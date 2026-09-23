/** `/api/users`. */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { CloudUserRecord } from "../cloud-db.js";
import { type CloudServerConfig, type Principal, requireUser } from "./context.js";
import { HttpError, readJsonBody, sendJson } from "./http.js";
import { createUser, publicUser } from "./records.js";
import { requireInvitationCode } from "./routes-auth.js";

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
    sendJson(res, 201, { ...publicUser(record), token });
    return;
  }

  if (id === "me" && method === "GET") {
    const user = requireUser(principal);
    sendJson(res, 200, publicUser(user));
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
