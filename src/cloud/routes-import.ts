/**
 * `/api/import/confluence` and `/api/import/notion` (start a background import
 * into a space) and `/api/import/jobs/:id` (poll it). Pages become `.noma`
 * documents owned by the importer; hierarchy, labels, and source provenance
 * (frontmatter) are kept, and re-importing updates pages by source page ID.
 * Notion images and files are stored as page attachments (`att:` references).
 */
import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { BLOB_HEAD_BYTES } from "../cloud-blobs.js";
import type { CloudDocumentRecord, CloudImportJob, CloudImportProgress, CloudImportSourceKind, CloudSiteRecord, CloudUserRecord } from "../cloud-db.js";
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
import { type NotionImport, NotionImportError, type NotionPage, parseNotionBundle, parseNotionExport } from "../notion-import.js";
import { parse } from "../parser.js";
import { sanitizeAttachmentFilename, sniffAttachmentType } from "./attachments.js";
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
import { assertCloudId, optionalCloudId, optionalString } from "./input.js";
import { attachmentIdFor } from "./routes-attachments.js";

const SOURCE_SYSTEM = "confluence";
const NOTION_SOURCE_SYSTEM = "notion";
const DEFAULT_IMPORT_MAX_BYTES = 50_000_000;
const ZIP_CONTENT_TYPES = ["application/zip", "application/x-zip-compressed", "application/octet-stream"];

type SpaceLoader = (onProgress: (fetched: number) => void) => Promise<ConfluenceSpace>;
type JobPatch = Parameters<CloudServerConfig["store"]["updateImportJob"]>[1];
type ImportRun = (progress: CloudImportProgress, report: () => void, touch: (patch: JobPatch) => void) => Promise<Record<string, unknown>>;

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

  if ((parts[2] === "confluence" || parts[2] === "notion") && !parts[3]) {
    if (method !== "POST") throw new HttpError(405, "Method not allowed");
    const started = parts[2] === "notion"
      ? await startNotionImport(req, url, config, principal, user)
      : await startConfluenceImport(req, url, config, principal, user);
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
  } else if ([...ZIP_CONTENT_TYPES, "application/xml", "text/xml"].includes(contentType)) {
    siteId = optionalCloudId(url.searchParams.get("site"), "Site");
    overwrite = /^(1|true|yes)$/i.test(url.searchParams.get("overwrite") ?? "");
    const data = await readRawBody(req, maxBytes);
    kind = "confluence-export";
    loader = async () => parseConfluenceArchive(data);
  } else {
    throw new HttpError(415, "Send JSON, a Confluence XML export ZIP (application/zip), or entities.xml (application/xml)");
  }

  return queueImportJob(config, principal, user, siteId, kind, spaceKey, async (targetSiteId, progress, report, touch) => {
    const space = await loader((fetched) => touch({ progress: { ...progress, total: fetched } }));
    progress.total = space.pages.length;
    touch({ spaceKey: space.spaceKey, progress });
    return importSpace(config, targetSiteId, user, space, overwrite, progress, report);
  });
}

/**
 * Notion import: a "Markdown & CSV" export ZIP (raw `application/zip` body with `?site=`, or JSON
 * `{ siteId, archiveBase64 }`) or a JSON `{ siteId, bundle }` (see `parseNotionBundle`).
 */
async function startNotionImport(
  req: IncomingMessage,
  url: URL,
  config: CloudServerConfig,
  principal: Principal,
  user: CloudUserRecord,
): Promise<CloudImportJob> {
  const maxBytes = config.importMaxBytes ?? DEFAULT_IMPORT_MAX_BYTES;
  const contentType = (headerValue(req, "content-type") ?? "").split(";")[0]!.trim().toLowerCase();
  const options = { maxAttachmentBytes: config.maxAttachmentBytes };
  let siteId: string | undefined;
  let overwrite = false;
  let kind: CloudImportSourceKind;
  let loader: () => NotionImport;

  if (contentType === "application/json" || contentType === "") {
    const input = await readJsonBody(req, maxBytes);
    siteId = optionalCloudId(input.siteId, "Site");
    overwrite = input.overwrite === true;
    if (input.bundle !== undefined) {
      const parsed = wrapImportError(() => parseNotionBundle(input.bundle, options));
      kind = "notion-bundle";
      loader = () => parsed;
    } else if (typeof input.archiveBase64 === "string") {
      const data = base64Input(input.archiveBase64, maxBytes);
      kind = "notion-export";
      loader = () => parseNotionExport(data, options);
    } else {
      throw new HttpError(400, "Provide archiveBase64 (a Notion Markdown & CSV export ZIP) or bundle");
    }
  } else if (ZIP_CONTENT_TYPES.includes(contentType)) {
    siteId = optionalCloudId(url.searchParams.get("site"), "Site");
    overwrite = /^(1|true|yes)$/i.test(url.searchParams.get("overwrite") ?? "");
    const data = await readRawBody(req, maxBytes);
    kind = "notion-export";
    loader = () => parseNotionExport(data, options);
  } else {
    throw new HttpError(415, "Send JSON or a Notion Markdown & CSV export ZIP (application/zip)");
  }

  return queueImportJob(config, principal, user, siteId, kind, undefined, async (targetSiteId, progress, report) => {
    const parsed = loader();
    progress.total = parsed.pages.length;
    report();
    return importNotion(config, targetSiteId, user, parsed, overwrite, progress, report);
  });
}

/** Checks the target space, records a queued job, and runs it in the background. */
async function queueImportJob(
  config: CloudServerConfig,
  principal: Principal,
  user: CloudUserRecord,
  siteId: string | undefined,
  kind: CloudImportSourceKind,
  spaceKey: string | undefined,
  run: (siteId: string, ...rest: Parameters<ImportRun>) => ReturnType<ImportRun>,
): Promise<CloudImportJob> {
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
  const targetSiteId = siteId;
  setImmediate(() => {
    runImportJob(config, job, user, (...args) => run(targetSiteId, ...args)).catch(() => undefined);
  });
  return job;
}

async function runImportJob(config: CloudServerConfig, job: CloudImportJob, user: CloudUserRecord, run: ImportRun): Promise<void> {
  const progress = emptyProgress();
  const touch = (patch: JobPatch): void => config.store.updateImportJob(job.id, patch, config.now().toISOString());
  try {
    touch({ status: "running" });
    const result = await run(progress, () => touch({ progress }), touch);
    touch({ status: "succeeded", progress, result, finishedAt: config.now().toISOString() });
    recordActivity(config, user, "import.completed", "site", job.siteId, { jobId: job.id, created: progress.created, updated: progress.updated });
  } catch (error) {
    const known = error instanceof ConfluenceImportError || error instanceof NotionImportError || error instanceof HttpError;
    const message = known ? error.message : `Import failed: ${error instanceof Error ? error.message : String(error)}`;
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

function countOutcome(progress: CloudImportProgress, action: ImportedPage["action"]): void {
  if (action === "created") progress.created += 1;
  else if (action === "updated") progress.updated += 1;
  else if (action === "unchanged") progress.unchanged += 1;
  else if (action === "failed") progress.failed += 1;
  else progress.skipped += 1;
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
  const ordered = orderPages(space.pages);
  const documentByPage = new Map<string, string>();
  const outcomes: ImportedPage[] = [];
  const loss = new Map<string, number>();
  let attachments = 0;

  for (const page of ordered) {
    await new Promise<void>((resolveTick) => setImmediate(resolveTick));
    try {
      const outcome = await importPage(config, initialSite, user, space, page, overwrite, loss);
      attachments += outcome.attachments;
      outcomes.push(outcome.page);
      const documentId = outcome.page.documentId;
      if (documentId && !config.store.isTrashed("document", documentId)) documentByPage.set(page.id, documentId);
      countOutcome(progress, outcome.page.action);
    } catch (error) {
      progress.failed += 1;
      outcomes.push({ pageId: page.id, title: page.title, action: "failed", reason: error instanceof Error ? error.message.slice(0, 300) : String(error) });
    }
    progress.processed += 1;
    report();
  }

  await attachImportedTree(config, siteId, user, ordered, documentByPage);

  return {
    spaceKey: space.spaceKey,
    ...(space.spaceName ? { spaceName: space.spaceName } : {}),
    pages: outcomes.slice(0, 2_000),
    loss: [...loss].map(([macro, count]) => ({ macro, count })).sort((a, b) => b.count - a.count),
    attachments: {
      referenced: attachments,
      note: "Attachments are not copied into Noma Cloud; figures keep links to the original Confluence download URLs (or attachments/<pageId>/<file> for file exports).",
    },
  };
}

/** Adds imported documents to the space and links each to its imported parent. */
async function attachImportedTree(
  config: CloudServerConfig,
  siteId: string,
  user: CloudUserRecord,
  ordered: Array<{ id: string; parentId?: string }>,
  documentByPage: Map<string, string>,
): Promise<void> {
  const pageIds = new Set(ordered.map((page) => page.id));
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
}

async function importPage(
  config: CloudServerConfig,
  site: CloudSiteRecord,
  user: CloudUserRecord,
  space: ConfluenceSpace,
  page: ConfluencePage,
  overwrite: boolean,
  loss: Map<string, number>,
): Promise<{ page: ImportedPage; attachments: number }> {
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
  });
  for (const entry of conversion.loss) loss.set(entry.macro, (loss.get(entry.macro) ?? 0) + entry.count);
  const imported = await upsertImportedPage(config, site, user, {
    sourceSystem: SOURCE_SYSTEM,
    sourceLabel: "Confluence",
    sourceId: `${space.spaceKey}:${page.id}`,
    pageId: page.id,
    title: page.title,
    source: conversion.source,
    ...(page.version ? { version: page.version } : {}),
    labels: page.labels,
    overwrite,
    activity: { importedFrom: "confluence", confluencePageId: page.id },
  });
  return { page: imported, attachments: conversion.attachments.length };
}

interface UpsertInput {
  sourceSystem: string;
  sourceLabel: string;
  sourceId: string;
  pageId: string;
  title: string;
  source: string;
  version?: string;
  labels: string[];
  overwrite: boolean;
  activity: Record<string, unknown>;
}

/**
 * Creates or updates the document mapped to one imported source page. Pages edited in Noma since
 * the last import are skipped unless `overwrite` is set; unchanged sources only merge labels.
 */
async function upsertImportedPage(config: CloudServerConfig, site: CloudSiteRecord, user: CloudUserRecord, input: UpsertInput): Promise<ImportedPage> {
  parse(input.source, { filename: `${input.pageId}.noma` });
  const sourceHash = sha256Hex(input.source);
  const title = input.title.slice(0, 120) || "Untitled Page";
  const now = config.now().toISOString();
  const mapping = config.store.readImportSource(site.id, input.sourceSystem, input.sourceId);
  // A mapped page that has left this space is not updated or re-added: re-adding would hand the space's members access to it.
  const existing = mapping && site.documentIds.includes(mapping.documentId) ? config.store.readDocument(mapping.documentId) : undefined;
  const outcome = (action: ImportedPage["action"], documentId?: string, reason?: string): ImportedPage => ({
    pageId: input.pageId,
    title,
    ...(documentId ? { documentId } : {}),
    action,
    ...(reason ? { reason } : {}),
  });
  const writeMapping = (documentId: string): void =>
    config.store.writeImportSource({
      siteId: site.id,
      sourceSystem: input.sourceSystem,
      sourceId: input.sourceId,
      documentId,
      ...(input.version ? { sourceVersion: input.version } : {}),
      importedHash: sourceHash,
      importedAt: now,
    });

  if (existing) {
    if (config.store.isTrashed("document", existing.id)) return outcome("skipped", existing.id, "The Noma page is in the trash");
    if (mapping!.importedHash === sourceHash) {
      mergeLabels(config, existing.id, input.labels, user, now);
      return outcome("unchanged", existing.id, existing.hash === sourceHash ? undefined : `Unchanged in ${input.sourceLabel}; local Noma edits kept`);
    }
    if (existing.hash !== mapping!.importedHash && !input.overwrite) {
      return outcome("skipped", existing.id, "The Noma page was edited after the last import; re-run with overwrite to replace it");
    }
    const record: CloudDocumentRecord = { ...existing, title, source: input.source, hash: sourceHash, updatedAt: now, updatedBy: user.id };
    await writeDocument(config, record, existing.hash);
    mergeLabels(config, existing.id, input.labels, user, now);
    writeMapping(existing.id);
    recordActivity(config, user, "document.updated", "document", existing.id, { hash: sourceHash, ...input.activity });
    return outcome("updated", existing.id);
  }

  const record: CloudDocumentRecord = {
    version: 2,
    id: uniqueId(config),
    title,
    source: input.source,
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
  mergeLabels(config, record.id, input.labels, user, now);
  writeMapping(record.id);
  recordActivity(config, user, "document.created", "document", record.id, { title, ...input.activity });
  return outcome("created", record.id);
}

interface NotionAttachmentStats {
  referenced: number;
  stored: number;
  unchanged: number;
  addedBytes: number;
  skipped: Array<{ pageId: string; filename: string; reason: string }>;
}

async function importNotion(
  config: CloudServerConfig,
  siteId: string,
  user: CloudUserRecord,
  workspace: NotionImport,
  overwrite: boolean,
  progress: CloudImportProgress,
  report: () => void,
): Promise<Record<string, unknown>> {
  const initialSite = await readSite(config, siteId);
  const documentByPage = new Map<string, string>();
  const outcomes: ImportedPage[] = [];
  const stats: NotionAttachmentStats = { referenced: 0, stored: 0, unchanged: 0, addedBytes: 0, skipped: [] };

  for (const page of workspace.pages) {
    await new Promise<void>((resolveTick) => setImmediate(resolveTick));
    try {
      const imported = await upsertImportedPage(config, initialSite, user, {
        sourceSystem: NOTION_SOURCE_SYSTEM,
        sourceLabel: "Notion",
        sourceId: page.id,
        pageId: page.id,
        title: page.title,
        source: page.source,
        labels: page.labels,
        overwrite,
        activity: { importedFrom: "notion", notionPageId: page.id },
      });
      outcomes.push(imported);
      const documentId = imported.documentId;
      if (documentId && !config.store.isTrashed("document", documentId)) {
        documentByPage.set(page.id, documentId);
        if (imported.action !== "skipped") await storeNotionAttachments(config, siteId, documentId, page, user, stats);
      }
      countOutcome(progress, imported.action);
    } catch (error) {
      progress.failed += 1;
      outcomes.push({ pageId: page.id, title: page.title, action: "failed", reason: error instanceof Error ? error.message.slice(0, 300) : String(error) });
    }
    progress.processed += 1;
    report();
  }

  await attachImportedTree(config, siteId, user, workspace.pages, documentByPage);

  return {
    ...(workspace.workspace ? { workspace: workspace.workspace } : {}),
    pages: outcomes.slice(0, 2_000),
    loss: workspace.loss.map((entry) => ({ macro: entry.kind, count: entry.count })),
    skippedEntries: workspace.skipped.slice(0, 200),
    attachments: {
      referenced: stats.referenced,
      stored: stats.stored,
      unchanged: stats.unchanged,
      skipped: stats.skipped.slice(0, 200),
      note: "Images and files from the export are stored as page attachments and referenced as att:<filename>.",
    },
  };
}

/**
 * Stores a Notion page's files as attachments of its document. A file whose name already holds the
 * same bytes is left alone; changed bytes replace the old attachment. Oversized, executable, or
 * over-quota files are reported and skipped (their `att:` reference renders as a missing file).
 */
async function storeNotionAttachments(
  config: CloudServerConfig,
  siteId: string,
  documentId: string,
  page: NotionPage,
  user: CloudUserRecord,
  stats: NotionAttachmentStats,
): Promise<void> {
  if (page.attachments.length === 0) return;
  const existing = new Map(config.store.listAttachments(documentId).map((attachment) => [attachment.filename, attachment]));
  const now = config.now().toISOString();
  let changed = false;
  for (const attachment of page.attachments) {
    stats.referenced += 1;
    const skip = (reason: string): void => {
      stats.skipped.push({ pageId: page.id, filename: attachment.filename, reason });
    };
    const size = attachment.data.length;
    const sha256 = createHash("sha256").update(attachment.data).digest("hex");
    const current = existing.get(attachment.filename);
    if (current && current.sha256 === sha256) {
      stats.unchanged += 1;
      continue;
    }
    if (sanitizeAttachmentFilename(attachment.filename) !== attachment.filename) {
      skip("invalid filename");
      continue;
    }
    if (size === 0) {
      skip("empty file");
      continue;
    }
    if (size > config.maxAttachmentBytes) {
      skip(`larger than ${config.maxAttachmentBytes} bytes`);
      continue;
    }
    if (config.store.siteAttachmentBytes(siteId) + stats.addedBytes + size > config.attachmentQuotaBytes) {
      skip("attachment storage quota exceeded");
      continue;
    }
    let contentType: string;
    try {
      contentType = sniffAttachmentType(attachment.data.subarray(0, BLOB_HEAD_BYTES), undefined, attachment.filename);
    } catch (error) {
      skip(error instanceof Error ? error.message : String(error));
      continue;
    }
    const staged = await config.blobs.stage(
      (async function* () {
        yield attachment.data;
      })(),
    );
    await staged.commit();
    if (current) config.store.markAttachmentDeleted(current.id, now);
    config.store.insertAttachment({
      id: attachmentIdFor(config),
      documentId,
      sha256: staged.sha256,
      filename: attachment.filename,
      contentType,
      size: staged.size,
      uploadedBy: user.id,
      createdAt: now,
    });
    stats.stored += 1;
    stats.addedBytes += staged.size;
    changed = true;
  }
  if (changed) {
    config.store.reindexAttachments(documentId);
    recordActivity(config, user, "attachment.uploaded", "document", documentId, { importedFrom: "notion", notionPageId: page.id });
  }
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
    if (error instanceof ConfluenceImportError || error instanceof NotionImportError) throw new HttpError(error.status, error.message);
    throw error;
  }
}

function emptyProgress(): CloudImportProgress {
  return { total: 0, processed: 0, created: 0, updated: 0, unchanged: 0, skipped: 0, failed: 0 };
}
