import assert from "node:assert/strict";
import test from "node:test";
import { nomaToEditorHtml } from "../web/noma-html.ts";
import { statusPath } from "../web/status-path.ts";

test("nomaToEditorHtml hides identity markers and renders claims", () => {
  const html = nomaToEditorHtml(
    "Q3 strategy memo",
    `---
title: Q3 strategy memo
---

# Q3 strategy memo

{#p}
The hosted workspace is the product surface.

::claim{id="north-star" confidence=0.9}
One login should take a team from a brief to a board.
::
`,
    "token",
  );
  assert.doesNotMatch(html, /\{#/);
  assert.doesNotMatch(html, /<h1>/);
  assert.match(html, /hosted workspace/);
  assert.match(html, /ew-panel/);
  assert.match(html, /Claim/);
  assert.doesNotMatch(html, /<blockquote>/);
});

test("statusPath walks forward and reopens done work", () => {
  assert.deepEqual(statusPath("todo", "done"), ["in_progress", "in_review", "done"]);
  assert.deepEqual(statusPath("done", "todo"), ["todo"]);
  assert.deepEqual(statusPath("in_progress", "todo"), ["todo"]);
  assert.deepEqual(statusPath("todo", "todo"), []);
});
