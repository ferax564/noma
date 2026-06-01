import { test } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parse } from "../src/parser.js";
import { validate } from "../src/validator.js";

test("claim-without-evidence is on by default", () => {
  const doc = parse(`::claim{id="lonely"}\nx\n::\n`);
  const diags = validate(doc);
  assert.ok(diags.some((d) => d.code === "claim-without-evidence"));
});

test("noverify suppresses claim-without-evidence", () => {
  const doc = parse(`::claim{id="lonely" noverify}\nx\n::\n`);
  const diags = validate(doc);
  assert.ok(!diags.some((d) => d.code === "claim-without-evidence"));
});

test("risk without owner emits warning", () => {
  const doc = parse(`::risk{id="r1" severity="high"}\nx\n::\n`);
  const diags = validate(doc);
  assert.ok(diags.some((d) => d.code === "risk-without-owner"));
});

test("risk with owner is clean", () => {
  const doc = parse(`::risk{id="r1" severity="high" owner="me"}\nx\n::\n`);
  const diags = validate(doc);
  assert.ok(!diags.some((d) => d.code === "risk-without-owner"));
});

test("decision/adr without status emits warning", () => {
  const docDecision = parse(`::decision{id="d1"}\nx\n::\n`);
  const docAdr = parse(`::adr{id="a1"}\nx\n::\n`);
  assert.ok(
    validate(docDecision).some((d) => d.code === "decision-without-status"),
  );
  assert.ok(validate(docAdr).some((d) => d.code === "decision-without-status"));
});

test("agent_task without scope or body emits warning", () => {
  const doc = parse(`::agent_task{id="t1"}\n::\n`);
  const diags = validate(doc);
  assert.ok(diags.some((d) => d.code === "agent-task-without-scope"));
});

test("agent_task with body is clean", () => {
  const doc = parse(`::agent_task{id="t1"}\nDo the thing.\n::\n`);
  const diags = validate(doc);
  assert.ok(!diags.some((d) => d.code === "agent-task-without-scope"));
});

test("figure missing alt and caption emits warning", () => {
  const doc = parse(`::figure{id="fig1" src="chart.png"}\n::\n`);
  const diags = validate(doc);
  assert.ok(diags.some((d) => d.code === "figure-missing-alt"));
});

test("figure alt or noverify suppresses missing-alt warning", () => {
  const withAlt = validate(parse(`::figure{id="fig1" src="chart.png" alt="Revenue chart"}\n::\n`));
  const suppressed = validate(parse(`::figure{id="fig2" src="chart.png" noverify}\n::\n`));
  assert.ok(!withAlt.some((d) => d.code === "figure-missing-alt"));
  assert.ok(!suppressed.some((d) => d.code === "figure-missing-alt"));
});

test("control validates numeric defaults", () => {
  const doc = parse(`::control{id="growth-rate" type="slider" min=0 max=20}
Growth rate
::

::control{id="discount-rate" type="number" min=0 max=10 default=12}
Discount rate
::

::control{id="include-risk" type="toggle" default=true}
Include risk
::
`);
  const diags = validate(doc);
  assert.ok(diags.some((d) => d.code === "control-missing-default"));
  assert.ok(diags.some((d) => d.code === "control-out-of-range-default"));
  assert.ok(!diags.some((d) => d.nodeId === "include-risk"));
});

test("text and date controls do not require numeric defaults", () => {
  const doc = parse(`::control{id="review-title" type="text" default="Committee memo"}
::

::control{id="review-date" type="date" default="2026-05-24"}
::

::control{id="review-owner" type="select" default="legal" options="legal=Legal,finance=Finance"}
::
`);
  const diags = validate(doc);
  assert.ok(!diags.some((d) => d.code === "control-missing-default"));
  assert.ok(!diags.some((d) => d.code === "control-out-of-range-default"));
});

test("control lock values are validated", () => {
  const valid = validate(parse(`::control{id="title" type="text" lock="control"}
::

::control{id="date" type="date" lock="content"}
::

::control{id="approved" type="toggle" default=false lock="all"}
::
`));
  assert.ok(!valid.some((d) => d.code === "control-invalid-lock"), JSON.stringify(valid));

  const invalid = validate(parse(`::control{id="bad-lock" type="text" lock="frozen"}
::
`));
  assert.ok(invalid.some((d) => d.code === "control-invalid-lock"));
});

test("computed directives validate formulas and dependencies", () => {
  const doc = parse(`::control{id="growth-rate" type="slider" min=0 max=20 default=8}
Growth rate
::

::control{id="base-revenue" type="number" default=120}
Base revenue
::

::computed_metric{id="year-5-revenue" formula="base-revenue * pow(1 + growth-rate / 100, 5)"}
::

::computed_plot{id="projection" formula="base-revenue * pow(1 + growth-rate / 100, year)" domain="year:0..10"}
::
`);
  const diags = validate(doc);
  assert.ok(!diags.some((d) => d.code === "computed-missing-formula"));
  assert.ok(!diags.some((d) => d.code === "computed-unknown-dependency"));
  assert.ok(!diags.some((d) => d.code === "formula-parse-error"));
});

test("computed directives accept body formula and domain lines", () => {
  const doc = parse(`::control{id="growth-rate" default=8}
::

::control{id="base-revenue" default=120}
::

::computed_plot{id="projection"}
formula: base-revenue * pow(1 + growth-rate / 100, year)
domain: year:0..3
::
`);
  const diags = validate(doc);
  assert.ok(!diags.some((d) => d.code === "computed-unknown-dependency"), JSON.stringify(diags));
  assert.ok(!diags.some((d) => d.code === "computed-missing-formula"), JSON.stringify(diags));
});

test("computed directives warn on missing and invalid formulas", () => {
  const doc = parse(`::control{id="x" default=1}
::

::computed_metric{id="missing"}
::

::computed_metric{id="bad" formula="x + * 2"}
::

::computed_metric{id="unknown" formula="x + y"}
::
`);
  const diags = validate(doc);
  assert.ok(diags.some((d) => d.code === "computed-missing-formula"));
  assert.ok(diags.some((d) => d.code === "formula-parse-error"));
  assert.ok(diags.some((d) => d.code === "computed-unknown-dependency"));
});

test("computed directives warn on deep computed chains", () => {
  const doc = parse(`::control{id="x" default=1}
::

::computed_metric{id="a" formula="x + 1"}
::

::computed_metric{id="b" formula="a + 1"}
::

::computed_metric{id="c" formula="b + 1"}
::
`);
  const diags = validate(doc);
  assert.ok(diags.some((d) => d.code === "computed-chain-too-deep"));
});

test("state_change without block warns", () => {
  const doc = parse(`::state_change{from=0.6 to=0.9}\n::\n`);
  const diags = validate(doc);
  assert.ok(diags.some((d) => d.code === "state-change-missing-block"));
});

test("state_change without from/to warns", () => {
  const doc = parse(`::state_change{block="x" attribute="confidence"}\n::\n`);
  const diags = validate(doc);
  assert.ok(diags.some((d) => d.code === "state-change-missing-from-to"));
});

test("state_change targets unknown block as broken-reference", () => {
  const doc = parse(
    `::state_change{block="missing" attribute="status" from="open" to="resolved"}\n::\n`,
  );
  const diags = validate(doc);
  assert.ok(diags.some((d) => d.code === "broken-reference"));
});

test("state_change targeting an existing block is clean", () => {
  const doc = parse(
    `::claim{id="c1"}\nx\n::\n::evidence{for="c1"}\ny\n::\n::state_change{block="c1" attribute="confidence" from=0.6 to=0.9}\n::\n`,
  );
  const diags = validate(doc);
  assert.ok(!diags.some((d) => d.code === "state-change-missing-block"));
  assert.ok(!diags.some((d) => d.code === "broken-reference"));
});

test("change_request validates tracked revision shape and target", () => {
  const doc = parse(
    `::claim{id="c1"}\nx\n::\n::evidence{for="c1"}\ny\n::\n::change_request{id="cr1" target="c1" action="replace" from="old" to="new"}\nReason.\n::\n`,
  );
  const diags = validate(doc);
  assert.ok(!diags.some((d) => d.code === "change-request-invalid-action"));
  assert.ok(!diags.some((d) => d.code === "change-request-missing-revision-text"));
  assert.ok(!diags.some((d) => d.code === "broken-reference"));
});

test("comment target participates in broken-reference validation", () => {
  const doc = parse(`::comment{id="comment1" parent="missing"}\nCheck this.\n::\n`);
  const diags = validate(doc);
  assert.ok(diags.some((d) => d.code === "broken-reference"));
});

test("comment reply_to participates in broken-reference validation", () => {
  const valid = validate(parse(`::comment{id="comment1"}\nCheck this.\n::\n\n::comment{id="comment2" reply_to="comment1"}\nReply.\n::\n`));
  assert.ok(!valid.some((d) => d.code === "broken-reference"), JSON.stringify(valid));

  const invalid = validate(parse(`::comment{id="comment2" reply_to="missing"}\nReply.\n::\n`));
  assert.ok(invalid.some((d) => d.code === "broken-reference"));
});

test("footnote target participates in broken-reference validation", () => {
  const valid = validate(parse(`::claim{id="c1" noverify}\nClaim.\n::\n\n::footnote{id="fn1" for="c1"}\nCheck this caveat.\n::\n`));
  assert.ok(!valid.some((d) => d.code === "broken-reference"), JSON.stringify(valid));

  const invalid = validate(parse(`::footnote{id="fn1" target="missing"}\nCheck this caveat.\n::\n`));
  assert.ok(invalid.some((d) => d.code === "broken-reference"));
});

test("endnote target participates in broken-reference validation", () => {
  const valid = validate(parse(`::claim{id="c1" noverify}\nClaim.\n::\n\n::endnote{id="en1" for="c1"}\nCheck this context.\n::\n`));
  assert.ok(!valid.some((d) => d.code === "broken-reference"), JSON.stringify(valid));

  const invalid = validate(parse(`::endnote{id="en1" ref="missing"}\nCheck this context.\n::\n`));
  assert.ok(invalid.some((d) => d.code === "broken-reference"));
});

test("change_request warns on invalid or incomplete tracked revisions", () => {
  const doc = parse(
    `::change_request{id="cr1" action="move"}\n::\n\n::change_request{id="cr2" action="replace" from="old"}\n::\n`,
  );
  const diags = validate(doc);
  assert.ok(diags.some((d) => d.code === "change-request-invalid-action"));
  assert.ok(diags.some((d) => d.code === "change-request-missing-revision-text"));
});

test("plot referencing unknown dataset is an error", () => {
  const doc = parse(`::plot{id="p1" type="bar" dataset="missing" column="x"}\n::\n`);
  const diags = validate(doc);
  assert.ok(diags.some((d) => d.code === "plot-unknown-dataset"));
});

test("plot referencing unknown column on known dataset is an error", () => {
  const doc = parse(
    `::dataset{id="ds1"}\nschema:\n  a: number\n  b: number\nrows:\n  - [1, 2]\n  - [3, 4]\n::\n::plot{id="p1" type="bar" dataset="ds1" column="z"}\n::\n`,
  );
  const diags = validate(doc);
  assert.ok(diags.some((d) => d.code === "plot-unknown-column"));
});

test("plot column validation supports quoted CSV dataset headers", () => {
  const doc = parse(
    `::dataset{id="ds1" format="csv"}\nvertical,"gross,margin"\nlegal,0.42\n::\n::plot{id="p1" type="bar" dataset="ds1" column="gross,margin"}\n::\n`,
  );
  const diags = validate(doc);
  assert.ok(!diags.some((d) => d.code === "plot-unknown-column"), JSON.stringify(diags));
});

test("plot-mixed-delimiters warns when data and xlabels disagree", () => {
  const doc = parse(
    `::plot{id="p1" type="bar" data="1,2,3" xlabels="a b c"}\n::\n`,
  );
  const diags = validate(doc);
  assert.ok(diags.some((d) => d.code === "plot-mixed-delimiters"));
});

test("plot-mixed-delimiters silent when both use commas", () => {
  const doc = parse(
    `::plot{id="p1" type="bar" data="1,2,3" xlabels="a,b,c"}\n::\n`,
  );
  const diags = validate(doc);
  assert.ok(!diags.some((d) => d.code === "plot-mixed-delimiters"));
});

test("stale-citation flags old accessed dates", () => {
  const doc = parse(`::citation{id="c1" url="x" accessed="2020-01-01"}\nx\n::\n`);
  const diags = validate(doc, { now: new Date("2026-05-09") });
  assert.ok(diags.some((d) => d.code === "stale-citation"));
});

test("claim-invalid-confidence flags values outside [0, 1]", () => {
  const doc = parse(`::claim{id="c1" confidence=1.5}\nx\n::\n`);
  const diags = validate(doc);
  assert.ok(diags.some((d) => d.code === "claim-invalid-confidence"));
});

test("claim-invalid-confidence flags non-numeric values", () => {
  const doc = parse(`::claim{id="c1" confidence="high"}\nx\n::\n`);
  const diags = validate(doc);
  assert.ok(diags.some((d) => d.code === "claim-invalid-confidence"));
});

test("claim-invalid-confidence silent on valid values", () => {
  const doc = parse(`::claim{id="c1" confidence=0.82}\nx\n::\n`);
  const diags = validate(doc);
  assert.ok(!diags.some((d) => d.code === "claim-invalid-confidence"));
});

test("citation-missing-source warns when no url/source/doi", () => {
  const doc = parse(`::citation{id="c1" accessed="2026-05-01"}\nx\n::\n`);
  const diags = validate(doc, { now: new Date("2026-05-09") });
  assert.ok(diags.some((d) => d.code === "citation-missing-source"));
});

test("citation-missing-source silent when url present", () => {
  const doc = parse(`::citation{id="c1" url="https://example.com"}\nx\n::\n`);
  const diags = validate(doc);
  assert.ok(!diags.some((d) => d.code === "citation-missing-source"));
});

test("citation-missing-source silent when doi present", () => {
  const doc = parse(`::citation{id="c1" doi="10.1000/xyz"}\nx\n::\n`);
  const diags = validate(doc);
  assert.ok(!diags.some((d) => d.code === "citation-missing-source"));
});

test("stale-citation honors frontmatter stale_citation_days", () => {
  const doc = parse(
    `---\nstale_citation_days: 30\n---\n::citation{id="c1" accessed="2026-04-01"}\nx\n::\n`,
  );
  const diags = validate(doc, { now: new Date("2026-05-09") });
  assert.ok(diags.some((d) => d.code === "stale-citation"));
});

test("stale-citation per-citation override beats global", () => {
  const doc = parse(
    `::citation{id="c1" accessed="2024-01-01" stale_after_days=10000}\nx\n::\n`,
  );
  const diags = validate(doc, { now: new Date("2026-05-09") });
  assert.ok(!diags.some((d) => d.code === "stale-citation"));
});

test("stale-citation respects custom window", () => {
  const doc = parse(`::citation{id="c1" accessed="2026-01-01"}\nx\n::\n`);
  const diags = validate(doc, {
    now: new Date("2026-05-09"),
    staleCitationDays: 1000,
  });
  assert.ok(!diags.some((d) => d.code === "stale-citation"));
});

test("profile=minimal warns on research directives", () => {
  const doc = parse(
    `---\nprofile: minimal\n---\n::claim{id="c1"}\nx\n::\n::evidence{for="c1"}\ny\n::\n`,
  );
  const diags = validate(doc);
  const ofp = diags.filter((d) => d.code === "out-of-profile-directive");
  assert.ok(ofp.length >= 2);
});

test("profile=research allows research directives", () => {
  const doc = parse(
    `---\nprofile: research\n---\n::claim{id="c1"}\nx\n::\n::evidence{for="c1"}\ny\n::\n`,
  );
  const diags = validate(doc);
  assert.ok(!diags.some((d) => d.code === "out-of-profile-directive"));
});

test("page chrome and publishing directives are allowed in publishing profiles", () => {
  for (const profile of ["minimal", "technical", "research"]) {
    const doc = parse(`---\nprofile: ${profile}\n---\n::page_setup{size="Letter"}\n::\n\n::doc_protection{edit="forms"}\n::\n\n::header\nhead\n::\n\n::footer{page_numbers}\nfoot\n::\n\n::toc\n::\n\n::pagebreak\n::\n\n::footnote\nnote\n::\n\n::endnote\nend note\n::\n\n::bibliography\n::\n`);
    const diags = validate(doc);
    assert.ok(
      !diags.some((d) => d.code === "out-of-profile-directive"),
      `expected page chrome and publishing directives in profile=${profile}`,
    );
  }
});

test("addressable code directives are allowed in publishing profiles", () => {
  for (const profile of ["minimal", "technical", "research"]) {
    const doc = parse(`---\nprofile: ${profile}\n---\n::code{id="snippet" lang="text"}\nPatch by stable ID.\n::\n`);
    const diags = validate(doc);
    assert.ok(
      !diags.some((d) => d.code === "out-of-profile-directive"),
      `expected code directive in profile=${profile}`,
    );
  }
});

test("technical API directives are allowed in the technical profile", () => {
  const doc = parse(`---
profile: technical
---
::api{id="api" title="API"}
::

::endpoint{id="endpoint" method="GET" path="/v1/items" api="api"}
::

::parameter{id="param" name="limit" in="query" type="number"}
::

::example{id="example" lang="json" for="endpoint"}
{"limit":10}
::

::query{id="query" lang="sql" dataset="api"}
select 1;
::

::instruction{id="instruction" scope="agent"}
Patch one block.
::

::control{id="growth-rate" default=8}
::

::computed_metric{id="projection" formula="growth-rate * 2"}
::

::changelog{id="change" version="1.0.0"}
Initial API.
::`);
  const diags = validate(doc);
  assert.ok(!diags.some((d) => d.code === "out-of-profile-directive"));
});

test("unknown-profile warns once", () => {
  const doc = parse(`---\nprofile: nonsense\n---\n# hi\n`);
  const diags = validate(doc);
  assert.equal(diags.filter((d) => d.code === "unknown-profile").length, 1);
});

test("examples and docs validate without errors", () => {
  const roots = ["examples", "docs"];
  for (const root of roots) {
    for (const f of readdirSync(root).filter((n) => n.endsWith(".noma"))) {
      const path = join(root, f);
      const doc = parse(readFileSync(path, "utf8"), { filename: path });
      const diags = validate(doc, { now: new Date("2026-05-09") });
      const errors = diags.filter((d) => d.severity === "error");
      assert.equal(
        errors.length,
        0,
        `${path} has errors: ${errors.map((d) => d.code).join(", ")}`,
      );
    }
  }
});

test("examples and docs emit no validator warnings", () => {
  const roots = ["examples", "docs"];
  const allWarnings: string[] = [];
  for (const root of roots) {
    for (const f of readdirSync(root).filter((n) => n.endsWith(".noma"))) {
      const path = join(root, f);
      const doc = parse(readFileSync(path, "utf8"), { filename: path });
      const diags = validate(doc, { now: new Date("2026-05-09") });
      for (const d of diags) {
        if (d.severity === "warning") {
          allWarnings.push(`${path}: ${d.code} ${d.message}`);
        }
      }
    }
  }
  assert.equal(
    allWarnings.length,
    0,
    `unexpected warnings:\n${allWarnings.join("\n")}`,
  );
});
