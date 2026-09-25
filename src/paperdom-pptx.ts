/**
 * PaperDOM canvas → PowerPoint (.pptx). Writes Office Open XML directly with
 * the dependency-free ZIP writer, and returns a fidelity report listing what
 * was approximated or left out, so no export silently drops content.
 *
 * Mapping: text and shapes become `p:sp` (preset geometry, fill, line, text
 * body), connectors `p:cxnSp`, tables `a:tbl`, bar/line charts native chart
 * parts (literal caches, no embedded workbook), base64 PNG/JPEG/GIF images
 * `p:pic`, speaker notes notes slides, `hidden` → `show="0"`, and page
 * transitions `p:transition`.
 */
import { SHAPE_GEOMETRIES } from "./paperdom-geometry-shapes.js";
import type { CanvasElement, CanvasPage, ElementStyle, PaperDOMDocument } from "./paperdom-document-model.js";
import { canvasPageSize, chartSeries, frameOf, paragraphsOf } from "./canvas-svg.js";
import { createZip, type ZipEntryInput } from "./zip.js";

export interface PptxFidelityReport {
  slides: number;
  /** Mapped natively. */
  supported: string[];
  /** Kept, but not exactly as on the canvas. */
  approximated: string[];
  /** Left out of the file. */
  unsupported: string[];
}

export interface PptxExport {
  bytes: Buffer;
  report: PptxFidelityReport;
}

export interface PptxOptions {
  /** Fixed timestamp for docProps/core.xml (tests and reproducible builds). */
  modified?: Date;
  /** Author written to docProps/core.xml. */
  creator?: string;
}

const EMU_PER_PX = 9525;
const NS_A = "http://schemas.openxmlformats.org/drawingml/2006/main";
const NS_R = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const NS_P = "http://schemas.openxmlformats.org/presentationml/2006/main";
const NS_C = "http://schemas.openxmlformats.org/drawingml/2006/chart";
const REL = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const REL_PKG = "http://schemas.openxmlformats.org/package/2006/relationships";
const XML_HEAD = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

type Rel = { id: string; type: string; target: string };
type Media = { path: string; ext: string; data: Buffer };

class Report {
  supported = new Set<string>();
  approximated = new Set<string>();
  unsupported = new Set<string>();
  done(slides: number): PptxFidelityReport {
    return { slides, supported: [...this.supported].sort(), approximated: [...this.approximated].sort(), unsupported: [...this.unsupported].sort() };
  }
}

/** Serialises a canvas document as a .pptx package. */
export function paperDomToPptx(document: PaperDOMDocument, options: PptxOptions = {}): PptxExport {
  const report = new Report();
  const pages = document.pages.filter((page): page is CanvasPage => typeof page === "object" && page !== null);
  if (pages.length === 0) throw new Error("PowerPoint export needs at least one canvas page");
  const size = canvasPageSize(pages[0]!);
  if (pages.some((page) => { const s = canvasPageSize(page); return s.width !== size.width || s.height !== size.height; })) {
    report.approximated.add("pages of different sizes: PowerPoint uses one slide size (the first page's)");
  }
  if (document.masters?.length) report.approximated.add("masters: master elements are not copied onto slides");
  if (document.theme) report.approximated.add("theme: canvas theme is not mapped to an Office theme");

  const entries: ZipEntryInput[] = [];
  const media: Media[] = [];
  const charts: string[] = [];
  const slideRels: Rel[][] = [];
  const slides: string[] = [];
  const notes: Array<string | undefined> = [];
  pages.forEach((page, index) => {
    const rels: Rel[] = [{ id: "rId1", type: `${REL}/slideLayout`, target: "../slideLayouts/slideLayout1.xml" }];
    const ctx: SlideCtx = { rels, media, charts, report, nextShapeId: 2, pageIndex: index };
    slides.push(slideXml(page, ctx));
    const note = typeof page.notes === "string" && page.notes.trim() ? page.notes : undefined;
    notes.push(note);
    if (note) rels.push({ id: `rId${rels.length + 1}`, type: `${REL}/notesSlide`, target: `../notesSlides/notesSlide${index + 1}.xml` });
    if (Array.isArray(page.animations) && page.animations.length) report.unsupported.add("animations: build steps are not exported");
    if (Array.isArray(page.comments) && page.comments.length) report.unsupported.add("slide comments: canvas comments are not exported");
    if (page.masterId) report.approximated.add("masters: master elements are not copied onto slides");
    slideRels.push(rels);
  });
  const hasNotes = notes.some(Boolean);
  const cx = Math.round(size.width * EMU_PER_PX);
  const cy = Math.round(size.height * EMU_PER_PX);

  entries.push({ path: "[Content_Types].xml", data: contentTypes(pages.length, notes, media, charts.length) });
  entries.push({ path: "_rels/.rels", data: rels([
    { id: "rId1", type: `${REL}/officeDocument`, target: "ppt/presentation.xml" },
    { id: "rId2", type: "http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties", target: "docProps/core.xml" },
    { id: "rId3", type: `${REL}/extended-properties`, target: "docProps/app.xml" },
  ]) });
  entries.push({ path: "docProps/app.xml", data: `${XML_HEAD}<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties" xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes"><Application>Noma</Application><Slides>${pages.length}</Slides></Properties>` });
  const modified = (options.modified ?? new Date(document.metadata?.updatedAt || 0)).toISOString().replace(/\.\d{3}Z$/, "Z");
  entries.push({ path: "docProps/core.xml", data: `${XML_HEAD}<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:dcterms="http://purl.org/dc/terms/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance"><dc:title>${esc(document.title ?? "")}</dc:title><dc:creator>${esc(options.creator ?? "Noma")}</dc:creator><dcterms:modified xsi:type="dcterms:W3CDTF">${modified}</dcterms:modified></cp:coreProperties>` });

  const presRels: Rel[] = [
    { id: "rId1", type: `${REL}/slideMaster`, target: "slideMasters/slideMaster1.xml" },
    { id: "rId2", type: `${REL}/theme`, target: "theme/theme1.xml" },
    { id: "rId3", type: `${REL}/presProps`, target: "presProps.xml" },
    { id: "rId4", type: `${REL}/viewProps`, target: "viewProps.xml" },
    { id: "rId5", type: `${REL}/tableStyles`, target: "tableStyles.xml" },
  ];
  if (hasNotes) presRels.push({ id: "rId6", type: `${REL}/notesMaster`, target: "notesMasters/notesMaster1.xml" });
  const slideRelBase = presRels.length + 1;
  pages.forEach((_, i) => presRels.push({ id: `rId${slideRelBase + i}`, type: `${REL}/slide`, target: `slides/slide${i + 1}.xml` }));
  const sldIds = pages.map((_, i) => `<p:sldId id="${256 + i}" r:id="rId${slideRelBase + i}"/>`).join("");
  entries.push({ path: "ppt/presentation.xml", data: `${XML_HEAD}<p:presentation xmlns:a="${NS_A}" xmlns:r="${NS_R}" xmlns:p="${NS_P}" saveSubsetFonts="1"><p:sldMasterIdLst><p:sldMasterId id="2147483648" r:id="rId1"/></p:sldMasterIdLst>${hasNotes ? '<p:notesMasterIdLst><p:notesMasterId r:id="rId6"/></p:notesMasterIdLst>' : ""}<p:sldIdLst>${sldIds}</p:sldIdLst><p:sldSz cx="${cx}" cy="${cy}"/><p:notesSz cx="6858000" cy="9144000"/><p:defaultTextStyle>${levelStyles()}</p:defaultTextStyle></p:presentation>` });
  entries.push({ path: "ppt/_rels/presentation.xml.rels", data: rels(presRels) });
  entries.push({ path: "ppt/presProps.xml", data: `${XML_HEAD}<p:presentationPr xmlns:a="${NS_A}" xmlns:r="${NS_R}" xmlns:p="${NS_P}"/>` });
  entries.push({ path: "ppt/viewProps.xml", data: `${XML_HEAD}<p:viewPr xmlns:a="${NS_A}" xmlns:r="${NS_R}" xmlns:p="${NS_P}"><p:normalViewPr><p:restoredLeft sz="15620"/><p:restoredTop sz="94660"/></p:normalViewPr><p:gridSpacing cx="76200" cy="76200"/></p:viewPr>` });
  entries.push({ path: "ppt/tableStyles.xml", data: `${XML_HEAD}<a:tblStyleLst xmlns:a="${NS_A}" def="{5C22544A-7EE6-4342-B048-85BDC9FD1C3A}"/>` });
  entries.push({ path: "ppt/theme/theme1.xml", data: themeXml("Noma") });
  entries.push({ path: "ppt/slideMasters/slideMaster1.xml", data: slideMasterXml() });
  entries.push({ path: "ppt/slideMasters/_rels/slideMaster1.xml.rels", data: rels([
    { id: "rId1", type: `${REL}/slideLayout`, target: "../slideLayouts/slideLayout1.xml" },
    { id: "rId2", type: `${REL}/theme`, target: "../theme/theme1.xml" },
  ]) });
  entries.push({ path: "ppt/slideLayouts/slideLayout1.xml", data: `${XML_HEAD}<p:sldLayout xmlns:a="${NS_A}" xmlns:r="${NS_R}" xmlns:p="${NS_P}" type="blank" preserve="1"><p:cSld name="Blank">${emptyTree()}</p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:sldLayout>` });
  entries.push({ path: "ppt/slideLayouts/_rels/slideLayout1.xml.rels", data: rels([{ id: "rId1", type: `${REL}/slideMaster`, target: "../slideMasters/slideMaster1.xml" }]) });
  if (hasNotes) {
    entries.push({ path: "ppt/theme/theme2.xml", data: themeXml("Noma Notes") });
    entries.push({ path: "ppt/notesMasters/notesMaster1.xml", data: notesMasterXml() });
    entries.push({ path: "ppt/notesMasters/_rels/notesMaster1.xml.rels", data: rels([{ id: "rId1", type: `${REL}/theme`, target: "../theme/theme2.xml" }]) });
  }
  slides.forEach((xml, i) => {
    entries.push({ path: `ppt/slides/slide${i + 1}.xml`, data: xml });
    entries.push({ path: `ppt/slides/_rels/slide${i + 1}.xml.rels`, data: rels(slideRels[i]!) });
    const note = notes[i];
    if (note) {
      entries.push({ path: `ppt/notesSlides/notesSlide${i + 1}.xml`, data: notesSlideXml(note) });
      entries.push({ path: `ppt/notesSlides/_rels/notesSlide${i + 1}.xml.rels`, data: rels([
        { id: "rId1", type: `${REL}/notesMaster`, target: "../notesMasters/notesMaster1.xml" },
        { id: "rId2", type: `${REL}/slide`, target: `../slides/slide${i + 1}.xml` },
      ]) });
    }
  });
  charts.forEach((xml, i) => entries.push({ path: `ppt/charts/chart${i + 1}.xml`, data: xml }));
  for (const item of media) entries.push({ path: `ppt/media/${item.path}`, data: item.data });
  if (hasNotes) report.supported.add("speaker notes");
  return { bytes: createZip(entries), report: report.done(pages.length) };
}

interface SlideCtx {
  rels: Rel[];
  media: Media[];
  charts: string[];
  report: Report;
  nextShapeId: number;
  pageIndex: number;
}

function slideXml(page: CanvasPage, ctx: SlideCtx): string {
  const elements = (Array.isArray(page.elements) ? page.elements : [])
    .filter((el): el is CanvasElement => typeof el === "object" && el !== null)
    .map((el, index) => ({ el, index }))
    .sort((a, b) => (Number(a.el.z) || 0) - (Number(b.el.z) || 0) || a.index - b.index)
    .map(({ el }) => el);
  const byId = new Map(elements.map((el) => [el.id, el]));
  const shapes = elements.map((el) => elementXml(el, byId, ctx)).join("");
  const bg = hex(page.background?.color);
  const background = bg ? `<p:bg><p:bgPr><a:solidFill><a:srgbClr val="${bg.rgb}"/></a:solidFill><a:effectLst/></p:bgPr></p:bg>` : "";
  const show = page.hidden ? ' show="0"' : "";
  if (page.hidden) ctx.report.supported.add("hidden slides");
  let transition = "";
  if (page.transition === "fade") transition = '<p:transition spd="med"><p:fade/></p:transition>';
  else if (page.transition === "slide") transition = '<p:transition spd="med"><p:push dir="l"/></p:transition>';
  if (transition) ctx.report.supported.add("slide transitions");
  const advance = Number(page.advanceSeconds);
  if (Number.isFinite(advance) && advance > 0) {
    transition = transition ? transition.replace("<p:transition ", `<p:transition advTm="${Math.round(advance * 1000)}" `) : `<p:transition advTm="${Math.round(advance * 1000)}"/>`;
  }
  return `${XML_HEAD}<p:sld xmlns:a="${NS_A}" xmlns:r="${NS_R}" xmlns:p="${NS_P}"${show}><p:cSld name="${esc(page.name ?? "")}">${background}<p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr>${shapes}</p:spTree></p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr>${transition}</p:sld>`;
}

function elementXml(el: CanvasElement, byId: Map<string, CanvasElement>, ctx: SlideCtx): string {
  if (el.hidden) {
    ctx.report.supported.add("hidden elements");
  }
  const id = ctx.nextShapeId++;
  const name = esc(String(el.name || el.id || `Shape ${id}`));
  const hidden = el.hidden ? ' hidden="1"' : "";
  const style = (el.style ?? {}) as ElementStyle;
  switch (el.type) {
    case "text":
      ctx.report.supported.add("text boxes");
      return shapeXml(el, id, name, hidden, "rect", style, ctx, true);
    case "shape": {
      const geometry = el.geometry && el.geometry in SHAPE_GEOMETRIES ? el.geometry : Number(style.radius) > 0 ? "roundRect" : "rect";
      ctx.report.supported.add("shapes");
      return shapeXml(el, id, name, hidden, geometry, style, ctx, false);
    }
    case "ellipse":
      ctx.report.supported.add("shapes");
      return shapeXml(el, id, name, hidden, "ellipse", style, ctx, false);
    case "line":
    case "connector":
      ctx.report.supported.add("lines and connectors");
      return connectorXml(el, id, name, hidden, style, byId);
    case "table":
      ctx.report.supported.add("tables");
      return tableXml(el, id, name, style);
    case "chart":
      return chartFrameXml(el, id, name, style, ctx);
    case "image":
      return imageXml(el, id, name, hidden, ctx);
    default:
      ctx.report.approximated.add(`${el.type} elements: exported as labelled placeholders`);
      return placeholderXml(el, id, name, String(el.name || el.type));
  }
}

function xfrm(el: CanvasElement, flip = ""): string {
  const f = frameOf(el);
  const rot = f.rotation ? ` rot="${Math.round(((f.rotation % 360) + 360) % 360 * 60000)}"` : "";
  return `<a:xfrm${rot}${flip}><a:off x="${emu(f.x)}" y="${emu(f.y)}"/><a:ext cx="${emu(f.w)}" cy="${emu(f.h)}"/></a:xfrm>`;
}

function shapeXml(el: CanvasElement, id: number, name: string, hidden: string, geometry: string, style: ElementStyle, ctx: SlideCtx, textBox: boolean): string {
  const f = frameOf(el);
  const radius = Number(style.radius) || 0;
  const adj = geometry === "roundRect" ? `<a:avLst><a:gd name="adj" fmla="val ${Math.round(Math.min(50000, (radius / Math.max(1, Math.min(f.w, f.h))) * 100000))}"/></a:avLst>` : "<a:avLst/>";
  if (style.fillGradient) ctx.report.approximated.add("gradient fills: exported as a solid fill of the start colour");
  if (style.shadow) ctx.report.unsupported.add("drop shadows");
  const fillColor = style.fillGradient ? style.fillGradient.from : style.fill;
  return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${name}"${hidden}/><p:cNvSpPr${textBox ? ' txBox="1"' : ""}/><p:nvPr/></p:nvSpPr><p:spPr>${xfrm(el)}<a:prstGeom prst="${geometry}">${adj}</a:prstGeom>${fill(fillColor, style.opacity)}${line(style)}</p:spPr>${textBody(el, style, textBox ? "t" : "ctr")}</p:sp>`;
}

function textBody(el: CanvasElement, style: ElementStyle, defaultAnchor: "t" | "ctr"): string {
  const paragraphs = paragraphsOf(el);
  const anchor = style.verticalAlign === "middle" ? "ctr" : style.verticalAlign === "bottom" ? "b" : style.verticalAlign === "top" ? "t" : defaultAnchor;
  const inset = emu(Math.max(0, Number(style.padding) || 0));
  const autofit = style.autoFit === "shrink" ? "<a:normAutofit/>" : style.autoFit === "grow" ? "<a:spAutoFit/>" : "";
  const body = `<a:bodyPr wrap="square" lIns="${inset}" tIns="${inset}" rIns="${inset}" bIns="${inset}" anchor="${anchor}" rtlCol="0">${autofit}</a:bodyPr><a:lstStyle/>`;
  if (paragraphs.length === 0) return `<p:txBody>${body}<a:p><a:endParaRPr lang="en-US" dirty="0"/></a:p></p:txBody>`;
  const algn = style.textAlign === "center" ? "ctr" : style.textAlign === "right" ? "r" : "l";
  const runProps = runPr(style);
  const lineHeight = Number(style.lineHeight);
  const spacing = Number.isFinite(lineHeight) && lineHeight > 0 ? `<a:lnSpc><a:spcPct val="${Math.round(Math.min(5, lineHeight) * 100000 / 1.2)}"/></a:lnSpc>` : "";
  const paras = paragraphs
    .map((p) => {
      const level = Math.max(0, Math.min(8, Math.round(p.level)));
      const indent = p.kind === "plain" ? "" : ` marL="${emu(24 + level * 24)}" indent="${emu(-20)}"`;
      const lvl = level ? ` lvl="${level}"` : "";
      const bullet = p.kind === "bullet" ? '<a:buFont typeface="Arial"/><a:buChar char="•"/>' : p.kind === "number" ? '<a:buFont typeface="+mj-lt"/><a:buAutoNum type="arabicPeriod"/>' : "<a:buNone/>";
      const run = p.text ? `<a:r>${runProps}<a:t>${esc(p.text)}</a:t></a:r>` : "";
      return `<a:p><a:pPr algn="${algn}"${indent}${lvl}>${spacing}${bullet}</a:pPr>${run}<a:endParaRPr lang="en-US" dirty="0"/></a:p>`;
    })
    .join("");
  return `<p:txBody>${body}${paras}</p:txBody>`;
}

function runPr(style: ElementStyle): string {
  const size = Math.round(clamp(Number(style.fontSize) || 24, 1, 800) * 75);
  const bold = (Number(style.fontWeight) || 400) >= 600 ? ' b="1"' : "";
  const italic = style.fontStyle === "italic" ? ' i="1"' : "";
  const underline = style.underline ? ' u="sng"' : "";
  const strike = style.strike ? ' strike="sngStrike"' : "";
  const spc = Number(style.letterSpacing) ? ` spc="${Math.round(Number(style.letterSpacing) * 75)}"` : "";
  const colour = hex(style.color);
  const font = firstFont(style.fontFamily);
  return `<a:rPr lang="en-US" sz="${size}"${bold}${italic}${underline}${strike}${spc} dirty="0">${colour ? `<a:solidFill><a:srgbClr val="${colour.rgb}"/></a:solidFill>` : ""}${font ? `<a:latin typeface="${esc(font)}"/><a:cs typeface="${esc(font)}"/>` : ""}</a:rPr>`;
}

function fill(value: unknown, opacity: unknown): string {
  const colour = hex(value);
  if (!colour) return "<a:noFill/>";
  const alpha = Math.round(clamp(colour.alpha * (typeof opacity === "number" && Number.isFinite(opacity) ? opacity : 1), 0, 1) * 100000);
  return `<a:solidFill><a:srgbClr val="${colour.rgb}">${alpha < 100000 ? `<a:alpha val="${alpha}"/>` : ""}</a:srgbClr></a:solidFill>`;
}

function line(style: ElementStyle): string {
  const colour = hex(style.stroke);
  const width = Number(style.strokeWidth) || 0;
  if (!colour || width <= 0) return "<a:ln><a:noFill/></a:ln>";
  const dash = style.lineStyle === "dashed" ? '<a:prstDash val="dash"/>' : "";
  return `<a:ln w="${emu(width)}"><a:solidFill><a:srgbClr val="${colour.rgb}"/></a:solidFill>${dash}</a:ln>`;
}

function connectorXml(el: CanvasElement, id: number, name: string, hidden: string, style: ElementStyle, byId: Map<string, CanvasElement>): string {
  const f = frameOf(el);
  const start = endpoint(el.from, byId) ?? { x: f.x, y: f.y };
  const end = endpoint(el.to, byId) ?? { x: f.x + f.w, y: f.y + f.h };
  const x = Math.min(start.x, end.x);
  const y = Math.min(start.y, end.y);
  const flip = `${start.x > end.x ? ' flipH="1"' : ""}${start.y > end.y ? ' flipV="1"' : ""}`;
  const colour = hex(style.stroke) ?? { rgb: "1D1C1A", alpha: 1 };
  const width = Math.max(0.5, Number(style.strokeWidth) || 2);
  const dash = style.lineStyle === "dashed" ? '<a:prstDash val="dash"/>' : "";
  return `<p:cxnSp><p:nvCxnSpPr><p:cNvPr id="${id}" name="${name}"${hidden}/><p:cNvCxnSpPr/><p:nvPr/></p:nvCxnSpPr><p:spPr><a:xfrm${flip}><a:off x="${emu(x)}" y="${emu(y)}"/><a:ext cx="${emu(Math.abs(end.x - start.x))}" cy="${emu(Math.abs(end.y - start.y))}"/></a:xfrm><a:prstGeom prst="line"><a:avLst/></a:prstGeom><a:ln w="${emu(width)}"><a:solidFill><a:srgbClr val="${colour.rgb}"/></a:solidFill>${dash}</a:ln></p:spPr></p:cxnSp>`;
}

function endpoint(value: unknown, byId: Map<string, CanvasElement>): { x: number; y: number } | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const point = value as { elementId?: unknown; anchor?: unknown; x?: unknown; y?: unknown };
  const target = typeof point.elementId === "string" ? byId.get(point.elementId) : undefined;
  if (target) {
    const f = frameOf(target);
    if (point.anchor === "top") return { x: f.x + f.w / 2, y: f.y };
    if (point.anchor === "bottom") return { x: f.x + f.w / 2, y: f.y + f.h };
    if (point.anchor === "left") return { x: f.x, y: f.y + f.h / 2 };
    if (point.anchor === "right") return { x: f.x + f.w, y: f.y + f.h / 2 };
    return { x: f.x + f.w / 2, y: f.y + f.h / 2 };
  }
  if (typeof point.x === "number" && typeof point.y === "number" && Number.isFinite(point.x) && Number.isFinite(point.y)) return { x: point.x, y: point.y };
  return undefined;
}

function tableXml(el: CanvasElement, id: number, name: string, style: ElementStyle): string {
  const rows = (Array.isArray(el.table?.rows) ? el.table.rows : []).filter(Array.isArray).map((row) => row.map((cell) => String(cell ?? "")));
  const f = frameOf(el);
  const cols = Math.max(1, ...rows.map((row) => row.length));
  const colW = Math.floor(emu(f.w) / cols);
  const rowH = rows.length ? Math.floor(emu(f.h) / rows.length) : emu(f.h);
  const border = hex(style.stroke) ?? { rgb: "CBD5E1", alpha: 1 };
  const edge = (tag: string): string => `<a:${tag} w="12700"><a:solidFill><a:srgbClr val="${border.rgb}"/></a:solidFill></a:${tag}>`;
  const header = el.table?.header !== false;
  const cellStyle = { ...style, padding: 0 } as ElementStyle;
  const body = (rows.length ? rows : [[""]])
    .map((row, r) => {
      const cells = Array.from({ length: cols }, (_, c) => {
        const bold = header && r === 0 ? { ...cellStyle, fontWeight: 700 } : cellStyle;
        return `<a:tc><a:txBody><a:bodyPr/><a:lstStyle/><a:p><a:pPr algn="l"/>${row[c] ? `<a:r>${runPr(bold)}<a:t>${esc(row[c]!)}</a:t></a:r>` : ""}<a:endParaRPr lang="en-US" dirty="0"/></a:p></a:txBody><a:tcPr marL="76200" marR="76200" marT="38100" marB="38100">${edge("lnL")}${edge("lnR")}${edge("lnT")}${edge("lnB")}${header && r === 0 ? '<a:solidFill><a:srgbClr val="F1F5F9"/></a:solidFill>' : "<a:noFill/>"}</a:tcPr></a:tc>`;
      }).join("");
      return `<a:tr h="${rowH}">${cells}</a:tr>`;
    })
    .join("");
  const grid = Array.from({ length: cols }, () => `<a:gridCol w="${colW}"/>`).join("");
  return `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="${id}" name="${name}"/><p:cNvGraphicFramePr><a:graphicFrameLocks noGrp="1"/></p:cNvGraphicFramePr><p:nvPr/></p:nvGraphicFramePr><p:xfrm><a:off x="${emu(f.x)}" y="${emu(f.y)}"/><a:ext cx="${emu(f.w)}" cy="${emu(f.h)}"/></p:xfrm><a:graphic><a:graphicData uri="http://schemas.openxmlformats.org/drawingml/2006/table"><a:tbl><a:tblPr firstRow="${header ? 1 : 0}" bandRow="0"/><a:tblGrid>${grid}</a:tblGrid>${body}</a:tbl></a:graphicData></a:graphic></p:graphicFrame>`;
}

const CHART_COLORS = ["2F6FA7", "B9522A", "2F7048", "8A5CB8", "9A681F", "0F666B"];

function chartFrameXml(el: CanvasElement, id: number, name: string, style: ElementStyle, ctx: SlideCtx): string {
  const chart = el.chart as unknown as Record<string, unknown> | undefined;
  const labels = Array.isArray(chart?.labels) ? chart.labels.map((label) => String(label ?? "")) : [];
  const series = chart ? chartSeries(chart) : [];
  if (!chart || labels.length === 0 || series.length === 0) {
    ctx.report.approximated.add("empty charts: exported as labelled placeholders");
    return placeholderXml(el, id, name, "chart");
  }
  ctx.report.supported.add("bar and line charts (native, without an embedded workbook)");
  const index = ctx.charts.length + 1;
  const colours = (Array.isArray(chart.colors) ? chart.colors : []).map((c) => hex(c)?.rgb);
  const kind = chart.kind === "line" ? "line" : "bar";
  const cat = `<c:cat><c:strLit><c:ptCount val="${labels.length}"/>${labels.map((label, i) => `<c:pt idx="${i}"><c:v>${esc(label)}</c:v></c:pt>`).join("")}</c:strLit></c:cat>`;
  const ser = series
    .map((s, i) => {
      const colour = colours[i] ?? CHART_COLORS[i % CHART_COLORS.length]!;
      const spPr = kind === "bar" ? `<c:spPr><a:solidFill><a:srgbClr val="${colour}"/></a:solidFill></c:spPr>` : `<c:spPr><a:ln w="28575"><a:solidFill><a:srgbClr val="${colour}"/></a:solidFill></a:ln></c:spPr><c:marker><c:symbol val="none"/></c:marker>`;
      const values = labels.map((_, j) => s.values[j] ?? 0);
      return `<c:ser><c:idx val="${i}"/><c:order val="${i}"/><c:tx><c:v>${esc(s.name)}</c:v></c:tx>${spPr}${cat}<c:val><c:numLit><c:formatCode>General</c:formatCode><c:ptCount val="${values.length}"/>${values.map((v, j) => `<c:pt idx="${j}"><c:v>${v}</c:v></c:pt>`).join("")}</c:numLit></c:val>${kind === "line" ? '<c:smooth val="0"/>' : ""}</c:ser>`;
    })
    .join("");
  const plot = kind === "bar"
    ? `<c:barChart><c:barDir val="col"/><c:grouping val="clustered"/><c:varyColors val="0"/>${ser}<c:gapWidth val="60"/><c:axId val="1001"/><c:axId val="1002"/></c:barChart>`
    : `<c:lineChart><c:grouping val="standard"/><c:varyColors val="0"/>${ser}<c:marker val="1"/><c:axId val="1001"/><c:axId val="1002"/></c:lineChart>`;
  const title = typeof chart.title === "string" && chart.title.trim() ? chart.title : "";
  const fontSize = Math.round(clamp(Number(style.fontSize) || 14, 6, 60) * 75);
  const titleXml = title ? `<c:title><c:tx><c:rich><a:bodyPr/><a:lstStyle/><a:p><a:pPr><a:defRPr sz="${Math.round(fontSize * 1.1)}" b="1"/></a:pPr><a:r><a:rPr lang="en-US" sz="${Math.round(fontSize * 1.1)}" b="1"/><a:t>${esc(title)}</a:t></a:r></a:p></c:rich></c:tx><c:overlay val="0"/></c:title><c:autoTitleDeleted val="0"/>` : '<c:autoTitleDeleted val="1"/>';
  const gridlines = chart.grid ? "<c:majorGridlines/>" : "";
  const axes = `<c:catAx><c:axId val="1001"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="b"/><c:numFmt formatCode="General" sourceLinked="0"/><c:tickLblPos val="nextTo"/><c:txPr><a:bodyPr/><a:lstStyle/><a:p><a:pPr><a:defRPr sz="${fontSize}"/></a:pPr><a:endParaRPr lang="en-US"/></a:p></c:txPr><c:crossAx val="1002"/><c:crosses val="autoZero"/><c:auto val="1"/><c:lblAlgn val="ctr"/><c:lblOffset val="100"/></c:catAx><c:valAx><c:axId val="1002"/><c:scaling><c:orientation val="minMax"/></c:scaling><c:delete val="0"/><c:axPos val="l"/>${gridlines}<c:numFmt formatCode="General" sourceLinked="0"/><c:tickLblPos val="nextTo"/><c:txPr><a:bodyPr/><a:lstStyle/><a:p><a:pPr><a:defRPr sz="${fontSize}"/></a:pPr><a:endParaRPr lang="en-US"/></a:p></c:txPr><c:crossAx val="1001"/><c:crosses val="autoZero"/><c:crossBetween val="between"/></c:valAx>`;
  const legend = series.length > 1 ? '<c:legend><c:legendPos val="b"/><c:overlay val="0"/></c:legend>' : "";
  ctx.charts.push(`${XML_HEAD}<c:chartSpace xmlns:c="${NS_C}" xmlns:a="${NS_A}" xmlns:r="${NS_R}"><c:roundedCorners val="0"/><c:chart>${titleXml}<c:plotArea><c:layout/>${plot}${axes}</c:plotArea>${legend}<c:plotVisOnly val="1"/><c:dispBlanksAs val="gap"/></c:chart><c:spPr><a:noFill/><a:ln><a:noFill/></a:ln></c:spPr></c:chartSpace>`);
  const relId = `rId${ctx.rels.length + 1}`;
  ctx.rels.push({ id: relId, type: `${REL}/chart`, target: `../charts/chart${index}.xml` });
  const f = frameOf(el);
  return `<p:graphicFrame><p:nvGraphicFramePr><p:cNvPr id="${id}" name="${name}"/><p:cNvGraphicFramePr/><p:nvPr/></p:nvGraphicFramePr><p:xfrm><a:off x="${emu(f.x)}" y="${emu(f.y)}"/><a:ext cx="${emu(f.w)}" cy="${emu(f.h)}"/></p:xfrm><a:graphic><a:graphicData uri="${NS_C}"><c:chart xmlns:c="${NS_C}" r:id="${relId}"/></a:graphicData></a:graphic></p:graphicFrame>`;
}

const IMAGE_DATA = /^data:image\/(png|jpeg|gif);base64,([A-Za-z0-9+/=]+)$/;

function imageXml(el: CanvasElement, id: number, name: string, hidden: string, ctx: SlideCtx): string {
  const src = typeof el.content?.src === "string" ? el.content.src : "";
  const alt = typeof el.content?.alt === "string" ? el.content.alt : "";
  const match = IMAGE_DATA.exec(src);
  if (!match) {
    ctx.report.approximated.add("linked images: only embedded PNG/JPEG/GIF images are exported; others become placeholders");
    return placeholderXml(el, id, name, `image${alt ? `: ${alt}` : ""}`);
  }
  ctx.report.supported.add("embedded images");
  const ext = match[1] === "jpeg" ? "jpeg" : match[1]!;
  const path = `image${ctx.media.length + 1}.${ext}`;
  ctx.media.push({ path, ext, data: Buffer.from(match[2]!, "base64") });
  const relId = `rId${ctx.rels.length + 1}`;
  ctx.rels.push({ id: relId, type: `${REL}/image`, target: `../media/${path}` });
  return `<p:pic><p:nvPicPr><p:cNvPr id="${id}" name="${name}" descr="${esc(alt)}"${hidden}/><p:cNvPicPr><a:picLocks noChangeAspect="1"/></p:cNvPicPr><p:nvPr/></p:nvPicPr><p:blipFill><a:blip r:embed="${relId}"/><a:stretch><a:fillRect/></a:stretch></p:blipFill><p:spPr>${xfrm(el)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr></p:pic>`;
}

function placeholderXml(el: CanvasElement, id: number, name: string, label: string): string {
  const style = { fill: "#F1F5F9", stroke: "#94A3B8", strokeWidth: 1, lineStyle: "dashed", color: "#475569", fontSize: 14, textAlign: "center", verticalAlign: "middle", padding: 4 } as unknown as ElementStyle;
  const stub = { ...el, content: { text: label } } as CanvasElement;
  return `<p:sp><p:nvSpPr><p:cNvPr id="${id}" name="${name}"/><p:cNvSpPr/><p:nvPr/></p:nvSpPr><p:spPr>${xfrm(el)}<a:prstGeom prst="rect"><a:avLst/></a:prstGeom>${fill(style.fill, 1)}${line(style)}</p:spPr>${textBody(stub, style, "ctr")}</p:sp>`;
}

function contentTypes(slideCount: number, notes: Array<string | undefined>, media: Media[], chartCount: number): string {
  const overrides = [
    ["/ppt/presentation.xml", "application/vnd.openxmlformats-officedocument.presentationml.presentation.main+xml"],
    ["/ppt/presProps.xml", "application/vnd.openxmlformats-officedocument.presentationml.presProps+xml"],
    ["/ppt/viewProps.xml", "application/vnd.openxmlformats-officedocument.presentationml.viewProps+xml"],
    ["/ppt/tableStyles.xml", "application/vnd.openxmlformats-officedocument.presentationml.tableStyles+xml"],
    ["/ppt/theme/theme1.xml", "application/vnd.openxmlformats-officedocument.theme+xml"],
    ["/ppt/slideMasters/slideMaster1.xml", "application/vnd.openxmlformats-officedocument.presentationml.slideMaster+xml"],
    ["/ppt/slideLayouts/slideLayout1.xml", "application/vnd.openxmlformats-officedocument.presentationml.slideLayout+xml"],
    ["/docProps/core.xml", "application/vnd.openxmlformats-package.core-properties+xml"],
    ["/docProps/app.xml", "application/vnd.openxmlformats-officedocument.extended-properties+xml"],
  ];
  for (let i = 1; i <= slideCount; i++) overrides.push([`/ppt/slides/slide${i}.xml`, "application/vnd.openxmlformats-officedocument.presentationml.slide+xml"]);
  if (notes.some(Boolean)) {
    overrides.push(["/ppt/theme/theme2.xml", "application/vnd.openxmlformats-officedocument.theme+xml"]);
    overrides.push(["/ppt/notesMasters/notesMaster1.xml", "application/vnd.openxmlformats-officedocument.presentationml.notesMaster+xml"]);
  }
  notes.forEach((note, i) => {
    if (note) overrides.push([`/ppt/notesSlides/notesSlide${i + 1}.xml`, "application/vnd.openxmlformats-officedocument.presentationml.notesSlide+xml"]);
  });
  for (let i = 1; i <= chartCount; i++) overrides.push([`/ppt/charts/chart${i}.xml`, "application/vnd.openxmlformats-officedocument.drawingml.chart+xml"]);
  const exts = [...new Set(media.map((m) => m.ext))];
  const defaults = [
    '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>',
    '<Default Extension="xml" ContentType="application/xml"/>',
    ...exts.map((ext) => `<Default Extension="${ext}" ContentType="image/${ext}"/>`),
  ].join("");
  return `${XML_HEAD}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">${defaults}${overrides.map(([part, type]) => `<Override PartName="${part}" ContentType="${type}"/>`).join("")}</Types>`;
}

function rels(list: Rel[]): string {
  return `${XML_HEAD}<Relationships xmlns="${REL_PKG}">${list.map((rel) => `<Relationship Id="${rel.id}" Type="${rel.type}" Target="${rel.target}"/>`).join("")}</Relationships>`;
}

function emptyTree(): string {
  return '<p:spTree><p:nvGrpSpPr><p:cNvPr id="1" name=""/><p:cNvGrpSpPr/><p:nvPr/></p:nvGrpSpPr><p:grpSpPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="0" cy="0"/><a:chOff x="0" y="0"/><a:chExt cx="0" cy="0"/></a:xfrm></p:grpSpPr></p:spTree>';
}

function levelStyles(): string {
  return Array.from({ length: 9 }, (_, i) => `<a:lvl${i + 1}pPr marL="${i * 457200}" algn="l" defTabSz="914400" rtl="0" eaLnBrk="1" latinLnBrk="0" hangingPunct="1"><a:defRPr sz="1800" kern="1200"><a:solidFill><a:schemeClr val="tx1"/></a:solidFill><a:latin typeface="+mn-lt"/><a:ea typeface="+mn-ea"/><a:cs typeface="+mn-cs"/></a:defRPr></a:lvl${i + 1}pPr>`).join("");
}

function slideMasterXml(): string {
  const clrMap = '<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>';
  return `${XML_HEAD}<p:sldMaster xmlns:a="${NS_A}" xmlns:r="${NS_R}" xmlns:p="${NS_P}"><p:cSld><p:bg><p:bgRef idx="1001"><a:schemeClr val="bg1"/></p:bgRef></p:bg>${emptyTree()}</p:cSld>${clrMap}<p:sldLayoutIdLst><p:sldLayoutId id="2147483649" r:id="rId1"/></p:sldLayoutIdLst><p:txStyles><p:titleStyle>${levelStyles()}</p:titleStyle><p:bodyStyle>${levelStyles()}</p:bodyStyle><p:otherStyle>${levelStyles()}</p:otherStyle></p:txStyles></p:sldMaster>`;
}

function notesMasterXml(): string {
  const clrMap = '<p:clrMap bg1="lt1" tx1="dk1" bg2="lt2" tx2="dk2" accent1="accent1" accent2="accent2" accent3="accent3" accent4="accent4" accent5="accent5" accent6="accent6" hlink="hlink" folHlink="folHlink"/>';
  const body = '<p:sp><p:nvSpPr><p:cNvPr id="2" name="Notes Placeholder 1"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr><p:spPr><a:xfrm><a:off x="685800" y="4400550"/><a:ext cx="5486400" cy="3600450"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></p:spPr><p:txBody><a:bodyPr/><a:lstStyle/><a:p><a:endParaRPr lang="en-US"/></a:p></p:txBody></p:sp>';
  return `${XML_HEAD}<p:notesMaster xmlns:a="${NS_A}" xmlns:r="${NS_R}" xmlns:p="${NS_P}"><p:cSld><p:bg><p:bgRef idx="1001"><a:schemeClr val="bg1"/></p:bgRef></p:bg>${emptyTree().replace("</p:grpSpPr>", `</p:grpSpPr>${body}`)}</p:cSld>${clrMap}<p:notesStyle>${levelStyles()}</p:notesStyle></p:notesMaster>`;
}

function notesSlideXml(text: string): string {
  const paras = text.split(/\r?\n/).map((line) => `<a:p>${line ? `<a:r><a:rPr lang="en-US" dirty="0"/><a:t>${esc(line)}</a:t></a:r>` : ""}<a:endParaRPr lang="en-US" dirty="0"/></a:p>`).join("");
  const body = `<p:sp><p:nvSpPr><p:cNvPr id="2" name="Notes Placeholder 1"/><p:cNvSpPr><a:spLocks noGrp="1"/></p:cNvSpPr><p:nvPr><p:ph type="body" idx="1"/></p:nvPr></p:nvSpPr><p:spPr/><p:txBody><a:bodyPr/><a:lstStyle/>${paras}</p:txBody></p:sp>`;
  return `${XML_HEAD}<p:notes xmlns:a="${NS_A}" xmlns:r="${NS_R}" xmlns:p="${NS_P}"><p:cSld>${emptyTree().replace("</p:grpSpPr>", `</p:grpSpPr>${body}`)}</p:cSld><p:clrMapOvr><a:masterClrMapping/></p:clrMapOvr></p:notes>`;
}

function themeXml(name: string): string {
  const scheme = [
    ["dk1", '<a:sysClr val="windowText" lastClr="000000"/>'],
    ["lt1", '<a:sysClr val="window" lastClr="FFFFFF"/>'],
    ["dk2", '<a:srgbClr val="1D1C1A"/>'],
    ["lt2", '<a:srgbClr val="FBFAF7"/>'],
    ["accent1", '<a:srgbClr val="B9522A"/>'],
    ["accent2", '<a:srgbClr val="2C5D8F"/>'],
    ["accent3", '<a:srgbClr val="2F7D4A"/>'],
    ["accent4", '<a:srgbClr val="A8362E"/>'],
    ["accent5", '<a:srgbClr val="8A5CB8"/>'],
    ["accent6", '<a:srgbClr val="0F666B"/>'],
    ["hlink", '<a:srgbClr val="2C5D8F"/>'],
    ["folHlink", '<a:srgbClr val="8A5CB8"/>'],
  ].map(([key, value]) => `<a:${key}>${value}</a:${key}>`).join("");
  const font = (face: string): string => `<a:latin typeface="${face}"/><a:ea typeface=""/><a:cs typeface=""/>`;
  const solid = '<a:solidFill><a:schemeClr val="phClr"/></a:solidFill>';
  const lineStyle = (w: number): string => `<a:ln w="${w}" cap="flat" cmpd="sng" algn="ctr"><a:solidFill><a:schemeClr val="phClr"/></a:solidFill><a:prstDash val="solid"/></a:ln>`;
  const fmt = `<a:fmtScheme name="Noma"><a:fillStyleLst>${solid}${solid}${solid}</a:fillStyleLst><a:lnStyleLst>${lineStyle(6350)}${lineStyle(12700)}${lineStyle(19050)}</a:lnStyleLst><a:effectStyleLst><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle><a:effectStyle><a:effectLst/></a:effectStyle></a:effectStyleLst><a:bgFillStyleLst>${solid}${solid}${solid}</a:bgFillStyleLst></a:fmtScheme>`;
  return `${XML_HEAD}<a:theme xmlns:a="${NS_A}" name="${esc(name)}"><a:themeElements><a:clrScheme name="Noma">${scheme}</a:clrScheme><a:fontScheme name="Noma"><a:majorFont>${font("Calibri")}</a:majorFont><a:minorFont>${font("Calibri")}</a:minorFont></a:fontScheme>${fmt}</a:themeElements><a:objectDefaults/><a:extraClrSchemeLst/></a:theme>`;
}

const NAMED: Record<string, string> = {
  black: "000000", white: "FFFFFF", red: "FF0000", green: "008000", blue: "0000FF", gray: "808080", grey: "808080",
  orange: "FFA500", yellow: "FFFF00", purple: "800080", navy: "000080", teal: "008080", silver: "C0C0C0",
};

/** A canvas colour as OOXML `RRGGBB` plus alpha, or undefined for transparent/unknown. */
export function hex(value: unknown): { rgb: string; alpha: number } | undefined {
  if (typeof value !== "string") return undefined;
  const v = value.trim().toLowerCase();
  if (!v || v === "transparent" || v === "none") return undefined;
  if (NAMED[v]) return { rgb: NAMED[v]!, alpha: 1 };
  let m = /^#([0-9a-f]{3,4})$/.exec(v);
  if (m) {
    const [r, g, b, a] = m[1]!.split("").map((c) => c + c);
    return { rgb: `${r}${g}${b}`.toUpperCase(), alpha: a ? parseInt(a, 16) / 255 : 1 };
  }
  m = /^#([0-9a-f]{6})([0-9a-f]{2})?$/.exec(v);
  if (m) return { rgb: m[1]!.toUpperCase(), alpha: m[2] ? parseInt(m[2], 16) / 255 : 1 };
  m = /^rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)$/.exec(v);
  if (m) {
    const part = (n: string): string => clamp(Number(n), 0, 255).toString(16).padStart(2, "0");
    return { rgb: `${part(m[1]!)}${part(m[2]!)}${part(m[3]!)}`.toUpperCase(), alpha: m[4] === undefined ? 1 : clamp(Number(m[4]), 0, 1) };
  }
  return undefined;
}

function firstFont(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const first = value.split(",")[0]?.replace(/["']/g, "").trim();
  if (!first || /^(ui-sans-serif|system-ui|sans-serif|serif|monospace|-apple-system)$/i.test(first)) return undefined;
  return first.replace(/[^\w\s-]/g, "");
}

function emu(px: number): number {
  return Math.round(px * EMU_PER_PX);
}

function clamp(n: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, Number.isFinite(n) ? n : min));
}

function esc(value: string): string {
  return value
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g, "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}
