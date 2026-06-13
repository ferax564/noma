"""`noma ids` — collect canonical IDs and the alias map in document order.

Mirrors the reference rule set the conformance `expected.ids.json` fixtures
assert: heading slugs and explicit directive/section IDs are canonical; heading
`{aliases="..."}` and the frontmatter `aliases:` list (attached to the first H1
section) populate the alias map.
"""

from __future__ import annotations

from .parser import Block, Document, parse


def collect_ids(source: str) -> dict:
    doc = parse(source)
    canonical: list[str] = []
    aliases: dict[str, list[str]] = {}

    # Directive blocks and headings interleave by source line; emit in line order.
    events: list[tuple[int, str, object]] = []

    def collect_block_events(block: Block) -> None:
        events.append((block.open_line, "block", block))
        for child in block.children:
            collect_block_events(child)

    for block in doc.blocks:
        collect_block_events(block)
    for heading in doc.headings:
        events.append((heading.line, "heading", heading))

    events.sort(key=lambda e: e[0])

    first_h1_id = next(
        (h.id for _, kind, h in events if kind == "heading" and h.level == 1),
        None,
    )

    for _line, kind, node in events:
        if kind == "block":
            if node.id:
                canonical.append(node.id)
                if node.aliases:
                    aliases.setdefault(node.id, [])
                    aliases[node.id].extend(node.aliases)
        else:  # heading
            canonical.append(node.id)
            extra = list(node.aliases)
            if node.id == first_h1_id and doc.frontmatter_aliases:
                extra = doc.frontmatter_aliases + extra
            if extra:
                aliases.setdefault(node.id, [])
                aliases[node.id].extend(extra)

    return {"canonical": canonical, "aliases": aliases}
