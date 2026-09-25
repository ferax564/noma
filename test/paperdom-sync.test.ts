import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "../src/parser.js";
import { patchSource } from "../src/patch.js";
import { validate } from "../src/validator.js";
import { renderPaperDom } from "../src/renderer-paperdom.js";
import { paperDomToPatchOps, rebaseInlineEdit } from "../src/paperdom-sync.js";
import { componentKitFromSource } from "../src/components.js";
import type { PaperDOMDocument } from "../src/paperdom-document-model.js";

const DECK = `# Deck

::deck{id="d" title="Deck"}
:::slide{id="s1" title="Pricing **now**"}
- Team costs **$8** per month
- Free for *small* teams

::::notes
Mention the discount.
::::
:::

:::slide{id="s2" layout="title"}
## Welcome aboard {id="welcome"}

Subtitle here
:::

:::slide{id="s3" title="Numbers"}
{#nums}
| k | v |
|---|---|
| a | 1 |
:::

:::slide{id="s4" title="Plain table"}
| k | v |
|---|---|
| a | 1 |
:::
::
`;

function canvasOf(source: string, options = {}): PaperDOMDocument {
  return structuredClone(renderPaperDom(parse(source), options));
}

function element(canvas: PaperDOMDocument, id: string) {
  for (const page of canvas.pages) for (const el of page.elements) if (el.id === id) return el;
  throw new Error(`no element ${id}`);
}

function setParagraph(canvas: PaperDOMDocument, id: string, index: number, text: string): void {
  const el = element(canvas, id);
  el.content!.paragraphs![index]!.text = text;
  el.content!.text = el.content!.paragraphs!.map((p) => p.text).join("\n");
}

function apply(source: string, canvas: PaperDOMDocument, options = {}): { next: string; result: ReturnType<typeof paperDomToPatchOps> } {
  const result = paperDomToPatchOps(parse(source), canvas, options);
  return { next: patchSource(source, result.ops), result };
}

test("rebaseInlineEdit keeps inline markup around the edited span", () => {
  assert.equal(rebaseInlineEdit("Team costs **$8** per month", "Team costs $8 per month", "Team costs $9 per month"), "Team costs **$9** per month");
  assert.equal(rebaseInlineEdit("Free for *small* teams", "Free for small teams", "Free for tiny teams"), "Free for *tiny* teams");
  assert.equal(rebaseInlineEdit("plain text", "plain text", "new text"), "new text");
  assert.equal(rebaseInlineEdit("[link](https://x.test) here", "link here", "link there"), "[link](https://x.test) there");
});

test("an unedited canvas produces no ops", () => {
  const result = paperDomToPatchOps(parse(DECK), canvasOf(DECK));
  assert.deepEqual(result, { ops: [], changes: [], skipped: [] });
});

test("title, bullet, heading, and notes edits come back as ops that keep formatting", () => {
  const canvas = canvasOf(DECK);
  element(canvas, "s1--title").content!.text = "Pricing today";
  setParagraph(canvas, "s1--body", 0, "Team costs $9 per month");
  element(canvas, "s2--title").content!.text = "Welcome on board";
  canvas.pages.find((p) => p.id === "s1")!.notes = "Mention the launch discount.";
  const { next, result } = apply(DECK, canvas);
  assert.match(next, /:::slide\{id="s1" title="Pricing \*\*today\*\*"\}/);
  assert.match(next, /- Team costs \*\*\$9\*\* per month/);
  assert.match(next, /- Free for \*small\* teams/);
  assert.match(next, /::::notes\nMention the launch discount\.\n::::/);
  assert.match(next, /## Welcome on board \{id="welcome"\}/);
  assert.deepEqual(validate(parse(next)).filter((d) => d.severity === "error"), []);
  assert.deepEqual(result.skipped, []);
  const reexported = renderPaperDom(parse(next));
  assert.equal(element(reexported, "s1--body").content!.paragraphs![0]!.text, "Team costs $9 per month");
});

test("pipe-table cell edits are carried by the enclosing slide", () => {
  const canvas = canvasOf(DECK);
  element(canvas, "s3--nums").table!.rows[1]![1] = "2";
  element(canvas, "s4--table-1").table!.rows[0]![0] = "key";
  const { next, result } = apply(DECK, canvas);
  assert.deepEqual(result.ops.map((op) => `${op.op}:${"id" in op ? op.id : ""}`).sort(), ["replace_block:s3", "replace_block:s4"]);
  assert.match(next, /\{#nums\}\n\|/, "the table keeps its id marker");
  assert.match(next, /\| a +\| 2 +\|/);
  assert.match(next, /\| key +\| v +\|/);
});

test("hidden, transition, and slide order sync; notes are added when missing", () => {
  const canvas = canvasOf(DECK);
  const s2 = canvas.pages.find((p) => p.id === "s2")!;
  s2.hidden = true;
  s2.transition = "fade";
  s2.notes = "New notes";
  canvas.pages.reverse();
  const { next } = apply(DECK, canvas);
  const doc = parse(next);
  const deck = doc.children.find((n) => n.type === "section")!;
  assert.ok(deck.type === "section");
  const deckNode = deck.children.find((n) => n.type === "directive" && n.name === "deck");
  assert.ok(deckNode && deckNode.type === "directive");
  assert.deepEqual(deckNode.children.map((c) => c.id), ["s4", "s3", "s2", "s1"]);
  assert.match(next, /:::slide\{id="s2" layout="title" hidden transition="fade"\}/);
  assert.match(next, /::::notes\nNew notes\n::::/);
});

test("changes that cannot map to text are reported, not guessed", () => {
  const canvas = canvasOf(DECK);
  const body = element(canvas, "s1--body");
  body.content!.paragraphs!.push({ text: "A new bullet", kind: "bullet", level: 0 });
  body.content!.text = body.content!.paragraphs!.map((p) => p.text).join("\n");
  element(canvas, "s2--title").frame.x += 50;
  canvas.pages.push({ ...structuredClone(canvas.pages[0]!), id: "extra", elements: [] });
  canvas.pages.find((p) => p.id === "s3")!.elements = [];
  const result = paperDomToPatchOps(parse(DECK), canvas);
  assert.deepEqual(result.ops, []);
  const reasons = result.skipped.map((s) => s.reason).join(" | ");
  assert.match(reasons, /paragraphs were added/);
  assert.match(reasons, /layout stays in PaperDOM/);
  assert.match(reasons, /new page on the canvas/);
  assert.match(reasons, /element deleted on the canvas/);
});

test("section-derived pages sync headings and addressable blocks; plain paragraphs are reported", () => {
  const source = "# Guide\n\nIntro text\n\n## Setup {id=\"setup\"}\n\n{#install}\nInstall **Node** first.\n\nThen clone.\n\n## Deploy\n\nShip it.\n";
  const canvas = canvasOf(source);
  element(canvas, "setup--title").content!.text = "Getting set up";
  setParagraph(canvas, "setup--body", 0, "Install Node 22 first.");
  setParagraph(canvas, "setup--body", 1, "Then fork.");
  const { next, result } = apply(source, canvas);
  assert.match(next, /## Getting set up \{id="setup"\}/);
  assert.match(next, /\{#install\}\nInstall \*\*Node\*\* 22 first\./, "text inserted at a formatting boundary goes after the markup");
  assert.match(next, /Then clone\./, "an unaddressed paragraph under a heading is not rewritten");
  assert.match(result.skipped.map((s) => s.reason).join(" "), /paragraph has no id and sits outside any ::slide/);
  assert.ok(result.ops.some((op) => op.op === "replace_body" && op.id === "install"));
});

test("text produced by a component is not written back", () => {
  const kit = componentKitFromSource(`::component{name="stat" props="value"}\n:::card{title="{{value}}"}\nStat\n:::\n::\n`);
  const source = `::deck{id="d"}\n:::slide{id="s" title="T"}\n::::stat{id="st" value="9"}\n::::\n:::\n::\n`;
  const canvas = canvasOf(source, { components: kit });
  setParagraph(canvas, "s--body", 0, "Changed");
  const result = paperDomToPatchOps(parse(source), canvas, { components: kit });
  assert.deepEqual(result.ops, []);
  assert.match(result.skipped.map((s) => s.reason).join(" "), /comes from a component/);
});

test("an invalid canvas is rejected", () => {
  assert.throws(() => paperDomToPatchOps(parse(DECK), { format: "paperdom" } as unknown as PaperDOMDocument), /Invalid PaperDOM document/);
});

test("noma paperdom-sync prints proof-ready ops and --inplace applies them", () => {
  const dir = mkdtempSync(join(tmpdir(), "noma-paperdom-sync-"));
  const file = join(dir, "deck.noma");
  const canvasFile = join(dir, "canvas.json");
  writeFileSync(file, DECK);
  const canvas = canvasOf(DECK);
  setParagraph(canvas, "s1--body", 1, "Free for tiny teams");
  writeFileSync(canvasFile, JSON.stringify(canvas));

  const dry = spawnSync("npx", ["tsx", "src/cli.ts", "paperdom-sync", file, canvasFile], { encoding: "utf8" });
  assert.equal(dry.status, 0, dry.stderr);
  const printed = JSON.parse(dry.stdout) as { ops: unknown[] };
  assert.equal(printed.ops.length, 1);
  assert.equal(readFileSync(file, "utf8"), DECK, "a dry run does not write");
  const opsFile = join(dir, "sync.json");
  writeFileSync(opsFile, dry.stdout);
  const proof = spawnSync("npx", ["tsx", "src/cli.ts", "proof", file, "--ops", opsFile, "--to", "markdown"], { encoding: "utf8" });
  assert.equal(proof.status, 0, proof.stderr);
  assert.match(proof.stdout, /Noma Proof: PASS/);

  const applied = spawnSync("npx", ["tsx", "src/cli.ts", "paperdom-sync", file, canvasFile, "--inplace"], { encoding: "utf8" });
  assert.equal(applied.status, 0, applied.stderr);
  assert.match(readFileSync(file, "utf8"), /- Free for \*tiny\* teams/);
});
