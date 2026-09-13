import assert from "node:assert/strict";
import test from "node:test";
import { parse } from "../src/parser.js";
import { renderNoma } from "../src/renderer-noma.js";
import { renderHtml } from "../src/renderer-html.js";
import { validate } from "../src/validator.js";
import { collectIdRegistry } from "../src/ids.js";
import {
  assignPersistentIdentities,
  insertTableRowWithIdentities,
  locateTableCell,
  remapIdentitiesOnDuplicate,
  resetIdentitySequence,
  updateTableCellById,
} from "../src/stable-identity.js";
import type { TableNode } from "../src/ast.js";

function tableOf(source: string): TableNode {
  const doc = parse(source);
  const section = doc.children.find((node) => node.type === "section");
  const table = (section && section.type === "section" ? section.children : doc.children).find((node) => node.type === "table");
  assert.equal(table?.type, "table");
  return table as TableNode;
}

test("legacy pipe tables still parse without identity metadata", () => {
  const table = tableOf("# T\n\n| A | B |\n| --- | --- |\n| 1 | 2 |\n");
  assert.deepEqual(table.header, ["A", "B"]);
  assert.deepEqual(table.rows, [["1", "2"]]);
  assert.equal(table.cellIds, undefined);
});

test("explicit table, row, column, and cell identities round-trip through source", () => {
  const source = `{#results cols="col-a,col-b" rows="row-1"}
| {#h-a} Metric | {#h-b} Value |
| --- | --- |
| {#c-metric} Temp | {#c-value} 21.4 |
`;
  const table = tableOf(source);
  assert.equal(table.id, "results");
  assert.deepEqual(table.columnIds, ["col-a", "col-b"]);
  assert.deepEqual(table.rowIds, ["row-1"]);
  assert.equal(table.headerIds?.[0], "h-a");
  assert.equal(table.cellIds?.[0]?.[1], "c-value");
  const printed = renderNoma(parse(source));
  const again = tableOf(printed);
  assert.equal(again.id, "results");
  assert.equal(again.cellIds?.[0]?.[1], "c-value");
  assert.deepEqual(again.columnIds, ["col-a", "col-b"]);
});

test("block identity markers attach to paragraphs, lists, and code without changing headings slugs", () => {
  const doc = parse(`# Title

{#p1}
Hello.

{#lst}
- {#i1} one
- two

{#code}
\`\`\`
x
\`\`\`
`);
  const section = doc.children.find((node) => node.type === "section");
  assert.ok(section && section.type === "section");
  assert.equal(section.id, "title");
  const para = section.children.find((node) => node.type === "paragraph");
  const list = section.children.find((node) => node.type === "list");
  const code = section.children.find((node) => node.type === "code");
  assert.equal(para?.id, "p1");
  assert.equal(list?.id, "lst");
  assert.equal(list && list.type === "list" ? list.items[0]?.id : undefined, "i1");
  assert.equal(code?.id, "code");
});

test("assignPersistentIdentities fills missing IDs once and never derives them from text", () => {
  resetIdentitySequence(0);
  const doc = parse("| Name | Value |\n| --- | --- |\n| Alpha | 1 |\n");
  assignPersistentIdentities(doc);
  const table = doc.children.find((node) => node.type === "table");
  assert.ok(table && table.type === "table");
  const first = [...(table.cellIds?.[0] ?? [])];
  assignPersistentIdentities(doc);
  assert.deepEqual(table.cellIds?.[0], first);
  assert.notEqual(first[0], "Alpha");
  assert.ok(table.id && table.columnIds?.[0] && table.rowIds?.[0]);
});

test("row insertion does not retarget an existing cell identity", () => {
  resetIdentitySequence(0);
  const table = tableOf(`{#t cols="c0,c1" rows="r0"}
| {#h0} A | {#h1} B |
| --- | --- |
| {#c00} keep | {#c01} me |
`);
  assignPersistentIdentities(parse("")); // keep factory moving; table already has ids
  const before = locateTableCell(table, { cellId: "c00" });
  insertTableRowWithIdentities(table, 0, ["new", "row"]);
  const after = locateTableCell(table, { cellId: "c00" });
  assert.equal(after.rowIndex, before.rowIndex + 1);
  updateTableCellById(table, { cellId: "c00" }, "still-keep");
  assert.equal(table.rows[1]?.[0], "still-keep");
  assert.equal(table.rows[0]?.[0], "new");
});

test("duplication remaps identities instead of copying them", () => {
  resetIdentitySequence(100);
  const doc = parse(`{#p}\nHi\n`);
  const clone = parse(renderNoma(doc));
  const map = remapIdentitiesOnDuplicate(clone);
  assert.notEqual(clone.children[0]?.id, "p");
  assert.equal(map.get("p"), clone.children[0]?.id);
});

test("HTML renderer emits stable cell and row data attributes", () => {
  const html = renderHtml(
    parse(`{#t cols="c0,c1" rows="r0"}
| {#h0} A | {#h1} B |
| --- | --- |
| {#c00} 1 | {#c01} 2 |
`),
  );
  assert.match(html, /data-noma-cell-id="c00"/);
  assert.match(html, /data-noma-row-id="r0"/);
  assert.match(html, /id="t"/);
});

test("validator treats table cell identities as first-class IDs", () => {
  const diags = validate(
    parse(`{#dup}
Hello

| {#dup} A | B |
| --- | --- |
| x | y |
`),
  );
  assert.ok(diags.some((d) => d.code === "duplicate-id"));
});

test("id registry includes table cell identities even without a table block id", () => {
  const registry = collectIdRegistry(parse(`| {#only} A | B |\n| --- | --- |\n| x | y |\n`));
  assert.ok(registry.ids.includes("only"));
});
