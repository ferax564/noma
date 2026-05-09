import type {
  AttrValue,
  DocumentNode,
  Node,
  ParagraphNode,
} from "./ast.js";
import { isDirective } from "./ast.js";
import { parse } from "./parser.js";

/**
 * Block-level patch operations. Mutate a document by ID rather than rewriting
 * source. Each op returns a new document; the input is not mutated.
 *
 * See docs/agent-protocol.noma for the public schema.
 */
export type PatchOp =
  | { op: "replace_block"; id: string; content: string }
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

export class PatchError extends Error {
  constructor(
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

function applyReplace(
  doc: DocumentNode,
  op: Extract<PatchOp, { op: "replace_block" }>,
): void {
  const parsed = parseFragment(op.content, op);
  const found = findParent(doc, op.id);
  if (!found) throw new PatchError(`block "${op.id}" not found`, op);
  found.list[found.index] = parsed;
}

function applyAdd(
  doc: DocumentNode,
  op: Extract<PatchOp, { op: "add_block" }>,
): void {
  const parsed = parseFragment(op.content, op);
  const parent = findById(doc, op.parent);
  if (!parent) throw new PatchError(`parent "${op.parent}" not found`, op);
  if (!hasChildren(parent)) {
    throw new PatchError(`parent "${op.parent}" cannot have children`, op);
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
  if (!found) throw new PatchError(`block "${op.id}" not found`, op);
  found.list.splice(found.index, 1);
}

function applyUpdateAttr(
  doc: DocumentNode,
  op: Extract<PatchOp, { op: "update_attribute" }>,
): void {
  const node = findById(doc, op.id);
  if (!node) throw new PatchError(`block "${op.id}" not found`, op);
  if (!isDirective(node)) {
    throw new PatchError(`block "${op.id}" is not a directive`, op);
  }
  if (op.key === "id") {
    throw new PatchError(`use rename_id to change a block's id`, op);
  }
  node.attrs[op.key] = op.value;
}

function applyRenameId(
  doc: DocumentNode,
  op: Extract<PatchOp, { op: "rename_id" }>,
): void {
  const node = findById(doc, op.from);
  if (!node) throw new PatchError(`block "${op.from}" not found`, op);
  if (findById(doc, op.to)) {
    throw new PatchError(`target id "${op.to}" already exists`, op);
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
  return text.replace(/\[\[([a-zA-Z_][\w-]*)\]\]/g, (m, id) =>
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

function parseFragment(content: string, op: PatchOp): Node {
  const doc = parse(content);
  if (doc.children.length === 0) {
    throw new PatchError(`fragment parsed to no blocks`, op);
  }
  if (doc.children.length > 1) {
    throw new PatchError(
      `fragment must contain exactly one top-level block (got ${doc.children.length})`,
      op,
    );
  }
  return doc.children[0]!;
}

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value));
}
