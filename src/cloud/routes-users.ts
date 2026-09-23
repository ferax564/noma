/** `/api/users`. */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { CloudUserRecord } from "../cloud-db.js";
import { type CloudServerConfig, type Principal, randomToken, requireUser, tokenPreview } from "./context.js";
import { HttpError, readJsonBody, sendJson, sha256Hex } from "./http.js";
import { createUser, publicUser, selfUser } from "./records.js";
import { requireInvitationCode } from "./routes-auth.js";
import { requireScope } from "./security.js";

export async function routeUsers(
  req: IncomingMessage,
  res: ServerResponse,
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
