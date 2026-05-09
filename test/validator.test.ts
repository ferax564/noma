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

test("stale-citation flags old accessed dates", () => {
  const doc = parse(`::citation{id="c1" accessed="2020-01-01"}\nx\n::\n`);
  const diags = validate(doc, { now: new Date("2026-05-09") });
  assert.ok(diags.some((d) => d.code === "stale-citation"));
});

test("stale-citation respects custom window", () => {
  const doc = parse(`::citation{id="c1" accessed="2026-01-01"}\nx\n::\n`);
  const diags = validate(doc, {
    now: new Date("2026-05-09"),
    staleCitationDays: 1000,
  });
  assert.ok(!diags.some((d) => d.code === "stale-citation"));
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
