import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "../src/parser.js";
import { validate } from "../src/validator.js";
import { renderHtml } from "../src/renderer-html.js";
import { loadBook, loadBookChapters } from "../src/book.js";
import { renderSite } from "../src/renderer-site.js";
import type { SectionNode } from "../src/ast.js";

test("issue #6: ::table is allowed inside profile=research", () => {
  const doc = parse(
    `---\nprofile: research\n---\n::table{header align="-,c"}\n| A | B |\n| 1 | 2 |\n::\n`,
  );
  const diags = validate(doc);
  assert.ok(!diags.some((d) => d.code === "out-of-profile-directive"));
});

test("issue #6: profiles: [a, b] composes the directive union", () => {
  const doc = parse(
    `---\nprofiles:\n  - research\n  - technical\n---\n::claim{id="c1" noverify}\nx\n::\n::grid{columns=2}\n:::card\nA\n:::\n::\n`,
  );
  const diags = validate(doc);
  assert.ok(!diags.some((d) => d.code === "out-of-profile-directive"));
});

test("issue #6: composed profile still warns on out-of-list directives", () => {
  const doc = parse(
    `---\nprofiles:\n  - minimal\n---\n::grid{columns=2}\n:::card\nA\n:::\n::\n`,
  );
  const diags = validate(doc);
  assert.ok(
    diags.some(
      (d) =>
        d.code === "out-of-profile-directive" && d.message.includes("grid"),
    ),
  );
});

test("issue #7: --ignore-rule filters matching diagnostics", () => {
  const doc = parse(`# Hi\n\nSee [[no-such-id]].\n`);
  const without = validate(doc);
  assert.ok(without.some((d) => d.code === "broken-reference"));
  const filtered = validate(doc, { ignoreRules: ["broken-reference"] });
  assert.ok(!filtered.some((d) => d.code === "broken-reference"));
});

test("issue #7: unknown ignored rule produces an info note", () => {
  const doc = parse(`# Hi\n`);
  const diags = validate(doc, { ignoreRules: ["does-not-exist"] });
  assert.ok(
    diags.some(
      (d) =>
        d.code === "unknown-ignore-rule" &&
        d.message.includes("does-not-exist"),
    ),
  );
});

test("issue #5: filename slug aliases the chapter root", () => {
  const doc = parse(`# Risk Premia 3 (RP3)\n\nbody\n`, {
    filename: "/abs/strategies/risk-premia-3.noma",
  });
  const root = doc.children[0] as SectionNode;
  assert.equal(root.id, "risk-premia-3-rp3");
  assert.ok(root.aliases?.includes("risk-premia-3"));
});

test("issue #5: frontmatter aliases attach to chapter root", () => {
  const doc = parse(
    `---\naliases:\n  - rp3\n  - risk-premia-3\n---\n# Risk Premia 3 (RP3)\n`,
  );
  const root = doc.children.find((n): n is SectionNode => n.type === "section" && n.level === 1);
  assert.ok(root, "expected a level-1 section");
  assert.deepEqual(
    [...new Set(root.aliases)].sort(),
    ["rp3", "risk-premia-3"].sort(),
  );
});

test("issue #5: wikilinks resolve via alias in validator", () => {
  const doc = parse(
    `---\naliases:\n  - rp3\n---\n# Risk Premia 3\n\nSee [[rp3]].\n`,
  );
  const diags = validate(doc);
  assert.ok(!diags.some((d) => d.code === "broken-reference"));
});

test("review fix #3: wikilinks support /, ., : in IDs", () => {
  const doc = parse(
    `# T\n\n::claim{id="chapter/risks"}\nx\n::\n\n::claim{id="metric.r10"}\ny\n::\n\n::claim{id="ns:scoped"}\nz\n::\n\nSee [[chapter/risks]], [[metric.r10]], [[ns:scoped]].\n`,
  );
  const diags = validate(doc);
  assert.ok(
    !diags.some((d) => d.code === "broken-reference"),
    `unexpected broken-reference: ${JSON.stringify(diags)}`,
  );
  const html = renderHtml(doc);
  assert.match(html, /href="#chapter\/risks"/);
  assert.match(html, /href="#metric\.r10"/);
  assert.match(html, /href="#ns:scoped"/);
});

test("issue #5: HTML emits hidden anchors for aliases", () => {
  const doc = parse(
    `---\naliases:\n  - rp3\n---\n# Risk Premia 3\n\nbody\n`,
  );
  const html = renderHtml(doc);
  assert.match(html, /<a class="noma-alias" id="rp3"/);
});

test("review hardening: section IDs render once in HTML", () => {
  const doc = parse(`# Title {id="stable-section"}\n\nbody\n`);
  const html = renderHtml(doc);
  assert.equal(html.match(/id="stable-section"/g)?.length, 1);
  assert.match(html, /<section id="stable-section" data-level="1">/);
  assert.match(html, /<h1>Title<\/h1>/);
});

test("issue #4: heading {id=...} attribute overrides slug", () => {
  const doc = parse(`# Title\n\n## Risks {id="rp3-risks"}\n\nbody\n`);
  const root = doc.children[0] as SectionNode;
  const sub = root.children[0] as SectionNode;
  assert.equal(sub.id, "rp3-risks");
});

test("issue #4: book mode scopes heading IDs by chapter", () => {
  const doc = loadBook("examples/book/book.noma.yml");
  const ids: string[] = [];
  const collect = (n: any): void => {
    if (n.id) ids.push(n.id);
    if (n.children) for (const c of n.children) collect(c);
  };
  for (const c of doc.children) collect(c);
  assert.ok(ids.some((id) => id.includes("/")), "expected at least one scoped ID");
  const dups: Record<string, number> = {};
  for (const id of ids) dups[id] = (dups[id] ?? 0) + 1;
  for (const [id, count] of Object.entries(dups)) {
    assert.equal(count, 1, `duplicate id "${id}" after scoping`);
  }
});

test("issue #4: book mode reports zero duplicate-id errors", () => {
  const doc = loadBook("examples/book/book.noma.yml");
  const diags = validate(doc, { now: new Date("2026-05-09") });
  assert.ok(!diags.some((d) => d.code === "duplicate-id"));
});

test("issue #3: --to site emits multi-page output with cross-chapter links", () => {
  const dir = mkdtempSync(join(tmpdir(), "noma-site-"));
  const { manifest, chapters } = loadBookChapters("examples/book/book.noma.yml");
  renderSite(manifest, chapters, dir, { themeCss: "" });
  const files = readdirSync(dir).sort();
  assert.ok(files.includes("index.html"));
  assert.ok(files.length >= chapters.length + 1);
  const ch3 = readFileSync(join(dir, "edits-agents-can-trust.html"), "utf8");
  assert.match(ch3, /noma-xchapter/);
  assert.match(ch3, /href="why-noma-exists\.html#/);
  const idx = readFileSync(join(dir, "index.html"), "utf8");
  assert.match(idx, /noma-site-toc/);
});

test("issue #2: ::math directive renders display math container", () => {
  const doc = parse(`::math{id="vol"}\nw_t = \\frac{a}{b}\n::\n`);
  const html = renderHtml(doc);
  assert.match(html, /class="noma-math noma-math-display"/);
  assert.match(html, /id="vol"/);
  assert.match(html, /\\\[w_t/);
});

test("issue #2: standalone HTML injects KaTeX assets when math is present", () => {
  const doc = parse(`::math\nx^2\n::\n`);
  const html = renderHtml(doc, { standalone: true });
  assert.match(html, /katex.min.css/);
  assert.match(html, /auto-render.min.js/);
});

test("issue #2: math: katex is auto-detected from $$..$$ delimiters", () => {
  const doc = parse(`# Hi\n\nThe formula $$x^2 + y^2 = z^2$$ is famous.\n`);
  const html = renderHtml(doc, { standalone: true });
  assert.match(html, /katex.min.css/);
});

test("issue #2: math assets disabled when --math=none", () => {
  const doc = parse(`::math\nx^2\n::\n`);
  const html = renderHtml(doc, { standalone: true, math: "none" });
  assert.ok(!/katex.min.css/.test(html));
});

test("review hardening: externalAssets=false omits CDN runtimes", () => {
  const doc = parse(
    `::math\nx^2\n::\n\n::diagram{kind="mermaid"}\ngraph TD; A-->B\n::\n\n::plotly\n{"data":[]}\n::\n`,
  );
  const html = renderHtml(doc, { standalone: true, externalAssets: false });
  assert.ok(!/cdn\.jsdelivr\.net/.test(html));
  assert.ok(!/cdn\.plot\.ly/.test(html));
  assert.ok(!/katex\.min\.css/.test(html));
  assert.match(html, /noma-diagram-source/);
  assert.match(html, /noma-plotly/);
});

test("issue #9: site index card descriptions parse inline markdown", () => {
  const dir = mkdtempSync(join(tmpdir(), "noma-site-"));
  const { manifest, chapters } = loadBookChapters("examples/book/book.noma.yml");
  renderSite(manifest, chapters, dir, { themeCss: "" });
  const idx = readFileSync(join(dir, "index.html"), "utf8");
  assert.ok(!/\*\*[^*]+\*\*/.test(idx), "raw **bold** must not appear in index");
  assert.ok(!/`[^`]+`/.test(idx), "raw `code` must not appear in index");
  assert.ok(!/\[\[[^\]]+\]\]/.test(idx), "raw [[wikilink]] must not appear in index");
});

test("issue #9: site index renders <strong>/<em>/<code> from summary markup", () => {
  const dir = mkdtempSync(join(tmpdir(), "noma-issue9-"));
  const { manifest, chapters } = loadBookChapters("examples/book/book.noma.yml");
  // Inject a chapter with rich markup into the bundle
  const richChapter = chapters[0];
  if (richChapter) {
    richChapter.doc = parse(
      `# Demo\n\n::summary\nThis chapter covers **bold ideas** and \`code-like\` concepts.\n::\n`,
      { filename: "/tmp/demo.noma" },
    );
    richChapter.slug = "demo-issue9";
  }
  renderSite(manifest, chapters, dir, { themeCss: "" });
  const idx = readFileSync(join(dir, "index.html"), "utf8");
  assert.match(idx, /<strong>bold ideas<\/strong>/);
  assert.match(idx, /<code>code-like<\/code>/);
});

test("issue #9: site index includes nav.noma-site-nav", () => {
  const dir = mkdtempSync(join(tmpdir(), "noma-site-"));
  const { manifest, chapters } = loadBookChapters("examples/book/book.noma.yml");
  renderSite(manifest, chapters, dir, { themeCss: "" });
  const idx = readFileSync(join(dir, "index.html"), "utf8");
  assert.match(idx, /<nav class="noma-site-nav"/);
  assert.ok(idx.includes("noma-nav-current"), "home crumb should be marked current on index");
});

test("issue #9: card description truncates at sentence boundary", () => {
  const dir = mkdtempSync(join(tmpdir(), "noma-issue9-trunc-"));
  const { manifest, chapters } = loadBookChapters("examples/book/book.noma.yml");
  const ch = chapters[0];
  if (ch) {
    ch.doc = parse(
      `# Demo\n\n::summary\nFirst sentence here. Second sentence should not appear.\n::\n`,
      { filename: "/tmp/demo.noma" },
    );
    ch.slug = "demo-trunc";
  }
  renderSite(manifest, chapters, dir, { themeCss: "" });
  const idx = readFileSync(join(dir, "index.html"), "utf8");
  assert.match(idx, /First sentence here\./);
  assert.ok(!/Second sentence/.test(idx));
});

test("issue #8: package.json declares dist in files and prepare script", () => {
  const pkg = JSON.parse(readFileSync("package.json", "utf8"));
  assert.ok(pkg.files.includes("dist"), "dist must be in files");
  assert.ok(pkg.scripts.prepare, "prepare script must exist");
});
