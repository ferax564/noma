/**
 * Stale-knowledge maintenance per space: settings (`/api/sites/:id/maintenance`), a sweep that turns
 * knowledge-health findings (past review date, conflicting claims, broken links) into tracked items,
 * and optional AI refresh drafts. Drafts are ordinary proofed patch proposals that still need an
 * independent human approval. Sweeps run on an in-process timer, on demand, or from the worker entry.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { CloudHealthItemRecord, CloudMaintenanceRun, CloudSiteMaintenanceSettings, CloudSiteRecord, CloudUserRecord } from "../cloud-db.js";
import type { KnowledgeHealthItem } from "../cloud-platform.js";
import { aiStatus } from "./ai-runtime.js";
import { fetchSourceText } from "./ai-sources.js";
import { type CloudServerConfig, type Principal, randomId, readSite, requireAccessRole, requireNotTrashed, requireRecordAccess, requireUser, roleRank } from "./context.js";
import { HttpError, readJsonBody, sendJson, sha256Hex } from "./http.js";
import { boundedInteger, stringPathPart } from "./input.js";
import { draftRefreshProposal, type RefreshSource } from "./routes-ai.js";
import { knowledgeDocuments } from "./routes-knowledge.js";

const trackedKinds = new Set(["stale", "contradiction", "broken_link"]);
const manualRunCooldownMs = 60_000;
const sitesPerTick = 5;

export async function routeSiteMaintenance(req: IncomingMessage, res: ServerResponse, url: URL, parts: string[], config: CloudServerConfig, principal: Principal): Promise<void> {
  const user = requireUser(principal);
  const method = req.method ?? "GET";
  const site = await readSite(config, stringPathPart(parts[2], "Site ID"));
  requireNotTrashed(config, "site", site.id);
  const access = requireRecordAccess(config, site, principal, "viewer");
  const action = parts[4];
  if (!action && method === "GET") {
    sendJson(res, 200, maintenanceResponse(config, site, user));
    return;
  }
  if (!action && method === "PUT") {
    requireAccessRole(access, "editor");
    const input = await readJsonBody(req, config.maxBodyBytes);
    const current = settingsFor(config, site.id, user.id);
    const next: CloudSiteMaintenanceSettings = {
      ...current,
      enabled: booleanInput(input.enabled, current.enabled, "enabled"),
      aiRefresh: booleanInput(input.aiRefresh, current.aiRefresh, "aiRefresh"),
      intervalHours: boundedInteger(input.intervalHours, current.intervalHours, 1, 720, "intervalHours"),
      maxProposalsPerRun: boundedInteger(input.maxProposalsPerRun, current.maxProposalsPerRun, 0, 20, "maxProposalsPerRun"),
      runAs: user.id,
      updatedBy: user.id,
      updatedAt: config.now().toISOString(),
    };
    config.store.writeSiteMaintenance(next);
    sendJson(res, 200, maintenanceResponse(config, site, user));
    return;
  }
  if (action === "run" && method === "POST") {
    requireAccessRole(access, "editor");
    const settings = settingsFor(config, site.id, user.id);
    if (settings.lastRunAt && config.now().getTime() - Date.parse(settings.lastRunAt) < manualRunCooldownMs) {
      throw new HttpError(429, "This space was swept less than a minute ago", { code: "maintenance_cooldown", lastRunAt: settings.lastRunAt });
    }
    const run = await runSiteMaintenance(config, settings, "manual", user.id);
    sendJson(res, 200, { run, items: config.store.listHealthItems(site.id, "open") });
    return;
  }
  if (action === "items" && method === "GET") {
    const status = url.searchParams.get("status");
    if (status !== null && status !== "open" && status !== "resolved") throw new HttpError(400, "status must be open or resolved");
    sendJson(res, 200, { items: config.store.listHealthItems(site.id, status ?? undefined) });
    return;
  }
  throw new HttpError(action ? 404 : 405, action ? "Unknown maintenance route" : "Method not allowed");
}

function maintenanceResponse(config: CloudServerConfig, site: CloudSiteRecord, user: CloudUserRecord): Record<string, unknown> {
  const settings = settingsFor(config, site.id, user.id);
  const runAs = config.store.readUser(settings.runAs) ?? user;
  return {
    siteId: site.id,
    settings: { ...settings, configured: Boolean(config.store.readSiteMaintenance(site.id)) },
    ai: aiStatus(config, runAs),
    openItems: config.store.listHealthItems(site.id, "open").length,
    runs: config.store.listMaintenanceRuns(site.id, 10),
  };
}

function settingsFor(config: CloudServerConfig, siteId: string, fallbackUserId: string): CloudSiteMaintenanceSettings {
  return config.store.readSiteMaintenance(siteId) ?? {
    siteId,
    enabled: false,
    aiRefresh: false,
    intervalHours: 24,
    maxProposalsPerRun: 3,
    runAs: fallbackUserId,
    updatedBy: fallbackUserId,
    updatedAt: config.now().toISOString(),
  };
}

function booleanInput(value: unknown, fallback: boolean, label: string): boolean {
  if (value === undefined) return fallback;
  if (typeof value !== "boolean") throw new HttpError(400, `${label} must be a boolean`);
  return value;
}

/** Starts the in-process scheduler; returns a stop function. A tick of 0 disables it. */
export function startMaintenanceScheduler(config: CloudServerConfig): () => void {
  if (config.ai.maintenanceTickMs <= 0) return () => undefined;
  let running = false;
  const timer = setInterval(() => {
    if (running) return;
    running = true;
    runDueMaintenance(config)
      .catch((error: unknown) => console.error("noma cloud maintenance tick failed", error))
      .finally(() => {
        running = false;
      });
  }, config.ai.maintenanceTickMs);
  timer.unref();
  return () => clearInterval(timer);
}

export async function runDueMaintenance(config: CloudServerConfig): Promise<{ runs: CloudMaintenanceRun[] }> {
  const due = config.store.listDueSiteMaintenance(config.now().toISOString(), sitesPerTick);
  const runs: CloudMaintenanceRun[] = [];
  for (const settings of due) runs.push(await runSiteMaintenance(config, settings, "scheduled"));
  return { runs };
}

/** Sweeps one space as `actorId` (the caller for manual runs, the opted-in `runAs` user for scheduled ones). */
export async function runSiteMaintenance(
  config: CloudServerConfig,
  settings: CloudSiteMaintenanceSettings,
  trigger: CloudMaintenanceRun["trigger"],
  actorId = settings.runAs,
): Promise<CloudMaintenanceRun> {
  const startedAt = config.now().toISOString();
  const run: CloudMaintenanceRun = { id: randomId(), siteId: settings.siteId, trigger, status: "running", startedAt, itemsOpen: 0, itemsResolved: 0, proposalsCreated: 0, detail: {} };
  config.store.writeMaintenanceRun(run);
  const finish = (patch: Partial<CloudMaintenanceRun>): CloudMaintenanceRun => {
    const finished: CloudMaintenanceRun = { ...run, ...patch, finishedAt: config.now().toISOString() };
    config.store.writeMaintenanceRun(finished);
    config.store.writeSiteMaintenance({ ...settings, lastRunAt: startedAt });
    return finished;
  };
  const user = config.store.readUser(actorId);
  const site = config.store.readSite(settings.siteId);
  if (!user || !site || !config.store.resourceAccess(user.id, "site", site.id)) {
    return finish({ status: "failed", detail: { actorId, error: "The maintenance user no longer has access to this space" } });
  }
  try {
    const documents = knowledgeDocuments(config, user, site.id);
    const findings = config.platform.health(documents, startedAt).filter((item) => trackedKinds.has(item.kind) && item.documentId);
    const { open, resolved } = reconcileItems(config, site.id, findings, startedAt);
    const drafting = settings.aiRefresh && settings.maxProposalsPerRun > 0
      ? await draftRefreshes(config, user, site, open, settings.maxProposalsPerRun)
      : { created: 0, skipped: [] as Array<Record<string, unknown>> };
    return finish({
      status: "completed",
      itemsOpen: open.length,
      itemsResolved: resolved,
      proposalsCreated: drafting.created,
      detail: { actorId, documentsScanned: documents.length, aiRefresh: settings.aiRefresh, skipped: drafting.skipped.slice(0, 50) },
    });
  } catch (error) {
    return finish({ status: "failed", detail: { error: error instanceof Error ? error.message : "Maintenance failed" } });
  }
}

function reconcileItems(config: CloudServerConfig, siteId: string, findings: KnowledgeHealthItem[], now: string): { open: CloudHealthItemRecord[]; resolved: number } {
  const existing = new Map(config.store.listHealthItems(siteId, undefined, 5_000).map((item) => [item.id, item]));
  const seen = new Set<string>();
  const open: CloudHealthItemRecord[] = [];
  for (const finding of findings) {
    const id = sha256Hex(`${siteId}:${finding.kind}:${finding.documentId ?? ""}:${finding.blockId ?? ""}:${finding.message}`).slice(0, 32);
    if (seen.has(id)) continue;
    seen.add(id);
    const previous = existing.get(id);
    const item: CloudHealthItemRecord = {
      id,
      siteId,
      kind: finding.kind,
      severity: finding.severity,
      ...(finding.documentId ? { documentId: finding.documentId } : {}),
      ...(finding.blockId ? { blockId: finding.blockId } : {}),
      message: finding.message,
      evidence: finding.evidence,
      status: "open",
      ...(previous?.proposalId ? { proposalId: previous.proposalId } : {}),
      firstSeenAt: previous && previous.status === "open" ? previous.firstSeenAt : now,
      lastSeenAt: now,
    };
    config.store.writeHealthItem(item);
    open.push(item);
  }
  let resolved = 0;
  for (const item of existing.values()) {
    if (item.status !== "open" || seen.has(item.id)) continue;
    config.store.writeHealthItem({ ...item, status: "resolved", resolvedAt: now });
    resolved += 1;
  }
  return { open, resolved };
}

async function draftRefreshes(
  config: CloudServerConfig,
  user: CloudUserRecord,
  site: CloudSiteRecord,
  items: CloudHealthItemRecord[],
  limit: number,
): Promise<{ created: number; skipped: Array<Record<string, unknown>> }> {
  const skipped: Array<Record<string, unknown>> = [];
  const status = aiStatus(config, user);
  if (!status.available) return { created: 0, skipped: [{ reason: "ai_unavailable", detail: status.reason }] };
  const staleByDocument = new Map<string, CloudHealthItemRecord[]>();
  for (const item of items) {
    if (item.kind !== "stale" || !item.documentId) continue;
    const pending = item.proposalId ? config.store.readPatchProposal(item.proposalId) : undefined;
    if (pending?.status === "pending" || pending?.status === "approved") continue;
    staleByDocument.set(item.documentId, [...(staleByDocument.get(item.documentId) ?? []), item]);
  }
  let created = 0;
  for (const [documentId, staleItems] of staleByDocument) {
    if (created >= limit) break;
    const role = config.store.documentAccessRole(user.id, documentId);
    if (!role || roleRank[role] < roleRank.editor) {
      skipped.push({ documentId, reason: "not_editor" });
      continue;
    }
    const document = config.store.readDocument(documentId);
    if (!document) continue;
    const sources = await maintenanceSources(config, site, documentId);
    if (sources.length === 0) {
      skipped.push({ documentId, reason: "no_sources" });
      continue;
    }
    const blockIds = [...new Set(staleItems.map((item) => item.blockId).filter((id): id is string => Boolean(id)))];
    try {
      const result = await draftRefreshProposal(config, user, document, sources, {
        trigger: "scheduled",
        instruction: `These blocks are past their review date: ${blockIds.join(", ")}. Update them only where the sources show newer facts.`,
      });
      const proposal = result.proposal as { id: string };
      for (const item of staleItems) config.store.writeHealthItem({ ...item, proposalId: proposal.id });
      created += 1;
    } catch (error) {
      const details = error instanceof HttpError ? error.details : {};
      skipped.push({ documentId, reason: typeof details.code === "string" ? details.code : "draft_failed", message: error instanceof Error ? error.message : String(error) });
      if (details.code === "ai_unavailable") break;
    }
  }
  return { created, skipped };
}

/** Sources recorded on the page: trust `sourceOf` URLs and connector sources linked to the document. */
async function maintenanceSources(config: CloudServerConfig, site: CloudSiteRecord, documentId: string): Promise<RefreshSource[]> {
  const urls = new Set<string>();
  for (const trust of config.platform.listTrust([documentId])) {
    for (const value of trust.sourceOf ?? []) if (/^https?:\/\//i.test(value)) urls.add(value);
  }
  for (const connector of config.platform.listConnectors([site.id])) {
    if (connector.status === "disabled") continue;
    for (const source of config.platform.listConnectorSources(connector.id)) {
      if (source.documentId === documentId && !source.tombstonedAt) urls.add(source.sourceUrl);
    }
  }
  const sources: RefreshSource[] = [];
  for (const url of [...urls].slice(0, 3)) {
    try {
      const fetched = await fetchSourceText(url, { allowPrivateHosts: config.ai.allowPrivateSourceHosts });
      sources.push({ id: `S${sources.length + 1}`, kind: "url", label: fetched.finalUrl, url: fetched.finalUrl, contentHash: fetched.contentHash, text: fetched.text });
    } catch {
      continue;
    }
  }
  return sources;
}
