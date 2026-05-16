"""Round-trip tests against the locally-built Node MCP server.

These tests do NOT use ``npx -y @ferax564/noma-mcp-server`` (the default) to
keep CI hermetic — they point at ``packages/mcp-server/dist/index.js`` from
this same repo. If that file is missing, run ``npm run build`` in the repo
root first; otherwise the tests are skipped with a clear message.
"""

from __future__ import annotations

import shutil
from pathlib import Path

import pytest

from noma_agent_sdk import NomaTools, StdioMcpClientOptions

REPO_ROOT = Path(__file__).resolve().parents[3]
MCP_SERVER_BIN = REPO_ROOT / "packages" / "mcp-server" / "dist" / "index.js"
EXAMPLE_DOC = REPO_ROOT / "examples" / "agent-plan.noma"


def _spawn_options() -> StdioMcpClientOptions:
    node = shutil.which("node")
    if node is None:
        pytest.skip("node binary not on PATH")
    if not MCP_SERVER_BIN.exists():
        pytest.skip(
            f"missing {MCP_SERVER_BIN} — run 'npm run build -w @ferax564/noma-mcp-server' first"
        )
    return StdioMcpClientOptions(command=node, args=[str(MCP_SERVER_BIN)])


@pytest.mark.asyncio
async def test_read_doc_round_trip() -> None:
    assert EXAMPLE_DOC.exists(), f"fixture missing: {EXAMPLE_DOC}"
    tools = await NomaTools.spawn(_spawn_options())
    try:
        result = await tools.read_doc(str(EXAMPLE_DOC))
    finally:
        await tools.close()

    # agent-plan.noma is non-empty; we don't pin the exact block count here —
    # the example evolves. The contract under test is: spawn, MCP handshake,
    # tool call, JSON decode, pydantic validation, child shutdown.
    assert len(result.blocks) > 0
    assert all(hasattr(b, "type") for b in result.blocks)


@pytest.mark.asyncio
async def test_list_ids_returns_dict_and_list() -> None:
    tools = await NomaTools.spawn(_spawn_options())
    try:
        ids = await tools.list_ids(str(EXAMPLE_DOC))
    finally:
        await tools.close()

    assert isinstance(ids.ids, list)
    assert isinstance(ids.aliases, dict)


@pytest.mark.asyncio
async def test_validate_doc_returns_ok_flag() -> None:
    tools = await NomaTools.spawn(_spawn_options())
    try:
        res = await tools.validate_doc(str(EXAMPLE_DOC))
    finally:
        await tools.close()

    # ok may be true or false depending on doc state; just assert the shape.
    assert isinstance(res.ok, bool)
    assert isinstance(res.diagnostics, list)
