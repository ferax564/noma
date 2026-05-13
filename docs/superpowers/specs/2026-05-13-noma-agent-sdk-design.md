# `@noma/agent-sdk` — Reference Agent SDK Design

**Date:** 2026-05-13
**Target release:** v0.9.0 (SDK debut) → v1.1 (Annex graduation gate)
**Status:** approved, awaiting implementation plan
**RFC reference:** `docs/spec-agent-protocol-v1.noma` §1.4, Annex A, Annex B

---

## Purpose

The Noma Agent Protocol v1.0 RFC ships with Annexes A (capability descriptor sidecar) and B (MCP-over-stdio binding) marked **provisional**. Per §1.4, they cannot graduate to normative until "the reference SDK (Phase 3) and at least one third-party binding exercise them under production conditions."

This spec covers the **reference SDK** prerequisite. The third-party binding is tracked separately and not in scope here.

The SDK's job is to be the consumer-pressure mechanism that surfaces real shape issues in both annexes before they freeze. It is **not** an opinionated agent framework, it is **not** a noma-shaped DSL for authoring documents, and it is **not** a polished public artifact at v1.0 — it is a typed, ergonomic wrapper over the four MCP tools plus enough workflow surface to make real multi-op editing tractable.

## Scope

**In scope:**
- TypeScript-only SDK published as `@noma/agent-sdk` v0.1.0 alongside `@noma/cli`.
- Stdio transport only, spawning `@noma/mcp-server` as a child process.
- Workflow primitives that compose the four MCP tools: safe-patch with retry, client-side op chaining, transcript replay, capability descriptor reader with advisory checks.
- Test coverage that exercises every documented annex shape (every §3.5 error code, every §A.3 descriptor field).

**Out of scope:**
- Python or other-language SDKs.
- In-process transport that bypasses `@noma/mcp-server`.
- HTTP, WebSocket, or any future binding.
- Server-side enforcement of the capability descriptor (deferred to v1.1 per Annex A.4).
- Atomic multi-op transactions (deferred to v1.1's `patch_block_list` per Annex B.8).
- Opinionated authoring helpers (`addEvidenceTo(claim)`, etc.) — may revisit post-v1.1.

## Decisions Locked During Brainstorming

| # | Decision | Why |
|---|----------|-----|
| 1 | Reference SDK only, not bundled with third-party binding | Keeps each spec single-purpose; binding is its own brainstorm |
| 2 | TypeScript only | Fastest path; covers Claude Agent SDK + OpenAI Agents SDK audience day one |
| 3 | Stdio-only via `@noma/mcp-server` | Required for Annex B graduation; no in-process bypass path |
| 4 | Workflow layer over raw MCP tools | Annex A graduation needs descriptor consumer pressure; workflow surface is the minimum that delivers it |
| 5 | Published 0.x with `experimental` disclaimer | API stabilizes alongside Annex graduation; freezes at 1.0 in lockstep with RFC v1.1 |
| 6 | Two-class architecture: `NomaTools` + `NomaWorkflow` | Mirrors spec's Annex-B-vs-workflow seam; clean extension point for future HTTP binding |
| 7 | `@modelcontextprotocol/sdk` v1.11.0 as a new dep | Lockstep with mcp-server; SDK must use the same framing real consumers use |
| 8 | `NomaWorkflow` borrows `NomaTools`; caller owns lifecycle | One mental model, no double-close, no shared-ownership bugs |
| 9 | Per-file in-process mutex in `safePatch` | Protects against same-SDK races without changing the wire protocol |

## Architecture

### Package layout

```
packages/agent-sdk/
  package.json              "@noma/agent-sdk", "version": "0.1.0"
  src/
    index.ts                public re-exports
    tools.ts                NomaTools — wire-level wrapper over @noma/mcp-server
    workflow.ts             NomaWorkflow — composes tools into stress-test primitives
    capabilities.ts         CapabilityDescriptor parser + advisory check (Annex A)
    transport.ts            stdio subprocess lifecycle + @modelcontextprotocol/sdk client
    types.ts                shared types
    errors.ts               NomaSystemError hierarchy + PatchFailure shape
  test/
    tools.test.ts           per-MCP-tool tests against real mcp-server subprocess
    workflow.test.ts        safe-patch retry, transcript replay, descriptor advisory
    capabilities.test.ts    Annex A schema validation
    integration.test.ts     spawns the demo scripts below and diffs their output against the non-SDK baselines
    conformance.test.ts     drives examples/conformance/* fixtures through the SDK
  scripts/
    agent-stale-memo-sdk.ts          SDK-driven demo; invoked by Tier 4 integration test
    agent-memory-demo-sdk.ts         SDK-driven demo; invoked by Tier 4 integration test
  README.md                 experimental disclaimer + usage examples
  tsconfig.json
```

### Dependencies

| Package | Purpose | Source |
|---------|---------|--------|
| `@modelcontextprotocol/sdk@1.11.0` | Stdio client transport, JSON-RPC framing, request correlation. Pinned in lockstep with the version `@noma/mcp-server` already depends on. | New runtime dep |
| `js-yaml@^4.1.0` | Capability descriptor YAML parsing. | Existing in `@noma/cli` |
| `@noma/mcp-server` (workspace) | Spawned as child process. Not imported. | Workspace |
| `@noma/cli` (workspace) | Types only (`PatchOp`, `Diagnostic`, etc.). Never imported at runtime. | Workspace |

The SDK uses the canonical MCP client library rather than hand-rolling JSON-RPC framing. Rationale: graduation requires the SDK to exercise the same code path real consumers use; a hand-rolled framer is a divergence that would weaken Annex B feedback.

### Versioning rule

`@noma/agent-sdk` SDK API is **experimental** through v0.x. API freezes at 1.0 in lockstep with RFC v1.1 Annex graduation. The package tracks `@noma/cli` and `@noma/mcp-server` versions for the rest of 0.x (see `packages/mcp-server/package.json` for the lockstep convention).

## Components

### `NomaTools` — wire-level wrapper (Annex B surface)

```ts
class NomaTools {
  static spawn(options?: {
    mcpServerBin?: string;          // override server binary path; default resolves @noma/mcp-server
    env?: NodeJS.ProcessEnv;
    requestTimeoutMs?: number;      // default 30_000
  }): Promise<NomaTools>;

  close(): Promise<void>;

  readDoc(file: string): Promise<{ blocks: BlockSummary[] }>;
  listIds(file: string): Promise<{ ids: string[]; aliases: Record<string, string> }>;
  validateDoc(file: string): Promise<{ ok: boolean; diagnostics: Diagnostic[] }>;
  patchBlock(file: string, op: PatchOp, options?: PatchOptions): Promise<PatchResult>;
}

type PatchOptions = {
  reason?: string;
  expectedSha?: string;
  actor?: Actor;
  baseSha256?: string;
  parentOpId?: string;
};

type PatchResult =
  | { ok: true; postValidation: "ok" | "warn" | "error"; transcriptEntry: TranscriptRecord; diagnostics: Diagnostic[] }
  | PatchFailure;

type PatchFailure = {
  ok: false;
  error: string;
  code?: PatchErrorCode | string;
};
```

Method-to-tool mapping is 1:1 with Annex B §B.3–B.6. Each method awaits one MCP request/response. The class owns one subprocess for its lifetime.

**Book manifest paths.** Passing a `.noma.yml` path:
- to `readDoc`, `listIds`, `validateDoc` → throws `NomaSystemError("book manifest path is not a valid target")` (server returns `isError: true`).
- to `patchBlock` → returns `{ ok: false, code: "unsupported_op" }` (server treats this as a user-facing error per Annex B §B.6).

### `NomaWorkflow` — composes tools into stress-test primitives

```ts
class NomaWorkflow {
  constructor(tools: NomaTools);   // borrows; caller owns tools.close()

  safePatch(file: string, op: PatchOp, options?: {
    retryOnShaMismatch?: number;       // default 3
    reason?: string;
    actor?: Actor;
  }): Promise<PatchResult>;

  applyOps(file: string, ops: PatchOp[], options?: {
    stopOnFirstError?: boolean;        // default true
    actor?: Actor;
    parentChain?: boolean;             // default true
  }): Promise<PatchResult[]>;

  replayTranscript(file: string): Promise<TranscriptRecord[]>;
  readCapabilities(file: string): Promise<CapabilityDescriptor | null>;
  checkCapability(file: string, op: PatchOp): Promise<CapabilityCheckResult>;
}

type CapabilityCheckResult =
  | { allowed: true }
  | { allowed: false;
      reason: "no_descriptor" | "block_not_listed" | "op_not_granted" | "attr_constraint_violated";
      detail: string };
```

**Lifecycle ownership rule.** `NomaWorkflow` **borrows** the `NomaTools` instance. It does not call `tools.close()`. There is no `workflow.close()`. The caller owns the tools handle:

```ts
const tools = await NomaTools.spawn();
try {
  const wf = new NomaWorkflow(tools);
  await wf.safePatch(file, op);
} finally {
  await tools.close();
}
```

A single `NomaTools` instance MAY be shared between multiple `NomaWorkflow` instances. Each workflow has its own per-file mutex map (see below); cross-workflow same-file calls are NOT serialized.

**Capability check is advisory only.** Per Annex A.4, the SDK MUST NOT block patches based on descriptor content in v1.0. `safePatch` does NOT call `checkCapability` internally. Callers compose them explicitly when they want advisory warnings.

### `CapabilityDescriptor` — typed view of the sidecar (Annex A consumer)

```ts
class CapabilityDescriptor {
  readonly version: 1;
  readonly profile?: string;
  readonly blocks: Map<string, BlockPolicy>;
  readonly idsRename: boolean;
  readonly validationRequired: boolean;

  static fromYaml(yaml: string): CapabilityDescriptor;
  static fromFile(file: string): Promise<CapabilityDescriptor | null>;

  allows(blockName: string, op: PatchOpName): boolean;
  validateAttr(blockName: string, key: string, value: unknown):
    | { ok: true }
    | { ok: false; reason: string };
}

type BlockPolicy = {
  ops: Set<PatchOpName>;
  attrs?: Map<string, AttrConstraint>;
};

type AttrConstraint = {
  type?: "string" | "number" | "boolean";
  min?: number;
  max?: number;
  enum?: ReadonlyArray<string | number>;
};
```

`fromFile(path)` resolves `<path>.capabilities.yml`. Missing sidecar → returns `null`. Malformed YAML → throws `NomaCapabilityError("invalid YAML: ...")`. `version` ≠ 1 → throws `NomaCapabilityError("unsupported descriptor version: <n>")`. Unknown fields → ignored silently (forward-compat per A.5).

## Data Flow

### Subprocess lifecycle

```
NomaTools.spawn()
  └─ resolve mcp-server binary (default: require.resolve("@noma/mcp-server/dist/index.js"))
     spawn(node, [binary]) via @modelcontextprotocol/sdk's StdioClientTransport
     await initialize handshake
     return NomaTools instance

NomaTools.close()
  └─ transport.close() (sends MCP shutdown notification, ends stdin)
     wait up to 5s for child exit
     SIGTERM if still running, then SIGKILL after another 2s
```

One subprocess per `NomaTools` instance. The MCP client library handles request id allocation and multiplexing — multiple concurrent SDK calls are correlated by id, not serialized.

### Single call flow (`readDoc` as canonical example)

```
caller.readDoc(file)
  → mcpClient.callTool({ name: "read_doc", arguments: { file } })
    → request: tools/call, id=N
    ← response: { content: [{ type: "text", text: "{\"blocks\":[...]}" }], isError: false }
  → if response.isError: throw NomaSystemError(content[0].text)
  → parse content[0].text as JSON
  → return { blocks }
```

### Safe-patch flow

```
NomaWorkflow.safePatch(file, op, { retryOnShaMismatch: N })
  └─ acquire per-file mutex (this.fileMutex.get(file))
     try {
       for attempt in 0..N:
         sha = sha256_8(await fs.readFile(file))
         result = await this.tools.patchBlock(file, op, { expectedSha: sha, ... })
         if result.ok: return result
         if result.code !== "sha_mismatch": return result
         continue
       return result  // last sha_mismatch
     } finally {
       release per-file mutex
     }
```

The per-file mutex is a `Map<string, Promise<void>>` keyed by absolute file path. Acquire = chain on the existing promise. Release = resolve. Two concurrent `safePatch` calls on the same file within the same workflow serialize automatically. External writers (other processes, other workflows) are still detected by `expected_sha` and trigger the retry loop normally.

### Capability check flow

```
NomaWorkflow.checkCapability(file, op)
  └─ desc = await this.readCapabilities(file)
     if desc === null: return { allowed: false, reason: "no_descriptor", detail: `${file}.capabilities.yml` }
     blockName = await this.inferBlockName(file, op)   // uses tools.readDoc to resolve id → name
     policy = desc.blocks.get(blockName)
     if !policy: return { allowed: false, reason: "block_not_listed", detail: blockName }
     if !policy.ops.has(op.op): return { allowed: false, reason: "op_not_granted", detail: op.op }
     if op.op === "update_attribute":
       attrCheck = desc.validateAttr(blockName, op.key, op.value)
       if !attrCheck.ok: return { allowed: false, reason: "attr_constraint_violated", detail: attrCheck.reason }
     return { allowed: true }
```

`inferBlockName` issues one `readDoc` call to resolve the patch op's target id to its directive name (`claim`, `evidence`, etc.). Cost: one round-trip per `checkCapability` invocation. Acceptable because checks are advisory and not on the hot path.

### Transcript replay

```
NomaWorkflow.replayTranscript(file)
  └─ raw = await fs.readFile(`${file}.patches`, "utf8").catch(() => "")
     if !raw: return []
     return raw.split("\n").filter(Boolean).map(line => JSON.parse(line) as TranscriptRecord)
```

No validation beyond shape — the server is the source of truth for transcript format. Integration tests assert records appear after every `patchBlock` call.

## Error Handling

### Two channels

| Channel | When | Examples |
|---------|------|----------|
| **Throws** `NomaSystemError` (or subclass) | System fault — caller cannot recover by inspecting a body | Subprocess died, stdio framing broken, file I/O failure, capability YAML malformed, MCP `isError: true`, request timeout |
| **Returns** `{ ok: false, code }` | User-recoverable patch error from §3.5 | `target_missing`, `sha_mismatch`, `id_conflict`, `invalid_content`, `unsupported_op`, `rename_collision`, `schema_violation` |

### Error class hierarchy

```ts
class NomaSystemError extends Error {
  readonly cause?: unknown;
  constructor(message: string, cause?: unknown);
}

class NomaSpawnError extends NomaSystemError {}        // subprocess failed to start
class NomaTransportError extends NomaSystemError {}    // stdio framing error or subprocess exit mid-request
class NomaCapabilityError extends NomaSystemError {}   // sidecar YAML or schema violation
class NomaTimeoutError extends NomaSystemError {}      // request exceeded requestTimeoutMs
```

Shallow on purpose. `instanceof NomaSystemError` catches all four subclasses. The `cause` field carries the underlying Node error for inspection.

### PatchFailure shape

```ts
type PatchErrorCode =
  | "target_missing"
  | "sha_mismatch"
  | "id_conflict"
  | "invalid_content"
  | "unsupported_op"
  | "rename_collision"
  | "schema_violation";

type PatchFailure = {
  ok: false;
  error: string;
  code?: PatchErrorCode | string;  // string passthrough for forward-compat with future server codes
};
```

The `code` field is the type-narrowing primitive. Callers `switch (result.code)` with exhaustive cases for v1.0 codes plus a `default` branch for forward-compat.

### Timeouts

Per-request `requestTimeoutMs` (default 30s). On timeout the SDK throws `NomaTimeoutError`. The subprocess is NOT killed — the next request reuses the same child. A consistently-hanging subprocess is a system fault: caller calls `close()` and respawns.

### Subprocess crash mid-request

`stdout` EOF detected → all in-flight requests reject with `NomaTransportError("subprocess exited unexpectedly")`. The `NomaTools` instance enters a terminal state — further calls throw `NomaTransportError("client closed")`. No auto-respawn. Annex B graduation needs honest crash signals; silent restart hides real bugs.

## Testing

Five-tier pyramid. Each tier maps to a specific annex graduation requirement.

### Tier 1 — Unit tests (`test/capabilities.test.ts`, `test/errors.test.ts`, `test/transport.test.ts`)

Pure logic, no subprocess. YAML schema parser accepts/rejects every §A.3 field shape. Error classes carry `cause`. Transport framing handles partial reads (covered by `@modelcontextprotocol/sdk` itself — SDK only tests its own wrappers).

### Tier 2 — Tools tests (`test/tools.test.ts`)

Spawns real `@noma/mcp-server` subprocess per file (shared via `before()`). Asserts:
- Each of the four tools returns the documented shape on a valid fixture.
- Every §3.5 patch error code (`target_missing`, `sha_mismatch`, `id_conflict`, `invalid_content`, `unsupported_op`, `rename_collision`, `schema_violation`) surfaces as `{ ok: false, code }` via `patchBlock` — never as a thrown system error.
- `isError: true` system faults (book manifest path on read/list/validate, file-not-found) throw `NomaSystemError`.
- Transcript file `<file>.patches` is appended after every `patchBlock`, including rejections and noops.

### Tier 3 — Workflow tests (`test/workflow.test.ts`)

- `safePatch` succeeds on first try when SHA matches.
- `safePatch` retries N times and succeeds on Nth attempt when an external writer modifies SHA between attempts (test edits the file between mocked retry boundaries).
- `safePatch` returns the final `sha_mismatch` failure after exhausting retries.
- `safePatch` serializes same-file concurrent calls within one workflow (mutex correctness — two concurrent calls must produce sequential transcript records, not interleaved).
- `applyOps` short-circuits on first failure when `stopOnFirstError: true`; continues otherwise.
- `applyOps` chains `parent_op_id` correctly when `parentChain: true`.
- `replayTranscript` round-trips: `applyOps` writes N records → `replayTranscript` reads exactly N back.
- `checkCapability` produces each of the four reason codes (`no_descriptor`, `block_not_listed`, `op_not_granted`, `attr_constraint_violated`) on tailored fixtures.

### Tier 4 — Demo replay (`scripts/agent-stale-memo-sdk.ts`, `scripts/agent-memory-demo-sdk.ts`)

Both existing demos rewritten on top of the SDK. Same patch sequences, same final document, but every patch flows through `NomaWorkflow.safePatch`. The trace HTML output is compared byte-for-byte against the non-SDK baseline (or with documented diffs explained). Production-conditions proxy: realistic multi-op workflows under the real wire format.

### Tier 5 — Conformance reuse (`test/conformance.test.ts`)

Each fixture under `examples/conformance/patch/{add_block,delete_block,rename_id,replace_block,update_attribute,replay-chain}/` has `patch.json` and `expected.post.noma`. The SDK harness loads each fixture, drives the patch(es) through `NomaTools.patchBlock`, asserts the post-patch file matches `expected.post.noma` byte-for-byte. Pass rate over the corpus is the headline metric.

### Annex graduation metrics

A single test report captures three numbers:

1. **Error code coverage** — # of distinct §3.5 codes observed through the SDK at least once. Target: 7/7 (100%).
2. **Descriptor shape coverage** — # of `nomaAgent.blocks.*.ops`, `attrs.*.type`, `attrs.*.min/max`, `attrs.*.enum`, `ids.rename`, `validation.required` shapes exercised by `checkCapability`. Target: every documented field.
3. **Conformance pass rate** — # of `examples/conformance/patch/*` fixtures passing via the SDK. Target: 6/6 (100%, current corpus size).

When all three hit target, Annexes A and B promote from `provisional` to `normative` in v1.1.

## Open questions for the implementation plan

These don't block the spec but will surface in `writing-plans`:

- Should `applyOps` expose a "dry-run" mode that calls `validate_doc` between ops without writing? (Probably yes, but cost is non-trivial — each step is a round-trip.)
- Does the SDK need a public `mcpClient` accessor for callers who want to call MCP methods the SDK doesn't wrap? (Probably no — escape hatch creates compat liability.)
- Should `readCapabilities` cache by file path within a single workflow instance? (Trade-off: fewer disk reads vs. detecting sidecar edits between calls.)

## Out-of-scope (deferred)

| Item | Defer reason |
|------|--------------|
| Python SDK | Separate brainstorm post-v1.1 once TS SDK shape stabilizes |
| HTTP/WebSocket bindings | Annex B §B.8 — v1.1+ items |
| Server-side capability enforcement | Annex A.4 — explicitly deferred to v1.1 |
| Atomic `patch_block_list` | Annex B §B.8 — v1.1+ tool |
| Opinionated authoring helpers | Wait for SDK shape to settle before adding higher-level surface |
| Auto-respawn on subprocess crash | Annex graduation needs honest crash signals |

## Approval trail

- 2026-05-13 Brainstorming session pinned scope, language, transport, layering, polish target, architecture, and per-section design through `superpowers:brainstorming`.
- 2026-05-13 Advisor review caught three issues before spec write: MCP client dep, NomaWorkflow lifecycle ownership, concurrent-safePatch race. All three resolved in this document.
- 2026-05-13 Spec written to `docs/superpowers/specs/2026-05-13-noma-agent-sdk-design.md`.
- Pending: user spec review → `superpowers:writing-plans` for the implementation plan → `/codex review` of the plan per the project's "substantial plan" convention → execution.
