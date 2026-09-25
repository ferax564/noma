import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, posix } from "node:path";
import { parse } from "../src/parser.js";
import { renderPaperDom } from "../src/renderer-paperdom.js";
import { hex, paperDomToPptx } from "../src/paperdom-pptx.js";
import { readZip } from "../src/zip.js";
import type { PaperDOMDocument } from "../src/paperdom-document-model.js";

const PNG = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

function parts(bytes: Buffer): Map<string, string> {
  return new Map(readZip(bytes).map((entry) => [entry.path, Buffer.from(entry.data).toString("utf8")]));
}

/** Minimal well-formedness check: balanced, properly nested tags and no raw `<`/`&` in text. */
function assertWellFormed(path: string, xml: string): void {
  const body = xml.replace(/^<\?xml[^>]*\?>\s*/, "");
  const stack: string[] = [];
  const tag = /<(\/?)([A-Za-z_][\w:.-]*)((?:\s+[\w:.-]+="[^"<]*")*)\s*(\/?)>/g;
  let last = 0;
  for (let m = tag.exec(body); m; m = tag.exec(body)) {
    const text = body.slice(last, m.index);
    assert.doesNotMatch(text, /[<>]|&(?!(amp|lt|gt|quot|apos|#\d+);)/, `${path}: stray markup in text near ${JSON.stringify(text.slice(0, 40))}`);
    last = m.index + m[0].length;
    if (m[1]) assert.equal(stack.pop(), m[2], `${path}: mismatched </${m[2]}>`);
    else if (!m[4]) stack.push(m[2]!);
  }
  assert.equal(body.slice(last).trim(), "", `${path}: trailing content`);
  assert.deepEqual(stack, [], `${path}: unclosed ${stack.join(",")}`);
}

function assertPackage(bytes: Buffer): Map<string, string> {
  const files = parts(bytes);
  assert.equal(readZip(bytes)[0]?.path, "[Content_Types].xml");
  const types = files.get("[Content_Types].xml")!;
  for (const [path, xml] of files) {
    if (path.startsWith("ppt/media/")) continue;
    assertWellFormed(path, xml);
    if (!path.endsWith(".rels") && path !== "[Content_Types].xml") assert.match(types, new RegExp(`PartName="/${path.replace(/[.[\]]/g, "\\$&")}"`), `${path} has a content type`);
    if (path.endsWith(".rels")) {
      const dir = posix.dirname(posix.dirname(path));
      for (const [, target] of xml.matchAll(/Target="([^"]+)"/g)) {
        const resolved = posix.normalize(posix.join(dir === "." ? "" : dir, target!));
        assert.ok(files.has(resolved), `${path} points at missing ${resolved}`);
      }
    }
  }
  return files;
}

const DECK = `# Deck\n\n::deck{id="d" title="Deck"}\n:::slide{id="s1" layout="title" title="Hello & <welcome>"}\nSubtitle\n\n::::notes\nSay hi.\n\nSecond line.\n::::\n:::\n\n:::slide{id="s2" title="Points" hidden transition="fade"}\n- One **bold**\n- Two\n\n| k | v |\n|---|---|\n| a | 1 |\n:::\n::\n`;

test("a deck exports as a valid .pptx with notes, hidden slides, transitions, and tables", () => {
  const { bytes, report } = paperDomToPptx(renderPaperDom(parse(DECK)));
  const files = assertPackage(bytes);
  assert.equal(report.slides, 2);
  assert.match(files.get("ppt/presentation.xml")!, /<p:sldSz cx="12192000" cy="6858000"\/>/);
  assert.match(files.get("ppt/slides/slide1.xml")!, /<a:t>Hello &amp; &lt;welcome&gt;<\/a:t>/);
  assert.match(files.get("ppt/notesSlides/notesSlide1.xml")!, /<a:t>Say hi\.<\/a:t>.*<a:t>Second line\.<\/a:t>/s);
  assert.ok(!files.has("ppt/notesSlides/notesSlide2.xml"));
  const slide2 = files.get("ppt/slides/slide2.xml")!;
  assert.match(slide2, /<p:sld [^>]*show="0"/);
  assert.match(slide2, /<p:transition spd="med"><p:fade\/><\/p:transition>/);
  assert.match(slide2, /<a:buChar char="•"\/><\/a:pPr><a:r>.*<a:t>One bold<\/a:t>/);
  assert.match(slide2, /<a:tbl>.*<a:t>k<\/a:t>.*<a:t>1<\/a:t>/s);
  assert.deepEqual(report.unsupported, []);
  assert.ok(report.supported.includes("speaker notes") && report.supported.includes("tables"));
});

function board(elements: unknown[]): PaperDOMDocument {
  return {
    format: "paperdom", version: "0.1", id: "b", title: "Board", revision: 0, plugins: [], metadata: { createdAt: "", updatedAt: "2026-09-25T00:00:00.000Z" },
    pages: [{ id: "p", name: "P", size: { width: 1280, height: 720 }, background: { color: "#fbfaf7" }, elements, animations: [{ id: "a", elementId: "x", effect: "appear", trigger: "click", duration: 1, delay: 0 }] }],
  } as unknown as PaperDOMDocument;
}

const el = (id: string, type: string, more: Record<string, unknown> = {}) => ({ id, type, name: id, z: 1, frame: { x: 10, y: 20, w: 200, h: 100, rotation: 0 }, style: { fill: "#dfeaf5", stroke: "#2c5d8f", strokeWidth: 2, color: "#111", fontSize: 20, radius: 12 }, ...more });

test("shapes, connectors, charts, and images map to native parts; the rest is reported", () => {
  const { bytes, report } = paperDomToPptx(board([
    el("r", "shape", { content: { text: "Box" } }),
    el("tri", "shape", { geometry: "triangle" }),
    el("e", "ellipse", { style: { fill: "rgba(255, 0, 0, 0.5)", opacity: 1 } }),
    el("c", "connector", { from: { elementId: "e", anchor: "right" }, to: { x: 5, y: 5 } }),
    el("chart", "chart", { chart: { kind: "line", labels: ["a", "b"], series: [{ name: "S1", values: [1, 2] }, { name: "S2", values: [3, 1] }], title: "Trend" } }),
    el("img", "image", { content: { src: `data:image/png;base64,${PNG}`, alt: "dot" } }),
    el("remote", "image", { content: { src: "https://example.test/x.png" } }),
    el("v", "video"),
  ]));
  const files = assertPackage(bytes);
  const slide = files.get("ppt/slides/slide1.xml")!;
  assert.match(slide, /<a:prstGeom prst="roundRect"><a:avLst><a:gd name="adj" fmla="val 12000"\/>/);
  assert.match(slide, /<a:prstGeom prst="triangle">/);
  assert.match(slide, /<a:prstGeom prst="ellipse">.*<a:srgbClr val="FF0000"><a:alpha val="50000"\/>/s);
  assert.match(slide, /<p:cxnSp>.*<a:xfrm flipH="1" flipV="1"><a:off x="47625" y="47625"\/>/s, "connectors flip toward their end point");
  assert.match(slide, /<c:chart [^>]*r:id="rId2"\/>/);
  assert.match(files.get("ppt/charts/chart1.xml")!, /<c:lineChart>.*<c:v>S1<\/c:v>.*<c:v>S2<\/c:v>.*<c:legend>/s);
  assert.match(slide, /<a:blip r:embed="rId3"\/>/);
  assert.equal(Buffer.from(readZip(bytes).find((entry) => entry.path === "ppt/media/image1.png")!.data).toString("base64"), PNG);
  assert.match(files.get("[Content_Types].xml")!, /<Default Extension="png" ContentType="image\/png"\/>/);
  assert.match(slide, /<a:t>image<\/a:t>/, "linked images become placeholders");
  assert.ok(report.approximated.some((item) => item.startsWith("linked images")));
  assert.ok(report.approximated.some((item) => item.startsWith("video elements")));
  assert.ok(report.unsupported.some((item) => item.startsWith("animations")));
});

test("canvas colours convert to OOXML hex", () => {
  assert.deepEqual(hex("#abc"), { rgb: "AABBCC", alpha: 1 });
  assert.deepEqual(hex("#11223380"), { rgb: "112233", alpha: 128 / 255 });
  assert.deepEqual(hex("rgb(255, 128, 0)"), { rgb: "FF8000", alpha: 1 });
  assert.equal(hex("transparent"), undefined);
  assert.equal(hex("url(x)"), undefined);
});

test("noma render --to pptx accepts .noma pages and canvas .json and reports fidelity", () => {
  const dir = mkdtempSync(join(tmpdir(), "noma-pptx-"));
  const fromNoma = join(dir, "deck.pptx");
  const a = spawnSync("npx", ["tsx", "src/cli.ts", "render", "examples/deck.noma", "--to", "pptx", "--out", fromNoma], { encoding: "utf8" });
  assert.equal(a.status, 0, a.stderr);
  assert.match(a.stderr, /\d+ slides; native: .*speaker notes/);
  assertPackage(readFileSync(fromNoma));
  const fromJson = join(dir, "board.pptx");
  const b = spawnSync("npx", ["tsx", "src/cli.ts", "render", "examples/canvas/agent-loop.paperdom.json", "--to", "pptx", "--out", fromJson], { encoding: "utf8" });
  assert.equal(b.status, 0, b.stderr);
  assert.match(parts(readFileSync(fromJson)).get("ppt/charts/chart1.xml")!, /<c:barChart>/);
  const missing = spawnSync("npx", ["tsx", "src/cli.ts", "render", "examples/deck.noma", "--to", "pptx"], { encoding: "utf8" });
  assert.equal(missing.status, 2);
  assert.match(missing.stderr, /--to pptx requires --out/);
});
