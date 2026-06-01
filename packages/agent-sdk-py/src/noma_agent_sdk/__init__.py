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
    AddChangeRequestOp,
    AddCommentOp,
    AddEndnoteOp,
    AddFootnoteOp,
    AddBlockOp,
    AttrValue,
    BlockSummary,
    DeleteBlockOp,
    DeleteDatasetColumnOp,
    DeleteDatasetRowOp,
    DeleteTableColumnOp,
    DeleteTableRowOp,
    Diagnostic,
    InsertDatasetColumnOp,
    InsertDatasetRowOp,
    InsertTableColumnOp,
    InsertTableRowOp,
    MoveBlockOp,
    PatchErrorCode,
    PatchFailure,
    PatchOp,
    PatchOpName,
    PatchResult,
    PatchSuccess,
    RenameIdOp,
    RemoveAttributeOp,
    ReplaceBlockOp,
    ReplaceBodyOp,
    ResolveCommentOp,
    TranscriptRecord,
    UpdateAttributeOp,
    UpdateDatasetCellOp,
    UpdateTableCellOp,
    UpdateTableHeaderCellOp,
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
    "MoveBlockOp",
    "AddChangeRequestOp",
    "AddCommentOp",
    "AddEndnoteOp",
    "AddFootnoteOp",
    "AddBlockOp",
    "DeleteBlockOp",
    "DeleteDatasetColumnOp",
    "DeleteDatasetRowOp",
    "DeleteTableColumnOp",
    "DeleteTableRowOp",
    "InsertDatasetColumnOp",
    "InsertDatasetRowOp",
    "InsertTableColumnOp",
    "InsertTableRowOp",
    "RenameIdOp",
    "RemoveAttributeOp",
    "ReplaceBlockOp",
    "ReplaceBodyOp",
    "ResolveCommentOp",
    "UpdateAttributeOp",
    "UpdateDatasetCellOp",
    "UpdateTableCellOp",
    "UpdateTableHeaderCellOp",
    "UpdateHeadingOp",
    "__version__",
]
