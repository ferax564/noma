"""Pydantic models + Literal types mirroring ``packages/agent-sdk/src/types.ts``.

The wire shape is snake_case (the server's JSON). Field names here match the
wire exactly so ``model_validate`` round-trips without aliasing. Where the TS
SDK renames at the return boundary (e.g. ``transcriptEntry`` vs
``transcript_entry``), the Python SDK keeps the snake_case server-native name —
Python convention favours snake_case, so no renaming is needed.
"""

from __future__ import annotations

from typing import Annotated, Literal, Union

from pydantic import BaseModel, ConfigDict, Field, NonNegativeInt

# ---------------------------------------------------------------------------
# §3.5 error codes — must match `packages/mcp-server/src/patch.ts`
# (and the TS SDK's PatchErrorCode union) exactly.
# ---------------------------------------------------------------------------
PatchErrorCode = Literal[
    "target_missing",
    "parent_missing",
    "id_conflict",
    "invalid_content",
    "id_attribute_protected",
    "sha_mismatch",
    "pre_validation_blocked",
    "op_list_aborted",
    "unsupported_op",
]

PatchOpName = Literal[
    "replace_block",
    "replace_body",
    "update_heading",
    "add_comment",
    "resolve_comment",
    "add_footnote",
    "add_endnote",
    "add_change_request",
    "update_table_cell",
    "update_table_header_cell",
    "insert_table_row",
    "delete_table_row",
    "insert_table_column",
    "delete_table_column",
    "update_dataset_cell",
    "insert_dataset_row",
    "delete_dataset_row",
    "insert_dataset_column",
    "delete_dataset_column",
    "move_block",
    "add_block",
    "delete_block",
    "update_attribute",
    "remove_attribute",
    "rename_id",
]

# AttrValue mirrors src/ast.ts — string | number | boolean ONLY.
AttrValue = Union[str, int, float, bool]

ValidationSummary = Literal["ok", "warn", "error"]
PatchResultStatus = Literal["applied", "rejected", "noop"]


# ---------------------------------------------------------------------------
# Patch ops — pydantic discriminated union on the literal `op` field
# ---------------------------------------------------------------------------
class _OpBase(BaseModel):
    model_config = ConfigDict(extra="forbid")


class ReplaceBlockOp(_OpBase):
    op: Literal["replace_block"] = "replace_block"
    id: str
    content: str


class ReplaceBodyOp(_OpBase):
    op: Literal["replace_body"] = "replace_body"
    id: str
    content: str


class UpdateHeadingOp(_OpBase):
    op: Literal["update_heading"] = "update_heading"
    id: str
    title: str


class AddCommentOp(_OpBase):
    op: Literal["add_comment"] = "add_comment"
    id: str
    target: str
    content: str
    author: str | None = None
    initials: str | None = None
    date: str | None = None
    reply_to: str | None = None


class ResolveCommentOp(_OpBase):
    op: Literal["resolve_comment"] = "resolve_comment"
    id: str
    resolved_by: str | None = None
    resolved_at: str | None = None


class AddFootnoteOp(_OpBase):
    op: Literal["add_footnote"] = "add_footnote"
    id: str
    target: str
    content: str
    label: str | None = None


class AddEndnoteOp(_OpBase):
    op: Literal["add_endnote"] = "add_endnote"
    id: str
    target: str
    content: str
    label: str | None = None


class AddChangeRequestOp(_OpBase):
    op: Literal["add_change_request"] = "add_change_request"
    id: str
    target: str
    action: Literal["insert", "delete", "replace"]
    from_: str | None = Field(default=None, alias="from")
    to: str | None = None
    text: str | None = None
    content: str | None = None
    author: str | None = None
    date: str | None = None

    model_config = ConfigDict(extra="forbid", populate_by_name=True)


class UpdateTableCellOp(_OpBase):
    op: Literal["update_table_cell"] = "update_table_cell"
    id: str
    row: NonNegativeInt
    column: NonNegativeInt | str
    value: str


class UpdateTableHeaderCellOp(_OpBase):
    op: Literal["update_table_header_cell"] = "update_table_header_cell"
    id: str
    column: NonNegativeInt | str
    value: str


class InsertTableRowOp(_OpBase):
    op: Literal["insert_table_row"] = "insert_table_row"
    id: str
    row: NonNegativeInt
    cells: list[str]


class DeleteTableRowOp(_OpBase):
    op: Literal["delete_table_row"] = "delete_table_row"
    id: str
    row: NonNegativeInt


class InsertTableColumnOp(_OpBase):
    op: Literal["insert_table_column"] = "insert_table_column"
    id: str
    column: NonNegativeInt
    header: str | None = None
    cells: list[str]


class DeleteTableColumnOp(_OpBase):
    op: Literal["delete_table_column"] = "delete_table_column"
    id: str
    column: NonNegativeInt | str


class UpdateDatasetCellOp(_OpBase):
    op: Literal["update_dataset_cell"] = "update_dataset_cell"
    id: str
    row: NonNegativeInt
    column: NonNegativeInt | str
    value: str


class InsertDatasetRowOp(_OpBase):
    op: Literal["insert_dataset_row"] = "insert_dataset_row"
    id: str
    row: NonNegativeInt
    cells: list[str]


class DeleteDatasetRowOp(_OpBase):
    op: Literal["delete_dataset_row"] = "delete_dataset_row"
    id: str
    row: NonNegativeInt


class InsertDatasetColumnOp(_OpBase):
    op: Literal["insert_dataset_column"] = "insert_dataset_column"
    id: str
    column: NonNegativeInt
    header: str
    cells: list[str]


class DeleteDatasetColumnOp(_OpBase):
    op: Literal["delete_dataset_column"] = "delete_dataset_column"
    id: str
    column: NonNegativeInt | str


class MoveBlockOp(_OpBase):
    op: Literal["move_block"] = "move_block"
    id: str
    parent: str
    position: NonNegativeInt | None = None


class AddBlockOp(_OpBase):
    op: Literal["add_block"] = "add_block"
    parent: str
    content: str
    position: int | None = None


class DeleteBlockOp(_OpBase):
    op: Literal["delete_block"] = "delete_block"
    id: str


class UpdateAttributeOp(_OpBase):
    op: Literal["update_attribute"] = "update_attribute"
    id: str
    key: str
    value: AttrValue


class RemoveAttributeOp(_OpBase):
    op: Literal["remove_attribute"] = "remove_attribute"
    id: str
    key: str


class RenameIdOp(_OpBase):
    op: Literal["rename_id"] = "rename_id"
    from_: str = Field(alias="from")
    to: str

    model_config = ConfigDict(extra="forbid", populate_by_name=True)


PatchOp = Annotated[
    Union[
        ReplaceBlockOp,
        ReplaceBodyOp,
        UpdateHeadingOp,
        AddCommentOp,
        ResolveCommentOp,
        AddFootnoteOp,
        AddEndnoteOp,
        AddChangeRequestOp,
        UpdateTableCellOp,
        UpdateTableHeaderCellOp,
        InsertTableRowOp,
        DeleteTableRowOp,
        InsertTableColumnOp,
        DeleteTableColumnOp,
        UpdateDatasetCellOp,
        InsertDatasetRowOp,
        DeleteDatasetRowOp,
        InsertDatasetColumnOp,
        DeleteDatasetColumnOp,
        MoveBlockOp,
        AddBlockOp,
        DeleteBlockOp,
        UpdateAttributeOp,
        RemoveAttributeOp,
        RenameIdOp,
    ],
    Field(discriminator="op"),
]


# ---------------------------------------------------------------------------
# Server response shapes
# ---------------------------------------------------------------------------
class BlockSummary(BaseModel):
    model_config = ConfigDict(extra="allow", populate_by_name=True)

    id: str | None = None
    type: str
    name: str | None = None
    attrs: dict[str, AttrValue] | None = None
    title: str | None = None
    level: int | None = None
    aliases: list[str] | None = None
    child_count: int = Field(alias="childCount")
    lines: tuple[int, int]
    patchable: bool


class DiagnosticPos(BaseModel):
    line: int
    column: int


class Diagnostic(BaseModel):
    model_config = ConfigDict(extra="allow")

    severity: Literal["error", "warning", "info"]
    code: str
    message: str
    pos: DiagnosticPos | None = None
    nodeId: str | None = None


class Actor(BaseModel):
    model_config = ConfigDict(extra="allow")

    kind: Literal["human", "agent", "tool"]
    name: str
    model: str | None = None
    version: str | None = None


class TranscriptRecord(BaseModel):
    """Mirrors `packages/mcp-server/src/transcript.ts` TranscriptLine.

    All fields stay snake_case — this is the wire shape, not an internal API.
    """

    model_config = ConfigDict(extra="allow")

    protocol_version: Literal["1.0"]
    tool_version: str
    op_id: str
    ts: str
    actor: Actor
    doc_uri: str
    pre_sha256: str
    post_sha256: str
    pre_sha: str
    post_sha: str
    op: dict  # raw op dict — we don't re-validate the union on inbound
    patch_result: PatchResultStatus
    pre_validation: ValidationSummary
    post_validation: ValidationSummary
    reason: str | None = None
    parent_op_id: str | None = None
    base_sha256: str | None = None
    diagnostics: list[dict] | None = None
    elapsed_ms: int | None = None
    prev_entry_sha256: str | None = None


class PatchSuccess(BaseModel):
    model_config = ConfigDict(extra="allow")

    ok: Literal[True] = True
    post_validation: ValidationSummary
    transcript_entry: TranscriptRecord
    diagnostics: list[Diagnostic]


class PatchFailure(BaseModel):
    model_config = ConfigDict(extra="allow")

    ok: Literal[False] = False
    error: str
    code: PatchErrorCode | str | None = None


PatchResult = Union[PatchSuccess, PatchFailure]


__all__ = [
    "Actor",
    "AddChangeRequestOp",
    "AddCommentOp",
    "AddBlockOp",
    "AttrValue",
    "BlockSummary",
    "DeleteBlockOp",
    "DeleteDatasetColumnOp",
    "DeleteDatasetRowOp",
    "Diagnostic",
    "DiagnosticPos",
    "InsertDatasetColumnOp",
    "InsertDatasetRowOp",
    "PatchErrorCode",
    "PatchFailure",
    "PatchOp",
    "PatchOpName",
    "PatchResult",
    "PatchResultStatus",
    "PatchSuccess",
    "RenameIdOp",
    "RemoveAttributeOp",
    "ReplaceBlockOp",
    "ReplaceBodyOp",
    "TranscriptRecord",
    "UpdateAttributeOp",
    "UpdateHeadingOp",
    "UpdateTableHeaderCellOp",
    "ValidationSummary",
]
