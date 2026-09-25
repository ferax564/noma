/** `/api/sites`: sites, site documents, page tree/breadcrumbs/moves, folders, and the site wiki. */
import type { IncomingMessage, ServerResponse } from "node:http";
import { walk } from "../ast.js";
import type { CloudDocumentRecord, CloudSiteRecord, CloudUserRecord } from "../cloud-db.js";
import { extractWikilinks } from "../inline.js";
import { parse } from "../parser.js";
import {
  type AccessContext,
  capAccessForDocument,
  type CloudServerConfig,
  type Principal,
  readDocument,
  readSite,
  recordActivity,
  requireAccessRole,
  requireNotTrashed,
  requireRecordAccess,
  requireSiteDocumentAccess,
  requireUser,
  uniqueId,
  writeSite,
} from "./context.js";
import { HttpError, readJsonBody, sendJson } from "./http.js";
import { assertCloudId, documentIdList, optionalCloudId, optionalString, stringInput } from "./input.js";
import {
  accessResponse,
  cloudSlug,
  createDocument,
  documentResponse,
  requireDocumentPrecondition,
  type SourceInspection,
  updateDocument,
} from "./records.js";
import { afterDocumentSaved } from "./page-hooks.js";
import { documentSummary } from "./macros.js";
import { routeCollaborators, routeGroupCollaborators, routeShares } from "./routes-access.js";
import { routeDocumentAnalytics, routeSitePopular } from "./routes-analytics.js";
import { routeSiteExport } from "./routes-export.js";
import { routeDocumentTasks } from "./routes-tasks.js";
import { routeSiteWebhooks } from "./routes-webhooks.js";
import {
  routeDocumentApprovals,
  routeDocumentComments,
  routeDocumentRevisions,
  routeWatch,
} from "./routes-documents.js";
import { routePatchProposals } from "./routes-patch.js";
import { applySpaceSettings, deriveSpaceKey, setSpaceArchived, spaceSettingsInput, writeSiteWithKey } from "./spaces.js";

interface WikiPageSummary {
  id: string;
  title: string;
  slug: string;
  updatedAt: string;
}

interface WikiLinkSummary {
  fromDocumentId: string;
  fromTitle: string;
  target: string;
  label: string;
  resolvedDocumentId?: string;
  resolvedTitle?: string;
  missing: boolean;
}

export async function routeSites(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
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
    const record = await createSite(config, input, user, principal);
    sendJson(res, 201, siteResponse(config, record, requireRecordAccess(config, record, principal, "owner")));
    return;
  }

  if (!id && method === "GET") {
    const user = requireUser(principal);
    const archived = url.searchParams.get("archived") ?? "exclude";
    if (archived !== "exclude" && archived !== "include" && archived !== "only") throw new HttpError(400, "archived must be exclude, include, or only");
    sendJson(res, 200, { sites: await listSites(config, user, archived) });
    return;
  }

  if (!id) throw new HttpError(404, "Site ID is required");

  const site = await readSite(config, id);
  requireNotTrashed(config, "site", id);

  if (suffix === "collaborators") {
    await routeCollaborators(req, res, parts[4], config, principal, site, "site");
    return;
  }

  if (suffix === "group-collaborators") {
    await routeGroupCollaborators(req, res, parts[4], config, principal, site, "site");
    return;
  }

  if (suffix === "shares") {
    await routeShares(req, res, parts[4], config, principal, site, "site");
    return;
  }

  if (suffix === "documents") {
    await routeSiteDocuments(req, res, parts, config, principal, site);
    return;
  }

  if (suffix === "wiki") {
    await routeSiteWiki(req, res, config, principal, site);
    return;
  }

  if (suffix === "tree") {
    if (method !== "GET") throw new HttpError(405, "Method not allowed");
    const access = requireRecordAccess(config, site, principal, "viewer");
    sendJson(res, 200, { siteId: site.id, title: site.title, pages: sitePageTree(config, site, access), access: accessResponse(access) });
    return;
  }

  if (suffix === "watch") {
    routeWatch(req, res, config, principal, site, "site");
    return;
  }

  if (suffix === "webhooks") {
    await routeSiteWebhooks(req, res, parts[4], parts[5], config, principal, site);
    return;
  }

  if (suffix === "popular") {
    routeSitePopular(req, res, config, principal, site);
    return;
  }

  if (suffix === "archive" || suffix === "unarchive") {
    if (method !== "POST") throw new HttpError(405, "Method not allowed");
    const updated = await setSpaceArchived(suffix, config, principal, site);
    sendJson(res, 200, siteResponse(config, updated, requireRecordAccess(config, updated, principal, "viewer")));
    return;
  }

  if (suffix === "export") {
    await routeSiteExport(req, res, url, config, principal, site);
    return;
  }

  if (suffix) throw new HttpError(404, "Unknown site route");

  if (method === "GET") {
    const access = requireRecordAccess(config, site, principal, "viewer");
    if (access.user) config.store.recordRecent(access.user.id, "site", site.id, config.now().toISOString());
    const response = siteResponse(config, site, access);
    if (url.searchParams.get("include") === "documents") {
      sendJson(res, 200, {
        ...response,
        documents: await siteDocumentResponses(config, site, access),
      });
      return;
    }
    sendJson(res, 200, response);
    return;
  }

  if (method === "PUT" || method === "PATCH") {
    const access = requireRecordAccess(config, site, principal, "editor");
    const input = await readJsonBody(req, config.maxBodyBytes);
    const updated = await updateSite(config, site, input, access, principal);
    sendJson(res, 200, siteResponse(config, updated, requireRecordAccess(config, updated, principal, "viewer")));
    return;
  }

  throw new HttpError(405, "Method not allowed");
}

async function routeSiteDocuments(
  req: IncomingMessage,
  res: ServerResponse,
  parts: string[],
  config: CloudServerConfig,
  principal: Principal,
  site: CloudSiteRecord,
): Promise<void> {
  const method = req.method ?? "GET";
  const docId = parts[4];

  if (!docId && method === "GET") {
    const access = requireRecordAccess(config, site, principal, "viewer");
    sendJson(res, 200, { documents: await siteDocumentResponses(config, site, access) });
    return;
  }

  if (!docId && method === "POST") {
    const access = requireRecordAccess(config, site, principal, "editor");
    const user = requireUser(principal);
    const input = await readJsonBody(req, config.maxBodyBytes);
    const document = await createDocument(config, input, user, site.title, site.id, true);
    const now = config.now().toISOString();
    const documentIds = [...site.documentIds, document.id];
    const pageFolders = pageFolderMap(site.pageFolders, documentIds);
    const folder = optionalFolderName(input.folder);
    if (folder) pageFolders[document.id] = folder;
    const parentId = optionalCloudId(input.parentId, "Parent document");
    if (parentId && (!site.documentIds.includes(parentId) || !capAccessForDocument(config, parentId, access))) {
      throw new HttpError(400, "parentId must be a page in this site");
    }
    const pageParents = { ...pageParentMap(site.pageParents, documentIds), ...(parentId ? { [document.id]: parentId } : {}) };
    const nextSite: CloudSiteRecord = {
      ...site,
      documentIds: parentId ? placeAfterSubtree(documentIds, pageParents, document.id, parentId) : documentIds,
      folders: normalizeSiteFolders(site.folders ?? [], pageFolders),
      pageFolders,
      pageParents,
      updatedAt: now,
      updatedBy: access.user?.id ?? site.updatedBy,
    };
    await writeSite(config, nextSite);
    afterDocumentSaved(config, undefined, document, { user, name: user.name });
    sendJson(res, 201, documentResponse(document, requireRecordAccess(config, document, principal, "owner"), config));
    return;
  }

  if (!docId) throw new HttpError(404, "Document ID is required");
  assertCloudId(docId, "Document");
  if (!site.documentIds.includes(docId)) throw new HttpError(404, "Document is not in this site");
  requireNotTrashed(config, "document", docId);

  if (parts[5] === "revisions") {
    const access = requireSiteDocumentAccess(config, site, docId, principal, "viewer");
    await routeDocumentRevisions(req, res, parts[6], parts[7], config, await readDocument(config, docId), access);
    return;
  }

  if (parts[5] === "breadcrumbs") {
    if (method !== "GET") throw new HttpError(405, "Method not allowed");
    const access = requireSiteDocumentAccess(config, site, docId, principal, "viewer");
    sendJson(res, 200, { breadcrumbs: pageBreadcrumbs(config, site, docId, access) });
    return;
  }

  if (parts[5] === "parent") {
    if (method !== "PUT") throw new HttpError(405, "Method not allowed");
    const access = requireRecordAccess(config, site, principal, "editor");
    requireSiteDocumentAccess(config, site, docId, principal, "editor");
    const input = await readJsonBody(req, config.maxBodyBytes);
    const updated = await movePage(config, site, docId, input, access);
    sendJson(res, 200, { site: siteResponse(config, updated, access), pages: sitePageTree(config, updated, access) });
    return;
  }

  if (parts[5] === "comments") {
    await routeDocumentComments(req, res, parts[6], parts[7], config, principal, await readDocument(config, docId), requireSiteDocumentAccess(config, site, docId, principal, "viewer"), parts[8]);
    return;
  }

  if (parts[5] === "tasks") {
    await routeDocumentTasks(req, res, parts[6], config, principal, await readDocument(config, docId), requireSiteDocumentAccess(config, site, docId, principal, "viewer"));
    return;
  }

  if (parts[5] === "views" || parts[5] === "analytics") {
    await routeDocumentAnalytics(req, res, parts[5], config, principal, await readDocument(config, docId), requireSiteDocumentAccess(config, site, docId, principal, "viewer"));
    return;
  }

  if (parts[5] === "approvals") {
    await routeDocumentApprovals(req, res, parts[6], config, principal, await readDocument(config, docId), requireSiteDocumentAccess(config, site, docId, principal, "viewer"));
    return;
  }

  if (parts[5] === "patch-proposals") {
    await routePatchProposals(
      req,
      res,
      parts[6],
      parts[7],
      config,
      principal,
      await readDocument(config, docId),
      requireSiteDocumentAccess(config, site, docId, principal, "viewer"),
    );
    return;
  }

  if (method === "GET") {
    const access = requireSiteDocumentAccess(config, site, docId, principal, "viewer");
    if (access.user) config.store.recordRecent(access.user.id, "document", docId, config.now().toISOString());
    sendJson(res, 200, documentResponse(await readDocument(config, docId), access, config));
    return;
  }

  if (method === "PUT" || method === "PATCH") {
    const access = requireSiteDocumentAccess(config, site, docId, principal, "editor");
    const input = await readJsonBody(req, config.maxBodyBytes);
    const document = await readDocument(config, docId);
    requireDocumentPrecondition(req, document, input);
    const updated = await updateDocument(config, document, input, access, { assignTaskIds: true });
    sendJson(res, 200, documentResponse(updated, access, config));
    return;
  }

  throw new HttpError(405, "Method not allowed");
}

async function siteDocumentResponses(
  config: CloudServerConfig,
  site: CloudSiteRecord,
  access: AccessContext,
): Promise<Array<Record<string, unknown> & SourceInspection>> {
  const visible = site.documentIds
    .filter((id) => !config.store.isTrashed("document", id))
    .map((id) => ({ id, access: capAccessForDocument(config, id, access) }))
    .filter((entry): entry is { id: string; access: AccessContext } => entry.access !== undefined);
  return Promise.all(visible.map(async (entry) => documentResponse(await readDocument(config, entry.id), entry.access, config)));
}

async function routeSiteWiki(
  req: IncomingMessage,
  res: ServerResponse,
  config: CloudServerConfig,
  principal: Principal,
  site: CloudSiteRecord,
): Promise<void> {
  const method = req.method ?? "GET";
  if (method !== "GET") throw new HttpError(405, "Method not allowed");
  const access = requireRecordAccess(config, site, principal, "viewer");
  const visibleIds = visibleSitePageIds(config, site, access);
  const documents = await Promise.all(site.documentIds.filter((id) => visibleIds.has(id)).map((id) => readDocument(config, id)));
  const pages = documents.map(wikiPageSummary);
  const links = buildWikiLinks(documents);
  const backlinks = new Map<string, WikiLinkSummary[]>();
  for (const link of links) {
    if (!link.resolvedDocumentId) continue;
    const list = backlinks.get(link.resolvedDocumentId) ?? [];
    list.push(link);
    backlinks.set(link.resolvedDocumentId, list);
  }
  sendJson(res, 200, {
    site: {
      id: site.id,
      title: site.title,
      slug: site.slug,
      updatedAt: site.updatedAt,
      access: accessResponse(access),
    },
    pages,
    links,
    backlinks: Object.fromEntries(backlinks),
    missing: links.filter((link) => link.missing),
  });
}

async function createSite(
  config: CloudServerConfig,
  input: Record<string, unknown>,
  user: CloudUserRecord,
  principal: Principal,
): Promise<CloudSiteRecord> {
  const id = uniqueId(config);
  const title = stringInput(input, "title", "Untitled Noma Site").slice(0, 120);
  const documentIds = documentIdList(input.documentIds);
  const pageFolders = pageFolderMap(input.pageFolders, documentIds);
  await requireDocumentEditAccess(config, documentIds, principal);
  const now = config.now().toISOString();
  const settings = spaceSettingsInput(config, input, documentIds, undefined);
  const record: CloudSiteRecord = {
    version: 1,
    id,
    title,
    slug: cloudSlug(title, id),
    key: settings.key ?? deriveSpaceKey(config, title),
    documentIds,
    folders: normalizeSiteFolders(folderList(input.folders), pageFolders),
    pageFolders,
    pageParents: pageParentMap(input.pageParents, documentIds),
    createdAt: now,
    updatedAt: now,
    createdBy: user.id,
    updatedBy: user.id,
    permissions: {
      [user.id]: { role: "owner", addedAt: now },
    },
    shareLinks: [],
  };
  const created = applySpaceSettings(record, settings);
  await writeSiteWithKey(config, created);
  recordActivity(config, user, "site.created", "site", created.id, { title: created.title, key: created.key });
  return created;
}

async function updateSite(
  config: CloudServerConfig,
  existing: CloudSiteRecord,
  input: Record<string, unknown>,
  access: AccessContext,
  principal: Principal,
): Promise<CloudSiteRecord> {
  const title = optionalString(input.title)?.slice(0, 120) ?? existing.title;
  const hiddenIds = existing.documentIds.filter((id) => !visibleSitePageIds(config, existing, access).has(id));
  const requestedIds = input.documentIds === undefined ? existing.documentIds : documentIdList(input.documentIds);
  const documentIds = [...requestedIds.filter((id) => !hiddenIds.includes(id)), ...hiddenIds];
  const folders = input.folders === undefined ? existing.folders ?? [] : folderList(input.folders);
  const pageFolders = {
    ...(input.pageFolders === undefined ? existing.pageFolders ?? {} : pageFolderMap(input.pageFolders, documentIds)),
    ...hiddenEntries(existing.pageFolders, hiddenIds),
  };
  const requestedParents = input.pageParents === undefined ? existing.pageParents : input.pageParents;
  const pageParents = requestedParents && typeof requestedParents === "object" && !Array.isArray(requestedParents)
    ? {
        ...Object.fromEntries(
          Object.entries(requestedParents as Record<string, unknown>).filter(
            ([child, parent]) =>
              !hiddenIds.includes(child) && (typeof parent !== "string" || !hiddenIds.includes(parent) || existing.pageParents?.[child] === parent),
          ),
        ),
        ...hiddenEntries(existing.pageParents, hiddenIds),
      }
    : requestedParents;
  const addedDocumentIds = documentIds.filter((id) => !existing.documentIds.includes(id));
  await requireDocumentEditAccess(config, addedDocumentIds, principal);
  const normalizedFolders = normalizeSiteFolders(folders, pageFolders);
  const settings = spaceSettingsInput(config, input, documentIds, existing.id);
  if (settings.key !== undefined && settings.key !== existing.key) requireAccessRole(access, "owner");
  if (settings.styleTokens !== undefined) requireAccessRole(access, "owner");
  if (settings.kitDocumentId !== undefined && settings.kitDocumentId !== (existing.kitDocumentId ?? "")) requireAccessRole(access, "owner");
  const updated: CloudSiteRecord = {
    ...existing,
    title,
    slug: optionalString(input.slug)?.slice(0, 80) ?? cloudSlug(title, existing.slug),
    documentIds,
    folders: normalizedFolders,
    pageFolders: pageFolderMap(pageFolders, documentIds),
    pageParents: pageParentMap(pageParents, documentIds),
    updatedAt: config.now().toISOString(),
    updatedBy: access.user?.id ?? `share:${access.share?.id ?? "unknown"}`,
  };
  const record = applySpaceSettings(updated, settings);
  await writeSiteWithKey(config, record);
  if (access.user) recordActivity(config, access.user, "site.updated", "site", record.id, { title: record.title });
  return record;
}

/**
 * Adding a page to a space grants the space's members inherited access to it,
 * so only the page's owner may do that — an editor could otherwise create a
 * space they own and inherit ownership of someone else's page.
 */
async function requireDocumentEditAccess(config: CloudServerConfig, ids: string[], principal: Principal): Promise<void> {
  for (const id of ids) {
    requireRecordAccess(config, await readDocument(config, id), principal, "owner");
  }
}

async function listSites(config: CloudServerConfig, user: CloudUserRecord, archived: "exclude" | "include" | "only"): Promise<Array<Record<string, unknown>>> {
  const sites = config.store.listSites(user).filter((record) => (archived === "include" ? true : archived === "only" ? Boolean(record.archivedAt) : !record.archivedAt));
  return sites.map((record) => {
    const visible = visibleSitePageIds(config, record, { role: record.currentRole ?? "viewer", via: "user", user });
    return {
    version: record.version,
    id: record.id,
    title: record.title,
    slug: record.slug,
    documentIds: record.documentIds.filter((id) => visible.has(id)),
    folders: record.folders,
    pageFolders: onlyKeys(record.pageFolders ?? {}, visible),
    pageParents: onlyKeys(record.pageParents ?? {}, visible),
    ...spaceFields(config, record, visible),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    createdBy: record.createdBy,
    updatedBy: record.updatedBy,
    currentRole: record.currentRole,
    };
  });
}

/**
 * Pages of a space the caller may see: page restrictions (own or inherited) hide the rest from
 * every space listing, tree, wiki, and published view.
 */
export function visibleSitePageIds(config: CloudServerConfig, site: CloudSiteRecord, access: AccessContext): Set<string> {
  return new Set(site.documentIds.filter((id) => capAccessForDocument(config, id, access) !== undefined));
}

function onlyKeys<T>(record: Record<string, T>, keep: Set<string>): Record<string, T> {
  return Object.fromEntries(Object.entries(record).filter(([key]) => keep.has(key)));
}

function hiddenEntries(record: Record<string, string> | undefined, hiddenIds: string[]): Record<string, string> {
  return Object.fromEntries(Object.entries(record ?? {}).filter(([key]) => hiddenIds.includes(key)));
}

function siteResponse(config: CloudServerConfig, record: CloudSiteRecord, access: AccessContext): Record<string, unknown> {
  const visible = visibleSitePageIds(config, record, access);
  const documentIds = record.documentIds.filter((id) => visible.has(id));
  const pageFolders = pageFolderMap(onlyKeys(record.pageFolders ?? {}, visible), documentIds);
  return {
    version: record.version,
    id: record.id,
    title: record.title,
    slug: record.slug,
    documentIds,
    folders: normalizeSiteFolders(record.folders ?? [], pageFolders),
    pageFolders,
    pageParents: pageParentMap(onlyKeys(record.pageParents ?? {}, visible), documentIds),
    ...spaceFields(config, record, visible),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    createdBy: record.createdBy,
    updatedBy: record.updatedBy,
    access: accessResponse(access),
  };
}

function spaceFields(config: CloudServerConfig, record: CloudSiteRecord, visible: Set<string>): Record<string, unknown> {
  const home = record.homeDocumentId && visible.has(record.homeDocumentId) && !config.store.isTrashed("document", record.homeDocumentId) ? record.homeDocumentId : undefined;
  return {
    key: record.key ?? null,
    description: record.description ?? "",
    icon: record.icon ?? "",
    styleTokens: record.styleTokens ?? {},
    kitDocumentId: record.kitDocumentId && visible.has(record.kitDocumentId) ? record.kitDocumentId : null,
    homeDocumentId: home ?? null,
    archived: Boolean(record.archivedAt),
    archivedAt: record.archivedAt ?? null,
    archivedBy: record.archivedBy ?? null,
  };
}

function wikiPageSummary(record: CloudDocumentRecord): WikiPageSummary {
  return {
    id: record.id,
    title: record.title,
    slug: cloudSlug(record.title, record.id),
    updatedAt: record.updatedAt,
  };
}

function buildWikiLinks(documents: CloudDocumentRecord[]): WikiLinkSummary[] {
  const pagesByKey = new Map<string, CloudDocumentRecord>();
  const blocksByKey = new Map<string, CloudDocumentRecord>();
  for (const document of documents) {
    for (const key of wikiPageKeys(document)) {
      if (!pagesByKey.has(key)) pagesByKey.set(key, document);
    }
    const doc = parse(document.source, { filename: `${document.id}.noma` });
    for (const node of walk(doc)) {
      for (const key of [node.id, ...(node.aliases ?? [])]) {
        if (key && !blocksByKey.has(wikiKey(key))) blocksByKey.set(wikiKey(key), document);
      }
    }
  }

  return documents.flatMap((document) =>
    extractWikilinks(stripFencedCode(document.source)).map((link) => {
      const baseTarget = link.target.split("#", 1)[0]?.trim() || link.target.trim();
      const resolved = pagesByKey.get(wikiKey(baseTarget)) ?? blocksByKey.get(wikiKey(baseTarget));
      return {
        fromDocumentId: document.id,
        fromTitle: document.title,
        target: link.target,
        label: link.label,
        ...(resolved ? { resolvedDocumentId: resolved.id, resolvedTitle: resolved.title } : {}),
        missing: !resolved,
      };
    }),
  );
}

function wikiPageKeys(record: CloudDocumentRecord): string[] {
  return [
    record.id,
    record.title,
    cloudSlug(record.title, record.id),
    sourceTitleForWiki(record.source),
    cloudSlug(sourceTitleForWiki(record.source), record.id),
  ].map(wikiKey);
}

function wikiKey(value: string): string {
  return value.trim().toLowerCase().replace(/\.noma$/i, "").replace(/\s+/g, " ");
}

function sourceTitleForWiki(source: string): string {
  return source.match(/^#\s+(.+)$/m)?.[1]?.replace(/\s+\{[^}]*\}\s*$/, "").trim() || "Untitled Page";
}

function stripFencedCode(source: string): string {
  return source.replace(/^```[\s\S]*?^```/gm, "");
}

function folderList(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new HttpError(400, "folders must be an array");
  return uniqueFolderNames(value.map(optionalFolderName).filter((folder): folder is string => Boolean(folder)));
}

function pageFolderMap(value: unknown, documentIds: string[]): Record<string, string> {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new HttpError(400, "pageFolders must be an object");
  const allowedDocumentIds = new Set(documentIds);
  const next: Record<string, string> = {};
  for (const [documentId, rawFolder] of Object.entries(value as Record<string, unknown>)) {
    assertCloudId(documentId, "Document");
    if (!allowedDocumentIds.has(documentId)) continue;
    const folder = optionalFolderName(rawFolder);
    if (folder) next[documentId] = folder;
  }
  return next;
}

function normalizeSiteFolders(folders: string[], pageFolders: Record<string, string>): string[] {
  return uniqueFolderNames([...folders, ...Object.values(pageFolders)]);
}

function uniqueFolderNames(folders: string[]): string[] {
  const seen = new Set<string>();
  const next: string[] = [];
  for (const folder of folders) {
    const key = folder.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    next.push(folder);
  }
  return next.slice(0, 80);
}

function optionalFolderName(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const folder = value
    .replace(/\\/g, "/")
    .split("/")
    .map((part) => part.trim().replace(/\s+/g, " "))
    .filter(Boolean)
    .join("/")
    .slice(0, 80);
  return folder || undefined;
}

interface CloudPageTreeNode {
  id: string;
  title: string;
  updatedAt: string;
  /** Plain text of the page's `::excerpt`, when it has one. */
  summary?: string;
  folder?: string;
  restrictions?: { view: boolean; edit: boolean; inheritedView: boolean };
  children: CloudPageTreeNode[];
}

interface CloudBreadcrumb {
  type: "site" | "document";
  id: string;
  title: string;
}

/**
 * Validates a child → parent page map against the site's pages. Unknown IDs are
 * dropped (pages leave spaces), self-parents and cycles are rejected.
 */
export function pageParentMap(value: unknown, documentIds: string[]): Record<string, string> {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value)) throw new HttpError(400, "pageParents must be an object");
  const allowed = new Set(documentIds);
  const next: Record<string, string> = {};
  for (const [child, parent] of Object.entries(value as Record<string, unknown>)) {
    assertCloudId(child, "Document");
    if (typeof parent !== "string") throw new HttpError(400, "pageParents values must be document IDs");
    assertCloudId(parent, "Parent document");
    if (child === parent) throw new HttpError(400, "A page cannot be its own parent");
    if (allowed.has(child) && allowed.has(parent)) next[child] = parent;
  }
  for (const start of Object.keys(next)) {
    const seen = new Set<string>([start]);
    let cursor = next[start];
    while (cursor) {
      if (seen.has(cursor)) throw new HttpError(400, "pageParents must not contain cycles");
      seen.add(cursor);
      cursor = next[cursor];
    }
  }
  return next;
}

/** Nearest ancestor that is still visible; trashed parents hand their children up. */
export function effectivePageParent(config: CloudServerConfig, parents: Record<string, string>, documentId: string): string | undefined {
  let parent = parents[documentId];
  const seen = new Set<string>();
  while (parent && config.store.isTrashed("document", parent) && !seen.has(parent)) {
    seen.add(parent);
    parent = parents[parent];
  }
  return parent;
}

function sitePageTree(config: CloudServerConfig, site: CloudSiteRecord, access: AccessContext): CloudPageTreeNode[] {
  const parents = pageParentMap(site.pageParents, site.documentIds);
  const folders = site.pageFolders ?? {};
  const visible = visibleSitePageIds(config, site, access);
  const flags = config.store.pageRestrictionFlags([...visible]);
  const nodes = new Map<string, CloudPageTreeNode>();
  for (const id of site.documentIds) {
    if (!visible.has(id) || config.store.isTrashed("document", id)) continue;
    const document = config.store.readDocument(id);
    if (!document) continue;
    const restrictions = flags.get(id);
    const summary = documentSummary(document);
    nodes.set(id, {
      id,
      title: document.title,
      updatedAt: document.updatedAt,
      ...(summary ? { summary } : {}),
      ...(folders[id] ? { folder: folders[id] } : {}),
      ...(restrictions ? { restrictions } : {}),
      children: [],
    });
  }
  const roots: CloudPageTreeNode[] = [];
  for (const [id, node] of nodes) {
    const parent = effectivePageParent(config, parents, id);
    const parentNode = parent ? nodes.get(parent) : undefined;
    if (parentNode) parentNode.children.push(node);
    else roots.push(node);
  }
  return roots;
}

function pageBreadcrumbs(config: CloudServerConfig, site: CloudSiteRecord, documentId: string, access: AccessContext): CloudBreadcrumb[] {
  const parents = pageParentMap(site.pageParents, site.documentIds);
  const chain: CloudBreadcrumb[] = [];
  let cursor: string | undefined = documentId;
  while (cursor) {
    const document = capAccessForDocument(config, cursor, access) ? config.store.readDocument(cursor) : undefined;
    if (document) chain.unshift({ type: "document", id: document.id, title: document.title });
    cursor = effectivePageParent(config, parents, cursor);
  }
  return [{ type: "site", id: site.id, title: site.title }, ...chain];
}

function pageDescendants(parents: Record<string, string>, documentId: string): Set<string> {
  const descendants = new Set<string>();
  let grew = true;
  while (grew) {
    grew = false;
    for (const [child, parent] of Object.entries(parents)) {
      if ((parent === documentId || descendants.has(parent)) && !descendants.has(child)) {
        descendants.add(child);
        grew = true;
      }
    }
  }
  return descendants;
}

/** Moves `documentId` to sit directly after its parent's existing subtree in page order. */
function placeAfterSubtree(documentIds: string[], parents: Record<string, string>, documentId: string, parentId: string): string[] {
  const rest = documentIds.filter((id) => id !== documentId);
  const subtree = pageDescendants(parents, parentId);
  subtree.delete(documentId);
  let insertAt = rest.indexOf(parentId) + 1;
  for (let index = 0; index < rest.length; index++) {
    if (subtree.has(rest[index]!)) insertAt = Math.max(insertAt, index + 1);
  }
  return [...rest.slice(0, insertAt), documentId, ...rest.slice(insertAt)];
}

async function movePage(
  config: CloudServerConfig,
  site: CloudSiteRecord,
  documentId: string,
  input: Record<string, unknown>,
  access: AccessContext,
): Promise<CloudSiteRecord> {
  const parents = pageParentMap(site.pageParents, site.documentIds);
  const parentId = input.parentId === null ? undefined : optionalCloudId(input.parentId, "Parent document");
  if (parentId !== undefined) {
    if (!site.documentIds.includes(parentId) || !capAccessForDocument(config, parentId, access)) {
      throw new HttpError(400, "parentId must be a page in this site");
    }
    if (parentId === documentId || pageDescendants(parents, documentId).has(parentId)) {
      throw new HttpError(400, "A page cannot be moved under itself or its descendants");
    }
    parents[documentId] = parentId;
  } else {
    delete parents[documentId];
  }
  let documentIds = parentId ? placeAfterSubtree(site.documentIds, parents, documentId, parentId) : site.documentIds;
  if (input.position !== undefined) {
    if (typeof input.position !== "number" || !Number.isInteger(input.position) || input.position < 0) {
      throw new HttpError(400, "position must be a non-negative integer");
    }
    const rest = documentIds.filter((id) => id !== documentId);
    const siblings = rest.filter((id) => parents[id] === parents[documentId] && !config.store.isTrashed("document", id));
    const before = siblings[input.position];
    const last = siblings.at(-1);
    if (before !== undefined) {
      const insertAt = rest.indexOf(before);
      documentIds = [...rest.slice(0, insertAt), documentId, ...rest.slice(insertAt)];
    } else if (last !== undefined) {
      const lastSubtree = new Set([last, ...pageDescendants(parents, last)]);
      let insertAt = rest.indexOf(last) + 1;
      for (let index = 0; index < rest.length; index++) {
        if (lastSubtree.has(rest[index]!)) insertAt = Math.max(insertAt, index + 1);
      }
      documentIds = [...rest.slice(0, insertAt), documentId, ...rest.slice(insertAt)];
    }
  }
  const record: CloudSiteRecord = {
    ...site,
    documentIds,
    pageParents: parents,
    updatedAt: config.now().toISOString(),
    updatedBy: access.user?.id ?? `share:${access.share?.id ?? "unknown"}`,
  };
  await writeSite(config, record);
  if (access.user) recordActivity(config, access.user, "document.moved", "site", site.id, { documentId, parentId: parentId ?? null });
  return record;
}

/** Adds an existing page to a space, optionally under `parentId`, keeping folders and the page tree consistent. */
export async function attachPageToSite(
  config: CloudServerConfig,
  site: CloudSiteRecord,
  documentId: string,
  parentId: string | undefined,
  access: AccessContext,
): Promise<CloudSiteRecord> {
  const documentIds = site.documentIds.includes(documentId) ? site.documentIds : [...site.documentIds, documentId];
  const parent = parentId && site.documentIds.includes(parentId) && !config.store.isTrashed("document", parentId) ? parentId : undefined;
  const pageParents = { ...pageParentMap(site.pageParents, documentIds), ...(parent ? { [documentId]: parent } : {}) };
  const pageFolders = pageFolderMap(site.pageFolders, documentIds);
  const next: CloudSiteRecord = {
    ...site,
    documentIds: parent ? placeAfterSubtree(documentIds, pageParents, documentId, parent) : documentIds,
    folders: normalizeSiteFolders(site.folders ?? [], pageFolders),
    pageFolders,
    pageParents,
    updatedAt: config.now().toISOString(),
    updatedBy: access.user?.id ?? site.updatedBy,
  };
  await writeSite(config, next);
  return next;
}
