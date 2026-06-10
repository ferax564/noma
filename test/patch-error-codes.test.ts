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

test("replace_body without content throws invalid_content, never a TypeError", () => {
  try {
    patchSource("::claim{id=a}\nx\n::\n", { op: "replace_body", id: "a" } as never);
    assert.fail("expected throw");
  } catch (e) {
    assert.ok(e instanceof PatchError, `expected PatchError, got ${(e as Error).name}: ${(e as Error).message}`);
    assert.equal((e as PatchError).code, "invalid_content");
    assert.match((e as PatchError).message, /requires string field "content"/);
  }
});

test("replace_body with a stray body field suggests content", () => {
  try {
    patchSource("::claim{id=a}\nx\n::\n", { op: "replace_body", id: "a", body: "new text" } as never);
    assert.fail("expected throw");
  } catch (e) {
    assert.match((e as PatchError).message, /found "body"; did you mean "content"\?/);
  }
});

test("update_table_cell with string row throws invalid_content", () => {
  try {
    patchSource("::claim{id=a}\nx\n::\n", { op: "update_table_cell", id: "a", row: "0", column: 0, value: "x" } as never);
    assert.fail("expected throw");
  } catch (e) {
    assert.equal((e as PatchError).code, "invalid_content");
    assert.match((e as PatchError).message, /requires number field "row"/);
  }
});

test("insert_table_row with non-string cells throws invalid_content", () => {
  try {
    patchSource("::claim{id=a}\nx\n::\n", { op: "insert_table_row", id: "a", row: 0, cells: [1, 2] } as never);
    assert.fail("expected throw");
  } catch (e) {
    assert.equal((e as PatchError).code, "invalid_content");
    assert.match((e as PatchError).message, /requires string\[\] field "cells"/);
  }
});

test("unknown op name throws unsupported_op", () => {
  try {
    patchSource("::claim{id=a}\nx\n::\n", { op: "set_body", id: "a", content: "x" } as never);
    assert.fail("expected throw");
  } catch (e) {
    assert.equal((e as PatchError).code, "unsupported_op");
  }
});

test("rename_id without to throws invalid_content listing received fields", () => {
  try {
    patchSource("::claim{id=a}\nx\n::\n", { op: "rename_id", from: "a" } as never);
    assert.fail("expected throw");
  } catch (e) {
    assert.equal((e as PatchError).code, "invalid_content");
    assert.match((e as PatchError).message, /received fields: op, from/);
  }
});
