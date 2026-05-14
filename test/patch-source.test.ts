import { test } from "node:test";
import assert from "node:assert/strict";
import { patchSource } from "../src/patch.js";

const sample = `---
title: Demo
date: 2026-05-09
tags: [a, b]
---

# Heading

Intro paragraph.

::claim{id="c1" confidence=0.5}
old body
::

::evidence{for="c1"}
ev
::

See [[c1]].
`;

test("patchSource: update_attribute preserves frontmatter byte-for-byte", () => {
  const out = patchSource(sample, {
    op: "update_attribute",
    id: "c1",
    key: "confidence",
    value: 0.95,
  });
  assert.match(out, /^---\ntitle: Demo\ndate: 2026-05-09\ntags: \[a, b\]\n---/);
  assert.match(out, /confidence=0\.95/);
  assert.doesNotMatch(out, /confidence=0\.5\b/);
  // Sibling block + body untouched.
  assert.match(out, /old body/);
  assert.match(out, /::evidence\{for="c1"\}/);
});

test("patchSource: update_attribute appends a new attr", () => {
  const out = patchSource(sample, {
    op: "update_attribute",
    id: "c1",
    key: "owner",
    value: "alice",
  });
  assert.match(out, /::claim\{id="c1" confidence=0\.5 owner="alice"\}/);
});

test("patchSource: replace_block keeps surrounding bytes", () => {
  const out = patchSource(sample, {
    op: "replace_block",
    id: "c1",
    content: `::claim{id="c1" confidence=0.99}\nfresh body\n::`,
  });
  assert.match(out, /^---\ntitle: Demo/);
  assert.match(out, /fresh body/);
  assert.doesNotMatch(out, /old body/);
  assert.match(out, /::evidence\{for="c1"\}\nev\n::/);
});

test("patchSource: replace_body rewrites only directive body lines", () => {
  const out = patchSource(sample, {
    op: "replace_body",
    id: "c1",
    content: "fresh body\nsecond line",
  });
  assert.match(out, /::claim\{id="c1" confidence=0\.5\}\nfresh body\nsecond line\n::/);
  assert.match(out, /^---\ntitle: Demo\ndate: 2026-05-09\ntags: \[a, b\]\n---/);
  assert.match(out, /::evidence\{for="c1"\}\nev\n::/);
  assert.doesNotMatch(out, /old body/);
});

test("patchSource: replace_body rejects directives with child blocks", () => {
  const src = `::grid{id="g"}\n:::card{id="a"}\na\n:::\n::\n`;
  assert.throws(
    () => patchSource(src, { op: "replace_body", id: "g", content: "x" }),
    /has child blocks/,
  );
});

test("patchSource: update_heading changes title and pins old slug as explicit id", () => {
  const src = `# Old Title\n\n::claim{id="c"}\na\n::\n`;
  const out = patchSource(src, { op: "update_heading", id: "old-title", title: "New Title" });
  assert.match(out, /^# New Title \{id="old-title"\}/);
  assert.match(out, /::claim\{id="c"\}\na\n::/);
});

test("patchSource: update_heading preserves existing heading aliases", () => {
  const src = `# Old Title {aliases="legacy"}\n\nBody.\n`;
  const out = patchSource(src, { op: "update_heading", id: "old-title", title: "New Title" });
  assert.match(out, /^# New Title \{aliases="legacy" id="old-title"\}/);
});

test("patchSource: delete_block drops the block plus a duplicate blank", () => {
  const out = patchSource(sample, { op: "delete_block", id: "c1" });
  assert.doesNotMatch(out, /old body/);
  assert.match(out, /Intro paragraph/);
  assert.match(out, /::evidence\{for="c1"\}/);
});

test("patchSource: add_block appends to a parent at end", () => {
  const src = `::grid{id="g" columns=2}
:::card{id="a" title="A"}
left
:::
::
`;
  const out = patchSource(src, {
    op: "add_block",
    parent: "g",
    content: `:::card{id="b" title="B"}\nright\n:::\n`,
  });
  assert.match(out, /title="A"[\s\S]*title="B"/);
  // Original card body intact.
  assert.match(out, /:::card\{id="a" title="A"\}\nleft\n:::/);
});

test("patchSource: add_block at position 0 inserts before sibling", () => {
  const src = `::grid{id="g"}
:::card{id="a"}
a
:::
::
`;
  const out = patchSource(src, {
    op: "add_block",
    parent: "g",
    position: 0,
    content: `:::card{id="z"}\nz\n:::\n`,
  });
  assert.match(out, /id="z"[\s\S]*id="a"/);
});

test("patchSource: add_block rejects non-directive fragments before editing source", () => {
  const src = `::grid{id="g"}\n::\n`;
  assert.throws(
    () =>
      patchSource(src, {
        op: "add_block",
        parent: "g",
        content: "just a paragraph\n",
      }),
    /fragment must be a directive block/,
  );
});

test("patchSource: rename_id rewrites id attr, ref attrs, and wikilinks", () => {
  const out = patchSource(sample, { op: "rename_id", from: "c1", to: "claim-renamed" });
  assert.match(out, /::claim\{id="claim-renamed"/);
  assert.match(out, /::evidence\{for="claim-renamed"\}/);
  assert.match(out, /\[\[claim-renamed\]\]/);
  assert.doesNotMatch(out, /"c1"/);
  // Frontmatter byte-identical.
  assert.match(out, /^---\ntitle: Demo\ndate: 2026-05-09\ntags: \[a, b\]\n---/);
});

test("patchSource: heading id roundtrip via rename_id", () => {
  const src = `# Custom Title {id="custom-id"}\n\n::claim{id="c"}\na\n::\n\nSee [[custom-id]].\n`;
  const out = patchSource(src, { op: "rename_id", from: "custom-id", to: "renamed" });
  assert.match(out, /\{id="renamed"\}/);
  assert.match(out, /\[\[renamed\]\]/);
});

test("patchSource: ops sequence (re-locates after each op)", () => {
  const out = patchSource(sample, [
    { op: "update_attribute", id: "c1", key: "confidence", value: 0.7 },
    { op: "rename_id", from: "c1", to: "c2" },
  ]);
  assert.match(out, /::claim\{id="c2" confidence=0\.7\}/);
  assert.match(out, /for="c2"/);
});

test("patchSource: every line outside the patched block is byte-identical", () => {
  const out = patchSource(sample, {
    op: "update_attribute",
    id: "c1",
    key: "confidence",
    value: 0.95,
  });
  const before = sample.split("\n");
  const after = out.split("\n");
  assert.equal(after.length, before.length, "line count must not change");
  let driftLines = 0;
  for (let i = 0; i < before.length; i++) {
    if (before[i]!.includes('id="c1"')) {
      driftLines++;
      continue;
    }
    assert.equal(after[i], before[i], `line ${i + 1} drifted: "${before[i]}" → "${after[i]}"`);
  }
  assert.equal(driftLines, 1, "exactly one line should change (the targeted open line)");
});

test("patchSource: replace_block leaves frontmatter and sibling bytes identical", () => {
  const out = patchSource(sample, {
    op: "replace_block",
    id: "c1",
    content: `::claim{id="c1" confidence=0.99}\nfresh body\n::`,
  });
  const before = sample.split("\n");
  const after = out.split("\n");
  // Frontmatter (lines 0..3, ending '---') untouched.
  for (let i = 0; i < 5; i++) {
    assert.equal(after[i], before[i], `frontmatter line ${i} drifted`);
  }
  // The evidence block (after the claim) must still be byte-identical.
  const evIdxBefore = before.findIndex((l) => l.includes("::evidence"));
  const evIdxAfter = after.findIndex((l) => l.includes("::evidence"));
  assert.notEqual(evIdxAfter, -1);
  for (let i = 0; i < 4; i++) {
    assert.equal(after[evIdxAfter + i], before[evIdxBefore + i]);
  }
});

test("patchSource: rename_id retargets bareword reference attrs", () => {
  const src = `::claim{id="c1"}\nx\n::\n\n::evidence{for=c1}\ne\n::\n\n::plot{dataset=c1}\np\n::\n\n::comment{parent=c1}\nnote\n::\n`;
  const out = patchSource(src, { op: "rename_id", from: "c1", to: "c2" });
  assert.match(out, /::evidence\{for="c2"\}/);
  assert.match(out, /::plot\{dataset="c2"\}/);
  assert.match(out, /::comment\{parent="c2"\}/);
  assert.doesNotMatch(out, /=c1\b/);
});

test("patchSource: missing id throws", () => {
  assert.throws(
    () => patchSource(sample, { op: "delete_block", id: "missing" }),
    /not found/,
  );
});
