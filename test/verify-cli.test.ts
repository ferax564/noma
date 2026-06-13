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

test("verifyFixtureDir throws ENOENT when fixture dir does not exist", () => {
  const ghost = "/tmp/noma-verify-nonexistent-" + Math.random().toString(36).slice(2);
  assert.throws(() => verifyFixtureDir(ghost), /ENOENT|no such file/);
});

test("verifyFixtureDir checks expected.spans.json when present", () => {
  const dir = mkdtempSync(join(tmpdir(), "noma-verify-"));
  try {
    const fixDir = join(dir, "valid/spans");
    mkdirSync(fixDir, { recursive: true });
    writeFileSync(join(fixDir, "input.noma"), `# Heading\n\nparagraph.\n`);
    writeFileSync(join(fixDir, "expected.spans.json"), JSON.stringify({
      "heading": { startLine: 1, endLine: 3 },
    }));
    const report = verifyFixtureDir(dir);
    assert.equal(report.ok, true);
    assert.equal(report.fixtures[0]?.status, "pass");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("verifyFixtureDir fails when expected.spans.json mismatches", () => {
  const dir = mkdtempSync(join(tmpdir(), "noma-verify-"));
  try {
    const fixDir = join(dir, "valid/spans");
    mkdirSync(fixDir, { recursive: true });
    writeFileSync(join(fixDir, "input.noma"), `# Heading\n\nparagraph.\n`);
    writeFileSync(join(fixDir, "expected.spans.json"), JSON.stringify({
      "heading": { startLine: 1, endLine: 999 },
    }));
    const report = verifyFixtureDir(dir);
    assert.equal(report.ok, false);
    assert.equal(report.fixtures[0]?.status, "fail");
    assert.match(report.fixtures[0]?.error ?? "", /span/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("verifyFixtureDir applies patch.json and checks expected.post.noma", () => {
  const dir = mkdtempSync(join(tmpdir(), "noma-verify-"));
  try {
    const fixDir = join(dir, "patch/replace");
    mkdirSync(fixDir, { recursive: true });
    writeFileSync(join(fixDir, "input.noma"), `::claim{id="x" confidence=0.5}\nhello\n::\n`);
    writeFileSync(join(fixDir, "patch.json"), JSON.stringify([
      { op: "update_attribute", id: "x", key: "confidence", value: 0.9 }
    ]));
    writeFileSync(join(fixDir, "expected.post.noma"), `::claim{id="x" confidence=0.9}\nhello\n::\n`);
    const report = verifyFixtureDir(dir);
    assert.equal(report.ok, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("verifyFixtureDir passes when patch throws the expected error code", () => {
  const dir = mkdtempSync(join(tmpdir(), "noma-verify-"));
  try {
    const fixDir = join(dir, "patch-error/missing");
    mkdirSync(fixDir, { recursive: true });
    writeFileSync(join(fixDir, "input.noma"), `::claim{id="x"}\nhello\n::\n`);
    writeFileSync(join(fixDir, "patch.json"), JSON.stringify({ op: "replace_body", id: "nope", content: "y" }));
    writeFileSync(join(fixDir, "expected.error.json"), JSON.stringify({ code: "target_missing" }));
    const report = verifyFixtureDir(dir);
    assert.equal(report.ok, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("verifyFixtureDir fails when the patch error code differs from expected", () => {
  const dir = mkdtempSync(join(tmpdir(), "noma-verify-"));
  try {
    const fixDir = join(dir, "patch-error/wrong-code");
    mkdirSync(fixDir, { recursive: true });
    writeFileSync(join(fixDir, "input.noma"), `::claim{id="x"}\nhello\n::\n`);
    writeFileSync(join(fixDir, "patch.json"), JSON.stringify({ op: "replace_body", id: "nope", content: "y" }));
    writeFileSync(join(fixDir, "expected.error.json"), JSON.stringify({ code: "id_conflict" }));
    const report = verifyFixtureDir(dir);
    assert.equal(report.ok, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("verifyFixtureDir fails when an expected-error patch unexpectedly succeeds", () => {
  const dir = mkdtempSync(join(tmpdir(), "noma-verify-"));
  try {
    const fixDir = join(dir, "patch-error/no-throw");
    mkdirSync(fixDir, { recursive: true });
    writeFileSync(join(fixDir, "input.noma"), `::claim{id="x" confidence=0.5}\nhello\n::\n`);
    writeFileSync(join(fixDir, "patch.json"), JSON.stringify({ op: "update_attribute", id: "x", key: "confidence", value: 0.9 }));
    writeFileSync(join(fixDir, "expected.error.json"), JSON.stringify({ code: "target_missing" }));
    const report = verifyFixtureDir(dir);
    assert.equal(report.ok, false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
