/** `/api/tokens`: named, scoped, expiring personal access tokens. */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { CloudPersonalAccessToken } from "../cloud-db.js";
import { type CloudServerConfig, type Principal, randomId, requireUser, tokenPreview } from "./context.js";
import { HttpError, readJsonBody, sendJson, sha256Hex } from "./http.js";
import { assertCloudId, boundedInteger, optionalString } from "./input.js";
import {
  maxActivePersonalAccessTokens,
  newPersonalAccessToken,
  pageQuery,
  publicPersonalAccessToken,
  requireScope,
  tokenScopesInput,
} from "./security.js";

export async function routeTokens(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  parts: string[],
  config: CloudServerConfig,
  principal: Principal,
): Promise<void> {
  const user = requireUser(principal);
  const method = req.method ?? "GET";
  const tokenId = parts[2];
  const now = config.now();

  if (!tokenId && method === "GET") {
    const page = pageQuery(url, 50, 200);
    const tokens = config.store.listPersonalAccessTokens(user.id, page.limit, page.offset);
    sendJson(res, 200, { tokens: tokens.map((token) => publicPersonalAccessToken(token, now.toISOString())), ...page });
    return;
  }

  if (!tokenId && method === "POST") {
    const input = await readJsonBody(req, config.maxBodyBytes);
    const name = optionalString(input.name);
    if (!name) throw new HttpError(400, "name is required");
    const scopes = tokenScopesInput(input.scopes);
    for (const scope of scopes) requireScope(principal, scope);
    const expiresInDays = input.expiresInDays === undefined || input.expiresInDays === null
      ? undefined
      : boundedInteger(input.expiresInDays, 90, 1, 365, "expiresInDays");
    if (config.store.countActivePersonalAccessTokens(user.id, now.toISOString()) >= maxActivePersonalAccessTokens) {
      throw new HttpError(429, `A user can hold at most ${maxActivePersonalAccessTokens} active personal access tokens`, {
        code: "token_quota_exceeded",
        limit: maxActivePersonalAccessTokens,
      });
    }
    const token = newPersonalAccessToken();
    const record: CloudPersonalAccessToken = {
      id: randomId(),
      userId: user.id,
      name: name.slice(0, 80),
      tokenPreview: tokenPreview(token),
      scopes,
      createdAt: now.toISOString(),
      ...(expiresInDays ? { expiresAt: new Date(now.getTime() + expiresInDays * 86_400_000).toISOString() } : {}),
    };
    config.store.createPersonalAccessToken(record, sha256Hex(token));
    sendJson(res, 201, { ...publicPersonalAccessToken(record, now.toISOString()), token });
    return;
  }

  if (tokenId && !parts[3] && method === "DELETE") {
    assertCloudId(tokenId, "Token");
    if (!config.store.revokePersonalAccessToken(user.id, tokenId, now.toISOString())) throw new HttpError(404, "Token not found");
    sendJson(res, 200, { ok: true, revoked: tokenId });
    return;
  }

  throw new HttpError(404, "Unknown tokens route");
}
