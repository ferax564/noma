import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { parse } from "../src/parser.js";
import { validate } from "../src/validator.js";
import { renderPaperDom } from "../src/renderer-paperdom.js";
import { paperDomToPptx } from "../src/paperdom-pptx.js";
import { auditCanvasDocument, auditCanvasPage, estimateTextFit } from "../src/canvas-text-metrics.js";
import { describeChange, diffCanvasDocuments, reviewSlideChanges } from "../src/canvas-review.js";
import { createAgentSafetyProof, renderProofHtml, renderProofMarkdownSummary } from "../src/proof.js";
import { documentSlidePngPages, renderSlidePngs, slidePngPages } from "../src/slide-png.js";
import type { CanvasPage, PaperDOMDocument } from "../src/paperdom-document-model.js";

const LONG_ITEMS = Array.from({ length: 24 }, (_, i) => `- Point ${i + 1} carries a fairly long explanation that wraps across most of the slide width`).join("\n");

const DECK = `---
title: Visual
---

::deck{id="d"}
:::slide{id="intro" layout="title"}
# Hello deck
:::

:::slide{id="busy" title="Busy slide"}
${LONG_ITEMS}
:::

:::slide{id="calm" title="Calm slide"}
- One short point
:::

:::slide{id="secret" title="Hidden" hidden}
- not shown
:::
::
`;

function canvasPage(elements: CanvasPage["elements"], id = "p1"): CanvasPage {
  return { id, name: id, size: { width: 1280, height: 720 }, background: { color: "#fff" }, elements } as CanvasPage;
}

function canvasDoc(pages: CanvasPage[]): PaperDOMDocument {
  return { format: "paperdom", version: "0.1", id: "c", title: "c", revision: 0, pages, plugins: [], metadata: { createdAt: "", updatedAt: "" } } as PaperDOMDocument;
}

function textEl(id: string, text: string, frame: { x: number; y: number; w: number; h: number }, fontSize = 24): CanvasPage["elements"][number] {
  return { id, type: "text", name: id, frame: { ...frame, rotation: 0 }, z: 1, style: { fontSize, lineHeight: 1.3, fontFamily: "Inter" }, content: { text } } as CanvasPage["elements"][number];
}

// --- text metrics -----------------------------------------------------------

test("estimateTextFit: short text fits, long text overflows with a smaller suggested size", () => {
  const fits = estimateTextFit("Hello", { fontSize: 24, lineHeight: 1.3 }, 400, 40);
  assert.equal(fits.lines, 1);
  assert.equal(fits.overflow, false);
  assert.equal(fits.suggestedFontSize, 24);

  const long = estimateTextFit("word ".repeat(200), { fontSize: 24, lineHeight: 1.3 }, 400, 100);
  assert.ok(long.lines > 20);
  assert.equal(long.overflow, true);
  assert.ok(long.suggestedFontSize < 24 && long.suggestedFontSize >= 8);
});

test("estimateTextFit: mono fonts are wider, hard line breaks each count, garbage styles fall back", () => {
  const sans = estimateTextFit("x".repeat(100), { fontSize: 20, fontFamily: "Inter" }, 500, 1000);
  const mono = estimateTextFit("x".repeat(100), { fontSize: 20, fontFamily: "JetBrains Mono" }, 500, 1000);
  assert.ok(mono.lines >= sans.lines);
  assert.equal(estimateTextFit("a\n\nb", {}, 500, 1000).lines, 3);
  const weird = estimateTextFit("abc", { fontSize: Number.NaN, lineHeight: -3 } as never, 500, 100);
  assert.equal(weird.overflow, false);
});

test("auditCanvasPage flags overflow and off-page elements, ignores hidden ones", () => {
  const page = canvasPage([
    textEl("ok", "Fine", { x: 10, y: 10, w: 300, h: 60 }),
    textEl("tight", "long text ".repeat(80), { x: 10, y: 100, w: 300, h: 60 }),
    textEl("off", "edge", { x: 1200, y: 10, w: 200, h: 60 }),
    { ...textEl("ghost", "long text ".repeat(80), { x: 10, y: 200, w: 300, h: 20 }), hidden: true },
  ]);
  const warnings = auditCanvasPage(page);
  assert.deepEqual(warnings.map((w) => [w.code, w.elementId]), [["text_overflow", "tight"], ["outside_page", "off"]]);
  assert.ok(warnings[0]!.fit!.estimatedHeight > 60);
});

test("auditCanvasDocument survives malformed canvas JSON", () => {
  const junk = { format: "paperdom", pages: [{ id: "x", elements: [null, 5, { type: "text", frame: "no" }] }, null] } as unknown as PaperDOMDocument;
  assert.deepEqual(auditCanvasDocument(junk), []);
});

// --- validator rule ---------------------------------------------------------

test("validator: slide-text-overflow warns on the overflowing slide only, and is ignorable", () => {
  const doc = parse(DECK);
  const diagnostics = validate(doc).filter((d) => d.code === "slide-text-overflow");
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0]!.nodeId, "busy");
  assert.equal(diagnostics[0]!.severity, "warning");
  assert.match(diagnostics[0]!.message, /busy.*body/);
  assert.ok(diagnostics[0]!.pos);

  const ignored = validate(doc, { ignoreRules: ["slide-text-overflow"] });
  assert.equal(ignored.filter((d) => d.code === "slide-text-overflow" || d.code === "unknown-ignore-rule").length, 0);
});

test("validator: noverify slides and documents without a deck are not checked", () => {
  assert.equal(validate(parse(DECK.replace('id="busy"', 'id="busy" noverify'))).filter((d) => d.code === "slide-text-overflow").length, 0);
  const plain = parse(`# Title\n\n## Part one\n\n${LONG_ITEMS}\n\n## Part two\n\nShort.\n`);
  assert.equal(validate(plain).filter((d) => d.code === "slide-text-overflow").length, 0);
});

test("validator: ::canvas pages with overflowing text warn", () => {
  const json = JSON.stringify(canvasDoc([canvasPage([textEl("t", "lots of words ".repeat(60), { x: 0, y: 0, w: 200, h: 40 })])]));
  const doc = parse(`::canvas{id="board"}\n\`\`\`json\n${json}\n\`\`\`\n::\n`);
  const diagnostics = validate(doc).filter((d) => d.code === "slide-text-overflow");
  assert.equal(diagnostics.length, 1);
  assert.equal(diagnostics[0]!.nodeId, "board");
});

// --- PPTX fidelity report ---------------------------------------------------

test("pptx fidelity report lists estimated text overflow", () => {
  const { report } = paperDomToPptx(renderPaperDom(parse(DECK)), { modified: new Date(0) });
  assert.equal(report.warnings.length, 1);
  assert.match(report.warnings[0]!, /^text overflow: busy\/busy--body needs ~\d+px in a \d+px frame$/);
  const clean = paperDomToPptx(renderPaperDom(parse(DECK.replace(LONG_ITEMS, "- short"))), { modified: new Date(0) });
  assert.deepEqual(clean.report.warnings, []);
});

// --- element diff + visual review -------------------------------------------

test("diffCanvasDocuments classifies moved, resized, text, created, and deleted elements", () => {
  const before = canvasDoc([canvasPage([
    textEl("a", "Alpha", { x: 0, y: 0, w: 100, h: 50 }),
    textEl("b", "Beta", { x: 0, y: 100, w: 100, h: 50 }),
    textEl("c", "Gamma", { x: 0, y: 200, w: 100, h: 50 }),
  ])]);
  const after = canvasDoc([canvasPage([
    textEl("a", "Alpha", { x: 40, y: 0, w: 300, h: 50 }),
    textEl("b", "Beta!", { x: 0, y: 100, w: 100, h: 50 }),
    textEl("d", "Delta", { x: 0, y: 300, w: 100, h: 50 }),
  ])]);
  const changes = diffCanvasDocuments(before, after);
  const byId = Object.fromEntries(changes.filter((c) => c.action !== "moved").map((c) => [c.elementId, describeChange(c)]));
  assert.equal(byId.a, "moved, resized");
  assert.equal(byId.b, "text changed");
  assert.equal(byId.c, "removed");
  assert.equal(byId.d, "added");
  assert.deepEqual(diffCanvasDocuments(before, before), []);
});

test("reviewSlideChanges previews only the changed slide, with before/after SVG", () => {
  const before = parse(DECK);
  const after = parse(DECK.replace("- One short point", "- One short point\n- A new second point"));
  const review = reviewSlideChanges(before, after);
  assert.ok(review);
  assert.deepEqual(review.pages.map((p) => [p.source, p.containerId, p.pageId]), [["deck", "d", "calm"]]);
  const page = review.pages[0]!;
  assert.match(page.beforeSvg!, /^<svg /);
  assert.match(page.afterSvg!, /A new second point/);
  assert.ok(!page.beforeSvg!.includes("A new second point"));
  assert.deepEqual(page.changes.map((c) => [c.elementId, describeChange(c)]), [["calm--body", "text changed"]]);
  assert.equal(reviewSlideChanges(before, parse(DECK)), undefined);
  assert.equal(reviewSlideChanges(parse("# Plain\n\nText.\n"), parse("# Plain\n\nMore text.\n")), undefined);
});

test("proof: deck edits carry a visual review into HTML, markdown, and stay absent otherwise", () => {
  const proof = createAgentSafetyProof({
    filePath: "deck.noma",
    source: DECK,
    ops: [{ op: "update_attribute", id: "calm", key: "title", value: "Calm <b>slide</b> renamed" }],
    inlineSources: false,
  });
  assert.equal(proof.patchResult, "applied");
  assert.ok(proof.slideReview);
  assert.equal(proof.slideReview.pages[0]!.pageId, "calm");
  const html = renderProofHtml(proof);
  assert.match(html, /<h2>Visual Review<\/h2>/);
  assert.equal((html.match(/class="slide-review-svg"/g) ?? []).length, 2);
  assert.ok(!html.includes("Calm <b>slide</b>"), "slide text is escaped");
  assert.match(html, /text changed/);
  assert.match(renderProofMarkdownSummary(proof), /### Visual Review\n\n- `deck:d\/calm`/);

  const plain = createAgentSafetyProof({
    filePath: "doc.noma",
    source: "# Doc\n\n::decision{id=\"x\" status=\"open\"}\nShip it.\n::\n",
    ops: [{ op: "update_attribute", id: "x", key: "status", value: "accepted" }],
    inlineSources: false,
  });
  assert.equal(plain.slideReview, undefined);
  assert.ok(!renderProofHtml(plain).includes("Visual Review"));
});

test("proof: layout warnings of the edited slide surface in the review", () => {
  const proof = createAgentSafetyProof({
    filePath: "deck.noma",
    source: DECK,
    ops: [{ op: "replace_block", id: "calm", content: `:::slide{id="calm" title="Calm slide"}\n${LONG_ITEMS}\n:::` }],
    inlineSources: false,
  });
  const page = proof.slideReview?.pages.find((p) => p.pageId === "calm");
  assert.ok(page);
  assert.equal(page.warnings[0]?.code, "text_overflow");
  assert.ok(proof.postDiagnostics.some((d) => d.code === "slide-text-overflow" && d.nodeId === "calm"));
});

// --- PNG pages --------------------------------------------------------------

test("slidePngPages: one script-free page per visible slide, named by position and slide ID", () => {
  const pages = documentSlidePngPages(parse(DECK));
  assert.deepEqual(pages.map((p) => p.fileName), ["01-intro.png", "02-busy.png", "03-calm.png"]);
  for (const page of pages) {
    assert.equal(page.width, 1280);
    assert.equal(page.height, 720);
    assert.match(page.html, /Content-Security-Policy" content="default-src 'none'/);
    assert.ok(!/<script/i.test(page.html));
  }
  assert.deepEqual(documentSlidePngPages(parse(DECK), { slide: "secret" }).map((p) => p.fileName), ["04-secret.png"]);
  assert.throws(() => documentSlidePngPages(parse(DECK), { slide: "nope" }), /No slide "nope".*intro, busy, calm, secret/);
});

test("slidePngPages: canvas text is escaped and unsafe file characters are replaced", () => {
  const pages = slidePngPages(canvasDoc([canvasPage([textEl("t", "<img src=x onerror=alert(1)>", { x: 0, y: 0, w: 400, h: 60 })], "../odd id")]));
  assert.equal(pages[0]!.fileName, "01-odd-id.png");
  assert.ok(!pages[0]!.html.includes("<img src=x"));
});

async function chromeAvailable(): Promise<string | undefined> {
  try {
    const puppeteer = await import("puppeteer");
    const path = puppeteer.default.executablePath();
    return existsSync(path) ? undefined : `Chrome not installed at ${path} (npx puppeteer browsers install chrome)`;
  } catch (error) {
    return `puppeteer not importable: ${error instanceof Error ? error.message : String(error)}`;
  }
}

const skipPng = await chromeAvailable();

test("renderSlidePngs writes real PNGs at the slide size", { skip: skipPng }, async () => {
  const pages = documentSlidePngPages(parse(DECK), { slide: "intro" });
  const [rendered] = await renderSlidePngs(pages, { scale: 0.5 });
  assert.ok(rendered);
  const png = rendered.png;
  assert.equal(png.subarray(1, 4).toString("latin1"), "PNG");
  assert.equal(png.readUInt32BE(16), 640);
  assert.equal(png.readUInt32BE(20), 360);
});

test("CLI: render --to png writes one file per slide", { skip: skipPng }, () => {
  const out = mkdtempSync(join(tmpdir(), "noma-png-"));
  const result = spawnSync(process.execPath, ["--import", "tsx", "src/cli.ts", "render", "examples/deck.noma", "--to", "png", "--out", out], { encoding: "utf8" });
  assert.equal(result.status, 0, result.stderr);
  const files = readdirSync(out).sort();
  assert.equal(files[0], "01-pitch-cover.png");
  assert.ok(files.length >= 6);
  assert.equal(readFileSync(join(out, files[0]!)).subarray(1, 4).toString("latin1"), "PNG");
});

test("CLI: render --to png requires --out and rejects unknown slides", () => {
  const noOut = spawnSync(process.execPath, ["--import", "tsx", "src/cli.ts", "render", "examples/deck.noma", "--to", "png"], { encoding: "utf8" });
  assert.equal(noOut.status, 2);
  assert.match(noOut.stderr, /--to png requires --out/);
  const out = mkdtempSync(join(tmpdir(), "noma-png-"));
  const bad = spawnSync(process.execPath, ["--import", "tsx", "src/cli.ts", "render", "examples/deck.noma", "--to", "png", "--out", out, "--slide", "nope"], { encoding: "utf8" });
  assert.equal(bad.status, 2);
  assert.match(bad.stderr, /No slide "nope"/);
});
