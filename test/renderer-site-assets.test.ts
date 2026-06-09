import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { loadBookChapters } from "../src/book.js";
import { renderSite } from "../src/renderer-site.js";

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "noma-site-"));
}

test("renderSite emits _assets/theme.css and links it from every page", () => {
  const dir = scratch();
  writeFileSync(join(dir, "ch1.noma"), "# Chapter One\n\nHello.\n");
  writeFileSync(join(dir, "ch2.noma"), "# Chapter Two\n\nWorld.\n");
  writeFileSync(
    join(dir, "book.yml"),
    "title: T\nchapters:\n  - ch1.noma\n  - ch2.noma\n",
  );
  const out = join(dir, "site");
  const { manifest, chapters } = loadBookChapters(join(dir, "book.yml"));
  renderSite(manifest, chapters, out, { themeCss: "body { color: red; }" });

  const themePath = join(out, "_assets", "theme.css");
  assert.ok(existsSync(themePath), "_assets/theme.css must exist");
  assert.equal(readFileSync(themePath, "utf8"), "body { color: red; }");

  for (const page of ["index.html", "chapter-one.html", "chapter-two.html"]) {
    const html = readFileSync(join(out, page), "utf8");
    assert.ok(
      html.includes(`<link rel="stylesheet" href="_assets/theme.css"`),
      `${page} must link _assets/theme.css`,
    );
    assert.ok(
      !html.includes("body { color: red; }"),
      `${page} must NOT inline the theme CSS body`,
    );
  }
});

test("renderSite with empty themeCss does not emit _assets/theme.css", () => {
  const dir = scratch();
  writeFileSync(join(dir, "ch.noma"), "# Only\n");
  writeFileSync(join(dir, "book.yml"), "title: T\nchapters:\n  - ch.noma\n");
  const out = join(dir, "site");
  const { manifest, chapters } = loadBookChapters(join(dir, "book.yml"));
  renderSite(manifest, chapters, out, { themeCss: "" });
  assert.ok(!existsSync(join(out, "_assets", "theme.css")));
});

test("renderSite computes a relative theme href for nested chapter slugs", () => {
  // Regression: a level-1 section with an explicit id containing `/` writes
  // the page into a subdirectory. The shared-asset link must climb up.
  const dir = scratch();
  writeFileSync(
    join(dir, "ch.noma"),
    `# Nested {id="part/intro"}\n\nHello.\n`,
  );
  writeFileSync(join(dir, "book.yml"), "title: T\nchapters:\n  - ch.noma\n");
  const out = join(dir, "site");
  const { manifest, chapters } = loadBookChapters(join(dir, "book.yml"));
  renderSite(manifest, chapters, out, { themeCss: "body { color: red; }" });

  const nestedPath = join(out, "part", "intro.html");
  assert.ok(existsSync(nestedPath), "nested chapter page must exist");
  const html = readFileSync(nestedPath, "utf8");
  assert.ok(
    html.includes(`<link rel="stylesheet" href="../_assets/theme.css"`),
    `nested chapter must link ../_assets/theme.css; got: ${html.slice(0, 400)}`,
  );

  const indexHtml = readFileSync(join(out, "index.html"), "utf8");
  assert.ok(
    indexHtml.includes(`<link rel="stylesheet" href="_assets/theme.css"`),
    `index must link root-relative _assets/theme.css`,
  );
});

test("renderSite nav links from a nested chapter use depth-aware prefixes", () => {
  const dir = scratch();
  writeFileSync(join(dir, "a.noma"), `# Nested {id="part/intro"}\n\nHi.\n`);
  writeFileSync(join(dir, "b.noma"), `# Flat\n\nHi.\n`);
  writeFileSync(
    join(dir, "c.noma"),
    `# OtherNested {id="other/page"}\n\nHi.\n`,
  );
  writeFileSync(
    join(dir, "book.yml"),
    "title: T\nchapters:\n  - a.noma\n  - b.noma\n  - c.noma\n",
  );
  const out = join(dir, "site");
  const { manifest, chapters } = loadBookChapters(join(dir, "book.yml"));
  renderSite(manifest, chapters, out, { themeCss: "x" });

  const nestedHtml = readFileSync(join(out, "part", "intro.html"), "utf8");
  assert.ok(
    nestedHtml.includes(`href="../flat.html"`),
    `nested → flat sibling link must climb up; got nav fragment: ${nestedHtml.slice(0, 800)}`,
  );
  assert.ok(
    nestedHtml.includes(`href="../other/page.html"`),
    `nested → nested sibling link must climb up; got nav fragment: ${nestedHtml.slice(0, 800)}`,
  );
  assert.ok(
    nestedHtml.includes(`href="../index.html"`),
    `nested home link must climb up; got nav fragment: ${nestedHtml.slice(0, 800)}`,
  );

  const flatHtml = readFileSync(join(out, "flat.html"), "utf8");
  assert.ok(
    flatHtml.includes(`href="part/intro.html"`),
    `flat → nested sibling link must descend; got: ${flatHtml.slice(0, 800)}`,
  );
  assert.ok(
    flatHtml.includes(`href="index.html"`),
    `flat home link stays root-relative`,
  );
});

test("renderSite cross-chapter wikilinks from a nested page use depth-aware prefixes", () => {
  const dir = scratch();
  writeFileSync(
    join(dir, "a.noma"),
    `# Nested {id="part/intro"}\n\nSee [[target-claim]] and [[deep-claim]].\n`,
  );
  writeFileSync(
    join(dir, "b.noma"),
    `# Flat\n\n::claim{id="target-claim"}\nThis is flat.\n::\n`,
  );
  writeFileSync(
    join(dir, "c.noma"),
    `# OtherNested {id="other/page"}\n\n::claim{id="deep-claim"}\nThis is nested.\n::\n`,
  );
  writeFileSync(
    join(dir, "book.yml"),
    "title: T\nchapters:\n  - a.noma\n  - b.noma\n  - c.noma\n",
  );
  const out = join(dir, "site");
  const { manifest, chapters } = loadBookChapters(join(dir, "book.yml"));
  renderSite(manifest, chapters, out, { themeCss: "x" });

  const nestedHtml = readFileSync(join(out, "part", "intro.html"), "utf8");
  assert.ok(
    nestedHtml.includes(`href="../flat.html#target-claim"`),
    `nested → flat wikilink must climb up; got: ${nestedHtml.slice(0, 1200)}`,
  );
  assert.ok(
    nestedHtml.includes(`href="../other/page.html#deep-claim"`),
    `nested → nested wikilink must climb up; got: ${nestedHtml.slice(0, 1200)}`,
  );
});

test("renderSite emits a searchable space index and page context chrome", () => {
  const dir = scratch();
  writeFileSync(
    join(dir, "intro.noma"),
    `---
tags: [guide, agent]
status: draft
owner: Docs
updated: 2026-06-05
---
# Intro

This space explains how agents keep documentation current. See [[target]].
`,
  );
  writeFileSync(
    join(dir, "target.noma"),
    `---
tags: [guide, reference]
status: stable
owner: Maintainers
updated: 2026-06-04
---
# Target

The target page is written for searchable space rendering.
`,
  );
  writeFileSync(
    join(dir, "book.yml"),
    "title: Team Space\ndescription: Agent-ready documentation.\nauthor: Noma\nchapters:\n  - intro.noma\n  - target.noma\n",
  );
  const out = join(dir, "site");
  const { manifest, chapters } = loadBookChapters(join(dir, "book.yml"));
  renderSite(manifest, chapters, out, { themeCss: "x" });

  const indexPath = join(out, "_assets", "search-index.json");
  assert.ok(existsSync(indexPath), "_assets/search-index.json must exist");
  const searchIndex = readFileSync(indexPath, "utf8");
  assert.match(searchIndex, /"title": "Intro"/);
  assert.match(searchIndex, /"tags": \[\s+"guide",\s+"agent"\s+\]/);
  assert.match(searchIndex, /"status": "draft"/);

  const introHtml = readFileSync(join(out, "intro.html"), "utf8");
  assert.match(introHtml, /class="noma-space-sidebar"/);
  assert.match(introHtml, /data-noma-space-search/);
  assert.match(introHtml, /<span>Status<\/span><strong>draft<\/strong>/);
  assert.match(introHtml, /<span>Owner<\/span><strong>Docs<\/strong>/);
  assert.match(introHtml, /<span>Updated<\/span><strong>2026-06-05<\/strong>/);
  assert.match(introHtml, /<span>guide<\/span>/);

  const targetHtml = readFileSync(join(out, "target.html"), "utf8");
  assert.match(targetHtml, /<h2>Backlinks<\/h2>/);
  assert.match(targetHtml, /href="intro.html">Intro<\/a>/);
  assert.match(targetHtml, /<h2>Related<\/h2>/);
  assert.match(targetHtml, /href="intro.html">Intro<\/a>/);

  const indexHtml = readFileSync(join(out, "index.html"), "utf8");
  assert.match(indexHtml, /Agent-ready documentation/);
  assert.match(indexHtml, /2 pages/);
  assert.match(indexHtml, /3 tags/);
});

test("renderSite embedded search data uses depth-aware hrefs on nested pages", () => {
  const dir = scratch();
  writeFileSync(join(dir, "a.noma"), `# Nested {id="part/intro"}\n\nSearch here.\n`);
  writeFileSync(join(dir, "b.noma"), `# Flat\n\nFlat page.\n`);
  writeFileSync(
    join(dir, "book.yml"),
    "title: T\nchapters:\n  - a.noma\n  - b.noma\n",
  );
  const out = join(dir, "site");
  const { manifest, chapters } = loadBookChapters(join(dir, "book.yml"));
  renderSite(manifest, chapters, out, { themeCss: "x" });

  const nestedHtml = readFileSync(join(out, "part", "intro.html"), "utf8");
  assert.ok(
    nestedHtml.includes(`"href":"../flat.html"`),
    `nested embedded search data must climb up for flat pages; got: ${nestedHtml.slice(-1600)}`,
  );
  assert.ok(
    nestedHtml.includes(`"href":"../part/intro.html"`),
    `nested embedded search data must prefix the current nested page; got: ${nestedHtml.slice(-1600)}`,
  );
});

test("renderSite links the search index depth-aware when interactive chrome is disabled", () => {
  const dir = scratch();
  writeFileSync(join(dir, "ch.noma"), "# Only {id=\"docs/only\"}\n\nStatic page.\n");
  writeFileSync(join(dir, "book.yml"), "title: T\nchapters:\n  - ch.noma\n");
  const out = join(dir, "site");
  const { manifest, chapters } = loadBookChapters(join(dir, "book.yml"));
  renderSite(manifest, chapters, out, { themeCss: "", interactive: false });

  assert.ok(existsSync(join(out, "_assets", "search-index.json")));
  const html = readFileSync(join(out, "docs", "only.html"), "utf8");
  assert.ok(!html.includes("data-noma-space-search"));
  assert.ok(html.includes(`href="../_assets/search-index.json"`));
  assert.ok(!html.includes("<script"));
  assert.ok(!html.includes("onclick="));
});
