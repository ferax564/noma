/**
 * Noma Cloud HTTP server entry point: config, top-level request routing, and the CLI main. Route
 * handlers live in `src/cloud/` (`router.ts` maps `/api/:resource` to `routes-*.ts`; shared helpers
 * are in `http.ts`, `input.ts`, `context.ts`, `records.ts`).
 */
import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { type BlobStore, LocalDiskBlobStore } from "./cloud-blobs.js";
import { attachCloudCollab, type CloudCollabOptions } from "./cloud-collab.js";
import { openNomaCloudDatabase } from "./cloud-db.js";
import { createLlmProviderFromEnv, type LlmProvider } from "./cloud-llm.js";
import { CloudKnowledgePlatform } from "./cloud-platform.js";
import {
  CloudRateLimiter,
  type CloudServerConfig,
  readDocument,
  readSite,
  requireNotTrashed,
  requireRecordAccess,
  resolvePrincipal,
} from "./cloud/context.js";
import { decodePathSegment, headerValue, HttpError, sendJson, sendText, sha256Hex } from "./cloud/http.js";
import { selfUser } from "./cloud/records.js";
import { attachmentResolver } from "./cloud/attachments.js";
import { widgetFrameResolver } from "./cloud/widgets.js";
import { documentStyleTokens } from "./cloud/spaces.js";
import { cloudMacroResolvers, cloudPageHref } from "./cloud/macros.js";
import { renderDocumentHtml, renderPresentationHtml, renderSiteHtml, serveStatic } from "./cloud/render.js";
import { runDueMaintenance, startMaintenanceScheduler } from "./cloud/routes-maintenance.js";
import { routeApi } from "./cloud/router.js";
import { recordPageView } from "./cloud/routes-analytics.js";
import { runServerQueueTick } from "./cloud/queue.js";
import {
  isCloudAppShell,
  redirectWithCloudAccessCookie,
  requiresCloudAccess,
  resolveCloudAccess,
  routeAuth,
  sendCloudAccessDenied,
} from "./cloud/routes-auth.js";
import { enforceRequestAuthorization, requestAddress } from "./cloud/security.js";

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
  /**
   * User IDs allowed to administer workspace-wide enterprise settings. When empty,
   * only the first user ever registered on this database is the workspace admin.
   */
  adminUserIds?: string[];
  /** Largest single attachment upload in bytes (default 25 MB, env `NOMA_CLOUD_MAX_ATTACHMENT_BYTES`). */
  maxAttachmentBytes?: number;
  /** Live attachment bytes per space, or per user outside spaces (default 1 GB, env `NOMA_CLOUD_ATTACHMENT_QUOTA_BYTES`). */
  attachmentQuotaBytes?: number;
  /** Attachment blob storage; defaults to content-addressed files under `<storage root>/blobs`. */
  blobStore?: BlobStore;
  /** Allow Confluence imports from private/loopback hosts (tests, on-prem Data Center). */
  importAllowPrivateHosts?: boolean;
  /** Maximum Confluence import upload size in bytes (default 50 MB). */
  importMaxBytes?: number;
  now?: () => Date;
  /**
   * How often the in-process queue (webhook deliveries, email digests) drains, in ms.
   * Defaults to `NOMA_CLOUD_QUEUE_INTERVAL_MS` or 5000; 0 disables the timer.
   */
  queueIntervalMs?: number;
  /** Live co-editing relay tuning (checkpoint coalescing, permission re-check cadence). */
  collab?: CloudCollabOptions;
  /** Generative AI settings; environment variables fill anything left unset. */
  ai?: NomaCloudAiOptions;
}

export interface NomaCloudAiOptions {
  /** `null` disables AI even when `ANTHROPIC_API_KEY` is set. */
  provider?: LlmProvider | null;
  userBudgetUsd?: number;
  agentBudgetUsd?: number;
  allowPrivateSourceHosts?: boolean;
  /** Maintenance scheduler tick in ms; 0 disables the in-process timer. */
  maintenanceTickMs?: number;
}

export function createNomaCloudServer(options: NomaCloudServerOptions = {}): Server {
  const config = createCloudServerConfig(options);
  const { store, platform } = config;
  const stopMaintenance = startMaintenanceScheduler(config);
  if (config.production && config.adminUserIds.length === 0) {
    console.warn("noma cloud: NOMA_CLOUD_ADMIN_USER_IDS is not set; enterprise admin routes will return 403 until it is configured");
  }

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
  const collab = attachCloudCollab(server, config, options.collab);
  const closeServer = server.close.bind(server);
  server.close = ((callback?: (error?: Error) => void) => {
    void collab.shutdown();
    return closeServer(callback);
  }) as Server["close"];
  const queueIntervalMs = options.queueIntervalMs ?? Number(process.env.NOMA_CLOUD_QUEUE_INTERVAL_MS ?? 5_000);
  const queueTimer = queueIntervalMs > 0 ? setInterval(() => void runServerQueueTick(config), queueIntervalMs) : undefined;
  queueTimer?.unref();
  server.on("close", () => {
    if (queueTimer) clearInterval(queueTimer);
    stopMaintenance();
    platform.close();
    store.close();
  });
  return server;
}

/**
 * Runs one maintenance pass over every space whose stale-knowledge sweep is due, then closes the
 * databases. Backs the `apps/worker/cloud-maintenance.ts` entry for deployments that prefer a cron job
 * over the in-process scheduler.
 */
export async function runNomaCloudMaintenanceOnce(options: NomaCloudServerOptions = {}): Promise<Awaited<ReturnType<typeof runDueMaintenance>>> {
  const config = createCloudServerConfig({ ...options, ai: { ...options.ai, maintenanceTickMs: 0 } });
  try {
    return await runDueMaintenance(config);
  } finally {
    config.platform.close();
    config.store.close();
  }
}

function createCloudServerConfig(options: NomaCloudServerOptions): CloudServerConfig {
  const dataDir = resolve(options.dataDir ?? process.env.NOMA_CLOUD_DATA_DIR ?? ".noma-cloud/documents");
  const storageRoot = dirname(dataDir);
  const usersDir = resolve(options.usersDir ?? process.env.NOMA_CLOUD_USERS_DIR ?? join(storageRoot, "users"));
  const sitesDir = resolve(options.sitesDir ?? process.env.NOMA_CLOUD_SITES_DIR ?? join(storageRoot, "sites"));
  const dbPath = resolve(options.dbPath ?? process.env.NOMA_CLOUD_DB ?? join(storageRoot, "noma-cloud.sqlite"));
  const accessTokenHash = cloudAccessTokenHash(options);
  const invitationCodeHash = cloudInvitationCodeHash(options);
  const ssoTrustedHeaderHash = cleanSecret(options.ssoTrustedHeaderSecret ?? process.env.NOMA_CLOUD_SSO_TRUST_SECRET);
  const production = options.production ?? process.env.NODE_ENV === "production";
  validateProductionSecurity(options, production, accessTokenHash, invitationCodeHash);
  const now = options.now ?? (() => new Date());
  const adminUserIds = options.adminUserIds ?? (process.env.NOMA_CLOUD_ADMIN_USER_IDS ?? "").split(",").map((id) => id.trim()).filter(Boolean);
  const store = openNomaCloudDatabase({ dbPath, dataDir, usersDir, sitesDir, adminUserIds, bootstrapFirstUserAdmin: !production });
  const platform = new CloudKnowledgePlatform(dbPath);
  return {
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
    adminUserIds,
    production,
    importAllowPrivateHosts: options.importAllowPrivateHosts ?? enabledEnvironmentFlag("NOMA_CLOUD_IMPORT_ALLOW_PRIVATE_HOSTS"),
    importMaxBytes: positiveInteger(options.importMaxBytes ?? Number(process.env.NOMA_CLOUD_IMPORT_MAX_BYTES ?? 50_000_000), "importMaxBytes"),
    now,
    store,
    platform,
    blobs: options.blobStore ?? new LocalDiskBlobStore(storageRoot),
    maxAttachmentBytes: positiveInteger(
      options.maxAttachmentBytes ?? Number(process.env.NOMA_CLOUD_MAX_ATTACHMENT_BYTES ?? 25 * 1024 * 1024),
      "maxAttachmentBytes",
    ),
    attachmentQuotaBytes: positiveInteger(
      options.attachmentQuotaBytes ?? Number(process.env.NOMA_CLOUD_ATTACHMENT_QUOTA_BYTES ?? 1024 * 1024 * 1024),
      "attachmentQuotaBytes",
    ),
    ai: cloudAiConfig(options.ai ?? {}),
  };
}

function cloudAiConfig(options: NomaCloudAiOptions): CloudServerConfig["ai"] {
  const provider = options.provider === null ? undefined : options.provider ?? createLlmProviderFromEnv();
  return {
    ...(provider ? { provider } : {}),
    userBudgetUsd: nonNegativeNumber(options.userBudgetUsd ?? Number(process.env.NOMA_CLOUD_AI_USER_BUDGET_USD ?? 10), "userBudgetUsd"),
    agentBudgetUsd: nonNegativeNumber(options.agentBudgetUsd ?? Number(process.env.NOMA_CLOUD_AI_AGENT_BUDGET_USD ?? 25), "agentBudgetUsd"),
    allowPrivateSourceHosts: options.allowPrivateSourceHosts ?? enabledEnvironmentFlag("NOMA_CLOUD_AI_ALLOW_PRIVATE_SOURCES"),
    maintenanceTickMs: nonNegativeNumber(options.maintenanceTickMs ?? Number(process.env.NOMA_CLOUD_MAINTENANCE_TICK_MS ?? 900_000), "maintenanceTickMs"),
  };
}

function nonNegativeNumber(value: number, label: string): number {
  if (!Number.isFinite(value) || value < 0) throw new Error(`${label} must be a non-negative number`);
  return value;
}

function validateProductionSecurity(
  options: NomaCloudServerOptions,
  production: boolean,
  accessTokenHash: string | undefined,
  invitationCodeHash: string | undefined,
): void {
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

async function routeRequest(req: IncomingMessage, res: ServerResponse, config: CloudServerConfig): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const method = req.method ?? "GET";

  if (method === "GET" && url.pathname === "/healthz") {
    const ready = config.platform.ready();
    sendJson(res, ready ? 200 : 503, { ok: ready, storage: "sqlite" });
    return;
  }

  if (url.pathname.startsWith("/api/") || url.searchParams.has("access")) enforceRateLimit(req, res, url, config);

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
  enforceRequestAuthorization(req, url, principal);

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
          "ai",
          "space-maintenance",
          "sync-manifest",
        ],
      },
      maxBodyBytes: config.maxBodyBytes,
      user: principal.user ? selfUser(principal.user) : undefined,
    });
    return;
  }

  if (url.pathname.startsWith("/api/")) {
    await routeApi(req, res, url, config, principal);
    return;
  }

  const presentMatch = method === "GET" ? /^\/d\/([^/]+)\/present\/?$/.exec(url.pathname) : null;
  if (presentMatch) {
    const id = decodePathSegment(presentMatch[1]!);
    const record = await readDocument(config, id);
    requireNotTrashed(config, "document", id);
    const access = requireRecordAccess(config, record, principal, "viewer");
    recordPageView(config, req, record, access);
    const share = url.searchParams.get("share");
    sendText(
      res,
      200,
      renderPresentationHtml(record, {
        resolveAttachment: attachmentResolver(config, record.id, access),
        resolveWidgetFrame: widgetFrameResolver(config, record.id, access),
        styleTokens: documentStyleTokens(config, record.id),
        macros: cloudMacroResolvers(config, principal, record.id),
        backHref: share ? `/d/${encodeURIComponent(record.id)}?share=${encodeURIComponent(share)}` : cloudPageHref(record.id),
      }),
      "text/html; charset=utf-8",
    );
    return;
  }

  if (method === "GET" && url.pathname.startsWith("/d/")) {
    const id = decodePathSegment(url.pathname.slice(3));
    const record = await readDocument(config, id);
    requireNotTrashed(config, "document", id);
    const access = requireRecordAccess(config, record, principal, "viewer");
    recordPageView(config, req, record, access);
    sendText(res, 200, renderDocumentHtml(record, access, { resolveAttachment: attachmentResolver(config, record.id, access), resolveWidgetFrame: widgetFrameResolver(config, record.id, access), styleTokens: documentStyleTokens(config, record.id), macros: cloudMacroResolvers(config, principal, record.id), ...(url.searchParams.get("share") ? { shareToken: url.searchParams.get("share")! } : {}) }), "text/html; charset=utf-8");
    return;
  }

  if (method === "GET" && url.pathname.startsWith("/s/")) {
    const id = decodePathSegment(url.pathname.slice(3));
    const site = await readSite(config, id);
    requireNotTrashed(config, "site", id);
    const access = requireRecordAccess(config, site, principal, "viewer");
    sendText(res, 200, await renderSiteHtml(config, site, access, principal), "text/html; charset=utf-8");
    return;
  }

  if (method === "GET" || method === "HEAD") {
    await serveStatic(req, res, url, config);
    return;
  }

  throw new HttpError(405, "Method not allowed");
}

function enforceRateLimit(req: IncomingMessage, res: ServerResponse, url: URL, config: CloudServerConfig): void {
  const auth =
    url.pathname.startsWith("/api/auth/") || (url.pathname === "/api/users" && req.method === "POST") || url.searchParams.has("access");
  const address = requestAddress(req, config.trustProxy);
  const result = config.rateLimiter.consume(`${address}:${auth ? "auth" : "api"}`, auth, config.now().getTime());
  res.setHeader("x-ratelimit-limit", String(result.limit));
  res.setHeader("x-ratelimit-remaining", String(result.remaining));
  res.setHeader("x-ratelimit-reset", String(Math.ceil(result.resetAt / 1000)));
  if (result.allowed) return;
  const retryAfter = Math.max(1, Math.ceil((result.resetAt - config.now().getTime()) / 1000));
  res.setHeader("retry-after", String(retryAfter));
  throw new HttpError(429, "Too many requests", { code: "rate_limit_exceeded", retryAfter });
}

const mainPath = process.argv[1] ? resolve(process.argv[1]) : "";

if (mainPath && fileURLToPath(import.meta.url) === mainPath) {
  const port = Number(process.env.PORT ?? 3000);
  const host = process.env.HOST ?? "0.0.0.0";
  const server = createNomaCloudServer();
  server.listen(port, host, () => {
    console.log(`noma cloud listening on http://${host}:${port}`);
  });
  const shutdown = (signal: NodeJS.Signals): void => {
    console.log(`noma cloud received ${signal}; closing`);
    server.close((error) => {
      if (error) {
        console.error(error);
        process.exitCode = 1;
      }
    });
    server.closeIdleConnections();
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}
