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

# render one demo to HTML / LLM / JSON
npm run noma -- render examples/agent-plan.noma --to html --out dist/agent-plan.html
npm run noma -- render examples/agent-plan.noma --to llm
npm run noma -- render examples/agent-plan.noma --to json

# validate a document
npm run noma -- check examples/research-thesis.noma

# build the full site (examples + docs + landing page + demo PDFs)
npm run build:site
open dist/index.html
```

## Demos

Three artifacts that exercise the full block surface end-to-end. Each renders to HTML, PDF, LLM context, and JSON AST from a single `.noma` source.

| Demo | What it shows | Live |
| ---- | ------------- | ---- |
| **Agent planning artifact** ([source](examples/agent-plan.noma)) | Q3 roadmap decision — options, decision matrix, claims/evidence/risks, agent tasks, copy-as-prompt buttons | [HTML](https://ferax564.github.io/noma/examples/agent-plan.html) · [PDF](https://ferax564.github.io/noma/examples/agent-plan.pdf) · [LLM](https://ferax564.github.io/noma/examples/agent-plan.llm.txt) · [JSON](https://ferax564.github.io/noma/examples/agent-plan.json) |
| **Technical documentation** ([source](examples/tech-doc.noma)) | CLI reference page — tabs, callouts, code blocks, architecture diagram, cross-links | [HTML](https://ferax564.github.io/noma/examples/tech-doc.html) · [PDF](https://ferax564.github.io/noma/examples/tech-doc.pdf) · [LLM](https://ferax564.github.io/noma/examples/tech-doc.llm.txt) · [JSON](https://ferax564.github.io/noma/examples/tech-doc.json) |
| **Investment thesis** ([source](examples/research-thesis.noma)) | Vertical-AI thesis — claims with confidence scores, counterevidence, risks, datasets, plots, quarterly review tasks | [HTML](https://ferax564.github.io/noma/examples/research-thesis.html) · [PDF](https://ferax564.github.io/noma/examples/research-thesis.pdf) · [LLM](https://ferax564.github.io/noma/examples/research-thesis.llm.txt) · [JSON](https://ferax564.github.io/noma/examples/research-thesis.json) |

## What ships today

- `@noma/parser` — hand-written, no parser-combinator dependency. Supports directive blocks, frontmatter, headings, lists, code, quotes, GitHub-style tables, and inline markdown.
- Typed AST in `src/ast.ts` — discriminated union, exhaustively switched everywhere.
- HTML renderer with a small default CSS theme and a print stylesheet. Native rendering for grids, cards, tabs, callouts, claims/evidence/risks, decisions, open questions, datasets, plot placeholders, agent tasks, export buttons, controls, and tables.
- LLM renderer — deterministic plain-text output for context windows.
- JSON renderer — full AST export.
- Validator — duplicate IDs, broken references, plots without data, figures without alt text.
- CLI — `noma parse | render | check | export`.
- Six examples: three new demos (agent-plan, tech-doc, research-thesis) plus the original thesis, landing, and mini-book chapter.
- Five docs (all written in Noma): direction, spec, getting started, agent patch protocol, architecture.
- Hand-crafted HTML landing page (`site/index.html`).
- PDF demo exports via Puppeteer.
- GitHub Pages deployment on every push to `main`.

See [`PLAN.md`](PLAN.md) for the long-term vision, [`docs/direction.noma`](docs/direction.noma) for the positioning, [`docs/spec.noma`](docs/spec.noma) for the format spec, and [`CHANGELOG.md`](CHANGELOG.md) for what changed when.

## Status

This is **v0.1** — small, sharp, working. Out of scope for now: visual editor, realtime collaboration, plugin marketplace, hosted SaaS. The point is to ship a useful core and let the community shape what comes next.

## License

MIT © 2026 ferax564
