/** `/api/documents` and per-document sub-resources: revisions, comments, approvals, labels, watch. */
import type { IncomingMessage, ServerResponse } from "node:http";
import { walk } from "../ast.js";
import type {
  CloudApproval,
  CloudApprovalStatus,
  CloudDocumentRecord,
  CloudDocumentRevision,
  CloudResourceType,
  CloudSiteRecord,
  CloudUserRecord,
} from "../cloud-db.js";
import { parse } from "../parser.js";
import { lineDiff } from "../proof.js";
import { renderLlm } from "../renderer-llm.js";
import {
  type AccessContext,
  type CloudServerConfig,
  type Principal,
  readDocument,
  readUser,
  recordActivity,
  requireAccessRole,
  requireNotTrashed,
  requireRecordAccess,
  requireUser,
  uniqueId,
  writeNotification,
} from "./context.js";
import { decodePathSegment, HttpError, readJsonBody, sendJson, sendText } from "./http.js";
import { labelInput, optionalString, stringInput } from "./input.js";
import {
  createDocument,
  documentResponse,
  inspectSource,
  requireDocumentPrecondition,
  updateDocument,
} from "./records.js";
import { attachmentResolver } from "./attachments.js";
import { canvasResolver } from "./canvas.js";
import { renderDocumentHtml } from "./render.js";
import { routeDocumentWidget, widgetFrameResolver } from "./widgets.js";
import { paperDomToPatchOps } from "../paperdom-sync.js";
import type { PaperDOMDocument } from "../paperdom-document-model.js";
import { documentComponentKit, documentStyleTokens } from "./spaces.js";
import { routeCollaborators, routeGroupCollaborators, routeShares } from "./routes-access.js";
import { routeDocumentAnalytics } from "./routes-analytics.js";
import { routeDocumentTasks } from "./routes-tasks.js";
import { emitPageWebhookEvent } from "./webhooks.js";
import { routeComments } from "./routes-comments.js";
import { routeDocumentAttachments } from "./routes-attachments.js";
import { routeDocumentRestrictions } from "./routes-restrictions.js";
import { cloudMacroResolvers } from "./macros.js";
import { routeDocumentExport } from "./routes-export.js";
import { routePatchProposals } from "./routes-patch.js";

export async function routeDocuments(
  req: IncomingMessage,
  res: ServerResponse,
  parts: string[],
  config: CloudServerConfig,
  principal: Principal,
): Promise<void> {
  const method = req.method ?? "GET";
  const id = parts[2];
  const suffix = parts[3];

  if (!id && method === "POST") {
    const user = requireUser(principal);
    const input = await readJsonBody(req, config.maxBodyBytes);
    const record = await createDocument(config, input, user);
    sendJson(res, 201, documentResponse(record, requireRecordAccess(config, record, principal, "owner"), config));
    return;
  }

  if (!id && method === "GET") {
    const user = requireUser(principal);
    sendJson(res, 200, { documents: await listDocuments(config, user) });
    return;
  }

  if (!id) throw new HttpError(404, "Document ID is required");

  const record = await readDocument(config, id);
  requireNotTrashed(config, "document", id);

  if (suffix === "collaborators") {
    await routeCollaborators(req, res, parts[4], config, principal, record, "document");
    return;
  }

  if (suffix === "group-collaborators") {
    await routeGroupCollaborators(req, res, parts[4], config, principal, record, "document");
    return;
  }

  if (suffix === "shares") {
    await routeShares(req, res, parts[4], config, principal, record, "document");
    return;
  }

  if (suffix === "revisions") {
    const access = requireRecordAccess(config, record, principal, "viewer");
    await routeDocumentRevisions(req, res, parts[4], parts[5], config, record, access);
    return;
  }

  if (suffix === "labels") {
    await routeDocumentLabels(req, res, parts[4], config, principal, record);
    return;
  }

  if (suffix === "watch") {
    routeWatch(req, res, config, principal, record, "document");
    return;
  }

  if (suffix === "attachments") {
    await routeDocumentAttachments(req, res, parts[4], config, principal, record);
    return;
  }

  if (suffix === "restrictions") {
    await routeDocumentRestrictions(req, res, config, principal, record);
    return;
  }

  if (suffix === "comments") {
    await routeDocumentComments(req, res, parts[4], parts[5], config, principal, record, undefined, parts[6]);
    return;
  }

  if (suffix === "approvals") {
    await routeDocumentApprovals(req, res, parts[4], config, principal, record);
    return;
  }

  if (suffix === "tasks") {
    await routeDocumentTasks(req, res, parts[4], config, principal, record);
    return;
  }

  if (suffix === "views" || suffix === "analytics") {
    await routeDocumentAnalytics(req, res, suffix, config, principal, record);
    return;
  }

  if (suffix === "patch-proposals") {
    await routePatchProposals(req, res, parts[4], parts[5], config, principal, record);
    return;
  }

  if (suffix === "export") {
    await routeDocumentExport(req, res, new URL(req.url ?? "/", "http://noma.local"), config, principal, record);
    return;
  }

  if (suffix === "paperdom-sync") {
    if (method !== "POST") throw new HttpError(405, "Method not allowed");
    requireAccessRole(requireRecordAccess(config, record, principal, "viewer"), "editor");
    const input = await readJsonBody(req, config.maxBodyBytes);
    if (!input.canvas || typeof input.canvas !== "object") throw new HttpError(400, "canvas must be a PaperDOM document");
    const deck = optionalString(input.deck);
    try {
      const result = paperDomToPatchOps(parse(record.source, { filename: `${record.id}.noma` }), input.canvas as PaperDOMDocument, {
        components: documentComponentKit(config, record.id),
        ...(deck ? { deck } : {}),
      });
      sendJson(res, 200, { ...result, documentHash: record.hash });
    } catch (error) {
      throw new HttpError(422, error instanceof Error ? error.message : String(error), { code: "invalid_canvas" });
    }
    return;
  }

  if (suffix === "widgets") {
    routeDocumentWidget(req, res, parts[4], config, principal, record);
    return;
  }

  if (suffix === "html" && method === "GET") {
    const access = requireRecordAccess(config, record, principal, "viewer");
    sendText(res, 200, renderDocumentHtml(record, access, { resolveAttachment: attachmentResolver(config, record.id, access), resolveCanvas: await canvasResolver(config, record.id, record.source), resolveWidgetFrame: widgetFrameResolver(config, record.id, access), styleTokens: documentStyleTokens(config, record.id), components: documentComponentKit(config, record.id), macros: cloudMacroResolvers(config, principal, record.id) }), "text/html; charset=utf-8");
    return;
  }

  if (suffix === "json" && method === "GET") {
    requireRecordAccess(config, record, principal, "viewer");
    sendText(res, 200, inspectSource(record.source, record.id).json, "application/json; charset=utf-8");
    return;
  }

  if (suffix === "llm" && method === "GET") {
    requireRecordAccess(config, record, principal, "viewer");
    const doc = parse(record.source, { filename: `${record.id}.noma` });
    sendText(res, 200, renderLlm(doc, cloudMacroResolvers(config, principal, record.id)), "text/plain; charset=utf-8");
    return;
  }

  if (suffix) throw new HttpError(404, "Unknown document artifact");

  if (method === "GET") {
    const access = requireRecordAccess(config, record, principal, "viewer");
    if (access.user) config.store.recordRecent(access.user.id, "document", record.id, config.now().toISOString());
    sendJson(res, 200, documentResponse(record, access, config));
    return;
  }

  if (method === "PUT" || method === "PATCH") {
    const access = requireRecordAccess(config, record, principal, "editor");
    const input = await readJsonBody(req, config.maxBodyBytes);
    requireDocumentPrecondition(req, record, input);
    const updated = await updateDocument(config, record, input, access, { assignTaskIds: true });
    sendJson(res, 200, documentResponse(updated, requireRecordAccess(config, updated, principal, "viewer"), config));
    return;
  }

  throw new HttpError(405, "Method not allowed");
}

export async function routeDocumentRevisions(
  req: IncomingMessage,
  res: ServerResponse,
  revisionText: string | undefined,
  action: string | undefined,
  config: CloudServerConfig,
  document: CloudDocumentRecord,
  access: AccessContext,
): Promise<void> {
  const method = req.method ?? "GET";
  if (!revisionText && method === "GET") {
    sendJson(res, 200, { revisions: config.store.listDocumentRevisions(document.id) });
    return;
  }

  const revisionNumber = parseRevisionNumber(revisionText);
  const revision = config.store.readDocumentRevision(document.id, revisionNumber);
  if (!revision) throw new HttpError(404, "Document revision not found");

  if (!action && method === "GET") {
    sendJson(res, 200, revision);
    return;
  }

  if (action === "diff" && method === "GET") {
    const againstText = new URL(req.url ?? "/", "http://noma.local").searchParams.get("against");
    const againstNumber = againstText === null ? revisionNumber - 1 : parseRevisionNumber(againstText);
    const base = againstNumber > 0 ? config.store.readDocumentRevision(document.id, againstNumber) : undefined;
    if (againstNumber > 0 && !base) throw new HttpError(404, "Comparison revision not found");
    sendJson(res, 200, revisionDiffResponse(document.id, base, revision));
    return;
  }

  if (action === "restore" && method === "POST") {
    requireAccessRole(access, "editor");
    const input = await readJsonBody(req, config.maxBodyBytes);
    requireDocumentPrecondition(req, document, input);
    const restored = await updateDocument(
      config,
      document,
      { title: revision.title, source: revision.source },
      access,
    );
    sendJson(res, 200, documentResponse(restored, access, config));
    return;
  }

  throw new HttpError(404, "Unknown document revision route");
}

export async function routeDocumentComments(
  req: IncomingMessage,
  res: ServerResponse,
  commentId: string | undefined,
  action: string | undefined,
  config: CloudServerConfig,
  principal: Principal,
  document: CloudDocumentRecord,
  inheritedAccess?: AccessContext,
  actionArg?: string,
): Promise<void> {
  const access = inheritedAccess ?? requireRecordAccess(config, document, principal, "viewer");
  await routeComments(req, res, commentId, action, actionArg, config, principal, document, access);
}

export async function routeDocumentApprovals(
  req: IncomingMessage,
  res: ServerResponse,
  approvalId: string | undefined,
  config: CloudServerConfig,
  principal: Principal,
  document: CloudDocumentRecord,
  inheritedAccess?: AccessContext,
): Promise<void> {
  const method = req.method ?? "GET";
  const access = inheritedAccess ?? requireRecordAccess(config, document, principal, "viewer");
  const user = requireUser(principal);
  if (!approvalId && method === "GET") {
    sendJson(res, 200, { approvals: config.store.listApprovals(document.id) });
    return;
  }
  if (!approvalId && method === "POST") {
    requireAccessRole(access, "editor");
    const input = await readJsonBody(req, config.maxBodyBytes);
    const reviewerId = stringInput(input, "reviewerId");
    const reviewer = await readUser(config, reviewerId);
    if (!config.store.documentAccessRole(reviewerId, document.id)) throw new HttpError(400, "Reviewer needs access to this document or its space");
    if (
      config.store
        .listApprovals(document.id)
        .some((approval) => approval.reviewerId === reviewerId && approval.documentHash === document.hash && approval.status === "pending")
    ) {
      throw new HttpError(409, "This reviewer already has a pending approval for the current version");
    }
    const now = config.now().toISOString();
    const approval: Omit<CloudApproval, "reviewerName"> = {
      id: uniqueId(config),
      documentId: document.id,
      documentHash: document.hash,
      requestedBy: user.id,
      reviewerId,
      status: "pending",
      note: optionalString(input.note)?.slice(0, 4_000),
      createdAt: now,
      updatedAt: now,
    };
    config.store.writeApproval(approval);
    writeNotification(config, reviewer.id, "approval_requested", `Approval requested: ${document.title}`, `${user.name} requested your review.`, "document", document.id);
    recordActivity(config, user, "approval.requested", "document", document.id, { approvalId: approval.id, reviewerId, documentHash: document.hash });
    sendJson(res, 201, config.store.readApproval(approval.id));
    return;
  }
  if (approvalId && method === "PATCH") {
    const existing = config.store.readApproval(approvalId);
    if (!existing || existing.documentId !== document.id) throw new HttpError(404, "Approval not found");
    const input = await readJsonBody(req, config.maxBodyBytes);
    const status = approvalStatusInput(input.status);
    if (status === "approved" && document.hash !== existing.documentHash) {
      throw new HttpError(409, "This approval targets an older document version", {
        code: "approval_version_stale",
        approvalHash: existing.documentHash,
        currentHash: document.hash,
      });
    }
    if (status === "cancelled") {
      if (existing.requestedBy !== user.id) throw new HttpError(403, "Only the requester can cancel this approval");
    } else if (existing.reviewerId !== user.id) {
      throw new HttpError(403, "Only the assigned reviewer can update this approval");
    }
    const now = config.now().toISOString();
    config.store.writeApproval({
      ...existing,
      status,
      note: optionalString(input.note)?.slice(0, 4_000) ?? existing.note,
      updatedAt: now,
    });
    if (config.store.documentAccessRole(existing.requestedBy, document.id)) writeNotification(
      config,
      existing.requestedBy,
      "approval_updated",
      `Approval ${status.replace("_", " ")}: ${document.title}`,
      `${user.name} set the review to ${status.replace("_", " ")}.`,
      "document",
      document.id,
    );
    recordActivity(config, user, `approval.${status}`, "document", document.id, { approvalId, documentHash: existing.documentHash });
    sendJson(res, 200, config.store.readApproval(approvalId));
    return;
  }
  throw new HttpError(404, "Unknown approval route");
}

async function listDocuments(config: CloudServerConfig, user: CloudUserRecord): Promise<Array<Record<string, unknown>>> {
  return config.store.listDocuments(user).map((record) => ({
    version: record.version,
    id: record.id,
    title: record.title,
    hash: record.hash,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    createdBy: record.createdBy,
    updatedBy: record.updatedBy,
    currentRole: record.currentRole,
  }));
}

function approvalStatusInput(value: unknown): Exclude<CloudApprovalStatus, "pending"> {
  if (value === "approved" || value === "changes_requested" || value === "cancelled") return value;
  throw new HttpError(400, "status must be approved, changes_requested, or cancelled");
}

function parseRevisionNumber(value: string | undefined): number {
  if (!value || !/^\d+$/.test(value)) throw new HttpError(400, "Revision number is required");
  const revision = Number(value);
  if (!Number.isSafeInteger(revision) || revision < 1) throw new HttpError(400, "Invalid revision number");
  return revision;
}

function revisionDiffResponse(
  documentId: string,
  base: CloudDocumentRevision | undefined,
  target: CloudDocumentRevision,
): Record<string, unknown> {
  const before = base?.source ?? "";
  const diff = lineDiff(before, target.source);
  const diffLines = diff.split("\n");
  const beforeBlocks = blockFingerprints(before, documentId);
  const afterBlocks = blockFingerprints(target.source, documentId);
  const added = [...afterBlocks.keys()].filter((id) => !beforeBlocks.has(id));
  const removed = [...beforeBlocks.keys()].filter((id) => !afterBlocks.has(id));
  const changed = [...afterBlocks.keys()].filter((id) => beforeBlocks.has(id) && beforeBlocks.get(id) !== afterBlocks.get(id));
  const summary = (revision: CloudDocumentRevision) => ({
    revision: revision.revision,
    title: revision.title,
    hash: revision.hash,
    createdAt: revision.createdAt,
    createdBy: revision.createdBy,
  });
  return {
    documentId,
    from: base ? summary(base) : null,
    to: summary(target),
    titleChanged: (base?.title ?? "") !== target.title,
    stats: {
      added: diffLines.filter((line) => line.startsWith("+")).length,
      removed: diffLines.filter((line) => line.startsWith("-")).length,
    },
    blocks: { added, removed, changed },
    diff,
  };
}

function blockFingerprints(source: string, documentId: string): Map<string, string> {
  const fingerprints = new Map<string, string>();
  if (!source) return fingerprints;
  const doc = parse(source, { filename: `${documentId}.noma` });
  for (const node of walk(doc)) {
    if (!node.id || node.type === "document" || fingerprints.has(node.id)) continue;
    fingerprints.set(node.id, JSON.stringify(node, (key, value: unknown) => (key === "pos" || key === "endLine" ? undefined : value)));
  }
  return fingerprints;
}

function labelListInput(value: unknown): string[] {
  if (!Array.isArray(value)) throw new HttpError(400, "labels must be an array");
  if (value.length > 50) throw new HttpError(400, "A page can carry at most 50 labels");
  return [...new Set(value.map(labelInput))].sort();
}

async function routeDocumentLabels(
  req: IncomingMessage,
  res: ServerResponse,
  labelText: string | undefined,
  config: CloudServerConfig,
  principal: Principal,
  document: CloudDocumentRecord,
): Promise<void> {
  const method = req.method ?? "GET";
  if (!labelText && method === "GET") {
    requireRecordAccess(config, document, principal, "viewer");
    sendJson(res, 200, { documentId: document.id, labels: config.store.listDocumentLabels(document.id) });
    return;
  }
  const access = requireRecordAccess(config, document, principal, "editor");
  const actor = access.user?.id ?? `share:${access.share?.id ?? "unknown"}`;
  const now = config.now().toISOString();
  const current = config.store.listDocumentLabels(document.id);
  let next: string[];
  if (!labelText && method === "PUT") {
    next = labelListInput((await readJsonBody(req, config.maxBodyBytes)).labels);
  } else if (!labelText && method === "POST") {
    const label = labelInput((await readJsonBody(req, config.maxBodyBytes)).label);
    next = [...new Set([...current, label])].sort();
    if (next.length > 50) throw new HttpError(400, "A page can carry at most 50 labels");
  } else if (labelText && method === "DELETE") {
    const label = labelInput(decodePathSegment(labelText));
    next = current.filter((existing) => existing !== label);
  } else {
    throw new HttpError(405, "Method not allowed");
  }
  const labels = config.store.replaceDocumentLabels(document.id, next, actor, now);
  if (access.user) recordActivity(config, access.user, "document.labeled", "document", document.id, { labels });
  const added = labels.filter((label) => !current.includes(label));
  const removed = current.filter((label) => !labels.includes(label));
  if (added.length || removed.length) emitPageWebhookEvent(config, "label.changed", document, access.user, { labels, added, removed });
  sendJson(res, 200, { documentId: document.id, labels });
}

export function routeWatch(
  req: IncomingMessage,
  res: ServerResponse,
  config: CloudServerConfig,
  principal: Principal,
  record: CloudDocumentRecord | CloudSiteRecord,
  resourceType: CloudResourceType,
): void {
  const method = req.method ?? "GET";
  const user = requireUser(principal);
  requireRecordAccess(config, record, principal, "viewer");
  if (method === "PUT") config.store.setWatch(user.id, resourceType, record.id, config.now().toISOString());
  else if (method === "DELETE") config.store.removeWatch(user.id, resourceType, record.id);
  else if (method !== "GET") throw new HttpError(405, "Method not allowed");
  sendJson(res, 200, { resourceType, resourceId: record.id, watching: config.store.isWatching(user.id, resourceType, record.id) });
}
