/**
 * `/api/auth/oidc/{start,callback}` and `/api/auth/providers`: native OpenID Connect login. Maps a
 * verified ID token to a Noma user — (issuer, sub) binding first, then an active SCIM identity whose
 * externalId is the subject, then a verified email, then optional JIT provisioning — and opens the
 * same HttpOnly cookie session as every other browser login.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { CloudUserRecord } from "../cloud-db.js";
import type { ScimIdentity } from "../cloud-platform.js";
import type { CloudServerConfig } from "./context.js";
import { escapeHtml, HttpError, sendJson, sendText, setSecurityHeaders } from "./http.js";
import { constantTimeEqual, oidcFlowCookieName, oidcFlowMaxAgeSeconds, type OidcClient, type OidcIdTokenClaims } from "./oidc.js";
import { createUser } from "./records.js";
import { appendSetCookie, cookieValue, fullTokenScopes, isSecureRequest, requestUrl, startBrowserSession } from "./security.js";

const defaultReturnTo = "/cloud.html";

/** What the login screens need to know: which sign-in methods this deployment offers. */
export function routeAuthProviders(res: ServerResponse, config: CloudServerConfig): void {
  const policy = config.platform.enterprisePolicy();
  const oidc = config.oidc;
  sendJson(res, 200, {
    providers: oidc ? [{ id: "oidc", type: "oidc", label: oidc.settings.label, startUrl: "/api/auth/oidc/start" }] : [],
    tokenLogin: !policy.sso.enforced,
    registration: !policy.sso.enforced,
    sso: { enforced: policy.sso.enforced, provider: policy.sso.provider },
  });
}

export async function routeOidc(req: IncomingMessage, res: ServerResponse, parts: string[], config: CloudServerConfig): Promise<void> {
  const method = req.method ?? "GET";
  const action = parts[3];
  const oidc = config.oidc;
  if (!oidc) throw new HttpError(404, "OpenID Connect login is not configured");
  if (method !== "GET") throw new HttpError(405, "Method not allowed");

  if (action === "start" && !parts[4]) {
    const returnTo = safeReturnTo(requestUrl(req).searchParams.get("returnTo"));
    const { url, flow } = await oidc.authorizationRequest(returnTo);
    appendSetCookie(res, flowCookie(req, oidc.sealFlow(flow), oidcFlowMaxAgeSeconds));
    redirect(res, url);
    return;
  }

  if (action === "callback" && !parts[4]) {
    try {
      const location = await completeLogin(req, res, config, oidc);
      redirect(res, location);
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 502;
      const message = error instanceof HttpError ? error.message : "Sign-in failed";
      res.removeHeader("set-cookie");
      appendSetCookie(res, flowCookie(req, "", 0));
      sendText(res, status, loginErrorPage(message), "text/html; charset=utf-8");
    }
    return;
  }

  throw new HttpError(404, "Unknown OpenID Connect route");
}

async function completeLogin(req: IncomingMessage, res: ServerResponse, config: CloudServerConfig, oidc: OidcClient): Promise<string> {
  const url = requestUrl(req);
  const flow = oidc.openFlow(cookieValue(req, oidcFlowCookieName));
  appendSetCookie(res, flowCookie(req, "", 0));
  const idpError = url.searchParams.get("error");
  if (idpError) throw new HttpError(401, `Identity provider declined the sign-in (${idpError.slice(0, 100).replace(/[^\w.-]/g, "")})`);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  if (!code || !state) throw new HttpError(400, "Sign-in callback is missing code or state");
  if (!flow) throw new HttpError(400, "Sign-in session expired or was started in another browser; start again", { code: "oidc_flow_missing" });
  if (!constantTimeEqual(state, flow.state)) throw new HttpError(400, "Sign-in state does not match; start again", { code: "oidc_state_mismatch" });
  const { idToken } = await oidc.exchangeCode(code, flow.verifier);
  const claims = await oidc.verifyIdToken(idToken, flow.nonce);
  const user = await resolveOidcUser(config, oidc, claims);
  startBrowserSession(config, req, res, user, { source: "oidc", scopes: fullTokenScopes });
  return flow.returnTo;
}

/** Applies policy (SSO enforcement, SCIM, domains, groups) and finds, links or provisions the Noma user. */
export async function resolveOidcUser(config: CloudServerConfig, oidc: OidcClient, claims: OidcIdTokenClaims): Promise<CloudUserRecord> {
  const settings = oidc.settings;
  const issuer = settings.issuer;
  const subject = claims.sub;
  const policy = config.platform.enterprisePolicy();
  if (policy.sso.enforced && policy.sso.provider === "saml") throw new HttpError(403, "Workspace policy requires SAML SSO login");
  if (policy.sso.enforced && policy.sso.provider === "oidc" && policy.sso.issuer && policy.sso.issuer.trim().replace(/\/+$/, "") !== issuer) {
    throw new HttpError(403, "Workspace policy requires a different identity provider");
  }

  const email = typeof claims.email === "string" ? claims.email.trim().toLowerCase() : undefined;
  const emailVerified = claims.email_verified === true || claims.email_verified === "true";
  const verifiedEmail = email && emailVerified && /^[^\s@]+@[^\s@]+$/.test(email) && email.length <= 320 ? email : undefined;
  if (settings.allowedDomains.length > 0) {
    const domain = verifiedEmail?.split("@")[1];
    if (!domain || !settings.allowedDomains.includes(domain)) throw new HttpError(403, "Your email domain is not allowed to sign in to this workspace");
  }
  if (settings.requiredGroup && !claimGroups(claims, settings.groupsClaim).includes(settings.requiredGroup)) {
    throw new HttpError(403, "Your account is not in the group required to sign in to this workspace");
  }

  const scimIdentities: ScimIdentity[] = policy.scim.enabled ? config.platform.listScimIdentities() : [];
  const scimRequired = policy.sso.enforced && policy.scim.enabled;
  const now = config.now().toISOString();

  let user: CloudUserRecord | undefined;
  const binding = config.store.readOidcIdentity(issuer, subject);
  if (binding) user = config.store.readUser(binding.userId);
  if (!user) {
    const scim = scimIdentities.find((identity) => identity.externalId === subject && identity.active);
    if (scim) user = config.store.readUser(scim.userId);
  }
  if (!user && verifiedEmail && settings.linkByEmail) user = linkByEmail(config, issuer, verifiedEmail);
  if (!user) {
    if (scimRequired) throw new HttpError(403, "Workspace policy requires SCIM provisioning before first sign-in");
    if (!settings.autoProvision) throw new HttpError(403, "No Noma account is linked to this identity; ask a workspace admin for access");
    const { record } = await createUser(config, { name: displayName(claims, verifiedEmail) });
    user = verifiedEmail ? { ...record, email: verifiedEmail } : record;
    if (verifiedEmail) config.store.writeUser(user);
  }

  const userScim = scimIdentities.filter((identity) => identity.userId === user.id);
  if (userScim.length > 0 && !userScim.some((identity) => identity.active)) throw new HttpError(403, "This account has been deprovisioned");
  if (scimRequired && !userScim.some((identity) => identity.active)) throw new HttpError(403, "Workspace policy requires an active SCIM identity");

  config.store.upsertOidcIdentity({
    issuer,
    subject,
    userId: user.id,
    ...(verifiedEmail ? { email: verifiedEmail } : {}),
    createdAt: binding?.createdAt ?? now,
    lastLoginAt: now,
  });
  return user;
}

/** Links by verified email only when exactly one user matches and it has no other identity at this issuer. */
function linkByEmail(config: CloudServerConfig, issuer: string, email: string): CloudUserRecord | undefined {
  const matches = config.store.findUsersByEmail(email);
  if (matches.length !== 1) return undefined;
  const candidate = matches[0];
  if (!candidate) return undefined;
  if (config.store.listUserOidcIdentities(candidate.id).some((identity) => identity.issuer === issuer)) {
    throw new HttpError(403, "This email belongs to an account already linked to a different identity");
  }
  return candidate;
}

function claimGroups(claims: OidcIdTokenClaims, claim: string): string[] {
  const value = claims[claim];
  if (typeof value === "string") return [value];
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}

function displayName(claims: OidcIdTokenClaims, email: string | undefined): string {
  for (const candidate of [claims.name, claims.preferred_username, email?.split("@")[0]]) {
    if (typeof candidate === "string" && candidate.trim()) return candidate.trim().slice(0, 80);
  }
  return "Noma collaborator";
}

/** Same-origin path only: rejects absolute, protocol-relative, backslash and control-character targets. */
export function safeReturnTo(value: string | null): string {
  if (!value || value.length > 2000 || !value.startsWith("/") || value.startsWith("//") || /[\\\u0000-\u001f\u007f]/.test(value)) return defaultReturnTo;
  try {
    const base = "http://noma.invalid";
    const parsed = new URL(value, base);
    if (parsed.origin !== base) return defaultReturnTo;
    const path = `${parsed.pathname}${parsed.search}${parsed.hash}`;
    return path.startsWith("/api/") ? defaultReturnTo : path;
  } catch {
    return defaultReturnTo;
  }
}

function flowCookie(req: IncomingMessage, value: string, maxAge: number): string {
  return `${oidcFlowCookieName}=${value}; Path=/api/auth/oidc; HttpOnly; SameSite=Lax; Max-Age=${maxAge}${isSecureRequest(req) ? "; Secure" : ""}`;
}

function redirect(res: ServerResponse, location: string): void {
  res.statusCode = 302;
  setSecurityHeaders(res);
  res.setHeader("location", location);
  res.setHeader("cache-control", "no-store");
  res.end();
}

function loginErrorPage(message: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Sign-in failed</title></head><body><h1>Sign-in failed</h1><p>${escapeHtml(message)}</p><p><a href="/login.html">Back to sign-in</a></p></body></html>\n`;
}
