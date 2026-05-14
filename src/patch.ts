import type {
  AttrValue,
  DocumentNode,
  Node,
  ParagraphNode,
} from "./ast.js";
import { isDirective } from "./ast.js";
import { parse, slugify } from "./parser.js";

/**
 * Block-level patch operations. Mutate a document by ID rather than rewriting
 * source. Each op returns a new document; the input is not mutated.
 *
 * See docs/agent-protocol.noma for the public schema.
 */
export type PatchOp =
  | { op: "replace_block"; id: string; content: string }
  | { op: "replace_body"; id: string; content: string }
  | { op: "update_heading"; id: string; title: string }
  | {
      op: "add_block";
      parent: string;
      content: string;
      /** 0-based insertion index in parent.children. Defaults to end. */
      position?: number;
    }
  | { op: "delete_block"; id: string }
  | { op: "update_attribute"; id: string; key: string; value: AttrValue }
  | { op: "rename_id"; from: string; to: string };

export type PatchErrorCode =
  | "target_missing"
  | "parent_missing"
  | "id_conflict"
  | "invalid_content"
  | "id_attribute_protected"
  | "sha_mismatch"
  | "pre_validation_blocked"
  | "op_list_aborted"
  | "unsupported_op";

export class PatchError extends Error {
  constructor(
    public readonly code: PatchErrorCode,
    message: string,
    public readonly op: PatchOp,
  ) {
    super(message);
    this.name = "PatchError";
  }
}

export function patch(doc: DocumentNode, op: PatchOp): DocumentNode {
  const next = clone(doc) as DocumentNode;
  apply(next, op);
  return next;
}

export function patchAll(doc: DocumentNode, ops: PatchOp[]): DocumentNode {
  let cur = doc;
  for (const op of ops) cur = patch(cur, op);
  return cur;
}

function apply(doc: DocumentNode, op: PatchOp): void {
  switch (op.op) {
    case "replace_block":
      return applyReplace(doc, op);
    case "replace_body":
      return applyReplaceBody(doc, op);
    case "update_heading":
      return applyUpdateHeading(doc, op);
    case "add_block":
      return applyAdd(doc, op);
    case "delete_block":
      return applyDelete(doc, op);
    case "update_attribute":
      return applyUpdateAttr(doc, op);
    case "rename_id":
      return applyRenameId(doc, op);
    default: {
      const _exhaustive: never = op;
      void _exhaustive;
      throw new Error(`unknown patch op`);
    }
  }
}

function applyReplaceBody(
  doc: DocumentNode,
  op: Extract<PatchOp, { op: "replace_body" }>,
): void {
  const node = findById(doc, op.id);
  if (!node) throw new PatchError("target_missing", `block "${op.id}" not found`, op);
  if (isDirective(node)) {
    if (!isBodyOnlyDirective(node)) {
      throw new PatchError("invalid_content", `block "${op.id}" has child blocks; use replace_block`, op);
    }
    node.body = op.content;
    node.children = op.content === "" ? [] : [bodyParagraph(op.content)];
    return;
  }
  if (
    node.type === "paragraph" ||
    node.type === "quote" ||
    node.type === "code" ||
    node.type === "list_item"
  ) {
    node.content = op.content;
    return;
  }
  throw new PatchError("invalid_content", `block "${op.id}" does not have replaceable body text`, op);
}

function applyUpdateHeading(
  doc: DocumentNode,
  op: Extract<PatchOp, { op: "update_heading" }>,
): void {
  const node = findById(doc, op.id);
  if (!node) throw new PatchError("target_missing", `block "${op.id}" not found`, op);
  if (node.type !== "section") {
    throw new PatchError("invalid_content", `block "${op.id}" is not a section heading`, op);
  }
  node.title = op.title;
}

function applyReplace(
  doc: DocumentNode,
  op: Extract<PatchOp, { op: "replace_block" }>,
): void {
  const parsed = parseFragment(op.content, op);
  const found = findParent(doc, op.id);
  if (!found) throw new PatchError("target_missing", `block "${op.id}" not found`, op);
  found.list[found.index] = parsed;
}

function applyAdd(
  doc: DocumentNode,
  op: Extract<PatchOp, { op: "add_block" }>,
): void {
  const parsed = parseFragment(op.content, op);
  const parent = findById(doc, op.parent);
  if (!parent) throw new PatchError("parent_missing", `parent "${op.parent}" not found`, op);
  if (!hasChildren(parent)) {
    throw new PatchError("parent_missing", `parent "${op.parent}" cannot have children`, op);
  }
  const arr = parent.children;
  const pos = op.position ?? arr.length;
  arr.splice(Math.max(0, Math.min(pos, arr.length)), 0, parsed);
}

function applyDelete(
  doc: DocumentNode,
  op: Extract<PatchOp, { op: "delete_block" }>,
): void {
  const found = findParent(doc, op.id);
  if (!found) throw new PatchError("target_missing", `block "${op.id}" not found`, op);
  found.list.splice(found.index, 1);
}

function applyUpdateAttr(
  doc: DocumentNode,
  op: Extract<PatchOp, { op: "update_attribute" }>,
): void {
  const node = findById(doc, op.id);
  if (!node) throw new PatchError("target_missing", `block "${op.id}" not found`, op);
  if (!isDirective(node)) {
    throw new PatchError("target_missing", `block "${op.id}" is not a directive`, op);
  }
  if (op.key === "id") {
    throw new PatchError("id_attribute_protected", `use rename_id to change a block's id`, op);
  }
  node.attrs[op.key] = op.value;
}

function applyRenameId(
  doc: DocumentNode,
  op: Extract<PatchOp, { op: "rename_id" }>,
): void {
  const node = findById(doc, op.from);
  if (!node) throw new PatchError("target_missing", `block "${op.from}" not found`, op);
  if (findById(doc, op.to)) {
    throw new PatchError("id_conflict", `target id "${op.to}" already exists`, op);
  }
  node.id = op.to;
  if (isDirective(node) && "id" in node.attrs) {
    node.attrs.id = op.to;
  }
  retargetReferences(doc, op.from, op.to);
}

function retargetReferences(node: Node, from: string, to: string): void {
  if (isDirective(node)) {
    for (const key of Object.keys(node.attrs)) {
      if (node.attrs[key] === from) node.attrs[key] = to;
    }
  }
  if (node.type === "paragraph") {
    node.content = rewriteWikilinks((node as ParagraphNode).content, from, to);
  }
  if (node.type === "section") {
    node.title = rewriteWikilinks(node.title, from, to);
  }
  for (const child of childArray(node)) retargetReferences(child, from, to);
}

function rewriteWikilinks(text: string, from: string, to: string): string {
  return text.replace(/\[\[([a-zA-Z_][\w\-./:]*)\]\]/g, (m, id) =>
    id === from ? `[[${to}]]` : m,
  );
}

interface ParentRef {
  list: Node[];
  index: number;
}

function findParent(node: Node, id: string, parent?: ParentRef): ParentRef | null {
  if (node.id === id && parent) return parent;
  for (const arr of childArrays(node)) {
    for (let i = 0; i < arr.list.length; i++) {
      const child = arr.list[i]!;
      const found = findParent(child, id, { list: arr.list, index: i });
      if (found) return found;
    }
  }
  return null;
}

export function findById(node: Node, id: string): Node | null {
  if (node.id === id) return node;
  for (const arr of childArrays(node)) {
    for (const child of arr.list) {
      const found = findById(child, id);
      if (found) return found;
    }
  }
  return null;
}

function childArrays(
  node: Node,
): Array<{ key: "children" | "items"; list: Node[] }> {
  if (
    node.type === "document" ||
    node.type === "section" ||
    node.type === "directive"
  ) {
    return [{ key: "children", list: node.children }];
  }
  if (node.type === "list") {
    return [{ key: "items", list: node.items }];
  }
  return [];
}

function childArray(node: Node): Node[] {
  for (const a of childArrays(node)) return a.list;
  return [];
}

function hasChildren(node: Node): node is Node & { children: Node[] } {
  return (
    node.type === "document" ||
    node.type === "section" ||
    node.type === "directive"
  );
}

function isBodyOnlyDirective(node: Node): boolean {
  return (
    isDirective(node) &&
    (node.children.length === 0 ||
      (node.children.length === 1 &&
        node.children[0]?.type === "paragraph" &&
        node.body !== undefined))
  );
}

function bodyParagraph(content: string): ParagraphNode {
  return { type: "paragraph", content };
}

function parseFragment(content: string, op: PatchOp): Node {
  const doc = parse(content);
  if (doc.children.length === 0) {
    throw new PatchError("invalid_content", `fragment parsed to no blocks`, op);
  }
  if (doc.children.length > 1) {
    throw new PatchError(
      "invalid_content",
      `fragment must contain exactly one top-level block (got ${doc.children.length})`,
      op,
    );
  }
  const node = doc.children[0]!;
  if (!isDirective(node)) {
    throw new PatchError("invalid_content", `fragment must be a directive block (got ${node.type})`, op);
  }
  return node;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}

/**
 * Apply patch ops directly to source text. Unlike `patch(doc, op)` (which
 * round-trips through the AST renderer and reformats the entire file), this
 * preserves every byte outside the targeted block — frontmatter quoting,
 * sibling blocks, comments, blank-line padding, attr ordering on unchanged
 * lines.
 *
 * Each op:
 *   - re-parses the *current* source so line numbers stay accurate after
 *     prior ops in the sequence,
 *   - locates the target by ID,
 *   - rewrites only the affected line range.
 */
export function patchSource(source: string, ops: PatchOp | PatchOp[]): string {
  const list = Array.isArray(ops) ? ops : [ops];
  let cur = source;
  for (const op of list) cur = applyToSource(cur, op);
  return cur;
}

function applyToSource(source: string, op: PatchOp): string {
  switch (op.op) {
    case "update_attribute":
      return applySrcUpdateAttr(source, op);
    case "replace_block":
      return applySrcReplace(source, op);
    case "replace_body":
      return applySrcReplaceBody(source, op);
    case "update_heading":
      return applySrcUpdateHeading(source, op);
    case "delete_block":
      return applySrcDelete(source, op);
    case "add_block":
      return applySrcAdd(source, op);
    case "rename_id":
      return applySrcRenameId(source, op);
    default: {
      const _exhaustive: never = op;
      void _exhaustive;
      throw new Error("unknown patch op");
    }
  }
}

function locate(source: string, id: string, op: PatchOp): { node: Node; start: number; end: number } {
  const doc = parse(source);
  const node = findById(doc, id);
  if (!node) throw new PatchError("target_missing", `block "${id}" not found`, op);
  const start = node.pos?.line;
  const end = node.endLine;
  if (!start || !end) {
    throw new Error(`block "${id}" has no source span`);
  }
  return { node, start, end };
}

function applySrcReplaceBody(
  source: string,
  op: Extract<PatchOp, { op: "replace_body" }>,
): string {
  const { node, start, end } = locate(source, op.id, op);
  const lines = source.split("\n");
  const bodyLines = op.content.replace(/\n+$/, "").split("\n");
  if (isDirective(node)) {
    if (!isBodyOnlyDirective(node)) {
      throw new PatchError("invalid_content", `block "${op.id}" has child blocks; use replace_block`, op);
    }
    lines.splice(start, Math.max(0, end - start - 1), ...bodyLines);
    return lines.join("\n");
  }
  if (node.type === "paragraph") {
    lines.splice(start - 1, end - start + 1, ...bodyLines);
    return lines.join("\n");
  }
  if (node.type === "quote") {
    const quoted = bodyLines.map((line) => (line ? `> ${line}` : ">"));
    lines.splice(start - 1, end - start + 1, ...quoted);
    return lines.join("\n");
  }
  if (node.type === "code") {
    lines.splice(start, Math.max(0, end - start - 1), ...bodyLines);
    return lines.join("\n");
  }
  if (node.type === "list_item") {
    const marker = (lines[start - 1] ?? "").match(/^(\s*(?:[-*+]|\d+[.)])\s+)/)?.[1] ?? "- ";
    lines[start - 1] = `${marker}${op.content.replace(/\n/g, " ")}`;
    return lines.join("\n");
  }
  throw new PatchError("invalid_content", `block "${op.id}" does not have replaceable body text`, op);
}

function applySrcUpdateHeading(
  source: string,
  op: Extract<PatchOp, { op: "update_heading" }>,
): string {
  const { node, start } = locate(source, op.id, op);
  if (node.type !== "section") {
    throw new PatchError("invalid_content", `block "${op.id}" is not a section heading`, op);
  }
  const lines = source.split("\n");
  lines[start - 1] = rewriteHeadingTitle(lines[start - 1] ?? "", op.title, node.id);
  return lines.join("\n");
}

function applySrcUpdateAttr(
  source: string,
  op: Extract<PatchOp, { op: "update_attribute" }>,
): string {
  if (op.key === "id") {
    throw new PatchError("id_attribute_protected", `use rename_id to change a block's id`, op);
  }
  const { node, start } = locate(source, op.id, op);
  if (!isDirective(node)) {
    throw new PatchError("target_missing", `block "${op.id}" is not a directive`, op);
  }
  const lines = source.split("\n");
  const lineIdx = start - 1;
  const open = lines[lineIdx] ?? "";
  lines[lineIdx] = rewriteOpenLineAttr(open, op.key, op.value, op);
  return lines.join("\n");
}

function applySrcReplace(
  source: string,
  op: Extract<PatchOp, { op: "replace_block" }>,
): string {
  parseFragment(op.content, op);
  const { start, end } = locate(source, op.id, op);
  const lines = source.split("\n");
  const replacement = op.content.replace(/\n+$/, "").split("\n");
  lines.splice(start - 1, end - start + 1, ...replacement);
  return lines.join("\n");
}

function applySrcDelete(
  source: string,
  op: Extract<PatchOp, { op: "delete_block" }>,
): string {
  const { start, end } = locate(source, op.id, op);
  const lines = source.split("\n");
  let removeCount = end - start + 1;
  // Collapse a single trailing blank line so we don't grow whitespace.
  if (lines[start - 1 + removeCount] === "" && lines[start - 2] === "") {
    removeCount += 1;
  }
  lines.splice(start - 1, removeCount);
  return lines.join("\n");
}

function applySrcAdd(
  source: string,
  op: Extract<PatchOp, { op: "add_block" }>,
): string {
  parseFragment(op.content, op);
  const doc = parse(source);
  const parent = findById(doc, op.parent);
  if (!parent) throw new PatchError("parent_missing", `parent "${op.parent}" not found`, op);
  if (!hasChildren(parent)) {
    throw new PatchError("parent_missing", `parent "${op.parent}" cannot have children`, op);
  }
  const children = parent.children;
  const pos = Math.max(0, Math.min(op.position ?? children.length, children.length));
  const lines = source.split("\n");
  const fragmentLines = op.content.replace(/\n+$/, "").split("\n");

  let insertAt: number;
  if (pos < children.length) {
    const next = children[pos]!;
    const nextStart = next.pos?.line;
    if (!nextStart) throw new Error(`sibling has no source span`);
    insertAt = nextStart - 1;
    fragmentLines.push("");
  } else if (children.length > 0) {
    const last = children[children.length - 1]!;
    const lastEnd = last.endLine;
    if (!lastEnd) throw new Error(`sibling has no source span`);
    insertAt = lastEnd;
    fragmentLines.unshift("");
  } else {
    // Empty parent — insert just inside.
    if (parent.type === "directive" && parent.endLine) {
      insertAt = parent.endLine - 1;
    } else if (parent.type === "section" && parent.endLine) {
      insertAt = parent.endLine;
    } else {
      insertAt = lines.length;
    }
  }
  lines.splice(insertAt, 0, ...fragmentLines);
  return lines.join("\n");
}

function applySrcRenameId(
  source: string,
  op: Extract<PatchOp, { op: "rename_id" }>,
): string {
  const doc = parse(source);
  const node = findById(doc, op.from);
  if (!node) throw new PatchError("target_missing", `block "${op.from}" not found`, op);
  if (findById(doc, op.to)) {
    throw new PatchError("id_conflict", `target id "${op.to}" already exists`, op);
  }
  const lines = source.split("\n");
  const startLine = node.pos?.line;
  if (!startLine) throw new Error(`block has no source span`);
  const lineIdx = startLine - 1;
  const open = lines[lineIdx] ?? "";

  if (isDirective(node)) {
    lines[lineIdx] = rewriteOpenLineAttr(open, "id", op.to, op);
  } else if (node.type === "section") {
    // Heading line: rewrite trailing {id="..."} block.
    lines[lineIdx] = rewriteHeadingId(open, op.to);
  }

  let result = lines.join("\n");
  result = rewriteWikilinksInSource(result, op.from, op.to);
  result = rewriteAttrReferences(result, op.from, op.to);
  return result;
}

const REF_ATTRS = new Set(["for", "parent", "dataset", "block", "ref"]);

function rewriteAttrReferences(source: string, from: string, to: string): string {
  // Rewrite key="from", key='from', or key=from (bareword) inside any
  // directive open line. Line-by-line so identical strings in prose stay put.
  const escFrom = escapeRegex(from);
  return source
    .split("\n")
    .map((line) => {
      if (!/^:{2,}\w/.test(line.trim())) return line;
      let out = line;
      for (const k of REF_ATTRS) {
        const quoted = new RegExp(`(\\b${k}=)("|')${escFrom}\\2`, "g");
        out = out.replace(quoted, `$1$2${to}$2`);
        const bare = new RegExp(`(\\b${k}=)${escFrom}(?=[\\s}])`, "g");
        out = out.replace(bare, `$1"${to}"`);
      }
      return out;
    })
    .join("\n");
}

function rewriteWikilinksInSource(source: string, from: string, to: string): string {
  return source.replace(
    new RegExp(`\\[\\[${escapeRegex(from)}\\]\\]`, "g"),
    `[[${to}]]`,
  );
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const ATTR_TOKEN_RE =
  /([a-zA-Z_][\w-]*)(?:=("([^"]*)"|'([^']*)'|([^\s}]+)))?/g;

function rewriteOpenLineAttr(
  line: string,
  key: string,
  value: AttrValue,
  op: PatchOp,
): string {
  const openMatch = line.match(/^(\s*:{2,}\s*[a-zA-Z_][\w-]*(?:::[a-zA-Z_][\w-]*)*)(\s*\{)?(.*?)(\}\s*)?$/);
  if (!openMatch) {
    throw new PatchError("invalid_content", `malformed open line for "${(op as { id?: string }).id}"`, op);
  }
  const head = openMatch[1] ?? "";
  const inner = openMatch[3] ?? "";
  const trailing = (line.match(/\s*$/) ?? [""])[0];
  const serialized = serializeOneAttr(key, value);

  let replaced = false;
  const rewrittenInner = inner.replace(ATTR_TOKEN_RE, (m, k) => {
    if (k !== key) return m;
    replaced = true;
    return value === false && typeof value === "boolean"
      ? `${key}=false`
      : serialized;
  });

  let next: string;
  if (replaced) {
    next = rewrittenInner;
  } else {
    const trimmed = inner.trim();
    next = trimmed ? `${trimmed} ${serialized}` : serialized;
  }
  return `${head}{${next.trim()}}${trailing}`.replace(/\s+$/, "") + (line.endsWith("\n") ? "\n" : "");
}

function rewriteHeadingId(line: string, newId: string): string {
  const m = line.match(/^(#+\s+.+?)(?:\s+\{([^}]*)\})?\s*$/);
  if (!m) return line;
  const head = m[1] ?? "";
  const attrsInner = (m[2] ?? "").trim();
  if (!attrsInner) return `${head} {id="${newId}"}`;
  let replaced = false;
  const updated = attrsInner.replace(ATTR_TOKEN_RE, (full, k) => {
    if (k !== "id") return full;
    replaced = true;
    return `id="${newId}"`;
  });
  if (!replaced) return `${head} {${attrsInner} id="${newId}"}`;
  return `${head} {${updated.trim()}}`;
}

function rewriteHeadingTitle(line: string, newTitle: string, stableId?: string): string {
  const m = line.match(/^(#+)(\s+)(.*?)(?:\s+\{([^}]*)\})?\s*$/);
  if (!m) return line;
  const hashes = m[1] ?? "#";
  const space = m[2] ?? " ";
  const attrsInner = (m[4] ?? "").trim();
  const needsExplicitId =
    stableId && stableId.length > 0 && slugify(newTitle) !== stableId;
  if (!attrsInner) {
    return needsExplicitId
      ? `${hashes}${space}${newTitle} {id="${stableId}"}`
      : `${hashes}${space}${newTitle}`;
  }
  let hasId = false;
  attrsInner.replace(ATTR_TOKEN_RE, (_full, k) => {
    if (k === "id") hasId = true;
    return _full;
  });
  const attrs = needsExplicitId && !hasId ? `${attrsInner} id="${stableId}"` : attrsInner;
  return `${hashes}${space}${newTitle} {${attrs.trim()}}`;
}

function serializeOneAttr(key: string, value: AttrValue): string {
  if (value === true) return key;
  if (value === false) return `${key}=false`;
  if (typeof value === "number") return `${key}=${value}`;
  const s = String(value);
  if (s.includes('"')) {
    if (s.includes("'")) return `${key}="${s.replace(/"/g, '\\"')}"`;
    return `${key}='${s}'`;
  }
  return `${key}="${s}"`;
}
