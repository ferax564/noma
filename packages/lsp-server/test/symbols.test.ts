import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { computeDocumentSymbols } from "../src/lib.js";

const source = [
  '# Alpha {id="alpha" aliases="a1"}',
  "",
  "Intro [[beta]].",
  "",
  '::claim{id="beta" confidence=0.9}',
  "Beta claim.",
  "::",
  "",
  '::evidence{id="ev" for="beta"}',
  "Proof line one.",
  "Proof line two.",
  "::",
  "",
  '## Child Section {id="kid"}',
  "",
  "Text.",
  "",
].join("\n");

describe("computeDocumentSymbols", () => {
  it("builds a section tree with ID-bearing directives as children", () => {
    const symbols = computeDocumentSymbols(source);
    assert.equal(symbols.length, 1);
    const alpha = symbols[0];
    assert.ok(alpha);
    assert.equal(alpha.name, "Alpha");
    assert.equal(alpha.detail, "#alpha");
    assert.deepEqual(alpha.children?.map(c => c.name), ["::claim", "::evidence", "Child Section"]);
    assert.deepEqual(alpha.children?.map(c => c.detail), ["#beta", "#ev", "#kid"]);
  });

  it("spans each symbol range from pos to endLine", () => {
    const symbols = computeDocumentSymbols(source);
    const alpha = symbols[0];
    assert.ok(alpha);
    assert.equal(alpha.range.start.line, 0);
    assert.equal(alpha.range.end.line >= 15, true);

    const evidence = alpha.children?.find(c => c.detail === "#ev");
    assert.ok(evidence);
    assert.deepEqual(evidence.range, {
      start: { line: 8, character: 0 },
      end: { line: 11, character: "::".length },
    });
    assert.deepEqual(evidence.selectionRange, {
      start: { line: 8, character: 0 },
      end: { line: 8, character: '::evidence{id="ev" for="beta"}'.length },
    });
  });

  it("omits directives without an id but keeps their ID-bearing descendants", () => {
    const nested = [
      "# Top",
      "",
      "::grid",
      ':::card{id="inner"}',
      "Card body.",
      ":::",
      "::",
      "",
    ].join("\n");
    const symbols = computeDocumentSymbols(nested);
    const top = symbols[0];
    assert.ok(top);
    assert.deepEqual(top.children?.map(c => [c.name, c.detail]), [["::card", "#inner"]]);
  });
});
