/** Browser-session management under `/api/auth/`: current session, session list/revoke, logout. */
import type { IncomingMessage, ServerResponse } from "node:http";
import { type CloudServerConfig, requireUser, resolvePrincipal } from "./context.js";
import { HttpError, sendJson } from "./http.js";
import { assertCloudId, stringPathPart } from "./input.js";
import { selfUser } from "./records.js";
import { clearBrowserSessionCookies, enforceRequestAuthorization, pageQuery, publicSession, requestUrl, sessionCsrfToken } from "./security.js";

export async function routeAuthSessions(req: IncomingMessage, res: ServerResponse, parts: string[], config: CloudServerConfig): Promise<void> {
  const method = req.method ?? "GET";
  const action = parts[2];
  const url = requestUrl(req);
  const principal = await resolvePrincipal(config, req, url);
  enforceRequestAuthorization(req, url, principal);
  const now = config.now().toISOString();

  if (action === "session" && method === "GET" && !parts[3]) {
    if (!principal.user || !principal.auth) {
      sendJson(res, 200, { authenticated: false });
      return;
    }
    const auth = principal.auth;
    sendJson(res, 200, {
      authenticated: true,
      method: auth.method,
      scopes: auth.scopes,
      user: selfUser(principal.user),
      ...(auth.method === "session" ? { sessionId: auth.sessionId, csrfToken: sessionCsrfToken(config, req, res, auth) } : {}),
    });
    return;
  }

  if (action === "sessions" && method === "GET" && !parts[3]) {
    const user = requireUser(principal);
    const page = pageQuery(url, 50, 200);
    const sessions = config.store.listAuthSessions(user.id, now, page.limit, page.offset);
    sendJson(res, 200, { sessions: sessions.map((session) => publicSession(session, principal.auth?.sessionId)), ...page });
    return;
  }

  if (action === "sessions" && method === "DELETE" && parts[3] && !parts[4]) {
    const user = requireUser(principal);
    const sessionId = stringPathPart(parts[3], "Session ID");
    assertCloudId(sessionId, "Session");
    if (!config.store.revokeAuthSession(user.id, sessionId, now)) throw new HttpError(404, "Session not found");
    if (principal.auth?.sessionId === sessionId) clearBrowserSessionCookies(req, res);
    sendJson(res, 200, { ok: true, revoked: sessionId });
    return;
  }

  if (action === "logout" && method === "POST" && !parts[3]) {
    const auth = principal.auth;
    if (principal.user && auth?.method === "session" && auth.sessionId) config.store.revokeAuthSession(principal.user.id, auth.sessionId, now);
    clearBrowserSessionCookies(req, res);
    sendJson(res, 200, { ok: true });
    return;
  }

  throw new HttpError(404, "Unknown auth route");
}
