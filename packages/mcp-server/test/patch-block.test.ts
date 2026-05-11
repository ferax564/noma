import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, readFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { patchBlock } from "../src/tools/patch-block.js";
import { sha256hex } from "../src/sha.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "noma-patch-block-"));
});

function writeNoma(name: string, content: string): string {
  const p = join(dir, name);
  writeFileSync(p, content, "utf8");
  return p;
}

const DOC = `---
title: Test
---

# Intro {id="intro"}

Some paragraph text here.

::claim{id="c1" confidence=0.7}
This is a claim.
::
`;

describe("patchBlock — update_attribute", () => {
  it("applies op and returns ok:true", () => {
    const file = writeNoma("doc.noma", DOC);
    const result = patchBlock({
      file,
      op: { op: "update_attribute", id: "c1", key: "confidence", value: 0.95 },
      reason: "Q1 beat",
    });
    assert.equal(result.ok, true);
    const updated = readFileSync(file, "utf8");
    assert.ok(updated.includes("confidence=0.95"), `expected confidence=0.95 in:\n${updated}`);
  });

  it("preserves bytes outside the patched block", () => {
    const file = writeNoma("doc2.noma", DOC);
    patchBlock({ file, op: { op: "update_attribute", id: "c1", key: "confidence", value: 0.9 }, reason: "" });
    const updated = readFileSync(file, "utf8");
    assert.ok(updated.includes("Some paragraph text here."), "unpatched paragraph should be byte-identical");
    assert.ok(updated.includes("---\ntitle: Test\n---"), "frontmatter should be byte-identical");
  });

  it("appends to .noma.patches transcript", () => {
    const file = writeNoma("doc3.noma", DOC);
    patchBlock({ file, op: { op: "update_attribute", id: "c1", key: "confidence", value: 0.8 }, reason: "test" });
    const transcriptPath = file + ".patches";
    const raw = readFileSync(transcriptPath, "utf8");
    const entry = JSON.parse(raw.trim());
    assert.equal(entry.v, 1);
    assert.equal(entry.reason, "test");
    assert.ok(entry.pre_sha, "pre_sha must be set");
    assert.ok(entry.post_sha, "post_sha must be set");
    assert.notEqual(entry.pre_sha, entry.post_sha);
  });
});

describe("patchBlock — concurrency guard", () => {
  it("returns ok:false on expected_sha mismatch", () => {
    const file = writeNoma("doc4.noma", DOC);
    const result = patchBlock({
      file,
      op: { op: "update_attribute", id: "c1", key: "confidence", value: 0.9 },
      reason: "",
      expected_sha: "00000000",
    });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error, "precondition_failed");
    }
  });

  it("succeeds when expected_sha matches actual", () => {
    const file = writeNoma("doc5.noma", DOC);
    const bytes = readFileSync(file);
    const sha = sha256hex(bytes).slice(0, 8);
    const result = patchBlock({
      file,
      op: { op: "update_attribute", id: "c1", key: "confidence", value: 0.85 },
      reason: "",
      expected_sha: sha,
    });
    assert.equal(result.ok, true);
  });
});

describe("patchBlock — error cases", () => {
  it("returns ok:false for unknown block ID", () => {
    const file = writeNoma("doc6.noma", DOC);
    const result = patchBlock({ file, op: { op: "delete_block", id: "no-such-id" }, reason: "" });
    assert.equal(result.ok, false);
  });

  it("returns ok:false for book manifest", () => {
    const file = writeNoma("book.noma.yml", "chapters: []");
    const result = patchBlock({ file, op: { op: "delete_block", id: "x" }, reason: "" });
    assert.equal(result.ok, false);
  });

  it("returns ok:false for content over 1MB", () => {
    const file = writeNoma("doc7.noma", DOC);
    const result = patchBlock({
      file,
      op: { op: "replace_block", id: "c1", content: "x".repeat(1_100_000) },
      reason: "",
    });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error, "content_too_large");
  });
});
