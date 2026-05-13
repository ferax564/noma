import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readdirSync, existsSync, copyFileSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { NomaTools } from "../src/tools.js";
import { NomaWorkflow } from "../src/workflow.js";
import type { PatchErrorCode } from "../src/types.js";

// Source: src/patch.ts:29. Nine codes total; this aggregator covers the
// seven that are reachable through a single patch_block call.
//
// pre_validation_blocked and op_list_aborted are emitted by the in-process
// patchAll() flow that v1.1's patch_block_list tool will expose (Annex B.8).
// v0.1 SDK does NOT expose batched atomic ops — applyOps is client-side
// sequential and short-circuits via PatchFailure, not via op_list_aborted.
// Codes are listed in PatchErrorCode for forward-compat but are NOT in
// the v0.1 graduation metric. When patch_block_list lands (v1.1), the
// aggregator gets an applyOpsList test that exercises both codes.
const ALL_CODES: PatchErrorCode[] = [
  "target_missing",
  "parent_missing",
  "id_conflict",
  "invalid_content",
  "id_attribute_protected",
  "sha_mismatch",
  "unsupported_op",
];

// Resolve relative to repo root, not process.cwd() — workspace tests
// run with cwd=packages/agent-sdk/.
const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "../../..");

test("graduation metrics: error code coverage + descriptor shape + conformance corpus size", async () => {
  const tools = await NomaTools.spawn();
  try {
    const wf = new NomaWorkflow(tools);
    const seenCodes = new Set<string>();

    const dir = mkdtempSync(join(tmpdir(), "noma-grad-"));
    const fixture = join(dir, "doc.noma");
    writeFileSync(
      fixture,
      `# H\n\n::claim{id="c1" confidence=0.5}\nbody\n::\n::claim{id="c2"}\nb\n::\n`,
    );

    // target_missing
    let r = await tools.patchBlock(fixture, { op: "delete_block", id: "nope" });
    if (!r.ok && r.code) seenCodes.add(r.code);
    // sha_mismatch
    r = await tools.patchBlock(
      fixture,
      { op: "update_attribute", id: "c1", key: "confidence", value: 0.7 },
      { expectedSha: "deadbeef" },
    );
    if (!r.ok && r.code) seenCodes.add(r.code);
    // id_conflict (rename_id collision; from/to per server schema)
    r = await tools.patchBlock(fixture, { op: "rename_id", from: "c1", to: "c2" });
    if (!r.ok && r.code) seenCodes.add(r.code);
    // unsupported_op via book manifest. Server returns isError; SDK throws.
    // The aggregator catches the throw and parses the code from the message
    // so the metric stays honest about what the server emitted.
    const yml = join(dir, "book.noma.yml");
    writeFileSync(yml, "title: t\nchapters: []\n");
    try {
      await tools.patchBlock(yml, { op: "delete_block", id: "x" });
    } catch (e) {
      const msg = (e as Error).message;
      if (/unsupported_op/.test(msg)) seenCodes.add("unsupported_op");
    }
    // invalid_content
    r = await tools.patchBlock(fixture, {
      op: "replace_block",
      id: "c1",
      content: "::claim{id=\"c1\"\nunterminated",
    });
    if (!r.ok && r.code) seenCodes.add(r.code);
    // id_attribute_protected
    r = await tools.patchBlock(fixture, {
      op: "update_attribute",
      id: "c1",
      key: "id",
      value: "c2",
    });
    if (!r.ok && r.code) seenCodes.add(r.code);
    // parent_missing
    r = await tools.patchBlock(fixture, {
      op: "add_block",
      parent: "no-such-parent",
      content: "::evidence{id=\"e9\"}\nbody\n::\n",
    });
    if (!r.ok && r.code) seenCodes.add(r.code);

    const descPath = join(dir, "desc-doc.noma");
    writeFileSync(descPath, `# H\n\n::claim{id="c1"}\nbody\n::\n`);
    writeFileSync(
      `${descPath}.capabilities.yml`,
      "nomaAgent:\n  version: 1\n  profile: r\n  ids:\n    rename: true\n  validation:\n    required: true\n  blocks:\n    claim:\n      ops: [update_attribute]\n      attrs:\n        confidence:\n          type: number\n          min: 0\n          max: 1\n        status:\n          type: string\n          enum: [open, closed]\n",
    );
    const descShape = new Set<string>();
    const desc = await wf.readCapabilities(descPath);
    assert.ok(desc);
    if (desc.profile) descShape.add("profile");
    if (desc.idsRename) descShape.add("ids.rename");
    if (desc.validationRequired) descShape.add("validation.required");
    for (const [, policy] of desc.blocks) {
      if (policy.ops.size > 0) descShape.add("blocks.ops");
      for (const [, c] of policy.attrs ?? new Map()) {
        if (c.type) descShape.add("attrs.type");
        if (c.min !== undefined) descShape.add("attrs.min");
        if (c.max !== undefined) descShape.add("attrs.max");
        if (c.enum) descShape.add("attrs.enum");
      }
    }

    // Re-run each conformance fixture inline so the metric reports an actual
    // pass count, not just the corpus size. Skips fixtures missing input/patch/
    // expected files (test/conformance.test.ts owns the strict assertion; this
    // is an honest tally for the v1.1 graduation note).
    const confRoot = resolve(REPO_ROOT, "examples/conformance/patch");
    const confDirs = existsSync(confRoot) ? readdirSync(confRoot) : [];
    let confPassed = 0;
    let confEligible = 0;
    for (const name of confDirs) {
      const fx = join(confRoot, name);
      if (
        !existsSync(join(fx, "patch.json")) ||
        !existsSync(join(fx, "expected.post.noma")) ||
        !existsSync(join(fx, "input.noma"))
      ) continue;
      confEligible++;
      const scratch2 = mkdtempSync(join(tmpdir(), `noma-grad-conf-${name}-`));
      const workFile = join(scratch2, "input.noma");
      copyFileSync(join(fx, "input.noma"), workFile);
      const raw = JSON.parse(readFileSync(join(fx, "patch.json"), "utf8")) as unknown;
      const ops: unknown[] = Array.isArray(raw)
        ? raw
        : (raw as { ops?: unknown[] }).ops ?? [raw];
      const results = await wf.applyOps(workFile, ops as never, { stopOnFirstError: true });
      const allOk = results.every((res) => res.ok);
      const got = readFileSync(workFile, "utf8");
      const want = readFileSync(join(fx, "expected.post.noma"), "utf8");
      if (allOk && got === want) confPassed++;
    }

    const report = {
      errorCodes: { observed: [...seenCodes].sort(), total: ALL_CODES.length },
      descriptorShape: { observed: [...descShape].sort() },
      conformance: { passed: confPassed, total: confEligible },
    };
    console.log("\n=== Annex graduation metrics ===\n" + JSON.stringify(report, null, 2));

    // Target: all 7 single-call-reachable codes from src/patch.ts. The
    // remaining 2 (pre_validation_blocked, op_list_aborted) come from
    // workflow-level paths and are observed in Phase 5 tests.
    assert.equal(
      seenCodes.size,
      ALL_CODES.length,
      `expected all ${ALL_CODES.length} single-call codes, got ${seenCodes.size}: ${[...seenCodes].sort().join(", ")}`,
    );
    assert.ok(descShape.has("blocks.ops"));
    assert.ok(descShape.has("attrs.type"));
    assert.ok(descShape.has("attrs.min"));
    assert.ok(descShape.has("attrs.max"));
    assert.ok(descShape.has("attrs.enum"));
    assert.ok(descShape.has("ids.rename"));
    assert.ok(descShape.has("validation.required"));
    // Honest graduation gate: at least 5 fixtures, ALL passing through the
    // SDK. The pass count is the real third graduation metric — corpus size
    // alone tells you nothing about whether the SDK handles those fixtures.
    assert.equal(confEligible >= 5, true, `conformance corpus too small: ${confEligible}`);
    assert.equal(
      confPassed,
      confEligible,
      `conformance not 100%: ${confPassed}/${confEligible} passed`,
    );
  } finally {
    await tools.close();
  }
});
