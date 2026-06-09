import type {
  AttrValue,
  DirectiveNode,
  DocumentNode,
  Node,
  ParagraphNode,
} from "./ast.js";
import { isDirective } from "./ast.js";
import { escapePipeTableCell, serializeDelimitedRow, splitDelimitedRow, splitPipeRow } from "./inline.js";
import { parse, slugify } from "./parser.js";
import yaml from "js-yaml";

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
  | { op: "add_comment"; id: string; target: string; content: string; author?: string; initials?: string; date?: string; reply_to?: string }
  | { op: "resolve_comment"; id: string; resolved_by?: string; resolved_at?: string }
  | { op: "add_footnote"; id: string; target: string; content: string; label?: string }
  | { op: "add_endnote"; id: string; target: string; content: string; label?: string }
  | {
      op: "add_change_request";
      id: string;
      target: string;
      action: "insert" | "delete" | "replace";
      from?: string;
      to?: string;
      text?: string;
      content?: string;
      author?: string;
      date?: string;
    }
  | { op: "update_table_cell"; id: string; row: number; column: number | string; value: string }
  | { op: "update_table_header_cell"; id: string; column: number | string; value: string }
  | { op: "insert_table_row"; id: string; row: number; cells: string[] }
  | { op: "delete_table_row"; id: string; row: number }
  | { op: "insert_table_column"; id: string; column: number; header?: string; cells: string[] }
  | { op: "delete_table_column"; id: string; column: number | string }
  | { op: "update_dataset_cell"; id: string; row: number; column: number | string; value: string }
  | { op: "insert_dataset_row"; id: string; row: number; cells: string[] }
  | { op: "delete_dataset_row"; id: string; row: number }
  | { op: "insert_dataset_column"; id: string; column: number; header: string; cells: string[] }
  | { op: "delete_dataset_column"; id: string; column: number | string }
  | { op: "move_block"; id: string; parent: string; position?: number }
  | {
      op: "add_block";
      parent: string;
      content: string;
      /** 0-based insertion index in parent.children. Defaults to end. */
      position?: number;
    }
  | { op: "delete_block"; id: string }
  | { op: "update_attribute"; id: string; key: string; value: AttrValue }
  | { op: "remove_attribute"; id: string; key: string }
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
    case "add_comment":
      return applyAddComment(doc, op);
    case "resolve_comment":
      return applyResolveComment(doc, op);
    case "add_footnote":
    case "add_endnote":
      return applyAddNote(doc, op);
    case "add_change_request":
      return applyAddChangeRequest(doc, op);
    case "update_table_cell":
      return applyUpdateTableCell(doc, op);
    case "update_table_header_cell":
      return applyUpdateTableHeaderCell(doc, op);
    case "insert_table_row":
      return applyInsertTableRow(doc, op);
    case "delete_table_row":
      return applyDeleteTableRow(doc, op);
    case "insert_table_column":
      return applyInsertTableColumn(doc, op);
    case "delete_table_column":
      return applyDeleteTableColumn(doc, op);
    case "update_dataset_cell":
      return applyUpdateDatasetCell(doc, op);
    case "insert_dataset_row":
      return applyInsertDatasetRow(doc, op);
    case "delete_dataset_row":
      return applyDeleteDatasetRow(doc, op);
    case "insert_dataset_column":
      return applyInsertDatasetColumn(doc, op);
    case "delete_dataset_column":
      return applyDeleteDatasetColumn(doc, op);
    case "move_block":
      return applyMove(doc, op);
    case "add_block":
      return applyAdd(doc, op);
    case "delete_block":
      return applyDelete(doc, op);
    case "update_attribute":
      return applyUpdateAttr(doc, op);
    case "remove_attribute":
      return applyRemoveAttr(doc, op);
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

function applyMove(
  doc: DocumentNode,
  op: Extract<PatchOp, { op: "move_block" }>,
): void {
  const found = findParent(doc, op.id);
  if (!found) throw new PatchError("target_missing", `block "${op.id}" not found`, op);
  const node = found.list[found.index]!;
  if (!isDirective(node)) {
    throw new PatchError("invalid_content", `block "${op.id}" is not a directive block`, op);
  }
  const parent = findById(doc, op.parent);
  if (!parent) throw new PatchError("parent_missing", `parent "${op.parent}" not found`, op);
  if (!hasChildren(parent)) {
    throw new PatchError("parent_missing", `parent "${op.parent}" cannot have children`, op);
  }
  if (containsId(node, op.parent)) {
    throw new PatchError("invalid_content", `cannot move "${op.id}" into itself or its descendants`, op);
  }
  found.list.splice(found.index, 1);
  const arr = parent.children;
  const pos = op.position ?? arr.length;
  arr.splice(Math.max(0, Math.min(pos, arr.length)), 0, node);
}

function applyAddComment(
  doc: DocumentNode,
  op: Extract<PatchOp, { op: "add_comment" }>,
): void {
  if (!op.content.trim()) {
    throw new PatchError("invalid_content", `comment content must not be empty`, op);
  }
  if (findById(doc, op.id)) {
    throw new PatchError("id_conflict", `target id "${op.id}" already exists`, op);
  }
  const target = findById(doc, op.target);
  if (!target) throw new PatchError("target_missing", `block "${op.target}" not found`, op);
  const comment = commentNode(op);
  if (target.type === "section") {
    target.children.splice(0, 0, comment);
    return;
  }
  const found = findParent(doc, op.target);
  if (!found) throw new PatchError("target_missing", `block "${op.target}" has no parent`, op);
  found.list.splice(found.index + 1, 0, comment);
}

function applyResolveComment(
  doc: DocumentNode,
  op: Extract<PatchOp, { op: "resolve_comment" }>,
): void {
  const node = findById(doc, op.id);
  if (!node) throw new PatchError("target_missing", `comment "${op.id}" not found`, op);
  if (!isCommentDirective(node)) {
    throw new PatchError("invalid_content", `block "${op.id}" is not a comment`, op);
  }
  markCommentResolved(node, op);
}

type AddNoteOp = Extract<PatchOp, { op: "add_footnote" | "add_endnote" }>;

function applyAddNote(
  doc: DocumentNode,
  op: AddNoteOp,
): void {
  validateNoteOp(op);
  if (findById(doc, op.id)) {
    throw new PatchError("id_conflict", `target id "${op.id}" already exists`, op);
  }
  const target = findById(doc, op.target);
  if (!target) throw new PatchError("target_missing", `block "${op.target}" not found`, op);
  const note = noteNode(op);
  if (target.type === "section") {
    target.children.splice(0, 0, note);
    return;
  }
  const found = findParent(doc, op.target);
  if (!found) throw new PatchError("target_missing", `block "${op.target}" has no parent`, op);
  found.list.splice(found.index + 1, 0, note);
}

function applyAddChangeRequest(
  doc: DocumentNode,
  op: Extract<PatchOp, { op: "add_change_request" }>,
): void {
  validateChangeRequestOp(op);
  if (findById(doc, op.id)) {
    throw new PatchError("id_conflict", `target id "${op.id}" already exists`, op);
  }
  const target = findById(doc, op.target);
  if (!target) throw new PatchError("target_missing", `block "${op.target}" not found`, op);
  const changeRequest = changeRequestNode(op);
  if (target.type === "section") {
    target.children.splice(0, 0, changeRequest);
    return;
  }
  const found = findParent(doc, op.target);
  if (!found) throw new PatchError("target_missing", `block "${op.target}" has no parent`, op);
  found.list.splice(found.index + 1, 0, changeRequest);
}

function applyUpdateTableCell(
  doc: DocumentNode,
  op: Extract<PatchOp, { op: "update_table_cell" }>,
): void {
  const node = findById(doc, op.id);
  if (!node) throw new PatchError("target_missing", `table "${op.id}" not found`, op);
  if (!isTableDirective(node)) {
    throw new PatchError("invalid_content", `block "${op.id}" is not a table directive`, op);
  }
  const table = parseTableDirectiveBody(node.body ?? "", node, op);
  updateTableRows(table, op);
  const body = serializeTableRows(table);
  node.body = body;
  node.children = body === "" ? [] : [bodyParagraph(body)];
}

function applyUpdateTableHeaderCell(
  doc: DocumentNode,
  op: Extract<PatchOp, { op: "update_table_header_cell" }>,
): void {
  const node = findById(doc, op.id);
  if (!node) throw new PatchError("target_missing", `table "${op.id}" not found`, op);
  if (!isTableDirective(node)) {
    throw new PatchError("invalid_content", `block "${op.id}" is not a table directive`, op);
  }
  const table = parseTableDirectiveBody(node.body ?? "", node, op);
  updateTableHeaderCell(table, op);
  const body = serializeTableRows(table);
  node.body = body;
  node.children = body === "" ? [] : [bodyParagraph(body)];
}

function applyInsertTableRow(
  doc: DocumentNode,
  op: Extract<PatchOp, { op: "insert_table_row" }>,
): void {
  const node = findById(doc, op.id);
  if (!node) throw new PatchError("target_missing", `table "${op.id}" not found`, op);
  if (!isTableDirective(node)) {
    throw new PatchError("invalid_content", `block "${op.id}" is not a table directive`, op);
  }
  const table = parseTableDirectiveBody(node.body ?? "", node, op);
  insertTableRow(table, op);
  const body = serializeTableRows(table);
  node.body = body;
  node.children = body === "" ? [] : [bodyParagraph(body)];
}

function applyDeleteTableRow(
  doc: DocumentNode,
  op: Extract<PatchOp, { op: "delete_table_row" }>,
): void {
  const node = findById(doc, op.id);
  if (!node) throw new PatchError("target_missing", `table "${op.id}" not found`, op);
  if (!isTableDirective(node)) {
    throw new PatchError("invalid_content", `block "${op.id}" is not a table directive`, op);
  }
  const table = parseTableDirectiveBody(node.body ?? "", node, op);
  deleteTableRow(table, op);
  const body = serializeTableRows(table);
  node.body = body;
  node.children = body === "" ? [] : [bodyParagraph(body)];
}

function applyInsertTableColumn(
  doc: DocumentNode,
  op: Extract<PatchOp, { op: "insert_table_column" }>,
): void {
  const node = findById(doc, op.id);
  if (!node) throw new PatchError("target_missing", `table "${op.id}" not found`, op);
  if (!isTableDirective(node)) {
    throw new PatchError("invalid_content", `block "${op.id}" is not a table directive`, op);
  }
  const table = parseTableDirectiveBody(node.body ?? "", node, op);
  insertTableColumn(table, op);
  const body = serializeTableRows(table);
  node.body = body;
  node.children = body === "" ? [] : [bodyParagraph(body)];
}

function applyDeleteTableColumn(
  doc: DocumentNode,
  op: Extract<PatchOp, { op: "delete_table_column" }>,
): void {
  const node = findById(doc, op.id);
  if (!node) throw new PatchError("target_missing", `table "${op.id}" not found`, op);
  if (!isTableDirective(node)) {
    throw new PatchError("invalid_content", `block "${op.id}" is not a table directive`, op);
  }
  const table = parseTableDirectiveBody(node.body ?? "", node, op);
  deleteTableColumn(table, op);
  const body = serializeTableRows(table);
  node.body = body;
  node.children = body === "" ? [] : [bodyParagraph(body)];
}

function applyUpdateDatasetCell(
  doc: DocumentNode,
  op: Extract<PatchOp, { op: "update_dataset_cell" }>,
): void {
  const node = findById(doc, op.id);
  if (!node) throw new PatchError("target_missing", `dataset "${op.id}" not found`, op);
  if (!isDatasetDirective(node)) {
    throw new PatchError("invalid_content", `block "${op.id}" is not a dataset directive`, op);
  }
  const body = updateDatasetBody(node, op);
  node.body = body;
  node.children = body === "" ? [] : [bodyParagraph(body)];
}

function applyInsertDatasetRow(
  doc: DocumentNode,
  op: Extract<PatchOp, { op: "insert_dataset_row" }>,
): void {
  const node = findById(doc, op.id);
  if (!node) throw new PatchError("target_missing", `dataset "${op.id}" not found`, op);
  if (!isDatasetDirective(node)) {
    throw new PatchError("invalid_content", `block "${op.id}" is not a dataset directive`, op);
  }
  const body = insertDatasetBody(node, op);
  node.body = body;
  node.children = body === "" ? [] : [bodyParagraph(body)];
}

function applyDeleteDatasetRow(
  doc: DocumentNode,
  op: Extract<PatchOp, { op: "delete_dataset_row" }>,
): void {
  const node = findById(doc, op.id);
  if (!node) throw new PatchError("target_missing", `dataset "${op.id}" not found`, op);
  if (!isDatasetDirective(node)) {
    throw new PatchError("invalid_content", `block "${op.id}" is not a dataset directive`, op);
  }
  const body = deleteDatasetBody(node, op);
  node.body = body;
  node.children = body === "" ? [] : [bodyParagraph(body)];
}

function applyInsertDatasetColumn(
  doc: DocumentNode,
  op: Extract<PatchOp, { op: "insert_dataset_column" }>,
): void {
  const node = findById(doc, op.id);
  if (!node) throw new PatchError("target_missing", `dataset "${op.id}" not found`, op);
  if (!isDatasetDirective(node)) {
    throw new PatchError("invalid_content", `block "${op.id}" is not a dataset directive`, op);
  }
  const body = insertDatasetColumnBody(node, op);
  node.body = body;
  node.children = body === "" ? [] : [bodyParagraph(body)];
}

function applyDeleteDatasetColumn(
  doc: DocumentNode,
  op: Extract<PatchOp, { op: "delete_dataset_column" }>,
): void {
  const node = findById(doc, op.id);
  if (!node) throw new PatchError("target_missing", `dataset "${op.id}" not found`, op);
  if (!isDatasetDirective(node)) {
    throw new PatchError("invalid_content", `block "${op.id}" is not a dataset directive`, op);
  }
  const body = deleteDatasetColumnBody(node, op);
  node.body = body;
  node.children = body === "" ? [] : [bodyParagraph(body)];
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

function applyRemoveAttr(
  doc: DocumentNode,
  op: Extract<PatchOp, { op: "remove_attribute" }>,
): void {
  const node = findById(doc, op.id);
  if (!node) throw new PatchError("target_missing", `block "${op.id}" not found`, op);
  if (!isDirective(node)) {
    throw new PatchError("target_missing", `block "${op.id}" is not a directive`, op);
  }
  if (op.key === "id") {
    throw new PatchError("id_attribute_protected", `use rename_id to change a block's id`, op);
  }
  delete node.attrs[op.key];
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
  return text.replace(/\[\[([^\]\n]+?)\]\]/g, (match, raw: string) => {
    const pipe = raw.indexOf("|");
    const target = (pipe === -1 ? raw : raw.slice(0, pipe)).trim();
    if (target !== from) return match;
    const label = pipe === -1 ? "" : raw.slice(pipe);
    return `[[${to}${label}]]`;
  });
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

function containsId(node: Node, id: string): boolean {
  return findById(node, id) !== null;
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

function commentNode(op: Extract<PatchOp, { op: "add_comment" }>): DirectiveNode {
  const attrs = commentAttrs(op);
  return {
    type: "directive",
    name: "comment",
    id: op.id,
    attrs,
    body: op.content,
    children: op.content === "" ? [] : [bodyParagraph(op.content)],
  };
}

function commentAttrs(op: Extract<PatchOp, { op: "add_comment" }>): Record<string, AttrValue> {
  return {
    id: op.id,
    ...(op.reply_to ? { reply_to: op.reply_to } : { parent: op.target }),
    ...(op.author ? { author: op.author } : {}),
    ...(op.initials ? { initials: op.initials } : {}),
    ...(op.date ? { date: op.date } : {}),
  };
}

function isCommentDirective(node: Node): node is DirectiveNode {
  return isDirective(node) && node.name === "comment";
}

function noteNode(op: AddNoteOp): DirectiveNode {
  const attrs = noteAttrs(op);
  const content = op.content.replace(/\n+$/, "");
  return {
    type: "directive",
    name: op.op === "add_footnote" ? "footnote" : "endnote",
    id: op.id,
    attrs,
    body: content,
    children: content === "" ? [] : [bodyParagraph(content)],
  };
}

function noteAttrs(op: AddNoteOp): Record<string, AttrValue> {
  return {
    id: op.id,
    for: op.target,
    ...(op.label ? { label: op.label } : {}),
  };
}

function changeRequestNode(op: Extract<PatchOp, { op: "add_change_request" }>): DirectiveNode {
  const attrs = changeRequestAttrs(op);
  const content = op.content?.replace(/\n+$/, "") ?? "";
  return {
    type: "directive",
    name: "change_request",
    id: op.id,
    attrs,
    body: content,
    children: content === "" ? [] : [bodyParagraph(content)],
  };
}

function changeRequestAttrs(op: Extract<PatchOp, { op: "add_change_request" }>): Record<string, AttrValue> {
  return {
    id: op.id,
    target: op.target,
    action: op.action,
    ...(op.from !== undefined ? { from: op.from } : {}),
    ...(op.to !== undefined ? { to: op.to } : {}),
    ...(op.text !== undefined ? { text: op.text } : {}),
    ...(op.author ? { author: op.author } : {}),
    ...(op.date ? { date: op.date } : {}),
  };
}

function isTableDirective(node: Node): node is DirectiveNode {
  return isDirective(node) && node.name === "table";
}

function isDatasetDirective(node: Node): node is DirectiveNode {
  return isDirective(node) && node.name === "dataset";
}

function markCommentResolved(
  node: DirectiveNode,
  op: Extract<PatchOp, { op: "resolve_comment" }>,
): void {
  node.attrs.status = "resolved";
  if (op.resolved_by) node.attrs.resolved_by = op.resolved_by;
  if (op.resolved_at) node.attrs.resolved_at = op.resolved_at;
}

interface TableDirectiveRows {
  header?: string[];
  rows: string[][];
  lines: Array<{ index: number; indent: string; cells: string[] }>;
}

function parseTableDirectiveBody(
  body: string,
  node: DirectiveNode,
  op: PatchOp,
): TableDirectiveRows {
  const lines = body
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const parsed = lines.map((line) => tableLineCells(line, op));
  return tableRowsFromCells(parsed, node, op);
}

function sourceTableDirectiveRows(
  sourceLines: string[],
  start: number,
  end: number,
  node: DirectiveNode,
  op: PatchOp,
): TableDirectiveRows {
  const lines: TableDirectiveRows["lines"] = [];
  for (let i = start; i < end - 1; i++) {
    const line = sourceLines[i] ?? "";
    if (!line.trim()) continue;
    lines.push({
      index: i,
      indent: line.match(/^\s*/)?.[0] ?? "",
      cells: tableLineCells(line.trim(), op),
    });
  }
  return tableRowsFromCells(lines, node, op);
}

function tableRowsFromCells(
  parsed: Array<string[] | { index: number; indent: string; cells: string[] }>,
  node: DirectiveNode,
  op: PatchOp,
): TableDirectiveRows {
  if (parsed.length === 0) {
    throw new PatchError("invalid_content", `table "${node.id ?? "?"}" has no rows`, op);
  }
  const wantsHeader = node.attrs.header === true || node.attrs.header === "true";
  const lines = parsed.map((entry, index) => {
    if (Array.isArray(entry)) return { index, indent: "", cells: entry };
    return entry;
  });
  const header = wantsHeader ? lines[0]?.cells : undefined;
  const rows = wantsHeader ? lines.slice(1).map((line) => line.cells) : lines.map((line) => line.cells);
  return {
    ...(header ? { header } : {}),
    rows,
    lines,
  };
}

function updateTableRows(
  table: TableDirectiveRows,
  op: Extract<PatchOp, { op: "update_table_cell" }>,
): { lineOffset: number; cells: string[] } {
  if (!Number.isInteger(op.row) || op.row < 0) {
    throw new PatchError("invalid_content", `table row must be a non-negative integer`, op);
  }
  if (op.value.includes("\n") || op.value.includes("\r")) {
    throw new PatchError("invalid_content", `table cell value must be a single line`, op);
  }
  if (op.row >= table.rows.length) {
    throw new PatchError("invalid_content", `table row ${op.row} is out of range`, op);
  }
  const column = tableColumnIndex(table, op);
  const columnCount = tableColumnCount(table);
  if (column >= columnCount) {
    throw new PatchError("invalid_content", `table column ${String(op.column)} is out of range`, op);
  }
  for (const row of table.rows) {
    while (row.length < columnCount) row.push("");
  }
  const row = table.rows[op.row]!;
  row[column] = op.value;
  const lineOffset = table.header ? op.row + 1 : op.row;
  return { lineOffset, cells: row };
}

function updateTableHeaderCell(
  table: TableDirectiveRows,
  op: Extract<PatchOp, { op: "update_table_header_cell" }>,
): { lineOffset: number; cells: string[] } {
  if (!table.header) {
    throw new PatchError("invalid_content", `table header cell update requires header=true`, op);
  }
  if (op.value.includes("\n") || op.value.includes("\r")) {
    throw new PatchError("invalid_content", `table header cell value must be a single line`, op);
  }
  const column = tableColumnIndex(table, op);
  const columnCount = tableColumnCount(table);
  if (column >= columnCount) {
    throw new PatchError("invalid_content", `table column ${String(op.column)} is out of range`, op);
  }
  while (table.header.length < columnCount) table.header.push("");
  table.header[column] = op.value;
  return { lineOffset: 0, cells: table.header };
}

function insertTableRow(
  table: TableDirectiveRows,
  op: Extract<PatchOp, { op: "insert_table_row" }>,
): { lineOffset: number; cells: string[] } {
  const row = validateTableRowIndex(op.row, table.rows.length, true, op);
  const cells = normalizeInsertedTableCells(table, op);
  table.rows.splice(row, 0, cells);
  const lineOffset = table.header ? row + 1 : row;
  return { lineOffset, cells };
}

function deleteTableRow(
  table: TableDirectiveRows,
  op: Extract<PatchOp, { op: "delete_table_row" }>,
): { lineOffset: number } {
  const row = validateTableRowIndex(op.row, table.rows.length, false, op);
  table.rows.splice(row, 1);
  return { lineOffset: table.header ? row + 1 : row };
}

function insertTableColumn(
  table: TableDirectiveRows,
  op: Extract<PatchOp, { op: "insert_table_column" }>,
): void {
  const columnCount = tableColumnCount(table);
  const column = validateTableColumnInsertIndex(op.column, columnCount, op);
  const cells = normalizeInsertedTableColumnCells(table, op);
  normalizeTableRows(table, columnCount);
  if (table.header) table.header.splice(column, 0, op.header ?? "");
  for (let rowIndex = 0; rowIndex < table.rows.length; rowIndex++) {
    table.rows[rowIndex]!.splice(column, 0, cells[rowIndex] ?? "");
  }
}

function deleteTableColumn(
  table: TableDirectiveRows,
  op: Extract<PatchOp, { op: "delete_table_column" }>,
): void {
  const columnCount = tableColumnCount(table);
  if (columnCount <= 1) {
    throw new PatchError("invalid_content", `cannot delete the last table column`, op);
  }
  const column = tableColumnIndex(table, op);
  if (column >= columnCount) {
    throw new PatchError("invalid_content", `table column ${String(op.column)} is out of range`, op);
  }
  normalizeTableRows(table, columnCount);
  if (table.header) table.header.splice(column, 1);
  for (const row of table.rows) row.splice(column, 1);
}

function validateTableRowIndex(row: number, length: number, allowEnd: boolean, op: PatchOp): number {
  if (!Number.isInteger(row) || row < 0) {
    throw new PatchError("invalid_content", `table row must be a non-negative integer`, op);
  }
  const max = allowEnd ? length : length - 1;
  if (row > max) {
    throw new PatchError("invalid_content", `table row ${row} is out of range`, op);
  }
  return row;
}

function normalizeInsertedTableCells(
  table: TableDirectiveRows,
  op: Extract<PatchOp, { op: "insert_table_row" }>,
): string[] {
  if (!Array.isArray(op.cells)) {
    throw new PatchError("invalid_content", `table row cells must be an array`, op);
  }
  const cells = op.cells.map((cell) => String(cell));
  for (const cell of cells) {
    if (cell.includes("\n") || cell.includes("\r")) {
      throw new PatchError("invalid_content", `table row cells must be single-line strings`, op);
    }
  }
  const columnCount = tableColumnCount(table);
  while (cells.length < columnCount) cells.push("");
  return cells;
}

function validateTableColumnInsertIndex(column: number, length: number, op: PatchOp): number {
  if (!Number.isInteger(column) || column < 0) {
    throw new PatchError("invalid_content", `table column must be a non-negative integer`, op);
  }
  if (column > length) {
    throw new PatchError("invalid_content", `table column ${column} is out of range`, op);
  }
  return column;
}

function normalizeInsertedTableColumnCells(
  table: TableDirectiveRows,
  op: Extract<PatchOp, { op: "insert_table_column" }>,
): string[] {
  if (!Array.isArray(op.cells)) {
    throw new PatchError("invalid_content", `table column cells must be an array`, op);
  }
  if (!table.header && op.header !== undefined) {
    throw new PatchError("invalid_content", `table column header requires header=true`, op);
  }
  if (op.header !== undefined && (op.header.includes("\n") || op.header.includes("\r"))) {
    throw new PatchError("invalid_content", `table column header must be a single-line string`, op);
  }
  if (op.cells.length > table.rows.length) {
    throw new PatchError("invalid_content", `table column cells exceed row count`, op);
  }
  const cells = op.cells.map((cell) => String(cell));
  for (const cell of cells) {
    if (cell.includes("\n") || cell.includes("\r")) {
      throw new PatchError("invalid_content", `table column cells must be single-line strings`, op);
    }
  }
  while (cells.length < table.rows.length) cells.push("");
  return cells;
}

function normalizeTableRows(table: TableDirectiveRows, columnCount: number): void {
  if (table.header) {
    while (table.header.length < columnCount) table.header.push("");
  }
  for (const row of table.rows) {
    while (row.length < columnCount) row.push("");
  }
}

function validateChangeRequestOp(op: Extract<PatchOp, { op: "add_change_request" }>): void {
  const attrValues = [op.from, op.to, op.text, op.author, op.date];
  for (const value of attrValues) {
    if (value !== undefined && (value.includes("\n") || value.includes("\r"))) {
      throw new PatchError("invalid_content", `change_request attributes must be single-line strings`, op);
    }
  }
  if (op.action === "replace") {
    if (!op.from || !op.to) {
      throw new PatchError("invalid_content", `replace change_request requires from and to`, op);
    }
    return;
  }
  if (op.action === "insert") {
    if (!op.to && !op.text) {
      throw new PatchError("invalid_content", `insert change_request requires to or text`, op);
    }
    return;
  }
  if (op.action === "delete") {
    if (!op.from && !op.text) {
      throw new PatchError("invalid_content", `delete change_request requires from or text`, op);
    }
    return;
  }
  throw new PatchError("invalid_content", `change_request action must be insert, delete, or replace`, op);
}

function validateNoteOp(op: AddNoteOp): void {
  if (!op.content.trim()) {
    throw new PatchError("invalid_content", `${op.op === "add_footnote" ? "footnote" : "endnote"} content must not be empty`, op);
  }
  if (op.label !== undefined && (op.label.includes("\n") || op.label.includes("\r"))) {
    throw new PatchError("invalid_content", `note label must be a single-line string`, op);
  }
}

function tableColumnIndex(
  table: TableDirectiveRows,
  op: PatchOp & { column: number | string },
): number {
  if (typeof op.column === "number") {
    if (!Number.isInteger(op.column) || op.column < 0) {
      throw new PatchError("invalid_content", `table column must be a non-negative integer`, op);
    }
    return op.column;
  }
  if (!table.header) {
    throw new PatchError("invalid_content", `table column labels require header=true`, op);
  }
  const index = table.header.indexOf(op.column);
  if (index === -1) {
    throw new PatchError("invalid_content", `table column "${op.column}" not found`, op);
  }
  return index;
}

function tableColumnCount(table: TableDirectiveRows): number {
  return Math.max(
    table.header?.length ?? 0,
    ...table.rows.map((row) => row.length),
  );
}

function tableLineCells(line: string, op: PatchOp): string[] {
  if (!line.includes("|")) {
    throw new PatchError("invalid_content", `table rows must use pipe syntax`, op);
  }
  return splitPipeRow(line);
}

type DatasetSourceShape = "records" | "arrays" | "object";

interface DatasetDirectiveRows {
  columns: string[];
  rows: unknown[][];
  schema?: Record<string, unknown>;
  sourceShape?: DatasetSourceShape;
}

function updateDatasetBody(
  node: DirectiveNode,
  op: Extract<PatchOp, { op: "update_dataset_cell" }>,
): string {
  const format = datasetFormat(node);
  if (format === "csv" || format === "tsv") {
    const delimiter = format === "tsv" ? "\t" : ",";
    const table = parseDelimitedDatasetBody(node.body ?? "", delimiter, op);
    updateDatasetRows(table, op);
    return serializeDelimitedDatasetBody(table, delimiter, op);
  }
  if (format === "json") {
    const table = parseJsonDatasetBody(node, op);
    updateDatasetRows(table, op);
    return serializeJsonDatasetBody(table);
  }
  if (format !== "yaml") {
    throw new PatchError("invalid_content", `dataset format "${format}" is not supported by update_dataset_cell`, op);
  }
  const table = parseYamlDatasetBody(node, op);
  updateDatasetRows(table, op);
  return serializeYamlDatasetBody(table);
}

function insertDatasetBody(
  node: DirectiveNode,
  op: Extract<PatchOp, { op: "insert_dataset_row" }>,
): string {
  const format = datasetFormat(node);
  if (format === "csv" || format === "tsv") {
    const delimiter = format === "tsv" ? "\t" : ",";
    const table = parseDelimitedDatasetBody(node.body ?? "", delimiter, op);
    insertDatasetRow(table, op);
    return serializeDelimitedDatasetBody(table, delimiter, op);
  }
  if (format === "json") {
    const table = parseJsonDatasetBody(node, op);
    insertDatasetRow(table, op);
    return serializeJsonDatasetBody(table);
  }
  if (format !== "yaml") {
    throw new PatchError("invalid_content", `dataset format "${format}" is not supported by insert_dataset_row`, op);
  }
  const table = parseYamlDatasetBody(node, op);
  insertDatasetRow(table, op);
  return serializeYamlDatasetBody(table);
}

function deleteDatasetBody(
  node: DirectiveNode,
  op: Extract<PatchOp, { op: "delete_dataset_row" }>,
): string {
  const format = datasetFormat(node);
  if (format === "csv" || format === "tsv") {
    const delimiter = format === "tsv" ? "\t" : ",";
    const table = parseDelimitedDatasetBody(node.body ?? "", delimiter, op);
    deleteDatasetRow(table, op);
    return serializeDelimitedDatasetBody(table, delimiter, op);
  }
  if (format === "json") {
    const table = parseJsonDatasetBody(node, op);
    deleteDatasetRow(table, op);
    return serializeJsonDatasetBody(table);
  }
  if (format !== "yaml") {
    throw new PatchError("invalid_content", `dataset format "${format}" is not supported by delete_dataset_row`, op);
  }
  const table = parseYamlDatasetBody(node, op);
  deleteDatasetRow(table, op);
  return serializeYamlDatasetBody(table);
}

function insertDatasetColumnBody(
  node: DirectiveNode,
  op: Extract<PatchOp, { op: "insert_dataset_column" }>,
): string {
  const format = datasetFormat(node);
  if (format === "csv" || format === "tsv") {
    const delimiter = format === "tsv" ? "\t" : ",";
    const table = parseDelimitedDatasetBody(node.body ?? "", delimiter, op);
    insertDatasetColumn(table, op);
    return serializeDelimitedDatasetBody(table, delimiter, op);
  }
  if (format === "json") {
    const table = parseJsonDatasetBody(node, op);
    insertDatasetColumn(table, op);
    if (table.sourceShape === "arrays") table.sourceShape = "object";
    return serializeJsonDatasetBody(table);
  }
  if (format !== "yaml") {
    throw new PatchError("invalid_content", `dataset format "${format}" is not supported by insert_dataset_column`, op);
  }
  const table = parseYamlDatasetBody(node, op);
  insertDatasetColumn(table, op);
  return serializeYamlDatasetBody(table);
}

function deleteDatasetColumnBody(
  node: DirectiveNode,
  op: Extract<PatchOp, { op: "delete_dataset_column" }>,
): string {
  const format = datasetFormat(node);
  if (format === "csv" || format === "tsv") {
    const delimiter = format === "tsv" ? "\t" : ",";
    const table = parseDelimitedDatasetBody(node.body ?? "", delimiter, op);
    deleteDatasetColumn(table, op);
    return serializeDelimitedDatasetBody(table, delimiter, op);
  }
  if (format === "json") {
    const table = parseJsonDatasetBody(node, op);
    deleteDatasetColumn(table, op);
    if (table.sourceShape === "arrays") table.sourceShape = "object";
    return serializeJsonDatasetBody(table);
  }
  if (format !== "yaml") {
    throw new PatchError("invalid_content", `dataset format "${format}" is not supported by delete_dataset_column`, op);
  }
  const table = parseYamlDatasetBody(node, op);
  deleteDatasetColumn(table, op);
  return serializeYamlDatasetBody(table);
}

function datasetFormat(node: DirectiveNode): string {
  const format = node.attrs.format;
  return typeof format === "string" && format.trim() ? format.trim().toLowerCase() : "yaml";
}

function parseDelimitedDatasetBody(
  body: string,
  delimiter: "," | "\t",
  op: PatchOp,
): DatasetDirectiveRows {
  const lines = body.replace(/\r\n?/g, "\n").split("\n").filter((line) => line.trim().length > 0);
  if (lines.length < 1) throw new PatchError("invalid_content", `dataset must have a header row`, op);
  const split = (line: string) => splitDelimitedRow(line, delimiter);
  return {
    columns: split(lines[0]!),
    rows: lines.slice(1).map(split),
  };
}

function parseYamlDatasetBody(
  node: DirectiveNode,
  op: PatchOp,
): DatasetDirectiveRows {
  const parsed = loadYamlDataset(node, op);
  const rows = parsed.rows;
  if (!Array.isArray(rows)) throw new PatchError("invalid_content", `dataset "${node.id ?? "?"}" has no rows array`, op);
  return {
    columns: datasetColumnsFromYaml(node, parsed, rows),
    rows: rows.filter(Array.isArray).map((row) => [...row]),
    schema: recordValue(parsed.schema),
  };
}

function parseJsonDatasetBody(
  node: DirectiveNode,
  op: PatchOp,
): DatasetDirectiveRows {
  return parseJsonDatasetText(node.body ?? "", node, op);
}

function parseJsonDatasetText(
  body: string,
  node: DirectiveNode,
  op: PatchOp,
): DatasetDirectiveRows {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    throw new PatchError("invalid_content", `dataset "${node.id ?? "?"}" is not valid JSON`, op);
  }
  if (Array.isArray(parsed)) {
    if (parsed.length > 0 && firstJsonRowIsRecord(parsed)) {
      const columns = Object.keys(parsed[0] as Record<string, unknown>);
      return {
        columns,
        rows: (parsed as Record<string, unknown>[]).map((row) => columns.map((column) => row[column] ?? null)),
        sourceShape: "records",
      };
    }
    return {
      columns: columnsAttr(node),
      rows: (parsed as unknown[]).filter(Array.isArray).map((row) => [...row]),
      sourceShape: "arrays",
    };
  }
  const record = recordValue(parsed);
  if (!record || !Array.isArray(record.rows)) {
    throw new PatchError("invalid_content", `dataset "${node.id ?? "?"}" has no JSON rows array`, op);
  }
  const columns = Array.isArray(record.columns)
    ? record.columns.map(String)
    : columnsAttr(node);
  return {
    columns,
    rows: record.rows.filter(Array.isArray).map((row) => [...row]),
    sourceShape: "object",
  };
}

function loadYamlDataset(node: DirectiveNode, op: PatchOp): Record<string, unknown> {
  return loadYamlDatasetText(node.body ?? "", node.id, op);
}

function loadYamlDatasetText(body: string, id: string | undefined, op: PatchOp): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = yaml.load(body);
  } catch {
    throw new PatchError("invalid_content", `dataset "${id ?? "?"}" is not valid YAML`, op);
  }
  const record = recordValue(parsed);
  if (!record) throw new PatchError("invalid_content", `dataset "${id ?? "?"}" must be a YAML object`, op);
  return record;
}

function datasetColumnsFromYaml(
  node: DirectiveNode,
  parsed: Record<string, unknown>,
  rows: unknown[],
): string[] {
  const schema = recordValue(parsed.schema);
  if (schema) return Object.keys(schema);
  const attrColumns = columnsAttr(node);
  if (attrColumns.length > 0) return attrColumns;
  return inferredDatasetColumns(rows);
}

function columnsAttr(node: DirectiveNode): string[] {
  const columns = node.attrs.columns;
  return typeof columns === "string" ? columns.split(/[,\s]+/).filter(Boolean) : [];
}

function inferredDatasetColumns(rows: unknown[]): string[] {
  const width = Math.max(0, ...rows.filter(Array.isArray).map((row) => row.length));
  return Array.from({ length: width }, (_value, index) => `Column ${index + 1}`);
}

function updateDatasetRows(
  table: DatasetDirectiveRows,
  op: Extract<PatchOp, { op: "update_dataset_cell" }>,
): { lineOffset: number; column: number; cells: unknown[] } {
  if (!Number.isInteger(op.row) || op.row < 0) {
    throw new PatchError("invalid_content", `dataset row must be a non-negative integer`, op);
  }
  if (op.value.includes("\n") || op.value.includes("\r")) {
    throw new PatchError("invalid_content", `dataset cell value must be a single line`, op);
  }
  if (op.row >= table.rows.length) {
    throw new PatchError("invalid_content", `dataset row ${op.row} is out of range`, op);
  }
  const column = datasetColumnIndex(table, op);
  const columnCount = datasetColumnCount(table);
  if (column >= columnCount) {
    throw new PatchError("invalid_content", `dataset column ${String(op.column)} is out of range`, op);
  }
  for (const row of table.rows) {
    while (row.length < columnCount) row.push(null);
  }
  const row = table.rows[op.row]!;
  const columnName = table.columns[column];
  row[column] = coerceDatasetPatchValue(op.value, columnName ? table.schema?.[columnName] : undefined);
  return { lineOffset: op.row, column, cells: row };
}

function insertDatasetRow(
  table: DatasetDirectiveRows,
  op: Extract<PatchOp, { op: "insert_dataset_row" }>,
): { lineOffset: number; cells: unknown[] } {
  const row = validateDatasetRowIndex(op.row, table.rows.length, true, op);
  const cells = normalizeInsertedDatasetCells(table, op);
  table.rows.splice(row, 0, cells);
  return { lineOffset: row, cells };
}

function deleteDatasetRow(
  table: DatasetDirectiveRows,
  op: Extract<PatchOp, { op: "delete_dataset_row" }>,
): { lineOffset: number } {
  const row = validateDatasetRowIndex(op.row, table.rows.length, false, op);
  table.rows.splice(row, 1);
  return { lineOffset: row };
}

function insertDatasetColumn(
  table: DatasetDirectiveRows,
  op: Extract<PatchOp, { op: "insert_dataset_column" }>,
): { column: number; values: unknown[] } {
  const column = validateDatasetColumnInsertIndex(op.column, datasetColumnCount(table), op);
  if (op.header.includes("\n") || op.header.includes("\r") || op.header.trim().length === 0) {
    throw new PatchError("invalid_content", `dataset column header must be a non-empty single-line string`, op);
  }
  if (table.columns.includes(op.header)) {
    throw new PatchError("invalid_content", `dataset column "${op.header}" already exists`, op);
  }
  const values = normalizeInsertedDatasetColumnCells(table, op);
  const schemaValue = inferDatasetType(values.map(datasetScalarText));
  normalizeDatasetRows(table, datasetColumnCount(table));
  table.columns.splice(column, 0, op.header);
  for (let rowIndex = 0; rowIndex < table.rows.length; rowIndex++) {
    table.rows[rowIndex]!.splice(column, 0, values[rowIndex] ?? "");
  }
  if (table.schema) {
    table.schema = insertRecordEntry(table.schema, op.header, schemaValue, column);
  }
  return { column, values };
}

function deleteDatasetColumn(
  table: DatasetDirectiveRows,
  op: Extract<PatchOp, { op: "delete_dataset_column" }>,
): { column: number; header: string } {
  const columnCount = datasetColumnCount(table);
  if (columnCount <= 1) {
    throw new PatchError("invalid_content", `cannot delete the last dataset column`, op);
  }
  const column = datasetColumnIndex(table, op);
  if (column >= columnCount) {
    throw new PatchError("invalid_content", `dataset column ${String(op.column)} is out of range`, op);
  }
  normalizeDatasetRows(table, columnCount);
  const header = table.columns[column] ?? `Column ${column + 1}`;
  table.columns.splice(column, 1);
  for (const row of table.rows) row.splice(column, 1);
  if (table.schema) {
    const nextSchema: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(table.schema)) {
      if (key !== header) nextSchema[key] = value;
    }
    table.schema = nextSchema;
  }
  return { column, header };
}

function validateDatasetRowIndex(row: number, length: number, allowEnd: boolean, op: PatchOp): number {
  if (!Number.isInteger(row) || row < 0) {
    throw new PatchError("invalid_content", `dataset row must be a non-negative integer`, op);
  }
  const max = allowEnd ? length : length - 1;
  if (row > max) {
    throw new PatchError("invalid_content", `dataset row ${row} is out of range`, op);
  }
  return row;
}

function normalizeInsertedDatasetCells(
  table: DatasetDirectiveRows,
  op: Extract<PatchOp, { op: "insert_dataset_row" }>,
): unknown[] {
  if (!Array.isArray(op.cells)) {
    throw new PatchError("invalid_content", `dataset row cells must be an array`, op);
  }
  const rawCells = op.cells.map((cell) => String(cell));
  for (const cell of rawCells) {
    if (cell.includes("\n") || cell.includes("\r")) {
      throw new PatchError("invalid_content", `dataset row cells must be single-line strings`, op);
    }
  }
  let columnCount = datasetColumnCount(table);
  if (columnCount === 0) {
    columnCount = rawCells.length;
    table.columns = inferredDatasetColumns([rawCells]);
  }
  if (rawCells.length > columnCount) {
    throw new PatchError("invalid_content", `dataset row cells exceed column count`, op);
  }
  while (rawCells.length < columnCount) rawCells.push("");
  return rawCells.map((cell, column) => {
    const columnName = table.columns[column];
    return coerceDatasetPatchValue(cell, columnName ? table.schema?.[columnName] : undefined);
  });
}

function validateDatasetColumnInsertIndex(column: number, length: number, op: PatchOp): number {
  if (!Number.isInteger(column) || column < 0) {
    throw new PatchError("invalid_content", `dataset column must be a non-negative integer`, op);
  }
  if (column > length) {
    throw new PatchError("invalid_content", `dataset column ${column} is out of range`, op);
  }
  return column;
}

function normalizeInsertedDatasetColumnCells(
  table: DatasetDirectiveRows,
  op: Extract<PatchOp, { op: "insert_dataset_column" }>,
): unknown[] {
  if (!Array.isArray(op.cells)) {
    throw new PatchError("invalid_content", `dataset column cells must be an array`, op);
  }
  if (op.cells.length > table.rows.length) {
    throw new PatchError("invalid_content", `dataset column cells exceed row count`, op);
  }
  const cells = op.cells.map((cell) => String(cell));
  for (const cell of cells) {
    if (cell.includes("\n") || cell.includes("\r")) {
      throw new PatchError("invalid_content", `dataset column cells must be single-line strings`, op);
    }
  }
  while (cells.length < table.rows.length) cells.push("");
  const schemaValue = inferDatasetType(cells);
  return cells.map((cell) => coerceDatasetPatchValue(cell, schemaValue));
}

function normalizeDatasetRows(table: DatasetDirectiveRows, columnCount: number): void {
  while (table.columns.length < columnCount) table.columns.push(`Column ${table.columns.length + 1}`);
  for (const row of table.rows) {
    while (row.length < columnCount) row.push(null);
  }
}

function insertRecordEntry(record: Record<string, unknown>, key: string, value: unknown, index: number): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const entries = Object.entries(record);
  for (let i = 0; i <= entries.length; i++) {
    if (i === index) out[key] = value;
    const entry = entries[i];
    if (entry) out[entry[0]] = entry[1];
  }
  return out;
}

function datasetColumnIndex(
  table: DatasetDirectiveRows,
  op: PatchOp & { column: number | string },
): number {
  if (typeof op.column === "number") {
    if (!Number.isInteger(op.column) || op.column < 0) {
      throw new PatchError("invalid_content", `dataset column must be a non-negative integer`, op);
    }
    return op.column;
  }
  const index = table.columns.indexOf(op.column);
  if (index === -1) throw new PatchError("invalid_content", `dataset column "${op.column}" not found`, op);
  return index;
}

function datasetColumnCount(table: DatasetDirectiveRows): number {
  return Math.max(table.columns.length, ...table.rows.map((row) => row.length), 0);
}

function serializeDelimitedDatasetBody(
  table: DatasetDirectiveRows,
  delimiter: "," | "\t",
  op: PatchOp,
): string {
  const rows = [table.columns, ...table.rows.map((row) => row.map(datasetScalarText))];
  if (rows.some((row) => row.some((cell) => /[\r\n]/.test(cell)))) {
    throw new PatchError("invalid_content", `dataset cell value must be a single line`, op);
  }
  return rows.map((row) => serializeDelimitedRow(row, delimiter)).join("\n");
}

function serializeJsonDatasetBody(table: DatasetDirectiveRows): string {
  if (table.sourceShape === "records") {
    return JSON.stringify(table.rows.map((row) => datasetRecord(table.columns, row)), null, 2);
  }
  if (table.sourceShape === "arrays") {
    return JSON.stringify(table.rows, null, 2);
  }
  return JSON.stringify({ columns: table.columns, rows: table.rows }, null, 2);
}

function serializeYamlDatasetBody(table: DatasetDirectiveRows): string {
  const schema = table.schema ?? datasetSchema(table.columns, table.rows);
  return yaml.dump({ schema, rows: table.rows }, { flowLevel: 2, lineWidth: -1, noRefs: true, sortKeys: false }).trimEnd();
}

function datasetRecord(columns: string[], row: unknown[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  columns.forEach((column, index) => {
    out[column] = row[index] ?? null;
  });
  return out;
}

function datasetSchema(columns: string[], rows: unknown[][]): Record<string, unknown> {
  const schema: Record<string, unknown> = {};
  columns.forEach((column, columnIndex) => {
    schema[column] = inferDatasetType(rows.map((row) => datasetScalarText(row[columnIndex])));
  });
  return schema;
}

function coerceDatasetPatchValue(value: string, schemaValue: unknown): unknown {
  const type = schemaType(schemaValue);
  if (type === "number" || type === "integer") {
    if (!value.trim()) return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : value;
  }
  if (type === "boolean") {
    if (!value.trim()) return null;
    return booleanText(value) ?? value;
  }
  return type ? value : coerceDatasetScalar(value);
}

function coerceDatasetScalar(value: string): unknown {
  const trimmed = value.trim();
  if (!trimmed) return value;
  const boolean = booleanText(trimmed);
  if (boolean !== undefined) return boolean;
  const number = Number(trimmed);
  if (Number.isFinite(number) && /^-?\d/.test(trimmed)) return number;
  return value;
}

function inferDatasetType(values: string[]): "boolean" | "number" | "string" {
  const present = values.map((value) => value.trim()).filter(Boolean);
  if (present.length === 0) return "string";
  if (present.every((value) => Number.isFinite(Number(value)))) return "number";
  if (present.every((value) => booleanText(value) !== undefined)) return "boolean";
  return "string";
}

function schemaType(schemaValue: unknown): string | undefined {
  if (typeof schemaValue === "string") return schemaValue.toLowerCase();
  const record = recordValue(schemaValue);
  const type = record?.type;
  return typeof type === "string" ? type.toLowerCase() : undefined;
}

function booleanText(value: string): boolean | undefined {
  const normalized = value.trim().toLowerCase();
  if (normalized === "true" || normalized === "yes" || normalized === "1") return true;
  if (normalized === "false" || normalized === "no" || normalized === "0") return false;
  return undefined;
}

function datasetScalarText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

function firstJsonRowIsRecord(rows: unknown[]): boolean {
  const first = rows[0];
  return Boolean(first && typeof first === "object" && !Array.isArray(first));
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function serializeTableRows(table: TableDirectiveRows): string {
  return allTableRows(table).map((row) => serializePipeRow(row)).join("\n");
}

function allTableRows(table: TableDirectiveRows): string[][] {
  return table.header ? [table.header, ...table.rows] : table.rows;
}

function serializePipeRow(cells: string[], indent = ""): string {
  return `${indent}| ${cells.map(escapePipeTableCell).join(" | ")} |`;
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
  return structuredClone(value);
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
    case "remove_attribute":
      return applySrcRemoveAttr(source, op);
    case "replace_block":
      return applySrcReplace(source, op);
    case "replace_body":
      return applySrcReplaceBody(source, op);
    case "update_heading":
      return applySrcUpdateHeading(source, op);
    case "add_comment":
      return applySrcAddComment(source, op);
    case "resolve_comment":
      return applySrcResolveComment(source, op);
    case "add_footnote":
    case "add_endnote":
      return applySrcAddNote(source, op);
    case "add_change_request":
      return applySrcAddChangeRequest(source, op);
    case "update_table_cell":
      return applySrcUpdateTableCell(source, op);
    case "update_table_header_cell":
      return applySrcUpdateTableHeaderCell(source, op);
    case "insert_table_row":
      return applySrcInsertTableRow(source, op);
    case "delete_table_row":
      return applySrcDeleteTableRow(source, op);
    case "insert_table_column":
      return applySrcInsertTableColumn(source, op);
    case "delete_table_column":
      return applySrcDeleteTableColumn(source, op);
    case "update_dataset_cell":
      return applySrcUpdateDatasetCell(source, op);
    case "insert_dataset_row":
      return applySrcInsertDatasetRow(source, op);
    case "delete_dataset_row":
      return applySrcDeleteDatasetRow(source, op);
    case "insert_dataset_column":
      return applySrcInsertDatasetColumn(source, op);
    case "delete_dataset_column":
      return applySrcDeleteDatasetColumn(source, op);
    case "move_block":
      return applySrcMove(source, op);
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

function applySrcRemoveAttr(
  source: string,
  op: Extract<PatchOp, { op: "remove_attribute" }>,
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
  lines[lineIdx] = rewriteOpenLineRemoveAttr(open, op.key, op);
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

function applySrcAddComment(
  source: string,
  op: Extract<PatchOp, { op: "add_comment" }>,
): string {
  const doc = parse(source);
  if (findById(doc, op.id)) {
    throw new PatchError("id_conflict", `target id "${op.id}" already exists`, op);
  }
  const target = findById(doc, op.target);
  if (!target) throw new PatchError("target_missing", `block "${op.target}" not found`, op);
  const start = target.pos?.line;
  const end = target.endLine;
  if (!start || !end) throw new Error(`block "${op.target}" has no source span`);
  const lines = source.split("\n");
  const fragmentLines = siblingDirectiveFragmentLines(target, lines, serializeCommentBlock(op));

  let insertAt: number;
  if (target.type === "section") {
    insertAt = start;
    if (lines[insertAt] === "") insertAt += 1;
    fragmentLines.push("");
  } else {
    insertAt = end;
    fragmentLines.unshift("");
  }
  lines.splice(insertAt, 0, ...fragmentLines);
  return lines.join("\n");
}

function applySrcResolveComment(
  source: string,
  op: Extract<PatchOp, { op: "resolve_comment" }>,
): string {
  const { node, start } = locate(source, op.id, op);
  if (!isCommentDirective(node)) {
    throw new PatchError("invalid_content", `block "${op.id}" is not a comment`, op);
  }
  const lines = source.split("\n");
  const lineIdx = start - 1;
  lines[lineIdx] = rewriteCommentResolutionAttrs(lines[lineIdx] ?? "", op);
  return lines.join("\n");
}

function applySrcAddNote(
  source: string,
  op: AddNoteOp,
): string {
  validateNoteOp(op);
  const doc = parse(source);
  if (findById(doc, op.id)) {
    throw new PatchError("id_conflict", `target id "${op.id}" already exists`, op);
  }
  const target = findById(doc, op.target);
  if (!target) throw new PatchError("target_missing", `block "${op.target}" not found`, op);
  const start = target.pos?.line;
  const end = target.endLine;
  if (!start || !end) throw new Error(`block "${op.target}" has no source span`);
  const lines = source.split("\n");
  const fragmentLines = siblingDirectiveFragmentLines(target, lines, serializeNoteBlock(op));

  let insertAt: number;
  if (target.type === "section") {
    insertAt = start;
    if (lines[insertAt] === "") insertAt += 1;
    fragmentLines.push("");
  } else {
    insertAt = end;
    fragmentLines.unshift("");
  }
  lines.splice(insertAt, 0, ...fragmentLines);
  return lines.join("\n");
}

function applySrcAddChangeRequest(
  source: string,
  op: Extract<PatchOp, { op: "add_change_request" }>,
): string {
  validateChangeRequestOp(op);
  const doc = parse(source);
  if (findById(doc, op.id)) {
    throw new PatchError("id_conflict", `target id "${op.id}" already exists`, op);
  }
  const target = findById(doc, op.target);
  if (!target) throw new PatchError("target_missing", `block "${op.target}" not found`, op);
  const start = target.pos?.line;
  const end = target.endLine;
  if (!start || !end) throw new Error(`block "${op.target}" has no source span`);
  const lines = source.split("\n");
  const fragmentLines = siblingDirectiveFragmentLines(target, lines, serializeChangeRequestBlock(op));

  let insertAt: number;
  if (target.type === "section") {
    insertAt = start;
    if (lines[insertAt] === "") insertAt += 1;
    fragmentLines.push("");
  } else {
    insertAt = end;
    fragmentLines.unshift("");
  }
  lines.splice(insertAt, 0, ...fragmentLines);
  return lines.join("\n");
}

function siblingDirectiveFragmentLines(target: Node, lines: string[], source: string): string[] {
  const targetDepth = isDirective(target) ? directiveFenceDepth(target, lines) : 2;
  return normalizeDirectiveFenceDepth(source, 2, targetDepth).split("\n");
}

function applySrcUpdateTableCell(
  source: string,
  op: Extract<PatchOp, { op: "update_table_cell" }>,
): string {
  const { node, start, end } = locate(source, op.id, op);
  if (!isTableDirective(node)) {
    throw new PatchError("invalid_content", `block "${op.id}" is not a table directive`, op);
  }
  const lines = source.split("\n");
  const table = sourceTableDirectiveRows(lines, start, end, node, op);
  const target = updateTableRows(table, op);
  const sourceLine = table.lines[target.lineOffset]!;
  lines[sourceLine.index] = serializePipeRow(target.cells, sourceLine.indent);
  return lines.join("\n");
}

function applySrcUpdateTableHeaderCell(
  source: string,
  op: Extract<PatchOp, { op: "update_table_header_cell" }>,
): string {
  const { node, start, end } = locate(source, op.id, op);
  if (!isTableDirective(node)) {
    throw new PatchError("invalid_content", `block "${op.id}" is not a table directive`, op);
  }
  const lines = source.split("\n");
  const table = sourceTableDirectiveRows(lines, start, end, node, op);
  const target = updateTableHeaderCell(table, op);
  const sourceLine = table.lines[target.lineOffset]!;
  lines[sourceLine.index] = serializePipeRow(target.cells, sourceLine.indent);
  return lines.join("\n");
}

function applySrcInsertTableRow(
  source: string,
  op: Extract<PatchOp, { op: "insert_table_row" }>,
): string {
  const { node, start, end } = locate(source, op.id, op);
  if (!isTableDirective(node)) {
    throw new PatchError("invalid_content", `block "${op.id}" is not a table directive`, op);
  }
  const lines = source.split("\n");
  const table = sourceTableDirectiveRows(lines, start, end, node, op);
  const target = insertTableRow(table, op);
  const indent = tableRowIndent(table, target.lineOffset);
  const insertAt = tableInsertLineIndex(table, target.lineOffset, end);
  lines.splice(insertAt, 0, serializePipeRow(target.cells, indent));
  return lines.join("\n");
}

function applySrcDeleteTableRow(
  source: string,
  op: Extract<PatchOp, { op: "delete_table_row" }>,
): string {
  const { node, start, end } = locate(source, op.id, op);
  if (!isTableDirective(node)) {
    throw new PatchError("invalid_content", `block "${op.id}" is not a table directive`, op);
  }
  const lines = source.split("\n");
  const table = sourceTableDirectiveRows(lines, start, end, node, op);
  const target = deleteTableRow(table, op);
  const sourceLine = table.lines[target.lineOffset];
  if (!sourceLine) throw new PatchError("invalid_content", `table row ${op.row} is out of range`, op);
  lines.splice(sourceLine.index, 1);
  return lines.join("\n");
}

function applySrcInsertTableColumn(
  source: string,
  op: Extract<PatchOp, { op: "insert_table_column" }>,
): string {
  const { node, start, end } = locate(source, op.id, op);
  if (!isTableDirective(node)) {
    throw new PatchError("invalid_content", `block "${op.id}" is not a table directive`, op);
  }
  const lines = source.split("\n");
  const table = sourceTableDirectiveRows(lines, start, end, node, op);
  insertTableColumn(table, op);
  rewriteSourceTableRows(lines, table);
  return lines.join("\n");
}

function applySrcDeleteTableColumn(
  source: string,
  op: Extract<PatchOp, { op: "delete_table_column" }>,
): string {
  const { node, start, end } = locate(source, op.id, op);
  if (!isTableDirective(node)) {
    throw new PatchError("invalid_content", `block "${op.id}" is not a table directive`, op);
  }
  const lines = source.split("\n");
  const table = sourceTableDirectiveRows(lines, start, end, node, op);
  deleteTableColumn(table, op);
  rewriteSourceTableRows(lines, table);
  return lines.join("\n");
}

function applySrcUpdateDatasetCell(
  source: string,
  op: Extract<PatchOp, { op: "update_dataset_cell" }>,
): string {
  const { node, start, end } = locate(source, op.id, op);
  if (!isDatasetDirective(node)) {
    throw new PatchError("invalid_content", `block "${op.id}" is not a dataset directive`, op);
  }
  const lines = source.split("\n");
  const format = datasetFormat(node);
  if (format === "csv" || format === "tsv") {
    const delimiter = format === "tsv" ? "\t" : ",";
    const table = sourceDelimitedDatasetRows(lines, start, end, delimiter, op);
    const target = updateDatasetRows(table, op);
    const sourceLine = table.lines[target.lineOffset + 1]!;
    const cells = target.cells.map(datasetScalarText);
    if (cells.some((cell) => /[\r\n]/.test(cell))) {
      throw new PatchError("invalid_content", `dataset cell value must be a single line`, op);
    }
    lines[sourceLine.index] = `${sourceLine.indent}${serializeDelimitedRow(cells, delimiter)}`;
    return lines.join("\n");
  }
  if (format === "yaml") {
    const table = sourceYamlDatasetRows(lines, start, end, node, op);
    const target = updateDatasetRows(table, op);
    const sourceLine = table.lines[target.lineOffset]!;
    lines[sourceLine.index] = `${sourceLine.indent}- ${serializeYamlFlowRow(target.cells)}${sourceLine.trailing}`;
    return lines.join("\n");
  }
  if (format === "json") {
    const table = sourceJsonDatasetRows(lines, start, end, node, op);
    const target = updateDatasetRows(table, op);
    if (table.sourceShape === "records") {
      const sourceRow = table.lines[target.lineOffset];
      if (!sourceRow) throw new PatchError("invalid_content", `dataset row ${op.row} is out of range`, op);
      const column = target.column;
      const key = table.columns[column];
      if (!key) throw new PatchError("invalid_content", `dataset column ${String(op.column)} is out of range`, op);
      const sourceLine = sourceRow.propertyLines.get(key);
      if (sourceLine === undefined) {
        throw new PatchError("invalid_content", `source-preserving update_dataset_cell could not map JSON property "${key}"`, op);
      }
      lines[sourceLine] = rewriteJsonPropertyLine(lines[sourceLine] ?? "", key, target.cells[column], op);
      return lines.join("\n");
    }
    const sourceLine = table.lines[target.lineOffset];
    if (!sourceLine) throw new PatchError("invalid_content", `dataset row ${op.row} is out of range`, op);
    lines[sourceLine.index] = `${sourceLine.indent}${JSON.stringify(target.cells)}${sourceLine.trailing}`;
    return lines.join("\n");
  }
  throw new PatchError("invalid_content", `source-preserving update_dataset_cell does not support ${format} datasets`, op);
}

function applySrcInsertDatasetRow(
  source: string,
  op: Extract<PatchOp, { op: "insert_dataset_row" }>,
): string {
  const { node, start, end } = locate(source, op.id, op);
  if (!isDatasetDirective(node)) {
    throw new PatchError("invalid_content", `block "${op.id}" is not a dataset directive`, op);
  }
  const lines = source.split("\n");
  const format = datasetFormat(node);
  if (format === "csv" || format === "tsv") {
    const delimiter = format === "tsv" ? "\t" : ",";
    const table = sourceDelimitedDatasetRows(lines, start, end, delimiter, op);
    const target = insertDatasetRow(table, op);
    const cells = target.cells.map(datasetScalarText);
    if (cells.some((cell) => /[\r\n]/.test(cell))) {
      throw new PatchError("invalid_content", `dataset cell value must be a single line`, op);
    }
    const indent = delimitedDatasetRowIndent(table, target.lineOffset);
    const insertAt = delimitedDatasetInsertLineIndex(table, target.lineOffset, end);
    lines.splice(insertAt, 0, `${indent}${serializeDelimitedRow(cells, delimiter)}`);
    return lines.join("\n");
  }
  if (format === "yaml") {
    const table = sourceYamlDatasetRows(lines, start, end, node, op);
    const target = insertDatasetRow(table, op);
    const indent = yamlDatasetRowIndent(table, target.lineOffset);
    const insertAt = yamlDatasetInsertLineIndex(table, target.lineOffset, end);
    if (table.lines.length === 0) {
      lines[table.rowsLineIndex] = rewriteYamlRowsLineAsBlock(lines[table.rowsLineIndex] ?? "", op);
    }
    lines.splice(insertAt, 0, `${indent}- ${serializeYamlFlowRow(target.cells)}`);
    return lines.join("\n");
  }
  if (format === "json") {
    const table = sourceJsonDatasetRows(lines, start, end, node, op);
    if (table.sourceShape === "records") {
      const target = insertDatasetRow(table, op);
      const insertAt = jsonRecordDatasetInsertLineIndex(table, target.lineOffset);
      if (target.lineOffset >= table.lines.length && table.lines.length > 0) {
        const previous = table.lines[table.lines.length - 1]!;
        lines[previous.end] = ensureJsonTrailingComma(lines[previous.end] ?? "");
      }
      const reference = jsonRecordReferenceRow(table, target.lineOffset);
      const trailing = target.lineOffset < table.lines.length ? "," : "";
      lines.splice(insertAt, 0, ...serializeJsonRecordRow(table.columns, target.cells, reference, trailing));
      return lines.join("\n");
    }
    const target = insertDatasetRow(table, op);
    const literal = JSON.stringify(target.cells);
    if (table.inlineEmptyRowsLine) {
      lines.splice(
        table.inlineEmptyRowsLine.index,
        1,
        `${table.inlineEmptyRowsLine.indent}${table.inlineEmptyRowsLine.prefix}[`,
        `${table.rowIndent}${literal}`,
        `${table.inlineEmptyRowsLine.indent}]${table.inlineEmptyRowsLine.trailing}`,
      );
      return lines.join("\n");
    }
    const insertAt = jsonDatasetInsertLineIndex(table, target.lineOffset);
    if (target.lineOffset >= table.lines.length && table.lines.length > 0) {
      const previous = table.lines[table.lines.length - 1]!;
      lines[previous.index] = ensureJsonTrailingComma(lines[previous.index] ?? "");
    }
    const trailing = target.lineOffset < table.lines.length ? "," : "";
    lines.splice(insertAt, 0, `${table.rowIndent}${literal}${trailing}`);
    return lines.join("\n");
  }
  throw new PatchError("invalid_content", `source-preserving insert_dataset_row does not support ${format} datasets`, op);
}

function applySrcDeleteDatasetRow(
  source: string,
  op: Extract<PatchOp, { op: "delete_dataset_row" }>,
): string {
  const { node, start, end } = locate(source, op.id, op);
  if (!isDatasetDirective(node)) {
    throw new PatchError("invalid_content", `block "${op.id}" is not a dataset directive`, op);
  }
  const lines = source.split("\n");
  const format = datasetFormat(node);
  if (format === "csv" || format === "tsv") {
    const delimiter = format === "tsv" ? "\t" : ",";
    const table = sourceDelimitedDatasetRows(lines, start, end, delimiter, op);
    const target = deleteDatasetRow(table, op);
    const sourceLine = table.lines[target.lineOffset + 1];
    if (!sourceLine) throw new PatchError("invalid_content", `dataset row ${op.row} is out of range`, op);
    lines.splice(sourceLine.index, 1);
    return lines.join("\n");
  }
  if (format === "yaml") {
    const table = sourceYamlDatasetRows(lines, start, end, node, op);
    const deletingLast = table.rows.length === 1;
    const target = deleteDatasetRow(table, op);
    const sourceLine = table.lines[target.lineOffset];
    if (!sourceLine) throw new PatchError("invalid_content", `dataset row ${op.row} is out of range`, op);
    if (deletingLast) {
      lines[table.rowsLineIndex] = rewriteYamlRowsLineAsEmpty(lines[table.rowsLineIndex] ?? "", op);
    }
    lines.splice(sourceLine.index, 1);
    return lines.join("\n");
  }
  if (format === "json") {
    const table = sourceJsonDatasetRows(lines, start, end, node, op);
    if (table.sourceShape === "records") {
      const deletingLast = op.row === table.rows.length - 1;
      const target = deleteDatasetRow(table, op);
      const sourceRow = table.lines[target.lineOffset];
      if (!sourceRow) throw new PatchError("invalid_content", `dataset row ${op.row} is out of range`, op);
      lines.splice(sourceRow.start, sourceRow.end - sourceRow.start + 1);
      if (deletingLast && table.lines.length > 1) {
        const previous = table.lines[target.lineOffset - 1];
        if (previous) lines[previous.end] = removeJsonTrailingComma(lines[previous.end] ?? "");
      }
      return lines.join("\n");
    }
    const deletingLast = op.row === table.rows.length - 1;
    const target = deleteDatasetRow(table, op);
    const sourceLine = table.lines[target.lineOffset];
    if (!sourceLine) throw new PatchError("invalid_content", `dataset row ${op.row} is out of range`, op);
    lines.splice(sourceLine.index, 1);
    if (deletingLast && table.lines.length > 1) {
      const previous = table.lines[target.lineOffset - 1];
      if (previous) {
        const previousIndex = previous.index > sourceLine.index ? previous.index - 1 : previous.index;
        lines[previousIndex] = removeJsonTrailingComma(lines[previousIndex] ?? "");
      }
    }
    return lines.join("\n");
  }
  throw new PatchError("invalid_content", `source-preserving delete_dataset_row does not support ${format} datasets`, op);
}

function applySrcInsertDatasetColumn(
  source: string,
  op: Extract<PatchOp, { op: "insert_dataset_column" }>,
): string {
  const { node, start, end } = locate(source, op.id, op);
  if (!isDatasetDirective(node)) {
    throw new PatchError("invalid_content", `block "${op.id}" is not a dataset directive`, op);
  }
  const lines = source.split("\n");
  const format = datasetFormat(node);
  if (format === "csv" || format === "tsv") {
    const delimiter = format === "tsv" ? "\t" : ",";
    const table = sourceDelimitedDatasetRows(lines, start, end, delimiter, op);
    insertDatasetColumn(table, op);
    rewriteSourceDelimitedDatasetRows(lines, table, delimiter, op);
    return lines.join("\n");
  }
  if (format === "yaml") {
    const table = sourceYamlDatasetRows(lines, start, end, node, op);
    const target = insertDatasetColumn(table, op);
    rewriteSourceYamlDatasetRows(lines, table);
    insertSourceYamlSchemaLine(lines, table, target.column, op.header, inferDatasetType(target.values.map(datasetScalarText)), op);
    return lines.join("\n");
  }
  if (format === "json") {
    const table = sourceJsonDatasetRows(lines, start, end, node, op);
    if (table.sourceShape === "records") {
      insertDatasetColumn(table, op);
      rewriteSourceJsonRecordDatasetRows(lines, table);
      return lines.join("\n");
    }
    if (table.sourceShape !== "object") {
      throw new PatchError("invalid_content", `source-preserving insert_dataset_column requires JSON columns in the dataset body`, op);
    }
    insertDatasetColumn(table, op);
    rewriteSourceJsonColumnsLine(lines, table, op);
    rewriteSourceJsonArrayDatasetRows(lines, table);
    return lines.join("\n");
  }
  throw new PatchError("invalid_content", `source-preserving insert_dataset_column does not support ${format} datasets`, op);
}

function applySrcDeleteDatasetColumn(
  source: string,
  op: Extract<PatchOp, { op: "delete_dataset_column" }>,
): string {
  const { node, start, end } = locate(source, op.id, op);
  if (!isDatasetDirective(node)) {
    throw new PatchError("invalid_content", `block "${op.id}" is not a dataset directive`, op);
  }
  const lines = source.split("\n");
  const format = datasetFormat(node);
  if (format === "csv" || format === "tsv") {
    const delimiter = format === "tsv" ? "\t" : ",";
    const table = sourceDelimitedDatasetRows(lines, start, end, delimiter, op);
    deleteDatasetColumn(table, op);
    rewriteSourceDelimitedDatasetRows(lines, table, delimiter, op);
    return lines.join("\n");
  }
  if (format === "yaml") {
    const table = sourceYamlDatasetRows(lines, start, end, node, op);
    const target = deleteDatasetColumn(table, op);
    rewriteSourceYamlDatasetRows(lines, table);
    deleteSourceYamlSchemaLine(lines, table, target.header, op);
    return lines.join("\n");
  }
  if (format === "json") {
    const table = sourceJsonDatasetRows(lines, start, end, node, op);
    if (table.sourceShape === "records") {
      deleteDatasetColumn(table, op);
      rewriteSourceJsonRecordDatasetRows(lines, table);
      return lines.join("\n");
    }
    if (table.sourceShape !== "object") {
      throw new PatchError("invalid_content", `source-preserving delete_dataset_column requires JSON columns in the dataset body`, op);
    }
    deleteDatasetColumn(table, op);
    rewriteSourceJsonColumnsLine(lines, table, op);
    rewriteSourceJsonArrayDatasetRows(lines, table);
    return lines.join("\n");
  }
  throw new PatchError("invalid_content", `source-preserving delete_dataset_column does not support ${format} datasets`, op);
}

function rewriteSourceTableRows(lines: string[], table: TableDirectiveRows): void {
  const rows = allTableRows(table);
  for (let i = 0; i < table.lines.length; i++) {
    const sourceLine = table.lines[i]!;
    const row = rows[i];
    if (row) lines[sourceLine.index] = serializePipeRow(row, sourceLine.indent);
  }
}

function rewriteSourceDelimitedDatasetRows(
  lines: string[],
  table: SourceDelimitedDatasetRows,
  delimiter: "," | "\t",
  op: PatchOp,
): void {
  const rows = [table.columns, ...table.rows.map((row) => row.map(datasetScalarText))];
  if (rows.some((row) => row.some((cell) => /[\r\n]/.test(cell)))) {
    throw new PatchError("invalid_content", `dataset cell value must be a single line`, op);
  }
  for (let i = 0; i < table.lines.length; i++) {
    const sourceLine = table.lines[i]!;
    const row = rows[i];
    if (row) lines[sourceLine.index] = `${sourceLine.indent}${serializeDelimitedRow(row, delimiter)}`;
  }
}

function rewriteSourceYamlDatasetRows(lines: string[], table: SourceYamlDatasetRows): void {
  for (let i = 0; i < table.lines.length; i++) {
    const sourceLine = table.lines[i]!;
    const row = table.rows[i];
    if (row) lines[sourceLine.index] = `${sourceLine.indent}- ${serializeYamlFlowRow(row)}${sourceLine.trailing}`;
  }
}

function insertSourceYamlSchemaLine(
  lines: string[],
  table: SourceYamlDatasetRows,
  column: number,
  header: string,
  schemaValue: string,
  op: PatchOp,
): void {
  if (table.schemaLineIndex === undefined) {
    throw new PatchError("invalid_content", `source-preserving insert_dataset_column requires a YAML schema block`, op);
  }
  const indent = yamlSchemaIndent(table);
  const insertAt = yamlSchemaInsertLineIndex(table, column);
  lines.splice(insertAt, 0, `${indent}${header}: ${schemaValue}`);
}

function deleteSourceYamlSchemaLine(
  lines: string[],
  table: SourceYamlDatasetRows,
  header: string,
  op: PatchOp,
): void {
  const sourceLine = table.schemaLines.get(header);
  if (!sourceLine) {
    throw new PatchError("invalid_content", `source-preserving delete_dataset_column could not map YAML schema column "${header}"`, op);
  }
  lines.splice(sourceLine.index, 1);
}

function yamlSchemaIndent(table: SourceYamlDatasetRows): string {
  const sourceLine = table.schemaOrder[0];
  return sourceLine?.indent ?? `${table.schemaKeyIndent}  `;
}

function yamlSchemaInsertLineIndex(table: SourceYamlDatasetRows, column: number): number {
  const existingColumn = table.columns[column];
  const existing = existingColumn ? table.schemaLines.get(existingColumn) : undefined;
  if (existing) return existing.index;
  const previousColumn = table.columns[column - 1];
  const previous = previousColumn ? table.schemaLines.get(previousColumn) : undefined;
  if (previous) return previous.index + 1;
  return (table.schemaLineIndex ?? table.rowsLineIndex) + 1;
}

function rewriteSourceJsonColumnsLine(lines: string[], table: SourceJsonArrayDatasetRows, op: PatchOp): void {
  if (!table.columnsLine) {
    throw new PatchError("invalid_content", `source-preserving dataset column edits require a one-line JSON columns array`, op);
  }
  lines[table.columnsLine.index] = `${table.columnsLine.indent}${table.columnsLine.prefix}${JSON.stringify(table.columns)}${table.columnsLine.trailing}`;
}

function rewriteSourceJsonArrayDatasetRows(lines: string[], table: SourceJsonArrayDatasetRows): void {
  for (let i = 0; i < table.lines.length; i++) {
    const sourceLine = table.lines[i]!;
    const row = table.rows[i];
    if (row) lines[sourceLine.index] = `${sourceLine.indent}${JSON.stringify(row)}${sourceLine.trailing}`;
  }
}

function rewriteSourceJsonRecordDatasetRows(lines: string[], table: SourceJsonRecordDatasetRows): void {
  for (let i = table.lines.length - 1; i >= 0; i--) {
    const sourceRow = table.lines[i]!;
    const row = table.rows[i];
    if (!row) continue;
    const trailing = /\},?\s*$/.test(lines[sourceRow.end] ?? "") && (lines[sourceRow.end] ?? "").trim().endsWith(",") ? "," : "";
    lines.splice(sourceRow.start, sourceRow.end - sourceRow.start + 1, ...serializeJsonRecordRow(table.columns, row, sourceRow, trailing));
  }
}

function tableRowIndent(table: TableDirectiveRows, lineOffset: number): string {
  const sourceLine = table.lines[lineOffset] ?? table.lines[Math.max(0, lineOffset - 1)] ?? table.lines[0];
  return sourceLine?.indent ?? "";
}

function tableInsertLineIndex(table: TableDirectiveRows, lineOffset: number, end: number): number {
  const existing = table.lines[lineOffset];
  if (existing) return existing.index;
  const previous = table.lines[Math.max(0, lineOffset - 1)];
  return previous ? previous.index + 1 : end - 1;
}

function delimitedDatasetRowIndent(table: SourceDelimitedDatasetRows, row: number): string {
  const sourceLine = table.lines[row + 1] ?? table.lines[row] ?? table.lines[0];
  return sourceLine?.indent ?? "";
}

function delimitedDatasetInsertLineIndex(table: SourceDelimitedDatasetRows, row: number, end: number): number {
  const existing = table.lines[row + 1];
  if (existing) return existing.index;
  const previous = table.lines[row] ?? table.lines[0];
  return previous ? previous.index + 1 : end - 1;
}

function yamlDatasetRowIndent(table: SourceYamlDatasetRows, row: number): string {
  const sourceLine = table.lines[row] ?? table.lines[Math.max(0, row - 1)] ?? table.lines[0];
  return sourceLine?.indent ?? `${table.rowsKeyIndent}  `;
}

function yamlDatasetInsertLineIndex(table: SourceYamlDatasetRows, row: number, end: number): number {
  const existing = table.lines[row];
  if (existing) return existing.index;
  const previous = table.lines[Math.max(0, row - 1)];
  if (previous) return previous.index + 1;
  return table.rowsLineIndex >= 0 ? table.rowsLineIndex + 1 : end - 1;
}

function rewriteYamlRowsLineAsBlock(line: string, op: PatchOp): string {
  const next = line.replace(/^(\s*rows\s*:)\s*\[\]\s*(#.*)?\s*$/, (_match, prefix: string, comment?: string) =>
    `${prefix}${comment ? ` ${comment}` : ""}`,
  );
  if (next === line && /\[\]/.test(line)) return next;
  if (next === line && !/^\s*rows\s*:\s*(?:#.*)?$/.test(line)) {
    throw new PatchError("invalid_content", `source-preserving insert_dataset_row requires a block YAML rows array`, op);
  }
  return next;
}

function rewriteYamlRowsLineAsEmpty(line: string, op: PatchOp): string {
  const next = line.replace(/^(\s*rows\s*:)(?:\s*(#.*))?\s*$/, (_match, prefix: string, comment?: string) =>
    `${prefix} []${comment ? ` ${comment}` : ""}`,
  );
  if (next === line) {
    throw new PatchError("invalid_content", `source-preserving delete_dataset_row could not rewrite YAML rows as empty`, op);
  }
  return next;
}

interface SourceDelimitedDatasetRows extends DatasetDirectiveRows {
  lines: Array<{ index: number; indent: string }>;
}

interface SourceYamlDatasetRows extends DatasetDirectiveRows {
  lines: Array<{ index: number; indent: string; trailing: string }>;
  rowsLineIndex: number;
  rowsKeyIndent: string;
  schemaLineIndex?: number;
  schemaKeyIndent: string;
  schemaLines: Map<string, { index: number; indent: string }>;
  schemaOrder: Array<{ key: string; index: number; indent: string }>;
}

interface SourceJsonArrayDatasetRows extends DatasetDirectiveRows {
  sourceShape: "arrays" | "object";
  lines: Array<{ index: number; indent: string; trailing: string }>;
  rowsStartIndex: number;
  rowsEndIndex: number;
  rowIndent: string;
  inlineEmptyRowsLine?: { index: number; indent: string; prefix: string; trailing: string };
  columnsLine?: { index: number; indent: string; prefix: string; trailing: string };
}

interface SourceJsonRecordDatasetRows extends DatasetDirectiveRows {
  sourceShape: "records";
  lines: SourceJsonRecordRow[];
  rowsStartIndex: number;
  rowsEndIndex: number;
  rowIndent: string;
  propertyIndent: string;
}

interface SourceJsonRecordRow {
  propertyLines: Map<string, number>;
  start: number;
  end: number;
  indent: string;
  propertyIndent: string;
  multiline: boolean;
}

type SourceJsonDatasetRows = SourceJsonArrayDatasetRows | SourceJsonRecordDatasetRows;

function sourceDelimitedDatasetRows(
  sourceLines: string[],
  start: number,
  end: number,
  delimiter: "," | "\t",
  op: PatchOp,
): SourceDelimitedDatasetRows {
  const lines: SourceDelimitedDatasetRows["lines"] = [];
  const rows: string[][] = [];
  for (let i = start; i < end - 1; i++) {
    const line = sourceLines[i] ?? "";
    if (!line.trim()) continue;
    lines.push({ index: i, indent: line.match(/^\s*/)?.[0] ?? "" });
    rows.push(splitDelimitedRow(line.trim(), delimiter));
  }
  if (rows.length < 1) throw new PatchError("invalid_content", `dataset must have a header row`, op);
  return { columns: rows[0]!, rows: rows.slice(1), lines };
}

function sourceYamlDatasetRows(
  sourceLines: string[],
  start: number,
  end: number,
  node: DirectiveNode,
  op: PatchOp,
): SourceYamlDatasetRows {
  const body = sourceLines.slice(start, end - 1).join("\n");
  const parsed = loadYamlDatasetText(body, node.id, op);
  const rows = parsed.rows;
  if (!Array.isArray(rows)) throw new PatchError("invalid_content", `dataset "${node.id ?? "?"}" has no rows array`, op);
  const lines: SourceYamlDatasetRows["lines"] = [];
  const parsedRows: unknown[][] = [];
  let insideRows = false;
  let rowsIndent = -1;
  let rowsLineIndex = -1;
  let rowsKeyIndent = "";
  for (let i = start; i < end - 1; i++) {
    const line = sourceLines[i] ?? "";
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const indent = line.match(/^\s*/)?.[0] ?? "";
    if (!insideRows) {
      const rowsMatch = line.match(/^(\s*)rows\s*:/);
      if (rowsMatch) {
        insideRows = true;
        rowsIndent = indent.length;
        rowsLineIndex = i;
        rowsKeyIndent = rowsMatch[1] ?? "";
      }
      continue;
    }
    if (indent.length <= rowsIndent && !trimmed.startsWith("-")) break;
    const match = line.match(/^(\s*)-\s*(\[.*\])(\s+#.*)?\s*$/);
    if (!match) {
      if (trimmed.startsWith("-")) {
        throw new PatchError("invalid_content", `source-preserving dataset row edits require inline YAML row arrays`, op);
      }
      continue;
    }
    let row: unknown;
    try {
      row = yaml.load(match[2] ?? "");
    } catch {
      throw new PatchError("invalid_content", `dataset row is not valid YAML`, op);
    }
    if (!Array.isArray(row)) {
      throw new PatchError("invalid_content", `source-preserving dataset row edits require inline YAML row arrays`, op);
    }
    lines.push({ index: i, indent: match[1] ?? "", trailing: match[3] ?? "" });
    parsedRows.push([...row]);
  }
  if (parsedRows.length !== rows.filter(Array.isArray).length) {
    throw new PatchError("invalid_content", `source-preserving dataset row edits could not map every YAML row`, op);
  }
  if (rowsLineIndex === -1) {
    throw new PatchError("invalid_content", `source-preserving dataset row edits could not locate YAML rows`, op);
  }
  const schemaSource = sourceYamlSchemaLines(sourceLines, start, end);
  return {
    columns: datasetColumnsFromYaml(node, parsed, rows),
    rows: parsedRows,
    schema: recordValue(parsed.schema),
    lines,
    rowsLineIndex,
    rowsKeyIndent,
    ...schemaSource,
  };
}

function sourceYamlSchemaLines(
  sourceLines: string[],
  start: number,
  end: number,
): Pick<SourceYamlDatasetRows, "schemaLineIndex" | "schemaKeyIndent" | "schemaLines" | "schemaOrder"> {
  const schemaLines = new Map<string, { index: number; indent: string }>();
  const schemaOrder: Array<{ key: string; index: number; indent: string }> = [];
  let schemaLineIndex: number | undefined;
  let schemaIndent = -1;
  let schemaKeyIndent = "";
  for (let i = start; i < end - 1; i++) {
    const line = sourceLines[i] ?? "";
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const indent = line.match(/^\s*/)?.[0] ?? "";
    if (schemaLineIndex === undefined) {
      const schemaMatch = line.match(/^(\s*)schema\s*:/);
      if (schemaMatch) {
        schemaLineIndex = i;
        schemaIndent = indent.length;
        schemaKeyIndent = schemaMatch[1] ?? "";
      }
      continue;
    }
    if (indent.length <= schemaIndent && /^[A-Za-z_][\w-]*\s*:/.test(trimmed)) break;
    const propertyMatch = line.match(/^(\s*)([A-Za-z_][\w-]*)\s*:/);
    if (!propertyMatch || indent.length <= schemaIndent) continue;
    const key = propertyMatch[2] ?? "";
    const sourceLine = { key, index: i, indent: propertyMatch[1] ?? "" };
    schemaLines.set(key, { index: i, indent: sourceLine.indent });
    schemaOrder.push(sourceLine);
  }
  return { schemaLineIndex, schemaKeyIndent, schemaLines, schemaOrder };
}

function serializeYamlFlowRow(cells: unknown[]): string {
  return yaml.dump(cells, { flowLevel: 0, lineWidth: -1, noRefs: true }).trim();
}

function sourceJsonDatasetRows(
  sourceLines: string[],
  start: number,
  end: number,
  node: DirectiveNode,
  op: PatchOp,
): SourceJsonDatasetRows {
  const body = sourceLines.slice(start, end - 1).join("\n");
  const table = parseJsonDatasetText(body, node, op);
  if (table.sourceShape === "records") {
    const sourceRows = sourceJsonRecordRows(sourceLines, start, end, table.columns, op);
    if (sourceRows.lines.length !== table.rows.length) {
      throw new PatchError("invalid_content", `source-preserving update_dataset_cell could not map every JSON record row`, op);
    }
    return { ...table, sourceShape: "records", ...sourceRows };
  }
  const sourceRows = sourceJsonArrayRows(sourceLines, start, end, table.sourceShape === "object", op);
  if (sourceRows.lines.length !== table.rows.length) {
    throw new PatchError("invalid_content", `source-preserving update_dataset_cell could not map every JSON row array`, op);
  }
  return { ...table, sourceShape: table.sourceShape === "object" ? "object" : "arrays", ...sourceRows };
}

function sourceJsonArrayRows(
  sourceLines: string[],
  start: number,
  end: number,
  objectRows: boolean,
  op: PatchOp,
): Pick<SourceJsonArrayDatasetRows, "lines" | "rowsStartIndex" | "rowsEndIndex" | "rowIndent" | "inlineEmptyRowsLine" | "columnsLine"> {
  const bounds = sourceJsonArrayBounds(sourceLines, start, end, objectRows, op);
  const out: Array<{ index: number; indent: string; trailing: string }> = [];
  for (let i = bounds.rowsStartIndex + 1; i < bounds.rowsEndIndex; i++) {
    const line = sourceLines[i] ?? "";
    const trimmed = line.trim();
    if (!trimmed.startsWith("[") || trimmed === "[" || trimmed === "],") continue;
    const trailing = trimmed.endsWith(",") ? "," : "";
    const candidate = trailing ? trimmed.slice(0, -1).trimEnd() : trimmed;
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate);
    } catch {
      continue;
    }
    if (!Array.isArray(parsed)) continue;
    out.push({ index: i, indent: line.match(/^\s*/)?.[0] ?? "", trailing });
  }
  const rowIndent = out[0]?.indent ?? bounds.rowIndent;
  return { lines: out, rowsStartIndex: bounds.rowsStartIndex, rowsEndIndex: bounds.rowsEndIndex, rowIndent, inlineEmptyRowsLine: bounds.inlineEmptyRowsLine, columnsLine: bounds.columnsLine };
}

function sourceJsonArrayBounds(
  sourceLines: string[],
  start: number,
  end: number,
  objectRows: boolean,
  op: PatchOp,
): {
  rowsStartIndex: number;
  rowsEndIndex: number;
  rowIndent: string;
  inlineEmptyRowsLine?: { index: number; indent: string; prefix: string; trailing: string };
  columnsLine?: { index: number; indent: string; prefix: string; trailing: string };
} {
  let columnsLine: { index: number; indent: string; prefix: string; trailing: string } | undefined;
  for (let i = start; i < end - 1; i++) {
    const line = sourceLines[i] ?? "";
    const trimmed = line.trim();
    const indent = line.match(/^\s*/)?.[0] ?? "";
    if (objectRows) {
      const columnsMatch = line.match(/^(\s*)("columns"\s*:\s*)(\[.*\])(\s*,?)\s*$/);
      if (columnsMatch) {
        try {
          if (Array.isArray(JSON.parse(columnsMatch[3] ?? ""))) {
            columnsLine = {
              index: i,
              indent: columnsMatch[1] ?? "",
              prefix: columnsMatch[2] ?? "\"columns\": ",
              trailing: columnsMatch[4] ?? "",
            };
          }
        } catch {
          // Keep scanning; the parser will reject invalid JSON before source mapping is used.
        }
      }
      const inlineEmpty = line.match(/^(\s*)("rows"\s*:\s*)\[\]\s*(,?)\s*$/);
      if (inlineEmpty) {
        return {
          rowsStartIndex: i,
          rowsEndIndex: i,
          rowIndent: `${indent}  `,
          columnsLine,
          inlineEmptyRowsLine: {
            index: i,
            indent: inlineEmpty[1] ?? "",
            prefix: inlineEmpty[2] ?? "\"rows\": ",
            trailing: inlineEmpty[3] ?? "",
          },
        };
      }
      if (!/^"rows"\s*:\s*\[\s*$/.test(trimmed)) continue;
    } else if (trimmed !== "[") {
      continue;
    }
    for (let close = i + 1; close < end - 1; close++) {
      const closeLine = sourceLines[close] ?? "";
      if (/^\s*\]\s*,?\s*$/.test(closeLine)) {
        return {
          rowsStartIndex: i,
          rowsEndIndex: close,
          rowIndent: `${indent}  `,
          columnsLine,
        };
      }
    }
    break;
  }
  throw new PatchError("invalid_content", `source-preserving dataset row edits require a mappable JSON row array`, op);
}

function jsonDatasetInsertLineIndex(table: SourceJsonArrayDatasetRows, row: number): number {
  const existing = table.lines[row];
  if (existing) return existing.index;
  const previous = table.lines[Math.max(0, row - 1)];
  if (previous) return previous.index + 1;
  return table.rowsEndIndex;
}

function ensureJsonTrailingComma(line: string): string {
  return /,\s*$/.test(line) ? line : line.replace(/\s*$/, ",");
}

function removeJsonTrailingComma(line: string): string {
  return line.replace(/,\s*$/, "");
}

function sourceJsonRecordRows(
  sourceLines: string[],
  start: number,
  end: number,
  columns: string[],
  op: PatchOp,
): Pick<SourceJsonRecordDatasetRows, "lines" | "rowsStartIndex" | "rowsEndIndex" | "rowIndent" | "propertyIndent"> {
  const bounds = sourceJsonRecordArrayBounds(sourceLines, start, end, op);
  const out: SourceJsonRecordRow[] = [];
  for (let i = bounds.rowsStartIndex + 1; i < bounds.rowsEndIndex; i++) {
    const line = sourceLines[i] ?? "";
    const trimmed = line.trim();
    if (!trimmed.startsWith("{")) continue;
    const block = jsonObjectBlock(sourceLines, i, bounds.rowsEndIndex + 1);
    if (!block) continue;
    const candidate = stripJsonTrailingComma(block.lines.join("\n"));
    let parsed: unknown;
    try {
      parsed = JSON.parse(candidate);
    } catch {
      continue;
    }
    if (!recordValue(parsed)) continue;
    const propertyLines = new Map<string, number>();
    if (block.lines.length === 1) {
      for (const column of columns) {
        if (jsonLineHasProperty(block.lines[0] ?? "", column)) propertyLines.set(column, i);
      }
    } else {
      for (let offset = 0; offset < block.lines.length; offset++) {
        const sourceLine = block.lines[offset] ?? "";
        for (const column of columns) {
          if (jsonLineHasProperty(sourceLine, column)) propertyLines.set(column, i + offset);
        }
      }
    }
    const indent = line.match(/^\s*/)?.[0] ?? "";
    const propertyIndent = jsonRecordPropertyIndent(block.lines, indent);
    if (propertyLines.size > 0) {
      out.push({
        propertyLines,
        start: i,
        end: block.end,
        indent,
        propertyIndent,
        multiline: block.lines.length > 1,
      });
    }
    i = block.end;
  }
  if (out.length === 0) {
    throw new PatchError("invalid_content", `source-preserving update_dataset_cell requires mappable JSON record rows`, op);
  }
  return {
    lines: out,
    rowsStartIndex: bounds.rowsStartIndex,
    rowsEndIndex: bounds.rowsEndIndex,
    rowIndent: out[0]?.indent ?? bounds.rowIndent,
    propertyIndent: out[0]?.propertyIndent ?? `${bounds.rowIndent}  `,
  };
}

function sourceJsonRecordArrayBounds(
  sourceLines: string[],
  start: number,
  end: number,
  op: PatchOp,
): { rowsStartIndex: number; rowsEndIndex: number; rowIndent: string } {
  for (let i = start; i < end - 1; i++) {
    const line = sourceLines[i] ?? "";
    const trimmed = line.trim();
    if (trimmed !== "[") continue;
    const indent = line.match(/^\s*/)?.[0] ?? "";
    for (let close = i + 1; close < end - 1; close++) {
      const closeLine = sourceLines[close] ?? "";
      if (/^\s*\]\s*$/.test(closeLine)) {
        return { rowsStartIndex: i, rowsEndIndex: close, rowIndent: `${indent}  ` };
      }
    }
    break;
  }
  throw new PatchError("invalid_content", `source-preserving dataset row edits require a mappable JSON record array`, op);
}

function jsonRecordPropertyIndent(lines: string[], rowIndent: string): string {
  for (const line of lines.slice(1, -1)) {
    if (jsonLineHasAnyProperty(line)) return line.match(/^\s*/)?.[0] ?? `${rowIndent}  `;
  }
  return `${rowIndent}  `;
}

function jsonLineHasAnyProperty(line: string): boolean {
  return /"(?:(?:\\.)|[^"\\])*"\s*:/.test(line);
}

function jsonRecordDatasetInsertLineIndex(table: SourceJsonRecordDatasetRows, row: number): number {
  const existing = table.lines[row];
  if (existing) return existing.start;
  const previous = table.lines[Math.max(0, row - 1)];
  if (previous) return previous.end + 1;
  return table.rowsEndIndex;
}

function jsonRecordReferenceRow(table: SourceJsonRecordDatasetRows, row: number): SourceJsonRecordRow {
  const sourceRow = table.lines[row] ?? table.lines[Math.max(0, row - 1)] ?? table.lines[0];
  if (!sourceRow) {
    return {
      propertyLines: new Map(),
      start: table.rowsStartIndex,
      end: table.rowsStartIndex,
      indent: table.rowIndent,
      propertyIndent: table.propertyIndent,
      multiline: false,
    };
  }
  return sourceRow;
}

function serializeJsonRecordRow(
  columns: string[],
  cells: unknown[],
  reference: SourceJsonRecordRow,
  trailing: string,
): string[] {
  const pairs = columns.map((column, index) => [column, cells[index] ?? null] as const);
  if (!reference.multiline) {
    const fields = pairs.map(([key, value]) => `${JSON.stringify(key)}: ${JSON.stringify(value)}`).join(", ");
    return [`${reference.indent}{ ${fields} }${trailing}`];
  }
  const lines = [`${reference.indent}{`];
  pairs.forEach(([key, value], index) => {
    const comma = index === pairs.length - 1 ? "" : ",";
    lines.push(`${reference.propertyIndent}${JSON.stringify(key)}: ${JSON.stringify(value)}${comma}`);
  });
  lines.push(`${reference.indent}}${trailing}`);
  return lines;
}

function jsonObjectBlock(
  sourceLines: string[],
  startIndex: number,
  end: number,
): { end: number; lines: string[] } | undefined {
  const first = sourceLines[startIndex] ?? "";
  const firstTrimmed = first.trim();
  if (firstTrimmed.includes("}") && stripJsonTrailingComma(firstTrimmed).endsWith("}")) {
    return { end: startIndex, lines: [first] };
  }
  const lines: string[] = [];
  for (let i = startIndex; i < end - 1; i++) {
    const line = sourceLines[i] ?? "";
    lines.push(line);
    if (line.trim().startsWith("}")) return { end: i, lines };
  }
  return undefined;
}

function stripJsonTrailingComma(text: string): string {
  return text.replace(/,\s*$/, "");
}

function jsonLineHasProperty(line: string, key: string): boolean {
  return new RegExp(`${escapeRegExp(JSON.stringify(key))}\\s*:`).test(line);
}

function rewriteJsonPropertyLine(
  line: string,
  key: string,
  value: unknown,
  op: PatchOp,
): string {
  const literal = JSON.stringify(value ?? null);
  const valuePattern = `"(?:(?:\\\\.)|[^"\\\\])*"|true|false|null|-?\\d+(?:\\.\\d+)?(?:[eE][+-]?\\d+)?`;
  const pattern = new RegExp(`(${escapeRegExp(JSON.stringify(key))}\\s*:\\s*)(?:${valuePattern})(\\s*(?:,|}|$))`);
  const next = line.replace(pattern, (_match, prefix: string, suffix: string) => `${prefix}${literal}${suffix}`);
  if (next === line) {
    throw new PatchError("invalid_content", `source-preserving update_dataset_cell could not rewrite JSON property "${key}"`, op);
  }
  return next;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function applySrcMove(
  source: string,
  op: Extract<PatchOp, { op: "move_block" }>,
): string {
  const doc = parse(source);
  const node = findById(doc, op.id);
  if (!node) throw new PatchError("target_missing", `block "${op.id}" not found`, op);
  if (!isDirective(node)) {
    throw new PatchError("invalid_content", `block "${op.id}" is not a directive block`, op);
  }
  const parent = findById(doc, op.parent);
  if (!parent) throw new PatchError("parent_missing", `parent "${op.parent}" not found`, op);
  if (!hasChildren(parent)) {
    throw new PatchError("parent_missing", `parent "${op.parent}" cannot have children`, op);
  }
  if (containsId(node, op.parent)) {
    throw new PatchError("invalid_content", `cannot move "${op.id}" into itself or its descendants`, op);
  }
  const start = node.pos?.line;
  const end = node.endLine;
  if (!start || !end) throw new Error(`block "${op.id}" has no source span`);
  const lines = source.split("\n");
  const sourceDepth = directiveFenceDepth(node, lines);
  const targetDepth = parent.type === "directive" ? directiveFenceDepth(parent, lines) + 1 : 2;
  const content = normalizeDirectiveFenceDepth(
    lines.slice(start - 1, end).join("\n"),
    sourceDepth,
    targetDepth,
  );
  let deleted = applySrcDelete(source, { op: "delete_block", id: op.id });
  if (start === 1 && deleted.startsWith("\n")) deleted = deleted.slice(1);
  return applySrcAdd(deleted, {
    op: "add_block",
    parent: op.parent,
    content,
    ...(op.position !== undefined ? { position: op.position } : {}),
  });
}

function directiveFenceDepth(node: DirectiveNode, lines: string[]): number {
  const start = node.pos?.line;
  const line = start ? lines[start - 1] : undefined;
  return line?.match(/^\s*(:{2,})/)?.[1]?.length ?? 2;
}

function normalizeDirectiveFenceDepth(content: string, from: number, to: number): string {
  if (from === to) return content;
  const delta = to - from;
  let inFence = false;
  return content
    .split("\n")
    .map((line) => {
      if (/^\s*```/.test(line)) {
        inFence = !inFence;
        return line;
      }
      if (inFence) return line;
      const match = line.match(/^(\s*)(:{2,})(.*)$/);
      if (!match) return line;
      const rest = match[3] ?? "";
      if (!/^\s*(?:[a-zA-Z_]|$)/.test(rest)) return line;
      const depth = match[2]!.length;
      if (depth < from) return line;
      return `${match[1] ?? ""}${":".repeat(Math.max(2, depth + delta))}${rest}`;
    })
    .join("\n");
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

function rewriteOpenLineRemoveAttr(
  line: string,
  key: string,
  op: PatchOp,
): string {
  const openMatch = line.match(/^(\s*:{2,}\s*[a-zA-Z_][\w-]*(?:::[a-zA-Z_][\w-]*)*)(\s*\{)?(.*?)(\}\s*)?$/);
  if (!openMatch) {
    throw new PatchError("invalid_content", `malformed open line for "${(op as { id?: string }).id}"`, op);
  }
  const head = openMatch[1] ?? "";
  const inner = openMatch[3] ?? "";
  const trailing = (line.match(/\s*$/) ?? [""])[0];

  let removed = false;
  const kept: string[] = [];
  inner.replace(ATTR_TOKEN_RE, (m, k) => {
    if (k !== key) {
      kept.push(m);
      return m;
    }
    removed = true;
    return "";
  });
  const rewrittenInner = kept.join(" ").trim();
  if (!removed) return line;
  if (!rewrittenInner) {
    return `${head}${trailing}`.replace(/\s+$/, "") + (line.endsWith("\n") ? "\n" : "");
  }
  return `${head}{${rewrittenInner}}${trailing}`.replace(/\s+$/, "") + (line.endsWith("\n") ? "\n" : "");
}

function rewriteCommentResolutionAttrs(
  line: string,
  op: Extract<PatchOp, { op: "resolve_comment" }>,
): string {
  let next = rewriteOpenLineAttr(line, "status", "resolved", op);
  if (op.resolved_by) next = rewriteOpenLineAttr(next, "resolved_by", op.resolved_by, op);
  if (op.resolved_at) next = rewriteOpenLineAttr(next, "resolved_at", op.resolved_at, op);
  return next;
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

function serializeCommentBlock(op: Extract<PatchOp, { op: "add_comment" }>): string {
  if (!op.content.trim()) {
    throw new PatchError("invalid_content", `comment content must not be empty`, op);
  }
  const attrs = Object.entries(commentAttrs(op))
    .map(([key, value]) => serializeOneAttr(key, value))
    .join(" ");
  const content = op.content.replace(/\n+$/, "");
  const source = `::comment{${attrs}}\n${content}\n::`;
  parseFragment(source, op);
  return source;
}

function serializeNoteBlock(op: AddNoteOp): string {
  validateNoteOp(op);
  const attrs = Object.entries(noteAttrs(op))
    .map(([key, value]) => serializeOneAttr(key, value))
    .join(" ");
  const content = op.content.replace(/\n+$/, "");
  const source = `::${op.op === "add_footnote" ? "footnote" : "endnote"}{${attrs}}\n${content}\n::`;
  parseFragment(source, op);
  return source;
}

function serializeChangeRequestBlock(op: Extract<PatchOp, { op: "add_change_request" }>): string {
  validateChangeRequestOp(op);
  const attrs = Object.entries(changeRequestAttrs(op))
    .map(([key, value]) => serializeOneAttr(key, value))
    .join(" ");
  const content = op.content?.replace(/\n+$/, "") ?? "";
  const source = content
    ? `::change_request{${attrs}}\n${content}\n::`
    : `::change_request{${attrs}}\n::`;
  parseFragment(source, op);
  return source;
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
