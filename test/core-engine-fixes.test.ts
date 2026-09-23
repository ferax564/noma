import { test } from "node:test";
import assert from "node:assert/strict";
import { parse, slugify } from "../src/parser.js";
import { isDirective, walk, type DirectiveNode, type DocumentNode, type Node } from "../src/ast.js";
import { renderNoma } from "../src/renderer-noma.js";
import { validate } from "../src/validator.js";
import { findById, patch, patchSource, PatchError, type PatchOp } from "../src/patch.js";

function directive(doc: DocumentNode, name: string): DirectiveNode {
  for (const node of walk(doc)) {
    if (isDirective(node) && node.name === name) return node;
  }
  throw new Error(`no ::${name} directive`);
}

function sectionIds(doc: DocumentNode): string[] {
  const out: string[] = [];
  for (const node of walk(doc)) if (node.type === "section") out.push(node.id ?? "");
  return out;
}

function patchCode(source: string, op: PatchOp): string {
  try {
    patchSource(source, op);
  } catch (err) {
    if (err instanceof PatchError) return err.code;
    throw err;
  }
  return "ok";
}

// ---------------------------------------------------------------- parser

test("parser: quoted numeric-looking attribute values stay strings", () => {
  const doc = parse(`::claim{id="2024" version="1.10" flag="true" n=3 x=0.82 b=true}\nbody\n::\n`);
  const claim = directive(doc, "claim");
  assert.equal(claim.id, "2024");
  assert.equal(claim.attrs.id, "2024");
  assert.equal(claim.attrs.version, "1.10");
  assert.equal(claim.attrs.flag, "true");
  assert.equal(claim.attrs.n, 3);
  assert.equal(claim.attrs.x, 0.82);
  assert.equal(claim.attrs.b, true);
});

test("parser: bareword numeric id is kept as a string id", () => {
  const claim = directive(parse(`::claim{id=2024}\nbody\n::\n`), "claim");
  assert.equal(claim.id, "2024");
  assert.equal(claim.attrs.id, "2024");
});

test("parser: quoted numeric strings still work for numeric consumers", () => {
  const doc = parse(`::claim{id="c" confidence="0.9"}\nbody\n::\n\n::evidence{for="c"}\ne\n::\n`);
  const codes = validate(doc).map((d) => d.code);
  assert.ok(!codes.includes("claim-invalid-confidence"), codes.join(","));
});

test("parser: invalid YAML frontmatter does not throw and surfaces a diagnostic", () => {
  const src = `---\ntitle: "unterminated\nfoo: [1, 2\n---\n\n# Hello\n\nBody.\n`;
  const doc = parse(src);
  assert.deepEqual(sectionIds(doc), ["hello"]);
  const fm = doc.children[0];
  assert.equal(fm?.type, "frontmatter");
  const diags = validate(doc);
  const d = diags.find((x) => x.code === "invalid-frontmatter");
  assert.ok(d, "expected invalid-frontmatter diagnostic");
  assert.equal(d.severity, "error");
  assert.equal(renderNoma(doc), src);
});

test("parser: leading --- used as a thematic break keeps its content", () => {
  const doc = parse("---\n\nHello world\n\n---\n\nAfter\n");
  const types = doc.children.map((c) => c.type);
  assert.deepEqual(types, ["thematic_break", "paragraph", "thematic_break", "paragraph"]);
  assert.equal((doc.children[1] as { content: string }).content, "Hello world");
  assert.deepEqual(doc.meta, {});
});

test("parser: empty and mapping frontmatter still parse as frontmatter", () => {
  assert.deepEqual(parse("---\n---\n\nx\n").children.map((c) => c.type), ["paragraph"]);
  const doc = parse("---\ntitle: T\n---\n\nx\n");
  assert.equal(doc.meta.title, "T");
  assert.equal(doc.children[0]?.type, "frontmatter");
});

test("parser: non-Latin headings get Unicode slugs", () => {
  assert.equal(slugify("日本語"), "日本語");
  assert.equal(slugify("Привет мир"), "привет-мир");
  assert.equal(slugify("Café au lait"), "cafe-au-lait");
  assert.equal(slugify("API: v2 (beta)"), "api-v2-beta");
  const doc = parse("# 日本語\n\n## Привет\n\n## Привет\n");
  assert.deepEqual(sectionIds(doc), ["日本語", "привет", "привет-2"]);
});

test("parser: headings with an empty slug fall back to section-N ids", () => {
  const doc = parse("# ???\n\n## !!!\n");
  assert.deepEqual(sectionIds(doc), ["section", "section-2"]);
});

test("parser: trailing braces that are not attributes stay in the heading title", () => {
  const doc = parse("# Set {a, b}\n\n## Map {x}\n\n## Real {id=\"r\" aliases=\"q\"}\n");
  const secs = [...walk(doc)].filter((n) => n.type === "section");
  assert.equal((secs[0] as { title: string }).title, "Set {a, b}");
  assert.equal(secs[0]?.id, "set-a-b");
  assert.equal((secs[1] as { title: string }).title, "Map {x}");
  assert.equal((secs[2] as { title: string }).title, "Real");
  assert.equal(secs[2]?.id, "r");
  assert.deepEqual(secs[2]?.aliases, ["q"]);
});

test("parser: code fences with symbols, tildes and long backtick runs suppress structure", () => {
  const cpp = parse("```c++\n::claim{id=\"x\"}\n::\n```\n");
  assert.equal(cpp.children.length, 1);
  assert.equal(cpp.children[0]?.type, "code");
  assert.equal((cpp.children[0] as { lang?: string }).lang, "c++");

  const tilde = parse("~~~\n# Not a heading\n~~~\n");
  assert.deepEqual(tilde.children.map((c) => c.type), ["code"]);
  assert.equal((tilde.children[0] as { content: string }).content, "# Not a heading");

  const four = parse("````md\n```\n::x\n::\n```\n````\n\nafter\n");
  assert.deepEqual(four.children.map((c) => c.type), ["code", "paragraph"]);
  assert.equal((four.children[0] as { content: string }).content, "```\n::x\n::\n```");

  const mismatch = parse("~~~\n```\n~~~\n");
  assert.deepEqual(mismatch.children.map((c) => c.type), ["code"]);
  assert.equal((mismatch.children[0] as { content: string }).content, "```");
});

test("parser: long fences inside directives do not leak closers", () => {
  const doc = parse("::card{id=\"c\"}\n````\n```\n::\n```\n````\n::\n\nafter\n");
  assert.equal(doc.children.length, 2);
  const card = doc.children[0] as DirectiveNode;
  assert.equal(card.id, "c");
  assert.equal(card.children[0]?.type, "code");
});

test("renderNoma: code content with backtick fences roundtrips via a longer fence", () => {
  const doc = parse("````\n```\ninner\n```\n````\n");
  const again = parse(renderNoma(doc));
  assert.equal((again.children[0] as { content: string }).content, "```\ninner\n```");
});

test("attribute values with both quote kinds roundtrip through renderNoma", () => {
  const doc = parse(`::card{id="c"}\nbody\n::\n`);
  const card = directive(doc, "card");
  card.attrs.title = `He said "it's" \\ fine\\`;
  const again = directive(parse(renderNoma(doc)), "card");
  assert.equal(again.attrs.title, `He said "it's" \\ fine\\`);
});

test("parser: escaped quotes and backslashes in double-quoted values", () => {
  const card = directive(parse(`::card{title="a \\"b\\" \\\\ c \\d" x="y"}\n::\n`), "card");
  assert.equal(card.attrs.title, `a "b" \\ c \\d`);
  assert.equal(card.attrs.x, "y");
});

// ---------------------------------------------------------------- patch

test("patch: update_attribute with both quote kinds is readable after patch", () => {
  const src = `::claim{id="c1"}\nbody\n::\n`;
  const value = `She said "don't" \\n`;
  const out = patchSource(src, { op: "update_attribute", id: "c1", key: "note", value });
  assert.equal(directive(parse(out), "claim").attrs.note, value);
  const again = patchSource(out, { op: "update_attribute", id: "c1", key: "note", value: "plain" });
  assert.equal(again, `::claim{id="c1" note="plain"}\nbody\n::\n`);
});

test("patch: newline in attribute value is rejected", () => {
  const src = `::claim{id="c1"}\nbody\n::\n\n::claim{id="c2"}\nx\n::\n`;
  assert.equal(
    patchCode(src, { op: "update_attribute", id: "c1", key: "note", value: "a\"}\n::\n::evil{id=\"e\"" }),
    "invalid_attribute_value",
  );
  assert.throws(
    () => patch(parse(src), { op: "update_attribute", id: "c1", key: "note", value: "a\nb" }),
    (err: unknown) => err instanceof PatchError && err.code === "invalid_attribute_value",
  );
});

test("patch: malformed attribute keys are rejected", () => {
  const src = `::claim{id="c1"}\nbody\n::\n`;
  for (const key of ["a b", "x}\n::", "", "1abc", "a=b", "a\"b"]) {
    assert.equal(patchCode(src, { op: "update_attribute", id: "c1", key, value: "v" }), "invalid_attribute_key", key);
    assert.equal(patchCode(src, { op: "remove_attribute", id: "c1", key }), "invalid_attribute_key", key);
  }
});

test("patch: newlines in heading titles and comment attributes are rejected", () => {
  const src = `# Title\n\n::claim{id="c1"}\nbody\n::\n`;
  assert.equal(patchCode(src, { op: "update_heading", id: "title", title: "A\n::evil" }), "invalid_content");
  assert.equal(
    patchCode(src, { op: "add_comment", id: "k", target: "c1", content: "hi", author: "x\ny" }),
    "invalid_attribute_value",
  );
  assert.equal(patchCode(src, { op: "rename_id", from: "c1", to: "a\nb" }), "invalid_attribute_value");
});

test("patch: replace_body content that closes the block early is rejected", () => {
  const src = `::claim{id="c1"}\nbody\n::\n\n::claim{id="c2"}\nx\n::\n`;
  assert.equal(
    patchCode(src, { op: "replace_body", id: "c1", content: "ok\n::\n\n::claim{id=\"evil\"}\ninjected" }),
    "unbalanced_fence_content",
  );
  assert.equal(patchCode(src, { op: "replace_body", id: "c1", content: "```\nunclosed" }), "unbalanced_fence_content");
  const nested = `::card{id="card"}\n:::note{id="n"}\ntext\n:::\n::\n\nafter\n`;
  assert.equal(patchCode(nested, { op: "replace_body", id: "n", content: "a\n:::\n::\n" }), "unbalanced_fence_content");
  assert.equal(patchCode(nested, { op: "replace_body", id: "n", content: "a\n::\nb" }), "unbalanced_fence_content");
});

test("patch: replace_body allows balanced nested fences and code with colons", () => {
  const src = `::card{id="c1"}\nbody\n::\n\nafter\n`;
  const content = ":::note{id=\"inner\"}\nx\n:::\n\n```\n::\n```";
  const out = patchSource(src, { op: "replace_body", id: "c1", content });
  assert.equal(out, `::card{id="c1"}\n${content}\n::\n\nafter\n`);
  const doc = parse(out);
  assert.ok(findById(doc, "inner"));
});

test("patch: replace_body inside a directive rejects paragraphs that escape their parent", () => {
  const src = `::card{id="card"}\n{#p1}\nold text\n::\n\nafter\n`;
  assert.equal(patchCode(src, { op: "replace_body", id: "p1", content: "new\n::" }), "unbalanced_fence_content");
  assert.equal(
    patchSource(src, { op: "replace_body", id: "p1", content: "new text" }),
    `::card{id="card"}\n{#p1}\nnew text\n::\n\nafter\n`,
  );
});

test("patch: replace_body on an unclosed directive replaces the old body", () => {
  const src = `::claim{id="c1"}\nold one\nold two\n`;
  const out = patchSource(src, { op: "replace_body", id: "c1", content: "new body" });
  assert.equal(out, `::claim{id="c1"}\nnew body\n`);
  const noNewline = patchSource(`::claim{id="c1"}\nold`, { op: "replace_body", id: "c1", content: "new" });
  assert.equal(noNewline, `::claim{id="c1"}\nnew`);
});

test("patch: replace_body on a list item keeps its {#id} marker", () => {
  const src = `- {#li-1} first\n- {#li-2} second\n`;
  const out = patchSource(src, { op: "replace_body", id: "li-2", content: "changed" });
  assert.equal(out, `- {#li-1} first\n- {#li-2} changed\n`);
  assert.ok(findById(parse(out), "li-2"));
});

test("patch: CRLF files keep CRLF line endings on patched lines", () => {
  const src = `# T\r\n\r\n::claim{id="c1" a=1}\r\nold\r\n::\r\n`;
  const ops: PatchOp[] = [
    { op: "update_attribute", id: "c1", key: "b", value: "x" },
    { op: "replace_body", id: "c1", content: "new\nlines" },
    { op: "add_block", parent: "t", content: "::note{id=\"n\"}\nhi\n::" },
  ];
  const out = patchSource(src, ops);
  assert.ok(!/[^\r]\n/.test(out), JSON.stringify(out));
  assert.equal(
    out,
    `# T\r\n\r\n::claim{id="c1" a=1 b="x"}\r\nnew\r\nlines\r\n::\r\n\r\n::note{id="n"}\r\nhi\r\n::\r\n`,
  );
});

test("patch: every node walk still resolves ids after unicode heading patch", () => {
  const src = `# Привет\n\n::claim{id="c"}\nb\n::\n`;
  const out = patchSource(src, { op: "update_heading", id: "привет", title: "Мир" });
  assert.equal(out.split("\n")[0], `# Мир {id="привет"}`);
  assert.ok(findById(parse(out), "привет"));
  const nodes: Node[] = [...walk(parse(out))];
  assert.ok(nodes.length > 0);
});
