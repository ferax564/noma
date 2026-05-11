import { test } from "node:test";
import assert from "node:assert/strict";
import { patchSource, PatchError } from "../src/patch.js";

test("delete_block on missing id throws PatchError with code=target_missing", () => {
  try {
    patchSource("::claim{id=a}\nx\n::\n", { op: "delete_block", id: "missing" });
    assert.fail("expected throw");
  } catch (e) {
    assert.ok(e instanceof PatchError);
    assert.equal((e as PatchError).code, "target_missing");
  }
});

test("rename_id to existing id throws id_conflict", () => {
  try {
    patchSource("::claim{id=a}\nx\n::\n\n::claim{id=b}\ny\n::\n", { op: "rename_id", from: "a", to: "b" });
    assert.fail("expected throw");
  } catch (e) {
    assert.equal((e as PatchError).code, "id_conflict");
  }
});

test("update_attribute key=id throws id_attribute_protected", () => {
  try {
    patchSource("::claim{id=a}\nx\n::\n", { op: "update_attribute", id: "a", key: "id", value: "z" });
    assert.fail("expected throw");
  } catch (e) {
    assert.equal((e as PatchError).code, "id_attribute_protected");
  }
});

test("add_block parent=missing throws parent_missing", () => {
  try {
    patchSource("::claim{id=a}\nx\n::\n", { op: "add_block", parent: "nope", content: "::card{id=z}\nz\n::" });
    assert.fail("expected throw");
  } catch (e) {
    assert.equal((e as PatchError).code, "parent_missing");
  }
});

test("replace_block content not parseable throws invalid_content", () => {
  try {
    patchSource("::claim{id=a}\nx\n::\n", { op: "replace_block", id: "a", content: "garbage that doesn't open a block" });
    assert.fail("expected throw");
  } catch (e) {
    assert.equal((e as PatchError).code, "invalid_content");
  }
});
