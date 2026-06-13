"""Minimal native Noma parser — enough to collect canonical IDs/aliases and to
locate directive blocks by source span for the seed patch ops.

This is a *partial second implementation* of the Noma format, written from the
spec and the conformance fixtures rather than from the TypeScript source. It is
deliberately small: it covers the frozen surface the conformance corpus exercises
for the seed (heading-ID derivation + aliasing, explicit section/directive IDs,
frontmatter aliases, code-fence suppression, and directive nesting by colon depth).
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from typing import Optional

HEADING_RE = re.compile(r"^(#{1,6})\s+(.*?)\s*$")
# A directive open: one or more colons, a name, optional `{...}` attribute block.
DIRECTIVE_OPEN_RE = re.compile(r"^(:{2,})([A-Za-z][\w-]*)\s*(\{.*\})?\s*$")
# A directive close: only colons.
DIRECTIVE_CLOSE_RE = re.compile(r"^:{2,}\s*$")
# Trailing `{...}` attribute block on a heading.
HEADING_ATTRS_RE = re.compile(r"^(.*?)\s*\{(.*)\}\s*$")


def slugify(title: str) -> str:
    """Deterministic heading-slug derivation: lowercase, non-alphanumerics to
    single hyphens, trimmed. Matches the reference implementation for the ASCII
    titles in the conformance corpus."""
    # Strip inline markdown emphasis/code markers before slugging.
    text = re.sub(r"[*`_]", "", title)
    slug = re.sub(r"[^a-z0-9]+", "-", text.strip().lower())
    return slug.strip("-")


def parse_attrs(body: str) -> list[tuple[str, object, bool]]:
    """Parse a `{...}` attribute body into ordered (key, value, is_flag) tuples.

    - key="quoted string"  -> str value
    - key=bareword         -> str value
    - key=1.5 / key=3      -> numeric value
    - key=true / key=false -> bool value
    - flag                 -> (flag, True, is_flag=True)
    """
    attrs: list[tuple[str, object, bool]] = []
    tokens = _split_attr_tokens(body)
    for tok in tokens:
        if "=" in tok:
            key, raw = tok.split("=", 1)
            key = key.strip()
            raw = raw.strip()
            attrs.append((key, _coerce(raw), False))
        else:
            attrs.append((tok.strip(), True, True))
    return attrs


def _split_attr_tokens(body: str) -> list[str]:
    tokens: list[str] = []
    cur = ""
    in_quote = False
    for ch in body:
        if ch == '"':
            in_quote = not in_quote
            cur += ch
        elif ch.isspace() and not in_quote:
            if cur:
                tokens.append(cur)
                cur = ""
        else:
            cur += ch
    if cur:
        tokens.append(cur)
    return [t for t in tokens if t]


def _coerce(raw: str) -> object:
    if len(raw) >= 2 and raw[0] == '"' and raw[-1] == '"':
        return raw[1:-1]
    if raw in ("true", "false"):
        return raw == "true"
    try:
        if re.fullmatch(r"-?\d+", raw):
            return int(raw)
        return float(raw)
    except ValueError:
        return raw


def serialize_attrs(attrs: list[tuple[str, object, bool]]) -> str:
    parts: list[str] = []
    for key, value, is_flag in attrs:
        if is_flag:
            parts.append(key)
        elif isinstance(value, str):
            parts.append(f'{key}="{value}"')
        elif isinstance(value, bool):
            parts.append(f"{key}={'true' if value else 'false'}")
        elif isinstance(value, float):
            parts.append(f"{key}={format_number(value)}")
        else:
            parts.append(f"{key}={value}")
    return " ".join(parts)


def format_number(value: float) -> str:
    if value == int(value):
        return str(int(value))
    return repr(value)


@dataclass
class Block:
    """A directive block with its source span (0-based, inclusive line indices)."""

    name: str
    attrs: list[tuple[str, object, bool]]
    open_line: int
    close_line: int
    children: list["Block"] = field(default_factory=list)

    @property
    def id(self) -> Optional[str]:
        for key, value, is_flag in self.attrs:
            if key == "id" and not is_flag and isinstance(value, str):
                return value
        return None

    @property
    def aliases(self) -> list[str]:
        for key, value, is_flag in self.attrs:
            if key == "aliases" and isinstance(value, str):
                return [a.strip() for a in re.split(r"[ ,]+", value) if a.strip()]
        return []


@dataclass
class Heading:
    level: int
    id: str
    aliases: list[str]
    line: int


@dataclass
class Document:
    lines: list[str]
    trailing_newline: bool
    frontmatter_aliases: list[str]
    blocks: list[Block]
    headings: list[Heading]


def parse(source: str) -> Document:
    trailing_newline = source.endswith("\n")
    raw = source[:-1] if trailing_newline else source
    lines = raw.split("\n") if raw != "" else []

    i = 0
    frontmatter_aliases: list[str] = []
    if lines and lines[0].strip() == "---":
        j = 1
        fm: list[str] = []
        while j < len(lines) and lines[j].strip() != "---":
            fm.append(lines[j])
            j += 1
        frontmatter_aliases = _parse_frontmatter_aliases(fm)
        i = j + 1 if j < len(lines) else j

    root: list[Block] = []
    headings: list[Heading] = []
    stack: list[Block] = []
    in_code = False

    while i < len(lines):
        line = lines[i]
        stripped = line.strip()

        if stripped.startswith("```"):
            in_code = not in_code
            i += 1
            continue
        if in_code:
            i += 1
            continue

        open_m = DIRECTIVE_OPEN_RE.match(line)
        if open_m and not _is_pure_close(line):
            attrs_body = open_m.group(3)[1:-1] if open_m.group(3) else ""
            block = Block(
                name=open_m.group(2),
                attrs=parse_attrs(attrs_body),
                open_line=i,
                close_line=i,
            )
            (stack[-1].children if stack else root).append(block)
            stack.append(block)
            i += 1
            continue

        if DIRECTIVE_CLOSE_RE.match(line) and stack:
            stack[-1].close_line = i
            stack.pop()
            i += 1
            continue

        head_m = HEADING_RE.match(line)
        if head_m and not stack_in_code(stack):
            level = len(head_m.group(1))
            title, hid, haliases = _heading_id(head_m.group(2))
            headings.append(Heading(level=level, id=hid, aliases=haliases, line=i))
            i += 1
            continue

        i += 1

    return Document(
        lines=lines,
        trailing_newline=trailing_newline,
        frontmatter_aliases=frontmatter_aliases,
        blocks=root,
        headings=headings,
    )


def stack_in_code(_stack: list[Block]) -> bool:
    return False


def _is_pure_close(line: str) -> bool:
    return DIRECTIVE_CLOSE_RE.match(line) is not None


def _heading_id(rest: str) -> tuple[str, str, list[str]]:
    aliases: list[str] = []
    hid: Optional[str] = None
    title = rest
    m = HEADING_ATTRS_RE.match(rest)
    if m:
        title = m.group(1)
        for key, value, _flag in parse_attrs(m.group(2)):
            if key == "id" and isinstance(value, str):
                hid = value
            elif key == "aliases" and isinstance(value, str):
                aliases = [a.strip() for a in re.split(r"[ ,]+", value) if a.strip()]
    if hid is None:
        hid = slugify(title)
    return title, hid, aliases


def _parse_frontmatter_aliases(fm_lines: list[str]) -> list[str]:
    for line in fm_lines:
        m = re.match(r"^\s*aliases:\s*(.*)$", line)
        if not m:
            continue
        body = m.group(1).strip()
        if body.startswith("[") and body.endswith("]"):
            inner = body[1:-1]
            return [a.strip().strip('"').strip("'") for a in inner.split(",") if a.strip()]
    return []
