import { test } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { patchBookSource } from "../src/patch-book.js";
import { PatchError } from "../src/patch.js";
import { loadBookChapters } from "../src/book.js";
import { walk } from "../src/ast.js";

function tempBook(): string {
  const dir = mkdtempSync(join(tmpdir(), "noma-book-patch-"));
  cpSync("examples/book", dir, { recursive: true });
  return join(dir, "book.noma.yml");
}

test("routes an op to the owning chapter by directive id", () => {
  const manifest = tempBook();
  const result = patchBookSource(manifest, [
    { op: "update_attribute", id: "claim-typed-blocks", key: "confidence", value: 0.9 },
  ]);
  const changed = result.files.filter((f) => f.changed);
  assert.equal(changed.length, 1);
  assert.match(changed[0]!.file, /02-block-model\.noma$/);
});

test("dry run leaves files untouched; write persists only changed chapters", () => {
  const manifest = tempBook();
  const chapter = manifest.replace("book.noma.yml", "chapters/02-block-model.noma");
  const before = readFileSync(chapter, "utf8");
  patchBookSource(manifest, [
    { op: "update_attribute", id: "claim-typed-blocks", key: "confidence", value: 0.9 },
  ]);
  assert.equal(readFileSync(chapter, "utf8"), before);

  patchBookSource(
    manifest,
    [{ op: "update_attribute", id: "claim-typed-blocks", key: "confidence", value: 0.9 }],
    { write: true },
  );
  assert.match(readFileSync(chapter, "utf8"), /confidence=0\.9/);
});

test("ops spanning multiple chapters apply in one transaction", () => {
  const manifest = tempBook();
  const result = patchBookSource(
    manifest,
    [
      { op: "update_attribute", id: "claim-typed-blocks", key: "confidence", value: 0.95 },
      { op: "update_attribute", id: "claim-block-trust", key: "confidence", value: 0.99 },
    ],
    { write: true },
  );
  const changed = result.files.filter((f) => f.changed).map((f) => f.file);
  assert.equal(changed.length, 2);
  assert.match(readFileSync(changed.find((f) => f.includes("02-"))!, "utf8"), /confidence=0\.95/);
  assert.match(readFileSync(changed.find((f) => f.includes("03-"))!, "utf8"), /confidence=0\.99/);
});

test("chapter-scoped section ids route and retarget to the raw file id", () => {
  const manifest = tempBook();
  const { chapters } = loadBookChapters(manifest);
  let scopedId: string | undefined;
  for (const chapter of chapters) {
    for (const node of walk(chapter.doc)) {
      if (node.type === "section" && node.id?.includes("/")) {
        scopedId = node.id;
        break;
      }
    }
    if (scopedId) break;
  }
  assert.ok(scopedId, "expected a chapter-scoped section id in the demo book");
  const result = patchBookSource(manifest, [
    { op: "update_heading", id: scopedId, title: "Retitled by transaction" },
  ]);
  assert.equal(result.files.filter((f) => f.changed).length, 1);
});

test("unknown target ids fail the whole transaction with target_missing", () => {
  const manifest = tempBook();
  try {
    patchBookSource(manifest, [
      { op: "update_attribute", id: "claim-typed-blocks", key: "confidence", value: 0.9 },
      { op: "delete_block", id: "does-not-exist-anywhere" },
    ]);
    assert.fail("expected PatchError");
  } catch (e) {
    assert.ok(e instanceof PatchError);
    assert.equal(e.code, "target_missing");
  }
});

test("blockOnErrors refuses to write when the patched book has validation errors", () => {
  const manifest = tempBook();
  const chapter = manifest.replace("book.noma.yml", "chapters/02-block-model.noma");
  const before = readFileSync(chapter, "utf8");
  try {
    patchBookSource(
      manifest,
      [
        {
          op: "add_block",
          parent: "why-typed-blocks-matter",
          content: '::evidence{id="ev-broken" for="totally-absent-target"}\nbroken\n::',
        },
      ],
      { write: true, blockOnErrors: true },
    );
    assert.fail("expected PatchError");
  } catch (e) {
    assert.ok(e instanceof PatchError);
    assert.equal(e.code, "pre_validation_blocked");
  }
  assert.equal(readFileSync(chapter, "utf8"), before);
});

test("baseHash preconditions hold against the chapter file source", () => {
  const manifest = tempBook();
  try {
    patchBookSource(manifest, [
      {
        op: "update_attribute",
        id: "claim-typed-blocks",
        key: "confidence",
        value: 0.9,
        baseHash: "deadbeefdeadbeef",
      },
    ]);
    assert.fail("expected PatchError");
  } catch (e) {
    assert.ok(e instanceof PatchError);
    assert.equal(e.code, "sha_mismatch");
  }
});
