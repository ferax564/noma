import { test } from "node:test";
import assert from "node:assert/strict";
import { parse } from "../src/parser.js";

test("parser emits FrontmatterNode when frontmatter present", () => {
  const src = `---
title: Example
date: 2026-05-11
---

# Heading
`;
  const doc = parse(src);
  const fm = doc.children[0];
  assert.equal(fm?.type, "frontmatter");
  assert.equal(fm.pos?.line, 1);
  assert.equal(fm.endLine, 4);
  assert.equal(fm.data.title, "Example");
  assert.ok(fm.data.date !== undefined);
});

test("no FrontmatterNode emitted when frontmatter absent", () => {
  const src = `# Heading\n\nparagraph.\n`;
  const doc = parse(src);
  assert.notEqual(doc.children[0]?.type, "frontmatter");
});
