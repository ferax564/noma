"""Source-preserving patch ops for the seed: `replace_body`, `update_attribute`,
`add_block`.

Each op rewrites only the addressed region of the source and leaves every other
byte untouched, matching the reference engine's `expected.post.noma` fixtures.
"""

from __future__ import annotations

import hashlib
from typing import Optional

from .parser import Block, Document, parse, serialize_attrs


class PatchError(Exception):
    def __init__(self, code: str, message: str):
        super().__init__(message)
        self.code = code


def _find(blocks: list[Block], block_id: str) -> Optional[Block]:
    for block in blocks:
        if block.id == block_id:
            return block
        found = _find(block.children, block_id)
        if found:
            return found
    return None


def block_source_hash(doc: Document, block: Block) -> str:
    """sha256 over the block's source slice (its open..close lines)."""
    slice_text = "\n".join(doc.lines[block.open_line : block.close_line + 1])
    return hashlib.sha256(slice_text.encode("utf-8")).hexdigest()


def _check_base_hash(doc: Document, block: Optional[Block], op: dict) -> None:
    base = op.get("baseHash")
    if base is None:
        return
    if block is None or not block_source_hash(doc, block).startswith(base):
        raise PatchError("sha_mismatch", "baseHash precondition did not match target block")


def _join(doc: Document, lines: list[str]) -> str:
    text = "\n".join(lines)
    if doc.trailing_newline:
        text += "\n"
    return text


def patch_source(source: str, op: dict) -> str:
    name = op.get("op")
    if name == "update_attribute":
        return _update_attribute(source, op)
    if name == "replace_body":
        return _replace_body(source, op)
    if name == "add_block":
        return _add_block(source, op)
    raise PatchError("unsupported_op", f"seed does not implement op {name!r}")


def _update_attribute(source: str, op: dict) -> str:
    doc = parse(source)
    block = _find(doc.blocks, op["id"])
    if block is None:
        raise PatchError("target_missing", f'block "{op["id"]}" not found')
    _check_base_hash(doc, block, op)
    key = op["key"]
    if key == "id":
        raise PatchError("id_attribute_protected", "id must be changed via rename_id")
    value = op["value"]
    new_attrs: list[tuple[str, object, bool]] = []
    found = False
    for k, v, is_flag in block.attrs:
        if k == key:
            new_attrs.append((k, value, False))
            found = True
        else:
            new_attrs.append((k, v, is_flag))
    if not found:
        new_attrs.append((key, value, False))
    lines = list(doc.lines)
    lines[block.open_line] = f"::{block.name}{{{serialize_attrs(new_attrs)}}}"
    return _join(doc, lines)


def _replace_body(source: str, op: dict) -> str:
    doc = parse(source)
    block = _find(doc.blocks, op["id"])
    if block is None:
        raise PatchError("target_missing", f'block "{op["id"]}" not found')
    _check_base_hash(doc, block, op)
    body_lines = op["content"].split("\n")
    lines = (
        doc.lines[: block.open_line + 1]
        + body_lines
        + doc.lines[block.close_line :]
    )
    return _join(doc, lines)


def _add_block(source: str, op: dict) -> str:
    doc = parse(source)
    parent = _find(doc.blocks, op["parent"])
    if parent is None:
        raise PatchError("parent_missing", f'parent "{op["parent"]}" not found')
    _check_base_hash(doc, parent, op)
    content = op["content"]
    inner = parse(content)
    if len(inner.blocks) != 1 or inner.headings:
        raise PatchError(
            "invalid_content", "add_block content must be exactly one top-level directive"
        )
    content_lines = content.split("\n")
    position = op.get("position", len(parent.children))

    if position <= 0:
        insert_at = parent.open_line + 1
    elif position >= len(parent.children):
        insert_at = parent.close_line
    else:
        insert_at = parent.children[position - 1].close_line + 1

    inserted = content_lines + [""]  # block followed by a blank separator line
    lines = doc.lines[:insert_at] + inserted + doc.lines[insert_at:]
    return _join(doc, lines)
