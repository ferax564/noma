import { test } from "node:test";
import assert from "node:assert/strict";
import { parse } from "../src/parser.js";
import { renderDocx } from "../src/renderer-docx.js";

function storedZipEntries(buffer: Buffer): Map<string, string> {
  const entries = new Map<string, string>();
  let offset = 0;
  while (offset + 30 <= buffer.length && buffer.readUInt32LE(offset) === 0x04034b50) {
    const method = buffer.readUInt16LE(offset + 8);
    const size = buffer.readUInt32LE(offset + 18);
    const nameLen = buffer.readUInt16LE(offset + 26);
    const extraLen = buffer.readUInt16LE(offset + 28);
    const nameStart = offset + 30;
    const dataStart = nameStart + nameLen + extraLen;
    const dataEnd = dataStart + size;
    const name = buffer.subarray(nameStart, nameStart + nameLen).toString("utf8");
    assert.equal(method, 0, `expected stored ZIP entry for ${name}`);
    entries.set(name, buffer.subarray(dataStart, dataEnd).toString("utf8"));
    offset = dataEnd;
  }
  return entries;
}

test("renderDocx emits a WordprocessingML package with structure and links", () => {
  const doc = parse(`# Spec {id="spec"}\n\nSee **bold**, *em*, \`code\`, [site](https://example.com), and [[spec]].\n\n- first\n- second\n\n| A | B |\n| --- | --- |\n| x | y |\n\n::claim{id="c1" confidence=0.8}\nClaim body.\n::\n`);
  const docx = renderDocx(doc, { title: "Spec" });
  assert.equal(docx.subarray(0, 4).toString("binary"), "PK\u0003\u0004");

  const entries = storedZipEntries(docx);
  assert.ok(entries.has("[Content_Types].xml"));
  assert.ok(entries.has("word/document.xml"));
  assert.ok(entries.has("word/styles.xml"));
  assert.ok(entries.has("word/numbering.xml"));

  const documentXml = entries.get("word/document.xml") ?? "";
  assert.match(documentXml, /<w:pStyle w:val="Heading1"\/>/);
  assert.match(documentXml, /<w:bookmarkStart w:id="1" w:name="n_spec_/);
  assert.match(documentXml, /<w:b\/>/);
  assert.match(documentXml, /<w:i\/>/);
  assert.match(documentXml, /Courier New/);
  assert.match(documentXml, /<w:numId w:val="1"\/>/);
  assert.match(documentXml, /<w:tbl>/);
  assert.match(documentXml, /claim \(confidence=0\.8\)/);
  assert.match(documentXml, /w:anchor="n_spec_/);

  const rels = entries.get("word/_rels/document.xml.rels") ?? "";
  assert.match(rels, /Target="https:\/\/example\.com" TargetMode="External"/);
});
