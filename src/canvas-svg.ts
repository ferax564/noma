/**
 * Static SVG rendering of PaperDOM canvas documents, for `::canvas` embeds and
 * slide thumbnails. Pure and dependency-free (type-only PaperDOM imports), so
 * the core library and the browser bundle can both use it.
 *
 * Canvas JSON may come from an untrusted attachment: every colour, font,
 * number, and URL is sanitised, all text is escaped, and anything unknown
 * renders as a labelled placeholder instead of being passed through.
 */
import { escapeAttr, escapeHtml } from "./inline.js";
import type { DirectiveNode } from "./ast.js";
import type { CanvasElement, CanvasPage, ElementStyle, PaperDOMDocument } from "./paperdom-document-model.js";

export type CanvasReadResult = { ok: true; document: PaperDOMDocument } | { ok: false; error: string };

/** Largest canvas JSON accepted for rendering (bytes of source text). */
export const MAX_CANVAS_SOURCE_BYTES = 2 * 1024 * 1024;

export interface CanvasSvgOptions {
  /** Prefix for SVG-internal ids so several canvases can share one page. */
  idPrefix?: string;
  /** Maps an image `src` to a URL the page may load; unresolved images render as placeholders. */
  resolveImage?: (src: string) => string | undefined;
  /** Accessible label; defaults to the page name. */
  label?: string;
  /** Extra class names on the root `<svg>`. */
  className?: string;
}

/**
 * Parses canvas JSON loosely: the minimum structure needed to draw (pages with
 * a size and an element array). Full kernel validation lives in
 * `parsePaperDOMDocument`; this reader never throws.
 */
export function readCanvasDocument(json: string): CanvasReadResult {
  if (json.length > MAX_CANVAS_SOURCE_BYTES) return { ok: false, error: `canvas JSON is larger than ${MAX_CANVAS_SOURCE_BYTES} bytes` };
  let value: unknown;
  try {
    value = JSON.parse(json);
  } catch (error) {
    return { ok: false, error: `canvas JSON does not parse: ${error instanceof Error ? error.message : String(error)}` };
  }
  if (!isRecord(value)) return { ok: false, error: "canvas JSON must be an object" };
  if (value.format !== "paperdom" && value.format !== "canvasdoc") return { ok: false, error: 'canvas JSON needs "format": "paperdom"' };
  if (!Array.isArray(value.pages) || value.pages.length === 0) return { ok: false, error: "canvas JSON needs at least one page" };
  for (const [index, page] of value.pages.entries()) {
    if (!isRecord(page) || !Array.isArray(page.elements)) return { ok: false, error: `canvas page ${index + 1} needs an elements array` };
  }
  return { ok: true, document: value as unknown as PaperDOMDocument };
}

/** Page size with sane bounds (PaperDOM pages default to 1280×720). */
export function canvasPageSize(page: CanvasPage): { width: number; height: number } {
  const size: Record<string, unknown> = isRecord(page.size) ? page.size : {};
  return { width: bounded(size.width, 1280, 16, 20000), height: bounded(size.height, 720, 16, 20000) };
}

/** One page as a self-contained `<svg>` element. */
export function canvasPageSvg(page: CanvasPage, options: CanvasSvgOptions = {}): string {
  const { width, height } = canvasPageSize(page);
  const prefix = safeIdPart(options.idPrefix ?? "canvas");
  const label = options.label ?? str(page.name) ?? "Canvas page";
  const elements = (Array.isArray(page.elements) ? page.elements : [])
    .filter((el): el is CanvasElement => isRecord(el) && !el.hidden)
    .map((el, index) => ({ el, index }))
    .sort((a, b) => num(a.el.z, 0) - num(b.el.z, 0) || a.index - b.index)
    .map(({ el }) => el);
  const byId = new Map(elements.map((el) => [str(el.id) ?? "", el]));
  const body = elements.map((el, index) => renderElement(el, `${prefix}-${index}`, byId, options)).join("");
  const background = color(isRecord(page.background) ? page.background.color : undefined, "#ffffff");
  const className = ["noma-canvas-svg", options.className].filter(Boolean).join(" ");
  return `<svg xmlns="http://www.w3.org/2000/svg" class="${escapeAttr(className)}" viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" role="img" aria-label="${escapeAttr(label)}" preserveAspectRatio="xMidYMid meet"><rect width="${width}" height="${height}" fill="${background}"/>${body}</svg>`;
}

/** Visible pages of a canvas, or only `pageId` when given. */
export function canvasPages(document: PaperDOMDocument, pageId?: string): CanvasPage[] {
  const pages = document.pages.filter((page): page is CanvasPage => isRecord(page));
  if (pageId) return pages.filter((page) => page.id === pageId);
  return pages.filter((page) => !page.hidden);
}

/** Plain-text reading order of a canvas: page names, then element text top-to-bottom. */
export function canvasOutline(document: PaperDOMDocument, pageId?: string): Array<{ page: string; lines: string[] }> {
  return canvasPages(document, pageId).map((page, index) => {
    const elements = (Array.isArray(page.elements) ? page.elements : [])
      .filter((el): el is CanvasElement => isRecord(el) && !el.hidden)
      .slice()
      .sort((a, b) => rowBand(a, page) - rowBand(b, page) || frameOf(a).x - frameOf(b).x);
    const lines: string[] = [];
    for (const el of elements) {
      if (isRecord(el.table) && Array.isArray(el.table.rows)) {
        for (const row of el.table.rows) if (Array.isArray(row)) lines.push(row.map((cell) => String(cell ?? "")).join(" | "));
        continue;
      }
      if (isRecord(el.chart)) {
        const chart = el.chart;
        const labels = Array.isArray(chart.labels) ? chart.labels : [];
        const values = Array.isArray(chart.values) ? chart.values : [];
        lines.push(`${str(chart.title) ?? "Chart"}: ${labels.map((label, i) => `${String(label)} ${String(values[i] ?? "")}`).join(", ")}`);
        continue;
      }
      const text = elementText(el);
      if (text) lines.push(...text.split("\n").map((line) => line.trim()).filter(Boolean));
      else if (el.type === "image" && isRecord(el.content) && str(el.content.alt)) lines.push(`[image: ${str(el.content.alt)}]`);
    }
    return { page: str(page.name) ?? `Page ${index + 1}`, lines };
  });
}

/** Reading-order row: elements whose vertical centres fall in the same twelfth of the page read left to right. */
function rowBand(el: CanvasElement, page: CanvasPage): number {
  const f = frameOf(el);
  const band = canvasPageSize(page).height / 12;
  return Math.floor((f.y + f.h / 2) / band);
}

function renderElement(el: CanvasElement, uid: string, byId: Map<string, CanvasElement>, options: CanvasSvgOptions): string {
  const frame = frameOf(el);
  const style = styleOf(el);
  const { x, y, w, h } = frame;
  const opacity = bounded(style.opacity, 1, 0, 1);
  const rotation = num(frame.rotation, 0);
  const transform = rotation ? ` transform="rotate(${fmt(rotation)} ${fmt(x + w / 2)} ${fmt(y + h / 2)})"` : "";
  const attrs = `data-element="${escapeAttr(str(el.id) ?? "")}"${opacity < 1 ? ` opacity="${fmt(opacity)}"` : ""}${transform}`;
  switch (el.type) {
    case "line":
    case "connector":
      return `<g ${attrs}>${lineMarkup(el, frame, style, byId)}</g>`;
    case "ellipse":
      return `<g ${attrs}><ellipse cx="${fmt(x + w / 2)}" cy="${fmt(y + h / 2)}" rx="${fmt(w / 2)}" ry="${fmt(h / 2)}"${paint(style)}/>${textBox(el, frame, style, "middle")}</g>`;
    case "shape":
      return `<g ${attrs}>${boxMarkup(frame, style)}${textBox(el, frame, style, "middle")}</g>`;
    case "text":
      return `<g ${attrs}>${hasPaint(style) ? boxMarkup(frame, style) : ""}${textBox(el, frame, style)}</g>`;
    case "table":
      return `<g ${attrs}>${tableMarkup(el, frame, style)}</g>`;
    case "chart":
      return `<g ${attrs}>${chartMarkup(el, frame, style, uid)}</g>`;
    case "image":
      return `<g ${attrs}>${imageMarkup(el, frame, options)}</g>`;
    default:
      return `<g ${attrs}>${placeholder(frame, str(el.name) ?? String(el.type ?? "element"))}</g>`;
  }
}

function boxMarkup(frame: Box, style: ElementStyle): string {
  const radius = bounded(style.radius, 0, 0, Math.min(frame.w, frame.h) / 2);
  return `<rect x="${fmt(frame.x)}" y="${fmt(frame.y)}" width="${fmt(frame.w)}" height="${fmt(frame.h)}"${radius ? ` rx="${fmt(radius)}"` : ""}${paint(style)}/>`;
}

function paint(style: ElementStyle): string {
  const fill = color(style.fill, "transparent");
  const stroke = color(style.stroke, "transparent");
  const width = bounded(style.strokeWidth, 0, 0, 200);
  const dash = style.lineStyle === "dashed" ? ` stroke-dasharray="${fmt(width * 3 || 6)} ${fmt(width * 2 || 4)}"` : "";
  return ` fill="${fill === "transparent" ? "none" : fill}"${stroke !== "transparent" && width > 0 ? ` stroke="${stroke}" stroke-width="${fmt(width)}"${dash}` : ""}`;
}

function hasPaint(style: ElementStyle): boolean {
  return color(style.fill, "transparent") !== "transparent" || (color(style.stroke, "transparent") !== "transparent" && num(style.strokeWidth, 0) > 0);
}

/** Text is laid out by the browser inside a foreignObject so it wraps like the canvas editor does. */
function textBox(el: CanvasElement, frame: Box, style: ElementStyle, defaultAlign: "top" | "middle" = "top"): string {
  const paragraphs = paragraphsOf(el);
  if (paragraphs.length === 0) return "";
  const padding = bounded(style.padding, 0, 0, 400);
  const vertical = style.verticalAlign === "middle" || style.verticalAlign === "bottom" || style.verticalAlign === "top" ? style.verticalAlign : defaultAlign;
  const justify = vertical === "middle" ? "center" : vertical === "bottom" ? "flex-end" : "flex-start";
  const css = [
    "box-sizing:border-box",
    "width:100%",
    "height:100%",
    "display:flex",
    "flex-direction:column",
    `justify-content:${justify}`,
    "overflow:hidden",
    `padding:${fmt(padding)}px`,
    `color:${color(style.color, "#1d1c1a")}`,
    `font-family:${font(style.fontFamily)}`,
    `font-size:${fmt(bounded(style.fontSize, 24, 1, 800))}px`,
    `font-weight:${Math.round(bounded(style.fontWeight, 400, 100, 900))}`,
    `font-style:${style.fontStyle === "italic" ? "italic" : "normal"}`,
    `line-height:${fmt(bounded(style.lineHeight, 1.3, 0.5, 5))}`,
    `letter-spacing:${fmt(bounded(style.letterSpacing, 0, -20, 100))}px`,
    `text-align:${style.textAlign === "center" || style.textAlign === "right" ? style.textAlign : "left"}`,
    `text-decoration:${[style.underline ? "underline" : "", style.strike ? "line-through" : ""].filter(Boolean).join(" ") || "none"}`,
    "overflow-wrap:anywhere",
  ].join(";");
  let number = 0;
  const lines = paragraphs
    .map((p) => {
      const level = Math.round(bounded(p.level, 0, 0, 8));
      const indent = p.kind === "bullet" || p.kind === "number" ? 1.2 + level * 1.2 : 0;
      number = p.kind === "number" ? number + 1 : 0;
      const marker = p.kind === "bullet" ? "• " : p.kind === "number" ? `${number}. ` : "";
      const pad = indent ? `padding-left:${fmt(indent)}em;text-indent:-1.1em;` : "";
      return `<div style="${pad}margin:0;min-height:1em">${escapeHtml(marker + p.text)}</div>`;
    })
    .join("");
  return `<foreignObject x="${fmt(frame.x)}" y="${fmt(frame.y)}" width="${fmt(frame.w)}" height="${fmt(frame.h)}"><div xmlns="http://www.w3.org/1999/xhtml" style="${css}">${lines}</div></foreignObject>`;
}

function lineMarkup(el: CanvasElement, frame: Box, style: ElementStyle, byId: Map<string, CanvasElement>): string {
  const start = endpoint(el.from, byId) ?? { x: frame.x, y: frame.y };
  const end = endpoint(el.to, byId) ?? { x: frame.x + frame.w, y: frame.y + frame.h };
  const stroke = color(style.stroke, "#1d1c1a");
  const width = bounded(style.strokeWidth, 2, 0.5, 200);
  const dash = style.lineStyle === "dashed" ? ` stroke-dasharray="${fmt(width * 3)} ${fmt(width * 2)}"` : "";
  return `<line x1="${fmt(start.x)}" y1="${fmt(start.y)}" x2="${fmt(end.x)}" y2="${fmt(end.y)}" stroke="${stroke === "transparent" ? "#1d1c1a" : stroke}" stroke-width="${fmt(width)}"${dash}/>`;
}

function endpoint(value: unknown, byId: Map<string, CanvasElement>): { x: number; y: number } | undefined {
  if (!isRecord(value)) return undefined;
  const target = typeof value.elementId === "string" ? byId.get(value.elementId) : undefined;
  if (target) {
    const f = frameOf(target);
    switch (value.anchor) {
      case "top":
        return { x: f.x + f.w / 2, y: f.y };
      case "bottom":
        return { x: f.x + f.w / 2, y: f.y + f.h };
      case "left":
        return { x: f.x, y: f.y + f.h / 2 };
      case "right":
        return { x: f.x + f.w, y: f.y + f.h / 2 };
      default:
        return { x: f.x + f.w / 2, y: f.y + f.h / 2 };
    }
  }
  if (Number.isFinite(value.x) && Number.isFinite(value.y)) return { x: value.x as number, y: value.y as number };
  return undefined;
}

function tableMarkup(el: CanvasElement, frame: Box, style: ElementStyle): string {
  const table = isRecord(el.table) ? el.table : undefined;
  const rows = (Array.isArray(table?.rows) ? table.rows : []).filter(Array.isArray) as unknown[][];
  if (rows.length === 0) return placeholder(frame, "table");
  const border = color(style.stroke, "#cbd5e1");
  const cell = `border:1px solid ${border === "transparent" ? "#cbd5e1" : border};padding:.25em .45em;text-align:left;vertical-align:top`;
  const html = rows
    .map((row, index) => {
      const tag = index === 0 && table?.header !== false ? "th" : "td";
      return `<tr>${row.map((value) => `<${tag} style="${cell}${tag === "th" ? ";font-weight:700" : ""}">${escapeHtml(String(value ?? ""))}</${tag}>`).join("")}</tr>`;
    })
    .join("");
  const css = `width:100%;border-collapse:collapse;table-layout:fixed;color:${color(style.color, "#1d1c1a")};font-family:${font(style.fontFamily)};font-size:${fmt(bounded(style.fontSize, 18, 1, 400))}px;line-height:1.25`;
  return `<foreignObject x="${fmt(frame.x)}" y="${fmt(frame.y)}" width="${fmt(frame.w)}" height="${fmt(frame.h)}"><div xmlns="http://www.w3.org/1999/xhtml" style="width:100%;height:100%;overflow:hidden"><table style="${css}">${html}</table></div></foreignObject>`;
}

const CHART_COLORS = ["#2f6fa7", "#b9522a", "#2f7048", "#8a5cb8", "#9a681f", "#0f666b"];

function chartMarkup(el: CanvasElement, frame: Box, style: ElementStyle, uid: string): string {
  const chart = isRecord(el.chart) ? el.chart : undefined;
  if (!chart) return placeholder(frame, "chart");
  const labels = (Array.isArray(chart.labels) ? chart.labels : []).map((label) => String(label ?? ""));
  const series = chartSeries(chart);
  if (labels.length === 0 || series.length === 0) return placeholder(frame, "chart");
  const colors = (Array.isArray(chart.colors) ? chart.colors : []).map((c) => color(c, ""));
  const ink = color(style.color, "#1d1c1a");
  const fontSize = bounded(style.fontSize, 14, 6, 60);
  const title = str(chart.title);
  const top = frame.y + (title ? fontSize * 1.8 : fontSize * 0.6);
  const bottom = frame.y + frame.h - fontSize * 1.6;
  const left = frame.x + fontSize * 0.6;
  const right = frame.x + frame.w - fontSize * 0.6;
  const plotH = Math.max(1, bottom - top);
  const max = Math.max(0, ...series.flatMap((s) => s.values));
  const min = Math.min(0, ...series.flatMap((s) => s.values));
  const span = max - min || 1;
  const yOf = (value: number): number => bottom - ((value - min) / span) * plotH;
  const slot = (right - left) / labels.length;
  const parts: string[] = [];
  if (title) parts.push(`<text x="${fmt(frame.x + frame.w / 2)}" y="${fmt(frame.y + fontSize * 1.2)}" text-anchor="middle" font-size="${fmt(fontSize * 1.1)}" font-weight="700" fill="${ink}" font-family="${escapeAttr(font(style.fontFamily))}">${escapeHtml(title)}</text>`);
  if (chart.grid) {
    for (let i = 0; i <= 4; i++) {
      const gy = top + (plotH * i) / 4;
      parts.push(`<line x1="${fmt(left)}" x2="${fmt(right)}" y1="${fmt(gy)}" y2="${fmt(gy)}" stroke="#e2e8f0" stroke-width="1"/>`);
    }
  }
  parts.push(`<line x1="${fmt(left)}" x2="${fmt(right)}" y1="${fmt(yOf(0))}" y2="${fmt(yOf(0))}" stroke="#94a3b8" stroke-width="1"/>`);
  const seriesColor = (index: number): string => colors[index] || CHART_COLORS[index % CHART_COLORS.length]!;
  if (chart.kind === "line") {
    series.forEach((s, si) => {
      const points = labels.map((_, i) => `${fmt(left + slot * (i + 0.5))},${fmt(yOf(s.values[i] ?? 0))}`).join(" ");
      parts.push(`<polyline points="${points}" fill="none" stroke="${seriesColor(si)}" stroke-width="${fmt(Math.max(2, fontSize / 6))}"/>`);
    });
  } else {
    const barW = (slot * 0.7) / series.length;
    series.forEach((s, si) => {
      labels.forEach((_, i) => {
        const value = s.values[i] ?? 0;
        const bx = left + slot * i + slot * 0.15 + barW * si;
        const y0 = yOf(Math.max(0, value));
        const height = Math.abs(yOf(value) - yOf(0));
        parts.push(`<rect x="${fmt(bx)}" y="${fmt(y0)}" width="${fmt(barW)}" height="${fmt(height)}" fill="${seriesColor(si)}"/>`);
      });
    });
  }
  labels.forEach((label, i) => {
    parts.push(`<text x="${fmt(left + slot * (i + 0.5))}" y="${fmt(bottom + fontSize * 1.2)}" text-anchor="middle" font-size="${fmt(fontSize)}" fill="${ink}" font-family="${escapeAttr(font(style.fontFamily))}">${escapeHtml(label)}</text>`);
  });
  return `<g data-chart="${escapeAttr(uid)}">${parts.join("")}</g>`;
}

/** Normalised chart series: `series` when present, else the single `values` array. */
export function chartSeries(chart: Record<string, unknown>): Array<{ name: string; values: number[] }> {
  const toValues = (raw: unknown): number[] => (Array.isArray(raw) ? raw.map((v) => (typeof v === "number" && Number.isFinite(v) ? v : 0)) : []);
  if (Array.isArray(chart.series) && chart.series.length > 0) {
    return chart.series.filter(isRecord).map((s, i) => ({ name: str(s.name) ?? `Series ${i + 1}`, values: toValues(s.values) }));
  }
  const values = toValues(chart.values);
  return values.length ? [{ name: str(chart.title) ?? "Series 1", values }] : [];
}

function imageMarkup(el: CanvasElement, frame: Box, options: CanvasSvgOptions): string {
  const content = isRecord(el.content) ? el.content : {};
  const src = str(content.src);
  const alt = str(content.alt) ?? str(el.name) ?? "image";
  const href = src ? (SAFE_IMAGE_DATA.test(src) ? src : options.resolveImage?.(src)) : undefined;
  if (!href) return placeholder(frame, `image: ${alt}`);
  const fit = isRecord(el.style) && el.style.fit === "contain" ? "xMidYMid meet" : "xMidYMid slice";
  return `<image href="${escapeAttr(href)}" x="${fmt(frame.x)}" y="${fmt(frame.y)}" width="${fmt(frame.w)}" height="${fmt(frame.h)}" preserveAspectRatio="${fit}"><title>${escapeHtml(alt)}</title></image>`;
}

function placeholder(frame: Box, label: string): string {
  const size = Math.max(8, Math.min(18, frame.h / 3));
  return `<rect x="${fmt(frame.x)}" y="${fmt(frame.y)}" width="${fmt(frame.w)}" height="${fmt(frame.h)}" fill="#f1f5f9" stroke="#94a3b8" stroke-dasharray="6 4"/><text x="${fmt(frame.x + frame.w / 2)}" y="${fmt(frame.y + frame.h / 2)}" text-anchor="middle" dominant-baseline="middle" font-size="${fmt(size)}" fill="#475569" font-family="system-ui, sans-serif">${escapeHtml(label)}</text>`;
}

/** Paragraphs of a text-bearing element, preferring structured paragraphs over raw text. */
export function paragraphsOf(el: CanvasElement): Array<{ text: string; kind: "bullet" | "number" | "plain"; level: number }> {
  const content = isRecord(el.content) ? el.content : undefined;
  if (!content) return [];
  if (Array.isArray(content.paragraphs) && content.paragraphs.length > 0) {
    return content.paragraphs.filter(isRecord).map((p) => ({
      text: String(p.text ?? ""),
      kind: p.kind === "bullet" || p.kind === "number" ? p.kind : "plain",
      level: bounded(p.level, 0, 0, 8),
    }));
  }
  const text = str(content.text) ?? str(content.label);
  if (!text) return [];
  return text.split("\n").map((line) => ({ text: line, kind: "plain" as const, level: 0 }));
}

function elementText(el: CanvasElement): string {
  return paragraphsOf(el).map((p) => p.text).join("\n").trim();
}

type Box = { x: number; y: number; w: number; h: number; rotation: number };

/** An element's frame with every field finite and bounded. */
export function frameOf(el: CanvasElement): Box {
  const frame: Record<string, unknown> = isRecord(el.frame) ? el.frame : {};
  return {
    x: bounded(frame.x, 0, -50000, 50000),
    y: bounded(frame.y, 0, -50000, 50000),
    w: bounded(frame.w, 0, 0, 50000),
    h: bounded(frame.h, 0, 0, 50000),
    rotation: bounded(frame.rotation, 0, -360, 360),
  };
}

function styleOf(el: CanvasElement): ElementStyle {
  return (isRecord(el.style) ? el.style : {}) as ElementStyle;
}

const SAFE_IMAGE_DATA = /^data:image\/(png|jpeg|gif|webp);base64,[A-Za-z0-9+/=]+$/;
const HEX_COLOR = /^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
const FUNC_COLOR = /^(?:rgb|rgba|hsl|hsla)\(\s*[\d.%\s,/-]+\)$/;
const NAMED_COLOR = /^[a-zA-Z]{3,20}$/;

/** A CSS colour safe to place in an attribute or style, else `fallback`. */
export function color(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  const v = value.trim();
  if (HEX_COLOR.test(v) || FUNC_COLOR.test(v) || NAMED_COLOR.test(v)) return v;
  return fallback;
}

function font(value: unknown): string {
  if (typeof value !== "string") return "system-ui, sans-serif";
  const cleaned = value.replace(/[^\w\s,'-]/g, "").trim();
  return cleaned || "system-ui, sans-serif";
}

function bounded(value: unknown, fallback: number, min: number, max: number): number {
  const n = typeof value === "number" && Number.isFinite(value) ? value : fallback;
  return Math.min(max, Math.max(min, n));
}

function num(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value : undefined;
}

function fmt(n: number): string {
  return String(Math.round(n * 100) / 100);
}

function safeIdPart(value: string): string {
  return value.replace(/[^A-Za-z0-9_-]/g, "-") || "canvas";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const ATTACHMENT_PREFIX = "att:";

/**
 * Canvas JSON carried by a `::canvas` block: a fenced ```json child, a bare
 * JSON body (what the CLI loader inlines from `src=`), or an `att:` reference
 * resolved by the host. `src` echoes the reference when nothing resolved.
 */
export function canvasSourceOf(
  node: DirectiveNode,
  resolveCanvas?: (ref: string) => string | undefined,
): { json?: string; src?: string } {
  const code = node.children.find((child) => child.type === "code");
  if (code && code.type === "code" && code.content.trim()) return { json: code.content };
  const body = node.body?.trim();
  if (body && body.startsWith("{")) return { json: body };
  const src = typeof node.attrs.src === "string" ? node.attrs.src.trim() : "";
  if (!src) return {};
  if (src.toLowerCase().startsWith(ATTACHMENT_PREFIX) && resolveCanvas) {
    const json = resolveCanvas(src.slice(ATTACHMENT_PREFIX.length));
    if (json !== undefined) return { json, src };
  }
  return { src };
}

/**
 * Text-only view of a `::canvas` for LLM, Markdown, and DOCX output: one
 * heading line per page followed by its text in reading order, or a single
 * line explaining why the canvas is unavailable.
 */
export function canvasTextLines(node: DirectiveNode, resolveCanvas?: (ref: string) => string | undefined): { pages: Array<{ page: string; lines: string[] }>; error?: string } {
  const { json, src } = canvasSourceOf(node, resolveCanvas);
  if (json === undefined) return { pages: [], error: src ? `canvas not available: ${src}` : "canvas has no source" };
  const read = readCanvasDocument(json);
  if (!read.ok) return { pages: [], error: read.error };
  const pageId = typeof node.attrs.page === "string" ? node.attrs.page : undefined;
  return { pages: canvasOutline(read.document, pageId) };
}
