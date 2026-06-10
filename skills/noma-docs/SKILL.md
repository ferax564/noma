---
name: noma-docs
description: >-
  Use when reading, validating, or editing Noma (.noma) documents or book
  manifests (book.noma.yml) — structured plain-text docs with stable block
  IDs that agents patch block-by-block instead of rewriting files. Triggers:
  any task touching a .noma file, "update the docs" in a repo containing
  .noma sources, or requests to render/export/validate Noma documents.
---

# Maintaining Noma documents

Noma documents are plain text with addressable blocks. You edit them with
**patch operations targeting block IDs** — never by rewriting the file.

All commands need `@ferax564/noma-cli` (`npm install -g @ferax564/noma-cli`,
or `npx -p @ferax564/noma-cli noma …`).

## Read before you write

```bash
noma ids <file.noma>                  # every addressable block ID
noma render <file.noma> --to llm     # deterministic context export
noma check <file.noma>               # validation diagnostics (with fixits)
```

## The editing loop

1. Build a patch op (or list of ops) as JSON. The text field is always
   `content` — not `body`:
   ```json
   { "op": "replace_body", "id": "overview", "content": "New body text." }
   ```
2. **Prove first** — simulates the ops, validates the result, never writes:
   ```bash
   noma proof <file.noma> --op '<json>' --to markdown --out proof.md
   ```
   Exit 1 or `Noma Proof: FAIL` means do not apply; read proof.md for why.
3. Apply:
   ```bash
   noma patch <file.noma> --op '<json>' --inplace
   noma check <file.noma>
   ```

## Op cheat sheet

| Intent | Op |
|---|---|
| Edit a block's text | `replace_body` (`id`, `content`) |
| Replace a whole block incl. fences | `replace_block` (`id`, `content`) |
| Rename a heading, keep its ID | `update_heading` (`id`, `title`) |
| Change one attribute | `update_attribute` (`id`, `key`, `value`) |
| Add a new block under a parent | `add_block` (`parent`, `content`, `position?`) |
| Review comment / reply | `add_comment` (`id`, `target`, `content`, `reply_to?`) |
| Table/dataset cells, rows, columns | `update_table_cell`, `insert_dataset_row`, … |

Full schema: `noma schema patch-op`. Multi-op transactions: `--ops <file.json>`
(applied all-or-nothing).

## Concurrency safety

When a human may edit the same file, include a `baseHash` precondition:
read the block's hash (`blockSourceHash()` from the library, or `hash` from
the MCP server's `read_doc`), attach it to the op, and a `sha_mismatch`
rejection means re-read before retrying.

## Books

For multi-file books, patch the manifest and ops route to the owning chapter:

```bash
noma patch book.noma.yml --ops tx.json --inplace
```

## Hard rules

- Never rewrite a `.noma` file with Write/Edit when a patch op can express
  the change — whole-file writes destroy the reviewable diff and skip proofs.
- Never invent block IDs; only target IDs returned by `noma ids`.
- A failed proof is a stop signal, not an obstacle: fix the op, or report why
  the edit is unsafe.
