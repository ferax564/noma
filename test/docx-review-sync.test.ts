import { test } from "node:test";
import assert from "node:assert/strict";
import { readDocxZipEntries } from "../src/docx-control-data.js";
import { parse } from "../src/parser.js";
import { renderDocx } from "../src/renderer-docx.js";
import { syncReviewCommentsFromData, syncReviewCommentsFromDocx } from "../src/docx-review-sync.js";
import { storedDocx } from "./docx-test-zip.js";

test("syncReviewCommentsFromDocx adds anchored Word comments to source", () => {
  const source = `# Review

::claim{id="c1"}
Claim.
::
`;
  const reviewed = parse(`# Review

::claim{id="c1"}
Claim.
::

::comment{id="word-comment" parent="c1" author="Research" date="2026-05-24T09:00:00Z"}
Check this claim.
::
`);

  const result = syncReviewCommentsFromDocx(source, renderDocx(reviewed));

  assert.deepEqual(result.changes, [
    { action: "add_comment", id: "comment-c1-0", target: "c1", nativeId: "0" },
  ]);
  assert.match(result.source, /::comment\{id="comment-c1-0" parent="c1" author="Research" initials="R" date="2026-05-24T09:00:00Z"\}/);
  assert.match(result.source, /Check this claim\./);
});

test("syncReviewCommentsFromDocx anchors later framed directive body review items", () => {
  const source = `# Review

::claim{id="c1"}
First paragraph.

Second paragraph.

Third paragraph.
::
`;
  const bookmark = sourceBookmarkName("c1");
  const reviewed = storedDocx({
    "word/document.xml": `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Review</w:t></w:r></w:p>
    <w:p><w:pPr><w:pStyle w:val="NomaDirective"/></w:pPr><w:bookmarkStart w:id="1" w:name="${bookmark}"/><w:r><w:t>Claim</w:t></w:r><w:bookmarkEnd w:id="1"/></w:p>
    <w:p><w:pPr><w:shd w:fill="F1F6EF"/></w:pPr><w:r><w:t>First paragraph.</w:t></w:r></w:p>
    <w:p><w:pPr><w:shd w:fill="F1F6EF"/></w:pPr><w:commentRangeStart w:id="7"/><w:r><w:t>Second paragraph.</w:t></w:r><w:commentRangeEnd w:id="7"/><w:r><w:commentReference w:id="7"/></w:r></w:p>
    <w:p><w:pPr><w:shd w:fill="F1F6EF"/></w:pPr><w:del w:id="8" w:author="Reviewer" w:date="2026-05-25T09:00:00Z"><w:r><w:delText>Third paragraph.</w:delText></w:r></w:del><w:ins w:id="9" w:author="Reviewer" w:date="2026-05-25T09:00:00Z"><w:r><w:t>Third paragraph updated.</w:t></w:r></w:ins></w:p>
  </w:body>
</w:document>`,
    "word/comments.xml": `<w:comments xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:comment w:id="7" w:author="Reviewer" w:initials="R"><w:p><w:r><w:t>Review the second paragraph.</w:t></w:r></w:p></w:comment>
</w:comments>`,
  });

  const result = syncReviewCommentsFromDocx(source, reviewed);

  assert.deepEqual(result.changes, [
    { action: "add_comment", id: "comment-c1-7", target: "c1", nativeId: "7" },
    { action: "add_change_request", id: "change-c1-8-9", target: "c1", nativeId: "8/9" },
  ]);
  assert.match(result.source, /::comment\{id="comment-c1-7" parent="c1" author="Reviewer" initials="R"\}/);
  assert.match(result.source, /Review the second paragraph\./);
  assert.match(result.source, /::change_request\{id="change-c1-8-9" target="c1" action="replace" from="Third paragraph\." to="Third paragraph updated\." author="Reviewer" date="2026-05-25T09:00:00Z"\}/);
  assert.equal(result.skipped.length, 0);
  assert.equal(result.skippedRevisions.length, 0);
});

test("syncReviewCommentsFromDocx anchors layout table review items to child blocks", () => {
  const source = `# Review

::grid{id="review-grid" columns=1}
:::card{id="card-one" title="Card one"}
First paragraph.

Second paragraph.
:::
::
`;

  const result = syncReviewCommentsFromDocx(source, docxWithLayoutChildReview(renderDocx(parse(source))));

  assert.deepEqual(result.changes, [
    { action: "add_comment", id: "comment-card-one-72", target: "card-one", nativeId: "72" },
    { action: "add_change_request", id: "change-card-one-80-81", target: "card-one", nativeId: "80/81" },
  ]);
  assert.match(result.source, /::comment\{id="comment-card-one-72" parent="card-one" author="Reviewer" initials="R"\}/);
  assert.match(result.source, /Review the card paragraph\./);
  assert.match(result.source, /::change_request\{id="change-card-one-80-81" target="card-one" action="replace" from="First paragraph\." to="First paragraph updated\." author="Reviewer" date="2026-05-25T09:00:00Z"\}/);
  assert.doesNotMatch(result.source, /parent="review-grid"|target="review-grid"/);
  assert.equal(result.skipped.length, 0);
  assert.equal(result.skippedRevisions.length, 0);
});

test("syncReviewCommentsFromDocx updates accepted Word prose block body edits", () => {
  const source = `# Review

::claim{id="c1"}
Old claim body.
::

::card{id="plan" title="Plan"}
Old card body.
::
`;
  const reviewed = parse(`# Review

::claim{id="c1"}
New **claim** body with [source](https://example.com/report).
::

::card{id="plan" title="Plan"}
New card body.

Second paragraph.
::
`);

  const result = syncReviewCommentsFromDocx(source, renderDocx(reviewed));

  assert.deepEqual(result.changes, [
    { action: "update_block_body", id: "c1", nativeId: "0" },
    { action: "update_block_body", id: "plan", nativeId: "1" },
  ]);
  assert.match(result.source, /::claim\{id="c1"\}\nNew \*\*claim\*\* body with \[source\]\(https:\/\/example\.com\/report\)\.\n::/);
  assert.match(result.source, /::card\{id="plan" title="Plan"\}\nNew card body\.\n\nSecond paragraph\.\n::/);
  assert.equal(result.skippedBlockBodies.length, 0);
});

test("syncReviewCommentsFromDocx does not rewrite unchanged captioned wikilinks in block bodies", () => {
  const source = `# Review

::table{id="metrics" title="Quarterly metrics" header}
| Metric | Value |
| ARR | 10m |
::

::claim{id="c1"}
See **[[metrics]]** before editing the table.
::
`;

  const result = syncReviewCommentsFromDocx(source, renderDocx(parse(source)));

  assert.deepEqual(result.changes, []);
  assert.equal(result.source, source);
  assert.equal(result.skippedBlockBodies.length, 0);
});

test("syncReviewCommentsFromDocx does not rewrite unchanged simple caption REF fields", () => {
  const source = `# Review

::table{id="metrics" title="Quarterly metrics" header}
| Metric | Value |
| ARR | 10m |
::

::claim{id="c1"}
See **[[metrics]]** before editing the table.
::
`;

  const result = syncReviewCommentsFromDocx(source, docxWithSimpleCaptionRefField(renderDocx(parse(source))));

  assert.deepEqual(result.changes, []);
  assert.equal(result.source, source);
  assert.equal(result.skippedBlockBodies.length, 0);
});

test("syncReviewCommentsFromDocx preserves unchanged soft-wrapped source block bodies", () => {
  const source = `# Review

::claim{id="c1"}
Old claim
body.
::
`;
  const reviewed = parse(`# Review

::claim{id="c1"}
Old claim body.
::
`);

  const result = syncReviewCommentsFromDocx(source, renderDocx(reviewed));

  assert.deepEqual(result.changes, []);
  assert.equal(result.source, source);
  assert.equal(result.skippedBlockBodies.length, 0);
});

test("syncReviewCommentsFromDocx updates accepted Word code block body edits", () => {
  const source = `# Compute

::code_cell{id="cell1" lang="ts" runtime="node"}
const value = 1;
console.log(value);
::

::query{id="usage-query" language="sql"}
select *
from usage
where account_id = 1;
::
`;
  const reviewed = parse(`# Compute

::code_cell{id="cell1" lang="ts" runtime="node"}
const value = 2;
console.log(value);
::

::query{id="usage-query" language="sql"}
select account_id, usage
from usage
where usage > 0;
::
`);

  const result = syncReviewCommentsFromDocx(source, renderDocx(reviewed));

  assert.deepEqual(result.changes, [
    { action: "update_block_body", id: "cell1", nativeId: "0" },
    { action: "update_block_body", id: "usage-query", nativeId: "1" },
  ]);
  assert.match(result.source, /::code_cell\{id="cell1" lang="ts" runtime="node"\}\nconst value = 2;\nconsole\.log\(value\);\n::/);
  assert.match(result.source, /::query\{id="usage-query" language="sql"\}\nselect account_id, usage\nfrom usage\nwhere usage > 0;\n::/);
  assert.equal(result.skippedBlockBodies.length, 0);
});

test("syncReviewCommentsFromDocx updates accepted Word technical prose body edits", () => {
  const source = `# Technical

::instruction{id="review-flow" scope="word"}
Use the old checklist.
::

::api{id="payments-api" version="v1"}
The API is stable.
::

::query{id="audit-query"}
Review the latest audit rows before shipping.
::
`;
  const reviewed = parse(`# Technical

::instruction{id="review-flow" scope="word"}
Use the new checklist.
::

::api{id="payments-api" version="v1"}
The API is stable for partner review.
::

::query{id="audit-query"}
Review the latest audit rows and attach findings before shipping.
::
`);

  const result = syncReviewCommentsFromDocx(source, renderDocx(reviewed));

  assert.deepEqual(result.changes, [
    { action: "update_block_body", id: "review-flow", nativeId: "0" },
    { action: "update_block_body", id: "payments-api", nativeId: "1" },
    { action: "update_block_body", id: "audit-query", nativeId: "2" },
  ]);
  assert.match(result.source, /::instruction\{id="review-flow" scope="word"\}\nUse the new checklist\.\n::/);
  assert.match(result.source, /::api\{id="payments-api" version="v1"\}\nThe API is stable for partner review\.\n::/);
  assert.match(result.source, /::query\{id="audit-query"\}\nReview the latest audit rows and attach findings before shipping\.\n::/);
  assert.equal(result.skippedBlockBodies.length, 0);
});

test("syncReviewCommentsFromDocx updates accepted Word custom fallback body edits", () => {
  const source = `# Pack

::finance::position{id="holding-asml" asset_class="equity" region="EU"}
Initial thesis.
::

::custom_directive{id="custom-block" last_seen="2026-05-24" noverify}
Custom block note.
::
`;
  const reviewed = parse(`# Pack

::finance::position{id="holding-asml" asset_class="equity" region="EU"}
Updated **thesis**.
::

::custom_directive{id="custom-block" last_seen="2026-05-24" noverify}
Custom block note updated.
::
`);

  const result = syncReviewCommentsFromDocx(source, renderDocx(reviewed));

  assert.deepEqual(result.changes, [
    { action: "update_block_body", id: "holding-asml", nativeId: "0" },
    { action: "update_block_body", id: "custom-block", nativeId: "1" },
  ]);
  assert.match(result.source, /::finance::position\{id="holding-asml" asset_class="equity" region="EU"\}\nUpdated \*\*thesis\*\*\.\n::/);
  assert.match(result.source, /::custom_directive\{id="custom-block" last_seen="2026-05-24" noverify\}\nCustom block note updated\.\n::/);
  assert.equal(result.skippedBlockBodies.length, 0);
});

test("syncReviewCommentsFromDocx does not leak layout child anchors across sibling cells", () => {
  const source = `# Review

::grid{id="review-grid" columns=2}
:::card{id="card-one" title="Card one"}
First cell.
:::

Loose second cell.
::
`;

  const result = syncReviewCommentsFromDocx(source, docxWithLooseLayoutCellReview(renderDocx(parse(source))));

  assert.deepEqual(result.changes, [
    { action: "add_comment", id: "comment-review-grid-73", target: "review-grid", nativeId: "73" },
    { action: "add_change_request", id: "change-review-grid-82-83", target: "review-grid", nativeId: "82/83" },
  ]);
  assert.match(result.source, /::comment\{id="comment-review-grid-73" parent="review-grid" author="Reviewer" initials="R"\}/);
  assert.match(result.source, /Review the loose layout cell\./);
  assert.match(result.source, /::change_request\{id="change-review-grid-82-83" target="review-grid" action="replace" from="Loose second cell\." to="Loose second cell updated\." author="Reviewer" date="2026-05-25T09:00:00Z"\}/);
  assert.doesNotMatch(result.source, /parent="card-one"|target="card-one"/);
  assert.equal(result.skipped.length, 0);
  assert.equal(result.skippedRevisions.length, 0);
});

test("syncReviewCommentsFromDocx preserves Word carriage-return breaks in added comments", () => {
  const source = `# Review

::claim{id="c1"}
Claim.
::
`;
  const entries = Object.fromEntries(
    [...readDocxZipEntries(renderDocx(parse(source)))].map(([name, data]) => [name, data.toString("utf8")]),
  );
  const documentXml = entries["word/document.xml"];
  assert.ok(documentXml);
  const targetRun = /<w:r><w:t(?: xml:space="preserve")?>Claim\.<\/w:t><\/w:r>/;
  assert.ok(targetRun.test(documentXml));
  entries["word/document.xml"] = documentXml.replace(
    targetRun,
    (run) => `<w:commentRangeStart w:id="7"/>${run}<w:commentRangeEnd w:id="7"/><w:r><w:commentReference w:id="7"/></w:r>`,
  );
  entries["word/comments.xml"] = `<w:comments xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:comment w:id="7" w:author="Reviewer" w:initials="R"><w:p><w:r><w:t>First line</w:t><w:cr/><w:t>Second line</w:t></w:r></w:p></w:comment>
</w:comments>`;

  const result = syncReviewCommentsFromDocx(
    source,
    storedDocx(entries),
  );

  assert.deepEqual(result.changes, [
    { action: "add_comment", id: "comment-c1-7", target: "c1", nativeId: "7" },
  ]);
  assert.match(result.source, /First line\nSecond line/);
});

test("syncReviewCommentsFromDocx preserves paired Word break elements in added comments", () => {
  const source = `# Review

::claim{id="c1"}
Claim.
::
`;
  const entries = Object.fromEntries(
    [...readDocxZipEntries(renderDocx(parse(source)))].map(([name, data]) => [name, data.toString("utf8")]),
  );
  const documentXml = entries["word/document.xml"];
  assert.ok(documentXml);
  const targetRun = /<w:r><w:t(?: xml:space="preserve")?>Claim\.<\/w:t><\/w:r>/;
  assert.ok(targetRun.test(documentXml));
  entries["word/document.xml"] = documentXml.replace(
    targetRun,
    (run) => `<w:commentRangeStart w:id="17"/>${run}<w:commentRangeEnd w:id="17"/><w:r><w:commentReference w:id="17"/></w:r>`,
  );
  entries["word/comments.xml"] = `<w:comments xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:comment w:id="17" w:author="Reviewer" w:initials="R"><w:p><w:r><w:t>First line</w:t><w:br></w:br><w:t>Second line</w:t></w:r></w:p></w:comment>
</w:comments>`;

  const result = syncReviewCommentsFromDocx(
    source,
    storedDocx(entries),
  );

  assert.deepEqual(result.changes, [
    { action: "add_comment", id: "comment-c1-17", target: "c1", nativeId: "17" },
  ]);
  assert.match(result.source, /First line\nSecond line/);
});

test("syncReviewCommentsFromDocx preserves Word no-break hyphens in added comments", () => {
  const source = `# Review

::claim{id="c1"}
Claim.
::
`;
  const entries = Object.fromEntries(
    [...readDocxZipEntries(renderDocx(parse(source)))].map(([name, data]) => [name, data.toString("utf8")]),
  );
  const documentXml = entries["word/document.xml"];
  assert.ok(documentXml);
  const targetRun = /<w:r><w:t(?: xml:space="preserve")?>Claim\.<\/w:t><\/w:r>/;
  assert.ok(targetRun.test(documentXml));
  entries["word/document.xml"] = documentXml.replace(
    targetRun,
    (run) => `<w:commentRangeStart w:id="8"/>${run}<w:commentRangeEnd w:id="8"/><w:r><w:commentReference w:id="8"/></w:r>`,
  );
  entries["word/comments.xml"] = `<w:comments xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:comment w:id="8" w:author="Reviewer" w:initials="R"><w:p><w:r><w:t>Board</w:t><w:noBreakHyphen/><w:t>ready memo.</w:t></w:r></w:p></w:comment>
</w:comments>`;

  const result = syncReviewCommentsFromDocx(
    source,
    storedDocx(entries),
  );

  assert.deepEqual(result.changes, [
    { action: "add_comment", id: "comment-c1-8", target: "c1", nativeId: "8" },
  ]);
  assert.match(result.source, /Board-ready memo\./);
});

test("syncReviewCommentsFromDocx preserves Word symbol glyphs in added comments", () => {
  const source = `# Review

::claim{id="c1"}
Claim.
::
`;
  const entries = Object.fromEntries(
    [...readDocxZipEntries(renderDocx(parse(source)))].map(([name, data]) => [name, data.toString("utf8")]),
  );
  const documentXml = entries["word/document.xml"];
  assert.ok(documentXml);
  const targetRun = /<w:r><w:t(?: xml:space="preserve")?>Claim\.<\/w:t><\/w:r>/;
  assert.ok(targetRun.test(documentXml));
  entries["word/document.xml"] = documentXml.replace(
    targetRun,
    (run) => `<w:commentRangeStart w:id="9"/>${run}<w:commentRangeEnd w:id="9"/><w:r><w:commentReference w:id="9"/></w:r>`,
  );
  entries["word/comments.xml"] = `<w:comments xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:comment w:id="9" w:author="Reviewer" w:initials="R"><w:p><w:r><w:t>Review </w:t><w:sym w:font="Segoe UI Symbol" w:char="2713"/><w:t> complete.</w:t></w:r></w:p></w:comment>
</w:comments>`;

  const result = syncReviewCommentsFromDocx(
    source,
    storedDocx(entries),
  );

  assert.deepEqual(result.changes, [
    { action: "add_comment", id: "comment-c1-9", target: "c1", nativeId: "9" },
  ]);
  assert.match(result.source, /Review \u2713 complete\./);
});

test("syncReviewCommentsFromDocx preserves Word positional tabs in added comments", () => {
  const source = `# Review

::claim{id="c1"}
Claim.
::
`;
  const entries = Object.fromEntries(
    [...readDocxZipEntries(renderDocx(parse(source)))].map(([name, data]) => [name, data.toString("utf8")]),
  );
  const documentXml = entries["word/document.xml"];
  assert.ok(documentXml);
  const targetRun = /<w:r><w:t(?: xml:space="preserve")?>Claim\.<\/w:t><\/w:r>/;
  assert.ok(targetRun.test(documentXml));
  entries["word/document.xml"] = documentXml.replace(
    targetRun,
    (run) => `<w:commentRangeStart w:id="10"/>${run}<w:commentRangeEnd w:id="10"/><w:r><w:commentReference w:id="10"/></w:r>`,
  );
  entries["word/comments.xml"] = `<w:comments xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:comment w:id="10" w:author="Reviewer" w:initials="R"><w:p><w:r><w:t>Metric</w:t><w:ptab w:relativeTo="margin" w:alignment="right" w:leader="none"/><w:t>Value</w:t></w:r></w:p></w:comment>
</w:comments>`;

  const result = syncReviewCommentsFromDocx(
    source,
    storedDocx(entries),
  );

  assert.deepEqual(result.changes, [
    { action: "add_comment", id: "comment-c1-10", target: "c1", nativeId: "10" },
  ]);
  assert.match(result.source, /Metric\tValue/);
});

test("syncReviewCommentsFromDocx preserves Word soft hyphens in added comments", () => {
  const source = `# Review

::claim{id="c1"}
Claim.
::
`;
  const entries = Object.fromEntries(
    [...readDocxZipEntries(renderDocx(parse(source)))].map(([name, data]) => [name, data.toString("utf8")]),
  );
  const documentXml = entries["word/document.xml"];
  assert.ok(documentXml);
  const targetRun = /<w:r><w:t(?: xml:space="preserve")?>Claim\.<\/w:t><\/w:r>/;
  assert.ok(targetRun.test(documentXml));
  entries["word/document.xml"] = documentXml.replace(
    targetRun,
    (run) => `<w:commentRangeStart w:id="11"/>${run}<w:commentRangeEnd w:id="11"/><w:r><w:commentReference w:id="11"/></w:r>`,
  );
  entries["word/comments.xml"] = `<w:comments xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:comment w:id="11" w:author="Reviewer" w:initials="R"><w:p><w:r><w:t>co</w:t><w:softHyphen/><w:t>operate.</w:t></w:r></w:p></w:comment>
</w:comments>`;

  const result = syncReviewCommentsFromDocx(
    source,
    storedDocx(entries),
  );

  assert.deepEqual(result.changes, [
    { action: "add_comment", id: "comment-c1-11", target: "c1", nativeId: "11" },
  ]);
  assert.match(result.source, /co\u00adoperate\./);
});

test("syncReviewCommentsFromDocx skips comments with deleted tracked body text", () => {
  const source = `# Review

::claim{id="c1"}
Claim.
::
`;
  const entries = Object.fromEntries(
    [...readDocxZipEntries(renderDocx(parse(source)))].map(([name, data]) => [name, data.toString("utf8")]),
  );
  const documentXml = entries["word/document.xml"];
  assert.ok(documentXml);
  const targetRun = /<w:r><w:t(?: xml:space="preserve")?>Claim\.<\/w:t><\/w:r>/;
  assert.ok(targetRun.test(documentXml));
  entries["word/document.xml"] = documentXml.replace(
    targetRun,
    (run) => `<w:commentRangeStart w:id="12"/>${run}<w:commentRangeEnd w:id="12"/><w:r><w:commentReference w:id="12"/></w:r>`,
  );
  entries["word/comments.xml"] = `<w:comments xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:comment w:id="12" w:author="Reviewer" w:initials="R"><w:p><w:r><w:t>Updated</w:t></w:r><w:del w:id="5" w:author="Reviewer" w:date="2026-05-25T09:00:00Z"><w:r><w:br/><w:noBreakHyphen/><w:tab/><w:delText>old break</w:delText></w:r></w:del><w:r><w:t>comment.</w:t></w:r></w:p></w:comment>
</w:comments>`;

  const result = syncReviewCommentsFromDocx(
    source,
    storedDocx(entries),
  );

  assert.deepEqual(result.changes, []);
  assert.equal(result.source, source);
  assert.equal(result.skipped.length, 1);
  assert.equal(result.skipped[0]?.body, "Updatedcomment.");
  assert.equal(result.skipped[0]?.hasRevisions, true);
});

test("syncReviewCommentsFromDocx skips comments with tracked moved body text", () => {
  const source = `# Review

::claim{id="c1"}
Claim.
::
`;
  const entries = Object.fromEntries(
    [...readDocxZipEntries(renderDocx(parse(source)))].map(([name, data]) => [name, data.toString("utf8")]),
  );
  const documentXml = entries["word/document.xml"];
  assert.ok(documentXml);
  const targetRun = /<w:r><w:t(?: xml:space="preserve")?>Claim\.<\/w:t><\/w:r>/;
  assert.ok(targetRun.test(documentXml));
  entries["word/document.xml"] = documentXml.replace(
    targetRun,
    (run) => `<w:commentRangeStart w:id="13"/>${run}<w:commentRangeEnd w:id="13"/><w:r><w:commentReference w:id="13"/></w:r>`,
  );
  entries["word/comments.xml"] = `<w:comments xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:comment w:id="13" w:author="Reviewer" w:initials="R"><w:p><w:r><w:t>Updated </w:t></w:r><w:moveFrom w:id="5" w:author="Reviewer" w:date="2026-05-25T09:00:00Z"><w:r><w:t>old</w:t><w:br/><w:t>comment</w:t></w:r></w:moveFrom><w:moveTo w:id="6" w:author="Reviewer" w:date="2026-05-25T09:00:00Z"><w:r><w:t>comment.</w:t></w:r></w:moveTo></w:p></w:comment>
</w:comments>`;

  const result = syncReviewCommentsFromDocx(
    source,
    storedDocx(entries),
  );

  assert.deepEqual(result.changes, []);
  assert.equal(result.source, source);
  assert.equal(result.skipped.length, 1);
  assert.equal(result.skipped[0]?.body, "Updated comment.");
  assert.equal(result.skipped[0]?.hasRevisions, true);
});

test("syncReviewCommentsFromDocx imports header/footer comments and revisions", () => {
  const source = `::header
:::claim{id="header-claim"}
Header claim.
:::
::

::footer
:::claim{id="footer-claim"}
Footer claim.
:::
::
`;

  const result = syncReviewCommentsFromDocx(
    source,
    docxWithHeaderCommentAndFooterRevision(renderDocx(parse(source))),
  );

  assert.ok(result.changes.some((change) =>
    change.action === "add_comment" &&
    change.target === "header-claim" &&
    change.nativeId === "42"
  ));
  assert.ok(result.changes.some((change) =>
    change.action === "add_change_request" &&
    change.target === "footer-claim" &&
    change.nativeId === "word/footer1.xml:50/51"
  ));
  assert.match(result.source, /:::comment\{id="comment-header-claim-42" parent="header-claim" author="Reviewer" initials="R"\}/);
  assert.match(result.source, /Check the running header\./);
  assert.match(result.source, /:::change_request\{id="change-footer-claim-word-footer1\.xml-50-51" target="footer-claim" action="replace" from="Footer claim\." to="Footer claim updated\." author="Reviewer" date="2026-05-25T09:00:00Z"\}/);
  assert.equal(result.skipped.length, 0);
  assert.equal(result.skippedRevisions.length, 0);
});

test("syncReviewCommentsFromDocx updates accepted Word heading edits", () => {
  const source = `# Review

## Original section {id="topic"}

Body.
`;

  const result = syncReviewCommentsFromDocx(source, docxWithHeadingEdit(renderDocx(parse(source))));

  assert.deepEqual(result.changes, [
    { action: "update_heading", id: "topic", nativeId: "1" },
  ]);
  assert.match(result.source, /## Edited section \{id="topic"\}/);
  assert.equal(result.skippedHeadings.length, 0);
});

test("syncReviewCommentsFromDocx preserves rich accepted Word heading edits", () => {
  const source = `# Intro {id="intro"}

## Original section {id="topic"}

Body.
`;
  const reviewed = parse(`# Intro {id="intro"}

## **Edited** [source](https://example.com/heading) \`model\` and [[intro]] {id="topic"}

Body.
`);

  const result = syncReviewCommentsFromDocx(source, renderDocx(reviewed));

  assert.deepEqual(result.changes, [
    { action: "update_heading", id: "topic", nativeId: "1" },
  ]);
  assert.match(result.source, /## \*\*Edited\*\* \[source\]\(https:\/\/example\.com\/heading\) `model` and \[\[intro\]\] \{id="topic"\}/);
  assert.equal(result.skippedHeadings.length, 0);
});

test("syncReviewCommentsFromDocx does not rewrite unchanged rich headings", () => {
  const source = `# Intro {id="intro"}

## **Market** [source](https://example.com/heading) \`model\` and [[intro]] {id="topic"}

Body.
`;

  const result = syncReviewCommentsFromDocx(source, renderDocx(parse(source)));

  assert.deepEqual(result.changes, []);
  assert.equal(result.source, source);
  assert.equal(result.skippedHeadings.length, 0);
});

test("syncReviewCommentsFromDocx does not rewrite unchanged alias wikilinks in headings", () => {
  const source = `# Review

## Details {id="review-details" aliases="details"}

## See [[details]] {id="topic"}

Body.
`;

  const result = syncReviewCommentsFromDocx(source, renderDocx(parse(source)));

  assert.deepEqual(result.changes, []);
  assert.equal(result.source, source);
  assert.equal(result.skippedHeadings.length, 0);
});

test("syncReviewCommentsFromDocx updates accepted Word table caption edits", () => {
  const source = `# Review

::table{id="metrics" title="Old metrics" header}
| Metric | Value |
| ARR | 10m |
::
`;
  const reviewed = parse(`# Review

::table{id="metrics" title="Updated metrics" header}
| Metric | Value |
| ARR | 10m |
::
`);

  const result = syncReviewCommentsFromDocx(source, renderDocx(reviewed));

  assert.deepEqual(result.changes, [
    { action: "update_caption", id: "metrics", nativeId: "0", key: "title" },
  ]);
  assert.match(result.source, /::table\{id="metrics" title="Updated metrics" header\}/);
  assert.equal(result.skippedCaptions.length, 0);
});

test("syncReviewCommentsFromDocx updates accepted Word figure caption edits", () => {
  const source = `# Review

::figure{id="diagram" caption="Old diagram" alt="Diagram"}
::
`;
  const reviewed = parse(`# Review

::figure{id="diagram" caption="Updated diagram" alt="Diagram"}
::
`);

  const result = syncReviewCommentsFromDocx(source, renderDocx(reviewed));

  assert.deepEqual(result.changes, [
    { action: "update_caption", id: "diagram", nativeId: "0", key: "caption" },
  ]);
  assert.match(result.source, /::figure\{id="diagram" caption="Updated diagram" alt="Diagram"\}/);
  assert.equal(result.skippedCaptions.length, 0);
});

test("syncReviewCommentsFromDocx updates accepted Word plot caption edits", () => {
  const source = `# Review

::plot{id="growth" title="Old growth" type="line" data="1,2,3"}
::
`;
  const reviewed = parse(`# Review

::plot{id="growth" title="Updated growth" type="line" data="1,2,3"}
::
`);

  const result = syncReviewCommentsFromDocx(source, renderDocx(reviewed));

  assert.deepEqual(result.changes, [
    { action: "update_caption", id: "growth", nativeId: "0", key: "title" },
  ]);
  assert.match(result.source, /::plot\{id="growth" title="Updated growth" type="line" data="1,2,3"\}/);
  assert.equal(result.skippedCaptions.length, 0);
});

test("syncReviewCommentsFromDocx updates accepted Word computed plot body-title caption edits", () => {
  const source = `# Review

::computed_plot{id="projection" formula="x * 2" domain="x:0..2"}
title: Old projection
Reviewed as a static Word chart.
::
`;
  const reviewed = parse(`# Review

::computed_plot{id="projection" formula="x * 2" domain="x:0..2"}
title: Updated projection
Reviewed as a static Word chart.
::
`);

  const result = syncReviewCommentsFromDocx(source, renderDocx(reviewed));

  assert.deepEqual(result.changes, [
    { action: "update_caption", id: "projection", nativeId: "0", key: "title" },
  ]);
  assert.match(result.source, /title: Updated projection/);
  assert.match(result.source, /Reviewed as a static Word chart\./);
  assert.doesNotMatch(result.source, /title: Old projection/);
  assert.equal(result.skippedCaptions.length, 0);
});

test("syncReviewCommentsFromDocx adds computed plot title attrs for accepted default caption edits", () => {
  const source = `# Review

::computed_plot{id="projection" formula="x * 2" domain="x:0..2"}
::
`;
  const reviewed = parse(`# Review

::computed_plot{id="projection" title="Updated projection" formula="x * 2" domain="x:0..2"}
::
`);

  const result = syncReviewCommentsFromDocx(source, renderDocx(reviewed));

  assert.deepEqual(result.changes, [
    { action: "update_caption", id: "projection", nativeId: "0", key: "title" },
  ]);
  assert.match(result.source, /::computed_plot\{id="projection" formula="x \* 2" domain="x:0\.\.2" title="Updated projection"\}/);
  assert.equal(result.skippedCaptions.length, 0);
});

test("syncReviewCommentsFromDocx updates accepted Word computed plot label caption edits", () => {
  const source = `# Review

::computed_plot{id="projection" label="Old projection" formula="x * 2" domain="x:0..2"}
::
`;
  const reviewed = parse(`# Review

::computed_plot{id="projection" label="Updated projection" formula="x * 2" domain="x:0..2"}
::
`);

  const result = syncReviewCommentsFromDocx(source, renderDocx(reviewed));

  assert.deepEqual(result.changes, [
    { action: "update_caption", id: "projection", nativeId: "0", key: "label" },
  ]);
  assert.match(result.source, /::computed_plot\{id="projection" label="Updated projection" formula="x \* 2" domain="x:0\.\.2"\}/);
  assert.equal(result.skippedCaptions.length, 0);
});

test("syncReviewCommentsFromDocx updates accepted Word computed plot name caption edits", () => {
  const source = `# Review

::computed_plot{id="projection" name="Old projection" formula="x * 2" domain="x:0..2"}
::
`;
  const reviewed = parse(`# Review

::computed_plot{id="projection" name="Updated projection" formula="x * 2" domain="x:0..2"}
::
`);

  const result = syncReviewCommentsFromDocx(source, renderDocx(reviewed));

  assert.deepEqual(result.changes, [
    { action: "update_caption", id: "projection", nativeId: "0", key: "name" },
  ]);
  assert.match(result.source, /::computed_plot\{id="projection" name="Updated projection" formula="x \* 2" domain="x:0\.\.2"\}/);
  assert.equal(result.skippedCaptions.length, 0);
});

test("syncReviewCommentsFromDocx updates accepted Word computed plot body-label caption edits", () => {
  const source = `# Review

::computed_plot{id="projection" formula="x * 2" domain="x:0..2"}
label: Old projection
Reviewed as a static Word chart.
::
`;
  const reviewed = parse(`# Review

::computed_plot{id="projection" formula="x * 2" domain="x:0..2"}
label: Updated projection
Reviewed as a static Word chart.
::
`);

  const result = syncReviewCommentsFromDocx(source, renderDocx(reviewed));

  assert.deepEqual(result.changes, [
    { action: "update_caption", id: "projection", nativeId: "0", key: "label" },
  ]);
  assert.match(result.source, /label: Updated projection/);
  assert.match(result.source, /Reviewed as a static Word chart\./);
  assert.doesNotMatch(result.source, /label: Old projection/);
  assert.equal(result.skippedCaptions.length, 0);
});

test("syncReviewCommentsFromDocx does not rewrite unchanged rich captions", () => {
  const source = `# Review

::table{id="metrics" title="Quarterly **metrics**" header}
| Metric | Value |
| ARR | 10m |
::

::figure{id="diagram" caption="Architecture **diagram**" alt="Diagram"}
::

::plot{id="growth" title="Revenue **trend**" type="line" data="1,2,3"}
::

::computed_plot{id="projection" label="Scenario **projection**" formula="x * 2" domain="x:0..2"}
::
`;

  const result = syncReviewCommentsFromDocx(source, renderDocx(parse(source)));

  assert.deepEqual(result.changes, []);
  assert.equal(result.source, source);
  assert.equal(result.skippedCaptions.length, 0);
});

test("syncReviewCommentsFromDocx updates accepted Word metric label edits", () => {
  const source = `# Review

::metric{id="arr" label="Old ARR" value="10" unit="M"}
::
`;
  const reviewed = parse(`# Review

::metric{id="arr" label="Updated ARR" value="10" unit="M"}
::
`);

  const result = syncReviewCommentsFromDocx(source, renderDocx(reviewed));

  assert.deepEqual(result.changes, [
    { action: "update_label", id: "arr", nativeId: "0", key: "label" },
  ]);
  assert.match(result.source, /::metric\{id="arr" label="Updated ARR" value="10" unit="M"\}/);
  assert.equal(result.skippedLabels.length, 0);
});

test("syncReviewCommentsFromDocx updates accepted Word control label edits", () => {
  const source = `# Form

::control{id="growth" type="number" default=8 label="Old growth"}
::

::control{id="margin" type="slider" default=4 Label="Old margin"}
::
`;
  const reviewed = parse(`# Form

::control{id="growth" type="number" default=8 label="Updated growth"}
::

::control{id="margin" type="slider" default=4 Label="Updated margin"}
::
`);

  const result = syncReviewCommentsFromDocx(source, renderDocx(reviewed));

  assert.deepEqual(result.changes, [
    { action: "update_label", id: "growth", nativeId: "0", key: "label" },
    { action: "update_label", id: "margin", nativeId: "1", key: "Label" },
  ]);
  assert.match(result.source, /::control\{id="growth" type="number" default=8 label="Updated growth"\}/);
  assert.match(result.source, /::control\{id="margin" type="slider" default=4 Label="Updated margin"\}/);
  assert.equal(result.skippedLabels.length, 0);
});

test("syncReviewCommentsFromDocx does not rewrite unchanged rich metric and control labels", () => {
  const source = `# Review

::metric{id="arr" label="Net **ARR**" value="10" unit="M"}
::

::control{id="growth" type="number" default=8 label="Growth **rate**"}
::

::computed_metric{id="year-5" label="Year **5** revenue" formula="2 + 2"}
::

::computed_metric{id="body-year" formula="2 + 2"}
label: Body **metric**
Source note.
::
`;

  const result = syncReviewCommentsFromDocx(source, renderDocx(parse(source)));

  assert.deepEqual(result.changes, []);
  assert.equal(result.source, source);
  assert.equal(result.skippedLabels.length, 0);
});

test("syncReviewCommentsFromDocx adds control label attrs for accepted default label edits", () => {
  const source = `# Form

::control{id="growth" type="number" default=8}
::
`;
  const reviewed = parse(`# Form

::control{id="growth" type="number" default=8 label="Growth rate"}
::
`);

  const result = syncReviewCommentsFromDocx(source, renderDocx(reviewed));

  assert.deepEqual(result.changes, [
    { action: "update_label", id: "growth", nativeId: "0", key: "label" },
  ]);
  assert.match(result.source, /::control\{id="growth" type="number" default=8 label="Growth rate"\}/);
  assert.equal(result.skippedLabels.length, 0);
});

test("syncReviewCommentsFromDocx updates accepted Word action label edits", () => {
  const source = `# Actions

::button{id="cta" href="https://example.com" label="Start"}
::

::export_button{id="copy" format="prompt" target="cta" Label="Copy"}
::
`;
  const reviewed = parse(`# Actions

::button{id="cta" href="https://example.com" label="Launch"}
::

::export_button{id="copy" format="prompt" target="cta" Label="Copy prompt"}
::
`);

  const result = syncReviewCommentsFromDocx(source, renderDocx(reviewed));

  assert.deepEqual(result.changes, [
    { action: "update_label", id: "cta", nativeId: "0", key: "label" },
    { action: "update_label", id: "copy", nativeId: "1", key: "Label" },
  ]);
  assert.match(result.source, /::button\{id="cta" href="https:\/\/example\.com" label="Launch"\}/);
  assert.match(result.source, /::export_button\{id="copy" format="prompt" target="cta" Label="Copy prompt"\}/);
  assert.equal(result.skippedLabels.length, 0);
});

test("syncReviewCommentsFromDocx preserves rich accepted Word action label edits without generated hyperlink targets", () => {
  const source = `# Actions

::button{id="cta" href="https://example.com" label="Start now"}
::

::export_button{id="copy" format="prompt" target="cta" Label="Copy prompt"}
::
`;
  const entries = Object.fromEntries(
    [...readDocxZipEntries(renderDocx(parse(source)))].map(([name, data]) => [name, data.toString("utf8")]),
  );
  const documentXml = entries["word/document.xml"];
  assert.ok(documentXml);
  const buttonLink = /<w:hyperlink r:id="([^"]+)" w:history="1"><w:r><w:rPr><w:u w:val="single"\/><w:color w:val="0563C1"\/><\/w:rPr><w:t xml:space="preserve">Start now<\/w:t><\/w:r><\/w:hyperlink>/;
  assert.ok(buttonLink.test(documentXml));
  const exportLabel = `<w:r><w:rPr><w:color w:val="2B5265"/></w:rPr><w:t xml:space="preserve">Export action: Copy prompt</w:t></w:r>`;
  assert.ok(documentXml.includes(exportLabel));
  entries["word/document.xml"] = documentXml
    .replace(
      buttonLink,
      (_match, relId) => `<w:hyperlink r:id="${relId}" w:history="1"><w:r><w:rPr><w:b/><w:u w:val="single"/><w:color w:val="0563C1"/></w:rPr><w:t xml:space="preserve">Start </w:t></w:r><w:r><w:rPr><w:b/><w:i/><w:u w:val="single"/><w:color w:val="0563C1"/></w:rPr><w:t>now</w:t></w:r></w:hyperlink>`,
    )
    .replace(
      exportLabel,
      `<w:r><w:rPr><w:color w:val="2B5265"/></w:rPr><w:t xml:space="preserve">Export action: Copy </w:t></w:r><w:r><w:rPr><w:i/><w:color w:val="2B5265"/></w:rPr><w:t>prompt</w:t></w:r>`,
    );

  const result = syncReviewCommentsFromDocx(source, storedDocx(entries));

  assert.deepEqual(result.changes, [
    { action: "update_label", id: "cta", nativeId: "0", key: "label" },
    { action: "update_label", id: "copy", nativeId: "1", key: "Label" },
  ]);
  assert.match(result.source, /::button\{id="cta" href="https:\/\/example\.com" label="Start \*now\*"\}/);
  assert.match(result.source, /::export_button\{id="copy" format="prompt" target="cta" Label="Copy \*prompt\*"\}/);
  assert.doesNotMatch(result.source, /\[Start \*now\*\]\(https:\/\/example\.com\)/);
  assert.equal(result.skippedLabels.length, 0);
});

test("syncReviewCommentsFromDocx preserves mixed Word action label bold as authored Markdown", () => {
  const source = `# Actions

::button{id="cta" href="https://example.com" label="Start now"}
::

::export_button{id="copy" format="prompt" target="cta" Label="Copy prompt"}
::
`;
  const entries = Object.fromEntries(
    [...readDocxZipEntries(renderDocx(parse(source)))].map(([name, data]) => [name, data.toString("utf8")]),
  );
  const documentXml = entries["word/document.xml"];
  assert.ok(documentXml);
  const buttonLink = /<w:hyperlink r:id="([^"]+)" w:history="1"><w:r><w:rPr><w:u w:val="single"\/><w:color w:val="0563C1"\/><\/w:rPr><w:t xml:space="preserve">Start now<\/w:t><\/w:r><\/w:hyperlink>/;
  assert.ok(buttonLink.test(documentXml));
  const exportLabel = `<w:r><w:rPr><w:color w:val="2B5265"/></w:rPr><w:t xml:space="preserve">Export action: Copy prompt</w:t></w:r>`;
  assert.ok(documentXml.includes(exportLabel));
  entries["word/document.xml"] = documentXml
    .replace(
      buttonLink,
      (_match, relId) => `<w:hyperlink r:id="${relId}" w:history="1"><w:r><w:rPr><w:u w:val="single"/><w:color w:val="0563C1"/></w:rPr><w:t xml:space="preserve">Start </w:t></w:r><w:r><w:rPr><w:b/><w:u w:val="single"/><w:color w:val="0563C1"/></w:rPr><w:t>now</w:t></w:r></w:hyperlink>`,
    )
    .replace(
      exportLabel,
      `<w:r><w:rPr><w:color w:val="2B5265"/></w:rPr><w:t xml:space="preserve">Export action: Copy </w:t></w:r><w:r><w:rPr><w:b/><w:color w:val="2B5265"/></w:rPr><w:t>prompt</w:t></w:r>`,
    );

  const result = syncReviewCommentsFromDocx(source, storedDocx(entries));

  assert.deepEqual(result.changes, [
    { action: "update_label", id: "cta", nativeId: "0", key: "label" },
    { action: "update_label", id: "copy", nativeId: "1", key: "Label" },
  ]);
  assert.match(result.source, /::button\{id="cta" href="https:\/\/example\.com" label="Start \*\*now\*\*"\}/);
  assert.match(result.source, /::export_button\{id="copy" format="prompt" target="cta" Label="Copy \*\*prompt\*\*"\}/);
  assert.doesNotMatch(result.source, /\[Start \*\*now\*\*\]\(https:\/\/example\.com\)/);
  assert.equal(result.skippedLabels.length, 0);
});

test("syncReviewCommentsFromDocx does not rewrite unchanged rich action labels", () => {
  const source = `# Actions

::button{id="cta" href="https://example.com" label="Start **now**"}
::

::export_button{id="copy" format="prompt" target="cta" Label="Copy **prompt**"}
::
`;

  const result = syncReviewCommentsFromDocx(source, renderDocx(parse(source)));

  assert.deepEqual(result.changes, []);
  assert.equal(result.source, source);
  assert.equal(result.skippedLabels.length, 0);
});

test("syncReviewCommentsFromDocx updates accepted Word action body-label edits", () => {
  const source = `# Actions

::button{id="cta" href="https://example.com"}
Label: Start
::
`;
  const reviewed = parse(`# Actions

::button{id="cta" href="https://example.com"}
Label: Launch
::
`);

  const result = syncReviewCommentsFromDocx(source, renderDocx(reviewed));

  assert.deepEqual(result.changes, [
    { action: "update_label", id: "cta", nativeId: "0", key: "label" },
  ]);
  assert.match(result.source, /Label: Launch/);
  assert.doesNotMatch(result.source, /Label: Start/);
  assert.equal(result.skippedLabels.length, 0);
});

test("syncReviewCommentsFromDocx adds action label attrs for accepted fallback label edits", () => {
  const source = `# Actions

::button{id="cta" href="https://example.com"}
::

::export_button{id="copy" format="prompt" target="cta"}
::
`;
  const reviewed = parse(`# Actions

::button{id="cta" href="https://example.com" label="Launch"}
::

::export_button{id="copy" format="prompt" target="cta" label="Copy prompt"}
::
`);

  const result = syncReviewCommentsFromDocx(source, renderDocx(reviewed));

  assert.deepEqual(result.changes, [
    { action: "update_label", id: "cta", nativeId: "0", key: "label" },
    { action: "update_label", id: "copy", nativeId: "1", key: "label" },
  ]);
  assert.match(result.source, /::button\{id="cta" href="https:\/\/example\.com" label="Launch"\}/);
  assert.match(result.source, /::export_button\{id="copy" format="prompt" target="cta" label="Copy prompt"\}/);
  assert.equal(result.skippedLabels.length, 0);
});

test("syncReviewCommentsFromDocx updates accepted Word block title edits", () => {
  const source = `# Panels

::card{id="plan" title="Old plan"}
Body.
::

::callout{id="warning" tone="warning" title="Old warning"}
Body.
::

::memory{id="memory1" type="user" title="Old memory"}
Body.
::

::api{id="api" title="Old API"}
Body.
::

::parameter{id="limit" name="oldLimit" type="number"}
Body.
::
`;
  const reviewed = parse(`# Panels

::card{id="plan" title="New plan"}
Body.
::

::callout{id="warning" tone="warning" title="New warning"}
Body.
::

::memory{id="memory1" type="user" title="New memory"}
Body.
::

::api{id="api" title="New API"}
Body.
::

::parameter{id="limit" name="newLimit" type="number"}
Body.
::
`);

  const result = syncReviewCommentsFromDocx(source, renderDocx(reviewed));

  assert.deepEqual(result.changes, [
    { action: "update_block_title", id: "plan", nativeId: "0", key: "title" },
    { action: "update_block_title", id: "warning", nativeId: "1", key: "title" },
    { action: "update_block_title", id: "memory1", nativeId: "2", key: "title" },
    { action: "update_block_title", id: "api", nativeId: "3", key: "title" },
    { action: "update_block_title", id: "limit", nativeId: "4", key: "name" },
  ]);
  assert.match(result.source, /::card\{id="plan" title="New plan"\}/);
  assert.match(result.source, /::callout\{id="warning" tone="warning" title="New warning"\}/);
  assert.match(result.source, /::memory\{id="memory1" type="user" title="New memory"\}/);
  assert.match(result.source, /::api\{id="api" title="New API"\}/);
  assert.match(result.source, /::parameter\{id="limit" name="newLimit" type="number"\}/);
  assert.equal(result.skippedLabels.length, 0);
});

test("syncReviewCommentsFromDocx does not rewrite unchanged rich block titles", () => {
  const source = `# Panels

::card{id="plan" title="Launch **plan**"}
Body.
::

::callout{id="warning" tone="warning" title="Risk **warning**"}
Body.
::

::memory{id="memory1" type="user" title="User **memory**"}
Body.
::

::api{id="api" title="API **surface**"}
Body.
::
`;

  const result = syncReviewCommentsFromDocx(source, renderDocx(parse(source)));

  assert.deepEqual(result.changes, []);
  assert.equal(result.source, source);
  assert.equal(result.skippedLabels.length, 0);
});

test("syncReviewCommentsFromDocx adds title attrs for accepted fallback block title edits", () => {
  const source = `# Panels

::card{id="plan"}
Body.
::

::callout{id="warning" tone="warning"}
Body.
::
`;
  const reviewed = parse(`# Panels

::card{id="plan" title="New plan"}
Body.
::

::callout{id="warning" tone="warning" title="New warning"}
Body.
::
`);

  const result = syncReviewCommentsFromDocx(source, renderDocx(reviewed));

  assert.deepEqual(result.changes, [
    { action: "update_block_title", id: "plan", nativeId: "0", key: "title" },
    { action: "update_block_title", id: "warning", nativeId: "1", key: "title" },
  ]);
  assert.match(result.source, /::card\{id="plan" title="New plan"\}/);
  assert.match(result.source, /::callout\{id="warning" tone="warning" title="New warning"\}/);
  assert.equal(result.skippedLabels.length, 0);
});

test("syncReviewCommentsFromDocx adds title attrs for accepted custom fallback title edits", () => {
  const source = `# Pack

::finance::position{id="pos-a" asset_class="equity"}
Initial thesis.
::

::custom_directive{id="custom-block" last_seen="2026-05-24" noverify}
Custom block note.
::
`;
  const reviewed = parse(`# Pack

::finance::position{id="pos-a" asset_class="equity" title="Updated thesis"}
Initial thesis.
::

::custom_directive{id="custom-block" last_seen="2026-05-24" noverify title="Reviewed custom"}
Custom block note.
::
`);

  const result = syncReviewCommentsFromDocx(source, renderDocx(reviewed));

  assert.deepEqual(result.changes, [
    { action: "update_block_title", id: "pos-a", nativeId: "0", key: "title" },
    { action: "update_block_title", id: "custom-block", nativeId: "1", key: "title" },
  ]);
  assert.match(result.source, /::finance::position\{id="pos-a" asset_class="equity" title="Updated thesis"\}/);
  assert.match(result.source, /::custom_directive\{id="custom-block" last_seen="2026-05-24" noverify title="Reviewed custom"\}/);
  assert.equal(result.skippedLabels.length, 0);
});

test("syncReviewCommentsFromDocx updates custom fallback heading metadata edits", () => {
  const source = `# Pack

::finance::position{id="pos-a" asset_class="equity" region="EU"}
Initial thesis.
::

::custom_directive{id="custom-block" last_seen="2026-05-24" noverify}
Custom block note.
::
`;
  const reviewed = parse(`# Pack

::finance::position{id="pos-a" asset_class="credit" priority="high"}
Initial thesis.
::

::custom_directive{id="custom-block" last_seen="2026-05-25" noverify title="Reviewed custom"}
Custom block note.
::
`);

  const result = syncReviewCommentsFromDocx(source, renderDocx(reviewed));

  assert.deepEqual(result.changes, [
    { action: "update_block_metadata", id: "pos-a", nativeId: "0", key: "asset_class" },
    { action: "update_block_metadata", id: "pos-a", nativeId: "0", key: "priority" },
    { action: "delete_block_metadata", id: "pos-a", nativeId: "0", key: "region" },
    { action: "update_block_metadata", id: "custom-block", nativeId: "1", key: "last_seen" },
    { action: "update_block_title", id: "custom-block", nativeId: "1", key: "title" },
  ]);
  assert.match(result.source, /::finance::position\{id="pos-a" asset_class="credit" priority="high"\}/);
  assert.doesNotMatch(result.source, /title="Finance position/);
  assert.doesNotMatch(result.source, /region="EU"/);
  assert.match(result.source, /::custom_directive\{id="custom-block" last_seen="2026-05-25" noverify title="Reviewed custom"\}/);
  assert.equal(result.skippedLabels.length, 0);
});

test("syncReviewCommentsFromDocx deletes custom fallback metadata when the heading summary is removed", () => {
  const source = `# Pack

::finance::position{id="pos-a" asset_class="equity" region="EU"}
Initial thesis.
::

::custom_directive{id="custom-block" last_seen="2026-05-24" noverify title="Reviewed custom"}
Custom block note.
::
`;
  const reviewed = parse(`# Pack

::finance::position{id="pos-a"}
Initial thesis.
::

::custom_directive{id="custom-block" title="Reviewed custom"}
Custom block note.
::
`);

  const result = syncReviewCommentsFromDocx(source, renderDocx(reviewed));

  assert.deepEqual(result.changes, [
    { action: "delete_block_metadata", id: "pos-a", nativeId: "0", key: "asset_class" },
    { action: "delete_block_metadata", id: "pos-a", nativeId: "0", key: "region" },
    { action: "delete_block_metadata", id: "custom-block", nativeId: "1", key: "last_seen" },
    { action: "delete_block_metadata", id: "custom-block", nativeId: "1", key: "noverify" },
  ]);
  assert.match(result.source, /::finance::position\{id="pos-a"\}/);
  assert.match(result.source, /::custom_directive\{id="custom-block" title="Reviewed custom"\}/);
  assert.doesNotMatch(result.source, /asset_class|region|last_seen|noverify/);
  assert.equal(result.skippedLabels.length, 0);
});

test("syncReviewCommentsFromDocx preserves comma-bearing custom fallback metadata values", () => {
  const source = `# Pack

::finance::position{id="pos-a" note="A, B" region="EU"}
Initial thesis.
::
`;
  const reviewed = parse(`# Pack

::finance::position{id="pos-a" note="A, B" region="US" priority="high"}
Initial thesis.
::
`);

  const result = syncReviewCommentsFromDocx(source, renderDocx(reviewed));

  assert.deepEqual(result.changes, [
    { action: "update_block_metadata", id: "pos-a", nativeId: "0", key: "region" },
    { action: "update_block_metadata", id: "pos-a", nativeId: "0", key: "priority" },
  ]);
  assert.match(result.source, /::finance::position\{id="pos-a" note="A, B" region="US" priority="high"\}/);
  assert.doesNotMatch(result.source, /title="Finance position/);
  assert.equal(result.skippedLabels.length, 0);
});

test("syncReviewCommentsFromDocx adds metric label attrs for accepted default label edits", () => {
  const source = `# Review

::metric{id="arr" value="10" unit="M"}
::
`;
  const reviewed = parse(`# Review

::metric{id="arr" label="Updated ARR" value="10" unit="M"}
::
`);

  const result = syncReviewCommentsFromDocx(source, renderDocx(reviewed));

  assert.deepEqual(result.changes, [
    { action: "update_label", id: "arr", nativeId: "0", key: "label" },
  ]);
  assert.match(result.source, /::metric\{id="arr" value="10" unit="M" label="Updated ARR"\}/);
  assert.equal(result.skippedLabels.length, 0);
});

test("syncReviewCommentsFromDocx updates accepted Word computed metric body-label edits", () => {
  const source = `# Review

::computed_metric{id="year-5" formula="2 + 2"}
label: Old year 5
Source note.
::
`;
  const reviewed = parse(`# Review

::computed_metric{id="year-5" formula="2 + 2"}
label: Updated year 5
Source note.
::
`);

  const result = syncReviewCommentsFromDocx(source, renderDocx(reviewed));

  assert.deepEqual(result.changes, [
    { action: "update_label", id: "year-5", nativeId: "0", key: "label" },
  ]);
  assert.match(result.source, /label: Updated year 5/);
  assert.match(result.source, /Source note\./);
  assert.doesNotMatch(result.source, /label: Old year 5/);
  assert.equal(result.skippedLabels.length, 0);
});

test("syncReviewCommentsFromDocx adds computed metric label attrs for accepted default label edits", () => {
  const source = `# Review

::computed_metric{id="year-5" formula="2 + 2"}
::
`;
  const reviewed = parse(`# Review

::computed_metric{id="year-5" label="Updated year 5" formula="2 + 2"}
::
`);

  const result = syncReviewCommentsFromDocx(source, renderDocx(reviewed));

  assert.deepEqual(result.changes, [
    { action: "update_label", id: "year-5", nativeId: "0", key: "label" },
  ]);
  assert.match(result.source, /::computed_metric\{id="year-5" formula="2 \+ 2" label="Updated year 5"\}/);
  assert.equal(result.skippedLabels.length, 0);
});

test("syncReviewCommentsFromDocx updates accepted Word metric value edits", () => {
  const source = `# Review

::metric{id="arr" label="ARR" value="10" unit="M"}
::
`;
  const reviewed = parse(`# Review

::metric{id="arr" label="ARR" value="12" unit="M"}
::
`);

  const result = syncReviewCommentsFromDocx(source, renderDocx(reviewed));

  assert.deepEqual(result.changes, [
    { action: "update_metric_value", id: "arr", nativeId: "0", key: "value" },
  ]);
  assert.match(result.source, /::metric\{id="arr" label="ARR" value="12" unit="M"\}/);
  assert.equal(result.skippedMetricValues.length, 0);
});

test("syncReviewCommentsFromDocx does not rewrite unchanged rich metric values", () => {
  const source = `# Review

::metric{id="arr" label="ARR" value="**10**" unit="M"}
::

::metric{id="pipeline" label="Pipeline" unit="M"}
\`42\`
::
`;

  const result = syncReviewCommentsFromDocx(source, renderDocx(parse(source)));

  assert.deepEqual(result.changes, []);
  assert.equal(result.source, source);
  assert.equal(result.skippedMetricValues.length, 0);
});

test("syncReviewCommentsFromDocx updates accepted Word metric body-value edits", () => {
  const source = `# Review

::metric{id="pipeline" label="Pipeline" unit="%"}
10
::
`;
  const reviewed = parse(`# Review

::metric{id="pipeline" label="Pipeline" unit="%"}
12
::
`);

  const result = syncReviewCommentsFromDocx(source, renderDocx(reviewed));

  assert.deepEqual(result.changes, [
    { action: "update_metric_value", id: "pipeline", nativeId: "0", key: "body" },
  ]);
  assert.match(result.source, /::metric\{id="pipeline" label="Pipeline" unit="%"\}\n12\n::/);
  assert.equal(result.skippedMetricValues.length, 0);
});

test("syncReviewCommentsFromDocx removes metric unit attrs when accepted Word value edits delete the unit", () => {
  const source = `# Review

::metric{id="arr" label="ARR" value="10" unit="M"}
::
`;
  const reviewed = parse(`# Review

::metric{id="arr" label="ARR" value="12"}
::
`);

  const result = syncReviewCommentsFromDocx(source, renderDocx(reviewed));

  assert.deepEqual(result.changes, [
    { action: "update_metric_value", id: "arr", nativeId: "0", key: "value" },
  ]);
  assert.match(result.source, /::metric\{id="arr" label="ARR" value="12"\}/);
  assert.doesNotMatch(result.source, /unit="M"/);
  assert.equal(result.skippedMetricValues.length, 0);
});

test("syncReviewCommentsFromDocx updates accepted Word metric metadata edits", () => {
  const source = `# Review

::metric{id="arr" label="ARR" value="10" unit="M" status="draft" trend="up" delta="2" target="15" source="crm" asOf="2026-05-01"}
::
`;
  const reviewed = parse(`# Review

::metric{id="arr" label="ARR" value="10" unit="M" status="approved" trend="flat" delta="3" target="18" source="erp" asOf="2026-05-15"}
::
`);

  const result = syncReviewCommentsFromDocx(source, renderDocx(reviewed));

  assert.deepEqual(result.changes, [
    { action: "update_metric_metadata", id: "arr", nativeId: "0", key: "status" },
    { action: "update_metric_metadata", id: "arr", nativeId: "0", key: "trend" },
    { action: "update_metric_metadata", id: "arr", nativeId: "0", key: "delta" },
    { action: "update_metric_metadata", id: "arr", nativeId: "0", key: "target" },
    { action: "update_metric_metadata", id: "arr", nativeId: "0", key: "source" },
    { action: "update_metric_metadata", id: "arr", nativeId: "0", key: "asOf" },
  ]);
  assert.match(result.source, /status="approved"/);
  assert.match(result.source, /trend="flat"/);
  assert.match(result.source, /delta="3"/);
  assert.match(result.source, /target="18"/);
  assert.match(result.source, /source="erp"/);
  assert.match(result.source, /asOf="2026-05-15"/);
  assert.equal(result.skippedMetricMetadata.length, 0);
});

test("syncReviewCommentsFromDocx preserves metadata values containing Word separators", () => {
  const source = `# Review

::metric{id="arr" label="ARR" value="10" source="CRM · status: stale" status="draft"}
::

::risk{id="risk1" owner="Ops · Q1: Finance" status="open"}
Mitigate.
::
`;
  const reviewed = parse(`# Review

::metric{id="arr" label="ARR" value="10" source="CRM · status: stale" status="approved"}
::

::risk{id="risk1" owner="Ops · Q1: Finance" status="mitigated"}
Mitigate.
::
`);

  const result = syncReviewCommentsFromDocx(source, renderDocx(reviewed));

  assert.deepEqual(result.changes, [
    { action: "update_metric_metadata", id: "arr", nativeId: "0", key: "status" },
    { action: "update_block_metadata", id: "risk1", nativeId: "0", key: "status" },
  ]);
  assert.match(result.source, /source="CRM · status: stale" status="approved"/);
  assert.match(result.source, /owner="Ops · Q1: Finance" status="mitigated"/);
  assert.doesNotMatch(result.source, /source="CRM"/);
  assert.doesNotMatch(result.source, /owner="Ops"/);
  assert.equal(result.skippedMetricMetadata.length, 0);
  assert.equal(result.skippedBlockMetadata.length, 0);
});

test("syncReviewCommentsFromDocx preserves metadata values when Word isolates separator runs", () => {
  const source = `# Review

::metric{id="arr" label="ARR" value="10" source="CRM · status: stale" status="draft"}
::

::risk{id="risk1" owner="Ops · Q1: Finance" status="open"}
Mitigate.
::
`;
  const reviewed = parse(`# Review

::metric{id="arr" label="ARR" value="10" source="CRM · status: stale" status="approved"}
::

::risk{id="risk1" owner="Ops · Q1: Finance" status="mitigated"}
Mitigate.
::
`);

  const result = syncReviewCommentsFromDocx(source, docxWithIsolatedMetadataValueSeparators(renderDocx(reviewed)));

  assert.deepEqual(result.changes, [
    { action: "update_metric_metadata", id: "arr", nativeId: "0", key: "status" },
    { action: "update_block_metadata", id: "risk1", nativeId: "0", key: "status" },
  ]);
  assert.match(result.source, /source="CRM · status: stale" status="approved"/);
  assert.match(result.source, /owner="Ops · Q1: Finance" status="mitigated"/);
  assert.doesNotMatch(result.source, /source="CRM"/);
  assert.doesNotMatch(result.source, /owner="Ops"/);
  assert.equal(result.skippedMetricMetadata.length, 0);
  assert.equal(result.skippedBlockMetadata.length, 0);
});

test("syncReviewCommentsFromDocx removes accepted deleted Word metric metadata fields", () => {
  const source = `# Review

::metric{id="arr" label="ARR" value="10" unit="M" status="draft" trend="up"}
::
`;
  const reviewed = parse(`# Review

::metric{id="arr" label="ARR" value="10" unit="M" trend="up"}
::
`);

  const result = syncReviewCommentsFromDocx(source, renderDocx(reviewed));

  assert.deepEqual(result.changes, [
    { action: "delete_metric_metadata", id: "arr", nativeId: "0", key: "status" },
  ]);
  assert.doesNotMatch(result.source, /status="draft"/);
  assert.match(result.source, /trend="up"/);
  assert.equal(result.skippedMetricMetadata.length, 0);
});

test("syncReviewCommentsFromDocx adds accepted Word metric metadata fields", () => {
  const source = `# Review

::metric{id="arr" label="ARR" value="10" unit="M" trend="up"}
::
`;
  const reviewed = parse(`# Review

::metric{id="arr" label="ARR" value="10" unit="M" status="approved" trend="up"}
::
`);

  const result = syncReviewCommentsFromDocx(source, renderDocx(reviewed));

  assert.deepEqual(result.changes, [
    { action: "update_metric_metadata", id: "arr", nativeId: "0", key: "status" },
  ]);
  assert.match(result.source, /status="approved"/);
  assert.match(result.source, /trend="up"/);
  assert.equal(result.skippedMetricMetadata.length, 0);
});

test("syncReviewCommentsFromDocx updates accepted Word block metadata edits", () => {
  const source = `# Review

::risk{id="risk1" severity="high" owner="Ops" status="open"}
Mitigate.
::

::review{id="review1" for="risk1" status="needs_changes" author="Andrea" due_at="2026-06-01"}
Check it.
::
`;
  const reviewed = parse(`# Review

::risk{id="risk1" severity="medium" owner="Finance" status="mitigated"}
Mitigate.
::

::review{id="review1" for="risk1" status="approved" author="Bianca" due_at="2026-06-15"}
Check it.
::
`);

  const result = syncReviewCommentsFromDocx(source, renderDocx(reviewed));

  assert.deepEqual(result.changes, [
    { action: "update_block_metadata", id: "risk1", nativeId: "0", key: "severity" },
    { action: "update_block_metadata", id: "risk1", nativeId: "0", key: "owner" },
    { action: "update_block_metadata", id: "risk1", nativeId: "0", key: "status" },
    { action: "update_block_metadata", id: "review1", nativeId: "1", key: "status" },
    { action: "update_block_metadata", id: "review1", nativeId: "1", key: "author" },
    { action: "update_block_metadata", id: "review1", nativeId: "1", key: "due_at" },
  ]);
  assert.match(result.source, /severity="medium"/);
  assert.match(result.source, /owner="Finance"/);
  assert.match(result.source, /status="mitigated"/);
  assert.match(result.source, /::review\{id="review1" for="risk1" status="approved" author="Bianca" due_at="2026-06-15"\}/);
  assert.equal(result.skippedBlockMetadata.length, 0);
});

test("syncReviewCommentsFromDocx removes accepted deleted Word block metadata fields", () => {
  const source = `# Review

::risk{id="risk1" severity="high" owner="Ops" status="open"}
Mitigate.
::
`;
  const reviewed = parse(`# Review

::risk{id="risk1" status="open"}
Mitigate.
::
`);

  const result = syncReviewCommentsFromDocx(source, renderDocx(reviewed));

  assert.deepEqual(result.changes, [
    { action: "delete_block_metadata", id: "risk1", nativeId: "0", key: "severity" },
    { action: "delete_block_metadata", id: "risk1", nativeId: "0", key: "owner" },
  ]);
  assert.doesNotMatch(result.source, /severity="high"/);
  assert.doesNotMatch(result.source, /owner="Ops"/);
  assert.match(result.source, /status="open"/);
  assert.equal(result.skippedBlockMetadata.length, 0);
});

test("syncReviewCommentsFromDocx adds accepted Word block metadata fields", () => {
  const source = `# Review

::risk{id="risk1"}
Mitigate.
::
`;
  const reviewed = parse(`# Review

::risk{id="risk1" owner="Finance" status="open"}
Mitigate.
::
`);

  const result = syncReviewCommentsFromDocx(source, renderDocx(reviewed));

  assert.deepEqual(result.changes, [
    { action: "update_block_metadata", id: "risk1", nativeId: "0", key: "owner" },
    { action: "update_block_metadata", id: "risk1", nativeId: "0", key: "status" },
  ]);
  assert.match(result.source, /owner="Finance"/);
  assert.match(result.source, /status="open"/);
  assert.equal(result.skippedBlockMetadata.length, 0);
});

test("syncReviewCommentsFromDocx updates accepted Word citation metadata edits", () => {
  const source = `# Review

::citation{id="cite1" source="Old source" accessed="2026-05-01" href="https://old.example/report" doi="10.1000/old"}
::
`;
  const reviewed = parse(`# Review

::citation{id="cite1" source="New source" accessed="2026-05-15" href="https://new.example/report" doi="10.1000/new"}
::
`);

  const result = syncReviewCommentsFromDocx(source, renderDocx(reviewed));

  assert.deepEqual(result.changes, [
    { action: "update_block_metadata", id: "cite1", nativeId: "0", key: "source" },
    { action: "update_block_metadata", id: "cite1", nativeId: "0", key: "accessed" },
    { action: "update_block_metadata", id: "cite1", nativeId: "0", key: "href" },
    { action: "update_block_metadata", id: "cite1", nativeId: "0", key: "doi" },
  ]);
  assert.match(result.source, /source="New source"/);
  assert.match(result.source, /accessed="2026-05-15"/);
  assert.match(result.source, /href="https:\/\/new\.example\/report"/);
  assert.match(result.source, /doi="10\.1000\/new"/);
  assert.equal(result.skippedBlockMetadata.length, 0);
});

test("syncReviewCommentsFromDocx removes accepted deleted Word citation metadata fields", () => {
  const source = `# Review

::citation{id="cite1" source="Vendor report" href="https://example.com/report" doi="10.1000/report"}
::
`;
  const reviewed = parse(`# Review

::citation{id="cite1" source="Vendor report" href="https://example.com/report"}
::
`);

  const result = syncReviewCommentsFromDocx(source, renderDocx(reviewed));

  assert.deepEqual(result.changes, [
    { action: "delete_block_metadata", id: "cite1", nativeId: "0", key: "doi" },
  ]);
  assert.match(result.source, /source="Vendor report"/);
  assert.match(result.source, /href="https:\/\/example\.com\/report"/);
  assert.doesNotMatch(result.source, /doi=/);
  assert.equal(result.skippedBlockMetadata.length, 0);
});

test("syncReviewCommentsFromDocx updates accepted Word technical metadata edits", () => {
  const source = `# API

::api{id="core-api" name="Core API" version="v1" baseUrl="https://old.example.com" status="beta" owner="Platform"}
::

::endpoint{id="list-users" method="GET" url="/users" auth="token" status="draft" api="core-api"}
::
`;
  const reviewed = parse(`# API

::api{id="core-api" name="Core API" version="v1" baseUrl="https://new.example.com" status="stable" owner="DX"}
::

::endpoint{id="list-users" method="POST" url="/v2/users" status="stable" api="core-v2"}
::
`);

  const result = syncReviewCommentsFromDocx(source, renderDocx(reviewed));

  assert.deepEqual(result.changes, [
    { action: "update_block_metadata", id: "core-api", nativeId: "0", key: "baseUrl" },
    { action: "update_block_metadata", id: "core-api", nativeId: "0", key: "status" },
    { action: "update_block_metadata", id: "core-api", nativeId: "0", key: "owner" },
    { action: "update_block_metadata", id: "list-users", nativeId: "1", key: "method" },
    { action: "update_block_metadata", id: "list-users", nativeId: "1", key: "url" },
    { action: "update_block_metadata", id: "list-users", nativeId: "1", key: "status" },
    { action: "update_block_metadata", id: "list-users", nativeId: "1", key: "api" },
    { action: "delete_block_metadata", id: "list-users", nativeId: "1", key: "auth" },
  ]);
  assert.match(result.source, /baseUrl="https:\/\/new\.example\.com"/);
  assert.match(result.source, /owner="DX"/);
  assert.match(result.source, /::endpoint\{id="list-users" method="POST" url="\/v2\/users" status="stable" api="core-v2"\}/);
  assert.doesNotMatch(result.source, /auth="token"/);
  assert.equal(result.skippedBlockMetadata.length, 0);
});

test("syncReviewCommentsFromDocx adds accepted Word technical metadata fields", () => {
  const source = `# API

::query{id="usage-query"}
select 1
::
`;
  const reviewed = parse(`# API

::query{id="usage-query" language="sql" dataset="warehouse" source="analytics" status="reviewed"}
select 1
::
`);

  const result = syncReviewCommentsFromDocx(source, renderDocx(reviewed));

  assert.deepEqual(result.changes, [
    { action: "update_block_metadata", id: "usage-query", nativeId: "0", key: "lang" },
    { action: "update_block_metadata", id: "usage-query", nativeId: "0", key: "dataset" },
    { action: "update_block_metadata", id: "usage-query", nativeId: "0", key: "source" },
    { action: "update_block_metadata", id: "usage-query", nativeId: "0", key: "status" },
  ]);
  assert.match(result.source, /::query\{id="usage-query" lang="sql" dataset="warehouse" source="analytics" status="reviewed"\}/);
  assert.equal(result.skippedBlockMetadata.length, 0);
});

test("syncReviewCommentsFromDocx updates accepted Word computation metadata edits", () => {
  const source = `# Compute

::code_cell{id="cell1" lang="ts" runtime="node" status="draft" count=1}
1 + 1
::

::output{id="out1" cell="cell1" status="stale" mime="text/plain"}
2
::
`;
  const reviewed = parse(`# Compute

::code_cell{id="cell1" lang="ts" runtime="deno" status="reviewed" count=2}
1 + 1
::

::output{id="out1" cell="cell2" status="fresh"}
2
::
`);

  const result = syncReviewCommentsFromDocx(source, renderDocx(reviewed));

  assert.deepEqual(result.changes, [
    { action: "update_block_metadata", id: "cell1", nativeId: "0", key: "runtime" },
    { action: "update_block_metadata", id: "cell1", nativeId: "0", key: "status" },
    { action: "update_block_metadata", id: "cell1", nativeId: "0", key: "count" },
    { action: "update_block_metadata", id: "out1", nativeId: "1", key: "cell" },
    { action: "update_block_metadata", id: "out1", nativeId: "1", key: "status" },
    { action: "delete_block_metadata", id: "out1", nativeId: "1", key: "mime" },
  ]);
  assert.match(result.source, /::code_cell\{id="cell1" lang="ts" runtime="deno" status="reviewed" count="2"\}/);
  assert.match(result.source, /::output\{id="out1" cell="cell2" status="fresh"\}/);
  assert.doesNotMatch(result.source, /mime="text\/plain"/);
  assert.equal(result.skippedBlockMetadata.length, 0);
});

test("syncReviewCommentsFromDocx adds accepted Word computation metadata fields", () => {
  const source = `# Compute

::code_cell{id="cell1"}
1 + 1
::

::output{id="out1"}
2
::
`;
  const reviewed = parse(`# Compute

::code_cell{id="cell1" kernel="node" status="reviewed" execution_count=7}
1 + 1
::

::output{id="out1" for="cell1" status="fresh" mime="application/json"}
2
::
`);

  const result = syncReviewCommentsFromDocx(source, renderDocx(reviewed));

  assert.deepEqual(result.changes, [
    { action: "update_block_metadata", id: "cell1", nativeId: "0", key: "kernel" },
    { action: "update_block_metadata", id: "cell1", nativeId: "0", key: "status" },
    { action: "update_block_metadata", id: "cell1", nativeId: "0", key: "execution_count" },
    { action: "update_block_metadata", id: "out1", nativeId: "1", key: "for" },
    { action: "update_block_metadata", id: "out1", nativeId: "1", key: "status" },
    { action: "update_block_metadata", id: "out1", nativeId: "1", key: "mime" },
  ]);
  assert.match(result.source, /::code_cell\{id="cell1" kernel="node" status="reviewed" execution_count="7"\}/);
  assert.match(result.source, /::output\{id="out1" for="cell1" status="fresh" mime="application\/json"\}/);
  assert.equal(result.skippedBlockMetadata.length, 0);
});

test("syncReviewCommentsFromDocx updates accepted Word computed metric metadata edits", () => {
  const source = `# Compute

::computed_metric{id="cm1" label="Revenue" formula="2 + 2" domain="x:0..2" suffix="M"}
::
`;
  const reviewed = parse(`# Compute

::computed_metric{id="cm1" label="Revenue" formula="3 + 3" domain="x:1..3"}
::
`);

  const result = syncReviewCommentsFromDocx(source, renderDocx(reviewed));

  assert.deepEqual(result.changes, [
    { action: "update_block_metadata", id: "cm1", nativeId: "0", key: "formula" },
    { action: "update_block_metadata", id: "cm1", nativeId: "0", key: "domain" },
    { action: "delete_block_metadata", id: "cm1", nativeId: "0", key: "suffix" },
  ]);
  assert.match(result.source, /::computed_metric\{id="cm1" label="Revenue" formula="3 \+ 3" domain="x:1\.\.3"\}/);
  assert.doesNotMatch(result.source, /suffix="M"/);
  assert.equal(result.skippedBlockMetadata.length, 0);
});

test("syncReviewCommentsFromDocx updates accepted Word computed metric body metadata edits", () => {
  const source = `# Compute

::computed_metric{id="cm-body" label="Body metric"}
formula: 2 + 2
range: x:0..2
unit: M
Notes stay.
::
`;
  const reviewed = parse(`# Compute

::computed_metric{id="cm-body" label="Body metric"}
formula: 3 + 3
range: x:1..3
Notes stay.
::
`);

  const result = syncReviewCommentsFromDocx(source, renderDocx(reviewed));

  assert.deepEqual(result.changes, [
    { action: "update_block_metadata", id: "cm-body", nativeId: "0", key: "formula" },
    { action: "update_block_metadata", id: "cm-body", nativeId: "0", key: "range" },
    { action: "delete_block_metadata", id: "cm-body", nativeId: "0", key: "unit" },
  ]);
  assert.match(result.source, /formula: 3 \+ 3/);
  assert.match(result.source, /range: x:1\.\.3/);
  assert.match(result.source, /Notes stay\./);
  assert.doesNotMatch(result.source, /^unit: M$/m);
  assert.equal(result.skippedBlockMetadata.length, 0);
});

test("syncReviewCommentsFromDocx adds accepted Word computed metric metadata fields", () => {
  const source = `# Compute

::computed_metric{id="cm1" label="Revenue"}
::
`;
  const reviewed = parse(`# Compute

::computed_metric{id="cm1" label="Revenue" formula="2 + 2" domain="x:0..2" unit="M"}
::
`);

  const result = syncReviewCommentsFromDocx(source, renderDocx(reviewed));

  assert.deepEqual(result.changes, [
    { action: "update_block_metadata", id: "cm1", nativeId: "0", key: "formula" },
    { action: "update_block_metadata", id: "cm1", nativeId: "0", key: "domain" },
    { action: "update_block_metadata", id: "cm1", nativeId: "0", key: "unit" },
  ]);
  assert.match(result.source, /::computed_metric\{id="cm1" label="Revenue" formula="2 \+ 2" domain="x:0\.\.2" unit="M"\}/);
  assert.equal(result.skippedBlockMetadata.length, 0);
});

test("syncReviewCommentsFromDocx updates accepted Word computed plot metadata edits", () => {
  const source = `# Compute

::computed_plot{id="cp1" label="Projection" formula="x * 2" domain="x:0..2" suffix="M"}
::
`;
  const reviewed = parse(`# Compute

::computed_plot{id="cp1" label="Projection" formula="x * 3" domain="x:1..3"}
::
`);

  const result = syncReviewCommentsFromDocx(source, renderDocx(reviewed));

  assert.deepEqual(result.changes, [
    { action: "update_block_metadata", id: "cp1", nativeId: "0", key: "formula" },
    { action: "update_block_metadata", id: "cp1", nativeId: "0", key: "domain" },
    { action: "delete_block_metadata", id: "cp1", nativeId: "0", key: "suffix" },
  ]);
  assert.match(result.source, /::computed_plot\{id="cp1" label="Projection" formula="x \* 3" domain="x:1\.\.3"\}/);
  assert.doesNotMatch(result.source, /suffix="M"/);
  assert.equal(result.skippedBlockMetadata.length, 0);
});

test("syncReviewCommentsFromDocx updates accepted Word computed plot body metadata edits", () => {
  const source = `# Compute

::computed_plot{id="cp-body" label="Projection"}
formula: x * 2
range: x:0..2
unit: M
Notes stay.
::
`;
  const reviewed = parse(`# Compute

::computed_plot{id="cp-body" label="Projection"}
formula: x * 3
range: x:1..3
Notes stay.
::
`);

  const result = syncReviewCommentsFromDocx(source, renderDocx(reviewed));

  assert.deepEqual(result.changes, [
    { action: "update_block_metadata", id: "cp-body", nativeId: "0", key: "formula" },
    { action: "update_block_metadata", id: "cp-body", nativeId: "0", key: "range" },
    { action: "delete_block_metadata", id: "cp-body", nativeId: "0", key: "unit" },
  ]);
  assert.match(result.source, /formula: x \* 3/);
  assert.match(result.source, /range: x:1\.\.3/);
  assert.match(result.source, /Notes stay\./);
  assert.doesNotMatch(result.source, /^unit: M$/m);
  assert.equal(result.skippedBlockMetadata.length, 0);
});

test("syncReviewCommentsFromDocx adds accepted Word computed plot metadata fields", () => {
  const source = `# Compute

::computed_plot{id="cp1" label="Projection"}
::
`;
  const reviewed = parse(`# Compute

::computed_plot{id="cp1" label="Projection" formula="x * 2" domain="x:0..2" unit="M"}
::
`);

  const result = syncReviewCommentsFromDocx(source, renderDocx(reviewed));

  assert.deepEqual(result.changes, [
    { action: "update_block_metadata", id: "cp1", nativeId: "0", key: "formula" },
    { action: "update_block_metadata", id: "cp1", nativeId: "0", key: "domain" },
    { action: "update_block_metadata", id: "cp1", nativeId: "0", key: "unit" },
  ]);
  assert.match(result.source, /::computed_plot\{id="cp1" label="Projection" formula="x \* 2" domain="x:0\.\.2" unit="M"\}/);
  assert.equal(result.skippedBlockMetadata.length, 0);
});

test("syncReviewCommentsFromDocx updates accepted Word control metadata edits", () => {
  const source = `# Form

::control{id="growth" type="slider" min=0 max=20 step=1 default=8 label="Growth"}
::
`;
  const reviewed = parse(`# Form

::control{id="growth" type="number" min=1 max=10 default=4.5 label="Growth"}
::
`);

  const result = syncReviewCommentsFromDocx(source, renderDocx(reviewed));

  assert.deepEqual(result.changes, [
    { action: "update_block_metadata", id: "growth", nativeId: "0", key: "type" },
    { action: "update_block_metadata", id: "growth", nativeId: "0", key: "default" },
    { action: "update_block_metadata", id: "growth", nativeId: "0", key: "min" },
    { action: "update_block_metadata", id: "growth", nativeId: "0", key: "max" },
    { action: "delete_block_metadata", id: "growth", nativeId: "0", key: "step" },
  ]);
  assert.match(result.source, /::control\{id="growth" type="number" min="1" max="10" default="4\.5" label="Growth"\}/);
  assert.doesNotMatch(result.source, /step=1/);
  assert.equal(result.skippedBlockMetadata.length, 0);
});

test("syncReviewCommentsFromDocx adds accepted Word control metadata fields", () => {
  const source = `# Form

::control{id="growth" label="Growth"}
::
`;
  const reviewed = parse(`# Form

::control{id="growth" type="slider" default=8 min=0 max=20 step=1 label="Growth"}
::
`);

  const result = syncReviewCommentsFromDocx(source, renderDocx(reviewed));

  assert.deepEqual(result.changes, [
    { action: "update_block_metadata", id: "growth", nativeId: "0", key: "type" },
    { action: "update_block_metadata", id: "growth", nativeId: "0", key: "default" },
    { action: "update_block_metadata", id: "growth", nativeId: "0", key: "min" },
    { action: "update_block_metadata", id: "growth", nativeId: "0", key: "max" },
    { action: "update_block_metadata", id: "growth", nativeId: "0", key: "step" },
  ]);
  assert.match(result.source, /::control\{id="growth" label="Growth" type="slider" default="8" min="0" max="20" step="1"\}/);
  assert.equal(result.skippedBlockMetadata.length, 0);
});

test("syncReviewCommentsFromDocx updates accepted Word memory metadata edits", () => {
  const source = `# Memory

::memory{id="m1" type="project" confidence=0.7 lastSeen="2026-05-01" scope="repo" source="brief" validUntil="2026-06-01" supersededBy="m2" expired}
Keep this.
::
`;
  const reviewed = parse(`# Memory

::memory{id="m1" type="reference" confidence=0.9 lastSeen="2026-05-15" scope="product" source="brief-v2" validUntil="2026-07-01" supersededBy="m3"}
Keep this.
::
`);

  const result = syncReviewCommentsFromDocx(source, renderDocx(reviewed));

  assert.deepEqual(result.changes, [
    { action: "update_block_metadata", id: "m1", nativeId: "0", key: "type" },
    { action: "update_block_metadata", id: "m1", nativeId: "0", key: "confidence" },
    { action: "update_block_metadata", id: "m1", nativeId: "0", key: "lastSeen" },
    { action: "update_block_metadata", id: "m1", nativeId: "0", key: "scope" },
    { action: "update_block_metadata", id: "m1", nativeId: "0", key: "source" },
    { action: "update_block_metadata", id: "m1", nativeId: "0", key: "validUntil" },
    { action: "update_block_metadata", id: "m1", nativeId: "0", key: "supersededBy" },
    { action: "delete_block_metadata", id: "m1", nativeId: "0", key: "expired" },
  ]);
  assert.match(result.source, /type="reference"/);
  assert.match(result.source, /confidence="0\.9"/);
  assert.match(result.source, /lastSeen="2026-05-15"/);
  assert.match(result.source, /scope="product"/);
  assert.match(result.source, /source="brief-v2"/);
  assert.match(result.source, /validUntil="2026-07-01"/);
  assert.match(result.source, /supersededBy="m3"/);
  assert.doesNotMatch(result.source, /expired/);
  assert.equal(result.skippedBlockMetadata.length, 0);
});

test("syncReviewCommentsFromDocx adds accepted Word memory metadata fields", () => {
  const source = `# Memory

::memory{id="m1"}
Keep this.
::
`;
  const reviewed = parse(`# Memory

::memory{id="m1" type="project" last_seen="2026-05-15" valid_until="2026-07-01" superseded_by="m2" expired}
Keep this.
::
`);

  const result = syncReviewCommentsFromDocx(source, renderDocx(reviewed));

  assert.deepEqual(result.changes, [
    { action: "update_block_metadata", id: "m1", nativeId: "0", key: "type" },
    { action: "update_block_metadata", id: "m1", nativeId: "0", key: "last_seen" },
    { action: "update_block_metadata", id: "m1", nativeId: "0", key: "valid_until" },
    { action: "update_block_metadata", id: "m1", nativeId: "0", key: "superseded_by" },
    { action: "update_block_metadata", id: "m1", nativeId: "0", key: "expired" },
  ]);
  assert.match(result.source, /::memory\{id="m1" type="project" last_seen="2026-05-15" valid_until="2026-07-01" superseded_by="m2" expired="true"\}/);
  assert.equal(result.skippedBlockMetadata.length, 0);
});

test("syncReviewCommentsFromDocx keeps tracked Word heading revisions as change requests", () => {
  const source = `# Review

## Original section {id="topic"}

Body.
`;

  const result = syncReviewCommentsFromDocx(source, docxWithTrackedHeadingRevision(renderDocx(parse(source))));

  assert.equal(result.changes.some((change) => change.action === "update_heading"), false);
  assert.deepEqual(result.changes, [
    { action: "add_change_request", id: "change-topic-7-8", target: "topic", nativeId: "7/8" },
  ]);
  assert.match(result.source, /## Original section \{id="topic"\}/);
  assert.match(result.source, /::change_request\{id="change-topic-7-8" target="topic" action="replace" from="Original section" to="Edited section"/);
  assert.equal(result.skippedHeadings.length, 1);
  assert.equal(result.skippedHeadings[0]?.hasRevisions, true);
});

test("syncReviewCommentsFromDocx keeps tracked Word heading moves as change requests", () => {
  const source = `# Review

## Original section {id="topic"}

Body.
`;

  const result = syncReviewCommentsFromDocx(source, docxWithTrackedHeadingMove(renderDocx(parse(source))));

  assert.equal(result.changes.some((change) => change.action === "update_heading"), false);
  assert.deepEqual(result.changes, [
    { action: "add_change_request", id: "change-topic-17-18", target: "topic", nativeId: "17/18" },
  ]);
  assert.match(result.source, /## Original section \{id="topic"\}/);
  assert.match(result.source, /::change_request\{id="change-topic-17-18" target="topic" action="replace" from="Original section" to="Moved section"/);
  assert.equal(result.skippedHeadings.length, 1);
  assert.equal(result.skippedHeadings[0]?.hasRevisions, true);
});

test("syncReviewCommentsFromDocx keeps range-marked tracked Word heading moves as change requests", () => {
  const source = `# Review

## Original section {id="topic"}

Body.
`;

  const result = syncReviewCommentsFromDocx(source, docxWithTrackedHeadingRangeMove(renderDocx(parse(source))));

  assert.equal(result.changes.some((change) => change.action === "update_heading"), false);
  assert.deepEqual(result.changes, [
    { action: "add_change_request", id: "change-topic-27-28", target: "topic", nativeId: "27/28" },
  ]);
  assert.match(result.source, /## Original section \{id="topic"\}/);
  assert.match(result.source, /::change_request\{id="change-topic-27-28" target="topic" action="replace" from="Original section" to="Moved section"/);
  assert.equal(result.skippedHeadings.length, 1);
  assert.equal(result.skippedHeadings[0]?.hasRevisions, true);
});

test("syncReviewCommentsFromDocx resolves existing source comments", () => {
  const source = `# Review

::claim{id="c1"}
Claim.
::

::comment{id="comment-c1" parent="c1" author="Research" date="2026-05-24T09:00:00Z"}
Check this claim.
::
`;
  const reviewed = parse(`# Review

::claim{id="c1"}
Claim.
::

::comment{id="comment-c1" parent="c1" author="Research" date="2026-05-24T09:00:00Z" status="resolved" resolved_by="Andrea" resolved_at="2026-05-24T10:00:00Z"}
Check this claim.
::
`);

  const result = syncReviewCommentsFromDocx(source, renderDocx(reviewed));

  assert.deepEqual(result.changes, [
    { action: "resolve_comment", id: "comment-c1", nativeId: "0" },
  ]);
  assert.match(result.source, /::comment\{id="comment-c1" parent="c1" author="Research" date="2026-05-24T09:00:00Z" status="resolved" resolved_by="Andrea" resolved_at="2026-05-24T10:00:00Z"\}/);
  assert.equal(result.skipped.length, 0);
});

test("syncReviewCommentsFromDocx resolves existing comments from native Word state", () => {
  const source = `# Review

::claim{id="c1"}
Claim.
::

::comment{id="comment-c1" parent="c1" author="Research" date="2026-05-24T09:00:00Z"}
Check this claim.
::
`;

  const result = syncReviewCommentsFromDocx(source, docxWithNativeResolvedComment(renderDocx(parse(source))));

  assert.deepEqual(result.changes, [
    { action: "resolve_comment", id: "comment-c1", nativeId: "0" },
  ]);
  assert.match(result.source, /::comment\{id="comment-c1" parent="c1" author="Research" date="2026-05-24T09:00:00Z" status="resolved"\}/);
  assert.match(result.source, /Check this claim\./);
  assert.equal(result.skipped.length, 0);
});

test("syncReviewCommentsFromDocx refreshes existing resolution metadata", () => {
  const source = `# Review

::claim{id="c1"}
Claim.
::

::comment{id="comment-c1" parent="c1" author="Research" status="resolved"}
Check this claim.
::
`;
  const reviewed = parse(`# Review

::claim{id="c1"}
Claim.
::

::comment{id="comment-c1" parent="c1" author="Research" status="resolved" resolved_by="Andrea" resolved_at="2026-05-24T10:00:00Z"}
Check this claim.
::
`);

  const result = syncReviewCommentsFromDocx(source, renderDocx(reviewed));

  assert.deepEqual(result.changes, [
    { action: "resolve_comment", id: "comment-c1", nativeId: "0" },
  ]);
  assert.match(result.source, /::comment\{id="comment-c1" parent="c1" author="Research" status="resolved" resolved_by="Andrea" resolved_at="2026-05-24T10:00:00Z"\}/);
  assert.equal(result.skipped.length, 0);
});

test("syncReviewCommentsFromDocx reopens existing source comments from native Word state", () => {
  const source = `# Review

::claim{id="c1"}
Claim.
::

::comment{id="comment-c1" parent="c1" author="Research" status="resolved" resolved_by="Andrea" resolved_at="2026-05-24T10:00:00Z"}
Check this claim.
::
`;

  const result = syncReviewCommentsFromDocx(source, docxWithNativeUnresolvedComment(renderDocx(parse(source))));

  assert.deepEqual(result.changes, [
    { action: "reopen_comment", id: "comment-c1", nativeId: "0" },
  ]);
  assert.match(result.source, /::comment\{id="comment-c1" parent="c1" author="Research"\}\nCheck this claim\.\n::/);
  assert.doesNotMatch(result.source, /status="resolved"/);
  assert.doesNotMatch(result.source, /resolved_by=/);
  assert.doesNotMatch(result.source, /resolved_at=/);
  assert.equal(result.skipped.length, 0);
});

test("syncReviewCommentsFromDocx keeps resolved comments resolved when native done is missing", () => {
  const source = `# Review

::claim{id="c1"}
Claim.
::

::comment{id="comment-c1" parent="c1" author="Research" status="resolved" resolved_by="Andrea" resolved_at="2026-05-24T10:00:00Z"}
Check this claim.
::
`;

  const result = syncReviewCommentsFromDocx(source, docxWithNativeDoneOmitted(renderDocx(parse(source))));

  assert.deepEqual(result.changes, []);
  assert.equal(result.source, source);
  assert.equal(result.skipped.length, 0);
});

test("syncReviewCommentsFromDocx updates existing source comment bodies", () => {
  const source = `# Review

::claim{id="c1"}
Claim.
::

::comment{id="comment-c1" parent="c1" author="Research"}
Original wording.
::
`;
  const reviewed = parse(`# Review

::claim{id="c1"}
Claim.
::

::comment{id="comment-c1" parent="c1" author="Research"}
Edited wording from Word.
::
`);

  const result = syncReviewCommentsFromDocx(source, renderDocx(reviewed));

  assert.deepEqual(result.changes, [
    { action: "update_comment", id: "comment-c1", nativeId: "0" },
  ]);
  assert.match(result.source, /::comment\{id="comment-c1" parent="c1" author="Research"\}\nEdited wording from Word\.\n::/);
  assert.equal(result.skipped.length, 0);
});

test("syncReviewCommentsFromData preserves leading and trailing returned review body spaces", () => {
  const source = `# Review

::claim{id="c1"}
Claim.
::

::comment{id="comment-c1" parent="c1" author="Research"}
Original comment.
::

::footnote{id="fn1" for="c1"}
Original footnote.
::

::endnote{id="en1" for="c1"}
Original endnote.
::
`;

  const result = syncReviewCommentsFromData(source, {
    comments: [{
      nativeId: "0",
      anchorBookmarkNames: [docxBookmarkName(source, "n_comment_c1_")],
      author: "Research",
      body: "  Padded comment  ",
    }],
    revisions: [],
    footnotes: [{
      nativeId: "1",
      anchorBookmarkNames: [docxBookmarkName(source, "n_fn1_")],
      body: "  Padded footnote  ",
    }],
    endnotes: [{
      nativeId: "2",
      anchorBookmarkNames: [docxBookmarkName(source, "n_en1_")],
      body: "  Padded endnote  ",
    }],
    tables: [],
    headings: [],
  });

  assert.deepEqual(result.changes, [
    { action: "update_comment", id: "comment-c1", nativeId: "0" },
    { action: "update_footnote", id: "fn1", nativeId: "1" },
    { action: "update_endnote", id: "en1", nativeId: "2" },
  ]);
  assert.match(result.source, /::comment\{id="comment-c1" parent="c1" author="Research"\}\n  Padded comment  \n::/);
  assert.match(result.source, /::footnote\{id="fn1" for="c1"\}\n  Padded footnote  \n::/);
  assert.match(result.source, /::endnote\{id="en1" for="c1"\}\n  Padded endnote  \n::/);
});

test("syncReviewCommentsFromData skips tracked source comment body revisions", () => {
  const source = `# Review

::claim{id="c1"}
Claim.
::

::comment{id="comment-c1" parent="c1" author="Research"}
Original wording.
::
`;

  const result = syncReviewCommentsFromData(source, {
    comments: [{
      nativeId: "0",
      anchorBookmarkNames: [docxBookmarkName(source, "n_comment_c1_")],
      author: "Research",
      status: "resolved",
      resolvedBy: "Reviewer",
      hasRevisions: true,
      body: "Edited wording from Word.",
    }],
    revisions: [],
    footnotes: [],
    endnotes: [],
    tables: [],
    headings: [],
  });

  assert.deepEqual(result.changes, [
    { action: "resolve_comment", id: "comment-c1", nativeId: "0" },
  ]);
  assert.match(result.source, /::comment\{id="comment-c1" parent="c1" author="Research" status="resolved" resolved_by="Reviewer"\}\nOriginal wording\.\n::/);
  assert.equal(result.skipped.length, 1);
  assert.equal(result.skipped[0]?.hasRevisions, true);
});

test("syncReviewCommentsFromData does not delete target comments when tracked comment revisions are skipped", () => {
  const source = `# Review

::claim{id="c1"}
Claim.
::

::comment{id="comment-c1" parent="c1" author="Andrea"}
Original wording.
::
`;

  const result = syncReviewCommentsFromData(source, {
    comments: [{
      nativeId: "7",
      anchorBookmarkNames: [docxBookmarkName(source, "n_c1_")],
      author: "Reviewer",
      hasRevisions: true,
      body: "Edited wording from Word.",
    }],
    revisions: [],
    footnotes: [],
    endnotes: [],
    tables: [],
    headings: [],
  });

  assert.deepEqual(result.changes, []);
  assert.equal(result.source, source);
  assert.equal(result.skipped.length, 1);
  assert.equal(result.skipped[0]?.hasRevisions, true);
});

test("syncReviewCommentsFromDocx ignores generated empty comment fallback text", () => {
  const source = `# Review

::claim{id="c1"}
Claim.
::

::comment{id="comment-empty" parent="c1" author="Research"}
::

::comment{id="comment-parent" parent="c1" author="Research"}
Parent comment.
::

::comment{id="reply-empty" reply_to="comment-parent" author="Research"}
::
`;

  const result = syncReviewCommentsFromDocx(source, renderDocx(parse(source)));

  assert.deepEqual(result.changes, []);
  assert.equal(result.source, source);
  assert.equal(result.skipped.length, 0);
});

test("syncReviewCommentsFromDocx preserves multiple same-target source comments", () => {
  const source = `# Review

::claim{id="c1"}
Claim.
::

::comment{id="comment-a" parent="c1" author="A"}
First.
::

::comment{id="comment-b" parent="c1" author="B"}
Second.
::
`;

  const result = syncReviewCommentsFromDocx(source, renderDocx(parse(source)));

  assert.deepEqual(result.changes, []);
  assert.equal(result.source, source);
  assert.equal(result.skipped.length, 0);
});

test("syncReviewCommentsFromDocx preserves rich Word comment body edits", () => {
  const source = `# Review

::claim{id="c1"}
Claim.
::

::comment{id="comment-c1" parent="c1" author="Research"}
Make this bold.
::
`;
  const reviewed = parse(`# Review

::claim{id="c1"}
Claim.
::

::comment{id="comment-c1" parent="c1" author="Research"}
Make **this** [bold](https://example.com/review) and re-check [[c1]].
::
`);

  const result = syncReviewCommentsFromDocx(source, renderDocx(reviewed));

  assert.deepEqual(result.changes, [
    { action: "update_comment", id: "comment-c1", nativeId: "0" },
  ]);
  assert.match(result.source, /Make \*\*this\*\* \[bold\]\(https:\/\/example\.com\/review\) and re-check \[\[c1\]\]\./);
  assert.equal(result.skipped.length, 0);
});

test("syncReviewCommentsFromDocx preserves bracketed hyperlink labels in comment edits", () => {
  const source = `# Review

::claim{id="c1"}
Claim.
::

::comment{id="comment-c1" parent="c1" author="Research"}
See source.
::
`;
  const reviewed = parse(`# Review

::claim{id="c1"}
Claim.
::

::comment{id="comment-c1" parent="c1" author="Research"}
See [\\[source\\]](https://example.com/review).
::
`);

  const result = syncReviewCommentsFromDocx(source, renderDocx(reviewed));

  assert.deepEqual(result.changes, [
    { action: "update_comment", id: "comment-c1", nativeId: "0" },
  ]);
  assert.match(result.source, /See \[\\\[source\\\]\]\(https:\/\/example\.com\/review\)\./);
  assert.equal(result.skipped.length, 0);
});

test("syncReviewCommentsFromDocx preserves Markdown-safe returned hyperlink targets", () => {
  const source = `# Review

::claim{id="c1"}
Claim.
::

::comment{id="comment-c1" parent="c1" author="Research"}
See source.
::
`;
  const reviewed = parse(`# Review

::claim{id="c1"}
Claim.
::

::comment{id="comment-c1" parent="c1" author="Research"}
See [source](https://example.com/review).
::
`);

  const result = syncReviewCommentsFromDocx(
    source,
    docxWithCommentRelationshipTarget(renderDocx(reviewed), "https://example.com/report(2026 final).html"),
  );

  assert.deepEqual(result.changes, [
    { action: "update_comment", id: "comment-c1", nativeId: "0" },
  ]);
  assert.match(result.source, /See \[source\]\(https:\/\/example\.com\/report%282026%20final%29\.html\)\./);
  assert.equal(result.skipped.length, 0);
});

test("syncReviewCommentsFromDocx preserves formatted internal hyperlink labels in comment edits", () => {
  const source = `# Review

## Details {id="details"}

::claim{id="c1"}
Claim.
::

::comment{id="comment-c1" parent="c1" author="Research"}
See details.
::
`;
  const reviewed = parse(`# Review

## Details {id="details"}

::claim{id="c1"}
Claim.
::

::comment{id="comment-c1" parent="c1" author="Research"}
See [*details*](#details) and [[c1]].
::
`);

  const result = syncReviewCommentsFromDocx(source, renderDocx(reviewed));

  assert.deepEqual(result.changes, [
    { action: "update_comment", id: "comment-c1", nativeId: "0" },
  ]);
  assert.match(result.source, /See \[\*details\*\]\(#details\) and \[\[c1\]\]\./);
  assert.equal(result.skipped.length, 0);
});

test("syncReviewCommentsFromDocx preserves custom internal hyperlink labels in comment edits", () => {
  const source = `# Review

## Details {id="review-details"}

::claim{id="c1"}
Claim.
::

::comment{id="comment-c1" parent="c1" author="Research"}
See details.
::
`;
  const reviewed = parse(`# Review

## Details {id="review-details"}

::claim{id="c1"}
Claim.
::

::comment{id="comment-c1" parent="c1" author="Research"}
See [*the detailed note*](#review-details).
::
`);

  const result = syncReviewCommentsFromDocx(source, renderDocx(reviewed));

  assert.deepEqual(result.changes, [
    { action: "update_comment", id: "comment-c1", nativeId: "0" },
  ]);
  assert.match(result.source, /See \[\*the detailed note\*\]\(#review-details\)\./);
  assert.equal(result.skipped.length, 0);
});

test("syncReviewCommentsFromDocx preserves Word wikilink-only comment edits", () => {
  const source = `# Review

::claim{id="c1"}
Claim.
::

::comment{id="comment-c1" parent="c1" author="Research"}
See c1.
::
`;
  const reviewed = parse(`# Review

::claim{id="c1"}
Claim.
::

::comment{id="comment-c1" parent="c1" author="Research"}
See [[c1]].
::
`);

  const result = syncReviewCommentsFromDocx(source, renderDocx(reviewed));

  assert.deepEqual(result.changes, [
    { action: "update_comment", id: "comment-c1", nativeId: "0" },
  ]);
  assert.match(result.source, /See \[\[c1\]\]\./);
  assert.equal(result.skipped.length, 0);
});

test("syncReviewCommentsFromDocx marks missing sibling source comments deleted", () => {
  const source = `# Review

::claim{id="c1"}
Claim.
::

::comment{id="comment-a" parent="c1" author="Andrea"}
Delete this in Word.
::

::comment{id="comment-b" parent="c1" author="Research"}
Keep this comment.
::
`;
  const reviewed = parse(`# Review

::claim{id="c1"}
Claim.
::

::comment{id="comment-b" parent="c1" author="Research"}
Keep this comment.
::
`);

  const result = syncReviewCommentsFromDocx(source, renderDocx(reviewed));

  assert.deepEqual(result.changes, [
    { action: "delete_comment", id: "comment-a", target: "c1" },
  ]);
  assert.match(result.source, /::comment\{id="comment-a" parent="c1" author="Andrea" status="deleted"\}/);
  assert.match(result.source, /::comment\{id="comment-b" parent="c1" author="Research"\}\nKeep this comment\.\n::/);
  assert.equal(result.skipped.length, 0);
});

test("syncReviewCommentsFromDocx marks missing resolved sibling source comments deleted", () => {
  const source = `# Review

::claim{id="c1"}
Claim.
::

::comment{id="comment-a" parent="c1" author="Andrea" status="resolved" resolved_by="Andrea" resolved_at="2026-05-24T10:00:00Z"}
Delete this resolved comment in Word.
::

::comment{id="comment-b" parent="c1" author="Research"}
Keep this comment.
::
`;
  const reviewed = parse(`# Review

::claim{id="c1"}
Claim.
::

::comment{id="comment-b" parent="c1" author="Research"}
Keep this comment.
::
`);

  const result = syncReviewCommentsFromDocx(source, renderDocx(reviewed));

  assert.deepEqual(result.changes, [
    { action: "delete_comment", id: "comment-a", target: "c1" },
  ]);
  assert.match(result.source, /::comment\{id="comment-a" parent="c1" author="Andrea" status="deleted" resolved_by="Andrea" resolved_at="2026-05-24T10:00:00Z"\}/);
  assert.match(result.source, /::comment\{id="comment-b" parent="c1" author="Research"\}\nKeep this comment\.\n::/);
  assert.equal(result.skipped.length, 0);
});

test("syncReviewCommentsFromDocx does not flatten unchanged formatted source comments", () => {
  const source = `# Review

::claim{id="c1"}
Claim.
::

::comment{id="comment-c1" parent="c1" author="Research"}
Check **bold**, _emphasis_, \`code\`, [source](https://example.com), and [\\[bracketed\\]](https://example.com/bracketed).
::
`;

  const result = syncReviewCommentsFromDocx(source, renderDocx(parse(source)));

  assert.equal(result.source, source);
  assert.deepEqual(result.changes, []);
  assert.equal(result.skipped.length, 0);
});

test("syncReviewCommentsFromDocx does not rewrite unchanged field-code hyperlink comments", () => {
  const source = `# Review

::claim{id="c1"}
Claim.
::

::comment{id="comment-c1" parent="c1" author="Research"}
See [**field link**](https://example.com/review).
::
`;

  const result = syncReviewCommentsFromDocx(source, docxWithCommentHyperlinkField(renderDocx(parse(source))));

  assert.equal(result.source, source);
  assert.deepEqual(result.changes, []);
  assert.equal(result.skipped.length, 0);
});

test("syncReviewCommentsFromDocx does not rewrite unchanged spaced hyperlink labels", () => {
  const source = `# Review

::claim{id="c1"}
Claim.
::

::comment{id="comment-c1" parent="c1" author="Research"}
See [ source ](https://example.com/review).
::
`;

  const result = syncReviewCommentsFromDocx(source, renderDocx(parse(source)));

  assert.equal(result.source, source);
  assert.deepEqual(result.changes, []);
  assert.equal(result.skipped.length, 0);
});

test("syncReviewCommentsFromDocx does not rewrite unchanged backslash hyperlink labels", () => {
  const source = `# Review

::claim{id="c1"}
Claim.
::

::comment{id="comment-c1" parent="c1" author="Research"}
See [C:\\source](https://example.com/review).
::
`;

  const result = syncReviewCommentsFromDocx(source, renderDocx(parse(source)));

  assert.equal(result.source, source);
  assert.deepEqual(result.changes, []);
  assert.equal(result.skipped.length, 0);
});

test("syncReviewCommentsFromDocx does not rewrite unchanged escaped pipes", () => {
  const source = `# Review

::claim{id="c1"}
Claim.
::

::comment{id="comment-c1" parent="c1" author="Research"}
Compare ARR\\|NRR and [C\\|D](https://example.com/review).
::
`;

  const result = syncReviewCommentsFromDocx(source, renderDocx(parse(source)));

  assert.equal(result.source, source);
  assert.deepEqual(result.changes, []);
  assert.equal(result.skipped.length, 0);
});

test("syncReviewCommentsFromDocx does not rewrite unchanged alias internal links", () => {
  const source = `# Review

## Details {id="review-details" aliases="details"}

::claim{id="c1"}
Claim.
::

::comment{id="comment-c1" parent="c1" author="Research"}
See [*the detailed note*](#details).
::
`;

  const result = syncReviewCommentsFromDocx(source, renderDocx(parse(source)));

  assert.equal(result.source, source);
  assert.deepEqual(result.changes, []);
  assert.equal(result.skipped.length, 0);
});

test("syncReviewCommentsFromDocx does not rewrite unchanged escaped-label alias internal links", () => {
  const source = `# Review

## Details {id="review-details" aliases="details"}

::claim{id="c1"}
Claim.
::

::comment{id="comment-c1" parent="c1" author="Research"}
See [\\[details\\]](#details).
::
`;

  const result = syncReviewCommentsFromDocx(source, renderDocx(parse(source)));

  assert.equal(result.source, source);
  assert.deepEqual(result.changes, []);
  assert.equal(result.skipped.length, 0);
});

test("syncReviewCommentsFromDocx does not rewrite unchanged alias wikilinks", () => {
  const source = `# Review

## Details {id="review-details" aliases="details"}

::claim{id="c1"}
Claim.
::

::comment{id="comment-c1" parent="c1" author="Research"}
See [[details]].
::
`;

  const result = syncReviewCommentsFromDocx(source, renderDocx(parse(source)));

  assert.equal(result.source, source);
  assert.deepEqual(result.changes, []);
  assert.equal(result.skipped.length, 0);
});

test("syncReviewCommentsFromDocx matches formatted target-only comments among siblings", () => {
  const source = `# Review

::claim{id="c1"}
Claim.
::

::comment{id="comment-a" parent="c1" author="Andrea"}
Check _wording_.
::

::comment{id="comment-b" parent="c1" author="Research"}
Second comment.
::
`;

  const result = syncReviewCommentsFromDocx(
    source,
    docxWithoutBookmarks(renderDocx(parse(source)), ["n_comment_a_", "n_comment_b_"]),
  );

  assert.equal(result.source, source);
  assert.deepEqual(result.changes, []);
  assert.equal(result.skipped.length, 0);
});

test("syncReviewCommentsFromDocx matches target-only comments whose source target uses an alias", () => {
  const source = `# Review

## Claim {id="review-claim" aliases="claim"}

::comment{id="comment-a" parent="claim" author="Andrea"}
Check wording.
::
`;

  const result = syncReviewCommentsFromDocx(
    source,
    docxWithoutBookmarks(renderDocx(parse(source)), ["n_comment_a_"]),
  );

  assert.equal(result.source, source);
  assert.deepEqual(result.changes, []);
  assert.equal(result.skipped.length, 0);
});

test("syncReviewCommentsFromDocx syncs target-only comment markup removals among siblings", () => {
  const source = `# Review

::claim{id="c1"}
Claim.
::

::comment{id="comment-a" parent="c1" author="Andrea"}
Check **wording**.
::

::comment{id="comment-b" parent="c1" author="Research"}
Second comment.
::
`;
  const reviewed = parse(`# Review

::claim{id="c1"}
Claim.
::

::comment{id="comment-a" parent="c1" author="Andrea"}
Check wording.
::

::comment{id="comment-b" parent="c1" author="Research"}
Second comment.
::
`);

  const result = syncReviewCommentsFromDocx(
    source,
    docxWithoutBookmarks(renderDocx(reviewed), ["n_comment_a_", "n_comment_b_"]),
  );

  assert.deepEqual(result.changes, [
    { action: "update_comment", id: "comment-a", nativeId: "0" },
  ]);
  assert.match(result.source, /::comment\{id="comment-a" parent="c1" author="Andrea"\}\nCheck wording\.\n::/);
  assert.match(result.source, /::comment\{id="comment-b" parent="c1" author="Research"\}\nSecond comment\.\n::/);
  assert.equal(result.skipped.length, 0);
});

test("syncReviewCommentsFromData matches target-only escaped-label link removals among siblings", () => {
  const source = `# Review

::claim{id="c1"}
Claim.
::

::comment{id="comment-a" parent="c1"}
See [\\[source\\]](https://example.com/review).
::

::comment{id="comment-b" parent="c1"}
Second comment.
::
`;

  const result = syncReviewCommentsFromData(source, {
    comments: [
      {
        nativeId: "0",
        anchorBookmarkNames: [docxBookmarkName(source, "n_c1_")],
        body: "See [source].",
      },
      {
        nativeId: "1",
        anchorBookmarkNames: [docxBookmarkName(source, "n_c1_")],
        body: "Second comment.",
      },
    ],
    revisions: [],
    footnotes: [],
    endnotes: [],
    tables: [],
    headings: [],
  });

  assert.deepEqual(result.changes, [
    { action: "update_comment", id: "comment-a", nativeId: "0" },
  ]);
  assert.match(result.source, /::comment\{id="comment-a" parent="c1"\}\nSee \[source\]\.\n::/);
  assert.match(result.source, /::comment\{id="comment-b" parent="c1"\}\nSecond comment\.\n::/);
  assert.equal(result.skipped.length, 0);
});

test("syncReviewCommentsFromDocx skips ambiguous target-only comments without deleting siblings", () => {
  const source = `# Review

::claim{id="c1"}
Claim.
::

::comment{id="comment-a" parent="c1" author="Andrea"}
First source comment.
::

::comment{id="comment-b" parent="c1" author="Andrea"}
Second source comment.
::
`;
  const reviewed = parse(`# Review

::claim{id="c1"}
Claim.
::

::comment{id="comment-a" parent="c1" author="Andrea"}
Edited ambiguous comment.
::
`);

  const result = syncReviewCommentsFromDocx(
    source,
    docxWithoutBookmarks(renderDocx(reviewed), ["n_comment_a_", "n_comment_b_"]),
  );

  assert.equal(result.source, source);
  assert.deepEqual(result.changes, []);
  assert.equal(result.skipped.length, 1);
});

test("syncReviewCommentsFromData does not overwrite a source comment when target-only metadata conflicts", () => {
  const source = `# Review

::claim{id="c1"}
Claim.
::

::comment{id="comment-a" parent="c1" author="Andrea"}
Old source comment.
::
`;
  const result = syncReviewCommentsFromData(source, {
    comments: [{
      nativeId: "7",
      anchorBookmarkNames: [docxBookmarkName(source, "n_c1_")],
      author: "Reviewer",
      initials: "R",
      body: "New Word comment.",
    }],
    revisions: [],
    footnotes: [],
    endnotes: [],
    tables: [],
    headings: [],
  });

  assert.deepEqual(result.changes, [
    { action: "add_comment", id: "comment-c1-7", target: "c1", nativeId: "7" },
    { action: "delete_comment", id: "comment-a", target: "c1" },
  ]);
  assert.match(result.source, /::comment\{id="comment-c1-7" parent="c1" author="Reviewer" initials="R"\}\nNew Word comment\.\n::/);
  assert.match(result.source, /::comment\{id="comment-a" parent="c1" author="Andrea" status="deleted"\}\nOld source comment\.\n::/);
  assert.equal(result.skipped.length, 0);
});

test("syncReviewCommentsFromData does not collapse same-body comments when target-only metadata conflicts", () => {
  const source = `# Review

::claim{id="c1"}
Claim.
::

::comment{id="comment-a" parent="c1" author="Andrea"}
Same visible text.
::
`;
  const result = syncReviewCommentsFromData(source, {
    comments: [{
      nativeId: "7",
      anchorBookmarkNames: [docxBookmarkName(source, "n_c1_")],
      author: "Reviewer",
      initials: "R",
      body: "Same visible text.",
    }],
    revisions: [],
    footnotes: [],
    endnotes: [],
    tables: [],
    headings: [],
  });

  assert.deepEqual(result.changes, [
    { action: "add_comment", id: "comment-c1-7", target: "c1", nativeId: "7" },
    { action: "delete_comment", id: "comment-a", target: "c1" },
  ]);
  assert.match(result.source, /::comment\{id="comment-c1-7" parent="c1" author="Reviewer" initials="R"\}\nSame visible text\.\n::/);
  assert.match(result.source, /::comment\{id="comment-a" parent="c1" author="Andrea" status="deleted"\}\nSame visible text\.\n::/);
  assert.equal(result.skipped.length, 0);
});

test("syncReviewCommentsFromData does not match new Word comments to deleted source comments", () => {
  const source = `# Review

::claim{id="c1"}
Claim.
::

::comment{id="comment-old" parent="c1" author="Andrea" status="deleted"}
Same visible text.
::
`;
  const result = syncReviewCommentsFromData(source, {
    comments: [{
      nativeId: "7",
      anchorBookmarkNames: [docxBookmarkName(source, "n_c1_")],
      author: "Andrea",
      body: "Same visible text.",
    }],
    revisions: [],
    footnotes: [],
    endnotes: [],
    tables: [],
    headings: [],
  });

  assert.deepEqual(result.changes, [
    { action: "add_comment", id: "comment-c1-7", target: "c1", nativeId: "7" },
  ]);
  assert.match(result.source, /::comment\{id="comment-c1-7" parent="c1" author="Andrea"\}\nSame visible text\.\n::/);
  assert.match(result.source, /::comment\{id="comment-old" parent="c1" author="Andrea" status="deleted"\}\nSame visible text\.\n::/);
  assert.equal(result.skipped.length, 0);
});

test("syncReviewCommentsFromData does not match direct source bookmarks to deleted source comments", () => {
  const source = `# Review

::claim{id="c1"}
Claim.
::

::comment{id="comment-old" parent="c1" author="Andrea" status="deleted"}
Same visible text.
::
`;
  const activeSource = source.replace(' status="deleted"', "");
  const result = syncReviewCommentsFromData(source, {
    comments: [{
      nativeId: "7",
      anchorBookmarkNames: [docxBookmarkName(activeSource, "n_comment_old_")],
      author: "Andrea",
      body: "Same visible text.",
    }],
    revisions: [],
    footnotes: [],
    endnotes: [],
    tables: [],
    headings: [],
  });

  assert.deepEqual(result.changes, [
    { action: "add_comment", id: "comment-c1-7", target: "c1", nativeId: "7" },
  ]);
  assert.match(result.source, /::comment\{id="comment-c1-7" parent="c1" author="Andrea"\}\nSame visible text\.\n::/);
  assert.match(result.source, /::comment\{id="comment-old" parent="c1" author="Andrea" status="deleted"\}\nSame visible text\.\n::/);
  assert.equal(result.skipped.length, 0);
});

test("syncReviewCommentsFromDocx syncs Word comment markup removals", () => {
  const source = `# Review

::claim{id="c1"}
Claim.
::

::comment{id="comment-c1" parent="c1" author="Research"}
Check **bold** and [source](https://example.com).
::
`;
  const reviewed = parse(`# Review

::claim{id="c1"}
Claim.
::

::comment{id="comment-c1" parent="c1" author="Research"}
Check bold and source.
::
`);

  const result = syncReviewCommentsFromDocx(source, renderDocx(reviewed));

  assert.deepEqual(result.changes, [
    { action: "update_comment", id: "comment-c1", nativeId: "0" },
  ]);
  assert.match(result.source, /::comment\{id="comment-c1" parent="c1" author="Research"\}\nCheck bold and source\.\n::/);
  assert.equal(result.skipped.length, 0);
});

test("syncReviewCommentsFromDocx adds threaded Word replies to source comments", () => {
  const source = `# Review

::claim{id="c1"}
Claim.
::

::comment{id="comment-c1" parent="c1" author="Research"}
Check this claim.
::
`;
  const reviewed = parse(`# Review

::claim{id="c1"}
Claim.
::

::comment{id="comment-c1" parent="c1" author="Research"}
Check this claim.
::

::comment{id="word-reply" reply_to="comment-c1" author="Andrea" date="2026-05-24T10:00:00Z"}
Confirmed.
::
`);

  const result = syncReviewCommentsFromDocx(source, renderDocx(reviewed));

  assert.deepEqual(result.changes, [
    {
      action: "add_comment",
      id: "comment-comment-c1-1",
      target: "comment-c1",
      nativeId: "1",
      replyTo: "comment-c1",
    },
  ]);
  assert.match(result.source, /::comment\{id="comment-comment-c1-1" reply_to="comment-c1" author="Andrea" initials="A" date="2026-05-24T10:00:00Z"\}\nConfirmed\.\n::/);
  assert.equal(result.skipped.length, 0);
});

test("syncReviewCommentsFromDocx does not duplicate existing threaded replies", () => {
  const source = `# Review

::claim{id="c1"}
Claim.
::

::comment{id="comment-c1" parent="c1" author="Research"}
Check this claim.
::

::comment{id="comment-c1-reply" reply_to="comment-c1" author="Andrea"}
Confirmed.
::
`;

  const result = syncReviewCommentsFromDocx(source, renderDocx(parse(source)));

  assert.equal(result.source, source);
  assert.deepEqual(result.changes, []);
  assert.equal(result.skipped.length, 0);
});

test("syncReviewCommentsFromDocx does not duplicate formatted threaded replies among siblings", () => {
  const source = `# Review

::claim{id="c1"}
Claim.
::

::comment{id="comment-c1" parent="c1"}
Check this claim.
::

::comment{id="comment-c1-reply-a" reply_to="comment-c1"}
First _reply_.
::

::comment{id="comment-c1-reply-b" reply_to="comment-c1"}
Second reply.
::
`;

  const result = syncReviewCommentsFromDocx(source, renderDocx(parse(source)));

  assert.equal(result.source, source);
  assert.deepEqual(result.changes, []);
  assert.equal(result.skipped.length, 0);
});

test("syncReviewCommentsFromDocx updates existing threaded reply bodies", () => {
  const source = `# Review

::claim{id="c1"}
Claim.
::

::comment{id="comment-c1" parent="c1" author="Research"}
Check this claim.
::

::comment{id="comment-c1-reply-a" reply_to="comment-c1" author="Andrea"}
Original reply.
::

::comment{id="comment-c1-reply-b" reply_to="comment-c1" author="Boris"}
Second reply.
::
`;
  const reviewed = parse(`# Review

::claim{id="c1"}
Claim.
::

::comment{id="comment-c1" parent="c1" author="Research"}
Check this claim.
::

::comment{id="comment-c1-reply-a" reply_to="comment-c1" author="Andrea"}
Edited reply from Word.
::

::comment{id="comment-c1-reply-b" reply_to="comment-c1" author="Boris"}
Second reply.
::
`);

  const result = syncReviewCommentsFromDocx(source, renderDocx(reviewed));

  assert.deepEqual(result.changes, [
    { action: "update_comment", id: "comment-c1-reply-a", nativeId: "1" },
  ]);
  assert.match(result.source, /::comment\{id="comment-c1-reply-a" reply_to="comment-c1" author="Andrea"\}\nEdited reply from Word\.\n::/);
  assert.match(result.source, /::comment\{id="comment-c1-reply-b" reply_to="comment-c1" author="Boris"\}\nSecond reply\.\n::/);
  assert.equal(result.skipped.length, 0);
});

test("syncReviewCommentsFromDocx skips ambiguous threaded replies without deleting siblings", () => {
  const source = `# Review

::claim{id="c1"}
Claim.
::

::comment{id="comment-c1" parent="c1" author="Research"}
Check this claim.
::

::comment{id="comment-c1-reply-a" reply_to="comment-c1" author="Andrea"}
First source reply.
::

::comment{id="comment-c1-reply-b" reply_to="comment-c1" author="Andrea"}
Second source reply.
::
`;
  const reviewed = parse(`# Review

::claim{id="c1"}
Claim.
::

::comment{id="comment-c1" parent="c1" author="Research"}
Check this claim.
::

::comment{id="comment-c1-reply-a" reply_to="comment-c1" author="Andrea"}
Edited ambiguous reply.
::
`);

  const result = syncReviewCommentsFromDocx(source, renderDocx(reviewed));

  assert.equal(result.source, source);
  assert.deepEqual(result.changes, []);
  assert.equal(result.skipped.length, 1);
});

test("syncReviewCommentsFromData does not overwrite a source reply when metadata conflicts", () => {
  const source = `# Review

::claim{id="c1"}
Claim.
::

::comment{id="comment-c1" parent="c1" author="Research"}
Check this claim.
::

::comment{id="comment-c1-reply-old" reply_to="comment-c1" author="Andrea"}
Old source reply.
::
`;
  const result = syncReviewCommentsFromData(source, {
    comments: [
      {
        nativeId: "0",
        anchorBookmarkNames: [
          docxBookmarkName(source, "n_c1_"),
          docxBookmarkName(source, "n_comment_c1_"),
        ],
        author: "Research",
        body: "Check this claim.",
      },
      {
        nativeId: "1",
        replyTo: "0",
        author: "Reviewer",
        initials: "R",
        body: "New Word reply.",
      },
    ],
    revisions: [],
    footnotes: [],
    endnotes: [],
    tables: [],
    headings: [],
  });

  assert.deepEqual(result.changes, [
    {
      action: "add_comment",
      id: "comment-comment-c1-1",
      target: "comment-c1",
      nativeId: "1",
      replyTo: "comment-c1",
    },
    { action: "delete_comment", id: "comment-c1-reply-old", replyTo: "comment-c1" },
  ]);
  assert.match(result.source, /::comment\{id="comment-comment-c1-1" reply_to="comment-c1" author="Reviewer" initials="R"\}\nNew Word reply\.\n::/);
  assert.match(result.source, /::comment\{id="comment-c1-reply-old" reply_to="comment-c1" author="Andrea" status="deleted"\}\nOld source reply\.\n::/);
  assert.equal(result.skipped.length, 0);
});

test("syncReviewCommentsFromData does not collapse same-body replies when metadata conflicts", () => {
  const source = `# Review

::claim{id="c1"}
Claim.
::

::comment{id="comment-c1" parent="c1" author="Research"}
Check this claim.
::

::comment{id="comment-c1-reply-old" reply_to="comment-c1" author="Andrea"}
Same reply text.
::
`;
  const result = syncReviewCommentsFromData(source, {
    comments: [
      {
        nativeId: "0",
        anchorBookmarkNames: [
          docxBookmarkName(source, "n_c1_"),
          docxBookmarkName(source, "n_comment_c1_"),
        ],
        author: "Research",
        body: "Check this claim.",
      },
      {
        nativeId: "1",
        replyTo: "0",
        author: "Reviewer",
        initials: "R",
        body: "Same reply text.",
      },
    ],
    revisions: [],
    footnotes: [],
    endnotes: [],
    tables: [],
    headings: [],
  });

  assert.deepEqual(result.changes, [
    {
      action: "add_comment",
      id: "comment-comment-c1-1",
      target: "comment-c1",
      nativeId: "1",
      replyTo: "comment-c1",
    },
    { action: "delete_comment", id: "comment-c1-reply-old", replyTo: "comment-c1" },
  ]);
  assert.match(result.source, /::comment\{id="comment-comment-c1-1" reply_to="comment-c1" author="Reviewer" initials="R"\}\nSame reply text\.\n::/);
  assert.match(result.source, /::comment\{id="comment-c1-reply-old" reply_to="comment-c1" author="Andrea" status="deleted"\}\nSame reply text\.\n::/);
  assert.equal(result.skipped.length, 0);
});

test("syncReviewCommentsFromData does not match new Word replies to deleted source replies", () => {
  const source = `# Review

::claim{id="c1"}
Claim.
::

::comment{id="comment-c1" parent="c1" author="Research"}
Check this claim.
::

::comment{id="comment-c1-reply-old" reply_to="comment-c1" author="Andrea" status="deleted"}
Same reply text.
::
`;
  const result = syncReviewCommentsFromData(source, {
    comments: [
      {
        nativeId: "0",
        anchorBookmarkNames: [
          docxBookmarkName(source, "n_c1_"),
          docxBookmarkName(source, "n_comment_c1_"),
        ],
        author: "Research",
        body: "Check this claim.",
      },
      {
        nativeId: "1",
        replyTo: "0",
        author: "Andrea",
        body: "Same reply text.",
      },
    ],
    revisions: [],
    footnotes: [],
    endnotes: [],
    tables: [],
    headings: [],
  });

  assert.deepEqual(result.changes, [
    {
      action: "add_comment",
      id: "comment-comment-c1-1",
      target: "comment-c1",
      nativeId: "1",
      replyTo: "comment-c1",
    },
  ]);
  assert.match(result.source, /::comment\{id="comment-comment-c1-1" reply_to="comment-c1" author="Andrea"\}\nSame reply text\.\n::/);
  assert.match(result.source, /::comment\{id="comment-c1-reply-old" reply_to="comment-c1" author="Andrea" status="deleted"\}\nSame reply text\.\n::/);
  assert.equal(result.skipped.length, 0);
});

test("syncReviewCommentsFromData marks missing replies deleted when a source-bookmarked reply returns", () => {
  const source = `# Review

::claim{id="c1"}
Claim.
::

::comment{id="comment-c1" parent="c1" author="Research"}
Check this claim.
::

::comment{id="comment-c1-reply-a" reply_to="comment-c1" author="Andrea"}
First reply.
::

::comment{id="comment-c1-reply-b" reply_to="comment-c1" author="Boris"}
Second reply.
::
`;
  const result = syncReviewCommentsFromData(source, {
    comments: [{
      nativeId: "1",
      anchorBookmarkNames: [sourceBookmarkName("comment-c1-reply-a")],
      author: "Andrea",
      body: "First reply.",
    }],
    revisions: [],
    footnotes: [],
    endnotes: [],
    tables: [],
    headings: [],
  });

  assert.deepEqual(result.changes, [
    { action: "delete_comment", id: "comment-c1-reply-b", replyTo: "comment-c1" },
  ]);
  assert.match(result.source, /::comment\{id="comment-c1-reply-a" reply_to="comment-c1" author="Andrea"\}\nFirst reply\.\n::/);
  assert.match(result.source, /::comment\{id="comment-c1-reply-b" reply_to="comment-c1" author="Boris" status="deleted"\}\nSecond reply\.\n::/);
  assert.equal(result.skipped.length, 0);
});

test("syncReviewCommentsFromData imports direct source bookmarks to deleted replies as new replies", () => {
  const source = `# Review

::claim{id="c1"}
Claim.
::

::comment{id="comment-c1" parent="c1" author="Research"}
Check this claim.
::

::comment{id="comment-c1-reply-old" reply_to="comment-c1" author="Andrea" status="deleted"}
Same reply text.
::
`;
  const result = syncReviewCommentsFromData(source, {
    comments: [{
      nativeId: "1",
      anchorBookmarkNames: [sourceBookmarkName("comment-c1-reply-old")],
      author: "Andrea",
      body: "Same reply text.",
    }],
    revisions: [],
    footnotes: [],
    endnotes: [],
    tables: [],
    headings: [],
  });

  assert.deepEqual(result.changes, [
    {
      action: "add_comment",
      id: "comment-comment-c1-1",
      target: "comment-c1",
      nativeId: "1",
      replyTo: "comment-c1",
    },
  ]);
  assert.match(result.source, /::comment\{id="comment-comment-c1-1" reply_to="comment-c1" author="Andrea"\}\nSame reply text\.\n::/);
  assert.match(result.source, /::comment\{id="comment-c1-reply-old" reply_to="comment-c1" author="Andrea" status="deleted"\}\nSame reply text\.\n::/);
  assert.equal(result.skipped.length, 0);
});

test("syncReviewCommentsFromDocx adds tracked revisions as change requests", () => {
  const source = `# Review

::claim{id="c1"}
Claim.
::
`;
  const reviewed = parse(`# Review

::claim{id="c1"}
Claim.
::

::change_request{id="cr1" target="c1" action="replace" from="old wording" to="new wording" author="Research" date="2026-05-24T09:30:00Z"}
Reason for the proposed edit.
::
`);

  const result = syncReviewCommentsFromDocx(source, renderDocx(reviewed));

  assert.deepEqual(result.changes, [
    { action: "add_change_request", id: "change-c1-0-1", target: "c1", nativeId: "0/1" },
  ]);
  assert.match(result.source, /::change_request\{id="change-c1-0-1" target="c1" action="replace" from="old wording" to="new wording" author="Research" date="2026-05-24T09:30:00Z"\}/);
  assert.equal(result.skippedRevisions.length, 0);
});

test("syncReviewCommentsFromDocx preserves rich tracked revision text", () => {
  const source = `# Review

::claim{id="c1"}
Claim.
::
`;

  const result = syncReviewCommentsFromDocx(source, docxWithRichTrackedRevision(renderDocx(parse(source))));

  assert.deepEqual(result.changes, [
    { action: "add_change_request", id: "change-c1-70-71", target: "c1", nativeId: "70/71" },
  ]);
  assert.match(result.source, /::change_request\{id="change-c1-70-71" target="c1" action="replace" from="Old \*\*claim\*\* \[source\]\(https:\/\/example\.com\/old\)\." to="New \*claim\* `model` and \[\[c1\]\]\." author="Reviewer" date="2026-05-25T09:00:00Z"\}/);
  assert.equal(result.skippedRevisions.length, 0);
});

test("syncReviewCommentsFromDocx preserves formatted hyperlink labels in change requests", () => {
  const source = `# Review

::claim{id="c1"}
Claim.
::
`;

  const result = syncReviewCommentsFromDocx(source, docxWithFormattedHyperlinkRevision(renderDocx(parse(source))));

  assert.deepEqual(result.changes, [
    { action: "add_change_request", id: "change-c1-70-71", target: "c1", nativeId: "70/71" },
  ]);
  assert.match(result.source, /::change_request\{id="change-c1-70-71" target="c1" action="replace" from="Old \[\*\*source note\*\*\]\(https:\/\/example\.com\/old\)\." to="New \[\*source note\*\]\(https:\/\/example\.com\/new\)\." author="Reviewer" date="2026-05-25T09:00:00Z"\}/);
  assert.doesNotMatch(result.source, /from="Old \[source note\]/);
  assert.doesNotMatch(result.source, /to="New \[source note\]/);
  assert.equal(result.skippedRevisions.length, 0);
});

test("syncReviewCommentsFromDocx merges split styled Word runs in change requests", () => {
  const source = `# Review

::claim{id="c1"}
Claim.
::
`;

  const result = syncReviewCommentsFromDocx(source, docxWithSplitStyledTrackedRevision(renderDocx(parse(source))));

  assert.deepEqual(result.changes, [
    { action: "add_change_request", id: "change-c1-70-71", target: "c1", nativeId: "70/71" },
  ]);
  assert.match(result.source, /::change_request\{id="change-c1-70-71" target="c1" action="replace" from="Old \*\*Bold\*\*" to="New \*emphasis\*" author="Reviewer" date="2026-05-25T09:00:00Z"\}/);
  assert.doesNotMatch(result.source, /\*\*Bo\*\*\*\*ld\*\*/);
  assert.doesNotMatch(result.source, /\*em\*\*phasis\*/);
  assert.equal(result.skippedRevisions.length, 0);
});

test("syncReviewCommentsFromDocx merges split same-ID tracked revisions into one change request", () => {
  const source = `# Review

::claim{id="c1"}
Claim.
::
`;

  const result = syncReviewCommentsFromDocx(source, docxWithSplitTrackedRevision(renderDocx(parse(source))));

  assert.deepEqual(result.changes, [
    { action: "add_change_request", id: "change-c1-70-71", target: "c1", nativeId: "70/71" },
  ]);
  assert.match(result.source, /::change_request\{id="change-c1-70-71" target="c1" action="replace" from="Old \*\*claim\*\*" to="New \*claim\*" author="Reviewer" date="2026-05-25T09:00:00Z"\}/);
  assert.doesNotMatch(result.source, /id="change-c1-70"\b/);
  assert.doesNotMatch(result.source, /id="change-c1-71"\b/);
  assert.equal(result.skippedRevisions.length, 0);
});

test("syncReviewCommentsFromDocx imports multiple paragraph replacements as separate change requests", () => {
  const source = `# Review

::claim{id="c1"}
Claim.
::
`;

  const result = syncReviewCommentsFromDocx(source, docxWithMultipleTrackedReplacements(renderDocx(parse(source))));

  assert.deepEqual(result.changes, [
    { action: "add_change_request", id: "change-c1-70-71", target: "c1", nativeId: "70/71" },
    { action: "add_change_request", id: "change-c1-72-73", target: "c1", nativeId: "72/73" },
  ]);
  assert.match(result.source, /::change_request\{id="change-c1-70-71" target="c1" action="replace" from="old first" to="new first" author="Reviewer" date="2026-05-25T09:00:00Z"\}/);
  assert.match(result.source, /::change_request\{id="change-c1-72-73" target="c1" action="replace" from="old second" to="new second" author="Reviewer" date="2026-05-25T09:01:00Z"\}/);
  assert.doesNotMatch(result.source, /id="change-c1-70"\b/);
  assert.doesNotMatch(result.source, /id="change-c1-71"\b/);
  assert.equal(result.skippedRevisions.length, 0);
});

test("syncReviewCommentsFromDocx imports tracked Word moves as change requests", () => {
  const source = `# Review

::claim{id="c1"}
Claim.
::
`;

  const result = syncReviewCommentsFromDocx(source, docxWithTrackedMoveRevision(renderDocx(parse(source))));

  assert.deepEqual(result.changes, [
    { action: "add_change_request", id: "change-c1-80-81", target: "c1", nativeId: "80/81" },
  ]);
  assert.match(result.source, /::change_request\{id="change-c1-80-81" target="c1" action="replace" from="Original wording" to="Moved wording" author="Reviewer" date="2026-05-25T09:00:00Z"\}/);
  assert.equal(result.skippedRevisions.length, 0);
});

test("syncReviewCommentsFromDocx imports range-marked tracked Word moves as change requests", () => {
  const source = `# Review

::claim{id="c1"}
Claim.
::
`;

  const result = syncReviewCommentsFromDocx(source, docxWithTrackedRangeMoveRevision(renderDocx(parse(source))));

  assert.deepEqual(result.changes, [
    { action: "add_change_request", id: "change-c1-82-83", target: "c1", nativeId: "82/83" },
  ]);
  assert.match(result.source, /::change_request\{id="change-c1-82-83" target="c1" action="replace" from="Original wording" to="Moved wording" author="Reviewer" date="2026-05-25T09:00:00Z"\}/);
  assert.equal(result.skippedRevisions.length, 0);
});

test("syncReviewCommentsFromDocx imports rich Noma-rendered change request revisions", () => {
  const source = `# Review

::claim{id="c1"}
Claim.
::
`;
  const reviewed = parse(`# Review

::claim{id="c1"}
Claim.
::

::change_request{id="cr-rich" target="c1" action="replace" from="Old **claim** [source](https://example.com/old) and \`model\`." to="New *claim* [[c1]] and [source](https://example.com/new)." author="Research" date="2026-05-24T09:30:00Z"}
::
`);

  const result = syncReviewCommentsFromDocx(source, renderDocx(reviewed));

  assert.deepEqual(result.changes, [
    { action: "add_change_request", id: "change-c1-0-1", target: "c1", nativeId: "0/1" },
  ]);
  assert.match(result.source, /::change_request\{id="change-c1-0-1" target="c1" action="replace" from="Old \*\*claim\*\* \[source\]\(https:\/\/example\.com\/old\) and `model`\." to="New \*claim\* \[\[c1\]\] and \[source\]\(https:\/\/example\.com\/new\)\." author="Research" date="2026-05-24T09:30:00Z"\}/);
  assert.equal(result.skippedRevisions.length, 0);
});

test("syncReviewCommentsFromDocx adds Word table-cell revisions to the source table", () => {
  const source = `# Review

::table{id="metrics" header}
| Metric | Value |
| ARR | 10m |
::
`;

  const result = syncReviewCommentsFromDocx(source, docxWithTableCellRevision(renderDocx(parse(source))));

  assert.deepEqual(result.changes, [
    { action: "add_change_request", id: "change-metrics-21-22", target: "metrics", nativeId: "21/22" },
  ]);
  assert.match(result.source, /::change_request\{id="change-metrics-21-22" target="metrics" action="replace" from="10m" to="11m" author="Reviewer" date="2026-05-25T09:00:00Z"\}/);
  assert.match(result.source, /\| ARR \| 10m \|/);
  assert.equal(result.skippedRevisions.length, 0);
  assert.equal(result.skippedTables.length, 1);
  assert.equal(result.skippedTables[0]?.hasRevisions, true);
});

test("syncReviewCommentsFromDocx adds Word table-cell revisions to the source dataset", () => {
  const source = `# Review

::dataset{id="dataset-metrics"}
schema:
  metric: string
  value: string
rows:
  - [ARR, 10m]
::
`;

  const result = syncReviewCommentsFromDocx(source, docxWithTableCellRevision(renderDocx(parse(source))));

  assert.deepEqual(result.changes, [
    { action: "add_change_request", id: "change-dataset-metrics-21-22", target: "dataset-metrics", nativeId: "21/22" },
  ]);
  assert.match(result.source, /::change_request\{id="change-dataset-metrics-21-22" target="dataset-metrics" action="replace" from="10m" to="11m" author="Reviewer" date="2026-05-25T09:00:00Z"\}/);
  assert.match(result.source, /- \[ARR, 10m\]/);
  assert.equal(result.skippedRevisions.length, 0);
  assert.equal(result.skippedTables.length, 1);
  assert.equal(result.skippedTables[0]?.hasRevisions, true);
});

test("syncReviewCommentsFromDocx updates existing tracked change requests", () => {
  const source = `# Review

::claim{id="c1"}
Claim.
::

::change_request{id="cr1" target="c1" action="replace" from="old wording" to="new wording" author="Research" date="2026-05-24T09:30:00Z"}
Reason for the proposed edit.
::
`;
  const reviewed = parse(`# Review

::claim{id="c1"}
Claim.
::

::change_request{id="cr1" target="c1" action="replace" from="old wording" to="newer wording" author="Research" date="2026-05-24T09:30:00Z"}
Reason for the proposed edit.
::
`);

  const result = syncReviewCommentsFromDocx(source, renderDocx(reviewed));

  assert.deepEqual(result.changes, [
    { action: "update_change_request", id: "cr1", nativeId: "0/1" },
  ]);
  assert.match(result.source, /::change_request\{id="cr1" target="c1" action="replace" from="old wording" to="newer wording" author="Research" date="2026-05-24T09:30:00Z"\}/);
  assert.match(result.source, /Reason for the proposed edit\./);
  assert.equal(result.skippedRevisions.length, 0);
});

test("syncReviewCommentsFromDocx does not rewrite unchanged formatted change request attributes", () => {
  const source = `# Review

::claim{id="c1"}
Claim.
::

::change_request{id="cr1" target="c1" action="replace" from="old _wording_" to="new _wording_" author="Research" date="2026-05-24T09:30:00Z"}
Reason for the proposed edit.
::
`;

  const result = syncReviewCommentsFromDocx(source, renderDocx(parse(source)));

  assert.equal(result.source, source);
  assert.deepEqual(result.changes, []);
  assert.equal(result.skippedRevisions.length, 0);
});

test("syncReviewCommentsFromDocx does not rewrite unchanged formatted change request bodies", () => {
  const source = `# Review

::claim{id="c1"}
Claim.
::

::change_request{id="cr1" target="c1" action="insert" author="Research" date="2026-05-24T09:30:00Z"}
Add _wording_ here.
::
`;

  const result = syncReviewCommentsFromDocx(source, renderDocx(parse(source)));

  assert.equal(result.source, source);
  assert.deepEqual(result.changes, []);
  assert.equal(result.skippedRevisions.length, 0);
});

test("syncReviewCommentsFromDocx matches formatted target-only change request bodies among siblings", () => {
  const source = `# Review

::claim{id="c1"}
Claim.
::

::change_request{id="cr-a" target="c1" action="insert" author="Research" date="2026-05-24T09:30:00Z"}
Add _wording_ here.
::

::change_request{id="cr-b" target="c1" action="insert" author="Research" date="2026-05-24T09:30:00Z"}
Add second proposal.
::
`;

  const result = syncReviewCommentsFromDocx(
    source,
    docxWithoutBookmarks(renderDocx(parse(source)), ["n_cr_a_", "n_cr_b_"]),
  );

  assert.equal(result.source, source);
  assert.deepEqual(result.changes, []);
  assert.equal(result.skippedRevisions.length, 0);
});

test("syncReviewCommentsFromDocx syncs target-only change request body markup removals among siblings", () => {
  const source = `# Review

::claim{id="c1"}
Claim.
::

::change_request{id="cr-a" target="c1" action="insert" author="Research" date="2026-05-24T09:30:00Z"}
Add **wording** here.
::

::change_request{id="cr-b" target="c1" action="insert" author="Research" date="2026-05-24T09:30:00Z"}
Add second proposal.
::
`;
  const reviewed = parse(`# Review

::claim{id="c1"}
Claim.
::

::change_request{id="cr-a" target="c1" action="insert" author="Research" date="2026-05-24T09:30:00Z"}
Add wording here.
::

::change_request{id="cr-b" target="c1" action="insert" author="Research" date="2026-05-24T09:30:00Z"}
Add second proposal.
::
`);

  const result = syncReviewCommentsFromDocx(
    source,
    docxWithoutBookmarks(renderDocx(reviewed), ["n_cr_a_", "n_cr_b_"]),
  );

  assert.deepEqual(result.changes, [
    { action: "update_change_request", id: "cr-a", nativeId: "0" },
  ]);
  assert.match(result.source, /::change_request\{id="cr-a" target="c1" action="insert" author="Research" date="2026-05-24T09:30:00Z"\}\nAdd wording here\.\n::/);
  assert.match(result.source, /::change_request\{id="cr-b" target="c1" action="insert" author="Research" date="2026-05-24T09:30:00Z"\}\nAdd second proposal\.\n::/);
  assert.equal(result.skippedRevisions.length, 0);
});

test("syncReviewCommentsFromData uses metadata to identify a target-only change request", () => {
  const source = `# Review

::claim{id="c1"}
Claim.
::

::change_request{id="cr-a" target="c1" action="insert" author="Andrea" date="2026-05-24T09:00:00Z"}
Add first proposal.
::

::change_request{id="cr-b" target="c1" action="insert" author="Research" date="2026-05-24T09:30:00Z"}
Add second proposal.
::
`;

  const result = syncReviewCommentsFromData(source, {
    comments: [],
    revisions: [
      {
        nativeId: "6",
        targetId: "c1",
        action: "insert",
        author: "Andrea",
        date: "2026-05-24T09:00:00Z",
        newText: "Add first proposal.",
      },
      {
        nativeId: "7",
        targetId: "c1",
        action: "insert",
        author: "Research",
        date: "2026-05-24T09:30:00Z",
        newText: "Edited second proposal.",
      },
    ],
    footnotes: [],
    endnotes: [],
    tables: [],
    headings: [],
  });

  assert.deepEqual(result.changes, [
    { action: "update_change_request", id: "cr-b", nativeId: "7" },
  ]);
  assert.match(result.source, /::change_request\{id="cr-a" target="c1" action="insert" author="Andrea" date="2026-05-24T09:00:00Z"\}\nAdd first proposal\.\n::/);
  assert.match(result.source, /::change_request\{id="cr-b" target="c1" action="insert" author="Research" date="2026-05-24T09:30:00Z"\}\nEdited second proposal\.\n::/);
  assert.equal(result.skippedRevisions.length, 0);
});

test("syncReviewCommentsFromData does not overwrite a source change request when target-only metadata conflicts", () => {
  const source = `# Review

::claim{id="c1"}
Claim.
::

::change_request{id="cr-a" target="c1" action="insert" author="Andrea" date="2026-05-24T09:00:00Z"}
Old source proposal.
::
`;

  const result = syncReviewCommentsFromData(source, {
    comments: [],
    revisions: [
      {
        nativeId: "7",
        targetId: "c1",
        action: "insert",
        author: "Reviewer",
        date: "2026-05-24T10:00:00Z",
        newText: "New Word proposal.",
      },
    ],
    footnotes: [],
    endnotes: [],
    tables: [],
    headings: [],
  });

  assert.deepEqual(result.changes, [
    { action: "add_change_request", id: "change-c1-7", target: "c1", nativeId: "7" },
    { action: "delete_change_request", id: "cr-a", target: "c1" },
  ]);
  assert.match(result.source, /::change_request\{id="change-c1-7" target="c1" action="insert" to="New Word proposal\." author="Reviewer" date="2026-05-24T10:00:00Z"\}\n::/);
  assert.match(result.source, /::change_request\{id="cr-a" target="c1" action="insert" author="Andrea" date="2026-05-24T09:00:00Z" status="deleted"\}\nOld source proposal\.\n::/);
  assert.equal(result.skippedRevisions.length, 0);
});

test("syncReviewCommentsFromData does not collapse same-text change requests when metadata conflicts", () => {
  const source = `# Review

::claim{id="c1"}
Claim.
::

::change_request{id="cr-a" target="c1" action="insert" author="Andrea" date="2026-05-24T09:00:00Z"}
Same proposal.
::
`;

  const result = syncReviewCommentsFromData(source, {
    comments: [],
    revisions: [
      {
        nativeId: "7",
        targetId: "c1",
        action: "insert",
        author: "Reviewer",
        date: "2026-05-24T10:00:00Z",
        newText: "Same proposal.",
      },
    ],
    footnotes: [],
    endnotes: [],
    tables: [],
    headings: [],
  });

  assert.deepEqual(result.changes, [
    { action: "add_change_request", id: "change-c1-7", target: "c1", nativeId: "7" },
    { action: "delete_change_request", id: "cr-a", target: "c1" },
  ]);
  assert.match(result.source, /::change_request\{id="change-c1-7" target="c1" action="insert" to="Same proposal\." author="Reviewer" date="2026-05-24T10:00:00Z"\}\n::/);
  assert.match(result.source, /::change_request\{id="cr-a" target="c1" action="insert" author="Andrea" date="2026-05-24T09:00:00Z" status="deleted"\}\nSame proposal\.\n::/);
  assert.equal(result.skippedRevisions.length, 0);
});

test("syncReviewCommentsFromData marks missing change requests deleted when a target-anchored revision returns", () => {
  const source = `# Review

::claim{id="c1"}
Claim.
::

::change_request{id="cr-a" target="c1" action="insert" author="Andrea"}
Old source proposal.
::
`;

  const result = syncReviewCommentsFromData(source, {
    comments: [],
    revisions: [{
      nativeId: "7",
      anchorBookmarkNames: [docxBookmarkName(source, "n_c1_")],
      action: "insert",
      author: "Reviewer",
      newText: "New Word proposal.",
    }],
    footnotes: [],
    endnotes: [],
    tables: [],
    headings: [],
  });

  assert.deepEqual(result.changes, [
    { action: "add_change_request", id: "change-c1-7", target: "c1", nativeId: "7" },
    { action: "delete_change_request", id: "cr-a", target: "c1" },
  ]);
  assert.match(result.source, /::change_request\{id="change-c1-7" target="c1" action="insert" to="New Word proposal\." author="Reviewer"\}\n::/);
  assert.match(result.source, /::change_request\{id="cr-a" target="c1" action="insert" author="Andrea" status="deleted"\}\nOld source proposal\.\n::/);
  assert.equal(result.skippedRevisions.length, 0);
});

test("syncReviewCommentsFromData does not match direct source bookmarks to deleted change requests", () => {
  const source = `# Review

::claim{id="c1"}
Claim.
::

::change_request{id="cr-old" target="c1" action="insert" author="Andrea" status="deleted"}
Same proposal.
::
`;
  const activeSource = source.replace(' status="deleted"', "");
  const result = syncReviewCommentsFromData(source, {
    comments: [],
    revisions: [{
      nativeId: "7",
      sourceBookmarkNames: [docxBookmarkName(activeSource, "n_cr_old_")],
      action: "insert",
      author: "Andrea",
      newText: "Same proposal.",
    }],
    footnotes: [],
    endnotes: [],
    tables: [],
    headings: [],
  });

  assert.deepEqual(result.changes, [
    { action: "add_change_request", id: "change-c1-7", target: "c1", nativeId: "7" },
  ]);
  assert.match(result.source, /::change_request\{id="change-c1-7" target="c1" action="insert" to="Same proposal\." author="Andrea"\}\n::/);
  assert.match(result.source, /::change_request\{id="cr-old" target="c1" action="insert" author="Andrea" status="deleted"\}\nSame proposal\.\n::/);
  assert.equal(result.skippedRevisions.length, 0);
});

test("syncReviewCommentsFromDocx does not mark malformed source change requests deleted", () => {
  const source = `# Review

::claim{id="c1"}
Claim.
::

::change_request{id="cr-invalid" target="c1" action="replace" from="old wording" author="Research"}
Missing replacement text.
::

::change_request{id="cr-keep" target="c1" action="insert" text="keep this proposal" author="Research"}
Keep this in Word.
::
`;

  const result = syncReviewCommentsFromDocx(source, renderDocx(parse(source)));

  assert.deepEqual(result.changes, []);
  assert.match(result.source, /::change_request\{id="cr-invalid" target="c1" action="replace" from="old wording" author="Research"\}\nMissing replacement text\.\n::/);
  assert.match(result.source, /::change_request\{id="cr-keep" target="c1" action="insert" text="keep this proposal" author="Research"\}/);
  assert.equal(result.skippedRevisions.length, 0);
});

test("syncReviewCommentsFromData does not match target-only revisions to malformed source change requests", () => {
  const source = `# Review

::claim{id="c1"}
Claim.
::

::change_request{id="cr-invalid" target="c1" action="replace" from="old wording" author="Research"}
Missing replacement text.
::
`;
  const result = syncReviewCommentsFromData(source, {
    comments: [],
    revisions: [{
      nativeId: "7",
      targetId: "c1",
      action: "insert",
      newText: "New Word proposal.",
      author: "Research",
    }],
    footnotes: [],
    endnotes: [],
    tables: [],
    headings: [],
  });

  assert.deepEqual(result.changes, [
    { action: "add_change_request", id: "change-c1-7", target: "c1", nativeId: "7" },
  ]);
  assert.match(result.source, /::change_request\{id="cr-invalid" target="c1" action="replace" from="old wording" author="Research"\}\nMissing replacement text\.\n::/);
  assert.match(result.source, /::change_request\{id="change-c1-7" target="c1" action="insert" to="New Word proposal\." author="Research"\}\n::/);
  assert.equal(result.skippedRevisions.length, 0);
});

test("syncReviewCommentsFromDocx syncs change request markup removals", () => {
  const source = `# Review

::claim{id="c1"}
Claim.
::

::change_request{id="cr1" target="c1" action="replace" from="old **wording**" to="new [wording](https://example.com)" author="Research" date="2026-05-24T09:30:00Z"}
Reason for the proposed edit.
::
`;
  const reviewed = parse(`# Review

::claim{id="c1"}
Claim.
::

::change_request{id="cr1" target="c1" action="replace" from="old wording" to="new wording" author="Research" date="2026-05-24T09:30:00Z"}
Reason for the proposed edit.
::
`);

  const result = syncReviewCommentsFromDocx(source, renderDocx(reviewed));

  assert.deepEqual(result.changes, [
    { action: "update_change_request", id: "cr1", nativeId: "0/1" },
  ]);
  assert.match(result.source, /::change_request\{id="cr1" target="c1" action="replace" from="old wording" to="new wording" author="Research" date="2026-05-24T09:30:00Z"\}/);
  assert.equal(result.skippedRevisions.length, 0);
});

test("syncReviewCommentsFromDocx marks missing sibling change requests deleted", () => {
  const source = `# Review

::claim{id="c1"}
Claim.
::

::change_request{id="cr-delete" target="c1" action="insert" text="delete this proposal" author="Research"}
Delete this in Word.
::

::change_request{id="cr-keep" target="c1" action="insert" text="keep this proposal" author="Research"}
Keep this in Word.
::
`;
  const reviewed = parse(`# Review

::claim{id="c1"}
Claim.
::

::change_request{id="cr-keep" target="c1" action="insert" text="keep this proposal" author="Research"}
Keep this in Word.
::
`);

  const result = syncReviewCommentsFromDocx(source, renderDocx(reviewed));

  assert.deepEqual(result.changes, [
    { action: "delete_change_request", id: "cr-delete", target: "c1" },
  ]);
  assert.match(result.source, /::change_request\{id="cr-delete" target="c1" action="insert" text="delete this proposal" author="Research" status="deleted"\}/);
  assert.match(result.source, /::change_request\{id="cr-keep" target="c1" action="insert" text="keep this proposal" author="Research"\}/);
  assert.equal(result.skippedRevisions.length, 0);
});

test("syncReviewCommentsFromDocx adds native footnotes and endnotes to source", () => {
  const source = `# Review

::claim{id="c1"}
Claim.
::
`;
  const reviewed = parse(`# Review

::claim{id="c1"}
Claim.
::

::footnote{id="word-footnote" for="c1"}
Footnote from Word review.
::

::endnote{id="word-endnote" for="c1"}
Endnote from Word review.
::
`);

  const result = syncReviewCommentsFromDocx(source, renderDocx(reviewed));

  assert.deepEqual(result.changes, [
    { action: "add_footnote", id: "footnote-c1-1", target: "c1", nativeId: "1" },
    { action: "add_endnote", id: "endnote-c1-1", target: "c1", nativeId: "1" },
  ]);
  assert.match(result.source, /::footnote\{id="footnote-c1-1" for="c1"\}\nFootnote from Word review\.\n::/);
  assert.match(result.source, /::endnote\{id="endnote-c1-1" for="c1"\}\nEndnote from Word review\.\n::/);
  assert.equal(result.skippedFootnotes.length, 0);
  assert.equal(result.skippedEndnotes.length, 0);
  assert.equal(result.skippedTables.length, 0);
});

test("syncReviewCommentsFromDocx adds Word table-cell notes to the source table", () => {
  const source = `# Review

::table{id="metrics" header}
| Metric | Value |
| ARR | 10m |
::
`;

  const result = syncReviewCommentsFromDocx(source, docxWithTableCellNotes(renderDocx(parse(source))));

  assert.deepEqual(result.changes, [
    { action: "add_footnote", id: "footnote-metrics-9", target: "metrics", nativeId: "9" },
    { action: "add_endnote", id: "endnote-metrics-10", target: "metrics", nativeId: "10" },
  ]);
  assert.match(result.source, /::footnote\{id="footnote-metrics-9" for="metrics"\}\nFootnote on the ARR value\.\n::/);
  assert.match(result.source, /::endnote\{id="endnote-metrics-10" for="metrics"\}\nEndnote on the ARR value\.\n::/);
  assert.equal(result.skippedFootnotes.length, 0);
  assert.equal(result.skippedEndnotes.length, 0);
});

test("syncReviewCommentsFromDocx adds Word table-cell notes to the source dataset", () => {
  const source = `# Review

::dataset{id="dataset-metrics"}
schema:
  metric: string
  value: string
rows:
  - [ARR, 10m]
::
`;

  const result = syncReviewCommentsFromDocx(source, docxWithTableCellNotes(renderDocx(parse(source))));

  assert.deepEqual(result.changes, [
    { action: "add_footnote", id: "footnote-dataset-metrics-9", target: "dataset-metrics", nativeId: "9" },
    { action: "add_endnote", id: "endnote-dataset-metrics-10", target: "dataset-metrics", nativeId: "10" },
  ]);
  assert.match(result.source, /::footnote\{id="footnote-dataset-metrics-9" for="dataset-metrics"\}\nFootnote on the ARR value\.\n::/);
  assert.match(result.source, /::endnote\{id="endnote-dataset-metrics-10" for="dataset-metrics"\}\nEndnote on the ARR value\.\n::/);
  assert.equal(result.skippedFootnotes.length, 0);
  assert.equal(result.skippedEndnotes.length, 0);
});

test("syncReviewCommentsFromDocx updates targeted footnote and endnote bodies", () => {
  const source = `# Review

::claim{id="c1"}
Claim.
::

::footnote{id="fn-c1" for="c1"}
Original targeted footnote.
::

::endnote{id="en-c1" for="c1"}
Original targeted endnote.
::
`;
  const reviewed = parse(`# Review

::claim{id="c1"}
Claim.
::

::footnote{id="fn-c1" for="c1"}
Edited targeted footnote from Word.
::

::endnote{id="en-c1" for="c1"}
Edited targeted endnote from Word.
::
`);

  const result = syncReviewCommentsFromDocx(source, renderDocx(reviewed));

  assert.deepEqual(result.changes, [
    { action: "update_footnote", id: "fn-c1", nativeId: "1" },
    { action: "update_endnote", id: "en-c1", nativeId: "1" },
  ]);
  assert.match(result.source, /::footnote\{id="fn-c1" for="c1"\}\nEdited targeted footnote from Word\.\n::/);
  assert.match(result.source, /::endnote\{id="en-c1" for="c1"\}\nEdited targeted endnote from Word\.\n::/);
  assert.equal(result.skippedFootnotes.length, 0);
  assert.equal(result.skippedEndnotes.length, 0);
});

test("syncReviewCommentsFromDocx ignores generated empty note fallback text", () => {
  const source = `# Review

::claim{id="c1"}
Claim.
::

::footnote{id="fn-empty" for="c1"}
::

::endnote{id="en-empty" for="c1"}
::
`;

  const result = syncReviewCommentsFromDocx(source, renderDocx(parse(source)));

  assert.deepEqual(result.changes, []);
  assert.equal(result.source, source);
  assert.equal(result.skippedFootnotes.length, 0);
  assert.equal(result.skippedEndnotes.length, 0);
});

test("syncReviewCommentsFromDocx skips tracked note body revisions", () => {
  const source = `# Review

::claim{id="c1"}
Claim.
::

::footnote{id="fn1" for="c1"}
Original footnote.
::

::endnote{id="en1" for="c1"}
Original endnote.
::
`;

  const result = syncReviewCommentsFromDocx(source, docxWithTrackedNoteBody(renderDocx(parse(source))));

  assert.deepEqual(result.changes, []);
  assert.equal(result.source, source);
  assert.equal(result.skippedFootnotes.length, 1);
  assert.equal(result.skippedFootnotes[0]?.body, "Edited footnote.");
  assert.equal(result.skippedFootnotes[0]?.hasRevisions, true);
  assert.equal(result.skippedEndnotes.length, 1);
  assert.equal(result.skippedEndnotes[0]?.body, "Edited endnote.");
  assert.equal(result.skippedEndnotes[0]?.hasRevisions, true);
});

test("syncReviewCommentsFromData does not delete target-only notes with tracked revisions", () => {
  const source = `# Review

::claim{id="c1"}
Claim.
::

::footnote{id="fn1" for="c1"}
Original footnote.
::
`;

  const result = syncReviewCommentsFromData(source, {
    comments: [],
    revisions: [],
    footnotes: [{
      nativeId: "1",
      anchorBookmarkNames: [docxBookmarkName(source, "n_c1_")],
      hasRevisions: true,
      body: "Edited footnote.",
    }],
    endnotes: [],
    tables: [],
    headings: [],
  });

  assert.deepEqual(result.changes, []);
  assert.equal(result.source, source);
  assert.equal(result.skippedFootnotes.length, 1);
  assert.equal(result.skippedFootnotes[0]?.hasRevisions, true);
});

test("syncReviewCommentsFromDocx preserves multiple same-target source notes", () => {
  const source = `# Review

::claim{id="c1"}
Claim.
::

::footnote{id="fn-a" for="c1"}
First footnote.
::

::footnote{id="fn-b" for="c1"}
Second footnote.
::

::endnote{id="en-a" for="c1"}
First endnote.
::

::endnote{id="en-b" for="c1"}
Second endnote.
::
`;

  const result = syncReviewCommentsFromDocx(source, renderDocx(parse(source)));

  assert.deepEqual(result.changes, []);
  assert.equal(result.source, source);
  assert.equal(result.skippedFootnotes.length, 0);
  assert.equal(result.skippedEndnotes.length, 0);
});

test("syncReviewCommentsFromDocx marks missing sibling targeted notes deleted", () => {
  const source = `# Review

::claim{id="c1"}
Claim.
::

::footnote{id="fn-delete" for="c1"}
Delete this footnote in Word.
::

::footnote{id="fn-keep" for="c1"}
Keep this footnote.
::

::endnote{id="en-delete" for="c1"}
Delete this endnote in Word.
::

::endnote{id="en-keep" for="c1"}
Keep this endnote.
::
`;
  const reviewed = parse(`# Review

::claim{id="c1"}
Claim.
::

::footnote{id="fn-keep" for="c1"}
Keep this footnote.
::

::endnote{id="en-keep" for="c1"}
Keep this endnote.
::
`);

  const result = syncReviewCommentsFromDocx(source, renderDocx(reviewed));

  assert.deepEqual(result.changes, [
    { action: "delete_footnote", id: "fn-delete", target: "c1" },
    { action: "delete_endnote", id: "en-delete", target: "c1" },
  ]);
  assert.match(result.source, /::footnote\{id="fn-delete" for="c1" status="deleted"\}/);
  assert.match(result.source, /::footnote\{id="fn-keep" for="c1"\}\nKeep this footnote\.\n::/);
  assert.match(result.source, /::endnote\{id="en-delete" for="c1" status="deleted"\}/);
  assert.match(result.source, /::endnote\{id="en-keep" for="c1"\}\nKeep this endnote\.\n::/);
  assert.equal(result.skippedFootnotes.length, 0);
  assert.equal(result.skippedEndnotes.length, 0);
});

test("syncReviewCommentsFromData does not match direct source bookmarks to deleted targeted notes", () => {
  const source = `# Review

::claim{id="c1"}
Claim.
::

::footnote{id="fn-old" for="c1" status="deleted"}
Same footnote.
::

::endnote{id="en-old" for="c1" status="deleted"}
Same endnote.
::
`;
  const activeSource = source.replace(' status="deleted"', "").replace(' status="deleted"', "");
  const result = syncReviewCommentsFromData(source, {
    comments: [],
    revisions: [],
    footnotes: [{
      nativeId: "7",
      anchorBookmarkNames: [docxBookmarkName(activeSource, "n_fn_old_")],
      body: "Same footnote.",
    }],
    endnotes: [{
      nativeId: "8",
      anchorBookmarkNames: [docxBookmarkName(activeSource, "n_en_old_")],
      body: "Same endnote.",
    }],
    tables: [],
    headings: [],
  });

  assert.deepEqual(result.changes, [
    { action: "add_footnote", id: "footnote-c1-7", target: "c1", nativeId: "7" },
    { action: "add_endnote", id: "endnote-c1-8", target: "c1", nativeId: "8" },
  ]);
  assert.match(result.source, /::footnote\{id="footnote-c1-7" for="c1"\}\nSame footnote\.\n::/);
  assert.match(result.source, /::footnote\{id="fn-old" for="c1" status="deleted"\}\nSame footnote\.\n::/);
  assert.match(result.source, /::endnote\{id="endnote-c1-8" for="c1"\}\nSame endnote\.\n::/);
  assert.match(result.source, /::endnote\{id="en-old" for="c1" status="deleted"\}\nSame endnote\.\n::/);
  assert.equal(result.skippedFootnotes.length, 0);
  assert.equal(result.skippedEndnotes.length, 0);
});

test("syncReviewCommentsFromDocx matches formatted target-only notes among siblings", () => {
  const source = `# Review

::claim{id="c1"}
Claim.
::

::footnote{id="fn-a" for="c1"}
First _note_.
::

::footnote{id="fn-b" for="c1"}
Second note.
::
`;

  const result = syncReviewCommentsFromDocx(
    source,
    docxWithoutBookmarks(renderDocx(parse(source)), ["n_fn_a_", "n_fn_b_"]),
  );

  assert.equal(result.source, source);
  assert.deepEqual(result.changes, []);
  assert.equal(result.skippedFootnotes.length, 0);
});

test("syncReviewCommentsFromDocx syncs target-only note markup removals among siblings", () => {
  const source = `# Review

::claim{id="c1"}
Claim.
::

::footnote{id="fn-a" for="c1"}
First **note** with [source](https://example.com).
::

::footnote{id="fn-b" for="c1"}
Second note.
::

::endnote{id="en-a" for="c1"}
First **endnote** with [source](https://example.com).
::

::endnote{id="en-b" for="c1"}
Second endnote.
::
`;
  const reviewed = parse(`# Review

::claim{id="c1"}
Claim.
::

::footnote{id="fn-a" for="c1"}
First note with source.
::

::footnote{id="fn-b" for="c1"}
Second note.
::

::endnote{id="en-a" for="c1"}
First endnote with source.
::

::endnote{id="en-b" for="c1"}
Second endnote.
::
`);

  const result = syncReviewCommentsFromDocx(
    source,
    docxWithoutBookmarks(renderDocx(reviewed), ["n_fn_a_", "n_fn_b_", "n_en_a_", "n_en_b_"]),
  );

  assert.deepEqual(result.changes, [
    { action: "update_footnote", id: "fn-a", nativeId: "1" },
    { action: "update_endnote", id: "en-a", nativeId: "1" },
  ]);
  assert.match(result.source, /::footnote\{id="fn-a" for="c1"\}\nFirst note with source\.\n::/);
  assert.match(result.source, /::footnote\{id="fn-b" for="c1"\}\nSecond note\.\n::/);
  assert.match(result.source, /::endnote\{id="en-a" for="c1"\}\nFirst endnote with source\.\n::/);
  assert.match(result.source, /::endnote\{id="en-b" for="c1"\}\nSecond endnote\.\n::/);
  assert.equal(result.skippedFootnotes.length, 0);
  assert.equal(result.skippedEndnotes.length, 0);
});

test("syncReviewCommentsFromDocx updates source-position footnote bodies", () => {
  const source = `# Review

::footnote{id="fn1"}
Original note.
::
`;
  const reviewed = parse(`# Review

::footnote{id="fn1"}
Edited note from Word.
::
`);

  const result = syncReviewCommentsFromDocx(source, renderDocx(reviewed));

  assert.deepEqual(result.changes, [
    { action: "update_footnote", id: "fn1", nativeId: "1" },
  ]);
  assert.match(result.source, /::footnote\{id="fn1"\}\nEdited note from Word\.\n::/);
});

test("syncReviewCommentsFromDocx updates source-position endnote bodies", () => {
  const source = `# Review

::endnote{id="en1"}
Original endnote.
::
`;
  const reviewed = parse(`# Review

::endnote{id="en1"}
Edited endnote from Word.
::
`);

  const result = syncReviewCommentsFromDocx(source, renderDocx(reviewed));

  assert.deepEqual(result.changes, [
    { action: "update_endnote", id: "en1", nativeId: "1" },
  ]);
  assert.match(result.source, /::endnote\{id="en1"\}\nEdited endnote from Word\.\n::/);
  assert.equal(result.skippedEndnotes.length, 0);
});

test("syncReviewCommentsFromDocx does not flatten unchanged formatted source notes", () => {
  const source = `# Review

::footnote{id="fn1"}
Footnote has **bold**, _emphasis_, and [source](https://example.com).
::
`;

  const result = syncReviewCommentsFromDocx(source, renderDocx(parse(source)));

  assert.equal(result.source, source);
  assert.deepEqual(result.changes, []);
  assert.equal(result.skippedFootnotes.length, 0);
});

test("syncReviewCommentsFromDocx does not flatten unchanged formatted source endnotes", () => {
  const source = `# Review

::endnote{id="en1"}
Endnote has **bold**, _emphasis_, and [source](https://example.com).
::
`;

  const result = syncReviewCommentsFromDocx(source, renderDocx(parse(source)));

  assert.equal(result.source, source);
  assert.deepEqual(result.changes, []);
  assert.equal(result.skippedEndnotes.length, 0);
});

test("syncReviewCommentsFromDocx syncs Word note markup removals", () => {
  const source = `# Review

::footnote{id="fn1"}
Footnote has **bold** and [source](https://example.com).
::
`;
  const reviewed = parse(`# Review

::footnote{id="fn1"}
Footnote has bold and source.
::
`);

  const result = syncReviewCommentsFromDocx(source, renderDocx(reviewed));

  assert.deepEqual(result.changes, [
    { action: "update_footnote", id: "fn1", nativeId: "1" },
  ]);
  assert.match(result.source, /::footnote\{id="fn1"\}\nFootnote has bold and source\.\n::/);
  assert.equal(result.skippedFootnotes.length, 0);
});

test("syncReviewCommentsFromDocx syncs Word endnote markup removals", () => {
  const source = `# Review

::endnote{id="en1"}
Endnote has **bold** and [source](https://example.com).
::
`;
  const reviewed = parse(`# Review

::endnote{id="en1"}
Endnote has bold and source.
::
`);

  const result = syncReviewCommentsFromDocx(source, renderDocx(reviewed));

  assert.deepEqual(result.changes, [
    { action: "update_endnote", id: "en1", nativeId: "1" },
  ]);
  assert.match(result.source, /::endnote\{id="en1"\}\nEndnote has bold and source\.\n::/);
  assert.equal(result.skippedEndnotes.length, 0);
});

test("syncReviewCommentsFromDocx updates native Word table edits in source", () => {
  const source = `# Review

::table{id="metrics" header}
| Metric | Value |
| ARR | 10m |
::
`;
  const reviewed = parse(`# Review

::table{id="metrics" header}
| Metric | Value |
| ARR | 11m |
| NRR | 120% |
::
`);

  const result = syncReviewCommentsFromDocx(source, renderDocx(reviewed));

  assert.deepEqual(result.changes, [
    { action: "update_table", id: "metrics", nativeId: "0" },
  ]);
  assert.match(result.source, /::table\{id="metrics" header\}\n\| Metric \| Value \|\n\| ARR \| 11m \|\n\| NRR \| 120% \|\n::/);
  assert.equal(result.skippedTables.length, 0);
});

test("syncReviewCommentsFromDocx skips nested native tables inside source table cells", () => {
  const source = `# Review

::table{id="metrics" header}
| Metric | Value |
| ARR | 10m |
::
`;

  const result = syncReviewCommentsFromDocx(source, docxWithNestedNativeTableCell(renderDocx(parse(source))));

  assert.deepEqual(result.changes, []);
  assert.equal(result.source, source);
  assert.equal(result.skippedTables.length, 1);
  assert.deepEqual(result.skippedTables[0]?.rows, [
    ["Metric", "Value"],
    ["ARR", "Summary\nLow\nHigh\nDone"],
  ]);
});

test("syncReviewCommentsFromDocx updates native Word table edits inside layout cells", () => {
  const source = `# Review

::grid{id="layout" columns=1}
:::card{id="card" title="Metrics"}
::::table{id="metrics" header}
| Metric | Value |
| ARR | 10m |
::::
:::
::
`;
  const reviewed = parse(`# Review

::grid{id="layout" columns=1}
:::card{id="card" title="Metrics"}
::::table{id="metrics" header}
| Metric | Value |
| ARR | 11m |
| NRR | 120% |
::::
:::
::
`);

  const result = syncReviewCommentsFromDocx(source, renderDocx(reviewed));

  assert.deepEqual(result.changes, [
    { action: "update_table", id: "metrics", nativeId: "0" },
  ]);
  assert.match(result.source, /::::table\{id="metrics" header\}\n\| Metric \| Value \|\n\| ARR \| 11m \|\n\| NRR \| 120% \|\n::::/);
  assert.equal(result.skippedTables.length, 0);
});

test("syncReviewCommentsFromDocx updates native dataset edits inside layout cells", () => {
  const source = `# Review

::grid{id="layout" columns=1}
:::card{id="card" title="Metrics"}
::::dataset{id="metrics" format="csv"}
Metric,Value
ARR,10m
::::
:::
::
`;
  const reviewed = parse(`# Review

::grid{id="layout" columns=1}
:::card{id="card" title="Metrics"}
::::dataset{id="metrics" format="csv"}
Metric,Value
ARR,11m
NRR,120%
::::
:::
::
`);

  const result = syncReviewCommentsFromDocx(source, renderDocx(reviewed));

  assert.deepEqual(result.changes, [
    { action: "update_dataset", id: "metrics", nativeId: "0" },
  ]);
  assert.match(result.source, /::::dataset\{id="metrics" format="csv"\}\nMetric,Value\nARR,11m\nNRR,120%\n::::/);
  assert.equal(result.skippedTables.length, 0);
});

test("syncReviewCommentsFromDocx anchors nested layout table-cell review items to the table", () => {
  const source = `# Review

::grid{id="layout" columns=1}
:::card{id="card" title="Metrics"}
::::table{id="metrics" header}
| Metric | Value |
| ARR | 10m |
::::
:::
::
`;

  const result = syncReviewCommentsFromDocx(source, docxWithNestedLayoutTableCellReview(renderDocx(parse(source))));

  assert.deepEqual(result.changes, [
    { action: "add_comment", id: "comment-metrics-74", target: "metrics", nativeId: "74" },
    { action: "add_change_request", id: "change-metrics-84-85", target: "metrics", nativeId: "84/85" },
  ]);
  assert.match(result.source, /::::comment\{id="comment-metrics-74" parent="metrics" author="Reviewer" initials="R"\}/);
  assert.match(result.source, /Review the nested table value\./);
  assert.match(result.source, /::::change_request\{id="change-metrics-84-85" target="metrics" action="replace" from="10m" to="11m" author="Reviewer" date="2026-05-25T09:00:00Z"\}/);
  assert.doesNotMatch(result.source, /parent="card"|target="card"|parent="layout"|target="layout"/);
  assert.equal(result.skipped.length, 0);
  assert.equal(result.skippedRevisions.length, 0);
  assert.equal(result.skippedTables.length, 1);
  assert.equal(result.skippedTables[0]?.hasRevisions, true);
});

test("syncReviewCommentsFromDocx anchors nested layout dataset-cell review items to the dataset", () => {
  const source = `# Review

::grid{id="layout" columns=1}
:::card{id="card" title="Metrics"}
::::dataset{id="metrics" format="csv"}
Metric,Value
ARR,10m
::::
:::
::
`;

  const result = syncReviewCommentsFromDocx(source, docxWithNestedLayoutTableCellReview(renderDocx(parse(source))));

  assert.deepEqual(result.changes, [
    { action: "add_comment", id: "comment-metrics-74", target: "metrics", nativeId: "74" },
    { action: "add_change_request", id: "change-metrics-84-85", target: "metrics", nativeId: "84/85" },
  ]);
  assert.match(result.source, /::::comment\{id="comment-metrics-74" parent="metrics" author="Reviewer" initials="R"\}/);
  assert.match(result.source, /Review the nested table value\./);
  assert.match(result.source, /::::change_request\{id="change-metrics-84-85" target="metrics" action="replace" from="10m" to="11m" author="Reviewer" date="2026-05-25T09:00:00Z"\}/);
  assert.doesNotMatch(result.source, /parent="card"|target="card"|parent="layout"|target="layout"/);
  assert.equal(result.skipped.length, 0);
  assert.equal(result.skippedRevisions.length, 0);
  assert.equal(result.skippedTables.length, 1);
  assert.equal(result.skippedTables[0]?.hasRevisions, true);
});

test("syncReviewCommentsFromDocx syncs Word table-cell markup removals", () => {
  const source = `# Review

::table{id="metrics" header}
| Metric | Value |
| **ARR** | [10m](https://example.com/arr) |
::
`;
  const reviewed = parse(`# Review

::table{id="metrics" header}
| Metric | Value |
| ARR | 10m |
::
`);

  const result = syncReviewCommentsFromDocx(source, renderDocx(reviewed));

  assert.deepEqual(result.changes, [
    { action: "update_table", id: "metrics", nativeId: "0" },
  ]);
  assert.match(result.source, /\| ARR \| 10m \|/);
  assert.doesNotMatch(result.source, /\*\*ARR\*\*|\[10m\]\(https:\/\/example\.com\/arr\)/);
  assert.equal(result.skippedTables.length, 0);
});

test("syncReviewCommentsFromDocx preserves formatted table cells around an accepted Word cell edit", () => {
  const source = `# Review

::table{id="metrics" header}
| Metric | Value | Source |
| **ARR** | 10m | [model](https://example.com/arr) |
| NRR | 120% | [crm](https://example.com/nrr) |
::
`;

  const result = syncReviewCommentsFromDocx(source, docxWithAcceptedTableCellEdit(renderDocx(parse(source))));

  assert.deepEqual(result.changes, [
    { action: "update_table", id: "metrics", nativeId: "0" },
  ]);
  assert.match(result.source, /\| \*\*ARR\*\* \| 11m \| \[model\]\(https:\/\/example\.com\/arr\) \|/);
  assert.match(result.source, /\| NRR \| 120% \| \[crm\]\(https:\/\/example\.com\/nrr\) \|/);
  assert.equal(result.skippedTables.length, 0);
});

test("syncReviewCommentsFromDocx keeps accepted table edits after Word table restyling", () => {
  const source = `# Review

::table{id="metrics" header}
| Metric | Value |
| ARR | 10m |
::
`;

  const result = syncReviewCommentsFromDocx(source, docxWithRestyledAcceptedTableCellEdit(renderDocx(parse(source))));

  assert.deepEqual(result.changes, [
    { action: "update_table", id: "metrics", nativeId: "0" },
  ]);
  assert.match(result.source, /\| ARR \| 11m \|/);
  assert.equal(result.skippedTables.length, 0);
});

test("syncReviewCommentsFromDocx preserves rich accepted Word table cell edits", () => {
  const source = `# Review

::table{id="metrics" header}
| Metric | Value |
| ARR | 10m |
::
`;
  const reviewed = parse(`# Review

::table{id="metrics" header}
| Metric | Value |
| ARR | [11m](https://example.com/arr) |
::
`);

  const result = syncReviewCommentsFromDocx(source, renderDocx(reviewed));

  assert.deepEqual(result.changes, [
    { action: "update_table", id: "metrics", nativeId: "0" },
  ]);
  assert.match(result.source, /\| ARR \| \[11m\]\(https:\/\/example\.com\/arr\) \|/);
  assert.equal(result.skippedTables.length, 0);
});

test("syncReviewCommentsFromDocx preserves rich accepted Word table header edits", () => {
  const source = `# Review

::table{id="metrics" header}
| Metric | Value |
| ARR | 10m |
::
`;
  const reviewed = parse(`# Review

::table{id="metrics" header}
| **Metric** | [Value](https://example.com/value) |
| ARR | 10m |
::
`);

  const result = syncReviewCommentsFromDocx(source, renderDocx(reviewed));

  assert.deepEqual(result.changes, [
    { action: "update_table", id: "metrics", nativeId: "0" },
  ]);
  assert.match(result.source, /\| \*\*Metric\*\* \| \[Value\]\(https:\/\/example\.com\/value\) \|/);
  assert.equal(result.skippedTables.length, 0);
});

test("syncReviewCommentsFromDocx preserves source rows around accepted Word table header edits", () => {
  const source = `# Review

::table{id="metrics" header}
  | Metric | Value |
  | **ARR** | [10m](https://example.com/arr) |
::
`;
  const reviewed = parse(`# Review

::table{id="metrics" header}
| Metric | Revenue |
| **ARR** | [10m](https://example.com/arr) |
::
`);

  const result = syncReviewCommentsFromDocx(source, renderDocx(reviewed));

  assert.deepEqual(result.changes, [
    { action: "update_table", id: "metrics", nativeId: "0" },
  ]);
  assert.match(result.source, /  \| Metric \| Revenue \|/);
  assert.match(result.source, /  \| \*\*ARR\*\* \| \[10m\]\(https:\/\/example\.com\/arr\) \|/);
  assert.equal(result.skippedTables.length, 0);
});

test("syncReviewCommentsFromDocx does not rewrite unchanged formatted table headers", () => {
  const source = `# Review

::table{id="metrics" header}
| **Metric** | [Value](https://example.com/value) |
| ARR | 10m |
::
`;

  const result = syncReviewCommentsFromDocx(source, renderDocx(parse(source)));

  assert.equal(result.source, source);
  assert.deepEqual(result.changes, []);
  assert.equal(result.skippedTables.length, 0);
});

test("syncReviewCommentsFromDocx does not rewrite unchanged escaped table pipes", () => {
  const source = `# Review

::table{id="metrics" header}
| Metric | Source | Code |
| ARR\\|NRR | [C\\|D](https://example.com/pipe) | \`x\\|y\` |
::
`;

  const result = syncReviewCommentsFromDocx(source, renderDocx(parse(source)));

  assert.equal(result.source, source);
  assert.deepEqual(result.changes, []);
  assert.equal(result.skippedTables.length, 0);
});

test("syncReviewCommentsFromDocx preserves code-span pipes in edited table cells", () => {
  const source = `# Review

::table{id="metrics" header}
| Metric | Value |
| ARR | old |
::
`;
  const reviewed = parse(`# Review

::table{id="metrics" header}
| Metric | Value |
| ARR | \`code|value\` |
::
`);

  const result = syncReviewCommentsFromDocx(source, renderDocx(reviewed));

  assert.deepEqual(result.changes, [
    { action: "update_table", id: "metrics", nativeId: "0" },
  ]);
  assert.ok(result.source.includes("| ARR | `code|value` |"));
  assert.ok(!result.source.includes("`code\\|value`"));
  assert.equal(result.skippedTables.length, 0);
});

test("syncReviewCommentsFromDocx does not rewrite unchanged alias internal links in table cells", () => {
  const source = `# Review

## Details {id="review-details" aliases="details"}

::table{id="metrics" header}
| Metric | Source |
| ARR | [*detail note*](#details) |
::
`;

  const result = syncReviewCommentsFromDocx(source, renderDocx(parse(source)));

  assert.equal(result.source, source);
  assert.deepEqual(result.changes, []);
  assert.equal(result.skippedTables.length, 0);
});

test("syncReviewCommentsFromDocx preserves existing table row markup when Word appends a row", () => {
  const source = `# Review

::table{id="metrics" header}
| Metric | Value |
| **ARR** | [10m](https://example.com/arr) |
::
`;
  const reviewed = parse(`# Review

::table{id="metrics" header}
| Metric | Value |
| **ARR** | [10m](https://example.com/arr) |
| NRR | 120% |
::
`);

  const result = syncReviewCommentsFromDocx(source, renderDocx(reviewed));

  assert.deepEqual(result.changes, [
    { action: "update_table", id: "metrics", nativeId: "0" },
  ]);
  assert.match(result.source, /\| \*\*ARR\*\* \| \[10m\]\(https:\/\/example\.com\/arr\) \|\n\| NRR \| 120% \|/);
  assert.equal(result.skippedTables.length, 0);
});

test("syncReviewCommentsFromDocx preserves existing table markup when Word inserts a column", () => {
  const source = `# Review

::table{id="metrics" header}
| Metric | Value |
| **ARR** | [10m](https://example.com/arr) |
| NRR | 120% |
::
`;
  const reviewed = parse(`# Review

::table{id="metrics" header}
| Metric | Owner | Value |
| **ARR** | Finance | [10m](https://example.com/arr) |
| NRR | Sales | 120% |
::
`);

  const result = syncReviewCommentsFromDocx(source, renderDocx(reviewed));

  assert.deepEqual(result.changes, [
    { action: "update_table", id: "metrics", nativeId: "0" },
  ]);
  assert.match(result.source, /\| Metric \| Owner \| Value \|/);
  assert.match(result.source, /\| \*\*ARR\*\* \| Finance \| \[10m\]\(https:\/\/example\.com\/arr\) \|/);
  assert.match(result.source, /\| NRR \| Sales \| 120% \|/);
  assert.equal(result.skippedTables.length, 0);
});

test("syncReviewCommentsFromDocx preserves existing table markup when Word deletes a column", () => {
  const source = `# Review

::table{id="metrics" header}
| Metric | Owner | Value |
| **ARR** | Finance | [10m](https://example.com/arr) |
| NRR | Sales | 120% |
::
`;
  const reviewed = parse(`# Review

::table{id="metrics" header}
| Metric | Value |
| **ARR** | [10m](https://example.com/arr) |
| NRR | 120% |
::
`);

  const result = syncReviewCommentsFromDocx(source, renderDocx(reviewed));

  assert.deepEqual(result.changes, [
    { action: "update_table", id: "metrics", nativeId: "0" },
  ]);
  assert.match(result.source, /\| Metric \| Value \|/);
  assert.match(result.source, /\| \*\*ARR\*\* \| \[10m\]\(https:\/\/example\.com\/arr\) \|/);
  assert.match(result.source, /\| NRR \| 120% \|/);
  assert.doesNotMatch(result.source, /Finance|Sales|Owner/);
  assert.equal(result.skippedTables.length, 0);
});

test("syncReviewCommentsFromDocx adds Word table-cell comments to the source table", () => {
  const source = `# Review

::table{id="metrics" header}
| Metric | Value |
| ARR | 10m |
::
`;

  const result = syncReviewCommentsFromDocx(source, docxWithTableCellComment(renderDocx(parse(source))));

  assert.deepEqual(result.changes, [
    { action: "add_comment", id: "comment-metrics-42", target: "metrics", nativeId: "42" },
  ]);
  assert.match(result.source, /::comment\{id="comment-metrics-42" parent="metrics" author="Reviewer" initials="R"\}/);
  assert.match(result.source, /Check the ARR value\./);
  assert.equal(result.skipped.length, 0);
  assert.equal(result.skippedTables.length, 0);
});

test("syncReviewCommentsFromDocx adds Word point comments to the source table", () => {
  const source = `# Review

::table{id="metrics" header}
| Metric | Value |
| ARR | 10m |
::
`;

  const result = syncReviewCommentsFromDocx(source, docxWithTableCellPointComment(renderDocx(parse(source))));

  assert.deepEqual(result.changes, [
    { action: "add_comment", id: "comment-metrics-42", target: "metrics", nativeId: "42" },
  ]);
  assert.match(result.source, /::comment\{id="comment-metrics-42" parent="metrics" author="Reviewer" initials="R"\}/);
  assert.match(result.source, /Check the ARR value\./);
  assert.equal(result.skipped.length, 0);
  assert.equal(result.skippedTables.length, 0);
});

test("syncReviewCommentsFromDocx adds Word table-cell comments to the source dataset", () => {
  const source = `# Review

::dataset{id="dataset-metrics"}
schema:
  metric: string
  value: string
rows:
  - [ARR, 10m]
::
`;

  const result = syncReviewCommentsFromDocx(source, docxWithTableCellComment(renderDocx(parse(source))));

  assert.deepEqual(result.changes, [
    { action: "add_comment", id: "comment-dataset-metrics-42", target: "dataset-metrics", nativeId: "42" },
  ]);
  assert.match(result.source, /::comment\{id="comment-dataset-metrics-42" parent="dataset-metrics" author="Reviewer" initials="R"\}/);
  assert.match(result.source, /Check the ARR value\./);
  assert.equal(result.skipped.length, 0);
  assert.equal(result.skippedTables.length, 0);
});

test("syncReviewCommentsFromDocx updates native dataset table edits in source", () => {
  const source = `# Review

::dataset{id="vertical-scores" title="Vertical scores"}
schema:
  vertical: string
  score: number
rows:
  - [legal, 18]
  - [finance, 24]
::
`;
  const reviewed = parse(`# Review

::dataset{id="vertical-scores" title="Vertical scores"}
schema:
  vertical: string
  score: number
rows:
  - [legal, 18]
  - [finance, 25]
  - [healthcare, 31]
::
`);

  const result = syncReviewCommentsFromDocx(source, renderDocx(reviewed));

  assert.deepEqual(result.changes, [
    { action: "update_dataset", id: "vertical-scores", nativeId: "0" },
  ]);
  assert.match(result.source, /::dataset\{id="vertical-scores" title="Vertical scores"\}\nschema:\n  vertical: string\n  score: number\nrows:\n  - \[legal, 18\]\n  - \[finance, 25\]\n  - \[healthcare, 31\]\n::/);
  assert.equal(result.skippedTables.length, 0);
});

test("syncReviewCommentsFromDocx skips nested native tables inside dataset cells", () => {
  const source = `# Review

::dataset{id="metrics" format="csv"}
Metric,Value
ARR,10m
::
`;

  const result = syncReviewCommentsFromDocx(source, docxWithNestedNativeTableCell(renderDocx(parse(source))));

  assert.deepEqual(result.changes, []);
  assert.equal(result.source, source);
  assert.equal(result.skippedTables.length, 1);
  assert.deepEqual(result.skippedTables[0]?.rows, [
    ["Metric", "Value"],
    ["ARR", "Summary\nLow\nHigh\nDone"],
  ]);
});

test("syncReviewCommentsFromDocx preserves YAML dataset body around a simple Word cell edit", () => {
  const source = `# Review

::dataset{id="vertical-scores" title="Vertical scores"}
source_note: analyst-maintained source note
schema:
  vertical: string
  score: number
rows:
  - [legal, 18]
  - [finance, 24] # keep row note
::
`;
  const reviewed = parse(`# Review

::dataset{id="vertical-scores" title="Vertical scores"}
schema:
  vertical: string
  score: number
rows:
  - [legal, 18]
  - [finance, 25]
::
`);

  const result = syncReviewCommentsFromDocx(source, renderDocx(reviewed));

  assert.deepEqual(result.changes, [
    { action: "update_dataset", id: "vertical-scores", nativeId: "0" },
  ]);
  assert.match(result.source, /source_note: analyst-maintained source note/);
  assert.match(result.source, /- \[finance, 25\] # keep row note/);
  assert.equal(result.skippedTables.length, 0);
});

test("syncReviewCommentsFromDocx preserves YAML dataset body around a simple Word row insert", () => {
  const source = `# Review

::dataset{id="vertical-scores" title="Vertical scores"}
source_note: analyst-maintained source note
schema:
  vertical: string
  score: number
rows:
  - [legal, 18]
  - [finance, 24] # keep row note
::
`;
  const reviewed = parse(`# Review

::dataset{id="vertical-scores" title="Vertical scores"}
schema:
  vertical: string
  score: number
rows:
  - [legal, 18]
  - [energy, 21]
  - [finance, 24]
::
`);

  const result = syncReviewCommentsFromDocx(source, renderDocx(reviewed));

  assert.deepEqual(result.changes, [
    { action: "update_dataset", id: "vertical-scores", nativeId: "0" },
  ]);
  assert.match(result.source, /source_note: analyst-maintained source note/);
  assert.match(result.source, /  - \[legal, 18\]\n  - \[energy, 21\]\n  - \[finance, 24\] # keep row note/);
  assert.equal(result.skippedTables.length, 0);
});

test("syncReviewCommentsFromDocx preserves YAML dataset body around a simple Word row delete", () => {
  const source = `# Review

::dataset{id="vertical-scores" title="Vertical scores"}
source_note: analyst-maintained source note
schema:
  vertical: string
  score: number
rows:
  - [legal, 18]
  - [finance, 24] # keep row note
::
`;
  const reviewed = parse(`# Review

::dataset{id="vertical-scores" title="Vertical scores"}
schema:
  vertical: string
  score: number
rows:
  - [finance, 24]
::
`);

  const result = syncReviewCommentsFromDocx(source, renderDocx(reviewed));

  assert.deepEqual(result.changes, [
    { action: "update_dataset", id: "vertical-scores", nativeId: "0" },
  ]);
  assert.match(result.source, /source_note: analyst-maintained source note/);
  assert.doesNotMatch(result.source, /\[legal, 18\]/);
  assert.match(result.source, /  - \[finance, 24\] # keep row note/);
  assert.equal(result.skippedTables.length, 0);
});

test("syncReviewCommentsFromDocx preserves YAML dataset body around a simple Word column insert", () => {
  const source = `# Review

::dataset{id="vertical-scores" title="Vertical scores"}
source_note: analyst-maintained source note
schema:
  vertical: string
  score: number
rows:
  - [legal, 18]
  - [finance, 24] # keep row note
::
`;
  const reviewed = parse(`# Review

::dataset{id="vertical-scores" title="Vertical scores"}
schema:
  vertical: string
  owner: string
  score: number
rows:
  - [legal, Research, 18]
  - [finance, Finance, 24]
::
`);

  const result = syncReviewCommentsFromDocx(source, renderDocx(reviewed));

  assert.deepEqual(result.changes, [
    { action: "update_dataset", id: "vertical-scores", nativeId: "0" },
  ]);
  assert.match(result.source, /source_note: analyst-maintained source note/);
  assert.match(result.source, /schema:\n  vertical: string\n  owner: string\n  score: number/);
  assert.match(result.source, /  - \[finance, Finance, 24\] # keep row note/);
  assert.equal(result.skippedTables.length, 0);
});

test("syncReviewCommentsFromDocx preserves YAML dataset body around a simple Word column delete", () => {
  const source = `# Review

::dataset{id="vertical-scores" title="Vertical scores"}
source_note: analyst-maintained source note
schema:
  vertical: string
  owner: string
  score: number
rows:
  - [legal, Research, 18]
  - [finance, Finance, 24] # keep row note
::
`;
  const reviewed = parse(`# Review

::dataset{id="vertical-scores" title="Vertical scores"}
schema:
  vertical: string
  score: number
rows:
  - [legal, 18]
  - [finance, 24]
::
`);

  const result = syncReviewCommentsFromDocx(source, renderDocx(reviewed));

  assert.deepEqual(result.changes, [
    { action: "update_dataset", id: "vertical-scores", nativeId: "0" },
  ]);
  assert.match(result.source, /source_note: analyst-maintained source note/);
  assert.match(result.source, /schema:\n  vertical: string\n  score: number/);
  assert.doesNotMatch(result.source, /owner: string|Research|Finance/);
  assert.match(result.source, /  - \[finance, 24\] # keep row note/);
  assert.equal(result.skippedTables.length, 0);
});

test("syncReviewCommentsFromDocx preserves TSV dataset body around a simple Word cell edit", () => {
  const source = `# Review

::dataset{id="vertical-scores" title="Vertical scores" format="tsv"}
vertical\tscore
legal\t18
finance\t24
::
`;
  const reviewed = parse(`# Review

::dataset{id="vertical-scores" title="Vertical scores" format="tsv"}
vertical\tscore
legal\t18
finance\t25
::
`);

  const result = syncReviewCommentsFromDocx(source, renderDocx(reviewed));

  assert.deepEqual(result.changes, [
    { action: "update_dataset", id: "vertical-scores", nativeId: "0" },
  ]);
  assert.match(result.source, /vertical\tscore\nlegal\t18\nfinance\t25/);
  assert.doesNotMatch(result.source, /schema:|vertical,score/);
  assert.equal(result.skippedTables.length, 0);
});

test("syncReviewCommentsFromDocx preserves TSV dataset body around a simple Word column insert", () => {
  const source = `# Review

::dataset{id="vertical-scores" title="Vertical scores" format="tsv"}
vertical\tscore
legal\t18
finance\t24
::
`;
  const reviewed = parse(`# Review

::dataset{id="vertical-scores" title="Vertical scores" format="tsv"}
vertical\towner\tscore
legal\tResearch\t18
finance\tFinance\t24
::
`);

  const result = syncReviewCommentsFromDocx(source, renderDocx(reviewed));

  assert.deepEqual(result.changes, [
    { action: "update_dataset", id: "vertical-scores", nativeId: "0" },
  ]);
  assert.match(result.source, /vertical\towner\tscore\nlegal\tResearch\t18\nfinance\tFinance\t24/);
  assert.doesNotMatch(result.source, /schema:|vertical,owner,score/);
  assert.equal(result.skippedTables.length, 0);
});

test("syncReviewCommentsFromDocx quotes CSV dataset cells accepted from Word", () => {
  const source = `# Review

::dataset{id="vertical-scores" title="Vertical scores" format="csv"}
vertical,region,score
legal,NA,18
finance,EMEA,24
::
`;
  const reviewed = parse(`# Review

::dataset{id="vertical-scores" title="Vertical scores" format="csv"}
vertical,region,score
legal,NA,18
finance,"North, America",24
::
`);

  const result = syncReviewCommentsFromDocx(source, renderDocx(reviewed));

  assert.deepEqual(result.changes, [
    { action: "update_dataset", id: "vertical-scores", nativeId: "0" },
  ]);
  assert.match(result.source, /vertical,region,score\nlegal,NA,18\nfinance,"North, America",24/);
  assert.equal(result.skippedTables.length, 0);
});

test("syncReviewCommentsFromDocx preserves JSON dataset body around a simple Word cell edit", () => {
  const source = `# Review

::dataset{id="vertical-scores" title="Vertical scores" format="json"}
{
  "source_note": "analyst-maintained source note",
  "columns": ["vertical", "score"],
  "rows": [
    ["legal", 18],
    ["finance", 24]
  ]
}
::
`;
  const reviewed = parse(`# Review

::dataset{id="vertical-scores" title="Vertical scores" format="json"}
{
  "columns": ["vertical", "score"],
  "rows": [
    ["legal", 18],
    ["finance", 25]
  ]
}
::
`);

  const result = syncReviewCommentsFromDocx(source, renderDocx(reviewed));

  assert.deepEqual(result.changes, [
    { action: "update_dataset", id: "vertical-scores", nativeId: "0" },
  ]);
  assert.match(result.source, /"source_note": "analyst-maintained source note"/);
  assert.match(result.source, /\["finance",25\]/);
  assert.equal(result.skippedTables.length, 0);
});

test("syncReviewCommentsFromDocx preserves JSON dataset body around a simple Word row insert", () => {
  const source = `# Review

::dataset{id="vertical-scores" title="Vertical scores" format="json"}
{
  "source_note": "analyst-maintained source note",
  "columns": ["vertical", "score"],
  "rows": [
    ["legal", 18],
    ["finance", 24]
  ]
}
::
`;
  const reviewed = parse(`# Review

::dataset{id="vertical-scores" title="Vertical scores" format="json"}
{
  "columns": ["vertical", "score"],
  "rows": [
    ["legal", 18],
    ["energy", 21],
    ["finance", 24]
  ]
}
::
`);

  const result = syncReviewCommentsFromDocx(source, renderDocx(reviewed));

  assert.deepEqual(result.changes, [
    { action: "update_dataset", id: "vertical-scores", nativeId: "0" },
  ]);
  assert.match(result.source, /"source_note": "analyst-maintained source note"/);
  assert.match(result.source, /\["legal", 18\],\n    \["energy",21\],\n    \["finance", 24\]/);
  assert.equal(result.skippedTables.length, 0);
});

test("syncReviewCommentsFromDocx preserves JSON row-array dataset body around a simple Word column insert", () => {
  const source = `# Review

::dataset{id="vertical-scores" title="Vertical scores" format="json"}
{
  "source_note": "analyst-maintained source note",
  "columns": ["vertical", "score"],
  "rows": [
    ["legal", 18],
    ["finance", 24]
  ]
}
::
`;
  const reviewed = parse(`# Review

::dataset{id="vertical-scores" title="Vertical scores" format="json"}
{
  "columns": ["vertical", "owner", "score"],
  "rows": [
    ["legal", "Research", 18],
    ["finance", "Finance", 24]
  ]
}
::
`);

  const result = syncReviewCommentsFromDocx(source, renderDocx(reviewed));

  assert.deepEqual(result.changes, [
    { action: "update_dataset", id: "vertical-scores", nativeId: "0" },
  ]);
  assert.match(result.source, /"source_note": "analyst-maintained source note"/);
  assert.match(result.source, /"columns": \["vertical","owner","score"\]/);
  assert.match(result.source, /\["legal","Research",18\]/);
  assert.match(result.source, /\["finance","Finance",24\]/);
  assert.equal(result.skippedTables.length, 0);
});

test("syncReviewCommentsFromDocx preserves JSON row-array dataset body around a simple Word column delete", () => {
  const source = `# Review

::dataset{id="vertical-scores" title="Vertical scores" format="json"}
{
  "source_note": "analyst-maintained source note",
  "columns": ["vertical", "owner", "score"],
  "rows": [
    ["legal", "Research", 18],
    ["finance", "Finance", 24]
  ]
}
::
`;
  const reviewed = parse(`# Review

::dataset{id="vertical-scores" title="Vertical scores" format="json"}
{
  "columns": ["vertical", "score"],
  "rows": [
    ["legal", 18],
    ["finance", 24]
  ]
}
::
`);

  const result = syncReviewCommentsFromDocx(source, renderDocx(reviewed));

  assert.deepEqual(result.changes, [
    { action: "update_dataset", id: "vertical-scores", nativeId: "0" },
  ]);
  assert.match(result.source, /"source_note": "analyst-maintained source note"/);
  assert.match(result.source, /"columns": \["vertical","score"\]/);
  assert.match(result.source, /\["finance",24\]/);
  assert.doesNotMatch(result.source, /Research|Finance/);
  assert.equal(result.skippedTables.length, 0);
});

test("syncReviewCommentsFromDocx preserves JSON record-array dataset body around a simple Word row insert", () => {
  const source = `# Review

::dataset{id="vertical-scores" title="Vertical scores" format="json"}
[
  { "vertical": "legal", "score": 18 },
  { "vertical": "finance", "score": 24 }
]
::
`;
  const reviewed = parse(`# Review

::dataset{id="vertical-scores" title="Vertical scores" format="json"}
[
  { "vertical": "legal", "score": 18 },
  { "vertical": "energy", "score": 21 },
  { "vertical": "finance", "score": 24 }
]
::
`);

  const result = syncReviewCommentsFromDocx(source, renderDocx(reviewed));

  assert.deepEqual(result.changes, [
    { action: "update_dataset", id: "vertical-scores", nativeId: "0" },
  ]);
  assert.match(result.source, /\{ "vertical": "legal", "score": 18 \},\n  \{ "vertical": "energy", "score": 21 \},\n  \{ "vertical": "finance", "score": 24 \}/);
  assert.equal(result.skippedTables.length, 0);
});

test("syncReviewCommentsFromDocx preserves JSON record-array dataset body around a simple Word column insert", () => {
  const source = `# Review

::dataset{id="vertical-scores" title="Vertical scores" format="json"}
[
  { "vertical": "legal", "score": 18 },
  { "vertical": "finance", "score": 24 }
]
::
`;
  const reviewed = parse(`# Review

::dataset{id="vertical-scores" title="Vertical scores" format="json"}
[
  { "vertical": "legal", "owner": "Research", "score": 18 },
  { "vertical": "finance", "owner": "Finance", "score": 24 }
]
::
`);

  const result = syncReviewCommentsFromDocx(source, renderDocx(reviewed));

  assert.deepEqual(result.changes, [
    { action: "update_dataset", id: "vertical-scores", nativeId: "0" },
  ]);
  assert.match(result.source, /\{ "vertical": "legal", "owner": "Research", "score": 18 \}/);
  assert.match(result.source, /\{ "vertical": "finance", "owner": "Finance", "score": 24 \}/);
  assert.equal(result.skippedTables.length, 0);
});

test("syncReviewCommentsFromDocx preserves JSON record-array dataset body around a simple Word column delete", () => {
  const source = `# Review

::dataset{id="vertical-scores" title="Vertical scores" format="json"}
[
  { "vertical": "legal", "owner": "Research", "score": 18 },
  { "vertical": "finance", "owner": "Finance", "score": 24 }
]
::
`;
  const reviewed = parse(`# Review

::dataset{id="vertical-scores" title="Vertical scores" format="json"}
[
  { "vertical": "legal", "score": 18 },
  { "vertical": "finance", "score": 24 }
]
::
`);

  const result = syncReviewCommentsFromDocx(source, renderDocx(reviewed));

  assert.deepEqual(result.changes, [
    { action: "update_dataset", id: "vertical-scores", nativeId: "0" },
  ]);
  assert.match(result.source, /\{ "vertical": "legal", "score": 18 \}/);
  assert.match(result.source, /\{ "vertical": "finance", "score": 24 \}/);
  assert.doesNotMatch(result.source, /owner|Research|Finance/);
  assert.equal(result.skippedTables.length, 0);
});

test("syncReviewCommentsFromDocx does not rewrite unchanged dataset tables", () => {
  const source = `# Review

::dataset{id="vertical-scores" title="Vertical scores"}
schema:
  vertical: string
  score: number
rows:
  - [legal, 18]
  - [finance, 24]
::
`;

  const result = syncReviewCommentsFromDocx(source, renderDocx(parse(source)));

  assert.equal(result.source, source);
  assert.deepEqual(result.changes, []);
  assert.equal(result.skippedTables.length, 0);
});

test("syncReviewCommentsFromDocx does not rewrite unchanged alias internal links in dataset cells", () => {
  const source = `# Review

## Details {id="review-details" aliases="details"}

::dataset{id="vertical-scores" title="Vertical scores"}
schema:
  vertical: string
  source: string
rows:
  - [finance, "[*detail note*](#details)"]
::
`;

  const result = syncReviewCommentsFromDocx(source, renderDocx(parse(source)));

  assert.equal(result.source, source);
  assert.deepEqual(result.changes, []);
  assert.equal(result.skippedTables.length, 0);
});

test("syncReviewCommentsFromDocx does not flatten unchanged formatted table cells", () => {
  const source = `# Review

::table{id="metrics" header}
| Metric | Value |
| **ARR** | [10m](https://example.com/arr) |
| _NRR_ | 120% |
::
`;

  const result = syncReviewCommentsFromDocx(source, renderDocx(parse(source)));

  assert.equal(result.source, source);
  assert.deepEqual(result.changes, []);
});

function docxBookmarkName(source: string, prefix: string): string {
  const entries = Object.fromEntries(
    [...readDocxZipEntries(renderDocx(parse(source)))].map(([name, data]) => [name, data.toString("utf8")]),
  );
  const documentXml = entries["word/document.xml"];
  assert.ok(documentXml);
  const match = new RegExp(`w:name="(${escapeRegExp(prefix)}[^"]+)"`).exec(documentXml);
  assert.ok(match?.[1]);
  return match[1];
}

function sourceBookmarkName(id: string): string {
  const hash = crc32(Buffer.from(id, "utf8")).toString(16).padStart(8, "0");
  const clean = id.replace(/[^A-Za-z0-9_]/g, "_").replace(/^[^A-Za-z]+/, "");
  const stem = (clean || "id").slice(0, 28);
  return `n_${stem}_${hash}`.slice(0, 40);
}

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function docxWithIsolatedMetadataValueSeparators(buffer: Buffer): Buffer {
  const entries = Object.fromEntries(
    [...readDocxZipEntries(buffer)].map(([name, data]) => [name, data.toString("utf8")]),
  );
  const documentXml = entries["word/document.xml"];
  assert.ok(documentXml);
  assert.match(documentXml, /CRM · status: stale/);
  assert.match(documentXml, /owner: Ops · Q1: Finance/);
  entries["word/document.xml"] = documentXml
    .replace(
      "CRM · status: stale",
      `CRM</w:t></w:r><w:r><w:t xml:space="preserve"> · </w:t></w:r><w:r><w:t xml:space="preserve">status: stale`,
    )
    .replace(
      "owner: Ops · Q1: Finance",
      `owner: Ops</w:t></w:r><w:r><w:t xml:space="preserve"> · </w:t></w:r><w:r><w:t xml:space="preserve">Q1: Finance`,
    );
  return storedDocx(entries);
}

function docxWithHeadingEdit(buffer: Buffer): Buffer {
  const entries = Object.fromEntries(
    [...readDocxZipEntries(buffer)].map(([name, data]) => [name, data.toString("utf8")]),
  );
  const documentXml = entries["word/document.xml"];
  assert.ok(documentXml);
  const targetRun = /<w:r>(?:<w:rPr><w:b\/><\/w:rPr>)?<w:t(?: xml:space="preserve")?>Original section<\/w:t><\/w:r>/;
  assert.ok(targetRun.test(documentXml));
  entries["word/document.xml"] = documentXml.replace(
    targetRun,
    `<w:r><w:t>Edited section</w:t></w:r>`,
  );
  return storedDocx(entries);
}

function docxWithoutBookmarks(buffer: Buffer, namePrefixes: string[]): Buffer {
  const entries = Object.fromEntries(
    [...readDocxZipEntries(buffer)].map(([name, data]) => [name, data.toString("utf8")]),
  );
  let documentXml = entries["word/document.xml"];
  assert.ok(documentXml);
  for (const prefix of namePrefixes) {
    documentXml = stripBookmarksByNamePrefix(documentXml, prefix);
  }
  entries["word/document.xml"] = documentXml;
  return storedDocx(entries);
}

function stripBookmarksByNamePrefix(xml: string, prefix: string): string {
  let out = xml;
  const startRe = new RegExp(`<w:bookmarkStart w:id="(\\d+)" w:name="${escapeRegExp(prefix)}[^"]*"\\/>`, "g");
  for (const match of [...out.matchAll(startRe)]) {
    const id = match[1];
    if (!id) continue;
    out = out
      .replace(match[0], "")
      .replace(new RegExp(`<w:bookmarkEnd w:id="${escapeRegExp(id)}"\\/>`, "g"), "");
  }
  return out;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function docxWithTrackedHeadingRevision(buffer: Buffer): Buffer {
  const entries = Object.fromEntries(
    [...readDocxZipEntries(buffer)].map(([name, data]) => [name, data.toString("utf8")]),
  );
  const documentXml = entries["word/document.xml"];
  assert.ok(documentXml);
  const targetRun = /<w:r>(?:<w:rPr><w:b\/><\/w:rPr>)?<w:t(?: xml:space="preserve")?>Original section<\/w:t><\/w:r>/;
  assert.ok(targetRun.test(documentXml));
  entries["word/document.xml"] = documentXml.replace(
    targetRun,
    `<w:del w:id="7" w:author="Research" w:date="2026-05-25T09:00:00Z"><w:r><w:delText>Original section</w:delText></w:r></w:del><w:ins w:id="8" w:author="Research" w:date="2026-05-25T09:00:00Z"><w:r><w:t>Edited section</w:t></w:r></w:ins>`,
  );
  return storedDocx(entries);
}

function docxWithTrackedHeadingMove(buffer: Buffer): Buffer {
  const entries = Object.fromEntries(
    [...readDocxZipEntries(buffer)].map(([name, data]) => [name, data.toString("utf8")]),
  );
  const documentXml = entries["word/document.xml"];
  assert.ok(documentXml);
  const targetRun = /<w:r>(?:<w:rPr><w:b\/><\/w:rPr>)?<w:t(?: xml:space="preserve")?>Original section<\/w:t><\/w:r>/;
  assert.ok(targetRun.test(documentXml));
  entries["word/document.xml"] = documentXml.replace(
    targetRun,
    `<w:moveFrom w:id="17" w:author="Research" w:date="2026-05-25T09:00:00Z"><w:r><w:t>Original section</w:t></w:r></w:moveFrom><w:moveTo w:id="18" w:author="Research" w:date="2026-05-25T09:00:00Z"><w:r><w:t>Moved section</w:t></w:r></w:moveTo>`,
  );
  return storedDocx(entries);
}

function docxWithTrackedHeadingRangeMove(buffer: Buffer): Buffer {
  const entries = Object.fromEntries(
    [...readDocxZipEntries(buffer)].map(([name, data]) => [name, data.toString("utf8")]),
  );
  const documentXml = entries["word/document.xml"];
  assert.ok(documentXml);
  const targetRun = /<w:r>(?:<w:rPr><w:b\/><\/w:rPr>)?<w:t(?: xml:space="preserve")?>Original section<\/w:t><\/w:r>/;
  assert.ok(targetRun.test(documentXml));
  entries["word/document.xml"] = documentXml.replace(
    targetRun,
    `<w:moveFromRangeStart w:id="27" w:author="Research" w:date="2026-05-25T09:00:00Z"/><w:r><w:t>Original section</w:t></w:r><w:moveFromRangeEnd w:id="27"/><w:moveToRangeStart w:id="28" w:author="Research" w:date="2026-05-25T09:00:00Z"/><w:r><w:t>Moved section</w:t></w:r><w:moveToRangeEnd w:id="28"/>`,
  );
  return storedDocx(entries);
}

function docxWithNativeResolvedComment(buffer: Buffer): Buffer {
  const entries = Object.fromEntries(
    [...readDocxZipEntries(buffer)].map(([name, data]) => [name, data.toString("utf8")]),
  );
  const commentsExtended = entries["word/commentsExtended.xml"];
  assert.ok(commentsExtended);
  assert.match(commentsExtended, /w15:done="0"/);
  entries["word/commentsExtended.xml"] = commentsExtended.replace(/w15:done="0"/, `w15:done="1"`);
  return storedDocx(entries);
}

function docxWithNativeUnresolvedComment(buffer: Buffer): Buffer {
  const entries = Object.fromEntries(
    [...readDocxZipEntries(buffer)].map(([name, data]) => [name, data.toString("utf8")]),
  );
  const commentsExtended = entries["word/commentsExtended.xml"];
  assert.ok(commentsExtended);
  assert.match(commentsExtended, /w15:done="1"/);
  entries["word/commentsExtended.xml"] = commentsExtended.replace(/w15:done="1"/, `w15:done="0"`);
  return storedDocx(entries);
}

function docxWithNativeDoneOmitted(buffer: Buffer): Buffer {
  const entries = Object.fromEntries(
    [...readDocxZipEntries(buffer)].map(([name, data]) => [name, data.toString("utf8")]),
  );
  const commentsExtended = entries["word/commentsExtended.xml"];
  assert.ok(commentsExtended);
  assert.match(commentsExtended, / w15:done="1"/);
  entries["word/commentsExtended.xml"] = commentsExtended.replace(/ w15:done="1"/, "");
  return storedDocx(entries);
}

function docxWithCommentRelationshipTarget(buffer: Buffer, target: string): Buffer {
  const entries = Object.fromEntries(
    [...readDocxZipEntries(buffer)].map(([name, data]) => [name, data.toString("utf8")]),
  );
  const rels = entries["word/_rels/comments.xml.rels"];
  assert.ok(rels);
  assert.match(rels, /Target="https:\/\/example\.com\/review"/);
  entries["word/_rels/comments.xml.rels"] = rels.replace(
    /Target="https:\/\/example\.com\/review"/,
    `Target="${target}"`,
  );
  return storedDocx(entries);
}

function docxWithCommentHyperlinkField(buffer: Buffer): Buffer {
  const entries = Object.fromEntries(
    [...readDocxZipEntries(buffer)].map(([name, data]) => [name, data.toString("utf8")]),
  );
  const commentsXml = entries["word/comments.xml"];
  const rels = entries["word/_rels/comments.xml.rels"];
  assert.ok(commentsXml);
  assert.ok(rels);
  const relationship = /<Relationship Id="(rId\d+)"[^>]*Target="([^"]+)"[^>]*\/>/.exec(rels);
  assert.ok(relationship);
  const target = relationship[2];
  assert.ok(target);
  const hyperlinkRe = new RegExp(`<w:hyperlink r:id="${relationship[1]}" w:history="1">([\\s\\S]*?)</w:hyperlink>`);
  assert.match(commentsXml, hyperlinkRe);
  entries["word/comments.xml"] = commentsXml.replace(
    hyperlinkRe,
    (_match, body) => `<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> HYPERLINK "${target}" </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r>${body}<w:r><w:fldChar w:fldCharType="end"/></w:r>`,
  );
  return storedDocx(entries);
}

function docxWithLayoutChildReview(buffer: Buffer): Buffer {
  const entries = Object.fromEntries(
    [...readDocxZipEntries(buffer)].map(([name, data]) => [name, data.toString("utf8")]),
  );
  const documentXml = entries["word/document.xml"];
  assert.ok(documentXml);
  const firstRun = /<w:r><w:t(?: xml:space="preserve")?>First paragraph\.<\/w:t><\/w:r>/;
  const secondRun = /<w:r><w:t(?: xml:space="preserve")?>Second paragraph\.<\/w:t><\/w:r>/;
  assert.ok(firstRun.test(documentXml));
  assert.ok(secondRun.test(documentXml));
  entries["word/document.xml"] = documentXml
    .replace(
      firstRun,
      `<w:del w:id="80" w:author="Reviewer" w:date="2026-05-25T09:00:00Z"><w:r><w:delText>First paragraph.</w:delText></w:r></w:del><w:ins w:id="81" w:author="Reviewer" w:date="2026-05-25T09:00:00Z"><w:r><w:t>First paragraph updated.</w:t></w:r></w:ins>`,
    )
    .replace(
      secondRun,
      (run) => `<w:commentRangeStart w:id="72"/>${run}<w:commentRangeEnd w:id="72"/><w:r><w:commentReference w:id="72"/></w:r>`,
    );
  entries["word/comments.xml"] = `<w:comments xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:comment w:id="72" w:author="Reviewer" w:initials="R"><w:p><w:r><w:t>Review the card paragraph.</w:t></w:r></w:p></w:comment>
</w:comments>`;
  return storedDocx(entries);
}

function docxWithLooseLayoutCellReview(buffer: Buffer): Buffer {
  const entries = Object.fromEntries(
    [...readDocxZipEntries(buffer)].map(([name, data]) => [name, data.toString("utf8")]),
  );
  const documentXml = entries["word/document.xml"];
  assert.ok(documentXml);
  const looseRun = /<w:r><w:t(?: xml:space="preserve")?>Loose second cell\.<\/w:t><\/w:r>/;
  assert.ok(looseRun.test(documentXml));
  entries["word/document.xml"] = documentXml.replace(
    looseRun,
    `<w:commentRangeStart w:id="73"/><w:del w:id="82" w:author="Reviewer" w:date="2026-05-25T09:00:00Z"><w:r><w:delText>Loose second cell.</w:delText></w:r></w:del><w:ins w:id="83" w:author="Reviewer" w:date="2026-05-25T09:00:00Z"><w:r><w:t>Loose second cell updated.</w:t></w:r></w:ins><w:commentRangeEnd w:id="73"/><w:r><w:commentReference w:id="73"/></w:r>`,
  );
  entries["word/comments.xml"] = `<w:comments xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:comment w:id="73" w:author="Reviewer" w:initials="R"><w:p><w:r><w:t>Review the loose layout cell.</w:t></w:r></w:p></w:comment>
</w:comments>`;
  return storedDocx(entries);
}

function docxWithHeaderCommentAndFooterRevision(buffer: Buffer): Buffer {
  const entries = Object.fromEntries(
    [...readDocxZipEntries(buffer)].map(([name, data]) => [name, data.toString("utf8")]),
  );
  const headerXml = entries["word/header1.xml"];
  const footerXml = entries["word/footer1.xml"];
  assert.ok(headerXml);
  assert.ok(footerXml);
  const headerRun = /<w:r><w:t(?: xml:space="preserve")?>Header claim\.<\/w:t><\/w:r>/;
  const footerRun = /<w:r><w:t(?: xml:space="preserve")?>Footer claim\.<\/w:t><\/w:r>/;
  assert.ok(headerRun.test(headerXml));
  assert.ok(footerRun.test(footerXml));
  entries["word/header1.xml"] = headerXml.replace(
    headerRun,
    (run) => `<w:commentRangeStart w:id="42"/>${run}<w:commentRangeEnd w:id="42"/><w:r><w:commentReference w:id="42"/></w:r>`,
  );
  entries["word/footer1.xml"] = footerXml.replace(
    footerRun,
    `<w:del w:id="50" w:author="Reviewer" w:date="2026-05-25T09:00:00Z"><w:r><w:delText>Footer claim.</w:delText></w:r></w:del><w:ins w:id="51" w:author="Reviewer" w:date="2026-05-25T09:00:00Z"><w:r><w:t>Footer claim updated.</w:t></w:r></w:ins>`,
  );
  entries["word/comments.xml"] = `<w:comments xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:comment w:id="42" w:author="Reviewer" w:initials="R"><w:p><w:r><w:t>Check the running header.</w:t></w:r></w:p></w:comment>
</w:comments>`;
  return storedDocx(entries);
}

function docxWithSimpleCaptionRefField(buffer: Buffer): Buffer {
  const entries = Object.fromEntries(
    [...readDocxZipEntries(buffer)].map(([name, data]) => [name, data.toString("utf8")]),
  );
  const documentXml = entries["word/document.xml"];
  assert.ok(documentXml);
  const bookmark = /<w:bookmarkStart\b[^>]*\bw:name="(n_metrics_[^"]+)"/.exec(documentXml)?.[1];
  assert.ok(bookmark);
  const refField = new RegExp(`<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> REF ${escapeRegExp(bookmark)} \\\\h </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r>[\\s\\S]*?<w:r><w:fldChar w:fldCharType="end"/></w:r>`);
  assert.match(documentXml, refField);
  entries["word/document.xml"] = documentXml.replace(
    refField,
    `<w:fldSimple w:instr=" REF ${bookmark} \\h "><w:r><w:rPr><w:b/></w:rPr><w:t>Table</w:t></w:r></w:fldSimple>`,
  );
  return storedDocx(entries);
}

function docxWithRichTrackedRevision(buffer: Buffer): Buffer {
  const entries = Object.fromEntries(
    [...readDocxZipEntries(buffer)].map(([name, data]) => [name, data.toString("utf8")]),
  );
  const documentXml = entries["word/document.xml"];
  assert.ok(documentXml);
  const targetRun = /<w:r><w:t(?: xml:space="preserve")?>Claim\.<\/w:t><\/w:r>/;
  assert.ok(targetRun.test(documentXml));
  entries["word/document.xml"] = documentXml.replace(
    targetRun,
    `<w:del w:id="70" w:author="Reviewer" w:date="2026-05-25T09:00:00Z"><w:r><w:delText>Old </w:delText></w:r><w:r><w:rPr><w:b/></w:rPr><w:delText>claim</w:delText></w:r><w:r><w:delText> </w:delText></w:r><w:hyperlink r:id="rIdRich"><w:r><w:delText>source</w:delText></w:r></w:hyperlink><w:r><w:delText>.</w:delText></w:r></w:del><w:ins w:id="71" w:author="Reviewer" w:date="2026-05-25T09:00:00Z"><w:r><w:t>New </w:t></w:r><w:r><w:rPr><w:i/></w:rPr><w:t>claim</w:t></w:r><w:r><w:t> </w:t></w:r><w:r><w:rPr><w:rFonts w:ascii="Courier New"/></w:rPr><w:t>model</w:t></w:r><w:r><w:t> and </w:t></w:r><w:hyperlink w:anchor="n_c1_placeholder"><w:r><w:t>c1</w:t></w:r></w:hyperlink><w:r><w:t>.</w:t></w:r></w:ins>`,
  );
  const c1Bookmark = /<w:bookmarkStart\b[^>]*\bw:name="(n_c1_[^"]+)"/.exec(documentXml)?.[1];
  assert.ok(c1Bookmark);
  entries["word/document.xml"] = entries["word/document.xml"]!.replace(/n_c1_placeholder/g, c1Bookmark);
  entries["word/_rels/document.xml.rels"] = addDocumentRelationship(
    entries["word/_rels/document.xml.rels"],
    "rIdRich",
    "https://example.com/old",
  );
  return storedDocx(entries);
}

function docxWithFormattedHyperlinkRevision(buffer: Buffer): Buffer {
  const entries = Object.fromEntries(
    [...readDocxZipEntries(buffer)].map(([name, data]) => [name, data.toString("utf8")]),
  );
  const documentXml = entries["word/document.xml"];
  assert.ok(documentXml);
  const targetRun = /<w:r><w:t(?: xml:space="preserve")?>Claim\.<\/w:t><\/w:r>/;
  assert.ok(targetRun.test(documentXml));
  entries["word/document.xml"] = documentXml.replace(
    targetRun,
    `<w:del w:id="70" w:author="Reviewer" w:date="2026-05-25T09:00:00Z"><w:r><w:delText>Old </w:delText></w:r><w:hyperlink r:id="rIdOld"><w:r><w:rPr><w:b/></w:rPr><w:delText>source</w:delText></w:r><w:r><w:rPr><w:b/></w:rPr><w:delText> note</w:delText></w:r></w:hyperlink><w:r><w:delText>.</w:delText></w:r></w:del><w:ins w:id="71" w:author="Reviewer" w:date="2026-05-25T09:00:00Z"><w:r><w:t>New </w:t></w:r><w:hyperlink r:id="rIdNew"><w:r><w:rPr><w:i/></w:rPr><w:t>source</w:t></w:r><w:r><w:rPr><w:i/></w:rPr><w:t> note</w:t></w:r></w:hyperlink><w:r><w:t>.</w:t></w:r></w:ins>`,
  );
  entries["word/_rels/document.xml.rels"] = addDocumentRelationship(
    addDocumentRelationship(entries["word/_rels/document.xml.rels"], "rIdOld", "https://example.com/old"),
    "rIdNew",
    "https://example.com/new",
  );
  return storedDocx(entries);
}

function docxWithSplitTrackedRevision(buffer: Buffer): Buffer {
  const entries = Object.fromEntries(
    [...readDocxZipEntries(buffer)].map(([name, data]) => [name, data.toString("utf8")]),
  );
  const documentXml = entries["word/document.xml"];
  assert.ok(documentXml);
  const targetRun = /<w:r><w:t(?: xml:space="preserve")?>Claim\.<\/w:t><\/w:r>/;
  assert.ok(targetRun.test(documentXml));
  entries["word/document.xml"] = documentXml.replace(
    targetRun,
    `<w:del w:id="70" w:author="Reviewer" w:date="2026-05-25T09:00:00Z"><w:r><w:delText>Old </w:delText></w:r></w:del><w:del w:id="70" w:author="Reviewer" w:date="2026-05-25T09:00:00Z"><w:r><w:rPr><w:b/></w:rPr><w:delText>claim</w:delText></w:r></w:del><w:ins w:id="71" w:author="Reviewer" w:date="2026-05-25T09:00:00Z"><w:r><w:t>New </w:t></w:r></w:ins><w:ins w:id="71" w:author="Reviewer" w:date="2026-05-25T09:00:00Z"><w:r><w:rPr><w:i/></w:rPr><w:t>claim</w:t></w:r></w:ins>`,
  );
  return storedDocx(entries);
}

function docxWithSplitStyledTrackedRevision(buffer: Buffer): Buffer {
  const entries = Object.fromEntries(
    [...readDocxZipEntries(buffer)].map(([name, data]) => [name, data.toString("utf8")]),
  );
  const documentXml = entries["word/document.xml"];
  assert.ok(documentXml);
  const targetRun = /<w:r><w:t(?: xml:space="preserve")?>Claim\.<\/w:t><\/w:r>/;
  assert.ok(targetRun.test(documentXml));
  entries["word/document.xml"] = documentXml.replace(
    targetRun,
    `<w:del w:id="70" w:author="Reviewer" w:date="2026-05-25T09:00:00Z"><w:r><w:delText>Old </w:delText></w:r><w:r><w:rPr><w:b/></w:rPr><w:delText>Bo</w:delText></w:r><w:r><w:rPr><w:b/></w:rPr><w:delText>ld</w:delText></w:r></w:del><w:ins w:id="71" w:author="Reviewer" w:date="2026-05-25T09:00:00Z"><w:r><w:t>New </w:t></w:r><w:r><w:rPr><w:i/></w:rPr><w:t>em</w:t></w:r><w:r><w:rPr><w:i/></w:rPr><w:t>phasis</w:t></w:r></w:ins>`,
  );
  return storedDocx(entries);
}

function docxWithMultipleTrackedReplacements(buffer: Buffer): Buffer {
  const entries = Object.fromEntries(
    [...readDocxZipEntries(buffer)].map(([name, data]) => [name, data.toString("utf8")]),
  );
  const documentXml = entries["word/document.xml"];
  assert.ok(documentXml);
  const targetRun = /<w:r><w:t(?: xml:space="preserve")?>Claim\.<\/w:t><\/w:r>/;
  assert.ok(targetRun.test(documentXml));
  entries["word/document.xml"] = documentXml.replace(
    targetRun,
    `<w:del w:id="70" w:author="Reviewer" w:date="2026-05-25T09:00:00Z"><w:r><w:delText>old first</w:delText></w:r></w:del><w:ins w:id="71" w:author="Reviewer" w:date="2026-05-25T09:00:00Z"><w:r><w:t>new first</w:t></w:r></w:ins><w:r><w:t> and </w:t></w:r><w:del w:id="72" w:author="Reviewer" w:date="2026-05-25T09:01:00Z"><w:r><w:delText>old second</w:delText></w:r></w:del><w:ins w:id="73" w:author="Reviewer" w:date="2026-05-25T09:01:00Z"><w:r><w:t>new second</w:t></w:r></w:ins>`,
  );
  return storedDocx(entries);
}

function docxWithTrackedMoveRevision(buffer: Buffer): Buffer {
  const entries = Object.fromEntries(
    [...readDocxZipEntries(buffer)].map(([name, data]) => [name, data.toString("utf8")]),
  );
  const documentXml = entries["word/document.xml"];
  assert.ok(documentXml);
  const targetRun = /<w:r><w:t(?: xml:space="preserve")?>Claim\.<\/w:t><\/w:r>/;
  assert.ok(targetRun.test(documentXml));
  entries["word/document.xml"] = documentXml.replace(
    targetRun,
    `<w:moveFrom w:id="80" w:author="Reviewer" w:date="2026-05-25T09:00:00Z"><w:r><w:t>Original wording</w:t></w:r></w:moveFrom><w:moveTo w:id="81" w:author="Reviewer" w:date="2026-05-25T09:00:00Z"><w:r><w:t>Moved wording</w:t></w:r></w:moveTo>`,
  );
  return storedDocx(entries);
}

function docxWithTrackedRangeMoveRevision(buffer: Buffer): Buffer {
  const entries = Object.fromEntries(
    [...readDocxZipEntries(buffer)].map(([name, data]) => [name, data.toString("utf8")]),
  );
  const documentXml = entries["word/document.xml"];
  assert.ok(documentXml);
  const targetRun = /<w:r><w:t(?: xml:space="preserve")?>Claim\.<\/w:t><\/w:r>/;
  assert.ok(targetRun.test(documentXml));
  entries["word/document.xml"] = documentXml.replace(
    targetRun,
    `<w:moveFromRangeStart w:id="82" w:author="Reviewer" w:date="2026-05-25T09:00:00Z"/><w:r><w:t>Original wording</w:t></w:r><w:moveFromRangeEnd w:id="82"/><w:moveToRangeStart w:id="83" w:author="Reviewer" w:date="2026-05-25T09:00:00Z"/><w:r><w:t>Moved wording</w:t></w:r><w:moveToRangeEnd w:id="83"/>`,
  );
  return storedDocx(entries);
}

function docxWithTrackedNoteBody(buffer: Buffer): Buffer {
  const entries = Object.fromEntries(
    [...readDocxZipEntries(buffer)].map(([name, data]) => [name, data.toString("utf8")]),
  );
  const footnotesXml = entries["word/footnotes.xml"];
  const endnotesXml = entries["word/endnotes.xml"];
  assert.ok(footnotesXml);
  assert.ok(endnotesXml);
  const footnoteRun = /<w:r><w:t(?: xml:space="preserve")?>Original footnote\.<\/w:t><\/w:r>/;
  const endnoteRun = /<w:r><w:t(?: xml:space="preserve")?>Original endnote\.<\/w:t><\/w:r>/;
  assert.ok(footnoteRun.test(footnotesXml));
  assert.ok(endnoteRun.test(endnotesXml));
  entries["word/footnotes.xml"] = footnotesXml.replace(
    footnoteRun,
    `<w:del w:id="61" w:author="Reviewer" w:date="2026-05-25T09:00:00Z"><w:r><w:delText>Original footnote.</w:delText></w:r></w:del><w:ins w:id="62" w:author="Reviewer" w:date="2026-05-25T09:00:00Z"><w:r><w:t>Edited footnote.</w:t></w:r></w:ins>`,
  );
  entries["word/endnotes.xml"] = endnotesXml.replace(
    endnoteRun,
    `<w:del w:id="63" w:author="Reviewer" w:date="2026-05-25T09:00:00Z"><w:r><w:delText>Original endnote.</w:delText></w:r></w:del><w:ins w:id="64" w:author="Reviewer" w:date="2026-05-25T09:00:00Z"><w:r><w:t>Edited endnote.</w:t></w:r></w:ins>`,
  );
  return storedDocx(entries);
}

function addDocumentRelationship(xml: string | undefined, id: string, target: string): string {
  const rel = `  <Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="${target}" TargetMode="External"/>\n`;
  const source = xml ?? `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">\n</Relationships>`;
  return source.includes(`Id="${id}"`) ? source : source.replace("</Relationships>", `${rel}</Relationships>`);
}

function docxWithTableCellComment(buffer: Buffer): Buffer {
  const entries = Object.fromEntries(
    [...readDocxZipEntries(buffer)].map(([name, data]) => [name, data.toString("utf8")]),
  );
  const documentXml = entries["word/document.xml"];
  assert.ok(documentXml);
  const targetRun = /<w:r><w:t(?: xml:space="preserve")?>10m<\/w:t><\/w:r>/;
  assert.ok(targetRun.test(documentXml));
  entries["word/document.xml"] = documentXml.replace(
    targetRun,
    (run) => `<w:commentRangeStart w:id="42"/>${run}<w:commentRangeEnd w:id="42"/><w:r><w:commentReference w:id="42"/></w:r>`,
  );
  entries["word/comments.xml"] = `<w:comments xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:comment w:id="42" w:author="Reviewer" w:initials="R"><w:p><w:r><w:t>Check the ARR value.</w:t></w:r></w:p></w:comment>
</w:comments>`;
  return storedDocx(entries);
}

function docxWithTableCellPointComment(buffer: Buffer): Buffer {
  const entries = Object.fromEntries(
    [...readDocxZipEntries(buffer)].map(([name, data]) => [name, data.toString("utf8")]),
  );
  const documentXml = entries["word/document.xml"];
  assert.ok(documentXml);
  const targetRun = /<w:r><w:t(?: xml:space="preserve")?>10m<\/w:t><\/w:r>/;
  assert.ok(targetRun.test(documentXml));
  entries["word/document.xml"] = documentXml.replace(
    targetRun,
    (run) => `${run}<w:r><w:commentReference w:id="42"/></w:r>`,
  );
  entries["word/comments.xml"] = `<w:comments xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:comment w:id="42" w:author="Reviewer" w:initials="R"><w:p><w:r><w:t>Check the ARR value.</w:t></w:r></w:p></w:comment>
</w:comments>`;
  return storedDocx(entries);
}

function docxWithAcceptedTableCellEdit(buffer: Buffer): Buffer {
  const entries = Object.fromEntries(
    [...readDocxZipEntries(buffer)].map(([name, data]) => [name, data.toString("utf8")]),
  );
  const documentXml = entries["word/document.xml"];
  assert.ok(documentXml);
  const targetRun = /<w:r><w:t(?: xml:space="preserve")?>10m<\/w:t><\/w:r>/;
  assert.ok(targetRun.test(documentXml));
  entries["word/document.xml"] = documentXml.replace(
    targetRun,
    `<w:r><w:t>11m</w:t></w:r>`,
  );
  return storedDocx(entries);
}

function docxWithNestedNativeTableCell(buffer: Buffer): Buffer {
  const entries = Object.fromEntries(
    [...readDocxZipEntries(buffer)].map(([name, data]) => [name, data.toString("utf8")]),
  );
  const documentXml = entries["word/document.xml"];
  assert.ok(documentXml);
  const targetRun = /<w:r><w:t(?: xml:space="preserve")?>10m<\/w:t><\/w:r>/;
  assert.ok(targetRun.test(documentXml));
  entries["word/document.xml"] = documentXml.replace(
    targetRun,
    `<w:r><w:t>Summary</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>Low</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>High</w:t></w:r></w:p></w:tc></w:tr></w:tbl><w:p><w:r><w:t>Done</w:t></w:r>`,
  );
  return storedDocx(entries);
}

function docxWithRestyledAcceptedTableCellEdit(buffer: Buffer): Buffer {
  const entries = Object.fromEntries(
    [...readDocxZipEntries(buffer)].map(([name, data]) => [name, data.toString("utf8")]),
  );
  const documentXml = entries["word/document.xml"];
  assert.ok(documentXml);
  const targetRun = /<w:r><w:t(?: xml:space="preserve")?>10m<\/w:t><\/w:r>/;
  assert.ok(targetRun.test(documentXml));
  entries["word/document.xml"] = documentXml
    .replace(/<w:tblStyle w:val="TableGrid"\/>/, `<w:tblStyle w:val="LightShading"/>`)
    .replace(targetRun, `<w:r><w:t>11m</w:t></w:r>`);
  return storedDocx(entries);
}

function docxWithTableCellNotes(buffer: Buffer): Buffer {
  const entries = Object.fromEntries(
    [...readDocxZipEntries(buffer)].map(([name, data]) => [name, data.toString("utf8")]),
  );
  const documentXml = entries["word/document.xml"];
  assert.ok(documentXml);
  const targetRun = /<w:r><w:t(?: xml:space="preserve")?>10m<\/w:t><\/w:r>/;
  assert.ok(targetRun.test(documentXml));
  entries["word/document.xml"] = documentXml.replace(
    targetRun,
    (run) => `${run}<w:r><w:footnoteReference w:id="9"/></w:r><w:r><w:endnoteReference w:id="10"/></w:r>`,
  );
  entries["word/footnotes.xml"] = `<w:footnotes xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:footnote w:id="9"><w:p><w:r><w:t>Footnote on the ARR value.</w:t></w:r></w:p></w:footnote>
</w:footnotes>`;
  entries["word/endnotes.xml"] = `<w:endnotes xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:endnote w:id="10"><w:p><w:r><w:t>Endnote on the ARR value.</w:t></w:r></w:p></w:endnote>
</w:endnotes>`;
  return storedDocx(entries);
}

function docxWithTableCellRevision(buffer: Buffer): Buffer {
  const entries = Object.fromEntries(
    [...readDocxZipEntries(buffer)].map(([name, data]) => [name, data.toString("utf8")]),
  );
  const documentXml = entries["word/document.xml"];
  assert.ok(documentXml);
  const targetRun = /<w:r><w:t(?: xml:space="preserve")?>10m<\/w:t><\/w:r>/;
  assert.ok(targetRun.test(documentXml));
  entries["word/document.xml"] = documentXml.replace(
    targetRun,
    `<w:del w:id="21" w:author="Reviewer" w:date="2026-05-25T09:00:00Z"><w:r><w:delText>10m</w:delText></w:r></w:del><w:ins w:id="22" w:author="Reviewer" w:date="2026-05-25T09:00:00Z"><w:r><w:t>11m</w:t></w:r></w:ins>`,
  );
  return storedDocx(entries);
}

function docxWithNestedLayoutTableCellReview(buffer: Buffer): Buffer {
  const entries = Object.fromEntries(
    [...readDocxZipEntries(buffer)].map(([name, data]) => [name, data.toString("utf8")]),
  );
  const documentXml = entries["word/document.xml"];
  assert.ok(documentXml);
  const targetRun = /<w:r><w:t(?: xml:space="preserve")?>10m<\/w:t><\/w:r>/;
  assert.ok(targetRun.test(documentXml));
  entries["word/document.xml"] = documentXml.replace(
    targetRun,
    `<w:commentRangeStart w:id="74"/><w:del w:id="84" w:author="Reviewer" w:date="2026-05-25T09:00:00Z"><w:r><w:delText>10m</w:delText></w:r></w:del><w:ins w:id="85" w:author="Reviewer" w:date="2026-05-25T09:00:00Z"><w:r><w:t>11m</w:t></w:r></w:ins><w:commentRangeEnd w:id="74"/><w:r><w:commentReference w:id="74"/></w:r>`,
  );
  entries["word/comments.xml"] = `<w:comments xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:comment w:id="74" w:author="Reviewer" w:initials="R"><w:p><w:r><w:t>Review the nested table value.</w:t></w:r></w:p></w:comment>
</w:comments>`;
  return storedDocx(entries);
}
