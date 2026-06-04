import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "../src/parser.js";
import { renderHtml } from "../src/renderer-html.js";
import { renderLlm } from "../src/renderer-llm.js";
import { validate } from "../src/validator.js";
import { inlineDatasetSources } from "../src/loader.js";

test("::diagram mermaid renders source verbatim and injects CDN", () => {
  const doc = parse(
    `::diagram{kind="mermaid" id="flow"}\ngraph TD\nA-->B\n::\n`,
  );
  const html = renderHtml(doc, { standalone: true });
  assert.match(html, /class="noma-diagram noma-diagram-mermaid"/);
  assert.match(html, /data-noma-source="graph TD/);
  assert.match(html, /cdn\.jsdelivr\.net\/npm\/mermaid/);
});

test("::diagram graphviz triggers viz.js CDN", () => {
  const doc = parse(`::diagram{kind="graphviz"}\ndigraph { a -> b }\n::\n`);
  const html = renderHtml(doc, { standalone: true });
  assert.match(html, /noma-diagram-graphviz/);
  assert.match(html, /viz-standalone\.mjs/);
});

test("::diagram drawio embeds via diagrams.net viewer", () => {
  const doc = parse(`::diagram{kind="drawio"}\n<mxGraphModel/>\n::\n`);
  const html = renderHtml(doc, { standalone: true });
  assert.match(html, /class="mxgraph"/);
  assert.match(html, /viewer\.diagrams\.net\/js\/viewer-static\.min\.js/);
});

test("::diagram drawio body with apostrophes survives attribute encoding", () => {
  const body = `<mxCell value="Anne's box" style="font-family='Arial'"/>`;
  const doc = parse(`::diagram{kind="drawio"}\n${body}\n::\n`);
  const html = renderHtml(doc, { standalone: true });
  // attr container must use double quotes; embedded JSON " gets &quot;
  assert.match(html, /data-mxgraph="/);
  // raw apostrophe must not bleed out — original text preserved inside encoded JSON
  assert.match(html, /Anne's box/);
  // and the attribute must still close cleanly
  assert.match(html, /<\/div><\/figure>/);
});

test("::diagram body passes verbatim to LLM (no markdown stripping)", () => {
  const doc = parse(
    "::diagram{kind=\"mermaid\"}\ngraph TD\nA-->|`label`|B\n::\n",
  );
  const llm = renderLlm(doc);
  assert.match(llm, /A-->\|`label`\|B/);
});

test("::plotly emits container + Plotly CDN", () => {
  const spec = JSON.stringify({ data: [{ x: [1, 2], y: [3, 4], type: "scatter" }] });
  const doc = parse(`::plotly\n${spec}\n::\n`);
  const html = renderHtml(doc, { standalone: true });
  assert.match(html, /class="noma-plotly"/);
  assert.match(html, /cdn\.plot\.ly\/plotly-/);
});

test("HTML grid and columns expose lateral layout controls", () => {
  const doc = parse(
    `::grid{id="g" columns=5 min="12rem" gap="0.5rem" wide compact}\n::\n\n::columns{id="c" columns=20 min=220 full dense}\n::\n`,
  );
  const html = renderHtml(doc);

  assert.match(html, /class="noma-grid noma-grid-wide noma-grid-compact noma-grid-auto"/);
  assert.match(html, /style="--noma-cols: 5; --noma-grid-min: 12rem; --noma-grid-gap: 0.5rem;"/);
  assert.match(html, /class="noma-columns noma-columns-full noma-columns-compact noma-columns-auto"/);
  assert.match(html, /style="--noma-cols: 12; --noma-grid-min: 220px;"/);
});

test("HTML grid layout ignores unsafe CSS lengths", () => {
  const doc = parse(`::grid{gap="url(javascript:bad)" min="calc(100vw)"}\n::\n`);
  const html = renderHtml(doc);
  const style = /<div class="noma-grid"[^>]* style="([^"]+)"/.exec(html)?.[1];
  assert.equal(style, "--noma-cols: 2;");
});

test("::computed_table renders static rows, LLM defaults, and hash-state runtime", () => {
  const doc = parse(
    `::control{id="base" type="slider" min=0 max=20 default=10 label="Base"}\n::\n\n::computed_table{id="projection" formula="base * year" domain="year:1..3" unit="pts" variable_label="Year" value_label="Score"}\n::\n`,
  );
  const html = renderHtml(doc, { standalone: true });
  assert.match(html, /data-noma-computed="table"/);
  assert.match(html, /<th>Year<\/th><th>Score<\/th>/);
  assert.match(html, /<td>2<\/td><td>20 pts<\/td>/);
  assert.match(html, /#noma:/);
  assert.match(html, /writeHashState/);

  const llm = renderLlm(doc);
  assert.match(llm, /default_series \(year\): 1=10, 2=20, 3=30/);

  const diags = validate(doc);
  assert.equal(diags.filter((d) => d.code.startsWith("computed-")).length, 0);
});

test("::plotly invalid JSON flagged by validator", () => {
  const doc = parse(`::plotly\n{not json}\n::\n`);
  const diags = validate(doc);
  assert.ok(diags.some((d) => d.code === "plotly-invalid-json"));
});

test("::diagram missing kind flagged", () => {
  const doc = parse(`::diagram\nx\n::\n`);
  const diags = validate(doc);
  assert.ok(diags.some((d) => d.code === "diagram-missing-kind"));
});

test("inlineDatasetSources loads CSV into body and infers format", () => {
  const dir = mkdtempSync(join(tmpdir(), "noma-ds-"));
  try {
    writeFileSync(join(dir, "data.csv"), "a,b\n1,2\n3,4\n");
    const docPath = join(dir, "doc.noma");
    writeFileSync(docPath, `::dataset{id="d" src="data.csv"}\n::\n`);
    const doc = parse(`::dataset{id="d" src="data.csv"}\n::\n`, { filename: docPath });
    inlineDatasetSources(doc);
    const ds = doc.children[0] as { name: string; body?: string; attrs: Record<string, unknown> };
    assert.equal(ds.attrs.format, "csv");
    assert.match(ds.body ?? "", /a,b\n1,2/);
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test("dataset src= missing file flagged by validator", () => {
  const doc = parse(`::dataset{id="d" src="nope.csv"}\n::\n`, {
    filename: "/tmp/never-exists/doc.noma",
  });
  inlineDatasetSources(doc);
  const diags = validate(doc);
  assert.ok(
    diags.some((d) => d.code === "dataset-src-missing"),
    `expected dataset-src-missing, got: ${JSON.stringify(diags.map((d) => d.code))}`,
  );
});

test("CSV-backed dataset flags plot-unknown-column on typo", () => {
  const dir = mkdtempSync(join(tmpdir(), "noma-ds-"));
  try {
    writeFileSync(join(dir, "rev.csv"), "year,revenue\n2022,100\n2023,150\n");
    const src = `::dataset{id="rev" src="rev.csv"}\n::\n\n::plot{id="p" dataset="rev" column="revneue"}\n::\n`;
    const docPath = join(dir, "doc.noma");
    writeFileSync(docPath, src);
    const doc = parse(src, { filename: docPath });
    inlineDatasetSources(doc);
    const diags = validate(doc);
    assert.ok(
      diags.some((d) => d.code === "plot-unknown-column"),
      `expected plot-unknown-column for typo, got: ${JSON.stringify(diags.map((d) => d.code))}`,
    );
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test("JSON-backed dataset extracts columns from first object key", () => {
  const dir = mkdtempSync(join(tmpdir(), "noma-ds-"));
  try {
    writeFileSync(join(dir, "data.json"), JSON.stringify([{ name: "a", count: 1 }, { name: "b", count: 2 }]));
    const src = `::dataset{id="d" src="data.json"}\n::\n\n::plot{id="p" dataset="d" column="missing"}\n::\n`;
    const docPath = join(dir, "doc.noma");
    writeFileSync(docPath, src);
    const doc = parse(src, { filename: docPath });
    inlineDatasetSources(doc);
    const diags = validate(doc);
    assert.ok(diags.some((d) => d.code === "plot-unknown-column"));
  } finally {
    rmSync(dir, { recursive: true });
  }
});

test("CSV-backed dataset is queryable by ::plot{column=...}", () => {
  const dir = mkdtempSync(join(tmpdir(), "noma-ds-"));
  try {
    writeFileSync(join(dir, "rev.csv"), "year,revenue\n2022,100\n2023,150\n2024,200\n");
    const docPath = join(dir, "doc.noma");
    const src = `::dataset{id="rev" src="rev.csv"}\n::\n\n::plot{id="p" dataset="rev" column="revenue"}\n::\n`;
    writeFileSync(docPath, src);
    const doc = parse(src, { filename: docPath });
    inlineDatasetSources(doc);
    const html = renderHtml(doc);
    assert.match(html, /3 points/);
    const diags = validate(doc);
    assert.ok(!diags.some((d) => d.code === "plot-unknown-column"));
  } finally {
    rmSync(dir, { recursive: true });
  }
});
