import assert from "node:assert/strict";
import test from "node:test";
import { listenEnterpriseHttp } from "../src/enterprise-http.js";
import { seedEnterpriseProductFixture } from "../src/enterprise-shell.js";
import { paperCanvasMarkup, paperCommentPin, paperStickyColor } from "../src/enterprise-paperdom.js";
import { translateSqliteToPostgres } from "../src/enterprise-sql.js";
import { postgresRuntimeAvailable } from "../src/enterprise-pg-sync.js";
import { createTestOidc, EnterpriseWorkspace } from "../src/enterprise-workspace.js";
import { resetIdentitySequence } from "../src/stable-identity.js";

function harness() {
  resetIdentitySequence(0);
  const oidc = createTestOidc({
    alice: { sub: "alice", email: "alice@example.com", name: "Alice Chen" },
    bob: { sub: "bob", email: "bob@example.com", name: "Bob Lee" },
  });
  const ws = new EnterpriseWorkspace({ oidc });
  const tenantId = ws.provisionTenant("Atlas").tenantId;
  ws.scimUpsert(tenantId, { externalId: "alice", userName: "Alice Chen", active: true });
  const session = ws.loginOidc(tenantId, "alice");
  ws.bootstrapGrant(tenantId, session.actor.principalId, "tenant", tenantId, "owner");
  return { ws, session };
}

test("page tree, comments, mentions, revisions, and attachments are kernel-backed", () => {
  const { ws, session } = harness();
  const spaceId = ws.createSpace(session.actor, "Docs");
  const parent = ws.createDocument(session.actor, { spaceId, title: "Root", source: "# Root\n\nHello.\n" });
  ws.publishDocument(session.actor, parent);
  const child = ws.createDocument(session.actor, { spaceId, parentId: parent, title: "Child", source: "# Child\n\nNested.\n" });
  ws.renameDocument(session.actor, child, "Child page");
  ws.moveDocument(session.actor, child, parent);
  const comment = ws.addDocumentComment(session.actor, parent, "@alice please look");
  assert.ok(comment.mentions.includes(session.actor.principalId));
  assert.equal(ws.listDocumentComments(session.actor, parent).length, 1);
  const restored = ws.restoreDocumentRevision(session.actor, parent, 1);
  assert.ok(restored.hash);
  const attached = ws.attachDocumentAsset(session.actor, parent, {
    bytes: Buffer.from("hello"),
    mime: "text/plain",
    filename: "notes.txt",
  });
  assert.equal(ws.listDocumentAssets(session.actor, parent)[0]?.filename, "notes.txt");
  assert.ok(attached.assetId);
  const shell = ws.workspaceShell(session.actor);
  assert.equal(shell.documents.find((doc) => doc.id === child)?.parentId, parent);
  ws.close();
});

test("workspaces, permissions, media, arrows, and GitHub/issue links", () => {
  const { ws, session } = harness();
  ws.scimUpsert(session.actor.tenantId, { externalId: "bob", userName: "Bob Lee", active: true });
  const bob = ws.loginOidc(session.actor.tenantId, "bob");
  const spaceId = ws.createSpace(session.actor, "Studio", "internal", { homePage: true });
  const home = ws.workspaceShell(session.actor).documents.find((doc) => doc.spaceId === spaceId);
  assert.equal(home?.title, "Home");
  const page = home!.id;
  ws.grant(session.actor, {
    principalId: bob.actor.principalId,
    resourceKind: "space",
    resourceId: spaceId,
    role: "viewer",
  });
  assert.ok(ws.listResourceGrants(session.actor, "space", spaceId).some((grant) => grant.principalId === bob.actor.principalId));
  assert.equal(ws.readDocument(bob.actor, page).title, "Home");
  assert.throws(
    () =>
      ws.addExternalLink(session.actor, {
        fromKind: "document",
        fromId: page,
        provider: "github",
        url: "https://example.com/not-github",
      }),
    (error: unknown) => error instanceof Error && /github.com/.test(error.message),
  );
  assert.ok(
    ws.addExternalLink(session.actor, {
      fromKind: "document",
      fromId: page,
      provider: "github",
      url: "https://github.com/ferax564/noma",
    }),
  );
  const projectId = ws.createProject(session.actor, { key: "STUDIO", name: "Studio", spaceId });
  const issue = ws.createIssue(session.actor, { projectId, typeKey: "task", summary: "Ship media" });
  ws.addExternalLink(session.actor, { fromKind: "document", fromId: page, provider: "issue", issueId: issue.id });
  assert.ok(ws.listExternalLinks(session.actor, "document", page).some((link) => link.provider === "issue"));
  assert.ok(ws.dependents(session.actor, page).some((row) => row.to_id === issue.id));
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
    "base64",
  );
  const attached = ws.attachDocumentAsset(session.actor, page, { bytes: png, mime: "image/png", filename: "pixel.png" });
  ws.embedDocumentMedia(session.actor, page, { kind: "image", assetId: attached.assetId, filename: "pixel.png" });
  assert.match(ws.readDocument(session.actor, page).source, /::figure/);
  assert.equal(ws.inspectAsset(session.actor, attached.assetId).mime, "image/png");
  assert.equal(ws.inspectAsset(bob.actor, attached.assetId).mime, "image/png");
  const artifactId = ws.createArtifact(session.actor, { spaceId, title: "Review deck" });
  const from = ws.insertArtifactElement(session.actor, artifactId, { type: "shape", text: "Docs", altText: "Docs" });
  const to = ws.insertArtifactElement(session.actor, artifactId, { type: "shape", text: "Work", altText: "Work" });
  ws.insertArtifactElement(session.actor, artifactId, { type: "arrow", fromId: from.id, toId: to.id, altText: "flow" });
  ws.insertArtifactElement(session.actor, artifactId, {
    type: "video",
    href: "https://example.com/demo.mp4",
    altText: "demo",
  });
  const board = ws.readArtifact(session.actor, artifactId, "draft");
  assert.ok(board.document.elements.some((el) => el.type === "arrow" && el.fromId === from.id));
  assert.ok(board.document.elements.some((el) => el.type === "video"));
  ws.close();
});

test("issue detail, real transitions, sprints, JQL, worklog, and rank", () => {
  const { ws, session } = harness();
  const spaceId = ws.createSpace(session.actor, "Work");
  const projectId = ws.createProject(session.actor, { key: "OPS", name: "Ops", spaceId });
  const created = ws.createIssue(session.actor, { projectId, typeKey: "task", summary: "Triage inbox" });
  ws.updateIssue(session.actor, created.id, { description: "Need a human" });
  ws.transitionIssue(session.actor, created.id, "todo");
  const transitions = ws.listIssueTransitions(session.actor, created.id);
  assert.ok(transitions.some((item) => item.to === "in_progress"));
  assert.throws(
    () => ws.transitionIssue(session.actor, created.id, "done"),
    (error: unknown) => error instanceof Error && /no transition/.test(error.message),
  );
  const board = ws.listBoards(session.actor, projectId)[0] as { id: string };
  const sprintId = ws.createSprint(session.actor, board.id, "S1");
  ws.startSprint(session.actor, sprintId);
  ws.setIssueSprint(session.actor, created.id, sprintId);
  ws.logWork(session.actor, { issueId: created.id, durationSeconds: 1200, note: "triage" });
  ws.addIssueComment(session.actor, created.id, "logged time");
  const second = ws.createIssue(session.actor, { projectId, typeKey: "bug", summary: "Leak" });
  ws.rankIssues(session.actor, projectId, [second.id, created.id]);
  const filtered = ws.queryIssues(session.actor, projectId, "status = backlog");
  assert.ok(filtered.some((issue) => issue.id === second.id));
  assert.throws(
    () => ws.queryIssues(session.actor, projectId, "labels = x"),
    (error: unknown) => error instanceof Error && /unsupported JQL field/.test(error.message),
  );
  const detail = ws.readIssue(session.actor, created.id);
  assert.equal((detail.worklogs as unknown[]).length, 1);
  ws.close();
});

test("HTTP productizes docs, work, admin, import loss report, and notifications", async () => {
  const { ws, session } = harness();
  const fixture = seedEnterpriseProductFixture(ws, session.actor);
  const server = await listenEnterpriseHttp({ workspace: ws });
  const origin = `http://127.0.0.1:${server.port}`;
  const auth = { authorization: `Bearer ${session.token}`, "content-type": "application/json" };
  try {
    const created = await fetch(`${origin}/v1/documents`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ spaceId: fixture.spaceId, title: "HTTP page", parentId: fixture.documentId }),
    }).then((res) => res.json()) as { id: string };
    assert.ok(created.id);
    await fetch(`${origin}/v1/documents/${created.id}/comments`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ body: "@alice from HTTP" }),
    });
    const comments = await fetch(`${origin}/v1/documents/${created.id}/comments`, { headers: auth }).then((res) => res.json()) as {
      comments: unknown[];
    };
    assert.equal(comments.comments.length, 1);
    await fetch(`${origin}/v1/documents/${created.id}/publish`, { method: "POST", headers: auth });
    const importResult = await fetch(`${origin}/v1/spaces/${fixture.spaceId}/import/confluence`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        title: "Imported",
        xml: `<p>Hi</p><ac:structured-macro ac:name="toc"><ac:parameter ac:name="">x</ac:parameter></ac:structured-macro>`,
      }),
    }).then((res) => res.json()) as { documentId: string; lossReport: Array<{ name: string }> };
    assert.equal(importResult.lossReport[0]?.name, "toc");
    const issue = await fetch(`${origin}/v1/projects/${fixture.projectId}/issues`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ summary: "From HTTP", typeKey: "task" }),
    }).then((res) => res.json()) as { id: string; key: string };
    await fetch(`${origin}/v1/issues/${issue.id}/comments`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ body: "ship it" }),
    });
    await fetch(`${origin}/v1/issues/${issue.id}/worklog`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ durationSeconds: 600 }),
    });
    const jql = await fetch(`${origin}/v1/projects/${fixture.projectId}/issues?jql=${encodeURIComponent("labels = urgent")}`, { headers: auth });
    assert.equal(jql.status, 400);
    const jqlBody = await jql.json() as { field?: string; reported?: boolean };
    assert.equal(jqlBody.field, "labels");
    assert.equal(jqlBody.reported, true);
    await fetch(`${origin}/v1/sprints/${fixture.sprintId}/close`, { method: "POST", headers: auth, body: JSON.stringify({ carry: true }) });
    const admin = await fetch(`${origin}/v1/admin`, { headers: auth }).then((res) => res.json()) as { spaces: unknown[] };
    assert.ok(admin.spaces.length >= 1);
    const notes = await fetch(`${origin}/v1/notifications`, { headers: auth }).then((res) => res.json()) as { notifications: Array<{ id: string }> };
    assert.ok(notes.notifications.length >= 1);
    await fetch(`${origin}/v1/notifications/${notes.notifications[0]!.id}/read`, { method: "POST", headers: auth });
    const space = await fetch(`${origin}/v1/spaces`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ name: "HTTP workspace" }),
    }).then((res) => res.json()) as { id: string };
    const home = await fetch(`${origin}/v1/workspace`, { headers: auth }).then((res) => res.json()) as {
      documents: Array<{ id: string; spaceId: string; title: string }>;
    };
    assert.ok(home.documents.some((doc) => doc.spaceId === space.id && doc.title === "Home"));
    const github = await fetch(`${origin}/v1/documents/${fixture.documentId}/links`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ provider: "github", url: "https://github.com/ferax564/noma/pull/38" }),
    }).then((res) => res.json()) as { id: string };
    assert.ok(github.id);
    const badGithub = await fetch(`${origin}/v1/documents/${fixture.documentId}/links`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ provider: "github", url: "https://example.com/not-github" }),
    });
    assert.equal(badGithub.status, 400);
    const issueLink = await fetch(`${origin}/v1/issues/${issue.id}/links`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ provider: "document", documentId: fixture.documentId }),
    }).then((res) => res.json()) as { id: string };
    assert.ok(issueLink.id);
    const png = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
      "base64",
    );
    const media = await fetch(`${origin}/v1/documents/${created.id}/media`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ kind: "image", filename: "pixel.png", mime: "image/png", contentBase64: png.toString("base64") }),
    }).then((res) => res.json()) as { assetId: string };
    const asset = await fetch(`${origin}/v1/assets/${media.assetId}?token=${encodeURIComponent(session.token)}`);
    assert.equal(asset.status, 200);
    assert.equal(asset.headers.get("content-type"), "image/png");
    const board = await fetch(`${origin}/v1/artifacts`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ spaceId: fixture.spaceId, title: "HTTP deck" }),
    }).then((res) => res.json()) as { id: string };
    await fetch(`${origin}/v1/artifacts/${board.id}/elements`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ type: "shape", text: "A", altText: "A" }),
    });
    await fetch(`${origin}/v1/artifacts/${board.id}/elements`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({ type: "shape", text: "B", altText: "B" }),
    });
    const readBoard = await fetch(`${origin}/v1/artifacts/${board.id}`, { headers: auth }).then((res) => res.json()) as {
      document: { elements: Array<{ id: string; type: string }> };
    };
    const firstId = readBoard.document.elements[0]?.id;
    const moved = await fetch(`${origin}/v1/artifacts/${board.id}/elements/${firstId}`, {
      method: "PATCH",
      headers: auth,
      body: JSON.stringify({ geometry: { x: 120, y: 80 } }),
    });
    assert.equal(moved.status, 200);
    const afterMove = await fetch(`${origin}/v1/artifacts/${board.id}`, { headers: auth }).then((res) => res.json()) as {
      document: { elements: Array<{ id: string; geometry: { x: number; y: number } }> };
    };
    assert.equal(afterMove.document.elements.find((el) => el.id === firstId)?.geometry.x, 120);
    const arrow = await fetch(`${origin}/v1/artifacts/${board.id}/elements`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        type: "arrow",
        fromId: readBoard.document.elements[0]?.id,
        toId: readBoard.document.elements[1]?.id,
        altText: "A to B",
      }),
    }).then((res) => res.json()) as { id: string };
    assert.ok(arrow.id);
    const marked = await fetch(`${origin}/v1/artifacts/${board.id}`, { headers: auth }).then((res) => res.json()) as { html: string };
    assert.match(marked.html, /pd-el-arrow/);
    const exportReport = await fetch(`${origin}/v1/artifacts/${board.id}/export?target=svg`, { headers: auth }).then((res) => res.json()) as {
      supported: string[];
      completeOfficeFidelity: boolean;
    };
    assert.ok(exportReport.supported.includes("shape"));
    assert.equal(exportReport.completeOfficeFidelity, false);
    const reports = await fetch(`${origin}/v1/projects/${fixture.projectId}/reports`, { headers: auth }).then((res) => res.json()) as {
      throughput: Array<{ completed: number }>;
      cycleTime: Array<{ key: string }>;
      cumulativeFlow: unknown[];
    };
    assert.ok(reports.throughput.some((point) => point.completed >= 1));
    assert.ok(reports.cycleTime.some((row) => row.key.startsWith("ATLAS-")));
    assert.ok(reports.cumulativeFlow.length >= 1);
  } finally {
    await server.close();
    ws.close();
  }
});

test("sqlite-to-postgres translation keeps ignore/replace semantics", () => {
  assert.match(translateSqliteToPostgres("INSERT OR IGNORE INTO spaces(id) VALUES (?)"), /ON CONFLICT DO NOTHING/);
  assert.match(translateSqliteToPostgres("INSERT OR REPLACE INTO documents(id, title) VALUES (?, ?)"), /ON CONFLICT \(id\) DO UPDATE SET title = excluded.title/);
  assert.equal(translateSqliteToPostgres("SELECT * FROM issues WHERE id = ?"), "SELECT * FROM issues WHERE id = $1");
});

test("sticky notes keep color in PaperDOM markup", () => {
  assert.equal(paperStickyColor("Sticky"), "yellow");
  assert.equal(paperStickyColor("Sticky:pink"), "pink");
  assert.equal(paperStickyColor("Sticky:green"), "green");
  const html = paperCanvasMarkup({
    id: "board",
    title: "Notes",
    schemaVersion: 1,
    revision: 1,
    elements: [
      {
        id: "note",
        type: "shape",
        geometry: { x: 8, y: 8, width: 120, height: 80 },
        zIndex: 1,
        text: "Risk",
        altText: "Sticky:blue",
      },
    ],
  });
  assert.match(html, /pd-el-sticky-blue/);
  assert.match(html, /data-sticky="blue"/);
});

test("quoted comments, flags, comment pins, and canvas delete are kernel-backed", () => {
  assert.equal(paperCommentPin("Comment"), true);
  assert.equal(paperCommentPin("Sticky:pink"), false);
  const pin = paperCanvasMarkup({
    id: "board",
    title: "Notes",
    schemaVersion: 1,
    revision: 1,
    elements: [
      {
        id: "pin",
        type: "shape",
        geometry: { x: 16, y: 16, width: 140, height: 64 },
        zIndex: 1,
        text: "Call this out in review",
        altText: "Comment",
      },
    ],
  });
  assert.match(pin, /pd-el-comment/);
  assert.match(pin, /data-comment="true"/);

  const { ws, session } = harness();
  try {
    const fixture = seedEnterpriseProductFixture(ws, session.actor);
    const shell = ws.workspaceShell(session.actor);
    assert.ok(shell.issues.some((issue) => issue.flagged && /leak/i.test(issue.summary)));
    assert.ok(shell.issues.some((issue) => issue.typeKey === "subtask" && issue.parentId));
    ws.addDocumentComment(session.actor, fixture.documentId, "Need a sharper claim", "One login should take a team");
    const comments = ws.listDocumentComments(session.actor, fixture.documentId);
    assert.ok(comments.some((comment) => comment.quote === "One login should take a team"));
    assert.ok(shell.issues.some((issue) => issue.watching && /PaperDOM/i.test(issue.summary)));
    ws.deleteArtifactElement(session.actor, fixture.artifactId, "note-comment");
    const board = ws.readArtifact(session.actor, fixture.artifactId, "draft");
    assert.equal(board.document.elements.some((element) => element.id === "note-comment"), false);
  } finally {
    ws.close();
  }
});

test("postgres can be a running store when a runtime is available", async (t) => {
  if (!postgresRuntimeAvailable("pglite:memory")) {
    t.skip("PGlite is not installed");
    return;
  }
  const oidc = createTestOidc({ alice: { sub: "alice", email: "alice@example.com", name: "Alice" } });
  const ws = new EnterpriseWorkspace({ oidc, postgresUrl: "pglite:memory" });
  try {
    const tenantId = ws.provisionTenant("Pg").tenantId;
    ws.scimUpsert(tenantId, { externalId: "alice", userName: "Alice", active: true });
    const session = ws.loginOidc(tenantId, "alice");
    ws.bootstrapGrant(tenantId, session.actor.principalId, "tenant", tenantId, "owner");
    const spaceId = ws.createSpace(session.actor, "Docs");
    const documentId = ws.createDocument(session.actor, { spaceId, title: "PG", source: "# PG\n\nHi.\n" });
    assert.equal(ws.readDocument(session.actor, documentId).title, "PG");
    const projectId = ws.createProject(session.actor, { key: "PG", name: "PG", spaceId });
    const issue = ws.createIssue(session.actor, { projectId, typeKey: "task", summary: "pg issue" });
    assert.match(issue.key, /^PG-/);
  } finally {
    ws.close();
  }
});
