/** `/api/users`. */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { CloudUserRecord } from "../cloud-db.js";
import { type CloudServerConfig, type Principal, requireNotTrashed, requireRecordAccess, requireUser } from "./context.js";
import { HttpError, readJsonBody, sendJson } from "./http.js";
import { assertCloudId, optionalCloudId } from "./input.js";
import { createUser, publicUser } from "./records.js";
import { requireInvitationCode } from "./routes-auth.js";

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
    sendJson(res, 201, { ...publicUser(record), token });
    return;
  }

  if (id === "me" && method === "GET") {
    const user = requireUser(principal);
    sendJson(res, 200, publicUser(user));
    return;
  }

  if (!id && method === "GET" && (url.searchParams.has("q") || url.searchParams.has("ids"))) {
    const user = requireUser(principal);
    sendJson(res, 200, { users: userDirectory(config, user, principal, url) });
    return;
  }

  if (!id && method === "GET") {
    requireUser(principal);
    sendJson(res, 200, { users: (await listUsers(config)).map(publicUser) });
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

