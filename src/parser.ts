import yaml from "js-yaml";
import { splitPipeRow } from "./inline.js";
import type {
  Attrs,
  AttrValue,
  CodeNode,
  DirectiveNode,
  DocumentNode,
  FrontmatterNode,
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
import { parseInlineStableId, parseListItemIdentity, STABLE_ID_LINE_RE } from "./stable-identity.js";

export interface ParseOptions {
  /** Optional source filename, kept on the document meta for diagnostics. */
  filename?: string;
}

const FRONTMATTER_RE = /^---\s*$/;
const HEADING_RE = /^(#{1,6})\s+(.+?)\s*$/;
const HEADING_ATTRS_RE = /^(.+?)\s+\{([^}]*)\}$/;
const FENCE_OPEN_RE = /^(`{3,})([^`]*)$|^(~{3,})(.*)$/;
const DIRECTIVE_OPEN_RE = /^(:{2,})\s*([a-zA-Z_][\w-]*(?:::[a-zA-Z_][\w-]*)*)\s*(\{.*\})?\s*$/;
const DIRECTIVE_CLOSE_RE = /^(:{2,})\s*$/;
const LIST_RE = /^([-*])\s+(.+)$/;
const ORDERED_LIST_RE = /^(\d+)\.\s+(.+)$/;
const QUOTE_RE = /^>\s?(.*)$/;
const THEMATIC_BREAK_RE = /^(?:-{3,}|\*{3,}|_{3,})\s*$/;
const TABLE_ROW_RE = /^\s*\|.*\|\s*$/;
const TABLE_SEPARATOR_RE = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/;

/**
 * Directive nesting depth is one level per extra colon, so capping the fence
 * width bounds parser/walker recursion on adversarial input. Real documents
 * sit at depth 2–4.
 */
const MAX_FENCE_COLONS = 64;

const matchOnce = (re: RegExp, s: string): RegExpMatchArray | null => s.match(re);

export function parse(source: string, options: ParseOptions = {}): DocumentNode {
  const normalized = source.replace(/\r\n?/g, "\n");
  const lines = normalized.split("\n");

  const { meta, raw, startLine, endLine: fmEnd } = extractFrontmatter(lines);
  const flatChildren = parseBlocks(lines, startLine, lines.length, 0);
  const children: Node[] = foldSections(flatChildren);
  for (const c of children) computeSectionEndLines(c);

  if (raw !== "") {
    const fmNode: FrontmatterNode = {
      type: "frontmatter",
      data: meta,
      raw,
      pos: { line: 1, column: 1 },
      endLine: fmEnd,
    };
    children.unshift(fmNode);
  }

  attachChapterAliases(children, meta, options.filename);

  return {
    type: "document",
    pos: { line: 1, column: 1 },
    endLine: Math.max(1, lines.length - (normalized.endsWith("\n") ? 1 : 0)),
    meta: { ...(options.filename ? { filename: options.filename } : {}), ...meta },
    children,
  };
}

function attachChapterAliases(
  children: Node[],
  meta: Record<string, unknown>,
  filename: string | undefined,
): void {
  const root = children.find((n): n is SectionNode => n.type === "section" && n.level === 1);
  if (!root) return;

  const aliases = new Set<string>(root.aliases ?? []);

  if (filename) {
    const base = filename.replace(/\\/g, "/").split("/").pop() ?? filename;
    const stem = base.replace(/\.noma$/i, "").replace(/^\d+[-_]/, "");
    const slug = slugify(stem);
    if (slug && slug !== root.id) aliases.add(slug);
  }

  const fmAliases = meta.aliases;
  if (Array.isArray(fmAliases)) {
    for (const a of fmAliases) {
      if (typeof a === "string" && a.trim()) aliases.add(a.trim());
    }
  }

  if (aliases.size > 0) root.aliases = [...aliases];
}

function extractFrontmatter(lines: string[]): {
  meta: Record<string, unknown>;
  raw: string;
  startLine: number;
  endLine: number;
} {
  const none = { meta: {}, raw: "", startLine: 0, endLine: 0 };
  if (lines.length === 0 || !FRONTMATTER_RE.test(lines[0] ?? "")) return none;
  for (let i = 1; i < lines.length; i++) {
    if (!FRONTMATTER_RE.test(lines[i] ?? "")) continue;
    const raw = lines.slice(1, i).join("\n");
    const block = { raw, startLine: i + 1, endLine: i + 1 };
    const result = loadFrontmatterYaml(raw);
    if (result.ok) {
      const parsed = result.value;
      // Blank frontmatter is still frontmatter; comment-only "YAML" between
      // two rules is far more likely a `# heading` framed by thematic breaks.
      if (parsed === null || parsed === undefined) return raw.trim() === "" ? { meta: {}, ...block } : none;
      if (typeof parsed === "object" && !Array.isArray(parsed)) {
        return { meta: parsed as Record<string, unknown>, ...block };
      }
      return none;
    }
    // Broken YAML that still looks like `key: value` lines is an authoring
    // mistake in real frontmatter: keep it (the validator reports
    // `invalid-frontmatter`). Anything else is a thematic break plus prose.
    return looksLikeYamlMapping(raw) ? { meta: {}, ...block } : none;
  }
  return none;
}

/**
 * Loads frontmatter YAML without throwing. Exposed so the validator can
 * report the exact YAML error for a frontmatter block the parser kept.
 */
export function loadFrontmatterYaml(raw: string): { ok: true; value: unknown } | { ok: false; error: string } {
  try {
    return { ok: true, value: yaml.load(raw) };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { ok: false, error: message.split("\n")[0] ?? message };
  }
}

function looksLikeYamlMapping(raw: string): boolean {
  const first = raw.split("\n").find((line) => line.trim() !== "" && !line.trim().startsWith("#"));
  return first !== undefined && /^[\w"'][\w\s"'.-]*:(?:\s|$)/.test(first);
}

function splitIdList(raw: string | undefined): string[] | undefined {
  if (!raw) return undefined;
  const list = raw.split(/[,\s]+/).map((part) => part.trim()).filter(Boolean);
  return list.length > 0 ? list : undefined;
}

function applyPendingId<T extends Node>(
  node: T,
  pending: { id?: string; cols?: string[]; rows?: string[] },
): T {
  const pendingId = pending.id;
  const cols = pending.cols;
  const rows = pending.rows;
  pending.id = undefined;
  pending.cols = undefined;
  pending.rows = undefined;
  if (pendingId) {
    if (!node.id) node.id = pendingId;
    else if (node.id !== pendingId) {
      const aliases = new Set(node.aliases ?? []);
      aliases.add(pendingId);
      node.aliases = [...aliases];
    }
    if (node.type === "directive" && node.attrs.id === undefined) {
      node.attrs = { ...node.attrs, id: pendingId };
    }
  }
  if (node.type === "table") {
    if (cols) node.columnIds = cols;
    if (rows) node.rowIds = rows;
  }
  return node;
}

function parseBlocks(
  lines: string[],
  from: number,
  to: number,
  parentColons: number,
): Node[] {
  const out: Node[] = [];
  let i = from;
  const pending: { id?: string; cols?: string[]; rows?: string[] } = {};

  while (i < to) {
    const line = lines[i] ?? "";

    if (line.trim() === "") {
      i++;
      continue;
    }

    const stableId = matchOnce(STABLE_ID_LINE_RE, line);
    if (stableId) {
      pending.id = stableId[1];
      const extra = stableId[2]?.trim();
      if (extra) {
        const attrs = parseAttrs(`{${extra}}`);
        pending.cols = splitIdList(typeof attrs.cols === "string" ? attrs.cols : undefined);
        pending.rows = splitIdList(typeof attrs.rows === "string" ? attrs.rows : undefined);
      }
      i++;
      continue;
    }

    const directiveOpen = matchOnce(DIRECTIVE_OPEN_RE, line);
    if (directiveOpen) {
      const colons = directiveOpen[1]!.length;
      if (colons > MAX_FENCE_COLONS) {
        out.push(paragraph(line, i));
        i++;
        continue;
      }
      if (colons > parentColons || parentColons === 0) {
        const result = parseDirective(lines, i, to, colons);
        out.push(applyPendingId(result.node, pending));
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
      const split = splitHeadingAttrs(heading[2]!);
      const title = split.title;
      const headingAttrs = split.attrs ?? {};
      const explicitId =
        typeof headingAttrs.id === "string" && headingAttrs.id !== "" ? headingAttrs.id : undefined;
      const section: SectionNode & { _idIsExplicit?: boolean } = {
        type: "section",
        id: explicitId ?? headingSlug(title),
        level,
        title,
        children: [],
        pos: { line: i + 1, column: 1 },
      };
      if (!explicitId) section._idIsExplicit = false;
      else section._idIsExplicit = true;
      const aliasesAttr = headingAttrs.aliases;
      if (typeof aliasesAttr === "string") {
        const list = aliasesAttr
          .split(/[,\s]+/)
          .map((a) => a.trim())
          .filter(Boolean);
        if (list.length > 0) section.aliases = list;
      }
      out.push(applyPendingId(section, pending));
      i++;
      continue;
    }

    const fence = matchCodeFenceOpen(line);
    if (fence) {
      const start = i + 1;
      const end = findCodeFenceClose(lines, start, to, fence);
      const content = lines.slice(start, end).join("\n");
      const closed = end < to;
      out.push(
        applyPendingId(
          {
            type: "code",
            lang: fence.lang,
            content,
            pos: { line: i + 1, column: 1 },
            endLine: closed ? end + 1 : end,
          } satisfies CodeNode,
          pending,
        ),
      );
      i = closed ? end + 1 : end;
      continue;
    }

    if (
      TABLE_ROW_RE.test(line) &&
      i + 1 < to &&
      TABLE_SEPARATOR_RE.test(lines[i + 1] ?? "")
    ) {
      const result = parseTable(lines, i, to);
      if (result) {
        result.node.endLine = result.next;
        out.push(applyPendingId(result.node, pending));
        i = result.next;
        continue;
      }
    }

    if (THEMATIC_BREAK_RE.test(line)) {
      out.push(
        applyPendingId(
          {
            type: "thematic_break",
            pos: { line: i + 1, column: 1 },
            endLine: i + 1,
          } satisfies ThematicBreakNode,
          pending,
        ),
      );
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
      out.push(
        applyPendingId(
          {
            type: "quote",
            content: buf.join("\n"),
            pos: { line: startLine + 1, column: 1 },
            endLine: i,
          } satisfies QuoteNode,
          pending,
        ),
      );
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
        const parsedItem = parseListItemIdentity(m[2] ?? "");
        items.push({
          type: "list_item",
          content: parsedItem.content,
          ...(parsedItem.id ? { id: parsedItem.id } : {}),
          pos: { line: i + 1, column: 1 },
          endLine: i + 1,
        });
        i++;
      }
      out.push(
        applyPendingId(
          {
            type: "list",
            ordered,
            items,
            pos: { line: startLine + 1, column: 1 },
            endLine: i,
          } satisfies ListNode,
          pending,
        ),
      );
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
        matchCodeFenceOpen(cur) !== null ||
        DIRECTIVE_OPEN_RE.test(cur) ||
        DIRECTIVE_CLOSE_RE.test(cur) ||
        STABLE_ID_LINE_RE.test(cur) ||
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
    if (buf.length > 0) out.push(applyPendingId(paragraph(buf.join("\n"), startLine, i), pending));
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
    const fence = matchCodeFenceOpen(lines[j] ?? "");
    if (fence) {
      j = findCodeFenceClose(lines, j + 1, to, fence);
      continue;
    }
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
    endLine: close === -1 ? to : close + 1,
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
  const rawHeader = splitRow(headerLine);
  const sepCells = splitRow(sepLine);
  if (sepCells.length !== rawHeader.length) return null;

  const parsedHeader = rawHeader.map(parseInlineStableId);
  const header = parsedHeader.map((cell) => cell.content);
  const headerIds = parsedHeader.map((cell) => cell.id ?? "");

  const align: TableAlign[] = sepCells.map((c) => {
    const left = c.startsWith(":");
    const right = c.endsWith(":");
    if (left && right) return "center";
    if (right) return "right";
    if (left) return "left";
    return null;
  });

  const rows: string[][] = [];
  const cellIds: string[][] = [];
  let j = i + 2;
  while (j < to && TABLE_ROW_RE.test(lines[j] ?? "")) {
    const cells = splitRow(lines[j] ?? "");
    while (cells.length < header.length) cells.push("");
    if (cells.length > header.length) cells.length = header.length;
    const parsed = cells.map(parseInlineStableId);
    rows.push(parsed.map((cell) => cell.content));
    cellIds.push(parsed.map((cell) => cell.id ?? ""));
    j++;
  }

  const node: TableNode = {
    type: "table",
    header,
    align,
    rows,
    pos: { line: i + 1, column: 1 },
  };
  if (headerIds.some(Boolean)) node.headerIds = headerIds;
  if (cellIds.some((row) => row.some(Boolean))) node.cellIds = cellIds;

  return { node, next: j };
}

/**
 * An opening code fence: three or more backticks (the info string may not
 * contain backticks) or three or more tildes. `lang` is the first word of the
 * info string, so ```` ```c++ ```` and ```` ```js title="x" ```` both fence.
 */
export interface CodeFence {
  char: "`" | "~";
  length: number;
  lang?: string;
}

export function matchCodeFenceOpen(line: string): CodeFence | null {
  const m = FENCE_OPEN_RE.exec(line);
  if (!m) return null;
  const marker = m[1] ?? m[3] ?? "";
  const lang = (m[2] ?? m[4] ?? "").trim().split(/\s+/)[0];
  return { char: marker[0] === "~" ? "~" : "`", length: marker.length, ...(lang ? { lang } : {}) };
}

/** A closing fence uses the opener's character, is at least as long, and carries no info string. */
export function isCodeFenceClose(line: string, open: CodeFence): boolean {
  const m = /^(`{3,}|~{3,})\s*$/.exec(line);
  return m !== null && m[1]![0] === open.char && m[1]!.length >= open.length;
}

/** Index of the closing fence line in `[from, to)`, or `to` when the fence is unclosed. */
export function findCodeFenceClose(lines: string[], from: number, to: number, open: CodeFence): number {
  let j = from;
  while (j < to && !isCodeFenceClose(lines[j] ?? "", open)) j++;
  return j;
}

const ATTR_KEY_RE = /^[a-zA-Z_][\w-]*/;

/** Attribute names accepted by the attribute grammar (`key`, `data-x`, `_y`). */
export const ATTR_NAME_RE = /^[a-zA-Z_][\w-]*$/;

interface AttrToken {
  key: string;
  value?: string;
  quoted: boolean;
}

/**
 * Tokenises an attribute list body (without braces). Double-quoted values
 * accept `\"` and `\\` escapes; every other backslash is literal. Single-
 * quoted values are raw. In lenient mode stray characters are skipped (the
 * parser is forgiving); in strict mode they make the whole list invalid.
 */
function tokenizeAttrs(inner: string, strict: boolean): AttrToken[] | null {
  const tokens: AttrToken[] = [];
  let i = 0;
  const atBoundary = (at: number) => at >= inner.length || /\s/.test(inner[at]!);
  while (i < inner.length) {
    if (/\s/.test(inner[i]!)) {
      i++;
      continue;
    }
    const keyMatch = ATTR_KEY_RE.exec(inner.slice(i));
    if (!keyMatch) {
      if (strict) return null;
      i++;
      continue;
    }
    const key = keyMatch[0];
    i += key.length;
    if (inner[i] !== "=") {
      if (strict && !atBoundary(i)) return null;
      tokens.push({ key, quoted: false });
      continue;
    }
    const valueStart = i + 1;
    const quote = inner[valueStart];
    if (quote === '"' || quote === "'") {
      const scanned = scanQuoted(inner, valueStart + 1, quote);
      if (scanned) {
        if (strict && !atBoundary(scanned.next)) return null;
        tokens.push({ key, value: scanned.value, quoted: true });
        i = scanned.next;
        continue;
      }
    }
    const bare = /^\S+/.exec(inner.slice(valueStart));
    if (!bare) {
      if (strict) return null;
      tokens.push({ key, quoted: false });
      continue;
    }
    tokens.push({ key, value: bare[0], quoted: false });
    i = valueStart + bare[0].length;
  }
  return tokens;
}

function scanQuoted(s: string, from: number, quote: string): { value: string; next: number } | null {
  let value = "";
  for (let j = from; j < s.length; j++) {
    const c = s[j]!;
    if (c === quote) return { value, next: j + 1 };
    if (quote === '"' && c === "\\" && (s[j + 1] === '"' || s[j + 1] === "\\")) {
      value += s[j + 1];
      j++;
      continue;
    }
    value += c;
  }
  return null;
}

function tokensToAttrs(tokens: AttrToken[]): Attrs {
  const attrs: Attrs = {};
  for (const t of tokens) {
    if (t.value === undefined) attrs[t.key] = true;
    else if (t.quoted || t.key === "id") attrs[t.key] = t.value;
    else attrs[t.key] = coerce(t.value);
  }
  return attrs;
}

/**
 * Parses a `{...}` attribute list. Only unquoted barewords are coerced
 * (`n=3`, `x=0.82`, `on=true`); quoted values are always strings, and `id`
 * is never coerced because IDs are strings.
 */
export function parseAttrs(raw: string): Attrs {
  if (!raw) return {};
  const inner = raw.replace(/^\{/, "").replace(/\}$/, "").trim();
  if (!inner) return {};
  return tokensToAttrs(tokenizeAttrs(inner, false) ?? []);
}

/**
 * Splits a heading's text into title and trailing `{...}` attributes. The
 * braces count as attributes only when they tokenise cleanly and contain at
 * least one `key=value` pair, so `# Set {a, b}` keeps its braces.
 */
export function splitHeadingAttrs(text: string): { title: string; attrs?: Attrs; rawAttrs?: string } {
  const trimmed = text.trim();
  const m = HEADING_ATTRS_RE.exec(trimmed);
  if (!m) return { title: trimmed };
  const tokens = tokenizeAttrs(m[2]!, true);
  if (!tokens || !tokens.some((t) => t.value !== undefined)) return { title: trimmed };
  return { title: m[1]!.trim(), attrs: tokensToAttrs(tokens), rawAttrs: m[2]! };
}

/**
 * Serialises one attribute so `parseAttrs` reads back the same value:
 * numbers and booleans bare, strings quoted. A string with `"` but no `'`
 * uses single quotes; otherwise double quotes, escaping `"` as `\"` and any
 * backslash that would otherwise be read as an escape as `\\`.
 */
export function serializeAttr(key: string, value: AttrValue): string {
  if (value === true) return key;
  if (value === false) return `${key}=false`;
  if (typeof value === "number") return `${key}=${value}`;
  const s = String(value);
  if (s.includes('"') && !s.includes("'")) return `${key}='${s}'`;
  return `${key}="${escapeAttrValue(s)}"`;
}

function escapeAttrValue(s: string): string {
  return s.replace(/\\(?=[\\"]|$)/g, "\\\\").replace(/"/g, '\\"');
}

function coerce(v: string): AttrValue {
  if (v === "true") return true;
  if (v === "false") return false;
  if (/^-?\d+$/.test(v)) return Number(v);
  if (/^-?\d+\.\d+$/.test(v)) return Number(v);
  return v;
}

function paragraph(content: string, line: number, endIdx?: number): ParagraphNode {
  const lineCount = content.split("\n").length;
  return {
    type: "paragraph",
    content: content.replace(/\n+$/, ""),
    pos: { line: line + 1, column: 1 },
    endLine: endIdx !== undefined ? endIdx : line + lineCount,
  };
}

function computeSectionEndLines(node: Node): number {
  if (node.type === "section") {
    let end = node.pos?.line ?? 0;
    for (const c of node.children) {
      const ce = computeSectionEndLines(c);
      if (ce > end) end = ce;
    }
    node.endLine = end;
    return end;
  }
  if (node.type === "directive") {
    for (const c of node.children) computeSectionEndLines(c);
  }
  return node.endLine ?? node.pos?.line ?? 0;
}

function foldSections(nodes: Node[]): Node[] {
  const root: Node[] = [];
  const stack: SectionNode[] = [];
  const seenSlugSections = new Set<string>();

  const push = (node: Node) => {
    const parent = stack[stack.length - 1];
    if (parent) parent.children.push(node);
    else root.push(node);
  };

  for (const node of nodes) {
    if (node.type === "section") {
      const section = node as SectionNode & { _idIsExplicit?: boolean };
      const isExplicit = section._idIsExplicit === true;

      if (!isExplicit) {
        const slug = section.id!;
        if (seenSlugSections.has(slug)) {
          let n = 2;
          while (seenSlugSections.has(`${slug}-${n}`)) n++;
          section.id = `${slug}-${n}`;
          seenSlugSections.add(section.id);
        } else {
          seenSlugSections.add(slug);
        }
      }

      while (stack.length > 0 && stack[stack.length - 1]!.level >= section.level) {
        stack.pop();
      }
      push(node);
      stack.push(section);
      delete section._idIsExplicit;
      continue;
    }
    push(node);
  }

  return root;
}

/**
 * Deterministic heading slug. Letters and numbers of any script are kept and
 * lowercased; whitespace becomes `-`. Latin letters are folded to ASCII by
 * dropping diacritics, and Latin letters with no ASCII decomposition (`ß`,
 * `ø`) are dropped as before, so existing Latin-script slugs never change.
 */
export function slugify(input: string): string {
  return input
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .normalize("NFC")
    .replace(/\p{Script=Inherited}/gu, "")
    .replace(/[^\p{L}\p{N}\p{M}\s-]/gu, "")
    .replace(/\p{Script=Latin}/gu, (ch) => (ch >= "a" && ch <= "z" ? ch : ""))
    .trim()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");
}

/** The auto ID for a heading title: its slug, or `section` when the slug is empty. */
export function headingSlug(title: string): string {
  return slugify(title) || "section";
}
