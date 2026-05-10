# Phase 0 Design: @noma/mcp-server

**Date:** 2026-05-10
**Status:** Approved (rev 2 — post-codex)
**Phase:** 0 (validate the core promise)
**Parent plan:** CEO Plan — Noma Protocol Standard (Approach B, Phase 0)

## Goal

Ship a working MCP server that lets an agent read, edit, and validate a `.noma` document at the block level — using the existing patch engine — and produces an append-only patch transcript alongside the file. Validates the agent-edit loop end-to-end before building the broader platform.

## Approach

Approach A — Thin MCP server, tools-only. Stateless (all tools take a `file` path argument). Stdio transport. Four tools wrapping existing `@noma/cli` package logic. No new AST types. No `noma://` URL scheme (Phase 4). No capability enforcement (Phase 3).

## Package Structure

```
packages/
  mcp-server/
    src/
      index.ts             ← McpServer setup, tool registrations
      tools/
        read-doc.ts        ← read_doc handler
        list-ids.ts        ← list_ids handler
        patch-block.ts     ← patch_block handler + transcript append
        validate-doc.ts    ← validate_doc handler
      transcript.ts        ← .noma.patches JSONL writer
    package.json           ← name: @noma/mcp-server, bin: noma-mcp-server
                              deps: @modelcontextprotocol/sdk, @noma/cli (workspace:*)
    tsconfig.json          ← extends ../../tsconfig.json
                              MUST override: rootDir, outDir, include
                              (root tsconfig has rootDir:"src" which breaks sub-packages)
```

Root `package.json` gains `"workspaces": ["packages/*"]`. The root package is `@noma/cli`
(not `noma`) — the workspace dep must reference `@noma/cli`.

### Running the server

```json
{ "command": "node", "args": ["packages/mcp-server/dist/index.js"] }
```

## Path Policy

Phase 0 is intentionally unrestricted: tools accept any absolute path to a `.noma` file
the process can read/write. This is explicitly unsafe — the server trusts the caller.
Workspace-root restriction defers to Phase 3 (capability descriptor). Callers must
be aware they are operating with ambient filesystem permissions.

## Tool Schemas

### `read_doc`

```typescript
input:  { file: string }
output: { blocks: BlockSummary[] }
```

`BlockSummary` is a shallow, type-accurate view of each node. Fields vary by node type —
only directives have `attrs`; sections have `id/level/title/aliases`; other node types
expose only what the AST carries:

```typescript
type BlockSummary = {
  id?: string;                            // present only if node has an id
  type: string;                           // "section" | "directive" | "paragraph" | etc
  name?: string;                          // directive name (type === "directive" only)
  attrs?: Record<string, AttrValue>;      // directive only — undefined for other types
  title?: string;                         // section only
  level?: number;                         // section only
  aliases?: string[];                     // section only
  childCount: number;
  lines: [number, number];                // [startLine, endLine], 1-based
  patchable: boolean;                     // true only if id is present and non-empty
}
```

`patchable: false` means the block exists in the AST but cannot be targeted by any patch
op. Paragraphs, lists, tables, and code blocks only receive an id if the author set one
explicitly via a heading attribute — the parser does not auto-assign IDs to them.

### `list_ids`

```typescript
input:  { file: string }
output: { ids: string[]; aliases: Record<string, string> }
// ids: all canonical block IDs in document order
// aliases: map of alias → canonical id
```

Aliases are part of the ID model (`src/validator.ts` tracks `ids` and `aliasIds` separately).
Agents that see only canonical IDs will miss valid patch targets referenced by alias.

### `patch_block`

```typescript
input: {
  file: string,
  op: PatchOp,             // same union as src/patch.ts — validated at runtime via Zod
  reason?: string,         // agent justification — stored in transcript
  expected_sha?: string    // first 8 chars of SHA-256 of file before patch (concurrency guard)
}
output:
  | { ok: true;  post_validation: ValidationSummary; transcript_entry: TranscriptLine }
  | { ok: false; error: string }   // isError: true in MCP error response
```

**Write path:** uses `patchSource()` (from `src/patch.ts`) — not `patch()` + `renderNoma()`.
`patchSource()` splices at line boundaries, preserving every byte outside the patched block.
Using `renderNoma()` would normalize the whole document and destroy byte preservation.

**Concurrency guard:** if `expected_sha` is provided, the handler hashes the file before
applying the patch. If the hash does not match `expected_sha`, it returns `ok: false` with
`error: "precondition_failed"`. Callers that care about lost-update safety must pass this
field (recommended for any multi-agent workflow).

**Atomic write contract:**
1. Read file bytes. If `expected_sha` provided, verify SHA-256[:8] matches — abort if not.
2. Apply op via `patchSource()`.
3. Write result via temp file + `fs.renameSync` (atomic on same filesystem).
4. Run `validate()` on the result. Compute `post_sha`.
5. Append transcript line via `fs.appendFileSync`.

If the process dies between steps 3 and 5, the patch is on disk but unlogged. This is a
known limitation for Phase 0 (transcript is an advisory audit trail, not a WAL). Step 5
is not fsynced — partial JSONL lines are possible under crash. Concurrent appends from
multiple server instances are uncoordinated.

**Known sharp edges in the underlying patch engine (document, don't silently swallow):**
- `update_attribute` only works on directive nodes, not heading sections. Heading
  `id` and `aliases` are immutable except via `rename_id`.
- `rename_id` rewrites wikilinks globally including inside code fences and escape-hatch
  bodies. It also only rewrites a known set of reference attrs — not guaranteed complete.
- `patchSource()` does NOT validate `replace_block` / `add_block` content before
  splicing. Malformed multi-block content can be inserted. Agents should prefer
  `patch()` (AST-level, validates via `parseFragment()`) for content ops; `patchSource()`
  is used for byte preservation but skips fragment validation.

When these limitations are hit, return `ok: false` with a descriptive `error` string
rather than silently applying a broken patch.

**Runtime validation:** `PatchOp` is a TypeScript type, not a JSON schema. All MCP tool
inputs are raw JSON. Use Zod (or equivalent) to validate the `op` discriminant and
required fields before passing to the patch engine. Reject invalid discriminants,
missing required fields, non-integer `position`, and oversized content/reason strings
(cap at 1 MB) with `ok: false`.

### `validate_doc`

```typescript
input:  { file: string }
output: { ok: boolean; diagnostics: Diagnostic[] }
```

No `profile` parameter. The validator reads the profile from the document's own
frontmatter (`profile:` or `profiles:` key). Known profiles: `minimal`, `technical`,
`research` (`src/validator.ts:34`). Injecting a profile externally is not supported by
the current validator API — this is a Phase 3 concern.

`ok` is `true` if `diagnostics` contains no entries with `severity === "error"`.
Warning-only results are `ok: true`. The mapping:

```typescript
function summarize(diagnostics: Diagnostic[]): ValidationSummary {
  const hasError = diagnostics.some(d => d.severity === "error");
  const hasWarn  = diagnostics.some(d => d.severity === "warn");
  return hasError ? "error" : hasWarn ? "warn" : "ok";
}
```

`.noma.yml` book manifests are explicitly rejected with a useful error message
("book manifests are not supported by validate_doc — use the CLI").

## Transcript Format

Sidecar file: `<file>.noma.patches` — append-only JSONL.

```jsonl
{"v":1,"ts":"2026-05-10T14:23:01Z","agent":"unknown","op":{...},"reason":"...","pre_validation":"ok","post_validation":"ok","pre_sha":"a3f9ef12","post_sha":"b1c2de34"}
```

| Field | Type | Description |
|---|---|---|
| `v` | `1` | transcript format version |
| `ts` | ISO 8601 | wall-clock time of the patch |
| `agent` | string | from MCP `_meta.progressToken` or request context if available; `"unknown"` if not |
| `op` | PatchOp | the applied op |
| `reason` | string | agent-provided justification; `""` if not provided |
| `pre_validation` | `"ok"` \| `"warn"` \| `"error"` | validator state before patch |
| `post_validation` | `"ok"` \| `"warn"` \| `"error"` | validator state after patch |
| `pre_sha` | string | SHA-256[:8] of file content **before** patch |
| `post_sha` | string | SHA-256[:8] of file content **after** patch |

Rules:
- File created on first patch, never rewritten.
- `pre_sha`/`post_sha` together allow detection of out-of-band edits: if next patch's
  `pre_sha` ≠ last entry's `post_sha`, the file was changed outside the MCP server.
- Agent identity from MCP context is advisory only — not authenticated.
- Transcript is best-effort: crash between write and append leaves the patch on disk
  but unlogged. Do not treat transcript as a complete WAL.

## Error Handling

| Category | Behavior |
|---|---|
| File not found / not `.noma` / permission denied | MCP `isError: true`, no state written |
| Book manifest (`.noma.yml`) passed to patch_block | MCP `isError: true`, no state written |
| `expected_sha` mismatch | `ok: false`, `error: "precondition_failed"`, no state written |
| Invalid op schema (runtime Zod validation) | `ok: false`, `error: "invalid_op: ..."`, no state written |
| Block ID not found / `PatchError` from engine | `ok: false`, `error: "..."`, no state written |
| Content too large (>1 MB) | `ok: false`, `error: "content_too_large"`, no state written |
| Post-patch validator errors | `ok: true`, `post_validation: "error"`, full diagnostics in response — patch on disk, agent decides |

The server does not refuse a patch because the document becomes invalid. It surfaces
the post-state and defers the decision to the agent or human reviewer.

## Out of Scope (Phase 0)

- MCP Resources / `noma://` URIs (Phase 4)
- Capability descriptor enforcement (Phase 3 / v1.1)
- Workspace-root path restriction (Phase 3)
- 3-way merge (Phase 2 / v1.1)
- TypeScript Agent SDK (Phase 3 / v1.1)
- `noma diff` (Phase 2)
- Signed patches / Ed25519 (Phase 6 / v1.1)
- Fragment validation in `patchSource()` — known engine limitation, document and surface to caller
- Transcript fsync / WAL semantics — advisory only in Phase 0
