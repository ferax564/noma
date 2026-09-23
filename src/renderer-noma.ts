import yaml from "js-yaml";
import { headingSlug, serializeAttr, slugify, splitHeadingAttrs } from "./parser.js";
import type {
  Attrs,
  CodeNode,
  DirectiveNode,
  DocumentNode,
  FrontmatterNode,
  ListNode,
  Node,
  ParagraphNode,
  QuoteNode,
  SectionNode,
  TableNode,
  ThematicBreakNode,
} from "./ast.js";
import { formatInlineStableId } from "./stable-identity.js";

export interface NomaRenderOptions {
  /** Drop internal meta keys (filename, pos) from frontmatter. Default: true. */
  stripInternal?: boolean;
}

const INTERNAL_META_KEYS = new Set(["filename"]);

/**
 * AST → .noma source. Designed for roundtrip: `parse(renderNoma(doc))` should
 * yield a structurally equal AST (modulo positions). Foundation for `noma patch`.
 */
export function renderNoma(doc: DocumentNode, options: NomaRenderOptions = {}): string {
  const stripInternal = options.stripInternal !== false;
  const out: string[] = [];
  const ctx = buildContext(doc);

  const hasFrontmatterNode = doc.children[0]?.type === "frontmatter";
  if (!hasFrontmatterNode) {
    const metaEntries = Object.entries(doc.meta).filter(
      ([k]) => !stripInternal || !INTERNAL_META_KEYS.has(k),
    );
    if (metaEntries.length > 0) {
      out.push(`---\n${yaml.dump(Object.fromEntries(metaEntries)).trimEnd()}\n---`);
    }
  }

  for (const child of doc.children) {
    // A leading `---` rule would be re-read as a frontmatter fence.
    const leadingRule = out.length === 0 && child.type === "thematic_break";
    const rendered = leadingRule ? "***" : renderNode(child, 2, ctx);
    if (rendered.trim() !== "") out.push(rendered);
  }

  // Blocks are separated by exactly one blank line. Blank lines *inside* a
  // block (code content, quotes) are content and must not be collapsed.
  return out.length === 0 ? "" : `${out.join("\n\n").replace(/\n+$/, "")}\n`;
}

interface RenderCtx {
  /** Aliases that the parser/loader will re-derive on parse and so don't
   *  need to be emitted on the heading. Filename slug + frontmatter list. */
  regenAliases: Set<string>;
}

function buildContext(doc: DocumentNode): RenderCtx {
  const regenAliases = new Set<string>();
  if (Array.isArray(doc.meta.aliases)) {
    for (const a of doc.meta.aliases) {
      if (typeof a === "string" && a.trim()) regenAliases.add(a.trim());
    }
  }
  if (typeof doc.meta.filename === "string") {
    const base = doc.meta.filename.replace(/\\/g, "/").split("/").pop() ?? "";
    const stem = base.replace(/\.noma$/i, "").replace(/^\d+[-_]/, "");
    const slug = slugify(stem);
    if (slug) regenAliases.add(slug);
  }
  return { regenAliases };
}

function renderNode(node: Node, colons: number, ctx: RenderCtx): string {
  switch (node.type) {
    case "document":
      return node.children.map((c) => renderNode(c, colons, ctx)).join("\n\n");
    case "section":
      return renderSection(node, colons, ctx);
    case "paragraph":
      return renderParagraph(node);
    case "code":
      return renderCode(node);
    case "list":
      return renderList(node);
    case "list_item":
      return `- ${node.content}`;
    case "quote":
      return renderQuote(node);
    case "thematic_break":
      return renderThematicBreak(node);
    case "table":
      return renderTable(node);
    case "directive":
      return renderDirective(node, colons, ctx);
    case "frontmatter":
      return `---\n${node.raw}\n---`;
    default: {
      const _exhaustive: never = node;
      void _exhaustive;
      return "";
    }
  }
}

function renderSection(node: SectionNode, colons: number, ctx: RenderCtx): string {
  const hashes = "#".repeat(Math.max(1, Math.min(6, node.level)));
  const attrs = headingAttrs(node, ctx);
  const head = attrs ? `${hashes} ${node.title} ${attrs}` : `${hashes} ${node.title}`;
  if (node.children.length === 0) return head;
  const inner = node.children.map((c) => renderNode(c, colons, ctx)).join("\n\n");
  return `${head}\n\n${inner}`;
}

function headingAttrs(node: SectionNode, ctx: RenderCtx): string {
  // A title that itself ends in `{key=value}` would be re-read as attributes,
  // so pin its id explicitly to keep the braces in the title.
  const titleLooksLikeAttrs = splitHeadingAttrs(node.title).attrs !== undefined;
  const explicitId =
    node.id && (node.id !== headingSlug(node.title) || titleLooksLikeAttrs) ? node.id : undefined;
  // Drop aliases the parser/loader will re-derive (frontmatter list, filename
  // slug). Anything else came from explicit `{aliases="..."}` in source and
  // must be kept to round-trip.
  const aliases = (node.aliases ?? []).filter((a) => !ctx.regenAliases.has(a));
  const parts: string[] = [];
  if (explicitId) parts.push(serializeAttr("id", explicitId));
  if (aliases.length > 0) {
    parts.push(serializeAttr("aliases", aliases.join(",")));
  }
  return parts.length > 0 ? `{${parts.join(" ")}}` : "";
}

function renderParagraph(node: ParagraphNode): string {
  return withBlockId(node.id, node.content);
}

function renderCode(node: CodeNode): string {
  const longestRun = Math.max(0, ...node.content.split("\n").map((l) => /^`*/.exec(l)?.[0].length ?? 0));
  const fence = "`".repeat(Math.max(3, longestRun + 1));
  return withBlockId(node.id, fence + (node.lang ?? "") + "\n" + node.content + "\n" + fence);
}

function renderList(node: ListNode): string {
  const body = node.ordered
    ? node.items.map((it, i) => `${i + 1}. ${formatInlineStableId(it.id, it.content)}`).join("\n")
    : node.items.map((it) => `- ${formatInlineStableId(it.id, it.content)}`).join("\n");
  return withBlockId(node.id, body);
}

function renderQuote(node: QuoteNode): string {
  const body = node.content
    .split("\n")
    .map((l) => (l ? `> ${l}` : ">"))
    .join("\n");
  return withBlockId(node.id, body);
}

function renderThematicBreak(_node: ThematicBreakNode): string {
  return "---";
}

function withBlockId(id: string | undefined, body: string): string {
  return id ? `{#${id}}\n${body}` : body;
}

function tableIdentityLine(node: TableNode): string | undefined {
  if (!node.id && !node.columnIds?.some(Boolean) && !node.rowIds?.some(Boolean)) return undefined;
  const parts: string[] = [];
  if (node.columnIds?.some(Boolean)) parts.push(`cols="${(node.columnIds ?? []).join(",")}"`);
  if (node.rowIds?.some(Boolean)) parts.push(`rows="${(node.rowIds ?? []).join(",")}"`);
  const id = node.id ?? "table";
  return parts.length > 0 ? `{#${id} ${parts.join(" ")}}` : `{#${id}}`;
}

function renderTable(node: TableNode): string {
  const headerCells = node.header.map((h, i) => formatInlineStableId(node.headerIds?.[i], h));
  const bodyRows = node.rows.map((row, r) =>
    row.map((cell, c) => formatInlineStableId(node.cellIds?.[r]?.[c], cell)),
  );
  const widths = headerCells.map((h, i) =>
    Math.max(h.length, ...bodyRows.map((row) => (row[i] ?? "").length), 3),
  );
  const fmtRow = (cells: string[]) =>
    "| " +
    cells.map((c, i) => c.padEnd(widths[i] ?? c.length)).join(" | ") +
    " |";
  const sep =
    "| " +
    widths
      .map((w, i) => {
        const a = node.align[i];
        if (a === "center") return ":" + "-".repeat(Math.max(3, w - 2)) + ":";
        if (a === "right") return "-".repeat(Math.max(3, w - 1)) + ":";
        if (a === "left") return ":" + "-".repeat(Math.max(3, w - 1));
        return "-".repeat(Math.max(3, w));
      })
      .join(" | ") +
    " |";
  const table = [fmtRow(headerCells), sep, ...bodyRows.map(fmtRow)].join("\n");
  const marker = tableIdentityLine(node);
  return marker ? `${marker}\n${table}` : table;
}

function renderDirective(node: DirectiveNode, colons: number, ctx: RenderCtx): string {
  const fence = ":".repeat(colons);
  const attrs = serializeAttrs(node.attrs);
  const open = `${fence}${node.name}${attrs ? attrs : ""}`;
  const close = fence;

  if (node.children.length === 0) {
    if (node.body !== undefined && node.body !== "") {
      return `${open}\n${node.body}\n${close}`;
    }
    return `${open}\n${close}`;
  }

  const childColons = colons + 1;
  const inner = node.children.map((c) => renderNode(c, childColons, ctx)).join("\n\n");
  return `${open}\n${inner}\n${close}`;
}

function serializeAttrs(attrs: Attrs): string {
  const entries = Object.entries(attrs);
  if (entries.length === 0) return "";
  const parts = entries.map(([k, v]) => serializeAttr(k, v));
  return `{${parts.join(" ")}}`;
}
