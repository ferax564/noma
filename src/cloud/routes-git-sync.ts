/**
 * `GET /api/sites/:id/sync-manifest`: the page list a Git-native sync client diffs against. Each page
 * carries its revision hash and a stable repository path derived from the page tree and title slug.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { CloudSiteRecord } from "../cloud-db.js";
import { type CloudServerConfig, type Principal, readSite, requireNotTrashed, requireRecordAccess } from "./context.js";
import { HttpError, sendJson } from "./http.js";
import { stringPathPart } from "./input.js";
import { cloudSlug } from "./records.js";
import { effectivePageParent, pageParentMap } from "./routes-sites.js";

export const syncManifestFormat = "noma-space-sync-v1";

export interface SyncManifestPage {
  id: string;
  title: string;
  path: string;
  parentId?: string;
  labels: string[];
  hash: string;
  updatedAt: string;
}

export async function routeSyncManifest(req: IncomingMessage, res: ServerResponse, parts: string[], config: CloudServerConfig, principal: Principal): Promise<void> {
  if ((req.method ?? "GET") !== "GET") throw new HttpError(405, "Method not allowed");
  const site = await readSite(config, stringPathPart(parts[2], "Site ID"));
  requireNotTrashed(config, "site", site.id);
  const access = requireRecordAccess(config, site, principal, "viewer");
  sendJson(res, 200, {
    format: syncManifestFormat,
    site: { id: site.id, title: site.title, slug: site.slug, updatedAt: site.updatedAt },
    generatedAt: config.now().toISOString(),
    role: access.role,
    pages: syncManifestPages(config, site),
  });
}

export function syncManifestPages(config: CloudServerConfig, site: CloudSiteRecord): SyncManifestPage[] {
  const parents = pageParentMap(site.pageParents, site.documentIds);
  const visible = site.documentIds
    .filter((id) => !config.store.isTrashed("document", id))
    .map((id) => config.store.readDocument(id))
    .filter((document): document is NonNullable<typeof document> => Boolean(document));
  const visibleIds = new Set(visible.map((document) => document.id));
  const parentOf = new Map<string, string | undefined>();
  for (const document of visible) {
    const parent = effectivePageParent(config, parents, document.id);
    parentOf.set(document.id, parent && visibleIds.has(parent) ? parent : undefined);
  }
  const segment = new Map<string, string>();
  const taken = new Map<string, Set<string>>();
  for (const document of visible) {
    const scope = parentOf.get(document.id) ?? "";
    const used = taken.get(scope) ?? new Set<string>();
    let slug = cloudSlug(document.title, document.id).toLowerCase().replace(/[^a-z0-9._-]+/g, "-").replace(/^[.-]+|-+$/g, "") || document.id;
    if (used.has(slug)) slug = `${slug}-${document.id.slice(0, 8).toLowerCase()}`;
    used.add(slug);
    taken.set(scope, used);
    segment.set(document.id, slug);
  }
  const directory = (id: string): string[] => {
    const chain: string[] = [];
    const seen = new Set<string>();
    let cursor = parentOf.get(id);
    while (cursor && !seen.has(cursor)) {
      seen.add(cursor);
      chain.unshift(segment.get(cursor) ?? cursor);
      cursor = parentOf.get(cursor);
    }
    return chain;
  };
  return visible.map((document) => {
    const parentId = parentOf.get(document.id);
    return {
      id: document.id,
      title: document.title,
      path: [...directory(document.id), `${segment.get(document.id)}.noma`].join("/"),
      ...(parentId ? { parentId } : {}),
      labels: config.store.listDocumentLabels(document.id),
      hash: document.hash,
      updatedAt: document.updatedAt,
    };
  });
}
