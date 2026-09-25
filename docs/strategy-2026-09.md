# Noma Strategy: The Knowledge Base for the Agentic Era

**Date:** 2026-09-23 · **Baseline:** v0.18.0 (`76b3d2d`) · **Branch:** `claude/awesome-brahmagupta-5fj0nc`

This review asks three questions:

1. Where does Noma stand today?
2. How does it compare with Notion and Confluence as they are in September 2026?
3. Which document model should Noma use? The options are HTML with composable classes, the `.noma` format, or a mix of the two. The model also has to support presentations through PaperDOM.

The first slice of the recommendation is already built on this branch (§7).

---

## 1. Summary

- **Keep `.noma` as the only source of truth.** Adopt HTML's *composition model* but not HTML as a *storage format*.
  - Directives are the Lego bricks.
  - Attributes are their props.
  - Fenced nesting is how bricks snap together.
  - A new, closed `class="..."` vocabulary of **style tokens** gives authors the utility-class feel they like in HTML. It does this without free CSS, scripts, or layout that breaks reading order.
  - HTML stays a first-class *output*: semantic, class-based, and isomorphic to the source.
- **Presentations are a surface, not a separate product.** Decks come in two kinds:
  - *Flow decks* (`::deck` / `::slide`) live inside any page. Agents patch them block by block, and they present in the browser. **Shipped on this branch.**
  - *Canvas decks* use the PaperDOM model, for pixel-positioned design work. `.noma` → PaperDOM export is **shipped on this branch**, and each canvas element is keyed back to the block that owns it.
- **Where Noma wins.** Notion and Confluence have both added agents, MCP, HTML blocks, and presentation modes during 2026. Neither can give an agent a stable, diffable, per-block address with proof-before-write. That is the moat. Every feature should widen it rather than chase parity.

---

## 2. Where Noma stands (v0.18.0)

| Area | State | Notes |
|---|---|---|
| Format core (parser, AST, validator, patch, IDs) | ✅ Strong | 25 patch ops, `baseHash` preconditions, 55 conformance fixtures, Python seed implementation |
| Renderers | ✅ | HTML, LLM, JSON, `.noma`, Markdown, DOCX (deep), PDF, site. **New:** PaperDOM |
| Wiki (Noma Cloud) | ✅ broad | Spaces, page tree, labels, comments (range anchors, reactions), history and diff, restrictions, templates, attachments, macros, Confluence import, webhooks, analytics, email digests |
| Editing | ✅ | ProseMirror Visual editor maps 1:1 to blocks and round-trips byte for byte. Yjs co-editing with presence |
| AI | ✅ differentiator | Generative Ask with validated citations. Proofed summarize, draft, and refresh proposals. Stale-knowledge sweeps. MCP |
| Search | 🟡 | FTS5 and filters are good. The "semantic" part is a 96-dimension token-hash vector, not a real embedding model |
| Identity | 🟡 | SSO works only through a trusted proxy header. There is no native OIDC/SAML flow |
| Scale | 🟡 | Single-process collaboration fan-out. Local-disk blobs (the S3 interface has no driver) |
| Import | 🟡 | Confluence yes, but without attachments. **Notion import is missing** |
| Presentations | ❌ → 🟡 | Before this branch: no slide syntax, and PaperDOM was vendored but unconnected. Two competing visual models, and the HTML export was a stub that did not escape markup (fixed here) |
| Styling freedom | ❌ → 🟡 | Before this branch: `class=` rendered as `data-class` and Cloud disabled `::html`. Now: style tokens |
| Code health | 🟡 | ~1,070 tests. Vendored `paperdom-*` files are all `// @ts-nocheck`. Enterprise modules are partly demo-grade (`docs/review-2026-09.md` §6) |

---

## 3. Competitors in September 2026

### Notion (3.x line)

- **Agents everywhere.**
  - Notion Agent (3.0, Sep 2025).
  - Custom Agents (3.3, Feb 2026).
  - External Agents such as Claude and Cursor, which can be assigned board tasks and @-mentioned (3.6, Jul 2026).
  - MCP with audit logs, and session control over MCP (Sep 2026).
- **HTML blocks (3.6).** Agents can write custom HTML/CSS/JS mini-apps inside a page, and the blocks follow page permissions. This is the direct answer to "more freedom than Markdown."
- **Presentation Mode (3.4)** splits a page at dividers into slides. Reviewers call it present-only: no layouts, no themes, no export. Since 3.6, agents can generate a static `.pptx` in a sandbox.

### Confluence and Rovo

- **Rovo agents.** @-mentionable agents that create and edit pages, label them, and build whiteboards and databases. Verified-agent governance, custom skills, and memory controls (Sep 2026). A Rovo MCP server works from Claude, Cursor, and IDEs.
- **Live docs, databases, and whiteboards.** Databases are maturing into typed collections.
- **Doc-to-deck presentation mode** inside Confluence.

### What they cannot do, and why

| Capability | Notion | Confluence | Noma |
|---|---|---|---|
| Stable, human-readable block address an agent can target | Opaque UUIDs in a proprietary tree | Storage-format XML, page-level versions | `{#id}` or heading slug, part of the user-facing API |
| Edit one block, with a proof and hash precondition | Page-level agent writes | Page-level agent writes | `patchSource` + proof + `baseHash` |
| Source you can `git diff` and review in a PR | Export only | Export only | Plain-text `.noma`, Git-native spaces |
| Per-claim provenance and citations | ❌ | ❌ | `::claim` / `::evidence` / `[doc:block@hash]` |
| Freedom beyond Markdown | HTML blocks, which are **unstructured islands** agents must rewrite whole | Macros | Typed directives + style tokens + sandboxed escape hatch |
| Presentations | Dividers → present-only; static `.pptx` | Doc → deck | Deck blocks with IDs, presenter, and a PaperDOM canvas bridge |

**The takeaway.** Both incumbents bolted agents onto storage models designed for human editors. Their agents write pages; Noma's agents propose block diffs. Notion's HTML blocks show that users want freedom. They also show the trap: an HTML island has no stable inner structure, so every agent edit is a full rewrite that nobody can review.

---

## 4. The format decision

### Options considered

| Option | Human-readable source | Safe agent block edits | Reviewable diffs | Expressiveness | Security | WYSIWYG round-trip | Decks |
|---|---|---|---|---|---|---|---|
| **A. Markdown+** (plain MD with extensions) | ★★★ | ★ | ★★ | ★ | ★★★ | ★★ | ★ |
| **B. Raw HTML + utility classes** (Tailwind-like) | ★ | ★ | ★ | ★★★ | ★ (XSS surface) | ★★ | ★★ |
| **C. HTML custom elements** (`<noma-card>`) | ★★ | ★★ | ★★ | ★★★ | ★★ | ★★ | ★★ |
| **D. JSON block tree** (Notion-style) | ✗ | ★★ | ★ | ★★ | ★★★ | ★★★ | ★★ |
| **E. `.noma` directives + style tokens + component kits** | ★★★ | ★★★ | ★★★ | ★★☆ → ★★★ with kits | ★★★ | ★★★ (already proven) | ★★★ |

### Recommendation: E, "HTML's Lego model with Noma's syntax"

The appeal of "classes in HTML composed like Lego" is **composition plus a shared vocabulary**. The drawbacks of *storing* HTML are real:

- no stable IDs
- noisy diffs
- XSS risk
- nesting that is ambiguous for agents
- WYSIWYG editors that rewrite it

Option E keeps the appeal and avoids the drawbacks.

| HTML concept | Noma equivalent | Example |
|---|---|---|
| Element / component | Directive | `::card`, `::slide`, `::decision` |
| Props / attributes | Attributes | `{title="Q3" status="accepted"}` |
| Children / slots | Fenced nesting (`:::`, `::::`) | `::grid` → `:::card` |
| Utility classes | **Style tokens** (closed set) | `class="tone-accent elevated span-2"` |
| `id` | Stable block ID (user-facing API) | `{id="pitch-loop"}` |
| Design system | Theme CSS + token vocabulary | `themes/default.css` |
| Custom components | **Component kits** (next, §6) | `::pricing_card` defined once per space |
| `<iframe srcdoc>` widget | Sandboxed `::html` | Same freedom as Notion HTML blocks, but isolated |

HTML output keeps this shape, e.g. `<article class="noma-card n-tone-info n-elevated" id="…">`. That means:

- Front-end developers can style it like any class-based system.
- The HTML is isomorphic to the source, so a strict "Noma-HTML" subset can later be *ingested* back into `.noma`.
- People who think in HTML get HTML, but it is never the storage format.

**Why not a hybrid where both HTML and `.noma` are sources?** Two sources of truth means two ID systems, two diff formats, two validators, and a lossy converter between them. The Iron Rules (stable IDs, round-trip, pure renderers) only hold if there is one canonical source. HTML is the right *projection* and *escape hatch*, and the wrong canonical format.

---

## 5. Presentations and PaperDOM

A deck needs two different editing modes, and forcing either into the other fails:

| Kind | Model | Best for | Agent editing |
|---|---|---|---|
| **Flow deck** | `.noma` `::deck` / `::slide` blocks inside a page | Status updates, pitches, training, doc → deck | Block patches by slide or bullet ID, same proof loop |
| **Canvas deck** | PaperDOM JSON: absolute frames, masters, shapes, charts, animations | Designed decks and whiteboard-like visuals | PaperDOM `AgentOperation` transactions with revision checks |

**The bridge is the product.** One-way exports lose the agent story, so the plan is two-way:

1. **`.noma` → PaperDOM (shipped).**
   - `renderPaperDom()` / `--to paperdom`.
   - Page id = slide block ID. Element id = `<slide-id>--<part>`.
   - The output is valid under the vendored kernel's `parsePaperDOMDocument`.
2. **PaperDOM → `.noma` text sync — shipped.** When someone edits an element's text on the canvas, the id convention maps the edit back to a `patchSource` op on the owning block. It goes through the same proof and approval loop. Geometry stays in PaperDOM, and words stay in `.noma`.
3. **Embed canvases in pages — shipped.** `::canvas{src="att:board.json" id="…"}` draws a PaperDOM document (an inline JSON body, a file, or a page attachment) inside a wiki page as sanitised SVG. This is Noma's whiteboard answer, without cloning Confluence whiteboards.
4. **Office export through PaperDOM — shipped.** `noma render --to pptx` and Cloud `export?to=pptx` write `.pptx` from the canvas model (native text, shapes, connectors, tables, charts, images, notes, hidden slides, transitions), with a fidelity report for everything else.

Housekeeping required first:

- Retire the flat `PaperDocument` "Visuals" model in `enterprise-paperdom.ts`, or make it a view over PaperDOM. There should be one visual model.
- Replace the stub `paperDomHtmlExport` with a real renderer.
- ~~Remove `@ts-nocheck`~~ **Done.** PaperDOM is now a maintained fork in this repo: type-checked, linted, and free to change.

---

## 6. Roadmap

### Phase 0: shipped on this branch

- `::deck` / `:::slide` / `::::notes`, eight layouts, three aspects, and a fullscreen presenter with keyboard navigation and deep links.
- `--to paperdom` / `renderPaperDom()`, with section-per-slide fallback for documents without a deck.
- Style tokens (`class=`): 35 tokens in 9 groups, themed in the default and dark themes, validated (`unknown-style-token`).
- Validator rules for deck structure, and a `presentation` profile.
- XSS fix in `paperDomHtmlExport`.
- `examples/deck.noma`, which builds into the site. 15 new tests.

### Phase 1: make it feel native in Cloud (≈4 weeks)

- ~~**Present from any page.**~~ **Done.**
  - A Present button in the page header opens `/d/:id/present`. Pages without a deck present as a title slide plus one slide per section, which matches Confluence doc-to-deck.
  - The presenter has speaker notes, an overview grid, deep links, and share-link support.
  - The same presenter ships as `noma render --to slides`.
- **Visual editor support.**
  - ~~Slash commands `/deck`, `/slide`, `/notes`~~ **Done.** `/grid`, `/card`, and `/widget` were added too.
  - ~~A slide-strip view~~ **Done.** A filmstrip above the editor, drawn through the canvas model: click to reveal, drag or Alt+←/→ to reorder (`move_block`), hide, and add slides.
  - ~~A token picker (chips, not a CSS box) that writes `class=`~~ **Done.** It shows space aliases first and keeps one token per exclusive group.
- ~~**Sandboxed `::html` in Cloud.**~~ **Done.**
  - Each widget has its own signed URL, served with a `sandbox allow-scripts` CSP, `connect-src 'none'`, and an opaque origin.
  - A `srcdoc` iframe would have inherited the page CSP, so it was not used.
  - Agents can author these widgets through the proof loop.
- ~~**Per-space token vocabularies.**~~ **Done.** Space owners define aliases such as `brand-callout = tone-accent filled roomy`. An alias expands only to core tokens.

### Phase 2: component kits, the real Lego system — **shipped**

Shipped on this branch as described below. Two details changed during
implementation: the kit is a page chosen in Space settings, not a `_kit.noma`
file, and the LLM renderer keeps the component call.

- A space-level kit file (`_kit.noma`) declares components:

  ```noma
  ::component{name="pricing_card" props="plan,price,cta" slots="features"}
  :::card{title="{{plan}}" class="elevated tone-accent"}
  **{{price}}**

  {{slot:features}}
  :::
  ::
  ```

- `::pricing_card{plan="Team" price="$8"}` then expands to built-in blocks at render time. The source stays small, stays diffable, and keeps its ID.
- Rules:
  - Kits compose only built-in directives and tokens. No CSS or scripts, which keeps them safe for agents and renderable in every target.
  - The validator checks props and slots.
  - The LLM renderer shows the *component call*, not the expansion, which saves tokens.

### Phase 3: the canvas bridge (≈6–8 weeks)

- ~~PaperDOM → `.noma` text sync (§5.2)~~ **Done:** `noma paperdom-sync` and Cloud `POST …/paperdom-sync` feed the proof and approval loop.
- ~~`::canvas` embeds (§5.3).~~ **Done.**
- ~~`.pptx` export (§5.4).~~ **Done.**
- ~~A real PaperDOM HTML/SVG renderer.~~ **Done:** `canvasPageSvg` (static, sanitised) backs `::canvas` and the slide strip.
- Unify the visual models.

### Phase 4: close the enterprise gaps that decide deals

- ~~**Notion import.**~~ **Done (2026-09-25).**
- ~~**Real embeddings**~~ **Done (2026-09-25):** OpenAI-compatible and Voyage providers, local hash default.
- ~~**Native OIDC**~~ **Done (2026-09-25).** SAML stays behind the trusted-header route.
- ~~**S3 blob driver**~~ and ~~Confluence attachment copy~~ **Done (2026-09-25).**
- **Multi-node collaboration fan-out.** Still open.
- ~~**Agents as teammates**~~ **Done (2026-09-25):** @-mention or assign tasks to agents, with MCP `assignments`/`reply`/`update_assignment`.

### Explicit non-goals

- Free-form CSS or user stylesheets in Cloud pages. Tokens and themes only; the direction doc rules out "a complex CSS theming engine".
- HTML as a stored or canonical format.
- Feature-for-feature whiteboards and databases. Use `::canvas` and `::dataset` instead.

---

## 7. What changed on this branch

| File | Change |
|---|---|
| `src/style-tokens.ts` | Token vocabulary, parser, and class mapping |
| `src/slides.ts` | Shared deck/slide helpers (layouts, aspects, title/notes extraction, section fallback) |
| `src/renderer-paperdom.ts` | AST → PaperDOM document |
| `src/renderer-html.ts` | Deck/slide/notes rendering, token classes on every directive, presenter runtime |
| `src/renderer-markdown.ts` | Slides as `##` sections with `---` separators, notes as quotes |
| `src/validator.ts` | Five new rules and the `presentation` profile |
| `src/cli.ts` | `--to paperdom`, `--deck <id>` |
| `src/enterprise-paperdom-host.ts` | Escape HTML in `paperDomHtmlExport` |
| `themes/default.css`, `themes/dark.css` | Token and deck styles |
| `examples/deck.noma`, `test/slides.test.ts` | Example and tests |
| `docs/spec.noma`, `CHANGELOG.md` | Spec and changelog |

Verification:

- Passed: `npx tsc --noEmit`, `npm run typecheck:web`, `npm run verify:conformance` (55/55), and `npm run build:site`.
- `npm test`: 1,067 of 1,068 pass. The one failure is `cloud-ui.test.ts`, which loads a CDN resource that this sandbox's network blocks. It fails the same way on the base commit.

---

## 8. Decisions (maintainer, 2026-09-24)

| # | Question | Decision | Implemented |
|---|---|---|---|
| 1 | HTML vs Noma | **`.noma` is the standard.** HTML is a projection and a sandboxed escape hatch, never the source | `docs/direction.noma` decision `lego-composition` is accepted |
| 2 | Token governance | **Multiple vocabularies.** Each space defines its own aliases on top of the global core set | Space `styleTokens` (owner-only), frontmatter `style_tokens:`, `invalid-style-token-alias` rule |
| 3 | Sandboxed `::html` in Cloud | **Yes** | Signed `/api/documents/:id/widgets/:block` route, `sandbox allow-scripts` CSP, `<iframe sandbox>` in pages and in the editor preview |
| 4 | PaperDOM | **Fork** into this repo | `@ts-nocheck` removed, the 48 hidden type errors fixed, files linted, provenance in `paperdom-pin.ts` |

---

### Sources (competitor research, September 2026)

- [Notion 3.6: External Agents, HTML blocks](https://www.notion.com/releases/2026-07-01)
- [Notion 3.3: Custom Agents](https://www.notion.com/releases/2026-02-24)
- [Notion 3.2: Mobile AI, MCP audit logs](https://www.notion.com/releases/2026-01-20)
- [TechCrunch: Notion turned its workspace into a hub for AI agents](https://techcrunch.com/2026/05/13/notion-just-turned-its-workspace-into-a-hub-for-ai-agents/)
- [Notion release notes, September 2026 (Releasebot)](https://releasebot.io/updates/notion)
- [How Notion HTML blocks work (and their limits)](https://matthiasfrank.de/en/notion-html-blocks/)
- [Notion Slides / Presentation Mode explained](https://eazyhq.com/blog/notion-slides)
- [Notion can now make PowerPoint](https://2slides.com/blog/notion-can-now-make-powerpoint)
- [Rovo Chat new features, September 2026](https://www.atlassian.com/blog/company-news/rovo-chat-new-features-september-2026)
- [What's new in Rovo Agents](https://community.atlassian.com/forums/Rovo-articles/What-s-New-in-Rovo-Agents-Your-Bi-Monthly-Update/ba-p/3214108)
- [Confluence updates, August 2026 (Releasebot)](https://releasebot.io/updates/atlassian/confluence)
- [Confluence Databases, Spring 2026](https://community.atlassian.com/forums/Confluence-Databases-articles/What-s-New-in-Confluence-Databases-Spring-2026-Feature-Drop/ba-p/3237974)
