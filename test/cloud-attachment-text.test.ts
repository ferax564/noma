import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { attachmentTextSettingsFromEnv, sanitizeExtractedText } from "../src/cloud/attachment-text.js";
import { createNomaCloudServer, type NomaCloudServerOptions } from "../src/cloud-server.js";

interface User {
  id: string;
  token: string;
}

interface Extraction {
  status: "pending" | "done" | "failed" | "skipped";
  attempts: number;
  textLength: number;
  preview?: boolean;
  dlpWithheld?: boolean;
  error?: string;
}

interface Attachment {
  id: string;
  size: number;
  filename: string;
  contentType: string;
  url?: string;
  previewUrl?: string;
  extraction?: Extraction;
}

interface Harness {
  base: string;
  clock: { now: Date };
  close: () => Promise<void>;
}

interface Sidecar {
  url: string;
  calls: Array<{ path: string; auth?: string; config?: string; contentType?: string; bytes: number; filename?: string }>;
  mode: "ok" | "error" | "not-pdf" | "huge" | "hang";
  close: () => Promise<void>;
}

const DOCX = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

function pdfWithText(text: string): Buffer {
  return Buffer.from(`%PDF-1.4\nTEXT:${text}\n%%EOF\n`, "utf8");
}

function docxWithText(text: string): Buffer {
  return Buffer.concat([Buffer.from([0x50, 0x4b, 0x03, 0x04]), Buffer.from(`word/document.xml DOCXTEXT:${text}\n`, "utf8")]);
}

async function readBody(req: IncomingMessage): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  return Buffer.concat(chunks);
}

async function listen(handler: (req: IncomingMessage, res: ServerResponse, sidecar: Sidecar) => Promise<void>): Promise<Sidecar> {
  const sidecar: Sidecar = { url: "", calls: [], mode: "ok", close: async () => undefined };
  const server: Server = createServer((req, res) => void handler(req, res, sidecar).catch(() => res.destroy()));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  sidecar.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  sidecar.close = () => new Promise<void>((resolve) => server.close(() => resolve()));
  return sidecar;
}

/** Fake ferrox-server: `extract_text` returns whatever follows `TEXT:` in the "PDF". */
function fakeFerrox(token: string): Promise<Sidecar> {
  return listen(async (req, res, sidecar) => {
    const body = await readBody(req);
    sidecar.calls.push({ path: req.url ?? "", auth: req.headers.authorization, config: String(req.headers["x-ferrox-config"] ?? ""), contentType: req.headers["content-type"], bytes: body.byteLength });
    if (req.url !== "/api/v1/process" || req.method !== "POST") return void res.writeHead(404).end();
    if (req.headers.authorization !== `Bearer ${token}`) return void res.writeHead(401, { "content-type": "application/json" }).end('{"error":"missing or invalid bearer token"}');
    if (sidecar.mode === "error") return void res.writeHead(503).end("busy");
    if (sidecar.mode === "hang") return;
    const text = /TEXT:([^\n]*)/.exec(body.toString("utf8"))?.[1] ?? "";
    const data = Buffer.from(`${text}\u0000‮`, "utf8").toString("base64");
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ artifacts: [{ artifact_id: "text", name: "text.txt", media_type: "text/plain", data, data_base64: data }] }));
  });
}

/** Fake officeconvert: turns `DOCXTEXT:` into a one-line "PDF" carrying the same text. */
function fakeOfficeConvert(): Promise<Sidecar> {
  return listen(async (req, res, sidecar) => {
    const body = await readBody(req);
    const filename = /filename="([^"]+)"/.exec(body.toString("latin1"))?.[1];
    sidecar.calls.push({ path: req.url ?? "", auth: req.headers.authorization, contentType: req.headers["content-type"], bytes: body.byteLength, ...(filename ? { filename } : {}) });
    if (req.url !== "/v1/convert" || req.method !== "POST" || !/^multipart\/form-data/.test(req.headers["content-type"] ?? "")) return void res.writeHead(400).end();
    const text = /DOCXTEXT:([^\n]*)/.exec(body.toString("utf8"))?.[1] ?? "";
    if (sidecar.mode === "not-pdf") return void res.writeHead(200, { "content-type": "application/pdf" }).end("<html>not a pdf</html>");
    if (sidecar.mode === "huge") return void res.writeHead(200, { "content-type": "application/pdf" }).end(Buffer.concat([Buffer.from("%PDF-1.7\n"), Buffer.alloc(200_000, 0x20)]));
    res.writeHead(200, { "content-type": "application/pdf" });
    res.end(pdfWithText(text));
  });
}

async function start(options: Partial<NomaCloudServerOptions>): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), "noma-attachment-text-"));
  const publicDir = join(root, "public");
  await mkdir(publicDir, { recursive: true });
  await writeFile(join(publicDir, "index.html"), "<h1>Noma</h1>", "utf8");
  const clock = { now: new Date("2026-09-27T12:00:00.000Z") };
  const server = createNomaCloudServer({
    dataDir: join(root, "data", "documents"),
    usersDir: join(root, "data", "users"),
    sitesDir: join(root, "data", "sites"),
    dbPath: join(root, "data", "noma-cloud.sqlite"),
    publicDir,
    rateLimitMaxRequests: 10_000,
    queueIntervalMs: 0,
    embeddings: { provider: null },
    now: () => clock.now,
    ...options,
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    base: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    clock,
    close: async () => {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await rm(root, { recursive: true, force: true });
    },
  };
}

async function json<T>(url: string, options: { method?: string; token?: string; body?: unknown; expected?: number } = {}): Promise<T> {
  const response = await fetch(url, {
    method: options.method ?? "GET",
    headers: { ...(options.token ? { authorization: `Bearer ${options.token}` } : {}), ...(options.body ? { "content-type": "application/json" } : {}) },
    ...(options.body ? { body: JSON.stringify(options.body) } : {}),
  });
  const text = await response.text();
  if (options.expected === undefined) assert.ok(response.status === 200 || response.status === 201, `${response.status} ${text}`);
  else assert.equal(response.status, options.expected, text);
  return JSON.parse(text) as T;
}

async function user(base: string, name: string): Promise<User> {
  return json<User>(`${base}/api/users`, { method: "POST", body: { name } });
}

async function page(base: string, token: string, title: string): Promise<{ id: string }> {
  return json(`${base}/api/documents`, { method: "POST", token, body: { title, source: `# ${title}\n\nBody.\n` } });
}

async function upload(base: string, documentId: string, token: string, bytes: Buffer, contentType: string, filename: string): Promise<Attachment> {
  const response = await fetch(`${base}/api/documents/${documentId}/attachments`, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": contentType, "x-filename": encodeURIComponent(filename) },
    body: bytes,
  });
  const text = await response.text();
  assert.equal(response.status, 201, text);
  return JSON.parse(text) as Attachment;
}

async function runPass(base: string, admin: User): Promise<{ counts: Record<string, number> }> {
  return json(`${base}/api/enterprise/attachment-text/run`, { method: "POST", token: admin.token });
}

async function attachment(base: string, documentId: string, token: string, id: string): Promise<Attachment> {
  const listed = await json<{ attachments: Attachment[] }>(`${base}/api/documents/${documentId}/attachments`, { token });
  const found = listed.attachments.find((item) => item.id === id);
  assert.ok(found, `attachment ${id} is listed`);
  return found;
}

async function find(base: string, token: string, q: string): Promise<{ pages: Array<{ id: string }>; attachments: Array<{ id: string; filename: string; documentId: string; excerpt: string }> }> {
  return json(`${base}/api/find?q=${encodeURIComponent(q)}`, { token });
}

test("sanitizeExtractedText strips control and bidi characters and caps UTF-8 bytes on a character boundary", () => {
  assert.deepEqual(sanitizeExtractedText("a\u0000b‮c​d\r\n\n\n\ne \t f\ud800"), { text: "a bcd\n\ne f", truncated: false });
  const capped = sanitizeExtractedText("é".repeat(10), 5);
  assert.deepEqual(capped, { text: "éé", truncated: true });
});

test("attachment sidecar settings come from env and stay off when unset", () => {
  assert.equal(attachmentTextSettingsFromEnv({}, () => ""), undefined);
  const settings = attachmentTextSettingsFromEnv(
    { NOMA_CLOUD_PDF_EXTRACT_URL: "http://ferrox:3001/", NOMA_CLOUD_PDF_EXTRACT_TOKEN_FILE: "/run/secret", NOMA_CLOUD_ATTACHMENT_TEXT_TIMEOUT_MS: "5000" },
    () => " file-token \n",
  );
  assert.deepEqual(settings, { pdfExtract: { url: "http://ferrox:3001", token: "file-token" }, timeoutMs: 5000, maxInputBytes: 2_000_000 });
  assert.throws(() => attachmentTextSettingsFromEnv({ NOMA_CLOUD_OFFICE_CONVERT_URL: "ftp://x" }, () => ""), /http\(s\) URL/);
});

test("PDF and Office attachments are extracted in the background, indexed for search and retrieval, and previewed", async () => {
  const ferrox = await fakeFerrox("ferrox-secret");
  const office = await fakeOfficeConvert();
  const harness = await start({
    attachmentText: { pdfExtract: { url: ferrox.url, token: "ferrox-secret" }, officeConvert: { url: office.url }, timeoutMs: 5_000, maxInputBytes: 64 * 1024 },
  });
  const { base } = harness;
  try {
    const ada = await user(base, "Ada");
    const bob = await user(base, "Bob");
    const notes = await page(base, ada.token, "Design Notes");

    const pdf = await upload(base, notes.id, ada.token, pdfWithText("zygomorphic turbine schematics"), "application/pdf", "spec.pdf");
    const docx = await upload(base, notes.id, ada.token, docxWithText("quarterly heliotrope forecast"), DOCX, "Plan Q3.docx");
    const png = await upload(base, notes.id, ada.token, Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64"), "image/png", "chart.png");
    assert.equal(docx.contentType, DOCX);

    const pass = await runPass(base, ada);
    assert.equal(pass.counts.done, 2);
    const pdfState = await attachment(base, notes.id, ada.token, pdf.id);
    assert.equal(pdfState.extraction?.status, "done");
    assert.equal(pdfState.extraction?.textLength, "zygomorphic turbine schematics".length);
    assert.equal(pdfState.previewUrl, undefined);
    assert.equal((await attachment(base, notes.id, ada.token, png.id)).extraction, undefined);

    const ferroxCall = ferrox.calls.find((call) => call.path === "/api/v1/process");
    assert.equal(ferroxCall?.auth, "Bearer ferrox-secret");
    assert.equal(ferroxCall?.contentType, "application/pdf");
    assert.deepEqual(JSON.parse(ferroxCall?.config ?? "{}"), { op: "extract_text" });
    assert.equal(office.calls.length, 1);
    assert.equal(office.calls[0]?.filename, "document.docx");
    assert.equal(office.calls[0]?.auth, undefined);

    const found = await find(base, ada.token, "zygomorphic");
    assert.deepEqual(found.attachments.map((item) => [item.id, item.filename, item.documentId]), [[pdf.id, "spec.pdf", notes.id]]);
    assert.match(found.attachments[0]!.excerpt, /zygomorphic turbine/);
    assert.doesNotMatch(found.attachments[0]!.excerpt, /[\u0000‮]/);
    assert.deepEqual((await find(base, ada.token, "heliotrope")).attachments.map((item) => item.id), [docx.id]);

    const knowledge = await json<{ results: Array<{ blockId: string; contentType: string; documentId: string }> }>(`${base}/api/knowledge/search?q=${encodeURIComponent("heliotrope forecast")}`, { token: ada.token });
    assert.ok(knowledge.results.some((result) => result.blockId === `att:${docx.id}` && result.contentType === "attachment" && result.documentId === notes.id));

    // Permission scoping: Bob sees nothing until he can view the page.
    assert.deepEqual((await find(base, bob.token, "zygomorphic")).attachments, []);
    const bobKnowledge = await json<{ results: Array<{ blockId: string }> }>(`${base}/api/knowledge/search?q=heliotrope`, { token: bob.token });
    assert.equal(bobKnowledge.results.length, 0);
    await json(`${base}/api/documents/${notes.id}/collaborators`, { method: "POST", token: ada.token, body: { userId: bob.id, role: "viewer" } });
    assert.deepEqual((await find(base, bob.token, "zygomorphic")).attachments.map((item) => item.id), [pdf.id]);

    // Office preview: derived PDF, same auth and safe headers.
    const docxState = await attachment(base, notes.id, bob.token, docx.id);
    assert.equal(docxState.extraction?.preview, true);
    assert.match(docxState.previewUrl ?? "", new RegExp(`^/api/attachments/${docx.id}/preview\\?exp=\\d+&p=u\\.${bob.id}&sig=`));
    const preview = await fetch(`${base}/api/attachments/${docx.id}/preview`, { headers: { authorization: `Bearer ${bob.token}` } });
    assert.equal(preview.status, 200);
    assert.equal(preview.headers.get("content-type"), "application/pdf");
    assert.match(preview.headers.get("content-disposition") ?? "", /^inline; filename="Plan Q3.pdf"/);
    assert.equal(preview.headers.get("x-content-type-options"), "nosniff");
    assert.match(preview.headers.get("content-security-policy") ?? "", /sandbox/);
    assert.equal((await preview.arrayBuffer()).byteLength > 0, true);
    const signed = await fetch(`${base}${docxState.previewUrl}`);
    assert.equal(signed.status, 200);
    assert.equal(Buffer.from(await signed.arrayBuffer()).subarray(0, 5).toString("latin1"), "%PDF-");
    const mallory = await user(base, "Mallory");
    assert.equal((await fetch(`${base}/api/attachments/${docx.id}/preview`, { headers: { authorization: `Bearer ${mallory.token}` } })).status, 403);
    assert.equal((await fetch(`${base}/api/attachments/${docx.id}/preview`)).status, 401);
    const noPreview = await fetch(`${base}/api/attachments/${pdf.id}/preview`, { headers: { authorization: `Bearer ${ada.token}` } });
    assert.equal(noPreview.status, 404);
    assert.equal(((await noPreview.json()) as { code: string }).code, "attachment_preview_unavailable");
    assert.equal((await fetch(`${base}/api/attachments/${docx.id}/other`, { headers: { authorization: `Bearer ${ada.token}` } })).status, 404);

    // Identical bytes are converted and extracted once.
    const copy = await upload(base, notes.id, ada.token, docxWithText("quarterly heliotrope forecast"), DOCX, "copy.docx");
    await runPass(base, ada);
    assert.equal((await attachment(base, notes.id, ada.token, copy.id)).extraction?.status, "done");
    assert.equal(office.calls.length, 1);

    // Deleting the attachment drops its text from search.
    await json(`${base}/api/documents/${notes.id}/attachments/${pdf.id}`, { method: "DELETE", token: ada.token });
    assert.deepEqual((await find(base, ada.token, "zygomorphic")).attachments, []);

    const status = await json<{ configured: { pdfExtract: boolean; officeConvert: boolean }; counts: Record<string, number> }>(`${base}/api/enterprise/attachment-text`, { token: ada.token });
    assert.deepEqual(status.configured, { pdfExtract: true, officeConvert: true });
    await json(`${base}/api/enterprise/attachment-text`, { token: bob.token, expected: 403 });
  } finally {
    await harness.close();
    await ferrox.close();
    await office.close();
  }
});

test("DLP scans extracted attachment text: warn flags it, block keeps it out of search", async () => {
  const ferrox = await fakeFerrox("t");
  const harness = await start({ attachmentText: { pdfExtract: { url: ferrox.url, token: "t" }, timeoutMs: 5_000, maxInputBytes: 64 * 1024 } });
  const { base } = harness;
  try {
    const ada = await user(base, "Ada");
    const notes = await page(base, ada.token, "Keys");
    await json(`${base}/api/enterprise/dlp`, { method: "PUT", token: ada.token, body: { mode: "warn" } });
    const warned = await upload(base, notes.id, ada.token, pdfWithText("rotation note AKIAABCDEFGHIJKLMNOP marmalade"), "application/pdf", "keys.pdf");
    await runPass(base, ada);
    const findings = await json<{ findings: Array<{ resourceType: string; resourceId: string; outcome: string; detectors: string[] }> }>(`${base}/api/enterprise/dlp-findings`, { token: ada.token });
    assert.deepEqual(
      findings.findings.map((finding) => [finding.resourceType, finding.resourceId, finding.outcome, finding.detectors]),
      [["attachment", warned.id, "flagged", ["aws_access_key"]]],
    );
    assert.deepEqual((await find(base, ada.token, "marmalade")).attachments.map((item) => item.id), [warned.id]);

    await json(`${base}/api/enterprise/dlp`, { method: "PUT", token: ada.token, body: { mode: "block" } });
    const blocked = await upload(base, notes.id, ada.token, pdfWithText("second AKIAQRSTUVWXYZ234567 quince"), "application/pdf", "more-keys.pdf");
    await runPass(base, ada);
    const state = await attachment(base, notes.id, ada.token, blocked.id);
    assert.equal(state.extraction?.status, "done");
    assert.equal(state.extraction?.dlpWithheld, true);
    assert.deepEqual((await find(base, ada.token, "quince")).attachments, []);
    const after = await json<{ findings: Array<{ resourceId: string; outcome: string }> }>(`${base}/api/enterprise/dlp-findings`, { token: ada.token });
    assert.ok(after.findings.some((finding) => finding.resourceId === blocked.id && finding.outcome === "blocked"));
  } finally {
    await harness.close();
    await ferrox.close();
  }
});

test("a down sidecar retries with backoff then fails, and never affects the upload", async () => {
  const closed = await fakeFerrox("t");
  await closed.close();
  const harness = await start({ attachmentText: { pdfExtract: { url: closed.url, token: "t" }, timeoutMs: 2_000, maxInputBytes: 64 * 1024 } });
  const { base, clock } = harness;
  try {
    const ada = await user(base, "Ada");
    const notes = await page(base, ada.token, "Down");
    const pdf = await upload(base, notes.id, ada.token, pdfWithText("unreachable words"), "application/pdf", "down.pdf");
    assert.equal(pdf.contentType, "application/pdf");
    await runPass(base, ada);
    let state = await attachment(base, notes.id, ada.token, pdf.id);
    assert.deepEqual([state.extraction?.status, state.extraction?.attempts, state.extraction?.error], ["pending", 1, "pdf-extract is unreachable"]);
    await runPass(base, ada);
    assert.equal((await attachment(base, notes.id, ada.token, pdf.id)).extraction?.attempts, 1, "not retried before the backoff elapses");
    clock.now = new Date(clock.now.getTime() + 61_000);
    await runPass(base, ada);
    assert.equal((await attachment(base, notes.id, ada.token, pdf.id)).extraction?.attempts, 2);
    clock.now = new Date(clock.now.getTime() + 5 * 60_000);
    await runPass(base, ada);
    state = await attachment(base, notes.id, ada.token, pdf.id);
    assert.deepEqual([state.extraction?.status, state.extraction?.attempts], ["failed", 3]);
    const download = await fetch(`${base}/api/attachments/${pdf.id}`, { headers: { authorization: `Bearer ${ada.token}` } });
    assert.equal(download.status, 200);
    assert.deepEqual((await find(base, ada.token, "down.pdf")).attachments.map((item) => item.id), [pdf.id]);
    assert.deepEqual((await find(base, ada.token, "unreachable")).attachments, []);
  } finally {
    await harness.close();
  }
});

test("a slow sidecar times out and is retried later", async () => {
  const ferrox = await fakeFerrox("t");
  ferrox.mode = "hang";
  const harness = await start({ attachmentText: { pdfExtract: { url: ferrox.url, token: "t" }, timeoutMs: 150, maxInputBytes: 64 * 1024 } });
  const { base, clock } = harness;
  try {
    const ada = await user(base, "Ada");
    const notes = await page(base, ada.token, "Slow");
    const pdf = await upload(base, notes.id, ada.token, pdfWithText("glacial"), "application/pdf", "slow.pdf");
    await runPass(base, ada);
    const state = await attachment(base, notes.id, ada.token, pdf.id);
    assert.deepEqual([state.extraction?.status, state.extraction?.error], ["pending", "pdf-extract timed out after 150 ms"]);
    ferrox.mode = "ok";
    clock.now = new Date(clock.now.getTime() + 61_000);
    await runPass(base, ada);
    assert.equal((await attachment(base, notes.id, ada.token, pdf.id)).extraction?.status, "done");
    assert.deepEqual((await find(base, ada.token, "glacial")).attachments.map((item) => item.id), [pdf.id]);
  } finally {
    await harness.close();
    ferrox.close().catch(() => undefined);
  }
});

test("size caps: oversized inputs are skipped, oversized or non-PDF conversions fail, previews respect quota", async () => {
  const ferrox = await fakeFerrox("t");
  const office = await fakeOfficeConvert();
  const harness = await start({
    maxAttachmentBytes: 100_000,
    attachmentQuotaBytes: 100_000,
    attachmentText: { pdfExtract: { url: ferrox.url, token: "t" }, officeConvert: { url: office.url }, timeoutMs: 5_000, maxInputBytes: 4_096 },
  });
  const { base } = harness;
  try {
    const ada = await user(base, "Ada");
    const notes = await page(base, ada.token, "Caps");
    const big = await upload(base, notes.id, ada.token, Buffer.concat([pdfWithText("large"), Buffer.alloc(5_000, 0x20)]), "application/pdf", "big.pdf");
    await runPass(base, ada);
    assert.deepEqual([(await attachment(base, notes.id, ada.token, big.id)).extraction?.status, (await attachment(base, notes.id, ada.token, big.id)).extraction?.error], ["skipped", "too_large"]);
    assert.equal(ferrox.calls.length, 0);

    office.mode = "not-pdf";
    const fake = await upload(base, notes.id, ada.token, docxWithText("imposter"), DOCX, "fake.docx");
    await runPass(base, ada);
    const fakeState = await attachment(base, notes.id, ada.token, fake.id);
    assert.deepEqual([fakeState.extraction?.status, fakeState.extraction?.error], ["failed", "office-convert returned bytes that are not a PDF"]);
    assert.equal(fakeState.previewUrl, undefined);

    office.mode = "huge";
    const huge = await upload(base, notes.id, ada.token, docxWithText("enormous"), DOCX, "huge.docx");
    await runPass(base, ada);
    assert.deepEqual((await attachment(base, notes.id, ada.token, huge.id)).extraction?.error, "office-convert response exceeds 100000 bytes");

    office.mode = "ok";
    const tightBytes = docxWithText("squeezed");
    const used = [big, fake, huge].reduce((sum, item) => sum + item.size, 0) + tightBytes.byteLength;
    await upload(base, notes.id, ada.token, Buffer.alloc(100_000 - used - 10, 0x61), "text/plain", "filler.txt");
    const tight = await upload(base, notes.id, ada.token, tightBytes, DOCX, "tight.docx");
    await runPass(base, ada);
    const tightState = await attachment(base, notes.id, ada.token, tight.id);
    assert.equal(tightState.extraction?.status, "done");
    assert.equal(tightState.extraction?.preview, undefined);
    assert.equal(tightState.extraction?.error, "preview_over_quota");
    assert.deepEqual((await find(base, ada.token, "squeezed")).attachments.map((item) => item.id), [tight.id]);
  } finally {
    await harness.close();
    await ferrox.close();
    await office.close();
  }
});

test("without sidecars attachments behave exactly as before", async () => {
  const harness = await start({ attachmentText: null });
  const { base } = harness;
  try {
    const ada = await user(base, "Ada");
    const notes = await page(base, ada.token, "Plain");
    const pdf = await upload(base, notes.id, ada.token, pdfWithText("invisible words"), "application/pdf", "plain.pdf");
    assert.equal(pdf.extraction, undefined);
    assert.equal(pdf.previewUrl, undefined);
    await json(`${base}/api/enterprise/attachment-text/run`, { method: "POST", token: ada.token, expected: 409 });
    assert.deepEqual((await find(base, ada.token, "invisible")).attachments, []);
    assert.deepEqual((await find(base, ada.token, "plain.pdf")).attachments.map((item) => item.id), [pdf.id]);
  } finally {
    await harness.close();
  }
});
