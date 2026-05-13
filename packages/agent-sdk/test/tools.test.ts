import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { NomaTools } from "../src/tools.js";
import { NomaSystemError } from "../src/errors.js";

let tools: NomaTools;

before(async () => {
  tools = await NomaTools.spawn();
});

after(async () => {
  await tools.close();
});

function scratchDoc(content: string, name = "doc.noma"): string {
  const dir = mkdtempSync(join(tmpdir(), "noma-tools-"));
  const path = join(dir, name);
  writeFileSync(path, content, "utf8");
  return path;
}

test("NomaTools.spawn yields a usable client; close shuts it down", async () => {
  assert.ok(tools);
});

test("readDoc returns block summaries with patchable flag", async () => {
  const path = scratchDoc(
    `# Hello\n\nA paragraph.\n\n::claim{id="c1" confidence=0.7}\nClaim body.\n::\n`,
  );
  const { blocks } = await tools.readDoc(path);
  assert.ok(blocks.length >= 2, `expected >=2 blocks, got ${blocks.length}`);
  const claim = blocks.find((b) => b.name === "claim");
  assert.ok(claim, "claim block must surface");
  assert.equal(claim.id, "c1");
  assert.equal(claim.patchable, true);
});

test("readDoc throws NomaSystemError on book manifest path", async () => {
  const yml = scratchDoc("title: T\nchapters:\n  - x.noma\n", "book.noma.yml");
  await assert.rejects(() => tools.readDoc(yml), NomaSystemError);
});

test("readDoc throws NomaSystemError on missing file", async () => {
  await assert.rejects(() => tools.readDoc("/no/such/file.noma"), NomaSystemError);
});

test("listIds returns canonical ids + aliases", async () => {
  const path = scratchDoc(
    `# Top {aliases="root"}\n\n::claim{id="c1"}\nbody\n::\n\n::evidence{id="e1" for="c1"}\nbody\n::\n`,
  );
  const { ids, aliases } = await tools.listIds(path);
  assert.ok(ids.includes("c1"));
  assert.ok(ids.includes("e1"));
  assert.equal(aliases["root"], "top");
});

test("validateDoc returns ok=true for a clean doc and ok=false for one with errors", async () => {
  const clean = scratchDoc(`# H\n\n::claim{id="c1" noverify}\nbody\n::\n`);
  const goodRes = await tools.validateDoc(clean);
  assert.equal(goodRes.ok, true);

  const dup = scratchDoc(
    `# H\n\n::claim{id="x"}\nA\n::\n\n::claim{id="x"}\nB\n::\n`,
  );
  const badRes = await tools.validateDoc(dup);
  assert.equal(badRes.ok, false);
  assert.ok(badRes.diagnostics.some((d) => d.severity === "error"));
});

test("patchBlock applies update_attribute and writes a transcript record", async () => {
  const path = scratchDoc(
    `# H\n\n::claim{id="c1" confidence=0.5}\nbody\n::\n`,
  );
  const res = await tools.patchBlock(path, {
    op: "update_attribute",
    id: "c1",
    key: "confidence",
    value: 0.9,
  });
  assert.equal(res.ok, true);
  if (res.ok) {
    assert.equal(res.transcriptEntry.op.op, "update_attribute");
    assert.equal(res.transcriptEntry.patch_result, "applied");
  }
  const content = readFileSync(path, "utf8");
  assert.ok(content.includes("confidence=0.9"));
  assert.ok(existsSync(`${path}.patches`));
});

test("patchBlock returns target_missing for a non-existent id", async () => {
  const path = scratchDoc(`# H\n\n::claim{id="c1"}\nbody\n::\n`);
  const res = await tools.patchBlock(path, {
    op: "delete_block",
    id: "does-not-exist",
  });
  assert.equal(res.ok, false);
  if (!res.ok) assert.equal(res.code, "target_missing");
});

test("patchBlock throws NomaSystemError on book manifest path", async () => {
  // The server marks book-manifest rejection as `system: true` in
  // packages/mcp-server/src/tools/patch-block.ts:58 — MCP surfaces that
  // as `isError: true`, and our SDK throws NomaSystemError. The `body.code`
  // is still "unsupported_op" but it lives in the error message string, not
  // in a returned body.
  const yml = scratchDoc("title: T\nchapters:\n  - x.noma\n", "book.noma.yml");
  await assert.rejects(
    () => tools.patchBlock(yml, { op: "delete_block", id: "x" }),
    (e: unknown) => e instanceof NomaSystemError && /unsupported_op/.test((e as Error).message),
  );
});

test("patchBlock returns sha_mismatch when expectedSha disagrees with file", async () => {
  const path = scratchDoc(`# H\n\n::claim{id="c1"}\nbody\n::\n`);
  const res = await tools.patchBlock(
    path,
    { op: "update_attribute", id: "c1", key: "confidence", value: 0.5 },
    { expectedSha: "deadbeef" },
  );
  assert.equal(res.ok, false);
  if (!res.ok) assert.equal(res.code, "sha_mismatch");
});

test("patchBlock returns id_conflict on rename_id collision", async () => {
  // Server uses `from` and `to` (NOT id/new_id) — see packages/mcp-server/src/index.ts:16.
  const path = scratchDoc(
    `# H\n\n::claim{id="c1"}\na\n::\n\n::claim{id="c2"}\nb\n::\n`,
  );
  const res = await tools.patchBlock(path, {
    op: "rename_id",
    from: "c1",
    to: "c2",
  });
  assert.equal(res.ok, false);
  if (!res.ok) assert.equal(res.code, "id_conflict");
});

test("patchBlock returns invalid_content when replace_block body is unparseable", async () => {
  const path = scratchDoc(`# H\n\n::claim{id="c1"}\nbody\n::\n`);
  const res = await tools.patchBlock(path, {
    op: "replace_block",
    id: "c1",
    content: "::claim{id=\"c1\"\nunterminated attribute string",
  });
  assert.equal(res.ok, false);
  if (!res.ok) assert.equal(res.code, "invalid_content");
});

test("patchBlock returns id_attribute_protected on update_attribute with reserved id key", async () => {
  // src/patch.ts protects `id` from `update_attribute` — rename_id is the only path.
  const path = scratchDoc(`# H\n\n::claim{id="c1"}\nbody\n::\n`);
  const res = await tools.patchBlock(path, {
    op: "update_attribute",
    id: "c1",
    key: "id",
    value: "c2",
  });
  assert.equal(res.ok, false);
  if (!res.ok) assert.equal(res.code, "id_attribute_protected");
});

test("patchBlock returns parent_missing when add_block parent id does not exist", async () => {
  // add_block requires a parent id that exists in the document.
  const path = scratchDoc(`# H\n\n::claim{id="c1"}\nbody\n::\n`);
  const res = await tools.patchBlock(path, {
    op: "add_block",
    parent: "no-such-parent",
    content: "::evidence{id=\"e1\" for=\"c1\"}\nbody\n::\n",
  });
  assert.equal(res.ok, false);
  if (!res.ok) assert.equal(res.code, "parent_missing");
});
