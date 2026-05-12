import { test } from "node:test";
import assert from "node:assert/strict";
import { parse } from "../src/parser.js";
import { diffDocs } from "../src/diff.js";
import { renderNoma } from "../src/renderer-noma.js";
import { validate } from "../src/validator.js";

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

test("diffDocs with empty options.at throws", () => {
  const before = parse(`::claim{id="c1" confidence=0.6}\nx\n::\n`);
  const after = parse(`::claim{id="c1" confidence=0.9}\nx\n::\n`);
  assert.throws(() => diffDocs(before, after, { at: "" }), /at/i);
});

test("attribute appearing only on after-side is SKIPPED in v0.7", () => {
  const before = parse(`::claim{id="c1"}\nx\n::\n`);
  const after = parse(`::claim{id="c1" confidence=0.5}\nx\n::\n`);
  assert.deepEqual(diffDocs(before, after, { at: AT }), []);
});

test("attribute disappearing on after-side is SKIPPED in v0.7", () => {
  const before = parse(`::claim{id="c1" status="open"}\nx\n::\n`);
  const after = parse(`::claim{id="c1"}\nx\n::\n`);
  assert.deepEqual(diffDocs(before, after, { at: AT }), []);
});

test("multiple attrs on same block produce multiple state_changes", () => {
  const before = parse(`::risk{id="r1" severity="medium" owner="a"}\nx\n::\n`);
  const after = parse(`::risk{id="r1" severity="high" owner="b"}\nx\n::\n`);
  const deltas = diffDocs(before, after, { at: AT });
  assert.equal(deltas.length, 2);
  const attrs = deltas.map((d) => d.attrs.attribute).sort();
  assert.deepEqual(attrs, ["owner", "severity"]);
});

test("blocks present only in before or only in after are ignored", () => {
  const before = parse(`::claim{id="c1" confidence=0.5}\nx\n::\n::claim{id="c2"}\ny\n::\n`);
  const after = parse(`::claim{id="c1" confidence=0.5}\nx\n::\n::claim{id="c3"}\nz\n::\n`);
  assert.deepEqual(diffDocs(before, after, { at: AT }), []);
});

test("explicit reason attribute flows through", () => {
  const before = parse(`::claim{id="c1" confidence=0.5}\nx\n::\n`);
  const after = parse(`::claim{id="c1" confidence=0.9}\nx\n::\n`);
  const [d] = diffDocs(before, after, { reason: "Q1 refresh", at: AT });
  assert.equal(d!.attrs.reason, "Q1 refresh");
  assert.equal(d!.attrs.at, AT);
});

test("duplicate IDs in either snapshot throw", () => {
  const dup = parse(`::claim{id="c1"}\nx\n::\n::claim{id="c1"}\ny\n::\n`);
  const ok = parse(`::claim{id="c1"}\nx\n::\n`);
  assert.throws(() => diffDocs(dup, ok, { at: AT }), /duplicate id/);
  assert.throws(() => diffDocs(ok, dup, { at: AT }), /duplicate id/);
});

test("emitted state_change blocks pass the validator after parse-back", () => {
  // The strongest correctness check: render → parse → validate. If validator
  // emits state-change-missing-block or state-change-missing-from-to, the
  // diff output is invalid Noma and the round-trip would fail to ship.
  const before = parse(
    `::claim{id="c1" confidence=0.6}\nx\n::\n::evidence{for="c1"}\ny\n::\n`,
  );
  const after = parse(
    `::claim{id="c1" confidence=0.9}\nx\n::\n::evidence{for="c1"}\ny\n::\n`,
  );
  const deltas = diffDocs(before, after, { at: AT });
  const wrappedSource =
    renderNoma(before) +
    "\n" +
    deltas.map((d) => renderNoma({ type: "document", meta: {}, children: [d] })).join("\n");
  const reparsed = parse(wrappedSource);
  const diagnostics = validate(reparsed);
  const stateChangeDiags = diagnostics.filter((d) =>
    d.code.startsWith("state-change") || (d.code === "broken-reference" && d.message.includes("c1")),
  );
  assert.deepEqual(
    stateChangeDiags,
    [],
    `state_change diags must be empty; got: ${JSON.stringify(stateChangeDiags, null, 2)}`,
  );
});
