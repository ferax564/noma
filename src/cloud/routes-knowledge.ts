/**
 * Knowledge platform: ask, knowledge trust/health/wiki/evals, agent inbox, semantic collections,
 * analytics, backup, offline drafts, realtime ops.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { CloudDocumentRecord, CloudRole, CloudUserRecord } from "../cloud-db.js";
import type {
  AgentAccessGrant,
  AnalyticsEvent,
  CloudAgentIdentity,
  KnowledgeDocumentAccess,
  KnowledgeTrust,
  NomaBackupBundle,
  OfflineDraft,
  RagEvaluationFixture,
  RealtimeOperation,
} from "../cloud-platform.js";
import type { PatchOp } from "../patch.js";
import { parse } from "../parser.js";
import { renderLlm } from "../renderer-llm.js";
import {
  type AccessContext,
  type CloudServerConfig,
  type Principal,
  readDocument,
  recordActivity,
  requireRecordAccess,
  requireResourceAccess,
  requireUser,
  roleRank,
  uniqueId,
} from "./context.js";
import { HttpError, readJsonBody, sendJson, sendText, sha256Hex } from "./http.js";
import {
  assertCloudId,
  boundedInteger,
  boundedNumber,
  documentIdList,
  numberQuery,
  optionalCloudId,
  optionalIsoDate,
  optionalRecord,
  optionalString,
  optionalStringArray,
  requiredIsoDate,
  shaInput,
  stringInput,
  stringPathPart,
} from "./input.js";
import {
  accessResponse,
  documentHasBlock,
  documentResponse,
  inspectSource,
  notifyPageWatchers,
  requireDocumentPrecondition,
  updateDocument,
} from "./records.js";
import { backupAttachments, restoreBackupAttachments, validateBackupAttachments } from "./attachments.js";
import { generativeAsk } from "./routes-ai.js";
import { cloudProofRecord, createCloudPatchProof, patchOpsInput } from "./routes-patch.js";
import {
  hasSearchFilterTerms,
  mergeSearchParams,
  type ParsedSearchQuery,
  parseSearchQuery,
  resolveSearchFilters,
  searchQueryResponse,
} from "./search-query.js";
import { pageQuery, requestUrl } from "./security.js";

/** Documents one knowledge request may read; larger workspaces are served most-recently-updated first. */
const maxKnowledgeDocuments = 2_000;
const maxOfflineDraftsPerUser = 200;
const maxOfflineDraftBytes = 1_000_000;
const maxAnalyticsEventsPerMinute = 120;
const analyticsRetentionDays = 90;
const maxAnalyticsEventsPerUser = 10_000;
const maxBackupFiles = 1_000;

export async function routeAskNoma(req: IncomingMessage, res: ServerResponse, config: CloudServerConfig, principal: Principal): Promise<void> {
  if ((req.method ?? "GET") !== "POST") throw new HttpError(405, "Method not allowed");
  const user = requireUser(principal);
  const input = await readJsonBody(req, config.maxBodyBytes);
  const query = stringInput(input, "query").slice(0, 1_000);
  const siteId = optionalCloudId(input.siteId, "Site");
  const agentId = optionalString(input.agentId);
  const documents = knowledgeDocuments(config, user, siteId, agentId);
  const contentTypes = optionalStringArray(input.contentTypes, "contentTypes", 30);
  const mode = input.mode === undefined ? "extractive" : input.mode;
  if (mode !== "extractive" && mode !== "generative") throw new HttpError(400, "mode must be extractive or generative");
  const answer = await config.platform.askWithRetrieval({
    principalId: agentId ?? user.id,
    query,
    documents,
    now: config.now().toISOString(),
    limit: boundedInteger(input.limit, 8, 1, 25, "limit"),
    ...(contentTypes ? { contentTypes } : {}),
  });
  if (mode === "generative") {
    sendJson(res, 200, await generativeAsk(config, user, { query, extractive: answer, ...(siteId ? { siteId } : {}), ...(agentId ? { agentId } : {}) }));
    return;
  }
  sendJson(res, 200, answer);
}

export async function routeKnowledge(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  parts: string[],
  config: CloudServerConfig,
  principal: Principal,
): Promise<void> {
  const user = requireUser(principal);
  const method = req.method ?? "GET";
  const action = parts[2];
  if (action === "search" && method === "GET") {
    const query = (url.searchParams.get("q") ?? "").trim().slice(0, 1_000);
    const siteId = optionalCloudId(url.searchParams.get("site"), "Site");
    const agentId = optionalString(url.searchParams.get("agent"));
    const limit = boundedInteger(numberQuery(url.searchParams.get("limit")), 25, 1, 100, "limit");
    const parsed = mergeSearchParams(parseSearchQuery(query), url.searchParams);
    sendJson(res, 200, await filteredKnowledgeSearch(config, user, parsed, query, limit, siteId, agentId));
    return;
  }
  if (action === "trust") {
    const documentId = stringPathPart(parts[3], "Document ID");
    const blockId = stringPathPart(parts[4], "Block ID");
    const document = await readDocument(config, documentId);
    const access = requireRecordAccess(config, document, principal, method === "GET" ? "viewer" : "editor");
    if (!documentHasBlock(document, blockId)) throw new HttpError(404, "Block not found");
    if (method === "GET") {
      sendJson(res, 200, { trust: config.platform.trustFor(documentId, blockId), access: accessResponse(access) });
      return;
    }
    if (method === "PUT") {
      const input = await readJsonBody(req, config.maxBodyBytes);
      const now = config.now().toISOString();
      const trust: KnowledgeTrust = {
        documentId,
        blockId,
        ownerId: optionalString(input.ownerId),
        verifiedBy: optionalString(input.verifiedBy) === undefined ? undefined : user.id,
        verifiedAt: optionalIsoDate(input.verifiedAt, "verifiedAt"),
        reviewBy: optionalIsoDate(input.reviewBy, "reviewBy"),
        supersedes: optionalStringArray(input.supersedes, "supersedes", 100),
        canonicalFor: optionalStringArray(input.canonicalFor, "canonicalFor", 100),
        sourceOf: optionalStringArray(input.sourceOf, "sourceOf", 100),
        provenance: optionalRecord(input.provenance, "provenance"),
        updatedAt: now,
        updatedBy: user.id,
      };
      sendJson(res, 200, config.platform.putTrust(trust));
      return;
    }
    throw new HttpError(405, "Method not allowed");
  }
  const siteId = optionalCloudId(url.searchParams.get("site"), "Site");
  const agentId = optionalString(url.searchParams.get("agent"));
  const documents = knowledgeDocuments(config, user, siteId, agentId);
  if (action === "llm" && method === "GET") {
    const context = documents.map((access) => `<!-- document:${access.document.id} hash:${access.document.hash} role:${access.role} via:${access.via} -->\n${renderLlm(parse(access.document.source, { filename: `${access.document.id}.noma` }))}`).join("\n\n");
    sendText(res, 200, context, "text/plain; charset=utf-8");
    return;
  }
  if (action === "health" && method === "GET") {
    sendJson(res, 200, { generatedAt: config.now().toISOString(), items: config.platform.health(documents, config.now().toISOString()) });
    return;
  }
  if (action === "wiki" && method === "GET") {
    sendJson(res, 200, config.platform.wiki(documents, config.now().toISOString()));
    return;
  }
  if (action === "reindex" && method === "POST") {
    const indexed = config.platform.indexDocuments(documents, config.now().toISOString(), true);
    const embeddings = await config.platform.backfillEmbeddings({ documentIds: documents.map((item) => item.document.id) });
    sendJson(res, 200, { indexed, documentCount: documents.length, embeddings });
    return;
  }
  if (action === "evaluations" && method === "POST") {
    const input = await readJsonBody(req, config.maxBodyBytes);
    const fixtures = ragEvaluationFixtures(input.fixtures);
    const results = config.platform.evaluate(fixtures, { principalId: agentId ?? user.id, documents, now: config.now().toISOString() });
    sendJson(res, 200, { passed: results.every((result) => result.passed), results });
    return;
  }
  throw new HttpError(404, "Unknown knowledge route");
}

export function routeAgentInbox(req: IncomingMessage, res: ServerResponse, url: URL, config: CloudServerConfig, principal: Principal): void {
  if ((req.method ?? "GET") !== "GET") throw new HttpError(405, "Method not allowed");
  const user = requireUser(principal);
  const siteId = optionalCloudId(url.searchParams.get("site"), "Site");
  const documents = knowledgeDocuments(config, user, siteId);
  const proposals = documents.flatMap((item) => config.store.listPatchProposals(item.document.id));
  const inbox = config.platform.agentChangeInbox(proposals, documents);
  sendJson(res, 200, {
    changes: inbox,
    counts: {
      awaitingReview: inbox.filter((item) => item.applyStatus === "awaiting_review").length,
      ready: inbox.filter((item) => item.applyStatus === "ready").length,
      rejected: inbox.filter((item) => item.applyStatus === "rejected").length,
      applied: inbox.filter((item) => item.applyStatus === "applied").length,
    },
  });
}

export function routeSemanticCollections(req: IncomingMessage, res: ServerResponse, url: URL, config: CloudServerConfig, principal: Principal): void {
  if ((req.method ?? "GET") !== "GET") throw new HttpError(405, "Method not allowed");
  const user = requireUser(principal);
  const siteId = optionalCloudId(url.searchParams.get("site"), "Site");
  const collections = config.platform.semanticCollections(knowledgeDocuments(config, user, siteId), config.now().toISOString());
  const pending = collections.find((collection) => collection.id === "pending_agent_changes");
  if (pending) {
    const documents = knowledgeDocuments(config, user, siteId);
    const inbox = config.platform.agentChangeInbox(documents.flatMap((item) => config.store.listPatchProposals(item.document.id)), documents);
    pending.items = inbox.filter((item) => item.applyStatus === "awaiting_review" || item.applyStatus === "ready").map((item) => ({
      documentId: item.documentId,
      documentTitle: documents.find((access) => access.document.id === item.documentId)?.document.title ?? item.documentId,
      blockId: item.affectedIds[0] ?? item.id,
      contentType: "agent_change",
      title: item.plan[0],
      freshness: { state: "current", score: 1 },
      versionHash: item.documentHash,
    }));
  }
  sendJson(res, 200, { collections });
}

export async function routeKnowledgeAnalytics(req: IncomingMessage, res: ServerResponse, config: CloudServerConfig, principal: Principal): Promise<void> {
  const user = requireUser(principal);
  const method = req.method ?? "GET";
  const documents = knowledgeDocuments(config, user);
  if (method === "GET") {
    sendJson(res, 200, config.platform.analytics(user.id, documents.map((item) => item.document.id)));
    return;
  }
  if (method === "POST") {
    const input = await readJsonBody(req, config.maxBodyBytes);
    const type = analyticsType(input.type);
    const nowMs = config.now().getTime();
    if (config.platform.countAnalyticsSince(user.id, new Date(nowMs - 60_000).toISOString()) >= maxAnalyticsEventsPerMinute) {
      throw new HttpError(429, "Too many analytics events", { code: "analytics_rate_limited", limit: maxAnalyticsEventsPerMinute, retryAfter: 60 });
    }
    const documentId = optionalCloudId(input.documentId, "Document");
    if (documentId) await requireResourceAccess(config, principal, "document", documentId, "viewer");
    const event: AnalyticsEvent = {
      id: uniqueId(config),
      type,
      actorId: user.id,
      ...(documentId ? { documentId } : {}),
      ...(optionalString(input.query) ? { query: optionalString(input.query)?.slice(0, 1_000) } : {}),
      ...(typeof input.resultCount === "number" ? { resultCount: boundedInteger(input.resultCount, 0, 0, 1_000_000, "resultCount") } : {}),
      createdAt: config.now().toISOString(),
    };
    const recorded = config.platform.recordAnalytics(event);
    config.platform.pruneAnalytics(user.id, new Date(nowMs - analyticsRetentionDays * 86_400_000).toISOString(), maxAnalyticsEventsPerUser);
    sendJson(res, 201, recorded);
    return;
  }
  throw new HttpError(405, "Method not allowed");
}

export async function routeBackup(req: IncomingMessage, res: ServerResponse, parts: string[], config: CloudServerConfig, principal: Principal): Promise<void> {
  const user = requireUser(principal);
  const method = req.method ?? "GET";
  const action = parts[2];
  if (method !== "POST") throw new HttpError(405, "Method not allowed");
  const input = await readJsonBody(req, config.maxBodyBytes);
  if (action === "export") {
    const siteId = optionalCloudId(input.siteId, "Site");
    const documents = knowledgeDocuments(config, user, siteId).map((item) => item.document);
    const requested = input.documentIds === undefined ? documents : documents.filter((document) => documentIdList(input.documentIds).includes(document.id));
    const gitInput = optionalRecord(input.git, "git");
    const git = gitInput ? { repository: stringInput(gitInput, "repository"), branch: stringInput(gitInput, "branch"), pullRequestReview: gitInput.pullRequestReview === true } : undefined;
    const attachments = input.includeAttachments === false ? [] : await backupAttachments(config, requested);
    sendJson(res, 200, config.platform.exportBackup(requested, config.now().toISOString(), git, attachments));
    return;
  }
  if (action === "import") {
    const bundle = backupBundleInput(input.bundle);
    const targets = backupTargets(config, user, bundle);
    const plan = config.platform.planBackupImport(bundle, [...targets.values()].map((target) => target.document));
    if (input.apply !== true || plan.conflicts.length > 0) {
      sendJson(res, plan.conflicts.length > 0 ? 409 : 200, { applied: false, plan });
      return;
    }
    const unavailable = () =>
      new HttpError(409, "One or more backup documents cannot be imported by this user", { code: "backup_ids_unavailable" });
    if (plan.create.some((file) => config.store.hasRecordId(file.documentId))) throw unavailable();
    if (plan.update.some((item) => roleRank[targets.get(item.file.documentId)?.role ?? "viewer"] < roleRank.editor)) throw unavailable();
    for (const file of [...plan.create, ...plan.update.map((item) => item.file)]) inspectSource(file.source, file.documentId);
    const now = config.now().toISOString();
    const created: CloudDocumentRecord[] = [];
    const updated: CloudDocumentRecord[] = [];
    config.store.runInTransaction(() => {
      for (const file of plan.create) {
        if (config.store.hasRecordId(file.documentId)) throw unavailable();
        const record: CloudDocumentRecord = {
          version: 2,
          id: file.documentId,
          title: file.title,
          source: file.source,
          hash: sha256Hex(file.source),
          createdAt: now,
          updatedAt: now,
          createdBy: user.id,
          updatedBy: user.id,
          permissions: { [user.id]: { role: "owner", addedAt: now } },
          shareLinks: [],
        };
        config.store.writeDocument(record);
        created.push(record);
      }
      for (const item of plan.update) {
        const existing = config.store.readDocument(item.file.documentId);
        if (!existing || existing.hash !== item.expectedHash) {
          throw new HttpError(409, "Backup import precondition changed", { code: "document_conflict", documentId: item.file.documentId });
        }
        const record: CloudDocumentRecord = {
          ...existing,
          title: item.file.title.slice(0, 120),
          source: item.file.source,
          hash: sha256Hex(item.file.source),
          updatedAt: now,
          updatedBy: user.id,
        };
        if (!config.store.writeDocument(record, existing.hash)) {
          throw new HttpError(409, "Backup import precondition changed", { code: "document_conflict", documentId: existing.id });
        }
        updated.push(record);
      }
    });
    for (const record of created) {
      config.store.setWatch(user.id, "document", record.id, now);
      recordActivity(config, user, "document.created", "document", record.id, { title: record.title, via: "backup_import" });
    }
    for (const record of updated) {
      const target = targets.get(record.id);
      const access: AccessContext = { role: target?.role ?? "editor", via: "user", user };
      recordActivity(config, user, "document.updated", "document", record.id, { hash: record.hash, via: "backup_import" });
      notifyPageWatchers(config, record, access);
      config.store.setWatch(user.id, "document", record.id, now);
    }
    const editable = new Set([
      ...created.map((record) => record.id),
      ...updated.map((record) => record.id),
      ...plan.unchanged.filter((documentId) => {
        const existing = config.store.readDocument(documentId);
        return existing !== undefined && !config.store.isTrashed("document", documentId) && roleRank[config.store.documentAccessRole(user.id, documentId) ?? "viewer"] >= roleRank.editor;
      }),
    ]);
    const attachments = await restoreBackupAttachments(config, bundle, editable, user.id);
    sendJson(res, 200, {
      applied: true,
      created: created.map((record) => record.id),
      updated: updated.map((record) => record.id),
      unchanged: plan.unchanged,
      attachments,
      pullRequestReview: plan.pullRequestReview,
    });
    return;
  }
  throw new HttpError(404, "Unknown backup route");
}

export async function routeOffline(req: IncomingMessage, res: ServerResponse, parts: string[], config: CloudServerConfig, principal: Principal): Promise<void> {
  const user = requireUser(principal);
  const method = req.method ?? "GET";
  const action = parts[2];
  const draftId = parts[3];
  const subaction = parts[4];
  if (action !== "drafts") throw new HttpError(404, "Unknown offline route");
  if (!draftId && method === "GET") {
    const page = pageQuery(requestUrl(req), maxOfflineDraftsPerUser, maxOfflineDraftsPerUser);
    sendJson(res, 200, { drafts: config.platform.listOfflineDrafts(user.id, page), ...page });
    return;
  }
  if (!draftId && method === "POST") {
    const input = await readJsonBody(req, config.maxBodyBytes);
    const documentId = stringInput(input, "documentId");
    await requireResourceAccess(config, principal, "document", documentId, "editor");
    const now = config.now().toISOString();
    const draft: OfflineDraft = {
      id: uniqueId(config),
      userId: user.id,
      documentId,
      baseHash: shaInput(input.baseHash, "baseHash"),
      baseSource: stringInput(input, "baseSource"),
      source: stringInput(input, "source"),
      createdAt: now,
      updatedAt: now,
    };
    if (Buffer.byteLength(draft.source) + Buffer.byteLength(draft.baseSource) > maxOfflineDraftBytes) {
      throw new HttpError(413, "Offline draft is too large", { code: "offline_draft_too_large", limitBytes: maxOfflineDraftBytes });
    }
    if (config.platform.countOfflineDrafts(user.id) >= maxOfflineDraftsPerUser) {
      throw new HttpError(429, `A user can keep at most ${maxOfflineDraftsPerUser} offline drafts`, {
        code: "offline_draft_quota_exceeded",
        limit: maxOfflineDraftsPerUser,
      });
    }
    sendJson(res, 201, config.platform.saveOfflineDraft(draft));
    return;
  }
  if (draftId && subaction === "merge" && method === "POST") {
    const draft = config.platform.readOfflineDraft(user.id, draftId);
    if (!draft) throw new HttpError(404, "Offline draft not found");
    const document = await readDocument(config, draft.documentId);
    requireRecordAccess(config, document, principal, "editor");
    sendJson(res, 200, config.platform.mergeOfflineDraft(draft.id, document.source, document.hash, config.now().toISOString()));
    return;
  }
  throw new HttpError(404, "Unknown offline draft route");
}

export async function routeRealtime(req: IncomingMessage, res: ServerResponse, url: URL, parts: string[], config: CloudServerConfig, principal: Principal): Promise<void> {
  const user = requireUser(principal);
  const method = req.method ?? "GET";
  if (parts[2] !== "documents" || parts[4] !== "operations") throw new HttpError(404, "Unknown realtime route");
  const documentId = stringPathPart(parts[3], "Document ID");
  const document = await readDocument(config, documentId);
  const access = requireRecordAccess(config, document, principal, method === "GET" ? "viewer" : "editor");
  if (method === "GET") {
    const after = boundedInteger(numberQuery(url.searchParams.get("after")), 0, 0, 1_000_000_000, "after");
    const limit = boundedInteger(numberQuery(url.searchParams.get("limit")), 500, 1, 1_000, "limit");
    sendJson(res, 200, { operations: config.platform.realtimeOperations(documentId, after, limit), currentHash: document.hash, limit });
    return;
  }
  if (method === "POST") {
    const input = await readJsonBody(req, config.maxBodyBytes);
    requireDocumentPrecondition(req, document, input);
    const ops = patchOpsInput(input.ops);
    const proof = createCloudPatchProof(config, document, ops);
    if (!proof.canWrite || proof.preHash.sha256 !== document.hash) throw new HttpError(422, "Realtime operation proof failed", { proof: cloudProofRecord(proof) });
    const updated = await updateDocument(config, document, { source: proof.postSource }, access);
    const prior = config.platform.realtimeOperations(documentId);
    const operation: RealtimeOperation = {
      id: uniqueId(config),
      documentId,
      userId: user.id,
      actorType: "human",
      sequence: (prior.at(-1)?.sequence ?? 0) + 1,
      baseHash: document.hash,
      resultHash: updated.hash,
      operations: ops,
      affectedIds: [...new Set(ops.flatMap((op) => operationTargetIds(op)))],
      proofStatus: "pass",
      createdAt: config.now().toISOString(),
    };
    sendJson(res, 201, { operation: config.platform.recordRealtimeOperation(operation), document: documentResponse(updated, access) });
    return;
  }
  throw new HttpError(405, "Method not allowed");
}

/**
 * Hybrid search narrowed by the query language. Document-level filters restrict the permitted
 * corpus before retrieval; `type:` maps to block content types, phrases must appear verbatim, and
 * `type:page` keeps the best block per page. A filter-only query lists matching pages instead.
 */
async function filteredKnowledgeSearch(
  config: CloudServerConfig,
  user: CloudUserRecord,
  parsed: ParsedSearchQuery,
  query: string,
  limit: number,
  siteId: string | undefined,
  agentId: string | undefined,
): Promise<Record<string, unknown>> {
  let documents = knowledgeDocuments(config, user, siteId, agentId);
  const filters = resolveSearchFilters(config, user, parsed);
  const allowed = config.store.filteredDocumentIds(user, filters);
  documents = documents.filter((access) => allowed.has(access.document.id));
  if (!parsed.text) {
    const permitted = new Set(documents.map((access) => access.document.id));
    const results = hasSearchFilterTerms(parsed)
      ? config.store
          .searchFiltered(user, { words: [], phrases: [], ...(siteId ? { siteId } : {}), filters, limit: Math.min(limit * 4, 400) })
          .filter((result) => permitted.has(result.documentId))
          .slice(0, limit)
      : [];
    return { query, mode: "filter", filters: searchQueryResponse(parsed), results };
  }
  const blockTypes = parsed.types.filter((type) => type !== "page");
  const pageOnly = parsed.types.includes("page");
  const phrases = parsed.phrases.map((phrase) => phrase.toLowerCase().replace(/\s+/g, " "));
  const { results: candidates, retrieval } = await config.platform.searchWithRetrieval({
    principalId: agentId ?? user.id,
    query: parsed.text,
    documents,
    now: config.now().toISOString(),
    limit: pageOnly || phrases.length ? Math.min(limit * 8, 800) : limit,
    ...(blockTypes.length ? { contentTypes: blockTypes } : {}),
  });
  const seen = new Set<string>();
  const results = candidates
    .filter((result) => phrases.every((phrase) => result.exactSource.toLowerCase().replace(/\s+/g, " ").includes(phrase)))
    .filter((result) => !pageOnly || (seen.has(result.documentId) ? false : (seen.add(result.documentId), true)))
    .slice(0, limit);
  return { query, mode: "hybrid", retrieval, filters: searchQueryResponse(parsed), results };
}

export function knowledgeDocuments(config: CloudServerConfig, user: CloudUserRecord, siteId?: string, agentId?: string): KnowledgeDocumentAccess[] {
  let summaries = config.store.listDocuments(user, maxKnowledgeDocuments);
  if (siteId) {
    if (!config.store.resourceAccess(user.id, "site", siteId)) throw new HttpError(403, "Site access is required");
    const site = config.store.readSite(siteId);
    if (!site) throw new HttpError(404, "Site not found");
    const siteDocuments = new Set(site.documentIds);
    summaries = summaries.filter((summary) => siteDocuments.has(summary.id));
  }
  let agentGrants: AgentAccessGrant[] | undefined;
  const siteGrantDocuments = new Map<string, Set<string>>();
  if (agentId) {
    const agent = ownedAgent(config, user, agentId);
    if (agent.status !== "active") throw new HttpError(403, "Agent identity is not active");
    agentGrants = config.platform.listAgentAccess(agentId);
    for (const grant of agentGrants) {
      if (grant.resourceType === "site") siteGrantDocuments.set(grant.id, new Set(config.store.readSite(grant.resourceId)?.documentIds ?? []));
    }
  }
  const access: KnowledgeDocumentAccess[] = [];
  for (const summary of summaries) {
    if (config.store.isTrashed("document", summary.id)) continue;
    const humanAccess = config.store.resourceAccess(user.id, "document", summary.id);
    if (!humanAccess) continue;
    let role = humanAccess.role;
    let via: KnowledgeDocumentAccess["via"] = humanAccess.via;
    if (agentGrants) {
      const direct = agentGrants.find((grant) => grant.resourceType === "document" && grant.resourceId === summary.id);
      const siteGrant = agentGrants.find((grant) => grant.resourceType === "site" && siteGrantDocuments.get(grant.id)?.has(summary.id));
      const agentAccess = direct ?? siteGrant;
      if (!agentAccess) continue;
      role = roleRank[agentAccess.role] > roleRank[humanAccess.role] ? humanAccess.role : agentAccess.role;
      via = "agent";
    }
    const document = config.store.readDocument(summary.id);
    if (document) access.push({ document, role, via });
  }
  return access;
}

/**
 * Existing documents named by a backup bundle that the user can read. Documents the user cannot see
 * are absent, so the import plan never reveals whether their IDs exist.
 */
function backupTargets(config: CloudServerConfig, user: CloudUserRecord, bundle: NomaBackupBundle): Map<string, { document: CloudDocumentRecord; role: CloudRole }> {
  const targets = new Map<string, { document: CloudDocumentRecord; role: CloudRole }>();
  for (const file of bundle.files) {
    const grant = config.store.resourceAccess(user.id, "document", file.documentId);
    if (!grant || config.store.isTrashed("document", file.documentId)) continue;
    const document = config.store.readDocument(file.documentId);
    if (document) targets.set(document.id, { document, role: grant.role });
  }
  return targets;
}

function ragEvaluationFixtures(value: unknown): RagEvaluationFixture[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 500) throw new HttpError(400, "fixtures must be an array with 1-500 entries");
  return value.map((item, index) => {
    const record = optionalRecord(item, `fixtures[${index}]`)!;
    return {
      id: stringInput(record, "id"),
      query: stringInput(record, "query"),
      requiredSources: evaluationSources(record.requiredSources, `fixtures[${index}].requiredSources`),
      forbiddenSources: evaluationSources(record.forbiddenSources, `fixtures[${index}].forbiddenSources`),
      ...(record.expectAbstention === undefined ? {} : { expectAbstention: record.expectAbstention === true }),
      ...(typeof record.maxLatencyMs === "number" ? { maxLatencyMs: boundedNumber(record.maxLatencyMs, 0, 0, 3_600_000, "maxLatencyMs") } : {}),
      ...(typeof record.maxCostUsd === "number" ? { maxCostUsd: boundedNumber(record.maxCostUsd, 0, 0, 1_000_000, "maxCostUsd") } : {}),
    };
  });
}

function evaluationSources(value: unknown, label: string): Array<{ documentId: string; blockId?: string }> | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new HttpError(400, `${label} must be an array`);
  return value.map((item, index) => {
    const record = optionalRecord(item, `${label}[${index}]`)!;
    return { documentId: stringInput(record, "documentId"), ...(optionalString(record.blockId) ? { blockId: optionalString(record.blockId) } : {}) };
  });
}

export function platformInput<T>(operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    throw new HttpError(409, error instanceof Error ? error.message : "Platform operation failed");
  }
}

function platformForbidden<T>(operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    throw new HttpError(403, error instanceof Error ? error.message : "Agent authorization failed");
  }
}

export function ownedAgent(config: CloudServerConfig, user: CloudUserRecord, agentId: string): CloudAgentIdentity {
  const agent = config.platform.readAgent(agentId);
  if (!agent) throw new HttpError(404, "Agent not found");
  if (agent.createdBy !== user.id) throw new HttpError(403, "Agent owner access is required");
  return agent;
}

function analyticsType(value: unknown): AnalyticsEvent["type"] {
  if (value === "no_result" || value === "answer_generated" || value === "citation_opened" || value === "answer_rejected" || value === "task_completed") return value;
  throw new HttpError(400, "Unsupported analytics event type");
}

function backupBundleInput(value: unknown): NomaBackupBundle {
  const bundle = optionalRecord(value, "bundle");
  if (!bundle) throw new HttpError(400, "bundle is required");
  const manifest = optionalRecord(bundle.manifest, "bundle.manifest");
  if (!manifest || manifest.format !== "noma-cloud-backup-v1") throw new HttpError(400, "Unsupported backup format");
  requiredIsoDate(manifest.exportedAt, "bundle.manifest.exportedAt");
  if (!Array.isArray(manifest.files)) throw new HttpError(400, "bundle.manifest.files must be an array");
  if (!Array.isArray(bundle.files)) throw new HttpError(400, "bundle.files must be an array");
  if (bundle.files.length > maxBackupFiles) {
    throw new HttpError(413, `A backup import can contain at most ${maxBackupFiles} documents`, { code: "backup_too_large", limit: maxBackupFiles });
  }
  const documentIds = new Set<string>();
  const paths = new Set<string>();
  for (const [index, item] of bundle.files.entries()) {
    const file = optionalRecord(item, `bundle.files[${index}]`)!;
    const path = stringInput(file, "path");
    const documentId = stringInput(file, "documentId");
    assertCloudId(documentId, "Document");
    if (path !== `documents/${documentId}.noma`) throw new HttpError(400, `bundle.files[${index}].path must match its document ID`);
    if (documentIds.has(documentId) || paths.has(path)) throw new HttpError(400, "Backup bundle contains duplicate documents or paths");
    documentIds.add(documentId);
    paths.add(path);
    stringInput(file, "title");
    shaInput(file.hash, `bundle.files[${index}].hash`);
    if (typeof file.source !== "string") throw new HttpError(400, `bundle.files[${index}].source must be a string`);
    requiredIsoDate(file.updatedAt, `bundle.files[${index}].updatedAt`);
  }
  const typed = bundle as unknown as NomaBackupBundle;
  const expectedManifestFiles = typed.files.map(({ source: _source, ...file }) => file);
  if (JSON.stringify(typed.manifest.files) !== JSON.stringify(expectedManifestFiles)) {
    throw new HttpError(400, "Backup manifest does not match bundle files");
  }
  validateBackupAttachments(typed, documentIds);
  const digest = shaInput(bundle.digest, "bundle.digest");
  const actualDigest = sha256Hex(`${JSON.stringify(typed.manifest)}\n${typed.files.map((file) => `${file.path}\n${file.source}`).join("\n")}`);
  if (digest !== actualDigest) throw new HttpError(400, "Backup bundle digest does not match its contents");
  return typed;
}

function operationTargetIds(operation: PatchOp): string[] {
  const value = operation as unknown as Record<string, unknown>;
  return [value.id, value.parentId, value.to].filter((item): item is string => typeof item === "string" && item.length > 0);
}
