import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";
import { parse } from "../src/parser.js";

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "noma-diff-"));
}

test("noma diff a.noma b.noma --at <date> prints state_change blocks", () => {
  const dir = scratch();
  writeFileSync(join(dir, "a.noma"), `::claim{id="c1" confidence=0.6}\nx\n::\n`);
  writeFileSync(join(dir, "b.noma"), `::claim{id="c1" confidence=0.9}\nx\n::\n`);
  const res = spawnSync(
    "npx",
    ["tsx", "src/cli.ts", "diff", join(dir, "a.noma"), join(dir, "b.noma"), "--at", "2026-05-12"],
    { encoding: "utf8" },
  );
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /::state_change\{/);
  assert.match(res.stdout, /block="c1"/);
  assert.match(res.stdout, /attribute="confidence"/);
  assert.match(res.stdout, /from=0\.6/);
  assert.match(res.stdout, /to=0\.9/);
  assert.match(res.stdout, /at="2026-05-12"/);
  // Round-trip: the CLI output must parse cleanly back into Noma.
  const reparsed = parse(res.stdout);
  assert.ok(reparsed.children.length >= 1);
});

test("noma diff without --at exits 2", () => {
  const dir = scratch();
  writeFileSync(join(dir, "a.noma"), `::claim{id="c1" confidence=0.6}\nx\n::\n`);
  writeFileSync(join(dir, "b.noma"), `::claim{id="c1" confidence=0.9}\nx\n::\n`);
  const res = spawnSync(
    "npx",
    ["tsx", "src/cli.ts", "diff", join(dir, "a.noma"), join(dir, "b.noma")],
    { encoding: "utf8" },
  );
  assert.equal(res.status, 2);
  assert.match(res.stderr, /--at/);
});

test("noma diff with no changes prints nothing and exits 0", () => {
  const dir = scratch();
  const src = `::claim{id="c1" confidence=0.5}\nx\n::\n`;
  writeFileSync(join(dir, "a.noma"), src);
  writeFileSync(join(dir, "b.noma"), src);
  const res = spawnSync(
    "npx",
    ["tsx", "src/cli.ts", "diff", join(dir, "a.noma"), join(dir, "b.noma"), "--at", "2026-05-12"],
    { encoding: "utf8" },
  );
  assert.equal(res.status, 0);
  assert.equal(res.stdout.trim(), "");
});

test("noma diff with --reason embeds reason on each delta", () => {
  const dir = scratch();
  writeFileSync(join(dir, "a.noma"), `::risk{id="r1" severity="low" owner="me"}\nx\n::\n`);
  writeFileSync(join(dir, "b.noma"), `::risk{id="r1" severity="high" owner="me"}\nx\n::\n`);
  const res = spawnSync(
    "npx",
    ["tsx", "src/cli.ts", "diff", join(dir, "a.noma"), join(dir, "b.noma"), "--at", "2026-05-12", "--reason", "post-incident"],
    { encoding: "utf8" },
  );
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /reason="post-incident"/);
});
