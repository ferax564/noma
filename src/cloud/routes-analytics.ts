/**
 * Page analytics: view beacons, per-page view statistics, and popular pages per space.
 * Views are deduplicated per viewer per page for 30 minutes; share-link views are anonymous.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { CloudDocumentRecord, CloudSiteRecord } from "../cloud-db.js";
import { type AccessContext, capAccessForDocument, type CloudServerConfig, type Principal, requireRecordAccess, roleRank } from "./context.js";
import { HttpError, sendJson, sha256Hex } from "./http.js";
import { boundedInteger, numberQuery } from "./input.js";

export const PAGE_VIEW_DEDUPE_MS = 30 * 60 * 1000;

/** Records one view for the caller. Anonymous share-link viewers are keyed by a hash of link and address. */
export function recordPageView(config: CloudServerConfig, req: IncomingMessage, document: CloudDocumentRecord, access: AccessContext): boolean {
  const viewedAt = config.now().toISOString();
  if (access.user) {
    return config.store.recordPageView({ documentId: document.id, viewerKey: access.user.id, userId: access.user.id, via: "user", viewedAt }, PAGE_VIEW_DEDUPE_MS);
  }
  const address = req.socket.remoteAddress ?? "unknown";
  const viewerKey = `share:${sha256Hex(`${access.share?.id ?? "share"}:${address}`).slice(0, 24)}`;
  return config.store.recordPageView({ documentId: document.id, viewerKey, via: "share", viewedAt }, PAGE_VIEW_DEDUPE_MS);
}

/** `POST /api/documents/:id/views` and `GET /api/documents/:id/analytics`. */
export async function routeDocumentAnalytics(
  req: IncomingMessage,
  res: ServerResponse,
  suffix: "views" | "analytics",
  config: CloudServerConfig,
  principal: Principal,
  document: CloudDocumentRecord,
  inheritedAccess?: AccessContext,
): Promise<void> {
  const method = req.method ?? "GET";
  const access = inheritedAccess ?? requireRecordAccess(config, document, principal, "viewer");
  if (suffix === "views") {
    if (method !== "POST") throw new HttpError(405, "Method not allowed");
    const recorded = recordPageView(config, req, document, access);
    const since = daysAgo(config, 30);
    sendJson(res, 200, { documentId: document.id, recorded, views: config.store.pageViewStats(document.id, since).totalViews });
    return;
  }
  if (method !== "GET") throw new HttpError(405, "Method not allowed");
  const url = new URL(req.url ?? "/", "http://noma.local");
  const days = boundedInteger(numberQuery(url.searchParams.get("days")), 30, 1, 365, "days");
  const since = daysAgo(config, days);
  const stats = config.store.pageViewStats(document.id, since);
  const canSeeViewers = Boolean(access.user) && access.via !== "share" && roleRank[access.role] >= roleRank.editor;
  sendJson(res, 200, {
    ...stats,
    days,
    ...(canSeeViewers ? { viewers: config.store.pageViewers(document.id, since) } : {}),
    viewersVisible: canSeeViewers,
  });
}

/** `GET /api/sites/:id/popular?days=30&limit=10`: most viewed pages in a space. */
export function routeSitePopular(req: IncomingMessage, res: ServerResponse, config: CloudServerConfig, principal: Principal, site: CloudSiteRecord): void {
  if ((req.method ?? "GET") !== "GET") throw new HttpError(405, "Method not allowed");
  const access = requireRecordAccess(config, site, principal, "viewer");
  const url = new URL(req.url ?? "/", "http://noma.local");
  const days = boundedInteger(numberQuery(url.searchParams.get("days")), 30, 1, 365, "days");
  const limit = boundedInteger(numberQuery(url.searchParams.get("limit")), 10, 1, 50, "limit");
  const pages = config.store
    .popularPages(site.id, daysAgo(config, days), 200)
    .filter((page) => capAccessForDocument(config, page.documentId, access) !== undefined)
    .slice(0, limit);
  sendJson(res, 200, { siteId: site.id, days, pages });
}

function daysAgo(config: CloudServerConfig, days: number): string {
  return new Date(config.now().getTime() - days * 86_400_000).toISOString();
}
