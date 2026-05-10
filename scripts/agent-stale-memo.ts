#!/usr/bin/env tsx
/**
 * "Agent updates a stale research memo without rewriting the file."
 *
 * Reads examples/agent-stale-memo/memo.noma, runs the validator (showing the
 * stale-citation warnings), applies the patch ops in patches.json via
 * patchSource (the source-preserving path), runs the validator again (clean),
 * and prints byte-level diff stats so you can see the unrelated 95% of the
 * file survive verbatim.
 *
 * Outputs:
 *   dist/examples/agent-stale-memo/memo.before.noma
 *   dist/examples/agent-stale-memo/memo.after.noma
 *   dist/examples/agent-stale-memo/trace.html  — narrated walkthrough
 *
 * Used by `npm run demo:stale-memo` and `npm run build:site`.
 */
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parse } from "../src/parser.js";
import { patchSource, type PatchOp } from "../src/patch.js";
import { validate, formatDiagnostics } from "../src/validator.js";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, "..");
const SRC = resolve(ROOT, "examples/agent-stale-memo/memo.noma");
const PATCHES = resolve(ROOT, "examples/agent-stale-memo/patches.json");
const OUT_DIR = resolve(ROOT, "dist/examples/agent-stale-memo");

function ensureDir(path: string): void {
  if (!existsSync(path)) mkdirSync(path, { recursive: true });
}

function pad(s: string, width: number): string {
  return s.length >= width ? s : s + " ".repeat(width - s.length);
}

function lineDiffStats(before: string, after: string): {
  totalLines: number;
  changedLines: number;
  unchangedPct: number;
  byteBefore: number;
  byteAfter: number;
} {
  const a = before.split("\n");
  const b = after.split("\n");
  const setBefore = new Map<string, number>();
  for (const line of a) setBefore.set(line, (setBefore.get(line) ?? 0) + 1);
  let unchanged = 0;
  for (const line of b) {
    const n = setBefore.get(line) ?? 0;
    if (n > 0) {
      unchanged++;
      setBefore.set(line, n - 1);
    }
  }
  const total = Math.max(a.length, b.length);
  return {
    totalLines: total,
    changedLines: total - unchanged,
    unchangedPct: total === 0 ? 100 : (100 * unchanged) / total,
    byteBefore: Buffer.byteLength(before, "utf8"),
    byteAfter: Buffer.byteLength(after, "utf8"),
  };
}

function reviewDate(): Date {
  // Fixed clock so the demo output is deterministic. Matches the date shown
  // throughout the memo and aligns with `dist/` build artifacts in CI.
  return new Date("2026-05-10T00:00:00Z");
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function renderTrace(args: {
  before: string;
  after: string;
  ops: PatchOp[];
  beforeDiagnostics: ReturnType<typeof validate>;
  afterDiagnostics: ReturnType<typeof validate>;
  stats: ReturnType<typeof lineDiffStats>;
}): string {
  const opLines = args.ops
    .map((op, i) => `  ${pad(`${i + 1}.`, 4)}${formatOp(op)}`)
    .join("\n");
  const beforeIssues = args.beforeDiagnostics.length
    ? formatDiagnostics(args.beforeDiagnostics)
    : "(no issues)";
  const afterIssues = args.afterDiagnostics.length
    ? formatDiagnostics(args.afterDiagnostics)
    : "(no issues — clean validate)";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<title>Noma demo — agent updates a stale research memo</title>
<meta name="viewport" content="width=device-width, initial-scale=1" />
<style>
  :root { color-scheme: light; }
  body { font: 16px/1.55 ui-sans-serif, system-ui, -apple-system, "Segoe UI",
    Roboto, sans-serif; max-width: 960px; margin: 2rem auto; padding: 0 1rem;
    color: #1a1a1a; }
  h1 { font-size: 1.6rem; margin-bottom: 0.25rem; }
  h2 { font-size: 1.15rem; margin-top: 2rem; border-bottom: 1px solid #e5e5e5;
    padding-bottom: 0.25rem; }
  .lead { color: #555; }
  pre { background: #f6f7f9; border: 1px solid #e2e4e8; border-radius: 8px;
    padding: 0.75rem 1rem; overflow-x: auto; font-size: 0.9rem;
    line-height: 1.45; }
  pre.bad { background: #fff5f4; border-color: #f5c2bc; }
  pre.ok { background: #f1faf3; border-color: #c6e7cf; }
  .stats { display: grid; grid-template-columns: repeat(3, 1fr); gap: 1rem;
    margin: 1rem 0; }
  .stat { background: #fafafa; border: 1px solid #e2e4e8; border-radius: 8px;
    padding: 0.75rem 1rem; }
  .stat .label { color: #555; font-size: 0.85rem; }
  .stat .value { font-size: 1.4rem; font-weight: 600; }
  .pill { display: inline-block; background: #f0eef7; color: #4f3eaa;
    border-radius: 999px; padding: 0.1rem 0.6rem; font-size: 0.8rem;
    margin-right: 0.25rem; }
  .diff { display: grid; grid-template-columns: 1fr 1fr; gap: 0.75rem; }
  @media (max-width: 800px) { .diff, .stats { grid-template-columns: 1fr; } }
  footer { margin-top: 3rem; color: #777; font-size: 0.85rem; }
  a { color: #4f3eaa; }
</style>
</head>
<body>
<h1>Agent updates a stale research memo — without rewriting the file</h1>
<p class="lead">A live trace of the Noma agent patch protocol against
<code>examples/agent-stale-memo/memo.noma</code>. Five block-level operations
refresh stale citations, raise a claim's confidence, attach fresh evidence,
and escalate one risk. Every unrelated byte stays put.</p>

<div class="stats">
  <div class="stat"><div class="label">Patch operations</div>
    <div class="value">${args.ops.length}</div></div>
  <div class="stat"><div class="label">Lines changed</div>
    <div class="value">${args.stats.changedLines} / ${args.stats.totalLines}</div></div>
  <div class="stat"><div class="label">Bytes preserved</div>
    <div class="value">${args.stats.unchangedPct.toFixed(1)}%</div></div>
</div>

<h2>1. Validate before — stale citations flagged</h2>
<pre class="bad">${escapeHtml(beforeIssues)}</pre>

<h2>2. Patch operations the agent issues</h2>
<pre>${escapeHtml(opLines)}</pre>

<h2>3. Apply via <code>patchSource</code> — line range only</h2>
<p><code>patchSource(source, ops)</code> rewrites only the targeted line range
for each op. Frontmatter quoting, sibling blocks, attribute order on
unchanged lines, and blank-line padding all survive byte-for-byte.</p>

<div class="diff">
  <div>
    <h3>Before (${args.stats.byteBefore} bytes)</h3>
    <pre>${escapeHtml(args.before)}</pre>
  </div>
  <div>
    <h3>After (${args.stats.byteAfter} bytes)</h3>
    <pre>${escapeHtml(args.after)}</pre>
  </div>
</div>

<h2>4. Validate after — clean</h2>
<pre class="ok">${escapeHtml(afterIssues)}</pre>

<footer>
<p>Reproduce: <code>npm run demo:stale-memo</code>. Source:
<a href="https://github.com/ferax564/noma/tree/main/examples/agent-stale-memo">examples/agent-stale-memo/</a>.
Protocol: <a href="../../docs/agent-protocol.html">docs/agent-protocol.noma</a>.</p>
</footer>
</body>
</html>
`;
}

function formatOp(op: PatchOp): string {
  switch (op.op) {
    case "update_attribute":
      return `update_attribute   id=${op.id}   ${op.key}=${JSON.stringify(op.value)}`;
    case "rename_id":
      return `rename_id          ${op.from} → ${op.to}`;
    case "delete_block":
      return `delete_block       id=${op.id}`;
    case "add_block":
      return `add_block          parent=${op.parent}${op.position !== undefined ? `   position=${op.position}` : ""}   <inline content>`;
    case "replace_block":
      return `replace_block      id=${op.id}   <inline content>`;
  }
}

function main(): void {
  const before = readFileSync(SRC, "utf8");
  const ops = JSON.parse(readFileSync(PATCHES, "utf8")) as PatchOp[];

  const docBefore = parse(before, { filename: SRC });
  const beforeDiagnostics = validate(docBefore, { now: reviewDate() });

  const after = patchSource(before, ops);

  const docAfter = parse(after, { filename: SRC });
  const afterDiagnostics = validate(docAfter, { now: reviewDate() });

  const stats = lineDiffStats(before, after);

  ensureDir(OUT_DIR);
  writeFileSync(resolve(OUT_DIR, "memo.before.noma"), before);
  writeFileSync(resolve(OUT_DIR, "memo.after.noma"), after);
  writeFileSync(
    resolve(OUT_DIR, "trace.html"),
    renderTrace({
      before,
      after,
      ops,
      beforeDiagnostics,
      afterDiagnostics,
      stats,
    }),
  );

  console.log("noma agent-stale-memo demo");
  console.log("--------------------------");
  console.log(`source:    ${SRC}`);
  console.log(`patches:   ${PATCHES}  (${ops.length} ops)`);
  console.log("");
  console.log(
    `before:    ${beforeDiagnostics.length} diagnostic(s) — stale-citation, etc.`,
  );
  console.log(
    `after:     ${afterDiagnostics.length} diagnostic(s) — should be 0`,
  );
  console.log("");
  console.log(
    `bytes:     ${stats.byteBefore} → ${stats.byteAfter}   (${stats.byteAfter - stats.byteBefore >= 0 ? "+" : ""}${stats.byteAfter - stats.byteBefore})`,
  );
  console.log(
    `lines:     ${stats.changedLines}/${stats.totalLines} changed   (${stats.unchangedPct.toFixed(1)}% preserved)`,
  );
  console.log(`trace:     ${resolve(OUT_DIR, "trace.html")}`);

  if (afterDiagnostics.length > 0) {
    console.error("");
    console.error("after-validate is NOT clean:");
    console.error(formatDiagnostics(afterDiagnostics));
    process.exitCode = 1;
  }
}

main();
