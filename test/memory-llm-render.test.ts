import { test } from "node:test";
import assert from "node:assert/strict";
import { parse } from "../src/parser.js";
import { renderLlm } from "../src/renderer-llm.js";

const SRC = `---
profile: memory
---

::memory{id="fresh_project" type="project" last_seen="2026-05-12"}
fresh project body
::

::memory{id="stale_project" type="project" last_seen="2025-01-01"}
stale project body
::
`;

test("renderLlm: default includes all memories", () => {
  const out = renderLlm(parse(SRC));
  assert.match(out, /fresh project body/);
  assert.match(out, /stale project body/);
});

test("renderLlm: excludeStale drops stale project memories", () => {
  const out = renderLlm(parse(SRC), {
    excludeStale: { now: new Date("2026-05-13T00:00:00Z"), days: 30 },
  });
  assert.match(out, /fresh project body/, "fresh project memory should be kept");
  assert.doesNotMatch(out, /stale project body/, "stale project memory should be dropped");
});

test("renderLlm: excludeStale skips when last_seen missing", () => {
  const src = `::memory{id="m" type="project"}\nbody\n::\n`;
  const out = renderLlm(parse(src), {
    excludeStale: { now: new Date("2030-01-01"), days: 1 },
  });
  assert.match(out, /body/, "memory without last_seen should not be excluded");
});

test("renderLlm: durable types (user, feedback) are kept regardless of last_seen", () => {
  const src = `---
profile: memory
---

::memory{id="ancient_user" type="user" last_seen="2020-01-01"}
ancient user rule
::

::memory{id="ancient_feedback" type="feedback" last_seen="2020-01-01"}
ancient feedback rule
::
`;
  const out = renderLlm(parse(src), {
    excludeStale: { now: new Date("2026-05-13"), days: 7 },
  });
  assert.match(out, /ancient user rule/, "type=user must survive stale window by default");
  assert.match(out, /ancient feedback rule/, "type=feedback must survive stale window by default");
});

test("renderLlm: expired=true opts a durable memory into stale filtering", () => {
  const src = `---
profile: memory
---

::memory{id="m" type="feedback" last_seen="2020-01-01" expired}
deprecated rule
::
`;
  const out = renderLlm(parse(src), {
    excludeStale: { now: new Date("2026-05-13"), days: 7 },
  });
  assert.doesNotMatch(
    out,
    /deprecated rule/,
    "expired=true should allow stale-filtering of a durable type",
  );
});

test("renderLlm: memory_index drops list items pointing only at excluded memories", () => {
  const src = `---
profile: memory
---

::memory_index{id="index"}
- [[fresh_project]] — fresh
- [[stale_project]] — stale
::

::memory{id="fresh_project" type="project" last_seen="2026-05-12"}
fresh
::

::memory{id="stale_project" type="project" last_seen="2025-01-01"}
stale
::
`;
  const out = renderLlm(parse(src), {
    excludeStale: { now: new Date("2026-05-13"), days: 30 },
  });
  assert.match(out, /\[\[fresh_project\]\] — fresh|fresh_project — fresh/);
  assert.doesNotMatch(
    out,
    /stale_project/,
    "index line referencing only the excluded memory must be dropped",
  );
});

test("renderLlm: memory_index keeps lines whose links include at least one surviving memory", () => {
  const src = `---
profile: memory
---

::memory_index{id="index"}
- [[fresh_project]] and [[stale_project]] both
::

::memory{id="fresh_project" type="project" last_seen="2026-05-12"}
fresh
::

::memory{id="stale_project" type="project" last_seen="2025-01-01"}
stale
::
`;
  const out = renderLlm(parse(src), {
    excludeStale: { now: new Date("2026-05-13"), days: 30 },
  });
  assert.match(
    out,
    /fresh_project.*stale_project|stale_project.*fresh_project|both/,
    "line with a surviving wikilink target must stay",
  );
});
