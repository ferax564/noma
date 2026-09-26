/**
 * Chat: a Slack-style drawer with channels per space (by Work project or by topic), a timeline,
 * a thread pane, reactions, search, and chat → issue/page hand-offs. The inspector keeps a compact
 * launcher listing the space's channels with unread badges.
 */
import { fetchCloudJson } from "./api.js";
import {
  chatAgentChips,
  chatCancelChannelButton,
  chatChannelList,
  chatChannelMeta,
  chatChannelTitle,
  chatCloseButton,
  chatCloseThreadButton,
  chatComposerInput,
  chatCreateChannelButton,
  chatDrawer,
  chatJoinButton,
  chatLauncherList,
  chatMessages,
  chatNewChannelForm,
  chatNewChannelToggle,
  chatNewNameInput,
  chatNewProjectSelect,
  chatNewTopicInput,
  chatNewVisibilitySelect,
  chatSearchInput,
  chatSendButton,
  chatSpaceTitle,
  chatStatus,
  chatThreadInput,
  chatThreadLabel,
  chatThreadMessages,
  chatThreadPane,
  chatThreadSendButton,
  openChatButton,
} from "./dom.js";
import { attachMentionPicker, mentionDisplay } from "./mentions.js";
import { loadSite } from "./navigation.js";
import { canEditSite } from "./permissions.js";
import { state } from "./state.js";
import type { ChatChannel, ChatChannelDetail, ChatMessage } from "./types.js";
import { emptyState, errorMessage, setPanelStatus } from "./util.js";

const QUICK_REACTIONS = ["👍", "✅", "👀", "🎉"];
const POLL_MS = 30_000;
const GROUP_WINDOW_MS = 5 * 60_000;

interface SearchResult {
  channel: { id: string; name?: string };
  message: ChatMessage;
}

let channels: ChatChannel[] = [];
let detail: ChatChannelDetail | undefined;
let messages: ChatMessage[] = [];
let threadRoot: ChatMessage | undefined;
let threadReplies: ChatMessage[] = [];
let searchResults: SearchResult[] | undefined;
let stream: EventSource | undefined;
let reloadTimer: number | undefined;
let searchTimer: number | undefined;

export function installChat(): void {
  attachMentionPicker(chatComposerInput);
  attachMentionPicker(chatThreadInput);
  openChatButton.addEventListener("click", () => void openDrawer());
  chatCloseButton.addEventListener("click", () => closeDrawer());
  chatCloseThreadButton.addEventListener("click", () => void openThread(undefined));
  chatJoinButton.addEventListener("click", () => void joinChannel());
  chatSendButton.addEventListener("click", () => void sendMessage(chatComposerInput, undefined));
  chatThreadSendButton.addEventListener("click", () => void sendMessage(chatThreadInput, threadRoot));
  bindComposer(chatComposerInput, () => void sendMessage(chatComposerInput, undefined));
  bindComposer(chatThreadInput, () => void sendMessage(chatThreadInput, threadRoot));
  chatNewChannelToggle.addEventListener("click", () => toggleNewChannel(chatNewChannelForm.hidden));
  chatCancelChannelButton.addEventListener("click", () => toggleNewChannel(false));
  chatNewChannelForm.addEventListener("submit", (event) => {
    event.preventDefault();
    void createChannel();
  });
  chatSearchInput.addEventListener("input", () => {
    window.clearTimeout(searchTimer);
    searchTimer = window.setTimeout(() => void runSearch(), 250);
  });
  chatDrawer.addEventListener("keydown", (event) => {
    if (event.key !== "Escape" || event.defaultPrevented) return;
    if (!chatThreadPane.hidden) void openThread(undefined);
    else closeDrawer();
  });
  window.setInterval(() => {
    if (document.visibilityState === "visible" && state.cloudUser && state.currentSite) void refreshChannelList().catch(() => undefined);
  }, POLL_MS);
}

/** Reloads the current space's channels and reopens the selected (or first joined) one. */
export async function refreshChat(): Promise<void> {
  if (!state.cloudUser || !state.currentSite) {
    channels = [];
    closeChannel();
    closeDrawer();
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

async function openDrawer(channelId?: string): Promise<void> {
  chatDrawer.hidden = false;
  document.body.dataset.chatOpen = "true";
  if (channelId && channelId !== detail?.id) await selectChannel(channelId);
  else {
    if (detail?.joined) await markRead().catch((error: unknown) => setPanelStatus(chatStatus, errorMessage(error), "error"));
    renderChat();
  }
  (detail?.access.canPost ? chatComposerInput : chatCloseButton).focus();
}

function closeDrawer(): void {
  chatDrawer.hidden = true;
  delete document.body.dataset.chatOpen;
}

async function refreshChannelList(): Promise<void> {
  if (!state.currentSite) return;
  const response = await fetchCloudJson<{ channels: ChatChannel[] }>(`/api/channels?siteId=${encodeURIComponent(state.currentSite.id)}`);
  channels = response.channels;
  renderChannelLists();
}

async function selectChannel(channelId: string): Promise<void> {
  try {
    searchResults = undefined;
    chatSearchInput.value = "";
    await openChannel(channelId);
  } catch (error) {
    setPanelStatus(chatStatus, errorMessage(error), "error");
    renderChat();
  }
}

async function openChannel(channelId: string): Promise<void> {
  if (!channelId) return;
  if (detail?.id !== channelId) {
    threadRoot = undefined;
    threadReplies = [];
  }
  detail = await fetchCloudJson<ChatChannelDetail>(`/api/channels/${encodeURIComponent(channelId)}`);
  await Promise.all([loadTimeline(), loadThread()]);
  connectStream(channelId);
  if (detail.joined && !chatDrawer.hidden) await markRead();
  renderChat();
}

function closeChannel(): void {
  detail = undefined;
  messages = [];
  threadRoot = undefined;
  threadReplies = [];
  stream?.close();
  stream = undefined;
}

async function loadTimeline(): Promise<void> {
  if (!detail) return;
  messages = (await fetchCloudJson<{ messages: ChatMessage[] }>(`/api/channels/${encodeURIComponent(detail.id)}/messages?limit=100`)).messages;
}

async function loadThread(): Promise<void> {
  if (!detail || !threadRoot) return;
  const thread = await fetchCloudJson<{ root?: ChatMessage; replies: ChatMessage[] }>(`/api/channels/${encodeURIComponent(detail.id)}/messages/${encodeURIComponent(threadRoot.id)}`);
  if (thread.root) threadRoot = thread.root;
  threadReplies = thread.replies;
}

async function openThread(root: ChatMessage | undefined): Promise<void> {
  threadRoot = root;
  threadReplies = [];
  try {
    await loadThread();
  } catch (error) {
    setPanelStatus(chatStatus, errorMessage(error), "error");
  }
  renderChat();
  if (root) chatThreadInput.focus();
  else chatComposerInput.focus();
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
        await Promise.all([loadTimeline(), loadThread()]);
        if (detail?.joined && !chatDrawer.hidden) await markRead();
        else await refreshChannelList();
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
  renderChannelLists();
}

async function sendMessage(input: HTMLTextAreaElement, root: ChatMessage | undefined): Promise<void> {
  const body = input.value.trim();
  if (!detail || !body) return;
  input.disabled = true;
  try {
    await fetchCloudJson(`/api/channels/${encodeURIComponent(detail.id)}/messages`, jsonInit("POST", { body, ...(root ? { threadId: root.id } : {}) }));
    input.value = "";
    autoGrow(input);
    if (!detail.joined) detail = await fetchCloudJson<ChatChannelDetail>(`/api/channels/${encodeURIComponent(detail.id)}`);
    await Promise.all([loadTimeline(), loadThread()]);
    setPanelStatus(chatStatus, "", "ok");
  } catch (error) {
    setPanelStatus(chatStatus, errorMessage(error), "error");
  } finally {
    input.disabled = false;
    renderChat();
    input.focus();
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

function toggleNewChannel(open: boolean): void {
  chatNewChannelForm.hidden = !open;
  chatNewChannelToggle.setAttribute("aria-expanded", String(open));
  if (open) chatNewNameInput.focus();
}

async function createChannel(): Promise<void> {
  if (!state.currentSite || !canEditSite()) {
    setPanelStatus(chatStatus, "Open an editable space before creating a channel", "error");
    return;
  }
  const name = chatNewNameInput.value.trim();
  if (!name) {
    setPanelStatus(chatStatus, "Enter a channel name", "error");
    chatNewNameInput.focus();
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
    toggleNewChannel(false);
    await refreshChannelList();
    await selectChannel(channel.id);
    setPanelStatus(chatStatus, `Created #${channel.name}`, "ok");
  } catch (error) {
    setPanelStatus(chatStatus, errorMessage(error), "error");
  }
}

async function runSearch(): Promise<void> {
  const q = chatSearchInput.value.trim();
  if (q.length < 2 || !state.currentSite) {
    searchResults = undefined;
    renderMessages();
    return;
  }
  try {
    const response = await fetchCloudJson<{ results: SearchResult[] }>(`/api/chat/search?q=${encodeURIComponent(q)}&siteId=${encodeURIComponent(state.currentSite.id)}`);
    searchResults = response.results;
  } catch (error) {
    setPanelStatus(chatStatus, errorMessage(error), "error");
  }
  renderMessages();
}

type MessageAction = "issue" | "page" | "delete" | { react: string; remove: boolean };

async function messageAction(message: ChatMessage, action: MessageAction): Promise<void> {
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
    await Promise.all([loadTimeline(), loadThread()]);
  } catch (error) {
    setPanelStatus(chatStatus, errorMessage(error), "error");
  }
  renderMessages();
}

// rendering

export function renderChat(): void {
  const signedIn = Boolean(state.cloudUser && state.currentSite);
  openChatButton.disabled = !signedIn;
  chatSpaceTitle.textContent = state.currentSite?.title ?? "No space";
  chatNewChannelToggle.disabled = !signedIn || !canEditSite();
  chatCreateChannelButton.disabled = !signedIn || !canEditSite();
  renderChannelLists();
  renderProjectOptions();
  const canPost = Boolean(detail?.access.canPost);
  chatComposerInput.disabled = !canPost;
  chatSendButton.disabled = !canPost;
  chatThreadInput.disabled = !canPost;
  chatThreadSendButton.disabled = !canPost;
  chatJoinButton.hidden = !detail || detail.joined || detail.visibility === "private";
  chatComposerInput.placeholder = !detail ? "Choose or create a channel" : canPost ? `Message ${channelLabel(detail)}` : "This channel is read-only";
  chatThreadPane.hidden = !threadRoot;
  chatDrawer.dataset.thread = String(Boolean(threadRoot));
  if (!detail) {
    chatChannelTitle.textContent = signedIn ? "No channel yet" : "Chat";
    chatChannelMeta.textContent = signedIn ? "Create a channel for a project or a topic." : "Open a space to chat.";
    chatAgentChips.replaceChildren();
  } else {
    chatChannelTitle.textContent = channelLabel(detail);
    const parts = [detail.topic ?? "", detail.project ? `Project ${detail.project.key}` : "", `${detail.members.length} member${detail.members.length === 1 ? "" : "s"}`, detail.archivedAt ? "Archived" : ""];
    chatChannelMeta.textContent = parts.filter(Boolean).join(" · ");
    chatAgentChips.replaceChildren(...detail.agents.map((agent) => agentChip(agent)));
  }
  renderMessages();
}

function renderChannelLists(): void {
  const projects = channels.filter((channel) => channel.projectId);
  const topics = channels.filter((channel) => !channel.projectId);
  chatChannelList.replaceChildren(
    ...(channels.length === 0 ? [emptyState(state.currentSite ? "No channels yet" : "Open a space")] : []),
    ...channelGroup("Projects", projects),
    ...channelGroup("Topics", topics),
  );
  chatLauncherList.replaceChildren(
    ...(channels.length === 0 ? [emptyState(state.currentSite ? "No channels yet — open chat to create one" : "Open a space to chat")] : []),
    ...channels.slice(0, 8).map((channel) => channelButton(channel, "chat-launcher-row")),
  );
}

function channelGroup(label: string, items: ChatChannel[]): HTMLElement[] {
  if (items.length === 0) return [];
  const heading = document.createElement("div");
  heading.className = "chat-channel-group";
  heading.textContent = label;
  return [heading, ...items.map((channel) => channelButton(channel, "chat-channel-row"))];
}

function channelButton(channel: ChatChannel, className: string): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = className;
  button.dataset.active = String(channel.id === detail?.id);
  button.dataset.unread = String(Boolean(channel.unread));
  if (channel.id === detail?.id) button.setAttribute("aria-current", "true");
  const name = document.createElement("span");
  name.className = "chat-channel-name";
  name.textContent = channelLabel(channel);
  button.append(name);
  const count = channel.mentions || channel.unread;
  if (count) {
    const badge = document.createElement("span");
    badge.className = "chat-count";
    badge.dataset.mention = String(Boolean(channel.mentions));
    badge.textContent = channel.mentions ? `@${channel.mentions}` : String(channel.unread);
    button.append(badge);
  }
  button.setAttribute("aria-label", `${channelLabel(channel)}${channel.unread ? `, ${channel.unread} unread` : ""}${channel.mentions ? `, ${channel.mentions} mentions` : ""}`);
  button.addEventListener("click", () => void openDrawer(channel.id));
  return button;
}

function channelLabel(channel: Pick<ChatChannel, "name" | "visibility">): string {
  return `${channel.visibility === "private" ? "🔒 " : "#"}${channel.name}`;
}

function renderProjectOptions(): void {
  const current = chatNewProjectSelect.value;
  const projects = state.workProjects.filter((project) => project.siteId === state.currentSite?.id);
  chatNewProjectSelect.replaceChildren(new Option("None — a topic channel", ""), ...projects.map((project) => new Option(`${project.key} · ${project.name}`, project.id)));
  if (projects.some((project) => project.id === current)) chatNewProjectSelect.value = current;
}

function renderMessages(): void {
  if (searchResults) {
    chatMessages.replaceChildren(searchHeader(), ...(searchResults.length ? searchResults.map((result) => searchRow(result)) : [emptyState("No messages match")]));
  } else if (!detail) {
    chatMessages.replaceChildren(welcome(state.currentSite ? "Start the first conversation" : "Open a space to chat", state.currentSite ? "Channels live in this space. Tie one to a Work project, or give it a topic." : ""));
  } else {
    const rows = timelineRows(messages, false);
    chatMessages.replaceChildren(...(rows.length ? rows : [welcome(`Welcome to ${channelLabel(detail)}`, detail.topic ?? "This is the very beginning of the channel.")]));
  }
  scrollToEnd(chatMessages);
  if (threadRoot) {
    const replyCount = threadReplies.filter((reply) => reply.kind === "message").length;
    const replies = `${replyCount} ${replyCount === 1 ? "reply" : "replies"}`;
    chatThreadLabel.textContent = detail ? `${channelLabel(detail)} · ${replies}` : replies;
    chatThreadMessages.replaceChildren(messageRow(threadRoot, { grouped: false, inThread: true, root: true }), divider(replies), ...timelineRows(threadReplies, true));
    scrollToEnd(chatThreadMessages);
  }
}

function timelineRows(items: ChatMessage[], inThread: boolean): HTMLElement[] {
  const rows: HTMLElement[] = [];
  let previous: ChatMessage | undefined;
  for (const message of items) {
    const day = dayLabel(message.createdAt);
    if (!inThread && (!previous || dayLabel(previous.createdAt) !== day)) rows.push(divider(day));
    const grouped = Boolean(
      previous &&
        previous.kind === "message" &&
        message.kind === "message" &&
        previous.authorId === message.authorId &&
        previous.agent?.id === message.agent?.id &&
        !previous.deletedAt &&
        Date.parse(message.createdAt) - Date.parse(previous.createdAt) < GROUP_WINDOW_MS &&
        dayLabel(previous.createdAt) === day,
    );
    rows.push(messageRow(message, { grouped, inThread, root: false }));
    previous = message;
  }
  return rows;
}

function messageRow(message: ChatMessage, options: { grouped: boolean; inThread: boolean; root: boolean }): HTMLElement {
  const row = document.createElement("article");
  row.className = "chat-message";
  row.dataset.kind = message.kind;
  row.dataset.grouped = String(options.grouped);
  if (options.root) row.dataset.root = "true";
  if (message.kind === "system") {
    const note = document.createElement("div");
    note.className = "chat-system";
    note.textContent = `${message.authorName} ${mentionDisplay(message.body, message.mentions)} · ${timeLabel(message.createdAt)}`;
    row.append(note);
    const chips = linkChips(message);
    if (chips) row.append(chips);
    return row;
  }
  const displayName = message.agent?.name ?? message.authorName;
  row.append(options.grouped ? gutterTime(message.createdAt) : avatar(message.agent?.id ?? message.authorId, displayName, Boolean(message.agent)));
  const content = document.createElement("div");
  content.className = "chat-message-content";
  if (!options.grouped) {
    const header = document.createElement("div");
    header.className = "chat-message-header";
    const author = document.createElement("strong");
    author.textContent = displayName;
    header.append(author);
    if (message.agent) {
      const badge = document.createElement("span");
      badge.className = "chat-agent-badge";
      badge.textContent = "Agent";
      badge.title = `Posted by ${message.authorName}'s agent`;
      header.append(badge);
    }
    const time = document.createElement("time");
    time.dateTime = message.createdAt;
    time.textContent = timeLabel(message.createdAt);
    time.title = new Date(message.createdAt).toLocaleString();
    header.append(time);
    content.append(header);
  }
  const body = document.createElement("div");
  body.className = "chat-message-body";
  if (message.deletedAt) {
    body.dataset.deleted = "true";
    body.textContent = "This message was deleted.";
  } else {
    body.append(...formatBody(mentionDisplay(message.body, message.mentions), message.mentions.map((mention) => mention.name)));
    if (message.editedAt) {
      const edited = document.createElement("span");
      edited.className = "chat-edited";
      edited.textContent = " (edited)";
      body.append(edited);
    }
  }
  content.append(body);
  const chips = linkChips(message);
  if (chips) content.append(chips);
  if (message.reactions.length) content.append(reactionBar(message));
  if (!options.inThread && message.replyCount > 0) {
    const replies = document.createElement("button");
    replies.type = "button";
    replies.className = "chat-replies";
    replies.textContent = `${message.replyCount} ${message.replyCount === 1 ? "reply" : "replies"}`;
    if (message.lastReplyAt) replies.title = `Last reply ${new Date(message.lastReplyAt).toLocaleString()}`;
    replies.addEventListener("click", () => void openThread(message));
    content.append(replies);
  }
  row.append(content);
  if (!message.deletedAt) row.append(hoverActions(message, options));
  return row;
}

function hoverActions(message: ChatMessage, options: { inThread: boolean; root: boolean }): HTMLElement {
  const bar = document.createElement("div");
  bar.className = "chat-actions";
  bar.setAttribute("role", "toolbar");
  bar.setAttribute("aria-label", "Message actions");
  const canPost = Boolean(detail?.access.canPost);
  const me = state.cloudUser?.id ?? "";
  for (const emoji of QUICK_REACTIONS) {
    const mine = message.reactions.some((reaction) => reaction.emoji === emoji && reaction.memberIds.includes(me));
    bar.append(toolButton(emoji, mine ? `Remove ${emoji}` : `React ${emoji}`, () => void messageAction(message, { react: emoji, remove: mine }), !canPost));
  }
  if (!options.inThread && !message.threadId) bar.append(toolButton("Reply", "Reply in thread", () => void openThread(message)));
  if (detail?.projectId && canEditSite()) bar.append(toolButton("Issue", "Create a Work issue from this message", () => void messageAction(message, "issue"), !canPost));
  if (canEditSite()) bar.append(toolButton("Page", "Save this thread as a .noma page", () => void messageAction(message, "page"), !canPost));
  if (message.authorId === me || detail?.access.canManage) bar.append(toolButton("Delete", "Delete message", () => void messageAction(message, "delete"), !canPost, true));
  return bar;
}

function toolButton(text: string, label: string, action: () => void, disabled = false, danger = false): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = danger ? "chat-tool chat-tool-danger" : "chat-tool";
  button.textContent = text;
  button.title = label;
  button.setAttribute("aria-label", label);
  button.disabled = disabled;
  button.addEventListener("click", action);
  return button;
}

function reactionBar(message: ChatMessage): HTMLElement {
  const bar = document.createElement("div");
  bar.className = "chat-reactions";
  const me = state.cloudUser?.id ?? "";
  const canPost = Boolean(detail?.access.canPost);
  for (const reaction of message.reactions) {
    const mine = reaction.memberIds.includes(me);
    const pill = document.createElement("button");
    pill.type = "button";
    pill.className = "chat-reaction";
    pill.dataset.active = String(mine);
    pill.disabled = !canPost;
    pill.textContent = `${reaction.emoji} ${reaction.memberIds.length}`;
    pill.setAttribute("aria-label", `${mine ? "Remove" : "Add"} ${reaction.emoji} (${reaction.memberIds.length})`);
    pill.setAttribute("aria-pressed", String(mine));
    pill.addEventListener("click", () => void messageAction(message, { react: reaction.emoji, remove: mine }));
    bar.append(pill);
  }
  return bar;
}

function linkChips(message: ChatMessage): HTMLElement | undefined {
  const chips = [
    ...message.refs.filter((ref) => !message.links.issues.some((issue) => issue.id === ref.id)).map((ref) => chip(ref.key, ref.summary, ref.status.replaceAll("_", " "))),
    ...message.links.issues.map((issue) => chip(issue.key, issue.summary, "issue created")),
    ...message.links.documents.map((document) => {
      const link = chip("Page", document.title, "open");
      link.addEventListener("click", () => {
        if (state.currentSite) {
          closeDrawer();
          void loadSite(state.currentSite.id, document.id);
        }
      });
      return link;
    }),
  ];
  if (!chips.length) return undefined;
  const refs = document.createElement("div");
  refs.className = "chat-message-refs";
  refs.append(...chips);
  return refs;
}

function chip(kind: string, title: string, meta: string): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "chat-ref";
  const label = document.createElement("strong");
  label.textContent = kind;
  const text = document.createElement("span");
  text.textContent = title;
  const status = document.createElement("em");
  status.textContent = meta;
  button.append(label, text, status);
  button.title = `${kind}: ${title}`;
  return button;
}

function agentChip(agent: { id: string; name: string }): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "chat-agent-chip";
  button.append(avatar(agent.id, agent.name, true), document.createTextNode(agent.name));
  button.title = `Mention ${agent.name} (agent)`;
  button.setAttribute("aria-label", `Mention ${agent.name} (agent)`);
  button.disabled = !detail?.access.canPost;
  button.addEventListener("click", () => insertMention(threadRoot ? chatThreadInput : chatComposerInput, agent.id));
  return button;
}

function avatar(id: string, name: string, agent: boolean): HTMLElement {
  const element = document.createElement("span");
  element.className = "chat-avatar";
  element.dataset.agent = String(agent);
  element.setAttribute("aria-hidden", "true");
  element.textContent = agent ? "✦" : initials(name);
  element.style.setProperty("--avatar-hue", String(hue(id)));
  return element;
}

function gutterTime(value: string): HTMLElement {
  const time = document.createElement("time");
  time.className = "chat-gutter-time";
  time.dateTime = value;
  time.textContent = timeLabel(value);
  return time;
}

function divider(text: string): HTMLElement {
  const element = document.createElement("div");
  element.className = "chat-divider";
  element.setAttribute("role", "separator");
  const label = document.createElement("span");
  label.textContent = text;
  element.append(label);
  return element;
}

function welcome(title: string, text: string): HTMLElement {
  const element = document.createElement("div");
  element.className = "chat-welcome";
  const heading = document.createElement("strong");
  heading.textContent = title;
  const copy = document.createElement("span");
  copy.textContent = text;
  element.append(heading, copy);
  return element;
}

function searchHeader(): HTMLElement {
  return divider(`Results for “${chatSearchInput.value.trim()}”`);
}

function searchRow(result: SearchResult): HTMLElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "chat-search-result";
  const where = document.createElement("span");
  where.className = "chat-search-where";
  where.textContent = `#${result.channel.name ?? "channel"} · ${result.message.agent?.name ?? result.message.authorName} · ${dayLabel(result.message.createdAt)} ${timeLabel(result.message.createdAt)}`;
  const body = document.createElement("span");
  body.textContent = mentionDisplay(result.message.body);
  button.append(where, body);
  button.addEventListener("click", () => {
    void (async () => {
      await selectChannel(result.channel.id);
      if (!result.message.threadId) return;
      try {
        const thread = await fetchCloudJson<{ root?: ChatMessage }>(`/api/channels/${encodeURIComponent(result.channel.id)}/messages/${encodeURIComponent(result.message.id)}`);
        if (thread.root) await openThread(thread.root);
      } catch (error) {
        setPanelStatus(chatStatus, errorMessage(error), "error");
      }
    })();
  });
  return button;
}

/** Splits text into nodes, highlighting `@Name` mentions and turning bare URLs into links. */
function formatBody(text: string, mentionNames: string[]): Node[] {
  const names = [...new Set(mentionNames)].sort((left, right) => right.length - left.length).map(escapeRegExp);
  const pattern = new RegExp(`(https?://[^\\s<>"]+)${names.length ? `|(@(?:${names.join("|")}))` : ""}`, "g");
  const nodes: Node[] = [];
  let last = 0;
  for (const match of text.matchAll(pattern)) {
    if (match.index > last) nodes.push(document.createTextNode(text.slice(last, match.index)));
    if (match[1]) {
      const link = document.createElement("a");
      link.href = match[1];
      link.textContent = match[1];
      link.target = "_blank";
      link.rel = "noopener noreferrer";
      nodes.push(link);
    } else {
      const mention = document.createElement("span");
      mention.className = "chat-mention";
      mention.textContent = match[0];
      nodes.push(mention);
    }
    last = match.index + match[0].length;
  }
  if (last < text.length) nodes.push(document.createTextNode(text.slice(last)));
  return nodes;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function bindComposer(input: HTMLTextAreaElement, send: () => void): void {
  input.addEventListener("input", () => autoGrow(input));
  input.addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
      event.preventDefault();
      send();
    }
  });
}

function autoGrow(input: HTMLTextAreaElement): void {
  input.style.height = "auto";
  input.style.height = `${Math.min(input.scrollHeight, 180)}px`;
}

function insertMention(input: HTMLTextAreaElement, id: string): void {
  const token = `@{${id}} `;
  const start = input.selectionStart ?? input.value.length;
  input.value = `${input.value.slice(0, start)}${token}${input.value.slice(input.selectionEnd ?? start)}`;
  input.focus();
  input.selectionStart = input.selectionEnd = start + token.length;
}

function scrollToEnd(element: HTMLElement): void {
  element.scrollTop = element.scrollHeight;
}

function initials(name: string): string {
  const words = name.trim().split(/\s+/).filter(Boolean);
  return ((words[0]?.[0] ?? "?") + (words.length > 1 ? words[words.length - 1]![0] ?? "" : "")).toUpperCase();
}

function hue(id: string): number {
  let hash = 0;
  for (const char of id) hash = (hash * 31 + char.charCodeAt(0)) % 360;
  return hash;
}

function dayLabel(value: string): string {
  const date = new Date(value);
  const today = new Date();
  const yesterday = new Date(today.getTime() - 86_400_000);
  if (date.toDateString() === today.toDateString()) return "Today";
  if (date.toDateString() === yesterday.toDateString()) return "Yesterday";
  return date.toLocaleDateString(undefined, { weekday: "long", month: "long", day: "numeric" });
}

function timeLabel(value: string): string {
  return new Date(value).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
}

function jsonInit(method: string, body: Record<string, unknown>): RequestInit {
  return { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) };
}
