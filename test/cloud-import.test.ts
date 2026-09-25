import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import Database from "better-sqlite3";
import { NomaCloudDatabase } from "../src/cloud-db.js";
import { parseConfluenceEntitiesXml } from "../src/confluence-import.js";
import { convertConfluencePage } from "../src/confluence-storage.js";
import { parse } from "../src/parser.js";
import { validate } from "../src/validator.js";
import { createZip } from "../src/zip.js";
import { type CloudUserResponse, createCloudUser, json, jsonStatus, request, startCloudServer } from "./cloud-wiki-helpers.js";
import { DESIGN, HOME, notionFixture, TASK_A, TASK_B, TASKS } from "./notion-fixture.js";

interface ImportJob {
  id: string;
  status: "queued" | "running" | "succeeded" | "failed";
  source: string;
  spaceKey?: string;
  progress: { total: number; processed: number; created: number; updated: number; unchanged: number; skipped: number; failed: number };
  result?: {
    pages: Array<{ pageId: string; documentId?: string; action: string; reason?: string }>;
    loss: Array<{ macro: string; count: number }>;
    attachments: { referenced: number };
  };
  error?: string;
}

interface SiteResponse {
  id: string;
  documentIds: string[];
  pageParents?: Record<string, string>;
}

interface DocumentResponse {
  id: string;
  title: string;
  source: string;
  hash: string;
}

interface FakePage {
  id: string;
  title: string;
  parentId?: string;
  storage: string;
  labels: string[];
  version: number;
}

class FakeConfluence {
  readonly requests: string[] = [];
  cloudPages: FakePage[] = [
    {
      id: "100",
      title: "Engineering Home",
      storage: `<p>Welcome to <strong>Engineering</strong>.</p><ac:structured-macro ac:name="excerpt"><ac:rich-text-body><p>Engineering space home.</p></ac:rich-text-body></ac:structured-macro><ac:structured-macro ac:name="children" />`,
      labels: ["home"],
      version: 1,
    },
    {
      id: "101",
      title: "Architecture",
      parentId: "100",
      storage: `<h1>Overview</h1><p>See <ac:link><ri:page ri:content-title="Engineering Home" /><ac:plain-text-link-body><![CDATA[home]]></ac:plain-text-link-body></ac:link>.</p><ac:structured-macro ac:name="info"><ac:parameter ac:name="title">Note</ac:parameter><ac:rich-text-body><p>Services talk over gRPC.</p></ac:rich-text-body></ac:structured-macro><table><tbody><tr><th>Service</th><th>Owner</th></tr><tr><td>api</td><td>Ada</td></tr></tbody></table><ac:image ac:alt="diagram"><ri:attachment ri:filename="arch.png" /></ac:image><ac:structured-macro ac:name="roadmap"><ac:parameter ac:name="x">1</ac:parameter></ac:structured-macro>`,
      labels: ["architecture", "Design Docs"],
      version: 4,
    },
    {
      id: "102",
      title: "Decisions",
      parentId: "101",
      storage: `<ac:task-list><ac:task><ac:task-status>complete</ac:task-status><ac:task-body>Pick a database</ac:task-body></ac:task></ac:task-list><p>Status: <ac:structured-macro ac:name="status"><ac:parameter ac:name="title">Approved</ac:parameter></ac:structured-macro></p>`,
      labels: [],
      version: 2,
    },
  ];
  dcPages: FakePage[] = [
    { id: "9001", title: "Ops Home", storage: "<p>Ops landing page.</p>", labels: ["ops"], version: 1 },
    { id: "9002", title: "On-call", parentId: "9001", storage: `<ac:structured-macro ac:name="code"><ac:parameter ac:name="language">bash</ac:parameter><ac:plain-text-body><![CDATA[pager ack --all]]></ac:plain-text-body></ac:structured-macro>`, labels: [], version: 3 },
  ];
  private server: Server | undefined;
  base = "";

  async start(): Promise<void> {
    this.server = createServer((req, res) => this.handle(req, res));
    await new Promise<void>((resolve) => this.server!.listen(0, "127.0.0.1", resolve));
    const address = this.server.address();
    assert.ok(address && typeof address === "object");
    this.base = `http://127.0.0.1:${address.port}`;
  }

  async stop(): Promise<void> {
    this.server?.closeAllConnections();
    await new Promise<void>((resolve) => this.server?.close(() => resolve()));
  }

  private handle(req: IncomingMessage, res: ServerResponse): void {
    const url = new URL(req.url ?? "/", "http://fake");
    this.requests.push(`${req.method} ${url.pathname}${url.search}`);
    const send = (status: number, body: unknown): void => {
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    };
    const authorization = req.headers.authorization ?? "";
    if (url.pathname.startsWith("/wiki/api/v2/")) {
      if (authorization !== `Basic ${Buffer.from("ada@example.com:cloud-token").toString("base64")}`) return send(401, { message: "unauthorized" });
      if (url.pathname === "/wiki/api/v2/spaces") {
        return send(200, { results: url.searchParams.get("keys") === "ENG" ? [{ id: "77", key: "ENG", name: "Engineering" }] : [] });
      }
      if (url.pathname === "/wiki/api/v2/spaces/77/pages") {
        const cursor = url.searchParams.get("cursor");
        const slice = cursor ? this.cloudPages.slice(2) : this.cloudPages.slice(0, 2);
        return send(200, {
          results: slice.map((page, index) => ({
            id: page.id,
            title: page.title,
            parentId: page.parentId ?? "77000",
            parentType: page.parentId ? "page" : "space",
            position: index,
            authorId: "acct-ada",
            createdAt: "2026-01-01T00:00:00.000Z",
            version: { number: page.version, createdAt: "2026-02-01T00:00:00.000Z" },
            body: { storage: { value: page.storage, representation: "storage" } },
            _links: { webui: `/spaces/ENG/pages/${page.id}` },
          })),
          _links: cursor ? {} : { next: "/wiki/api/v2/spaces/77/pages?cursor=next-1&body-format=storage&status=current&limit=100" },
        });
      }
      const labels = /^\/wiki\/api\/v2\/pages\/(\d+)\/labels$/.exec(url.pathname);
      if (labels) {
        const page = this.cloudPages.find((candidate) => candidate.id === labels[1]);
        return send(200, { results: (page?.labels ?? []).map((name) => ({ name, prefix: "global" })) });
      }
      return send(404, {});
    }
    if (url.pathname.startsWith("/confluence/rest/api/")) {
      if (authorization !== "Bearer dc-pat") return send(401, {});
      if (url.pathname === "/confluence/rest/api/space/OPS") return send(200, { key: "OPS", name: "Operations" });
      if (url.pathname === "/confluence/rest/api/content") {
        const start = Number(url.searchParams.get("start") ?? 0);
        const slice = this.dcPages.slice(start, start + 1);
        return send(200, {
          results: slice.map((page) => ({
            id: page.id,
            title: page.title,
            ancestors: page.parentId ? [{ id: page.parentId }] : [],
            metadata: { labels: { results: page.labels.map((name) => ({ name })) } },
            version: { number: page.version, when: "2026-03-01T00:00:00.000Z" },
            history: { createdDate: "2026-01-01T00:00:00.000Z", createdBy: { displayName: "Grace Hopper" } },
            body: { storage: { value: page.storage } },
            _links: { webui: `/display/OPS/${page.id}` },
          })),
          size: slice.length,
          _links: start + 1 < this.dcPages.length ? { next: `/rest/api/content?start=${start + 1}` } : {},
        });
      }
    }
    send(404, {});
  }
}

async function waitForJob(base: string, token: string, id: string): Promise<ImportJob> {
  for (let attempt = 0; attempt < 200; attempt++) {
    const { job } = await json<{ job: ImportJob }>(`${base}/api/import/jobs/${id}`, { token });
    if (job.status === "succeeded" || job.status === "failed") return job;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  assert.fail(`import job ${id} did not finish`);
}

async function startImport(base: string, user: CloudUserResponse, body: Record<string, unknown>): Promise<ImportJob> {
  const started = await json<{ job: ImportJob }>(`${base}/api/import/confluence`, { method: "POST", token: user.token, body });
  assert.equal(started.job.status, "queued");
  return waitForJob(base, user.token, started.job.id);
}

test("live Confluence Cloud import preserves hierarchy, labels, and provenance, and re-imports idempotently", async () => {
  const confluence = new FakeConfluence();
  await confluence.start();
  const cloud = await startCloudServer("noma-cloud-import-", { importAllowPrivateHosts: true });
  try {
    const alice = await createCloudUser(cloud.base, "Alice");
    const viewer = await createCloudUser(cloud.base, "Viewer");
    const site = await json<SiteResponse>(`${cloud.base}/api/sites`, { method: "POST", token: alice.token, body: { title: "Imported", documentIds: [] } });
    await json(`${cloud.base}/api/sites/${site.id}/collaborators`, { method: "POST", token: alice.token, body: { userId: viewer.id, role: "viewer" } });
    const live = { siteId: site.id, baseUrl: `${confluence.base}/wiki`, deployment: "cloud", email: "ada@example.com", apiToken: "cloud-token", spaceKey: "ENG" };

    await jsonStatus(`${cloud.base}/api/import/confluence`, 403, { method: "POST", token: viewer.token, body: live });
    await jsonStatus(`${cloud.base}/api/import/confluence`, 400, { method: "POST", token: alice.token, body: { ...live, apiToken: undefined } });

    const job = await startImport(cloud.base, alice, live);
    assert.equal(job.status, "succeeded", job.error);
    assert.equal(job.spaceKey, "ENG");
    assert.deepEqual({ ...job.progress }, { total: 3, processed: 3, created: 3, updated: 0, unchanged: 0, skipped: 0, failed: 0, attachmentsCopied: 0, attachmentsSkipped: 1 });
    assert.deepEqual(job.result?.loss, [{ macro: "roadmap", count: 1 }]);
    assert.equal(job.result?.attachments.referenced, 1);
    assert.ok(confluence.requests.some((line) => line.includes("cursor=next-1")));
    assert.ok(!JSON.stringify(job).includes("cloud-token"));

    const byPage = new Map(job.result!.pages.map((page) => [page.pageId, page.documentId!]));
    const updatedSite = await json<SiteResponse>(`${cloud.base}/api/sites/${site.id}`, { token: alice.token });
    assert.deepEqual(updatedSite.documentIds, [byPage.get("100"), byPage.get("101"), byPage.get("102")]);
    assert.equal(updatedSite.pageParents?.[byPage.get("101")!], byPage.get("100"));
    assert.equal(updatedSite.pageParents?.[byPage.get("102")!], byPage.get("101"));

    const architecture = await json<DocumentResponse & { diagnostics: Array<{ severity: string; code: string }> }>(`${cloud.base}/api/documents/${byPage.get("101")}`, { token: alice.token });
    assert.equal(architecture.title, "Architecture");
    assert.match(architecture.source, /^---\nsource: confluence\nconfluence:\n  id: '101'\n  space: ENG\n  url: http:\/\/127\.0\.0\.1:\d+\/wiki\/spaces\/ENG\/pages\/101\n  author: acct-ada/);
    assert.match(architecture.source, /^# Architecture \{id="architecture"\}$/m);
    assert.match(architecture.source, /^## Overview \{id="overview"\}$/m);
    assert.match(architecture.source, /See \[\[Engineering Home\|home\]\]\./);
    assert.match(architecture.source, /::callout\{tone="info" title="Note"\}\nServices talk over gRPC\.\n::/);
    assert.match(architecture.source, /\| Service \| Owner \|\n\| --- \| --- \|\n\| api \| Ada \|/);
    assert.match(architecture.source, /::figure\{src="http:\/\/127\.0\.0\.1:\d+\/wiki\/download\/attachments\/101\/arch\.png" alt="diagram"\}/);
    assert.equal(architecture.diagnostics.filter((diagnostic) => diagnostic.severity === "error").length, 0);
    const labels = await json<{ labels: string[] }>(`${cloud.base}/api/documents/${byPage.get("101")}/labels`, { token: alice.token });
    assert.deepEqual(labels.labels, ["architecture", "design-docs"]);
    const home = await json<DocumentResponse>(`${cloud.base}/api/documents/${byPage.get("100")}`, { token: alice.token });
    assert.match(home.source, /::excerpt\{id="excerpt"\}\nEngineering space home\.\n::/);
    const homeHtml = await (await request(`${cloud.base}/api/documents/${home.id}/html`, { token: alice.token })).text();
    assert.match(homeHtml, /<nav class="noma-children"[^>]*><ul><li data-page-id="[^"]+"><a[^>]*>Architecture<\/a><\/li><\/ul><\/nav>/);
    const tree = await json<{ pages: Array<{ summary?: string }> }>(`${cloud.base}/api/sites/${site.id}/tree`, { token: alice.token });
    assert.equal(tree.pages[0]?.summary, "Engineering space home.");

    const again = await startImport(cloud.base, alice, live);
    assert.deepEqual({ created: again.progress.created, updated: again.progress.updated, unchanged: again.progress.unchanged }, { created: 0, updated: 0, unchanged: 3 });
    const stable = await json<SiteResponse>(`${cloud.base}/api/sites/${site.id}`, { token: alice.token });
    assert.equal(stable.documentIds.length, 3);

    confluence.cloudPages[2]!.storage = "<p>Decision recorded: SQLite.</p>";
    confluence.cloudPages[2]!.version = 3;
    const decisions = await json<DocumentResponse>(`${cloud.base}/api/documents/${byPage.get("102")}`, { token: alice.token });
    const changed = await startImport(cloud.base, alice, live);
    assert.equal(changed.progress.updated, 1);
    const updatedDecisions = await json<DocumentResponse>(`${cloud.base}/api/documents/${byPage.get("102")}`, { token: alice.token });
    assert.match(updatedDecisions.source, /Decision recorded: SQLite\./);
    assert.notEqual(updatedDecisions.hash, decisions.hash);
    const revisions = await json<{ revisions: unknown[] }>(`${cloud.base}/api/documents/${byPage.get("102")}/revisions`, { token: alice.token });
    assert.equal(revisions.revisions.length, 2);

    await json(`${cloud.base}/api/documents/${byPage.get("102")}`, {
      method: "PUT",
      token: alice.token,
      body: { source: `${updatedDecisions.source}\nLocal note.\n`, expectedHash: updatedDecisions.hash },
    });
    confluence.cloudPages[2]!.storage = "<p>Decision recorded: Postgres.</p>";
    const conflicted = await startImport(cloud.base, alice, live);
    assert.equal(conflicted.progress.skipped, 1);
    assert.match(conflicted.result!.pages.find((page) => page.pageId === "102")!.reason ?? "", /edited after the last import/);
    const overwritten = await startImport(cloud.base, alice, { ...live, overwrite: true });
    assert.equal(overwritten.progress.updated, 1);
    const final = await json<DocumentResponse>(`${cloud.base}/api/documents/${byPage.get("102")}`, { token: alice.token });
    assert.match(final.source, /Postgres/);
    assert.doesNotMatch(final.source, /Local note/);

    const current = await json<SiteResponse>(`${cloud.base}/api/sites/${site.id}`, { token: alice.token });
    await json(`${cloud.base}/api/sites/${site.id}`, {
      method: "PUT",
      token: alice.token,
      body: { documentIds: current.documentIds.filter((id) => id !== byPage.get("102")) },
    });
    const detached = await startImport(cloud.base, alice, live);
    assert.equal(detached.progress.created, 1);
    const recreated = detached.result!.pages.find((page) => page.pageId === "102")!;
    assert.notEqual(recreated.documentId, byPage.get("102"));
    const unchangedDetached = await json<DocumentResponse>(`${cloud.base}/api/documents/${byPage.get("102")}`, { token: alice.token });
    assert.equal(unchangedDetached.hash, final.hash);

    const stranger = await createCloudUser(cloud.base, "Stranger");
    await jsonStatus(`${cloud.base}/api/import/jobs/${job.id}`, 403, { token: stranger.token });
    await jsonStatus(`${cloud.base}/api/import/jobs/${job.id}`, 403, { token: viewer.token });

    const badCredentials = await startImport(cloud.base, alice, { ...live, apiToken: "wrong" });
    assert.equal(badCredentials.status, "failed");
    assert.match(badCredentials.error ?? "", /rejected the credentials \(HTTP 401\)/);
  } finally {
    await cloud.close();
    await confluence.stop();
  }
});

test("Data Center import uses a PAT and paginates by start offset", async () => {
  const confluence = new FakeConfluence();
  await confluence.start();
  const cloud = await startCloudServer("noma-cloud-import-dc-", { importAllowPrivateHosts: true });
  try {
    const alice = await createCloudUser(cloud.base, "Alice");
    const site = await json<SiteResponse>(`${cloud.base}/api/sites`, { method: "POST", token: alice.token, body: { title: "Ops", documentIds: [] } });
    const job = await startImport(cloud.base, alice, {
      siteId: site.id,
      baseUrl: `${confluence.base}/confluence`,
      deployment: "datacenter",
      pat: "dc-pat",
      spaceKey: "OPS",
    });
    assert.equal(job.status, "succeeded", job.error);
    assert.equal(job.source, "confluence-datacenter");
    assert.equal(job.progress.created, 2);
    const onCall = job.result!.pages.find((page) => page.pageId === "9002")!;
    const document = await json<DocumentResponse>(`${cloud.base}/api/documents/${onCall.documentId}`, { token: alice.token });
    assert.match(document.source, /author: Grace Hopper/);
    assert.match(document.source, /```bash\npager ack --all\n```/);
    const updatedSite = await json<SiteResponse>(`${cloud.base}/api/sites/${site.id}`, { token: alice.token });
    assert.equal(updatedSite.pageParents?.[onCall.documentId!], job.result!.pages.find((page) => page.pageId === "9001")!.documentId);
    assert.ok(confluence.requests.some((line) => line.includes("start=1")));
  } finally {
    await cloud.close();
    await confluence.stop();
  }
});

test("XML space export uploads and JSON bundles import without network access", async () => {
  const cloud = await startCloudServer("noma-cloud-import-export-", { importMaxBytes: 2_000_000 });
  try {
    const alice = await createCloudUser(cloud.base, "Alice");
    const site = await json<SiteResponse>(`${cloud.base}/api/sites`, { method: "POST", token: alice.token, body: { title: "Ops export", documentIds: [] } });
    const entities = await readFile(join(import.meta.dirname, "fixtures", "confluence", "entities.xml"));
    const archive = createZip([
      { path: "exportDescriptor.properties", data: "spaceKey=OPS\n" },
      { path: "entities.xml", data: entities },
    ]);
    const response = await request(`${cloud.base}/api/import/confluence?site=${site.id}`, {
      method: "POST",
      token: alice.token,
      headers: { "content-type": "application/zip" },
      body: new Uint8Array(archive),
    });
    assert.equal(response.status, 202, await response.clone().text());
    const { job: started } = (await response.json()) as { job: ImportJob };
    const job = await waitForJob(cloud.base, alice.token, started.id);
    assert.equal(job.status, "succeeded", job.error);
    assert.equal(job.spaceKey, "OPS");
    assert.equal(job.progress.created, 2);
    const restart = job.result!.pages.find((page) => page.pageId === "1002")!;
    const document = await json<DocumentResponse>(`${cloud.base}/api/documents/${restart.documentId}`, { token: alice.token });
    assert.match(document.source, /1\. Drain traffic\n2\. Run `systemctl restart api`/);
    assert.match(document.source, /:::?warning\nNever restart both regions at once\.\n::/);
    assert.match(document.source, /&xxe; See \[\[Runbooks\]\]\./);
    assert.doesNotMatch(document.source, /OLD VERSION TEXT|root:/);
    assert.deepEqual((await json<{ labels: string[] }>(`${cloud.base}/api/documents/${restart.documentId}/labels`, { token: alice.token })).labels, ["runbook"]);
    const runbooks = await json<DocumentResponse>(`${cloud.base}/api/documents/${job.result!.pages.find((page) => page.pageId === "1001")!.documentId}`, { token: alice.token });
    assert.match(runbooks.source, /author: jdoe/);
    assert.match(runbooks.source, /A literal tag inside CDATA must not end the object\./);
    assert.match(runbooks.source, /::children\{sort="title"\}/);

    const htmlExport = createZip([{ path: "OPS/index.html", data: "<html></html>" }]);
    const failed = await request(`${cloud.base}/api/import/confluence?site=${site.id}`, {
      method: "POST",
      token: alice.token,
      headers: { "content-type": "application/zip" },
      body: new Uint8Array(htmlExport),
    });
    const failedJob = await waitForJob(cloud.base, alice.token, ((await failed.json()) as { job: ImportJob }).job.id);
    assert.equal(failedJob.status, "failed");
    assert.match(failedJob.error ?? "", /HTML export/);

    const bundleSite = await json<SiteResponse>(`${cloud.base}/api/sites`, { method: "POST", token: alice.token, body: { title: "Bundle", documentIds: [] } });
    const bundleJob = await startImport(cloud.base, alice, {
      siteId: bundleSite.id,
      bundle: {
        format: "noma-confluence-bundle",
        spaceKey: "DOC",
        pages: [
          { id: "1", title: "Root", storage: "<p>Root page</p>", labels: ["guide"] },
          { id: "2", title: "Leaf", parentId: "1", storage: "<p>Leaf page</p>" },
        ],
      },
    });
    assert.equal(bundleJob.progress.created, 2);
    await jsonStatus(`${cloud.base}/api/import/confluence`, 400, { method: "POST", token: alice.token, body: { siteId: bundleSite.id, bundle: { spaceKey: "DOC", pages: [{ id: "1" }] } } });
    await jsonStatus(`${cloud.base}/api/import/confluence`, 415, { method: "POST", token: alice.token, headers: { "content-type": "text/plain" }, body: new Uint8Array([1]) });
    const tooLarge = await request(`${cloud.base}/api/import/confluence?site=${site.id}`, {
      method: "POST",
      token: alice.token,
      headers: { "content-type": "application/zip" },
      body: new Uint8Array(2_100_000),
    });
    assert.equal(tooLarge.status, 413);
  } finally {
    await cloud.close();
  }
});

test("live imports refuse private targets unless explicitly allowed", async () => {
  const cloud = await startCloudServer("noma-cloud-import-ssrf-");
  try {
    const alice = await createCloudUser(cloud.base, "Alice");
    const site = await json<SiteResponse>(`${cloud.base}/api/sites`, { method: "POST", token: alice.token, body: { title: "Guarded", documentIds: [] } });
    const base = { siteId: site.id, deployment: "cloud", email: "a@example.com", apiToken: "t", spaceKey: "ENG" };
    for (const baseUrl of ["http://example.com", "https://127.0.0.1", "https://localhost", "https://169.254.169.254", "https://[::1]", "https://user:pass@example.com", "file:///etc/passwd"]) {
      const rejected = await jsonStatus<{ error: string }>(`${cloud.base}/api/import/confluence`, 400, { method: "POST", token: alice.token, body: { ...base, baseUrl } });
      assert.match(rejected.error, /https|private|credentials|absolute/, baseUrl);
    }
  } finally {
    await cloud.close();
  }
});

test("storage conversion is structure-safe and the entities parser keeps only current pages", async () => {
  const conversion = convertConfluencePage("<p>::html</p><p># fake heading</p><h2>Title {id=\"evil\"}</h2><p>[[not a link]]</p>", { title: "Safe {x}" });
  const doc = parse(conversion.source);
  assert.equal(validate(doc).filter((diagnostic) => diagnostic.severity === "error").length, 0);
  const kinds = doc.children.flatMap((node) => (node.type === "section" ? [node, ...node.children] : [node])).map((node) => node.type);
  assert.ok(!kinds.includes("directive"), conversion.source);
  assert.match(conversion.source, /^### Title \(id="evil"\) \{id="title-idevil"\}$/m);
  const space = parseConfluenceEntitiesXml(await readFile(join(import.meta.dirname, "fixtures", "confluence", "entities.xml"), "utf8"));
  assert.deepEqual(space.pages.map((page) => page.id).sort(), ["1001", "1002"]);
  assert.equal(space.pages.find((page) => page.id === "1002")?.parentId, "1001");
  assert.equal(space.spaceName, "Operations");
});

test("Notion export ZIP imports pages, databases, and attachments, and re-imports by Notion ID", async () => {
  const cloud = await startCloudServer("noma-cloud-import-notion-", { importMaxBytes: 2_000_000 });
  try {
    const alice = await createCloudUser(cloud.base, "Alice");
    const viewer = await createCloudUser(cloud.base, "Viewer");
    const site = await json<SiteResponse>(`${cloud.base}/api/sites`, { method: "POST", token: alice.token, body: { title: "From Notion", documentIds: [] } });
    await json(`${cloud.base}/api/sites/${site.id}/collaborators`, { method: "POST", token: alice.token, body: { userId: viewer.id, role: "viewer" } });
    const archive = new Uint8Array(notionFixture());
    const upload = (token: string, query = ""): Promise<Response> =>
      request(`${cloud.base}/api/import/notion?site=${site.id}${query}`, { method: "POST", token, headers: { "content-type": "application/zip" }, body: archive });

    assert.equal((await upload(viewer.token)).status, 403);
    await jsonStatus(`${cloud.base}/api/import/notion`, 400, { method: "POST", token: alice.token, body: { siteId: site.id } });
    await jsonStatus(`${cloud.base}/api/import/notion`, 415, { method: "POST", token: alice.token, headers: { "content-type": "text/plain" }, body: new Uint8Array(Buffer.from("x")) });

    const response = await upload(alice.token);
    assert.equal(response.status, 202, await response.clone().text());
    const job = await waitForJob(cloud.base, alice.token, ((await response.json()) as { job: ImportJob }).job.id);
    assert.equal(job.status, "succeeded", job.error);
    assert.equal(job.source, "notion-export");
    assert.deepEqual({ ...job.progress }, { total: 5, processed: 5, created: 5, updated: 0, unchanged: 0, skipped: 0, failed: 0 });
    assert.deepEqual(job.result?.loss.find((entry) => entry.macro === "html"), { macro: "html", count: 3 });
    const attachments = job.result?.attachments as unknown as { referenced: number; stored: number; skipped: unknown[] };
    assert.deepEqual({ referenced: attachments.referenced, stored: attachments.stored, skipped: attachments.skipped }, { referenced: 3, stored: 3, skipped: [] });

    const byPage = new Map(job.result!.pages.map((page) => [page.pageId, page.documentId!]));
    const tree = await json<SiteResponse>(`${cloud.base}/api/sites/${site.id}`, { token: alice.token });
    assert.deepEqual(tree.documentIds, [byPage.get(HOME), byPage.get(DESIGN), byPage.get(TASKS), byPage.get(TASK_A), byPage.get(TASK_B)]);
    assert.equal(tree.pageParents?.[byPage.get(DESIGN)!], byPage.get(HOME));
    assert.equal(tree.pageParents?.[byPage.get(TASK_A)!], byPage.get(TASKS));

    const design = await json<DocumentResponse>(`${cloud.base}/api/documents/${byPage.get(DESIGN)}`, { token: alice.token });
    assert.match(design.source, /::figure\{src="att:arch-v2-\.png" alt="Diagram"\}/);
    const files = await json<{ attachments: Array<{ id: string; filename: string; contentType: string }> }>(`${cloud.base}/api/documents/${design.id}/attachments`, { token: alice.token });
    assert.deepEqual(files.attachments.map((file) => [file.filename, file.contentType]).sort(), [["arch-v2-.png", "image/png"], ["spec.pdf", "application/pdf"]]);
    const arch = files.attachments.find((file) => file.filename === "arch-v2-.png")!;
    const html = await (await request(`${cloud.base}/api/documents/${design.id}/html`, { token: alice.token })).text();
    assert.match(html, new RegExp(`/api/attachments/${arch.id}\\?exp=`));
    const labels = await json<{ labels: string[] }>(`${cloud.base}/api/documents/${byPage.get(TASK_A)}/labels`, { token: alice.token });
    assert.deepEqual(labels.labels, ["import", "notion"]);
    const tasks = await json<DocumentResponse>(`${cloud.base}/api/documents/${byPage.get(TASKS)}`, { token: alice.token });
    assert.match(tasks.source, /::dataset\{id="tasks-data" format="csv"\}/);

    const again = await waitForJob(cloud.base, alice.token, ((await (await upload(alice.token)).json()) as { job: ImportJob }).job.id);
    assert.deepEqual({ created: again.progress.created, unchanged: again.progress.unchanged }, { created: 0, unchanged: 5 });
    const againAttachments = again.result?.attachments as unknown as { stored: number; unchanged: number };
    assert.deepEqual({ stored: againAttachments.stored, unchanged: againAttachments.unchanged }, { stored: 0, unchanged: 3 });
    const stable = await json<SiteResponse>(`${cloud.base}/api/sites/${site.id}`, { token: alice.token });
    assert.equal(stable.documentIds.length, 5);

    await json(`${cloud.base}/api/documents/${design.id}`, { method: "PUT", token: alice.token, body: { source: `${design.source}\nLocal note.\n`, expectedHash: design.hash } });
    const bundleJob = await startNotionJson(cloud.base, alice, {
      siteId: site.id,
      bundle: { pages: [{ id: DESIGN, title: "Design Doc", markdown: "Rewritten from the API." }] },
    });
    assert.equal(bundleJob.source, "notion-bundle");
    assert.equal(bundleJob.progress.skipped, 1);
    assert.match(bundleJob.result!.pages[0]!.reason ?? "", /edited after the last import/);
    const overwritten = await startNotionJson(cloud.base, alice, {
      siteId: site.id,
      overwrite: true,
      bundle: { pages: [{ id: DESIGN, title: "Design Doc", markdown: "Rewritten from the API." }] },
    });
    assert.equal(overwritten.progress.updated, 1);
    const rewritten = await json<DocumentResponse>(`${cloud.base}/api/documents/${design.id}`, { token: alice.token });
    assert.match(rewritten.source, /Rewritten from the API\./);

    const base64 = await startNotionJson(cloud.base, alice, { siteId: site.id, archiveBase64: Buffer.from("PK\u0003\u0004 broken").toString("base64") });
    assert.equal(base64.status, "failed");
    assert.match(base64.error ?? "", /Could not read the export ZIP/);
    await jsonStatus(`${cloud.base}/api/import/notion`, 400, { method: "POST", token: alice.token, body: { siteId: site.id, bundle: { pages: [{ id: "x" }] } } });
  } finally {
    await cloud.close();
  }
});

test("Notion imports respect the upload limit and the attachment size limit", async () => {
  const cloud = await startCloudServer("noma-cloud-import-notion-limits-", { importMaxBytes: 1_000, maxAttachmentBytes: 20 });
  try {
    const alice = await createCloudUser(cloud.base, "Alice");
    const site = await json<SiteResponse>(`${cloud.base}/api/sites`, { method: "POST", token: alice.token, body: { title: "Limits", documentIds: [] } });
    const tooLarge = await request(`${cloud.base}/api/import/notion?site=${site.id}`, {
      method: "POST",
      token: alice.token,
      headers: { "content-type": "application/zip" },
      body: new Uint8Array(notionFixture()),
    });
    assert.equal(tooLarge.status, 413);
    const small = createZip([
      { path: `Page ${HOME}.md`, data: `# Page\n\n![big](big.png)\n` },
      { path: "big.png", data: Buffer.alloc(64, 1) },
    ]);
    const job = await startNotionJson(cloud.base, alice, { siteId: site.id, archiveBase64: small.toString("base64") });
    assert.equal(job.status, "succeeded", job.error);
    assert.deepEqual(job.result?.loss, [{ macro: "attachment-too-large", count: 1 }]);
  } finally {
    await cloud.close();
  }
});

test("databases created before Notion import accept the new import job kinds", async () => {
  const root = await mkdtemp(join(tmpdir(), "noma-import-migrate-"));
  try {
    const dbPath = join(root, "noma-cloud.sqlite");
    const legacy = new Database(dbPath);
    legacy.exec(`CREATE TABLE import_jobs (
      id TEXT PRIMARY KEY, site_id TEXT NOT NULL, created_by TEXT NOT NULL,
      source TEXT NOT NULL CHECK (source IN ('confluence-cloud', 'confluence-datacenter', 'confluence-export', 'confluence-bundle')),
      status TEXT NOT NULL CHECK (status IN ('queued', 'running', 'succeeded', 'failed')),
      space_key TEXT, progress_json TEXT NOT NULL DEFAULT '{}', result_json TEXT, error TEXT,
      created_at TEXT NOT NULL, updated_at TEXT NOT NULL, finished_at TEXT)`);
    legacy.prepare("INSERT INTO import_jobs VALUES ('old-job', 'site-1', 'user-1', 'confluence-export', 'succeeded', 'OPS', '{}', NULL, NULL, 't', 't', 't')").run();
    legacy.close();
    const store = new NomaCloudDatabase({ dbPath, dataDir: join(root, "documents"), usersDir: join(root, "users"), sitesDir: join(root, "sites") });
    try {
      assert.equal(store.readImportJob("old-job")?.source, "confluence-export");
      const progress = { total: 0, processed: 0, created: 0, updated: 0, unchanged: 0, skipped: 0, failed: 0 };
      store.createImportJob({ id: "new-job", siteId: "site-1", createdBy: "user-1", source: "notion-export", status: "queued", progress, createdAt: "t", updatedAt: "t" });
      assert.equal(store.readImportJob("new-job")?.source, "notion-export");
    } finally {
      store.close();
    }
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function startNotionJson(base: string, user: CloudUserResponse, body: Record<string, unknown>): Promise<ImportJob> {
  const started = await json<{ job: ImportJob }>(`${base}/api/import/notion`, { method: "POST", token: user.token, body });
  return waitForJob(base, user.token, started.job.id);
}
