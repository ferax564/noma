# Phase 0 Design: @noma/mcp-server

**Date:** 2026-05-10
**Status:** Approved
**Phase:** 0 (validate the core promise)
**Parent plan:** CEO Plan — Noma Protocol Standard (Approach B, Phase 0)

## Goal

Ship a working MCP server that lets an agent read, edit, and validate a `.noma` document at the block level — using the existing patch engine — and produces an append-only patch transcript alongside the file. Validates the agent-edit loop end-to-end before building the broader platform.

## Approach

Approach A — Thin MCP server, tools-only. Stateless (all tools take a `file` path argument). Stdio transport. Four tools wrapping existing `noma` package logic. No new AST types. No `noma://` URL scheme (Phase 4). No capability enforcement (Phase 3).

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
    tsconfig.json          ← extends ../../tsconfig.json
```

Root `package.json` gains `"workspaces": ["packages/*"]`. `mcp-server` lists `noma` as a workspace dependency.

### Running the server

```json
{ "command": "node", "args": ["packages/mcp-server/dist/index.js"] }
```

## Tool Schemas

### `read_doc`

```typescript
input:  { file: string }
output: { blocks: BlockSummary[] }
```

`BlockSummary`:
```typescript
type BlockSummary = {
  id: string;
  type: string;          // "section" | "directive" | "paragraph" | etc
  name?: string;         // directive name if type === "directive"
  attrs: Record<string, AttrValue>;
  childCount: number;
  lines: [number, number];
}
```

Shallow view — enough for an agent to pick patch targets without flooding context.

### `list_ids`

```typescript
input:  { file: string }
output: { ids: string[] }   // all block IDs in document order
```

### `patch_block`

```typescript
input: {
  file: string,
  op: PatchOp,             // same union as src/patch.ts
  reason?: string          // agent justification — stored in transcript
}
output: {
  ok: boolean,
  validation: Diagnostic[],
  transcript_entry: TranscriptLine
}
```

Writes patched source back to disk atomically (temp file + rename). Appends to `.noma.patches` after write succeeds.

### `validate_doc`

```typescript
input:  { file: string, profile?: string }
output: { ok: boolean, diagnostics: Diagnostic[] }
```

`profile` defaults to `"core"`. Passes through to existing `validator.ts`.

## Transcript Format

Sidecar file: `<file>.noma.patches` — append-only JSONL.

```jsonl
{"v":1,"ts":"2026-05-10T14:23:01Z","agent":"claude-sonnet-4-6","op":{...},"reason":"...","pre_validation":"ok","post_validation":"ok","file_sha":"a3f9..."}
```

| Field | Type | Description |
|---|---|---|
| `v` | `1` | transcript format version |
| `ts` | ISO 8601 | wall-clock time |
| `agent` | string | model/agent ID from MCP request context, or `"unknown"` |
| `op` | PatchOp | the applied op |
| `reason` | string? | agent-provided justification |
| `pre_validation` | `"ok"` \| `"warn"` \| `"error"` | validator state before patch |
| `post_validation` | `"ok"` \| `"warn"` \| `"error"` | validator state after patch |
| `file_sha` | string | first 8 chars of SHA-256 of file content after patch |

Rules:
- File created on first patch, never rewritten.
- `file_sha` detects out-of-band edits between patches.
- `reason` is `""` if not provided by agent.

## Error Handling

| Category | Behavior |
|---|---|
| File not found / not `.noma` / permission denied | `isError: true`, no state written |
| Block ID not found / invalid op / `PatchError` | `isError: true`, file unchanged, no transcript append |
| Post-patch validator errors | `ok: true`, `post_validation: "error"`, full diagnostics returned — patch applied, agent/human decides |

The server does not refuse a patch because the document becomes invalid. It surfaces the post-state and defers the decision to the agent or human reviewer.

## Atomic Write Contract

`patch_block`:
1. Parse existing file.
2. Apply op via `patch.ts`.
3. Render back to source via `renderer-noma.ts`.
4. Write via temp file + `fs.renameSync` (atomic on same filesystem).
5. Append transcript line via `fs.appendFileSync`.

If the process dies between steps 4 and 5, the patch is on disk but unlogged. Acceptable for Phase 0 (transcript is advisory audit trail, not the source of truth for file state).

## Out of Scope (Phase 0)

- MCP Resources / `noma://` URIs (Phase 4)
- Capability descriptor enforcement (Phase 3 / v1.1)
- 3-way merge (Phase 2 / v1.1)
- TypeScript Agent SDK (Phase 3 / v1.1)
- `noma diff` (Phase 2)
- Signed patches (Phase 6 / v1.1)
