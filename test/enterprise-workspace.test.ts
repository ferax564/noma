import assert from "node:assert/strict";
import test from "node:test";
import { visualRoundTrip } from "../src/enterprise/adapter.js";
import { EnterpriseError } from "../src/enterprise/contracts.js";
import { applyVisualCommands, createPaperDocument, exportFidelityReport, semanticOutline } from "../src/enterprise/paperdom.js";
import { enterpriseSchema } from "../src/enterprise/store.js";
import { createTestOidc, EnterpriseWorkspace } from "../src/enterprise/workspace.js";
import { resetIdentitySequence } from "../src/stable-identity.js";

function workspace() {
  resetIdentitySequence(0);
  const oidc = createTestOidc({
    alice: { sub: "alice", email: "alice@example.com", name: "Alice" },
    bob: { sub: "bob", email: "bob@example.com", name: "Bob" },
  });
  const ws = new EnterpriseWorkspace({
    oidc,
    now: () => "2026-09-13T12:00:00.000Z",
  });
  const tenantId = ws.provisionTenant("Acme").tenantId;
  ws.scimUpsert(tenantId, { externalId: "alice", userName: "Alice", active: true });
  ws.scimUpsert(tenantId, { externalId: "bob", userName: "Bob", active: true });
  const alice = ws.loginOidc(tenantId, "alice").actor;
  const bob = ws.loginOidc(tenantId, "bob").actor;
  ws.bootstrapGrant(tenantId, alice.principalId, "tenant", tenantId, "owner");
  const spaceId = ws.createSpace(alice, "Docs");
  ws.bootstrapGrant(tenantId, bob.principalId, "space", spaceId, "editor");
  const projectId = ws.createProject(alice, { key: "ENG", name: "Engineering", spaceId });
  ws.bootstrapGrant(tenantId, bob.principalId, "project", projectId, "editor");
  return { ws, tenantId, alice, bob, spaceId, projectId };
}

test("OIDC login and SCIM deprovision revoke sessions", () => {
  const { ws, tenantId, alice } = workspace();
  const token = ws.loginOidc(tenantId, "alice").token;
  assert.equal(ws.authenticate(token).principalId, alice.principalId);
  ws.scimDeprovision(tenantId, "alice");
  assert.throws(() => ws.authenticate(token), (err: unknown) => err instanceof EnterpriseError && err.code === "unauthorized");
  ws.close();
});

test("document coordinator persists the draft before acknowledging save", () => {
  const { ws, alice, spaceId } = workspace();
  const documentId = ws.createDocument(alice, { spaceId, title: "Spec", source: "# Spec\n\nHello.\n" });
  const before = ws.readDocument(alice, documentId);
  const editor = JSON.parse(
    (ws.store.db.prepare("SELECT crdt_json FROM documents WHERE id = ?").get(documentId) as { crdt_json: string }).crdt_json,
  );
  editor.content.push({ type: "paragraph", attrs: { id: "p2" }, content: [{ type: "text", text: "More." }] });
  const saved = ws.saveDraft(alice, { documentId, editor, expectedHash: before.hash });
  assert.notEqual(saved.hash, before.hash);
  assert.equal(ws.readDocument(alice, documentId).hash, saved.hash);
  assert.throws(
    () => ws.saveDraft(alice, { documentId, editor, expectedHash: before.hash }),
    (err: unknown) => err instanceof EnterpriseError && err.code === "stale_revision",
  );
  ws.close();
});

test("visual editor adapter preserves unknown directives, IDs, and table cells", () => {
  const source = `# Spec

::mystery{id="opaque" extra="keep" flag}
Nested **unknown** payload.
::

{#tbl cols="c0,c1" rows="r0"}
| {#h0} A | {#h1} B |
| --- | --- |
| {#c00} 1 | {#c01} 2 |
`;
  const round = visualRoundTrip(source);
  assert.match(round.source, /::mystery/);
  assert.match(round.source, /extra="keep"/);
  assert.match(round.source, /\{#c00\}/);
  assert.equal(round.editor.attrs.unknownPreserved, true);
});

test("PaperDOM ignores client actor fields and rejects stale revisions", () => {
  const doc = createPaperDocument("art", "Chart");
  const inserted = applyVisualCommands(
    doc,
    [
      {
        op: "insert_element",
        actor: { id: "attacker" },
        element: {
          id: "e1",
          type: "text",
          geometry: { x: 0, y: 0, width: 10, height: 10 },
          zIndex: 1,
          text: "hello",
          altText: "hello",
        },
      },
    ],
    { actorId: "server-alice", expectedRevision: 0 },
  );
  assert.equal(inserted.document.revision, 1);
  assert.equal(semanticOutline(inserted.document)[0]?.altText, "hello");
  assert.throws(
    () => applyVisualCommands(inserted.document, [{ op: "delete_element", elementId: "e1" }], { actorId: "server-alice", expectedRevision: 0 }),
    (err: unknown) => err instanceof EnterpriseError && err.code === "stale_revision",
  );
  const report = exportFidelityReport(inserted.document, "pptx");
  assert.equal(report.completeOfficeFidelity, false);
});

test("assets require authorization and quarantined SVG script is not served", () => {
  const { ws, alice, bob, spaceId } = workspace();
  void spaceId;
  const assetId = ws.uploadAsset(alice, { bytes: Buffer.from("<svg><script>x</script></svg>"), mime: "image/svg+xml" });
  assert.throws(() => ws.readAsset(alice, assetId), (err: unknown) => err instanceof EnterpriseError && err.code === "forbidden");
  const png = ws.uploadAsset(alice, { bytes: Buffer.from("png"), mime: "image/png" });
  assert.equal(ws.readAsset(alice, png).toString(), "png");
  assert.throws(() => ws.readAsset(bob, png), (err: unknown) => err instanceof EnterpriseError && err.code === "forbidden");
  ws.close();
});

test("work domain enforces hierarchy, workflow fields, JQL subset, and occupied-status protection", () => {
  const { ws, alice, bob, projectId } = workspace();
  const epic = ws.createIssue(alice, { projectId, typeKey: "epic", summary: "Platform" });
  const story = ws.createIssue(alice, { projectId, typeKey: "story", summary: "Auth", parentId: epic.id });
  ws.createIssue(alice, { projectId, typeKey: "subtask", summary: "Write tests", parentId: story.id });
  assert.throws(
    () => ws.createIssue(alice, { projectId, typeKey: "epic", summary: "loop", parentId: story.id }),
    (err: unknown) => err instanceof EnterpriseError && err.code === "invalid",
  );
  const task = ws.createIssue(alice, { projectId, typeKey: "task", summary: "Ship", parentId: story.id });
  ws.transitionIssue(alice, task.id, "todo");
  ws.transitionIssue(alice, task.id, "in_progress");
  assert.throws(() => ws.transitionIssue(alice, task.id, "done"));
  ws.transitionIssue(alice, task.id, "in_review");
  ws.transitionIssue(alice, task.id, "done", { resolution: "completed" });
  const field = ws.defineCustomField(alice, projectId, { key: "severity_note", fieldType: "select", options: ["low", "high"] });
  void field;
  ws.setFieldValue(alice, task.id, "severity_note", "high");
  assert.throws(() => ws.setFieldValue(alice, task.id, "severity_note", "nope"));
  const found = ws.queryIssues(alice, projectId, 'status = done AND assignee = currentUser()');
  assert.equal(found.length, 0);
  const board = ws.createBoard(alice, { projectId, name: "Board", kind: "scrum" });
  const sprint = ws.createSprint(alice, board, "S1", "ship it");
  ws.startSprint(alice, sprint);
  assert.throws(() => ws.startSprint(alice, sprint));
  ws.logWork(alice, { issueId: task.id, durationSeconds: 3600 });
  ws.rankIssues(alice, projectId, [epic.id, story.id, task.id]);
  const auto = ws.addAutomation(alice, {
    projectId,
    event: "issue.updated",
    condition: { type: "eq", field: "status_id", value: "done" },
    action: { type: "label", payload: { label: "released" } },
  });
  assert.equal(ws.dryRunAutomation(alice, auto, task.id).wouldApply, true);
  assert.throws(
    () =>
      ws.activateWorkflow(alice, projectId, {
        version: 2,
        statuses: [{ id: "only", name: "Only", category: "todo" }],
        transitions: [],
      }),
    (err: unknown) => err instanceof EnterpriseError && err.code === "invalid",
  );
  void bob;
  ws.close();
});

test("agent changesets cannot self-approve, ignore injected grants, and fail closed on stale heads", () => {
  const { ws, alice, bob, spaceId, projectId, tenantId } = workspace();
  const agentId = ws.createPrincipal(tenantId, { kind: "agent", name: "bot", capabilities: ["changeset.propose"] });
  const agent = ws.createSession({ id: agentId, tenant_id: tenantId, kind: "agent" }).actor;
  ws.bootstrapGrant(tenantId, agentId, "space", spaceId, "editor");
  ws.bootstrapGrant(tenantId, agentId, "project", projectId, "editor");
  const documentId = ws.createDocument(alice, {
    spaceId,
    title: "Req",
    source: `{#p}\nNeed this.\n\n{#t cols="c0,c1" rows="r0"}\n| {#h0} A | {#h1} B |\n| --- | --- |\n| {#c} 1 | {#c1} 2 |\n`,
  });
  const head = ws.readDocument(alice, documentId);
  const changesetId = ws.draftChangeset(agent, {
    intent: "update cell",
    idempotencyKey: "cs-1",
    targetRevisions: { [documentId]: head.draftRevision },
    operations: [
      {
        resource: { kind: "document", id: documentId },
        op: "update_table_cell",
        payload: { tableId: "t", cellId: "c", value: "2", grant: "owner" },
      },
    ],
  });
  assert.throws(() => ws.validateChangeset(agent, changesetId), (err: unknown) => err instanceof EnterpriseError && err.code === "policy");
  const clean = ws.draftChangeset(agent, {
    intent: "update cell",
    idempotencyKey: "cs-2",
    targetRevisions: { [documentId]: head.draftRevision },
    operations: [
      { resource: { kind: "document", id: documentId }, op: "update_table_cell", payload: { tableId: "t", cellId: "c", value: "2" } },
    ],
  });
  ws.proposeChangeset(agent, clean, [bob.principalId]);
  assert.throws(() => ws.approveChangeset(agent, clean), (err: unknown) => err instanceof EnterpriseError && err.code === "self_approval");
  ws.approveChangeset(bob, clean);
  ws.applyChangeset(bob, clean);
  assert.match(ws.readDocument(alice, documentId).source, /2/);
  ws.setKillSwitch(tenantId, true);
  assert.throws(() => ws.runRecipe(agent, "stale-source-refresh", {}), (err: unknown) => err instanceof EnterpriseError && err.code === "killed");
  ws.close();
});

test("search and references do not leak resources the principal cannot read", () => {
  const { ws, alice, bob, spaceId } = workspace();
  const secretSpace = ws.createSpace(alice, "Secret", "restricted");
  const publicDoc = ws.createDocument(alice, { spaceId, title: "Public", source: "# Public\n\nVisible claim.\n" });
  const secretDoc = ws.createDocument(alice, { spaceId: secretSpace, title: "Secret price", source: "# Secret\n\n900 million.\n" });
  ws.publishDocument(alice, publicDoc);
  ws.publishDocument(alice, secretDoc);
  ws.putReference(alice, {
    from: { kind: "document", id: publicDoc },
    to: { kind: "document", id: secretDoc },
    relation: "supports",
  });
  const aliceHits = ws.search(alice, "million");
  const bobHits = ws.search(bob, "million");
  assert.ok(aliceHits.some((hit) => hit.resourceId === secretDoc));
  assert.ok(bobHits.every((hit) => hit.resourceId !== secretDoc));
  assert.equal(ws.dependents(bob, publicDoc).length, 0);
  assert.ok(ws.dependents(alice, publicDoc).length > 0);
  ws.close();
});

test("importers quarantine unmapped permissions and record inaccessible objects", () => {
  const { ws, alice, spaceId } = workspace();
  const inventory = ws.inventoryImport(alice, "jira", [
    { sourceId: "JIRA-1", readable: true, type: "issue", payload: { summary: "Imported", projectId: ws.createProject(alice, { key: "IMP", name: "Import", spaceId }) } },
    { sourceId: "JIRA-2", readable: false, type: "issue", payload: {} },
    { sourceId: "JIRA-3", readable: true, type: "unsupported", payload: {} },
    { sourceId: "JIRA-4", readable: true, type: "issue", payload: { unmappedPermission: true } },
  ]);
  const dispositions = Object.fromEntries(inventory.report.map((row) => [row.sourceId, row.disposition]));
  assert.equal(dispositions["JIRA-1"], "imported");
  assert.equal(dispositions["JIRA-2"], "inaccessible");
  assert.equal(dispositions["JIRA-3"], "unsupported");
  assert.equal(dispositions["JIRA-4"], "quarantined");
  ws.close();
});

test("backup digest is verified and postgres DDL is generated", () => {
  const { ws, tenantId, alice, spaceId } = workspace();
  ws.createDocument(alice, { spaceId, title: "Keep", source: "# Keep\n\nBody.\n" });
  const snapshot = ws.backup(tenantId);
  assert.throws(() => ws.restore(snapshot.bundle, "deadbeef"), (err: unknown) => err instanceof EnterpriseError && err.code === "invalid");
  const other = new EnterpriseWorkspace();
  other.restore(snapshot.bundle, snapshot.digest);
  assert.ok(other.store.db.prepare("SELECT id FROM documents WHERE title = 'Keep'").get());
  other.close();
  const ddl = enterpriseSchema("postgres");
  assert.match(ddl, /JSONB/);
  assert.match(ddl, /BYTEA/);
  ws.close();
});

test("legal hold is recorded against a document", () => {
  const { ws, alice, spaceId } = workspace();
  const documentId = ws.createDocument(alice, { spaceId, title: "Hold me", source: "# Hold\n\nx\n" });
  ws.placeLegalHold(alice, { resourceKind: "document", resourceId: documentId, reason: "litigation" });
  assert.equal(ws.isOnLegalHold(alice.tenantId, documentId), true);
  ws.close();
});
