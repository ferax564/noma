import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawnSync } from "node:child_process";

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "noma-cli-"));
}

test("noma --version prints package version", () => {
  const pkg = JSON.parse(readFileSync("package.json", "utf8")) as { version: string };
  const res = spawnSync("npx", ["tsx", "src/cli.ts", "--version"], { encoding: "utf8" });
  assert.equal(res.status, 0, res.stderr);
  assert.equal(res.stdout.trim(), pkg.version);
});

test("noma init creates a renderable starter document", () => {
  const dir = join(scratch(), "starter");
  const res = spawnSync("npx", ["tsx", "src/cli.ts", "init", dir], { encoding: "utf8" });
  assert.equal(res.status, 0, res.stderr);
  const starter = join(dir, "demo.noma");
  assert.match(readFileSync(starter, "utf8"), /::claim\{id="core-claim"/);

  const render = spawnSync(
    "npx",
    ["tsx", "src/cli.ts", "render", starter, "--to", "html"],
    { encoding: "utf8" },
  );
  assert.equal(render.status, 0, render.stderr);
  assert.match(render.stdout, /Agent-Safe Spec/);
});

test("noma render --strict blocks escape hatches and external assets", () => {
  const dir = scratch();
  const input = join(dir, "strict.noma");
  writeFileSync(
    input,
    `# Strict\n\n::html\n<b>raw</b>\n::\n\n::math\nx^2\n::\n\n::diagram{kind="mermaid"}\ngraph TD; A-->B\n::\n`,
  );
  const res = spawnSync(
    "npx",
    ["tsx", "src/cli.ts", "render", input, "--strict"],
    { encoding: "utf8" },
  );
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /noma-blocked-escape/);
  assert.ok(!res.stdout.includes("<b>raw</b>"));
  assert.ok(!/cdn\.jsdelivr\.net/.test(res.stdout));
});

test("noma render --to llm supports select, exclude, and budget", () => {
  const dir = scratch();
  const input = join(dir, "ctx.noma");
  writeFileSync(
    input,
    `# Spec\n\n::claim{id="c1"}\nClaim.\n::\n\n::dataset{id="ds1"}\nrows: []\n::\n\n::risk{id="r1" owner="me"}\nRisk.\n::\n`,
  );
  const res = spawnSync(
    "npx",
    ["tsx", "src/cli.ts", "render", input, "--to", "llm", "--select", "claim,risk", "--exclude", "risk", "--budget", "120"],
    { encoding: "utf8" },
  );
  assert.equal(res.status, 0, res.stderr);
  assert.match(res.stdout, /\[CLAIM/);
  assert.doesNotMatch(res.stdout, /\[RISK/);
  assert.doesNotMatch(res.stdout, /\[DATASET/);
  assert.ok(res.stdout.length <= 120);
});

test("noma ids prints canonical IDs, aliases, and records", () => {
  const dir = scratch();
  const input = join(dir, "ids.noma");
  writeFileSync(input, `# Spec {id="spec" aliases="intro"}\n\n::claim{id="c1"}\nClaim.\n::\n`);
  const res = spawnSync("npx", ["tsx", "src/cli.ts", "ids", input], { encoding: "utf8" });
  assert.equal(res.status, 0, res.stderr);
  const body = JSON.parse(res.stdout) as {
    ids: string[];
    aliases: Record<string, string>;
    records: Array<{ id: string; type: string; title?: string; name?: string }>;
  };
  assert.deepEqual(body.ids, ["spec", "c1"]);
  assert.equal(body.aliases.intro, "spec");
  assert.ok(body.records.some((r) => r.id === "spec" && r.type === "section" && r.title === "Spec"));
  assert.ok(body.records.some((r) => r.id === "c1" && r.type === "directive" && r.name === "claim"));
});

test("noma patch transaction postvalidate rejects invalid post-state without writing", () => {
  const dir = scratch();
  const input = join(dir, "tx.noma");
  const tx = join(dir, "tx.json");
  const original = `::claim{id="c1"}\nClaim.\n::\n\n::evidence{id="e1" for="c1"}\nEvidence.\n::\n`;
  writeFileSync(input, original);
  writeFileSync(
    tx,
    JSON.stringify({
      ops: [{ op: "delete_block", id: "c1" }],
      postvalidate: true,
    }),
  );
  const res = spawnSync(
    "npx",
    ["tsx", "src/cli.ts", "patch", input, "--ops", tx, "--inplace"],
    { encoding: "utf8" },
  );
  assert.equal(res.status, 1);
  assert.match(res.stderr, /post-validation failed/);
  assert.equal(readFileSync(input, "utf8"), original);
});

test("noma patch transaction applies when validations pass", () => {
  const dir = scratch();
  const input = join(dir, "tx-ok.noma");
  const tx = join(dir, "tx-ok.json");
  writeFileSync(input, `::claim{id="c1" confidence=0.5 noverify}\nClaim.\n::\n`);
  writeFileSync(
    tx,
    JSON.stringify({
      ops: [{ op: "update_attribute", id: "c1", key: "confidence", value: 0.9 }],
      prevalidate: true,
      postvalidate: true,
    }),
  );
  const res = spawnSync(
    "npx",
    ["tsx", "src/cli.ts", "patch", input, "--ops", tx, "--inplace"],
    { encoding: "utf8" },
  );
  assert.equal(res.status, 0, res.stderr);
  assert.match(readFileSync(input, "utf8"), /confidence=0\.9/);
});
