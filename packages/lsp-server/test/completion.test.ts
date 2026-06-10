import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { computeCompletions } from "../src/lib.js";

const source = [
  '# Alpha {id="alpha" aliases="a1"}',
  "",
  "See [[",
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

describe("computeCompletions", () => {
  it("offers all canonical IDs inside an open wikilink", () => {
    const items = computeCompletions(source, { line: 2, character: 6 });
    const labels = items.map(i => i.label);
    assert.ok(labels.includes("alpha"));
    assert.ok(labels.includes("beta"));
    assert.ok(labels.includes("ev"));
  });

  it("offers aliases with the canonical id as detail", () => {
    const items = computeCompletions(source, { line: 2, character: 6 });
    const alias = items.find(i => i.label === "a1");
    assert.ok(alias);
    assert.equal(alias.detail, "alias of alpha");
  });

  it("completes after a partial target prefix", () => {
    const typed = source.replace("See [[", "See [[be");
    const items = computeCompletions(typed, { line: 2, character: 8 });
    assert.ok(items.some(i => i.label === "beta"));
  });

  it("offers nothing outside a wikilink", () => {
    assert.deepEqual(computeCompletions(source, { line: 5, character: 4 }), []);
    assert.deepEqual(computeCompletions(source, { line: 2, character: 3 }), []);
  });

  it("offers nothing once the wikilink is closed", () => {
    const closed = source.replace("See [[", "See [[beta]] tail");
    assert.deepEqual(computeCompletions(closed, { line: 2, character: 17 }), []);
  });
});
