import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readDoc } from "../src/tools/read-doc.js";

const dir = mkdtempSync(join(tmpdir(), "noma-read-doc-"));

function writeNoma(name: string, content: string): string {
  const p = join(dir, name);
  writeFileSync(p, content, "utf8");
  return p;
}

describe("readDoc", () => {
  it("returns blocks with type and patchable flag", () => {
    const file = writeNoma("a.noma", `# My Doc\n\nHello world.\n`);
    const blocks = readDoc(file);
    assert.ok(blocks.length >= 1);
    const section = blocks.find(b => b.type === "section");
    assert.ok(section, "expected a section block");
    assert.equal(section!.patchable, true);
    assert.ok(section!.id, "section should have an id");
  });

  it("marks paragraphs without explicit id as not patchable", () => {
    const file = writeNoma("b.noma", `# Doc\n\nSome text here.\n`);
    const blocks = readDoc(file);
    const para = blocks.find(b => b.type === "paragraph");
    assert.ok(para, "expected a paragraph");
    assert.equal(para!.patchable, false);
  });

  it("returns directive attrs only for directives", () => {
    const file = writeNoma("c.noma", `::claim{id="c1" confidence=0.8}\nSome claim.\n::\n`);
    const blocks = readDoc(file);
    const dir = blocks.find(b => b.type === "directive");
    assert.ok(dir, "expected a directive");
    assert.deepEqual(dir!.attrs, { confidence: 0.8 });
  });

  it("throws on book manifest path", () => {
    const file = writeNoma("book.noma.yml", "chapters: []");
    assert.throws(() => readDoc(file), /book manifests/);
  });

  it("throws on missing file", () => {
    assert.throws(() => readDoc("/nonexistent/path/x.noma"), /ENOENT/);
  });
});
