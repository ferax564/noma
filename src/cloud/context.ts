/**
 * Server config, principals, access control, record persistence, and activity/notification writers
 * shared by all Noma Cloud route modules. Must not import route modules.
 */
import { randomBytes, randomUUID } from "node:crypto";
import type { IncomingMessage } from "node:http";
import type {
  CloudDocumentRecord,
  CloudNotification,
  CloudProject,
  CloudResourceType,
  CloudRole,
  CloudShareLink,
  CloudSiteRecord,
  CloudUserRecord,
  NomaCloudDatabase,
} from "../cloud-db.js";
import type { CloudKnowledgePlatform } from "../cloud-platform.js";
import { authBearer, headerValue, HttpError, sha256Hex } from "./http.js";
import { assertCloudId } from "./input.js";

export interface CloudServerConfig {
  dataDir: string;
  usersDir: string;
  sitesDir: string;
  dbPath: string;
  publicDir: string;
  maxBodyBytes: number;
  accessTokenHash?: string;
  invitationCodeHash?: string;
  ssoTrustedHeaderHash?: string;
  rateLimiter: CloudRateLimiter;
  trustProxy: boolean;
  adminUserIds: string[];
  now: () => Date;
  store: NomaCloudDatabase;
  platform: CloudKnowledgePlatform;
}

export interface Principal {
  user?: CloudUserRecord;
  userTokenHash?: string;
  shareTokenHash?: string;
}

export interface AccessContext {
  role: CloudRole;
  via: "user" | "group" | "share";
  user?: CloudUserRecord;
  share?: CloudShareLink;
  groupId?: string;
}

interface RateLimitBucket {
  count: number;
  resetAt: number;
}

interface RateLimitResult {
  allowed: boolean;
  limit: number;
  remaining: number;
  resetAt: number;
}

export class CloudRateLimiter {
  private readonly buckets = new Map<string, RateLimitBucket>();

  constructor(
    private readonly windowMs: number,
    private readonly apiLimit: number,
    private readonly authLimit: number,
  ) {}

  consume(key: string, auth: boolean, now: number): RateLimitResult {
    const limit = auth ? this.authLimit : this.apiLimit;
    const bucket = this.buckets.get(key);
    const active = bucket && bucket.resetAt > now ? bucket : { count: 0, resetAt: now + this.windowMs };
    active.count += 1;
    this.buckets.set(key, active);
    if (this.buckets.size > 10_000) this.prune(now);
    return {
      allowed: active.count <= limit,
      limit,
      remaining: Math.max(0, limit - active.count),
      resetAt: active.resetAt,
    };
  }

  private prune(now: number): void {
    for (const [key, bucket] of this.buckets) {
      if (bucket.resetAt <= now) this.buckets.delete(key);
    }
  }
}

export const roleRank: Record<CloudRole, number> = {
  viewer: 1,
  editor: 2,
  owner: 3,
};

export async function resolvePrincipal(config: CloudServerConfig, req: IncomingMessage, url: URL): Promise<Principal> {
  const userToken = authBearer(req) ?? headerValue(req, "x-noma-user-token");
  const shareToken = url.searchParams.get("share") ?? headerValue(req, "x-noma-share-token");
  const principal: Principal = {};
  if (userToken) {
    principal.userTokenHash = sha256Hex(userToken);
    principal.user = await findUserByToken(config, principal.userTokenHash);
  }
  if (shareToken) principal.shareTokenHash = sha256Hex(shareToken);
  return principal;
}

export async function findUserByToken(config: CloudServerConfig, tokenHash: string): Promise<CloudUserRecord | undefined> {
  return config.store.findUserByToken(tokenHash);
}

export function requireUser(principal: Principal): CloudUserRecord {
  if (!principal.user) throw new HttpError(401, "A cloud user token is required");
  return principal.user;
}

export async function requireResourceAccess(
  config: CloudServerConfig,
  principal: Principal,
  resourceType: CloudResourceType,
  resourceId: string,
  minimum: CloudRole,
  allowTrashed = false,
): Promise<AccessContext> {
  const record = resourceType === "document" ? await readDocument(config, resourceId) : await readSite(config, resourceId);
  if (!allowTrashed) requireNotTrashed(config, resourceType, resourceId);
  return requireRecordAccess(config, record, principal, minimum);
}

export function requireProjectAccess(
  config: CloudServerConfig,
  project: CloudProject,
  principal: Principal,
  minimum: CloudRole,
): AccessContext {
  const site = config.store.readSite(project.siteId);
  if (!site) throw new HttpError(404, "Project space not found");
  requireNotTrashed(config, "site", site.id);
  return requireRecordAccess(config, site, principal, minimum);
}

export function requireNotTrashed(config: CloudServerConfig, resourceType: CloudResourceType, resourceId: string): void {
  if (config.store.isTrashed(resourceType, resourceId)) {
    throw new HttpError(410, `${resourceType === "document" ? "Document" : "Site"} is in trash`, {
      code: "resource_trashed",
      resourceType,
      resourceId,
    });
  }
}

export function requireRecordAccess(
  config: CloudServerConfig,
  record: CloudDocumentRecord | CloudSiteRecord,
  principal: Principal,
  minimum: CloudRole,
): AccessContext {
  const access = recordAccess(config, record, principal);
  if (!access || roleRank[access.role] < roleRank[minimum]) {
    const status = principal.user || principal.shareTokenHash ? 403 : 401;
    throw new HttpError(access ? 403 : status, `${minimum} access is required`);
  }
  return access;
}

export function requireAccessRole(access: AccessContext, minimum: CloudRole): void {
  if (roleRank[access.role] < roleRank[minimum]) throw new HttpError(403, `${minimum} access is required`);
}

function recordAccess(
  config: CloudServerConfig,
  record: CloudDocumentRecord | CloudSiteRecord,
  principal: Principal,
): AccessContext | undefined {
  let best: AccessContext | undefined;
  if (principal.user) {
    const grant = config.store.resourceAccess(principal.user.id, "source" in record ? "document" : "site", record.id);
    if (grant) {
      best = {
        role: grant.role,
        via: grant.via,
        user: principal.user,
        ...(grant.groupId ? { groupId: grant.groupId } : {}),
      };
    }
  }

  if (principal.shareTokenHash) {
    const share = record.shareLinks.find((item) => !item.revokedAt && item.tokenHash === principal.shareTokenHash);
    if (share && (!best || roleRank[share.role] > roleRank[best.role])) {
      best = { role: share.role, via: "share", user: principal.user, share };
    }
  }

  return best;
}

export async function readDocument(config: CloudServerConfig, id: string): Promise<CloudDocumentRecord> {
  assertCloudId(id, "Document");
  const record = config.store.readDocument(id);
  if (!record) throw new HttpError(404, "Record not found");
  if (record.version === 2 && record.id === id && typeof record.source === "string") return record;
  throw new HttpError(500, "Stored document is invalid");
}

export async function readSite(config: CloudServerConfig, id: string): Promise<CloudSiteRecord> {
  assertCloudId(id, "Site");
  const record = config.store.readSite(id);
  if (!record) throw new HttpError(404, "Record not found");
  if (record.version !== 1 || record.id !== id || !Array.isArray(record.documentIds)) {
    throw new HttpError(500, "Stored site is invalid");
  }
  return record;
}

export async function readUser(config: CloudServerConfig, id: string): Promise<CloudUserRecord> {
  assertCloudId(id, "User");
  const record = config.store.readUser(id);
  if (!record) throw new HttpError(404, "Record not found");
  if (record.version !== 1 || record.id !== id || typeof record.tokenHash !== "string") {
    throw new HttpError(500, "Stored user is invalid");
  }
  return record;
}

export async function writeDocument(config: CloudServerConfig, record: CloudDocumentRecord, expectedHash?: string): Promise<void> {
  if (config.store.writeDocument(record, expectedHash)) return;
  const current = config.store.readDocument(record.id);
  throw new HttpError(409, "Document changed while the update was being applied", {
    code: "document_conflict",
    expectedHash,
    currentHash: current?.hash,
    currentUpdatedAt: current?.updatedAt,
  });
}

export async function writeSite(config: CloudServerConfig, record: CloudSiteRecord): Promise<void> {
  config.store.writeSite(record);
}

export async function writeUser(config: CloudServerConfig, record: CloudUserRecord): Promise<void> {
  config.store.writeUser(record);
}

export function uniqueId(config: CloudServerConfig): string {
  for (let attempt = 0; attempt < 12; attempt++) {
    const id = randomId();
    if (!config.store.hasRecordId(id)) return id;
  }
  throw new HttpError(500, "Could not allocate ID");
}

export function randomId(): string {
  return randomUUID().replace(/-/g, "").slice(0, 18);
}

export function randomToken(prefix: string): string {
  return `${prefix}_${randomBytes(24).toString("base64url")}`;
}

export function tokenPreview(token: string): string {
  return token.slice(0, 5) + "..." + token.slice(-6);
}

export function writeNotification(
  config: CloudServerConfig,
  userId: string,
  type: CloudNotification["type"],
  title: string,
  body: string,
  resourceType?: CloudResourceType,
  resourceId?: string,
): void {
  config.store.writeNotification({
    id: randomId(),
    userId,
    type,
    title,
    body,
    ...(resourceType ? { resourceType } : {}),
    ...(resourceId ? { resourceId } : {}),
    createdAt: config.now().toISOString(),
  });
}

export function recordActivity(
  config: CloudServerConfig,
  actor: CloudUserRecord,
  action: string,
  resourceType: CloudResourceType,
  resourceId: string,
  detail: Record<string, unknown> = {},
): void {
  config.store.writeActivity({
    id: randomId(),
    actorId: actor.id,
    action,
    resourceType,
    resourceId,
    detail,
    createdAt: config.now().toISOString(),
  });
}

export function sqliteConstraint(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && String(error.code).startsWith("SQLITE_CONSTRAINT"));
}

export function recordIssueEvent(
  config: CloudServerConfig,
  actor: CloudUserRecord,
  issueId: string,
  action: string,
  detail: Record<string, unknown> = {},
): void {
  config.store.writeIssueEvent({ id: randomId(), issueId, actorId: actor.id, action, detail, createdAt: config.now().toISOString() });
}

export function requireWorkspaceOwner(config: CloudServerConfig, user: CloudUserRecord): void {
  if (!isWorkspaceAdmin(config, user)) throw new HttpError(403, "Workspace owner access is required");
}

function isWorkspaceAdmin(config: CloudServerConfig, user: CloudUserRecord): boolean {
  if (config.adminUserIds.length > 0) return config.adminUserIds.includes(user.id);
  return config.store.firstRegisteredUserId() === user.id;
}
