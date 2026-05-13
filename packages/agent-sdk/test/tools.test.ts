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
