export type PatchOpName =
  | "replace_block"
  | "add_block"
  | "delete_block"
  | "update_attribute"
  | "rename_id";

// AttrValue mirrors src/ast.ts — string | number | boolean ONLY. The RFC
// reserves `value: null` for attribute removal (§3.1.4) but the current
// server schema rejects null (packages/mcp-server/src/index.ts:15). Null
// removal is tracked as future work; do NOT add `null` to this union until
// the server schema accepts it.
export type AttrValue = string | number | boolean;

export type PatchOp =
  | { op: "replace_block"; id: string; content: string }
  | { op: "add_block"; parent: string; content: string; position?: number }
  | { op: "delete_block"; id: string }
  | { op: "update_attribute"; id: string; key: string; value: AttrValue }
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
