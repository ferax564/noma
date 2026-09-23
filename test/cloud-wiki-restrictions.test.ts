import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join } from "node:path";
import test from "node:test";
import { type CloudDocumentResponse, createCloudUser, json, request, savePage, startCloudServer } from "./cloud-wiki-harness.js";

test("search filters, directory, popular pages, tasks, analytics, mentions, webhooks and digests never leak view-restricted pages", async () => {
  const previous = { ...process.env };
  process.env.NOMA_CLOUD_ALLOW_PRIVATE_WEBHOOKS = "1";
  process.env.NOMA_CLOUD_MAIL_TRANSPORT = "log";
  const received: Array<{ event: string; page?: { id: string; title: string } }> = [];
  const receiver = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      received.push(JSON.parse(Buffer.concat(chunks).toString("utf8")) as { event: string; page?: { id: string; title: string } });
      res.end("ok");
    });
  });
  await new Promise<void>((resolve) => receiver.listen(0, "127.0.0.1", resolve));
  const port = (receiver.address() as { port: number }).port;
  const harness = await startCloudServer("noma-wiki-restrictions-", { queueIntervalMs: 25 });
  const { base, clock } = harness;
  const mailLog = join(harness.root, "mail.log");
  process.env.NOMA_CLOUD_MAIL_LOG = mailLog;
  try {
    await createCloudUser(base, "Root Admin");
    const ada = await createCloudUser(base, "Ada Lovelace");
    const bob = await createCloudUser(base, "Bob Builder");
    const space = await json<{ id: string }>(`${base}/api/sites`, { method: "POST", token: ada.token, body: { title: "Engineering", key: "ENG", documentIds: [] } });
    await json(`${base}/api/sites/${space.id}/collaborators`, { method: "POST", token: ada.token, body: { userId: bob.id, role: "editor" } });
    await json(`${base}/api/sites/${space.id}/webhooks`, { method: "POST", token: ada.token, body: { url: `http://127.0.0.1:${port}/hook`, events: ["page.updated", "comment.created", "label.changed", "task.completed"] } });
    const open = await json<CloudDocumentResponse>(`${base}/api/sites/${space.id}/documents`, { method: "POST", token: ada.token, body: { source: "# Public Plan\n\nThe flamingo roadmap is public.\n" } });
    let secret = await json<CloudDocumentResponse>(`${base}/api/sites/${space.id}/documents`, {
      method: "POST",
      token: ada.token,
      body: { source: `# Secret Payroll\n\nThe flamingo salary ledger.\n\n- [ ] Reconcile payroll @{${bob.id}}\n` },
    });
    await json(`${base}/api/documents/${secret.id}/labels`, { method: "POST", token: ada.token, body: { label: "how-to" } });
    for (const token of [ada.token, bob.token]) {
      await json(`${base}/api/documents/${secret.id}/views`, { method: "POST", token });
      await json(`${base}/api/documents/${open.id}/views`, { method: "POST", token });
    }
    await json(`${base}/api/sites/${space.id}`, { method: "PUT", token: ada.token, body: { homeDocumentId: secret.id } });
    await json(`${base}/api/users/me`, { method: "PUT", token: bob.token, body: { email: "bob@example.com" } });
    await json(`${base}/api/users/me/preferences`, { method: "PUT", token: bob.token, body: { digest: "daily" } });
    assert.equal((await json<{ tasks: unknown[] }>(`${base}/api/tasks`, { token: bob.token })).tasks.length, 1, "bob sees his task before the lock");

    await json(`${base}/api/documents/${secret.id}/restrictions`, { method: "PUT", token: ada.token, body: { view: { users: [ada.id], groups: [] } } });
    const hookCount = received.length;
    await json(`${base}/api/sites/${space.id}/watch`, { method: "PUT", token: bob.token });

    const titles = async (path: string) => JSON.stringify(await json(`${base}${path}`, { token: bob.token }));
    for (const path of [
      "/api/search?q=flamingo",
      "/api/search?q=label:how-to",
      "/api/search?q=type:page+space:ENG",
      "/api/search?q=flamingo+type:page",
      "/api/knowledge/search?q=flamingo",
      "/api/knowledge/search?q=label:how-to",
      `/api/sites/${space.id}/popular`,
      "/api/tasks?assignee=me&status=all",
      "/api/tasks?assignee=any&status=all",
      `/api/sites/${space.id}`,
      "/api/sites",
      "/api/labels",
    ]) {
      const body = await titles(path);
      assert.ok(!body.includes("Secret Payroll") && !body.includes(secret.id), `${path} leaked the restricted page: ${body.slice(0, 300)}`);
    }
    assert.match(await titles("/api/search?q=flamingo"), /Public Plan/, "unrestricted pages still match");
    assert.match(await titles(`/api/sites/${space.id}/popular`), /Public Plan/);
    const adaPopular = await json<{ pages: Array<{ documentId: string }> }>(`${base}/api/sites/${space.id}/popular`, { token: ada.token });
    assert.ok(adaPopular.pages.some((page) => page.documentId === secret.id), "people who can see the page still get it");
    const bobSpace = await json<{ homeDocumentId: string | null }>(`${base}/api/sites/${space.id}`, { token: bob.token });
    assert.equal(bobSpace.homeDocumentId, null);

    for (const path of [`/api/documents/${secret.id}/analytics`, `/api/users?q=a&document=${secret.id}`, `/api/documents/${secret.id}/tasks`]) {
      const response = await request(`${base}${path}`, { token: bob.token });
      assert.ok(response.status === 403 || response.status === 404, `${path} returned ${response.status}`);
    }
    const viewers = await json<{ viewers?: Array<{ name: string }> }>(`${base}/api/documents/${secret.id}/analytics`, { token: ada.token });
    assert.ok(viewers.viewers?.length);
    const directory = await json<{ users: Array<{ name: string }> }>(`${base}/api/users?q=&document=${secret.id}`, { token: ada.token });
    assert.deepEqual(directory.users.map((user) => user.name), ["Ada Lovelace"], "the page directory only lists people who can open it");

    const bobMentionsBefore = (await json<{ notifications: Array<{ type: string }> }>(`${base}/api/notifications`, { token: bob.token })).notifications.filter((item) => item.type === "mention").length;
    secret = await savePage(base, ada.token, secret, `${secret.source}\nPing @{${bob.id}} about the ledger.\n`);
    await json(`${base}/api/documents/${secret.id}/labels`, { method: "POST", token: ada.token, body: { label: "payroll" } });
    await json(`${base}/api/documents/${secret.id}/comments`, { method: "POST", token: ada.token, body: { body: "Locked down" } });
    await savePage(base, ada.token, open, "# Public Plan\n\nThe flamingo roadmap is public, v2.\n");
    const bobMentionsAfter = (await json<{ notifications: Array<{ type: string }> }>(`${base}/api/notifications`, { token: bob.token })).notifications.filter((item) => item.type === "mention").length;
    assert.equal(bobMentionsAfter, bobMentionsBefore, "no mention notifications for pages the user cannot open");

    const started = Date.now();
    while (!received.slice(hookCount).some((item) => item.page?.id === open.id) && Date.now() - started < 10_000) await new Promise((resolve) => setTimeout(resolve, 20));
    assert.ok(received.slice(hookCount).some((item) => item.page?.id === open.id), "unrestricted pages still emit webhooks");
    assert.ok(!received.slice(hookCount).some((item) => item.page?.id === secret.id), "restricted pages emit no webhook payloads");

    clock.advance(25 * 60 * 60 * 1000);
    const digestStarted = Date.now();
    let log = "";
    while (!log.includes("digest") && Date.now() - digestStarted < 10_000) {
      await new Promise((resolve) => setTimeout(resolve, 25));
      log = await readFile(mailLog, "utf8").catch(() => "");
    }
    assert.match(log, /daily digest/, "bob still gets a digest for what he can see");
    assert.ok(!log.includes("Secret Payroll"), "digests leave out notifications about pages that became restricted");
  } finally {
    await harness.close();
    await new Promise<void>((resolve) => receiver.close(() => resolve()));
    for (const key of ["NOMA_CLOUD_ALLOW_PRIVATE_WEBHOOKS", "NOMA_CLOUD_MAIL_TRANSPORT", "NOMA_CLOUD_MAIL_LOG"]) {
      if (previous[key] === undefined) delete process.env[key];
      else process.env[key] = previous[key];
    }
  }
});
