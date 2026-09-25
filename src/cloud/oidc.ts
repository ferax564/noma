/**
 * Native OpenID Connect relying party for Noma Cloud, dependency-free (node:crypto + fetch):
 * discovery and JWKS caching, the authorization-code flow with PKCE (S256), `state` + `nonce`,
 * an encrypted short-lived flow cookie, the token endpoint call (client_secret_basic or
 * client_secret_post), and ID-token verification (RS*, PS*, ES* only). Account mapping and routes
 * live in `routes-oidc.ts`.
 */
import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createPublicKey,
  hkdfSync,
  type JsonWebKey,
  type KeyObject,
  randomBytes,
  timingSafeEqual,
  verify as verifySignature,
  constants as cryptoConstants,
} from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { HttpError } from "./http.js";

export type OidcTokenEndpointAuthMethod = "client_secret_basic" | "client_secret_post";

/** Programmatic OIDC settings; anything left unset falls back to the `NOMA_CLOUD_OIDC_*` environment. */
export interface NomaCloudOidcOptions {
  issuer?: string;
  clientId?: string;
  clientSecret?: string;
  clientSecretFile?: string;
  /** Absolute callback URL registered at the IdP; defaults to `NOMA_CLOUD_PUBLIC_URL` + `/api/auth/oidc/callback`. */
  redirectUrl?: string;
  scopes?: string[];
  /** Verified email domains allowed to sign in; empty allows any. */
  allowedDomains?: string[];
  /** Create a Noma user on first login when no binding, SCIM identity, or verified email matches. */
  autoProvision?: boolean;
  /** Link a first login to an existing user by verified email (default false: Noma profile emails are self-asserted). */
  linkByEmail?: boolean;
  /** Group that must appear in the groups claim. */
  requiredGroup?: string;
  /** Claim that carries group names (default `groups`). */
  groupsClaim?: string;
  /** Button label, e.g. "Okta" renders "Sign in with Okta". */
  label?: string;
  tokenEndpointAuthMethod?: OidcTokenEndpointAuthMethod;
  /** HTTP timeout for discovery, JWKS and token calls (default 10 s). */
  timeoutMs?: number;
  /** Allowed clock skew for exp/iat/nbf (default 60 s). */
  clockSkewSeconds?: number;
  discoveryTtlMs?: number;
  jwksTtlMs?: number;
  /** Minimum gap between JWKS refreshes triggered by an unknown `kid` (default 60 s). */
  jwksMinRefreshMs?: number;
  /** Injected for tests. */
  fetch?: typeof fetch;
}

export interface OidcSettings {
  issuer: string;
  clientId: string;
  clientSecret: string;
  redirectUrl: string;
  scopes: string[];
  allowedDomains: string[];
  autoProvision: boolean;
  linkByEmail: boolean;
  requiredGroup?: string;
  groupsClaim: string;
  label: string;
  tokenEndpointAuthMethod?: OidcTokenEndpointAuthMethod;
  timeoutMs: number;
  clockSkewSeconds: number;
  discoveryTtlMs: number;
  jwksTtlMs: number;
  jwksMinRefreshMs: number;
}

export interface OidcDiscovery {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  token_endpoint_auth_methods_supported?: string[];
}

/** What the flow cookie carries between `/start` and `/callback`. */
export interface OidcFlowState {
  state: string;
  nonce: string;
  verifier: string;
  returnTo: string;
  expiresAt: number;
}

export interface OidcIdTokenClaims extends Record<string, unknown> {
  iss: string;
  sub: string;
}

export const oidcFlowCookieName = "noma_oidc_flow";
export const oidcFlowMaxAgeSeconds = 600;
export const oidcCallbackPath = "/api/auth/oidc/callback";

const maxDiscoveryBytes = 64 * 1024;
const maxJwksBytes = 256 * 1024;
const maxTokenResponseBytes = 256 * 1024;
const maxIdTokenLength = 64 * 1024;

const signatureAlgorithms: Record<string, { kty: "RSA" | "EC"; hash: string; pss?: boolean; crv?: string }> = {
  RS256: { kty: "RSA", hash: "sha256" },
  RS384: { kty: "RSA", hash: "sha384" },
  RS512: { kty: "RSA", hash: "sha512" },
  PS256: { kty: "RSA", hash: "sha256", pss: true },
  PS384: { kty: "RSA", hash: "sha384", pss: true },
  PS512: { kty: "RSA", hash: "sha512", pss: true },
  ES256: { kty: "EC", hash: "sha256", crv: "P-256" },
  ES384: { kty: "EC", hash: "sha384", crv: "P-384" },
  ES512: { kty: "EC", hash: "sha512", crv: "P-521" },
};

const envNames = [
  "NOMA_CLOUD_OIDC_ISSUER",
  "NOMA_CLOUD_OIDC_CLIENT_ID",
  "NOMA_CLOUD_OIDC_CLIENT_SECRET",
  "NOMA_CLOUD_OIDC_CLIENT_SECRET_FILE",
  "NOMA_CLOUD_OIDC_REDIRECT_URL",
  "NOMA_CLOUD_OIDC_SCOPES",
  "NOMA_CLOUD_OIDC_ALLOWED_DOMAINS",
  "NOMA_CLOUD_OIDC_AUTO_PROVISION",
  "NOMA_CLOUD_OIDC_LINK_BY_EMAIL",
  "NOMA_CLOUD_OIDC_REQUIRED_GROUP",
  "NOMA_CLOUD_OIDC_GROUPS_CLAIM",
  "NOMA_CLOUD_OIDC_LABEL",
  "NOMA_CLOUD_OIDC_TOKEN_AUTH_METHOD",
] as const;

/**
 * Resolves OIDC settings from options and the environment. Returns `undefined` when nothing is
 * configured (or `options` is `null`), and throws on partial or invalid configuration so a
 * misconfigured deployment fails at startup rather than at the first login.
 */
export function resolveOidcSettings(options: NomaCloudOidcOptions | null | undefined, env: NodeJS.ProcessEnv = process.env): OidcSettings | undefined {
  if (options === null) return undefined;
  const opts = options ?? {};
  const read = (name: (typeof envNames)[number]): string | undefined => clean(env[name]);
  const touched = Object.keys(opts).some((key) => key !== "fetch" && opts[key as keyof NomaCloudOidcOptions] !== undefined) || envNames.some((name) => read(name) !== undefined);
  if (!touched) return undefined;

  const issuerInput = clean(opts.issuer) ?? read("NOMA_CLOUD_OIDC_ISSUER");
  const clientId = clean(opts.clientId) ?? read("NOMA_CLOUD_OIDC_CLIENT_ID");
  const clientSecret = readClientSecret(opts, read);
  const publicUrl = clean(env.NOMA_CLOUD_PUBLIC_URL)?.replace(/\/+$/, "");
  const redirectInput = clean(opts.redirectUrl) ?? read("NOMA_CLOUD_OIDC_REDIRECT_URL") ?? (publicUrl ? `${publicUrl}${oidcCallbackPath}` : undefined);
  const missing = [
    issuerInput ? undefined : "NOMA_CLOUD_OIDC_ISSUER",
    clientId ? undefined : "NOMA_CLOUD_OIDC_CLIENT_ID",
    clientSecret ? undefined : "NOMA_CLOUD_OIDC_CLIENT_SECRET (or _FILE)",
    redirectInput ? undefined : "NOMA_CLOUD_OIDC_REDIRECT_URL (or NOMA_CLOUD_PUBLIC_URL)",
  ].filter((item): item is string => item !== undefined);
  if (missing.length > 0 || !issuerInput || !clientId || !clientSecret || !redirectInput) {
    throw new Error(`Incomplete OpenID Connect configuration; missing ${missing.join(", ")}`);
  }

  const issuer = normalizeIssuer(issuerInput);
  requireSafeUrl(issuer, "NOMA_CLOUD_OIDC_ISSUER");
  const redirectUrl = requireSafeUrl(redirectInput, "NOMA_CLOUD_OIDC_REDIRECT_URL");
  const scopes = unique(["openid", ...(opts.scopes ?? splitList(read("NOMA_CLOUD_OIDC_SCOPES") ?? "openid email profile"))]);
  const allowedDomains = unique((opts.allowedDomains ?? splitList(read("NOMA_CLOUD_OIDC_ALLOWED_DOMAINS") ?? "")).map((domain) => domain.toLowerCase().replace(/^@/, "")));
  const tokenEndpointAuthMethod = opts.tokenEndpointAuthMethod ?? tokenAuthMethod(read("NOMA_CLOUD_OIDC_TOKEN_AUTH_METHOD"));
  const requiredGroup = clean(opts.requiredGroup) ?? read("NOMA_CLOUD_OIDC_REQUIRED_GROUP");
  return {
    issuer,
    clientId,
    clientSecret,
    redirectUrl,
    scopes,
    allowedDomains,
    autoProvision: opts.autoProvision ?? flag(read("NOMA_CLOUD_OIDC_AUTO_PROVISION"), false),
    linkByEmail: opts.linkByEmail ?? flag(read("NOMA_CLOUD_OIDC_LINK_BY_EMAIL"), false),
    ...(requiredGroup ? { requiredGroup } : {}),
    groupsClaim: clean(opts.groupsClaim) ?? read("NOMA_CLOUD_OIDC_GROUPS_CLAIM") ?? "groups",
    label: (clean(opts.label) ?? read("NOMA_CLOUD_OIDC_LABEL") ?? "SSO").slice(0, 60),
    ...(tokenEndpointAuthMethod ? { tokenEndpointAuthMethod } : {}),
    timeoutMs: positive(opts.timeoutMs ?? 10_000, "oidc.timeoutMs"),
    clockSkewSeconds: nonNegative(opts.clockSkewSeconds ?? 60, "oidc.clockSkewSeconds"),
    discoveryTtlMs: nonNegative(opts.discoveryTtlMs ?? 3_600_000, "oidc.discoveryTtlMs"),
    jwksTtlMs: nonNegative(opts.jwksTtlMs ?? 3_600_000, "oidc.jwksTtlMs"),
    jwksMinRefreshMs: nonNegative(opts.jwksMinRefreshMs ?? 60_000, "oidc.jwksMinRefreshMs"),
  };
}

/** Issuer identifiers are compared exactly; only a trailing slash is normalized away. */
export function normalizeIssuer(value: string): string {
  return value.trim().replace(/\/+$/, "");
}

interface CachedValue<T> {
  value: T;
  fetchedAt: number;
}

/** Stateless-per-login OIDC client; discovery and JWKS are cached per instance. */
export class OidcClient {
  private discoveryCache?: CachedValue<OidcDiscovery>;
  private discoveryInFlight?: Promise<OidcDiscovery>;
  private jwksCache?: CachedValue<JsonWebKey[]>;
  private jwksInFlight?: Promise<JsonWebKey[]>;
  private readonly flowKey: Buffer;

  constructor(
    readonly settings: OidcSettings,
    private readonly now: () => Date = () => new Date(),
    private readonly fetchImpl: typeof fetch = (input, init) => fetch(input, init),
  ) {
    this.flowKey = Buffer.from(hkdfSync("sha256", settings.clientSecret, settings.issuer, "noma-oidc-flow-cookie-v1", 32));
  }

  async discovery(): Promise<OidcDiscovery> {
    const nowMs = this.now().getTime();
    if (this.discoveryCache && nowMs - this.discoveryCache.fetchedAt < this.settings.discoveryTtlMs) return this.discoveryCache.value;
    this.discoveryInFlight ??= this.fetchDiscovery().finally(() => {
      this.discoveryInFlight = undefined;
    });
    return this.discoveryInFlight;
  }

  /** Builds the IdP authorization URL and the flow state to seal into the flow cookie. */
  async authorizationRequest(returnTo: string): Promise<{ url: string; flow: OidcFlowState }> {
    const discovery = await this.discovery();
    const flow: OidcFlowState = {
      state: randomBytes(32).toString("base64url"),
      nonce: randomBytes(32).toString("base64url"),
      verifier: randomBytes(48).toString("base64url"),
      returnTo,
      expiresAt: this.now().getTime() + oidcFlowMaxAgeSeconds * 1000,
    };
    const url = new URL(discovery.authorization_endpoint);
    url.searchParams.set("response_type", "code");
    url.searchParams.set("client_id", this.settings.clientId);
    url.searchParams.set("redirect_uri", this.settings.redirectUrl);
    url.searchParams.set("scope", this.settings.scopes.join(" "));
    url.searchParams.set("state", flow.state);
    url.searchParams.set("nonce", flow.nonce);
    url.searchParams.set("code_challenge", pkceChallenge(flow.verifier));
    url.searchParams.set("code_challenge_method", "S256");
    return { url: url.toString(), flow };
  }

  /** Exchanges an authorization code (with the PKCE verifier) for the raw ID token. */
  async exchangeCode(code: string, verifier: string): Promise<{ idToken: string }> {
    const discovery = await this.discovery();
    const method = this.tokenAuthMethod(discovery);
    const body = new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: this.settings.redirectUrl, code_verifier: verifier });
    const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded", accept: "application/json" };
    if (method === "client_secret_basic") {
      const credentials = `${formUrlEncode(this.settings.clientId)}:${formUrlEncode(this.settings.clientSecret)}`;
      headers.authorization = `Basic ${Buffer.from(credentials).toString("base64")}`;
    } else {
      body.set("client_id", this.settings.clientId);
      body.set("client_secret", this.settings.clientSecret);
    }
    const { status, payload } = await this.fetchJson(discovery.token_endpoint, { method: "POST", headers, body: body.toString() }, maxTokenResponseBytes, true);
    if (status < 200 || status >= 300) {
      const reason = typeof payload.error === "string" ? payload.error.slice(0, 100).replace(/[^\w.-]/g, "") : `HTTP ${status}`;
      throw new HttpError(401, `Identity provider rejected the authorization code (${reason})`);
    }
    const idToken = payload.id_token;
    if (typeof idToken !== "string" || !idToken) throw new HttpError(502, "Identity provider token response has no id_token");
    return { idToken };
  }

  /**
   * Verifies the ID token signature against the IdP JWKS (refreshing once on an unknown `kid`) and
   * checks iss, aud/azp, exp, iat, nbf and nonce.
   */
  async verifyIdToken(idToken: string, expectedNonce: string): Promise<OidcIdTokenClaims> {
    if (idToken.length > maxIdTokenLength) throw invalidToken("ID token is too large");
    const segments = idToken.split(".");
    if (segments.length !== 3) throw invalidToken("ID token is not a compact JWS");
    const [encodedHeader = "", encodedPayload = "", encodedSignature = ""] = segments;
    const header = decodeSegment(encodedHeader, "header");
    const claims = decodeSegment(encodedPayload, "payload");
    const alg = typeof header.alg === "string" ? header.alg : "";
    const spec = signatureAlgorithms[alg];
    if (!spec) throw invalidToken(`ID token algorithm ${alg || "(missing)"} is not accepted`);
    if (header.crit !== undefined) throw invalidToken("ID token uses unsupported critical header parameters");
    const kid = typeof header.kid === "string" ? header.kid : undefined;
    const signature = Buffer.from(encodedSignature, "base64url");
    const key = await this.signingKey(alg, kid);
    const data = Buffer.from(`${encodedHeader}.${encodedPayload}`);
    const verified = spec.kty === "EC"
      ? verifySignature(spec.hash, data, { key, dsaEncoding: "ieee-p1363" }, signature)
      : spec.pss
        ? verifySignature(spec.hash, data, { key, padding: cryptoConstants.RSA_PKCS1_PSS_PADDING, saltLength: cryptoConstants.RSA_PSS_SALTLEN_DIGEST }, signature)
        : verifySignature(spec.hash, data, key, signature);
    if (!verified) throw invalidToken("ID token signature is invalid");
    this.checkClaims(claims, expectedNonce, (await this.discovery()).issuer);
    return claims as OidcIdTokenClaims;
  }

  /** Encrypts (AES-256-GCM) the flow state for the short-lived flow cookie. */
  sealFlow(flow: OidcFlowState): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", this.flowKey, iv);
    cipher.setAAD(Buffer.from(oidcFlowCookieName));
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(flow), "utf8"), cipher.final()]);
    return Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString("base64url");
  }

  /** Decrypts and validates a flow cookie; `undefined` when missing, tampered with, or expired. */
  openFlow(value: string | undefined): OidcFlowState | undefined {
    if (!value || value.length > 4096) return undefined;
    try {
      const raw = Buffer.from(value, "base64url");
      if (raw.length < 29) return undefined;
      const decipher = createDecipheriv("aes-256-gcm", this.flowKey, raw.subarray(0, 12));
      decipher.setAAD(Buffer.from(oidcFlowCookieName));
      decipher.setAuthTag(raw.subarray(12, 28));
      const plain = Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString("utf8");
      const flow = JSON.parse(plain) as Partial<OidcFlowState>;
      if (
        typeof flow.state !== "string" ||
        typeof flow.nonce !== "string" ||
        typeof flow.verifier !== "string" ||
        typeof flow.returnTo !== "string" ||
        typeof flow.expiresAt !== "number" ||
        flow.expiresAt <= this.now().getTime()
      ) {
        return undefined;
      }
      return flow as OidcFlowState;
    } catch {
      return undefined;
    }
  }

  private checkClaims(claims: Record<string, unknown>, expectedNonce: string, issuer: string): void {
    const skew = this.settings.clockSkewSeconds;
    const nowSeconds = Math.floor(this.now().getTime() / 1000);
    if (claims.iss !== issuer) throw invalidToken("ID token issuer does not match");
    const audience = typeof claims.aud === "string" ? [claims.aud] : Array.isArray(claims.aud) ? claims.aud.filter((item): item is string => typeof item === "string") : [];
    if (!audience.includes(this.settings.clientId)) throw invalidToken("ID token audience does not include this client");
    if (audience.length > 1 && claims.azp === undefined) throw invalidToken("ID token with multiple audiences must name an authorized party");
    if (claims.azp !== undefined && claims.azp !== this.settings.clientId) throw invalidToken("ID token authorized party is not this client");
    if (typeof claims.exp !== "number" || !Number.isFinite(claims.exp)) throw invalidToken("ID token has no expiry");
    if (claims.exp + skew <= nowSeconds) throw invalidToken("ID token has expired");
    if (typeof claims.iat !== "number" || !Number.isFinite(claims.iat)) throw invalidToken("ID token has no issued-at time");
    if (claims.iat - skew > nowSeconds) throw invalidToken("ID token was issued in the future");
    if (claims.nbf !== undefined && (typeof claims.nbf !== "number" || claims.nbf - skew > nowSeconds)) throw invalidToken("ID token is not yet valid");
    if (typeof claims.nonce !== "string" || !constantTimeEqual(claims.nonce, expectedNonce)) throw invalidToken("ID token nonce does not match this login");
    if (typeof claims.sub !== "string" || !claims.sub || claims.sub.length > 255) throw invalidToken("ID token has no valid subject");
  }

  private async signingKey(alg: string, kid: string | undefined): Promise<KeyObject> {
    const found = selectJwk(await this.jwks(false), alg, kid);
    if (found) return importJwk(found);
    const refreshed = selectJwk(await this.jwks(true), alg, kid);
    if (!refreshed) throw invalidToken(`No signing key${kid ? ` with kid ${kid.slice(0, 64)}` : ""} matches the ID token`);
    return importJwk(refreshed);
  }

  private async jwks(unknownKid: boolean): Promise<JsonWebKey[]> {
    const nowMs = this.now().getTime();
    const cached = this.jwksCache;
    if (cached) {
      const age = nowMs - cached.fetchedAt;
      const fresh = age < this.settings.jwksTtlMs;
      if (!unknownKid && fresh) return cached.value;
      if (unknownKid && age < this.settings.jwksMinRefreshMs) return cached.value;
    }
    this.jwksInFlight ??= this.fetchJwks().finally(() => {
      this.jwksInFlight = undefined;
    });
    return this.jwksInFlight;
  }

  private async fetchJwks(): Promise<JsonWebKey[]> {
    const discovery = await this.discovery();
    const { status, payload } = await this.fetchJson(discovery.jwks_uri, { method: "GET", headers: { accept: "application/json" } }, maxJwksBytes, false);
    if (status !== 200 || !Array.isArray(payload.keys)) throw new HttpError(502, "Identity provider JWKS is unavailable or malformed");
    const keys = payload.keys.filter((key): key is JsonWebKey => Boolean(key) && typeof key === "object" && !Array.isArray(key));
    this.jwksCache = { value: keys, fetchedAt: this.now().getTime() };
    return keys;
  }

  private async fetchDiscovery(): Promise<OidcDiscovery> {
    const url = `${this.settings.issuer}/.well-known/openid-configuration`;
    const { status, payload } = await this.fetchJson(url, { method: "GET", headers: { accept: "application/json" } }, maxDiscoveryBytes, false);
    if (status !== 200) throw new HttpError(502, `OpenID discovery failed (HTTP ${status})`);
    if (typeof payload.issuer !== "string" || normalizeIssuer(payload.issuer) !== this.settings.issuer) {
      throw new HttpError(502, "OpenID discovery issuer does not match the configured issuer");
    }
    const endpoint = (name: "authorization_endpoint" | "token_endpoint" | "jwks_uri"): string => {
      const value = payload[name];
      if (typeof value !== "string") throw new HttpError(502, `OpenID discovery is missing ${name}`);
      try {
        return requireSafeUrl(value, name);
      } catch {
        throw new HttpError(502, `OpenID discovery ${name} must be an https URL`);
      }
    };
    const methods = Array.isArray(payload.token_endpoint_auth_methods_supported)
      ? payload.token_endpoint_auth_methods_supported.filter((item): item is string => typeof item === "string")
      : undefined;
    const discovery: OidcDiscovery = {
      issuer: payload.issuer,
      authorization_endpoint: endpoint("authorization_endpoint"),
      token_endpoint: endpoint("token_endpoint"),
      jwks_uri: endpoint("jwks_uri"),
      ...(methods ? { token_endpoint_auth_methods_supported: methods } : {}),
    };
    this.discoveryCache = { value: discovery, fetchedAt: this.now().getTime() };
    return discovery;
  }

  private tokenAuthMethod(discovery: OidcDiscovery): OidcTokenEndpointAuthMethod {
    if (this.settings.tokenEndpointAuthMethod) return this.settings.tokenEndpointAuthMethod;
    const supported = discovery.token_endpoint_auth_methods_supported;
    if (!supported || supported.includes("client_secret_basic")) return "client_secret_basic";
    if (supported.includes("client_secret_post")) return "client_secret_post";
    throw new HttpError(502, "Identity provider supports neither client_secret_basic nor client_secret_post");
  }

  private async fetchJson(
    url: string,
    init: RequestInit,
    maxBytes: number,
    allowErrorStatus: boolean,
  ): Promise<{ status: number; payload: Record<string, unknown> }> {
    let response: Response;
    try {
      response = await this.fetchImpl(url, { ...init, redirect: "error", signal: AbortSignal.timeout(this.settings.timeoutMs) });
    } catch (error) {
      throw new HttpError(502, `Identity provider is unreachable (${error instanceof Error ? error.name : "error"})`);
    }
    const text = await readBounded(response, maxBytes);
    let payload: unknown;
    try {
      payload = text ? JSON.parse(text) : {};
    } catch {
      if (allowErrorStatus && !response.ok) return { status: response.status, payload: {} };
      throw new HttpError(502, "Identity provider returned invalid JSON");
    }
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new HttpError(502, "Identity provider returned a non-object JSON response");
    return { status: response.status, payload: payload as Record<string, unknown> };
  }
}

/** `BASE64URL(SHA256(verifier))` per RFC 7636. */
export function pkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

async function readBounded(response: Response, maxBytes: number): Promise<string> {
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (declared > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new HttpError(502, "Identity provider response is too large");
  }
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new HttpError(502, "Identity provider response is too large");
      }
      chunks.push(value);
    }
  } catch (error) {
    if (error instanceof HttpError) throw error;
    throw new HttpError(502, "Identity provider response could not be read");
  }
  return Buffer.concat(chunks).toString("utf8");
}

function selectJwk(keys: JsonWebKey[], alg: string, kid: string | undefined): JsonWebKey | undefined {
  const spec = signatureAlgorithms[alg];
  if (!spec) return undefined;
  const candidates = keys.filter(
    (key) =>
      key.kty === spec.kty &&
      (key.use === undefined || key.use === "sig") &&
      (key.alg === undefined || key.alg === alg) &&
      (spec.crv === undefined || key.crv === spec.crv) &&
      (!Array.isArray(key.key_ops) || key.key_ops.includes("verify")),
  );
  if (kid !== undefined) return candidates.find((key) => key.kid === kid);
  return candidates.length === 1 ? candidates[0] : undefined;
}

function importJwk(jwk: JsonWebKey): KeyObject {
  const { kty, n, e, crv, x, y } = jwk;
  try {
    return createPublicKey({ key: kty === "RSA" ? { kty, n, e } : { kty, crv, x, y }, format: "jwk" });
  } catch {
    throw invalidToken("Identity provider signing key is malformed");
  }
}

function decodeSegment(segment: string, label: string): Record<string, unknown> {
  if (!/^[A-Za-z0-9_-]+$/.test(segment)) throw invalidToken(`ID token ${label} is not base64url`);
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(segment, "base64url").toString("utf8"));
  } catch {
    throw invalidToken(`ID token ${label} is not JSON`);
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw invalidToken(`ID token ${label} is not a JSON object`);
  return parsed as Record<string, unknown>;
}

function invalidToken(message: string): HttpError {
  return new HttpError(401, message, { code: "oidc_invalid_id_token" });
}

export function constantTimeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function readClientSecret(opts: NomaCloudOidcOptions, read: (name: (typeof envNames)[number]) => string | undefined): string | undefined {
  const inline = clean(opts.clientSecret) ?? (clean(opts.clientSecretFile) ? undefined : read("NOMA_CLOUD_OIDC_CLIENT_SECRET"));
  const file = clean(opts.clientSecretFile) ?? (clean(opts.clientSecret) ? undefined : read("NOMA_CLOUD_OIDC_CLIENT_SECRET_FILE"));
  if (inline && file) throw new Error("Set only one of NOMA_CLOUD_OIDC_CLIENT_SECRET and NOMA_CLOUD_OIDC_CLIENT_SECRET_FILE");
  if (inline) return inline;
  if (!file) return undefined;
  const secret = clean(readFileSync(resolve(file), "utf8"));
  if (!secret) throw new Error(`OIDC client secret file is empty: ${file}`);
  return secret;
}

function requireSafeUrl(value: string, label: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`${label} must be an absolute URL`);
  }
  if (url.username || url.password) throw new Error(`${label} must not embed credentials`);
  if (url.protocol === "https:") return value;
  if (url.protocol === "http:" && isLoopbackHost(url.hostname)) return value;
  throw new Error(`${label} must use https (plain http is allowed only for loopback hosts)`);
}

function isLoopbackHost(hostname: string): boolean {
  return hostname === "localhost" || hostname === "[::1]" || /^127\.\d+\.\d+\.\d+$/.test(hostname);
}

function tokenAuthMethod(value: string | undefined): OidcTokenEndpointAuthMethod | undefined {
  if (value === undefined) return undefined;
  if (value === "client_secret_basic" || value === "client_secret_post") return value;
  throw new Error("NOMA_CLOUD_OIDC_TOKEN_AUTH_METHOD must be client_secret_basic or client_secret_post");
}

function splitList(value: string): string[] {
  return value.split(/[\s,]+/).map((item) => item.trim()).filter(Boolean);
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function flag(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined) return fallback;
  if (/^(?:1|true|yes|on)$/i.test(value)) return true;
  if (/^(?:0|false|no|off)$/i.test(value)) return false;
  throw new Error(`Invalid boolean OIDC setting: ${value}`);
}

function positive(value: number, label: string): number {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${label} must be a positive number`);
  return value;
}

function nonNegative(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 0) throw new Error(`${label} must be a non-negative number`);
  return value;
}

function clean(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed || undefined;
}

/** `application/x-www-form-urlencoded` encoding of one value, as RFC 6749 §2.3.1 requires for Basic credentials. */
export function formUrlEncode(value: string): string {
  return new URLSearchParams([["v", value]]).toString().slice(2);
}
