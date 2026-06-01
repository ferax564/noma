import { test } from "node:test";
import assert from "node:assert/strict";
import { PatchError, patchSource } from "../src/patch.js";

const sample = `---
title: Demo
date: 2026-05-09
tags: [a, b]
---

# Heading

Intro paragraph.

::claim{id="c1" confidence=0.5}
old body
::

::evidence{for="c1"}
ev
::

See [[c1]].
`;

test("patchSource: update_attribute preserves frontmatter byte-for-byte", () => {
  const out = patchSource(sample, {
    op: "update_attribute",
    id: "c1",
    key: "confidence",
    value: 0.95,
  });
  assert.match(out, /^---\ntitle: Demo\ndate: 2026-05-09\ntags: \[a, b\]\n---/);
  assert.match(out, /confidence=0\.95/);
  assert.doesNotMatch(out, /confidence=0\.5\b/);
  // Sibling block + body untouched.
  assert.match(out, /old body/);
  assert.match(out, /::evidence\{for="c1"\}/);
});

test("patchSource: update_attribute appends a new attr", () => {
  const out = patchSource(sample, {
    op: "update_attribute",
    id: "c1",
    key: "owner",
    value: "alice",
  });
  assert.match(out, /::claim\{id="c1" confidence=0\.5 owner="alice"\}/);
});

test("patchSource: remove_attribute rewrites only the directive opener", () => {
  const out = patchSource(sample, { op: "remove_attribute", id: "c1", key: "confidence" });
  assert.match(out, /::claim\{id="c1"\}\nold body\n::/);
  assert.match(out, /::evidence\{for="c1"\}/);
});

test("patchSource: remove_attribute rejects id changes", () => {
  assert.throws(
    () => patchSource(sample, { op: "remove_attribute", id: "c1", key: "id" }),
    PatchError,
  );
});

test("patchSource: replace_block keeps surrounding bytes", () => {
  const out = patchSource(sample, {
    op: "replace_block",
    id: "c1",
    content: `::claim{id="c1" confidence=0.99}\nfresh body\n::`,
  });
  assert.match(out, /^---\ntitle: Demo/);
  assert.match(out, /fresh body/);
  assert.doesNotMatch(out, /old body/);
  assert.match(out, /::evidence\{for="c1"\}\nev\n::/);
});

test("patchSource: replace_body rewrites only directive body lines", () => {
  const out = patchSource(sample, {
    op: "replace_body",
    id: "c1",
    content: "fresh body\nsecond line",
  });
  assert.match(out, /::claim\{id="c1" confidence=0\.5\}\nfresh body\nsecond line\n::/);
  assert.match(out, /^---\ntitle: Demo\ndate: 2026-05-09\ntags: \[a, b\]\n---/);
  assert.match(out, /::evidence\{for="c1"\}\nev\n::/);
  assert.doesNotMatch(out, /old body/);
});

test("patchSource: replace_body rejects directives with child blocks", () => {
  const src = `::grid{id="g"}\n:::card{id="a"}\na\n:::\n::\n`;
  assert.throws(
    () => patchSource(src, { op: "replace_body", id: "g", content: "x" }),
    /has child blocks/,
  );
});

test("patchSource: update_heading changes title and pins old slug as explicit id", () => {
  const src = `# Old Title\n\n::claim{id="c"}\na\n::\n`;
  const out = patchSource(src, { op: "update_heading", id: "old-title", title: "New Title" });
  assert.match(out, /^# New Title \{id="old-title"\}/);
  assert.match(out, /::claim\{id="c"\}\na\n::/);
});

test("patchSource: update_heading preserves existing heading aliases", () => {
  const src = `# Old Title {aliases="legacy"}\n\nBody.\n`;
  const out = patchSource(src, { op: "update_heading", id: "old-title", title: "New Title" });
  assert.match(out, /^# New Title \{aliases="legacy" id="old-title"\}/);
});

test("patchSource: add_comment inserts a targeted comment without rewriting siblings", () => {
  const out = patchSource(sample, {
    op: "add_comment",
    id: "comment-c1",
    target: "c1",
    content: "Check the claim before handoff.",
    author: "Research",
  });
  assert.match(out, /::claim\{id="c1" confidence=0\.5\}\nold body\n::\n\n::comment\{id="comment-c1" parent="c1" author="Research"\}\nCheck the claim before handoff\.\n::\n\n::evidence\{for="c1"\}/);
  assert.match(out, /^---\ntitle: Demo\ndate: 2026-05-09\ntags: \[a, b\]\n---/);
});

test("patchSource: add_comment inserts a section comment after the heading", () => {
  const src = `# Heading\n\nBody.\n`;
  const out = patchSource(src, {
    op: "add_comment",
    id: "comment-heading",
    target: "heading",
    content: "Review this section.",
  });
  assert.match(out, /^# Heading\n\n::comment\{id="comment-heading" parent="heading"\}\nReview this section\.\n::\n\nBody\./);
});

test("patchSource: add_comment matches nested directive fence depth", () => {
  const src = `::header
:::claim{id="header-claim"}
Header claim.
:::
::
`;
  const out = patchSource(src, {
    op: "add_comment",
    id: "comment-header-claim",
    target: "header-claim",
    content: "Check the running header.",
  });
  assert.match(out, /:::claim\{id="header-claim"\}\nHeader claim\.\n:::\n\n:::comment\{id="comment-header-claim" parent="header-claim"\}\nCheck the running header\.\n:::\n::/);
});

test("patchSource: add_comment can insert a threaded reply", () => {
  const src = `# Review

::claim{id="c1"}
Claim.
::

::comment{id="comment-c1" parent="c1"}
Check this claim.
::
`;
  const out = patchSource(src, {
    op: "add_comment",
    id: "comment-c1-reply",
    target: "comment-c1",
    reply_to: "comment-c1",
    content: "Confirmed.",
    author: "Research",
  });
  assert.match(out, /::comment\{id="comment-c1" parent="c1"\}\nCheck this claim\.\n::\n\n::comment\{id="comment-c1-reply" reply_to="comment-c1" author="Research"\}\nConfirmed\.\n::/);
});

test("patchSource: resolve_comment rewrites only the comment opener", () => {
  const src = `::claim{id="c1" confidence=0.5}\nClaim body.\n::\n\n::comment{id="comment-c1" parent="c1" author="Research"}\nCheck this.\n::\n\n::evidence{for="c1"}\nEvidence.\n::\n`;
  const out = patchSource(src, {
    op: "resolve_comment",
    id: "comment-c1",
    resolved_by: "Andrea",
    resolved_at: "2026-05-24T10:00:00Z",
  });
  assert.match(out, /::comment\{id="comment-c1" parent="c1" author="Research" status="resolved" resolved_by="Andrea" resolved_at="2026-05-24T10:00:00Z"\}\nCheck this\.\n::/);
  assert.match(out, /^::claim\{id="c1" confidence=0\.5\}\nClaim body\.\n::/);
  assert.match(out, /::evidence\{for="c1"\}\nEvidence\.\n::\n$/);
});

test("patchSource: resolve_comment rejects non-comment blocks", () => {
  assert.throws(
    () => patchSource(sample, { op: "resolve_comment", id: "c1" }),
    /not a comment/,
  );
});

test("patchSource: add_footnote inserts a targeted footnote without rewriting siblings", () => {
  const out = patchSource(sample, {
    op: "add_footnote",
    id: "fn-c1",
    target: "c1",
    content: "Clarify this claim for committee review.",
  });
  assert.match(out, /::claim\{id="c1" confidence=0\.5\}\nold body\n::\n\n::footnote\{id="fn-c1" for="c1"\}\nClarify this claim for committee review\.\n::\n\n::evidence\{for="c1"\}/);
});

test("patchSource: add_endnote inserts a section endnote after the heading", () => {
  const src = `# Heading\n\nBody.\n`;
  const out = patchSource(src, {
    op: "add_endnote",
    id: "en-heading",
    target: "heading",
    content: "Keep this note at the end.",
    label: "Review note",
  });
  assert.match(out, /^# Heading\n\n::endnote\{id="en-heading" for="heading" label="Review note"\}\nKeep this note at the end\.\n::\n\nBody\./);
});

test("patchSource: add_footnote matches nested directive fence depth", () => {
  const src = `::footer
:::claim{id="footer-claim"}
Footer claim.
:::
::
`;
  const out = patchSource(src, {
    op: "add_footnote",
    id: "fn-footer-claim",
    target: "footer-claim",
    content: "Clarify footer claim.",
  });
  assert.match(out, /:::claim\{id="footer-claim"\}\nFooter claim\.\n:::\n\n:::footnote\{id="fn-footer-claim" for="footer-claim"\}\nClarify footer claim\.\n:::\n::/);
});

test("patchSource: add_change_request inserts a tracked review request without rewriting siblings", () => {
  const out = patchSource(sample, {
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
  assert.match(out, /::claim\{id="c1" confidence=0\.5\}\nold body\n::\n\n::change_request\{id="cr-c1" target="c1" action="replace" from="old body" to="new body" author="Research" date="2026-05-24T11:00:00Z"\}\nUse the stronger wording before Word handoff\.\n::\n\n::evidence\{for="c1"\}/);
  assert.match(out, /^---\ntitle: Demo\ndate: 2026-05-09\ntags: \[a, b\]\n---/);
});

test("patchSource: add_change_request inserts a section request after the heading", () => {
  const src = `# Heading\n\nBody.\n`;
  const out = patchSource(src, {
    op: "add_change_request",
    id: "cr-heading",
    target: "heading",
    action: "insert",
    to: "Opening sentence.",
  });
  assert.match(out, /^# Heading\n\n::change_request\{id="cr-heading" target="heading" action="insert" to="Opening sentence\."\}\n::\n\nBody\./);
});

test("patchSource: add_change_request matches nested directive fence depth", () => {
  const src = `::footer
:::claim{id="footer-claim"}
Footer claim.
:::
::
`;
  const out = patchSource(src, {
    op: "add_change_request",
    id: "cr-footer-claim",
    target: "footer-claim",
    action: "replace",
    from: "Footer claim.",
    to: "Footer claim updated.",
  });
  assert.match(out, /:::claim\{id="footer-claim"\}\nFooter claim\.\n:::\n\n:::change_request\{id="cr-footer-claim" target="footer-claim" action="replace" from="Footer claim\." to="Footer claim updated\."\}\n:::\n::/);
});

test("patchSource: add_change_request rejects incomplete revision text", () => {
  assert.throws(
    () => patchSource(sample, { op: "add_change_request", id: "cr-c1", target: "c1", action: "delete" }),
    /requires from or text/,
  );
});

test("patchSource: update_table_cell rewrites only the addressed table row", () => {
  const src = `::table{id="metrics" header align="-,r"}\n| Metric | Value |\n| ARR | 10m |\n| NRR | 120% |\n::\n\nAfter.\n`;
  const out = patchSource(src, {
    op: "update_table_cell",
    id: "metrics",
    row: 1,
    column: "Value",
    value: "125% | audited",
  });
  assert.match(out, /^::table\{id="metrics" header align="-,r"\}\n\| Metric \| Value \|\n\| ARR \| 10m \|\n\| NRR \| 125% \\\| audited \|\n::\n\nAfter\.\n$/);
});

test("patchSource: update_table_header_cell rewrites only the header row", () => {
  const src = `::table{id="metrics" header align="-,r"}\n  | Metric | Value |\n  | ARR | 10m |\n::\n\nAfter.\n`;
  const out = patchSource(src, {
    op: "update_table_header_cell",
    id: "metrics",
    column: "Metric",
    value: "Metric | KPI",
  });
  assert.match(out, /^::table\{id="metrics" header align="-,r"\}\n  \| Metric \\\| KPI \| Value \|\n  \| ARR \| 10m \|\n::\n\nAfter\.\n$/);
});

test("patchSource: update_table_cell preserves pipes inside code spans", () => {
  const src = `::table{id="metrics" header}\n| Metric | Value |\n| ARR | old |\n::\n\nAfter.\n`;
  const codeOut = patchSource(src, {
    op: "update_table_cell",
    id: "metrics",
    row: 0,
    column: "Value",
    value: "`code|value`",
  });
  const plainOut = patchSource(src, {
    op: "update_table_cell",
    id: "metrics",
    row: 0,
    column: "Value",
    value: "plain|value",
  });

  assert.ok(codeOut.includes("| ARR | `code|value` |"));
  assert.ok(plainOut.includes("| ARR | plain\\|value |"));
});

test("patchSource: update_table_cell supports numeric columns without a header", () => {
  const src = `::table{id="scores"}\n| Alice | 3 |\n| Bob | 4 |\n::\n`;
  const out = patchSource(src, {
    op: "update_table_cell",
    id: "scores",
    row: 0,
    column: 1,
    value: "5",
  });
  assert.match(out, /::table\{id="scores"\}\n\| Alice \| 5 \|\n\| Bob \| 4 \|\n::/);
});

test("patchSource: update_table_cell rejects missing table columns", () => {
  const src = `::table{id="metrics" header}\n| Metric | Value |\n| ARR | 10m |\n::\n`;
  assert.throws(
    () => patchSource(src, { op: "update_table_cell", id: "metrics", row: 0, column: "Missing", value: "x" }),
    /not found/,
  );
});

test("patchSource: update_table_header_cell rejects headerless tables", () => {
  const src = `::table{id="scores"}\n| Alice | 3 |\n::\n`;
  assert.throws(
    () => patchSource(src, { op: "update_table_header_cell", id: "scores", column: 0, value: "Name" }),
    /requires header=true/,
  );
});

test("patchSource: insert_table_row inserts one serialized row", () => {
  const src = `::table{id="metrics" header}\n| Metric | Value |\n| ARR | 10m |\n::\n\nAfter.\n`;
  const out = patchSource(src, {
    op: "insert_table_row",
    id: "metrics",
    row: 1,
    cells: ["NRR", "120% | audited"],
  });
  assert.match(out, /^::table\{id="metrics" header\}\n\| Metric \| Value \|\n\| ARR \| 10m \|\n\| NRR \| 120% \\\| audited \|\n::\n\nAfter\.\n$/);
});

test("patchSource: insert_table_row can insert into a header-only table", () => {
  const src = `::table{id="metrics" header}\n| Metric | Value |\n::\n`;
  const out = patchSource(src, {
    op: "insert_table_row",
    id: "metrics",
    row: 0,
    cells: ["ARR", "10m"],
  });
  assert.match(out, /::table\{id="metrics" header\}\n\| Metric \| Value \|\n\| ARR \| 10m \|\n::/);
});

test("patchSource: delete_table_row deletes only the addressed body row", () => {
  const src = `::table{id="metrics" header}\n| Metric | Value |\n| ARR | 10m |\n| NRR | 120% |\n::\n\nAfter.\n`;
  const out = patchSource(src, {
    op: "delete_table_row",
    id: "metrics",
    row: 0,
  });
  assert.match(out, /^::table\{id="metrics" header\}\n\| Metric \| Value \|\n\| NRR \| 120% \|\n::\n\nAfter\.\n$/);
});

test("patchSource: delete_table_row rejects out-of-range rows", () => {
  const src = `::table{id="metrics" header}\n| Metric | Value |\n| ARR | 10m |\n::\n`;
  assert.throws(
    () => patchSource(src, { op: "delete_table_row", id: "metrics", row: 2 }),
    /out of range/,
  );
});

test("patchSource: insert_table_column rewrites only table row lines", () => {
  const src = `::table{id="metrics" header}\n  | Metric | Value |\n  | ARR | 10m |\n  | NRR | 120% |\n::\n\nAfter.\n`;
  const out = patchSource(src, {
    op: "insert_table_column",
    id: "metrics",
    column: 1,
    header: "Owner | Team",
    cells: ["Finance", "Sales"],
  });
  assert.match(out, /^::table\{id="metrics" header\}\n  \| Metric \| Owner \\\| Team \| Value \|\n  \| ARR \| Finance \| 10m \|\n  \| NRR \| Sales \| 120% \|\n::\n\nAfter\.\n$/);
});

test("patchSource: insert_table_column pads missing cells", () => {
  const src = `::table{id="metrics" header}\n| Metric | Value |\n| ARR | 10m |\n| NRR | 120% |\n::\n`;
  const out = patchSource(src, {
    op: "insert_table_column",
    id: "metrics",
    column: 2,
    header: "Owner",
    cells: ["Finance"],
  });
  assert.match(out, /::table\{id="metrics" header\}\n\| Metric \| Value \| Owner \|\n\| ARR \| 10m \| Finance \|\n\| NRR \| 120% \|  \|\n::/);
});

test("patchSource: delete_table_column deletes by header label", () => {
  const src = `::table{id="metrics" header}\n| Metric | Owner | Value |\n| ARR | Finance | 10m |\n| NRR | Sales | 120% |\n::\n\nAfter.\n`;
  const out = patchSource(src, {
    op: "delete_table_column",
    id: "metrics",
    column: "Owner",
  });
  assert.match(out, /^::table\{id="metrics" header\}\n\| Metric \| Value \|\n\| ARR \| 10m \|\n\| NRR \| 120% \|\n::\n\nAfter\.\n$/);
});

test("patchSource: delete_table_column rejects deleting the last column", () => {
  const src = `::table{id="metrics" header}\n| Metric |\n| ARR |\n::\n`;
  assert.throws(
    () => patchSource(src, { op: "delete_table_column", id: "metrics", column: 0 }),
    /last table column/,
  );
});

test("patchSource: insert_table_column rejects too many cells", () => {
  const src = `::table{id="metrics" header}\n| Metric | Value |\n| ARR | 10m |\n::\n`;
  assert.throws(
    () => patchSource(src, { op: "insert_table_column", id: "metrics", column: 1, header: "Owner", cells: ["A", "B"] }),
    /exceed row count/,
  );
});

test("patchSource: update_dataset_cell rewrites only the addressed YAML row", () => {
  const src = `::dataset{id="scores"}\nsource_note: analyst-maintained ordering\nschema:\n  vertical: string\n  score: number\nrows:\n  - [legal, 18]\n  - [finance, 24] # keep row note\n::\n\nAfter.\n`;
  const out = patchSource(src, {
    op: "update_dataset_cell",
    id: "scores",
    row: 1,
    column: "score",
    value: "25",
  });
  assert.match(out, /^::dataset\{id="scores"\}\nsource_note: analyst-maintained ordering\nschema:\n  vertical: string\n  score: number\nrows:\n  - \[legal, 18\]\n  - \[finance, 25\] # keep row note\n::\n\nAfter\.\n$/);
});

test("patchSource: insert_dataset_row preserves surrounding YAML dataset body", () => {
  const src = `::dataset{id="scores"}\nsource_note: analyst-maintained ordering\nschema:\n  vertical: string\n  score: number\nrows:\n  - [legal, 18]\n  - [finance, 24] # keep row note\n::\n`;
  const out = patchSource(src, {
    op: "insert_dataset_row",
    id: "scores",
    row: 1,
    cells: ["energy", "21"],
  });
  assert.match(out, /source_note: analyst-maintained ordering/);
  assert.match(out, /  - \[legal, 18\]\n  - \[energy, 21\]\n  - \[finance, 24\] # keep row note/);
});

test("patchSource: delete_dataset_row preserves YAML schema and comments", () => {
  const src = `::dataset{id="scores"}\nschema:\n  vertical: string\n  score: number\nrows:\n  - [legal, 18]\n  - [finance, 24] # keep row note\n::\n`;
  const out = patchSource(src, { op: "delete_dataset_row", id: "scores", row: 0 });
  assert.match(out, /schema:\n  vertical: string\n  score: number/);
  assert.doesNotMatch(out, /\[legal, 18\]/);
  assert.match(out, /  - \[finance, 24\] # keep row note/);
});

test("patchSource: insert_dataset_column preserves surrounding YAML dataset body", () => {
  const src = `::dataset{id="scores"}\nsource_note: analyst-maintained ordering\nschema:\n  vertical: string\n  score: number\nrows:\n  - [legal, 18]\n  - [finance, 24] # keep row note\n::\n`;
  const out = patchSource(src, {
    op: "insert_dataset_column",
    id: "scores",
    column: 1,
    header: "owner",
    cells: ["Research", "Finance"],
  });
  assert.match(out, /source_note: analyst-maintained ordering/);
  assert.match(out, /schema:\n  vertical: string\n  owner: string\n  score: number/);
  assert.match(out, /  - \[legal, Research, 18\]\n  - \[finance, Finance, 24\] # keep row note/);
});

test("patchSource: delete_dataset_column preserves YAML row comments", () => {
  const src = `::dataset{id="scores"}\nschema:\n  vertical: string\n  owner: string\n  score: number\nrows:\n  - [legal, Research, 18]\n  - [finance, Finance, 24] # keep row note\n::\n`;
  const out = patchSource(src, { op: "delete_dataset_column", id: "scores", column: "owner" });
  assert.doesNotMatch(out, /owner|Research|Finance, 24/);
  assert.match(out, /schema:\n  vertical: string\n  score: number/);
  assert.match(out, /  - \[finance, 24\] # keep row note/);
});

test("patchSource: update_dataset_cell supports CSV datasets", () => {
  const src = `::dataset{id="scores" format="csv"}\nvertical,score\nlegal,18\nfinance,24\n::\n`;
  const out = patchSource(src, {
    op: "update_dataset_cell",
    id: "scores",
    row: 0,
    column: "score",
    value: "19",
  });
  assert.match(out, /::dataset\{id="scores" format="csv"\}\nvertical,score\nlegal,19\nfinance,24\n::/);
});

test("patchSource: update_dataset_cell quotes CSV cells containing commas and quotes", () => {
  const src = `::dataset{id="scores" format="csv"}\nvertical,region,score\nlegal,"North, America",18\nfinance,EMEA,24\n::\n`;
  const out = patchSource(src, {
    op: "update_dataset_cell",
    id: "scores",
    row: 1,
    column: "region",
    value: `APAC, "Strategic"`,
  });
  assert.match(out, /legal,"North, America",18/);
  assert.match(out, /finance,"APAC, ""Strategic""",24/);
});

test("patchSource: insert_dataset_row supports CSV datasets", () => {
  const src = `::dataset{id="scores" format="csv"}\nvertical,score\nlegal,18\nfinance,24\n::\n`;
  const out = patchSource(src, {
    op: "insert_dataset_row",
    id: "scores",
    row: 1,
    cells: ["energy", "21"],
  });
  assert.match(out, /vertical,score\nlegal,18\nenergy,21\nfinance,24/);
});

test("patchSource: insert_dataset_row quotes CSV cells containing delimiters", () => {
  const src = `::dataset{id="scores" format="csv"}\nvertical,region,score\nlegal,NA,18\nfinance,EMEA,24\n::\n`;
  const out = patchSource(src, {
    op: "insert_dataset_row",
    id: "scores",
    row: 1,
    cells: ["energy", "North, America", "21"],
  });
  assert.match(out, /legal,NA,18\nenergy,"North, America",21\nfinance,EMEA,24/);
});

test("patchSource: delete_dataset_row supports CSV datasets", () => {
  const src = `::dataset{id="scores" format="csv"}\nvertical,score\nlegal,18\nfinance,24\n::\n`;
  const out = patchSource(src, { op: "delete_dataset_row", id: "scores", row: 1 });
  assert.match(out, /vertical,score\nlegal,18\n::/);
  assert.doesNotMatch(out, /finance,24/);
});

test("patchSource: insert_dataset_column supports CSV datasets", () => {
  const src = `::dataset{id="scores" format="csv"}\nvertical,score\nlegal,18\nfinance,24\n::\n`;
  const out = patchSource(src, {
    op: "insert_dataset_column",
    id: "scores",
    column: 1,
    header: "owner",
    cells: ["Research", "Finance"],
  });
  assert.match(out, /vertical,owner,score\nlegal,Research,18\nfinance,Finance,24/);
});

test("patchSource: insert_dataset_column quotes delimited dataset cells when needed", () => {
  const src = `::dataset{id="scores" format="tsv"}\nvertical\tscore\nlegal\t18\nfinance\t24\n::\n`;
  const out = patchSource(src, {
    op: "insert_dataset_column",
    id: "scores",
    column: 1,
    header: "region",
    cells: ["North\tAmerica", "EMEA"],
  });
  assert.match(out, /vertical\tregion\tscore\nlegal\t"North\tAmerica"\t18\nfinance\tEMEA\t24/);
});

test("patchSource: delete_dataset_column supports CSV datasets", () => {
  const src = `::dataset{id="scores" format="csv"}\nvertical,owner,score\nlegal,Research,18\nfinance,Finance,24\n::\n`;
  const out = patchSource(src, { op: "delete_dataset_column", id: "scores", column: "owner" });
  assert.match(out, /vertical,score\nlegal,18\nfinance,24/);
  assert.doesNotMatch(out, /owner|Research/);
});

test("patchSource: update_dataset_cell supports JSON row-array datasets", () => {
  const src = `::dataset{id="scores" format="json"}\n{\n  "source_note": "keep this note",\n  "columns": ["vertical", "score"],\n  "rows": [\n    ["legal", 18],\n    ["finance", 24]\n  ]\n}\n::\n`;
  const out = patchSource(src, {
    op: "update_dataset_cell",
    id: "scores",
    row: 1,
    column: "score",
    value: "25",
  });
  assert.match(out, /"source_note": "keep this note"/);
  assert.match(out, /\["finance",25\]/);
  assert.doesNotMatch(out, /"rows": \[\n    \[\n      "legal"/);
});

test("patchSource: insert_dataset_row supports JSON row-array datasets", () => {
  const src = `::dataset{id="scores" format="json"}\n{\n  "source_note": "keep this note",\n  "columns": ["vertical", "score"],\n  "rows": [\n    ["legal", 18],\n    ["finance", 24]\n  ]\n}\n::\n`;
  const out = patchSource(src, {
    op: "insert_dataset_row",
    id: "scores",
    row: 2,
    cells: ["energy", "21"],
  });
  assert.match(out, /"source_note": "keep this note"/);
  assert.match(out, /\["finance", 24\],\n    \["energy",21\]\n  \]/);
});

test("patchSource: delete_dataset_row supports JSON row-array datasets", () => {
  const src = `::dataset{id="scores" format="json"}\n{\n  "columns": ["vertical", "score"],\n  "rows": [\n    ["legal", 18],\n    ["finance", 24]\n  ]\n}\n::\n`;
  const out = patchSource(src, { op: "delete_dataset_row", id: "scores", row: 1 });
  assert.match(out, /\["legal", 18\]\n  \]/);
  assert.doesNotMatch(out, /finance/);
});

test("patchSource: insert_dataset_column supports JSON row-array datasets", () => {
  const src = `::dataset{id="scores" format="json"}\n{\n  "source_note": "keep this note",\n  "columns": ["vertical", "score"],\n  "rows": [\n    ["legal", 18],\n    ["finance", 24]\n  ]\n}\n::\n`;
  const out = patchSource(src, {
    op: "insert_dataset_column",
    id: "scores",
    column: 1,
    header: "owner",
    cells: ["Research", "Finance"],
  });
  assert.match(out, /"source_note": "keep this note"/);
  assert.match(out, /"columns": \["vertical","owner","score"\]/);
  assert.match(out, /\["legal","Research",18\]/);
});

test("patchSource: delete_dataset_column supports JSON row-array datasets", () => {
  const src = `::dataset{id="scores" format="json"}\n{\n  "columns": ["vertical", "owner", "score"],\n  "rows": [\n    ["legal", "Research", 18],\n    ["finance", "Finance", 24]\n  ]\n}\n::\n`;
  const out = patchSource(src, { op: "delete_dataset_column", id: "scores", column: "owner" });
  assert.match(out, /"columns": \["vertical","score"\]/);
  assert.match(out, /\["finance",24\]/);
  assert.doesNotMatch(out, /Research|Owner/);
});

test("patchSource: update_dataset_cell supports JSON record-array datasets", () => {
  const src = `::dataset{id="scores" format="json"}\n[\n  { "vertical": "legal", "score": 18 },\n  { "vertical": "finance", "score": 24 }\n]\n::\n`;
  const out = patchSource(src, {
    op: "update_dataset_cell",
    id: "scores",
    row: 1,
    column: "score",
    value: "25",
  });
  assert.match(out, /\{ "vertical": "finance", "score": 25 \}/);
  assert.match(out, /\{ "vertical": "legal", "score": 18 \}/);
});

test("patchSource: insert_dataset_row supports JSON record-array datasets", () => {
  const src = `::dataset{id="scores" format="json"}\n[\n  { "vertical": "legal", "score": 18 },\n  { "vertical": "finance", "score": 24 }\n]\n::\n`;
  const out = patchSource(src, {
    op: "insert_dataset_row",
    id: "scores",
    row: 1,
    cells: ["energy", "21"],
  });
  assert.match(out, /\{ "vertical": "legal", "score": 18 \},\n  \{ "vertical": "energy", "score": 21 \},\n  \{ "vertical": "finance", "score": 24 \}/);
});

test("patchSource: delete_dataset_row supports JSON record-array datasets", () => {
  const src = `::dataset{id="scores" format="json"}\n[\n  { "vertical": "legal", "score": 18 },\n  { "vertical": "finance", "score": 24 }\n]\n::\n`;
  const out = patchSource(src, { op: "delete_dataset_row", id: "scores", row: 1 });
  assert.match(out, /\[\n  \{ "vertical": "legal", "score": 18 \}\n\]/);
  assert.doesNotMatch(out, /finance/);
});

test("patchSource: insert_dataset_row preserves multiline JSON record style", () => {
  const src = `::dataset{id="scores" format="json"}\n[\n  {\n    "vertical": "legal",\n    "score": 18\n  },\n  {\n    "vertical": "finance",\n    "score": 24\n  }\n]\n::\n`;
  const out = patchSource(src, {
    op: "insert_dataset_row",
    id: "scores",
    row: 1,
    cells: ["energy", "21"],
  });
  assert.match(out, /  \{\n    "vertical": "energy",\n    "score": 21\n  \},/);
  assert.match(out, /"vertical": "finance"/);
});

test("patchSource: insert_dataset_column supports JSON record-array datasets", () => {
  const src = `::dataset{id="scores" format="json"}\n[\n  { "vertical": "legal", "score": 18 },\n  { "vertical": "finance", "score": 24 }\n]\n::\n`;
  const out = patchSource(src, {
    op: "insert_dataset_column",
    id: "scores",
    column: 1,
    header: "owner",
    cells: ["Research", "Finance"],
  });
  assert.match(out, /\{ "vertical": "legal", "owner": "Research", "score": 18 \}/);
  assert.match(out, /\{ "vertical": "finance", "owner": "Finance", "score": 24 \}/);
});

test("patchSource: delete_dataset_column supports JSON record-array datasets", () => {
  const src = `::dataset{id="scores" format="json"}\n[\n  { "vertical": "legal", "owner": "Research", "score": 18 },\n  { "vertical": "finance", "owner": "Finance", "score": 24 }\n]\n::\n`;
  const out = patchSource(src, { op: "delete_dataset_column", id: "scores", column: "owner" });
  assert.match(out, /\{ "vertical": "legal", "score": 18 \}/);
  assert.doesNotMatch(out, /owner|Research/);
});

test("patchSource: update_dataset_cell rejects non-inline YAML rows", () => {
  const src = `::dataset{id="scores"}\nschema:\n  vertical: string\n  score: number\nrows:\n  - vertical: legal\n    score: 18\n::\n`;
  assert.throws(
    () => patchSource(src, { op: "update_dataset_cell", id: "scores", row: 0, column: "score", value: "19" }),
    /inline YAML row arrays/,
  );
});

test("patchSource: delete_block drops the block plus a duplicate blank", () => {
  const out = patchSource(sample, { op: "delete_block", id: "c1" });
  assert.doesNotMatch(out, /old body/);
  assert.match(out, /Intro paragraph/);
  assert.match(out, /::evidence\{for="c1"\}/);
});

test("patchSource: add_block appends to a parent at end", () => {
  const src = `::grid{id="g" columns=2}
:::card{id="a" title="A"}
left
:::
::
`;
  const out = patchSource(src, {
    op: "add_block",
    parent: "g",
    content: `:::card{id="b" title="B"}\nright\n:::\n`,
  });
  assert.match(out, /title="A"[\s\S]*title="B"/);
  // Original card body intact.
  assert.match(out, /:::card\{id="a" title="A"\}\nleft\n:::/);
});

test("patchSource: add_block at position 0 inserts before sibling", () => {
  const src = `::grid{id="g"}
:::card{id="a"}
a
:::
::
`;
  const out = patchSource(src, {
    op: "add_block",
    parent: "g",
    position: 0,
    content: `:::card{id="z"}\nz\n:::\n`,
  });
  assert.match(out, /id="z"[\s\S]*id="a"/);
});

test("patchSource: move_block preserves moved block bytes", () => {
  const src = `::grid{id="left"}\n:::card{id="a" title="A"}\na\n:::\n\n:::card{id="b" title="B"}\nB **body**\n:::\n::\n\n::grid{id="right"}\n:::card{id="c" title="C"}\nc\n:::\n::\n`;
  const out = patchSource(src, {
    op: "move_block",
    id: "b",
    parent: "right",
    position: 0,
  });
  assert.match(out, /::grid\{id="left"\}\n:::card\{id="a" title="A"\}\na\n:::\n\n::/);
  assert.match(out, /::grid\{id="right"\}\n:::card\{id="b" title="B"\}\nB \*\*body\*\*\n:::\n\n:::card\{id="c" title="C"\}/);
});

test("patchSource: move_block adjusts directive fence depth for the new parent", () => {
  const src = `::risk{id="r1"}\nRisk body.\n::\n\n::grid{id="g"}\n::\n`;
  const out = patchSource(src, {
    op: "move_block",
    id: "r1",
    parent: "g",
  });
  assert.match(out, /^::grid\{id="g"\}\n:::risk\{id="r1"\}\nRisk body\.\n:::\n::\n$/);
});

test("patchSource: move_block rejects moving into descendants", () => {
  const src = `::grid{id="g"}\n:::card{id="c"}\nText.\n:::\n::\n`;
  assert.throws(
    () => patchSource(src, { op: "move_block", id: "g", parent: "c" }),
    /cannot move/,
  );
});

test("patchSource: add_block rejects non-directive fragments before editing source", () => {
  const src = `::grid{id="g"}\n::\n`;
  assert.throws(
    () =>
      patchSource(src, {
        op: "add_block",
        parent: "g",
        content: "just a paragraph\n",
      }),
    /fragment must be a directive block/,
  );
});

test("patchSource: rename_id rewrites id attr, ref attrs, and wikilinks", () => {
  const out = patchSource(sample, { op: "rename_id", from: "c1", to: "claim-renamed" });
  assert.match(out, /::claim\{id="claim-renamed"/);
  assert.match(out, /::evidence\{for="claim-renamed"\}/);
  assert.match(out, /\[\[claim-renamed\]\]/);
  assert.doesNotMatch(out, /"c1"/);
  // Frontmatter byte-identical.
  assert.match(out, /^---\ntitle: Demo\ndate: 2026-05-09\ntags: \[a, b\]\n---/);
});

test("patchSource: heading id roundtrip via rename_id", () => {
  const src = `# Custom Title {id="custom-id"}\n\n::claim{id="c"}\na\n::\n\nSee [[custom-id]].\n`;
  const out = patchSource(src, { op: "rename_id", from: "custom-id", to: "renamed" });
  assert.match(out, /\{id="renamed"\}/);
  assert.match(out, /\[\[renamed\]\]/);
});

test("patchSource: ops sequence (re-locates after each op)", () => {
  const out = patchSource(sample, [
    { op: "update_attribute", id: "c1", key: "confidence", value: 0.7 },
    { op: "rename_id", from: "c1", to: "c2" },
  ]);
  assert.match(out, /::claim\{id="c2" confidence=0\.7\}/);
  assert.match(out, /for="c2"/);
});

test("patchSource: every line outside the patched block is byte-identical", () => {
  const out = patchSource(sample, {
    op: "update_attribute",
    id: "c1",
    key: "confidence",
    value: 0.95,
  });
  const before = sample.split("\n");
  const after = out.split("\n");
  assert.equal(after.length, before.length, "line count must not change");
  let driftLines = 0;
  for (let i = 0; i < before.length; i++) {
    if (before[i]!.includes('id="c1"')) {
      driftLines++;
      continue;
    }
    assert.equal(after[i], before[i], `line ${i + 1} drifted: "${before[i]}" → "${after[i]}"`);
  }
  assert.equal(driftLines, 1, "exactly one line should change (the targeted open line)");
});

test("patchSource: replace_block leaves frontmatter and sibling bytes identical", () => {
  const out = patchSource(sample, {
    op: "replace_block",
    id: "c1",
    content: `::claim{id="c1" confidence=0.99}\nfresh body\n::`,
  });
  const before = sample.split("\n");
  const after = out.split("\n");
  // Frontmatter (lines 0..3, ending '---') untouched.
  for (let i = 0; i < 5; i++) {
    assert.equal(after[i], before[i], `frontmatter line ${i} drifted`);
  }
  // The evidence block (after the claim) must still be byte-identical.
  const evIdxBefore = before.findIndex((l) => l.includes("::evidence"));
  const evIdxAfter = after.findIndex((l) => l.includes("::evidence"));
  assert.notEqual(evIdxAfter, -1);
  for (let i = 0; i < 4; i++) {
    assert.equal(after[evIdxAfter + i], before[evIdxBefore + i]);
  }
});

test("patchSource: rename_id retargets bareword reference attrs", () => {
  const src = `::claim{id="c1"}\nx\n::\n\n::evidence{for=c1}\ne\n::\n\n::plot{dataset=c1}\np\n::\n\n::comment{parent=c1}\nnote\n::\n`;
  const out = patchSource(src, { op: "rename_id", from: "c1", to: "c2" });
  assert.match(out, /::evidence\{for="c2"\}/);
  assert.match(out, /::plot\{dataset="c2"\}/);
  assert.match(out, /::comment\{parent="c2"\}/);
  assert.doesNotMatch(out, /=c1\b/);
});

test("patchSource: missing id throws", () => {
  assert.throws(
    () => patchSource(sample, { op: "delete_block", id: "missing" }),
    /not found/,
  );
});
