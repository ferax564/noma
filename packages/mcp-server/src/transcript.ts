import { appendFileSync } from "node:fs";
import type { PatchOp } from "@noma/cli";

export type ValidationSummary = "ok" | "warn" | "error";

export interface TranscriptLine {
  v: 1;
  ts: string;
  agent: string;
  op: PatchOp;
  reason: string;
  pre_validation: ValidationSummary;
  post_validation: ValidationSummary;
  pre_sha: string;
  post_sha: string;
}

export function appendTranscript(path: string, line: TranscriptLine): void {
  appendFileSync(path, JSON.stringify(line) + "\n", "utf8");
}
