/**
 * Content-addressed blob storage for Noma Cloud attachments. Blobs are keyed by the SHA-256 of their
 * bytes, so identical uploads share one stored object. Writes are two-phase: `stage` streams bytes to
 * a private temp file while hashing, the caller inspects the result (size, magic bytes, quota), and
 * then either `commit`s or `discard`s.
 *
 * Two drivers ship:
 * - `LocalDiskBlobStore` lays blobs out as `<root>/blobs/ab/cd/<sha256>`; `commit` is an atomic rename.
 * - `S3BlobStore` talks to any S3-compatible service (AWS S3, MinIO, Cloudflare R2, Hetzner Object
 *   Storage) with dependency-free AWS Signature V4 over global `fetch`. `stage` stays local (hash
 *   before upload), `commit` is a `PutObject` keyed by the hash (skipped when the object already
 *   exists), `get` a streaming `GetObject`, `exists` a `HeadObject`, and `delete` a `DeleteObject`.
 *   Keys are `<prefix>blobs/ab/cd/<sha256>`, the same layout as on disk.
 */
import { createHash, createHmac, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, open, rename, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import type { ReadableStream as WebReadableStream } from "node:stream/web";

const SHA256_RE = /^[a-f0-9]{64}$/;

/** Bytes kept from the start of a staged blob for content sniffing. */
export const BLOB_HEAD_BYTES = 4096;

export interface StagedBlob {
  sha256: string;
  size: number;
  /** The first `BLOB_HEAD_BYTES` bytes, for magic-byte sniffing before the blob is committed. */
  head: Buffer;
  /** Moves the staged bytes to their content address. Idempotent when the blob already exists. */
  commit(): Promise<void>;
  /** Removes the staged bytes without storing them. */
  discard(): Promise<void>;
}

export interface StoredBlob {
  size: number;
  stream: Readable;
}

export interface BlobStore {
  readonly kind: string;
  stage(source: AsyncIterable<Uint8Array>): Promise<StagedBlob>;
  get(sha256: string): Promise<StoredBlob | undefined>;
  exists(sha256: string): Promise<boolean>;
  delete(sha256: string): Promise<void>;
}

export class LocalDiskBlobStore implements BlobStore {
  readonly kind = "local-disk";
  private readonly blobRoot: string;
  private readonly tempRoot: string;

  constructor(storageRoot: string) {
    this.blobRoot = join(storageRoot, "blobs");
    this.tempRoot = join(this.blobRoot, "tmp");
  }

  async stage(source: AsyncIterable<Uint8Array>): Promise<StagedBlob> {
    const { tempPath, sha256, size, head } = await stageToTempFile(this.tempRoot, source);
    const finalPath = this.pathFor(sha256);
    let settled = false;
    return {
      sha256,
      size,
      head,
      commit: async () => {
        if (settled) return;
        settled = true;
        if (await this.exists(sha256)) {
          await rm(tempPath, { force: true });
          return;
        }
        await mkdir(join(finalPath, ".."), { recursive: true, mode: 0o700 });
        await rename(tempPath, finalPath);
      },
      discard: async () => {
        if (settled) return;
        settled = true;
        await rm(tempPath, { force: true });
      },
    };
  }

  async get(sha256: string): Promise<StoredBlob | undefined> {
    const path = this.pathFor(sha256);
    try {
      const info = await stat(path);
      if (!info.isFile()) return undefined;
      return { size: info.size, stream: createReadStream(path) };
    } catch {
      return undefined;
    }
  }

  async exists(sha256: string): Promise<boolean> {
    try {
      return (await stat(this.pathFor(sha256))).isFile();
    } catch {
      return false;
    }
  }

  async delete(sha256: string): Promise<void> {
    await rm(this.pathFor(sha256), { force: true });
  }

  private pathFor(sha256: string): string {
    if (!SHA256_RE.test(sha256)) throw new Error("Blob key must be a lowercase SHA-256 hash");
    return join(this.blobRoot, sha256.slice(0, 2), sha256.slice(2, 4), sha256);
  }
}

/** Reads a whole stored blob into memory; callers bound `maxBytes` before calling. */
export async function readBlobBuffer(store: BlobStore, sha256: string, maxBytes: number): Promise<Buffer | undefined> {
  const blob = await store.get(sha256);
  if (!blob) return undefined;
  if (blob.size > maxBytes) {
    blob.stream.destroy();
    throw new Error("Blob exceeds the read limit");
  }
  const chunks: Buffer[] = [];
  for await (const chunk of blob.stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
  return Buffer.concat(chunks);
}

interface TempFileBlob {
  tempPath: string;
  sha256: string;
  size: number;
  head: Buffer;
}

/** Streams `source` into a private temp file under `tempRoot` while hashing it. */
async function stageToTempFile(tempRoot: string, source: AsyncIterable<Uint8Array>): Promise<TempFileBlob> {
  await mkdir(tempRoot, { recursive: true, mode: 0o700 });
  const tempPath = join(tempRoot, `${randomUUID()}.part`);
  const hash = createHash("sha256");
  const headChunks: Buffer[] = [];
  let headSize = 0;
  let size = 0;
  const output = createWriteStream(tempPath, { flags: "wx", mode: 0o600 });
  const closed = new Promise<void>((resolve, reject) => {
    output.once("close", resolve);
    output.once("error", reject);
  });
  try {
    for await (const chunk of source) {
      const buffer = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
      hash.update(buffer);
      size += buffer.byteLength;
      if (headSize < BLOB_HEAD_BYTES) {
        const slice = buffer.subarray(0, BLOB_HEAD_BYTES - headSize);
        headChunks.push(Buffer.from(slice));
        headSize += slice.byteLength;
      }
      if (!output.write(buffer)) await new Promise<void>((resolve) => output.once("drain", resolve));
    }
    output.end();
    await closed;
    const handle = await open(tempPath, "r");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  } catch (error) {
    output.destroy();
    await closed.catch(() => undefined);
    await rm(tempPath, { force: true });
    throw error;
  }
  return { tempPath, sha256: hash.digest("hex"), size, head: Buffer.concat(headChunks) };
}

/** Static AWS-style credentials. They are never logged or included in error messages. */
export interface S3Credentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

export type S3ServerSideEncryption = "AES256" | "aws:kms";

export interface S3BlobStoreOptions {
  bucket: string;
  region: string;
  /** Custom endpoint for S3-compatible services, e.g. `https://fsn1.your-objectstorage.com` or `http://127.0.0.1:9000`. */
  endpoint?: string;
  /**
   * Path-style (`<endpoint>/<bucket>/<key>`) instead of virtual-hosted (`<bucket>.<host>/<key>`)
   * addressing. Defaults to `true` with a custom endpoint and `false` for AWS.
   */
  forcePathStyle?: boolean;
  /** Key prefix such as `noma/prod/`; a trailing `/` is added when missing. */
  prefix?: string;
  /** Static credentials, or a provider called before each request (rotating or role credentials). */
  credentials: S3Credentials | (() => S3Credentials | Promise<S3Credentials>);
  /** Server-side encryption requested on every `PutObject`. */
  serverSideEncryption?: S3ServerSideEncryption;
  /** KMS key ID or ARN for `aws:kms`; the bucket's default key is used when omitted. */
  kmsKeyId?: string;
  /** Local directory for staged uploads while they are hashed and sniffed (default: OS temp dir). */
  stagingDir?: string;
  /** Per-attempt timeout in ms (default 30 000). For `GetObject` it bounds the wait for response headers. */
  timeoutMs?: number;
  /** Total attempts for retryable failures: 5xx, 429, throttling codes, timeouts, network errors (default 3). */
  maxAttempts?: number;
  /** Base delay for exponential backoff with full jitter, in ms (default 100). */
  retryBaseDelayMs?: number;
  /** Replaces global `fetch` (tests, custom agents). */
  fetch?: typeof fetch;
  now?: () => Date;
}

const S3_BUCKET_RE = /^[a-z0-9][a-z0-9.-]{1,61}[a-z0-9]$/;
const S3_REGION_RE = /^[a-z0-9-]{1,64}$/;
const EMPTY_PAYLOAD_SHA256 = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
const RETRYABLE_S3_CODES = new Set([
  "SlowDown",
  "Throttling",
  "ThrottlingException",
  "RequestTimeout",
  "RequestTimeTooSkewed",
  "InternalError",
  "ServiceUnavailable",
]);

/** The object key for a blob: `<prefix>blobs/ab/cd/<sha256>`. */
export function s3BlobKey(prefix: string, sha256: string): string {
  if (!SHA256_RE.test(sha256)) throw new Error("Blob key must be a lowercase SHA-256 hash");
  return `${normalizeS3Prefix(prefix)}blobs/${sha256.slice(0, 2)}/${sha256.slice(2, 4)}/${sha256}`;
}

/** The request URL for `key`, honoring the custom endpoint and the addressing style. */
export function s3ObjectUrl(options: Pick<S3BlobStoreOptions, "bucket" | "region" | "endpoint" | "forcePathStyle">, key: string): URL {
  const endpoint = new URL(options.endpoint ?? `https://s3.${options.region}.amazonaws.com`);
  const pathStyle = options.forcePathStyle ?? options.endpoint !== undefined;
  const basePath = endpoint.pathname.replace(/\/+$/, "");
  const encodedKey = key.split("/").map(encodeRfc3986).join("/");
  const url = new URL(endpoint.origin);
  if (pathStyle) {
    url.pathname = `${basePath}/${encodeRfc3986(options.bucket)}/${encodedKey}`;
  } else {
    url.hostname = `${options.bucket}.${endpoint.hostname}`;
    url.pathname = `${basePath}/${encodedKey}`;
  }
  return url;
}

function normalizeS3Prefix(prefix: string): string {
  const trimmed = prefix.replace(/^\/+/, "");
  if (!trimmed) return "";
  if (/[\u0000-\u001f\u007f\\]/.test(trimmed)) throw new Error("S3 key prefix contains invalid characters");
  if (trimmed.split("/").some((segment) => segment === "." || segment === "..")) throw new Error("S3 key prefix must not contain . or .. segments");
  return trimmed.endsWith("/") ? trimmed : `${trimmed}/`;
}

function encodeRfc3986(value: string): string {
  return encodeURIComponent(value).replace(/[!'()*]/g, (char) => `%${char.charCodeAt(0).toString(16).toUpperCase()}`);
}

/** A failed S3 call. The message carries the operation, HTTP status, and S3 error code only. */
export class S3RequestError extends Error {
  constructor(
    message: string,
    readonly status: number | undefined,
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = "S3RequestError";
  }
}

interface S3Request {
  operation: string;
  method: "GET" | "HEAD" | "PUT" | "DELETE";
  key: string;
  payloadSha256?: string;
  headers?: Record<string, string>;
  body?: () => Readable;
  /** Leaves the response body open for the caller (GetObject). */
  streamResponse?: boolean;
  okStatuses: number[];
}

/**
 * S3-compatible `BlobStore` with dependency-free SigV4 signing. Uploads are hashed while staging, so
 * `PutObject` signs `x-amz-content-sha256: <sha256>`: the content hash is both the object key and the
 * signed payload hash, and the service rejects a body that does not match it.
 */
export class S3BlobStore implements BlobStore {
  readonly kind = "s3";
  readonly bucket: string;
  readonly region: string;
  readonly prefix: string;
  readonly #options: S3BlobStoreOptions;
  readonly #stagingDir: string;
  readonly #fetch: typeof fetch;
  readonly #now: () => Date;
  readonly #timeoutMs: number;
  readonly #maxAttempts: number;
  readonly #retryBaseDelayMs: number;

  constructor(options: S3BlobStoreOptions) {
    if (!S3_BUCKET_RE.test(options.bucket) || options.bucket.includes("..")) throw new Error(`Invalid S3 bucket name: ${JSON.stringify(options.bucket)}`);
    if (!S3_REGION_RE.test(options.region)) throw new Error(`Invalid S3 region: ${JSON.stringify(options.region)}`);
    if (options.endpoint !== undefined) validateS3Endpoint(options.endpoint);
    if (options.serverSideEncryption !== undefined && options.serverSideEncryption !== "AES256" && options.serverSideEncryption !== "aws:kms") {
      throw new Error('S3 server-side encryption must be "AES256" or "aws:kms"');
    }
    if (options.kmsKeyId && options.serverSideEncryption !== "aws:kms") throw new Error('An S3 KMS key ID requires server-side encryption "aws:kms"');
    if (typeof options.credentials !== "function") validateS3Credentials(options.credentials);
    const timeoutMs = options.timeoutMs ?? 30_000;
    if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error("S3 timeoutMs must be a positive number");
    this.bucket = options.bucket;
    this.region = options.region;
    this.prefix = normalizeS3Prefix(options.prefix ?? "");
    this.#options = { ...options };
    this.#stagingDir = options.stagingDir ?? join(tmpdir(), "noma-cloud-blob-staging");
    this.#fetch = options.fetch ?? globalThis.fetch.bind(globalThis);
    this.#now = options.now ?? (() => new Date());
    this.#timeoutMs = timeoutMs;
    this.#maxAttempts = Math.max(1, Math.floor(options.maxAttempts ?? 3));
    this.#retryBaseDelayMs = Math.max(0, options.retryBaseDelayMs ?? 100);
  }

  /** The object URL for a blob, without credentials (diagnostics and tests). */
  urlFor(sha256: string): URL {
    return s3ObjectUrl(this.#options, s3BlobKey(this.prefix, sha256));
  }

  async stage(source: AsyncIterable<Uint8Array>): Promise<StagedBlob> {
    const { tempPath, sha256, size, head } = await stageToTempFile(this.#stagingDir, source);
    let settled = false;
    return {
      sha256,
      size,
      head,
      commit: async () => {
        if (settled) return;
        settled = true;
        try {
          if ((await this.headObject(sha256)) === 200) return;
          await this.putObject(sha256, tempPath, size);
        } finally {
          await rm(tempPath, { force: true });
        }
      },
      discard: async () => {
        if (settled) return;
        settled = true;
        await rm(tempPath, { force: true });
      },
    };
  }

  async get(sha256: string): Promise<StoredBlob | undefined> {
    const response = await this.send({
      operation: "GetObject",
      method: "GET",
      key: s3BlobKey(this.prefix, sha256),
      headers: { "accept-encoding": "identity" },
      streamResponse: true,
      okStatuses: [200, 404],
    });
    if (response.status === 404 || !response.body) {
      await response.body?.cancel().catch(() => undefined);
      return undefined;
    }
    const size = Number(response.headers.get("content-length"));
    const stream = Readable.fromWeb(response.body as unknown as WebReadableStream<Uint8Array>);
    if (!Number.isSafeInteger(size) || size < 0) {
      stream.destroy();
      throw new S3RequestError("S3 GetObject failed: response has no valid content-length", response.status, false);
    }
    return { size, stream };
  }

  async exists(sha256: string): Promise<boolean> {
    const status = await this.headObject(sha256);
    if (status === 403) throw new S3RequestError("S3 HeadObject failed: HTTP 403 (grant s3:GetObject and s3:ListBucket)", 403, false);
    return status === 200;
  }

  async delete(sha256: string): Promise<void> {
    await this.send({ operation: "DeleteObject", method: "DELETE", key: s3BlobKey(this.prefix, sha256), okStatuses: [200, 204, 404] });
  }

  /** S3 answers HEAD on a missing key with 403 when the caller lacks `s3:ListBucket`; commit then just uploads. */
  private async headObject(sha256: string): Promise<number> {
    const response = await this.send({ operation: "HeadObject", method: "HEAD", key: s3BlobKey(this.prefix, sha256), okStatuses: [200, 403, 404] });
    return response.status;
  }

  private async putObject(sha256: string, path: string, size: number): Promise<void> {
    const headers: Record<string, string> = { "content-length": String(size), "content-type": "application/octet-stream" };
    const sse = this.#options.serverSideEncryption;
    if (sse) headers["x-amz-server-side-encryption"] = sse;
    if (sse === "aws:kms" && this.#options.kmsKeyId) headers["x-amz-server-side-encryption-aws-kms-key-id"] = this.#options.kmsKeyId;
    await this.send({
      operation: "PutObject",
      method: "PUT",
      key: s3BlobKey(this.prefix, sha256),
      payloadSha256: sha256,
      headers,
      body: () => createReadStream(path),
      okStatuses: [200],
    });
  }

  private async send(request: S3Request): Promise<Response> {
    let lastError: S3RequestError | undefined;
    for (let attempt = 1; attempt <= this.#maxAttempts; attempt++) {
      if (attempt > 1) await delay(Math.random() * this.#retryBaseDelayMs * 2 ** (attempt - 1));
      try {
        return await this.attempt(request);
      } catch (error) {
        lastError = error instanceof S3RequestError ? error : new S3RequestError(`S3 ${request.operation} failed: ${errorMessage(error)}`, undefined, true);
        if (!lastError.retryable) throw lastError;
      }
    }
    throw lastError ?? new S3RequestError(`S3 ${request.operation} failed`, undefined, false);
  }

  private async attempt(request: S3Request): Promise<Response> {
    const url = s3ObjectUrl(this.#options, request.key);
    const credentials = typeof this.#options.credentials === "function" ? await this.#options.credentials() : this.#options.credentials;
    validateS3Credentials(credentials);
    const headers = signS3Request({
      method: request.method,
      url,
      region: this.region,
      headers: request.headers ?? {},
      payloadSha256: request.payloadSha256 ?? EMPTY_PAYLOAD_SHA256,
      credentials,
      now: this.#now(),
    });
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error(`timed out after ${this.#timeoutMs} ms`)), this.#timeoutMs);
    let body: Readable | undefined;
    try {
      body = request.body?.();
      const init: RequestInit & { duplex?: "half" } = { method: request.method, headers, signal: controller.signal, redirect: "manual" };
      if (body) {
        init.body = Readable.toWeb(body) as unknown as ReadableStream<Uint8Array>;
        init.duplex = "half";
      }
      const response = await this.#fetch(url, init);
      if (request.okStatuses.includes(response.status)) {
        if (!request.streamResponse && request.method !== "HEAD") await response.arrayBuffer();
        return response;
      }
      const text = request.method === "HEAD" ? "" : await response.text().catch(() => "");
      throw responseError(request.operation, response.status, text);
    } catch (error) {
      if (error instanceof S3RequestError) throw error;
      const reason = controller.signal.aborted ? errorMessage(controller.signal.reason) : errorMessage(error);
      throw new S3RequestError(`S3 ${request.operation} failed: ${reason}`, undefined, true);
    } finally {
      clearTimeout(timer);
      body?.destroy();
    }
  }
}

function validateS3Endpoint(value: string): void {
  let endpoint: URL;
  try {
    endpoint = new URL(value);
  } catch {
    throw new Error("S3 endpoint must be an absolute http(s) URL");
  }
  if (endpoint.protocol !== "https:" && endpoint.protocol !== "http:") throw new Error("S3 endpoint must be an absolute http(s) URL");
  if (endpoint.username || endpoint.password || endpoint.search || endpoint.hash) throw new Error("S3 endpoint must not carry credentials, a query, or a fragment");
}

function validateS3Credentials(credentials: S3Credentials | undefined): void {
  if (!credentials?.accessKeyId?.trim() || !credentials.secretAccessKey?.trim()) throw new Error("S3 credentials need an access key ID and a secret access key");
}

function responseError(operation: string, status: number, body: string): S3RequestError {
  const code = /<Code>([A-Za-z0-9.]{1,100})<\/Code>/.exec(body)?.[1];
  const retryable = status >= 500 || status === 429 || (code !== undefined && RETRYABLE_S3_CODES.has(code));
  return new S3RequestError(`S3 ${operation} failed: HTTP ${status}${code ? ` ${code}` : ""}`, status, retryable);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface SignS3RequestInput {
  method: string;
  url: URL;
  region: string;
  headers: Record<string, string>;
  /** Hex SHA-256 of the body, or `UNSIGNED-PAYLOAD`. */
  payloadSha256: string;
  credentials: S3Credentials;
  now: Date;
  service?: string;
}

const UNSIGNED_HEADERS = new Set(["authorization", "connection", "expect", "keep-alive", "te", "trailer", "transfer-encoding", "upgrade", "user-agent"]);

/**
 * AWS Signature Version 4 (header auth) for one request; every input header except hop-by-hop ones
 * is signed. Returns the headers to send: the input headers plus `x-amz-date`,
 * `x-amz-content-sha256`, `x-amz-security-token`, and `authorization`. `host` is signed but left for
 * the HTTP client to send.
 */
export function signS3Request(input: SignS3RequestInput): Record<string, string> {
  const service = input.service ?? "s3";
  const amzDate = input.now.toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
  const dateStamp = amzDate.slice(0, 8);
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(input.headers)) headers[name.toLowerCase()] = value;
  headers["x-amz-date"] = amzDate;
  headers["x-amz-content-sha256"] = input.payloadSha256;
  if (input.credentials.sessionToken) headers["x-amz-security-token"] = input.credentials.sessionToken;
  const signed: Record<string, string> = { host: input.url.host };
  for (const [name, value] of Object.entries(headers)) {
    if (!UNSIGNED_HEADERS.has(name)) signed[name] = value;
  }
  const signedNames = Object.keys(signed).sort();
  const canonicalHeaders = signedNames.map((name) => `${name}:${(signed[name] ?? "").trim().replace(/\s+/g, " ")}\n`).join("");
  const signedHeaders = signedNames.join(";");
  const canonicalQuery = [...input.url.searchParams.entries()]
    .map(([key, value]) => `${encodeRfc3986(key)}=${encodeRfc3986(value)}`)
    .sort()
    .join("&");
  const canonicalRequest = [input.method, input.url.pathname, canonicalQuery, canonicalHeaders, signedHeaders, input.payloadSha256].join("\n");
  const scope = `${dateStamp}/${input.region}/${service}/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", amzDate, scope, createHash("sha256").update(canonicalRequest).digest("hex")].join("\n");
  const dateKey = createHmac("sha256", `AWS4${input.credentials.secretAccessKey}`).update(dateStamp).digest();
  const regionKey = createHmac("sha256", dateKey).update(input.region).digest();
  const serviceKey = createHmac("sha256", regionKey).update(service).digest();
  const signingKey = createHmac("sha256", serviceKey).update("aws4_request").digest();
  const signature = createHmac("sha256", signingKey).update(stringToSign).digest("hex");
  headers.authorization = `AWS4-HMAC-SHA256 Credential=${input.credentials.accessKeyId}/${scope}, SignedHeaders=${signedHeaders}, Signature=${signature}`;
  return headers;
}
