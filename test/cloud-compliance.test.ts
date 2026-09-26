import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CloudChatStore, type ChatEvent } from "../src/cloud-chat.js";
import { DLP_DETECTORS } from "../src/cloud-compliance.js";
import { scanText } from "../src/cloud/dlp.js";
import { createCloudUser, createSpace, json, request, startCloudServer } from "./cloud-wiki-harness.js";

const AWS_KEY = "AKIAIOSFODNN7EXAMPLE";
const GITHUB_TOKEN = `ghp_${"a1B2c3D4e5".repeat(4)}`;

test("DLP detectors find secrets and valid card numbers, not look-alikes", () => {
  const found = (text: string) => Object.fromEntries(scanText(text, DLP_DETECTORS));
  assert.deepEqual(found(`key ${AWS_KEY} and ${GITHUB_TOKEN}`), { aws_access_key: 1, github_token: 1 });
  assert.deepEqual(found("-----BEGIN OPENSSH PRIVATE KEY-----\nabc"), { private_key: 1 });
  assert.deepEqual(found("xoxb-12345678901-abcdefghij"), { slack_token: 1 });
  assert.deepEqual(found(`sk-ant-${"x".repeat(30)}`), { api_key: 1 });
  assert.deepEqual(found("card 4111 1111 1111 1111 on file"), { credit_card: 1 });
  assert.deepEqual(found("order 4111 1111 1111 1112, phone 0000000000000000, sku 1234567890123"), {}, "Luhn and repeated digits rule out look-alikes");
  assert.deepEqual(Object.fromEntries(scanText(`${AWS_KEY} 4111111111111111`, ["credit_card"])), { credit_card: 1 }, "only enabled detectors run");
});

test("DLP warn records findings; block refuses chat, issue, and page writes without echoing the secret", async () => {
  const harness = await startCloudServer("noma-dlp-");
  const { base } = harness;
  try {
    const ada = await createCloudUser(base, "Ada Admin");
    const bob = await createCloudUser(base, "Bob Builder");
    const { site, pages } = await createSpace(base, ada.token, "Delivery", [`# Keys\n\nLegacy key ${AWS_KEY} (rotated).\n`]);
    await json(`${base}/api/sites/${site.id}/collaborators`, { method: "POST", token: ada.token, body: { userId: bob.id, role: "editor" } });
    const channel = await json<{ id: string }>(`${base}/api/channels`, { method: "POST", token: ada.token, body: { siteId: site.id, name: "ops" } });
    const project = await json<{ id: string }>(`${base}/api/projects`, { method: "POST", token: ada.token, body: { siteId: site.id, key: "OPS", name: "Ops" } });
    const issue = await json<{ id: string }>(`${base}/api/projects/${project.id}/issues`, { method: "POST", token: bob.token, body: { summary: "Rotate keys" } });

    await json(`${base}/api/enterprise/dlp`, { method: "PUT", token: bob.token, body: { mode: "block" }, expectedStatus: 403 });
    await json(`${base}/api/enterprise/dlp`, { method: "PUT", token: ada.token, body: { mode: "loud" }, expectedStatus: 400 });
    await json(`${base}/api/enterprise/dlp`, { method: "PUT", token: ada.token, body: { mode: "warn" } });
    await json(`${base}/api/channels/${channel.id}/messages`, { method: "POST", token: bob.token, body: { body: `use ${GITHUB_TOKEN}` }, expectedStatus: 201 });

    const policy = await json<{ mode: string; detectors: string[] }>(`${base}/api/enterprise/dlp`, { method: "PUT", token: ada.token, body: { mode: "block" } });
    assert.deepEqual(policy.detectors, [...DLP_DETECTORS]);
    const blocked = await request<{ code: string; detectors: string[]; error: string }>(`${base}/api/channels/${channel.id}/messages`, { method: "POST", token: bob.token, body: { body: `here: ${AWS_KEY}` } });
    assert.equal(blocked.status, 422);
    assert.deepEqual([blocked.body.code, blocked.body.detectors], ["dlp_blocked", ["aws_access_key"]]);
    assert.doesNotMatch(JSON.stringify(blocked.body), new RegExp(AWS_KEY), "the response never echoes the secret");
    const ok = await json<{ id: string }>(`${base}/api/channels/${channel.id}/messages`, { method: "POST", token: bob.token, body: { body: "rotated, all good" } });
    await json(`${base}/api/channels/${channel.id}/messages/${ok.id}`, { method: "PATCH", token: bob.token, body: { body: `oops ${AWS_KEY}` }, expectedStatus: 422 });
    await json(`${base}/api/projects/${project.id}/issues/${issue.id}/comments`, { method: "POST", token: bob.token, body: { body: "card 4111-1111-1111-1111" }, expectedStatus: 422 });
    await json(`${base}/api/projects/${project.id}/issues`, { method: "POST", token: bob.token, body: { summary: "x", description: "-----BEGIN RSA PRIVATE KEY-----" }, expectedStatus: 422 });

    const page = pages[0]!;
    const edited = await json<{ hash: string }>(`${base}/api/documents/${page.id}`, { method: "PUT", token: ada.token, body: { expectedHash: page.hash, source: `# Keys\n\nLegacy key ${AWS_KEY} (rotated). Next rotation in May.\n` } });
    assert.ok(edited.hash, "an edit that keeps an existing value is not blocked again");
    await json(`${base}/api/documents/${page.id}`, { method: "PUT", token: ada.token, body: { expectedHash: edited.hash, source: `# Keys\n\nLegacy key ${AWS_KEY}.\nNew: ${GITHUB_TOKEN}\n` }, expectedStatus: 422 });
    await json(`${base}/api/documents/${page.id}`, { method: "PUT", token: ada.token, body: { expectedHash: edited.hash, source: "# Keys\n\nLegacy key AKIAABCDEFGHIJKLMNOP (rotated). Next rotation in May.\n" }, expectedStatus: 422 });
    await json(`${base}/api/sites/${site.id}/documents`, { method: "POST", token: ada.token, body: { source: `# New\n\n${GITHUB_TOKEN}\n` }, expectedStatus: 422 });

    const findings = await json<{ findings: Array<{ outcome: string; detectors: string[]; resourceType: string }> }>(`${base}/api/enterprise/dlp-findings`, { token: ada.token });
    assert.deepEqual(findings.findings.filter((finding) => finding.outcome === "flagged").map((finding) => finding.detectors), [["github_token"]]);
    assert.deepEqual(new Set(findings.findings.filter((finding) => finding.outcome === "blocked").map((finding) => finding.resourceType)), new Set(["chat_channel", "chat_message", "issue", "document"]));
    assert.doesNotMatch(JSON.stringify(findings), new RegExp(`${AWS_KEY}|${GITHUB_TOKEN}`));
    const audit = await json<{ events: Array<{ action: string }> }>(`${base}/api/enterprise/audit`, { token: ada.token });
    assert.ok(["dlp.flagged", "dlp.blocked", "dlp.policy_updated"].every((action) => audit.events.some((event) => event.action === action)));
  } finally {
    await harness.close();
  }
});

test("the audit log exports as NDJSON and ships to a SIEM with a cursor that survives outages", async () => {
  const received: Array<{ body: string; auth?: string; signature?: string }> = [];
  let fail = false;
  const siem = createServer((req: IncomingMessage, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      if (fail) {
        res.writeHead(503).end();
        return;
      }
      received.push({ body: Buffer.concat(chunks).toString("utf8"), auth: req.headers.authorization, signature: req.headers["x-noma-signature"] as string | undefined });
      res.writeHead(202).end();
    });
  });
  await new Promise<void>((resolve) => siem.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${(siem.address() as AddressInfo).port}/ingest`;
  const harness = await startCloudServer("noma-siem-", { siem: { url, token: "siem-secret" } });
  const { base } = harness;
  try {
    const ada = await createCloudUser(base, "Ada Admin");
    const bob = await createCloudUser(base, "Bob Builder");
    await json(`${base}/api/enterprise/siem`, { token: bob.token, expectedStatus: 403 });
    await json(`${base}/api/enterprise/dlp`, { method: "PUT", token: ada.token, body: { mode: "warn" } });

    const shipped = await json<{ configured: boolean; cursor: number; lag: number; lastBatch: number }>(`${base}/api/enterprise/siem/ship`, { method: "POST", token: ada.token });
    assert.equal(shipped.configured, true);
    assert.equal(shipped.lag, 0);
    assert.equal(received.length, 1);
    const lines = received[0]!.body.trim().split("\n").map((line) => JSON.parse(line) as { sequence: number; action: string; source: string });
    assert.ok(lines.some((line) => line.action === "dlp.policy_updated"));
    assert.ok(lines.every((line, index) => line.source === "noma-cloud" && (index === 0 || line.sequence > lines[index - 1]!.sequence)));
    assert.equal(received[0]!.auth, "Bearer siem-secret");
    assert.equal(received[0]!.signature, `sha256=${createHmac("sha256", "siem-secret").update(received[0]!.body).digest("hex")}`);

    fail = true;
    await json(`${base}/api/enterprise/dlp`, { method: "PUT", token: ada.token, body: { mode: "block" } });
    const down = await json<{ cursor: number; lastError: string; lag: number }>(`${base}/api/enterprise/siem/ship`, { method: "POST", token: ada.token });
    assert.equal(down.cursor, shipped.cursor, "a failed batch does not move the cursor");
    assert.match(down.lastError, /503/);
    assert.ok(down.lag >= 1);
    fail = false;
    const recovered = await json<{ cursor: number; lastError?: string; lag: number }>(`${base}/api/enterprise/siem/ship`, { method: "POST", token: ada.token });
    assert.equal(recovered.lastError, undefined);
    assert.ok(recovered.cursor > shipped.cursor);
    assert.match(received.at(-1)!.body, /"action":"dlp.policy_updated"/);

    const ndjson = await fetch(`${base}/api/enterprise/audit.ndjson?after=0&limit=2`, { headers: { authorization: `Bearer ${ada.token}` } });
    assert.equal(ndjson.headers.get("content-type"), "application/x-ndjson; charset=utf-8");
    const records = (await ndjson.text()).trim().split("\n").map((line) => JSON.parse(line) as { sequence: number });
    assert.equal(records.length, 2);
    assert.equal(ndjson.headers.get("x-noma-next-after"), String(records[1]!.sequence));
  } finally {
    await harness.close();
    await new Promise<void>((resolve) => siem.close(() => resolve()));
  }
});

test("the admin overview summarises people, content, chat, AI, runs, and compliance", async () => {
  const harness = await startCloudServer("noma-overview-");
  const { base } = harness;
  try {
    const ada = await createCloudUser(base, "Ada Admin");
    const bob = await createCloudUser(base, "Bob Builder");
    const { site } = await createSpace(base, ada.token, "Delivery", ["# One\n", "# Two\n"]);
    const channel = await json<{ id: string }>(`${base}/api/channels`, { method: "POST", token: ada.token, body: { siteId: site.id, name: "general" } });
    await json(`${base}/api/channels/${channel.id}/messages`, { method: "POST", token: ada.token, body: { body: "hello" } });
    const project = await json<{ id: string }>(`${base}/api/projects`, { method: "POST", token: ada.token, body: { siteId: site.id, key: "SHIP", name: "Ship" } });
    await json(`${base}/api/projects/${project.id}/issues`, { method: "POST", token: ada.token, body: { summary: "A" } });
    await json(`${base}/api/enterprise/dlp`, { method: "PUT", token: ada.token, body: { mode: "off" } });
    await json(`${base}/api/enterprise/overview`, { token: bob.token, expectedStatus: 403 });
    const readOnly = await json<{ token: string }>(`${base}/api/tokens`, { method: "POST", token: ada.token, body: { name: "Reporter", scopes: ["read"] } });
    await json(`${base}/api/enterprise/overview`, { token: readOnly.token, expectedStatus: 403 });
    assert.equal((await json<{ killSwitch?: unknown }>(`${base}/api/approvals`, { token: readOnly.token })).killSwitch, undefined, "a token without the admin scope is not offered admin controls it cannot use");
    assert.ok((await json<{ killSwitch?: unknown }>(`${base}/api/approvals`, { token: ada.token })).killSwitch);
    const overview = await json<{
      people: { users: number };
      knowledge: { spaces: number; pages: number };
      work: { projects: number; openIssues: number };
      chat: { channels: number; messages: number };
      ai: { agents: { active: number }; paused: boolean };
      runs: { environment: string | null; runs: number };
      compliance: { dlp: { mode: string }; siem: { configured: boolean }; audit: { latestSequence: number } };
    }>(`${base}/api/enterprise/overview`, { token: ada.token });
    assert.equal(overview.people.users, 2);
    assert.deepEqual(overview.knowledge, { spaces: 1, pages: 2 });
    assert.deepEqual(overview.work, { projects: 1, openIssues: 1 });
    assert.deepEqual([overview.chat.channels, overview.chat.messages], [1, 1]);
    assert.deepEqual([overview.ai.agents.active, overview.ai.paused], [0, false]);
    assert.deepEqual([overview.runs.environment, overview.runs.runs], [null, 0]);
    assert.deepEqual([overview.compliance.dlp.mode, overview.compliance.siem.configured], ["off", false]);
    assert.ok(overview.compliance.audit.latestSequence > 0);
  } finally {
    await harness.close();
  }
});

test("chat events fan out across processes sharing one database", async () => {
  const root = await mkdtemp(join(tmpdir(), "noma-chat-fanout-"));
  const dbPath = join(root, "cloud.sqlite");
  const first = new CloudChatStore(dbPath, { tailIntervalMs: 10 });
  const second = new CloudChatStore(dbPath, { tailIntervalMs: 10 });
  try {
    const now = new Date().toISOString();
    first.createChannel({ id: "c1", kind: "channel", siteId: "s1", name: "general", visibility: "public", createdBy: "u1", createdAt: now, updatedAt: now });
    const seenBySecond: ChatEvent[] = [];
    const seenByFirst: ChatEvent[] = [];
    const stopSecond = second.subscribe("c1", (event) => seenBySecond.push(event));
    const stopFirst = first.subscribe("c1", (event) => seenByFirst.push(event));
    first.postMessage({ id: "m1", channelId: "c1", kind: "message", authorId: "u1", body: "hi", links: {}, createdAt: now });
    for (let attempt = 0; attempt < 100 && seenBySecond.length === 0; attempt++) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.deepEqual(seenBySecond.map((event) => [event.type, event.messageId]), [["message", "m1"]], "the other process hears the message");
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(seenByFirst.length, 1, "a process does not replay its own events");
    stopSecond();
    stopFirst();

    first.postMessage({ id: "m2", channelId: "c1", kind: "message", authorId: "u1", body: "while nobody listened", links: {}, createdAt: now });
    const late: ChatEvent[] = [];
    const stopLate = second.subscribe("c1", (event) => late.push(event));
    for (let attempt = 0; attempt < 100 && late.length === 0; attempt++) await new Promise((resolve) => setTimeout(resolve, 10));
    assert.deepEqual(late.map((event) => event.messageId), ["m2"], "an event written just before a stream opens still reaches it");
    stopLate();
  } finally {
    first.close();
    second.close();
    await rm(root, { recursive: true, force: true });
  }
});
