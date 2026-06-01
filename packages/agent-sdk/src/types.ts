export type PatchOpName =
  | "replace_block"
  | "replace_body"
  | "update_heading"
  | "add_comment"
  | "resolve_comment"
  | "add_footnote"
  | "add_endnote"
  | "add_change_request"
  | "update_table_cell"
  | "update_table_header_cell"
  | "insert_table_row"
  | "delete_table_row"
  | "insert_table_column"
  | "delete_table_column"
  | "update_dataset_cell"
  | "insert_dataset_row"
  | "delete_dataset_row"
  | "insert_dataset_column"
  | "delete_dataset_column"
  | "move_block"
  | "add_block"
  | "delete_block"
  | "update_attribute"
  | "remove_attribute"
  | "rename_id";

// AttrValue mirrors src/ast.ts — string | number | boolean ONLY.
export type AttrValue = string | number | boolean;

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
  | { op: "add_block"; parent: string; content: string; position?: number }
  | { op: "delete_block"; id: string }
  | { op: "update_attribute"; id: string; key: string; value: AttrValue }
  | { op: "remove_attribute"; id: string; key: string }
  | { op: "rename_id"; from: string; to: string };

// Mirrors src/patch.ts PatchErrorCode exactly. Names like `rename_collision`
// and `schema_violation` from earlier drafts do NOT exist on the server —
// rename collisions surface as `id_conflict`, and reserved-key violations
// surface as `id_attribute_protected`.
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

export type BlockSummary = {
  id?: string;
  type: string;
  name?: string;
  attrs?: Record<string, string | number | boolean>;
  title?: string;
  level?: number;
  aliases?: string[];
  childCount: number;
  lines: [number, number];
  patchable: boolean;
};

// Mirrors src/ast.ts Diagnostic. NOT `rule`/`line`/`column`/`blockId` from
// earlier drafts — those names never existed on the server.
export type Diagnostic = {
  severity: "error" | "warning" | "info";
  code: string;
  message: string;
  pos?: { line: number; column: number };
  nodeId?: string;
};

export type Actor = {
  kind: "human" | "agent" | "tool";
  name: string;
  model?: string;
  version?: string;
};

export type ValidationSummary = "ok" | "warn" | "error";
export type PatchResultStatus = "applied" | "rejected" | "noop";

// Mirrors packages/mcp-server/src/transcript.ts TranscriptLine exactly.
// All fields use snake_case to match the JSON the server emits — this is
// the wire shape, not an internal API. Renamings to camelCase happen at
// the SDK return boundary (see PatchResult below).
export type TranscriptRecord = {
  protocol_version: "1.0";
  tool_version: string;
  op_id: string;
  ts: string;
  actor: Actor;
  doc_uri: string;
  pre_sha256: string;
  post_sha256: string;
  pre_sha: string;
  post_sha: string;
  op: PatchOp;
  patch_result: PatchResultStatus;
  pre_validation: ValidationSummary;
  post_validation: ValidationSummary;
  reason?: string;
  parent_op_id?: string;
  base_sha256?: string;
  diagnostics?: Array<Diagnostic & { phase: "pre" | "post" }>;
  elapsed_ms?: number;
  prev_entry_sha256?: string;
  signature?: null | { algorithm: string; key_id: string; value: string };
};

export type PatchResult =
  | {
      ok: true;
      postValidation: ValidationSummary;
      transcriptEntry: TranscriptRecord;
      diagnostics: Diagnostic[];
    }
  | PatchFailure;

export type PatchFailure = {
  ok: false;
  error: string;
  code?: PatchErrorCode | string;
};

export type CapabilityCheckResult =
  | { allowed: true }
  | {
      allowed: false;
      reason:
        | "no_descriptor"
        | "block_not_listed"
        | "op_not_granted"
        | "attr_constraint_violated"
        | "rename_globally_denied";
      detail: string;
    };
