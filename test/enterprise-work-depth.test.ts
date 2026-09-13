import assert from "node:assert/strict";
import test from "node:test";
import { createTestOidc, EnterpriseWorkspace } from "../src/enterprise-workspace.js";
import { resetIdentitySequence } from "../src/stable-identity.js";

function harness() {
  resetIdentitySequence(0);
  const oidc = createTestOidc({
    alice: { sub: "alice", email: "alice@example.com", name: "Alice" },
    bob: { sub: "bob", email: "bob@example.com", name: "Bob" },
  });
  let t = Date.parse("2026-09-01T00:00:00.000Z");
  const ws = new EnterpriseWorkspace({
    oidc,
    now: () => new Date(t).toISOString(),
    id: () => {
      t += 1000;
      return `id_${t}`;
    },
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
  return { ws, alice, bob, projectId, spaceId, tenantId };
}

test("work reports derive throughput, cycle time, and CFD from events", () => {
  const { ws, alice, projectId } = harness();
  const one = ws.createIssue(alice, { projectId, typeKey: "task", summary: "One", estimate: 3 });
  const two = ws.createIssue(alice, { projectId, typeKey: "task", summary: "Two", estimate: 5 });
  ws.transitionIssue(alice, one.id, "todo");
  ws.transitionIssue(alice, one.id, "in_progress");
  ws.transitionIssue(alice, one.id, "in_review");
  ws.transitionIssue(alice, one.id, "done", { resolution: "completed" });
  ws.transitionIssue(alice, two.id, "todo");
  const flow = ws.cumulativeFlow(alice, projectId);
  assert.ok(flow[flow.length - 1]!.done >= 1);
  assert.ok(ws.throughput(alice, projectId).some((point) => point.completed >= 1));
  assert.ok(ws.cycleTime(alice, projectId).some((row) => row.issueId === one.id && row.hours >= 0));
  ws.close();
});

test("bulk edit preview and issue security do not leak or apply silently", () => {
  const { ws, alice, bob, projectId } = harness();
  const open = ws.createIssue(alice, { projectId, typeKey: "task", summary: "Open" });
  const secret = ws.createIssue(alice, { projectId, typeKey: "task", summary: "Secret payroll" });
  const level = ws.defineIssueSecurityLevel(alice, projectId, "payroll");
  ws.setIssueSecurity(alice, secret.id, level);
  const preview = ws.bulkEditPreview(alice, [open.id, secret.id], { status: "todo" });
  assert.equal(preview.wouldChange.length, 2);
  const bobOpen = ws.queryIssues(bob, projectId, { type: "contains", field: "summary", value: "Open" });
  const bobSecret = ws.queryIssues(bob, projectId, { type: "contains", field: "summary", value: "payroll" });
  assert.equal(bobOpen.length, 1);
  assert.equal(bobSecret.length, 0);
  ws.grantIssueSecurity(alice, level, bob.principalId);
  assert.equal(ws.queryIssues(bob, projectId, { type: "contains", field: "summary", value: "payroll" }).length, 1);
  ws.close();
});

test("recipes emit changesets and unsupported JQL is reported rather than approximated", () => {
  const { ws, alice, spaceId, projectId } = harness();
  const documentId = ws.createDocument(alice, {
    spaceId,
    title: "Notes",
    source: `{#decision}\nPending.\n\n{#runbook}\nEmpty.\n`,
  });
  const agentId = ws.createPrincipal(alice.tenantId, { kind: "agent", name: "bot", capabilities: ["changeset.propose"] });
  const agent = ws.createSession({ id: agentId, tenant_id: alice.tenantId, kind: "agent" }).actor;
  ws.bootstrapGrant(alice.tenantId, agentId, "space", spaceId, "editor");
  const ran = ws.runRecipe(agent, "meeting-notes-to-decisions", { documentId, blockId: "decision", decision: "Ship the slice." });
  assert.ok(ran.changesetId);
  const record = ws.changeset(ran.changesetId!, alice.tenantId);
  assert.equal(record.operations[0]?.op, "replace_paragraph");
  assert.throws(() => ws.compileQuery("status WAS done", alice.principalId), /unsupported JQL/);
  void projectId;
  ws.close();
});
