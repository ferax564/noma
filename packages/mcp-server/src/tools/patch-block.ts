import { readFileSync, writeFileSync, renameSync, unlinkSync } from "node:fs";
import { dirname, resolve as resolvePath } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { parse, patchSource, validate, isBookManifestPath, PatchError } from "@ferax564/noma-cli";
import type { Diagnostic, PatchOp } from "@ferax564/noma-cli";
import { sha256hex } from "../sha.js";
import { appendTranscript } from "../transcript.js";
import { summarizeValidation } from "./validate-doc.js";
import type {
  TranscriptLine,
  TranscriptDiagnostic,
  PatchResult,
  TranscriptActor,
  ValidationSummary,
} from "../transcript.js";

const MAX_CONTENT_BYTES = 1_000_000;

import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const TOOL_VERSION: string = (require("../../package.json") as { version: string }).version;

export interface PatchBlockArgs {
  file: string;
  op: PatchOp;
  reason?: string;
  expected_sha?: string;
  actor?: TranscriptActor;
  base_sha256?: string;
  parent_op_id?: string;
}

type PatchBlockResult =
  | {
      ok: true;
      post_validation: ValidationSummary;
      transcript_entry: TranscriptLine;
      diagnostics: Diagnostic[];
    }
  | { ok: false; error: string; code?: string; system?: true };

function defaultActor(): TranscriptActor {
  return { kind: "agent", name: "unknown" };
}

function toTranscriptDiagnostics(diags: Diagnostic[], phase: "pre" | "post"): TranscriptDiagnostic[] {
  return diags.map((d) => ({ ...d, phase }));
}

export function patchBlock(args: PatchBlockArgs): PatchBlockResult {
  const start = Date.now();
  const { file, op, reason, expected_sha, actor = defaultActor(), base_sha256, parent_op_id } = args;
  const op_id = randomUUID();
  const ts = new Date().toISOString();
  const doc_uri = pathToFileURL(resolvePath(file)).toString();

  if (isBookManifestPath(file)) {
    return { ok: false, error: "book manifests are not supported by patch_block", code: "unsupported_op", system: true };
  }

  if ("content" in op && typeof op.content === "string" && Buffer.byteLength(op.content, "utf8") > MAX_CONTENT_BYTES) {
    return { ok: false, error: "content_too_large", code: "invalid_content" };
  }

  let source: string;
  try {
    source = readFileSync(file, "utf8");
  } catch (e) {
    return { ok: false, error: String(e), system: true };
  }

  const preBytes = Buffer.from(source, "utf8");
  const pre_sha256 = sha256hex(preBytes);
  const pre_sha = pre_sha256.slice(0, 8);

  if (expected_sha !== undefined && expected_sha !== pre_sha) {
    const rejected: TranscriptLine = {
      protocol_version: "1.0",
      tool_version: TOOL_VERSION,
      op_id,
      ts,
      actor,
      doc_uri,
      pre_sha256,
      post_sha256: pre_sha256,
      pre_sha,
      post_sha: pre_sha,
      op,
      patch_result: "rejected",
      pre_validation: "ok",
      post_validation: "ok",
      diagnostics: [{ phase: "pre", severity: "error", code: "sha_mismatch", message: "expected_sha did not match pre_sha" }],
      ...(reason ? { reason } : {}),
      ...(parent_op_id ? { parent_op_id } : {}),
      elapsed_ms: Date.now() - start,
    };
    try { appendTranscript(file + ".patches", rejected); } catch {}
    return { ok: false, error: "sha_mismatch", code: "sha_mismatch" };
  }

  const preDoc = parse(source);
  const preDiagnostics = validate(preDoc);
  const pre_validation = summarizeValidation(preDiagnostics);

  let patched: string;
  try {
    patched = patchSource(source, op);
  } catch (e) {
    if (e instanceof PatchError) {
      const rejected: TranscriptLine = {
        protocol_version: "1.0",
        tool_version: TOOL_VERSION,
        op_id,
        ts,
        actor,
        doc_uri,
        pre_sha256,
        post_sha256: pre_sha256,
        pre_sha,
        post_sha: pre_sha,
        op,
        patch_result: "rejected",
        pre_validation,
        post_validation: pre_validation,
        diagnostics: [
          ...toTranscriptDiagnostics(preDiagnostics, "pre"),
          { phase: "pre", severity: "error", code: e.code, message: e.message },
        ],
        ...(reason ? { reason } : {}),
        ...(parent_op_id ? { parent_op_id } : {}),
        ...(base_sha256 ? { base_sha256 } : {}),
        elapsed_ms: Date.now() - start,
      };
      try { appendTranscript(file + ".patches", rejected); } catch {}
      return { ok: false, error: e.message, code: e.code };
    }
    return { ok: false, error: String(e) };
  }

  const postBytes = Buffer.from(patched, "utf8");
  const post_sha256 = sha256hex(postBytes);
  const post_sha = post_sha256.slice(0, 8);
  const noop = pre_sha256 === post_sha256;

  if (!noop) {
    const tmp = `${dirname(file)}/.noma-patch-${randomBytes(6).toString("hex")}.tmp`;
    try {
      writeFileSync(tmp, patched, "utf8");
      renameSync(tmp, file);
    } catch (e) {
      try { unlinkSync(tmp); } catch {}
      return { ok: false, error: String(e), system: true };
    }
  }

  const postDoc = parse(patched);
  const postDiagnostics = validate(postDoc);
  const post_validation = summarizeValidation(postDiagnostics);
  const patch_result: PatchResult = noop ? "noop" : "applied";

  const diagnostics: TranscriptDiagnostic[] = [
    ...toTranscriptDiagnostics(preDiagnostics, "pre"),
    ...toTranscriptDiagnostics(postDiagnostics, "post"),
  ];

  if (base_sha256 && base_sha256 !== pre_sha256) {
    diagnostics.push({
      phase: "pre",
      severity: "warning",
      code: "base_sha_drift",
      message: "base_sha256 differs from pre_sha256; agent may have edited stale state",
    });
  }

  const transcript_entry: TranscriptLine = {
    protocol_version: "1.0",
    tool_version: TOOL_VERSION,
    op_id,
    ts,
    actor,
    doc_uri,
    pre_sha256,
    post_sha256,
    pre_sha,
    post_sha,
    op,
    patch_result,
    pre_validation,
    post_validation,
    ...(diagnostics.length ? { diagnostics } : {}),
    ...(reason ? { reason } : {}),
    ...(parent_op_id ? { parent_op_id } : {}),
    ...(base_sha256 ? { base_sha256 } : {}),
    elapsed_ms: Date.now() - start,
  };

  try { appendTranscript(file + ".patches", transcript_entry); } catch {}

  return { ok: true, post_validation, transcript_entry, diagnostics: postDiagnostics };
}
