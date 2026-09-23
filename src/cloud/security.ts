/**
 * Authentication primitives for Noma Cloud: HttpOnly browser sessions with CSRF protection,
 * personal access tokens, token scopes, and paging/quota helpers. Imports only types from
 * `context.ts` so `resolvePrincipal` can call into it without a cycle at runtime.
 */
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { CloudAuthSession, CloudPersonalAccessToken, CloudTokenScope, CloudUserRecord } from "../cloud-db.js";
import { cloudTokenScopes } from "../cloud-db.js";
import type { CloudServerConfig, Principal, PrincipalAuth } from "./context.js";
import { headerValue, HttpError, sha256Hex } from "./http.js";
import { boundedInteger } from "./input.js";

export const sessionCookieName = "noma_session";
export const csrfCookieName = "noma_csrf";
export const csrfHeaderName = "x-noma-csrf";
export const personalAccessTokenPrefix = "noma_pat_";
export const sessionMaxAgeSeconds = 30 * 24 * 60 * 60;
export const maxActivePersonalAccessTokens = 50;
export const fullTokenScopes: CloudTokenScope[] = [...cloudTokenScopes];

const touchIntervalMs = 60_000;
const readOnlyPostPaths = new Set(["/api/db/query"]);

interface ResolvedUser {
  user: CloudUserRecord;
  auth: PrincipalAuth;
}

/** Resolves a bearer credential: a `noma_pat_…` personal access token or a legacy per-user token (full scope). */
export function resolveTokenUser(config: CloudServerConfig, token: string): ResolvedUser | undefined {
  const tokenHash = sha256Hex(token);
  if (!token.startsWith(personalAccessTokenPrefix)) {
    const user = config.store.findUserByToken(tokenHash);
    return user ? { user, auth: { method: "legacy_token", scopes: [...fullTokenScopes] } } : undefined;
  }
  const pat = config.store.findPersonalAccessToken(tokenHash);
  if (!pat) return undefined;
  const now = config.now();
  if (pat.revokedAt) throw new HttpError(401, "Personal access token has been revoked", { code: "token_revoked" });
  if (pat.expiresAt && pat.expiresAt <= now.toISOString()) throw new HttpError(401, "Personal access token has expired", { code: "token_expired" });
  const user = config.store.readUser(pat.userId);
  if (!user) return undefined;
  if (!pat.lastUsedAt || now.getTime() - Date.parse(pat.lastUsedAt) >= touchIntervalMs) {
    config.store.touchPersonalAccessToken(pat.id, now.toISOString());
  }
  return { user, auth: { method: "pat", scopes: impliedScopes(pat.scopes), patId: pat.id } };
}

/** Resolves the `noma_session` cookie to an active session and its user. */
export function resolveSessionUser(config: CloudServerConfig, req: IncomingMessage): ResolvedUser | undefined {
  const secret = cookieValue(req, sessionCookieName);
  if (!secret) return undefined;
  const now = config.now();
  const found = config.store.findAuthSession(sha256Hex(secret), now.toISOString());
  if (!found) return undefined;
  const user = config.store.readUser(found.session.userId);
  if (!user) return undefined;
  if (now.getTime() - Date.parse(found.session.lastSeenAt) >= touchIntervalMs) {
    config.store.touchAuthSession(found.session.id, now.toISOString());
  }
  return {
    user,
    auth: {
      method: "session",
      scopes: impliedScopes(found.session.scopes),
      sessionId: found.session.id,
      ...(found.session.patId ? { patId: found.session.patId } : {}),
      csrfHash: found.csrfHash,
    },
  };
}

/**
 * Request-wide authorization that does not depend on the resource: CSRF for cookie-authenticated
 * mutations, and token scopes (`write` for mutations, `admin` for `/api/enterprise`).
 */
export function enforceRequestAuthorization(req: IncomingMessage, url: URL, principal: Principal): void {
  const auth = principal.auth;
  if (!auth) return;
  const method = req.method ?? "GET";
  const safe = method === "GET" || method === "HEAD" || method === "OPTIONS";
  if (!safe && auth.method === "session") requireCsrfToken(req, auth);
  if (!url.pathname.startsWith("/api/")) return;
  if (!safe && !readOnlyPostPaths.has(url.pathname)) requireScope(principal, "write");
  if (url.pathname === "/api/enterprise" || url.pathname.startsWith("/api/enterprise/")) requireScope(principal, "admin");
}

export function requireScope(principal: Principal, scope: CloudTokenScope): void {
  if (!principal.auth || principal.auth.scopes.includes(scope)) return;
  throw new HttpError(403, `This token lacks the ${scope} scope`, { code: "insufficient_scope", requiredScope: scope });
}

function requireCsrfToken(req: IncomingMessage, auth: PrincipalAuth): void {
  const header = headerValue(req, csrfHeaderName)?.trim();
  if (!header || !auth.csrfHash || !constantTimeEqual(sha256Hex(header), auth.csrfHash)) {
    throw new HttpError(403, `Cookie-authenticated requests must send the ${csrfHeaderName} header`, { code: "csrf_required" });
  }
}

/** `read` is implied by every token; the stored scope list is normalized to the canonical order. */
export function impliedScopes(scopes: CloudTokenScope[]): CloudTokenScope[] {
  return cloudTokenScopes.filter((scope) => scope === "read" || scopes.includes(scope));
}

export function tokenScopesInput(value: unknown): CloudTokenScope[] {
  if (!Array.isArray(value) || value.length === 0) throw new HttpError(400, "scopes must be a non-empty array of read, write, admin");
  const scopes = new Set<CloudTokenScope>();
  for (const item of value) {
    if (item !== "read" && item !== "write" && item !== "admin") throw new HttpError(400, "scopes may only contain read, write, admin");
    scopes.add(item);
  }
  return impliedScopes([...scopes]);
}

export interface BrowserSessionOptions {
  source: CloudAuthSession["source"];
  scopes: CloudTokenScope[];
  patId?: string;
  /** Hard upper bound for the session, e.g. the expiry of the personal access token it was opened with. */
  notAfter?: string;
}

/** Creates a server-side session and sets the HttpOnly session cookie plus the readable CSRF cookie. */
export function startBrowserSession(
  config: CloudServerConfig,
  req: IncomingMessage,
  res: ServerResponse,
  user: CloudUserRecord,
  options: BrowserSessionOptions,
): { session: CloudAuthSession; csrfToken: string } {
  const now = config.now();
  const createdAt = now.toISOString();
  const maxExpiry = new Date(now.getTime() + sessionMaxAgeSeconds * 1000).toISOString();
  const expiresAt = options.notAfter && options.notAfter < maxExpiry ? options.notAfter : maxExpiry;
  const secret = randomBytes(32).toString("base64url");
  const csrfToken = randomBytes(24).toString("base64url");
  const userAgent = headerValue(req, "user-agent")?.slice(0, 300);
  const session: CloudAuthSession = {
    id: randomUUID().replace(/-/g, "").slice(0, 24),
    userId: user.id,
    scopes: impliedScopes(options.scopes),
    source: options.source,
    ...(options.patId ? { patId: options.patId } : {}),
    createdAt,
    lastSeenAt: createdAt,
    expiresAt,
    ...(userAgent ? { userAgent } : {}),
    ip: requestAddress(req, config.trustProxy),
  };
  config.store.purgeAuthSessions(new Date(now.getTime() - sessionMaxAgeSeconds * 1000).toISOString());
  config.store.createAuthSession(session, sha256Hex(secret), sha256Hex(csrfToken));
  const maxAge = Math.max(0, Math.floor((Date.parse(expiresAt) - now.getTime()) / 1000));
  appendSetCookie(res, sessionCookie(req, secret, maxAge));
  appendSetCookie(res, csrfCookie(req, csrfToken, maxAge));
  return { session, csrfToken };
}

/** Returns the CSRF token for the current session, issuing a fresh one when the cookie was lost. */
export function sessionCsrfToken(config: CloudServerConfig, req: IncomingMessage, res: ServerResponse, auth: PrincipalAuth): string {
  const current = cookieValue(req, csrfCookieName);
  if (current && auth.csrfHash && constantTimeEqual(sha256Hex(current), auth.csrfHash)) return current;
  if (!auth.sessionId) throw new HttpError(400, "No browser session");
  const next = randomBytes(24).toString("base64url");
  config.store.setAuthSessionCsrf(auth.sessionId, sha256Hex(next));
  appendSetCookie(res, csrfCookie(req, next, sessionMaxAgeSeconds));
  return next;
}

export function clearBrowserSessionCookies(req: IncomingMessage, res: ServerResponse): void {
  appendSetCookie(res, sessionCookie(req, "", 0));
  appendSetCookie(res, csrfCookie(req, "", 0));
}

/** Session fields safe to show to their owner (no secret or CSRF hashes exist on the record). */
export function publicSession(session: CloudAuthSession, currentId?: string): Record<string, unknown> {
  return { ...session, current: session.id === currentId };
}

export function publicPersonalAccessToken(token: CloudPersonalAccessToken, now: string): Record<string, unknown> {
  return { ...token, active: !token.revokedAt && (!token.expiresAt || token.expiresAt > now) };
}

export function newPersonalAccessToken(): string {
  return `${personalAccessTokenPrefix}${randomBytes(32).toString("base64url")}`;
}

export function requestUrl(req: IncomingMessage): URL {
  return new URL(req.url ?? "/", "http://localhost");
}

/** `limit`/`offset` query parameters for list endpoints. */
export function pageQuery(url: URL, defaultLimit = 100, maxLimit = 500): { limit: number; offset: number } {
  return {
    limit: boundedInteger(integerParam(url.searchParams.get("limit")), defaultLimit, 1, maxLimit, "limit"),
    offset: boundedInteger(integerParam(url.searchParams.get("offset")), 0, 0, 1_000_000, "offset"),
  };
}

function integerParam(value: string | null): number | undefined {
  if (value === null || value === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : Number.NaN;
}

export function requestAddress(req: IncomingMessage, trustProxy: boolean): string {
  if (trustProxy) {
    const forwarded = headerValue(req, "x-forwarded-for")?.split(",")[0]?.trim();
    if (forwarded) return forwarded;
  }
  return req.socket.remoteAddress ?? "unknown";
}

export function isSecureRequest(req: IncomingMessage): boolean {
  const forwardedProto = headerValue(req, "x-forwarded-proto");
  const host = headerValue(req, "host") ?? "";
  return forwardedProto === "https" || (!host.startsWith("127.0.0.1") && !host.startsWith("localhost") && !host.startsWith("[::1]"));
}

export function cookieValue(req: IncomingMessage, name: string): string | undefined {
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

/** Adds a `Set-Cookie` header without dropping cookies already set on the response. */
export function appendSetCookie(res: ServerResponse, cookie: string): void {
  const existing = res.getHeader("set-cookie");
  const cookies = existing === undefined ? [] : Array.isArray(existing) ? existing : [String(existing)];
  res.setHeader("set-cookie", [...cookies, cookie]);
}

function sessionCookie(req: IncomingMessage, value: string, maxAge: number): string {
  return `${sessionCookieName}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${isSecureRequest(req) ? "; Secure" : ""}`;
}

function csrfCookie(req: IncomingMessage, value: string, maxAge: number): string {
  return `${csrfCookieName}=${value}; Path=/; SameSite=Lax; Max-Age=${maxAge}${isSecureRequest(req) ? "; Secure" : ""}`;
}

function constantTimeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}
