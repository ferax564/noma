import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { splitPipeRow, escapePipeTableCell } from "../src/inline.js";
import { parse } from "../src/parser.js";
import { renderHtml } from "../src/renderer-html.js";
import { renderNoma } from "../src/renderer-noma.js";
import { validate } from "../src/validator.js";
import { validateSpace } from "../src/space-check.js";

test("a labelled wikilink's pipe does not split a table cell", () => {
  assert.deepEqual(splitPipeRow("| [[ops|Operations]] | `a|b` | x \\| y |"), ["[[ops|Operations]]", "`a|b`", "x \\| y"]);
  assert.equal(escapePipeTableCell("see [[ops|Operations]] or a|b"), "see [[ops|Operations]] or a\\|b");
  const source = "| Page | What |\n|---|---|\n| [[ops|Operations]] | deploy |\n\n## Operations {id=\"ops\"}\n\nText.\n";
  const doc = parse(source);
  assert.match(renderHtml(doc), /<td><a class="noma-ref" href="#ops">Operations<\/a><\/td><td>deploy<\/td>/);
  assert.equal(renderNoma(parse(renderNoma(doc))), renderNoma(doc), "tables with labelled wikilinks round-trip");
  assert.deepEqual(validate(doc).filter((d) => d.severity === "error"), []);
});

test("spaceIds lets a wikilink resolve to another page, but not an attribute reference", () => {
  const doc = parse('# Home\n\nSee [[ops-page|Operations]].\n\n::evidence{for="ops-claim"}\nx\n::\n');
  const alone = validate(doc).filter((d) => d.code === "broken-reference").map((d) => d.message);
  assert.equal(alone.length, 2);
  const inSpace = validate(doc, { spaceIds: new Set(["ops-page", "ops-claim"]) }).filter((d) => d.code === "broken-reference");
  assert.deepEqual(inSpace.map((d) => d.message), ['Reference to unknown block ID "ops-claim".'], "evidence for= must stay inside the page");
});

test("validateSpace resolves links across pages and flags ambiguous IDs", () => {
  const pages = [
    { path: "home.noma", doc: parse('# Home {id="home"}\n\nGo to [[ops|Operations]] or [[missing-page]].\n\n## Shared {id="shared"}\n') },
    { path: "home/ops.noma", doc: parse('# Operations {id="ops"}\n\nBack to [[home]].\n\n## Shared {id="shared"}\n') },
  ];
  const [home, ops] = validateSpace(pages);
  assert.deepEqual(home!.diagnostics.filter((d) => d.code === "broken-reference").map((d) => d.message), ['Reference to unknown block ID "missing-page".']);
  assert.deepEqual(ops!.diagnostics.filter((d) => d.severity === "error"), []);
  const dup = home!.diagnostics.find((d) => d.code === "duplicate-space-id");
  assert.match(dup?.message ?? "", /"shared" is also defined in home\/ops\.noma/);
  assert.equal(validateSpace(pages, { ignoreRules: ["duplicate-space-id"] })[0]!.diagnostics.some((d) => d.code === "duplicate-space-id"), false);
});

test("noma check <dir> validates a wiki directory as one space", () => {
  const dir = mkdtempSync(join(tmpdir(), "noma-space-"));
  mkdirSync(join(dir, "proj"));
  writeFileSync(join(dir, "proj.noma"), '# Proj {id="proj-home"}\n\n| Page | |\n|---|---|\n| [[proj-arch|Architecture]] | how |\n');
  writeFileSync(join(dir, "proj", "architecture.noma"), '# Architecture {id="proj-arch"}\n\nUp: [[proj-home]].\n');
  writeFileSync(join(dir, ".hidden.noma"), "[[nowhere]]\n");
  const single = spawnSync("npx", ["tsx", "src/cli.ts", "check", join(dir, "proj.noma")], { encoding: "utf8" });
  assert.equal(single.status, 1, "a single file cannot see its siblings");
  const ok = spawnSync("npx", ["tsx", "src/cli.ts", "check", dir], { encoding: "utf8" });
  assert.equal(ok.status, 0, ok.stdout + ok.stderr);
  assert.match(ok.stdout, /2 page\(s\) checked as one space: 0 error\(s\), 0 warning\(s\)/);
  writeFileSync(join(dir, "proj", "roadmap.noma"), "# Roadmap\n\nSee [[proj-nope]].\n");
  const bad = spawnSync("npx", ["tsx", "src/cli.ts", "check", dir], { encoding: "utf8" });
  assert.equal(bad.status, 1);
  assert.match(bad.stdout, /proj\/roadmap\.noma:3:\d+.*proj-nope/);
});
