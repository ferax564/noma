import DatabaseConstructor from "better-sqlite3";
import type { Database as SqliteDatabase } from "better-sqlite3";
import type { Attrs, Node } from "./ast.js";
import type { CloudDocumentRecord, CloudPatchProposal, CloudRole } from "./cloud-db.js";
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

export interface AskNomaResult {
  query: string;
  state: "answered" | "insufficient_evidence";
  answer: string;
  confidence: { score: number; label: "low" | "medium" | "high" };
  citations: Array<KnowledgeRetrievalRecord & { citation: number }>;
  conflicts: Array<{ concept: string; records: string[]; reason: string }>;
  latencyMs: number;
  estimatedCostUsd: number;
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
  Omit<StoredRecord, "documentId" | "kind"> & { documentId: string; kind: "rag_block" };

interface AuditRecord {
  id: string;
  actorId: string;
  action: string;
  resourceType: string;
  resourceId: string;
  detail: Record<string, unknown>;
  createdAt: string;
}

const vectorDimensions = 96;
const retrievalStopWords = new Set(["a", "an", "and", "are", "as", "at", "be", "by", "do", "does", "for", "from", "how", "in", "is", "it", "of", "on", "or", "the", "to", "was", "were", "what", "when", "where", "which", "who", "why", "with"]);
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

export class CloudKnowledgePlatform {
  private readonly db: SqliteDatabase;

  constructor(dbPath: string) {
    this.db = new DatabaseConstructor(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.db.pragma("busy_timeout = 5000");
    this.applySchema();
  }

  close(): void {
    this.db.close();
  }

  putTrust(trust: KnowledgeTrust): KnowledgeTrust {
    this.put("trust", `${trust.documentId}:${trust.blockId}`, trust, {
      ownerId: trust.ownerId,
      documentId: trust.documentId,
      updatedAt: trust.updatedAt,
    });
    this.db.prepare("DELETE FROM cloud_platform_records WHERE kind = 'rag_document' AND id = ?").run(trust.documentId);
    this.audit(trust.updatedBy, "trust.updated", "block", `${trust.documentId}:${trust.blockId}`, { ...trust }, trust.updatedAt);
    return trust;
  }

  trustFor(documentId: string, blockId: string): KnowledgeTrust | undefined {
    return this.get<KnowledgeTrust>("trust", `${documentId}:${blockId}`);
  }

  listTrust(documentIds: string[]): KnowledgeTrust[] {
    const allowed = new Set(documentIds);
    return this.list<KnowledgeTrust>("trust").filter((record) => allowed.has(record.documentId));
  }

  indexDocuments(documents: KnowledgeDocumentAccess[], now: string, force = false): number {
    const transaction = this.db.transaction(() => {
      let count = 0;
      for (const access of documents) {
        const indexed = this.get<{ versionHash: string }>("rag_document", access.document.id);
        if (!force && indexed?.versionHash === access.document.hash) continue;
        this.db.prepare("DELETE FROM cloud_platform_records WHERE kind = 'rag_block' AND document_id = ?").run(access.document.id);
        for (const block of indexDocument(access.document, this.listTrust([access.document.id]), now)) {
          this.put("rag_block", block.id, block, { documentId: block.documentId, updatedAt: now });
          count += 1;
        }
        this.put("rag_document", access.document.id, { id: access.document.id, versionHash: access.document.hash, indexedAt: now }, { documentId: access.document.id, updatedAt: now });
      }
      return count;
    });
    return transaction();
  }

  search(request: KnowledgeSearchRequest): KnowledgeRetrievalRecord[] {
    const query = request.query.trim();
    if (!query) return [];
    this.indexDocuments(request.documents, request.now);
    const accessByDocument = new Map(request.documents.map((item) => [item.document.id, item]));
    const queryEmbedding = embed(query);
    const queryTokens = tokens(query);
    const types = new Set(request.contentTypes ?? []);
    const scored = this.list<IndexedBlock>("rag_block")
      .filter((block) => accessByDocument.has(block.documentId) && (types.size === 0 || types.has(block.contentType)))
      .map((block): KnowledgeRetrievalRecord => {
        const access = accessByDocument.get(block.documentId)!;
        const lexical = lexicalScore(queryTokens, tokens(block.searchableText));
        const semantic = cosine(queryEmbedding, block.embedding);
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
      .filter((result) => result.score > 0.04)
      .sort((left, right) => right.score - left.score || left.documentId.localeCompare(right.documentId) || left.sourceSpan.line - right.sourceSpan.line);
    return scored.slice(0, request.limit ?? 12);
  }

  ask(request: KnowledgeSearchRequest): AskNomaResult {
    const started = performance.now();
    const results = this.search({ ...request, limit: request.limit ?? 8 });
    const citations = uniqueCitations(results).slice(0, 5);
    const confidenceScore = citations.length === 0 ? 0 : round(citations.reduce((sum, item) => sum + item.score, 0) / citations.length);
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
    const blocks = this.list<IndexedBlock>("rag_block").filter((block) => allowed.has(block.documentId));
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
    const blocks = this.list<IndexedBlock>("rag_block").filter((block) => allowed.has(block.documentId));
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

  listAgents(): CloudAgentIdentity[] {
    return this.list<CloudAgentIdentity>("agent");
  }

  grantAgentAccess(access: AgentAccessGrant, actorId: string, now: string): AgentAccessGrant {
    if (!this.readAgent(access.agentId)) throw new Error("Agent not found");
    this.put("agent_access", access.id, access, { ownerId: access.agentId, documentId: access.resourceType === "document" ? access.resourceId : undefined, siteId: access.resourceType === "site" ? access.resourceId : undefined, updatedAt: access.updatedAt });
    this.audit(actorId, "agent.access_granted", access.resourceType, access.resourceId, { agentId: access.agentId, role: access.role }, now);
    return access;
  }

  listAgentAccess(agentId: string): AgentAccessGrant[] {
    return this.list<AgentAccessGrant>("agent_access").filter((access) => access.agentId === agentId);
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

  listAgentRuns(agentId: string): AgentRun[] {
    return this.list<AgentRun>("agent_run").filter((run) => run.agentId === agentId);
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
    const blocks = this.list<IndexedBlock>("rag_block").filter((block) => allowed.has(block.documentId));
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
    ];
  }

  recordAnalytics(event: AnalyticsEvent): AnalyticsEvent {
    this.put("analytics", event.id, event, { ownerId: event.actorId, documentId: event.documentId, updatedAt: event.createdAt });
    return event;
  }

  analytics(actorId: string, accessibleDocumentIds: string[]): AnalyticsSummary {
    const allowed = new Set(accessibleDocumentIds);
    const events = this.list<AnalyticsEvent>("analytics").filter((event) => event.actorId === actorId || (event.documentId !== undefined && allowed.has(event.documentId)));
    const counts = Object.fromEntries(["no_result", "answer_generated", "citation_opened", "answer_rejected", "task_completed"].map((type) => [type, events.filter((event) => event.type === type).length])) as Record<AnalyticsEvent["type"], number>;
    return {
      counts,
      total: events.length,
      noResultQueries: events.filter((event) => event.type === "no_result" && event.query).map((event) => event.query!),
      scope: { actorId, accessibleDocumentIds: [...allowed].sort() },
    };
  }

  exportBackup(documents: CloudDocumentRecord[], exportedAt: string, git?: { repository: string; branch: string; pullRequestReview: boolean }): NomaBackupBundle {
    const files = [...documents].sort((left, right) => left.id.localeCompare(right.id)).map((document) => ({
      path: `documents/${document.id}.noma`,
      documentId: document.id,
      title: document.title,
      hash: document.hash,
      source: document.source.replace(/\r\n?/g, "\n"),
      updatedAt: document.updatedAt,
    }));
    const manifest = { format: "noma-cloud-backup-v1" as const, exportedAt, files: files.map(({ source: _source, ...file }) => file), ...(git ? { git } : {}) };
    return { manifest, files, digest: sha256Hex(`${JSON.stringify(manifest)}\n${files.map((file) => `${file.path}\n${file.source}`).join("\n")}`) };
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

  listOfflineDrafts(userId: string): OfflineDraft[] {
    return this.list<OfflineDraft>("offline_draft").filter((draft) => draft.userId === userId);
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
    const prior = this.list<RealtimeOperation>("realtime_operation").filter((item) => item.documentId === operation.documentId);
    const expectedSequence = prior.reduce((max, item) => Math.max(max, item.sequence), 0) + 1;
    if (operation.sequence !== expectedSequence) throw new Error(`Realtime sequence must be ${expectedSequence}`);
    this.put("realtime_operation", operation.id, operation, { ownerId: operation.userId, documentId: operation.documentId, updatedAt: operation.createdAt });
    this.audit(operation.userId, "realtime.operation_applied", "document", operation.documentId, { operationId: operation.id, sequence: operation.sequence, baseHash: operation.baseHash, resultHash: operation.resultHash, affectedIds: operation.affectedIds }, operation.createdAt);
    return operation;
  }

  realtimeOperations(documentId: string, afterSequence = 0): RealtimeOperation[] {
    return this.list<RealtimeOperation>("realtime_operation").filter((operation) => operation.documentId === documentId && operation.sequence > afterSequence).sort((left, right) => left.sequence - right.sequence);
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

  listScimIdentities(): ScimIdentity[] {
    return this.list<ScimIdentity>("scim_identity");
  }

  putLegalHold(hold: LegalHold): LegalHold {
    if (!this.enterprisePolicy().legalHoldEnabled) throw new Error("Legal hold is not enabled");
    this.put("legal_hold", hold.id, hold, { ownerId: hold.createdBy, documentId: hold.resourceType === "document" ? hold.resourceId : undefined, updatedAt: hold.createdAt });
    this.audit(hold.createdBy, "legal_hold.created", hold.resourceType, hold.resourceId, { holdId: hold.id, reason: hold.reason }, hold.createdAt);
    return hold;
  }

  listLegalHolds(): LegalHold[] {
    return this.list<LegalHold>("legal_hold");
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

  private list<T>(kind: PlatformKind): T[] {
    return this.db.prepare("SELECT id, data_json FROM cloud_platform_records WHERE kind = ? ORDER BY updated_at DESC, id").all(kind).map((row) => JSON.parse((row as PlatformRow).data_json) as T);
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

function embed(value: string): number[] {
  const vector = Array.from({ length: vectorDimensions }, () => 0);
  const normalized = ` ${value.normalize("NFKC").toLocaleLowerCase()} `;
  const features = [...tokens(normalized), ...Array.from({ length: Math.max(0, normalized.length - 2) }, (_, index) => normalized.slice(index, index + 3))];
  for (const feature of features) {
    const hash = sha256Hex(feature);
    const index = Number.parseInt(hash.slice(0, 8), 16) % vectorDimensions;
    const sign = Number.parseInt(hash.slice(8, 10), 16) % 2 === 0 ? 1 : -1;
    vector[index] = vector[index]! + sign;
  }
  const magnitude = Math.sqrt(vector.reduce((sum, item) => sum + item * item, 0)) || 1;
  return vector.map((item) => round(item / magnitude, 6));
}

function tokens(value: string): string[] {
  return (value.normalize("NFKC").toLocaleLowerCase().match(/[\p{L}\p{N}_-]{2,}/gu) ?? []).filter((token) => !retrievalStopWords.has(token));
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

function cosine(left: number[], right: number[]): number {
  let dot = 0;
  let leftMagnitude = 0;
  let rightMagnitude = 0;
  for (let index = 0; index < Math.min(left.length, right.length); index++) {
    dot += left[index]! * right[index]!;
    leftMagnitude += left[index]! * left[index]!;
    rightMagnitude += right[index]! * right[index]!;
  }
  if (leftMagnitude === 0 || rightMagnitude === 0) return 0;
  return Math.max(0, dot / Math.sqrt(leftMagnitude * rightMagnitude));
}

function stripStored(block: IndexedBlock): Omit<KnowledgeRetrievalRecord, "accessDecision" | "score" | "scoreParts"> {
  const { id: _id, kind: _kind, ownerId: _ownerId, siteId: _siteId, createdAt: _createdAt, updatedAt: _updatedAt, ...record } = block;
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

function uniqueCitations(results: KnowledgeRetrievalRecord[]): KnowledgeRetrievalRecord[] {
  const seen = new Set<string>();
  return results.filter((result) => {
    const key = `${result.documentId}:${result.blockId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
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
  operation: "search" | "cited_answer" | "list_ids" | "llm_export" | "proof" | "proposal" | "review" | "apply" | "webhook";
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

export interface NomaBackupBundle {
  manifest: {
    format: "noma-cloud-backup-v1";
    exportedAt: string;
    files: Array<Omit<NomaBackupFile, "source">>;
    git?: { repository: string; branch: string; pullRequestReview: boolean };
  };
  files: NomaBackupFile[];
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
