# Noma Strategy Review: Riding the ChatGPT Space Wave

**Date:** 2026-10-02 · **Baseline:** `main` @ `d561b68` (package.json v0.19.0) · **Supersedes nothing:** extends `docs/strategy-2026-09.md`

**Inputs:**
- Launch coverage of ChatGPT Space.
- A survey of related open-source projects.
- A hands-on audit of the landing page and install path.
- A Noma Cloud UI audit: 42 screenshots at desktop and phone sizes, taken against a seeded local server.
- A check of GitHub and npm state.

---

## 0. The verdict in one paragraph

OpenAI shipped Noma's thesis to hundreds of millions of users on 2026-09-29. ChatGPT Space is a shared workspace of AI-editable "pages" for teams. That confirms the market, and it ends the window in which "AI wiki" alone was a differentiated pitch.

Noma's problem is not features. In five months it has built:
- a wiki
- Jira-style Work
- Slack-style Chat
- a CI/deploy loop
- agent governance
- DLP and SIEM
- PaperDOM slides
- a DOCX review loop
- six render targets

That comes to about 94k lines of TypeScript. In the same five months it has gained **0 GitHub stars, 0 forks, 0 external issues, and npm has been stuck on 0.15.0 since June.**

The next six weeks should go almost entirely to:
1. **narrowing the story** to the one thing ChatGPT Space structurally cannot be;
2. **polishing the single loop** that proves it;
3. **making Noma trivially reachable from the agents people already use**, ChatGPT included;
4. **launching** while "ChatGPT Space alternative" is a live search term.

New surfaces should wait.

---

## 1. What changed: ChatGPT Space

Announced at DevDay on 2026-09-29, rolling out to Pro, Business and Enterprise:

- **A shared workspace inside ChatGPT.** Teams add members and work alongside ChatGPT. History and files live in one place instead of scattered across chats.
- **"Pages."** Interactive documents with charts, images, checklists and dashboards. Pages can be created from a conversation, a file or a template, and grouped into spaces.
- **Co-editing,** with comments on passages and a chat per page.
- **Meeting summaries,** plus Slack and Microsoft Teams integrations.
- **Alongside it,** an Agents API in public beta: OpenAI-hosted sandboxes and a managed Codex harness.

**Not yet verified** (the coverage sites were blocked from our sandbox, so check these first-hand within the week):
- page storage format and export;
- version history granularity;
- whether third-party agents or MCP can write to pages;
- self-hosting, which is almost certainly not offered.

### What it means for Noma

| | ChatGPT Space | Noma |
|---|---|---|
| Distribution | Enormous, built in | ~none |
| Where the source of truth lives | OpenAI's database | Plain-text `.noma` files you own (Git, export, self-host) |
| Which agents can edit | ChatGPT / OpenAI agents | Any: Claude Code, Codex, Cursor, ChatGPT via MCP, CLI, SDKs |
| How an agent edits | Model rewrites the page in place (assumed) | Proposes a patch to **one block by stable ID** → proof → human approval → apply checked against the content hash |
| Audit | Activity history (assumed) | Append-only decision log, hash-bound approvals, trust tiers, kill switch |
| Review in Git | No | Yes: `.noma` diffs, GitHub Action, PR review |
| Deployment | OpenAI cloud | Self-host (Docker, Hetzner, EU AWS reference), or hosted |
| Engineering loop | Generic office | GitHub PRs and CI → issues, `/deploy`, `/test`, code intelligence |

**Positioning consequence:** never fight Space on "AI-native pages" or collaboration polish. Fight on **ownership, neutrality and governance.** The headline is *"The wiki your agents can edit — and you can audit."*

### Open-source landscape (no one owns this position)

- **HKUDS/OpenSpace** manages skills for agents, as an MCP server. Not a document tool, so not a competitor. It could be a partner: a skills layer that writes into Noma.
- **openagents-org/openagents** (4.2k★, Apache 2.0) is a "Slack for agents": shared threads, files and a browser across Claude Code, Codex, Cursor and others. It overlaps with Noma Chat and has **no durable, reviewable document layer.** That makes it an integration target, not a rival.
- **gh0stcreator/openspace** is a 1★ experiment in role-based agents.

**Conclusion:** no open project combines plain-text source with stable block IDs, proofed agent patches, a hosted wiki and governance. The open lane is real but empty, and the funnel is what's missing.

---

## 2. Honest state of Noma (2026-10-02)

### 2.1 Product: deep and broad

The core is strong. The format and patch engine are:
- 25 patch ops with `baseHash` preconditions;
- backed by a 55-fixture conformance suite;
- seeded with a native Python implementation.

Cloud has spaces, a tree, history, a Visual editor with Yjs co-editing, Ask with citations, ⌘K, Chat, Work, approvals, governance, imports (Confluence, Notion, Slack, Jira) and compliance. The UI audit hit **zero runtime errors** across every surface.

### 2.2 Distribution: broken

| Signal | State | Evidence |
|---|---|---|
| npm | **0.15.0 (June)**; repo at 0.19.0 | `npm view @ferax564/noma-cli versions` |
| Why | Release run #3 (v0.19.0) failed: *"4 package version(s) need publishing but no NPM_TOKEN secret is configured"*. The tag was still created, so every later push-to-main run sees `v0.19.0 already exists` and **skips silently**. 0.16–0.18 were never published either. | Actions run 36224075716 |
| Template CI | `noma init --template docs-repo` pins `@ferax564/noma-cli@0.19.0`, which **does not exist on npm**, so a new user's first CI run fails | init-docs-repo.ts |
| GitHub | 0★, 0 forks, no homepage set, no topics; the only open issue is a bot's | repo metadata |
| Landing badge | "v0.17.0", a tag that does not exist; the `uses: ferax564/noma@v0.17.0` snippet resolves to nothing | site/index.html |
| Claude Code plugin | version 0.15.0 | .claude-plugin/plugin.json |
| Hosted demo / sign-up / waitlist / analytics | None. The only Cloud link opens a static page that shows "Failed to fetch / No spaces" | `cloud-static.png` |

### 2.3 Messaging: four stories at once

- Site `<title>`: *"Proof-before-apply docs for AI agents"*
- Site H1: *"Let agents update docs without rewriting docs"* (the June CLI story)
- README: *"The wiki for the agentic-AI era"* / *"the next Notion and Confluence"*
- `docs/direction.noma`: *"Confluence-class team wiki"*, then *"a plain-text source format"* on the same screen
- package.json and the GitHub description: *"readable document format for humans and agents"*

None of them mentions Work, Chat or the dev loop. The landing page names about 30 surfaces, has 12 nav items, 4 equal-weight CTAs, and no product screenshot. It runs to about 16,000px on a phone.

### 2.4 Frontend: functional, not yet credible next to Space

The full list is in Appendix A. The ones that matter strategically:

1. **The differentiating loop is the worst-presented part of the app.** "Agent Review" is a raw JSON textarea at the bottom of the inspector. Its default op targets `research-paper-draft`, so on most pages **"Preview in Draft" errors immediately**: `block "research-paper-draft" not found`. A pending proposal shows "warn · 93.3% preserved" with Approve/Reject and **no inline diff**.
2. **No top-level navigation.** Work, Chat, Approvals and Agents are about 25 stacked sections in a 280px right column. The Work board is a five-column Kanban crammed into the sidebar.
3. **Bug: entering Preview hides every panel and stays that way.** `web/cloud/layout.ts:30` persists `panelsOpen=false` to localStorage.
4. **No first-run path.** A logged-out visitor sees disabled chrome. A new user lands in a research-paper template already showing health warnings.
5. **Internals leak:**
   - dashed outlines around every block in Preview;
   - `EXCERPT id=… / Style / Attributes` chrome on every block in Visual mode;
   - raw `@{a036ab96…}` user IDs and `{#task-…}` markers in source;
   - `::children` rendering as an empty box on the space home;
   - about 14 equal-weight buttons in the page header;
   - about 30 native `window.prompt`/`confirm` calls.
6. **Weight and dependencies:**
   - one 965 KB (289 KB gzip) bundle with no code splitting;
   - Inter loaded from a third-party CDN (an enterprise privacy flag);
   - Preview stays white in dark mode;
   - on mobile, the page body starts about 1000px down.

**What's genuinely good:**
- ⌘K grouped across pages, issues and messages;
- Chat, the most polished surface, and fine on mobile;
- Ask with confidence, numbered citations and block hashes;
- the approvals queue with capability class, sha256 binding and "Pause all agents";
- live presence in the editor.

---

## 3. Strategy

### 3.1 One-sentence position

> **Noma is the open, self-hostable team wiki where any AI agent can propose edits to any block — and nothing changes until a human approves a verified diff.**

Short form for headlines: **"The wiki your agents can edit — and you can audit."**

**Three proof pillars** (every page, deck and demo repeats these, in this order):

1. **Agents propose, humans approve.**
   - Block-level patches by stable ID, with a proof: diff, validation, before/after preview.
   - Applied only against a matching content hash.
   - Append-only audit trail.
2. **Any agent, any model.**
   - Claude Code, Codex, Cursor, ChatGPT and your own, over MCP, CLI or SDK.
   - Never locked to one vendor's assistant.
3. **You own it.**
   - Plain-text `.noma` in Git.
   - Self-host in minutes, or use hosted.
   - Import from Confluence, Notion, Slack and Jira; export everything.

Work, Chat, the dev loop, decks and DOCX are **supporting features** ("everything your team needs around the wiki"), not headline claims.

### 3.2 Target customer (narrow on purpose)

**Primary ICP:** engineering organisations of 20–500 people where several engineers already use coding agents daily (Claude Code, Codex, Cursor), docs live partly in Git and partly in Confluence or Notion, and at least one of these holds:
- (a) a regulated or EU data-residency need;
- (b) a mixed-model policy, i.e. not all-in on OpenAI;
- (c) leadership nervous about agents writing to shared knowledge unsupervised.

**Secondary:** open-source projects that want agent-maintained docs in their repo, using the docs-repo template and the GitHub Action. These are the cheapest path to stars and the first external consumer (§25.3 exit criterion 2).

**Not now:** general business teams, consumers and agencies. Space wins those on distribution.

### 3.3 Ride the wave, don't fight it

1. **Be reachable from ChatGPT.** Add OAuth 2.1 to the existing remote MCP endpoint (`POST /api/agents/mcp`, token auth today) so Noma can be added as a connector in ChatGPT, Claude.ai and Codex. Then the pitch becomes *"Keep using ChatGPT Space for chat — let it read and propose edits to your Noma wiki, under your approval."* Being neutral is something OpenAI can't copy, so make it a feature they effectively distribute.
2. **Own the comparison searches** while they're hot: a "Noma vs ChatGPT Space" page and an "Open-source, self-hosted ChatGPT Space alternative" page. Be honest that Space is great for chat-first teams, and argue that governed knowledge needs ownership.
3. **Import path from Space,** as soon as its export format is known: Markdown, HTML or an API. That gives every team that tries Space and hits the lock-in or governance wall a one-click "bring your pages to Noma".
4. **Integrate, don't compete, with open agent projects.** Write a Noma adapter for OpenAgents (shared threads → durable `.noma` pages) and a post on "OpenSpace skills that maintain your docs". Their communities are early users.
5. **Launch in the window.** Ship the W0–W3 items below and launch within about three weeks (target **2026-10-23**). After that, Space's novelty fades and the comparison stops pulling traffic.

### 3.4 Focus: keep, polish, hide

| Surface | Decision | Why |
|---|---|---|
| Format, patch engine, conformance, v1.0 freeze | **Keep, finish** | The moat; becoming a standard is something OpenAI won't do |
| Wiki + Visual editor + co-editing | **Polish (P0)** | Table stakes against Space |
| Agent proposal → proof → approve → apply | **Make it the hero (P0)** | The differentiator; currently the weakest UI |
| Ask with citations, ⌘K | Keep, light polish | Already good |
| MCP / CLI / SDK / Claude plugin / Action | **Polish + distribute (P0)** | The "any agent" pillar |
| Imports (Confluence, Notion, Slack, Jira) | Keep, feature in onboarding | The switching story |
| Chat | Keep, move to a top-level tab | Best-polished surface; agents as members is on message |
| Work | Keep, give it a real page; no new features | Supporting |
| Dev loop (GitHub/CI → issues, `/deploy`, `/test`) | Keep for the ICP; second-tier in marketing | Strong for engineering teams, but a distraction on the homepage |
| Governance, DLP, SIEM, admin | Keep; move into Settings | Enterprise checklist, not the hero |
| PaperDOM canvas, `.pptx`, DOCX review loop, book sites | **Freeze**; docs only | Niche; maintenance cost |
| Enterprise `apps/`, `packages/*` extraction shims | **Freeze** | No customer is asking yet |
| New surfaces (whiteboards, databases, more run environments) | **No** until there are 5 active teams | Sprawl is the main risk |

**Rule for the next six weeks:** every merged PR either (a) fixes the funnel, (b) polishes the hero loop or first run, (c) improves agent reachability, or (d) fixes a bug. Anything else waits.

---

## 4. Workstreams and next steps

Priority key: **P0** before launch · **P1** within two weeks after launch · **P2** later.

### W0 — Ship-blockers (this week, about a day of work)

| # | Item | Detail |
|---|---|---|
| W0.1 | **Publish 0.19.0 to npm** | Add the `NPM_TOKEN` secret, or publish locally (`npm publish` for cli, mcp-server, lsp, agent-sdk), then re-run the release workflow so it creates the GitHub release. Consider npm trusted publishing (OIDC) to drop the token. |
| W0.2 | **Make the failure loud** | `release.yml` `detect`: when the tag exists, also check `npm view <pkg>@<version>` and **fail** when it's missing. Add the same check to `pages.yml` so the site never advertises an unpublished version. |
| W0.3 | Version strings from one source | Generate the landing badge, Action snippet, `.claude-plugin/plugin.json` and template pins from `package.json` at build time. Use `@v0` in snippets and maintain a moving `v0` tag. |
| W0.4 | Fix or hide the "Hosted Cloud" link | It currently shows "Failed to fetch". Point it at the live demo (W1.1), or remove it. |
| W0.5 | `noma init` template claims | `--template research-memo` etc. fail ("expected docs-repo"). Restore the starter templates or remove the claim from docs/CLAUDE.md. |
| W0.6 | GitHub repo hygiene | Set the homepage (Pages URL), topics (`wiki`, `ai-agents`, `mcp`, `confluence-alternative`, `self-hosted`, `knowledge-base`, `claude-code`), a social preview image, and an updated description: *"Open, self-hostable team wiki where AI agents propose block-level edits and humans approve them."* |
| W0.7 | Fix the Preview panel-collapse bug | `web/cloud/layout.ts:30`: don't persist `panelsOpen=false` on entering Preview; restore the previous state on exit. |
| W0.8 | Fix the Agent Review default op | Don't prefill an op aimed at a block that doesn't exist. Prefill with the current page's first block ID, or leave it empty with a placeholder. |

### W1 — The hero loop and first run (P0, about two weeks)

| # | Item | Detail |
|---|---|---|
| W1.1 | **Public live demo** | A read-only (or sandboxed, reset nightly) seeded space on ezkeel/Hetzner at `demo.<domain>`. Content: an engineering handbook, a pending agent proposal, a Work project and a channel. Link it from the hero as "Try the live wiki →". The UI-tour seed script (`scripts/cloud-ui-tour.ts`, `npm run tour:cloud`) is most of the work. |
| W1.1b | **One-command self-host** | Neither command exists today: `noma cloud` only does sync, and no image is published. Publish the existing `Dockerfile` as `ghcr.io/ferax564/noma` on every release, and add `noma cloud serve [--data dir]` to the CLI so `npx @ferax564/noma-cli cloud serve` boots a working wiki with a sample space. Both install lines on the site and in the README depend on this. |
| W1.2 | **Review view** (replaces the JSON textarea) | A full-width page per proposal: agent identity and trust tier → plan / reason → affected block IDs → a **rendered before/after diff** (reuse `noma proof`'s HTML) → validation and hash status → **Approve & apply** / Request changes / Reject. Inline comments on the diff. Keep raw JSON behind "Advanced". |
| W1.3 | **Inbox** | A top-bar badge with the pending count. Proposals, run requests and AI pages in one list (the approvals queue already exists; give it a page). Optional email/Slack notification. |
| W1.4 | **Top-level navigation** | A left icon rail: **Wiki · Inbox · Work · Chat · Agents · Settings**. Each gets a full-width view, and the inspector keeps only page context (outline, comments, Ask about this page, backlinks). |
| W1.5 | **First-run flow** | Logged out → a proper sign-in page, never disabled chrome. First login → "Create your space": blank, from a template (engineering handbook, ADRs, runbooks), or **Import** (Confluence / Notion / Markdown folder / Git repo). Then a 60-second guided moment: *"An agent suggested an edit — review it"* → approve → see the audit entry. That moment is the product's "aha". |
| W1.6 | **Connect-an-agent page** | Settings → Agents → "Connect": copy-paste config for Claude Code (plugin + MCP), Codex, Cursor, ChatGPT (once OAuth lands) and generic MCP, plus a test button that shows the agent's first `list_ids` call arriving. |
| W1.7 | Header declutter | View toggle (Read · Edit · Source) + Share + "…" overflow. Autosave with a status chip, so Save is only primary when the page has unsaved changes. |
| W1.8 | Hide internals in reading views | No dashed outlines in Read. Block chrome only on hover or selection in Edit. `due:` as date chips. Mentions shown by name. `{#task-…}` markers collapsed in Source (or folded by the editor). |
| W1.9 | Macros in Visual mode | Read-only expansion of `::children`, `::include`, `::excerpt` and `::issues`, so the space home doesn't look broken. |
| W1.10 | Settings out of the reading view | Space settings, style tokens, component kits, webhooks, DLP, SIEM and project creation all move to Settings pages. |
| W1.11 | Replace `window.prompt`/`confirm` | Use the existing `<dialog>` pattern for all ~30 calls (kill switch reason, AI draft prompt, …). |

### W2 — Agent reach (P0/P1)

| # | Item | Priority |
|---|---|---|
| W2.1 | **OAuth 2.1 + dynamic client registration on the remote MCP endpoint,** so Noma installs as a connector in ChatGPT, Claude.ai and Codex. Scopes map to the capability registry (read / propose / apply). Agent writes always go through proposals unless the trust tier allows auto-apply. | P0 |
| W2.2 | Submit to the MCP registry, Claude Code plugin marketplace and ChatGPT apps/connector directory once W2.1 lands. Bump `.claude-plugin` to the current version. | P0 |
| W2.3 | "Agent-ready docs in your repo": the docs-repo template + GitHub Action as a two-minute path (`npx @ferax564/noma-cli init --template docs-repo`), with a demo PR where Claude Code proposes and the Action posts the proof as a PR comment. | P0 |
| W2.4 | ChatGPT Space import (once the export format is known) + a generic "Markdown/HTML folder" import in the first-run flow. | P1 |
| W2.5 | OpenAgents adapter: a thread → `.noma` page, and agents in OpenAgents can propose Noma patches. | P2 |
| W2.6 | Publish the Python SDK to PyPI and move `noma-py-seed` to its own repo (also §25.3 criterion 3). | P1 |

### W3 — Landing page (P0)

**Structure** (replaces the current ~30-claim page; the tables move to docs):

1. **Hero.**
   - Headline: *"The wiki your agents can edit — and you can audit."*
   - Sub-line: *"Pages, issues and chat in plain-text `.noma`. Any agent — Claude, Codex, ChatGPT — proposes a block-level edit; you review the diff; it applies only if nothing changed underneath. Self-host it or use ours."*
   - Primary CTA **Try the live wiki**; secondary **Self-host in 5 minutes** (`docker run …`); tertiary text link "GitHub ★".
   - Visual: a **20–30 second loop** of an agent proposing → the Review view → approve → the page updates → the audit entry.
2. **The loop in three steps:** Propose → Prove → Approve, each with one screenshot. No CLI flags here.
3. **"Why not just ChatGPT Space / Notion AI / Rovo?"** A short, fair comparison on four rows: who owns the source · which agents can edit · how edits are reviewed · where it runs. Suggested copy: *"AI workspaces let the model rewrite your page. Noma makes it propose a diff to one block, shows you the proof, and applies only what you approve — in a file you own, with any model, on your own server."*
4. **Bring any agent:** a logo strip (Claude Code, Codex, Cursor, ChatGPT, MCP, VS Code, GitHub Action) linking to the connect docs.
5. **Everything around the wiki:** one row each for Work, Chat and the dev loop, with screenshots and one line apiece.
6. **Switch in an afternoon:** Confluence, Notion, Slack and Jira imports, plus export everything.
7. **Self-host or hosted:** Docker one-liner, EU hosting, SSO/OIDC, audit export. Hosted beta waitlist form.
8. **Built with Noma:** this project's own wiki and docs (dogfood), then design-partner logos once they exist.
9. **Footer:** docs, spec (with a "v1.0 freeze in progress" badge), GitHub, changelog.

**Mechanics:**
- Cut the nav to five items: Product · Compare · Docs · GitHub · **Try it**.
- Add a hamburger nav on mobile.
- Delete internal language ("wedge", "artifact", "escape hatches", "design test").
- Use the unused `workbench-*.png` assets or new Cloud screenshots.
- Add privacy-friendly analytics (Plausible or Umami, self-hosted) and an `og:image`.
- Version strings come from the build (W0.3).

**Separate pages:**
- `/compare/chatgpt-space`
- `/compare/confluence`
- `/compare/notion`
- `/self-host`
- `/for-open-source` (the docs-repo template story)

### W4 — README, docs, messaging (P0)

- **README first screen:** the one-sentence position, a GIF, then three install paths of three lines each:
  - *Run the wiki* (`docker run ghcr.io/ferax564/noma` / `npx @ferax564/noma-cli cloud serve`, both from W1.1b)
  - *Agent-ready docs in your repo* (`init --template docs-repo`)
  - *Connect your agent* (MCP)

  Move the 4,000-character "What ships today" paragraph to `docs/` and remove links to internal review/status memos.
- **One positioning string everywhere:** package.json `description`, GitHub description, site `<title>`, README H1, `docs/direction.noma` opening, `.claude-plugin` description. Fix the self-contradiction at the top of `docs/direction.noma`.
- **PLAN.md §23.24,** mirrored in `docs/direction.noma`: record the focus rule and the keep/polish/hide table above.
- A "Concepts in 5 minutes" doc: block IDs, proposals, proofs, hashes, trust tiers. One diagram.

### W5 — Frontend engineering polish (P1)

- **Code splitting:** load Chat, Work, admin, the visual editor and PaperDOM on demand. Target under 350 KB gzip for the first paint of a reading page; it's 289 KB gzip for *everything* today, so lazy surfaces should bring reading under 150 KB.
- **Self-host Inter,** with no third-party font CDN (enterprise privacy reviews flag this).
- **Dark mode:** dark paper preview; fix disabled-text contrast.
- **Mobile:** drawer for the rail, page content first, bottom tab bar (Wiki · Inbox · Chat · Search). Chat's mobile layout is the model.
- **Accessibility:** skip link; audit the 4 `outline:none` rules; keyboard reordering on the Work board; `aria-live` for proposal status changes; take headings out of `<summary>`.
- **Breadcrumbs:** no repeated space name.
- **⌘K snippets:** render or strip directive syntax (`claim id=… confidence=0.9` → the claim text).
- **Typography:** one body family across Read and Edit, or a deliberate serif "paper" mode as a setting.
- **Visual regression:** promote the audit script (Puppeteer + seeded server, 21 views × 2 viewports) into `npm run tour:cloud` in CI and diff screenshots per PR, so polish doesn't regress.

### W6 — Features worth adding (P1/P2, only after launch)

Each passes the focus rule because it strengthens a pillar or answers Space directly:

| Feature | Pillar | Note |
|---|---|---|
| **Meeting → decision page:** paste or upload a transcript; an agent proposes `::decision` / action-item blocks and Work issues, through Review | Answers Space's meeting summaries, governed | Reuses chat-thread → page |
| **Page chat:** Ask scoped to the current page, where answers can become proposals | Answers Space's page chat | Mostly UI over the existing Ask |
| **Interactive blocks showcase:** charts/plots, datasets, checklists, computed metrics | Answers "pages with dashboards" | Already supported; needs templates and a gallery |
| **Agent trust dashboard:** per-agent acceptance rate, reverted edits, blocks touched | Governance | The data already exists (decisions log) |
| **Auto-apply policies:** e.g. "typo fixes from trusted agents in space X auto-apply, everything else needs review" | Governance + speed | Keeps review from becoming a bottleneck |
| **Git-backed spaces as a first-class option:** the space *is* a repo; approvals become commits or PRs | Ownership | `noma cloud sync` exists; make it a one-toggle setting |
| Native SAML, PostgreSQL, multi-process realtime | Enterprise | Already listed in `docs/enterprise.noma`; do it when a design partner asks |

### W7 — Launch and distribution (target 2026-10-23)

**Pre-launch (weeks 1–3):**
- Recruit **5 design partners** from the ICP (personal network, Claude Code / Cursor communities, EU dev teams). Offer a free hosted instance or self-host support in exchange for weekly feedback, plus permission to quote them.
- Record a 90-second demo video: Claude Code proposes → Review view → approve → audit → the same page edited by ChatGPT through the connector.
- Write three posts:
  1. *"ChatGPT Space proves the AI wiki. Here's what it should have: proofs, ownership, any model."*
  2. *"Why agents should edit blocks, not pages"* (technical, with the patch protocol).
  3. *"Moving our docs from Confluence to Noma in an afternoon"* (dogfood or design partner).

**Launch day:** Show HN ("Show HN: Noma – an open-source wiki where AI agents propose edits and humans approve them"), r/selfhosted, r/LocalLLaMA (the any-model angle), Product Hunt, LinkedIn/X thread, Claude Code and MCP communities.

**Post-launch:**
- `good first issue` labels.
- The pinned *"help wanted: second implementation"* issue (§25.5).
- Weekly changelog posts.
- Answer every issue within 24 hours.

### W8 — Business model (decide before launch, keep simple)

- **Open core.** MIT for format, CLI, MCP, LSP, the Action and **self-hosted Cloud for small teams** (≤ 10 users or ungated features).
- **Hosted Noma Cloud (EU).** Per-seat pricing; agents don't count as seats; usage-based AI with bring-your-own key.
- **Enterprise (self-host or dedicated).** SSO/SAML, DLP/SIEM export, governance trust tiers, audit retention, support SLA. These features exist, so the license line is mostly packaging.
- Launch with a **waitlist plus "free during beta"**. Don't build billing yet; talk to every sign-up.

---

## 5. Sequenced plan

| Window | Deliverables | Exit check |
|---|---|---|
| **Week 1** (Oct 2–9) | W0 complete; one positioning string everywhere (W4); design-partner outreach begins; Space export format verified first-hand | npm shows 0.19.x; `init --template docs-repo` CI passes on a fresh repo |
| **Weeks 2–3** (Oct 9–23) | W1.1–W1.7, W2.1–W2.3, W3 landing page + compare pages, demo video, posts drafted | A stranger reaches the "approve an agent edit" moment on the live demo in < 2 minutes; ChatGPT and Claude.ai can add Noma as a connector |
| **Launch** (≈ Oct 23) | W7 launch day | — |
| **Weeks 4–6** | W1.8–W1.11, W5, W2.4/W2.6, respond to launch feedback | Design partners active weekly; visual regression in CI |
| **Weeks 7–12** | W6 items chosen by design-partner demand; v0.20 → v1.0 freeze path (§25) | First external consumer has run the loop for 30 days (§25.3 #2) |

---

## 6. Metrics (instrument before launch)

| Stage | Metric | 6-week target |
|---|---|---|
| Awareness | GitHub stars · landing visitors | 500★ · 10k visitors |
| Activation | Demo visitors who **approve an agent proposal** | ≥ 25% |
| Install | npm weekly downloads (CLI + MCP) · `docker pull`s | 300/wk · 200 |
| Adoption | Teams with ≥ 3 users and ≥ 1 connected agent, active weekly | 5 (design partners) |
| Value | Agent proposals approved per active team per week | ≥ 10 |
| Trust | Proposal approval rate · applies rejected by `baseHash` | Tracked, no target yet |

These targets are guesses meant to force instrumentation. Revisit them after launch week.

---

## 7. What to stop doing

- **Shipping new surfaces** before anyone outside the project uses the existing ones.
- **Merging releases without checking they reached users.** Two silent publish failures cost four versions (W0.2).
- **Describing internals in marketing:** hashes, `baseHash`, AST, directives and "artifacts" belong in docs. Lead with the outcome (*"nothing changes until you approve"*).
- **Equal-weight everything.** One primary action per screen, on the site and in the app.
- **Folding in more projects** (§23.23) until the umbrella has users. The sidecars stay optional and quiet.

---

## 8. Risks

| Risk | Mitigation |
|---|---|
| OpenAI adds export, an MCP write API and approvals to Space within months | Speed (launch in the window); depth of the governance loop; self-hosting and the open format are things they won't match |
| Notion or Atlassian ship "agent suggestions with review" | Same; any-model neutrality and plain-text Git source remain structural differences |
| Solo-maintainer bandwidth vs a 94k-LOC surface | The focus rule and freeze list (§3.4); design partners steer priorities; visual regression and conformance in CI catch breakage cheaply |
| The "approve everything" bottleneck makes agents feel slow | Auto-apply policies by trust tier (W6); batch review in the Inbox |
| Launching with the frontend still rough | W1 is gated on the "< 2 minutes to aha on the live demo" exit check; slip the launch a week rather than launch rough |

---

## 9. Decisions needed from the maintainer

1. **Approve the position and the focus rule** (§3.1, §3.4) → record as PLAN.md §23.24 + `docs/direction.noma`.
2. **npm publishing:** add an `NPM_TOKEN` secret, switch to npm trusted publishing, or publish locally.
3. **Demo hosting:** a public demo on ezkeel/Hetzner, plus a domain for the site and demo (a custom domain instead of `github.io` helps credibility).
4. **License line** for hosted and enterprise (§W8): what stays MIT and what is commercial.
5. **Launch date:** confirm ≈ 2026-10-23, or set the exit check as the gate instead of a date.
6. **Design partners:** who to approach first.

---

## Appendix A — UI audit (2026-10-02)

Seeded local server (3 users, a 6-page "Engineering Handbook" space, a PLAT project with 5 issues, `#platform` channel, a pending agent proposal), driven by Puppeteer at 1440×900 and 390×844. Zero page errors. Screenshots from this session were saved to the session scratchpad (`shots/d-*.png`, `shots/m-*.png`); regenerate with `npm run tour:cloud` or the audit script.

Ranked problems:
1. The agent review loop is buried and errors out of the box (W0.8, W1.2).
2. Preview hides all panels persistently (W0.7).
3. No top-level nav for Wiki, Work, Chat and Approvals (W1.4).
4. Weak first run (W1.5).
5. About 14 equal-weight header buttons (W1.7).
6. Mobile is a stacked desktop layout (W5).
7. Internals leak into Read and Edit (W1.8).
8. Macros don't render in Visual mode (W1.9).
9. Settings and admin forms clutter the reading view (W1.10).
10. Inconsistencies: duplicate breadcrumbs, white preview in dark mode, about 30 native prompts (W1.11, W5).

Good: ⌘K, Chat, Ask citations, the approvals queue's governance detail, live presence.

Code: vanilla TS + Tiptap/ProseMirror + Yjs; 48 modules, about 14.5k lines; `cloud-app.js` 965 KB minified (289 KB gzip), no splitting; `cloud.css` 75 KB with few breakpoints; `cloud.html` keeps 128 buttons and every panel in the DOM.

## Appendix B — Funnel audit (2026-10-02)

- The CLI quickstart from source works cleanly: `init` → `check` → `render` → `ids` → `proof` → `patch` → `check`, with `init` in about 0.6s. Minor: the LLM render duplicates the H1.
- Broken or stale:
  - npm 0.15.0;
  - template CI pins an unpublished version;
  - the v0.17.0 badge and Action snippet point at a nonexistent tag;
  - plugin version 0.15.0;
  - the Cloud link shows "Failed to fetch";
  - `init --template research-memo` fails despite docs.
- Missing: hosted demo, waitlist, pricing, analytics, social proof, product screenshots, repo homepage and topics.

## Appendix C — Sources

- [TechCrunch: OpenAI takes on Microsoft with ChatGPT Space](https://techcrunch.com/2026/09/29/openai-takes-on-microsoft-with-the-launch-of-what-feels-a-whole-lot-like-chatgpts-own-office-suite/)
- [Android Headlines: ChatGPT Space collaborative hub](https://www.androidheadlines.com/2026/09/openai-launches-chatgpt-space-collaborative-hub.html)
- [OpenAI launches ChatGPT Space (pasqualepillitteri.it)](https://pasqualepillitteri.it/en/news/19316/openai-launches-chatgpt-space)
- [AGTP on X](https://x.com/AGTPinsights/status/2105001661748183301)
- [OpenAI API changelog](https://developers.openai.com/api/docs/changelog)
- [HKUDS/OpenSpace](https://github.com/HKUDS/OpenSpace) · [openagents-org/openagents](https://github.com/openagents-org/openagents) · [gh0stcreator/openspace](https://github.com/gh0stcreator/openspace)
