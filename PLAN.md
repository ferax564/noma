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
endnote
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
multi-tenant SaaS cloud platform
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

> **Noma is source-controlled artifacts agents can safely edit.**

Markdown is excellent as lightweight text, but too weak for rich artifacts.
HTML is excellent as a rendering target, but too noisy and unpleasant as long-term source.

Noma is the missing middle:

```txt
Readable source → Polished artifact → Agent context + ID-targeted patches
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
structured than Markdown, less noisy than HTML — plus IDs, validation, and
patch operations.

### 23.3 Final Positioning

Primary:

> **Noma is a plain-text format for durable documents that humans review and
> agents safely patch.**

Sharper:

> **Write in Noma. Render the artifact. Patch by ID.**

Or:

> **Readable source. Polished artifacts. Safe agent edits.**

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
add_comment
resolve_comment
add_change_request
update_table_cell
update_table_header_cell
insert_table_row
delete_table_row
insert_table_column
delete_table_column
move_block
add_block
delete_block
update_attribute
remove_attribute
rename_id
```

This set covers whole semantic-block replacement, body-only edits, heading
renames that preserve stable IDs, review comment creation/resolution, targeted
tracked change-request creation, table-cell edits, table-row insertion/deletion, table-column
insertion/deletion, block moves, insertion, deletion, scalar
attribute updates, and canonical-ID renames with reference retargeting.

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

> Noma is source-controlled artifacts agents can safely edit. Write structured
> documents in plain text, render them to HTML/PDF/DOCX/LLM context, and let
> agents patch stable block IDs.

### 23.17 Final Product Definition

> **Noma is a plain-text source format for durable, structured documents that
> humans review and agents safely patch. It keeps source readable in Git,
> renders polished artifacts, and gives agents stable block IDs for targeted
> edits.**

### 23.18 Hosted Collaboration Layer

Noma's source-first core remains the product contract, but the collaboration
surface should not stop at static HTML. The hosted layer is **Noma Cloud**:

```txt
.noma source → cloud document ID → workbench collaboration URL → rendered artifact URL
```

This layer should make Noma useful for shared research, paper drafting, books,
technical documentation, and internal knowledge spaces. The MVP is intentionally
smaller than realtime collaborative editing: persistent documents, stable share
links, artifact publishing, diagnostics, LLM/JSON exports, and proofed patch
operations. EZKeel is the default deployment path for user-owned VPS hosting.

Realtime cursors, multi-tenant enterprise auth, billing, and organization-scale
permissions are later product work. They must not weaken the source/artifact/
agent contract or turn `.noma` into an opaque database-only format.

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
- **Third-party binding (starter, in-tree, not yet published).** `packages/agent-sdk-py/` adds a Python v0.1.0 starter (`ferax564-noma-agent-sdk` on PyPI namespace, **not yet published**). Mirrors the TS `NomaTools` surface 1:1 over the official Python `mcp` SDK; spawns the same Node `@ferax564/noma-mcp-server` child process; error hierarchy and §3.5 error code Literal match the TS SDK. Workflow layer (safe-patch mutex, op-list transcripts, replay) and capability sidecar parser deferred to v0.2.0. Once published to PyPI and validated against the Annex graduation conformance fixtures, this satisfies the second v1.1 RFC Annex A+B graduation prerequisite (≥1 third-party binding).

### §24.15 — v0.10.0 (agent-safe workflow polish)

Shipped on `main` on 2026-05-14. Closes the first P0/P1 items from the revised agent-safe-document wedge: boring install, strict publishing, agent-targeted exports, transaction-safe patching, and CI-ready rendering.

- **One-command install path.** `noma --version` / `noma -v` now prints the package version, and `noma init [dir]` writes a renderable starter project that can immediately run through `noma check` and `noma render`.
- **Strict render mode.** `noma render --strict` blocks raw HTML/SVG/script escape hatches, disables external CDN runtimes, and freezes computed controls as disabled static defaults with no generated inline runtime, giving published/team artifacts a clear safe-by-default path. `renderHtml(..., { externalAssets: false })` exposes CDN-free rendering to API callers, while `renderHtml(..., { interactive: false })` exposes the static computed-control posture.
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

### §24.23 — post-v0.11.1 Word handoff + review loop

Landed after v0.11.1 to move the source/artifact/agent loop closer to a Word-compatible review workflow.

- **Web workbench.** The static site now ships `workbench.html`, a browser-based `.noma` editing surface with Word-style file, formatting, paragraph, insert, layout, review, find, print, and export controls plus live safe HTML preview, diagnostics, outline navigation, AST and LLM output tabs, sample loading, local file opening, selection-aware Markdown formatting, Noma block insertion templates, and HTML/JSON/Noma/LLM export actions. `npm run build:site` builds the client bundle from the existing parser, validator, HTML renderer, JSON renderer, and LLM renderer before copying `site/` to `dist/`.
- **Markdown export.** `renderer-markdown.ts`, `renderMarkdown`, and `noma render --to markdown` / `--to md` add a portable sharing target between `.noma` source, rich HTML/PDF, and Word handoffs. The renderer preserves ordinary Markdown, converts `[[id]]` to `[id](#id)`, emits hidden anchors for IDs/aliases, renders tasks as checklists, figures as images, callouts as GitHub-style admonitions, and directive tables as pipe tables, while hidden semantic comments carry directive block context for agents.
- **DOCX handoff depth.** `renderer-docx.ts` now exports native Word comments with resolved-state and thread metadata, targeted comment anchors, review-view settings, target-anchored tracked change-request revisions, state-change deltas, dataset tables, Office Math blocks and inline equations, native checkbox action items, native control fields, action/export blocks, section-level page setup, rich headers/footers with page numbers, generated tables of contents and caption lists with page-reference fields, page breaks, target-anchored native footnotes/endnotes, generated bibliographies, and semantic review-block styling/metadata from the same AST used by HTML/PDF/LLM renderers.
- **DOCX rich hyperlink labels.** Markdown link labels with bold, emphasis, combined bold+italic, inline code, escaped literal brackets, or escaped table pipes export as styled native Word hyperlink runs for external URLs, `mailto:` links, and internal `#id` links, so Word reviewers see the intended label formatting instead of literal Markdown punctuation.
- **DOCX nested inline links.** Links and wikilinks wrapped in bold, emphasis, or combined bold+italic render recursively in DOCX output, so formatted caption references become styled `REF` fields instead of literal Markdown text.
- **Native DOCX figures.** `::figure` blocks with PNG/JPEG/GIF/SVG image data export as embedded Word media parts. The CLI resolves local `src=` paths before rendering so the renderer stays pure.
- **Static DOCX plots.** Resolvable `::plot` blocks reuse the pure plot SVG renderer and export as embedded Word media, so dataset-backed charts survive the Word handoff instead of degrading to text.
- **DOCX figure and plot captions.** Embedded figures and resolved plots use the Word caption style, place captions after the media, keep block bookmarks attached to the visible caption, and include `SEQ Figure` / `SEQ Plot` numbering fields.
- **DOCX caption cross-references.** `[[id]]` wikilinks to captioned figures, tables, plots, and computed plots export as Word `REF` fields pointing at the caption bookmark, so references update with generated caption numbers.
- **DOCX caption lists.** `::toc{of="figures|tables|plots"}` emits linked lists of captioned artifacts with Word `PAGEREF` fields, using the same bookmarks as figure/table/plot captions and wikilinks.
- **Native DOCX task checkboxes.** `::agent_task` and `::todo` export as Word checkbox content controls, preserving checked/unchecked state while keeping scope, owner, due, and priority metadata readable.
- **Native DOCX control fields.** `::control` exports its default value as an editable Word text content control tagged with `noma-control:<id>`, while `type="select"` uses native Word dropdown lists, `type="date"` uses native Word date-picker content controls, and `type="toggle"` / `checkbox` uses native Word checkbox controls. Type/default/range metadata stays visible for review.
- **DOCX content-control locks.** `::control{lock="control|content|all"}` and `locked` export native Word `w:lock` metadata so form authors can keep fields from being deleted while leaving values editable when appropriate.
- **DOCX control data binding.** ID-bearing `::control` blocks write a `urn:noma:controls` custom XML part and native Word `w:dataBinding` metadata, creating a structured form-data layer behind the visible content controls.
- **DOCX control data extraction.** `noma docx-data <file.docx>` and `extractDocxControlData(buffer)` read that `urn:noma:controls` value layer back out as JSON, giving fillable Word handoffs a `.noma -> .docx -> data` return path.
- **DOCX control data sync.** `noma docx-sync <file.noma> <file.docx>` and `syncControlDefaultsFromDocx(source, buffer)` source-preservingly update matching `::control default=` attributes from bound DOCX values, closing the basic `.noma -> .docx -> .noma` form loop. Controls without an explicit `type=` sync as text fields, matching render-time behavior.
- **DOCX sync audit reports.** `noma docx-sync` and `noma docx-review-sync` accept `--report <file.json>` so reviewers can inspect applied changes plus unmatched or skipped Word-return items, including revision-bearing tables skipped from direct table-body sync, without embedding the full patched source in the report.
- **DOCX task checkbox return path.** `noma docx-data <file.docx>` now reads native `noma-task:<id>` checkbox content controls, and `noma docx-sync <file.noma> <file.docx>` applies checked/unchecked state back to matching `::agent_task` / `::todo` `done` or `status` attributes.
- **DOCX visible control fallback extraction.** `noma docx-data <file.docx>` now also reads visible `noma-control:<id>` content-control values for text, date, dropdown/combobox, and checkbox/toggle controls, preserving Word `w:cr` carriage-return and `w:br` manual-break runs as line breaks, normalizing Word `w:noBreakHyphen` runs to `-`, preserving Word `w:softHyphen` runs as U+00AD soft hyphen characters, preserving Word `w:tab` and `w:ptab` runs as tabs, preserving Unicode `w:sym` glyphs, preserving leading/trailing spaces from text control values, accepting those empty run-token elements whether Word serializes them as self-closing or paired empty elements, ignoring deleted and moved-from tracked ranges, including range-marker `w:moveFromRangeStart` / `w:moveFromRangeEnd` spans, while keeping moved-to ranges as current text, accepting implicit checked elements without `val`, and recovering generated text/symbol checkbox glyphs when native checkbox metadata was stripped so `docx-sync` can recover reviewer edits even when the bound custom XML part is stale or missing.
- **DOCX header/footer form return path.** `noma docx-data` and `noma docx-sync` scan native Word header/footer parts for visible `noma-control:<id>` fields and `noma-task:<id>` checkboxes, so form controls embedded in document chrome can return to source.
- **DOCX review data extraction.** `noma docx-review-data <file.docx>` and `extractDocxReviewData(buffer)` read native Word comments, resolved state, threaded reply links, tracked insert/delete/replace revisions, tracked moves, footnotes, endnotes, bookmarked headings, and bookmarked tables from DOCX packages as JSON, reconstructing lightweight Markdown for bold/emphasis/code/internal-wikilink/external-link comment and note bodies. Adjacent same-style Word runs coalesce before Markdown rendering, so Word-split formatting returns as `**Bold**` or `*emphasis*` instead of fragmented markup, including inside internal and external hyperlink labels. Literal `[` and `]` characters inside returned external hyperlink labels are escaped so bracketed Word labels remain valid Noma Markdown, formatted or custom internal `#id` hyperlink labels return as `[label](#id)` when the visible anchor text or a verified Noma-generated bookmark identifies the target, generated complex or `fldSimple` Word `REF` fields for Noma caption cross-references return as `[[id]]`, and returned external hyperlink targets percent-encode whitespace and parentheses so Word relationship URLs remain valid inline link targets. Current comment, note, heading, and table bodies preserve Word `w:cr` carriage-return and `w:br` manual-break runs as line breaks, normalize Word `w:noBreakHyphen` runs to `-`, preserve Word `w:softHyphen` runs as U+00AD soft hyphen characters, preserve Word `w:tab` and `w:ptab` runs as tabs, preserve Unicode `w:sym` glyphs, preserve leading/trailing spaces in comment, note, and table-cell text, keep nested native table rows inside their parent table cell instead of promoting them to outer rows, accept those empty run-token elements whether Word serializes them as self-closing or paired empty elements, ignore deleted and moved-from tracked ranges, including range-marker `w:moveFromRangeStart` / `w:moveFromRangeEnd` spans, and keep moved-to ranges as current text while tracked-revision extraction preserves deleted or moved-from text and run tokens as old values and moved-to runs as new values. Adjacent same-ID tracked revision fragments are merged before insert/delete/replace grouping, so one formatted Word edit split across multiple `w:ins` / `w:del` wrappers returns as one rich revision instead of duplicate change requests. Multiple adjacent delete/insert pairs in the same paragraph group into separate replacements, while delete/insert runs separated by current text remain independent revisions. Explicit native `done=false` comment state wins over a stale generated `Status: resolved` paragraph, so reopened Word comments extract as unresolved; comments-extended entries with no `done` attribute fall back to the generated status paragraph instead of reopening comments by omission.
- **DOCX field-code hyperlink return path.** Word `HYPERLINK` fields, including complex fields and `fldSimple`, return as Markdown links with preserved result-run formatting, so Word-normalized comments and body edits do not collapse links into plain text.
- **DOCX rich caption/label return path.** Accepted Word edits to caption titles plus metric, control, action, and block-title label paragraphs preserve reviewer-authored bold/emphasis Markdown on return, including mixed bold spans in button and export-button action labels, while generated whole-label Word styling, generated button hyperlinks, and generated export-target links remain presentation-only and do not cause no-op rewrites. DOCX rendering emits editable label Markdown, generated contents and caption-list entry labels, source-authored metadata values, metric values, generated dataset/plot/export metadata, bibliography entry text, task status text, and state-change `from` / `to` values as native Word runs on the next handoff instead of showing literal `**` / `*` punctuation or erasing unchanged rich labels.
- **DOCX framed directive body anchors.** Comments, footnote/endnote references, and tracked revisions on later shaded paragraphs inside rendered directive bodies inherit the directive bookmark, so review items placed on paragraph two or three of a claim, risk, card, or other framed block still sync back to that source block.
- **DOCX header/footer review return path.** `noma docx-review-data` and `noma docx-review-sync` scan native Word header/footer parts for comment and tracked-revision anchors, and returned comments, notes, and change requests preserve nested directive fence depth when inserted back into source.
- **DOCX table-cell review anchors.** Native Word comment ranges or point references, footnote/endnote references, and tracked revisions placed inside a bookmarked table inherit the table's preceding Noma bookmark, so review notes and change requests made on table cells can sync back to the source `::table` or inline `::dataset` block without accepting tracked revisions as direct table-body edits.
- **DOCX layout child review anchors.** Native Word comments, footnote/endnote references, and tracked revisions placed inside `::grid` / `::columns` layout cells use nested child block bookmarks instead of the outer layout bookmark, so review items on rendered card/claim cells sync back to those child blocks.
- **DOCX layout cell anchor isolation.** Review anchor inheritance for generated `::grid` / `::columns` Word layout tables resets at each cell; unbookmarked sibling cells keep the outer layout block as their fallback instead of inheriting a previous cell's child bookmark.
- **DOCX restyled table review sync.** Bookmarked Word tables still return accepted edits to source after a reviewer changes the native table style away from Noma's generated `TableGrid` style.
- **DOCX rich table-cell review sync.** Accepted Word edits to table header/body cells with bold, emphasis, inline code, internal wikilinks, or external hyperlinks return as Noma Markdown while generated header styling stays presentation-only.
- **DOCX nested layout table sync.** Native Word table extraction recurses through generated `::grid` / `::columns` layout cells, so accepted edits to nested source `::table` blocks inside cards or layout cells return to the nested table instead of being skipped with the outer layout table.
- **DOCX nested layout table review anchors.** Word comments, footnote/endnote references, and tracked revisions inside nested source `::table` blocks rendered in layout cells inherit the nested table bookmark, so returned review items target the table rather than the surrounding card/grid.
- **DOCX nested layout dataset review sync.** Native Word table extraction and review-anchor inheritance cover nested source `::dataset` blocks rendered in layout cells too, so accepted edits, comments, footnote/endnote references, and tracked revisions return to the nested dataset rather than the surrounding card/grid.
- **DOCX review sync.** `noma docx-review-sync <file.noma> <file.docx>` and `syncReviewCommentsFromDocx(source, buffer)` map native Word comment/revision/note/table anchors back to Noma bookmarks, add new anchored review comments and notes to source, update or resolve existing source comments from Word state, update existing source-position note bodies, update matching `::table` bodies from edited Word tables, and import tracked revisions plus wrapper or range-marker tracked moves as `::change_request` blocks. Alias and canonical targets compare as the same source reference during review sync, so Word's canonical bookmark return does not rewrite unchanged alias-authored wikilinks, internal links with escaped labels, table/dataset cell links, or target attributes; target-only comment markup removals also match source links whose visible labels contain escaped brackets. DOCX review extraction preserves intentional spaces inside hyperlink labels, and review sync treats Word-escaped backslashes in returned hyperlink labels plus Word-returned literal pipes for source `\|` escapes as the same visible text, avoiding noisy rewrites of unchanged `[ label ](...)`, `[C:\label](...)`, and `A\|B` source links/cells.
- **Granular DOCX table sync.** Accepted Word edits to matching source `::table` blocks use `update_table_header_cell`, `update_table_cell`, `insert_table_row`, `delete_table_row`, `insert_table_column`, or `delete_table_column` when the edit shape is simple and unambiguous, preserving Markdown/link markup in unchanged cells instead of rewriting the whole table body. Returned table cells with multiline or nested native Word table content are reported as skipped instead of being flattened into a lossy source edit.
- **DOCX table code-cell pipe preservation.** The DOCX review return path and table patch serializers now escape separator pipes outside inline code spans while preserving literal pipes inside edited code cells, so a Word-returned `` `x|y` `` cell keeps the same visible code text in source.
- **DOCX heading edit sync.** Accepted edits to bookmarked Word headings return through source-preserving `update_heading` patches, keeping explicit heading IDs stable while updating the visible title.
- **DOCX rich heading edit sync.** Accepted Word heading edits with bold, emphasis, inline code, internal wikilinks, or external hyperlinks return through `update_heading` as lightweight Noma Markdown instead of flattened plain text.
- **DOCX caption edit sync.** Accepted edits to Word caption paragraphs for tables, figures, plots, and computed plots return to the source block's caption field, including computed-plot `label=` / `title=` / `name=` attrs and body `label:` / `title:` fields, or add `title=` when no explicit computed-plot caption field exists, giving captioned artifacts the same accepted-edit return path as headings.
- **DOCX caption reference return path.** Generated complex or `fldSimple` Word `REF` fields for Noma caption cross-references return through `docx-review-data` as `[[id]]`, so unchanged block bodies keep source wikilinks instead of syncing visible Word labels such as `Table`.
- **DOCX metric label edit sync.** Accepted Word edits to `Metric:` and `Computed metric:` label paragraphs return to source `label=` / `title=` / `name=` attrs or computed-metric body `label:` / `title:` fields, adding `label=` only when the displayed label came from the fallback block ID.
- **DOCX control label edit sync.** Accepted Word edits to `Control:` label paragraphs return to source `Label=` / `label=` attrs, adding `label=` when the displayed label came from the default Word control fallback while leaving visible control values on the form-data sync path.
- **DOCX action label edit sync.** Accepted Word edits to `::button` and `::export_button` action labels return to source `Label=` / `label=` attrs or body `Label:` fields, adding `label=` when the displayed label came from the default action fallback.
- **DOCX block title edit sync.** Accepted Word edits to titled directive heading lines return to source `title=`, `caption=`, or `name=` fields when the rendered title maps cleanly to a source field, including cards, callouts, sidebars, tabs, memory blocks, datasets, bibliographies, technical blocks, and custom fallback directives.
- **DOCX custom fallback metadata sync.** Accepted Word edits to readable attribute summaries in unknown and namespaced directive headings update, add, or remove matching source attrs, including whole-summary deletion and comma-bearing attr values, instead of turning metadata-only heading edits into noisy `title=` values.
- **DOCX block body edit sync.** Accepted Word edits to prose-like body-only directive content return through source-preserving `replace_body` patches for claims, cards, callouts, memory blocks, tasks, and supported semantic blocks, while unchanged source soft wraps do not create noisy rewrites.
- **DOCX technical prose body edit sync.** Accepted Word edits to body-only technical prose directives return through `replace_body` for `::api`, `::endpoint`, `::parameter`, `::instruction`, `::changelog`, and non-language-backed `::query` / `::example` blocks.
- **DOCX code body edit sync.** Accepted Word edits to monospace directive bodies return through source-preserving `replace_body` patches for `::code`, `::code_cell`, `::output`, and language-backed `::query` / `::example` blocks, preserving code line breaks instead of dropping those edits.
- **DOCX custom fallback body sync.** Unknown and namespaced directives export as framed Word fallback panels, and accepted Word edits to body-only fallback content return through `replace_body` while preserving readable custom labels and attribute metadata.
- **DOCX metric value edit sync.** Accepted Word edits to `::metric` value paragraphs return to source `value=` / `current=` / `amount=` attrs or body-backed metric values, preserving `unit=` when the edited visible value still carries the rendered unit and removing it when the reviewer deletes the unit from the value line.
- **DOCX metric metadata edit sync.** Accepted Word edits to `::metric` metadata fields update, add, or remove source `status=`, `trend=`, `change=` / `delta=`, `target=`, `source=`, and `as_of=` / `asOf=` / `date=` attrs.
- **DOCX block metadata edit sync.** Accepted Word edits to exported metadata lines for `::citation`, technical API/reference blocks, `::code_cell`, `::output`, `::computed_metric`, `::computed_plot`, `::control`, `::memory`, `::risk`, `::decision`, `::adr`, `::open_question`, evidence/counterevidence, assumption/hypothesis/result/limitation, `::review`, `::provenance`, `::confidence`, `::agent_task`, and `::todo` update, add, or remove matching source attrs or computed body metadata fields while preserving existing alias spellings such as `due_at=`, `decided_at=`, `author=`, `href=`, `baseUrl=`, `url=`, `location=`, `runtime=`, `count=`, `cell=`, `range=`, `suffix=`, `min=`, `max=`, `step=`, `lastSeen=`, `validUntil=`, and `supersededBy=`, including multi-line citation `source=`, `accessed=`, URL, DOI metadata, and values containing Word's visible ` · ` metadata separator or field-like text such as `Q1: Finance`, even when Word serializes that value separator as its own run.
- **DOCX dataset table sync.** `noma docx-review-sync <file.noma> <file.docx>` and `syncReviewCommentsFromDocx(source, buffer)` update inline `::dataset` bodies from edited native Word tables when the matched dataset can be represented in its source format.
- **Granular DOCX dataset sync.** Simple Word cell edits to inline YAML/CSV/TSV/JSON dataset tables use `update_dataset_cell`, simple row insert/delete edits use `insert_dataset_row` / `delete_dataset_row`, and simple column insert/delete edits use `insert_dataset_column` / `delete_dataset_column`, preserving comments, schema text, and unrelated source rows instead of replacing the full dataset body. Returned dataset cells with multiline or nested native Word table content are reported as skipped instead of being flattened into a lossy source edit.
- **DOCX form protection.** `::doc_protection{edit="forms"}` writes native Word document-protection settings for fillable form handoffs, defaulting to forms mode with enforcement enabled but no password protection.
- **DOCX metric handoffs.** `::metric` blocks export as KPI review blocks with label, value/unit, status, trend, change, target, source, and as-of metadata instead of falling through to generic directive labels.
- **DOCX computation handoffs.** `::code_cell` and `::output` blocks export as technical Word blocks with monospace source/output text, execution metadata, output-to-cell links, and block bookmarks instead of generic directive labels.
- **HTML data and computation blocks.** `::metric`, `::code`, `::code_cell`, and `::output` render as structured HTML/PDF panels with visible metadata, anchor links, KPI values, and monospace code/output bodies instead of falling through to generic directive boxes.
- **HTML semantic reasoning metadata.** `::evidence`, `::counterevidence`, `::risk`, `::decision` / `::adr`, `::open_question`, and common research blocks now keep target/source links, URL/DOI/accessed evidence details, ownership/status/date/due fields, and confidence metadata visible in HTML/PDF panels instead of only preserving that context in DOCX.
- **DOCX collaboration metadata.** `::review`, `::provenance`, and `::confidence` blocks export as Word-readable review metadata with target/source links, status/reviewer/provenance/value/basis/timestamp metadata, and block bookmarks.
- **Native DOCX resolved comments.** Resolved `::comment` blocks now write a `word/commentsExtended.xml` part with `w15:commentEx` done-state metadata, so Word-compatible handoffs preserve comment resolution as native package state as well as visible text.
- **Native DOCX comment replies.** `reply_to=` on `::comment` creates a threaded Word reply via `w15:paraIdParent` without changing existing block-targeting `parent=` semantics. Replies whose thread parent is missing, deleted, or withdrawn are not exported as orphan standalone Word comments and do not force review-view settings.
- **DOCX threaded reply sync.** `noma docx-review-sync <file.noma> <file.docx>` maps Word threaded replies back to source `::comment{reply_to="..."}` blocks when the parent source comment can be identified.
- **DOCX existing comment body sync.** Source-position native Word comment edits now return to existing `::comment` bodies through `replace_body`, with unchanged Markdown-formatted comments compared by visible text to avoid unnecessary flattening.
- **DOCX rich review body sync.** Accepted Word comment and note bodies without tracked revisions, with bold, emphasis, inline code, internal wikilinks, or external hyperlinks return as Noma Markdown instead of flattened plain text.
- **DOCX rich change-request export.** Source `::change_request` tracked insert/delete/replace text with bold, emphasis, inline code, internal wikilinks, or external hyperlinks exports as rich native Word revision runs instead of flattened plain text.
- **DOCX rich tracked-revision sync.** Word tracked insert/delete/replace revisions and tracked moves with bold, emphasis, inline code, internal wikilinks, or external hyperlinks return as Noma Markdown in source `::change_request` `from=` / `to=` text instead of flattened plain text.
- **DOCX review Markdown stability.** Review sync treats equivalent lightweight Markdown spellings such as `_emphasis_` and `*emphasis*` as unchanged in comments, threaded replies, notes, change requests, and table cells, avoiding noisy source rewrites when Word returns normalized inline markup.
- **DOCX review markup removal sync.** When a reviewer removes Word formatting or hyperlinks from comments, notes, change requests, or table cells, the source updates to plain text instead of silently preserving old Markdown/link markup.
- **DOCX edited reply sync.** Edited Word reply bodies return to existing source `::comment{reply_to="..."}` blocks when the parent thread plus visible text, metadata, or an unambiguous sibling identifies the source reply.
- **DOCX comment edit/deletion sync.** Targeted Word comments return to existing same-target source comments when the source bookmark, visible body, or metadata identifies them; source-bookmarked replies count as returned thread state when marking missing sibling replies deleted; resolved Word comments refresh existing source resolution metadata; reopened Word comments remove stale source resolution metadata; metadata-conflicting comments and replies return as distinct Word comments instead of overwriting source siblings, even when the visible text is identical; deleted/withdrawn source comments and replies are ignored when matching returned Word comments and replies, even if an older DOCX still carries their source bookmark; ambiguous same-target comments and replies are skipped without deleting source siblings; deleted Word comments, including previously resolved source comments, return as `status="deleted"` when at least one sibling comment on the same target or reply thread remains in the reviewed DOCX, and deleted/withdrawn source comments plus orphaned replies no longer export as native Word comments.
- **DOCX targeted note sync.** Targeted Word footnote/endnote edits now return to existing source notes when the source note, exact or visible body, or an unambiguous same-target note can be matched, including target-only note markup removals among same-target siblings; deleted/withdrawn source notes are ignored when matching returned notes, even if an older DOCX still carries their source bookmark; missing sibling targeted notes return as `status="deleted"`, and deleted/withdrawn notes no longer export as native Word notes.
- **DOCX same-anchor review sync.** Same-target comments and notes that share one Word anchor fall back to body/metadata matching instead of trusting the first source bookmark on that anchor, preventing no-op DOCX returns from overwriting one sibling and deleting another. Generated empty `Comment` / `Footnote` / `Endnote` fallback labels are ignored during sync so empty source review blocks stay empty unless a reviewer adds real text.
- **DOCX tracked review-text safeguards.** Comment and footnote/endnote bodies containing Word tracked revisions are marked in `docx-review-data` and skipped by `docx-review-sync` instead of being accepted as plain body edits, keeping proposed review-text changes visible in the review report.
- **DOCX tracked change request sync.** Edited Word revisions now return to existing source `::change_request` blocks when the source request, exact revision, metadata, or an unambiguous Noma-generated same-target request can be matched; metadata-conflicting target-only revisions return as distinct change requests instead of overwriting source siblings, even when the action and revision text are identical; target-anchored tracked revisions count as returned review state when marking missing sibling change requests deleted; deleted/withdrawn source requests are ignored when matching returned revisions, even if an older DOCX still carries their source bookmark; missing sibling change requests return as `status="deleted"`, while deleted/withdrawn and malformed fallback requests no longer export as native tracked revisions and are not treated as missing native siblings.
- **Targeted DOCX change requests.** When a `::change_request` target resolves, Word output marks the reviewed block with a native comment range and renders the tracked revision block beside that target instead of leaving the proposal detached at its source position.
- **DOCX review-view settings.** Documents with native comments or valid change-request tracked revisions now include `word/settings.xml` revision-view metadata so comments and insert/delete revisions are advertised as review markup.
- **DOCX malformed change-request fallbacks.** Malformed `::change_request` blocks stay readable at source position with visible action/target/revision metadata, without creating native Word review parts.
- **Rich DOCX comment and note bodies.** Native comments, footnotes, and endnotes preserve inline bold/emphasis/code, internal wikilinks, and external hyperlinks, with part-local relationship files for links inside `comments.xml`, `footnotes.xml`, and `endnotes.xml`.
- **Targeted DOCX footnotes.** When a `::footnote` target resolves, Word output attaches the native superscript reference to the reviewed block instead of leaving a detached footnote label at the source position.
- **Native DOCX endnotes.** `::endnote` mirrors the footnote targeting and rich-body behavior but writes native `word/endnotes.xml` content with `w:endnoteReference` runs for Word handoffs that collect notes at the end.
- **Rich DOCX headers and footers.** Native header/footer parts preserve inline bold/emphasis/code, internal wikilinks, and external hyperlinks, with part-local relationship files for links inside `header1.xml` and `footer1.xml`.
- **HTML collaboration metadata.** `::comment`, `::review`, `::provenance`, and `::confidence` render as structured HTML/PDF review panels with target/source links and visible resolution, reviewer, provenance, and confidence metadata instead of falling through to generic directive boxes.
- **DOCX technical documentation blocks.** `::api`, `::endpoint`, `::parameter`, `::example`, `::query`, `::instruction`, and `::changelog` export as structured Word panels with visible metadata, bookmark/reference links, and monospace example/query bodies.
- **HTML technical documentation blocks.** The same `::api`, `::endpoint`, `::parameter`, `::example`, `::query`, `::instruction`, and `::changelog` directives render as structured HTML/PDF panels with visible metadata links and monospace example/query bodies, so technical docs no longer fall through to generic directive boxes outside Word.
- **DOCX natural callouts.** `::abstract`, `::callout{tone=...}`, `::note`, `::warning`, and `::tip` export with natural Word labels and tone-specific shading instead of lowercase generic directive labels or `Callout (tone)` labels.
- **DOCX card panels.** `::card` blocks export as framed Word panels with natural labels, variant shading, visible icon/variant metadata, and block bookmarks instead of leaking titleless generic directive labels.
- **DOCX memory panels.** `::memory` and `::memory_index` blocks export as typed Word panels with visible memory metadata, wikilinked index entries, and block bookmarks instead of generic fallback labels.
- **HTML memory panels.** `::memory` and `::memory_index` render as structured HTML/PDF memory panels with typed labels, wikilinked index entries, source/supersession links, and visible freshness metadata instead of generic directive boxes.
- **DOCX addressable code and custom labels.** `::code{id=... lang=...}` exports as a bookmarked monospace Word block, and unknown/namespaced directives get readable fallback labels plus readable attribute summaries instead of raw directive identifiers.
- **HTML custom directive fallbacks.** Unknown and namespaced directives render as labeled HTML/PDF panels with readable directive names (`Finance position`, `Custom directive`), preserved bodies, and visible attribute metadata, giving future community packs a usable no-plugin baseline.
- **Computed formula validation foundation.** `src/formula.ts` adds a safe numeric formula parser/evaluator for `::computed_metric` and `::computed_plot`; the validator now checks control defaults/ranges, formula syntax, unknown dependencies, and over-deep computed chains before the §23.9 browser runtime lands.
- **Computed LLM defaults.** `renderer-llm.ts` evaluates computed formulas against `::control default=` values, emitting `formula:` plus `default:` for computed metrics and short `default_series` lines for simple-domain computed plots without shipping any runtime code into agent context.
- **Interactive computed HTML artifacts.** `renderer-html.ts` now renders live `::control` inputs plus browser-updating `::computed_metric` and simple-domain `::computed_plot` blocks from the shared safe formula AST. Body-style `formula:` / `domain:` lines are accepted so the §23.9 source sketch works without packing long formulas into attributes.
- **Strict computed HTML artifacts.** `--strict` keeps computed metrics/plots at their default rendered values, disables every rendered control, emits one disabled-interactivity badge, and omits the generated inline computed runtime so strict artifacts contain no Noma-generated `<script>` tags.
- **Trusted-publishing strict HTML posture.** Book manifests with `trusted_publishing: true` now apply the same strict static posture as `--strict` to manifest-driven HTML/site/PDF renders, so published books block escape hatches, omit CDN runtimes, and keep computed controls as disabled static defaults without relying on every render command to pass `--strict`.
- **DOCX computed artifacts.** `renderer-docx.ts` now evaluates `::computed_metric` values from `::control default=` inputs and exports simple-domain `::computed_plot` blocks as static SVG chart media with formula/domain metadata, giving Word handoffs the same default-state computation evidence as HTML and LLM outputs.
- **State-change diff presence tracking.** `diffDocs` and `noma diff` now emit `::state_change` blocks for attribute additions/removals as well as value changes, using `from="(absent)"` or `to="(absent)"` for presence changes. This closes the attribute add/delete half of the old v0.7 structural-diff follow-up.
- **Figure validation noverify.** The existing `figure-missing-alt` rule now respects per-block `noverify`, and tests cover missing-alt, valid-alt, and suppressed cases.
- **DOCX package metadata.** Frontmatter `title`, `author`, `description`, `tags` / `keywords`, `profile`, and `status` flow into `docProps/core.xml`, so Word and Google Docs handoff files retain meaningful document properties outside the visible body.
- **DOCX inline math.** Inline prose/table math written with `$...$`, `$$...$$`, `\(...\)`, or `\[...\]` exports as Office Math instead of literal delimiter text.
- **DOCX field update settings.** DOCX files that contain generated Word fields now include `word/settings.xml` with update-on-open metadata, `::toc` entries carry `PAGEREF` fields for page numbers, and captions carry `SEQ` fields for numbering.
- **DOCX table captions.** `::table{title=...}` / `caption=...` exports a visible Word table label with a `SEQ Table` numbering field and the block bookmark attached, so table references keep useful visible context.
- **DOCX page-aware table widths.** Pipe tables, `::table`, datasets, and `::grid` / `::columns` layout tables now size Word columns from the active `::page_setup` width and margins, so landscape or narrow-margin reports use the available page geometry.
- **DOCX section-level page setup.** The first `::page_setup` controls the initial DOCX section; later `::page_setup` blocks emit native Word section breaks and update subsequent table/layout widths from the new section geometry.
- **Native DOCX layouts.** `::grid` and `::columns` blocks export as fixed-width Word tables, preserving multi-column artifact structure instead of flattening layout blocks into generic labels.
- **Readable DOCX web layouts.** `::hero`, `::tabs`, and `::accordion` flatten into their child content for Word exports, `:::tab{title=...}` renders as a titled Word panel, and `::sidebar` renders as a framed aside instead of a raw directive label.
- **DOCX visual-spec fallbacks.** Browser-hydrated `::diagram` and `::plotly` blocks render as explicit source fallbacks in Word, preserving Mermaid/Graphviz/Draw.io/Plotly source for review.
- **Review patch ops.** `add_comment` creates targeted `::comment` blocks near the reviewed block or threaded replies with `reply_to=`, `resolve_comment` marks them `status="resolved"` with optional resolver metadata, and `remove_attribute` removes stale non-`id` directive metadata without replacing a block; `add_footnote` and `add_endnote` create targeted note blocks near reviewed content; `add_change_request` creates targeted `::change_request` blocks with explicit insert/delete/replace revision text for DOCX tracked-review handoffs. Source patching preserves nested directive fence depth for returned comments, notes, and change requests.
- **Table and dataset patch ops.** `update_table_cell` updates one body cell in an ID-bearing `::table` directive by zero-based row and numeric column or header label, escaping separator pipes outside inline code spans while preserving pipes inside code spans; `update_table_header_cell` updates one header cell without touching body rows; `insert_table_row` and `delete_table_row` add or remove body rows; `insert_table_column` and `delete_table_column` add or remove columns, including header-label deletion; `update_dataset_cell` updates one data cell in an ID-bearing `::dataset` directive for inline YAML row arrays, single-line CSV/TSV bodies with quoted cells, and simple pretty-printed JSON row or record arrays; `insert_dataset_row` and `delete_dataset_row` add or remove data rows; `insert_dataset_column` and `delete_dataset_column` add or remove data columns with schema/header/key updates where the source shape supports them. All preserve surrounding source bytes where the source shape is supported.
- **Move patch op.** `move_block` relocates an existing directive block under a new parent while preserving the block body/attributes, normalizing directive fence depth when needed, and rejecting moves into descendants.
- **Surface sync.** CLI schemas, MCP validation, Agent SDK types/capabilities, Python SDK models, docs, and regression tests all understand the expanded patch surface.

### §24.24 — v0.12.0 (interactive artifacts + release packaging)

Prepared on 2026-06-04. This release packages the post-v0.11.1 Word/review work and adds the local interactive-artifact follow-through needed for a coherent v0.12.0 cut.

- **Computed table directive.** `::computed_table` joins `computed_metric` and `computed_plot` as a first-class computed artifact directive without adding an AST variant. HTML renders default rows and updates them live with controls; LLM export emits a default row series; DOCX exports native captioned Word tables with formula/domain/unit metadata; validator/profile support covers formula dependencies and profile membership.
- **Shareable interactive state.** Standalone computed HTML artifacts persist control values in a `#noma:` URL hash and restore them on load, so scenario pages can be shared without a backend.
- **Denser lateral layouts.** Default and dark themes use a wider document canvas, smaller base/headline/table typography, tighter cards, and responsive `::grid` / `::columns` controls for `min=`, `gap=`, `wide`, `full`, `compact`, and related aliases.
- **New demos.** `examples/interactive-projection.noma` demonstrates controls, metrics, plots, computed tables, and URL-hash scenarios. `examples/word-review-loop.noma` demonstrates controls, comments, change requests, computed Word tables, and DOCX review/data return paths. Both are wired into `npm run render:examples`; the review demo also builds a DOCX artifact.
- **Release metadata.** Root CLI and MCP server move to `0.12.0`; the TypeScript Agent SDK moves to `0.1.2` with `0.12.0` dependencies; the Python starter binding moves locally to `0.1.1`; versioned docs, README status, changelog, and lockfile metadata are aligned.
- **Publish readiness.** npm and PyPI runbooks document the maintainer-only publish steps. VS Code Marketplace publication remains the manual §24.9 maintainer action; this release does not automate `vsce publish`.

### §24.25 — v0.13.0 (agent safety proof)

Shipped on 2026-06-05 to make the source/artifact/agent loop visible as a single
trust artifact instead of a sequence of separate commands.

- **`noma prove` CLI.** `noma prove <file.noma> --op/--ops` dry-runs the same
  patch transaction shape as `noma patch` and renders a static proof artifact:
  pre/post validation, canonical ID registry, scoped LLM context, operation
  payloads, source-line preservation percentage, compact source diff, pre/post
  SHA hashes, and a sandboxed post-patch HTML preview.
- **Guarded apply.** `noma prove --inplace --out proof.html` writes the source
  only when the simulated post-patch document has no validation errors. Failed
  proofs still write the report and leave the source unchanged.
- **Automation surface.** `noma prove --to json` emits proof metadata without the
  patched source or embedded preview, and the public API exports
  `createAgentSafetyProof` / `renderProofHtml` for integrations that want the
  same audit artifact without shelling out.
- **Docs and examples.** README, getting-started, agent guide, and the CLI
  reference demo now put proof before patching in the default agent loop.
- **Release metadata.** Root CLI and MCP server move to `0.13.0`; the
  TypeScript Agent SDK moves to `0.1.3` with `0.13.0` dependencies; versioned
  docs, README status, changelog, and lockfile metadata are aligned.

### §24.26 — post-v0.13.0 live workbench proof/editor slice

Implemented on 2026-06-05 after the public v0.13.0 proof release to make the
proof loop usable directly from the browser workbench.

- **Workbench proof surface.** The static workbench now includes an Agent Proof
  panel, Review-tab prove/apply/share controls, and a Proof output tab. Browser
  proofs simulate patch ops, compute pre/post hashes, validate the post-source,
  measure line preservation, show operation payloads, and render a sandboxed
  post-patch artifact preview. Apply is disabled unless the proof is writable.
- **Workbench table/data editor.** ID-bearing `::table` and `::dataset` blocks
  are discoverable from the side panel and editable through a compact grid.
  Cell edits and row/column additions generate granular table/dataset patch
  operations, run through the proof loop, and only update the browser draft when
  validation permits the write.
- **Diagnostics-first authoring.** The inspector now begins with a severity
  summary while keeping click-to-source diagnostics and outline navigation.
- **Async collaboration handoff.** The browser workbench now exposes a
  Collaboration panel with a live source fingerprint, shared draft links that
  carry source in the URL fragment, and Markdown review packets containing the
  draft URL, hash, diagnostics, IDs, and LLM context.
- **Agent-oriented narrative.** The landing page and docs now frame Noma around
  LaTeX/Markdown/HTML pain: math/PDF-friendly reports, Markdown-like readable
  source, HTML artifacts, and proofed agent patches from the same `.noma` file.

### §24.27 — post-v0.13.0 Noma Spaces renderer

Implemented on 2026-06-05 to make Noma useful as a source-controlled
documentation, book, paper, and knowledge-space manager before the hosted
collaboration layer.

- **Static Noma Space output.** `noma render book.noma.yml --to site --out
  dist/space` now writes one page per chapter, a root index, shared theme
  assets, and `_assets/search-index.json`.
- **Reader-facing knowledge chrome.** Space pages include sidebar navigation,
  breadcrumbs, copy-link and print actions, page status/owner/updated/tag
  metadata, related-page suggestions, and backlinks computed from cross-chapter
  `[[id]]` references.
- **Agent orientation.** The generated search index exposes titles, paths, tags,
  status, owners, updated dates, summaries, and plain text so agents can inspect
  a space without scraping rendered HTML.
- **Example and docs.** The sample book now carries chapter metadata, and README,
  getting-started, spec, direction, agent guide, changelog, and landing copy
  describe Noma Spaces as the static sharing surface for documentation, internal
  books, papers, and agent-maintained knowledge bases.

### §24.28 — post-v0.13.0 Hetzner static deployment path

Implemented on 2026-06-06 to make the static product deployable outside GitHub
Pages while preserving the same source-controlled artifact model.

- **Atomic rsync releases.** `npm run deploy:hetzner` builds `dist/`, uploads it
  to a timestamped release directory on an SSH target, flips a `current`
  symlink, and prunes older releases.
- **Optional nginx bootstrap.** `HETZNER_PROVISION=1` installs/enables nginx when
  needed and writes a static server block rooted at the `current` symlink.
- **Health checks.** `HETZNER_URL=...` verifies the deployed URL after the
  symlink flip, making the command usable from local shells or CI once SSH
  credentials are present.

### §24.29 — post-v0.13.0 Noma Cloud + EZKeel deployment path

Implemented on 2026-06-06 to move beyond static HTML pages toward a hosted
collaboration product for shared research, papers, books, and documentation.

- **Persistent document API.** `src/cloud-server.ts` serves the existing
  workbench/site and exposes `/api/documents` for creating, loading, and
  updating shared `.noma` documents. The source remains the durable object; the
  server adds stable IDs, hashes, timestamps, diagnostics, JSON, LLM context,
  and rendered HTML artifacts.
- **Cloud workbench links.** The workbench now detects the hosted API, saves a
  document to cloud storage, opens `workbench.html?doc=<id>` for collaborators,
  and publishes reader artifacts at `/d/<id>`. Static builds still support the
  existing URL-fragment draft and review packet flow.
- **EZKeel deploy surface.** `ezkeel.yaml`, `Dockerfile`, `.dockerignore`,
  `npm run build:cloud`, `npm start`, and `npm run deploy:ezkeel(:dry-run)`
  define the user-owned VPS deployment path. Runtime storage defaults to
  `/data/noma/documents`, and `/healthz` is available for deployment checks.
- **Product boundary update.** Static Noma Spaces remain valid publishable
  artifacts, while Noma Cloud becomes the collaboration layer. Realtime editing,
  enterprise auth/permissions, and multi-tenant SaaS operations remain later
  work rather than v1 core format work.

### §24.30 — post-v0.13.0 Noma Cloud workspace editor

Implemented on 2026-06-07 to make the hosted product an editable workspace
instead of only a single-document cloud workbench.

- **Hosted cloud app.** `site/cloud.html` is now a first-screen product surface
  for spaces, pages, editable Noma source, live rendered preview, save/publish
  actions, share links, user invites, and an agent patch panel. It reuses the
  existing parser, validator, HTML renderer, LLM renderer, and source-preserving
  patch ops in the browser.
- **Workspace page permissions.** `src/cloud-server.ts` now exposes
  `/api/sites/:id?include=documents`, `/api/sites/:id/documents`, and
  `/api/sites/:id/documents/:docId` so site viewers can read the pages inside a
  space and site editors can update those pages through workspace permissions.
  This makes space-level collaboration useful without separately sharing every
  document.
- **Role-aware browser controls.** The cloud app disables editing for viewers,
  enables page saves for editors/owners, reserves invites for owners, and keeps
  standalone page shares plus published site shares available from the same
  workspace shell.
- **Product boundary update.** This is still async collaboration, not realtime
  multiplayer editing. Enterprise identity, audit logs, comments, Notion-style
  database views, templates, and automation remain future cloud work, but the
  deployed surface is now a real editable web app for shared Noma spaces.

### §24.31 — post-v0.13.0 Noma Cloud SQLite database and query API

Implemented on 2026-06-07 to make the hosted product database-backed and ready
for future Codex/plugin integrations.

- **SQLite-backed cloud storage.** Noma Cloud now persists users, documents,
  sites, permissions, share links, site page membership, and a block-level
  search index in `/data/noma/noma-cloud.sqlite` by default. Older JSON
  user/document/site records are imported once on startup when present.
- **Permission-aware DB query API.** `/api/db/schema` describes the available
  query resources, and `/api/db/query` exposes bounded JSON queries for
  `documents`, `sites`, `blocks`, and `users`. The API requires a user token,
  never accepts raw SQL, limits result size, and filters document/block rows by
  direct document access plus site-scoped workspace permissions.
- **Deployment update.** The Docker image now installs the native SQLite
  binding explicitly and sets `NOMA_CLOUD_DB=/data/noma/noma-cloud.sqlite` for
  EZKeel deployments.

### §24.32 — v0.14.0 hardening, block-level concurrency, self-maintaining repo (2026-06-10)

- **Security hardening.** Dataset/figure `src=` and book-chapter paths are
  contained to the document's directory by default (`--allow-external-paths`
  opts out); Mermaid/Graphviz SVG output is sanitized client-side before
  insertion; directive fence depth is capped at 64 colons; the GitHub Action
  renders strict by default; `patch(doc, op)` clones with `structuredClone`.
- **Block-level optimistic concurrency.** Every patch op accepts a `baseHash`
  precondition (sha256 of the target block's source slice, from the new
  browser-safe `src/hash.ts`). `patchSource` rejects stale edits with
  `sha_mismatch`; `blockSourceHash()` is exported; the MCP server returns a
  per-block `hash` from `read_doc` and accepts `base_hash` on `patch_block`;
  the protocol RFC documents the field as provisional. Diagnostics now carry
  `endLine` so consumers get full block spans.
- **Self-maintaining repo.** `npm run check:memory` fails CI when
  CLAUDE.md/AGENTS.md drift from the repo layout; `npm run release -- check|bump`
  encodes the versioned-locations ritual; `ci.yml` runs the matrix gates on
  PRs; `freshness.yml` sweeps docs weekly with `noma check --stale-days` and
  files an issue; `release.yml` publishes to npm with provenance on `v*` tags;
  Dependabot watches npm and Actions; eslint + coverage scripts added; the
  cloud-server test suite grew from 3 to 11 test blocks.

### §24.33 — v0.15.0 live editing loop: watch, fixits, LSP, book transactions (2026-06-10)

- **Watch mode.** `noma render|check|export <file> --watch` re-runs on
  document-directory changes (debounced; output files and non-source
  extensions ignored) for live author/agent loops.
- **Mechanical fixits.** Diagnostics carry an optional ready-to-apply `fix`
  patch op when the repair is unambiguous; broken references with a single
  near-miss ID suggest the correction; `noma check --fix` applies every
  available fix and re-validates. Each referencing site now gets its own
  positioned `broken-reference` diagnostic.
- **Book patch transactions.** `noma patch book.noma.yml --ops tx.json
  --inplace` (and `patchBookSource()`) routes each op to the chapter that owns
  its target ID, validates the re-assembled book, and writes all-or-nothing;
  cross-chapter ID conflicts are rejected; `baseHash` verifies against the
  chapter file.
- **Language server.** `@ferax564/noma-lsp` serves validator-backed
  diagnostics, document symbols, alias-aware go-to-definition, and `[[`
  completion over stdio; the VS Code extension (v0.3.0) bundles a language
  client that starts it automatically.
- **Release pipeline fix.** `release.yml` now fails loudly when `NPM_TOKEN`
  is missing (the v0.14.0 run silently skipped npm publishing) and publishes
  all four packages — cli, mcp-server, lsp, agent-sdk — idempotently.

### §24.34 — v0.16.0 conformance suite expansion to full op coverage (2026-06-13)

First v1.0 exit-criterion (§25.3 #1) closed. The golden conformance corpus
grows from 14 to 40 fixtures.

- **Full patch-op coverage.** Added one happy-path `patch/<op>/` fixture for
  every reference patch op that lacked one (20 new): `replace_body`,
  `update_heading`, `move_block`, `remove_attribute`, the
  comment/footnote/endnote/change-request ops, and the complete table and
  dataset cell/row/column families. Each is `input.noma` + `patch.json` →
  `expected.post.noma`, byte-exact through `patchSource`.
- **Error-code fixtures.** New `patch-error/` track with `expected.error.json`
  asserting the thrown `PatchError.code`. Six fixtures pin `target_missing`,
  `parent_missing`, `id_conflict`, `invalid_content`,
  `id_attribute_protected`, and `sha_mismatch`. The `noma verify` harness now
  evaluates rejection fixtures (fails loudly if the op succeeds, throws a
  non-`PatchError`, or throws the wrong code).
- **RFC §C updated.** The Agent Protocol RFC documents the new `patch-error/`
  track and `expected.error.json` vocabulary, and §C.5 now separates the
  normative 18-fixture protocol minimum (five frozen ops only) from the
  non-normative extended reference fixtures (§C.5.1) so the extra op coverage
  does not silently widen the frozen surface.
- **Authoring aid.** `scripts/gen-patch-fixtures.ts` regenerates the
  happy-path patch fixtures from their declared inputs/ops (manual, not in CI).

## 25. Road to v1.0 — Spec Freeze and Second Implementation

A format becomes a standard when someone else can implement it and a user can
rely on it not breaking. v1.0 is a **stability promise**, not a feature
milestone. Distribution work (template repo, MCP registry, Claude Code
plugin, launch) runs in parallel and does not gate the freeze.

### 25.1 What v1.0 freezes

- **Source syntax:** directive fences, attribute grammar, heading-ID
  derivation and aliasing, frontmatter, inline Markdown subset, pipe tables.
- **Block-ID semantics:** determinism, stability across re-parses, book-mode
  scoping, alias resolution order.
- **Patch op surface:** the op names, required fields (`content`, not
  `body`), error codes, `baseHash` precondition semantics, transaction
  all-or-nothing behavior. Annex A+B of the Agent Protocol RFC graduate from
  provisional to normative.
- **Conformance suite as the contract:** a v1.0-conformant implementation
  passes `examples/conformance` verbatim. New fixtures may be added; existing
  fixtures only change with a major version.

### 25.2 What v1.0 explicitly does NOT freeze

Renderer output (HTML/DOCX/PDF byte stability), validator profile contents,
LLM context format details, Noma Cloud APIs, workbench UI, and any directive
marked experimental in the spec.

### 25.3 Exit criteria (all must hold)

1. Conformance suite covers every frozen syntax feature and every patch op.
   **DONE (v0.16):** the corpus is 40 fixtures — one happy-path fixture per
   reference patch op (25 ops + a replay chain), one `patch-error/` fixture per
   reachable error code (6), plus the 6 valid and 2 invalid parse/validate
   fixtures. The RFC §C.5 minimum corpus (18) stays scoped to the five frozen
   ops; the extra op fixtures are labelled non-normative reference coverage.
2. One external consumer (not ferax564) has run the agent → proof → merge
   loop on a real repo and the patch-op surface survived contact unchanged
   for 30 days.
3. A second implementation — even partial — exists outside this repo:
   parser + `noma ids` + `replace_body`/`update_attribute`/`add_block` in
   another language passes the relevant conformance fixtures. The Python
   agent SDK is the natural seed; a community binding is better.
4. Zero `provisional` markers left in `docs/spec-agent-protocol-v1.noma`.
5. Six weeks without a breaking change to any frozen surface.

### 25.4 Sequence

```txt
v0.15        publish funnel fixed, plugin + registry + template distribution
v0.16 (now)  conformance suite expanded to full op coverage + error-code
             fixtures (DONE); spec audit pass marking every feature
             frozen|experimental (NEXT)
v0.17        external-user feedback window; breaking changes land here
             or wait for v2
v1.0         freeze + SemVer promise: breaking source/patch changes → major,
             additive → minor
```

### 25.5 Third-party binding recruitment

Concrete asks, smallest first: (a) a Python `noma-ids` reader against the
conformance fixtures, (b) a Rust or Go parser for the valid/ fixtures,
(c) a non-TS patch engine for the patch/ fixtures. Offer: conformance
fixtures as the test suite (no design work needed), listed as official
binding in README + spec. Channel: the launch posts + a `help wanted:
second implementation` GitHub issue pinned on the repo.
