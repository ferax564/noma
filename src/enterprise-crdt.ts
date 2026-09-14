import { parse } from "./parser.js";
import { renderNoma } from "./renderer-noma.js";
import { findNodeByAnyId, updateTableCellById } from "./stable-identity.js";
import { EnterpriseError } from "./enterprise-contracts.js";

export type CrdtOp =
  | { kind: "replace_paragraph"; blockId: string; content: string }
  | { kind: "update_table_cell"; tableId: string; cellId: string; value: string };

export interface CrdtUpdate {
  clientId: string;
  clientSeq: number;
  ops: CrdtOp[];
}

export function crdtOpTarget(op: CrdtOp): string {
  return op.kind === "replace_paragraph" ? `paragraph:${op.blockId}` : `cell:${op.tableId}:${op.cellId}`;
}

export function crdtOpsConflict(a: CrdtOp[], b: CrdtOp[]): boolean {
  const left = new Set(a.map(crdtOpTarget));
  return b.some((op) => left.has(crdtOpTarget(op)));
}

export function applyCrdtOps(source: string, ops: CrdtOp[]): string {
  const parsed = parse(source);
  for (const op of ops) {
    if (op.kind === "replace_paragraph") {
      const node = findNodeByAnyId(parsed, op.blockId);
      if (!node || node.type !== "paragraph") throw new EnterpriseError("not_found", "paragraph not found", { blockId: op.blockId });
      node.content = op.content;
    } else {
      const table = findNodeByAnyId(parsed, op.tableId);
      if (!table || table.type !== "table") throw new EnterpriseError("not_found", "table not found", { tableId: op.tableId });
      updateTableCellById(table, { cellId: op.cellId }, op.value);
    }
  }
  return renderNoma(parsed);
}
