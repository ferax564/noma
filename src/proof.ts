import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";
import type { Diagnostic, DocumentNode } from "./ast.js";
import { escapeAttr, escapeHtml } from "./inline.js";
import { collectIdRegistry, type IdRegistry } from "./ids.js";
import { inlineDatasetSources } from "./loader.js";
import { parse } from "./parser.js";
import { PatchError, patchSource, type PatchOp } from "./patch.js";
import { renderHtml, type HtmlRenderOptions } from "./renderer-html.js";
import { renderLlm, type RenderLlmOptions } from "./renderer-llm.js";
import { formatDiagnostics, validate, type ValidateOptions } from "./validator.js";

export type ValidationSummary = "ok" | "warn" | "error";
export type ProofStatus = "pass" | "warn" | "fail";
export type ProofPatchResult = "applied" | "noop" | "rejected";

export interface ProofOptions {
  filePath: string;
  source: string;
  ops: PatchOp[];
  prevalidate?: boolean;
  postvalidate?: boolean;
  validateOptions?: ValidateOptions;
  llmOptions?: RenderLlmOptions;
  artifactOptions?: HtmlRenderOptions;
}

export interface ProofSourceMetrics {
  beforeBytes: number;
  afterBytes: number;
  beforeLines: number;
  afterLines: number;
  unchangedLines: number;
  preservedPercent: number;
}

export interface ProofHashPair {
  sha256: string;
  sha: string;
}

export interface ProofPatchError {
  code: string;
  message: string;
  op: PatchOp;
}

export interface AgentSafetyProof {
  status: ProofStatus;
  patchResult: ProofPatchResult;
  canWrite: boolean;
  file: string;
  docUri: string;
  ops: PatchOp[];
  preHash: ProofHashPair;
  postHash: ProofHashPair;
  preValidation: ValidationSummary;
  postValidation: ValidationSummary;
  preDiagnostics: Diagnostic[];
  postDiagnostics: Diagnostic[];
  idRegistry: IdRegistry;
  sourceMetrics: ProofSourceMetrics;
  diff: string;
  llmContext: string;
  artifactPreviewHtml: string;
  error?: ProofPatchError;
  postSource: string;
}

export function createAgentSafetyProof(options: ProofOptions): AgentSafetyProof {
  const preDoc = parseProofDoc(options.source, options.filePath);
  const preDiagnostics = validate(preDoc, options.validateOptions);
  const idRegistry = collectIdRegistry(preDoc);
  const llmContext = renderLlm(preDoc, options.llmOptions ?? {});
  const preHash = hashSource(options.source);
  const preValidation = summarizeValidation(preDiagnostics);
  const prevalidateBlocked =
    options.prevalidate === true && preDiagnostics.some((diag) => diag.severity === "error");

  let postSource = options.source;
  let patchResult: ProofPatchResult = "rejected";
  let error: ProofPatchError | undefined;

  if (prevalidateBlocked) {
    error = {
      code: "pre_validation_blocked",
      message: "pre-validation failed before patch simulation",
      op: options.ops[0]!,
    };
  } else {
    try {
      postSource = patchSource(options.source, options.ops);
      patchResult = postSource === options.source ? "noop" : "applied";
    } catch (caught) {
      if (caught instanceof PatchError) {
        error = { code: caught.code, message: caught.message, op: caught.op };
      } else {
        const fallback = options.ops[0] ?? ({ op: "replace_block", id: "", content: "" } as PatchOp);
        error = {
          code: "patch_error",
          message: caught instanceof Error ? caught.message : String(caught),
          op: fallback,
        };
      }
    }
  }

  const postDoc = parseProofDoc(postSource, options.filePath);
  const postDiagnostics = validate(postDoc, options.validateOptions);
  const postValidation = summarizeValidation(postDiagnostics);
  const postvalidateBlocked =
    options.postvalidate === true && postDiagnostics.some((diag) => diag.severity === "error");
  const canWrite =
    patchResult !== "rejected" &&
    !prevalidateBlocked &&
    postValidation !== "error" &&
    !postvalidateBlocked;
  const postHash = hashSource(postSource);
  const sourceMetrics = measureSourcePreservation(options.source, postSource);
  const status = proofStatus({ patchResult, prevalidateBlocked, postvalidateBlocked, postValidation });

  return {
    status,
    patchResult,
    canWrite,
    file: options.filePath,
    docUri: pathToFileURL(options.filePath).toString(),
    ops: options.ops,
    preHash,
    postHash,
    preValidation,
    postValidation,
    preDiagnostics,
    postDiagnostics,
    idRegistry,
    sourceMetrics,
    diff: lineDiff(options.source, postSource),
    llmContext,
    artifactPreviewHtml:
      patchResult === "rejected"
        ? ""
        : renderHtml(postDoc, {
            ...(options.artifactOptions ?? {}),
            standalone: true,
            allowEscapeHatches: false,
            externalAssets: false,
            interactive: false,
          }),
    ...(error ? { error } : {}),
    postSource,
  };
}

export function renderProofHtml(proof: AgentSafetyProof): string {
  const title = "Noma Agent Safety Proof";
  const statusLabel = proof.status.toUpperCase();
  const statusClass = `status-${proof.status}`;
  const opRows = proof.ops
    .map((op, index) => {
      const target = opTarget(op);
      return `<tr><td>${index + 1}</td><td><code>${escapeHtml(op.op)}</code></td><td>${escapeHtml(target)}</td><td><pre>${escapeHtml(JSON.stringify(op, null, 2))}</pre></td></tr>`;
    })
    .join("\n");
  const idRows = proof.idRegistry.records
    .map((record) => {
      const kind = record.type === "directive" ? `${record.type}:${record.name ?? ""}` : record.type;
      const aliases = record.aliases?.join(", ") ?? "";
      return `<tr><td><code>${escapeHtml(record.id)}</code></td><td>${escapeHtml(kind)}</td><td>${record.line ?? ""}</td><td>${escapeHtml(record.title ?? aliases)}</td></tr>`;
    })
    .join("\n");
  const preDiagnostics = diagnosticsHtml(proof.preDiagnostics, proof.file);
  const postDiagnostics = diagnosticsHtml(proof.postDiagnostics, proof.file);
  const errorHtml = proof.error
    ? `<section class="proof-section proof-error"><h2>Patch Error</h2><p><code>${escapeHtml(proof.error.code)}</code> ${escapeHtml(proof.error.message)}</p><pre>${escapeHtml(JSON.stringify(proof.error.op, null, 2))}</pre></section>`
    : "";
  const previewHtml = proof.artifactPreviewHtml
    ? `<iframe title="Post-patch artifact preview" sandbox srcdoc="${escapeAttr(proof.artifactPreviewHtml)}"></iframe>`
    : `<p class="muted">Artifact preview omitted because the patch was rejected.</p>`;

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="generator" content="noma" />
<title>${title}</title>
<link rel="icon" href="data:," />
<style>
  :root {
    --bg: #f6f7f8;
    --panel: #fff;
    --ink: #17191c;
    --muted: #606975;
    --rule: #dde3ea;
    --soft: #eef2f5;
    --good: #26784a;
    --warn: #9a681d;
    --bad: #a7372f;
    --accent: #2f5f8d;
    --mono: "SF Mono", Menlo, Consolas, monospace;
    --sans: Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
  }
  * { box-sizing: border-box; }
  body { margin: 0; background: var(--bg); color: var(--ink); font-family: var(--sans); line-height: 1.5; }
  main { max-width: 1320px; margin: 0 auto; padding: 28px; }
  code, pre { font-family: var(--mono); }
  code { background: var(--soft); border-radius: 4px; padding: 0.08rem 0.28rem; overflow-wrap: anywhere; word-break: break-word; }
  pre { margin: 0; white-space: pre-wrap; overflow-wrap: anywhere; }
  .hero, .proof-section { background: var(--panel); border: 1px solid var(--rule); border-radius: 8px; box-shadow: 0 16px 42px -34px rgba(0,0,0,.35); min-width: 0; }
  .hero { padding: 24px; margin-bottom: 18px; }
  .hero-top { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; }
  h1 { margin: 0 0 10px; font-size: clamp(2rem, 5vw, 3.2rem); line-height: 1.03; letter-spacing: 0; }
  h2 { margin: 0 0 14px; font-size: 1.05rem; }
  p { margin: 0 0 12px; }
  .muted { color: var(--muted); }
  .badge { display: inline-flex; align-items: center; border-radius: 999px; padding: 6px 10px; font-weight: 750; font-size: .82rem; border: 1px solid currentColor; }
  .status-pass { color: var(--good); }
  .status-warn { color: var(--warn); }
  .status-fail { color: var(--bad); }
  .metrics { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 10px; margin-top: 20px; }
  .metric { border: 1px solid var(--rule); border-radius: 8px; padding: 13px; background: #fbfcfd; min-width: 0; }
  .metric span { display: block; color: var(--muted); font-size: .76rem; font-weight: 720; text-transform: uppercase; }
  .metric strong { display: block; margin-top: 4px; font-size: 1.1rem; overflow-wrap: anywhere; }
  .grid { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 18px; }
  .proof-section { padding: 18px; margin-bottom: 18px; overflow: hidden; }
  table { width: 100%; border-collapse: collapse; font-size: .92rem; min-width: 640px; }
  .table-scroll { overflow-x: auto; }
  th, td { border-top: 1px solid var(--rule); padding: 8px 10px; text-align: left; vertical-align: top; overflow-wrap: anywhere; }
  th { color: var(--muted); font-size: .76rem; text-transform: uppercase; }
  td pre { font-size: .8rem; max-height: 220px; overflow: auto; }
  .timeline { display: grid; grid-template-columns: repeat(6, minmax(0, 1fr)); gap: 8px; }
  .step { border: 1px solid var(--rule); border-radius: 8px; padding: 10px; background: #fbfcfd; }
  .step strong { display: block; font-size: .9rem; }
  .step span { display: block; color: var(--muted); font-size: .82rem; }
  .diff { background: #111417; color: #e8edf2; border-radius: 8px; padding: 14px; max-height: 520px; overflow: auto; font-size: .84rem; }
  .diff .add { color: #8fe0a8; }
  .diff .del { color: #ffaaa5; }
  .diff .meta { color: #9fb3c8; }
  .llm { background: #f9fafb; border: 1px solid var(--rule); border-radius: 8px; padding: 14px; max-height: 520px; overflow: auto; font-size: .86rem; }
  iframe { width: 100%; min-height: 560px; border: 1px solid var(--rule); border-radius: 8px; background: white; }
  .proof-error { border-color: rgba(167,55,47,.45); }
  @media (max-width: 860px) {
    main { padding: 16px; }
    .hero-top, .grid { display: block; }
    .metrics, .timeline { grid-template-columns: 1fr; }
    .badge { margin-top: 12px; }
    .hero, .proof-section { padding: 16px; }
    .hero .muted { overflow-wrap: anywhere; }
    table { font-size: .86rem; }
    iframe { min-height: 460px; }
  }
</style>
</head>
<body>
<main>
  <section class="hero">
    <div class="hero-top">
      <div>
        <h1>${title}</h1>
        <p class="muted">${escapeHtml(proof.file)}</p>
        <p><code>${escapeHtml(proof.docUri)}</code></p>
      </div>
      <span class="badge ${statusClass}">${statusLabel}</span>
    </div>
    <div class="metrics">
      <div class="metric"><span>Patch result</span><strong>${escapeHtml(proof.patchResult)}</strong></div>
      <div class="metric"><span>Validation</span><strong>${escapeHtml(proof.preValidation)} → ${escapeHtml(proof.postValidation)}</strong></div>
      <div class="metric"><span>Lines preserved</span><strong>${proof.sourceMetrics.preservedPercent.toFixed(1)}%</strong></div>
      <div class="metric"><span>Operations</span><strong>${proof.ops.length}</strong></div>
      <div class="metric"><span>Pre SHA</span><strong><code>${escapeHtml(proof.preHash.sha)}</code></strong></div>
      <div class="metric"><span>Post SHA</span><strong><code>${escapeHtml(proof.postHash.sha)}</code></strong></div>
      <div class="metric"><span>Source bytes</span><strong>${proof.sourceMetrics.beforeBytes} → ${proof.sourceMetrics.afterBytes}</strong></div>
      <div class="metric"><span>Write allowed</span><strong>${proof.canWrite ? "yes" : "no"}</strong></div>
    </div>
  </section>

  <section class="proof-section">
    <h2>Agent Loop</h2>
    <div class="timeline">
      <div class="step"><strong>1. Read</strong><span>${proof.sourceMetrics.beforeLines} source lines</span></div>
      <div class="step"><strong>2. Discover IDs</strong><span>${proof.idRegistry.ids.length} canonical IDs</span></div>
      <div class="step"><strong>3. Export Context</strong><span>${proof.llmContext.length} LLM chars</span></div>
      <div class="step"><strong>4. Simulate Patch</strong><span>${escapeHtml(proof.patchResult)}</span></div>
      <div class="step"><strong>5. Validate</strong><span>${escapeHtml(proof.postValidation)}</span></div>
      <div class="step"><strong>6. Preview</strong><span>${proof.artifactPreviewHtml ? "sandboxed artifact" : "omitted"}</span></div>
    </div>
  </section>

  ${errorHtml}

  <section class="proof-section">
    <h2>Patch Operations</h2>
    <div class="table-scroll"><table><thead><tr><th>#</th><th>Op</th><th>Target</th><th>Payload</th></tr></thead><tbody>${opRows}</tbody></table></div>
  </section>

  <div class="grid">
    <section class="proof-section">
      <h2>Pre-Validation</h2>
      ${preDiagnostics}
    </section>
    <section class="proof-section">
      <h2>Post-Validation</h2>
      ${postDiagnostics}
    </section>
  </div>

  <section class="proof-section">
    <h2>ID Registry</h2>
    <div class="table-scroll"><table><thead><tr><th>ID</th><th>Type</th><th>Line</th><th>Title / aliases</th></tr></thead><tbody>${idRows}</tbody></table></div>
  </section>

  <section class="proof-section">
    <h2>Source Diff</h2>
    <pre class="diff">${diffHtml(proof.diff)}</pre>
  </section>

  <section class="proof-section">
    <h2>LLM Context Used For Agent Work</h2>
    <pre class="llm">${escapeHtml(proof.llmContext)}</pre>
  </section>

  <section class="proof-section">
    <h2>Post-Patch Artifact Preview</h2>
    ${previewHtml}
  </section>
</main>
</body>
</html>`;
}

function parseProofDoc(source: string, filename: string): DocumentNode {
  const doc = parse(source, { filename });
  inlineDatasetSources(doc);
  return doc;
}

function hashSource(source: string): ProofHashPair {
  const sha256 = createHash("sha256").update(source).digest("hex");
  return { sha256, sha: sha256.slice(0, 8) };
}

function summarizeValidation(diagnostics: Diagnostic[]): ValidationSummary {
  if (diagnostics.some((diag) => diag.severity === "error")) return "error";
  if (diagnostics.some((diag) => diag.severity === "warning")) return "warn";
  return "ok";
}

function proofStatus(input: {
  patchResult: ProofPatchResult;
  prevalidateBlocked: boolean;
  postvalidateBlocked: boolean;
  postValidation: ValidationSummary;
}): ProofStatus {
  if (input.patchResult === "rejected" || input.prevalidateBlocked || input.postvalidateBlocked) {
    return "fail";
  }
  if (input.postValidation === "error") return "fail";
  if (input.postValidation === "warn") return "warn";
  return "pass";
}

function measureSourcePreservation(before: string, after: string): ProofSourceMetrics {
  const beforeLines = sourceLines(before);
  const afterLines = sourceLines(after);
  const unchangedLines = commonLineCount(beforeLines, afterLines);
  const preservedPercent =
    beforeLines.length === 0
      ? afterLines.length === 0
        ? 100
        : 0
      : (unchangedLines / beforeLines.length) * 100;
  return {
    beforeBytes: Buffer.byteLength(before, "utf8"),
    afterBytes: Buffer.byteLength(after, "utf8"),
    beforeLines: beforeLines.length,
    afterLines: afterLines.length,
    unchangedLines,
    preservedPercent: Math.max(0, Math.min(100, preservedPercent)),
  };
}

function sourceLines(source: string): string[] {
  if (source.length === 0) return [];
  return source.endsWith("\n") ? source.slice(0, -1).split("\n") : source.split("\n");
}

function commonLineCount(a: string[], b: string[]): number {
  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++;
  let suffix = 0;
  while (
    suffix + prefix < a.length &&
    suffix + prefix < b.length &&
    a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
  ) {
    suffix++;
  }
  const aMid = a.slice(prefix, a.length - suffix);
  const bMid = b.slice(prefix, b.length - suffix);
  if (aMid.length === 0 || bMid.length === 0) return prefix + suffix;
  if (aMid.length * bMid.length > 1_000_000) return prefix + suffix;
  return prefix + suffix + lcsCount(aMid, bMid);
}

function lcsCount(a: string[], b: string[]): number {
  let prev = new Array<number>(b.length + 1).fill(0);
  let cur = new Array<number>(b.length + 1).fill(0);
  for (let i = 1; i <= a.length; i++) {
    for (let j = 1; j <= b.length; j++) {
      cur[j] = a[i - 1] === b[j - 1] ? prev[j - 1]! + 1 : Math.max(prev[j]!, cur[j - 1]!);
    }
    [prev, cur] = [cur, prev];
    cur.fill(0);
  }
  return prev[b.length]!;
}

function lineDiff(before: string, after: string): string {
  if (before === after) return "(no source changes)";
  const a = sourceLines(before);
  const b = sourceLines(after);
  if (a.length * b.length > 1_000_000) {
    const metrics = measureSourcePreservation(before, after);
    return `diff omitted: source is too large for inline proof diff\nunchanged lines: ${metrics.unchangedLines}/${metrics.beforeLines}`;
  }
  const rows = diffRows(a, b);
  const lines = rows.map((row) => `${row.kind}${row.text}`);
  const max = 600;
  if (lines.length <= max) return lines.join("\n");
  return [
    ...lines.slice(0, 280),
    `... ${lines.length - 560} diff lines omitted ...`,
    ...lines.slice(-280),
  ].join("\n");
}

function diffRows(a: string[], b: string[]): Array<{ kind: " " | "+" | "-"; text: string }> {
  const dp: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i--) {
    for (let j = b.length - 1; j >= 0; j--) {
      dp[i]![j] = a[i] === b[j] ? dp[i + 1]![j + 1]! + 1 : Math.max(dp[i + 1]![j]!, dp[i]![j + 1]!);
    }
  }
  const rows: Array<{ kind: " " | "+" | "-"; text: string }> = [];
  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      rows.push({ kind: " ", text: a[i]! });
      i++;
      j++;
    } else if (dp[i + 1]![j]! >= dp[i]![j + 1]!) {
      rows.push({ kind: "-", text: a[i]! });
      i++;
    } else {
      rows.push({ kind: "+", text: b[j]! });
      j++;
    }
  }
  while (i < a.length) rows.push({ kind: "-", text: a[i++]! });
  while (j < b.length) rows.push({ kind: "+", text: b[j++]! });
  return compactContext(rows);
}

function compactContext(rows: Array<{ kind: " " | "+" | "-"; text: string }>): Array<{ kind: " " | "+" | "-"; text: string }> {
  const keep = new Set<number>();
  for (let i = 0; i < rows.length; i++) {
    if (rows[i]!.kind === " ") continue;
    for (let j = Math.max(0, i - 3); j <= Math.min(rows.length - 1, i + 3); j++) keep.add(j);
  }
  if (keep.size === rows.length) return rows;
  const out: Array<{ kind: " " | "+" | "-"; text: string }> = [];
  let lastKept = -1;
  for (let i = 0; i < rows.length; i++) {
    if (!keep.has(i)) continue;
    if (lastKept !== -1 && i > lastKept + 1) out.push({ kind: " ", text: "..." });
    out.push(rows[i]!);
    lastKept = i;
  }
  return out;
}

function diagnosticsHtml(diagnostics: Diagnostic[], file: string): string {
  if (diagnostics.length === 0) return `<p class="muted">No issues found.</p>`;
  return `<pre>${escapeHtml(formatDiagnostics(diagnostics, file))}</pre>`;
}

function diffHtml(diff: string): string {
  return diff
    .split("\n")
    .map((line) => {
      const escaped = escapeHtml(line);
      if (line.startsWith("+")) return `<span class="add">${escaped}</span>`;
      if (line.startsWith("-")) return `<span class="del">${escaped}</span>`;
      if (line.startsWith("@") || line.startsWith("...")) return `<span class="meta">${escaped}</span>`;
      return escaped;
    })
    .join("\n");
}

function opTarget(op: PatchOp): string {
  switch (op.op) {
    case "rename_id":
      return `${op.from} → ${op.to}`;
    case "add_block":
      return `parent:${op.parent}`;
    case "add_comment":
    case "add_footnote":
    case "add_endnote":
    case "add_change_request":
      return `target:${op.target}`;
    default:
      return "id" in op ? op.id : "";
  }
}
