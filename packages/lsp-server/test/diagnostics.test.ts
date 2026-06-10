import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { computeDiagnostics } from "../src/lib.js";

const source = [
  '# Alpha {id="alpha"}',
  "",
  "Intro text.",
  "",
  '::claim{id="beta"}',
  "Beta claim spanning",
  "two lines.",
  "::",
  "",
  '::evidence{id="ev" for="missing"}',
  "Proof.",
  "::",
  "",
].join("\n");

describe("computeDiagnostics", () => {
  it("returns no diagnostics for a clean document", () => {
    const clean = [
      "# Clean",
      "",
      '::claim{id="c1" confidence=0.9}',
      "A claim.",
      "::",
      "",
      '::evidence{id="e1" for="c1"}',
      "Backing.",
      "::",
      "",
    ].join("\n");
    assert.deepEqual(computeDiagnostics(clean), []);
  });

  it("maps 1-based validator positions to 0-based LSP ranges", () => {
    const diagnostics = computeDiagnostics(source);
    const broken = diagnostics.find(d => d.code === "broken-reference");
    assert.ok(broken);
    assert.equal(broken.range.start.line, 9);
    assert.equal(broken.range.start.character, 0);
  });

  it("extends the range to endLine when the validator provides one", () => {
    const diagnostics = computeDiagnostics(source);
    const broken = diagnostics.find(d => d.code === "broken-reference");
    assert.ok(broken);
    assert.equal(broken.range.end.line, 11);
    assert.equal(broken.range.end.character, "::".length);

    const noEvidence = diagnostics.find(d => d.code === "claim-without-evidence");
    assert.ok(noEvidence);
    assert.deepEqual(noEvidence.range, {
      start: { line: 4, character: 0 },
      end: { line: 7, character: "::".length },
    });
  });

  it("maps severities to LSP numeric levels", () => {
    const diagnostics = computeDiagnostics(source);
    const broken = diagnostics.find(d => d.code === "broken-reference");
    const noEvidence = diagnostics.find(d => d.code === "claim-without-evidence");
    assert.equal(broken?.severity, 1);
    assert.equal(noEvidence?.severity, 2);
    assert.ok(diagnostics.every(d => d.source === "noma"));
  });

  it("anchors diagnostics without a position at the document start", () => {
    const headless = 'Orphan [[nowhere]] reference.\n';
    const diagnostics = computeDiagnostics(headless);
    const broken = diagnostics.find(d => d.code === "broken-reference");
    assert.ok(broken);
    assert.equal(broken.range.start.line >= 0, true);
    assert.equal(broken.range.start.character >= 0, true);
  });
});
