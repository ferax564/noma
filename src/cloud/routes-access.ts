/** Collaborators, group collaborators, and share links for documents and sites. */
import type { IncomingMessage, ServerResponse } from "node:http";
import type {
  CloudDocumentRecord,
  CloudResourceType,
  CloudRole,
  CloudShareLink,
  CloudSiteRecord,
} from "../cloud-db.js";
import {
  type AccessContext,
  type CloudServerConfig,
  type Principal,
  randomId,
  randomToken,
  readUser,
  recordActivity,
  requireRecordAccess,
  requireUser,
  roleRank,
  tokenPreview,
  writeDocument,
  writeSite,
} from "./context.js";
import { HttpError, readJsonBody, sendJson, sha256Hex } from "./http.js";
import { assertCloudId, optionalString, stringInput } from "./input.js";

export async function routeCollaborators(
  req: IncomingMessage,
  res: ServerResponse,
  collaboratorId: string | undefined,
  config: CloudServerConfig,
  principal: Principal,
  record: CloudDocumentRecord | CloudSiteRecord,
  kind: "document" | "site",
): Promise<void> {
  const method = req.method ?? "GET";
  requireRecordAccess(config, record, principal, "owner");

  if (method === "GET") {
    sendJson(res, 200, { collaborators: Object.entries(record.permissions).map(([userId, permission]) => ({ userId, ...permission })) });
    return;
  }

  if (method === "POST") {
    const input = await readJsonBody(req, config.maxBodyBytes);
    const userId = stringInput(input, "userId");
    const role = collaboratorRole(input.role);
    await readUser(config, userId);
    if (userId === record.createdBy) throw new HttpError(400, "Owner already has owner access");
    const next = {
      ...record,
      permissions: {
        ...record.permissions,
        [userId]: { role, addedAt: config.now().toISOString() },
      },
      updatedAt: config.now().toISOString(),
      updatedBy: principal.user?.id ?? record.updatedBy,
    };
    if (kind === "document") await writeDocument(config, next as CloudDocumentRecord, (record as CloudDocumentRecord).hash);
    else await writeSite(config, next as CloudSiteRecord);
    if (principal.user) recordActivity(config, principal.user, "permission.updated", kind, record.id, { userId, role });
    sendJson(res, 200, { collaborators: Object.entries(next.permissions).map(([id, permission]) => ({ userId: id, ...permission })) });
    return;
  }

  if (collaboratorId && method === "DELETE") {
    assertCloudId(collaboratorId, "User");
    if (collaboratorId === record.createdBy) throw new HttpError(409, "The resource owner cannot be removed");
    if (!record.permissions[collaboratorId]) throw new HttpError(404, "Collaborator not found");
    const permissions = { ...record.permissions };
    delete permissions[collaboratorId];
    const next = {
      ...record,
      permissions,
      updatedAt: config.now().toISOString(),
      updatedBy: principal.user?.id ?? record.updatedBy,
    };
    if (kind === "document") await writeDocument(config, next as CloudDocumentRecord, (record as CloudDocumentRecord).hash);
    else await writeSite(config, next as CloudSiteRecord);
    if (principal.user) recordActivity(config, principal.user, "permission.removed", kind, record.id, { userId: collaboratorId });
    sendJson(res, 200, { collaborators: Object.entries(next.permissions).map(([id, permission]) => ({ userId: id, ...permission })) });
    return;
  }

  throw new HttpError(405, "Method not allowed");
}

export async function routeGroupCollaborators(
  req: IncomingMessage,
  res: ServerResponse,
  groupId: string | undefined,
  config: CloudServerConfig,
  principal: Principal,
  record: CloudDocumentRecord | CloudSiteRecord,
  kind: CloudResourceType,
): Promise<void> {
  const method = req.method ?? "GET";
  const owner = requireRecordAccess(config, record, principal, "owner");
  if (!groupId && method === "GET") {
    sendJson(res, 200, { groups: config.store.listGroupPermissions(kind, record.id) });
    return;
  }
  if (!groupId && method === "POST") {
    const input = await readJsonBody(req, config.maxBodyBytes);
    const requestedGroupId = stringInput(input, "groupId");
    assertCloudId(requestedGroupId, "Group");
    const group = config.store.readGroup(requestedGroupId);
    if (!group) throw new HttpError(404, "Group not found");
    if (!group.members.some((member) => member.userId === owner.user?.id)) {
      throw new HttpError(403, "You must belong to a group before granting it access");
    }
    const role = collaboratorRole(input.role);
    const now = config.now().toISOString();
    config.store.setGroupPermission(kind, record.id, group.id, role, now);
    if (owner.user) recordActivity(config, owner.user, "group_permission.updated", kind, record.id, { groupId: group.id, role });
    sendJson(res, 200, { groups: config.store.listGroupPermissions(kind, record.id) });
    return;
  }
  if (groupId && method === "DELETE") {
    assertCloudId(groupId, "Group");
    if (!config.store.removeGroupPermission(kind, record.id, groupId)) throw new HttpError(404, "Group permission not found");
    if (owner.user) recordActivity(config, owner.user, "group_permission.removed", kind, record.id, { groupId });
    sendJson(res, 200, { groups: config.store.listGroupPermissions(kind, record.id) });
    return;
  }
  throw new HttpError(405, "Method not allowed");
}

export async function routeShares(
  req: IncomingMessage,
  res: ServerResponse,
  shareId: string | undefined,
  config: CloudServerConfig,
  principal: Principal,
  record: CloudDocumentRecord | CloudSiteRecord,
  kind: "document" | "site",
): Promise<void> {
  const method = req.method ?? "GET";
  const user = requireUser(principal);
  const grant = config.store.resourceAccess(user.id, kind, record.id);
  if (!grant || roleRank[grant.role] < roleRank.editor) throw new HttpError(403, "editor access is required");
  const access: AccessContext = { role: grant.role, via: grant.via, user, ...(grant.groupId ? { groupId: grant.groupId } : {}) };

  if (method === "GET") {
    sendJson(res, 200, { shares: record.shareLinks.map(shareSummary) });
    return;
  }

  if (method === "POST") {
    const input = await readJsonBody(req, config.maxBodyBytes);
    const role = shareRole(input.role);
    const token = randomToken("ns");
    const now = config.now().toISOString();
    const share: CloudShareLink = {
      id: randomId(),
      role,
      tokenHash: sha256Hex(token),
      tokenPreview: tokenPreview(token),
      label: optionalString(input.label)?.slice(0, 80),
      createdBy: access.user?.id ?? "share",
      createdAt: now,
    };
    const next = {
      ...record,
      shareLinks: [...record.shareLinks, share],
      updatedAt: now,
      updatedBy: access.user?.id ?? record.updatedBy,
    };
    if (kind === "document") await writeDocument(config, next as CloudDocumentRecord, (record as CloudDocumentRecord).hash);
    else await writeSite(config, next as CloudSiteRecord);
    recordActivity(config, user, "share.created", kind, record.id, { shareId: share.id, role });
    sendJson(res, 201, {
      ...shareSummary(share),
      token,
      url: kind === "document" ? `/workbench.html?doc=${record.id}&share=${token}` : `/s/${record.id}?share=${token}`,
      artifactUrl: kind === "document" ? `/d/${record.id}?share=${token}` : `/s/${record.id}?share=${token}`,
    });
    return;
  }

  if (shareId && method === "DELETE") {
    const existing = record.shareLinks.find((share) => share.id === shareId && !share.revokedAt);
    if (!existing) throw new HttpError(404, "Active share link not found");
    const now = config.now().toISOString();
    const next = {
      ...record,
      shareLinks: record.shareLinks.map((share) => (share.id === shareId ? { ...share, revokedAt: now } : share)),
      updatedAt: now,
      updatedBy: user.id,
    };
    if (kind === "document") await writeDocument(config, next as CloudDocumentRecord, (record as CloudDocumentRecord).hash);
    else await writeSite(config, next as CloudSiteRecord);
    recordActivity(config, user, "share.revoked", kind, record.id, { shareId });
    sendJson(res, 200, { shares: next.shareLinks.map(shareSummary) });
    return;
  }

  throw new HttpError(405, "Method not allowed");
}

function shareSummary(share: CloudShareLink): Omit<CloudShareLink, "tokenHash"> {
  const { tokenHash, ...out } = share;
  return out;
}

function collaboratorRole(value: unknown): Exclude<CloudRole, "owner"> {
  if (value === "viewer" || value === "editor") return value;
  throw new HttpError(400, "role must be viewer or editor");
}

function shareRole(value: unknown): Exclude<CloudRole, "owner"> {
  return value === undefined ? "viewer" : collaboratorRole(value);
}
