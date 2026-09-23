/** Access-gate token/cookie handling, invitation codes, and `/api/auth/*`. */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { CloudUserRecord } from "../cloud-db.js";
import { type CloudServerConfig, findUserByToken, randomToken, tokenPreview } from "./context.js";
import { headerValue, HttpError, readJsonBody, sendJson, sendText, setSecurityHeaders, sha256Hex } from "./http.js";
import { optionalString, stringInput } from "./input.js";
import { createUser, publicUser } from "./records.js";

const cloudAccessCookieName = "noma_cloud_access";

export function requiresCloudAccess(pathname: string): boolean {
  return (
    (pathname.startsWith("/api/") && !pathname.startsWith("/api/auth/")) ||
    isCloudAppShell(pathname) ||
    pathname === "/assets/cloud-app.js" ||
    pathname === "/assets/cloud.css" ||
    pathname === "/assets/workbench.js" ||
    pathname === "/assets/workbench.css"
  );
}

export function isCloudAppShell(pathname: string): boolean {
  return pathname === "/cloud" || pathname === "/cloud.html" || pathname === "/workbench" || pathname === "/workbench.html";
}

export function resolveCloudAccess(
  config: CloudServerConfig,
  req: IncomingMessage,
  url: URL,
): { ok: true; via: "open" | "query" | "header" | "cookie"; token: string } | { ok: false } {
  if (!config.accessTokenHash) return { ok: true, via: "open", token: "" };

  const queryToken = url.searchParams.get("access");
  if (queryToken !== null) {
    return tokenMatches(config, queryToken) ? { ok: true, via: "query", token: queryToken } : { ok: false };
  }

  const headerToken = headerValue(req, "x-noma-cloud-access-token");
  if (headerToken && tokenMatches(config, headerToken)) return { ok: true, via: "header", token: headerToken };

  const cookieToken = cookieValue(req, cloudAccessCookieName);
  if (cookieToken && tokenMatches(config, cookieToken)) return { ok: true, via: "cookie", token: cookieToken };

  return { ok: false };
}

function requireCloudAccessToken(config: CloudServerConfig, req: IncomingMessage, input: Record<string, unknown>): string {
  const rawBodyToken = input.accessToken;
  if (rawBodyToken !== undefined && typeof rawBodyToken !== "string") {
    throw new HttpError(400, "accessToken must be a string");
  }

  const bodyToken = optionalString(rawBodyToken);
  if (bodyToken) {
    if (config.accessTokenHash && !tokenMatches(config, bodyToken)) throw new HttpError(401, "Invalid Noma Cloud access token");
    return bodyToken;
  }

  const headerToken = headerValue(req, "x-noma-cloud-access-token");
  if (headerToken && (!config.accessTokenHash || tokenMatches(config, headerToken))) return headerToken;

  const cookieToken = cookieValue(req, cloudAccessCookieName);
  if (cookieToken && (!config.accessTokenHash || tokenMatches(config, cookieToken))) return cookieToken;

  if (!config.accessTokenHash) return "";
  throw new HttpError(400, "Cloud access token is required");
}

function tokenMatches(config: CloudServerConfig, token: string): boolean {
  return sha256Hex(token.trim()) === config.accessTokenHash;
}

export async function routeAuth(req: IncomingMessage, res: ServerResponse, parts: string[], config: CloudServerConfig): Promise<void> {
  const method = req.method ?? "GET";
  const action = parts[2];

  if (action === "session" && method === "POST") {
    if (config.platform.enterprisePolicy().sso.enforced) throw new HttpError(403, "Workspace policy requires SSO login");
    const input = await readJsonBody(req, config.maxBodyBytes);
    const accessToken = requireCloudAccessToken(config, req, input);
    const userToken = optionalString(input.userToken);
    const user = userToken ? await findUserByToken(config, sha256Hex(userToken)) : undefined;
    if (userToken && !user) throw new HttpError(401, "Invalid Noma user token");
    setCloudAccessCookie(req, res, accessToken);
    sendJson(res, 200, {
      ok: true,
      user: user ? { ...publicUser(user), token: userToken } : undefined,
    });
    return;
  }

  if (action === "register" && method === "POST") {
    if (config.platform.enterprisePolicy().sso.enforced) throw new HttpError(403, "Workspace policy requires SCIM provisioning and SSO login");
    const input = await readJsonBody(req, config.maxBodyBytes);
    const accessToken = requireCloudAccessToken(config, req, input);
    requireInvitationCode(config, req, input);
    const { record, token } = await createUser(config, input);
    setCloudAccessCookie(req, res, accessToken);
    sendJson(res, 201, {
      ok: true,
      user: { ...publicUser(record), token },
    });
    return;
  }

  if (action === "sso" && method === "POST") {
    const policy = config.platform.enterprisePolicy();
    if (!policy.sso.enabled || policy.sso.provider === "none") throw new HttpError(404, "SSO is not enabled");
    if (!config.ssoTrustedHeaderHash) throw new HttpError(503, "SSO trust secret is not configured");
    const trustSecret = headerValue(req, "x-noma-sso-trust-secret");
    if (!trustSecret || sha256Hex(trustSecret) !== config.ssoTrustedHeaderHash) throw new HttpError(401, "Trusted SSO assertion required");
    const input = await readJsonBody(req, config.maxBodyBytes);
    const externalId = stringInput(input, "externalId");
    const identity = config.platform.listScimIdentities().find((item) => item.externalId === externalId && item.active);
    if (!identity) throw new HttpError(403, "Active SCIM identity not found");
    const user = config.store.readUser(identity.userId);
    if (!user) throw new HttpError(404, "Provisioned Noma user not found");
    const token = randomToken("noma");
    const updated: CloudUserRecord = { ...user, tokenHash: sha256Hex(token), tokenPreview: tokenPreview(token), updatedAt: config.now().toISOString() };
    config.store.writeUser(updated);
    sendJson(res, 200, { ok: true, provider: policy.sso.provider, user: { ...publicUser(updated), token } });
    return;
  }

  throw new HttpError(404, "Unknown auth route");
}

export function requireInvitationCode(config: CloudServerConfig, req: IncomingMessage, input: Record<string, unknown>): void {
  if (!config.invitationCodeHash) return;
  const code = optionalString(input.invitationCode) ?? headerValue(req, "x-noma-cloud-invitation-code");
  if (!code || sha256Hex(code.trim()) !== config.invitationCodeHash) {
    throw new HttpError(403, "Valid invitation code required");
  }
}

export function sendCloudAccessDenied(res: ServerResponse, url: URL): void {
  if (url.pathname.startsWith("/api/")) {
    sendJson(res, 401, { error: "Noma Cloud access token required" });
    return;
  }
  if (isCloudAppShell(url.pathname)) {
    redirectToLogin(res, url);
    return;
  }
  sendText(
    res,
    401,
    "Noma Cloud access token required. Open the cloud app with ?access=<token> once, or send X-Noma-Cloud-Access-Token for API requests.\n",
    "text/plain; charset=utf-8",
  );
}

export function redirectWithCloudAccessCookie(req: IncomingMessage, res: ServerResponse, url: URL, token: string): void {
  const next = new URL(url.toString());
  next.searchParams.delete("access");
  const location = `${next.pathname}${next.search}`;
  res.statusCode = 302;
  setSecurityHeaders(res);
  res.setHeader("location", location || url.pathname);
  res.setHeader("set-cookie", cloudAccessCookie(req, token));
  res.setHeader("cache-control", "no-store");
  res.end();
}

function redirectToLogin(res: ServerResponse, url: URL): void {
  const next = `${url.pathname}${url.search}`;
  const location = `/login.html?next=${encodeURIComponent(next)}`;
  res.statusCode = 302;
  setSecurityHeaders(res);
  res.setHeader("location", location);
  res.setHeader("cache-control", "no-store");
  res.end();
}

function setCloudAccessCookie(req: IncomingMessage, res: ServerResponse, token: string): void {
  res.setHeader("set-cookie", cloudAccessCookie(req, token));
}

function cloudAccessCookie(req: IncomingMessage, token: string): string {
  const secure = isSecureRequest(req) ? "; Secure" : "";
  return `${cloudAccessCookieName}=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=2592000${secure}`;
}

function isSecureRequest(req: IncomingMessage): boolean {
  const forwardedProto = headerValue(req, "x-forwarded-proto");
  const host = headerValue(req, "host") ?? "";
  return forwardedProto === "https" || (!host.startsWith("127.0.0.1") && !host.startsWith("localhost"));
}

function cookieValue(req: IncomingMessage, name: string): string | undefined {
  const header = headerValue(req, "cookie");
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const [rawKey, ...rawValue] = part.trim().split("=");
    if (rawKey === name) {
      try {
        return decodeURIComponent(rawValue.join("="));
      } catch {
        return rawValue.join("=");
      }
    }
  }
  return undefined;
}
