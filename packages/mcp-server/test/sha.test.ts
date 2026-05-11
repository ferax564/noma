import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { sha256hex } from "../src/sha.js";

describe("sha256hex", () => {
  it("returns lowercase hex string of length 64", () => {
    const h = sha256hex(Buffer.from("hello"));
    assert.equal(h.length, 64);
    assert.match(h, /^[0-9a-f]+$/);
  });

  it("is deterministic", () => {
    assert.equal(sha256hex(Buffer.from("abc")), sha256hex(Buffer.from("abc")));
  });

  it("differs for different inputs", () => {
    assert.notEqual(sha256hex(Buffer.from("a")), sha256hex(Buffer.from("b")));
  });

  it("accepts string input", () => {
    assert.equal(sha256hex("hello"), sha256hex(Buffer.from("hello")));
  });
});
