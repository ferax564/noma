import { test } from "node:test";
import assert from "node:assert/strict";
import { parse } from "../src/parser.js";
import { renderHtml } from "../src/renderer-html.js";
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

test("patch: move_block moves an existing directive to a new parent", () => {
  const doc = parse(`::grid{id="a"}\n:::card{id="one" title="One"}\n1\n:::\n:::card{id="two" title="Two"}\n2\n:::\n::\n\n::grid{id="b"}\n::\n`);
  const next = patch(doc, {
    op: "move_block",
    id: "two",
    parent: "b",
    position: 0,
  });
  const a = findById(next, "a") as DirectiveNode;
  const b = findById(next, "b") as DirectiveNode;
  assert.deepEqual(a.children.map((c) => c.id), ["one"]);
  assert.deepEqual(b.children.map((c) => c.id), ["two"]);
});

test("patch: move_block rejects moves into descendants", () => {
  const doc = parse(`::grid{id="g"}\n:::card{id="c"}\nText.\n:::\n::\n`);
  assert.throws(
    () => patch(doc, { op: "move_block", id: "g", parent: "c" }),
    PatchError,
  );
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

test("patch: remove_attribute deletes a single attr", () => {
  const doc = parse(sample);
  const next = patch(doc, { op: "remove_attribute", id: "c1", key: "confidence" });
  const claim = findById(next, "c1") as DirectiveNode;
  assert.equal(claim.attrs.confidence, undefined);
  assert.equal(claim.attrs.id, "c1");
});

test("patch: remove_attribute rejects id changes", () => {
  const doc = parse(sample);
  assert.throws(
    () =>
      patch(doc, {
        op: "remove_attribute",
        id: "c1",
        key: "id",
      }),
    PatchError,
  );
});

test("patch: replace_body updates directive body without touching attrs", () => {
  const doc = parse(sample);
  const next = patch(doc, {
    op: "replace_body",
    id: "c1",
    content: "new body",
  });
  const claim = findById(next, "c1") as DirectiveNode;
  assert.equal(claim.attrs.confidence, 0.5);
  assert.equal(claim.body, "new body");
  assert.match(renderNoma(next), /::claim\{id="c1" confidence=0\.5\}\nnew body\n::/);
  assert.match(renderHtml(next), /new body/);
});

test("patch: update_heading preserves section id while changing title", () => {
  const doc = parse(`# Old Title\n\n::claim{id="c"}\na\n::\n`);
  const next = patch(doc, { op: "update_heading", id: "old-title", title: "New Title" });
  const out = renderNoma(next);
  assert.match(out, /^# New Title \{id="old-title"\}/);
  assert.equal(findById(next, "old-title")?.type, "section");
});

test("patch: add_comment inserts a targeted comment after the target block", () => {
  const doc = parse(sample);
  const next = patch(doc, {
    op: "add_comment",
    id: "comment-c1",
    target: "c1",
    content: "Check the claim before handoff.",
    author: "Research",
  });
  const comment = findById(next, "comment-c1") as DirectiveNode;
  assert.equal(comment.name, "comment");
  assert.equal(comment.attrs.parent, "c1");
  assert.equal(comment.attrs.author, "Research");
  const out = renderNoma(next);
  assert.match(out, /::claim\{id="c1" confidence=0\.5\}\nold body\n::\n\n::comment\{id="comment-c1" parent="c1" author="Research"\}/);
});

test("patch: add_comment can insert a threaded reply", () => {
  const doc = parse(`::claim{id="c1"}\nClaim.\n::\n\n::comment{id="comment-c1" parent="c1"}\nCheck.\n::\n`);
  const next = patch(doc, {
    op: "add_comment",
    id: "comment-c1-reply",
    target: "comment-c1",
    reply_to: "comment-c1",
    content: "Confirmed.",
  });
  const comment = findById(next, "comment-c1-reply") as DirectiveNode;
  assert.equal(comment.name, "comment");
  assert.equal(comment.attrs.reply_to, "comment-c1");
  assert.equal(comment.attrs.parent, undefined);
});

test("patch: resolve_comment marks an existing comment resolved", () => {
  const doc = parse(`::comment{id="comment-c1" parent="c1"}\nCheck this.\n::\n`);
  const next = patch(doc, {
    op: "resolve_comment",
    id: "comment-c1",
    resolved_by: "Andrea",
    resolved_at: "2026-05-24T10:00:00Z",
  });
  const comment = findById(next, "comment-c1") as DirectiveNode;
  assert.equal(comment.attrs.status, "resolved");
  assert.equal(comment.attrs.resolved_by, "Andrea");
  assert.equal(comment.attrs.resolved_at, "2026-05-24T10:00:00Z");
});

test("patch: resolve_comment rejects non-comment blocks", () => {
  const doc = parse(sample);
  assert.throws(
    () => patch(doc, { op: "resolve_comment", id: "c1" }),
    PatchError,
  );
});

test("patch: add_footnote inserts a targeted footnote after the target block", () => {
  const doc = parse(sample);
  const next = patch(doc, {
    op: "add_footnote",
    id: "fn-c1",
    target: "c1",
    content: "Clarify this claim for committee review.",
  });
  const note = findById(next, "fn-c1") as DirectiveNode;
  assert.equal(note.name, "footnote");
  assert.equal(note.attrs.for, "c1");
  assert.match(renderNoma(next), /::claim\{id="c1" confidence=0\.5\}\nold body\n::\n\n::footnote\{id="fn-c1" for="c1"\}\nClarify this claim for committee review\.\n::/);
});

test("patch: add_endnote inserts a targeted endnote after the target block", () => {
  const doc = parse(sample);
  const next = patch(doc, {
    op: "add_endnote",
    id: "en-c1",
    target: "c1",
    content: "Keep this context with the final notes.",
    label: "Review note",
  });
  const note = findById(next, "en-c1") as DirectiveNode;
  assert.equal(note.name, "endnote");
  assert.equal(note.attrs.for, "c1");
  assert.equal(note.attrs.label, "Review note");
});

test("patch: add_change_request inserts a tracked review request after the target block", () => {
  const doc = parse(sample);
  const next = patch(doc, {
    op: "add_change_request",
    id: "cr-c1",
    target: "c1",
    action: "replace",
    from: "old body",
    to: "new body",
    content: "Use the stronger wording before Word handoff.",
    author: "Research",
    date: "2026-05-24T11:00:00Z",
  });
  const change = findById(next, "cr-c1") as DirectiveNode;
  assert.equal(change.name, "change_request");
  assert.equal(change.attrs.target, "c1");
  assert.equal(change.attrs.action, "replace");
  assert.equal(change.attrs.from, "old body");
  assert.equal(change.attrs.to, "new body");
  assert.match(renderNoma(next), /::claim\{id="c1" confidence=0\.5\}\nold body\n::\n\n::change_request\{id="cr-c1" target="c1" action="replace" from="old body" to="new body" author="Research" date="2026-05-24T11:00:00Z"\}/);
});

test("patch: add_change_request rejects incomplete revision text", () => {
  const doc = parse(sample);
  assert.throws(
    () => patch(doc, { op: "add_change_request", id: "cr-c1", target: "c1", action: "replace", from: "old" }),
    PatchError,
  );
});

test("patch: update_table_cell updates an ID-bearing table directive", () => {
  const doc = parse(`::table{id="metrics" header}\n| Metric | Value |\n| ARR | 10m |\n| NRR | 120% |\n::\n`);
  const next = patch(doc, {
    op: "update_table_cell",
    id: "metrics",
    row: 1,
    column: "Value",
    value: "125%",
  });
  const table = findById(next, "metrics") as DirectiveNode;
  assert.match(table.body ?? "", /\| NRR \| 125% \|/);
  assert.match(renderHtml(next), /<td>125%<\/td>/);
});

test("patch: update_table_header_cell updates an ID-bearing table directive header", () => {
  const doc = parse(`::table{id="metrics" header}\n| Metric | Value |\n| ARR | 10m |\n::\n`);
  const next = patch(doc, {
    op: "update_table_header_cell",
    id: "metrics",
    column: "Value",
    value: "Revenue",
  });
  const table = findById(next, "metrics") as DirectiveNode;
  assert.match(table.body ?? "", /\| Metric \| Revenue \|/);
  assert.match(renderHtml(next), /<th>Revenue<\/th>/);
});

test("patch: insert_table_row inserts a body row in an ID-bearing table directive", () => {
  const doc = parse(`::table{id="metrics" header}\n| Metric | Value |\n| ARR | 10m |\n::\n`);
  const next = patch(doc, {
    op: "insert_table_row",
    id: "metrics",
    row: 1,
    cells: ["NRR", "120%"],
  });
  const table = findById(next, "metrics") as DirectiveNode;
  assert.match(table.body ?? "", /\| ARR \| 10m \|\n\| NRR \| 120% \|/);
  assert.match(renderHtml(next), /<td>NRR<\/td>/);
});

test("patch: delete_table_row deletes a body row in an ID-bearing table directive", () => {
  const doc = parse(`::table{id="metrics" header}\n| Metric | Value |\n| ARR | 10m |\n| NRR | 120% |\n::\n`);
  const next = patch(doc, {
    op: "delete_table_row",
    id: "metrics",
    row: 0,
  });
  const table = findById(next, "metrics") as DirectiveNode;
  assert.doesNotMatch(table.body ?? "", /ARR/);
  assert.match(table.body ?? "", /\| Metric \| Value \|\n\| NRR \| 120% \|/);
});

test("patch: insert_table_column inserts a column in an ID-bearing table directive", () => {
  const doc = parse(`::table{id="metrics" header}\n| Metric | Value |\n| ARR | 10m |\n| NRR | 120% |\n::\n`);
  const next = patch(doc, {
    op: "insert_table_column",
    id: "metrics",
    column: 1,
    header: "Owner",
    cells: ["Finance", "Sales"],
  });
  const table = findById(next, "metrics") as DirectiveNode;
  assert.match(table.body ?? "", /\| Metric \| Owner \| Value \|\n\| ARR \| Finance \| 10m \|\n\| NRR \| Sales \| 120% \|/);
  assert.match(renderHtml(next), /<th>Owner<\/th>/);
});

test("patch: delete_table_column deletes a column by header label", () => {
  const doc = parse(`::table{id="metrics" header}\n| Metric | Owner | Value |\n| ARR | Finance | 10m |\n| NRR | Sales | 120% |\n::\n`);
  const next = patch(doc, {
    op: "delete_table_column",
    id: "metrics",
    column: "Owner",
  });
  const table = findById(next, "metrics") as DirectiveNode;
  assert.doesNotMatch(table.body ?? "", /Owner|Finance|Sales/);
  assert.match(table.body ?? "", /\| Metric \| Value \|\n\| ARR \| 10m \|\n\| NRR \| 120% \|/);
});

test("patch: update_dataset_cell updates an ID-bearing dataset directive", () => {
  const doc = parse(`::dataset{id="scores"}\nschema:\n  vertical: string\n  score: number\nrows:\n  - [legal, 18]\n  - [finance, 24]\n::\n`);
  const next = patch(doc, {
    op: "update_dataset_cell",
    id: "scores",
    row: 1,
    column: "score",
    value: "25",
  });
  const dataset = findById(next, "scores") as DirectiveNode;
  assert.match(dataset.body ?? "", /- \[finance, 25\]/);
  assert.match(renderHtml(next), /<pre>schema:/);
});

test("patch: insert_dataset_row inserts a typed dataset row", () => {
  const doc = parse(`::dataset{id="scores"}\nschema:\n  vertical: string\n  score: number\nrows:\n  - [legal, 18]\n::\n`);
  const next = patch(doc, {
    op: "insert_dataset_row",
    id: "scores",
    row: 1,
    cells: ["finance", "24"],
  });
  const dataset = findById(next, "scores") as DirectiveNode;
  assert.match(dataset.body ?? "", /- \[finance, 24\]/);
});

test("patch: delete_dataset_row deletes a dataset row", () => {
  const doc = parse(`::dataset{id="scores"}\nschema:\n  vertical: string\n  score: number\nrows:\n  - [legal, 18]\n  - [finance, 24]\n::\n`);
  const next = patch(doc, { op: "delete_dataset_row", id: "scores", row: 0 });
  const dataset = findById(next, "scores") as DirectiveNode;
  assert.doesNotMatch(dataset.body ?? "", /legal/);
  assert.match(dataset.body ?? "", /- \[finance, 24\]/);
});

test("patch: insert_dataset_column inserts a typed dataset column", () => {
  const doc = parse(`::dataset{id="scores"}\nschema:\n  vertical: string\n  score: number\nrows:\n  - [legal, 18]\n::\n`);
  const next = patch(doc, {
    op: "insert_dataset_column",
    id: "scores",
    column: 1,
    header: "owner",
    cells: ["Research"],
  });
  const dataset = findById(next, "scores") as DirectiveNode;
  assert.match(dataset.body ?? "", /owner: string/);
  assert.match(dataset.body ?? "", /- \[legal, Research, 18\]/);
});

test("patch: delete_dataset_column deletes a dataset column", () => {
  const doc = parse(`::dataset{id="scores"}\nschema:\n  vertical: string\n  owner: string\n  score: number\nrows:\n  - [legal, Research, 18]\n::\n`);
  const next = patch(doc, { op: "delete_dataset_column", id: "scores", column: "owner" });
  const dataset = findById(next, "scores") as DirectiveNode;
  assert.doesNotMatch(dataset.body ?? "", /owner|Research/);
  assert.match(dataset.body ?? "", /- \[legal, 18\]/);
});

test("patch: update_table_cell rejects non-table blocks", () => {
  const doc = parse(sample);
  assert.throws(
    () => patch(doc, { op: "update_table_cell", id: "c1", row: 0, column: 0, value: "x" }),
    PatchError,
  );
});

test("patch: update_dataset_cell rejects non-dataset blocks", () => {
  const doc = parse(sample);
  assert.throws(
    () => patch(doc, { op: "update_dataset_cell", id: "c1", row: 0, column: 0, value: "x" }),
    PatchError,
  );
});

test("patch: insert_dataset_row rejects non-dataset blocks", () => {
  const doc = parse(sample);
  assert.throws(
    () => patch(doc, { op: "insert_dataset_row", id: "c1", row: 0, cells: ["x"] }),
    PatchError,
  );
});

test("patch: insert_table_row rejects non-table blocks", () => {
  const doc = parse(sample);
  assert.throws(
    () => patch(doc, { op: "insert_table_row", id: "c1", row: 0, cells: ["x"] }),
    PatchError,
  );
});

test("patch: delete_table_row rejects out-of-range rows", () => {
  const doc = parse(`::table{id="metrics" header}\n| Metric | Value |\n| ARR | 10m |\n::\n`);
  assert.throws(
    () => patch(doc, { op: "delete_table_row", id: "metrics", row: 1 }),
    PatchError,
  );
});

test("patch: insert_table_column rejects headers on headerless tables", () => {
  const doc = parse(`::table{id="scores"}\n| Alice | 3 |\n| Bob | 4 |\n::\n`);
  assert.throws(
    () => patch(doc, { op: "insert_table_column", id: "scores", column: 1, header: "Score", cells: ["5"] }),
    PatchError,
  );
});

test("patch: delete_table_column rejects deleting the last column", () => {
  const doc = parse(`::table{id="metrics" header}\n| Metric |\n| ARR |\n::\n`);
  assert.throws(
    () => patch(doc, { op: "delete_table_column", id: "metrics", column: 0 }),
    PatchError,
  );
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
