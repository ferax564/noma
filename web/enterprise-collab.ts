import Collaboration from "@tiptap/extension-collaboration";
import StarterKit from "@tiptap/starter-kit";
import { Editor } from "@tiptap/core";
import * as Y from "yjs";

const params = new URLSearchParams(window.location.search);
const token = params.get("token") ?? "";
const documentId = params.get("documentId") ?? "";
const status = document.getElementById("status");
const mountElement = document.getElementById("editor");
if (!mountElement) throw new Error("missing #editor");
const mount: HTMLElement = mountElement;

const ydoc = new Y.Doc();
let editor: Editor | undefined;
let socket: WebSocket | undefined;
let ready = false;
let acks = 0;
let reconnectTimer: number | undefined;

function bytesToB64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function b64ToBytes(value: string): Uint8Array {
  return Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
}

function setStatus(text: string): void {
  if (status) status.textContent = text;
}

const api = {
  getText: () => editor?.getText() ?? "",
  acks: () => acks,
  ready: () => ready,
};

Object.assign(window, { nomaCollab: api });

function sendUpdate(update: Uint8Array): void {
  if (!socket || socket.readyState !== WebSocket.OPEN || !ready) return;
  socket.send(JSON.stringify({ type: "update", update: bytesToB64(update) }));
}

ydoc.on("update", (update: Uint8Array, origin: unknown) => {
  if (origin === "remote" || !ready) return;
  sendUpdate(update);
});

function ensureEditor(): void {
  if (editor) return;
  editor = new Editor({
    element: mount,
    extensions: [
      StarterKit.configure({ history: false }),
      Collaboration.configure({ document: ydoc, field: "default" }),
    ],
  });
}

function connect(): void {
  const protocol = window.location.protocol === "https:" ? "wss" : "ws";
  const wsUrl = `${protocol}://${window.location.host}/yjs?token=${encodeURIComponent(token)}&documentId=${encodeURIComponent(documentId)}`;
  socket = new WebSocket(wsUrl);
  socket.addEventListener("open", () => setStatus("connected"));
  socket.addEventListener("message", (event) => {
    const message = JSON.parse(String(event.data)) as { type: string; update?: string };
    if ((message.type === "init" || message.type === "update") && message.update) {
      Y.applyUpdate(ydoc, b64ToBytes(message.update), "remote");
      ready = true;
      ensureEditor();
      setStatus(message.type === "init" ? "ready" : `acks:${acks}`);
    }
    if (message.type === "ack") {
      acks += 1;
      setStatus(`acks:${acks}`);
    }
  });
  socket.addEventListener("close", () => {
    ready = false;
    setStatus("reconnecting");
    if (reconnectTimer !== undefined) window.clearTimeout(reconnectTimer);
    reconnectTimer = window.setTimeout(connect, 250);
  });
}

connect();
