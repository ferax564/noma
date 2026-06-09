import { test } from "node:test";
import assert from "node:assert/strict";
import { parse } from "../src/parser.js";
import { isDirective } from "../src/ast.js";

test("`::` inside fenced code does NOT close the parent directive", () => {
  const src = `::card{id="c"}
\`\`\`
::not-a-directive
::
\`\`\`
::
`;
  const doc = parse(src);
  const card = doc.children.find((n) => isDirective(n) && n.id === "c");
  assert.ok(card && isDirective(card), "card should exist");
  const code = card.children.find((c) => c.type === "code");
  assert.ok(code && code.type === "code", "card should contain a code node");
  assert.match(code.content, /::not-a-directive/);
  assert.match(code.content, /^::$/m);
});

test("`::` inside fenced code at top level does not start a directive", () => {
  const src = `\`\`\`
::card
content
::
\`\`\`
`;
  const doc = parse(src);
  const first = doc.children[0];
  assert.equal(first?.type, "code");
});
