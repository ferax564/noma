/**
 * `/api/import/confluence` (start a background import into a space) and
 * `/api/import/jobs/:id` (poll it). Pages become `.noma` documents owned by
 * the importer; hierarchy, labels, and Confluence provenance (frontmatter) are
 * kept, and re-importing updates pages by Confluence page ID.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { CloudDocumentRecord, CloudImportJob, CloudImportProgress, CloudImportSource, CloudImportSourceKind, CloudSiteRecord, CloudUserRecord } from "../cloud-db.js";
import {
  type ConfluencePage,
  type ConfluenceSpace,
  assertImportTarget,
  ConfluenceImportError,
  fetchConfluenceSpace,
  type LiveConfluenceOptions,
  parseConfluenceArchive,
  parseConfluenceBundle,
} from "../confluence-import.js";
import { convertConfluencePage } from "../confluence-storage.js";
import { parse } from "../parser.js";
import {
  type CloudServerConfig,
  type Principal,
  randomId,
  readSite,
  recordActivity,
  requireNotTrashed,
  requireRecordAccess,
  requireUser,
  uniqueId,
  writeDocument,
  writeSite,
} from "./context.js";
import { headerValue, HttpError, readJsonBody, sendJson, sha256Hex } from "./http.js";
import { ImportAttachmentLedger, preparePageAttachments } from "./import-attachments.js";
import { assertCloudId, optionalCloudId, optionalString } from "./input.js";

const SOURCE_SYSTEM = "confluence";
const DEFAULT_IMPORT_MAX_BYTES = 50_000_000;

type SpaceLoader = (onProgress: (fetched: number) => void) => Promise<ConfluenceSpace>;

export async function routeImport(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  parts: string[],
  config: CloudServerConfig,
  principal: Principal,
): Promise<void> {
  const method = req.method ?? "GET";
  const user = requireUser(principal);

  if (parts[2] === "confluence" && !parts[3]) {
    if (method !== "POST") throw new HttpError(405, "Method not allowed");
    const started = await startConfluenceImport(req, url, config, principal, user);
    sendJson(res, 202, { job: started, statusUrl: `/api/import/jobs/${started.id}` });
    return;
  }

  if (parts[2] === "jobs" && parts[3] && !parts[4]) {
    if (method !== "GET") throw new HttpError(405, "Method not allowed");
    assertCloudId(parts[3], "Import job");
    const job = config.store.readImportJob(parts[3]);
    if (!job) throw new HttpError(404, "Import job not found");
    if (job.createdBy !== user.id) {
      const site = await readSite(config, job.siteId);
      requireRecordAccess(config, site, principal, "editor");
    }
    sendJson(res, 200, { job });
    return;
  }

  throw new HttpError(404, "Unknown import route");
}

async function startConfluenceImport(
  req: IncomingMessage,
  url: URL,
  config: CloudServerConfig,
  principal: Principal,
  user: CloudUserRecord,
): Promise<CloudImportJob> {
  const maxBytes = config.importMaxBytes ?? DEFAULT_IMPORT_MAX_BYTES;
  const contentType = (headerValue(req, "content-type") ?? "").split(";")[0]!.trim().toLowerCase();
  let siteId: string | undefined;
  let overwrite = false;
  let kind: CloudImportSourceKind;
  let loader: SpaceLoader;
  let spaceKey: string | undefined;

  if (contentType === "application/json" || contentType === "") {
    const input = await readJsonBody(req, maxBytes);
    siteId = optionalCloudId(input.siteId, "Site");
    overwrite = input.overwrite === true;
    if (input.bundle !== undefined) {
      const space = wrapImportError(() => parseConfluenceBundle(input.bundle));
      kind = "confluence-bundle";
      spaceKey = space.spaceKey;
      loader = async () => space;
    } else if (typeof input.archiveBase64 === "string" || typeof input.entitiesXml === "string") {
      const data = typeof input.entitiesXml === "string" ? Buffer.from(input.entitiesXml, "utf8") : base64Input(input.archiveBase64 as string, maxBytes);
      kind = "confluence-export";
      loader = async () => parseConfluenceArchive(data);
    } else {
      const live = liveOptions(input, config);
      try {
        live.baseUrl = await assertImportTarget(live.baseUrl, live.allowPrivateHosts === true);
      } catch (error) {
        if (error instanceof ConfluenceImportError) throw new HttpError(400, error.message, { code: "import_target_rejected" });
        throw error;
      }
      kind = live.deployment === "cloud" ? "confluence-cloud" : "confluence-datacenter";
      spaceKey = live.spaceKey;
      loader = (onProgress) => fetchConfluenceSpace(live, onProgress);
    }
  } else if (["application/zip", "application/x-zip-compressed", "application/octet-stream", "application/xml", "text/xml"].includes(contentType)) {
    siteId = optionalCloudId(url.searchParams.get("site"), "Site");
    overwrite = /^(1|true|yes)$/i.test(url.searchParams.get("overwrite") ?? "");
    const data = await readRawBody(req, maxBytes);
    kind = "confluence-export";
    loader = async () => parseConfluenceArchive(data);
  } else {
    throw new HttpError(415, "Send JSON, a Confluence XML export ZIP (application/zip), or entities.xml (application/xml)");
  }

  if (!siteId) throw new HttpError(400, "siteId is required");
  const site = await readSite(config, siteId);
  requireNotTrashed(config, "site", siteId);
  requireRecordAccess(config, site, principal, "editor");
  if (config.store.countActiveImportJobs(siteId) > 0) throw new HttpError(409, "An import into this space is already running", { code: "import_running" });

  const now = config.now().toISOString();
  const job: CloudImportJob = {
    id: randomId(),
    siteId,
    createdBy: user.id,
    source: kind,
    status: "queued",
    ...(spaceKey ? { spaceKey } : {}),
    progress: emptyProgress(),
    createdAt: now,
    updatedAt: now,
  };
  config.store.createImportJob(job);
  recordActivity(config, user, "import.started", "site", siteId, { jobId: job.id, source: kind, spaceKey });
  setImmediate(() => {
    runImportJob(config, job, user, loader, overwrite).catch(() => undefined);
  });
  return job;
}

async function runImportJob(config: CloudServerConfig, job: CloudImportJob, user: CloudUserRecord, loader: SpaceLoader, overwrite: boolean): Promise<void> {
  const progress = emptyProgress();
  const touch = (patch: Parameters<typeof config.store.updateImportJob>[1]): void => config.store.updateImportJob(job.id, patch, config.now().toISOString());
  try {
    touch({ status: "running" });
    const space = await loader((fetched) => touch({ progress: { ...progress, total: fetched } }));
    progress.total = space.pages.length;
    touch({ spaceKey: space.spaceKey, progress });
    const result = await importSpace(config, job.siteId, user, space, overwrite, progress, () => touch({ progress }));
    touch({ status: "succeeded", progress, result, finishedAt: config.now().toISOString() });
    recordActivity(config, user, "import.completed", "site", job.siteId, { jobId: job.id, created: progress.created, updated: progress.updated });
  } catch (error) {
    const message = error instanceof ConfluenceImportError || error instanceof HttpError ? error.message : `Import failed: ${error instanceof Error ? error.message : String(error)}`;
    touch({ status: "failed", progress, error: message.slice(0, 2_000), finishedAt: config.now().toISOString() });
  }
}

interface ImportedPage {
  pageId: string;
  title: string;
  documentId?: string;
  action: "created" | "updated" | "unchanged" | "skipped" | "failed";
  reason?: string;
}

async function importSpace(
  config: CloudServerConfig,
  siteId: string,
  user: CloudUserRecord,
  space: ConfluenceSpace,
  overwrite: boolean,
  progress: CloudImportProgress,
  report: () => void,
): Promise<Record<string, unknown>> {
  const initialSite = await readSite(config, siteId);
  const pageIds = new Set(space.pages.map((page) => page.id));
  const ordered = orderPages(space.pages);
  const documentByPage = new Map<string, string>();
  const outcomes: ImportedPage[] = [];
  const loss = new Map<string, number>();
  const ledger = new ImportAttachmentLedger(config, siteId, config.maxAttachmentBytes, config.importMaxBytes ?? DEFAULT_IMPORT_MAX_BYTES);
  let attachments = 0;

  for (const page of ordered) {
    await new Promise<void>((resolveTick) => setImmediate(resolveTick));
    try {
      const outcome = await importPage(config, initialSite, user, space, page, overwrite, loss, ledger);
      attachments += outcome.attachments;
      outcomes.push(outcome.page);
      const documentId = outcome.page.documentId;
      if (documentId && !config.store.isTrashed("document", documentId)) documentByPage.set(page.id, documentId);
      if (outcome.page.action === "created") progress.created += 1;
      else if (outcome.page.action === "updated") progress.updated += 1;
      else if (outcome.page.action === "unchanged") progress.unchanged += 1;
      else progress.skipped += 1;
    } catch (error) {
      progress.failed += 1;
      outcomes.push({ pageId: page.id, title: page.title, action: "failed", reason: error instanceof Error ? error.message.slice(0, 300) : String(error) });
    }
    progress.processed += 1;
    progress.attachmentsCopied = ledger.copied;
    progress.attachmentsSkipped = ledger.skipped;
    report();
  }

  const site = await readSite(config, siteId);
  requireNotTrashed(config, "site", siteId);
  const documentIds = [...site.documentIds];
  const pageParents = { ...(site.pageParents ?? {}) };
  for (const page of ordered) {
    const documentId = documentByPage.get(page.id);
    if (!documentId) continue;
    if (!documentIds.includes(documentId)) documentIds.push(documentId);
    const parentDocument = page.parentId && pageIds.has(page.parentId) ? documentByPage.get(page.parentId) : undefined;
    if (parentDocument && parentDocument !== documentId) pageParents[documentId] = parentDocument;
  }
  const nextSite: CloudSiteRecord = {
    ...site,
    documentIds,
    pageParents: acyclicParents(pageParents, documentIds),
    updatedAt: config.now().toISOString(),
    updatedBy: user.id,
  };
  await writeSite(config, nextSite);

  return {
    spaceKey: space.spaceKey,
    ...(space.spaceName ? { spaceName: space.spaceName } : {}),
    pages: outcomes.slice(0, 2_000),
    loss: [...loss].map(([macro, count]) => ({ macro, count })).sort((a, b) => b.count - a.count),
    attachments: {
      referenced: attachments,
      ...ledger.summary(),
      ...(space.attachmentsUnavailable ? { note: space.attachmentsUnavailable } : {}),
    },
  };
}

async function importPage(
  config: CloudServerConfig,
  site: CloudSiteRecord,
  user: CloudUserRecord,
  space: ConfluenceSpace,
  page: ConfluencePage,
  overwrite: boolean,
  loss: Map<string, number>,
  ledger: ImportAttachmentLedger,
): Promise<{ page: ImportedPage; attachments: number }> {
  const sourceId = `${space.spaceKey}:${page.id}`;
  const mapping = config.store.readImportSource(site.id, SOURCE_SYSTEM, sourceId);
  // A mapped page that has left this space is not updated or re-added: re-adding would hand the space's members access to it.
  const existing = mapping && site.documentIds.includes(mapping.documentId) ? config.store.readDocument(mapping.documentId) : undefined;
  const prepared = existing && config.store.isTrashed("document", existing.id)
    ? undefined
    : await preparePageAttachments(ledger, space.attachmentSource, space.attachmentsUnavailable, page, existing ? config.store.listAttachments(existing.id) : []);
  try {
    const result = await importConvertedPage(config, site, user, space, page, overwrite, loss, mapping, existing, prepared?.refs);
    const documentId = result.page.documentId;
    if (prepared && documentId && ["created", "updated", "unchanged"].includes(result.page.action)) await prepared.commit(documentId, user.id);
    else await prepared?.discard();
    for (const filename of new Set(result.unresolved)) {
      if (prepared && !prepared.reasons.has(filename)) ledger.skip(page.id, filename, prepared.sourceReason ?? "Not found among the page's attachments in the source");
    }
    return { page: result.page, attachments: result.attachments };
  } catch (error) {
    await prepared?.discard();
    throw error;
  }
}

async function importConvertedPage(
  config: CloudServerConfig,
  site: CloudSiteRecord,
  user: CloudUserRecord,
  space: ConfluenceSpace,
  page: ConfluencePage,
  overwrite: boolean,
  loss: Map<string, number>,
  mapping: CloudImportSource | undefined,
  existing: CloudDocumentRecord | undefined,
  attachmentRefs: Map<string, string> | undefined,
): Promise<{ page: ImportedPage; attachments: number; unresolved: string[] }> {
  const conversion = convertConfluencePage(page.storage, {
    title: page.title,
    pageId: page.id,
    spaceKey: space.spaceKey,
    ...(space.baseUrl ? { baseUrl: space.baseUrl } : {}),
    ...(page.url ? { url: page.url } : {}),
    ...(page.author ? { author: page.author } : {}),
    ...(page.createdAt ? { createdAt: page.createdAt } : {}),
    ...(page.updatedAt ? { updatedAt: page.updatedAt } : {}),
    ...(page.version ? { version: page.version } : {}),
    labels: page.labels,
    ...(attachmentRefs ? { attachmentRef: (filename: string) => attachmentRefs.get(filename) } : {}),
  });
  for (const entry of conversion.loss) loss.set(entry.macro, (loss.get(entry.macro) ?? 0) + entry.count);
  parse(conversion.source, { filename: `${page.id}.noma` });
  const sourceHash = sha256Hex(conversion.source);
  const sourceId = `${space.spaceKey}:${page.id}`;
  const title = page.title.slice(0, 120) || "Untitled Page";
  const now = config.now().toISOString();
  const attachments = conversion.attachments.length;
  const unresolved = conversion.attachments.filter((ref) => !ref.copied).map((ref) => ref.filename);
  const outcome = (action: ImportedPage["action"], documentId?: string, reason?: string): { page: ImportedPage; attachments: number; unresolved: string[] } => ({
    page: { pageId: page.id, title, ...(documentId ? { documentId } : {}), action, ...(reason ? { reason } : {}) },
    attachments,
    unresolved,
  });

  if (existing) {
    if (config.store.isTrashed("document", existing.id)) return outcome("skipped", existing.id, "The Noma page is in the trash");
    if (mapping!.importedHash === sourceHash) {
      mergeLabels(config, existing.id, page.labels, user, now);
      return outcome("unchanged", existing.id, existing.hash === sourceHash ? undefined : "Unchanged in Confluence; local Noma edits kept");
    }
    if (existing.hash !== mapping!.importedHash && !overwrite) {
      return outcome("skipped", existing.id, "The Noma page was edited after the last import; re-run with overwrite to replace it");
    }
    const record: CloudDocumentRecord = { ...existing, title, source: conversion.source, hash: sourceHash, updatedAt: now, updatedBy: user.id };
    await writeDocument(config, record, existing.hash);
    mergeLabels(config, existing.id, page.labels, user, now);
    config.store.writeImportSource({ siteId: site.id, sourceSystem: SOURCE_SYSTEM, sourceId, documentId: existing.id, ...(page.version ? { sourceVersion: page.version } : {}), importedHash: sourceHash, importedAt: now });
    recordActivity(config, user, "document.updated", "document", existing.id, { hash: sourceHash, importedFrom: "confluence", confluencePageId: page.id });
    return outcome("updated", existing.id);
  }

  const record: CloudDocumentRecord = {
    version: 2,
    id: uniqueId(config),
    title,
    source: conversion.source,
    hash: sourceHash,
    createdAt: now,
    updatedAt: now,
    createdBy: user.id,
    updatedBy: user.id,
    permissions: { [user.id]: { role: "owner", addedAt: now } },
    shareLinks: [],
  };
  await writeDocument(config, record);
  config.store.setWatch(user.id, "document", record.id, now);
  mergeLabels(config, record.id, page.labels, user, now);
  config.store.writeImportSource({ siteId: site.id, sourceSystem: SOURCE_SYSTEM, sourceId, documentId: record.id, ...(page.version ? { sourceVersion: page.version } : {}), importedHash: sourceHash, importedAt: now });
  recordActivity(config, user, "document.created", "document", record.id, { title, importedFrom: "confluence", confluencePageId: page.id });
  return outcome("created", record.id);
}

function mergeLabels(config: CloudServerConfig, documentId: string, labels: string[], user: CloudUserRecord, now: string): void {
  if (labels.length === 0) return;
  const current = config.store.listDocumentLabels(documentId);
  const next = [...new Set([...current, ...labels])].sort().slice(0, 50);
  if (next.length !== current.length || next.some((label, index) => label !== current[index])) config.store.replaceDocumentLabels(documentId, next, user.id, now);
}

/** Parents before children; siblings by Confluence position, then title. Pages whose parent is absent are roots. */
function orderPages(pages: ConfluencePage[]): ConfluencePage[] {
  const ids = new Set(pages.map((page) => page.id));
  const children = new Map<string | undefined, ConfluencePage[]>();
  for (const page of pages) {
    const parent = page.parentId && ids.has(page.parentId) && page.parentId !== page.id ? page.parentId : undefined;
    children.set(parent, [...(children.get(parent) ?? []), page]);
  }
  const sortKey = (a: ConfluencePage, b: ConfluencePage): number => (a.position ?? Number.MAX_SAFE_INTEGER) - (b.position ?? Number.MAX_SAFE_INTEGER) || a.title.localeCompare(b.title);
  const ordered: ConfluencePage[] = [];
  const seen = new Set<string>();
  const visit = (parent: string | undefined): void => {
    for (const page of (children.get(parent) ?? []).sort(sortKey)) {
      if (seen.has(page.id)) continue;
      seen.add(page.id);
      ordered.push(page);
      visit(page.id);
    }
  };
  visit(undefined);
  for (const page of pages) {
    if (!seen.has(page.id)) {
      seen.add(page.id);
      ordered.push(page);
    }
  }
  return ordered;
}

/** Drops parent links that would form a cycle or point outside the space. */
function acyclicParents(parents: Record<string, string>, documentIds: string[]): Record<string, string> {
  const allowed = new Set(documentIds);
  const next: Record<string, string> = {};
  for (const [child, parent] of Object.entries(parents)) {
    if (!allowed.has(child) || !allowed.has(parent) || child === parent) continue;
    let cursor: string | undefined = parent;
    const seen = new Set<string>([child]);
    let cyclic = false;
    while (cursor) {
      if (seen.has(cursor)) {
        cyclic = true;
        break;
      }
      seen.add(cursor);
      cursor = next[cursor];
    }
    if (!cyclic) next[child] = parent;
  }
  return next;
}

function liveOptions(input: Record<string, unknown>, config: CloudServerConfig): LiveConfluenceOptions {
  const baseUrl = optionalString(input.baseUrl);
  if (!baseUrl) throw new HttpError(400, "Provide baseUrl + credentials, bundle, archiveBase64, or entitiesXml");
  const deployment = input.deployment ?? "cloud";
  if (deployment !== "cloud" && deployment !== "datacenter") throw new HttpError(400, "deployment must be cloud or datacenter");
  const spaceKey = optionalString(input.spaceKey);
  if (!spaceKey) throw new HttpError(400, "spaceKey is required");
  const email = optionalString(input.email);
  const apiToken = optionalString(input.apiToken);
  const pat = optionalString(input.pat) ?? optionalString(input.personalAccessToken);
  const options: LiveConfluenceOptions = {
    baseUrl,
    deployment,
    spaceKey,
    ...(email ? { email } : {}),
    ...(apiToken ? { apiToken } : {}),
    ...(pat ? { personalAccessToken: pat } : {}),
    allowPrivateHosts: config.importAllowPrivateHosts === true,
  };
  if (deployment === "cloud" && (!email || !apiToken)) throw new HttpError(400, "Confluence Cloud imports need email and apiToken");
  if (deployment === "datacenter" && !pat) throw new HttpError(400, "Confluence Data Center imports need pat (a personal access token)");
  return options;
}

function base64Input(value: string, maxBytes: number): Buffer {
  const clean = value.replace(/^data:[^,]*,/, "").replace(/\s+/g, "");
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(clean)) throw new HttpError(400, "archiveBase64 must be base64");
  const data = Buffer.from(clean, "base64");
  if (data.length === 0) throw new HttpError(400, "archiveBase64 is empty");
  if (data.length > maxBytes) throw new HttpError(413, "Import upload is too large");
  return data;
}

async function readRawBody(req: IncomingMessage, maxBytes: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  let tooLarge = false;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buffer.byteLength;
    if (tooLarge || size > maxBytes) {
      tooLarge = true;
      continue;
    }
    chunks.push(buffer);
  }
  if (tooLarge) throw new HttpError(413, "Import upload is too large");
  if (size === 0) throw new HttpError(400, "Import upload is empty");
  return Buffer.concat(chunks);
}

function wrapImportError<T>(run: () => T): T {
  try {
    return run();
  } catch (error) {
    if (error instanceof ConfluenceImportError) throw new HttpError(error.status, error.message);
    throw error;
  }
}

function emptyProgress(): CloudImportProgress {
  return { total: 0, processed: 0, created: 0, updated: 0, unchanged: 0, skipped: 0, failed: 0, attachmentsCopied: 0, attachmentsSkipped: 0 };
}
