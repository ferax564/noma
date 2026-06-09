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
  type CloudDocumentRecord,
  type CloudPermission,
  type CloudRole,
  type CloudShareLink,
  type CloudSiteRecord,
  type CloudUserRecord,
  type DocumentSummary,
  type NomaCloudDatabase,
  type SiteSummary,
} from "./cloud-db.js";
import { extractWikilinks } from "./inline.js";
import { slugify, parse } from "./parser.js";
import { renderHtml } from "./renderer-html.js";
import { renderJson } from "./renderer-json.js";
import { renderLlm } from "./renderer-llm.js";
import { validate } from "./validator.js";

export type {
  CloudDbQuery,
  CloudDocumentRecord,
  CloudPermission,
  CloudRole,
  CloudShareLink,
  CloudSiteRecord,
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
  now: () => Date;
  store: NomaCloudDatabase;
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
  via: "user" | "share";
  user?: CloudUserRecord;
  share?: CloudShareLink;
}

class HttpError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
  }
}

const roleRank: Record<CloudRole, number> = {
  viewer: 1,
  editor: 2,
  owner: 3,
};

const cloudAccessCookieName = "noma_cloud_access";

export function createNomaCloudServer(options: NomaCloudServerOptions = {}): Server {
  const dataDir = resolve(options.dataDir ?? process.env.NOMA_CLOUD_DATA_DIR ?? ".noma-cloud/documents");
  const storageRoot = dirname(dataDir);
  const usersDir = resolve(options.usersDir ?? process.env.NOMA_CLOUD_USERS_DIR ?? join(storageRoot, "users"));
  const sitesDir = resolve(options.sitesDir ?? process.env.NOMA_CLOUD_SITES_DIR ?? join(storageRoot, "sites"));
  const dbPath = resolve(options.dbPath ?? process.env.NOMA_CLOUD_DB ?? join(storageRoot, "noma-cloud.sqlite"));
  const store = openNomaCloudDatabase({ dbPath, dataDir, usersDir, sitesDir });
  const config: CloudServerConfig = {
    dataDir,
    usersDir,
    sitesDir,
    dbPath,
    publicDir: resolve(options.publicDir ?? process.env.NOMA_PUBLIC_DIR ?? "dist"),
    maxBodyBytes: options.maxBodyBytes ?? Number(process.env.NOMA_CLOUD_MAX_BODY_BYTES ?? 1_500_000),
    accessTokenHash: cloudAccessTokenHash(options),
    invitationCodeHash: cloudInvitationCodeHash(options),
    now: options.now ?? (() => new Date()),
    store,
  };

  const server = createServer((req, res) => {
    void routeRequest(req, res, config).catch((error: unknown) => {
      if (res.headersSent) {
        res.destroy(error instanceof Error ? error : new Error(String(error)));
        return;
      }
      const status = error instanceof HttpError ? error.status : 500;
      const message = error instanceof Error ? error.message : "Internal server error";
      sendJson(res, status, { error: message });
    });
  });
  server.on("close", () => store.close());
  return server;
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
  res.setHeader("location", location || url.pathname);
  res.setHeader("set-cookie", cloudAccessCookie(req, token));
  res.setHeader("cache-control", "no-store");
  res.end();
}

function redirectToLogin(res: ServerResponse, url: URL): void {
  const next = `${url.pathname}${url.search}`;
  const location = `/login.html?next=${encodeURIComponent(next)}`;
  res.statusCode = 302;
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
    sendJson(res, 200, {
      ok: true,
      mode: "cloud",
      auth: "token",
      access: config.accessTokenHash ? "gate-token" : "open",
      storage: "sqlite",
      database: {
        queryApi: true,
        resources: ["documents", "sites", "blocks", "users", "wiki"],
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
    const access = requireRecordAccess(record, principal, "viewer");
    sendText(res, 200, renderDocumentHtml(record, access), "text/html; charset=utf-8");
    return;
  }

  if (method === "GET" && url.pathname.startsWith("/s/")) {
    const id = decodeURIComponent(url.pathname.slice(3));
    const site = await readSite(config, id);
    const access = requireRecordAccess(site, principal, "viewer");
    sendText(res, 200, await renderSiteHtml(config, site, access), "text/html; charset=utf-8");
    return;
  }

  if (method === "GET" || method === "HEAD") {
    await serveStatic(req, res, url, config);
    return;
  }

  throw new HttpError(405, "Method not allowed");
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

  throw new HttpError(404, "Unknown API resource");
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
    sendJson(res, 201, documentResponse(record, requireRecordAccess(record, principal, "owner")));
    return;
  }

  if (!id && method === "GET") {
    const user = requireUser(principal);
    sendJson(res, 200, { documents: await listDocuments(config, user) });
    return;
  }

  if (!id) throw new HttpError(404, "Document ID is required");

  if (suffix === "collaborators") {
    await routeCollaborators(req, res, config, principal, await readDocument(config, id), "document");
    return;
  }

  if (suffix === "shares") {
    await routeShares(req, res, config, principal, await readDocument(config, id), "document");
    return;
  }

  const record = await readDocument(config, id);

  if (suffix === "html" && method === "GET") {
    const access = requireRecordAccess(record, principal, "viewer");
    sendText(res, 200, renderDocumentHtml(record, access), "text/html; charset=utf-8");
    return;
  }

  if (suffix === "json" && method === "GET") {
    requireRecordAccess(record, principal, "viewer");
    sendText(res, 200, inspectSource(record.source, record.id).json, "application/json; charset=utf-8");
    return;
  }

  if (suffix === "llm" && method === "GET") {
    requireRecordAccess(record, principal, "viewer");
    sendText(res, 200, inspectSource(record.source, record.id).llm, "text/plain; charset=utf-8");
    return;
  }

  if (suffix) throw new HttpError(404, "Unknown document artifact");

  if (method === "GET") {
    const access = requireRecordAccess(record, principal, "viewer");
    sendJson(res, 200, documentResponse(record, access));
    return;
  }

  if (method === "PUT" || method === "PATCH") {
    const access = requireRecordAccess(record, principal, "editor");
    const input = await readJsonBody(req, config.maxBodyBytes);
    const updated = await updateDocument(config, record, input, access);
    sendJson(res, 200, documentResponse(updated, requireRecordAccess(updated, principal, "viewer")));
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
    sendJson(res, 201, siteResponse(record, requireRecordAccess(record, principal, "owner")));
    return;
  }

  if (!id && method === "GET") {
    const user = requireUser(principal);
    sendJson(res, 200, { sites: await listSites(config, user) });
    return;
  }

  if (!id) throw new HttpError(404, "Site ID is required");

  if (suffix === "collaborators") {
    await routeCollaborators(req, res, config, principal, await readSite(config, id), "site");
    return;
  }

  if (suffix === "shares") {
    await routeShares(req, res, config, principal, await readSite(config, id), "site");
    return;
  }

  if (suffix === "documents") {
    await routeSiteDocuments(req, res, parts, config, principal, await readSite(config, id));
    return;
  }

  if (suffix === "wiki") {
    await routeSiteWiki(req, res, config, principal, await readSite(config, id));
    return;
  }

  if (suffix) throw new HttpError(404, "Unknown site route");

  const site = await readSite(config, id);

  if (method === "GET") {
    const access = requireRecordAccess(site, principal, "viewer");
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
    const access = requireRecordAccess(site, principal, "editor");
    const input = await readJsonBody(req, config.maxBodyBytes);
    const updated = await updateSite(config, site, input, access, principal);
    sendJson(res, 200, siteResponse(updated, requireRecordAccess(updated, principal, "viewer")));
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
    const access = requireRecordAccess(site, principal, "viewer");
    sendJson(res, 200, { documents: await siteDocumentResponses(config, site, access) });
    return;
  }

  if (!docId && method === "POST") {
    const access = requireRecordAccess(site, principal, "editor");
    const user = requireUser(principal);
    const input = await readJsonBody(req, config.maxBodyBytes);
    const document = await createDocument(config, input, user);
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
    sendJson(res, 201, documentResponse(document, requireRecordAccess(document, principal, "owner")));
    return;
  }

  if (!docId) throw new HttpError(404, "Document ID is required");
  assertCloudId(docId, "Document");
  if (!site.documentIds.includes(docId)) throw new HttpError(404, "Document is not in this site");

  if (method === "GET") {
    const access = requireRecordAccess(site, principal, "viewer");
    sendJson(res, 200, documentResponse(await readDocument(config, docId), access));
    return;
  }

  if (method === "PUT" || method === "PATCH") {
    const access = requireRecordAccess(site, principal, "editor");
    const input = await readJsonBody(req, config.maxBodyBytes);
    const updated = await updateDocument(config, await readDocument(config, docId), input, access);
    sendJson(res, 200, documentResponse(updated, access));
    return;
  }

  throw new HttpError(405, "Method not allowed");
}

async function siteDocumentResponses(
  config: CloudServerConfig,
  site: CloudSiteRecord,
  access: AccessContext,
): Promise<Array<CloudDocumentRecord & SourceInspection & { access: Record<string, unknown> }>> {
  return Promise.all(site.documentIds.map(async (id) => documentResponse(await readDocument(config, id), access)));
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
  const access = requireRecordAccess(site, principal, "viewer");
  const documents = await Promise.all(site.documentIds.map((id) => readDocument(config, id)));
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
  config: CloudServerConfig,
  principal: Principal,
  record: CloudDocumentRecord | CloudSiteRecord,
  kind: "document" | "site",
): Promise<void> {
  const method = req.method ?? "GET";
  requireRecordAccess(record, principal, "owner");

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
    sendJson(res, 200, { collaborators: Object.entries(next.permissions).map(([id, permission]) => ({ userId: id, ...permission })) });
    return;
  }

  throw new HttpError(405, "Method not allowed");
}

async function routeShares(
  req: IncomingMessage,
  res: ServerResponse,
  config: CloudServerConfig,
  principal: Principal,
  record: CloudDocumentRecord | CloudSiteRecord,
  kind: "document" | "site",
): Promise<void> {
  const method = req.method ?? "GET";
  const access = requireRecordAccess(record, principal, "editor");

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
    sendJson(res, 201, {
      ...shareSummary(share),
      token,
      url: kind === "document" ? `/workbench.html?doc=${record.id}&share=${token}` : `/s/${record.id}?share=${token}`,
      artifactUrl: kind === "document" ? `/d/${record.id}?share=${token}` : `/s/${record.id}?share=${token}`,
    });
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
): Promise<CloudDocumentRecord> {
  const id = uniqueId(config);
  const source = sourceFromInput(input);
  inspectSource(source, id);
  const now = config.now().toISOString();
  const record: CloudDocumentRecord = {
    version: 2,
    id,
    title: titleFromInput(input, source),
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
  return record;
}

async function requireDocumentEditAccess(config: CloudServerConfig, ids: string[], principal: Principal): Promise<void> {
  for (const id of ids) {
    requireRecordAccess(await readDocument(config, id), principal, "editor");
  }
}

async function listDocuments(config: CloudServerConfig, user: CloudUserRecord): Promise<DocumentSummary[]> {
  return config.store.listDocuments(user);
}

async function listSites(config: CloudServerConfig, user: CloudUserRecord): Promise<SiteSummary[]> {
  return config.store.listSites(user);
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

function requireRecordAccess(
  record: CloudDocumentRecord | CloudSiteRecord,
  principal: Principal,
  minimum: CloudRole,
): AccessContext {
  const access = recordAccess(record, principal);
  if (!access || roleRank[access.role] < roleRank[minimum]) {
    const status = principal.user || principal.shareTokenHash ? 403 : 401;
    throw new HttpError(access ? 403 : status, `${minimum} access is required`);
  }
  return access;
}

function recordAccess(record: CloudDocumentRecord | CloudSiteRecord, principal: Principal): AccessContext | undefined {
  let best: AccessContext | undefined;
  if (principal.user) {
    const permission = record.permissions[principal.user.id];
    if (permission) {
      best = { role: permission.role, via: "user", user: principal.user };
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

function documentResponse(record: CloudDocumentRecord, access: AccessContext): CloudDocumentRecord & SourceInspection & { access: Record<string, unknown> } {
  return {
    ...record,
    ...inspectSource(record.source, record.id),
    access: accessResponse(access),
  };
}

function siteResponse(record: CloudSiteRecord, access: AccessContext): CloudSiteRecord & { access: Record<string, unknown> } {
  const pageFolders = pageFolderMap(record.pageFolders, record.documentIds);
  return {
    ...record,
    folders: normalizeSiteFolders(record.folders ?? [], pageFolders),
    pageFolders,
    shareLinks: record.shareLinks,
    access: accessResponse(access),
  };
}

function accessResponse(access: AccessContext): Record<string, unknown> {
  return {
    role: access.role,
    via: access.via,
    user: access.user ? publicUser(access.user) : undefined,
    shareId: access.share?.id,
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
  const documents = await Promise.all(site.documentIds.map((id) => readDocument(config, id)));
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
  res.statusCode = 200;
  res.setHeader("content-type", contentType(filePath));
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
  res.setHeader("content-type", type);
  res.setHeader("cache-control", "no-store");
  res.end(body);
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
