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
