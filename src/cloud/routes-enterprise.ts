/** `/api/enterprise`: policy, SCIM, legal hold, audit export, retention, chat eDiscovery. */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { EnterprisePolicy, LegalHold, ScimIdentity } from "../cloud-platform.js";
import { type CloudServerConfig, type Principal, requireUser, requireWorkspaceOwner, uniqueId } from "./context.js";
import { DLP_DETECTORS, type DlpDetector } from "../cloud-compliance.js";
import { HttpError, readJsonBody, sendJson } from "./http.js";
import { auditNdjson, shipAuditToSiem } from "./siem.js";
import {
  absoluteUrl,
  boundedInteger,
  numberQuery,
  optionalRecord,
  optionalString,
  optionalStringArray,
  requiredStringArray,
  stringInput,
} from "./input.js";
import { connectorKinds } from "./routes-agents.js";
import { channelExport, enforceChatRetention } from "./routes-chat.js";
import { platformInput } from "./routes-knowledge.js";
import { pageQuery, requestUrl } from "./security.js";

function siemView(config: CloudServerConfig): Record<string, unknown> {
  const status = config.compliance.siemStatus();
  const latest = config.platform.auditStats(config.now().toISOString()).latestSequence;
  return { configured: Boolean(config.siem), ...(config.siem ? { url: new URL(config.siem.url).origin } : {}), ...status, lag: Math.max(0, latest - status.cursor) };
}

function isoParam(value: string, label: string): string {
  if (Number.isNaN(Date.parse(value))) throw new HttpError(400, `${label} must be an ISO date`);
  return new Date(value).toISOString();
}

export async function routeEnterprise(req: IncomingMessage, res: ServerResponse, parts: string[], config: CloudServerConfig, principal: Principal): Promise<void> {
  const user = requireUser(principal);
  requireWorkspaceOwner(config, user);
  const method = req.method ?? "GET";
  const action = parts[2];
  if (!action && method === "GET") {
    sendJson(res, 200, config.platform.enterprisePolicy());
    return;
  }
  if (!action && method === "PUT") {
    const input = await readJsonBody(req, config.maxBodyBytes);
    const sso = optionalRecord(input.sso, "sso") ?? {};
    const scim = optionalRecord(input.scim, "scim") ?? {};
    const policy: EnterprisePolicy = {
      id: "workspace",
      sso: {
        enabled: sso.enabled === true,
        provider: sso.provider === "oidc" || sso.provider === "saml" ? sso.provider : "none",
        ...(optionalString(sso.issuer) ? { issuer: optionalString(sso.issuer) } : {}),
        enforced: sso.enforced === true,
      },
      scim: { enabled: scim.enabled === true, ...(optionalString(scim.baseUrl) ? { baseUrl: absoluteUrl(scim.baseUrl, "scim.baseUrl") } : {}) },
      retentionDays: boundedInteger(input.retentionDays, 365, 1, 36_500, "retentionDays"),
      chatRetentionDays: boundedInteger(input.chatRetentionDays, 0, 0, 36_500, "chatRetentionDays"),
      legalHoldEnabled: input.legalHoldEnabled === true,
      dataResidency: stringInput(input, "dataResidency", "local").slice(0, 100),
      connectorAllowlist: connectorKinds(input.connectorAllowlist),
      modelAllowlist: requiredStringArray(input.modelAllowlist, "modelAllowlist", 100),
      requireZeroRetentionModels: input.requireZeroRetentionModels === true,
      auditExportEnabled: input.auditExportEnabled !== false,
      updatedAt: config.now().toISOString(),
      updatedBy: user.id,
    };
    if (policy.sso.enforced && !config.ssoTrustedHeaderHash && !config.oidc) {
      throw new HttpError(409, "Configure NOMA_CLOUD_OIDC_* or NOMA_CLOUD_SSO_TRUST_SECRET before enforcing SSO");
    }
    sendJson(res, 200, platformInput(() => config.platform.setEnterprisePolicy(policy)));
    return;
  }
  if (action === "scim" && method === "GET") {
    const page = pageQuery(requestUrl(req));
    sendJson(res, 200, { identities: config.platform.listScimIdentities(page), ...page });
    return;
  }
  if (action === "scim" && method === "POST") {
    const input = await readJsonBody(req, config.maxBodyBytes);
    const id = stringInput(input, "id");
    const externalId = stringInput(input, "externalId");
    const userId = stringInput(input, "userId");
    const conflicting = config.platform
      .listScimIdentities()
      .find((existing) => existing.id !== id && (existing.externalId === externalId || existing.userId === userId));
    if (conflicting) throw new HttpError(409, "externalId and userId are already bound to another SCIM identity");
    const bound = config.platform.listScimIdentities().find((existing) => existing.id === id);
    if (bound && (bound.externalId !== externalId || bound.userId !== userId)) {
      throw new HttpError(409, "A SCIM identity cannot be rebound to a different externalId or user");
    }
    if (!config.store.readUser(userId)) throw new HttpError(404, "userId must reference an existing Noma user");
    const identity: ScimIdentity = {
      id,
      externalId,
      userId,
      userName: stringInput(input, "userName"),
      active: input.active !== false,
      groups: optionalStringArray(input.groups, "groups", 500) ?? [],
      updatedAt: config.now().toISOString(),
    };
    sendJson(res, 201, platformInput(() => config.platform.upsertScimIdentity(identity, user.id)));
    return;
  }
  if (action === "legal-holds" && method === "GET") {
    const page = pageQuery(requestUrl(req));
    sendJson(res, 200, { holds: config.platform.listLegalHolds(page), ...page });
    return;
  }
  if (action === "legal-holds" && method === "POST") {
    const input = await readJsonBody(req, config.maxBodyBytes);
    const resourceType = input.resourceType === "document" || input.resourceType === "site" || input.resourceType === "user" || input.resourceType === "chat_channel" ? input.resourceType : undefined;
    if (!resourceType) throw new HttpError(400, "resourceType must be document, site, user, or chat_channel");
    const hold: LegalHold = { id: uniqueId(config), resourceType, resourceId: stringInput(input, "resourceId"), reason: stringInput(input, "reason").slice(0, 2_000), createdBy: user.id, createdAt: config.now().toISOString() };
    sendJson(res, 201, platformInput(() => config.platform.putLegalHold(hold)));
    return;
  }
  if (action === "audit.ndjson" && method === "GET") {
    if (!config.platform.enterprisePolicy().auditExportEnabled) throw new HttpError(403, "Audit export is disabled");
    const url = requestUrl(req);
    const after = boundedInteger(numberQuery(url.searchParams.get("after")), 0, 0, Number.MAX_SAFE_INTEGER, "after");
    const limit = boundedInteger(numberQuery(url.searchParams.get("limit")), 1_000, 1, 10_000, "limit");
    const records = config.platform.auditAfter(after, limit);
    config.platform.recordAudit(user.id, "audit.exported", "workspace", "workspace", { format: "ndjson", after, records: records.length }, config.now().toISOString());
    res.writeHead(200, { "content-type": "application/x-ndjson; charset=utf-8", "cache-control": "no-store", "x-noma-next-after": String(records.at(-1)?.sequence ?? after) });
    res.end(auditNdjson(records));
    return;
  }
  if (action === "dlp" && method === "GET") {
    sendJson(res, 200, { ...config.compliance.dlpPolicy(), available: DLP_DETECTORS });
    return;
  }
  if (action === "dlp" && method === "PUT") {
    const input = await readJsonBody(req, config.maxBodyBytes);
    const mode = input.mode;
    if (mode !== "off" && mode !== "warn" && mode !== "block") throw new HttpError(400, "mode must be off, warn, or block");
    const detectors = input.detectors === undefined ? [...DLP_DETECTORS] : Array.isArray(input.detectors) ? input.detectors : undefined;
    if (!detectors || detectors.some((detector) => !(DLP_DETECTORS as readonly unknown[]).includes(detector))) throw new HttpError(400, `detectors must be a subset of ${DLP_DETECTORS.join(", ")}`);
    const now = config.now().toISOString();
    const saved = config.compliance.setDlpPolicy({ mode, detectors: [...new Set(detectors as DlpDetector[])], updatedBy: user.id, updatedAt: now });
    config.platform.recordAudit(user.id, "dlp.policy_updated", "workspace", "workspace", { mode: saved.mode, detectors: saved.detectors }, now);
    sendJson(res, 200, { ...saved, available: DLP_DETECTORS });
    return;
  }
  if (action === "dlp-findings" && method === "GET") {
    const since = new Date(config.now().getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();
    sendJson(res, 200, { findings: config.compliance.listFindings(since, 200) });
    return;
  }
  if (action === "siem" && method === "GET" && !parts[3]) {
    sendJson(res, 200, siemView(config));
    return;
  }
  if (action === "siem" && parts[3] === "ship" && method === "POST") {
    if (!config.siem) throw new HttpError(409, "No SIEM is configured (set NOMA_CLOUD_SIEM_URL and NOMA_CLOUD_SIEM_TOKEN)", { code: "siem_not_configured" });
    await shipAuditToSiem(config);
    sendJson(res, 200, siemView(config));
    return;
  }
  if (action === "overview" && method === "GET") {
    const now = config.now();
    const since = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000).toISOString();
    const monthStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
    const workspace = config.store.workspaceCounts(since);
    const chat = config.chat.stats(since);
    sendJson(res, 200, {
      generatedAt: now.toISOString(),
      window: { since, monthStart },
      people: { users: workspace.users, activeLast30d: workspace.activeUsers },
      knowledge: { spaces: workspace.spaces, pages: workspace.pages },
      work: { projects: workspace.projects, openIssues: workspace.openIssues },
      chat,
      storage: { attachmentBytes: workspace.attachmentBytes, chatFileBytes: chat.fileBytes },
      ai: { spendLast30dUsd: Math.round(workspace.aiSpendUsd * 100) / 100, agents: config.platform.agentCounts(), paused: config.agentOps.killSwitch().paused },
      runs: { environment: config.runProvider?.name ?? null, ...config.devloop.stats(monthStart) },
      compliance: {
        dlp: { mode: config.compliance.dlpPolicy().mode, ...config.compliance.findingCounts(since) },
        audit: { ...config.platform.auditStats(new Date(now.getTime() - 24 * 60 * 60 * 1000).toISOString()), exportEnabled: config.platform.enterprisePolicy().auditExportEnabled },
        siem: siemView(config),
        chatRetentionDays: config.platform.enterprisePolicy().chatRetentionDays ?? 0,
      },
    });
    return;
  }
  if (action === "audit" && method === "GET") {
    const resources = [...config.store.listDocuments(user).map((document) => document.id), ...config.store.listSites(user).map((site) => site.id), "workspace"];
    sendJson(res, 200, platformInput(() => config.platform.exportAudit(user.id, resources)));
    return;
  }
  if (action === "retention" && method === "POST") {
    const platform = config.platform.enforceRetention(config.now().toISOString());
    const chatDays = config.platform.enterprisePolicy().chatRetentionDays ?? 0;
    sendJson(res, 200, { ...platform, ...(chatDays > 0 ? { chat: await enforceChatRetention(config, chatDays, user.id) } : {}) });
    return;
  }
  if (action === "agents" && method === "GET") {
    sendJson(res, 200, config.agentOps.killSwitch());
    return;
  }
  if (action === "agents" && method === "PUT") {
    const input = await readJsonBody(req, config.maxBodyBytes);
    if (typeof input.paused !== "boolean") throw new HttpError(400, "paused must be true or false");
    const now = config.now().toISOString();
    const reason = optionalString(input.reason)?.slice(0, 500);
    const saved = config.agentOps.setKillSwitch({ paused: input.paused, ...(reason ? { reason } : {}), updatedBy: user.id, updatedAt: now });
    config.platform.recordAudit(user.id, input.paused ? "agents.paused" : "agents.resumed", "workspace", "workspace", { ...(reason ? { reason } : {}) }, now);
    sendJson(res, 200, saved);
    return;
  }
  if (action === "chat-export" && method === "GET") {
    const url = requestUrl(req);
    const channelId = url.searchParams.get("channelId");
    const siteId = url.searchParams.get("siteId");
    const userId = url.searchParams.get("userId");
    const channels = channelId
      ? [config.chat.readChannel(channelId)].filter((channel) => channel !== undefined)
      : config.chat.listAllChannels(siteId ? [siteId] : undefined).filter((channel) => !userId || channel.kind === "channel" || config.chat.readMember(channel.id, userId));
    if (channelId && channels.length === 0) throw new HttpError(404, "Channel not found");
    const window = { ...(url.searchParams.get("since") ? { since: isoParam(url.searchParams.get("since")!, "since") } : {}), ...(url.searchParams.get("until") ? { until: isoParam(url.searchParams.get("until")!, "until") } : {}) };
    const exports = channels.slice(0, 500).map((channel) => channelExport(config, channel, window, user, userId ?? undefined));
    config.platform.recordAudit(user.id, "chat.ediscovery_exported", "workspace", "workspace", { channels: exports.length, ...(siteId ? { siteId } : {}), ...(userId ? { userId } : {}), ...window }, config.now().toISOString());
    sendJson(res, 200, { format: "noma-chat-ediscovery-v1", exportedAt: config.now().toISOString(), exportedBy: user.id, channels: exports, truncated: channels.length > 500 });
    return;
  }
  throw new HttpError(404, "Unknown enterprise route");
}
