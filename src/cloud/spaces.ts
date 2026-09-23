/**
 * Space identity and lifecycle: unique keys, description, icon, home page, and archiving.
 * Archived spaces are read-only: every write to the space or to a page that lives only in
 * archived spaces is rejected with `409 space_archived` until an owner unarchives it.
 */
import type { IncomingMessage } from "node:http";
import type { CloudDocumentRecord, CloudSiteRecord } from "../cloud-db.js";
import { type CloudServerConfig, type Principal, recordActivity, requireRecordAccess, requireUser, sqliteConstraint, writeSite } from "./context.js";
import { HttpError } from "./http.js";
import { assertCloudId } from "./input.js";

const SPACE_KEY_RE = /^[A-Z][A-Z0-9]{1,9}$/;

export interface SpaceSettings {
  key?: string;
  description?: string;
  icon?: string;
  homeDocumentId?: string;
}

export function spaceKeyInput(value: unknown): string {
  if (typeof value !== "string") throw new HttpError(400, "key must be a string");
  const key = value.trim().toUpperCase();
  if (!SPACE_KEY_RE.test(key)) throw new HttpError(400, "key must be 2-10 letters or digits, starting with a letter");
  return key;
}

/** A free key derived from the title: word initials, else leading letters, suffixed with digits on collision. */
export function deriveSpaceKey(config: CloudServerConfig, title: string): string {
  const words = title.normalize("NFKD").toUpperCase().replace(/[^A-Z0-9\s]/g, " ").split(/\s+/).filter(Boolean);
  const initials = words.map((word) => word[0]).join("");
  const letters = words.join("");
  let base = (initials.length >= 2 ? initials : letters).replace(/^[0-9]+/, "").slice(0, 6);
  if (base.length < 2) base = `${base}SP`.slice(0, 2).padEnd(2, "S");
  if (!/^[A-Z]/.test(base)) base = `S${base}`.slice(0, 6);
  for (let attempt = 0; attempt < 10_000; attempt++) {
    const candidate = attempt === 0 ? base : `${base}${attempt + 1}`.slice(0, 10);
    if (!config.store.siteIdForKey(candidate)) return candidate;
  }
  throw new HttpError(500, "Could not allocate a space key");
}

/**
 * Validates space settings from a create/update body. `documentIds` is the space's page list
 * after the update, so a home page removed from the space is rejected.
 */
export function spaceSettingsInput(config: CloudServerConfig, input: Record<string, unknown>, documentIds: string[], siteId: string | undefined): SpaceSettings {
  const settings: SpaceSettings = {};
  if (input.key !== undefined && input.key !== null) {
    const key = spaceKeyInput(input.key);
    const owner = config.store.siteIdForKey(key);
    if (owner && owner !== siteId) throw new HttpError(409, `Space key ${key} is already in use`, { code: "space_key_taken" });
    settings.key = key;
  }
  if (input.description !== undefined) {
    if (input.description !== null && typeof input.description !== "string") throw new HttpError(400, "description must be a string");
    settings.description = (input.description ?? "").trim().slice(0, 2_000);
  }
  if (input.icon !== undefined) {
    if (input.icon !== null && typeof input.icon !== "string") throw new HttpError(400, "icon must be a string");
    const icon = (input.icon ?? "").trim();
    if ([...icon].length > 8 || /[<>"'&\p{Cc}]/u.test(icon)) throw new HttpError(400, "icon must be an emoji or up to 8 plain characters");
    settings.icon = icon;
  }
  if (input.homeDocumentId !== undefined) {
    if (input.homeDocumentId === null || input.homeDocumentId === "") {
      settings.homeDocumentId = "";
    } else {
      if (typeof input.homeDocumentId !== "string") throw new HttpError(400, "homeDocumentId must be a document ID");
      assertCloudId(input.homeDocumentId, "Home document");
      if (!documentIds.includes(input.homeDocumentId)) throw new HttpError(400, "homeDocumentId must be a page in this space");
      if (config.store.isTrashed("document", input.homeDocumentId)) throw new HttpError(400, "homeDocumentId is in trash");
      settings.homeDocumentId = input.homeDocumentId;
    }
  }
  return settings;
}

/** Applies validated settings; empty strings clear optional fields. */
export function applySpaceSettings(record: CloudSiteRecord, settings: SpaceSettings): CloudSiteRecord {
  const next: CloudSiteRecord = { ...record };
  if (settings.key !== undefined) next.key = settings.key;
  for (const field of ["description", "icon", "homeDocumentId"] as const) {
    const value = settings[field];
    if (value === undefined) continue;
    if (value) next[field] = value;
    else delete next[field];
  }
  if (next.homeDocumentId && !next.documentIds.includes(next.homeDocumentId)) delete next.homeDocumentId;
  return next;
}

/** Persists a site, mapping a concurrent key collision to 409. */
export async function writeSiteWithKey(config: CloudServerConfig, record: CloudSiteRecord): Promise<void> {
  try {
    await writeSite(config, record);
  } catch (error) {
    if (sqliteConstraint(error)) throw new HttpError(409, `Space key ${record.key ?? ""} is already in use`, { code: "space_key_taken" });
    throw error;
  }
}

export function requireSpaceWritable(site: CloudSiteRecord): void {
  if (site.archivedAt) throw new HttpError(409, "Space is archived and read-only", { code: "space_archived", siteId: site.id });
}

export function requirePageWritable(config: CloudServerConfig, documentId: string): void {
  if (config.store.isDocumentArchived(documentId)) throw new HttpError(409, "This page is in an archived space and is read-only", { code: "space_archived", documentId });
}

const ARCHIVE_EXEMPT_SITE_SUFFIXES = new Set(["archive", "unarchive", "watch"]);

/**
 * Router guard: rejects mutating requests against an archived space or a page that lives only in
 * archived spaces. Reads, watching, and unarchiving stay available.
 */
export function guardArchivedSpaceWrite(req: IncomingMessage, parts: string[], config: CloudServerConfig, principal: Principal): void {
  const method = req.method ?? "GET";
  if (method === "GET" || method === "HEAD" || method === "OPTIONS") return;
  const [, resource, id, suffix] = parts;
  const validId = (value: string | undefined): value is string => Boolean(value && /^[A-Za-z0-9_-]{8,80}$/.test(value));
  if (!validId(id)) return;
  if (resource === "sites") {
    if (suffix && ARCHIVE_EXEMPT_SITE_SUFFIXES.has(suffix)) return;
    const site = config.store.readSite(id);
    if (site?.archivedAt && canView(config, site, principal)) requireSpaceWritable(site);
    return;
  }
  const documentId = resource === "documents" && suffix !== "watch" ? id : resource === "trash" && id === "document" && validId(parts[3]) && parts[4] === undefined ? parts[3] : undefined;
  if (!documentId) return;
  const document = config.store.readDocument(documentId);
  if (document && canView(config, document, principal)) requirePageWritable(config, documentId);
}

/** Only callers who can already see the resource learn that it is archived; others get the route's own 401/403/404. */
function canView(config: CloudServerConfig, record: CloudSiteRecord | CloudDocumentRecord, principal: Principal): boolean {
  try {
    requireRecordAccess(config, record, principal, "viewer");
    return true;
  } catch {
    return false;
  }
}

/** `POST /api/sites/:id/archive` and `/unarchive` (space owners only). */
export async function setSpaceArchived(
  action: "archive" | "unarchive",
  config: CloudServerConfig,
  principal: Principal,
  site: CloudSiteRecord,
): Promise<CloudSiteRecord> {
  const user = requireUser(principal);
  requireRecordAccess(config, site, principal, "owner");
  const now = config.now().toISOString();
  const next: CloudSiteRecord = { ...site, updatedAt: now, updatedBy: user.id };
  if (action === "archive") {
    if (site.archivedAt) throw new HttpError(409, "Space is already archived");
    next.archivedAt = now;
    next.archivedBy = user.id;
  } else {
    if (!site.archivedAt) throw new HttpError(409, "Space is not archived");
    delete next.archivedAt;
    delete next.archivedBy;
  }
  await writeSite(config, next);
  recordActivity(config, user, `site.${action}d`, "site", site.id, { title: site.title });
  return next;
}
