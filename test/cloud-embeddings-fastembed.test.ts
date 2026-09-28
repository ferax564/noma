import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  createEmbeddingProviderFromEnv,
  DEFAULT_FASTEMBED_EMBEDDING_MODEL,
  EmbeddingError,
  embeddingLabel,
  embeddingPolicyBlock,
  FastembedEmbeddingProvider,
  retrievalTokens,
} from "../src/cloud-embeddings.js";
import type { CloudDocumentRecord } from "../src/cloud-db.js";
import { CloudKnowledgePlatform, type KnowledgeDocumentAccess } from "../src/cloud-platform.js";
import { sha256Hex } from "../src/hash.js";

const now = "2026-09-28T10:00:00.000Z";
const noSleep = async (): Promise<void> => undefined;

interface RecordedRequest {
  method: string;
  path: string;
  headers: IncomingMessage["headers"];
  body: Record<string, unknown>;
}

type Embed = (text: string) => number[];

/**
 * In-process stand-in for fastembed's `src/server.py`: `GET /health`, `POST /v1/embeddings` taking a
 * string or string list, answering `{object: "list", data: [{object, embedding, index}], model, usage}`
 * with the request's `model` echoed (default `fastcode-embed`), 503 while not ready, 400 on bad input.
 */
async function fakeFastembed(embed: Embed, options: { ready?: () => boolean; token?: string } = {}): Promise<{ url: string; requests: RecordedRequest[]; close: () => Promise<void> }> {
  const requests: RecordedRequest[] = [];
  const json = (res: import("node:http").ServerResponse, status: number, body: unknown): void => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      if (req.method === "GET" && req.url === "/health") return json(res, 200, { status: "ok" });
      let body: Record<string, unknown> = {};
      try {
        body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}") as Record<string, unknown>;
      } catch {
        return json(res, 400, { error: { message: "Invalid JSON body", type: "invalid_request_error" } });
      }
      requests.push({ method: req.method ?? "", path: req.url ?? "", headers: req.headers, body });
      if (options.token && req.headers.authorization !== `Bearer ${options.token}`) return json(res, 401, { error: { message: "unauthorized" } });
      if (req.method !== "POST" || req.url !== "/v1/embeddings") return json(res, 404, { error: { message: "Not found", type: "invalid_request_error" } });
      if (options.ready && !options.ready()) return json(res, 503, { error: { message: "Server is not ready", type: "server_error" } });
      const input = typeof body.input === "string" ? [body.input] : body.input;
      if (!Array.isArray(input) || input.length === 0) return json(res, 400, { error: { message: "'input' must be a string or list of strings", type: "invalid_request_error" } });
      json(res, 200, {
        object: "list",
        data: (input as string[]).map((text, index) => ({ object: "embedding", embedding: embed(text), index })),
        model: body.model ?? "fastcode-embed",
        usage: { prompt_tokens: 0, total_tokens: 0 },
      });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return {
    url: `http://127.0.0.1:${address.port}`,
    requests,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
}

const constant = (dimensions: number): Embed => (text) => Array.from({ length: dimensions }, (_, slot) => (text.length + slot) / 100);

test("fastembed provider speaks the OpenAI wire format keyless, batches by 32, and discovers dimensions", async () => {
  const server = await fakeFastembed(constant(768));
  try {
    const provider = new FastembedEmbeddingProvider({ baseUrl: server.url, sleep: noSleep });
    assert.deepEqual([provider.id, provider.model, provider.dimensions, provider.remote, provider.zeroRetention], ["fastembed", DEFAULT_FASTEMBED_EMBEDDING_MODEL, undefined, true, true]);
    assert.equal(embeddingLabel(provider), "fastembed:fastcode-embed");
    const texts = Array.from({ length: 70 }, (_, index) => `block ${index}`);
    const vectors = await provider.embed(texts, { inputType: "document" });
    assert.equal(vectors.length, 70);
    assert.equal(vectors[0]!.length, 768);
    assert.equal(vectors[69]![0], "block 69".length / 100);
    assert.deepEqual(server.requests.map((request) => (request.body.input as string[]).length), [32, 32, 6]);
    const first = server.requests[0]!;
    assert.equal(first.method, "POST");
    assert.equal(first.path, "/v1/embeddings");
    assert.equal(first.headers.authorization, undefined, "no bearer without a key");
    assert.deepEqual(Object.keys(first.body).sort(), ["encoding_format", "input", "model"]);
    assert.equal(first.body.model, "fastcode-embed");
  } finally {
    await server.close();
  }
});

test("fastembed provider sends the optional bearer, never sends dimensions, and checks a configured length", async () => {
  const server = await fakeFastembed(constant(384), { token: "gate-token" });
  try {
    const gated = new FastembedEmbeddingProvider({ baseUrl: `${server.url}/v1`, apiKey: "gate-token", model: "bge-small-en-v1.5", dimensions: 384, sleep: noSleep });
    assert.equal((await gated.embed(["hello"]))[0]!.length, 384);
    assert.equal(server.requests[0]!.headers.authorization, "Bearer gate-token");
    assert.equal(server.requests[0]!.body.dimensions, undefined);
    assert.equal(server.requests[0]!.body.model, "bge-small-en-v1.5");

    const mismatched = new FastembedEmbeddingProvider({ baseUrl: server.url, apiKey: "gate-token", dimensions: 768, sleep: noSleep });
    await assert.rejects(mismatched.embed(["hello"]), (error: unknown) => error instanceof EmbeddingError && error.code === "dimension_mismatch");

    const unauthenticated = new FastembedEmbeddingProvider({ baseUrl: server.url, sleep: noSleep });
    await assert.rejects(unauthenticated.embed(["hello"]), (error: unknown) => error instanceof EmbeddingError && error.code === "auth");
  } finally {
    await server.close();
  }
});

test("fastembed provider retries a warming-up server and times out a hung one", async () => {
  let ready = false;
  const sleeps: number[] = [];
  const warming = await fakeFastembed(constant(8), { ready: () => ready });
  try {
    const provider = new FastembedEmbeddingProvider({
      baseUrl: warming.url,
      maxRetries: 1,
      sleep: async (ms) => {
        sleeps.push(ms);
        ready = true;
      },
    });
    assert.equal((await provider.embed(["one"]))[0]!.length, 8);
    assert.equal(warming.requests.length, 2);
    assert.deepEqual(sleeps, [500]);

    ready = false;
    const down = new FastembedEmbeddingProvider({ baseUrl: warming.url, maxRetries: 0, sleep: noSleep });
    await assert.rejects(down.embed(["one"]), (error: unknown) => error instanceof EmbeddingError && error.code === "server_error" && /not ready/.test(error.message));
  } finally {
    await warming.close();
  }

  const hung = createServer(() => undefined);
  await new Promise<void>((resolve) => hung.listen(0, "127.0.0.1", resolve));
  const address = hung.address();
  assert.ok(address && typeof address === "object");
  try {
    const provider = new FastembedEmbeddingProvider({ baseUrl: `http://127.0.0.1:${address.port}`, timeoutMs: 50, maxRetries: 0, sleep: noSleep });
    await assert.rejects(provider.embed(["one"]), (error: unknown) => error instanceof EmbeddingError && error.code === "timeout");
  } finally {
    hung.closeAllConnections();
    await new Promise<void>((resolve) => hung.close(() => resolve()));
  }
});

test("NOMA_CLOUD_EMBEDDINGS=fastembed requires a URL, keeps the key optional and defaults to zero retention", async () => {
  assert.throws(() => createEmbeddingProviderFromEnv({ NOMA_CLOUD_EMBEDDINGS: "fastembed" }), /fastembed needs NOMA_CLOUD_EMBEDDINGS_URL/);
  assert.throws(() => createEmbeddingProviderFromEnv({ NOMA_CLOUD_EMBEDDINGS: "fastembed", NOMA_CLOUD_EMBEDDINGS_API_KEY: "k" }), /NOMA_CLOUD_EMBEDDINGS_URL/);

  const keyless = createEmbeddingProviderFromEnv({ NOMA_CLOUD_EMBEDDINGS: "fastembed", NOMA_CLOUD_EMBEDDINGS_URL: "http://100.100.1.2:8090", OPENAI_API_KEY: "sk-must-not-leak" });
  assert.ok(keyless instanceof FastembedEmbeddingProvider);
  assert.deepEqual([keyless.id, keyless.model, keyless.dimensions, keyless.remote, keyless.zeroRetention], ["fastembed", "fastcode-embed", undefined, true, true]);

  const server = await fakeFastembed(constant(4));
  const root = await mkdtemp(join(tmpdir(), "noma-fastembed-env-"));
  try {
    await writeFile(join(root, "token"), "file-token\n", "utf8");
    const configured = createEmbeddingProviderFromEnv({
      NOMA_CLOUD_EMBEDDINGS: "FastEmbed",
      NOMA_CLOUD_EMBEDDINGS_URL: server.url,
      NOMA_CLOUD_EMBEDDINGS_MODEL: "jina-embeddings-v2-base-en",
      NOMA_CLOUD_EMBEDDINGS_API_KEY_FILE: join(root, "token"),
      NOMA_CLOUD_EMBEDDINGS_DIMENSIONS: "4",
      NOMA_CLOUD_EMBEDDINGS_BATCH_SIZE: "2",
      NOMA_CLOUD_EMBEDDINGS_ZERO_RETENTION: "false",
    });
    assert.deepEqual([configured.model, configured.dimensions, configured.zeroRetention], ["jina-embeddings-v2-base-en", 4, false]);
    await configured.embed(["a", "b", "c"]);
    assert.deepEqual(server.requests.map((request) => (request.body.input as string[]).length), [2, 1]);
    assert.equal(server.requests[0]!.headers.authorization, "Bearer file-token");
    assert.equal(server.requests[0]!.body.dimensions, undefined);
  } finally {
    await server.close();
    await rm(root, { recursive: true, force: true });
  }
  assert.equal(
    embeddingPolicyBlock({ modelAllowlist: [], requireZeroRetentionModels: true, updatedBy: "system" }, createEmbeddingProviderFromEnv({ NOMA_CLOUD_EMBEDDINGS: "fastembed", NOMA_CLOUD_EMBEDDINGS_URL: "http://fastembed:8080" })),
    undefined,
    "a self-hosted fastembed passes a zero-retention policy without extra attestation",
  );
});

const concepts: string[][] = [
  ["outage", "downtime", "incident", "failover", "disaster", "standby"],
  ["salary", "payroll", "compensation", "bonus"],
];

function conceptEmbedding(text: string): number[] {
  const vector = Array.from({ length: 12 }, () => 0);
  for (const token of retrievalTokens(text)) {
    const concept = concepts.findIndex((group) => group.some((word) => token.startsWith(word)));
    if (concept >= 0) vector[concept] = vector[concept]! + 4;
    else {
      const slot = 2 + (Number.parseInt(sha256Hex(token).slice(0, 8), 16) % 10);
      vector[slot] = vector[slot]! + 0.25;
    }
  }
  return vector;
}

function doc(id: string, source: string): CloudDocumentRecord {
  return {
    version: 2,
    id,
    title: id,
    source,
    hash: sha256Hex(source),
    createdAt: "2026-09-01T00:00:00.000Z",
    updatedAt: "2026-09-10T00:00:00.000Z",
    createdBy: "alice",
    updatedBy: "alice",
    permissions: { alice: { role: "owner", addedAt: "2026-09-01T00:00:00.000Z" } },
    shareLinks: [],
  };
}

test("knowledge search backfills through fastembed and falls back to lexical scoring when it goes away", async () => {
  const server = await fakeFastembed(conceptEmbedding);
  const root = await mkdtemp(join(tmpdir(), "noma-fastembed-platform-"));
  const documents: KnowledgeDocumentAccess[] = [
    doc("ops", `::decision{id="failover-plan" status="accepted"}\nFailover to the standby cluster after a disaster.\n::\n`),
    doc("office", `::note{id="playground-bookings"}\nOutdated downtown playground bookings.\n::\n`),
  ].map((document) => ({ document, role: "editor", via: "user" }));
  const request = { principalId: "alice", query: "outage downtime playbook", documents, now };
  const provider = new FastembedEmbeddingProvider({ baseUrl: server.url, maxRetries: 0, timeoutMs: 2_000, sleep: noSleep });
  const platform = new CloudKnowledgePlatform(join(root, "platform.sqlite"), { embeddings: provider, providerCooldownMs: 60_000 });
  let closed = false;
  try {
    platform.setEnterprisePolicy({ ...platform.enterprisePolicy(), requireZeroRetentionModels: true });
    platform.indexDocuments(documents, now);
    const backfill = await platform.backfillEmbeddings();
    assert.equal(backfill.provider, "fastembed:fastcode-embed");
    assert.ok(backfill.embedded > 0);
    assert.equal(backfill.skipped, undefined);
    const outcome = await platform.searchWithRetrieval(request);
    assert.equal(outcome.retrieval.semantic, "fastembed:fastcode-embed");
    assert.equal(outcome.results[0]?.blockId, "failover-plan");
    const status = platform.embeddingStatus();
    assert.deepEqual([status.provider, status.remote, status.zeroRetention, status.dimensions], ["fastembed:fastcode-embed", true, true, undefined]);

    await server.close();
    closed = true;
    const down = await platform.searchWithRetrieval({ ...request, query: "standby cluster" });
    assert.equal(down.retrieval.semantic, "local-hash");
    assert.equal(down.retrieval.fallback, "provider_unavailable");
    assert.equal(down.results[0]?.blockId, "failover-plan", "lexical scoring still answers");
  } finally {
    platform.close();
    if (!closed) await server.close();
    await rm(root, { recursive: true, force: true });
  }
});
