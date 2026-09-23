/** Live co-editing session for the visual editor: Yjs over `/api/collab/documents/:id`, with presence and remote cursors. */
import type { Plugin, Transaction } from "@tiptap/pm/state";
import { redoCommand, undoCommand, yCursorPlugin, ySyncPlugin, ySyncPluginKey, yUndoPlugin } from "y-prosemirror";
import { applyAwarenessUpdate, Awareness, encodeAwarenessUpdate } from "y-protocols/awareness";
import * as Y from "yjs";
import { EDITOR_YJS_FRAGMENT } from "../../src/editor-yjs.js";

export interface LivePresence {
  clientId: number;
  userId: string | null;
  name: string;
  color: string;
  role: "viewer" | "editor" | "owner";
  readOnly: boolean;
}

export interface LiveInit {
  hash: string;
  title: string;
  source: string;
  updatedAt: string;
  readOnly: boolean;
  self: LivePresence;
  presence: LivePresence[];
}

export interface LiveSaved {
  hash: string;
  title: string;
  source: string;
  updatedAt: string;
}

export interface LiveCallbacks {
  ready(session: LiveSession, init: LiveInit): void;
  saved(saved: LiveSaved): void;
  presence(presence: LivePresence[]): void;
  role(readOnly: boolean): void;
  error(message: string): void;
  closed(reason: string, retry: boolean): void;
}

interface ServerFrame {
  type?: unknown;
  update?: unknown;
  awareness?: unknown;
  presence?: unknown;
  readOnly?: unknown;
  message?: unknown;
  code?: unknown;
}

const REMOTE = "noma-remote";

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
}

function fromBase64(value: string): Uint8Array {
  return Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
}

export class LiveSession {
  readonly doc = new Y.Doc();
  readonly awareness = new Awareness(this.doc);
  readonly fragment = this.doc.getXmlFragment(EDITOR_YJS_FRAGMENT);
  readOnly = true;
  ready = false;
  unacked = 0;
  private readonly ws: WebSocket;
  private closedByClient = false;
  private nextId = 1;

  constructor(readonly documentId: string, auth: { token?: string; share?: string }, private readonly callbacks: LiveCallbacks) {
    const protocol = window.location.protocol === "https:" ? "wss" : "ws";
    this.ws = new WebSocket(`${protocol}://${window.location.host}/api/collab/documents/${encodeURIComponent(documentId)}`);
    this.ws.addEventListener("open", () => {
      if (this.closedByClient) {
        this.ws.close(1000, "client left");
        return;
      }
      this.ws.send(JSON.stringify({ type: "hello", clientId: this.doc.clientID, token: auth.token, share: auth.share }));
    });
    this.ws.addEventListener("message", (event) => this.receive(event.data));
    this.ws.addEventListener("close", (event) => {
      this.teardown();
      if (this.closedByClient) return;
      const fatal = event.code === 4403 || event.code === 4404 || event.code === 4410 || event.code === 4401;
      this.callbacks.closed(event.reason || (fatal ? "Live editing is not available for this page" : "Live connection lost"), !fatal);
    });
    this.doc.on("update", (update: Uint8Array, origin: unknown) => {
      if (origin === REMOTE || !this.ready || this.readOnly) return;
      this.unacked += 1;
      this.send({ type: "update", id: this.nextId++, update: toBase64(update) });
    });
    this.awareness.on("update", ({ added, updated, removed }: { added: number[]; updated: number[]; removed: number[] }, origin: unknown) => {
      if (origin === REMOTE || !this.ready) return;
      const changed = [...added, ...updated, ...removed].filter((id) => id === this.doc.clientID);
      if (changed.length > 0) this.send({ type: "awareness", update: toBase64(encodeAwarenessUpdate(this.awareness, changed)) });
    });
  }

  /** ProseMirror plugins that bind the editor to this session's Yjs document. */
  plugins(): Plugin[] {
    return [ySyncPlugin(this.fragment), yCursorPlugin(this.awareness), yUndoPlugin()];
  }

  readonly undo = undoCommand;
  readonly redo = redoCommand;

  isRemote(tr: Transaction): boolean {
    const meta = tr.getMeta(ySyncPluginKey) as { isChangeOrigin?: boolean } | undefined;
    return meta?.isChangeOrigin === true;
  }

  close(): void {
    this.closedByClient = true;
    if (this.ws.readyState === WebSocket.OPEN) this.ws.close(1000, "client left");
    this.teardown();
  }

  private teardown(): void {
    this.ready = false;
    this.awareness.destroy();
  }

  private send(payload: Record<string, unknown>): void {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(payload));
  }

  private receive(data: unknown): void {
    if (typeof data !== "string" || this.closedByClient) return;
    let frame: ServerFrame;
    try {
      frame = JSON.parse(data) as ServerFrame;
    } catch {
      return;
    }
    switch (frame.type) {
      case "init": {
        if (typeof frame.update === "string") Y.applyUpdate(this.doc, fromBase64(frame.update), REMOTE);
        const init = frame as unknown as LiveInit & { awareness?: string[] };
        this.readOnly = Boolean(init.readOnly);
        this.ready = true;
        for (const update of init.awareness ?? []) applyAwarenessUpdate(this.awareness, fromBase64(update), REMOTE);
        this.awareness.setLocalStateField("user", { name: init.self.name, color: init.self.color });
        this.callbacks.ready(this, init);
        this.callbacks.presence(init.presence);
        return;
      }
      case "update":
        if (typeof frame.update === "string") Y.applyUpdate(this.doc, fromBase64(frame.update), REMOTE);
        return;
      case "ack":
        this.unacked = Math.max(0, this.unacked - 1);
        return;
      case "awareness":
        if (typeof frame.update === "string") applyAwarenessUpdate(this.awareness, fromBase64(frame.update), REMOTE);
        return;
      case "presence":
        if (Array.isArray(frame.presence)) this.callbacks.presence(frame.presence as LivePresence[]);
        return;
      case "saved":
        this.callbacks.saved(frame as unknown as LiveSaved);
        return;
      case "role":
        this.readOnly = Boolean(frame.readOnly);
        this.callbacks.role(this.readOnly);
        return;
      case "revoked":
        this.callbacks.error(typeof frame.message === "string" ? frame.message : "Access revoked");
        return;
      case "error":
        this.callbacks.error(typeof frame.message === "string" ? frame.message : "Live editing error");
        return;
      default:
        return;
    }
  }
}
