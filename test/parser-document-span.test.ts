import { test } from "node:test";
import assert from "node:assert/strict";
import { parse } from "../src/parser.js";

test("DocumentNode carries pos and endLine spanning the whole source", () => {
  const src = `---
title: Example
---

# Heading

paragraph.
`;
  const doc = parse(src);
  assert.equal(doc.pos?.line, 1, "document starts on line 1");
  assert.equal(doc.pos?.column, 1, "document starts on column 1");
  assert.equal(doc.endLine, 7, "document spans through last line (trailing newline = empty line 7)");
});
