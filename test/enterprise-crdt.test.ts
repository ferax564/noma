import assert from "node:assert/strict";
import test from "node:test";
import { applyCrdtOps, crdtOpsConflict } from "../src/enterprise-crdt.js";
import { EnterpriseError } from "../src/enterprise-contracts.js";
import { createTestOidc, EnterpriseWorkspace } from "../src/enterprise-workspace.js";
import { resetIdentitySequence } from "../src/stable-identity.js";

function harness() {
  resetIdentitySequence(0);
  const oidc = createTestOidc({
    alice: { sub: "alice", email: "alice@example.com", name: "Alice" },
    bob: { sub: "bob", email: "bob@example.com", name: "Bob" },
  });
  const ws = new EnterpriseWorkspace({ oidc, now: () => "2026-09-13T12:00:00.000Z" });
  const tenantId = ws.provisionTenant("Acme").tenantId;
  ws.scimUpsert(tenantId, { externalId: "alice", userName: "Alice", active: true });
  ws.scimUpsert(tenantId, { externalId: "bob", userName: "Bob", active: true });
  const alice = ws.loginOidc(tenantId, "alice").actor;
  const bob = ws.loginOidc(tenantId, "bob").actor;
  ws.bootstrapGrant(tenantId, alice.principalId, "tenant", tenantId, "owner");
  const spaceId = ws.createSpace(alice, "Docs");
  ws.bootstrapGrant(tenantId, bob.principalId, "space", spaceId, "editor");
  return { ws, alice, bob, spaceId };
}

test("CRDT persist-before-ack survives lost acknowledgements and reconnect replay", () => {
  const { ws, alice, spaceId } = harness();
  const documentId = ws.createDocument(alice, {
    spaceId,
    title: "Live",
    source: `{#a}\nAlpha.\n\n{#b}\nBravo.\n`,
  });
  assert.throws(
    () =>
      ws.persistCollaborativeUpdate(alice, {
        documentId,
        clientId: "c1",
        clientSeq: 1,
        ops: [{ kind: "replace_paragraph", blockId: "a", content: "Acked alpha." }],
        simulateLostAck: true,
      }),
    (err: unknown) => err instanceof EnterpriseError && err.code === "invalid",
  );
  const replay = ws.reconnectDraft(alice, documentId, 0);
  assert.equal(replay.length, 1);
  assert.equal(ws.readDocument(alice, documentId).source.includes("Acked alpha."), true);
  const retry = ws.persistCollaborativeUpdate(alice, {
    documentId,
    clientId: "c1",
    clientSeq: 1,
    ops: [{ kind: "replace_paragraph", blockId: "a", content: "Acked alpha." }],
  });
  assert.equal(retry.replayed, true);
  assert.equal(ws.readDocument(alice, documentId).source.match(/Acked alpha/g)?.length, 1);
  ws.close();
});

test("independent concurrent block edits merge; overlapping edits conflict", () => {
  const { ws, alice, bob, spaceId } = harness();
  const documentId = ws.createDocument(alice, {
    spaceId,
    title: "Live",
    source: `{#a}\nAlpha.\n\n{#b}\nBravo.\n`,
  });
  ws.persistCollaborativeUpdate(alice, {
    documentId,
    clientId: "alice",
    clientSeq: 1,
    lastAckedSeq: 0,
    ops: [{ kind: "replace_paragraph", blockId: "a", content: "Alice alpha." }],
  });
  ws.persistCollaborativeUpdate(bob, {
    documentId,
    clientId: "bob",
    clientSeq: 1,
    lastAckedSeq: 0,
    ops: [{ kind: "replace_paragraph", blockId: "b", content: "Bob bravo." }],
  });
  const source = ws.readDocument(alice, documentId).source;
  assert.match(source, /Alice alpha/);
  assert.match(source, /Bob bravo/);
  assert.equal(crdtOpsConflict([{ kind: "replace_paragraph", blockId: "a", content: "x" }], [{ kind: "replace_paragraph", blockId: "a", content: "y" }]), true);
  assert.throws(
    () =>
      ws.persistCollaborativeUpdate(bob, {
        documentId,
        clientId: "bob",
        clientSeq: 2,
        lastAckedSeq: 0,
        ops: [{ kind: "replace_paragraph", blockId: "a", content: "clash" }],
      }),
    (err: unknown) => err instanceof EnterpriseError && err.code === "conflict",
  );
  const merged = applyCrdtOps(`{#a}\nA.\n\n{#b}\nB.\n`, [
    { kind: "replace_paragraph", blockId: "a", content: "A2." },
    { kind: "replace_paragraph", blockId: "b", content: "B2." },
  ]);
  assert.match(merged, /A2/);
  assert.match(merged, /B2/);
  ws.close();
});
