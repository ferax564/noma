import { test } from "node:test";
import assert from "node:assert/strict";
import { parse } from "../src/parser.js";
import { validate } from "../src/validator.js";
import { patchSource, type PatchOp } from "../src/patch.js";

const typoDoc = `# Doc

::claim{id="asml-euv-moat" confidence=0.8}
the claim
::

::evidence{id="ev1" for="asml-euv-mot"}
typo'd reference
::
`;

test("broken attr reference with a near-miss id carries a fix patch op", () => {
  const diagnostics = validate(parse(typoDoc)).filter((d) => d.code === "broken-reference");
  assert.equal(diagnostics.length, 1);
  const d = diagnostics[0]!;
  assert.match(d.message, /Did you mean "asml-euv-moat"\?/);
  assert.equal(d.nodeId, "ev1");
  assert.ok(d.pos);
  assert.deepEqual(d.fix, {
    op: "update_attribute",
    id: "ev1",
    key: "for",
    value: "asml-euv-moat",
  });
});

test("the fix op applies cleanly through patchSource", () => {
  const diagnostics = validate(parse(typoDoc));
  const fixes = diagnostics.filter((d) => d.fix).map((d) => d.fix as unknown as PatchOp);
  const fixed = patchSource(typoDoc, fixes);
  assert.match(fixed, /for="asml-euv-moat"/);
  const after = validate(parse(fixed));
  assert.ok(!after.some((d) => d.code === "broken-reference"));
});

test("no fix is offered when no id is close enough", () => {
  const doc = parse(`# D

::claim{id="alpha" confidence=0.5}
c
::

::evidence{id="ev1" for="completely-unrelated"}
e
::
`);
  const d = validate(doc).find((diag) => diag.code === "broken-reference");
  assert.ok(d);
  assert.equal(d.fix, undefined);
  assert.doesNotMatch(d.message, /Did you mean/);
});

test("ambiguous near-misses (ties) do not produce a fix", () => {
  const doc = parse(`# D

::claim{id="claim-a" confidence=0.5}
a
::

::claim{id="claim-b" confidence=0.5}
b
::

::evidence{id="ev1" for="claim-x"}
e
::
`);
  const d = validate(doc).find((diag) => diag.code === "broken-reference");
  assert.ok(d);
  assert.equal(d.fix, undefined);
});

test("broken wikilink references carry position but no fix op", () => {
  const doc = parse(`# D

::claim{id="real-target" confidence=0.5}
c
::

See [[real-targe]] for details.
`);
  const d = validate(doc).find((diag) => diag.code === "broken-reference");
  assert.ok(d);
  assert.ok(d.pos);
  assert.match(d.message, /Did you mean "real-target"\?/);
  assert.equal(d.fix, undefined);
});

test("each referencing site gets its own broken-reference diagnostic", () => {
  const doc = parse(`# D

::evidence{id="ev1" for="ghost"}
a
::

::evidence{id="ev2" for="ghost"}
b
::
`);
  const broken = validate(doc).filter((d) => d.code === "broken-reference");
  assert.equal(broken.length, 2);
  assert.deepEqual(broken.map((d) => d.nodeId).sort(), ["ev1", "ev2"]);
});
