import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import test from "node:test";
import { isPrivateAddress, slackWebhookBody } from "../src/cloud/webhooks.js";
import { type CloudDocumentResponse, createCloudUser, json, request, savePage, startCloudServer } from "./cloud-wiki-harness.js";

interface Received {
  headers: IncomingHttpHeaders;
  body: string;
  json: Record<string, unknown>;
}

interface Receiver {
  url: string;
  received: Received[];
  statuses: number[];
  close: () => Promise<void>;
}

async function startReceiver(): Promise<Receiver> {
  const received: Received[] = [];
  const statuses: number[] = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const body = Buffer.concat(chunks).toString("utf8");
      received.push({ headers: req.headers, body, json: JSON.parse(body) as Record<string, unknown> });
      res.statusCode = statuses.shift() ?? 200;
      res.end("ok");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return {
    url: `http://127.0.0.1:${address.port}/hook`,
    received,
    statuses,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

interface DeliveryLogEntry {
  event: string;
  status: string;
  attempts: number;
  responseStatus?: number;
  lastError?: string;
  nextAttemptAt: string;
}

/** Polls the delivery log until `check` accepts it; deliveries are recorded after the receiver answers. */
async function waitForLog(url: string, token: string, check: (deliveries: DeliveryLogEntry[]) => boolean, label: string): Promise<DeliveryLogEntry[]> {
  const started = Date.now();
  for (;;) {
    const deliveries = (await json<{ deliveries: DeliveryLogEntry[] }>(url, { token })).deliveries;
    if (check(deliveries)) return deliveries;
    if (Date.now() - started > 10_000) assert.fail(`timed out waiting for ${label}: ${JSON.stringify(deliveries)}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function waitFor(check: () => boolean, label: string, timeoutMs = 10_000): Promise<void> {
  const started = Date.now();
  while (!check()) {
    if (Date.now() - started > timeoutMs) assert.fail(`timed out waiting for ${label}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

test("private-address detection covers loopback, private, link-local, CGNAT and mapped IPv6", () => {
  for (const address of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "::1", "fe80::1", "fd00::1", "::ffff:127.0.0.1", "224.0.0.1"]) {
    assert.equal(isPrivateAddress(address), true, address);
  }
  for (const address of ["8.8.8.8", "172.32.0.1", "2606:4700::1111", "::ffff:8.8.8.8"]) assert.equal(isPrivateAddress(address), false, address);
  assert.deepEqual(slackWebhookBody({ event: "comment.created", actor: { name: "Ada" }, page: { title: "Plan" }, space: { title: "Eng", key: "ENG" }, comment: { body: "Looks good" } }), {
    text: "Ada commented on “Plan” in ENG · Eng: Looks good",
  });
});

test("webhook targets on private networks are rejected unless explicitly allowed", async () => {
  const previous = process.env.NOMA_CLOUD_ALLOW_PRIVATE_WEBHOOKS;
  delete process.env.NOMA_CLOUD_ALLOW_PRIVATE_WEBHOOKS;
  const harness = await startCloudServer("noma-webhooks-ssrf-");
  try {
    const ada = await createCloudUser(harness.base, "Ada");
    const space = await json<{ id: string }>(`${harness.base}/api/sites`, { method: "POST", token: ada.token, body: { title: "Eng", documentIds: [] } });
    for (const url of ["http://127.0.0.1:9/x", "http://localhost/x", "http://10.0.0.5/x", "http://169.254.169.254/latest/meta-data", "http://[::1]/x", "ftp://example.com/x", "https://user:pass@example.com/x"]) {
      await json(`${harness.base}/api/sites/${space.id}/webhooks`, { method: "POST", token: ada.token, body: { url, events: ["page.updated"] }, expectedStatus: 400 });
    }
    const created = await json<{ id: string }>(`${harness.base}/api/sites/${space.id}/webhooks`, { method: "POST", token: ada.token, body: { url: "https://hooks.example.com/noma", events: ["page.updated"] } });
    assert.ok(created.id);
  } finally {
    if (previous === undefined) delete process.env.NOMA_CLOUD_ALLOW_PRIVATE_WEBHOOKS;
    else process.env.NOMA_CLOUD_ALLOW_PRIVATE_WEBHOOKS = previous;
    await harness.close();
  }
});

test("space webhooks sign deliveries, retry with backoff, support Slack format, and keep a delivery log", async () => {
  const previous = process.env.NOMA_CLOUD_ALLOW_PRIVATE_WEBHOOKS;
  process.env.NOMA_CLOUD_ALLOW_PRIVATE_WEBHOOKS = "1";
  const receiver = await startReceiver();
  const slack = await startReceiver();
  const harness = await startCloudServer("noma-webhooks-", { queueIntervalMs: 40 });
  const { base, clock } = harness;
  try {
    const ada = await createCloudUser(base, "Ada Lovelace");
    const bob = await createCloudUser(base, "Bob Builder");
    const space = await json<{ id: string; key: string }>(`${base}/api/sites`, { method: "POST", token: ada.token, body: { title: "Engineering", key: "ENG", documentIds: [] } });
    await json(`${base}/api/sites/${space.id}/collaborators`, { method: "POST", token: ada.token, body: { userId: bob.id, role: "editor" } });

    await json(`${base}/api/sites/${space.id}/webhooks`, { method: "POST", token: bob.token, body: { url: receiver.url, events: ["page.created"] }, expectedStatus: 403 });
    await json(`${base}/api/sites/${space.id}/webhooks`, { method: "POST", token: ada.token, body: { url: receiver.url, events: ["page.exploded"] }, expectedStatus: 400 });
    await json(`${base}/api/sites/${space.id}/webhooks`, { method: "POST", token: ada.token, body: { url: receiver.url, events: [] }, expectedStatus: 400 });
    await json(`${base}/api/sites/${space.id}/webhooks`, { method: "POST", token: ada.token, body: { url: receiver.url, events: ["page.created"], secret: "short" }, expectedStatus: 400 });
    const secret = "test-signing-secret-0123456789";
    const hook = await json<{ id: string; secret: string; events: string[] }>(`${base}/api/sites/${space.id}/webhooks`, {
      method: "POST",
      token: ada.token,
      body: { url: receiver.url, secret, events: ["page.created", "page.updated", "page.deleted", "comment.created", "label.changed", "task.completed"] },
    });
    assert.equal(hook.secret, secret);
    const slackHook = await json<{ id: string; secret: string }>(`${base}/api/sites/${space.id}/webhooks`, { method: "POST", token: ada.token, body: { url: slack.url, events: ["comment.created"], format: "slack" } });
    assert.match(slackHook.secret, /^whsec_/);
    const listed = await json<{ webhooks: Array<{ id: string; secret?: string; secretPreview: string }> }>(`${base}/api/sites/${space.id}/webhooks`, { token: ada.token });
    assert.equal(listed.webhooks.length, 2);
    assert.ok(listed.webhooks.every((item) => item.secret === undefined && item.secretPreview.startsWith("…")));
    await json(`${base}/api/sites/${space.id}/webhooks`, { token: bob.token, expectedStatus: 403 });

    let page = await json<CloudDocumentResponse>(`${base}/api/sites/${space.id}/documents`, { method: "POST", token: bob.token, body: { source: "# Runbook\n\n- [ ] Rotate keys\n" } });
    await waitFor(() => receiver.received.length === 1, "page.created");
    const created = receiver.received[0]!;
    assert.equal(created.headers["x-noma-event"], "page.created");
    const timestamp = String(created.headers["x-noma-timestamp"]);
    const expected = `sha256=${createHmac("sha256", secret).update(`${timestamp}.${created.body}`).digest("hex")}`;
    assert.equal(created.headers["x-noma-signature"], expected);
    assert.equal(created.headers["x-noma-delivery"], created.json.id);
    assert.deepEqual(created.json.space, { id: space.id, title: "Engineering", key: "ENG" });
    assert.deepEqual((created.json.actor as { name: string }).name, "Bob Builder");
    assert.equal((created.json.page as { id: string }).id, page.id);

    receiver.statuses.push(500);
    page = await savePage(base, ada.token, page, `${page.source}\nMore detail.\n`);
    await waitFor(() => receiver.received.length === 2, "failed page.updated attempt");
    const logUrl = `${base}/api/sites/${space.id}/webhooks/${hook.id}/deliveries`;
    const updated = (await waitForLog(logUrl, ada.token, (entries) => entries.some((entry) => entry.event === "page.updated" && entry.attempts === 1), "first page.updated attempt")).find((entry) => entry.event === "page.updated")!;
    assert.deepEqual([updated.status, updated.attempts, updated.responseStatus], ["pending", 1, 500]);
    assert.equal(updated.nextAttemptAt, "2026-06-06T12:00:30.000Z", "first retry waits 30 seconds");
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(receiver.received.length, 2, "no retry before the backoff elapses");
    clock.advance(31_000);
    await waitFor(() => receiver.received.length === 3, "retried page.updated");
    assert.equal(receiver.received[2]!.headers["x-noma-delivery"], receiver.received[1]!.headers["x-noma-delivery"], "a retry reuses the delivery ID");

    await json(`${base}/api/documents/${page.id}/comments`, { method: "POST", token: bob.token, body: { body: "Ship it" } });
    await waitFor(() => slack.received.length === 1 && receiver.received.length === 4, "comment.created");
    assert.deepEqual(slack.received[0]!.json, { text: "Bob Builder commented on “Runbook” in ENG · Engineering: Ship it" });
    assert.ok(String(slack.received[0]!.headers["x-noma-signature"]).startsWith("sha256="));

    await json(`${base}/api/documents/${page.id}/labels`, { method: "POST", token: bob.token, body: { label: "ops" } });
    await waitFor(() => receiver.received.length === 5, "label.changed");
    assert.deepEqual([receiver.received[4]!.json.event, receiver.received[4]!.json.added], ["label.changed", ["ops"]]);

    const taskId = /\{#(task-[a-z0-9]+)\}/.exec(page.source)?.[1];
    assert.ok(taskId);
    await json(`${base}/api/documents/${page.id}/tasks/${taskId}`, { method: "POST", token: bob.token, body: { done: true } });
    await waitFor(() => receiver.received.some((item) => item.json.event === "task.completed"), "task.completed");
    const completed = receiver.received.find((item) => item.json.event === "task.completed")!;
    assert.equal((completed.json.task as { title: string }).title, "Rotate keys");

    await json(`${base}/api/trash/document/${page.id}`, { method: "POST", token: ada.token });
    await waitFor(() => receiver.received.some((item) => item.json.event === "page.deleted"), "page.deleted");

    const deliveries = await waitForLog(logUrl, ada.token, (entries) => entries.length === 7 && entries.every((entry) => entry.status === "delivered"), "all deliveries delivered");
    assert.deepEqual(deliveries.map((entry) => entry.event).sort(), ["comment.created", "label.changed", "page.created", "page.deleted", "page.updated", "page.updated", "task.completed"], "completing a task is also a page update");
    await json(`${base}/api/sites/${space.id}/webhooks/${hook.id}/deliveries`, { token: bob.token, expectedStatus: 403 });

    const deleted = await request(`${base}/api/sites/${space.id}/webhooks/${hook.id}`, { method: "DELETE", token: ada.token });
    assert.equal(deleted.status, 200);
    await json(`${base}/api/sites/${space.id}/webhooks/${hook.id}`, { token: ada.token, expectedStatus: 404 });
    const before = receiver.received.length;
    const other = await json<CloudDocumentResponse>(`${base}/api/sites/${space.id}/documents`, { method: "POST", token: ada.token, body: { source: "# Other\n\nText.\n" } });
    await new Promise((resolve) => setTimeout(resolve, 150));
    assert.equal(receiver.received.length, before, "deleted webhooks stop receiving events");
    assert.ok(other.id);
  } finally {
    await harness.close();
    await receiver.close();
    await slack.close();
    if (previous === undefined) delete process.env.NOMA_CLOUD_ALLOW_PRIVATE_WEBHOOKS;
    else process.env.NOMA_CLOUD_ALLOW_PRIVATE_WEBHOOKS = previous;
  }
});

test("deliveries give up after the maximum attempts and literal private targets fail permanently once disallowed", async () => {
  const previous = process.env.NOMA_CLOUD_ALLOW_PRIVATE_WEBHOOKS;
  process.env.NOMA_CLOUD_ALLOW_PRIVATE_WEBHOOKS = "1";
  const receiver = await startReceiver();
  const harness = await startCloudServer("noma-webhooks-retry-", { queueIntervalMs: 25 });
  const { base, clock } = harness;
  try {
    const ada = await createCloudUser(base, "Ada");
    const space = await json<{ id: string }>(`${base}/api/sites`, { method: "POST", token: ada.token, body: { title: "Eng", documentIds: [] } });
    const hook = await json<{ id: string }>(`${base}/api/sites/${space.id}/webhooks`, { method: "POST", token: ada.token, body: { url: receiver.url, events: ["page.created"] } });
    receiver.statuses.push(...Array.from({ length: 20 }, () => 503));
    await json(`${base}/api/sites/${space.id}/documents`, { method: "POST", token: ada.token, body: { source: "# One\n\nx\n" } });
    const logUrl = `${base}/api/sites/${space.id}/webhooks/${hook.id}/deliveries`;
    for (let attempt = 1; attempt <= 8; attempt++) {
      await waitForLog(logUrl, ada.token, (entries) => entries[0]?.attempts === attempt, `attempt ${attempt}`);
      clock.advance(7 * 60 * 60 * 1000);
    }
    const final = (await waitForLog(logUrl, ada.token, (entries) => entries[0]?.status === "failed", "failed delivery"))[0];
    assert.deepEqual([final?.status, final?.attempts, final?.responseStatus], ["failed", 8, 503]);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(receiver.received.length, 8, "no attempts after giving up");

    delete process.env.NOMA_CLOUD_ALLOW_PRIVATE_WEBHOOKS;
    await json(`${base}/api/sites/${space.id}/documents`, { method: "POST", token: ada.token, body: { source: "# Two\n\nx\n" } });
    const blocked = (await waitForLog(logUrl, ada.token, (entries) => entries.length === 2 && entries.every((entry) => entry.status === "failed"), "blocked delivery")).find((entry) => entry.attempts === 1);
    assert.deepEqual([blocked?.status, blocked?.lastError], ["failed", "Blocked private address"]);
    assert.equal(receiver.received.length, 8);
  } finally {
    await harness.close();
    await receiver.close();
    if (previous === undefined) delete process.env.NOMA_CLOUD_ALLOW_PRIVATE_WEBHOOKS;
    else process.env.NOMA_CLOUD_ALLOW_PRIVATE_WEBHOOKS = previous;
  }
});
