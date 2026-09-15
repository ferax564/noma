import Collaboration from "@tiptap/extension-collaboration";
import Image from "@tiptap/extension-image";
import Link from "@tiptap/extension-link";
import Placeholder from "@tiptap/extension-placeholder";
import Typography from "@tiptap/extension-typography";
import Underline from "@tiptap/extension-underline";
import StarterKit from "@tiptap/starter-kit";
import { Editor } from "@tiptap/core";
import * as Y from "yjs";
import { computePosition, flip, offset, shift } from "@floating-ui/dom";
import { iconSvg } from "./ui-kit";

export interface HostedCollab {
  getText: () => string;
  acks: () => number;
  ready: () => boolean;
  editor: () => Editor | undefined;
  destroy: () => void;
}

const SLASH_ITEMS = [
  { id: "h1", label: "Heading 1", icon: "Heading1" as const, run: (editor: Editor) => editor.chain().focus().toggleHeading({ level: 1 }).run() },
  { id: "h2", label: "Heading 2", icon: "Heading2" as const, run: (editor: Editor) => editor.chain().focus().toggleHeading({ level: 2 }).run() },
  { id: "bullet", label: "Bullet list", icon: "List" as const, run: (editor: Editor) => editor.chain().focus().toggleBulletList().run() },
  { id: "ordered", label: "Numbered list", icon: "ListOrdered" as const, run: (editor: Editor) => editor.chain().focus().toggleOrderedList().run() },
  { id: "quote", label: "Quote", icon: "Quote" as const, run: (editor: Editor) => editor.chain().focus().toggleBlockquote().run() },
  { id: "code", label: "Code block", icon: "Code" as const, run: (editor: Editor) => editor.chain().focus().toggleCodeBlock().run() },
];

function bindSlashMenu(editor: Editor): () => void {
  const menu = document.createElement("div");
  menu.className = "ew-slash";
  menu.hidden = true;
  menu.setAttribute("role", "listbox");
  menu.setAttribute("aria-label", "Insert block");
  document.body.appendChild(menu);

  let query = "";
  let active = 0;

  const hide = (): void => {
    menu.hidden = true;
    query = "";
    active = 0;
  };

  const visibleItems = (): typeof SLASH_ITEMS =>
    SLASH_ITEMS.filter((item) => item.label.toLowerCase().includes(query.toLowerCase()) || item.id.startsWith(query.toLowerCase()));

  const render = (): void => {
    const items = visibleItems();
    if (!items.length) {
      hide();
      return;
    }
    active = Math.max(0, Math.min(active, items.length - 1));
    menu.hidden = false;
    menu.innerHTML = items
      .map(
        (item, index) =>
          `<button type="button" role="option" class="ew-slash-item${index === active ? " is-active" : ""}" data-slash="${item.id}">${iconSvg(item.icon)}<span>${item.label}</span></button>`,
      )
      .join("");
    const coords = editor.view.coordsAtPos(editor.state.selection.from);
    const anchor = document.createElement("div");
    anchor.style.position = "fixed";
    anchor.style.left = `${coords.left}px`;
    anchor.style.top = `${coords.bottom}px`;
    anchor.style.width = "1px";
    anchor.style.height = "1px";
    document.body.appendChild(anchor);
    void computePosition(anchor, menu, {
      placement: "bottom-start",
      middleware: [offset(8), flip(), shift({ padding: 8 })],
    }).then(({ x, y }) => {
      menu.style.left = `${x}px`;
      menu.style.top = `${y}px`;
      anchor.remove();
    });
  };

  const apply = (id: string): void => {
    const item = SLASH_ITEMS.find((entry) => entry.id === id);
    const { $from } = editor.state.selection;
    const text = $from.parent.textBetween(0, $from.parentOffset, undefined, "\ufffc");
    const match = text.match(/(?:^|\s)(\/[a-z]*)$/i);
    if (match?.[1]) {
      editor.chain().focus().deleteRange({ from: editor.state.selection.from - match[1].length, to: editor.state.selection.from }).run();
    }
    hide();
    item?.run(editor);
  };

  const onUpdate = (): void => {
    const { $from } = editor.state.selection;
    if (!$from.parent.isTextblock) {
      hide();
      return;
    }
    const text = $from.parent.textBetween(0, $from.parentOffset, undefined, "\ufffc");
    const match = text.match(/(?:^|\s)\/([a-z]*)$/i);
    if (!match) {
      hide();
      return;
    }
    query = match[1] ?? "";
    render();
  };

  const onKey = (event: KeyboardEvent): boolean => {
    if (menu.hidden) return false;
    const items = visibleItems();
    if (!items.length) return false;
    if (event.key === "ArrowDown") {
      event.preventDefault();
      active = (active + 1) % items.length;
      render();
      return true;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      active = (active - 1 + items.length) % items.length;
      render();
      return true;
    }
    if (event.key === "Enter") {
      const item = items[active];
      if (item) {
        event.preventDefault();
        apply(item.id);
        return true;
      }
    }
    if (event.key === "Escape") {
      event.preventDefault();
      hide();
      return true;
    }
    return false;
  };

  menu.addEventListener("mousedown", (event) => {
    const button = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-slash]");
    if (!button?.dataset.slash) return;
    event.preventDefault();
    apply(button.dataset.slash);
  });

  const onKeyDown = (event: KeyboardEvent): void => {
    if (onKey(event)) event.stopPropagation();
  };

  editor.on("selectionUpdate", onUpdate);
  editor.on("update", onUpdate);
  editor.view.dom.addEventListener("keydown", onKeyDown);

  return () => {
    editor.off("selectionUpdate", onUpdate);
    editor.off("update", onUpdate);
    editor.view.dom.removeEventListener("keydown", onKeyDown);
    menu.remove();
  };
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
  let stopSlash: (() => void) | undefined;

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
        Placeholder.configure({ placeholder: "Type / for commands, or start writing…" }),
        Typography,
        Underline,
        Link.configure({ openOnClick: false, autolink: true, HTMLAttributes: { rel: "noopener noreferrer", target: "_blank" } }),
        Image.configure({ inline: false, allowBase64: false }),
        Collaboration.configure({ document: ydoc, field: "default" }),
      ],
    });
    stopSlash = bindSlashMenu(editor);
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
      stopSlash?.();
      if (reconnectTimer !== undefined) window.clearTimeout(reconnectTimer);
      socket?.close();
      editor?.destroy();
      ydoc.destroy();
    },
  };
}
