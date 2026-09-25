import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "../src/parser.js";
import { validate } from "../src/validator.js";
import { renderHtml } from "../src/renderer-html.js";
import { renderLlm } from "../src/renderer-llm.js";
import { renderMarkdown } from "../src/renderer-markdown.js";
import { renderNoma } from "../src/renderer-noma.js";
import { inlineDatasetSources } from "../src/loader.js";
import { canvasOutline, canvasPageSvg, readCanvasDocument } from "../src/canvas-svg.js";
import type { CanvasPage, PaperDOMDocument } from "../src/paperdom-document-model.js";

function canvas(elements: unknown[], extra: Record<string, unknown> = {}): PaperDOMDocument {
  return {
    format: "paperdom",
    version: "0.1",
    id: "c",
    title: "Board",
    revision: 0,
    pages: [{ id: "p1", name: "One", size: { width: 400, height: 200 }, background: { color: "#ffffff" }, elements } as unknown as CanvasPage, { id: "p2", name: "Two", hidden: true, size: { width: 400, height: 200 }, background: { color: "#fff" }, elements: [] } as unknown as CanvasPage],
    plugins: [],
    metadata: { createdAt: "", updatedAt: "" },
    ...extra,
  } as PaperDOMDocument;
}

const box = (id: string, type: string, x: number, y: number, more: Record<string, unknown> = {}) => ({
  id,
  type,
  name: id,
  z: 1,
  frame: { x, y, w: 100, h: 40, rotation: 0 },
  style: { fill: "#dfeaf5", stroke: "#2c5d8f", strokeWidth: 2, color: "#111111", fontSize: 16 },
  ...more,
});

function page(source: PaperDOMDocument): string {
  return `# Page\n\n::canvas{id="board" caption="Board"}\n\`\`\`json\n${JSON.stringify(source)}\n\`\`\`\n::\n`;
}

test("every element kind draws, in z order, with hidden elements and pages left out", () => {
  const doc = canvas([
    box("b", "shape", 150, 10, { z: 3, content: { text: "Second" } }),
    box("a", "text", 10, 10, { z: 2, content: { paragraphs: [{ text: "First", kind: "bullet" }] } }),
    box("e", "ellipse", 10, 80, { content: { text: "Round" } }),
    box("l", "connector", 0, 0, { from: { elementId: "a", anchor: "right" }, to: { elementId: "b", anchor: "left" } }),
    box("t", "table", 150, 80, { table: { header: true, rows: [["k", "v"], ["a", "1"]] } }),
    box("ch", "chart", 260, 80, { chart: { kind: "bar", labels: ["x", "y"], values: [1, 2], title: "Bars" } }),
    box("ln", "chart", 260, 140, { chart: { kind: "line", labels: ["x", "y"], values: [2, 1], title: "Line" } }),
    box("img", "image", 300, 10, { content: { src: "https://example.test/x.png", alt: "logo" } }),
    box("h", "shape", 0, 0, { hidden: true, content: { text: "Invisible" } }),
    box("pl", "plugin", 0, 150),
  ]);
  const svg = canvasPageSvg(doc.pages[0]!);
  assert.match(svg, /^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg"[^>]*viewBox="0 0 400 200"/);
  assert.ok(svg.indexOf('data-element="a"') < svg.indexOf('data-element="b"'), "lower z draws first");
  assert.match(svg, /<ellipse /);
  assert.match(svg, /<line x1="110" y1="30" x2="150" y2="30"/, "connectors attach to element anchors");
  assert.match(svg, /<th [^>]*>k<\/th>/);
  assert.match(svg, /<rect [^>]*fill="#2f6fa7"/);
  assert.match(svg, /<polyline /);
  assert.match(svg, /• First/);
  assert.match(svg, /image: logo/, "remote images are placeholders unless the host resolves them");
  assert.doesNotMatch(svg, /Invisible/);
  assert.match(canvasPageSvg(doc.pages[0]!, { resolveImage: (src) => src }), /<image href="https:\/\/example\.test\/x\.png"/);
  const html = renderHtml(parse(page(doc)), { standalone: false });
  assert.match(html, /<figure class="noma-canvas" id="board" data-pages="1">/, "hidden pages are skipped");
  assert.match(html, /<figcaption>Board<\/figcaption>/);
});

test("canvas JSON cannot inject markup, styles, or script", () => {
  const doc = canvas([
    box("x\"><script>alert(1)</script>", "shape", 0, 0, {
      style: { fill: "red\" onload=\"alert(1)", stroke: "url(javascript:alert(1))", strokeWidth: 2, color: "expression(alert(1))", fontFamily: "x;}</style><script>alert(1)</script>", fontSize: "20px" },
      content: { text: "</div><script>alert(1)</script>" },
    }),
    box("img", "image", 0, 0, { content: { src: "javascript:alert(1)", alt: "<b>x</b>" } }),
    box("svgimg", "image", 0, 0, { content: { src: "data:image/svg+xml;base64,PHN2Zz48L3N2Zz4=", alt: "svg" } }),
  ], { title: "<script>" });
  doc.pages[0]!.name = "\"><script>alert(1)</script>";
  (doc.pages[0]!.background as { color: string }).color = "#fff\"/><script>alert(1)</script>";
  const html = renderHtml(parse(page(doc)), { standalone: false });
  assert.doesNotMatch(html, /<script>alert/);
  assert.doesNotMatch(html, /onload=|javascript:|expression\(/);
  assert.doesNotMatch(html, /data:image\/svg\+xml/, "SVG data URIs are not drawn");
  assert.match(html, /&lt;\/div&gt;&lt;script&gt;/);
});

test("::canvas validates its source and reports unreadable canvases in place", () => {
  const codes = (source: string) => validate(parse(source)).map((d) => d.code);
  assert.ok(codes(`::canvas{id="c"}\n::\n`).includes("canvas-missing-source"));
  assert.ok(codes(`::canvas{id="c"}\n\`\`\`json\n{ nope\n\`\`\`\n::\n`).includes("canvas-invalid"));
  assert.ok(codes(`::canvas{id="c"}\n\`\`\`json\n{"format":"paperdom","pages":[]}\n\`\`\`\n::\n`).includes("canvas-invalid"));
  assert.ok(codes(page(canvas([])).replace('caption="Board"', 'page="nope"')).includes("canvas-unknown-page"));
  assert.deepEqual(codes(page(canvas([]))), []);
  assert.deepEqual(codes(`::canvas{id="c" src="att:board.json"}\n::\n`), [], "attachment sources are resolved by the host");
  assert.match(renderHtml(parse(`::canvas{id="c" src="att:board.json"}\n::\n`), { standalone: false }), /canvas not available: att:board\.json/);
  assert.match(renderHtml(parse(`::canvas{id="c"}\n\`\`\`json\n[1]\n\`\`\`\n::\n`), { standalone: false }), /canvas JSON must be an object/);
  assert.equal(readCanvasDocument("x".repeat(3 * 1024 * 1024)).ok, false);
});

test("text targets get the canvas outline, the source keeps the JSON", () => {
  const doc = canvas([
    box("r", "shape", 200, 12, { content: { text: "Right" } }),
    box("l", "shape", 10, 10, { content: { text: "Left" } }),
    box("t", "table", 10, 120, { table: { header: true, rows: [["k", "v"]] } }),
  ]);
  assert.deepEqual(canvasOutline(doc), [{ page: "One", lines: ["Left", "Right", "k | v"] }], "rows read left to right");
  const source = page(doc);
  const llm = renderLlm(parse(source));
  assert.match(llm, /\[CANVAS id="board" caption="Board"\]\nOne:\n- Left\n- Right\n- k \| v\n\[\/CANVAS\]/);
  assert.doesNotMatch(llm, /"format"/);
  const md = renderMarkdown(parse(source));
  assert.match(md, /\*\*Board\*\*\n\n\*One\*\n\n- Left\n- Right/);
  assert.equal(renderNoma(parse(source)), source, "the canvas JSON round-trips through .noma unchanged");
});

test("the loader reads src= canvas files next to the document", () => {
  const dir = mkdtempSync(join(tmpdir(), "noma-canvas-"));
  writeFileSync(join(dir, "board.json"), JSON.stringify(canvas([box("a", "shape", 0, 0, { content: { text: "From file" } })])));
  const doc = parse(`::canvas{id="c" src="board.json"}\n::\n\n::canvas{id="escape" src="../../etc/passwd"}\n::\n`, { filename: join(dir, "page.noma") });
  inlineDatasetSources(doc);
  const html = renderHtml(doc, { standalone: false });
  assert.match(html, /From file/);
  assert.match(html, /canvas not available: \.\.\/\.\.\/etc\/passwd/);
});
