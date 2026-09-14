import { escapeAttr } from "./inline.js";
import type { ActorContext } from "./enterprise-contracts.js";
import type { VisualCommand } from "./enterprise-paperdom.js";
import type { EnterpriseWorkspace } from "./enterprise-workspace.js";

export interface EnterpriseShellHtmlOptions {
  css?: string;
  script?: string;
  tenantId?: string;
  demoUser?: string;
}

export function enterpriseWorkspaceHtml(options: EnterpriseShellHtmlOptions = {}): string {
  const css = options.css
    ? `<style>${options.css}</style>`
    : `<link rel="stylesheet" href="/assets/enterprise-workspace.css" />`;
  const script = options.script
    ? `<script>${options.script.replace(/<\/script/gi, "<\\/script")}</script>`
    : `<script src="/assets/enterprise-workspace.js"></script>`;
  const tenant = options.tenantId
    ? `<meta name="noma-tenant-id" content="${escapeAttr(options.tenantId)}" />`
    : "";
  const demo = options.demoUser
    ? `<meta name="noma-demo-user" content="${escapeAttr(options.demoUser)}" />`
    : "";
  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <meta name="theme-color" content="#a64f2b" />
    <title>Noma — Docs, Visuals, Work</title>
    <link rel="icon" href="data:," />
    ${tenant}
    ${demo}
    <link rel="preconnect" href="https://rsms.me/" />
    <link rel="stylesheet" href="https://rsms.me/inter/inter.css" />
    ${css}
  </head>
  <body>
    <div class="ew-atmosphere" aria-hidden="true">
      <span class="ew-orb ew-orb-a"></span>
      <span class="ew-orb ew-orb-b"></span>
      <span class="ew-orb ew-orb-c"></span>
      <span class="ew-noise"></span>
    </div>
    <div id="login-gate" class="ew-gate" hidden>
      <div class="ew-gate-card">
        <div class="ew-brand-mark" aria-hidden="true"></div>
        <p class="ew-kicker">Noma enterprise</p>
        <h1>Sign in to the workspace</h1>
        <p class="ew-lede">One session for documents, canvases, and native work.</p>
        <label for="login-tenant">Tenant
          <input id="login-tenant" name="tenant" autocomplete="organization" />
        </label>
        <label for="login-token">IdP subject
          <input id="login-token" name="idToken" autocomplete="username" placeholder="alice" />
        </label>
        <div class="ew-gate-actions">
          <button id="login-submit" type="button">Continue</button>
          <button id="login-demo" type="button">Open demo session</button>
        </div>
        <p id="login-error" class="ew-error" role="alert"></p>
      </div>
    </div>
    <div id="workspace-shell" class="ew-shell">
      <header class="ew-topbar">
        <a class="ew-brand" href="/">
          <span class="ew-brand-mark" aria-hidden="true"></span>
          <span class="ew-brand-copy">
            <strong>Noma</strong>
            <em>Enterprise</em>
          </span>
        </a>
        <div class="ew-modes" role="tablist" aria-label="Workspace mode">
          <button id="mode-docs" type="button" role="tab" aria-selected="true" data-mode="docs">Docs</button>
          <button id="mode-visuals" type="button" role="tab" aria-selected="false" data-mode="visuals">Visuals</button>
          <button id="mode-work" type="button" role="tab" aria-selected="false" data-mode="work">Work</button>
          <button id="mode-admin" type="button" role="tab" aria-selected="false" data-mode="admin">Admin</button>
        </div>
        <label class="ew-search" for="workspace-search">Search
          <input id="workspace-search" type="search" placeholder="Find pages, canvases, issues" autocomplete="off" />
        </label>
        <button id="notify-toggle" type="button" aria-expanded="false" aria-controls="notify-drawer">Inbox</button>
        <button id="theme-toggle" type="button" aria-pressed="false">Dark</button>
        <span id="session-status" class="ew-status" data-state="connecting" aria-live="polite">Connecting</span>
      </header>
      <div class="ew-body">
        <aside class="ew-rail" aria-label="Workspace navigation">
          <div class="ew-rail-head">
            <p class="ew-kicker" id="rail-kicker">Pages</p>
            <h2 id="rail-title">Product</h2>
          </div>
          <div id="rail-actions" class="ew-rail-actions"></div>
          <div id="rail-list" class="ew-rail-list"></div>
        </aside>
        <main class="ew-main">
          <section id="canvas-docs" class="ew-canvas is-active" data-mode="docs">
            <div id="doc-toolbar" class="ew-toolbar" role="toolbar" aria-label="Document formatting">
              <button type="button" data-cmd="bold" aria-label="Bold"><b>B</b></button>
              <button type="button" data-cmd="italic" aria-label="Italic"><i>I</i></button>
              <button type="button" data-cmd="strike" aria-label="Strikethrough"><s>S</s></button>
              <button type="button" data-cmd="heading" data-level="1" aria-label="Heading 1">H1</button>
              <button type="button" data-cmd="heading" data-level="2" aria-label="Heading 2">H2</button>
              <button type="button" data-cmd="bullet" aria-label="Bullet list">List</button>
              <button type="button" data-cmd="ordered" aria-label="Ordered list">1.</button>
              <span id="collab-status" class="ew-chip">idle</span>
              <label for="insert-image">Insert image<input id="insert-image" type="file" accept="image/*" /></label>
              <label for="insert-video">Insert video<input id="insert-video" type="file" accept="video/*" /></label>
              <button id="doc-publish" type="button">Publish</button>
            </div>
            <article class="ew-paper">
              <p class="ew-kicker" id="doc-kicker">Draft</p>
              <h1 id="doc-title">Untitled</h1>
              <div id="editor" class="ew-editor"></div>
              <div id="doc-media" class="ew-media-strip" aria-label="Page media"></div>
            </article>
            <section id="doc-discussion" class="ew-discussion" aria-label="Page comments">
              <h2>Comments</h2>
              <div id="doc-comments"></div>
              <label for="doc-comment-input">Comment
                <textarea id="doc-comment-input" rows="2" placeholder="Write a comment. Mention with @alice"></textarea>
              </label>
              <button id="doc-comment-submit" type="button">Add comment</button>
            </section>
          </section>
          <section id="canvas-visuals" class="ew-canvas" data-mode="visuals" hidden>
            <div class="ew-visual-chrome">
              <p class="ew-kicker">Presentation</p>
              <h1 id="visual-title">Untitled board</h1>
              <div id="visual-toolbar" class="ew-toolbar ew-visual-toolbar" role="toolbar" aria-label="Canvas tools">
                <label for="new-board-title">Board title<input id="new-board-title" placeholder="Q3 review" /></label>
                <button type="button" id="create-board">New presentation</button>
                <button type="button" id="add-frame">Add frame</button>
                <label for="arrow-from">From
                  <select id="arrow-from"></select>
                </label>
                <label for="arrow-to">To
                  <select id="arrow-to"></select>
                </label>
                <button type="button" id="add-arrow">Add arrow</button>
                <label for="canvas-image">Canvas image<input id="canvas-image" type="file" accept="image/*" /></label>
                <label for="canvas-video">Canvas video<input id="canvas-video" type="file" accept="video/*" /></label>
              </div>
            </div>
            <div id="visual-stage" class="ew-visual-stage"></div>
          </section>
          <section id="canvas-work" class="ew-canvas" data-mode="work" hidden>
            <div class="ew-work-chrome">
              <p class="ew-kicker">Board</p>
              <h1 id="work-title">Work</h1>
              <div id="sprint-bar" class="ew-sprint"></div>
              <label class="ew-jql" for="jql-input">JQL
                <input id="jql-input" type="search" placeholder="status = in_progress AND assignee = currentUser()" autocomplete="off" />
              </label>
              <p id="jql-error" class="ew-error" role="alert"></p>
            </div>
            <div id="work-board" class="ew-board"></div>
          </section>
          <section id="canvas-admin" class="ew-canvas" data-mode="admin" hidden>
            <div class="ew-work-chrome">
              <p class="ew-kicker">Directory</p>
              <h1>Spaces, projects, grants</h1>
            </div>
            <div id="admin-panel" class="ew-admin"></div>
          </section>
        </main>
        <aside class="ew-inspector" aria-label="Inspector">
          <p class="ew-kicker">Context</p>
          <h2 id="inspector-title">Session</h2>
          <div id="inspector" class="ew-inspector-body"></div>
          <div id="search-results" class="ew-search-results" hidden></div>
          <div id="visual-outline" class="ew-outline"></div>
        </aside>
      </div>
    </div>
    <aside id="notify-drawer" class="ew-drawer" hidden>
      <div class="ew-drawer-head">
        <p class="ew-kicker">Inbox</p>
        <h2>Notifications</h2>
        <button id="notify-close" type="button" aria-label="Close inbox">Close</button>
      </div>
      <div id="notify-list"></div>
    </aside>
    <div id="import-modal" class="ew-gate" hidden>
      <div class="ew-gate-card">
        <p class="ew-kicker">Confluence import</p>
        <h1>Paste storage XML</h1>
        <p class="ew-lede">Unsupported macros are kept as loss-report blocks, not dropped silently.</p>
        <label for="import-title">Title
          <input id="import-title" />
        </label>
        <label for="import-xml">Confluence storage
          <textarea id="import-xml" rows="8" placeholder="<p>Imported page</p>"></textarea>
        </label>
        <div class="ew-gate-actions">
          <button id="import-submit" type="button">Import</button>
          <button id="import-cancel" type="button">Cancel</button>
        </div>
        <p id="import-error" class="ew-error" role="alert"></p>
      </div>
    </div>
    ${script}
  </body>
</html>`;
}

export interface EnterpriseProductFixture {
  spaceId: string;
  documentId: string;
  artifactId: string;
  projectId: string;
  issueKeys: string[];
  childDocumentId: string;
  boardId: string;
  sprintId: string;
}

function advanceIssue(ws: EnterpriseWorkspace, actor: ActorContext, issueId: string, target: string): void {
  const path: Record<string, string[]> = {
    todo: ["todo"],
    in_progress: ["todo", "in_progress"],
    in_review: ["todo", "in_progress", "in_review"],
    done: ["todo", "in_progress", "in_review", "done"],
  };
  for (const to of path[target] ?? []) {
    ws.transitionIssue(actor, issueId, to, to === "done" ? { resolution: "completed" } : undefined);
  }
}

export function seedEnterpriseProductFixture(ws: EnterpriseWorkspace, actor: ActorContext): EnterpriseProductFixture {
  const spaceId = ws.createSpace(actor, "Product");
  const documentId = ws.createDocument(actor, {
    spaceId,
    title: "Q3 strategy memo",
    source: `---
title: Q3 strategy memo
---

# Q3 strategy memo

The hosted workspace is the product surface: documents, canvases, and work share one session.

::claim{id="north-star" confidence=0.9}
One login should take a team from a brief to a board without changing tools.
::

{#p}
Tiptap persists through Yjs only after the host acknowledges the update. Visual frames keep geometry. Issues inherit the same identity and grants.
`,
  });
  ws.publishDocument(actor, documentId);
  const childId = ws.createDocument(actor, {
    spaceId,
    parentId: documentId,
    title: "Risks and open questions",
    source: `# Risks and open questions\n\nChild page in the Product tree.\n`,
  });
  ws.addDocumentComment(actor, documentId, "@alice please review the north-star claim.");
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
  );
  const image = ws.attachDocumentAsset(actor, documentId, { bytes: png, mime: "image/png", filename: "pixel.png" });
  ws.embedDocumentMedia(actor, documentId, { kind: "image", assetId: image.assetId, filename: "pixel.png" });
  const artifactId = ws.createArtifact(actor, { spaceId, title: "Atlas architecture" });
  const commands: VisualCommand[] = [
    {
      op: "insert_element",
      element: {
        id: "hero",
        type: "text",
        geometry: { x: 48, y: 36, width: 640, height: 64 },
        zIndex: 4,
        text: "Atlas architecture",
        altText: "Board title",
      },
    },
    {
      op: "insert_element",
      element: {
        id: "subtitle",
        type: "text",
        geometry: { x: 48, y: 100, width: 520, height: 36 },
        zIndex: 4,
        text: "Docs, visuals, and work on one grant graph.",
        altText: "Board subtitle",
      },
    },
    {
      op: "insert_element",
      element: {
        id: "card-docs",
        type: "shape",
        geometry: { x: 48, y: 168, width: 250, height: 150 },
        zIndex: 2,
        text: "Docs\nHosted Tiptap + Yjs\npersist-before-ack",
        altText: "Docs card",
      },
    },
    {
      op: "insert_element",
      element: {
        id: "card-visuals",
        type: "shape",
        geometry: { x: 322, y: 168, width: 250, height: 150 },
        zIndex: 2,
        text: "Visuals\nPaperDOM frames\nserver-derived actors",
        altText: "Visuals card",
      },
    },
    {
      op: "insert_element",
      element: {
        id: "card-work",
        type: "shape",
        geometry: { x: 596, y: 168, width: 250, height: 150 },
        zIndex: 2,
        text: "Work\nNative issues\nshared search",
        altText: "Work card",
      },
    },
    {
      op: "insert_element",
      element: {
        id: "cycle",
        type: "chart",
        geometry: { x: 48, y: 348, width: 800, height: 220 },
        zIndex: 3,
        text: "Cycle time",
        altText: "Cycle time chart",
        chart: {
          datasetId: "cycle-time",
          datasetRevision: 1,
          values: [5, 6, 4, 7, 5],
          labels: ["W1", "W2", "W3", "W4", "W5"],
          units: "d",
        },
      },
    },
    {
      op: "insert_element",
      element: {
        id: "flow-docs-work",
        type: "arrow",
        geometry: { x: 0, y: 0, width: 900, height: 360 },
        zIndex: 8,
        altText: "Docs to Work",
        fromId: "card-docs",
        toId: "card-work",
      },
    },
    {
      op: "insert_element",
      element: {
        id: "hero-image",
        type: "image",
        geometry: { x: 870, y: 36, width: 72, height: 72 },
        zIndex: 3,
        altText: "pixel.png",
        imageAssetId: image.assetId,
      },
    },
  ];
  ws.applyArtifactCommands(actor, artifactId, commands, 0);
  const projectId = ws.createProject(actor, { key: "ATLAS", name: "Atlas", spaceId });
  const epic = ws.createIssue(actor, { projectId, typeKey: "epic", summary: "Ship the product shell" });
  const collab = ws.createIssue(actor, {
    projectId,
    typeKey: "story",
    summary: "Hosted collab in the Docs canvas",
    parentId: epic.id,
  });
  const canvas = ws.createIssue(actor, {
    projectId,
    typeKey: "story",
    summary: "PaperDOM stage instead of a paragraph dump",
    parentId: epic.id,
  });
  const board = ws.createIssue(actor, {
    projectId,
    typeKey: "task",
    summary: "Kanban with live transitions",
    parentId: canvas.id,
  });
  const leak = ws.createIssue(actor, { projectId, typeKey: "bug", summary: "Search must not leak restricted docs" });
  advanceIssue(ws, actor, epic.id, "in_progress");
  advanceIssue(ws, actor, collab.id, "in_review");
  advanceIssue(ws, actor, canvas.id, "todo");
  advanceIssue(ws, actor, board.id, "in_progress");
  advanceIssue(ws, actor, leak.id, "done");
  const existingBoard = ws.listBoards(actor, projectId)[0] as { id: string } | undefined;
  const boardId = existingBoard?.id ?? ws.createBoard(actor, { projectId, name: "Atlas board", kind: "scrum" });
  const sprintId = ws.createSprint(actor, boardId, "Sprint 1", "Ship the product surface");
  ws.startSprint(actor, sprintId);
  ws.setIssueSprint(actor, collab.id, sprintId);
  ws.setIssueSprint(actor, canvas.id, sprintId);
  ws.addIssueComment(actor, collab.id, "Hosted collab is on the sprint.");
  ws.logWork(actor, { issueId: collab.id, durationSeconds: 3600, note: "Wired persist-before-ack" });
  ws.addExternalLink(actor, {
    fromKind: "document",
    fromId: documentId,
    provider: "github",
    url: "https://github.com/ferax564/noma",
    label: "ferax564/noma",
  });
  ws.addExternalLink(actor, {
    fromKind: "document",
    fromId: documentId,
    provider: "issue",
    issueId: collab.id,
  });
  ws.addExternalLink(actor, {
    fromKind: "issue",
    fromId: collab.id,
    provider: "github",
    url: "https://github.com/ferax564/noma/issues/38",
  });
  ws.addExternalLink(actor, {
    fromKind: "issue",
    fromId: collab.id,
    provider: "document",
    documentId,
  });
  return {
    spaceId,
    documentId,
    artifactId,
    projectId,
    issueKeys: [epic.key, collab.key, canvas.key, board.key, leak.key],
    childDocumentId: childId,
    boardId,
    sprintId,
  };
}
