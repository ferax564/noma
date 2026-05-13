import { dirname, resolve } from "node:path";
import { copyFileSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { NomaTools, NomaWorkflow } from "../src/index.js";
import type { PatchOp } from "../src/index.js";

// Resolve relative to repo root, not process.cwd(). The npm workspace
// (`npm run demo:agent-stale-memo -w @noma/agent-sdk`) sets cwd to
// packages/agent-sdk/, so `resolve("examples/...")` would look under
// the workspace, not the repo root. Walk up from this file's URL instead.
const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "../../..");
const FIXTURE = resolve(REPO_ROOT, "examples/agent-stale-memo");
const OUT_DIR = resolve(REPO_ROOT, "dist/examples/agent-stale-memo-sdk");

export async function runDemo(): Promise<{
  outDir: string;
  patchedFile: string;
  ops: number;
}> {
  mkdirSync(OUT_DIR, { recursive: true });
  const src = resolve(FIXTURE, "memo.noma");
  const dst = resolve(OUT_DIR, "memo.after.noma");
  copyFileSync(src, dst);

  const tools = await NomaTools.spawn();
  try {
    const wf = new NomaWorkflow(tools);
    // patches.json is a flat array — no { ops: [...] } envelope in this fixture.
    // The discriminated read below handles both shapes so the demo stays forward-compat.
    const raw = JSON.parse(readFileSync(resolve(FIXTURE, "patches.json"), "utf8")) as
      | { ops: PatchOp[] }
      | PatchOp[];
    const ops = Array.isArray(raw) ? raw : raw.ops;
    const results = await wf.applyOps(dst, ops, { stopOnFirstError: true });
    writeFileSync(resolve(OUT_DIR, "trace.html"), renderTrace(results));
    return { outDir: OUT_DIR, patchedFile: dst, ops: results.length };
  } finally {
    await tools.close();
  }
}

function renderTrace(results: Awaited<ReturnType<NomaWorkflow["applyOps"]>>): string {
  const rows = results
    .map((r, i) => {
      if (r.ok) {
        return `<tr><td>${i + 1}</td><td>applied</td><td>${r.transcriptEntry.op.op}</td><td>${r.postValidation}</td></tr>`;
      }
      return `<tr><td>${i + 1}</td><td>failed</td><td>${r.code ?? "?"}</td><td>—</td></tr>`;
    })
    .join("\n");
  return `<!doctype html><meta charset="utf-8"><title>agent-stale-memo-sdk</title><table border="1"><thead><tr><th>#</th><th>result</th><th>op</th><th>validation</th></tr></thead><tbody>${rows}</tbody></table>`;
}

// CLI entrypoint guard. Compares the file being invoked by `node`/`tsx`
// against this module's path so importing the module from a test does NOT
// run the demo as a side effect. The earlier `import.meta.url === \`file://...\``
// form is tautological because `fileURLToPath(import.meta.url)` always
// round-trips to the same URL — it fires on every import.
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  runDemo()
    .then((r) => console.log(`wrote ${r.outDir}/trace.html (${r.ops} ops)`))
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
