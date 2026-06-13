# noma-py-seed — native Python conformance seed

A **partial, native second implementation** of the Noma format in pure Python,
with **no dependency on the Node reference implementation**. It exists to seed
the v1.0 spec-freeze exit criterion that calls for an independent implementation
passing the shared conformance corpus (PLAN §25.3 #3, §25.5).

Unlike `packages/agent-sdk-py` (which spawns the Node MCP server as a child
process), this package reimplements the parser and patch engine from the
specification and the conformance fixtures, so passing fixtures here is genuine
evidence that the frozen surface is implementable from the spec alone.

## Scope

Deliberately small — it covers the slice of the frozen v1.0 surface the seed
needs to demonstrate independence:

- **Parser + `noma ids`.** Heading-slug IDs, explicit `::section{}` / directive
  IDs, heading `{aliases="..."}`, frontmatter `aliases:` (attached to the first
  H1), code-fence directive suppression, and directive nesting by colon depth.
- **Patch ops:** `replace_body`, `update_attribute`, `add_block` — byte-exact,
  source-preserving, matching `expected.post.noma`.
- **Error codes:** `target_missing`, `id_attribute_protected`, `parent_missing`,
  `invalid_content`, and the `baseHash` → `sha_mismatch` precondition.

It does **not** implement the remaining ops (table/dataset/comment/note families,
`rename_id`, `move_block`, …), full section folding, or the renderers. Those are
the natural next steps for anyone extending the seed toward full conformance.

## Run

```bash
cd packages/noma-py-seed

# Run against the shared corpus (examples/conformance), seed-covered fixtures only:
python3 run_conformance.py

# Unit + conformance tests (stdlib unittest, no third-party deps):
python3 -m unittest discover -s tests
```

Expected: every seed-covered fixture passes (6 `valid/` ID fixtures, 3 `patch/`
ops, 4 `patch-error/` codes).

## Why this matters

The conformance corpus under `examples/conformance/` is the executable contract
for the format (Agent Protocol RFC, Annex C). A second implementation that passes
it — even a partial one in another language — is what turns "a format the
reference tool happens to emit" into "a format you can independently implement."
This package is that proof-of-concept for Python.
