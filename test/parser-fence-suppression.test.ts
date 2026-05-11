import { test } from "node:test";
import assert from "node:assert/strict";
import { parse } from "../src/parser.js";

test("`::` inside fenced code does NOT close the parent directive", () => {
  const src = `::card{id="c"}
\`\`\`
::not-a-directive
::
\`\`\`
::
`;
  const doc = parse(src);
  const card = doc.children.find(
    (n) => n.type === "directive" && (n as any).id === "c"
  );
  assert.ok(card, "card should exist");
  const card2 = card as { children?: any[] };
  const code = card2.children?.find((c: any) => c.type === "code");
  assert.ok(code, "card should contain a code node");
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
