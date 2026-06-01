import { test } from "node:test";
import assert from "node:assert/strict";
import { evaluateFormula, extractFormulaIdentifiers, parseFormula } from "../src/formula.js";

function parseOk(source: string) {
  const parsed = parseFormula(source);
  assert.equal(parsed.ok, true, parsed.ok ? "" : parsed.error.message);
  return parsed.ast;
}

test("formula parser evaluates numeric arithmetic and functions", () => {
  const ast = parseOk("base-revenue * pow(1 + growth-rate / 100, 5)");
  const result = evaluateFormula(ast, { "base-revenue": 120, "growth-rate": 8 });
  assert.equal(result.ok, true, result.ok ? "" : result.error.message);
  assert.equal(Math.round(result.value * 100) / 100, 176.32);
});

test("formula parser keeps subtraction distinct from hyphenated identifiers", () => {
  assert.deepEqual(evaluateFormula(parseOk("x - 1"), { x: 3 }), { ok: true, value: 2 });
  assert.deepEqual(extractFormulaIdentifiers(parseOk("growth-rate - 1")), ["growth-rate"]);
  assert.deepEqual(extractFormulaIdentifiers(parseOk("year-5-revenue + 1")), ["year-5-revenue"]);
});

test("formula parser extracts hyphenated control identifiers", () => {
  const ast = parseOk("clamp(growth-rate, 0, 20) + round(base_revenue / 3, 1)");
  assert.deepEqual(extractFormulaIdentifiers(ast), ["base_revenue", "growth-rate"]);
});

test("formula parser supports comparisons for if", () => {
  const ast = parseOk("if(growth-rate > 10, 1, 0)");
  assert.deepEqual(evaluateFormula(ast, { "growth-rate": 12 }), { ok: true, value: 1 });
  assert.deepEqual(evaluateFormula(ast, { "growth-rate": 4 }), { ok: true, value: 0 });
});

test("formula parser rejects unknown functions and invalid syntax", () => {
  const unknown = parseFormula("evil(x)");
  assert.equal(unknown.ok, false);
  assert.match(unknown.ok ? "" : unknown.error.message, /Unknown function/);

  const invalid = parseFormula("1 + * 2");
  assert.equal(invalid.ok, false);
  assert.match(invalid.ok ? "" : invalid.error.message, /Expected/);
});

test("formula evaluator reports missing identifiers and non-finite output", () => {
  const missing = evaluateFormula(parseOk("x + 1"), {});
  assert.equal(missing.ok, false);
  assert.match(missing.ok ? "" : missing.error.message, /Missing numeric value/);

  const division = evaluateFormula(parseOk("1 / 0"), {});
  assert.equal(division.ok, false);
  assert.match(division.ok ? "" : division.error.message, /Division by zero/);
});
