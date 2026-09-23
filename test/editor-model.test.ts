import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";
import { walk } from "../src/ast.js";
import {
  editorBlockKey,
  editorDocToNoma,
  editorIdBackfill,
  type EditorDoc,
  type EditorNode,
  nomaToEditorDoc,
  parseInline,
  planBlockMerge,
  serializeInline,
} from "../src/editor-model.js";
import { parse } from "../src/parser.js";

function corpus(): Array<{ name: string; source: string }> {
  const files: Array<{ name: string; source: string }> = [];
  const visit = (dir: string, recurse: boolean): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory() && recurse) visit(path, recurse);
      else if (entry.isFile() && entry.name.endsWith(".noma")) files.push({ name: path, source: readFileSync(path, "utf8") });
    }
  };
  visit("examples", true);
  visit("docs", true);
  return files;
}

function ids(source: string): string[] {
  const out: string[] = [];
  for (const node of walk(parse(source))) {
    if (node.id) out.push(node.id);
    if (node.type === "list") for (const item of node.items) if (item.id) out.push(item.id);
  }
  return out.sort();
}

function clone(doc: EditorDoc): EditorDoc {
  return JSON.parse(JSON.stringify(doc)) as EditorDoc;
}

function changedLineSpan(before: string, after: string): { prefix: number; suffix: number } {
  const a = before.split("\n");
  const b = after.split("\n");
  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++;
  let suffix = 0;
  while (suffix < a.length - prefix && suffix < b.length - prefix && a[a.length - 1 - suffix] === b[b.length - 1 - suffix]) suffix++;
  return { prefix, suffix };
}

test("every example and doc round-trips byte-for-byte through the editor model", () => {
  const files = corpus();
  assert.ok(files.length > 20, "expected a real corpus");
  for (const file of files) {
    const doc = nomaToEditorDoc(file.source);
    assert.equal(editorDocToNoma(doc, file.source), file.source, `${file.name} did not round-trip`);
    assert.deepEqual(nomaToEditorDoc(file.source), doc, `${file.name} projection is not deterministic`);
  }
});

test("the projection is also stable when re-serialized without the original", () => {
  for (const file of corpus()) {
    const doc = nomaToEditorDoc(file.source);
    const fresh = editorDocToNoma(doc, "");
    const again = nomaToEditorDoc(fresh);
    const withoutAssigned = (key: string): string => key.replace(/id=\\"[a-z_]+-\d+\\" ?/g, "").replace(/id=\\"x\\" ?/g, "");
    assert.deepEqual(again.content.map(editorBlockKey).map(withoutAssigned), doc.content.map(editorBlockKey).map(withoutAssigned), `${file.name} fresh serialization drifted`);
    const freshIds = new Set(ids(fresh));
    for (const id of new Set(ids(file.source))) assert.ok(freshIds.has(id), `${file.name} lost stable ID ${id} on fresh serialization`);
  }
});

test("editing one block changes only that block's lines across the corpus", () => {
  for (const file of corpus()) {
    const doc = nomaToEditorDoc(file.source);
    const index = doc.content.findIndex((node) => node.type === "paragraph");
    if (index < 0) continue;
    const edited = clone(doc);
    const paragraph = edited.content[index]!;
    paragraph.content = [...(paragraph.content ?? []), { type: "text", text: " Edited visually." }];
    const out = editorDocToNoma(edited, file.source);
    const before = file.source.split("\n");
    const after = out.split("\n");
    assert.equal(after.length, before.length, `${file.name}: paragraph edit changed line count`);
    const span = changedLineSpan(file.source, out);
    const changed = after.length - span.prefix - span.suffix;
    assert.ok(changed >= 1 && changed <= (paragraph.content?.filter((n) => n.type === "hard_break").length ?? 0) + 1, `${file.name}: touched ${changed} lines`);
    assert.match(out, /Edited visually\./);
    assert.deepEqual(ids(out), ids(file.source), `${file.name}: IDs changed`);
  }
});

test("inserting or deleting a block keeps every other block intact across the corpus", () => {
  for (const file of corpus()) {
    const doc = nomaToEditorDoc(file.source);
    const keys = doc.content.map(editorBlockKey);
    const middle = Math.floor(doc.content.length / 2);
    if (doc.content[middle]?.type === "frontmatter" || doc.content.length < 2) continue;

    const deleted = clone(doc);
    deleted.content.splice(middle, 1);
    const afterDelete = editorDocToNoma(deleted, file.source);
    assert.deepEqual(nomaToEditorDoc(afterDelete).content.map(editorBlockKey), keys.filter((_, index) => index !== middle), `${file.name}: delete disturbed other blocks`);

    const inserted = clone(doc);
    inserted.content.splice(middle, 0, { type: "paragraph", content: [{ type: "text", text: "Inserted by the visual editor." }] });
    const afterInsert = editorDocToNoma(inserted, file.source);
    const reparsed = nomaToEditorDoc(afterInsert).content.map(editorBlockKey);
    assert.deepEqual(reparsed.filter((key) => !key.includes("Inserted by the visual editor.")), keys, `${file.name}: insert disturbed other blocks`);
    assert.deepEqual(ids(afterInsert), ids(file.source), `${file.name}: insert changed IDs`);
  }
});

const sample = `---
title: Visual sample
---

# Visual Sample

Intro with **bold**, *em*, _under_, \`code\`, [link](https://example.com), [[intro|Intro link]] and $x^2$.
Second line of the same paragraph.

{#para-stable}
A paragraph with a stable marker.

## Section Two {id="two" aliases="second,deux"}

- first
- {#item-b} [x] done task
- [ ] open task

1. one
2. two

> quoted **text**
> second quote line

\`\`\`ts
const x = 1;
\`\`\`

| Name | Value |
|:---|---:|
| {#cell-a} a | 1 |
| b \\| c | 2 |

---

::callout{tone="warning"}
Careful **here**.

:::claim{id="claim-a" confidence=0.8}
Nested claim body.
:::
::

::math
E = mc^2
::

::dataset{id="ds" format="csv"}
a,b
1,2
::

::toc
::
`;

test("sample document round-trips and projects to the expected node types", () => {
  const doc = nomaToEditorDoc(sample);
  assert.equal(editorDocToNoma(doc, sample), sample);
  const types = doc.content.map((node) => node.type);
  assert.deepEqual(types, [
    "frontmatter",
    "heading",
    "paragraph",
    "paragraph",
    "heading",
    "bullet_list",
    "ordered_list",
    "blockquote",
    "code_block",
    "table",
    "horizontal_rule",
    "directive",
    "text_directive",
    "raw",
    "directive",
  ]);
  const heading = doc.content[4]!;
  assert.equal(heading.attrs?.id, "two");
  assert.equal(heading.attrs?.attrs, `id="two" aliases="second,deux"`);
  const list = doc.content[5]!;
  assert.deepEqual(list.content?.map((item) => [item.attrs?.id, item.attrs?.checked]), [[null, null], ["item-b", true], [null, false]]);
  assert.equal(doc.content[3]!.attrs?.marker, "{#para-stable}");
  const intro = doc.content[2]!.content ?? [];
  assert.ok(intro.some((node) => node.type === "wikilink" && node.attrs?.raw === "intro|Intro link"));
  assert.ok(intro.some((node) => node.type === "math_inline" && node.attrs?.tex === "x^2"));
  assert.ok(intro.some((node) => node.type === "hard_break"));
  assert.ok(intro.some((node) => node.marks?.some((mark) => mark.type === "link" && mark.attrs?.href === "https://example.com")));
  const callout = doc.content[11]!;
  assert.equal(callout.attrs?.name, "callout");
  assert.equal(callout.content?.[1]?.type, "directive");
  assert.equal(callout.content?.[1]?.attrs?.colons, 3);
});

test("inline markdown parses and serializes symmetrically", () => {
  const cases = [
    "plain",
    "**bold** and *em* and _em_ and `code`",
    "[label **strong**](https://x.test) tail",
    "wiki [[target]] and [[a|b]]",
    "math $a+b$ and $$c$$ and \\(d\\) and \\[e\\]",
    "line one\nline two",
    "escaped \\* star and $5 price",
    "code with `a | b` pipe",
  ];
  for (const text of cases) assert.equal(serializeInline(parseInline(text)), text, text);
});

test("renaming a heading keeps its stable slug as an explicit id", () => {
  const source = "# Title\n\n## Overview\n\nBody.\n";
  const doc = nomaToEditorDoc(source);
  doc.content[1]!.content = [{ type: "text", text: "Project overview" }];
  const out = editorDocToNoma(doc, source);
  assert.equal(out, "# Title\n\n## Project overview {id=\"overview\"}\n\nBody.\n");
  assert.deepEqual(ids(out), ids(source));
});

test("inserted heading that collides with an existing slug does not steal its id", () => {
  const source = "# Title\n\n## Notes\n\nBody.\n";
  const doc = nomaToEditorDoc(source);
  doc.content.splice(1, 0, { type: "heading", attrs: { level: 2 }, content: [{ type: "text", text: "Notes" }] });
  const out = editorDocToNoma(doc, source);
  const sections = [...walk(parse(out))].filter((node) => node.type === "section").map((node) => node.id);
  assert.ok(sections.includes("notes"));
  assert.equal(new Set(sections).size, sections.length);
  assert.match(out, /^# Title\n\n## Notes \{id="notes-\d+"\}\n\n## Notes \{id="notes"\}\n\nBody\.\n$/);
});

test("new blocks are appended with blank-line separation and get deterministic ids", () => {
  const source = "# Title\n\nExisting.\n";
  const doc = nomaToEditorDoc(source);
  doc.content.push(
    { type: "directive", attrs: { name: "claim", attrs: "confidence=0.7", colons: 2 }, content: [{ type: "paragraph", content: [{ type: "text", text: "New claim." }] }] },
    { type: "directive", attrs: { name: "claim", attrs: "", colons: 2 }, content: [{ type: "paragraph", content: [{ type: "text", text: "Another." }] }] },
    { type: "bullet_list", content: [{ type: "list_item", attrs: { checked: false }, content: [{ type: "text", text: "todo" }] }] },
  );
  const out = editorDocToNoma(doc, source);
  assert.equal(
    out,
    "# Title\n\nExisting.\n\n::claim{id=\"claim-1\" confidence=0.7}\nNew claim.\n::\n\n::claim{id=\"claim-2\"}\nAnother.\n::\n\n- [ ] todo\n",
  );
  assert.equal(editorDocToNoma(doc, source), out, "id assignment is deterministic");
  const patches = editorIdBackfill(doc, out);
  assert.deepEqual(patches.map((patch) => [patch.path, patch.attrs.attrs]), [
    [[2], "id=\"claim-1\" confidence=0.7"],
    [[3], "id=\"claim-2\""],
  ]);
});

test("editing inside a directive preserves the directive shell and sibling bytes", () => {
  const doc = nomaToEditorDoc(sample);
  const callout = doc.content[11]!;
  callout.content![0]!.content = [{ type: "text", text: "Rewritten." }];
  const out = editorDocToNoma(doc, sample);
  const expected = sample.replace("Careful **here**.", "Rewritten.");
  assert.equal(out, expected);
});

test("editing a list item or table row only rewrites that line", () => {
  const doc = nomaToEditorDoc(sample);
  const list = doc.content[5]!;
  list.content![2]!.attrs = { ...list.content![2]!.attrs, checked: true };
  const table = doc.content[9]!;
  table.content![2]!.content![1]!.content = [{ type: "text", text: "20" }];
  const out = editorDocToNoma(doc, sample);
  assert.equal(out, sample.replace("- [ ] open task", "- [x] open task").replace("| b \\| c | 2 |", "| b \\| c | 20 |"));
});

test("duplicated blocks never duplicate stable ids", () => {
  const doc = nomaToEditorDoc(sample);
  const marked = doc.content[3]!;
  doc.content.push(JSON.parse(JSON.stringify(marked)) as EditorNode);
  const heading = doc.content[4]!;
  doc.content.push(JSON.parse(JSON.stringify(heading)) as EditorNode);
  const out = editorDocToNoma(doc, sample);
  assert.equal(out.split("{#para-stable}").length - 1, 1);
  const sectionIds = [...walk(parse(out))].filter((node) => node.type === "section").map((node) => node.id);
  assert.equal(new Set(sectionIds).size, sectionIds.length);
  assert.ok(out.startsWith(sample.slice(0, sample.indexOf("::toc"))));
});

test("deleting blocks removes only their lines", () => {
  const doc = nomaToEditorDoc(sample);
  doc.content.splice(13, 1);
  const out = editorDocToNoma(doc, sample);
  assert.equal(out, sample.replace("::dataset{id=\"ds\" format=\"csv\"}\na,b\n1,2\n::\n\n", ""));
});

test("raw blocks round-trip their exact source when edited", () => {
  const doc = nomaToEditorDoc(sample);
  const raw = doc.content[13]!;
  raw.attrs = { ...raw.attrs, src: "::dataset{id=\"ds\" format=\"csv\"}\na,b\n3,4\n::" };
  assert.equal(editorDocToNoma(doc, sample), sample.replace("1,2", "3,4"));
});

test("an empty editor document serializes to an empty source", () => {
  const doc = nomaToEditorDoc("");
  assert.equal(doc.content[0]?.type, "paragraph");
  assert.equal(editorDocToNoma(doc, ""), "");
});

test("three-way block merge keeps live edits and applies external ones", () => {
  const base = ["a", "b", "c", "d"];
  const theirs = ["a", "B", "c", "d", "e"];
  const current = ["a", "b", "c", "D"];
  const merged = planBlockMerge(base, theirs, current).map((step) => (step.kind === "keep" ? current[step.index] : theirs[step.index]));
  assert.deepEqual(merged, ["a", "B", "c", "D", "e"]);
  const conflict = planBlockMerge(["x"], ["x-theirs"], ["x-live"]).map((step) => (step.kind === "keep" ? ["x-live"][step.index] : ["x-theirs"][step.index]));
  assert.deepEqual(conflict, ["x-live", "x-theirs"]);
  const same = planBlockMerge(["x"], ["y"], ["y"]).map((step) => step.kind);
  assert.deepEqual(same, ["keep"]);
});

test("@{userId} mentions become atom nodes and serialize back to the exact source", () => {
  const source = "# Mentions\n\nAsk @{user_abc12345} or **@{user_def67890}** about `@{not_a_mention}`.\n";
  const json = nomaToEditorDoc(source);
  const paragraph = json.content?.find((node) => node.type === "paragraph");
  const mentions = (paragraph?.content ?? []).filter((node) => node.type === "mention").map((node) => node.attrs?.userId);
  assert.deepEqual(mentions, ["user_abc12345", "user_def67890"]);
  assert.equal(editorDocToNoma(json, source), source);
  assert.equal(editorDocToNoma(json), source);
});
