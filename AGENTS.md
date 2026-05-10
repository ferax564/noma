# Noma — Project Memory for Codex

## What is Noma

Noma is a plain-text **document format** for humans and AI agents. Think:
- readable like Markdown
- structured like data
- renderable like HTML
- printable like PDF
- editable by agents at the **block level** (not full-file rewrites)

Source files use the `.noma` extension. The full vision lives in `PLAN.md` — read it before making structural changes.

## Repo Layout

```
src/                       TypeScript source for parser, AST, renderers, validator, CLI
  ast.ts                   Typed AST node definitions (single source of truth)
  parser.ts                .noma → AST (hand-written recursive descent)
  renderer-html.ts         AST → semantic HTML (plot SVGs, escape hatches, KaTeX auto-inject, alias anchors)
  renderer-llm.ts          AST → deterministic LLM context (escape-hatch bodies stripped; math passes through)
  renderer-json.ts         AST → JSON
  renderer-noma.ts         AST → .noma source (roundtrip-safe; backs `noma patch`)
  renderer-site.ts         Multi-page HTML site for book manifests (`--to site`). Cross-chapter wikilink rewrite.
  validator.ts             AST → diagnostics (`noverify` opt-out; composable profiles; wikilink refs incl. aliases; `--ignore-rule`)
  inline.ts                Inline markdown + shared `splitPipeRow` util
  patch.ts                 Block-level patch ops (replace/add/delete/update_attr/rename_id)
  book.ts                  YAML manifest loader. `loadBook` (concat) + `loadBookChapters` (per-chapter, scoped IDs)
  fmt.ts                   Source formatter; re-aligns pipe tables, leaves rest byte-identical
  cli.ts                   `noma parse|render|check|export|patch|fmt` (`--to site`, `--math`, `--ignore-rule`)
bin/noma.mjs               Node CLI shim
themes/default.css         Default HTML theme (tables, export buttons, controls, variants)
themes/dark.css            Alternate dark theme — `noma render --theme dark`
examples/                  Demo .noma files
  thesis.noma              Original ASML investment-thesis demo (with real revenue plot)
  landing.noma             Original landing-page demo
  book-chapter.noma        Original single-chapter demo
  agent-plan.noma          Demo 1 — Q3 roadmap decision artifact
  tech-doc.noma            Demo 2 — CLI reference page
  research-thesis.noma     Demo 3 — vertical-AI investment thesis (with real bar/line plots)
  index.noma               Noma-rendered gallery (kept around as dist/_index-noma.html)
  book/                    Multi-file demo book — book.noma.yml + 3 chapters
docs/                      Project docs, all written in .noma
  direction.noma           Canonical positioning (mirrors PLAN.md §23)
  spec.noma                Block-type and AST reference (incl. variants, book manifests, escape hatches)
  architecture.noma        Parser/renderer/validator design
  agent-protocol.noma      Block-level patch operation schema
  getting-started.noma     User-facing walkthrough
site/                      Hand-crafted HTML landing page (NOT a .noma file)
  index.html               Bespoke layout — copied to dist/index.html in build
scripts/                   Build/render helpers
  render-pdf.ts            Single HTML → PDF via Puppeteer
  render-demo-pdfs.ts      All three demos → PDF (single browser instance)
test/                      node:test suites — parser, roundtrip, patch, validator, plot, book, escape-hatch
.github/workflows/         CI
  pages.yml                Typecheck + tests + build:site → GitHub Pages
dist/                      Build output (gitignored). GH Pages deploys this.
PLAN.md                    Full product vision (do NOT delete). §23 = revised direction. §24 = shipped tracker.
CHANGELOG.md               Keep-a-Changelog format. Add to [Unreleased] as you ship.
```

## Block Syntax — Quick Reference

```noma
::block_type{id="x" attr="value" flag}
inline content or nested children
::
```

- `::name{...}` opens a block; `::` closes it.
- `:::` opens a child block one level deeper (Pandoc-style fences).
- Frontmatter is YAML between `---` markers at the top of the file.
- Headings (`# H1`, `## H2`) auto-create `section` blocks with stable IDs derived from slugified titles. **v0.4:** trailing `{id="..." aliases="a,b"}` overrides the slug or registers extra IDs.
- Inline markdown (`**bold**`, `*em*`, `` `code` ``, `[text](url)`) is kept inside paragraph and heading content.
- **v0.4:** inline math via `$..$`, `$$..$$`, `\(..\)`, `\[..\]` and the `::math` block. KaTeX is auto-injected on standalone HTML when math is detected.

Block IDs are **stable**: agents target them by ID for safe edits. Renaming an ID is a breaking edit.

**Aliases (v0.4).** A node can carry `aliases?: string[]` — alternative IDs that resolve to the same node. Sources:
- frontmatter `aliases: [...]` → attached to chapter root section
- chapter filename slug → auto-attached to root section
- `## Heading {aliases="..."}` → attached to that section
- book mode scoping → original (un-prefixed) slug retained as alias

Validator: `referenced` IDs match against `ids ∪ aliasIds`. HTML renderer: emits hidden `<a class="noma-alias" id="alias">` anchors before each headed section so URL fragments resolve. The site renderer's wikilink-rewrite uses the alias map to find the owning chapter.

## Iron Rules

1. **Never break the AST contract.** `src/ast.ts` is the source of truth. Renderers and validators import types from there. If you add a node type, add it to the discriminated union and to every renderer's switch statement (the TS compiler enforces this — keep `noUncheckedIndexedAccess` on).
2. **Renderers must be pure.** Input AST → output string. No I/O, no globals, no mutation of the input AST.
3. **Parser is forgiving, validator is strict.** The parser should accept anything that *looks* like Noma and produce a best-effort tree. The validator is where errors live. Keeps editor experience smooth.
4. **Block IDs are user-facing API.** Agents and external tools reference blocks by ID. Auto-generated IDs (from heading slugs) must be deterministic and stable across re-parses of unchanged content.
5. **Examples are tests.** Files in `examples/` and `docs/` must always parse and render cleanly. CI runs `npm run render:examples`. Breaking an example breaks the build.

## Conventions

- **Run scripts:** prefer `npm run` aliases in `package.json` over ad-hoc commands.
- **Type safety:** `npx tsc --noEmit` must pass before commit. No `any` in committed code without a `// reason:` comment.
- **No comments in code** unless the *why* is non-obvious — well-named identifiers carry the *what*. Doc comments on exported APIs are fine and encouraged.
- **Commits:** Conventional Commits (`feat:`, `fix:`, `docs:`, `refactor:`, `test:`). Author = `ferax564`.

## Parser Notes (Read Before Editing)

The parser is a hand-written recursive descent over a line-based tokenizer. It is intentionally simple — no PEG, no parser combinator library. If you find yourself reaching for one, that's a signal to step back: Noma should stay learnable in an afternoon.

Block fence depth is tracked by counting leading colons. A `:::card` inside a `::grid` is valid; a stray `:::` at top level is a parse error.

Attribute parsing supports:
- `key="quoted value"`
- `key=bareword`
- `key=0.82` (numeric coerced)
- `flag` (boolean true)

Inline content is **not** fully parsed at parser time — it is stored as a string and parsed lazily by renderers. This keeps the AST small and lets different renderers handle inline markup their own way (HTML escapes, LLM strips formatting).

**GitHub-style tables** are detected by a pipe-row + separator-row pair (`| col | col |\n|---|---|`). Per-column alignment comes from the separator (`:---` left, `:---:` center, `---:` right). Inline markdown inside cells is preserved (rendered by the HTML renderer, stripped by LLM). The paragraph buffer also breaks on table starts — without this, an inline table after prose would get pulled into the paragraph.

Cell splitting (parser, fmt, `::table` directive renderer) all share `splitPipeRow` from `src/inline.ts` — pipes inside `` `code spans` `` and `\|` escapes are kept verbatim inside the cell instead of starting a new column. If you touch the table parser, touch the shared util once; don't duplicate the logic.

For tables where pipe-syntax becomes ugly (mixed `✓`/long-prose columns), the `::table` directive accepts pipe rows in its body without a separator row and declares alignment via `align="l,c,r,-"`. `noma fmt <file> [--inplace]` re-aligns existing pipe tables to a single column width and skips fenced code blocks.

**Heading attribute syntax (v0.4).** `HEADING_RE` accepts a trailing `{...}` block. `parseAttrs` reuses the directive grammar. `id="..."` overrides the slug; `aliases="a,b"` (or `"a b"`) becomes `section.aliases`. The frontmatter `aliases: [...]` and the filename slug are attached to the **first H1 section** in `attachChapterAliases` after `foldSections`.

**Book mode scoping (v0.4).** `loadBookChapters` (and `loadBook`, internally) calls `scopeHeadingIds(doc, chapterSlug)` per chapter. Every level ≥ 2 section's id becomes `${chapterSlug}/${original}`, and the original slug is added to `aliases` so legacy `[[risks]]` still resolves. Single-file `parse()` is unchanged — scoping is book-scope-only.

**Math (v0.4).** `::math` is a generic directive (no AST change). `renderer-html` wraps the body in `\[...\]` (default `display`) or `\(...\)` (when `display="inline"`). `resolveMathMode(doc, override)` auto-detects `$$..$$`, `\(`, `\[`, or any `::math` directive, plus respecting `meta.math` and the `--math={katex|none}` CLI flag. KaTeX assets are CDN-injected (`KATEX_VERSION = "0.16.11"`) only when math is present, keeping plain pages zero-CDN.

## Current AST Variants

```
document, section, paragraph, code, list, list_item, quote,
thematic_break, table, directive
```

`directive` is the open-ended one — every typed semantic block (claim, evidence, grid, card, plot, dataset, agent_task, export_button, control, …) flows through `DirectiveNode` with a `name`. Renderers dispatch on `name`. Adding a *new directive name* needs no AST change — just a renderer case (or fall through to the generic `<div class="noma-block-{name}">`).

Adding a *new node variant* (like `table`) is the heavier path: AST union update + parser case + renderer cases + tests.

## Adding a New Block Type — Checklist

1. Add the node interface to `src/ast.ts` and extend the `Node` union.
2. Add a parser case (usually nothing if the directive name is the only differentiator — directives flow through generic `BlockDirective`).
3. Add a render case in **every** renderer (`html`, `llm`, `json`).
4. Add a validation rule if the block has invariants (e.g., `evidence` requires a `for=` attribute pointing to an existing `claim` ID).
5. Add an example to `examples/` or extend an existing one.
6. Update `docs/spec.noma` block-type tables.

## What NOT to Do (Yet)

Per `PLAN.md` § 17 — these are out of scope for the MVP. Don't be tempted:
- visual editor / WYSIWYG
- realtime collaboration
- plugin marketplace
- enterprise auth/permissions
- cloud platform
- complex CSS theming engine
- a Markdown-to-Noma converter (one-way for now, Noma → Markdown only)

## Useful Commands

```bash
npm install
npm run noma -- parse examples/agent-plan.noma
npm run noma -- render examples/agent-plan.noma --to html --out dist/agent-plan.html
npm run noma -- render examples/agent-plan.noma --to llm
npm run noma -- render examples/agent-plan.noma --to noma          # AST → .noma source
npm run noma -- render examples/research-thesis.noma --to html --theme dark
npm run noma -- render examples/book/book.noma.yml --to html       # multi-file book (single page)
npm run noma -- render examples/book/book.noma.yml --to site --out dist/book   # multi-page site
npm run noma -- render examples/research-thesis.noma --math katex  # force KaTeX assets in HTML
npm run noma -- check examples/research-thesis.noma
npm run noma -- check examples/research-thesis.noma --stale-days 30   # tighter window for time-sensitive docs
npm run noma -- check chapters/03.noma --ignore-rule broken-reference  # skip cross-book refs

# block-level patch (rewrites only the addressed block)
npm run noma -- patch examples/thesis.noma --op '{"op":"update_attribute","id":"asml-euv-moat","key":"confidence","value":0.95}' --inplace

# re-align pipe tables in source (idempotent; skips fenced code blocks)
npm run noma -- fmt examples/research-thesis.noma --inplace

# render all examples and docs (HTML + LLM + JSON)
npm run render:examples
npm run render:docs

# generate PDFs for the three demos (requires Puppeteer Chrome installed)
npm run render:pdf:demos

# full site build — examples + docs + book + dark-theme demo + landing + PDFs
npm run build:site
```

## GitHub Pages

`.github/workflows/pages.yml` runs `tsc --noEmit && npm test && npm run build:site` on every push to `main` and publishes `dist/` to <https://ferax564.github.io/noma/>. The workflow installs Chrome via `npx puppeteer browsers install chrome` so PDFs build on the runner.

The landing page at `dist/index.html` comes from the hand-crafted `site/index.html`, **not** from the .noma renderer. Marketing-style layout is the right place to use HTML directly — see `docs/direction.noma` for why escape hatches are allowed for artifacts of this kind. Demo and doc pages remain fully Noma-driven.

## Verification Before Shipping

Before claiming a feature done, run **all** of:
```bash
npx tsc --noEmit
npm test
npm run build:site
```

If any fail, the feature is not done. No partial-success claims. The CI workflow runs the same gates, so a green local run should mean a green deploy.

## Documentation Conventions

- Add user-facing changes to `CHANGELOG.md` under `[Unreleased]`. Promote to a real version on tag.
- When a §23 item ships, move it to PLAN.md §24 (the "shipped" tracker).
- Keep `docs/direction.noma` in lockstep with PLAN.md §23 — they say the same thing in different forms.
- Updates to block syntax must update `docs/spec.noma`. Bump the spec's `version:` frontmatter and the "Compatibility promises (vX.Y)" header in lockstep with `package.json`.
- After every release: `package.json` version, `CHANGELOG.md` heading, `docs/spec.noma` (`version:` + the "Render targets" / "Compatibility promises" headings), `docs/agent-protocol.noma` (`version:`), `README.md` Status paragraph, and `PLAN.md §24.N` must all carry the same vN.

## Versioned Locations (Bump These Together)

```
package.json                    "version"
docs/spec.noma                  frontmatter `version:` + section headings tagged "(vN)"
docs/agent-protocol.noma        frontmatter `version:`
CHANGELOG.md                    new `## [N.N.N] — YYYY-MM-DD` heading
README.md                       Status paragraph (vN summary)
PLAN.md                         new §24.X subsection
```

## Releasing

The published flow (matches what shipped v0.3 and v0.4):

```bash
# 1. ensure clean
npx tsc --noEmit && npm test && npm run build:site

# 2. bump every versioned location (see above), update CHANGELOG, PLAN.md §24

# 3. commit
git add -p   # review explicitly; do not -A
git commit -m "feat: vN.N.N — short headline"

# 4. push, tag, push tag
git push origin main
git tag vN.N.N
git push origin vN.N.N

# 5. release notes from CHANGELOG slice
awk '/^## \[N\.N\.N\]/{f=1;next}/^## \[/{f=0}f' CHANGELOG.md > /tmp/notes.md
gh release create vN.N.N --title "vN.N.N — short headline" --notes-file /tmp/notes.md

# 6. close the issues that shipped
for n in <issue-numbers>; do
  gh issue close $n --comment "Shipped in vN.N.N — <release-url>"
done
```

GitHub Actions tags created by GITHUB_TOKEN cannot trigger other workflows. Local-tag-then-push (step 4) avoids that trap; that's why the flow above does not let CI cut the tag.
