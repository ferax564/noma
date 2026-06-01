import { test } from "node:test";
import assert from "node:assert/strict";
import { parse } from "../src/parser.js";
import { renderDocx } from "../src/renderer-docx.js";
import { extractDocxControlData } from "../src/docx-control-data.js";
import { storedDocx } from "./docx-test-zip.js";

test("extractDocxControlData reads bound Noma controls from DOCX custom XML", () => {
  const doc = parse(`::control{id="review-title" type="text" default="R&D <memo>" label="Review title"}
::

::control{id="scenario" type="select" default="base" options="base=Base,upside=Upside" label="Scenario"}
::

::control{id="approved" type="toggle" default=false label="Approved"}
::
`);
  const data = extractDocxControlData(renderDocx(doc));

  assert.deepEqual(data.controls, [
    {
      id: "review-title",
      type: "text",
      label: "Review title",
      value: "R&D <memo>",
    },
    {
      id: "scenario",
      type: "select",
      label: "Scenario",
      value: "base",
    },
    {
      id: "approved",
      type: "toggle",
      label: "Approved",
      value: "false",
    },
  ]);
  assert.deepEqual(data.tasks, []);
});

test("extractDocxControlData returns an empty control list when no custom XML exists", () => {
  const doc = parse(`# Plain\n\nNo controls here.\n`);
  assert.deepEqual(extractDocxControlData(renderDocx(doc)), { controls: [], tasks: [] });
});

test("extractDocxControlData prefers visible content-control values over stale custom XML", () => {
  const data = extractDocxControlData(storedControlDocx({ includeCustomXml: true }));

  assert.deepEqual(data.controls, [
    {
      id: "review-title",
      type: "text",
      label: "Review title",
      value: "Final memo",
    },
    {
      id: "scenario",
      type: "select",
      label: "Scenario",
      value: "upside",
    },
    {
      id: "review-date",
      type: "date",
      label: "Review date",
      value: "2026-05-25",
    },
    {
      id: "approved",
      type: "toggle",
      label: "Approved",
      value: "true",
    },
  ]);
  assert.deepEqual(data.tasks, []);
});

test("extractDocxControlData reads visible controls when custom XML is missing", () => {
  assert.deepEqual(extractDocxControlData(storedControlDocx({ includeCustomXml: false })).controls, [
    {
      id: "review-title",
      type: "text",
      label: "Review title",
      value: "Final memo",
    },
    {
      id: "scenario",
      type: "select",
      label: "Scenario",
      value: "upside",
    },
    {
      id: "review-date",
      type: "date",
      label: "Review date",
      value: "2026-05-25",
    },
    {
      id: "approved",
      type: "toggle",
      label: "Approved",
      value: "true",
    },
  ]);
});

test("extractDocxControlData preserves leading and trailing visible control spaces", () => {
  const data = extractDocxControlData(
    storedDocx({
      "word/document.xml": `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p><w:sdt><w:sdtPr><w:alias w:val="Control: Reference code"/><w:tag w:val="noma-control:reference-code"/><w:text/></w:sdtPr><w:sdtContent><w:r><w:t xml:space="preserve">  ACME-42  </w:t></w:r></w:sdtContent></w:sdt></w:p>
  </w:body>
</w:document>`,
      "customXml/item1.xml": `<noma:controls xmlns:noma="urn:noma:controls">
  <noma:control id="reference-code" type="text"><noma:label>Reference code</noma:label><noma:value>ACME-42</noma:value></noma:control>
</noma:controls>`,
    }),
  );

  assert.deepEqual(data.controls, [
    {
      id: "reference-code",
      type: "text",
      label: "Reference code",
      value: "  ACME-42  ",
    },
  ]);
});

test("extractDocxControlData reads visible combo box controls as select values", () => {
  const data = extractDocxControlData(
    storedDocx({
      "word/document.xml": `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p><w:sdt><w:sdtPr><w:alias w:val="Control: Scenario"/><w:tag w:val="noma-control:scenario"/><w:comboBox><w:listItem w:displayText="Base" w:value="base"/><w:listItem w:displayText="Upside" w:value="upside"/></w:comboBox></w:sdtPr><w:sdtContent><w:r><w:t>Upside</w:t></w:r></w:sdtContent></w:sdt></w:p>
  </w:body>
</w:document>`,
    }),
  );

  assert.deepEqual(data.controls, [
    {
      id: "scenario",
      type: "select",
      label: "Scenario",
      value: "upside",
    },
  ]);
});

test("extractDocxControlData reads native task checkbox states", () => {
  const doc = parse(`::agent_task{id="task1" scope="weekly" owner="Research" done}
Review the thesis.
::

::todo{id="todo1" status="open" priority="high"}
Follow up.
::
`);

  assert.deepEqual(extractDocxControlData(renderDocx(doc)).tasks, [
    { id: "task1", checked: true },
    { id: "todo1", checked: false },
  ]);
});

test("extractDocxControlData reads visible controls and tasks from headers and footers", () => {
  const data = extractDocxControlData(
    storedDocx({
      "word/header1.xml": headerControlXml(),
      "word/footer1.xml": footerControlXml(),
      "word/document.xml": emptyDocumentXml(),
      "customXml/item1.xml": `<noma:controls xmlns:noma="urn:noma:controls">
  <noma:control id="running-title" type="text"><noma:label>Running title</noma:label><noma:value>Draft title</noma:value></noma:control>
</noma:controls>`,
    }),
  );

  assert.deepEqual(data.controls, [
    {
      id: "running-title",
      type: "text",
      label: "Running title",
      value: "Board final",
    },
    {
      id: "approved",
      type: "toggle",
      label: "Approved",
      value: "true",
    },
  ]);
  assert.deepEqual(data.tasks, [{ id: "footer-task", checked: true }]);
});

test("extractDocxControlData ignores deleted tracked text inside visible controls", () => {
  const data = extractDocxControlData(
    storedDocx({
      "word/document.xml": `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p><w:sdt><w:sdtPr><w:alias w:val="Control: Review title"/><w:tag w:val="noma-control:review-title"/><w:text/></w:sdtPr><w:sdtContent><w:del w:id="5" w:author="Reviewer" w:date="2026-05-25T09:00:00Z"><w:r><w:delText>Draft memo</w:delText></w:r></w:del><w:ins w:id="6" w:author="Reviewer" w:date="2026-05-25T09:00:00Z"><w:r><w:t>Final memo</w:t></w:r></w:ins></w:sdtContent></w:sdt></w:p>
  </w:body>
</w:document>`,
      "customXml/item1.xml": `<noma:controls xmlns:noma="urn:noma:controls">
  <noma:control id="review-title" type="text"><noma:label>Review title</noma:label><noma:value>Draft memo</noma:value></noma:control>
</noma:controls>`,
    }),
  );

  assert.deepEqual(data.controls, [
    {
      id: "review-title",
      type: "text",
      label: "Review title",
      value: "Final memo",
    },
  ]);
});

test("extractDocxControlData ignores self-closing tokens inside deleted tracked control text", () => {
  const data = extractDocxControlData(
    storedDocx({
      "word/document.xml": `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p><w:sdt><w:sdtPr><w:alias w:val="Control: Review title"/><w:tag w:val="noma-control:review-title"/><w:text/></w:sdtPr><w:sdtContent><w:r><w:t>Final</w:t></w:r><w:del w:id="5" w:author="Reviewer" w:date="2026-05-25T09:00:00Z"><w:r><w:br/><w:noBreakHyphen/><w:tab/><w:delText>old break</w:delText></w:r></w:del><w:r><w:t>memo</w:t></w:r></w:sdtContent></w:sdt></w:p>
  </w:body>
</w:document>`,
      "customXml/item1.xml": `<noma:controls xmlns:noma="urn:noma:controls">
  <noma:control id="review-title" type="text"><noma:label>Review title</noma:label><noma:value>Final memo</noma:value></noma:control>
</noma:controls>`,
    }),
  );

  assert.deepEqual(data.controls, [
    {
      id: "review-title",
      type: "text",
      label: "Review title",
      value: "Finalmemo",
    },
  ]);
});

test("extractDocxControlData ignores moved-from tracked control text and keeps moved-to text", () => {
  const data = extractDocxControlData(
    storedDocx({
      "word/document.xml": `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p><w:sdt><w:sdtPr><w:alias w:val="Control: Review title"/><w:tag w:val="noma-control:review-title"/><w:text/></w:sdtPr><w:sdtContent><w:r><w:t>Final </w:t></w:r><w:moveFrom w:id="5" w:author="Reviewer" w:date="2026-05-25T09:00:00Z"><w:r><w:t>old</w:t><w:br/><w:t>title</w:t></w:r></w:moveFrom><w:moveTo w:id="6" w:author="Reviewer" w:date="2026-05-25T09:00:00Z"><w:r><w:t>memo</w:t></w:r></w:moveTo></w:sdtContent></w:sdt></w:p>
  </w:body>
</w:document>`,
      "customXml/item1.xml": `<noma:controls xmlns:noma="urn:noma:controls">
  <noma:control id="review-title" type="text"><noma:label>Review title</noma:label><noma:value>Old title</noma:value></noma:control>
</noma:controls>`,
    }),
  );

  assert.deepEqual(data.controls, [
    {
      id: "review-title",
      type: "text",
      label: "Review title",
      value: "Final memo",
    },
  ]);
});

test("extractDocxControlData ignores range-marked moved-from control text and keeps moved-to text", () => {
  const data = extractDocxControlData(
    storedDocx({
      "word/document.xml": `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p><w:sdt><w:sdtPr><w:alias w:val="Control: Review title"/><w:tag w:val="noma-control:review-title"/><w:text/></w:sdtPr><w:sdtContent><w:r><w:t>Final </w:t></w:r><w:moveFromRangeStart w:id="15" w:author="Reviewer" w:date="2026-05-25T09:00:00Z"/><w:r><w:t>old</w:t><w:br/><w:t>title</w:t></w:r><w:moveFromRangeEnd w:id="15"/><w:moveToRangeStart w:id="16" w:author="Reviewer" w:date="2026-05-25T09:00:00Z"/><w:r><w:t>memo</w:t></w:r><w:moveToRangeEnd w:id="16"/></w:sdtContent></w:sdt></w:p>
  </w:body>
</w:document>`,
      "customXml/item1.xml": `<noma:controls xmlns:noma="urn:noma:controls">
  <noma:control id="review-title" type="text"><noma:label>Review title</noma:label><noma:value>Old title</noma:value></noma:control>
</noma:controls>`,
    }),
  );

  assert.deepEqual(data.controls, [
    {
      id: "review-title",
      type: "text",
      label: "Review title",
      value: "Final memo",
    },
  ]);
});

test("extractDocxControlData preserves Word carriage-return breaks in visible controls", () => {
  const data = extractDocxControlData(
    storedDocx({
      "word/document.xml": `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p><w:sdt><w:sdtPr><w:alias w:val="Control: Review notes"/><w:tag w:val="noma-control:review-notes"/><w:text/></w:sdtPr><w:sdtContent><w:r><w:t>First line</w:t><w:cr/><w:t>Second line</w:t></w:r></w:sdtContent></w:sdt></w:p>
  </w:body>
</w:document>`,
    }),
  );

  assert.deepEqual(data.controls, [
    {
      id: "review-notes",
      type: "text",
      label: "Review notes",
      value: "First line\nSecond line",
    },
  ]);
});

test("extractDocxControlData preserves paired Word empty run elements in visible controls", () => {
  const data = extractDocxControlData(
    storedDocx({
      "word/document.xml": `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p><w:sdt><w:sdtPr><w:alias w:val="Control: Review notes"/><w:tag w:val="noma-control:review-notes"/><w:text/></w:sdtPr><w:sdtContent><w:r><w:t>First</w:t><w:br></w:br><w:t>Second</w:t><w:tab></w:tab><w:t>Column</w:t><w:noBreakHyphen></w:noBreakHyphen><w:t>ready</w:t><w:softHyphen></w:softHyphen><w:t>term </w:t><w:sym w:font="Segoe UI Symbol" w:char="2713"></w:sym></w:r></w:sdtContent></w:sdt></w:p>
  </w:body>
</w:document>`,
    }),
  );

  assert.deepEqual(data.controls, [
    {
      id: "review-notes",
      type: "text",
      label: "Review notes",
      value: "First\nSecond\tColumn-ready\u00adterm \u2713",
    },
  ]);
});

test("extractDocxControlData preserves Word no-break hyphens in visible controls", () => {
  const data = extractDocxControlData(
    storedDocx({
      "word/document.xml": `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p><w:sdt><w:sdtPr><w:alias w:val="Control: Review title"/><w:tag w:val="noma-control:review-title"/><w:text/></w:sdtPr><w:sdtContent><w:r><w:t>Board</w:t><w:noBreakHyphen/><w:t>ready memo</w:t></w:r></w:sdtContent></w:sdt></w:p>
  </w:body>
</w:document>`,
    }),
  );

  assert.deepEqual(data.controls, [
    {
      id: "review-title",
      type: "text",
      label: "Review title",
      value: "Board-ready memo",
    },
  ]);
});

test("extractDocxControlData preserves Word positional tabs in visible controls", () => {
  const data = extractDocxControlData(
    storedDocx({
      "word/document.xml": `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p><w:sdt><w:sdtPr><w:alias w:val="Control: Review notes"/><w:tag w:val="noma-control:review-notes"/><w:text/></w:sdtPr><w:sdtContent><w:r><w:t>Metric</w:t><w:ptab w:relativeTo="margin" w:alignment="right" w:leader="none"/><w:t>Value</w:t></w:r></w:sdtContent></w:sdt></w:p>
  </w:body>
</w:document>`,
    }),
  );

  assert.deepEqual(data.controls, [
    {
      id: "review-notes",
      type: "text",
      label: "Review notes",
      value: "Metric\tValue",
    },
  ]);
});

test("extractDocxControlData preserves Word soft hyphens in visible controls", () => {
  const data = extractDocxControlData(
    storedDocx({
      "word/document.xml": `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p><w:sdt><w:sdtPr><w:alias w:val="Control: Review term"/><w:tag w:val="noma-control:review-term"/><w:text/></w:sdtPr><w:sdtContent><w:r><w:t>co</w:t><w:softHyphen/><w:t>operate</w:t></w:r></w:sdtContent></w:sdt></w:p>
  </w:body>
</w:document>`,
    }),
  );

  assert.deepEqual(data.controls, [
    {
      id: "review-term",
      type: "text",
      label: "Review term",
      value: "co\u00adoperate",
    },
  ]);
});

test("extractDocxControlData recovers checkbox states from Word symbol glyphs when metadata is stripped", () => {
  const data = extractDocxControlData(
    storedDocx({
      "word/document.xml": `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p><w:sdt><w:sdtPr><w:alias w:val="Control: Approved"/><w:tag w:val="noma-control:approved"/><w:text/></w:sdtPr><w:sdtContent><w:r><w:sym w:font="Segoe UI Symbol" w:char="2612"/></w:r></w:sdtContent></w:sdt></w:p>
    <w:p><w:sdt><w:sdtPr><w:alias w:val="Todo status"/><w:tag w:val="noma-task:review-task"/><w:text/></w:sdtPr><w:sdtContent><w:r><w:sym w:font="Segoe UI Symbol" w:char="2610"/></w:r></w:sdtContent></w:sdt></w:p>
  </w:body>
</w:document>`,
      "customXml/item1.xml": `<noma:controls xmlns:noma="urn:noma:controls">
  <noma:control id="approved" type="toggle"><noma:label>Approved</noma:label><noma:value>false</noma:value></noma:control>
</noma:controls>`,
    }),
  );

  assert.deepEqual(data.controls, [
    {
      id: "approved",
      type: "toggle",
      label: "Approved",
      value: "true",
    },
  ]);
  assert.deepEqual(data.tasks, [{ id: "review-task", checked: false }]);
});

test("extractDocxControlData recovers checkbox states from visible glyphs when metadata is stripped", () => {
  const data = extractDocxControlData(
    storedDocx({
      "word/document.xml": `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p><w:sdt><w:sdtPr><w:alias w:val="Control: Approved"/><w:tag w:val="noma-control:approved"/><w:text/></w:sdtPr><w:sdtContent><w:r><w:t>&#x2612;</w:t></w:r></w:sdtContent></w:sdt></w:p>
    <w:p><w:sdt><w:sdtPr><w:alias w:val="Todo status"/><w:tag w:val="noma-task:review-task"/><w:text/></w:sdtPr><w:sdtContent><w:r><w:t>&#x2610;</w:t></w:r></w:sdtContent></w:sdt></w:p>
  </w:body>
</w:document>`,
      "customXml/item1.xml": `<noma:controls xmlns:noma="urn:noma:controls">
  <noma:control id="approved" type="toggle"><noma:label>Approved</noma:label><noma:value>false</noma:value></noma:control>
</noma:controls>`,
    }),
  );

  assert.deepEqual(data.controls, [
    {
      id: "approved",
      type: "toggle",
      label: "Approved",
      value: "true",
    },
  ]);
  assert.deepEqual(data.tasks, [{ id: "review-task", checked: false }]);
});

test("extractDocxControlData treats present checked elements without values as checked", () => {
  const data = extractDocxControlData(
    storedDocx({
      "word/document.xml": `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml">
  <w:body>
    <w:p><w:sdt><w:sdtPr><w:alias w:val="Control: Approved"/><w:tag w:val="noma-control:approved"/><w14:checkbox><w14:checked/></w14:checkbox></w:sdtPr><w:sdtContent><w:r><w:t>&#x2612;</w:t></w:r></w:sdtContent></w:sdt></w:p>
    <w:p><w:sdt><w:sdtPr><w:alias w:val="Todo status"/><w:tag w:val="noma-task:review-task"/><w14:checkbox><w14:checked/></w14:checkbox></w:sdtPr><w:sdtContent><w:r><w:t>&#x2612;</w:t></w:r></w:sdtContent></w:sdt></w:p>
  </w:body>
</w:document>`,
    }),
  );

  assert.deepEqual(data.controls, [
    {
      id: "approved",
      type: "toggle",
      label: "Approved",
      value: "true",
    },
  ]);
  assert.deepEqual(data.tasks, [{ id: "review-task", checked: true }]);
});

function storedControlDocx(options: { includeCustomXml: boolean }): Buffer {
  return storedDocx({
    "word/document.xml": controlDocumentXml(),
    ...(options.includeCustomXml ? { "customXml/item1.xml": staleControlDataXml() } : {}),
  });
}

function emptyDocumentXml(): string {
  return `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body><w:p><w:r><w:t>No form fields here.</w:t></w:r></w:p></w:body>
</w:document>`;
}

function headerControlXml(): string {
  return `<w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:p><w:sdt><w:sdtPr><w:alias w:val="Control: Running title"/><w:tag w:val="noma-control:running-title"/><w:text/></w:sdtPr><w:sdtContent><w:r><w:t>Board final</w:t></w:r></w:sdtContent></w:sdt></w:p>
</w:hdr>`;
}

function footerControlXml(): string {
  return `<w:ftr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml">
  <w:p><w:sdt><w:sdtPr><w:alias w:val="Control: Approved"/><w:tag w:val="noma-control:approved"/><w14:checkbox><w14:checked w14:val="1"/></w14:checkbox></w:sdtPr><w:sdtContent><w:r><w:t>X</w:t></w:r></w:sdtContent></w:sdt></w:p>
  <w:p><w:sdt><w:sdtPr><w:alias w:val="Todo status"/><w:tag w:val="noma-task:footer-task"/><w14:checkbox><w14:checked w14:val="1"/></w14:checkbox></w:sdtPr><w:sdtContent><w:r><w:t>X</w:t></w:r></w:sdtContent></w:sdt></w:p>
</w:ftr>`;
}

function staleControlDataXml(): string {
  return `<noma:controls xmlns:noma="urn:noma:controls">
  <noma:control id="review-title" type="text"><noma:label>Review title</noma:label><noma:value>Draft memo</noma:value></noma:control>
  <noma:control id="scenario" type="select"><noma:label>Scenario</noma:label><noma:value>base</noma:value></noma:control>
  <noma:control id="review-date" type="date"><noma:label>Review date</noma:label><noma:value>2026-05-24</noma:value></noma:control>
  <noma:control id="approved" type="toggle"><noma:label>Approved</noma:label><noma:value>false</noma:value></noma:control>
</noma:controls>`;
}

function controlDocumentXml(): string {
  return `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml">
  <w:body>
    <w:p><w:sdt><w:sdtPr><w:alias w:val="Control: Review title"/><w:tag w:val="noma-control:review-title"/><w:text/></w:sdtPr><w:sdtContent><w:r><w:t>Final memo</w:t></w:r></w:sdtContent></w:sdt></w:p>
    <w:p><w:sdt><w:sdtPr><w:alias w:val="Control: Scenario"/><w:tag w:val="noma-control:scenario"/><w:dropDownList><w:listItem w:displayText="Base" w:value="base"/><w:listItem w:displayText="Upside" w:value="upside"/></w:dropDownList></w:sdtPr><w:sdtContent><w:r><w:t>Upside</w:t></w:r></w:sdtContent></w:sdt></w:p>
    <w:p><w:sdt><w:sdtPr><w:alias w:val="Control: Review date"/><w:tag w:val="noma-control:review-date"/><w:date w:fullDate="2026-05-25T00:00:00Z"><w:dateFormat w:val="yyyy-MM-dd"/></w:date></w:sdtPr><w:sdtContent><w:r><w:t>May 25, 2026</w:t></w:r></w:sdtContent></w:sdt></w:p>
    <w:p><w:sdt><w:sdtPr><w:alias w:val="Control: Approved"/><w:tag w:val="noma-control:approved"/><w14:checkbox><w14:checked w14:val="1"/></w14:checkbox></w:sdtPr><w:sdtContent><w:r><w:t>X</w:t></w:r></w:sdtContent></w:sdt></w:p>
  </w:body>
</w:document>`;
}
