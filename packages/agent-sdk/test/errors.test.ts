import { test } from "node:test";
import assert from "node:assert/strict";
import {
  NomaSystemError,
  NomaSpawnError,
  NomaTransportError,
  NomaCapabilityError,
  NomaTimeoutError,
} from "../src/errors.js";

test("NomaSystemError carries message and optional cause", () => {
  const cause = new Error("underlying");
  const e = new NomaSystemError("boom", cause);
  assert.equal(e.message, "boom");
  assert.equal(e.cause, cause);
  assert.equal(e.name, "NomaSystemError");
  assert.ok(e instanceof Error);
});

test("subclasses inherit from NomaSystemError and carry their own name", () => {
  const cases = [
    [new NomaSpawnError("a"), "NomaSpawnError"],
    [new NomaTransportError("b"), "NomaTransportError"],
    [new NomaCapabilityError("c"), "NomaCapabilityError"],
    [new NomaTimeoutError("d"), "NomaTimeoutError"],
  ] as const;
  for (const [err, expectedName] of cases) {
    assert.ok(err instanceof NomaSystemError, `${expectedName} must extend NomaSystemError`);
    assert.equal(err.name, expectedName);
  }
});

test("cause is preserved across subclasses", () => {
  const cause = new Error("fs");
  const e = new NomaTransportError("transport failure", cause);
  assert.equal(e.cause, cause);
});
