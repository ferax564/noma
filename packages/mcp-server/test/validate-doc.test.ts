import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { validateDoc } from "../src/tools/validate-doc.js";

const dir = mkdtempSync(join(tmpdir(), "noma-validate-"));

function writeNoma(name: string, content: string): string {
  const p = join(dir, name);
  writeFileSync(p, content, "utf8");
  return p;
}

describe("validateDoc", () => {
  it("returns ok:true for a clean doc", () => {
    const file = writeNoma("clean.noma", `# Clean Doc\n\nSome text.\n`);
    const result = validateDoc(file);
    assert.equal(result.ok, true);
  });

  it("returns ok:false and diagnostics for a broken reference", () => {
    const file = writeNoma("broken.noma", [
      `::evidence{id="e1" for="claim-missing"}`,
      `Some evidence.`,
      `::`,
    ].join("\n") + "\n");
    const result = validateDoc(file);
    assert.equal(result.ok, false);
    assert.ok(result.diagnostics.length > 0);
    assert.ok(result.diagnostics.some(d => d.severity === "error"));
  });

  it("rejects book manifests", () => {
    const file = writeNoma("book.noma.yml", "chapters: []");
    assert.throws(() => validateDoc(file), /book manifests/);
  });
});
