import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { EnterpriseError, type ActorContext } from "./enterprise-contracts.js";
import { healthProbe } from "./enterprise-ops.js";
import type { CrdtOp } from "./enterprise-crdt.js";
import { EnterpriseWorkspace } from "./enterprise-workspace.js";

export interface EnterpriseHttpOptions {
  workspace: EnterpriseWorkspace;
  host?: string;
  port?: number;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    req.on("error", reject);
  });
}

function send(res: ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { "content-type": "application/json", "content-length": Buffer.byteLength(payload) });
  res.end(payload);
}

function actorFrom(ws: EnterpriseWorkspace, req: IncomingMessage): ActorContext {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) throw new EnterpriseError("unauthorized", "missing bearer token");
  return ws.authenticate(header.slice("Bearer ".length));
}

export function createEnterpriseHttpServer(options: EnterpriseHttpOptions) {
  const ws = options.workspace;
  return createServer((req, res) => {
    void (async () => {
      try {
        const url = new URL(req.url ?? "/", "http://enterprise.local");
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
        if (req.method === "GET" && url.pathname === "/v1/search") {
          send(res, 200, { hits: ws.search(actor, url.searchParams.get("q") ?? "") });
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
  const host = options.host ?? "127.0.0.1";
  return new Promise((resolve, reject) => {
    server.listen(options.port ?? 0, host, () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("failed to bind enterprise http"));
        return;
      }
      resolve({
        port: address.port,
        close: () =>
          new Promise((done, fail) => {
            server.close((err) => (err ? fail(err) : done()));
          }),
      });
    });
  });
}
