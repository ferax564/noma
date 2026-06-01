import { test } from "node:test";
import assert from "node:assert/strict";
import { readDocxZipEntries } from "../src/docx-control-data.js";
import { parse } from "../src/parser.js";
import { renderDocx } from "../src/renderer-docx.js";
import { extractDocxReviewData } from "../src/docx-review-data.js";
import { storedDocx } from "./docx-test-zip.js";

test("extractDocxReviewData reads native Word comments and replies", () => {
  const doc = parse(`# Review

::claim{id="c1" confidence=0.8}
Claim.
::

::comment{id="comment-parent" parent="c1" author="Andrea" date="2026-05-24T09:00:00Z"}
Check **bold**, *emphasis*, \`code\`, [source](https://example.com), and [[c1]].
::

::comment{id="comment-reply" reply_to="comment-parent" author="Research" date="2026-05-24T09:30:00Z" status="resolved" resolved_by="Andrea" resolved_at="2026-05-24T10:00:00Z"}
Confirmed with latest source.
::
`);

  const data = extractDocxReviewData(renderDocx(doc));

  assert.equal(data.comments.length, 2);
  assert.equal(data.revisions.length, 0);
  assert.equal(data.footnotes.length, 0);
  assert.equal(data.endnotes.length, 0);
  assert.equal(data.tables.length, 0);
  assert.equal(data.comments[0]?.nativeId, "0");
  assert.equal(data.comments[0]?.author, "Andrea");
  assert.equal(data.comments[0]?.initials, "A");
  assert.equal(data.comments[0]?.date, "2026-05-24T09:00:00Z");
  assert.equal(data.comments[0]?.body, "Check **bold**, *emphasis*, `code`, [source](https://example.com), and [[c1]].");
  assert.equal(data.comments[0]?.anchorBookmarkNames?.length, 2);
  assert.match(data.comments[0]?.anchorBookmarkNames?.[0] ?? "", /^n_c1_/);
  assert.match(data.comments[0]?.anchorBookmarkNames?.[1] ?? "", /^n_comment_parent_/);

  assert.deepEqual(data.comments[1], {
    nativeId: "1",
    author: "Research",
    initials: "R",
    date: "2026-05-24T09:30:00Z",
    status: "resolved",
    resolvedBy: "Andrea",
    resolvedAt: "2026-05-24T10:00:00Z",
    replyTo: "0",
    body: "Confirmed with latest source.",
  });
});

test("extractDocxReviewData merges adjacent Word runs with the same Markdown style", () => {
  const data = extractDocxReviewData(storedDocx({
    "word/document.xml": `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p><w:bookmarkStart w:id="1" w:name="n_c1_12345678"/><w:bookmarkEnd w:id="1"/><w:commentRangeStart w:id="7"/><w:r><w:t>Claim.</w:t></w:r><w:commentRangeEnd w:id="7"/><w:r><w:commentReference w:id="7"/></w:r></w:p>
  </w:body>
</w:document>`,
    "word/comments.xml": `<w:comments xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:comment w:id="7" w:author="Reviewer" w:initials="R">
    <w:p><w:r><w:rPr><w:b/></w:rPr><w:t>Bo</w:t></w:r><w:r><w:rPr><w:b/></w:rPr><w:t>ld</w:t></w:r><w:r><w:t> and </w:t></w:r><w:r><w:rPr><w:i/></w:rPr><w:t>em</w:t></w:r><w:r><w:rPr><w:i/></w:rPr><w:t>phasis</w:t></w:r><w:r><w:t> plus </w:t></w:r><w:r><w:rPr><w:rFonts w:ascii="Courier New"/></w:rPr><w:t>co</w:t></w:r><w:r><w:rPr><w:rFonts w:ascii="Courier New"/></w:rPr><w:t>de</w:t></w:r></w:p>
  </w:comment>
</w:comments>`,
  }));

  assert.deepEqual(data.comments, [
    {
      nativeId: "7",
      anchorBookmarkNames: ["n_c1_12345678"],
      author: "Reviewer",
      initials: "R",
      body: "**Bold** and *emphasis* plus `code`",
    },
  ]);
});

test("extractDocxReviewData maps later framed directive body review anchors", () => {
  const data = extractDocxReviewData(storedDocx({
    "word/document.xml": `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p><w:pPr><w:pStyle w:val="NomaDirective"/></w:pPr><w:bookmarkStart w:id="1" w:name="n_c1_12345678"/><w:r><w:t>Claim</w:t></w:r><w:bookmarkEnd w:id="1"/></w:p>
    <w:p><w:pPr><w:shd w:fill="F1F6EF"/></w:pPr><w:r><w:t>First paragraph.</w:t></w:r></w:p>
    <w:p><w:pPr><w:shd w:fill="F1F6EF"/></w:pPr><w:commentRangeStart w:id="7"/><w:r><w:t>Second paragraph.</w:t></w:r><w:r><w:footnoteReference w:id="3"/></w:r><w:commentRangeEnd w:id="7"/><w:r><w:commentReference w:id="7"/></w:r></w:p>
    <w:p><w:pPr><w:shd w:fill="F1F6EF"/></w:pPr><w:del w:id="8" w:author="Reviewer" w:date="2026-05-25T09:00:00Z"><w:r><w:delText>Third paragraph.</w:delText></w:r></w:del><w:ins w:id="9" w:author="Reviewer" w:date="2026-05-25T09:00:00Z"><w:r><w:t>Third paragraph updated.</w:t></w:r></w:ins></w:p>
  </w:body>
</w:document>`,
    "word/comments.xml": `<w:comments xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:comment w:id="7" w:author="Reviewer" w:initials="R"><w:p><w:r><w:t>Review the second paragraph.</w:t></w:r></w:p></w:comment>
</w:comments>`,
    "word/footnotes.xml": `<w:footnotes xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:footnote w:id="3"><w:p><w:r><w:t>Footnote on the second paragraph.</w:t></w:r></w:p></w:footnote>
</w:footnotes>`,
  }));

  assert.deepEqual(data.comments, [
    {
      nativeId: "7",
      anchorBookmarkNames: ["n_c1_12345678"],
      author: "Reviewer",
      initials: "R",
      body: "Review the second paragraph.",
    },
  ]);
  assert.deepEqual(data.revisions, [
    {
      nativeId: "8/9",
      action: "replace",
      anchorBookmarkNames: ["n_c1_12345678"],
      author: "Reviewer",
      date: "2026-05-25T09:00:00Z",
      oldText: "Third paragraph.",
      newText: "Third paragraph updated.",
    },
  ]);
  assert.deepEqual(data.footnotes, [
    {
      nativeId: "3",
      anchorBookmarkNames: ["n_c1_12345678"],
      body: "Footnote on the second paragraph.",
    },
  ]);
});

test("extractDocxReviewData maps layout table review anchors to child bookmarks", () => {
  const data = extractDocxReviewData(storedDocx({
    "word/document.xml": `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p><w:pPr><w:pStyle w:val="NomaMeta"/></w:pPr><w:bookmarkStart w:id="1" w:name="n_grid_12345678"/><w:bookmarkEnd w:id="1"/></w:p>
    <w:tbl>
      <w:tblPr><w:tblStyle w:val="NomaLayout"/></w:tblPr>
      <w:tr><w:tc>
        <w:p><w:pPr><w:pStyle w:val="NomaDirective"/></w:pPr><w:bookmarkStart w:id="2" w:name="n_card_one_12345678"/><w:r><w:t>Card one</w:t></w:r><w:bookmarkEnd w:id="2"/></w:p>
        <w:p><w:pPr><w:shd w:fill="F1F6EF"/></w:pPr><w:commentRangeStart w:id="7"/><w:r><w:t>Second paragraph.</w:t></w:r><w:r><w:footnoteReference w:id="3"/></w:r><w:commentRangeEnd w:id="7"/><w:r><w:commentReference w:id="7"/></w:r></w:p>
        <w:p><w:pPr><w:shd w:fill="F1F6EF"/></w:pPr><w:del w:id="8" w:author="Reviewer" w:date="2026-05-25T09:00:00Z"><w:r><w:delText>Third paragraph.</w:delText></w:r></w:del><w:ins w:id="9" w:author="Reviewer" w:date="2026-05-25T09:00:00Z"><w:r><w:t>Third paragraph updated.</w:t></w:r></w:ins></w:p>
      </w:tc></w:tr>
    </w:tbl>
  </w:body>
</w:document>`,
    "word/comments.xml": `<w:comments xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:comment w:id="7" w:author="Reviewer" w:initials="R"><w:p><w:r><w:t>Review the card paragraph.</w:t></w:r></w:p></w:comment>
</w:comments>`,
    "word/footnotes.xml": `<w:footnotes xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:footnote w:id="3"><w:p><w:r><w:t>Footnote on the card paragraph.</w:t></w:r></w:p></w:footnote>
</w:footnotes>`,
  }));

  assert.equal(data.comments[0]?.anchorBookmarkNames?.[0], "n_card_one_12345678");
  assert.equal(data.footnotes[0]?.anchorBookmarkNames?.[0], "n_card_one_12345678");
  assert.equal(data.revisions[0]?.anchorBookmarkNames?.[0], "n_card_one_12345678");
  assert.notEqual(data.comments[0]?.anchorBookmarkNames?.[0], "n_grid_12345678");
});

test("extractDocxReviewData resets layout review anchors at cell boundaries", () => {
  const data = extractDocxReviewData(storedDocx({
    "word/document.xml": `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p><w:pPr><w:pStyle w:val="NomaMeta"/></w:pPr><w:bookmarkStart w:id="1" w:name="n_grid_12345678"/><w:bookmarkEnd w:id="1"/></w:p>
    <w:tbl>
      <w:tblPr><w:tblStyle w:val="NomaLayout"/></w:tblPr>
      <w:tr>
        <w:tc>
          <w:p><w:pPr><w:pStyle w:val="NomaDirective"/></w:pPr><w:bookmarkStart w:id="2" w:name="n_card_one_12345678"/><w:r><w:t>Card one</w:t></w:r><w:bookmarkEnd w:id="2"/></w:p>
          <w:p><w:pPr><w:shd w:fill="F1F6EF"/></w:pPr><w:r><w:t>First cell body.</w:t></w:r></w:p>
        </w:tc>
        <w:tc>
          <w:p><w:commentRangeStart w:id="7"/><w:r><w:t>Loose second cell.</w:t></w:r><w:r><w:footnoteReference w:id="3"/></w:r><w:commentRangeEnd w:id="7"/><w:r><w:commentReference w:id="7"/></w:r></w:p>
          <w:p><w:del w:id="8" w:author="Reviewer" w:date="2026-05-25T09:00:00Z"><w:r><w:delText>Loose old.</w:delText></w:r></w:del><w:ins w:id="9" w:author="Reviewer" w:date="2026-05-25T09:00:00Z"><w:r><w:t>Loose new.</w:t></w:r></w:ins></w:p>
        </w:tc>
      </w:tr>
    </w:tbl>
  </w:body>
</w:document>`,
    "word/comments.xml": `<w:comments xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:comment w:id="7" w:author="Reviewer" w:initials="R"><w:p><w:r><w:t>Review the loose layout cell.</w:t></w:r></w:p></w:comment>
</w:comments>`,
    "word/footnotes.xml": `<w:footnotes xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:footnote w:id="3"><w:p><w:r><w:t>Footnote on the loose layout cell.</w:t></w:r></w:p></w:footnote>
</w:footnotes>`,
  }));

  assert.equal(data.comments[0]?.anchorBookmarkNames?.[0], "n_grid_12345678");
  assert.equal(data.footnotes[0]?.anchorBookmarkNames?.[0], "n_grid_12345678");
  assert.equal(data.revisions[0]?.anchorBookmarkNames?.[0], "n_grid_12345678");
  assert.notEqual(data.comments[0]?.anchorBookmarkNames?.[0], "n_card_one_12345678");
});

test("extractDocxReviewData preserves formatted external hyperlink labels", () => {
  const data = extractDocxReviewData(storedDocx({
    "word/document.xml": `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p><w:bookmarkStart w:id="1" w:name="n_c1_12345678"/><w:bookmarkEnd w:id="1"/><w:commentRangeStart w:id="7"/><w:r><w:t>Claim.</w:t></w:r><w:commentRangeEnd w:id="7"/><w:r><w:commentReference w:id="7"/></w:r></w:p>
  </w:body>
</w:document>`,
    "word/comments.xml": `<w:comments xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <w:comment w:id="7" w:author="Reviewer" w:initials="R">
    <w:p><w:r><w:t>Read </w:t></w:r><w:hyperlink r:id="rId1"><w:r><w:rPr><w:b/></w:rPr><w:t>source</w:t></w:r><w:r><w:rPr><w:b/></w:rPr><w:t> note</w:t></w:r></w:hyperlink><w:r><w:t>.</w:t></w:r></w:p>
  </w:comment>
</w:comments>`,
    "word/_rels/comments.xml.rels": `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://example.com/source" TargetMode="External"/>
</Relationships>`,
  }));

  assert.deepEqual(data.comments, [
    {
      nativeId: "7",
      anchorBookmarkNames: ["n_c1_12345678"],
      author: "Reviewer",
      initials: "R",
      body: "Read [**source note**](https://example.com/source).",
    },
  ]);
});

test("extractDocxReviewData preserves external hyperlink label spaces", () => {
  const data = extractDocxReviewData(storedDocx({
    "word/document.xml": `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p><w:bookmarkStart w:id="1" w:name="n_c1_12345678"/><w:bookmarkEnd w:id="1"/><w:commentRangeStart w:id="7"/><w:r><w:t>Claim.</w:t></w:r><w:commentRangeEnd w:id="7"/><w:r><w:commentReference w:id="7"/></w:r></w:p>
  </w:body>
</w:document>`,
    "word/comments.xml": `<w:comments xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <w:comment w:id="7" w:author="Reviewer" w:initials="R">
    <w:p><w:r><w:t>Read </w:t></w:r><w:hyperlink r:id="rId1"><w:r><w:t xml:space="preserve"> source </w:t></w:r></w:hyperlink><w:r><w:t>.</w:t></w:r></w:p>
  </w:comment>
</w:comments>`,
    "word/_rels/comments.xml.rels": `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://example.com/source" TargetMode="External"/>
</Relationships>`,
  }));

  assert.equal(data.comments[0]?.body, "Read [ source ](https://example.com/source).");
});

test("extractDocxReviewData escapes bracketed external hyperlink labels", () => {
  const data = extractDocxReviewData(storedDocx({
    "word/document.xml": `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p><w:bookmarkStart w:id="1" w:name="n_c1_12345678"/><w:bookmarkEnd w:id="1"/><w:commentRangeStart w:id="7"/><w:r><w:t>Claim.</w:t></w:r><w:commentRangeEnd w:id="7"/><w:r><w:commentReference w:id="7"/></w:r></w:p>
  </w:body>
</w:document>`,
    "word/comments.xml": `<w:comments xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <w:comment w:id="7" w:author="Reviewer" w:initials="R">
    <w:p><w:r><w:t>Read </w:t></w:r><w:hyperlink r:id="rId1"><w:r><w:t>[source]</w:t></w:r></w:hyperlink><w:r><w:t>.</w:t></w:r></w:p>
  </w:comment>
</w:comments>`,
    "word/_rels/comments.xml.rels": `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://example.com/source" TargetMode="External"/>
</Relationships>`,
  }));

  assert.deepEqual(data.comments, [
    {
      nativeId: "7",
      anchorBookmarkNames: ["n_c1_12345678"],
      author: "Reviewer",
      initials: "R",
      body: "Read [\\[source\\]](https://example.com/source).",
    },
  ]);
});

test("extractDocxReviewData percent-encodes Markdown-hostile external hyperlink targets", () => {
  const data = extractDocxReviewData(storedDocx({
    "word/document.xml": `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p><w:bookmarkStart w:id="1" w:name="n_c1_12345678"/><w:bookmarkEnd w:id="1"/><w:commentRangeStart w:id="7"/><w:r><w:t>Claim.</w:t></w:r><w:commentRangeEnd w:id="7"/><w:r><w:commentReference w:id="7"/></w:r></w:p>
  </w:body>
</w:document>`,
    "word/comments.xml": `<w:comments xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <w:comment w:id="7" w:author="Reviewer" w:initials="R">
    <w:p><w:r><w:t>Read </w:t></w:r><w:hyperlink r:id="rId1"><w:r><w:t>source</w:t></w:r></w:hyperlink><w:r><w:t>.</w:t></w:r></w:p>
  </w:comment>
</w:comments>`,
    "word/_rels/comments.xml.rels": `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://example.com/report(2026 final).html" TargetMode="External"/>
</Relationships>`,
  }));

  assert.deepEqual(data.comments, [
    {
      nativeId: "7",
      anchorBookmarkNames: ["n_c1_12345678"],
      author: "Reviewer",
      initials: "R",
      body: "Read [source](https://example.com/report%282026%20final%29.html).",
    },
  ]);
});

test("extractDocxReviewData preserves Word field-code hyperlinks", () => {
  const data = extractDocxReviewData(storedDocx({
    "word/document.xml": `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p><w:bookmarkStart w:id="1" w:name="n_c1_12345678"/><w:bookmarkEnd w:id="1"/><w:commentRangeStart w:id="7"/><w:r><w:t>Claim.</w:t></w:r><w:commentRangeEnd w:id="7"/><w:r><w:commentReference w:id="7"/></w:r></w:p>
  </w:body>
</w:document>`,
    "word/comments.xml": `<w:comments xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:comment w:id="7" w:author="Reviewer" w:initials="R">
    <w:p><w:r><w:t>See </w:t></w:r><w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> HYPERLINK "https://example.com/report draft(2).html" </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r><w:r><w:rPr><w:b/></w:rPr><w:t>field link</w:t></w:r><w:r><w:fldChar w:fldCharType="end"/></w:r><w:r><w:t> and </w:t></w:r><w:fldSimple w:instr=" HYPERLINK \\l &quot;section-1&quot; "><w:r><w:t>internal note</w:t></w:r></w:fldSimple><w:r><w:t>.</w:t></w:r></w:p>
  </w:comment>
</w:comments>`,
  }));

  assert.deepEqual(data.comments, [
    {
      nativeId: "7",
      anchorBookmarkNames: ["n_c1_12345678"],
      author: "Reviewer",
      initials: "R",
      body: "See [**field link**](https://example.com/report%20draft%282%29.html) and [internal note](#section-1).",
    },
  ]);
});

test("extractDocxReviewData round-trips Noma-authored formatted external hyperlink labels", () => {
  const doc = parse(`# Review

::claim{id="c1"}
Claim.
::

::comment{id="comment-c1" parent="c1" author="Reviewer"}
Read [***source note***](https://example.com/source).
::
`);

  const data = extractDocxReviewData(renderDocx(doc));

  assert.equal(data.comments[0]?.body, "Read [***source note***](https://example.com/source).");
});

test("extractDocxReviewData preserves formatted internal hyperlink labels", () => {
  const doc = parse(`# Review

## Details {id="details"}

::claim{id="c1"}
Claim.
::

::comment{id="comment-c1" parent="c1" author="Reviewer"}
See [*details*](#details) and [[c1]].
::
`);

  const data = extractDocxReviewData(renderDocx(doc));

  assert.equal(data.comments[0]?.body, "See [*details*](#details) and [[c1]].");
});

test("extractDocxReviewData preserves custom internal hyperlink labels", () => {
  const doc = parse(`# Review

## Details {id="review-details"}

::claim{id="c1"}
Claim.
::

::comment{id="comment-c1" parent="c1" author="Reviewer"}
See [*the detailed note*](#review-details).
::
`);

  const data = extractDocxReviewData(renderDocx(doc));

  assert.equal(data.comments[0]?.body, "See [*the detailed note*](#review-details).");
});

test("extractDocxReviewData preserves leading and trailing spaces in review bodies", () => {
  const data = extractDocxReviewData(storedDocx({
    "word/comments.xml": `<w:comments xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:comment w:id="7" w:author="Reviewer">
    <w:p><w:r><w:t xml:space="preserve">  Padded comment  </w:t></w:r></w:p>
  </w:comment>
</w:comments>`,
    "word/footnotes.xml": `<w:footnotes xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:footnote w:id="-1" w:type="separator"><w:p><w:r><w:separator/></w:r></w:p></w:footnote>
  <w:footnote w:id="3"><w:p><w:r><w:t xml:space="preserve">  Padded footnote  </w:t></w:r></w:p></w:footnote>
</w:footnotes>`,
    "word/endnotes.xml": `<w:endnotes xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:endnote w:id="-1" w:type="separator"><w:p><w:r><w:separator/></w:r></w:p></w:endnote>
  <w:endnote w:id="4"><w:p><w:r><w:t xml:space="preserve">  Padded endnote  </w:t></w:r></w:p></w:endnote>
</w:endnotes>`,
  }));

  assert.equal(data.comments[0]?.body, "  Padded comment  ");
  assert.equal(data.footnotes[0]?.body, "  Padded footnote  ");
  assert.equal(data.endnotes[0]?.body, "  Padded endnote  ");
});

test("extractDocxReviewData ignores deleted tracked text in current comment bodies", () => {
  const data = extractDocxReviewData(storedDocx({
    "word/document.xml": `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p><w:bookmarkStart w:id="1" w:name="n_c1_12345678"/><w:bookmarkEnd w:id="1"/><w:commentRangeStart w:id="7"/><w:r><w:t>Claim.</w:t></w:r><w:commentRangeEnd w:id="7"/><w:r><w:commentReference w:id="7"/></w:r></w:p>
  </w:body>
</w:document>`,
    "word/comments.xml": `<w:comments xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:comment w:id="7" w:author="Reviewer" w:initials="R">
    <w:p><w:del w:id="5" w:author="Reviewer" w:date="2026-05-25T09:00:00Z"><w:r><w:delText>Old comment.</w:delText></w:r></w:del><w:ins w:id="6" w:author="Reviewer" w:date="2026-05-25T09:00:00Z"><w:r><w:t>Updated comment.</w:t></w:r></w:ins></w:p>
  </w:comment>
</w:comments>`,
  }));

  assert.deepEqual(data.comments, [
    {
      nativeId: "7",
      anchorBookmarkNames: ["n_c1_12345678"],
      author: "Reviewer",
      initials: "R",
      hasRevisions: true,
      body: "Updated comment.",
    },
  ]);
  assert.deepEqual(data.revisions, []);
});

test("extractDocxReviewData ignores self-closing tokens inside deleted tracked comment bodies", () => {
  const data = extractDocxReviewData(storedDocx({
    "word/document.xml": `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p><w:bookmarkStart w:id="1" w:name="n_c1_12345678"/><w:bookmarkEnd w:id="1"/><w:commentRangeStart w:id="7"/><w:r><w:t>Claim.</w:t></w:r><w:commentRangeEnd w:id="7"/><w:r><w:commentReference w:id="7"/></w:r></w:p>
  </w:body>
</w:document>`,
    "word/comments.xml": `<w:comments xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:comment w:id="7" w:author="Reviewer" w:initials="R">
    <w:p><w:r><w:t>Updated</w:t></w:r><w:del w:id="5" w:author="Reviewer" w:date="2026-05-25T09:00:00Z"><w:r><w:br/><w:noBreakHyphen/><w:tab/><w:delText>old break</w:delText></w:r></w:del><w:r><w:t>comment.</w:t></w:r></w:p>
  </w:comment>
</w:comments>`,
  }));

  assert.deepEqual(data.comments, [
    {
      nativeId: "7",
      anchorBookmarkNames: ["n_c1_12345678"],
      author: "Reviewer",
      initials: "R",
      hasRevisions: true,
      body: "Updatedcomment.",
    },
  ]);
  assert.deepEqual(data.revisions, []);
});

test("extractDocxReviewData ignores moved-from tracked comment text and keeps moved-to text", () => {
  const data = extractDocxReviewData(storedDocx({
    "word/document.xml": `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p><w:bookmarkStart w:id="1" w:name="n_c1_12345678"/><w:bookmarkEnd w:id="1"/><w:commentRangeStart w:id="7"/><w:r><w:t>Claim.</w:t></w:r><w:commentRangeEnd w:id="7"/><w:r><w:commentReference w:id="7"/></w:r></w:p>
  </w:body>
</w:document>`,
    "word/comments.xml": `<w:comments xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:comment w:id="7" w:author="Reviewer" w:initials="R">
    <w:p><w:r><w:t>Updated </w:t></w:r><w:moveFrom w:id="5" w:author="Reviewer" w:date="2026-05-25T09:00:00Z"><w:r><w:t>old</w:t><w:br/><w:t>comment</w:t></w:r></w:moveFrom><w:moveTo w:id="6" w:author="Reviewer" w:date="2026-05-25T09:00:00Z"><w:r><w:t>comment.</w:t></w:r></w:moveTo></w:p>
  </w:comment>
</w:comments>`,
  }));

  assert.deepEqual(data.comments, [
    {
      nativeId: "7",
      anchorBookmarkNames: ["n_c1_12345678"],
      author: "Reviewer",
      initials: "R",
      hasRevisions: true,
      body: "Updated comment.",
    },
  ]);
  assert.deepEqual(data.revisions, []);
});

test("extractDocxReviewData ignores range-marked moved-from comment text and keeps moved-to text", () => {
  const data = extractDocxReviewData(storedDocx({
    "word/document.xml": `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p><w:bookmarkStart w:id="1" w:name="n_c1_12345678"/><w:bookmarkEnd w:id="1"/><w:commentRangeStart w:id="7"/><w:r><w:t>Claim.</w:t></w:r><w:commentRangeEnd w:id="7"/><w:r><w:commentReference w:id="7"/></w:r></w:p>
  </w:body>
</w:document>`,
    "word/comments.xml": `<w:comments xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:comment w:id="7" w:author="Reviewer" w:initials="R">
    <w:p><w:r><w:t>Updated </w:t></w:r><w:moveFromRangeStart w:id="5" w:author="Reviewer" w:date="2026-05-25T09:00:00Z"/><w:r><w:t>old</w:t><w:br/><w:t>comment</w:t></w:r><w:moveFromRangeEnd w:id="5"/><w:moveToRangeStart w:id="6" w:author="Reviewer" w:date="2026-05-25T09:00:00Z"/><w:r><w:t>comment.</w:t></w:r><w:moveToRangeEnd w:id="6"/></w:p>
  </w:comment>
</w:comments>`,
  }));

  assert.deepEqual(data.comments, [
    {
      nativeId: "7",
      anchorBookmarkNames: ["n_c1_12345678"],
      author: "Reviewer",
      initials: "R",
      hasRevisions: true,
      body: "Updated comment.",
    },
  ]);
  assert.deepEqual(data.revisions, []);
});

test("extractDocxReviewData preserves Word carriage-return breaks in comment bodies", () => {
  const data = extractDocxReviewData(storedDocx({
    "word/document.xml": `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p><w:bookmarkStart w:id="1" w:name="n_c1_12345678"/><w:bookmarkEnd w:id="1"/><w:commentRangeStart w:id="7"/><w:r><w:t>Claim.</w:t></w:r><w:commentRangeEnd w:id="7"/><w:r><w:commentReference w:id="7"/></w:r></w:p>
  </w:body>
</w:document>`,
    "word/comments.xml": `<w:comments xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:comment w:id="7" w:author="Reviewer" w:initials="R">
    <w:p><w:r><w:t>First line</w:t><w:cr/><w:t>Second line</w:t></w:r></w:p>
  </w:comment>
</w:comments>`,
  }));

  assert.deepEqual(data.comments, [
    {
      nativeId: "7",
      anchorBookmarkNames: ["n_c1_12345678"],
      author: "Reviewer",
      initials: "R",
      body: "First line\nSecond line",
    },
  ]);
});

test("extractDocxReviewData preserves paired Word empty run elements in comment bodies", () => {
  const data = extractDocxReviewData(storedDocx({
    "word/document.xml": `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p><w:bookmarkStart w:id="1" w:name="n_c1_12345678"/><w:bookmarkEnd w:id="1"/><w:commentRangeStart w:id="7"/><w:r><w:t>Claim.</w:t></w:r><w:commentRangeEnd w:id="7"/><w:r><w:commentReference w:id="7"/></w:r></w:p>
  </w:body>
</w:document>`,
    "word/comments.xml": `<w:comments xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:comment w:id="7" w:author="Reviewer" w:initials="R">
    <w:p><w:r><w:t>First</w:t><w:br></w:br><w:t>Second</w:t><w:tab></w:tab><w:t>Column</w:t><w:noBreakHyphen></w:noBreakHyphen><w:t>ready</w:t><w:softHyphen></w:softHyphen><w:t>term </w:t><w:sym w:font="Segoe UI Symbol" w:char="2713"></w:sym></w:r></w:p>
  </w:comment>
</w:comments>`,
  }));

  assert.deepEqual(data.comments, [
    {
      nativeId: "7",
      anchorBookmarkNames: ["n_c1_12345678"],
      author: "Reviewer",
      initials: "R",
      body: "First\nSecond\tColumn-ready\u00adterm \u2713",
    },
  ]);
});

test("extractDocxReviewData preserves Word no-break hyphens in comment bodies", () => {
  const data = extractDocxReviewData(storedDocx({
    "word/document.xml": `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p><w:bookmarkStart w:id="1" w:name="n_c1_12345678"/><w:bookmarkEnd w:id="1"/><w:commentRangeStart w:id="7"/><w:r><w:t>Claim.</w:t></w:r><w:commentRangeEnd w:id="7"/><w:r><w:commentReference w:id="7"/></w:r></w:p>
  </w:body>
</w:document>`,
    "word/comments.xml": `<w:comments xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:comment w:id="7" w:author="Reviewer" w:initials="R">
    <w:p><w:r><w:t>Board</w:t><w:noBreakHyphen/><w:t>ready memo.</w:t></w:r></w:p>
  </w:comment>
</w:comments>`,
  }));

  assert.deepEqual(data.comments, [
    {
      nativeId: "7",
      anchorBookmarkNames: ["n_c1_12345678"],
      author: "Reviewer",
      initials: "R",
      body: "Board-ready memo.",
    },
  ]);
});

test("extractDocxReviewData preserves Word symbol glyphs in comment bodies", () => {
  const data = extractDocxReviewData(storedDocx({
    "word/document.xml": `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p><w:bookmarkStart w:id="1" w:name="n_c1_12345678"/><w:bookmarkEnd w:id="1"/><w:commentRangeStart w:id="7"/><w:r><w:t>Claim.</w:t></w:r><w:commentRangeEnd w:id="7"/><w:r><w:commentReference w:id="7"/></w:r></w:p>
  </w:body>
</w:document>`,
    "word/comments.xml": `<w:comments xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:comment w:id="7" w:author="Reviewer" w:initials="R">
    <w:p><w:r><w:t>Review </w:t><w:sym w:font="Segoe UI Symbol" w:char="2713"/><w:t> complete.</w:t></w:r></w:p>
  </w:comment>
</w:comments>`,
  }));

  assert.deepEqual(data.comments, [
    {
      nativeId: "7",
      anchorBookmarkNames: ["n_c1_12345678"],
      author: "Reviewer",
      initials: "R",
      body: "Review \u2713 complete.",
    },
  ]);
});

test("extractDocxReviewData preserves Word positional tabs in comment bodies", () => {
  const data = extractDocxReviewData(storedDocx({
    "word/document.xml": `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p><w:bookmarkStart w:id="1" w:name="n_c1_12345678"/><w:bookmarkEnd w:id="1"/><w:commentRangeStart w:id="7"/><w:r><w:t>Claim.</w:t></w:r><w:commentRangeEnd w:id="7"/><w:r><w:commentReference w:id="7"/></w:r></w:p>
  </w:body>
</w:document>`,
    "word/comments.xml": `<w:comments xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:comment w:id="7" w:author="Reviewer" w:initials="R">
    <w:p><w:r><w:t>Metric</w:t><w:ptab w:relativeTo="margin" w:alignment="right" w:leader="none"/><w:t>Value</w:t></w:r></w:p>
  </w:comment>
</w:comments>`,
  }));

  assert.deepEqual(data.comments, [
    {
      nativeId: "7",
      anchorBookmarkNames: ["n_c1_12345678"],
      author: "Reviewer",
      initials: "R",
      body: "Metric\tValue",
    },
  ]);
});

test("extractDocxReviewData preserves Word soft hyphens in comment bodies", () => {
  const data = extractDocxReviewData(storedDocx({
    "word/document.xml": `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p><w:bookmarkStart w:id="1" w:name="n_c1_12345678"/><w:bookmarkEnd w:id="1"/><w:commentRangeStart w:id="7"/><w:r><w:t>Claim.</w:t></w:r><w:commentRangeEnd w:id="7"/><w:r><w:commentReference w:id="7"/></w:r></w:p>
  </w:body>
</w:document>`,
    "word/comments.xml": `<w:comments xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:comment w:id="7" w:author="Reviewer" w:initials="R">
    <w:p><w:r><w:t>co</w:t><w:softHyphen/><w:t>operate.</w:t></w:r></w:p>
  </w:comment>
</w:comments>`,
  }));

  assert.deepEqual(data.comments, [
    {
      nativeId: "7",
      anchorBookmarkNames: ["n_c1_12345678"],
      author: "Reviewer",
      initials: "R",
      body: "co\u00adoperate.",
    },
  ]);
});

test("extractDocxReviewData reads native Word resolved state without a status paragraph", () => {
  const data = extractDocxReviewData(storedDocx({
    "word/document.xml": `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p><w:bookmarkStart w:id="1" w:name="n_c1_12345678"/><w:bookmarkEnd w:id="1"/><w:commentRangeStart w:id="7"/><w:r><w:t>Claim.</w:t></w:r><w:commentRangeEnd w:id="7"/><w:r><w:commentReference w:id="7"/></w:r></w:p>
  </w:body>
</w:document>`,
    "word/comments.xml": `<w:comments xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:w15="http://schemas.microsoft.com/office/word/2012/wordml">
  <w:comment w:id="7" w:author="Reviewer" w:initials="R"><w:p w15:paraId="ABCDEF12"><w:r><w:t>Resolved in Word.</w:t></w:r></w:p></w:comment>
</w:comments>`,
    "word/commentsExtended.xml": `<w15:commentsEx xmlns:w15="http://schemas.microsoft.com/office/word/2012/wordml">
  <w15:commentEx w15:paraId="ABCDEF12" w15:done="1"/>
</w15:commentsEx>`,
  }));

  assert.deepEqual(data.comments, [
    {
      nativeId: "7",
      anchorBookmarkNames: ["n_c1_12345678"],
      author: "Reviewer",
      initials: "R",
      status: "resolved",
      body: "Resolved in Word.",
    },
  ]);
});

test("extractDocxReviewData honors native unresolved state over a stale status paragraph", () => {
  const data = extractDocxReviewData(storedDocx({
    "word/document.xml": `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p><w:bookmarkStart w:id="1" w:name="n_c1_12345678"/><w:bookmarkEnd w:id="1"/><w:commentRangeStart w:id="7"/><w:r><w:t>Claim.</w:t></w:r><w:commentRangeEnd w:id="7"/><w:r><w:commentReference w:id="7"/></w:r></w:p>
  </w:body>
</w:document>`,
    "word/comments.xml": `<w:comments xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:w15="http://schemas.microsoft.com/office/word/2012/wordml">
  <w:comment w:id="7" w:author="Reviewer" w:initials="R">
    <w:p w15:paraId="ABCDEF12"><w:r><w:t>Status: resolved; resolved by Andrea; resolved at 2026-05-24T10:00:00Z</w:t></w:r></w:p>
    <w:p><w:r><w:t>Reopened in Word.</w:t></w:r></w:p>
  </w:comment>
</w:comments>`,
    "word/commentsExtended.xml": `<w15:commentsEx xmlns:w15="http://schemas.microsoft.com/office/word/2012/wordml">
  <w15:commentEx w15:paraId="ABCDEF12" w15:done="0"/>
</w15:commentsEx>`,
  }));

  assert.deepEqual(data.comments, [
    {
      nativeId: "7",
      anchorBookmarkNames: ["n_c1_12345678"],
      author: "Reviewer",
      initials: "R",
      resolvedBy: "Andrea",
      resolvedAt: "2026-05-24T10:00:00Z",
      body: "Reopened in Word.",
    },
  ]);
});

test("extractDocxReviewData falls back to status paragraphs when native done is missing", () => {
  const data = extractDocxReviewData(storedDocx({
    "word/document.xml": `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p><w:bookmarkStart w:id="1" w:name="n_c1_12345678"/><w:bookmarkEnd w:id="1"/><w:commentRangeStart w:id="7"/><w:r><w:t>Claim.</w:t></w:r><w:commentRangeEnd w:id="7"/><w:r><w:commentReference w:id="7"/></w:r></w:p>
  </w:body>
</w:document>`,
    "word/comments.xml": `<w:comments xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:w15="http://schemas.microsoft.com/office/word/2012/wordml">
  <w:comment w:id="7" w:author="Reviewer" w:initials="R">
    <w:p w15:paraId="ABCDEF12"><w:r><w:t>Status: resolved; resolved by Andrea; resolved at 2026-05-24T10:00:00Z</w:t></w:r></w:p>
    <w:p><w:r><w:t>Resolved in Word.</w:t></w:r></w:p>
  </w:comment>
</w:comments>`,
    "word/commentsExtended.xml": `<w15:commentsEx xmlns:w15="http://schemas.microsoft.com/office/word/2012/wordml">
  <w15:commentEx w15:paraId="ABCDEF12"/>
</w15:commentsEx>`,
  }));

  assert.deepEqual(data.comments, [
    {
      nativeId: "7",
      anchorBookmarkNames: ["n_c1_12345678"],
      author: "Reviewer",
      initials: "R",
      status: "resolved",
      resolvedBy: "Andrea",
      resolvedAt: "2026-05-24T10:00:00Z",
      body: "Resolved in Word.",
    },
  ]);
});

test("extractDocxReviewData returns an empty comment list when no comments exist", () => {
  const doc = parse(`# Plain\n\nNo review comments here.\n`);
  const data = extractDocxReviewData(renderDocx(doc));
  assert.deepEqual(
    {
      comments: data.comments,
      revisions: data.revisions,
      footnotes: data.footnotes,
      endnotes: data.endnotes,
      tables: data.tables,
      captions: data.captions,
      labels: data.labels,
      metricValues: data.metricValues,
      metricMetadata: data.metricMetadata,
      blockMetadata: data.blockMetadata,
    },
    { comments: [], revisions: [], footnotes: [], endnotes: [], tables: [], captions: [], labels: [], metricValues: [], metricMetadata: [], blockMetadata: [] },
  );
  assert.equal(data.headings.length, 1);
  assert.equal(data.headings[0]?.title, "Plain");
});

test("extractDocxReviewData reads bookmarked Word headings", () => {
  const doc = parse(`# Review

## Section title {id="section-title"}

Body.
`);

  const data = extractDocxReviewData(renderDocx(doc));

  assert.deepEqual(data.headings.map((heading) => ({ nativeId: heading.nativeId, level: heading.level, title: heading.title })), [
    { nativeId: "0", level: 1, title: "Review" },
    { nativeId: "1", level: 2, title: "Section title" },
  ]);
  assert.match(data.headings[0]?.anchorBookmarkNames?.[0] ?? "", /^n_review_/);
  assert.match(data.headings[1]?.anchorBookmarkNames?.[0] ?? "", /^n_section_title_/);
});

test("extractDocxReviewData preserves rich heading titles", () => {
  const doc = parse(`# Intro {id="intro"}

## **Market** [source](https://example.com/heading) \`model\` and [[intro]] {id="topic"}

Body.
`);

  const data = extractDocxReviewData(renderDocx(doc));

  assert.deepEqual(data.headings.map((heading) => ({ nativeId: heading.nativeId, level: heading.level, title: heading.title })), [
    { nativeId: "0", level: 1, title: "Intro" },
    {
      nativeId: "1",
      level: 2,
      title: "**Market** [source](https://example.com/heading) `model` and [[intro]]",
    },
  ]);
  assert.match(data.headings[1]?.anchorBookmarkNames?.[0] ?? "", /^n_topic_/);
});

test("extractDocxReviewData reads bookmarked Word captions", () => {
  const doc = parse(`# Review

::table{id="metrics" title="Quarterly metrics" header}
| Metric | Value |
| ARR | 10m |
::

::figure{id="diagram" caption="Architecture diagram"}
::

::plot{id="growth" title="Revenue trend" type="line" data="1,2,3"}
::

::computed_plot{id="projection" formula="x * 2" domain="x:0..2"}
title: Projection
::

::computed_plot{id="projection-label" label="Labeled projection" formula="x * 2" domain="x:0..2"}
::
`);

  const data = extractDocxReviewData(renderDocx(doc));

  assert.deepEqual(data.captions?.map((caption) => ({
    nativeId: caption.nativeId,
    kind: caption.kind,
    title: caption.title,
  })), [
    { nativeId: "0", kind: "table", title: "Quarterly metrics" },
    { nativeId: "1", kind: "figure", title: "Architecture diagram" },
    { nativeId: "2", kind: "plot", title: "Revenue trend" },
    { nativeId: "3", kind: "plot", title: "Projection" },
    { nativeId: "4", kind: "plot", title: "Labeled projection" },
  ]);
  assert.match(data.captions?.[0]?.anchorBookmarkNames?.[0] ?? "", /^n_metrics_/);
  assert.match(data.captions?.[1]?.anchorBookmarkNames?.[0] ?? "", /^n_diagram_/);
  assert.match(data.captions?.[2]?.anchorBookmarkNames?.[0] ?? "", /^n_growth_/);
  assert.match(data.captions?.[3]?.anchorBookmarkNames?.[0] ?? "", /^n_projection_/);
  assert.match(data.captions?.[4]?.anchorBookmarkNames?.[0] ?? "", /^n_projection_label_/);
});

test("extractDocxReviewData preserves rich Word caption titles", () => {
  const data = extractDocxReviewData(storedDocx({
    "word/document.xml": `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <w:body>
    <w:p>
      <w:pPr><w:pStyle w:val="NomaCaption"/></w:pPr>
      <w:bookmarkStart w:id="1" w:name="n_metrics_12345678"/>
      <w:r><w:t>Table 1: </w:t></w:r>
      <w:r><w:rPr><w:b/></w:rPr><w:t>Scenario</w:t></w:r>
      <w:r><w:t> </w:t></w:r>
      <w:hyperlink r:id="rId1"><w:r><w:rPr><w:i/></w:rPr><w:t>source</w:t></w:r></w:hyperlink>
      <w:bookmarkEnd w:id="1"/>
    </w:p>
  </w:body>
</w:document>`,
    "word/_rels/document.xml.rels": `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://example.com/caption" TargetMode="External"/>
</Relationships>`,
  }));

  assert.deepEqual(data.captions?.map((caption) => ({
    nativeId: caption.nativeId,
    kind: caption.kind,
    title: caption.title,
  })), [
    { nativeId: "0", kind: "table", title: "**Scenario** [*source*](https://example.com/caption)" },
  ]);
  assert.equal(data.captions?.[0]?.anchorBookmarkNames?.[0], "n_metrics_12345678");
});

test("extractDocxReviewData reads bookmarked Word metric labels", () => {
  const doc = parse(`# Review

::metric{id="arr" label="ARR" value="10" unit="M"}
::

::computed_metric{id="year-5" label="Year 5 revenue" formula="2 + 2"}
::
`);

  const data = extractDocxReviewData(renderDocx(doc));

  assert.deepEqual(data.labels?.map((label) => ({
    nativeId: label.nativeId,
    kind: label.kind,
    title: label.title,
  })), [
    { nativeId: "0", kind: "metric", title: "ARR" },
    { nativeId: "1", kind: "computed_metric", title: "Year 5 revenue" },
  ]);
  assert.match(data.labels?.[0]?.anchorBookmarkNames?.[0] ?? "", /^n_arr_/);
  assert.match(data.labels?.[1]?.anchorBookmarkNames?.[0] ?? "", /^n_year_5_/);
});

test("extractDocxReviewData preserves rich Word metric labels", () => {
  const data = extractDocxReviewData(storedDocx({
    "word/document.xml": `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <w:body>
    <w:p>
      <w:pPr><w:pStyle w:val="NomaDirective"/></w:pPr>
      <w:bookmarkStart w:id="1" w:name="n_arr_12345678"/>
      <w:r><w:t>Metric: </w:t></w:r>
      <w:r><w:rPr><w:b/></w:rPr><w:t>ARR</w:t></w:r>
      <w:r><w:t> from </w:t></w:r>
      <w:hyperlink r:id="rId1"><w:r><w:t>CRM</w:t></w:r></w:hyperlink>
      <w:bookmarkEnd w:id="1"/>
    </w:p>
  </w:body>
</w:document>`,
    "word/_rels/document.xml.rels": `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://example.com/crm" TargetMode="External"/>
</Relationships>`,
  }));

  assert.deepEqual(data.labels?.map((label) => ({
    nativeId: label.nativeId,
    kind: label.kind,
    title: label.title,
  })), [
    { nativeId: "0", kind: "metric", title: "**ARR** from [CRM](https://example.com/crm)" },
  ]);
  assert.equal(data.labels?.[0]?.anchorBookmarkNames?.[0], "n_arr_12345678");
});

test("extractDocxReviewData reads bookmarked Word control labels", () => {
  const doc = parse(`# Form

::control{id="growth" type="number" default=8 label="Growth rate"}
::
`);

  const data = extractDocxReviewData(renderDocx(doc));

  assert.deepEqual(data.labels?.map((label) => ({
    nativeId: label.nativeId,
    kind: label.kind,
    title: label.title,
  })), [
    { nativeId: "0", kind: "control", title: "Growth rate" },
  ]);
  assert.match(data.labels?.[0]?.anchorBookmarkNames?.[0] ?? "", /^n_growth_/);
});

test("extractDocxReviewData reads bookmarked Word action labels", () => {
  const doc = parse(`# Actions

::button{id="cta" href="https://example.com" label="Start now"}
::

::export_button{id="copy" format="prompt" target="cta" label="Copy prompt"}
::
`);

  const data = extractDocxReviewData(renderDocx(doc));

  assert.deepEqual(data.labels?.map((label) => ({
    nativeId: label.nativeId,
    kind: label.kind,
    title: label.title,
  })), [
    { nativeId: "0", kind: "button", title: "Start now" },
    { nativeId: "1", kind: "export_button", title: "Copy prompt" },
  ]);
  assert.match(data.labels?.[0]?.anchorBookmarkNames?.[0] ?? "", /^n_cta_/);
  assert.match(data.labels?.[1]?.anchorBookmarkNames?.[0] ?? "", /^n_copy_/);
});

test("extractDocxReviewData preserves rich Word action labels without generated hyperlink chrome", () => {
  const data = extractDocxReviewData(storedDocx({
    "word/document.xml": `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <w:body>
    <w:p>
      <w:pPr><w:pStyle w:val="NomaAction"/></w:pPr>
      <w:bookmarkStart w:id="1" w:name="n_cta_12345678"/>
      <w:hyperlink r:id="rId1">
        <w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">Start </w:t></w:r>
        <w:r><w:rPr><w:b/><w:i/></w:rPr><w:t>now</w:t></w:r>
      </w:hyperlink>
      <w:bookmarkEnd w:id="1"/>
    </w:p>
    <w:p>
      <w:pPr><w:pStyle w:val="NomaAction"/></w:pPr>
      <w:bookmarkStart w:id="2" w:name="n_copy_12345678"/>
      <w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">Export action: </w:t></w:r>
      <w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">Copy </w:t></w:r>
      <w:r><w:rPr><w:b/><w:i/></w:rPr><w:t>prompt</w:t></w:r>
      <w:r><w:t xml:space="preserve"> · target: </w:t></w:r>
      <w:hyperlink w:anchor="n_cta_12345678"><w:r><w:t>cta</w:t></w:r></w:hyperlink>
      <w:bookmarkEnd w:id="2"/>
    </w:p>
  </w:body>
</w:document>`,
    "word/_rels/document.xml.rels": `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://example.com/start" TargetMode="External"/>
</Relationships>`,
  }));

  assert.deepEqual(data.labels?.map((label) => ({
    nativeId: label.nativeId,
    kind: label.kind,
    title: label.title,
  })), [
    { nativeId: "0", kind: "button", title: "Start *now*" },
    { nativeId: "1", kind: "export_button", title: "Copy *prompt*" },
  ]);
});

test("extractDocxReviewData preserves mixed Word action label bold as authored Markdown", () => {
  const data = extractDocxReviewData(storedDocx({
    "word/document.xml": `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <w:body>
    <w:p>
      <w:pPr><w:pStyle w:val="NomaAction"/></w:pPr>
      <w:bookmarkStart w:id="1" w:name="n_cta_12345678"/>
      <w:hyperlink r:id="rId1">
        <w:r><w:t xml:space="preserve">Start </w:t></w:r>
        <w:r><w:rPr><w:b/></w:rPr><w:t>now</w:t></w:r>
      </w:hyperlink>
      <w:bookmarkEnd w:id="1"/>
    </w:p>
	    <w:p>
	      <w:pPr><w:pStyle w:val="NomaAction"/></w:pPr>
	      <w:bookmarkStart w:id="2" w:name="n_growth_12345678"/>
	      <w:r><w:t xml:space="preserve">Control: Growth </w:t></w:r>
	      <w:r><w:rPr><w:b/></w:rPr><w:t>rate</w:t></w:r>
	      <w:bookmarkEnd w:id="2"/>
	    </w:p>
	    <w:p>
	      <w:pPr><w:pStyle w:val="NomaAction"/></w:pPr>
	      <w:bookmarkStart w:id="3" w:name="n_copy_12345678"/>
	      <w:r><w:rPr><w:b/></w:rPr><w:t xml:space="preserve">Export action: </w:t></w:r>
	      <w:r><w:t xml:space="preserve">Copy </w:t></w:r>
	      <w:r><w:rPr><w:b/></w:rPr><w:t>prompt</w:t></w:r>
	      <w:r><w:t xml:space="preserve"> · target: </w:t></w:r>
	      <w:hyperlink w:anchor="n_cta_12345678"><w:r><w:t>cta</w:t></w:r></w:hyperlink>
	      <w:bookmarkEnd w:id="3"/>
	    </w:p>
	  </w:body>
	</w:document>`,
    "word/_rels/document.xml.rels": `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://example.com/start" TargetMode="External"/>
</Relationships>`,
  }));

  assert.deepEqual(data.labels?.map((label) => ({
    nativeId: label.nativeId,
    kind: label.kind,
    title: label.title,
	  })), [
	    { nativeId: "0", kind: "button", title: "Start **now**" },
	    { nativeId: "1", kind: "control", title: "Growth **rate**" },
	    { nativeId: "2", kind: "export_button", title: "Copy **prompt**" },
	  ]);
	});

test("extractDocxReviewData reads bookmarked Word block titles", () => {
  const doc = parse(`# Panels

::card{id="plan" title="Old plan"}
Body.
::

::callout{id="warning" tone="warning" title="Old warning"}
Body.
::

::api{id="api" title="Old API"}
Body.
::
`);

  const data = extractDocxReviewData(renderDocx(doc));

  assert.deepEqual(data.labels?.map((label) => ({
    nativeId: label.nativeId,
    kind: label.kind,
    title: label.title,
  })), [
    { nativeId: "0", kind: "block_title", title: "Old plan" },
    { nativeId: "1", kind: "block_title", title: "Warning: Old warning" },
    { nativeId: "2", kind: "block_title", title: "API: Old API" },
  ]);
  assert.match(data.labels?.[0]?.anchorBookmarkNames?.[0] ?? "", /^n_plan_/);
  assert.match(data.labels?.[1]?.anchorBookmarkNames?.[0] ?? "", /^n_warning_/);
  assert.match(data.labels?.[2]?.anchorBookmarkNames?.[0] ?? "", /^n_api_/);
});

test("extractDocxReviewData reads bookmarked Word block bodies", () => {
  const doc = parse(`# Review

::claim{id="c1"}
First **bold** paragraph.

Second [source](https://example.com/report) paragraph.
::

::card{id="plan" title="Plan"}
Card body.
::
`);

  const data = extractDocxReviewData(renderDocx(doc));

  assert.deepEqual(data.blockBodies?.map((body) => ({
    nativeId: body.nativeId,
    body: body.body,
  })), [
    {
      nativeId: "0",
      body: "First **bold** paragraph.\n\nSecond [source](https://example.com/report) paragraph.",
    },
    {
      nativeId: "1",
      body: "Card body.",
    },
  ]);
  assert.match(data.blockBodies?.[0]?.anchorBookmarkNames?.[0] ?? "", /^n_c1_/);
  assert.match(data.blockBodies?.[1]?.anchorBookmarkNames?.[0] ?? "", /^n_plan_/);
});

test("extractDocxReviewData preserves generated caption REF fields as wikilinks", () => {
  const doc = parse(`# Review

::table{id="metrics" title="Quarterly metrics" header}
| Metric | Value |
| ARR | 10m |
::

::claim{id="c1"}
See **[[metrics]]** before editing the table.
::
`);

  const data = extractDocxReviewData(renderDocx(doc));

  const body = data.blockBodies?.find((entry) =>
    entry.anchorBookmarkNames?.some((bookmark) => /^n_c1_/.test(bookmark))
  );
  assert.equal(body?.body, "See **[[metrics]]** before editing the table.");
});

test("extractDocxReviewData preserves simple generated caption REF fields as wikilinks", () => {
  const doc = parse(`# Review

::table{id="metrics" title="Quarterly metrics" header}
| Metric | Value |
| ARR | 10m |
::

::claim{id="c1"}
See **[[metrics]]** before editing the table.
::
`);

  const data = extractDocxReviewData(docxWithSimpleCaptionRefField(renderDocx(doc)));

  const body = data.blockBodies?.find((entry) =>
    entry.anchorBookmarkNames?.some((bookmark) => /^n_c1_/.test(bookmark))
  );
  assert.equal(body?.body, "See **[[metrics]]** before editing the table.");
});

test("extractDocxReviewData reads bookmarked Word code block bodies", () => {
  const doc = parse(`# Compute

::code_cell{id="cell1" lang="ts" runtime="node"}
const value = 1;

console.log(value);
::

::output{id="out1" cell="cell1"}
value=1
::
`);

  const data = extractDocxReviewData(renderDocx(doc));

  assert.deepEqual(data.blockBodies?.map((body) => ({
    nativeId: body.nativeId,
    mode: body.mode,
    body: body.body,
  })), [
    {
      nativeId: "0",
      mode: "code",
      body: "const value = 1;\n\nconsole.log(value);",
    },
    {
      nativeId: "1",
      mode: "code",
      body: "value=1",
    },
  ]);
  assert.match(data.blockBodies?.[0]?.anchorBookmarkNames?.[0] ?? "", /^n_cell1_/);
  assert.match(data.blockBodies?.[1]?.anchorBookmarkNames?.[0] ?? "", /^n_out1_/);
});

test("extractDocxReviewData reads bookmarked Word custom fallback block bodies", () => {
  const doc = parse(`# Pack

::finance::position{id="holding-asml" asset_class="equity" region="EU"}
ASML position note.
::

::custom_directive{id="custom-block" last_seen="2026-05-24" noverify}
Custom block note.
::
`);

  const data = extractDocxReviewData(renderDocx(doc));

  assert.deepEqual(data.blockBodies?.map((body) => ({
    nativeId: body.nativeId,
    mode: body.mode,
    body: body.body,
  })), [
    {
      nativeId: "0",
      mode: "prose",
      body: "ASML position note.",
    },
    {
      nativeId: "1",
      mode: "prose",
      body: "Custom block note.",
    },
  ]);
  assert.match(data.blockBodies?.[0]?.anchorBookmarkNames?.[0] ?? "", /^n_holding_asml_/);
  assert.match(data.blockBodies?.[1]?.anchorBookmarkNames?.[0] ?? "", /^n_custom_block_/);
});

test("extractDocxReviewData reads bookmarked Word metric values", () => {
  const doc = parse(`# Review

::metric{id="arr" label="ARR" value="10" unit="M"}
::

::metric{id="pipeline" label="Pipeline" unit="M"}
42
::

::computed_metric{id="year-5" label="Year 5 revenue" formula="2 + 2" unit="M"}
::
`);

  const data = extractDocxReviewData(renderDocx(doc));

  assert.deepEqual(data.metricValues?.map((value) => ({
    nativeId: value.nativeId,
    value: value.value,
  })), [
    { nativeId: "0", value: "10 M" },
    { nativeId: "1", value: "42 M" },
  ]);
  assert.match(data.metricValues?.[0]?.anchorBookmarkNames?.[0] ?? "", /^n_arr_/);
  assert.match(data.metricValues?.[1]?.anchorBookmarkNames?.[0] ?? "", /^n_pipeline_/);
});

test("extractDocxReviewData reads bookmarked Word metric metadata", () => {
  const doc = parse(`# Review

::metric{id="arr" label="ARR" value="10" unit="M" status="draft" trend="up" delta="2" target="15" source="crm" asOf="2026-05-01"}
::

::computed_metric{id="year-5" label="Year 5 revenue" formula="2 + 2" status="draft"}
::
`);

  const data = extractDocxReviewData(renderDocx(doc));

  assert.deepEqual(data.metricMetadata?.map((meta) => ({
    nativeId: meta.nativeId,
    fields: meta.fields,
  })), [
    {
      nativeId: "0",
      fields: {
        status: "draft",
        trend: "up",
        change: "2",
        target: "15",
        source: "crm",
        "as of": "2026-05-01",
      },
    },
  ]);
  assert.match(data.metricMetadata?.[0]?.anchorBookmarkNames?.[0] ?? "", /^n_arr_/);
});

test("extractDocxReviewData reads bookmarked Word block metadata", () => {
  const doc = parse(`# Review

::risk{id="risk1" severity="high" owner="Ops" status="open"}
Mitigate.
::

::review{id="review1" for="risk1" status="needs_changes" reviewer="Andrea" due="2026-06-01"}
Check it.
::
`);

  const data = extractDocxReviewData(renderDocx(doc));

  assert.deepEqual(data.blockMetadata?.map((meta) => ({
    nativeId: meta.nativeId,
    fields: meta.fields,
  })), [
    {
      nativeId: "0",
      fields: {
        severity: "high",
        owner: "Ops",
        status: "open",
      },
    },
    {
      nativeId: "1",
      fields: {
        status: "needs_changes",
        reviewer: "Andrea",
        due: "2026-06-01",
      },
    },
  ]);
  assert.match(data.blockMetadata?.[0]?.anchorBookmarkNames?.[0] ?? "", /^n_risk1_/);
  assert.match(data.blockMetadata?.[1]?.anchorBookmarkNames?.[0] ?? "", /^n_review1_/);
});

test("extractDocxReviewData preserves metadata values containing Word separators", () => {
  const doc = parse(`# Review

::metric{id="arr" label="ARR" value="10" source="CRM · status: stale" status="draft"}
::

::risk{id="risk1" owner="Ops · Q1: Finance" status="open"}
Mitigate.
::
`);

  const data = extractDocxReviewData(renderDocx(doc));

  assert.deepEqual(data.metricMetadata?.map((meta) => ({
    nativeId: meta.nativeId,
    fields: meta.fields,
  })), [
    {
      nativeId: "0",
      fields: {
        status: "draft",
        source: "CRM · status: stale",
      },
    },
  ]);
  assert.deepEqual(data.blockMetadata?.map((meta) => ({
    nativeId: meta.nativeId,
    fields: meta.fields,
  })), [
    {
      nativeId: "0",
      fields: {
        owner: "Ops · Q1: Finance",
        status: "open",
      },
    },
  ]);
});

test("extractDocxReviewData preserves metadata values when Word isolates separator runs", () => {
  const doc = parse(`# Review

::metric{id="arr" label="ARR" value="10" source="CRM · status: stale" status="draft"}
::

::risk{id="risk1" owner="Ops · Q1: Finance" status="open"}
Mitigate.
::
`);

  const data = extractDocxReviewData(docxWithIsolatedMetadataValueSeparators(renderDocx(doc)));

  assert.deepEqual(data.metricMetadata?.map((meta) => ({
    nativeId: meta.nativeId,
    fields: meta.fields,
  })), [
    {
      nativeId: "0",
      fields: {
        status: "draft",
        source: "CRM · status: stale",
      },
    },
  ]);
  assert.deepEqual(data.blockMetadata?.map((meta) => ({
    nativeId: meta.nativeId,
    fields: meta.fields,
  })), [
    {
      nativeId: "0",
      fields: {
        owner: "Ops · Q1: Finance",
        status: "open",
      },
    },
  ]);
});

test("extractDocxReviewData reads multi-line Word citation metadata", () => {
  const doc = parse(`# Review

::citation{id="cite1" source="Vendor report" accessed="2026-05-01" href="https://example.com/report" doi="10.1000/report"}
::
`);

  const data = extractDocxReviewData(renderDocx(doc));

  assert.deepEqual(data.blockMetadata?.map((meta) => ({
    nativeId: meta.nativeId,
    fields: meta.fields,
  })), [
    {
      nativeId: "0",
      fields: {
        source: "Vendor report",
        accessed: "2026-05-01",
        url: "https://example.com/report",
        doi: "10.1000/report",
      },
    },
  ]);
  assert.match(data.blockMetadata?.[0]?.anchorBookmarkNames?.[0] ?? "", /^n_cite1_/);
});

test("extractDocxReviewData reads bookmarked Word technical metadata", () => {
  const doc = parse(`# API

::api{id="core-api" name="Core API" version="v1" baseUrl="https://api.example.com" status="beta" owner="Platform"}
::

::endpoint{id="list-users" method="GET" path="/users" auth="token" status="draft" api="core-api"}
::

::parameter{id="limit-param" name="limit" location="query" type="number" required="false" default="25" values="10,25,50"}
::
`);

  const data = extractDocxReviewData(renderDocx(doc));

  assert.deepEqual(data.blockMetadata?.map((meta) => ({
    nativeId: meta.nativeId,
    fields: meta.fields,
  })), [
    {
      nativeId: "0",
      fields: {
        version: "v1",
        "base url": "https://api.example.com",
        status: "beta",
        owner: "Platform",
      },
    },
    {
      nativeId: "1",
      fields: {
        method: "GET",
        path: "/users",
        auth: "token",
        status: "draft",
        api: "core-api",
      },
    },
    {
      nativeId: "2",
      fields: {
        in: "query",
        type: "number",
        required: "false",
        default: "25",
        enum: "10,25,50",
      },
    },
  ]);
  assert.match(data.blockMetadata?.[0]?.anchorBookmarkNames?.[0] ?? "", /^n_core_api_/);
  assert.match(data.blockMetadata?.[1]?.anchorBookmarkNames?.[0] ?? "", /^n_list_users_/);
  assert.match(data.blockMetadata?.[2]?.anchorBookmarkNames?.[0] ?? "", /^n_limit_param_/);
});

test("extractDocxReviewData reads bookmarked Word computation metadata", () => {
  const doc = parse(`# Compute

::code_cell{id="cell1" lang="ts" runtime="node" status="draft" count=1}
1 + 1
::

::output{id="out1" cell="cell1" status="stale" mime="text/plain"}
2
::
`);

  const data = extractDocxReviewData(renderDocx(doc));

  assert.deepEqual(data.blockMetadata?.map((meta) => ({
    nativeId: meta.nativeId,
    fields: meta.fields,
  })), [
    {
      nativeId: "0",
      fields: {
        kernel: "node",
        status: "draft",
        execution: "1",
      },
    },
    {
      nativeId: "1",
      fields: {
        for: "cell1",
        status: "stale",
        mime: "text/plain",
      },
    },
  ]);
  assert.match(data.blockMetadata?.[0]?.anchorBookmarkNames?.[0] ?? "", /^n_cell1_/);
  assert.match(data.blockMetadata?.[1]?.anchorBookmarkNames?.[0] ?? "", /^n_out1_/);
});

test("extractDocxReviewData reads bookmarked Word computed metric metadata", () => {
  const doc = parse(`# Compute

::computed_metric{id="cm1" label="Revenue" formula="2 + 2" domain="x:0..2" suffix="M"}
::
`);

  const data = extractDocxReviewData(renderDocx(doc));

  assert.deepEqual(data.blockMetadata?.map((meta) => ({
    nativeId: meta.nativeId,
    fields: meta.fields,
  })), [
    {
      nativeId: "0",
      fields: {
        formula: "2 + 2",
        domain: "x:0..2",
        unit: "M",
      },
    },
  ]);
  assert.match(data.blockMetadata?.[0]?.anchorBookmarkNames?.[0] ?? "", /^n_cm1_/);
});

test("extractDocxReviewData reads bookmarked Word computed plot metadata", () => {
  const doc = parse(`# Compute

::computed_plot{id="cp1" label="Projection" formula="x * 2" domain="x:0..2" suffix="M"}
::
`);

  const data = extractDocxReviewData(renderDocx(doc));

  assert.deepEqual(data.blockMetadata?.map((meta) => ({
    nativeId: meta.nativeId,
    fields: meta.fields,
  })), [
    {
      nativeId: "0",
      fields: {
        formula: "x * 2",
        domain: "x:0..2",
        unit: "M",
      },
    },
  ]);
  assert.match(data.blockMetadata?.[0]?.anchorBookmarkNames?.[0] ?? "", /^n_cp1_/);
});

test("extractDocxReviewData reads bookmarked Word control metadata", () => {
  const doc = parse(`# Form

::control{id="growth" type="slider" min=0 max=20 step=1 default=8 label="Growth"}
::
`);

  const data = extractDocxReviewData(renderDocx(doc));

  assert.deepEqual(data.blockMetadata?.map((meta) => ({
    nativeId: meta.nativeId,
    fields: meta.fields,
  })), [
    {
      nativeId: "0",
      fields: {
        type: "slider",
        default: "8",
        min: "0",
        max: "20",
        step: "1",
      },
    },
  ]);
  assert.match(data.blockMetadata?.[0]?.anchorBookmarkNames?.[0] ?? "", /^n_growth_/);
});

test("extractDocxReviewData reads bookmarked Word memory metadata", () => {
  const doc = parse(`# Memory

::memory{id="m1" type="project" confidence=0.7 lastSeen="2026-05-01" scope="repo" source="brief" validUntil="2026-06-01" supersededBy="m2" expired}
Keep this.
::
`);

  const data = extractDocxReviewData(renderDocx(doc));

  assert.deepEqual(data.blockMetadata?.map((meta) => ({
    nativeId: meta.nativeId,
    fields: meta.fields,
  })), [
    {
      nativeId: "0",
      fields: {
        type: "project",
        confidence: "0.7",
        "last seen": "2026-05-01",
        scope: "repo",
        source: "brief",
        "valid until": "2026-06-01",
        "superseded by": "m2",
        expired: "true",
      },
    },
  ]);
  assert.match(data.blockMetadata?.[0]?.anchorBookmarkNames?.[0] ?? "", /^n_m1_/);
});

test("extractDocxReviewData reads native tracked revisions", () => {
  const doc = parse(`# Review

::claim{id="c1"}
Claim.
::

::change_request{id="cr1" target="c1" action="replace" from="old wording" to="new wording" author="Research" date="2026-05-24T09:30:00Z"}
Reason for the proposed edit.
::
`);

  const data = extractDocxReviewData(renderDocx(doc));

  assert.equal(data.revisions.length, 1);
  assert.deepEqual(
    data.revisions.map((revision) => ({
      nativeId: revision.nativeId,
      action: revision.action,
      targetId: revision.targetId,
      author: revision.author,
      date: revision.date,
      oldText: revision.oldText,
      newText: revision.newText,
    })),
    [
      {
        nativeId: "0/1",
        action: "replace",
        targetId: "c1",
        author: "Research",
        date: "2026-05-24T09:30:00Z",
        oldText: "old wording",
        newText: "new wording",
      },
    ],
  );
  assert.ok(data.revisions[0]?.sourceBookmarkNames?.some((name) => /^n_cr1_/.test(name)));
  assert.equal(data.footnotes.length, 0);
  assert.equal(data.endnotes.length, 0);
  assert.equal(data.tables.length, 0);
});

test("extractDocxReviewData reads rich source change request revisions", () => {
  const doc = parse(`# Review

::claim{id="c1"}
Claim.
::

::change_request{id="cr-rich" target="c1" action="replace" from="Old **claim** [source](https://example.com/old) and \`model\`." to="New *claim* [[c1]] and [source](https://example.com/new)." author="Research" date="2026-05-24T09:30:00Z"}
::
`);

  const data = extractDocxReviewData(renderDocx(doc));

  assert.equal(data.revisions.length, 1);
  assert.deepEqual({
    nativeId: data.revisions[0]?.nativeId,
    action: data.revisions[0]?.action,
    targetId: data.revisions[0]?.targetId,
    author: data.revisions[0]?.author,
    date: data.revisions[0]?.date,
    oldText: data.revisions[0]?.oldText,
    newText: data.revisions[0]?.newText,
  }, {
    nativeId: "0/1",
    action: "replace",
    targetId: "c1",
    author: "Research",
    date: "2026-05-24T09:30:00Z",
    oldText: "Old **claim** [source](https://example.com/old) and `model`.",
    newText: "New *claim* [[c1]] and [source](https://example.com/new).",
  });
  assert.ok(data.revisions[0]?.sourceBookmarkNames?.some((name) => /^n_cr_rich_/.test(name)));
});

test("extractDocxReviewData preserves rich tracked revision text", () => {
  const doc = parse(`# Review

::claim{id="c1"}
Claim.
::
`);

  const data = extractDocxReviewData(docxWithRichTrackedRevision(renderDocx(doc)));

  assert.equal(data.revisions.length, 1);
  assert.deepEqual({
    nativeId: data.revisions[0]?.nativeId,
    action: data.revisions[0]?.action,
    author: data.revisions[0]?.author,
    date: data.revisions[0]?.date,
    oldText: data.revisions[0]?.oldText,
    newText: data.revisions[0]?.newText,
  }, {
    nativeId: "70/71",
    action: "replace",
    author: "Reviewer",
    date: "2026-05-25T09:00:00Z",
    oldText: "Old **claim** [source](https://example.com/old).",
    newText: "New *claim* `model` and [[c1]].",
  });
  assert.ok(data.revisions[0]?.anchorBookmarkNames?.some((name) => /^n_c1_/.test(name)));
});

test("extractDocxReviewData merges split styled runs inside tracked revisions", () => {
  const data = extractDocxReviewData(storedDocx({
    "word/document.xml": `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p><w:bookmarkStart w:id="1" w:name="n_c1_12345678"/><w:bookmarkEnd w:id="1"/><w:del w:id="70" w:author="Reviewer" w:date="2026-05-25T09:00:00Z"><w:r><w:delText>Old </w:delText></w:r><w:r><w:rPr><w:b/></w:rPr><w:delText>Bo</w:delText></w:r><w:r><w:rPr><w:b/></w:rPr><w:delText>ld</w:delText></w:r></w:del><w:ins w:id="71" w:author="Reviewer" w:date="2026-05-25T09:00:00Z"><w:r><w:t>New </w:t></w:r><w:r><w:rPr><w:i/></w:rPr><w:t>em</w:t></w:r><w:r><w:rPr><w:i/></w:rPr><w:t>phasis</w:t></w:r></w:ins></w:p>
  </w:body>
</w:document>`,
  }));

  assert.deepEqual(data.revisions, [
    {
      nativeId: "70/71",
      action: "replace",
      anchorBookmarkNames: ["n_c1_12345678"],
      author: "Reviewer",
      date: "2026-05-25T09:00:00Z",
      oldText: "Old **Bold**",
      newText: "New *emphasis*",
    },
  ]);
});

test("extractDocxReviewData merges adjacent split tracked revisions with the same native ID", () => {
  const data = extractDocxReviewData(storedDocx({
    "word/document.xml": `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p><w:bookmarkStart w:id="1" w:name="n_c1_12345678"/><w:bookmarkEnd w:id="1"/><w:del w:id="70" w:author="Reviewer" w:date="2026-05-25T09:00:00Z"><w:r><w:delText>Old </w:delText></w:r></w:del><w:del w:id="70" w:author="Reviewer" w:date="2026-05-25T09:00:00Z"><w:r><w:rPr><w:b/></w:rPr><w:delText>claim</w:delText></w:r></w:del><w:ins w:id="71" w:author="Reviewer" w:date="2026-05-25T09:00:00Z"><w:r><w:t>New </w:t></w:r></w:ins><w:ins w:id="71" w:author="Reviewer" w:date="2026-05-25T09:00:00Z"><w:r><w:rPr><w:i/></w:rPr><w:t>claim</w:t></w:r></w:ins></w:p>
  </w:body>
</w:document>`,
  }));

  assert.deepEqual(data.revisions, [
    {
      nativeId: "70/71",
      action: "replace",
      anchorBookmarkNames: ["n_c1_12345678"],
      author: "Reviewer",
      date: "2026-05-25T09:00:00Z",
      oldText: "Old **claim**",
      newText: "New *claim*",
    },
  ]);
});

test("extractDocxReviewData groups multiple tracked replacement pairs in one paragraph", () => {
  const data = extractDocxReviewData(storedDocx({
    "word/document.xml": `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p><w:bookmarkStart w:id="1" w:name="n_c1_12345678"/><w:bookmarkEnd w:id="1"/><w:del w:id="70" w:author="Reviewer" w:date="2026-05-25T09:00:00Z"><w:r><w:delText>old first</w:delText></w:r></w:del><w:ins w:id="71" w:author="Reviewer" w:date="2026-05-25T09:00:00Z"><w:r><w:t>new first</w:t></w:r></w:ins><w:r><w:t> and </w:t></w:r><w:del w:id="72" w:author="Reviewer" w:date="2026-05-25T09:01:00Z"><w:r><w:delText>old second</w:delText></w:r></w:del><w:ins w:id="73" w:author="Reviewer" w:date="2026-05-25T09:01:00Z"><w:r><w:t>new second</w:t></w:r></w:ins></w:p>
  </w:body>
</w:document>`,
  }));

  assert.deepEqual(data.revisions, [
    {
      nativeId: "70/71",
      action: "replace",
      anchorBookmarkNames: ["n_c1_12345678"],
      author: "Reviewer",
      date: "2026-05-25T09:00:00Z",
      oldText: "old first",
      newText: "new first",
    },
    {
      nativeId: "72/73",
      action: "replace",
      anchorBookmarkNames: ["n_c1_12345678"],
      author: "Reviewer",
      date: "2026-05-25T09:01:00Z",
      oldText: "old second",
      newText: "new second",
    },
  ]);
});

test("extractDocxReviewData does not group delete and insert revisions separated by current text", () => {
  const data = extractDocxReviewData(storedDocx({
    "word/document.xml": `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p><w:bookmarkStart w:id="1" w:name="n_c1_12345678"/><w:bookmarkEnd w:id="1"/><w:del w:id="70" w:author="Reviewer" w:date="2026-05-25T09:00:00Z"><w:r><w:delText>delete here</w:delText></w:r></w:del><w:r><w:t> current text </w:t></w:r><w:ins w:id="71" w:author="Reviewer" w:date="2026-05-25T09:00:00Z"><w:r><w:t>insert later</w:t></w:r></w:ins></w:p>
  </w:body>
</w:document>`,
  }));

  assert.deepEqual(data.revisions, [
    {
      nativeId: "70",
      action: "delete",
      anchorBookmarkNames: ["n_c1_12345678"],
      author: "Reviewer",
      date: "2026-05-25T09:00:00Z",
      oldText: "delete here",
    },
    {
      nativeId: "71",
      action: "insert",
      anchorBookmarkNames: ["n_c1_12345678"],
      author: "Reviewer",
      date: "2026-05-25T09:00:00Z",
      newText: "insert later",
    },
  ]);
});

test("extractDocxReviewData reads native tracked move revisions", () => {
  const data = extractDocxReviewData(storedDocx({
    "word/document.xml": `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p><w:bookmarkStart w:id="1" w:name="n_c1_12345678"/><w:bookmarkEnd w:id="1"/><w:moveFrom w:id="80" w:author="Reviewer" w:date="2026-05-25T09:00:00Z"><w:r><w:delText>Original </w:delText></w:r><w:r><w:rPr><w:b/></w:rPr><w:delText>wording</w:delText></w:r></w:moveFrom><w:moveTo w:id="81" w:author="Reviewer" w:date="2026-05-25T09:00:00Z"><w:r><w:t>Moved </w:t></w:r><w:r><w:rPr><w:i/></w:rPr><w:t>wording</w:t></w:r></w:moveTo></w:p>
  </w:body>
</w:document>`,
  }));

  assert.deepEqual(data.revisions, [
    {
      nativeId: "80/81",
      action: "replace",
      anchorBookmarkNames: ["n_c1_12345678"],
      author: "Reviewer",
      date: "2026-05-25T09:00:00Z",
      oldText: "Original **wording**",
      newText: "Moved *wording*",
    },
  ]);
});

test("extractDocxReviewData reads range-marked tracked move revisions", () => {
  const data = extractDocxReviewData(storedDocx({
    "word/document.xml": `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p><w:bookmarkStart w:id="1" w:name="n_c1_12345678"/><w:bookmarkEnd w:id="1"/><w:moveFromRangeStart w:id="82" w:author="Reviewer" w:date="2026-05-25T09:00:00Z"/><w:r><w:delText>Original </w:delText></w:r><w:r><w:rPr><w:b/></w:rPr><w:delText>wording</w:delText></w:r><w:moveFromRangeEnd w:id="82"/><w:moveToRangeStart w:id="83" w:author="Reviewer" w:date="2026-05-25T09:00:00Z"/><w:r><w:t>Moved </w:t></w:r><w:r><w:rPr><w:i/></w:rPr><w:t>wording</w:t></w:r><w:moveToRangeEnd w:id="83"/></w:p>
  </w:body>
</w:document>`,
  }));

  assert.deepEqual(data.revisions, [
    {
      nativeId: "82/83",
      action: "replace",
      anchorBookmarkNames: ["n_c1_12345678"],
      author: "Reviewer",
      date: "2026-05-25T09:00:00Z",
      oldText: "Original **wording**",
      newText: "Moved *wording*",
    },
  ]);
});

test("extractDocxReviewData preserves self-closing tokens in tracked revision old text", () => {
  const data = extractDocxReviewData(storedDocx({
    "word/document.xml": `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p><w:bookmarkStart w:id="1" w:name="n_c1_12345678"/><w:bookmarkEnd w:id="1"/><w:del w:id="70" w:author="Reviewer" w:date="2026-05-25T09:00:00Z"><w:r><w:delText>Old</w:delText><w:br/><w:delText>claim</w:delText></w:r></w:del><w:ins w:id="71" w:author="Reviewer" w:date="2026-05-25T09:00:00Z"><w:r><w:t>New claim</w:t></w:r></w:ins></w:p>
  </w:body>
</w:document>`,
  }));

  assert.deepEqual(data.revisions, [
    {
      nativeId: "70/71",
      action: "replace",
      anchorBookmarkNames: ["n_c1_12345678"],
      author: "Reviewer",
      date: "2026-05-25T09:00:00Z",
      oldText: "Old\nclaim",
      newText: "New claim",
    },
  ]);
});

test("extractDocxReviewData maps header/footer comment and revision anchors", () => {
  const doc = parse(`::header
:::claim{id="header-claim"}
Header claim.
:::
::

::footer
:::claim{id="footer-claim"}
Footer claim.
:::
::
`);

  const data = extractDocxReviewData(docxWithHeaderCommentAndFooterRevision(renderDocx(doc)));

  assert.deepEqual(data.comments.map((comment) => ({
    nativeId: comment.nativeId,
    body: comment.body,
    author: comment.author,
  })), [
    {
      nativeId: "42",
      body: "Check the running header.",
      author: "Reviewer",
    },
  ]);
  assert.ok(data.comments[0]?.anchorBookmarkNames?.some((name) => /^n_header_claim_/.test(name)));
  assert.equal(data.revisions.length, 1);
  assert.deepEqual({
    nativeId: data.revisions[0]?.nativeId,
    action: data.revisions[0]?.action,
    author: data.revisions[0]?.author,
    date: data.revisions[0]?.date,
    oldText: data.revisions[0]?.oldText,
    newText: data.revisions[0]?.newText,
  }, {
    nativeId: "word/footer1.xml:50/51",
    action: "replace",
    author: "Reviewer",
    date: "2026-05-25T09:00:00Z",
    oldText: "Footer claim.",
    newText: "Footer claim updated.",
  });
  assert.ok(data.revisions[0]?.anchorBookmarkNames?.some((name) => /^n_footer_claim_/.test(name)));
});

test("extractDocxReviewData reads native footnotes and endnotes", () => {
  const doc = parse(`# Review

::claim{id="c1"}
Claim.
::

::footnote{id="fn1" for="c1"}
Footnote has **bold** context and [[c1]].
::

::endnote{id="en1" for="c1"}
Endnote has [source](https://example.com).
::
`);

  const data = extractDocxReviewData(renderDocx(doc));

  assert.deepEqual(data.footnotes.map((note) => ({ nativeId: note.nativeId, body: note.body })), [
    { nativeId: "1", body: "Footnote has **bold** context and [[c1]]." },
  ]);
  assert.match(data.footnotes[0]?.anchorBookmarkNames?.[0] ?? "", /^n_c1_/);
  assert.ok(data.footnotes[0]?.anchorBookmarkNames?.some((name) => /^n_fn1_/.test(name)));
  assert.deepEqual(data.endnotes.map((note) => ({ nativeId: note.nativeId, body: note.body })), [
    { nativeId: "1", body: "Endnote has [source](https://example.com)." },
  ]);
  assert.match(data.endnotes[0]?.anchorBookmarkNames?.[0] ?? "", /^n_c1_/);
  assert.ok(data.endnotes[0]?.anchorBookmarkNames?.some((name) => /^n_en1_/.test(name)));
});

test("extractDocxReviewData marks note bodies containing tracked revisions", () => {
  const doc = parse(`# Review

::claim{id="c1"}
Claim.
::

::footnote{id="fn1" for="c1"}
Original footnote.
::

::endnote{id="en1" for="c1"}
Original endnote.
::
`);

  const data = extractDocxReviewData(docxWithTrackedNoteBody(renderDocx(doc)));

  assert.equal(data.footnotes[0]?.body, "Edited footnote.");
  assert.equal(data.footnotes[0]?.hasRevisions, true);
  assert.equal(data.endnotes[0]?.body, "Edited endnote.");
  assert.equal(data.endnotes[0]?.hasRevisions, true);
});

test("extractDocxReviewData reads bookmarked native tables", () => {
  const doc = parse(`# Review

::table{id="metrics" header}
| Metric | Value |
| ARR | 10m |
| NRR | 120% |
::
`);

  const data = extractDocxReviewData(renderDocx(doc));

  assert.deepEqual(data.tables.map((table) => ({ nativeId: table.nativeId, header: table.header, rows: table.rows })), [
    {
      nativeId: "0",
      header: true,
      rows: [
        ["Metric", "Value"],
        ["ARR", "10m"],
        ["NRR", "120%"],
      ],
    },
  ]);
  assert.match(data.tables[0]?.anchorBookmarkNames?.[0] ?? "", /^n_metrics_/);
});

test("extractDocxReviewData reads native tables nested inside layout cells", () => {
  const doc = parse(`# Review

::grid{id="layout" columns=1}
:::card{id="card" title="Metrics"}
::::table{id="metrics" header}
| Metric | Value |
| ARR | 10m |
::::
:::
::
`);

  const data = extractDocxReviewData(renderDocx(doc));

  assert.deepEqual(data.tables.map((table) => ({ nativeId: table.nativeId, header: table.header, rows: table.rows })), [
    {
      nativeId: "0",
      header: true,
      rows: [
        ["Metric", "Value"],
        ["ARR", "10m"],
      ],
    },
  ]);
  assert.match(data.tables[0]?.anchorBookmarkNames?.[0] ?? "", /^n_metrics_/);
  assert.doesNotMatch(data.tables[0]?.anchorBookmarkNames?.[0] ?? "", /^n_layout_/);
  assert.doesNotMatch(data.tables[0]?.anchorBookmarkNames?.[0] ?? "", /^n_card_/);
});

test("extractDocxReviewData reads native dataset tables nested inside layout cells", () => {
  const doc = parse(`# Review

::grid{id="layout" columns=1}
:::card{id="card" title="Metrics"}
::::dataset{id="metrics" format="csv"}
Metric,Value
ARR,10m
::::
:::
::
`);

  const data = extractDocxReviewData(renderDocx(doc));

  assert.deepEqual(data.tables.map((table) => ({ nativeId: table.nativeId, header: table.header, rows: table.rows })), [
    {
      nativeId: "0",
      header: true,
      rows: [
        ["Metric", "Value"],
        ["ARR", "10m"],
      ],
    },
  ]);
  assert.match(data.tables[0]?.anchorBookmarkNames?.[0] ?? "", /^n_metrics_/);
  assert.doesNotMatch(data.tables[0]?.anchorBookmarkNames?.[0] ?? "", /^n_layout_/);
  assert.doesNotMatch(data.tables[0]?.anchorBookmarkNames?.[0] ?? "", /^n_card_/);
});

test("extractDocxReviewData maps nested layout table-cell review anchors to the table bookmark", () => {
  const doc = parse(`# Review

::grid{id="layout" columns=1}
:::card{id="card" title="Metrics"}
::::table{id="metrics" header}
| Metric | Value |
| ARR | 10m |
::::
:::
::
`);
  const entries = Object.fromEntries(
    [...readDocxZipEntries(renderDocx(doc))].map(([name, data]) => [name, data.toString("utf8")]),
  );
  const documentXml = entries["word/document.xml"];
  assert.ok(documentXml);
  const targetRun = /<w:r><w:t(?: xml:space="preserve")?>10m<\/w:t><\/w:r>/;
  assert.ok(targetRun.test(documentXml));
  entries["word/document.xml"] = documentXml.replace(
    targetRun,
    `<w:commentRangeStart w:id="42"/><w:del w:id="43" w:author="Reviewer" w:date="2026-05-25T09:00:00Z"><w:r><w:delText>10m</w:delText></w:r></w:del><w:ins w:id="44" w:author="Reviewer" w:date="2026-05-25T09:00:00Z"><w:r><w:t>11m</w:t></w:r></w:ins><w:r><w:footnoteReference w:id="9"/></w:r><w:r><w:endnoteReference w:id="10"/></w:r><w:commentRangeEnd w:id="42"/><w:r><w:commentReference w:id="42"/></w:r>`,
  );
  entries["word/comments.xml"] = `<w:comments xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:comment w:id="42" w:author="Reviewer" w:initials="R"><w:p><w:r><w:t>Check the ARR value.</w:t></w:r></w:p></w:comment>
</w:comments>`;
  entries["word/footnotes.xml"] = `<w:footnotes xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:footnote w:id="9"><w:p><w:r><w:t>Footnote on the ARR value.</w:t></w:r></w:p></w:footnote>
</w:footnotes>`;
  entries["word/endnotes.xml"] = `<w:endnotes xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:endnote w:id="10"><w:p><w:r><w:t>Endnote on the ARR value.</w:t></w:r></w:p></w:endnote>
</w:endnotes>`;

  const data = extractDocxReviewData(storedDocx(entries));

  const commentAnchor = data.comments[0]?.anchorBookmarkNames?.[0] ?? "";
  const footnoteAnchor = data.footnotes[0]?.anchorBookmarkNames?.[0] ?? "";
  const endnoteAnchor = data.endnotes[0]?.anchorBookmarkNames?.[0] ?? "";
  const revisionAnchor = data.revisions[0]?.anchorBookmarkNames?.[0] ?? "";
  assert.match(commentAnchor, /^n_metrics_/);
  assert.match(footnoteAnchor, /^n_metrics_/);
  assert.match(endnoteAnchor, /^n_metrics_/);
  assert.match(revisionAnchor, /^n_metrics_/);
  assert.doesNotMatch(commentAnchor, /^n_card_|^n_layout_/);
  assert.deepEqual(data.revisions.map((revision) => ({
    nativeId: revision.nativeId,
    action: revision.action,
    oldText: revision.oldText,
    newText: revision.newText,
  })), [
    { nativeId: "43/44", action: "replace", oldText: "10m", newText: "11m" },
  ]);
});

test("extractDocxReviewData maps nested layout dataset-cell review anchors to the dataset bookmark", () => {
  const doc = parse(`# Review

::grid{id="layout" columns=1}
:::card{id="card" title="Metrics"}
::::dataset{id="metrics" format="csv"}
Metric,Value
ARR,10m
::::
:::
::
`);
  const entries = Object.fromEntries(
    [...readDocxZipEntries(renderDocx(doc))].map(([name, data]) => [name, data.toString("utf8")]),
  );
  const documentXml = entries["word/document.xml"];
  assert.ok(documentXml);
  const targetRun = /<w:r><w:t(?: xml:space="preserve")?>10m<\/w:t><\/w:r>/;
  assert.ok(targetRun.test(documentXml));
  entries["word/document.xml"] = documentXml.replace(
    targetRun,
    `<w:commentRangeStart w:id="52"/><w:del w:id="53" w:author="Reviewer" w:date="2026-05-25T09:00:00Z"><w:r><w:delText>10m</w:delText></w:r></w:del><w:ins w:id="54" w:author="Reviewer" w:date="2026-05-25T09:00:00Z"><w:r><w:t>11m</w:t></w:r></w:ins><w:r><w:footnoteReference w:id="19"/></w:r><w:r><w:endnoteReference w:id="20"/></w:r><w:commentRangeEnd w:id="52"/><w:r><w:commentReference w:id="52"/></w:r>`,
  );
  entries["word/comments.xml"] = `<w:comments xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:comment w:id="52" w:author="Reviewer" w:initials="R"><w:p><w:r><w:t>Check the dataset value.</w:t></w:r></w:p></w:comment>
</w:comments>`;
  entries["word/footnotes.xml"] = `<w:footnotes xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:footnote w:id="19"><w:p><w:r><w:t>Footnote on the dataset value.</w:t></w:r></w:p></w:footnote>
</w:footnotes>`;
  entries["word/endnotes.xml"] = `<w:endnotes xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:endnote w:id="20"><w:p><w:r><w:t>Endnote on the dataset value.</w:t></w:r></w:p></w:endnote>
</w:endnotes>`;

  const data = extractDocxReviewData(storedDocx(entries));

  const commentAnchor = data.comments[0]?.anchorBookmarkNames?.[0] ?? "";
  const footnoteAnchor = data.footnotes[0]?.anchorBookmarkNames?.[0] ?? "";
  const endnoteAnchor = data.endnotes[0]?.anchorBookmarkNames?.[0] ?? "";
  const revisionAnchor = data.revisions[0]?.anchorBookmarkNames?.[0] ?? "";
  assert.match(commentAnchor, /^n_metrics_/);
  assert.match(footnoteAnchor, /^n_metrics_/);
  assert.match(endnoteAnchor, /^n_metrics_/);
  assert.match(revisionAnchor, /^n_metrics_/);
  assert.doesNotMatch(commentAnchor, /^n_card_|^n_layout_/);
  assert.deepEqual(data.revisions.map((revision) => ({
    nativeId: revision.nativeId,
    action: revision.action,
    oldText: revision.oldText,
    newText: revision.newText,
  })), [
    { nativeId: "53/54", action: "replace", oldText: "10m", newText: "11m" },
  ]);
});

test("extractDocxReviewData preserves rich body cells in bookmarked native tables", () => {
  const doc = parse(`# Review

::table{id="metrics" header}
| Metric | Value | Source |
| **ARR** | \`10m\` | [model](https://example.com/arr) |
::
`);

  const data = extractDocxReviewData(renderDocx(doc));

  assert.deepEqual(data.tables.map((table) => ({ nativeId: table.nativeId, header: table.header, rows: table.rows })), [
    {
      nativeId: "0",
      header: true,
      rows: [
        ["Metric", "Value", "Source"],
        ["**ARR**", "`10m`", "[model](https://example.com/arr)"],
      ],
    },
  ]);
});

test("extractDocxReviewData preserves rich header cells in bookmarked native tables", () => {
  const doc = parse(`# Review

::table{id="metrics" header}
| **Metric** | [Value](https://example.com/value) |
| ARR | 10m |
::
`);

  const data = extractDocxReviewData(renderDocx(doc));

  assert.deepEqual(data.tables.map((table) => ({ nativeId: table.nativeId, header: table.header, rows: table.rows })), [
    {
      nativeId: "0",
      header: true,
      rows: [
        ["**Metric**", "[Value](https://example.com/value)"],
        ["ARR", "10m"],
      ],
    },
  ]);
});

test("extractDocxReviewData reads bookmarked native tables after Word restyling", () => {
  const data = extractDocxReviewData(storedDocx({
    "word/document.xml": `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p><w:bookmarkStart w:id="1" w:name="n_metrics_12345678"/><w:bookmarkEnd w:id="1"/></w:p>
    <w:tbl>
      <w:tblPr><w:tblStyle w:val="LightShading"/></w:tblPr>
      <w:tr><w:trPr><w:tblHeader/></w:trPr><w:tc><w:p><w:r><w:t>Metric</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Value</w:t></w:r></w:p></w:tc></w:tr>
      <w:tr><w:tc><w:p><w:r><w:t>ARR</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>11m</w:t></w:r></w:p></w:tc></w:tr>
    </w:tbl>
  </w:body>
</w:document>`,
  }));

  assert.deepEqual(data.tables, [
    {
      nativeId: "0",
      anchorBookmarkNames: ["n_metrics_12345678"],
      header: true,
      rows: [
        ["Metric", "Value"],
        ["ARR", "11m"],
      ],
    },
  ]);
});

test("extractDocxReviewData keeps nested native table rows inside their parent cell", () => {
  const data = extractDocxReviewData(storedDocx({
    "word/document.xml": `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p><w:bookmarkStart w:id="1" w:name="n_metrics_12345678"/><w:bookmarkEnd w:id="1"/></w:p>
    <w:tbl>
      <w:tblPr><w:tblStyle w:val="TableGrid"/></w:tblPr>
      <w:tr><w:trPr><w:tblHeader/></w:trPr><w:tc><w:p><w:r><w:t>Metric</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Evidence</w:t></w:r></w:p></w:tc></w:tr>
      <w:tr>
        <w:tc><w:p><w:r><w:t>ARR</w:t></w:r></w:p></w:tc>
        <w:tc>
          <w:p><w:r><w:t>Summary</w:t></w:r></w:p>
          <w:tbl>
            <w:tr><w:tc><w:p><w:r><w:t>Low</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>High</w:t></w:r></w:p></w:tc></w:tr>
          </w:tbl>
          <w:p><w:r><w:t>Done</w:t></w:r></w:p>
        </w:tc>
      </w:tr>
    </w:tbl>
  </w:body>
</w:document>`,
  }));

  assert.deepEqual(data.tables, [
    {
      nativeId: "0",
      anchorBookmarkNames: ["n_metrics_12345678"],
      header: true,
      rows: [
        ["Metric", "Evidence"],
        ["ARR", "Summary\nLow\nHigh\nDone"],
      ],
    },
  ]);
});

test("extractDocxReviewData maps table-cell comments to the table bookmark", () => {
  const data = extractDocxReviewData(storedDocx({
    "word/document.xml": `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p><w:bookmarkStart w:id="1" w:name="n_metrics_12345678"/><w:bookmarkEnd w:id="1"/></w:p>
    <w:tbl>
      <w:tblPr><w:tblStyle w:val="TableGrid"/></w:tblPr>
      <w:tr><w:tc><w:p><w:r><w:t>Metric</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Value</w:t></w:r></w:p></w:tc></w:tr>
      <w:tr><w:tc><w:p><w:r><w:t>ARR</w:t></w:r></w:p></w:tc><w:tc><w:p><w:commentRangeStart w:id="7"/><w:r><w:t>10m</w:t></w:r><w:commentRangeEnd w:id="7"/><w:r><w:commentReference w:id="7"/></w:r></w:p></w:tc></w:tr>
    </w:tbl>
  </w:body>
</w:document>`,
    "word/comments.xml": `<w:comments xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:comment w:id="7" w:author="Reviewer" w:initials="R"><w:p><w:r><w:t>Check the ARR value.</w:t></w:r></w:p></w:comment>
</w:comments>`,
  }));

  assert.deepEqual(data.comments, [
    {
      nativeId: "7",
      anchorBookmarkNames: ["n_metrics_12345678"],
      author: "Reviewer",
      initials: "R",
      body: "Check the ARR value.",
    },
  ]);
  assert.deepEqual(data.tables[0]?.anchorBookmarkNames, ["n_metrics_12345678"]);
});

test("extractDocxReviewData maps point comments to the table bookmark", () => {
  const data = extractDocxReviewData(storedDocx({
    "word/document.xml": `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p><w:bookmarkStart w:id="1" w:name="n_metrics_12345678"/><w:bookmarkEnd w:id="1"/></w:p>
    <w:tbl>
      <w:tblPr><w:tblStyle w:val="TableGrid"/></w:tblPr>
      <w:tr><w:tc><w:p><w:r><w:t>Metric</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Value</w:t></w:r></w:p></w:tc></w:tr>
      <w:tr><w:tc><w:p><w:r><w:t>ARR</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>10m</w:t></w:r><w:r><w:commentReference w:id="7"/></w:r></w:p></w:tc></w:tr>
    </w:tbl>
  </w:body>
</w:document>`,
    "word/comments.xml": `<w:comments xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:comment w:id="7" w:author="Reviewer" w:initials="R"><w:p><w:r><w:t>Check the ARR value.</w:t></w:r></w:p></w:comment>
</w:comments>`,
  }));

  assert.deepEqual(data.comments, [
    {
      nativeId: "7",
      anchorBookmarkNames: ["n_metrics_12345678"],
      author: "Reviewer",
      initials: "R",
      body: "Check the ARR value.",
    },
  ]);
  assert.deepEqual(data.tables[0]?.anchorBookmarkNames, ["n_metrics_12345678"]);
});

test("extractDocxReviewData maps table-cell notes to the table bookmark", () => {
  const data = extractDocxReviewData(storedDocx({
    "word/document.xml": `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p><w:bookmarkStart w:id="1" w:name="n_metrics_12345678"/><w:bookmarkEnd w:id="1"/></w:p>
    <w:tbl>
      <w:tblPr><w:tblStyle w:val="TableGrid"/></w:tblPr>
      <w:tr><w:tc><w:p><w:r><w:t>Metric</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Value</w:t></w:r></w:p></w:tc></w:tr>
      <w:tr><w:tc><w:p><w:r><w:t>ARR</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>10m</w:t></w:r><w:r><w:footnoteReference w:id="3"/></w:r><w:r><w:endnoteReference w:id="4"/></w:r></w:p></w:tc></w:tr>
    </w:tbl>
  </w:body>
</w:document>`,
    "word/footnotes.xml": `<w:footnotes xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:footnote w:id="3"><w:p><w:r><w:t>Footnote on the ARR cell.</w:t></w:r></w:p></w:footnote>
</w:footnotes>`,
    "word/endnotes.xml": `<w:endnotes xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:endnote w:id="4"><w:p><w:r><w:t>Endnote on the ARR cell.</w:t></w:r></w:p></w:endnote>
</w:endnotes>`,
  }));

  assert.deepEqual(data.footnotes, [
    {
      nativeId: "3",
      anchorBookmarkNames: ["n_metrics_12345678"],
      body: "Footnote on the ARR cell.",
    },
  ]);
  assert.deepEqual(data.endnotes, [
    {
      nativeId: "4",
      anchorBookmarkNames: ["n_metrics_12345678"],
      body: "Endnote on the ARR cell.",
    },
  ]);
});

test("extractDocxReviewData maps table-cell revisions to the table bookmark", () => {
  const data = extractDocxReviewData(storedDocx({
    "word/document.xml": `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p><w:bookmarkStart w:id="1" w:name="n_metrics_12345678"/><w:bookmarkEnd w:id="1"/></w:p>
    <w:tbl>
      <w:tblPr><w:tblStyle w:val="TableGrid"/></w:tblPr>
      <w:tr><w:tc><w:p><w:r><w:t>Metric</w:t></w:r></w:p></w:tc><w:tc><w:p><w:r><w:t>Value</w:t></w:r></w:p></w:tc></w:tr>
      <w:tr><w:tc><w:p><w:r><w:t>ARR</w:t></w:r></w:p></w:tc><w:tc><w:p><w:del w:id="5" w:author="Reviewer" w:date="2026-05-25T09:00:00Z"><w:r><w:delText>10m</w:delText></w:r></w:del><w:ins w:id="6" w:author="Reviewer" w:date="2026-05-25T09:00:00Z"><w:r><w:t>11m</w:t></w:r></w:ins></w:p></w:tc></w:tr>
    </w:tbl>
  </w:body>
</w:document>`,
  }));

  assert.deepEqual(data.revisions, [
    {
      nativeId: "5/6",
      action: "replace",
      anchorBookmarkNames: ["n_metrics_12345678"],
      author: "Reviewer",
      date: "2026-05-25T09:00:00Z",
      oldText: "10m",
      newText: "11m",
    },
  ]);
  assert.equal(data.tables[0]?.hasRevisions, true);
  assert.deepEqual(data.tables[0]?.rows, [
    ["Metric", "Value"],
    ["ARR", "11m"],
  ]);
});

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

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
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

function addDocumentRelationship(xml: string | undefined, id: string, target: string): string {
  const rel = `  <Relationship Id="${id}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="${target}" TargetMode="External"/>\n`;
  const source = xml ?? `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">\n</Relationships>`;
  return source.includes(`Id="${id}"`) ? source : source.replace("</Relationships>", `${rel}</Relationships>`);
}
