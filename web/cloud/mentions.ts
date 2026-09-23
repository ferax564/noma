/** `@` mention picker for comment and source inputs, plus `@{userId}` → `@Name` display in comments and the preview. */
import { fetchCloudJson } from "./api.js";
import { state } from "./state.js";

interface DirectoryUser {
  id: string;
  name: string;
}

const MENTION_RE = /@\{([A-Za-z0-9_-]{8,80})\}/g;
const MENTION_QUERY_RE = /(^|[^\w@{])@([\p{L}\p{N}_.-]{0,40})$/u;
const nameCache = new Map<string, string>();
const pendingLookups = new Set<string>();
let picker: HTMLElement | undefined;
let activeInput: HTMLTextAreaElement | HTMLInputElement | undefined;
let options: DirectoryUser[] = [];
let selected = 0;
let queryStart = -1;
let searchTimer: number | undefined;
let searchSeq = 0;

/** Wires the picker to a text control. Typing `@` followed by letters searches people who share a space with you. */
export function attachMentionPicker(input: HTMLTextAreaElement | HTMLInputElement): void {
  input.setAttribute("aria-autocomplete", "list");
  input.addEventListener("input", () => updatePickerFor(input));
  input.addEventListener("click", () => updatePickerFor(input));
  input.addEventListener("blur", () =>
    window.setTimeout(() => {
      if (activeInput === input && document.activeElement !== input) closePicker();
    }, 150),
  );
  input.addEventListener(
    "keydown",
    (keyEvent) => {
      const event = keyEvent as KeyboardEvent;
      if (!picker || picker.hidden || activeInput !== input || options.length === 0) return;
      if (event.key === "ArrowDown" || event.key === "ArrowUp") {
        event.preventDefault();
        event.stopImmediatePropagation();
        selected = (selected + (event.key === "ArrowDown" ? 1 : options.length - 1)) % options.length;
        renderPicker();
      } else if (event.key === "Enter" || event.key === "Tab") {
        event.preventDefault();
        event.stopImmediatePropagation();
        const choice = options[selected];
        if (choice) insertMention(input, choice);
      } else if (event.key === "Escape") {
        event.stopImmediatePropagation();
        closePicker();
      }
    },
    true,
  );
}

/** Replaces `@{id}` with `@Name` for display; unknown IDs are looked up in the background. */
export function mentionDisplay(text: string, known: DirectoryUser[] = []): string {
  for (const user of known) nameCache.set(user.id, user.name);
  const missing = [...text.matchAll(MENTION_RE)].map((match) => match[1]!).filter((id) => !nameCache.has(id));
  if (missing.length) void lookupNames(missing);
  return text.replace(MENTION_RE, (whole, id: string) => `@${nameCache.get(id) ?? "unknown user"}`);
}

/** Wraps `@{id}` in the rendered preview so it shows as `@Name` while the source text stays intact for inline edits. */
export function decoratePreviewMentions(previewDoc: Document | null): void {
  if (!previewDoc?.body) return;
  if (!previewDoc.getElementById("noma-mention-style")) {
    const style = previewDoc.createElement("style");
    style.id = "noma-mention-style";
    style.textContent =
      ".noma-mention{font-size:0;white-space:nowrap}.noma-mention::before{content:attr(data-name);font-size:.95rem;font-weight:650;color:#0f666b;background:#e6f0ee;border-radius:4px;padding:0 3px}";
    previewDoc.head.append(style);
  }
  const walker = previewDoc.createTreeWalker(previewDoc.body, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node as Text;
    if (text.data.includes("@{") && !text.parentElement?.closest("code, pre, .noma-mention")) nodes.push(text);
  }
  const missing = new Set<string>();
  for (const node of nodes) {
    const fragment = previewDoc.createDocumentFragment();
    let last = 0;
    for (const match of node.data.matchAll(MENTION_RE)) {
      const id = match[1]!;
      fragment.append(node.data.slice(last, match.index));
      const span = previewDoc.createElement("span");
      span.className = "noma-mention";
      span.dataset.userId = id;
      span.dataset.name = `@${nameCache.get(id) ?? "unknown user"}`;
      span.textContent = match[0];
      fragment.append(span);
      last = (match.index ?? 0) + match[0].length;
      if (!nameCache.has(id)) missing.add(id);
    }
    if (last === 0) continue;
    fragment.append(node.data.slice(last));
    node.replaceWith(fragment);
  }
  if (missing.size) {
    void lookupNames([...missing]).then(() => {
      for (const span of [...previewDoc.querySelectorAll<HTMLElement>(".noma-mention")]) {
        const name = nameCache.get(span.dataset.userId ?? "");
        if (name) span.dataset.name = `@${name}`;
      }
    });
  }
}

/** Cached display name for a user ID, if already known. */
export function knownMentionName(id: string): string | undefined {
  return nameCache.get(id);
}

/** Resolves names for `ids` (people who share a space with you) into the shared cache. */
export async function resolveMentionNames(ids: string[]): Promise<void> {
  await lookupNames(ids.filter((id) => !nameCache.has(id)));
}

async function lookupNames(ids: string[]): Promise<void> {
  const fresh = ids.filter((id) => !pendingLookups.has(id)).slice(0, 100);
  if (fresh.length === 0 || !state.cloudUser) return;
  for (const id of fresh) pendingLookups.add(id);
  try {
    const params = new URLSearchParams({ ids: fresh.join(",") });
    if (state.currentPage) params.set("document", state.currentPage.id);
    const response = await fetchCloudJson<{ users: DirectoryUser[] }>(`/api/users?${params.toString()}`);
    for (const user of response.users) nameCache.set(user.id, user.name);
  } catch {
    return;
  } finally {
    for (const id of fresh) pendingLookups.delete(id);
  }
}

function updatePickerFor(input: HTMLTextAreaElement | HTMLInputElement): void {
  const caret = input.selectionStart ?? input.value.length;
  const before = input.value.slice(0, caret);
  const match = MENTION_QUERY_RE.exec(before);
  if (!match || !state.cloudUser) {
    if (activeInput === input) closePicker();
    return;
  }
  activeInput = input;
  queryStart = caret - match[2]!.length - 1;
  const query = match[2]!;
  window.clearTimeout(searchTimer);
  searchTimer = window.setTimeout(() => void searchUsers(input, query), 120);
}

async function searchUsers(input: HTMLTextAreaElement | HTMLInputElement, query: string): Promise<void> {
  const seq = ++searchSeq;
  try {
    const params = new URLSearchParams({ q: query, limit: "8" });
    if (state.currentPage) params.set("document", state.currentPage.id);
    const response = await fetchCloudJson<{ users: DirectoryUser[] }>(`/api/users?${params.toString()}`);
    if (seq !== searchSeq || activeInput !== input) return;
    options = response.users;
    for (const user of options) nameCache.set(user.id, user.name);
    selected = 0;
    showPicker(input);
  } catch {
    closePicker();
  }
}

function showPicker(input: HTMLTextAreaElement | HTMLInputElement): void {
  if (!picker) {
    picker = document.createElement("div");
    picker.id = "mentionPicker";
    picker.className = "mention-picker";
    picker.setAttribute("role", "listbox");
    picker.setAttribute("aria-label", "Mention someone");
    document.body.append(picker);
  }
  const rect = input.getBoundingClientRect();
  picker.style.left = `${Math.max(8, rect.left)}px`;
  picker.style.top = `${Math.max(8, Math.min(window.innerHeight - 40, caretTop(input, rect)))}px`;
  picker.style.minWidth = `${Math.min(260, rect.width)}px`;
  picker.hidden = false;
  renderPicker();
}

/** Approximate viewport Y just below the caret line, so the picker follows the cursor in tall textareas. */
function caretTop(input: HTMLTextAreaElement | HTMLInputElement, rect: DOMRect): number {
  if (!(input instanceof HTMLTextAreaElement)) return rect.bottom + 4;
  const style = window.getComputedStyle(input);
  const lineHeight = Number.parseFloat(style.lineHeight) || Number.parseFloat(style.fontSize) * 1.4 || 20;
  const line = input.value.slice(0, input.selectionStart ?? 0).split("\n").length;
  const top = rect.top + (Number.parseFloat(style.paddingTop) || 0) + line * lineHeight - input.scrollTop + 4;
  return Math.min(rect.bottom + 4, Math.max(rect.top + lineHeight, top));
}

function renderPicker(): void {
  if (!picker || !activeInput) return;
  picker.textContent = "";
  if (options.length === 0) {
    const empty = document.createElement("div");
    empty.className = "mention-picker-empty";
    empty.textContent = "No people in your spaces match";
    picker.append(empty);
    return;
  }
  options.forEach((user, index) => {
    const option = document.createElement("button");
    option.type = "button";
    option.className = "mention-option";
    option.setAttribute("role", "option");
    option.setAttribute("aria-selected", String(index === selected));
    option.textContent = user.name;
    option.title = `Mention ${user.name}`;
    option.addEventListener("mousedown", (event) => {
      event.preventDefault();
      if (activeInput) insertMention(activeInput, user);
    });
    picker!.append(option);
  });
}

function insertMention(input: HTMLTextAreaElement | HTMLInputElement, user: DirectoryUser): void {
  const caret = input.selectionStart ?? input.value.length;
  const typed = MENTION_QUERY_RE.exec(input.value.slice(0, caret));
  const start = typed ? caret - typed[2]!.length - 1 : queryStart >= 0 ? queryStart : caret;
  const token = `@{${user.id}} `;
  input.value = `${input.value.slice(0, start)}${token}${input.value.slice(caret)}`;
  const next = start + token.length;
  input.setSelectionRange(next, next);
  nameCache.set(user.id, user.name);
  closePicker();
  input.dispatchEvent(new Event("input", { bubbles: true }));
  input.focus();
}

function closePicker(): void {
  if (picker) picker.hidden = true;
  options = [];
  queryStart = -1;
}
