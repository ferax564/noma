import { appendFileSync } from "node:fs";
import type { PatchOp } from "@ferax564/noma-cli";
import type { Diagnostic } from "@ferax564/noma-cli";

export type ValidationSummary = "ok" | "warn" | "error";
export type PatchResult = "applied" | "rejected" | "noop";

export interface TranscriptActor {
  kind: "human" | "agent" | "tool";
  name: string;
  model?: string;
  version?: string;
}

export interface TranscriptSignature {
  algorithm: string;
  key_id: string;
  value: string;
}

export interface TranscriptDiagnostic extends Diagnostic {
  phase: "pre" | "post";
}

export interface TranscriptLine {
  protocol_version: "1.0";
  tool_version: string;
  op_id: string;
  ts: string;
  actor: TranscriptActor;
  doc_uri: string;
  pre_sha256: string;
  post_sha256: string;
  pre_sha: string;
  post_sha: string;
  op: PatchOp;
  patch_result: PatchResult;
  pre_validation: ValidationSummary;
  post_validation: ValidationSummary;

  reason?: string;
  parent_op_id?: string;
  base_sha256?: string;
  diagnostics?: TranscriptDiagnostic[];
  elapsed_ms?: number;
  prev_entry_sha256?: string;
  signature?: null | TranscriptSignature;
}

export function appendTranscript(path: string, line: TranscriptLine): void {
  appendFileSync(path, JSON.stringify(line) + "\n", "utf8");
}
