import { test, before } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runDemo as runStaleMemoSdk } from "../scripts/agent-stale-memo-sdk.js";
import { runDemo as runAgentMemorySdk } from "../scripts/agent-memory-demo-sdk.js";

// Baseline paths come from the existing non-SDK demos. agent-stale-memo
// writes `memo.after.noma` (scripts/agent-stale-memo.ts:214); agent-memory
// writes `memory.after.noma` (scripts/agent-memory-demo.ts:266). Don't
// confuse with the unmutated `memo.noma`/`memory.noma` fixtures the demos
// copy as input.
// Resolve baselines relative to repo root, not process.cwd() — workspace
// tests run with cwd=packages/agent-sdk/.
const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "../../..");
const BASELINE_STALE = resolve(REPO_ROOT, "dist/examples/agent-stale-memo/memo.after.noma");
const BASELINE_MEMORY = resolve(REPO_ROOT, "dist/examples/agent-memory/memory.after.noma");

before(() => {
  if (!existsSync(BASELINE_STALE)) {
    throw new Error(
      `baseline missing: ${BASELINE_STALE}. Run 'npm run demo:stale-memo' first.`,
    );
  }
  if (!existsSync(BASELINE_MEMORY)) {
    throw new Error(
      `baseline missing: ${BASELINE_MEMORY}. Run 'npm run demo:agent-memory' first.`,
    );
  }
});

test("agent-stale-memo SDK port produces byte-identical final document", async () => {
  const r = await runStaleMemoSdk();
  const sdkDoc = readFileSync(r.patchedFile, "utf8");
  const baseline = readFileSync(BASELINE_STALE, "utf8");
  assert.equal(sdkDoc, baseline, "SDK port and baseline produced different final documents");
});

test("agent-memory SDK port produces byte-identical final document", async () => {
  const r = await runAgentMemorySdk();
  const sdkDoc = readFileSync(r.patchedFile, "utf8");
  const baseline = readFileSync(BASELINE_MEMORY, "utf8");
  assert.equal(sdkDoc, baseline, "SDK port and baseline produced different final documents");
});
