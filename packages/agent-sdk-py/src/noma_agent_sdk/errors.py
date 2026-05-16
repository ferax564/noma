"""Error hierarchy mirroring the TypeScript SDK (`packages/agent-sdk/src/errors.ts`).

Two channels — exactly as in the TS SDK:

* **Raised** for system faults the caller cannot recover from by reading a body
  (spawn failure, broken transport, request timeout, capability violation).
* **Returned** as ``{"ok": False, "code", "error"}`` from :meth:`NomaTools.patch_block`
  for §3.5 patch errors the server marks as user-recoverable.

See ``packages/agent-sdk/README.md`` ("Errors") for the full contract.
"""

from __future__ import annotations


class NomaSystemError(Exception):
    """Base class for all SDK-raised system errors."""

    def __init__(self, message: str, cause: object | None = None) -> None:
        super().__init__(message)
        self.cause = cause


class NomaSpawnError(NomaSystemError):
    """Raised when the MCP server child process cannot be spawned or connected."""


class NomaTransportError(NomaSystemError):
    """Raised when the stdio transport returns an unexpected envelope or is closed."""


class NomaCapabilityError(NomaSystemError):
    """Raised when a capability descriptor is malformed.

    Reserved for v0.2.0 (sidecar descriptor parser). Surface preserved so callers
    can write forward-compatible ``except`` clauses today.
    """


class NomaTimeoutError(NomaSystemError):
    """Raised when an MCP request exceeds the configured request timeout."""


__all__ = [
    "NomaSystemError",
    "NomaSpawnError",
    "NomaTransportError",
    "NomaCapabilityError",
    "NomaTimeoutError",
]
