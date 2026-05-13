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
