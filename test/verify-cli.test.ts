import { test } from "node:test";
import assert from "node:assert/strict";
import { verifyFixtureDir } from "../src/verify.js";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("verifyFixtureDir returns success for a trivial valid fixture", () => {
  const dir = mkdtempSync(join(tmpdir(), "noma-verify-"));
  try {
    const fixDir = join(dir, "valid/basic");
    mkdirSync(fixDir, { recursive: true });
    writeFileSync(join(fixDir, "input.noma"), `# Hello\n\nparagraph.\n`);
    writeFileSync(join(fixDir, "expected.ids.json"), JSON.stringify({
      canonical: ["hello"],
      aliases: {},
    }));
    writeFileSync(join(fixDir, "expected.diagnostics.json"), JSON.stringify([]));
    writeFileSync(join(fixDir, "expected.roundtrip.noma"), `# Hello\n\nparagraph.\n`);
    const report = verifyFixtureDir(dir);
    assert.equal(report.ok, true);
    assert.equal(report.fixtures.length, 1);
    assert.equal(report.fixtures[0]?.status, "pass");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("verifyFixtureDir fails when expected.ids.json mismatches", () => {
  const dir = mkdtempSync(join(tmpdir(), "noma-verify-"));
  try {
    const fixDir = join(dir, "valid/basic");
    mkdirSync(fixDir, { recursive: true });
    writeFileSync(join(fixDir, "input.noma"), `# Hello\n\nparagraph.\n`);
    writeFileSync(join(fixDir, "expected.ids.json"), JSON.stringify({
      canonical: ["wrong-id"],
      aliases: {},
    }));
    writeFileSync(join(fixDir, "expected.diagnostics.json"), JSON.stringify([]));
    writeFileSync(join(fixDir, "expected.roundtrip.noma"), `# Hello\n\nparagraph.\n`);
    const report = verifyFixtureDir(dir);
    assert.equal(report.ok, false);
    assert.equal(report.fixtures[0]?.status, "fail");
    assert.match(report.fixtures[0]?.error ?? "", /ids/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
