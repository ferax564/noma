# Noma

> **Readable source for beautiful agent artifacts.**

Noma is a plain-text format for books, docs, research, dashboards, and webpages. It is:

- readable like Markdown
- structured like data
- renderable like HTML
- printable like PDF
- editable by AI agents at the **block level** — not via full-file rewrites

```
.noma source  ->  typed AST  ->  HTML / PDF / DOCX / JSON / LLM context
```

**Live site:** <https://ferax564.github.io/noma/> — landing page, demo gallery, rendered HTML/PDF/LLM/JSON for every example, full docs.

## Why

Markdown is excellent for prose and durable notes. HTML is excellent for browser artifacts. The painful gap is everything in between: research memos, PR reviews, decision records, technical docs, dashboards, and agent outputs that need tables, layout, validation, citations, and safe follow-up edits.

Noma is that middle layer. Keep the source small and reviewable like Markdown; render the artifact as rich HTML/PDF; give agents typed blocks and stable IDs so they can patch the exact claim, table, risk, or citation that changed.

See [`docs/direction.noma`](docs/direction.noma) for the full positioning and [PLAN.md §23](PLAN.md) for the three-layer model and the central design test every feature must pass.

## The wedge

Use Noma when a document needs all three surfaces at once:

| Surface | What Noma keeps stable | Why Markdown or raw HTML alone gets awkward |
| ------- | ---------------------- | ------------------------------------------- |
| Source | readable `.noma` text with directive blocks | Markdown gets flat; HTML gets noisy to co-author and diff |
| Artifact | standalone HTML, PDF, DOCX, docs site, JSON | Markdown needs extra tooling for polished rich output |
| Agent | IDs, validation, scoped LLM export, patch ops | Agents need structure instead of whole-file rewrites |

The first sharp use cases are table-heavy research, PR/architecture review artifacts, decision records, stale-source refreshes, and agent memory files.

## Hello, Noma

```noma
---
title: ASML Investment Thesis
---

# ASML Investment Thesis

::claim{id="asml-euv-moat" confidence=0.82}
ASML has a durable moat because it is the only supplier of EUV lithography systems at scale.
::

::evidence{for="asml-euv-moat" source="annual-report-2025"}
ASML continues to report strong demand for EUV systems from leading-edge customers.
::

::grid{columns=2}
:::card{title="Bull Case"}
EUV demand stays structurally high.
:::

:::card{title="Bear Case"}
Export restrictions and cyclicality.
:::
::
```

That's the whole language — directive blocks (`::name{attrs} ... ::`), Markdown-ish inline text, YAML frontmatter, and stable block IDs.

## Quick start

Install the public CLI:

```bash
npm install -g @ferax564/noma-cli
noma --version
noma init my-spec
noma render my-spec/demo.noma --to html --out my-spec/demo.html
```

Install editor support:

```text
ext install ferax564.noma-language
```

Install the agent integration packages when you want MCP or a TypeScript
workflow wrapper:

```bash
npm install @ferax564/noma-mcp-server
npm install @ferax564/noma-agent-sdk
```

From a checkout:

```bash
git clone https://github.com/ferax564/noma.git
cd noma
npm install

# render one demo to HTML / LLM / JSON / .noma source
npm run noma -- render examples/agent-plan.noma --to html --out dist/agent-plan.html
npm run noma -- render examples/agent-plan.noma --to llm
npm run noma -- render examples/agent-plan.noma --to llm --select claim,evidence,risk --exclude dataset --budget 12000
npm run noma -- render examples/agent-plan.noma --to json
npm run noma -- render examples/agent-plan.noma --to noma     # AST → .noma roundtrip
npm run noma -- ids examples/book/book.noma.yml               # global ID + alias map for agents
npm run noma -- render examples/agent-plan.noma --to pdf --out dist/agent-plan.pdf
npm run noma -- render examples/agent-plan.noma --to docx --out dist/agent-plan.docx
npm run noma -- docx-data dist/agent-plan.docx                # extract Word control values and task state
npm run noma -- docx-sync examples/agent-plan.noma dist/agent-plan.docx --out synced.noma --report synced.report.json
npm run noma -- docx-review-data dist/agent-plan.docx         # extract review comments, headings, and tables
npm run noma -- docx-review-sync examples/agent-plan.noma dist/agent-plan.docx --out reviewed.noma --report reviewed.report.json

# pick a theme
npm run noma -- render examples/research-thesis.noma --to html --theme dark

# render a multi-file book (chapters resolved relative to the manifest)
npm run noma -- render examples/book/book.noma.yml --to html --out dist/book.html

# block-level patch — agent-safe edits, no full-file rewrite
npm run noma -- patch examples/thesis.noma \
  --op '{"op":"update_attribute","id":"asml-euv-moat","key":"confidence","value":0.95}' \
  --inplace

# validate a document
npm run noma -- check examples/research-thesis.noma

# render in GitHub Actions
# - uses: ferax564/noma@v0.11.1
#   with:
#     input: docs/spec.noma
#     output: dist/spec.html

# build the full site (examples + docs + book + dark-theme demo + landing + PDFs)
npm run build:site
open dist/index.html
open dist/workbench.html

# re-align pipe tables in source (idempotent; skips fenced code blocks)
npm run noma -- fmt examples/research-thesis.noma --inplace
```

## Block-level edits

Agents and CI pipelines patch single blocks instead of rewriting whole files. Twenty-three operations cover the editing flows that matter:

```bash
noma patch thesis.noma --op '{"op":"replace_block","id":"claim-x","content":"::claim{id=\"claim-x\" confidence=0.9}\nNew body.\n::"}'
noma patch thesis.noma --op '{"op":"replace_body","id":"claim-x","content":"Sharper body text."}'
noma patch thesis.noma --op '{"op":"update_heading","id":"risk-section","title":"Known Risks"}'
noma patch thesis.noma --op '{"op":"add_comment","id":"comment-claim-x","target":"claim-x","content":"Verify this before the Word handoff.","author":"Research"}'
noma patch thesis.noma --op '{"op":"resolve_comment","id":"comment-claim-x","resolved_by":"Andrea","resolved_at":"2026-05-24T10:00:00Z"}'
noma patch thesis.noma --op '{"op":"add_change_request","id":"cr-claim-x","target":"claim-x","action":"replace","from":"old wording","to":"new wording","content":"Track this edit for Word review.","author":"Research"}'
noma patch thesis.noma --op '{"op":"update_table_cell","id":"scenario-table","row":0,"column":"Upside","value":"12%"}'
noma patch thesis.noma --op '{"op":"insert_table_row","id":"scenario-table","row":1,"cells":["Base","8%","watch"]}'
noma patch thesis.noma --op '{"op":"delete_table_row","id":"scenario-table","row":0}'
noma patch thesis.noma --op '{"op":"insert_table_column","id":"scenario-table","column":2,"header":"Owner","cells":["Finance","Research"]}'
noma patch thesis.noma --op '{"op":"delete_table_column","id":"scenario-table","column":"Owner"}'
noma patch thesis.noma --op '{"op":"update_dataset_cell","id":"model-inputs","row":0,"column":"value","value":"42"}'
noma patch thesis.noma --op '{"op":"insert_dataset_row","id":"model-inputs","row":1,"cells":["growth","0.12"]}'
noma patch thesis.noma --op '{"op":"delete_dataset_row","id":"model-inputs","row":0}'
noma patch thesis.noma --op '{"op":"insert_dataset_column","id":"model-inputs","column":2,"header":"source","cells":["10-K","model"]}'
noma patch thesis.noma --op '{"op":"delete_dataset_column","id":"model-inputs","column":"source"}'
noma patch thesis.noma --op '{"op":"move_block","id":"risk-1","parent":"archived-risks","position":0}'
noma patch thesis.noma --op '{"op":"add_block","parent":"risks","content":"::risk{id=\"r1\" severity=\"high\" owner=\"me\"}\nNew risk.\n::"}'
noma patch thesis.noma --op '{"op":"delete_block","id":"deprecated"}'
noma patch thesis.noma --op '{"op":"update_attribute","id":"claim-x","key":"confidence","value":0.85}'
noma patch thesis.noma --op '{"op":"rename_id","from":"claim-x","to":"claim-renamed"}'
noma patch thesis.noma --ops patch-transaction.json --inplace
```

`rename_id` retargets reference attributes such as `for=`, `parent=`, `dataset=`, `block=`, and `ref=`, plus `[[wikilink]]` references across the document. Table patch ops escape literal separator pipes in edited cells while preserving pipes inside inline code spans. The source-preserving patch path rewrites only the addressed line range or inserted block, so unrelated bytes stay byte-identical. See [`docs/agent-protocol.noma`](docs/agent-protocol.noma) and [`docs/compatibility.noma`](docs/compatibility.noma).

## GitHub Action

Render and upload a Noma artifact from any repository:

```yaml
name: Render docs

on: [push, pull_request]

jobs:
  noma:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: ferax564/noma@v0.11.1
        with:
          input: docs/spec.noma
          output: dist/spec.html
          to: html
          strict: true
          artifact-name: spec-preview
```

The action installs the CLI from the checked-out action ref by default, runs `noma check`, renders the requested target, and uploads the result with `actions/upload-artifact`. Use `to: site` when `input` is a book manifest and `output` is a directory. For explicit dependency control, set `cli-package` to any npm package spec or `cli-version` to an `@ferax564/noma-cli` npm version range.

## Demos

Three artifacts that exercise the full block surface end-to-end. Each renders to HTML, PDF, LLM context, and JSON AST from a single `.noma` source. For the workflow narrative behind them, see the [case studies](docs/case-studies.noma).

| Demo | What it shows | Live |
| ---- | ------------- | ---- |
| **Agent planning artifact** ([source](examples/agent-plan.noma)) | Q3 roadmap decision — options, decision matrix, claims/evidence/risks, agent tasks, copy-as-prompt buttons | [HTML](https://ferax564.github.io/noma/examples/agent-plan.html) · [PDF](https://ferax564.github.io/noma/examples/agent-plan.pdf) · [LLM](https://ferax564.github.io/noma/examples/agent-plan.llm.txt) · [JSON](https://ferax564.github.io/noma/examples/agent-plan.json) |
| **Technical documentation** ([source](examples/tech-doc.noma)) | CLI reference page — tabs, callouts, code blocks, architecture diagram, cross-links | [HTML](https://ferax564.github.io/noma/examples/tech-doc.html) · [PDF](https://ferax564.github.io/noma/examples/tech-doc.pdf) · [LLM](https://ferax564.github.io/noma/examples/tech-doc.llm.txt) · [JSON](https://ferax564.github.io/noma/examples/tech-doc.json) |
| **Investment thesis** ([source](examples/research-thesis.noma)) | Vertical-AI thesis — claims with confidence scores, counterevidence, risks, datasets, plots, quarterly review tasks | [HTML](https://ferax564.github.io/noma/examples/research-thesis.html) · [PDF](https://ferax564.github.io/noma/examples/research-thesis.pdf) · [LLM](https://ferax564.github.io/noma/examples/research-thesis.llm.txt) · [JSON](https://ferax564.github.io/noma/examples/research-thesis.json) |

## Guides for adoption

- [Case studies](docs/case-studies.noma) — agent-refreshable research memo, decision artifact, technical-doc publishing, and memory workflow.
- [Comparison guide](docs/comparison.noma) — when to choose Noma vs Markdown, MDX, raw HTML, or collaborative docs.
- [Markdown/HTML pain research](docs/research-markdown-html-pains.noma) — external evidence from X, Reddit, HN, specs, GitHub, and Stack Overflow behind the source/artifact/agent wedge.
- [Agent editing guide](docs/agent-guide.noma) — the safe loop for ID discovery, patch transactions, validation, and strict rendering.
- [Starter templates](docs/templates.noma) — copyable research memo, decision record, technical spec, and agent refresh templates under `examples/templates/`.

## What ships today

- `@ferax564/noma-cli` (this package) — hand-written parser with no parser-combinator dependency. Supports directive blocks, frontmatter, headings, lists, code, quotes, GitHub-style tables, and inline markdown. The parser and DOCX return-path helpers are exported alongside the CLI; `import { parse, extractDocxControlData, syncControlDefaultsFromDocx, extractDocxReviewData, syncReviewCommentsFromDocx } from "@ferax564/noma-cli"` works in any Node 20+ project.
- Typed AST in `src/ast.ts` — discriminated union, exhaustively switched everywhere.
- HTML renderer with a default CSS theme + a `dark` alternate (`--theme dark`), a print stylesheet, and per-block `{variant="..."}` styling. Native rendering for grids, cards, tabs, callouts, claims/evidence/risks, decisions, open questions, semantic research metadata, technical API/reference panels, metric KPI blocks, addressable code snippets, code-cell/output computation panels, memory profile panels, review comments/collaboration metadata, readable custom directive fallbacks, datasets, real inline-data plots (line + bar SVG, no JS) with x-axis label controls, agent tasks, change-request deltas, export buttons, controls, interactive computed metrics/plots, tables, the new `::table` directive, and `::state_change` deltas. `::html` / `::svg` / `::script` escape hatches can be blocked with `--no-unsafe`; `--strict` also omits external CDN runtimes for math, diagrams, and Plotly, and freezes computed controls as disabled static defaults with no inline runtime. Book manifests with `trusted_publishing: true` apply that strict static posture to manifest-driven HTML/site/PDF renders.
- Web workbench (`site/workbench.html`, published as `dist/workbench.html`) — browser-based editing surface for `.noma` source with Word-style file, formatting, paragraph, insert, layout, review, find, print, and export controls. It includes live safe HTML preview, diagnostics, outline navigation, AST/LLM output tabs, example loading, local file opening, selection-aware Markdown formatting, Noma block insertion templates, and HTML/JSON/Noma/LLM export actions. The client bundle reuses the core parser, validator, HTML renderer, JSON renderer, and LLM renderer.
- LLM renderer — deterministic plain-text output for context windows; escape-hatch bodies always stripped. Supports `--select`, `--exclude`, and `--budget` for scoped agent context, and emits computed formulas with default scalar/series results from control defaults.
- DOCX renderer — dependency-free WordprocessingML export for handoff to Word or Google Docs import paths. It preserves frontmatter as Word package metadata, headings, prose, lists, page-aware tables, field-numbered table captions, dataset tables, metric KPI blocks, static computed metric/plot handoffs, technical API/reference blocks, addressable code snippets, code-cell/output computation blocks, page-aware grid/columns layouts, framed card panels, memory profile panels, flattened hero/tabs/accordion sections, titled tab panels, framed sidebars, code blocks, abstract/callout/note/warning/tip blocks, Office Math blocks and inline equations, native checkbox action items, native text/dropdown/date/checkbox control fields with optional lock metadata and custom XML data bindings, action blocks, section-level page setup, form document-protection settings, rich native headers/footers with page numbers and part-local hyperlinks, linked tables of contents and caption lists with Word page-reference fields, caption cross-reference fields for figure/table/plot wikilinks, page breaks, targeted/threaded native comments with rich inline body content and resolved-state metadata, review-view settings for comments and revisions, target-anchored rich tracked review revisions, state-change deltas, target-anchored rich native footnotes/endnotes, generated bibliographies, styled semantic review blocks and metadata, review/provenance/confidence metadata blocks, embedded PNG/JPEG/GIF/SVG figures, field-numbered figure/plot captions, static SVG plots for resolvable data, diagram/Plotly source fallbacks, clickable citations, block-ID bookmarks, internal wikilinks, external hyperlinks with rich Markdown labels including combined bold+italic spans, visible escaped table pipes outside code spans, and readable fallback labels for custom directives; unresolved web-only blocks degrade to labeled placeholders.
- JSON renderer — full AST export.
- `.noma` source printer — AST → `.noma` (roundtrip-safe). Backs `noma render --to noma`; source-preserving `noma patch` rewrites addressed spans directly.
- `noma fmt` — re-aligns GitHub-style pipe tables in source; respects pipes inside `` `code spans` `` and `\|` escapes, which render as literal pipes outside code spans; leaves everything else byte-identical.
- Validator — wikilink references resolve across paragraphs, quotes, list items, headings, table cells, and book chapters. Default rules: duplicate IDs, broken references (incl. wikilinks), plot/figure issues, plot/dataset linkage (`plot-unknown-dataset`, `plot-unknown-column`), `plot-mixed-delimiters`, claim-without-evidence, `claim-invalid-confidence`, risk-without-owner, decision-without-status, agent-task-without-scope, stale-citation, `citation-missing-source`, escape-hatch-untrusted, evidence-missing-for, computed formula/control checks, state_change and change_request shape rules, and `out-of-profile-directive` when a `profile` is declared. Per-block opt-out with the `noverify` flag.
- Profiles — declare `profile: research | technical | minimal` in frontmatter as a contract about which directives the document uses; the `technical` profile includes API/reference blocks such as `api`, `endpoint`, `parameter`, `example`, `query`, `instruction`, and `changelog` so downstream tools can narrow safely.
- Plot/dataset linkage — `::plot{dataset="<id>" column="<name>" xcolumn="<name>"}` resolves against sibling `::dataset` blocks at render time.
- Citation staleness — global default 365 days, override via frontmatter `stale_citation_days`, per-citation `stale_after_days=N`, or CLI `--stale-days <n>`.
- CLI — `noma --version`, `noma init`, `noma parse | render | ids | schema | check | export | patch | fmt | docx-data | docx-sync | docx-review-data | docx-review-sync | diff`. `noma render --to pdf --out report.pdf` prints through Chromium via Puppeteer and accepts `--page-size`, margin flags, `--no-print-background`, and `--css`; `noma render --to docx --out report.docx` writes a Word-compatible package; `noma docx-data report.docx --out controls.json` extracts bound `::control` values from the DOCX custom XML part or visible `noma-control:<id>` content controls in the document body, headers, or footers plus native `::agent_task` / `::todo` checkbox state from those Word content controls; `noma docx-sync report.noma report.docx --out synced.noma --report sync.json` source-preservingly updates matching `::control default=` attributes and task done/status attributes from those values and can write a JSON change/unmatched report; `noma docx-review-data report.docx` extracts native Word comment/note bodies, authors, resolved state, reply links, tracked revisions and wrapper or range-marker moves, footnotes, endnotes, bookmarked headings, and bookmarked tables as JSON, including lightweight Markdown for bold/emphasis/code/internal wikilinks/external links in comments, notes, accepted heading titles, tracked revision text, and bookmarked table cells plus comment, note-reference, tracked-revision, and tracked-move anchors inside the document body, native headers/footers, and bookmarked native tables; `noma docx-review-sync report.noma report.docx --out reviewed.noma --report review-sync.json` source-preservingly updates accepted heading edits, adds anchored Word comments, threaded replies, and notes, updates/resolves/reopens/deletes existing source comments and replies from Word state, updates/deletes targeted source footnotes and endnotes from Word state when they can be matched, adds/updates/deletes source `::change_request` blocks from Word revisions and moves when they can be matched, applies simple accepted `::table` edits with granular header/cell/row/column patch ops, and applies simple accepted inline `::dataset` cell/row/column edits with `update_dataset_cell`, `insert_dataset_row`, `delete_dataset_row`, `insert_dataset_column`, or `delete_dataset_column` before falling back to safe full-body dataset replacement. The review-sync report records applied changes and skipped native review items without duplicating the patched source. `noma diff before.noma after.noma --at YYYY-MM-DD` emits `::state_change` blocks for attribute additions, changes, and removals. Patch ops include `replace_block`, `replace_body`, `update_heading`, `add_comment`, `resolve_comment`, `remove_attribute`, `add_footnote`, `add_endnote`, `add_change_request`, `update_table_cell`, `update_table_header_cell`, `insert_table_row`, `delete_table_row`, `insert_table_column`, `delete_table_column`, `update_dataset_cell`, `insert_dataset_row`, `delete_dataset_row`, `insert_dataset_column`, `delete_dataset_column`, `move_block`, `add_block`, `delete_block`, `update_attribute`, and `rename_id`, plus transaction-shaped `--ops` files with optional pre/post validation.
- GitHub Action — `uses: ferax564/noma@v0.11.1` validates, renders, and uploads HTML/LLM/JSON/Noma/site artifacts in CI.
- VS Code extension — `ext install ferax564.noma-language` adds syntax highlighting, folding, embedded YAML/JSON/LaTeX/Mermaid/DOT scopes, and warning scopes for raw escape hatches.
- MCP server — `@ferax564/noma-mcp-server` exposes `read_doc`, `list_ids`, `validate_doc`, and `patch_block` over stdio.
- Agent SDK — `@ferax564/noma-agent-sdk` wraps the MCP server with TypeScript helpers for safe patching, capability descriptors, and transcript replay. Experimental during v0.x.
- Book manifests (`book.noma.yml`) + multi-file rendering. CLI auto-detects manifest extension; chapters resolve relative to its directory.
- Starter templates under `examples/templates/` for research memos, decision records, technical specs, and agent refresh packs.
- Seven examples: three demos (agent-plan, tech-doc, research-thesis), the original thesis/landing/book-chapter, and the `examples/book/` 3-chapter book.
- Eleven docs (all written in Noma): direction, spec, compatibility, getting started, agent patch protocol, architecture, comparison guide, case studies, agent editing guide, starter templates, and the Markdown/HTML pain research memo.
- Hand-crafted HTML landing page (`site/index.html`) plus the static browser workbench (`site/workbench.html`).
- PDF demo exports via Puppeteer.
- GitHub Pages deployment on every push to `main`.

See [`PLAN.md`](PLAN.md) for the long-term vision, [`docs/direction.noma`](docs/direction.noma) for the positioning, [`docs/spec.noma`](docs/spec.noma) for the format spec, and [`CHANGELOG.md`](CHANGELOG.md) for what changed when.

## Status

**Status:** v0.11.1 — polish patch on the first public `@ferax564/*` release line. Fixes the MCP server runtime version string, ships the v0.2.1 VS Code extension README, lockstep-bumps the experimental `@ferax564/noma-agent-sdk` to v0.1.1 so its declared dependencies match the v0.11.1 CLI/MCP packages, and adds two new validator rules (`claim-invalid-confidence`, `citation-missing-source`). v0.11.0 first shipped bundled JSON Schemas via `noma schema <name>`, source-preserving `replace_body` and `update_heading` patch ops, `parent=` retargeting for `rename_id`, package manifest hardening for public scoped publish, a packed-CLI smoke gate, the compatibility policy, adoption guides, and namespaced directive parsing groundwork for future community packs. See [`CHANGELOG.md`](CHANGELOG.md) and `PLAN.md` §24.22 for the full release tracker.

## License

MIT © 2026 ferax564
