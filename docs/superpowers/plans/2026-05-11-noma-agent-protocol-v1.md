# Noma Agent Protocol v1.0 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship v0.6.0 — the Noma Agent Protocol v1.0 RFC plus the reference-implementation work that makes the RFC's normative claims true.

**Architecture:** Two coupled sub-phases under one release. Phase 1B (reference-impl alignment) lands first so Phase 1A (RFC text) doesn't claim behaviour the code can't deliver. Both ship together as v0.6.0. Inside Phase 1B, AST/parser changes precede transcript writer changes precede `noma verify` CLI precedes fixture corpus; conformance corpus tasks are mechanical and parallelizable across subagents.

**Tech Stack:** TypeScript (strict, `noUncheckedIndexedAccess`), node:test, `.noma` source format, JSONL transcripts, MCP SDK over stdio.

**Source spec:** `docs/superpowers/specs/2026-05-11-noma-agent-protocol-v1-design.md` (referenced as "design doc §X.Y" below).

---

## Pre-flight

### Task 0: Verify clean baseline + create work branch

**Files:** none modified.

- [ ] **Step 1: Run typecheck**

```bash
npx tsc --noEmit
```

Expected: exits 0, no output.

- [ ] **Step 2: Run tests**

```bash
npm test
```

Expected: all suites pass.

- [ ] **Step 3: Build the site to confirm nothing in `dist/` is broken**

```bash
npm run build:site
```

Expected: exits 0; `dist/index.html` exists.

- [ ] **Step 4: Confirm working tree clean (except untracked `.context/`)**

```bash
git status --short
```

Expected: only `?? .context/` (codex session cache, never committed).

- [ ] **Step 5: Stay on `main`. Do NOT create a long-lived feature branch — Noma releases on `main` per CLAUDE.md "Releasing" section. Each task below commits to main.**

---

# Phase 1B — Reference Implementation Alignment

Phase 1B ships the production code the RFC will claim. Lands first.

---

## 1B-1 — AST + Parser work for spans (§3.9 of design doc)

### Task 1: Add `endLine` to `DocumentNode` (write failing test first)

**Files:**
- Modify: `src/parser.ts` (function `parse`, around line 50)
- Test: `test/parser.test.ts` (or create `test/parser-document-span.test.ts`)

- [ ] **Step 1: Write the failing test**

Append to `test/parser.test.ts` (or new file `test/parser-document-span.test.ts`):

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { parse } from "../src/parser.js";

test("DocumentNode carries pos and endLine spanning the whole source", () => {
  const src = `---
title: Example
---

# Heading

paragraph.
`;
  const doc = parse(src);
  assert.equal(doc.pos?.line, 1, "document starts on line 1");
  assert.equal(doc.pos?.column, 1, "document starts on column 1");
  assert.equal(doc.endLine, 7, "document spans through last line (trailing newline = empty line 7)");
});
```

- [ ] **Step 2: Run and verify it fails**

```bash
npx tsc --noEmit && node --import tsx --test test/parser-document-span.test.ts
```

Expected: FAIL — `doc.pos` is undefined.

- [ ] **Step 3: Update `parse` in `src/parser.ts` to populate `pos` and `endLine`**

Edit the `return { type: "document", ... }` block (around line 50) to:

```ts
return {
  type: "document",
  pos: { line: 1, column: 1 },
  endLine: lines.length,
  meta: { ...(options.filename ? { filename: options.filename } : {}), ...meta },
  children,
};
```

- [ ] **Step 4: Run test, verify pass**

```bash
node --import tsx --test test/parser-document-span.test.ts
```

Expected: PASS.

- [ ] **Step 5: Run full test suite to verify nothing else broke**

```bash
npm test && npx tsc --noEmit
```

Expected: all pass.

- [ ] **Step 6: Commit**

```bash
git add src/parser.ts test/parser-document-span.test.ts
git commit -m "feat(parser): DocumentNode carries pos and endLine spanning whole source"
```

---

### Task 2: Add `FrontmatterNode` AST variant + parser populates it

**Files:**
- Modify: `src/ast.ts`
- Modify: `src/parser.ts` (function `extractFrontmatter`, function `parse`)
- Modify: `src/renderer-json.ts`, `src/renderer-html.ts`, `src/renderer-llm.ts`, `src/renderer-noma.ts` (add no-op switch cases so TS compiler is happy)
- Test: `test/parser-frontmatter-node.test.ts` (new)

- [ ] **Step 1: Write the failing test**

Create `test/parser-frontmatter-node.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { parse } from "../src/parser.js";

test("parser emits FrontmatterNode when frontmatter present", () => {
  const src = `---
title: Example
date: 2026-05-11
---

# Heading
`;
  const doc = parse(src);
  const fm = doc.children[0];
  assert.equal(fm?.type, "frontmatter");
  assert.equal(fm.pos?.line, 1);
  assert.equal(fm.endLine, 4);
  assert.deepEqual(fm.data, { title: "Example", date: "2026-05-11" });
});

test("no FrontmatterNode emitted when frontmatter absent", () => {
  const src = `# Heading\n\nparagraph.\n`;
  const doc = parse(src);
  assert.notEqual(doc.children[0]?.type, "frontmatter");
});
```

- [ ] **Step 2: Run and verify it fails**

```bash
node --import tsx --test test/parser-frontmatter-node.test.ts
```

Expected: FAIL — `frontmatter` not a valid type.

- [ ] **Step 3: Add `FrontmatterNode` to `src/ast.ts`**

After the `DocumentNode` interface, add:

```ts
export interface FrontmatterNode extends NodeBase {
  type: "frontmatter";
  /** Parsed YAML object (string keys → arbitrary values). */
  data: Record<string, unknown>;
  /** Raw frontmatter source text (between the --- fences, exclusive). */
  raw: string;
}
```

Extend the `Node` union to include `FrontmatterNode`:

```ts
export type Node =
  | DocumentNode
  | SectionNode
  | FrontmatterNode
  | ParagraphNode
  // ...rest unchanged
```

And extend `BlockNode`:

```ts
export type BlockNode = Exclude<Node, ListItemNode | FrontmatterNode>;
```

(Frontmatter is a document-level header, not a content block.)

Extend `walk` if needed — frontmatter has no children, so the existing recursion is fine. No change required.

- [ ] **Step 4: Update `extractFrontmatter` to return the raw text and line span**

Edit `src/parser.ts`. The function currently returns `{ meta, startLine }`. Change to:

```ts
function extractFrontmatter(
  lines: string[],
): { meta: Record<string, unknown>; raw: string; startLine: number; endLine: number } {
  // existing logic, plus accumulate raw text between fences and track the closing line.
  // Return endLine = index of the closing `---` line (0-based + 1 for 1-based).
  // Return raw = lines between fences joined with "\n".
  // When no frontmatter: return { meta: {}, raw: "", startLine: 0, endLine: 0 }.
}
```

Implementation note: the existing function uses `js-yaml`. Keep the yaml parse, just expand the return.

- [ ] **Step 5: Update `parse` to insert FrontmatterNode at children[0] when present**

In `parse`:

```ts
const { meta, raw, startLine, endLine: fmEnd } = extractFrontmatter(lines);
const flatChildren = parseBlocks(lines, startLine, lines.length, 0);
const children: Node[] = foldSections(flatChildren);
for (const c of children) computeSectionEndLines(c);

if (raw !== "") {
  const fmNode: FrontmatterNode = {
    type: "frontmatter",
    data: meta,
    raw,
    pos: { line: 1, column: 1 },
    endLine: fmEnd,
  };
  children.unshift(fmNode);
}

attachChapterAliases(children, meta, options.filename);
```

- [ ] **Step 6: Add no-op switch cases to each renderer**

For `src/renderer-json.ts` — frontmatter already gets serialized via `meta`; the JSON renderer can pass through `FrontmatterNode` like other nodes. Add a case to the node-dispatch switch that emits the node as-is.

For `src/renderer-html.ts` — frontmatter is metadata, NOT rendered. Add `case "frontmatter": return "";`.

For `src/renderer-llm.ts` — frontmatter is metadata. Add `case "frontmatter": return "";`.

For `src/renderer-noma.ts` — round-trip MUST emit `---\n{raw}\n---\n` for FrontmatterNode. Add:

```ts
case "frontmatter":
  return `---\n${node.raw}\n---\n`;
```

- [ ] **Step 7: Run test and verify pass**

```bash
node --import tsx --test test/parser-frontmatter-node.test.ts
```

Expected: PASS.

- [ ] **Step 8: Run full suite — roundtrip and renderer tests**

```bash
npm test
```

Expected: all pass. Roundtrip test (`test/roundtrip.test.ts`) MUST still pass with the new FrontmatterNode in children.

- [ ] **Step 9: Commit**

```bash
git add src/ast.ts src/parser.ts src/renderer-*.ts test/parser-frontmatter-node.test.ts
git commit -m "feat(ast,parser): explicit FrontmatterNode with raw text + span"
```

---

### Task 3: Section-id collision suffixing

**Files:**
- Modify: `src/parser.ts` (function `foldSections` or wherever section IDs are assigned)
- Test: `test/parser-section-id-collision.test.ts` (new)

- [ ] **Step 1: Write the failing test**

Create `test/parser-section-id-collision.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { parse } from "../src/parser.js";

test("duplicate-slug headings get suffixed -2, -3, …", () => {
  const src = `# Risks

text 1.

# Risks

text 2.

# Risks

text 3.
`;
  const doc = parse(src);
  const sections = doc.children.filter((n) => n.type === "section");
  assert.equal(sections.length, 3);
  assert.equal(sections[0]?.id, "risks");
  assert.equal(sections[1]?.id, "risks-2");
  assert.equal(sections[2]?.id, "risks-3");
});

test("explicit {id=} override is not suffixed even on collision", () => {
  const src = `# A {id="x"}

text.

# B {id="x"}

text.
`;
  const doc = parse(src);
  const sections = doc.children.filter((n) => n.type === "section");
  assert.equal(sections[0]?.id, "x");
  assert.equal(sections[1]?.id, "x");
  // (validator emits duplicate-id diagnostic — tested separately in validator tests)
});
```

- [ ] **Step 2: Run, verify fails**

Expected: FAIL — current parser does not suffix.

- [ ] **Step 3: Implement collision suffixing**

In `src/parser.ts`, the section ID is set via slugify on the heading text (no `{id=}` override). Add a `seen: Set<string>` accumulator during section folding:

```ts
function foldSections(flat: Node[]): Node[] {
  const seenSlugSections = new Set<string>();
  // ... existing fold logic; when assigning a section.id that came from slugify (NOT explicit override):
  //   if (seenSlugSections.has(slug)) {
  //     let n = 2;
  //     while (seenSlugSections.has(`${slug}-${n}`)) n++;
  //     section.id = `${slug}-${n}`;
  //   } else {
  //     section.id = slug;
  //   }
  //   seenSlugSections.add(section.id);
}
```

Important: track only slug-derived IDs. Explicit `{id="x"}` overrides are NOT suffixed (the validator handles that case via the `duplicate-id` diagnostic — see Task 7).

- [ ] **Step 4: Run test, verify pass**

Expected: both tests pass.

- [ ] **Step 5: Run full suite**

Expected: all pass. Existing example documents must keep their stable IDs — if any break, investigate (probably an example that accidentally had duplicate headings).

- [ ] **Step 6: Commit**

```bash
git add src/parser.ts test/parser-section-id-collision.test.ts
git commit -m "feat(parser): suffix duplicate-slug section IDs as -2, -3, …"
```

---

### Task 4: Parser fence bug — `::` inside fenced code suppressed (PLAN.md §24.9)

**Files:**
- Modify: `src/parser.ts` (function `parseBlocks`)
- Test: `test/parser-fence-suppression.test.ts` (new)

- [ ] **Step 1: Write the failing test**

Create `test/parser-fence-suppression.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { parse } from "../src/parser.js";

test("`::` inside fenced code does NOT close the parent directive", () => {
  const src = `::card{id="c"}
\`\`\`
::not-a-directive
::
\`\`\`
::
`;
  const doc = parse(src);
  const card = doc.children.find((n) => n.type === "directive" && n.id === "c");
  assert.ok(card, "card should exist");
  // The card MUST contain a CodeNode whose content includes the literal '::not-a-directive' lines.
  const card2 = card as { children?: any[] };
  const code = card2.children?.find((c: any) => c.type === "code");
  assert.ok(code, "card should contain a code node");
  assert.match(code.content, /::not-a-directive/);
  assert.match(code.content, /^::$/m);
});

test("`::` inside fenced code at top level does not start a directive", () => {
  const src = `\`\`\`
::card
content
::
\`\`\`
`;
  const doc = parse(src);
  // Top-level child should be a CodeNode, not a DirectiveNode.
  const first = doc.children[0];
  assert.equal(first?.type, "code");
});
```

- [ ] **Step 2: Run, verify fails**

Expected: FAIL — the parser currently treats `::` lines inside fenced code as block boundaries.

- [ ] **Step 3: Fix `parseBlocks` to suppress directive recognition inside open fences**

In `src/parser.ts`, when entering a fenced-code block (line matches `FENCE_RE`), accumulate lines into the code body until a matching close fence, IGNORING `DIRECTIVE_OPEN_RE`, `DIRECTIVE_CLOSE_RE`, `HEADING_RE`, and every other block-level pattern. Only the fence-close regex applies.

This likely means restructuring the loop in `parseBlocks` so the fenced-code branch consumes lines greedily until close, rather than dispatching per-line through the same regex sieve. Reference: the FENCE_RE pattern is `^```(\w*)\s*$` at line 27.

- [ ] **Step 4: Run test, verify pass**

Expected: PASS.

- [ ] **Step 5: Run full suite — check examples still render**

```bash
npm test && npm run render:examples && npm run render:docs
```

Expected: all pass; no example output drifts.

- [ ] **Step 6: Commit**

```bash
git add src/parser.ts test/parser-fence-suppression.test.ts
git commit -m "fix(parser): suppress directive recognition inside fenced code (PLAN §24.9)"
```

---

## 1B-2 — Validator updates

### Task 5: Validator emits `duplicate-id` diagnostic for explicit id collisions

**Files:**
- Modify: `src/validator.ts`
- Test: `test/validator-duplicate-id.test.ts` (new)

- [ ] **Step 1: Write the failing test**

Create `test/validator-duplicate-id.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { parse } from "../src/parser.js";
import { validate } from "../src/validator.js";

test("explicit duplicate IDs emit duplicate-id error diagnostic", () => {
  const src = `::claim{id="x"}\na\n::\n\n::claim{id="x"}\nb\n::\n`;
  const doc = parse(src);
  const diags = validate(doc);
  const dup = diags.filter((d) => d.code === "duplicate-id");
  assert.ok(dup.length >= 1, "expected at least one duplicate-id diagnostic");
  assert.equal(dup[0]?.severity, "error");
});

test("no duplicate-id when slug-derived IDs were already suffixed", () => {
  const src = `# Risks\n\na\n\n# Risks\n\nb\n`;
  const doc = parse(src);
  const diags = validate(doc);
  const dup = diags.filter((d) => d.code === "duplicate-id");
  assert.equal(dup.length, 0, "suffixed slug IDs should not trigger duplicate-id");
});
```

- [ ] **Step 2: Run, verify fails**

Expected: FAIL — validator does not yet emit this diagnostic code.

- [ ] **Step 3: Add the rule to `src/validator.ts`**

Walk the document, accumulate seen `id`s. When a duplicate is encountered, emit:

```ts
{
  severity: "error",
  code: "duplicate-id",
  message: `Duplicate block id "${id}"`,
  nodeId: id,
  pos: node.pos,
}
```

Important: only check **canonical** `id`s, not aliases (per design doc §3.2 — aliases are resolution aids, not identity).

- [ ] **Step 4: Run test, verify pass**

Expected: PASS.

- [ ] **Step 5: Run full suite**

Expected: all pass. If any example doc now flags duplicate-id, investigate.

- [ ] **Step 6: Commit**

```bash
git add src/validator.ts test/validator-duplicate-id.test.ts
git commit -m "feat(validator): emit duplicate-id error diagnostic"
```

---

## 1B-3 — Patch error taxonomy (§3.15)

### Task 6: Refactor `PatchError` to carry a `code` field from the locked taxonomy

**Files:**
- Modify: `src/patch.ts` (class `PatchError`, all `throw new PatchError(...)` sites)
- Test: `test/patch-error-codes.test.ts` (new)

- [ ] **Step 1: Write the failing test**

Create `test/patch-error-codes.test.ts`:

```ts
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
```

- [ ] **Step 2: Run, verify fails**

Expected: all 5 tests FAIL — `code` field not present on PatchError.

- [ ] **Step 3: Extend `PatchError` class**

In `src/patch.ts`:

```ts
export type PatchErrorCode =
  | "target_missing"
  | "parent_missing"
  | "id_conflict"
  | "invalid_content"
  | "id_attribute_protected"
  | "sha_mismatch"
  | "pre_validation_blocked"
  | "op_list_aborted"
  | "unsupported_op";

export class PatchError extends Error {
  constructor(
    public readonly code: PatchErrorCode,
    message: string,
    public readonly op: PatchOp,
  ) {
    super(message);
    this.name = "PatchError";
  }
}
```

- [ ] **Step 4: Update every existing throw site in `src/patch.ts`**

Search the file for `throw new PatchError(` and add the correct code as the first arg. Common sites:
- "not found" → `target_missing`
- "parent not found" or `add_block` resolution failure → `parent_missing`
- "id already exists" → `id_conflict`
- key === "id" guard in `update_attribute` → `id_attribute_protected`
- content parse failure in `replace_block`/`add_block` → `invalid_content`

- [ ] **Step 5: Run new + existing tests**

```bash
npm test
```

Expected: all pass. The new test file passes; existing tests still pass because the constructor signature change is fully backward at the message level.

- [ ] **Step 6: Commit**

```bash
git add src/patch.ts test/patch-error-codes.test.ts
git commit -m "feat(patch): PatchError carries machine-readable code field (§3.15 taxonomy)"
```

---

## 1B-4 — Transcript writer rewrite (§3.5)

### Task 7: Define the v1.0 TranscriptLine type

**Files:**
- Modify: `packages/mcp-server/src/transcript.ts`
- Test: existing `packages/mcp-server/test/transcript.test.ts` (or new if missing)

- [ ] **Step 1: Replace the contents of `packages/mcp-server/src/transcript.ts`**

```ts
import { appendFileSync } from "node:fs";
import type { PatchOp } from "@noma/cli";
import type { Diagnostic } from "@noma/cli";

export type ValidationSummary = "ok" | "warn" | "error";
export type PatchResult = "applied" | "rejected" | "noop";

export interface TranscriptActor {
  kind: "human" | "agent" | "tool";
  name: string;
  model?: string;
  version?: string;
}

export interface TranscriptSignature {
  algorithm: string;
  key_id: string;
  value: string;
}

export interface TranscriptLine {
  protocol_version: "1.0";
  tool_version: string;
  op_id: string;
  ts: string;
  actor: TranscriptActor;
  doc_uri: string;
  pre_sha256: string;
  post_sha256: string;
  pre_sha: string;   // 8-char display, derived from pre_sha256
  post_sha: string;
  op: PatchOp;
  patch_result: PatchResult;
  pre_validation: ValidationSummary;
  post_validation: ValidationSummary;

  reason?: string;
  parent_op_id?: string;
  base_sha256?: string;
  diagnostics?: TranscriptDiagnostic[];
  elapsed_ms?: number;
  prev_entry_sha256?: string;
  signature?: null | TranscriptSignature;
}

export interface TranscriptDiagnostic extends Diagnostic {
  phase: "pre" | "post";
}

export function appendTranscript(path: string, line: TranscriptLine): void {
  appendFileSync(path, JSON.stringify(line) + "\n", "utf8");
}
```

Note: this removes the `v: 1` field. Phase 0 transcripts are not v1.0 (see design doc §3.5 "Phase 0 migration").

- [ ] **Step 2: Run typecheck**

```bash
npx tsc --noEmit
```

Expected: FAIL with errors in `packages/mcp-server/src/tools/patch-block.ts` — that's the next task. Confirm errors are limited to that file.

- [ ] **Step 3: Commit (type-only change, deliberately broken until Task 8)**

```bash
git add packages/mcp-server/src/transcript.ts
git commit -m "feat(mcp-server): v1.0 transcript schema types (patch-block.ts intentionally broken until Task 8)"
```

---

### Task 8: Rewrite `patch_block` to emit v1.0 transcript

**Files:**
- Modify: `packages/mcp-server/src/tools/patch-block.ts`
- Modify: `packages/mcp-server/src/index.ts` (pass actor identity through if needed)
- Modify: `packages/mcp-server/test/patch-block.test.ts`
- Modify: `packages/mcp-server/package.json` — confirm `version` matches (or read at runtime)

- [ ] **Step 1: Update `packages/mcp-server/src/tools/patch-block.ts`**

Replace the existing implementation. Key changes:

```ts
import { readFileSync, writeFileSync, renameSync, unlinkSync } from "node:fs";
import { dirname, resolve as resolvePath } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { pathToFileURL } from "node:url";
import { parse, patchSource, validate, isBookManifestPath, PatchError } from "@noma/cli";
import type { Diagnostic, PatchOp } from "@noma/cli";
import { sha256hex } from "../sha.js";
import { appendTranscript } from "../transcript.js";
import { summarizeValidation } from "./validate-doc.js";
import type {
  TranscriptLine,
  TranscriptDiagnostic,
  PatchResult,
  TranscriptActor,
  ValidationSummary,
} from "../transcript.js";

const MAX_CONTENT_BYTES = 1_000_000;

// Read tool version from this package's package.json at startup.
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);
const TOOL_VERSION: string = (require("../../package.json") as { version: string }).version;

export interface PatchBlockArgs {
  file: string;
  op: PatchOp;
  reason?: string;
  expected_sha?: string;
  actor?: TranscriptActor;
  base_sha256?: string;
  parent_op_id?: string;
}

type PatchBlockResult =
  | {
      ok: true;
      post_validation: ValidationSummary;
      transcript_entry: TranscriptLine;
      diagnostics: Diagnostic[];
    }
  | { ok: false; error: string; code?: string; system?: true };

function defaultActor(): TranscriptActor {
  return { kind: "agent", name: "unknown" };
}

function toTranscriptDiagnostics(diags: Diagnostic[], phase: "pre" | "post"): TranscriptDiagnostic[] {
  return diags.map((d) => ({ ...d, phase }));
}

export function patchBlock(args: PatchBlockArgs): PatchBlockResult {
  const start = Date.now();
  const { file, op, reason, expected_sha, actor = defaultActor(), base_sha256, parent_op_id } = args;
  const op_id = randomUUID();
  const ts = new Date().toISOString();
  const doc_uri = pathToFileURL(resolvePath(file)).toString();

  if (isBookManifestPath(file)) {
    return { ok: false, error: "book manifests are not supported by patch_block", code: "unsupported_op", system: true };
  }

  if ("content" in op && typeof op.content === "string" && Buffer.byteLength(op.content, "utf8") > MAX_CONTENT_BYTES) {
    return { ok: false, error: "content_too_large", code: "invalid_content" };
  }

  let source: string;
  try {
    source = readFileSync(file, "utf8");
  } catch (e) {
    return { ok: false, error: String(e), system: true };
  }

  const preBytes = Buffer.from(source, "utf8");
  const pre_sha256 = sha256hex(preBytes);
  const pre_sha = pre_sha256.slice(0, 8);

  // expected_sha (Phase 0 compat) — 8-char display; mismatch = sha_mismatch rejected record.
  if (expected_sha !== undefined && expected_sha !== pre_sha) {
    const rejected: TranscriptLine = {
      protocol_version: "1.0",
      tool_version: TOOL_VERSION,
      op_id,
      ts,
      actor,
      doc_uri,
      pre_sha256,
      post_sha256: pre_sha256,
      pre_sha,
      post_sha: pre_sha,
      op,
      patch_result: "rejected",
      pre_validation: "ok",
      post_validation: "ok",
      diagnostics: [{ phase: "pre", severity: "error", code: "sha_mismatch", message: "expected_sha did not match pre_sha" }],
      ...(reason ? { reason } : {}),
      ...(parent_op_id ? { parent_op_id } : {}),
      elapsed_ms: Date.now() - start,
    };
    try { appendTranscript(file + ".patches", rejected); } catch {}
    return { ok: false, error: "sha_mismatch", code: "sha_mismatch" };
  }

  const preDoc = parse(source);
  const preDiagnostics = validate(preDoc);
  const pre_validation = summarizeValidation(preDiagnostics);

  let patched: string;
  try {
    patched = patchSource(source, op);
  } catch (e) {
    if (e instanceof PatchError) {
      const rejected: TranscriptLine = {
        protocol_version: "1.0",
        tool_version: TOOL_VERSION,
        op_id,
        ts,
        actor,
        doc_uri,
        pre_sha256,
        post_sha256: pre_sha256,
        pre_sha,
        post_sha: pre_sha,
        op,
        patch_result: "rejected",
        pre_validation,
        post_validation: pre_validation,
        diagnostics: [
          ...toTranscriptDiagnostics(preDiagnostics, "pre"),
          { phase: "pre", severity: "error", code: e.code, message: e.message },
        ],
        ...(reason ? { reason } : {}),
        ...(parent_op_id ? { parent_op_id } : {}),
        ...(base_sha256 ? { base_sha256 } : {}),
        elapsed_ms: Date.now() - start,
      };
      try { appendTranscript(file + ".patches", rejected); } catch {}
      return { ok: false, error: e.message, code: e.code };
    }
    return { ok: false, error: String(e) };
  }

  const postBytes = Buffer.from(patched, "utf8");
  const post_sha256 = sha256hex(postBytes);
  const post_sha = post_sha256.slice(0, 8);
  const noop = pre_sha256 === post_sha256;

  if (!noop) {
    const tmp = `${dirname(file)}/.noma-patch-${randomBytes(6).toString("hex")}.tmp`;
    try {
      writeFileSync(tmp, patched, "utf8");
      renameSync(tmp, file);
    } catch (e) {
      try { unlinkSync(tmp); } catch {}
      return { ok: false, error: String(e), system: true };
    }
  }

  const postDoc = parse(patched);
  const postDiagnostics = validate(postDoc);
  const post_validation = summarizeValidation(postDiagnostics);
  const patch_result: PatchResult = noop ? "noop" : "applied";

  const diagnostics: TranscriptDiagnostic[] = [
    ...toTranscriptDiagnostics(preDiagnostics, "pre"),
    ...toTranscriptDiagnostics(postDiagnostics, "post"),
  ];

  if (base_sha256 && base_sha256 !== pre_sha256) {
    diagnostics.push({
      phase: "pre",
      severity: "warning",
      code: "base_sha_drift",
      message: "base_sha256 differs from pre_sha256; agent may have edited stale state",
    });
  }

  const transcript_entry: TranscriptLine = {
    protocol_version: "1.0",
    tool_version: TOOL_VERSION,
    op_id,
    ts,
    actor,
    doc_uri,
    pre_sha256,
    post_sha256,
    pre_sha,
    post_sha,
    op,
    patch_result,
    pre_validation,
    post_validation,
    ...(diagnostics.length ? { diagnostics } : {}),
    ...(reason ? { reason } : {}),
    ...(parent_op_id ? { parent_op_id } : {}),
    ...(base_sha256 ? { base_sha256 } : {}),
    elapsed_ms: Date.now() - start,
  };

  try { appendTranscript(file + ".patches", transcript_entry); } catch {}

  return { ok: true, post_validation, transcript_entry, diagnostics: postDiagnostics };
}
```

- [ ] **Step 2: Update `packages/mcp-server/src/index.ts` to accept actor + base_sha256 + parent_op_id in the MCP tool schema**

Locate the `patch_block` `server.tool(...)` call. Extend the input schema:

```ts
server.tool(
  "patch_block",
  "...existing description...",
  {
    file: z.string().describe("Absolute path to the .noma file"),
    op: PatchOpSchema.describe("Patch operation to apply"),
    reason: z.string().optional().describe("Agent-provided justification"),
    expected_sha: z.string().length(8).optional().describe("SHA-256[:8] of file before patch"),
    actor: z.object({
      kind: z.enum(["human", "agent", "tool"]),
      name: z.string(),
      model: z.string().optional(),
      version: z.string().optional(),
    }).optional().describe("Caller identity recorded in transcript"),
    base_sha256: z.string().length(64).optional().describe("SHA-256 of doc state agent prepared against; mismatch surfaces base_sha_drift warning"),
    parent_op_id: z.string().uuid().optional().describe("Previous op_id for causation chains"),
  },
  async ({ file, op, reason, expected_sha, actor, base_sha256, parent_op_id }) => {
    const result = patchBlock({ file, op: op as PatchOp, reason, expected_sha, actor, base_sha256, parent_op_id });
    // ...existing result mapping
  },
);
```

- [ ] **Step 3: Update existing patch-block tests**

In `packages/mcp-server/test/patch-block.test.ts`, every assertion against the old `TranscriptLine` shape (e.g., `assert.equal(entry.v, 1)`) needs updating. Change:
- `entry.v` → assert `entry.protocol_version === "1.0"`
- `entry.agent` (string) → `entry.actor.name`, `entry.actor.kind`
- New required fields: `op_id`, `tool_version`, `doc_uri`, `pre_sha256` (full), `post_sha256`, `patch_result`
- Add a test for `noop` result (apply an `update_attribute` setting a key to its current value, assert `patch_result === "noop"` and no file modification).
- Add a test for `rejected` result (apply a `delete_block` with a missing id, assert `patch_result === "rejected"` and `diagnostics[*].code === "target_missing"`).

- [ ] **Step 4: Run typecheck + tests**

```bash
npx tsc --noEmit && npm test
```

Expected: all pass.

- [ ] **Step 5: Commit**

```bash
git add packages/mcp-server/src/tools/patch-block.ts packages/mcp-server/src/index.ts packages/mcp-server/test/patch-block.test.ts
git commit -m "feat(mcp-server): emit v1.0 transcript with actor/op_id/full hashes/patch_result"
```

---

## 1B-5 — `noma verify` CLI + minimum conformance corpus (§3.10, §3.17)

### Task 9: `noma verify` CLI — scaffold

**Files:**
- Create: `src/verify.ts`
- Modify: `src/cli.ts` (add `verify` subcommand)
- Modify: `src/cli.ts` HELP string
- Test: `test/verify-cli.test.ts` (new)

- [ ] **Step 1: Write the failing test**

Create `test/verify-cli.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { verifyFixtureDir } from "../src/verify.js";
import { mkdtempSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("verifyFixtureDir returns success for a trivial valid fixture", () => {
  const dir = mkdtempSync(join(tmpdir(), "noma-verify-"));
  try {
    const fixDir = join(dir, "valid/basic");
    mkdirSync(fixDir, { recursive: true });
    writeFileSync(join(fixDir, "input.noma"), `# Hello\n\nparagraph.\n`);
    writeFileSync(join(fixDir, "expected.ids.json"), JSON.stringify({
      canonical: ["hello"],
      aliases: {},
    }));
    writeFileSync(join(fixDir, "expected.diagnostics.json"), JSON.stringify([]));
    writeFileSync(join(fixDir, "expected.roundtrip.noma"), `# Hello\n\nparagraph.\n`);
    const report = verifyFixtureDir(dir);
    assert.equal(report.ok, true);
    assert.equal(report.fixtures.length, 1);
    assert.equal(report.fixtures[0]?.status, "pass");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("verifyFixtureDir fails when expected.ids.json mismatches", () => {
  const dir = mkdtempSync(join(tmpdir(), "noma-verify-"));
  try {
    const fixDir = join(dir, "valid/basic");
    mkdirSync(fixDir, { recursive: true });
    writeFileSync(join(fixDir, "input.noma"), `# Hello\n\nparagraph.\n`);
    writeFileSync(join(fixDir, "expected.ids.json"), JSON.stringify({
      canonical: ["wrong-id"],
      aliases: {},
    }));
    writeFileSync(join(fixDir, "expected.diagnostics.json"), JSON.stringify([]));
    writeFileSync(join(fixDir, "expected.roundtrip.noma"), `# Hello\n\nparagraph.\n`);
    const report = verifyFixtureDir(dir);
    assert.equal(report.ok, false);
    assert.equal(report.fixtures[0]?.status, "fail");
    assert.match(report.fixtures[0]?.error ?? "", /ids/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run, verify fails (module doesn't exist)**

Expected: FAIL.

- [ ] **Step 3: Create `src/verify.ts`**

```ts
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, relative } from "node:path";
import { parse } from "./parser.js";
import { renderNoma } from "./renderer-noma.js";
import { validate } from "./validator.js";
import { walk } from "./ast.js";

export interface FixtureReport {
  name: string;
  status: "pass" | "fail" | "skip";
  error?: string;
}

export interface VerifyReport {
  ok: boolean;
  fixtures: FixtureReport[];
}

function listFixtures(root: string): string[] {
  const out: string[] = [];
  const walkDir = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const p = join(dir, entry);
      const s = statSync(p);
      if (s.isDirectory()) {
        if (existsSync(join(p, "input.noma"))) {
          out.push(p);
        } else {
          walkDir(p);
        }
      }
    }
  };
  walkDir(root);
  return out.sort();
}

function checkIds(doc: ReturnType<typeof parse>, expectedPath: string): string | null {
  const expected = JSON.parse(readFileSync(expectedPath, "utf8")) as {
    canonical: string[];
    aliases: Record<string, string[]>;
  };
  const canonical: string[] = [];
  const aliases: Record<string, string[]> = {};
  for (const node of walk(doc)) {
    if ("id" in node && node.id) {
      canonical.push(node.id);
      if (node.aliases?.length) aliases[node.id] = [...node.aliases];
    }
  }
  if (JSON.stringify(canonical.sort()) !== JSON.stringify([...expected.canonical].sort())) {
    return `ids mismatch: got ${JSON.stringify(canonical)}, expected ${JSON.stringify(expected.canonical)}`;
  }
  for (const k of Object.keys(expected.aliases)) {
    if (JSON.stringify((aliases[k] ?? []).sort()) !== JSON.stringify([...expected.aliases[k]!].sort())) {
      return `aliases mismatch for ${k}`;
    }
  }
  return null;
}

function checkDiagnostics(doc: ReturnType<typeof parse>, expectedPath: string): string | null {
  const expected = JSON.parse(readFileSync(expectedPath, "utf8")) as { code: string; severity: string }[];
  const got = validate(doc).map((d) => ({ code: d.code, severity: d.severity }));
  const norm = (xs: { code: string; severity: string }[]) =>
    xs.map((x) => `${x.severity}:${x.code}`).sort();
  if (JSON.stringify(norm(got)) !== JSON.stringify(norm(expected))) {
    return `diagnostics mismatch: got ${JSON.stringify(got)}, expected ${JSON.stringify(expected)}`;
  }
  return null;
}

function checkRoundtrip(source: string, expectedPath: string): string | null {
  const doc = parse(source);
  const rendered = renderNoma(doc);
  const expected = readFileSync(expectedPath, "utf8");
  if (rendered !== expected) {
    return `roundtrip mismatch: render-noma output differs from expected.roundtrip.noma`;
  }
  // Property: re-parse rendered output equals original parse (structural equality)
  const reparsed = parse(rendered);
  if (JSON.stringify(reparsed) !== JSON.stringify(doc)) {
    return `roundtrip property failed: parse(render-noma(parse(x))) !== parse(x)`;
  }
  return null;
}

function checkOne(fixturePath: string): FixtureReport {
  const name = relative(process.cwd(), fixturePath);
  const inputPath = join(fixturePath, "input.noma");
  const source = readFileSync(inputPath, "utf8");
  const doc = parse(source);

  const idsPath = join(fixturePath, "expected.ids.json");
  if (existsSync(idsPath)) {
    const err = checkIds(doc, idsPath);
    if (err) return { name, status: "fail", error: err };
  }
  const diagsPath = join(fixturePath, "expected.diagnostics.json");
  if (existsSync(diagsPath)) {
    const err = checkDiagnostics(doc, diagsPath);
    if (err) return { name, status: "fail", error: err };
  }
  const rtPath = join(fixturePath, "expected.roundtrip.noma");
  if (existsSync(rtPath)) {
    const err = checkRoundtrip(source, rtPath);
    if (err) return { name, status: "fail", error: err };
  }
  return { name, status: "pass" };
}

export function verifyFixtureDir(root: string): VerifyReport {
  const fixtures = listFixtures(root).map(checkOne);
  return { ok: fixtures.every((f) => f.status === "pass"), fixtures };
}
```

- [ ] **Step 4: Wire CLI subcommand in `src/cli.ts`**

Add to HELP string (around line 17):

```
  noma verify <fixture-dir>                  Run conformance suite against fixtures
```

Add a dispatch case (find where `parse`, `render`, `check`, etc. are routed):

```ts
case "verify": {
  const dir = args[0];
  if (!dir) { console.error("noma verify: <fixture-dir> required"); process.exit(2); }
  const report = verifyFixtureDir(dir);
  for (const f of report.fixtures) {
    const tag = f.status === "pass" ? "PASS" : f.status === "fail" ? "FAIL" : "SKIP";
    console.log(`${tag}  ${f.name}${f.error ? `  — ${f.error}` : ""}`);
  }
  console.log(`\n${report.fixtures.length} fixtures, ${report.fixtures.filter((f) => f.status === "pass").length} passed`);
  process.exit(report.ok ? 0 : 1);
}
```

Add `import { verifyFixtureDir } from "./verify.js";` at the top.

- [ ] **Step 5: Run tests + typecheck**

```bash
npx tsc --noEmit && npm test
```

Expected: all pass.

- [ ] **Step 6: Smoke-test the CLI manually**

```bash
mkdir -p /tmp/smoke/valid/x && printf '# Hello\n\nworld.\n' > /tmp/smoke/valid/x/input.noma && npm run noma -- verify /tmp/smoke
```

Expected: `PASS /tmp/smoke/valid/x` and exit 0. (No expected files → trivially passes.)

- [ ] **Step 7: Commit**

```bash
git add src/verify.ts src/cli.ts test/verify-cli.test.ts
git commit -m "feat(verify): noma verify CLI — IDs, diagnostics, roundtrip checks"
```

---

### Task 10: `noma verify` — span fidelity check

**Files:**
- Modify: `src/verify.ts`
- Modify: `test/verify-cli.test.ts`

- [ ] **Step 1: Write the failing test**

In `test/verify-cli.test.ts`, add:

```ts
test("verifyFixtureDir checks expected.spans.json when present", () => {
  const dir = mkdtempSync(join(tmpdir(), "noma-verify-"));
  try {
    const fixDir = join(dir, "valid/spans");
    mkdirSync(fixDir, { recursive: true });
    writeFileSync(join(fixDir, "input.noma"), `# Heading\n\nparagraph.\n`);
    writeFileSync(join(fixDir, "expected.spans.json"), JSON.stringify({
      "heading": { startLine: 1, endLine: 3 },
    }));
    const report = verifyFixtureDir(dir);
    assert.equal(report.ok, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run, verify fails (or skips)**

Expected: FAIL (or unexpected pass — the span check isn't implemented).

- [ ] **Step 3: Add `checkSpans` to `src/verify.ts`**

```ts
function checkSpans(doc: ReturnType<typeof parse>, expectedPath: string): string | null {
  const expected = JSON.parse(readFileSync(expectedPath, "utf8")) as Record<string, { startLine: number; endLine: number }>;
  for (const node of walk(doc)) {
    if (!("id" in node) || !node.id) continue;
    const want = expected[node.id];
    if (!want) continue;
    const gotStart = node.pos?.line;
    const gotEnd = node.endLine;
    if (gotStart !== want.startLine || gotEnd !== want.endLine) {
      return `span mismatch for "${node.id}": got [${gotStart}, ${gotEnd}], expected [${want.startLine}, ${want.endLine}]`;
    }
  }
  return null;
}
```

Hook into `checkOne`:

```ts
const spansPath = join(fixturePath, "expected.spans.json");
if (existsSync(spansPath)) {
  const err = checkSpans(doc, spansPath);
  if (err) return { name, status: "fail", error: err };
}
```

- [ ] **Step 4: Run tests, verify pass**

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/verify.ts test/verify-cli.test.ts
git commit -m "feat(verify): expected.spans.json check for span fidelity"
```

---

### Task 11: `noma verify` — patch + transcript shape check

**Files:**
- Modify: `src/verify.ts`
- Modify: `test/verify-cli.test.ts`

- [ ] **Step 1: Write the failing test**

In `test/verify-cli.test.ts`, add:

```ts
test("verifyFixtureDir applies patch.json and checks expected.post.noma", () => {
  const dir = mkdtempSync(join(tmpdir(), "noma-verify-"));
  try {
    const fixDir = join(dir, "patch/replace");
    mkdirSync(fixDir, { recursive: true });
    writeFileSync(join(fixDir, "input.noma"), `::claim{id="x" confidence=0.5}\nhello\n::\n`);
    writeFileSync(join(fixDir, "patch.json"), JSON.stringify([
      { op: "update_attribute", id: "x", key: "confidence", value: 0.9 }
    ]));
    writeFileSync(join(fixDir, "expected.post.noma"), `::claim{id="x" confidence=0.9}\nhello\n::\n`);
    const report = verifyFixtureDir(dir);
    assert.equal(report.ok, true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
```

- [ ] **Step 2: Run, verify fails**

- [ ] **Step 3: Add `checkPatch` to `src/verify.ts`**

```ts
import { patchSource, type PatchOp } from "./patch.js";

function checkPatch(source: string, fixturePath: string): string | null {
  const patchPath = join(fixturePath, "patch.json");
  const postPath = join(fixturePath, "expected.post.noma");
  if (!existsSync(patchPath) || !existsSync(postPath)) return null;
  const raw = JSON.parse(readFileSync(patchPath, "utf8")) as PatchOp | PatchOp[];
  const ops = Array.isArray(raw) ? raw : [raw];
  let cur = source;
  for (const op of ops) {
    cur = patchSource(cur, op);
  }
  const expected = readFileSync(postPath, "utf8");
  if (cur !== expected) {
    return `patch output mismatch: got\n${cur}\n--- expected ---\n${expected}`;
  }
  return null;
}
```

Hook into `checkOne` after the existing checks. Compute over `source`, not over the parsed doc.

- [ ] **Step 4: Run tests, verify pass**

- [ ] **Step 5: Commit**

```bash
git add src/verify.ts test/verify-cli.test.ts
git commit -m "feat(verify): patch.json + expected.post.noma application check"
```

---

## 1B-6 — Build the minimum conformance corpus (§3.17)

All fixtures live under `examples/conformance/`. Each task creates one fixture directory. Tasks 12–25 are mechanical and may be parallelized across subagents.

After all 14 fixtures are in place, Task 26 wires `noma verify` into CI.

### Task 12: Fixture — `valid/basic-section`

**Files:**
- Create: `examples/conformance/valid/basic-section/input.noma`
- Create: `examples/conformance/valid/basic-section/expected.ids.json`
- Create: `examples/conformance/valid/basic-section/expected.diagnostics.json`
- Create: `examples/conformance/valid/basic-section/expected.roundtrip.noma`
- Create: `examples/conformance/valid/basic-section/expected.spans.json`

- [ ] **Step 1: Write `input.noma`**

```noma
# Risks

A paragraph about risks.
```

- [ ] **Step 2: Write `expected.ids.json`**

```json
{
  "canonical": ["risks"],
  "aliases": {}
}
```

- [ ] **Step 3: Write `expected.diagnostics.json`**

```json
[]
```

- [ ] **Step 4: Write `expected.roundtrip.noma`** — same as input (canonical render):

```noma
# Risks

A paragraph about risks.
```

- [ ] **Step 5: Write `expected.spans.json`**

```json
{
  "risks": { "startLine": 1, "endLine": 3 }
}
```

- [ ] **Step 6: Run `noma verify`**

```bash
npm run noma -- verify examples/conformance
```

Expected: `PASS examples/conformance/valid/basic-section`.

If span numbers don't match, adjust `expected.spans.json` to the actual values — the fixture documents the spec, but the spec follows the parser unless the parser is wrong (in which case fix the parser).

- [ ] **Step 7: Commit**

```bash
git add examples/conformance/valid/basic-section
git commit -m "test(conformance): valid/basic-section fixture"
```

---

### Task 13: Fixture — `valid/explicit-section`

**Files:** `examples/conformance/valid/explicit-section/{input.noma, expected.ids.json, expected.diagnostics.json, expected.roundtrip.noma}`

- [ ] **Step 1: Write `input.noma`**

```noma
::section{id="manual"}
## Inner Heading

paragraph.
::
```

NOTE: `::section` is a generic directive in current Noma — sections-from-headings are the canonical section concept. The directive happens to be named "section" but it does not behave specially. The point of this fixture: exercise an explicit `id` on a top-level directive that contains a heading-generated child section. Expected output reflects that.

- [ ] **Step 2: `expected.ids.json`**

```json
{ "canonical": ["manual", "inner-heading"], "aliases": {} }
```

- [ ] **Step 3: `expected.diagnostics.json`**

```json
[]
```

- [ ] **Step 4: `expected.roundtrip.noma`** — same as input.

- [ ] **Step 5: Verify + commit**

```bash
npm run noma -- verify examples/conformance
git add examples/conformance/valid/explicit-section
git commit -m "test(conformance): valid/explicit-section fixture"
```

---

### Task 14: Fixture — `valid/aliases`

**Files:** `examples/conformance/valid/aliases/{input.noma, expected.ids.json, expected.diagnostics.json, expected.roundtrip.noma}`

- [ ] **Step 1: Write `input.noma`**

```noma
---
title: Aliases demo
aliases: [demo, intro]
---

# Aliases

Paragraph.
```

- [ ] **Step 2: `expected.ids.json`**

```json
{
  "canonical": ["aliases"],
  "aliases": { "aliases": ["demo", "intro"] }
}
```

- [ ] **Step 3: `expected.diagnostics.json`**

```json
[]
```

- [ ] **Step 4: `expected.roundtrip.noma`** — same as input.

- [ ] **Step 5: Verify + commit**

```bash
git add examples/conformance/valid/aliases
git commit -m "test(conformance): valid/aliases fixture"
```

---

### Task 15: Fixture — `valid/inline-table`

**Files:** `examples/conformance/valid/inline-table/{input.noma, expected.ids.json, expected.diagnostics.json, expected.roundtrip.noma}`

- [ ] **Step 1: Write `input.noma`**

```noma
# Comparison

| Name | Score |
|:-----|------:|
| Alice | 92 |
| Bob   | 88 |
```

- [ ] **Step 2: `expected.ids.json`**

```json
{ "canonical": ["comparison"], "aliases": {} }
```

- [ ] **Step 3: `expected.diagnostics.json`** = `[]`.

- [ ] **Step 4: `expected.roundtrip.noma`** — match output of `noma render --to noma examples/conformance/valid/inline-table/input.noma` (run it, paste exact output).

- [ ] **Step 5: Verify + commit**

```bash
git add examples/conformance/valid/inline-table
git commit -m "test(conformance): valid/inline-table fixture"
```

---

### Task 16: Fixture — `valid/code-fence-with-colons`

**Files:** `examples/conformance/valid/code-fence-with-colons/{input.noma, expected.ids.json, expected.diagnostics.json, expected.roundtrip.noma}`

This fixture exercises the §3.9 rule fixed in Task 4.

- [ ] **Step 1: Write `input.noma`**

````noma
# Demo

```
::not-a-directive{id="x"}
inside code
::
```

After the fence.
````

- [ ] **Step 2: `expected.ids.json`**

```json
{ "canonical": ["demo"], "aliases": {} }
```

(NB: NO id for "not-a-directive" — it's suppressed inside the code fence.)

- [ ] **Step 3: `expected.diagnostics.json`** = `[]`.

- [ ] **Step 4: `expected.roundtrip.noma`** — same as input.

- [ ] **Step 5: Verify + commit**

```bash
git add examples/conformance/valid/code-fence-with-colons
git commit -m "test(conformance): valid/code-fence-with-colons fixture"
```

---

### Task 17: Fixture — `valid/frontmatter-only`

**Files:** `examples/conformance/valid/frontmatter-only/{input.noma, expected.ids.json, expected.diagnostics.json, expected.roundtrip.noma, expected.spans.json}`

- [ ] **Step 1: Write `input.noma`**

```noma
---
title: Only frontmatter
---
```

- [ ] **Step 2: `expected.ids.json`**

```json
{ "canonical": [], "aliases": {} }
```

- [ ] **Step 3: `expected.diagnostics.json`** = `[]`.

- [ ] **Step 4: `expected.roundtrip.noma`** — same as input.

- [ ] **Step 5: `expected.spans.json`** — frontmatter has no id, so the file documents the doc-level span via comment only. Use:

```json
{}
```

(Or extend `expected.spans.json` to support a `"__document__"` synthetic key — if you do, update `src/verify.ts` Task 10 to read it. Default: empty object means no spans asserted; the fixture is exercising "frontmatter parses without error" only.)

- [ ] **Step 6: Verify + commit**

```bash
git add examples/conformance/valid/frontmatter-only
git commit -m "test(conformance): valid/frontmatter-only fixture"
```

---

### Task 18: Fixture — `patch/replace_block`

**Files:** `examples/conformance/patch/replace_block/{input.noma, patch.json, expected.post.noma}`

- [ ] **Step 1: Write `input.noma`**

```noma
::claim{id="c1" confidence=0.5}
Old body.
::
```

- [ ] **Step 2: Write `patch.json`**

```json
{ "op": "replace_block", "id": "c1", "content": "::claim{id=\"c1\" confidence=0.9}\nNew body.\n::" }
```

- [ ] **Step 3: Write `expected.post.noma`**

```noma
::claim{id="c1" confidence=0.9}
New body.
::
```

- [ ] **Step 4: Verify + commit**

```bash
npm run noma -- verify examples/conformance
git add examples/conformance/patch/replace_block
git commit -m "test(conformance): patch/replace_block fixture"
```

---

### Task 19: Fixture — `patch/add_block`

**Files:** `examples/conformance/patch/add_block/{input.noma, patch.json, expected.post.noma}`

- [ ] **Step 1: `input.noma`**

```noma
::section{id="risks" level=2}
::risk{id="r1" severity="low"}
First risk.
::
::
```

- [ ] **Step 2: `patch.json`**

```json
{ "op": "add_block", "parent": "risks", "position": 0, "content": "::risk{id=\"r0\" severity=\"high\"}\nNew top risk.\n::" }
```

- [ ] **Step 3: `expected.post.noma`**

```noma
::section{id="risks" level=2}
::risk{id="r0" severity="high"}
New top risk.
::
::risk{id="r1" severity="low"}
First risk.
::
::
```

- [ ] **Step 4: Verify + commit**

```bash
git add examples/conformance/patch/add_block
git commit -m "test(conformance): patch/add_block fixture"
```

---

### Task 20: Fixture — `patch/delete_block`

**Files:** `examples/conformance/patch/delete_block/{input.noma, patch.json, expected.post.noma}`

- [ ] **Step 1: `input.noma`**

```noma
::claim{id="keep"}
Keep.
::

::claim{id="drop"}
Drop.
::
```

- [ ] **Step 2: `patch.json`**

```json
{ "op": "delete_block", "id": "drop" }
```

- [ ] **Step 3: `expected.post.noma`**

```noma
::claim{id="keep"}
Keep.
::
```

(Note: the blank line + dropped block disappear; if your `patchSource` preserves the trailing blank, adjust `expected.post.noma` to match shipped behavior.)

- [ ] **Step 4: Verify + commit**

```bash
git add examples/conformance/patch/delete_block
git commit -m "test(conformance): patch/delete_block fixture"
```

---

### Task 21: Fixture — `patch/update_attribute`

**Files:** `examples/conformance/patch/update_attribute/{input.noma, patch.json, expected.post.noma}`

- [ ] **Step 1: `input.noma`**

```noma
::claim{id="x" confidence=0.5}
body
::
```

- [ ] **Step 2: `patch.json`**

```json
{ "op": "update_attribute", "id": "x", "key": "confidence", "value": 0.95 }
```

- [ ] **Step 3: `expected.post.noma`**

```noma
::claim{id="x" confidence=0.95}
body
::
```

- [ ] **Step 4: Verify + commit**

```bash
git add examples/conformance/patch/update_attribute
git commit -m "test(conformance): patch/update_attribute fixture"
```

---

### Task 22: Fixture — `patch/rename_id`

**Files:** `examples/conformance/patch/rename_id/{input.noma, patch.json, expected.post.noma}`

This fixture is critical: it pins down §3.3 (retargets refs and wikilinks; does NOT touch aliases attribute).

- [ ] **Step 1: `input.noma`**

```noma
::claim{id="old" aliases="legacy"}
the claim.
::

::evidence{for="old"}
supports it.
::

See [[old]].
```

- [ ] **Step 2: `patch.json`**

```json
{ "op": "rename_id", "from": "old", "to": "new" }
```

- [ ] **Step 3: `expected.post.noma`**

```noma
::claim{id="new" aliases="legacy"}
the claim.
::

::evidence{for="new"}
supports it.
::

See [[new]].
```

NOTE: `aliases="legacy"` is unchanged. The `for=` ref and `[[old]]` wikilink are rewritten. This is exactly the §3.3 contract.

- [ ] **Step 4: Verify + commit**

```bash
git add examples/conformance/patch/rename_id
git commit -m "test(conformance): patch/rename_id fixture (pins §3.3 alias-attribute contract)"
```

---

### Task 23: Fixture — `patch/replay-chain`

**Files:** `examples/conformance/patch/replay-chain/{input.noma, patch.json, expected.post.noma}`

Exercises multi-op atomicity + replay equivalence.

- [ ] **Step 1: `input.noma`**

```noma
::claim{id="c1" confidence=0.5}
body.
::
```

- [ ] **Step 2: `patch.json`** — three sequential ops

```json
[
  { "op": "update_attribute", "id": "c1", "key": "confidence", "value": 0.8 },
  { "op": "rename_id", "from": "c1", "to": "c2" },
  { "op": "update_attribute", "id": "c2", "key": "confidence", "value": 0.9 }
]
```

- [ ] **Step 3: `expected.post.noma`**

```noma
::claim{id="c2" confidence=0.9}
body.
::
```

- [ ] **Step 4: Verify + commit**

```bash
git add examples/conformance/patch/replay-chain
git commit -m "test(conformance): patch/replay-chain fixture (atomic 3-op list)"
```

---

### Task 24: Fixture — `invalid/duplicate-id`

**Files:** `examples/conformance/invalid/duplicate-id/{input.noma, expected.diagnostics.json}`

(No `expected.ids.json` — duplicate ids; the validator's job is to flag, not to enumerate.)

- [ ] **Step 1: `input.noma`**

```noma
::claim{id="x"}
first.
::

::claim{id="x"}
second.
::
```

- [ ] **Step 2: `expected.diagnostics.json`**

```json
[ { "severity": "error", "code": "duplicate-id" } ]
```

(Only one diagnostic expected — the validator reports the duplicate once. If the implementation emits two, update the fixture.)

- [ ] **Step 3: Verify + commit**

```bash
npm run noma -- verify examples/conformance
git add examples/conformance/invalid/duplicate-id
git commit -m "test(conformance): invalid/duplicate-id fixture"
```

---

### Task 25: Fixture — `invalid/missing-evidence-target`

**Files:** `examples/conformance/invalid/missing-evidence-target/{input.noma, expected.diagnostics.json}`

- [ ] **Step 1: `input.noma`**

```noma
::evidence{for="claim-that-does-not-exist"}
floating evidence.
::
```

- [ ] **Step 2: `expected.diagnostics.json`**

```json
[ { "severity": "error", "code": "broken-reference" } ]
```

(If the validator uses a different code for missing-target references, replace `broken-reference` with the actual one — discover via `npm run noma -- check examples/conformance/invalid/missing-evidence-target/input.noma`.)

- [ ] **Step 3: Verify + commit**

```bash
git add examples/conformance/invalid/missing-evidence-target
git commit -m "test(conformance): invalid/missing-evidence-target fixture"
```

---

### Task 26: Wire `noma verify` into CI

**Files:**
- Modify: `.github/workflows/pages.yml`
- Modify: `package.json` (add npm script)

- [ ] **Step 1: Add npm script in `package.json`**

In the `scripts` section, add:

```json
"verify:conformance": "npm run noma -- verify examples/conformance"
```

- [ ] **Step 2: Add CI step in `.github/workflows/pages.yml`**

Locate the `npm test` step. Add immediately after it:

```yaml
- name: Run conformance suite
  run: npm run verify:conformance
```

- [ ] **Step 3: Run locally to confirm everything passes**

```bash
npm run verify:conformance
```

Expected: 14 fixtures, 14 passed.

- [ ] **Step 4: Commit**

```bash
git add .github/workflows/pages.yml package.json
git commit -m "ci: run noma verify against examples/conformance on every push"
```

---

# Phase 1A — RFC + Docs

Phase 1A drafts the RFC text now that 1B is shipped. Each section maps to a numbered locked decision in the design doc.

---

### Task 27: Create RFC file with skeleton + frontmatter

**Files:**
- Create: `docs/spec-agent-protocol-v1.noma`

- [ ] **Step 1: Create the file with frontmatter + section skeleton**

```noma
---
title: Noma Agent Protocol
version: 1.0
status: stable
date: 2026-05-11
---

# Noma Agent Protocol v1.0

::summary
The contract agents follow when editing Noma documents. Covers block identity, patch
operations, validation, transcript records, and source-span guarantees. Annexes (A, B)
are provisional and may change before they reach stability in v1.1.
::

## 1. Conformance and versioning

(draft in Task 28)

## 2. Document model

(draft in Task 29)

## 3. Patch operation semantics

(draft in Task 30)

## 4. Validation contract

(draft in Task 31)

## 5. Transcript record

(draft in Task 32)

## 6. Source span guarantees

(draft in Task 33)

## Annex A — Capability descriptor (provisional)

::callout{tone="warning"}
**status: provisional.** Shape may change before enforcement code ships in v1.1.
::

(draft in Task 34)

## Annex B — MCP-over-stdio binding (provisional)

::callout{tone="warning"}
**status: provisional.** One binding among future bindings; shape may change.
::

(draft in Task 35)

## Annex C — Conformance suite

(draft in Task 36)
```

- [ ] **Step 2: Confirm parses cleanly**

```bash
npm run noma -- parse docs/spec-agent-protocol-v1.noma | head
```

Expected: valid JSON output.

- [ ] **Step 3: Commit**

```bash
git add docs/spec-agent-protocol-v1.noma
git commit -m "docs(spec): RFC skeleton for v1.0"
```

---

### Task 28: Draft §1 Conformance and versioning

**Files:**
- Modify: `docs/spec-agent-protocol-v1.noma` (replace `(draft in Task 28)` placeholder in §1)

Source: design doc §1, §2. Write covering:

- **1.1 What v1.0 stabilizes:** the five invariants (block identity, patch semantics, validation contract, transcript shape, span guarantees).
- **1.2 Compatibility promises:** semver — additions to optional transcript fields are minor; removing fields or changing required-field semantics is major.
- **1.3 Extension model:** implementations MUST ignore unknown fields in transcript records and on directive attributes.
- **1.4 Provisional annexes:** Annex A (capabilities) and Annex B (MCP binding) carry `status: provisional`. They are part of v1.0 documentation but NOT part of the v1.0 stability promise.

- [ ] **Step 1: Replace the §1 stub with full prose**

Open `docs/spec-agent-protocol-v1.noma`, replace the `## 1. Conformance and versioning\n\n(draft in Task 28)` block with the full section text covering the bullets above.

- [ ] **Step 2: Parse + check**

```bash
npm run noma -- check docs/spec-agent-protocol-v1.noma
```

Expected: validator passes (or only `stale-citation` warnings, which are fine).

- [ ] **Step 3: Commit**

```bash
git add docs/spec-agent-protocol-v1.noma
git commit -m "docs(spec): RFC §1 conformance and versioning"
```

---

### Task 29: Draft §2 Document model

**Files:** as Task 28.

Source: design doc §3.2 (canonical IDs only), §3.16 (book-mode out of wire scope).

Cover:
- 2.1 Addressable blocks — canonical `id` on `::block{id="..."}` directives or slugified heading; section-id collision suffixing.
- 2.2 Aliases as resolution aids — sources (`aliases=…`, frontmatter `aliases:`, filename slug, book-mode legacy retention). Aliases are NOT patch identity.
- 2.3 Book-mode scoping is a parsing concept — patches address a single `.noma` file directly. Multi-chapter patches out of scope for v1.0.

- [ ] **Step 1: Replace the §2 stub**.

- [ ] **Step 2: Parse + check**: `npm run noma -- check docs/spec-agent-protocol-v1.noma`.

- [ ] **Step 3: Commit**: `git commit -m "docs(spec): RFC §2 document model"`.

---

### Task 30: Draft §3 Patch operation semantics

**Files:** as above. Largest section.

Source: design doc §3.3, §3.4, §3.11, §3.14, §3.15.

Cover:
- 3.1 The five operations — per-op normative spec for each of `replace_block`, `add_block`, `delete_block`, `update_attribute`, `rename_id`. For each: required fields, error conditions referencing §3.15 codes, the effect on the document.
- 3.2 Atomicity per op-list — multi-op patches are atomic; on failure, no bytes are written.
- 3.3 `rename_id` retargets `for=`, `parent=`, `dataset=`, `[[wikilinks]]`. Leaves `aliases=` attribute untouched.
- 3.4 Validation failure policy — pre-validation does NOT block by default; post-validation surfaces post-state. Strict mode optional.
- 3.5 Error taxonomy — full table of `PatchErrorCode` values with meanings.

- [ ] **Step 1: Replace §3 stub with full spec text**. Include the error-code table from design doc §3.15 verbatim.

- [ ] **Step 2: Parse + check**.

- [ ] **Step 3: Commit**: `git commit -m "docs(spec): RFC §3 patch operation semantics"`.

---

### Task 31: Draft §4 Validation contract

Source: design doc §3.7, §3.13.

Cover:
- 4.1 Validators MUST run pre-apply (informational) and post-apply (informational). Strict mode is opt-in.
- 4.2 ValidationSummary (`ok | warn | error`) is derived from `Diagnostic[]`. The structured form is canonical.
- 4.3 Diagnostic shape — full type from design doc §3.5 (severity, code, message, nodeId?, pos?, phase).

- [ ] **Step 1: Replace §4 stub**.

- [ ] **Step 2: Check + commit**: `git commit -m "docs(spec): RFC §4 validation contract"`.

---

### Task 32: Draft §5 Transcript record

Source: design doc §3.5, §3.6, §3.11, §3.12, §3.13.

Cover:
- 5.1 JSONL append-only, one record per attempted op (not just applied).
- 5.2 Required schema (table). Cite the full type from design doc §3.5.
- 5.3 Optional ledger fields (`base_sha256`, `prev_entry_sha256`, `signature`). `signature: null` reserved in v1.0; shape defined v1.1+.
- 5.4 Hash semantics — sha256 of UTF-8 bytes, no normalization; pre = before apply, post = after apply.
- 5.5 Replay determinism — replaying every `applied` record's op against base produces post bytes.
- 5.6 Compatibility rules — `protocol_version` is the only version field; unknown fields ignored; `pre_sha`/`post_sha` are display only.
- 5.7 Phase 0 migration — Phase 0 logs are legacy-only and not v1.0 compatible.

- [ ] **Step 1: Replace §5 stub**.

- [ ] **Step 2: Check + commit**: `git commit -m "docs(spec): RFC §5 transcript record"`.

---

### Task 33: Draft §6 Source span guarantees

Source: design doc §3.9.

Cover:
- 6.1 Tier 1 — valid documents have exact, 1-based inclusive spans `[startLine, endLine]`.
- 6.2 Tier 2 — invalid/recovered documents have diagnostic-only spans (non-normative).
- 6.3 Per-node-type spec table (document, frontmatter, section implicit/explicit, directive, code, paragraph, list, list_item, quote, thematic_break, table).
- 6.4 Code-fence directive suppression rule — `::` inside ``` ``` blocks is NOT a directive boundary.
- 6.5 Section-id collision suffixing rule — slugified duplicates suffixed `-2`, `-3`; explicit `{id=}` overrides emit `duplicate-id` instead.

- [ ] **Step 1: Replace §6 stub**.

- [ ] **Step 2: Check + commit**: `git commit -m "docs(spec): RFC §6 source span guarantees"`.

---

### Task 34: Draft Annex A — Capability descriptor

Source: design doc §3.8.

Cover:
- Sidecar `document.noma.capabilities.yml` next to the document.
- Frontmatter pointer `agent_capabilities: ./...yml` (advisory).
- Schema: `nomaAgent.version`, `nomaAgent.profile`, `nomaAgent.blocks.<type>.{ops, attrs}`, `nomaAgent.ids.rename`, `nomaAgent.validation.required`.
- Default = `read-only / unspecified`, NOT `all`. Allowlist semantics.
- Provisional banner — no enforcement code in v1.0.

- [ ] **Step 1: Replace Annex A stub**.

- [ ] **Step 2: Check + commit**: `git commit -m "docs(spec): RFC Annex A capability descriptor (provisional)"`.

---

### Task 35: Draft Annex B — MCP-over-stdio binding

Source: existing `docs/agent-protocol.noma` (will be superseded by this annex) + Phase 0 tool surface from `packages/mcp-server/src/index.ts`.

Cover:
- Tool surface: `read_doc`, `list_ids`, `validate_doc`, `patch_block`.
- JSON-RPC mapping for each tool — input schema, output shape, error envelope.
- Authentication: stdio binding has no auth surface; runs under the caller's process identity. Annex notes this is one of several future bindings.
- Provisional banner.

- [ ] **Step 1: Fold relevant content from `docs/agent-protocol.noma` into Annex B**.

- [ ] **Step 2: Check + commit**: `git commit -m "docs(spec): RFC Annex B MCP-over-stdio binding (provisional)"`.

---

### Task 36: Draft Annex C — Conformance suite

Source: design doc §3.10, §3.17.

Cover:
- Fixture directory layout.
- File-naming conventions (`input.noma`, `expected.ids.json`, `expected.diagnostics.json`, `expected.roundtrip.noma`, `expected.spans.json`, `patch.json`, `expected.post.noma`).
- `noma verify <dir>` CLI behaviour and exit codes.
- Minimum corpus list (the 14 fixtures from §3.17 — refer by name).
- How to add a new fixture.

- [ ] **Step 1: Replace Annex C stub**.

- [ ] **Step 2: Check + commit**: `git commit -m "docs(spec): RFC Annex C conformance suite"`.

---

### Task 37: Migrate `docs/agent-protocol.noma` — supersede pointer

**Files:**
- Modify: `docs/agent-protocol.noma`

- [ ] **Step 1: Replace the body of `docs/agent-protocol.noma`** with a redirect:

```noma
---
title: Noma Agent Patch Protocol (superseded)
superseded-by: spec-agent-protocol-v1.noma
version: 0.5.1
date: 2026-05-11
---

# Agent Patch Protocol (superseded)

::callout{tone="warning"}
This document was the v0.x draft of the agent patch protocol. As of v0.6.0 it is
**superseded by [Noma Agent Protocol v1.0](spec-agent-protocol-v1.noma)**.

Folded into the v1.0 RFC as:
- Patch operation semantics → §3
- Annex B (MCP-over-stdio binding) → existing MCP content
- Open questions resolved or moved to v1.1 backlog

Refer to the v1.0 RFC for normative content.
::
```

- [ ] **Step 2: Run `npm run build:site`** — confirms cross-link doesn't break the site build.

- [ ] **Step 3: Commit**: `git commit -m "docs: supersede agent-protocol.noma → spec-agent-protocol-v1.noma"`.

---

### Task 38: Update `docs/spec.noma` cross-references

**Files:**
- Modify: `docs/spec.noma`

- [ ] **Step 1: Find all references to `agent-protocol.noma` in `docs/spec.noma`** and add a parallel reference to `spec-agent-protocol-v1.noma`. Keep the old reference (still useful for the redirect note); add the new one as the primary.

```bash
grep -n "agent-protocol" docs/spec.noma
```

- [ ] **Step 2: Insert or update the references** so the section listing "Agent patch protocol" points to the v1.0 RFC.

- [ ] **Step 3: Bump the `version:` frontmatter in `docs/spec.noma` to `0.6.0`** (matching the upcoming package version).

- [ ] **Step 4: Run `noma check docs/spec.noma`** and `npm run build:site`.

- [ ] **Step 5: Commit**: `git commit -m "docs(spec): cross-ref RFC v1.0 from spec.noma; bump version 0.6.0"`.

---

# Release

### Task 39: Version bump to v0.6.0 across all versioned locations

**Files:**
- Modify: `package.json` (version)
- Modify: `packages/mcp-server/package.json` (version)
- Modify: `docs/spec.noma` (already done in Task 38 if performed)
- Modify: `docs/spec-agent-protocol-v1.noma` (frontmatter `version: 1.0` is the **protocol** version; do not change)
- Modify: `README.md` (Status paragraph)
- Modify: `CHANGELOG.md` (new `## [0.6.0]` heading at top)
- Modify: `PLAN.md` (new `§24.X` subsection moving Phase 1 items to "shipped")

- [ ] **Step 1: Bump `package.json` and `packages/mcp-server/package.json`**

```bash
# package.json: "version": "0.5.1" → "0.6.0"
# packages/mcp-server/package.json: bump per the project's monorepo convention
```

- [ ] **Step 2: Write the CHANGELOG entry**

At the top of `CHANGELOG.md` under `## [Unreleased]` (or new `## [0.6.0] — 2026-05-DD`):

```markdown
## [0.6.0] — YYYY-MM-DD

### Added
- **Noma Agent Protocol v1.0 RFC** — single canonical spec for block identity, patch ops, validation, transcript records, and source spans. Provisional annexes for capability descriptors (sidecar) and MCP-over-stdio binding. (docs/spec-agent-protocol-v1.noma)
- **`noma verify` CLI** — conformance harness running ID, diagnostic, roundtrip, span, and patch-application checks against a fixture directory.
- **14-fixture conformance corpus** under `examples/conformance/` exercising every locked decision in the RFC.
- **Explicit `FrontmatterNode` AST variant** with `raw`, `data`, and source span; document node now carries `pos` and `endLine`.
- **`PatchError.code` field** — machine-readable taxonomy (`target_missing`, `id_conflict`, `id_attribute_protected`, …) per RFC §3.5.
- **Validator `duplicate-id` rule** for explicit id collisions; slug-derived collisions auto-suffix `-2`, `-3`.

### Changed
- **Transcript schema** rewritten to v1.0 protocol shape: drops `v:1` literal, adds `protocol_version`, `op_id` (UUID), full `pre_sha256`/`post_sha256` hashes (8-char `pre_sha`/`post_sha` now display only), structured `actor` object, `patch_result` enum, `tool_version`, `doc_uri`, optional `base_sha256` (warns on drift). Phase 0 transcript records are legacy-only and not retroactively v1.0 compatible.
- **`docs/agent-protocol.noma`** superseded by the new RFC. Carries a `superseded-by:` pointer.

### Fixed
- Parser: `::` lines inside fenced code no longer trigger directive recognition (PLAN.md §24.9).
```

- [ ] **Step 3: Update `README.md` Status paragraph** to reference v0.6.0 + the new RFC + the conformance suite.

- [ ] **Step 4: Add `PLAN.md` §24.X subsection** moving the Phase 1 deliverables out of §23 into shipped.

- [ ] **Step 5: Commit**

```bash
git add package.json packages/mcp-server/package.json README.md CHANGELOG.md PLAN.md
git commit -m "chore: bump v0.6.0 — Agent Protocol v1.0 RFC + conformance suite"
```

---

### Task 40: Final verification triad + render + tag + release

- [ ] **Step 1: Run the full triad**

```bash
npx tsc --noEmit && npm test && npm run build:site && npm run verify:conformance
```

Expected: all four pass.

- [ ] **Step 2: Push main**

```bash
git push origin main
```

- [ ] **Step 3: Tag locally and push the tag (CI cannot tag itself per CLAUDE.md "Releasing")**

```bash
git tag v0.6.0
git push origin v0.6.0
```

- [ ] **Step 4: Cut GitHub release with CHANGELOG slice**

```bash
awk '/^## \[0\.6\.0\]/{f=1;next}/^## \[/{f=0}f' CHANGELOG.md > /tmp/notes-v0.6.0.md
gh release create v0.6.0 --title "v0.6.0 — Agent Protocol v1.0" --notes-file /tmp/notes-v0.6.0.md
```

- [ ] **Step 5: Close shipped issues**

Identify the issues this release closed (Phase 1 tracker in PLAN.md §23 → §24). For each:

```bash
gh issue close <number> --comment "Shipped in v0.6.0 — <release-url>"
```

---

## Plan self-review checklist

After all tasks land:

- [ ] All 18 locked decisions in design doc §3 map to numbered sections or tests.
- [ ] `npm run verify:conformance` runs 14 fixtures and exits 0.
- [ ] `docs/spec-agent-protocol-v1.noma` parses + validates without errors.
- [ ] `docs/agent-protocol.noma` carries `superseded-by:` and a clear redirect note.
- [ ] `package.json`, `packages/mcp-server/package.json`, `docs/spec.noma`, `CHANGELOG.md`, `README.md`, `PLAN.md` all carry `0.6.0`.
- [ ] No `// TODO` or `(draft in Task N)` placeholders remain in `docs/spec-agent-protocol-v1.noma`.
- [ ] Pages workflow on GitHub Actions is green post-tag.

If any of the above are not satisfied, fix before declaring v0.6.0 shipped.
