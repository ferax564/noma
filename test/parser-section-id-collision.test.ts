import { test } from "node:test";
import assert from "node:assert/strict";
import { parse } from "../src/parser.js";

test("duplicate-slug headings get suffixed -2, -3, …", () => {
  const src = `# Risks

text 1.

# Risks

text 2.

# Risks

text 3.
`;
  const doc = parse(src);
  const sections = doc.children.filter((n) => n.type === "section");
  assert.equal(sections.length, 3);
  assert.equal(sections[0]?.id, "risks");
  assert.equal(sections[1]?.id, "risks-2");
  assert.equal(sections[2]?.id, "risks-3");
});

test("explicit {id=} override is not suffixed even on collision", () => {
  const src = `# A {id="x"}

text.

# B {id="x"}

text.
`;
  const doc = parse(src);
  const sections = doc.children.filter((n) => n.type === "section");
  assert.equal(sections[0]?.id, "x");
  assert.equal(sections[1]?.id, "x");
  // (validator emits duplicate-id diagnostic — tested separately in validator tests)
});
