import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import DatabaseConstructor from "better-sqlite3";
import {
  createEmbeddingProviderFromEnv,
  EmbeddingError,
  type EmbeddingProvider,
  embeddingsEndpoint,
  FakeEmbeddingProvider,
  LocalHashEmbeddingProvider,
  localHashEmbedding,
  OpenAiCompatibleEmbeddingProvider,
  retrievalTokens,
  VoyageEmbeddingProvider,
} from "../src/cloud-embeddings.js";
import type { CloudDocumentRecord } from "../src/cloud-db.js";
import { CloudKnowledgePlatform, type CloudKnowledgePlatformOptions, type KnowledgeDocumentAccess } from "../src/cloud-platform.js";
import { createNomaCloudServer } from "../src/cloud-server.js";
import { sha256Hex } from "../src/hash.js";

const now = "2026-07-14T10:00:00.000Z";
const noSleep = async (): Promise<void> => undefined;

interface RecordedRequest {
  path: string;
  headers: IncomingMessage["headers"];
  body: Record<string, unknown>;
}

type Reply = { status: number; body: unknown; headers?: Record<string, string> };

async function fakeEmbeddingServer(reply: (request: RecordedRequest, index: number) => Reply): Promise<{ url: string; requests: RecordedRequest[]; close: () => Promise<void> }> {
  const requests: RecordedRequest[] = [];
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      const recorded = { path: req.url ?? "", headers: req.headers, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown> };
      requests.push(recorded);
      const response = reply(recorded, requests.length - 1);
      res.writeHead(response.status, { "content-type": "application/json", ...(response.headers ?? {}) });
      res.end(JSON.stringify(response.body));
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

function vectorsFor(input: unknown, dimensions: number): Array<{ object: string; index: number; embedding: number[] }> {
  const texts = input as string[];
  return texts.map((text, index) => ({ object: "embedding", index, embedding: Array.from({ length: dimensions }, (_, slot) => (text.length + slot) / 100) })).reverse();
}

test("OpenAI-compatible provider sends the documented request, batches inputs and orders vectors by index", async () => {
  const server = await fakeEmbeddingServer((request) => ({ status: 200, body: { object: "list", data: vectorsFor(request.body.input, 4), model: request.body.model } }));
  try {
    const provider = new OpenAiCompatibleEmbeddingProvider({ baseUrl: server.url, apiKey: "sk-test", model: "text-embedding-3-small", dimensions: 4, requestDimensions: true, maxBatchSize: 2, sleep: noSleep });
    const vectors = await provider.embed(["a", "bb", "ccc", "dddd", "eeeee"], { inputType: "document" });
    assert.equal(vectors.length, 5);
    assert.deepEqual(vectors.map((vector) => vector[0]), [0.01, 0.02, 0.03, 0.04, 0.05]);
    assert.equal(server.requests.length, 3);
    assert.deepEqual(server.requests.map((request) => (request.body.input as string[]).length), [2, 2, 1]);
    const first = server.requests[0]!;
    assert.equal(first.path, "/v1/embeddings");
    assert.equal(first.headers.authorization, "Bearer sk-test");
    assert.equal(first.headers["content-type"], "application/json");
    assert.deepEqual(first.body, { model: "text-embedding-3-small", input: ["a", "bb"], encoding_format: "float", dimensions: 4 });
    assert.equal(provider.remote, true);
    assert.equal(provider.id, "openai");
  } finally {
    await server.close();
  }
});

test("Voyage provider sends input_type and bearer auth to /v1/embeddings", async () => {
  const server = await fakeEmbeddingServer((request) => ({ status: 200, body: { object: "list", data: vectorsFor(request.body.input, 1024), model: "voyage-3.5", usage: { total_tokens: 3 } } }));
  try {
    const provider = new VoyageEmbeddingProvider({ baseUrl: server.url, apiKey: "pa-test", sleep: noSleep });
    assert.equal(provider.model, "voyage-3.5");
    assert.equal(provider.dimensions, 1024);
    await provider.embed(["deploy runbook"], { inputType: "query" });
    await provider.embed(["# Runbook", "Failover steps"], { inputType: "document" });
    assert.equal(server.requests[0]!.path, "/v1/embeddings");
    assert.equal(server.requests[0]!.headers.authorization, "Bearer pa-test");
    assert.deepEqual(server.requests[0]!.body, { model: "voyage-3.5", input: ["deploy runbook"], truncation: true, input_type: "query" });
    assert.equal(server.requests[1]!.body.input_type, "document");
  } finally {
    await server.close();
  }
});

test("HTTP providers retry 429 and 5xx with retry-after, and stop on 4xx", async () => {
  const sleeps: number[] = [];
  const retrying = await fakeEmbeddingServer((request, index) =>
    index === 0
      ? { status: 429, body: { error: { message: "slow down" } }, headers: { "retry-after": "2" } }
      : index === 1
        ? { status: 503, body: { error: "overloaded" } }
        : { status: 200, body: { data: vectorsFor(request.body.input, 3) } },
  );
  try {
    const provider = new OpenAiCompatibleEmbeddingProvider({ baseUrl: retrying.url, apiKey: "k", model: "custom", sleep: async (ms) => void sleeps.push(ms) });
    const vectors = await provider.embed(["one"]);
    assert.equal(vectors[0]!.length, 3);
    assert.equal(retrying.requests.length, 3);
    assert.deepEqual(sleeps, [2_000, 1_000]);
  } finally {
    await retrying.close();
  }

  const failing = await fakeEmbeddingServer(() => ({ status: 400, body: { error: { message: "bad input" } } }));
  try {
    const provider = new OpenAiCompatibleEmbeddingProvider({ baseUrl: failing.url, apiKey: "k", model: "custom", sleep: noSleep });
    await assert.rejects(provider.embed(["one"]), (error: unknown) => error instanceof EmbeddingError && error.code === "bad_request" && /bad input/.test(error.message));
    assert.equal(failing.requests.length, 1);
  } finally {
    await failing.close();
  }

  const exhausted = await fakeEmbeddingServer(() => ({ status: 500, body: {} }));
  try {
    const provider = new VoyageEmbeddingProvider({ baseUrl: exhausted.url, apiKey: "k", maxRetries: 1, sleep: noSleep });
    await assert.rejects(provider.embed(["one"]), (error: unknown) => error instanceof EmbeddingError && error.code === "server_error");
    assert.equal(exhausted.requests.length, 2);
  } finally {
    await exhausted.close();
  }
});

test("HTTP providers reject vectors whose length does not match the configured dimensions", async () => {
  const server = await fakeEmbeddingServer((request) => ({ status: 200, body: { data: vectorsFor(request.body.input, 3) } }));
  try {
    const provider = new OpenAiCompatibleEmbeddingProvider({ baseUrl: `${server.url}/v1`, model: "nomic-embed-text", dimensions: 4, sleep: noSleep });
    await assert.rejects(provider.embed(["one"]), (error: unknown) => error instanceof EmbeddingError && error.code === "dimension_mismatch");
    assert.equal(server.requests[0]!.headers.authorization, undefined);
    assert.equal(server.requests[0]!.body.dimensions, undefined);
  } finally {
    await server.close();
  }
  const short = await fakeEmbeddingServer(() => ({ status: 200, body: { data: [{ index: 0, embedding: [0.1, 0.2] }] } }));
  try {
    const provider = new OpenAiCompatibleEmbeddingProvider({ baseUrl: short.url, model: "custom", sleep: noSleep });
    await assert.rejects(provider.embed(["one", "two"]), (error: unknown) => error instanceof EmbeddingError && error.code === "invalid_response");
  } finally {
    await short.close();
  }
});

test("HTTP providers time out a hung request", async () => {
  const server = createServer(() => undefined);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  try {
    const provider = new OpenAiCompatibleEmbeddingProvider({ baseUrl: `http://127.0.0.1:${address.port}`, model: "custom", timeoutMs: 50, maxRetries: 0, sleep: noSleep });
    await assert.rejects(provider.embed(["one"]), (error: unknown) => error instanceof EmbeddingError && error.code === "timeout");
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

test("endpoint resolution, env configuration and the local provider", async () => {
  assert.equal(embeddingsEndpoint("https://api.openai.com"), "https://api.openai.com/v1/embeddings");
  assert.equal(embeddingsEndpoint("http://localhost:11434/v1/"), "http://localhost:11434/v1/embeddings");
  assert.equal(embeddingsEndpoint("https://gw.example/openai/deployments/x/embeddings"), "https://gw.example/openai/deployments/x/embeddings");

  assert.ok(createEmbeddingProviderFromEnv({}) instanceof LocalHashEmbeddingProvider);
  assert.ok(createEmbeddingProviderFromEnv({ NOMA_CLOUD_EMBEDDINGS: "local" }) instanceof LocalHashEmbeddingProvider);
  assert.throws(() => createEmbeddingProviderFromEnv({ NOMA_CLOUD_EMBEDDINGS: "voyage" }), /API_KEY/);
  assert.throws(() => createEmbeddingProviderFromEnv({ NOMA_CLOUD_EMBEDDINGS: "cohere" }), /Unsupported/);
  assert.throws(() => createEmbeddingProviderFromEnv({ NOMA_CLOUD_EMBEDDINGS: "openai", NOMA_CLOUD_EMBEDDINGS_API_KEY: "k", NOMA_CLOUD_EMBEDDINGS_DIMENSIONS: "-1" }), /positive integer/);

  const root = await mkdtemp(join(tmpdir(), "noma-embeddings-env-"));
  try {
    const keyFile = join(root, "voyage.key");
    await writeFile(keyFile, "pa-from-file\n", "utf8");
    const voyage = createEmbeddingProviderFromEnv({ NOMA_CLOUD_EMBEDDINGS: "voyage", NOMA_CLOUD_EMBEDDINGS_API_KEY_FILE: keyFile, NOMA_CLOUD_EMBEDDINGS_MODEL: "voyage-3.5-lite", NOMA_CLOUD_EMBEDDINGS_ZERO_RETENTION: "1" });
    assert.ok(voyage instanceof VoyageEmbeddingProvider);
    assert.deepEqual([voyage.id, voyage.model, voyage.dimensions, voyage.zeroRetention], ["voyage", "voyage-3.5-lite", 1024, true]);
    const ollama = createEmbeddingProviderFromEnv({ NOMA_CLOUD_EMBEDDINGS: "openai", NOMA_CLOUD_EMBEDDINGS_URL: "http://localhost:11434", NOMA_CLOUD_EMBEDDINGS_MODEL: "nomic-embed-text" });
    assert.deepEqual([ollama.id, ollama.model, ollama.dimensions, ollama.remote], ["openai", "nomic-embed-text", undefined, true]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }

  const local = new LocalHashEmbeddingProvider();
  const [vector] = await local.embed(["Deployment region"]);
  assert.deepEqual(vector, localHashEmbedding("Deployment region"));
  assert.equal(vector!.length, 96);
  assert.equal(local.remote, false);
});

const concepts: string[][] = [
  ["outage", "downtime", "incident", "failover", "disaster", "standby"],
  ["salary", "payroll", "compensation", "bonus"],
  ["lunch", "cafeteria", "menu", "food"],
];

/** A tiny "semantic" model: synonyms share a concept dimension, everything else hashes into the tail. */
function conceptEmbedding(text: string): number[] {
  const vector = Array.from({ length: 16 }, () => 0);
  for (const token of retrievalTokens(text)) {
    const concept = concepts.findIndex((group) => group.some((word) => token.startsWith(word)));
    if (concept >= 0) vector[concept] = vector[concept]! + 4;
    else {
      const slot = 3 + (Number.parseInt(sha256Hex(token).slice(0, 8), 16) % 13);
      vector[slot] = vector[slot]! + 0.25;
    }
  }
  return vector;
}

const failoverPage = `::decision{id="failover-plan" status="accepted"}
Failover to the standby cluster after a disaster.
::
`;
const distractorPage = `::note{id="playground-bookings"}
Outdated downtown playground bookings.
::
`;
const query = "outage downtime playbook";

function doc(id: string, title: string, source: string): CloudDocumentRecord {
  return {
    version: 2,
    id,
    title,
    source,
    hash: sha256Hex(source),
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-10T00:00:00.000Z",
    createdBy: "alice",
    updatedBy: "alice",
    permissions: { alice: { role: "owner", addedAt: "2026-07-01T00:00:00.000Z" } },
    shareLinks: [],
  };
}

const documents: KnowledgeDocumentAccess[] = [doc("ops", "Operations", failoverPage), doc("office", "Office", distractorPage)].map((document) => ({ document, role: "editor", via: "user" }));
const request = { principalId: "alice", query, documents, now };

async function withPlatform(options: CloudKnowledgePlatformOptions, run: (platform: CloudKnowledgePlatform, dbPath: string) => Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "noma-embeddings-"));
  const dbPath = join(root, "platform.sqlite");
  const platform = new CloudKnowledgePlatform(dbPath, options);
  try {
    await run(platform, dbPath);
  } finally {
    platform.close();
    await rm(root, { recursive: true, force: true });
  }
}

test("backfill upgrades search: a synonym query finds the right block once provider vectors exist", async () => {
  const provider = new FakeEmbeddingProvider((text) => conceptEmbedding(text));
  await withPlatform({ embeddings: provider }, async (platform) => {
    const hashOnly = platform.search(request);
    assert.notEqual(hashOnly[0]?.blockId, "failover-plan", "the hash vector alone favours the trigram look-alike");

    const before = await platform.searchWithRetrieval(request);
    assert.deepEqual(before.retrieval, { semantic: "local-hash", provider: "fake:fake-embedding", coverage: { embedded: 0, total: 4 }, fallback: "not_embedded" });
    assert.notEqual(before.results[0]?.blockId, "failover-plan");

    const backfill = await platform.backfillEmbeddings();
    assert.deepEqual(backfill, { provider: "fake:fake-embedding", embedded: 4, reused: 0, pending: 0 });
    assert.equal(provider.calls.filter((call) => call.inputType === "document").length, 1);

    const after = await platform.searchWithRetrieval(request);
    assert.deepEqual(after.retrieval, { semantic: "fake:fake-embedding", provider: "fake:fake-embedding", coverage: { embedded: 4, total: 4 } });
    assert.equal(after.results[0]?.blockId, "failover-plan");
    assert.ok(after.results[0]!.scoreParts.semantic > 0.9);
    assert.equal("textHash" in after.results[0]!, false);

    const answer = await platform.askWithRetrieval(request);
    assert.equal(answer.retrieval?.semantic, "fake:fake-embedding");
    assert.equal(answer.citations[0]?.blockId, "failover-plan");
    assert.deepEqual(platform.embeddingStatus(), { provider: "fake:fake-embedding", remote: true, dimensions: 16, cachedVectors: 4 });
  });
});

test("embedding cache is keyed by provider, model and text hash, persists, and never mixes dimensions", async () => {
  const provider = new FakeEmbeddingProvider((text) => conceptEmbedding(text));
  await withPlatform({ embeddings: provider }, async (platform, dbPath) => {
    platform.indexDocuments(documents, now);
    assert.equal((await platform.backfillEmbeddings()).embedded, 4);
    const documentCalls = (): number => provider.calls.filter((call) => call.inputType === "document").length;
    assert.equal(documentCalls(), 1);

    platform.indexDocuments(documents, now, true);
    assert.deepEqual(await platform.backfillEmbeddings(), { provider: "fake:fake-embedding", embedded: 0, reused: 0, pending: 0 });
    assert.equal(documentCalls(), 1, "re-indexing unchanged text reuses cached vectors");

    const reopened = new CloudKnowledgePlatform(dbPath, { embeddings: provider });
    try {
      assert.equal((await reopened.backfillEmbeddings()).embedded, 0);
      assert.equal(documentCalls(), 1);
      assert.equal((await reopened.searchWithRetrieval(request)).retrieval.semantic, "fake:fake-embedding");
    } finally {
      reopened.close();
    }

    const narrower = new FakeEmbeddingProvider(undefined, { dimensions: 8 });
    const resized = new CloudKnowledgePlatform(dbPath, { embeddings: narrower });
    try {
      const outcome = await resized.searchWithRetrieval(request);
      assert.deepEqual(outcome.retrieval, { semantic: "local-hash", provider: "fake:fake-embedding", coverage: { embedded: 0, total: 4 }, fallback: "not_embedded" });
      assert.equal((await resized.backfillEmbeddings()).embedded, 4);
      assert.equal((await resized.searchWithRetrieval(request)).retrieval.semantic, "fake:fake-embedding");
    } finally {
      resized.close();
    }

    const otherModel = new FakeEmbeddingProvider((text) => conceptEmbedding(text), { model: "fake-embedding-2" });
    const switched = new CloudKnowledgePlatform(dbPath, { embeddings: otherModel });
    try {
      assert.equal((await switched.backfillEmbeddings()).embedded, 4, "a different model never reuses another model's vectors");
    } finally {
      switched.close();
    }
  });
});

test("a down or slow provider falls back to lexical + hash scoring", async () => {
  const provider = new FakeEmbeddingProvider((text) => conceptEmbedding(text));
  await withPlatform({ embeddings: provider, providerCooldownMs: 60_000 }, async (platform) => {
    await platform.backfillEmbeddings({ documentIds: ["ops", "office"] });
    await platform.searchWithRetrieval(request);
    provider.fail = true;
    const outcome = await platform.searchWithRetrieval({ ...request, query: "standby cluster" });
    assert.equal(outcome.retrieval.semantic, "local-hash");
    assert.equal(outcome.retrieval.fallback, "provider_unavailable");
    assert.equal(outcome.results[0]?.blockId, "failover-plan", "lexical scoring still answers");
    const callsAfterFailure = provider.calls.length;
    const cooled = await platform.searchWithRetrieval({ ...request, query: "another query" });
    assert.equal(cooled.retrieval.fallback, "provider_unavailable");
    assert.equal(provider.calls.length, callsAfterFailure, "cooldown skips the provider instead of waiting on it again");
    assert.equal((await platform.backfillEmbeddings()).skipped, "provider_unavailable");
  });

  const hung: EmbeddingProvider = {
    id: "hung",
    model: "never",
    dimensions: 4,
    remote: true,
    zeroRetention: true,
    embed: () => new Promise<number[][]>(() => undefined),
  };
  await withPlatform({ embeddings: hung, queryEmbeddingTimeoutMs: 30 }, async (platform) => {
    const started = Date.now();
    const outcome = await platform.searchWithRetrieval(request);
    assert.ok(Date.now() - started < 2_000);
    assert.deepEqual(outcome.retrieval, { semantic: "local-hash", provider: "hung:never", fallback: "query_timeout" });
    assert.equal(outcome.results.length, 4);
  });
});

test("enterprise policy keeps workspace text away from a disallowed embedding provider", async () => {
  const provider = new FakeEmbeddingProvider((text) => conceptEmbedding(text), { zeroRetention: false });
  await withPlatform({ embeddings: provider }, async (platform) => {
    const base = platform.enterprisePolicy();
    platform.setEnterprisePolicy({ ...base, modelAllowlist: ["fake-embedding"], requireZeroRetentionModels: true, updatedBy: "admin", updatedAt: now });
    assert.deepEqual(await platform.backfillEmbeddings(), { provider: "fake:fake-embedding", embedded: 0, reused: 0, pending: 0, skipped: "policy_zero_retention_required" });
    const zeroRetention = await platform.searchWithRetrieval(request);
    assert.deepEqual(zeroRetention.retrieval, { semantic: "local-hash", provider: "fake:fake-embedding", fallback: "policy_zero_retention_required" });
    assert.equal(provider.calls.length, 0);

    platform.setEnterprisePolicy({ ...base, modelAllowlist: ["claude-opus-5"], updatedBy: "admin", updatedAt: now });
    assert.equal((await platform.backfillEmbeddings()).skipped, "policy_model_not_allowed");
    assert.equal((await platform.askWithRetrieval(request)).retrieval?.fallback, "policy_model_not_allowed");
    assert.equal(platform.embeddingStatus().blocked, "policy_model_not_allowed");
    assert.equal(provider.calls.length, 0);

    platform.setEnterprisePolicy({ ...base, modelAllowlist: ["fake:fake-embedding"], updatedBy: "admin", updatedAt: now });
    assert.equal((await platform.backfillEmbeddings()).embedded, 4);
    assert.equal((await platform.searchWithRetrieval(request)).retrieval.semantic, "fake:fake-embedding");
  });

  await withPlatform({}, async (platform) => {
    assert.deepEqual((await platform.searchWithRetrieval(request)).retrieval, { semantic: "local-hash", provider: "local-hash" });
    assert.equal((await platform.backfillEmbeddings()).skipped, "local");
  });
});

test("Cloud search, ask and reindex report the retrieval mode over HTTP", async () => {
  const root = await mkdtemp(join(tmpdir(), "noma-embeddings-server-"));
  const publicDir = join(root, "public");
  await mkdir(publicDir, { recursive: true });
  await writeFile(join(publicDir, "index.html"), "<h1>Noma</h1>", "utf8");
  const provider = new FakeEmbeddingProvider((text) => conceptEmbedding(text));
  const server = createNomaCloudServer({
    dataDir: join(root, "data", "documents"),
    usersDir: join(root, "data", "users"),
    sitesDir: join(root, "data", "sites"),
    dbPath: join(root, "data", "noma-cloud.sqlite"),
    publicDir,
    now: () => new Date(now),
    rateLimitMaxRequests: 10_000,
    queueIntervalMs: 0,
    ai: { provider: null, maintenanceTickMs: 0 },
    embeddings: { provider },
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const base = `http://127.0.0.1:${address.port}`;
  const call = async <T>(path: string, init: { method?: string; token?: string; body?: unknown } = {}): Promise<T> => {
    const response = await fetch(`${base}${path}`, {
      method: init.method ?? "GET",
      headers: { accept: "application/json", ...(init.token ? { authorization: `Bearer ${init.token}` } : {}), ...(init.body ? { "content-type": "application/json" } : {}) },
      ...(init.body ? { body: JSON.stringify(init.body) } : {}),
    });
    assert.ok(response.ok, `${response.status} ${await response.clone().text()}`);
    return response.json() as Promise<T>;
  };
  try {
    const alice = await call<{ token: string }>("/api/users", { method: "POST", body: { name: "Alice" } });
    await call("/api/documents", { method: "POST", token: alice.token, body: { title: "Operations", source: failoverPage } });
    await call("/api/documents", { method: "POST", token: alice.token, body: { title: "Office", source: distractorPage } });

    const before = await call<{ retrieval: { semantic: string; fallback?: string } }>(`/api/knowledge/search?q=${encodeURIComponent(query)}`, { token: alice.token });
    assert.deepEqual([before.retrieval.semantic, before.retrieval.fallback], ["local-hash", "not_embedded"]);

    const reindex = await call<{ embeddings: { embedded: number; provider: string } }>("/api/knowledge/reindex", { method: "POST", token: alice.token, body: {} });
    assert.ok(reindex.embeddings.embedded >= 2);
    assert.equal(reindex.embeddings.provider, "fake:fake-embedding");

    const after = await call<{ mode: string; retrieval: { semantic: string }; results: Array<{ blockId: string }> }>(`/api/knowledge/search?q=${encodeURIComponent(query)}`, { token: alice.token });
    assert.equal(after.mode, "hybrid");
    assert.equal(after.retrieval.semantic, "fake:fake-embedding");
    assert.equal(after.results[0]?.blockId, "failover-plan");

    const answer = await call<{ retrieval: { semantic: string } }>("/api/ask", { method: "POST", token: alice.token, body: { query } });
    assert.equal(answer.retrieval.semantic, "fake:fake-embedding");
  } finally {
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    await rm(root, { recursive: true, force: true });
  }
});

test("backfill covers index rows written before text hashes were stored", async () => {
  const provider = new FakeEmbeddingProvider((text) => conceptEmbedding(text));
  await withPlatform({ embeddings: provider }, async (platform, dbPath) => {
    platform.indexDocuments(documents, now);
    const raw = new DatabaseConstructor(dbPath);
    try {
      const stripped = raw.prepare("UPDATE cloud_platform_records SET data_json = json_remove(data_json, '$.textHash') WHERE kind = 'rag_block'").run();
      assert.equal(stripped.changes, 4);
    } finally {
      raw.close();
    }
    const legacy = new CloudKnowledgePlatform(dbPath, { embeddings: provider });
    try {
      assert.deepEqual(await legacy.backfillEmbeddings(), { provider: "fake:fake-embedding", embedded: 4, reused: 0, pending: 0 });
      assert.equal((await legacy.backfillEmbeddings()).embedded, 0);
      const outcome = await legacy.searchWithRetrieval(request);
      assert.equal(outcome.retrieval.semantic, "fake:fake-embedding");
      assert.equal(outcome.results[0]?.blockId, "failover-plan");
    } finally {
      legacy.close();
    }
  });
});
