/**
 * Browser auth for the Cloud app: HttpOnly cookie sessions, the CSRF header for mutating requests,
 * one-time migration of legacy localStorage tokens, and explicit personal access token creation.
 */
import { userStorageKey } from "./constants.js";

const csrfCookieName = "noma_csrf";
export const csrfHeaderName = "x-noma-csrf";

let csrfToken: string | undefined;

/** The CSRF token for the current session: the `noma_csrf` cookie, or the one the server last returned. */
export function currentCsrfToken(): string | undefined {
  return readCookie(csrfCookieName) ?? csrfToken;
}

export function rememberCsrfToken(token: string | undefined): void {
  if (token) csrfToken = token;
}

export function forgetCsrfToken(): void {
  csrfToken = undefined;
}

export function isMutatingMethod(method: string | undefined): boolean {
  const normalized = (method ?? "GET").toUpperCase();
  return normalized !== "GET" && normalized !== "HEAD" && normalized !== "OPTIONS";
}

/**
 * Earlier builds kept the raw user token in localStorage. Exchange it once for a cookie session and
 * delete it, whether or not the exchange succeeds, so the token never lingers in page storage.
 */
export async function migrateLegacyStoredToken(): Promise<void> {
  let token: string | undefined;
  try {
    const stored = localStorage.getItem(userStorageKey);
    if (!stored) return;
    const parsed = JSON.parse(stored) as { token?: unknown };
    token = typeof parsed.token === "string" && parsed.token ? parsed.token : undefined;
  } catch {
    token = undefined;
  }
  try {
    if (!token) return;
    const response = await fetch("/api/auth/session", {
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ userToken: token }),
    });
    if (response.ok) {
      const payload = (await response.json()) as { csrfToken?: string };
      rememberCsrfToken(payload.csrfToken);
    }
  } catch {
    return;
  } finally {
    try {
      localStorage.removeItem(userStorageKey);
    } catch {
      /* storage unavailable: nothing to remove */
    }
  }
}

/** A browser sign-in method advertised by `GET /api/auth/providers` (today: native OpenID Connect). */
export interface SignInProvider {
  id: string;
  type: string;
  label: string;
  startUrl: string;
}

/** Sign-in providers the server offers; an empty list when the endpoint is unavailable. */
export async function fetchSignInProviders(): Promise<SignInProvider[]> {
  try {
    const response = await fetch("/api/auth/providers", { credentials: "same-origin", headers: { accept: "application/json" } });
    if (!response.ok) return [];
    const payload = (await response.json()) as { providers?: SignInProvider[] };
    return Array.isArray(payload.providers) ? payload.providers.filter((provider) => typeof provider.startUrl === "string" && provider.startUrl.startsWith("/api/auth/")) : [];
  } catch {
    return [];
  }
}

/** Full-page navigation into the IdP; the server only honours same-origin `returnTo` paths. */
export function signInWithProvider(provider: Pick<SignInProvider, "startUrl">, returnTo: string): void {
  window.location.assign(`${provider.startUrl}?returnTo=${encodeURIComponent(returnTo)}`);
}

function readCookie(name: string): string | undefined {
  for (const part of document.cookie.split(";")) {
    const [key, ...value] = part.trim().split("=");
    if (key === name && value.length > 0) {
      const raw = value.join("=");
      try {
        return decodeURIComponent(raw);
      } catch {
        return raw;
      }
    }
  }
  return undefined;
}
