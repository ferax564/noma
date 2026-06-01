import { test } from "node:test";
import assert from "node:assert/strict";
import { parse } from "../src/parser.js";
import { renderDocx } from "../src/renderer-docx.js";
import { syncControlDefaultsFromData, syncControlDefaultsFromDocx } from "../src/docx-control-sync.js";
import { storedDocx } from "./docx-test-zip.js";

test("syncControlDefaultsFromData updates matching control defaults only", () => {
  const source = `# Form

::control{id="review-title" type="text" default="Draft memo" label="Review title"}
::

::control{id="approved" type="toggle" default=false label="Approved"}
::

::control{id="growth-rate" type="slider" min=0 max=10 default=2}
::

::claim{id="review-title-note" default="unchanged"}
Not a control.
::
`;

  const result = syncControlDefaultsFromData(source, {
    controls: [
      { id: "review-title", type: "text", value: "Final memo" },
      { id: "approved", type: "toggle", value: "true" },
      { id: "growth-rate", type: "slider", value: "4.5" },
      { id: "review-title-note", value: "ignored" },
    ],
    tasks: [],
  });

  assert.match(result.source, /::control\{id="review-title" type="text" default="Final memo" label="Review title"\}/);
  assert.match(result.source, /::control\{id="approved" type="toggle" default="true" label="Approved"\}/);
  assert.match(result.source, /::control\{id="growth-rate" type="slider" min=0 max=10 default=4.5\}/);
  assert.match(result.source, /::claim\{id="review-title-note" default="unchanged"\}/);
  assert.deepEqual(result.changes.map((change) => change.id), ["review-title", "approved", "growth-rate"]);
  assert.deepEqual(result.unmatched.map((control) => control.id), ["review-title-note"]);
  assert.deepEqual(result.taskChanges, []);
  assert.deepEqual(result.unmatchedTasks, []);
});

test("syncControlDefaultsFromDocx reads generated custom XML values", () => {
  const source = `::control{id="review-title" type="text" default="Draft memo"}
::
`;
  const edited = parse(`::control{id="review-title" type="text" default="Final memo"}
::
`);
  const result = syncControlDefaultsFromDocx(source, renderDocx(edited));
  assert.match(result.source, /default="Final memo"/);
  assert.deepEqual(result.changes, [{ id: "review-title", value: "Final memo", defaultValue: "Final memo" }]);
  assert.deepEqual(result.taskChanges, []);
});

test("syncControlDefaultsFromData treats controls without type as text fields", () => {
  const source = `::control{id="invoice-code" default="007"}
::
`;

  const result = syncControlDefaultsFromData(source, {
    controls: [{ id: "invoice-code", value: "42" }],
    tasks: [],
  });

  assert.match(result.source, /::control\{id="invoice-code" default="42"\}/);
  assert.deepEqual(result.changes, [{ id: "invoice-code", value: "42", defaultValue: "42" }]);
});

test("syncControlDefaultsFromDocx uses visible control values when custom XML is stale", () => {
  const source = `::control{id="review-title" type="text" default="Draft memo" label="Review title"}
::

::control{id="scenario" type="select" default="base" options="base=Base,upside=Upside" label="Scenario"}
::

::control{id="review-date" type="date" default="2026-05-24" label="Review date"}
::

::control{id="approved" type="toggle" default=false label="Approved"}
::
`;

  const result = syncControlDefaultsFromDocx(source, staleBoundControlDocx());

  assert.match(result.source, /::control\{id="review-title" type="text" default="Final memo" label="Review title"\}/);
  assert.match(result.source, /::control\{id="scenario" type="select" default="upside" options="base=Base,upside=Upside" label="Scenario"\}/);
  assert.match(result.source, /::control\{id="review-date" type="date" default="2026-05-25" label="Review date"\}/);
  assert.match(result.source, /::control\{id="approved" type="toggle" default="true" label="Approved"\}/);
  assert.deepEqual(result.changes.map((change) => [change.id, change.value]), [
    ["review-title", "Final memo"],
    ["scenario", "upside"],
    ["review-date", "2026-05-25"],
    ["approved", "true"],
  ]);
});

test("syncControlDefaultsFromDocx preserves leading and trailing visible control spaces", () => {
  const source = `::control{id="reference-code" type="text" default="ACME-42" label="Reference code"}
::
`;
  const result = syncControlDefaultsFromDocx(
    source,
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

  assert.match(result.source, /::control\{id="reference-code" type="text" default="  ACME-42  " label="Reference code"\}/);
  assert.deepEqual(result.changes, [{ id: "reference-code", value: "  ACME-42  ", defaultValue: "  ACME-42  " }]);
});

test("syncControlDefaultsFromDocx reads visible combo box select values", () => {
  const source = `::control{id="scenario" type="select" default="base" options="base=Base,upside=Upside" label="Scenario"}
::
`;

  const result = syncControlDefaultsFromDocx(
    source,
    storedDocx({
      "word/document.xml": `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body>
    <w:p><w:sdt><w:sdtPr><w:alias w:val="Control: Scenario"/><w:tag w:val="noma-control:scenario"/><w:comboBox><w:listItem w:displayText="Base" w:value="base"/><w:listItem w:displayText="Upside" w:value="upside"/></w:comboBox></w:sdtPr><w:sdtContent><w:r><w:t>Upside</w:t></w:r></w:sdtContent></w:sdt></w:p>
  </w:body>
</w:document>`,
    }),
  );

  assert.match(result.source, /::control\{id="scenario" type="select" default="upside" options="base=Base,upside=Upside" label="Scenario"\}/);
  assert.deepEqual(result.changes, [{ id: "scenario", value: "upside", defaultValue: "upside" }]);
});

test("syncControlDefaultsFromData updates native task checkbox states", () => {
  const source = `::agent_task{id="task1" scope="weekly"}
Review.
::

::todo{id="todo1" status="open" priority="high"}
Follow up.
::

::claim{id="task-note"}
Not a task.
::
`;

  const result = syncControlDefaultsFromData(source, {
    controls: [],
    tasks: [
      { id: "task1", checked: true },
      { id: "todo1", checked: true },
      { id: "task-note", checked: true },
    ],
  });

  assert.match(result.source, /::agent_task\{id="task1" scope="weekly" done\}/);
  assert.match(result.source, /::todo\{id="todo1" status="done" priority="high"\}/);
  assert.match(result.source, /::claim\{id="task-note"\}/);
  assert.deepEqual(result.taskChanges.map((change) => [change.id, change.checked, change.attrs]), [
    ["task1", true, { done: true }],
    ["todo1", true, { status: "done" }],
  ]);
  assert.deepEqual(result.unmatchedTasks, [{ id: "task-note", checked: true }]);
});

test("syncControlDefaultsFromDocx reads generated native task checkbox values", () => {
  const source = `::agent_task{id="task1" scope="weekly" done}
Review.
::

::todo{id="todo1" status="done" priority="high"}
Follow up.
::
`;
  const edited = parse(`::agent_task{id="task1" scope="weekly"}
Review.
::

::todo{id="todo1" status="open" priority="high"}
Follow up.
::
`);

  const result = syncControlDefaultsFromDocx(source, renderDocx(edited));

  assert.match(result.source, /::agent_task\{id="task1" scope="weekly" done=false\}/);
  assert.match(result.source, /::todo\{id="todo1" status="open" priority="high"\}/);
  assert.deepEqual(result.taskChanges.map((change) => [change.id, change.checked, change.attrs]), [
    ["task1", false, { done: false }],
    ["todo1", false, { status: "open" }],
  ]);
});

test("syncControlDefaultsFromDocx applies visible header and footer control values", () => {
  const source = `::header
:::control{id="running-title" type="text" default="Draft title" label="Running title"}
:::
::

::footer
:::control{id="approved" type="toggle" default=false label="Approved"}
:::

:::todo{id="footer-task" status="open"}
Confirm footer package.
:::
::
`;

  const result = syncControlDefaultsFromDocx(source, headerFooterControlDocx());

  assert.match(result.source, /:::control\{id="running-title" type="text" default="Board final" label="Running title"\}/);
  assert.match(result.source, /:::control\{id="approved" type="toggle" default="true" label="Approved"\}/);
  assert.match(result.source, /:::todo\{id="footer-task" status="done"\}/);
  assert.deepEqual(result.changes.map((change) => [change.id, change.value]), [
    ["running-title", "Board final"],
    ["approved", "true"],
  ]);
  assert.deepEqual(result.taskChanges.map((change) => [change.id, change.checked, change.attrs]), [
    ["footer-task", true, { status: "done" }],
  ]);
});

function staleBoundControlDocx(): Buffer {
  return storedDocx({
    "word/document.xml": `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml">
  <w:body>
    <w:p><w:sdt><w:sdtPr><w:alias w:val="Control: Review title"/><w:tag w:val="noma-control:review-title"/><w:text/></w:sdtPr><w:sdtContent><w:r><w:t>Final memo</w:t></w:r></w:sdtContent></w:sdt></w:p>
    <w:p><w:sdt><w:sdtPr><w:alias w:val="Control: Scenario"/><w:tag w:val="noma-control:scenario"/><w:dropDownList><w:listItem w:displayText="Base" w:value="base"/><w:listItem w:displayText="Upside" w:value="upside"/></w:dropDownList></w:sdtPr><w:sdtContent><w:r><w:t>Upside</w:t></w:r></w:sdtContent></w:sdt></w:p>
    <w:p><w:sdt><w:sdtPr><w:alias w:val="Control: Review date"/><w:tag w:val="noma-control:review-date"/><w:date w:fullDate="2026-05-25T00:00:00Z"><w:dateFormat w:val="yyyy-MM-dd"/></w:date></w:sdtPr><w:sdtContent><w:r><w:t>May 25, 2026</w:t></w:r></w:sdtContent></w:sdt></w:p>
    <w:p><w:sdt><w:sdtPr><w:alias w:val="Control: Approved"/><w:tag w:val="noma-control:approved"/><w14:checkbox><w14:checked w14:val="1"/></w14:checkbox></w:sdtPr><w:sdtContent><w:r><w:t>X</w:t></w:r></w:sdtContent></w:sdt></w:p>
  </w:body>
</w:document>`,
    "customXml/item1.xml": `<noma:controls xmlns:noma="urn:noma:controls">
  <noma:control id="review-title" type="text"><noma:label>Review title</noma:label><noma:value>Draft memo</noma:value></noma:control>
  <noma:control id="scenario" type="select"><noma:label>Scenario</noma:label><noma:value>base</noma:value></noma:control>
  <noma:control id="review-date" type="date"><noma:label>Review date</noma:label><noma:value>2026-05-24</noma:value></noma:control>
  <noma:control id="approved" type="toggle"><noma:label>Approved</noma:label><noma:value>false</noma:value></noma:control>
</noma:controls>`,
  });
}

function headerFooterControlDocx(): Buffer {
  return storedDocx({
    "word/header1.xml": `<w:hdr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:p><w:sdt><w:sdtPr><w:alias w:val="Control: Running title"/><w:tag w:val="noma-control:running-title"/><w:text/></w:sdtPr><w:sdtContent><w:r><w:t>Board final</w:t></w:r></w:sdtContent></w:sdt></w:p>
</w:hdr>`,
    "word/footer1.xml": `<w:ftr xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:w14="http://schemas.microsoft.com/office/word/2010/wordml">
  <w:p><w:sdt><w:sdtPr><w:alias w:val="Control: Approved"/><w:tag w:val="noma-control:approved"/><w14:checkbox><w14:checked w14:val="1"/></w14:checkbox></w:sdtPr><w:sdtContent><w:r><w:t>X</w:t></w:r></w:sdtContent></w:sdt></w:p>
  <w:p><w:sdt><w:sdtPr><w:alias w:val="Todo status"/><w:tag w:val="noma-task:footer-task"/><w14:checkbox><w14:checked w14:val="1"/></w14:checkbox></w:sdtPr><w:sdtContent><w:r><w:t>X</w:t></w:r></w:sdtContent></w:sdt></w:p>
</w:ftr>`,
    "word/document.xml": `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:body><w:p><w:r><w:t>No form fields here.</w:t></w:r></w:p></w:body>
</w:document>`,
  });
}
