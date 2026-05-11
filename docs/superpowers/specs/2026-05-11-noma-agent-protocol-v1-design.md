# Noma Agent Protocol v1.0 — Design Doc

**Status:** design (pre-implementation)
**Phase:** 1 of CEO roadmap
**Author:** ferax564
**Date:** 2026-05-11
**Reviewers consulted:** Codex CLI (gpt-5.5, three consult passes including a full design-doc review)

This is the design doc that will guide drafting the v1.0 RFC and the matching reference-implementation alignment. The RFC text + the impl alignment are the combined Phase 1 deliverable; this document captures decisions, scope, and open questions before drafting begins.

This is **revision 2**, rewritten after Codex's full-doc review surfaced contradictions in transcript semantics, scope misframing (Phase 1 was undercounting required impl work), and dishonest migration claims. Revision 1 lived in this same path on 2026-05-11; see git history.

---

## 1. Goal

Lock the contract that turns Noma from "a parseable format with shipped tooling" into "a format with a stable agent-editing protocol." v1.0 is the version downstream consumers (TS Agent SDK in Phase 3, third-party agents) can build against without expecting breaking changes.

What v1.0 stabilizes:
- the on-wire identity of a block
- the patch operation semantics
- the validation contract before and after each patch
- the transcript record shape
- the source-span guarantees the parser commits to

What v1.0 does **not** stabilize (provisional annexes):
- the capability descriptor schema (sidecar shape, default deny)
- the MCP-over-stdio binding (one binding among many future bindings)

The provisional split is deliberate. Codex's critique on the unified-RFC-vs-layered question was that capabilities and binding aren't pressure-tested enough to merit stability promises. Marking them provisional inside the unified doc keeps a single discoverable spec while signaling maturity honestly.

## 2. Non-goals

- A new patch operation (`move_block`, `add_comment`, `resolve_comment`) — deferred to v1.1. The five shipped ops are the v1.0 set.
- A new transport binding beyond MCP-stdio.
- Real enforcement code for capabilities. The annex defines the descriptor; no runtime checks against it until v1.1.
- **Book-mode multi-doc patches on the wire.** v1.0 patches address a single `.noma` source file. Book-mode scoping is a parsing concept (chapter-scoped IDs at parse time) — it does not extend to the patch wire. If you want to edit a chapter, point the patch at the chapter file directly. Multi-chapter patches deferred.
- Migrating existing Phase 0 transcript records into v1.0 shape. Phase 0 transcripts are legacy-only — see §3.5.
- A full markdown-to-noma converter, visual editor, collaborative editing, signature/PKI — all out of v1.0 scope per PLAN.md §17.

## 3. Locked decisions

Each decision below cites its source for traceability. Decisions added or revised after Codex's review of revision 1 are marked **[r2]**.

### 3.1 Single unified RFC with provisional annexes

One document: `docs/spec-agent-protocol-v1.noma`. Sections 1–6 = normative core. Annexes A (capability descriptor) and B (MCP-stdio binding) marked `status: provisional`, `version: 0.x`, no compatibility promise.

**Source:** user decision after Codex pushback on scope.

### 3.2 Block identity on the wire = canonical ID only

Patch operations address blocks by canonical `id` only. Aliases (frontmatter `aliases:`, filename slug, heading `{aliases="…"}`) are resolution aids for discovery, wikilinks, validator references, and UI lookups. Aliases are **not** patch identity.

If an agent starts from `[[risks]]`, it must resolve to canonical before emitting a patch.

**Source:** Codex consult #2.

### 3.3 `rename_id` contract — alias attribute vs reference retargeting [r2]

`rename_id(from, to)` does two things, no more:

1. **Changes the canonical `id`** of the target node to `to`.
2. **Retargets references**: every `for=<from>`, `parent=<from>`, `dataset=<from>`, and `[[from]]` wikilink in the document is rewritten to point at `to`. This is what makes rename atomic and is what Phase 0 already ships in `patch.ts`.

It does **not**:
- Touch the `aliases=…` attribute on the target node or any other node. The aliases attribute is human-curated metadata, not a reference graph. Renaming `claim-x` to `claim-y` does not make `claim-x` an alias of `claim-y` — if the caller wants that, they emit an explicit `update_attribute` adding `claim-x` to `claim-y`'s aliases.
- Move or rename child blocks.
- Modify content.

Codex's earlier "no alias magic" remark applied to the `aliases=` attribute. Reference retargeting is not alias magic — it's the op's whole point.

**Source:** Codex consult #2 (concept), Codex review pass (terminology fix).

### 3.4 Patch op set frozen at five

`replace_block`, `add_block`, `delete_block`, `update_attribute`, `rename_id`. No additions in v1.0.

Deferred: `move_block`, `add_comment`, `resolve_comment` → v1.1.

### 3.5 Transcript schema [r2]

One canonical schema. Required v1.0 fields:

```ts
{
  protocol_version: "1.0",
  tool_version: string,
  op_id: string,                // UUID v4
  ts: string,                   // ISO 8601 UTC
  actor: {
    kind: "human" | "agent" | "tool",
    name: string,
    model?: string,
    version?: string
  },
  doc_uri: string,
  pre_sha256: string,           // full hash, integrity-grade
  post_sha256: string,
  pre_sha: string,              // 8-char display, non-authoritative
  post_sha: string,
  op: PatchOp,
  patch_result: "applied" | "rejected" | "noop",
  pre_validation: "ok" | "warn" | "error",
  post_validation: "ok" | "warn" | "error"
}
```

Optional v1.0 fields:

```ts
{
  reason?: string,
  parent_op_id?: string,
  base_sha256?: string,         // actor's claim of edited state
  diagnostics?: Diagnostic[],
  elapsed_ms?: number,
  prev_entry_sha256?: string,
  signature?: null | Signature
}
```

The `Diagnostic` shape aligns with the existing AST `Diagnostic` type in `src/ast.ts` rather than introducing new field names:

```ts
Diagnostic = {
  phase: "pre" | "post",
  severity: "info" | "warning" | "error",
  code: string,                 // matches src/ast.ts
  message: string,
  nodeId?: string,              // matches src/ast.ts
  pos?: { startLine: number, endLine?: number }
}
```

**`partial` is not a `patch_result` value.** v1.0 patches are atomic per op-list (see §3.14): either every op in the list applies or the writer never sees the new bytes. A patch list that fails mid-way produces a single `rejected` record explaining which op failed; previously-applied-in-memory ops are discarded.

**Compatibility rules:**
- Implementations MUST emit all required fields.
- Implementations MAY emit any optional field.
- Implementations MUST ignore unknown fields (extension model).
- `pre_sha` / `post_sha` are display only; integrity comparisons MUST use the `_sha256` fields.
- `protocol_version` is the **only** transcript version field. Phase 0's `v:1` is dropped.

**Phase 0 migration:** Phase 0 transcripts are legacy-only and are NOT re-emittable as v1.0. They lack `op_id`, full hashes, `doc_uri`, structured actor, and `tool_version`; reconstructing those fields would require fabrication. A converter MAY wrap Phase 0 lines in a separate `legacy_phase0` import format with a clear non-v1.0 marker; it MUST NOT claim v1.0 transcript compatibility. Tooling that wants v1.0 records starts emitting them fresh.

**Source:** Codex consult #3 (initial shape), Codex review pass (drop `partial`, align Diagnostic with AST, fix migration story).

### 3.6 `base_sha256` ships as optional in v1.0

`base_sha256` = actor's claim "I prepared this patch against doc X."
`pre_sha256` = engine's observation "doc was actually Y when applied."

Divergence is a concurrency signal block IDs alone don't catch. Optional so single-writer callers aren't forced to compute it; collaborative workflows can adopt it without a protocol bump.

Validators MAY warn on divergence; MUST NOT reject by default.

**Source:** Codex consult #3.

### 3.7 Diagnostics are dual: summary + structured

Both:
- `pre_validation` / `post_validation`: summary string ("ok" | "warn" | "error") — derived
- `diagnostics`: structured array — canonical, machine-consumable

If the structured form is present, it's the source of truth.

**Source:** Codex consult #3.

### 3.8 Capabilities live in a sidecar, not frontmatter

`document.noma.capabilities.yml` next to the document. Frontmatter may carry one pointer:

```yaml
agent_capabilities: ./document.noma.capabilities.yml
```

Sidecar shape (provisional):

```yaml
nomaAgent:
  version: 1
  profile: default
  blocks:
    claim:
      ops: [replace_block, update_attribute]
      attrs:
        confidence: { type: number, min: 0, max: 1 }
  ids:
    rename: false
  validation:
    required: true
```

**Default = read-only / unspecified, not "all."** Allowlist semantics, not denylist.

Rationale: frontmatter is content. Agents patch content. A capability declaration inside content is a self-modifying authority surface, not a permission system. Sidecar is the wall.

Marked **provisional** in v1.0: shape may change before enforcement code lands in v1.1.

**Source:** Codex consult #1 (strongest finding of the consult).

### 3.9 Source spans are two-tier and require AST work [r2]

The parser currently tracks `pos: { startLine, endLine? }` on most nodes but the `DocumentNode` has no `pos` or frontmatter sub-node (`src/ast.ts`, `src/parser.ts`). v1.0 promotes spans to normative under a two-tier rule, and this requires production-code work in Phase 1B.

**Tier 1 — valid documents:** spans are exact. 1-based inclusive `[startLine, endLine]`. Per-node-type guarantees:

- `document` node: spans the entire source, line 1 through last physical line (inclusive). **New AST work in Phase 1B.**
- `frontmatter` sub-node: present when frontmatter exists; spans the `---` lines inclusive. **New AST work in Phase 1B.**
- `section` (implicit, from heading): starts at the heading line; ends at the line before the next heading at the same or shallower level, or the last line of the document. Section `id` = slugified heading text; if two headings slugify to the same id, the validator emits `duplicate-id` (`error` severity) and the second occurrence is suffixed `-2`, `-3`, ….
- `section` (explicit, `::section{...}`): standard directive spans (opening fence line through closing fence line inclusive).
- `directive`, `code`, `paragraph`, `list`, `quote`, `thematic_break`, `table`: standard directive/block spans, opening through closing fence inclusive. Inline content does not get sub-spans in v1.0.

**Tier 2 — invalid or parser-recovered documents:** spans are diagnostic hints, not normative. Tooling may use them for error messages but cannot rely on them for replay or patch addressing.

Hard cases the spec addresses explicitly:
- **Implicit sections from headings**: no closing fence — endLine depends on the next heading or EOF. Semantic, not syntactic.
- **Fenced code containing `::` lines**: code fences MUST suppress directive recognition until the fence closes. **Fixes the PLAN.md §24.9 parser bug as part of Phase 1B.**
- **Frontmatter**: line counting starts at 1 including frontmatter; the document node spans the whole file.
- **Nested directives at the same colon depth**: each top-level directive at depth N closes at its own `::` of depth N.

Terminology note: what we have is **AST source spans**, not a CST. The spec will not use "CST" — concrete tokens are not exposed.

**Source:** Codex consult #1 (terminology + tier model), Codex review pass (acknowledged this is real AST work, not a bugfix).

### 3.10 Conformance suite has two fixture tracks plus a minimum corpus [r2]

- **Normative fixtures** (the public conformance bar): `.noma` input + expected **observable** outputs per fixture: `expected.ids.json` (canonical IDs and aliases), `expected.diagnostics.json` (validator output, conforming to §3.5 Diagnostic shape), `expected.roundtrip.noma` (parse → render-noma output), and optionally `expected.html.fragment.html` for required semantic markers.
- **Implementation fixtures** (private to the reference impl): full AST JSON snapshots for regression testing.

Property-style assertions baked in:
- `parse(render-noma(parse(x))) ≡ parse(x)` for all valid fixtures
- IDs stable across parser runs
- spans match documented line ranges for Tier-1 fixtures
- transcript **shape** is conformant; transcript **content** is not bit-exact (UUIDs, timestamps, elapsed_ms are non-deterministic by design)
- transcript replay determinism: applying the op list against `pre_sha256`-state produces `post_sha256`-state byte-exactly

**Minimum conformance corpus** ships with v1.0. See §3.17 for the list.

The harness is a CLI: `noma verify <fixture-dir>`. It MUST exit non-zero if any fixture fails.

**Source:** Codex consult #1 (dual-track model), Codex review pass (fix non-deterministic bit-exact claim, ship minimum corpus).

### 3.11 `patch_result` emission rules [r2]

One transcript record per **attempted** op (not per applied op). The `patch_result` value is set by the writer:

- `applied` — op resolved its target, validation policy (§3.14) didn't block, and the new bytes were written. `post_sha256` reflects post-state.
- `rejected` — op did not produce written bytes. Sub-cause is in `diagnostics` and may be a `PatchError` category (§3.15). `post_sha256` equals `pre_sha256` (no change).
- `noop` — op resolved cleanly but produced byte-identical output (`pre_sha256 == post_sha256`). E.g., `update_attribute` setting a key to its current value. Surfaced so reviewers see the agent acted but didn't change anything.

For a multi-op patch list, atomicity (§3.14) means a list rejection produces **one** transcript record per op-attempted-up-to-failure: previously-virtually-applied ops are recorded as `rejected` with `code: "op_list_aborted"` (in `diagnostics`), and the failing op records its own failure. No `partial`.

**Source:** Codex review pass.

### 3.12 Transcript purpose: replay + audit [r2]

Transcripts serve two purposes:

1. **Audit** — who did what, when, against which document state. Provenance for human reviewers.
2. **Replay** — given a base `.noma` source matching `pre_sha256` and a transcript list, applying each `applied` record's `op` in order MUST produce a result whose `sha256` equals the final `post_sha256`.

Replay determinism is enforced by the conformance suite (§3.10).

`rejected` and `noop` records are audit-only; replay skips them.

**Source:** Codex review pass (locking the replay claim explicitly).

### 3.13 Hash semantics [r2]

`pre_sha256` and `post_sha256` are sha256 over the file's **UTF-8 byte sequence as read/written by the patch engine**, no normalization:

- Line endings preserved as in the source (LF assumed; CRLF preserved if present, but the spec does not promise normalization).
- BOM preserved if present.
- Trailing newlines preserved as in source.

Timing:
- `pre_sha256` computed immediately before applying the op-list (or first op).
- `post_sha256` computed immediately after writing the new bytes.

`pre_sha` and `post_sha` = first 8 lowercase hex chars of the corresponding sha256. Display only.

`base_sha256` (optional) is computed by the agent the same way over the bytes it read.

**Source:** Codex review pass.

### 3.14 Validation failure policy [r2]

- **Pre-validation runs before apply.** If `pre_validation = "error"`, the patch still applies by default — the validator surfaces pre-existing errors in the source; refusing to patch on pre-existing red would block agents trying to fix that exact red. Implementations MAY offer a strict mode that rejects on `pre_validation = "error"`; transcript records `rejected` with `code: "pre_validation_blocked"`.
- **Post-validation runs after apply.** Result is informational: the patch IS written. Caller decides whether to act on `post_validation = "error"` (e.g., revert via a follow-up patch).
- **`expected_sha` (Phase 0) / `base_sha256` mismatch:**
  - `expected_sha` (8-char) mismatch → `rejected`, `code: "sha_mismatch"`. Pre-existing Phase 0 behavior; retained.
  - `base_sha256` mismatch with `pre_sha256` → `applied` (op runs) but diagnostics carry a `warning` severity entry with `code: "base_sha_drift"`. Concurrency signal, not a block.

**Source:** Codex review pass.

### 3.15 Error taxonomy (`PatchError` categories) [r2]

Locked at v1.0. Implementations expose these as machine-readable `code` values in transcript `diagnostics`:

| Code | Meaning |
|------|---------|
| `target_missing` | Op references an `id` (or `from`) that does not exist in the document |
| `parent_missing` | `add_block.parent` references an `id` that does not exist |
| `id_conflict` | `rename_id.to` already exists, or `add_block` content declares an id that's taken |
| `invalid_content` | `replace_block.content` / `add_block.content` is not a single parseable top-level block |
| `id_attribute_protected` | `update_attribute` targeting `id` — must use `rename_id` |
| `sha_mismatch` | `expected_sha` (Phase 0) or strict-mode `base_sha256` did not match |
| `pre_validation_blocked` | Strict-mode rejected on pre-existing validator errors |
| `op_list_aborted` | This op was virtually applied before a later op in the same list failed; rolled back |
| `unsupported_op` | Op name not in the §3.4 set |

New codes may be added in a minor version; removal requires a major.

**Source:** Codex review pass.

### 3.16 Book-mode patches are out of v1.0 wire scope [r2]

The `patch_block` MCP tool rejects book manifests today (`packages/mcp-server/src/tools/patch-block.ts:27`). v1.0 codifies that: **patches operate on a single `.noma` source file.** Book-mode scoped IDs (e.g., `chapter-2/risks`) are a *parsing concept* — when `noma render` operates on a book manifest, chapter IDs get prefixed. Patches do not address blocks through a manifest. To edit a chapter, point the patch at `chapter-2.noma` directly, using that file's unscoped canonical IDs.

Multi-chapter patches and book-scoped wire identity deferred to v1.1+.

**Source:** Codex review pass.

### 3.17 Minimum conformance fixture corpus [r2]

v1.0 ships a corpus large enough to exercise every locked decision. Minimum set:

| Fixture | Exercises |
|---------|-----------|
| `valid/basic-section` | implicit section IDs, paragraph spans |
| `valid/explicit-section` | `::section{}` spans |
| `valid/aliases` | alias resolution in `expected.ids.json` |
| `valid/inline-table` | pipe-table parsing + alignment |
| `valid/code-fence-with-colons` | §3.9 fenced-code-suppresses-`::` rule |
| `valid/frontmatter-only` | frontmatter sub-node + document span |
| `patch/replace_block` | replace_block op + transcript shape |
| `patch/add_block` | add_block op + transcript shape |
| `patch/delete_block` | delete_block op + transcript shape |
| `patch/update_attribute` | update_attribute op + transcript shape |
| `patch/rename_id` | rename_id retargets refs and wikilinks; does NOT touch aliases |
| `patch/replay-chain` | three-op list, transcript-replay equivalence |
| `invalid/duplicate-id` | validator emits `duplicate-id` diagnostic |
| `invalid/missing-evidence-target` | validator broken-reference diagnostic |

14 fixtures. Future versions may add more without breaking conformance; removing fixtures requires a major.

**Source:** Codex review pass (zero-fixture rejection).

### 3.18 RFC file format

The RFC source lives in `docs/spec-agent-protocol-v1.noma`. Dogfooding Noma is the right move; the format must be able to spec itself. A markdown rendering (for GitHub/IETF tooling parity) is generated, not authored — needs a `--to md` renderer, which is its own small task in Phase 1B if it doesn't yet exist; otherwise the published RFC ships as HTML alongside the .noma source.

---

## 4. Outline of the RFC document

```
1. Conformance & versioning
   1.1 What v1.0 stabilizes
   1.2 Compatibility promises (semver discipline)
   1.3 Extension model — unknown fields ignored

2. Document model (normative)
   2.1 Addressable blocks — canonical IDs only on wire
   2.2 Aliases as resolution aids (non-normative for patches)
   2.3 Book-mode scoping is a parser concept, not a wire concept

3. Patch operation semantics (normative)
   3.1 The five operations — full per-op semantics
   3.2 Atomicity per op-list
   3.3 rename_id — retargets refs and wikilinks; never touches aliases attribute
   3.4 Validation failure policy
   3.5 Error taxonomy

4. Validation contract (normative)
   4.1 pre/post validation MUST run
   4.2 ValidationSummary derived; Diagnostic[] canonical
   4.3 The Diagnostic shape

5. Transcript record (normative)
   5.1 JSONL append-only, one record per attempted op
   5.2 Required and optional field schema
   5.3 Ledger fields (base_sha256, prev_entry_sha256, signature)
   5.4 Hash semantics (encoding, normalization, timing)
   5.5 Replay determinism
   5.6 Compatibility rules

6. Source span guarantees (normative)
   6.1 Tier 1 — valid documents
   6.2 Tier 2 — recovered or invalid documents
   6.3 Per-node-type span specification (full table)
   6.4 Code fence directive suppression rule

Annex A (provisional) — Capability descriptor (sidecar)
Annex B (provisional) — MCP-over-stdio binding (folds in current docs/agent-protocol.noma)
Annex C — Conformance suite + fixture corpus + `noma verify` CLI
```

## 5. Success criteria [r2]

The combined v0.6.0 release (RFC + impl alignment) is done when:

1. A new TS implementer (Phase 3 Agent SDK) can read the RFC top-down and emit valid patches + transcript entries without referring to source code.
2. `noma verify examples/conformance/` runs and passes against the **14-fixture minimum corpus** (§3.17). Zero-fixture conformance is not a thing.
3. Every locked decision in §3 of this design doc maps to a numbered section in the RFC.
4. The provisional annexes carry a visible `status: provisional` banner.
5. The reference impl matches the normative claims:
   - Transcript writer emits the §3.5 v1.0 schema (Phase 0 writer rewritten).
   - `DocumentNode` has a `pos` and a `frontmatter` sub-node (§3.9 Phase 1B work).
   - Parser fenced-code-suppresses-`::` bug fixed.
   - Diagnostic field names match between AST and transcript without a translation layer.
6. `docs/agent-protocol.noma` either folds into the RFC as Annex B or carries a `superseded-by:` pointer.
7. `package.json`, `docs/spec.noma`, `docs/agent-protocol.noma`, `CHANGELOG.md`, `PLAN.md §24.N`, `README.md` all carry matching v0.6.0.

## 6. Open questions (to resolve during drafting) [r2]

The revision-1 question list shrank as Codex's review forced more decisions in. Remaining genuine punts:

### Q1. Per-node span specification — exhaustive list

§6.3 of the RFC requires per-node-type span semantics for every variant in `Node`. The §3.9 list above covers the macro cases; drafting will surface edge cases (e.g., what exactly is the span of an empty `::block::` with no body line — opening line only?).

### Q2. RFC markdown rendering path

§3.18 says HTML can ship alongside .noma. A `--to md` renderer would let the published RFC live on a markdown-rendering surface (GitHub). Build it now, or punt to v1.1? Drafting will decide based on whether the .noma → HTML output reads cleanly for the spec voice.

### Q3. Signature slot details

`signature?: null | Signature` is reserved. v1.0 ships `signature: null`. The `Signature` shape (algorithm, key id, encoded value) is undefined. Defer to v1.1 when a real consumer wants tamper-evident transcripts.

---

## 7. Phased implementation plan [r2]

Phase 1 splits into two coupled sub-phases. Both ship in v0.6.0; the RFC's claims must be backed by the reference impl.

### Phase 1A — RFC + docs

1. Draft RFC sections 1–6 (normative core).
2. Draft Annex A (capability descriptor, provisional banner).
3. Draft Annex B (MCP-stdio binding, provisional banner; folds in `docs/agent-protocol.noma` content).
4. Migrate `docs/agent-protocol.noma` — either content moves into Annex B, or the file carries a `superseded-by:` frontmatter and a redirect note.
5. Update `docs/spec.noma` cross-references to point at the new RFC.

### Phase 1B — reference-impl alignment

6. **Transcript writer rewrite** — `packages/mcp-server/src/transcript.ts` and the `patch_block` tool emit the §3.5 v1.0 schema. Drop the `v:1` literal, add `protocol_version`, structured actor, full sha256, etc. Update existing test suite + add new ones for new fields. **No automatic migration of Phase 0 logs.**
7. **AST + parser work for spans** — `DocumentNode` gains `pos` and an optional `frontmatter` sub-node. `parse()` fills both. Section-id collision suffixing (`-2`, `-3`) implemented. New tests for span fidelity.
8. **Parser fence bug** — `::` inside fenced code blocks no longer triggers directive recognition. PLAN.md §24.9.
9. **Diagnostic field alignment** — confirm `src/ast.ts` `Diagnostic` matches the §3.5 transcript Diagnostic shape exactly. Add the `info` severity to transcript spec (already in AST) — already done in §3.5.
10. **`noma verify` CLI** — new CLI subcommand. Loads fixture directories, runs ID checks, diagnostic checks, roundtrip property, span checks, transcript-shape + replay checks. Exits non-zero on any failure. Wire into CI.
11. **Ship minimum conformance corpus** — 14 fixtures under `examples/conformance/`. Each has `input.noma` + expected outputs.
12. **Version bump v0.6.0** — package.json, docs/spec.noma frontmatter, docs/agent-protocol.noma redirect (or annex), CHANGELOG, README status paragraph, PLAN.md §24.

### Sequencing within Phase 1

- 6 (transcript) can land independently — bumps Phase 0 writer to v1.0 format.
- 7, 8 (AST + parser) are coupled — land together.
- 9 is verification-only; lands once 6 is in.
- 10 (verify CLI) and 11 (corpus) land last, after 6–8 land — corpus exercises them.
- 1–5 (RFC text) can be drafted in parallel with 6–8 but should not merge to main before the impl matches (otherwise the spec promises behaviour the code doesn't deliver).

`writing-plans` will expand each into the standard plan format (deps, files touched, verification gates).

---

## 8. Glossary

- **Canonical ID** — the value of `id=` on a directive, or the slugified heading text for sections. The on-wire identifier used by all patch ops.
- **Alias** — an alternative ID resolving to the same node, sourced from `aliases=…`, frontmatter `aliases:`, filename slug, or book-mode legacy retention. Resolution-only.
- **Scoped ID** — in book mode, the canonical ID at parse time becomes `<chapter-slug>/<original-id>` for level-≥2 sections. Not a wire-level concept; patches address the unscoped form against the chapter file.
- **Provisional annex** — a labeled section inside the v1.0 RFC carrying `status: provisional` and no compatibility promise. Annex A (capabilities) and Annex B (MCP-stdio binding).
- **Transcript record** — one JSONL line representing one attempted patch op.
- **Replay** — given a base source matching `pre_sha256` and a transcript, applying every `applied` record's op in order produces a result matching the final `post_sha256`.
- **`base_sha256` drift** — `base_sha256 ≠ pre_sha256`. Signals the agent prepared the patch against a stale view of the document. `warning` severity; does not block.
- **Conformance fixture** — a directory under `examples/conformance/` containing `input.noma` plus expected outputs.
