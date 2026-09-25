import assert from "node:assert/strict";
import { createHash, createHmac } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { readBlobBuffer, S3BlobStore, type S3BlobStoreOptions, s3BlobKey, s3ObjectUrl, signS3Request } from "../src/cloud-blobs.js";
import { createBlobStoreFromEnv, createNomaCloudServer } from "../src/cloud-server.js";

const ACCESS_KEY_ID = "AKIDNOMATEST";
const SECRET_ACCESS_KEY = "noma-test-secret/do-not-log";
const SESSION_TOKEN = "session-token-value";
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==", "base64");

interface RecordedRequest {
  method: string;
  path: string;
  headers: IncomingMessage["headers"];
}

interface FakeS3 {
  endpoint: string;
  objects: Map<string, Buffer>;
  requests: RecordedRequest[];
  /** Responds 503 SlowDown to the next `count` requests with this method. */
  failNext(method: string, count: number): void;
  /** Never answers requests with this method (timeouts). */
  hang(method: string | undefined): void;
  close(): Promise<void>;
}

test("s3ObjectUrl builds virtual-hosted and path-style URLs; s3BlobKey applies the prefix", () => {
  const sha = "ab".repeat(32);
  const key = s3BlobKey("noma/prod", sha);
  assert.equal(key, `noma/prod/blobs/ab/ab/${sha}`);
  assert.equal(s3BlobKey("", sha), `blobs/ab/ab/${sha}`);
  assert.equal(s3BlobKey("/tenant/", sha), `tenant/blobs/ab/ab/${sha}`);
  assert.throws(() => s3BlobKey("../escape", sha), /must not contain/);
  assert.throws(() => s3BlobKey("", "not-a-hash"), /SHA-256/);

  assert.equal(s3ObjectUrl({ bucket: "noma-assets", region: "eu-central-1" }, key).href, `https://noma-assets.s3.eu-central-1.amazonaws.com/${key}`);
  assert.equal(
    s3ObjectUrl({ bucket: "noma-assets", region: "eu-central-1", forcePathStyle: true }, key).href,
    `https://s3.eu-central-1.amazonaws.com/noma-assets/${key}`,
  );
  assert.equal(s3ObjectUrl({ bucket: "noma", region: "us-east-1", endpoint: "http://127.0.0.1:9000" }, "a b/c+d").href, "http://127.0.0.1:9000/noma/a%20b/c%2Bd");
  assert.equal(
    s3ObjectUrl({ bucket: "noma", region: "auto", endpoint: "https://acct.r2.cloudflarestorage.com", forcePathStyle: false }, "k").href,
    "https://noma.acct.r2.cloudflarestorage.com/k",
  );
  assert.equal(s3ObjectUrl({ bucket: "noma", region: "fsn1", endpoint: "https://gw.example.com/storage/" }, "k").href, "https://gw.example.com/storage/noma/k");

  const store = new S3BlobStore({ bucket: "noma-assets", region: "eu-central-1", prefix: "p", credentials: { accessKeyId: "a", secretAccessKey: "b" } });
  assert.equal(store.urlFor(sha).href, `https://noma-assets.s3.eu-central-1.amazonaws.com/p/blobs/ab/ab/${sha}`);
  assert.throws(() => new S3BlobStore({ bucket: "Bad_Bucket", region: "eu-central-1", credentials: { accessKeyId: "a", secretAccessKey: "b" } }), /bucket/);
  assert.throws(() => new S3BlobStore({ bucket: "noma", region: "eu-central-1", credentials: { accessKeyId: "", secretAccessKey: "b" } }), /credentials/);
  assert.throws(() => new S3BlobStore({ bucket: "noma", region: "eu-central-1", endpoint: "ftp://x", credentials: { accessKeyId: "a", secretAccessKey: "b" } }), /endpoint/);
  assert.throws(
    () => new S3BlobStore({ bucket: "noma", region: "eu-central-1", kmsKeyId: "k", credentials: { accessKeyId: "a", secretAccessKey: "b" } }),
    /aws:kms/,
  );
});

test("signS3Request matches the AWS SigV4 GetObject reference example", () => {
  const headers = signS3Request({
    method: "GET",
    url: new URL("https://examplebucket.s3.amazonaws.com/test.txt"),
    region: "us-east-1",
    headers: { range: "bytes=0-9" },
    payloadSha256: "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
    credentials: { accessKeyId: "AKIAIOSFODNN7EXAMPLE", secretAccessKey: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY" },
    now: new Date("2013-05-24T00:00:00Z"),
  });
  assert.equal(
    headers.authorization,
    "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, SignedHeaders=host;range;x-amz-content-sha256;x-amz-date, Signature=f0e8bdb87c964420e857bd35b5d6ed310bd44f0170aba48dd91039c6036bdb41",
  );
  assert.equal(headers["x-amz-date"], "20130524T000000Z");
});

test("S3BlobStore stages locally, puts by hash, dedupes, streams gets, and deletes against a SigV4-checking fake", async () => {
  const s3 = await startFakeS3();
  const stagingDir = await mkdtemp(join(tmpdir(), "noma-s3-staging-"));
  try {
    const store = s3Store(s3, { stagingDir, prefix: "tenant-a", credentials: { accessKeyId: ACCESS_KEY_ID, secretAccessKey: SECRET_ACCESS_KEY, sessionToken: SESSION_TOKEN }, serverSideEncryption: "AES256" });
    assert.equal(store.kind, "s3");
    const staged = await store.stage(chunks([PNG.subarray(0, 10), PNG.subarray(10)]));
    assert.equal(staged.sha256, sha256(PNG));
    assert.equal(staged.size, PNG.byteLength);
    assert.deepEqual(staged.head, PNG);
    assert.equal(s3.requests.length, 0, "staging must not touch S3");
    assert.equal(await store.exists(staged.sha256), false);
    await staged.commit();
    await staged.commit();
    assert.deepEqual(await readdir(stagingDir), [], "the staged temp file is removed after commit");

    const key = `/noma-blobs/tenant-a/blobs/${staged.sha256.slice(0, 2)}/${staged.sha256.slice(2, 4)}/${staged.sha256}`;
    assert.deepEqual(s3.objects.get(key), PNG);
    const put = s3.requests.find((request) => request.method === "PUT");
    assert.ok(put);
    assert.equal(put.path, key);
    assert.equal(put.headers["x-amz-content-sha256"], staged.sha256, "the content hash is the signed payload hash");
    assert.equal(put.headers["x-amz-server-side-encryption"], "AES256");
    assert.equal(put.headers["x-amz-security-token"], SESSION_TOKEN);
    assert.equal(put.headers["content-length"], String(PNG.byteLength));
    assert.match(String(put.headers.authorization), /SignedHeaders=[^,]*x-amz-security-token/);

    assert.equal(await store.exists(staged.sha256), true);
    const again = await store.stage(chunks([PNG]));
    const putsBefore = s3.requests.filter((request) => request.method === "PUT").length;
    await again.commit();
    assert.equal(s3.requests.filter((request) => request.method === "PUT").length, putsBefore, "an existing blob is not uploaded again");

    const blob = await store.get(staged.sha256);
    assert.ok(blob);
    assert.equal(blob.size, PNG.byteLength);
    assert.deepEqual(await readStream(blob.stream), PNG);
    assert.deepEqual(await readBlobBuffer(store, staged.sha256, 1024), PNG);
    assert.equal(await store.get("cd".repeat(32)), undefined);

    const discarded = await store.stage(chunks([Buffer.from("never stored")]));
    await discarded.discard();
    assert.equal(s3.objects.size, 1);
    assert.deepEqual(await readdir(stagingDir), []);

    await store.delete(staged.sha256);
    assert.equal(s3.objects.size, 0);
    assert.equal(await store.exists(staged.sha256), false);
    await store.delete(staged.sha256);
    await assert.rejects(store.get("../../etc/passwd"), /SHA-256/);
  } finally {
    await s3.close();
    await rm(stagingDir, { recursive: true, force: true });
  }
});

test("S3BlobStore sends aws:kms headers, retries throttling once, and never leaks secrets in errors", async () => {
  const s3 = await startFakeS3();
  const stagingDir = await mkdtemp(join(tmpdir(), "noma-s3-staging-"));
  try {
    const store = s3Store(s3, { stagingDir, serverSideEncryption: "aws:kms", kmsKeyId: "arn:aws:kms:eu-central-1:111122223333:key/abc" });
    s3.failNext("PUT", 1);
    const staged = await store.stage(chunks([PNG]));
    await staged.commit();
    const puts = s3.requests.filter((request) => request.method === "PUT");
    assert.equal(puts.length, 2, "one 503 SlowDown, then a successful retry");
    assert.equal(puts[1]?.headers["x-amz-server-side-encryption"], "aws:kms");
    assert.equal(puts[1]?.headers["x-amz-server-side-encryption-aws-kms-key-id"], "arn:aws:kms:eu-central-1:111122223333:key/abc");
    assert.equal(s3.objects.size, 1);

    s3.failNext("GET", 5);
    const failing = s3Store(s3, { stagingDir, maxAttempts: 2 });
    const error = await failing.get(staged.sha256).then(
      () => assert.fail("expected the get to fail"),
      (caught: unknown) => caught as Error,
    );
    assert.match(error.message, /S3 GetObject failed: HTTP 503 SlowDown/);
    assert.doesNotMatch(error.message, new RegExp(SECRET_ACCESS_KEY));

    const wrongSecret = s3Store(s3, { stagingDir, credentials: { accessKeyId: ACCESS_KEY_ID, secretAccessKey: "wrong-secret" } });
    const before = s3.requests.length;
    await assert.rejects(wrongSecret.exists(staged.sha256), (caught: Error) => {
      assert.match(caught.message, /HTTP 403/);
      assert.doesNotMatch(caught.message, /wrong-secret/);
      return true;
    });
    assert.equal(s3.requests.length - before, 1, "a signature failure is not retried");
    const denied = await wrongSecret.stage(chunks([Buffer.from("denied")]));
    await assert.rejects(denied.commit(), /S3 PutObject failed: HTTP 403 SignatureDoesNotMatch/);
    assert.deepEqual(await readdir(stagingDir), [], "a failed commit still removes the staged file");

    s3.hang("HEAD");
    const slow = s3Store(s3, { stagingDir, timeoutMs: 50, maxAttempts: 2 });
    await assert.rejects(slow.exists(staged.sha256), /S3 HeadObject failed: timed out after 50 ms/);
    s3.hang(undefined);
  } finally {
    await s3.close();
    await rm(stagingDir, { recursive: true, force: true });
  }
});

test("createBlobStoreFromEnv selects local or s3 and fails fast on misconfiguration", async () => {
  const root = await mkdtemp(join(tmpdir(), "noma-s3-env-"));
  try {
    assert.equal(createBlobStoreFromEnv(root, {}).kind, "local-disk");
    assert.throws(() => createBlobStoreFromEnv(root, { NOMA_CLOUD_BLOB_STORE: "gcs" }), /must be "local" or "s3"/);
    assert.throws(() => createBlobStoreFromEnv(root, { NOMA_CLOUD_BLOB_STORE: "s3" }), /NOMA_CLOUD_S3_BUCKET/);
    assert.throws(() => createBlobStoreFromEnv(root, { NOMA_CLOUD_BLOB_STORE: "s3", NOMA_CLOUD_S3_BUCKET: "noma" }), /NOMA_CLOUD_S3_REGION/);
    assert.throws(
      () => createBlobStoreFromEnv(root, { NOMA_CLOUD_BLOB_STORE: "s3", NOMA_CLOUD_S3_BUCKET: "noma", NOMA_CLOUD_S3_REGION: "eu-central-1" }),
      /NOMA_CLOUD_S3_ACCESS_KEY_ID/,
    );
    const base = {
      NOMA_CLOUD_BLOB_STORE: "s3",
      NOMA_CLOUD_S3_BUCKET: "noma",
      NOMA_CLOUD_S3_REGION: "eu-central-1",
      AWS_ACCESS_KEY_ID: ACCESS_KEY_ID,
      AWS_SECRET_ACCESS_KEY: SECRET_ACCESS_KEY,
    };
    const fallback = createBlobStoreFromEnv(root, base);
    assert.ok(fallback instanceof S3BlobStore);
    assert.equal(fallback.urlFor("ab".repeat(32)).host, "noma.s3.eu-central-1.amazonaws.com");
    assert.doesNotMatch(JSON.stringify(fallback), new RegExp(SECRET_ACCESS_KEY));

    assert.throws(() => createBlobStoreFromEnv(root, { ...base, NOMA_CLOUD_S3_SSE: "rot13" }), /NOMA_CLOUD_S3_SSE/);
    assert.throws(() => createBlobStoreFromEnv(root, { ...base, NOMA_CLOUD_S3_KMS_KEY_ID: "k" }), /NOMA_CLOUD_S3_KMS_KEY_ID requires/);
    assert.throws(() => createBlobStoreFromEnv(root, { ...base, NOMA_CLOUD_S3_BUCKET: "No_Such" }), (error: Error) => {
      assert.match(error.message, /misconfigured: Invalid S3 bucket name/);
      assert.doesNotMatch(error.message, new RegExp(SECRET_ACCESS_KEY));
      return true;
    });

    await writeFile(join(root, "key-id"), `${ACCESS_KEY_ID}\n`);
    await writeFile(join(root, "secret"), `${SECRET_ACCESS_KEY}\n`);
    await writeFile(join(root, "empty"), "\n");
    const fromFiles = createBlobStoreFromEnv(root, {
      NOMA_CLOUD_BLOB_STORE: "s3",
      NOMA_CLOUD_S3_BUCKET: "noma",
      NOMA_CLOUD_S3_ENDPOINT: "http://127.0.0.1:9000",
      NOMA_CLOUD_S3_PREFIX: "wiki",
      NOMA_CLOUD_S3_ACCESS_KEY_ID_FILE: join(root, "key-id"),
      NOMA_CLOUD_S3_SECRET_ACCESS_KEY_FILE: join(root, "secret"),
      NOMA_CLOUD_S3_SSE: "aws:kms",
      NOMA_CLOUD_S3_KMS_KEY_ID: "alias/noma",
    });
    assert.ok(fromFiles instanceof S3BlobStore);
    assert.equal(fromFiles.region, "us-east-1");
    assert.equal(fromFiles.urlFor("ab".repeat(32)).href, `http://127.0.0.1:9000/noma/wiki/blobs/ab/ab/${"ab".repeat(32)}`);
    const virtual = createBlobStoreFromEnv(root, { ...base, NOMA_CLOUD_S3_ENDPOINT: "https://fsn1.your-objectstorage.com", NOMA_CLOUD_S3_FORCE_PATH_STYLE: "false" });
    assert.ok(virtual instanceof S3BlobStore);
    assert.equal(virtual.urlFor("ab".repeat(32)).host, "noma.fsn1.your-objectstorage.com");
    assert.throws(
      () => createBlobStoreFromEnv(root, { ...base, AWS_SECRET_ACCESS_KEY: undefined, NOMA_CLOUD_S3_SECRET_ACCESS_KEY_FILE: join(root, "empty") }),
      /NOMA_CLOUD_S3_SECRET_ACCESS_KEY_FILE points to an empty file/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Noma Cloud uploads (raw and multipart) and downloads attachments through the S3 driver", async () => {
  const s3 = await startFakeS3();
  const root = await mkdtemp(join(tmpdir(), "noma-s3-cloud-"));
  const publicDir = join(root, "public");
  await mkdir(publicDir, { recursive: true });
  await writeFile(join(publicDir, "index.html"), "<h1>Noma</h1>", "utf8");
  const server = createNomaCloudServer({
    dataDir: join(root, "data", "documents"),
    usersDir: join(root, "data", "users"),
    sitesDir: join(root, "data", "sites"),
    dbPath: join(root, "data", "noma-cloud.sqlite"),
    publicDir,
    rateLimitMaxRequests: 10_000,
    queueIntervalMs: 0,
    blobStore: s3Store(s3, { stagingDir: join(root, "staging"), prefix: "wiki/" }),
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;
  try {
    const user = (await (await fetch(`${base}/api/users`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ name: "Alice" }) })).json()) as { token: string };
    const auth = { authorization: `Bearer ${user.token}` };
    const page = (await (
      await fetch(`${base}/api/documents`, { method: "POST", headers: { ...auth, "content-type": "application/json" }, body: JSON.stringify({ title: "S3", source: "# S3\n\nBody.\n" }) })
    ).json()) as { id: string };

    const raw = await fetch(`${base}/api/documents/${page.id}/attachments`, {
      method: "POST",
      headers: { ...auth, "content-type": "image/png", "x-filename": "chart.png" },
      body: PNG,
    });
    assert.equal(raw.status, 201);
    const rawBody = (await raw.json()) as { id: string; sha256: string; contentType: string };
    assert.equal(rawBody.contentType, "image/png");
    const key = `/noma-blobs/wiki/blobs/${rawBody.sha256.slice(0, 2)}/${rawBody.sha256.slice(2, 4)}/${rawBody.sha256}`;
    assert.deepEqual(s3.objects.get(key), PNG);

    const form = new FormData();
    form.append("filename", "Quarterly report.pdf");
    const pdf = Buffer.from("%PDF-1.4\n1 0 obj << /Type /Catalog >> endobj\n%%EOF\n", "latin1");
    form.append("file", new Blob([pdf], { type: "application/pdf" }), "upload.bin");
    const multipart = await fetch(`${base}/api/documents/${page.id}/attachments`, { method: "POST", headers: auth, body: form });
    assert.equal(multipart.status, 201, await multipart.clone().text());
    const multipartBody = (await multipart.json()) as { id: string; filename: string; contentType: string; sha256: string };
    assert.equal(multipartBody.filename, "Quarterly report.pdf");
    assert.equal(multipartBody.contentType, "application/pdf");
    assert.equal(multipartBody.sha256, sha256(pdf));
    assert.equal(s3.objects.size, 2);

    const download = await fetch(`${base}/api/attachments/${rawBody.id}`, { headers: auth });
    assert.equal(download.status, 200);
    assert.equal(download.headers.get("content-length"), String(PNG.byteLength));
    assert.deepEqual(Buffer.from(await download.arrayBuffer()), PNG);
    const pdfDownload = await fetch(`${base}/api/attachments/${multipartBody.id}`, { headers: auth });
    assert.deepEqual(Buffer.from(await pdfDownload.arrayBuffer()), pdf);
    const head = await fetch(`${base}/api/attachments/${rawBody.id}`, { method: "HEAD", headers: auth });
    assert.equal(head.status, 200);
    assert.equal(head.headers.get("content-length"), String(PNG.byteLength));

    s3.objects.delete(key);
    assert.equal((await fetch(`${base}/api/attachments/${rawBody.id}`, { headers: auth })).status, 404);
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    await s3.close();
    await rm(root, { recursive: true, force: true });
  }
});

function s3Store(s3: FakeS3, options: Partial<S3BlobStoreOptions> = {}): S3BlobStore {
  return new S3BlobStore({
    bucket: "noma-blobs",
    region: "eu-central-1",
    endpoint: s3.endpoint,
    forcePathStyle: true,
    credentials: { accessKeyId: ACCESS_KEY_ID, secretAccessKey: SECRET_ACCESS_KEY },
    retryBaseDelayMs: 1,
    ...options,
  });
}

async function startFakeS3(): Promise<FakeS3> {
  const objects = new Map<string, Buffer>();
  const requests: RecordedRequest[] = [];
  const failures = new Map<string, number>();
  let hangMethod: string | undefined;
  const hanging = new Set<ServerResponse>();
  const server: Server = createServer((req, res) => {
    void handle(req, res).catch((error: unknown) => {
      res.statusCode = 500;
      res.end(String(error));
    });
  });
  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const method = req.method ?? "GET";
    const path = new URL(req.url ?? "/", "http://fake").pathname;
    const body = await readStream(req);
    requests.push({ method, path, headers: req.headers });
    if (hangMethod === method) {
      hanging.add(res);
      return;
    }
    const pendingFailures = failures.get(method) ?? 0;
    if (pendingFailures > 0) {
      failures.set(method, pendingFailures - 1);
      return s3Error(res, method, 503, "SlowDown");
    }
    if (!verifySignature(req, path)) return s3Error(res, method, 403, "SignatureDoesNotMatch");
    if (method === "PUT") {
      if (sha256(body) !== req.headers["x-amz-content-sha256"]) return s3Error(res, method, 400, "XAmzContentSHA256Mismatch");
      if (Number(req.headers["content-length"]) !== body.byteLength) return s3Error(res, method, 400, "IncompleteBody");
      objects.set(path, body);
      res.writeHead(200, { etag: `"${createHash("md5").update(body).digest("hex")}"` }).end();
      return;
    }
    const stored = objects.get(path);
    if (method === "DELETE") {
      objects.delete(path);
      res.writeHead(204).end();
      return;
    }
    if (!stored) return s3Error(res, method, 404, "NoSuchKey");
    res.writeHead(200, { "content-length": String(stored.byteLength), "content-type": "application/octet-stream" });
    res.end(method === "HEAD" ? undefined : stored);
  }
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return {
    endpoint: `http://127.0.0.1:${address.port}`,
    objects,
    requests,
    failNext: (method, count) => failures.set(method, count),
    hang: (method) => {
      hangMethod = method;
      if (!method) for (const res of hanging) res.destroy();
    },
    close: async () => {
      for (const res of hanging) res.destroy();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

function s3Error(res: ServerResponse, method: string, status: number, code: string): void {
  res.writeHead(status, { "content-type": "application/xml" });
  res.end(method === "HEAD" ? undefined : `<?xml version="1.0" encoding="UTF-8"?><Error><Code>${code}</Code><Message>fake</Message></Error>`);
}

/** Independent SigV4 check: rebuilds the canonical request from what arrived on the wire. */
function verifySignature(req: IncomingMessage, path: string): boolean {
  const match = /^AWS4-HMAC-SHA256 Credential=([^/]+)\/(\d{8})\/([^/]+)\/s3\/aws4_request, SignedHeaders=([a-z0-9;-]+), Signature=([a-f0-9]{64})$/.exec(
    String(req.headers.authorization ?? ""),
  );
  if (!match) return false;
  const [, accessKeyId, date, region, signedHeaders, signature] = match as unknown as [string, string, string, string, string, string];
  if (accessKeyId !== ACCESS_KEY_ID) return false;
  const amzDate = String(req.headers["x-amz-date"] ?? "");
  if (!amzDate.startsWith(date)) return false;
  const names = signedHeaders.split(";");
  if (!names.includes("host") || !names.includes("x-amz-content-sha256") || !names.includes("x-amz-date")) return false;
  if (req.headers["x-amz-security-token"] !== undefined && !names.includes("x-amz-security-token")) return false;
  const canonicalHeaders = names.map((name) => `${name}:${String(req.headers[name] ?? "").trim()}\n`).join("");
  const canonicalRequest = [req.method, path, "", canonicalHeaders, signedHeaders, String(req.headers["x-amz-content-sha256"])].join("\n");
  const scope = `${date}/${region}/s3/aws4_request`;
  const stringToSign = `AWS4-HMAC-SHA256\n${amzDate}\n${scope}\n${sha256(Buffer.from(canonicalRequest))}`;
  let key: Buffer = hmac(`AWS4${SECRET_ACCESS_KEY}`, date);
  for (const part of [region, "s3", "aws4_request"]) key = hmac(key, part);
  return hmac(key, stringToSign).toString("hex") === signature;
}

function hmac(key: string | Buffer, value: string): Buffer {
  return createHmac("sha256", key).update(value).digest();
}

async function* chunks(parts: Buffer[]): AsyncGenerator<Uint8Array> {
  for (const part of parts) yield part;
}

async function readStream(stream: AsyncIterable<unknown>): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const chunk of stream) parts.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
  return Buffer.concat(parts);
}

function sha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}
