import { readFileSync, writeFileSync, renameSync, unlinkSync } from "node:fs";
import { dirname } from "node:path";
import { randomBytes } from "node:crypto";
import { parse, patchSource, validate, isBookManifestPath, PatchError } from "@noma/cli";
import type { Diagnostic, PatchOp } from "@noma/cli";
import { sha256hex } from "../sha.js";
import { appendTranscript } from "../transcript.js";
import { summarizeValidation } from "./validate-doc.js";
import type { TranscriptLine, ValidationSummary } from "../transcript.js";

const MAX_CONTENT_BYTES = 1_000_000;

export interface PatchBlockArgs {
  file: string;
  op: PatchOp;
  reason?: string;
  expected_sha?: string;
}

type PatchBlockResult =
  | { ok: true; post_validation: ValidationSummary; transcript_entry: TranscriptLine; diagnostics: Diagnostic[] }
  | { ok: false; error: string; system?: true };

export function patchBlock(args: PatchBlockArgs): PatchBlockResult {
  const { file, op, reason = "", expected_sha } = args;

  if (isBookManifestPath(file)) {
    return { ok: false, error: "book manifests are not supported by patch_block", system: true };
  }

  if ("content" in op && typeof op.content === "string" && Buffer.byteLength(op.content, "utf8") > MAX_CONTENT_BYTES) {
    return { ok: false, error: "content_too_large" };
  }

  let source: string;
  try {
    source = readFileSync(file, "utf8");
  } catch (e) {
    return { ok: false, error: String(e), system: true };
  }

  const preBytes = Buffer.from(source, "utf8");
  const pre_sha = sha256hex(preBytes).slice(0, 8);

  if (expected_sha !== undefined && expected_sha !== pre_sha) {
    return { ok: false, error: "precondition_failed" };
  }

  const preDoc = parse(source);
  const pre_validation = summarizeValidation(validate(preDoc));

  let patched: string;
  try {
    patched = patchSource(source, op);
  } catch (e) {
    if (e instanceof PatchError) return { ok: false, error: e.message };
    return { ok: false, error: String(e) };
  }

  const postBytes = Buffer.from(patched, "utf8");
  const post_sha = sha256hex(postBytes).slice(0, 8);

  const tmp = `${dirname(file)}/.noma-patch-${randomBytes(6).toString("hex")}.tmp`;
  try {
    writeFileSync(tmp, patched, "utf8");
    renameSync(tmp, file);
  } catch (e) {
    try { unlinkSync(tmp); } catch {}
    return { ok: false, error: String(e), system: true };
  }

  const postDoc = parse(patched);
  const postDiagnostics = validate(postDoc);
  const post_validation = summarizeValidation(postDiagnostics);

  const transcript_entry: TranscriptLine = {
    v: 1,
    ts: new Date().toISOString(),
    agent: "unknown",
    op,
    reason,
    pre_validation,
    post_validation,
    pre_sha,
    post_sha,
  };

  try { appendTranscript(file + ".patches", transcript_entry); } catch {}

  return { ok: true, post_validation, transcript_entry, diagnostics: postDiagnostics };
}
