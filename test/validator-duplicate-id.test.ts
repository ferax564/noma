import { test } from "node:test";
import assert from "node:assert/strict";
import { parse } from "../src/parser.js";
import { validate } from "../src/validator.js";

test("explicit duplicate IDs emit duplicate-id error diagnostic", () => {
  const src = `::claim{id="x"}\na\n::\n\n::claim{id="x"}\nb\n::\n`;
  const doc = parse(src);
  const diags = validate(doc);
  const dup = diags.filter((d) => d.code === "duplicate-id");
  assert.ok(dup.length >= 1, "expected at least one duplicate-id diagnostic");
  assert.equal(dup[0]?.severity, "error");
});

test("no duplicate-id when slug-derived IDs were already suffixed", () => {
  const src = `# Risks\n\na\n\n# Risks\n\nb\n`;
  const doc = parse(src);
  const diags = validate(doc);
  const dup = diags.filter((d) => d.code === "duplicate-id");
  assert.equal(dup.length, 0, "suffixed slug IDs should not trigger duplicate-id");
});
