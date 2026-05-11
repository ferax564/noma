import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { listIds } from "../src/tools/list-ids.js";

const dir = mkdtempSync(join(tmpdir(), "noma-list-ids-"));

function writeNoma(name: string, content: string): string {
  const p = join(dir, name);
  writeFileSync(p, content, "utf8");
  return p;
}

describe("listIds", () => {
  it("returns canonical IDs in document order", () => {
    const file = writeNoma("a.noma", `# Section One\n\n## Section Two\n`);
    const { ids } = listIds(file);
    assert.ok(ids.includes("section-one"), `got: ${ids}`);
    assert.ok(ids.includes("section-two"), `got: ${ids}`);
    assert.ok(ids.indexOf("section-one") < ids.indexOf("section-two"));
  });

  it("returns alias map", () => {
    const file = writeNoma("b.noma", `# My Doc {id="doc-root" aliases="root,home"}\n`);
    const { aliases } = listIds(file);
    assert.equal(aliases["root"], "doc-root");
    assert.equal(aliases["home"], "doc-root");
  });

  it("returns empty for doc with no IDs", () => {
    const file = writeNoma("c.noma", `Plain paragraph text.\n`);
    const { ids, aliases } = listIds(file);
    assert.equal(ids.length, 0);
    assert.deepEqual(aliases, {});
  });

  it("rejects book manifests", () => {
    const file = writeNoma("book.noma.yml", "chapters: []");
    assert.throws(() => listIds(file), /book manifests/);
  });
});
