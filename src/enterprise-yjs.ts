import { randomUUID } from "node:crypto";
import { createServer, type IncomingMessage, type Server } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import * as Y from "yjs";
import { EnterpriseError } from "./enterprise-contracts.js";
import { sha256Hex } from "./hash.js";
import type { ActorContext } from "./enterprise-contracts.js";
import type { EnterpriseWorkspace } from "./enterprise-workspace.js";

export const YJS_FRAGMENT = "default";

/** Subprotocol the relay selects; clients must offer it alongside their bearer subprotocol. */
export const YJS_SUBPROTOCOL = "noma.v1";

/** Clients authenticate by offering `noma.bearer.<token>` as a WebSocket subprotocol. */
export const YJS_BEARER_PREFIX = "noma.bearer.";

const YJS_CLIENT_ID = "yjs";
const COMPACTION_ACTOR = "system:yjs-compaction";

/** Test-only seams. Production callers leave these unset. */
export interface YjsPersistHooks {
  /** Runs after the update is durably committed and before the result is returned. */
  afterPersist?: (result: { hash: string; seq: number }) => void;
}

export interface PersistYjsOptions {
  hooks?: YjsPersistHooks;
}

export interface EnterpriseYjsOptions {
  /**
   * Accept `?token=` on the upgrade URL. Off by default: query strings end up
   * in proxy logs, browser history, and Referer headers. Enable only for a
   * legacy client that cannot send a subprotocol or Authorization header.
   */
  allowQueryToken?: boolean;
  /** Evict a room this many ms after its last client disconnects. Default 30 000. */
  roomIdleMs?: number;
  /** Merge persisted updates into one snapshot once this many are stored. Default 200; 0 disables. */
  compactAfter?: number;
  /** Largest accepted decoded Yjs update, in bytes. Default 2 MiB. */
  maxUpdateBytes?: number;
  /** Largest accepted serialized presence state, in bytes. Default 2 KiB. */
  maxPresenceBytes?: number;
  /** How often an open socket re-checks its session and grant. Default 5 000 ms. */
  reauthIntervalMs?: number;
}

export interface PresenceEntry {
  clientId: string;
  principalId: string;
  name: string;
  state: Record<string, unknown>;
}

export interface EnterpriseYjsRelay {
  wss: WebSocketServer;
  /** Document IDs with a live in-memory room. */
  roomIds(): string[];
  /** Presence entries currently published in a room. */
  presence(documentId: string): PresenceEntry[];
  close(): Promise<void>;
}

interface Connection {
  clientId: string;
  actor: ActorContext;
  name: string;
  canEdit: boolean;
  presence: Record<string, unknown> | null;
  lastAuthAt: number;
}

interface Room {
  documentId: string;
  doc: Y.Doc;
  clients: Map<WebSocket, Connection>;
  idleTimer?: NodeJS.Timeout;
}

interface UpgradeContext {
  actor: ActorContext;
  documentId: string;
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

function assertWellFormedUpdate(update: Uint8Array): void {
  try {
    Y.decodeUpdate(update);
  } catch {
    throw new EnterpriseError("invalid", "malformed Yjs update");
  }
}

/**
 * Durably append one Yjs update for a document. The sequence number is
 * allocated inside a `BEGIN IMMEDIATE` transaction, so concurrent writers in
 * other processes serialize on SQLite's reserved lock instead of racing on
 * `MAX(seq) + 1`; `UNIQUE (document_id, seq)` remains the backstop.
 */
export function persistYjsUpdate(
  workspace: EnterpriseWorkspace,
  actor: ActorContext,
  documentId: string,
  update: Uint8Array,
  options: PersistYjsOptions = {},
): { hash: string; seq: number } {
  if (!workspace.hasRole(actor, "document", documentId, "editor")) {
    throw new EnterpriseError("forbidden", "missing editor on document");
  }
  assertWellFormedUpdate(update);
  const encoded = toBase64(update);
  const hash = sha256Hex(encoded);
  const db = workspace.store.db;
  const append = db.transaction((): number => {
    const { n } = db
      .prepare("SELECT COALESCE(MAX(seq), 0) AS n FROM crdt_updates WHERE document_id = ?")
      .get(documentId) as { n: number };
    const seq = n + 1;
    db.prepare(
      `INSERT INTO crdt_updates(id, document_id, seq, client_id, client_seq, actor_id, ops_json, hash, persisted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      `yjs-${documentId}-${seq}`,
      documentId,
      seq,
      YJS_CLIENT_ID,
      seq,
      actor.principalId,
      JSON.stringify({ yjs: encoded }),
      hash,
      new Date().toISOString(),
    );
    return seq;
  });
  const result = { hash, seq: append.immediate() };
  options.hooks?.afterPersist?.(result);
  return result;
}

function yjsRows(workspace: EnterpriseWorkspace, documentId: string): Array<{ seq: number; ops_json: string }> {
  return workspace.store.db
    .prepare("SELECT seq, ops_json FROM crdt_updates WHERE document_id = ? AND client_id = ? ORDER BY seq")
    .all(documentId, YJS_CLIENT_ID) as Array<{ seq: number; ops_json: string }>;
}

function docFromRows(rows: Array<{ ops_json: string }>): Y.Doc {
  const doc = new Y.Doc();
  for (const row of rows) {
    const payload = JSON.parse(row.ops_json) as { yjs?: string };
    if (payload.yjs) Y.applyUpdate(doc, fromBase64(payload.yjs));
  }
  return doc;
}

export function loadYjsDocument(workspace: EnterpriseWorkspace, documentId: string): Y.Doc {
  return docFromRows(yjsRows(workspace, documentId));
}

export function yjsPersistedCount(workspace: EnterpriseWorkspace, documentId: string): number {
  const row = workspace.store.db
    .prepare("SELECT COUNT(*) AS n FROM crdt_updates WHERE document_id = ? AND client_id = ?")
    .get(documentId, YJS_CLIENT_ID) as { n: number };
  return row.n;
}

/**
 * Replace every persisted Yjs update of a document with one
 * `Y.encodeStateAsUpdate` snapshot at the highest compacted `seq`. Runs in a
 * single `BEGIN IMMEDIATE` transaction: a concurrent writer either lands
 * before (and is folded in) or waits and appends after the snapshot, so no
 * update is lost. Returns `null` when fewer than `minUpdates` rows exist.
 */
export function compactYjsUpdates(
  workspace: EnterpriseWorkspace,
  documentId: string,
  minUpdates = 2,
): { compacted: number; seq: number; hash: string } | null {
  const db = workspace.store.db;
  const run = db.transaction(() => {
    const rows = yjsRows(workspace, documentId);
    const last = rows[rows.length - 1];
    if (!last || rows.length < Math.max(2, minUpdates)) return null;
    const doc = docFromRows(rows);
    const snapshot = toBase64(Y.encodeStateAsUpdate(doc));
    doc.destroy();
    const hash = sha256Hex(snapshot);
    db.prepare("DELETE FROM crdt_updates WHERE document_id = ? AND client_id = ? AND seq <= ?").run(
      documentId,
      YJS_CLIENT_ID,
      last.seq,
    );
    db.prepare(
      `INSERT INTO crdt_updates(id, document_id, seq, client_id, client_seq, actor_id, ops_json, hash, persisted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      `yjs-snapshot-${documentId}-${last.seq}`,
      documentId,
      last.seq,
      YJS_CLIENT_ID,
      last.seq,
      COMPACTION_ACTOR,
      JSON.stringify({ yjs: snapshot, snapshot: true, compacted: rows.length }),
      hash,
      new Date().toISOString(),
    );
    return { compacted: rows.length, seq: last.seq, hash };
  });
  return run.immediate();
}

/**
 * Pull the session token from an upgrade request. Order: `Authorization:
 * Bearer`, then a `noma.bearer.<token>` subprotocol, then (only when
 * `allowQueryToken`) the legacy `?token=` query parameter.
 */
export function extractYjsToken(req: IncomingMessage, options: { allowQueryToken?: boolean } = {}): string | undefined {
  const authorization = req.headers.authorization;
  if (typeof authorization === "string") {
    const match = /^Bearer\s+(\S+)\s*$/i.exec(authorization);
    if (match?.[1]) return match[1];
  }
  const offered = req.headers["sec-websocket-protocol"];
  if (typeof offered === "string") {
    for (const raw of offered.split(",")) {
      const protocol = raw.trim();
      if (protocol.startsWith(YJS_BEARER_PREFIX) && protocol.length > YJS_BEARER_PREFIX.length) {
        return protocol.slice(YJS_BEARER_PREFIX.length);
      }
    }
  }
  if (options.allowQueryToken) {
    const url = new URL(req.url ?? "/", "http://enterprise.local");
    const token = url.searchParams.get("token");
    if (token) return token;
  }
  return undefined;
}

export function enterpriseCollabHtml(script: string): string {
  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <title>Noma hosted collab</title>
    <style>
      html, body { margin: 0; font-family: ui-sans-serif, system-ui, sans-serif; }
      #status { padding: 0.5rem 1rem; background: #111; color: #fff; }
      #presence { padding: 0.25rem 1rem; font-size: 0.85rem; color: #444; }
      #editor { min-height: 12rem; }
      .ProseMirror { min-height: 12rem; padding: 1rem; outline: none; }
    </style>
  </head>
  <body>
    <div id="status">connecting</div>
    <div id="presence"></div>
    <div id="editor"></div>
    <script>${script}</script>
  </body>
</html>`;
}

function rejectUpgrade(socket: Duplex, status: 400 | 401 | 403 | 404): void {
  const reason = { 400: "Bad Request", 401: "Unauthorized", 403: "Forbidden", 404: "Not Found" }[status];
  socket.write(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
  socket.destroy();
}

function principalName(workspace: EnterpriseWorkspace, actor: ActorContext): string {
  const row = workspace.store.db
    .prepare("SELECT name FROM principals WHERE id = ? AND tenant_id = ?")
    .get(actor.principalId, actor.tenantId) as { name: string } | undefined;
  return row?.name ?? actor.principalId;
}

function send(ws: WebSocket, message: unknown): void {
  if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(message));
}

/**
 * Attach the persist-before-ack Yjs relay at `/yjs` on an HTTP server.
 *
 * Wire protocol (JSON text frames):
 * - server → client: `init {update, canEdit, clientId, presence[]}`, `update {update}`,
 *   `ack {seq}`, `presence {clientId, principalId, name, state|null}`, `error {message}`
 * - client → server: `update {update}` (base64 Yjs update), `presence {state|null}`
 *
 * Viewers may connect and receive updates and presence; only editors may send updates.
 */
export function attachEnterpriseYjs(
  http: Server,
  workspace: EnterpriseWorkspace,
  options: EnterpriseYjsOptions = {},
): EnterpriseYjsRelay {
  const roomIdleMs = options.roomIdleMs ?? 30_000;
  const compactAfter = options.compactAfter ?? 200;
  const maxUpdateBytes = options.maxUpdateBytes ?? 2 * 1024 * 1024;
  const maxPresenceBytes = options.maxPresenceBytes ?? 2 * 1024;
  const reauthIntervalMs = options.reauthIntervalMs ?? 5_000;
  const rooms = new Map<string, Room>();
  const wss = new WebSocketServer({
    noServer: true,
    maxPayload: Math.ceil((maxUpdateBytes * 4) / 3) + 1024,
    handleProtocols: (protocols) => (protocols.has(YJS_SUBPROTOCOL) ? YJS_SUBPROTOCOL : false),
  });

  const evict = (room: Room): void => {
    if (room.idleTimer) clearTimeout(room.idleTimer);
    room.idleTimer = undefined;
    room.doc.destroy();
    rooms.delete(room.documentId);
  };

  const scheduleEviction = (room: Room): void => {
    if (room.clients.size > 0) return;
    if (room.idleTimer) clearTimeout(room.idleTimer);
    room.idleTimer = setTimeout(() => {
      if (room.clients.size === 0 && rooms.get(room.documentId) === room) evict(room);
    }, roomIdleMs);
    room.idleTimer.unref();
  };

  const openRoom = (documentId: string): Room => {
    let room = rooms.get(documentId);
    if (!room) {
      room = { documentId, doc: loadYjsDocument(workspace, documentId), clients: new Map() };
      rooms.set(documentId, room);
    }
    if (room.idleTimer) {
      clearTimeout(room.idleTimer);
      room.idleTimer = undefined;
    }
    return room;
  };

  const broadcast = (room: Room, from: WebSocket | undefined, message: unknown): void => {
    const encoded = JSON.stringify(message);
    for (const peer of room.clients.keys()) {
      if (peer !== from && peer.readyState === peer.OPEN) peer.send(encoded);
    }
  };

  const presenceList = (room: Room, except?: WebSocket): PresenceEntry[] => {
    const out: PresenceEntry[] = [];
    for (const [peer, conn] of room.clients) {
      if (peer === except || !conn.presence) continue;
      out.push({ clientId: conn.clientId, principalId: conn.actor.principalId, name: conn.name, state: conn.presence });
    }
    return out;
  };

  http.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = new URL(req.url ?? "/", "http://enterprise.local");
    if (url.pathname !== "/yjs") {
      rejectUpgrade(socket, 404);
      return;
    }
    const documentId = url.searchParams.get("documentId") ?? "";
    const token = extractYjsToken(req, options);
    if (!documentId) {
      rejectUpgrade(socket, 400);
      return;
    }
    if (!token) {
      rejectUpgrade(socket, 401);
      return;
    }
    let actor: ActorContext;
    try {
      actor = workspace.authenticate(token);
    } catch {
      rejectUpgrade(socket, 401);
      return;
    }
    let allowed = false;
    try {
      allowed = workspace.hasRole(actor, "document", documentId, "viewer");
    } catch {
      allowed = false;
    }
    if (!allowed) {
      rejectUpgrade(socket, 403);
      return;
    }
    const context: UpgradeContext = { actor, documentId };
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req, context));
  });

  wss.on("connection", (ws: WebSocket, _req: IncomingMessage, context: UpgradeContext) => {
    const { actor, documentId } = context;
    const room = openRoom(documentId);
    let canEdit = false;
    try {
      canEdit = workspace.hasRole(actor, "document", documentId, "editor");
    } catch {
      canEdit = false;
    }
    const conn: Connection = {
      clientId: randomUUID(),
      actor,
      name: principalName(workspace, actor),
      canEdit,
      presence: null,
      lastAuthAt: Date.now(),
    };
    room.clients.set(ws, conn);
    send(ws, {
      type: "init",
      update: toBase64(encodeYjsState(room.doc)),
      canEdit,
      clientId: conn.clientId,
      presence: presenceList(room, ws),
    });

    const stillAuthorized = (): boolean => {
      if (Date.now() - conn.lastAuthAt < reauthIntervalMs) return true;
      try {
        if (!workspace.hasRole(actor, "document", documentId, "viewer")) return false;
        conn.canEdit = workspace.hasRole(actor, "document", documentId, "editor");
        conn.lastAuthAt = Date.now();
        return true;
      } catch {
        return false;
      }
    };

    ws.on("message", (raw) => {
      if (!stillAuthorized()) {
        ws.close(4401, "session no longer authorized");
        return;
      }
      let message: { type?: unknown; update?: unknown; state?: unknown };
      try {
        message = JSON.parse(String(raw)) as typeof message;
      } catch {
        send(ws, { type: "error", message: "malformed message" });
        return;
      }
      if (message.type === "presence") {
        const state = message.state;
        if (state !== null && (typeof state !== "object" || Array.isArray(state))) {
          send(ws, { type: "error", message: "presence state must be an object or null" });
          return;
        }
        if (state !== null && JSON.stringify(state).length > maxPresenceBytes) {
          send(ws, { type: "error", message: "presence state too large" });
          return;
        }
        conn.presence = state as Record<string, unknown> | null;
        broadcast(room, ws, {
          type: "presence",
          clientId: conn.clientId,
          principalId: actor.principalId,
          name: conn.name,
          state: conn.presence,
        });
        return;
      }
      if (message.type !== "update" || typeof message.update !== "string") return;
      try {
        if (!conn.canEdit) throw new EnterpriseError("forbidden", "missing editor on document");
        const update = fromBase64(message.update);
        if (update.byteLength > maxUpdateBytes) throw new EnterpriseError("invalid", "Yjs update too large");
        const { seq } = persistYjsUpdate(workspace, actor, documentId, update);
        applyYjsUpdate(room.doc, update, actor.principalId);
        broadcast(room, ws, { type: "update", update: message.update });
        send(ws, { type: "ack", seq });
        if (compactAfter > 0 && yjsPersistedCount(workspace, documentId) >= compactAfter) {
          compactYjsUpdates(workspace, documentId, compactAfter);
        }
      } catch (error) {
        send(ws, { type: "error", message: error instanceof Error ? error.message : String(error) });
      }
    });

    ws.on("error", () => ws.terminate());
    ws.on("close", () => {
      room.clients.delete(ws);
      if (conn.presence) {
        broadcast(room, undefined, {
          type: "presence",
          clientId: conn.clientId,
          principalId: actor.principalId,
          name: conn.name,
          state: null,
        });
      }
      scheduleEviction(room);
    });
  });

  return {
    wss,
    roomIds: () => [...rooms.keys()],
    presence: (documentId) => {
      const room = rooms.get(documentId);
      return room ? presenceList(room) : [];
    },
    close: () =>
      new Promise((resolve) => {
        for (const client of wss.clients) client.terminate();
        for (const room of [...rooms.values()]) evict(room);
        wss.close(() => resolve());
      }),
  };
}

export interface CollabListenResult {
  port: number;
  url: string;
  relay: EnterpriseYjsRelay;
  close: () => Promise<void>;
}

export function listenEnterpriseCollab(options: {
  workspace: EnterpriseWorkspace;
  host?: string;
  port?: number;
  editorHtml: string;
  yjs?: EnterpriseYjsOptions;
}): Promise<CollabListenResult> {
  const host = options.host ?? "127.0.0.1";
  const http: Server = createServer((req, res) => {
    const url = new URL(req.url ?? "/", `http://${host}`);
    if (url.pathname === "/collab" || url.pathname === "/collab.html") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "referrer-policy": "no-referrer" });
      res.end(options.editorHtml);
      return;
    }
    res.writeHead(404);
    res.end("not found");
  });
  const relay = attachEnterpriseYjs(http, options.workspace, options.yjs);
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
        relay,
        close: async () => {
          await relay.close();
          await new Promise<void>((done, fail) => http.close((err) => (err ? fail(err) : done())));
        },
      });
    });
  });
}
