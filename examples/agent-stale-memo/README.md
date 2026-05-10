# Demo — agent updates a stale research memo

The pitch line for Noma is *"agents edit at the block level so unrelated bytes
stay verbatim."* This demo proves it on a research memo: five patch ops, two
stale citations refreshed, one claim's confidence raised with fresh evidence,
one risk escalated — and ~90% of the source file's lines unchanged.

## Files

- [`memo.noma`](./memo.noma) — a Q1 2026 vertical-AI memo with two stale
  citations (accessed in late 2025; frontmatter sets `stale_citation_days: 60`),
  one claim with conservative confidence, and one risk that needs an upgrade.
- [`patches.json`](./patches.json) — five block-level operations: update two
  citation `accessed` dates, raise one claim's `confidence`, attach a fresh
  `::evidence` block, and bump one risk's `severity`.
- The runner lives at [`scripts/agent-stale-memo.ts`](../../scripts/agent-stale-memo.ts).

## Run it

```bash
npm run demo:stale-memo
```

The script:

1. **Validates the memo** — surfaces the `stale-citation` warnings.
2. **Applies the patches** via `patchSource(source, ops)` — the
   source-preserving CLI path. Each op rewrites only its own line range.
3. **Re-validates** — clean.
4. **Reports byte/line stats** — ~90% of lines unchanged on this memo.
5. **Writes a narrated trace** to `dist/examples/agent-stale-memo/trace.html`
   that you can ship as part of `npm run build:site`.

## Expected output

```
noma agent-stale-memo demo
--------------------------
source:    examples/agent-stale-memo/memo.noma
patches:   examples/agent-stale-memo/patches.json  (5 ops)

before:    2 diagnostic(s) — stale-citation, etc.
after:     0 diagnostic(s) — should be 0

bytes:     3437 → 3742   (+305)
lines:     10/93 changed   (89.2% preserved)
trace:     dist/examples/agent-stale-memo/trace.html
```

## Why this matters

- **Reviewer cost.** A full-file rewrite forces a reviewer to diff the whole
  document. Five block-scoped ops surface as five small hunks.
- **Identifier stability.** The patch protocol moves attributes by name, so
  references like `::evidence{for="claim-clinical-leaders"}` and `[[risk-mcp]]`
  do not need to be re-serialized.
- **Audit trail.** Every patch can be paired with a `::provenance` block (see
  `docs/agent-protocol.noma`). The Git diff is the changelog.

## Try variations

Change a number, add an op, see what happens. The CLI form is also valid:

```bash
# One inline op
npm run noma -- patch examples/agent-stale-memo/memo.noma \
  --op '{"op":"update_attribute","id":"risk-frontier-leap","key":"severity","value":"high"}' \
  --out /tmp/memo-after.noma

# A whole patch file
npm run noma -- patch examples/agent-stale-memo/memo.noma \
  --ops examples/agent-stale-memo/patches.json \
  --out /tmp/memo-after.noma
```

Diff the result against the input: every untouched block is byte-identical.
