import assert from "node:assert/strict";
import test from "node:test";
import { applyCrdtOps, crdtOpsConflict } from "../src/enterprise-crdt.js";
import { applyBlockOps, blockOpsConflict, detectBlockConflicts, mergeBlockEdits, type BlockOp } from "../src/enterprise-merge.js";
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

test("block merge persist-before-ack survives lost acknowledgements and reconnect replay", () => {
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
      }, {
        afterPersist: () => {
          throw new EnterpriseError("invalid", "simulated lost ack");
        },
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

const BASE = [
  "---",
  "title:   'Quoted   title'",
  "---",
  "",
  "{#a}",
  "Alpha   with  *odd*   spacing.",
  "",
  "{#b}",
  "Bravo.",
  "",
  "::note{id=\"n\"}",
  "{#t}",
  "| {#h1} Name | {#h2} Value |",
  "|:---|---:|",
  "| {#c1} one   | {#c2} 1 |",
  "| {#c3} two   | {#c4} 2 |",
  "::",
  "",
].join("\n");

test("block merge edits source in place instead of re-rendering the document", () => {
  const out = applyBlockOps(BASE, [
    { kind: "replace_paragraph", blockId: "b", content: "Bravo two." },
    { kind: "update_table_cell", tableId: "t", cellId: "c4", value: "a | b" },
  ]);
  const before = BASE.split("\n");
  const after = out.split("\n");
  assert.equal(after.length, before.length);
  const changed = before.map((line, i) => (line === after[i] ? -1 : i)).filter((i) => i >= 0);
  assert.deepEqual(changed, [8, 15], "only the paragraph line and the one table row change");
  assert.equal(after[8], "Bravo two.");
  assert.equal(after[15], "| {#c3} two | {#c4} a \\| b |");
  assert.equal(after[1], "title:   'Quoted   title'");
  assert.equal(after[5], "Alpha   with  *odd*   spacing.");
  assert.equal(after[14], "| {#c1} one   | {#c2} 1 |");
  assert.equal(applyCrdtOps, applyBlockOps, "deprecated alias points at the source-preserving implementation");
  assert.throws(() => applyBlockOps(BASE, [{ kind: "replace_paragraph", blockId: "missing", content: "x" }]), (err: unknown) =>
    err instanceof EnterpriseError && err.code === "not_found",
  );
  assert.throws(() => applyBlockOps(BASE, [{ kind: "update_table_cell", tableId: "t", cellId: "nope", value: "x" }]), (err: unknown) =>
    err instanceof EnterpriseError && err.code === "not_found",
  );
});

test("three-way merge: disjoint blocks merge, identical edits collapse, divergent edits conflict", () => {
  const ours: BlockOp[] = [{ kind: "replace_paragraph", blockId: "a", content: "Ours alpha." }];
  const theirs: BlockOp[] = [
    { kind: "replace_paragraph", blockId: "b", content: "Theirs bravo." },
    { kind: "update_table_cell", tableId: "t", cellId: "c2", value: "42" },
  ];
  const clean = mergeBlockEdits(BASE, ours, theirs);
  assert.equal(clean.ok, true);
  if (clean.ok) {
    assert.match(clean.source, /^Ours alpha\.$/m);
    assert.match(clean.source, /^Theirs bravo\.$/m);
    assert.match(clean.source, /\{#c2\} 42/);
    assert.match(clean.source, /title: {3}'Quoted {3}title'/);
  }

  const same: BlockOp = { kind: "replace_paragraph", blockId: "a", content: "Same." };
  assert.deepEqual(detectBlockConflicts([same], [{ ...same }]), []);
  const collapsed = mergeBlockEdits(BASE, [same], [{ ...same }]);
  assert.equal(collapsed.ok && collapsed.applied.length, 1);

  const clash = mergeBlockEdits(BASE, ours, [{ kind: "replace_paragraph", blockId: "a", content: "Theirs alpha." }]);
  assert.equal(clash.ok, false);
  if (!clash.ok) assert.deepEqual(clash.conflicts.map((c) => c.target), ["paragraph:a"]);

  const lastWriteWithinSide = mergeBlockEdits(BASE, [same], [
    { kind: "replace_paragraph", blockId: "a", content: "draft" },
    { ...same },
  ]);
  assert.equal(lastWriteWithinSide.ok, true, "only each side's final result per block is compared");
  if (lastWriteWithinSide.ok) assert.match(lastWriteWithinSide.source, /^Same\.$/m);
  assert.equal(crdtOpsConflict, blockOpsConflict);
});

test("workspace merge accepts an identical concurrent edit and ignores Yjs rows", () => {
  const { ws, alice, bob, spaceId } = harness();
  const documentId = ws.createDocument(alice, { spaceId, title: "Live", source: `{#a}\nAlpha.\n\n{#b}\nBravo.\n` });
  const op: BlockOp = { kind: "replace_paragraph", blockId: "a", content: "Agreed." };
  ws.persistCollaborativeUpdate(alice, { documentId, clientId: "alice", clientSeq: 1, lastAckedSeq: 0, ops: [op] });
  const again = ws.persistCollaborativeUpdate(bob, { documentId, clientId: "bob", clientSeq: 1, lastAckedSeq: 0, ops: [{ ...op }] });
  assert.equal(again.replayed, false);
  assert.equal(ws.readDocument(alice, documentId).source.match(/Agreed\./g)?.length, 1);
  assert.throws(
    () => ws.persistCollaborativeUpdate(bob, { documentId, clientId: "yjs", clientSeq: 9, ops: [] }),
    (err: unknown) => err instanceof EnterpriseError && err.code === "invalid",
  );
  ws.close();
});
