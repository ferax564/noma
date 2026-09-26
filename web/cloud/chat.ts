/** Chat: channels per space (optionally per Work project), threads, reactions, and chat → issue/page hand-offs. */
import { fetchCloudJson } from "./api.js";
import { chatAgentChips, chatChannelMeta, chatChannelSelect, chatCloseThreadButton, chatComposerInput, chatCreateChannelButton, chatJoinButton, chatMessages, chatNewNameInput, chatNewProjectSelect, chatNewTopicInput, chatNewVisibilitySelect, chatSendButton, chatStatus, chatThreadBanner, chatThreadLabel, refreshChatButton } from "./dom.js";
import { attachMentionPicker, mentionDisplay } from "./mentions.js";
import { loadSite } from "./navigation.js";
import { canEditSite } from "./permissions.js";
import { state } from "./state.js";
import type { ChatChannel, ChatChannelDetail, ChatMessage } from "./types.js";
import { actionButton, emptyState, errorMessage, formatDate, setPanelStatus } from "./util.js";

const QUICK_REACTIONS = ["👍", "✅", "👀"];
const POLL_MS = 30_000;

let channels: ChatChannel[] = [];
let detail: ChatChannelDetail | undefined;
let messages: ChatMessage[] = [];
let threadRoot: ChatMessage | undefined;
let stream: EventSource | undefined;
let reloadTimer: number | undefined;

export function installChat(): void {
  attachMentionPicker(chatComposerInput);
  refreshChatButton.addEventListener("click", () => void refreshChat());
  chatChannelSelect.addEventListener("change", () => void openChannel(chatChannelSelect.value));
  chatSendButton.addEventListener("click", () => void sendMessage());
  chatJoinButton.addEventListener("click", () => void joinChannel());
  chatCloseThreadButton.addEventListener("click", () => void openThread(undefined));
  chatCreateChannelButton.addEventListener("click", () => void createChannel());
  chatComposerInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      void sendMessage();
    }
  });
  window.setInterval(() => {
    if (document.visibilityState === "visible" && state.cloudUser && state.currentSite) void refreshChannelList();
  }, POLL_MS);
}

/** Reloads the current space's channels and reopens the selected (or first) one. */
export async function refreshChat(): Promise<void> {
  if (!state.cloudUser || !state.currentSite) {
    channels = [];
    closeChannel();
    renderChat();
    return;
  }
  try {
    await refreshChannelList();
    const selected = channels.find((channel) => channel.id === detail?.id) ?? channels.find((channel) => channel.joined) ?? channels[0];
    if (selected) await openChannel(selected.id);
    else closeChannel();
  } catch (error) {
    setPanelStatus(chatStatus, errorMessage(error), "error");
  } finally {
    renderChat();
  }
}

async function refreshChannelList(): Promise<void> {
  if (!state.currentSite) return;
  const response = await fetchCloudJson<{ channels: ChatChannel[] }>(`/api/channels?siteId=${encodeURIComponent(state.currentSite.id)}`);
  channels = response.channels;
  renderChannelSelect();
}

async function openChannel(channelId: string): Promise<void> {
  if (!channelId) return;
  if (detail?.id !== channelId) threadRoot = undefined;
  detail = await fetchCloudJson<ChatChannelDetail>(`/api/channels/${encodeURIComponent(channelId)}`);
  await loadMessages();
  connectStream(channelId);
  if (detail.joined) await markRead();
  renderChat();
}

function closeChannel(): void {
  detail = undefined;
  messages = [];
  threadRoot = undefined;
  stream?.close();
  stream = undefined;
}

async function loadMessages(): Promise<void> {
  if (!detail) return;
  const base = `/api/channels/${encodeURIComponent(detail.id)}/messages`;
  if (threadRoot) {
    const thread = await fetchCloudJson<{ root?: ChatMessage; replies: ChatMessage[] }>(`${base}/${encodeURIComponent(threadRoot.id)}`);
    if (thread.root) threadRoot = thread.root;
    messages = thread.replies;
  } else {
    messages = (await fetchCloudJson<{ messages: ChatMessage[] }>(`${base}?limit=100`)).messages;
  }
}

async function openThread(root: ChatMessage | undefined): Promise<void> {
  threadRoot = root;
  try {
    await loadMessages();
  } catch (error) {
    setPanelStatus(chatStatus, errorMessage(error), "error");
  }
  renderChat();
  if (root) chatComposerInput.focus();
}

function connectStream(channelId: string): void {
  stream?.close();
  if (typeof EventSource === "undefined") return;
  stream = new EventSource(`/api/channels/${encodeURIComponent(channelId)}/stream`, { withCredentials: true });
  stream.addEventListener("chat", () => scheduleReload());
}

function scheduleReload(): void {
  window.clearTimeout(reloadTimer);
  reloadTimer = window.setTimeout(() => {
    void (async () => {
      try {
        await loadMessages();
        if (detail?.joined) await markRead();
        renderMessages();
      } catch (error) {
        setPanelStatus(chatStatus, errorMessage(error), "error");
      }
    })();
  }, 150);
}

async function markRead(): Promise<void> {
  if (!detail) return;
  const { lastReadSeq } = await fetchCloudJson<{ lastReadSeq: number }>(`/api/channels/${encodeURIComponent(detail.id)}/read`, jsonInit("POST", {}));
  const channel = channels.find((item) => item.id === detail?.id);
  if (channel) Object.assign(channel, { lastReadSeq, unread: 0, mentions: 0 });
  renderChannelSelect();
}

async function sendMessage(): Promise<void> {
  const body = chatComposerInput.value.trim();
  if (!detail || !body) return;
  chatSendButton.disabled = true;
  try {
    await fetchCloudJson(`/api/channels/${encodeURIComponent(detail.id)}/messages`, jsonInit("POST", { body, ...(threadRoot ? { threadId: threadRoot.id } : {}) }));
    chatComposerInput.value = "";
    if (!detail.joined) detail = await fetchCloudJson<ChatChannelDetail>(`/api/channels/${encodeURIComponent(detail.id)}`);
    await loadMessages();
    setPanelStatus(chatStatus, "", "ok");
  } catch (error) {
    setPanelStatus(chatStatus, errorMessage(error), "error");
  } finally {
    chatSendButton.disabled = false;
    renderChat();
  }
}

async function joinChannel(): Promise<void> {
  if (!detail) return;
  try {
    detail = await fetchCloudJson<ChatChannelDetail>(`/api/channels/${encodeURIComponent(detail.id)}/join`, jsonInit("POST", {}));
    await refreshChannelList();
  } catch (error) {
    setPanelStatus(chatStatus, errorMessage(error), "error");
  }
  renderChat();
}

async function createChannel(): Promise<void> {
  if (!state.currentSite || !canEditSite()) {
    setPanelStatus(chatStatus, "Open an editable space before creating a channel", "error");
    return;
  }
  const name = chatNewNameInput.value.trim();
  if (!name) {
    setPanelStatus(chatStatus, "Enter a channel name", "error");
    return;
  }
  try {
    const channel = await fetchCloudJson<ChatChannelDetail>(
      "/api/channels",
      jsonInit("POST", {
        siteId: state.currentSite.id,
        name,
        topic: chatNewTopicInput.value.trim() || undefined,
        visibility: chatNewVisibilitySelect.value,
        projectId: chatNewProjectSelect.value || undefined,
      }),
    );
    chatNewNameInput.value = "";
    chatNewTopicInput.value = "";
    await refreshChannelList();
    await openChannel(channel.id);
    setPanelStatus(chatStatus, `Created #${channel.name}`, "ok");
  } catch (error) {
    setPanelStatus(chatStatus, errorMessage(error), "error");
  }
}

async function messageAction(message: ChatMessage, action: "issue" | "page" | "delete" | { react: string; remove: boolean }): Promise<void> {
  if (!detail) return;
  const base = `/api/channels/${encodeURIComponent(detail.id)}/messages/${encodeURIComponent(message.id)}`;
  try {
    if (action === "issue") {
      const created = await fetchCloudJson<{ issue: { key: string } }>(`${base}/issue`, jsonInit("POST", {}));
      setPanelStatus(chatStatus, `Created ${created.issue.key}`, "ok");
    } else if (action === "page") {
      const created = await fetchCloudJson<{ document: { title: string } }>(`${base}/page`, jsonInit("POST", {}));
      setPanelStatus(chatStatus, `Saved thread as “${created.document.title}”`, "ok");
    } else if (action === "delete") {
      if (!window.confirm("Delete this message?")) return;
      await fetchCloudJson(base, { method: "DELETE" });
    } else if (action.remove) {
      await fetchCloudJson(`${base}/reactions/${encodeURIComponent(action.react)}`, { method: "DELETE" });
    } else {
      await fetchCloudJson(`${base}/reactions`, jsonInit("POST", { emoji: action.react }));
    }
    await loadMessages();
  } catch (error) {
    setPanelStatus(chatStatus, errorMessage(error), "error");
  }
  renderMessages();
}

// rendering

export function renderChat(): void {
  const signedIn = Boolean(state.cloudUser && state.currentSite);
  renderChannelSelect();
  renderProjectOptions();
  chatCreateChannelButton.disabled = !signedIn || !canEditSite();
  chatComposerInput.disabled = !detail?.access.canPost;
  chatSendButton.disabled = !detail?.access.canPost;
  chatJoinButton.hidden = !detail || detail.joined || detail.visibility === "private";
  chatThreadBanner.hidden = !threadRoot;
  chatThreadLabel.textContent = threadRoot ? `Thread · ${mentionDisplay(threadRoot.body).slice(0, 60)}` : "";
  chatComposerInput.placeholder = threadRoot ? "Reply in thread" : detail ? `Message #${detail.name}` : "Choose or create a channel";
  if (!detail) {
    chatChannelMeta.textContent = signedIn ? "No channel selected" : "Open a space to chat";
    chatAgentChips.replaceChildren();
  } else {
    const parts = [detail.visibility === "private" ? "🔒 private" : "public", detail.project ? `project ${detail.project.key}` : "", detail.topic ?? "", `${detail.members.length} member${detail.members.length === 1 ? "" : "s"}`];
    chatChannelMeta.textContent = parts.filter(Boolean).join(" · ");
    chatAgentChips.replaceChildren(
      ...detail.agents.map((agent) =>
        actionButton(`@${agent.name}`, () => insertMention(agent.id), !detail?.access.canPost, `Mention ${agent.name} (agent)`),
      ),
    );
  }
  renderMessages();
}

function renderChannelSelect(): void {
  const selected = detail?.id ?? chatChannelSelect.value;
  chatChannelSelect.replaceChildren(
    ...(channels.length === 0 ? [new Option("No channels yet", "")] : []),
    ...channels.map((channel) => {
      const badge = channel.mentions ? ` · @${channel.mentions}` : channel.unread ? ` · ${channel.unread} new` : "";
      return new Option(`${channel.visibility === "private" ? "🔒" : "#"}${channel.name}${badge}`, channel.id);
    }),
  );
  if (channels.some((channel) => channel.id === selected)) chatChannelSelect.value = selected;
}

function renderProjectOptions(): void {
  const current = chatNewProjectSelect.value;
  const projects = state.workProjects.filter((project) => project.siteId === state.currentSite?.id);
  chatNewProjectSelect.replaceChildren(new Option("None — topic channel", ""), ...projects.map((project) => new Option(`${project.key} · ${project.name}`, project.id)));
  if (projects.some((project) => project.id === current)) chatNewProjectSelect.value = current;
}

function renderMessages(): void {
  if (!detail) {
    chatMessages.replaceChildren(emptyState(state.currentSite ? "Create a channel to start a conversation" : "Open a space to chat"));
    return;
  }
  const rows = [...(threadRoot ? [threadRoot] : []), ...messages].map((message) => messageRow(message, message === threadRoot));
  chatMessages.replaceChildren(...(rows.length ? rows : [emptyState(threadRoot ? "No replies yet" : "No messages yet — say hello")]));
  chatMessages.scrollTop = chatMessages.scrollHeight;
}

function messageRow(message: ChatMessage, isRoot: boolean): HTMLElement {
  const row = document.createElement("article");
  row.className = "chat-message";
  row.dataset.kind = message.kind;
  if (isRoot) row.dataset.root = "true";
  const header = document.createElement("div");
  header.className = "chat-message-header";
  const author = document.createElement("strong");
  author.textContent = message.kind === "system" ? `${message.authorName} ${mentionDisplay(message.body, message.mentions)}` : message.agent ? message.agent.name : message.authorName;
  header.append(author);
  if (message.agent) {
    const badge = document.createElement("span");
    badge.className = "meta-badge";
    badge.textContent = "agent";
    badge.title = `Posted by ${message.authorName}'s agent`;
    header.append(badge);
  }
  const time = document.createElement("span");
  time.className = "history-meta";
  time.textContent = `${formatDate(message.createdAt)}${message.editedAt ? " · edited" : ""}`;
  header.append(time);
  row.append(header);
  if (message.kind === "message") {
    const body = document.createElement("div");
    body.className = "chat-message-body";
    body.textContent = message.deletedAt ? "Message deleted" : mentionDisplay(message.body, message.mentions);
    if (message.deletedAt) body.dataset.deleted = "true";
    row.append(body);
  }
  const chips = [
    ...message.refs.map((ref) => chip(`${ref.key} · ${ref.status.replaceAll("_", " ")}`, ref.summary)),
    ...message.links.issues.map((issue) => chip(`→ ${issue.key}`, issue.summary)),
    ...message.links.documents.map((document) => {
      const link = chip(`→ ${document.title}`, "Open page");
      link.addEventListener("click", () => {
        if (state.currentSite) void loadSite(state.currentSite.id, document.id);
      });
      return link;
    }),
  ];
  if (chips.length) {
    const refs = document.createElement("div");
    refs.className = "chat-message-refs";
    refs.append(...chips);
    row.append(refs);
  }
  if (message.kind === "message" && !message.deletedAt) row.append(messageActions(message, isRoot));
  return row;
}

function messageActions(message: ChatMessage, isRoot: boolean): HTMLElement {
  const actions = document.createElement("div");
  actions.className = "collaboration-actions";
  const me = state.cloudUser?.id ?? "";
  const canPost = Boolean(detail?.access.canPost);
  for (const reaction of message.reactions) {
    const mine = reaction.memberIds.includes(me);
    const button = actionButton(`${reaction.emoji} ${reaction.memberIds.length}`, () => void messageAction(message, { react: reaction.emoji, remove: mine }), !canPost, mine ? `Remove ${reaction.emoji}` : `React ${reaction.emoji}`);
    button.dataset.active = String(mine);
    actions.append(button);
  }
  for (const emoji of QUICK_REACTIONS.filter((item) => !message.reactions.some((reaction) => reaction.emoji === item))) {
    actions.append(actionButton(emoji, () => void messageAction(message, { react: emoji, remove: false }), !canPost, `React ${emoji}`));
  }
  if (!message.threadId && !isRoot) actions.append(actionButton(message.replyCount ? `${message.replyCount} ${message.replyCount === 1 ? "reply" : "replies"}` : "Reply", () => void openThread(message)));
  const projectReady = Boolean(detail?.projectId) && canEditSite();
  if (projectReady) actions.append(actionButton("→ Issue", () => void messageAction(message, "issue"), !canPost, "Create a Work issue from this message"));
  if (canEditSite()) actions.append(actionButton("→ Page", () => void messageAction(message, "page"), !canPost, "Save this thread as a .noma page"));
  if (message.authorId === me || detail?.access.canManage) actions.append(actionButton("Delete", () => void messageAction(message, "delete"), !canPost));
  return actions;
}

function chip(text: string, title: string): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "chat-ref";
  button.textContent = text;
  button.title = title;
  return button;
}

function insertMention(id: string): void {
  const token = `@{${id}} `;
  const start = chatComposerInput.selectionStart ?? chatComposerInput.value.length;
  chatComposerInput.value = `${chatComposerInput.value.slice(0, start)}${token}${chatComposerInput.value.slice(chatComposerInput.selectionEnd ?? start)}`;
  chatComposerInput.focus();
  chatComposerInput.selectionStart = chatComposerInput.selectionEnd = start + token.length;
}

function jsonInit(method: string, body: Record<string, unknown>): RequestInit {
  return { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
}
