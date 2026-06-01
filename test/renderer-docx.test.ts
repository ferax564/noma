import { test } from "node:test";
import assert from "node:assert/strict";
import { parse } from "../src/parser.js";
import { renderDocx } from "../src/renderer-docx.js";

function storedZipEntries(buffer: Buffer): Map<string, string> {
  return new Map([...storedZipEntryBuffers(buffer)].map(([name, data]) => [name, data.toString("utf8")]));
}

function storedZipEntryBuffers(buffer: Buffer): Map<string, Buffer> {
  const buffers = new Map<string, Buffer>();
  let offset = 0;
  while (offset + 30 <= buffer.length && buffer.readUInt32LE(offset) === 0x04034b50) {
    const method = buffer.readUInt16LE(offset + 8);
    const size = buffer.readUInt32LE(offset + 18);
    const nameLen = buffer.readUInt16LE(offset + 26);
    const extraLen = buffer.readUInt16LE(offset + 28);
    const nameStart = offset + 30;
    const dataStart = nameStart + nameLen + extraLen;
    const dataEnd = dataStart + size;
    const name = buffer.subarray(nameStart, nameStart + nameLen).toString("utf8");
    assert.equal(method, 0, `expected stored ZIP entry for ${name}`);
    buffers.set(name, buffer.subarray(dataStart, dataEnd));
    offset = dataEnd;
  }
  return buffers;
}

test("renderDocx emits a WordprocessingML package with structure and links", () => {
  const source = [
    `# Spec {id="spec"}`,
    "",
    `::page_setup{size="A4" orientation="landscape" margin="12mm" margin_left="20mm" header_margin="10mm" footer_margin="11mm"}`,
    "::",
    "",
    `::header{id="doc-header"}`,
    "Committee draft",
    "::",
    "",
    `::toc{id="toc" depth=2}`,
    "::",
    "",
    "See **bold**, *em*, `code`, [site](https://example.com), and [[spec]].",
    "",
    `## Details {id="details"}`,
    "",
    "Section body.",
    "",
    "- first",
    "- second",
    "",
    "| A | B |",
    "| --- | --- |",
    "| x | y |",
    "",
    `::claim{id="c1" confidence=0.8}`,
    "Claim body.",
    "::",
    "",
    `::change_request{id="cr1" action="replace" target="c1" from="old claim wording" to="new claim wording" author="Andrea Ferrarelli" date="2026-05-24T09:30:00Z"}`,
    "Reason for the requested wording change.",
    "::",
    "",
    `::footnote{id="fn1" label="1"}`,
    "Footnote body for committee context.",
    "::",
    "",
    `::pagebreak{id="break-before-sources"}`,
    "::",
    "",
    `::comment{id="comment1" parent="c1" author="Andrea Ferrarelli" date="2026-05-24T09:00:00Z" status="resolved" resolved_by="Research" resolved_at="2026-05-24T10:00:00Z"}`,
    "Tighten this claim before sending the Word handoff.",
    "::",
    "",
    `::citation{id="source1" source="Briefing" url="https://source.example/report" doi="10.5555/noma" accessed="2026-05-24"}`,
    "Source note.",
    "::",
    "",
    `::bibliography{id="refs"}`,
    "::",
    "",
    `::footer{id="doc-footer" page_numbers total_pages}`,
    "Noma handoff",
    "::",
    "",
  ].join("\n");
  const doc = parse(source);
  const docx = renderDocx(doc, { title: "Spec" });
  assert.equal(docx.subarray(0, 4).toString("binary"), "PK\u0003\u0004");

  const entries = storedZipEntries(docx);
  assert.ok(entries.has("[Content_Types].xml"));
  assert.ok(entries.has("word/document.xml"));
  assert.ok(entries.has("word/header1.xml"));
  assert.ok(entries.has("word/footer1.xml"));
  assert.ok(entries.has("word/comments.xml"));
  assert.ok(entries.has("word/footnotes.xml"));
  assert.ok(entries.has("word/styles.xml"));
  assert.ok(entries.has("word/numbering.xml"));
  assert.ok(entries.has("word/settings.xml"));

  const documentXml = entries.get("word/document.xml") ?? "";
  assert.match(documentXml, /<w:pStyle w:val="Heading1"\/>/);
  assert.match(documentXml, /<w:headerReference w:type="default" r:id="rId3"\/>/);
  assert.match(documentXml, /<w:footerReference w:type="default" r:id="rId4"\/>/);
  assert.match(documentXml, /<w:pgSz w:w="16838" w:h="11906" w:orient="landscape"\/>/);
  assert.match(documentXml, /<w:pgMar w:top="680" w:right="680" w:bottom="680" w:left="1134" w:header="567" w:footer="624" w:gutter="0"\/>/);
  assert.match(documentXml, /<w:bookmarkStart w:id="1" w:name="n_spec_/);
  assert.match(documentXml, /Contents/);
  assert.match(documentXml, /<w:pStyle w:val="NomaToc"\/>/);
  assert.match(documentXml, /w:anchor="n_details_/);
  assert.match(documentXml, /<w:tab w:val="right" w:leader="dot" w:pos="15024"\/>/);
  assert.match(documentXml, /<w:tab\/>/);
  assert.match(documentXml, /<w:instrText xml:space="preserve"> PAGEREF n_details_[^ ]+ \\h <\/w:instrText>/);
  assert.match(documentXml, /<w:ind w:left="360"\/>/);
  assert.match(documentXml, /<w:b\/>/);
  assert.match(documentXml, /<w:i\/>/);
  assert.match(documentXml, /Courier New/);
  assert.match(documentXml, /<w:numId w:val="1"\/>/);
  assert.match(documentXml, /<w:tbl>/);
  assert.match(documentXml, /Claim \(confidence=0\.8\)/);
  assert.match(documentXml, /w:color="548D57"/);
  assert.match(documentXml, /w:fill="F1F6EF"/);
  assert.match(documentXml, /Change request: replace c1/);
  assert.match(documentXml, /<w:del w:id="0" w:author="Andrea Ferrarelli" w:date="2026-05-24T09:30:00Z">/);
  assert.match(documentXml, /<w:delText xml:space="preserve">old claim wording<\/w:delText>/);
  assert.match(documentXml, /<w:ins w:id="1" w:author="Andrea Ferrarelli" w:date="2026-05-24T09:30:00Z">/);
  assert.match(documentXml, /<w:t xml:space="preserve">new claim wording<\/w:t>/);
  assert.match(documentXml, /Reason for the requested wording change\./);
  assert.match(documentXml, /<w:footnoteReference w:id="1"\/>/);
  assert.match(documentXml, /w:name="n_fn1_/);
  assert.match(documentXml, /<w:br w:type="page"\/>/);
  assert.match(documentXml, /w:name="n_break_before_sources_/);
  assert.match(documentXml, /<w:commentRangeStart w:id="0"\/>[\s\S]*Claim \(confidence=0\.8\)[\s\S]*<w:commentRangeEnd w:id="0"\/>/);
  assert.match(documentXml, /<w:commentReference w:id="0"\/>/);
  assert.match(documentXml, /w:name="n_comment1_/);
  assert.doesNotMatch(documentXml, /Comment on c1/);
  assert.match(documentXml, /Citation: Briefing/);
  assert.match(documentXml, /Accessed: 2026-05-24/);
  assert.match(documentXml, /Bibliography/);
  assert.match(documentXml, /Briefing - Source note\./);
  assert.match(documentXml, /w:anchor="n_spec_/);

  const rels = entries.get("word/_rels/document.xml.rels") ?? "";
  assert.match(rels, /Type="http:\/\/schemas\.openxmlformats\.org\/officeDocument\/2006\/relationships\/header" Target="header1\.xml"/);
  assert.match(rels, /Type="http:\/\/schemas\.openxmlformats\.org\/officeDocument\/2006\/relationships\/footer" Target="footer1\.xml"/);
  assert.match(rels, /Type="http:\/\/schemas\.openxmlformats\.org\/officeDocument\/2006\/relationships\/comments" Target="comments\.xml"/);
  assert.match(rels, /Type="http:\/\/schemas\.microsoft\.com\/office\/2011\/relationships\/commentsExtended" Target="commentsExtended\.xml"/);
  assert.match(rels, /Type="http:\/\/schemas\.openxmlformats\.org\/officeDocument\/2006\/relationships\/footnotes" Target="footnotes\.xml"/);
  assert.match(rels, /Type="http:\/\/schemas\.openxmlformats\.org\/officeDocument\/2006\/relationships\/settings" Target="settings\.xml"/);
  assert.match(rels, /Target="https:\/\/example\.com" TargetMode="External"/);
  assert.match(rels, /Target="https:\/\/source\.example\/report" TargetMode="External"/);
  assert.match(rels, /Target="https:\/\/doi\.org\/10\.5555\/noma" TargetMode="External"/);

  const contentTypes = entries.get("[Content_Types].xml") ?? "";
  assert.match(contentTypes, /PartName="\/word\/header1\.xml"/);
  assert.match(contentTypes, /PartName="\/word\/footer1\.xml"/);
  assert.match(contentTypes, /PartName="\/word\/comments\.xml"/);
  assert.match(contentTypes, /PartName="\/word\/commentsExtended\.xml" ContentType="application\/vnd\.openxmlformats-officedocument\.wordprocessingml\.commentsExtended\+xml"/);
  assert.match(contentTypes, /PartName="\/word\/footnotes\.xml"/);
  assert.match(contentTypes, /PartName="\/word\/settings\.xml" ContentType="application\/vnd\.openxmlformats-officedocument\.wordprocessingml\.settings\+xml"/);

  const settings = entries.get("word/settings.xml") ?? "";
  assert.match(settings, /<w:updateFields w:val="true"\/>/);
  assert.match(settings, /<w:revisionView w:markup="1" w:comments="1" w:insDel="1" w:formatting="0"\/>/);

  const header = entries.get("word/header1.xml") ?? "";
  assert.match(header, /<w:hdr /);
  assert.match(header, /Committee draft/);
  assert.match(header, /w:name="n_doc_header_/);

  const footer = entries.get("word/footer1.xml") ?? "";
  assert.match(footer, /<w:ftr /);
  assert.match(footer, /Noma handoff/);
  assert.match(footer, /<w:instrText xml:space="preserve"> PAGE <\/w:instrText>/);
  assert.match(footer, /<w:instrText xml:space="preserve"> NUMPAGES <\/w:instrText>/);

  const comments = entries.get("word/comments.xml") ?? "";
  assert.match(comments, /<w:comment w:id="0" w:author="Andrea Ferrarelli" w:initials="AF" w:date="2026-05-24T09:00:00Z">/);
  assert.match(comments, /<w:p w15:paraId="00000001">/);
  assert.match(comments, /<w:annotationRef\/>/);
  assert.match(comments, /Status: resolved; resolved by Research; resolved at 2026-05-24T10:00:00Z/);
  assert.match(comments, /Tighten this claim before sending the Word handoff\./);

  const commentsExtended = entries.get("word/commentsExtended.xml") ?? "";
  assert.match(commentsExtended, /<w15:commentsEx xmlns:w15="http:\/\/schemas\.microsoft\.com\/office\/word\/2012\/wordml">/);
  assert.match(commentsExtended, /<w15:commentEx w15:paraId="00000001" w15:done="1"\/>/);

  const footnotes = entries.get("word/footnotes.xml") ?? "";
  assert.match(footnotes, /<w:footnote w:id="-1" w:type="separator">/);
  assert.match(footnotes, /<w:footnote w:id="1">/);
  assert.match(footnotes, /<w:footnoteRef\/>/);
  assert.match(footnotes, /Footnote body for committee context\./);
});

test("renderDocx preserves rich Markdown inside hyperlink labels", () => {
  const doc = parse(`# Details {id="details"}

Plain ***combined style***. See [**external note**](https://example.com/source), [*details*](#details), [\`mail\`](mailto:team@example.com), [***critical note***](https://example.com/critical), [\\[source\\]](https://example.com/bracket), and **[wrapped external](https://example.com/wrapped)**.
`);
  const docx = renderDocx(doc);
  const entries = storedZipEntries(docx);
  const documentXml = entries.get("word/document.xml") ?? "";
  const rels = entries.get("word/_rels/document.xml.rels") ?? "";

  assert.match(documentXml, /<w:b\/><w:i\/>[\s\S]*?<w:t xml:space="preserve">combined style<\/w:t>/);
  assert.match(documentXml, /<w:hyperlink r:id="rId\d+" w:history="1">[\s\S]*?<w:b\/>[\s\S]*?<w:t xml:space="preserve">external note<\/w:t>[\s\S]*?<\/w:hyperlink>/);
  assert.match(documentXml, /<w:hyperlink w:anchor="n_details_[^"]+">[\s\S]*?<w:i\/>[\s\S]*?<w:t xml:space="preserve">details<\/w:t>[\s\S]*?<\/w:hyperlink>/);
  assert.match(documentXml, /<w:hyperlink r:id="rId\d+" w:history="1">[\s\S]*?Courier New[\s\S]*?<w:t xml:space="preserve">mail<\/w:t>[\s\S]*?<\/w:hyperlink>/);
  assert.match(documentXml, /<w:hyperlink r:id="rId\d+" w:history="1">[\s\S]*?<w:b\/><w:i\/>[\s\S]*?<w:t xml:space="preserve">critical note<\/w:t>[\s\S]*?<\/w:hyperlink>/);
  assert.match(documentXml, /<w:hyperlink r:id="rId\d+" w:history="1">[\s\S]*?<w:t xml:space="preserve">\[source\]<\/w:t>[\s\S]*?<\/w:hyperlink>/);
  assert.match(documentXml, /<w:hyperlink r:id="rId\d+" w:history="1">[\s\S]*?<w:b\/>[\s\S]*?<w:t xml:space="preserve">wrapped external<\/w:t>[\s\S]*?<\/w:hyperlink>/);
  assert.doesNotMatch(documentXml, /\*\*\*combined style\*\*\*/);
  assert.doesNotMatch(documentXml, /\*\*external note\*\*/);
  assert.doesNotMatch(documentXml, /\*details\*/);
  assert.doesNotMatch(documentXml, /`mail`/);
  assert.doesNotMatch(documentXml, /\*\*\*critical note\*\*\*/);
  assert.doesNotMatch(documentXml, /\\\[source\\\]/);
  assert.doesNotMatch(documentXml, /\*\*\[wrapped external\]/);
  assert.match(rels, /Target="https:\/\/example\.com\/source" TargetMode="External"/);
  assert.match(rels, /Target="mailto:team@example\.com" TargetMode="External"/);
  assert.match(rels, /Target="https:\/\/example\.com\/critical" TargetMode="External"/);
  assert.match(rels, /Target="https:\/\/example\.com\/bracket" TargetMode="External"/);
  assert.match(rels, /Target="https:\/\/example\.com\/wrapped" TargetMode="External"/);
});

test("renderDocx renders escaped table pipes as visible pipes outside code spans", () => {
  const source = `::table{id="pipe-table" header}
| Label | Link | Code |
| A\\|B | [C\\|D](https://example.com/pipe) | \`x\\|y\` |
::
`;

  const entries = storedZipEntries(renderDocx(parse(source)));
  const documentXml = entries.get("word/document.xml") ?? "";

  assert.match(documentXml, /<w:t xml:space="preserve">A\|B<\/w:t>/);
  assert.match(documentXml, /<w:hyperlink r:id="rId\d+" w:history="1">[\s\S]*?<w:t xml:space="preserve">C\|D<\/w:t>[\s\S]*?<\/w:hyperlink>/);
  assert.match(documentXml, /<w:t xml:space="preserve">x\\\|y<\/w:t>/);
});

test("renderDocx stores header and footer hyperlinks in part-local relationships", () => {
  const doc = parse(`# Linked section {id="linked"}

::header{id="linked-header"}
Header **bold** [header link](https://header.example/report) and [[linked]].
::

::footer{id="linked-footer"}
Footer *emphasis* [footer link](https://footer.example/report) and \`code\`.
::

Body.
`);
  const docx = renderDocx(doc);
  const entries = storedZipEntries(docx);
  const documentRels = entries.get("word/_rels/document.xml.rels") ?? "";
  const header = entries.get("word/header1.xml") ?? "";
  const headerRels = entries.get("word/_rels/header1.xml.rels") ?? "";
  const footer = entries.get("word/footer1.xml") ?? "";
  const footerRels = entries.get("word/_rels/footer1.xml.rels") ?? "";

  assert.match(header, /xmlns:r="http:\/\/schemas\.openxmlformats\.org\/officeDocument\/2006\/relationships"/);
  assert.match(header, /<w:b\/>[\s\S]*<w:t xml:space="preserve">bold<\/w:t>/);
  assert.match(header, /<w:hyperlink r:id="rId1" w:history="1">[\s\S]*header link/);
  assert.match(header, /<w:hyperlink w:anchor="n_linked_/);
  assert.match(headerRels, /Target="https:\/\/header\.example\/report" TargetMode="External"/);

  assert.match(footer, /<w:i\/>[\s\S]*<w:t xml:space="preserve">emphasis<\/w:t>/);
  assert.match(footer, /Courier New[\s\S]*<w:t xml:space="preserve">code<\/w:t>/);
  assert.match(footer, /<w:hyperlink r:id="rId1" w:history="1">[\s\S]*footer link/);
  assert.match(footerRels, /Target="https:\/\/footer\.example\/report" TargetMode="External"/);

  assert.doesNotMatch(documentRels, /header\.example/);
  assert.doesNotMatch(documentRels, /footer\.example/);
});

test("renderDocx writes native Word document protection settings", () => {
  const doc = parse(`# Review Form {id="review-form"}

::doc_protection{id="form-protection"}
::

::control{id="review-date" type="date" default="2026-05-24" label="Review date"}
::
`);
  const docx = renderDocx(doc);
  const entries = storedZipEntries(docx);
  const settings = entries.get("word/settings.xml") ?? "";
  const rels = entries.get("word/_rels/document.xml.rels") ?? "";
  const contentTypes = entries.get("[Content_Types].xml") ?? "";
  const documentXml = entries.get("word/document.xml") ?? "";

  assert.match(settings, /<w:documentProtection w:edit="forms" w:enforcement="1"\/>/);
  assert.match(rels, /Type="http:\/\/schemas\.openxmlformats\.org\/officeDocument\/2006\/relationships\/settings" Target="settings\.xml"/);
  assert.match(contentTypes, /PartName="\/word\/settings\.xml" ContentType="application\/vnd\.openxmlformats-officedocument\.wordprocessingml\.settings\+xml"/);
  assert.match(documentXml, /noma-control:review-date/);
  assert.doesNotMatch(documentXml, /doc_protection/);
  assert.doesNotMatch(documentXml, /Doc protection/);
});

test("renderDocx writes frontmatter metadata into DOCX core properties", () => {
  const doc = parse(`---
title: Metadata Report
author: ferax564
description: Word package metadata survives.
tags: [word, handoff, agents]
status: draft
profile: research
---

# Metadata Report

Body.
`);
  const docx = renderDocx(doc);
  const core = storedZipEntries(docx).get("docProps/core.xml") ?? "";

  assert.match(core, /<dc:title>Metadata Report<\/dc:title>/);
  assert.match(core, /<dc:subject>Word package metadata survives\.<\/dc:subject>/);
  assert.match(core, /<dc:description>Word package metadata survives\.<\/dc:description>/);
  assert.match(core, /<dc:creator>ferax564<\/dc:creator>/);
  assert.match(core, /<cp:lastModifiedBy>ferax564<\/cp:lastModifiedBy>/);
  assert.match(core, /<cp:keywords>word, handoff, agents<\/cp:keywords>/);
  assert.match(core, /<cp:category>profile: research<\/cp:category>/);
  assert.match(core, /<cp:contentStatus>draft<\/cp:contentStatus>/);
});

test("renderDocx preserves comment replies as native Word comment threads", () => {
  const doc = parse(`::claim{id="c1"}
Claim body.
::

::comment{id="comment-parent" parent="c1" author="Andrea" date="2026-05-24T09:00:00Z"}
Check the confidence.
::

::comment{id="comment-reply" reply_to="comment-parent" author="Research" date="2026-05-24T09:30:00Z" status="resolved" resolved_by="Andrea" resolved_at="2026-05-24T10:00:00Z"}
Confirmed with the latest source.
::
`);
  const docx = renderDocx(doc);
  const entries = storedZipEntries(docx);
  const documentXml = entries.get("word/document.xml") ?? "";
  const comments = entries.get("word/comments.xml") ?? "";
  const commentsExtended = entries.get("word/commentsExtended.xml") ?? "";

  assert.match(documentXml, /<w:commentRangeStart w:id="0"\/>[\s\S]*Claim[\s\S]*<w:commentReference w:id="0"\/>/);
  assert.doesNotMatch(documentXml, /<w:commentRangeStart w:id="1"\/>/);
  assert.doesNotMatch(documentXml, /Comment on comment-parent/);
  assert.doesNotMatch(documentXml, /Confirmed with the latest source/);

  assert.match(comments, /<w:comment w:id="0" w:author="Andrea" w:initials="A" w:date="2026-05-24T09:00:00Z">/);
  assert.match(comments, /<w:p w15:paraId="00000001">/);
  assert.match(comments, /Check the confidence\./);
  assert.match(comments, /<w:comment w:id="1" w:author="Research" w:initials="R" w:date="2026-05-24T09:30:00Z">/);
  assert.match(comments, /<w:p w15:paraId="00000002">/);
  assert.match(comments, /Status: resolved; resolved by Andrea; resolved at 2026-05-24T10:00:00Z/);
  assert.match(comments, /Confirmed with the latest source\./);

  assert.match(commentsExtended, /<w15:commentEx w15:paraId="00000001" w15:done="0"\/>/);
  assert.match(commentsExtended, /<w15:commentEx w15:paraId="00000002" w15:paraIdParent="00000001" w15:done="1"\/>/);
});

test("renderDocx does not resurrect deleted comments as native Word comments", () => {
  const doc = parse(`::claim{id="c1"}
Claim body.
::

::comment{id="comment-deleted" parent="c1" author="Andrea" status="deleted"}
Removed during Word review.
::
`);
  const docx = renderDocx(doc);
  const entries = storedZipEntries(docx);
  const documentXml = entries.get("word/document.xml") ?? "";

  assert.equal(entries.has("word/comments.xml"), false);
  assert.doesNotMatch(documentXml, /commentRangeStart/);
  assert.doesNotMatch(documentXml, /Removed during Word review/);
});

test("renderDocx does not orphan replies to deleted comments", () => {
  const doc = parse(`::claim{id="c1"}
Claim body.
::

::comment{id="comment-deleted" parent="c1" author="Andrea" status="deleted"}
Removed during Word review.
::

::comment{id="comment-reply" reply_to="comment-deleted" author="Research"}
Do not re-export as a standalone Word comment.
::

::comment{id="comment-reply-child" reply_to="comment-reply" author="Research"}
Do not resurrect the deleted thread through a nested reply.
::
`);
  const docx = renderDocx(doc);
  const entries = storedZipEntries(docx);
  const documentXml = entries.get("word/document.xml") ?? "";

  assert.equal(entries.has("word/comments.xml"), false);
  assert.equal(entries.has("word/commentsExtended.xml"), false);
  assert.equal(entries.has("word/settings.xml"), false);
  assert.doesNotMatch(documentXml, /commentRangeStart/);
  assert.doesNotMatch(documentXml, /Do not re-export/);
  assert.doesNotMatch(documentXml, /Do not resurrect/);
});

test("renderDocx does not resurrect deleted notes as native Word notes", () => {
  const doc = parse(`::claim{id="c1"}
Claim body.
::

::footnote{id="fn-deleted" for="c1" status="deleted"}
Removed footnote.
::

::endnote{id="en-deleted" for="c1" status="withdrawn"}
Removed endnote.
::
`);
  const docx = renderDocx(doc);
  const entries = storedZipEntries(docx);
  const documentXml = entries.get("word/document.xml") ?? "";

  assert.equal(entries.has("word/footnotes.xml"), false);
  assert.equal(entries.has("word/endnotes.xml"), false);
  assert.doesNotMatch(documentXml, /footnoteReference/);
  assert.doesNotMatch(documentXml, /endnoteReference/);
  assert.doesNotMatch(documentXml, /Removed footnote/);
  assert.doesNotMatch(documentXml, /Removed endnote/);
});

test("renderDocx anchors targeted change requests beside the reviewed block", () => {
  const doc = parse(`::claim{id="c1"}
Claim body.
::

::evidence{id="e1" for="c1"}
Evidence body.
::

::change_request{id="cr1" target="c1" action="replace" from="old wording" to="new wording" author="Research" date="2026-05-24T09:30:00Z"}
Reason for the proposed edit.
::
`);
  const docx = renderDocx(doc);
  const entries = storedZipEntries(docx);
  const documentXml = entries.get("word/document.xml") ?? "";
  const comments = entries.get("word/comments.xml") ?? "";
  const settings = entries.get("word/settings.xml") ?? "";

  assert.match(documentXml, /<w:commentRangeStart w:id="0"\/>[\s\S]*Claim[\s\S]*<w:commentRangeEnd w:id="0"\/>[\s\S]*<w:commentReference w:id="0"\/>/);
  assert.equal(documentXml.match(/Change request: replace c1/g)?.length, 1);
  assert.ok(documentXml.indexOf("Claim") < documentXml.indexOf("Change request: replace c1"));
  assert.ok(documentXml.indexOf("Change request: replace c1") < documentXml.indexOf("Evidence"));
  assert.match(documentXml, /w:name="n_cr1_/);
  assert.match(documentXml, /<w:del w:id="0" w:author="Research" w:date="2026-05-24T09:30:00Z">/);
  assert.match(documentXml, /<w:ins w:id="1" w:author="Research" w:date="2026-05-24T09:30:00Z">/);

  assert.match(comments, /<w:comment w:id="0" w:author="Research" w:initials="R" w:date="2026-05-24T09:30:00Z">/);
  assert.match(comments, /Change request: replace c1/);
  assert.match(comments, /From: old wording/);
  assert.match(comments, /To: new wording/);
  assert.match(comments, /Note: Reason for the proposed edit\./);

  assert.ok(entries.has("word/settings.xml"));
  assert.match(settings, /<w:revisionView w:markup="1" w:comments="1" w:insDel="1" w:formatting="0"\/>/);
  assert.doesNotMatch(settings, /<w:updateFields/);
});

test("renderDocx preserves rich inline content in tracked change requests", () => {
  const doc = parse(`::claim{id="c1"}
Claim body.
::

::change_request{id="cr-rich" target="c1" action="replace" from="Old **claim** [source](https://example.com/old) and \`model\`." to="New *claim* [[c1]] and [source](https://example.com/new)." author="Research" date="2026-05-24T09:30:00Z"}
::
`);
  const docx = renderDocx(doc);
  const entries = storedZipEntries(docx);
  const documentXml = entries.get("word/document.xml") ?? "";
  const rels = entries.get("word/_rels/document.xml.rels") ?? "";

  assert.match(documentXml, /<w:del w:id="0" w:author="Research" w:date="2026-05-24T09:30:00Z">[\s\S]*<w:b\/>[\s\S]*<w:delText xml:space="preserve">claim<\/w:delText>[\s\S]*<w:hyperlink r:id="rId\d+" w:history="1">[\s\S]*<w:delText xml:space="preserve">source<\/w:delText>[\s\S]*Courier New[\s\S]*<w:delText xml:space="preserve">model<\/w:delText>[\s\S]*<\/w:del>/);
  assert.match(documentXml, /<w:ins w:id="1" w:author="Research" w:date="2026-05-24T09:30:00Z">[\s\S]*<w:i\/>[\s\S]*<w:t xml:space="preserve">claim<\/w:t>[\s\S]*<w:hyperlink w:anchor="n_c1_[^"]+">[\s\S]*<w:t xml:space="preserve">c1<\/w:t>[\s\S]*<w:hyperlink r:id="rId\d+" w:history="1">[\s\S]*<w:t xml:space="preserve">source<\/w:t>[\s\S]*<\/w:ins>/);
  assert.match(rels, /Target="https:\/\/example\.com\/old" TargetMode="External"/);
  assert.match(rels, /Target="https:\/\/example\.com\/new" TargetMode="External"/);
});

test("renderDocx does not resurrect deleted change requests as tracked revisions", () => {
  const doc = parse(`::claim{id="c1"}
Claim body.
::

::change_request{id="cr-deleted" target="c1" action="insert" text="removed proposal" author="Research" status="deleted"}
Removed during Word review.
::
`);
  const docx = renderDocx(doc);
  const entries = storedZipEntries(docx);
  const documentXml = entries.get("word/document.xml") ?? "";

  assert.equal(entries.has("word/comments.xml"), false);
  assert.equal(entries.has("word/settings.xml"), false);
  assert.doesNotMatch(documentXml, /Change request/);
  assert.doesNotMatch(documentXml, /removed proposal/);
  assert.doesNotMatch(documentXml, /Removed during Word review/);
  assert.doesNotMatch(documentXml, /<w:ins\b/);
  assert.doesNotMatch(documentXml, /<w:del\b/);
});

test("renderDocx keeps unresolved change requests at their source position", () => {
  const doc = parse(`::claim{id="c1"}
Claim body.
::

::evidence{id="e1" for="c1"}
Evidence body.
::

::change_request{id="cr1" target="missing" action="insert" text="new sentence" author="Research"}
Reason for the proposed edit.
::
`);
  const docx = renderDocx(doc);
  const entries = storedZipEntries(docx);
  const documentXml = entries.get("word/document.xml") ?? "";

  assert.equal(entries.has("word/comments.xml"), false);
  assert.equal(documentXml.match(/Change request: insert missing/g)?.length, 1);
  assert.ok(documentXml.indexOf("Evidence") < documentXml.indexOf("Change request: insert missing"));
  assert.match(documentXml, /Reason for the proposed edit\./);
});

test("renderDocx keeps malformed change requests readable without native review parts", () => {
  const doc = parse(`::claim{id="c1"}
Claim body.
::

::evidence{id="e1" for="c1"}
Evidence body.
::

::change_request{id="cr-invalid" target="c1" action="replace" from="old wording" author="Research"}
Missing replacement text.
::
`);
  const docx = renderDocx(doc);
  const entries = storedZipEntries(docx);
  const documentXml = entries.get("word/document.xml") ?? "";

  assert.equal(entries.has("word/comments.xml"), false);
  assert.equal(entries.has("word/commentsExtended.xml"), false);
  assert.equal(entries.has("word/settings.xml"), false);
  assert.equal(documentXml.match(/Change request: replace c1/g)?.length, 1);
  assert.ok(documentXml.indexOf("Evidence") < documentXml.indexOf("Change request: replace c1"));
  assert.match(documentXml, /target: [\s\S]*<w:hyperlink w:anchor="n_c1_/);
  assert.match(documentXml, /action: replace/);
  assert.match(documentXml, /from: old wording/);
  assert.match(documentXml, /author: Research/);
  assert.match(documentXml, /Missing replacement text\./);
  assert.doesNotMatch(documentXml, /<w:ins\b/);
  assert.doesNotMatch(documentXml, /<w:del\b/);
});

test("renderDocx anchors targeted footnotes on the referenced block", () => {
  const doc = parse(`::claim{id="c1"}
Claim body.
::

::evidence{id="e1" for="c1"}
Evidence body.
::

::footnote{id="fn1" for="c1"}
Targeted footnote body with **bold** and [[c1]].
::
`);
  const docx = renderDocx(doc);
  const entries = storedZipEntries(docx);
  const documentXml = entries.get("word/document.xml") ?? "";
  const footnotes = entries.get("word/footnotes.xml") ?? "";

  assert.match(documentXml, /Claim[\s\S]*<w:footnoteReference w:id="1"\/>/);
  assert.equal(documentXml.match(/<w:footnoteReference w:id="1"\/>/g)?.length, 1);
  assert.ok(documentXml.indexOf("Claim") < documentXml.indexOf("Evidence"));
  assert.doesNotMatch(documentXml, /<w:t xml:space="preserve">Footnote<\/w:t>/);
  assert.doesNotMatch(documentXml, /Targeted footnote body/);

  assert.match(footnotes, /<w:footnote w:id="1">/);
  assert.match(footnotes, /Targeted footnote body with/);
  assert.match(footnotes, /<w:b\/>[\s\S]*<w:t xml:space="preserve">bold<\/w:t>/);
  assert.match(footnotes, /<w:hyperlink w:anchor="n_c1_/);
});

test("renderDocx keeps unresolved targeted footnotes at their source position", () => {
  const doc = parse(`::claim{id="c1"}
Claim body.
::

::footnote{id="fn1" for="missing"}
Fallback footnote body.
::
`);
  const docx = renderDocx(doc);
  const entries = storedZipEntries(docx);
  const documentXml = entries.get("word/document.xml") ?? "";
  const footnotes = entries.get("word/footnotes.xml") ?? "";

  assert.match(documentXml, /Footnote[\s\S]*<w:footnoteReference w:id="1"\/>/);
  assert.match(documentXml, /w:name="n_fn1_/);
  assert.ok(documentXml.indexOf("Claim") < documentXml.indexOf("Footnote"));
  assert.match(footnotes, /Fallback footnote body\./);
});

test("renderDocx anchors targeted endnotes on the referenced block", () => {
  const doc = parse(`::claim{id="c1"}
Claim body.
::

::evidence{id="e1" for="c1"}
Evidence body.
::

::endnote{id="en1" for="c1"}
Targeted endnote body with **bold**, [end link](https://endnote.example/report), and [[c1]].
::
`);
  const docx = renderDocx(doc);
  const entries = storedZipEntries(docx);
  const documentXml = entries.get("word/document.xml") ?? "";
  const documentRels = entries.get("word/_rels/document.xml.rels") ?? "";
  const contentTypes = entries.get("[Content_Types].xml") ?? "";
  const endnotes = entries.get("word/endnotes.xml") ?? "";
  const endnotesRels = entries.get("word/_rels/endnotes.xml.rels") ?? "";

  assert.match(documentXml, /Claim[\s\S]*<w:endnoteReference w:id="1"\/>/);
  assert.equal(documentXml.match(/<w:endnoteReference w:id="1"\/>/g)?.length, 1);
  assert.ok(documentXml.indexOf("Claim") < documentXml.indexOf("Evidence"));
  assert.doesNotMatch(documentXml, /<w:t xml:space="preserve">Endnote<\/w:t>/);
  assert.doesNotMatch(documentXml, /Targeted endnote body/);

  assert.match(documentRels, /Type="http:\/\/schemas\.openxmlformats\.org\/officeDocument\/2006\/relationships\/endnotes" Target="endnotes\.xml"/);
  assert.match(contentTypes, /PartName="\/word\/endnotes\.xml"/);
  assert.match(endnotes, /<w:endnote w:id="-1" w:type="separator">/);
  assert.match(endnotes, /<w:endnote w:id="1">/);
  assert.match(endnotes, /<w:endnoteRef\/>/);
  assert.match(endnotes, /Targeted endnote body with/);
  assert.match(endnotes, /<w:b\/>[\s\S]*<w:t xml:space="preserve">bold<\/w:t>/);
  assert.match(endnotes, /<w:hyperlink r:id="rId1" w:history="1">[\s\S]*end link/);
  assert.match(endnotes, /<w:hyperlink w:anchor="n_c1_/);
  assert.match(endnotesRels, /Target="https:\/\/endnote\.example\/report" TargetMode="External"/);
});

test("renderDocx keeps unresolved targeted endnotes at their source position", () => {
  const doc = parse(`::claim{id="c1"}
Claim body.
::

::endnote{id="en1" for="missing"}
Fallback endnote body.
::
`);
  const docx = renderDocx(doc);
  const entries = storedZipEntries(docx);
  const documentXml = entries.get("word/document.xml") ?? "";
  const endnotes = entries.get("word/endnotes.xml") ?? "";

  assert.match(documentXml, /Endnote[\s\S]*<w:endnoteReference w:id="1"\/>/);
  assert.match(documentXml, /w:name="n_en1_/);
  assert.ok(documentXml.indexOf("Claim") < documentXml.indexOf("Endnote"));
  assert.match(endnotes, /Fallback endnote body\./);
});

test("renderDocx preserves rich inline content in native comments and footnotes", () => {
  const doc = parse(`# Source {id="source"}

::comment{id="rich-comment" parent="source" author="Research"}
Check **bold**, *emphasis*, \`code\`, [source link](https://comment.example/report), and [[source]].
::

::footnote{id="rich-footnote"}
Footnote has **bold**, [note link](https://footnote.example/note), and [[source]].
::
`);
  const docx = renderDocx(doc);
  const entries = storedZipEntries(docx);
  const documentRels = entries.get("word/_rels/document.xml.rels") ?? "";
  const comments = entries.get("word/comments.xml") ?? "";
  const commentsRels = entries.get("word/_rels/comments.xml.rels") ?? "";
  const footnotes = entries.get("word/footnotes.xml") ?? "";
  const footnotesRels = entries.get("word/_rels/footnotes.xml.rels") ?? "";

  assert.match(comments, /xmlns:r="http:\/\/schemas\.openxmlformats\.org\/officeDocument\/2006\/relationships"/);
  assert.match(comments, /<w:b\/>[\s\S]*<w:t xml:space="preserve">bold<\/w:t>/);
  assert.match(comments, /<w:i\/>[\s\S]*<w:t xml:space="preserve">emphasis<\/w:t>/);
  assert.match(comments, /Courier New[\s\S]*<w:t xml:space="preserve">code<\/w:t>/);
  assert.match(comments, /<w:hyperlink r:id="rId1" w:history="1">[\s\S]*source link/);
  assert.match(comments, /<w:hyperlink w:anchor="n_source_/);
  assert.match(commentsRels, /Target="https:\/\/comment\.example\/report" TargetMode="External"/);

  assert.match(footnotes, /xmlns:r="http:\/\/schemas\.openxmlformats\.org\/officeDocument\/2006\/relationships"/);
  assert.match(footnotes, /<w:b\/>[\s\S]*<w:t xml:space="preserve">bold<\/w:t>/);
  assert.match(footnotes, /<w:hyperlink r:id="rId1" w:history="1">[\s\S]*note link/);
  assert.match(footnotes, /<w:hyperlink w:anchor="n_source_/);
  assert.match(footnotesRels, /Target="https:\/\/footnote\.example\/note" TargetMode="External"/);

  assert.doesNotMatch(documentRels, /comment\.example/);
  assert.doesNotMatch(documentRels, /footnote\.example/);
});

test("renderDocx embeds data-uri figures as DOCX media", () => {
  const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";
  const doc = parse(`::figure{id="fig1" caption="Tiny chart" alt="One pixel chart" src="data:image/png;base64,${png}" width="1in"}\n::\n`);
  const docx = renderDocx(doc);
  const entries = storedZipEntries(docx);
  const buffers = storedZipEntryBuffers(docx);

  assert.deepEqual(buffers.get("word/media/image1.png"), Buffer.from(png, "base64"));

  const documentXml = entries.get("word/document.xml") ?? "";
  assert.match(documentXml, /<w:drawing>/);
  assert.match(documentXml, /<w:drawing>[\s\S]*<w:pStyle w:val="NomaCaption"\/>[\s\S]*Figure[\s\S]*<w:instrText xml:space="preserve"> SEQ Figure \\\* ARABIC <\/w:instrText>[\s\S]*Tiny chart/);
  assert.doesNotMatch(documentXml, /<w:pStyle w:val="NomaDirective"\/>[\s\S]*Tiny chart/);
  assert.match(documentXml, /<wp:extent cx="914400" cy="914400"\/>/);
  assert.match(documentXml, /<wp:docPr id="1" name="image1\.png" descr="One pixel chart"\/>/);
  assert.match(documentXml, /<a:blip r:embed="rId3"\/>/);
  assert.doesNotMatch(documentXml, /Source: \[/);

  const rels = entries.get("word/_rels/document.xml.rels") ?? "";
  assert.match(rels, /Type="http:\/\/schemas\.openxmlformats\.org\/officeDocument\/2006\/relationships\/image" Target="media\/image1\.png"/);

  const contentTypes = entries.get("[Content_Types].xml") ?? "";
  assert.match(contentTypes, /<Default Extension="png" ContentType="image\/png"\/>/);
  assert.match(contentTypes, /PartName="\/word\/settings\.xml"/);
});

test("renderDocx preserves grid and columns layouts as Word tables", () => {
  const doc = parse(`::grid{id="layout" columns=2}
:::card{id="left" title="Left"}
Left body.
:::

:::card{id="right" title="Right"}
Right body.
:::
::

::columns{id="cols" columns=3}
:::card{id="a" title="A"}
A body.
:::

:::card{id="b" title="B"}
B body.
:::

:::card{id="c" title="C"}
C body.
:::
::`);
  const docx = renderDocx(doc);
  const entries = storedZipEntries(docx);
  const documentXml = entries.get("word/document.xml") ?? "";
  const styles = entries.get("word/styles.xml") ?? "";

  assert.match(documentXml, /<w:tblStyle w:val="NomaLayout"\/>/);
  assert.match(documentXml, /<w:tblLayout w:type="fixed"\/>/);
  assert.equal(documentXml.match(/<w:tblStyle w:val="NomaLayout"\/>/g)?.length, 2);
  assert.equal(documentXml.match(/<w:gridCol w:w="4680"\/>/g)?.length, 2);
  assert.equal(documentXml.match(/<w:gridCol w:w="3120"\/>/g)?.length, 3);
  assert.match(documentXml, /w:name="n_layout_/);
  assert.match(documentXml, /w:name="n_cols_/);
  assert.match(documentXml, /Left body\./);
  assert.match(documentXml, /Right body\./);
  assert.match(documentXml, /A body\./);
  assert.match(documentXml, /C body\./);
  assert.doesNotMatch(documentXml, /grid \(columns=2\)/);
  assert.doesNotMatch(documentXml, /columns \(columns=3\)/);
  assert.match(styles, /<w:style w:type="table" w:styleId="NomaLayout">/);
});

test("renderDocx sizes Word tables from page setup", () => {
  const doc = parse(`::page_setup{size="Letter" orientation="landscape" margin="0.5in"}
::

| A | B | C |
| --- | --- | --- |
| 1 | 2 | 3 |

::grid{id="landscape-grid" columns=2}
:::card{title="Left"}
Left.
:::

:::card{title="Right"}
Right.
:::
::`);
  const docx = renderDocx(doc);
  const documentXml = storedZipEntries(docx).get("word/document.xml") ?? "";

  assert.match(documentXml, /<w:pgSz w:w="15840" w:h="12240" w:orient="landscape"\/>/);
  assert.match(documentXml, /<w:pgMar w:top="720" w:right="720" w:bottom="720" w:left="720" w:header="720" w:footer="720" w:gutter="0"\/>/);
  assert.equal(documentXml.match(/<w:gridCol w:w="4800"\/>/g)?.length, 3);
  assert.equal(documentXml.match(/<w:gridCol w:w="7200"\/>/g)?.length, 2);
  assert.match(documentXml, /w:name="n_landscape_grid_/);
  assert.match(documentXml, /Left\./);
  assert.match(documentXml, /Right\./);
});

test("renderDocx emits native section breaks for subsequent page setup changes", () => {
  const doc = parse(`::page_setup{size="Letter" margin="1in"}
::

| A | B |
| --- | --- |
| 1 | 2 |

::page_setup{id="wide-section" orientation="landscape" margin="0.5in"}
::

| A | B |
| --- | --- |
| 3 | 4 |
`);
  const docx = renderDocx(doc);
  const documentXml = storedZipEntries(docx).get("word/document.xml") ?? "";

  assert.equal(documentXml.match(/<w:sectPr>/g)?.length, 2);
  assert.match(documentXml, /<w:pPr><w:pStyle w:val="NomaMeta"\/><w:sectPr>[\s\S]*<w:pgSz w:w="12240" w:h="15840"\/>[\s\S]*<w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/);
  assert.match(documentXml, /<w:pgSz w:w="15840" w:h="12240" w:orient="landscape"\/>[\s\S]*<w:pgMar w:top="720" w:right="720" w:bottom="720" w:left="720"/);
  assert.match(documentXml, /w:name="n_wide_section_/);
  assert.match(documentXml, /<w:gridCol w:w="4680"\/>[\s\S]*<w:gridCol w:w="7200"\/>/);
});

test("renderDocx renders cards as framed Word panels with metadata", () => {
  const doc = parse(`::card{id="standalone-card" title="Launch plan" icon="rocket" variant="important"}
Confirm the rollout sequence.
::

::card{id="untitled-card" icon="note"}
Titleless cards still need a readable handoff label.
::`);
  const docx = renderDocx(doc);
  const documentXml = storedZipEntries(docx).get("word/document.xml") ?? "";

  assert.match(documentXml, /Launch plan/);
  assert.match(documentXml, /Confirm the rollout sequence\./);
  assert.match(documentXml, /variant: important/);
  assert.match(documentXml, /icon: rocket/);
  assert.match(documentXml, /w:name="n_standalone_card_/);
  assert.match(documentXml, /w:fill="F1EFF8"/);

  assert.match(documentXml, /<w:t xml:space="preserve">Card<\/w:t>/);
  assert.match(documentXml, /Titleless cards still need a readable handoff label\./);
  assert.match(documentXml, /icon: note/);
  assert.match(documentXml, /w:name="n_untitled_card_/);
  assert.match(documentXml, /w:fill="F3F4F6"/);
  assert.doesNotMatch(documentXml, /card \(icon=note\)/);
});

test("renderDocx renders rich block titles as native Word runs", () => {
  const doc = parse(`::card{id="plan" title="Launch **plan**"}
Body.
::

::callout{id="warning" tone="warning" title="Risk **warning**"}
Body.
::

::api{id="api" title="API **surface**"}
Body.
::`);
  const docx = renderDocx(doc);
  const documentXml = storedZipEntries(docx).get("word/document.xml") ?? "";

  assert.doesNotMatch(documentXml, /\*\*plan\*\*/);
  assert.doesNotMatch(documentXml, /\*\*warning\*\*/);
  assert.doesNotMatch(documentXml, /\*\*surface\*\*/);
  assert.match(documentXml, /<w:t xml:space="preserve">Launch <\/w:t><\/w:r><w:r><w:rPr><w:b\/><w:color w:val="46505A"\/><\/w:rPr><w:t xml:space="preserve">plan<\/w:t>/);
  assert.match(documentXml, /<w:t xml:space="preserve">Warning: Risk <\/w:t><\/w:r><w:r><w:rPr><w:b\/><w:color w:val="8B2E20"\/><\/w:rPr><w:t xml:space="preserve">warning<\/w:t>/);
  assert.match(documentXml, /<w:t xml:space="preserve">API: API <\/w:t><\/w:r><w:r><w:rPr><w:b\/><w:color w:val="2B5265"\/><\/w:rPr><w:t xml:space="preserve">surface<\/w:t>/);
});

test("renderDocx renders web layout containers as readable Word structure", () => {
  const doc = parse(`::hero{id="hero"}
# Landing Page
Intro copy for the first screen.

:::button{href="https://example.com"}
Open
:::
::

::tabs{id="compare"}
:::tab{id="tab-markdown" title="Markdown"}
Prose-first source.
:::

:::tab{title="Noma"}
Structured document source.
:::
::

::accordion{id="faq"}
:::card{title="Can this export to Word?"}
Yes, as readable sections.
:::
::

::sidebar{id="notes" title="Review notes"}
Keep this visible beside the main argument.
::
`);
  const docx = renderDocx(doc);
  const documentXml = storedZipEntries(docx).get("word/document.xml") ?? "";

  assert.match(documentXml, /w:name="n_hero_/);
  assert.match(documentXml, /w:name="n_compare_/);
  assert.match(documentXml, /w:name="n_tab_markdown_/);
  assert.match(documentXml, /w:name="n_faq_/);
  assert.match(documentXml, /Landing Page/);
  assert.match(documentXml, /Intro copy for the first screen\./);
  assert.match(documentXml, /Open/);
  assert.match(documentXml, /Markdown/);
  assert.match(documentXml, /Structured document source\./);
  assert.match(documentXml, /Can this export to Word\?/);
  assert.match(documentXml, /Sidebar: Review notes/);
  assert.match(documentXml, /Keep this visible beside the main argument\./);
  assert.doesNotMatch(documentXml, /<w:t xml:space="preserve">hero<\/w:t>/);
  assert.doesNotMatch(documentXml, /<w:t xml:space="preserve">tabs<\/w:t>/);
  assert.doesNotMatch(documentXml, /<w:t xml:space="preserve">tab<\/w:t>/);
  assert.doesNotMatch(documentXml, /<w:t xml:space="preserve">accordion<\/w:t>/);
  assert.doesNotMatch(documentXml, /sidebar \(title=Review notes\)/);
});

test("renderDocx renders abstract and callout aliases with natural Word labels", () => {
  const doc = parse(`::abstract{id="abstract"}
Executive context for the handoff.
::

::note{id="note-block"}
Keep this nuance.
::

::warning{id="warning-block"}
Do not ship without legal review.
::

::tip{id="tip-block"}
Use the short path.
::

::callout{id="explicit-warning" tone="warning" title="Launch risk"}
Recheck the release gate.
::

::callout{id="explicit-note" tone="note"}
Background context belongs here.
::
`);
  const docx = renderDocx(doc);
  const documentXml = storedZipEntries(docx).get("word/document.xml") ?? "";

  assert.match(documentXml, /Abstract/);
  assert.match(documentXml, /Executive context for the handoff\./);
  assert.match(documentXml, /w:name="n_abstract_/);
  assert.match(documentXml, /w:fill="EAF2EF"/);
  assert.doesNotMatch(documentXml, /<w:t xml:space="preserve">abstract<\/w:t>/);

  assert.match(documentXml, /Note/);
  assert.match(documentXml, /Keep this nuance\./);
  assert.match(documentXml, /w:name="n_note_block_/);
  assert.match(documentXml, /w:fill="EFF6F8"/);
  assert.doesNotMatch(documentXml, /<w:t xml:space="preserve">note<\/w:t>/);

  assert.match(documentXml, /Warning/);
  assert.match(documentXml, /Do not ship without legal review\./);
  assert.match(documentXml, /w:name="n_warning_block_/);
  assert.match(documentXml, /w:fill="FBEDEC"/);
  assert.doesNotMatch(documentXml, /<w:t xml:space="preserve">warning<\/w:t>/);

  assert.match(documentXml, /Tip/);
  assert.match(documentXml, /Use the short path\./);
  assert.match(documentXml, /w:name="n_tip_block_/);
  assert.match(documentXml, /w:fill="F1F6EF"/);
  assert.doesNotMatch(documentXml, /<w:t xml:space="preserve">tip<\/w:t>/);

  assert.match(documentXml, /Warning: Launch risk/);
  assert.match(documentXml, /Recheck the release gate\./);
  assert.match(documentXml, /w:name="n_explicit_warning_/);
  assert.doesNotMatch(documentXml, /Callout \(warning\)/);

  assert.match(documentXml, /Note/);
  assert.match(documentXml, /Background context belongs here\./);
  assert.match(documentXml, /w:name="n_explicit_note_/);
  assert.doesNotMatch(documentXml, /Callout \(note\)/);
});

test("renderDocx renders datasets as Word tables", () => {
  const doc = parse(`::dataset{id="ds1" title="Vertical scores"}
schema:
  vertical: string
  score: number
rows:
  - [legal, 18]
  - [finance, 24]
::`);
  const docx = renderDocx(doc);
  const documentXml = storedZipEntries(docx).get("word/document.xml") ?? "";

  assert.match(documentXml, /Dataset: Vertical scores/);
  assert.match(documentXml, /<w:tbl>/);
  assert.match(documentXml, /<w:tblHeader\/>/);
  assert.match(documentXml, /<w:t xml:space="preserve">vertical<\/w:t>/);
  assert.match(documentXml, /<w:t xml:space="preserve">score<\/w:t>/);
  assert.match(documentXml, /<w:t xml:space="preserve">legal<\/w:t>/);
  assert.match(documentXml, /<w:t xml:space="preserve">24<\/w:t>/);
  assert.match(documentXml, /2 rows/);
  assert.doesNotMatch(documentXml, /<w:pStyle w:val="NomaCode"\/>[\s\S]*schema:/);
});

test("renderDocx preserves ::table captions as Word labels", () => {
  const doc = parse(`::table{id="scenario-table" caption="Scenario summary" header align="l,r"}
| Case | Return |
| Base | 8% |
| Upside | 12% |
::

::table{id="unlabeled-table" header}
| A | B |
| x | y |
::`);
  const docx = renderDocx(doc);
  const entries = storedZipEntries(docx);
  const documentXml = entries.get("word/document.xml") ?? "";
  const styles = entries.get("word/styles.xml") ?? "";

  assert.match(documentXml, /<w:pStyle w:val="NomaCaption"\/>/);
  assert.match(documentXml, /Table[\s\S]*<w:instrText xml:space="preserve"> SEQ Table \\\* ARABIC <\/w:instrText>[\s\S]*Scenario summary/);
  assert.match(documentXml, /w:name="n_scenario_table_/);
  assert.match(documentXml, /<w:tbl>/);
  assert.match(documentXml, /<w:t xml:space="preserve">Case<\/w:t>/);
  assert.match(documentXml, /<w:t xml:space="preserve">12%<\/w:t>/);
  assert.doesNotMatch(documentXml, /table \(caption=Scenario summary/);

  assert.match(documentXml, /w:name="n_unlabeled_table_/);
  assert.doesNotMatch(documentXml, /unlabeled-table[\s\S]*SEQ Table/);
  assert.match(styles, /<w:style w:type="paragraph" w:styleId="NomaCaption">/);
});

test("renderDocx renders rich captions as native Word runs", () => {
  const doc = parse(`::table{id="metrics" title="Quarterly **metrics**" header}
| Metric | Value |
| ARR | 10m |
::

::plot{id="growth" title="Revenue **trend**" type="line" data="1,2,3"}
::`);
  const docx = renderDocx(doc);
  const documentXml = storedZipEntries(docx).get("word/document.xml") ?? "";

  assert.doesNotMatch(documentXml, /\*\*metrics\*\*/);
  assert.doesNotMatch(documentXml, /\*\*trend\*\*/);
  assert.match(documentXml, /<w:pStyle w:val="NomaCaption"\/>[\s\S]*<w:t xml:space="preserve">: Quarterly <\/w:t><\/w:r><w:r><w:rPr><w:b\/><w:color w:val="46505A"\/><\/w:rPr><w:t xml:space="preserve">metrics<\/w:t>/);
  assert.match(documentXml, /<w:pStyle w:val="NomaCaption"\/>[\s\S]*<w:t xml:space="preserve">: Revenue <\/w:t><\/w:r><w:r><w:rPr><w:b\/><w:color w:val="46505A"\/><\/w:rPr><w:t xml:space="preserve">trend<\/w:t>/);
});

test("renderDocx emits Word REF fields for wikilinks to captioned blocks", () => {
  const doc = parse(`See [[fig1]], **[[scenario-table]]**, and [[plain-target]].

::figure{id="fig1" caption="Adoption curve" src="data:image/svg+xml,%3Csvg%20width%3D%2210%22%20height%3D%225%22%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%2F%3E"}
::

::table{id="scenario-table" caption="Scenario summary" header}
| Case | Return |
| Base | 8% |
::

::claim{id="plain-target"}
Claim body.
::
`);
  const docx = renderDocx(doc);
  const entries = storedZipEntries(docx);
  const documentXml = entries.get("word/document.xml") ?? "";
  const settings = entries.get("word/settings.xml") ?? "";

  assert.match(documentXml, /<w:instrText xml:space="preserve"> REF n_fig1_[^ ]+ \\h <\/w:instrText>/);
  assert.match(documentXml, /<w:instrText xml:space="preserve"> REF n_scenario_table_[^ ]+ \\h <\/w:instrText>/);
  assert.match(documentXml, /<w:instrText xml:space="preserve"> REF n_scenario_table_[^ ]+ \\h <\/w:instrText>[\s\S]*<w:b\/>[\s\S]*<w:t xml:space="preserve">Table<\/w:t>/);
  assert.match(documentXml, /<w:t xml:space="preserve">Figure<\/w:t>/);
  assert.match(documentXml, /<w:t xml:space="preserve">Table<\/w:t>/);
  assert.match(documentXml, /<w:hyperlink w:anchor="n_plain_target_/);
  assert.match(settings, /<w:updateFields w:val="true"\/>/);
});

test("renderDocx renders caption lists from ::toc of figures tables and plots", () => {
  const doc = parse(`::toc{id="figures" of="figures"}
::

::toc{id="tables" of="tables"}
::

::toc{id="plots" of="plots"}
::

::figure{id="fig1" caption="Adoption curve" src="data:image/svg+xml,%3Csvg%20width%3D%2210%22%20height%3D%225%22%20xmlns%3D%22http%3A%2F%2Fwww.w3.org%2F2000%2Fsvg%22%2F%3E"}
::

::table{id="scenario-table" caption="Scenario summary" header}
| Case | Return |
| Base | 8% |
::

::plot{id="plot1" title="Revenue trend" type="line" data="1,2,3"}
::
`);
  const docx = renderDocx(doc);
  const entries = storedZipEntries(docx);
  const documentXml = entries.get("word/document.xml") ?? "";
  const settings = entries.get("word/settings.xml") ?? "";

  assert.match(documentXml, /List of Figures[\s\S]*<w:hyperlink w:anchor="n_fig1_[^"]+">[\s\S]*Figure: Adoption curve[\s\S]*<w:instrText xml:space="preserve"> PAGEREF n_fig1_[^ ]+ \\h <\/w:instrText>/);
  assert.match(documentXml, /List of Tables[\s\S]*<w:hyperlink w:anchor="n_scenario_table_[^"]+">[\s\S]*Table: Scenario summary[\s\S]*<w:instrText xml:space="preserve"> PAGEREF n_scenario_table_[^ ]+ \\h <\/w:instrText>/);
  assert.match(documentXml, /List of Plots[\s\S]*<w:hyperlink w:anchor="n_plot1_[^"]+">[\s\S]*Plot: Revenue trend[\s\S]*<w:instrText xml:space="preserve"> PAGEREF n_plot1_[^ ]+ \\h <\/w:instrText>/);
  assert.match(documentXml, /w:name="n_figures_/);
  assert.match(documentXml, /w:name="n_tables_/);
  assert.match(documentXml, /w:name="n_plots_/);
  assert.match(settings, /<w:updateFields w:val="true"\/>/);
});

test("renderDocx renders rich toc entries as native Word runs", () => {
  const doc = parse(`::toc{id="contents" depth=2}
::

::toc{id="tables" of="tables"}
::

# Executive **summary** {id="executive-summary"}

## Market **view** {id="market-view"}

See the table.

::table{id="metrics" title="Quarterly **metrics**" header}
| Metric | Value |
| ARR | 10m |
::`);
  const docx = renderDocx(doc);
  const documentXml = storedZipEntries(docx).get("word/document.xml") ?? "";

  assert.doesNotMatch(documentXml, /\*\*summary\*\*/);
  assert.doesNotMatch(documentXml, /\*\*view\*\*/);
  assert.doesNotMatch(documentXml, /\*\*metrics\*\*/);
  assert.match(documentXml, /<w:pStyle w:val="NomaToc"\/>[\s\S]*<w:hyperlink w:anchor="n_market_view_[^"]+">[\s\S]*<w:t xml:space="preserve">Market <\/w:t><\/w:r><w:r><w:rPr><w:b\/><w:u w:val="single"\/><w:color w:val="0563C1"\/><\/w:rPr><w:t xml:space="preserve">view<\/w:t>/);
  assert.match(documentXml, /<w:pStyle w:val="NomaToc"\/>[\s\S]*<w:hyperlink w:anchor="n_metrics_[^"]+">[\s\S]*<w:t xml:space="preserve">Table: Quarterly <\/w:t><\/w:r><w:r><w:rPr><w:b\/><w:u w:val="single"\/><w:color w:val="0563C1"\/><\/w:rPr><w:t xml:space="preserve">metrics<\/w:t>/);
});

test("renderDocx renders metric blocks as KPI handoff blocks", () => {
  const doc = parse(`::citation{id="source-dashboard" source="RevOps dashboard"}
Daily metric pull.
::

::metric{id="nrr" label="NRR" value=122 unit="%" status="green" trend="up" change="+4 pts" target="115%" source="source-dashboard" as_of="2026-05-24"}
Review note for the operating cadence.
::

::metric{id="pipeline"}
$42M
::
`);
  const docx = renderDocx(doc);
  const documentXml = storedZipEntries(docx).get("word/document.xml") ?? "";

  assert.match(documentXml, /Metric: NRR/);
  assert.match(documentXml, /122%/);
  assert.match(documentXml, /Review note for the operating cadence\./);
  assert.match(documentXml, /status: green[\s\S]*trend: up[\s\S]*change: \+4 pts[\s\S]*target: 115%/);
  assert.match(documentXml, /source: /);
  assert.match(documentXml, /<w:hyperlink w:anchor="n_source_dashboard_/);
  assert.match(documentXml, /as of: 2026-05-24/);
  assert.match(documentXml, /w:name="n_nrr_/);
  assert.doesNotMatch(documentXml, /metric \(label=NRR/);

  assert.match(documentXml, /Metric: pipeline/);
  assert.match(documentXml, /\$42M/);
  assert.match(documentXml, /w:name="n_pipeline_/);
});

test("renderDocx renders rich metric values and generated metadata as native Word runs", () => {
  const doc = parse(`::citation{id="source-rich" source="Research **memo**"}
Citation body with *notes*.
::

::bibliography{id="refs"}
::

::dataset{id="sales" title="Sales **dataset**" format="CSV **draft**" src="data/**sales**.csv"}
schema:
  segment: string
  arr: number
rows:
  - [A, 1]
  - [B, 2]
::

::metric{id="arr" label="ARR" value="**42** and \`base\`" unit="M"}
::

::plot{id="bad-plot" title="Fallback **plot**" type="line" data="bad **data**"}
::

::export_button{id="copy" format="prompt **rich**" label="Copy"}
::
`);
  const docx = renderDocx(doc);
  const entries = storedZipEntries(docx);
  const documentXml = entries.get("word/document.xml") ?? "";
  const styles = entries.get("word/styles.xml") ?? "";

  assert.doesNotMatch(documentXml, /\*\*42\*\*/);
  assert.doesNotMatch(documentXml, /`base`/);
  assert.doesNotMatch(documentXml, /CSV \*\*draft\*\*/);
  assert.doesNotMatch(documentXml, /bad \*\*data\*\*/);
  assert.doesNotMatch(documentXml, /prompt \*\*rich\*\*/);
  assert.match(documentXml, /<w:pStyle w:val="NomaMetricValue"\/>[\s\S]*<w:b\/><w:color w:val="2B5265"\/>[\s\S]*<w:t xml:space="preserve">42<\/w:t>/);
  assert.match(documentXml, /<w:pStyle w:val="NomaMetricValue"\/>[\s\S]*<w:color w:val="2B5265"\/><w:rFonts w:ascii="Courier New"[\s\S]*<w:t xml:space="preserve">base<\/w:t>/);
  assert.match(documentXml, /format: CSV <\/w:t><\/w:r><w:r><w:rPr><w:b\/><\/w:rPr><w:t xml:space="preserve">draft<\/w:t>/);
  assert.match(documentXml, /source: bad <\/w:t><\/w:r><w:r><w:rPr><w:b\/><\/w:rPr><w:t xml:space="preserve">data<\/w:t>/);
  assert.match(documentXml, /format: prompt <\/w:t><\/w:r><w:r><w:rPr><w:b\/><\/w:rPr><w:t xml:space="preserve">rich<\/w:t>/);
  assert.match(documentXml, /Bibliography[\s\S]*Research <\/w:t><\/w:r><w:r><w:rPr><w:b\/><\/w:rPr><w:t xml:space="preserve">memo<\/w:t>/);
  assert.match(styles, /<w:style w:type="paragraph" w:styleId="NomaMetricValue">/);
});

test("renderDocx renders addressable code directives as monospace Word blocks", () => {
  const doc = parse(`::code{id="agent-safe-edit-prompt" lang="text" title="Agent prompt"}
Discover IDs first.
noma patch --ops ops.json --inplace
::`);
  const docx = renderDocx(doc);
  const documentXml = storedZipEntries(docx).get("word/document.xml") ?? "";

  assert.match(documentXml, /Code \(text\): Agent prompt/);
  assert.match(documentXml, /<w:pStyle w:val="NomaCode"\/>[\s\S]*Discover IDs first\./);
  assert.match(documentXml, /<w:pStyle w:val="NomaCode"\/>[\s\S]*noma patch --ops ops\.json --inplace/);
  assert.match(documentXml, /w:name="n_agent_safe_edit_prompt_/);
  assert.match(documentXml, /w:fill="F3F4F6"/);
  assert.doesNotMatch(documentXml, /code \(lang=text/);
});

test("renderDocx renders code cells and outputs as technical handoff blocks", () => {
  const doc = parse(`::code_cell{id="cell-1" lang="python" kernel="pyodide" status="cached" execution_count=7}
print("hello")
total = 1 + 2
::

::output{id="cell-1-output" for="cell-1" type="stdout" status="ok"}
hello
3
::
`);
  const docx = renderDocx(doc);
  const documentXml = storedZipEntries(docx).get("word/document.xml") ?? "";

  assert.match(documentXml, /Code cell \(python\)/);
  assert.match(documentXml, /kernel: pyodide[\s\S]*status: cached[\s\S]*execution: 7/);
  assert.match(documentXml, /<w:pStyle w:val="NomaCode"\/>[\s\S]*print\("hello"\)/);
  assert.match(documentXml, /total = 1 \+ 2/);
  assert.match(documentXml, /w:name="n_cell_1_/);
  assert.doesNotMatch(documentXml, /code_cell \(lang=python/);

  assert.match(documentXml, /Output \(stdout\)/);
  assert.match(documentXml, /for: /);
  assert.match(documentXml, /<w:hyperlink w:anchor="n_cell_1_/);
  assert.match(documentXml, /status: ok/);
  assert.match(documentXml, /<w:pStyle w:val="NomaCode"\/>[\s\S]*hello[\s\S]*<w:pStyle w:val="NomaCode"\/>[\s\S]*3/);
  assert.match(documentXml, /w:name="n_cell_1_output_/);
  assert.doesNotMatch(documentXml, /output \(for=cell-1/);
});

test("renderDocx renders computed metrics and plots as static Word handoffs", () => {
  const doc = parse(`::control{id="growth-rate" type="slider" min=0 max=20 default=8}
label: Growth rate
unit: %
::

::control{id="base-revenue" type="number" default=120}
Base revenue
::

::computed_metric{id="year-5-revenue" formula="base-revenue * pow(1 + growth-rate / 100, 5)" unit="M" title="Year 5 revenue"}
::

::computed_plot{id="projection" type="line" width=320 height=140}
formula: base-revenue * pow(1 + growth-rate / 100, year)
domain: year:0..3
title: Projection
Reviewed as a static Word chart.
::
`);
  const docx = renderDocx(doc);
  const entries = storedZipEntries(docx);
  const buffers = storedZipEntryBuffers(docx);
  const documentXml = entries.get("word/document.xml") ?? "";
  const svg = buffers.get("word/media/image1.svg")?.toString("utf8") ?? "";

  assert.match(documentXml, /Computed metric: Year 5 revenue/);
  assert.match(documentXml, /176\.319369 M/);
  assert.match(documentXml, /formula: base-revenue \* pow\(1 \+ growth-rate \/ 100, 5\)/);
  assert.match(documentXml, /w:name="n_year_5_revenue_/);
  assert.doesNotMatch(documentXml, /computed_metric \(formula=/);

  assert.match(documentXml, /Computed plot[\s\S]*<w:instrText xml:space="preserve"> SEQ Plot \\\* ARABIC <\/w:instrText>[\s\S]*Projection/);
  assert.match(documentXml, /line computed plot, 4 points/);
  assert.match(documentXml, /Reviewed as a static Word chart\./);
  assert.match(documentXml, /domain: year:0\.\.3/);
  assert.match(documentXml, /<w:drawing>[\s\S]*<w:pStyle w:val="NomaCaption"\/>[\s\S]*Computed plot[\s\S]*Projection/);
  assert.match(documentXml, /<a:blip r:embed="rId3"\/>/);
  assert.doesNotMatch(documentXml, /formula: .*Reviewed as a static Word chart/);
  assert.doesNotMatch(documentXml, /computed_plot \(type=line/);

  assert.match(svg, /<svg viewBox="0 0 320 140"/);
  assert.match(svg, /<polyline /);
  assert.doesNotMatch(svg, /currentColor/);
  assert.match(svg, /#2B5265/);
});

test("renderDocx renders technical documentation blocks as structured Word handoffs", () => {
  const doc = parse(`::api{id="payments-api" title="Payments API" version="v1" base_url="https://api.example.test" status="beta"}
Use this API for payment orchestration.
::

::endpoint{id="create-payment" api="payments-api" method="post" path="/v1/payments" auth="bearer"}
Creates a payment intent.
::

::parameter{id="amount-param" name="amount" in="body" type="integer" required default=100}
Amount in cents.
::

::example{id="create-payment-example" title="Create payment" lang="json" for="create-payment"}
{"amount":100}
::

::query{id="payment-query" title="Recent payments" lang="sql" dataset="payments-api"}
select * from payments limit 10;
::

::instruction{id="agent-instruction" scope="agent" priority="high"}
Patch only the endpoint block that changed.
::

::changelog{id="api-change" version="1.2.0" date="2026-05-24" status="added"}
Added the create-payment endpoint.
::`);
  const docx = renderDocx(doc);
  const entries = storedZipEntries(docx);
  const documentXml = entries.get("word/document.xml") ?? "";
  const rels = entries.get("word/_rels/document.xml.rels") ?? "";

  assert.match(documentXml, /API: Payments API/);
  assert.match(documentXml, /version: v1[\s\S]*base URL: [\s\S]*https:\/\/api\.example\.test[\s\S]*status: beta/);
  assert.match(documentXml, /w:name="n_payments_api_/);
  assert.match(rels, /Target="https:\/\/api\.example\.test" TargetMode="External"/);

  assert.match(documentXml, /Endpoint: POST \/v1\/payments/);
  assert.match(documentXml, /method: post[\s\S]*path: \/v1\/payments[\s\S]*auth: bearer[\s\S]*api: /);
  assert.match(documentXml, /<w:hyperlink w:anchor="n_payments_api_/);
  assert.match(documentXml, /Creates a payment intent\./);
  assert.doesNotMatch(documentXml, /endpoint \(api=payments-api/);

  assert.match(documentXml, /Parameter: amount/);
  assert.match(documentXml, /in: body[\s\S]*type: integer[\s\S]*required: true[\s\S]*default: 100/);
  assert.match(documentXml, /Amount in cents\./);

  assert.match(documentXml, /Example: Create payment/);
  assert.match(documentXml, /language: json[\s\S]*for: /);
  assert.match(documentXml, /<w:hyperlink w:anchor="n_create_payment_/);
  assert.match(documentXml, /<w:pStyle w:val="NomaCode"\/>[\s\S]*\{"amount":100\}/);

  assert.match(documentXml, /Query: Recent payments/);
  assert.match(documentXml, /language: sql[\s\S]*dataset: /);
  assert.match(documentXml, /<w:pStyle w:val="NomaCode"\/>[\s\S]*select \* from payments limit 10;/);

  assert.match(documentXml, /Instruction/);
  assert.match(documentXml, /scope: agent[\s\S]*priority: high/);
  assert.match(documentXml, /Patch only the endpoint block that changed\./);

  assert.match(documentXml, /Changelog: 1\.2\.0/);
  assert.match(documentXml, /version: 1\.2\.0[\s\S]*date: 2026-05-24[\s\S]*status: added/);
});

test("renderDocx renders custom directive fallback labels as readable Word blocks", () => {
  const doc = parse(`::finance::position{id="holding-asml" asset_class="equity" region="EU"}
ASML position note.
::

::custom_directive{id="custom-block" last_seen="2026-05-24" noverify}
Custom block note.
::`);
  const docx = renderDocx(doc);
  const documentXml = storedZipEntries(docx).get("word/document.xml") ?? "";

  assert.match(documentXml, /Finance position \(asset class=equity, region=EU\)/);
  assert.match(documentXml, /ASML position note\./);
  assert.match(documentXml, /w:name="n_holding_asml_/);
  assert.match(documentXml, /w:fill="F2F6F3"[\s\S]*Finance position/);
  assert.doesNotMatch(documentXml, /finance::position/);

  assert.match(documentXml, /Custom directive \(last seen=2026-05-24, noverify\)/);
  assert.match(documentXml, /Custom block note\./);
  assert.match(documentXml, /w:name="n_custom_block_/);
  assert.match(documentXml, /w:fill="F2F6F3"[\s\S]*Custom directive/);
  assert.doesNotMatch(documentXml, /custom_directive/);
});

test("renderDocx renders agent tasks as action items", () => {
  const doc = parse(`::agent_task{id="task1" scope="weekly" owner="Research" due="2026-06-01" done}
Refresh stale citations.
::

::todo{id="todo1" status="Needs **review**" priority="high"}
Review the Word handoff.
::`);
  const docx = renderDocx(doc);
  const documentXml = storedZipEntries(docx).get("word/document.xml") ?? "";

  assert.match(documentXml, /xmlns:w14="http:\/\/schemas\.microsoft\.com\/office\/word\/2010\/wordml"/);
  assert.match(documentXml, /mc:Ignorable="w14"/);
  assert.equal(documentXml.match(/<w14:checkbox>/g)?.length, 2);
  assert.match(documentXml, /<w:alias w:val="Agent task status"\/>[\s\S]*<w:tag w:val="noma-task:task1"\/>[\s\S]*<w14:checked w14:val="1"\/>[\s\S]*<w:t>&#x2612;<\/w:t>/);
  assert.match(documentXml, /<w:alias w:val="Todo status"\/>[\s\S]*<w:tag w:val="noma-task:todo1"\/>[\s\S]*<w14:checked w14:val="0"\/>[\s\S]*<w:t>&#x2610;<\/w:t>/);
  assert.match(documentXml, /<w14:checkedState w14:val="2612" w14:font="MS Gothic"\/>/);
  assert.match(documentXml, /<w14:uncheckedState w14:val="2610" w14:font="MS Gothic"\/>/);
  assert.doesNotMatch(documentXml, /\[x\] /);
  assert.doesNotMatch(documentXml, /\[ \] /);
  assert.match(documentXml, /Agent task/);
  assert.match(documentXml, />Todo</);
  assert.doesNotMatch(documentXml, /\*\*review\*\*/);
  assert.match(documentXml, /<w:t xml:space="preserve"> \(Needs <\/w:t><\/w:r><w:r><w:rPr><w:b\/><w:color w:val="304B75"\/><\/w:rPr><w:t xml:space="preserve">review<\/w:t>/);
  assert.match(documentXml, /Refresh stale citations\./);
  assert.match(documentXml, /Review the Word handoff\./);
  assert.match(documentXml, /scope: weekly · owner: Research · due: 2026-06-01/);
  assert.match(documentXml, /priority: high/);
  assert.match(documentXml, /w:name="n_task1_/);
  assert.match(documentXml, /w:name="n_todo1_/);
});

test("renderDocx renders memory profile blocks as typed Word panels", () => {
  const doc = parse(`::memory_index{id="index"}
- [[user_handle]] — primary handle
- [[project_state]] — current project state
::

::memory{id="user_handle" type="user" confidence=0.95 last_seen="2026-05-09" scope="global" source="profile"}
ferax564 is the public authorship handle.
::

::memory{id="project_state" type="project" confidence=0.8 last_seen="2026-05-20" superseded_by="user_handle"}
Project context is tracked as patchable memory.
::`);
  const docx = renderDocx(doc);
  const documentXml = storedZipEntries(docx).get("word/document.xml") ?? "";

  assert.match(documentXml, /Memory index/);
  assert.match(documentXml, /<w:hyperlink w:anchor="n_user_handle_/);
  assert.match(documentXml, /primary handle/);
  assert.match(documentXml, /w:name="n_index_/);
  assert.doesNotMatch(documentXml, /memory_index/);

  assert.match(documentXml, /User memory: user_handle/);
  assert.match(documentXml, /ferax564 is the public authorship handle\./);
  assert.match(documentXml, /type: user[\s\S]*confidence: 0\.95[\s\S]*last seen: 2026-05-09/);
  assert.match(documentXml, /scope: global/);
  assert.match(documentXml, /source: /);
  assert.match(documentXml, /<w:t xml:space="preserve">profile<\/w:t>/);
  assert.match(documentXml, /w:name="n_user_handle_/);
  assert.match(documentXml, /w:fill="EAF2EF"/);
  assert.doesNotMatch(documentXml, /memory \(type=user/);

  assert.match(documentXml, /Project memory: project_state/);
  assert.match(documentXml, /Project context is tracked as patchable memory\./);
  assert.match(documentXml, /type: project[\s\S]*confidence: 0\.8[\s\S]*last seen: 2026-05-20/);
  assert.match(documentXml, /superseded by: /);
  assert.match(documentXml, /<w:hyperlink w:anchor="n_user_handle_/);
  assert.match(documentXml, /w:name="n_project_state_/);
  assert.match(documentXml, /w:fill="EFF6F8"/);
  assert.doesNotMatch(documentXml, /memory \(type=project/);
});

test("renderDocx renders artifact action blocks as Word actions", () => {
  const doc = parse(`# Review {id="review"}

::claim{id="claim1"}
Evidence-backed claim.
::

::button{id="cta" href="https://example.com/start"}
Label: Open review room
::

::export_button{id="copy-claim" format="prompt" target="claim1"}
Label: Copy claim prompt
::

::control{id="growth-rate" type="slider" min=0 max=20 default=8 step=1 label="Growth rate"}
::

::control{id="scenario" type="select" default=1 options="0.8=Downside,1=Base,1.2=Upside" label="Scenario"}
::

::control{id="include-risk" type="toggle" default=true label="Include risk"}
::

::control{id="review-date" type="date" default="2026-05-24" date_format="yyyy-MM-dd" label="Review date"}
::
`);
  const docx = renderDocx(doc);
  const entries = storedZipEntries(docx);
  const documentXml = entries.get("word/document.xml") ?? "";
  const rels = entries.get("word/_rels/document.xml.rels") ?? "";
  const styles = entries.get("word/styles.xml") ?? "";

  assert.match(documentXml, /<w:pStyle w:val="NomaAction"\/>/);
  assert.match(documentXml, /<w:hyperlink r:id="rId\d+" w:history="1">[\s\S]*Open review room/);
  assert.doesNotMatch(documentXml, /Label: Open review room/);
  assert.match(documentXml, /w:name="n_cta_/);
  assert.match(rels, /Target="https:\/\/example\.com\/start" TargetMode="External"/);

  assert.match(documentXml, /Export action: /);
  assert.match(documentXml, /Copy claim prompt/);
  assert.doesNotMatch(documentXml, /Label: Copy claim prompt/);
  assert.match(documentXml, /target: /);
  assert.match(documentXml, /<w:hyperlink w:anchor="n_claim1_/);
  assert.match(documentXml, /format: prompt/);
  assert.match(documentXml, /w:name="n_copy_claim_/);

  assert.match(documentXml, /Control: Growth rate/);
  assert.match(documentXml, /<w:alias w:val="Control: Growth rate"\/>/);
  assert.match(documentXml, /<w:tag w:val="noma-control:growth-rate"\/>/);
  assert.match(documentXml, /<w:text\/>/);
  assert.match(documentXml, /<w:sdtContent><w:r><w:t xml:space="preserve">8<\/w:t><\/w:r><\/w:sdtContent>/);
  assert.match(documentXml, /type: slider · default: 8 · min: 0 · max: 20 · step: 1/);
  assert.match(documentXml, /w:name="n_growth_rate_/);
  assert.match(documentXml, /<w:alias w:val="Control: Scenario"\/>[\s\S]*<w:tag w:val="noma-control:scenario"\/>[\s\S]*<w:dropDownList>[\s\S]*<w:listItem w:displayText="Downside" w:value="0\.8"\/>[\s\S]*<w:listItem w:displayText="Base" w:value="1"\/>[\s\S]*<w:listItem w:displayText="Upside" w:value="1\.2"\/>[\s\S]*<w:t xml:space="preserve">Base<\/w:t>/);
  assert.match(documentXml, /<w:alias w:val="Control: Include risk"\/>[\s\S]*<w:tag w:val="noma-control:include-risk"\/>[\s\S]*<w14:checked w14:val="1"\/>[\s\S]*<w:t>&#x2612;<\/w:t>/);
  assert.match(documentXml, /<w:alias w:val="Control: Review date"\/>[\s\S]*<w:tag w:val="noma-control:review-date"\/>[\s\S]*<w:date w:fullDate="2026-05-24T00:00:00Z">[\s\S]*<w:dateFormat w:val="yyyy-MM-dd"\/>[\s\S]*<w:storeMappedDataAs w:val="dateTime"\/>[\s\S]*<w:t xml:space="preserve">2026-05-24<\/w:t>/);
  assert.match(documentXml, /type: select · default: 1/);
  assert.match(documentXml, /type: toggle · default: true/);
  assert.match(documentXml, /type: date · default: 2026-05-24/);
  assert.match(styles, /<w:style w:type="paragraph" w:styleId="NomaAction">/);
});

test("renderDocx binds controls to custom XML form data", () => {
  const doc = parse(`::control{id="review-title" type="text" default="Draft memo" label="Review title"}
::

::control{id="scenario" type="select" default="base" options="base=Base,upside=Upside" label="Scenario"}
::

::control{id="approved" type="toggle" default=false label="Approved"}
::
`);
  const docx = renderDocx(doc);
  const entries = storedZipEntries(docx);
  const documentXml = entries.get("word/document.xml") ?? "";
  const rootRels = entries.get("_rels/.rels") ?? "";
  const contentTypes = entries.get("[Content_Types].xml") ?? "";
  const controlData = entries.get("customXml/item1.xml") ?? "";
  const controlDataRels = entries.get("customXml/_rels/item1.xml.rels") ?? "";
  const controlDataProps = entries.get("customXml/itemProps1.xml") ?? "";

  assert.match(rootRels, /Type="http:\/\/schemas\.openxmlformats\.org\/officeDocument\/2006\/relationships\/customXml" Target="customXml\/item1\.xml"/);
  assert.match(contentTypes, /PartName="\/customXml\/itemProps1\.xml" ContentType="application\/vnd\.openxmlformats-officedocument\.customXmlProperties\+xml"/);
  assert.match(controlDataRels, /Type="http:\/\/schemas\.openxmlformats\.org\/officeDocument\/2006\/relationships\/customXmlProps" Target="itemProps1\.xml"/);
  assert.match(controlDataProps, /<ds:datastoreItem ds:itemID="\{4E1F6C8C-7091-4A42-A5BD-6B5C229E7B0A\}"/);

  assert.match(controlData, /<noma:controls xmlns:noma="urn:noma:controls">/);
  assert.match(controlData, /<noma:control id="review-title" type="text">[\s\S]*<noma:label>Review title<\/noma:label>[\s\S]*<noma:value>Draft memo<\/noma:value>/);
  assert.match(controlData, /<noma:control id="scenario" type="select">[\s\S]*<noma:value>base<\/noma:value>/);
  assert.match(controlData, /<noma:control id="approved" type="toggle">[\s\S]*<noma:value>false<\/noma:value>/);

  assert.match(documentXml, /<w:tag w:val="noma-control:review-title"\/><w:dataBinding w:prefixMappings="xmlns:noma=&apos;urn:noma:controls&apos;" w:xpath="\/noma:controls\[1\]\/noma:control\[@id=&apos;review-title&apos;\]\[1\]\/noma:value\[1\]" w:storeItemID="\{4E1F6C8C-7091-4A42-A5BD-6B5C229E7B0A\}"\/><w:text\/>/);
  assert.match(documentXml, /<w:tag w:val="noma-control:scenario"\/><w:dataBinding[\s\S]*w:xpath="\/noma:controls\[1\]\/noma:control\[@id=&apos;scenario&apos;\]\[1\]\/noma:value\[1\]"[\s\S]*<w:dropDownList>/);
  assert.match(documentXml, /<w:tag w:val="noma-control:approved"\/><w:dataBinding[\s\S]*w:xpath="\/noma:controls\[1\]\/noma:control\[@id=&apos;approved&apos;\]\[1\]\/noma:value\[1\]"[\s\S]*<w14:checkbox>/);
});

test("renderDocx preserves Word content-control lock metadata", () => {
  const doc = parse(`::control{id="review-title" type="text" default="Draft memo" lock="control" label="Review title"}
::

::control{id="scenario" type="select" default="base" options="base=Base,upside=Upside" lock="content" label="Scenario"}
::

::control{id="approved" type="toggle" default=false lock="all" label="Approved"}
::

::control{id="review-date" type="date" default="2026-05-24" locked label="Review date"}
::
`);
  const docx = renderDocx(doc);
  const documentXml = storedZipEntries(docx).get("word/document.xml") ?? "";

  assert.match(documentXml, /<w:tag w:val="noma-control:review-title"\/><w:lock w:val="sdtLocked"\/>[\s\S]*?<w:text\/>/);
  assert.match(documentXml, /<w:tag w:val="noma-control:scenario"\/><w:lock w:val="contentLocked"\/>[\s\S]*?<w:dropDownList>/);
  assert.match(documentXml, /<w:tag w:val="noma-control:approved"\/><w:lock w:val="sdtContentLocked"\/>[\s\S]*?<w14:checkbox>/);
  assert.match(documentXml, /<w:tag w:val="noma-control:review-date"\/><w:lock w:val="sdtLocked"\/>[\s\S]*?<w:date w:fullDate="2026-05-24T00:00:00Z">/);
});

test("renderDocx preserves semantic block metadata", () => {
  const doc = parse(`::claim{id="claim1" confidence=0.7}
Claim body.
::

::evidence{id="ev1" for="claim1" source="source1" accessed="2026-05-24"}
Supporting evidence.
::

::counterevidence{id="ce1" for="claim1" source="https://counter.example/report"}
Contradicting evidence.
::

::risk{id="risk1" severity="high" owner="Research" status="watching"}
Risk body.
::

::decision{id="decision1" status="accepted" owner="Andrea" date="2026-05-24"}
Decision body.
::

::open_question{id="oq1" owner="Ops" due="2026-06-01" status="open"}
Question body.
::

::citation{id="source1" source="Interview log"}
Source details.
::
`);
  const docx = renderDocx(doc);
  const entries = storedZipEntries(docx);
  const documentXml = entries.get("word/document.xml") ?? "";
  const rels = entries.get("word/_rels/document.xml.rels") ?? "";

  assert.match(documentXml, /Evidence/);
  assert.match(documentXml, /for: /);
  assert.match(documentXml, /<w:hyperlink w:anchor="n_claim1_/);
  assert.match(documentXml, /source: /);
  assert.match(documentXml, /<w:hyperlink w:anchor="n_source1_/);
  assert.match(documentXml, /accessed: 2026-05-24/);

  assert.match(documentXml, /Counterevidence/);
  assert.doesNotMatch(documentXml, /counterevidence \(for=claim1/);
  assert.match(rels, /Target="https:\/\/counter\.example\/report" TargetMode="External"/);

  assert.match(documentXml, /severity: high[\s\S]*owner: Research[\s\S]*status: watching/);
  assert.match(documentXml, /status: accepted[\s\S]*owner: Andrea[\s\S]*date: 2026-05-24/);
  assert.match(documentXml, /Open question/);
  assert.match(documentXml, /status: open[\s\S]*owner: Ops[\s\S]*due: 2026-06-01/);
});

test("renderDocx renders rich metadata values as native Word runs", () => {
  const doc = parse(`::metric{id="arr" label="ARR" value="10" unit="M" status="Needs **review**" trend="Up *fast*" change="check \`model\`"}
::

::api{id="payments" title="Payments" version="v1 **beta**" status="Ready *soon*" owner="AI \`docs\`"}
Body.
::

::review{id="review1" for="arr" status="needs **changes**" reviewer="Andrea *lead*" due="2026-06-01"}
Review body.
::
`);
  const documentXml = storedZipEntries(renderDocx(doc)).get("word/document.xml") ?? "";

  assert.doesNotMatch(documentXml, /\*\*review\*\*/);
  assert.doesNotMatch(documentXml, /\*fast\*/);
  assert.doesNotMatch(documentXml, /`model`/);
  assert.match(documentXml, /<w:t xml:space="preserve">status: Needs <\/w:t><\/w:r><w:r><w:rPr><w:b\/><\/w:rPr><w:t xml:space="preserve">review<\/w:t>/);
  assert.match(documentXml, /<w:t xml:space="preserve">trend: Up <\/w:t><\/w:r><w:r><w:rPr><w:i\/><\/w:rPr><w:t xml:space="preserve">fast<\/w:t>/);
  assert.match(documentXml, /<w:t xml:space="preserve">change: check <\/w:t><\/w:r><w:r><w:rPr><w:rFonts w:ascii="Courier New"[\s\S]*<w:t xml:space="preserve">model<\/w:t>/);
  assert.match(documentXml, /<w:t xml:space="preserve">version: v1 <\/w:t><\/w:r><w:r><w:rPr><w:b\/><\/w:rPr><w:t xml:space="preserve">beta<\/w:t>/);
  assert.match(documentXml, /<w:t xml:space="preserve">reviewer: Andrea <\/w:t><\/w:r><w:r><w:rPr><w:i\/><\/w:rPr><w:t xml:space="preserve">lead<\/w:t>/);
});

test("renderDocx renders review, provenance, and confidence as collaboration metadata", () => {
  const doc = parse(`::claim{id="claim1" confidence=0.7}
Claim body.
::

::citation{id="source1" source="Interview log" url="https://source.example/report"}
Source details.
::

::review{id="review1" for="claim1" status="needs_changes" reviewer="Andrea" due="2026-06-01"}
Tighten the support before sending.
::

::provenance{id="prov1" for="claim1" source="source1" tool="refresh-agent" by="Research" commit="abc123" at="2026-05-24"}
Updated during source refresh.
::

::confidence{id="conf1" for="claim1" value=0.82 basis="new deployment evidence" source="source1" updated="2026-05-24"}
::
`);
  const docx = renderDocx(doc);
  const documentXml = storedZipEntries(docx).get("word/document.xml") ?? "";

  assert.match(documentXml, /Review/);
  assert.match(documentXml, /<w:hyperlink w:anchor="n_claim1_/);
  assert.match(documentXml, /Tighten the support before sending\./);
  assert.match(documentXml, /status: needs_changes[\s\S]*reviewer: Andrea[\s\S]*due: 2026-06-01/);
  assert.match(documentXml, /w:name="n_review1_/);
  assert.doesNotMatch(documentXml, /review \(for=claim1/);

  assert.match(documentXml, /Provenance/);
  assert.match(documentXml, /Updated during source refresh\./);
  assert.match(documentXml, /source: /);
  assert.match(documentXml, /<w:hyperlink w:anchor="n_source1_/);
  assert.match(documentXml, /tool: refresh-agent[\s\S]*by: Research[\s\S]*commit: abc123[\s\S]*at: 2026-05-24/);
  assert.match(documentXml, /w:name="n_prov1_/);
  assert.doesNotMatch(documentXml, /provenance \(for=claim1/);

  assert.match(documentXml, /Confidence/);
  assert.match(documentXml, /value: 0\.82[\s\S]*basis: new deployment evidence[\s\S]*source: /);
  assert.match(documentXml, /updated: 2026-05-24/);
  assert.match(documentXml, /w:name="n_conf1_/);
  assert.doesNotMatch(documentXml, /confidence \(for=claim1/);
});

test("renderDocx renders state_change as a readable Word delta", () => {
  const doc = parse(`::claim{id="c1" confidence=0.6}
Claim body.
::

::state_change{id="sc1" block="c1" attribute="confidence" from=0.6 to=0.9 reason="new evidence" at="2026-05-24"}
Raised after source refresh.
::`);
  const docx = renderDocx(doc);
  const documentXml = storedZipEntries(docx).get("word/document.xml") ?? "";

  assert.match(documentXml, /State change/);
  assert.match(documentXml, /<w:hyperlink w:anchor="n_c1_/);
  assert.match(documentXml, /<w:t xml:space="preserve">confidence<\/w:t>/);
  assert.match(documentXml, /<w:strike\/><w:color w:val="7A4B5F"\/>[\s\S]*<w:t xml:space="preserve">0\.6<\/w:t>/);
  assert.match(documentXml, /<w:b\/><w:color w:val="315A34"\/>[\s\S]*<w:t xml:space="preserve">0\.9<\/w:t>/);
  assert.match(documentXml, /Raised after source refresh\./);
  assert.match(documentXml, /at 2026-05-24 · why new evidence/);
  assert.doesNotMatch(documentXml, /state_change \(block=c1/);
});

test("renderDocx renders rich state_change values as native Word runs", () => {
  const doc = parse(`::claim{id="c1" confidence=0.6}
Claim body.
::

::state_change{id="sc1" block="c1" attribute="summary" from="Old **claim** [source](https://example.com/old) and \`model\`." to="New *claim* [[c1]] and [source](https://example.com/new)." reason="Because **evidence**" at="2026-05-24"}
Raised after source refresh.
::`);
  const docx = renderDocx(doc);
  const entries = storedZipEntries(docx);
  const documentXml = entries.get("word/document.xml") ?? "";
  const rels = entries.get("word/_rels/document.xml.rels") ?? "";

  assert.doesNotMatch(documentXml, /\*\*claim\*\*/);
  assert.doesNotMatch(documentXml, /\*claim\*/);
  assert.doesNotMatch(documentXml, /`model`/);
  assert.match(documentXml, /<w:strike\/><w:color w:val="7A4B5F"\/>[\s\S]*<w:t xml:space="preserve">Old <\/w:t>/);
  assert.match(documentXml, /<w:b\/><w:strike\/><w:color w:val="7A4B5F"\/>[\s\S]*<w:t xml:space="preserve">claim<\/w:t>/);
  assert.match(documentXml, /<w:strike\/><w:color w:val="7A4B5F"\/><w:rFonts w:ascii="Courier New"[\s\S]*<w:t xml:space="preserve">model<\/w:t>/);
  assert.match(documentXml, /<w:b\/><w:color w:val="315A34"\/>[\s\S]*<w:t xml:space="preserve">New <\/w:t>/);
  assert.match(documentXml, /<w:b\/><w:i\/><w:color w:val="315A34"\/>[\s\S]*<w:t xml:space="preserve">claim<\/w:t>/);
  assert.match(documentXml, /<w:hyperlink w:anchor="n_c1_/);
  assert.match(documentXml, /why Because <\/w:t><\/w:r><w:r><w:rPr><w:b\/><\/w:rPr><w:t xml:space="preserve">evidence<\/w:t>/);
  assert.match(rels, /Target="https:\/\/example\.com\/old" TargetMode="External"/);
  assert.match(rels, /Target="https:\/\/example\.com\/new" TargetMode="External"/);
});

test("renderDocx renders math blocks as Office Math", () => {
  const doc = parse(`::math{id="eq1"}
w_t = \\frac{a}{b}
::`);
  const docx = renderDocx(doc);
  const entries = storedZipEntries(docx);
  const documentXml = entries.get("word/document.xml") ?? "";
  const styles = entries.get("word/styles.xml") ?? "";

  assert.match(documentXml, /xmlns:m="http:\/\/schemas\.openxmlformats\.org\/officeDocument\/2006\/math"/);
  assert.match(documentXml, /<w:pStyle w:val="NomaMath"\/>/);
  assert.match(documentXml, /<m:oMath><m:r><m:rPr><m:nor\/><\/m:rPr><m:t>w_t = \\frac\{a\}\{b\}<\/m:t><\/m:r><\/m:oMath>/);
  assert.match(documentXml, /w:name="n_eq1_/);
  assert.doesNotMatch(documentXml, /<w:pStyle w:val="NomaCode"\/>[\s\S]*w_t = \\frac/);
  assert.match(styles, /<w:style w:type="paragraph" w:styleId="NomaMath">/);
  assert.match(styles, /Cambria Math/);
});

test("renderDocx renders inline math as Office Math", () => {
  const doc = parse(`# Equation Review {id="equation-review"}

Inline $E=mc^2$ and \\(a+b\\) survive as Word math. Budget stays $42M.

| Name | Formula |
| --- | --- |
| Loss | $$\\sum_i x_i$$ |
| Bound | \\[x+y\\] |
`);
  const docx = renderDocx(doc);
  const documentXml = storedZipEntries(docx).get("word/document.xml") ?? "";

  assert.match(documentXml, /<w:pStyle w:val="Heading1"\/>/);
  assert.equal(documentXml.match(/<m:oMath>/g)?.length, 4);
  assert.match(documentXml, /<m:t>E=mc\^2<\/m:t>/);
  assert.match(documentXml, /<m:t>a\+b<\/m:t>/);
  assert.match(documentXml, /<m:t>\\sum_i x_i<\/m:t>/);
  assert.match(documentXml, /<m:t>x\+y<\/m:t>/);
  assert.match(documentXml, /<w:t xml:space="preserve"> survive as Word math\. Budget stays \$42M\.<\/w:t>/);
  assert.doesNotMatch(documentXml, /\$E=mc\^2\$/);
  assert.doesNotMatch(documentXml, /\$\$\\sum_i x_i\$\$/);
});

test("renderDocx renders external visual specs as Word-readable source fallbacks", () => {
  const doc = parse(`::diagram{id="flow" kind="mermaid"}
flowchart LR
  A --> B
::

::plotly{id="interactive-chart"}
{"data":[{"type":"bar","y":[1,2,3]}]}
::
`);
  const docx = renderDocx(doc);
  const documentXml = storedZipEntries(docx).get("word/document.xml") ?? "";

  assert.match(documentXml, /Diagram \(mermaid\)/);
  assert.match(documentXml, /source: mermaid/);
  assert.match(documentXml, /flowchart LR/);
  assert.match(documentXml, /A --&gt; B/);
  assert.match(documentXml, /w:name="n_flow_/);
  assert.doesNotMatch(documentXml, /diagram \(kind=mermaid/);

  assert.match(documentXml, /Plotly chart/);
  assert.match(documentXml, /interactive JSON spec/);
  assert.match(documentXml, /"type":"bar"/);
  assert.match(documentXml, /w:name="n_interactive_chart_/);
  assert.doesNotMatch(documentXml, /<w:t xml:space="preserve">plotly<\/w:t>/);
});

test("renderDocx embeds data-uri SVG figures and reads natural dimensions", () => {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100"><rect width="200" height="100" fill="#2B5265"/></svg>`;
  const doc = parse(`::figure{id="svg-fig" caption="SVG chart" alt="Vector chart" src="data:image/svg+xml,${encodeURIComponent(svg)}"}\n::\n`);
  const docx = renderDocx(doc);
  const entries = storedZipEntries(docx);
  const buffers = storedZipEntryBuffers(docx);

  assert.equal(buffers.get("word/media/image1.svg")?.toString("utf8"), svg);

  const documentXml = entries.get("word/document.xml") ?? "";
  assert.match(documentXml, /Figure[\s\S]*<w:instrText xml:space="preserve"> SEQ Figure \\\* ARABIC <\/w:instrText>[\s\S]*SVG chart/);
  assert.match(documentXml, /<w:drawing>[\s\S]*<w:pStyle w:val="NomaCaption"\/>[\s\S]*Figure[\s\S]*SVG chart/);
  assert.match(documentXml, /<wp:extent cx="1905000" cy="952500"\/>/);
  assert.match(documentXml, /<wp:docPr id="1" name="image1\.svg" descr="Vector chart"\/>/);
  assert.match(documentXml, /<a:blip r:embed="rId3"\/>/);

  const contentTypes = entries.get("[Content_Types].xml") ?? "";
  assert.match(contentTypes, /<Default Extension="svg" ContentType="image\/svg\+xml"\/>/);
});

test("renderDocx embeds resolved plots as DOCX SVG media", () => {
  const doc = parse(`::dataset{id="ds1"}
schema:
  vertical: string
  growth: number
rows:
  - [legal, 18]
  - [finance, 24]
  - [healthcare, 29]
::

::plot{id="plot1" type="bar" dataset="ds1" column="growth" xcolumn="vertical" title="Growth" width=320 height=140}
::
`);
  const docx = renderDocx(doc);
  const entries = storedZipEntries(docx);
  const buffers = storedZipEntryBuffers(docx);
  const svg = buffers.get("word/media/image1.svg")?.toString("utf8") ?? "";

  assert.match(svg, /<svg viewBox="0 0 320 140"/);
  assert.match(svg, /<rect /);
  assert.doesNotMatch(svg, /currentColor/);
  assert.match(svg, /#2B5265/);

  const documentXml = entries.get("word/document.xml") ?? "";
  assert.match(documentXml, /Plot[\s\S]*<w:instrText xml:space="preserve"> SEQ Plot \\\* ARABIC <\/w:instrText>[\s\S]*Growth/);
  assert.match(documentXml, /<w:drawing>[\s\S]*<w:pStyle w:val="NomaCaption"\/>[\s\S]*Plot[\s\S]*Growth/);
  assert.match(documentXml, /<wp:extent cx="3048000" cy="1333500"\/>/);
  assert.match(documentXml, /<a:blip r:embed="rId3"\/>/);
  assert.match(documentXml, /bar plot, 3 points/);

  const rels = entries.get("word/_rels/document.xml.rels") ?? "";
  assert.match(rels, /Type="http:\/\/schemas\.openxmlformats\.org\/officeDocument\/2006\/relationships\/image" Target="media\/image1\.svg"/);

  const contentTypes = entries.get("[Content_Types].xml") ?? "";
  assert.match(contentTypes, /<Default Extension="svg" ContentType="image\/svg\+xml"\/>/);
});
