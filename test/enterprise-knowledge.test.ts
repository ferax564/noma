import assert from "node:assert/strict";
import test from "node:test";
import { createTestOidc, EnterpriseWorkspace } from "../src/enterprise-workspace.js";
import { resetIdentitySequence } from "../src/stable-identity.js";

test("RAG evals measure recall, citation correctness, abstention, and permission leakage", () => {
  resetIdentitySequence(0);
  const oidc = createTestOidc({
    alice: { sub: "alice", email: "alice@example.com", name: "Alice" },
    bob: { sub: "bob", email: "bob@example.com", name: "Bob" },
  });
  const ws = new EnterpriseWorkspace({ oidc });
  const tenantId = ws.provisionTenant("Acme").tenantId;
  ws.scimUpsert(tenantId, { externalId: "alice", userName: "Alice", active: true });
  ws.scimUpsert(tenantId, { externalId: "bob", userName: "Bob", active: true });
  const alice = ws.loginOidc(tenantId, "alice").actor;
  const bob = ws.loginOidc(tenantId, "bob").actor;
  ws.bootstrapGrant(tenantId, alice.principalId, "tenant", tenantId, "owner");
  const spaceId = ws.createSpace(alice, "Public");
  ws.bootstrapGrant(tenantId, bob.principalId, "space", spaceId, "editor");
  const secretSpace = ws.createSpace(alice, "Secret", "restricted");
  const publicDoc = ws.createDocument(alice, { spaceId, title: "Public soak", source: "# Public\n\nVisible thermal soak.\n" });
  const secretDoc = ws.createDocument(alice, { spaceId: secretSpace, title: "Secret price", source: "# Secret\n\n900 million.\n" });
  ws.publishDocument(alice, publicDoc);
  ws.publishDocument(alice, secretDoc);
  const aliceEval = ws.evaluateRetrieval(alice, [
    { id: "q1", question: "soak", expectedSourceIds: [publicDoc] },
    { id: "q2", question: "unanswerable-xyz", expectedSourceIds: [], unanswerable: true },
  ]);
  assert.equal(aliceEval.meanRecall, 1);
  assert.equal(aliceEval.citationAccuracy, 1);
  const bobEval = ws.evaluateRetrieval(bob, [
    { id: "q3", question: "million", expectedSourceIds: [], restrictedSourceIds: [secretDoc], unanswerable: true },
  ]);
  assert.equal(bobEval.leakageRate, 0);
  ws.recordKnowledgeHealth(alice, {
    kind: "stale_review",
    resourceId: publicDoc,
    detail: { reviewDueAt: "2026-01-01T00:00:00.000Z" },
  });
  ws.putReference(alice, {
    from: { kind: "document", id: publicDoc },
    to: { kind: "document", id: publicDoc },
    relation: "contradicts",
  });
  ws.recordKnowledgeHealth(alice, { kind: "contradiction_candidate", resourceId: publicDoc, detail: { note: "review" } });
  assert.ok(ws.knowledgeQueue(alice).length >= 2);
  assert.equal(ws.knowledgeQueue(bob).filter((row) => row.resource_id === secretDoc).length, 0);
  ws.close();
});
