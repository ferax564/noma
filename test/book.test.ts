import { test } from "node:test";
import assert from "node:assert/strict";
import { loadBook, isBookManifestPath, listChapters } from "../src/book.js";
import { renderHtml } from "../src/renderer-html.js";
import { renderLlm } from "../src/renderer-llm.js";
import { validate } from "../src/validator.js";

test("isBookManifestPath detects yaml extensions", () => {
  assert.equal(isBookManifestPath("book.noma.yml"), true);
  assert.equal(isBookManifestPath("book.yaml"), true);
  assert.equal(isBookManifestPath("chapter.noma"), false);
});

test("loadBook concatenates chapters into one DocumentNode", () => {
  const doc = loadBook("examples/book/book.noma.yml");
  assert.equal(doc.type, "document");
  assert.equal(doc.meta.title, "Agentic Documents — A Short Field Guide");
  assert.equal(doc.meta.author, "ferax564");
  const chapters = listChapters(doc);
  assert.equal(chapters.length, 3);
  assert.deepEqual(
    chapters.map((c) => c.title),
    ["Why Noma exists", "The block model", "Edits agents can trust"],
  );
});

test("loaded book renders to HTML and LLM cleanly", () => {
  const doc = loadBook("examples/book/book.noma.yml");
  const html = renderHtml(doc, { standalone: true, themeCss: "" });
  assert.match(html, /<!doctype html>/);
  assert.match(html, /Why Noma exists/);
  assert.match(html, /The block model/);
  assert.match(html, /Edits agents can trust/);

  const llm = renderLlm(doc);
  assert.match(llm, /Why Noma exists/);
  assert.match(llm, /\[CLAIM/);
});

test("loaded book validates with no errors", () => {
  const doc = loadBook("examples/book/book.noma.yml");
  const diags = validate(doc, { now: new Date("2026-05-09") });
  const errors = diags.filter((d) => d.severity === "error");
  assert.equal(errors.length, 0, errors.map((d) => d.message).join("\n"));
});
