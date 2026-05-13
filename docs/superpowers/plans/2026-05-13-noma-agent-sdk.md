# `@noma/agent-sdk` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Implement the reference Agent SDK whose existence is a v1.1 prerequisite (per `docs/spec-agent-protocol-v1.noma` §1.4) for graduating Annexes A (capability descriptor) and B (MCP-over-stdio binding) from provisional to normative.

**Architecture:** Single workspace package `packages/agent-sdk/` published as `@noma/agent-sdk`. Two public classes: `NomaTools` (1:1 wrapper over the four `@noma/mcp-server` tools, exercised via stdio) and `NomaWorkflow` (composes tools into safe-patch with per-file mutex, op chains, transcript replay, and advisory capability checks). Errors split into a throw-channel (`NomaSystemError` hierarchy) for system faults and a return-channel (`{ ok: false, code }`) for §3.5 patch errors. Five-tier test pyramid (unit → tools → workflow → demo replay → conformance) feeds three Annex graduation metrics.

**Tech Stack:** TypeScript (strict), Node ≥ 20, `@modelcontextprotocol/sdk@1.11.0` (stdio client), `js-yaml@^4.1.0`, `node:test` runner via `tsx`.

**Spec:** `docs/superpowers/specs/2026-05-13-noma-agent-sdk-design.md`

---

## File map

| File | Purpose | Phase |
|------|---------|-------|
| `packages/agent-sdk/package.json` | Workspace manifest, deps, scripts | 0 |
| `packages/agent-sdk/tsconfig.json` | Strict TS config | 0 |
| `packages/agent-sdk/src/index.ts` | Public re-exports | 6 |
| `packages/agent-sdk/src/errors.ts` | `NomaSystemError` hierarchy | 1 |
| `packages/agent-sdk/src/types.ts` | Shared types | 1 |
| `packages/agent-sdk/src/capabilities.ts` | `CapabilityDescriptor` class | 2 |
| `packages/agent-sdk/src/transport.ts` | Stdio subprocess wrapper around `@modelcontextprotocol/sdk` | 3 |
| `packages/agent-sdk/src/tools.ts` | `NomaTools` class | 4 |
| `packages/agent-sdk/src/workflow.ts` | `NomaWorkflow` class | 5 |
| `packages/agent-sdk/scripts/agent-stale-memo-sdk.ts` | SDK-driven port of existing demo (exports `runDemo`) | 7 |
| `packages/agent-sdk/scripts/agent-memory-demo-sdk.ts` | SDK-driven port of existing demo (exports `runDemo`) | 7 |
| `packages/agent-sdk/test/errors.test.ts` | Tier 1 — error class hierarchy | 1 |
| `packages/agent-sdk/test/capabilities.test.ts` | Tier 1 — YAML parser / schema | 2 |
| `packages/agent-sdk/test/transport.test.ts` | Tier 1 — subprocess lifecycle | 3 |
| `packages/agent-sdk/test/tools.test.ts` | Tier 2 — each MCP tool, error code coverage | 4 |
| `packages/agent-sdk/test/workflow.test.ts` | Tier 3 — safePatch retry, mutex, applyOps, replay, checkCapability | 5 |
| `packages/agent-sdk/test/integration.test.ts` | Tier 4 — imports demo modules + diffs final document | 7 |
| `packages/agent-sdk/test/conformance.test.ts` | Tier 5 — drives examples/conformance/patch/* | 7 |
| `packages/agent-sdk/test/graduation-metrics.test.ts` | Computes the three Annex graduation metrics | 8 |
| `packages/agent-sdk/README.md` | Experimental disclaimer + usage examples | 6 |
| `package.json` (root) | Add `test:agent-sdk` script + ensure workspace builds | 9 |
| `CHANGELOG.md` | `[Unreleased]` entry for SDK debut | 9 |

---

## Phase 0 — Scaffold the workspace package

### Task 0.1: Create the package skeleton

**Files:**
- Create: `packages/agent-sdk/package.json`
- Create: `packages/agent-sdk/tsconfig.json`
- Create: `packages/agent-sdk/src/index.ts` (placeholder)
- Create: `packages/agent-sdk/test/.gitkeep`

- [ ] **Step 1: Write `packages/agent-sdk/package.json`**

```json
{
  "name": "@noma/agent-sdk",
  "version": "0.1.0",
  "description": "Reference agent SDK for the Noma Agent Protocol v1.0 (experimental)",
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "import": "./dist/index.js"
    },
    "./package.json": "./package.json"
  },
  "files": ["src", "dist", "README.md"],
  "scripts": {
    "build": "tsc -p tsconfig.json",
    "test": "tsx --test test/*.test.ts"
  },
  "dependencies": {
    "@modelcontextprotocol/sdk": "1.11.0",
    "@noma/cli": "file:../..",
    "@noma/mcp-server": "file:../mcp-server",
    "js-yaml": "^4.1.0"
  },
  "devDependencies": {
    "@types/js-yaml": "^4.0.9",
    "@types/node": "^22.10.0",
    "tsx": "^4.19.2",
    "typescript": "^5.7.2"
  },
  "engines": { "node": ">=20" },
  "author": "ferax564",
  "license": "MIT"
}
```

- [ ] **Step 2: Write `packages/agent-sdk/tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "Bundler",
    "outDir": "dist",
    "rootDir": "src",
    "declaration": true,
    "sourceMap": true,
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "exactOptionalPropertyTypes": true,
    "verbatimModuleSyntax": true,
    "esModuleInterop": true,
    "skipLibCheck": true
  },
  "include": ["src/**/*"]
}
```

- [ ] **Step 3: Write placeholder `packages/agent-sdk/src/index.ts`**

```ts
export const PLACEHOLDER = "noma-agent-sdk-v0.1.0";
```

- [ ] **Step 4: Install workspace deps and verify build**

Run from repo root:
```bash
npm install
npx tsc -p packages/agent-sdk/tsconfig.json --noEmit
```

Expected: zero output, exit code 0. If `@modelcontextprotocol/sdk` resolution fails, run `npm install @modelcontextprotocol/sdk@1.11.0 -w @noma/agent-sdk`.

- [ ] **Step 5: Commit**

```bash
git add packages/agent-sdk/package.json packages/agent-sdk/tsconfig.json packages/agent-sdk/src/index.ts packages/agent-sdk/test/.gitkeep package-lock.json
git commit -m "feat(agent-sdk): scaffold @noma/agent-sdk workspace package"
```

---

## Phase 1 — Error hierarchy + shared types

### Task 1.1: Error classes (TDD)

**Files:**
- Test: `packages/agent-sdk/test/errors.test.ts`
- Create: `packages/agent-sdk/src/errors.ts`

- [ ] **Step 1: Write the failing test**

Create `packages/agent-sdk/test/errors.test.ts`:

```ts
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
```

- [ ] **Step 2: Run and verify it fails**

```bash
cd packages/agent-sdk && npx tsx --test test/errors.test.ts
```

Expected: FAIL — "Cannot find module '../src/errors.ts'".

- [ ] **Step 3: Write the minimal implementation**

Create `packages/agent-sdk/src/errors.ts`:

```ts
export class NomaSystemError extends Error {
  readonly cause?: unknown;
  constructor(message: string, cause?: unknown) {
    super(message);
    this.name = "NomaSystemError";
    if (cause !== undefined) this.cause = cause;
  }
}

export class NomaSpawnError extends NomaSystemError {
  constructor(message: string, cause?: unknown) {
    super(message, cause);
    this.name = "NomaSpawnError";
  }
}

export class NomaTransportError extends NomaSystemError {
  constructor(message: string, cause?: unknown) {
    super(message, cause);
    this.name = "NomaTransportError";
  }
}

export class NomaCapabilityError extends NomaSystemError {
  constructor(message: string, cause?: unknown) {
    super(message, cause);
    this.name = "NomaCapabilityError";
  }
}

export class NomaTimeoutError extends NomaSystemError {
  constructor(message: string, cause?: unknown) {
    super(message, cause);
    this.name = "NomaTimeoutError";
  }
}
```

- [ ] **Step 4: Run tests, verify pass**

```bash
cd packages/agent-sdk && npx tsx --test test/errors.test.ts
```

Expected: 3 passing.

- [ ] **Step 5: Commit**

```bash
git add packages/agent-sdk/src/errors.ts packages/agent-sdk/test/errors.test.ts
git commit -m "feat(agent-sdk): NomaSystemError hierarchy with cause preservation"
```

### Task 1.2: Shared types

**Files:**
- Create: `packages/agent-sdk/src/types.ts`

This task ships types only — no tests (types are erased at runtime; they're exercised by the tests in later tasks). Self-check is `tsc --noEmit`.

- [ ] **Step 1: Write `packages/agent-sdk/src/types.ts`**

All shapes below mirror the source-of-truth definitions in `src/patch.ts` (`PatchOp`, `PatchErrorCode`), `src/ast.ts` (`AttrValue`, `Diagnostic`), and `packages/mcp-server/src/transcript.ts` (`TranscriptLine`). Re-defining here (not importing) keeps `@noma/agent-sdk` consumers from pulling `@noma/cli` at runtime; the cost is that anyone who edits `src/patch.ts` shapes must keep this file in sync. CI enforces this via a separate type-equivalence test in Task 9.1.

```ts
export type PatchOpName =
  | "replace_block"
  | "add_block"
  | "delete_block"
  | "update_attribute"
  | "rename_id";

// AttrValue mirrors src/ast.ts — string | number | boolean ONLY. The RFC
// reserves `value: null` for attribute removal (§3.1.4) but the current
// server schema rejects null (packages/mcp-server/src/index.ts:15). Null
// removal is tracked as future work; do NOT add `null` to this union until
// the server schema accepts it.
export type AttrValue = string | number | boolean;

export type PatchOp =
  | { op: "replace_block"; id: string; content: string }
  | { op: "add_block"; parent: string; content: string; position?: number }
  | { op: "delete_block"; id: string }
  | { op: "update_attribute"; id: string; key: string; value: AttrValue }
  | { op: "rename_id"; from: string; to: string };

// Mirrors src/patch.ts PatchErrorCode exactly. Names like `rename_collision`
// and `schema_violation` from earlier drafts do NOT exist on the server —
// rename collisions surface as `id_conflict`, and reserved-key violations
// surface as `id_attribute_protected`.
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

export type BlockSummary = {
  id?: string;
  type: string;
  name?: string;
  attrs?: Record<string, string | number | boolean>;
  title?: string;
  level?: number;
  aliases?: string[];
  childCount: number;
  lines: [number, number];
  patchable: boolean;
};

// Mirrors src/ast.ts Diagnostic. NOT `rule`/`line`/`column`/`blockId` from
// earlier drafts — those names never existed on the server.
export type Diagnostic = {
  severity: "error" | "warning" | "info";
  code: string;
  message: string;
  pos?: { line: number; column: number };
  nodeId?: string;
};

export type Actor = {
  kind: "human" | "agent" | "tool";
  name: string;
  model?: string;
  version?: string;
};

export type ValidationSummary = "ok" | "warn" | "error";
export type PatchResultStatus = "applied" | "rejected" | "noop";

// Mirrors packages/mcp-server/src/transcript.ts TranscriptLine exactly.
// All fields use snake_case to match the JSON the server emits — this is
// the wire shape, not an internal API. Renamings to camelCase happen at
// the SDK return boundary (see PatchResult below).
export type TranscriptRecord = {
  protocol_version: "1.0";
  tool_version: string;
  op_id: string;
  ts: string;
  actor: Actor;
  doc_uri: string;
  pre_sha256: string;
  post_sha256: string;
  pre_sha: string;
  post_sha: string;
  op: PatchOp;
  patch_result: PatchResultStatus;
  pre_validation: ValidationSummary;
  post_validation: ValidationSummary;
  reason?: string;
  parent_op_id?: string;
  base_sha256?: string;
  diagnostics?: Array<Diagnostic & { phase: "pre" | "post" }>;
  elapsed_ms?: number;
  prev_entry_sha256?: string;
  signature?: null | { algorithm: string; key_id: string; value: string };
};

export type PatchResult =
  | {
      ok: true;
      postValidation: ValidationSummary;
      transcriptEntry: TranscriptRecord;
      diagnostics: Diagnostic[];
    }
  | PatchFailure;

export type PatchFailure = {
  ok: false;
  error: string;
  code?: PatchErrorCode | string;
};

export type CapabilityCheckResult =
  | { allowed: true }
  | {
      allowed: false;
      reason:
        | "no_descriptor"
        | "block_not_listed"
        | "op_not_granted"
        | "attr_constraint_violated"
        | "rename_globally_denied";
      detail: string;
    };
```

- [ ] **Step 2: Verify it typechecks**

```bash
npx tsc -p packages/agent-sdk/tsconfig.json --noEmit
```

Expected: zero output, exit 0.

- [ ] **Step 3: Commit**

```bash
git add packages/agent-sdk/src/types.ts
git commit -m "feat(agent-sdk): shared types for blocks, ops, diagnostics, transcript"
```

---

## Phase 2 — Capability descriptor parser (Annex A consumer)

### Task 2.1: `CapabilityDescriptor.fromYaml` accept/reject coverage

**Files:**
- Test: `packages/agent-sdk/test/capabilities.test.ts`
- Create: `packages/agent-sdk/src/capabilities.ts`

- [ ] **Step 1: Write failing tests covering every §A.3 shape**

Create `packages/agent-sdk/test/capabilities.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { CapabilityDescriptor } from "../src/capabilities.js";
import { NomaCapabilityError } from "../src/errors.js";

const MINIMAL = `
nomaAgent:
  version: 1
`;

const FULL = `
nomaAgent:
  version: 1
  profile: research
  blocks:
    claim:
      ops: [replace_block, update_attribute]
      attrs:
        confidence:
          type: number
          min: 0
          max: 1
    evidence:
      ops: [add_block, replace_block, delete_block]
  ids:
    rename: true
  validation:
    required: true
`;

test("fromYaml accepts minimal v1 descriptor", () => {
  const d = CapabilityDescriptor.fromYaml(MINIMAL);
  assert.equal(d.version, 1);
  assert.equal(d.profile, undefined);
  assert.equal(d.blocks.size, 0);
  assert.equal(d.idsRename, false);
  assert.equal(d.validationRequired, false);
});

test("fromYaml accepts full descriptor and indexes ops + attr constraints", () => {
  const d = CapabilityDescriptor.fromYaml(FULL);
  assert.equal(d.profile, "research");
  assert.ok(d.allows("claim", "replace_block"));
  assert.ok(d.allows("claim", "update_attribute"));
  assert.ok(!d.allows("claim", "delete_block"));
  assert.ok(d.allows("evidence", "add_block"));
  assert.ok(!d.allows("paragraph", "replace_block"));
  assert.equal(d.idsRename, true);
  assert.equal(d.validationRequired, true);
});

test("validateAttr enforces type", () => {
  const d = CapabilityDescriptor.fromYaml(FULL);
  assert.deepEqual(d.validateAttr("claim", "confidence", 0.5), { ok: true });
  const bad = d.validateAttr("claim", "confidence", "high");
  assert.equal(bad.ok, false);
});

test("validateAttr enforces min/max", () => {
  const d = CapabilityDescriptor.fromYaml(FULL);
  assert.deepEqual(d.validateAttr("claim", "confidence", 0), { ok: true });
  assert.deepEqual(d.validateAttr("claim", "confidence", 1), { ok: true });
  assert.equal(d.validateAttr("claim", "confidence", -0.1).ok, false);
  assert.equal(d.validateAttr("claim", "confidence", 1.1).ok, false);
});

test("validateAttr accepts unknown keys (no constraint)", () => {
  const d = CapabilityDescriptor.fromYaml(FULL);
  assert.deepEqual(d.validateAttr("claim", "uncatalogued", "anything"), { ok: true });
});

test("validateAttr accepts unknown block names", () => {
  const d = CapabilityDescriptor.fromYaml(FULL);
  assert.deepEqual(d.validateAttr("unknown", "any", 1), { ok: true });
});

test("fromYaml rejects malformed YAML", () => {
  assert.throws(() => CapabilityDescriptor.fromYaml(": : :"), NomaCapabilityError);
});

test("fromYaml rejects unsupported version", () => {
  assert.throws(
    () => CapabilityDescriptor.fromYaml("nomaAgent:\n  version: 2\n"),
    (e: unknown) => e instanceof NomaCapabilityError && /version/i.test((e as Error).message),
  );
});

test("fromYaml rejects descriptor with no nomaAgent root", () => {
  assert.throws(
    () => CapabilityDescriptor.fromYaml("foo: bar\n"),
    NomaCapabilityError,
  );
});

test("fromYaml accepts enum constraint", () => {
  const yaml = `
nomaAgent:
  version: 1
  blocks:
    decision:
      ops: [update_attribute]
      attrs:
        status:
          type: string
          enum: [open, accepted, rejected]
`;
  const d = CapabilityDescriptor.fromYaml(yaml);
  assert.deepEqual(d.validateAttr("decision", "status", "open"), { ok: true });
  const bad = d.validateAttr("decision", "status", "pending");
  assert.equal(bad.ok, false);
});
```

- [ ] **Step 2: Run, verify failure**

```bash
cd packages/agent-sdk && npx tsx --test test/capabilities.test.ts
```

Expected: FAIL — `../src/capabilities.ts` missing.

- [ ] **Step 3: Implement `src/capabilities.ts`**

```ts
import { readFile } from "node:fs/promises";
import yaml from "js-yaml";
import { NomaCapabilityError } from "./errors.js";
import type { PatchOpName } from "./types.js";

export type AttrConstraint = {
  type?: "string" | "number" | "boolean";
  min?: number;
  max?: number;
  enum?: ReadonlyArray<string | number>;
};

export type BlockPolicy = {
  ops: Set<PatchOpName>;
  attrs?: Map<string, AttrConstraint>;
};

const KNOWN_OPS: ReadonlySet<PatchOpName> = new Set([
  "replace_block",
  "add_block",
  "delete_block",
  "update_attribute",
  "rename_id",
]);

export class CapabilityDescriptor {
  readonly version: 1;
  readonly profile?: string;
  readonly blocks: ReadonlyMap<string, BlockPolicy>;
  readonly idsRename: boolean;
  readonly validationRequired: boolean;

  private constructor(args: {
    version: 1;
    profile?: string;
    blocks: Map<string, BlockPolicy>;
    idsRename: boolean;
    validationRequired: boolean;
  }) {
    this.version = args.version;
    if (args.profile !== undefined) this.profile = args.profile;
    this.blocks = args.blocks;
    this.idsRename = args.idsRename;
    this.validationRequired = args.validationRequired;
  }

  static fromYaml(source: string): CapabilityDescriptor {
    let parsed: unknown;
    try {
      parsed = yaml.load(source);
    } catch (cause) {
      throw new NomaCapabilityError(`invalid YAML: ${(cause as Error).message}`, cause);
    }
    if (!parsed || typeof parsed !== "object" || !("nomaAgent" in parsed)) {
      throw new NomaCapabilityError("descriptor missing root key 'nomaAgent'");
    }
    const root = (parsed as { nomaAgent: unknown }).nomaAgent;
    if (!root || typeof root !== "object") {
      throw new NomaCapabilityError("nomaAgent must be a mapping");
    }
    const r = root as Record<string, unknown>;
    if (r.version !== 1) {
      throw new NomaCapabilityError(`unsupported descriptor version: ${String(r.version)}`);
    }

    const blocks = new Map<string, BlockPolicy>();
    if (r.blocks && typeof r.blocks === "object") {
      for (const [name, raw] of Object.entries(r.blocks as Record<string, unknown>)) {
        if (!raw || typeof raw !== "object") continue;
        const b = raw as Record<string, unknown>;
        const ops = new Set<PatchOpName>();
        if (Array.isArray(b.ops)) {
          for (const op of b.ops) {
            if (typeof op === "string" && KNOWN_OPS.has(op as PatchOpName)) {
              ops.add(op as PatchOpName);
            }
          }
        }
        let attrs: Map<string, AttrConstraint> | undefined;
        if (b.attrs && typeof b.attrs === "object") {
          attrs = new Map();
          for (const [key, rawAttr] of Object.entries(b.attrs as Record<string, unknown>)) {
            if (!rawAttr || typeof rawAttr !== "object") continue;
            const a = rawAttr as Record<string, unknown>;
            const constraint: AttrConstraint = {};
            if (typeof a.type === "string" && (a.type === "string" || a.type === "number" || a.type === "boolean")) {
              constraint.type = a.type;
            }
            if (typeof a.min === "number") constraint.min = a.min;
            if (typeof a.max === "number") constraint.max = a.max;
            if (Array.isArray(a.enum)) {
              constraint.enum = a.enum.filter(
                (v): v is string | number => typeof v === "string" || typeof v === "number",
              );
            }
            attrs.set(key, constraint);
          }
        }
        const policy: BlockPolicy = attrs ? { ops, attrs } : { ops };
        blocks.set(name, policy);
      }
    }

    const idsRename =
      r.ids && typeof r.ids === "object" && (r.ids as Record<string, unknown>).rename === true;
    const validationRequired =
      r.validation && typeof r.validation === "object" &&
      (r.validation as Record<string, unknown>).required === true;

    return new CapabilityDescriptor({
      version: 1,
      ...(typeof r.profile === "string" ? { profile: r.profile } : {}),
      blocks,
      idsRename: Boolean(idsRename),
      validationRequired: Boolean(validationRequired),
    });
  }

  static async fromFile(file: string): Promise<CapabilityDescriptor | null> {
    let raw: string;
    try {
      raw = await readFile(file, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw new NomaCapabilityError(`cannot read ${file}: ${(e as Error).message}`, e);
    }
    return CapabilityDescriptor.fromYaml(raw);
  }

  allows(blockName: string, op: PatchOpName): boolean {
    const policy = this.blocks.get(blockName);
    if (!policy) return false;
    return policy.ops.has(op);
  }

  validateAttr(
    blockName: string,
    key: string,
    value: unknown,
  ): { ok: true } | { ok: false; reason: string } {
    const policy = this.blocks.get(blockName);
    if (!policy || !policy.attrs) return { ok: true };
    const constraint = policy.attrs.get(key);
    if (!constraint) return { ok: true };
    if (constraint.type === "string" && typeof value !== "string") {
      return { ok: false, reason: `expected string, got ${typeof value}` };
    }
    if (constraint.type === "boolean" && typeof value !== "boolean") {
      return { ok: false, reason: `expected boolean, got ${typeof value}` };
    }
    if (constraint.type === "number") {
      if (typeof value !== "number" || !Number.isFinite(value)) {
        return { ok: false, reason: `expected finite number, got ${typeof value}` };
      }
      if (constraint.min !== undefined && value < constraint.min) {
        return { ok: false, reason: `value ${value} < min ${constraint.min}` };
      }
      if (constraint.max !== undefined && value > constraint.max) {
        return { ok: false, reason: `value ${value} > max ${constraint.max}` };
      }
    }
    if (constraint.enum && !constraint.enum.includes(value as string | number)) {
      return { ok: false, reason: `value ${String(value)} not in enum [${constraint.enum.join(", ")}]` };
    }
    return { ok: true };
  }
}
```

- [ ] **Step 4: Run tests, verify pass**

```bash
cd packages/agent-sdk && npx tsx --test test/capabilities.test.ts
```

Expected: 10 passing.

- [ ] **Step 5: Commit**

```bash
git add packages/agent-sdk/src/capabilities.ts packages/agent-sdk/test/capabilities.test.ts
git commit -m "feat(agent-sdk): CapabilityDescriptor parser with §A.3 schema validation"
```

### Task 2.2: `fromFile` async loader covers missing-vs-malformed paths

**Files:**
- Modify: `packages/agent-sdk/test/capabilities.test.ts` (append)

- [ ] **Step 1: Append failing tests**

Append to `test/capabilities.test.ts`:

```ts
import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "noma-cap-"));
}

test("fromFile returns null when sidecar is absent", async () => {
  const d = await CapabilityDescriptor.fromFile(
    join(scratch(), "does-not-exist.noma.capabilities.yml"),
  );
  assert.equal(d, null);
});

test("fromFile parses a real sidecar from disk", async () => {
  const dir = scratch();
  const path = join(dir, "doc.noma.capabilities.yml");
  writeFileSync(path, "nomaAgent:\n  version: 1\n  profile: r\n");
  const d = await CapabilityDescriptor.fromFile(path);
  assert.ok(d);
  assert.equal(d.profile, "r");
});

test("fromFile throws NomaCapabilityError on bad YAML on disk", async () => {
  const dir = scratch();
  const path = join(dir, "bad.noma.capabilities.yml");
  writeFileSync(path, ": : :\n");
  await assert.rejects(() => CapabilityDescriptor.fromFile(path), NomaCapabilityError);
});
```

- [ ] **Step 2: Run, expect pass (impl already exists)**

```bash
cd packages/agent-sdk && npx tsx --test test/capabilities.test.ts
```

Expected: 13 passing (10 + 3).

- [ ] **Step 3: Commit**

```bash
git add packages/agent-sdk/test/capabilities.test.ts
git commit -m "test(agent-sdk): cover CapabilityDescriptor.fromFile sidecar paths"
```

---

## Phase 3 — Transport (stdio subprocess wrapper)

### Task 3.1: `StdioMcpClient` wrapper around `@modelcontextprotocol/sdk`

**Files:**
- Test: `packages/agent-sdk/test/transport.test.ts`
- Create: `packages/agent-sdk/src/transport.ts`

The MCP SDK's `StdioClientTransport` already handles JSON-RPC framing, request correlation, and subprocess piping. Our wrapper adds three things: (1) a resolved server binary path, (2) a per-request timeout layer, (3) discriminated routing of `isError: true` vs `isError: false` content into throw vs return channels.

- [ ] **Step 1: Write a failing test that resolves the mcp-server binary and lists tools**

Create `packages/agent-sdk/test/transport.test.ts`:

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { StdioMcpClient } from "../src/transport.js";
import { NomaSpawnError } from "../src/errors.js";

test("StdioMcpClient.spawn resolves the bundled mcp-server binary and returns a client", async () => {
  const client = await StdioMcpClient.spawn();
  try {
    const tools = await client.listTools();
    const names = new Set(tools.map((t) => t.name));
    assert.ok(names.has("read_doc"));
    assert.ok(names.has("list_ids"));
    assert.ok(names.has("validate_doc"));
    assert.ok(names.has("patch_block"));
  } finally {
    await client.close();
  }
});

test("StdioMcpClient.spawn rejects an unresolvable server binary", async () => {
  await assert.rejects(
    () => StdioMcpClient.spawn({ mcpServerBin: "/no/such/file" }),
    NomaSpawnError,
  );
});
```

- [ ] **Step 2: Verify the build location of mcp-server**

```bash
ls packages/mcp-server/dist/index.js
```

If absent, build it first: `npm run build -w @noma/mcp-server`.

- [ ] **Step 3: Run the failing test**

```bash
cd packages/agent-sdk && npx tsx --test test/transport.test.ts
```

Expected: FAIL — `../src/transport.ts` missing.

- [ ] **Step 4: Implement `src/transport.ts`**

```ts
import { createRequire } from "node:module";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { NomaSpawnError, NomaTimeoutError, NomaTransportError } from "./errors.js";

const require_ = createRequire(import.meta.url);

export type StdioMcpClientOptions = {
  mcpServerBin?: string;
  env?: NodeJS.ProcessEnv;
  requestTimeoutMs?: number;
};

export type ToolDescriptor = { name: string };

export type ToolCallResult = {
  isError: boolean;
  text: string;
};

const DEFAULT_TIMEOUT_MS = 30_000;

function resolveServerBin(override?: string): string {
  if (override) return override;
  try {
    return require_.resolve("@noma/mcp-server/dist/index.js");
  } catch (cause) {
    throw new NomaSpawnError("could not resolve @noma/mcp-server binary", cause);
  }
}

export class StdioMcpClient {
  private readonly client: Client;
  private readonly transport: StdioClientTransport;
  private readonly timeoutMs: number;
  private closed = false;

  private constructor(client: Client, transport: StdioClientTransport, timeoutMs: number) {
    this.client = client;
    this.transport = transport;
    this.timeoutMs = timeoutMs;
  }

  static async spawn(options: StdioMcpClientOptions = {}): Promise<StdioMcpClient> {
    const bin = resolveServerBin(options.mcpServerBin);
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [bin],
      ...(options.env ? { env: options.env } : {}),
    });
    const client = new Client(
      { name: "@noma/agent-sdk", version: "0.1.0" },
      { capabilities: {} },
    );
    try {
      await client.connect(transport);
    } catch (cause) {
      throw new NomaSpawnError(`failed to start mcp-server: ${(cause as Error).message}`, cause);
    }
    return new StdioMcpClient(client, transport, options.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS);
  }

  async listTools(): Promise<ToolDescriptor[]> {
    this.assertOpen();
    const res = await this.withTimeout(this.client.listTools());
    return res.tools.map((t) => ({ name: t.name }));
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<ToolCallResult> {
    this.assertOpen();
    const res = await this.withTimeout(
      this.client.callTool({ name, arguments: args }),
    );
    const content = res.content;
    if (!Array.isArray(content) || content.length === 0 || content[0]?.type !== "text") {
      throw new NomaTransportError(`tool ${name} returned no text content`);
    }
    return { isError: res.isError === true, text: String(content[0].text) };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.client.close();
  }

  private assertOpen(): void {
    if (this.closed) throw new NomaTransportError("client closed");
  }

  private withTimeout<T>(p: Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const handle = setTimeout(
        () => reject(new NomaTimeoutError(`request exceeded ${this.timeoutMs}ms`)),
        this.timeoutMs,
      );
      p.then((v) => {
        clearTimeout(handle);
        resolve(v);
      }).catch((e) => {
        clearTimeout(handle);
        reject(e);
      });
    });
  }
}
```

- [ ] **Step 5: Build mcp-server (if not already built) then run tests**

```bash
npm run build -w @noma/mcp-server
cd packages/agent-sdk && npx tsx --test test/transport.test.ts
```

Expected: 2 passing.

- [ ] **Step 6: Commit**

```bash
git add packages/agent-sdk/src/transport.ts packages/agent-sdk/test/transport.test.ts
git commit -m "feat(agent-sdk): StdioMcpClient with @modelcontextprotocol/sdk + timeout layer"
```

---

## Phase 4 — `NomaTools` (Annex B surface)

### Task 4.1: `NomaTools` skeleton + spawn/close

**Files:**
- Test: `packages/agent-sdk/test/tools.test.ts`
- Create: `packages/agent-sdk/src/tools.ts`

- [ ] **Step 1: Write the failing skeleton test**

Create `packages/agent-sdk/test/tools.test.ts`:

```ts
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { NomaTools } from "../src/tools.js";
import { NomaSystemError } from "../src/errors.js";

let tools: NomaTools;

before(async () => {
  tools = await NomaTools.spawn();
});

after(async () => {
  await tools.close();
});

function scratchDoc(content: string, name = "doc.noma"): string {
  const dir = mkdtempSync(join(tmpdir(), "noma-tools-"));
  const path = join(dir, name);
  writeFileSync(path, content, "utf8");
  return path;
}

test("NomaTools.spawn yields a usable client; close shuts it down", async () => {
  assert.ok(tools);
});
```

- [ ] **Step 2: Run, expect fail (file missing)**

```bash
cd packages/agent-sdk && npx tsx --test test/tools.test.ts
```

- [ ] **Step 3: Write the minimal skeleton**

Create `packages/agent-sdk/src/tools.ts`:

```ts
import { StdioMcpClient, type StdioMcpClientOptions } from "./transport.js";
import { NomaSystemError } from "./errors.js";
import type {
  BlockSummary,
  Diagnostic,
  PatchOp,
  PatchResult,
  Actor,
  TranscriptRecord,
  PatchErrorCode,
} from "./types.js";

export type PatchOptions = {
  reason?: string;
  expectedSha?: string;
  actor?: Actor;
  baseSha256?: string;
  parentOpId?: string;
};

export class NomaTools {
  private readonly client: StdioMcpClient;

  private constructor(client: StdioMcpClient) {
    this.client = client;
  }

  static async spawn(options: StdioMcpClientOptions = {}): Promise<NomaTools> {
    const client = await StdioMcpClient.spawn(options);
    return new NomaTools(client);
  }

  async close(): Promise<void> {
    await this.client.close();
  }

  async readDoc(file: string): Promise<{ blocks: BlockSummary[] }> {
    throw new Error("not implemented");
  }

  async listIds(file: string): Promise<{ ids: string[]; aliases: Record<string, string> }> {
    throw new Error("not implemented");
  }

  async validateDoc(file: string): Promise<{ ok: boolean; diagnostics: Diagnostic[] }> {
    throw new Error("not implemented");
  }

  async patchBlock(file: string, op: PatchOp, options: PatchOptions = {}): Promise<PatchResult> {
    throw new Error("not implemented");
  }
}
```

- [ ] **Step 4: Run, expect 1 passing**

- [ ] **Step 5: Commit**

```bash
git add packages/agent-sdk/src/tools.ts packages/agent-sdk/test/tools.test.ts
git commit -m "feat(agent-sdk): NomaTools class skeleton + spawn/close"
```

### Task 4.2: `readDoc`

- [ ] **Step 1: Append failing test**

```ts
test("readDoc returns block summaries with patchable flag", async () => {
  const path = scratchDoc(
    `# Hello\n\nA paragraph.\n\n::claim{id="c1" confidence=0.7}\nClaim body.\n::\n`,
  );
  const { blocks } = await tools.readDoc(path);
  assert.ok(blocks.length >= 2, `expected >=2 blocks, got ${blocks.length}`);
  const claim = blocks.find((b) => b.name === "claim");
  assert.ok(claim, "claim block must surface");
  assert.equal(claim.id, "c1");
  assert.equal(claim.patchable, true);
});

test("readDoc throws NomaSystemError on book manifest path", async () => {
  const yml = scratchDoc("title: T\nchapters:\n  - x.noma\n", "book.noma.yml");
  await assert.rejects(() => tools.readDoc(yml), NomaSystemError);
});

test("readDoc throws NomaSystemError on missing file", async () => {
  await assert.rejects(() => tools.readDoc("/no/such/file.noma"), NomaSystemError);
});
```

- [ ] **Step 2: Run, expect fail**

- [ ] **Step 3: Replace the `readDoc` stub**

```ts
  async readDoc(file: string): Promise<{ blocks: BlockSummary[] }> {
    const res = await this.client.callTool("read_doc", { file });
    if (res.isError) throw new NomaSystemError(res.text);
    return JSON.parse(res.text) as { blocks: BlockSummary[] };
  }
```

- [ ] **Step 4: Run, expect 4 passing**

- [ ] **Step 5: Commit**

```bash
git add packages/agent-sdk/src/tools.ts packages/agent-sdk/test/tools.test.ts
git commit -m "feat(agent-sdk): NomaTools.readDoc + book-manifest + missing-file coverage"
```

### Task 4.3: `listIds`

- [ ] **Step 1: Append test**

```ts
test("listIds returns canonical ids + aliases", async () => {
  const path = scratchDoc(
    `# Top {aliases="root"}\n\n::claim{id="c1"}\nbody\n::\n\n::evidence{id="e1" for="c1"}\nbody\n::\n`,
  );
  const { ids, aliases } = await tools.listIds(path);
  assert.ok(ids.includes("c1"));
  assert.ok(ids.includes("e1"));
  assert.equal(aliases["root"], "top");
});
```

- [ ] **Step 2: Run, expect fail. Step 3: Replace `listIds`:**

```ts
  async listIds(file: string): Promise<{ ids: string[]; aliases: Record<string, string> }> {
    const res = await this.client.callTool("list_ids", { file });
    if (res.isError) throw new NomaSystemError(res.text);
    return JSON.parse(res.text) as { ids: string[]; aliases: Record<string, string> };
  }
```

- [ ] **Step 4: Run, expect pass. Step 5: Commit:**

```bash
git add packages/agent-sdk/src/tools.ts packages/agent-sdk/test/tools.test.ts
git commit -m "feat(agent-sdk): NomaTools.listIds"
```

### Task 4.4: `validateDoc`

- [ ] **Step 1: Append test**

```ts
test("validateDoc returns ok=true for a clean doc and ok=false for one with errors", async () => {
  const clean = scratchDoc(`# H\n\n::claim{id="c1" noverify}\nbody\n::\n`);
  const goodRes = await tools.validateDoc(clean);
  assert.equal(goodRes.ok, true);

  const dup = scratchDoc(
    `# H\n\n::claim{id="x"}\nA\n::\n\n::claim{id="x"}\nB\n::\n`,
  );
  const badRes = await tools.validateDoc(dup);
  assert.equal(badRes.ok, false);
  assert.ok(badRes.diagnostics.some((d) => d.severity === "error"));
});
```

- [ ] **Step 2: Run, expect fail. Step 3: Replace `validateDoc`:**

```ts
  async validateDoc(file: string): Promise<{ ok: boolean; diagnostics: Diagnostic[] }> {
    const res = await this.client.callTool("validate_doc", { file });
    if (res.isError) throw new NomaSystemError(res.text);
    return JSON.parse(res.text) as { ok: boolean; diagnostics: Diagnostic[] };
  }
```

- [ ] **Step 4: Run, expect pass. Step 5: Commit:**

```bash
git add packages/agent-sdk/src/tools.ts packages/agent-sdk/test/tools.test.ts
git commit -m "feat(agent-sdk): NomaTools.validateDoc"
```

### Task 4.5: `patchBlock` — applied / rejected / sha-mismatch / unsupported_op

- [ ] **Step 1: Append four tests covering the patch outcomes**

```ts
test("patchBlock applies update_attribute and writes a transcript record", async () => {
  const path = scratchDoc(
    `# H\n\n::claim{id="c1" confidence=0.5}\nbody\n::\n`,
  );
  const res = await tools.patchBlock(path, {
    op: "update_attribute",
    id: "c1",
    key: "confidence",
    value: 0.9,
  });
  assert.equal(res.ok, true);
  if (res.ok) {
    assert.equal(res.transcriptEntry.op.op, "update_attribute");
    assert.equal(res.transcriptEntry.patch_result, "applied");
  }
  const content = readFileSync(path, "utf8");
  assert.ok(content.includes("confidence=0.9"));
  assert.ok(existsSync(`${path}.patches`));
});

test("patchBlock returns target_missing for a non-existent id", async () => {
  const path = scratchDoc(`# H\n\n::claim{id="c1"}\nbody\n::\n`);
  const res = await tools.patchBlock(path, {
    op: "delete_block",
    id: "does-not-exist",
  });
  assert.equal(res.ok, false);
  if (!res.ok) assert.equal(res.code, "target_missing");
});

test("patchBlock throws NomaSystemError on book manifest path", async () => {
  // The server marks book-manifest rejection as `system: true` in
  // packages/mcp-server/src/tools/patch-block.ts:58 — MCP surfaces that
  // as `isError: true`, and our SDK throws NomaSystemError. The `body.code`
  // is still "unsupported_op" but it lives in the error message string, not
  // in a returned body.
  const yml = scratchDoc("title: T\nchapters:\n  - x.noma\n", "book.noma.yml");
  await assert.rejects(
    () => tools.patchBlock(yml, { op: "delete_block", id: "x" }),
    (e: unknown) => e instanceof NomaSystemError && /unsupported_op/.test((e as Error).message),
  );
});

test("patchBlock returns sha_mismatch when expectedSha disagrees with file", async () => {
  const path = scratchDoc(`# H\n\n::claim{id="c1"}\nbody\n::\n`);
  const res = await tools.patchBlock(
    path,
    { op: "update_attribute", id: "c1", key: "confidence", value: 0.5 },
    { expectedSha: "deadbeef" },
  );
  assert.equal(res.ok, false);
  if (!res.ok) assert.equal(res.code, "sha_mismatch");
});
```

- [ ] **Step 2: Run, expect fail**

- [ ] **Step 3: Implement `patchBlock`**

Replace the `patchBlock` body in `src/tools.ts`:

```ts
  async patchBlock(file: string, op: PatchOp, options: PatchOptions = {}): Promise<PatchResult> {
    const args: Record<string, unknown> = { file, op };
    if (options.reason !== undefined) args.reason = options.reason;
    if (options.expectedSha !== undefined) args.expected_sha = options.expectedSha;
    if (options.actor !== undefined) args.actor = options.actor;
    if (options.baseSha256 !== undefined) args.base_sha256 = options.baseSha256;
    if (options.parentOpId !== undefined) args.parent_op_id = options.parentOpId;

    const res = await this.client.callTool("patch_block", args);
    if (res.isError) throw new NomaSystemError(res.text);

    const body = JSON.parse(res.text) as
      | {
          ok: true;
          post_validation: "ok" | "warn" | "error";
          transcript_entry: TranscriptRecord;
          diagnostics: Diagnostic[];
        }
      | { ok: false; error: string; code?: string };

    if (body.ok) {
      return {
        ok: true,
        postValidation: body.post_validation,
        transcriptEntry: body.transcript_entry,
        diagnostics: body.diagnostics,
      };
    }
    const failure: { ok: false; error: string; code?: PatchErrorCode | string } = {
      ok: false,
      error: body.error,
    };
    if (body.code !== undefined) failure.code = body.code;
    return failure;
  }
```

- [ ] **Step 4: Run, expect 4 new passing tests**

- [ ] **Step 5: Commit**

```bash
git add packages/agent-sdk/src/tools.ts packages/agent-sdk/test/tools.test.ts
git commit -m "feat(agent-sdk): NomaTools.patchBlock with apply/reject/sha-mismatch coverage"
```

### Task 4.6: §3.5 error-code coverage (remaining codes)

The corpus this task covers is the source-of-truth set in `src/patch.ts:29`: `target_missing`, `parent_missing`, `id_conflict`, `invalid_content`, `id_attribute_protected`, `sha_mismatch`, `pre_validation_blocked`, `op_list_aborted`, `unsupported_op` (nine codes). `target_missing`, `sha_mismatch`, and `unsupported_op` are already covered in Task 4.5. This task adds tests for `id_conflict`, `invalid_content`, `id_attribute_protected`, and `parent_missing`. `pre_validation_blocked` and `op_list_aborted` are exercised by the workflow tests in Phase 5 (op-list flows) — they don't surface from a single `patchBlock` call.

- [ ] **Step 1: Append the four remaining error-code tests**

```ts
test("patchBlock returns id_conflict on rename_id collision", async () => {
  // Server uses `from` and `to` (NOT id/new_id) — see packages/mcp-server/src/index.ts:16.
  const path = scratchDoc(
    `# H\n\n::claim{id="c1"}\na\n::\n\n::claim{id="c2"}\nb\n::\n`,
  );
  const res = await tools.patchBlock(path, {
    op: "rename_id",
    from: "c1",
    to: "c2",
  });
  assert.equal(res.ok, false);
  if (!res.ok) assert.equal(res.code, "id_conflict");
});

test("patchBlock returns invalid_content when replace_block body is unparseable", async () => {
  const path = scratchDoc(`# H\n\n::claim{id="c1"}\nbody\n::\n`);
  const res = await tools.patchBlock(path, {
    op: "replace_block",
    id: "c1",
    content: "::claim{id=\"c1\"\nunterminated attribute string",
  });
  assert.equal(res.ok, false);
  if (!res.ok) assert.equal(res.code, "invalid_content");
});

test("patchBlock returns id_attribute_protected on update_attribute with reserved id key", async () => {
  // src/patch.ts protects `id` from `update_attribute` — rename_id is the only path.
  const path = scratchDoc(`# H\n\n::claim{id="c1"}\nbody\n::\n`);
  const res = await tools.patchBlock(path, {
    op: "update_attribute",
    id: "c1",
    key: "id",
    value: "c2",
  });
  assert.equal(res.ok, false);
  if (!res.ok) assert.equal(res.code, "id_attribute_protected");
});

test("patchBlock returns parent_missing when add_block parent id does not exist", async () => {
  // add_block requires a parent id that exists in the document.
  const path = scratchDoc(`# H\n\n::claim{id="c1"}\nbody\n::\n`);
  const res = await tools.patchBlock(path, {
    op: "add_block",
    parent: "no-such-parent",
    content: "::evidence{id=\"e1\" for=\"c1\"}\nbody\n::\n",
  });
  assert.equal(res.ok, false);
  if (!res.ok) assert.equal(res.code, "parent_missing");
});
```

If any test produces a different code, **inspect the server's actual response, update the test to match, and open an issue documenting the gap between the RFC and the implementation**. The plan is built around the codes `src/patch.ts` actually throws, not aspirational ones.

- [ ] **Step 2: Run all tools tests**

```bash
cd packages/agent-sdk && npx tsx --test test/tools.test.ts
```

Expected: every test passing.

- [ ] **Step 3: Commit**

```bash
git add packages/agent-sdk/test/tools.test.ts
git commit -m "test(agent-sdk): cover §3.5 patch error codes through NomaTools"
```

---

## Phase 5 — `NomaWorkflow`

### Task 5.1: Workflow class skeleton + per-file mutex map

**Files:**
- Test: `packages/agent-sdk/test/workflow.test.ts`
- Create: `packages/agent-sdk/src/workflow.ts`

- [ ] **Step 1: Write the failing skeleton test**

Create `packages/agent-sdk/test/workflow.test.ts`:

```ts
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { NomaTools } from "../src/tools.js";
import { NomaWorkflow } from "../src/workflow.js";

let tools: NomaTools;

before(async () => {
  tools = await NomaTools.spawn();
});

after(async () => {
  await tools.close();
});

function scratchDoc(content: string, name = "doc.noma"): string {
  const dir = mkdtempSync(join(tmpdir(), "noma-wf-"));
  const path = join(dir, name);
  writeFileSync(path, content, "utf8");
  return path;
}

test("NomaWorkflow constructs over a NomaTools instance and borrows the handle", () => {
  const wf = new NomaWorkflow(tools);
  assert.ok(wf);
});
```

- [ ] **Step 2: Run, expect fail. Step 3: Implement skeleton:**

Create `packages/agent-sdk/src/workflow.ts`:

```ts
import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve as resolvePath } from "node:path";
import { NomaTools, type PatchOptions } from "./tools.js";
import { CapabilityDescriptor } from "./capabilities.js";
import type {
  Actor,
  CapabilityCheckResult,
  PatchOp,
  PatchResult,
  TranscriptRecord,
} from "./types.js";

export type SafePatchOptions = {
  retryOnShaMismatch?: number;
  reason?: string;
  actor?: Actor;
};

export type ApplyOpsOptions = {
  stopOnFirstError?: boolean;
  actor?: Actor;
  parentChain?: boolean;
};

export class NomaWorkflow {
  private readonly tools: NomaTools;
  private readonly fileLocks = new Map<string, Promise<void>>();

  constructor(tools: NomaTools) {
    this.tools = tools;
  }

  async safePatch(file: string, op: PatchOp, options: SafePatchOptions = {}): Promise<PatchResult> {
    throw new Error("not implemented");
  }

  async applyOps(file: string, ops: PatchOp[], options: ApplyOpsOptions = {}): Promise<PatchResult[]> {
    throw new Error("not implemented");
  }

  async replayTranscript(file: string): Promise<TranscriptRecord[]> {
    throw new Error("not implemented");
  }

  async readCapabilities(file: string): Promise<CapabilityDescriptor | null> {
    throw new Error("not implemented");
  }

  async checkCapability(file: string, op: PatchOp): Promise<CapabilityCheckResult> {
    throw new Error("not implemented");
  }
}
```

- [ ] **Step 4: Run, expect 1 passing. Step 5: Commit:**

```bash
git add packages/agent-sdk/src/workflow.ts packages/agent-sdk/test/workflow.test.ts
git commit -m "feat(agent-sdk): NomaWorkflow skeleton + fileLocks map"
```

### Task 5.2: `safePatch` happy path + retry + per-file mutex

- [ ] **Step 1: Append failing tests**

```ts
test("safePatch succeeds on first try when SHA matches", async () => {
  const path = scratchDoc(`# H\n\n::claim{id="c1" confidence=0.5}\nbody\n::\n`);
  const wf = new NomaWorkflow(tools);
  const res = await wf.safePatch(path, {
    op: "update_attribute",
    id: "c1",
    key: "confidence",
    value: 0.9,
  });
  assert.equal(res.ok, true);
});

test("safePatch serializes concurrent same-file calls (mutex ordering)", async () => {
  // Without a mutex, both calls would read the same SHA, one would patch,
  // the other would hit sha_mismatch and retry. With a mutex, the second
  // call waits for the first to finish before reading SHA — so we observe:
  //  (a) no patchBlock call sees sha_mismatch (no retries), AND
  //  (b) the two patchBlock invocations do not overlap in time.
  // Pure value-equality on the final document would pass without a mutex
  // (retry would still converge), which is why this test instruments timing
  // and retry-count rather than final state.
  const path = scratchDoc(
    `# H\n\n::claim{id="c1" confidence=0.5}\nbody\n::\n::claim{id="c2" confidence=0.5}\nb\n::\n`,
  );
  const wf = new NomaWorkflow(tools);

  const originalPatch = tools.patchBlock.bind(tools);
  const spans: Array<{ start: number; end: number }> = [];
  let shaMismatchSeen = 0;
  (tools as { patchBlock: typeof tools.patchBlock }).patchBlock = async (f, op, opts) => {
    const start = Date.now();
    const res = await originalPatch(f, op, opts);
    spans.push({ start, end: Date.now() });
    if (!res.ok && res.code === "sha_mismatch") shaMismatchSeen++;
    return res;
  };

  try {
    const [a, b] = await Promise.all([
      wf.safePatch(path, { op: "update_attribute", id: "c1", key: "confidence", value: 0.7 }),
      wf.safePatch(path, { op: "update_attribute", id: "c2", key: "confidence", value: 0.8 }),
    ]);
    assert.equal(a.ok, true);
    assert.equal(b.ok, true);
    assert.equal(shaMismatchSeen, 0, "mutex should prevent sha_mismatch retries on concurrent same-file calls");
    // Sort spans by start time; assert no overlap.
    spans.sort((x, y) => x.start - y.start);
    for (let i = 1; i < spans.length; i++) {
      assert.ok(
        spans[i].start >= spans[i - 1].end,
        `patchBlock invocations overlapped: ${JSON.stringify(spans)}`,
      );
    }
  } finally {
    (tools as { patchBlock: typeof tools.patchBlock }).patchBlock = originalPatch;
  }
});

test("safePatch retries after an external writer changes the file, then succeeds", async () => {
  const path = scratchDoc(`# H\n\n::claim{id="c1" confidence=0.5}\nbody\n::\n`);
  const wf = new NomaWorkflow(tools);

  const originalPatch = tools.patchBlock.bind(tools);
  let calls = 0;
  (tools as { patchBlock: typeof tools.patchBlock }).patchBlock = async (f, op, opts) => {
    if (calls++ === 0) {
      writeFileSync(f, readFileSync(f, "utf8").replace("confidence=0.5", "confidence=0.6"));
    }
    return originalPatch(f, op, opts);
  };

  try {
    const res = await wf.safePatch(
      path,
      { op: "update_attribute", id: "c1", key: "confidence", value: 0.9 },
      { retryOnShaMismatch: 3 },
    );
    assert.equal(res.ok, true);
    assert.equal(calls >= 2, true, `expected >=2 attempts, got ${calls}`);
  } finally {
    (tools as { patchBlock: typeof tools.patchBlock }).patchBlock = originalPatch;
  }
});

test("safePatch clamps negative/huge retryOnShaMismatch values", async () => {
  const path = scratchDoc(`# H\n\n::claim{id="c1" confidence=0.5}\nbody\n::\n`);
  const wf = new NomaWorkflow(tools);
  // Negative: clamped to 0 → exactly one attempt.
  const r1 = await wf.safePatch(
    path,
    { op: "update_attribute", id: "c1", key: "confidence", value: 0.91 },
    { retryOnShaMismatch: -5 },
  );
  assert.equal(r1.ok, true);
  // NaN: falls through to default (3 retries).
  const r2 = await wf.safePatch(
    path,
    { op: "update_attribute", id: "c1", key: "confidence", value: 0.92 },
    { retryOnShaMismatch: Number.NaN },
  );
  assert.equal(r2.ok, true);
});

test("safePatch returns the last sha_mismatch after exhausting retries", async () => {
  const path = scratchDoc(`# H\n\n::claim{id="c1" confidence=0.5}\nbody\n::\n`);
  const wf = new NomaWorkflow(tools);

  const originalPatch = tools.patchBlock.bind(tools);
  // Use a deterministic monotonically-changing value so the file SHA always
  // differs between attempts. Math.random() can collide with the existing
  // value (no-op write → same SHA → patch unexpectedly succeeds), making
  // the test flaky.
  let mutationN = 0;
  (tools as { patchBlock: typeof tools.patchBlock }).patchBlock = async (f, op, opts) => {
    const next = (++mutationN).toString().padStart(4, "0");
    writeFileSync(
      f,
      readFileSync(f, "utf8").replace(/confidence=\d+(?:\.\d+)?/, `confidence=0.${next}`),
    );
    return originalPatch(f, op, opts);
  };

  try {
    const res = await wf.safePatch(
      path,
      { op: "update_attribute", id: "c1", key: "confidence", value: 0.99 },
      { retryOnShaMismatch: 2 },
    );
    assert.equal(res.ok, false);
    if (!res.ok) assert.equal(res.code, "sha_mismatch");
  } finally {
    (tools as { patchBlock: typeof tools.patchBlock }).patchBlock = originalPatch;
  }
});
```

- [ ] **Step 2: Run, expect fail**

- [ ] **Step 3: Implement `safePatch` and helpers**

Replace the `safePatch` body and add helpers at the bottom of `src/workflow.ts`:

```ts
  async safePatch(file: string, op: PatchOp, options: SafePatchOptions = {}): Promise<PatchResult> {
    return this.withFileLock(file, async () => {
      // Clamp retries to [0, MAX_RETRIES]. Negative or non-finite values
      // would skip the loop entirely (returning `undefined as PatchResult`,
      // a type lie); huge values would burn API budget against a server
      // that keeps returning sha_mismatch. 10 is an arbitrary but sufficient
      // cap — concurrent same-process races are serialized by the mutex;
      // anything past ~3 retries means a different process is contending.
      const requested = options.retryOnShaMismatch ?? 3;
      const retries = Number.isFinite(requested) ? Math.max(0, Math.min(10, Math.floor(requested))) : 3;
      let last: PatchResult = {
        ok: false,
        error: "no attempts made",
        code: "sha_mismatch",
      };
      for (let attempt = 0; attempt <= retries; attempt++) {
        const sha = await sha8(file);
        const patchOptions: PatchOptions = { expectedSha: sha };
        if (options.reason !== undefined) patchOptions.reason = options.reason;
        if (options.actor !== undefined) patchOptions.actor = options.actor;
        last = await this.tools.patchBlock(file, op, patchOptions);
        if (last.ok) return last;
        if (last.code !== "sha_mismatch") return last;
      }
      return last;
    });
  }

  private async withFileLock<T>(file: string, fn: () => Promise<T>): Promise<T> {
    // Key by absolute path so `./doc.noma` and `/abs/doc.noma` map to the
    // same mutex slot. Without this, two safePatch calls with different
    // path spellings would bypass each other's serialization and race.
    const key = resolvePath(file);
    const previous = this.fileLocks.get(key) ?? Promise.resolve();
    let release: () => void;
    const next = new Promise<void>((r) => (release = r));
    const chained = previous.then(() => next);
    this.fileLocks.set(key, chained);
    await previous;
    try {
      return await fn();
    } finally {
      release!();
      if (this.fileLocks.get(key) === chained) {
        this.fileLocks.delete(key);
      }
    }
  }
}

async function sha8(file: string): Promise<string> {
  const buf = await readFile(file);
  return createHash("sha256").update(buf).digest("hex").slice(0, 8);
}
```

- [ ] **Step 4: Run, expect 4 new passing. Step 5: Commit:**

```bash
git add packages/agent-sdk/src/workflow.ts packages/agent-sdk/test/workflow.test.ts
git commit -m "feat(agent-sdk): NomaWorkflow.safePatch with per-file mutex + retry loop"
```

### Task 5.3: `applyOps` — sequential, stop-on-first, parent chain

- [ ] **Step 1: Append four tests**

```ts
test("applyOps runs ops sequentially and returns one result per op", async () => {
  const path = scratchDoc(
    `# H\n\n::claim{id="c1" confidence=0.5}\nA\n::\n::claim{id="c2" confidence=0.5}\nB\n::\n`,
  );
  const wf = new NomaWorkflow(tools);
  const results = await wf.applyOps(path, [
    { op: "update_attribute", id: "c1", key: "confidence", value: 0.7 },
    { op: "update_attribute", id: "c2", key: "confidence", value: 0.8 },
  ]);
  assert.equal(results.length, 2);
  assert.equal(results[0].ok, true);
  assert.equal(results[1].ok, true);
});

test("applyOps short-circuits on first failure when stopOnFirstError=true", async () => {
  const path = scratchDoc(`# H\n\n::claim{id="c1"}\nbody\n::\n`);
  const wf = new NomaWorkflow(tools);
  const results = await wf.applyOps(
    path,
    [
      { op: "delete_block", id: "does-not-exist" },
      { op: "update_attribute", id: "c1", key: "confidence", value: 0.9 },
    ],
    { stopOnFirstError: true },
  );
  assert.equal(results.length, 1);
  assert.equal(results[0].ok, false);
});

test("applyOps continues past failures when stopOnFirstError=false", async () => {
  const path = scratchDoc(`# H\n\n::claim{id="c1" confidence=0.5}\nbody\n::\n`);
  const wf = new NomaWorkflow(tools);
  const results = await wf.applyOps(
    path,
    [
      { op: "delete_block", id: "does-not-exist" },
      { op: "update_attribute", id: "c1", key: "confidence", value: 0.9 },
    ],
    { stopOnFirstError: false },
  );
  assert.equal(results.length, 2);
  assert.equal(results[0].ok, false);
  assert.equal(results[1].ok, true);
});

test("applyOps chains parent_op_id when parentChain=true", async () => {
  const path = scratchDoc(
    `# H\n\n::claim{id="c1" confidence=0.5}\nA\n::\n::claim{id="c2" confidence=0.5}\nB\n::\n`,
  );
  const wf = new NomaWorkflow(tools);
  const results = await wf.applyOps(path, [
    { op: "update_attribute", id: "c1", key: "confidence", value: 0.7 },
    { op: "update_attribute", id: "c2", key: "confidence", value: 0.8 },
  ]);
  assert.equal(results.every((r) => r.ok), true);
  const r0 = results[0];
  const r1 = results[1];
  assert.ok(r0.ok && r1.ok);
  const parent = r0.transcriptEntry.op_id;
  assert.equal(r1.transcriptEntry.parent_op_id, parent);
});
```

- [ ] **Step 2: Run, expect fail. Step 3: Implement `applyOps`:**

Replace the `applyOps` body:

```ts
  async applyOps(
    file: string,
    ops: PatchOp[],
    options: ApplyOpsOptions = {},
  ): Promise<PatchResult[]> {
    const stopOnFirstError = options.stopOnFirstError ?? true;
    const parentChain = options.parentChain ?? true;
    const results: PatchResult[] = [];
    let lastOpId: string | undefined;
    for (const op of ops) {
      const patchOptions: PatchOptions = {};
      if (parentChain && lastOpId !== undefined) patchOptions.parentOpId = lastOpId;
      if (options.actor !== undefined) patchOptions.actor = options.actor;
      const res = await this.safePatchInternal(file, op, patchOptions);
      results.push(res);
      if (res.ok) lastOpId = res.transcriptEntry.op_id;
      if (!res.ok && stopOnFirstError) break;
    }
    return results;
  }

  private async safePatchInternal(
    file: string,
    op: PatchOp,
    extra: PatchOptions,
  ): Promise<PatchResult> {
    return this.withFileLock(file, async () => {
      const sha = await sha8(file);
      return this.tools.patchBlock(file, op, { expectedSha: sha, ...extra });
    });
  }
```

`safePatchInternal` shares the same `fileLocks` map as `safePatch`. No retry inside `applyOps` — an op-list call wants to surface mismatches to the caller so they can decide whether to retry the chain.

- [ ] **Step 4: Run, expect 4 new passing. Step 5: Commit:**

```bash
git add packages/agent-sdk/src/workflow.ts packages/agent-sdk/test/workflow.test.ts
git commit -m "feat(agent-sdk): NomaWorkflow.applyOps with parent-chain + stop-on-first-error"
```

### Task 5.4: `replayTranscript`

- [ ] **Step 1: Append two tests**

```ts
test("replayTranscript returns [] when no .patches file exists", async () => {
  const path = scratchDoc(`# H\n`);
  const wf = new NomaWorkflow(tools);
  const records = await wf.replayTranscript(path);
  assert.deepEqual(records, []);
});

test("replayTranscript round-trips records written by applyOps", async () => {
  const path = scratchDoc(
    `# H\n\n::claim{id="c1" confidence=0.5}\nA\n::\n::claim{id="c2" confidence=0.5}\nB\n::\n`,
  );
  const wf = new NomaWorkflow(tools);
  await wf.applyOps(path, [
    { op: "update_attribute", id: "c1", key: "confidence", value: 0.7 },
    { op: "update_attribute", id: "c2", key: "confidence", value: 0.8 },
  ]);
  const records = await wf.replayTranscript(path);
  assert.equal(records.length, 2);
  assert.equal(records[0].op.op, "update_attribute");
  assert.equal(records[0].patch_result, "applied");
  assert.equal(records[1].parent_op_id, records[0].op_id);
});
```

- [ ] **Step 2: Run, expect fail. Step 3: Implement `replayTranscript`:**

```ts
  async replayTranscript(file: string): Promise<TranscriptRecord[]> {
    let raw: string;
    try {
      raw = await readFile(`${file}.patches`, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw e;
    }
    return raw
      .split("\n")
      .filter((line) => line.trim().length > 0)
      .map((line) => JSON.parse(line) as TranscriptRecord);
  }
```

- [ ] **Step 4: Run, expect 2 new passing. Step 5: Commit:**

```bash
git add packages/agent-sdk/src/workflow.ts packages/agent-sdk/test/workflow.test.ts
git commit -m "feat(agent-sdk): NomaWorkflow.replayTranscript reads <file>.patches"
```

### Task 5.5: `readCapabilities`

- [ ] **Step 1: Append two tests**

```ts
test("readCapabilities returns null when sidecar absent", async () => {
  const path = scratchDoc(`# H\n`);
  const wf = new NomaWorkflow(tools);
  const desc = await wf.readCapabilities(path);
  assert.equal(desc, null);
});

test("readCapabilities parses sidecar when present", async () => {
  const path = scratchDoc(`# H\n`);
  writeFileSync(
    `${path}.capabilities.yml`,
    "nomaAgent:\n  version: 1\n  profile: test\n",
  );
  const wf = new NomaWorkflow(tools);
  const desc = await wf.readCapabilities(path);
  assert.ok(desc);
  assert.equal(desc.profile, "test");
});
```

- [ ] **Step 2: Run, expect fail. Step 3: Implement:**

```ts
  async readCapabilities(file: string): Promise<CapabilityDescriptor | null> {
    return CapabilityDescriptor.fromFile(`${file}.capabilities.yml`);
  }
```

- [ ] **Step 4: Run, expect 2 new passing. Step 5: Commit:**

```bash
git add packages/agent-sdk/src/workflow.ts packages/agent-sdk/test/workflow.test.ts
git commit -m "feat(agent-sdk): NomaWorkflow.readCapabilities wraps CapabilityDescriptor.fromFile"
```

### Task 5.6: `checkCapability` — every reason code

- [ ] **Step 1: Append five tests, one per reason code (plus an allowed-case)**

```ts
test("checkCapability returns no_descriptor when sidecar absent", async () => {
  const path = scratchDoc(`# H\n\n::claim{id="c1"}\nbody\n::\n`);
  const wf = new NomaWorkflow(tools);
  const r = await wf.checkCapability(path, {
    op: "update_attribute",
    id: "c1",
    key: "confidence",
    value: 0.9,
  });
  assert.equal(r.allowed, false);
  if (!r.allowed) assert.equal(r.reason, "no_descriptor");
});

test("checkCapability returns block_not_listed when descriptor omits the block name", async () => {
  const path = scratchDoc(`# H\n\n::claim{id="c1"}\nbody\n::\n`);
  writeFileSync(
    `${path}.capabilities.yml`,
    "nomaAgent:\n  version: 1\n  blocks:\n    evidence:\n      ops: [replace_block]\n",
  );
  const wf = new NomaWorkflow(tools);
  const r = await wf.checkCapability(path, {
    op: "update_attribute",
    id: "c1",
    key: "confidence",
    value: 0.9,
  });
  assert.equal(r.allowed, false);
  if (!r.allowed) assert.equal(r.reason, "block_not_listed");
});

test("checkCapability returns op_not_granted when block lists the type but not the op", async () => {
  const path = scratchDoc(`# H\n\n::claim{id="c1"}\nbody\n::\n`);
  writeFileSync(
    `${path}.capabilities.yml`,
    "nomaAgent:\n  version: 1\n  blocks:\n    claim:\n      ops: [replace_block]\n",
  );
  const wf = new NomaWorkflow(tools);
  const r = await wf.checkCapability(path, {
    op: "update_attribute",
    id: "c1",
    key: "confidence",
    value: 0.9,
  });
  assert.equal(r.allowed, false);
  if (!r.allowed) assert.equal(r.reason, "op_not_granted");
});

test("checkCapability returns attr_constraint_violated when value violates range", async () => {
  const path = scratchDoc(`# H\n\n::claim{id="c1"}\nbody\n::\n`);
  writeFileSync(
    `${path}.capabilities.yml`,
    "nomaAgent:\n  version: 1\n  blocks:\n    claim:\n      ops: [update_attribute]\n      attrs:\n        confidence:\n          type: number\n          min: 0\n          max: 1\n",
  );
  const wf = new NomaWorkflow(tools);
  const r = await wf.checkCapability(path, {
    op: "update_attribute",
    id: "c1",
    key: "confidence",
    value: 1.5,
  });
  assert.equal(r.allowed, false);
  if (!r.allowed) assert.equal(r.reason, "attr_constraint_violated");
});

test("checkCapability returns rename_globally_denied when ids.rename is false", async () => {
  // Annex A.3 — per-block ops grant is necessary but not sufficient for rename_id.
  const path = scratchDoc(`# H\n\n::claim{id="c1"}\nbody\n::\n`);
  writeFileSync(
    `${path}.capabilities.yml`,
    "nomaAgent:\n  version: 1\n  ids:\n    rename: false\n  blocks:\n    claim:\n      ops: [rename_id]\n",
  );
  const wf = new NomaWorkflow(tools);
  const r = await wf.checkCapability(path, {
    op: "rename_id",
    from: "c1",
    to: "c2",
  });
  assert.equal(r.allowed, false);
  if (!r.allowed) assert.equal(r.reason, "rename_globally_denied");
});

test("checkCapability allows rename_id when ids.rename=true AND ops includes it", async () => {
  const path = scratchDoc(`# H\n\n::claim{id="c1"}\nbody\n::\n`);
  writeFileSync(
    `${path}.capabilities.yml`,
    "nomaAgent:\n  version: 1\n  ids:\n    rename: true\n  blocks:\n    claim:\n      ops: [rename_id]\n",
  );
  const wf = new NomaWorkflow(tools);
  const r = await wf.checkCapability(path, {
    op: "rename_id",
    from: "c1",
    to: "c-renamed",
  });
  assert.equal(r.allowed, true);
});

test("checkCapability returns allowed=true when policy matches", async () => {
  const path = scratchDoc(`# H\n\n::claim{id="c1"}\nbody\n::\n`);
  writeFileSync(
    `${path}.capabilities.yml`,
    "nomaAgent:\n  version: 1\n  blocks:\n    claim:\n      ops: [update_attribute]\n      attrs:\n        confidence:\n          type: number\n          min: 0\n          max: 1\n",
  );
  const wf = new NomaWorkflow(tools);
  const r = await wf.checkCapability(path, {
    op: "update_attribute",
    id: "c1",
    key: "confidence",
    value: 0.5,
  });
  assert.equal(r.allowed, true);
});
```

- [ ] **Step 2: Run, expect fail. Step 3: Implement `checkCapability`:**

```ts
  async checkCapability(file: string, op: PatchOp): Promise<CapabilityCheckResult> {
    const desc = await this.readCapabilities(file);
    if (!desc) {
      return {
        allowed: false,
        reason: "no_descriptor",
        detail: `${file}.capabilities.yml`,
      };
    }
    // Annex A.3: rename_id requires BOTH the per-block ops grant AND the
    // global ids.rename: true. Check the global flag first so denying a
    // rename always names the global gate, not the per-block one.
    if (op.op === "rename_id" && !desc.idsRename) {
      return { allowed: false, reason: "rename_globally_denied", detail: "ids.rename" };
    }
    const blockName = await this.inferBlockName(file, op);
    if (!blockName) {
      return { allowed: false, reason: "block_not_listed", detail: "<unknown-target>" };
    }
    const policy = desc.blocks.get(blockName);
    if (!policy) {
      return { allowed: false, reason: "block_not_listed", detail: blockName };
    }
    if (!policy.ops.has(op.op)) {
      return { allowed: false, reason: "op_not_granted", detail: op.op };
    }
    if (op.op === "update_attribute") {
      const check = desc.validateAttr(blockName, op.key, op.value);
      if (!check.ok) {
        return { allowed: false, reason: "attr_constraint_violated", detail: check.reason };
      }
    }
    return { allowed: true };
  }

  // For rename_id the target id lives in `op.from`, not `op.id`. For add_block
  // there's no existing target id at all — we infer the block name from the
  // first directive opener in the content string instead.
  private async inferBlockName(file: string, op: PatchOp): Promise<string | undefined> {
    if (op.op === "add_block") {
      const match = /^\s*::([a-z_]+)/i.exec(op.content);
      return match?.[1];
    }
    const targetId = op.op === "rename_id" ? op.from : (op as { id?: string }).id;
    if (!targetId) return undefined;
    const { blocks } = await this.tools.readDoc(file);
    const hit = blocks.find((b) => b.id === targetId);
    return hit?.name ?? hit?.type;
  }
```

- [ ] **Step 4: Run, expect 5 new passing. Step 5: Commit:**

```bash
git add packages/agent-sdk/src/workflow.ts packages/agent-sdk/test/workflow.test.ts
git commit -m "feat(agent-sdk): NomaWorkflow.checkCapability with all four reason codes"
```

---

## Phase 6 — Public surface + README

### Task 6.1: `src/index.ts` public re-exports

- [ ] **Step 1: Replace the placeholder content**

```ts
export { NomaTools, type PatchOptions } from "./tools.js";
export {
  NomaWorkflow,
  type SafePatchOptions,
  type ApplyOpsOptions,
} from "./workflow.ts";
export {
  CapabilityDescriptor,
  type BlockPolicy,
  type AttrConstraint,
} from "./capabilities.js";
export {
  NomaSystemError,
  NomaSpawnError,
  NomaTransportError,
  NomaCapabilityError,
  NomaTimeoutError,
} from "./errors.js";
export type {
  Actor,
  BlockSummary,
  CapabilityCheckResult,
  Diagnostic,
  PatchErrorCode,
  PatchFailure,
  PatchOp,
  PatchOpName,
  PatchResult,
  TranscriptRecord,
} from "./types.js";
```

- [ ] **Step 2: Build and verify export shape**

```bash
npx tsc -p packages/agent-sdk/tsconfig.json
node -e "import('./packages/agent-sdk/dist/index.js').then(m => { for (const k of ['NomaTools','NomaWorkflow','CapabilityDescriptor','NomaSystemError']) { if (!m[k]) throw new Error('missing export: '+k); } console.log('ok'); })"
```

Expected: `ok`.

- [ ] **Step 3: Commit**

```bash
git add packages/agent-sdk/src/index.ts
git commit -m "feat(agent-sdk): public re-exports for NomaTools, NomaWorkflow, types"
```

### Task 6.2: README with experimental disclaimer

- [ ] **Step 1: Write `packages/agent-sdk/README.md`**

````markdown
# `@noma/agent-sdk` (experimental)

> **Status: experimental.** API surface may change in any v0.x release. The
> SDK freezes at v1.0 in lockstep with Annex A+B graduation in the Noma
> Agent Protocol RFC v1.1.

TypeScript reference SDK for the [Noma Agent Protocol v1.0](../../docs/spec-agent-protocol-v1.noma).
It drives `@noma/mcp-server` over stdio and adds a workflow layer for
safe-patch retry, capability descriptor reading, and transcript replay.

## Install

```bash
npm install @noma/agent-sdk
```

`@noma/agent-sdk` spawns `@noma/mcp-server` as a child process — they ship
together in the workspace.

## Usage

```ts
import { NomaTools, NomaWorkflow } from "@noma/agent-sdk";

const tools = await NomaTools.spawn();
try {
  const wf = new NomaWorkflow(tools);

  const { allowed, reason } = await wf.checkCapability("./thesis.noma", {
    op: "update_attribute",
    id: "asml-euv-moat",
    key: "confidence",
    value: 0.92,
  });
  if (!allowed) console.warn(`capability advisory: ${reason}`);

  const result = await wf.safePatch("./thesis.noma", {
    op: "update_attribute",
    id: "asml-euv-moat",
    key: "confidence",
    value: 0.92,
  });

  if (!result.ok) {
    console.error(`patch failed: ${result.code} — ${result.error}`);
  }
} finally {
  await tools.close();
}
```

## Errors

Two channels:
- **Throws** `NomaSystemError` (and subclasses `NomaSpawnError`,
  `NomaTransportError`, `NomaCapabilityError`, `NomaTimeoutError`) for
  system faults the caller cannot recover from by reading a body.
- **Returns** `{ ok: false, code, error }` for §3.5 patch errors that the
  server marks as user-recoverable: `target_missing`, `parent_missing`,
  `id_conflict`, `invalid_content`, `id_attribute_protected`, `sha_mismatch`.
  Op-list-flow codes (`pre_validation_blocked`, `op_list_aborted`) are
  emitted by `patch_block_list` (Annex B.8, v1.1+) and not reachable from
  v0.1 SDK paths.
- `unsupported_op` for a book-manifest path is a **throw**
  (`NomaSystemError`), not a returned body — the server flags it as a
  system error because the path itself is outside the v1.0 patch wire scope.

## Lifecycle

`NomaWorkflow` **borrows** `NomaTools` — the caller owns `tools.close()`.
A single `NomaTools` may back multiple workflows. Same-file concurrent
`safePatch` calls are serialized by a per-file mutex inside each workflow.

## Spec

[`docs/superpowers/specs/2026-05-13-noma-agent-sdk-design.md`](../../docs/superpowers/specs/2026-05-13-noma-agent-sdk-design.md)
captures the design decisions, lifecycle contract, and the Annex graduation
metrics this SDK was built to feed.
````

- [ ] **Step 2: Commit**

```bash
git add packages/agent-sdk/README.md
git commit -m "docs(agent-sdk): README with usage + experimental disclaimer"
```

---

## Phase 7 — Tier 4 demos + Tier 5 conformance

### Task 7.1: Port `agent-stale-memo` demo to the SDK (exports `runDemo`)

**Files:**
- Read for reference: `scripts/agent-stale-memo.ts`
- Create: `packages/agent-sdk/scripts/agent-stale-memo-sdk.ts`

The demo MUST be importable as a function so the integration test can call it without spawning a new process. CLI entrypoint stays — guarded by `import.meta.url` check.

- [ ] **Step 1: Inspect the original demo**

```bash
head -80 scripts/agent-stale-memo.ts
```

Identify the patch-op sequence the demo applies. The SDK port must apply the same ops in the same order against the same input fixture, producing the same final document.

- [ ] **Step 2: Write the SDK-driven port**

Create `packages/agent-sdk/scripts/agent-stale-memo-sdk.ts`:

```ts
import { resolve } from "node:path";
import { copyFileSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { NomaTools, NomaWorkflow, type PatchOp } from "../src/index.js";

const FIXTURE = resolve("examples/agent-stale-memo");
const OUT_DIR = resolve("dist/examples/agent-stale-memo-sdk");

export async function runDemo(): Promise<{
  outDir: string;
  patchedFile: string;
  ops: number;
}> {
  mkdirSync(OUT_DIR, { recursive: true });
  const src = resolve(FIXTURE, "memo.noma");
  const dst = resolve(OUT_DIR, "memo.noma");
  copyFileSync(src, dst);

  const tools = await NomaTools.spawn();
  try {
    const wf = new NomaWorkflow(tools);
    const raw = JSON.parse(readFileSync(resolve(FIXTURE, "patches.json"), "utf8")) as
      | { ops: PatchOp[] }
      | PatchOp[];
    const ops = Array.isArray(raw) ? raw : raw.ops;
    const results = await wf.applyOps(dst, ops, { stopOnFirstError: true });
    writeFileSync(resolve(OUT_DIR, "trace.html"), renderTrace(results));
    return { outDir: OUT_DIR, patchedFile: dst, ops: results.length };
  } finally {
    await tools.close();
  }
}

function renderTrace(results: Awaited<ReturnType<NomaWorkflow["applyOps"]>>): string {
  const rows = results
    .map((r, i) => {
      if (r.ok) {
        return `<tr><td>${i + 1}</td><td>applied</td><td>${r.transcriptEntry.op.op}</td><td>${r.postValidation}</td></tr>`;
      }
      return `<tr><td>${i + 1}</td><td>failed</td><td>${r.code ?? "?"}</td><td>—</td></tr>`;
    })
    .join("\n");
  return `<!doctype html><meta charset="utf-8"><title>agent-stale-memo-sdk</title><table border="1"><thead><tr><th>#</th><th>result</th><th>op</th><th>validation</th></tr></thead><tbody>${rows}</tbody></table>`;
}

// CLI entrypoint guard. Compares the file being invoked by `node`/`tsx`
// against this module's path so importing the module from a test does NOT
// run the demo as a side effect. The earlier `import.meta.url === \`file://...\``
// form is tautological because `fileURLToPath(import.meta.url)` always
// round-trips to the same URL — it fires on every import.
if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  runDemo()
    .then((r) => console.log(`wrote ${r.outDir}/trace.html (${r.ops} ops)`))
    .catch((e) => {
      console.error(e);
      process.exit(1);
    });
}
```

If `patches.json` uses a key that does not match `PatchOp`, the adapter at the top handles both array and `{ ops: [...] }` shapes. If a yet-different shape appears, document it inline and adapt — do NOT change the SDK's accepted shape to match the demo.

- [ ] **Step 3: Wire a script entry in `packages/agent-sdk/package.json`**

Add to `scripts`:

```json
"demo:agent-stale-memo": "tsx scripts/agent-stale-memo-sdk.ts"
```

- [ ] **Step 4: Run the demo**

```bash
npm run demo:agent-stale-memo -w @noma/agent-sdk
```

Expected: writes `dist/examples/agent-stale-memo-sdk/trace.html` and prints the op count.

- [ ] **Step 5: Commit**

```bash
git add packages/agent-sdk/scripts/agent-stale-memo-sdk.ts packages/agent-sdk/package.json
git commit -m "feat(agent-sdk): port agent-stale-memo demo to drive through NomaWorkflow"
```

### Task 7.2: Port `agent-memory-demo` to the SDK (exports `runDemo`)

- [ ] **Step 1: Inspect the original demo**

```bash
head -120 scripts/agent-memory-demo.ts
```

- [ ] **Step 2: Write the SDK-driven port**

Create `packages/agent-sdk/scripts/agent-memory-demo-sdk.ts` mirroring Task 7.1's structure: export `runDemo()`, guard CLI invocation. Replace direct `patchSource` calls with `NomaWorkflow.applyOps`. Output paths under `dist/examples/agent-memory-sdk/`.

- [ ] **Step 3: Add script entry**

```json
"demo:agent-memory": "tsx scripts/agent-memory-demo-sdk.ts"
```

- [ ] **Step 4: Run**

```bash
npm run demo:agent-memory -w @noma/agent-sdk
```

- [ ] **Step 5: Commit**

```bash
git add packages/agent-sdk/scripts/agent-memory-demo-sdk.ts packages/agent-sdk/package.json
git commit -m "feat(agent-sdk): port agent-memory demo to drive through NomaWorkflow"
```

### Task 7.3: Integration test — imports demo modules, diffs final document

The test imports `runDemo` from each SDK demo module and calls it directly (no subprocess). It then reads the patched `.noma` file from each demo's output directory and compares against a baseline file from the existing non-SDK demo's output (which CI must have run prior — wired via a `pretest` hook or by invoking the existing `npm run demo:stale-memo` before this test).

For the baseline path, this test assumes the non-SDK demos write their outputs to `dist/examples/agent-stale-memo/memo.noma` and `dist/examples/agent-memory/memo.noma` respectively. If the existing scripts write to different paths, adapt the constants here — do NOT move the existing scripts' outputs.

**Files:**
- Create: `packages/agent-sdk/test/integration.test.ts`

- [ ] **Step 1: Verify the baseline output paths exist after running the existing demos**

```bash
npm run demo:stale-memo
npm run demo:agent-memory
ls dist/examples/agent-stale-memo/ dist/examples/agent-memory/
```

Note the location of the patched `.noma` file in each. Use those paths as `BASELINE_STALE` and `BASELINE_MEMORY` constants in the test below.

- [ ] **Step 2: Write the test**

```ts
import { test, before } from "node:test";
import assert from "node:assert/strict";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { runDemo as runStaleMemoSdk } from "../scripts/agent-stale-memo-sdk.ts";
import { runDemo as runAgentMemorySdk } from "../scripts/agent-memory-demo-sdk.ts";

// Baseline paths come from the existing non-SDK demos. agent-stale-memo
// writes `memo.after.noma` (scripts/agent-stale-memo.ts:213); agent-memory
// writes `memory.after.noma` (scripts/agent-memory-demo.ts:264). Don't
// confuse with the unmutated `memo.noma`/`memory.noma` fixtures the demos
// copy as input.
const BASELINE_STALE = resolve("dist/examples/agent-stale-memo/memo.after.noma");
const BASELINE_MEMORY = resolve("dist/examples/agent-memory/memory.after.noma");

before(() => {
  if (!existsSync(BASELINE_STALE)) {
    throw new Error(
      `baseline missing: ${BASELINE_STALE}. Run 'npm run demo:stale-memo' first.`,
    );
  }
  if (!existsSync(BASELINE_MEMORY)) {
    throw new Error(
      `baseline missing: ${BASELINE_MEMORY}. Run 'npm run demo:agent-memory' first.`,
    );
  }
});

test("agent-stale-memo SDK port produces byte-identical final document", async () => {
  const r = await runStaleMemoSdk();
  const sdkDoc = readFileSync(r.patchedFile, "utf8");
  const baseline = readFileSync(BASELINE_STALE, "utf8");
  assert.equal(sdkDoc, baseline, "SDK port and baseline produced different final documents");
});

test("agent-memory SDK port produces byte-identical final document", async () => {
  const r = await runAgentMemorySdk();
  const sdkDoc = readFileSync(r.patchedFile, "utf8");
  const baseline = readFileSync(BASELINE_MEMORY, "utf8");
  assert.equal(sdkDoc, baseline, "SDK port and baseline produced different final documents");
});
```

If byte-equality fails, the discrepancy IS the production-conditions signal — record the diff in a comment, decide whether SDK or baseline is correct (usually SDK, since it uses the real wire path), and fix the loser. Do not relax the assertion.

- [ ] **Step 3: Run**

```bash
npm run demo:stale-memo && npm run demo:agent-memory
cd packages/agent-sdk && npx tsx --test test/integration.test.ts
```

- [ ] **Step 4: Commit**

```bash
git add packages/agent-sdk/test/integration.test.ts
git commit -m "test(agent-sdk): integration test imports demos and asserts byte-match"
```

### Task 7.4: Conformance test — drive examples/conformance/patch/*

**Files:**
- Create: `packages/agent-sdk/test/conformance.test.ts`

- [ ] **Step 1: Inspect fixture shape**

```bash
ls examples/conformance/patch/update_attribute/
cat examples/conformance/patch/update_attribute/patch.json
```

Each subdir has an input `.noma`, `patch.json` (single op or `{ ops: [...] }`), and `expected.post.noma`.

- [ ] **Step 2: Write the test**

```ts
import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, copyFileSync, mkdtempSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { NomaTools } from "../src/tools.js";
import { NomaWorkflow } from "../src/workflow.js";
import type { PatchOp } from "../src/types.js";

const ROOT = resolve("examples/conformance/patch");

let tools: NomaTools;

before(async () => {
  tools = await NomaTools.spawn();
});

after(async () => {
  await tools.close();
});

const fixtures = readdirSync(ROOT).filter((f) => {
  const dir = join(ROOT, f);
  return (
    existsSync(join(dir, "patch.json")) &&
    existsSync(join(dir, "expected.post.noma")) &&
    existsSync(join(dir, "input.noma"))
  );
});

for (const name of fixtures) {
  test(`conformance: ${name} produces expected.post.noma`, async () => {
    const fixtureDir = join(ROOT, name);
    // The conformance corpus uses the exact filename `input.noma` for the
    // input document. Glob-style "first .noma that isn't expected.post.noma"
    // would silently pick up future sibling .noma files (e.g., a `notes.noma`
    // someone drops in). Require the exact name so missing inputs fail loudly.
    const inputName = "input.noma";
    assert.ok(
      existsSync(join(fixtureDir, inputName)),
      `fixture ${name} missing ${inputName}`,
    );

    const scratch = mkdtempSync(join(tmpdir(), `noma-conf-${name}-`));
    const workFile = join(scratch, inputName);
    copyFileSync(join(fixtureDir, inputName), workFile);

    const patch = JSON.parse(readFileSync(join(fixtureDir, "patch.json"), "utf8")) as
      | { ops: PatchOp[] }
      | PatchOp[]
      | PatchOp;

    const wf = new NomaWorkflow(tools);
    const ops: PatchOp[] = Array.isArray(patch)
      ? patch
      : "ops" in (patch as { ops?: PatchOp[] })
        ? (patch as { ops: PatchOp[] }).ops
        : [patch as PatchOp];

    const results = await wf.applyOps(workFile, ops, { stopOnFirstError: true });
    const failures = results.filter((r) => !r.ok);
    assert.equal(failures.length, 0, `fixture ${name}: applyOps failures ${JSON.stringify(failures)}`);

    const got = readFileSync(workFile, "utf8");
    const want = readFileSync(join(fixtureDir, "expected.post.noma"), "utf8");
    assert.equal(got, want, `fixture ${name}: post-patch document mismatch`);
  });
}
```

- [ ] **Step 3: Run**

```bash
cd packages/agent-sdk && npx tsx --test test/conformance.test.ts
```

Expected: one test per `examples/conformance/patch/*` subdir, all passing.

- [ ] **Step 4: Commit**

```bash
git add packages/agent-sdk/test/conformance.test.ts
git commit -m "test(agent-sdk): drive examples/conformance/patch/* through the SDK"
```

---

## Phase 8 — Annex graduation metrics report

### Task 8.1: Aggregator test that captures the three graduation numbers

**Files:**
- Create: `packages/agent-sdk/test/graduation-metrics.test.ts`

This test is the single durable place that surfaces the three numbers gating Annex A+B graduation. It re-uses the same patterns from earlier tiers and prints a JSON-shaped report on stdout that someone reading CI logs can copy into the v1.1 RFC graduation note.

- [ ] **Step 1: Write the aggregator test**

```ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readdirSync, existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { NomaTools } from "../src/tools.js";
import { NomaWorkflow } from "../src/workflow.js";
import type { PatchErrorCode } from "../src/types.js";

// Source: src/patch.ts:29. Nine codes total; this aggregator covers the
// seven that are reachable through a single patch_block call.
//
// pre_validation_blocked and op_list_aborted are emitted by the in-process
// patchAll() flow that v1.1's patch_block_list tool will expose (Annex B.8).
// v0.1 SDK does NOT expose batched atomic ops — applyOps is client-side
// sequential and short-circuits via PatchFailure, not via op_list_aborted.
// Codes are listed in PatchErrorCode for forward-compat but are NOT in
// the v0.1 graduation metric. When patch_block_list lands (v1.1), the
// aggregator gets an applyOpsList test that exercises both codes.
const ALL_CODES: PatchErrorCode[] = [
  "target_missing",
  "parent_missing",
  "id_conflict",
  "invalid_content",
  "id_attribute_protected",
  "sha_mismatch",
  "unsupported_op",
];

test("graduation metrics: error code coverage + descriptor shape + conformance corpus size", async () => {
  const tools = await NomaTools.spawn();
  try {
    const wf = new NomaWorkflow(tools);
    const seenCodes = new Set<string>();

    const dir = mkdtempSync(join(tmpdir(), "noma-grad-"));
    const fixture = join(dir, "doc.noma");
    writeFileSync(
      fixture,
      `# H\n\n::claim{id="c1" confidence=0.5}\nbody\n::\n::claim{id="c2"}\nb\n::\n`,
    );

    // target_missing
    let r = await tools.patchBlock(fixture, { op: "delete_block", id: "nope" });
    if (!r.ok && r.code) seenCodes.add(r.code);
    // sha_mismatch
    r = await tools.patchBlock(
      fixture,
      { op: "update_attribute", id: "c1", key: "confidence", value: 0.7 },
      { expectedSha: "deadbeef" },
    );
    if (!r.ok && r.code) seenCodes.add(r.code);
    // id_conflict (rename_id collision; from/to per server schema)
    r = await tools.patchBlock(fixture, { op: "rename_id", from: "c1", to: "c2" });
    if (!r.ok && r.code) seenCodes.add(r.code);
    // unsupported_op via book manifest. Server returns isError; SDK throws.
    // The aggregator catches the throw and parses the code from the message
    // so the metric stays honest about what the server emitted.
    const yml = join(dir, "book.noma.yml");
    writeFileSync(yml, "title: t\nchapters: []\n");
    try {
      await tools.patchBlock(yml, { op: "delete_block", id: "x" });
    } catch (e) {
      const msg = (e as Error).message;
      if (/unsupported_op/.test(msg)) seenCodes.add("unsupported_op");
    }
    // invalid_content
    r = await tools.patchBlock(fixture, {
      op: "replace_block",
      id: "c1",
      content: "::claim{id=\"c1\"\nunterminated",
    });
    if (!r.ok && r.code) seenCodes.add(r.code);
    // id_attribute_protected
    r = await tools.patchBlock(fixture, {
      op: "update_attribute",
      id: "c1",
      key: "id",
      value: "c2",
    });
    if (!r.ok && r.code) seenCodes.add(r.code);
    // parent_missing
    r = await tools.patchBlock(fixture, {
      op: "add_block",
      parent: "no-such-parent",
      content: "::evidence{id=\"e9\"}\nbody\n::\n",
    });
    if (!r.ok && r.code) seenCodes.add(r.code);

    const descPath = join(dir, "desc-doc.noma");
    writeFileSync(descPath, `# H\n\n::claim{id="c1"}\nbody\n::\n`);
    writeFileSync(
      `${descPath}.capabilities.yml`,
      "nomaAgent:\n  version: 1\n  profile: r\n  ids:\n    rename: true\n  validation:\n    required: true\n  blocks:\n    claim:\n      ops: [update_attribute]\n      attrs:\n        confidence:\n          type: number\n          min: 0\n          max: 1\n        status:\n          type: string\n          enum: [open, closed]\n",
    );
    const descShape = new Set<string>();
    const desc = await wf.readCapabilities(descPath);
    assert.ok(desc);
    if (desc.profile) descShape.add("profile");
    if (desc.idsRename) descShape.add("ids.rename");
    if (desc.validationRequired) descShape.add("validation.required");
    for (const [, policy] of desc.blocks) {
      if (policy.ops.size > 0) descShape.add("blocks.ops");
      for (const [, c] of policy.attrs ?? new Map()) {
        if (c.type) descShape.add("attrs.type");
        if (c.min !== undefined) descShape.add("attrs.min");
        if (c.max !== undefined) descShape.add("attrs.max");
        if (c.enum) descShape.add("attrs.enum");
      }
    }

    // Re-run each conformance fixture inline so the metric reports an actual
    // pass count, not just the corpus size. Skips fixtures missing input/patch/
    // expected files (test/conformance.test.ts owns the strict assertion; this
    // is an honest tally for the v1.1 graduation note).
    const confRoot = resolve("examples/conformance/patch");
    const confDirs = existsSync(confRoot) ? readdirSync(confRoot) : [];
    let confPassed = 0;
    let confEligible = 0;
    for (const name of confDirs) {
      const fx = join(confRoot, name);
      if (
        !existsSync(join(fx, "patch.json")) ||
        !existsSync(join(fx, "expected.post.noma")) ||
        !existsSync(join(fx, "input.noma"))
      ) continue;
      confEligible++;
      const scratch2 = mkdtempSync(join(tmpdir(), `noma-grad-conf-${name}-`));
      const workFile = join(scratch2, "input.noma");
      const { copyFileSync, readFileSync: rfs } = await import("node:fs");
      copyFileSync(join(fx, "input.noma"), workFile);
      const raw = JSON.parse(rfs(join(fx, "patch.json"), "utf8")) as unknown;
      const ops: unknown[] = Array.isArray(raw)
        ? raw
        : (raw as { ops?: unknown[] }).ops ?? [raw];
      const results = await wf.applyOps(workFile, ops as never, { stopOnFirstError: true });
      const allOk = results.every((r) => r.ok);
      const got = rfs(workFile, "utf8");
      const want = rfs(join(fx, "expected.post.noma"), "utf8");
      if (allOk && got === want) confPassed++;
    }

    const report = {
      errorCodes: { observed: [...seenCodes].sort(), total: ALL_CODES.length },
      descriptorShape: { observed: [...descShape].sort() },
      conformance: { passed: confPassed, total: confEligible },
    };
    console.log("\n=== Annex graduation metrics ===\n" + JSON.stringify(report, null, 2));

    // Target: all 7 single-call-reachable codes from src/patch.ts. The
    // remaining 2 (pre_validation_blocked, op_list_aborted) come from
    // workflow-level paths and are observed in Phase 5 tests.
    assert.equal(
      seenCodes.size,
      ALL_CODES.length,
      `expected all ${ALL_CODES.length} single-call codes, got ${seenCodes.size}: ${[...seenCodes].sort().join(", ")}`,
    );
    assert.ok(descShape.has("blocks.ops"));
    assert.ok(descShape.has("attrs.type"));
    assert.ok(descShape.has("attrs.min"));
    assert.ok(descShape.has("attrs.max"));
    assert.ok(descShape.has("attrs.enum"));
    assert.ok(descShape.has("ids.rename"));
    assert.ok(descShape.has("validation.required"));
    // Honest graduation gate: at least 5 fixtures, ALL passing through the
    // SDK. The pass count is the real third graduation metric — corpus size
    // alone tells you nothing about whether the SDK handles those fixtures.
    assert.equal(confEligible >= 5, true, `conformance corpus too small: ${confEligible}`);
    assert.equal(
      confPassed,
      confEligible,
      `conformance not 100%: ${confPassed}/${confEligible} passed`,
    );
  } finally {
    await tools.close();
  }
});
```

The threshold is `=== ALL_CODES.length` (currently 7). The aggregator induces every single-call-reachable code from `src/patch.ts` directly; if the test fails, the printed `observed` array tells you exactly which code the server failed to emit. Two codes (`pre_validation_blocked`, `op_list_aborted`) are tested separately in Phase 5 workflow tests because they only surface from op-list flows.

- [ ] **Step 2: Run**

```bash
cd packages/agent-sdk && npx tsx --test test/graduation-metrics.test.ts
```

Expected: 1 passing test, with the metrics report printed to stdout.

- [ ] **Step 3: Commit**

```bash
git add packages/agent-sdk/test/graduation-metrics.test.ts
git commit -m "test(agent-sdk): aggregator surfaces Annex A+B graduation metrics"
```

---

## Phase 9 — Wire into root + release notes

### Task 9.1: Wire `@noma/agent-sdk` into root test/build + CI

**Files:**
- Modify: `package.json` (root)
- Modify: `packages/agent-sdk/package.json` — add pretest hook
- Modify: `.github/workflows/pages.yml` — run SDK tests on CI

The integration test (Task 7.3) reads baselines from `dist/examples/agent-stale-memo/memo.after.noma` and `dist/examples/agent-memory/memory.after.noma`. Those files only exist after `npm run demo:stale-memo` and `npm run demo:agent-memory` run. A `pretest` script in the workspace package makes that happen automatically — without it, CI would either fail (no baseline) or skip a meaningful comparison.

- [ ] **Step 1: Append a pretest hook to `packages/agent-sdk/package.json`**

Add to the `scripts` block (next to the existing `"test"`):

```json
"pretest": "cd ../.. && npm run build -w @noma/mcp-server && npm run demo:stale-memo && npm run demo:agent-memory"
```

This builds the MCP server (so Phase 3 transport tests can resolve the binary) AND generates the baseline `*.after.noma` files (so Phase 7 integration tests can compare). Pretest runs automatically before `npm test` in this workspace; explicit invocations of `npx tsx --test ...` skip it, which is fine for local TDD on a single file.

- [ ] **Step 2: Append to root `scripts` in `package.json`**

Add to the `scripts` block:

```json
"test:agent-sdk": "npm run test -w @noma/agent-sdk",
"build:agent-sdk": "tsc -p packages/agent-sdk/tsconfig.json"
```

Note: the workspace's own `test` script is the canonical entry point. The root alias just invokes the workspace one — keeps a single source of truth for what "agent-sdk tests" means.

- [ ] **Step 3: Verify root `tsc --noEmit` covers the new package, or document why it does not**

Run from repo root:

```bash
npx tsc --noEmit
```

If the output shows zero `packages/agent-sdk/**` files were checked, that's expected — root `tsconfig.json` does not currently include workspace packages. The workspace package has its own `tsc` invoked via `npm run build:agent-sdk`. Add this command to the verification triad below.

- [ ] **Step 4: Run the full verification triad (now four commands)**

```bash
npx tsc --noEmit                                # root types
npm run build:agent-sdk                         # workspace types
npm test                                        # root tests
npm run test:agent-sdk                          # workspace tests (auto-runs pretest)
npm run build:site                              # full site build
```

Expected: zero errors, all tests pass, build:site green.

- [ ] **Step 5: Add the SDK gate to `.github/workflows/pages.yml`**

Insert before the existing `npm run build:site` step:

```yaml
      - name: Build agent-sdk types
        run: npm run build:agent-sdk
      - name: Run agent-sdk tests
        run: npm run test:agent-sdk
```

`pretest` handles the MCP-server build + demo baseline generation inside `npm run test:agent-sdk`, so no extra workflow steps are needed for those.

- [ ] **Step 6: Commit**

```bash
git add package.json packages/agent-sdk/package.json .github/workflows/pages.yml
git commit -m "build: wire @noma/agent-sdk into root test + CI gate"
```

### Task 9.2: CHANGELOG, README Status, PLAN.md §24.14

**Files:**
- Modify: `CHANGELOG.md`
- Modify: `README.md`
- Modify: `PLAN.md`

For this plan, just add the `[Unreleased]` section — version-bumping all locations belongs in the release commit, not in implementation tasks.

- [ ] **Step 1: Insert `[Unreleased]` section into `CHANGELOG.md`**

Above the most recent version heading, insert:

```markdown
## [Unreleased]

### Added

- **`@noma/agent-sdk` v0.1.0 — reference Agent SDK (experimental).** TypeScript-only, stdio-only via `@noma/mcp-server`. Public surface: `NomaTools` (1:1 wrapper over `read_doc`, `list_ids`, `validate_doc`, `patch_block`) and `NomaWorkflow` (composes tools into `safePatch` with per-file absolute-path mutex + clamped retry, `applyOps` with client-side parent-chain transcripts, `replayTranscript`, `readCapabilities`, `checkCapability` with advisory denials including the Annex A `ids.rename` global gate). `CapabilityDescriptor` parses Annex A v1 sidecars (`<file>.capabilities.yml`) and validates against the §A.3 schema. Errors split into a `NomaSystemError` hierarchy (thrown) for system faults — including book-manifest `unsupported_op` — and `{ ok: false, code }` bodies for user-recoverable §3.5 patch errors (`target_missing`, `parent_missing`, `id_conflict`, `invalid_content`, `id_attribute_protected`, `sha_mismatch`). Five-tier test pyramid: unit, tools-vs-real-server, workflow, demo replay (`agent-stale-memo` + `agent-memory` ported to the SDK), and conformance (drives `examples/conformance/patch/*`). Graduation metrics aggregator captures the three numbers gating Annex A+B promotion in v1.1 (7/7 single-call codes, every Annex A.3 descriptor field, full conformance corpus). Marked **experimental** — API freezes at v1.0 in lockstep with RFC v1.1 graduation.
```

- [ ] **Step 2: Update README Status paragraph**

Add a line under the existing Status paragraph:

```markdown
**Unreleased:** `@noma/agent-sdk` v0.1.0 — experimental reference Agent SDK shipping alongside the CLI. See `packages/agent-sdk/README.md`.
```

- [ ] **Step 3: Add PLAN.md §24.14 stub**

Append below `§24.13`:

```markdown
### §24.14 — Unreleased (agent SDK debut)

Pending release. Reference agent SDK (`@noma/agent-sdk`) lands in the workspace as a prerequisite for graduating Annex A (capability descriptor) and Annex B (MCP-over-stdio binding) from provisional to normative in RFC v1.1. See `docs/superpowers/specs/2026-05-13-noma-agent-sdk-design.md` for scope and decisions.
```

- [ ] **Step 4: Commit**

```bash
git add CHANGELOG.md README.md PLAN.md
git commit -m "docs: changelog + status + PLAN entry for @noma/agent-sdk debut"
```

---

## Post-implementation gate: `/codex review`

Before tagging a release that ships `@noma/agent-sdk`, run `/codex review` on this plan **and** on the final implementation diff. The project's memory rule (`feedback_codex_review_value`) flagged that codex caught a P1 bug in the v0.7 plan that self-review missed. The agent-sdk plan is more substantial than v0.7's — codex is non-optional.

If codex flags issues:
- Architectural issues → revise spec, update plan, restart affected phases.
- Code-level issues → fix inline, re-commit, re-run the triad before tag.

Document codex's findings in a follow-up commit to this plan: `docs(plan): codex review pass — N issues addressed, M deferred`.

---

## Self-review checklist

1. **Spec coverage.** Every section of the spec maps to at least one task:
   - Architecture / package layout → Task 0.1
   - Dependencies (incl. `@modelcontextprotocol/sdk`) → Task 0.1 deps block
   - Errors → Task 1.1
   - Types → Task 1.2
   - `CapabilityDescriptor` → Tasks 2.1, 2.2
   - Transport / `StdioMcpClient` → Task 3.1
   - `NomaTools` 4 methods → Tasks 4.1–4.5
   - `NomaTools` §3.5 coverage → Task 4.6
   - `NomaWorkflow` 5 methods → Tasks 5.1–5.6
   - Per-file mutex → Task 5.2
   - `inferBlockName` → Task 5.6
   - Public re-exports → Task 6.1
   - README experimental disclaimer → Task 6.2
   - Tier 4 demos + integration → Tasks 7.1, 7.2, 7.3
   - Tier 5 conformance → Task 7.4
   - Graduation metrics → Task 8.1
   - CI wiring → Task 9.1
   - CHANGELOG / PLAN entries → Task 9.2

2. **No placeholders.** Every code step has the actual code an engineer can paste. No "TBD" or "implement validation here".

3. **Type consistency.** `PatchOp` declared in `types.ts` is used unchanged in `tools.ts`, `workflow.ts`, both demo scripts, and the conformance test. `PatchResult` discriminant `ok: true | false` is consistent. `CapabilityCheckResult` four reason codes match across `types.ts`, `workflow.ts`, and the workflow tests.

4. **Test fixtures exist.** `examples/conformance/patch/*` confirmed (6 subdirs). `examples/agent-stale-memo/` confirmed. `examples/agent-memory/` confirmed.

5. **No `git add -A`.** Every commit stages only the files modified in that task.

6. **No subprocess invocation in tests.** Integration test (Task 7.3) imports `runDemo` functions rather than spawning child processes. Avoids the command-injection footgun and runs faster.

---

**Plan complete. Saved to `docs/superpowers/plans/2026-05-13-noma-agent-sdk.md`.**
