import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { LocalDiskBlobStore } from "../src/cloud-blobs.js";
import { sanitizeAttachmentFilename, sniffAttachmentType } from "../src/cloud/attachments.js";
import { createNomaCloudServer, type NomaCloudServerOptions } from "../src/cloud-server.js";
import { inlineToHtml, safeHref } from "../src/inline.js";
import { parse } from "../src/parser.js";
import { renderHtml } from "../src/renderer-html.js";

interface CloudUserResponse {
  id: string;
  name: string;
  token: string;
}

interface CloudDocumentResponse {
  id: string;
  title: string;
  source: string;
  hash: string;
}

interface AttachmentResponse {
  id: string;
  documentId: string;
  filename: string;
  contentType: string;
  size: number;
  sha256: string;
  image: boolean;
  reference: string;
  url?: string;
}

interface JsonRequestOptions {
  method?: string;
  token?: string;
  share?: string;
  headers?: Record<string, string>;
  body?: Record<string, unknown>;
  expectedStatus?: number;
}

interface Harness {
  base: string;
  root: string;
  clock: { now: Date };
  close: () => Promise<void>;
}

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");
const PDF = Buffer.from("%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\ntrailer << /Root 1 0 R >>\n%%EOF\n", "latin1");

test("attachments upload, sniff, dedupe, serve safely, and enforce page permissions", async () => {
  const harness = await startCloudServer("noma-attachments-");
  try {
    const alice = await createCloudUser(harness.base, "Alice");
    const bob = await createCloudUser(harness.base, "Bob");
    const mallory = await createCloudUser(harness.base, "Mallory");
    const page = await createDocument(harness.base, alice.token, "Design Notes");
    await json(`${harness.base}/api/documents/${page.id}/collaborators`, { method: "POST", token: alice.token, body: { userId: bob.id, role: "viewer" } });

    const uploaded = await upload(harness.base, page.id, alice.token, PNG, "image/png", "../../etc/Chart <final>.png");
    assert.equal(uploaded.status, 201);
    const chart = uploaded.body;
    assert.equal(chart.filename, "Chart _final_.png");
    assert.equal(chart.contentType, "image/png");
    assert.equal(chart.size, PNG.byteLength);
    assert.equal(chart.sha256, sha256(PNG));
    assert.equal(chart.image, true);
    assert.equal(chart.reference, `att:${chart.id}`);
    assert.match(chart.url ?? "", new RegExp(`^/api/attachments/${chart.id}\\?exp=\\d+&p=u\\.${alice.id}&sig=`));

    const blobPath = join(harness.root, "data", "blobs", chart.sha256.slice(0, 2), chart.sha256.slice(2, 4), chart.sha256);
    assert.equal((await stat(blobPath)).size, PNG.byteLength);
    const duplicate = await upload(harness.base, page.id, alice.token, PNG, "image/png", "copy.png");
    assert.equal(duplicate.status, 201);
    assert.notEqual(duplicate.body.id, chart.id);
    assert.equal(duplicate.body.sha256, chart.sha256);
    assert.deepEqual(await readdir(join(harness.root, "data", "blobs", chart.sha256.slice(0, 2), chart.sha256.slice(2, 4))), [chart.sha256]);

    const listed = await json<{ attachments: AttachmentResponse[] }>(`${harness.base}/api/documents/${page.id}/attachments`, { token: bob.token });
    assert.deepEqual(listed.attachments.map((item) => item.id), [chart.id, duplicate.body.id]);
    assert.match(listed.attachments[0]?.url ?? "", new RegExp(`p=u\\.${bob.id}`));

    const download = await fetch(`${harness.base}/api/attachments/${chart.id}`, { headers: { authorization: `Bearer ${bob.token}` } });
    assert.equal(download.status, 200);
    assert.deepEqual(Buffer.from(await download.arrayBuffer()), PNG);
    assert.equal(download.headers.get("content-type"), "image/png");
    assert.equal(download.headers.get("x-content-type-options"), "nosniff");
    assert.match(download.headers.get("content-disposition") ?? "", /^inline; filename="Chart _final_.png"; filename\*=UTF-8''Chart%20_final_.png$/);
    assert.match(download.headers.get("content-security-policy") ?? "", /sandbox/);
    assert.equal(download.headers.get("etag"), `"${chart.sha256}"`);
    assert.equal(download.headers.get("cross-origin-resource-policy"), "same-origin");
    const notModified = await fetch(`${harness.base}/api/attachments/${chart.id}`, {
      headers: { authorization: `Bearer ${bob.token}`, "if-none-match": `"${chart.sha256}"` },
    });
    assert.equal(notModified.status, 304);

    assert.equal((await fetch(`${harness.base}/api/attachments/${chart.id}`)).status, 401);
    assert.equal((await fetch(`${harness.base}/api/attachments/${chart.id}`, { headers: { authorization: `Bearer ${mallory.token}` } })).status, 403);
    await json(`${harness.base}/api/documents/${page.id}/attachments`, { token: mallory.token, expectedStatus: 403 });
    assert.equal((await upload(harness.base, page.id, bob.token, PNG, "image/png", "viewer.png")).status, 403);
    assert.equal((await upload(harness.base, page.id, mallory.token, PNG, "image/png", "stranger.png")).status, 403);

    const svg = await upload(harness.base, page.id, alice.token, Buffer.from('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>'), "image/svg+xml", "logo.svg");
    assert.equal(svg.body.contentType, "image/svg+xml");
    assert.equal(svg.body.image, false);
    const svgDownload = await fetch(`${harness.base}/api/attachments/${svg.body.id}`, { headers: { authorization: `Bearer ${alice.token}` } });
    assert.equal(svgDownload.headers.get("content-type"), "application/octet-stream");
    assert.match(svgDownload.headers.get("content-disposition") ?? "", /^attachment;/);

    const html = await upload(harness.base, page.id, alice.token, Buffer.from("<!doctype html><script>alert(1)</script>"), "text/plain", "notes.txt");
    assert.equal(html.body.contentType, "text/html");
    const htmlDownload = await fetch(`${harness.base}/api/attachments/${html.body.id}`, { headers: { authorization: `Bearer ${alice.token}` } });
    assert.equal(htmlDownload.headers.get("content-type"), "application/octet-stream");
    assert.match(htmlDownload.headers.get("content-disposition") ?? "", /^attachment;/);

    const fakeImage = await upload(harness.base, page.id, alice.token, Buffer.from("plain words, not a picture"), "image/png", "fake.png");
    assert.equal(fakeImage.body.contentType, "text/plain");
    const pdf = await upload(harness.base, page.id, alice.token, PDF, "application/octet-stream", "spec.pdf");
    assert.equal(pdf.body.contentType, "application/pdf");
    const pdfDownload = await fetch(`${harness.base}/api/attachments/${pdf.body.id}`, { headers: { authorization: `Bearer ${alice.token}` } });
    assert.match(pdfDownload.headers.get("content-disposition") ?? "", /^inline;/);

    const exe = await upload(harness.base, page.id, alice.token, Buffer.concat([Buffer.from("MZ"), Buffer.alloc(64)]), "application/octet-stream", "setup.dat");
    assert.equal(exe.status, 415);
    const script = await upload(harness.base, page.id, alice.token, Buffer.from("echo hi"), "text/plain", "run.sh");
    assert.equal(script.status, 415);
    const elf = await upload(harness.base, page.id, alice.token, Buffer.from([0x7f, 0x45, 0x4c, 0x46, 1, 1, 1]), "text/plain", "readme.txt");
    assert.equal(elf.status, 415);
    const empty = await upload(harness.base, page.id, alice.token, Buffer.alloc(0), "text/plain", "empty.txt");
    assert.equal(empty.status, 400);
    const multipart = await fetch(`${harness.base}/api/documents/${page.id}/attachments`, {
      method: "POST",
      headers: { authorization: `Bearer ${alice.token}`, "content-type": "multipart/form-data; boundary=x" },
      body: "--x--",
    });
    assert.equal(multipart.status, 415);

    const deleted = await json<{ ok: boolean }>(`${harness.base}/api/documents/${page.id}/attachments/${fakeImage.body.id}`, { method: "DELETE", token: alice.token });
    assert.equal(deleted.ok, true);
    assert.equal((await fetch(`${harness.base}/api/attachments/${fakeImage.body.id}`, { headers: { authorization: `Bearer ${alice.token}` } })).status, 404);
    await json(`${harness.base}/api/documents/${page.id}/attachments/${fakeImage.body.id}`, { method: "DELETE", token: alice.token, expectedStatus: 404 });
    await json(`${harness.base}/api/documents/${page.id}/attachments/${chart.id}`, { method: "DELETE", token: bob.token, expectedStatus: 403 });
  } finally {
    await harness.close();
  }
});

test("attachment uploads respect the per-file limit and the per-space quota", async () => {
  const harness = await startCloudServer("noma-attachments-quota-", { maxAttachmentBytes: 1_024, attachmentQuotaBytes: 2_500 });
  try {
    const alice = await createCloudUser(harness.base, "Alice");
    const site = await json<{ id: string }>(`${harness.base}/api/sites`, { method: "POST", token: alice.token, body: { title: "Quota Space", documentIds: [] } });
    const page = await json<CloudDocumentResponse>(`${harness.base}/api/sites/${site.id}/documents`, {
      method: "POST",
      token: alice.token,
      body: { title: "Quota Page", source: "# Quota Page\n" },
    });
    const tooBig = await upload(harness.base, page.id, alice.token, Buffer.alloc(1_025, 0x61), "text/plain", "big.txt");
    assert.equal(tooBig.status, 413);
    assert.equal((tooBig.body as unknown as { code: string }).code, "attachment_too_large");
    const chunked = await fetch(`${harness.base}/api/documents/${page.id}/attachments`, {
      method: "POST",
      headers: { authorization: `Bearer ${alice.token}`, "content-type": "text/plain", "x-filename": "stream.txt" },
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new Uint8Array(800).fill(0x61));
          controller.enqueue(new Uint8Array(800).fill(0x62));
          controller.close();
        },
      }),
      duplex: "half",
    } as RequestInit);
    assert.equal(chunked.status, 413);
    assert.deepEqual(await readdir(join(harness.root, "data", "blobs", "tmp")), []);

    assert.equal((await upload(harness.base, page.id, alice.token, Buffer.alloc(1_000, 0x61), "text/plain", "one.txt")).status, 201);
    assert.equal((await upload(harness.base, page.id, alice.token, Buffer.alloc(1_000, 0x62), "text/plain", "two.txt")).status, 201);
    const overQuota = await upload(harness.base, page.id, alice.token, Buffer.alloc(1_000, 0x63), "text/plain", "three.txt");
    assert.equal(overQuota.status, 413);
    const details = overQuota.body as unknown as { code: string; scope: string; siteId: string; usedBytes: number };
    assert.equal(details.code, "attachment_quota_exceeded");
    assert.equal(details.scope, "site");
    assert.equal(details.siteId, site.id);
    assert.equal(details.usedBytes, 2_000);
    const rejectedSha = sha256(Buffer.alloc(1_000, 0x63));
    await assert.rejects(stat(join(harness.root, "data", "blobs", rejectedSha.slice(0, 2), rejectedSha.slice(2, 4), rejectedSha)), "over-quota uploads are discarded");
    assert.deepEqual(await readdir(join(harness.root, "data", "blobs", "tmp")), []);
  } finally {
    await harness.close();
  }
});

test("att: references render through signed same-origin URLs scoped to the page", async () => {
  const harness = await startCloudServer("noma-attachments-render-");
  try {
    const alice = await createCloudUser(harness.base, "Alice");
    const bob = await createCloudUser(harness.base, "Bob");
    const page = await createDocument(harness.base, alice.token, "Figure Page");
    const other = await createDocument(harness.base, alice.token, "Other Page");
    const chart = (await upload(harness.base, page.id, alice.token, PNG, "image/png", "chart.png")).body;
    const spec = (await upload(harness.base, page.id, alice.token, PDF, "application/pdf", "spec.pdf")).body;
    const foreign = (await upload(harness.base, other.id, alice.token, PNG, "image/png", "foreign.png")).body;
    const source = [
      "# Figure Page",
      "",
      `::figure{id="chart-fig" src="att:${chart.id}" alt="Growth chart" caption="Growth"}`,
      "::",
      "",
      "Read the [spec](att:spec.pdf) or the [missing file](att:nope.pdf).",
      "",
      `::figure{id="foreign-fig" src="att:${foreign.id}" alt="Foreign"}`,
      "::",
      "",
    ].join("\n");
    await json(`${harness.base}/api/documents/${page.id}`, { method: "PUT", token: alice.token, body: { source, expectedHash: sha256(Buffer.from((await getDocument(harness.base, page.id, alice.token)).source)) } });

    const response = await fetch(`${harness.base}/d/${page.id}`, { headers: { authorization: `Bearer ${alice.token}` } });
    const html = await response.text();
    assert.match(response.headers.get("content-security-policy") ?? "", /img-src data: 'self'/);
    const imgSrc = /<img src="([^"]+)" alt="Growth chart"/.exec(html)?.[1]?.replaceAll("&amp;", "&");
    assert.ok(imgSrc, html);
    assert.match(imgSrc, new RegExp(`^/api/attachments/${chart.id}\\?exp=\\d+&p=u\\.${alice.id}&sig=[A-Za-z0-9_-]{43}$`));
    assert.match(html, new RegExp(`<a href="/api/attachments/${spec.id}\\?exp=`));
    assert.match(html, /<a href="#">missing file<\/a>/);
    assert.match(html, new RegExp(`\\[attachment not available: att:${foreign.id}\\]`));

    const signed = await fetch(`${harness.base}${imgSrc}`);
    assert.equal(signed.status, 200);
    assert.equal(signed.headers.get("cross-origin-resource-policy"), "cross-origin", "sandboxed artifacts have an opaque origin");
    assert.deepEqual(Buffer.from(await signed.arrayBuffer()), PNG);
    const tampered = await fetch(`${harness.base}${imgSrc.replace(/sig=.{4}/, "sig=AAAA")}`);
    assert.equal(tampered.status, 403);
    const wrongAttachment = await fetch(`${harness.base}${imgSrc.replace(chart.id, spec.id)}`);
    assert.equal(wrongAttachment.status, 403);
    const swappedPrincipal = await fetch(`${harness.base}${imgSrc.replace(`p=u.${alice.id}`, `p=u.${bob.id}`)}`);
    assert.equal(swappedPrincipal.status, 403);

    const htmlApi = await fetch(`${harness.base}/api/documents/${page.id}/html`, { headers: { authorization: `Bearer ${alice.token}` } });
    assert.match(await htmlApi.text(), new RegExp(`/api/attachments/${chart.id}\\?exp=`));

    await json(`${harness.base}/api/documents/${page.id}/collaborators`, { method: "POST", token: alice.token, body: { userId: bob.id, role: "viewer" } });
    const bobList = await json<{ attachments: AttachmentResponse[] }>(`${harness.base}/api/documents/${page.id}/attachments`, { token: bob.token });
    const bobUrl = bobList.attachments.find((item) => item.id === chart.id)?.url ?? "";
    assert.equal((await fetch(`${harness.base}${bobUrl}`)).status, 200);
    await json(`${harness.base}/api/documents/${page.id}/collaborators/${bob.id}`, { method: "DELETE", token: alice.token });
    assert.equal((await fetch(`${harness.base}${bobUrl}`)).status, 403, "signed URLs re-check the grant");

    harness.clock.now = new Date(harness.clock.now.getTime() + 3 * 60 * 60 * 1000);
    assert.equal((await fetch(`${harness.base}${imgSrc}`)).status, 403, "signed URLs expire");

    const share = await json<{ token: string }>(`${harness.base}/api/documents/${page.id}/shares`, { method: "POST", token: alice.token, body: { role: "viewer" } });
    const sharedHtml = await (await fetch(`${harness.base}/d/${page.id}?share=${share.token}`)).text();
    const sharedSrc = /<img src="([^"]+)" alt="Growth chart"/.exec(sharedHtml)?.[1]?.replaceAll("&amp;", "&") ?? "";
    assert.match(sharedSrc, /p=s\./);
    assert.equal((await fetch(`${harness.base}${sharedSrc}`)).status, 200);
    assert.equal((await fetch(`${harness.base}/api/attachments/${chart.id}`, { headers: { "x-noma-share-token": share.token } })).status, 200);
    const shares = await json<{ shares: Array<{ id: string }> }>(`${harness.base}/api/documents/${page.id}/shares`, { token: alice.token });
    await json(`${harness.base}/api/documents/${page.id}/shares/${shares.shares[0]!.id}`, { method: "DELETE", token: alice.token });
    assert.equal((await fetch(`${harness.base}${sharedSrc}`)).status, 403, "revoked share links revoke signed URLs");
  } finally {
    await harness.close();
  }
});

test("attachments are searchable, backed up, restored, and garbage-collected on purge", async () => {
  const harness = await startCloudServer("noma-attachments-lifecycle-");
  try {
    const alice = await createCloudUser(harness.base, "Alice");
    const bob = await createCloudUser(harness.base, "Bob");
    const page = await createDocument(harness.base, alice.token, "Quarterly Report");
    const sibling = await createDocument(harness.base, alice.token, "Sibling Report");
    const unique = Buffer.from("zebra-quokka appendix\n");
    const appendix = (await upload(harness.base, page.id, alice.token, unique, "text/plain", "zanzibar-appendix.txt")).body;
    const shared = (await upload(harness.base, page.id, alice.token, PNG, "image/png", "shared.png")).body;
    await upload(harness.base, sibling.id, alice.token, PNG, "image/png", "shared-copy.png");

    const search = await json<{ results: Array<{ documentId: string; nodeType: string; blockId?: string; title?: string }> }>(
      `${harness.base}/api/search?q=zanzibar`,
      { token: alice.token },
    );
    assert.ok(search.results.some((result) => result.documentId === page.id && result.nodeType === "attachment" && result.blockId === `att:${appendix.id}` && result.title === "zanzibar-appendix.txt"));
    const bobSearch = await json<{ results: unknown[] }>(`${harness.base}/api/search?q=zanzibar`, { token: bob.token });
    assert.equal(bobSearch.results.length, 0);
    await json(`${harness.base}/api/documents/${page.id}`, { method: "PUT", token: alice.token, body: { source: "# Quarterly Report\n\nEdited.\n", expectedHash: (await getDocument(harness.base, page.id, alice.token)).hash } });
    const afterEdit = await json<{ results: Array<{ nodeType: string }> }>(`${harness.base}/api/search?q=zanzibar`, { token: alice.token });
    assert.ok(afterEdit.results.some((result) => result.nodeType === "attachment"), "attachment rows survive re-indexing the page");

    const bundle = await json<{
      manifest: { attachments?: Array<{ id: string; sha256: string }> };
      attachments?: Array<{ id: string; data: string }>;
      files: Array<{ documentId: string }>;
    }>(`${harness.base}/api/backup/export`, { method: "POST", token: alice.token, body: { documentIds: [page.id] } });
    assert.deepEqual(bundle.manifest.attachments?.map((item) => item.id).sort(), [appendix.id, shared.id].sort());
    assert.equal(Buffer.from(bundle.attachments?.find((item) => item.id === appendix.id)?.data ?? "", "base64").toString(), unique.toString());
    const withoutAttachments = await json<{ attachments?: unknown[] }>(`${harness.base}/api/backup/export`, {
      method: "POST",
      token: alice.token,
      body: { documentIds: [page.id], includeAttachments: false },
    });
    assert.equal(withoutAttachments.attachments, undefined);

    const tampered = structuredClone(bundle);
    tampered.attachments![0]!.data = Buffer.from("evil").toString("base64");
    await json(`${harness.base}/api/backup/import`, { method: "POST", token: alice.token, body: { bundle: tampered, apply: true }, expectedStatus: 400 });

    await json(`${harness.base}/api/trash/document/${page.id}`, { method: "POST", token: alice.token });
    assert.equal((await fetch(`${harness.base}/api/attachments/${appendix.id}`, { headers: { authorization: `Bearer ${alice.token}` } })).status, 404);
    const purged = await json<{ blobsRemoved: number }>(`${harness.base}/api/trash/document/${page.id}`, { method: "DELETE", token: alice.token });
    assert.equal(purged.blobsRemoved, 1, "only the blob no other page references is removed");
    const blobPath = (sha: string) => join(harness.root, "data", "blobs", sha.slice(0, 2), sha.slice(2, 4), sha);
    await assert.rejects(stat(blobPath(appendix.sha256)));
    assert.ok((await stat(blobPath(shared.sha256))).isFile());

    const restored = await json<{ created: string[]; attachments: { restored: string[]; skipped: string[] } }>(`${harness.base}/api/backup/import`, {
      method: "POST",
      token: alice.token,
      body: { bundle, apply: true },
    });
    assert.deepEqual(restored.created, [page.id]);
    assert.deepEqual(restored.attachments.restored.sort(), [appendix.id, shared.id].sort());
    const again = await fetch(`${harness.base}/api/attachments/${appendix.id}`, { headers: { authorization: `Bearer ${alice.token}` } });
    assert.equal(await again.text(), unique.toString());
  } finally {
    await harness.close();
  }
});

test("attachment helpers sanitise names, sniff content, and keep renderers pure", async () => {
  assert.equal(sanitizeAttachmentFilename("..\\..\\windows\\system32\\evil.png"), "evil.png");
  assert.equal(sanitizeAttachmentFilename("%E2%9C%93%20ok.txt"), "✓ ok.txt");
  assert.equal(sanitizeAttachmentFilename("  ...  "), "attachment");
  assert.equal(sanitizeAttachmentFilename("a\u0000b‮c.txt"), "abc.txt");
  assert.equal(sanitizeAttachmentFilename(`${"x".repeat(300)}.pdf`).length, 180);
  assert.ok(sanitizeAttachmentFilename(`${"x".repeat(300)}.pdf`).endsWith(".pdf"));
  assert.equal(sniffAttachmentType(PNG, "text/plain", "x.txt"), "image/png");
  assert.equal(sniffAttachmentType(Buffer.from("a,b\n1,2\n"), "application/octet-stream", "data.csv"), "text/csv");
  assert.equal(sniffAttachmentType(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0]), "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "a.docx"), "application/vnd.openxmlformats-officedocument.wordprocessingml.document");
  assert.equal(sniffAttachmentType(Buffer.from([0x50, 0x4b, 0x03, 0x04, 0]), "application/vnd.openxmlformats-officedocument.wordprocessingml.document", "a.zip"), "application/zip");
  assert.equal(sniffAttachmentType(Buffer.from([0, 1, 2, 3, 0xff]), undefined, "blob"), "application/octet-stream");
  assert.throws(() => sniffAttachmentType(Buffer.from("#!/bin/sh\n"), "text/plain", "x.txt"), /Executable/);

  assert.equal(safeHref("att:abc123def"), "att:abc123def");
  assert.equal(inlineToHtml("[x](att:abc)"), '<a href="att:abc">x</a>');
  assert.equal(inlineToHtml("[x](att:abc)", { resolveAttachment: (ref) => (ref === "abc" ? "/api/attachments/abc?sig=1&exp=2" : undefined) }), '<a href="/api/attachments/abc?sig=1&amp;exp=2">x</a>');
  assert.equal(inlineToHtml("[x](att:zzz)", { resolveAttachment: () => undefined }), '<a href="#">x</a>');
  assert.equal(inlineToHtml("[x](javascript:alert)", { resolveAttachment: () => "/nope" }), '<a href="#">x</a>');
  const doc = parse('# T\n\n::figure{src="att:img" alt="A"}\n::\n\n::button{href="att:img"}\nGo\n::\n', { filename: "t.noma" });
  const plain = renderHtml(doc, { externalAssets: false });
  assert.match(plain, /attachment not available: att:img/);
  const resolved = renderHtml(doc, { externalAssets: false, resolveAttachment: (ref) => `/files/${ref}` });
  assert.match(resolved, /<img src="\/files\/img" alt="A" loading="lazy" \/>/);
  assert.match(resolved, /<a class="noma-button" href="\/files\/img"/);

  const root = await mkdtemp(join(tmpdir(), "noma-blobs-"));
  try {
    const store = new LocalDiskBlobStore(root);
    const staged = await store.stage((async function* () {
      yield Buffer.from("hello ");
      yield Buffer.from("world");
    })());
    assert.equal(staged.sha256, sha256(Buffer.from("hello world")));
    assert.equal(await store.exists(staged.sha256), false);
    await staged.commit();
    assert.equal(await store.exists(staged.sha256), true);
    const discarded = await store.stage((async function* () {
      yield Buffer.from("temporary");
    })());
    await discarded.discard();
    assert.equal(await store.exists(discarded.sha256), false);
    assert.deepEqual(await readdir(join(root, "blobs", "tmp")), []);
    await store.delete(staged.sha256);
    assert.equal(await store.exists(staged.sha256), false);
    await assert.rejects(store.get("../../etc/passwd"));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

async function upload(
  base: string,
  documentId: string,
  token: string,
  body: Buffer,
  contentType: string,
  filename: string,
): Promise<{ status: number; body: AttachmentResponse }> {
  const response = await fetch(`${base}/api/documents/${documentId}/attachments`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": contentType, "x-filename": encodeURIComponent(filename) },
    body,
  });
  return { status: response.status, body: (await response.json()) as AttachmentResponse };
}

async function createDocument(base: string, token: string, title: string): Promise<CloudDocumentResponse> {
  return json<CloudDocumentResponse>(`${base}/api/documents`, { method: "POST", token, body: { title, source: `# ${title}\n\nBody.\n` } });
}

async function getDocument(base: string, id: string, token: string): Promise<CloudDocumentResponse> {
  return json<CloudDocumentResponse>(`${base}/api/documents/${id}`, { token });
}

async function startCloudServer(
  prefix: string,
  options: Pick<NomaCloudServerOptions, "maxAttachmentBytes" | "attachmentQuotaBytes"> = {},
): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const publicDir = join(root, "public");
  await mkdir(publicDir, { recursive: true });
  await writeFile(join(publicDir, "index.html"), "<h1>Noma</h1>", "utf8");
  const clock = { now: new Date("2026-06-06T12:00:00.000Z") };
  const server = createNomaCloudServer({
    dataDir: join(root, "data", "documents"),
    usersDir: join(root, "data", "users"),
    sitesDir: join(root, "data", "sites"),
    dbPath: join(root, "data", "noma-cloud.sqlite"),
    publicDir,
    maxBodyBytes: 200_000,
    rateLimitMaxRequests: 10_000,
    now: () => clock.now,
    ...options,
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return {
    base: `http://127.0.0.1:${address.port}`,
    root,
    clock,
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
  for (const [name, value] of Object.entries(options.headers ?? {})) headers.set(name, value);
  if (options.token) headers.set("authorization", `Bearer ${options.token}`);
  if (options.share) headers.set("x-noma-share-token", options.share);
  if (options.body) headers.set("content-type", "application/json");
  const response = await fetch(url, {
    method: options.method ?? "GET",
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  if (options.expectedStatus !== undefined) {
    assert.equal(response.status, options.expectedStatus, await response.text());
    return {} as T;
  }
  if (!response.ok) assert.fail(`${response.status} ${await response.text()}`);
  return response.json() as Promise<T>;
}

function sha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}
