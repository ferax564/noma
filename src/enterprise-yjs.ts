import { createServer, type IncomingMessage, type Server } from "node:http";
import { WebSocketServer, type WebSocket } from "ws";
import * as Y from "yjs";
import { EnterpriseError } from "./enterprise-contracts.js";
import { sha256Hex } from "./hash.js";
import type { ActorContext } from "./enterprise-contracts.js";
import type { EnterpriseWorkspace } from "./enterprise-workspace.js";

export const YJS_FRAGMENT = "default";

interface Room {
  doc: Y.Doc;
  clients: Set<WebSocket>;
}

function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

function fromBase64(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value, "base64"));
}

export function yjsFragmentText(doc: Y.Doc): string {
  return doc.getXmlFragment(YJS_FRAGMENT).toString();
}

export function applyYjsUpdate(doc: Y.Doc, update: Uint8Array, origin: unknown = null): void {
  Y.applyUpdate(doc, update, origin);
}

export function encodeYjsState(doc: Y.Doc): Uint8Array {
  return Y.encodeStateAsUpdate(doc);
}

export function persistYjsUpdate(
  workspace: EnterpriseWorkspace,
  actor: ActorContext,
  documentId: string,
  update: Uint8Array,
  simulateLostAck = false,
): { hash: string; seq: number } {
  if (!workspace.hasRole(actor, "document", documentId, "editor")) {
    throw new EnterpriseError("forbidden", "missing editor on document");
  }
  const existing = workspace.store.db
    .prepare("SELECT COALESCE(MAX(seq), 0) AS n FROM crdt_updates WHERE document_id = ?")
    .get(documentId) as { n: number };
  const seq = existing.n + 1;
  const hash = sha256Hex(toBase64(update));
  workspace.store.db
    .prepare(
      `INSERT INTO crdt_updates(id, document_id, seq, client_id, client_seq, actor_id, ops_json, hash, persisted_at)
       VALUES (?, ?, ?, 'yjs', ?, ?, ?, ?, ?)`,
    )
    .run(
      `yjs-${documentId}-${seq}`,
      documentId,
      seq,
      seq,
      actor.principalId,
      JSON.stringify({ yjs: toBase64(update) }),
      hash,
      new Date().toISOString(),
    );
  if (simulateLostAck) throw new EnterpriseError("invalid", "simulated lost ack");
  return { hash, seq };
}

export function loadYjsDocument(workspace: EnterpriseWorkspace, documentId: string): Y.Doc {
  const doc = new Y.Doc();
  const rows = workspace.store.db
    .prepare("SELECT ops_json FROM crdt_updates WHERE document_id = ? ORDER BY seq")
    .all(documentId) as Array<{ ops_json: string }>;
  for (const row of rows) {
    const payload = JSON.parse(row.ops_json) as { yjs?: string };
    if (payload.yjs) Y.applyUpdate(doc, fromBase64(payload.yjs));
  }
  return doc;
}

export function yjsPersistedCount(workspace: EnterpriseWorkspace, documentId: string): number {
  const row = workspace.store.db
    .prepare("SELECT COUNT(*) AS n FROM crdt_updates WHERE document_id = ? AND client_id = 'yjs'")
    .get(documentId) as { n: number };
  return row.n;
}

export function enterpriseCollabHtml(script: string): string {
  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Noma hosted collab</title>
    <link rel="preconnect" href="https://rsms.me/" />
    <link rel="stylesheet" href="https://rsms.me/inter/inter.css" />
    <style>
      :root { --ink:#1b1712; --muted:#6a6156; --paper:#fffdf8; --rule:rgba(48,36,24,.12); --accent:#a64f2b; --sans:Inter,system-ui,sans-serif; --serif:"Iowan Old Style",Charter,Georgia,serif; }
      html, body { margin:0; min-height:100%; background:#efe8dc; color:var(--ink); font-family:var(--sans); }
      .collab-shell { min-height:100vh; display:grid; grid-template-rows:auto auto 1fr; }
      .collab-top { display:flex; align-items:center; gap:10px; padding:12px 18px; border-bottom:1px solid var(--rule); background:rgba(252,248,241,.92); }
      .brand { font-weight:760; letter-spacing:-.02em; }
      #status { margin-left:auto; border:1px solid var(--rule); border-radius:999px; padding:4px 10px; font-size:12px; color:var(--muted); }
      .toolbar { display:flex; gap:6px; padding:10px 18px; }
      .toolbar button { min-height:30px; border:1px solid var(--rule); border-radius:8px; background:#fff; padding:0 10px; font:650 12px var(--sans); }
      #editor { width:min(820px, calc(100% - 48px)); margin:18px auto 48px; min-height:24rem; padding:42px 56px; border-radius:22px; background:var(--paper); box-shadow:0 24px 64px -36px rgba(40,28,16,.48); }
      .ProseMirror { min-height:12rem; outline:none; font-family:var(--serif); font-size:1.12rem; line-height:1.65; }
    </style>
  </head>
  <body>
    <div class="collab-shell">
      <div class="collab-top">
        <span class="brand">Noma collab</span>
        <div id="status">connecting</div>
      </div>
      <div class="toolbar" role="toolbar" aria-label="Formatting">
        <button type="button" data-cmd="bold" aria-label="Bold"><b>B</b></button>
        <button type="button" data-cmd="italic" aria-label="Italic"><i>I</i></button>
        <button type="button" data-cmd="heading" data-level="2" aria-label="Heading">H2</button>
      </div>
      <div id="editor"></div>
    </div>
    <script>${script.replace(/<\/script/gi, "<\\/script")}</script>
  </body>
</html>`;
}

export function attachEnterpriseYjs(http: Server, workspace: EnterpriseWorkspace): WebSocketServer {
  const rooms = new Map<string, Room>();
  const wss = new WebSocketServer({ noServer: true });
  http.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url ?? "/", "http://enterprise.local");
    if (url.pathname !== "/yjs") {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  });
  wss.on("connection", (ws: WebSocket, req: IncomingMessage) => {
    const url = new URL(req.url ?? "/", "http://enterprise.local");
    const token = url.searchParams.get("token") ?? "";
    const documentId = url.searchParams.get("documentId") ?? "";
    let actor: ActorContext;
    try {
      actor = workspace.authenticate(token);
      if (!workspace.hasRole(actor, "document", documentId, "editor")) {
        throw new EnterpriseError("forbidden", "missing editor on document");
      }
    } catch {
      ws.close(4403, "forbidden");
      return;
    }
    let room = rooms.get(documentId);
    if (!room) {
      room = { doc: loadYjsDocument(workspace, documentId), clients: new Set() };
      rooms.set(documentId, room);
    }
    room.clients.add(ws);
    ws.send(JSON.stringify({ type: "init", update: toBase64(encodeYjsState(room.doc)) }));
    ws.on("message", (raw) => {
      try {
        const message = JSON.parse(String(raw)) as { type?: string; update?: string };
        if (message.type !== "update" || typeof message.update !== "string") return;
        const update = fromBase64(message.update);
        persistYjsUpdate(workspace, actor, documentId, update);
        applyYjsUpdate(room!.doc, update, actor.principalId);
        const encoded = JSON.stringify({ type: "update", update: message.update });
        for (const peer of room!.clients) {
          if (peer !== ws && peer.readyState === peer.OPEN) peer.send(encoded);
        }
        ws.send(JSON.stringify({ type: "ack" }));
      } catch (error) {
        ws.send(JSON.stringify({ type: "error", message: error instanceof Error ? error.message : String(error) }));
      }
    });
    ws.on("close", () => {
      room?.clients.delete(ws);
    });
  });
  return wss;
}

export interface CollabListenResult {
  port: number;
  url: string;
  close: () => Promise<void>;
}

export function listenEnterpriseCollab(options: {
  workspace: EnterpriseWorkspace;
  host?: string;
  port?: number;
  editorHtml: string;
}): Promise<CollabListenResult> {
  const host = options.host ?? "127.0.0.1";
  const http: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://${host}`);
    if (url.pathname === "/collab" || url.pathname === "/collab.html") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(options.editorHtml);
      return;
    }
    res.writeHead(404);
    res.end("not found");
  });
  const wss = attachEnterpriseYjs(http, options.workspace);
  return new Promise((resolve, reject) => {
    http.listen(options.port ?? 0, host, () => {
      const address = http.address();
      if (!address || typeof address === "string") {
        reject(new Error("collab bind failed"));
        return;
      }
      resolve({
        port: address.port,
        url: `http://${host}:${address.port}`,
        close: () =>
          new Promise((done, fail) => {
            wss.close();
            http.close((err) => (err ? fail(err) : done()));
          }),
      });
    });
  });
}
