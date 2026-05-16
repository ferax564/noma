"""Stdio MCP transport — spawns the Node ``@ferax564/noma-mcp-server``.

Mirrors ``packages/agent-sdk/src/transport.ts``. Default command is
``npx -y @ferax564/noma-mcp-server`` so the Python SDK does not require the
caller to clone the Noma repo — the npm registry resolves the server binary.
Callers may override with a local node binary for development / CI.
"""

from __future__ import annotations

import asyncio
from contextlib import AsyncExitStack
from dataclasses import dataclass, field
from typing import Any

from mcp import ClientSession, StdioServerParameters
from mcp.client.stdio import stdio_client

from .errors import NomaSpawnError, NomaTimeoutError, NomaTransportError

DEFAULT_TIMEOUT_S = 30.0

DEFAULT_COMMAND = "npx"
DEFAULT_ARGS: tuple[str, ...] = ("-y", "@ferax564/noma-mcp-server")


@dataclass
class StdioMcpClientOptions:
    """Configuration for spawning the Node MCP server child process."""

    command: str = DEFAULT_COMMAND
    args: list[str] = field(default_factory=lambda: list(DEFAULT_ARGS))
    env: dict[str, str] | None = None
    request_timeout_s: float = DEFAULT_TIMEOUT_S


@dataclass
class ToolCallResult:
    is_error: bool
    text: str


class StdioMcpClient:
    """Thin async wrapper around ``mcp.ClientSession`` over stdio.

    Use :meth:`spawn` (an ``async`` factory) to create — the session must be
    set up inside an event loop, and the constructor cannot be ``async``.

    Always call :meth:`close` (or use ``async with``) to tear down the child
    process. Leaking the process leaks file descriptors on every spawn.
    """

    def __init__(
        self,
        session: ClientSession,
        exit_stack: AsyncExitStack,
        timeout_s: float,
    ) -> None:
        self._session = session
        self._exit_stack = exit_stack
        self._timeout_s = timeout_s
        self._closed = False

    @classmethod
    async def spawn(cls, options: StdioMcpClientOptions | None = None) -> "StdioMcpClient":
        opts = options or StdioMcpClientOptions()
        params = StdioServerParameters(
            command=opts.command,
            args=list(opts.args),
            env=opts.env,
        )
        stack = AsyncExitStack()
        try:
            read, write = await stack.enter_async_context(stdio_client(params))
            session = await stack.enter_async_context(ClientSession(read, write))
            await session.initialize()
        except Exception as cause:
            await stack.aclose()
            raise NomaSpawnError(
                f"failed to start mcp-server ({opts.command} {' '.join(opts.args)}): {cause}",
                cause,
            ) from cause
        return cls(session, stack, opts.request_timeout_s)

    async def __aenter__(self) -> "StdioMcpClient":
        return self

    async def __aexit__(self, *_exc: object) -> None:
        await self.close()

    async def list_tools(self) -> list[str]:
        self._assert_open()
        res = await self._with_timeout(self._session.list_tools())
        return [t.name for t in res.tools]

    async def call_tool(self, name: str, arguments: dict[str, Any]) -> ToolCallResult:
        self._assert_open()
        raw = await self._with_timeout(
            self._session.call_tool(name, arguments=arguments)
        )
        content = getattr(raw, "content", None)
        if not content:
            raise NomaTransportError(f"tool {name} returned no content")
        first = content[0]
        text = getattr(first, "text", None)
        if text is None:
            raise NomaTransportError(f"tool {name} returned non-text content")
        return ToolCallResult(is_error=bool(getattr(raw, "isError", False)), text=str(text))

    async def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        await self._exit_stack.aclose()

    def _assert_open(self) -> None:
        if self._closed:
            raise NomaTransportError("client closed")

    async def _with_timeout(self, coro):
        try:
            return await asyncio.wait_for(coro, timeout=self._timeout_s)
        except asyncio.TimeoutError as cause:
            raise NomaTimeoutError(
                f"request exceeded {self._timeout_s}s", cause
            ) from cause


__all__ = [
    "DEFAULT_ARGS",
    "DEFAULT_COMMAND",
    "DEFAULT_TIMEOUT_S",
    "StdioMcpClient",
    "StdioMcpClientOptions",
    "ToolCallResult",
]
