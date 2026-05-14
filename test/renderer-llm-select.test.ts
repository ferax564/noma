import { test } from "node:test";
import assert from "node:assert/strict";
import { parse } from "../src/parser.js";
import { renderLlm } from "../src/renderer-llm.js";

const src = `# Spec

Intro paragraph.

::claim{id="c1" confidence=0.8}
Claim body.
::

::evidence{id="e1" for="c1"}
Evidence body.
::

::dataset{id="ds1"}
rows:
  - [1]
::

::risk{id="r1" severity="high" owner="me"}
Risk body.
::
`;

test("renderLlm select includes matching directives and ancestor sections", () => {
  const llm = renderLlm(parse(src), { select: ["claim,evidence"] });
  assert.match(llm, /# Spec/);
  assert.match(llm, /\[CLAIM/);
  assert.match(llm, /\[EVIDENCE/);
  assert.doesNotMatch(llm, /\[RISK/);
  assert.doesNotMatch(llm, /\[DATASET/);
  assert.doesNotMatch(llm, /Intro paragraph/);
});

test("renderLlm exclude prunes matching directives", () => {
  const llm = renderLlm(parse(src), { exclude: ["dataset", "risk"] });
  assert.match(llm, /\[CLAIM/);
  assert.match(llm, /\[EVIDENCE/);
  assert.doesNotMatch(llm, /\[RISK/);
  assert.doesNotMatch(llm, /\[DATASET/);
});

test("renderLlm budget trims at a bounded size", () => {
  const llm = renderLlm(parse(src), { budget: 120 });
  assert.ok(llm.length <= 120);
  assert.match(llm, /truncated at 120 characters/);
});
