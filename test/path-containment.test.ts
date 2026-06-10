import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadBook } from "../src/book.js";
import { inlineDatasetSources, resolveSourcePath } from "../src/loader.js";
import { parse } from "../src/parser.js";
import type { DirectiveNode } from "../src/ast.js";

function tempBook(): { dir: string; manifest: string } {
  const dir = mkdtempSync(join(tmpdir(), "noma-containment-"));
  mkdirSync(join(dir, "book"));
  writeFileSync(join(dir, "secret.noma"), "# Outside\n\nshould not load\n");
  writeFileSync(join(dir, "book", "ch1.noma"), "# Chapter One\n\nhello\n");
  const manifest = join(dir, "book", "book.noma.yml");
  return { dir, manifest };
}

test("resolveSourcePath contains relative paths to baseDir", () => {
  assert.ok(resolveSourcePath("/base", "data.csv"));
  assert.ok(resolveSourcePath("/base", "nested/data.csv"));
  assert.equal(resolveSourcePath("/base", "../data.csv"), undefined);
  assert.equal(resolveSourcePath("/base", "/etc/passwd"), undefined);
  assert.ok(resolveSourcePath("/base", "../data.csv", true));
  assert.ok(resolveSourcePath("/base", "/etc/passwd", true));
});

test("loadBook rejects chapters escaping the manifest directory", () => {
  const { manifest } = tempBook();
  writeFileSync(manifest, "title: T\nchapters:\n  - ../secret.noma\n");
  assert.throws(() => loadBook(manifest), /escapes the manifest directory/);
});

test("loadBook allows escaping chapters with allowExternalPaths", () => {
  const { manifest } = tempBook();
  writeFileSync(manifest, "title: T\nchapters:\n  - ../secret.noma\n");
  const doc = loadBook(manifest, { allowExternalPaths: true });
  assert.ok(doc.children.length > 0);
});

test("loadBook still loads contained chapters", () => {
  const { manifest } = tempBook();
  writeFileSync(manifest, "title: T\nchapters:\n  - ch1.noma\n");
  const doc = loadBook(manifest);
  assert.ok(doc.children.length > 0);
});

test("dataset src escaping the document directory becomes an error body", () => {
  const dir = mkdtempSync(join(tmpdir(), "noma-dataset-"));
  writeFileSync(join(dir, "doc.noma"), "");
  const doc = parse('::dataset{id="d1" src="../../etc/hostname"}\n::\n', {
    filename: join(dir, "doc.noma"),
  });
  inlineDatasetSources(doc, dir);
  const dataset = doc.children.find(
    (n): n is DirectiveNode => n.type === "directive" && n.name === "dataset",
  );
  assert.ok(dataset);
  assert.equal(dataset.attrs.format, "error");
  assert.match(String(dataset.body), /escapes the document directory/);
});

test("dataset src inside the document directory still inlines", () => {
  const dir = mkdtempSync(join(tmpdir(), "noma-dataset-ok-"));
  writeFileSync(join(dir, "data.csv"), "a,b\n1,2\n");
  const doc = parse('::dataset{id="d1" src="data.csv"}\n::\n');
  inlineDatasetSources(doc, dir);
  const dataset = doc.children.find(
    (n): n is DirectiveNode => n.type === "directive" && n.name === "dataset",
  );
  assert.ok(dataset);
  assert.equal(dataset.attrs.format, "csv");
  assert.match(String(dataset.body), /1,2/);
});

test("parser caps directive fence depth", () => {
  const deep = ":".repeat(80) + "card";
  const doc = parse(`${deep}\nbody\n${":".repeat(80)}\n`);
  assert.ok(doc.children.every((n) => n.type !== "directive"));
  const ok = parse('::grid{id="g"}\n:::card{id="c"}\nhi\n:::\n::\n');
  assert.ok(ok.children.some((n) => n.type === "directive"));
});
