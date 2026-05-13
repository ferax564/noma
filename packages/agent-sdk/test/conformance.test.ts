import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, copyFileSync, mkdtempSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { NomaTools } from "../src/tools.js";
import { NomaWorkflow } from "../src/workflow.js";
import type { PatchOp } from "../src/types.js";

// Resolve relative to repo root, not process.cwd() — workspace tests
// run with cwd=packages/agent-sdk/.
const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, "../../..");
const ROOT = resolve(REPO_ROOT, "examples/conformance/patch");

let tools: NomaTools;

before(async () => {
  tools = await NomaTools.spawn();
});

after(async () => {
  await tools.close();
});

const fixtures = readdirSync(ROOT).filter((f) => {
  const dir = join(ROOT, f);
  return (
    existsSync(join(dir, "patch.json")) &&
    existsSync(join(dir, "expected.post.noma")) &&
    existsSync(join(dir, "input.noma"))
  );
});

for (const name of fixtures) {
  test(`conformance: ${name} produces expected.post.noma`, async () => {
    const fixtureDir = join(ROOT, name);
    // The conformance corpus uses the exact filename `input.noma` for the
    // input document. Glob-style "first .noma that isn't expected.post.noma"
    // would silently pick up future sibling .noma files (e.g., a `notes.noma`
    // someone drops in). Require the exact name so missing inputs fail loudly.
    const inputName = "input.noma";
    assert.ok(
      existsSync(join(fixtureDir, inputName)),
      `fixture ${name} missing ${inputName}`,
    );

    const scratch = mkdtempSync(join(tmpdir(), `noma-conf-${name}-`));
    const workFile = join(scratch, inputName);
    copyFileSync(join(fixtureDir, inputName), workFile);

    const patch = JSON.parse(readFileSync(join(fixtureDir, "patch.json"), "utf8")) as
      | { ops: PatchOp[] }
      | PatchOp[]
      | PatchOp;

    const wf = new NomaWorkflow(tools);
    const ops: PatchOp[] = Array.isArray(patch)
      ? patch
      : "ops" in (patch as { ops?: PatchOp[] })
        ? (patch as { ops: PatchOp[] }).ops
        : [patch as PatchOp];

    const results = await wf.applyOps(workFile, ops, { stopOnFirstError: true });
    const failures = results.filter((r) => !r.ok);
    assert.equal(failures.length, 0, `fixture ${name}: applyOps failures ${JSON.stringify(failures)}`);

    const got = readFileSync(workFile, "utf8");
    const want = readFileSync(join(fixtureDir, "expected.post.noma"), "utf8");
    assert.equal(got, want, `fixture ${name}: post-patch document mismatch`);
  });
}
