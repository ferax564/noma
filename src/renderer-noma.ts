import yaml from "js-yaml";
import { slugify } from "./parser.js";
import type {
  Attrs,
  AttrValue,
  CodeNode,
  DirectiveNode,
  DocumentNode,
  ListNode,
  Node,
  ParagraphNode,
  QuoteNode,
  SectionNode,
  TableNode,
  ThematicBreakNode,
} from "./ast.js";

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

  const metaEntries = Object.entries(doc.meta).filter(
    ([k]) => !stripInternal || !INTERNAL_META_KEYS.has(k),
  );
  if (metaEntries.length > 0) {
    out.push("---");
    out.push(yaml.dump(Object.fromEntries(metaEntries)).trimEnd());
    out.push("---");
    out.push("");
  }

  for (const child of doc.children) {
    out.push(renderNode(child, 2));
    out.push("");
  }

  return out.join("\n").replace(/\n{3,}/g, "\n\n").replace(/\n+$/, "\n");
}

function renderNode(node: Node, colons: number): string {
  switch (node.type) {
    case "document":
      return node.children.map((c) => renderNode(c, colons)).join("\n\n");
    case "section":
      return renderSection(node, colons);
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
      return renderDirective(node, colons);
    default: {
      const _exhaustive: never = node;
      void _exhaustive;
      return "";
    }
  }
}

function renderSection(node: SectionNode, colons: number): string {
  const hashes = "#".repeat(Math.max(1, Math.min(6, node.level)));
  const attrs = headingAttrs(node);
  const head = attrs ? `${hashes} ${node.title} ${attrs}` : `${hashes} ${node.title}`;
  if (node.children.length === 0) return head;
  const inner = node.children.map((c) => renderNode(c, colons)).join("\n\n");
  return `${head}\n\n${inner}`;
}

function headingAttrs(node: SectionNode): string {
  // Drop the auto-attached chapter-filename / book-scope aliases — those are
  // re-derived on parse, not source-of-truth. Keep only aliases that wouldn't
  // be regenerated, plus a non-slug explicit id.
  const explicitId =
    node.id && node.id !== slugify(node.title) ? node.id : undefined;
  const aliases = node.aliases ?? [];
  const parts: string[] = [];
  if (explicitId) parts.push(`id="${explicitId}"`);
  if (aliases.length > 0) {
    parts.push(`aliases="${aliases.join(",")}"`);
  }
  return parts.length > 0 ? `{${parts.join(" ")}}` : "";
}

function renderParagraph(node: ParagraphNode): string {
  return node.content;
}

function renderCode(node: CodeNode): string {
  return "```" + (node.lang ?? "") + "\n" + node.content + "\n```";
}

function renderList(node: ListNode): string {
  if (node.ordered) {
    return node.items.map((it, i) => `${i + 1}. ${it.content}`).join("\n");
  }
  return node.items.map((it) => `- ${it.content}`).join("\n");
}

function renderQuote(node: QuoteNode): string {
  return node.content
    .split("\n")
    .map((l) => (l ? `> ${l}` : ">"))
    .join("\n");
}

function renderThematicBreak(_node: ThematicBreakNode): string {
  return "---";
}

function renderTable(node: TableNode): string {
  const widths = node.header.map((h, i) =>
    Math.max(h.length, ...node.rows.map((r) => (r[i] ?? "").length), 3),
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
  return [fmtRow(node.header), sep, ...node.rows.map(fmtRow)].join("\n");
}

function renderDirective(node: DirectiveNode, colons: number): string {
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
  const inner = node.children.map((c) => renderNode(c, childColons)).join("\n\n");
  return `${open}\n${inner}\n${close}`;
}

function serializeAttrs(attrs: Attrs): string {
  const entries = Object.entries(attrs);
  if (entries.length === 0) return "";
  const parts = entries.map(([k, v]) => serializeAttr(k, v));
  return `{${parts.join(" ")}}`;
}

function serializeAttr(key: string, value: AttrValue): string {
  if (value === true) return key;
  if (value === false) return `${key}=false`;
  if (typeof value === "number") return `${key}=${value}`;
  const s = String(value);
  if (s.includes('"')) {
    if (s.includes("'")) {
      return `${key}="${s.replace(/"/g, '\\"')}"`;
    }
    return `${key}='${s}'`;
  }
  return `${key}="${s}"`;
}
