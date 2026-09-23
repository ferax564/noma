/**
 * Visual-editor document model: a ProseMirror-compatible JSON schema that maps
 * 1:1 onto Noma blocks, plus lossless conversion in both directions.
 *
 * `nomaToEditorDoc(source)` projects `.noma` source into editor JSON.
 * `editorDocToNoma(doc, originalSource)` writes it back: blocks whose editor
 * JSON is unchanged are copied from `originalSource` byte-for-byte, and only
 * added or edited blocks are re-serialized. `.noma` stays the source of truth;
 * the editor JSON is a projection that never needs to be stored on its own.
 *
 * Pure and DOM-free so the browser editor, the Cloud collaboration relay and
 * the tests share one implementation.
 */
import type { Node as NomaNode, SectionNode } from "./ast.js";
import { escapePipeTableCell, splitPipeRow } from "./inline.js";
import { ATTR_NAME_RE, headingSlug, isCodeFenceClose, matchCodeFenceOpen, parse, parseAttrs, serializeAttr, slugify, splitHeadingAttrs } from "./parser.js";
import { STABLE_ID_LINE_RE } from "./stable-identity.js";

export type EditorAttrValue = string | number | boolean | null;
export type EditorAttrs = Record<string, EditorAttrValue>;

export interface EditorMark {
  type: string;
  attrs?: EditorAttrs;
}

export interface EditorNode {
  type: string;
  attrs?: EditorAttrs;
  content?: EditorNode[];
  text?: string;
  marks?: EditorMark[];
}

export interface EditorDoc extends EditorNode {
  type: "doc";
  content: EditorNode[];
}

export interface EditorNodeSpec {
  attrs: EditorAttrs;
  content?: string;
  group?: string;
  inline?: boolean;
  atom?: boolean;
  code?: boolean;
  marks?: string;
  defining?: boolean;
  isolating?: boolean;
  tableRole?: "table" | "row" | "cell" | "header_cell";
}

export interface EditorMarkSpec {
  attrs: EditorAttrs;
  excludes?: string;
  inclusive?: boolean;
}

/**
 * Node specs shared by the browser schema and the server-side Yjs codec. Order
 * matters: the first `block` node is ProseMirror's default block type.
 */
export const EDITOR_NODE_SPECS: Record<string, EditorNodeSpec> = {
  doc: { attrs: {}, content: "frontmatter? block+" },
  paragraph: { attrs: { marker: null }, content: "inline*", group: "block" },
  frontmatter: { attrs: { src: "" }, atom: true },
  heading: { attrs: { level: 1, id: null, attrs: null, marker: null }, content: "inline*", group: "block", defining: true },
  blockquote: { attrs: { marker: null }, content: "inline*", group: "block", defining: true },
  bullet_list: { attrs: { marker: null, bullet: "-" }, content: "list_item+", group: "block" },
  ordered_list: { attrs: { marker: null }, content: "list_item+", group: "block" },
  list_item: { attrs: { id: null, checked: null, num: null }, content: "inline*", defining: true },
  code_block: { attrs: { lang: "", fence: "```", marker: null }, content: "text*", group: "block", code: true, marks: "", defining: true },
  horizontal_rule: { attrs: { raw: "---", marker: null }, group: "block", atom: true },
  table: { attrs: { align: "", marker: null }, content: "table_row+", group: "block", isolating: true, tableRole: "table" },
  table_row: { attrs: {}, content: "(table_header | table_cell)+", tableRole: "row" },
  table_header: { attrs: { id: null, colspan: 1, rowspan: 1, colwidth: null }, content: "inline*", isolating: true, tableRole: "header_cell" },
  table_cell: { attrs: { id: null, colspan: 1, rowspan: 1, colwidth: null }, content: "inline*", isolating: true, tableRole: "cell" },
  directive: { attrs: { name: "callout", attrs: "", colons: 2, marker: null }, content: "block*", group: "block", defining: true, isolating: true },
  text_directive: { attrs: { name: "math", attrs: "", colons: 2, marker: null }, content: "text*", group: "block", code: true, marks: "", defining: true },
  raw: { attrs: { src: "", label: "" }, group: "block", atom: true },
  text: { attrs: {}, group: "inline", inline: true },
  hard_break: { attrs: {}, group: "inline", inline: true, atom: true },
  wikilink: { attrs: { raw: "" }, group: "inline", inline: true, atom: true },
  mention: { attrs: { userId: "" }, group: "inline", inline: true, atom: true },
  math_inline: { attrs: { tex: "", delim: "$" }, group: "inline", inline: true, atom: true },
};

/** Mark specs in rank order (outermost first when serialized). */
export const EDITOR_MARK_SPECS: Record<string, EditorMarkSpec> = {
  link: { attrs: { href: "" }, inclusive: false },
  strong: { attrs: { delim: "**" } },
  em: { attrs: { delim: "*" } },
  code: { attrs: {} },
};

const MARK_ORDER = Object.keys(EDITOR_MARK_SPECS);

/** Directives whose body is data or markup rather than prose: kept as raw source. */
export const RAW_DIRECTIVES = new Set([
  "dataset", "plot", "computed_metric", "computed_table", "computed_plot", "table", "svg", "html", "control",
  "export_button", "button", "state_change", "page_setup", "memory_index", "doc_protection", "bibliography",
  "artifact", "formula", "chart", "code", "style", "script", "embed", "csv",
]);

/** Directives whose body is raw text edited as code (with a preview in the UI). */
export const TEXT_DIRECTIVES = new Set(["math", "diagram", "mermaid"]);

/** Directives shown as read-only chips; they only make sense without a body. */
export const CHIP_DIRECTIVES = new Set(["toc", "children", "include", "transclude", "pagebreak"]);

/** New blocks of these kinds get a deterministic `id` because other blocks reference them. */
export const ID_REQUIRED_DIRECTIVES = new Set([
  "claim", "decision", "risk", "requirement", "open_question", "figure",
  "agent_task", "change_request", "memory", "assumption",
]);

const DIRECTIVE_OPEN_RE = /^(:{2,})\s*([a-zA-Z_][\w-]*(?:::[a-zA-Z_][\w-]*)*)\s*(\{.*\})?\s*$/;
const DIRECTIVE_CLOSE_RE = /^(:{2,})\s*$/;
const LIST_RE = /^([-*])\s+(.+)$/;
const ORDERED_LIST_RE = /^(\d+)\.\s+(.+)$/;
const QUOTE_RE = /^>\s?(.*)$/;
const TASK_RE = /^\[( |x|X)\]\s+/;
const INLINE_ID_RE = /^\{#([A-Za-z][\w:./-]*)\}\s*/;
const MAX_DIRECTIVE_DEPTH = 32;

// ---------------------------------------------------------------------------
// Canonical form

/** Fill default attrs, merge adjacent text, and sort marks so equal content compares equal. */
export function canonicalEditorNode(node: EditorNode): EditorNode {
  const spec = EDITOR_NODE_SPECS[node.type];
  if (node.type === "text") {
    const out: EditorNode = { type: "text", text: node.text ?? "" };
    const marks = canonicalMarks(node.marks);
    if (marks.length > 0) out.marks = marks;
    return out;
  }
  const out: EditorNode = { type: node.type };
  const attrs = canonicalAttrs(spec?.attrs ?? {}, node.attrs);
  if (Object.keys(attrs).length > 0) out.attrs = attrs;
  const marks = canonicalMarks(node.marks);
  if (marks.length > 0) out.marks = marks;
  if (node.content && node.content.length > 0) {
    const content = mergeText(node.content.map(canonicalEditorNode).filter((child) => child.type !== "text" || (child.text ?? "") !== ""));
    if (content.length > 0) out.content = content;
  }
  return out;
}

function canonicalAttrs(defaults: EditorAttrs, attrs: EditorAttrs | undefined): EditorAttrs {
  const out: EditorAttrs = {};
  for (const key of Object.keys(defaults).sort()) {
    const value = attrs?.[key];
    out[key] = value === undefined ? (defaults[key] ?? null) : value;
  }
  return out;
}

function canonicalMarks(marks: EditorMark[] | undefined): EditorMark[] {
  if (!marks || marks.length === 0) return [];
  const byType = new Map<string, EditorMark>();
  for (const mark of marks) {
    const spec = EDITOR_MARK_SPECS[mark.type];
    if (!spec) continue;
    const attrs = canonicalAttrs(spec.attrs, mark.attrs);
    byType.set(mark.type, Object.keys(attrs).length > 0 ? { type: mark.type, attrs } : { type: mark.type });
  }
  return MARK_ORDER.filter((type) => byType.has(type)).map((type) => byType.get(type)!);
}

function sameMarks(a: EditorMark[] | undefined, b: EditorMark[] | undefined): boolean {
  return JSON.stringify(a ?? []) === JSON.stringify(b ?? []);
}

function mergeText(nodes: EditorNode[]): EditorNode[] {
  const out: EditorNode[] = [];
  for (const node of nodes) {
    const prev = out[out.length - 1];
    if (prev && prev.type === "text" && node.type === "text" && sameMarks(prev.marks, node.marks)) {
      out[out.length - 1] = { ...prev, text: (prev.text ?? "") + (node.text ?? "") };
    } else {
      out.push(node);
    }
  }
  return out;
}

/** Stable comparison key for one editor block (canonical JSON). */
export function editorBlockKey(node: EditorNode): string {
  return JSON.stringify(canonicalEditorNode(node));
}

export function canonicalEditorDoc(doc: EditorNode): EditorDoc {
  const content = (doc.content ?? []).map(canonicalEditorNode);
  return { type: "doc", content: content.length > 0 ? content : [{ type: "paragraph", attrs: { marker: null } }] };
}

// ---------------------------------------------------------------------------
// Inline markdown <-> editor inline nodes

const MARKDOWN_LINK_AT_RE = /^\[((?:\\.|[^\]\\])+)\]\(([^)\s]+)\)/;
const MENTION_AT_RE = /^@\{([A-Za-z0-9_-]{8,80})\}/;

/** Parse Noma inline markdown into editor inline nodes (text with marks, breaks, wikilinks, math). */
export function parseInline(src: string, marks: EditorMark[] = []): EditorNode[] {
  const out: EditorNode[] = [];
  let buffer = "";
  const flush = (): void => {
    if (!buffer) return;
    out.push(marks.length > 0 ? { type: "text", text: buffer, marks } : { type: "text", text: buffer });
    buffer = "";
  };
  const withMark = (mark: EditorMark): EditorMark[] => canonicalMarks([...marks, mark]);
  const push = (nodes: EditorNode[]): void => {
    flush();
    out.push(...nodes);
  };

  let i = 0;
  while (i < src.length) {
    const ch = src[i]!;
    const rest = src.slice(i);
    if (ch === "`") {
      const close = src.indexOf("`", i + 1);
      if (close > i + 1) {
        const body = src.slice(i + 1, close);
        push([{ type: "text", text: body, marks: withMark({ type: "code" }) }]);
        i = close + 1;
        continue;
      }
    }
    if (ch === "\\" && (src[i + 1] === "(" || src[i + 1] === "[")) {
      const closer = src[i + 1] === "(" ? "\\)" : "\\]";
      const close = src.indexOf(closer, i + 2);
      if (close > i + 2) {
        push([inlineAtom({ type: "math_inline", attrs: { tex: src.slice(i + 2, close), delim: `\\${src[i + 1]}` } }, marks)]);
        i = close + 2;
        continue;
      }
    }
    if (ch === "\\" && i + 1 < src.length && src[i + 1] !== "\n") {
      buffer += src.slice(i, i + 2);
      i += 2;
      continue;
    }
    if (ch === "$") {
      const math = matchDollarMath(src, i);
      if (math) {
        push([inlineAtom({ type: "math_inline", attrs: { tex: math.tex, delim: math.delim } }, marks)]);
        i = math.end;
        continue;
      }
    }
    if (rest.startsWith("[[")) {
      const close = src.indexOf("]]", i + 2);
      const raw = close > i + 2 ? src.slice(i + 2, close) : "";
      if (raw && !/[[\]\n]/.test(raw)) {
        push([inlineAtom({ type: "wikilink", attrs: { raw } }, marks)]);
        i = close + 2;
        continue;
      }
    }
    if (ch === "@" && src[i + 1] === "{") {
      const mention = MENTION_AT_RE.exec(rest);
      if (mention) {
        push([inlineAtom({ type: "mention", attrs: { userId: mention[1]! } }, marks)]);
        i += mention[0].length;
        continue;
      }
    }
    if (ch === "[") {
      const link = MARKDOWN_LINK_AT_RE.exec(rest);
      if (link) {
        push(parseInline(link[1]!, withMark({ type: "link", attrs: { href: link[2]! } })));
        i += link[0].length;
        continue;
      }
    }
    if (rest.startsWith("**")) {
      const close = src.indexOf("**", i + 2);
      const body = close > i + 2 ? src.slice(i + 2, close) : "";
      if (body && !body.includes("*")) {
        push(parseInline(body, withMark({ type: "strong", attrs: { delim: "**" } })));
        i = close + 2;
        continue;
      }
    }
    if (ch === "*" && src[i + 1] !== "*") {
      const close = src.indexOf("*", i + 1);
      const body = close > i + 1 ? src.slice(i + 1, close) : "";
      if (body && !body.includes("*")) {
        push(parseInline(body, withMark({ type: "em", attrs: { delim: "*" } })));
        i = close + 1;
        continue;
      }
    }
    if (ch === "_" && !isWordChar(src[i - 1])) {
      const close = src.indexOf("_", i + 1);
      const body = close > i + 1 ? src.slice(i + 1, close) : "";
      if (body && !isWordChar(src[close + 1]) && isWordChar(body[0]) && isWordChar(body[body.length - 1])) {
        push(parseInline(body, withMark({ type: "em", attrs: { delim: "_" } })));
        i = close + 1;
        continue;
      }
    }
    if (ch === "\n") {
      push([inlineAtom({ type: "hard_break" }, marks)]);
      i += 1;
      continue;
    }
    buffer += ch;
    i += 1;
  }
  flush();
  return mergeText(out);
}

function inlineAtom(node: EditorNode, marks: EditorMark[]): EditorNode {
  return marks.length > 0 ? { ...node, marks } : node;
}

function isWordChar(ch: string | undefined): boolean {
  return ch !== undefined && /\w/.test(ch);
}

function matchDollarMath(src: string, i: number): { tex: string; delim: string; end: number } | undefined {
  if (src.startsWith("$$", i)) {
    const close = src.indexOf("$$", i + 2);
    if (close > i + 2) return { tex: src.slice(i + 2, close), delim: "$$", end: close + 2 };
    return undefined;
  }
  const first = src[i + 1];
  if (first === undefined || /\s|\$/.test(first) || src[i - 1] === "\\") return undefined;
  for (let j = i + 1; j < src.length; j++) {
    const ch = src[j];
    if (ch === "\n") return undefined;
    if (ch === "$") {
      const tex = src.slice(i + 1, j);
      if (/\s$/.test(tex) || /^\d/.test(src[j + 1] ?? "")) return undefined;
      return { tex, delim: "$", end: j + 1 };
    }
  }
  return undefined;
}

/** Serialize editor inline nodes back to Noma inline markdown. `breaks` controls hard_break output. */
export function serializeInline(nodes: EditorNode[] | undefined, breaks = "\n"): string {
  let out = "";
  const open: EditorMark[] = [];
  const closeMark = (mark: EditorMark): string => {
    if (mark.type === "strong") return String(mark.attrs?.delim ?? "**");
    if (mark.type === "em") return String(mark.attrs?.delim ?? "*");
    if (mark.type === "code") return "`";
    if (mark.type === "link") return `](${String(mark.attrs?.href ?? "")})`;
    return "";
  };
  const openMark = (mark: EditorMark): string => {
    if (mark.type === "link") return "[";
    return closeMark(mark);
  };
  for (const raw of nodes ?? []) {
    const node = canonicalEditorNode(raw);
    const marks = node.marks ?? [];
    let keep = 0;
    while (keep < open.length && keep < marks.length && JSON.stringify(open[keep]) === JSON.stringify(marks[keep])) keep++;
    while (open.length > keep) out += closeMark(open.pop()!);
    for (let m = keep; m < marks.length; m++) {
      out += openMark(marks[m]!);
      open.push(marks[m]!);
    }
    out += inlineNodeText(node, breaks);
  }
  while (open.length > 0) out += closeMark(open.pop()!);
  return out;
}

function inlineNodeText(node: EditorNode, breaks: string): string {
  switch (node.type) {
    case "text":
      return node.text ?? "";
    case "hard_break":
      return breaks;
    case "wikilink":
      return `[[${String(node.attrs?.raw ?? "")}]]`;
    case "mention":
      return `@{${String(node.attrs?.userId ?? "")}}`;
    case "math_inline": {
      const delim = String(node.attrs?.delim ?? "$");
      const tex = String(node.attrs?.tex ?? "");
      if (delim === "\\(") return `\\(${tex}\\)`;
      if (delim === "\\[") return `\\[${tex}\\]`;
      return `${delim}${tex}${delim}`;
    }
    default:
      return "";
  }
}

/** Plain text of an inline run (for labels and id suggestions). */
export function editorPlainText(node: EditorNode): string {
  if (node.type === "text") return node.text ?? "";
  if (node.type === "hard_break") return " ";
  if (node.type === "wikilink") return String(node.attrs?.raw ?? "");
  if (node.type === "mention") return `@${String(node.attrs?.userId ?? "")}`;
  if (node.type === "math_inline") return String(node.attrs?.tex ?? "");
  return (node.content ?? []).map(editorPlainText).join(node.type === "doc" ? "\n" : "");
}

// ---------------------------------------------------------------------------
// Directive attribute strings

/** Parse a directive attribute body (`key="v" flag n=2`) into ordered pairs, using the parser's attribute grammar. */
export function parseDirectiveAttrs(raw: string): Array<[string, string | number | boolean]> {
  return Object.entries(parseAttrs(raw));
}

/** Serialize ordered attribute pairs back to a directive attribute body (without braces). */
export function serializeDirectiveAttrs(pairs: Array<[string, string | number | boolean]>): string {
  return pairs
    .filter(([key]) => ATTR_NAME_RE.test(key))
    .map(([key, value]) => serializeAttr(key, value))
    .join(" ");
}

function attrValue(raw: string | null | undefined, key: string): string | number | boolean | undefined {
  if (!raw) return undefined;
  return parseDirectiveAttrs(raw).find(([name]) => name === key)?.[1];
}

// ---------------------------------------------------------------------------
// Source analysis

interface SourceChunk {
  node: EditorNode;
  key: string;
  /** 0-based index of the first line owned by this chunk (includes leading blank/marker lines). */
  prefixStart: number;
  /** 0-based index of the block's first line. */
  start: number;
  /** 0-based exclusive end line. */
  end: number;
  /** Leading lines that are not the stable-id marker (normally blank lines). */
  gap: string[];
  prefixLines: string[];
  blockLines: string[];
  children?: ChunkList;
  opener?: string;
  closer?: string;
}

interface ChunkList {
  chunks: SourceChunk[];
  tail: string[];
}

interface AnalyzedSource {
  lines: string[];
  top: ChunkList;
  ids: Set<string>;
}

function splitLines(source: string): string[] {
  const normalized = /\r(?!\n)/.test(source) ? source.replace(/\r\n?/g, "\n") : source;
  return normalized.split("\n");
}

function analyzeSource(source: string): AnalyzedSource {
  const lines = splitLines(source);
  const doc = parse(lines.join("\n"));
  const ids = new Set<string>();
  for (const node of flattenNodes(doc.children)) {
    if (node.id) ids.add(node.id);
    for (const alias of node.aliases ?? []) ids.add(alias);
    if (node.type === "list") for (const item of node.items) if (item.id) ids.add(item.id);
  }
  const top = buildChunks(doc.children, lines, 0, lines.length, 0, 0);
  return { lines, top, ids };
}

function* flattenNodes(nodes: NomaNode[]): Generator<NomaNode> {
  for (const node of nodes) {
    yield node;
    if (node.type === "section" || node.type === "directive" || node.type === "document") yield* flattenNodes(node.children);
  }
}

function flattenBlocks(nodes: NomaNode[]): NomaNode[] {
  const out: NomaNode[] = [];
  for (const node of nodes) {
    out.push(node);
    if (node.type === "section") out.push(...flattenBlocks(node.children));
  }
  return out;
}

function buildChunks(nodes: NomaNode[], lines: string[], from: number, to: number, depth: number, parentColons: number): ChunkList {
  const chunks: SourceChunk[] = [];
  let cursor = from;
  for (const node of flattenBlocks(nodes)) {
    const start = (node.pos?.line ?? 1) - 1;
    let end = node.type === "section" ? start + 1 : Math.min(to, node.endLine ?? start + 1);
    if (start < cursor || start >= to) continue;
    while (end > start + 1 && (lines[end - 1] ?? "").trim() === "") end--;
    const prefix = lines.slice(cursor, start);
    let markerIndex = -1;
    for (let i = prefix.length - 1; i >= 0; i--) {
      if (STABLE_ID_LINE_RE.test(prefix[i] ?? "")) {
        markerIndex = i;
        break;
      }
    }
    const marker = markerIndex >= 0 ? prefix[markerIndex]! : null;
    const gap = prefix.filter((_, index) => index !== markerIndex);
    const converted = convertBlock(node, lines, start, end, depth, parentColons);
    if (marker !== null && converted.node.attrs && "marker" in (EDITOR_NODE_SPECS[converted.node.type]?.attrs ?? {})) {
      converted.node.attrs.marker = marker;
    } else if (marker !== null) {
      converted.node = rawNode(lines.slice(cursor, end).join("\n"), converted.node.type);
      chunks.push({
        node: converted.node,
        key: editorBlockKey(converted.node),
        prefixStart: cursor,
        start: cursor,
        end,
        gap: [],
        prefixLines: [],
        blockLines: lines.slice(cursor, end),
      });
      cursor = end;
      continue;
    }
    chunks.push({
      ...converted,
      key: editorBlockKey(converted.node),
      prefixStart: cursor,
      start,
      end,
      gap,
      prefixLines: prefix,
      blockLines: lines.slice(start, end),
    });
    cursor = end;
  }
  return { chunks, tail: lines.slice(cursor, to) };
}

interface ConvertedBlock {
  node: EditorNode;
  children?: ChunkList;
  opener?: string;
  closer?: string;
}

function rawNode(src: string, label: string): EditorNode {
  return { type: "raw", attrs: { src, label } };
}

function convertBlock(node: NomaNode, lines: string[], start: number, end: number, depth: number, parentColons: number): ConvertedBlock {
  const text = lines.slice(start, end).join("\n");
  switch (node.type) {
    case "frontmatter":
      return { node: { type: "frontmatter", attrs: { src: text } } };
    case "section":
      return { node: convertHeading(node, lines[start] ?? "") };
    case "paragraph":
      return { node: { type: "paragraph", attrs: { marker: null }, content: parseInline(node.content) } };
    case "quote":
      return { node: { type: "blockquote", attrs: { marker: null }, content: parseInline(node.content) } };
    case "thematic_break":
      return { node: { type: "horizontal_rule", attrs: { raw: (lines[start] ?? "---").trim(), marker: null } } };
    case "code": {
      const open = matchCodeFenceOpen(lines[start] ?? "");
      const closed = open !== null && end - start >= 2 && isCodeFenceClose(lines[end - 1] ?? "", open);
      if (!open || !closed) return { node: rawNode(text, "code") };
      const content = node.content ? [{ type: "text", text: node.content }] : undefined;
      const fence = open.char.repeat(open.length);
      return { node: { type: "code_block", attrs: { lang: node.lang ?? "", fence, marker: null }, ...(content ? { content } : {}) } };
    }
    case "list":
      return { node: convertList(node.ordered, lines.slice(start, end)) ?? rawNode(text, "list") };
    case "table":
      return { node: convertTable(lines.slice(start, end)) ?? rawNode(text, "table") };
    case "directive":
      return convertDirective(node, lines, start, end, depth, parentColons);
    default:
      return { node: rawNode(text, node.type) };
  }
}

function convertHeading(section: SectionNode, line: string): EditorNode {
  const text = /^#{1,6}\s+(.*)$/.exec(line)?.[1] ?? "";
  const rawAttrs = splitHeadingAttrs(text).rawAttrs ?? null;
  return {
    type: "heading",
    attrs: { level: section.level, id: section.id ?? null, attrs: rawAttrs, marker: null },
    content: parseInline(section.title),
  };
}

function convertList(ordered: boolean, lines: string[]): EditorNode | undefined {
  const items: EditorNode[] = [];
  let bullet = "-";
  for (const [index, line] of lines.entries()) {
    const match = (ordered ? ORDERED_LIST_RE : LIST_RE).exec(line);
    if (!match) return undefined;
    if (index === 0 && !ordered) bullet = match[1]!;
    let rest = match[2]!;
    const idMatch = INLINE_ID_RE.exec(rest);
    const id = idMatch ? idMatch[1]! : null;
    if (idMatch) rest = rest.slice(idMatch[0].length);
    const task = TASK_RE.exec(rest);
    const checked = task ? task[1] !== " " : null;
    if (task) rest = rest.slice(task[0].length);
    items.push({
      type: "list_item",
      attrs: { id, checked, num: ordered ? match[1]! : null },
      content: parseInline(rest),
    });
  }
  if (items.length === 0) return undefined;
  return ordered
    ? { type: "ordered_list", attrs: { marker: null }, content: items }
    : { type: "bullet_list", attrs: { marker: null, bullet }, content: items };
}

function convertTable(lines: string[]): EditorNode | undefined {
  if (lines.length < 2) return undefined;
  const header = splitPipeRow(lines[0] ?? "");
  const separator = splitPipeRow(lines[1] ?? "");
  if (header.length !== separator.length) return undefined;
  const align = separator
    .map((cell) => {
      const left = cell.startsWith(":");
      const right = cell.endsWith(":");
      return left && right ? "c" : right ? "r" : left ? "l" : "-";
    })
    .join(",");
  const cell = (type: "table_header" | "table_cell", raw: string): EditorNode => {
    const idMatch = INLINE_ID_RE.exec(raw);
    const content = idMatch ? raw.slice(idMatch[0].length) : raw;
    return {
      type,
      attrs: { id: idMatch ? idMatch[1]! : null, colspan: 1, rowspan: 1, colwidth: null },
      content: parseInline(unescapeCell(content)),
    };
  };
  const rows: EditorNode[] = [{ type: "table_row", content: header.map((raw) => cell("table_header", raw)) }];
  for (const line of lines.slice(2)) {
    const cells = splitPipeRow(line);
    while (cells.length < header.length) cells.push("");
    if (cells.length > header.length) return undefined;
    rows.push({ type: "table_row", content: cells.map((raw) => cell("table_cell", raw)) });
  }
  return { type: "table", attrs: { align, marker: null }, content: rows };
}

function unescapeCell(value: string): string {
  let out = "";
  let inCode = false;
  for (let i = 0; i < value.length; i++) {
    const ch = value[i]!;
    if (ch === "`") inCode = !inCode;
    if (ch === "\\" && value[i + 1] === "|" && !inCode) {
      out += "|";
      i++;
      continue;
    }
    out += ch;
  }
  return out;
}

function convertDirective(
  node: Extract<NomaNode, { type: "directive" }>,
  lines: string[],
  start: number,
  end: number,
  depth: number,
  parentColons: number,
): ConvertedBlock {
  const text = lines.slice(start, end).join("\n");
  const opener = lines[start] ?? "";
  const closer = lines[end - 1] ?? "";
  const open = DIRECTIVE_OPEN_RE.exec(opener);
  const close = end - start >= 2 ? DIRECTIVE_CLOSE_RE.exec(closer) : null;
  const colons = open?.[1]?.length ?? 0;
  if (!open || !close || close[1]!.length !== colons || colons <= parentColons || depth >= MAX_DIRECTIVE_DEPTH) {
    return { node: rawNode(text, node.name) };
  }
  const name = open[2]!;
  const attrs = open[3] ? open[3].slice(1, -1) : "";
  const base = { name, attrs, colons, marker: null };
  if (RAW_DIRECTIVES.has(name)) return { node: rawNode(text, name) };
  if (TEXT_DIRECTIVES.has(name)) {
    const body = lines.slice(start + 1, end - 1).join("\n");
    return { node: { type: "text_directive", attrs: base, ...(body ? { content: [{ type: "text", text: body }] } : {}) } };
  }
  if (CHIP_DIRECTIVES.has(name) && node.children.length > 0) return { node: rawNode(text, name) };
  const children = buildChunks(node.children, lines, start + 1, end - 1, depth + 1, colons);
  if (children.tail.some((line) => line.trim() !== "")) return { node: rawNode(text, name) };
  return {
    node: { type: "directive", attrs: base, content: children.chunks.map((chunk) => chunk.node) },
    children,
    opener,
    closer,
  };
}

// ---------------------------------------------------------------------------
// Public conversion API

/** Project `.noma` source into editor JSON. Deterministic: equal source → equal JSON. */
export function nomaToEditorDoc(source: string): EditorDoc {
  const analyzed = analyzeSource(source);
  return canonicalEditorDoc({ type: "doc", content: analyzed.top.chunks.map((chunk) => chunk.node) });
}

interface SerializeContext {
  lineOffset: number;
  usedIds: Set<string>;
  knownIds: Set<string>;
  headings: Array<{ line: number; id: string | null; level: number; title: string; attrs: string | null }>;
  out: string[];
}

/**
 * Write editor JSON back to `.noma` source. Blocks whose editor JSON matches a
 * block of `originalSource` are copied byte-for-byte; edited and new blocks are
 * serialized. Stable IDs are preserved (a renamed heading keeps its old slug as
 * an explicit `{id}`); new blocks that need an ID get a deterministic one.
 */
export function editorDocToNoma(doc: EditorNode, originalSource = ""): string {
  const analyzed = analyzeSource(originalSource);
  const nodes = canonicalEditorDoc(doc).content;
  const ctx: SerializeContext = {
    lineOffset: 0,
    usedIds: new Set(),
    knownIds: new Set([...analyzed.ids, ...collectEditorIds(nodes)]),
    headings: [],
    out: [],
  };
  emitList(nodes, analyzed.top, ctx, 0);
  let lines = ctx.out;
  lines = enforceHeadingIds(lines, ctx.headings, ctx.knownIds);
  return lines.join("\n");
}

function collectEditorIds(nodes: EditorNode[]): string[] {
  const ids: string[] = [];
  const visit = (node: EditorNode): void => {
    const marker = typeof node.attrs?.marker === "string" ? STABLE_ID_LINE_RE.exec(node.attrs.marker)?.[1] : undefined;
    if (marker) ids.push(marker);
    if (node.type === "heading" && typeof node.attrs?.id === "string") ids.push(node.attrs.id);
    if (node.type === "list_item" && typeof node.attrs?.id === "string") ids.push(node.attrs.id);
    if (node.type === "directive" || node.type === "text_directive") {
      const id = attrValue(String(node.attrs?.attrs ?? ""), "id");
      if (typeof id === "string") ids.push(id);
    }
    for (const child of node.content ?? []) visit(child);
  };
  for (const node of nodes) visit(node);
  return ids;
}

function chunkIds(chunk: SourceChunk): string[] {
  return collectEditorIds([chunk.node]);
}

function emitList(nodes: EditorNode[], original: ChunkList, ctx: SerializeContext, parentColons: number): void {
  const keys = nodes.map(editorBlockKey);
  const pairs = lcsPairs(original.chunks.map((chunk) => chunk.key), keys);
  for (const [o] of pairs) for (const id of chunkIds(original.chunks[o]!)) ctx.usedIds.add(id);
  const startLength = ctx.out.length;
  let oi = 0;
  let ni = 0;
  let lastOriginal = -1;
  let changedSinceLast = false;
  const separatedFromPrevious = (gap: string[]): boolean => {
    const previous = ctx.out.length > startLength ? ctx.out[ctx.out.length - 1] : undefined;
    return previous === undefined || previous.trim() === "" || gap.some((line) => line.trim() === "");
  };
  const flushRun = (oEnd: number, nEnd: number): void => {
    const oldRun = original.chunks.slice(oi, oEnd);
    const newRun = nodes.slice(ni, nEnd);
    if (oldRun.length > newRun.length) changedSinceLast = true;
    newRun.forEach((node, k) => {
      const candidate = oldRun[k];
      const ref = candidate && sameKind(candidate.node, node) ? candidate : undefined;
      const refIndex = oi + k;
      const adjacent = ref !== undefined && lastOriginal === refIndex - 1 && !changedSinceLast;
      const first = ctx.out.length === startLength;
      let gap = ref ? ref.gap : first ? [] : [""];
      if (!adjacent && !separatedFromPrevious(gap)) gap = [...gap, ""];
      if (emitNew(node, ref, gap, ctx, parentColons) && ref) lastOriginal = refIndex;
      else changedSinceLast = true;
    });
  };
  for (const [o, n] of pairs) {
    flushRun(o, n);
    const chunk = original.chunks[o]!;
    const adjacent = lastOriginal === o - 1 && !changedSinceLast;
    if (!adjacent && !separatedFromPrevious(chunk.prefixLines)) ctx.out.push("");
    emitOriginalChunk(chunk, ctx);
    lastOriginal = o;
    changedSinceLast = false;
    oi = o + 1;
    ni = n + 1;
  }
  flushRun(original.chunks.length, nodes.length);
  ctx.out.push(...original.tail);
}

function emitOriginalChunk(chunk: SourceChunk, ctx: SerializeContext): void {
  const blockStart = ctx.out.length + chunk.prefixLines.length;
  ctx.out.push(...chunk.prefixLines, ...chunk.blockLines);
  if (chunk.node.type === "heading") recordHeading(chunk.node, typeof chunk.node.attrs?.id === "string" ? chunk.node.attrs.id : null, blockStart, ctx);
}

function sameKind(a: EditorNode, b: EditorNode): boolean {
  if (a.type !== b.type) return false;
  if (a.type === "directive" || a.type === "text_directive") return a.attrs?.name === b.attrs?.name;
  return true;
}

function emitNew(node: EditorNode, ref: SourceChunk | undefined, gap: string[], ctx: SerializeContext, parentColons: number): boolean {
  const marker = uniqueMarker(node, ctx);
  const blockStart = ctx.out.length + gap.length + (marker !== null ? 1 : 0);
  const headingCount = ctx.headings.length;
  const block = serializeBlock(node, ref, ctx, parentColons, marker !== null, blockStart);
  if (block.length === 0) {
    ctx.headings.length = headingCount;
    return false;
  }
  ctx.out.push(...gap);
  if (marker !== null) ctx.out.push(marker);
  ctx.out.push(...block);
  return true;
}

function uniqueMarker(node: EditorNode, ctx: SerializeContext): string | null {
  const marker = typeof node.attrs?.marker === "string" && node.attrs.marker ? node.attrs.marker : null;
  if (marker === null) return null;
  const id = STABLE_ID_LINE_RE.exec(marker)?.[1];
  if (!id) return null;
  if (ctx.usedIds.has(id)) return null;
  ctx.usedIds.add(id);
  return marker;
}

function claimId(id: string | null | undefined, ctx: SerializeContext): string | null {
  if (!id) return null;
  if (ctx.usedIds.has(id)) return null;
  ctx.usedIds.add(id);
  return id;
}

function recordHeading(node: EditorNode, id: string | null, line: number, ctx: SerializeContext): void {
  ctx.headings.push({
    line: ctx.lineOffset + line,
    id,
    level: Math.max(1, Math.min(6, Number(node.attrs?.level ?? 1) || 1)),
    title: serializeInline(node.content, " ").trim() || "Untitled",
    attrs: typeof node.attrs?.attrs === "string" ? node.attrs.attrs : null,
  });
}

function serializeBlock(
  node: EditorNode,
  ref: SourceChunk | undefined,
  ctx: SerializeContext,
  parentColons: number,
  hasMarker: boolean,
  blockStart: number,
): string[] {
  switch (node.type) {
    case "frontmatter":
      return String(node.attrs?.src ?? "") ? String(node.attrs?.src).split("\n") : [];
    case "raw": {
      const src = String(node.attrs?.src ?? "");
      return src.trim() ? src.split("\n") : [];
    }
    case "paragraph": {
      const text = serializeInline(node.content);
      return text.trim() || hasMarker ? text.split("\n") : [];
    }
    case "heading":
      return [serializeHeading(node, ctx, blockStart)];
    case "blockquote":
      return serializeInline(node.content).split("\n").map((line) => (line ? `> ${line}` : ">"));
    case "horizontal_rule":
      return [/^(?:-{3,}|\*{3,}|_{3,})$/.test(String(node.attrs?.raw ?? "")) ? String(node.attrs?.raw) : "---"];
    case "code_block": {
      const text = editorPlainText(node);
      const stored = String(node.attrs?.fence ?? "```");
      const char = stored.startsWith("~") ? "~" : "`";
      const longestRun = Math.max(0, ...(text.match(new RegExp(`^${char === "~" ? "~" : "`"}{3,}`, "gm")) ?? []).map((run) => run.length));
      const fence = char.repeat(Math.max(3, stored.length, longestRun + 1));
      const lang = String(node.attrs?.lang ?? "").replace(char === "`" ? /[`\s]/g : /\s/g, "");
      return [fence + lang, ...(text ? text.split("\n") : []), fence];
    }
    case "bullet_list":
    case "ordered_list":
      return serializeList(node, ref, ctx);
    case "table":
      return serializeTable(node, ref, ctx);
    case "text_directive":
      return serializeTextDirective(node, parentColons, ctx);
    case "directive":
      return serializeDirective(node, ref, ctx, parentColons, blockStart);
    default:
      return [];
  }
}

function serializeHeading(node: EditorNode, ctx: SerializeContext, blockStart: number): string {
  const level = Math.max(1, Math.min(6, Number(node.attrs?.level ?? 1) || 1));
  const title = serializeInline(node.content, " ").trim() || "Untitled";
  const raw = typeof node.attrs?.attrs === "string" ? node.attrs.attrs : null;
  const pairs = raw ? parseDirectiveAttrs(raw) : [];
  const wanted = claimId(typeof node.attrs?.id === "string" ? node.attrs.id : null, ctx);
  const explicit = pairs.find(([key]) => key === "id");
  let nextPairs = pairs;
  if (wanted) {
    if (explicit) nextPairs = pairs.map(([key, value]) => [key, key === "id" ? wanted : value]);
  } else if (explicit && typeof explicit[1] === "string") {
    if (ctx.usedIds.has(explicit[1])) nextPairs = pairs.filter(([key]) => key !== "id");
    else ctx.usedIds.add(explicit[1]);
  }
  const finalId = nextPairs.find(([key]) => key === "id")?.[1];
  recordHeading(node, wanted ?? (typeof finalId === "string" ? finalId : null), blockStart, ctx);
  const unchangedRaw = raw !== null && JSON.stringify(nextPairs) === JSON.stringify(pairs);
  const attrText = unchangedRaw ? raw : serializeDirectiveAttrs(nextPairs);
  return `${"#".repeat(level)} ${title}${attrText ? ` {${attrText}}` : ""}`;
}

function listItemLine(node: EditorNode, item: EditorNode, index: number, prevNum: number, ctx: SerializeContext): { line: string; num: number } | undefined {
  const content = serializeInline(item.content, " ");
  if (!content.trim()) return undefined;
  const ordered = node.type === "ordered_list";
  const stored = Number(item.attrs?.num);
  const num = ordered ? (Number.isInteger(stored) && stored > prevNum ? stored : prevNum + 1) : 0;
  const bullet = ordered ? `${num}.` : String(node.attrs?.bullet ?? "-") === "*" ? "*" : "-";
  const id = claimId(typeof item.attrs?.id === "string" ? item.attrs.id : null, ctx);
  const task = item.attrs?.checked === true ? "[x] " : item.attrs?.checked === false ? "[ ] " : "";
  return { line: `${bullet} ${id ? `{#${id}} ` : ""}${task}${content}`, num: ordered ? num : index };
}

function serializeList(node: EditorNode, ref: SourceChunk | undefined, ctx: SerializeContext): string[] {
  const items = node.content ?? [];
  const refItems = ref?.node.content ?? [];
  const refLines = ref ? ref.blockLines : [];
  const pairs = new Map(lcsPairs(refItems.map(editorBlockKey), items.map(editorBlockKey)).map(([o, n]) => [n, o]));
  for (const o of pairs.values()) {
    const id = refItems[o]?.attrs?.id;
    if (typeof id === "string") ctx.usedIds.add(id);
  }
  const out: string[] = [];
  let prevNum = 0;
  items.forEach((item, index) => {
    const o = pairs.get(index);
    const reused = o !== undefined ? refLines[o] : undefined;
    if (reused !== undefined) {
      out.push(reused);
      const num = Number(ORDERED_LIST_RE.exec(reused)?.[1]);
      if (Number.isInteger(num)) prevNum = num;
      return;
    }
    const line = listItemLine(node, item, index, prevNum, ctx);
    if (!line) return;
    out.push(line.line);
    if (node.type === "ordered_list") prevNum = line.num;
  });
  return out;
}

function serializeTable(node: EditorNode, ref: SourceChunk | undefined, ctx: SerializeContext): string[] {
  const rows = node.content ?? [];
  if (rows.length === 0) return [];
  const width = Math.max(...rows.map((row) => (row.content ?? []).reduce((sum, cell) => sum + Math.max(1, Number(cell.attrs?.colspan ?? 1) || 1), 0)));
  if (width === 0) return [];
  const align = String(node.attrs?.align ?? "").split(",");
  const rowLine = (row: EditorNode): string => {
    const cells: string[] = [];
    for (const cell of row.content ?? []) {
      const id = claimId(typeof cell.attrs?.id === "string" ? cell.attrs.id : null, ctx);
      const text = escapePipeTableCell(serializeInline(cell.content, " ").trim());
      cells.push(`${id ? `{#${id}} ` : ""}${text}`);
      for (let span = 1; span < (Number(cell.attrs?.colspan ?? 1) || 1); span++) cells.push("");
    }
    while (cells.length < width) cells.push("");
    return `| ${cells.slice(0, width).join(" | ")} |`;
  };
  const separator = `|${Array.from({ length: width }, (_, index) => {
    const a = align[index] ?? "-";
    return a === "c" ? ":---:" : a === "r" ? "---:" : a === "l" ? ":---" : "---";
  }).join("|")}|`;
  const refRows = ref?.node.content ?? [];
  const refLines = ref ? ref.blockLines : [];
  const headerSame = ref !== undefined && refRows[0] !== undefined && editorBlockKey(refRows[0]) === editorBlockKey(rows[0]!) && ref.node.attrs?.align === node.attrs?.align;
  const out: string[] = [];
  if (headerSame) {
    for (const cell of rows[0]!.content ?? []) if (typeof cell.attrs?.id === "string") ctx.usedIds.add(cell.attrs.id);
    out.push(refLines[0] ?? rowLine(rows[0]!), refLines[1] ?? separator);
  } else {
    out.push(rowLine(rows[0]!), separator);
  }
  const bodyRef = refRows.slice(1);
  const body = rows.slice(1);
  const pairs = new Map(lcsPairs(bodyRef.map(editorBlockKey), body.map(editorBlockKey)).map(([o, n]) => [n, o]));
  for (const o of pairs.values()) {
    for (const cell of bodyRef[o]?.content ?? []) if (typeof cell.attrs?.id === "string") ctx.usedIds.add(cell.attrs.id);
  }
  body.forEach((row, index) => {
    const o = pairs.get(index);
    const reused = o !== undefined && headerSame ? refLines[o + 2] : undefined;
    out.push(reused ?? rowLine(row));
  });
  return out;
}

function directiveAttrsWithId(node: EditorNode, ctx: SerializeContext): string {
  const name = String(node.attrs?.name ?? "");
  const raw = String(node.attrs?.attrs ?? "");
  const pairs = parseDirectiveAttrs(raw);
  const id = pairs.find(([key]) => key === "id")?.[1];
  if (typeof id === "string" && id) {
    if (!ctx.usedIds.has(id)) {
      ctx.usedIds.add(id);
      return raw;
    }
    const without = pairs.filter(([key]) => key !== "id");
    return ID_REQUIRED_DIRECTIVES.has(name) ? serializeDirectiveAttrs([["id", nextDirectiveId(name, ctx)], ...without]) : serializeDirectiveAttrs(without);
  }
  if (!ID_REQUIRED_DIRECTIVES.has(name)) return raw;
  return serializeDirectiveAttrs([["id", nextDirectiveId(name, ctx)], ...pairs]);
}

function nextDirectiveId(name: string, ctx: SerializeContext): string {
  const base = slugify(name.replace(/::/g, "-")) || "block";
  for (let n = 1; ; n++) {
    const candidate = `${base}-${n}`;
    if (!ctx.usedIds.has(candidate) && !ctx.knownIds.has(candidate)) {
      ctx.usedIds.add(candidate);
      ctx.knownIds.add(candidate);
      return candidate;
    }
  }
}

function directiveName(node: EditorNode): string {
  const name = String(node.attrs?.name ?? "");
  return /^[a-zA-Z_][\w-]*(?:::[a-zA-Z_][\w-]*)*$/.test(name) ? name : "note";
}

function colonsFor(node: EditorNode, parentColons: number): number {
  const stored = Number(node.attrs?.colons ?? 2);
  const colons = Number.isInteger(stored) && stored >= 2 ? stored : 2;
  return Math.min(64, colons > parentColons ? colons : parentColons + 1);
}

function serializeTextDirective(node: EditorNode, parentColons: number, ctx: SerializeContext): string[] {
  const colons = colonsFor(node, parentColons);
  const fence = ":".repeat(colons);
  const attrs = directiveAttrsWithId(node, ctx);
  const body = editorPlainText(node);
  const bodyLines = body ? body.split("\n").map((line) => (DIRECTIVE_CLOSE_RE.test(line) ? ` ${line}` : line)) : [];
  return [`${fence}${directiveName(node)}${attrs ? `{${attrs}}` : ""}`, ...bodyLines, fence];
}

function serializeDirective(node: EditorNode, ref: SourceChunk | undefined, ctx: SerializeContext, parentColons: number, blockStart: number): string[] {
  const colons = colonsFor(node, parentColons);
  const fence = ":".repeat(colons);
  const name = directiveName(node);
  const attrs = directiveAttrsWithId(node, ctx);
  const sameShell = ref?.opener !== undefined && ref.node.attrs?.name === name && ref.node.attrs?.attrs === attrs && Number(ref.node.attrs?.colons) === colons;
  const opener = sameShell ? ref.opener! : `${fence}${name}${attrs ? `{${attrs}}` : ""}`;
  const closer = sameShell && ref.closer !== undefined ? ref.closer : fence;
  const inner: SerializeContext = { ...ctx, out: [], lineOffset: ctx.lineOffset + blockStart + 1 };
  emitList(node.content ?? [], sameShell && ref.children ? ref.children : { chunks: ref?.children?.chunks ?? [], tail: [] }, inner, colons);
  const innerLines = inner.out;
  return [opener, ...innerLines, closer];
}

function enforceHeadingIds(lines: string[], headings: SerializeContext["headings"], knownIds: Set<string>): string[] {
  let current = lines;
  const ordered = [...headings].sort((x, y) => x.line - y.line);
  for (let attempt = 0; attempt < 8; attempt++) {
    const parsed = new Map<number, string>();
    const doc = parse(current.join("\n"));
    for (const node of flattenNodes(doc.children)) {
      if (node.type === "section" && node.pos && node.id) parsed.set(node.pos.line - 1, node.id);
    }
    const intended = new Set(ordered.map((heading) => heading.id).filter((id): id is string => id !== null));
    const taken = new Set<string>([...intended, ...parsed.values()]);
    const seen = new Set<string>();
    let changed = false;
    const next = [...current];
    const rewrite = (heading: SerializeContext["headings"][number], id: string): void => {
      const pairs = heading.attrs ? parseDirectiveAttrs(heading.attrs).filter(([key]) => key !== "id") : [];
      const attrText = serializeDirectiveAttrs([["id", id], ...pairs]);
      next[heading.line] = `${"#".repeat(heading.level)} ${heading.title} {${attrText}}`;
      heading.attrs = attrText;
      heading.id = id;
      changed = true;
    };
    for (const heading of ordered) {
      const actual = parsed.get(heading.line);
      if (actual === undefined) continue;
      if (heading.id !== null) {
        if (actual !== heading.id) rewrite(heading, heading.id);
        seen.add(heading.id);
        continue;
      }
      if (seen.has(actual) || intended.has(actual)) {
        const base = headingSlug(heading.title);
        let n = 2;
        while (taken.has(`${base}-${n}`) || knownIds.has(`${base}-${n}`)) n++;
        const id = `${base}-${n}`;
        taken.add(id);
        rewrite(heading, id);
        seen.add(id);
        continue;
      }
      seen.add(actual);
    }
    current = next;
    if (!changed) break;
  }
  return current;
}

// ---------------------------------------------------------------------------
// Sequence alignment

/**
 * Longest common subsequence of two key lists, as increasing index pairs.
 * Common prefix/suffix are matched first; very large middles fall back to
 * matching unique keys so work stays bounded.
 */
export function lcsPairs(a: readonly string[], b: readonly string[]): Array<[number, number]> {
  const pairs: Array<[number, number]> = [];
  let start = 0;
  while (start < a.length && start < b.length && a[start] === b[start]) {
    pairs.push([start, start]);
    start++;
  }
  let endA = a.length;
  let endB = b.length;
  const suffix: Array<[number, number]> = [];
  while (endA > start && endB > start && a[endA - 1] === b[endB - 1]) {
    endA--;
    endB--;
    suffix.unshift([endA, endB]);
  }
  const n = endA - start;
  const m = endB - start;
  if (n > 0 && m > 0) {
    if (n * m <= 4_000_000) pairs.push(...lcsDynamic(a, b, start, endA, start, endB));
    else pairs.push(...lcsUnique(a, b, start, endA, start, endB));
  }
  pairs.push(...suffix);
  return pairs;
}

function lcsDynamic(a: readonly string[], b: readonly string[], a0: number, a1: number, b0: number, b1: number): Array<[number, number]> {
  const n = a1 - a0;
  const m = b1 - b0;
  const table = new Uint32Array((n + 1) * (m + 1));
  const at = (i: number, j: number): number => table[i * (m + 1) + j] ?? 0;
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      table[i * (m + 1) + j] = a[a0 + i] === b[b0 + j] ? at(i + 1, j + 1) + 1 : Math.max(at(i + 1, j), at(i, j + 1));
    }
  }
  const out: Array<[number, number]> = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[a0 + i] === b[b0 + j]) {
      out.push([a0 + i, b0 + j]);
      i++;
      j++;
    } else if (at(i + 1, j) >= at(i, j + 1)) {
      i++;
    } else {
      j++;
    }
  }
  return out;
}

function lcsUnique(a: readonly string[], b: readonly string[], a0: number, a1: number, b0: number, b1: number): Array<[number, number]> {
  const count = (list: readonly string[], from: number, to: number): Map<string, number> => {
    const map = new Map<string, number>();
    for (let i = from; i < to; i++) map.set(list[i]!, (map.get(list[i]!) ?? 0) + 1);
    return map;
  };
  const ca = count(a, a0, a1);
  const cb = count(b, b0, b1);
  const indexB = new Map<string, number>();
  for (let j = b0; j < b1; j++) if (cb.get(b[j]!) === 1) indexB.set(b[j]!, j);
  const out: Array<[number, number]> = [];
  let lastB = b0 - 1;
  for (let i = a0; i < a1; i++) {
    if (ca.get(a[i]!) !== 1) continue;
    const j = indexB.get(a[i]!);
    if (j !== undefined && j > lastB) {
      out.push([i, j]);
      lastB = j;
    }
  }
  return out;
}

export type MergeStep = { kind: "keep"; index: number } | { kind: "insert"; index: number };

/**
 * Block-level three-way merge plan. Given the common ancestor (`base`), an
 * external version (`theirs`, e.g. an agent patch or API PUT) and the live
 * version (`current`), return the merged sequence as steps over `current`
 * (keep a current block) and `theirs` (insert a theirs block). Blocks changed
 * only externally are replaced; blocks changed only live are kept; when both
 * sides touched the same region, both versions survive so nothing is lost.
 */
export function planBlockMerge(base: readonly string[], theirs: readonly string[], current: readonly string[]): MergeStep[] {
  const baseToTheirs = new Map(lcsPairs(base, theirs));
  const baseToCurrent = new Map(lcsPairs(base, current));
  const anchors: Array<{ b: number; t: number; c: number }> = [];
  for (let b = 0; b < base.length; b++) {
    const t = baseToTheirs.get(b);
    const c = baseToCurrent.get(b);
    if (t === undefined || c === undefined) continue;
    const prev = anchors[anchors.length - 1];
    if (prev && (t <= prev.t || c <= prev.c)) continue;
    anchors.push({ b, t, c });
  }
  const steps: MergeStep[] = [];
  let pb = 0;
  let pt = 0;
  let pc = 0;
  const gap = (be: number, te: number, ce: number): void => {
    const baseSeg = base.slice(pb, be);
    const theirsSeg = theirs.slice(pt, te);
    const currentSeg = current.slice(pc, ce);
    const same = (x: readonly string[], y: readonly string[]): boolean => x.length === y.length && x.every((key, i) => key === y[i]);
    const keepCurrent = (): void => {
      for (let c = pc; c < ce; c++) steps.push({ kind: "keep", index: c });
    };
    if (same(baseSeg, theirsSeg) || same(currentSeg, theirsSeg)) {
      keepCurrent();
    } else if (same(baseSeg, currentSeg)) {
      for (let t = pt; t < te; t++) steps.push({ kind: "insert", index: t });
    } else {
      const removedByTheirs = new Set(baseSeg.filter((key) => !theirsSeg.includes(key)));
      for (let c = pc; c < ce; c++) if (!removedByTheirs.has(current[c]!)) steps.push({ kind: "keep", index: c });
      for (let t = pt; t < te; t++) {
        const key = theirs[t]!;
        if (!baseSeg.includes(key) && !currentSeg.includes(key)) steps.push({ kind: "insert", index: t });
      }
    }
  };
  for (const anchor of anchors) {
    gap(anchor.b, anchor.t, anchor.c);
    steps.push({ kind: "keep", index: anchor.c });
    pb = anchor.b + 1;
    pt = anchor.t + 1;
    pc = anchor.c + 1;
  }
  gap(base.length, theirs.length, current.length);
  return steps;
}

// ---------------------------------------------------------------------------
// Identity backfill

export interface EditorAttrPatch {
  /** Child-index path from the document root to the node. */
  path: number[];
  attrs: EditorAttrs;
}

/**
 * After `editorDocToNoma` assigns IDs to new blocks (heading slugs, directive
 * ids), return attr patches that write those IDs back into the editor doc so
 * later edits keep them stable. Only fills missing IDs; never renames.
 */
export function editorIdBackfill(doc: EditorNode, source: string): EditorAttrPatch[] {
  const patches: EditorAttrPatch[] = [];
  const derived = nomaToEditorDoc(source).content;
  const visit = (current: EditorNode[], next: EditorNode[], path: number[]): void => {
    if (current.length !== next.length) return;
    current.forEach((node, index) => {
      const target = next[index]!;
      if (node.type !== target.type) return;
      const at = [...path, index];
      if (node.type === "heading" && !node.attrs?.id && typeof target.attrs?.id === "string") {
        patches.push({ path: at, attrs: { ...canonicalEditorNode(node).attrs, id: target.attrs.id } });
      }
      if ((node.type === "directive" || node.type === "text_directive") && node.attrs?.name === target.attrs?.name) {
        const had = attrValue(String(node.attrs?.attrs ?? ""), "id");
        const has = attrValue(String(target.attrs?.attrs ?? ""), "id");
        if (had === undefined && typeof has === "string") {
          patches.push({ path: at, attrs: { ...canonicalEditorNode(node).attrs, attrs: String(target.attrs?.attrs ?? "") } });
        }
      }
      if (node.type === "directive") visit(node.content ?? [], target.content ?? [], at);
    });
  };
  visit(canonicalEditorDoc(doc).content, derived, []);
  return patches;
}

/** Stable-ID of an editor block, if it has one (used for deduplication in editors). */
export function editorNodeId(node: EditorNode): string | undefined {
  if (node.type === "heading" && typeof node.attrs?.id === "string") return node.attrs.id;
  if (node.type === "list_item" && typeof node.attrs?.id === "string") return node.attrs.id;
  if ((node.type === "table_cell" || node.type === "table_header") && typeof node.attrs?.id === "string") return node.attrs.id;
  if (node.type === "directive" || node.type === "text_directive") {
    const id = attrValue(String(node.attrs?.attrs ?? ""), "id");
    if (typeof id === "string") return id;
  }
  const marker = typeof node.attrs?.marker === "string" ? STABLE_ID_LINE_RE.exec(node.attrs.marker)?.[1] : undefined;
  return marker ?? undefined;
}

