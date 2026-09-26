import DatabaseConstructor from "better-sqlite3";
import type { Database as SqliteDatabase } from "better-sqlite3";
import type { Attrs, Node } from "./ast.js";
import type { CloudDocumentRecord, CloudPatchProposal, CloudRole } from "./cloud-db.js";
import {
  cosineSimilarity as cosine,
  type EmbeddingProvider,
  embeddingLabel,
  embeddingPolicyBlock,
  embeddingTextHash,
  LOCAL_HASH_PROVIDER_ID,
  LocalHashEmbeddingProvider,
  localHashEmbedding as embed,
  retrievalTokens as tokens,
} from "./cloud-embeddings.js";
import { sha256Hex } from "./hash.js";
import { extractWikilinks } from "./inline.js";
import { parse } from "./parser.js";

export type KnowledgeRelation = "links-to" | "supersedes" | "canonical-for" | "source-of" | "supports" | "contradicts" | "related-to";

export interface KnowledgeTrust {
  documentId: string;
  blockId: string;
  ownerId?: string;
  verifiedBy?: string;
  verifiedAt?: string;
  reviewBy?: string;
  supersedes?: string[];
  canonicalFor?: string[];
  sourceOf?: string[];
  provenance?: Record<string, unknown>;
  updatedAt: string;
  updatedBy: string;
}

export interface KnowledgeAccessDecision {
  principalId: string;
  allowed: true;
  role: CloudRole;
  via: "user" | "group" | "agent";
  decidedAt: string;
}

export interface KnowledgeSourceSpan {
  line: number;
  endLine: number;
  column: number;
}

export interface KnowledgeRetrievalRecord {
  recordId: string;
  documentId: string;
  documentTitle: string;
  blockId: string;
  sourceSpan: KnowledgeSourceSpan;
  versionHash: string;
  contentType: string;
  title?: string;
  exactSource: string;
  searchableText: string;
  attrs: Attrs;
  embedding: number[];
  trust: KnowledgeTrust;
  freshness: { state: "current" | "review_due" | "stale"; score: number; reviewBy?: string };
  provenance: string[];
  accessDecision: KnowledgeAccessDecision;
  score: number;
  scoreParts: {
    lexical: number;
    semantic: number;
    typed: number;
    graph: number;
    verification: number;
    freshness: number;
  };
}

export interface KnowledgeDocumentAccess {
  document: CloudDocumentRecord;
  role: CloudRole;
  via: "user" | "group" | "agent";
}

export interface KnowledgeSearchRequest {
  principalId: string;
  query: string;
  documents: KnowledgeDocumentAccess[];
  now: string;
  limit?: number;
  contentTypes?: string[];
}

/**
 * How a search or answer was retrieved. `semantic` names the vectors that scored semantic similarity:
 * `local-hash` (the deterministic 96-dimension hash vector) or `provider:model` of a configured
 * embedding provider. `fallback` says why a configured provider was not used for this query, and
 * `coverage` how many candidate blocks already carried a provider vector (the rest used lexical +
 * hash scoring; vectors from different spaces are never compared).
 */
export interface KnowledgeRetrievalMode {
  semantic: string;
  provider: string;
  coverage?: { embedded: number; total: number };
  fallback?: "policy_model_not_allowed" | "policy_zero_retention_required" | "provider_unavailable" | "query_timeout" | "not_embedded";
}

export interface KnowledgeSearchOutcome {
  results: KnowledgeRetrievalRecord[];
  retrieval: KnowledgeRetrievalMode;
}

/** Result of one embedding backfill pass. */
export interface EmbeddingBackfillResult {
  provider: string;
  embedded: number;
  reused: number;
  pending: number;
  skipped?: "local" | "policy_model_not_allowed" | "policy_zero_retention_required" | "provider_unavailable" | "closed";
  error?: string;
}

export interface CloudKnowledgePlatformOptions {
  /** Embedding provider for semantic retrieval; defaults to the local hash vector. */
  embeddings?: EmbeddingProvider;
  /** Deadline for embedding a query at search time before falling back to lexical + hash scoring. */
  queryEmbeddingTimeoutMs?: number;
  /** How long a failing provider is skipped before it is tried again. */
  providerCooldownMs?: number;
  /** Blocks embedded per backfill pass. */
  backfillBatchBlocks?: number;
}

export interface AskNomaResult {
  query: string;
  state: "answered" | "insufficient_evidence";
  answer: string;
  confidence: { score: number; label: "low" | "medium" | "high" };
  citations: Array<KnowledgeRetrievalRecord & { citation: number }>;
  conflicts: Array<{ concept: string; records: string[]; reason: string }>;
  latencyMs: number;
  estimatedCostUsd: number;
  retrieval?: KnowledgeRetrievalMode;
}

export interface RagEvaluationFixture {
  id: string;
  query: string;
  requiredSources?: Array<{ documentId: string; blockId?: string }>;
  forbiddenSources?: Array<{ documentId: string; blockId?: string }>;
  expectAbstention?: boolean;
  maxLatencyMs?: number;
  maxCostUsd?: number;
}

export interface RagEvaluationResult {
  fixtureId: string;
  passed: boolean;
  requiredRecall: number;
  forbiddenHits: number;
  citationCoverage: number;
  permissionLeakage: number;
  staleSourceHits: number;
  abstentionCorrect: boolean;
  latencyMs: number;
  estimatedCostUsd: number;
  failures: string[];
}

export type KnowledgeHealthKind =
  | "stale"
  | "orphan"
  | "broken_link"
  | "duplicate"
  | "contradiction"
  | "missing_owner"
  | "unanswered_query";

export interface KnowledgeHealthItem {
  id: string;
  kind: KnowledgeHealthKind;
  severity: "info" | "warning" | "error";
  documentId?: string;
  blockId?: string;
  relatedDocumentId?: string;
  message: string;
  evidence: Record<string, unknown>;
}

export interface LlmWikiResult {
  suggestions: Array<{ fromDocumentId: string; fromBlockId: string; toDocumentId: string; toBlockId: string; score: number }>;
  missingConcepts: Array<{ target: string; mentionedBy: string[] }>;
  canonicalConcepts: Array<{ concept: string; documentId: string; blockId: string }>;
  relationships: Array<{ from: string; to: string; relation: KnowledgeRelation }>;
  mergeProposals: Array<{
    id: string;
    canonicalDocumentId: string;
    duplicateDocumentId: string;
    plan: string[];
    sources: Array<{ documentId: string; blockId: string; versionHash: string }>;
    requestedCapabilities: string[];
    status: "draft";
  }>;
}

type PlatformKind =
  | "trust"
  | "rag_block"
  | "rag_document"
  | "unanswered_query"
  | "rag_evaluation"
  | "agent"
  | "agent_access"
  | "agent_run"
  | "agent_assignment"
  | "connector"
  | "connector_source"
  | "recipe"
  | "recipe_run"
  | "analytics"
  | "offline_draft"
  | "realtime_operation"
  | "enterprise_policy"
  | "scim_identity"
  | "legal_hold";

interface PlatformRow {
  id: string;
  data_json: string;
}

interface StoredRecord {
  id: string;
  kind: PlatformKind;
  ownerId?: string;
  documentId?: string;
  siteId?: string;
  createdAt: string;
  updatedAt: string;
}

type IndexedBlock = Omit<KnowledgeRetrievalRecord, "accessDecision" | "score" | "scoreParts"> &
  Omit<StoredRecord, "documentId" | "kind"> & { documentId: string; kind: "rag_block"; textHash?: string };

interface AuditRecord {
  id: string;
  actorId: string;
  action: string;
  resourceType: string;
  resourceId: string;
  detail: Record<string, unknown>;
  createdAt: string;
}

const defaultEnterprisePolicy: EnterprisePolicy = {
  id: "workspace",
  sso: { enabled: false, provider: "none", enforced: false },
  scim: { enabled: false },
  retentionDays: 365,
  legalHoldEnabled: false,
  dataResidency: "local",
  connectorAllowlist: ["github", "slack", "google_drive", "jira", "linear", "filesystem"],
  modelAllowlist: ["local-deterministic"],
  requireZeroRetentionModels: false,
  auditExportEnabled: true,
  updatedAt: "1970-01-01T00:00:00.000Z",
  updatedBy: "system",
};

/** One page of a platform listing. */
export interface PlatformPage {
  limit: number;
  offset: number;
}

const indexedBlockCacheSize = 512;
const maxDocumentsIndexedPerCall = 250;

export class CloudKnowledgePlatform {
  private readonly db: SqliteDatabase;
  private readonly indexedBlockCache = new Map<string, { versionHash: string; blocks: IndexedBlock[] }>();
  private readonly embeddings: EmbeddingProvider;
  private readonly queryEmbeddingTimeoutMs: number;
  private readonly providerCooldownMs: number;
  private readonly backfillBatchBlocks: number;
  private readonly queryVectorCache = new Map<string, number[]>();
  private providerUnavailableUntil = 0;
  private backfillChain: Promise<unknown> = Promise.resolve();
  private closed = false;

  constructor(dbPath: string, options: CloudKnowledgePlatformOptions = {}) {
    this.db = new DatabaseConstructor(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.db.pragma("busy_timeout = 5000");
    this.applySchema();
    this.embeddings = options.embeddings ?? new LocalHashEmbeddingProvider();
    this.queryEmbeddingTimeoutMs = options.queryEmbeddingTimeoutMs ?? 2_000;
    this.providerCooldownMs = options.providerCooldownMs ?? 60_000;
    this.backfillBatchBlocks = Math.max(1, options.backfillBatchBlocks ?? 256);
  }

  close(): void {
    this.closed = true;
    this.db.close();
  }

  ready(): boolean {
    return this.db.prepare("SELECT 1").pluck().get() === 1;
  }

  putTrust(trust: KnowledgeTrust): KnowledgeTrust {
    this.put("trust", `${trust.documentId}:${trust.blockId}`, trust, {
      ownerId: trust.ownerId,
      documentId: trust.documentId,
      updatedAt: trust.updatedAt,
    });
    this.db.prepare("DELETE FROM cloud_platform_records WHERE kind = 'rag_document' AND id = ?").run(trust.documentId);
    this.indexedBlockCache.delete(trust.documentId);
    this.audit(trust.updatedBy, "trust.updated", "block", `${trust.documentId}:${trust.blockId}`, { ...trust }, trust.updatedAt);
    return trust;
  }

  trustFor(documentId: string, blockId: string): KnowledgeTrust | undefined {
    return this.get<KnowledgeTrust>("trust", `${documentId}:${blockId}`);
  }

  listTrust(documentIds: string[]): KnowledgeTrust[] {
    return this.db
      .prepare("SELECT data_json FROM cloud_platform_records WHERE kind = 'trust' AND document_id IN (SELECT value FROM json_each(?)) ORDER BY updated_at DESC, id")
      .all(JSON.stringify(documentIds))
      .map((row) => JSON.parse((row as PlatformRow).data_json) as KnowledgeTrust);
  }

  /**
   * Indexes documents whose content hash changed since they were last indexed. At most
   * `maxDocuments` documents are parsed per call so one request cannot parse a whole workspace;
   * the rest are picked up by later calls and are left out of results until then.
   */
  indexDocuments(documents: KnowledgeDocumentAccess[], now: string, force = false, maxDocuments = maxDocumentsIndexedPerCall): number {
    const transaction = this.db.transaction(() => {
      let count = 0;
      let parsed = 0;
      for (const access of documents) {
        if (!force && this.indexedBlockCache.get(access.document.id)?.versionHash === access.document.hash) continue;
        const indexed = this.get<{ versionHash: string }>("rag_document", access.document.id);
        if (!force && indexed?.versionHash === access.document.hash) continue;
        if (parsed >= maxDocuments) continue;
        parsed += 1;
        this.db.prepare("DELETE FROM cloud_platform_records WHERE kind = 'rag_block' AND document_id = ?").run(access.document.id);
        const blocks = indexDocument(access.document, this.listTrust([access.document.id]), now);
        for (const block of blocks) {
          this.put("rag_block", block.id, block, { documentId: block.documentId, updatedAt: now });
          count += 1;
        }
        this.put("rag_document", access.document.id, { id: access.document.id, versionHash: access.document.hash, indexedAt: now }, { documentId: access.document.id, updatedAt: now });
        this.cacheIndexedBlocks(access.document.id, access.document.hash, blocks);
      }
      return count;
    });
    return transaction();
  }

  /** Current-version indexed blocks for the given documents, served from an LRU keyed by document hash. */
  private indexedBlocks(documents: KnowledgeDocumentAccess[]): IndexedBlock[] {
    const blocks: IndexedBlock[] = [];
    const select = this.db.prepare("SELECT data_json FROM cloud_platform_records WHERE kind = 'rag_block' AND document_id = ?");
    for (const { document } of documents) {
      const cached = this.indexedBlockCache.get(document.id);
      if (cached?.versionHash === document.hash) {
        this.indexedBlockCache.delete(document.id);
        this.indexedBlockCache.set(document.id, cached);
        blocks.push(...cached.blocks);
        continue;
      }
      const loaded = sortIndexedBlocks(
        select
          .all(document.id)
          .map((row) => JSON.parse((row as PlatformRow).data_json) as IndexedBlock)
          .filter((block) => block.versionHash === document.hash),
      );
      if (this.get<{ versionHash: string }>("rag_document", document.id)?.versionHash === document.hash) {
        this.cacheIndexedBlocks(document.id, document.hash, loaded);
      }
      blocks.push(...loaded);
    }
    return blocks;
  }

  private cacheIndexedBlocks(documentId: string, versionHash: string, blocks: IndexedBlock[]): void {
    this.indexedBlockCache.delete(documentId);
    this.indexedBlockCache.set(documentId, { versionHash, blocks: sortIndexedBlocks(blocks) });
    while (this.indexedBlockCache.size > indexedBlockCacheSize) {
      const oldest = this.indexedBlockCache.keys().next().value;
      if (oldest === undefined) break;
      this.indexedBlockCache.delete(oldest);
    }
  }

  /** Synchronous hybrid search scored with the local hash vector only (no provider call). */
  search(request: KnowledgeSearchRequest): KnowledgeRetrievalRecord[] {
    const query = request.query.trim();
    if (!query) return [];
    this.indexDocuments(request.documents, request.now);
    const queryEmbedding = embed(query);
    return this.rank(request, query, this.indexedBlocks(request.documents), (block) => cosine(queryEmbedding, block.embedding));
  }

  /**
   * Hybrid search that uses the configured embedding provider when policy allows it: the query is
   * embedded with a deadline, blocks with a cached provider vector of the same length are scored
   * against it, and everything else (or everything, when the provider is blocked, down, or slow)
   * falls back to lexical + local-hash scoring. `retrieval` reports which mode served the query.
   */
  async searchWithRetrieval(request: KnowledgeSearchRequest): Promise<KnowledgeSearchOutcome> {
    const query = request.query.trim();
    const provider = this.embeddings;
    const label = embeddingLabel(provider);
    const local: KnowledgeRetrievalMode = { semantic: LOCAL_HASH_PROVIDER_ID, provider: label };
    if (!query) return { results: [], retrieval: local };
    this.indexDocuments(request.documents, request.now);
    const hashQuery = embed(query);
    const hashScore = (block: IndexedBlock): number => cosine(hashQuery, block.embedding);
    if (provider.id === LOCAL_HASH_PROVIDER_ID) {
      return { results: this.rank(request, query, this.indexedBlocks(request.documents), hashScore), retrieval: local };
    }
    const blocked = this.providerBlock();
    if (blocked) {
      return { results: this.rank(request, query, this.indexedBlocks(request.documents), hashScore), retrieval: { ...local, fallback: blocked } };
    }
    let queryVector: number[] | undefined;
    let fallback: KnowledgeRetrievalMode["fallback"];
    try {
      queryVector = await this.embedQuery(query);
    } catch (error) {
      fallback = error instanceof QueryEmbeddingTimeout ? "query_timeout" : "provider_unavailable";
      this.providerUnavailableUntil = Date.now() + this.providerCooldownMs;
    }
    if (this.closed) throw new Error("Knowledge platform is closed");
    const blocks = this.indexedBlocks(request.documents);
    if (!queryVector) return { results: this.rank(request, query, blocks, hashScore), retrieval: { ...local, fallback: fallback ?? "provider_unavailable" } };
    const vectors = this.cachedVectors(queryVector.length, blocks.map(blockTextHash));
    const vector = queryVector;
    const results = this.rank(request, query, blocks, (block) => {
      const stored = vectors.get(blockTextHash(block));
      return stored && stored.length === vector.length ? cosine(vector, stored) : hashScore(block);
    });
    const embedded = blocks.filter((block) => vectors.has(blockTextHash(block))).length;
    const coverage = { embedded, total: blocks.length };
    if (embedded === 0) return { results, retrieval: { ...local, coverage, fallback: "not_embedded" } };
    return { results, retrieval: { semantic: label, provider: label, coverage } };
  }

  /** The configured embedding provider, whether policy or a recent failure blocks it, and its cache size. */
  embeddingStatus(): { provider: string; remote: boolean; dimensions?: number; blocked?: KnowledgeRetrievalMode["fallback"]; cachedVectors: number } {
    const provider = this.embeddings;
    const row = this.db.prepare("SELECT COUNT(*) AS count FROM block_embeddings WHERE provider = ? AND model = ?").get(provider.id, provider.model) as { count: number };
    const blocked = provider.id === LOCAL_HASH_PROVIDER_ID ? undefined : this.providerBlock();
    return {
      provider: embeddingLabel(provider),
      remote: provider.remote,
      ...(provider.dimensions !== undefined ? { dimensions: provider.dimensions } : {}),
      ...(blocked ? { blocked } : {}),
      cachedVectors: row.count,
    };
  }

  /**
   * Embeds indexed blocks that have no cached vector for the configured provider yet, at most
   * `backfillBatchBlocks` per pass. Vectors are cached by (provider, model, sha256(text)), so
   * re-indexing unchanged text never re-embeds it. Passes are serialised; failures put the provider
   * on cooldown and are reported, never thrown.
   */
  backfillEmbeddings(options: { documentIds?: string[]; maxBlocks?: number } = {}): Promise<EmbeddingBackfillResult> {
    const run = this.backfillChain.then(() => this.runBackfill(options));
    this.backfillChain = run.catch(() => undefined);
    return run;
  }

  private async runBackfill(options: { documentIds?: string[]; maxBlocks?: number }): Promise<EmbeddingBackfillResult> {
    const provider = this.embeddings;
    const label = embeddingLabel(provider);
    const empty = { provider: label, embedded: 0, reused: 0, pending: 0 };
    if (this.closed) return { ...empty, skipped: "closed" };
    if (provider.id === LOCAL_HASH_PROVIDER_ID) return { ...empty, skipped: "local" };
    const blocked = this.providerBlock();
    if (blocked === "policy_model_not_allowed" || blocked === "policy_zero_retention_required") return { ...empty, skipped: blocked };
    if (blocked) return { ...empty, skipped: "provider_unavailable" };
    const limit = Math.max(1, Math.min(options.maxBlocks ?? this.backfillBatchBlocks, 5_000));
    const candidates = this.missingEmbeddingBlocks(limit, options.documentIds);
    const texts = new Map<string, string>();
    for (const candidate of candidates) texts.set(candidate.textHash, candidate.text);
    const hashes = [...texts.keys()];
    if (hashes.length === 0) return empty;
    let vectors: number[][];
    try {
      vectors = await provider.embed(hashes.map((hash) => texts.get(hash)!), { inputType: "document" });
    } catch (error) {
      this.providerUnavailableUntil = Date.now() + this.providerCooldownMs;
      return { ...empty, pending: hashes.length, skipped: "provider_unavailable", error: error instanceof Error ? error.message : String(error) };
    }
    if (this.closed) return { ...empty, skipped: "closed" };
    const length = vectors[0]?.length ?? 0;
    if (vectors.length !== hashes.length || length === 0 || vectors.some((vector) => vector.length !== length) || (provider.dimensions !== undefined && length !== provider.dimensions)) {
      this.providerUnavailableUntil = Date.now() + this.providerCooldownMs;
      return { ...empty, pending: hashes.length, skipped: "provider_unavailable", error: "Embedding provider returned vectors of an unexpected shape" };
    }
    const insert = this.db.prepare("INSERT OR REPLACE INTO block_embeddings (provider, model, text_hash, dimensions, vector, created_at) VALUES (?, ?, ?, ?, ?, ?)");
    const createdAt = new Date().toISOString();
    this.db.transaction(() => {
      hashes.forEach((hash, index) => insert.run(provider.id, provider.model, hash, length, encodeVector(vectors[index]!), createdAt));
    })();
    const pending = this.missingEmbeddingBlocks(1, options.documentIds).length;
    return { provider: label, embedded: hashes.length, reused: candidates.length - hashes.length, pending };
  }

  private missingEmbeddingBlocks(limit: number, documentIds?: string[]): Array<{ textHash: string; text: string }> {
    const provider = this.embeddings;
    const dimensions = provider.dimensions ?? null;
    const select = (): Array<{ id: string; text_hash: string | null; text: string | null }> =>
      this.db
        .prepare(`
          SELECT r.id AS id, json_extract(r.data_json, '$.textHash') AS text_hash, json_extract(r.data_json, '$.searchableText') AS text
          FROM cloud_platform_records r
          WHERE r.kind = 'rag_block'
            ${documentIds ? "AND r.document_id IN (SELECT value FROM json_each(?))" : ""}
            AND NOT EXISTS (
              SELECT 1 FROM block_embeddings e
              WHERE e.provider = ? AND e.model = ? AND e.text_hash = json_extract(r.data_json, '$.textHash')
                AND (? IS NULL OR e.dimensions = ?)
            )
          ORDER BY r.updated_at, r.id
          LIMIT ?
        `)
        .all(...(documentIds ? [JSON.stringify(documentIds)] : []), provider.id, provider.model, dimensions, dimensions, limit) as Array<{ id: string; text_hash: string | null; text: string | null }>;
    let rows = select();
    const legacy = rows.filter((row) => !row.text_hash && typeof row.text === "string");
    if (legacy.length > 0) {
      const update = this.db.prepare("UPDATE cloud_platform_records SET data_json = json_set(data_json, '$.textHash', ?) WHERE kind = 'rag_block' AND id = ?");
      this.db.transaction(() => {
        for (const row of legacy) update.run(embeddingTextHash(row.text!), row.id);
      })();
      rows = select();
    }
    return rows
      .filter((row): row is { id: string; text_hash: string; text: string } => typeof row.text_hash === "string" && typeof row.text === "string")
      .map((row) => ({ textHash: row.text_hash, text: row.text }));
  }

  private cachedVectors(dimensions: number, textHashes: string[]): Map<string, Float32Array> {
    const vectors = new Map<string, Float32Array>();
    const provider = this.embeddings;
    const unique = [...new Set(textHashes)];
    const select = this.db.prepare("SELECT text_hash, vector FROM block_embeddings WHERE provider = ? AND model = ? AND dimensions = ? AND text_hash IN (SELECT value FROM json_each(?))");
    for (let start = 0; start < unique.length; start += 500) {
      const rows = select.all(provider.id, provider.model, dimensions, JSON.stringify(unique.slice(start, start + 500))) as Array<{ text_hash: string; vector: Buffer }>;
      for (const row of rows) {
        const vector = decodeVector(row.vector);
        if (vector.length === dimensions) vectors.set(row.text_hash, vector);
      }
    }
    return vectors;
  }

  private async embedQuery(query: string): Promise<number[]> {
    const provider = this.embeddings;
    const key = `${provider.id}\u0000${provider.model}\u0000${query}`;
    const cached = this.queryVectorCache.get(key);
    if (cached) return cached;
    const timeoutMs = this.queryEmbeddingTimeoutMs;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new QueryEmbeddingTimeout()), timeoutMs);
    });
    try {
      const [vector] = await Promise.race([provider.embed([query], { inputType: "query", timeoutMs }), deadline]);
      if (!vector || vector.length === 0 || (provider.dimensions !== undefined && vector.length !== provider.dimensions)) throw new Error("Embedding provider returned an unexpected query vector");
      this.queryVectorCache.set(key, vector);
      while (this.queryVectorCache.size > 256) {
        const oldest = this.queryVectorCache.keys().next().value;
        if (oldest === undefined) break;
        this.queryVectorCache.delete(oldest);
      }
      return vector;
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  private providerBlock(): KnowledgeRetrievalMode["fallback"] | undefined {
    const policyBlock = embeddingPolicyBlock(this.enterprisePolicy(), this.embeddings);
    if (policyBlock) return policyBlock === "model_not_allowed" ? "policy_model_not_allowed" : "policy_zero_retention_required";
    if (Date.now() < this.providerUnavailableUntil) return "provider_unavailable";
    return undefined;
  }

  private rank(request: KnowledgeSearchRequest, query: string, blocks: IndexedBlock[], semanticScore: (block: IndexedBlock) => number): KnowledgeRetrievalRecord[] {
    const accessByDocument = new Map(request.documents.map((item) => [item.document.id, item]));
    const queryTokens = tokens(query);
    const types = new Set(request.contentTypes ?? []);
    const scored = blocks
      .filter((block) => types.size === 0 || types.has(block.contentType))
      .map((block): KnowledgeRetrievalRecord => {
        const access = accessByDocument.get(block.documentId)!;
        const lexical = lexicalScore(queryTokens, tokens(block.searchableText));
        const semantic = semanticScore(block);
        const typed = typedScore(queryTokens, block);
        const graph = Math.min(1, (block.trust.canonicalFor?.length ?? 0) * 0.15 + (block.trust.sourceOf?.length ?? 0) * 0.1 + (block.trust.supersedes?.length ?? 0) * 0.1);
        const verification = block.trust.verifiedAt ? 1 : 0;
        const freshness = block.freshness.score;
        const score = lexical * 0.38 + semantic * 0.28 + typed * 0.1 + graph * 0.07 + verification * 0.08 + freshness * 0.09;
        return {
          ...stripStored(block),
          accessDecision: {
            principalId: request.principalId,
            allowed: true,
            role: access.role,
            via: access.via,
            decidedAt: request.now,
          },
          score: round(score),
          scoreParts: { lexical: round(lexical), semantic: round(semantic), typed: round(typed), graph: round(graph), verification, freshness: round(freshness) },
        };
      })
      .filter((result) => relevantRetrieval(queryTokens, result))
      .sort((left, right) => right.score - left.score || left.documentId.localeCompare(right.documentId) || left.sourceSpan.line - right.sourceSpan.line);
    return scored.slice(0, request.limit ?? 12);
  }

  ask(request: KnowledgeSearchRequest): AskNomaResult {
    const started = performance.now();
    return this.answer(request, this.search({ ...request, limit: request.limit ?? 8 }), started);
  }

  /** `ask` over `searchWithRetrieval`; the result carries the retrieval mode that served it. */
  async askWithRetrieval(request: KnowledgeSearchRequest): Promise<AskNomaResult> {
    const started = performance.now();
    const { results, retrieval } = await this.searchWithRetrieval({ ...request, limit: request.limit ?? 8 });
    return { ...this.answer(request, results, started), retrieval };
  }

  private answer(request: KnowledgeSearchRequest, results: KnowledgeRetrievalRecord[], started: number): AskNomaResult {
    const citations = selectCitations(results);
    const confidenceScore = citationConfidence(citations);
    const strongest = citations[0];
    const insufficient = !strongest || strongest.score < 0.16 || confidenceScore < 0.12 || (strongest.scoreParts.lexical < 0.45 && strongest.scoreParts.semantic < 0.55);
    const conflicts = detectConflicts(citations);
    const latencyMs = Math.max(0, Math.round(performance.now() - started));
    const estimatedCostUsd = round((request.query.length + citations.reduce((sum, item) => sum + item.exactSource.length, 0)) / 1_000_000 * 0.15, 6);
    const result: AskNomaResult = insufficient
      ? {
          query: request.query,
          state: "insufficient_evidence",
          answer: "Noma does not have enough accessible, current evidence to answer this question.",
          confidence: { score: confidenceScore, label: "low" },
          citations: [],
          conflicts: [],
          latencyMs,
          estimatedCostUsd,
        }
      : {
          query: request.query,
          state: "answered",
          answer: answerFromCitations(citations, conflicts),
          confidence: { score: confidenceScore, label: confidenceLabel(confidenceScore) },
          citations: citations.map((citation, index) => ({ ...citation, citation: index + 1 })),
          conflicts,
          latencyMs,
          estimatedCostUsd,
        };
    const eventId = sha256Hex(`${request.principalId}:${request.now}:${request.query}`).slice(0, 24);
    this.put("analytics", eventId, {
      id: eventId,
      type: insufficient ? "no_result" : "answer_generated",
      actorId: request.principalId,
      documentId: citations[0]?.documentId,
      query: request.query,
      resultCount: citations.length,
      createdAt: request.now,
    } satisfies AnalyticsEvent, { ownerId: request.principalId, documentId: citations[0]?.documentId, updatedAt: request.now });
    if (insufficient) {
      this.put("unanswered_query", eventId, {
        id: eventId,
        principalId: request.principalId,
        query: request.query,
        accessibleDocumentIds: request.documents.map((item) => item.document.id),
        createdAt: request.now,
      }, { ownerId: request.principalId, updatedAt: request.now });
    }
    return result;
  }

  evaluate(fixtures: RagEvaluationFixture[], base: Omit<KnowledgeSearchRequest, "query">): RagEvaluationResult[] {
    return fixtures.map((fixture) => {
      const answer = this.ask({ ...base, query: fixture.query });
      const visible = new Set(base.documents.map((item) => item.document.id));
      const citations = answer.citations;
      const required = fixture.requiredSources ?? [];
      const forbidden = fixture.forbiddenSources ?? [];
      const requiredHits = required.filter((source) => citations.some((citation) => sourceMatches(citation, source))).length;
      const forbiddenHits = forbidden.filter((source) => citations.some((citation) => sourceMatches(citation, source))).length;
      const permissionLeakage = citations.filter((citation) => !visible.has(citation.documentId)).length;
      const staleSourceHits = citations.filter((citation) => citation.freshness.state === "stale").length;
      const requiredRecall = required.length === 0 ? 1 : requiredHits / required.length;
      const citationCoverage = answer.state === "answered" && citations.length === 0 ? 0 : 1;
      const abstentionCorrect = fixture.expectAbstention === undefined || fixture.expectAbstention === (answer.state === "insufficient_evidence");
      const failures: string[] = [];
      if (requiredRecall < 1) failures.push("required_source_missing");
      if (forbiddenHits > 0) failures.push("forbidden_source_used");
      if (citationCoverage < 1) failures.push("citation_coverage");
      if (permissionLeakage > 0) failures.push("permission_leakage");
      if (staleSourceHits > 0) failures.push("stale_source_used");
      if (!abstentionCorrect) failures.push("abstention_mismatch");
      if (fixture.maxLatencyMs !== undefined && answer.latencyMs > fixture.maxLatencyMs) failures.push("latency_budget");
      if (fixture.maxCostUsd !== undefined && answer.estimatedCostUsd > fixture.maxCostUsd) failures.push("cost_budget");
      const result: RagEvaluationResult = {
        fixtureId: fixture.id,
        passed: failures.length === 0,
        requiredRecall: round(requiredRecall),
        forbiddenHits,
        citationCoverage,
        permissionLeakage,
        staleSourceHits,
        abstentionCorrect,
        latencyMs: answer.latencyMs,
        estimatedCostUsd: answer.estimatedCostUsd,
        failures,
      };
      const id = `${fixture.id}:${base.now}`;
      this.put("rag_evaluation", id, { ...result, id, createdAt: base.now }, { ownerId: base.principalId, updatedAt: base.now });
      return result;
    });
  }

  health(documents: KnowledgeDocumentAccess[], now: string): KnowledgeHealthItem[] {
    this.indexDocuments(documents, now);
    const allowed = new Set(documents.map((item) => item.document.id));
    const blocks = this.indexedBlocks(documents);
    const items: KnowledgeHealthItem[] = [];
    for (const block of blocks) {
      if (block.freshness.state !== "current") {
        items.push(healthItem("stale", block.documentId, block.blockId, `Review is ${block.freshness.state.replace("_", " ")}`, { reviewBy: block.freshness.reviewBy }, block.freshness.state === "stale" ? "error" : "warning"));
      }
      if (!block.trust.ownerId && (block.contentType === "section" || block.contentType === "claim" || block.contentType === "decision")) {
        items.push(healthItem("missing_owner", block.documentId, block.blockId, "Knowledge block has no accountable owner", { contentType: block.contentType }, "warning"));
      }
    }
    const links = knowledgeLinks(documents.map((item) => item.document));
    const linkedDocs = new Set(links.flatMap((link) => [link.fromDocumentId, link.toDocumentId].filter((value): value is string => Boolean(value))));
    for (const access of documents) {
      if (!linkedDocs.has(access.document.id)) items.push(healthItem("orphan", access.document.id, undefined, "Page has no resolved incoming or outgoing wiki link", {}, "info"));
    }
    for (const link of links.filter((item) => !item.toDocumentId)) {
      items.push(healthItem("broken_link", link.fromDocumentId, link.fromBlockId, `Wiki target [[${link.target}]] does not resolve`, { target: link.target }, "warning"));
    }
    for (const pair of duplicatePairs(blocks)) {
      items.push(healthItem("duplicate", pair.left.documentId, pair.left.blockId, "Semantically similar knowledge may duplicate another block", { relatedDocumentId: pair.right.documentId, relatedBlockId: pair.right.blockId, similarity: pair.similarity }, "info", pair.right.documentId));
    }
    for (const conflict of detectConflicts(blocks.map((block) => retrievalFromIndexed(block, now)))) {
      const first = blocks.find((block) => conflict.records.includes(block.recordId));
      items.push(healthItem("contradiction", first?.documentId, first?.blockId, `Conflicting sources for ${conflict.concept}`, { records: conflict.records, reason: conflict.reason }, "error"));
    }
    for (const record of this.list<{ id: string; query: string; accessibleDocumentIds: string[] }>("unanswered_query")) {
      if (record.accessibleDocumentIds.some((id) => allowed.has(id))) items.push(healthItem("unanswered_query", undefined, undefined, `Unanswered query: ${record.query}`, { queryId: record.id }, "warning"));
    }
    return dedupeHealth(items);
  }

  wiki(documents: KnowledgeDocumentAccess[], now: string): LlmWikiResult {
    this.indexDocuments(documents, now);
    const allowed = new Set(documents.map((item) => item.document.id));
    const blocks = this.indexedBlocks(documents);
    const links = knowledgeLinks(documents.map((item) => item.document));
    const existingPairs = new Set(links.filter((link) => link.toDocumentId).map((link) => `${link.fromDocumentId}:${link.toDocumentId}`));
    const suggestions = duplicatePairs(blocks)
      .filter((pair) => pair.left.documentId !== pair.right.documentId && !existingPairs.has(`${pair.left.documentId}:${pair.right.documentId}`))
      .slice(0, 30)
      .map((pair) => ({ fromDocumentId: pair.left.documentId, fromBlockId: pair.left.blockId, toDocumentId: pair.right.documentId, toBlockId: pair.right.blockId, score: pair.similarity }));
    const missingByTarget = new Map<string, string[]>();
    for (const link of links.filter((item) => !item.toDocumentId)) {
      const refs = missingByTarget.get(link.target) ?? [];
      refs.push(link.fromDocumentId);
      missingByTarget.set(link.target, refs);
    }
    const canonicalConcepts = blocks.flatMap((block) => (block.trust.canonicalFor ?? []).map((concept) => ({ concept, documentId: block.documentId, blockId: block.blockId })));
    const relationships: LlmWikiResult["relationships"] = links.filter((link) => link.toDocumentId).map((link) => ({ from: `${link.fromDocumentId}:${link.fromBlockId}`, to: `${link.toDocumentId}:${link.toBlockId ?? "page"}`, relation: "links-to" }));
    for (const block of blocks) {
      for (const target of block.trust.supersedes ?? []) relationships.push({ from: `${block.documentId}:${block.blockId}`, to: target, relation: "supersedes" });
      for (const target of block.trust.sourceOf ?? []) relationships.push({ from: `${block.documentId}:${block.blockId}`, to: target, relation: "source-of" });
    }
    const mergeProposals = duplicatePairs(blocks)
      .filter((pair) => pair.left.documentId !== pair.right.documentId && pair.similarity >= 0.82)
      .slice(0, 20)
      .map((pair) => ({
        id: sha256Hex(`merge:${pair.left.recordId}:${pair.right.recordId}`).slice(0, 24),
        canonicalDocumentId: pair.left.trust.canonicalFor?.length ? pair.left.documentId : pair.right.documentId,
        duplicateDocumentId: pair.left.trust.canonicalFor?.length ? pair.right.documentId : pair.left.documentId,
        plan: ["Compare exact block sources", "Preserve unique evidence and aliases", "Submit a proofed patch against the canonical document", "Request an independent reviewer"],
        sources: [pair.left, pair.right].map((block) => ({ documentId: block.documentId, blockId: block.blockId, versionHash: block.versionHash })),
        requestedCapabilities: ["read_doc", "list_ids", "validate_doc", "patch_block"],
        status: "draft" as const,
      }));
    return {
      suggestions,
      missingConcepts: [...missingByTarget].map(([target, mentionedBy]) => ({ target, mentionedBy: [...new Set(mentionedBy)].sort() })),
      canonicalConcepts,
      relationships,
      mergeProposals,
    };
  }

  agentChangeInbox(proposals: CloudPatchProposal[], documents: KnowledgeDocumentAccess[]): AgentChangeInboxItem[] {
    const visible = new Map(documents.map((item) => [item.document.id, item.document]));
    return proposals
      .filter((proposal) => visible.has(proposal.documentId))
      .map((proposal): AgentChangeInboxItem => {
        const proof = proposal.proof;
        const affectedIds = [...new Set(proposal.ops.flatMap((op) => operationIds(op)))];
        return {
          id: proposal.id,
          documentId: proposal.documentId,
          documentHash: proposal.documentHash,
          proposedBy: proposal.proposedBy,
          proposedByName: proposal.proposedByName,
          plan: [proposal.summary ?? "Apply the proposed block-level change", "Validate against the current source hash", "Require independent review before apply"],
          sources: [{ documentId: proposal.documentId, versionHash: proposal.documentHash, blockIds: affectedIds }],
          requestedCapabilities: ["read_doc", "list_ids", "validate_doc", "patch_block"],
          operations: proposal.ops,
          diff: recordField(proof, "diff"),
          validation: {
            before: recordField(proof, "preValidation"),
            after: recordField(proof, "postValidation"),
            canWrite: proof.canWrite === true,
          },
          affectedIds,
          reviewerId: proposal.reviewedBy,
          status: proposal.status,
          applyStatus: proposal.status === "applied" ? "applied" : proposal.status === "approved" ? "ready" : proposal.status === "rejected" ? "rejected" : "awaiting_review",
          createdAt: proposal.createdAt,
          updatedAt: proposal.updatedAt,
        };
      })
      .sort((left, right) => right.updatedAt.localeCompare(left.updatedAt) || left.id.localeCompare(right.id));
  }

  createAgent(agent: CloudAgentIdentity): CloudAgentIdentity {
    const policy = this.enterprisePolicy();
    if (!policy.modelAllowlist.includes(agent.modelPolicy.model)) throw new Error(`Model is not allowed: ${agent.modelPolicy.model}`);
    if (policy.requireZeroRetentionModels && !agent.modelPolicy.zeroRetention) throw new Error("Enterprise policy requires a zero-retention model");
    if (agent.budgetUsd < 0 || agent.spentUsd < 0 || agent.spentUsd > agent.budgetUsd) throw new Error("Agent budget is invalid");
    this.put("agent", agent.id, agent, { ownerId: agent.createdBy, updatedAt: agent.updatedAt });
    this.audit(agent.createdBy, "agent.created", "agent", agent.id, { modelPolicy: agent.modelPolicy, capabilities: agent.capabilities, budgetUsd: agent.budgetUsd }, agent.createdAt);
    return agent;
  }

  readAgent(id: string): CloudAgentIdentity | undefined {
    return this.get<CloudAgentIdentity>("agent", id);
  }

  listAgents(ownerId?: string, page?: PlatformPage): CloudAgentIdentity[] {
    return this.list<CloudAgentIdentity>("agent", { ownerId }, page);
  }

  /** Agent grants that cover a page directly or through one of `siteIds`. */
  listAgentAccessCovering(documentId: string, siteIds: string[]): AgentAccessGrant[] {
    return this.db
      .prepare("SELECT data_json FROM cloud_platform_records WHERE kind = 'agent_access' AND (document_id = ? OR site_id IN (SELECT value FROM json_each(?))) ORDER BY updated_at DESC, id LIMIT 1000")
      .all(documentId, JSON.stringify(siteIds))
      .map((row) => JSON.parse((row as PlatformRow).data_json) as AgentAccessGrant);
  }

  writeAgentAssignment(assignment: AgentAssignment): AgentAssignment {
    this.put("agent_assignment", assignment.id, assignment, { ownerId: assignment.agentId, documentId: assignment.documentId, updatedAt: assignment.updatedAt });
    return assignment;
  }

  readAgentAssignment(id: string): AgentAssignment | undefined {
    return this.get<AgentAssignment>("agent_assignment", id);
  }

  /** Assignments for one agent (`agentId`) or one page (`documentId`), newest activity first. */
  listAgentAssignments(filter: { agentId?: string; documentId?: string }, page?: PlatformPage): AgentAssignment[] {
    return this.list<AgentAssignment>("agent_assignment", { ownerId: filter.agentId, documentId: filter.documentId }, page);
  }

  grantAgentAccess(access: AgentAccessGrant, actorId: string, now: string): AgentAccessGrant {
    if (!this.readAgent(access.agentId)) throw new Error("Agent not found");
    this.put("agent_access", access.id, access, { ownerId: access.agentId, documentId: access.resourceType === "document" ? access.resourceId : undefined, siteId: access.resourceType === "site" ? access.resourceId : undefined, updatedAt: access.updatedAt });
    this.audit(actorId, "agent.access_granted", access.resourceType, access.resourceId, { agentId: access.agentId, role: access.role }, now);
    return access;
  }

  listAgentAccess(agentId: string): AgentAccessGrant[] {
    return this.list<AgentAccessGrant>("agent_access", { ownerId: agentId }).filter((access) => access.agentId === agentId);
  }

  requireAgentAccess(agentId: string, resourceType: "document" | "site", resourceId: string, capability: string): AgentAccessGrant {
    const agent = this.readAgent(agentId);
    if (!agent || agent.status !== "active") throw new Error("Agent identity is not active");
    if (!agent.capabilities.includes(capability)) throw new Error(`Agent lacks capability: ${capability}`);
    const grant = this.listAgentAccess(agentId).find((access) => access.resourceType === resourceType && access.resourceId === resourceId);
    if (!grant) throw new Error("Agent has no explicit access grant for this resource");
    return grant;
  }

  startAgentRun(run: AgentRun): AgentRun {
    const agent = this.readAgent(run.agentId);
    if (!agent || agent.status !== "active") throw new Error("Agent identity is not active");
    const ungranted = run.requestedCapabilities.find((capability) => !agent.capabilities.includes(capability));
    if (ungranted) throw new Error(`Agent run requests an ungranted capability: ${ungranted}`);
    const policy = this.enterprisePolicy();
    if (!policy.modelAllowlist.includes(agent.modelPolicy.model)) throw new Error("Agent model is no longer allowed");
    if (policy.requireZeroRetentionModels && !agent.modelPolicy.zeroRetention) throw new Error("Agent model does not meet zero-retention policy");
    if (agent.spentUsd >= agent.budgetUsd) throw new Error("Agent budget is exhausted");
    this.put("agent_run", run.id, run, { ownerId: run.agentId, documentId: run.documentId, updatedAt: run.startedAt });
    this.audit(run.triggeredBy, "agent.run_started", "agent", run.agentId, { runId: run.id, trigger: run.trigger, documentId: run.documentId }, run.startedAt);
    return run;
  }

  finishAgentRun(runId: string, input: { status: Exclude<AgentRunStatus, "running">; costUsd: number; completedAt: string; output?: Record<string, unknown> }): AgentRun {
    const run = this.get<AgentRun>("agent_run", runId);
    if (!run || run.status !== "running") throw new Error("Running agent run not found");
    const agent = this.readAgent(run.agentId);
    if (!agent) throw new Error("Agent not found");
    const nextSpend = round(agent.spentUsd + input.costUsd, 6);
    if (nextSpend > agent.budgetUsd) throw new Error("Agent run exceeds the remaining budget");
    const completed: AgentRun = { ...run, status: input.status, costUsd: input.costUsd, completedAt: input.completedAt, ...(input.output ? { output: input.output } : {}) };
    this.put("agent_run", run.id, completed, { ownerId: run.agentId, documentId: run.documentId, updatedAt: input.completedAt });
    this.put("agent", agent.id, { ...agent, spentUsd: nextSpend, updatedAt: input.completedAt }, { ownerId: agent.createdBy, updatedAt: input.completedAt });
    this.audit(run.agentId, "agent.run_completed", "agent", run.agentId, { runId, status: input.status, costUsd: input.costUsd }, input.completedAt);
    return completed;
  }

  listAgentRuns(agentId: string, page?: PlatformPage): AgentRun[] {
    return this.list<AgentRun>("agent_run", { ownerId: agentId }, page).filter((run) => run.agentId === agentId);
  }

  /**
   * Creates or refreshes the per-user system agent behind Cloud AI features. Unlike `createAgent` it
   * does not gate on the model allowlist, because the AI runtime re-checks enterprise policy on every call.
   * Spend already recorded is kept.
   */
  upsertSystemAgent(agent: CloudAgentIdentity): CloudAgentIdentity {
    const existing = this.readAgent(agent.id);
    if (existing && existing.createdBy !== agent.createdBy) throw new Error("System agent ID belongs to another user");
    const next: CloudAgentIdentity = existing
      ? { ...existing, name: agent.name, description: agent.description, modelPolicy: agent.modelPolicy, capabilities: agent.capabilities, budgetUsd: agent.budgetUsd, updatedAt: agent.updatedAt }
      : agent;
    if (existing && JSON.stringify({ ...existing, updatedAt: "" }) === JSON.stringify({ ...next, updatedAt: "" })) return existing;
    this.put("agent", next.id, next, { ownerId: next.createdBy, updatedAt: next.updatedAt });
    if (!existing) this.audit(next.createdBy, "agent.created", "agent", next.id, { system: true, modelPolicy: next.modelPolicy, budgetUsd: next.budgetUsd }, next.createdAt);
    return next;
  }

  /** Records one completed model call as an agent run and adds its cost to the agent's spend. */
  recordAgentUsage(input: { runId: string; agentId: string; triggeredBy: string; trigger: AgentRun["trigger"]; documentId?: string; costUsd: number; startedAt: string; completedAt: string; output: Record<string, unknown> }): AgentRun {
    const agent = this.readAgent(input.agentId);
    if (!agent) throw new Error("Agent not found");
    const run: AgentRun = {
      id: input.runId,
      agentId: input.agentId,
      triggeredBy: input.triggeredBy,
      trigger: input.trigger,
      ...(input.documentId ? { documentId: input.documentId } : {}),
      status: "completed",
      requestedCapabilities: ["read_doc"],
      startedAt: input.startedAt,
      completedAt: input.completedAt,
      costUsd: input.costUsd,
      output: input.output,
    };
    const transaction = this.db.transaction(() => {
      const current = this.readAgent(input.agentId) ?? agent;
      this.put("agent_run", run.id, run, { ownerId: run.agentId, documentId: run.documentId, updatedAt: input.completedAt });
      this.put("agent", current.id, { ...current, spentUsd: round(current.spentUsd + input.costUsd, 6), updatedAt: input.completedAt }, { ownerId: current.createdBy, updatedAt: input.completedAt });
    });
    transaction();
    this.audit(input.triggeredBy, "agent.run_completed", "agent", input.agentId, { runId: run.id, costUsd: input.costUsd, ...input.output }, input.completedAt);
    return run;
  }

  putConnector(connector: KnowledgeConnector): KnowledgeConnector {
    const policy = this.enterprisePolicy();
    if (!policy.connectorAllowlist.includes(connector.kind)) throw new Error(`Connector is not allowed: ${connector.kind}`);
    this.put("connector", connector.id, connector, { ownerId: connector.createdBy, siteId: connector.siteId, updatedAt: connector.updatedAt });
    this.audit(connector.createdBy, "connector.saved", "connector", connector.id, { kind: connector.kind, siteId: connector.siteId }, connector.updatedAt);
    return connector;
  }

  listConnectors(siteIds?: string[]): KnowledgeConnector[] {
    const allowed = siteIds ? new Set(siteIds) : undefined;
    return this.list<KnowledgeConnector>("connector").filter((connector) => !allowed || (connector.siteId && allowed.has(connector.siteId)));
  }

  syncConnectorSource(source: ConnectorSourceRecord, actorId: string): ConnectorSourceRecord {
    const connector = this.get<KnowledgeConnector>("connector", source.connectorId);
    if (!connector || connector.status === "disabled") throw new Error("Active connector not found");
    const previous = this.get<ConnectorSourceRecord>("connector_source", source.id);
    const next: ConnectorSourceRecord = {
      ...source,
      lineage: [...(previous?.lineage ?? []), ...(source.lineage ?? [])].filter((value, index, all) => all.indexOf(value) === index),
    };
    this.put("connector_source", source.id, next, { ownerId: connector.createdBy, documentId: source.documentId, siteId: connector.siteId, updatedAt: source.syncedAt });
    this.audit(actorId, source.tombstonedAt ? "connector.source_tombstoned" : "connector.source_synced", "connector_source", source.id, { connectorId: source.connectorId, documentId: source.documentId, sourceUrl: source.sourceUrl, upstreamModifiedAt: source.upstreamModifiedAt }, source.syncedAt);
    return next;
  }

  listConnectorSources(connectorId: string): ConnectorSourceRecord[] {
    return this.list<ConnectorSourceRecord>("connector_source").filter((source) => source.connectorId === connectorId);
  }

  recipes(): AgentRecipe[] {
    const custom = this.list<AgentRecipe>("recipe");
    const customIds = new Set(custom.map((recipe) => recipe.id));
    return [...custom, ...builtInRecipes.filter((recipe) => !customIds.has(recipe.id))];
  }

  putRecipe(recipe: AgentRecipe): AgentRecipe {
    this.put("recipe", recipe.id, recipe, { ownerId: recipe.createdBy, siteId: recipe.siteId, updatedAt: recipe.updatedAt });
    this.audit(recipe.createdBy, "recipe.saved", "recipe", recipe.id, { trigger: recipe.trigger, capabilitySet: recipe.capabilitySet }, recipe.updatedAt);
    return recipe;
  }

  runRecipe(run: RecipeRun): RecipeRun {
    const recipe = this.recipes().find((item) => item.id === run.recipeId);
    if (!recipe || !recipe.enabled) throw new Error("Enabled recipe not found");
    if (!recipe.trigger.modes.includes(run.triggerMode)) throw new Error("Recipe trigger mode is not allowed");
    const planned: RecipeRun = {
      ...run,
      status: "planned",
      plan: recipe.steps,
      mutationPolicy: "proof_proposal_only",
    };
    this.put("recipe_run", run.id, planned, { ownerId: run.triggeredBy, siteId: recipe.siteId, updatedAt: run.startedAt });
    this.audit(run.triggeredBy, "recipe.run_planned", "recipe", recipe.id, { runId: run.id, triggerMode: run.triggerMode }, run.startedAt);
    return planned;
  }

  listRecipeRuns(recipeId?: string): RecipeRun[] {
    return this.list<RecipeRun>("recipe_run").filter((run) => !recipeId || run.recipeId === recipeId);
  }

  semanticCollections(documents: KnowledgeDocumentAccess[], now: string): SemanticCollection[] {
    this.indexDocuments(documents, now);
    const allowed = new Set(documents.map((item) => item.document.id));
    const blocks = this.indexedBlocks(documents);
    const collection = (id: SemanticCollectionId, title: string, predicate: (block: IndexedBlock) => boolean): SemanticCollection => ({
      id,
      title,
      generatedAt: now,
      items: blocks.filter(predicate).map(collectionItem),
    });
    return [
      collection("open_decisions", "Open decisions", (block) => block.contentType === "decision" && !["accepted", "closed", "done"].includes(String(block.attrs.status ?? "open"))),
      collection("claims_missing_evidence", "Claims missing evidence", (block) => block.contentType === "claim" && !block.attrs.evidence && !block.attrs.source && !block.trust.sourceOf?.length),
      collection("risks_by_owner", "Risks by owner", (block) => block.contentType === "risk"),
      collection("stale_citations", "Stale citations", (block) => (block.contentType === "citation" || Boolean(block.trust.sourceOf?.length)) && block.freshness.state !== "current"),
      collection("pending_agent_changes", "Agent changes awaiting review", () => false),
    ];
  }

  gatewayCapabilities(): AgentGatewayCapability[] {
    return [
      { operation: "search", method: "GET", path: "/api/search", permission: "viewer" },
      { operation: "cited_answer", method: "POST", path: "/api/ask", permission: "viewer" },
      { operation: "list_ids", method: "POST", path: "/api/gateway/list-ids", permission: "viewer" },
      { operation: "llm_export", method: "GET", path: "/api/knowledge/llm", permission: "viewer" },
      { operation: "proof", method: "POST", path: "/api/documents/:id/patch-proposals", permission: "editor" },
      { operation: "proposal", method: "POST", path: "/api/documents/:id/patch-proposals", permission: "editor" },
      { operation: "review", method: "POST", path: "/api/documents/:id/patch-proposals/:proposal/review", permission: "editor" },
      { operation: "apply", method: "POST", path: "/api/documents/:id/patch-proposals/:proposal/apply", permission: "editor" },
      { operation: "webhook", method: "POST", path: "/api/gateway/webhooks/:recipe", permission: "editor" },
      { operation: "assignments", method: "GET", path: "/api/agents/:id/assignments", permission: "viewer" },
      { operation: "reply", method: "POST", path: "/api/agents/:id/assignments/:assignment/reply", permission: "viewer" },
      { operation: "update_assignment", method: "POST", path: "/api/agents/:id/assignments/:assignment/status", permission: "viewer" },
    ];
  }

  recordAnalytics(event: AnalyticsEvent): AnalyticsEvent {
    this.put("analytics", event.id, event, { ownerId: event.actorId, documentId: event.documentId, updatedAt: event.createdAt });
    return event;
  }

  analytics(actorId: string, accessibleDocumentIds: string[]): AnalyticsSummary {
    const allowed = new Set(accessibleDocumentIds);
    const events = this.db
      .prepare("SELECT data_json FROM cloud_platform_records WHERE kind = 'analytics' AND (owner_id = ? OR document_id IN (SELECT value FROM json_each(?))) ORDER BY updated_at DESC, id")
      .all(actorId, JSON.stringify([...allowed]))
      .map((row) => JSON.parse((row as PlatformRow).data_json) as AnalyticsEvent)
      .filter((event) => event.actorId === actorId || (event.documentId !== undefined && allowed.has(event.documentId)));
    const counts = Object.fromEntries(["no_result", "answer_generated", "citation_opened", "answer_rejected", "task_completed"].map((type) => [type, events.filter((event) => event.type === type).length])) as Record<AnalyticsEvent["type"], number>;
    return {
      counts,
      total: events.length,
      noResultQueries: events.filter((event) => event.type === "no_result" && event.query).map((event) => event.query!),
      scope: { actorId, accessibleDocumentIds: [...allowed].sort() },
    };
  }

  exportBackup(
    documents: CloudDocumentRecord[],
    exportedAt: string,
    git?: { repository: string; branch: string; pullRequestReview: boolean },
    attachments: Array<NomaBackupAttachment & { data: string }> = [],
  ): NomaBackupBundle {
    const files = [...documents].sort((left, right) => left.id.localeCompare(right.id)).map((document) => ({
      path: `documents/${document.id}.noma`,
      documentId: document.id,
      title: document.title,
      hash: document.hash,
      source: document.source.replace(/\r\n?/g, "\n"),
      updatedAt: document.updatedAt,
    }));
    const sortedAttachments = [...attachments].sort((left, right) => left.path.localeCompare(right.path));
    const manifest = {
      format: "noma-cloud-backup-v1" as const,
      exportedAt,
      files: files.map(({ source: _source, ...file }) => file),
      ...(git ? { git } : {}),
      ...(sortedAttachments.length > 0 ? { attachments: sortedAttachments.map(({ data: _data, ...attachment }) => attachment) } : {}),
    };
    return {
      manifest,
      files,
      ...(sortedAttachments.length > 0 ? { attachments: sortedAttachments } : {}),
      digest: sha256Hex(`${JSON.stringify(manifest)}\n${files.map((file) => `${file.path}\n${file.source}`).join("\n")}`),
    };
  }

  planBackupImport(bundle: NomaBackupBundle, current: CloudDocumentRecord[]): BackupImportPlan {
    const currentById = new Map(current.map((document) => [document.id, document]));
    const create: BackupImportPlan["create"] = [];
    const update: BackupImportPlan["update"] = [];
    const unchanged: string[] = [];
    const conflicts: BackupConflict[] = [];
    for (const file of [...bundle.files].sort((left, right) => left.documentId.localeCompare(right.documentId))) {
      const actualHash = sha256Hex(file.source);
      if (actualHash !== file.hash) {
        conflicts.push({ documentId: file.documentId, type: "corrupt_bundle", backupHash: file.hash, actualHash });
        continue;
      }
      const existing = currentById.get(file.documentId);
      if (!existing) create.push(file);
      else if (existing.hash === file.hash) unchanged.push(file.documentId);
      else if (existing.updatedAt > bundle.manifest.exportedAt) conflicts.push({ documentId: file.documentId, type: "concurrent_edit", backupHash: file.hash, currentHash: existing.hash });
      else update.push({ file, expectedHash: existing.hash });
    }
    return { create, update, unchanged, conflicts, pullRequestReview: bundle.manifest.git?.pullRequestReview === true };
  }

  saveOfflineDraft(draft: OfflineDraft): OfflineDraft {
    this.put("offline_draft", draft.id, draft, { ownerId: draft.userId, documentId: draft.documentId, updatedAt: draft.updatedAt });
    return draft;
  }

  listOfflineDrafts(userId: string, page?: PlatformPage): OfflineDraft[] {
    return this.list<OfflineDraft>("offline_draft", { ownerId: userId }, page).filter((draft) => draft.userId === userId);
  }

  readOfflineDraft(userId: string, draftId: string): OfflineDraft | undefined {
    const draft = this.get<OfflineDraft>("offline_draft", draftId);
    return draft?.userId === userId ? draft : undefined;
  }

  countOfflineDrafts(userId: string): number {
    return this.count("offline_draft", userId);
  }

  /** Analytics events recorded by `actorId` at or after `since`. */
  countAnalyticsSince(actorId: string, since: string): number {
    const row = this.db
      .prepare("SELECT COUNT(*) AS count FROM cloud_platform_records WHERE kind = 'analytics' AND owner_id = ? AND created_at >= ?")
      .get(actorId, since) as { count: number };
    return row.count;
  }

  /** Drops an actor's analytics older than `before`, then trims to the newest `keep` events. */
  pruneAnalytics(actorId: string, before: string, keep: number): number {
    const expired = this.db
      .prepare("DELETE FROM cloud_platform_records WHERE kind = 'analytics' AND owner_id = ? AND created_at < ?")
      .run(actorId, before).changes;
    const overflow = this.db
      .prepare(
        `DELETE FROM cloud_platform_records WHERE kind = 'analytics' AND owner_id = ? AND id NOT IN (
           SELECT id FROM cloud_platform_records WHERE kind = 'analytics' AND owner_id = ? ORDER BY created_at DESC, id DESC LIMIT ?
         )`,
      )
      .run(actorId, actorId, keep).changes;
    return expired + overflow;
  }

  mergeOfflineDraft(draftId: string, currentSource: string, currentHash: string, now: string): OfflineMergeResult {
    const draft = this.get<OfflineDraft>("offline_draft", draftId);
    if (!draft) throw new Error("Offline draft not found");
    if (draft.baseHash === currentHash) return { state: "clean", source: draft.source, expectedHash: currentHash, conflicts: [], mergedAt: now };
    const merge = threeWayMerge(draft.baseSource, currentSource, draft.source);
    return { state: merge.conflicts.length === 0 ? "merged" : "conflict", source: merge.source, expectedHash: currentHash, conflicts: merge.conflicts, mergedAt: now };
  }

  recordRealtimeOperation(operation: RealtimeOperation): RealtimeOperation {
    if (operation.actorType !== "human") throw new Error("Realtime operations are reserved for humans; agents use asynchronous proof proposals");
    const prior = this.list<RealtimeOperation>("realtime_operation", { documentId: operation.documentId }).filter((item) => item.documentId === operation.documentId);
    const expectedSequence = prior.reduce((max, item) => Math.max(max, item.sequence), 0) + 1;
    if (operation.sequence !== expectedSequence) throw new Error(`Realtime sequence must be ${expectedSequence}`);
    this.put("realtime_operation", operation.id, operation, { ownerId: operation.userId, documentId: operation.documentId, updatedAt: operation.createdAt });
    this.audit(operation.userId, "realtime.operation_applied", "document", operation.documentId, { operationId: operation.id, sequence: operation.sequence, baseHash: operation.baseHash, resultHash: operation.resultHash, affectedIds: operation.affectedIds }, operation.createdAt);
    return operation;
  }

  realtimeOperations(documentId: string, afterSequence = 0, limit = Number.POSITIVE_INFINITY): RealtimeOperation[] {
    return this.list<RealtimeOperation>("realtime_operation", { documentId })
      .filter((operation) => operation.documentId === documentId && operation.sequence > afterSequence)
      .sort((left, right) => left.sequence - right.sequence)
      .slice(0, limit);
  }

  enterprisePolicy(): EnterprisePolicy {
    return this.get<EnterprisePolicy>("enterprise_policy", "workspace") ?? defaultEnterprisePolicy;
  }

  setEnterprisePolicy(policy: EnterprisePolicy): EnterprisePolicy {
    if (policy.retentionDays < 1) throw new Error("Retention must be at least one day");
    if (policy.connectorAllowlist.length === 0) throw new Error("Connector allowlist cannot be empty");
    if (policy.modelAllowlist.length === 0) throw new Error("Model allowlist cannot be empty");
    this.put("enterprise_policy", "workspace", policy, { ownerId: policy.updatedBy, updatedAt: policy.updatedAt });
    this.audit(policy.updatedBy, "enterprise.policy_updated", "workspace", "workspace", { ...policy }, policy.updatedAt);
    return policy;
  }

  upsertScimIdentity(identity: ScimIdentity, actorId: string): ScimIdentity {
    if (!this.enterprisePolicy().scim.enabled) throw new Error("SCIM is not enabled");
    this.put("scim_identity", identity.id, identity, { ownerId: identity.userId, updatedAt: identity.updatedAt });
    this.audit(actorId, "scim.identity_upserted", "user", identity.userId, { externalId: identity.externalId, active: identity.active, groups: identity.groups }, identity.updatedAt);
    return identity;
  }

  listScimIdentities(page?: PlatformPage): ScimIdentity[] {
    return this.list<ScimIdentity>("scim_identity", {}, page);
  }

  putLegalHold(hold: LegalHold): LegalHold {
    if (!this.enterprisePolicy().legalHoldEnabled) throw new Error("Legal hold is not enabled");
    this.put("legal_hold", hold.id, hold, { ownerId: hold.createdBy, documentId: hold.resourceType === "document" ? hold.resourceId : undefined, updatedAt: hold.createdAt });
    this.audit(hold.createdBy, "legal_hold.created", hold.resourceType, hold.resourceId, { holdId: hold.id, reason: hold.reason }, hold.createdAt);
    return hold;
  }

  listLegalHolds(page?: PlatformPage): LegalHold[] {
    return this.list<LegalHold>("legal_hold", {}, page);
  }

  exportAudit(actorId: string, accessibleResourceIds: string[]): AuditExport {
    const policy = this.enterprisePolicy();
    if (!policy.auditExportEnabled) throw new Error("Audit export is disabled");
    const allowed = new Set(accessibleResourceIds);
    const rows = this.db.prepare("SELECT id, actor_id, action, resource_type, resource_id, detail_json, created_at FROM cloud_platform_audit ORDER BY sequence").all() as Array<{ id: string; actor_id: string; action: string; resource_type: string; resource_id: string; detail_json: string; created_at: string }>;
    const events = rows
      .filter((row) => row.actor_id === actorId || allowed.has(row.resource_id) || row.resource_type === "workspace")
      .map((row): AuditRecord => ({ id: row.id, actorId: row.actor_id, action: row.action, resourceType: row.resource_type, resourceId: row.resource_id, detail: JSON.parse(row.detail_json) as Record<string, unknown>, createdAt: row.created_at }));
    return { format: "noma-cloud-audit-v1", dataResidency: policy.dataResidency, events, digest: sha256Hex(JSON.stringify(events)) };
  }

  enforceRetention(now: string): { deleted: number; protectedByLegalHold: number } {
    const policy = this.enterprisePolicy();
    const cutoff = new Date(Date.parse(now) - policy.retentionDays * 86_400_000).toISOString();
    const heldResources = new Set(this.listLegalHolds().filter((hold) => !hold.releasedAt).map((hold) => hold.resourceId));
    const candidates = this.db.prepare("SELECT kind, id, document_id FROM cloud_platform_records WHERE updated_at < ? AND kind NOT IN ('enterprise_policy', 'legal_hold')").all(cutoff) as Array<{ kind: PlatformKind; id: string; document_id: string | null }>;
    let deleted = 0;
    let protectedByLegalHold = 0;
    for (const candidate of candidates) {
      if (candidate.document_id && heldResources.has(candidate.document_id)) {
        protectedByLegalHold += 1;
        continue;
      }
      this.db.prepare("DELETE FROM cloud_platform_records WHERE kind = ? AND id = ?").run(candidate.kind, candidate.id);
      deleted += 1;
    }
    if (deleted > 0) this.indexedBlockCache.clear();
    return { deleted, protectedByLegalHold };
  }

  private applySchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS cloud_platform_records (
        kind TEXT NOT NULL,
        id TEXT NOT NULL,
        owner_id TEXT,
        document_id TEXT,
        site_id TEXT,
        data_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (kind, id)
      );
      CREATE TABLE IF NOT EXISTS cloud_platform_audit (
        sequence INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        actor_id TEXT NOT NULL,
        action TEXT NOT NULL,
        resource_type TEXT NOT NULL,
        resource_id TEXT NOT NULL,
        detail_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_cloud_platform_kind_document ON cloud_platform_records(kind, document_id, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_cloud_platform_owner ON cloud_platform_records(kind, owner_id, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_cloud_platform_audit_time ON cloud_platform_audit(created_at, sequence);
      CREATE TABLE IF NOT EXISTS block_embeddings (
        provider TEXT NOT NULL,
        model TEXT NOT NULL,
        text_hash TEXT NOT NULL,
        dimensions INTEGER NOT NULL,
        vector BLOB NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (provider, model, text_hash)
      );
    `);
  }

  private put<T extends object>(kind: PlatformKind, id: string, value: T, metadata: { ownerId?: string; documentId?: string; siteId?: string; updatedAt: string }): void {
    const existing = this.db.prepare("SELECT created_at FROM cloud_platform_records WHERE kind = ? AND id = ?").get(kind, id) as { created_at: string } | undefined;
    this.db.prepare(`
      INSERT INTO cloud_platform_records (kind, id, owner_id, document_id, site_id, data_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(kind, id) DO UPDATE SET owner_id = excluded.owner_id, document_id = excluded.document_id,
        site_id = excluded.site_id, data_json = excluded.data_json, updated_at = excluded.updated_at
    `).run(kind, id, metadata.ownerId ?? null, metadata.documentId ?? null, metadata.siteId ?? null, JSON.stringify(value), existing?.created_at ?? metadata.updatedAt, metadata.updatedAt);
  }

  private get<T>(kind: PlatformKind, id: string): T | undefined {
    const row = this.db.prepare("SELECT data_json FROM cloud_platform_records WHERE kind = ? AND id = ?").get(kind, id) as { data_json: string } | undefined;
    return row ? JSON.parse(row.data_json) as T : undefined;
  }

  private list<T>(kind: PlatformKind, filter: { ownerId?: string; documentId?: string } = {}, page?: PlatformPage): T[] {
    const clauses = ["kind = ?"];
    const params: Array<string | number> = [kind];
    if (filter.ownerId !== undefined) {
      clauses.push("owner_id = ?");
      params.push(filter.ownerId);
    }
    if (filter.documentId !== undefined) {
      clauses.push("document_id = ?");
      params.push(filter.documentId);
    }
    if (page) params.push(page.limit, page.offset);
    return this.db
      .prepare(`SELECT id, data_json FROM cloud_platform_records WHERE ${clauses.join(" AND ")} ORDER BY updated_at DESC, id${page ? " LIMIT ? OFFSET ?" : ""}`)
      .all(...params)
      .map((row) => JSON.parse((row as PlatformRow).data_json) as T);
  }

  private count(kind: PlatformKind, ownerId: string): number {
    const row = this.db.prepare("SELECT COUNT(*) AS count FROM cloud_platform_records WHERE kind = ? AND owner_id = ?").get(kind, ownerId) as { count: number };
    return row.count;
  }

  private audit(actorId: string, action: string, resourceType: string, resourceId: string, detail: Record<string, unknown>, createdAt: string): AuditRecord {
    const record: AuditRecord = {
      id: sha256Hex(`${actorId}:${action}:${resourceType}:${resourceId}:${createdAt}:${JSON.stringify(detail)}`).slice(0, 32),
      actorId,
      action,
      resourceType,
      resourceId,
      detail,
      createdAt,
    };
    this.db.prepare("INSERT OR IGNORE INTO cloud_platform_audit (id, actor_id, action, resource_type, resource_id, detail_json, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)")
      .run(record.id, record.actorId, record.action, record.resourceType, record.resourceId, JSON.stringify(record.detail), record.createdAt);
    return record;
  }
}

class QueryEmbeddingTimeout extends Error {
  constructor() {
    super("Query embedding timed out");
  }
}

function blockTextHash(block: IndexedBlock): string {
  if (!block.textHash) block.textHash = embeddingTextHash(block.searchableText);
  return block.textHash;
}

function encodeVector(vector: number[]): Buffer {
  const floats = Float32Array.from(vector);
  return Buffer.from(floats.buffer, floats.byteOffset, floats.byteLength);
}

function decodeVector(buffer: Buffer): Float32Array {
  const copy = new Uint8Array(buffer.byteLength);
  copy.set(buffer);
  return new Float32Array(copy.buffer, 0, Math.floor(copy.byteLength / 4));
}

function sortIndexedBlocks(blocks: IndexedBlock[]): IndexedBlock[] {
  return [...blocks].sort((left, right) => left.sourceSpan.line - right.sourceSpan.line || left.id.localeCompare(right.id));
}

function indexDocument(document: CloudDocumentRecord, trustRecords: KnowledgeTrust[], now: string): IndexedBlock[] {
  const doc = parse(document.source, { filename: `${document.id}.noma` });
  const lines = document.source.replace(/\r\n?/g, "\n").split("\n");
  const trustByBlock = new Map(trustRecords.map((trust) => [trust.blockId, trust]));
  const blocks: IndexedBlock[] = [];
  const visit = (node: Node, inheritedId?: string): void => {
    const blockId = node.id ?? inheritedId;
    if (blockId && node.type !== "document" && node.type !== "frontmatter" && node.pos) {
      const endLine = node.endLine ?? node.pos.line;
      const exactSource = lines.slice(node.pos.line - 1, endLine).join("\n");
      const contentType = node.type === "directive" ? node.name : node.type;
      const attrs = node.type === "directive" ? node.attrs : {};
      const title = node.type === "section" ? node.title : stringAttr(attrs.title) ?? stringAttr(attrs.label);
      const trust = trustByBlock.get(blockId) ?? trustFromAttrs(document.id, blockId, attrs, document, now);
      const freshness = freshnessFor(trust, document.updatedAt, now);
      const searchableText = [title, contentType, exactSource, Object.entries(attrs).map(([key, value]) => `${key} ${String(value)}`).join(" ")].filter(Boolean).join("\n");
      const recordId = sha256Hex(`${document.id}:${document.hash}:${blockId}:${node.pos.line}:${endLine}:${contentType}`).slice(0, 32);
      blocks.push({
        id: recordId,
        kind: "rag_block",
        recordId,
        documentId: document.id,
        documentTitle: document.title,
        blockId,
        sourceSpan: { line: node.pos.line, endLine, column: node.pos.column },
        versionHash: document.hash,
        contentType,
        ...(title ? { title } : {}),
        exactSource,
        searchableText,
        attrs,
        embedding: embed(searchableText),
        textHash: embeddingTextHash(searchableText),
        trust,
        freshness,
        provenance: trust.sourceOf?.length ? trust.sourceOf : [`noma:${document.id}@${document.hash}#${blockId}`],
        createdAt: document.createdAt,
        updatedAt: document.updatedAt,
      });
    }
    if (node.type === "document" || node.type === "section" || node.type === "directive") {
      for (const child of node.children) visit(child, blockId);
    } else if (node.type === "list") {
      for (const item of node.items) visit(item, blockId);
    }
  };
  visit(doc);
  return blocks;
}

function trustFromAttrs(documentId: string, blockId: string, attrs: Attrs, document: CloudDocumentRecord, now: string): KnowledgeTrust {
  return {
    documentId,
    blockId,
    ownerId: stringAttr(attrs.owner),
    verifiedBy: stringAttr(attrs.verified_by),
    verifiedAt: stringAttr(attrs.verified_at),
    reviewBy: stringAttr(attrs.review_by),
    supersedes: listAttr(attrs.supersedes),
    canonicalFor: listAttr(attrs.canonical_for),
    sourceOf: listAttr(attrs.source_of),
    provenance: { canonicalSource: "noma", documentHash: document.hash },
    updatedAt: now,
    updatedBy: document.updatedBy,
  };
}

function freshnessFor(trust: KnowledgeTrust, documentUpdatedAt: string, now: string): KnowledgeRetrievalRecord["freshness"] {
  const current = Date.parse(now);
  const review = trust.reviewBy ? Date.parse(trust.reviewBy) : Number.NaN;
  if (Number.isFinite(review)) {
    if (review < current) return { state: "stale", score: 0, reviewBy: trust.reviewBy };
    if (review - current < 30 * 86_400_000) return { state: "review_due", score: 0.5, reviewBy: trust.reviewBy };
    return { state: "current", score: 1, reviewBy: trust.reviewBy };
  }
  const ageDays = Math.max(0, (current - Date.parse(documentUpdatedAt)) / 86_400_000);
  if (ageDays > 365) return { state: "stale", score: 0.2 };
  if (ageDays > 180) return { state: "review_due", score: 0.6 };
  return { state: "current", score: 0.9 };
}



function lexicalScore(query: string[], document: string[]): number {
  if (query.length === 0 || document.length === 0) return 0;
  const counts = new Map<string, number>();
  for (const token of document) counts.set(token, (counts.get(token) ?? 0) + 1);
  const matches = query.reduce((sum, token) => sum + (counts.has(token) ? 1 : 0), 0);
  return Math.min(1, matches / query.length);
}

function typedScore(query: string[], block: IndexedBlock): number {
  const typeTokens = new Set(tokens(`${block.contentType} ${Object.keys(block.attrs).join(" ")}`));
  return query.length === 0 ? 0 : query.filter((token) => typeTokens.has(token)).length / query.length;
}


function stripStored(block: IndexedBlock): Omit<KnowledgeRetrievalRecord, "accessDecision" | "score" | "scoreParts"> {
  const { id: _id, kind: _kind, ownerId: _ownerId, siteId: _siteId, createdAt: _createdAt, updatedAt: _updatedAt, textHash: _textHash, ...record } = block;
  return record;
}

function retrievalFromIndexed(block: IndexedBlock, now: string): KnowledgeRetrievalRecord {
  return {
    ...stripStored(block),
    accessDecision: { principalId: "health", allowed: true, role: "viewer", via: "user", decidedAt: now },
    score: 1,
    scoreParts: { lexical: 0, semantic: 0, typed: 0, graph: 0, verification: 0, freshness: block.freshness.score },
  };
}

/** Drop hash-similarity noise: a keyword query must share a word, unless a real embedding is a strong paraphrase. */
function relevantRetrieval(queryTokens: string[], result: KnowledgeRetrievalRecord): boolean {
  if (queryTokens.length === 0) return result.score > 0.04;
  const lexical = result.scoreParts.lexical > 0;
  const paraphrase = result.scoreParts.semantic >= 0.75;
  return (lexical || paraphrase) && result.score > 0.08;
}

function uniqueCitations(results: KnowledgeRetrievalRecord[]): KnowledgeRetrievalRecord[] {
  const seen = new Set<string>();
  return results.filter((result) => {
    const key = `${result.documentId}:${result.blockId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** Keep citations close to the best hit and collapse repeated excerpts from copied pages. */
function selectCitations(results: KnowledgeRetrievalRecord[]): KnowledgeRetrievalRecord[] {
  const unique = uniqueCitations(results);
  const best = unique[0];
  if (!best) return [];
  const floor = Math.max(0.16, best.score * 0.45);
  const seenText = new Set<string>();
  return unique
    .filter((result) => result.score >= floor && (result.scoreParts.lexical > 0 || result.scoreParts.semantic >= 0.75))
    .filter((result) => {
      const key = summarizeSource(result.exactSource).toLocaleLowerCase();
      if (!key || seenText.has(key)) return false;
      seenText.add(key);
      return true;
    })
    .slice(0, 5);
}

function citationConfidence(citations: KnowledgeRetrievalRecord[]): number {
  if (citations.length === 0) return 0;
  const top = citations[0]?.score ?? 0;
  const mean = citations.reduce((sum, item) => sum + item.score, 0) / citations.length;
  return round(top * 0.7 + mean * 0.3);
}

function answerFromCitations(citations: KnowledgeRetrievalRecord[], conflicts: AskNomaResult["conflicts"]): string {
  const statements = citations.map((citation, index) => `${summarizeSource(citation.exactSource)} [${index + 1}]`);
  const conflictNote = conflicts.length > 0 ? ` Conflicting source claims remain visible for ${conflicts.map((conflict) => conflict.concept).join(", ")}.` : "";
  return `${statements.join(" ")}${conflictNote}`.trim();
}

function summarizeSource(source: string): string {
  const clean = source.replace(/^:{2,64}[^\n]*\n?/, "").replace(/\n:{2,64}\s*$/, "").replace(/^#+\s+/gm, "").replace(/\s+/g, " ").trim();
  if (clean.length <= 280) return clean;
  return `${clean.slice(0, 277).trimEnd()}…`;
}

function detectConflicts(records: KnowledgeRetrievalRecord[]): AskNomaResult["conflicts"] {
  const byConcept = new Map<string, KnowledgeRetrievalRecord[]>();
  for (const record of records) {
    const concepts = record.trust.canonicalFor ?? [];
    for (const concept of concepts) {
      const group = byConcept.get(concept) ?? [];
      group.push(record);
      byConcept.set(concept, group);
    }
  }
  const conflicts: AskNomaResult["conflicts"] = [];
  for (const [concept, group] of byConcept) {
    if (group.length < 2) continue;
    const values = new Set(group.map((record) => conflictValue(record)));
    if (values.size > 1) conflicts.push({ concept, records: group.map((record) => record.recordId), reason: "Canonical sources assert different values or polarity" });
  }
  return conflicts;
}

function conflictValue(record: KnowledgeRetrievalRecord): string {
  const explicit = record.attrs.value ?? record.attrs.status ?? record.attrs.outcome ?? record.attrs.confidence;
  if (explicit !== undefined) return String(explicit).toLocaleLowerCase();
  const normalized = record.exactSource.toLocaleLowerCase();
  const polarity = /\b(?:not|never|false|rejected|failed|declined)\b/.test(normalized) ? "negative" : "positive";
  const numbers = normalized.match(/\b\d+(?:\.\d+)?%?\b/g)?.join(",") ?? "";
  return `${polarity}:${numbers}`;
}

function confidenceLabel(score: number): "low" | "medium" | "high" {
  if (score >= 0.62) return "high";
  if (score >= 0.32) return "medium";
  return "low";
}

function sourceMatches(record: KnowledgeRetrievalRecord, source: { documentId: string; blockId?: string }): boolean {
  return record.documentId === source.documentId && (!source.blockId || record.blockId === source.blockId);
}

function knowledgeLinks(documents: CloudDocumentRecord[]): Array<{ fromDocumentId: string; fromBlockId: string; target: string; toDocumentId?: string; toBlockId?: string }> {
  const targets = new Map<string, { documentId: string; blockId?: string }>();
  for (const document of documents) {
    targets.set(normalizeConcept(document.id), { documentId: document.id });
    targets.set(normalizeConcept(document.title), { documentId: document.id });
    const doc = parse(document.source, { filename: `${document.id}.noma` });
    visitNodes(doc, (node) => {
      if (node.id) targets.set(normalizeConcept(node.id), { documentId: document.id, blockId: node.id });
      for (const alias of node.aliases ?? []) targets.set(normalizeConcept(alias), { documentId: document.id, blockId: node.id });
    });
  }
  const links: Array<{ fromDocumentId: string; fromBlockId: string; target: string; toDocumentId?: string; toBlockId?: string }> = [];
  for (const document of documents) {
    const doc = parse(document.source, { filename: `${document.id}.noma` });
    visitNodes(doc, (node, inheritedId) => {
      const fromBlockId = node.id ?? inheritedId;
      if (!fromBlockId) return;
      const source = nodeText(node);
      for (const link of extractWikilinks(source)) {
        const base = link.target.split("#", 1)[0] ?? link.target;
        const resolved = targets.get(normalizeConcept(base));
        links.push({ fromDocumentId: document.id, fromBlockId, target: link.target, ...(resolved ? { toDocumentId: resolved.documentId, toBlockId: resolved.blockId } : {}) });
      }
    });
  }
  return links;
}

function visitNodes(node: Node, visitor: (node: Node, inheritedId?: string) => void, inheritedId?: string): void {
  visitor(node, inheritedId);
  const nextId = node.id ?? inheritedId;
  if (node.type === "document" || node.type === "section" || node.type === "directive") {
    for (const child of node.children) visitNodes(child, visitor, nextId);
  } else if (node.type === "list") {
    for (const item of node.items) visitNodes(item, visitor, nextId);
  }
}

function nodeText(node: Node): string {
  if (node.type === "paragraph" || node.type === "quote" || node.type === "code" || node.type === "list_item") return node.content;
  if (node.type === "section") return node.title;
  if (node.type === "directive") return node.body ?? "";
  if (node.type === "list") return node.items.map((item) => item.content).join("\n");
  if (node.type === "table") return [node.header, ...node.rows].flat().join(" ");
  return "";
}

function duplicatePairs(blocks: IndexedBlock[]): Array<{ left: IndexedBlock; right: IndexedBlock; similarity: number }> {
  const candidates = blocks.filter((block) => block.searchableText.length >= 32 && (block.contentType === "section" || block.contentType === "claim" || block.contentType === "decision" || block.contentType === "paragraph"));
  const pairs: Array<{ left: IndexedBlock; right: IndexedBlock; similarity: number }> = [];
  for (let leftIndex = 0; leftIndex < candidates.length; leftIndex++) {
    for (let rightIndex = leftIndex + 1; rightIndex < candidates.length; rightIndex++) {
      const left = candidates[leftIndex]!;
      const right = candidates[rightIndex]!;
      if (left.documentId === right.documentId && left.blockId === right.blockId) continue;
      const similarity = round(cosine(left.embedding, right.embedding));
      if (similarity >= 0.76) pairs.push({ left, right, similarity });
    }
  }
  return pairs.sort((left, right) => right.similarity - left.similarity || left.left.recordId.localeCompare(right.left.recordId));
}

function healthItem(kind: KnowledgeHealthKind, documentId: string | undefined, blockId: string | undefined, message: string, evidence: Record<string, unknown>, severity: KnowledgeHealthItem["severity"], relatedDocumentId?: string): KnowledgeHealthItem {
  return {
    id: sha256Hex(`${kind}:${documentId ?? ""}:${blockId ?? ""}:${message}:${JSON.stringify(evidence)}`).slice(0, 24),
    kind,
    severity,
    ...(documentId ? { documentId } : {}),
    ...(blockId ? { blockId } : {}),
    ...(relatedDocumentId ? { relatedDocumentId } : {}),
    message,
    evidence,
  };
}

function dedupeHealth(items: KnowledgeHealthItem[]): KnowledgeHealthItem[] {
  return [...new Map(items.map((item) => [item.id, item])).values()].sort((left, right) => severityRank(right.severity) - severityRank(left.severity) || left.kind.localeCompare(right.kind));
}

function severityRank(severity: KnowledgeHealthItem["severity"]): number {
  return severity === "error" ? 3 : severity === "warning" ? 2 : 1;
}

function stringAttr(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function listAttr(value: unknown): string[] | undefined {
  const string = stringAttr(value);
  return string ? string.split(/[;,]/).map((item) => item.trim()).filter(Boolean) : undefined;
}

function normalizeConcept(value: string): string {
  return value.normalize("NFKC").toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim();
}

function round(value: number, digits = 4): number {
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

export interface AnalyticsEvent {
  id: string;
  type: "no_result" | "answer_generated" | "citation_opened" | "answer_rejected" | "task_completed";
  actorId: string;
  documentId?: string;
  query?: string;
  resultCount?: number;
  createdAt: string;
}

export interface EnterprisePolicy {
  id: "workspace";
  sso: { enabled: boolean; provider: "none" | "oidc" | "saml"; issuer?: string; enforced: boolean };
  scim: { enabled: boolean; baseUrl?: string };
  retentionDays: number;
  legalHoldEnabled: boolean;
  dataResidency: string;
  connectorAllowlist: ConnectorKind[];
  modelAllowlist: string[];
  requireZeroRetentionModels: boolean;
  auditExportEnabled: boolean;
  updatedAt: string;
  updatedBy: string;
}

export type ConnectorKind = "github" | "slack" | "google_drive" | "jira" | "linear" | "filesystem";

export interface AgentChangeInboxItem {
  id: string;
  documentId: string;
  documentHash: string;
  proposedBy: string;
  proposedByName: string;
  plan: string[];
  sources: Array<{ documentId: string; versionHash: string; blockIds: string[] }>;
  requestedCapabilities: string[];
  operations: unknown[];
  diff?: unknown;
  validation: { before?: unknown; after?: unknown; canWrite: boolean };
  affectedIds: string[];
  reviewerId?: string;
  status: CloudPatchProposal["status"];
  applyStatus: "awaiting_review" | "ready" | "rejected" | "applied";
  createdAt: string;
  updatedAt: string;
}

export interface CloudAgentIdentity {
  id: string;
  name: string;
  description?: string;
  createdBy: string;
  modelPolicy: { model: string; zeroRetention: boolean; maxTokensPerRun: number };
  capabilities: string[];
  budgetUsd: number;
  spentUsd: number;
  status: "active" | "paused" | "revoked";
  createdAt: string;
  updatedAt: string;
}

export interface AgentAccessGrant {
  id: string;
  agentId: string;
  resourceType: "document" | "site";
  resourceId: string;
  role: Exclude<CloudRole, "owner">;
  createdAt: string;
  updatedAt: string;
}

export type AgentAssignmentStatus = "open" | "in_progress" | "done" | "declined";

/**
 * Work handed to an agent by a person: an `@{agentId}` mention in a comment, or a page task
 * assigned to the agent. The agent reads it through the gateway, replies in the comment thread,
 * links the patch proposals it opens, and reports a final status.
 */
export interface AgentAssignment {
  id: string;
  agentId: string;
  documentId: string;
  source: "comment" | "task";
  commentId?: string;
  taskId?: string;
  blockId?: string;
  request: string;
  requestedBy: string;
  requestedByName: string;
  status: AgentAssignmentStatus;
  note?: string;
  proposalIds: string[];
  replyCommentIds: string[];
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
}

export type AgentRunStatus = "running" | "completed" | "failed" | "cancelled";

export interface AgentRun {
  id: string;
  agentId: string;
  triggeredBy: string;
  trigger: "manual" | "scheduled" | "event" | "webhook";
  documentId?: string;
  status: AgentRunStatus;
  requestedCapabilities: string[];
  startedAt: string;
  completedAt?: string;
  costUsd?: number;
  output?: Record<string, unknown>;
}

export interface KnowledgeConnector {
  id: string;
  kind: ConnectorKind;
  name: string;
  siteId?: string;
  status: "active" | "paused" | "disabled";
  configuration: Record<string, string | number | boolean>;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface ConnectorSourceRecord {
  id: string;
  connectorId: string;
  externalId: string;
  documentId?: string;
  upstreamPermissions: Array<{ principal: string; role: string }>;
  upstreamModifiedAt: string;
  sourceUrl: string;
  contentHash: string;
  lineage: string[];
  tombstonedAt?: string;
  syncedAt: string;
}

export type RecipeTriggerMode = "manual" | "scheduled" | "event" | "webhook";

export interface AgentRecipe {
  id: string;
  name: string;
  purpose: "stale_doc_review" | "meeting_to_decision" | "issue_to_runbook" | "research_refresh" | "onboarding_answers" | "release_maintenance" | "custom";
  siteId?: string;
  agentId?: string;
  trigger: { modes: RecipeTriggerMode[]; schedule?: string; event?: string; webhookSecretHash?: string };
  capabilitySet: string[];
  steps: string[];
  enabled: boolean;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface RecipeRun {
  id: string;
  recipeId: string;
  triggeredBy: string;
  triggerMode: RecipeTriggerMode;
  input: Record<string, unknown>;
  status: "planned" | "completed" | "failed";
  plan: string[];
  mutationPolicy: "proof_proposal_only";
  proposalIds?: string[];
  startedAt: string;
  completedAt?: string;
}

export type SemanticCollectionId = "open_decisions" | "claims_missing_evidence" | "risks_by_owner" | "stale_citations" | "pending_agent_changes";

export interface SemanticCollection {
  id: SemanticCollectionId;
  title: string;
  generatedAt: string;
  items: Array<{
    documentId: string;
    documentTitle: string;
    blockId: string;
    contentType: string;
    title?: string;
    ownerId?: string;
    freshness: KnowledgeRetrievalRecord["freshness"];
    versionHash: string;
  }>;
}

export interface AgentGatewayCapability {
  operation: "search" | "cited_answer" | "list_ids" | "llm_export" | "proof" | "proposal" | "review" | "apply" | "webhook" | "assignments" | "reply" | "update_assignment";
  method: "GET" | "POST";
  path: string;
  permission: "viewer" | "editor";
}

export interface AnalyticsSummary {
  counts: Record<AnalyticsEvent["type"], number>;
  total: number;
  noResultQueries: string[];
  scope: { actorId: string; accessibleDocumentIds: string[] };
}

export interface NomaBackupFile {
  path: string;
  documentId: string;
  title: string;
  hash: string;
  source: string;
  updatedAt: string;
}

/** Attachment metadata in a backup manifest; the bytes travel base64-encoded in `bundle.attachments`. */
export interface NomaBackupAttachment {
  path: string;
  id: string;
  documentId: string;
  filename: string;
  contentType: string;
  size: number;
  sha256: string;
}

export interface NomaBackupBundle {
  manifest: {
    format: "noma-cloud-backup-v1";
    exportedAt: string;
    files: Array<Omit<NomaBackupFile, "source">>;
    /** Present only when the export carried attachments; covered by `digest` through the manifest. */
    attachments?: NomaBackupAttachment[];
    git?: { repository: string; branch: string; pullRequestReview: boolean };
  };
  files: NomaBackupFile[];
  attachments?: Array<NomaBackupAttachment & { data: string }>;
  digest: string;
}

export interface BackupConflict {
  documentId: string;
  type: "corrupt_bundle" | "concurrent_edit";
  backupHash: string;
  actualHash?: string;
  currentHash?: string;
}

export interface BackupImportPlan {
  create: NomaBackupFile[];
  update: Array<{ file: NomaBackupFile; expectedHash: string }>;
  unchanged: string[];
  conflicts: BackupConflict[];
  pullRequestReview: boolean;
}

export interface OfflineDraft {
  id: string;
  userId: string;
  documentId: string;
  baseHash: string;
  baseSource: string;
  source: string;
  createdAt: string;
  updatedAt: string;
}

export interface OfflineMergeConflict {
  line: number;
  base: string;
  current: string;
  draft: string;
}

export interface OfflineMergeResult {
  state: "clean" | "merged" | "conflict";
  source: string;
  expectedHash: string;
  conflicts: OfflineMergeConflict[];
  mergedAt: string;
}

export interface RealtimeOperation {
  id: string;
  documentId: string;
  userId: string;
  actorType: "human";
  sequence: number;
  baseHash: string;
  resultHash: string;
  operations: unknown[];
  affectedIds: string[];
  proofStatus: "pass";
  createdAt: string;
}

export interface ScimIdentity {
  id: string;
  externalId: string;
  userId: string;
  userName: string;
  active: boolean;
  groups: string[];
  updatedAt: string;
}

export interface LegalHold {
  id: string;
  resourceType: "document" | "site" | "user";
  resourceId: string;
  reason: string;
  createdBy: string;
  createdAt: string;
  releasedAt?: string;
}

export interface AuditExport {
  format: "noma-cloud-audit-v1";
  dataResidency: string;
  events: AuditRecord[];
  digest: string;
}

const builtInRecipes: AgentRecipe[] = [
  recipe("stale-doc-review", "Stale document review", "stale_doc_review", ["manual", "scheduled"], ["Find review-due blocks", "Retrieve current sources", "Draft a proofed refresh proposal"]),
  recipe("meeting-to-decision", "Meeting to decision", "meeting_to_decision", ["manual", "event", "webhook"], ["Extract decisions and owners", "Resolve canonical concept pages", "Draft decision blocks for review"]),
  recipe("issue-to-runbook", "Issue to runbook", "issue_to_runbook", ["manual", "event", "webhook"], ["Read the completed issue", "Locate the owned runbook", "Propose a scoped runbook patch"]),
  recipe("research-refresh", "Research refresh", "research_refresh", ["manual", "scheduled"], ["Identify stale citations", "Retrieve permitted sources", "Propose claim and citation updates"]),
  recipe("onboarding-answers", "Onboarding answers", "onboarding_answers", ["manual", "event"], ["Collect unanswered onboarding queries", "Retrieve canonical policy pages", "Draft missing concept pages"]),
  recipe("release-maintenance", "Release maintenance", "release_maintenance", ["manual", "event", "webhook"], ["Read release changes", "Locate versioned documentation", "Propose deterministic maintenance patches"]),
];

function recipe(id: string, name: string, purpose: AgentRecipe["purpose"], modes: RecipeTriggerMode[], steps: string[]): AgentRecipe {
  return {
    id,
    name,
    purpose,
    trigger: { modes },
    capabilitySet: ["read_doc", "list_ids", "validate_doc", "patch_block"],
    steps,
    enabled: true,
    createdBy: "system",
    createdAt: "1970-01-01T00:00:00.000Z",
    updatedAt: "1970-01-01T00:00:00.000Z",
  };
}

function collectionItem(block: IndexedBlock): SemanticCollection["items"][number] {
  return {
    documentId: block.documentId,
    documentTitle: block.documentTitle,
    blockId: block.blockId,
    contentType: block.contentType,
    ...(block.title ? { title: block.title } : {}),
    ...(block.trust.ownerId ? { ownerId: block.trust.ownerId } : {}),
    freshness: block.freshness,
    versionHash: block.versionHash,
  };
}

function operationIds(value: unknown): string[] {
  if (!value || typeof value !== "object") return [];
  const operation = value as Record<string, unknown>;
  return [operation.id, operation.parentId, operation.to].filter((item): item is string => typeof item === "string" && item.length > 0);
}

function recordField(record: Record<string, unknown>, key: string): unknown {
  return Object.hasOwn(record, key) ? record[key] : undefined;
}

function threeWayMerge(baseSource: string, currentSource: string, draftSource: string): { source: string; conflicts: OfflineMergeConflict[] } {
  const base = baseSource.replace(/\r\n?/g, "\n").split("\n");
  const current = currentSource.replace(/\r\n?/g, "\n").split("\n");
  const draft = draftSource.replace(/\r\n?/g, "\n").split("\n");
  const length = Math.max(base.length, current.length, draft.length);
  const output: string[] = [];
  const conflicts: OfflineMergeConflict[] = [];
  for (let index = 0; index < length; index++) {
    const baseLine = base[index] ?? "";
    const currentLine = current[index] ?? "";
    const draftLine = draft[index] ?? "";
    if (currentLine === draftLine) output.push(currentLine);
    else if (currentLine === baseLine) output.push(draftLine);
    else if (draftLine === baseLine) output.push(currentLine);
    else {
      conflicts.push({ line: index + 1, base: baseLine, current: currentLine, draft: draftLine });
      output.push(`<!-- NOMA MERGE CONFLICT: CURRENT -->\n${currentLine}\n<!-- NOMA MERGE CONFLICT: OFFLINE DRAFT -->\n${draftLine}\n<!-- NOMA MERGE CONFLICT: END -->`);
    }
  }
  return { source: output.join("\n"), conflicts };
}
