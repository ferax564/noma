/** `/api/sites`: sites, site documents, page tree/breadcrumbs/moves, folders, and the site wiki. */
import type { IncomingMessage, ServerResponse } from "node:http";
import { walk } from "../ast.js";
import type { CloudDocumentRecord, CloudSiteRecord, CloudUserRecord } from "../cloud-db.js";
import { extractWikilinks } from "../inline.js";
import { parse } from "../parser.js";
import {
  type AccessContext,
  type CloudServerConfig,
  type Principal,
  readDocument,
  readSite,
  recordActivity,
  requireAccessRole,
  requireNotTrashed,
  requireRecordAccess,
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
import { routeCollaborators, routeGroupCollaborators, routeShares } from "./routes-access.js";
import { routeDocumentAnalytics, routeSitePopular } from "./routes-analytics.js";
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
    sendJson(res, 200, { siteId: site.id, title: site.title, pages: sitePageTree(config, site), access: accessResponse(access) });
    return;
  }

  if (suffix === "watch") {
    routeWatch(req, res, config, principal, site, "site");
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
    const document = await createDocument(config, input, user, site.title, true);
    const now = config.now().toISOString();
    const documentIds = [...site.documentIds, document.id];
    const pageFolders = pageFolderMap(site.pageFolders, documentIds);
    const folder = optionalFolderName(input.folder);
    if (folder) pageFolders[document.id] = folder;
    const parentId = optionalCloudId(input.parentId, "Parent document");
    if (parentId && !site.documentIds.includes(parentId)) throw new HttpError(400, "parentId must be a page in this site");
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
    sendJson(res, 201, documentResponse(document, requireRecordAccess(config, document, principal, "owner")));
    return;
  }

  if (!docId) throw new HttpError(404, "Document ID is required");
  assertCloudId(docId, "Document");
  if (!site.documentIds.includes(docId)) throw new HttpError(404, "Document is not in this site");
  requireNotTrashed(config, "document", docId);

  if (parts[5] === "revisions") {
    const access = requireRecordAccess(config, site, principal, "viewer");
    await routeDocumentRevisions(req, res, parts[6], parts[7], config, await readDocument(config, docId), access);
    return;
  }

  if (parts[5] === "breadcrumbs") {
    if (method !== "GET") throw new HttpError(405, "Method not allowed");
    requireRecordAccess(config, site, principal, "viewer");
    sendJson(res, 200, { breadcrumbs: pageBreadcrumbs(config, site, docId) });
    return;
  }

  if (parts[5] === "parent") {
    if (method !== "PUT") throw new HttpError(405, "Method not allowed");
    const access = requireRecordAccess(config, site, principal, "editor");
    const input = await readJsonBody(req, config.maxBodyBytes);
    const updated = await movePage(config, site, docId, input, access);
    sendJson(res, 200, { site: siteResponse(config, updated, access), pages: sitePageTree(config, updated) });
    return;
  }

  if (parts[5] === "comments") {
    await routeDocumentComments(req, res, parts[6], parts[7], config, principal, await readDocument(config, docId), requireRecordAccess(config, site, principal, "viewer"), parts[8]);
    return;
  }

  if (parts[5] === "views" || parts[5] === "analytics") {
    await routeDocumentAnalytics(req, res, parts[5], config, principal, await readDocument(config, docId), requireRecordAccess(config, site, principal, "viewer"));
    return;
  }

  if (parts[5] === "approvals") {
    await routeDocumentApprovals(req, res, parts[6], config, principal, await readDocument(config, docId), requireRecordAccess(config, site, principal, "viewer"));
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
      requireRecordAccess(config, site, principal, "viewer"),
    );
    return;
  }

  if (method === "GET") {
    const access = requireRecordAccess(config, site, principal, "viewer");
    if (access.user) config.store.recordRecent(access.user.id, "document", docId, config.now().toISOString());
    sendJson(res, 200, documentResponse(await readDocument(config, docId), access));
    return;
  }

  if (method === "PUT" || method === "PATCH") {
    const access = requireRecordAccess(config, site, principal, "editor");
    const input = await readJsonBody(req, config.maxBodyBytes);
    const document = await readDocument(config, docId);
    requireDocumentPrecondition(req, document, input);
    const updated = await updateDocument(config, document, input, access);
    sendJson(res, 200, documentResponse(updated, access));
    return;
  }

  throw new HttpError(405, "Method not allowed");
}

async function siteDocumentResponses(
  config: CloudServerConfig,
  site: CloudSiteRecord,
  access: AccessContext,
): Promise<Array<Record<string, unknown> & SourceInspection>> {
  const visibleIds = site.documentIds.filter((id) => !config.store.isTrashed("document", id));
  return Promise.all(visibleIds.map(async (id) => documentResponse(await readDocument(config, id), access)));
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
  const visibleIds = site.documentIds.filter((id) => !config.store.isTrashed("document", id));
  const documents = await Promise.all(visibleIds.map((id) => readDocument(config, id)));
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
  const documentIds = input.documentIds === undefined ? existing.documentIds : documentIdList(input.documentIds);
  const folders = input.folders === undefined ? existing.folders ?? [] : folderList(input.folders);
  const pageFolders = input.pageFolders === undefined ? existing.pageFolders ?? {} : pageFolderMap(input.pageFolders, documentIds);
  const addedDocumentIds = documentIds.filter((id) => !existing.documentIds.includes(id));
  await requireDocumentEditAccess(config, addedDocumentIds, principal);
  const normalizedFolders = normalizeSiteFolders(folders, pageFolders);
  const settings = spaceSettingsInput(config, input, documentIds, existing.id);
  if (settings.key !== undefined && settings.key !== existing.key) requireAccessRole(access, "owner");
  const updated: CloudSiteRecord = {
    ...existing,
    title,
    slug: optionalString(input.slug)?.slice(0, 80) ?? cloudSlug(title, existing.slug),
    documentIds,
    folders: normalizedFolders,
    pageFolders: pageFolderMap(pageFolders, documentIds),
    pageParents: pageParentMap(input.pageParents === undefined ? existing.pageParents : input.pageParents, documentIds),
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
  return sites.map((record) => ({
    version: record.version,
    id: record.id,
    title: record.title,
    slug: record.slug,
    documentIds: record.documentIds,
    folders: record.folders,
    pageFolders: record.pageFolders,
    pageParents: record.pageParents ?? {},
    ...spaceFields(config, record),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    createdBy: record.createdBy,
    updatedBy: record.updatedBy,
    currentRole: record.currentRole,
  }));
}

function siteResponse(config: CloudServerConfig, record: CloudSiteRecord, access: AccessContext): Record<string, unknown> {
  const pageFolders = pageFolderMap(record.pageFolders, record.documentIds);
  return {
    version: record.version,
    id: record.id,
    title: record.title,
    slug: record.slug,
    documentIds: record.documentIds,
    folders: normalizeSiteFolders(record.folders ?? [], pageFolders),
    pageFolders,
    pageParents: pageParentMap(record.pageParents, record.documentIds),
    ...spaceFields(config, record),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    createdBy: record.createdBy,
    updatedBy: record.updatedBy,
    access: accessResponse(access),
  };
}

function spaceFields(config: CloudServerConfig, record: CloudSiteRecord): Record<string, unknown> {
  const home = record.homeDocumentId && record.documentIds.includes(record.homeDocumentId) && !config.store.isTrashed("document", record.homeDocumentId) ? record.homeDocumentId : undefined;
  return {
    key: record.key ?? null,
    description: record.description ?? "",
    icon: record.icon ?? "",
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
  folder?: string;
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
function pageParentMap(value: unknown, documentIds: string[]): Record<string, string> {
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
function effectivePageParent(config: CloudServerConfig, parents: Record<string, string>, documentId: string): string | undefined {
  let parent = parents[documentId];
  const seen = new Set<string>();
  while (parent && config.store.isTrashed("document", parent) && !seen.has(parent)) {
    seen.add(parent);
    parent = parents[parent];
  }
  return parent;
}

function sitePageTree(config: CloudServerConfig, site: CloudSiteRecord): CloudPageTreeNode[] {
  const parents = pageParentMap(site.pageParents, site.documentIds);
  const folders = site.pageFolders ?? {};
  const nodes = new Map<string, CloudPageTreeNode>();
  for (const id of site.documentIds) {
    if (config.store.isTrashed("document", id)) continue;
    const document = config.store.readDocument(id);
    if (!document) continue;
    nodes.set(id, { id, title: document.title, updatedAt: document.updatedAt, ...(folders[id] ? { folder: folders[id] } : {}), children: [] });
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

function pageBreadcrumbs(config: CloudServerConfig, site: CloudSiteRecord, documentId: string): CloudBreadcrumb[] {
  const parents = pageParentMap(site.pageParents, site.documentIds);
  const chain: CloudBreadcrumb[] = [];
  let cursor: string | undefined = documentId;
  while (cursor) {
    const document = config.store.readDocument(cursor);
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
    if (!site.documentIds.includes(parentId)) throw new HttpError(400, "parentId must be a page in this site");
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
    const insertAt = before === undefined ? documentIds.indexOf(documentId) : rest.indexOf(before);
    documentIds = before === undefined ? documentIds : [...rest.slice(0, insertAt), documentId, ...rest.slice(insertAt)];
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
