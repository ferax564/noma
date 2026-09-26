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
import type { IncomingMessage, ServerResponse } from "node:http";
import type { ChatChannel, ChatChannelVisibility, ChatMember, ChatMessage, ChatMessageKind } from "../cloud-chat.js";
import type { CloudIssue, CloudIssuePriority, CloudIssueType, CloudSiteRecord, CloudUserRecord } from "../cloud-db.js";
import type { CloudAgentIdentity } from "../cloud-platform.js";
import { chatThreadToNoma, CHAT_MESSAGE_MAX, channelNameInput } from "./chat.js";
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
import { HttpError, readJsonBody, sendJson } from "./http.js";
import { boundedInteger, numberQuery, optionalCloudId, optionalString, stringInput, stringPathPart } from "./input.js";
import { extractMentions } from "./mentions.js";
import { afterDocumentSaved } from "./page-hooks.js";
import { createDocument, documentResponse } from "./records.js";
import { ownedAgent } from "./routes-knowledge.js";
import { attachPageToSite } from "./routes-sites.js";
import { requestUrl } from "./security.js";
import { requireSpaceWritable } from "./spaces.js";

/** The capability an agent needs to read and post in channels. */
export const AGENT_CHAT_CAPABILITY = "chat";

const TOPIC_MAX = 500;
const MAX_REACTIONS_PER_MESSAGE = 50;
const STREAM_HEARTBEAT_MS = 25_000;
const MAX_STREAMS_PER_USER = 20;
const ISSUE_KEY_RE = /\b[A-Z][A-Z0-9]{1,9}-\d{1,7}\b/g;

interface ChannelContext {
  channel: ChatChannel;
  site: CloudSiteRecord;
  access: AccessContext;
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
  throw new HttpError(404, "Unknown channel route");
}

/** `GET /api/chat/search?q=…[&siteId=…]` — messages across every channel the caller can read. */
export async function routeChat(req: IncomingMessage, res: ServerResponse, url: URL, parts: string[], config: CloudServerConfig, principal: Principal): Promise<void> {
  const user = requireUser(principal);
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
    recordActivity(config, user, "chat.agent_posted", "site", channel.siteId, { channelId: channel.id, messageId: message.id, agentId: agent.id, transport: "mcp" });
    return { message: messageResponse(config, message, nameResolver(config)) };
  }
  throw new HttpError(400, `Unknown gateway tool: ${name}`);
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
  if (!context.canManage) throw new HttpError(403, "Channel admin access is required");
  const archiving = input.archived === true || input.archived === false;
  requireSpaceWritable(context.site);
  if (context.channel.archivedAt && !archiving) throw new HttpError(409, "Channel is archived");
  const name = input.name === undefined ? undefined : channelNameInput(input.name);
  if (name && name !== context.channel.name && config.chat.readChannelByName(context.channel.siteId, name)) throw new HttpError(409, `#${name} already exists in this space`);
  const projectId = input.projectId === undefined ? undefined : input.projectId === null ? null : channelProjectInput(config, context.principal, context.site, input.projectId) ?? null;
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
  return {
    ...channelSummary(context.channel),
    ...(project ? { project: { id: project.id, key: project.key, name: project.name } } : {}),
    space: { id: context.site.id, title: context.site.title },
    joined: Boolean(context.member),
    ...(context.member ? { lastReadSeq: context.member.lastReadSeq, memberRole: context.member.role } : {}),
    access: { role: context.access.role, canManage: context.canManage, canPost: !context.channel.archivedAt && !context.site.archivedAt && (context.channel.visibility === "public" || Boolean(context.member)) },
    members: config.chat.listMembers(context.channel.id).map((member) => ({ id: member.memberId, name: names(member.memberId, member.memberType === "agent"), type: member.memberType, role: member.role })),
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
    requireSpaceWritable(context.site);
    const input = await readJsonBody(req, config.maxBodyBytes);
    const added = addChannelMember(config, context.channel, context.site, stringInput(input, "memberId"), config.now().toISOString());
    if (!added) throw new HttpError(400, "memberId must be a person with access to this space, or an agent with a chat grant on it");
    systemMessage(config, context.channel, context.user, `added ${nameResolver(config)(added.memberId, added.memberType === "agent")}`);
    sendJson(res, 201, { id: added.memberId, type: added.memberType, role: added.role });
    return;
  }
  if (memberId && method === "DELETE") {
    if (memberId !== context.user.id && !context.canManage) throw new HttpError(403, "Channel admin access is required");
    if (!config.chat.removeMember(context.channel.id, memberId)) throw new HttpError(404, "Member not found");
    sendJson(res, 200, { removed: memberId });
    return;
  }
  throw new HttpError(405, "Method not allowed");
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
    const agent = agentId ? ownedAgent(config, context.user, agentId) : undefined;
    if (agent && !agentChannelAccess(config, agent.id, context.channel)) throw new HttpError(403, "The agent cannot chat in this channel");
    const threadId = optionalString(input.threadId);
    const message = postMessage(config, context, { body: stringInput(input, "body"), ...(threadId ? { threadId } : {}) }, agent);
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
    const agent = message.agentId ? config.platform.readAgent(message.agentId) : undefined;
    const previous = new Set(extractMentions(message.body));
    const mentions = resolveMentions(config, context.channel, body, context.user, agent).filter((mention) => !previous.has(mention.id));
    const edited = config.chat.editMessage(message.id, body, config.now().toISOString(), mentions)!;
    notifyMentions(config, context, edited, mentions, agent);
    sendJson(res, 200, messagesResponse(config, context.channel, [edited], names)[0]);
    return;
  }
  if (!action && method === "DELETE") {
    requireChannelWritable(context);
    if (message.authorId !== context.user.id && !context.canManage) throw new HttpError(403, "Only the author or a channel admin can delete a message");
    const deleted = config.chat.deleteMessage(message.id, config.now().toISOString())!;
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

function postMessage(config: CloudServerConfig, context: ChannelContext, input: { body: string; threadId?: string }, agent?: CloudAgentIdentity): ChatMessage {
  if (agent) {
    requireChannelWritable(context);
    if (!agentChannelAccess(config, agent.id, context.channel)) throw new HttpError(403, "The agent cannot chat in this channel");
  } else requireCanPost(context);
  const body = messageBodyInput(input.body);
  const threadId = input.threadId ? threadRootInput(config, context.channel, input.threadId) : undefined;
  const now = config.now().toISOString();
  if (!agent && !context.member) context.member = joinChannel(config, context);
  const mentions = resolveMentions(config, context.channel, body, context.user, agent);
  const message = config.chat.postMessage(
    { id: randomId(), channelId: context.channel.id, ...(threadId ? { threadId } : {}), kind: "message", authorId: context.user.id, ...(agent ? { agentId: agent.id } : {}), body, links: {}, createdAt: now },
    mentions,
  );
  if (!agent) config.chat.markRead(context.channel.id, context.user.id, message.seq);
  notifyMentions(config, context, message, mentions, agent);
  return message;
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
  if (!config.store.resourceAccess(userId, "site", channel.siteId)) return false;
  return channel.visibility === "public" || Boolean(config.chat.readMember(channel.id, userId));
}

function notifyMentions(config: CloudServerConfig, context: ChannelContext, message: ChatMessage, mentions: Array<{ id: string; isAgent: boolean }>, agent?: CloudAgentIdentity): void {
  const speaker = agent?.name ?? context.user.name;
  const excerpt = message.body.replace(/@\{[A-Za-z0-9_-]+\}/g, (match) => `@${nameResolver(config)(match.slice(2, -1), false)}`).slice(0, 240);
  for (const mention of mentions) {
    if (!mention.isAgent) {
      writeNotification(config, mention.id, "mention", `${speaker} mentioned you in #${context.channel.name}`, excerpt, "site", context.channel.siteId);
      continue;
    }
    const mentioned = config.platform.readAgent(mention.id);
    if (!mentioned || mentioned.createdBy === context.user.id) continue;
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
  requireSpaceWritable(context.site);
  if (context.channel.archivedAt) throw new HttpError(409, "Channel is archived");
}

function requireCanPost(context: ChannelContext): void {
  requireChannelWritable(context);
  if (context.channel.visibility === "private" && !context.member) throw new HttpError(403, "Only members can post in a private channel");
}

// chat → work

function messageToIssue(config: CloudServerConfig, principal: Principal, context: ChannelContext, message: ChatMessage, input: Record<string, unknown>): Record<string, unknown> {
  if (message.deletedAt || message.kind === "system") throw new HttpError(409, "Only live messages can become issues");
  const projectId = optionalString(input.projectId) ?? context.channel.projectId;
  if (!projectId) throw new HttpError(400, "projectId is required for channels without a project");
  const project = config.store.readProject(projectId);
  if (!project || project.siteId !== context.site.id) throw new HttpError(400, "projectId must be a project in this space");
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
  const access = requireRecordAccess(config, context.site, principal, "editor");
  const rootId = message.threadId ?? message.id;
  const root = config.chat.readMessage(rootId);
  if (!root) throw new HttpError(404, "Thread not found");
  const replies = config.chat.listMessages(context.channel.id, { threadId: rootId, limit: 200 }).filter((item) => item.kind === "message");
  const names = nameResolver(config);
  const turns = [root, ...replies].filter((item) => !item.deletedAt);
  const firstLine = displayBody(config, root.body).split("\n").find((line) => line.trim()) ?? `#${context.channel.name} thread`;
  const title = (optionalString(input.title) ?? firstLine).trim().slice(0, 160);
  const now = config.now().toISOString();
  const source = chatThreadToNoma({
    title,
    channel: context.channel.name,
    space: context.site.title,
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
  const document = await createDocument(config, { title, source }, context.user, context.site.title, context.site.id, true);
  await attachPageToSite(config, await readSite(config, context.site.id), document.id, optionalCloudId(input.parentId, "Parent document"), access);
  afterDocumentSaved(config, undefined, document, { user: context.user, name: context.user.name });
  config.chat.addMessageLinks(root.id, { documentIds: [document.id] });
  systemMessage(config, context.channel, context.user, `saved this thread as the page “${document.title}”`, root.id, { documentIds: [document.id] });
  recordActivity(config, context.user, "chat.thread_captured", "site", context.site.id, { channelId: context.channel.id, messageId: root.id, documentId: document.id });
  return {
    document: documentResponse(document, requireRecordAccess(config, document, principal, "viewer"), config),
    message: messagesResponse(config, context.channel, [config.chat.readMessage(root.id)!], names)[0],
  };
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
