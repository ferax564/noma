"""Source-preserving patch ops for the seed: `replace_body`, `update_attribute`,
`add_block`.

Each op rewrites only the addressed region of the source and leaves every other
byte untouched, matching the reference engine's `expected.post.noma` fixtures.
"""

from __future__ import annotations

import hashlib
import re
from typing import Optional

from .parser import ATTR_NAME_RE, Block, Document, ListItem, parse, serialize_attr, tokenize_attrs

LINE_BREAK_RE = re.compile(r"[\r\n\u2028\u2029]")
OPEN_LINE_RE = re.compile(r"^(\s*:{2,}\s*[A-Za-z_][\w-]*(?:::[A-Za-z_][\w-]*)*)(\s*\{(.*)\})?\s*$")


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


def _find_item(doc: Document, item_id: str) -> Optional[ListItem]:
    return next((item for item in doc.list_items if item.id == item_id), None)


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


def _uses_crlf(source: str) -> bool:
    lf = source.count("\n")
    return lf > 0 and source.count("\r\n") == lf


def patch_source(source: str, op: dict) -> str:
    """Apply one op. CRLF files are patched as LF and converted back, so
    patched lines keep the file's line endings."""
    if not _uses_crlf(source):
        return _dispatch(source, op)
    patched = _dispatch(source.replace("\r\n", "\n"), op)
    return re.sub(r"\r?\n", "\r\n", patched)


def _dispatch(source: str, op: dict) -> str:
    name = op.get("op")
    if name == "update_attribute":
        return _update_attribute(source, op)
    if name == "replace_body":
        return _replace_body(source, op)
    if name == "add_block":
        return _add_block(source, op)
    raise PatchError("unsupported_op", f"seed does not implement op {name!r}")


def _update_attribute(source: str, op: dict) -> str:
    key = op["key"]
    value = op["value"]
    if not isinstance(key, str) or not ATTR_NAME_RE.match(key):
        raise PatchError("invalid_attribute_key", f"attribute key {key!r} is not a valid name")
    if isinstance(value, str) and LINE_BREAK_RE.search(value):
        raise PatchError("invalid_attribute_value", "attribute values must not contain line breaks")
    if key == "id":
        raise PatchError("id_attribute_protected", "id must be changed via rename_id")
    doc = parse(source)
    block = _find(doc.blocks, op["id"])
    if block is None:
        raise PatchError("target_missing", f'block "{op["id"]}" not found')
    _check_base_hash(doc, block, op)
    lines = list(doc.lines)
    lines[block.open_line] = _rewrite_open_line(lines[block.open_line], key, value)
    return _join(doc, lines)


def _rewrite_open_line(line: str, key: str, value: object) -> str:
    """Replace (or append) one attribute token, keeping every other token verbatim."""
    m = OPEN_LINE_RE.match(line)
    if not m:
        raise PatchError("invalid_content", "malformed directive open line")
    head = m.group(1)
    inner = m.group(3) or ""
    serialized = serialize_attr(key, value)
    parts: list[str] = []
    cursor = 0
    replaced = False
    for tok in tokenize_attrs(inner) or []:
        if tok.key != key:
            continue
        parts.append(inner[cursor : tok.start])
        parts.append(serialized)
        cursor = tok.end
        replaced = True
    parts.append(inner[cursor:])
    rewritten = "".join(parts).strip()
    if not replaced:
        rewritten = f"{rewritten} {serialized}".strip()
    return f"{head}{{{rewritten}}}"


def _body_line_count(lines: list[str], open_line: int, close_line: int, closed: bool) -> int:
    if closed:
        return close_line - open_line - 1
    last = close_line
    while last > open_line and not lines[last].strip():
        last -= 1
    return last - open_line


def _replace_body(source: str, op: dict) -> str:
    doc = parse(source)
    content = op["content"]
    item = _find_item(doc, op["id"])
    block = _find(doc.blocks, op["id"])
    if block is None and item is not None:
        lines = list(doc.lines)
        flat = content.replace("\n", " ")
        lines[item.line] = f"{item.marker}{{#{item.id}}} {flat}"
        return _join(doc, lines)
    if block is None:
        raise PatchError("target_missing", f'block "{op["id"]}" not found')
    _check_base_hash(doc, block, op)
    if block.children:
        raise PatchError("invalid_content", f'block "{op["id"]}" has child blocks; use replace_block')
    body_lines = re.sub(r"\n+$", "", content).split("\n")
    start = block.open_line + 1
    count = _body_line_count(doc.lines, block.open_line, block.close_line, block.closed)
    lines = doc.lines[:start] + body_lines + doc.lines[start + count :]
    patched = _join(doc, lines)
    _assert_contained(doc, parse(patched), start, start + count - 1, start + len(body_lines) - 1)
    return patched


def _structure(doc: Document, start: int, end: int, delta: int) -> list[str]:
    """Signatures of structural nodes outside [start, end] (0-based, inclusive),
    with spans after the region shifted by `delta`."""
    spans: list[tuple[str, int, int]] = []

    def visit(blocks: list[Block]) -> None:
        for b in blocks:
            spans.append((f"block:{b.name}:{b.id or ''}:{b.closed}", b.open_line, b.close_line))
            visit(b.children)

    visit(doc.blocks)
    spans += [(f"heading:{h.id}", h.line, h.line) for h in doc.headings]
    spans += [(f"item:{it.id}", it.line, it.line) for it in doc.list_items]
    out: list[str] = []
    for sig, first, last in spans:
        if first >= start and last <= end:
            continue
        a = first + delta if first > end else first
        b = last + delta if last >= end else last
        out.append(f"{sig}:{a}:{b}")
    return sorted(out)


def _assert_contained(before: Document, after: Document, start: int, old_end: int, new_end: int) -> None:
    if _structure(before, start, old_end, new_end - old_end) != _structure(after, start, new_end, 0):
        raise PatchError(
            "unbalanced_fence_content",
            "replace_body content would change blocks outside the target",
        )


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
    expected = parent.colons + 1
    if inner.blocks[0].colons != expected:
        fence = ":" * expected
        raise PatchError(
            "unbalanced_fence_content",
            f"fragment opens with {inner.blocks[0].colons} colons but this position needs {expected} "
            f'(write "{fence}name{{...}}" … "{fence}")',
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

