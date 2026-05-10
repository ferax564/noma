# @noma/mcp-server Phase 0 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship a working MCP server (`@noma/mcp-server`) that lets an agent read, patch, and validate `.noma` files at the block level, with a byte-preserving write path and an append-only patch transcript.

**Architecture:** New npm workspace package under `packages/mcp-server/`. Four MCP tools (`read_doc`, `list_ids`, `patch_block`, `validate_doc`) wrap the existing `@noma/cli` library. `patch_block` uses `patchSource()` (line-splice, byte-preserving) and appends to a sidecar `.noma.patches` JSONL file. Stateless stdio transport — tools take an absolute `file` path argument.

**Tech Stack:** TypeScript, `@modelcontextprotocol/sdk` (McpServer + StdioServerTransport), `zod` (runtime input validation), `node:crypto` (SHA-256), `node:test` + `tsx` (tests).

---

## File Map

| File | Responsibility |
|---|---|
| `packages/mcp-server/package.json` | Package metadata, deps: `@modelcontextprotocol/sdk`, `zod`, `@noma/cli` |
| `packages/mcp-server/tsconfig.json` | Extends root tsconfig; overrides `rootDir`, `outDir`, `include` |
| `packages/mcp-server/src/sha.ts` | `sha256hex(data)` — SHA-256 of a Buffer or string |
| `packages/mcp-server/src/transcript.ts` | `TranscriptLine` type + `appendTranscript(path, line)` |
| `packages/mcp-server/src/tools/read-doc.ts` | `readDoc(file)` → `BlockSummary[]` |
| `packages/mcp-server/src/tools/list-ids.ts` | `listIds(file)` → `{ ids, aliases }` |
| `packages/mcp-server/src/tools/validate-doc.ts` | `validateDoc(file)` → `{ ok, diagnostics }` |
| `packages/mcp-server/src/tools/patch-block.ts` | `patchBlock(args)` — full write + transcript |
| `packages/mcp-server/src/index.ts` | `McpServer` setup, tool registrations, stdio connect |
| `packages/mcp-server/test/sha.test.ts` | SHA helper unit tests |
| `packages/mcp-server/test/transcript.test.ts` | Transcript append tests |
| `packages/mcp-server/test/read-doc.test.ts` | read_doc tests |
| `packages/mcp-server/test/list-ids.test.ts` | list_ids tests |
| `packages/mcp-server/test/validate-doc.test.ts` | validate_doc tests |
| `packages/mcp-server/test/patch-block.test.ts` | patch_block tests (concurrency guard, sharp edges) |

---

## Task 0: Monorepo Workspace Setup

**Files:**
- Modify: `package.json` (root)

- [ ] **Step 1: Add workspaces field to root package.json**

Open `package.json` (root). After the `"license"` field, add:

```json
"workspaces": ["packages/*"],
```

Full diff context — the engines block should now be preceded by:

```json
  "license": "MIT",
  "workspaces": ["packages/*"],
  "engines": {
```

- [ ] **Step 2: Create the packages directory**

```bash
mkdir -p packages
```

- [ ] **Step 3: Install to wire up workspaces**

```bash
npm install
```

Expected: no errors. A `packages/` symlink may appear in `node_modules/@noma/` after the mcp-server package is created.

- [ ] **Step 4: Commit**

```bash
git add package.json packages/
git commit -m "chore: add npm workspaces support"
```

---

## Task 1: Package Scaffold

**Files:**
- Create: `packages/mcp-server/package.json`
- Create: `packages/mcp-server/tsconfig.json`
- Create: `packages/mcp-server/src/index.ts` (stub)

- [ ] **Step 1: Create package.json**

```bash
mkdir -p packages/mcp-server/src packages/mcp-server/test
```

Create `packages/mcp-server/package.json`:

```json
{
  "name": "@noma/mcp-server",
  "version": "0.1.0",
  "description": "MCP server for @noma/cli — block-level agent editing",
  "type": "module",
  "main": "dist/index.js",
  "bin": {
    "noma-mcp-server": "./dist/index.js"
  },
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "test": "tsx --test test/*.test.ts"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.11.0",
    "@noma/cli": "*",
    "zod": "^3.24.0"
  },
  "devDependencies": {
    "@types/node": "^22.10.0",
    "tsx": "^4.19.2",
    "typescript": "^5.7.2"
  },
  "engines": {
    "node": ">=20"
  }
}
```

- [ ] **Step 2: Create tsconfig.json**

Create `packages/mcp-server/tsconfig.json`:

```json
{
  "extends": "../../tsconfig.json",
  "compilerOptions": {
    "rootDir": "src",
    "outDir": "dist",
    "declarationDir": "dist"
  },
  "include": ["src/**/*"],
  "exclude": ["node_modules", "dist", "test"]
}
```

- [ ] **Step 3: Create stub index.ts**

Create `packages/mcp-server/src/index.ts`:

```typescript
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const server = new McpServer({
  name: "@noma/mcp-server",
  version: "0.1.0",
});

const transport = new StdioServerTransport();
await server.connect(transport);
```

- [ ] **Step 4: Install dependencies**

```bash
npm install
```

Expected: `@modelcontextprotocol/sdk` and `zod` appear in `packages/mcp-server/node_modules` (or hoisted). No errors.

- [ ] **Step 5: Verify typecheck passes on stub**

```bash
cd packages/mcp-server && npx tsc --noEmit
```

Expected: no errors.

- [ ] **Step 6: Commit**

```bash
git add packages/mcp-server/
git commit -m "chore: scaffold @noma/mcp-server package"
```

---

## Task 2: SHA Helper

**Files:**
- Create: `packages/mcp-server/src/sha.ts`
- Create: `packages/mcp-server/test/sha.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/mcp-server/test/sha.test.ts`:

```typescript
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
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd packages/mcp-server && npm test -- --test-name-pattern sha
```

Expected: FAIL — `Cannot find module '../src/sha.js'`

- [ ] **Step 3: Implement sha.ts**

Create `packages/mcp-server/src/sha.ts`:

```typescript
import { createHash } from "node:crypto";

export function sha256hex(data: Buffer | string): string {
  return createHash("sha256").update(data).digest("hex");
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd packages/mcp-server && npm test -- --test-name-pattern sha
```

Expected: 4 passing.

- [ ] **Step 5: Commit**

```bash
git add packages/mcp-server/src/sha.ts packages/mcp-server/test/sha.test.ts
git commit -m "feat(mcp-server): sha256hex helper"
```

---

## Task 3: Transcript Writer

**Files:**
- Create: `packages/mcp-server/src/transcript.ts`
- Create: `packages/mcp-server/test/transcript.test.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/mcp-server/test/transcript.test.ts`:

```typescript
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { appendTranscript } from "../src/transcript.js";
import type { TranscriptLine } from "../src/transcript.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "noma-transcript-"));
});

describe("appendTranscript", () => {
  it("creates the file on first append", () => {
    const path = join(dir, "test.noma.patches");
    const line: TranscriptLine = {
      v: 1,
      ts: "2026-05-10T12:00:00Z",
      agent: "test",
      op: { op: "delete_block", id: "foo" },
      reason: "",
      pre_validation: "ok",
      post_validation: "ok",
      pre_sha: "aaaaaaaa",
      post_sha: "bbbbbbbb",
    };
    appendTranscript(path, line);
    const content = readFileSync(path, "utf8");
    const parsed = JSON.parse(content.trim());
    assert.equal(parsed.v, 1);
    assert.equal(parsed.agent, "test");
    assert.equal(parsed.pre_sha, "aaaaaaaa");
  });

  it("appends a second line without overwriting", () => {
    const path = join(dir, "test.noma.patches");
    const line: TranscriptLine = {
      v: 1, ts: "2026-05-10T12:00:00Z", agent: "a", reason: "",
      op: { op: "delete_block", id: "x" },
      pre_validation: "ok", post_validation: "ok",
      pre_sha: "11111111", post_sha: "22222222",
    };
    appendTranscript(path, line);
    appendTranscript(path, { ...line, pre_sha: "33333333", post_sha: "44444444" });
    const lines = readFileSync(path, "utf8").trim().split("\n");
    assert.equal(lines.length, 2);
    assert.equal(JSON.parse(lines[1]!).pre_sha, "33333333");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

```bash
cd packages/mcp-server && npm test -- --test-name-pattern transcript
```

Expected: FAIL — `Cannot find module '../src/transcript.js'`

- [ ] **Step 3: Implement transcript.ts**

Create `packages/mcp-server/src/transcript.ts`:

```typescript
import { appendFileSync } from "node:fs";
import type { PatchOp } from "@noma/cli";

export type ValidationSummary = "ok" | "warn" | "error";

export interface TranscriptLine {
  v: 1;
  ts: string;
  agent: string;
  op: PatchOp;
  reason: string;
  pre_validation: ValidationSummary;
  post_validation: ValidationSummary;
  pre_sha: string;
  post_sha: string;
}

export function appendTranscript(path: string, line: TranscriptLine): void {
  appendFileSync(path, JSON.stringify(line) + "\n", "utf8");
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd packages/mcp-server && npm test -- --test-name-pattern transcript
```

Expected: 2 passing.

- [ ] **Step 5: Commit**

```bash
git add packages/mcp-server/src/transcript.ts packages/mcp-server/test/transcript.test.ts
git commit -m "feat(mcp-server): transcript writer + types"
```

---

## Task 4: read_doc Tool

**Files:**
- Create: `packages/mcp-server/src/tools/read-doc.ts`
- Create: `packages/mcp-server/test/read-doc.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `packages/mcp-server/test/read-doc.test.ts`:

```typescript
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { readDoc } from "../src/tools/read-doc.js";

const dir = mkdtempSync(join(tmpdir(), "noma-read-doc-"));

function writeNoma(name: string, content: string): string {
  const p = join(dir, name);
  writeFileSync(p, content, "utf8");
  return p;
}

describe("readDoc", () => {
  it("returns blocks with type and patchable flag", () => {
    const file = writeNoma("a.noma", `# My Doc\n\nHello world.\n`);
    const blocks = readDoc(file);
    assert.ok(blocks.length >= 1);
    const section = blocks.find(b => b.type === "section");
    assert.ok(section, "expected a section block");
    assert.equal(section!.patchable, true);
    assert.ok(section!.id, "section should have an id");
  });

  it("marks paragraphs without explicit id as not patchable", () => {
    const file = writeNoma("b.noma", `# Doc\n\nSome text here.\n`);
    const blocks = readDoc(file);
    const para = blocks.find(b => b.type === "paragraph");
    assert.ok(para, "expected a paragraph");
    assert.equal(para!.patchable, false);
  });

  it("returns directive attrs only for directives", () => {
    const file = writeNoma("c.noma", `::claim{id="c1" confidence=0.8}\nSome claim.\n::\n`);
    const blocks = readDoc(file);
    const dir = blocks.find(b => b.type === "directive");
    assert.ok(dir, "expected a directive");
    assert.deepEqual(dir!.attrs, { confidence: 0.8 });
  });

  it("throws on book manifest path", () => {
    const file = writeNoma("book.noma.yml", "chapters: []");
    assert.throws(() => readDoc(file), /book manifests/);
  });

  it("throws on missing file", () => {
    assert.throws(() => readDoc("/nonexistent/path/x.noma"), /ENOENT/);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd packages/mcp-server && npm test -- --test-name-pattern "readDoc"
```

Expected: FAIL — `Cannot find module '../src/tools/read-doc.js'`

- [ ] **Step 3: Implement read-doc.ts**

Create `packages/mcp-server/src/tools/read-doc.ts`:

```typescript
import { readFileSync } from "node:fs";
import { parse, isBookManifestPath } from "@noma/cli";
import type { AttrValue, Node } from "@noma/cli";

export interface BlockSummary {
  id?: string;
  type: string;
  name?: string;
  attrs?: Record<string, AttrValue>;
  title?: string;
  level?: number;
  aliases?: string[];
  childCount: number;
  lines: [number, number];
  patchable: boolean;
}

export function readDoc(file: string): BlockSummary[] {
  if (isBookManifestPath(file)) {
    throw new Error("book manifests are not supported by read_doc — use the CLI");
  }
  const source = readFileSync(file, "utf8");
  const doc = parse(source);
  const summaries: BlockSummary[] = [];
  collectBlocks(doc.children, summaries);
  return summaries;
}

function collectBlocks(nodes: Node[], out: BlockSummary[]): void {
  for (const node of nodes) {
    const startLine = node.pos?.line ?? 0;
    const endLine = node.endLine ?? startLine;
    const base: BlockSummary = {
      type: node.type,
      childCount: "children" in node ? (node.children as Node[]).length : 0,
      lines: [startLine, endLine],
      patchable: typeof node.id === "string" && node.id.length > 0,
    };
    if (node.id) base.id = node.id;
    if (node.aliases?.length) base.aliases = node.aliases;

    if (node.type === "section") {
      base.title = node.title;
      base.level = node.level;
    } else if (node.type === "directive") {
      base.name = node.name;
      base.attrs = { ...node.attrs };
    }

    out.push(base);

    if ("children" in node) {
      collectBlocks(node.children as Node[], out);
    }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd packages/mcp-server && npm test -- --test-name-pattern "readDoc"
```

Expected: 5 passing.

- [ ] **Step 5: Commit**

```bash
git add packages/mcp-server/src/tools/read-doc.ts packages/mcp-server/test/read-doc.test.ts
git commit -m "feat(mcp-server): read_doc tool"
```

---

## Task 5: list_ids Tool

**Files:**
- Create: `packages/mcp-server/src/tools/list-ids.ts`
- Create: `packages/mcp-server/test/list-ids.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `packages/mcp-server/test/list-ids.test.ts`:

```typescript
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { listIds } from "../src/tools/list-ids.js";

const dir = mkdtempSync(join(tmpdir(), "noma-list-ids-"));

function writeNoma(name: string, content: string): string {
  const p = join(dir, name);
  writeFileSync(p, content, "utf8");
  return p;
}

describe("listIds", () => {
  it("returns canonical IDs in document order", () => {
    const file = writeNoma("a.noma", `# Section One\n\n## Section Two\n`);
    const { ids } = listIds(file);
    assert.ok(ids.includes("section-one"), `got: ${ids}`);
    assert.ok(ids.includes("section-two"), `got: ${ids}`);
    assert.ok(ids.indexOf("section-one") < ids.indexOf("section-two"));
  });

  it("returns alias map", () => {
    const file = writeNoma("b.noma", `# My Doc {id="doc-root" aliases="root,home"}\n`);
    const { aliases } = listIds(file);
    assert.equal(aliases["root"], "doc-root");
    assert.equal(aliases["home"], "doc-root");
  });

  it("returns empty for doc with no IDs", () => {
    const file = writeNoma("c.noma", `Plain paragraph text.\n`);
    const { ids, aliases } = listIds(file);
    assert.equal(ids.length, 0);
    assert.deepEqual(aliases, {});
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd packages/mcp-server && npm test -- --test-name-pattern "listIds"
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement list-ids.ts**

Create `packages/mcp-server/src/tools/list-ids.ts`:

```typescript
import { readFileSync } from "node:fs";
import { parse } from "@noma/cli";
import type { Node } from "@noma/cli";

export interface ListIdsResult {
  ids: string[];
  aliases: Record<string, string>;
}

export function listIds(file: string): ListIdsResult {
  const source = readFileSync(file, "utf8");
  const doc = parse(source);
  const ids: string[] = [];
  const aliases: Record<string, string> = {};
  collectIds(doc.children, ids, aliases);
  return { ids, aliases };
}

function collectIds(nodes: Node[], ids: string[], aliases: Record<string, string>): void {
  for (const node of nodes) {
    if (node.id) {
      ids.push(node.id);
      for (const alias of node.aliases ?? []) {
        aliases[alias] = node.id;
      }
    }
    if ("children" in node) {
      collectIds(node.children as Node[], ids, aliases);
    }
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd packages/mcp-server && npm test -- --test-name-pattern "listIds"
```

Expected: 3 passing.

- [ ] **Step 5: Commit**

```bash
git add packages/mcp-server/src/tools/list-ids.ts packages/mcp-server/test/list-ids.test.ts
git commit -m "feat(mcp-server): list_ids tool"
```

---

## Task 6: validate_doc Tool

**Files:**
- Create: `packages/mcp-server/src/tools/validate-doc.ts`
- Create: `packages/mcp-server/test/validate-doc.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `packages/mcp-server/test/validate-doc.test.ts`:

```typescript
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { validateDoc } from "../src/tools/validate-doc.js";

const dir = mkdtempSync(join(tmpdir(), "noma-validate-"));

function writeNoma(name: string, content: string): string {
  const p = join(dir, name);
  writeFileSync(p, content, "utf8");
  return p;
}

describe("validateDoc", () => {
  it("returns ok:true for a clean doc", () => {
    const file = writeNoma("clean.noma", `# Clean Doc\n\nSome text.\n`);
    const result = validateDoc(file);
    assert.equal(result.ok, true);
  });

  it("returns ok:false and diagnostics for a broken reference", () => {
    const file = writeNoma("broken.noma", [
      `::evidence{id="e1" for="claim-missing"}`,
      `Some evidence.`,
      `::`,
    ].join("\n") + "\n");
    const result = validateDoc(file);
    assert.equal(result.ok, false);
    assert.ok(result.diagnostics.length > 0);
    assert.ok(result.diagnostics.some(d => d.severity === "error"));
  });

  it("rejects book manifests", () => {
    const file = writeNoma("book.noma.yml", "chapters: []");
    assert.throws(() => validateDoc(file), /book manifests/);
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd packages/mcp-server && npm test -- --test-name-pattern "validateDoc"
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement validate-doc.ts**

Create `packages/mcp-server/src/tools/validate-doc.ts`:

```typescript
import { readFileSync } from "node:fs";
import { parse, validate, isBookManifestPath } from "@noma/cli";
import type { Diagnostic } from "@noma/cli";
import type { ValidationSummary } from "../transcript.js";

export interface ValidateDocResult {
  ok: boolean;
  diagnostics: Diagnostic[];
}

export function validateDoc(file: string): ValidateDocResult {
  if (isBookManifestPath(file)) {
    throw new Error("book manifests are not supported by validate_doc — use the CLI");
  }
  const source = readFileSync(file, "utf8");
  const doc = parse(source);
  const diagnostics = validate(doc);
  const ok = !diagnostics.some(d => d.severity === "error");
  return { ok, diagnostics };
}

export function summarizeValidation(diagnostics: Diagnostic[]): ValidationSummary {
  if (diagnostics.some(d => d.severity === "error")) return "error";
  if (diagnostics.some(d => d.severity === "warn")) return "warn";
  return "ok";
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd packages/mcp-server && npm test -- --test-name-pattern "validateDoc"
```

Expected: 3 passing.

- [ ] **Step 5: Commit**

```bash
git add packages/mcp-server/src/tools/validate-doc.ts packages/mcp-server/test/validate-doc.test.ts
git commit -m "feat(mcp-server): validate_doc tool"
```

---

## Task 7: patch_block Tool

**Files:**
- Create: `packages/mcp-server/src/tools/patch-block.ts`
- Create: `packages/mcp-server/test/patch-block.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `packages/mcp-server/test/patch-block.test.ts`:

```typescript
import { describe, it, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, readFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { patchBlock } from "../src/tools/patch-block.js";
import { sha256hex } from "../src/sha.js";

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "noma-patch-block-"));
});

function writeNoma(name: string, content: string): string {
  const p = join(dir, name);
  writeFileSync(p, content, "utf8");
  return p;
}

const DOC = `---
title: Test
---

# Intro {id="intro"}

Some paragraph text here.

::claim{id="c1" confidence=0.7}
This is a claim.
::
`;

describe("patchBlock — update_attribute", () => {
  it("applies op and returns ok:true", () => {
    const file = writeNoma("doc.noma", DOC);
    const result = patchBlock({
      file,
      op: { op: "update_attribute", id: "c1", key: "confidence", value: 0.95 },
      reason: "Q1 beat",
    });
    assert.equal(result.ok, true);
    const updated = readFileSync(file, "utf8");
    assert.ok(updated.includes("confidence=0.95"), `expected confidence=0.95 in:\n${updated}`);
  });

  it("preserves bytes outside the patched block", () => {
    const file = writeNoma("doc2.noma", DOC);
    patchBlock({ file, op: { op: "update_attribute", id: "c1", key: "confidence", value: 0.9 }, reason: "" });
    const updated = readFileSync(file, "utf8");
    assert.ok(updated.includes("Some paragraph text here."), "unpatched paragraph should be byte-identical");
    assert.ok(updated.includes("---\ntitle: Test\n---"), "frontmatter should be byte-identical");
  });

  it("appends to .noma.patches transcript", () => {
    const file = writeNoma("doc3.noma", DOC);
    patchBlock({ file, op: { op: "update_attribute", id: "c1", key: "confidence", value: 0.8 }, reason: "test" });
    const transcriptPath = file + ".patches";
    const raw = readFileSync(transcriptPath, "utf8");
    const entry = JSON.parse(raw.trim());
    assert.equal(entry.v, 1);
    assert.equal(entry.reason, "test");
    assert.ok(entry.pre_sha, "pre_sha must be set");
    assert.ok(entry.post_sha, "post_sha must be set");
    assert.notEqual(entry.pre_sha, entry.post_sha);
  });
});

describe("patchBlock — concurrency guard", () => {
  it("returns ok:false on expected_sha mismatch", () => {
    const file = writeNoma("doc4.noma", DOC);
    const result = patchBlock({
      file,
      op: { op: "update_attribute", id: "c1", key: "confidence", value: 0.9 },
      reason: "",
      expected_sha: "00000000",
    });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.error, "precondition_failed");
    }
  });

  it("succeeds when expected_sha matches actual", () => {
    const file = writeNoma("doc5.noma", DOC);
    const bytes = readFileSync(file);
    const sha = sha256hex(bytes).slice(0, 8);
    const result = patchBlock({
      file,
      op: { op: "update_attribute", id: "c1", key: "confidence", value: 0.85 },
      reason: "",
      expected_sha: sha,
    });
    assert.equal(result.ok, true);
  });
});

describe("patchBlock — error cases", () => {
  it("returns ok:false for unknown block ID", () => {
    const file = writeNoma("doc6.noma", DOC);
    const result = patchBlock({ file, op: { op: "delete_block", id: "no-such-id" }, reason: "" });
    assert.equal(result.ok, false);
  });

  it("returns ok:false for book manifest", () => {
    const file = writeNoma("book.noma.yml", "chapters: []");
    const result = patchBlock({ file, op: { op: "delete_block", id: "x" }, reason: "" });
    assert.equal(result.ok, false);
  });

  it("returns ok:false for content over 1MB", () => {
    const file = writeNoma("doc7.noma", DOC);
    const result = patchBlock({
      file,
      op: { op: "replace_block", id: "c1", content: "x".repeat(1_100_000) },
      reason: "",
    });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.error, "content_too_large");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

```bash
cd packages/mcp-server && npm test -- --test-name-pattern "patchBlock"
```

Expected: FAIL — module not found.

- [ ] **Step 3: Implement patch-block.ts**

Create `packages/mcp-server/src/tools/patch-block.ts`:

```typescript
import { readFileSync, writeFileSync, renameSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";
import { parse, patchSource, validate, isBookManifestPath, PatchError } from "@noma/cli";
import type { PatchOp } from "@noma/cli";
import { sha256hex } from "../sha.js";
import { appendTranscript } from "../transcript.js";
import { summarizeValidation } from "./validate-doc.js";
import type { TranscriptLine, ValidationSummary } from "../transcript.js";

const MAX_CONTENT_BYTES = 1_000_000;

export interface PatchBlockArgs {
  file: string;
  op: PatchOp;
  reason?: string;
  expected_sha?: string;
}

type PatchBlockResult =
  | { ok: true; post_validation: ValidationSummary; transcript_entry: TranscriptLine }
  | { ok: false; error: string };

export function patchBlock(args: PatchBlockArgs): PatchBlockResult {
  const { file, op, reason = "", expected_sha } = args;

  if (isBookManifestPath(file)) {
    return { ok: false, error: "book manifests are not supported by patch_block" };
  }

  if ("content" in op && typeof op.content === "string" && op.content.length > MAX_CONTENT_BYTES) {
    return { ok: false, error: "content_too_large" };
  }

  let source: string;
  try {
    source = readFileSync(file, "utf8");
  } catch (e) {
    return { ok: false, error: String(e) };
  }

  const preBytes = Buffer.from(source, "utf8");
  const pre_sha = sha256hex(preBytes).slice(0, 8);

  if (expected_sha !== undefined && expected_sha !== pre_sha) {
    return { ok: false, error: "precondition_failed" };
  }

  const preDoc = parse(source);
  const pre_validation = summarizeValidation(validate(preDoc));

  let patched: string;
  try {
    patched = patchSource(source, op);
  } catch (e) {
    if (e instanceof PatchError) return { ok: false, error: e.message };
    return { ok: false, error: String(e) };
  }

  const postBytes = Buffer.from(patched, "utf8");
  const post_sha = sha256hex(postBytes).slice(0, 8);

  const tmp = join(dirname(file), `.noma-patch-${randomBytes(6).toString("hex")}.tmp`);
  try {
    writeFileSync(tmp, patched, "utf8");
    renameSync(tmp, file);
  } catch (e) {
    try { renameSync(tmp, tmp + ".dead"); } catch {}
    return { ok: false, error: String(e) };
  }

  const postDoc = parse(patched);
  const post_validation = summarizeValidation(validate(postDoc));

  const transcript_entry: TranscriptLine = {
    v: 1,
    ts: new Date().toISOString(),
    agent: "unknown",
    op,
    reason,
    pre_validation,
    post_validation,
    pre_sha,
    post_sha,
  };

  appendTranscript(file + ".patches", transcript_entry);

  return { ok: true, post_validation, transcript_entry };
}
```

- [ ] **Step 4: Run tests to verify they pass**

```bash
cd packages/mcp-server && npm test -- --test-name-pattern "patchBlock"
```

Expected: all passing.

- [ ] **Step 5: Commit**

```bash
git add packages/mcp-server/src/tools/patch-block.ts packages/mcp-server/test/patch-block.test.ts
git commit -m "feat(mcp-server): patch_block tool with patchSource + transcript"
```

---

## Task 8: Wire Up MCP Server

**Files:**
- Modify: `packages/mcp-server/src/index.ts`

- [ ] **Step 1: Replace stub with full server**

Replace the contents of `packages/mcp-server/src/index.ts` with:

```typescript
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { readDoc } from "./tools/read-doc.js";
import { listIds } from "./tools/list-ids.js";
import { validateDoc } from "./tools/validate-doc.js";
import { patchBlock } from "./tools/patch-block.js";

const PatchOpSchema = z.discriminatedUnion("op", [
  z.object({ op: z.literal("replace_block"), id: z.string(), content: z.string() }),
  z.object({ op: z.literal("add_block"), parent: z.string(), content: z.string(), position: z.number().int().optional() }),
  z.object({ op: z.literal("delete_block"), id: z.string() }),
  z.object({ op: z.literal("update_attribute"), id: z.string(), key: z.string(), value: z.union([z.string(), z.number(), z.boolean()]) }),
  z.object({ op: z.literal("rename_id"), from: z.string(), to: z.string() }),
]);

const server = new McpServer({
  name: "@noma/mcp-server",
  version: "0.1.0",
});

server.tool(
  "read_doc",
  "Parse a .noma file and return a shallow summary of all blocks with their IDs, types, and patchability.",
  { file: z.string().describe("Absolute path to the .noma file") },
  async ({ file }) => {
    try {
      const blocks = readDoc(file);
      return { content: [{ type: "text", text: JSON.stringify({ blocks }) }] };
    } catch (e) {
      return { isError: true, content: [{ type: "text", text: String(e) }] };
    }
  },
);

server.tool(
  "list_ids",
  "Return all canonical block IDs and alias map for a .noma file.",
  { file: z.string() },
  async ({ file }) => {
    try {
      const result = listIds(file);
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    } catch (e) {
      return { isError: true, content: [{ type: "text", text: String(e) }] };
    }
  },
);

server.tool(
  "validate_doc",
  "Run the Noma validator on a .noma file. Profile is read from the document frontmatter.",
  { file: z.string() },
  async ({ file }) => {
    try {
      const result = validateDoc(file);
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    } catch (e) {
      return { isError: true, content: [{ type: "text", text: String(e) }] };
    }
  },
);

server.tool(
  "patch_block",
  "Apply a block-level patch op to a .noma file. Uses byte-preserving patchSource(). Appends to .noma.patches transcript.",
  {
    file: z.string().describe("Absolute path to the .noma file"),
    op: PatchOpSchema.describe("Patch operation to apply"),
    reason: z.string().optional().describe("Agent-provided justification stored in transcript"),
    expected_sha: z.string().length(8).optional().describe("SHA-256[:8] of file before patch — prevents lost updates"),
  },
  async ({ file, op, reason, expected_sha }) => {
    const result = patchBlock({ file, op, reason, expected_sha });
    if (!result.ok) {
      return { isError: true, content: [{ type: "text", text: JSON.stringify(result) }] };
    }
    return { content: [{ type: "text", text: JSON.stringify(result) }] };
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
```

- [ ] **Step 2: Typecheck**

```bash
cd packages/mcp-server && npx tsc --noEmit
```

Expected: no errors. If `PatchOp` type from `@noma/cli` doesn't align with `PatchOpSchema` discriminants, fix the zod schema to match the actual `op` string literals in `src/patch.ts` of the root package.

- [ ] **Step 3: Build**

```bash
cd packages/mcp-server && npm run build
```

Expected: `dist/` created with `index.js` and type declarations.

- [ ] **Step 4: Commit**

```bash
git add packages/mcp-server/src/index.ts
git commit -m "feat(mcp-server): wire up McpServer with all four tools"
```

---

## Task 9: Full Test Run + CI Verification

- [ ] **Step 1: Run all mcp-server tests**

```bash
cd packages/mcp-server && npm test
```

Expected: all tests pass. Note exact count.

- [ ] **Step 2: Run root package tests (regression check)**

```bash
cd /path/to/noma && npm test
```

Expected: all existing tests still pass. The workspace changes must not break the root package.

- [ ] **Step 3: Typecheck both packages**

```bash
npx tsc --noEmit && cd packages/mcp-server && npx tsc --noEmit
```

Expected: no errors from either.

- [ ] **Step 4: Smoke test the server**

Build and run the server with a real document:

```bash
cd packages/mcp-server && npm run build
echo '{"jsonrpc":"2.0","id":1,"method":"tools/list"}' | node dist/index.js
```

Expected: JSON response listing all four tools (`read_doc`, `list_ids`, `validate_doc`, `patch_block`).

- [ ] **Step 5: End-to-end agent loop smoke test**

```bash
FILE=$(realpath ../../examples/agent-plan.noma)
echo "{\"jsonrpc\":\"2.0\",\"id\":2,\"method\":\"tools/call\",\"params\":{\"name\":\"list_ids\",\"arguments\":{\"file\":\"$FILE\"}}}" | node dist/index.js
```

Expected: JSON with `ids` array containing block IDs from `examples/agent-plan.noma`.

- [ ] **Step 6: Final commit**

```bash
git add -p
git commit -m "test(mcp-server): full test suite + smoke verified"
```

---

## Definition of Done

- [ ] `npm test` passes in `packages/mcp-server/` (all tasks 2–7 green)
- [ ] `npx tsc --noEmit` passes in both root and `packages/mcp-server/`
- [ ] Root `npm test` still passes (no regressions)
- [ ] `tools/list` returns 4 tools via stdio JSON-RPC
- [ ] `list_ids` on `examples/agent-plan.noma` returns non-empty ID list
- [ ] `patch_block` with a real op writes byte-preserving result and appends `.noma.patches`
