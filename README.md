# Noma

> **Proof-before-apply docs for AI agents.**

Noma is a plain-text document format for AI-maintained docs in Git. It lets
teams keep reviewable `.noma` source, give agents scoped context and stable
block IDs, generate a proof before applying patches, and render the same source
as polished artifacts or searchable documentation spaces.
It is:

- readable like Markdown
- structured like data
- renderable like HTML
- printable like PDF
- editable by AI agents at the **block level** — not via full-file rewrites

```text
.noma source -> scoped context -> proof -> patch -> validated artifact
```

**Live site:** <https://ferax564.github.io/noma/> — landing page, demo gallery, rendered HTML/PDF/LLM/JSON for every example, full docs.

## Why

Markdown is excellent for prose. LaTeX is excellent for publication-grade math
and typesetting. HTML is excellent as the browser artifact. The painful gap is
the work agents now produce and maintain: research memos, PR reviews, decision
records, technical specs, stale-source refreshes, and Word review handoffs that
need tables, citations, validation, render targets, and safe follow-up edits.

Noma is that middle layer. Keep the source small and reviewable like Markdown;
render the artifact as HTML/PDF/DOCX/LLM/JSON; give agents typed blocks and
stable IDs so they can patch the exact claim, table, risk, task, or citation
that changed.

See [`docs/direction.noma`](docs/direction.noma) for the full positioning and [PLAN.md §23](PLAN.md) for the three-layer model and the central design test every feature must pass.

## The wedge

Use Noma when an agent is about to update a source-controlled document and a
reviewer needs proof before the source changes:

| Surface | What Noma keeps stable | Why Markdown or raw HTML alone gets awkward |
| ------- | ---------------------- | ------------------------------------------- |
| Source | readable `.noma` text with directive blocks | Markdown gets flat; HTML gets noisy to co-author and diff |
| Agent | IDs, validation, scoped LLM export, patch ops, proof summaries | Agents need structure instead of whole-file rewrites |
| Artifact | standalone HTML, PDF, DOCX, docs space, JSON | Markdown needs extra tooling for polished rich output |

The first sharp use cases are agent-refreshable research, PR/architecture review
artifacts, decision records, table-heavy technical specs, Word review loops, and
agent memory files.

## The loop

The default workflow is deliberately small:

```bash
noma check memo.noma
noma render memo.noma --to html --strict --out memo.html
noma render memo.noma --to llm --select claim,evidence,risk --budget 12000
noma ids memo.noma
noma proof memo.noma --ops ops.json --out proof.html
noma patch memo.noma --ops ops.json --inplace
noma check memo.noma
```

That is the product contract: humans review source and artifacts; agents inspect
IDs, prove the patch, update the smallest stable surface, and validation catches
broken structure before the artifact ships.

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
npm install -g @ferax564/noma-cli@latest
noma --version
noma init my-spec
noma check my-spec/demo.noma
noma render my-spec/demo.noma --to html --out my-spec/demo.html
noma render my-spec/demo.noma --to llm --budget 12000
noma ids my-spec/demo.noma
noma proof my-spec/demo.noma --op '{"op":"replace_body","id":"first-risk","content":"The first risk is now tracked without rewriting surrounding source."}' --out my-spec/proof.html
noma patch my-spec/demo.noma --op '{"op":"replace_body","id":"first-risk","content":"The first risk is now tracked without rewriting surrounding source."}' --inplace
noma check my-spec/demo.noma

# bring existing Markdown into the agent-safe loop incrementally
noma ingest docs/README.md --out docs/README.noma
noma check docs/README.noma --profile technical-docs
```

Install editor support:

```text
ext install ferax564.noma-language
```

Install the agent integration packages when you want MCP or a TypeScript
workflow wrapper:

```bash
npm install @ferax564/noma-mcp-server@latest
npm install @ferax564/noma-agent-sdk@latest
```

From a checkout:

```bash
git clone https://github.com/ferax564/noma.git
cd noma
npm install

# render one demo to HTML / LLM / JSON / Markdown / .noma source
npm run noma -- render examples/agent-plan.noma --to html --out dist/agent-plan.html
npm run noma -- render examples/agent-plan.noma --to llm
npm run noma -- render examples/agent-plan.noma --to llm --select claim,evidence,risk --exclude dataset --budget 12000
npm run noma -- render examples/agent-plan.noma --to json
npm run noma -- render examples/agent-plan.noma --to markdown --out dist/agent-plan.md
npm run noma -- render examples/agent-plan.noma --to noma     # AST → .noma roundtrip
npm run noma -- ids examples/book/book.noma.yml               # global ID + alias map for agents
npm run noma -- proof examples/agent-plan.noma --op '{"op":"update_attribute","id":"decision-q3-direction","key":"status","value":"accepted"}' --out dist/agent-plan-proof.html
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
npm run noma -- render examples/book/book.noma.yml --to site --out dist/book-site

# block-level patch — agent-safe edits, no full-file rewrite
npm run noma -- patch examples/thesis.noma \
  --op '{"op":"update_attribute","id":"asml-euv-moat","key":"confidence","value":0.95}' \
  --inplace

# validate a document
npm run noma -- check examples/research-thesis.noma

# render in GitHub Actions
# - uses: ferax564/noma@v0.13.0
#   with:
#     input: docs/spec.noma
#     output: dist/spec.html

# build the full site (examples + docs + book + dark-theme demo + landing + PDFs)
npm run build:site
open dist/index.html
open dist/workbench.html

# run the hosted Noma Cloud app locally
npm run build:cloud
PORT=3000 npm start
open http://localhost:3000/cloud.html

# inspect the plugin-ready query API
curl -H "authorization: Bearer $NOMA_TOKEN" http://localhost:3000/api/db/schema
curl -X POST -H "authorization: Bearer $NOMA_TOKEN" -H "content-type: application/json" \
  -d '{"resource":"blocks","q":"roadmap","limit":10}' \
  http://localhost:3000/api/db/query

# deploy the hosted Noma Cloud app with EZKeel
npm run deploy:ezkeel:dry-run
npm run deploy:ezkeel

# deploy the built static site to a Hetzner host over SSH/rsync
HETZNER_TARGET=hetzner HETZNER_PATH=/var/www/noma npm run deploy:hetzner

# optional first-time nginx provisioning on that host
HETZNER_TARGET=hetzner HETZNER_DOMAIN=noma.example.com HETZNER_PROVISION=1 npm run deploy:hetzner

# re-align pipe tables in source (idempotent; skips fenced code blocks)
npm run noma -- fmt examples/research-thesis.noma --inplace
```

## Block-level edits

Agents and CI pipelines patch single blocks instead of rewriting whole files. Twenty-three operations cover the editing flows that matter:

```bash
noma proof thesis.noma --op '{"op":"replace_body","id":"claim-x","content":"Sharper body text."}' --out proof.html
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

`noma proof` dry-runs those same patch operations and renders an agent safety proof: pre/post validation, ID registry, LLM context, operation payloads, source-line preservation, diff, hashes, and a sandboxed post-patch artifact preview. `--to markdown` emits a reviewer-friendly PR summary; `--inplace` writes only when the proof passes. `rename_id` retargets reference attributes such as `for=`, `parent=`, `dataset=`, `block=`, and `ref=`, plus `[[wikilink]]` references across the document. Table patch ops escape literal separator pipes in edited cells while preserving pipes inside inline code spans. The source-preserving patch path rewrites only the addressed line range or inserted block, so unrelated bytes stay byte-identical. `noma prove` remains an alias. See [`docs/agent-protocol.noma`](docs/agent-protocol.noma) and [`docs/compatibility.noma`](docs/compatibility.noma).

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
      - uses: ferax564/noma@v0.13.0
        with:
          input: docs/spec.noma
          output: dist/spec.html
          to: html
          strict: true
          artifact-name: spec-preview
```

Generate a proof artifact and PR comment from proposed patch ops:

```yaml
name: Proof docs patch

on: [pull_request]

jobs:
  noma-proof:
    runs-on: ubuntu-latest
    permissions:
      contents: read
      pull-requests: write
    steps:
      - uses: actions/checkout@v4
      - uses: ferax564/noma@v0.13.0
        with:
          mode: proof
          input: docs/spec.noma
          ops: proposed-docs-patch.json
          profile: technical-docs
          proof-output: dist/spec-proof.html
          comment-pr: true
          artifact-name: spec-proof
```

The action installs the CLI from the checked-out action ref by default, runs `noma check`, and either renders the requested target or generates a proof report plus Markdown summary. Use `to: site` when `mode: render`, `input` is a book manifest, and `output` is a directory. For explicit dependency control, set `cli-package` to any npm package spec or `cli-version` to an `@ferax564/noma-cli` npm version range.

## Demos

Five artifacts exercise the full block surface end-to-end. The main demos render to HTML, LLM context, and JSON AST from a single `.noma` source; the Word review-loop demo also builds a DOCX handoff. For the workflow narrative behind them, see the [case studies](docs/case-studies.noma).

| Demo | What it shows | Live |
| ---- | ------------- | ---- |
| **Agent planning artifact** ([source](examples/agent-plan.noma)) | Q3 roadmap decision — options, decision matrix, claims/evidence/risks, agent tasks, copy-as-prompt buttons | [HTML](https://ferax564.github.io/noma/examples/agent-plan.html) · [Proof](https://ferax564.github.io/noma/examples/agent-plan-proof.html) · [PDF](https://ferax564.github.io/noma/examples/agent-plan.pdf) · [LLM](https://ferax564.github.io/noma/examples/agent-plan.llm.txt) · [JSON](https://ferax564.github.io/noma/examples/agent-plan.json) |
| **Technical documentation** ([source](examples/tech-doc.noma)) | CLI reference page — tabs, callouts, code blocks, architecture diagram, cross-links | [HTML](https://ferax564.github.io/noma/examples/tech-doc.html) · [PDF](https://ferax564.github.io/noma/examples/tech-doc.pdf) · [LLM](https://ferax564.github.io/noma/examples/tech-doc.llm.txt) · [JSON](https://ferax564.github.io/noma/examples/tech-doc.json) |
| **Investment thesis** ([source](examples/research-thesis.noma)) | Vertical-AI thesis — claims with confidence scores, counterevidence, risks, datasets, plots, quarterly review tasks | [HTML](https://ferax564.github.io/noma/examples/research-thesis.html) · [PDF](https://ferax564.github.io/noma/examples/research-thesis.pdf) · [LLM](https://ferax564.github.io/noma/examples/research-thesis.llm.txt) · [JSON](https://ferax564.github.io/noma/examples/research-thesis.json) |
| **Interactive projection** ([source](examples/interactive-projection.noma)) | Controls update computed metrics, plots, and computed tables; scenario state persists in the URL hash | [HTML](https://ferax564.github.io/noma/examples/interactive-projection.html) · [LLM](https://ferax564.github.io/noma/examples/interactive-projection.llm.txt) · [JSON](https://ferax564.github.io/noma/examples/interactive-projection.json) |
| **Word review loop** ([source](examples/word-review-loop.noma)) | Word controls, comments, change requests, native computed tables, and extractable review return data | [HTML](https://ferax564.github.io/noma/examples/word-review-loop.html) · [DOCX](https://ferax564.github.io/noma/examples/word-review-loop.docx) · [LLM](https://ferax564.github.io/noma/examples/word-review-loop.llm.txt) · [JSON](https://ferax564.github.io/noma/examples/word-review-loop.json) |

## Guides for adoption

- [Getting started](docs/getting-started.noma) — the first proof loop: render, export context, list IDs, prove a patch, patch, validate.
- [Agent editing guide](docs/agent-guide.noma) — the operational rulebook agents should follow before touching a `.noma` file.
- [Case studies](docs/case-studies.noma) — agent-refreshable research memo, decision artifact, technical-doc publishing, Word review, and memory workflow.
- [Comparison guide](docs/comparison.noma) — when to choose Noma vs Markdown, MDX, raw HTML, or collaborative docs.
- [LaTeX/Markdown/HTML pain research](docs/research-markdown-html-pains.noma) — external evidence behind the source/artifact/agent wedge.
- [Starter templates](docs/templates.noma) — copyable research memo, decision record, technical spec, and agent refresh templates under `examples/templates/`.
- [Web workbench guide](docs/workbench.noma) — screenshots and workflows for the browser-based Word-style `.noma` editor.
- [Noma Cloud guide](docs/noma-cloud.noma) — screenshot-backed guide for workspaces, permissions, page editing, published sites, agent review, EZKeel deployment, and the query API.

## What ships today

- `@ferax564/noma-cli` (this package) — hand-written parser with no parser-combinator dependency. Supports directive blocks, frontmatter, headings, lists, code, quotes, GitHub-style tables, and inline markdown. The parser, renderers, and DOCX return-path helpers are exported alongside the CLI; `import { parse, renderMarkdown, extractDocxControlData, syncControlDefaultsFromDocx, extractDocxReviewData, syncReviewCommentsFromDocx } from "@ferax564/noma-cli"` works in any Node 20+ project.
- Typed AST in `src/ast.ts` — discriminated union, exhaustively switched everywhere.
- HTML renderer with a default CSS theme + a `dark` alternate (`--theme dark`), a print stylesheet, and per-block `{variant="..."}` styling. Native rendering for grids, cards, tabs, callouts, claims/evidence/risks, decisions, open questions, semantic research metadata, technical API/reference panels, metric KPI blocks, addressable code snippets, code-cell/output computation panels, memory profile panels, review comments/collaboration metadata, readable custom directive fallbacks, datasets, real inline-data plots (line + bar SVG, no JS) with x-axis label controls, agent tasks, change-request deltas, export buttons, controls, interactive computed metrics/plots, tables, the new `::table` directive, and `::state_change` deltas. `::html` / `::svg` / `::script` escape hatches can be blocked with `--no-unsafe`; `--strict` also omits external CDN runtimes for math, diagrams, and Plotly, and freezes computed controls as disabled static defaults with no inline runtime. Book manifests with `trusted_publishing: true` apply that strict static posture to manifest-driven HTML/site/PDF renders.
- Noma Space renderer (`noma render book.noma.yml --to site --out dist/space`) — multi-file books and documentation sets become a static, Confluence-like knowledge space with a sidebar, depth-aware links, page breadcrumbs, search UI, `_assets/search-index.json` for agents, page status/owner/updated/tag metadata, related-page suggestions, and cross-chapter backlinks from `[[id]]` references.
- Noma Cloud server (`npm run build:cloud && npm start`) — serves the cloud app, workbench, and rendered sites while persisting users, documents, sites, permissions, share links, diagnostics, JSON/LLM exports, block indexes, and reader artifacts in SQLite. Documents live behind `/api/documents`; workspaces live behind `/api/sites`; reader artifacts render at `/d/<id>` and `/s/<id>`; the plugin-ready DB API lives behind `/api/db/schema` and `/api/db/query`.
- Noma Cloud app (`site/cloud.html`, published as `dist/cloud.html`) — hosted workspace editor with spaces, page navigation, editable Noma source, live rendered preview, save/publish/share actions, viewer/editor/owner-aware controls, user invites, and an agent patch panel backed by source-preserving patch ops. Workspace editors can edit pages through site-scoped permissions instead of sharing each page separately.
- Web workbench (`site/workbench.html`, published as `dist/workbench.html`) — browser-based editing surface for `.noma` source with a compact Word-style menu bar and tabbed File, Format, Insert, Layout, Review, Find, and Export ribbon panels. It includes Typora-style rendered editing for headings/prose/list items/quotes, live safe HTML preview, diagnostics-first inspection, URL-fragment draft links, cloud document links when served by Noma Cloud, copyable review packets, proof-before-apply agent patch controls, proof-summary links, a compact table/dataset editor backed by granular patch ops, outline navigation, AST/LLM/Proof output tabs, example loading, local file opening, Markdown file upload and clipboard paste intake, selection-aware Markdown formatting, Noma block insertion templates, and HTML/JSON/Noma/Markdown/LLM export actions. The client bundle reuses the core parser, validator, patcher, HTML renderer, JSON renderer, Markdown renderer, LLM renderer, and hosted document API.
- LLM renderer — deterministic plain-text output for context windows; escape-hatch bodies always stripped. Supports `--select`, `--exclude`, and `--budget` for scoped agent context, and emits computed formulas with default scalar/series results from control defaults.
- Markdown renderer — portable `.md` export for GitHub, Slack, email, Notion-style imports, and agent handoffs. It preserves ordinary Markdown prose, emits hidden anchors for IDs and aliases, converts `[[id]]` wikilinks to `[id](#id)`, renders tasks as checklists, figures as Markdown images, callouts as GitHub-style admonitions, tables as pipe tables, and wraps directives in hidden semantic comments so exported Markdown keeps enough block context for agents.
- DOCX renderer — dependency-free WordprocessingML export for handoff to Word or Google Docs import paths. It preserves frontmatter as Word package metadata, headings, prose, lists, page-aware tables, field-numbered table captions, dataset tables, metric KPI blocks, static computed metric/plot/table handoffs, technical API/reference blocks, addressable code snippets, code-cell/output computation blocks, page-aware grid/columns layouts, framed card panels, memory profile panels, flattened hero/tabs/accordion sections, titled tab panels, framed sidebars, code blocks, abstract/callout/note/warning/tip blocks, Office Math blocks and inline equations, native checkbox action items, native text/dropdown/date/checkbox control fields with optional lock metadata and custom XML data bindings, action blocks, section-level page setup, form document-protection settings, rich native headers/footers with page numbers and part-local hyperlinks, linked tables of contents and caption lists with Word page-reference fields, caption cross-reference fields for figure/table/plot wikilinks, page breaks, targeted/threaded native comments with rich inline body content and resolved-state metadata, review-view settings for comments and revisions, target-anchored rich tracked review revisions, state-change deltas, target-anchored rich native footnotes/endnotes, generated bibliographies, styled semantic review blocks and metadata, review/provenance/confidence metadata blocks, embedded PNG/JPEG/GIF/SVG figures, field-numbered figure/plot captions, static SVG plots for resolvable data, diagram/Plotly source fallbacks, clickable citations, block-ID bookmarks, internal wikilinks, external hyperlinks with rich Markdown labels including combined bold+italic spans, visible escaped table pipes outside code spans, and readable fallback labels for custom directives; unresolved web-only blocks degrade to labeled placeholders.
- JSON renderer — full AST export.
- `.noma` source printer — AST → `.noma` (roundtrip-safe). Backs `noma render --to noma`; source-preserving `noma patch` rewrites addressed spans directly.
- `noma fmt` — re-aligns GitHub-style pipe tables in source; respects pipes inside `` `code spans` `` and `\|` escapes, which render as literal pipes outside code spans; leaves everything else byte-identical.
- Validator — wikilink references resolve across paragraphs, quotes, list items, headings, table cells, and book chapters. Default rules: duplicate IDs, broken references (incl. wikilinks), plot/figure issues, plot/dataset linkage (`plot-unknown-dataset`, `plot-unknown-column`), `plot-mixed-delimiters`, claim-without-evidence, `claim-invalid-confidence`, risk-without-owner, decision-without-status, agent-task-without-scope, stale-citation, `citation-missing-source`, escape-hatch-untrusted, evidence-missing-for, computed formula/control checks, state_change and change_request shape rules, and `out-of-profile-directive` when a `profile` is declared. Per-block opt-out with the `noverify` flag.
- Profiles — declare `profile: <name>` in frontmatter, or enforce one in CI with `noma check --profile technical-docs`, as a contract about which directives the document uses. The workflow profiles `technical-docs`, `research-memo`, `investment-thesis`, `adr`, `spec`, and `agent-memory` encode useful defaults without expanding syntax.
- Plot/dataset linkage — `::plot{dataset="<id>" column="<name>" xcolumn="<name>"}` resolves against sibling `::dataset` blocks at render time.
- Citation staleness — global default 365 days, override via frontmatter `stale_citation_days`, per-citation `stale_after_days=N`, or CLI `--stale-days <n>`.
- CLI — `noma --version`, `noma init`, `noma ingest`, `noma parse | render | ids | schema | check | export | proof | prove | patch | fmt | docx-data | docx-sync | docx-review-data | docx-review-sync | diff`. `noma ingest docs/README.md --out docs/README.noma` keeps Markdown-compatible source and pins explicit heading IDs for incremental migration. `noma proof report.noma --ops ops.json --out proof.html` dry-runs a patch transaction and renders an agent safety proof with diagnostics, hashes, source preservation, diff, LLM context, ID registry, and a sandboxed post-patch artifact preview; `--to json` emits the same proof metadata for automation, `--to markdown` emits a PR-ready summary, and `--inplace` writes only if the proof passes. `noma render --to markdown --out report.md` writes a portable Markdown handoff; `noma render --to pdf --out report.pdf` prints through Chromium via Puppeteer and accepts `--page-size`, margin flags, `--no-print-background`, and `--css`; `noma render --to docx --out report.docx` writes a Word-compatible package; `noma docx-data report.docx --out controls.json` extracts bound `::control` values from the DOCX custom XML part or visible `noma-control:<id>` content controls in the document body, headers, or footers plus native `::agent_task` / `::todo` checkbox state from those Word content controls; `noma docx-sync report.noma report.docx --out synced.noma --report sync.json` source-preservingly updates matching `::control default=` attributes and task done/status attributes from those values and can write a JSON change/unmatched report; `noma docx-review-data report.docx` extracts native Word comment/note bodies, authors, resolved state, reply links, tracked revisions and wrapper or range-marker moves, footnotes, endnotes, bookmarked headings, and bookmarked tables as JSON, including lightweight Markdown for bold/emphasis/code/internal wikilinks/external links in comments, notes, accepted heading titles, tracked revision text, and bookmarked table cells plus comment, note-reference, tracked-revision, and tracked-move anchors inside the document body, native headers/footers, and bookmarked native tables; `noma docx-review-sync report.noma report.docx --out reviewed.noma --report review-sync.json` source-preservingly updates accepted heading edits, adds anchored Word comments, threaded replies, and notes, updates/resolves/reopens/deletes existing source comments and replies from Word state, updates/deletes targeted source footnotes and endnotes from Word state when they can be matched, adds/updates/deletes source `::change_request` blocks from Word revisions and moves when they can be matched, applies simple accepted `::table` edits with granular header/cell/row/column patch ops, and applies simple accepted inline `::dataset` cell/row/column edits with `update_dataset_cell`, `insert_dataset_row`, `delete_dataset_row`, `insert_dataset_column`, or `delete_dataset_column` before falling back to safe full-body dataset replacement. The review-sync report records applied changes and skipped native review items without duplicating the patched source. `noma diff before.noma after.noma --at YYYY-MM-DD` emits `::state_change` blocks for attribute additions, changes, and removals. Patch ops include `replace_block`, `replace_body`, `update_heading`, `add_comment`, `resolve_comment`, `remove_attribute`, `add_footnote`, `add_endnote`, `add_change_request`, `update_table_cell`, `update_table_header_cell`, `insert_table_row`, `delete_table_row`, `insert_table_column`, `delete_table_column`, `update_dataset_cell`, `insert_dataset_row`, `delete_dataset_row`, `insert_dataset_column`, `delete_dataset_column`, `move_block`, `add_block`, `delete_block`, `update_attribute`, and `rename_id`, plus transaction-shaped `--ops` files with optional pre/post validation.
- GitHub Action — `uses: ferax564/noma@v0.13.0` validates, renders, and uploads HTML/LLM/JSON/Noma/Markdown/site artifacts in CI; `mode: proof` generates proof HTML, a Markdown PR summary, optional PR comments, and uploaded proof archives.
- VS Code extension — `ext install ferax564.noma-language` adds syntax highlighting, folding, embedded YAML/JSON/LaTeX/Mermaid/DOT scopes, and warning scopes for raw escape hatches.
- MCP server — `@ferax564/noma-mcp-server` exposes `read_doc`, `list_ids`, `validate_doc`, and `patch_block` over stdio.
- Agent SDK — `@ferax564/noma-agent-sdk` wraps the MCP server with TypeScript helpers for safe patching, capability descriptors, and transcript replay. Experimental during v0.x.
- Book manifests (`book.noma.yml`) + multi-file rendering. CLI auto-detects manifest extension; chapters resolve relative to its directory, and `--to site` publishes the set as a searchable static Noma Space.
- Starter templates under `examples/templates/` for research memos, decision records, technical specs, and agent refresh packs.
- Nine examples: five demos (agent-plan, tech-doc, research-thesis, interactive-projection, word-review-loop), the original thesis/landing/book-chapter, and the `examples/book/` 3-chapter book.
- Thirteen docs (all written in Noma): direction, spec, compatibility, getting started, web workbench guide, Noma Cloud guide, agent patch protocol, architecture, comparison guide, case studies, agent editing guide, starter templates, and the Markdown/HTML pain research memo.
- Hand-crafted HTML landing page (`site/index.html`) plus the hosted cloud app (`site/cloud.html`) and static browser workbench (`site/workbench.html`).
- PDF demo exports via Puppeteer.
- GitHub Pages deployment on every push to `main`.
- EZKeel deployment config — `ezkeel.yaml` and `Dockerfile` run `npm run build:cloud`, start `node dist/cloud-server.js`, expose `/healthz`, and use `/data/noma` as the runtime storage root for a hosted Noma Cloud app on user-owned VPS infrastructure. Runtime state is stored in `/data/noma/noma-cloud.sqlite`, with one-time import from older JSON document/user/site records when present.
- Hetzner static deploy helper — `npm run deploy:hetzner` builds `dist/`, rsyncs it to a timestamped release on an SSH target, flips a `current` symlink, can provision nginx with `HETZNER_PROVISION=1`, and can run a health check with `HETZNER_URL=...`.

See [`PLAN.md`](PLAN.md) for the long-term vision, [`docs/direction.noma`](docs/direction.noma) for the positioning, [`docs/spec.noma`](docs/spec.noma) for the format spec, and [`CHANGELOG.md`](CHANGELOG.md) for what changed when.

## Status

**Status:** v0.15.0 public release. This line closes the live editing loop: `--watch` mode re-runs render/check/export on file change, diagnostics carry ready-to-apply fixits (`noma check --fix`), book-wide patch transactions route ops to the owning chapter with all-or-nothing writes, and a new language server (`@ferax564/noma-lsp`) powers diagnostics, symbols, go-to-definition, and `[[` completion in the VS Code extension; see [`CHANGELOG.md`](CHANGELOG.md) and `PLAN.md` §24.33 for the full release tracker.

## License

MIT © 2026 ferax564
