import { test } from "node:test";
import assert from "node:assert/strict";
import { parse } from "../src/parser.js";
import { renderHtml } from "../src/renderer-html.js";
import { renderLlm } from "../src/renderer-llm.js";
import { validate } from "../src/validator.js";

const sampleHtml = `::html{trusted}\n<aside class="custom"><b>raw</b></aside>\n::\n`;
const sampleSvg = `::svg{trusted}\n<svg width="10" height="10"><circle cx="5" cy="5" r="4" /></svg>\n::\n`;
const sampleScript = `::script{runtime="browser" trusted}\nconsole.log("hi");\n::\n`;

test("html escape hatch emits raw markup by default", () => {
  const html = renderHtml(parse(sampleHtml));
  assert.match(html, /<aside class="custom"><b>raw<\/b><\/aside>/);
});

test("svg escape hatch emits raw markup by default", () => {
  const html = renderHtml(parse(sampleSvg));
  assert.match(html, /<circle cx="5"/);
});

test("script escape hatch emits a real <script> tag", () => {
  const html = renderHtml(parse(sampleScript));
  assert.match(html, /<script[^>]*>console\.log/);
});

test("--no-unsafe blocks all escape hatches", () => {
  for (const src of [sampleHtml, sampleSvg, sampleScript]) {
    const html = renderHtml(parse(src), { allowEscapeHatches: false });
    assert.match(html, /noma-blocked-escape/);
    assert.doesNotMatch(html, /<aside class="custom"|<circle|console\.log/);
  }
});

test("LLM render strips escape-hatch bodies", () => {
  const llm = renderLlm(parse(sampleHtml));
  assert.match(llm, /\[HTML escape-hatch block omitted/);
  assert.doesNotMatch(llm, /<aside/);
});

test("validator warns on untrusted escape hatches", () => {
  const doc = parse(`::html\nraw\n::\n`);
  const diags = validate(doc);
  assert.ok(diags.some((d) => d.code === "escape-hatch-untrusted"));
});

test("trusted attribute silences escape-hatch warning", () => {
  const doc = parse(`::html{trusted}\n<b>x</b>\n::\n`);
  const diags = validate(doc);
  assert.ok(!diags.some((d) => d.code === "escape-hatch-untrusted"));
});
