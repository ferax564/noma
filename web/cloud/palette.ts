/** Command palette (Cmd/Ctrl+K): one search box across spaces, pages, Work issues, channels, DMs and messages. */
import { fetchCloudJson } from "./api.js";
import { openChatAt } from "./chat.js";
import { commandPalette, commandPaletteButton, commandPaletteInput, commandPaletteResults, workProjectSelect } from "./dom.js";
import { loadSite, loadStandaloneDocument } from "./navigation.js";
import { state } from "./state.js";
import { emptyState, errorMessage, setCloudStatus } from "./util.js";
import { loadWorkProject, selectWorkIssue } from "./work.js";

interface FindResponse {
  spaces: Array<{ id: string; title: string; key?: string }>;
  pages: Array<{ id: string; title: string; siteId?: string; excerpt: string }>;
  issues: Array<{ id: string; key: string; summary: string; status: string; projectId: string; siteId: string }>;
  channels: Array<{ id: string; name: string; siteId: string; visibility: string; topic?: string }>;
  dms: Array<{ id: string; title: string }>;
  messages: Array<{ id: string; channelId: string; channel: string; threadId?: string; author: string; excerpt: string }>;
}

interface PaletteItem {
  group: string;
  title: string;
  detail: string;
  open: () => Promise<void>;
}

let items: PaletteItem[] = [];
let selected = 0;
let timer: number | undefined;
let sequence = 0;
let returnFocus: HTMLElement | null = null;

export function installCommandPalette(): void {
  commandPaletteButton.addEventListener("click", () => openPalette());
  document.addEventListener("keydown", (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k" && state.cloudUser) {
      event.preventDefault();
      if (commandPalette.hidden) openPalette();
      else closePalette();
    }
  });
  commandPalette.addEventListener("click", (event) => {
    if (event.target === commandPalette) closePalette();
  });
  commandPaletteInput.addEventListener("input", () => {
    window.clearTimeout(timer);
    timer = window.setTimeout(() => void runFind(), 150);
  });
  commandPaletteInput.addEventListener("keydown", (event) => {
    if (event.key === "Escape") {
      event.preventDefault();
      closePalette();
    } else if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (items.length === 0) return;
      selected = (selected + (event.key === "ArrowDown" ? 1 : items.length - 1)) % items.length;
      renderItems();
    } else if (event.key === "Enter") {
      event.preventDefault();
      const item = items[selected];
      if (item) void choose(item);
    }
  });
}

function openPalette(): void {
  returnFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  commandPalette.hidden = false;
  commandPaletteInput.value = "";
  items = [];
  selected = 0;
  commandPaletteResults.replaceChildren(emptyState("Type to search everything you can see"));
  commandPaletteInput.focus();
}

function closePalette(): void {
  commandPalette.hidden = true;
  returnFocus?.focus();
}

async function runFind(): Promise<void> {
  const q = commandPaletteInput.value.trim();
  const current = ++sequence;
  if (q.length < 2) {
    items = [];
    commandPaletteResults.replaceChildren(emptyState("Type to search everything you can see"));
    return;
  }
  try {
    const found = await fetchCloudJson<FindResponse>(`/api/find?q=${encodeURIComponent(q)}`);
    if (current !== sequence) return;
    items = paletteItems(found);
    selected = 0;
    renderItems();
  } catch (error) {
    commandPaletteResults.replaceChildren(emptyState(errorMessage(error)));
  }
}

function paletteItems(found: FindResponse): PaletteItem[] {
  return [
    ...found.spaces.map((space) => ({ group: "Spaces", title: space.title, detail: space.key ?? "", open: () => loadSite(space.id) })),
    ...found.pages.map((page) => ({
      group: "Pages",
      title: page.title,
      detail: page.excerpt,
      open: () => (page.siteId ? loadSite(page.siteId, page.id) : loadStandaloneDocument(page.id)),
    })),
    ...found.issues.map((issue) => ({
      group: "Issues",
      title: `${issue.key} ${issue.summary}`,
      detail: issue.status.replaceAll("_", " "),
      open: async () => {
        if (state.currentSite?.id !== issue.siteId) await loadSite(issue.siteId);
        workProjectSelect.value = issue.projectId;
        await loadWorkProject(issue.projectId);
        await selectWorkIssue(issue.id);
        workProjectSelect.closest("section")?.scrollIntoView({ block: "start" });
      },
    })),
    ...found.channels.map((channel) => ({
      group: "Channels",
      title: `${channel.visibility === "private" ? "🔒 " : "#"}${channel.name}`,
      detail: channel.topic ?? "",
      open: async () => {
        if (state.currentSite?.id !== channel.siteId) await loadSite(channel.siteId);
        await openChatAt(channel.id);
      },
    })),
    ...found.dms.map((dm) => ({ group: "Direct messages", title: dm.title, detail: "", open: () => openChatAt(dm.id) })),
    ...found.messages.map((message) => ({
      group: "Messages",
      title: message.excerpt,
      detail: `${message.channel} · ${message.author}`,
      open: () => openChatAt(message.channelId, message.threadId),
    })),
  ];
}

function renderItems(): void {
  if (items.length === 0) {
    commandPaletteResults.replaceChildren(emptyState("Nothing matches"));
    return;
  }
  const rows: HTMLElement[] = [];
  let group = "";
  items.forEach((item, index) => {
    if (item.group !== group) {
      group = item.group;
      const heading = document.createElement("div");
      heading.className = "command-palette-group";
      heading.textContent = group;
      rows.push(heading);
    }
    const option = document.createElement("button");
    option.type = "button";
    option.className = "command-palette-option";
    option.setAttribute("role", "option");
    option.setAttribute("aria-selected", String(index === selected));
    const title = document.createElement("strong");
    title.textContent = item.title;
    option.append(title);
    if (item.detail) {
      const detail = document.createElement("span");
      detail.textContent = item.detail;
      option.append(detail);
    }
    option.addEventListener("mouseenter", () => {
      selected = index;
      renderItems();
    });
    option.addEventListener("click", () => void choose(item));
    rows.push(option);
  });
  commandPaletteResults.replaceChildren(...rows);
  commandPaletteResults.querySelector<HTMLElement>('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
}

async function choose(item: PaletteItem): Promise<void> {
  commandPalette.hidden = true;
  try {
    await item.open();
  } catch (error) {
    setCloudStatus(errorMessage(error), "error");
  }
}
