/**
 * `/api/channels` and `/api/chat`: Slack-style conversations inside a space. A channel belongs to one
 * space and may be tied to a Work project; its topic says what it is about. Messages thread, react,
 * and `@{id}`-mention people and agents. Any message can become a Work issue, and any thread can be
 * captured as a `.noma` page, so decisions made in chat land in the reviewable source of truth.
 *
 * Access follows the space: space viewers read and post in public channels, private channels are
 * members-only (and invisible to everyone else), space editors create channels. Agents take part
 * through their owner's credentials, like page comments: an agent with the `chat` capability and a
 * grant on the space can read public channels (private ones once added as a member), answer its
 * mentions, and post. Agent posts never create agent mentions, so agents cannot ping-pong.
 */
import { enqueueSlackOutbound } from "./integrations.js";
import { enforceDlp } from "./dlp.js";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { ChatChannel, ChatChannelVisibility, ChatFile, ChatMember, ChatMessage, ChatMessageKind } from "../cloud-chat.js";
import type { CloudIssue, CloudIssuePriority, CloudIssueType, CloudSiteRecord, CloudUserRecord } from "../cloud-db.js";
import type { CloudAgentIdentity } from "../cloud-platform.js";
import { chatChannelToNoma, chatThreadToNoma, CHAT_MESSAGE_MAX, channelNameInput } from "./chat.js";
import {
  type AccessContext,
  type CloudServerConfig,
  type Principal,
  randomId,
  readSite,
  recordActivity,
  recordIssueEvent,
  requireNotTrashed,
  requireProjectAccess,
  requireRecordAccess,
  requireUser,
  roleRank,
  uniqueId,
  writeNotification,
} from "./context.js";
import { HttpError, readJsonBody, sendJson, sendText, sha256Hex } from "./http.js";
import { boundedInteger, numberQuery, optionalCloudId, optionalString, stringInput, stringPathPart } from "./input.js";
import { extractMentions } from "./mentions.js";
import { afterDocumentSaved } from "./page-hooks.js";
import { createDocument, documentResponse } from "./records.js";
import { ownedAgent } from "./routes-knowledge.js";
import { collectAttachmentGarbage, isImageAttachment } from "./attachments.js";
import { enqueueMention, requireAgentsRunning } from "./agent-runner.js";
import { runChatCommand } from "./routes-devloop.js";
import { attachmentIdFor, personalStorageBytes, serveStoredBlob, spaceStorageBytes, stageUpload } from "./routes-attachments.js";
import { attachPageToSite } from "./routes-sites.js";
import { requestUrl } from "./security.js";
import { requireSpaceWritable } from "./spaces.js";

/** The capability an agent needs to read and post in channels. */
export const AGENT_CHAT_CAPABILITY = "chat";

const TOPIC_MAX = 500;
const MAX_REACTIONS_PER_MESSAGE = 50;
const STREAM_HEARTBEAT_MS = 25_000;
const MAX_STREAMS_PER_USER = 20;
const MAX_CAPTURED_REPLIES = 5_000;
const MAX_DM_MEMBERS = 12;
const MAX_FILES_PER_MESSAGE = 10;
const ISSUE_KEY_RE = /\b[A-Z][A-Z0-9]{1,9}-\d{1,7}\b/g;

interface ChannelContext {
  channel: ChatChannel;
  /** Absent for direct messages. */
  site?: CloudSiteRecord;
  access?: AccessContext;
  user: CloudUserRecord;
  principal: Principal;
  member?: ChatMember;
  canManage: boolean;
}

export async function routeChannels(req: IncomingMessage, res: ServerResponse, url: URL, parts: string[], config: CloudServerConfig, principal: Principal): Promise<void> {
  const method = req.method ?? "GET";
  const user = requireUser(principal);
  const channelId = parts[2];
  if (!channelId && method === "GET") {
    sendJson(res, 200, { channels: listVisibleChannels(config, principal, user, url) });
    return;
  }
  if (!channelId && method === "POST") {
    const input = await readJsonBody(req, config.maxBodyBytes);
    sendJson(res, 201, await createChannel(config, principal, user, input));
    return;
  }
  if (!channelId) throw new HttpError(404, "Channel ID is required");
  const context = await channelContext(config, principal, stringPathPart(channelId, "Channel ID"));
  const action = parts[3];
  const childId = parts[4];

  if (!action && method === "GET") {
    sendJson(res, 200, channelDetail(config, context));
    return;
  }
  if (!action && method === "PATCH") {
    const input = await readJsonBody(req, config.maxBodyBytes);
    sendJson(res, 200, updateChannel(config, context, input));
    return;
  }
  if (action === "join" && method === "POST") {
    if (context.channel.visibility === "private" && !context.member) throw new HttpError(403, "Private channels are invitation-only");
    joinChannel(config, context);
    sendJson(res, 200, channelDetail(config, { ...context, member: config.chat.readMember(context.channel.id, user.id) }));
    return;
  }
  if (action === "leave" && method === "POST") {
    config.chat.removeMember(context.channel.id, user.id);
    if (context.channel.kind === "dm") config.chat.clearDmKey(context.channel.id);
    sendJson(res, 200, { left: true });
    return;
  }
  if (action === "read" && method === "POST") {
    const input = await readJsonBody(req, config.maxBodyBytes);
    if (!context.member) joinChannel(config, context);
    const seq = boundedInteger(input.seq, context.channel.lastSeq, 0, context.channel.lastSeq, "seq");
    sendJson(res, 200, { lastReadSeq: config.chat.markRead(context.channel.id, user.id, seq) });
    return;
  }
  if (action === "members") {
    await routeMembers(req, res, childId, config, context);
    return;
  }
  if (action === "messages") {
    await routeMessages(req, res, url, childId, parts[5], parts[6], config, principal, context);
    return;
  }
  if (action === "stream" && method === "GET") {
    streamChannel(req, res, config, principal, context);
    return;
  }
  if (action === "files" && !childId && method === "POST") {
    sendJson(res, 201, await uploadChatFile(req, res, config, context));
    return;
  }
  if (action === "files" && childId && (method === "GET" || method === "HEAD")) {
    const file = config.chat.readFile(stringPathPart(childId, "File ID"));
    if (!file || file.channelId !== context.channel.id) throw new HttpError(404, "File not found");
    if (!file.messageId && file.uploadedBy !== user.id) throw new HttpError(404, "File not found");
    await serveStoredBlob(req, res, config, file, "same-origin");
    return;
  }
  if (action === "files" && childId && method === "DELETE") {
    const file = config.chat.readFile(stringPathPart(childId, "File ID"));
    if (!file || file.channelId !== context.channel.id || file.uploadedBy !== user.id) throw new HttpError(404, "File not found");
    if (file.messageId) throw new HttpError(409, "Shared files are removed by deleting their message");
    config.chat.deleteUnattachedFile(file.id);
    await collectAttachmentGarbage(config, [file.sha256]);
    sendJson(res, 200, { removed: file.id });
    return;
  }
  if (action === "bridge") {
    await routeBridge(req, res, config, context);
    return;
  }
  if (action === "export" && method === "GET") {
    if (context.channel.kind !== "dm" && !context.canManage) throw new HttpError(403, "Channel admin access is required to export");
    const bundle = channelExport(config, context.channel, { ...exportWindow(url) }, user);
    config.platform.recordAudit(user.id, "chat.channel_exported", "chat_channel", context.channel.id, { messages: bundle.messages.length, digest: bundle.digest }, config.now().toISOString());
    if (url.searchParams.get("format") === "noma") {
      sendText(res, 200, channelTranscriptNoma(config, context.channel, bundle.messages), "text/plain; charset=utf-8");
      return;
    }
    sendJson(res, 200, bundle);
    return;
  }
  throw new HttpError(404, "Unknown channel route");
}

/** `GET /api/chat/search?q=…[&siteId=…]` — messages across every channel the caller can read. */
export async function routeChat(req: IncomingMessage, res: ServerResponse, url: URL, parts: string[], config: CloudServerConfig, principal: Principal): Promise<void> {
  const user = requireUser(principal);
  if (parts[2] === "dms") {
    await routeDms(req, res, config, principal, user);
    return;
  }
  if (parts[2] !== "search" || (req.method ?? "GET") !== "GET") throw new HttpError(404, "Unknown chat route");
  const q = (url.searchParams.get("q") ?? "").trim().slice(0, 200);
  if (q.length < 2) throw new HttpError(400, "q must be at least 2 characters");
  const limit = boundedInteger(numberQuery(url.searchParams.get("limit")), 50, 1, 200, "limit");
  const channels = readableChannels(config, principal, user, optionalCloudId(url.searchParams.get("siteId") ?? undefined, "Site"));
  const byId = new Map(channels.map((channel) => [channel.id, channel]));
  const messages = config.chat.searchMessages([...byId.keys()], q, limit);
  const names = nameResolver(config);
  sendJson(res, 200, {
    q,
    results: messages.map((message) => ({ channel: { id: message.channelId, name: byId.get(message.channelId)?.name, siteId: byId.get(message.channelId)?.siteId }, message: messageResponse(config, message, names) })),
  });
}

/** Channels, DMs and messages matching `q` that the user can read, for the unified finder. */
export function findInChat(config: CloudServerConfig, principal: Principal, user: CloudUserRecord, q: string, limit: number): Record<string, Array<Record<string, unknown>>> {
  const channels = readableChannels(config, principal, user);
  const dms = config.chat.listDms(user.id);
  const needle = q.toLowerCase();
  const names = nameResolver(config);
  const byId = new Map([...channels, ...dms].map((channel) => [channel.id, channel]));
  return {
    channels: channels
      .filter((channel) => channel.name.includes(needle.replace(/^#/, "")) || (channel.topic ?? "").toLowerCase().includes(needle))
      .slice(0, limit)
      .map((channel) => ({ id: channel.id, name: channel.name, siteId: channel.siteId, visibility: channel.visibility, ...(channel.topic ? { topic: channel.topic } : {}) })),
    dms: dms
      .map((dm) => ({ id: dm.id, title: dmTitle(config, dm, user.id) }))
      .filter((dm) => dm.title.toLowerCase().includes(needle))
      .slice(0, limit),
    messages: config.chat.searchMessages([...byId.keys()], q, limit).map((message) => {
      const channel = byId.get(message.channelId)!;
      return {
        id: message.id,
        channelId: channel.id,
        channel: channel.kind === "dm" ? dmTitle(config, channel, user.id) : `#${channel.name}`,
        ...(message.threadId ? { threadId: message.threadId } : {}),
        author: message.agentId ? names(message.agentId, true) : names(message.authorId, false),
        excerpt: displayBody(config, message.body).slice(0, 200),
        createdAt: message.createdAt,
      };
    }),
  };
}

/**
 * `GET|POST /api/chat/dms` — direct and group messages. Starting one with the same people again
 * returns the existing conversation. Everyone invited must share a space with the person starting it.
 */
async function routeDms(req: IncomingMessage, res: ServerResponse, config: CloudServerConfig, principal: Principal, user: CloudUserRecord): Promise<void> {
  const method = req.method ?? "GET";
  if (method === "GET") {
    const dms = config.chat.listDms(user.id);
    const counts = config.chat.unreadCounts(user.id, dms.map((dm) => dm.id));
    const members = config.chat.memberChannelIds(user.id, dms.map((dm) => dm.id));
    sendJson(res, 200, {
      dms: dms.map((dm) => ({
        ...channelSummary(dm),
        title: dmTitle(config, dm, user.id),
        joined: true,
        lastReadSeq: members.get(dm.id)?.lastReadSeq ?? 0,
        unread: counts.get(dm.id)?.unread ?? 0,
        mentions: counts.get(dm.id)?.mentions ?? 0,
      })),
    });
    return;
  }
  if (method !== "POST") throw new HttpError(405, "Method not allowed");
  const input = await readJsonBody(req, config.maxBodyBytes);
  const requested = Array.isArray(input.memberIds) ? input.memberIds.filter((id): id is string => typeof id === "string") : [];
  const others = [...new Set(requested)].filter((id) => id !== user.id);
  if (others.length === 0) throw new HttpError(400, "memberIds must name at least one other person");
  if (others.length + 1 > MAX_DM_MEMBERS) throw new HttpError(400, `Group messages are limited to ${MAX_DM_MEMBERS} people`);
  const visible = new Set(config.store.userNames(user.id, others).map((item) => item.id));
  const unknown = others.filter((id) => !visible.has(id));
  if (unknown.length) throw new HttpError(400, "You can only message people who share a space with you", { unknown });
  const memberIds = [user.id, ...others].sort();
  const dmKey = sha256Hex(`dm:${memberIds.join(",")}`);
  const existing = config.chat.readDmByKey(dmKey);
  if (existing) {
    sendJson(res, 200, channelDetail(config, { channel: existing, user, principal, member: config.chat.readMember(existing.id, user.id)!, canManage: false }));
    return;
  }
  const now = config.now().toISOString();
  const id = randomId();
  const channel = config.chat.createChannel({ id, kind: "dm", siteId: "", name: `dm-${id}`, visibility: "private", createdBy: user.id, createdAt: now, updatedAt: now }, dmKey);
  for (const memberId of memberIds) config.chat.addMember({ channelId: channel.id, memberId, memberType: "user", role: "member", joinedAt: now });
  sendJson(res, 201, channelDetail(config, { channel, user, principal, member: config.chat.readMember(channel.id, user.id)!, canManage: false }));
}

/** `GET /api/agents/:id/chat?status=pending|all` — messages that mention the agent, for its owner. */
export function agentChatInbox(config: CloudServerConfig, agent: CloudAgentIdentity, status: string | undefined, limit: number): Array<Record<string, unknown>> {
  const pending = status === undefined || status === "" || status === "pending";
  if (!pending && status !== "all") throw new HttpError(400, "status must be pending or all");
  const names = nameResolver(config);
  return config.chat.listAgentMentions(agent.id, { pending, limit }).flatMap((mention) => {
    const channel = config.chat.readChannel(mention.channelId);
    const message = config.chat.readMessage(mention.messageId);
    if (!channel || !message || channel.archivedAt || !agentChannelAccess(config, agent.id, channel)) return [];
    const rootId = message.threadId ?? message.id;
    const root = message.threadId ? config.chat.readMessage(message.threadId) : message;
    const replies = config.chat.listMessages(channel.id, { threadId: rootId, limit: 50 });
    return [
      {
        channel: { id: channel.id, name: channel.name, siteId: channel.siteId, ...(channel.topic ? { topic: channel.topic } : {}), ...(channel.projectId ? { projectId: channel.projectId } : {}) },
        message: messageResponse(config, message, names),
        threadId: rootId,
        thread: [...(root ? [root] : []), ...replies].filter((item) => !item.deletedAt).map((item) => messageResponse(config, item, names)),
      },
    ];
  });
}

/** Gateway (`/api/gateway/mcp`) chat tools. `agent` is already verified as owned by the caller. */
export async function callChatGatewayTool(name: string, args: Record<string, unknown>, config: CloudServerConfig, principal: Principal, agent: CloudAgentIdentity): Promise<Record<string, unknown>> {
  const user = requireUser(principal);
  if (name === "chat_inbox") {
    return { mentions: agentChatInbox(config, agent, optionalString(args.status), boundedInteger(args.limit, 25, 1, 100, "limit")) };
  }
  const channel = config.chat.readChannel(stringInput(args, "channelId"));
  if (!channel || !agentChannelAccess(config, agent.id, channel)) throw new HttpError(404, "Channel not found");
  if (name === "chat_history") {
    const threadId = optionalString(args.threadId);
    const after = args.after === undefined ? undefined : boundedInteger(args.after, 0, 0, Number.MAX_SAFE_INTEGER, "after");
    const messages = config.chat.listMessages(channel.id, { limit: boundedInteger(args.limit, 50, 1, 200, "limit"), ...(threadId ? { threadId } : {}), ...(after !== undefined ? { after } : {}) });
    const names = nameResolver(config);
    return { channel: channelSummary(channel), messages: messages.map((message) => messageResponse(config, message, names)) };
  }
  if (name === "chat_post") {
    const context = await channelContext(config, principal, channel.id, agent);
    const message = postMessage(config, context, { body: stringInput(args, "body"), ...(optionalString(args.threadId) ? { threadId: optionalString(args.threadId)! } : {}) }, agent);
    await runChatCommand(config, principal, channel, message, agent);
    recordActivity(config, user, "chat.agent_posted", "site", channel.siteId, { channelId: channel.id, messageId: message.id, agentId: agent.id, transport: "mcp" });
    return { message: messageResponse(config, message, nameResolver(config)) };
  }
  throw new HttpError(400, `Unknown gateway tool: ${name}`);
}

/**
 * Posts as a hosted or scheduled agent, exactly like the `chat_post` gateway tool: the agent must be
 * able to chat in the channel, and a `/deploy` or `/test` line goes through the run guardrails.
 */
export async function postAsAgent(config: CloudServerConfig, owner: CloudUserRecord, agent: CloudAgentIdentity, channelId: string, body: string, threadId?: string): Promise<ChatMessage> {
  requireAgentsRunning(config);
  const principal: Principal = { user: owner };
  const context = await channelContext(config, principal, channelId, agent);
  const message = postMessage(config, context, { body, ...(threadId ? { threadId } : {}) }, agent);
  await runChatCommand(config, principal, context.channel, message, agent);
  recordActivity(config, owner, "chat.agent_posted", "site", context.channel.siteId, { channelId, messageId: message.id, agentId: agent.id, transport: "hosted" });
  return message;
}

/** `Name: text` lines for a thread (root first) or, without `rootId`, the channel's recent top-level messages. */
export function channelTranscript(config: CloudServerConfig, channelId: string, options: { rootId?: string; after?: string; limit: number }): string[] {
  const names = nameResolver(config);
  const messages = options.rootId
    ? [config.chat.readMessage(options.rootId), ...config.chat.listMessages(channelId, { threadId: options.rootId, limit: options.limit })].filter((message): message is ChatMessage => Boolean(message))
    : config.chat.listMessages(channelId, { limit: options.limit });
  return messages
    .filter((message) => !message.deletedAt && (!options.after || message.createdAt > options.after))
    .slice(-options.limit)
    .map((message) => `${message.kind === "system" ? "(system)" : names(message.agentId ?? message.authorId, Boolean(message.agentId))}: ${displayBody(config, message.body)}`);
}

// channels

function listVisibleChannels(config: CloudServerConfig, principal: Principal, user: CloudUserRecord, url: URL): Array<Record<string, unknown>> {
  const siteId = optionalCloudId(url.searchParams.get("siteId") ?? undefined, "Site");
  const projectId = optionalString(url.searchParams.get("projectId"));
  const includeArchived = url.searchParams.get("archived") === "1" || url.searchParams.get("archived") === "true";
  const channels = readableChannels(config, principal, user, siteId, { ...(projectId ? { projectId } : {}), includeArchived });
  const members = config.chat.memberChannelIds(user.id, channels.map((channel) => channel.id));
  const counts = config.chat.unreadCounts(user.id, [...members.keys()]);
  return channels.map((channel) => {
    const member = members.get(channel.id);
    return {
      ...channelSummary(channel),
      joined: Boolean(member),
      ...(member ? { lastReadSeq: member.lastReadSeq, unread: counts.get(channel.id)?.unread ?? 0, mentions: counts.get(channel.id)?.mentions ?? 0 } : {}),
    };
  });
}

/** Channels the user may read: spaces they can view, minus private channels they are not in. */
function readableChannels(config: CloudServerConfig, principal: Principal, user: CloudUserRecord, siteId?: string, filter: { projectId?: string; includeArchived?: boolean } = {}): ChatChannel[] {
  const siteIds = siteId
    ? [siteId].filter((id) => {
        const site = config.store.readSite(id);
        return site && !config.store.isTrashed("site", id) && hasUserAccess(config, site, principal);
      })
    : config.store
        .listSites(user)
        .filter((site) => !config.store.isTrashed("site", site.id))
        .map((site) => site.id);
  const channels = config.chat.listChannels(siteIds, filter);
  const members = config.chat.memberChannelIds(user.id, channels.filter((channel) => channel.visibility === "private").map((channel) => channel.id));
  return channels.filter((channel) => channel.visibility === "public" || members.has(channel.id));
}

async function createChannel(config: CloudServerConfig, principal: Principal, user: CloudUserRecord, input: Record<string, unknown>): Promise<Record<string, unknown>> {
  const siteId = stringInput(input, "siteId");
  const site = await readSite(config, siteId);
  requireNotTrashed(config, "site", siteId);
  const access = requireRecordAccess(config, site, principal, "editor");
  if (access.via === "share") throw new HttpError(403, "Chat requires a signed-in collaborator");
  requireSpaceWritable(site);
  const name = channelNameInput(input.name);
  if (config.chat.readChannelByName(site.id, name)) throw new HttpError(409, `#${name} already exists in this space`);
  const projectId = channelProjectInput(config, principal, site, input.projectId);
  const now = config.now().toISOString();
  const channel = config.chat.createChannel({
    id: randomId(),
    kind: "channel",
    siteId: site.id,
    ...(projectId ? { projectId } : {}),
    name,
    ...(optionalString(input.topic) ? { topic: optionalString(input.topic)!.slice(0, TOPIC_MAX) } : {}),
    visibility: visibilityInput(input.visibility, "public"),
    createdBy: user.id,
    createdAt: now,
    updatedAt: now,
  });
  config.chat.addMember({ channelId: channel.id, memberId: user.id, memberType: "user", role: "admin", joinedAt: now });
  const invited = Array.isArray(input.memberIds) ? input.memberIds.filter((id): id is string => typeof id === "string").slice(0, 100) : [];
  for (const memberId of invited) addChannelMember(config, channel, site, memberId, now);
  recordActivity(config, user, "chat.channel_created", "site", site.id, { channelId: channel.id, name: channel.name, visibility: channel.visibility, ...(projectId ? { projectId } : {}) });
  return channelDetail(config, { channel, site, access, user, principal, member: config.chat.readMember(channel.id, user.id), canManage: true });
}

function updateChannel(config: CloudServerConfig, context: ChannelContext, input: Record<string, unknown>): Record<string, unknown> {
  const site = requireSpace(context);
  if (!context.canManage) throw new HttpError(403, "Channel admin access is required");
  const archiving = input.archived === true || input.archived === false;
  requireSpaceWritable(site);
  if (context.channel.archivedAt && !archiving) throw new HttpError(409, "Channel is archived");
  const name = input.name === undefined ? undefined : channelNameInput(input.name);
  if (name && name !== context.channel.name && config.chat.readChannelByName(context.channel.siteId, name)) throw new HttpError(409, `#${name} already exists in this space`);
  const projectId = input.projectId === undefined ? undefined : input.projectId === null ? null : channelProjectInput(config, context.principal, site, input.projectId) ?? null;
  const now = config.now().toISOString();
  const next = config.chat.updateChannel(context.channel.id, {
    ...(name ? { name } : {}),
    ...(input.topic === null ? { topic: null } : optionalString(input.topic) !== undefined ? { topic: optionalString(input.topic)!.slice(0, TOPIC_MAX) } : {}),
    ...(input.visibility !== undefined ? { visibility: visibilityInput(input.visibility, context.channel.visibility) } : {}),
    ...(projectId !== undefined ? { projectId } : {}),
    ...(archiving ? { archivedAt: input.archived === true ? context.channel.archivedAt ?? now : null } : {}),
    updatedAt: now,
  })!;
  if (next.visibility === "private" && context.channel.visibility === "public") {
    config.chat.addMember({ channelId: next.id, memberId: context.user.id, memberType: "user", role: "admin", joinedAt: now });
  }
  if (next.topic !== context.channel.topic || next.name !== context.channel.name) {
    const change = next.name !== context.channel.name ? `renamed the channel to #${next.name}` : next.topic ? `set the topic: ${next.topic}` : "cleared the topic";
    systemMessage(config, next, context.user, change);
  }
  return channelDetail(config, { ...context, channel: config.chat.readChannel(next.id)!, member: config.chat.readMember(next.id, context.user.id) });
}

function channelDetail(config: CloudServerConfig, context: ChannelContext): Record<string, unknown> {
  const names = nameResolver(config);
  const project = context.channel.projectId ? config.store.readProject(context.channel.projectId) : undefined;
  const members = config.chat.listMembers(context.channel.id);
  return {
    ...channelSummary(context.channel),
    ...(context.channel.kind === "dm" ? { title: dmTitle(config, context.channel, context.user.id, members) } : {}),
    ...(project ? { project: { id: project.id, key: project.key, name: project.name } } : {}),
    ...(context.site ? { space: { id: context.site.id, title: context.site.title } } : {}),
    joined: Boolean(context.member),
    ...(context.member ? { lastReadSeq: context.member.lastReadSeq, memberRole: context.member.role } : {}),
    access: {
      role: context.access?.role ?? "viewer",
      canManage: context.canManage,
      canPost: !context.channel.archivedAt && !context.site?.archivedAt && (context.channel.visibility === "public" || Boolean(context.member)),
    },
    members: members.map((member) => ({ id: member.memberId, name: names(member.memberId, member.memberType === "agent"), type: member.memberType, role: member.role })),
    agents: channelAgents(config, context.channel).map((agent) => ({ id: agent.id, name: agent.name })),
  };
}

function channelSummary(channel: ChatChannel): Record<string, unknown> {
  return { ...channel };
}

function channelProjectInput(config: CloudServerConfig, principal: Principal, site: CloudSiteRecord, value: unknown): string | undefined {
  const projectId = optionalString(value);
  if (!projectId) return undefined;
  const project = config.store.readProject(projectId);
  if (!project || project.siteId !== site.id) throw new HttpError(400, "projectId must be a project in this space");
  requireProjectAccess(config, project, principal, "viewer");
  return project.id;
}

function visibilityInput(value: unknown, fallback: ChatChannelVisibility): ChatChannelVisibility {
  if (value === undefined || value === null || value === "") return fallback;
  if (value === "public" || value === "private") return value;
  throw new HttpError(400, "visibility must be public or private");
}

async function channelContext(config: CloudServerConfig, principal: Principal, channelId: string, agent?: CloudAgentIdentity): Promise<ChannelContext> {
  const user = requireUser(principal);
  const channel = config.chat.readChannel(channelId);
  if (!channel) throw new HttpError(404, "Channel not found");
  if (channel.kind === "dm") {
    const member = config.chat.readMember(channel.id, user.id);
    if (!member || agent) throw new HttpError(404, "Channel not found");
    return { channel, user, principal, member, canManage: false };
  }
  const site = config.store.readSite(channel.siteId);
  if (!site || config.store.isTrashed("site", site.id)) throw new HttpError(404, "Channel not found");
  let access: AccessContext;
  try {
    access = requireRecordAccess(config, site, principal, "viewer");
  } catch {
    throw new HttpError(404, "Channel not found");
  }
  if (access.via === "share") throw new HttpError(404, "Channel not found");
  const member = config.chat.readMember(channel.id, user.id);
  if (channel.visibility === "private" && !member && !(agent && config.chat.readMember(channel.id, agent.id))) throw new HttpError(404, "Channel not found");
  const canManage = member?.role === "admin" || access.role === "owner" || (channel.visibility === "public" && roleRank[access.role] >= roleRank.editor);
  return { channel, site, access, user, principal, ...(member ? { member } : {}), canManage };
}

/** The channel's space, or 409 for direct messages, which have none. */
function requireSpace(context: ChannelContext): CloudSiteRecord {
  if (!context.site) throw new HttpError(409, "Direct messages are not part of a space");
  return context.site;
}

/** "Ada, Bob": the other members of a direct message, or "Just you". */
function dmTitle(config: CloudServerConfig, channel: ChatChannel, viewerId: string, members = config.chat.listMembers(channel.id)): string {
  const names = nameResolver(config);
  const others = members
    .filter((member) => member.memberId !== viewerId)
    .map((member) => names(member.memberId, false))
    .sort((left, right) => left.localeCompare(right));
  return others.length ? others.join(", ") : "Just you";
}

function hasUserAccess(config: CloudServerConfig, site: CloudSiteRecord, principal: Principal): boolean {
  try {
    return requireRecordAccess(config, site, principal, "viewer").via !== "share";
  } catch {
    return false;
  }
}

function joinChannel(config: CloudServerConfig, context: ChannelContext): ChatMember {
  return config.chat.addMember({ channelId: context.channel.id, memberId: context.user.id, memberType: "user", role: "member", joinedAt: config.now().toISOString(), lastReadSeq: context.channel.lastSeq });
}

// members

async function routeMembers(req: IncomingMessage, res: ServerResponse, memberId: string | undefined, config: CloudServerConfig, context: ChannelContext): Promise<void> {
  const method = req.method ?? "GET";
  if (!memberId && method === "GET") {
    sendJson(res, 200, { members: channelDetail(config, context).members });
    return;
  }
  if (!memberId && method === "POST") {
    if (!context.member && !context.canManage) throw new HttpError(403, "Join the channel before adding people");
    if (context.site) requireSpaceWritable(context.site);
    const input = await readJsonBody(req, config.maxBodyBytes);
    const added = context.site
      ? addChannelMember(config, context.channel, context.site, stringInput(input, "memberId"), config.now().toISOString())
      : addDmMember(config, context, stringInput(input, "memberId"));
    if (!added) throw new HttpError(400, "memberId must be a person with access to this space, or an agent with a chat grant on it");
    systemMessage(config, context.channel, context.user, `added ${nameResolver(config)(added.memberId, added.memberType === "agent")}`);
    sendJson(res, 201, { id: added.memberId, type: added.memberType, role: added.role });
    return;
  }
  if (memberId && method === "DELETE") {
    if (memberId !== context.user.id && !context.canManage) throw new HttpError(403, "Channel admin access is required");
    if (!config.chat.removeMember(context.channel.id, memberId)) throw new HttpError(404, "Member not found");
    if (context.channel.kind === "dm") config.chat.clearDmKey(context.channel.id);
    if (context.site) recordActivity(config, context.user, "chat.member_removed", "site", context.site.id, { channelId: context.channel.id, memberId });
    sendJson(res, 200, { removed: memberId });
    return;
  }
  throw new HttpError(405, "Method not allowed");
}

/** Grows a group DM with a person who shares a space with the one adding them. */
function addDmMember(config: CloudServerConfig, context: ChannelContext, memberId: string): ChatMember | undefined {
  if (config.store.userNames(context.user.id, [memberId]).length === 0) return undefined;
  const existing = config.chat.readMember(context.channel.id, memberId);
  if (existing) return existing;
  if (config.chat.listMembers(context.channel.id).length >= MAX_DM_MEMBERS) throw new HttpError(409, `Group messages are limited to ${MAX_DM_MEMBERS} people`);
  const member = config.chat.addMember({ channelId: context.channel.id, memberId, memberType: "user", role: "member", joinedAt: config.now().toISOString() });
  config.chat.clearDmKey(context.channel.id);
  return member;
}

/** Adds a person who can view the space, or an agent that can chat there. Returns undefined when neither applies. */
function addChannelMember(config: CloudServerConfig, channel: ChatChannel, site: CloudSiteRecord, memberId: string, now: string): ChatMember | undefined {
  if (config.store.readUser(memberId)) {
    if (!config.store.resourceAccess(memberId, "site", site.id)) return undefined;
    const member = config.chat.addMember({ channelId: channel.id, memberId, memberType: "user", role: "member", joinedAt: now });
    return member;
  }
  const agent = config.platform.readAgent(memberId);
  if (!agent || !agentCanChatInSpace(config, agent, site.id)) return undefined;
  return config.chat.addMember({ channelId: channel.id, memberId, memberType: "agent", role: "member", joinedAt: now });
}

// agents

function agentCanChatInSpace(config: CloudServerConfig, agent: CloudAgentIdentity, siteId: string): boolean {
  if (agent.status !== "active" || !agent.capabilities.includes(AGENT_CHAT_CAPABILITY)) return false;
  if (!config.platform.listAgentAccess(agent.id).some((grant) => grant.resourceType === "site" && grant.resourceId === siteId)) return false;
  return Boolean(config.store.resourceAccess(agent.createdBy, "site", siteId));
}

/** The agent when it may read and post in the channel, otherwise undefined. */
export function agentChannelAccess(config: CloudServerConfig, agentId: string, channel: ChatChannel): CloudAgentIdentity | undefined {
  const agent = config.platform.readAgent(agentId);
  if (!agent || !agentCanChatInSpace(config, agent, channel.siteId)) return undefined;
  if (channel.visibility === "private" && !config.chat.readMember(channel.id, agent.id)) return undefined;
  return agent;
}

/** Agents people can @-mention in the channel. */
function channelAgents(config: CloudServerConfig, channel: ChatChannel): CloudAgentIdentity[] {
  const agentIds = new Set(config.platform.listAgentAccessCovering("", [channel.siteId]).map((grant) => grant.agentId));
  return [...agentIds]
    .flatMap((id) => {
      const agent = agentChannelAccess(config, id, channel);
      return agent ? [agent] : [];
    })
    .sort((left, right) => left.name.localeCompare(right.name))
    .slice(0, 100);
}

// messages

async function routeMessages(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  messageId: string | undefined,
  action: string | undefined,
  actionId: string | undefined,
  config: CloudServerConfig,
  principal: Principal,
  context: ChannelContext,
): Promise<void> {
  const method = req.method ?? "GET";
  const names = nameResolver(config);
  if (!messageId && method === "GET") {
    const threadId = optionalString(url.searchParams.get("thread"));
    const after = numberQuery(url.searchParams.get("after"));
    const before = numberQuery(url.searchParams.get("before"));
    const all = url.searchParams.get("all") === "1";
    const limit = boundedInteger(numberQuery(url.searchParams.get("limit")), 50, 1, 200, "limit");
    const messages = config.chat.listMessages(context.channel.id, {
      limit,
      ...(threadId ? { threadId } : {}),
      ...(after !== undefined ? { after: boundedInteger(after, 0, 0, Number.MAX_SAFE_INTEGER, "after") } : {}),
      ...(before !== undefined ? { before: boundedInteger(before, 0, 0, Number.MAX_SAFE_INTEGER, "before") } : {}),
      all,
    });
    sendJson(res, 200, { channelId: context.channel.id, lastSeq: config.chat.readChannel(context.channel.id)?.lastSeq ?? context.channel.lastSeq, messages: messagesResponse(config, context.channel, messages, names) });
    return;
  }
  if (!messageId && method === "POST") {
    const input = await readJsonBody(req, config.maxBodyBytes);
    const agentId = optionalString(input.agentId);
    if (agentId) requireAgentsRunning(config);
    const agent = agentId ? ownedAgent(config, context.user, agentId) : undefined;
    if (agent && !agentChannelAccess(config, agent.id, context.channel)) throw new HttpError(403, "The agent cannot chat in this channel");
    const threadId = optionalString(input.threadId);
    const fileIds = Array.isArray(input.fileIds) ? (input.fileIds as unknown[]).filter((id): id is string => typeof id === "string") : [];
    const message = postMessage(config, context, { body: typeof input.body === "string" ? input.body : "", ...(threadId ? { threadId } : {}), ...(fileIds.length ? { fileIds } : {}) }, agent);
    await runChatCommand(config, principal, context.channel, message, agent);
    sendJson(res, 201, messagesResponse(config, context.channel, [message], names)[0]);
    return;
  }
  if (!messageId) throw new HttpError(405, "Method not allowed");
  const message = config.chat.readMessage(stringPathPart(messageId, "Message ID"));
  if (!message || message.channelId !== context.channel.id) throw new HttpError(404, "Message not found");

  if (!action && method === "GET") {
    const rootId = message.threadId ?? message.id;
    const root = message.threadId ? config.chat.readMessage(rootId) : message;
    const replies = config.chat.listMessages(context.channel.id, { threadId: rootId, limit: 200 });
    sendJson(res, 200, { root: root ? messagesResponse(config, context.channel, [root], names)[0] : undefined, replies: messagesResponse(config, context.channel, replies, names) });
    return;
  }
  if (!action && method === "PATCH") {
    requireChannelWritable(context);
    if (message.authorId !== context.user.id || message.kind === "system") throw new HttpError(403, "Only the author can edit a message");
    if (message.deletedAt) throw new HttpError(409, "Message was deleted");
    const input = await readJsonBody(req, config.maxBodyBytes);
    const body = messageBodyInput(input.body);
    enforceDlp(config, { text: body, previous: message.body, actorId: context.user.id, resourceType: "chat_message", resourceId: message.id, ...(context.channel.siteId ? { siteId: context.channel.siteId } : {}) });
    const agent = message.agentId ? config.platform.readAgent(message.agentId) : undefined;
    const previous = new Set(extractMentions(message.body));
    const mentions = resolveMentions(config, context.channel, body, context.user, agent);
    const edited = config.chat.editMessage(message.id, body, config.now().toISOString(), mentions, context.user.id)!;
    notifyMentions(config, context, edited, mentions.filter((mention) => !previous.has(mention.id)), agent);
    sendJson(res, 200, messagesResponse(config, context.channel, [edited], names)[0]);
    return;
  }
  if (!action && method === "DELETE") {
    requireChannelWritable(context);
    if (message.authorId !== context.user.id && !context.canManage) throw new HttpError(403, "Only the author or a channel admin can delete a message");
    const deleted = config.chat.deleteMessage(message.id, config.now().toISOString(), context.user.id)!;
    if (message.authorId !== context.user.id && context.site) {
      recordActivity(config, context.user, "chat.message_moderated", "site", context.site.id, { channelId: context.channel.id, messageId: message.id, authorId: message.authorId });
    }
    sendJson(res, 200, messagesResponse(config, context.channel, [deleted], names)[0]);
    return;
  }
  if (action === "reactions") {
    requireCanPost(context);
    if (message.deletedAt) throw new HttpError(409, "Message was deleted");
    if (method === "POST") {
      const input = await readJsonBody(req, config.maxBodyBytes);
      const emoji = emojiInput(input.emoji);
      if (config.chat.countReactions(message.id) >= MAX_REACTIONS_PER_MESSAGE) throw new HttpError(409, "This message has too many reactions");
      config.chat.addReaction(message.id, context.user.id, emoji, config.now().toISOString());
    } else if (method === "DELETE" && actionId) {
      config.chat.removeReaction(message.id, context.user.id, emojiInput(decodeURIComponent(actionId)));
    } else throw new HttpError(405, "Method not allowed");
    sendJson(res, 200, messagesResponse(config, context.channel, [config.chat.readMessage(message.id)!], names)[0]);
    return;
  }
  if (action === "issue" && method === "POST") {
    requireCanPost(context);
    const input = await readJsonBody(req, config.maxBodyBytes);
    sendJson(res, 201, messageToIssue(config, principal, context, message, input));
    return;
  }
  if (action === "page" && method === "POST") {
    requireCanPost(context);
    const input = await readJsonBody(req, config.maxBodyBytes);
    sendJson(res, 201, await threadToPage(config, principal, context, message, input));
    return;
  }
  throw new HttpError(404, "Unknown message route");
}

function postMessage(config: CloudServerConfig, context: ChannelContext, input: { body: string; threadId?: string; fileIds?: string[] }, agent?: CloudAgentIdentity): ChatMessage {
  if (agent) {
    requireChannelWritable(context);
    if (!agentChannelAccess(config, agent.id, context.channel)) throw new HttpError(403, "The agent cannot chat in this channel");
  } else requireCanPost(context);
  const files = agent ? [] : shareableFiles(config, context, input.fileIds ?? []);
  const body = files.length > 0 && !input.body.trim() ? files.map((file) => file.filename).join(", ") : messageBodyInput(input.body);
  enforceDlp(config, { text: body, actorId: context.user.id, resourceType: "chat_channel", resourceId: context.channel.id, ...(context.channel.siteId ? { siteId: context.channel.siteId } : {}) });
  const threadId = input.threadId ? threadRootInput(config, context.channel, input.threadId) : undefined;
  const now = config.now().toISOString();
  if (!agent && !context.member) context.member = joinChannel(config, context);
  const mentions = resolveMentions(config, context.channel, body, context.user, agent);
  const message = config.chat.postMessage(
    {
      id: randomId(),
      channelId: context.channel.id,
      ...(threadId ? { threadId } : {}),
      kind: "message",
      authorId: context.user.id,
      ...(agent ? { agentId: agent.id } : {}),
      body,
      links: files.length ? { fileIds: files.map((file) => file.id) } : {},
      createdAt: now,
    },
    mentions,
  );
  if (files.length) config.chat.attachFiles(message.id, files.map((file) => file.id));
  if (!agent) config.chat.markRead(context.channel.id, context.user.id, message.seq);
  notifyMentions(config, context, message, mentions, agent);
  if (context.channel.kind === "dm") notifyDmMembers(config, context, message, mentions);
  enqueueSlackOutbound(config, context.channel, message);
  return message;
}

/** Files the poster uploaded to this channel and has not shared yet. */
function shareableFiles(config: CloudServerConfig, context: ChannelContext, fileIds: unknown[]): ChatFile[] {
  const ids = [...new Set(fileIds.filter((id): id is string => typeof id === "string"))];
  if (ids.length > MAX_FILES_PER_MESSAGE) throw new HttpError(400, `At most ${MAX_FILES_PER_MESSAGE} files per message`);
  const files = config.chat.listFiles(ids);
  if (files.length !== ids.length || files.some((file) => file.channelId !== context.channel.id || file.uploadedBy !== context.user.id || file.messageId)) {
    throw new HttpError(400, "fileIds must be your own unshared uploads to this channel");
  }
  return files;
}

/** Tells the other members of a DM about a new message, once per unread stretch. */
function notifyDmMembers(config: CloudServerConfig, context: ChannelContext, message: ChatMessage, mentions: Array<{ id: string }>): void {
  const mentioned = new Set(mentions.map((mention) => mention.id));
  const excerpt = message.body.replace(/@\{[A-Za-z0-9_-]+\}/g, (match) => `@${nameResolver(config)(match.slice(2, -1), false)}`).slice(0, 240);
  for (const member of config.chat.listMembers(context.channel.id)) {
    if (member.memberId === context.user.id || member.memberType !== "user" || mentioned.has(member.memberId)) continue;
    if (member.lastReadSeq < message.seq - 1) continue;
    writeNotification(config, member.memberId, "mention", `${context.user.name} sent you a message`, excerpt);
  }
}

function systemMessage(config: CloudServerConfig, channel: ChatChannel, actor: CloudUserRecord, text: string, threadId?: string, links: ChatMessage["links"] = {}): ChatMessage {
  return config.chat.postMessage({ id: randomId(), channelId: channel.id, ...(threadId ? { threadId } : {}), kind: "system" satisfies ChatMessageKind, authorId: actor.id, body: text.slice(0, CHAT_MESSAGE_MAX), links, createdAt: config.now().toISOString() });
}

/**
 * People mentioned in `body` who can read the channel, plus — for human posts only — agents that
 * can chat there. The author and the posting agent are skipped.
 */
function resolveMentions(config: CloudServerConfig, channel: ChatChannel, body: string, author: CloudUserRecord, agent?: CloudAgentIdentity): Array<{ id: string; isAgent: boolean }> {
  return extractMentions(body)
    .slice(0, 50)
    .flatMap((id): Array<{ id: string; isAgent: boolean }> => {
      if (id === author.id || id === agent?.id) return [];
      if (config.store.readUser(id)) return canUserReadChannel(config, id, channel) ? [{ id, isAgent: false }] : [];
      if (agent) return [];
      return agentChannelAccess(config, id, channel) ? [{ id, isAgent: true }] : [];
    });
}

function canUserReadChannel(config: CloudServerConfig, userId: string, channel: ChatChannel): boolean {
  if (channel.kind === "dm") return Boolean(config.chat.readMember(channel.id, userId));
  if (!config.store.resourceAccess(userId, "site", channel.siteId)) return false;
  return channel.visibility === "public" || Boolean(config.chat.readMember(channel.id, userId));
}

function notifyMentions(config: CloudServerConfig, context: ChannelContext, message: ChatMessage, mentions: Array<{ id: string; isAgent: boolean }>, agent?: CloudAgentIdentity): void {
  const speaker = agent?.name ?? context.user.name;
  const excerpt = message.body.replace(/@\{[A-Za-z0-9_-]+\}/g, (match) => `@${nameResolver(config)(match.slice(2, -1), false)}`).slice(0, 240);
  const where = context.channel.kind === "dm" ? "a direct message" : `#${context.channel.name}`;
  const resource = context.site ? (["site", context.site.id] as const) : ([undefined, undefined] as const);
  for (const mention of mentions) {
    if (!mention.isAgent) {
      writeNotification(config, mention.id, "mention", `${speaker} mentioned you in ${where}`, excerpt, resource[0], resource[1]);
      continue;
    }
    const mentioned = config.platform.readAgent(mention.id);
    if (!mentioned) continue;
    if (!agent) enqueueMention(config, mentioned.id, context.channel, message);
    if (mentioned.createdBy === context.user.id) continue;
    writeNotification(config, mentioned.createdBy, "task_assigned", `${mentioned.name} was asked in #${context.channel.name}`, `${speaker}: ${excerpt}`, "site", context.channel.siteId);
  }
}

function threadRootInput(config: CloudServerConfig, channel: ChatChannel, threadId: string): string {
  const root = config.chat.readMessage(threadId);
  if (!root || root.channelId !== channel.id) throw new HttpError(400, "threadId must be a message in this channel");
  return root.threadId ?? root.id;
}

function messageBodyInput(value: unknown): string {
  if (typeof value !== "string") throw new HttpError(400, "body is required");
  const body = value.replace(/\r\n?/g, "\n").trim();
  if (!body) throw new HttpError(400, "body must not be empty");
  if (body.length > CHAT_MESSAGE_MAX) throw new HttpError(413, `Messages are limited to ${CHAT_MESSAGE_MAX} characters`);
  return body;
}

function emojiInput(value: unknown): string {
  if (typeof value !== "string") throw new HttpError(400, "emoji is required");
  const emoji = value.trim();
  if (!emoji || emoji.length > 32 || /\s/.test(emoji)) throw new HttpError(400, "emoji must be a single short token");
  return emoji;
}

function requireChannelWritable(context: ChannelContext): void {
  if (context.site) requireSpaceWritable(context.site);
  if (context.channel.archivedAt) throw new HttpError(409, "Channel is archived");
}

function requireCanPost(context: ChannelContext): void {
  requireChannelWritable(context);
  if (context.channel.visibility === "private" && !context.member) throw new HttpError(403, "Only members can post in a private channel");
}

// chat → work

function messageToIssue(config: CloudServerConfig, principal: Principal, context: ChannelContext, message: ChatMessage, input: Record<string, unknown>): Record<string, unknown> {
  const site = requireSpace(context);
  if (message.deletedAt || message.kind === "system") throw new HttpError(409, "Only live messages can become issues");
  const projectId = optionalString(input.projectId) ?? context.channel.projectId;
  if (!projectId) throw new HttpError(400, "projectId is required for channels without a project");
  const project = config.store.readProject(projectId);
  if (!project || project.siteId !== site.id) throw new HttpError(400, "projectId must be a project in this space");
  requireProjectAccess(config, project, principal, "editor");
  const plain = displayBody(config, message.body);
  const now = config.now().toISOString();
  const issue: CloudIssue = config.store.createIssue(
    {
      id: uniqueId(config),
      projectId: project.id,
      summary: (optionalString(input.summary) ?? (plain.split("\n").find((line) => line.trim()) ?? plain)).trim().slice(0, 240),
      description: `${plain}\n\nFrom #${context.channel.name} (message ${message.id}).`.slice(0, 20_000),
      type: issueTypeInput(input.type),
      status: "backlog",
      priority: issuePriorityInput(input.priority),
      reporterId: context.user.id,
      labels: ["chat"],
      createdAt: now,
      updatedAt: now,
    },
    project.key,
  );
  recordIssueEvent(config, context.user, issue.id, "issue.created", { status: issue.status, source: "chat", channelId: context.channel.id, messageId: message.id });
  config.chat.addMessageLinks(message.id, { issueIds: [issue.id] });
  systemMessage(config, context.channel, context.user, `created ${issue.key}: ${issue.summary}`, message.threadId ?? message.id, { issueIds: [issue.id] });
  const names = nameResolver(config);
  return { issue, message: messagesResponse(config, context.channel, [config.chat.readMessage(message.id)!], names)[0] };
}

async function threadToPage(config: CloudServerConfig, principal: Principal, context: ChannelContext, message: ChatMessage, input: Record<string, unknown>): Promise<Record<string, unknown>> {
  const site = requireSpace(context);
  const access = requireRecordAccess(config, site, principal, "editor");
  const rootId = message.threadId ?? message.id;
  const root = config.chat.readMessage(rootId);
  if (!root) throw new HttpError(404, "Thread not found");
  const replies = threadReplies(config, context.channel.id, rootId).filter((item) => item.kind === "message");
  const names = nameResolver(config);
  const turns = [root, ...replies].filter((item) => !item.deletedAt);
  const firstLine = displayBody(config, root.body).split("\n").find((line) => line.trim()) ?? `#${context.channel.name} thread`;
  const title = (optionalString(input.title) ?? firstLine).trim().slice(0, 160);
  const now = config.now().toISOString();
  const source = chatThreadToNoma({
    title,
    channel: context.channel.name,
    space: site.title,
    capturedAt: now,
    capturedBy: context.user.name,
    messages: turns.map((turn) => ({
      id: turn.id,
      author: names(turn.authorId, false),
      ...(turn.agentId ? { agent: names(turn.agentId, true) } : {}),
      at: turn.createdAt,
      body: displayBody(config, turn.body),
    })),
  });
  const document = await createDocument(config, { title, source }, context.user, site.title, site.id, true);
  await attachPageToSite(config, await readSite(config, site.id), document.id, optionalCloudId(input.parentId, "Parent document"), access);
  afterDocumentSaved(config, undefined, document, { user: context.user, name: context.user.name });
  config.chat.addMessageLinks(root.id, { documentIds: [document.id] });
  systemMessage(config, context.channel, context.user, `saved this thread as the page “${document.title}”`, root.id, { documentIds: [document.id] });
  recordActivity(config, context.user, "chat.thread_captured", "site", site.id, { channelId: context.channel.id, messageId: root.id, documentId: document.id });
  return {
    document: documentResponse(document, requireRecordAccess(config, document, principal, "viewer"), config),
    message: messagesResponse(config, context.channel, [config.chat.readMessage(root.id)!], names)[0],
  };
}

/** Every reply in a thread, oldest first; refuses threads too long to capture in one page. */
function threadReplies(config: CloudServerConfig, channelId: string, rootId: string): ChatMessage[] {
  const replies: ChatMessage[] = [];
  for (let after = 0; ; ) {
    const page = config.chat.listMessages(channelId, { threadId: rootId, after, limit: 200 });
    replies.push(...page);
    if (page.length < 200) return replies;
    if (replies.length >= MAX_CAPTURED_REPLIES) throw new HttpError(413, `Threads over ${MAX_CAPTURED_REPLIES} replies are too long to capture as one page`);
    after = page[page.length - 1]!.seq;
  }
}

function issueTypeInput(value: unknown): CloudIssueType {
  if (value === undefined || value === null || value === "") return "task";
  if (value === "task" || value === "story" || value === "bug" || value === "epic") return value;
  throw new HttpError(400, "type must be task, story, bug, or epic");
}

function issuePriorityInput(value: unknown): CloudIssuePriority {
  if (value === undefined || value === null || value === "") return "medium";
  if (value === "lowest" || value === "low" || value === "medium" || value === "high" || value === "highest") return value;
  throw new HttpError(400, "priority must be lowest, low, medium, high, or highest");
}

// files

async function uploadChatFile(req: IncomingMessage, res: ServerResponse, config: CloudServerConfig, context: ChannelContext): Promise<Record<string, unknown>> {
  requireCanPost(context);
  const staged = await stageUpload(req, res, config);
  try {
    const used = context.site ? spaceStorageBytes(config, context.site.id) : personalStorageBytes(config, context.user.id);
    if (used + staged.size > config.attachmentQuotaBytes) {
      throw new HttpError(413, "Attachment storage quota exceeded", { code: "attachment_quota_exceeded", scope: context.site ? "site" : "user", usedBytes: used, quotaBytes: config.attachmentQuotaBytes });
    }
    await staged.commit();
  } catch (error) {
    await staged.discard();
    throw error;
  }
  let file: ChatFile;
  try {
    file = config.chat.insertFile({
      id: attachmentIdFor(config),
      channelId: context.channel.id,
      sha256: staged.sha256,
      filename: staged.filename,
      contentType: staged.contentType,
      size: staged.size,
      uploadedBy: context.user.id,
      createdAt: config.now().toISOString(),
    });
  } catch (error) {
    await collectAttachmentGarbage(config, [staged.sha256]);
    throw error;
  }
  return fileResponse(file);
}

function fileResponse(file: ChatFile): Record<string, unknown> {
  return {
    id: file.id,
    filename: file.filename,
    contentType: file.contentType,
    size: file.size,
    image: isImageAttachment(file),
    url: `/api/channels/${file.channelId}/files/${file.id}`,
    uploadedBy: file.uploadedBy,
    createdAt: file.createdAt,
  };
}

// compliance

function exportWindow(url: URL): { since?: string; until?: string } {
  const since = url.searchParams.get("since");
  const until = url.searchParams.get("until");
  for (const [label, value] of [["since", since], ["until", until]] as const) {
    if (value && Number.isNaN(Date.parse(value))) throw new HttpError(400, `${label} must be an ISO date`);
  }
  return { ...(since ? { since: new Date(since).toISOString() } : {}), ...(until ? { until: new Date(until).toISOString() } : {}) };
}

/**
 * eDiscovery bundle for one channel: every message in the window with deleted ones, their previous
 * bodies, reactions, mentions and file metadata, plus a SHA-256 digest of the message list.
 */
export function channelExport(
  config: CloudServerConfig,
  channel: ChatChannel,
  window: { since?: string; until?: string },
  exporter: CloudUserRecord,
  involving?: string,
): { format: string; channel: Record<string, unknown>; exportedAt: string; exportedBy: string; messages: Array<Record<string, unknown>>; digest: string } {
  const all = config.chat.exportMessages(channel.id, window);
  const mentions = config.chat.listMessageMentions(all.map((message) => message.id));
  const messages = involving ? all.filter((message) => message.authorId === involving || (mentions.get(message.id) ?? []).includes(involving)) : all;
  const ids = messages.map((message) => message.id);
  const revisions = config.chat.listRevisions(ids);
  const reactions = config.chat.listReactions(ids);
  const files = new Map(config.chat.listFiles(messages.flatMap((message) => message.links.fileIds ?? [])).map((file) => [file.id, file]));
  const rows = messages.map((message) => ({
    id: message.id,
    seq: message.seq,
    ...(message.threadId ? { threadId: message.threadId } : {}),
    kind: message.kind,
    authorId: message.authorId,
    ...(message.agentId ? { agentId: message.agentId } : {}),
    body: message.body,
    createdAt: message.createdAt,
    ...(message.editedAt ? { editedAt: message.editedAt } : {}),
    ...(message.deletedAt ? { deletedAt: message.deletedAt } : {}),
    revisions: revisions.get(message.id) ?? [],
    reactions: reactions.get(message.id) ?? [],
    mentions: mentions.get(message.id) ?? [],
    files: (message.links.fileIds ?? []).flatMap((id) => {
      const file = files.get(id);
      return file ? [{ id: file.id, filename: file.filename, contentType: file.contentType, size: file.size, sha256: file.sha256 }] : [];
    }),
  }));
  return {
    format: "noma-chat-export-v1",
    channel: { id: channel.id, kind: channel.kind, name: channel.name, siteId: channel.siteId, visibility: channel.visibility, members: config.chat.listMembers(channel.id).map((member) => member.memberId) },
    exportedAt: config.now().toISOString(),
    exportedBy: exporter.id,
    messages: rows,
    digest: sha256Hex(JSON.stringify(rows)),
  };
}

function channelTranscriptNoma(config: CloudServerConfig, channel: ChatChannel, rows: Array<Record<string, unknown>>): string {
  const names = nameResolver(config);
  return chatChannelToNoma({
    channel: channel.kind === "dm" ? `dm-${channel.id}` : channel.name,
    ...(channel.topic ? { topic: channel.topic } : {}),
    exportedAt: config.now().toISOString(),
    messages: rows
      .filter((row) => row.kind === "message")
      .map((row) => ({
        id: String(row.id),
        author: names(String(row.authorId), false),
        ...(row.agentId ? { agent: names(String(row.agentId), true) } : {}),
        at: String(row.createdAt),
        body: displayBody(config, String(row.body)),
        ...(row.threadId ? { thread: String(row.threadId) } : {}),
      })),
  });
}

/**
 * Public channels of a space as `.noma` transcripts for the space export. Private channels and
 * direct messages stay out: an export is readable by anyone who can view the space.
 */
export function spaceChatTranscripts(config: CloudServerConfig, siteId: string): Array<{ id: string; name: string; path: string; messages: number; source: string }> {
  return config.chat
    .listChannels([siteId], { includeArchived: true })
    .filter((channel) => channel.visibility === "public")
    .map((channel) => {
      const rows = config.chat.exportMessages(channel.id).filter((message) => !message.deletedAt).map((message) => ({ ...message }) as unknown as Record<string, unknown>);
      return { id: channel.id, name: channel.name, path: `chat/${channel.name}.noma`, messages: rows.length, source: channelTranscriptNoma(config, channel, rows) };
    });
}

/**
 * Applies chat retention: messages older than `retentionDays` are removed unless their space,
 * channel or author is under legal hold. Returns counts and garbage-collects freed blobs.
 */
export async function enforceChatRetention(config: CloudServerConfig, retentionDays: number, actorId: string): Promise<Record<string, number>> {
  const now = config.now();
  const cutoff = new Date(now.getTime() - retentionDays * 86_400_000).toISOString();
  const holds = config.platform.listLegalHolds().filter((hold) => !hold.releasedAt);
  const heldSites = new Set(holds.filter((hold) => hold.resourceType === "site").map((hold) => hold.resourceId));
  const heldUsers = new Set(holds.filter((hold) => hold.resourceType === "user").map((hold) => hold.resourceId));
  const heldChannels = new Set(holds.filter((hold) => hold.resourceType === "chat_channel").map((hold) => hold.resourceId));
  const result = config.chat.purgeBefore(
    cutoff,
    (channel) => heldChannels.has(channel.id) || (channel.siteId !== "" && heldSites.has(channel.siteId)),
    (authorId) => heldUsers.has(authorId),
  );
  const blobsRemoved = await collectAttachmentGarbage(config, result.fileHashes);
  const summary = { deletedMessages: result.deletedMessages, blankedRoots: result.blankedRoots, protectedMessages: result.protectedMessages, deletedFiles: result.deletedFiles, blobsRemoved };
  config.platform.recordAudit(actorId, "chat.retention_enforced", "workspace", "workspace", { ...summary, retentionDays, cutoff }, now.toISOString());
  return summary;
}

// realtime

/**
 * `GET /api/channels/:id/stream` — Server-Sent Events. Each `chat` event is a light notice
 * (`{type, seq, messageId, threadId}`); clients fetch the content through the regular, access-checked
 * message endpoints. Access is re-checked on every event and heartbeat, and the stream ends when it lapses.
 */
function streamChannel(req: IncomingMessage, res: ServerResponse, config: CloudServerConfig, principal: Principal, context: ChannelContext): void {
  let closed = false;
  const end = (): void => {
    if (closed) return;
    closed = true;
    unsubscribe?.();
    untrack?.();
    if (heartbeat) clearInterval(heartbeat);
    res.end();
  };
  const untrack = config.chat.trackStream(context.user.id, end, MAX_STREAMS_PER_USER);
  if (!untrack) throw new HttpError(429, `At most ${MAX_STREAMS_PER_USER} live chat streams per user`);
  res.writeHead(200, {
    "content-type": "text/event-stream; charset=utf-8",
    "cache-control": "no-cache, no-transform",
    connection: "keep-alive",
    "x-accel-buffering": "no",
  });
  res.write(`retry: 3000\nevent: ready\ndata: ${JSON.stringify({ channelId: context.channel.id, lastSeq: context.channel.lastSeq })}\n\n`);
  const stillAllowed = (): boolean => {
    try {
      const channel = config.chat.readChannel(context.channel.id);
      if (channel?.kind === "dm") return Boolean(config.chat.readMember(channel.id, context.user.id));
      const site = channel && config.store.readSite(channel.siteId);
      if (!channel || !site || config.store.isTrashed("site", site.id) || !hasUserAccess(config, site, principal)) return false;
      return channel.visibility === "public" || Boolean(config.chat.readMember(channel.id, context.user.id));
    } catch {
      return false;
    }
  };
  const unsubscribe: (() => void) | undefined = config.chat.subscribe(context.channel.id, (event) => {
    if (!stillAllowed()) return end();
    res.write(`event: chat\ndata: ${JSON.stringify(event)}\n\n`);
  });
  const heartbeat: ReturnType<typeof setInterval> | undefined = setInterval(() => {
    if (!stillAllowed()) return end();
    res.write(": ping\n\n");
  }, STREAM_HEARTBEAT_MS);
  heartbeat.unref();
  req.on("close", end);
  res.on("close", end);
}

// responses

type NameResolver = (id: string, agent: boolean) => string;

function nameResolver(config: CloudServerConfig): NameResolver {
  const cache = new Map<string, string>();
  return (id, agent) => {
    const key = `${agent ? "a" : "u"}:${id}`;
    const cached = cache.get(key);
    if (cached !== undefined) return cached;
    const name = (agent ? config.platform.readAgent(id)?.name : config.store.readUser(id)?.name) ?? config.platform.readAgent(id)?.name ?? id;
    cache.set(key, name);
    return name;
  };
}

/** Message body with `@{id}` mentions replaced by `@Name`, for issue descriptions and transcripts. */
function displayBody(config: CloudServerConfig, body: string): string {
  const names = nameResolver(config);
  return body.replace(/@\{([A-Za-z0-9_-]{8,80})\}/g, (_match, id: string) => `@${names(id, false)}`);
}

function messagesResponse(config: CloudServerConfig, channel: ChatChannel, messages: ChatMessage[], names: NameResolver): Array<Record<string, unknown>> {
  const ids = messages.map((message) => message.id);
  const reactions = config.chat.listReactions(ids);
  const mentions = config.chat.listMessageMentions(ids);
  return messages.map((message) => ({
    ...messageResponse(config, message, names),
    reactions: reactions.get(message.id) ?? [],
    mentions: (mentions.get(message.id) ?? []).map((id) => ({ id, name: names(id, !config.store.readUser(id)), ...(config.store.readUser(id) ? {} : { agent: true }) })),
    refs: message.deletedAt ? [] : issueRefs(config, channel, message.body),
  }));
}

function messageResponse(config: CloudServerConfig, message: ChatMessage, names: NameResolver): Record<string, unknown> {
  return {
    ...message,
    authorName: names(message.authorId, false),
    ...(message.agentId ? { agent: { id: message.agentId, name: names(message.agentId, true) } } : {}),
    links: {
      issues: (message.links.issueIds ?? []).flatMap((id) => {
        const issue = config.store.readIssue(id);
        return issue ? [{ id: issue.id, key: issue.key, summary: issue.summary, status: issue.status }] : [];
      }),
      documents: (message.links.documentIds ?? []).flatMap((id) => {
        const document = config.store.readDocument(id);
        return document && !config.store.isTrashed("document", id) ? [{ id: document.id, title: document.title }] : [];
      }),
      files: config.chat.listFiles(message.deletedAt ? [] : message.links.fileIds ?? []).map(fileResponse),
    },
  };
}

/** Issue keys (`NOMA-12`) in the body that resolve to projects in the channel's space. */
function issueRefs(config: CloudServerConfig, channel: ChatChannel, body: string): Array<{ id: string; key: string; summary: string; status: string }> {
  const keys = [...new Set(body.match(ISSUE_KEY_RE) ?? [])].slice(0, 10);
  return keys.flatMap((key) => {
    const issue = config.store.readIssue(key);
    if (!issue) return [];
    const project = config.store.readProject(issue.projectId);
    return project && project.siteId === channel.siteId ? [{ id: issue.id, key: issue.key, summary: issue.summary, status: issue.status }] : [];
  });
}

/** `GET|PUT|DELETE /api/channels/:id/bridge` — link a channel to a Slack channel (channel admins; needs the Slack app configured). */
async function routeBridge(req: IncomingMessage, res: ServerResponse, config: CloudServerConfig, context: ChannelContext): Promise<void> {
  const method = req.method ?? "GET";
  requireSpace(context);
  if (method === "GET") {
    sendJson(res, 200, { configured: Boolean(config.slack), bridge: config.integrations.readBridge(context.channel.id) ?? null });
    return;
  }
  if (!context.canManage) throw new HttpError(403, "Channel admin access is required");
  if (method === "DELETE") {
    if (!config.integrations.deleteBridge(context.channel.id)) throw new HttpError(404, "This channel is not bridged");
    config.platform.recordAudit(context.user.id, "chat.bridge_removed", "site", context.channel.siteId, { channelId: context.channel.id }, config.now().toISOString());
    sendJson(res, 200, { removed: true });
    return;
  }
  if (method !== "PUT") throw new HttpError(405, "Method not allowed");
  if (!config.slack) throw new HttpError(409, "Set NOMA_CLOUD_SLACK_BOT_TOKEN and NOMA_CLOUD_SLACK_SIGNING_SECRET to bridge channels", { code: "slack_not_configured" });
  const input = await readJsonBody(req, config.maxBodyBytes);
  const slackChannelId = stringInput(input, "slackChannelId");
  if (!/^[CG][A-Z0-9]{6,20}$/.test(slackChannelId)) throw new HttpError(400, "slackChannelId must be a Slack channel ID such as C0123ABCD");
  const linked = config.integrations.bridgeForSlackChannel(slackChannelId);
  if (linked && linked.channelId !== context.channel.id) throw new HttpError(409, "That Slack channel is already bridged to another Noma channel");
  const now = config.now().toISOString();
  const current = config.integrations.readBridge(context.channel.id);
  const bridge = config.integrations.writeBridge({ channelId: context.channel.id, slackChannelId, enabled: input.enabled !== false, createdBy: current?.createdBy ?? context.user.id, createdAt: current?.createdAt ?? now, updatedAt: now });
  config.platform.recordAudit(context.user.id, "chat.bridge_linked", "site", context.channel.siteId, { channelId: context.channel.id, slackChannelId }, now);
  systemMessage(config, context.channel, context.user, `bridged this channel with Slack (${slackChannelId})`);
  sendJson(res, 200, { configured: true, bridge });
}
