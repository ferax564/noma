/** Workspace-wide listings: search, navigation, templates, trash, labels, notifications, activity. */
import type { IncomingMessage, ServerResponse } from "node:http";
import { cloudPageTemplates } from "../cloud-templates.js";
import {
  type CloudServerConfig,
  type Principal,
  recordActivity,
  requireResourceAccess,
  requireUser,
} from "./context.js";
import { decodePathSegment, HttpError, readJsonBody, sendJson } from "./http.js";
import {
  boundedInteger,
  labelInput,
  numberQuery,
  optionalCloudId,
  resourceIdInput,
  resourceTypeInput,
} from "./input.js";

export function routeSearch(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  config: CloudServerConfig,
  principal: Principal,
): void {
  if ((req.method ?? "GET") !== "GET") throw new HttpError(405, "Method not allowed");
  const user = requireUser(principal);
  const q = (url.searchParams.get("q") ?? "").trim().slice(0, 200);
  const siteId = optionalCloudId(url.searchParams.get("site"), "Site");
  const limit = boundedInteger(numberQuery(url.searchParams.get("limit")), 25, 1, 100, "limit");
  sendJson(res, 200, { q, results: config.store.search(user, q, siteId, limit) });
}

export async function routeNavigation(
  req: IncomingMessage,
  res: ServerResponse,
  parts: string[],
  config: CloudServerConfig,
  principal: Principal,
): Promise<void> {
  const method = req.method ?? "GET";
  const action = parts[2];
  const user = requireUser(principal);
  if (!action && method === "GET") {
    sendJson(res, 200, {
      recents: config.store.listRecents(user),
      favorites: config.store.listFavorites(user),
    });
    return;
  }
  if (action === "recent" && method === "POST") {
    const input = await readJsonBody(req, config.maxBodyBytes);
    const resourceType = resourceTypeInput(input.resourceType);
    const resourceId = resourceIdInput(input.resourceId, resourceType);
    await requireResourceAccess(config, principal, resourceType, resourceId, "viewer");
    config.store.recordRecent(user.id, resourceType, resourceId, config.now().toISOString());
    sendJson(res, 200, { ok: true });
    return;
  }
  if (action === "favorites" && (method === "PUT" || method === "DELETE")) {
    const input = await readJsonBody(req, config.maxBodyBytes);
    const resourceType = resourceTypeInput(input.resourceType);
    const resourceId = resourceIdInput(input.resourceId, resourceType);
    await requireResourceAccess(config, principal, resourceType, resourceId, "viewer");
    if (method === "PUT") config.store.setFavorite(user.id, resourceType, resourceId, config.now().toISOString());
    else config.store.removeFavorite(user.id, resourceType, resourceId);
    sendJson(res, 200, { ok: true });
    return;
  }
  throw new HttpError(404, "Unknown navigation route");
}

export function routeTemplates(req: IncomingMessage, res: ServerResponse, config: CloudServerConfig, principal: Principal): void {
  if ((req.method ?? "GET") !== "GET") throw new HttpError(405, "Method not allowed");
  requireUser(principal);
  sendJson(res, 200, { templates: cloudPageTemplates, count: cloudPageTemplates.length, storage: "built-in" });
}

export async function routeTrash(
  req: IncomingMessage,
  res: ServerResponse,
  parts: string[],
  config: CloudServerConfig,
  principal: Principal,
): Promise<void> {
  const method = req.method ?? "GET";
  const user = requireUser(principal);
  const rawType = parts[2];
  if (!rawType && method === "GET") {
    sendJson(res, 200, { items: config.store.listTrash(user) });
    return;
  }
  const resourceType = resourceTypeInput(rawType);
  const resourceId = resourceIdInput(parts[3], resourceType);
  const action = parts[4];
  if (method === "POST" && !action) {
    await requireResourceAccess(config, principal, resourceType, resourceId, resourceType === "site" ? "owner" : "editor", true);
    config.store.trashResource(resourceType, resourceId, config.now().toISOString(), user.id);
    config.store.removeFavorite(user.id, resourceType, resourceId);
    recordActivity(config, user, `${resourceType}.trashed`, resourceType, resourceId);
    sendJson(res, 200, { ok: true, resourceType, resourceId });
    return;
  }
  if (method === "POST" && action === "restore") {
    await requireResourceAccess(config, principal, resourceType, resourceId, resourceType === "site" ? "owner" : "editor", true);
    if (!config.store.isTrashed(resourceType, resourceId)) throw new HttpError(409, "Resource is not in trash");
    config.store.restoreResource(resourceType, resourceId);
    recordActivity(config, user, `${resourceType}.restored`, resourceType, resourceId);
    sendJson(res, 200, { ok: true, resourceType, resourceId });
    return;
  }
  if (method === "DELETE" && !action) {
    await requireResourceAccess(config, principal, resourceType, resourceId, "owner", true);
    if (!config.store.isTrashed(resourceType, resourceId)) throw new HttpError(409, "Only trashed resources can be permanently deleted");
    const held = config.platform
      .listLegalHolds()
      .some((hold) => !hold.releasedAt && hold.resourceType === resourceType && hold.resourceId === resourceId);
    if (held) throw new HttpError(409, "Resource is under legal hold", { code: "legal_hold" });
    config.store.purgeResource(resourceType, resourceId);
    sendJson(res, 200, { ok: true, purged: true, resourceType, resourceId });
    return;
  }
  throw new HttpError(404, "Unknown trash route");
}

export async function routeNotifications(
  req: IncomingMessage,
  res: ServerResponse,
  parts: string[],
  config: CloudServerConfig,
  principal: Principal,
): Promise<void> {
  const method = req.method ?? "GET";
  const user = requireUser(principal);
  const id = parts[2];
  const action = parts[3];
  if (!id && method === "GET") {
    const notifications = config.store.listNotifications(user.id);
    sendJson(res, 200, { notifications, unread: notifications.filter((notification) => !notification.readAt).length });
    return;
  }
  if (id === "read-all" && method === "POST") {
    const changed = config.store.markAllNotificationsRead(user.id, config.now().toISOString());
    sendJson(res, 200, { ok: true, changed });
    return;
  }
  if (id && action === "read" && method === "POST") {
    if (!config.store.markNotificationRead(user.id, id, config.now().toISOString())) throw new HttpError(404, "Notification not found");
    sendJson(res, 200, { ok: true });
    return;
  }
  throw new HttpError(404, "Unknown notification route");
}

export function routeActivity(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  config: CloudServerConfig,
  principal: Principal,
): void {
  if ((req.method ?? "GET") !== "GET") throw new HttpError(405, "Method not allowed");
  const user = requireUser(principal);
  const siteId = optionalCloudId(url.searchParams.get("site"), "Site");
  const documentId = optionalCloudId(url.searchParams.get("document"), "Document");
  const limit = boundedInteger(numberQuery(url.searchParams.get("limit")), 50, 1, 100, "limit");
  sendJson(res, 200, { events: config.store.listActivity(user, siteId, documentId, limit) });
}

export function routeLabels(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  parts: string[],
  config: CloudServerConfig,
  principal: Principal,
): void {
  if ((req.method ?? "GET") !== "GET") throw new HttpError(405, "Method not allowed");
  const user = requireUser(principal);
  const siteId = optionalCloudId(url.searchParams.get("site"), "Site");
  const labelText = parts[2];
  if (!labelText) {
    sendJson(res, 200, { labels: config.store.listLabels(user, siteId) });
    return;
  }
  const label = labelInput(decodePathSegment(labelText));
  sendJson(res, 200, { label, documents: config.store.listDocumentsByLabel(user, label, siteId) });
}
