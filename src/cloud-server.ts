import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createReadStream, readFileSync } from "node:fs";
import { stat } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import type { Diagnostic } from "./ast.js";
import { walk } from "./ast.js";
import {
  openNomaCloudDatabase,
  type CloudDbQuery,
  type CloudActivityEvent,
  type CloudApproval,
  type CloudApprovalStatus,
  type CloudComment,
  type CloudDocumentRecord,
  type CloudDocumentRevision,
  type CloudDocumentRevisionSummary,
  type CloudGroup,
  type CloudGroupPermission,
  type CloudIssue,
  type CloudIssueComment,
  type CloudIssueEvent,
  type CloudIssueFilter,
  type CloudIssueLink,
  type CloudIssueLinkType,
  type CloudIssuePriority,
  type CloudIssueStatus,
  type CloudIssueType,
  type CloudNavigationItem,
  type CloudNotification,
  type CloudPatchProposal,
  type CloudPermission,
  type CloudProject,
  type CloudResourceType,
  type CloudRole,
  type CloudSearchResult,
  type CloudShareLink,
  type CloudSiteRecord,
  type CloudSprint,
  type CloudSprintStatus,
  type CloudTrashItem,
  type CloudUserRecord,
  type NomaCloudDatabase,
} from "./cloud-db.js";
import {
  CloudKnowledgePlatform,
  type AgentAccessGrant,
  type AgentRecipe,
  type AgentRun,
  type AnalyticsEvent,
  type CloudAgentIdentity,
  type ConnectorKind,
  type ConnectorSourceRecord,
  type EnterprisePolicy,
  type KnowledgeConnector,
  type KnowledgeDocumentAccess,
  type KnowledgeTrust,
  type LegalHold,
  type NomaBackupBundle,
  type OfflineDraft,
  type RagEvaluationFixture,
  type RealtimeOperation,
  type RecipeRun,
  type ScimIdentity,
} from "./cloud-platform.js";
import { cloudPageTemplates, instantiateCloudPageTemplate } from "./cloud-templates.js";
import { convertMarkdownToNoma } from "./ingest-markdown.js";
import { extractWikilinks } from "./inline.js";
import type { PatchOp } from "./patch.js";
import { slugify, parse } from "./parser.js";
import { createAgentSafetyProof, type AgentSafetyProof } from "./proof.js";
import { renderHtml } from "./renderer-html.js";
import { renderJson } from "./renderer-json.js";
import { renderLlm } from "./renderer-llm.js";
import { validate } from "./validator.js";

export type {
  CloudDbQuery,
  CloudActivityEvent,
  CloudApproval,
  CloudApprovalStatus,
  CloudComment,
  CloudDocumentRecord,
  CloudDocumentRevision,
  CloudDocumentRevisionSummary,
  CloudGroup,
  CloudGroupPermission,
  CloudIssue,
  CloudIssueComment,
  CloudIssueEvent,
  CloudIssueFilter,
  CloudIssueLink,
  CloudIssueLinkType,
  CloudIssuePriority,
  CloudIssueStatus,
  CloudIssueType,
  CloudNavigationItem,
  CloudNotification,
  CloudPatchProposal,
  CloudPermission,
  CloudProject,
  CloudResourceType,
  CloudRole,
  CloudSearchResult,
  CloudShareLink,
  CloudSiteRecord,
  CloudSprint,
  CloudSprintStatus,
  CloudTrashItem,
  CloudUserRecord,
} from "./cloud-db.js";

export interface NomaCloudServerOptions {
  dataDir?: string;
  usersDir?: string;
  sitesDir?: string;
  dbPath?: string;
  publicDir?: string;
  maxBodyBytes?: number;
  accessToken?: string;
  accessTokenFile?: string;
  invitationCode?: string;
  invitationCodeFile?: string;
  ssoTrustedHeaderSecret?: string;
  allowOpenAccess?: boolean;
  allowOpenRegistration?: boolean;
  production?: boolean;
  rateLimitWindowMs?: number;
  rateLimitMaxRequests?: number;
  authRateLimitMaxRequests?: number;
  trustProxy?: boolean;
  now?: () => Date;
}

interface CloudServerConfig {
  dataDir: string;
  usersDir: string;
  sitesDir: string;
  dbPath: string;
  publicDir: string;
  maxBodyBytes: number;
  accessTokenHash?: string;
  invitationCodeHash?: string;
  ssoTrustedHeaderHash?: string;
  rateLimiter: CloudRateLimiter;
  trustProxy: boolean;
  now: () => Date;
  store: NomaCloudDatabase;
  platform: CloudKnowledgePlatform;
}

interface SourceInspection {
  hash: string;
  diagnostics: Diagnostic[];
  json: string;
  llm: string;
}

interface WikiPageSummary {
  id: string;
  title: string;
  slug: string;
  updatedAt: string;
}

interface WikiLinkSummary {
  fromDocumentId: string;
  fromTitle: string;
  target: string;
  label: string;
  resolvedDocumentId?: string;
  resolvedTitle?: string;
  missing: boolean;
}

interface Principal {
  user?: CloudUserRecord;
  userTokenHash?: string;
  shareTokenHash?: string;
}

interface AccessContext {
  role: CloudRole;
  via: "user" | "group" | "share";
  user?: CloudUserRecord;
  share?: CloudShareLink;
  groupId?: string;
}

interface RateLimitBucket {
  count: number;
  resetAt: number;
}

interface RateLimitResult {
  allowed: boolean;
  limit: number;
  remaining: number;
  resetAt: number;
}

class CloudRateLimiter {
  private readonly buckets = new Map<string, RateLimitBucket>();

  constructor(
    private readonly windowMs: number,
    private readonly apiLimit: number,
    private readonly authLimit: number,
  ) {}

  consume(key: string, auth: boolean, now: number): RateLimitResult {
    const limit = auth ? this.authLimit : this.apiLimit;
    const bucket = this.buckets.get(key);
    const active = bucket && bucket.resetAt > now ? bucket : { count: 0, resetAt: now + this.windowMs };
    active.count += 1;
    this.buckets.set(key, active);
    if (this.buckets.size > 10_000) this.prune(now);
    return {
      allowed: active.count <= limit,
      limit,
      remaining: Math.max(0, limit - active.count),
      resetAt: active.resetAt,
    };
  }

  private prune(now: number): void {
    for (const [key, bucket] of this.buckets) {
      if (bucket.resetAt <= now) this.buckets.delete(key);
    }
  }
}

class HttpError extends Error {
  constructor(readonly status: number, message: string, readonly details: Record<string, unknown> = {}) {
    super(message);
  }
}

const roleRank: Record<CloudRole, number> = {
  viewer: 1,
  editor: 2,
  owner: 3,
};

const issueStatuses: CloudIssueStatus[] = ["backlog", "todo", "in_progress", "in_review", "done"];
const issueTransitions: Record<CloudIssueStatus, CloudIssueStatus[]> = {
  backlog: ["todo"],
  todo: ["backlog", "in_progress"],
  in_progress: ["todo", "in_review", "done"],
  in_review: ["in_progress", "done"],
  done: ["todo"],
};
const sprintTransitions: Record<CloudSprintStatus, CloudSprintStatus[]> = {
  planned: ["active"],
  active: ["closed"],
  closed: [],
};

const cloudAccessCookieName = "noma_cloud_access";

export function createNomaCloudServer(options: NomaCloudServerOptions = {}): Server {
  const dataDir = resolve(options.dataDir ?? process.env.NOMA_CLOUD_DATA_DIR ?? ".noma-cloud/documents");
  const storageRoot = dirname(dataDir);
  const usersDir = resolve(options.usersDir ?? process.env.NOMA_CLOUD_USERS_DIR ?? join(storageRoot, "users"));
  const sitesDir = resolve(options.sitesDir ?? process.env.NOMA_CLOUD_SITES_DIR ?? join(storageRoot, "sites"));
  const dbPath = resolve(options.dbPath ?? process.env.NOMA_CLOUD_DB ?? join(storageRoot, "noma-cloud.sqlite"));
  const accessTokenHash = cloudAccessTokenHash(options);
  const invitationCodeHash = cloudInvitationCodeHash(options);
  const ssoTrustedHeaderHash = cleanSecret(options.ssoTrustedHeaderSecret ?? process.env.NOMA_CLOUD_SSO_TRUST_SECRET);
  validateProductionSecurity(options, accessTokenHash, invitationCodeHash);
  const now = options.now ?? (() => new Date());
  const store = openNomaCloudDatabase({ dbPath, dataDir, usersDir, sitesDir });
  const platform = new CloudKnowledgePlatform(dbPath);
  const config: CloudServerConfig = {
    dataDir,
    usersDir,
    sitesDir,
    dbPath,
    publicDir: resolve(options.publicDir ?? process.env.NOMA_PUBLIC_DIR ?? "dist"),
    maxBodyBytes: options.maxBodyBytes ?? Number(process.env.NOMA_CLOUD_MAX_BODY_BYTES ?? 1_500_000),
    accessTokenHash,
    invitationCodeHash,
    ssoTrustedHeaderHash: ssoTrustedHeaderHash ? sha256Hex(ssoTrustedHeaderHash) : undefined,
    rateLimiter: new CloudRateLimiter(
      positiveInteger(options.rateLimitWindowMs ?? Number(process.env.NOMA_CLOUD_RATE_LIMIT_WINDOW_MS ?? 60_000), "rateLimitWindowMs"),
      positiveInteger(options.rateLimitMaxRequests ?? Number(process.env.NOMA_CLOUD_RATE_LIMIT_MAX ?? 300), "rateLimitMaxRequests"),
      positiveInteger(options.authRateLimitMaxRequests ?? Number(process.env.NOMA_CLOUD_AUTH_RATE_LIMIT_MAX ?? 20), "authRateLimitMaxRequests"),
    ),
    trustProxy: options.trustProxy ?? enabledEnvironmentFlag("NOMA_CLOUD_TRUST_PROXY"),
    now,
    store,
    platform,
  };

  const server = createServer((req, res) => {
    void routeRequest(req, res, config).catch((error: unknown) => {
      if (res.headersSent) {
        res.destroy(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      const status = error instanceof HttpError ? error.status : 500;
      const message = error instanceof Error ? error.message : "Internal server error";
      sendJson(res, status, { error: message, ...(error instanceof HttpError ? error.details : {}) });
    });
  });
  server.on("close", () => {
    platform.close();
    store.close();
  });
  return server;
}

function validateProductionSecurity(
  options: NomaCloudServerOptions,
  accessTokenHash: string | undefined,
  invitationCodeHash: string | undefined,
): void {
  const production = options.production ?? process.env.NODE_ENV === "production";
  if (!production) return;
  const allowOpenAccess = options.allowOpenAccess ?? enabledEnvironmentFlag("NOMA_CLOUD_ALLOW_OPEN_ACCESS");
  const allowOpenRegistration = options.allowOpenRegistration ?? enabledEnvironmentFlag("NOMA_CLOUD_ALLOW_OPEN_REGISTRATION");
  if (!accessTokenHash && !allowOpenAccess) {
    throw new Error("Production Noma Cloud requires NOMA_CLOUD_ACCESS_TOKEN or explicit NOMA_CLOUD_ALLOW_OPEN_ACCESS=1");
  }
  if (!invitationCodeHash && !allowOpenRegistration) {
    throw new Error("Production Noma Cloud requires NOMA_CLOUD_INVITATION_CODE or explicit NOMA_CLOUD_ALLOW_OPEN_REGISTRATION=1");
  }
}

function enabledEnvironmentFlag(name: string): boolean {
  return /^(?:1|true|yes)$/i.test(process.env[name]?.trim() ?? "");
}

function positiveInteger(value: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`${label} must be a positive integer`);
  return value;
}

function cloudAccessTokenHash(options: NomaCloudServerOptions): string | undefined {
  const token = readCloudAccessToken(options);
  return token ? sha256Hex(token) : undefined;
}

function readCloudAccessToken(options: NomaCloudServerOptions): string | undefined {
  const inlineToken = cleanSecret(options.accessToken ?? process.env.NOMA_CLOUD_ACCESS_TOKEN);
  if (inlineToken) return inlineToken;

  const filePath = cleanSecret(options.accessTokenFile ?? process.env.NOMA_CLOUD_ACCESS_TOKEN_FILE);
  if (!filePath) return undefined;
  const token = cleanSecret(readFileSync(resolve(filePath), "utf8"));
  if (!token) throw new Error(`Cloud access token file is empty: ${filePath}`);
  return token;
}

function cloudInvitationCodeHash(options: NomaCloudServerOptions): string | undefined {
  const code = readCloudInvitationCode(options);
  return code ? sha256Hex(code) : undefined;
}

function readCloudInvitationCode(options: NomaCloudServerOptions): string | undefined {
  const inlineCode = cleanSecret(options.invitationCode ?? process.env.NOMA_CLOUD_INVITATION_CODE);
  if (inlineCode) return inlineCode;

  const filePath = cleanSecret(options.invitationCodeFile ?? process.env.NOMA_CLOUD_INVITATION_CODE_FILE);
  if (!filePath) return undefined;
  const code = cleanSecret(readFileSync(resolve(filePath), "utf8"));
  if (!code) throw new Error(`Cloud invitation code file is empty: ${filePath}`);
  return code;
}

function cleanSecret(value: string | undefined): string | undefined {
  const token = value?.trim();
  return token || undefined;
}

function requiresCloudAccess(pathname: string): boolean {
  return (
    (pathname.startsWith("/api/") && !pathname.startsWith("/api/auth/")) ||
    isCloudAppShell(pathname) ||
    pathname === "/assets/cloud-app.js" ||
    pathname === "/assets/cloud.css" ||
    pathname === "/assets/workbench.js" ||
    pathname === "/assets/workbench.css"
  );
}

function isCloudAppShell(pathname: string): boolean {
  return pathname === "/cloud" || pathname === "/cloud.html" || pathname === "/workbench" || pathname === "/workbench.html";
}

function resolveCloudAccess(
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

async function routeAuth(req: IncomingMessage, res: ServerResponse, parts: string[], config: CloudServerConfig): Promise<void> {
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

function requireInvitationCode(config: CloudServerConfig, req: IncomingMessage, input: Record<string, unknown>): void {
  if (!config.invitationCodeHash) return;
  const code = optionalString(input.invitationCode) ?? headerValue(req, "x-noma-cloud-invitation-code");
  if (!code || sha256Hex(code.trim()) !== config.invitationCodeHash) {
    throw new HttpError(403, "Valid invitation code required");
  }
}

function sendCloudAccessDenied(res: ServerResponse, url: URL): void {
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

function redirectWithCloudAccessCookie(req: IncomingMessage, res: ServerResponse, url: URL, token: string): void {
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

async function routeRequest(req: IncomingMessage, res: ServerResponse, config: CloudServerConfig): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const method = req.method ?? "GET";

  if (method === "GET" && url.pathname === "/healthz") {
    sendJson(res, 200, { ok: true });
    return;
  }

  if (url.pathname.startsWith("/api/")) enforceRateLimit(req, res, url, config);

  if (url.pathname.startsWith("/api/auth/")) {
    await routeAuth(req, res, url.pathname.split("/").filter(Boolean), config);
    return;
  }

  if (requiresCloudAccess(url.pathname)) {
    const access = resolveCloudAccess(config, req, url);
    if (!access.ok) {
      sendCloudAccessDenied(res, url);
      return;
    }
    if ((method === "GET" || method === "HEAD") && access.via === "query" && isCloudAppShell(url.pathname)) {
      redirectWithCloudAccessCookie(req, res, url, access.token);
      return;
    }
  }

  const principal = await resolvePrincipal(config, req, url);

  if (url.pathname === "/api/status" && method === "GET") {
    const enterprisePolicy = config.platform.enterprisePolicy();
    sendJson(res, 200, {
      ok: true,
      mode: "cloud",
      auth: enterprisePolicy.sso.enforced ? "sso" : "token",
      sso: enterprisePolicy.sso,
      access: config.accessTokenHash ? "gate-token" : "open",
      storage: "sqlite",
      database: {
        queryApi: true,
        resources: [
          "documents",
          "sites",
          "blocks",
          "users",
          "wiki",
          "search",
          "navigation",
          "templates",
          "trash",
          "comments",
          "notifications",
          "activity",
          "approvals",
          "groups",
          "projects",
          "issues",
          "sprints",
          "patch-proposals",
          "ask",
          "knowledge-trust",
          "knowledge-health",
          "llm-wiki",
          "rag-evaluations",
          "agent-inbox",
          "agent-identities",
          "connectors",
          "recipes",
          "semantic-collections",
          "agent-gateway",
          "analytics",
          "backup",
          "offline-drafts",
          "realtime-operations",
          "enterprise-policy",
          "scim",
          "legal-hold",
          "audit-export",
        ],
      },
      maxBodyBytes: config.maxBodyBytes,
      user: principal.user ? publicUser(principal.user) : undefined,
    });
    return;
  }

  if (url.pathname.startsWith("/api/")) {
    await routeApi(req, res, url, config, principal);
    return;
  }

  if (method === "GET" && url.pathname.startsWith("/d/")) {
    const id = decodeURIComponent(url.pathname.slice(3));
    const record = await readDocument(config, id);
    requireNotTrashed(config, "document", id);
    const access = requireRecordAccess(config, record, principal, "viewer");
    sendText(res, 200, renderDocumentHtml(record, access), "text/html; charset=utf-8");
    return;
  }

  if (method === "GET" && url.pathname.startsWith("/s/")) {
    const id = decodeURIComponent(url.pathname.slice(3));
    const site = await readSite(config, id);
    requireNotTrashed(config, "site", id);
    const access = requireRecordAccess(config, site, principal, "viewer");
    sendText(res, 200, await renderSiteHtml(config, site, access), "text/html; charset=utf-8");
    return;
  }

  if (method === "GET" || method === "HEAD") {
    await serveStatic(req, res, url, config);
    return;
  }

  throw new HttpError(405, "Method not allowed");
}

function enforceRateLimit(req: IncomingMessage, res: ServerResponse, url: URL, config: CloudServerConfig): void {
  const auth = url.pathname.startsWith("/api/auth/") || (url.pathname === "/api/users" && req.method === "POST");
  const address = clientAddress(req, config.trustProxy);
  const result = config.rateLimiter.consume(`${address}:${auth ? "auth" : "api"}`, auth, config.now().getTime());
  res.setHeader("x-ratelimit-limit", String(result.limit));
  res.setHeader("x-ratelimit-remaining", String(result.remaining));
  res.setHeader("x-ratelimit-reset", String(Math.ceil(result.resetAt / 1000)));
  if (result.allowed) return;
  const retryAfter = Math.max(1, Math.ceil((result.resetAt - config.now().getTime()) / 1000));
  res.setHeader("retry-after", String(retryAfter));
  throw new HttpError(429, "Too many requests", { code: "rate_limit_exceeded", retryAfter });
}

function clientAddress(req: IncomingMessage, trustProxy: boolean): string {
  if (trustProxy) {
    const forwarded = headerValue(req, "x-forwarded-for")?.split(",")[0]?.trim();
    if (forwarded) return forwarded;
  }
  return req.socket.remoteAddress ?? "unknown";
}

async function routeApi(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  config: CloudServerConfig,
  principal: Principal,
): Promise<void> {
  const parts = url.pathname.split("/").filter(Boolean);
  const resource = parts[1];

  if (resource === "users") {
    await routeUsers(req, res, parts, config, principal);
    return;
  }

  if (resource === "documents") {
    await routeDocuments(req, res, parts, config, principal);
    return;
  }

  if (resource === "sites") {
    await routeSites(req, res, url, parts, config, principal);
    return;
  }

  if (resource === "db") {
    await routeDatabase(req, res, parts, config, principal);
    return;
  }

  if (resource === "search") {
    routeSearch(req, res, url, config, principal);
    return;
  }

  if (resource === "navigation") {
    await routeNavigation(req, res, parts, config, principal);
    return;
  }

  if (resource === "templates") {
    routeTemplates(req, res, config, principal);
    return;
  }

  if (resource === "trash") {
    await routeTrash(req, res, parts, config, principal);
    return;
  }

  if (resource === "notifications") {
    await routeNotifications(req, res, parts, config, principal);
    return;
  }

  if (resource === "activity") {
    routeActivity(req, res, url, config, principal);
    return;
  }

  if (resource === "groups") {
    await routeGroups(req, res, parts, config, principal);
    return;
  }

  if (resource === "projects") {
    await routeProjects(req, res, url, parts, config, principal);
    return;
  }

  if (resource === "ask" || resource === "knowledge" || resource === "agent-inbox" || resource === "agents" || resource === "connectors" || resource === "recipes" || resource === "collections" || resource === "gateway" || resource === "analytics" || resource === "backup" || resource === "offline" || resource === "realtime" || resource === "enterprise") {
    await routeKnowledgePlatform(req, res, url, parts, config, principal);
    return;
  }

  throw new HttpError(404, "Unknown API resource");
}

function routeSearch(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  config: CloudServerConfig,
  principal: Principal,
): void {
  if ((req.method ?? "GET") !== "GET") throw new HttpError(405, "Method not allowed");
  const user = requireUser(principal);
  const q = (url.searchParams.get("q") ?? "").trim().slice(0, 200);
  const siteId = optionalCloudId(url.searchParams.get("site"), "Site");
  const limit = boundedInteger(numberQuery(url.searchParams.get("limit")), 25, 1, 100, "limit");
  sendJson(res, 200, { q, results: config.store.search(user, q, siteId, limit) });
}

async function routeKnowledgePlatform(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  parts: string[],
  config: CloudServerConfig,
  principal: Principal,
): Promise<void> {
  const resource = parts[1];
  if (resource === "ask") {
    await routeAskNoma(req, res, config, principal);
    return;
  }
  if (resource === "knowledge") {
    await routeKnowledge(req, res, url, parts, config, principal);
    return;
  }
  if (resource === "agent-inbox") {
    routeAgentInbox(req, res, url, config, principal);
    return;
  }
  if (resource === "agents") {
    await routeAgents(req, res, parts, config, principal);
    return;
  }
  if (resource === "connectors") {
    await routeConnectors(req, res, parts, config, principal);
    return;
  }
  if (resource === "recipes") {
    await routeRecipes(req, res, parts, config, principal);
    return;
  }
  if (resource === "collections") {
    routeSemanticCollections(req, res, url, config, principal);
    return;
  }
  if (resource === "gateway") {
    await routeAgentGateway(req, res, parts, config, principal);
    return;
  }
  if (resource === "analytics") {
    await routeKnowledgeAnalytics(req, res, config, principal);
    return;
  }
  if (resource === "backup") {
    await routeBackup(req, res, parts, config, principal);
    return;
  }
  if (resource === "offline") {
    await routeOffline(req, res, parts, config, principal);
    return;
  }
  if (resource === "realtime") {
    await routeRealtime(req, res, url, parts, config, principal);
    return;
  }
  if (resource === "enterprise") {
    await routeEnterprise(req, res, parts, config, principal);
    return;
  }
  throw new HttpError(404, "Unknown knowledge platform route");
}

async function routeAskNoma(req: IncomingMessage, res: ServerResponse, config: CloudServerConfig, principal: Principal): Promise<void> {
  if ((req.method ?? "GET") !== "POST") throw new HttpError(405, "Method not allowed");
  const user = requireUser(principal);
  const input = await readJsonBody(req, config.maxBodyBytes);
  const query = stringInput(input, "query").slice(0, 1_000);
  const siteId = optionalCloudId(input.siteId, "Site");
  const agentId = optionalString(input.agentId);
  const documents = knowledgeDocuments(config, user, siteId, agentId);
  const contentTypes = optionalStringArray(input.contentTypes, "contentTypes", 30);
  const answer = config.platform.ask({
    principalId: agentId ?? user.id,
    query,
    documents,
    now: config.now().toISOString(),
    limit: boundedInteger(input.limit, 8, 1, 25, "limit"),
    ...(contentTypes ? { contentTypes } : {}),
  });
  sendJson(res, 200, answer);
}

async function routeKnowledge(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  parts: string[],
  config: CloudServerConfig,
  principal: Principal,
): Promise<void> {
  const user = requireUser(principal);
  const method = req.method ?? "GET";
  const action = parts[2];
  if (action === "search" && method === "GET") {
    const query = (url.searchParams.get("q") ?? "").trim().slice(0, 1_000);
    const siteId = optionalCloudId(url.searchParams.get("site"), "Site");
    const agentId = optionalString(url.searchParams.get("agent"));
    const results = config.platform.search({
      principalId: agentId ?? user.id,
      query,
      documents: knowledgeDocuments(config, user, siteId, agentId),
      now: config.now().toISOString(),
      limit: boundedInteger(numberQuery(url.searchParams.get("limit")), 25, 1, 100, "limit"),
    });
    sendJson(res, 200, { query, mode: "hybrid", results });
    return;
  }
  if (action === "trust") {
    const documentId = stringPathPart(parts[3], "Document ID");
    const blockId = stringPathPart(parts[4], "Block ID");
    const document = await readDocument(config, documentId);
    const access = requireRecordAccess(config, document, principal, method === "GET" ? "viewer" : "editor");
    if (!documentHasBlock(document, blockId)) throw new HttpError(404, "Block not found");
    if (method === "GET") {
      sendJson(res, 200, { trust: config.platform.trustFor(documentId, blockId), access: accessResponse(access) });
      return;
    }
    if (method === "PUT") {
      const input = await readJsonBody(req, config.maxBodyBytes);
      const now = config.now().toISOString();
      const trust: KnowledgeTrust = {
        documentId,
        blockId,
        ownerId: optionalString(input.ownerId),
        verifiedBy: optionalString(input.verifiedBy),
        verifiedAt: optionalIsoDate(input.verifiedAt, "verifiedAt"),
        reviewBy: optionalIsoDate(input.reviewBy, "reviewBy"),
        supersedes: optionalStringArray(input.supersedes, "supersedes", 100),
        canonicalFor: optionalStringArray(input.canonicalFor, "canonicalFor", 100),
        sourceOf: optionalStringArray(input.sourceOf, "sourceOf", 100),
        provenance: optionalRecord(input.provenance, "provenance"),
        updatedAt: now,
        updatedBy: user.id,
      };
      sendJson(res, 200, config.platform.putTrust(trust));
      return;
    }
    throw new HttpError(405, "Method not allowed");
  }
  const siteId = optionalCloudId(url.searchParams.get("site"), "Site");
  const agentId = optionalString(url.searchParams.get("agent"));
  const documents = knowledgeDocuments(config, user, siteId, agentId);
  if (action === "llm" && method === "GET") {
    const context = documents.map((access) => `<!-- document:${access.document.id} hash:${access.document.hash} role:${access.role} via:${access.via} -->\n${renderLlm(parse(access.document.source, { filename: `${access.document.id}.noma` }))}`).join("\n\n");
    sendText(res, 200, context, "text/plain; charset=utf-8");
    return;
  }
  if (action === "health" && method === "GET") {
    sendJson(res, 200, { generatedAt: config.now().toISOString(), items: config.platform.health(documents, config.now().toISOString()) });
    return;
  }
  if (action === "wiki" && method === "GET") {
    sendJson(res, 200, config.platform.wiki(documents, config.now().toISOString()));
    return;
  }
  if (action === "reindex" && method === "POST") {
    sendJson(res, 200, { indexed: config.platform.indexDocuments(documents, config.now().toISOString(), true), documentCount: documents.length });
    return;
  }
  if (action === "evaluations" && method === "POST") {
    const input = await readJsonBody(req, config.maxBodyBytes);
    const fixtures = ragEvaluationFixtures(input.fixtures);
    const results = config.platform.evaluate(fixtures, { principalId: agentId ?? user.id, documents, now: config.now().toISOString() });
    sendJson(res, 200, { passed: results.every((result) => result.passed), results });
    return;
  }
  throw new HttpError(404, "Unknown knowledge route");
}

function routeAgentInbox(req: IncomingMessage, res: ServerResponse, url: URL, config: CloudServerConfig, principal: Principal): void {
  if ((req.method ?? "GET") !== "GET") throw new HttpError(405, "Method not allowed");
  const user = requireUser(principal);
  const siteId = optionalCloudId(url.searchParams.get("site"), "Site");
  const documents = knowledgeDocuments(config, user, siteId);
  const proposals = documents.flatMap((item) => config.store.listPatchProposals(item.document.id));
  const inbox = config.platform.agentChangeInbox(proposals, documents);
  sendJson(res, 200, {
    changes: inbox,
    counts: {
      awaitingReview: inbox.filter((item) => item.applyStatus === "awaiting_review").length,
      ready: inbox.filter((item) => item.applyStatus === "ready").length,
      rejected: inbox.filter((item) => item.applyStatus === "rejected").length,
      applied: inbox.filter((item) => item.applyStatus === "applied").length,
    },
  });
}

async function routeAgents(req: IncomingMessage, res: ServerResponse, parts: string[], config: CloudServerConfig, principal: Principal): Promise<void> {
  const user = requireUser(principal);
  const method = req.method ?? "GET";
  const agentId = parts[2];
  const action = parts[3];
  const childId = parts[4];
  if (!agentId && method === "GET") {
    sendJson(res, 200, { agents: config.platform.listAgents().filter((agent) => agent.createdBy === user.id) });
    return;
  }
  if (!agentId && method === "POST") {
    const input = await readJsonBody(req, config.maxBodyBytes);
    const now = config.now().toISOString();
    const modelPolicy = optionalRecord(input.modelPolicy, "modelPolicy") ?? {};
    const agent: CloudAgentIdentity = {
      id: uniqueId(config),
      name: stringInput(input, "name").slice(0, 120),
      ...(optionalString(input.description) ? { description: optionalString(input.description)?.slice(0, 2_000) } : {}),
      createdBy: user.id,
      modelPolicy: {
        model: stringInput(modelPolicy, "model", "local-deterministic"),
        zeroRetention: modelPolicy.zeroRetention === true,
        maxTokensPerRun: boundedInteger(modelPolicy.maxTokensPerRun, 8_000, 128, 1_000_000, "maxTokensPerRun"),
      },
      capabilities: requiredStringArray(input.capabilities, "capabilities", 100),
      budgetUsd: boundedNumber(input.budgetUsd, 25, 0, 1_000_000, "budgetUsd"),
      spentUsd: 0,
      status: "active",
      createdAt: now,
      updatedAt: now,
    };
    sendJson(res, 201, platformInput(() => config.platform.createAgent(agent)));
    return;
  }
  const agent = ownedAgent(config, user, stringPathPart(agentId, "Agent ID"));
  if (!action && method === "GET") {
    sendJson(res, 200, { ...agent, access: config.platform.listAgentAccess(agent.id), runs: config.platform.listAgentRuns(agent.id) });
    return;
  }
  if (action === "access" && method === "GET") {
    sendJson(res, 200, { access: config.platform.listAgentAccess(agent.id) });
    return;
  }
  if (action === "access" && method === "POST") {
    const input = await readJsonBody(req, config.maxBodyBytes);
    const resourceType = input.resourceType === "site" ? "site" : input.resourceType === "document" ? "document" : undefined;
    if (!resourceType) throw new HttpError(400, "resourceType must be document or site");
    const resourceId = stringInput(input, "resourceId");
    const role = input.role === "editor" ? "editor" : input.role === "viewer" ? "viewer" : undefined;
    if (!role) throw new HttpError(400, "role must be viewer or editor");
    await requireResourceAccess(config, principal, resourceType, resourceId, role);
    const now = config.now().toISOString();
    const grant: AgentAccessGrant = { id: uniqueId(config), agentId: agent.id, resourceType, resourceId, role, createdAt: now, updatedAt: now };
    sendJson(res, 201, platformInput(() => config.platform.grantAgentAccess(grant, user.id, now)));
    return;
  }
  if (action === "runs" && !childId && method === "GET") {
    sendJson(res, 200, { runs: config.platform.listAgentRuns(agent.id) });
    return;
  }
  if (action === "runs" && !childId && method === "POST") {
    const input = await readJsonBody(req, config.maxBodyBytes);
    const documentId = optionalCloudId(input.documentId, "Document");
    if (documentId) requireGatewayAgentDocumentAccess(config, agent.id, documentId, "read_doc");
    const run: AgentRun = {
      id: uniqueId(config),
      agentId: agent.id,
      triggeredBy: user.id,
      trigger: agentRunTrigger(input.trigger),
      ...(documentId ? { documentId } : {}),
      status: "running",
      requestedCapabilities: optionalStringArray(input.requestedCapabilities, "requestedCapabilities", 100) ?? [],
      startedAt: config.now().toISOString(),
    };
    sendJson(res, 201, platformInput(() => config.platform.startAgentRun(run)));
    return;
  }
  if (action === "runs" && childId && parts[5] === "complete" && method === "POST") {
    const input = await readJsonBody(req, config.maxBodyBytes);
    const status = input.status === "completed" || input.status === "failed" || input.status === "cancelled" ? input.status : undefined;
    if (!status) throw new HttpError(400, "status must be completed, failed, or cancelled");
    sendJson(res, 200, platformInput(() => config.platform.finishAgentRun(childId, {
      status,
      costUsd: boundedNumber(input.costUsd, 0, 0, 1_000_000, "costUsd"),
      completedAt: config.now().toISOString(),
      ...(optionalRecord(input.output, "output") ? { output: optionalRecord(input.output, "output") } : {}),
    })));
    return;
  }
  throw new HttpError(404, "Unknown agent route");
}

async function routeConnectors(req: IncomingMessage, res: ServerResponse, parts: string[], config: CloudServerConfig, principal: Principal): Promise<void> {
  const user = requireUser(principal);
  const method = req.method ?? "GET";
  const connectorId = parts[2];
  const action = parts[3];
  if (!connectorId && method === "GET") {
    const visibleSites = config.store.listSites(user).map((site) => site.id);
    sendJson(res, 200, { connectors: config.platform.listConnectors(visibleSites) });
    return;
  }
  if (!connectorId && method === "POST") {
    const input = await readJsonBody(req, config.maxBodyBytes);
    const siteId = optionalCloudId(input.siteId, "Site");
    if (siteId) await requireResourceAccess(config, principal, "site", siteId, "editor");
    const now = config.now().toISOString();
    const connector: KnowledgeConnector = {
      id: uniqueId(config),
      kind: connectorKind(input.kind),
      name: stringInput(input, "name").slice(0, 120),
      ...(siteId ? { siteId } : {}),
      status: "active",
      configuration: scalarRecord(input.configuration, "configuration"),
      createdBy: user.id,
      createdAt: now,
      updatedAt: now,
    };
    sendJson(res, 201, platformInput(() => config.platform.putConnector(connector)));
    return;
  }
  const connector = visibleConnector(config, user, stringPathPart(connectorId, "Connector ID"));
  if (!action && method === "GET") {
    sendJson(res, 200, { ...connector, sources: config.platform.listConnectorSources(connector.id) });
    return;
  }
  if (action === "sources" && method === "GET") {
    sendJson(res, 200, { sources: config.platform.listConnectorSources(connector.id) });
    return;
  }
  if (action === "sources" && method === "POST") {
    const input = await readJsonBody(req, config.maxBodyBytes);
    const documentId = optionalCloudId(input.documentId, "Document");
    if (documentId) await requireResourceAccess(config, principal, "document", documentId, "editor");
    const syncedAt = config.now().toISOString();
    const source: ConnectorSourceRecord = {
      id: `${connector.id}:${sha256Hex(stringInput(input, "externalId")).slice(0, 18)}`,
      connectorId: connector.id,
      externalId: stringInput(input, "externalId").slice(0, 500),
      ...(documentId ? { documentId } : {}),
      upstreamPermissions: permissionLineage(input.upstreamPermissions),
      upstreamModifiedAt: requiredIsoDate(input.upstreamModifiedAt, "upstreamModifiedAt"),
      sourceUrl: absoluteUrl(input.sourceUrl, "sourceUrl"),
      contentHash: stringInput(input, "contentHash"),
      lineage: optionalStringArray(input.lineage, "lineage", 500) ?? [],
      ...(input.tombstone === true ? { tombstonedAt: syncedAt } : {}),
      syncedAt,
    };
    sendJson(res, 201, platformInput(() => config.platform.syncConnectorSource(source, user.id)));
    return;
  }
  throw new HttpError(404, "Unknown connector route");
}

async function routeRecipes(req: IncomingMessage, res: ServerResponse, parts: string[], config: CloudServerConfig, principal: Principal): Promise<void> {
  const user = requireUser(principal);
  const method = req.method ?? "GET";
  const recipeId = parts[2];
  const action = parts[3];
  if (!recipeId && method === "GET") {
    sendJson(res, 200, { recipes: config.platform.recipes() });
    return;
  }
  if (!recipeId && method === "POST") {
    const input = await readJsonBody(req, config.maxBodyBytes);
    const siteId = optionalCloudId(input.siteId, "Site");
    if (siteId) await requireResourceAccess(config, principal, "site", siteId, "editor");
    const now = config.now().toISOString();
    const trigger = optionalRecord(input.trigger, "trigger") ?? {};
    const recipe: AgentRecipe = {
      id: uniqueId(config),
      name: stringInput(input, "name").slice(0, 120),
      purpose: "custom",
      ...(siteId ? { siteId } : {}),
      ...(optionalString(input.agentId) ? { agentId: optionalString(input.agentId) } : {}),
      trigger: {
        modes: recipeTriggerModes(trigger.modes),
        ...(optionalString(trigger.schedule) ? { schedule: optionalString(trigger.schedule) } : {}),
        ...(optionalString(trigger.event) ? { event: optionalString(trigger.event) } : {}),
        ...(optionalString(trigger.webhookSecretHash) ? { webhookSecretHash: optionalString(trigger.webhookSecretHash) } : {}),
      },
      capabilitySet: requiredStringArray(input.capabilitySet, "capabilitySet", 100),
      steps: requiredStringArray(input.steps, "steps", 100),
      enabled: input.enabled !== false,
      createdBy: user.id,
      createdAt: now,
      updatedAt: now,
    };
    sendJson(res, 201, config.platform.putRecipe(recipe));
    return;
  }
  if (action === "runs" && method === "GET") {
    sendJson(res, 200, { runs: config.platform.listRecipeRuns(recipeId) });
    return;
  }
  if (action === "runs" && method === "POST") {
    const input = await readJsonBody(req, config.maxBodyBytes);
    const run: RecipeRun = {
      id: uniqueId(config),
      recipeId: stringPathPart(recipeId, "Recipe ID"),
      triggeredBy: user.id,
      triggerMode: recipeTriggerMode(input.triggerMode),
      input: optionalRecord(input.input, "input") ?? {},
      status: "planned",
      plan: [],
      mutationPolicy: "proof_proposal_only",
      startedAt: config.now().toISOString(),
    };
    sendJson(res, 201, platformInput(() => config.platform.runRecipe(run)));
    return;
  }
  throw new HttpError(404, "Unknown recipe route");
}

function routeSemanticCollections(req: IncomingMessage, res: ServerResponse, url: URL, config: CloudServerConfig, principal: Principal): void {
  if ((req.method ?? "GET") !== "GET") throw new HttpError(405, "Method not allowed");
  const user = requireUser(principal);
  const siteId = optionalCloudId(url.searchParams.get("site"), "Site");
  const collections = config.platform.semanticCollections(knowledgeDocuments(config, user, siteId), config.now().toISOString());
  const pending = collections.find((collection) => collection.id === "pending_agent_changes");
  if (pending) {
    const documents = knowledgeDocuments(config, user, siteId);
    const inbox = config.platform.agentChangeInbox(documents.flatMap((item) => config.store.listPatchProposals(item.document.id)), documents);
    pending.items = inbox.filter((item) => item.applyStatus === "awaiting_review" || item.applyStatus === "ready").map((item) => ({
      documentId: item.documentId,
      documentTitle: documents.find((access) => access.document.id === item.documentId)?.document.title ?? item.documentId,
      blockId: item.affectedIds[0] ?? item.id,
      contentType: "agent_change",
      title: item.plan[0],
      freshness: { state: "current", score: 1 },
      versionHash: item.documentHash,
    }));
  }
  sendJson(res, 200, { collections });
}

async function routeAgentGateway(req: IncomingMessage, res: ServerResponse, parts: string[], config: CloudServerConfig, principal: Principal): Promise<void> {
  const user = requireUser(principal);
  const method = req.method ?? "GET";
  const action = parts[2];
  if (!action && method === "GET") {
    sendJson(res, 200, { protocol: "noma-agent-gateway-v1", transports: ["api", "mcp", "webhook"], capabilities: config.platform.gatewayCapabilities() });
    return;
  }
  if (action === "list-ids" && method === "POST") {
    const input = await readJsonBody(req, config.maxBodyBytes);
    const agentId = stringInput(input, "agentId");
    ownedAgent(config, user, agentId);
    const documentId = stringInput(input, "documentId");
    requireGatewayAgentDocumentAccess(config, agentId, documentId, "list_ids");
    const document = await readDocument(config, documentId);
    const doc = parse(document.source, { filename: `${document.id}.noma` });
    const ids = [...walk(doc)].filter((node) => node.id).map((node) => ({ id: node.id!, aliases: node.aliases ?? [], type: node.type, line: node.pos?.line, endLine: node.endLine }));
    sendJson(res, 200, { documentId, versionHash: document.hash, ids });
    return;
  }
  if (action === "mcp" && method === "POST") {
    const input = await readJsonBody(req, config.maxBodyBytes);
    const requestId = input.id ?? null;
    if (input.jsonrpc !== "2.0") throw new HttpError(400, "MCP request must use JSON-RPC 2.0");
    if (input.method === "tools/list") {
      sendJson(res, 200, {
        jsonrpc: "2.0",
        id: requestId,
        result: {
          tools: config.platform.gatewayCapabilities().filter((capability) => capability.operation !== "webhook").map((capability) => ({
            name: capability.operation,
            description: `Noma Cloud ${capability.operation.replace("_", " ")} with ${capability.permission} scope`,
            inputSchema: { type: "object", additionalProperties: true },
          })),
        },
      });
      return;
    }
    if (input.method === "tools/call") {
      const params = optionalRecord(input.params, "params") ?? {};
      const name = stringInput(params, "name");
      const args = optionalRecord(params.arguments, "params.arguments") ?? {};
      const result = await callGatewayTool(name, args, config, principal, user);
      sendJson(res, 200, { jsonrpc: "2.0", id: requestId, result: { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result } });
      return;
    }
    throw new HttpError(400, "Unsupported MCP method");
  }
  if (action === "webhooks" && parts[3] && method === "POST") {
    const input = await readJsonBody(req, config.maxBodyBytes);
    const run: RecipeRun = { id: uniqueId(config), recipeId: parts[3], triggeredBy: user.id, triggerMode: "webhook", input, status: "planned", plan: [], mutationPolicy: "proof_proposal_only", startedAt: config.now().toISOString() };
    sendJson(res, 202, platformInput(() => config.platform.runRecipe(run)));
    return;
  }
  throw new HttpError(404, "Unknown gateway route");
}

async function callGatewayTool(
  name: string,
  args: Record<string, unknown>,
  config: CloudServerConfig,
  principal: Principal,
  user: CloudUserRecord,
): Promise<Record<string, unknown>> {
  const now = config.now().toISOString();
  if (name === "search" || name === "cited_answer") {
    const agentId = stringInput(args, "agentId");
    ownedAgent(config, user, agentId);
    const query = stringInput(args, "query").slice(0, 1_000);
    const siteId = optionalCloudId(args.siteId, "Site");
    const documents = knowledgeDocuments(config, user, siteId, agentId);
    if (name === "search") return { query, results: config.platform.search({ principalId: agentId, query, documents, now, limit: boundedInteger(args.limit, 12, 1, 100, "limit") }) };
    return config.platform.ask({ principalId: agentId, query, documents, now, limit: boundedInteger(args.limit, 8, 1, 25, "limit") }) as unknown as Record<string, unknown>;
  }
  if (name === "llm_export") {
    const agentId = stringInput(args, "agentId");
    ownedAgent(config, user, agentId);
    const siteId = optionalCloudId(args.siteId, "Site");
    const documents = knowledgeDocuments(config, user, siteId, agentId);
    return {
      documents: documents.map((access) => ({
        documentId: access.document.id,
        versionHash: access.document.hash,
        accessDecision: { principalId: agentId, allowed: true, role: access.role, via: access.via, decidedAt: now },
        context: renderLlm(parse(access.document.source, { filename: `${access.document.id}.noma` })),
      })),
    };
  }
  if (name === "list_ids") {
    const agentId = stringInput(args, "agentId");
    ownedAgent(config, user, agentId);
    const documentId = stringInput(args, "documentId");
    requireGatewayAgentDocumentAccess(config, agentId, documentId, "list_ids");
    const document = await readDocument(config, documentId);
    const doc = parse(document.source, { filename: `${document.id}.noma` });
    return { documentId, versionHash: document.hash, ids: [...walk(doc)].filter((node) => node.id).map((node) => ({ id: node.id!, aliases: node.aliases ?? [], type: node.type, line: node.pos?.line, endLine: node.endLine })) };
  }
  if (name === "proof" || name === "proposal") {
    const agentId = stringInput(args, "agentId");
    const documentId = stringInput(args, "documentId");
    ownedAgent(config, user, agentId);
    const grant = requireGatewayAgentDocumentAccess(config, agentId, documentId, "patch_block");
    if (grant.role !== "editor") throw new HttpError(403, "Agent editor access is required for patch proposals");
    const document = await readDocument(config, documentId);
    const ops = patchOpsInput(args.ops);
    const proof = createCloudPatchProof(config, document, ops);
    const proofRecord = { ...cloudProofRecord(proof), agentId };
    if (name === "proof" || !proof.canWrite) return { proof: proofRecord, proposed: false };
    const proposal: Omit<CloudPatchProposal, "proposedByName"> = {
      id: uniqueId(config),
      documentId,
      documentHash: document.hash,
      proposedBy: user.id,
      summary: optionalString(args.summary)?.slice(0, 500) ?? `Proposal from ${config.platform.readAgent(agentId)?.name ?? agentId}`,
      ops,
      proof: proofRecord,
      status: "pending",
      createdAt: now,
      updatedAt: now,
    };
    config.store.writePatchProposal(proposal);
    recordActivity(config, user, "patch.proposed", "document", documentId, { proposalId: proposal.id, agentId, transport: "mcp" });
    return { proposed: true, proposal: config.store.readPatchProposal(proposal.id) };
  }
  if (name === "review") {
    const documentId = stringInput(args, "documentId");
    const document = await readDocument(config, documentId);
    const access = requireRecordAccess(config, document, principal, "editor");
    requireAccessRole(access, "editor");
    const proposal = config.store.readPatchProposal(stringInput(args, "proposalId"));
    if (!proposal || proposal.documentId !== document.id) throw new HttpError(404, "Patch proposal not found");
    if (proposal.status !== "pending") throw new HttpError(409, "Only pending proposals can be reviewed");
    if (proposal.documentHash !== document.hash) throw stalePatchProposal(proposal, document);
    const decision = patchReviewDecision(args.decision);
    if (decision === "approved" && proposal.proposedBy === user.id) throw new HttpError(409, "A different collaborator must approve an agent patch");
    config.store.writePatchProposal({ ...proposal, status: decision, reviewedBy: user.id, reviewedAt: now, updatedAt: now });
    return { proposal: config.store.readPatchProposal(proposal.id) };
  }
  if (name === "apply") {
    const documentId = stringInput(args, "documentId");
    const document = await readDocument(config, documentId);
    const access = requireRecordAccess(config, document, principal, "editor");
    const proposal = config.store.readPatchProposal(stringInput(args, "proposalId"));
    if (!proposal || proposal.documentId !== document.id) throw new HttpError(404, "Patch proposal not found");
    if (proposal.status !== "approved") throw new HttpError(409, "The proposal must be approved before it can be applied");
    if (proposal.documentHash !== document.hash) throw stalePatchProposal(proposal, document);
    const proof = createCloudPatchProof(config, document, proposal.ops as PatchOp[]);
    if (!proof.canWrite || proof.preHash.sha256 !== proposal.documentHash) throw new HttpError(409, "Patch proof no longer matches the current document", { proof: cloudProofRecord(proof) });
    const updated = await updateDocument(config, document, { source: proof.postSource }, access);
    config.store.writePatchProposal({ ...proposal, status: "applied", appliedHash: updated.hash, updatedAt: now });
    return { proposal: config.store.readPatchProposal(proposal.id), document: documentResponse(updated, access) };
  }
  throw new HttpError(400, `Unknown gateway tool: ${name}`);
}

async function routeKnowledgeAnalytics(req: IncomingMessage, res: ServerResponse, config: CloudServerConfig, principal: Principal): Promise<void> {
  const user = requireUser(principal);
  const method = req.method ?? "GET";
  const documents = knowledgeDocuments(config, user);
  if (method === "GET") {
    sendJson(res, 200, config.platform.analytics(user.id, documents.map((item) => item.document.id)));
    return;
  }
  if (method === "POST") {
    const input = await readJsonBody(req, config.maxBodyBytes);
    const type = analyticsType(input.type);
    const documentId = optionalCloudId(input.documentId, "Document");
    if (documentId) await requireResourceAccess(config, principal, "document", documentId, "viewer");
    const event: AnalyticsEvent = {
      id: uniqueId(config),
      type,
      actorId: user.id,
      ...(documentId ? { documentId } : {}),
      ...(optionalString(input.query) ? { query: optionalString(input.query)?.slice(0, 1_000) } : {}),
      ...(typeof input.resultCount === "number" ? { resultCount: boundedInteger(input.resultCount, 0, 0, 1_000_000, "resultCount") } : {}),
      createdAt: config.now().toISOString(),
    };
    sendJson(res, 201, config.platform.recordAnalytics(event));
    return;
  }
  throw new HttpError(405, "Method not allowed");
}

async function routeBackup(req: IncomingMessage, res: ServerResponse, parts: string[], config: CloudServerConfig, principal: Principal): Promise<void> {
  const user = requireUser(principal);
  const method = req.method ?? "GET";
  const action = parts[2];
  if (method !== "POST") throw new HttpError(405, "Method not allowed");
  const input = await readJsonBody(req, config.maxBodyBytes);
  const siteId = optionalCloudId(input.siteId, "Site");
  const documents = knowledgeDocuments(config, user, siteId).map((item) => item.document);
  if (action === "export") {
    const requested = input.documentIds === undefined ? documents : documents.filter((document) => documentIdList(input.documentIds).includes(document.id));
    const gitInput = optionalRecord(input.git, "git");
    const git = gitInput ? { repository: stringInput(gitInput, "repository"), branch: stringInput(gitInput, "branch"), pullRequestReview: gitInput.pullRequestReview === true } : undefined;
    sendJson(res, 200, config.platform.exportBackup(requested, config.now().toISOString(), git));
    return;
  }
  if (action === "import") {
    const bundle = backupBundleInput(input.bundle);
    const plan = config.platform.planBackupImport(bundle, documents);
    if (input.apply !== true || plan.conflicts.length > 0) {
      sendJson(res, plan.conflicts.length > 0 ? 409 : 200, { applied: false, plan });
      return;
    }
    const now = config.now().toISOString();
    const created: string[] = [];
    const updated: string[] = [];
    for (const file of plan.create) {
      if (config.store.hasRecordId(file.documentId)) throw new HttpError(409, `Backup document ID already exists: ${file.documentId}`);
      const inspection = inspectSource(file.source, file.documentId);
      const record: CloudDocumentRecord = {
        version: 2,
        id: file.documentId,
        title: file.title,
        source: file.source,
        hash: inspection.hash,
        createdAt: now,
        updatedAt: now,
        createdBy: user.id,
        updatedBy: user.id,
        permissions: { [user.id]: { role: "owner", addedAt: now } },
        shareLinks: [],
      };
      await writeDocument(config, record);
      created.push(record.id);
    }
    for (const item of plan.update) {
      const existing = await readDocument(config, item.file.documentId);
      const access = requireRecordAccess(config, existing, principal, "editor");
      if (existing.hash !== item.expectedHash) throw new HttpError(409, "Backup import precondition changed", { documentId: existing.id, currentHash: existing.hash });
      await updateDocument(config, existing, { source: item.file.source, title: item.file.title }, access);
      updated.push(existing.id);
    }
    sendJson(res, 200, { applied: true, created, updated, unchanged: plan.unchanged, pullRequestReview: plan.pullRequestReview });
    return;
  }
  throw new HttpError(404, "Unknown backup route");
}

async function routeOffline(req: IncomingMessage, res: ServerResponse, parts: string[], config: CloudServerConfig, principal: Principal): Promise<void> {
  const user = requireUser(principal);
  const method = req.method ?? "GET";
  const action = parts[2];
  const draftId = parts[3];
  const subaction = parts[4];
  if (action !== "drafts") throw new HttpError(404, "Unknown offline route");
  if (!draftId && method === "GET") {
    sendJson(res, 200, { drafts: config.platform.listOfflineDrafts(user.id) });
    return;
  }
  if (!draftId && method === "POST") {
    const input = await readJsonBody(req, config.maxBodyBytes);
    const documentId = stringInput(input, "documentId");
    await requireResourceAccess(config, principal, "document", documentId, "editor");
    const now = config.now().toISOString();
    const draft: OfflineDraft = {
      id: uniqueId(config),
      userId: user.id,
      documentId,
      baseHash: shaInput(input.baseHash, "baseHash"),
      baseSource: stringInput(input, "baseSource"),
      source: stringInput(input, "source"),
      createdAt: now,
      updatedAt: now,
    };
    sendJson(res, 201, config.platform.saveOfflineDraft(draft));
    return;
  }
  if (draftId && subaction === "merge" && method === "POST") {
    const draft = config.platform.listOfflineDrafts(user.id).find((item) => item.id === draftId);
    if (!draft) throw new HttpError(404, "Offline draft not found");
    const document = await readDocument(config, draft.documentId);
    requireRecordAccess(config, document, principal, "editor");
    sendJson(res, 200, config.platform.mergeOfflineDraft(draft.id, document.source, document.hash, config.now().toISOString()));
    return;
  }
  throw new HttpError(404, "Unknown offline draft route");
}

async function routeRealtime(req: IncomingMessage, res: ServerResponse, url: URL, parts: string[], config: CloudServerConfig, principal: Principal): Promise<void> {
  const user = requireUser(principal);
  const method = req.method ?? "GET";
  if (parts[2] !== "documents" || parts[4] !== "operations") throw new HttpError(404, "Unknown realtime route");
  const documentId = stringPathPart(parts[3], "Document ID");
  const document = await readDocument(config, documentId);
  const access = requireRecordAccess(config, document, principal, method === "GET" ? "viewer" : "editor");
  if (method === "GET") {
    const after = boundedInteger(numberQuery(url.searchParams.get("after")), 0, 0, 1_000_000_000, "after");
    sendJson(res, 200, { operations: config.platform.realtimeOperations(documentId, after), currentHash: document.hash });
    return;
  }
  if (method === "POST") {
    const input = await readJsonBody(req, config.maxBodyBytes);
    requireDocumentPrecondition(req, document, input);
    const ops = patchOpsInput(input.ops);
    const proof = createCloudPatchProof(config, document, ops);
    if (!proof.canWrite || proof.preHash.sha256 !== document.hash) throw new HttpError(422, "Realtime operation proof failed", { proof: cloudProofRecord(proof) });
    const updated = await updateDocument(config, document, { source: proof.postSource }, access);
    const prior = config.platform.realtimeOperations(documentId);
    const operation: RealtimeOperation = {
      id: uniqueId(config),
      documentId,
      userId: user.id,
      actorType: "human",
      sequence: (prior.at(-1)?.sequence ?? 0) + 1,
      baseHash: document.hash,
      resultHash: updated.hash,
      operations: ops,
      affectedIds: [...new Set(ops.flatMap((op) => operationTargetIds(op)))],
      proofStatus: "pass",
      createdAt: config.now().toISOString(),
    };
    sendJson(res, 201, { operation: config.platform.recordRealtimeOperation(operation), document: documentResponse(updated, access) });
    return;
  }
  throw new HttpError(405, "Method not allowed");
}

async function routeEnterprise(req: IncomingMessage, res: ServerResponse, parts: string[], config: CloudServerConfig, principal: Principal): Promise<void> {
  const user = requireUser(principal);
  requireWorkspaceOwner(config, user);
  const method = req.method ?? "GET";
  const action = parts[2];
  if (!action && method === "GET") {
    sendJson(res, 200, config.platform.enterprisePolicy());
    return;
  }
  if (!action && method === "PUT") {
    const input = await readJsonBody(req, config.maxBodyBytes);
    const sso = optionalRecord(input.sso, "sso") ?? {};
    const scim = optionalRecord(input.scim, "scim") ?? {};
    const policy: EnterprisePolicy = {
      id: "workspace",
      sso: {
        enabled: sso.enabled === true,
        provider: sso.provider === "oidc" || sso.provider === "saml" ? sso.provider : "none",
        ...(optionalString(sso.issuer) ? { issuer: optionalString(sso.issuer) } : {}),
        enforced: sso.enforced === true,
      },
      scim: { enabled: scim.enabled === true, ...(optionalString(scim.baseUrl) ? { baseUrl: absoluteUrl(scim.baseUrl, "scim.baseUrl") } : {}) },
      retentionDays: boundedInteger(input.retentionDays, 365, 1, 36_500, "retentionDays"),
      legalHoldEnabled: input.legalHoldEnabled === true,
      dataResidency: stringInput(input, "dataResidency", "local").slice(0, 100),
      connectorAllowlist: connectorKinds(input.connectorAllowlist),
      modelAllowlist: requiredStringArray(input.modelAllowlist, "modelAllowlist", 100),
      requireZeroRetentionModels: input.requireZeroRetentionModels === true,
      auditExportEnabled: input.auditExportEnabled !== false,
      updatedAt: config.now().toISOString(),
      updatedBy: user.id,
    };
    if (policy.sso.enforced && !config.ssoTrustedHeaderHash) throw new HttpError(409, "Configure NOMA_CLOUD_SSO_TRUST_SECRET before enforcing SSO");
    sendJson(res, 200, platformInput(() => config.platform.setEnterprisePolicy(policy)));
    return;
  }
  if (action === "scim" && method === "GET") {
    sendJson(res, 200, { identities: config.platform.listScimIdentities() });
    return;
  }
  if (action === "scim" && method === "POST") {
    const input = await readJsonBody(req, config.maxBodyBytes);
    const identity: ScimIdentity = {
      id: stringInput(input, "id"),
      externalId: stringInput(input, "externalId"),
      userId: stringInput(input, "userId"),
      userName: stringInput(input, "userName"),
      active: input.active !== false,
      groups: optionalStringArray(input.groups, "groups", 500) ?? [],
      updatedAt: config.now().toISOString(),
    };
    sendJson(res, 201, platformInput(() => config.platform.upsertScimIdentity(identity, user.id)));
    return;
  }
  if (action === "legal-holds" && method === "GET") {
    sendJson(res, 200, { holds: config.platform.listLegalHolds() });
    return;
  }
  if (action === "legal-holds" && method === "POST") {
    const input = await readJsonBody(req, config.maxBodyBytes);
    const resourceType = input.resourceType === "document" || input.resourceType === "site" || input.resourceType === "user" ? input.resourceType : undefined;
    if (!resourceType) throw new HttpError(400, "resourceType must be document, site, or user");
    const hold: LegalHold = { id: uniqueId(config), resourceType, resourceId: stringInput(input, "resourceId"), reason: stringInput(input, "reason").slice(0, 2_000), createdBy: user.id, createdAt: config.now().toISOString() };
    sendJson(res, 201, platformInput(() => config.platform.putLegalHold(hold)));
    return;
  }
  if (action === "audit" && method === "GET") {
    const resources = [...config.store.listDocuments(user).map((document) => document.id), ...config.store.listSites(user).map((site) => site.id), "workspace"];
    sendJson(res, 200, platformInput(() => config.platform.exportAudit(user.id, resources)));
    return;
  }
  if (action === "retention" && method === "POST") {
    sendJson(res, 200, config.platform.enforceRetention(config.now().toISOString()));
    return;
  }
  throw new HttpError(404, "Unknown enterprise route");
}

async function routeNavigation(
  req: IncomingMessage,
  res: ServerResponse,
  parts: string[],
  config: CloudServerConfig,
  principal: Principal,
): Promise<void> {
  const method = req.method ?? "GET";
  const action = parts[2];
  const user = requireUser(principal);
  if (!action && method === "GET") {
    sendJson(res, 200, {
      recents: config.store.listRecents(user),
      favorites: config.store.listFavorites(user),
    });
    return;
  }
  if (action === "recent" && method === "POST") {
    const input = await readJsonBody(req, config.maxBodyBytes);
    const resourceType = resourceTypeInput(input.resourceType);
    const resourceId = resourceIdInput(input.resourceId, resourceType);
    await requireResourceAccess(config, principal, resourceType, resourceId, "viewer");
    config.store.recordRecent(user.id, resourceType, resourceId, config.now().toISOString());
    sendJson(res, 200, { ok: true });
    return;
  }
  if (action === "favorites" && (method === "PUT" || method === "DELETE")) {
    const input = await readJsonBody(req, config.maxBodyBytes);
    const resourceType = resourceTypeInput(input.resourceType);
    const resourceId = resourceIdInput(input.resourceId, resourceType);
    await requireResourceAccess(config, principal, resourceType, resourceId, "viewer");
    if (method === "PUT") config.store.setFavorite(user.id, resourceType, resourceId, config.now().toISOString());
    else config.store.removeFavorite(user.id, resourceType, resourceId);
    sendJson(res, 200, { ok: true });
    return;
  }
  throw new HttpError(404, "Unknown navigation route");
}

function routeTemplates(req: IncomingMessage, res: ServerResponse, config: CloudServerConfig, principal: Principal): void {
  if ((req.method ?? "GET") !== "GET") throw new HttpError(405, "Method not allowed");
  requireUser(principal);
  sendJson(res, 200, { templates: cloudPageTemplates, count: cloudPageTemplates.length, storage: "built-in" });
}

async function routeTrash(
  req: IncomingMessage,
  res: ServerResponse,
  parts: string[],
  config: CloudServerConfig,
  principal: Principal,
): Promise<void> {
  const method = req.method ?? "GET";
  const user = requireUser(principal);
  const rawType = parts[2];
  if (!rawType && method === "GET") {
    sendJson(res, 200, { items: config.store.listTrash(user) });
    return;
  }
  const resourceType = resourceTypeInput(rawType);
  const resourceId = resourceIdInput(parts[3], resourceType);
  const action = parts[4];
  if (method === "POST" && !action) {
    await requireResourceAccess(config, principal, resourceType, resourceId, resourceType === "site" ? "owner" : "editor", true);
    config.store.trashResource(resourceType, resourceId, config.now().toISOString(), user.id);
    config.store.removeFavorite(user.id, resourceType, resourceId);
    recordActivity(config, user, `${resourceType}.trashed`, resourceType, resourceId);
    sendJson(res, 200, { ok: true, resourceType, resourceId });
    return;
  }
  if (method === "POST" && action === "restore") {
    await requireResourceAccess(config, principal, resourceType, resourceId, resourceType === "site" ? "owner" : "editor", true);
    if (!config.store.isTrashed(resourceType, resourceId)) throw new HttpError(409, "Resource is not in trash");
    config.store.restoreResource(resourceType, resourceId);
    recordActivity(config, user, `${resourceType}.restored`, resourceType, resourceId);
    sendJson(res, 200, { ok: true, resourceType, resourceId });
    return;
  }
  throw new HttpError(404, "Unknown trash route");
}

async function routeNotifications(
  req: IncomingMessage,
  res: ServerResponse,
  parts: string[],
  config: CloudServerConfig,
  principal: Principal,
): Promise<void> {
  const method = req.method ?? "GET";
  const user = requireUser(principal);
  const id = parts[2];
  const action = parts[3];
  if (!id && method === "GET") {
    const notifications = config.store.listNotifications(user.id);
    sendJson(res, 200, { notifications, unread: notifications.filter((notification) => !notification.readAt).length });
    return;
  }
  if (id === "read-all" && method === "POST") {
    const changed = config.store.markAllNotificationsRead(user.id, config.now().toISOString());
    sendJson(res, 200, { ok: true, changed });
    return;
  }
  if (id && action === "read" && method === "POST") {
    if (!config.store.markNotificationRead(user.id, id, config.now().toISOString())) throw new HttpError(404, "Notification not found");
    sendJson(res, 200, { ok: true });
    return;
  }
  throw new HttpError(404, "Unknown notification route");
}

function routeActivity(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  config: CloudServerConfig,
  principal: Principal,
): void {
  if ((req.method ?? "GET") !== "GET") throw new HttpError(405, "Method not allowed");
  const user = requireUser(principal);
  const siteId = optionalCloudId(url.searchParams.get("site"), "Site");
  const documentId = optionalCloudId(url.searchParams.get("document"), "Document");
  const limit = boundedInteger(numberQuery(url.searchParams.get("limit")), 50, 1, 100, "limit");
  sendJson(res, 200, { events: config.store.listActivity(user, siteId, documentId, limit) });
}

async function routeGroups(
  req: IncomingMessage,
  res: ServerResponse,
  parts: string[],
  config: CloudServerConfig,
  principal: Principal,
): Promise<void> {
  const method = req.method ?? "GET";
  const user = requireUser(principal);
  const groupId = parts[2];
  const action = parts[3];
  const memberId = parts[4];
  if (!groupId && method === "GET") {
    sendJson(res, 200, { groups: config.store.listGroups(user.id) });
    return;
  }
  if (!groupId && method === "POST") {
    const input = await readJsonBody(req, config.maxBodyBytes);
    const now = config.now().toISOString();
    const group: Omit<CloudGroup, "members"> = {
      id: uniqueId(config),
      name: stringInput(input, "name").slice(0, 100),
      createdBy: user.id,
      createdAt: now,
      updatedAt: now,
    };
    try {
      config.store.createGroup(group, user.id);
    } catch (error) {
      if (sqliteConstraint(error)) throw new HttpError(409, "A group with this name already exists");
      throw error;
    }
    sendJson(res, 201, config.store.readGroup(group.id));
    return;
  }
  if (!groupId) throw new HttpError(404, "Group ID is required");
  assertCloudId(groupId, "Group");
  const group = config.store.readGroup(groupId);
  if (!group) throw new HttpError(404, "Group not found");
  const membership = group.members.find((member) => member.userId === user.id);
  if (!membership) throw new HttpError(403, "Group membership is required");
  if (!action && method === "GET") {
    sendJson(res, 200, group);
    return;
  }
  if (action === "members" && !memberId && method === "POST") {
    if (membership.role !== "manager") throw new HttpError(403, "Group manager access is required");
    const input = await readJsonBody(req, config.maxBodyBytes);
    const userId = stringInput(input, "userId");
    await readUser(config, userId);
    const role = input.role === "manager" ? "manager" : "member";
    config.store.addGroupMember(group.id, userId, role, config.now().toISOString());
    sendJson(res, 200, config.store.readGroup(group.id));
    return;
  }
  if (action === "members" && memberId && method === "DELETE") {
    if (membership.role !== "manager") throw new HttpError(403, "Group manager access is required");
    assertCloudId(memberId, "User");
    const target = group.members.find((member) => member.userId === memberId);
    if (!target) throw new HttpError(404, "Group member not found");
    if (target.role === "manager" && group.members.filter((member) => member.role === "manager").length === 1) {
      throw new HttpError(409, "A group must keep at least one manager");
    }
    config.store.removeGroupMember(group.id, memberId, config.now().toISOString());
    sendJson(res, 200, config.store.readGroup(group.id));
    return;
  }
  throw new HttpError(404, "Unknown group route");
}

async function routeProjects(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  parts: string[],
  config: CloudServerConfig,
  principal: Principal,
): Promise<void> {
  const method = req.method ?? "GET";
  const user = requireUser(principal);
  const projectId = parts[2];
  if (!projectId && method === "GET") {
    sendJson(res, 200, { projects: config.store.listProjects(user) });
    return;
  }
  if (!projectId && method === "POST") {
    const input = await readJsonBody(req, config.maxBodyBytes);
    const siteId = stringInput(input, "siteId");
    const site = await readSite(config, siteId);
    requireNotTrashed(config, "site", siteId);
    requireRecordAccess(config, site, principal, "editor");
    const now = config.now().toISOString();
    const project: CloudProject = {
      id: uniqueId(config),
      key: projectKeyInput(input.key),
      name: stringInput(input, "name").slice(0, 120),
      siteId,
      ...(optionalString(input.description) ? { description: optionalString(input.description)?.slice(0, 4_000) } : {}),
      createdBy: user.id,
      createdAt: now,
      updatedAt: now,
    };
    try {
      config.store.writeProject(project);
    } catch (error) {
      if (sqliteConstraint(error)) throw new HttpError(409, "Project key already exists");
      throw error;
    }
    sendJson(res, 201, { ...project, access: { role: config.store.resourceAccess(user.id, "site", siteId)?.role ?? "viewer" } });
    return;
  }
  if (!projectId) throw new HttpError(404, "Project ID or key is required");
  const project = config.store.readProject(projectId);
  if (!project) throw new HttpError(404, "Project not found");
  const access = requireProjectAccess(config, project, principal, "viewer");
  const resource = parts[3];
  const resourceId = parts[4];
  const subresource = parts[5];

  if (!resource && method === "GET") {
    sendJson(res, 200, { ...project, access: { role: access.role } });
    return;
  }
  if (!resource && method === "PATCH") {
    requireAccessRole(access, "editor");
    const input = await readJsonBody(req, config.maxBodyBytes);
    const next: CloudProject = {
      ...project,
      name: optionalString(input.name)?.slice(0, 120) ?? project.name,
      description: input.description === null ? undefined : optionalString(input.description)?.slice(0, 4_000) ?? project.description,
      updatedAt: config.now().toISOString(),
    };
    config.store.writeProject(next);
    sendJson(res, 200, { ...next, access: { role: access.role } });
    return;
  }
  if (resource === "issues") {
    await routeProjectIssues(req, res, url, resourceId, subresource, config, principal, user, project, access);
    return;
  }
  if (resource === "sprints") {
    await routeProjectSprints(req, res, resourceId, config, user, project, access);
    return;
  }
  if ((resource === "board" || resource === "backlog") && method === "GET") {
    const issues = config.store.listIssues(project.id, { limit: 500 });
    const sprints = config.store.listSprints(project.id);
    if (resource === "backlog") {
      sendJson(res, 200, {
        project,
        issues: issues.filter((issue) => !issue.sprintId && (issue.status === "backlog" || issue.status === "todo")),
        plannedSprints: sprints.filter((sprint) => sprint.status === "planned"),
      });
    } else {
      sendJson(res, 200, {
        project,
        columns: Object.fromEntries(issueStatuses.map((status) => [status, issues.filter((issue) => issue.status === status)])),
        activeSprint: sprints.find((sprint) => sprint.status === "active"),
      });
    }
    return;
  }
  throw new HttpError(404, "Unknown project route");
}

async function routeProjectIssues(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  issueId: string | undefined,
  subresource: string | undefined,
  config: CloudServerConfig,
  principal: Principal,
  user: CloudUserRecord,
  project: CloudProject,
  access: AccessContext,
): Promise<void> {
  const method = req.method ?? "GET";
  if (!issueId && method === "GET") {
    sendJson(res, 200, { issues: config.store.listIssues(project.id, issueFilterInput(url)) });
    return;
  }
  if (!issueId && method === "POST") {
    requireAccessRole(access, "editor");
    const input = await readJsonBody(req, config.maxBodyBytes);
    const assigneeId = await issueAssignee(config, project, input.assigneeId);
    const sprintId = issueSprint(config, project.id, input.sprintId);
    const parentId = issueParent(config, project.id, input.parentId);
    const now = config.now().toISOString();
    const issue = config.store.createIssue(
      {
        id: uniqueId(config),
        projectId: project.id,
        summary: stringInput(input, "summary").slice(0, 240),
        ...(optionalString(input.description) ? { description: optionalString(input.description)?.slice(0, 20_000) } : {}),
        type: issueTypeInput(input.type, "task"),
        status: issueStatusInput(input.status, "backlog"),
        priority: issuePriorityInput(input.priority, "medium"),
        reporterId: user.id,
        ...(assigneeId ? { assigneeId } : {}),
        labels: issueLabels(input.labels),
        ...(sprintId ? { sprintId } : {}),
        ...(parentId ? { parentId } : {}),
        ...(issueEstimate(input.estimate) === undefined ? {} : { estimate: issueEstimate(input.estimate) }),
        ...(issueDueDate(input.dueDate) ? { dueDate: issueDueDate(input.dueDate) } : {}),
        createdAt: now,
        updatedAt: now,
      },
      project.key,
    );
    recordIssueEvent(config, user, issue.id, "issue.created", { status: issue.status, assigneeId });
    sendJson(res, 201, issue);
    return;
  }
  if (!issueId) throw new HttpError(404, "Issue ID or key is required");
  const issue = config.store.readIssue(issueId);
  if (!issue || issue.projectId !== project.id) throw new HttpError(404, "Issue not found");
  if (subresource === "comments") {
    if (method === "GET") {
      sendJson(res, 200, { comments: config.store.listIssueComments(issue.id) });
      return;
    }
    if (method === "POST") {
      const input = await readJsonBody(req, config.maxBodyBytes);
      const now = config.now().toISOString();
      const comment: Omit<CloudIssueComment, "createdByName"> = {
        id: uniqueId(config),
        issueId: issue.id,
        body: stringInput(input, "body").slice(0, 10_000),
        createdBy: user.id,
        createdAt: now,
        updatedAt: now,
      };
      config.store.writeIssueComment(comment);
      recordIssueEvent(config, user, issue.id, "comment.created", { commentId: comment.id });
      sendJson(res, 201, config.store.listIssueComments(issue.id).find((item) => item.id === comment.id));
      return;
    }
  }
  if (subresource === "links") {
    if (method === "GET") {
      sendJson(res, 200, { links: config.store.listIssueLinks(issue.id) });
      return;
    }
    if (method === "POST") {
      requireAccessRole(access, "editor");
      const input = await readJsonBody(req, config.maxBodyBytes);
      const target = config.store.readIssue(stringInput(input, "targetIssueId"));
      if (!target) throw new HttpError(404, "Target issue not found");
      const targetProject = config.store.readProject(target.projectId);
      if (!targetProject) throw new HttpError(404, "Target project not found");
      requireProjectAccess(config, targetProject, principal, "viewer");
      if (target.id === issue.id) throw new HttpError(400, "An issue cannot link to itself");
      const link: Omit<CloudIssueLink, "targetIssueKey" | "targetIssueSummary"> = {
        id: uniqueId(config),
        sourceIssueId: issue.id,
        targetIssueId: target.id,
        type: issueLinkTypeInput(input.type),
        createdBy: user.id,
        createdAt: config.now().toISOString(),
      };
      try {
        config.store.writeIssueLink(link);
      } catch (error) {
        if (sqliteConstraint(error)) throw new HttpError(409, "This issue link already exists");
        throw error;
      }
      recordIssueEvent(config, user, issue.id, "link.created", { targetIssueId: target.id, type: link.type });
      sendJson(res, 201, config.store.listIssueLinks(issue.id).find((item) => item.id === link.id));
      return;
    }
  }
  if (subresource === "history" && method === "GET") {
    sendJson(res, 200, { events: config.store.listIssueEvents(issue.id) });
    return;
  }
  if (subresource) throw new HttpError(404, "Unknown issue route");
  if (method === "GET") {
    sendJson(res, 200, {
      ...issue,
      links: config.store.listIssueLinks(issue.id),
      comments: config.store.listIssueComments(issue.id),
      events: config.store.listIssueEvents(issue.id),
    });
    return;
  }
  if (method === "PATCH") {
    requireAccessRole(access, "editor");
    const input = await readJsonBody(req, config.maxBodyBytes);
    const nextStatus = input.status === undefined ? issue.status : issueStatusInput(input.status);
    if (nextStatus !== issue.status && !issueTransitions[issue.status].includes(nextStatus)) {
      throw new HttpError(409, `Issue cannot move from ${issue.status} to ${nextStatus}`);
    }
    const assigneeId = input.assigneeId === undefined ? issue.assigneeId : await issueAssignee(config, project, input.assigneeId);
    const sprintId = input.sprintId === undefined ? issue.sprintId : issueSprint(config, project.id, input.sprintId);
    const parentId = input.parentId === undefined ? issue.parentId : issueParent(config, project.id, input.parentId, issue.id);
    const next: CloudIssue = {
      ...issue,
      summary: optionalString(input.summary)?.slice(0, 240) ?? issue.summary,
      description: input.description === null ? undefined : optionalString(input.description)?.slice(0, 20_000) ?? issue.description,
      type: input.type === undefined ? issue.type : issueTypeInput(input.type),
      status: nextStatus,
      priority: input.priority === undefined ? issue.priority : issuePriorityInput(input.priority),
      assigneeId,
      labels: input.labels === undefined ? issue.labels : issueLabels(input.labels),
      sprintId,
      parentId,
      estimate: input.estimate === undefined ? issue.estimate : issueEstimate(input.estimate),
      dueDate: input.dueDate === undefined ? issue.dueDate : issueDueDate(input.dueDate),
      updatedAt: config.now().toISOString(),
    };
    config.store.writeIssue(next);
    recordIssueEvent(config, user, issue.id, "issue.updated", issueChanges(issue, next));
    sendJson(res, 200, config.store.readIssue(issue.id));
    return;
  }
  throw new HttpError(405, "Method not allowed");
}

async function routeProjectSprints(
  req: IncomingMessage,
  res: ServerResponse,
  sprintId: string | undefined,
  config: CloudServerConfig,
  user: CloudUserRecord,
  project: CloudProject,
  access: AccessContext,
): Promise<void> {
  const method = req.method ?? "GET";
  if (!sprintId && method === "GET") {
    sendJson(res, 200, { sprints: config.store.listSprints(project.id) });
    return;
  }
  if (!sprintId && method === "POST") {
    requireAccessRole(access, "editor");
    const input = await readJsonBody(req, config.maxBodyBytes);
    const now = config.now().toISOString();
    const status = sprintStatusInput(input.status, "planned");
    if (status === "closed") throw new HttpError(400, "New sprints must be planned or active");
    if (status === "active" && config.store.activeSprint(project.id)) throw new HttpError(409, "This project already has an active sprint");
    const sprint: CloudSprint = {
      id: uniqueId(config),
      projectId: project.id,
      name: stringInput(input, "name").slice(0, 160),
      ...(optionalString(input.goal) ? { goal: optionalString(input.goal)?.slice(0, 4_000) } : {}),
      status,
      ...(status === "active" ? { startAt: issueDateTime(input.startAt) ?? now } : {}),
      ...(issueDateTime(input.endAt) ? { endAt: issueDateTime(input.endAt) } : {}),
      createdBy: user.id,
      createdAt: now,
      updatedAt: now,
    };
    config.store.writeSprint(sprint);
    sendJson(res, 201, sprint);
    return;
  }
  if (!sprintId) throw new HttpError(404, "Sprint ID is required");
  const sprint = config.store.readSprint(sprintId);
  if (!sprint || sprint.projectId !== project.id) throw new HttpError(404, "Sprint not found");
  if (method === "GET") {
    sendJson(res, 200, sprint);
    return;
  }
  if (method === "PATCH") {
    requireAccessRole(access, "editor");
    const input = await readJsonBody(req, config.maxBodyBytes);
    const status = input.status === undefined ? sprint.status : sprintStatusInput(input.status);
    if (status !== sprint.status && !sprintTransitions[sprint.status].includes(status)) {
      throw new HttpError(409, `Sprint cannot move from ${sprint.status} to ${status}`);
    }
    if (status === "active" && config.store.activeSprint(project.id)) throw new HttpError(409, "This project already has an active sprint");
    const now = config.now().toISOString();
    const next: CloudSprint = {
      ...sprint,
      name: optionalString(input.name)?.slice(0, 160) ?? sprint.name,
      goal: input.goal === null ? undefined : optionalString(input.goal)?.slice(0, 4_000) ?? sprint.goal,
      status,
      startAt: status === "active" ? issueDateTime(input.startAt) ?? sprint.startAt ?? now : sprint.startAt,
      endAt: issueDateTime(input.endAt) ?? sprint.endAt,
      updatedAt: now,
    };
    if (status === "closed" && sprint.status !== "closed") config.store.closeSprint(next, now);
    else config.store.writeSprint(next);
    sendJson(res, 200, config.store.readSprint(sprint.id));
    return;
  }
  throw new HttpError(405, "Method not allowed");
}

async function routeUsers(
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

async function routeDocuments(
  req: IncomingMessage,
  res: ServerResponse,
  parts: string[],
  config: CloudServerConfig,
  principal: Principal,
): Promise<void> {
  const method = req.method ?? "GET";
  const id = parts[2];
  const suffix = parts[3];

  if (!id && method === "POST") {
    const user = requireUser(principal);
    const input = await readJsonBody(req, config.maxBodyBytes);
    const record = await createDocument(config, input, user);
    sendJson(res, 201, documentResponse(record, requireRecordAccess(config, record, principal, "owner")));
    return;
  }

  if (!id && method === "GET") {
    const user = requireUser(principal);
    sendJson(res, 200, { documents: await listDocuments(config, user) });
    return;
  }

  if (!id) throw new HttpError(404, "Document ID is required");

  const record = await readDocument(config, id);
  requireNotTrashed(config, "document", id);

  if (suffix === "collaborators") {
    await routeCollaborators(req, res, parts[4], config, principal, record, "document");
    return;
  }

  if (suffix === "group-collaborators") {
    await routeGroupCollaborators(req, res, parts[4], config, principal, record, "document");
    return;
  }

  if (suffix === "shares") {
    await routeShares(req, res, parts[4], config, principal, record, "document");
    return;
  }

  if (suffix === "revisions") {
    const access = requireRecordAccess(config, record, principal, "viewer");
    await routeDocumentRevisions(req, res, parts[4], parts[5], config, record, access);
    return;
  }

  if (suffix === "comments") {
    await routeDocumentComments(req, res, parts[4], parts[5], config, principal, record);
    return;
  }

  if (suffix === "approvals") {
    await routeDocumentApprovals(req, res, parts[4], config, principal, record);
    return;
  }

  if (suffix === "patch-proposals") {
    await routePatchProposals(req, res, parts[4], parts[5], config, principal, record);
    return;
  }

  if (suffix === "html" && method === "GET") {
    const access = requireRecordAccess(config, record, principal, "viewer");
    sendText(res, 200, renderDocumentHtml(record, access), "text/html; charset=utf-8");
    return;
  }

  if (suffix === "json" && method === "GET") {
    requireRecordAccess(config, record, principal, "viewer");
    sendText(res, 200, inspectSource(record.source, record.id).json, "application/json; charset=utf-8");
    return;
  }

  if (suffix === "llm" && method === "GET") {
    requireRecordAccess(config, record, principal, "viewer");
    sendText(res, 200, inspectSource(record.source, record.id).llm, "text/plain; charset=utf-8");
    return;
  }

  if (suffix) throw new HttpError(404, "Unknown document artifact");

  if (method === "GET") {
    const access = requireRecordAccess(config, record, principal, "viewer");
    if (access.user) config.store.recordRecent(access.user.id, "document", record.id, config.now().toISOString());
    sendJson(res, 200, documentResponse(record, access));
    return;
  }

  if (method === "PUT" || method === "PATCH") {
    const access = requireRecordAccess(config, record, principal, "editor");
    const input = await readJsonBody(req, config.maxBodyBytes);
    requireDocumentPrecondition(req, record, input);
    const updated = await updateDocument(config, record, input, access);
    sendJson(res, 200, documentResponse(updated, requireRecordAccess(config, updated, principal, "viewer")));
    return;
  }

  throw new HttpError(405, "Method not allowed");
}

async function routeSites(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  parts: string[],
  config: CloudServerConfig,
  principal: Principal,
): Promise<void> {
  const method = req.method ?? "GET";
  const id = parts[2];
  const suffix = parts[3];

  if (!id && method === "POST") {
    const user = requireUser(principal);
    const input = await readJsonBody(req, config.maxBodyBytes);
    const record = await createSite(config, input, user, principal);
    sendJson(res, 201, siteResponse(record, requireRecordAccess(config, record, principal, "owner")));
    return;
  }

  if (!id && method === "GET") {
    const user = requireUser(principal);
    sendJson(res, 200, { sites: await listSites(config, user) });
    return;
  }

  if (!id) throw new HttpError(404, "Site ID is required");

  const site = await readSite(config, id);
  requireNotTrashed(config, "site", id);

  if (suffix === "collaborators") {
    await routeCollaborators(req, res, parts[4], config, principal, site, "site");
    return;
  }

  if (suffix === "group-collaborators") {
    await routeGroupCollaborators(req, res, parts[4], config, principal, site, "site");
    return;
  }

  if (suffix === "shares") {
    await routeShares(req, res, parts[4], config, principal, site, "site");
    return;
  }

  if (suffix === "documents") {
    await routeSiteDocuments(req, res, parts, config, principal, site);
    return;
  }

  if (suffix === "wiki") {
    await routeSiteWiki(req, res, config, principal, site);
    return;
  }

  if (suffix) throw new HttpError(404, "Unknown site route");

  if (method === "GET") {
    const access = requireRecordAccess(config, site, principal, "viewer");
    if (access.user) config.store.recordRecent(access.user.id, "site", site.id, config.now().toISOString());
    const response = siteResponse(site, access);
    if (url.searchParams.get("include") === "documents") {
      sendJson(res, 200, {
        ...response,
        documents: await siteDocumentResponses(config, site, access),
      });
      return;
    }
    sendJson(res, 200, response);
    return;
  }

  if (method === "PUT" || method === "PATCH") {
    const access = requireRecordAccess(config, site, principal, "editor");
    const input = await readJsonBody(req, config.maxBodyBytes);
    const updated = await updateSite(config, site, input, access, principal);
    sendJson(res, 200, siteResponse(updated, requireRecordAccess(config, updated, principal, "viewer")));
    return;
  }

  throw new HttpError(405, "Method not allowed");
}

async function routeDatabase(
  req: IncomingMessage,
  res: ServerResponse,
  parts: string[],
  config: CloudServerConfig,
  principal: Principal,
): Promise<void> {
  const method = req.method ?? "GET";
  const action = parts[2];
  const user = requireUser(principal);

  if (action === "schema" && method === "GET") {
    sendJson(res, 200, {
      storage: "sqlite",
      resources: {
        documents: {
          filters: ["q", "siteId", "documentId"],
          fields: ["id", "title", "hash", "createdAt", "updatedAt", "createdBy", "updatedBy", "access.role", "source"],
          notes: "source is returned only when includeSource is true",
        },
        sites: {
          filters: ["q", "siteId"],
          fields: ["id", "title", "slug", "documentIds", "folders", "pageFolders", "createdAt", "updatedAt", "createdBy", "updatedBy", "access.role"],
        },
        blocks: {
          filters: ["q", "siteId", "documentId"],
          fields: ["rowKey", "documentId", "documentTitle", "id", "aliases", "type", "name", "title", "text", "line", "depth", "ordinal", "access.role"],
        },
        users: {
          filters: ["q"],
          fields: ["id", "name", "tokenPreview", "createdAt", "updatedAt"],
        },
      },
      query: {
        method: "POST",
        path: "/api/db/query",
        body: {
          resource: "documents | sites | blocks | users",
          q: "optional text search",
          siteId: "optional site filter",
          documentId: "optional document filter",
          includeSource: "boolean, documents only",
          limit: "1..100, default 25",
          offset: "0..10000, default 0",
        },
      },
    });
    return;
  }

  if (action === "query" && method === "POST") {
    const input = await readJsonBody(req, config.maxBodyBytes);
    sendJson(res, 200, config.store.query(user, databaseQueryInput(input)));
    return;
  }

  throw new HttpError(404, "Unknown database route");
}

async function routeSiteDocuments(
  req: IncomingMessage,
  res: ServerResponse,
  parts: string[],
  config: CloudServerConfig,
  principal: Principal,
  site: CloudSiteRecord,
): Promise<void> {
  const method = req.method ?? "GET";
  const docId = parts[4];

  if (!docId && method === "GET") {
    const access = requireRecordAccess(config, site, principal, "viewer");
    sendJson(res, 200, { documents: await siteDocumentResponses(config, site, access) });
    return;
  }

  if (!docId && method === "POST") {
    const access = requireRecordAccess(config, site, principal, "editor");
    const user = requireUser(principal);
    const input = await readJsonBody(req, config.maxBodyBytes);
    const document = await createDocument(config, input, user, site.title);
    const now = config.now().toISOString();
    const documentIds = [...site.documentIds, document.id];
    const pageFolders = pageFolderMap(site.pageFolders, documentIds);
    const folder = optionalFolderName(input.folder);
    if (folder) pageFolders[document.id] = folder;
    const nextSite: CloudSiteRecord = {
      ...site,
      documentIds,
      folders: normalizeSiteFolders(site.folders ?? [], pageFolders),
      pageFolders,
      updatedAt: now,
      updatedBy: access.user?.id ?? site.updatedBy,
    };
    await writeSite(config, nextSite);
    sendJson(res, 201, documentResponse(document, requireRecordAccess(config, document, principal, "owner")));
    return;
  }

  if (!docId) throw new HttpError(404, "Document ID is required");
  assertCloudId(docId, "Document");
  if (!site.documentIds.includes(docId)) throw new HttpError(404, "Document is not in this site");
  requireNotTrashed(config, "document", docId);

  if (parts[5] === "revisions") {
    const access = requireRecordAccess(config, site, principal, "viewer");
    await routeDocumentRevisions(req, res, parts[6], parts[7], config, await readDocument(config, docId), access);
    return;
  }

  if (parts[5] === "comments") {
    await routeDocumentComments(req, res, parts[6], parts[7], config, principal, await readDocument(config, docId), requireRecordAccess(config, site, principal, "viewer"));
    return;
  }

  if (parts[5] === "approvals") {
    await routeDocumentApprovals(req, res, parts[6], config, principal, await readDocument(config, docId), requireRecordAccess(config, site, principal, "viewer"));
    return;
  }

  if (parts[5] === "patch-proposals") {
    await routePatchProposals(
      req,
      res,
      parts[6],
      parts[7],
      config,
      principal,
      await readDocument(config, docId),
      requireRecordAccess(config, site, principal, "viewer"),
    );
    return;
  }

  if (method === "GET") {
    const access = requireRecordAccess(config, site, principal, "viewer");
    if (access.user) config.store.recordRecent(access.user.id, "document", docId, config.now().toISOString());
    sendJson(res, 200, documentResponse(await readDocument(config, docId), access));
    return;
  }

  if (method === "PUT" || method === "PATCH") {
    const access = requireRecordAccess(config, site, principal, "editor");
    const input = await readJsonBody(req, config.maxBodyBytes);
    const document = await readDocument(config, docId);
    requireDocumentPrecondition(req, document, input);
    const updated = await updateDocument(config, document, input, access);
    sendJson(res, 200, documentResponse(updated, access));
    return;
  }

  throw new HttpError(405, "Method not allowed");
}

async function routeDocumentRevisions(
  req: IncomingMessage,
  res: ServerResponse,
  revisionText: string | undefined,
  action: string | undefined,
  config: CloudServerConfig,
  document: CloudDocumentRecord,
  access: AccessContext,
): Promise<void> {
  const method = req.method ?? "GET";
  if (!revisionText && method === "GET") {
    sendJson(res, 200, { revisions: config.store.listDocumentRevisions(document.id) });
    return;
  }

  const revisionNumber = parseRevisionNumber(revisionText);
  const revision = config.store.readDocumentRevision(document.id, revisionNumber);
  if (!revision) throw new HttpError(404, "Document revision not found");

  if (!action && method === "GET") {
    sendJson(res, 200, revision);
    return;
  }

  if (action === "restore" && method === "POST") {
    requireAccessRole(access, "editor");
    const input = await readJsonBody(req, config.maxBodyBytes);
    requireDocumentPrecondition(req, document, input);
    const restored = await updateDocument(
      config,
      document,
      { title: revision.title, source: revision.source },
      access,
    );
    sendJson(res, 200, documentResponse(restored, access));
    return;
  }

  throw new HttpError(404, "Unknown document revision route");
}

async function routeDocumentComments(
  req: IncomingMessage,
  res: ServerResponse,
  commentId: string | undefined,
  action: string | undefined,
  config: CloudServerConfig,
  principal: Principal,
  document: CloudDocumentRecord,
  inheritedAccess?: AccessContext,
): Promise<void> {
  const method = req.method ?? "GET";
  const access = inheritedAccess ?? requireRecordAccess(config, document, principal, "viewer");
  const user = requireUser(principal);
  if (!commentId && method === "GET") {
    sendJson(res, 200, { comments: config.store.listComments(document.id) });
    return;
  }
  if (!commentId && method === "POST") {
    const input = await readJsonBody(req, config.maxBodyBytes);
    const body = stringInput(input, "body").slice(0, 10_000);
    const blockId = optionalString(input.blockId)?.slice(0, 160);
    const line = input.line === undefined ? undefined : boundedInteger(input.line, 1, 1, 1_000_000, "line");
    const parentId = optionalString(input.parentId);
    if (blockId && !documentHasBlock(document, blockId)) throw new HttpError(400, "Comment blockId does not exist in this document");
    if (parentId) {
      const parent = config.store.readComment(parentId);
      if (!parent || parent.documentId !== document.id) throw new HttpError(400, "Comment parentId does not exist in this document");
    }
    const now = config.now().toISOString();
    const comment: Omit<CloudComment, "createdByName"> = {
      id: uniqueId(config),
      documentId: document.id,
      ...(blockId ? { blockId } : {}),
      ...(line === undefined ? {} : { line }),
      ...(parentId ? { parentId } : {}),
      body,
      createdBy: user.id,
      createdAt: now,
      updatedAt: now,
    };
    config.store.writeComment(comment);
    notifyCommentParticipants(config, document, comment, user);
    recordActivity(config, user, parentId ? "comment.replied" : "comment.created", "document", document.id, {
      commentId: comment.id,
      blockId,
      line,
    });
    sendJson(res, 201, config.store.readComment(comment.id));
    return;
  }
  if (commentId && action === "resolve" && method === "POST") {
    const existing = config.store.readComment(commentId);
    if (!existing || existing.documentId !== document.id) throw new HttpError(404, "Comment not found");
    if (existing.createdBy !== user.id) requireAccessRole(access, "editor");
    const now = config.now().toISOString();
    config.store.writeComment({
      ...existing,
      updatedAt: now,
      resolvedAt: existing.resolvedAt ? undefined : now,
      resolvedBy: existing.resolvedAt ? undefined : user.id,
    });
    recordActivity(config, user, existing.resolvedAt ? "comment.reopened" : "comment.resolved", "document", document.id, {
      commentId,
    });
    sendJson(res, 200, config.store.readComment(commentId));
    return;
  }
  throw new HttpError(404, "Unknown comment route");
}

async function routeDocumentApprovals(
  req: IncomingMessage,
  res: ServerResponse,
  approvalId: string | undefined,
  config: CloudServerConfig,
  principal: Principal,
  document: CloudDocumentRecord,
  inheritedAccess?: AccessContext,
): Promise<void> {
  const method = req.method ?? "GET";
  const access = inheritedAccess ?? requireRecordAccess(config, document, principal, "viewer");
  const user = requireUser(principal);
  if (!approvalId && method === "GET") {
    sendJson(res, 200, { approvals: config.store.listApprovals(document.id) });
    return;
  }
  if (!approvalId && method === "POST") {
    requireAccessRole(access, "editor");
    const input = await readJsonBody(req, config.maxBodyBytes);
    const reviewerId = stringInput(input, "reviewerId");
    const reviewer = await readUser(config, reviewerId);
    if (!config.store.documentAccessRole(reviewerId, document.id)) throw new HttpError(400, "Reviewer needs access to this document or its space");
    if (
      config.store
        .listApprovals(document.id)
        .some((approval) => approval.reviewerId === reviewerId && approval.documentHash === document.hash && approval.status === "pending")
    ) {
      throw new HttpError(409, "This reviewer already has a pending approval for the current version");
    }
    const now = config.now().toISOString();
    const approval: Omit<CloudApproval, "reviewerName"> = {
      id: uniqueId(config),
      documentId: document.id,
      documentHash: document.hash,
      requestedBy: user.id,
      reviewerId,
      status: "pending",
      note: optionalString(input.note)?.slice(0, 4_000),
      createdAt: now,
      updatedAt: now,
    };
    config.store.writeApproval(approval);
    writeNotification(config, reviewer.id, "approval_requested", `Approval requested: ${document.title}`, `${user.name} requested your review.`, "document", document.id);
    recordActivity(config, user, "approval.requested", "document", document.id, { approvalId: approval.id, reviewerId, documentHash: document.hash });
    sendJson(res, 201, config.store.readApproval(approval.id));
    return;
  }
  if (approvalId && method === "PATCH") {
    const existing = config.store.readApproval(approvalId);
    if (!existing || existing.documentId !== document.id) throw new HttpError(404, "Approval not found");
    const input = await readJsonBody(req, config.maxBodyBytes);
    const status = approvalStatusInput(input.status);
    if (status === "approved" && document.hash !== existing.documentHash) {
      throw new HttpError(409, "This approval targets an older document version", {
        code: "approval_version_stale",
        approvalHash: existing.documentHash,
        currentHash: document.hash,
      });
    }
    if (status === "cancelled") {
      if (existing.requestedBy !== user.id) throw new HttpError(403, "Only the requester can cancel this approval");
    } else if (existing.reviewerId !== user.id) {
      throw new HttpError(403, "Only the assigned reviewer can update this approval");
    }
    const now = config.now().toISOString();
    config.store.writeApproval({
      ...existing,
      status,
      note: optionalString(input.note)?.slice(0, 4_000) ?? existing.note,
      updatedAt: now,
    });
    writeNotification(
      config,
      existing.requestedBy,
      "approval_updated",
      `Approval ${status.replace("_", " ")}: ${document.title}`,
      `${user.name} set the review to ${status.replace("_", " ")}.`,
      "document",
      document.id,
    );
    recordActivity(config, user, `approval.${status}`, "document", document.id, { approvalId, documentHash: existing.documentHash });
    sendJson(res, 200, config.store.readApproval(approvalId));
    return;
  }
  throw new HttpError(404, "Unknown approval route");
}

async function routePatchProposals(
  req: IncomingMessage,
  res: ServerResponse,
  proposalId: string | undefined,
  action: string | undefined,
  config: CloudServerConfig,
  principal: Principal,
  document: CloudDocumentRecord,
  inheritedAccess?: AccessContext,
): Promise<void> {
  const method = req.method ?? "GET";
  const access = inheritedAccess ?? requireRecordAccess(config, document, principal, "viewer");
  const user = requireUser(principal);
  if (!proposalId && method === "GET") {
    sendJson(res, 200, { proposals: config.store.listPatchProposals(document.id) });
    return;
  }
  if (!proposalId && method === "POST") {
    requireAccessRole(access, "editor");
    const input = await readJsonBody(req, config.maxBodyBytes);
    const ops = patchOpsInput(input.ops);
    const issueId = optionalString(input.issueId);
    const issue = issueId ? linkedPatchIssue(config, principal, document, issueId) : undefined;
    const proof = createCloudPatchProof(config, document, ops);
    const proofRecord = cloudProofRecord(proof);
    if (!proof.canWrite) throw new HttpError(422, "Patch proof failed", { proof: proofRecord });
    const now = config.now().toISOString();
    const proposal: Omit<CloudPatchProposal, "proposedByName"> = {
      id: uniqueId(config),
      documentId: document.id,
      documentHash: document.hash,
      ...(issue ? { issueId: issue.id } : {}),
      proposedBy: user.id,
      ...(optionalString(input.summary) ? { summary: optionalString(input.summary)?.slice(0, 500) } : {}),
      ops,
      proof: proofRecord,
      status: "pending",
      createdAt: now,
      updatedAt: now,
    };
    config.store.writePatchProposal(proposal);
    recordActivity(config, user, "patch.proposed", "document", document.id, { proposalId: proposal.id, issueId: issue?.id });
    if (issue) recordIssueEvent(config, user, issue.id, "patch.proposed", { proposalId: proposal.id, documentId: document.id, documentHash: document.hash });
    sendJson(res, 201, config.store.readPatchProposal(proposal.id));
    return;
  }
  if (!proposalId) throw new HttpError(404, "Patch proposal ID is required");
  assertCloudId(proposalId, "Patch proposal");
  const proposal = config.store.readPatchProposal(proposalId);
  if (!proposal || proposal.documentId !== document.id) throw new HttpError(404, "Patch proposal not found");
  if (!action && method === "GET") {
    sendJson(res, 200, proposal);
    return;
  }
  if (action === "review" && method === "POST") {
    requireAccessRole(access, "editor");
    if (proposal.status !== "pending") throw new HttpError(409, "Only pending proposals can be reviewed");
    if (document.hash !== proposal.documentHash) throw stalePatchProposal(proposal, document);
    const input = await readJsonBody(req, config.maxBodyBytes);
    const decision = patchReviewDecision(input.decision);
    if (decision === "approved" && proposal.proposedBy === user.id) {
      throw new HttpError(409, "A different collaborator must approve an agent patch");
    }
    const now = config.now().toISOString();
    config.store.writePatchProposal({ ...proposal, status: decision, reviewedBy: user.id, reviewedAt: now, updatedAt: now });
    recordActivity(config, user, `patch.${decision}`, "document", document.id, { proposalId: proposal.id, issueId: proposal.issueId });
    if (proposal.issueId) recordIssueEvent(config, user, proposal.issueId, `patch.${decision}`, { proposalId: proposal.id, documentId: document.id });
    sendJson(res, 200, config.store.readPatchProposal(proposal.id));
    return;
  }
  if (action === "apply" && method === "POST") {
    requireAccessRole(access, "editor");
    if (proposal.status !== "approved") throw new HttpError(409, "The proposal must be approved before it can be applied");
    if (document.hash !== proposal.documentHash) throw stalePatchProposal(proposal, document);
    const proof = createCloudPatchProof(config, document, proposal.ops as PatchOp[]);
    if (!proof.canWrite || proof.preHash.sha256 !== proposal.documentHash) {
      throw new HttpError(409, "Patch proof no longer matches the current document", { proof: cloudProofRecord(proof) });
    }
    const updated = await updateDocument(config, document, { source: proof.postSource }, access);
    const now = config.now().toISOString();
    config.store.writePatchProposal({ ...proposal, status: "applied", appliedHash: updated.hash, updatedAt: now });
    recordActivity(config, user, "patch.applied", "document", document.id, { proposalId: proposal.id, issueId: proposal.issueId, hash: updated.hash });
    if (proposal.issueId) {
      recordIssueEvent(config, user, proposal.issueId, "patch.applied", {
        proposalId: proposal.id,
        documentId: document.id,
        beforeHash: proposal.documentHash,
        afterHash: updated.hash,
      });
    }
    sendJson(res, 200, { proposal: config.store.readPatchProposal(proposal.id), document: documentResponse(updated, access) });
    return;
  }
  throw new HttpError(404, "Unknown patch proposal route");
}

async function siteDocumentResponses(
  config: CloudServerConfig,
  site: CloudSiteRecord,
  access: AccessContext,
): Promise<Array<Record<string, unknown> & SourceInspection>> {
  const visibleIds = site.documentIds.filter((id) => !config.store.isTrashed("document", id));
  return Promise.all(visibleIds.map(async (id) => documentResponse(await readDocument(config, id), access)));
}

async function routeSiteWiki(
  req: IncomingMessage,
  res: ServerResponse,
  config: CloudServerConfig,
  principal: Principal,
  site: CloudSiteRecord,
): Promise<void> {
  const method = req.method ?? "GET";
  if (method !== "GET") throw new HttpError(405, "Method not allowed");
  const access = requireRecordAccess(config, site, principal, "viewer");
  const visibleIds = site.documentIds.filter((id) => !config.store.isTrashed("document", id));
  const documents = await Promise.all(visibleIds.map((id) => readDocument(config, id)));
  const pages = documents.map(wikiPageSummary);
  const links = buildWikiLinks(documents);
  const backlinks = new Map<string, WikiLinkSummary[]>();
  for (const link of links) {
    if (!link.resolvedDocumentId) continue;
    const list = backlinks.get(link.resolvedDocumentId) ?? [];
    list.push(link);
    backlinks.set(link.resolvedDocumentId, list);
  }
  sendJson(res, 200, {
    site: {
      id: site.id,
      title: site.title,
      slug: site.slug,
      updatedAt: site.updatedAt,
      access: accessResponse(access),
    },
    pages,
    links,
    backlinks: Object.fromEntries(backlinks),
    missing: links.filter((link) => link.missing),
  });
}

async function routeCollaborators(
  req: IncomingMessage,
  res: ServerResponse,
  collaboratorId: string | undefined,
  config: CloudServerConfig,
  principal: Principal,
  record: CloudDocumentRecord | CloudSiteRecord,
  kind: "document" | "site",
): Promise<void> {
  const method = req.method ?? "GET";
  requireRecordAccess(config, record, principal, "owner");

  if (method === "GET") {
    sendJson(res, 200, { collaborators: Object.entries(record.permissions).map(([userId, permission]) => ({ userId, ...permission })) });
    return;
  }

  if (method === "POST") {
    const input = await readJsonBody(req, config.maxBodyBytes);
    const userId = stringInput(input, "userId");
    const role = collaboratorRole(input.role);
    await readUser(config, userId);
    if (userId === record.createdBy) throw new HttpError(400, "Owner already has owner access");
    const next = {
      ...record,
      permissions: {
        ...record.permissions,
        [userId]: { role, addedAt: config.now().toISOString() },
      },
      updatedAt: config.now().toISOString(),
      updatedBy: principal.user?.id ?? record.updatedBy,
    };
    if (kind === "document") await writeDocument(config, next as CloudDocumentRecord);
    else await writeSite(config, next as CloudSiteRecord);
    if (principal.user) recordActivity(config, principal.user, "permission.updated", kind, record.id, { userId, role });
    sendJson(res, 200, { collaborators: Object.entries(next.permissions).map(([id, permission]) => ({ userId: id, ...permission })) });
    return;
  }

  if (collaboratorId && method === "DELETE") {
    assertCloudId(collaboratorId, "User");
    if (collaboratorId === record.createdBy) throw new HttpError(409, "The resource owner cannot be removed");
    if (!record.permissions[collaboratorId]) throw new HttpError(404, "Collaborator not found");
    const permissions = { ...record.permissions };
    delete permissions[collaboratorId];
    const next = {
      ...record,
      permissions,
      updatedAt: config.now().toISOString(),
      updatedBy: principal.user?.id ?? record.updatedBy,
    };
    if (kind === "document") await writeDocument(config, next as CloudDocumentRecord);
    else await writeSite(config, next as CloudSiteRecord);
    if (principal.user) recordActivity(config, principal.user, "permission.removed", kind, record.id, { userId: collaboratorId });
    sendJson(res, 200, { collaborators: Object.entries(next.permissions).map(([id, permission]) => ({ userId: id, ...permission })) });
    return;
  }

  throw new HttpError(405, "Method not allowed");
}

async function routeGroupCollaborators(
  req: IncomingMessage,
  res: ServerResponse,
  groupId: string | undefined,
  config: CloudServerConfig,
  principal: Principal,
  record: CloudDocumentRecord | CloudSiteRecord,
  kind: CloudResourceType,
): Promise<void> {
  const method = req.method ?? "GET";
  const owner = requireRecordAccess(config, record, principal, "owner");
  if (!groupId && method === "GET") {
    sendJson(res, 200, { groups: config.store.listGroupPermissions(kind, record.id) });
    return;
  }
  if (!groupId && method === "POST") {
    const input = await readJsonBody(req, config.maxBodyBytes);
    const requestedGroupId = stringInput(input, "groupId");
    assertCloudId(requestedGroupId, "Group");
    const group = config.store.readGroup(requestedGroupId);
    if (!group) throw new HttpError(404, "Group not found");
    if (!group.members.some((member) => member.userId === owner.user?.id)) {
      throw new HttpError(403, "You must belong to a group before granting it access");
    }
    const role = collaboratorRole(input.role);
    const now = config.now().toISOString();
    config.store.setGroupPermission(kind, record.id, group.id, role, now);
    if (owner.user) recordActivity(config, owner.user, "group_permission.updated", kind, record.id, { groupId: group.id, role });
    sendJson(res, 200, { groups: config.store.listGroupPermissions(kind, record.id) });
    return;
  }
  if (groupId && method === "DELETE") {
    assertCloudId(groupId, "Group");
    if (!config.store.removeGroupPermission(kind, record.id, groupId)) throw new HttpError(404, "Group permission not found");
    if (owner.user) recordActivity(config, owner.user, "group_permission.removed", kind, record.id, { groupId });
    sendJson(res, 200, { groups: config.store.listGroupPermissions(kind, record.id) });
    return;
  }
  throw new HttpError(405, "Method not allowed");
}

async function routeShares(
  req: IncomingMessage,
  res: ServerResponse,
  shareId: string | undefined,
  config: CloudServerConfig,
  principal: Principal,
  record: CloudDocumentRecord | CloudSiteRecord,
  kind: "document" | "site",
): Promise<void> {
  const method = req.method ?? "GET";
  const user = requireUser(principal);
  const grant = config.store.resourceAccess(user.id, kind, record.id);
  if (!grant || roleRank[grant.role] < roleRank.editor) throw new HttpError(403, "editor access is required");
  const access: AccessContext = { role: grant.role, via: grant.via, user, ...(grant.groupId ? { groupId: grant.groupId } : {}) };

  if (method === "GET") {
    sendJson(res, 200, { shares: record.shareLinks.map(shareSummary) });
    return;
  }

  if (method === "POST") {
    const input = await readJsonBody(req, config.maxBodyBytes);
    const role = shareRole(input.role);
    const token = randomToken("ns");
    const now = config.now().toISOString();
    const share: CloudShareLink = {
      id: randomId(),
      role,
      tokenHash: sha256Hex(token),
      tokenPreview: tokenPreview(token),
      label: optionalString(input.label)?.slice(0, 80),
      createdBy: access.user?.id ?? "share",
      createdAt: now,
    };
    const next = {
      ...record,
      shareLinks: [...record.shareLinks, share],
      updatedAt: now,
      updatedBy: access.user?.id ?? record.updatedBy,
    };
    if (kind === "document") await writeDocument(config, next as CloudDocumentRecord);
    else await writeSite(config, next as CloudSiteRecord);
    recordActivity(config, user, "share.created", kind, record.id, { shareId: share.id, role });
    sendJson(res, 201, {
      ...shareSummary(share),
      token,
      url: kind === "document" ? `/workbench.html?doc=${record.id}&share=${token}` : `/s/${record.id}?share=${token}`,
      artifactUrl: kind === "document" ? `/d/${record.id}?share=${token}` : `/s/${record.id}?share=${token}`,
    });
    return;
  }

  if (shareId && method === "DELETE") {
    const existing = record.shareLinks.find((share) => share.id === shareId && !share.revokedAt);
    if (!existing) throw new HttpError(404, "Active share link not found");
    const now = config.now().toISOString();
    const next = {
      ...record,
      shareLinks: record.shareLinks.map((share) => (share.id === shareId ? { ...share, revokedAt: now } : share)),
      updatedAt: now,
      updatedBy: user.id,
    };
    if (kind === "document") await writeDocument(config, next as CloudDocumentRecord);
    else await writeSite(config, next as CloudSiteRecord);
    recordActivity(config, user, "share.revoked", kind, record.id, { shareId });
    sendJson(res, 200, { shares: next.shareLinks.map(shareSummary) });
    return;
  }

  throw new HttpError(405, "Method not allowed");
}

async function createUser(
  config: CloudServerConfig,
  input: Record<string, unknown>,
): Promise<{ record: CloudUserRecord; token: string }> {
  const token = randomToken("nu");
  const now = config.now().toISOString();
  const record: CloudUserRecord = {
    version: 1,
    id: randomId(),
    name: userName(input.name),
    tokenHash: sha256Hex(token),
    tokenPreview: tokenPreview(token),
    createdAt: now,
    updatedAt: now,
  };
  await writeUser(config, record);
  return { record, token };
}

async function createDocument(
  config: CloudServerConfig,
  input: Record<string, unknown>,
  user: CloudUserRecord,
  spaceTitle = "Noma Workspace",
): Promise<CloudDocumentRecord> {
  const id = uniqueId(config);
  const template = optionalString(input.templateId)
    ? cloudPageTemplates.find((candidate) => candidate.id === optionalString(input.templateId))
    : undefined;
  if (input.templateId !== undefined && !template) throw new HttpError(400, "Unknown page template");
  const requestedTitle = optionalString(input.title) ?? template?.title ?? "Untitled document";
  const source = sourceFromCreateInput(input, requestedTitle, spaceTitle);
  inspectSource(source, id);
  const now = config.now().toISOString();
  const record: CloudDocumentRecord = {
    version: 2,
    id,
    title: titleFromInput(template ? { ...input, title: requestedTitle } : input, source),
    source,
    hash: sha256Hex(source),
    createdAt: now,
    updatedAt: now,
    createdBy: user.id,
    updatedBy: user.id,
    permissions: {
      [user.id]: { role: "owner", addedAt: now },
    },
    shareLinks: [],
  };
  await writeDocument(config, record);
  recordActivity(config, user, "document.created", "document", record.id, { title: record.title });
  return record;
}

async function updateDocument(
  config: CloudServerConfig,
  existing: CloudDocumentRecord,
  input: Record<string, unknown>,
  access: AccessContext,
): Promise<CloudDocumentRecord> {
  const source = input.source === undefined ? existing.source : sourceFromInput(input);
  inspectSource(source, existing.id);
  const record: CloudDocumentRecord = {
    ...existing,
    title: titleFromInput(input, source, existing.title),
    source,
    hash: sha256Hex(source),
    updatedAt: config.now().toISOString(),
    updatedBy: access.user?.id ?? `share:${access.share?.id ?? "unknown"}`,
  };
  await writeDocument(config, record);
  if (access.user) recordActivity(config, access.user, "document.updated", "document", record.id, { hash: record.hash });
  return record;
}

async function createSite(
  config: CloudServerConfig,
  input: Record<string, unknown>,
  user: CloudUserRecord,
  principal: Principal,
): Promise<CloudSiteRecord> {
  const id = uniqueId(config);
  const title = stringInput(input, "title", "Untitled Noma Site").slice(0, 120);
  const documentIds = documentIdList(input.documentIds);
  const pageFolders = pageFolderMap(input.pageFolders, documentIds);
  await requireDocumentEditAccess(config, documentIds, principal);
  const now = config.now().toISOString();
  const record: CloudSiteRecord = {
    version: 1,
    id,
    title,
    slug: cloudSlug(title, id),
    documentIds,
    folders: normalizeSiteFolders(folderList(input.folders), pageFolders),
    pageFolders,
    createdAt: now,
    updatedAt: now,
    createdBy: user.id,
    updatedBy: user.id,
    permissions: {
      [user.id]: { role: "owner", addedAt: now },
    },
    shareLinks: [],
  };
  await writeSite(config, record);
  recordActivity(config, user, "site.created", "site", record.id, { title: record.title });
  return record;
}

async function updateSite(
  config: CloudServerConfig,
  existing: CloudSiteRecord,
  input: Record<string, unknown>,
  access: AccessContext,
  principal: Principal,
): Promise<CloudSiteRecord> {
  const title = optionalString(input.title)?.slice(0, 120) ?? existing.title;
  const documentIds = input.documentIds === undefined ? existing.documentIds : documentIdList(input.documentIds);
  const folders = input.folders === undefined ? existing.folders ?? [] : folderList(input.folders);
  const pageFolders = input.pageFolders === undefined ? existing.pageFolders ?? {} : pageFolderMap(input.pageFolders, documentIds);
  const addedDocumentIds = documentIds.filter((id) => !existing.documentIds.includes(id));
  await requireDocumentEditAccess(config, addedDocumentIds, principal);
  const normalizedFolders = normalizeSiteFolders(folders, pageFolders);
  const record: CloudSiteRecord = {
    ...existing,
    title,
    slug: optionalString(input.slug)?.slice(0, 80) ?? cloudSlug(title, existing.slug),
    documentIds,
    folders: normalizedFolders,
    pageFolders: pageFolderMap(pageFolders, documentIds),
    updatedAt: config.now().toISOString(),
    updatedBy: access.user?.id ?? `share:${access.share?.id ?? "unknown"}`,
  };
  await writeSite(config, record);
  if (access.user) recordActivity(config, access.user, "site.updated", "site", record.id, { title: record.title });
  return record;
}

async function requireDocumentEditAccess(config: CloudServerConfig, ids: string[], principal: Principal): Promise<void> {
  for (const id of ids) {
    requireRecordAccess(config, await readDocument(config, id), principal, "editor");
  }
}

async function listDocuments(config: CloudServerConfig, user: CloudUserRecord): Promise<Array<Record<string, unknown>>> {
  return config.store.listDocuments(user).map((record) => ({
    version: record.version,
    id: record.id,
    title: record.title,
    hash: record.hash,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    createdBy: record.createdBy,
    updatedBy: record.updatedBy,
    currentRole: record.currentRole,
  }));
}

async function listSites(config: CloudServerConfig, user: CloudUserRecord): Promise<Array<Record<string, unknown>>> {
  return config.store.listSites(user).map((record) => ({
    version: record.version,
    id: record.id,
    title: record.title,
    slug: record.slug,
    documentIds: record.documentIds,
    folders: record.folders,
    pageFolders: record.pageFolders,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    createdBy: record.createdBy,
    updatedBy: record.updatedBy,
    currentRole: record.currentRole,
  }));
}

async function listUsers(config: CloudServerConfig): Promise<CloudUserRecord[]> {
  return config.store.listUsers();
}

async function resolvePrincipal(config: CloudServerConfig, req: IncomingMessage, url: URL): Promise<Principal> {
  const userToken = authBearer(req) ?? headerValue(req, "x-noma-user-token");
  const shareToken = url.searchParams.get("share") ?? headerValue(req, "x-noma-share-token");
  const principal: Principal = {};
  if (userToken) {
    principal.userTokenHash = sha256Hex(userToken);
    principal.user = await findUserByToken(config, principal.userTokenHash);
  }
  if (shareToken) principal.shareTokenHash = sha256Hex(shareToken);
  return principal;
}

async function findUserByToken(config: CloudServerConfig, tokenHash: string): Promise<CloudUserRecord | undefined> {
  return config.store.findUserByToken(tokenHash);
}

function requireUser(principal: Principal): CloudUserRecord {
  if (!principal.user) throw new HttpError(401, "A cloud user token is required");
  return principal.user;
}

async function requireResourceAccess(
  config: CloudServerConfig,
  principal: Principal,
  resourceType: CloudResourceType,
  resourceId: string,
  minimum: CloudRole,
  allowTrashed = false,
): Promise<AccessContext> {
  const record = resourceType === "document" ? await readDocument(config, resourceId) : await readSite(config, resourceId);
  if (!allowTrashed) requireNotTrashed(config, resourceType, resourceId);
  return requireRecordAccess(config, record, principal, minimum);
}

function requireProjectAccess(
  config: CloudServerConfig,
  project: CloudProject,
  principal: Principal,
  minimum: CloudRole,
): AccessContext {
  const site = config.store.readSite(project.siteId);
  if (!site) throw new HttpError(404, "Project space not found");
  requireNotTrashed(config, "site", site.id);
  return requireRecordAccess(config, site, principal, minimum);
}

function requireNotTrashed(config: CloudServerConfig, resourceType: CloudResourceType, resourceId: string): void {
  if (config.store.isTrashed(resourceType, resourceId)) {
    throw new HttpError(410, `${resourceType === "document" ? "Document" : "Site"} is in trash`, {
      code: "resource_trashed",
      resourceType,
      resourceId,
    });
  }
}

function requireRecordAccess(
  config: CloudServerConfig,
  record: CloudDocumentRecord | CloudSiteRecord,
  principal: Principal,
  minimum: CloudRole,
): AccessContext {
  const access = recordAccess(config, record, principal);
  if (!access || roleRank[access.role] < roleRank[minimum]) {
    const status = principal.user || principal.shareTokenHash ? 403 : 401;
    throw new HttpError(access ? 403 : status, `${minimum} access is required`);
  }
  return access;
}

function requireAccessRole(access: AccessContext, minimum: CloudRole): void {
  if (roleRank[access.role] < roleRank[minimum]) throw new HttpError(403, `${minimum} access is required`);
}

function recordAccess(
  config: CloudServerConfig,
  record: CloudDocumentRecord | CloudSiteRecord,
  principal: Principal,
): AccessContext | undefined {
  let best: AccessContext | undefined;
  if (principal.user) {
    const grant = config.store.resourceAccess(principal.user.id, "source" in record ? "document" : "site", record.id);
    if (grant) {
      best = {
        role: grant.role,
        via: grant.via,
        user: principal.user,
        ...(grant.groupId ? { groupId: grant.groupId } : {}),
      };
    }
  }

  if (principal.shareTokenHash) {
    const share = record.shareLinks.find((item) => !item.revokedAt && item.tokenHash === principal.shareTokenHash);
    if (share && (!best || roleRank[share.role] > roleRank[best.role])) {
      best = { role: share.role, via: "share", user: principal.user, share };
    }
  }

  return best;
}

async function readDocument(config: CloudServerConfig, id: string): Promise<CloudDocumentRecord> {
  assertCloudId(id, "Document");
  const record = config.store.readDocument(id);
  if (!record) throw new HttpError(404, "Record not found");
  if (record.version === 2 && record.id === id && typeof record.source === "string") return record;
  throw new HttpError(500, "Stored document is invalid");
}

async function readSite(config: CloudServerConfig, id: string): Promise<CloudSiteRecord> {
  assertCloudId(id, "Site");
  const record = config.store.readSite(id);
  if (!record) throw new HttpError(404, "Record not found");
  if (record.version !== 1 || record.id !== id || !Array.isArray(record.documentIds)) {
    throw new HttpError(500, "Stored site is invalid");
  }
  return record;
}

async function readUser(config: CloudServerConfig, id: string): Promise<CloudUserRecord> {
  assertCloudId(id, "User");
  const record = config.store.readUser(id);
  if (!record) throw new HttpError(404, "Record not found");
  if (record.version !== 1 || record.id !== id || typeof record.tokenHash !== "string") {
    throw new HttpError(500, "Stored user is invalid");
  }
  return record;
}

async function writeDocument(config: CloudServerConfig, record: CloudDocumentRecord): Promise<void> {
  config.store.writeDocument(record);
}

async function writeSite(config: CloudServerConfig, record: CloudSiteRecord): Promise<void> {
  config.store.writeSite(record);
}

async function writeUser(config: CloudServerConfig, record: CloudUserRecord): Promise<void> {
  config.store.writeUser(record);
}

function documentResponse(record: CloudDocumentRecord, access: AccessContext): Record<string, unknown> & SourceInspection {
  return {
    version: record.version,
    id: record.id,
    title: record.title,
    source: record.source,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    createdBy: record.createdBy,
    updatedBy: record.updatedBy,
    ...inspectSource(record.source, record.id),
    access: accessResponse(access),
  };
}

function siteResponse(record: CloudSiteRecord, access: AccessContext): Record<string, unknown> {
  const pageFolders = pageFolderMap(record.pageFolders, record.documentIds);
  return {
    version: record.version,
    id: record.id,
    title: record.title,
    slug: record.slug,
    documentIds: record.documentIds,
    folders: normalizeSiteFolders(record.folders ?? [], pageFolders),
    pageFolders,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    createdBy: record.createdBy,
    updatedBy: record.updatedBy,
    access: accessResponse(access),
  };
}

function accessResponse(access: AccessContext): Record<string, unknown> {
  return {
    role: access.role,
    via: access.via,
    user: access.user ? publicUser(access.user) : undefined,
    shareId: access.share?.id,
    groupId: access.groupId,
  };
}

function wikiPageSummary(record: CloudDocumentRecord): WikiPageSummary {
  return {
    id: record.id,
    title: record.title,
    slug: cloudSlug(record.title, record.id),
    updatedAt: record.updatedAt,
  };
}

function buildWikiLinks(documents: CloudDocumentRecord[]): WikiLinkSummary[] {
  const pagesByKey = new Map<string, CloudDocumentRecord>();
  const blocksByKey = new Map<string, CloudDocumentRecord>();
  for (const document of documents) {
    for (const key of wikiPageKeys(document)) {
      if (!pagesByKey.has(key)) pagesByKey.set(key, document);
    }
    const doc = parse(document.source, { filename: `${document.id}.noma` });
    for (const node of walk(doc)) {
      for (const key of [node.id, ...(node.aliases ?? [])]) {
        if (key && !blocksByKey.has(wikiKey(key))) blocksByKey.set(wikiKey(key), document);
      }
    }
  }

  return documents.flatMap((document) =>
    extractWikilinks(stripFencedCode(document.source)).map((link) => {
      const baseTarget = link.target.split("#", 1)[0]?.trim() || link.target.trim();
      const resolved = pagesByKey.get(wikiKey(baseTarget)) ?? blocksByKey.get(wikiKey(baseTarget));
      return {
        fromDocumentId: document.id,
        fromTitle: document.title,
        target: link.target,
        label: link.label,
        ...(resolved ? { resolvedDocumentId: resolved.id, resolvedTitle: resolved.title } : {}),
        missing: !resolved,
      };
    }),
  );
}

function wikiPageKeys(record: CloudDocumentRecord): string[] {
  return [
    record.id,
    record.title,
    cloudSlug(record.title, record.id),
    sourceTitleForWiki(record.source),
    cloudSlug(sourceTitleForWiki(record.source), record.id),
  ].map(wikiKey);
}

function wikiKey(value: string): string {
  return value.trim().toLowerCase().replace(/\.noma$/i, "").replace(/\s+/g, " ");
}

function sourceTitleForWiki(source: string): string {
  return source.match(/^#\s+(.+)$/m)?.[1]?.replace(/\s+\{[^}]*\}\s*$/, "").trim() || "Untitled Page";
}

function stripFencedCode(source: string): string {
  return source.replace(/^```[\s\S]*?^```/gm, "");
}

function publicUser(user: CloudUserRecord): Omit<CloudUserRecord, "tokenHash"> {
  const { tokenHash, ...out } = user;
  return out;
}

function shareSummary(share: CloudShareLink): Omit<CloudShareLink, "tokenHash"> {
  const { tokenHash, ...out } = share;
  return out;
}

function renderDocumentHtml(record: CloudDocumentRecord, access?: AccessContext): string {
  const doc = parse(record.source, { filename: `${record.id}.noma` });
  const banner = access
    ? `<div class="noma-cloud-banner">Noma Cloud · ${escapeHtml(record.title)} · ${escapeHtml(access.role)} access</div>`
    : "";
  const html = renderHtml(doc, {
    standalone: true,
    allowEscapeHatches: false,
    externalAssets: false,
  });
  return banner ? html.replace("<body>", `<body>${banner}`) : html;
}

async function renderSiteHtml(config: CloudServerConfig, site: CloudSiteRecord, access: AccessContext): Promise<string> {
  const visibleIds = site.documentIds.filter((id) => !config.store.isTrashed("document", id));
  const documents = await Promise.all(visibleIds.map((id) => readDocument(config, id)));
  const articles = documents
    .map((record) => {
      const doc = parse(record.source, { filename: `${record.id}.noma` });
      const body = renderHtml(doc, {
        standalone: false,
        allowEscapeHatches: false,
        externalAssets: false,
        interactive: false,
      });
      return `<article class="site-doc" id="${escapeAttr(record.id)}"><header><h2>${escapeHtml(record.title)}</h2><a href="#${escapeAttr(record.id)}">Copy link</a></header>${body}</article>`;
    })
    .join("\n");
  const nav = documents
    .map((record) => `<a href="#${escapeAttr(record.id)}">${escapeHtml(record.title)}</a>`)
    .join("");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<link rel="icon" href="data:," />
<title>${escapeHtml(site.title)}</title>
<style>
body{margin:0;background:#f2f4f1;color:#20242a;font:15px/1.52 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
.shell{display:grid;grid-template-columns:minmax(180px,260px) minmax(0,1fr);min-height:100vh}
nav{position:sticky;top:0;height:100vh;overflow:auto;border-right:1px solid #d9ded8;background:linear-gradient(180deg,#fffdf8,#f7f8f4);padding:18px}
nav h1{font-size:1rem;margin:0 0 14px}nav a{display:block;color:#0f666b;text-decoration:none;margin:8px 0;font-weight:650}
main{padding:30px;max-width:980px}.meta{color:#5c6670;font-size:.85rem;margin-bottom:18px}
.site-doc{background:#fffefa;border:1px solid #d9ded8;border-radius:8px;padding:26px;margin:0 0 18px;box-shadow:0 22px 58px -48px rgba(32,36,42,.54)}
.site-doc>header{display:flex;align-items:center;justify-content:space-between;gap:14px;border-bottom:1px solid #e6dfd2;margin:-4px 0 18px;padding-bottom:12px}
.site-doc>header h2{margin:0;font-size:1rem}.site-doc>header a{color:#5c6670;font-size:.82rem}
.site-doc h1{font-size:2.1rem;line-height:1.08;margin:18px 0 18px}.site-doc h2{font-size:1.45rem;margin:28px 0 12px;border-bottom:1px solid #e6dfd2;padding-bottom:8px}.site-doc p{max-width:76ch}
.site-doc table{width:100%;border-collapse:collapse;margin:14px 0 20px;font-size:.94rem}.site-doc th,.site-doc td{border-bottom:1px solid #e6dfd2;padding:9px 10px;text-align:left;vertical-align:top}.site-doc th{background:#f2eee6;color:#20242a;font-weight:750}
.noma-research,.noma-block,.noma-custom-directive{border:1px solid #e0ded7;border-radius:8px;background:#fffefa;margin:16px 0;padding:16px 18px;box-shadow:0 14px 32px -30px rgba(32,36,42,.55)}
.noma-research{border-left:4px solid #2f7048}.noma-block-claim{border-left:4px solid #2f6fa7}.noma-block-evidence{border-left:4px solid #2f7048}.noma-block-counterevidence,.noma-block-risk{border-left:4px solid #9a681f}
.noma-research-head,.noma-block-head,.noma-technical-head,.noma-comment-head,.noma-review-meta-head{display:flex;align-items:center;gap:10px;margin-bottom:10px}.noma-tag{display:inline-flex;align-items:center;border-radius:999px;background:#e9f1ee;color:#0f666b;font-size:.72rem;font-weight:800;letter-spacing:.08em;text-transform:uppercase;padding:4px 9px}
.noma-confidence{width:140px;height:5px;border-radius:999px;background:#e4e1d8;overflow:hidden}.noma-confidence-bar{height:100%;background:linear-gradient(90deg,#a4573c,#2f6fa7)}
.noma-meta{color:#5c6670;font-size:.85rem;margin-top:10px}.noma-meta-key{color:#20242a;font-weight:720}.noma-block-body>*:first-child{margin-top:0}.noma-block-body>*:last-child{margin-bottom:0}
.noma-task{display:grid;grid-template-columns:auto minmax(0,1fr);gap:8px;align-items:start;margin:12px 0}.noma-task input{margin-top:.28em}
@media(max-width:760px){.shell{display:block}nav{position:static;height:auto}.site-doc{padding:16px}main{padding:18px}}
</style>
</head>
<body>
<div class="shell">
<nav><h1>${escapeHtml(site.title)}</h1>${nav}</nav>
<main><p class="meta">Noma Cloud site · ${escapeHtml(access.role)} access · updated ${escapeHtml(site.updatedAt)}</p>${articles}</main>
</div>
</body>
</html>`;
}

function inspectSource(source: string, id: string): SourceInspection {
  const doc = parse(source, { filename: `${id}.noma` });
  return {
    hash: sha256Hex(source),
    diagnostics: validate(doc),
    json: renderJson(doc),
    llm: renderLlm(doc),
  };
}

function uniqueId(config: CloudServerConfig): string {
  for (let attempt = 0; attempt < 12; attempt++) {
    const id = randomId();
    if (!config.store.hasRecordId(id)) return id;
  }
  throw new HttpError(500, "Could not allocate ID");
}

function randomId(): string {
  return randomUUID().replace(/-/g, "").slice(0, 18);
}

function randomToken(prefix: string): string {
  return `${prefix}_${randomBytes(24).toString("base64url")}`;
}

function tokenPreview(token: string): string {
  return token.slice(0, 5) + "..." + token.slice(-6);
}

function sourceFromInput(input: Record<string, unknown>): string {
  if (typeof input.source !== "string") throw new HttpError(400, "source must be a string");
  if (input.source.trim().length === 0) throw new HttpError(400, "source cannot be empty");
  return input.source;
}

function sourceFromCreateInput(input: Record<string, unknown>, title: string, spaceTitle: string): string {
  const templateId = optionalString(input.templateId);
  if (templateId) {
    try {
      return instantiateCloudPageTemplate(templateId, title, spaceTitle);
    } catch (error) {
      throw new HttpError(400, error instanceof Error ? error.message : "Unknown page template");
    }
  }
  const source = sourceFromInput(input);
  const format = optionalString(input.format)?.toLowerCase() ?? "noma";
  if (format === "noma") return source.replace(/\r\n?/g, "\n");
  if (format === "markdown" || format === "md") return convertMarkdownToNoma(source);
  throw new HttpError(400, "format must be noma or markdown");
}

function documentHasBlock(document: CloudDocumentRecord, blockId: string): boolean {
  const doc = parse(document.source, { filename: `${document.id}.noma` });
  for (const node of walk(doc)) {
    if (node.id === blockId || node.aliases?.includes(blockId)) return true;
  }
  return false;
}

function notifyCommentParticipants(
  config: CloudServerConfig,
  document: CloudDocumentRecord,
  comment: Omit<CloudComment, "createdByName">,
  actor: CloudUserRecord,
): void {
  const recipients = new Map<string, CloudNotification["type"]>();
  for (const match of comment.body.matchAll(/@\{([A-Za-z0-9_-]{8,80})\}/g)) {
    const userId = match[1];
    if (userId && userId !== actor.id && config.store.documentAccessRole(userId, document.id)) recipients.set(userId, "mention");
  }
  if (comment.parentId) {
    const parent = config.store.readComment(comment.parentId);
    if (parent && parent.createdBy !== actor.id) recipients.set(parent.createdBy, recipients.get(parent.createdBy) ?? "comment");
  } else if (document.createdBy !== actor.id) {
    recipients.set(document.createdBy, recipients.get(document.createdBy) ?? "comment");
  }
  for (const [userId, type] of recipients) {
    writeNotification(
      config,
      userId,
      type,
      type === "mention" ? `Mentioned in ${document.title}` : `New comment on ${document.title}`,
      `${actor.name}: ${comment.body.slice(0, 240)}`,
      "document",
      document.id,
    );
  }
}

function writeNotification(
  config: CloudServerConfig,
  userId: string,
  type: CloudNotification["type"],
  title: string,
  body: string,
  resourceType?: CloudResourceType,
  resourceId?: string,
): void {
  config.store.writeNotification({
    id: randomId(),
    userId,
    type,
    title,
    body,
    ...(resourceType ? { resourceType } : {}),
    ...(resourceId ? { resourceId } : {}),
    createdAt: config.now().toISOString(),
  });
}

function recordActivity(
  config: CloudServerConfig,
  actor: CloudUserRecord,
  action: string,
  resourceType: CloudResourceType,
  resourceId: string,
  detail: Record<string, unknown> = {},
): void {
  config.store.writeActivity({
    id: randomId(),
    actorId: actor.id,
    action,
    resourceType,
    resourceId,
    detail,
    createdAt: config.now().toISOString(),
  });
}

function approvalStatusInput(value: unknown): Exclude<CloudApprovalStatus, "pending"> {
  if (value === "approved" || value === "changes_requested" || value === "cancelled") return value;
  throw new HttpError(400, "status must be approved, changes_requested, or cancelled");
}

function sqliteConstraint(error: unknown): boolean {
  return Boolean(error && typeof error === "object" && "code" in error && String(error.code).startsWith("SQLITE_CONSTRAINT"));
}

function requireDocumentPrecondition(
  req: IncomingMessage,
  document: CloudDocumentRecord,
  input: Record<string, unknown>,
): void {
  if (input.expectedHash !== undefined && typeof input.expectedHash !== "string") {
    throw new HttpError(400, "expectedHash must be a SHA-256 string");
  }
  const bodyHash = optionalString(input.expectedHash);
  const headerHash = ifMatchHash(headerValue(req, "if-match"));
  if (bodyHash && headerHash && bodyHash !== headerHash) {
    throw new HttpError(400, "expectedHash and If-Match must agree");
  }
  const expectedHash = bodyHash ?? headerHash;
  if (!expectedHash) {
    throw new HttpError(428, "Document updates require expectedHash or If-Match", {
      code: "precondition_required",
      currentHash: document.hash,
    });
  }
  if (!/^[a-f0-9]{64}$/.test(expectedHash)) throw new HttpError(400, "expectedHash must be a lowercase SHA-256 hash");
  if (expectedHash !== document.hash) {
    throw new HttpError(409, "Document changed since it was loaded", {
      code: "document_conflict",
      expectedHash,
      currentHash: document.hash,
      currentUpdatedAt: document.updatedAt,
    });
  }
}

function ifMatchHash(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const match = /^(?:W\/)?"?([a-f0-9]{64})"?$/.exec(value.trim());
  if (!match?.[1]) throw new HttpError(400, "If-Match must contain one SHA-256 hash");
  return match[1];
}

function titleFromInput(input: Record<string, unknown>, source: string, fallback = "Untitled document"): string {
  const title = optionalString(input.title);
  if (title) return title.slice(0, 120);
  const heading = source.match(/^#\s+(.+)$/m)?.[1]?.replace(/\s+\{[^}]*\}\s*$/, "").trim();
  return heading ? heading.slice(0, 120) : fallback;
}

function cloudSlug(title: string, fallback: string): string {
  return (slugify(title) || fallback).slice(0, 80);
}

function userName(value: unknown): string {
  const name = optionalString(value);
  return name ? name.slice(0, 80) : "Noma collaborator";
}

function collaboratorRole(value: unknown): Exclude<CloudRole, "owner"> {
  if (value === "viewer" || value === "editor") return value;
  throw new HttpError(400, "role must be viewer or editor");
}

function shareRole(value: unknown): Exclude<CloudRole, "owner"> {
  return value === undefined ? "viewer" : collaboratorRole(value);
}

function databaseQueryInput(input: Record<string, unknown>): CloudDbQuery {
  const resource = databaseQueryResource(input.resource);
  return {
    resource,
    q: optionalString(input.q) ?? optionalString(input.text),
    siteId: optionalCloudId(input.siteId, "Site"),
    documentId: optionalCloudId(input.documentId, "Document"),
    includeSource: input.includeSource === true,
    limit: boundedInteger(input.limit, 25, 1, 100, "limit"),
    offset: boundedInteger(input.offset, 0, 0, 10_000, "offset"),
  };
}

function databaseQueryResource(value: unknown): CloudDbQuery["resource"] {
  if (value === "documents" || value === "sites" || value === "blocks" || value === "users") return value;
  throw new HttpError(400, "resource must be documents, sites, blocks, or users");
}

function optionalCloudId(value: unknown, label: string): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") throw new HttpError(400, `${label} ID must be a string`);
  assertCloudId(value, label);
  return value;
}

function resourceTypeInput(value: unknown): CloudResourceType {
  if (value === "document" || value === "site") return value;
  throw new HttpError(400, "resourceType must be document or site");
}

function resourceIdInput(value: unknown, resourceType: CloudResourceType): string {
  if (typeof value !== "string") throw new HttpError(400, "resourceId must be a string");
  assertCloudId(value, resourceType === "document" ? "Document" : "Site");
  return value;
}

function projectKeyInput(value: unknown): string {
  const key = optionalString(value)?.toUpperCase();
  if (!key || !/^[A-Z][A-Z0-9]{1,9}$/.test(key)) throw new HttpError(400, "Project key must be 2-10 letters or digits and start with a letter");
  return key;
}

function issueTypeInput(value: unknown, fallback?: CloudIssueType): CloudIssueType {
  if (value === undefined && fallback) return fallback;
  if (value === "task" || value === "story" || value === "bug" || value === "epic") return value;
  throw new HttpError(400, "type must be task, story, bug, or epic");
}

function issueStatusInput(value: unknown, fallback?: CloudIssueStatus): CloudIssueStatus {
  if (value === undefined && fallback) return fallback;
  if (typeof value === "string" && issueStatuses.includes(value as CloudIssueStatus)) return value as CloudIssueStatus;
  throw new HttpError(400, "status must be backlog, todo, in_progress, in_review, or done");
}

function issuePriorityInput(value: unknown, fallback?: CloudIssuePriority): CloudIssuePriority {
  if (value === undefined && fallback) return fallback;
  if (value === "lowest" || value === "low" || value === "medium" || value === "high" || value === "highest") return value;
  throw new HttpError(400, "priority must be lowest, low, medium, high, or highest");
}

function sprintStatusInput(value: unknown, fallback?: CloudSprintStatus): CloudSprintStatus {
  if (value === undefined && fallback) return fallback;
  if (value === "planned" || value === "active" || value === "closed") return value;
  throw new HttpError(400, "status must be planned, active, or closed");
}

function issueLinkTypeInput(value: unknown): CloudIssueLinkType {
  if (value === "blocks" || value === "duplicates") return value;
  if (value === undefined || value === "relates") return "relates";
  throw new HttpError(400, "type must be blocks, relates, or duplicates");
}

function issueFilterInput(url: URL): CloudIssueFilter {
  const sprint = url.searchParams.get("sprint");
  return {
    ...(optionalString(url.searchParams.get("q")) ? { q: optionalString(url.searchParams.get("q"))?.slice(0, 200) } : {}),
    ...(url.searchParams.has("status") ? { status: issueStatusInput(url.searchParams.get("status")) } : {}),
    ...(url.searchParams.has("type") ? { type: issueTypeInput(url.searchParams.get("type")) } : {}),
    ...(url.searchParams.has("priority") ? { priority: issuePriorityInput(url.searchParams.get("priority")) } : {}),
    ...(optionalString(url.searchParams.get("assignee")) ? { assigneeId: optionalString(url.searchParams.get("assignee")) } : {}),
    ...(optionalString(url.searchParams.get("label")) ? { label: optionalString(url.searchParams.get("label"))?.slice(0, 80) } : {}),
    ...(sprint === "none" ? { sprintId: null } : optionalString(sprint) ? { sprintId: optionalString(sprint) } : {}),
    limit: boundedInteger(numberQuery(url.searchParams.get("limit")), 200, 1, 500, "limit"),
  };
}

async function issueAssignee(config: CloudServerConfig, project: CloudProject, value: unknown): Promise<string | undefined> {
  if (value === null || value === "" || value === undefined) return undefined;
  if (typeof value !== "string") throw new HttpError(400, "assigneeId must be a user ID or null");
  const assignee = await readUser(config, value);
  if (!config.store.resourceAccess(assignee.id, "site", project.siteId)) throw new HttpError(400, "Assignee needs access to the project space");
  return assignee.id;
}

function issueSprint(config: CloudServerConfig, projectId: string, value: unknown): string | undefined {
  if (value === null || value === "" || value === undefined) return undefined;
  if (typeof value !== "string") throw new HttpError(400, "sprintId must be a sprint ID or null");
  const sprint = config.store.readSprint(value);
  if (!sprint || sprint.projectId !== projectId) throw new HttpError(400, "Sprint does not belong to this project");
  if (sprint.status === "closed") throw new HttpError(409, "Closed sprints cannot accept issues");
  return sprint.id;
}

function issueParent(config: CloudServerConfig, projectId: string, value: unknown, issueId?: string): string | undefined {
  if (value === null || value === "" || value === undefined) return undefined;
  if (typeof value !== "string") throw new HttpError(400, "parentId must be an issue ID or null");
  const parent = config.store.readIssue(value);
  if (!parent || parent.projectId !== projectId) throw new HttpError(400, "Parent issue does not belong to this project");
  if (parent.id === issueId) throw new HttpError(400, "An issue cannot be its own parent");
  if (parent.type !== "epic") throw new HttpError(400, "Parent issues must be epics");
  return parent.id;
}

function issueLabels(value: unknown): string[] {
  if (value === undefined) return [];
  const values = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : undefined;
  if (!values) throw new HttpError(400, "labels must be an array or comma-separated string");
  const labels = values.map((label) => {
    if (typeof label !== "string") throw new HttpError(400, "labels must contain strings");
    const normalized = label.trim().toLowerCase().replace(/\s+/g, "-").slice(0, 80);
    if (!normalized || !/^[a-z0-9][a-z0-9._-]*$/.test(normalized)) throw new HttpError(400, "labels may contain letters, digits, dots, underscores, and dashes");
    return normalized;
  });
  return [...new Set(labels)].slice(0, 20);
}

function issueEstimate(value: unknown): number | undefined {
  if (value === null || value === "" || value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 100_000) {
    throw new HttpError(400, "estimate must be a number between 0 and 100000");
  }
  return value;
}

function issueDueDate(value: unknown): string | undefined {
  if (value === null || value === "" || value === undefined) return undefined;
  const parsed = typeof value === "string" ? new Date(`${value}T00:00:00Z`) : undefined;
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
    !parsed ||
    Number.isNaN(parsed.getTime()) ||
    parsed.toISOString().slice(0, 10) !== value
  ) {
    throw new HttpError(400, "dueDate must be YYYY-MM-DD or null");
  }
  return value;
}

function issueDateTime(value: unknown): string | undefined {
  if (value === null || value === "" || value === undefined) return undefined;
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) throw new HttpError(400, "Sprint dates must be ISO date-time strings");
  return new Date(value).toISOString();
}

function issueChanges(before: CloudIssue, after: CloudIssue): Record<string, unknown> {
  const detail: Record<string, unknown> = {};
  for (const key of ["summary", "description", "type", "status", "priority", "assigneeId", "labels", "sprintId", "parentId", "estimate", "dueDate"] as const) {
    if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) detail[key] = { from: before[key], to: after[key] };
  }
  return detail;
}

function recordIssueEvent(
  config: CloudServerConfig,
  actor: CloudUserRecord,
  issueId: string,
  action: string,
  detail: Record<string, unknown> = {},
): void {
  config.store.writeIssueEvent({ id: randomId(), issueId, actorId: actor.id, action, detail, createdAt: config.now().toISOString() });
}

function patchOpsInput(value: unknown): PatchOp[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 100) throw new HttpError(400, "ops must be an array with 1-100 patch operations");
  for (const op of value) {
    if (!op || typeof op !== "object" || Array.isArray(op) || typeof (op as { op?: unknown }).op !== "string") {
      throw new HttpError(400, "Each patch operation must be an object with an op name");
    }
  }
  return value as PatchOp[];
}

function linkedPatchIssue(
  config: CloudServerConfig,
  principal: Principal,
  document: CloudDocumentRecord,
  issueId: string,
): CloudIssue {
  const issue = config.store.readIssue(issueId);
  if (!issue) throw new HttpError(404, "Linked issue not found");
  const project = config.store.readProject(issue.projectId);
  if (!project) throw new HttpError(404, "Linked issue project not found");
  requireProjectAccess(config, project, principal, "editor");
  const site = config.store.readSite(project.siteId);
  if (!site?.documentIds.includes(document.id)) throw new HttpError(400, "Linked issue must belong to the space containing this document");
  return issue;
}

function createCloudPatchProof(config: CloudServerConfig, document: CloudDocumentRecord, ops: PatchOp[]): AgentSafetyProof {
  return createAgentSafetyProof({
    filePath: join(config.dataDir, `${document.id}.noma`),
    source: document.source,
    ops,
    prevalidate: true,
    postvalidate: true,
    artifactOptions: { allowEscapeHatches: false, externalAssets: false, interactive: false },
  });
}

function cloudProofRecord(proof: AgentSafetyProof): Record<string, unknown> {
  return {
    status: proof.status,
    patchResult: proof.patchResult,
    canWrite: proof.canWrite,
    preHash: proof.preHash,
    postHash: proof.postHash,
    preValidation: proof.preValidation,
    postValidation: proof.postValidation,
    preDiagnostics: proof.preDiagnostics,
    postDiagnostics: proof.postDiagnostics,
    sourceMetrics: proof.sourceMetrics,
    diff: proof.diff,
    idRegistry: proof.idRegistry,
    artifactPreviewHtml: proof.artifactPreviewHtml,
    ...(proof.error ? { error: proof.error } : {}),
  };
}

function patchReviewDecision(value: unknown): "approved" | "rejected" {
  if (value === "approved" || value === "rejected") return value;
  throw new HttpError(400, "decision must be approved or rejected");
}

function stalePatchProposal(proposal: CloudPatchProposal, document: CloudDocumentRecord): HttpError {
  return new HttpError(409, "This patch proposal targets an older document version", {
    code: "patch_proposal_stale",
    proposalHash: proposal.documentHash,
    currentHash: document.hash,
  });
}

function numberQuery(value: string | null): number | undefined {
  if (value === null || value === "") return undefined;
  return Number(value);
}

function boundedInteger(value: unknown, fallback: number, min: number, max: number, label: string): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value)) throw new HttpError(400, `${label} must be an integer`);
  if (value < min || value > max) throw new HttpError(400, `${label} must be between ${min} and ${max}`);
  return value;
}

function documentIdList(value: unknown): string[] {
  if (!Array.isArray(value)) throw new HttpError(400, "documentIds must be an array");
  const ids = value.map((item) => {
    if (typeof item !== "string") throw new HttpError(400, "documentIds must contain strings");
    assertCloudId(item, "Document");
    return item;
  });
  return [...new Set(ids)];
}

function folderList(value: unknown): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new HttpError(400, "folders must be an array");
  return uniqueFolderNames(value.map(optionalFolderName).filter((folder): folder is string => Boolean(folder)));
}

function pageFolderMap(value: unknown, documentIds: string[]): Record<string, string> {
  if (value === undefined) return {};
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new HttpError(400, "pageFolders must be an object");
  const allowedDocumentIds = new Set(documentIds);
  const next: Record<string, string> = {};
  for (const [documentId, rawFolder] of Object.entries(value as Record<string, unknown>)) {
    assertCloudId(documentId, "Document");
    if (!allowedDocumentIds.has(documentId)) continue;
    const folder = optionalFolderName(rawFolder);
    if (folder) next[documentId] = folder;
  }
  return next;
}

function normalizeSiteFolders(folders: string[], pageFolders: Record<string, string>): string[] {
  return uniqueFolderNames([...folders, ...Object.values(pageFolders)]);
}

function uniqueFolderNames(folders: string[]): string[] {
  const seen = new Set<string>();
  const next: string[] = [];
  for (const folder of folders) {
    const key = folder.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    next.push(folder);
  }
  return next.slice(0, 80);
}

function optionalFolderName(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const folder = value
    .replace(/\\/g, "/")
    .split("/")
    .map((part) => part.trim().replace(/\s+/g, " "))
    .filter(Boolean)
    .join("/")
    .slice(0, 80);
  return folder || undefined;
}

function knowledgeDocuments(config: CloudServerConfig, user: CloudUserRecord, siteId?: string, agentId?: string): KnowledgeDocumentAccess[] {
  let summaries = config.store.listDocuments(user, 10_000);
  if (siteId) {
    if (!config.store.resourceAccess(user.id, "site", siteId)) throw new HttpError(403, "Site access is required");
    const site = config.store.readSite(siteId);
    if (!site) throw new HttpError(404, "Site not found");
    const siteDocuments = new Set(site.documentIds);
    summaries = summaries.filter((summary) => siteDocuments.has(summary.id));
  }
  let agentGrants: AgentAccessGrant[] | undefined;
  if (agentId) {
    const agent = ownedAgent(config, user, agentId);
    if (agent.status !== "active") throw new HttpError(403, "Agent identity is not active");
    agentGrants = config.platform.listAgentAccess(agentId);
  }
  const access: KnowledgeDocumentAccess[] = [];
  for (const summary of summaries) {
    if (config.store.isTrashed("document", summary.id)) continue;
    const humanAccess = config.store.resourceAccess(user.id, "document", summary.id);
    if (!humanAccess) continue;
    let role = humanAccess.role;
    let via: KnowledgeDocumentAccess["via"] = humanAccess.via;
    if (agentGrants) {
      const direct = agentGrants.find((grant) => grant.resourceType === "document" && grant.resourceId === summary.id);
      const siteGrant = agentGrants.find((grant) => grant.resourceType === "site" && config.store.readSite(grant.resourceId)?.documentIds.includes(summary.id));
      const agentAccess = direct ?? siteGrant;
      if (!agentAccess) continue;
      role = agentAccess.role;
      via = "agent";
    }
    const document = config.store.readDocument(summary.id);
    if (document) access.push({ document, role, via });
  }
  return access;
}

function optionalStringArray(value: unknown, label: string, max: number): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new HttpError(400, `${label} must be an array`);
  const items = value.map((item) => {
    if (typeof item !== "string" || !item.trim()) throw new HttpError(400, `${label} must contain non-empty strings`);
    return item.trim().slice(0, 1_000);
  });
  if (items.length > max) throw new HttpError(400, `${label} cannot contain more than ${max} items`);
  return [...new Set(items)];
}

function requiredStringArray(value: unknown, label: string, max: number): string[] {
  const items = optionalStringArray(value, label, max);
  if (!items || items.length === 0) throw new HttpError(400, `${label} must contain at least one item`);
  return items;
}

function optionalRecord(value: unknown, label: string): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new HttpError(400, `${label} must be an object`);
  return value as Record<string, unknown>;
}

function scalarRecord(value: unknown, label: string): Record<string, string | number | boolean> {
  const record = optionalRecord(value, label) ?? {};
  const result: Record<string, string | number | boolean> = {};
  for (const [key, item] of Object.entries(record)) {
    if (typeof item !== "string" && typeof item !== "number" && typeof item !== "boolean") throw new HttpError(400, `${label}.${key} must be a string, number, or boolean`);
    result[key] = item;
  }
  return result;
}

function boundedNumber(value: unknown, fallback: number, min: number, max: number, label: string): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value)) throw new HttpError(400, `${label} must be a finite number`);
  if (value < min || value > max) throw new HttpError(400, `${label} must be between ${min} and ${max}`);
  return value;
}

function stringPathPart(value: string | undefined, label: string): string {
  if (!value) throw new HttpError(400, `${label} is required`);
  return value;
}

function optionalIsoDate(value: unknown, label: string): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) throw new HttpError(400, `${label} must be an ISO date`);
  return value;
}

function requiredIsoDate(value: unknown, label: string): string {
  const date = optionalIsoDate(value, label);
  if (!date) throw new HttpError(400, `${label} is required`);
  return date;
}

function ragEvaluationFixtures(value: unknown): RagEvaluationFixture[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 500) throw new HttpError(400, "fixtures must be an array with 1-500 entries");
  return value.map((item, index) => {
    const record = optionalRecord(item, `fixtures[${index}]`)!;
    return {
      id: stringInput(record, "id"),
      query: stringInput(record, "query"),
      requiredSources: evaluationSources(record.requiredSources, `fixtures[${index}].requiredSources`),
      forbiddenSources: evaluationSources(record.forbiddenSources, `fixtures[${index}].forbiddenSources`),
      ...(record.expectAbstention === undefined ? {} : { expectAbstention: record.expectAbstention === true }),
      ...(typeof record.maxLatencyMs === "number" ? { maxLatencyMs: boundedNumber(record.maxLatencyMs, 0, 0, 3_600_000, "maxLatencyMs") } : {}),
      ...(typeof record.maxCostUsd === "number" ? { maxCostUsd: boundedNumber(record.maxCostUsd, 0, 0, 1_000_000, "maxCostUsd") } : {}),
    };
  });
}

function evaluationSources(value: unknown, label: string): Array<{ documentId: string; blockId?: string }> | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new HttpError(400, `${label} must be an array`);
  return value.map((item, index) => {
    const record = optionalRecord(item, `${label}[${index}]`)!;
    return { documentId: stringInput(record, "documentId"), ...(optionalString(record.blockId) ? { blockId: optionalString(record.blockId) } : {}) };
  });
}

function platformInput<T>(operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    throw new HttpError(409, error instanceof Error ? error.message : "Platform operation failed");
  }
}

function platformForbidden<T>(operation: () => T): T {
  try {
    return operation();
  } catch (error) {
    throw new HttpError(403, error instanceof Error ? error.message : "Agent authorization failed");
  }
}

function ownedAgent(config: CloudServerConfig, user: CloudUserRecord, agentId: string): CloudAgentIdentity {
  const agent = config.platform.readAgent(agentId);
  if (!agent) throw new HttpError(404, "Agent not found");
  if (agent.createdBy !== user.id) throw new HttpError(403, "Agent owner access is required");
  return agent;
}

function requireGatewayAgentDocumentAccess(config: CloudServerConfig, agentId: string, documentId: string, capability: string): AgentAccessGrant {
  const agent = config.platform.readAgent(agentId);
  if (!agent || agent.status !== "active") throw new HttpError(403, "Agent identity is not active");
  if (!agent.capabilities.includes(capability)) throw new HttpError(403, `Agent lacks capability: ${capability}`);
  const grants = config.platform.listAgentAccess(agentId);
  const direct = grants.find((grant) => grant.resourceType === "document" && grant.resourceId === documentId);
  const inherited = grants.find((grant) => grant.resourceType === "site" && config.store.readSite(grant.resourceId)?.documentIds.includes(documentId));
  const grant = direct ?? inherited;
  if (!grant) throw new HttpError(403, "Agent has no explicit page or space grant for this document");
  return grant;
}

function agentRunTrigger(value: unknown): AgentRun["trigger"] {
  if (value === "scheduled" || value === "event" || value === "webhook") return value;
  if (value === undefined || value === "manual") return "manual";
  throw new HttpError(400, "trigger must be manual, scheduled, event, or webhook");
}

function connectorKind(value: unknown): ConnectorKind {
  if (value === "github" || value === "slack" || value === "google_drive" || value === "jira" || value === "linear" || value === "filesystem") return value;
  throw new HttpError(400, "Unsupported connector kind");
}

function connectorKinds(value: unknown): ConnectorKind[] {
  return requiredStringArray(value, "connectorAllowlist", 6).map(connectorKind);
}

function visibleConnector(config: CloudServerConfig, user: CloudUserRecord, connectorId: string): KnowledgeConnector {
  const connector = config.platform.listConnectors().find((item) => item.id === connectorId);
  if (!connector) throw new HttpError(404, "Connector not found");
  if (connector.createdBy !== user.id && (!connector.siteId || !config.store.resourceAccess(user.id, "site", connector.siteId))) throw new HttpError(403, "Connector access is required");
  return connector;
}

function permissionLineage(value: unknown): ConnectorSourceRecord["upstreamPermissions"] {
  if (!Array.isArray(value)) throw new HttpError(400, "upstreamPermissions must be an array");
  return value.map((item, index) => {
    const record = optionalRecord(item, `upstreamPermissions[${index}]`)!;
    return { principal: stringInput(record, "principal"), role: stringInput(record, "role") };
  });
}

function absoluteUrl(value: unknown, label: string): string {
  if (typeof value !== "string") throw new HttpError(400, `${label} must be a URL`);
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("invalid protocol");
    return url.toString();
  } catch {
    throw new HttpError(400, `${label} must be an absolute HTTP URL`);
  }
}

function recipeTriggerModes(value: unknown): AgentRecipe["trigger"]["modes"] {
  return requiredStringArray(value, "trigger.modes", 4).map(recipeTriggerMode);
}

function recipeTriggerMode(value: unknown): RecipeRun["triggerMode"] {
  if (value === "manual" || value === "scheduled" || value === "event" || value === "webhook") return value;
  throw new HttpError(400, "trigger mode must be manual, scheduled, event, or webhook");
}

function analyticsType(value: unknown): AnalyticsEvent["type"] {
  if (value === "no_result" || value === "answer_generated" || value === "citation_opened" || value === "answer_rejected" || value === "task_completed") return value;
  throw new HttpError(400, "Unsupported analytics event type");
}

function backupBundleInput(value: unknown): NomaBackupBundle {
  const bundle = optionalRecord(value, "bundle");
  if (!bundle) throw new HttpError(400, "bundle is required");
  const manifest = optionalRecord(bundle.manifest, "bundle.manifest");
  if (!manifest || manifest.format !== "noma-cloud-backup-v1") throw new HttpError(400, "Unsupported backup format");
  requiredIsoDate(manifest.exportedAt, "bundle.manifest.exportedAt");
  if (!Array.isArray(bundle.files)) throw new HttpError(400, "bundle.files must be an array");
  for (const [index, item] of bundle.files.entries()) {
    const file = optionalRecord(item, `bundle.files[${index}]`)!;
    stringInput(file, "path");
    stringInput(file, "documentId");
    stringInput(file, "title");
    shaInput(file.hash, `bundle.files[${index}].hash`);
    if (typeof file.source !== "string") throw new HttpError(400, `bundle.files[${index}].source must be a string`);
    requiredIsoDate(file.updatedAt, `bundle.files[${index}].updatedAt`);
  }
  return bundle as unknown as NomaBackupBundle;
}

function shaInput(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) throw new HttpError(400, `${label} must be a lowercase SHA-256 hash`);
  return value;
}

function operationTargetIds(operation: PatchOp): string[] {
  const value = operation as unknown as Record<string, unknown>;
  return [value.id, value.parentId, value.to].filter((item): item is string => typeof item === "string" && item.length > 0);
}

function requireWorkspaceOwner(config: CloudServerConfig, user: CloudUserRecord): void {
  const ownsSite = config.store.listSites(user).some((site) => site.currentRole === "owner");
  const bootstrapAdmin = config.store.listUsers()[0]?.id === user.id;
  if (!ownsSite && !bootstrapAdmin) throw new HttpError(403, "Workspace owner access is required");
}

function stringInput(input: Record<string, unknown>, key: string, fallback?: string): string {
  const value = optionalString(input[key]);
  if (value) return value;
  if (fallback !== undefined) return fallback;
  throw new HttpError(400, `${key} must be a string`);
}

function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function assertCloudId(id: string, label: string): void {
  if (!/^[A-Za-z0-9_-]{8,80}$/.test(id)) throw new HttpError(400, `Invalid ${label.toLowerCase()} ID`);
}

function parseRevisionNumber(value: string | undefined): number {
  if (!value || !/^\d+$/.test(value)) throw new HttpError(400, "Revision number is required");
  const revision = Number(value);
  if (!Number.isSafeInteger(revision) || revision < 1) throw new HttpError(400, "Invalid revision number");
  return revision;
}

function authBearer(req: IncomingMessage): string | undefined {
  const value = headerValue(req, "authorization");
  if (!value) return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(value);
  return match?.[1];
}

function headerValue(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

async function readJsonBody(req: IncomingMessage, maxBodyBytes: number): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  let tooLarge = false;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buffer.byteLength;
    if (tooLarge || size > maxBodyBytes) {
      tooLarge = true;
      continue;
    }
    chunks.push(buffer);
  }
  if (tooLarge) throw new HttpError(413, "Request body is too large");
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text.trim()) throw new HttpError(400, "JSON body is required");
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("body must be an object");
    return parsed as Record<string, unknown>;
  } catch {
    throw new HttpError(400, "Invalid JSON body");
  }
}

async function serveStatic(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  config: CloudServerConfig,
): Promise<void> {
  const filePath = await resolveStaticPath(config.publicDir, url.pathname);
  if (!filePath) throw new HttpError(404, "Not found");
  const info = await stat(filePath);
  const type = contentType(filePath);
  res.statusCode = 200;
  setSecurityHeaders(res, type.startsWith("text/html") ? staticHtmlContentSecurityPolicy : undefined);
  res.setHeader("content-type", type);
  res.setHeader("content-length", String(info.size));
  if (req.method === "HEAD") {
    res.end();
    return;
  }
  await new Promise<void>((resolvePromise, reject) => {
    const stream = createReadStream(filePath);
    stream.on("error", reject);
    stream.on("end", resolvePromise);
    stream.pipe(res);
  });
}

async function resolveStaticPath(publicDir: string, pathname: string): Promise<string | null> {
  let decoded: string;
  try {
    decoded = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  const requested = decoded === "/" ? "/index.html" : decoded;
  const candidates = [requested];
  if (!extname(requested)) candidates.push(`${requested}.html`);

  for (const candidate of candidates) {
    const resolved = resolve(publicDir, `.${candidate}`);
    const root = publicDir.endsWith(sep) ? publicDir : `${publicDir}${sep}`;
    if (resolved !== publicDir && !resolved.startsWith(root)) return null;
    try {
      const info = await stat(resolved);
      if (info.isDirectory()) {
        const indexPath = join(resolved, "index.html");
        await stat(indexPath);
        return indexPath;
      }
      if (info.isFile()) return resolved;
    } catch {
      continue;
    }
  }
  return null;
}

function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  sendText(res, status, `${JSON.stringify(payload)}\n`, "application/json; charset=utf-8");
}

function sendText(res: ServerResponse, status: number, body: string, type: string): void {
  res.statusCode = status;
  setSecurityHeaders(res, type.startsWith("text/html") ? artifactContentSecurityPolicy : undefined);
  res.setHeader("content-type", type);
  res.setHeader("cache-control", "no-store");
  res.end(body);
}

const staticHtmlContentSecurityPolicy = [
  "default-src 'self'",
  "script-src 'self' 'unsafe-inline'",
  "style-src 'self' 'unsafe-inline' https://rsms.me",
  "font-src 'self' https://rsms.me",
  "img-src 'self' data:",
  "connect-src 'self'",
  "frame-src 'self'",
  "object-src 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

const artifactContentSecurityPolicy = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  "font-src data:",
  "img-src data:",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

function setSecurityHeaders(res: ServerResponse, contentSecurityPolicy?: string): void {
  res.setHeader("x-content-type-options", "nosniff");
  res.setHeader("referrer-policy", "no-referrer");
  res.setHeader("x-frame-options", "DENY");
  res.setHeader("permissions-policy", "camera=(), microphone=(), geolocation=(), payment=()");
  if (contentSecurityPolicy) res.setHeader("content-security-policy", contentSecurityPolicy);
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => {
    switch (char) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#39;";
    }
  });
}

function escapeAttr(value: string): string {
  return escapeHtml(value);
}

function contentType(filePath: string): string {
  switch (extname(filePath).toLowerCase()) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".js":
    case ".mjs":
      return "text/javascript; charset=utf-8";
    case ".json":
      return "application/json; charset=utf-8";
    case ".webmanifest":
      return "application/manifest+json; charset=utf-8";
    case ".svg":
      return "image/svg+xml";
    case ".png":
      return "image/png";
    case ".jpg":
    case ".jpeg":
      return "image/jpeg";
    case ".pdf":
      return "application/pdf";
    case ".docx":
      return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    case ".txt":
      return "text/plain; charset=utf-8";
    default:
      return "application/octet-stream";
  }
}

const mainPath = process.argv[1] ? resolve(process.argv[1]) : "";
if (mainPath && fileURLToPath(import.meta.url) === mainPath) {
  const port = Number(process.env.PORT ?? 3000);
  const host = process.env.HOST ?? "0.0.0.0";
  const server = createNomaCloudServer();
  server.listen(port, host, () => {
    console.log(`noma cloud listening on http://${host}:${port}`);
  });
}
