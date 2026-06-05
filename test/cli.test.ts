import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "noma-cli-"));
}

test("noma --version prints package version", () => {
  const pkg = JSON.parse(readFileSync("package.json", "utf8")) as { version: string };
  const res = spawnSync("npx", ["tsx", "src/cli.ts", "--version"], { encoding: "utf8" });
  assert.equal(res.status, 0, res.stderr);
  assert.equal(res.stdout.trim(), pkg.version);
});

test("noma init creates a renderable starter document", () => {
  const dir = join(scratch(), "starter");
  const res = spawnSync("npx", ["tsx", "src/cli.ts", "init", dir], { encoding: "utf8" });
  assert.equal(res.status, 0, res.stderr);
  const starter = join(dir, "demo.noma");
  assert.match(readFileSync(starter, "utf8"), /::claim\{id="core-claim"/);

  const render = spawnSync(
    "npx",
    ["tsx", "src/cli.ts", "render", starter, "--to", "html"],
    { encoding: "utf8" },
  );
  assert.equal(render.status, 0, render.stderr);
  assert.match(render.stdout, /Agent-Safe Spec/);
});

test("noma render --strict blocks escape hatches and external assets", () => {
  const dir = scratch();
  const input = join(dir, "strict.noma");
  writeFileSync(
    input,
    `# Strict

::html
<b>raw</b>
::

::math
x^2
::

::diagram{kind="mermaid"}
graph TD; A-->B
::

::control{id="growth-rate" type="slider" min=0 max=20 default=8}
Growth rate
::

::computed_metric{id="projection" formula="growth-rate * 2"}
::
`,
  );
  const res = spawnSync(
    "npx",
    ["tsx", "src/cli.ts", "render", input, "--strict"],
    { encoding: "utf8" },
  );
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /noma-blocked-escape/);
  assert.ok(!res.stdout.includes("<b>raw</b>"));
  assert.ok(!/cdn\.jsdelivr\.net/.test(res.stdout));
  assert.ok(!/<script\b/.test(res.stdout));
  assert.match(res.stdout, /interactive controls disabled in strict mode/);
  assert.equal(res.stdout.match(/interactive controls disabled in strict mode/g)?.length, 1);
  assert.match(res.stdout, /data-noma-control-input="growth-rate"[^>]*disabled/);
  assert.match(res.stdout, /<div class="noma-computed-value" data-noma-computed-value>16<\/div>/);
});

test("noma render --to llm supports select, exclude, and budget", () => {
  const dir = scratch();
  const input = join(dir, "ctx.noma");
  writeFileSync(
    input,
    `# Spec\n\n::claim{id="c1"}\nClaim.\n::\n\n::dataset{id="ds1"}\nrows: []\n::\n\n::risk{id="r1" owner="me"}\nRisk.\n::\n`,
  );
  const res = spawnSync(
    "npx",
    ["tsx", "src/cli.ts", "render", input, "--to", "llm", "--select", "claim,risk", "--exclude", "risk", "--budget", "120"],
    { encoding: "utf8" },
  );
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /\[CLAIM/);
  assert.doesNotMatch(res.stdout, /\[RISK/);
  assert.doesNotMatch(res.stdout, /\[DATASET/);
  assert.ok(res.stdout.length <= 120);
});

test("noma render --to markdown writes shareable Markdown", () => {
  const dir = scratch();
  const input = join(dir, "share.noma");
  const output = join(dir, "share.md");
  writeFileSync(
    input,
    `# Share {id="share"}\n\nSee [[claim-1]].\n\n::claim{id="claim-1" confidence=0.7}\nA **claim**.\n::\n`,
  );
  const res = spawnSync(
    "npx",
    ["tsx", "src/cli.ts", "render", input, "--to", "markdown", "--out", output],
    { encoding: "utf8" },
  );
  assert.equal(res.status, 0, res.stderr);
  const md = readFileSync(output, "utf8");
  assert.match(md, /# Share/);
  assert.match(md, /\[claim-1\]\(#claim-1\)/);
  assert.match(md, /<!-- noma:block/);
  assert.match(md, /\*\*Claim: claim-1\*\*/);
});

test("noma prove renders an agent safety proof without mutating by default", () => {
  const dir = scratch();
  const input = join(dir, "proof.noma");
  const html = join(dir, "proof.html");
  const json = join(dir, "proof.json");
  writeFileSync(input, `# Proof\n\n::risk{id="r1" owner="ops"}\nOld risk.\n::\n`);

  const res = spawnSync(
    "npx",
    [
      "tsx",
      "src/cli.ts",
      "prove",
      input,
      "--op",
      '{"op":"replace_body","id":"r1","content":"New risk."}',
      "--out",
      html,
    ],
    { encoding: "utf8" },
  );
  assert.equal(res.status, 0, res.stderr);
  assert.match(readFileSync(html, "utf8"), /Noma Agent Safety Proof/);
  assert.match(readFileSync(html, "utf8"), /Lines preserved/);
  assert.equal(readFileSync(input, "utf8"), `# Proof\n\n::risk{id="r1" owner="ops"}\nOld risk.\n::\n`);

  const jsonRes = spawnSync(
    "npx",
    [
      "tsx",
      "src/cli.ts",
      "prove",
      input,
      "--to",
      "json",
      "--op",
      '{"op":"replace_body","id":"r1","content":"New risk."}',
      "--out",
      json,
    ],
    { encoding: "utf8" },
  );
  assert.equal(jsonRes.status, 0, jsonRes.stderr);
  const proof = JSON.parse(readFileSync(json, "utf8")) as {
    status: string;
    patchResult: string;
    canWrite: boolean;
    sourceMetrics: { preservedPercent: number };
  };
  assert.equal(proof.status, "pass");
  assert.equal(proof.patchResult, "applied");
  assert.equal(proof.canWrite, true);
  assert.ok(proof.sourceMetrics.preservedPercent > 0);
});

test("noma prove --inplace refuses to write when the patch target is missing", () => {
  const dir = scratch();
  const input = join(dir, "proof-fail.noma");
  const html = join(dir, "proof-fail.html");
  const before = `# Proof\n\n::risk{id="r1" owner="ops"}\nOld risk.\n::\n`;
  writeFileSync(input, before);

  const res = spawnSync(
    "npx",
    [
      "tsx",
      "src/cli.ts",
      "prove",
      input,
      "--op",
      '{"op":"replace_body","id":"missing","content":"New risk."}',
      "--inplace",
      "--out",
      html,
    ],
    { encoding: "utf8" },
  );
  assert.equal(res.status, 1);
  assert.match(res.stderr, /source not written/);
  assert.match(readFileSync(html, "utf8"), /target_missing/);
  assert.equal(readFileSync(input, "utf8"), before);
});

test("noma render --to pdf writes a PDF file", () => {
  const dir = scratch();
  const input = join(dir, "report.noma");
  const output = join(dir, "report.pdf");
  writeFileSync(input, `# Report\n\nA short report.\n`);
  const res = spawnSync(
    "npx",
    [
      "tsx",
      "src/cli.ts",
      "render",
      input,
      "--to",
      "pdf",
      "--out",
      output,
      "--page-size",
      "Letter",
      "--margin",
      "12mm",
      "--no-print-background",
    ],
    { encoding: "utf8" },
  );
  assert.equal(res.status, 0, res.stderr);
  assert.ok(existsSync(output), "expected PDF output file");
  assert.equal(readFileSync(output).subarray(0, 4).toString("utf8"), "%PDF");
});

test("noma render --to docx writes a DOCX package", () => {
  const dir = scratch();
  const input = join(dir, "report.noma");
  const output = join(dir, "report.docx");
  const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=";
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="120" height="60"><rect width="120" height="60" fill="#2B5265"/></svg>`;
  writeFileSync(join(dir, "pixel.png"), Buffer.from(png, "base64"));
  writeFileSync(join(dir, "chart.svg"), svg);
  writeFileSync(input, `# Report\n\nA short **report**.\n\n::figure{id="pixel" src="pixel.png" alt="Pixel" caption="Pixel"}\n::\n\n::figure{id="chart" src="chart.svg" alt="Chart" caption="Vector chart"}\n::\n`);
  const res = spawnSync(
    "npx",
    ["tsx", "src/cli.ts", "render", input, "--to", "docx", "--out", output],
    { encoding: "utf8" },
  );
  assert.equal(res.status, 0, res.stderr);
  assert.ok(existsSync(output), "expected DOCX output file");
  const body = readFileSync(output);
  assert.equal(body.subarray(0, 4).toString("binary"), "PK\u0003\u0004");
  assert.ok(body.includes("word/document.xml"));
  assert.ok(body.includes("word/media/image1.png"));
  assert.ok(body.includes("word/media/image2.svg"));
});

test("noma docx-data prints bound control values from a DOCX package", () => {
  const dir = scratch();
  const input = join(dir, "form.noma");
  const output = join(dir, "form.docx");
  const dataFile = join(dir, "form-data.json");
  writeFileSync(input, `# Form

::control{id="review-title" type="text" default="Draft memo" label="Review title"}
::

::control{id="approved" type="toggle" default=false label="Approved"}
::

::agent_task{id="task1" scope="weekly" done}
Review the draft.
::
`);
  const render = spawnSync(
    "npx",
    ["tsx", "src/cli.ts", "render", input, "--to", "docx", "--out", output],
    { encoding: "utf8" },
  );
  assert.equal(render.status, 0, render.stderr);

  const extract = spawnSync("npx", ["tsx", "src/cli.ts", "docx-data", output], { encoding: "utf8" });
  assert.equal(extract.status, 0, extract.stderr);
  const data = JSON.parse(extract.stdout) as {
    controls: Array<{ id: string; value: string }>;
    tasks: Array<{ id: string; checked: boolean }>;
  };
  assert.deepEqual(data.controls.map((control) => [control.id, control.value]), [
    ["review-title", "Draft memo"],
    ["approved", "false"],
  ]);
  assert.deepEqual(data.tasks, [{ id: "task1", checked: true }]);

  const writeJson = spawnSync("npx", ["tsx", "src/cli.ts", "docx-data", output, "--out", dataFile], {
    encoding: "utf8",
  });
  assert.equal(writeJson.status, 0, writeJson.stderr);
  assert.deepEqual(JSON.parse(readFileSync(dataFile, "utf8")), data);
});

test("noma docx-sync updates source control defaults from a DOCX package", () => {
  const dir = scratch();
  const source = join(dir, "form.noma");
  const edited = join(dir, "edited.noma");
  const docx = join(dir, "edited.docx");
  const synced = join(dir, "synced.noma");
  const report = join(dir, "sync-report.json");
  writeFileSync(source, `# Form

::control{id="review-title" type="text" default="Draft memo" label="Review title"}
::

::control{id="approved" type="toggle" default=false label="Approved"}
::

::agent_task{id="task1" scope="weekly"}
Review the draft.
::

::todo{id="todo1" status="open" priority="high"}
Follow up.
::
`);
  writeFileSync(edited, `# Form

::control{id="review-title" type="text" default="Final memo" label="Review title"}
::

::control{id="approved" type="toggle" default=true label="Approved"}
::

::agent_task{id="task1" scope="weekly" done}
Review the draft.
::

::todo{id="todo1" status="done" priority="high"}
Follow up.
::
`);
  const render = spawnSync(
    "npx",
    ["tsx", "src/cli.ts", "render", edited, "--to", "docx", "--out", docx],
    { encoding: "utf8" },
  );
  assert.equal(render.status, 0, render.stderr);

  const sync = spawnSync("npx", ["tsx", "src/cli.ts", "docx-sync", source, docx, "--out", synced, "--report", report], {
    encoding: "utf8",
  });
  assert.equal(sync.status, 0, sync.stderr);
  const body = readFileSync(synced, "utf8");
  assert.match(body, /default="Final memo"/);
  assert.match(body, /default="true"/);
  assert.match(body, /::agent_task\{id="task1" scope="weekly" done\}/);
  assert.match(body, /::todo\{id="todo1" status="done" priority="high"\}/);
  assert.match(readFileSync(source, "utf8"), /default="Draft memo"/);
  const reportBody = JSON.parse(readFileSync(report, "utf8")) as {
    source?: string;
    changes: Array<{ id: string; value: string }>;
    taskChanges: Array<{ id: string; checked: boolean }>;
    unmatched: unknown[];
    unmatchedTasks: unknown[];
  };
  assert.equal(reportBody.source, undefined);
  assert.deepEqual(reportBody.changes.map((change) => [change.id, change.value]), [
    ["review-title", "Final memo"],
    ["approved", "true"],
  ]);
  assert.deepEqual(reportBody.taskChanges.map((change) => [change.id, change.checked]), [
    ["task1", true],
    ["todo1", true],
  ]);
  assert.deepEqual(reportBody.unmatched, []);
  assert.deepEqual(reportBody.unmatchedTasks, []);
});

test("noma docx-review-data prints native Word comments from a DOCX package", () => {
  const dir = scratch();
  const input = join(dir, "review.noma");
  const docx = join(dir, "review.docx");
  writeFileSync(input, `# Review

::claim{id="c1"}
Claim.
::

::comment{id="comment-c1" parent="c1" author="Research" date="2026-05-24T09:00:00Z"}
Check this claim.
::
`);
  const render = spawnSync(
    "npx",
    ["tsx", "src/cli.ts", "render", input, "--to", "docx", "--out", docx],
    { encoding: "utf8" },
  );
  assert.equal(render.status, 0, render.stderr);

  const extract = spawnSync("npx", ["tsx", "src/cli.ts", "docx-review-data", docx], {
    encoding: "utf8",
  });
  assert.equal(extract.status, 0, extract.stderr);
  const data = JSON.parse(extract.stdout) as { comments: Array<{ author: string; body: string }> };
  assert.deepEqual(data.comments.map((comment) => [comment.author, comment.body]), [
    ["Research", "Check this claim."],
  ]);
});

test("noma docx-review-sync maps computed table captions and metadata", () => {
  const dir = scratch();
  const source = join(dir, "source.noma");
  const reviewed = join(dir, "reviewed.noma");
  const docx = join(dir, "reviewed.docx");
  const synced = join(dir, "synced.noma");
  const report = join(dir, "review-report.json");
  const base = `# Review

::control{id="base" type="number" default=10 label="Base"}
::
`;
  writeFileSync(source, `${base}
::computed_table{id="projection" label="Scenario" formula="base * year" domain="year:1..2" unit="pts" variable_label="Year" value_label="Score"}
::
`);
  writeFileSync(reviewed, `${base}
::computed_table{id="projection" label="Reviewed scenario" formula="base * year * 2" domain="year:1..2" unit="points" variable_label="Year" value_label="Score"}
::
`);
  const render = spawnSync(
    "npx",
    ["tsx", "src/cli.ts", "render", reviewed, "--to", "docx", "--out", docx],
    { encoding: "utf8" },
  );
  assert.equal(render.status, 0, render.stderr);

  const extract = spawnSync("npx", ["tsx", "src/cli.ts", "docx-review-data", docx], {
    encoding: "utf8",
  });
  assert.equal(extract.status, 0, extract.stderr);
  const data = JSON.parse(extract.stdout) as {
    captions?: Array<{ kind: string; title: string }>;
    blockMetadata?: Array<{ fields: Record<string, string> }>;
  };
  assert.ok(data.captions?.some((caption) => caption.kind === "table" && caption.title === "Reviewed scenario"));
  assert.ok(data.blockMetadata?.some((meta) => meta.fields.formula === "base * year * 2" && meta.fields.unit === "points"));

  const sync = spawnSync("npx", ["tsx", "src/cli.ts", "docx-review-sync", source, docx, "--out", synced, "--report", report], {
    encoding: "utf8",
  });
  assert.equal(sync.status, 0, sync.stderr);
  const body = readFileSync(synced, "utf8");
  assert.match(body, /label="Reviewed scenario"/);
  assert.match(body, /formula="base \* year \* 2"/);
  assert.match(body, /unit="points"/);
  const reportBody = JSON.parse(readFileSync(report, "utf8")) as {
    changes: Array<{ action: string; id: string; key?: string }>;
  };
  assert.ok(reportBody.changes.some((change) => change.action === "update_caption" && change.id === "projection" && change.key === "label"));
  assert.ok(reportBody.changes.some((change) => change.action === "update_block_metadata" && change.id === "projection" && change.key === "formula"));
});

test("noma docx-review-sync adds native Word comments to source", () => {
  const dir = scratch();
  const source = join(dir, "source.noma");
  const reviewed = join(dir, "reviewed.noma");
  const docx = join(dir, "reviewed.docx");
  const synced = join(dir, "synced.noma");
  const report = join(dir, "review-report.json");
  writeFileSync(source, `# Review

::claim{id="c1"}
Claim.
::
`);
  writeFileSync(reviewed, `# Review

::claim{id="c1"}
Claim.
::

::comment{id="word-comment" parent="c1" author="Research"}
Check this claim.
::

::change_request{id="word-change" target="c1" action="replace" from="old wording" to="new wording" author="Research"}
::
`);
  const render = spawnSync(
    "npx",
    ["tsx", "src/cli.ts", "render", reviewed, "--to", "docx", "--out", docx],
    { encoding: "utf8" },
  );
  assert.equal(render.status, 0, render.stderr);

  const sync = spawnSync("npx", ["tsx", "src/cli.ts", "docx-review-sync", source, docx, "--out", synced, "--report", report], {
    encoding: "utf8",
  });
  assert.equal(sync.status, 0, sync.stderr);
  const body = readFileSync(synced, "utf8");
  assert.match(body, /::comment\{id="comment-c1-0" parent="c1" author="Research"/);
  assert.match(body, /Check this claim\./);
  assert.match(body, /::change_request\{id="change-c1-0-1" target="c1" action="replace" from="old wording" to="new wording" author="Research"/);
  const reportBody = JSON.parse(readFileSync(report, "utf8")) as {
    source?: string;
    changes: Array<{ action: string; id: string; target?: string }>;
    skipped: unknown[];
    skippedRevisions: unknown[];
    skippedFootnotes: unknown[];
    skippedEndnotes: unknown[];
    skippedTables: unknown[];
    skippedHeadings: unknown[];
  };
  assert.equal(reportBody.source, undefined);
  assert.deepEqual(reportBody.changes.map((change) => [change.action, change.id, change.target]), [
    ["add_comment", "comment-c1-0", "c1"],
    ["add_change_request", "change-c1-0-1", "c1"],
  ]);
  assert.deepEqual(reportBody.skipped, []);
  assert.deepEqual(reportBody.skippedRevisions, []);
  assert.deepEqual(reportBody.skippedFootnotes, []);
  assert.deepEqual(reportBody.skippedEndnotes, []);
  assert.deepEqual(reportBody.skippedTables, []);
  assert.deepEqual(reportBody.skippedHeadings, []);
});

test("noma ids prints canonical IDs, aliases, and records", () => {
  const dir = scratch();
  const input = join(dir, "ids.noma");
  writeFileSync(input, `# Spec {id="spec" aliases="intro"}\n\n::claim{id="c1"}\nClaim.\n::\n`);
  const res = spawnSync("npx", ["tsx", "src/cli.ts", "ids", input], { encoding: "utf8" });
  assert.equal(res.status, 0, res.stderr);
  const body = JSON.parse(res.stdout) as {
    ids: string[];
    aliases: Record<string, string>;
    records: Array<{ id: string; type: string; title?: string; name?: string }>;
  };
  assert.deepEqual(body.ids, ["spec", "c1"]);
  assert.equal(body.aliases.intro, "spec");
  assert.ok(body.records.some((r) => r.id === "spec" && r.type === "section" && r.title === "Spec"));
  assert.ok(body.records.some((r) => r.id === "c1" && r.type === "directive" && r.name === "claim"));
});

test("noma patch transaction postvalidate rejects invalid post-state without writing", () => {
  const dir = scratch();
  const input = join(dir, "tx.noma");
  const tx = join(dir, "tx.json");
  const original = `::claim{id="c1"}\nClaim.\n::\n\n::evidence{id="e1" for="c1"}\nEvidence.\n::\n`;
  writeFileSync(input, original);
  writeFileSync(
    tx,
    JSON.stringify({
      ops: [{ op: "delete_block", id: "c1" }],
      postvalidate: true,
    }),
  );
  const res = spawnSync(
    "npx",
    ["tsx", "src/cli.ts", "patch", input, "--ops", tx, "--inplace"],
    { encoding: "utf8" },
  );
  assert.equal(res.status, 1);
  assert.match(res.stderr, /post-validation failed/);
  assert.equal(readFileSync(input, "utf8"), original);
});

test("noma patch transaction applies when validations pass", () => {
  const dir = scratch();
  const input = join(dir, "tx-ok.noma");
  const tx = join(dir, "tx-ok.json");
  writeFileSync(input, `::claim{id="c1" confidence=0.5 noverify}\nClaim.\n::\n`);
  writeFileSync(
    tx,
    JSON.stringify({
      ops: [{ op: "update_attribute", id: "c1", key: "confidence", value: 0.9 }],
      prevalidate: true,
      postvalidate: true,
    }),
  );
  const res = spawnSync(
    "npx",
    ["tsx", "src/cli.ts", "patch", input, "--ops", tx, "--inplace"],
    { encoding: "utf8" },
  );
  assert.equal(res.status, 0, res.stderr);
  assert.match(readFileSync(input, "utf8"), /confidence=0\.9/);
});
