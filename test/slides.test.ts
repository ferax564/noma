import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { parse } from "../src/parser.js";
import { validate } from "../src/validator.js";
import { renderHtml } from "../src/renderer-html.js";
import { renderMarkdown } from "../src/renderer-markdown.js";
import { renderLlm } from "../src/renderer-llm.js";
import { renderPaperDom } from "../src/renderer-paperdom.js";
import { parsePaperDOMDocument } from "../src/paperdom-document-model.js";
import { normalizeStyleTokenAliases, parseStyleTokens } from "../src/style-tokens.js";
import { patchSource } from "../src/patch.js";

const DECK = `::deck{id="d" title="Deck" aspect="4:3"}
:::slide{id="s1" layout="title"}
## Welcome {id="welcome"}

Subtitle line
:::

:::slide{id="s2" title="Agenda" class="tone-accent"}
- First
- Second

::::notes
Say hello.
::::
:::

:::slide{id="s3" title="Numbers" layout="two-column"}
| k | v |
|---|---|
| a | 1 |

Left text
:::
::
`;

test("style tokens split known from unknown words", () => {
  assert.deepEqual(parseStyleTokens("tone-accent elevated bogus tone-accent"), {
    tokens: ["tone-accent", "elevated"],
    unknown: ["bogus"],
  });
  assert.deepEqual(parseStyleTokens(undefined), { tokens: [], unknown: [] });
});

test("class tokens render as n- classes on the block's outer element; unknown ones are dropped", () => {
  const html = renderHtml(parse(`::card{id="c" title="T" class="tone-info elevated evil"}\nBody\n::\n`), { standalone: false });
  assert.match(html, /<article class="noma-card n-tone-info n-elevated" id="c"/);
  assert.doesNotMatch(html, /evil/);
  assert.doesNotMatch(html, /data-class=/);
});

test("class tokens reach the generic directive fallback", () => {
  const html = renderHtml(parse(`::widget{id="w" class="span-2"}\nx\n::\n`), { standalone: false });
  assert.match(html, /<aside class="noma-block noma-custom-directive noma-block-widget n-span-2"/);
});

test("validator warns on unknown style tokens", () => {
  const diags = validate(parse(`::card{id="c" class="tone-info rainbow"}\nx\n::\n`));
  const d = diags.find((x) => x.code === "unknown-style-token");
  assert.ok(d);
  assert.match(d.message, /"rainbow"/);
});

test("validator enforces deck structure", () => {
  const diags = validate(parse(`:::slide{id="lost"}\nx\n:::\n\n::notes\ny\n::\n\n::deck{id="d" aspect="21:9"}\n:::slide{id="s" layout="spiral"}\nz\n:::\n::\n`));
  const codes = diags.map((d) => d.code);
  assert.ok(codes.includes("notes-outside-slide"));
  assert.ok(codes.includes("slide-unknown-layout"));
  assert.ok(codes.includes("deck-unknown-aspect"));
  assert.equal(validate(parse(DECK)).filter((d) => d.severity !== "info").length, 0);
});

test("slide outside a deck is an error", () => {
  const diags = validate(parse(`::grid\n:::slide{id="s"}\nx\n:::\n::\n`));
  assert.ok(diags.some((d) => d.code === "slide-outside-deck" && d.severity === "error"));
});

test("HTML renders a deck with numbered slides, layouts, notes, and the presenter runtime", () => {
  const doc = parse(DECK);
  const html = renderHtml(doc, { standalone: true });
  assert.match(html, /<section class="noma-deck" id="d" data-aspect="4:3"/);
  assert.match(html, /<article class="noma-slide noma-slide--title" id="s1" data-slide-index="1"/);
  assert.match(html, /<h2 class="noma-slide-title" id="welcome">Welcome<\/h2>/);
  assert.match(html, /class="noma-slide noma-slide--content n-tone-accent" id="s2"/);
  assert.match(html, /aria-label="Slide 2 of 3: Agenda"/);
  assert.match(html, /<details class="noma-slide-notes"><summary>Speaker notes<\/summary><p>Say hello.<\/p><\/details>/);
  assert.match(html, /data-noma-deck-present/);
  assert.match(html, /noma-presenting/);
  const plain = renderHtml(parse("# Just a doc\n\nText\n"), { standalone: true });
  assert.doesNotMatch(plain, /noma-presenting/);
});

test("HTML omits the presenter when interactivity is off", () => {
  const html = renderHtml(parse(DECK), { standalone: true, interactive: false });
  assert.doesNotMatch(html, /data-noma-deck-present/);
});

test("Markdown and LLM targets keep slides readable", () => {
  const doc = parse(DECK);
  const md = renderMarkdown(doc);
  assert.match(md, /## Agenda/);
  assert.match(md, /> \*\*Speaker notes\*\*/);
  const llm = renderLlm(doc);
  assert.match(llm, /\[SLIDE id="s2" title="Agenda" class="tone-accent"\]/);
  assert.match(llm, /\[NOTES\]/);
});

test("renderPaperDom emits a valid PaperDOM document keyed by block IDs", () => {
  const out = renderPaperDom(parse(DECK));
  const parsed = parsePaperDOMDocument(out);
  assert.ok(parsed.ok, parsed.ok ? "" : parsed.error);
  assert.equal(out.id, "d");
  assert.deepEqual(out.pages.map((p) => p.id), ["s1", "s2", "s3"]);
  assert.deepEqual(out.pages[0]!.size, { width: 1024, height: 768 });
  assert.equal(out.pages[1]!.notes, "Say hello.");
  const agenda = out.pages[1]!.elements.find((e) => e.id === "s2--body");
  assert.deepEqual(agenda?.content?.paragraphs, [
    { text: "First", kind: "bullet", level: 0 },
    { text: "Second", kind: "bullet", level: 0 },
  ]);
  const table = out.pages[2]!.elements.find((e) => e.type === "table");
  assert.deepEqual(table?.table?.rows, [["k", "v"], ["a", "1"]]);
  assert.equal(out.metadata.createdAt, "1970-01-01T00:00:00.000Z");
});

test("renderPaperDom is deterministic and does not mutate the AST", () => {
  const doc = parse(DECK);
  const before = JSON.stringify(doc);
  assert.deepEqual(renderPaperDom(doc), renderPaperDom(doc));
  assert.equal(JSON.stringify(doc), before);
});

test("renderPaperDom converts a deck-less document section-per-slide", () => {
  const doc = parse("# Title\n\nIntro\n\n## One\n\nAlpha\n\n## Two\n\n- Beta\n");
  const out = renderPaperDom(doc, { now: "2026-09-23T00:00:00.000Z" });
  assert.ok(parsePaperDOMDocument(out).ok);
  assert.deepEqual(out.pages.map((p) => p.name), ["One", "Two"]);
});

test("renderPaperDom rejects an unknown --deck id", () => {
  assert.throws(() => renderPaperDom(parse(DECK), { deck: "nope" }), /No ::deck with id "nope"/);
});

test("a single slide is patchable by ID without touching its neighbours", () => {
  const source = patchSource(DECK, [{ op: "update_attribute", id: "s2", key: "title", value: "Plan" }]);
  assert.ok(source.includes(`:::slide{id="s2" title="Plan" class="tone-accent"}`));
  assert.equal(source.replace(`title="Plan"`, `title="Agenda"`), DECK);
});

test("the example deck validates and converts", () => {
  const doc = parse(readFileSync("examples/deck.noma", "utf8"), { filename: "examples/deck.noma" });
  assert.equal(validate(doc).filter((d) => d.severity === "error").length, 0);
  assert.ok(parsePaperDOMDocument(renderPaperDom(doc)).ok);
});

test("style-token aliases expand to core tokens from frontmatter and host options", () => {
  const src = `---\nstyle_tokens:\n  hero-box: tone-info elevated\n  bad: not-a-token\n---\n\n::card{id="c" class="hero-box team-box"}\nx\n::\n`;
  const doc = parse(src);
  const plain = renderHtml(doc, { standalone: false });
  assert.match(plain, /class="noma-card n-tone-info n-elevated"/);
  const hosted = renderHtml(doc, { standalone: false, styleTokens: { "team-box": ["span-2"], "hero-box": ["tone-danger"] } });
  assert.match(hosted, /class="noma-card n-tone-danger n-span-2"/);
  const diags = validate(doc);
  assert.ok(diags.some((d) => d.code === "invalid-style-token-alias" && /unknown core token "not-a-token"/.test(d.message)));
  assert.ok(diags.some((d) => d.code === "unknown-style-token" && /"team-box"/.test(d.message)));
  assert.ok(!validate(doc, { styleTokens: { "team-box": ["span-2"] } }).some((d) => d.code === "unknown-style-token"));
});

test("normalizeStyleTokenAliases rejects shadowing, bad names, and non-core expansions", () => {
  const { aliases, errors } = normalizeStyleTokenAliases({ ok: "tone-accent,filled", "tone-info": "filled", "Bad Name": "filled", css: "color:red", empty: "" });
  assert.deepEqual(aliases, { ok: ["tone-accent", "filled"] });
  assert.equal(errors.length, 4);
});
