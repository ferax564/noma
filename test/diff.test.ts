import { test } from "node:test";
import assert from "node:assert/strict";
import { parse } from "../src/parser.js";
import { diffDocs } from "../src/diff.js";

const AT = "2026-05-12";

test("attribute change on one block emits a state_change", () => {
  const before = parse(`::claim{id="c1" confidence=0.6}\nx\n::\n`);
  const after = parse(`::claim{id="c1" confidence=0.9}\nx\n::\n`);
  const deltas = diffDocs(before, after, { at: AT });
  assert.equal(deltas.length, 1);
  const d = deltas[0]!;
  assert.equal(d.type, "directive");
  assert.equal(d.name, "state_change");
  assert.equal(d.attrs.block, "c1");
  assert.equal(d.attrs.attribute, "confidence");
  assert.equal(d.attrs.from, 0.6);
  assert.equal(d.attrs.to, 0.9);
  assert.equal(d.attrs.at, AT);
});

test("identical docs produce no deltas", () => {
  const src = `::claim{id="c1" confidence=0.6}\nx\n::\n`;
  assert.deepEqual(diffDocs(parse(src), parse(src), { at: AT }), []);
});

test("diffDocs without options.at throws", () => {
  const before = parse(`::claim{id="c1" confidence=0.6}\nx\n::\n`);
  const after = parse(`::claim{id="c1" confidence=0.9}\nx\n::\n`);
  assert.throws(() => diffDocs(before, after), /at/i);
});
