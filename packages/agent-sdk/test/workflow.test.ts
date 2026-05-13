import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { NomaTools } from "../src/tools.js";
import { NomaWorkflow } from "../src/workflow.js";

let tools: NomaTools;

before(async () => {
  tools = await NomaTools.spawn();
});

after(async () => {
  await tools.close();
});

function scratchDoc(content: string, name = "doc.noma"): string {
  const dir = mkdtempSync(join(tmpdir(), "noma-wf-"));
  const path = join(dir, name);
  writeFileSync(path, content, "utf8");
  return path;
}

test("NomaWorkflow constructs over a NomaTools instance and borrows the handle", () => {
  const wf = new NomaWorkflow(tools);
  assert.ok(wf);
});

test("safePatch succeeds on first try when SHA matches", async () => {
  const path = scratchDoc(`# H\n\n::claim{id="c1" confidence=0.5}\nbody\n::\n`);
  const wf = new NomaWorkflow(tools);
  const res = await wf.safePatch(path, {
    op: "update_attribute",
    id: "c1",
    key: "confidence",
    value: 0.9,
  });
  assert.equal(res.ok, true);
});

test("safePatch serializes concurrent same-file calls (mutex ordering)", async () => {
  // Without a mutex, both calls would read the same SHA, one would patch,
  // the other would hit sha_mismatch and retry. With a mutex, the second
  // call waits for the first to finish before reading SHA — so we observe:
  //  (a) no patchBlock call sees sha_mismatch (no retries), AND
  //  (b) the two patchBlock invocations do not overlap in time.
  // Pure value-equality on the final document would pass without a mutex
  // (retry would still converge), which is why this test instruments timing
  // and retry-count rather than final state.
  const path = scratchDoc(
    `# H\n\n::claim{id="c1" confidence=0.5}\nbody\n::\n::claim{id="c2" confidence=0.5}\nb\n::\n`,
  );
  const wf = new NomaWorkflow(tools);

  const originalPatch = tools.patchBlock.bind(tools);
  const spans: Array<{ start: number; end: number }> = [];
  let shaMismatchSeen = 0;
  (tools as { patchBlock: typeof tools.patchBlock }).patchBlock = async (f, op, opts) => {
    const start = Date.now();
    const res = await originalPatch(f, op, opts);
    spans.push({ start, end: Date.now() });
    if (!res.ok && res.code === "sha_mismatch") shaMismatchSeen++;
    return res;
  };

  try {
    const [a, b] = await Promise.all([
      wf.safePatch(path, { op: "update_attribute", id: "c1", key: "confidence", value: 0.7 }),
      wf.safePatch(path, { op: "update_attribute", id: "c2", key: "confidence", value: 0.8 }),
    ]);
    assert.equal(a.ok, true);
    assert.equal(b.ok, true);
    assert.equal(shaMismatchSeen, 0, "mutex should prevent sha_mismatch retries on concurrent same-file calls");
    // Sort spans by start time; assert no overlap.
    spans.sort((x, y) => x.start - y.start);
    for (let i = 1; i < spans.length; i++) {
      const cur = spans[i];
      const prev = spans[i - 1];
      assert.ok(
        cur !== undefined && prev !== undefined && cur.start >= prev.end,
        `patchBlock invocations overlapped: ${JSON.stringify(spans)}`,
      );
    }
  } finally {
    (tools as { patchBlock: typeof tools.patchBlock }).patchBlock = originalPatch;
  }
});

test("safePatch retries after an external writer changes the file, then succeeds", async () => {
  const path = scratchDoc(`# H\n\n::claim{id="c1" confidence=0.5}\nbody\n::\n`);
  const wf = new NomaWorkflow(tools);

  const originalPatch = tools.patchBlock.bind(tools);
  let calls = 0;
  (tools as { patchBlock: typeof tools.patchBlock }).patchBlock = async (f, op, opts) => {
    if (calls++ === 0) {
      writeFileSync(f, readFileSync(f, "utf8").replace("confidence=0.5", "confidence=0.6"));
    }
    return originalPatch(f, op, opts);
  };

  try {
    const res = await wf.safePatch(
      path,
      { op: "update_attribute", id: "c1", key: "confidence", value: 0.9 },
      { retryOnShaMismatch: 3 },
    );
    assert.equal(res.ok, true);
    assert.equal(calls >= 2, true, `expected >=2 attempts, got ${calls}`);
  } finally {
    (tools as { patchBlock: typeof tools.patchBlock }).patchBlock = originalPatch;
  }
});

test("safePatch clamps negative/huge retryOnShaMismatch values", async () => {
  const path = scratchDoc(`# H\n\n::claim{id="c1" confidence=0.5}\nbody\n::\n`);
  const wf = new NomaWorkflow(tools);
  // Negative: clamped to 0 → exactly one attempt.
  const r1 = await wf.safePatch(
    path,
    { op: "update_attribute", id: "c1", key: "confidence", value: 0.91 },
    { retryOnShaMismatch: -5 },
  );
  assert.equal(r1.ok, true);
  // NaN: falls through to default (3 retries).
  const r2 = await wf.safePatch(
    path,
    { op: "update_attribute", id: "c1", key: "confidence", value: 0.92 },
    { retryOnShaMismatch: Number.NaN },
  );
  assert.equal(r2.ok, true);
});

test("safePatch returns the last sha_mismatch after exhausting retries", async () => {
  const path = scratchDoc(`# H\n\n::claim{id="c1" confidence=0.5}\nbody\n::\n`);
  const wf = new NomaWorkflow(tools);

  const originalPatch = tools.patchBlock.bind(tools);
  // Use a deterministic monotonically-changing value so the file SHA always
  // differs between attempts. Math.random() can collide with the existing
  // value (no-op write → same SHA → patch unexpectedly succeeds), making
  // the test flaky.
  let mutationN = 0;
  (tools as { patchBlock: typeof tools.patchBlock }).patchBlock = async (f, op, opts) => {
    const next = (++mutationN).toString().padStart(4, "0");
    writeFileSync(
      f,
      readFileSync(f, "utf8").replace(/confidence=\d+(?:\.\d+)?/, `confidence=0.${next}`),
    );
    return originalPatch(f, op, opts);
  };

  try {
    const res = await wf.safePatch(
      path,
      { op: "update_attribute", id: "c1", key: "confidence", value: 0.99 },
      { retryOnShaMismatch: 2 },
    );
    assert.equal(res.ok, false);
    if (!res.ok) assert.equal(res.code, "sha_mismatch");
  } finally {
    (tools as { patchBlock: typeof tools.patchBlock }).patchBlock = originalPatch;
  }
});
