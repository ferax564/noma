/** `/api/users`. */
import type { IncomingMessage, ServerResponse } from "node:http";
import { type CloudNotificationType, type CloudUserRecord, cloudNotificationTypes } from "../cloud-db.js";
import { type CloudServerConfig, type Principal, randomToken, requireNotTrashed, requireRecordAccess, requireUser, tokenPreview, writeUser } from "./context.js";
import { HttpError, readJsonBody, sendJson, sha256Hex } from "./http.js";
import { assertCloudId, optionalCloudId, optionalRecord } from "./input.js";
import { isValidEmail } from "./mail.js";
import { createUser, publicUser, selfUser } from "./records.js";
import { requireInvitationCode } from "./routes-auth.js";
import { requireScope } from "./security.js";

export async function routeUsers(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  parts: string[],
  config: CloudServerConfig,
  principal: Principal,
): Promise<void> {
  const method = req.method ?? "GET";
  const id = parts[2];

  if (!id && method === "POST") {
    const input = await readJsonBody(req, config.maxBodyBytes);
    requireInvitationCode(config, req, input);
    const { record, token } = await createUser(config, input);
    sendJson(res, 201, { ...selfUser(record), token });
    return;
  }

  if (id === "me" && !parts[3] && method === "GET") {
    const user = requireUser(principal);
    sendJson(res, 200, selfUser(user));
    return;
  }

  if (id === "me" && !parts[3] && (method === "PUT" || method === "PATCH")) {
    const user = requireUser(principal);
    const input = await readJsonBody(req, config.maxBodyBytes);
    const next: CloudUserRecord = { ...user, updatedAt: config.now().toISOString() };
    if (input.name !== undefined) {
      if (typeof input.name !== "string" || !input.name.trim()) throw new HttpError(400, "name must be a non-empty string");
      next.name = input.name.trim().slice(0, 80);
    }
    if (input.email !== undefined) {
      if (input.email === null || input.email === "") delete next.email;
      else if (typeof input.email !== "string" || !isValidEmail(input.email.trim())) throw new HttpError(400, "email must be a valid address");
      else next.email = input.email.trim();
    }
    await writeUser(config, next);
    sendJson(res, 200, selfUser(next));
    return;
  }

  if (id === "me" && parts[3] === "preferences") {
    const user = requireUser(principal);
    if (method === "GET") {
      sendJson(res, 200, preferencesResponse(config, user));
      return;
    }
    if (method !== "PUT" && method !== "PATCH") throw new HttpError(405, "Method not allowed");
    const input = await readJsonBody(req, config.maxBodyBytes);
    const current = config.store.notificationPreferences(user.id);
    const channels = { ...current.channels };
    const requested = optionalRecord(input.channels, "channels") ?? {};
    for (const [type, channel] of Object.entries(requested)) {
      if (!(cloudNotificationTypes as readonly string[]).includes(type)) throw new HttpError(400, `Unknown notification type: ${type}`);
      if (channel !== "in_app" && channel !== "email" && channel !== "off") throw new HttpError(400, "channels values must be in_app, email, or off");
      channels[type as CloudNotificationType] = channel;
    }
    let digest = current.digest;
    if (input.digest !== undefined) {
      if (input.digest !== "off" && input.digest !== "daily" && input.digest !== "weekly") throw new HttpError(400, "digest must be off, daily, or weekly");
      digest = input.digest;
    }
    const now = config.now().toISOString();
    const lastDigestAt = digest !== current.digest && digest !== "off" ? now : current.lastDigestAt;
    config.store.writeNotificationPreferences({ userId: user.id, channels, digest, ...(lastDigestAt ? { lastDigestAt } : {}) }, now);
    sendJson(res, 200, preferencesResponse(config, user));
    return;
  }

  if (!id && method === "GET" && (url.searchParams.has("q") || url.searchParams.has("ids"))) {
    const user = requireUser(principal);
    sendJson(res, 200, { users: userDirectory(config, user, principal, url) });
    return;
  }

  if (id === "me" && parts[3] === "rotate-token" && !parts[4] && method === "POST") {
    const user = requireUser(principal);
    requireScope(principal, "admin");
    const token = randomToken("nu");
    const now = config.now().toISOString();
    const updated: CloudUserRecord = { ...user, tokenHash: sha256Hex(token), tokenPreview: tokenPreview(token), updatedAt: now };
    config.store.writeUser(updated);
    const revokedSessions = config.store.revokeUserAuthSessions(user.id, now, principal.auth?.sessionId);
    sendJson(res, 200, { ...selfUser(updated), token, revokedSessions });
    return;
  }

  if (!id && method === "GET") {
    const viewer = requireUser(principal);
    sendJson(res, 200, { users: (await listUsers(config)).map((user) => (user.id === viewer.id ? selfUser(user) : publicUser(user))) });
    return;
  }

  throw new HttpError(404, "Unknown users route");
}

async function listUsers(config: CloudServerConfig): Promise<CloudUserRecord[]> {
  return config.store.listUsers();
}

/**
 * Mention-picker directory: `q` searches users who share a space with the caller; `ids` resolves
 * display names for mentions. `document` narrows to people who can open that page (and lets
 * `ids` resolve anyone with access to it). Only `id` and `name` are returned.
 */
function userDirectory(config: CloudServerConfig, user: CloudUserRecord, principal: Principal, url: URL): Array<{ id: string; name: string }> {
  const documentId = optionalCloudId(url.searchParams.get("document"), "Document");
  if (documentId) {
    const document = config.store.readDocument(documentId);
    if (!document) throw new HttpError(404, "Record not found");
    requireNotTrashed(config, "document", documentId);
    requireRecordAccess(config, document, principal, "viewer");
  }
  const idsParam = url.searchParams.get("ids");
  if (idsParam !== null) {
    const ids = [...new Set(idsParam.split(",").map((value) => value.trim()).filter(Boolean))];
    if (ids.length > 100) throw new HttpError(400, "ids cannot contain more than 100 users");
    for (const id of ids) assertCloudId(id, "User");
    return config.store.userNames(user.id, ids, documentId);
  }
  const q = (url.searchParams.get("q") ?? "").trim().replace(/^@/, "").slice(0, 80);
  const limitText = url.searchParams.get("limit");
  const limit = limitText === null ? 10 : Number(limitText);
  if (!Number.isInteger(limit) || limit < 1 || limit > 50) throw new HttpError(400, "limit must be between 1 and 50");
  return config.store.coMemberUsers(user.id, q, limit, documentId);
}

function preferencesResponse(config: CloudServerConfig, user: CloudUserRecord): Record<string, unknown> {
  const preferences = config.store.notificationPreferences(user.id);
  return {
    channels: preferences.channels,
    digest: preferences.digest,
    lastDigestAt: preferences.lastDigestAt ?? null,
    email: user.email ?? null,
    emailConfigured: Boolean(user.email),
    types: cloudNotificationTypes,
  };
}
