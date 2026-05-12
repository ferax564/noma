# Noma

> **Readable source for beautiful agent artifacts.**

Noma is a plain-text format for books, docs, research, dashboards, and webpages. It is:

- readable like Markdown
- structured like data
- renderable like HTML
- printable like PDF
- editable by AI agents at the **block level** — not via full-file rewrites

```
.noma  →  typed AST  →  HTML / PDF / JSON / LLM context
```

**Live site:** <https://ferax564.github.io/noma/> — landing page, demo gallery, rendered HTML/PDF/LLM/JSON for every example, full docs.

## Why

Markdown is excellent for prose, weak for grids, cards, claims, plots, citations, and stable agent edits. HTML is the opposite — great as a render target, unpleasant as long-term source. Noma sits between them: a small directive syntax that compiles to clean semantic HTML, prints cleanly to PDF, exports a deterministic LLM-friendly form, and gives agents stable block IDs they can patch without rewriting whole files.

See [`docs/direction.noma`](docs/direction.noma) for the full positioning and [PLAN.md §23](PLAN.md) for the three-layer model and the central design test every feature must pass.

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

```bash
git clone https://github.com/ferax564/noma.git
cd noma
npm install

# render one demo to HTML / LLM / JSON / .noma source
npm run noma -- render examples/agent-plan.noma --to html --out dist/agent-plan.html
npm run noma -- render examples/agent-plan.noma --to llm
npm run noma -- render examples/agent-plan.noma --to json
npm run noma -- render examples/agent-plan.noma --to noma     # AST → .noma roundtrip

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

# build the full site (examples + docs + book + dark-theme demo + landing + PDFs)
npm run build:site
open dist/index.html

# re-align pipe tables in source (idempotent; skips fenced code blocks)
npm run noma -- fmt examples/research-thesis.noma --inplace
```

## Block-level edits

Agents and CI pipelines patch single blocks instead of rewriting whole files. Five operations cover the editing flows that matter:

```bash
noma patch thesis.noma --op '{"op":"replace_block","id":"claim-x","content":"::claim{id=\"claim-x\" confidence=0.9}\nNew body.\n::"}'
noma patch thesis.noma --op '{"op":"add_block","parent":"risks","content":"::risk{id=\"r1\" severity=\"high\" owner=\"me\"}\nNew risk.\n::"}'
noma patch thesis.noma --op '{"op":"delete_block","id":"deprecated"}'
noma patch thesis.noma --op '{"op":"update_attribute","id":"claim-x","key":"confidence","value":0.85}'
noma patch thesis.noma --op '{"op":"rename_id","from":"claim-x","to":"claim-renamed"}'
```

`rename_id` retargets every `for=`, `parent=`, and `[[wikilink]]` reference across the document. Patches re-serialize via the AST source printer, so the unrelated 95% of the file is byte-identical. See [`docs/agent-protocol.noma`](docs/agent-protocol.noma).

## Demos

Three artifacts that exercise the full block surface end-to-end. Each renders to HTML, PDF, LLM context, and JSON AST from a single `.noma` source.

| Demo | What it shows | Live |
| ---- | ------------- | ---- |
| **Agent planning artifact** ([source](examples/agent-plan.noma)) | Q3 roadmap decision — options, decision matrix, claims/evidence/risks, agent tasks, copy-as-prompt buttons | [HTML](https://ferax564.github.io/noma/examples/agent-plan.html) · [PDF](https://ferax564.github.io/noma/examples/agent-plan.pdf) · [LLM](https://ferax564.github.io/noma/examples/agent-plan.llm.txt) · [JSON](https://ferax564.github.io/noma/examples/agent-plan.json) |
| **Technical documentation** ([source](examples/tech-doc.noma)) | CLI reference page — tabs, callouts, code blocks, architecture diagram, cross-links | [HTML](https://ferax564.github.io/noma/examples/tech-doc.html) · [PDF](https://ferax564.github.io/noma/examples/tech-doc.pdf) · [LLM](https://ferax564.github.io/noma/examples/tech-doc.llm.txt) · [JSON](https://ferax564.github.io/noma/examples/tech-doc.json) |
| **Investment thesis** ([source](examples/research-thesis.noma)) | Vertical-AI thesis — claims with confidence scores, counterevidence, risks, datasets, plots, quarterly review tasks | [HTML](https://ferax564.github.io/noma/examples/research-thesis.html) · [PDF](https://ferax564.github.io/noma/examples/research-thesis.pdf) · [LLM](https://ferax564.github.io/noma/examples/research-thesis.llm.txt) · [JSON](https://ferax564.github.io/noma/examples/research-thesis.json) |

## What ships today

- `@noma/cli` (this package) — hand-written parser with no parser-combinator dependency. Supports directive blocks, frontmatter, headings, lists, code, quotes, GitHub-style tables, and inline markdown. The parser is exported alongside the CLI; `import { parse } from "@noma/cli"` works in any Node 20+ project.
- Typed AST in `src/ast.ts` — discriminated union, exhaustively switched everywhere.
- HTML renderer with a default CSS theme + a `dark` alternate (`--theme dark`), a print stylesheet, and per-block `{variant="..."}` styling. Native rendering for grids, cards, tabs, callouts, claims/evidence/risks, decisions, open questions, datasets, real inline-data plots (line + bar SVG, no JS), agent tasks, export buttons, controls, tables, the new `::table` directive, and `::state_change` deltas. `::html` / `::svg` / `::script` escape hatches with `--no-unsafe` to block them.
- LLM renderer — deterministic plain-text output for context windows; escape-hatch bodies always stripped.
- JSON renderer — full AST export.
- `.noma` source printer — AST → `.noma` (roundtrip-safe). Backs `noma render --to noma` and the patch CLI.
- `noma fmt` — re-aligns GitHub-style pipe tables in source; respects pipes inside `` `code spans` `` and `\|` escapes; leaves everything else byte-identical.
- Validator — wikilink references resolve across paragraphs, quotes, list items, headings, table cells, and book chapters. Default rules: duplicate IDs, broken references (incl. wikilinks), plot/figure issues, plot/dataset linkage (`plot-unknown-dataset`, `plot-unknown-column`), `plot-mixed-delimiters`, claim-without-evidence, risk-without-owner, decision-without-status, agent-task-without-scope, stale-citation, escape-hatch-untrusted, evidence-missing-for, state_change shape rules, and `out-of-profile-directive` when a `profile` is declared. Per-block opt-out with the `noverify` flag.
- Profiles — declare `profile: research | technical | minimal` in frontmatter as a contract about which directives the document uses; downstream tools can narrow safely.
- Plot/dataset linkage — `::plot{dataset="<id>" column="<name>" xcolumn="<name>"}` resolves against sibling `::dataset` blocks at render time.
- Citation staleness — global default 365 days, override via frontmatter `stale_citation_days`, per-citation `stale_after_days=N`, or CLI `--stale-days <n>`.
- CLI — `noma parse | render | check | export | patch | fmt`. Five patch ops (`replace_block`, `add_block`, `delete_block`, `update_attribute`, `rename_id`).
- Book manifests (`book.noma.yml`) + multi-file rendering. CLI auto-detects manifest extension; chapters resolve relative to its directory.
- Seven examples: three demos (agent-plan, tech-doc, research-thesis), the original thesis/landing/book-chapter, and the `examples/book/` 3-chapter book.
- Five docs (all written in Noma): direction, spec, getting started, agent patch protocol, architecture.
- Hand-crafted HTML landing page (`site/index.html`).
- PDF demo exports via Puppeteer.
- GitHub Pages deployment on every push to `main`.

See [`PLAN.md`](PLAN.md) for the long-term vision, [`docs/direction.noma`](docs/direction.noma) for the positioning, [`docs/spec.noma`](docs/spec.noma) for the format spec, and [`CHANGELOG.md`](CHANGELOG.md) for what changed when.

## Status

**Status:** v0.8.0 — adds the `memory` profile (`::memory` + `::memory_index`) for typed, validated, patch-addressable agent memory stores, plus type-aware stale-recall via `noma render --to llm --exclude-stale-days <n>` (durable `user`/`feedback` rules stay pinned; only `project`/`reference` age out). Closes the residual nested-slug bug from v0.7.1: nav chapter links, the home link, and cross-chapter wikilinks from chapter pages with a level-1 `id` containing `/` now climb the right number of directories. Carries everything from v0.7.x: `noma diff` (attribute-drift detector emitting `::state_change` blocks), manifest-level `trusted_publishing` (implies `--no-unsafe`), shared `_assets/theme.css` for `--to site` builds, depth-aware stylesheet href for nested chapters, and `tools/vscode-noma` v0.2.0 marketplace prep. See [`CHANGELOG.md`](CHANGELOG.md) and `PLAN.md` §24 for the full per-version tracker.

## License

MIT © 2026 ferax564
