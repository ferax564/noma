import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { loadBookChapters } from "../src/book.js";

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "noma-trust-"));
}

test("manifest trusted_publishing: true surfaces via loadBookChapters", () => {
  const dir = scratch();
  writeFileSync(join(dir, "ch.noma"), "# Hello\n\n::html\n<b>raw</b>\n::\n");
  writeFileSync(
    join(dir, "book.yml"),
    "title: Test\ntrusted_publishing: true\nchapters:\n  - ch.noma\n",
  );
  const { manifest } = loadBookChapters(join(dir, "book.yml"));
  assert.equal(manifest.trusted_publishing, true);
});

test("manifest without trusted_publishing leaves flag undefined", () => {
  const dir = scratch();
  writeFileSync(join(dir, "ch.noma"), "# Hello\n");
  writeFileSync(
    join(dir, "book.yml"),
    "title: Test\nchapters:\n  - ch.noma\n",
  );
  const { manifest } = loadBookChapters(join(dir, "book.yml"));
  assert.equal(manifest.trusted_publishing, undefined);
});

test("noma render --to site honors manifest trusted_publishing", () => {
  const dir = scratch();
  writeFileSync(
    join(dir, "ch.noma"),
    "# Hello\n\n::html\n<b>raw</b>\n::\n",
  );
  writeFileSync(
    join(dir, "book.yml"),
    "title: Test\ntrusted_publishing: true\nchapters:\n  - ch.noma\n",
  );
  const out = join(dir, "site");
  const res = spawnSync(
    "npx",
    ["tsx", "src/cli.ts", "render", join(dir, "book.yml"), "--to", "site", "--out", out],
    { encoding: "utf8" },
  );
  assert.equal(res.status, 0, res.stderr);
  const html = readFileSync(join(out, "hello.html"), "utf8");
  assert.ok(!html.includes("<b>raw</b>"), "raw HTML must be filtered under trusted publishing");
});

test("noma render --to html on a manifest honors trusted_publishing", () => {
  const dir = scratch();
  writeFileSync(
    join(dir, "ch.noma"),
    "# Hello\n\n::html\n<b>raw</b>\n::\n",
  );
  writeFileSync(
    join(dir, "book.yml"),
    "title: Test\ntrusted_publishing: true\nchapters:\n  - ch.noma\n",
  );
  const outPath = join(dir, "single.html");
  const res = spawnSync(
    "npx",
    ["tsx", "src/cli.ts", "render", join(dir, "book.yml"), "--to", "html", "--out", outPath],
    { encoding: "utf8" },
  );
  assert.equal(res.status, 0, res.stderr);
  const html = readFileSync(outPath, "utf8");
  assert.ok(!html.includes("<b>raw</b>"), "raw HTML must be filtered under trusted publishing");
});

test("noma render without manifest trusted_publishing leaves escape hatches alone", () => {
  const dir = scratch();
  writeFileSync(
    join(dir, "ch.noma"),
    "# Hello\n\n::html\n<b>raw</b>\n::\n",
  );
  writeFileSync(
    join(dir, "book.yml"),
    "title: Test\nchapters:\n  - ch.noma\n",
  );
  const outPath = join(dir, "single.html");
  const res = spawnSync(
    "npx",
    ["tsx", "src/cli.ts", "render", join(dir, "book.yml"), "--to", "html", "--out", outPath],
    { encoding: "utf8" },
  );
  assert.equal(res.status, 0, res.stderr);
  const html = readFileSync(outPath, "utf8");
  assert.ok(html.includes("<b>raw</b>"), "default render preserves escape hatches");
});
