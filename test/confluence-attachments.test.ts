import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import test from "node:test";
import { guardedHttp } from "../src/confluence-import.js";
import { createZip } from "../src/zip.js";
import { type CloudUserResponse, createCloudUser, json, request, startCloudServer } from "./cloud-wiki-helpers.js";

interface ImportJob {
  id: string;
  status: "queued" | "running" | "succeeded" | "failed";
  progress: { created: number; updated: number; unchanged: number; skipped: number; failed: number; attachmentsCopied?: number; attachmentsSkipped?: number };
  result?: {
    pages: Array<{ pageId: string; documentId?: string; action: string; reason?: string }>;
    attachments: {
      referenced: number;
      copied: number;
      reused: number;
      skipped: number;
      bytesCopied: number;
      skippedDetails?: Array<{ pageId: string; filename: string; reason: string }>;
      note?: string;
    };
  };
  error?: string;
}

interface AttachmentListing {
  attachments: Array<{ id: string; filename: string; contentType: string; size: number; sha256: string; url?: string }>;
}

const PNG = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from("diagram-pixels")]);
const PDF = Buffer.from("%PDF-1.4\n% spec\n");
const BIG_PNG = Buffer.concat([PNG, Buffer.alloc(5_000, 1)]);
const EXE = Buffer.concat([Buffer.from("MZ"), Buffer.alloc(64, 0)]);

const PAGE_STORAGE =
  `<p>Architecture overview.</p>` +
  `<ac:image ac:alt="system diagram"><ri:attachment ri:filename="diagram.png" /></ac:image>` +
  `<p>Read the <ac:link><ri:attachment ri:filename="spec.pdf" /><ac:plain-text-link-body><![CDATA[full spec]]></ac:plain-text-link-body></ac:link>.</p>` +
  `<ac:image><ri:attachment ri:filename="big.png" /></ac:image>`;

class FakeConfluence {
  readonly requests: string[] = [];
  readonly files = new Map<string, Buffer>([
    ["diagram.png", PNG],
    ["spec.pdf", PDF],
    ["big.png", BIG_PNG],
  ]);
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
    if (req.headers.authorization !== `Basic ${Buffer.from("ada@example.com:cloud-token").toString("base64")}`) return send(401, {});
    if (url.pathname === "/wiki/api/v2/spaces") return send(200, { results: [{ id: "77", key: "ENG", name: "Engineering" }] });
    if (url.pathname === "/wiki/api/v2/spaces/77/pages") {
      return send(200, {
        results: [{ id: "300", title: "Architecture", parentType: "space", version: { number: 1 }, body: { storage: { value: PAGE_STORAGE } }, _links: { webui: "/spaces/ENG/pages/300" } }],
        _links: {},
      });
    }
    if (url.pathname === "/wiki/api/v2/pages/300/labels") return send(200, { results: [] });
    if (url.pathname === "/wiki/rest/api/content/300/child/attachment") {
      const names = [...this.files.keys()];
      const start = Number(url.searchParams.get("start") ?? 0);
      const slice = names.slice(start, start + 2);
      return send(200, {
        results: slice.map((name, index) => ({
          id: `att${start + index + 1}`,
          title: name,
          extensions: { mediaType: name.endsWith(".pdf") ? "application/pdf" : "image/png", fileSize: this.files.get(name)!.length },
          version: { number: 1 },
          _links: { download: `/download/attachments/300/${encodeURIComponent(name)}?version=1&api=v2` },
        })),
        size: slice.length,
        _links: start + 2 < names.length ? { next: `/rest/api/content/300/child/attachment?start=${start + 2}` } : {},
      });
    }
    const download = /^\/wiki\/download\/attachments\/300\/(.+)$/.exec(url.pathname);
    if (download) {
      const data = this.files.get(decodeURIComponent(download[1]!));
      if (!data) return send(404, {});
      res.writeHead(200, { "content-type": "application/octet-stream" });
      res.end(data);
      return;
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
  return waitForJob(base, user.token, started.job.id);
}

async function uploadExport(base: string, user: CloudUserResponse, siteId: string, data: Buffer, contentType = "application/zip"): Promise<ImportJob> {
  const response = await request(`${base}/api/import/confluence?site=${siteId}`, { method: "POST", token: user.token, headers: { "content-type": contentType }, body: new Uint8Array(data) });
  assert.equal(response.status, 202, await response.clone().text());
  return waitForJob(base, user.token, ((await response.json()) as { job: ImportJob }).job.id);
}

async function downloadBytes(base: string, token: string, attachmentId: string): Promise<Buffer> {
  const response = await request(`${base}/api/attachments/${attachmentId}`, { token });
  assert.equal(response.status, 200);
  return Buffer.from(await response.arrayBuffer());
}

test("live import copies page attachments, rewrites refs to att:, skips oversize files, and re-imports without duplicates", async () => {
  const confluence = new FakeConfluence();
  await confluence.start();
  const cloud = await startCloudServer("noma-cloud-import-att-", { importAllowPrivateHosts: true, maxAttachmentBytes: 2_000 });
  try {
    const alice = await createCloudUser(cloud.base, "Alice");
    const site = await json<{ id: string }>(`${cloud.base}/api/sites`, { method: "POST", token: alice.token, body: { title: "Eng", documentIds: [] } });
    const live = { siteId: site.id, baseUrl: `${confluence.base}/wiki`, deployment: "cloud", email: "ada@example.com", apiToken: "cloud-token", spaceKey: "ENG" };

    const job = await startImport(cloud.base, alice, live);
    assert.equal(job.status, "succeeded", job.error);
    assert.equal(job.progress.attachmentsCopied, 2);
    assert.equal(job.progress.attachmentsSkipped, 1);
    assert.equal(job.result!.attachments.copied, 2);
    assert.equal(job.result!.attachments.bytesCopied, PNG.length + PDF.length);
    assert.deepEqual(job.result!.attachments.skippedDetails?.map((skip) => [skip.pageId, skip.filename]), [["300", "big.png"]]);
    assert.match(job.result!.attachments.skippedDetails![0]!.reason, /2000-byte attachment limit/);
    assert.ok(confluence.requests.some((line) => line.includes("/child/attachment?") && line.includes("start=2")), "attachment listing paginates");
    assert.ok(!confluence.requests.some((line) => line.startsWith("GET /wiki/download/attachments/300/big.png")), "declared oversize files are not downloaded");

    const documentId = job.result!.pages[0]!.documentId!;
    const listing = await json<AttachmentListing>(`${cloud.base}/api/documents/${documentId}/attachments`, { token: alice.token });
    const byName = new Map(listing.attachments.map((attachment) => [attachment.filename, attachment]));
    assert.deepEqual([...byName.keys()].sort(), ["diagram.png", "spec.pdf"]);
    assert.equal(byName.get("diagram.png")!.contentType, "image/png");
    assert.equal(byName.get("spec.pdf")!.contentType, "application/pdf");
    assert.deepEqual(await downloadBytes(cloud.base, alice.token, byName.get("diagram.png")!.id), PNG);

    const document = await json<{ source: string; hash: string }>(`${cloud.base}/api/documents/${documentId}`, { token: alice.token });
    assert.match(document.source, new RegExp(`::figure\\{src="att:${byName.get("diagram.png")!.id}" alt="system diagram"\\}`));
    assert.match(document.source, new RegExp(`Read the \\[full spec\\]\\(att:${byName.get("spec.pdf")!.id}\\)\\.`));
    assert.match(document.source, /::figure\{src="http:\/\/127\.0\.0\.1:\d+\/wiki\/download\/attachments\/300\/big\.png"/);
    const html = await (await request(`${cloud.base}/api/documents/${documentId}/html`, { token: alice.token })).text();
    assert.match(html, new RegExp(`/api/attachments/${byName.get("diagram.png")!.id}\\?exp=`));

    const again = await startImport(cloud.base, alice, live);
    assert.equal(again.status, "succeeded", again.error);
    assert.equal(again.progress.unchanged, 1);
    assert.equal(again.progress.attachmentsCopied, 0);
    assert.equal(again.result!.attachments.reused, 2);
    const relisted = await json<AttachmentListing>(`${cloud.base}/api/documents/${documentId}/attachments`, { token: alice.token });
    assert.equal(relisted.attachments.length, 2);
    assert.equal((await json<{ hash: string }>(`${cloud.base}/api/documents/${documentId}`, { token: alice.token })).hash, document.hash);

    confluence.files.set("diagram.png", Buffer.concat([PNG, Buffer.from("v2")]));
    const changed = await startImport(cloud.base, alice, live);
    assert.equal(changed.progress.updated, 1);
    assert.equal(changed.progress.attachmentsCopied, 1);
    const updated = await json<{ source: string }>(`${cloud.base}/api/documents/${documentId}`, { token: alice.token });
    const newDiagram = (await json<AttachmentListing>(`${cloud.base}/api/documents/${documentId}/attachments`, { token: alice.token })).attachments.find(
      (attachment) => attachment.filename === "diagram.png" && attachment.id !== byName.get("diagram.png")!.id,
    );
    assert.ok(newDiagram);
    assert.match(updated.source, new RegExp(`src="att:${newDiagram.id}"`));
  } finally {
    await cloud.close();
    await confluence.stop();
  }
});

function exportEntities(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<hibernate-generic datetime="2026-05-01 10:00:00">
<object class="Space" package="com.atlassian.confluence.spaces"><id name="id">1</id><property name="key"><![CDATA[OPS]]></property></object>
<object class="Page" package="com.atlassian.confluence.pages">
<id name="id">1001</id>
<property name="title"><![CDATA[Runbook]]></property>
<property name="version">2</property>
<property name="contentStatus"><![CDATA[current]]></property>
</object>
<object class="BodyContent" package="com.atlassian.confluence.core">
<id name="id">5001</id>
<property name="body"><![CDATA[<p>Topology:</p><ac:image><ri:attachment ri:filename="topology.png" /></ac:image><ac:image><ri:attachment ri:filename="missing.png" /></ac:image>]]></property>
<property name="content" class="Page" package="com.atlassian.confluence.pages"><id name="id">1001</id></property>
</object>
<object class="Attachment" package="com.atlassian.confluence.pages">
<id name="id">7001</id>
<property name="title"><![CDATA[topology.png]]></property>
<property name="version">2</property>
<property name="containerContent" class="Page" package="com.atlassian.confluence.pages"><id name="id">1001</id></property>
<property name="contentStatus"><![CDATA[current]]></property>
</object>
<object class="Attachment" package="com.atlassian.confluence.pages">
<id name="id">7000</id>
<property name="title"><![CDATA[topology.png]]></property>
<property name="version">1</property>
<property name="originalVersion" class="Attachment" package="com.atlassian.confluence.pages"><id name="id">7001</id></property>
<property name="containerContent" class="Page" package="com.atlassian.confluence.pages"><id name="id">1001</id></property>
</object>
</hibernate-generic>`;
}

test("XML export ZIP attachments are copied from attachments/<pageId>/<attachmentId>/<version>; bundles accept base64 files", async () => {
  const cloud = await startCloudServer("noma-cloud-import-att-export-", { importMaxBytes: 2_000_000 });
  try {
    const alice = await createCloudUser(cloud.base, "Alice");
    const site = await json<{ id: string }>(`${cloud.base}/api/sites`, { method: "POST", token: alice.token, body: { title: "Ops", documentIds: [] } });
    const current = Buffer.concat([PNG, Buffer.from("current")]);
    const archive = createZip([
      { path: "entities.xml", data: exportEntities() },
      { path: "attachments/1001/7001/1", data: Buffer.concat([PNG, Buffer.from("old")]) },
      { path: "attachments/1001/7001/2", data: current },
    ]);
    const job = await uploadExport(cloud.base, alice, site.id, archive);
    assert.equal(job.status, "succeeded", job.error);
    assert.equal(job.progress.attachmentsCopied, 1);
    assert.deepEqual(job.result!.attachments.skippedDetails?.map((skip) => skip.filename), ["missing.png"]);
    const documentId = job.result!.pages[0]!.documentId!;
    const listing = await json<AttachmentListing>(`${cloud.base}/api/documents/${documentId}/attachments`, { token: alice.token });
    assert.equal(listing.attachments.length, 1);
    assert.deepEqual(await downloadBytes(cloud.base, alice.token, listing.attachments[0]!.id), current);
    const document = await json<{ source: string }>(`${cloud.base}/api/documents/${documentId}`, { token: alice.token });
    assert.match(document.source, new RegExp(`::figure\\{src="att:${listing.attachments[0]!.id}" alt="topology.png"\\}`));
    assert.match(document.source, /::figure\{src="attachments\/1001\/missing\.png"/);

    const again = await uploadExport(cloud.base, alice, site.id, archive);
    assert.equal(again.progress.unchanged, 1);
    assert.equal(again.progress.attachmentsCopied, 0);
    assert.equal((await json<AttachmentListing>(`${cloud.base}/api/documents/${documentId}/attachments`, { token: alice.token })).attachments.length, 1);

    const bareSite = await json<{ id: string }>(`${cloud.base}/api/sites`, { method: "POST", token: alice.token, body: { title: "Bare", documentIds: [] } });
    const bare = await uploadExport(cloud.base, alice, bareSite.id, Buffer.from(exportEntities()), "application/xml");
    assert.equal(bare.status, "succeeded", bare.error);
    assert.equal(bare.progress.attachmentsCopied, 0);
    assert.match(bare.result!.attachments.note ?? "", /entities\.xml alone/);
    assert.match(bare.result!.attachments.skippedDetails?.[0]?.reason ?? "", /entities\.xml alone/);

    const bundleSite = await json<{ id: string }>(`${cloud.base}/api/sites`, { method: "POST", token: alice.token, body: { title: "Bundle", documentIds: [] } });
    const bundle = await startImport(cloud.base, alice, {
      siteId: bundleSite.id,
      bundle: {
        spaceKey: "DOC",
        pages: [
          {
            id: "1",
            title: "Root",
            storage: `<ac:image><ri:attachment ri:filename="logo.png" /></ac:image><p><ac:link><ri:attachment ri:filename="setup.exe" /></ac:link></p>`,
            attachments: [
              { filename: "logo.png", dataBase64: PNG.toString("base64") },
              { filename: "setup.exe", dataBase64: EXE.toString("base64") },
            ],
          },
        ],
      },
    });
    assert.equal(bundle.status, "succeeded", bundle.error);
    assert.equal(bundle.progress.attachmentsCopied, 1);
    assert.equal(bundle.progress.attachmentsSkipped, 1);
    assert.match(bundle.result!.attachments.skippedDetails?.[0]?.reason ?? "", /Executable/);
    const root = await json<{ source: string }>(`${cloud.base}/api/documents/${bundle.result!.pages[0]!.documentId}`, { token: alice.token });
    assert.match(root.source, /::figure\{src="att:[A-Za-z0-9_-]+" alt="logo\.png"\}/);
    assert.doesNotMatch(root.source, /\(att:[^)]*\)/);
  } finally {
    await cloud.close();
  }
});

test("guarded import HTTP resolves once, rejects private answers, and pins the socket to the checked address", async () => {
  const hits: string[] = [];
  const server = createServer((req, res) => {
    hits.push(`${req.headers.host} ${req.url}`);
    res.writeHead(200, { "content-type": "application/json" });
    res.end('{"ok":true}');
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  try {
    const rebinding = guardedHttp("https://confluence.example.com", false, 5_000, { resolveHost: async () => ["10.0.0.7"] });
    await assert.rejects(rebinding.fetch("https://confluence.example.com/wiki/rest/api/space"), /private or disallowed host/);
    const mixed = guardedHttp("https://confluence.example.com", false, 5_000, { resolveHost: async () => ["93.184.216.34", "127.0.0.1"] });
    await assert.rejects(mixed.fetch("https://confluence.example.com/wiki/download/attachments/1/a.png"), /private or disallowed host/);
    const mapped = guardedHttp("https://confluence.example.com", false, 5_000, { resolveHost: async () => ["::ffff:169.254.169.254"] });
    await assert.rejects(mapped.fetch("https://confluence.example.com/"), /private or disallowed host/);
    assert.equal(hits.length, 0);

    let resolutions = 0;
    const origin = `http://confluence.invalid:${address.port}`;
    const pinned = guardedHttp(origin, true, 5_000, {
      resolveHost: async (hostname) => {
        resolutions += 1;
        assert.equal(hostname, "confluence.invalid");
        return ["127.0.0.1"];
      },
    });
    const response = await pinned.fetch(`${origin}/rest/api/space?x=1`);
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { ok: true });
    assert.equal(resolutions, 1);
    assert.deepEqual(hits, [`confluence.invalid:${address.port} /rest/api/space?x=1`]);
    await assert.rejects(pinned.fetch(`http://elsewhere.invalid:${address.port}/`), /left the configured site/);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
