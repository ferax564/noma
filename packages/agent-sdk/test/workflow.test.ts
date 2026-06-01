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

test("applyOps runs ops sequentially and returns one result per op", async () => {
  const path = scratchDoc(
    `# H\n\n::claim{id="c1" confidence=0.5}\nA\n::\n::claim{id="c2" confidence=0.5}\nB\n::\n`,
  );
  const wf = new NomaWorkflow(tools);
  const results = await wf.applyOps(path, [
    { op: "update_attribute", id: "c1", key: "confidence", value: 0.7 },
    { op: "update_attribute", id: "c2", key: "confidence", value: 0.8 },
  ]);
  assert.equal(results.length, 2);
  const r0 = results[0];
  const r1 = results[1];
  assert.ok(r0);
  assert.ok(r1);
  assert.equal(r0.ok, true);
  assert.equal(r1.ok, true);
});

test("applyOps short-circuits on first failure when stopOnFirstError=true", async () => {
  const path = scratchDoc(`# H\n\n::claim{id="c1"}\nbody\n::\n`);
  const wf = new NomaWorkflow(tools);
  const results = await wf.applyOps(
    path,
    [
      { op: "delete_block", id: "does-not-exist" },
      { op: "update_attribute", id: "c1", key: "confidence", value: 0.9 },
    ],
    { stopOnFirstError: true },
  );
  assert.equal(results.length, 1);
  const r0 = results[0];
  assert.ok(r0);
  assert.equal(r0.ok, false);
});

test("applyOps continues past failures when stopOnFirstError=false", async () => {
  const path = scratchDoc(`# H\n\n::claim{id="c1" confidence=0.5}\nbody\n::\n`);
  const wf = new NomaWorkflow(tools);
  const results = await wf.applyOps(
    path,
    [
      { op: "delete_block", id: "does-not-exist" },
      { op: "update_attribute", id: "c1", key: "confidence", value: 0.9 },
    ],
    { stopOnFirstError: false },
  );
  assert.equal(results.length, 2);
  const r0 = results[0];
  const r1 = results[1];
  assert.ok(r0);
  assert.ok(r1);
  assert.equal(r0.ok, false);
  assert.equal(r1.ok, true);
});

test("applyOps chains parent_op_id when parentChain=true", async () => {
  const path = scratchDoc(
    `# H\n\n::claim{id="c1" confidence=0.5}\nA\n::\n::claim{id="c2" confidence=0.5}\nB\n::\n`,
  );
  const wf = new NomaWorkflow(tools);
  const results = await wf.applyOps(path, [
    { op: "update_attribute", id: "c1", key: "confidence", value: 0.7 },
    { op: "update_attribute", id: "c2", key: "confidence", value: 0.8 },
  ]);
  assert.equal(results.every((r) => r.ok), true);
  const r0 = results[0];
  const r1 = results[1];
  assert.ok(r0);
  assert.ok(r1);
  assert.ok(r0.ok && r1.ok);
  const parent = r0.transcriptEntry.op_id;
  assert.equal(r1.transcriptEntry.parent_op_id, parent);
});

test("replayTranscript returns [] when no .patches file exists", async () => {
  const path = scratchDoc(`# H\n`);
  const wf = new NomaWorkflow(tools);
  const records = await wf.replayTranscript(path);
  assert.deepEqual(records, []);
});

test("replayTranscript round-trips records written by applyOps", async () => {
  const path = scratchDoc(
    `# H\n\n::claim{id="c1" confidence=0.5}\nA\n::\n::claim{id="c2" confidence=0.5}\nB\n::\n`,
  );
  const wf = new NomaWorkflow(tools);
  await wf.applyOps(path, [
    { op: "update_attribute", id: "c1", key: "confidence", value: 0.7 },
    { op: "update_attribute", id: "c2", key: "confidence", value: 0.8 },
  ]);
  const records = await wf.replayTranscript(path);
  assert.equal(records.length, 2);
  const rec0 = records[0];
  const rec1 = records[1];
  assert.ok(rec0);
  assert.ok(rec1);
  assert.equal(rec0.op.op, "update_attribute");
  assert.equal(rec0.patch_result, "applied");
  assert.equal(rec1.parent_op_id, rec0.op_id);
});

test("readCapabilities returns null when sidecar absent", async () => {
  const path = scratchDoc(`# H\n`);
  const wf = new NomaWorkflow(tools);
  const desc = await wf.readCapabilities(path);
  assert.equal(desc, null);
});

test("readCapabilities parses sidecar when present", async () => {
  const path = scratchDoc(`# H\n`);
  writeFileSync(
    `${path}.capabilities.yml`,
    "nomaAgent:\n  version: 1\n  profile: test\n",
  );
  const wf = new NomaWorkflow(tools);
  const desc = await wf.readCapabilities(path);
  assert.ok(desc);
  assert.equal(desc.profile, "test");
});

test("checkCapability returns no_descriptor when sidecar absent", async () => {
  const path = scratchDoc(`# H\n\n::claim{id="c1"}\nbody\n::\n`);
  const wf = new NomaWorkflow(tools);
  const r = await wf.checkCapability(path, {
    op: "update_attribute",
    id: "c1",
    key: "confidence",
    value: 0.9,
  });
  assert.equal(r.allowed, false);
  if (!r.allowed) assert.equal(r.reason, "no_descriptor");
});

test("checkCapability returns block_not_listed when descriptor omits the block name", async () => {
  const path = scratchDoc(`# H\n\n::claim{id="c1"}\nbody\n::\n`);
  writeFileSync(
    `${path}.capabilities.yml`,
    "nomaAgent:\n  version: 1\n  blocks:\n    evidence:\n      ops: [replace_block]\n",
  );
  const wf = new NomaWorkflow(tools);
  const r = await wf.checkCapability(path, {
    op: "update_attribute",
    id: "c1",
    key: "confidence",
    value: 0.9,
  });
  assert.equal(r.allowed, false);
  if (!r.allowed) assert.equal(r.reason, "block_not_listed");
});

test("checkCapability returns op_not_granted when block lists the type but not the op", async () => {
  const path = scratchDoc(`# H\n\n::claim{id="c1"}\nbody\n::\n`);
  writeFileSync(
    `${path}.capabilities.yml`,
    "nomaAgent:\n  version: 1\n  blocks:\n    claim:\n      ops: [replace_block]\n",
  );
  const wf = new NomaWorkflow(tools);
  const r = await wf.checkCapability(path, {
    op: "update_attribute",
    id: "c1",
    key: "confidence",
    value: 0.9,
  });
  assert.equal(r.allowed, false);
  if (!r.allowed) assert.equal(r.reason, "op_not_granted");
});

test("checkCapability returns attr_constraint_violated when value violates range", async () => {
  const path = scratchDoc(`# H\n\n::claim{id="c1"}\nbody\n::\n`);
  writeFileSync(
    `${path}.capabilities.yml`,
    "nomaAgent:\n  version: 1\n  blocks:\n    claim:\n      ops: [update_attribute]\n      attrs:\n        confidence:\n          type: number\n          min: 0\n          max: 1\n",
  );
  const wf = new NomaWorkflow(tools);
  const r = await wf.checkCapability(path, {
    op: "update_attribute",
    id: "c1",
    key: "confidence",
    value: 1.5,
  });
  assert.equal(r.allowed, false);
  if (!r.allowed) assert.equal(r.reason, "attr_constraint_violated");
});

test("checkCapability returns rename_globally_denied when ids.rename is false", async () => {
  // Annex A.3 — per-block ops grant is necessary but not sufficient for rename_id.
  const path = scratchDoc(`# H\n\n::claim{id="c1"}\nbody\n::\n`);
  writeFileSync(
    `${path}.capabilities.yml`,
    "nomaAgent:\n  version: 1\n  ids:\n    rename: false\n  blocks:\n    claim:\n      ops: [rename_id]\n",
  );
  const wf = new NomaWorkflow(tools);
  const r = await wf.checkCapability(path, {
    op: "rename_id",
    from: "c1",
    to: "c2",
  });
  assert.equal(r.allowed, false);
  if (!r.allowed) assert.equal(r.reason, "rename_globally_denied");
});

test("checkCapability allows rename_id when ids.rename=true AND ops includes it", async () => {
  const path = scratchDoc(`# H\n\n::claim{id="c1"}\nbody\n::\n`);
  writeFileSync(
    `${path}.capabilities.yml`,
    "nomaAgent:\n  version: 1\n  ids:\n    rename: true\n  blocks:\n    claim:\n      ops: [rename_id]\n",
  );
  const wf = new NomaWorkflow(tools);
  const r = await wf.checkCapability(path, {
    op: "rename_id",
    from: "c1",
    to: "c-renamed",
  });
  assert.equal(r.allowed, true);
});

test("checkCapability returns allowed=true when policy matches", async () => {
  const path = scratchDoc(`# H\n\n::claim{id="c1"}\nbody\n::\n`);
  writeFileSync(
    `${path}.capabilities.yml`,
    "nomaAgent:\n  version: 1\n  blocks:\n    claim:\n      ops: [update_attribute]\n      attrs:\n        confidence:\n          type: number\n          min: 0\n          max: 1\n",
  );
  const wf = new NomaWorkflow(tools);
  const r = await wf.checkCapability(path, {
    op: "update_attribute",
    id: "c1",
    key: "confidence",
    value: 0.5,
  });
  assert.equal(r.allowed, true);
});

test("checkCapability checks add_comment against the commented block", async () => {
  const path = scratchDoc(`# H\n\n::claim{id="c1"}\nbody\n::\n`);
  writeFileSync(
    `${path}.capabilities.yml`,
    "nomaAgent:\n  version: 1\n  blocks:\n    claim:\n      ops: [add_comment]\n",
  );
  const wf = new NomaWorkflow(tools);
  const r = await wf.checkCapability(path, {
    op: "add_comment",
    id: "comment-c1",
    target: "c1",
    content: "Review this claim.",
  });
  assert.equal(r.allowed, true);
});

test("checkCapability checks resolve_comment against the comment block", async () => {
  const path = scratchDoc(`# H\n\n::comment{id="comment-c1" parent="c1"}\nReview this.\n::\n`);
  writeFileSync(
    `${path}.capabilities.yml`,
    "nomaAgent:\n  version: 1\n  blocks:\n    comment:\n      ops: [resolve_comment]\n",
  );
  const wf = new NomaWorkflow(tools);
  const r = await wf.checkCapability(path, {
    op: "resolve_comment",
    id: "comment-c1",
    resolved_by: "Andrea",
  });
  assert.equal(r.allowed, true);
});

test("checkCapability checks add_change_request against the reviewed block", async () => {
  const path = scratchDoc(`# H\n\n::claim{id="c1"}\nbody\n::\n`);
  writeFileSync(
    `${path}.capabilities.yml`,
    "nomaAgent:\n  version: 1\n  blocks:\n    claim:\n      ops: [add_change_request]\n",
  );
  const wf = new NomaWorkflow(tools);
  const r = await wf.checkCapability(path, {
    op: "add_change_request",
    id: "cr-c1",
    target: "c1",
    action: "replace",
    from: "old",
    to: "new",
  });
  assert.equal(r.allowed, true);
});

test("checkCapability checks add_footnote against the noted block", async () => {
  const path = scratchDoc(`# H\n\n::claim{id="c1"}\nbody\n::\n`);
  writeFileSync(
    `${path}.capabilities.yml`,
    "nomaAgent:\n  version: 1\n  blocks:\n    claim:\n      ops: [add_footnote]\n",
  );
  const wf = new NomaWorkflow(tools);
  const r = await wf.checkCapability(path, {
    op: "add_footnote",
    id: "fn-c1",
    target: "c1",
    content: "Add a native note.",
  });
  assert.equal(r.allowed, true);
});

test("checkCapability checks update_table_cell against the table block", async () => {
  const path = scratchDoc(`# H\n\n::table{id="metrics" header}\n| Metric | Value |\n| ARR | 10m |\n::\n`);
  writeFileSync(
    `${path}.capabilities.yml`,
    "nomaAgent:\n  version: 1\n  blocks:\n    table:\n      ops: [update_table_cell]\n",
  );
  const wf = new NomaWorkflow(tools);
  const r = await wf.checkCapability(path, {
    op: "update_table_cell",
    id: "metrics",
    row: 0,
    column: "Value",
    value: "11m",
  });
  assert.equal(r.allowed, true);
});

test("checkCapability checks update_table_header_cell against the table block", async () => {
  const path = scratchDoc(`# H\n\n::table{id="metrics" header}\n| Metric | Value |\n| ARR | 10m |\n::\n`);
  writeFileSync(
    `${path}.capabilities.yml`,
    "nomaAgent:\n  version: 1\n  blocks:\n    table:\n      ops: [update_table_header_cell]\n",
  );
  const wf = new NomaWorkflow(tools);
  const r = await wf.checkCapability(path, {
    op: "update_table_header_cell",
    id: "metrics",
    column: "Value",
    value: "Revenue",
  });
  assert.equal(r.allowed, true);
});

test("checkCapability checks update_dataset_cell against the dataset block", async () => {
  const path = scratchDoc(`# H\n\n::dataset{id="scores"}\nschema:\n  vertical: string\n  score: number\nrows:\n  - [legal, 18]\n::\n`);
  writeFileSync(
    `${path}.capabilities.yml`,
    "nomaAgent:\n  version: 1\n  blocks:\n    dataset:\n      ops: [update_dataset_cell]\n",
  );
  const wf = new NomaWorkflow(tools);
  const r = await wf.checkCapability(path, {
    op: "update_dataset_cell",
    id: "scores",
    row: 0,
    column: "score",
    value: "19",
  });
  assert.equal(r.allowed, true);
});

test("checkCapability checks insert_dataset_row against the dataset block", async () => {
  const path = scratchDoc(`# H\n\n::dataset{id="scores"}\nschema:\n  vertical: string\n  score: number\nrows:\n  - [legal, 18]\n::\n`);
  writeFileSync(
    `${path}.capabilities.yml`,
    "nomaAgent:\n  version: 1\n  blocks:\n    dataset:\n      ops: [insert_dataset_row]\n",
  );
  const wf = new NomaWorkflow(tools);
  const r = await wf.checkCapability(path, {
    op: "insert_dataset_row",
    id: "scores",
    row: 1,
    cells: ["finance", "24"],
  });
  assert.equal(r.allowed, true);
});

test("checkCapability checks delete_dataset_row against the dataset block", async () => {
  const path = scratchDoc(`# H\n\n::dataset{id="scores"}\nschema:\n  vertical: string\n  score: number\nrows:\n  - [legal, 18]\n::\n`);
  writeFileSync(
    `${path}.capabilities.yml`,
    "nomaAgent:\n  version: 1\n  blocks:\n    dataset:\n      ops: [delete_dataset_row]\n",
  );
  const wf = new NomaWorkflow(tools);
  const r = await wf.checkCapability(path, {
    op: "delete_dataset_row",
    id: "scores",
    row: 0,
  });
  assert.equal(r.allowed, true);
});

test("checkCapability checks insert_dataset_column against the dataset block", async () => {
  const path = scratchDoc(`# H\n\n::dataset{id="scores"}\nschema:\n  vertical: string\n  score: number\nrows:\n  - [legal, 18]\n::\n`);
  writeFileSync(
    `${path}.capabilities.yml`,
    "nomaAgent:\n  version: 1\n  blocks:\n    dataset:\n      ops: [insert_dataset_column]\n",
  );
  const wf = new NomaWorkflow(tools);
  const r = await wf.checkCapability(path, {
    op: "insert_dataset_column",
    id: "scores",
    column: 1,
    header: "owner",
    cells: ["Research"],
  });
  assert.equal(r.allowed, true);
});

test("checkCapability checks delete_dataset_column against the dataset block", async () => {
  const path = scratchDoc(`# H\n\n::dataset{id="scores"}\nschema:\n  vertical: string\n  owner: string\n  score: number\nrows:\n  - [legal, Research, 18]\n::\n`);
  writeFileSync(
    `${path}.capabilities.yml`,
    "nomaAgent:\n  version: 1\n  blocks:\n    dataset:\n      ops: [delete_dataset_column]\n",
  );
  const wf = new NomaWorkflow(tools);
  const r = await wf.checkCapability(path, {
    op: "delete_dataset_column",
    id: "scores",
    column: "owner",
  });
  assert.equal(r.allowed, true);
});

test("checkCapability checks insert_table_row against the table block", async () => {
  const path = scratchDoc(`# H\n\n::table{id="metrics" header}\n| Metric | Value |\n| ARR | 10m |\n::\n`);
  writeFileSync(
    `${path}.capabilities.yml`,
    "nomaAgent:\n  version: 1\n  blocks:\n    table:\n      ops: [insert_table_row]\n",
  );
  const wf = new NomaWorkflow(tools);
  const r = await wf.checkCapability(path, {
    op: "insert_table_row",
    id: "metrics",
    row: 1,
    cells: ["NRR", "120%"],
  });
  assert.equal(r.allowed, true);
});

test("checkCapability checks delete_table_row against the table block", async () => {
  const path = scratchDoc(`# H\n\n::table{id="metrics" header}\n| Metric | Value |\n| ARR | 10m |\n::\n`);
  writeFileSync(
    `${path}.capabilities.yml`,
    "nomaAgent:\n  version: 1\n  blocks:\n    table:\n      ops: [delete_table_row]\n",
  );
  const wf = new NomaWorkflow(tools);
  const r = await wf.checkCapability(path, {
    op: "delete_table_row",
    id: "metrics",
    row: 0,
  });
  assert.equal(r.allowed, true);
});

test("checkCapability checks insert_table_column against the table block", async () => {
  const path = scratchDoc(`# H\n\n::table{id="metrics" header}\n| Metric | Value |\n| ARR | 10m |\n::\n`);
  writeFileSync(
    `${path}.capabilities.yml`,
    "nomaAgent:\n  version: 1\n  blocks:\n    table:\n      ops: [insert_table_column]\n",
  );
  const wf = new NomaWorkflow(tools);
  const r = await wf.checkCapability(path, {
    op: "insert_table_column",
    id: "metrics",
    column: 1,
    header: "Owner",
    cells: ["Finance"],
  });
  assert.equal(r.allowed, true);
});

test("checkCapability checks delete_table_column against the table block", async () => {
  const path = scratchDoc(`# H\n\n::table{id="metrics" header}\n| Metric | Owner | Value |\n| ARR | Finance | 10m |\n::\n`);
  writeFileSync(
    `${path}.capabilities.yml`,
    "nomaAgent:\n  version: 1\n  blocks:\n    table:\n      ops: [delete_table_column]\n",
  );
  const wf = new NomaWorkflow(tools);
  const r = await wf.checkCapability(path, {
    op: "delete_table_column",
    id: "metrics",
    column: "Owner",
  });
  assert.equal(r.allowed, true);
});

test("checkCapability checks move_block against the moved block", async () => {
  const path = scratchDoc(`# H\n\n::risk{id="r1"}\nRisk.\n::\n\n::section_marker{id="target"}\n::\n`);
  writeFileSync(
    `${path}.capabilities.yml`,
    "nomaAgent:\n  version: 1\n  blocks:\n    risk:\n      ops: [move_block]\n",
  );
  const wf = new NomaWorkflow(tools);
  const r = await wf.checkCapability(path, {
    op: "move_block",
    id: "r1",
    parent: "target",
  });
  assert.equal(r.allowed, true);
});
