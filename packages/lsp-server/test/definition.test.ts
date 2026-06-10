import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { computeDefinition, referenceTargetAt } from "../src/lib.js";

const source = [
  '# Alpha {id="alpha" aliases="a1"}',
  "",
  "Intro [[beta]] and [[a1|the alias]].",
  "",
  '::claim{id="beta" confidence=0.9}',
  "Beta claim.",
  "::",
  "",
  '::evidence{id="ev" for="beta"}',
  "Proof.",
  "::",
  "",
].join("\n");

describe("referenceTargetAt", () => {
  it("extracts the wikilink target under the cursor", () => {
    assert.equal(referenceTargetAt("Intro [[beta]] here.", 9), "beta");
  });

  it("strips the label from piped wikilinks", () => {
    assert.equal(referenceTargetAt("See [[a1|the alias]].", 7), "a1");
  });

  it("extracts for= and target= attribute values", () => {
    assert.equal(referenceTargetAt('::evidence{id="ev" for="beta"}', 25), "beta");
    assert.equal(referenceTargetAt('::comment{target="beta"}', 19), "beta");
  });

  it("returns undefined outside any reference", () => {
    assert.equal(referenceTargetAt("Intro [[beta]] here.", 2), undefined);
    assert.equal(referenceTargetAt('::evidence{id="ev" for="beta"}', 16), undefined);
  });
});

describe("computeDefinition", () => {
  it("resolves a wikilink to the defining block", () => {
    const result = computeDefinition(source, { line: 2, character: 9 });
    assert.ok(result);
    assert.equal(result.id, "beta");
    assert.equal(result.range.start.line, 4);
    assert.equal(result.range.end.line, 6);
  });

  it("resolves aliases to the canonical block", () => {
    const result = computeDefinition(source, { line: 2, character: 22 });
    assert.ok(result);
    assert.equal(result.id, "alpha");
    assert.equal(result.range.start.line, 0);
  });

  it("resolves for= attribute references", () => {
    const result = computeDefinition(source, { line: 8, character: 25 });
    assert.ok(result);
    assert.equal(result.id, "beta");
    assert.equal(result.range.start.line, 4);
  });

  it("returns undefined for unknown targets and plain text", () => {
    const broken = source.replace("[[beta]]", "[[ghost]]");
    assert.equal(computeDefinition(broken, { line: 2, character: 9 }), undefined);
    assert.equal(computeDefinition(source, { line: 5, character: 3 }), undefined);
  });
});
