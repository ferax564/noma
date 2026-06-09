import yaml from "js-yaml";
import type {
  AttrValue,
  DirectiveNode,
  DocumentNode,
  FrontmatterNode,
  ListNode,
  Node,
  QuoteNode,
  SectionNode,
  TableAlign,
  TableNode,
} from "./ast.js";
import { escapePipeTableCell, extractWikilinks, splitPipeRow, unescapeMarkdownTextEscapes } from "./inline.js";

export interface MarkdownRenderOptions {
  /** Include YAML frontmatter when present or when document meta has public keys. Default: true. */
  includeFrontmatter?: boolean;
  /** Drop internal meta keys such as parser filename from generated frontmatter. Default: true. */
  stripInternal?: boolean;
  /** Convert Noma [[id]] wikilinks to portable Markdown [id](#id) links. Default: true. */
  anchorWikilinks?: boolean;
  /** Emit hidden HTML anchors for IDs and aliases so fragments survive in Markdown hosts. Default: true. */
  includeAnchors?: boolean;
  /** Emit hidden directive comments with block name, ID, and attrs for agent context. Default: true. */
  semanticComments?: boolean;
  /** Include raw html/svg/script escape-hatch bodies instead of safe placeholders. Default: false. */
  includeEscapeHatches?: boolean;
}

interface RenderCtx {
  includeFrontmatter: boolean;
  stripInternal: boolean;
  anchorWikilinks: boolean;
  includeAnchors: boolean;
  semanticComments: boolean;
  includeEscapeHatches: boolean;
}

const INTERNAL_META_KEYS = new Set(["filename"]);
const ESCAPE_HATCHES = new Set(["html", "svg", "script"]);
const CODE_DIRECTIVES = new Set(["code", "code_cell", "output", "query", "example"]);
const LAYOUT_CONTAINERS = new Set(["grid", "columns", "tabs", "accordion", "hero"]);
const VERBATIM_DIRECTIVES = new Set(["dataset", "diagram", "plotly"]);

export function renderMarkdown(doc: DocumentNode, options: MarkdownRenderOptions = {}): string {
  const ctx: RenderCtx = {
    includeFrontmatter: options.includeFrontmatter !== false,
    stripInternal: options.stripInternal !== false,
    anchorWikilinks: options.anchorWikilinks !== false,
    includeAnchors: options.includeAnchors !== false,
    semanticComments: options.semanticComments !== false,
    includeEscapeHatches: options.includeEscapeHatches === true,
  };
  const chunks: string[] = [];
  const hasFrontmatterNode = doc.children[0]?.type === "frontmatter";
  if (ctx.includeFrontmatter && !hasFrontmatterNode) {
    const frontmatter = frontmatterFromMeta(doc, ctx);
    if (frontmatter) chunks.push(frontmatter);
  }
  for (const child of doc.children) chunks.push(renderNode(child, ctx, 1));
  return joinBlocks(chunks) + "\n";
}

function frontmatterFromMeta(doc: DocumentNode, ctx: RenderCtx): string {
  const entries = Object.entries(doc.meta).filter(([key]) => {
    return !ctx.stripInternal || !INTERNAL_META_KEYS.has(key);
  });
  if (entries.length === 0) return "";
  return `---\n${yaml.dump(Object.fromEntries(entries)).trimEnd()}\n---`;
}

function renderNode(node: Node, ctx: RenderCtx, depth: number): string {
  switch (node.type) {
    case "document":
      return joinBlocks(node.children.map((child) => renderNode(child, ctx, depth)));
    case "frontmatter":
      return renderFrontmatter(node, ctx);
    case "section":
      return renderSection(node, ctx, depth);
    case "paragraph":
      return renderInline(node.content, ctx);
    case "code":
      return fenced(node.content, node.lang);
    case "list":
      return renderList(node, ctx);
    case "list_item":
      return `- ${renderInline(node.content, ctx)}`;
    case "quote":
      return renderQuote(node, ctx);
    case "thematic_break":
      return "---";
    case "table":
      return renderPipeTable(node.header, node.rows, node.align, ctx);
    case "directive":
      return renderDirective(node, ctx, depth);
    default: {
      const _exhaustive: never = node;
      void _exhaustive;
      return "";
    }
  }
}

function renderFrontmatter(node: FrontmatterNode, ctx: RenderCtx): string {
  return ctx.includeFrontmatter ? `---\n${node.raw}\n---` : "";
}

function renderSection(node: SectionNode, ctx: RenderCtx, depth: number): string {
  const level = Math.max(1, Math.min(6, node.level));
  const heading = `${"#".repeat(level)} ${renderInline(node.title, ctx)}`;
  const anchors = renderAnchors([node.id, ...(node.aliases ?? [])], ctx);
  const children = joinBlocks(node.children.map((child) => renderNode(child, ctx, depth + 1)));
  return joinBlocks([anchors, heading, children]);
}

function renderList(node: ListNode, ctx: RenderCtx): string {
  return node.items
    .map((item, index) => {
      const marker = node.ordered ? `${index + 1}.` : "-";
      return `${marker} ${renderInline(item.content, ctx)}`;
    })
    .join("\n");
}

function renderQuote(node: QuoteNode, ctx: RenderCtx): string {
  return renderInline(node.content, ctx)
    .split("\n")
    .map((line) => (line ? `> ${line}` : ">"))
    .join("\n");
}

function renderDirective(node: DirectiveNode, ctx: RenderCtx, depth: number): string {
  if (ESCAPE_HATCHES.has(node.name) && !ctx.includeEscapeHatches) {
    return wrapDirective(node, `[${readableDirectiveName(node.name)} escape hatch omitted]`, ctx);
  }

  if (node.name === "math") {
    const body = node.body ?? renderDirectiveChildren(node, ctx, depth);
    return wrapDirective(node, `$$\n${body.trim()}\n$$`, ctx);
  }

  if (node.name === "pagebreak") {
    return wrapDirective(node, "<!-- pagebreak -->", ctx);
  }

  if (node.name === "table") {
    return wrapDirective(node, renderTableDirective(node, ctx), ctx);
  }

  if (node.name === "figure") {
    return wrapDirective(node, renderFigure(node, ctx, depth), ctx);
  }

  if (node.name === "agent_task" || node.name === "todo") {
    return wrapDirective(node, renderTask(node, ctx, depth), ctx);
  }

  if (isCallout(node)) {
    return wrapDirective(node, renderCallout(node, ctx, depth), ctx);
  }

  if (node.name === "card" || node.name === "tab" || node.name === "sidebar") {
    return wrapDirective(node, renderTitledContainer(node, ctx, depth), ctx);
  }

  if (LAYOUT_CONTAINERS.has(node.name)) {
    return wrapDirective(node, renderDirectiveChildren(node, ctx, depth), ctx);
  }

  if (CODE_DIRECTIVES.has(node.name) && hasCodeLikeBody(node)) {
    const language = attrText(node, "lang", "language", "runtime");
    return wrapDirective(node, renderLabeledCode(node, ctx, depth, language), ctx);
  }

  if (node.name === "button" || node.name === "export_button") {
    return wrapDirective(node, renderAction(node, ctx, depth), ctx);
  }

  if (VERBATIM_DIRECTIVES.has(node.name)) {
    return wrapDirective(node, renderVerbatimDirective(node), ctx);
  }

  return wrapDirective(node, renderGenericDirective(node, ctx, depth), ctx);
}

function renderCallout(node: DirectiveNode, ctx: RenderCtx, depth: number): string {
  const admonition = calloutKind(node);
  const title = attrText(node, "title", "label", "caption");
  const body = renderDirectiveContent(node, ctx, depth);
  const lines = [admonition ? `[!${admonition}]` : undefined, title ? `**${renderInline(title, ctx)}**` : undefined, body]
    .filter((line): line is string => Boolean(line && line.trim()));
  return lines.map((line) => quoteMarkdown(line)).join("\n");
}

function renderTitledContainer(node: DirectiveNode, ctx: RenderCtx, depth: number): string {
  const title = attrText(node, "title", "label", "caption", "name") ?? readableDirectiveName(node.name);
  const headingLevel = Math.min(6, depth + 1);
  return joinBlocks([
    `${"#".repeat(headingLevel)} ${renderInline(title, ctx)}`,
    renderMetadata(node),
    renderDirectiveContent(node, ctx, depth),
  ]);
}

function renderGenericDirective(node: DirectiveNode, ctx: RenderCtx, depth: number): string {
  const title = directiveTitle(node);
  const content = renderDirectiveContent(node, ctx, depth);
  return joinBlocks([`**${renderInline(title, ctx)}**`, renderMetadata(node), content]);
}

function renderLabeledCode(
  node: DirectiveNode,
  ctx: RenderCtx,
  depth: number,
  language: string | undefined,
): string {
  return joinBlocks([
    `**${renderInline(directiveTitle(node), ctx)}**`,
    renderMetadata(node),
    fenced(node.body ?? renderDirectiveChildren(node, ctx, depth), language),
  ]);
}

function renderVerbatimDirective(node: DirectiveNode): string {
  const language = node.name === "dataset" ? datasetLanguage(node) : node.name;
  return joinBlocks([
    `**${directiveTitle(node)}**`,
    renderMetadata(node),
    fenced(node.body ?? "", language),
  ]);
}

function renderAction(node: DirectiveNode, ctx: RenderCtx, depth: number): string {
  const label = attrText(node, "Label", "label", "title") ?? directiveBodyLabel(node) ?? readableDirectiveName(node.name);
  const href = attrText(node, "href", "url");
  const body = renderDirectiveContent(node, ctx, depth);
  const action = href ? `[${renderInline(label, ctx)}](${href})` : `**${renderInline(label, ctx)}**`;
  return joinBlocks([action, renderMetadata(node), body]);
}

function renderFigure(node: DirectiveNode, ctx: RenderCtx, depth: number): string {
  const src = attrText(node, "src", "href", "url");
  const alt = attrText(node, "alt") ?? attrText(node, "caption", "title") ?? node.id ?? "Figure";
  const caption = attrText(node, "caption", "title");
  const media = src ? `![${renderInline(alt, ctx)}](${src})` : `**${renderInline(directiveTitle(node), ctx)}**`;
  return joinBlocks([
    media,
    caption ? `_${renderInline(caption, ctx)}_` : "",
    renderMetadata(node),
    renderDirectiveContent(node, ctx, depth),
  ]);
}

function renderTask(node: DirectiveNode, ctx: RenderCtx, depth: number): string {
  const checked = node.attrs.done === true || attrText(node, "status") === "done";
  const body = renderDirectiveContent(node, ctx, depth).trim() || directiveTitle(node);
  const firstLine = body.split("\n")[0] ?? "";
  const rest = body.split("\n").slice(1).join("\n");
  const item = `- [${checked ? "x" : " "}] ${firstLine}`;
  return joinBlocks([item, rest, renderMetadata(node)]);
}

function renderTableDirective(node: DirectiveNode, ctx: RenderCtx): string {
  const rows = (node.body ?? "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.startsWith("|"))
    .map(splitPipeRow);
  if (rows.length === 0) return renderVerbatimDirective(node);
  const width = rows.reduce((max, row) => Math.max(max, row.length), 0);
  const header =
    node.attrs.header === true
      ? normalizeRow(rows[0] ?? [], width)
      : Array.from({ length: width }, (_value, index) => `Column ${index + 1}`);
  const bodyRows = node.attrs.header === true ? rows.slice(1) : rows;
  return joinBlocks([
    attrText(node, "title", "caption") ? `**${renderInline(directiveTitle(node), ctx)}**` : "",
    renderMetadata(node),
    renderPipeTable(header, bodyRows.map((row) => normalizeRow(row, width)), alignFromAttr(node.attrs.align, width), ctx),
  ]);
}

function renderPipeTable(
  header: string[],
  rows: string[][],
  align: TableAlign[],
  ctx: RenderCtx,
): string {
  const renderedHeader = header.map((cell) => tableCell(cell, ctx));
  const renderedRows = rows.map((row) => row.map((cell) => tableCell(cell, ctx)));
  const widths = renderedHeader.map((cell, index) =>
    Math.max(cell.length, ...renderedRows.map((row) => (row[index] ?? "").length), 3),
  );
  const row = (cells: string[]) =>
    "| " +
    cells.map((cell, index) => cell.padEnd(widths[index] ?? cell.length)).join(" | ") +
    " |";
  const separator =
    "| " +
    widths
      .map((width, index) => alignmentSeparator(width, align[index] ?? null))
      .join(" | ") +
    " |";
  return [row(renderedHeader), separator, ...renderedRows.map(row)].join("\n");
}

function renderDirectiveContent(node: DirectiveNode, ctx: RenderCtx, depth: number): string {
  if (node.children.length > 0) return renderDirectiveChildren(node, ctx, depth);
  if (node.body === undefined) return "";
  return renderInline(node.body, ctx);
}

function renderDirectiveChildren(node: DirectiveNode, ctx: RenderCtx, depth: number): string {
  return joinBlocks(node.children.map((child) => renderNode(child, ctx, depth + 1)));
}

function wrapDirective(node: DirectiveNode, body: string, ctx: RenderCtx): string {
  const anchors = renderAnchors([node.id, ...(node.aliases ?? [])], ctx);
  if (!ctx.semanticComments) return joinBlocks([anchors, body]);
  const open = directiveComment(node);
  const close = `<!-- /noma:block ${safeCommentToken(node.id ?? node.name)} -->`;
  return joinBlocks([anchors, open, body, close]);
}

function renderInline(src: string, ctx: RenderCtx): string {
  const text = unescapeMarkdownTextEscapes(src);
  if (!ctx.anchorWikilinks) return text;
  return text.replace(/\[\[([^\]\n]+?)\]\]/g, (match) => {
    const link = extractWikilinks(match)[0];
    if (!link) return match;
    return `[${link.label}](#${encodeURIComponent(link.target)})`;
  });
}

function renderAnchors(values: Array<string | undefined>, ctx: RenderCtx): string {
  if (!ctx.includeAnchors) return "";
  const unique = [...new Set(values.filter((value): value is string => Boolean(value)))];
  return unique.map((value) => `<a id="${escapeHtmlAttr(value)}"></a>`).join("\n");
}

function renderMetadata(node: DirectiveNode): string {
  const parts = metadataParts(node);
  return parts.length > 0 ? `_${parts.join(", ")}_` : "";
}

function metadataParts(node: DirectiveNode): string[] {
  const skip = new Set(["id", "title", "caption", "label", "Label", "name", "src", "alt"]);
  const parts: string[] = [];
  if (node.id) parts.push(`id=${node.id}`);
  for (const [key, value] of Object.entries(node.attrs)) {
    if (skip.has(key)) continue;
    parts.push(formatAttr(key, value));
  }
  return parts;
}

function directiveComment(node: DirectiveNode): string {
  const attrs = Object.fromEntries(Object.entries(node.attrs).filter(([key]) => key !== "id"));
  const payload: Record<string, unknown> = { name: node.name };
  if (node.id) payload.id = node.id;
  if (Object.keys(attrs).length > 0) payload.attrs = attrs;
  return `<!-- noma:block ${safeCommentToken(JSON.stringify(payload))} -->`;
}

function directiveTitle(node: DirectiveNode): string {
  const title = attrText(node, "title", "caption", "label", "Label", "name");
  const label = readableDirectiveName(node.name);
  if (title) return label === title ? title : `${label}: ${title}`;
  return node.id ? `${label}: ${node.id}` : label;
}

function directiveBodyLabel(node: DirectiveNode): string | undefined {
  if (!node.body) return undefined;
  const match = /^(?:Label|label|title):\s*(.+)$/m.exec(node.body);
  return match?.[1]?.trim();
}

function isCallout(node: DirectiveNode): boolean {
  return node.name === "summary" ||
    node.name === "abstract" ||
    node.name === "callout" ||
    node.name === "note" ||
    node.name === "warning" ||
    node.name === "tip";
}

function calloutKind(node: DirectiveNode): string | undefined {
  if (node.name === "warning") return "WARNING";
  if (node.name === "tip") return "TIP";
  if (node.name === "note") return "NOTE";
  const tone = attrText(node, "tone")?.toLowerCase();
  if (tone === "warning" || tone === "danger" || tone === "error") return "WARNING";
  if (tone === "tip" || tone === "success") return "TIP";
  if (tone === "info" || tone === "note") return "NOTE";
  return "NOTE";
}

function hasCodeLikeBody(node: DirectiveNode): boolean {
  return node.body !== undefined && (node.children.length === 0 || attrText(node, "lang", "language", "runtime") !== undefined);
}

function datasetLanguage(node: DirectiveNode): string {
  const format = attrText(node, "format")?.toLowerCase();
  if (format === "csv" || format === "tsv" || format === "json" || format === "yaml") return format;
  if ((node.body ?? "").trimStart().startsWith("{") || (node.body ?? "").trimStart().startsWith("[")) return "json";
  return "yaml";
}

function attrText(node: DirectiveNode, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = node.attrs[key];
    if (typeof value === "string" && value.trim()) return value;
    if (typeof value === "number" || typeof value === "boolean") return String(value);
  }
  return undefined;
}

function formatAttr(key: string, value: AttrValue): string {
  if (value === true) return key;
  return `${key}=${String(value)}`;
}

function readableDirectiveName(name: string): string {
  const words = name.replace(/::/g, "_").split(/[_-]+/).filter(Boolean);
  if (words.length === 0) return "Block";
  return words.map((word, index) => {
    const lower = word.toLowerCase();
    return index === 0 ? lower.charAt(0).toUpperCase() + lower.slice(1) : lower;
  }).join(" ");
}

function tableCell(cell: string, ctx: RenderCtx): string {
  return escapePipeTableCell(renderInline(cell, ctx));
}

function alignmentSeparator(width: number, align: TableAlign): string {
  if (align === "center") return ":" + "-".repeat(Math.max(3, width - 2)) + ":";
  if (align === "right") return "-".repeat(Math.max(3, width - 1)) + ":";
  if (align === "left") return ":" + "-".repeat(Math.max(3, width - 1));
  return "-".repeat(Math.max(3, width));
}

function alignFromAttr(value: AttrValue | undefined, width: number): TableAlign[] {
  const parts = typeof value === "string" ? value.split(/[,\s]+/).filter(Boolean) : [];
  return Array.from({ length: width }, (_item, index): TableAlign => {
    const code = parts[index]?.toLowerCase();
    if (code === "l" || code === "left") return "left";
    if (code === "c" || code === "center") return "center";
    if (code === "r" || code === "right") return "right";
    return null;
  });
}

function normalizeRow(row: string[], width: number): string[] {
  return Array.from({ length: width }, (_value, index) => row[index] ?? "");
}

function quoteMarkdown(text: string): string {
  return text.split("\n").map((line) => `> ${line}`).join("\n");
}

function fenced(content: string, language: string | undefined): string {
  const fence = content.includes("```") ? "~~~~" : "```";
  return `${fence}${language ?? ""}\n${content.replace(/\n+$/, "")}\n${fence}`;
}

function joinBlocks(chunks: string[]): string {
  return chunks.filter((chunk) => chunk.trim().length > 0).join("\n\n");
}

function safeCommentToken(value: string): string {
  return value.replace(/--/g, "- -");
}

function escapeHtmlAttr(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/"/g, "&quot;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}
