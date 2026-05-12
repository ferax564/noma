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
