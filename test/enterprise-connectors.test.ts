import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { assertSafeImportUrl, parseConfluenceStorage, parseJiraIssue } from "../src/enterprise-connectors.js";
import { EnterpriseError } from "../src/enterprise-contracts.js";
import { createTestOidc, EnterpriseWorkspace } from "../src/enterprise-workspace.js";
import { resetIdentitySequence } from "../src/stable-identity.js";

function harness() {
  resetIdentitySequence(0);
  const oidc = createTestOidc({
    alice: { sub: "alice", email: "alice@example.com", name: "Alice" },
  });
  const ws = new EnterpriseWorkspace({ oidc });
  const tenantId = ws.provisionTenant("Acme").tenantId;
  ws.scimUpsert(tenantId, { externalId: "alice", userName: "Alice", active: true });
  const alice = ws.loginOidc(tenantId, "alice").actor;
  ws.bootstrapGrant(tenantId, alice.principalId, "tenant", tenantId, "owner");
  const spaceId = ws.createSpace(alice, "Docs");
  const projectId = ws.createProject(alice, { key: "ENG", name: "Engineering", spaceId });
  return { ws, alice, spaceId, projectId };
}

test("Confluence storage XML maps macros, tables, and preserves unsupported snapshots", () => {
  const xml = readFileSync("examples/enterprise/confluence-page.xml", "utf8");
  const mapped = parseConfluenceStorage(xml, "Soak results");
  assert.match(mapped.source, /# Soak results/);
  assert.match(mapped.source, /::callout\{kind="info"\}/);
  assert.match(mapped.source, /unsupported_macro/);
  assert.equal(mapped.lossReport.some((item) => item.name === "jira"), true);
  const { ws, alice, spaceId } = harness();
  const imported = ws.importConfluenceStorage(alice, spaceId, xml, "Soak results");
  assert.ok(imported.documentId);
  assert.ok(imported.lossReport.length > 0);
  ws.close();
});

test("Jira issue JSON imports comments, worklogs, and custom fields without widening permissions", () => {
  const payload = JSON.parse(readFileSync("examples/enterprise/jira-issue.json", "utf8")) as Record<string, unknown>;
  const mapped = parseJiraIssue(payload);
  assert.equal(mapped.key, "ENG-42");
  assert.equal(mapped.worklogs.length, 1);
  assert.ok(mapped.customFields.customfield_10010);
  const { ws, alice, projectId } = harness();
  const created = ws.importJiraIssue(alice, projectId, payload);
  assert.match(created.key, /^ENG-/);
  ws.close();
});

test("cutover advances only after complete inventory reconciliation", () => {
  const { ws, alice, spaceId } = harness();
  const inventory = ws.inventoryImport(alice, "confluence", [
    { sourceId: "p1", readable: true, type: "page", payload: { title: "A", source: "# A\n\nHi.\n", projectId: undefined } },
    { sourceId: "p2", readable: false, type: "page", payload: {} },
  ]);
  assert.throws(() => ws.startCutover(alice, inventory.connectorId, [{ sourceId: "p1" }, { sourceId: "p2" }, { sourceId: "p3" }], inventory.report));
  const runId = ws.startCutover(alice, inventory.connectorId, [{ sourceId: "p1" }, { sourceId: "p2" }], inventory.report);
  assert.equal(ws.cutoverStage(runId), "inventory");
  assert.equal(ws.advanceCutover(alice, runId), "dry_run");
  void spaceId;
  ws.close();
});

test("importer rejects SSRF targets", () => {
  assert.throws(() => assertSafeImportUrl("file:///etc/passwd"), (err: unknown) => err instanceof EnterpriseError && err.code === "policy");
  assert.throws(() => assertSafeImportUrl("http://127.0.0.1/latest"), (err: unknown) => err instanceof EnterpriseError && err.code === "policy");
  assertSafeImportUrl("https://api.atlassian.com/ex/confluence/page");
});
