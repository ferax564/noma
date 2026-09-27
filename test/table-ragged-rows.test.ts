import { test } from "node:test";
import assert from "node:assert/strict";
import Ajv2020 from "ajv/dist/2020.js";
import { readFileSync } from "node:fs";
import { parse } from "../src/parser.js";
import { renderHtml } from "../src/renderer-html.js";
import { renderJson } from "../src/renderer-json.js";
import { renderNoma } from "../src/renderer-noma.js";
import { validate } from "../src/validator.js";
import type { TableNode } from "../src/ast.js";

const ragged = "| A | B |\n|---|---|\n| 1 | 2 | 3 |\n| 4 |\n| 5 | 6 |\n";

test("a long table row keeps its extra cells in the last column instead of dropping them", () => {
  const table = parse(ragged).children[0] as TableNode;
  assert.deepEqual(table.rows, [["1", "2 \\| 3"], ["4", ""], ["5", "6"]]);
  assert.deepEqual(table.raggedRows, [[0, 3], [1, 1]]);
  assert.match(renderHtml(parse(ragged)), /<td>2 \| 3<\/td>/);
  const once = renderNoma(parse(ragged));
  assert.match(once, /\| 1 +\| 2 \\\| 3 \|/);
  const twice = parse(once).children[0] as TableNode;
  assert.deepEqual(twice.rows, table.rows, "re-serialising keeps the text");
  assert.equal(twice.raggedRows, undefined, "the serialised table is regular");
});

test("the validator warns on each ragged row with its source line", () => {
  const warnings = validate(parse(`# T\n\n${ragged}`)).filter((d) => d.code === "table-row-cells");
  assert.deepEqual(warnings.map((d) => [d.severity, d.pos?.line]), [["warning", 5], ["warning", 6]]);
  assert.match(warnings[0]!.message, /3 cell\(s\) but the header has 2\. The extra cells are kept in the last column\./);
  assert.deepEqual(validate(parse(`# T\n\n${ragged}`), { ignoreRules: ["table-row-cells"] }).filter((d) => d.code === "table-row-cells"), []);
  assert.deepEqual(validate(parse("| A | B |\n|---|---|\n| 1 | 2 |\n")).filter((d) => d.code === "table-row-cells"), []);
});

test("raggedRows is part of the AST schema", () => {
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  const check = ajv.compile(JSON.parse(readFileSync("schemas/ast.schema.json", "utf8")) as object);
  assert.equal(check(JSON.parse(renderJson(parse(ragged)))), true, JSON.stringify(check.errors));
});

test("a callout written with type= gets a warning and a tone= fix", () => {
  const [warning] = validate(parse('::callout{id="c1" type="warning"}\nCareful.\n::\n')).filter((d) => d.code === "callout-type-attribute");
  assert.equal(warning?.severity, "warning");
  assert.match(warning!.message, /Write tone="warning"/);
  assert.deepEqual(warning!.fix, { op: "update_attribute", id: "c1", key: "tone", value: "warning" });
  assert.deepEqual(validate(parse('::callout{tone="warning"}\nOk.\n::\n')).filter((d) => d.code === "callout-type-attribute"), []);
});
