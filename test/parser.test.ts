import { test } from "node:test";
import assert from "node:assert/strict";
import { parse } from "../src/parser.js";
import { renderHtml } from "../src/renderer-html.js";
import { renderLlm } from "../src/renderer-llm.js";
import { validate } from "../src/validator.js";
import type { DirectiveNode, SectionNode } from "../src/ast.js";

test("frontmatter parsed into meta", () => {
  const doc = parse(`---\ntitle: Hello\nauthor: ferax564\n---\n\n# Body\n`);
  assert.equal(doc.meta.title, "Hello");
  assert.equal(doc.meta.author, "ferax564");
});

test("headings fold into nested sections with stable ids", () => {
  const doc = parse(`# A\n\n## B\n\nbody\n\n## C\n\nbody\n`);
  assert.equal(doc.children.length, 1);
  const a = doc.children[0] as SectionNode;
  assert.equal(a.type, "section");
  assert.equal(a.id, "a");
  assert.equal(a.children.length, 2);
  assert.equal((a.children[0] as SectionNode).id, "b");
  assert.equal((a.children[1] as SectionNode).id, "c");
});

test("directive block parses with attributes", () => {
  const doc = parse(`::claim{id="c1" confidence=0.82}\nClaim body.\n::\n`);
  const node = doc.children[0] as DirectiveNode;
  assert.equal(node.type, "directive");
  assert.equal(node.name, "claim");
  assert.equal(node.id, "c1");
  assert.equal(node.attrs.confidence, 0.82);
  assert.equal(node.body, "Claim body.");
});

test("nested directives via colon counting", () => {
  const src = `::grid{columns=2}\n:::card{title="A"}\nleft\n:::\n\n:::card{title="B"}\nright\n:::\n::\n`;
  const doc = parse(src);
  const grid = doc.children[0] as DirectiveNode;
  assert.equal(grid.name, "grid");
  assert.equal(grid.children.length, 2);
  const cardA = grid.children[0] as DirectiveNode;
  assert.equal(cardA.name, "card");
  assert.equal(cardA.attrs.title, "A");
});

test("inline markup survives in HTML output", () => {
  const doc = parse(`This is **bold** and *em* and \`code\`.\n`);
  const html = renderHtml(doc);
  assert.match(html, /<strong>bold<\/strong>/);
  assert.match(html, /<em>em<\/em>/);
  assert.match(html, /<code>code<\/code>/);
});

test("LLM renderer emits typed tags", () => {
  const doc = parse(`::claim{id="c1" confidence=0.5}\nHello.\n::\n`);
  const out = renderLlm(doc);
  assert.match(out, /\[CLAIM/);
  assert.match(out, /id="c1"/);
  assert.match(out, /\[\/CLAIM\]/);
});

test("validator catches duplicate IDs", () => {
  const doc = parse(`::claim{id="x"}\na\n::\n\n::claim{id="x"}\nb\n::\n`);
  const diagnostics = validate(doc);
  assert.ok(diagnostics.some((d) => d.code === "duplicate-id"));
});

test("validator catches broken evidence reference", () => {
  const doc = parse(`::evidence{for="missing"}\nbody\n::\n`);
  const diagnostics = validate(doc);
  assert.ok(diagnostics.some((d) => d.code === "broken-reference"));
});

test("validator catches plot without data", () => {
  const doc = parse(`::plot{title="x"}\n::\n`);
  const diagnostics = validate(doc);
  assert.ok(diagnostics.some((d) => d.code === "plot-missing-data"));
});

test("standalone HTML wraps with theme", () => {
  const doc = parse(`# Hello\n`);
  const html = renderHtml(doc, { standalone: true, themeCss: "body{color:red}" });
  assert.match(html, /<!doctype html>/);
  assert.match(html, /color:red/);
});
