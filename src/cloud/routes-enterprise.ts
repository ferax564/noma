/** `/api/enterprise`: policy, SCIM, legal hold, audit export, retention, chat eDiscovery. */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { EnterprisePolicy, LegalHold, ScimIdentity } from "../cloud-platform.js";
import { type CloudServerConfig, type Principal, requireUser, requireWorkspaceOwner, uniqueId } from "./context.js";
import { HttpError, readJsonBody, sendJson } from "./http.js";
import {
  absoluteUrl,
  boundedInteger,
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
    const exports = channels.slice(0, 500).map((channel) => {
      const bundle = channelExport(config, channel, window, user);
      return userId ? { ...bundle, messages: bundle.messages.filter((message) => message.authorId === userId || (message.mentions as string[]).includes(userId)) } : bundle;
    });
    config.platform.recordAudit(user.id, "chat.ediscovery_exported", "workspace", "workspace", { channels: exports.length, ...(siteId ? { siteId } : {}), ...(userId ? { userId } : {}), ...window }, config.now().toISOString());
    sendJson(res, 200, { format: "noma-chat-ediscovery-v1", exportedAt: config.now().toISOString(), exportedBy: user.id, channels: exports, truncated: channels.length > 500 });
    return;
  }
  throw new HttpError(404, "Unknown enterprise route");
}
