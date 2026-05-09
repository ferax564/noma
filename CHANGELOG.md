# Changelog

All notable changes to Noma are documented here.
Format follows [Keep a Changelog](https://keepachangelog.com/en/1.1.0/);
versioning follows [SemVer](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **AST source printer** (`src/renderer-noma.ts`) — AST → `.noma`
  serializer. Roundtrip-safe (`parse → renderNoma → parse` preserves the
  AST modulo positions). Foundation for `noma patch`. Also exposed as
  `noma render --to noma`. New roundtrip test covers every `.noma` file
  in `examples/` and `docs/`.

- **`noma patch`** — block-level edits without rewriting the file. Five
  ops shipped:
  - `replace_block{id, content}`
  - `add_block{parent, content, position?}`
  - `delete_block{id}`
  - `update_attribute{id, key, value}`
  - `rename_id{from, to}` — also rewrites `for=`, `parent=`, and
    `[[wikilink]]` references across the document.

  CLI: `noma patch <file> --op '<json>' [--inplace | --out path]` or
  `--ops <file.json>` for batches. Public API: `patch`, `patchAll`,
  `findById`, `PatchError` from `@noma/cli`. This closes PLAN.md §23.11
  and turns the agent-protocol doc from spec into shipped code.

- **Three new demo artifacts** under `examples/`, exercising the full block
  surface end-to-end:
  - `agent-plan.noma` — Q3 roadmap decision (options, decision matrix,
    claims/evidence/risks, agent tasks, copy-as-prompt buttons).
  - `tech-doc.noma` — CLI reference page (tabs, callouts, code blocks,
    architecture diagram, cross-links).
  - `research-thesis.noma` — vertical-AI investment thesis (claims with
    confidence scores, counterevidence, datasets, plots, quarterly review
    tasks).
- **`docs/direction.noma`** — canonical statement of what Noma is, the
  three-layer model (source / artifact / agent), and the central design
  test every feature must pass. Mirrors PLAN.md §23.
- **`examples/index.noma`** — Noma-rendered gallery (kept around as
  `dist/_index-noma.html`; the live site uses the hand-crafted
  `site/index.html` instead).
- **GitHub-style Markdown tables** — new `TableNode` AST variant.
  Pipe-row + separator detection, per-column alignment via `:---` /
  `:---:` / `---:`, inline markdown preserved inside cells. HTML emits
  `<table class="noma-table">` with per-cell `text-align`; LLM keeps
  the pipe format aligned to column widths.
- **`::export_button`** directive — renders as a real `<button>` with
  format-aware coloring (`prompt` blue, `markdown` green, `json` grey).
  Powers the "Copy as prompt", "Copy summary", "Copy AST" actions in
  the agent-plan and research-thesis demos.
- **`::control`** directive — renders a labeled input. First step
  toward the interactive-artifact blocks described in PLAN.md §23.9.
- **`::open_question` / `::assumption` styling** — distinct accent colors
  in the default theme so they read as their own block class.
- **PDF exports for all three demos** via Puppeteer
  (`dist/examples/{agent-plan,tech-doc,research-thesis}.pdf`,
  A4 with print backgrounds). New script: `scripts/render-demo-pdfs.ts`.
- **Hand-crafted HTML landing page** at `site/index.html` —
  sticky nav, gradient hero with side-by-side `.noma`/artifact preview,
  three-layer model cards, demo gallery with custom SVG thumbnails,
  vs-Markdown and vs-HTML comparison tables, central design-test panel.
  This is intentionally not a `.noma` file: marketing layout is the kind
  of artifact where bespoke HTML is the right escape hatch.
- **`npm run build:site`** orchestrator — renders examples + docs,
  copies `site/` over `dist/`, generates demo PDFs.
- **`npm run render:docs`** — renders all `docs/*.noma` to HTML + LLM.
- **JSON renders for all demos** — `render:examples` now emits `.json`
  alongside `.html` and `.llm.txt`.
- **GitHub Pages deployment** via `.github/workflows/pages.yml`. Every
  push to `main` runs `npx tsc --noEmit && npm test && npm run build:site`
  and publishes `dist/` to <https://ferax564.github.io/noma/>. Chrome is
  installed in CI (`npx puppeteer browsers install chrome`) so PDFs
  build on the runner.
- **PLAN.md §23** — revised final direction (three-layer model, central
  design test, artifact-first rendering, refined comparison tables,
  updated MVP scope and four-week plan).
- **PLAN.md §24** — "Shipped" tracker that lists what crossed from plan
  to reality.
- **Parser test** for tables (alignment markers, inline markdown in cells,
  HTML and LLM round-trip).

### Changed

- **Default theme** — added styles for `<table class="noma-table">`,
  `.noma-export-button` (with format-keyed colors), `.noma-control`,
  and the `decision`/`open_question`/`assumption` research-block
  variants. Hover state added on table rows.
- **`render:examples`** script now also renders LLM and JSON for the
  three new demos, not just HTML.
- **Top-nav alignment** on the landing page — every link sits in a fixed
  inline-flex 32px box so the GitHub pill aligns with the plain text
  links instead of dropping below them.

### Fixed

- **Markdown tables previously rendered as `<p>` with `<br>`** between
  rows. Tables in `docs/spec.noma`, the new demos, and the comparison
  pages now render as real HTML tables. (Surfaced when shipping the
  refined direction docs.)

## [0.1.0] — 2026-05-09

Initial public release.

### Added

- `@noma/parser` — hand-written, no parser-combinator dependency.
- Typed AST in `src/ast.ts` — discriminated union, exhaustively
  switched everywhere.
- HTML renderer with default CSS theme and print stylesheet.
- LLM renderer — deterministic plain-text output for context windows.
- JSON renderer — full AST export.
- Validator — duplicate IDs, broken references, plots without data,
  figures without alt text.
- CLI — `noma parse | render | check | export`.
- Three working examples: investment thesis, landing page, mini-book
  chapter.
- Four docs (written in Noma): spec, getting started, agent patch
  protocol, architecture.
- Puppeteer-based PDF script (`scripts/render-pdf.ts`).
