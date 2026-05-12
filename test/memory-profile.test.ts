import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parse } from "../src/parser.js";
import { validate } from "../src/validator.js";

const EXAMPLE = resolve("examples/agent-memory/memory.noma");

test("memory profile: example file validates clean", () => {
  const doc = parse(readFileSync(EXAMPLE, "utf8"));
  const diags = validate(doc);
  assert.equal(
    diags.length,
    0,
    `expected no diagnostics, got: ${diags.map((d) => d.code).join(", ")}`,
  );
});

test("memory profile: missing type is an error", () => {
  const src = `---
profile: memory
---

::memory{id="m1" confidence=0.9 last_seen="2026-05-12"}
body
::
`;
  const diags = validate(parse(src));
  const d = diags.find((x) => x.code === "memory-missing-type");
  assert.ok(d, "expected memory-missing-type diagnostic");
  assert.equal(d?.severity, "error");
});

test("memory profile: invalid type is an error", () => {
  const src = `---
profile: memory
---

::memory{id="m1" type="random" last_seen="2026-05-12"}
body
::
`;
  const diags = validate(parse(src));
  const d = diags.find((x) => x.code === "memory-invalid-type");
  assert.ok(d, "expected memory-invalid-type diagnostic");
});

test("memory profile: confidence out of [0,1] is an error", () => {
  const src = `---
profile: memory
---

::memory{id="m1" type="user" confidence=1.5 last_seen="2026-05-12"}
body
::
`;
  const diags = validate(parse(src));
  const d = diags.find((x) => x.code === "memory-invalid-confidence");
  assert.ok(d, "expected memory-invalid-confidence diagnostic");
});

test("memory profile: non-ISO last_seen is an error", () => {
  const src = `---
profile: memory
---

::memory{id="m1" type="user" last_seen="yesterday"}
body
::
`;
  const diags = validate(parse(src));
  const d = diags.find((x) => x.code === "memory-invalid-last-seen");
  assert.ok(d, "expected memory-invalid-last-seen diagnostic");
});

test("memory profile: wikilink to non-memory block warns", () => {
  const src = `---
profile: memory
---

::memory_index{id="index"}
- [[other]]
::

::memory{id="m1" type="user" last_seen="2026-05-12"}
body
::

::note{id="other"}
not a memory
::
`;
  const diags = validate(parse(src));
  const d = diags.find((x) => x.code === "memory-wikilink-non-memory-target");
  assert.ok(d, "expected memory-wikilink-non-memory-target diagnostic");
  assert.equal(d?.severity, "warning");
});

test("memory profile: directive outside allow-list warns", () => {
  const src = `---
profile: memory
---

::memory{id="m1" type="user" last_seen="2026-05-12"}
body
::

::claim{id="c1"}
not allowed in memory profile
::
`;
  const diags = validate(parse(src));
  const d = diags.find(
    (x) => x.code === "out-of-profile-directive" && x.message.includes("claim"),
  );
  assert.ok(d, "expected out-of-profile-directive on ::claim");
});

test("memory profile: confidence as flag is rejected", () => {
  const src = `---
profile: memory
---

::memory{id="m1" type="user" confidence last_seen="2026-05-12"}
body
::
`;
  const diags = validate(parse(src));
  const d = diags.find((x) => x.code === "memory-invalid-confidence");
  assert.ok(d, "boolean confidence (flag) should be rejected");
});

test("memory profile: empty-string confidence is rejected", () => {
  const src = `---
profile: memory
---

::memory{id="m1" type="user" confidence="" last_seen="2026-05-12"}
body
::
`;
  const diags = validate(parse(src));
  const d = diags.find((x) => x.code === "memory-invalid-confidence");
  assert.ok(d, "empty-string confidence should be rejected");
});

test("memory profile: impossible calendar date in last_seen is rejected", () => {
  const src = `---
profile: memory
---

::memory{id="m1" type="user" last_seen="2026-02-31"}
body
::
`;
  const diags = validate(parse(src));
  const d = diags.find((x) => x.code === "memory-invalid-last-seen");
  assert.ok(d, "Feb 31 should not round-trip through Date and must be rejected");
});

test("memory profile: wikilink via alias to non-memory block still warns", () => {
  const src = `---
profile: memory
---

::memory_index{id="index"}
- [[risk-alias]]
::

::memory{id="m1" type="user" last_seen="2026-05-12"}
ok
::

## Risks {id="risks" aliases="risk-alias"}
not a memory
`;
  const diags = validate(parse(src));
  const d = diags.find((x) => x.code === "memory-wikilink-non-memory-target");
  assert.ok(
    d,
    "wikilink via section alias should still trip memory-wikilink-non-memory-target",
  );
});

test("memory profile: noverify suppresses memory rules", () => {
  const src = `---
profile: memory
---

::memory{id="m1" type="random" confidence=99 last_seen="bogus" noverify}
body
::
`;
  const diags = validate(parse(src));
  for (const code of [
    "memory-missing-type",
    "memory-invalid-type",
    "memory-invalid-confidence",
    "memory-invalid-last-seen",
  ]) {
    assert.equal(
      diags.find((d) => d.code === code),
      undefined,
      `noverify should have suppressed ${code}`,
    );
  }
});
