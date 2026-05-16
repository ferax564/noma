"""Python SDK for the Noma Agent Protocol v1.0 (starter — v0.1.0).

Drives ``@ferax564/noma-mcp-server`` over stdio.

This package is the Python sibling of ``@ferax564/noma-agent-sdk``
(``packages/agent-sdk``). The TypeScript SDK remains the reference
implementation; this binding mirrors its surface 1:1 for the four v1.0 MCP
tools (``read_doc``, ``list_ids``, ``validate_doc``, ``patch_block``).

Workflow layer (``NomaWorkflow``: safe-patch with per-file mutex, op-list
transcripts, transcript replay) and capability sidecar parsing land in v0.2.0.
"""

from .errors import (
    NomaCapabilityError,
    NomaSpawnError,
    NomaSystemError,
    NomaTimeoutError,
    NomaTransportError,
)
from .tools import (
    ListIdsResult,
    NomaTools,
    PatchOptions,
    ReadDocResult,
    ValidateDocResult,
)
from .transport import (
    StdioMcpClient,
    StdioMcpClientOptions,
)
from .types import (
    Actor,
    AddBlockOp,
    AttrValue,
    BlockSummary,
    DeleteBlockOp,
    Diagnostic,
    PatchErrorCode,
    PatchFailure,
    PatchOp,
    PatchOpName,
    PatchResult,
    PatchSuccess,
    RenameIdOp,
    ReplaceBlockOp,
    ReplaceBodyOp,
    TranscriptRecord,
    UpdateAttributeOp,
    UpdateHeadingOp,
)

__version__ = "0.1.0"

__all__ = [
    # tools
    "NomaTools",
    "PatchOptions",
    "ReadDocResult",
    "ListIdsResult",
    "ValidateDocResult",
    # transport
    "StdioMcpClient",
    "StdioMcpClientOptions",
    # errors
    "NomaSystemError",
    "NomaSpawnError",
    "NomaTransportError",
    "NomaCapabilityError",
    "NomaTimeoutError",
    # types
    "Actor",
    "AttrValue",
    "BlockSummary",
    "Diagnostic",
    "PatchErrorCode",
    "PatchFailure",
    "PatchOp",
    "PatchOpName",
    "PatchResult",
    "PatchSuccess",
    "TranscriptRecord",
    # patch ops
    "AddBlockOp",
    "DeleteBlockOp",
    "RenameIdOp",
    "ReplaceBlockOp",
    "ReplaceBodyOp",
    "UpdateAttributeOp",
    "UpdateHeadingOp",
    "__version__",
]
