import Collaboration from "@tiptap/extension-collaboration";
import Placeholder from "@tiptap/extension-placeholder";
import StarterKit from "@tiptap/starter-kit";
import { Editor } from "@tiptap/core";
import * as Y from "yjs";

export interface HostedCollab {
  getText: () => string;
  acks: () => number;
  ready: () => boolean;
  editor: () => Editor | undefined;
  destroy: () => void;
}

export function mountHostedCollab(options: {
  element: HTMLElement;
  token: string;
  documentId: string;
  onStatus?: (text: string) => void;
}): HostedCollab {
  const ydoc = new Y.Doc();
  let editor: Editor | undefined;
  let socket: WebSocket | undefined;
  let ready = false;
  let acks = 0;
  let reconnectTimer: number | undefined;
  let closed = false;

  const setStatus = (text: string): void => {
    options.onStatus?.(text);
  };

  const bytesToB64 = (bytes: Uint8Array): string => {
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary);
  };

  const b64ToBytes = (value: string): Uint8Array => Uint8Array.from(atob(value), (char) => char.charCodeAt(0));

  const sendUpdate = (update: Uint8Array): void => {
    if (!socket || socket.readyState !== WebSocket.OPEN || !ready) return;
    socket.send(JSON.stringify({ type: "update", update: bytesToB64(update) }));
  };

  ydoc.on("update", (update: Uint8Array, origin: unknown) => {
    if (origin === "remote" || !ready) return;
    sendUpdate(update);
  });

  const ensureEditor = (): void => {
    if (editor) return;
    editor = new Editor({
      element: options.element,
      extensions: [
        StarterKit.configure({ history: false }),
        Placeholder.configure({ placeholder: "Start writing…" }),
        Collaboration.configure({ document: ydoc, field: "default" }),
      ],
    });
  };

  const connect = (): void => {
    if (closed) return;
    const protocol = window.location.protocol === "https:" ? "wss" : "ws";
    const wsUrl = `${protocol}://${window.location.host}/yjs?token=${encodeURIComponent(options.token)}&documentId=${encodeURIComponent(options.documentId)}`;
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
      if (closed) return;
      setStatus("reconnecting");
      if (reconnectTimer !== undefined) window.clearTimeout(reconnectTimer);
      reconnectTimer = window.setTimeout(connect, 250);
    });
  };

  connect();

  return {
    getText: () => editor?.getText() ?? "",
    acks: () => acks,
    ready: () => ready,
    editor: () => editor,
    destroy: () => {
      closed = true;
      if (reconnectTimer !== undefined) window.clearTimeout(reconnectTimer);
      socket?.close();
      editor?.destroy();
      ydoc.destroy();
    },
  };
}
