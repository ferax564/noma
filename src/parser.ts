import yaml from "js-yaml";
import { splitPipeRow } from "./inline.js";
import type {
  Attrs,
  AttrValue,
  CodeNode,
  DirectiveNode,
  DocumentNode,
  ListItemNode,
  ListNode,
  Node,
  ParagraphNode,
  QuoteNode,
  SectionNode,
  TableAlign,
  TableNode,
  ThematicBreakNode,
} from "./ast.js";

export interface ParseOptions {
  /** Optional source filename, kept on the document meta for diagnostics. */
  filename?: string;
}

const FRONTMATTER_RE = /^---\s*$/;
const HEADING_RE = /^(#{1,6})\s+(.+?)\s*$/;
const FENCE_RE = /^```(\w*)\s*$/;
const DIRECTIVE_OPEN_RE = /^(:{2,})\s*([a-zA-Z_][\w-]*)\s*(\{.*\})?\s*$/;
const DIRECTIVE_CLOSE_RE = /^(:{2,})\s*$/;
const LIST_RE = /^([-*])\s+(.+)$/;
const ORDERED_LIST_RE = /^(\d+)\.\s+(.+)$/;
const QUOTE_RE = /^>\s?(.*)$/;
const THEMATIC_BREAK_RE = /^(?:-{3,}|\*{3,}|_{3,})\s*$/;
const TABLE_ROW_RE = /^\s*\|.*\|\s*$/;
const TABLE_SEPARATOR_RE = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/;

const matchOnce = (re: RegExp, s: string): RegExpMatchArray | null => s.match(re);

export function parse(source: string, options: ParseOptions = {}): DocumentNode {
  const normalized = source.replace(/\r\n?/g, "\n");
  const lines = normalized.split("\n");

  const { meta, startLine } = extractFrontmatter(lines);
  const flatChildren = parseBlocks(lines, startLine, lines.length, 0);
  const children = foldSections(flatChildren);

  return {
    type: "document",
    meta: { ...(options.filename ? { filename: options.filename } : {}), ...meta },
    children,
  };
}

function extractFrontmatter(lines: string[]): {
  meta: Record<string, unknown>;
  startLine: number;
} {
  if (lines.length === 0 || !FRONTMATTER_RE.test(lines[0] ?? "")) {
    return { meta: {}, startLine: 0 };
  }
  for (let i = 1; i < lines.length; i++) {
    if (FRONTMATTER_RE.test(lines[i] ?? "")) {
      const yamlText = lines.slice(1, i).join("\n");
      const parsed = yaml.load(yamlText);
      const meta =
        parsed && typeof parsed === "object" && !Array.isArray(parsed)
          ? (parsed as Record<string, unknown>)
          : {};
      return { meta, startLine: i + 1 };
    }
  }
  return { meta: {}, startLine: 0 };
}

function parseBlocks(
  lines: string[],
  from: number,
  to: number,
  parentColons: number,
): Node[] {
  const out: Node[] = [];
  let i = from;

  while (i < to) {
    const line = lines[i] ?? "";

    if (line.trim() === "") {
      i++;
      continue;
    }

    const directiveOpen = matchOnce(DIRECTIVE_OPEN_RE, line);
    if (directiveOpen) {
      const colons = directiveOpen[1]!.length;
      if (colons > parentColons || parentColons === 0) {
        const result = parseDirective(lines, i, to, colons);
        out.push(result.node);
        i = result.next;
        continue;
      }
      // Same-or-lower colon count inside a parent: treat as paragraph text
      // rather than spinning forever. Validator will flag the structural issue.
      out.push(paragraph(line, i));
      i++;
      continue;
    }

    if (matchOnce(DIRECTIVE_CLOSE_RE, line)) {
      out.push(paragraph(line, i));
      i++;
      continue;
    }

    const heading = matchOnce(HEADING_RE, line);
    if (heading) {
      const level = heading[1]!.length;
      const title = heading[2]!.trim();
      out.push({
        type: "section",
        id: slugify(title),
        level,
        title,
        children: [],
        pos: { line: i + 1, column: 1 },
      } satisfies SectionNode);
      i++;
      continue;
    }

    const fence = matchOnce(FENCE_RE, line);
    if (fence) {
      const lang = fence[1] || undefined;
      const start = i + 1;
      let end = start;
      while (end < to && !FENCE_RE.test(lines[end] ?? "")) end++;
      const content = lines.slice(start, end).join("\n");
      out.push({
        type: "code",
        lang,
        content,
        pos: { line: i + 1, column: 1 },
      } satisfies CodeNode);
      i = end < to ? end + 1 : end;
      continue;
    }

    if (
      TABLE_ROW_RE.test(line) &&
      i + 1 < to &&
      TABLE_SEPARATOR_RE.test(lines[i + 1] ?? "")
    ) {
      const result = parseTable(lines, i, to);
      if (result) {
        out.push(result.node);
        i = result.next;
        continue;
      }
    }

    if (THEMATIC_BREAK_RE.test(line)) {
      out.push({
        type: "thematic_break",
        pos: { line: i + 1, column: 1 },
      } satisfies ThematicBreakNode);
      i++;
      continue;
    }

    if (QUOTE_RE.test(line)) {
      const buf: string[] = [];
      const startLine = i;
      while (i < to) {
        const m = matchOnce(QUOTE_RE, lines[i] ?? "");
        if (!m) break;
        buf.push(m[1] ?? "");
        i++;
      }
      out.push({
        type: "quote",
        content: buf.join("\n"),
        pos: { line: startLine + 1, column: 1 },
      } satisfies QuoteNode);
      continue;
    }

    if (LIST_RE.test(line) || ORDERED_LIST_RE.test(line)) {
      const ordered = ORDERED_LIST_RE.test(line);
      const items: ListItemNode[] = [];
      const re = ordered ? ORDERED_LIST_RE : LIST_RE;
      const startLine = i;
      while (i < to) {
        const m = matchOnce(re, lines[i] ?? "");
        if (!m) break;
        items.push({
          type: "list_item",
          content: m[2] ?? "",
          pos: { line: i + 1, column: 1 },
        });
        i++;
      }
      out.push({
        type: "list",
        ordered,
        items,
        pos: { line: startLine + 1, column: 1 },
      } satisfies ListNode);
      continue;
    }

    const buf: string[] = [];
    const startLine = i;
    while (i < to) {
      const cur = lines[i] ?? "";
      const next = lines[i + 1] ?? "";
      if (
        cur.trim() === "" ||
        HEADING_RE.test(cur) ||
        FENCE_RE.test(cur) ||
        DIRECTIVE_OPEN_RE.test(cur) ||
        DIRECTIVE_CLOSE_RE.test(cur) ||
        THEMATIC_BREAK_RE.test(cur) ||
        QUOTE_RE.test(cur) ||
        LIST_RE.test(cur) ||
        ORDERED_LIST_RE.test(cur) ||
        (TABLE_ROW_RE.test(cur) && TABLE_SEPARATOR_RE.test(next))
      ) {
        break;
      }
      buf.push(cur);
      i++;
    }
    if (buf.length > 0) out.push(paragraph(buf.join("\n"), startLine));
  }

  return out;
}

function parseDirective(
  lines: string[],
  i: number,
  to: number,
  colons: number,
): { node: DirectiveNode; next: number } {
  const opener = matchOnce(DIRECTIVE_OPEN_RE, lines[i] ?? "")!;
  const name = opener[2]!;
  const attrs = parseAttrs(opener[3] ?? "");

  let close = -1;
  for (let j = i + 1; j < to; j++) {
    const m = matchOnce(DIRECTIVE_CLOSE_RE, lines[j] ?? "");
    if (m && m[1]!.length === colons) {
      close = j;
      break;
    }
  }

  const innerEnd = close === -1 ? to : close;
  const children = parseBlocks(lines, i + 1, innerEnd, colons);
  const node: DirectiveNode = {
    type: "directive",
    name,
    attrs,
    children,
    pos: { line: i + 1, column: 1 },
  };

  if (typeof attrs.id === "string") node.id = attrs.id;

  if (children.length === 1 && children[0]!.type === "paragraph") {
    node.body = (children[0] as ParagraphNode).content;
  }

  return { node, next: close === -1 ? to : close + 1 };
}

const splitRow = splitPipeRow;

function parseTable(
  lines: string[],
  i: number,
  to: number,
): { node: TableNode; next: number } | null {
  const headerLine = lines[i] ?? "";
  const sepLine = lines[i + 1] ?? "";
  const header = splitRow(headerLine);
  const sepCells = splitRow(sepLine);
  if (sepCells.length !== header.length) return null;

  const align: TableAlign[] = sepCells.map((c) => {
    const left = c.startsWith(":");
    const right = c.endsWith(":");
    if (left && right) return "center";
    if (right) return "right";
    if (left) return "left";
    return null;
  });

  const rows: string[][] = [];
  let j = i + 2;
  while (j < to && TABLE_ROW_RE.test(lines[j] ?? "")) {
    const cells = splitRow(lines[j] ?? "");
    while (cells.length < header.length) cells.push("");
    if (cells.length > header.length) cells.length = header.length;
    rows.push(cells);
    j++;
  }

  return {
    node: {
      type: "table",
      header,
      align,
      rows,
      pos: { line: i + 1, column: 1 },
    },
    next: j,
  };
}

function parseAttrs(raw: string): Attrs {
  const attrs: Attrs = {};
  if (!raw) return attrs;
  const inner = raw.replace(/^\{/, "").replace(/\}$/, "").trim();
  if (!inner) return attrs;

  const re = /([a-zA-Z_][\w-]*)(?:=("([^"]*)"|'([^']*)'|([^\s]+)))?/g;
  for (const m of inner.matchAll(re)) {
    const key = m[1]!;
    if (m[2] === undefined) {
      attrs[key] = true;
      continue;
    }
    const quoted = m[3] ?? m[4];
    const bare = m[5];
    const value = quoted !== undefined ? quoted : (bare ?? "");
    attrs[key] = coerce(value);
  }
  return attrs;
}

function coerce(v: string): AttrValue {
  if (v === "true") return true;
  if (v === "false") return false;
  if (/^-?\d+$/.test(v)) return Number(v);
  if (/^-?\d+\.\d+$/.test(v)) return Number(v);
  return v;
}

function paragraph(content: string, line: number): ParagraphNode {
  return {
    type: "paragraph",
    content: content.replace(/\n+$/, ""),
    pos: { line: line + 1, column: 1 },
  };
}

function foldSections(nodes: Node[]): Node[] {
  const root: Node[] = [];
  const stack: SectionNode[] = [];

  const push = (node: Node) => {
    const parent = stack[stack.length - 1];
    if (parent) parent.children.push(node);
    else root.push(node);
  };

  for (const node of nodes) {
    if (node.type === "section") {
      while (stack.length > 0 && stack[stack.length - 1]!.level >= node.level) {
        stack.pop();
      }
      push(node);
      stack.push(node);
      continue;
    }
    push(node);
  }
  return root;
}

export function slugify(input: string): string {
  return input
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}
