import type { Attrs, DirectiveNode, DocumentNode, Node, SectionNode, TableAlign, TableNode } from "./ast.js";
import { walk } from "./ast.js";
import { splitPipeRow } from "./inline.js";

export interface DocxRenderOptions {
  /** Override document title used in package metadata. */
  title?: string;
  /** Creator metadata written to docProps/core.xml. */
  creator?: string;
  /** Short package description. */
  description?: string;
}

interface Relationship {
  id: string;
  type: string;
  target: string;
  targetMode?: "External";
}

interface DocxCtx {
  relationships: Relationship[];
  nextRelationshipId: number;
  bookmarkNames: Map<string, string>;
  bookmarkIds: Map<string, number>;
  nextBookmarkId: number;
}

interface RunStyle {
  bold?: boolean;
  italic?: boolean;
  code?: boolean;
  color?: string;
  underline?: boolean;
}

interface ParagraphOptions {
  style?: string;
  align?: "left" | "center" | "right";
  numId?: number;
  bookmarkId?: string;
  bottomBorder?: boolean;
}

interface TableCellOptions {
  header?: boolean;
  align?: TableAlign;
  width: number;
}

const W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const R_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const REL_NS = "http://schemas.openxmlformats.org/package/2006/relationships";
const PACKAGE_REL_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const CORE_REL_NS = "http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties";
const APP_REL_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties";
const FIXED_CORE_TIME = "2026-01-01T00:00:00Z";

export function renderDocx(doc: DocumentNode, options: DocxRenderOptions = {}): Buffer {
  const ctx: DocxCtx = {
    relationships: [],
    nextRelationshipId: 3,
    bookmarkNames: buildBookmarkNames(doc),
    bookmarkIds: new Map(),
    nextBookmarkId: 1,
  };
  const title =
    options.title ||
    (typeof doc.meta.title === "string" ? doc.meta.title : undefined) ||
    extractFirstHeading(doc) ||
    "Noma Document";

  const documentXml = resolveBookmarkPlaceholders(renderDocumentXml(doc, ctx), ctx);
  const relsXml = renderDocumentRelationships(ctx.relationships);
  const entries = [
    { path: "[Content_Types].xml", data: contentTypesXml() },
    { path: "_rels/.rels", data: rootRelationshipsXml() },
    { path: "docProps/core.xml", data: corePropertiesXml(title, options) },
    { path: "docProps/app.xml", data: appPropertiesXml() },
    { path: "word/document.xml", data: documentXml },
    { path: "word/_rels/document.xml.rels", data: relsXml },
    { path: "word/styles.xml", data: stylesXml() },
    { path: "word/numbering.xml", data: numberingXml() },
  ];
  return zipStore(entries);
}

function renderDocumentXml(doc: DocumentNode, ctx: DocxCtx): string {
  const body = doc.children.map((node) => renderNode(node, ctx)).join("");
  return xmlDecl(`\
<w:document xmlns:w="${W_NS}" xmlns:r="${R_NS}">
  <w:body>
${body}    <w:sectPr>
      <w:pgSz w:w="12240" w:h="15840"/>
      <w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/>
    </w:sectPr>
  </w:body>
</w:document>`);
}

function renderNode(node: Node, ctx: DocxCtx): string {
  switch (node.type) {
    case "document":
      return node.children.map((child) => renderNode(child, ctx)).join("");
    case "section":
      return renderSection(node, ctx);
    case "paragraph":
      return paragraph(inlineRuns(node.content, ctx));
    case "code":
      return renderCode(node.content, node.lang);
    case "list":
      return node.items
        .map((item) => paragraph(inlineRuns(item.content, ctx), { numId: node.ordered ? 2 : 1 }))
        .join("");
    case "list_item":
      return paragraph(inlineRuns(node.content, ctx), { numId: 1 });
    case "quote":
      return splitLines(node.content).map((line) => paragraph(inlineRuns(line, ctx), { style: "NomaQuote" })).join("");
    case "thematic_break":
      return paragraph("", { bottomBorder: true });
    case "table":
      return renderTable(node, ctx);
    case "directive":
      return renderDirective(node, ctx);
    case "frontmatter":
      return "";
    default: {
      const _exhaustive: never = node;
      void _exhaustive;
      return "";
    }
  }
}

function renderSection(node: SectionNode, ctx: DocxCtx): string {
  const style = `Heading${Math.min(Math.max(node.level, 1), 6)}`;
  const heading = paragraph(inlineRuns(node.title, ctx, { bold: true }), {
    style,
    bookmarkId: node.id,
  });
  return heading + node.children.map((child) => renderNode(child, ctx)).join("");
}

function renderDirective(node: DirectiveNode, ctx: DocxCtx): string {
  if (node.name === "table") return renderTableDirective(node, ctx);
  if (node.name === "plot") return renderPlot(node, ctx);
  if (node.name === "figure") return renderFigure(node, ctx);
  if (isVerbatimDirective(node.name)) return renderVerbatimDirective(node, ctx);

  const title = directiveTitle(node);
  const label = paragraph(textRun(title, { bold: true, color: "3f5f4a" }), {
    style: "NomaDirective",
    bookmarkId: node.id,
  });
  return label + renderDirectiveContent(node, ctx);
}

function renderDirectiveContent(node: DirectiveNode, ctx: DocxCtx): string {
  if (node.children.length > 0) {
    return node.children.map((child) => renderNode(child, ctx)).join("");
  }
  return renderBodyParagraphs(node.body ?? "", ctx);
}

function renderBodyParagraphs(body: string, ctx: DocxCtx): string {
  const text = body.trim();
  if (!text) return "";
  return text
    .split(/\n\s*\n/)
    .map((para) => paragraph(inlineRuns(para.replace(/\n/g, " "), ctx)))
    .join("");
}

function renderCode(content: string, lang?: string): string {
  const head = lang ? paragraph(textRun(`Code (${lang})`, { bold: true }), { style: "NomaMeta" }) : "";
  const lines = splitLines(content);
  return head + lines.map((line) => paragraph(textRun(line, { code: true }), { style: "NomaCode" })).join("");
}

function renderVerbatimDirective(node: DirectiveNode, ctx: DocxCtx): string {
  const label = paragraph(textRun(directiveTitle(node), { bold: true, color: "3f5f4a" }), {
    style: "NomaDirective",
    bookmarkId: node.id,
  });
  const body = node.body ?? "";
  if (!body.trim()) return label;
  return label + splitLines(body).map((line) => paragraph(textRun(line, { code: true }), { style: "NomaCode" })).join("");
}

function renderPlot(node: DirectiveNode, ctx: DocxCtx): string {
  const title = typeof node.attrs.title === "string" ? node.attrs.title : "Plot";
  const source = node.attrs.dataset ?? node.attrs.data ?? node.attrs.src ?? "";
  const type = node.attrs.type ? String(node.attrs.type) : "line";
  const details = source ? `${type} plot, source: ${String(source)}` : `${type} plot`;
  return (
    paragraph(textRun(`Plot: ${title}`, { bold: true, color: "3f5f4a" }), {
      style: "NomaDirective",
      bookmarkId: node.id,
    }) + paragraph(textRun(details), { style: "NomaMeta" })
  );
}

function renderFigure(node: DirectiveNode, ctx: DocxCtx): string {
  const caption = typeof node.attrs.caption === "string" ? node.attrs.caption : "Figure";
  const src = typeof node.attrs.src === "string" ? node.attrs.src : "";
  const body = renderDirectiveContent(node, ctx);
  const source = src ? paragraph(inlineRuns(`Source: [${src}](${src})`, ctx), { style: "NomaMeta" }) : "";
  return (
    paragraph(textRun(`Figure: ${caption}`, { bold: true, color: "3f5f4a" }), {
      style: "NomaDirective",
      bookmarkId: node.id,
    }) +
    source +
    body
  );
}

function renderTable(node: TableNode, ctx: DocxCtx): string {
  const columns = Math.max(node.header.length, ...node.rows.map((row) => row.length), 1);
  const widths = tableWidths(columns);
  const header = tableRow(node.header, ctx, widths, { header: true, align: node.align });
  const rows = node.rows
    .map((row) => tableRow(row, ctx, widths, { align: node.align }))
    .join("");
  return tableXml(header + rows, widths);
}

function renderTableDirective(node: DirectiveNode, ctx: DocxCtx): string {
  const body = node.body ?? "";
  const rows = body.split("\n").map((line) => line.trim()).filter(Boolean).map(splitPipeRow);
  const columns = Math.max(...rows.map((row) => row.length), 1);
  for (const row of rows) while (row.length < columns) row.push("");
  const widths = tableWidths(columns);
  const align = typeof node.attrs.align === "string" ? parseDirectiveAlign(node.attrs.align, columns) : [];
  const wantsHeader = node.attrs.header === true || node.attrs.header === "true";
  const label = node.id
    ? paragraph("", { style: "NomaMeta", bookmarkId: node.id })
    : "";
  if (rows.length === 0) return label;
  const first = wantsHeader ? rows.shift() : undefined;
  const header = first ? tableRow(first, ctx, widths, { header: true, align }) : "";
  const bodyRows = rows.map((row) => tableRow(row, ctx, widths, { align })).join("");
  return label + tableXml(header + bodyRows, widths);
}

function tableXml(rows: string, widths: number[]): string {
  const grid = widths.map((width) => `<w:gridCol w:w="${width}"/>`).join("");
  return `\
    <w:tbl>
      <w:tblPr>
        <w:tblStyle w:val="TableGrid"/>
        <w:tblW w:w="0" w:type="auto"/>
        <w:tblCellMar>
          <w:top w:w="90" w:type="dxa"/>
          <w:left w:w="120" w:type="dxa"/>
          <w:bottom w:w="90" w:type="dxa"/>
          <w:right w:w="120" w:type="dxa"/>
        </w:tblCellMar>
      </w:tblPr>
      <w:tblGrid>${grid}</w:tblGrid>
${rows}    </w:tbl>
`;
}

function tableRow(
  cells: string[],
  ctx: DocxCtx,
  widths: number[],
  options: { header?: boolean; align?: TableAlign[] },
): string {
  const rowCells = widths
    .map((width, index) =>
      tableCell(cells[index] ?? "", ctx, {
        header: options.header,
        align: options.align?.[index] ?? null,
        width,
      }),
    )
    .join("");
  const rowPr = options.header ? "<w:trPr><w:tblHeader/></w:trPr>" : "";
  return `      <w:tr>${rowPr}${rowCells}</w:tr>\n`;
}

function tableCell(content: string, ctx: DocxCtx, options: TableCellOptions): string {
  const shade = options.header ? '<w:shd w:fill="E8F0EA"/>' : "";
  const props = `\
<w:tcPr>
  <w:tcW w:w="${options.width}" w:type="dxa"/>
  <w:vAlign w:val="center"/>
  ${shade}
</w:tcPr>`;
  const runs = inlineRuns(content, ctx, options.header ? { bold: true } : {});
  return `<w:tc>${props}${paragraph(runs, { align: wordAlign(options.align ?? null) })}</w:tc>`;
}

function tableWidths(columns: number): number[] {
  const usable = 9360;
  const base = Math.floor(usable / columns);
  const widths = new Array<number>(columns).fill(base);
  widths[columns - 1] = usable - base * (columns - 1);
  return widths;
}

function parseDirectiveAlign(raw: string, columns: number): TableAlign[] {
  const parts = raw.split(/[,\s]+/).map((part) => part.trim().toLowerCase()).filter(Boolean);
  const out: TableAlign[] = [];
  for (let i = 0; i < columns; i++) {
    const code = parts[i] ?? "-";
    if (code === "l" || code === "left") out.push("left");
    else if (code === "c" || code === "center") out.push("center");
    else if (code === "r" || code === "right") out.push("right");
    else out.push(null);
  }
  return out;
}

function wordAlign(align: TableAlign): "left" | "center" | "right" | undefined {
  return align ?? undefined;
}

function directiveTitle(node: DirectiveNode): string {
  const title = typeof node.attrs.title === "string" ? node.attrs.title : undefined;
  const caption = typeof node.attrs.caption === "string" ? node.attrs.caption : undefined;
  if (node.name === "card" && title) return title;
  if (node.name === "figure" && caption) return `Figure: ${caption}`;
  if (node.name === "export_button") return `Export button: ${node.attrs.format ?? "text"}`;
  if (node.name === "control") return `Control: ${node.attrs.type ?? "text"}`;
  const attrs = attrsSummary(node.attrs);
  return attrs ? `${node.name} (${attrs})` : node.name;
}

function attrsSummary(attrs: Attrs): string {
  const skip = new Set(["id", "title", "caption", "variant"]);
  return Object.entries(attrs)
    .filter(([key]) => !skip.has(key))
    .map(([key, value]) => (value === true ? key : `${key}=${String(value)}`))
    .join(", ");
}

function isVerbatimDirective(name: string): boolean {
  return name === "dataset" || name === "diagram" || name === "plotly" || name === "math" || name === "html" || name === "svg" || name === "script";
}

function paragraph(runs: string, options: ParagraphOptions = {}): string {
  const props: string[] = [];
  if (options.style) props.push(`<w:pStyle w:val="${xmlAttr(options.style)}"/>`);
  if (options.align) props.push(`<w:jc w:val="${options.align}"/>`);
  if (options.numId !== undefined) {
    props.push(`<w:numPr><w:ilvl w:val="0"/><w:numId w:val="${options.numId}"/></w:numPr>`);
  }
  if (options.bottomBorder) {
    props.push('<w:pBdr><w:bottom w:val="single" w:sz="6" w:space="1" w:color="AAB7AF"/></w:pBdr>');
  }
  const pPr = props.length > 0 ? `<w:pPr>${props.join("")}</w:pPr>` : "";
  return `    <w:p>${pPr}${bookmarkStartXml(options.bookmarkId)}${runs}${bookmarkEndXml(options.bookmarkId)}</w:p>\n`;
}

function bookmarkStartXml(id: string | undefined): string {
  if (!id) return "";
  return `{{BOOKMARK_START:${xmlAttr(id)}}}`;
}

function bookmarkEndXml(id: string | undefined): string {
  if (!id) return "";
  return `{{BOOKMARK_END:${xmlAttr(id)}}}`;
}

function resolveBookmarkPlaceholders(xml: string, ctx: DocxCtx): string {
  return xml.replace(/\{\{BOOKMARK_(START|END):([^}]+)\}\}/g, (_match, kind: string, rawId: string) => {
    const id = unescapePlaceholderId(rawId);
    const name = ctx.bookmarkNames.get(id);
    if (!name) return "";
    const num = bookmarkNumber(id, ctx);
    return kind === "START"
      ? `<w:bookmarkStart w:id="${num}" w:name="${xmlAttr(name)}"/>`
      : `<w:bookmarkEnd w:id="${num}"/>`;
  });
}

function bookmarkNumber(id: string, ctx: DocxCtx): number {
  let num = ctx.bookmarkIds.get(id);
  if (num === undefined) {
    num = ctx.nextBookmarkId++;
    ctx.bookmarkIds.set(id, num);
  }
  return num;
}

function unescapePlaceholderId(id: string): string {
  return id
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function inlineRuns(src: string, ctx: DocxCtx, base: RunStyle = {}): string {
  const out: string[] = [];
  let i = 0;
  while (i < src.length) {
    const next = nextInlineToken(src, i);
    if (!next) {
      out.push(textRun(normalizeInlineText(src.slice(i)), base));
      break;
    }
    if (next.index > i) {
      out.push(textRun(normalizeInlineText(src.slice(i, next.index)), base));
    }
    if (next.kind === "code") out.push(textRun(normalizeInlineText(next.text), { ...base, code: true }));
    else if (next.kind === "bold") out.push(textRun(normalizeInlineText(next.text), { ...base, bold: true }));
    else if (next.kind === "italic") out.push(textRun(normalizeInlineText(next.text), { ...base, italic: true }));
    else if (next.kind === "link") out.push(linkRuns(next.text, next.href ?? "", ctx, base));
    else if (next.kind === "wikilink") out.push(wikilinkRuns(next.text, ctx, base));
    i = next.end;
  }
  return out.join("");
}

type InlineToken =
  | { kind: "code" | "bold" | "italic" | "wikilink"; index: number; end: number; text: string }
  | { kind: "link"; index: number; end: number; text: string; href: string };

function nextInlineToken(src: string, start: number): InlineToken | null {
  const slice = src.slice(start);
  const specs: Array<{ kind: InlineToken["kind"]; re: RegExp }> = [
    { kind: "code", re: /`([^`]+)`/ },
    { kind: "bold", re: /\*\*([^*]+)\*\*/ },
    { kind: "link", re: /\[([^\]]+)\]\(([^)\s]+)\)/ },
    { kind: "wikilink", re: /\[\[([a-zA-Z_][\w\-./:]*)\]\]/ },
    { kind: "italic", re: /\*([^*\n]+)\*/ },
    { kind: "italic", re: /\b_([^_\n]+)_\b/ },
  ];
  let best: InlineToken | null = null;
  for (const spec of specs) {
    const match = spec.re.exec(slice);
    if (!match || match.index === undefined) continue;
    const index = start + match.index;
    const full = match[0] ?? "";
    const text = match[1] ?? "";
    const token = spec.kind === "link"
      ? { kind: "link" as const, index, end: index + full.length, text, href: match[2] ?? "" }
      : { kind: spec.kind as Exclude<InlineToken["kind"], "link">, index, end: index + full.length, text };
    if (!best || token.index < best.index) best = token;
  }
  return best;
}

function normalizeInlineText(text: string): string {
  const hardBreak = "\u0000";
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/(?: {2,}|\\)\n/g, hardBreak)
    .replace(/\n/g, " ")
    .replace(new RegExp(hardBreak, "g"), "\n");
}

function linkRuns(label: string, href: string, ctx: DocxCtx, base: RunStyle): string {
  if (href.startsWith("#")) {
    const anchor = ctx.bookmarkNames.get(href.slice(1));
    if (anchor) {
      return `<w:hyperlink w:anchor="${xmlAttr(anchor)}">${textRun(label, { ...base, color: "0563C1", underline: true })}</w:hyperlink>`;
    }
  }
  if (/^(https?:|mailto:)/i.test(href)) {
    const relId = addRelationship(ctx, "http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink", href, "External");
    return `<w:hyperlink r:id="${xmlAttr(relId)}" w:history="1">${textRun(label, { ...base, color: "0563C1", underline: true })}</w:hyperlink>`;
  }
  return textRun(`${label} (${href})`, base);
}

function wikilinkRuns(id: string, ctx: DocxCtx, base: RunStyle): string {
  const anchor = ctx.bookmarkNames.get(id);
  if (!anchor) return textRun(id, base);
  return `<w:hyperlink w:anchor="${xmlAttr(anchor)}">${textRun(id, { ...base, color: "0563C1", underline: true })}</w:hyperlink>`;
}

function textRun(text: string, style: RunStyle = {}): string {
  if (text.length === 0) return "";
  const parts = normalizeXmlText(text).split("\n");
  const content = parts
    .map((part, index) => `${index > 0 ? "<w:br/>" : ""}<w:t xml:space="preserve">${xmlText(part)}</w:t>`)
    .join("");
  return `<w:r>${runProps(style)}${content}</w:r>`;
}

function runProps(style: RunStyle): string {
  const props: string[] = [];
  if (style.bold) props.push("<w:b/>");
  if (style.italic) props.push("<w:i/>");
  if (style.underline) props.push('<w:u w:val="single"/>');
  if (style.color) props.push(`<w:color w:val="${xmlAttr(style.color)}"/>`);
  if (style.code) {
    props.push('<w:rFonts w:ascii="Courier New" w:hAnsi="Courier New" w:cs="Courier New"/>');
    props.push('<w:sz w:val="20"/>');
    props.push('<w:shd w:fill="EEF2F0"/>');
  }
  return props.length > 0 ? `<w:rPr>${props.join("")}</w:rPr>` : "";
}

function addRelationship(
  ctx: DocxCtx,
  type: string,
  target: string,
  targetMode?: "External",
): string {
  const id = `rId${ctx.nextRelationshipId++}`;
  ctx.relationships.push({ id, type, target, ...(targetMode ? { targetMode } : {}) });
  return id;
}

function buildBookmarkNames(doc: DocumentNode): Map<string, string> {
  const names = new Map<string, string>();
  const used = new Set<string>();
  for (const node of walk(doc)) {
    if (!node.id) continue;
    const name = uniqueBookmarkName(node.id, used);
    names.set(node.id, name);
    for (const alias of node.aliases ?? []) names.set(alias, name);
  }
  return names;
}

function uniqueBookmarkName(id: string, used: Set<string>): string {
  const hash = crc32(Buffer.from(id, "utf8")).toString(16).padStart(8, "0");
  const clean = id.replace(/[^A-Za-z0-9_]/g, "_").replace(/^[^A-Za-z]+/, "");
  const stem = (clean || "id").slice(0, 28);
  let name = `n_${stem}_${hash}`.slice(0, 40);
  let i = 1;
  while (used.has(name)) {
    const suffix = `_${i++}`;
    name = `${`n_${stem}_${hash}`.slice(0, 40 - suffix.length)}${suffix}`;
  }
  used.add(name);
  return name;
}

function extractFirstHeading(doc: DocumentNode): string | undefined {
  for (const node of walk(doc)) {
    if (node.type === "section") return node.title;
  }
  return undefined;
}

function splitLines(text: string): string[] {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  return lines.length > 0 ? lines : [""];
}

function normalizeXmlText(text: string): string {
  return text.replace(/[^\u0009\u000A\u000D\u0020-\uD7FF\uE000-\uFFFD]/g, "");
}

function xmlText(text: string): string {
  return normalizeXmlText(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function xmlAttr(text: string): string {
  return xmlText(text).replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

function xmlDecl(body: string): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n${body}`;
}

function contentTypesXml(): string {
  return xmlDecl(`\
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
  <Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
  <Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>
</Types>`);
}

function rootRelationshipsXml(): string {
  return xmlDecl(`\
<Relationships xmlns="${REL_NS}">
  <Relationship Id="rId1" Type="${PACKAGE_REL_NS}/officeDocument" Target="word/document.xml"/>
  <Relationship Id="rId2" Type="${CORE_REL_NS}" Target="docProps/core.xml"/>
  <Relationship Id="rId3" Type="${APP_REL_NS}" Target="docProps/app.xml"/>
</Relationships>`);
}

function renderDocumentRelationships(relationships: Relationship[]): string {
  const dynamic = relationships
    .map((rel) => {
      const mode = rel.targetMode ? ` TargetMode="${rel.targetMode}"` : "";
      return `  <Relationship Id="${xmlAttr(rel.id)}" Type="${xmlAttr(rel.type)}" Target="${xmlAttr(rel.target)}"${mode}/>`;
    })
    .join("\n");
  return xmlDecl(`\
<Relationships xmlns="${REL_NS}">
  <Relationship Id="rId1" Type="${PACKAGE_REL_NS}/styles" Target="styles.xml"/>
  <Relationship Id="rId2" Type="${PACKAGE_REL_NS}/numbering" Target="numbering.xml"/>
${dynamic ? `${dynamic}\n` : ""}</Relationships>`);
}

function corePropertiesXml(title: string, options: DocxRenderOptions): string {
  const creator = options.creator ?? "Noma";
  const description = options.description ?? "Generated from Noma plain-text source.";
  return xmlDecl(`\
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties"
  xmlns:dc="http://purl.org/dc/elements/1.1/"
  xmlns:dcterms="http://purl.org/dc/terms/"
  xmlns:dcmitype="http://purl.org/dc/dcmitype/"
  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <dc:title>${xmlText(title)}</dc:title>
  <dc:subject>${xmlText(description)}</dc:subject>
  <dc:creator>${xmlText(creator)}</dc:creator>
  <cp:lastModifiedBy>${xmlText(creator)}</cp:lastModifiedBy>
  <dcterms:created xsi:type="dcterms:W3CDTF">${FIXED_CORE_TIME}</dcterms:created>
  <dcterms:modified xsi:type="dcterms:W3CDTF">${FIXED_CORE_TIME}</dcterms:modified>
</cp:coreProperties>`);
}

function appPropertiesXml(): string {
  return xmlDecl(`\
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"
  xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">
  <Application>Noma</Application>
  <DocSecurity>0</DocSecurity>
  <ScaleCrop>false</ScaleCrop>
  <Company/>
  <LinksUpToDate>false</LinksUpToDate>
  <SharedDoc>false</SharedDoc>
  <HyperlinksChanged>false</HyperlinksChanged>
  <AppVersion>0.11</AppVersion>
</Properties>`);
}

function stylesXml(): string {
  return xmlDecl(`\
<w:styles xmlns:w="${W_NS}">
  <w:docDefaults>
    <w:rPrDefault><w:rPr><w:rFonts w:ascii="Aptos" w:hAnsi="Aptos" w:cs="Aptos"/><w:sz w:val="22"/></w:rPr></w:rPrDefault>
    <w:pPrDefault><w:pPr><w:spacing w:after="160" w:line="276" w:lineRule="auto"/></w:pPr></w:pPrDefault>
  </w:docDefaults>
  <w:style w:type="paragraph" w:default="1" w:styleId="Normal">
    <w:name w:val="Normal"/><w:qFormat/>
    <w:pPr><w:spacing w:after="160" w:line="276" w:lineRule="auto"/></w:pPr>
    <w:rPr><w:rFonts w:ascii="Aptos" w:hAnsi="Aptos" w:cs="Aptos"/><w:sz w:val="22"/></w:rPr>
  </w:style>
${headingStyles()}
  <w:style w:type="paragraph" w:styleId="NomaDirective">
    <w:name w:val="Noma Directive"/><w:basedOn w:val="Normal"/><w:qFormat/>
    <w:pPr><w:spacing w:before="180" w:after="80"/><w:keepNext/></w:pPr>
    <w:rPr><w:b/><w:color w:val="3F5F4A"/><w:smallCaps/></w:rPr>
  </w:style>
  <w:style w:type="paragraph" w:styleId="NomaMeta">
    <w:name w:val="Noma Meta"/><w:basedOn w:val="Normal"/>
    <w:pPr><w:spacing w:after="120"/></w:pPr>
    <w:rPr><w:color w:val="6D7770"/><w:sz w:val="20"/></w:rPr>
  </w:style>
  <w:style w:type="paragraph" w:styleId="NomaCode">
    <w:name w:val="Noma Code"/><w:basedOn w:val="Normal"/>
    <w:pPr><w:spacing w:before="0" w:after="0" w:line="240" w:lineRule="auto"/></w:pPr>
    <w:rPr><w:rFonts w:ascii="Courier New" w:hAnsi="Courier New" w:cs="Courier New"/><w:sz w:val="20"/></w:rPr>
  </w:style>
  <w:style w:type="paragraph" w:styleId="NomaQuote">
    <w:name w:val="Noma Quote"/><w:basedOn w:val="Normal"/>
    <w:pPr><w:ind w:left="360"/><w:pBdr><w:left w:val="single" w:sz="12" w:space="8" w:color="AAB7AF"/></w:pBdr></w:pPr>
    <w:rPr><w:i/><w:color w:val="47514A"/></w:rPr>
  </w:style>
  <w:style w:type="table" w:styleId="TableGrid">
    <w:name w:val="Table Grid"/>
    <w:tblPr><w:tblBorders><w:top w:val="single" w:sz="4" w:color="B7C3BC"/><w:left w:val="single" w:sz="4" w:color="B7C3BC"/><w:bottom w:val="single" w:sz="4" w:color="B7C3BC"/><w:right w:val="single" w:sz="4" w:color="B7C3BC"/><w:insideH w:val="single" w:sz="4" w:color="B7C3BC"/><w:insideV w:val="single" w:sz="4" w:color="B7C3BC"/></w:tblBorders></w:tblPr>
  </w:style>
</w:styles>`);
}

function headingStyles(): string {
  const sizes = [36, 30, 26, 24, 22, 22];
  return sizes
    .map((size, index) => {
      const level = index + 1;
      const before = level === 1 ? 260 : 220;
      return `  <w:style w:type="paragraph" w:styleId="Heading${level}">
    <w:name w:val="heading ${level}"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/>
    <w:pPr><w:keepNext/><w:spacing w:before="${before}" w:after="100"/><w:outlineLvl w:val="${index}"/></w:pPr>
    <w:rPr><w:b/><w:color w:val="203C2F"/><w:sz w:val="${size}"/></w:rPr>
  </w:style>`;
    })
    .join("\n");
}

function numberingXml(): string {
  return xmlDecl(`\
<w:numbering xmlns:w="${W_NS}">
  <w:abstractNum w:abstractNumId="1">
    <w:multiLevelType w:val="singleLevel"/>
    <w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="&#8226;"/><w:lvlJc w:val="left"/><w:pPr><w:tabs><w:tab w:val="num" w:pos="720"/></w:tabs><w:ind w:left="720" w:hanging="360"/></w:pPr></w:lvl>
  </w:abstractNum>
  <w:abstractNum w:abstractNumId="2">
    <w:multiLevelType w:val="singleLevel"/>
    <w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/><w:lvlJc w:val="left"/><w:pPr><w:tabs><w:tab w:val="num" w:pos="720"/></w:tabs><w:ind w:left="720" w:hanging="360"/></w:pPr></w:lvl>
  </w:abstractNum>
  <w:num w:numId="1"><w:abstractNumId w:val="1"/></w:num>
  <w:num w:numId="2"><w:abstractNumId w:val="2"/></w:num>
</w:numbering>`);
}

interface ZipEntry {
  path: string;
  data: string | Buffer;
}

interface PreparedZipEntry {
  name: Buffer;
  data: Buffer;
  crc: number;
  offset: number;
}

function zipStore(entries: ZipEntry[]): Buffer {
  const prepared: PreparedZipEntry[] = [];
  const locals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.path, "utf8");
    const data = typeof entry.data === "string" ? Buffer.from(entry.data, "utf8") : entry.data;
    const crc = crc32(data);
    const local = localHeader(name, data, crc);
    prepared.push({ name, data, crc, offset });
    locals.push(local, data);
    offset += local.length + data.length;
  }
  const central: Buffer[] = [];
  for (const entry of prepared) central.push(centralHeader(entry));
  const centralDir = Buffer.concat(central);
  const end = endRecord(prepared.length, centralDir.length, offset);
  return Buffer.concat([...locals, centralDir, end]);
}

function localHeader(name: Buffer, data: Buffer, crc: number): Buffer {
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(0x0800, 6);
  header.writeUInt16LE(0, 8);
  header.writeUInt16LE(0, 10);
  header.writeUInt16LE(33, 12);
  header.writeUInt32LE(crc, 14);
  header.writeUInt32LE(data.length, 18);
  header.writeUInt32LE(data.length, 22);
  header.writeUInt16LE(name.length, 26);
  header.writeUInt16LE(0, 28);
  return Buffer.concat([header, name]);
}

function centralHeader(entry: PreparedZipEntry): Buffer {
  const header = Buffer.alloc(46);
  header.writeUInt32LE(0x02014b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(20, 6);
  header.writeUInt16LE(0x0800, 8);
  header.writeUInt16LE(0, 10);
  header.writeUInt16LE(0, 12);
  header.writeUInt16LE(33, 14);
  header.writeUInt32LE(entry.crc, 16);
  header.writeUInt32LE(entry.data.length, 20);
  header.writeUInt32LE(entry.data.length, 24);
  header.writeUInt16LE(entry.name.length, 28);
  header.writeUInt16LE(0, 30);
  header.writeUInt16LE(0, 32);
  header.writeUInt16LE(0, 34);
  header.writeUInt16LE(0, 36);
  header.writeUInt32LE(0, 38);
  header.writeUInt32LE(entry.offset, 42);
  return Buffer.concat([header, entry.name]);
}

function endRecord(entryCount: number, centralSize: number, centralOffset: number): Buffer {
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entryCount, 8);
  end.writeUInt16LE(entryCount, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(centralOffset, 16);
  end.writeUInt16LE(0, 20);
  return end;
}

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}
