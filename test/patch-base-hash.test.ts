import { test } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { parse } from "../src/parser.js";
import { blockSourceHash, patch, patchSource, PatchError } from "../src/patch.js";
import { sha256Hex } from "../src/hash.js";

const sample = `# T

::claim{id="c1" confidence=0.5}
old body
::

::claim{id="c2" confidence=0.8}
other claim
::
`;

test("sha256Hex matches node:crypto", () => {
  for (const input of ["", "abc", "::claim{id=\"x\"}\nbody\n::", "é🎉"]) {
    assert.equal(sha256Hex(input), createHash("sha256").update(input, "utf8").digest("hex"));
  }
});

test("blockSourceHash hashes the block's exact source slice", () => {
  const hash = blockSourceHash(sample, "c1");
  assert.equal(hash, sha256Hex('::claim{id="c1" confidence=0.5}\nold body\n::'));
});

test("blockSourceHash throws for unknown ids", () => {
  assert.throws(() => blockSourceHash(sample, "nope"), /not found/);
});

test("patchSource applies when baseHash matches", () => {
  const baseHash = blockSourceHash(sample, "c1");
  const out = patchSource(sample, {
    op: "update_attribute",
    id: "c1",
    key: "confidence",
    value: 0.9,
    baseHash,
  });
  assert.match(out, /confidence=0\.9/);
});

test("patchSource accepts a >=8-char baseHash prefix", () => {
  const prefix = blockSourceHash(sample, "c1").slice(0, 12);
  const out = patchSource(sample, {
    op: "replace_body",
    id: "c1",
    content: "new body",
    baseHash: prefix,
  });
  assert.match(out, /new body/);
});

test("patchSource rejects a stale baseHash with sha_mismatch", () => {
  const baseHash = blockSourceHash(sample, "c1");
  const drifted = patchSource(sample, {
    op: "replace_body",
    id: "c1",
    content: "edited by someone else",
  });
  try {
    patchSource(drifted, { op: "replace_body", id: "c1", content: "mine", baseHash });
    assert.fail("expected PatchError");
  } catch (e) {
    assert.ok(e instanceof PatchError);
    assert.equal(e.code, "sha_mismatch");
  }
});

test("patchSource baseHash is per-block: edits to other blocks do not conflict", () => {
  const baseHash = blockSourceHash(sample, "c1");
  const drifted = patchSource(sample, {
    op: "replace_body",
    id: "c2",
    content: "someone edited the other claim",
  });
  const out = patchSource(drifted, {
    op: "replace_body",
    id: "c1",
    content: "mine",
    baseHash,
  });
  assert.match(out, /mine/);
  assert.match(out, /someone edited the other claim/);
});

test("patchSource rejects malformed baseHash values", () => {
  try {
    patchSource(sample, { op: "delete_block", id: "c1", baseHash: "xyz" });
    assert.fail("expected PatchError");
  } catch (e) {
    assert.ok(e instanceof PatchError);
    assert.equal(e.code, "invalid_content");
  }
});

test("baseHash targets rename_id's from block", () => {
  const baseHash = blockSourceHash(sample, "c1");
  const out = patchSource(sample, { op: "rename_id", from: "c1", to: "c1-new", baseHash });
  assert.match(out, /id="c1-new"/);
});

test("AST patch() refuses baseHash preconditions", () => {
  const doc = parse(sample);
  try {
    patch(doc, { op: "delete_block", id: "c1", baseHash: blockSourceHash(sample, "c1") });
    assert.fail("expected PatchError");
  } catch (e) {
    assert.ok(e instanceof PatchError);
    assert.equal(e.code, "unsupported_op");
  }
});

test("patch() preserves non-JSON metadata via structuredClone", () => {
  const doc = parse(sample);
  doc.meta.updated = new Date("2026-01-02T03:04:05Z");
  const next = patch(doc, { op: "replace_body", id: "c1", content: "fresh" });
  assert.ok(next.meta.updated instanceof Date);
});
