"""1:1 wrapper over the MCP tools exposed by ``@ferax564/noma-mcp-server``.

Mirrors ``packages/agent-sdk/src/tools.ts``. Each method calls a single MCP
tool and decodes the JSON body. Schema validation uses the pydantic models in
:mod:`noma_agent_sdk.types` — invalid server responses raise pydantic's
``ValidationError`` rather than failing silently.

Workflow-level helpers (safePatch retries, capability checks, transcript
replay) intentionally do NOT live here. They land in v0.2.0 as ``NomaWorkflow``.
"""

from __future__ import annotations

import json
from dataclasses import dataclass
from typing import Any

from pydantic import TypeAdapter

from .errors import NomaSystemError
from .transport import StdioMcpClient, StdioMcpClientOptions
from .types import (
    Actor,
    BlockSummary,
    Diagnostic,
    PatchFailure,
    PatchOp,
    PatchResult,
    PatchSuccess,
)

_BLOCK_LIST_ADAPTER = TypeAdapter(list[BlockSummary])
_DIAG_LIST_ADAPTER = TypeAdapter(list[Diagnostic])


@dataclass
class PatchOptions:
    """Optional metadata passed alongside a patch op.

    Names mirror the TS SDK; field names use Python snake_case but map to the
    same wire keys (``expected_sha``, ``base_sha256``, ``parent_op_id``).
    """

    reason: str | None = None
    expected_sha: str | None = None
    actor: Actor | None = None
    base_sha256: str | None = None
    parent_op_id: str | None = None


@dataclass
class ReadDocResult:
    blocks: list[BlockSummary]


@dataclass
class ListIdsResult:
    ids: list[str]
    aliases: dict[str, str]


@dataclass
class ValidateDocResult:
    ok: bool
    diagnostics: list[Diagnostic]


class NomaTools:
    """Async client for the four v1.0 MCP tools.

    Create via :meth:`spawn`; always ``await tools.close()`` (or use
    ``async with``) to tear down the Node child process.
    """

    def __init__(self, client: StdioMcpClient) -> None:
        self._client = client

    @classmethod
    async def spawn(cls, options: StdioMcpClientOptions | None = None) -> "NomaTools":
        client = await StdioMcpClient.spawn(options)
        return cls(client)

    async def __aenter__(self) -> "NomaTools":
        return self

    async def __aexit__(self, *_exc: object) -> None:
        await self.close()

    async def close(self) -> None:
        await self._client.close()

    async def read_doc(self, file: str) -> ReadDocResult:
        body = await self._call_json("read_doc", {"file": file})
        return ReadDocResult(blocks=_BLOCK_LIST_ADAPTER.validate_python(body["blocks"]))

    async def list_ids(self, file: str) -> ListIdsResult:
        body = await self._call_json("list_ids", {"file": file})
        return ListIdsResult(
            ids=list(body.get("ids", [])),
            aliases=dict(body.get("aliases", {})),
        )

    async def validate_doc(self, file: str) -> ValidateDocResult:
        body = await self._call_json("validate_doc", {"file": file})
        return ValidateDocResult(
            ok=bool(body["ok"]),
            diagnostics=_DIAG_LIST_ADAPTER.validate_python(body.get("diagnostics", [])),
        )

    async def patch_block(
        self,
        file: str,
        op: PatchOp | dict[str, Any],
        options: PatchOptions | None = None,
    ) -> PatchResult:
        opts = options or PatchOptions()
        # Accept either a pydantic op model or a raw dict — agents constructing
        # ops dynamically prefer dicts; statically-typed callers prefer models.
        op_wire: dict[str, Any]
        if isinstance(op, dict):
            op_wire = op
        else:
            op_wire = op.model_dump(by_alias=True, exclude_none=True)

        args: dict[str, Any] = {"file": file, "op": op_wire}
        if opts.reason is not None:
            args["reason"] = opts.reason
        if opts.expected_sha is not None:
            args["expected_sha"] = opts.expected_sha
        if opts.actor is not None:
            args["actor"] = opts.actor.model_dump(exclude_none=True)
        if opts.base_sha256 is not None:
            args["base_sha256"] = opts.base_sha256
        if opts.parent_op_id is not None:
            args["parent_op_id"] = opts.parent_op_id

        body = await self._call_json("patch_block", args)
        if body.get("ok") is True:
            return PatchSuccess.model_validate(body)
        return PatchFailure.model_validate(body)

    async def _call_json(self, name: str, arguments: dict[str, Any]) -> dict[str, Any]:
        res = await self._client.call_tool(name, arguments)
        if res.is_error:
            raise NomaSystemError(res.text)
        try:
            return json.loads(res.text)
        except json.JSONDecodeError as cause:
            raise NomaSystemError(
                f"tool {name} returned non-JSON body: {res.text[:200]}",
                cause,
            ) from cause


__all__ = [
    "ListIdsResult",
    "NomaTools",
    "PatchOptions",
    "ReadDocResult",
    "ValidateDocResult",
]
