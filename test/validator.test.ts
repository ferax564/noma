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
  const doc = parse(`::citation{id="c1" accessed="2020-01-01"}\nx\n::\n`);
  const diags = validate(doc, { now: new Date("2026-05-09") });
  assert.ok(diags.some((d) => d.code === "stale-citation"));
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
