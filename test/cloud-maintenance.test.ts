import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { FakeLlmProvider, type LlmCompletionRequest } from "../src/cloud-llm.js";
import { createNomaCloudServer, runNomaCloudMaintenanceOnce, type NomaCloudAiOptions, type NomaCloudServerOptions } from "../src/cloud-server.js";

interface CloudUserResponse {
  id: string;
  token: string;
}

interface JsonRequestOptions {
  method?: string;
  token?: string;
  body?: Record<string, unknown>;
  expectedStatus?: number;
}

interface MaintenanceResponse {
  settings: { enabled: boolean; aiRefresh: boolean; intervalHours: number; maxProposalsPerRun: number; runAs: string; configured: boolean };
  ai: { available: boolean; reason?: string };
  openItems: number;
  runs: Array<{ trigger: string; status: string; itemsOpen: number; itemsResolved: number; proposalsCreated: number; detail: { skipped?: Array<{ reason: string }> } }>;
}

interface HealthItem {
  kind: string;
  documentId: string;
  blockId?: string;
  status: string;
  proposalId?: string;
}

const staleSource = (title: string, blockId: string): string => `# ${title}

::claim{id="${blockId}"}
Production services run in Zurich with a fifteen-minute recovery target.
::

See [[Missing escalation policy]].
`;

test("maintenance sweeps track stale knowledge and draft rate-limited refresh proposals", async () => {
  const upstream = await startTextServer("Production now runs in Frankfurt with a ten-minute recovery target.");
  const clock = { now: Date.parse("2026-06-06T12:00:00.000Z") };
  const provider = new FakeLlmProvider((request: LlmCompletionRequest) => {
    const blockId = /These blocks are past their review date: ([\w-]+)/.exec(request.messages[0]!.content)?.[1] ?? "missing";
    return JSON.stringify({
      summary: "Refresh the region",
      ops: [{ op: "replace_body", id: blockId, content: "Production services run in Frankfurt with a ten-minute recovery target." }],
      citations: [{ source: "S1", claim: "Frankfurt" }],
    });
  });
  const harness = await startCloudServer("noma-maintenance-", { provider, allowPrivateSourceHosts: true }, { now: () => new Date(clock.now) });
  try {
    const alice = await createCloudUser(harness.base, "Alice");
    const viewer = await createCloudUser(harness.base, "Victor");
    const first = await createPage(harness.base, alice.token, "Region handbook", staleSource("Region handbook", "region-claim"));
    const second = await createPage(harness.base, alice.token, "Recovery handbook", staleSource("Recovery handbook", "recovery-claim"));
    const site = await json<{ id: string }>(`${harness.base}/api/sites`, { method: "POST", token: alice.token, body: { title: "Operations", documentIds: [first.id, second.id] } });
    await json(`${harness.base}/api/sites/${site.id}/collaborators`, { method: "POST", token: alice.token, body: { userId: viewer.id, role: "viewer" } });
    for (const [page, blockId] of [[first, "region-claim"], [second, "recovery-claim"]] as const) {
      await json(`${harness.base}/api/knowledge/trust/${page.id}/${blockId}`, {
        method: "PUT",
        token: alice.token,
        body: { ownerId: alice.id, reviewBy: "2026-01-01T00:00:00.000Z", sourceOf: [upstream.url] },
      });
    }

    const defaults = await json<MaintenanceResponse>(`${harness.base}/api/sites/${site.id}/maintenance`, { token: viewer.token });
    assert.deepEqual([defaults.settings.enabled, defaults.settings.configured, defaults.settings.intervalHours], [false, false, 24]);
    assert.equal(defaults.ai.available, true);
    await json(`${harness.base}/api/sites/${site.id}/maintenance`, { method: "PUT", token: viewer.token, body: { enabled: true }, expectedStatus: 403 });
    await json(`${harness.base}/api/sites/${site.id}/maintenance`, { method: "PUT", token: alice.token, body: { intervalHours: 0 }, expectedStatus: 400 });
    await json(`${harness.base}/api/sites/${site.id}/maintenance`, { method: "PUT", token: alice.token, body: { enabled: "yes" }, expectedStatus: 400 });
    const saved = await json<MaintenanceResponse>(`${harness.base}/api/sites/${site.id}/maintenance`, {
      method: "PUT",
      token: alice.token,
      body: { enabled: true, aiRefresh: true, intervalHours: 6, maxProposalsPerRun: 1 },
    });
    assert.deepEqual([saved.settings.enabled, saved.settings.aiRefresh, saved.settings.runAs, saved.settings.configured], [true, true, alice.id, true]);

    const firstRun = await json<{ run: MaintenanceResponse["runs"][number]; items: HealthItem[] }>(`${harness.base}/api/sites/${site.id}/maintenance/run`, { method: "POST", token: alice.token, body: {} });
    assert.equal(firstRun.run.status, "completed");
    assert.equal(firstRun.run.proposalsCreated, 1, "maxProposalsPerRun limits AI drafts per sweep");
    const stale = firstRun.items.filter((item) => item.kind === "stale");
    assert.deepEqual(stale.map((item) => item.blockId).sort(), ["recovery-claim", "region-claim"]);
    assert.ok(firstRun.items.some((item) => item.kind === "broken_link"));
    const drafted = stale.filter((item) => item.proposalId);
    assert.equal(drafted.length, 1);
    const proposal = await json<{ status: string; summary: string; proposedBy: string; proof: { ai: { feature: string } } }>(
      `${harness.base}/api/documents/${drafted[0]!.documentId}/patch-proposals/${drafted[0]!.proposalId}`,
      { token: alice.token },
    );
    assert.equal(proposal.status, "pending");
    assert.equal(proposal.proposedBy, alice.id);
    assert.equal(proposal.proof.ai.feature, "maintenance_refresh");
    assert.match(proposal.summary, /^AI refresh from S1/);

    await json(`${harness.base}/api/sites/${site.id}/maintenance/run`, { method: "POST", token: alice.token, body: {}, expectedStatus: 429 });
    await json(`${harness.base}/api/sites/${site.id}/maintenance/run`, { method: "POST", token: viewer.token, body: {}, expectedStatus: 403 });

    clock.now += 2 * 60_000;
    const secondRun = await json<{ run: MaintenanceResponse["runs"][number]; items: HealthItem[] }>(`${harness.base}/api/sites/${site.id}/maintenance/run`, { method: "POST", token: alice.token, body: {} });
    assert.equal(secondRun.run.proposalsCreated, 1, "the page that already has a pending draft is skipped");
    const proposalIds = new Set(secondRun.items.filter((item) => item.proposalId).map((item) => item.proposalId));
    assert.equal(proposalIds.size, 2);

    await json(`${harness.base}/api/knowledge/trust/${first.id}/region-claim`, {
      method: "PUT",
      token: alice.token,
      body: { ownerId: alice.id, reviewBy: "2027-01-01T00:00:00.000Z", sourceOf: [upstream.url] },
    });
    clock.now += 2 * 60_000;
    const thirdRun = await json<{ run: MaintenanceResponse["runs"][number] }>(`${harness.base}/api/sites/${site.id}/maintenance/run`, { method: "POST", token: alice.token, body: {} });
    assert.equal(thirdRun.run.itemsResolved, 1);
    const resolved = await json<{ items: HealthItem[] }>(`${harness.base}/api/sites/${site.id}/maintenance/items?status=resolved`, { token: viewer.token });
    assert.deepEqual(resolved.items.map((item) => item.blockId), ["region-claim"]);
    await json(`${harness.base}/api/sites/${site.id}/maintenance/items?status=bogus`, { token: viewer.token, expectedStatus: 400 });

    const overview = await json<MaintenanceResponse>(`${harness.base}/api/sites/${site.id}/maintenance`, { token: viewer.token });
    assert.equal(overview.runs.length, 3);
    assert.ok(overview.openItems >= 2);
  } finally {
    await harness.close();
    await new Promise<void>((resolve) => upstream.server.close(() => resolve()));
  }
});

test("maintenance without AI still records health items and explains skipped drafts", async () => {
  const harness = await startCloudServer("noma-maintenance-noai-", { provider: null });
  try {
    const alice = await createCloudUser(harness.base, "Alice");
    const page = await createPage(harness.base, alice.token, "Region handbook", staleSource("Region handbook", "region-claim"));
    const site = await json<{ id: string }>(`${harness.base}/api/sites`, { method: "POST", token: alice.token, body: { title: "Operations", documentIds: [page.id] } });
    await json(`${harness.base}/api/knowledge/trust/${page.id}/region-claim`, { method: "PUT", token: alice.token, body: { reviewBy: "2026-01-01T00:00:00.000Z" } });
    await json(`${harness.base}/api/sites/${site.id}/maintenance`, { method: "PUT", token: alice.token, body: { enabled: true, aiRefresh: true } });
    const run = await json<{ run: MaintenanceResponse["runs"][number]; items: HealthItem[] }>(`${harness.base}/api/sites/${site.id}/maintenance/run`, { method: "POST", token: alice.token, body: {} });
    assert.equal(run.run.proposalsCreated, 0);
    assert.equal(run.run.detail.skipped?.[0]?.reason, "ai_unavailable");
    assert.ok(run.items.some((item) => item.kind === "stale" && item.blockId === "region-claim"));
    const outsider = await createCloudUser(harness.base, "Mallory");
    await json(`${harness.base}/api/sites/${site.id}/maintenance`, { token: outsider.token, expectedStatus: 403 });
    await json(`${harness.base}/api/sites/${site.id}/maintenance/items`, { token: outsider.token, expectedStatus: 403 });
  } finally {
    await harness.close();
  }
});

test("the in-process scheduler and the worker entry sweep due spaces", async () => {
  const root = await mkdtemp(join(tmpdir(), "noma-maintenance-scheduled-"));
  const storage = {
    dataDir: join(root, "data", "documents"),
    usersDir: join(root, "data", "users"),
    sitesDir: join(root, "data", "sites"),
    dbPath: join(root, "data", "noma-cloud.sqlite"),
  };
  const clock = { now: Date.parse("2026-06-06T12:00:00.000Z") };
  const harness = await startCloudServer("noma-maintenance-tick-", { provider: null, maintenanceTickMs: 25 }, { ...storage, now: () => new Date(clock.now) });
  try {
    const alice = await createCloudUser(harness.base, "Alice");
    const page = await createPage(harness.base, alice.token, "Region handbook", staleSource("Region handbook", "region-claim"));
    const site = await json<{ id: string }>(`${harness.base}/api/sites`, { method: "POST", token: alice.token, body: { title: "Operations", documentIds: [page.id] } });
    await json(`${harness.base}/api/sites/${site.id}/maintenance`, { method: "PUT", token: alice.token, body: { enabled: true, intervalHours: 1 } });
    let runs: MaintenanceResponse["runs"] = [];
    for (let attempt = 0; attempt < 80 && runs.length === 0; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      runs = (await json<MaintenanceResponse>(`${harness.base}/api/sites/${site.id}/maintenance`, { token: alice.token })).runs;
    }
    assert.equal(runs[0]?.trigger, "scheduled");
    assert.equal(runs[0]?.status, "completed");
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal((await json<MaintenanceResponse>(`${harness.base}/api/sites/${site.id}/maintenance`, { token: alice.token })).runs.length, 1, "not due again within the interval");
  } finally {
    await harness.close();
  }
  try {
    const notDue = await runNomaCloudMaintenanceOnce({ ...storage, now: () => new Date(clock.now), ai: { provider: null } });
    assert.equal(notDue.runs.length, 0);
    const due = await runNomaCloudMaintenanceOnce({ ...storage, now: () => new Date(clock.now + 2 * 3_600_000), ai: { provider: null } });
    assert.equal(due.runs.length, 1);
    assert.equal(due.runs[0]!.status, "completed");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function startTextServer(text: string): Promise<{ server: Server; url: string }> {
  const server = createServer((_req, res) => {
    res.setHeader("content-type", "text/plain; charset=utf-8");
    res.end(text);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return { server, url: `http://127.0.0.1:${address.port}/status.txt` };
}

async function createPage(base: string, token: string, title: string, source: string): Promise<{ id: string; hash: string }> {
  return json<{ id: string; hash: string }>(`${base}/api/documents`, { method: "POST", token, body: { title, source } });
}

async function startCloudServer(
  prefix: string,
  ai: NomaCloudAiOptions,
  overrides: Partial<NomaCloudServerOptions> = {},
): Promise<{ base: string; close: () => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const publicDir = join(root, "public");
  await mkdir(publicDir, { recursive: true });
  await writeFile(join(publicDir, "index.html"), "<h1>Noma</h1>", "utf8");
  const server = createNomaCloudServer({
    dataDir: join(root, "data", "documents"),
    usersDir: join(root, "data", "users"),
    sitesDir: join(root, "data", "sites"),
    dbPath: join(root, "data", "noma-cloud.sqlite"),
    publicDir,
    maxBodyBytes: 100_000,
    rateLimitMaxRequests: 10_000,
    now: () => new Date("2026-06-06T12:00:00.000Z"),
    ...overrides,
    ai: { maintenanceTickMs: 0, ...ai },
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return {
    base: `http://127.0.0.1:${address.port}`,
    close: async () => {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
      await rm(root, { recursive: true, force: true });
    },
  };
}

async function createCloudUser(base: string, name: string): Promise<CloudUserResponse> {
  return json<CloudUserResponse>(`${base}/api/users`, { method: "POST", body: { name } });
}

async function json<T = { error?: string }>(url: string, options: JsonRequestOptions = {}): Promise<T> {
  const headers = new Headers({ accept: "application/json" });
  if (options.token) headers.set("authorization", `Bearer ${options.token}`);
  if (options.body) headers.set("content-type", "application/json");
  const response = await fetch(url, { method: options.method ?? "GET", headers, body: options.body ? JSON.stringify(options.body) : undefined });
  if (options.expectedStatus !== undefined) {
    assert.equal(response.status, options.expectedStatus, await response.text());
    return {} as T;
  }
  if (!response.ok) assert.fail(`${response.status} ${await response.text()}`);
  return response.json() as Promise<T>;
}
