# Noma — Project Memory for Claude

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
src/                 TypeScript source for parser, AST, renderers, validator, CLI
  ast.ts             Typed AST node definitions (single source of truth)
  parser.ts          .noma → AST
  renderer-html.ts   AST → semantic HTML
  renderer-llm.ts    AST → deterministic LLM context
  renderer-json.ts   AST → JSON
  validator.ts       AST → diagnostics (duplicate IDs, broken refs, etc.)
  cli.ts             `noma parse|render|check|export`
bin/noma.mjs         Node CLI shim
themes/default.css   HTML theme
examples/            Demo .noma files (thesis, landing, mini-book chapter)
docs/                Project docs, all written in .noma
scripts/             Build/render helpers (puppeteer PDF, etc.)
test/                Tests using node:test
PLAN.md              Full product vision (do NOT delete)
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
- Headings (`# H1`, `## H2`) auto-create `section` blocks with stable IDs derived from slugified titles.
- Inline markdown (`**bold**`, `*em*`, `` `code` ``, `[text](url)`) is kept inside paragraph and heading content.

Block IDs are **stable**: agents target them by ID for safe edits. Renaming an ID is a breaking edit.

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
npm run noma -- parse examples/thesis.noma
npm run noma -- render examples/thesis.noma --to html --out dist/thesis.html
npm run noma -- render examples/thesis.noma --to llm
npm run noma -- check examples/thesis.noma
npm run demo                 # full pipeline: HTML + PDF
```

## Verification Before Shipping

Before claiming a feature done, run **all** of:
```bash
npx tsc --noEmit
npm test
npm run render:examples
```

If any fail, the feature is not done. No partial-success claims.
