"""Minimal native Noma parser — enough to collect canonical IDs/aliases and to
locate directive blocks and list items by source span for the seed patch ops.

This is a *partial second implementation* of the Noma format, written from the
spec and the conformance fixtures rather than from the TypeScript source. It is
deliberately small: it covers the frozen surface the conformance corpus exercises
for the seed (frontmatter detection, heading-ID derivation + aliasing, explicit
section/directive IDs, frontmatter aliases, code-fence suppression, attribute
quoting and escapes, and directive nesting by colon depth).
"""

from __future__ import annotations

import re
import unicodedata
from dataclasses import dataclass, field
from typing import Optional

HEADING_RE = re.compile(r"^(#{1,6})\s+(.+?)\s*$")
# Trailing `{...}` on a heading; only an attribute list if it tokenises strictly.
HEADING_ATTRS_RE = re.compile(r"^(.+?)\s+\{([^}]*)\}$")
# A directive open: two or more colons, a (possibly namespaced) name, optional `{...}`.
DIRECTIVE_OPEN_RE = re.compile(
    r"^(:{2,})\s*([A-Za-z_][\w-]*(?:::[A-Za-z_][\w-]*)*)\s*(\{.*\})?\s*$"
)
# A directive close: only colons.
DIRECTIVE_CLOSE_RE = re.compile(r"^(:{2,})\s*$")
FENCE_OPEN_RE = re.compile(r"^(`{3,})([^`]*)$|^(~{3,})(.*)$")
FENCE_CLOSE_RE = re.compile(r"^(`{3,}|~{3,})\s*$")
LIST_ITEM_RE = re.compile(r"^(\s*(?:[-*]|\d+\.)\s+)(.*)$")
INLINE_ID_RE = re.compile(r"^\{#([A-Za-z][\w:./-]*)\}\s*")
FRONTMATTER_KEY_RE = re.compile(r"""^[\w"'][\w\s"'.-]*:(?:\s|$)""")
ATTR_KEY_RE = re.compile(r"[A-Za-z_][A-Za-z0-9_-]*")
ATTR_NAME_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_-]*$")
MAX_FENCE_COLONS = 64

# Unicode `Script=Inherited` ranges (combining marks, variation selectors,
# joiners) — stripped from slugs after NFC, as the reference implementation does.
_INHERITED_RANGES = (
    (0x0300, 0x036F), (0x0485, 0x0486), (0x064B, 0x0655), (0x0670, 0x0670),
    (0x0951, 0x0954), (0x1AB0, 0x1ACE), (0x1CD0, 0x1CD2), (0x1CD4, 0x1CE0),
    (0x1CE2, 0x1CE8), (0x1CED, 0x1CED), (0x1CF4, 0x1CF4), (0x1CF8, 0x1CF9),
    (0x1DC0, 0x1DFF), (0x200C, 0x200D), (0x20D0, 0x20F0), (0x302A, 0x302D),
    (0x3099, 0x309A), (0xFE00, 0xFE0F), (0xFE20, 0xFE2D), (0x101FD, 0x101FD),
    (0x102E0, 0x102E0), (0x1133B, 0x1133B), (0x1CF00, 0x1CF46), (0x1D167, 0x1D169),
    (0x1D17B, 0x1D182), (0x1D185, 0x1D18B), (0x1D1AA, 0x1D1AD), (0xE0100, 0xE01EF),
)


def _is_inherited(ch: str) -> bool:
    cp = ord(ch)
    return any(lo <= cp <= hi for lo, hi in _INHERITED_RANGES)


def _is_latin(ch: str) -> bool:
    return "LATIN" in unicodedata.name(ch, "")


def _slug_char(ch: str) -> str:
    if ch.isspace() or ch == "-":
        return ch
    if unicodedata.category(ch)[0] not in "LNM":
        return ""
    if _is_latin(ch) and not ("a" <= ch <= "z"):
        return ""
    return ch


def slugify(title: str) -> str:
    """Heading slug: letters and numbers of any script, lowercased, whitespace
    runs become `-`. Latin letters lose diacritics; Latin letters with no ASCII
    decomposition (`ß`, `ø`) are dropped so Latin-script slugs stay stable."""
    text = unicodedata.normalize("NFKD", title.lower())
    text = re.sub("[\u0300-\u036f]", "", text)
    text = unicodedata.normalize("NFC", text)
    text = "".join(ch for ch in text if not _is_inherited(ch))
    text = "".join(_slug_char(ch) for ch in text).strip()
    text = re.sub(r"\s+", "-", text)
    text = re.sub(r"-+", "-", text)
    return text.strip("-")


def heading_slug(title: str) -> str:
    """Auto ID for a heading: its slug, or `section` when the slug is empty."""
    return slugify(title) or "section"


# ---------------------------------------------------------------- attributes


@dataclass
class AttrToken:
    key: str
    value: Optional[str]
    quoted: bool
    start: int
    end: int


def _scan_quoted(s: str, start: int, quote: str) -> Optional[tuple[str, int]]:
    value = ""
    j = start
    while j < len(s):
        c = s[j]
        if c == quote:
            return value, j + 1
        if quote == '"' and c == "\\" and j + 1 < len(s) and s[j + 1] in ('"', "\\"):
            value += s[j + 1]
            j += 2
            continue
        value += c
        j += 1
    return None


def tokenize_attrs(inner: str, strict: bool = False) -> Optional[list[AttrToken]]:
    """Tokenise an attribute list body. Double-quoted values accept `\\"` and
    `\\\\` escapes; other backslashes are literal. Single-quoted values are raw.
    Lenient mode skips stray characters; strict mode returns None on them."""
    tokens: list[AttrToken] = []
    i = 0
    n = len(inner)

    def at_boundary(k: int) -> bool:
        return k >= n or inner[k].isspace()

    while i < n:
        if inner[i].isspace():
            i += 1
            continue
        m = ATTR_KEY_RE.match(inner, i)
        if not m:
            if strict:
                return None
            i += 1
            continue
        start = i
        key = m.group(0)
        i = m.end()
        if i >= n or inner[i] != "=":
            if strict and not at_boundary(i):
                return None
            tokens.append(AttrToken(key, None, False, start, i))
            continue
        vstart = i + 1
        quote = inner[vstart] if vstart < n else ""
        if quote in ('"', "'"):
            scanned = _scan_quoted(inner, vstart + 1, quote)
            if scanned is not None:
                value, nxt = scanned
                if strict and not at_boundary(nxt):
                    return None
                tokens.append(AttrToken(key, value, True, start, nxt))
                i = nxt
                continue
        bare = re.match(r"\S+", inner[vstart:])
        if not bare:
            if strict:
                return None
            tokens.append(AttrToken(key, None, False, start, i))
            continue
        tokens.append(AttrToken(key, bare.group(0), False, start, vstart + bare.end()))
        i = vstart + bare.end()
    return tokens


def _coerce(raw: str) -> object:
    if raw == "true":
        return True
    if raw == "false":
        return False
    if re.fullmatch(r"-?\d+", raw):
        return int(raw)
    if re.fullmatch(r"-?\d+\.\d+", raw):
        return float(raw)
    return raw


def _token_value(tok: AttrToken) -> object:
    if tok.value is None:
        return True
    if tok.quoted or tok.key == "id":
        return tok.value
    return _coerce(tok.value)


def parse_attrs(body: str) -> list[tuple[str, object, bool]]:
    """Parse a `{...}` attribute body into ordered (key, value, is_flag) tuples.

    - key="quoted" / key='quoted' -> str (never coerced; `\\"` and `\\\\` escapes)
    - key=bareword                -> str
    - key=3 / key=0.82            -> number (unquoted only)
    - key=true / key=false        -> bool (unquoted only)
    - id=anything                 -> str (ids are never coerced)
    - flag                        -> (flag, True, is_flag=True)
    """
    return [
        (tok.key, _token_value(tok), tok.value is None)
        for tok in tokenize_attrs(body.strip()) or []
    ]


def split_heading_attrs(text: str) -> tuple[str, Optional[list[tuple[str, object, bool]]]]:
    """Split heading text into title and trailing attributes. The braces count
    as attributes only when they tokenise strictly with a `key=value` pair."""
    trimmed = text.strip()
    m = HEADING_ATTRS_RE.match(trimmed)
    if not m:
        return trimmed, None
    tokens = tokenize_attrs(m.group(2), strict=True)
    if not tokens or not any(t.value is not None for t in tokens):
        return trimmed, None
    return m.group(1).strip(), [(t.key, _token_value(t), t.value is None) for t in tokens]


def serialize_attr(key: str, value: object) -> str:
    """Serialise one attribute so the parser reads back the same value."""
    if value is True:
        return key
    if value is False:
        return f"{key}=false"
    if isinstance(value, float):
        return f"{key}={format_number(value)}"
    if isinstance(value, int):
        return f"{key}={value}"
    s = str(value)
    if '"' in s and "'" not in s:
        return f"{key}='{s}'"
    escaped = re.sub(r'\\(?=[\\"]|$)', r"\\\\", s).replace('"', '\\"')
    return f'{key}="{escaped}"'


def serialize_attrs(attrs: list[tuple[str, object, bool]]) -> str:
    return " ".join(key if is_flag else serialize_attr(key, value) for key, value, is_flag in attrs)


def format_number(value: float) -> str:
    if value == int(value):
        return str(int(value))
    return repr(value)


# ---------------------------------------------------------------- fences


@dataclass
class CodeFence:
    char: str
    length: int


def match_code_fence_open(line: str) -> Optional[CodeFence]:
    m = FENCE_OPEN_RE.match(line)
    if not m:
        return None
    marker = m.group(1) or m.group(3) or ""
    return CodeFence(marker[0], len(marker))


def is_code_fence_close(line: str, fence: CodeFence) -> bool:
    m = FENCE_CLOSE_RE.match(line)
    return bool(m) and m.group(1)[0] == fence.char and len(m.group(1)) >= fence.length


def find_code_fence_close(lines: list[str], start: int, end: int, fence: CodeFence) -> int:
    j = start
    while j < end and not is_code_fence_close(lines[j], fence):
        j += 1
    return j


# ---------------------------------------------------------------- tree


@dataclass
class Block:
    """A directive block with its source span (0-based, inclusive line indices).

    For an unclosed block `closed` is False and `close_line` is the last line of
    the range it swallowed."""

    name: str
    attrs: list[tuple[str, object, bool]]
    open_line: int
    close_line: int
    colons: int = 2
    closed: bool = True
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
    explicit: bool = False
    top_level: bool = True


@dataclass
class ListItem:
    id: str
    line: int
    marker: str


@dataclass
class Document:
    lines: list[str]
    trailing_newline: bool
    frontmatter_aliases: list[str]
    blocks: list[Block]
    headings: list[Heading]
    list_items: list[ListItem] = field(default_factory=list)


def parse(source: str) -> Document:
    trailing_newline = source.endswith("\n")
    raw = source[:-1] if trailing_newline else source
    lines = raw.split("\n") if raw != "" else []

    start, frontmatter_aliases = _frontmatter(lines)
    headings: list[Heading] = []
    list_items: list[ListItem] = []
    blocks = _parse_blocks(lines, start, len(lines), 0, headings, list_items)

    seen: set[str] = set()
    for heading in headings:
        if heading.explicit or not heading.top_level:
            continue
        if heading.id in seen:
            n = 2
            while f"{heading.id}-{n}" in seen:
                n += 1
            heading.id = f"{heading.id}-{n}"
        seen.add(heading.id)

    return Document(
        lines=lines,
        trailing_newline=trailing_newline,
        frontmatter_aliases=frontmatter_aliases,
        blocks=blocks,
        headings=headings,
        list_items=list_items,
    )


def _parse_blocks(
    lines: list[str],
    start: int,
    end: int,
    parent_colons: int,
    headings: list[Heading],
    list_items: list[ListItem],
) -> list[Block]:
    out: list[Block] = []
    i = start
    while i < end:
        line = lines[i]
        open_m = DIRECTIVE_OPEN_RE.match(line)
        if open_m:
            colons = len(open_m.group(1))
            if colons <= MAX_FENCE_COLONS and (colons > parent_colons or parent_colons == 0):
                block, i = _parse_directive(lines, i, end, open_m, headings, list_items)
                out.append(block)
                continue
            i += 1
            continue
        if DIRECTIVE_CLOSE_RE.match(line):
            i += 1
            continue
        head_m = HEADING_RE.match(line)
        if head_m:
            title, attrs = split_heading_attrs(head_m.group(2))
            hid: Optional[str] = None
            aliases: list[str] = []
            for key, value, _flag in attrs or []:
                if key == "id" and isinstance(value, str) and value:
                    hid = value
                elif key == "aliases" and isinstance(value, str):
                    aliases = [a.strip() for a in re.split(r"[ ,]+", value) if a.strip()]
            headings.append(
                Heading(
                    level=len(head_m.group(1)),
                    id=hid if hid is not None else heading_slug(title),
                    aliases=aliases,
                    line=i,
                    explicit=hid is not None,
                    top_level=parent_colons == 0,
                )
            )
            i += 1
            continue
        fence = match_code_fence_open(line)
        if fence:
            close = find_code_fence_close(lines, i + 1, end, fence)
            i = close + 1 if close < end else end
            continue
        item_m = LIST_ITEM_RE.match(line)
        if item_m:
            id_m = INLINE_ID_RE.match(item_m.group(2))
            if id_m:
                list_items.append(ListItem(id=id_m.group(1), line=i, marker=item_m.group(1)))
        i += 1
    return out


def _parse_directive(
    lines: list[str],
    i: int,
    end: int,
    open_m: re.Match,
    headings: list[Heading],
    list_items: list[ListItem],
) -> tuple[Block, int]:
    colons = len(open_m.group(1))
    close = -1
    j = i + 1
    while j < end:
        fence = match_code_fence_open(lines[j])
        if fence:
            j = find_code_fence_close(lines, j + 1, end, fence) + 1
            continue
        close_m = DIRECTIVE_CLOSE_RE.match(lines[j])
        if close_m and len(close_m.group(1)) == colons:
            close = j
            break
        j += 1
    inner_end = end if close == -1 else close
    attrs_body = open_m.group(3)[1:-1] if open_m.group(3) else ""
    block = Block(
        name=open_m.group(2),
        attrs=parse_attrs(attrs_body),
        open_line=i,
        close_line=close if close != -1 else end - 1,
        colons=colons,
        closed=close != -1,
    )
    block.children = _parse_blocks(lines, i + 1, inner_end, colons, headings, list_items)
    return block, (close + 1 if close != -1 else end)


def _frontmatter(lines: list[str]) -> tuple[int, list[str]]:
    """A leading `---` pair is frontmatter when it holds blank text or YAML
    mapping lines; otherwise it is a thematic break followed by content."""
    if not lines or lines[0].strip() != "---":
        return 0, []
    for j in range(1, len(lines)):
        if lines[j].strip() != "---":
            continue
        body = lines[1:j]
        first = next((ln for ln in body if ln.strip() and not ln.strip().startswith("#")), None)
        if all(not ln.strip() for ln in body):
            return j + 1, []
        if first is None or not (FRONTMATTER_KEY_RE.match(first) or first.lstrip().startswith("{")):
            return 0, []
        return j + 1, _parse_frontmatter_aliases(body)
    return 0, []


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
