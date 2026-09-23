/**
 * @deprecated This module was never a CRDT. It is a block-level three-way
 * merge; import from `./enterprise-merge.js` instead. These aliases keep
 * existing callers compiling and will be removed in a future major release.
 */
import {
  applyBlockOps,
  blockOpsConflict,
  blockOpTarget,
  type BlockEditSet,
  type BlockOp,
} from "./enterprise-merge.js";

/** @deprecated Use `BlockOp` from `enterprise-merge`. */
export type CrdtOp = BlockOp;

/** @deprecated Use `BlockEditSet` from `enterprise-merge`. */
export type CrdtUpdate = BlockEditSet;

/** @deprecated Use `blockOpTarget` from `enterprise-merge`. */
export const crdtOpTarget = blockOpTarget;

/** @deprecated Use `blockOpsConflict` / `detectBlockConflicts` from `enterprise-merge`. */
export const crdtOpsConflict = blockOpsConflict;

/** @deprecated Use `applyBlockOps` from `enterprise-merge` (source-preserving). */
export const applyCrdtOps = applyBlockOps;
