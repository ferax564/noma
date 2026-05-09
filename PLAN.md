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
@noma/parser
@noma/ast
@noma/renderer-html
@noma/renderer-llm
@noma/renderer-pdf
@noma/validator
@noma/cli
@noma/vscode
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
