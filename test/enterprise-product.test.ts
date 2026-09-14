import assert from "node:assert/strict";
import test from "node:test";
import { listenEnterpriseHttp } from "../src/enterprise-http.js";
import { seedEnterpriseProductFixture } from "../src/enterprise-shell.js";
import { translateSqliteToPostgres } from "../src/enterprise-sql.js";
import { postgresRuntimeAvailable } from "../src/enterprise-pg-sync.js";
import { createTestOidc, EnterpriseWorkspace } from "../src/enterprise-workspace.js";
import { resetIdentitySequence } from "../src/stable-identity.js";

function harness() {
  resetIdentitySequence(0);
  const oidc = createTestOidc({ alice: { sub: "alice", email: "alice@example.com", name: "Alice Chen" } });
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
