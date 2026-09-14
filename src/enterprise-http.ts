import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { extname, join, normalize, resolve, sep } from "node:path";
import { EnterpriseError, type ActorContext } from "./enterprise-contracts.js";
import { healthProbe } from "./enterprise-ops.js";
import type { CrdtOp } from "./enterprise-crdt.js";
import { attachEnterpriseYjs } from "./enterprise-yjs.js";
import { EnterpriseWorkspace } from "./enterprise-workspace.js";
import { enterpriseWorkspaceHtml } from "./enterprise-shell.js";
import { paperCanvasMarkup, paperCanvasStyles } from "./enterprise-paperdom.js";

export interface EnterpriseHttpOptions {
  workspace: EnterpriseWorkspace;
  host?: string;
  port?: number;
  collabHtml?: string;
  workspaceHtml?: string;
  publicDir?: string;
  tenantId?: string;
  demoUser?: string;
  assets?: Record<string, { body: string; type: string }>;
}

const ASSET_TYPES: Record<string, string> = {
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".html": "text/html; charset=utf-8",
  ".svg": "image/svg+xml",
  ".map": "application/json; charset=utf-8",
};

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolveBody, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolveBody(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(payload) });
  res.end(payload);
}

function sendHtml(res: ServerResponse, html: string): void {
  res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
  res.end(html);
}

function actorFrom(ws: EnterpriseWorkspace, req: IncomingMessage): ActorContext {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) throw new EnterpriseError("unauthorized", "missing bearer token");
  return ws.authenticate(header.slice("Bearer ".length));
}

function safeAssetPath(publicDir: string, pathname: string): string | undefined {
  const relative = pathname.replace(/^\/assets\//, "");
  if (!relative || relative.includes("..") || relative.includes("\\") || relative.includes("\0")) return undefined;
  if (!/^[A-Za-z0-9._-]+$/.test(relative)) return undefined;
  const root = resolve(publicDir);
  const candidate = resolve(join(root, relative));
  const prefix = root.endsWith(sep) ? root : root + sep;
  if (candidate !== root && !candidate.startsWith(prefix)) return undefined;
  if (!existsSync(candidate) || !statSync(candidate).isFile()) return undefined;
  return normalize(candidate);
}

export function createEnterpriseHttpServer(options: EnterpriseHttpOptions) {
  const ws = options.workspace;
  const workspaceHtml =
    options.workspaceHtml ??
    enterpriseWorkspaceHtml({ tenantId: options.tenantId, demoUser: options.demoUser });
  return createServer((req, res) => {
    void (async () => {
      try {
        const url = new URL(req.url ?? "/", "http://enterprise.local");
        if (req.method === "GET" && (url.pathname === "/collab" || url.pathname === "/collab.html") && options.collabHtml) {
          sendHtml(res, options.collabHtml);
          return;
        }
        if (
          req.method === "GET" &&
          (url.pathname === "/" || url.pathname === "/workspace" || url.pathname === "/index.html")
        ) {
          sendHtml(res, workspaceHtml);
          return;
        }
        if (req.method === "GET" && url.pathname.startsWith("/assets/")) {
          const name = url.pathname.slice("/assets/".length);
          const memory = options.assets?.[name];
          if (memory) {
            res.writeHead(200, { "content-type": memory.type });
            res.end(memory.body);
            return;
          }
          if (options.publicDir) {
            const filePath = safeAssetPath(options.publicDir, url.pathname);
            if (!filePath) {
              send(res, 404, { error: "not_found" });
              return;
            }
            const type = ASSET_TYPES[extname(filePath)] ?? "application/octet-stream";
            res.writeHead(200, { "content-type": type });
            createReadStream(filePath).pipe(res);
            return;
          }
          send(res, 404, { error: "not_found" });
          return;
        }
        if (req.method === "GET" && (url.pathname === "/favicon.ico" || url.pathname === "/robots.txt")) {
          res.writeHead(204);
          res.end();
          return;
        }
        if (req.method === "GET" && url.pathname === "/health") {
          send(res, 200, healthProbe({ dbOk: true, objectStoreOk: true, killSwitch: false }));
          return;
        }
        if (req.method === "GET" && url.pathname === "/ready") {
          ws.store.db.prepare("SELECT 1").get();
          send(res, 200, { ready: true });
          return;
        }
        if (req.method === "POST" && url.pathname === "/v1/session") {
          const body = JSON.parse((await readBody(req)) || "{}") as { tenantId: string; idToken: string };
          const session = ws.loginOidc(body.tenantId, body.idToken);
          send(res, 200, session);
          return;
        }
        const actor = actorFrom(ws, req);
        if (req.method === "GET" && url.pathname === "/v1/workspace") {
          send(res, 200, ws.workspaceShell(actor));
          return;
        }
        if (req.method === "GET" && url.pathname === "/v1/search") {
          send(res, 200, { hits: ws.search(actor, url.searchParams.get("q") ?? "") });
          return;
        }
        const artifactMatch = url.pathname.match(/^\/v1\/artifacts\/([^/]+)$/);
        if (artifactMatch && req.method === "GET") {
          const artifactId = decodeURIComponent(artifactMatch[1]!);
          const read = ws.readArtifact(actor, artifactId, "draft");
          send(res, 200, {
            ...read,
            html: `<style>${paperCanvasStyles()}</style>${paperCanvasMarkup(read.document)}`,
          });
          return;
        }
        const issueMatch = url.pathname.match(/^\/v1\/issues\/([^/]+)\/transition$/);
        if (issueMatch && req.method === "POST") {
          const body = JSON.parse((await readBody(req)) || "{}") as { to: string; fields?: Record<string, unknown> };
          ws.transitionIssue(actor, decodeURIComponent(issueMatch[1]!), body.to, body.fields);
          send(res, 200, { ok: true });
          return;
        }
        const docMatch = url.pathname.match(/^\/v1\/documents\/([^/]+)(\/crdt|\/updates)?$/);
        if (docMatch && req.method === "GET" && !docMatch[2]) {
          send(res, 200, ws.readDocument(actor, decodeURIComponent(docMatch[1]!)));
          return;
        }
        if (docMatch && docMatch[2] === "/updates" && req.method === "GET") {
          send(res, 200, ws.reconnectDraft(actor, decodeURIComponent(docMatch[1]!), Number(url.searchParams.get("since") ?? "0")));
          return;
        }
        if (docMatch && docMatch[2] === "/crdt" && req.method === "POST") {
          const body = JSON.parse((await readBody(req)) || "{}") as {
            clientId: string;
            clientSeq: number;
            lastAckedSeq?: number;
            ops: CrdtOp[];
          };
          send(res, 200, ws.persistCollaborativeUpdate(actor, { documentId: decodeURIComponent(docMatch[1]!), ...body }));
          return;
        }
        if (req.method === "GET" && url.pathname === "/v1/notifications") {
          send(res, 200, { notifications: ws.notifications(actor) });
          return;
        }
        send(res, 404, { error: "not_found" });
      } catch (error) {
        const code = error instanceof EnterpriseError ? error.code : "invalid";
        const status = code === "unauthorized" || code === "forbidden" ? 403 : 400;
        send(res, status, { error: code, message: error instanceof Error ? error.message : String(error) });
      }
    })();
  });
}

export function listenEnterpriseHttp(options: EnterpriseHttpOptions): Promise<{ port: number; close: () => Promise<void> }> {
  const server = createEnterpriseHttpServer(options);
  const wss = attachEnterpriseYjs(server, options.workspace);
  const host = options.host ?? "127.0.0.1";
  return new Promise((resolveListen, reject) => {
    server.listen(options.port ?? 0, host, () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("failed to bind enterprise http"));
        return;
      }
      resolveListen({
        port: address.port,
        close: () =>
          new Promise((done, fail) => {
            wss.close();
            server.close((err) => (err ? fail(err) : done()));
          }),
      });
    });
  });
}
