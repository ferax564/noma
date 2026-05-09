import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { parse } from "../src/parser.js";
import { renderNoma } from "../src/renderer-noma.js";
import type { DocumentNode, Node } from "../src/ast.js";

function stripPositions(node: Node): Node {
  const clone: Record<string, unknown> = { ...node };
  delete clone.pos;
  if ("children" in clone && Array.isArray(clone.children)) {
    clone.children = (clone.children as Node[]).map(stripPositions);
  }
  if ("items" in clone && Array.isArray(clone.items)) {
    clone.items = (clone.items as Node[]).map(stripPositions);
  }
  return clone as unknown as Node;
}

function normalize(doc: DocumentNode): unknown {
  const meta = { ...doc.meta };
  delete meta.filename;
  return {
    type: "document",
    meta,
    children: doc.children.map(stripPositions),
  };
}

function roundtripEquals(source: string): void {
  const original = parse(source);
  const printed = renderNoma(original);
  const reparsed = parse(printed);
  assert.deepEqual(normalize(reparsed), normalize(original));
}

test("roundtrip: frontmatter + headings + paragraph", () => {
  roundtripEquals(`---\ntitle: Hi\nauthor: ferax564\n---\n\n# A\n\nbody **bold**.\n\n## B\n\nmore.\n`);
});

test("roundtrip: directive with attrs and body", () => {
  roundtripEquals(`::claim{id="c1" confidence=0.82}\nClaim body.\n::\n`);
});

test("roundtrip: nested directives via deeper colons", () => {
  roundtripEquals(
    `::grid{columns=2}\n:::card{title="A"}\nleft\n:::\n\n:::card{title="B"}\nright\n:::\n::\n`,
  );
});

test("roundtrip: code, list, quote, hr, table", () => {
  const src = [
    "# T",
    "",
    "```ts",
    "const x = 1;",
    "```",
    "",
    "- one",
    "- two",
    "",
    "> quoted",
    "> line two",
    "",
    "---",
    "",
    "| A | B |",
    "| :--- | ---: |",
    "| 1 | 2 |",
    "",
  ].join("\n");
  roundtripEquals(src);
});

test("roundtrip: every file in examples/ and docs/", () => {
  const roots = ["examples", "docs"];
  for (const root of roots) {
    for (const f of readdirSync(root).filter((n) => n.endsWith(".noma"))) {
      const path = join(root, f);
      const src = readFileSync(path, "utf8");
      try {
        roundtripEquals(src);
      } catch (err) {
        throw new Error(`roundtrip failed for ${path}: ${(err as Error).message}`);
      }
    }
  }
});

test("printer escapes attr values containing quotes", () => {
  const doc = parse(`::callout{tone="info"}\nhi\n::\n`);
  const out = renderNoma(doc);
  assert.match(out, /::callout\{tone="info"\}/);
});

test("printer omits filename meta", () => {
  const doc = parse(`# A\n`, { filename: "/tmp/x.noma" });
  const out = renderNoma(doc);
  assert.doesNotMatch(out, /filename/);
});
