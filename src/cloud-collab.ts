/**
 * Noma Cloud live co-editing relay for the visual editor.
 *
 * One Yjs room per document at `wss://…/api/collab/documents/:id`. Every
 * update is persisted to SQLite before it is applied, broadcast and
 * acknowledged. `.noma` remains the source of truth: a coalesced checkpoint
 * (at most one per `checkpointIntervalMs` of activity, plus one when the last
 * editor leaves) converts the Yjs document to source with `editorDocToNoma`
 * and writes a normal hash-checked revision. Source writes from anywhere else
 * (agent patch apply, API PUT, restore) are merged back into the live room at
 * block granularity so humans and agents never clobber each other.
 *
 * Wire protocol (JSON text frames, binary payloads base64):
 *   client → server  hello {clientId, token?, share?} (first frame) · update {id, update} · awareness {update} · ping
 *   server → client  init · update · ack {id} · awareness · presence · saved · role · revoked · error · pong
 */
import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type RawData, type WebSocket } from "ws";
import * as Y from "yjs";
import type { CloudDocumentRecord, CloudRole } from "./cloud-db.js";
import {
  type AccessContext,
  type CloudServerConfig,
  type Principal,
  readDocument,
  requireRecordAccess,
} from "./cloud/context.js";
import { authBearer, headerValue, HttpError, sha256Hex } from "./cloud/http.js";
import { updateDocument } from "./cloud/records.js";
import { requiresCloudAccess, resolveCloudAccess } from "./cloud/routes-auth.js";
import { editorDocToNoma, editorIdBackfill, nomaToEditorDoc } from "./editor-model.js";
import { applyYAttrPatches, editorFragment, mergeSourceIntoYFragment, replaceYFragment, yFragmentToEditorDoc } from "./editor-yjs.js";

export interface CloudCollabOptions {
  /** Minimum spacing between checkpoint revisions while a room is active. Default 30s. */
  checkpointIntervalMs?: number;
  /** How often connected clients' permissions are re-validated. Default 15s. */
  permissionCheckMs?: number;
  /** How long a new socket may take to send its `hello` frame. Default 5s. */
  helloTimeoutMs?: number;
  /** Maximum concurrent sockets per document. Default 50. */
  maxClientsPerRoom?: number;
  /** Compact a room once this many bytes of updates are pending. Default 4 MiB. */
  compactAfterBytes?: number;
  /** Refuse updates once a room's stored state would exceed this size. Default 16 × maxBodyBytes (at least 16 MiB). */
  maxRoomBytes?: number;
  /** Frames a socket may send per 10 seconds before it is disconnected. Default 1000. */
  maxFramesPer10s?: number;
}

export const COLLAB_PATH_RE = /^\/api\/collab\/documents\/([A-Za-z0-9_-]{8,80})$/;

const SERVER_ORIGIN = Symbol("noma-collab-server");
const MAX_AWARENESS_BYTES = 16_384;
const PRESENCE_COLORS = ["#2563eb", "#db2777", "#059669", "#d97706", "#7c3aed", "#dc2626", "#0891b2", "#4d7c0f"];

export interface CollabPresence {
  clientId: number;
  userId: string | null;
  name: string;
  color: string;
  role: CloudRole;
  readOnly: boolean;
}

interface CollabClient {
  documentId: string;
  ws: WebSocket;
  principal: Principal;
  access: AccessContext;
  clientId: number;
  presence: CollabPresence;
  awareness?: Uint8Array;
  windowStart: number;
  windowFrames: number;
}

interface CollabRoom {
  documentId: string;
  doc: Y.Doc;
  clients: Set<CollabClient>;
  baseSource: string;
  baseHash: string;
  pendingBytes: number;
  snapshotBytes: number;
  dirty: boolean;
  lastEditor?: AccessContext;
  checkpointTimer?: NodeJS.Timeout;
  lastCheckpointAt: number;
  checkpointing?: Promise<void>;
}

type ClientMessage =
  | { type: "hello"; clientId?: unknown; token?: unknown; share?: unknown }
  | { type: "update"; id?: unknown; update?: unknown }
  | { type: "awareness"; update?: unknown }
  | { type: "ping" };

const hubs = new WeakMap<CloudServerConfig, CloudCollabHub>();

/** The live-editing hub attached to a server config, if any. */
export function collabHubFor(config: CloudServerConfig): CloudCollabHub | undefined {
  return hubs.get(config);
}

export class CloudCollabHub {
  private readonly rooms = new Map<string, CollabRoom>();
  private readonly wss: WebSocketServer;
  private readonly permissionTimer: NodeJS.Timeout;
  private readonly checkpointIntervalMs: number;
  private readonly helloTimeoutMs: number;
  private readonly maxClientsPerRoom: number;
  private readonly compactAfterBytes: number;
  private readonly maxRoomBytes: number;
  private readonly maxFramesPer10s: number;
  private closed = false;

  constructor(private readonly config: CloudServerConfig, options: CloudCollabOptions = {}) {
    this.checkpointIntervalMs = options.checkpointIntervalMs ?? 30_000;
    this.helloTimeoutMs = options.helloTimeoutMs ?? 5_000;
    this.maxClientsPerRoom = options.maxClientsPerRoom ?? 50;
    this.compactAfterBytes = options.compactAfterBytes ?? 4 * 1024 * 1024;
    this.maxRoomBytes = options.maxRoomBytes ?? Math.max(16 * 1024 * 1024, config.maxBodyBytes * 16);
    this.maxFramesPer10s = options.maxFramesPer10s ?? 1_000;
    this.wss = new WebSocketServer({ noServer: true, maxPayload: Math.max(64 * 1024, config.maxBodyBytes * 2) });
    this.permissionTimer = setInterval(() => this.recheckAll(), options.permissionCheckMs ?? 15_000);
    this.permissionTimer.unref();
    hubs.set(config, this);
    config.onDocumentWritten = (record) => this.documentWritten(record);
  }

  /** Route `upgrade` requests for `/api/collab/documents/:id` to this hub. */
  attach(server: Server): void {
    server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => this.handleUpgrade(req, socket, head));
  }

  /** Connected users for a document (for the REST status route and the page header). */
  presence(documentId: string): CollabPresence[] {
    return [...(this.rooms.get(documentId)?.clients ?? [])].map((client) => client.presence);
  }

  roomInfo(documentId: string): { live: boolean; clients: CollabPresence[]; pendingUpdates: number; baseHash?: string; dirty: boolean } {
    const room = this.rooms.get(documentId);
    return {
      live: Boolean(room),
      clients: this.presence(documentId),
      pendingUpdates: this.config.store.collabPendingUpdateCount(documentId),
      baseHash: room?.baseHash ?? this.config.store.readCollabRoom(documentId)?.baseHash,
      dirty: room?.dirty ?? false,
    };
  }

  /** Flush pending checkpoints now (used on shutdown and by tests). */
  async flush(documentId?: string): Promise<void> {
    const rooms = documentId ? [this.rooms.get(documentId)].filter((room): room is CollabRoom => Boolean(room)) : [...this.rooms.values()];
    await Promise.all(rooms.map((room) => this.checkpoint(room, true)));
  }

  /** Checkpoint every room, close every socket, and stop timers. */
  shutdown(): Promise<void> {
    if (this.closed) return Promise.resolve();
    this.closed = true;
    clearInterval(this.permissionTimer);
    const pending: Array<Promise<void>> = [];
    for (const room of this.rooms.values()) {
      if (room.checkpointTimer) clearTimeout(room.checkpointTimer);
      pending.push(this.checkpoint(room, true).then(() => this.snapshot(room)));
      for (const client of room.clients) client.ws.close(1001, "server shutting down");
    }
    this.wss.close();
    if (hubs.get(this.config) === this) hubs.delete(this.config);
    return Promise.all(pending).then(() => undefined);
  }

  private handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const url = new URL(req.url ?? "/", "http://localhost");
    const match = COLLAB_PATH_RE.exec(url.pathname);
    const reject = (status: number, reason: string): void => {
      socket.end(`HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    };
    if (!match || this.closed) return reject(404, "Not Found");
    if (requiresCloudAccess(url.pathname) && !resolveCloudAccess(this.config, req, url).ok) return reject(401, "Unauthorized");
    const origin = headerValue(req, "origin");
    if (origin) {
      let originHost = "";
      try {
        originHost = new URL(origin).host;
      } catch {
        return reject(403, "Forbidden");
      }
      const forwardedHost = this.config.trustProxy ? headerValue(req, "x-forwarded-host") : undefined;
      if (originHost !== (forwardedHost ?? headerValue(req, "host"))) return reject(403, "Forbidden");
    }
    const address = (this.config.trustProxy ? headerValue(req, "x-forwarded-for")?.split(",")[0]?.trim() : undefined) ?? req.socket.remoteAddress ?? "unknown";
    if (!this.config.rateLimiter.consume(`${address}:api`, false, this.config.now().getTime()).allowed) return reject(429, "Too Many Requests");
    const documentId = match[1]!;
    this.wss.handleUpgrade(req, socket, head, (ws) => this.handleConnection(ws, req, url, documentId));
  }

  private handleConnection(ws: WebSocket, req: IncomingMessage, url: URL, documentId: string): void {
    const headerUserToken = authBearer(req) ?? headerValue(req, "x-noma-user-token");
    const headerShareToken = url.searchParams.get("share") ?? headerValue(req, "x-noma-share-token");
    let client: CollabClient | undefined;
    const helloTimer = setTimeout(() => ws.close(4401, "hello required"), this.helloTimeoutMs);
    ws.on("message", (raw: RawData, isBinary: boolean) => {
      const message = parseMessage(raw, isBinary);
      if (!message) {
        send(ws, { type: "error", code: "bad_message", message: "Frames must be JSON objects with a type" });
        return;
      }
      if (!client) {
        if (message.type !== "hello") {
          ws.close(4401, "hello required");
          return;
        }
        clearTimeout(helloTimer);
        const userToken = typeof message.token === "string" && message.token ? message.token : headerUserToken;
        const shareToken = typeof message.share === "string" && message.share ? message.share : headerShareToken;
        const clientId = Number(message.clientId);
        if (!Number.isSafeInteger(clientId) || clientId < 0) {
          ws.close(4400, "hello.clientId must be a Yjs client id");
          return;
        }
        client = this.join(ws, documentId, clientId, userToken, shareToken);
        return;
      }
      this.handleMessage(client, message);
    });
    ws.on("close", () => {
      clearTimeout(helloTimer);
      if (client) this.leave(client);
    });
    ws.on("error", () => ws.terminate());
  }

  private join(ws: WebSocket, documentId: string, clientId: number, userToken: string | null | undefined, shareToken: string | null | undefined): CollabClient | undefined {
    const principal: Principal = {};
    if (userToken) {
      principal.userTokenHash = sha256Hex(userToken);
      principal.user = this.config.store.findUserByToken(principal.userTokenHash);
    }
    if (shareToken) principal.shareTokenHash = sha256Hex(shareToken);
    let record: CloudDocumentRecord;
    let access: AccessContext;
    try {
      record = this.readRecord(documentId);
      access = requireRecordAccess(this.config, record, principal, "viewer");
    } catch (error) {
      const status = error instanceof HttpError ? error.status : 500;
      ws.close(status === 404 ? 4404 : status === 410 ? 4410 : status === 401 ? 4401 : 4403, error instanceof Error ? error.message.slice(0, 100) : "forbidden");
      return undefined;
    }
    const room = this.room(record);
    if (room.clients.size >= this.maxClientsPerRoom) {
      ws.close(4429, "room is full");
      return undefined;
    }
    for (const other of room.clients) {
      if (other.clientId === clientId) {
        ws.close(4409, "clientId already connected");
        return undefined;
      }
    }
    const client: CollabClient = {
      documentId,
      ws,
      principal,
      access,
      clientId,
      presence: presenceFor(access, clientId),
      windowStart: Date.now(),
      windowFrames: 0,
    };
    room.clients.add(client);
    send(ws, {
      type: "init",
      update: toBase64(Y.encodeStateAsUpdate(room.doc)),
      role: access.role,
      readOnly: client.presence.readOnly,
      hash: record.hash,
      title: record.title,
      source: record.source,
      updatedAt: record.updatedAt,
      self: client.presence,
      presence: this.presence(documentId),
      awareness: [...room.clients].filter((peer) => peer !== client && peer.awareness).map((peer) => toBase64(peer.awareness!)),
      checkpointIntervalMs: this.checkpointIntervalMs,
    });
    this.broadcastPresence(room);
    return client;
  }

  private handleMessage(client: CollabClient, message: ClientMessage): void {
    const room = this.rooms.get(client.documentId);
    if (!room || !room.clients.has(client)) return;
    const now = Date.now();
    if (now - client.windowStart > 10_000) {
      client.windowStart = now;
      client.windowFrames = 0;
    }
    client.windowFrames += 1;
    if (client.windowFrames > this.maxFramesPer10s) {
      client.ws.close(4429, "too many frames");
      return;
    }
    if (message.type === "ping") {
      send(client.ws, { type: "pong" });
      return;
    }
    if (message.type === "update") {
      const id = typeof message.id === "number" || typeof message.id === "string" ? message.id : null;
      if (client.presence.readOnly) {
        send(client.ws, { type: "error", code: "read_only", id, message: "Viewer access is read-only" });
        return;
      }
      if (typeof message.update !== "string") {
        send(client.ws, { type: "error", code: "bad_update", id, message: "update must be base64" });
        return;
      }
      const update = fromBase64(message.update);
      try {
        Y.decodeUpdate(update);
      } catch {
        send(client.ws, { type: "error", code: "bad_update", id, message: "update is not a valid Yjs update" });
        return;
      }
      if (room.snapshotBytes + room.pendingBytes + update.byteLength > this.maxRoomBytes) {
        send(client.ws, { type: "error", code: "room_full", id, message: "This page is too large to keep editing live; save and reload it" });
        return;
      }
      const actor = client.access.user?.id ?? `share:${client.access.share?.id ?? "unknown"}`;
      this.config.store.appendCollabUpdate(room.documentId, update, actor, this.config.now().toISOString());
      room.pendingBytes += update.byteLength;
      Y.applyUpdate(room.doc, update, client);
      const frame = JSON.stringify({ type: "update", update: message.update });
      for (const peer of room.clients) if (peer !== client) sendRaw(peer.ws, frame);
      send(client.ws, { type: "ack", id });
      room.dirty = true;
      room.lastEditor = client.access;
      this.scheduleCheckpoint(room);
      if (room.pendingBytes > this.compactAfterBytes) this.snapshot(room);
      return;
    }
    if (message.type === "awareness") {
      if (typeof message.update !== "string" || message.update.length > MAX_AWARENESS_BYTES * 2) return;
      const rewritten = rewriteAwareness(fromBase64(message.update), client);
      if (!rewritten) return;
      client.awareness = rewritten;
      const frame = JSON.stringify({ type: "awareness", update: toBase64(rewritten) });
      for (const peer of room.clients) if (peer !== client) sendRaw(peer.ws, frame);
    }
  }

  private leave(client: CollabClient): void {
    const documentId = client.documentId;
    const room = this.rooms.get(documentId);
    if (!room || !room.clients.delete(client)) return;
    if (this.closed) return;
    const removal = encodeAwareness([{ clientId: client.clientId, clock: 0x7fffffff, state: null }]);
    const frame = JSON.stringify({ type: "awareness", update: toBase64(removal) });
    for (const peer of room.clients) sendRaw(peer.ws, frame);
    this.broadcastPresence(room);
    if (room.clients.size > 0) return;
    if (room.checkpointTimer) clearTimeout(room.checkpointTimer);
    room.checkpointTimer = undefined;
    void this.checkpoint(room, true).finally(() => {
      if (room.clients.size === 0 && this.rooms.get(documentId) === room) {
        this.snapshot(room);
        room.doc.destroy();
        this.rooms.delete(documentId);
      }
    });
  }

  private readRecord(documentId: string): CloudDocumentRecord {
    const record = this.config.store.readDocument(documentId);
    if (!record) throw new HttpError(404, "Record not found");
    if (this.config.store.isTrashed("document", documentId)) throw new HttpError(410, "Document is in trash");
    return record;
  }

  private room(record: CloudDocumentRecord): CollabRoom {
    const existing = this.rooms.get(record.id);
    if (existing) return existing;
    const persisted = this.config.store.readCollabRoom(record.id);
    const recoveredActor = persisted && persisted.updates.length > 0 ? this.config.store.lastCollabActor(record.id) : undefined;
    const doc = new Y.Doc();
    let baseSource = record.source;
    if (persisted?.state && persisted.baseSource !== undefined) {
      Y.applyUpdate(doc, persisted.state, SERVER_ORIGIN);
      for (const update of persisted.updates) Y.applyUpdate(doc, update, SERVER_ORIGIN);
      baseSource = persisted.baseSource;
    } else {
      doc.transact(() => replaceYFragment(editorFragment(doc), nomaToEditorDoc(record.source)), SERVER_ORIGIN);
    }
    const room: CollabRoom = {
      documentId: record.id,
      doc,
      clients: new Set(),
      baseSource,
      baseHash: sha256Hex(baseSource),
      pendingBytes: 0,
      snapshotBytes: 0,
      dirty: false,
      lastCheckpointAt: 0,
      lastEditor: recoveredActor ? this.recoveredEditor(record, recoveredActor) : undefined,
    };
    doc.on("update", (update: Uint8Array, origin: unknown) => {
      if (origin !== SERVER_ORIGIN || !this.rooms.has(room.documentId)) return;
      this.config.store.appendCollabUpdate(room.documentId, update, "system", this.config.now().toISOString());
      room.pendingBytes += update.byteLength;
      const frame = JSON.stringify({ type: "update", update: toBase64(update) });
      for (const client of room.clients) sendRaw(client.ws, frame);
    });
    this.rooms.set(record.id, room);
    if (room.baseSource !== record.source) this.mergeExternal(room, record);
    else this.snapshot(room);
    if (this.derivedSource(room) !== record.source) {
      room.dirty = true;
      this.scheduleCheckpoint(room);
    }
    return room;
  }

  /** Attribute edits recovered after a restart to their last author, if that person can still edit. */
  private recoveredEditor(record: CloudDocumentRecord, actorId: string): AccessContext | undefined {
    const user = this.config.store.readUser(actorId);
    if (!user) return undefined;
    try {
      return requireRecordAccess(this.config, record, { user }, "editor");
    } catch {
      return undefined;
    }
  }

  private derivedSource(room: CollabRoom): string {
    return editorDocToNoma(yFragmentToEditorDoc(editorFragment(room.doc)), room.baseSource);
  }

  private mergeExternal(room: CollabRoom, record: CloudDocumentRecord): void {
    room.doc.transact(() => mergeSourceIntoYFragment(editorFragment(room.doc), room.baseSource, record.source), SERVER_ORIGIN);
    room.baseSource = record.source;
    room.baseHash = record.hash;
    this.snapshot(room);
  }

  /** Write hook: merge a source change made outside the room and tell clients about the new revision. */
  documentWritten(record: CloudDocumentRecord): void {
    const room = this.rooms.get(record.id);
    if (!room || this.closed) return;
    try {
      if (record.source !== room.baseSource) {
        this.mergeExternal(room, record);
        if (this.derivedSource(room) !== record.source) {
          room.dirty = true;
          this.scheduleCheckpoint(room);
        } else {
          room.dirty = false;
        }
      }
      const saved = JSON.stringify({ type: "saved", hash: record.hash, title: record.title, updatedAt: record.updatedAt, source: record.source });
      for (const client of room.clients) sendRaw(client.ws, saved);
      for (const client of [...room.clients]) this.recheck(client, room, record);
    } catch (error) {
      console.error("noma collab: failed to merge external write", error);
    }
  }

  private scheduleCheckpoint(room: CollabRoom): void {
    if (room.checkpointTimer || this.closed) return;
    const wait = Math.max(0, room.lastCheckpointAt + this.checkpointIntervalMs - Date.now());
    room.checkpointTimer = setTimeout(() => {
      room.checkpointTimer = undefined;
      void this.checkpoint(room, false);
    }, Math.max(wait, Math.min(this.checkpointIntervalMs, 1_000)));
    room.checkpointTimer.unref();
  }

  private checkpoint(room: CollabRoom, final: boolean): Promise<void> {
    const run = async (): Promise<void> => {
      if (!room.dirty && !final) return;
      let record: CloudDocumentRecord;
      try {
        record = await readDocument(this.config, room.documentId);
      } catch {
        return;
      }
      const source = this.derivedSource(room);
      room.lastCheckpointAt = Date.now();
      if (source === record.source) {
        room.dirty = false;
        return;
      }
      if (Buffer.byteLength(source) > this.config.maxBodyBytes) {
        this.broadcastError(room, "checkpoint_too_large", "The live document exceeds the maximum page size; remove content to save it.");
        return;
      }
      const editor = room.lastEditor;
      if (!editor) return;
      try {
        await updateDocument(this.config, record, { source }, editor);
      } catch (error) {
        if (error instanceof HttpError && error.status === 409 && !final) {
          room.dirty = true;
          this.scheduleCheckpoint(room);
          return;
        }
        this.broadcastError(room, "checkpoint_failed", error instanceof Error ? error.message : "Checkpoint failed");
        return;
      }
      room.dirty = this.derivedSource(room) !== room.baseSource;
      const patches = editorIdBackfill(yFragmentToEditorDoc(editorFragment(room.doc)), room.baseSource);
      if (patches.length > 0) room.doc.transact(() => applyYAttrPatches(editorFragment(room.doc), patches), SERVER_ORIGIN);
      this.snapshot(room);
    };
    const previous = room.checkpointing ?? Promise.resolve();
    const next = previous.then(run, run);
    room.checkpointing = next;
    return next;
  }

  private snapshot(room: CollabRoom): void {
    const state = Y.encodeStateAsUpdate(room.doc);
    this.config.store.writeCollabSnapshot(room.documentId, state, room.baseSource, room.baseHash, this.config.now().toISOString());
    room.snapshotBytes = state.byteLength;
    room.pendingBytes = 0;
  }

  private broadcastPresence(room: CollabRoom): void {
    const frame = JSON.stringify({ type: "presence", presence: [...room.clients].map((client) => client.presence) });
    for (const client of room.clients) sendRaw(client.ws, frame);
  }

  private broadcastError(room: CollabRoom, code: string, message: string): void {
    const frame = JSON.stringify({ type: "error", code, message });
    for (const client of room.clients) sendRaw(client.ws, frame);
  }

  private recheckAll(): void {
    for (const room of [...this.rooms.values()]) {
      let record: CloudDocumentRecord | undefined;
      try {
        record = this.readRecord(room.documentId);
      } catch {
        record = undefined;
      }
      for (const client of [...room.clients]) this.recheck(client, room, record);
    }
  }

  private recheck(client: CollabClient, room: CollabRoom, record: CloudDocumentRecord | undefined): void {
    let access: AccessContext | undefined;
    if (record && !this.config.store.isTrashed("document", record.id)) {
      const principal: Principal = { ...client.principal };
      if (principal.userTokenHash) principal.user = this.config.store.findUserByToken(principal.userTokenHash);
      try {
        access = requireRecordAccess(this.config, record, principal, "viewer");
      } catch {
        access = undefined;
      }
    }
    if (!access) {
      send(client.ws, { type: "revoked", message: "Your access to this page was removed" });
      room.clients.delete(client);
      client.ws.close(4403, "access revoked");
      this.broadcastPresence(room);
      return;
    }
    const previous = client.presence;
    client.access = access;
    client.presence = presenceFor(access, client.clientId);
    if (previous.role !== client.presence.role) {
      send(client.ws, { type: "role", role: client.presence.role, readOnly: client.presence.readOnly });
      this.broadcastPresence(room);
    }
  }
}

/** Attach the live-editing relay to a Noma Cloud HTTP server. */
export function attachCloudCollab(server: Server, config: CloudServerConfig, options: CloudCollabOptions = {}): CloudCollabHub {
  const hub = new CloudCollabHub(config, options);
  hub.attach(server);
  return hub;
}

function presenceFor(access: AccessContext, clientId: number): CollabPresence {
  const userId = access.user?.id ?? null;
  const seed = userId ?? `share:${access.share?.id ?? clientId}`;
  const color = PRESENCE_COLORS[parseInt(sha256Hex(seed).slice(0, 6), 16) % PRESENCE_COLORS.length]!;
  return {
    clientId,
    userId,
    name: access.user?.name ?? (access.share?.label ? `${access.share.label} (link)` : "Share-link guest"),
    color,
    role: access.role,
    readOnly: access.role === "viewer",
  };
}

function parseMessage(raw: RawData, isBinary: boolean): ClientMessage | undefined {
  if (isBinary) return undefined;
  try {
    const text = Array.isArray(raw) ? Buffer.concat(raw).toString("utf8") : Buffer.from(raw as ArrayBuffer).toString("utf8");
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return undefined;
    const type = (parsed as { type?: unknown }).type;
    if (type === "hello" || type === "update" || type === "awareness" || type === "ping") return parsed as ClientMessage;
    return undefined;
  } catch {
    return undefined;
  }
}

function send(ws: WebSocket, payload: Record<string, unknown>): void {
  sendRaw(ws, JSON.stringify(payload));
}

function sendRaw(ws: WebSocket, frame: string): void {
  if (ws.readyState === ws.OPEN) ws.send(frame);
}

function toBase64(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64");
}

function fromBase64(value: string): Uint8Array {
  return new Uint8Array(Buffer.from(value, "base64"));
}

interface AwarenessEntry {
  clientId: number;
  clock: number;
  state: Record<string, unknown> | null;
}

/**
 * Validate a y-protocols awareness update: only the sender's own client id is
 * accepted, and the `user` field is overwritten with the server-known identity
 * so names and colours cannot be spoofed.
 */
function rewriteAwareness(update: Uint8Array, client: CollabClient): Uint8Array | undefined {
  if (update.byteLength > MAX_AWARENESS_BYTES) return undefined;
  const entries = decodeAwareness(update);
  if (!entries) return undefined;
  const own = entries.filter((entry) => entry.clientId === client.clientId);
  if (own.length === 0) return undefined;
  return encodeAwareness(
    own.map((entry) => ({
      ...entry,
      state: entry.state
        ? { ...entry.state, user: { name: client.presence.name, color: client.presence.color, userId: client.presence.userId } }
        : null,
    })),
  );
}

function decodeAwareness(update: Uint8Array): AwarenessEntry[] | undefined {
  let offset = 0;
  const readVarUint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      if (offset >= update.length || shift > 49) throw new Error("truncated varuint");
      const byte = update[offset++]!;
      value += (byte & 0x7f) * 2 ** shift;
      if (byte < 0x80) return value;
      shift += 7;
    }
  };
  try {
    const count = readVarUint();
    if (count > 64) return undefined;
    const entries: AwarenessEntry[] = [];
    for (let i = 0; i < count; i++) {
      const clientId = readVarUint();
      const clock = readVarUint();
      const length = readVarUint();
      if (offset + length > update.length) return undefined;
      const json = new TextDecoder().decode(update.subarray(offset, offset + length));
      offset += length;
      const state = JSON.parse(json) as unknown;
      entries.push({ clientId, clock, state: state && typeof state === "object" && !Array.isArray(state) ? (state as Record<string, unknown>) : null });
    }
    return entries;
  } catch {
    return undefined;
  }
}

function encodeAwareness(entries: AwarenessEntry[]): Uint8Array {
  const bytes: number[] = [];
  const writeVarUint = (value: number): void => {
    let rest = value;
    while (rest > 0x7f) {
      bytes.push((rest % 0x80) | 0x80);
      rest = Math.floor(rest / 0x80);
    }
    bytes.push(rest);
  };
  writeVarUint(entries.length);
  for (const entry of entries) {
    writeVarUint(entry.clientId);
    writeVarUint(entry.clock);
    const json = new TextEncoder().encode(JSON.stringify(entry.state));
    writeVarUint(json.length);
    bytes.push(...json);
  }
  return Uint8Array.from(bytes);
}
