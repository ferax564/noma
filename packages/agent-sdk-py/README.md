# `ferax564-noma-agent-sdk` (Python — v0.1.0 starter)

> **Status: starter / experimental.** This is the **third-party language
> binding** for the [Noma Agent Protocol v1.0](../../docs/spec-agent-protocol-v1.noma).
> The TypeScript SDK at [`packages/agent-sdk`](../agent-sdk) remains the
> reference implementation; this package mirrors its surface 1:1 for the
> four v1.0 MCP tools.
>
> Workflow layer (safe-patch retry, op-list transcripts, replay) and
> capability sidecar parsing land in **v0.2.0**. See "What's missing" below.

## What this gives you (v0.1.0)

- `NomaTools.spawn()` — async factory that spawns the Node
  `@ferax564/noma-mcp-server` over stdio.
- `NomaTools.read_doc(file)` / `list_ids(file)` / `validate_doc(file)` /
  `patch_block(file, op, options=...)` — 1:1 wrappers over the four v1.0
  MCP tools.
- Pydantic models for every patch op variant (`replace_block`,
  `replace_body`, `update_heading`, `add_comment`, `resolve_comment`,
  `add_footnote`, `add_endnote`, `add_change_request`, `update_table_cell`, `update_table_header_cell`, `insert_table_row`,
  `delete_table_row`, `insert_table_column`, `delete_table_column`,
  `update_dataset_cell`, `insert_dataset_row`, `delete_dataset_row`,
  `insert_dataset_column`, `delete_dataset_column`,
  `move_block`, `add_block`, `delete_block`, `update_attribute`, `remove_attribute`,
  `rename_id`) and the §3.5 error code literal type.
- Error hierarchy mirroring the TS SDK: `NomaSystemError`,
  `NomaSpawnError`, `NomaTransportError`, `NomaCapabilityError`,
  `NomaTimeoutError`.

## Install

This package is **not yet on PyPI** — install from source:

```bash
pip install -e packages/agent-sdk-py/
# with the optional test extras:
pip install -e 'packages/agent-sdk-py/[test]'
```

You also need Node.js ≥20 on PATH — the SDK spawns the
`@ferax564/noma-mcp-server` Node binary as a child process. The default
spawn command is `npx -y @ferax564/noma-mcp-server`, which fetches the
server from the npm registry on first use; you can override with a local
build via `StdioMcpClientOptions(command="node", args=["/path/to/dist/index.js"])`.

## Usage

```python
import asyncio
from noma_agent_sdk import NomaTools, UpdateAttributeOp, PatchOptions, Actor

async def main() -> None:
    async with await NomaTools.spawn() as tools:
        doc = await tools.read_doc("./thesis.noma")
        print(f"{len(doc.blocks)} blocks")

        result = await tools.patch_block(
            "./thesis.noma",
            UpdateAttributeOp(id="asml-euv-moat", key="confidence", value=0.92),
            PatchOptions(
                reason="quarterly update",
                actor=Actor(kind="agent", name="research-bot"),
            ),
        )
        if not result.ok:
            print(f"patch failed: {result.code} — {result.error}")

asyncio.run(main())
```

## Errors

Two channels (matches the TS SDK):

- **Raised** as `NomaSystemError` (and subclasses `NomaSpawnError`,
  `NomaTransportError`, `NomaCapabilityError`, `NomaTimeoutError`) for
  system faults the caller cannot recover from by reading a body.
- **Returned** as `PatchFailure(ok=False, code=..., error=...)` for §3.5
  patch errors the server marks as user-recoverable: `target_missing`,
  `parent_missing`, `id_conflict`, `invalid_content`,
  `id_attribute_protected`, `sha_mismatch`.

## What's missing (lands in v0.2.0)

- **`NomaWorkflow`** — safe-patch with per-file mutex, `apply_ops` with
  transcript output, `replay_transcript`. Today, build your own retry
  loop on top of `NomaTools` if you need atomic op-list semantics.
- **`CapabilityDescriptor`** — Annex A.3 sidecar parser. Until then,
  enforce capabilities on the server side via `noma.capabilities.yml`.
- **Full §3.5 error code coverage** — `pre_validation_blocked` and
  `op_list_aborted` only surface via op-list flows (Annex B.8), which
  this v0.1.0 binding does not yet expose.

## Tests

```bash
# Requires Node.js ≥20 + a built MCP server in this same repo:
npm run build -w @ferax564/noma-mcp-server

# Then:
pip install -e 'packages/agent-sdk-py/[test]'
python -m pytest packages/agent-sdk-py/tests
```

The test suite avoids `npx` to keep CI hermetic — it spawns
`packages/mcp-server/dist/index.js` directly. If that path doesn't exist,
tests are skipped with a clear message instead of failing.

## License

MIT — same as the rest of Noma.
