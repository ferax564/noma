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

test("renderLlm emits computed formulas with default results", () => {
  const llm = renderLlm(parse(`::control{id="growth-rate" type="slider" min=0 max=20 default=8}
Growth rate
::

::control{id="base-revenue" type="number" default=120}
Base revenue
::

::control{id="include-risk" type="toggle" default=true}
Include risk
::

::computed_metric{id="year-5-revenue" formula="base-revenue * pow(1 + growth-rate / 100, 5)"}
::

::computed_metric{id="risk-enabled-revenue" formula="include-risk * base-revenue"}
::

::computed_metric{id="year-6-revenue" formula="year-5-revenue * (1 + growth-rate / 100)"}
::

::computed_plot{id="projection" formula="base-revenue * pow(1 + growth-rate / 100, year)" domain="year:0..3"}
::
`));

  assert.match(llm, /\[COMPUTED_METRIC id="year-5-revenue"/);
  assert.match(llm, /formula: base-revenue \* pow\(1 \+ growth-rate \/ 100, 5\)/);
  assert.match(llm, /default: 176\.319/);
  assert.match(llm, /\[COMPUTED_METRIC id="risk-enabled-revenue"/);
  assert.match(llm, /formula: include-risk \* base-revenue/);
  assert.match(llm, /default: 120/);
  assert.match(llm, /\[COMPUTED_METRIC id="year-6-revenue"/);
  assert.match(llm, /default: 190\.424/);
  assert.match(llm, /\[COMPUTED_PLOT id="projection"/);
  assert.match(llm, /default_series \(year\): 120, 129\.6, 139\.968, 151\.16544/);
});
