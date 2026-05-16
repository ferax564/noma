# Noma — Final Plan

## 1. Vision

**Noma** is a plain-text document format for humans and AI agents.

It should be:

- readable like Markdown
- structured like data
- renderable like HTML
- printable like LaTeX/Typst
- scalable like a book system
- editable by humans and agents without breaking the document

Noma is not “another Markdown flavor.”  
It is a **human-readable document operating format** for the AI era.

## 2. Core Thesis

Markdown is excellent for simple vertical documents, but weak for:

- grids
- cards
- tabs
- dashboards
- plots
- rich tables
- books
- citations
- semantic claims
- agent collaboration
- stable block-level editing
- multi-format rendering

HTML can express layout, but it is not pleasant for humans to write or review.

Noma should sit between them:

```txt
Human source  →  Typed AST  →  Web / PDF / Book / Slides / LLM Context
```

The source remains readable.  
The internal structure is machine-operable.  
The output can be beautiful and rich.

## 3. Positioning

### One-liner

> **Noma is a readable document format for humans and agents.**

### Longer version

> Noma lets you write books, documentation, research reports, product specs, dashboards, and webpages in a clean plain-text format that humans can read and agents can safely edit.

### Do not position it as

> A Markdown replacement.

### Position it as

> Markdown-compatible structured documents for humans, agents, books, docs, and websites.

## 4. Name and Extension

Product name:

```txt
Noma
```

Canonical file extension:

```txt
.noma
```

Optional future alias:

```txt
.nom
```

Avoid:

```txt
.no
```

Reason: `.no` is ambiguous, hard to search, and already strongly associated with Norway domains.

## 5. Example Syntax

```noma
# ASML Investment Thesis

::summary
ASML remains one of the most strategically important companies in the semiconductor supply chain.
::

::claim{id="asml-euv-moat" confidence=0.82}
ASML has a durable moat because it is the only supplier of EUV lithography systems at scale.
::

::evidence{for="asml-euv-moat" source="annual-report-2025"}
ASML continues to report strong demand for EUV systems from leading-edge semiconductor manufacturers.
::

::grid{columns=2}
:::card{title="Bull Case"}
EUV demand remains structurally high as chipmakers move to smaller process nodes.
:::

:::card{title="Bear Case"}
Export restrictions and semiconductor cyclicality could pressure growth.
:::
::

::plot{id="revenue-chart" type="line" data="./data/asml_revenue.csv" x="year" y="revenue"}
title: ASML Revenue Over Time
::

::agent_task{id="quarterly-review"}
Every quarter, check whether gross margin, order backlog, China exposure, and EUV demand have materially changed.
::
```

Raw source is still readable.  
A renderer can turn it into a website, PDF, dashboard, book chapter, or LLM context.

## 6. Core Design Principles

### 6.1 Human-readable first

A human should be able to open a `.noma` file in any text editor and understand it.

If the source starts looking like HTML, XML, JSX, or YAML soup, the format is failing.

### 6.2 HTML is an output, not the source

Noma should compile to clean semantic HTML, but humans should not need to write HTML directly.

```txt
Noma source → HTML renderer → website
```

### 6.3 Stable block IDs

Every important block can have a stable ID.

```noma
::claim{id="claim-risk-overlap"}
ETF overlap can make a portfolio less diversified than it appears.
::
```

This allows agents to safely edit specific blocks instead of rewriting entire files.

### 6.4 Typed semantic blocks

Documents should know what their parts mean.

Examples:

```txt
claim
evidence
risk
decision
chart
dataset
task
warning
example
quote
citation
```

This makes the document more useful for:

- agents
- search
- validation
- RAG
- citation checking
- structured export
- knowledge graphs

### 6.5 Layout without HTML

Noma should support layout primitives:

```txt
grid
columns
card
tabs
sidebar
callout
hero
accordion
```

But it should not become CSS.  
The goal is semantic layout, not pixel-perfect page design inside the source file.

### 6.6 Data and plots as first-class citizens

Modern documents need charts, tables, datasets, and computed outputs.

```noma
::dataset{id="sales-q1" src="./data/sales.csv"}
schema:
  date: date
  revenue: money
  region: string
::

::plot{id="sales-plot" dataset="sales-q1" type="line"}
x: date
y: revenue
group: region
title: Revenue by Region
::
```

### 6.7 Agent collaboration should be native

Agents should be able to:

- review documents
- update specific blocks
- add evidence
- flag stale claims
- check broken links
- suggest edits
- validate structure
- generate summaries
- export LLM context

But they should do this through controlled block-level operations, not blind full-file rewrites.

## 7. Core Block Types

### 7.1 Basic document blocks

```txt
doc
section
paragraph
list
quote
code
math
table
figure
footnote
citation
bibliography
```

### 7.2 Layout blocks

```txt
grid
columns
card
callout
tabs
accordion
sidebar
hero
pagebreak
```

### 7.3 Technical documentation blocks

```txt
api
endpoint
parameter
example
warning
note
changelog
decision
adr
```

### 7.4 Research and reasoning blocks

```txt
claim
evidence
counterevidence
assumption
risk
hypothesis
experiment
result
limitation
open_question
```

### 7.5 Data and computation blocks

```txt
dataset
query
plot
metric
code_cell
output
```

### 7.6 Agent collaboration blocks

```txt
agent_task
instruction
review
comment
todo
change_request
provenance
confidence
```

## 8. Book-Scale Structure

Noma must scale beyond single files.

A book project could look like this:

```txt
my-book/
  book.noma.yml
  chapters/
    01-introduction.noma
    02-concepts.noma
    03-method.noma
    04-results.noma
  assets/
    concept-map.svg
  data/
    experiments.csv
  references.bib
```

Manifest example:

```yaml
title: "Agentic Documents"
author: "ferax564"

outputs:
  html:
    theme: docs
  pdf:
    engine: typst
  epub: true
  llm: true

chapters:
  - chapters/01-introduction.noma
  - chapters/02-concepts.noma
  - chapters/03-method.noma
  - chapters/04-results.noma
```

Target outputs:

```bash
noma render book.noma.yml --to html
noma render book.noma.yml --to pdf
noma render book.noma.yml --to epub
noma render book.noma.yml --to llm
```

## 9. Webpage Example

Noma should be powerful enough to create webpage-like documents without writing HTML.

```noma
---
title: HoldNav
layout: landing
---

::hero
# Portfolio intelligence for self-directed investors

Track what you own, why you own it, and when your thesis breaks.

::button{href="/signup"}
Start Beta
::
::

::grid{columns=3}
:::card{icon="layers"}
## True Exposure

Look through ETFs and funds to understand real underlying holdings.
:::

:::card{icon="brain"}
## Thesis Vault

Capture bull cases, bear cases, catalysts, and risks.
:::

:::card{icon="chart"}
## Analytics

Run Monte Carlo, factor analysis, and scenario replay.
:::
::

::plot{type="line" data="./data/demo_returns.csv" x="date" y="value"}
title: Portfolio Growth Simulation
::
```

This should render to a proper landing page while remaining readable in source form.

## 10. Agent Patch Protocol

Agents should not edit documents by rewriting the whole file.

They should propose structured operations.

Example:

```json
{
  "op": "replace_block",
  "id": "asml-euv-moat",
  "content": "ASML has a durable moat because EUV lithography requires unmatched optical, mechanical, and supply-chain capabilities."
}
```

Example:

```json
{
  "op": "add_child",
  "parent": "risk-section",
  "block": {
    "type": "risk",
    "id": "risk-china-restrictions",
    "severity": "high",
    "content": "Further export restrictions could reduce ASML's China revenue."
  }
}
```

This enables safe collaboration between:

- humans
- AI agents
- editors
- CI pipelines
- documentation systems
- research platforms

## 11. Validation

Noma should include a validator from day one.

Command:

```bash
noma check thesis.noma
```

Validation should detect:

- duplicate IDs
- broken internal references
- broken external links
- missing citation targets
- invalid block nesting
- missing chart datasets
- missing figure alt text
- claims without evidence, if required by schema
- stale review dates
- invalid frontmatter
- invalid book manifests
- invalid plot configuration

This is one of the biggest differentiators versus Markdown.

## 12. Rendering Targets

Initial targets:

```txt
html
pdf
llm
json
markdown
```

Later targets:

```txt
epub
slides
docx
confluence
notion
static_site
dashboard
```

CLI examples:

```bash
noma render thesis.noma --to html
noma render thesis.noma --to pdf
noma render thesis.noma --to llm
noma render thesis.noma --to json
noma render docs/ --to website
```

## 13. LLM Context Export

Noma should have a deterministic LLM export mode.

Example source:

```noma
::claim{id="claim-1" confidence=0.75}
Portfolio concentration risk can be hidden by ETF overlap.
::

::evidence{for="claim-1" source="holdings-analysis"}
The portfolio has 23% effective exposure to NVIDIA after ETF look-through.
::
```

LLM export:

```txt
[CLAIM id=claim-1 confidence=0.75]
Portfolio concentration risk can be hidden by ETF overlap.

[EVIDENCE for=claim-1 source=holdings-analysis]
The portfolio has 23% effective exposure to NVIDIA after ETF look-through.
```

This is better than feeding raw HTML and more structured than plain Markdown.

## 14. Technical Architecture

### 14.1 Language

Start with TypeScript.

Reasons:

- good for parser tooling
- good for VS Code extension
- good for web renderer
- good for npm adoption
- good for static site generation
- easy integration with AI/dev tooling

Later, consider Rust for performance-critical parsing.

### 14.2 Core packages

```txt
@ferax564/noma-parser
@ferax564/noma-ast
@ferax564/noma-renderer-html
@ferax564/noma-renderer-llm
@ferax564/noma-renderer-pdf
@ferax564/noma-validator
@ferax564/noma-cli
@ferax564/noma-vscode
```

### 14.3 CLI

```bash
noma init
noma parse file.noma
noma check file.noma
noma render file.noma --to html
noma render file.noma --to pdf
noma render file.noma --to llm
noma export file.noma --to json
```

### 14.4 Internal AST

Example:

```json
{
  "type": "document",
  "meta": {
    "title": "ASML Thesis"
  },
  "children": [
    {
      "type": "section",
      "level": 1,
      "id": "asml-thesis",
      "title": "ASML Investment Thesis",
      "children": [
        {
          "type": "claim",
          "id": "asml-euv-moat",
          "confidence": 0.82,
          "content": "ASML has a durable moat because it is the only supplier of EUV lithography systems at scale."
        }
      ]
    }
  ]
}
```

## 15. Open Source Strategy

The format must be open source.

Open-source:

```txt
spec
parser
AST
CLI
validator
basic renderers
VS Code syntax highlighting
examples
conformance tests
```

Commercialize later:

```txt
hosted publishing
collaboration platform
team permissions
agent review workflows
enterprise governance
premium themes
analytics
document intelligence
domain-specific products
```

Reason:

A document format needs trust.  
People will not adopt a closed source-of-truth format for books, documentation, research, or company knowledge.

## 16. Community Strategy

Launch the open-source project early.

Target communities:

```txt
technical writers
Markdown users
AsciiDoc users
Quarto users
Typst users
Obsidian users
AI agent builders
open-source maintainers
researchers
data scientists
documentation teams
```

Places to gather feedback:

```txt
GitHub
Hacker News
Reddit r/programming
Reddit r/Markdown
Reddit r/technicalwriting
Reddit r/LocalLLaMA
Reddit r/AI_Agents
Reddit r/ObsidianMD
Write the Docs
Typst community
Quarto community
```

Ask for feedback on:

- syntax readability
- block naming
- book workflows
- renderer expectations
- agent editing model
- plugin API
- migration from Markdown
- comparison with AsciiDoc, Quarto, MDX, MyST, and Typst

## 17. MVP Scope

The first MVP should be small and sharp.

### Must have

```txt
.noma parser
typed AST
CLI
HTML renderer
LLM renderer
JSON export
basic validator
10–15 block types
example docs
GitHub repo
VS Code highlighting
```

### Initial block types

```txt
section
callout
grid
card
figure
table
claim
evidence
risk
plot
dataset
agent_task
todo
citation
```

### Do not build yet

```txt
full visual editor
Notion competitor
complex CSS system
real-time collaboration
huge plugin marketplace
enterprise permissions
cloud platform
```

## 18. Four-Week Prototype Plan

### Week 1 — Format and Parser

Deliver:

- formal syntax draft
- parser
- AST output
- frontmatter support
- directive block support
- inline reference support
- basic conformance tests

Commands:

```bash
noma parse example.noma
noma export example.noma --to json
```

### Week 2 — HTML and LLM Renderers

Deliver:

- clean HTML renderer
- basic CSS theme
- LLM context renderer
- support for cards, grids, callouts, claims, evidence, datasets, and plots
- examples comparing Markdown, HTML, and Noma

Commands:

```bash
noma render example.noma --to html
noma render example.noma --to llm
```

### Week 3 — Validation and Book Structure

Deliver:

- `noma check`
- duplicate ID detection
- broken reference detection
- missing dataset detection
- book manifest support
- multi-file project rendering
- first PDF experiment via Typst or another engine

Commands:

```bash
noma check thesis.noma
noma render book.noma.yml --to html
```

### Week 4 — Real Demo and Open Source Launch

Deliver three strong demos:

```txt
1. Investment thesis document
2. Technical documentation site
3. Mini book chapter with charts and citations
```

Also deliver:

```txt
README
spec draft
examples
comparison table
VS Code syntax highlighting
GitHub issues templates
contribution guide
```

Launch message:

> Noma is a readable document format for humans and agents. It lets you write structured documents, books, docs, reports, and webpages in plain text, then render them to HTML, PDF, JSON, or LLM context.

## 19. First Demo Ideas

### Demo 1 — HoldNav Thesis Vault

A structured investment thesis with:

- claims
- evidence
- risks
- catalysts
- charts
- quarterly review agent task
- LLM export

### Demo 2 — Engineering Architecture Doc

A software design document with:

- architecture diagram
- decisions
- API blocks
- examples
- risks
- changelog
- agent review tasks

### Demo 3 — Mini Book

A short technical book with:

- chapters
- citations
- figures
- tables
- plots
- PDF output
- EPUB output later

## 20. Business Model

Open-source core. Paid workflow.

### Free/open

```txt
format
parser
CLI
validator
basic renderers
basic themes
VS Code extension
```

### Paid later

```txt
hosted publishing
team collaboration
agent review automation
document intelligence
private workspaces
enterprise governance
premium themes
advanced exports
analytics
version review UI
```

### Strategic wedge

Start with:

> Agent-native technical and research documents.

Then expand to:

```txt
books
websites
documentation portals
research reports
investment theses
technical specs
enterprise knowledge bases
```

## 21. Why Noma Can Win

Noma can win if it is:

- easier to read than HTML
- more structured than Markdown
- less web-specific than MDX
- friendlier than AsciiDoc
- more agent-native than Quarto
- more document-general than Jupyter
- more portable than Notion or Confluence
- more semantic than plain text
- more renderable than Markdown

The killer idea:

> Every document is simultaneously human-readable source, structured data, renderable publication, and agent-editable workspace.

## 22. Final Recommendation

Build Noma as an open-source format first.

Do not start with a SaaS app.  
Do not start with a complex editor.  
Do not over-design the syntax.

Start with:

```txt
.noma files
parser
AST
CLI
HTML renderer
LLM renderer
validator
examples
```

Then dogfood it inside HoldNav and technical documentation workflows.

The first milestone should be:

> A `.noma` file that a human enjoys reading, an agent can safely edit, and a renderer can turn into a beautiful webpage, PDF, book, or LLM context.

## 23. Revised Final Direction (post-MVP refinement)

This section refines and supersedes the earlier positioning where they conflict.
Sections 1–22 still hold; this section sharpens the *why* and locks the *what*.

### 23.1 Core Reframe

Noma should not be positioned as "better Markdown" or "HTML replacement."

The stronger thesis is:

> **Noma is readable source for beautiful agent artifacts.**

Markdown is excellent as lightweight text, but too weak for rich artifacts.
HTML is excellent as a rendering target, but too noisy and unpleasant as long-term source.

Noma is the missing middle:

```txt
Readable source → Typed document AST → Beautiful HTML / PDF / Book / Slides / LLM Context
```

### 23.2 The Three-Layer Model

Noma explicitly separates three concerns that Markdown and HTML often mix.

**1. Source layer** — what humans and agents edit. Readable plain text, clean Git diffs,
stable over time, easy to patch by agents at the block level, structured enough for
validation, expressive enough for layout, data, charts, reasoning.

**2. Artifact layer** — what humans consume. Primary target is **standalone HTML**:
a single shareable file with visual hierarchy, grids, cards, tabs, tables, SVG
diagrams, charts, copy buttons, mobile-responsive layout, collapsible sections.
HTML is not the enemy. Hand-authored HTML *as source of truth* is.

**3. Agent layer** — what AI systems use. Deterministic LLM context export — more
structured than Markdown, less noisy than HTML.

### 23.3 Final Positioning

Primary:

> **Noma is a plain-text format for creating beautiful, structured documents
> with humans and AI agents.**

Sharper:

> **Write in Noma. Render to HTML. Collaborate with agents.**

Or:

> **Readable source. Beautiful artifacts. Agent-safe edits.**

### 23.4 The Central Design Test

> A `.noma` file should be **readable enough to edit manually**, **structured
> enough for agents to modify safely**, and **rich enough to render into an
> artifact someone actually wants to read**.

Every feature must pass three questions:

1. Can a human understand this in raw text?
2. Can an agent edit this safely without destroying the document?
3. Can it render into an artifact people actually want to read?

If the answer is not yes to all three, the feature does not belong in core Noma.

### 23.5 Why Noma Beats Markdown

| Need                   | Markdown                | Noma                 |
| ---------------------- | ----------------------: | -------------------: |
| Plain-text readability | Excellent               | Excellent            |
| Git diffs              | Excellent               | Excellent            |
| Grids/cards/tabs       | Poor                    | Native               |
| Charts/plots           | Poor                    | Native               |
| Semantic blocks        | Weak                    | Native               |
| Claims/evidence/risks  | Ad hoc                  | Native               |
| Agent patching         | Weak                    | Native block IDs     |
| Validation             | Weak                    | Built-in             |
| Book scale             | Possible but fragmented | Native project model |
| Beautiful web output   | Needs tooling           | Built-in             |
| LLM context export     | Basic                   | Structured           |

### 23.6 Why Noma Beats Raw HTML

| Need                      | Raw HTML   | Noma                   |
| ------------------------- | ---------: | ---------------------: |
| Browser rendering         | Excellent  | Excellent via renderer |
| Human source readability  | Poor       | Excellent              |
| Long-term maintainability | Poor       | Strong                 |
| Git diffs                 | Noisy      | Clean                  |
| Book authoring            | Awkward    | Native                 |
| PDF/EPUB export           | Awkward    | Native targets         |
| Semantic reasoning blocks | Ad hoc     | Native                 |
| Agent-safe edits          | Fragile    | Block-level operations |
| LLM export                | Noisy      | Clean                  |
| Styling consistency       | Manual CSS | Themes                 |
| Validation                | Custom     | Built-in               |
| Reusable components       | Possible   | Declarative            |

### 23.7 Required v1 Capabilities (Five Pillars)

**1. Markdown-compatible prose** — normal `# headings`, `**bold**`, lists, links,
fenced code work without ceremony. Reduces adoption friction.

**2. Directive blocks** — `::type{key="value"} ... ::` as the universal extension
mechanism. Examples: `callout`, `claim`, `evidence`, `decision`.

**3. Layout blocks** — `grid`, `columns`, `card`, `tabs`, `accordion`, `sidebar`,
`hero`, `section`, `callout`. Semantic layout, not CSS.

**4. Data + visualization blocks** — `dataset`, `plot`, `metric`, `table`. HTML
renderer turns these interactive; PDF renders static; LLM renderer summarizes
data + intent.

**5. Agent collaboration blocks** — `agent_task`, `instruction`, `review`, `todo`,
`decision`, `claim`, `evidence`, `risk`, `assumption`, `open_question`,
`change_request`. Agent-native from day one.

### 23.8 Artifact-First Rendering

Noma renders **artifacts**, not just documents. A single `.noma` source can become:

- a report, spec, research memo, dashboard, landing page, prototype, code review
  explainer, book chapter, project plan, decision record, custom mini-tool.

Command:

```bash
noma artifact pr-review.noma --standalone
```

Output: a single `.html` file that opens locally or uploads anywhere.

### 23.9 Interactive Artifact Blocks (later)

Declarative interaction so agents can produce useful temporary tools without
becoming a full app framework:

```noma
::control{id="growth-rate" type="slider" min=0 max=20 default=8}
label: Growth rate
unit: %
::

::computed_plot{id="projection" depends_on="growth-rate" type="line"}
formula: revenue * (1 + growth-rate / 100) ^ year
title: Revenue Projection
::
```

### 23.10 Copy/Export Buttons as First-Class

Two-way collaboration: HTML artifacts can feed back into the agent.

```noma
::export_button{format="prompt" target="review-notes"}
Label: Copy as prompt for agent
::

::export_button{format="markdown" target="summary"}
Label: Copy summary
::
```

### 23.11 Agent Patch Protocol — Operations

Launch operation set:

```txt
replace_block
replace_body
update_heading
add_block
delete_block
update_attribute
rename_id
```

This set covers whole semantic-block replacement, body-only edits, heading
renames that preserve stable IDs, insertion, deletion, scalar attribute updates,
and canonical-ID renames with reference retargeting. Candidate future ops
(`move_block`, `add_comment`, `resolve_comment`, table-cell edits) remain out of
core until real design-partner documents prove the smaller set is insufficient.

### 23.12 Validation as Differentiator

Beyond §11, the validator should also catch: missing alt text, claims without
evidence, risks without owner, decisions without status, agent tasks without
scope, stale citations.

### 23.13 Themes Instead of Inline Styling

Source must avoid visual clutter. Bad:

```noma
::card{padding="24px" border="1px solid #ddd" shadow="large" radius="12px"}
::
```

Good:

```noma
::card{variant="important"}
::
```

Themes decide how `important` renders. Preserves readability; enforces consistency.

### 23.14 Escape Hatches

Allowed but not default. `::html`, `::svg`, `::script{runtime="browser"}`. Rules:

- allowed only in artifact mode
- excluded or summarized in LLM mode
- flagged by validator if unsafe
- disabled by default in trusted publishing contexts

### 23.15 Updated MVP Demos

Three demos prove Noma beats Markdown *and* HTML for the same workflow. All three
should ship as `.noma` source + rendered HTML + rendered LLM context, side by side.

**Demo 1 — Agent Planning Artifact**
summary, decision matrix, grid of options, risks, timeline, agent tasks,
copy-as-prompt button.

**Demo 2 — Technical Documentation Page**
API reference, architecture diagram, code snippets, warnings, examples, tabs,
cross-links.

**Demo 3 — Research / Investment Thesis**
claims, evidence, risks, charts, tables, citations, quarterly review task, LLM export.

### 23.16 Updated Four-Week Plan

Replaces §18 where they conflict.

**Week 1 — Source and AST.** parser, directive blocks, frontmatter, typed AST,
block IDs, JSON export, basic validation.

**Week 2 — Artifact Renderer.** standalone HTML, default theme, cards/grids/tabs/
callouts/tables/code blocks, basic charts, mobile responsive.

**Week 3 — Agent Renderer + Patch Protocol.** LLM context renderer, patch schema,
`replace_block` / `add_block` / `update_attribute`, claim/evidence/risk rendering,
copy-as-prompt HTML button.

**Week 4 — Public Demo + OSS Release.** GitHub repo, README, spec draft,
comparison page, three demo artifacts, VS Code highlighting, examples gallery,
contribution guide.

Launch line:

> Noma is readable source for beautiful agent artifacts. Write structured
> documents in plain text, render them to HTML/PDF/LLM context, and let agents
> edit them safely.

### 23.17 Final Product Definition

> **Noma is a plain-text source format for building beautiful, structured,
> agent-editable documents. It keeps the source readable like Markdown, renders
> artifacts as richly as HTML, and gives agents a stable structure for safe
> collaboration.**

## 24. Shipped Tracker

This section closes the loop between the plan and the code. As §23 items
ship, they move here with a one-line note on what landed. Use `git log` for
commits; this section is for the bird's-eye picture.

### 24.1 v0.1.0 — initial release (2026-05-09)

Covers §17 "Must have" entirely:

- ✅ `.noma` parser, typed AST, CLI, HTML / LLM / JSON renderers.
- ✅ Validator (duplicate IDs, broken refs, plot/figure rules).
- ✅ ~15 working block types (claim/evidence/risk/decision/grid/card/
  callout/plot/dataset/agent_task/figure/citation/hero/button/quote).
- ✅ Three example documents (thesis, landing, book chapter).
- ✅ Four docs in Noma (spec, getting started, agent protocol, architecture).
- ✅ Puppeteer-based PDF script for one document.

### 24.2 Post-MVP refinement (2026-05-09)

The §23 revised direction landed alongside three production-grade demos
that prove the three-layer model end-to-end:

- ✅ §23.1–23.3 — three-layer model and revised positioning written down
  in `docs/direction.noma` and PLAN.md §23.
- ✅ §23.7 pillar 2 — `::export_button{format=...}` directive renders as
  a real `<button>` (format-keyed colors). Pillar 4 — first interactive
  block with `::control{type=slider ...}`.
- ✅ §23.8 — artifact-first rendering: three demos (`agent-plan`,
  `tech-doc`, `research-thesis`) shipped as `.noma` source plus rendered
  HTML, PDF, LLM, JSON.
- ✅ §23.10 — copy/export buttons land in the agent-plan and
  research-thesis demos.
- ✅ §23.15 — three required demos all ship, all render to all four
  targets, all link from the landing page.
- ✅ Markdown-compatible prose pillar (§23.7 #1) — extended to
  GitHub-style tables (`TableNode` AST variant; HTML `<table>` with
  per-column alignment; LLM keeps pipe format).
- ✅ Public landing page live at <https://ferax564.github.io/noma/>,
  deployed by GitHub Actions on every push to `main`.

### 24.3 v0.2.0 — agent-editable artifacts (2026-05-09)

The format crossed the line from "renderable plain text" to "block-level
agent-editable document operating system". Six §23 items shipped:

- ✅ §23.11 — `noma patch` CLI with five ops (`replace_block`,
  `add_block`, `delete_block`, `update_attribute`, `rename_id`).
  `rename_id` retargets `for=`, `parent=`, and `[[wikilink]]`
  references. Backed by a new AST → `.noma` source printer; every
  example/doc roundtrips losslessly.
- ✅ §23.12 — five new default validator rules:
  `claim-without-evidence` (promoted from optional),
  `risk-without-owner`, `decision-without-status`,
  `agent-task-without-scope`, `stale-citation`. Per-block opt-out via
  the `noverify` flag attribute.
- ✅ §23.13 — `{variant="..."}` lands as `data-variant` on cards,
  callouts, and research blocks. Alternate `themes/dark.css` ships
  with the CLI flag `--theme dark`.
- ✅ §23.14 — `::html` / `::svg` / `::script{runtime="browser"}`
  escape hatches. LLM renderer always strips them; validator warns
  on every untrusted use; `--no-unsafe` blocks them globally.
- ✅ Real `::plot` rendering — inline-data line and bar charts as
  self-contained SVG. Demos (thesis revenue, vertical-AI funding) now
  show real numbers.
- ✅ §8 — book manifest (`book.noma.yml`) + multi-file rendering.
  CLI auto-detects manifest extension; chapters concatenate into one
  `DocumentNode` so every renderer works on books unchanged. Demo
  book at `examples/book/` (3 chapters).

### 24.4 v0.3.0 — first real-world authoring response (2026-05-10)

Issue #1 surfaced eight friction items and two design questions from a
non-trivial weekly recap document. All ten shipped:

- ✅ `::table` directive — body is plain pipe rows, no separator-row
  required, alignment via `align="l,c,r,-"`, optional `header` flag.
  For tables where pipe-syntax becomes ugly under mixed cell widths.
- ✅ `noma fmt <file>` — re-aligns GitHub-style pipe tables in source
  to a single column width, leaves everything else byte-identical
  (skips fenced code blocks). Respects pipes inside `` `code` `` and
  `\|` escapes — same rule applied to the parser, fixing a latent
  cell-truncation bug.
- ✅ `::plot{dataset, column, xcolumn}` linkage — plots resolve their
  series against sibling `::dataset` blocks at render time. Validator:
  `plot-unknown-dataset`, `plot-unknown-column`. Demo updated.
- ✅ `::state_change{block, attribute, from, to, reason, at}` — typed
  delta directive for weekly/quarterly recap docs. HTML strike-through
  → bold; LLM keeps structured fields; included in research profile.
  Foundation for a future `noma diff a.noma b.noma`.
- ✅ Profile frontmatter (`research | technical | minimal`) — opt-in
  contract with downstream tools. Validator warns on out-of-profile
  directives. Pure metadata; no AST change.
- ✅ Citation staleness override — `stale_citation_days` in
  frontmatter, `stale_after_days=N` per citation. CLI `--stale-days`
  finally wired (was previously documented but not implemented).
- ✅ Wikilink validation — `[[id]]` references in paragraphs, quotes,
  list items, headings, table cells, and directive bodies are tracked
  by the validator. Resolves across all chapters in a loaded book.
  Wikilinks inside `` `code spans` `` ignored.
- ✅ `plot-mixed-delimiters` warning when `data` and `xlabels` use
  different separators. Commas canonical; existing demos normalized.
- ✅ Spec doc — explicit attribute-grammar rule (attrs are plain text),
  dataset linkage, profiles, staleness precedence, `::table`, `noma
  fmt`. Agent-protocol doc — choose-your-op decision tree. Direction
  doc — core directives vs community packs stance with proposed
  `pack::name` namespacing convention and pack contract.

### 24.5 v0.4.0 — book authoring + math (2026-05-10)

Issues #2 through #8 came out of a 30-chapter strategy reference dogfood
of the format. All seven shipped:

- ✅ Multi-page site renderer (`--to site`) — book manifests render to
  one HTML page per chapter plus `index.html`. Cross-chapter `[[id]]`
  wikilinks rewrite to `<other-chapter>.html#id` URLs; same-page refs
  stay as `#id`. Per-page top nav lists every chapter and links back
  to the index. Closes the per-chapter rendering item from §24.5 (old).
- ✅ Math rendering — new `::math` directive plus inline `$..$`,
  `$$..$$`, `\(..\)`, `\[..\]` delimiters. The HTML renderer auto-injects
  KaTeX from CDN when math is detected. Force with `--math=katex|none`.
  LLM passes LaTeX source through verbatim. `math` is in every profile.
- ✅ Scoped heading IDs in book mode — every level ≥ 2 heading is
  path-prefixed by its chapter root (`risk-premia-3/risks` instead of
  the bare `risks`). Original slug stays as an alias on the same node
  so `[[risks]]` still resolves to the first occurrence. Eliminates
  the `duplicate-id` floods 30-chapter books used to flood validators
  with.
- ✅ Heading attribute syntax (`## Title {id="..." aliases="a,b"}`)
  for pinning a stable wikilink target without restructuring the title.
- ✅ Chapter aliases — filename slug auto-registers as a chapter root
  alias; frontmatter `aliases:` list registers extras. Wikilink
  resolution order: explicit id → auto-slug → frontmatter aliases →
  filename slug.
- ✅ Composable profiles — `profiles: [research, technical]` opts in
  to the union of multiple profiles. Legacy `profile: <single>` form
  still works. `::table` and `::math` now ship in every profile (the
  most common false-positive sources before).
- ✅ `--ignore-rule <name>` flag on `noma check` and `noma render`.
  Repeatable; drops matching diagnostics. Unknown rule names produce
  an `info` note, not a failure.
- ✅ `prepare` script + `dist/` in published `files`. `npm i -g
  github:ferax564/noma` now builds before symlinking, fixing the
  dangling-symlink failure on direct-from-GitHub installs.

### 24.6 v0.4.1 — site index polish (2026-05-10)

Closes issue #9 — papercut surfaced after v0.4.0 went out the door.

- ✅ Card descriptions on the auto-generated `index.html` for `--to site`
  now run through the inline parser. `**bold**` → `<strong>`, `` `code` ``
  → `<code>`, `*em*` → `<em>`, `[label](url)` → `<a>`. Wikilinks resolve
  to the owning chapter (`other.html#id`) when the target is known and
  fall back to bare label text when it isn't — no more literal `[[...]]`
  in card output.
- ✅ Description truncation now honours sentence boundaries (`.`, `!`,
  `?` followed by whitespace) instead of naive character count. Ugly
  mid-sentence cutoffs gone.
- ✅ The index page emits the same `nav.noma-site-nav` element every
  chapter page does. Post-processing layers that target the nav (grouped
  TOC overlays, theme switchers) no longer need an index special-case.
  The home crumb is marked `noma-nav-current` on the index itself.

### 24.7 v0.5.0 — review fixes + interactive directives (2026-05-10)

Closes the executive-read review (review fixes #1–#4) plus issues #10,
#11, #12. Theme: tightening the human-and-agent collaboration contract
and shipping the artifacts that turn `.noma` into a richer document
substrate without breaking the AST.

- ✅ Source-preserving `patchSource(source, ops)` (review fix #1).
  Parser now records `endLine` per node; patches rewrite only the
  targeted line range. Frontmatter quoting, sibling blocks, blank-line
  padding, and attribute order on unchanged lines all survive
  byte-for-byte. Backs the "unrelated 95% byte-identical" promise the
  protocol doc has been making since v0.2.
- ✅ `renderNoma` emits explicit heading attributes (review fix #2).
  Sections with non-slug `id=` or aliases now print as
  `## Title {id="..." aliases="a,b"}`. Stable IDs survive the parse →
  render → parse cycle.
- ✅ Wikilink grammar accepts `/`, `.`, `:` in IDs (review fix #3).
  Book-scoped IDs (`chapter/risks`), dotted metric IDs, namespaced
  IDs all resolve. Fixed uniformly across `inline.ts`, `patch.ts`,
  `validator.ts`.
- ✅ `@ferax564/noma-cli` programmatic API (review fix #4). Added `main`,
  `types`, `exports` so `import { parse, patchSource, renderHtml }
  from "@ferax564/noma-cli"` works in any Node 20+ project. Dropped `|| true`
  from `prepare` so broken builds fail loud.
- ✅ `::diagram{kind="mermaid|graphviz|drawio"}` directive (issue #10).
  Body holds source verbatim. HTML auto-injects the matching CDN only
  when the doc actually uses that kind, keeping plain pages CDN-free.
- ✅ `::plotly` directive (issue #11). Body is a JSON spec
  (`{ data, layout, config }`). HTML hydrates via Plotly.js; LLM keeps
  the JSON intact.
- ✅ `::dataset{src="data.csv"}` external sources (issue #12). New
  `src/loader.ts` inlines the file into `body` after parse, inferring
  format (csv/tsv/json/yaml). Renderers stay pure. Plots can reference
  CSV/JSON datasets the same way they reference inline ones.

### 24.8 v0.5.1 — VS Code grammar + stale-memo demo (2026-05-10)

Closes the two items deferred from review fixes #5 and #6.

- ✅ **VS Code language extension** — `tools/vscode-noma/` ships a
  TextMate grammar (`source.noma`) and `language-configuration.json`
  with directive folding, attribute highlighting (`id=`, `for=`,
  `parent=`, `block=`, `dataset=`, `column=`, `xcolumn=`, `src=`,
  `href=`, `aliases=`), wikilinks, math (`$..$`, `$$..$$`, `\(..\)`,
  `::math`), embedded YAML in frontmatter, and embedded language
  scopes for `::plotly` (JSON), `::diagram{kind="mermaid"}` (Mermaid),
  `::diagram{kind="graphviz"}` (DOT), `::math` (LaTeX). Escape-hatch
  blocks (`::html`, `::svg`, `::script`) emit `invalid.illegal.*`
  scopes so themes can warn on them. Install: `vsce package` →
  `code --install-extension`. Not yet on the marketplace; published
  separately under `@ferax564/noma-language` once the grammar
  stabilises against real-world `.noma` files.
- ✅ **Killer demo: agent updates a stale research memo** —
  `examples/agent-stale-memo/` plus `scripts/agent-stale-memo.ts`.
  The memo declares `stale_citation_days: 60` and carries two
  citations whose `accessed=` dates are outside the window. Five
  patch operations (two `update_attribute` on `accessed=`, one on
  `confidence=`, one on `severity=`, one `add_block` for fresh
  evidence) refresh the memo end-to-end. The runner validates
  before, applies via `patchSource`, validates after (clean), and
  writes a narrated `dist/examples/agent-stale-memo/trace.html`.
  Output: ~89% of source lines preserved byte-for-byte; the only
  changed lines are the four edited attribute lines plus the new
  evidence block. `npm run demo:stale-memo`. Wired into `build:site`.

### 24.9 Still ahead

- ✅ Shared `_assets/theme.css` for `--to site` (currently inlines CSS
  per page; functional but doubles output size on large books).
- ✅ Trusted-publishing context (auto-set `--no-unsafe` based on
  manifest config).
- ✅ `noma diff a.noma b.noma` — emit `::state_change` blocks for
  attribute drift between two versions of the same document.
- ✅ prep ready / ⏳ live publish pending maintainer step — Publish `noma-language` to the VS Code marketplace once the
  grammar has soaked against external `.noma` files (currently
  ships in-repo only).

### §24.10 — v0.6.0 (Phase 1: Agent Protocol v1.0)

Shipped on 2026-05-11.

- v1.0 RFC: `docs/spec-agent-protocol-v1.noma` (sections 1–6 normative, Annexes A/B/C provisional/conformance)
- Reference impl alignment: v1.0 transcript writer, `FrontmatterNode` + `DocumentNode` spans, parser fence-suppression fix (closes ⏳ from §24.9), `PatchError` taxonomy, validator `duplicate-id` rule
- `noma verify` CLI + 14-fixture minimum corpus (`examples/conformance/`)
- Legacy `docs/agent-protocol.noma` superseded; cross-refs updated in `docs/spec.noma`
- `@ferax564/noma-mcp-server` bumped to v0.6.0 (matching CLI); transcript writer updated to v1.0 protocol shape

### §24.11 — v0.7.0 (papercut bundle)

Shipped on 2026-05-12. Closes three ⏳ items from §24.9; VS Code marketplace is prep-only in this release (live publish is a maintainer-run follow-up).

- `noma diff <before.noma> <after.noma> --at <date>` — attribute-drift detector emitting `::state_change` directives. v0.7 scope is attribute-value changes only; add/delete and structural diffs tracked for v0.7.1. Programmatic API exported as `diffDocs` from `@ferax564/noma-cli`. `--at` is required so output is deterministic.
- `book.yml` `trusted_publishing: true` — manifest-level implicit `--no-unsafe` for both single-page and `--to site` renders. No CLI override (security posture is final once the manifest sets it).
- Shared `_assets/theme.css` for `--to site` — `renderHtml` gained a `stylesheetHref` option; the site renderer writes theme once and points every page at it. Per-page output drops ~15 KB on 30-chapter books.
- `noma-language` v0.2.0 — marketplace publish prep (metadata, README, .vscodeignore, extension-local CHANGELOG, LICENSE). Live marketplace listing follows when the maintainer runs `vsce publish`.

### §24.12 — v0.7.1 (nested-slug stylesheet fix)

Shipped on 2026-05-12. Single-bug patch caught by Codex review of v0.7.0.

- `--to site` no longer emits a root-relative stylesheet `href` from chapter pages that sit in subdirectories (level-1 section with explicit `id="foo/bar"`). The renderer now computes depth-aware `../` prefixes per chapter; the index page stays root-relative. Regression test in `test/renderer-site-assets.test.ts`. Existing demo books used plain filename slugs and were unaffected. Nav links and cross-chapter wikilinks from nested-slug pages have a pre-existing equivalent issue (predates v0.7), tracked for v0.8.

### §24.13 — v0.8.0 (memory profile + nested-slug links)

Shipped on 2026-05-12. Bundles the agent-memory work that landed on `main` after v0.7.1 with the residual nested-slug link bug called out in §24.12.

- **`memory` validator profile + `::memory` / `::memory_index` directives** — six rules enforce canonical `id`, `type ∈ {user, feedback, project, reference}`, `confidence ∈ [0, 1]` (rejects boolean / empty-string coercion), strict ISO `last_seen` (rejects impossible calendars), and wikilink targets that resolve to a `::memory` directive via `ids ∪ aliasIds`.
- **Type-aware stale-recall** — `noma render --to llm --exclude-stale-days <n>` with optional `--now <iso>`. Durable `user` / `feedback` rules are pinned by default unless they carry `expired=true`; only `project` and `reference` memories age out. `::memory_index` body lines whose wikilinks resolve only to excluded memories are dropped from the LLM output so the context has no dangling references.
- **Runnable demo** — `examples/agent-memory/` (`npm run demo:agent-memory`) converts six real Claude Code Markdown memories into a single `.noma` file, applies four surgical patches, re-validates, and renders both full and stale-excluded LLM recalls. 90.7% of bytes survive the patch; 30-day recall four months later shrinks 9033B → 4551B.
- **Closes the §24.12 nested-slug residual.** Nav chapter links, the home link, and cross-chapter wikilinks from nested-slug pages now apply the same depth-aware `../` prefix as the stylesheet href. Regression coverage added in `test/renderer-site-assets.test.ts`.

### §24.14 — v0.9.0 (reference agent SDK)

Shipped on 2026-05-13. Reference agent SDK (`@ferax564/noma-agent-sdk` v0.1.0) lands in the workspace as the first of two v1.1 RFC Annex A+B graduation prerequisites (the other being ≥1 third-party binding, tracked separately).

- **Public surface.** `NomaTools` (1:1 wrapper over `read_doc`, `list_ids`, `validate_doc`, `patch_block` via stdio); `NomaWorkflow` (composes them into `safePatch` with per-file absolute-path mutex + clamped retry, `applyOps` with parent-chain transcripts, `replayTranscript`, `readCapabilities`, `checkCapability` with five reason codes including the Annex A `ids.rename` global gate); `CapabilityDescriptor` (Annex A.3 sidecar parser).
- **Error channels.** Thrown `NomaSystemError` hierarchy (`NomaSpawnError`, `NomaTransportError`, `NomaCapabilityError`, `NomaTimeoutError`) for system faults — including the book-manifest `unsupported_op` — and `{ ok: false, code }` bodies for user-recoverable §3.5 patch errors.
- **Annex graduation metrics at target.** 7/7 single-call §3.5 codes observed end-to-end; 8/8 Annex A.3 descriptor fields exercised; 6/6 `examples/conformance/patch/*` fixtures pass through the SDK with byte-identical output to the non-SDK baselines. Aggregator test prints the report on every CI run as the durable graduation gate evidence.
- **Infrastructure.** `zod` pinned to `3.25.76` via root `overrides` to collapse three duplicate copies in `node_modules` that broke the MCP SDK's `instanceof ZodType` check. `@ferax564/noma-mcp-server` bumped to v0.9.0 in lockstep with the CLI. CI workflow runs `build:agent-sdk` + `test:agent-sdk` before `build:site`.
- **Authoring trail.** 28 commits, executed via subagent-driven flow from a plan refined through five rounds of `/codex review` (see `docs/superpowers/plans/2026-05-13-noma-agent-sdk.md` and `docs/superpowers/specs/2026-05-13-noma-agent-sdk-design.md`). Plan was written before any code shipped; codex caught every plan-vs-reality drift before a subagent ever ran.

### §24.15 — v0.10.0 (agent-safe workflow polish)

Shipped on `main` on 2026-05-14. Closes the first P0/P1 items from the revised agent-safe-document wedge: boring install, strict publishing, agent-targeted exports, transaction-safe patching, and CI-ready rendering.

- **One-command install path.** `noma --version` / `noma -v` now prints the package version, and `noma init [dir]` writes a renderable starter project that can immediately run through `noma check` and `noma render`.
- **Strict render mode.** `noma render --strict` blocks raw HTML/SVG/script escape hatches and disables external CDN runtimes, giving published/team artifacts a clear safe-by-default path. `renderHtml(..., { externalAssets: false })` exposes the same CDN-free behavior to API callers.
- **HTML ID hardening.** Headed sections now emit the canonical ID once on the wrapping `<section>` instead of duplicating it on the heading element, closing the duplicate-fragment risk called out in the review.
- **Agent-focused context export.** `noma render --to llm` now supports `--select`, `--exclude`, and `--budget`, so agents can request only the directive types and sections they need instead of ingesting whole artifacts.
- **Repository ID registry.** `noma ids <file.noma|book.yml>` prints canonical IDs, aliases, and source records as JSON. Book manifests return scoped chapter IDs plus alias records, giving agents a discovery surface before patching.
- **Patch transactions.** `noma patch --ops` accepts `{ "ops": [...], "prevalidate": true, "postvalidate": true }` and aborts the whole edit on validation failure. Source-preserving `add_block` now validates fragments before writing, matching `replace_block`.
- **Reusable GitHub Action.** Root `action.yml` exposes `uses: ferax564/noma@main` for validation, strict rendering, render-target selection, and optional artifact upload. It installs the CLI from the action checkout by default so workflow runs do not drift to an unrelated npm registry `latest`; explicit `cli-package` / `cli-version` overrides remain available. The README and getting-started docs now include copy-paste workflow snippets, with YAML regression coverage in `test/github-action.test.ts`.
- **MCP SDK security bump.** `@modelcontextprotocol/sdk` is upgraded to `1.29.0` in both MCP-facing workspaces; `npm audit` returns zero vulnerabilities after the lockfile refresh.

### §24.16 — v0.10.1 (package value validation)

Shipped on 2026-05-14 after external consumer smoke testing of the v0.10 line.

- **Action install hardening.** External registry checks showed `@noma/cli@latest` resolves to a different published package version than this repo's v0.10 line. The reusable GitHub Action now installs from `$GITHUB_ACTION_PATH` by default, preserving exact `uses: ferax564/noma@<ref>` behavior. `cli-package` and legacy `cli-version` remain opt-in overrides.
- **Consumer smoke evidence.** A clean temp project installed the packed CLI tarball, ran `noma --version`, `noma init`, `noma check`, HTML/LLM rendering, `noma ids`, transaction patching, strict rendering, and a programmatic parser/renderer import. A separate temp npm prefix installed the action checkout globally and rendered a claim through the resulting `noma` binary.

### §24.17 — v0.10.2 (npm package identity correction)

Shipped on 2026-05-14 after verifying the public npm package namespace.

- **Moved public package identity to `@ferax564`.** Registry metadata confirms `@noma/cli` belongs to `github.com/getnoma/noma`, and `noma` is also taken. `@ferax564/noma-cli`, `@ferax564/noma-mcp-server`, and `@ferax564/noma-agent-sdk` returned 404 and are the intended publish targets. Package metadata, workspace dependencies, source imports, install docs, examples, and Action override docs now use the corrected scope.

### §24.18 — post-v0.10.2 npm publish readiness

Landed on `main` after v0.10.2.

- **Package manifest hardening.** Scoped packages declare `publishConfig.access=public`; the MCP server now has typed ESM exports; and the CLI npm `files` list targets compiled root modules instead of the whole `dist/` directory, so generated docs, demo sites, and PDFs do not leak into the published tarball.
- **Regression coverage.** `test/packaging.test.ts` locks the package names, public publish metadata, root `files` shape, and MCP export contract before the first `@ferax564/*` npm publish.
- **Packed CLI smoke gate.** `npm run smoke:package` installs the packed CLI into a clean temp project and proves the boring install path, starter workflow, ID registry, patch transactions, API import, strict rendering, and slim tarball shape. CI runs it before conformance and site build.

### §24.19 — local v1-readiness bundle before publishing

Landed on `main` on 2026-05-14 while intentionally skipping npm/GitHub release publication.

- **Machine-readable contracts.** Root `schemas/` now carries JSON Schemas for patch ops, patch transactions, AST JSON, transcript records, and capability sidecars, exposed through `noma schema <name>` and included in the CLI package files list.
- **Patch surface expansion.** The implementation adds source-preserving `replace_body` and `update_heading`, with matching CLI schemas, MCP input validation, Agent SDK types, tests, and docs. `rename_id` now retargets `parent=` alongside `for=`, `dataset=`, `block=`, `ref=`, and wikilinks.
- **Compatibility policy.** `docs/compatibility.noma` defines stable vs. experimental surfaces, SemVer expectations, schema evolution rules, deprecation rules, validator/render compatibility, and explicit exclusions for publishing/hosted workflow.
- **Community-pack groundwork.** The parser and VS Code grammar accept namespaced directive names (`pack::name`), while renderer/validator plug-in loading stays explicitly future work.

### §24.20 — v0.11.0 (first public npm release line)

Shipped on 2026-05-15 to turn the post-v0.10.2 local readiness bundle into the first public `@ferax564/*` release line. This release packages local contracts, publish gates, and adoption docs before the next feature cycle.

- **Versioned release surface.** Root CLI and MCP server packages, lockfile metadata, spec frontmatter/headings, compatibility docs, superseded protocol docs, README status, and changelog now carry v0.11.0.
- **Machine-readable contracts.** `noma schema <name>` exposes bundled JSON Schemas for patch ops, transactions, AST JSON, transcript records, and capability sidecars, with schema validation tests and packed CLI smoke coverage.
- **Patch and reference readiness.** Source-preserving `replace_body` and `update_heading` are part of the public CLI/MCP/SDK surface, and `rename_id` retargets `parent=` references along with existing reference-bearing attributes and wikilinks.
- **Publish safety.** Public scoped package metadata, typed MCP exports, slim CLI tarball contents, packed install smoke tests, compatibility policy, and namespaced directive parsing are all documented for the first `@ferax564/*` publish.

### §24.21 — adoption surface follow-up

Landed after the v0.11.0 release metadata to make the project easier to evaluate during the first public release.

- **Homepage wedge sharpened.** `site/index.html` now leads with the v0.11.0 readiness story and links directly to adoption guides instead of only the demo gallery.
- **Case studies and comparison docs.** New Noma-authored docs explain when to use Noma, how it compares with Markdown/MDX/raw HTML/collaborative docs, and which workflows prove the agent-safe artifact thesis.
- **Agent and template guides.** New docs and `examples/templates/` files give agents a safe editing loop plus copyable research memo, decision record, technical spec, and recurring refresh pack shapes.

### §24.22 — v0.11.1 (polish + two validator rules)

Shipped on 2026-05-16. Patch release that absorbs the `[Unreleased]` slice queued after v0.11.0 and adds the residual §23.12 validator coverage.

- **MCP server runtime version string.** `@ferax564/noma-mcp-server` now reports `0.11.1` to MCP clients instead of the stale `0.1.0` server version string that v0.11.0 left in `serverInfo`. The published `0.11.0` MCP package on npm was misadvertising its own identity over the wire; v0.11.1 makes the wire version match the npm version.
- **Agent SDK lockstep dependency bump.** `@ferax564/noma-agent-sdk` stays experimental at `0.1.1`, but its declared deps on `noma-cli` and `noma-mcp-server` move to `0.11.1` so `npm install @ferax564/noma-agent-sdk` resolves a consistent v0.11.x toolchain (the published `0.1.0` still references the v0.9.0 CLI line).
- **VS Code extension README + `0.2.1` package bump.** The in-tree extension is ready for the maintainer to run `vsce publish` against the Marketplace. README points at the live install path; `noma-language-0.2.1.vsix` is packaged in `tools/vscode-noma/`.
- **Two new validator rules.** `claim-invalid-confidence` (warn on non-numeric or out-of-`[0, 1]` `confidence=` on `::claim`) and `citation-missing-source` (warn when a `::citation` has no `url=` / `source=` / `doi=`). Both are filterable via `--ignore-rule` and per-block `noverify`. Six new tests cover both, including silent paths for valid inputs.
- **Status:** the §24.9 "live publish pending maintainer step" line for `noma-language` still applies — `vsce publish` is a manual maintainer action that v0.11.1 prepares but does not automate.
