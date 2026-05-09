# Noma

> A readable document format for humans and agents.

Noma is a plain-text format for books, docs, research, dashboards, and webpages. It is:

- readable like Markdown
- structured like data
- renderable like HTML
- printable like PDF
- editable by AI agents at the **block level** — not via full-file rewrites

```
.noma  →  typed AST  →  HTML / PDF / JSON / LLM context
```

## Why

Markdown is excellent for prose, weak for grids, cards, claims, plots, citations, and stable agent edits. HTML is the opposite. Noma sits between them: a small directive syntax that compiles to clean semantic HTML, prints cleanly to PDF, and exports a deterministic LLM-friendly form.

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
npm run noma -- render examples/thesis.noma --to html --out dist/thesis.html
npm run noma -- render examples/thesis.noma --to llm
npm run noma -- check  examples/thesis.noma
npm run demo  # renders all examples + produces a PDF
```

## What ships in v0.1

- `@noma/parser` — hand-written, no parser-combinator dependency.
- Typed AST in `src/ast.ts` — discriminated union, exhaustively switched everywhere.
- HTML renderer with a small default CSS theme and a print stylesheet.
- LLM renderer — deterministic plain-text output for context windows.
- JSON renderer — full AST export.
- Validator — duplicate IDs, broken references, plots without data, figures without alt text.
- CLI — `noma parse | render | check | export`.
- 3 working examples: investment thesis, landing page, mini-book chapter.
- 4 docs (written in Noma): spec, getting started, agent patch protocol, architecture.

See [PLAN.md](PLAN.md) for the long-term vision and [docs/spec.noma](docs/spec.noma) for the format specification.

## Status

This is **v0.1** — small, sharp, working. Out of scope for now: visual editor, realtime collaboration, plugin marketplace, hosted SaaS. The point is to ship a useful core and let the community shape what comes next.

## License

MIT © 2026 ferax564
