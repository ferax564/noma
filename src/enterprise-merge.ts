/**
 * Block-level three-way merge for concurrently edited Noma drafts.
 *
 * This is deliberately *not* a CRDT. Each side's edits are expressed as
 * block-addressed ops against a shared base; the merge applies both op sets
 * with the source-preserving `patchSource` machinery (every byte outside an
 * edited block is kept), and reports a conflict when both sides changed the
 * same block to different results. Edits to disjoint blocks merge cleanly;
 * identical edits on both sides collapse to one.
 */
import type { TableNode } from "./ast.js";
import { EnterpriseError } from "./enterprise-contracts.js";
import { escapePipeTableCell, splitPipeRow } from "./inline.js";
import { parse } from "./parser.js";
import { patchSource } from "./patch.js";
import { findNodeByAnyId, formatInlineStableId, locateTableCell } from "./stable-identity.js";

export type BlockOp =
  | { kind: "replace_paragraph"; blockId: string; content: string }
  | { kind: "update_table_cell"; tableId: string; cellId: string; value: string };

export interface BlockEditSet {
  clientId: string;
  clientSeq: number;
  ops: BlockOp[];
}

export interface BlockMergeConflict {
  target: string;
  ours: BlockOp;
  theirs: BlockOp;
}

export type BlockMergeResult =
  | { ok: true; source: string; applied: BlockOp[] }
  | { ok: false; conflicts: BlockMergeConflict[] };

/** Stable key of the block (or table cell) an op edits. */
export function blockOpTarget(op: BlockOp): string {
  return op.kind === "replace_paragraph" ? `paragraph:${op.blockId}` : `cell:${op.tableId}:${op.cellId}`;
}

function blockOpResult(op: BlockOp): string {
  return op.kind === "replace_paragraph" ? op.content : op.value;
}

/** Last op per target wins within one side, matching sequential application. */
function finalOpsByTarget(ops: BlockOp[]): Map<string, BlockOp> {
  const out = new Map<string, BlockOp>();
  for (const op of ops) out.set(blockOpTarget(op), op);
  return out;
}

/**
 * Conflicts between two concurrent op sets: a target edited on both sides
 * whose final results differ. Identical edits are not conflicts.
 */
export function detectBlockConflicts(ours: BlockOp[], theirs: BlockOp[]): BlockMergeConflict[] {
  const left = finalOpsByTarget(ours);
  const conflicts: BlockMergeConflict[] = [];
  for (const [target, op] of finalOpsByTarget(theirs)) {
    const mine = left.get(target);
    if (mine && blockOpResult(mine) !== blockOpResult(op)) conflicts.push({ target, ours: mine, theirs: op });
  }
  return conflicts;
}

export function blockOpsConflict(ours: BlockOp[], theirs: BlockOp[]): boolean {
  return detectBlockConflicts(ours, theirs).length > 0;
}

function replaceParagraph(source: string, op: Extract<BlockOp, { kind: "replace_paragraph" }>): string {
  const node = findNodeByAnyId(parse(source), op.blockId);
  if (!node || node.type !== "paragraph" || !node.id) {
    throw new EnterpriseError("not_found", "paragraph not found", { blockId: op.blockId });
  }
  if (op.content.trim() === "") throw new EnterpriseError("invalid", "paragraph content must not be empty", { blockId: op.blockId });
  return patchSource(source, { op: "replace_body", id: node.id, content: op.content });
}

/**
 * Rewrite one pipe-table cell in place. Only the addressed row line changes;
 * `patchSource`'s table ops cover `::table` directives, not GitHub pipe
 * tables with persistent cell IDs, so this splices the single source line.
 */
function updateTableCell(source: string, op: Extract<BlockOp, { kind: "update_table_cell" }>): string {
  const node = findNodeByAnyId(parse(source), op.tableId);
  if (!node || node.type !== "table") throw new EnterpriseError("not_found", "table not found", { tableId: op.tableId });
  if (/[\r\n]/.test(op.value)) throw new EnterpriseError("invalid", "table cell value must be a single line", { cellId: op.cellId });
  const table: TableNode = node;
  let located;
  try {
    located = locateTableCell(table, { cellId: op.cellId });
  } catch {
    throw new EnterpriseError("not_found", "table cell not found", { tableId: op.tableId, cellId: op.cellId });
  }
  const headerLine = table.pos?.line;
  if (!headerLine) throw new EnterpriseError("invalid", "table has no source position", { tableId: op.tableId });
  const lines = source.split("\n");
  const index = headerLine - 1 + 2 + located.rowIndex;
  const line = lines[index];
  if (line === undefined) throw new EnterpriseError("invalid", "table row is outside the source", { tableId: op.tableId });
  const cells = splitPipeRow(line);
  while (cells.length <= located.columnIndex) cells.push("");
  cells[located.columnIndex] = formatInlineStableId(op.cellId, escapePipeTableCell(op.value));
  const indent = /^\s*/.exec(line)?.[0] ?? "";
  lines[index] = `${indent}| ${cells.join(" | ")} |`;
  return lines.join("\n");
}

/** Apply block ops to source, preserving every byte outside the edited blocks. */
export function applyBlockOps(source: string, ops: BlockOp[]): string {
  let current = source;
  for (const op of ops) {
    current = op.kind === "replace_paragraph" ? replaceParagraph(current, op) : updateTableCell(current, op);
  }
  return current;
}

/**
 * Three-way merge: `base` is the common ancestor; `ours` and `theirs` are the
 * op sets each side applied to it. Returns the merged source, or the list of
 * conflicting targets when both sides changed the same block differently.
 */
export function mergeBlockEdits(base: string, ours: BlockOp[], theirs: BlockOp[]): BlockMergeResult {
  const conflicts = detectBlockConflicts(ours, theirs);
  if (conflicts.length > 0) return { ok: false, conflicts };
  const ourTargets = new Set(ours.map(blockOpTarget));
  const extra = theirs.filter((op) => !ourTargets.has(blockOpTarget(op)));
  const applied = [...ours, ...extra];
  return { ok: true, source: applyBlockOps(base, applied), applied };
}
