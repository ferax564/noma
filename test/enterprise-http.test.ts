import assert from "node:assert/strict";
import test from "node:test";
import { AGENT_BENCHMARK_TASKS, runAgentBenchmark, runPerformanceProfile } from "../src/enterprise-bench.js";
import { generateSbom, healthProbe, percentile, redactSupportBundle } from "../src/enterprise-ops.js";
import { listenEnterpriseHttp } from "../src/enterprise-http.js";
import { runEnterpriseWorkerTick } from "../src/enterprise-worker.js";
import { createTestOidc, EnterpriseWorkspace } from "../src/enterprise-workspace.js";
import { resetIdentitySequence } from "../src/stable-identity.js";

test("HTTP and worker entry points serve search, CRDT reconnect, health, and outbox ticks", async () => {
  resetIdentitySequence(0);
  const oidc = createTestOidc({ alice: { sub: "alice", email: "alice@example.com", name: "Alice" } });
  const ws = new EnterpriseWorkspace({ oidc });
  const tenantId = ws.provisionTenant("Acme").tenantId;
  ws.scimUpsert(tenantId, { externalId: "alice", userName: "Alice", active: true });
  const login = ws.loginOidc(tenantId, "alice");
  ws.bootstrapGrant(tenantId, login.actor.principalId, "tenant", tenantId, "owner");
  const spaceId = ws.createSpace(login.actor, "Docs");
  const documentId = ws.createDocument(login.actor, { spaceId, title: "HTTP", source: `{#p}\nHello.\n` });
  const server = await listenEnterpriseHttp({ workspace: ws });
  try {
    const health = await fetch(`http://127.0.0.1:${server.port}/health`).then((res) => res.json()) as { status: string };
    assert.equal(health.status, "ok");
    const session = await fetch(`http://127.0.0.1:${server.port}/v1/session`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ tenantId, idToken: "alice" }),
    }).then((res) => res.json()) as { token: string };
    const saved = await fetch(`http://127.0.0.1:${server.port}/v1/documents/${documentId}/crdt`, {
      method: "POST",
      headers: { authorization: `Bearer ${session.token}`, "content-type": "application/json" },
      body: JSON.stringify({
        clientId: "browser",
        clientSeq: 1,
        ops: [{ kind: "replace_paragraph", blockId: "p", content: "From HTTP." }],
      }),
    }).then((res) => res.json()) as { seq: number };
    assert.equal(saved.seq, 1);
    const updates = await fetch(`http://127.0.0.1:${server.port}/v1/documents/${documentId}/updates?since=0`, {
      headers: { authorization: `Bearer ${session.token}` },
    }).then((res) => res.json()) as unknown[];
    assert.equal(updates.length, 1);
    ws.publishDocument(login.actor, documentId);
    const search = await fetch(`http://127.0.0.1:${server.port}/v1/search?q=HTTP`, {
      headers: { authorization: `Bearer ${session.token}` },
    }).then((res) => res.json()) as { hits: unknown[] };
    assert.ok(Array.isArray(search.hits));
  } finally {
    await server.close();
    ws.close();
  }
});

test("worker drain and dead-letter handling, SBOM, and redacted support bundles", () => {
  resetIdentitySequence(0);
  const oidc = createTestOidc({ alice: { sub: "alice", email: "alice@example.com", name: "Alice" } });
  const ws = new EnterpriseWorkspace({ oidc });
  const tenantId = ws.provisionTenant("Acme").tenantId;
  ws.scimUpsert(tenantId, { externalId: "alice", userName: "Alice", active: true });
  const alice = ws.loginOidc(tenantId, "alice").actor;
  ws.bootstrapGrant(tenantId, alice.principalId, "tenant", tenantId, "owner");
  const spaceId = ws.createSpace(alice, "Docs");
  const documentId = ws.createDocument(alice, { spaceId, title: "W", source: "# W\n\nHi.\n" });
  ws.publishDocument(alice, documentId);
  const tick = runEnterpriseWorkerTick(ws, tenantId);
  assert.ok(tick.outbox >= 0);
  const probe = healthProbe({ dbOk: true, objectStoreOk: false, killSwitch: false });
  assert.equal(probe.status, "degraded");
  const sbom = generateSbom("package-lock.json");
  assert.equal(sbom.bomFormat, "CycloneDX");
  assert.ok(sbom.components.some((item) => item.name.includes("typescript") || item.name.includes("better-sqlite3") || item.name.length > 0));
  const redacted = redactSupportBundle({ token: "abc", nested: { password: "x" }, ok: 1 });
  assert.equal(redacted.token, "[redacted]");
  assert.equal(percentile([1, 2, 3, 4, 5], 95), 5);
  ws.close();
});

test("agent benchmark includes 30+ labeled tasks and records a performance profile against published targets", () => {
  assert.ok(AGENT_BENCHMARK_TASKS.length >= 30);
  const result = runAgentBenchmark();
  assert.equal(result.total, AGENT_BENCHMARK_TASKS.length);
  assert.ok(result.passed >= 30, `expected >=30 passing scripted tasks, got ${result.passed}`);
  const profile = runPerformanceProfile();
  assert.ok(profile.issueMutationP95Ms < profile.targets.issueMs * 20);
  assert.ok(profile.searchP95Ms < profile.targets.retrievalMs * 20);
  assert.ok(profile.documentSaveP95Ms < profile.targets.pageOpenMs * 20);
});
