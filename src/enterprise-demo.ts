import { parse } from "./parser.js";
import { assignPersistentIdentities, findNodeByAnyId, resetIdentitySequence } from "./stable-identity.js";
import { nomaToEditor } from "./enterprise-adapter.js";
import { EnterpriseError, type ActorContext } from "./enterprise-contracts.js";
import { createTestOidc, EnterpriseWorkspace } from "./enterprise-workspace.js";

export const TEST_REPORT_SOURCE = `---
title: Thermal vacuum test report
identityFormat: 1
---

# Thermal vacuum campaign

{#conclusion}
The chamber run meets the requirement at the pinned dataset revision.

::requirement{id="req-thermal-vac" owner="qa"}
The unit must remain within 2.0 °C of the target across the soak window.
::

{#results cols="col-metric,col-value" rows="row-temp,row-drift"}
| {#h-metric} Metric | {#h-value} Result |
| --- | --- |
| {#cell-temp} Soak temperature | {#cell-temp-val} 21.4 °C |
| {#cell-drift} Drift | {#cell-drift-val} 1.8 °C |

::artifact{id="chart-thermal" artifact="artifact-thermal" pin="published"}
Pinned thermal chart.
::
`;

export interface DemonstrationResult {
  documentId: string;
  artifactId: string;
  issueKey: string;
  followUpKey?: string;
  changesetId: string;
  appliedHash: string;
  staleRejected: boolean;
  revokedDenied: boolean;
  pinnedUnchanged: boolean;
  updateCandidate: boolean;
  restored: boolean;
  notifications: number;
  searchHits: number;
}

export function runEnterpriseReleaseDemonstration(): DemonstrationResult {
  resetIdentitySequence(0);
  const oidc = createTestOidc({
    alice: { sub: "alice", email: "alice@example.com", name: "Alice" },
    bob: { sub: "bob", email: "bob@example.com", name: "Bob" },
  });
  const clock = { t: Date.parse("2026-09-13T12:00:00.000Z") };
  const ws = new EnterpriseWorkspace({
    oidc,
    now: () => new Date(clock.t).toISOString(),
    id: () => {
      clock.t += 1;
      return `id_${clock.t.toString(16)}`;
    },
  });

  try {
    const tenantId = ws.provisionTenant("R&D").tenantId;
    const aliceId = ws.scimUpsert(tenantId, { externalId: "alice", userName: "Alice", active: true });
    const bobId = ws.scimUpsert(tenantId, { externalId: "bob", userName: "Bob", active: true });
    const alice = ws.loginOidc(tenantId, "alice").actor;
    const bob = ws.loginOidc(tenantId, "bob").actor;
    ws.bootstrapGrant(tenantId, aliceId, "tenant", tenantId, "owner");
    const agentId = ws.createPrincipal(tenantId, {
      kind: "agent",
      name: "scoped-refresh",
      capabilities: ["changeset.propose", "work.read"],
    });
    const agentSession = ws.createSession({ id: agentId, tenant_id: tenantId, kind: "agent" });
    const agent = agentSession.actor;

    const spaceId = ws.createSpace(alice, "Thermal", "internal");
    ws.bootstrapGrant(tenantId, bobId, "space", spaceId, "editor");
    ws.bootstrapGrant(tenantId, agentId, "space", spaceId, "editor");
    const projectId = ws.createProject(alice, { key: "THM", name: "Thermal", spaceId });
    ws.bootstrapGrant(tenantId, bobId, "project", projectId, "editor");
    ws.bootstrapGrant(tenantId, agentId, "project", projectId, "editor");

    const documentId = ws.createDocument(alice, { spaceId, title: "Thermal vacuum campaign", source: TEST_REPORT_SOURCE });
    const parsed = parse(ws.readDocument(alice, documentId).source);
    assignPersistentIdentities(parsed);
    const table = parsed.children.flatMap((node) => (node.type === "section" ? node.children : [node])).find((node) => node.type === "table");
    if (!table || table.type !== "table" || !table.id) throw new Error("expected identified table");

    const issue = ws.createIssue(alice, {
      projectId,
      typeKey: "story",
      summary: "Keep soak within 2.0 °C",
      labels: ["requirement"],
    });
    ws.putReference(alice, {
      from: { kind: "document", id: documentId, blockId: "req-thermal-vac" },
      to: { kind: "issue", id: issue.id },
      relation: "implements",
      authoritative: true,
    });

    const artifactId = ws.createArtifact(alice, { spaceId, title: "Thermal chart" });
    ws.applyArtifactCommands(
      alice,
      artifactId,
      [
        {
          op: "insert_element",
          element: {
            id: "chart-1",
            type: "chart",
            geometry: { x: 0, y: 0, width: 400, height: 240 },
            zIndex: 1,
            altText: "Soak temperature over time",
            readingOrder: 1,
            chart: {
              datasetId: "dataset-thermal",
              datasetRevision: 1,
              labels: ["t0", "t1"],
              values: [21.4, 21.6],
              units: "°C",
            },
          },
        },
      ],
      0,
    );
    const publishedArtifact = ws.publishArtifact(alice, artifactId);
    const assetId = ws.uploadAsset(alice, {
      bytes: Buffer.from("png-bytes"),
      mime: "image/png",
      provenance: { source: "lab-camera" },
    });
    ws.readAsset(alice, assetId);

    const inventory = ws.inventoryImport(alice, "confluence", [
      {
        sourceId: "conf-88",
        readable: true,
        type: "page",
        payload: {
          title: "Revised soak results",
          source: `# Revised soak results\n\n::evidence{id="ev-rev" for="req-thermal-vac"}\nDataset revision 2 records 2.4 °C drift.\n::\n`,
        },
      },
      { sourceId: "conf-secret", readable: false, type: "page", payload: {} },
    ]);
    const imported = ws.applyImport(alice, inventory.connectorId, spaceId, "noma_native");
    ws.putReference(alice, {
      from: { kind: "document", id: imported[0]!, blockId: "ev-rev" },
      to: { kind: "document", id: documentId, blockId: "req-thermal-vac" },
      relation: "supports",
      authoritative: true,
    });
    const impacts = ws.dependents(alice, documentId);

    const changesetId = ws.draftChangeset(agent, {
      intent: "Refresh soak table, chart, conclusion, and follow-up issue from dataset revision 2",
      idempotencyKey: "demo-refresh-1",
      reviewerIds: [bobId],
      targetRevisions: {
        [documentId]: ws.readDocument(alice, documentId).draftRevision,
        [artifactId]: ws.readArtifact(alice, artifactId, "draft").document.revision,
      },
      sourceDependencies: imported[0]
        ? [{ resource: { kind: "document", id: imported[0] }, hash: ws.readDocument(alice, imported[0]).hash }]
        : [],
      operations: [
        {
          resource: { kind: "document", id: documentId, blockId: table.cellIds?.[1]?.[1] },
          op: "update_table_cell",
          payload: { tableId: table.id, cellId: table.cellIds?.[1]?.[1], value: "2.4 °C" },
        },
        {
          resource: { kind: "document", id: documentId, blockId: "conclusion" },
          op: "replace_paragraph",
          payload: { blockId: "conclusion", content: "The chamber run now exceeds the 2.0 °C requirement and needs a follow-up." },
        },
        {
          resource: { kind: "artifact", id: artifactId, elementId: "chart-1" },
          op: "update_chart",
          payload: {
            elementId: "chart-1",
            chart: {
              datasetId: "dataset-thermal",
              datasetRevision: 2,
              labels: ["t0", "t1"],
              values: [21.4, 23.8],
              units: "°C",
            },
          },
        },
        {
          resource: { kind: "issue", id: issue.id },
          op: "create_issue",
          payload: {
            projectId,
            typeKey: "task",
            summary: "Investigate soak drift after dataset revision 2",
            assigneeId: aliceId,
            accountableId: bobId,
            documentId,
            requirementBlockId: "req-thermal-vac",
          },
        },
      ],
    });
    ws.proposeChangeset(agent, changesetId, [bobId]);
    const proposed = ws.changeset(changesetId, tenantId);
    if (!proposed.diffs.text || !proposed.diffs.visual) throw new Error("expected text and visual diffs");
    ws.approveChangeset(bob, changesetId, { issueOwnerOverride: bobId });
    const applied = ws.applyChangeset(bob, changesetId);
    ws.drainOutbox(tenantId);
    ws.publishDocument(alice, documentId);

    const after = parse(ws.readDocument(alice, documentId).source);
    const updatedTable = findNodeByAnyId(after, table.id);
    if (!updatedTable || updatedTable.type !== "table") throw new Error("table missing after apply");
    const drift = updatedTable.rows[1]?.[1];
    if (drift !== "2.4 °C") throw new Error(`expected drift cell update, got ${drift}`);

    let staleRejected = false;
    try {
      ws.applyChangeset(bob, changesetId);
    } catch (error) {
      staleRejected = error instanceof EnterpriseError && (error.code === "invalid" || error.code === "stale_revision");
    }
    const concurrent = ws.draftChangeset(agent, {
      intent: "stale retry",
      idempotencyKey: "demo-refresh-stale",
      targetRevisions: { [documentId]: 0 },
      operations: proposed.operations,
    });
    ws.proposeChangeset(agent, concurrent, [bobId]);
    ws.approveChangeset(bob, concurrent);
    try {
      ws.applyChangeset(bob, concurrent);
    } catch (error) {
      staleRejected = staleRejected || (error instanceof EnterpriseError && error.code === "stale_revision");
    }

    const grantId = (
      ws.store.db.prepare("SELECT id FROM grants WHERE principal_id = ? AND resource_kind = 'space'").get(bobId) as { id: string }
    ).id;
    ws.revokeGrant(alice, grantId);
    ws.revokePrincipalSessions(bobId);
    let revokedDenied = false;
    try {
      ws.readDocument(bob, documentId);
    } catch (error) {
      revokedDenied = error instanceof EnterpriseError && (error.code === "unauthorized" || error.code === "forbidden");
    }
    try {
      ws.readArtifact(bob, artifactId, "draft");
    } catch (error) {
      revokedDenied = revokedDenied && error instanceof EnterpriseError;
    }

    const pinned = ws.readArtifact(alice, artifactId, publishedArtifact.revision);
    const draft = ws.readArtifact(alice, artifactId, "draft");
    const pinnedUnchanged = pinned.document.elements[0]?.chart?.datasetRevision === 1;
    const updateCandidate = draft.updateCandidate || draft.document.elements[0]?.chart?.datasetRevision === 2;

    const snapshot = ws.backup(tenantId);
    const restoredWs = new EnterpriseWorkspace();
    restoredWs.restore(snapshot.bundle, snapshot.digest);
    const restoredDoc = restoredWs.store.db.prepare("SELECT id FROM documents WHERE id = ?").get(documentId);
    const restoredIssue = restoredWs.store.db.prepare("SELECT key FROM issues WHERE id = ?").get(issue.id);
    const restoredAudit = restoredWs.store.db.prepare("SELECT COUNT(*) AS n FROM audit_events WHERE tenant_id = ?").get(tenantId) as {
      n: number;
    };
    restoredWs.close();

    const searchHits = ws.search(alice, "soak").length;
    const followUp = ws.queryIssues(alice, projectId, { type: "contains", field: "summary", value: "Investigate soak" })[0] as
      | { key?: string }
      | undefined;

    void nomaToEditor(after);
    void impacts;

    return {
      documentId,
      artifactId,
      issueKey: issue.key,
      followUpKey: followUp?.key,
      changesetId,
      appliedHash: String(applied.result?.appliedAt ?? ""),
      staleRejected,
      revokedDenied,
      pinnedUnchanged,
      updateCandidate,
      restored: Boolean(restoredDoc && restoredIssue && restoredAudit.n > 0),
      notifications: ws.notifications(alice).length + ws.notifications(bob).length,
      searchHits,
    };
  } finally {
    ws.close();
  }
}

export function demonstrationSourceHasPinnedArtifact(): boolean {
  return TEST_REPORT_SOURCE.includes('pin="published"');
}
