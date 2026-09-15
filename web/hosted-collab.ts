import Collaboration from "@tiptap/extension-collaboration";
import CollaborationCursor from "@tiptap/extension-collaboration-cursor";
import CharacterCount from "@tiptap/extension-character-count";
import Highlight from "@tiptap/extension-highlight";
import Image from "@tiptap/extension-image";
import Link from "@tiptap/extension-link";
import Mention from "@tiptap/extension-mention";
import Placeholder from "@tiptap/extension-placeholder";
import Table from "@tiptap/extension-table";
import TableCell from "@tiptap/extension-table-cell";
import TableHeader from "@tiptap/extension-table-header";
import TableRow from "@tiptap/extension-table-row";
import TaskItem from "@tiptap/extension-task-item";
import TaskList from "@tiptap/extension-task-list";
import TextAlign from "@tiptap/extension-text-align";
import Typography from "@tiptap/extension-typography";
import Underline from "@tiptap/extension-underline";
import StarterKit from "@tiptap/starter-kit";
import { Editor } from "@tiptap/core";
import * as Y from "yjs";
import { Awareness, applyAwarenessUpdate, encodeAwarenessUpdate, removeAwarenessStates } from "y-protocols/awareness";
import { computePosition, flip, offset, shift } from "@floating-ui/dom";
import { NomaPanel } from "./noma-panel";
import { mentionSuggestion, type MentionPerson } from "./mention-suggestion";
import { iconSvg, type IconName } from "./ui-kit";

export interface PresenceUser {
  id: string;
  name: string;
  color: string;
}

export interface HostedCollab {
  getText: () => string;
  acks: () => number;
  ready: () => boolean;
  editor: () => Editor | undefined;
  counts: () => { words: number; characters: number };
  destroy: () => void;
}

const SLASH_ITEMS: Array<{
  id: string;
  label: string;
  icon: IconName;
  run: (editor: Editor) => void;
}> = [
  { id: "h1", label: "Heading 1", icon: "Heading1", run: (editor) => editor.chain().focus().toggleHeading({ level: 1 }).run() },
  { id: "h2", label: "Heading 2", icon: "Heading2", run: (editor) => editor.chain().focus().toggleHeading({ level: 2 }).run() },
  { id: "bullet", label: "Bullet list", icon: "List", run: (editor) => editor.chain().focus().toggleBulletList().run() },
  { id: "ordered", label: "Numbered list", icon: "ListOrdered", run: (editor) => editor.chain().focus().toggleOrderedList().run() },
  { id: "task", label: "Action items", icon: "ListChecks", run: (editor) => editor.chain().focus().toggleTaskList().run() },
  { id: "table", label: "Table", icon: "Table", run: (editor) => editor.chain().focus().insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run() },
  { id: "quote", label: "Quote", icon: "Quote", run: (editor) => editor.chain().focus().toggleBlockquote().run() },
  { id: "code", label: "Code block", icon: "Code", run: (editor) => editor.chain().focus().toggleCodeBlock().run() },
  { id: "info", label: "Info panel", icon: "Info", run: (editor) => editor.chain().focus().setNomaPanel("info").run() },
  { id: "note", label: "Note panel", icon: "Lightbulb", run: (editor) => editor.chain().focus().setNomaPanel("note").run() },
  { id: "warning", label: "Warning panel", icon: "AlertTriangle", run: (editor) => editor.chain().focus().setNomaPanel("warning").run() },
  { id: "success", label: "Success panel", icon: "CircleCheck", run: (editor) => editor.chain().focus().setNomaPanel("success").run() },
  { id: "claim", label: "Claim", icon: "Highlighter", run: (editor) => editor.chain().focus().setNomaPanel("claim").run() },
  { id: "decision", label: "Decision", icon: "CircleCheck", run: (editor) => editor.chain().focus().setNomaPanel("decision").run() },
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
    const match = text.match(/(\/[a-z]*)$/i);
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
    const match = text.match(/\/([a-z]*)$/i);
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

function bindFormatBubble(editor: Editor, onComment?: (quote: string) => void): () => void {
  const bar = document.createElement("div");
  bar.className = "ew-bubble";
  bar.hidden = true;
  bar.setAttribute("role", "toolbar");
  bar.setAttribute("aria-label", "Selection formatting");
  bar.innerHTML = [
    ["bold", "Bold", "Bold"],
    ["italic", "Italic", "Italic"],
    ["underline", "Underline", "Underline"],
    ["highlight", "Highlight", "Highlighter"],
    ["align-left", "Align left", "AlignLeft"],
    ["align-center", "Align center", "AlignCenter"],
    ["align-right", "Align right", "AlignRight"],
  ]
    .map(([cmd, label, icon]) => `<button type="button" data-bubble="${cmd}" aria-label="${label}">${iconSvg(icon as IconName)}</button>`)
    .join("") +
    `<span class="ew-bubble-sep" aria-hidden="true"></span>
     <button type="button" data-bubble="comment" class="ew-bubble-comment" aria-label="Comment on selection">${iconSvg("MessageSquare")} Comment</button>`;
  document.body.appendChild(bar);

  const hide = (): void => {
    bar.hidden = true;
  };

  const place = (): void => {
    const { empty, from } = editor.state.selection;
    if (empty || !editor.isFocused) {
      hide();
      return;
    }
    bar.hidden = false;
    const coords = editor.view.coordsAtPos(from);
    const anchor = document.createElement("div");
    anchor.style.position = "fixed";
    anchor.style.left = `${coords.left}px`;
    anchor.style.top = `${coords.top}px`;
    anchor.style.width = "1px";
    anchor.style.height = "1px";
    document.body.appendChild(anchor);
    void computePosition(anchor, bar, {
      placement: "top",
      middleware: [offset(8), flip(), shift({ padding: 8 })],
    }).then(({ x, y }) => {
      bar.style.left = `${x}px`;
      bar.style.top = `${y}px`;
      anchor.remove();
    });
  };

  bar.addEventListener("mousedown", (event) => {
    event.preventDefault();
    const cmd = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-bubble]")?.dataset.bubble;
    if (cmd === "bold") editor.chain().focus().toggleBold().run();
    if (cmd === "italic") editor.chain().focus().toggleItalic().run();
    if (cmd === "underline") editor.chain().focus().toggleUnderline().run();
    if (cmd === "highlight") editor.chain().focus().toggleHighlight().run();
    if (cmd === "align-left") editor.chain().focus().setTextAlign("left").run();
    if (cmd === "align-center") editor.chain().focus().setTextAlign("center").run();
    if (cmd === "align-right") editor.chain().focus().setTextAlign("right").run();
    if (cmd === "comment") {
      const { from, to } = editor.state.selection;
      const quote = editor.state.doc.textBetween(from, to, " ").trim();
      hide();
      onComment?.(quote);
      return;
    }
    place();
  });

  editor.on("selectionUpdate", place);
  editor.on("blur", hide);
  return () => {
    editor.off("selectionUpdate", place);
    editor.off("blur", hide);
    bar.remove();
  };
}

function editorCounts(instance: Editor | undefined): { words: number; characters: number } {
  const storage = instance?.storage as { characterCount?: { words: () => number; characters: () => number } } | undefined;
  return {
    words: storage?.characterCount?.words() ?? 0,
    characters: storage?.characterCount?.characters() ?? 0,
  };
}

export function mountHostedCollab(options: {
  element: HTMLElement;
  token: string;
  documentId: string;
  user?: PresenceUser;
  people?: MentionPerson[];
  onStatus?: (text: string) => void;
  onPresence?: (users: PresenceUser[]) => void;
  onUpdate?: () => void;
  onCount?: (counts: { words: number; characters: number }) => void;
  onComment?: (quote: string) => void;
}): HostedCollab {
  const ydoc = new Y.Doc();
  const awareness = new Awareness(ydoc);
  if (options.user) awareness.setLocalStateField("user", { name: options.user.name, color: options.user.color });
  let editor: Editor | undefined;
  let socket: WebSocket | undefined;
  let ready = false;
  let acks = 0;
  let reconnectTimer: number | undefined;
  let closed = false;
  let stopSlash: (() => void) | undefined;
  let stopBubble: (() => void) | undefined;

  const setStatus = (text: string): void => {
    options.onStatus?.(text);
  };

  const bytesToB64 = (bytes: Uint8Array): string => {
    let binary = "";
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary);
  };

  const b64ToBytes = (value: string): Uint8Array => Uint8Array.from(atob(value), (char) => char.charCodeAt(0));

  const sendAwareness = (): void => {
    if (!socket || socket.readyState !== WebSocket.OPEN) return;
    socket.send(JSON.stringify({ type: "awareness", update: bytesToB64(encodeAwarenessUpdate(awareness, [awareness.clientID])) }));
  };

  awareness.on("update", (_changes: unknown, origin: unknown) => {
    if (origin === "remote") return;
    sendAwareness();
  });

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
        Placeholder.configure({ placeholder: "Type / for commands or @ to mention…" }),
        Typography,
        Underline,
        Highlight,
        TaskList,
        TaskItem.configure({ nested: true }),
        Table.configure({ resizable: true }),
        TableRow,
        TableHeader,
        TableCell,
        NomaPanel,
        TextAlign.configure({ types: ["heading", "paragraph"] }),
        Mention.configure({
          HTMLAttributes: { class: "ew-mention-chip" },
          suggestion: mentionSuggestion(options.people ?? []),
        }),
        CharacterCount,
        Link.configure({ openOnClick: false, autolink: true, HTMLAttributes: { rel: "noopener noreferrer", target: "_blank" } }),
        Image.configure({ inline: false, allowBase64: false }),
        Collaboration.configure({ document: ydoc, field: "default" }),
        CollaborationCursor.configure({
          provider: { awareness },
          user: options.user ? { name: options.user.name, color: options.user.color } : { name: "Guest", color: "#0C66E4" },
        }),
      ],
    });
    stopSlash = bindSlashMenu(editor);
    stopBubble = bindFormatBubble(editor, options.onComment);
    editor.on("update", () => {
      options.onUpdate?.();
      options.onCount?.(editorCounts(editor));
    });
    options.onCount?.(editorCounts(editor));
  };

  const connect = (): void => {
    if (closed) return;
    const protocol = window.location.protocol === "https:" ? "wss" : "ws";
    const wsUrl = `${protocol}://${window.location.host}/yjs?token=${encodeURIComponent(options.token)}&documentId=${encodeURIComponent(options.documentId)}`;
    socket = new WebSocket(wsUrl);
    socket.addEventListener("open", () => setStatus("connected"));
    socket.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data)) as { type: string; update?: string; users?: PresenceUser[] };
      if ((message.type === "init" || message.type === "update") && message.update) {
        Y.applyUpdate(ydoc, b64ToBytes(message.update), "remote");
        ready = true;
        ensureEditor();
        setStatus(message.type === "init" ? "ready" : `acks:${acks}`);
        if (message.type === "init" && socket?.readyState === WebSocket.OPEN) {
          if (options.user) socket.send(JSON.stringify({ type: "presence", user: options.user }));
          sendAwareness();
        }
        if (message.users) options.onPresence?.(message.users);
      }
      if (message.type === "presence" && message.users) options.onPresence?.(message.users);
      if (message.type === "awareness" && message.update) applyAwarenessUpdate(awareness, b64ToBytes(message.update), "remote");
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
    counts: () => editorCounts(editor),
    destroy: () => {
      closed = true;
      stopSlash?.();
      stopBubble?.();
      for (const menu of document.querySelectorAll(".ew-mention-suggest")) menu.remove();
      removeAwarenessStates(awareness, [awareness.clientID], "local");
      if (reconnectTimer !== undefined) window.clearTimeout(reconnectTimer);
      socket?.close();
      editor?.destroy();
      if (typeof awareness.destroy === "function") awareness.destroy();
      ydoc.destroy();
    },
  };
}

