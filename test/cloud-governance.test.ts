import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import DatabaseConstructor from "better-sqlite3";
import { CloudGovernanceStore } from "../src/cloud-governance.js";
import { canonicalJson, listCapabilities, lookupCapability } from "../src/cloud/capabilities.js";
import type { CloudServerConfig } from "../src/cloud/context.js";
import { governAgentAction, payloadHash, recordAgentDecision } from "../src/cloud/governance.js";
import { HttpError } from "../src/cloud/http.js";
import { FakeRunProvider } from "../src/cloud/run-provider.js";
import { createNomaCloudServer } from "../src/cloud-server.js";
import { createCloudUser, createSpace, json, request, startCloudServer } from "./cloud-wiki-harness.js";

interface AuditEntry {
  actorId: string;
  action: string;
  resourceType: string;
  resourceId: string;
  detail: Record<string, unknown>;
}

async function gateHarness() {
  const dir = await mkdtemp(join(tmpdir(), "noma-governance-unit-"));
  const dbPath = join(dir, "governance.sqlite");
  const governance = new CloudGovernanceStore(dbPath);
  const audits: AuditEntry[] = [];
  const config = {
    governance,
    now: () => new Date("2026-09-27T10:00:00.000Z"),
    platform: {
      recordAudit: (actorId: string, action: string, resourceType: string, resourceId: string, detail: Record<string, unknown>) => {
        audits.push({ actorId, action, resourceType, resourceId, detail });
      },
    },
  } as unknown as CloudServerConfig;
  return {
    config,
    governance,
    audits,
    dbPath,
    close: async () => {
      governance.close();
      await rm(dir, { recursive: true, force: true });
    },
  };
}

function denied(code: string): (error: unknown) => boolean {
  return (error) => error instanceof HttpError && error.details.code === code;
}

test("every registered kind has a class and tier; canonical JSON sorts keys and drops undefined", () => {
  const capabilities = listCapabilities();
  assert.ok(capabilities.length > 10);
  for (const capability of capabilities) assert.ok(["read_only", "approve_to_execute", "propose_only"].includes(capability.capabilityClass), capability.kind);
  assert.equal(lookupCapability("run.deploy")?.minTier, 3);
  assert.equal(lookupCapability("run.test")?.minTier, 2);
  assert.equal(lookupCapability("access.change")?.capabilityClass, "propose_only");
  assert.equal(lookupCapability("space.nuke"), undefined);
  assert.equal(canonicalJson({ b: 1, a: [{ d: undefined, c: "x" }] }), '{"a":[{"c":"x"}],"b":1}');
  assert.equal(payloadHash({ b: 1, a: 2 }), payloadHash({ a: 2, b: 1 }));
});

test("the gate denies unregistered actions by default and audits every decision", async () => {
  const gate = await gateHarness();
  try {
    assert.throws(() => governAgentAction(gate.config, { kind: "space.nuke", phase: "execute", actorId: "u1", agentId: "a1", payload: {} }), denied("action_unregistered"));
    assert.equal(gate.audits.at(-1)?.action, "agent.gate.denied");
    assert.equal(gate.audits.at(-1)?.detail.code, "action_unregistered");
    const allowed = governAgentAction(gate.config, { kind: "page.read", phase: "execute", actorId: "u1", agentId: "a1", siteIds: ["s1"], payload: { tool: "search" } });
    assert.equal(allowed.capabilityClass, "read_only");
    assert.deepEqual([gate.audits.at(-1)?.action, gate.audits.at(-1)?.resourceType, gate.audits.at(-1)?.resourceId], ["agent.gate.allowed", "site", "s1"]);
    assert.ok(typeof gate.audits.at(-1)?.detail.gateId === "string");
  } finally {
    await gate.close();
  }
});

test("propose_only actions can be proposed but never execute, even with an approval on record", async () => {
  const gate = await gateHarness();
  try {
    const payload = { kind: "access.change", siteId: "s1", payload: { grant: "admin", to: "a1" } };
    assert.equal(governAgentAction(gate.config, { kind: "access.change", phase: "propose", actorId: "u1", agentId: "a1", siteIds: ["s1"], payload }).capabilityClass, "propose_only");
    const decision = recordAgentDecision(gate.config, { subject: { type: "action", id: "p1" }, kind: "access.change", decision: "approved", decidedBy: "u2", payload, siteId: "s1", agentId: "a1" });
    assert.equal(decision.capabilityClass, "propose_only");
    for (const agentId of ["a1", undefined]) {
      assert.throws(
        () => governAgentAction(gate.config, { kind: "access.change", phase: "execute", actorId: "u2", ...(agentId ? { agentId } : {}), siteIds: ["s1"], subject: { type: "action", id: "p1" }, payload, standing: "anything" }),
        denied("bright_line_propose_only"),
      );
    }
    assert.equal(gate.audits.at(-1)?.detail.code, "bright_line_propose_only");
  } finally {
    await gate.close();
  }
});

test("approvals bind to the payload hash: a changed payload or a later rejection refuses execution", async () => {
  const gate = await gateHarness();
  try {
    const approvedPayload = { kind: "page.patch", documentId: "d1", documentHash: "h1", ops: [{ op: "update_attribute", id: "x", key: "k", value: 1 }] };
    const execute = (payload: unknown) => governAgentAction(gate.config, { kind: "page.patch", phase: "execute", actorId: "u2", agentId: "a1", siteIds: ["s1"], subject: { type: "patch", id: "p1" }, payload });
    assert.throws(() => execute(approvedPayload), denied("approval_required"));
    assert.throws(
      () => recordAgentDecision(gate.config, { subject: { type: "patch", id: "p1" }, kind: "page.patch", decision: "approved", decidedBy: "u2", payload: approvedPayload, expectedHash: "0".repeat(64) }),
      denied("payload_hash_mismatch"),
    );
    const decision = recordAgentDecision(gate.config, { subject: { type: "patch", id: "p1" }, kind: "page.patch", decision: "approved", decidedBy: "u2", payload: approvedPayload, expectedHash: payloadHash(approvedPayload) });
    assert.equal(execute(approvedPayload).decisionId, decision.id);
    assert.throws(() => execute({ ...approvedPayload, ops: [{ op: "update_attribute", id: "x", key: "k", value: 2 }] }), (error) => error instanceof HttpError && error.status === 409 && error.details.code === "payload_hash_mismatch");
    assert.throws(() => governAgentAction(gate.config, { kind: "page.patch", phase: "execute", actorId: "u2", agentId: "a1", payload: approvedPayload, standing: "agents cannot stand in for a page patch approval" }), denied("approval_required"));
    recordAgentDecision(gate.config, { subject: { type: "patch", id: "p1" }, kind: "page.patch", decision: "rejected", decidedBy: "u3", payload: approvedPayload });
    assert.throws(() => execute(approvedPayload), denied("approval_required"));
    assert.deepEqual(gate.governance.listDecisions("patch", "p1").map((item) => item.decision), ["approved", "rejected"]);
  } finally {
    await gate.close();
  }
});

test("the decision log is append-only: SQLite triggers abort UPDATE and DELETE", async () => {
  const gate = await gateHarness();
  try {
    recordAgentDecision(gate.config, { subject: { type: "run", id: "r1" }, kind: "run.test", decision: "approved", decidedBy: "u2", payload: { ref: "main" } });
    const raw = new DatabaseConstructor(gate.dbPath);
    try {
      assert.throws(() => raw.prepare("UPDATE agent_decisions SET decision = 'rejected'").run(), /append-only/);
      assert.throws(() => raw.prepare("UPDATE agent_decisions SET payload_hash = 'x'").run(), /append-only/);
      assert.throws(() => raw.prepare("DELETE FROM agent_decisions").run(), /append-only/);
      assert.equal((raw.prepare("SELECT COUNT(*) AS n FROM agent_decisions").get() as { n: number }).n, 1);
    } finally {
      raw.close();
    }
  } finally {
    await gate.close();
  }
});

test("per-space trust tiers bind agents, not people; the most restrictive space wins", async () => {
  const gate = await gateHarness();
  try {
    const run = (kind: string, agentId: string | undefined, siteIds: string[]) =>
      governAgentAction(gate.config, { kind, phase: "execute", actorId: "u1", ...(agentId ? { agentId } : {}), siteIds, payload: { ref: "main" }, standing: "the project owner turned off approval for agent runs" });
    assert.equal(run("run.deploy", "a1", ["unconfigured"]).tier, 3, "unconfigured spaces keep today's behaviour");
    gate.governance.writeTrust({ siteId: "s1", tier: 1, updatedBy: "u1", updatedAt: "2026-09-27T10:00:00.000Z" });
    assert.throws(() => run("run.test", "a1", ["s1"]), denied("agent_tier_too_low"));
    assert.equal(gate.audits.at(-1)?.detail.requiredTier, 2);
    assert.ok(run("run.test", undefined, ["s1"]), "a person's own run is not bound by the agent tier");
    gate.governance.writeTrust({ siteId: "s1", tier: 2, updatedBy: "u1", updatedAt: "2026-09-27T10:00:00.000Z" });
    assert.ok(run("run.test", "a1", ["s1"]));
    assert.throws(() => run("run.deploy", "a1", ["s1"]), denied("agent_tier_too_low"));
    gate.governance.writeTrust({ siteId: "s0", tier: 0, updatedBy: "u1", updatedAt: "2026-09-27T10:00:00.000Z" });
    assert.throws(() => governAgentAction(gate.config, { kind: "page.patch", phase: "propose", actorId: "u1", agentId: "a1", siteIds: ["unconfigured", "s0"], payload: {} }), denied("agent_tier_too_low"));
    assert.ok(governAgentAction(gate.config, { kind: "page.read", phase: "execute", actorId: "u1", agentId: "a1", siteIds: ["s0"], payload: {} }));
  } finally {
    await gate.close();
  }
});

async function gatewayCall<T = Record<string, unknown>>(base: string, token: string, name: string, args: Record<string, unknown>) {
  const response = await request<{ result?: { structuredContent: T }; code?: string; error?: string }>(`${base}/api/gateway/mcp`, {
    method: "POST",
    token,
    body: { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name, arguments: args } },
  });
  return { status: response.status, body: response.body, result: response.body.result?.structuredContent };
}

async function agentSpace(base: string) {
  const ada = await createCloudUser(base, "Ada Admin");
  const bob = await createCloudUser(base, "Bob Builder");
  const { site, pages } = await createSpace(base, ada.token, "Research", [`# Market memo\n\n::claim{id="tam" confidence=0.6}\nThe market is $4B.\n::\n`]);
  await json(`${base}/api/sites/${site.id}/collaborators`, { method: "POST", token: ada.token, body: { userId: bob.id, role: "editor" } });
  const agent = await json<{ id: string }>(`${base}/api/agents`, { method: "POST", token: bob.token, body: { name: "Research Bot", capabilities: ["read_doc", "list_ids", "patch_block", "run"] } });
  await json(`${base}/api/agents/${agent.id}/access`, { method: "POST", token: bob.token, body: { resourceType: "site", resourceId: site.id, role: "editor" } });
  return { ada, bob, site, page: pages[0]!, agent };
}

interface QueueItem {
  kind: string;
  id: string;
  decidable: boolean;
  governance?: { actionKind: string; capabilityClass: string; payloadHash: string; history: Array<{ decision: string; payloadHash: string; source: string }> };
}

test("agent patches: hash-bound review, decision history in the queue, tamper refusal, tier refusal, audit", async () => {
  const harness = await startCloudServer("noma-governance-patch-");
  const { base } = harness;
  try {
    const { ada, bob, site, page, agent } = await agentSpace(base);
    const ops = [{ op: "update_attribute", id: "tam", key: "confidence", value: 0.4 }];
    const proposed = await gatewayCall<{ proposed: boolean; proposal: { id: string } }>(base, bob.token, "proposal", { agentId: agent.id, documentId: page.id, ops, summary: "Lower confidence" });
    assert.equal(proposed.result?.proposed, true);
    const proposalId = proposed.result!.proposal.id;

    const queue = await json<{ items: QueueItem[] }>(`${base}/api/approvals`, { token: ada.token });
    const item = queue.items.find((entry) => entry.kind === "patch" && entry.id === proposalId)!;
    assert.deepEqual([item.governance?.actionKind, item.governance?.capabilityClass, item.governance?.history.length], ["page.patch", "approve_to_execute", 0]);
    assert.match(item.governance!.payloadHash, /^[0-9a-f]{64}$/);

    const reviewUrl = `${base}/api/documents/${page.id}/patch-proposals/${proposalId}/review`;
    const stale = await json<{ code: string }>(reviewUrl, { method: "POST", token: ada.token, body: { decision: "approved", payloadHash: "f".repeat(64) }, expectedStatus: 409 });
    assert.equal(stale.code, "payload_hash_mismatch");
    await json(reviewUrl, { method: "POST", token: ada.token, body: { decision: "approved", payloadHash: item.governance!.payloadHash, reason: "Matches the Q3 numbers" } });
    const history = await json<{ history: Array<{ decision: string; decidedBy: string; payloadHash: string; reason?: string; agentId?: string }> }>(`${base}/api/documents/${page.id}/patch-proposals/${proposalId}/decisions`, { token: ada.token });
    assert.deepEqual(history.history.map((entry) => [entry.decision, entry.decidedBy, entry.payloadHash, entry.reason, entry.agentId]), [["approved", ada.id, item.governance!.payloadHash, "Matches the Q3 numbers", agent.id]]);

    const raw = new DatabaseConstructor(join(harness.root, "data", "noma-cloud.sqlite"));
    try {
      raw.prepare("UPDATE patch_proposals SET ops_json = ? WHERE id = ?").run(JSON.stringify([{ op: "update_attribute", id: "tam", key: "confidence", value: 0.01 }]), proposalId);
      const tampered = await json<{ code: string; approvedHash: string }>(`${base}/api/documents/${page.id}/patch-proposals/${proposalId}/apply`, { method: "POST", token: ada.token, expectedStatus: 409 });
      assert.deepEqual([tampered.code, tampered.approvedHash], ["payload_hash_mismatch", item.governance!.payloadHash]);
      raw.prepare("UPDATE patch_proposals SET ops_json = ? WHERE id = ?").run(JSON.stringify(ops), proposalId);
    } finally {
      raw.close();
    }
    const applied = await json<{ proposal: { status: string }; document: { source: string } }>(`${base}/api/documents/${page.id}/patch-proposals/${proposalId}/apply`, { method: "POST", token: ada.token });
    assert.equal(applied.proposal.status, "applied");
    assert.match(applied.document.source, /confidence=0\.4/);

    const trustUrl = `${base}/api/approvals/trust/${site.id}`;
    assert.deepEqual(await json<{ tier: number; configured: boolean }>(trustUrl, { token: bob.token }), { siteId: site.id, tier: 3, label: "run deploys", configured: false });
    await json(trustUrl, { method: "PUT", token: bob.token, body: { tier: 3 }, expectedStatus: 403 });
    await json(trustUrl, { method: "PUT", token: ada.token, body: { tier: 7 }, expectedStatus: 400 });
    assert.equal((await json<{ tier: number }>(trustUrl, { method: "PUT", token: ada.token, body: { tier: 0 } })).tier, 0);
    const refused = await gatewayCall(base, bob.token, "proposal", { agentId: agent.id, documentId: page.id, ops });
    assert.deepEqual([refused.status, refused.body.code], [403, "agent_tier_too_low"]);
    assert.match(refused.body.error ?? "", /trust tier is 0 \(read-only\)/);
    const read = await gatewayCall<{ ids: unknown[] }>(base, bob.token, "list_ids", { agentId: agent.id, documentId: page.id });
    assert.ok(read.result?.ids.length, "tier 0 still lets agents read");

    const audit = await json<{ events: Array<{ action: string; detail: Record<string, unknown> }> }>(`${base}/api/enterprise/audit`, { token: ada.token });
    const actions = audit.events.map((event) => event.action);
    for (const action of ["agent.gate.allowed", "agent.gate.denied", "agent.decision.recorded", "agent.trust_changed"]) assert.ok(actions.includes(action), action);
    const denial = audit.events.find((event) => event.action === "agent.gate.denied" && event.detail.code === "agent_tier_too_low")!;
    assert.deepEqual([denial.detail.kind, denial.detail.agentId, denial.detail.tier, denial.detail.capabilityClass], ["page.patch", agent.id, 0, "approve_to_execute"]);
    assert.ok(audit.events.some((event) => event.action === "agent.gate.denied" && event.detail.code === "payload_hash_mismatch"));
  } finally {
    await harness.close();
  }
});

test("bright-line proposals reach the queue for space owners and are never executed; unknown tools are denied", async () => {
  const harness = await startCloudServer("noma-governance-bright-");
  const { base } = harness;
  try {
    const { ada, bob, site, agent } = await agentSpace(base);
    const unknownTool = await gatewayCall(base, bob.token, "delete_space", { agentId: agent.id, siteId: site.id });
    assert.deepEqual([unknownTool.status, unknownTool.body.code], [403, "action_unregistered"]);
    const unknownKind = await gatewayCall(base, bob.token, "action_propose", { agentId: agent.id, siteId: site.id, kind: "space.nuke", reason: "why not" });
    assert.deepEqual([unknownKind.status, unknownKind.body.code], [403, "action_unregistered"]);
    const wrongTool = await gatewayCall(base, bob.token, "action_propose", { agentId: agent.id, siteId: site.id, kind: "page.patch", reason: "x" });
    assert.deepEqual([wrongTool.status, wrongTool.body.code], [400, "not_propose_only"]);

    const proposed = await gatewayCall<{ proposed: boolean; proposal: { id: string; status: string; payloadHash: string } }>(base, bob.token, "action_propose", {
      agentId: agent.id,
      siteId: site.id,
      kind: "access.change",
      payload: { grant: "editor", to: "carol" },
      reason: "Carol owns the pricing section now",
    });
    assert.equal(proposed.result?.proposal.status, "pending");
    const proposalId = proposed.result!.proposal.id;

    const bobItem = (await json<{ items: QueueItem[] }>(`${base}/api/approvals`, { token: bob.token })).items.find((entry) => entry.id === proposalId)!;
    assert.deepEqual([bobItem.kind, bobItem.decidable], ["action", false], "editors see it; only space owners decide");
    const adaItem = (await json<{ items: QueueItem[] }>(`${base}/api/approvals`, { token: ada.token })).items.find((entry) => entry.id === proposalId)!;
    assert.deepEqual([adaItem.decidable, adaItem.governance?.capabilityClass], [true, "propose_only"]);
    assert.equal(adaItem.governance?.payloadHash, proposed.result?.proposal.payloadHash);

    await json(`${base}/api/approvals/actions/${proposalId}`, { method: "POST", token: bob.token, body: { decision: "approve" }, expectedStatus: 403 });
    const decided = await json<{ executed: boolean; proposal: { status: string }; decision: { capabilityClass: string; decision: string } }>(`${base}/api/approvals/actions/${proposalId}`, {
      method: "POST",
      token: ada.token,
      body: { decision: "approve", payloadHash: adaItem.governance!.payloadHash },
    });
    assert.deepEqual([decided.executed, decided.proposal.status, decided.decision.capabilityClass, decided.decision.decision], [false, "approved", "propose_only", "approved"]);
    await json(`${base}/api/approvals/actions/${proposalId}`, { method: "POST", token: ada.token, body: { decision: "reject" }, expectedStatus: 409 });
    assert.equal((await json<{ items: QueueItem[] }>(`${base}/api/approvals`, { token: ada.token })).items.filter((entry) => entry.kind === "action").length, 0);

    const history = await json<{ decisions: Array<{ subjectId: string; actionKind: string }> }>(`${base}/api/approvals/history?siteId=${site.id}`, { token: ada.token });
    assert.ok(history.decisions.some((entry) => entry.subjectId === proposalId && entry.actionKind === "access.change"));
    const registry = await json<{ capabilities: Array<{ kind: string }>; defaultTier: number }>(`${base}/api/approvals/capabilities`, { token: bob.token });
    assert.equal(registry.defaultTier, 3);
    assert.ok(registry.capabilities.some((entry) => entry.kind === "run.deploy"));
  } finally {
    await harness.close();
  }
});

test("agent runs: tier 2 allows tests but refuses deploys; run approvals are hash-bound and logged", async () => {
  const provider = new FakeRunProvider();
  const harness = await startCloudServer("noma-governance-runs-", { runProvider: provider, queueIntervalMs: 0 });
  const { base } = harness;
  try {
    const { ada, bob, site, agent } = await agentSpace(base);
    const project = await json<{ id: string }>(`${base}/api/projects`, { method: "POST", token: ada.token, body: { siteId: site.id, key: "SHIP", name: "Shop" } });
    await json(`${base}/api/projects/${project.id}/repo`, { method: "PUT", token: ada.token, body: { repo: "acme/shop", runsEnabled: true }, expectedStatus: 201 });
    await json(`${base}/api/approvals/trust/${site.id}`, { method: "PUT", token: ada.token, body: { tier: 2 } });

    const deploy = await gatewayCall(base, bob.token, "run_request", { agentId: agent.id, projectId: project.id, kind: "deploy", ref: "main" });
    assert.deepEqual([deploy.status, deploy.body.code], [403, "agent_tier_too_low"]);
    const runs = await json<{ runs: unknown[] }>(`${base}/api/projects/${project.id}/runs`, { token: ada.token });
    assert.equal(runs.runs.length, 0, "a refused request leaves no run behind");

    const testRun = await gatewayCall<{ run: { id: string; status: string } }>(base, bob.token, "run_request", { agentId: agent.id, projectId: project.id, kind: "test", ref: "main" });
    assert.equal(testRun.result?.run.status, "pending_approval");
    const runId = testRun.result!.run.id;
    const item = (await json<{ items: QueueItem[] }>(`${base}/api/approvals`, { token: ada.token })).items.find((entry) => entry.id === runId)!;
    assert.deepEqual([item.governance?.actionKind, item.governance?.capabilityClass], ["run.test", "approve_to_execute"]);

    await json(`${base}/api/projects/${project.id}/repo`, { method: "PUT", token: ada.token, body: { repo: "acme/other" } });
    const moved = await json<{ code: string }>(`${base}/api/approvals/runs/${runId}`, { method: "POST", token: ada.token, body: { decision: "approve", payloadHash: item.governance!.payloadHash }, expectedStatus: 409 });
    assert.equal(moved.code, "payload_hash_mismatch", "relinking the repository after the request voids what the reviewer saw");
    assert.equal(provider.started.length, 0);
    await json(`${base}/api/projects/${project.id}/repo`, { method: "PUT", token: ada.token, body: { repo: "acme/shop" } });
    const approved = await json<{ status: string }>(`${base}/api/approvals/runs/${runId}`, { method: "POST", token: ada.token, body: { decision: "approve", payloadHash: item.governance!.payloadHash } });
    assert.equal(approved.status, "running");
    assert.equal(provider.started[0]?.repoUrl, "https://github.com/acme/shop.git");
    const history = await json<{ decisions: Array<{ subjectType: string; subjectId: string; decision: string; payloadHash: string }> }>(`${base}/api/approvals/history?siteId=${site.id}`, { token: ada.token });
    assert.deepEqual(
      history.decisions.filter((entry) => entry.subjectId === runId).map((entry) => [entry.subjectType, entry.decision, entry.payloadHash]),
      [["run", "approved", item.governance!.payloadHash]],
    );
  } finally {
    await harness.close();
  }
});

test("approvals recorded before the decision log existed are migrated so they still apply", async () => {
  const root = await mkdtemp(join(tmpdir(), "noma-governance-migrate-"));
  const options = {
    dataDir: join(root, "data", "documents"),
    usersDir: join(root, "data", "users"),
    sitesDir: join(root, "data", "sites"),
    dbPath: join(root, "data", "noma-cloud.sqlite"),
    publicDir: root,
    rateLimitMaxRequests: 10_000,
    authRateLimitMaxRequests: 1_000,
    queueIntervalMs: 0,
  };
  const listen = async () => {
    const server = createNomaCloudServer(options);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    assert.ok(address && typeof address === "object");
    return { server, base: `http://127.0.0.1:${address.port}` };
  };
  const stop = (server: ReturnType<typeof createNomaCloudServer>) => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
  try {
    const first = await listen();
    const { ada, bob, page, agent } = await agentSpace(first.base);
    const proposed = await gatewayCall<{ proposal: { id: string } }>(first.base, bob.token, "proposal", { agentId: agent.id, documentId: page.id, ops: [{ op: "update_attribute", id: "tam", key: "confidence", value: 0.5 }] });
    const proposalId = proposed.result!.proposal.id;
    await json(`${first.base}/api/documents/${page.id}/patch-proposals/${proposalId}/review`, { method: "POST", token: ada.token, body: { decision: "approved" } });
    await stop(first.server);

    const raw = new DatabaseConstructor(options.dbPath);
    raw.exec("DROP TABLE agent_decisions");
    raw.close();

    const second = await listen();
    try {
      const history = await json<{ history: Array<{ decision: string; source: string; decidedBy: string }> }>(`${second.base}/api/documents/${page.id}/patch-proposals/${proposalId}/decisions`, { token: ada.token });
      assert.deepEqual(history.history.map((entry) => [entry.decision, entry.source, entry.decidedBy]), [["approved", "migrated", ada.id]]);
      const applied = await json<{ proposal: { status: string } }>(`${second.base}/api/documents/${page.id}/patch-proposals/${proposalId}/apply`, { method: "POST", token: ada.token });
      assert.equal(applied.proposal.status, "applied");
    } finally {
      await stop(second.server);
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
