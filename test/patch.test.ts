import { test } from "node:test";
import assert from "node:assert/strict";
import { parse } from "../src/parser.js";
import { renderNoma } from "../src/renderer-noma.js";
import { patch, patchAll, findById, PatchError } from "../src/patch.js";
import type { DirectiveNode } from "../src/ast.js";

const sample = `# T

::claim{id="c1" confidence=0.5}
old body
::

::evidence{for="c1"}
ev
::
`;

test("patch: replace_block swaps node by id", () => {
  const doc = parse(sample);
  const next = patch(doc, {
    op: "replace_block",
    id: "c1",
    content: `::claim{id="c1" confidence=0.9}\nnew body\n::\n`,
  });
  const out = renderNoma(next);
  assert.match(out, /confidence=0\.9/);
  assert.match(out, /new body/);
  assert.doesNotMatch(out, /old body/);
});

test("patch: add_block appends to a parent", () => {
  const doc = parse(`::grid{id="g" columns=2}\n:::card{title="A"}\nl\n:::\n::\n`);
  const next = patch(doc, {
    op: "add_block",
    parent: "g",
    content: `:::card{title="B"}\nr\n:::\n`,
  });
  const grid = next.children[0] as DirectiveNode;
  assert.equal(grid.children.length, 2);
  assert.equal((grid.children[1] as DirectiveNode).attrs.title, "B");
});

test("patch: add_block honours position", () => {
  const doc = parse(`::grid{id="g"}\n:::card{title="A"}\na\n:::\n\n:::card{title="C"}\nc\n:::\n::\n`);
  const next = patch(doc, {
    op: "add_block",
    parent: "g",
    position: 1,
    content: `:::card{title="B"}\nb\n:::\n`,
  });
  const grid = next.children[0] as DirectiveNode;
  const titles = grid.children.map((c) => (c as DirectiveNode).attrs.title);
  assert.deepEqual(titles, ["A", "B", "C"]);
});

test("patch: delete_block removes by id", () => {
  const doc = parse(sample);
  const next = patch(doc, { op: "delete_block", id: "c1" });
  assert.equal(findById(next, "c1"), null);
});

test("patch: update_attribute mutates a single attr", () => {
  const doc = parse(sample);
  const next = patch(doc, {
    op: "update_attribute",
    id: "c1",
    key: "confidence",
    value: 0.99,
  });
  const claim = findById(next, "c1") as DirectiveNode;
  assert.equal(claim.attrs.confidence, 0.99);
});

test("patch: update_attribute rejects id changes", () => {
  const doc = parse(sample);
  assert.throws(
    () =>
      patch(doc, {
        op: "update_attribute",
        id: "c1",
        key: "id",
        value: "c2",
      }),
    PatchError,
  );
});

test("patch: rename_id retargets evidence references and wikilinks", () => {
  const doc = parse(`# T\n\n::claim{id="c1"}\na\n::\n\n::evidence{for="c1"}\nb\n::\n\nSee [[c1]].\n`);
  const next = patch(doc, { op: "rename_id", from: "c1", to: "claim-renamed" });
  const out = renderNoma(next);
  assert.match(out, /id="claim-renamed"/);
  assert.match(out, /for="claim-renamed"/);
  assert.match(out, /\[\[claim-renamed\]\]/);
  assert.doesNotMatch(out, /c1/);
});

test("patch: rename_id rejects collision", () => {
  const doc = parse(`::claim{id="a"}\nx\n::\n\n::claim{id="b"}\ny\n::\n`);
  assert.throws(
    () => patch(doc, { op: "rename_id", from: "a", to: "b" }),
    PatchError,
  );
});

test("patch: replace_block on missing id throws", () => {
  const doc = parse(sample);
  assert.throws(
    () =>
      patch(doc, {
        op: "replace_block",
        id: "missing",
        content: `::claim{id="missing"}\nx\n::\n`,
      }),
    PatchError,
  );
});

test("patchAll runs ops sequentially", () => {
  const doc = parse(sample);
  const next = patchAll(doc, [
    { op: "update_attribute", id: "c1", key: "confidence", value: 0.7 },
    { op: "rename_id", from: "c1", to: "c2" },
  ]);
  const claim = findById(next, "c2") as DirectiveNode;
  assert.equal(claim.attrs.confidence, 0.7);
  const out = renderNoma(next);
  assert.match(out, /for="c2"/);
});

test("patch: input doc is not mutated", () => {
  const doc = parse(sample);
  const before = renderNoma(doc);
  patch(doc, { op: "delete_block", id: "c1" });
  assert.equal(renderNoma(doc), before);
});
