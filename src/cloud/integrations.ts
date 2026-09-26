/**
 * Switching tools: Slack export → channels, Jira search JSON → Work, and a two-way Slack bridge for the
 * migration period. People are matched by email to members of the space; anyone unmatched is kept as a
 * name on the content, never invented as an account. Re-running an import updates nothing twice.
 */
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import type { ChatChannel, ChatMessage, CloudChatStore } from "../cloud-chat.js";
import type { CloudIssue, CloudIssueLinkType, CloudProject, CloudSiteRecord, CloudUserRecord } from "../cloud-db.js";
import type { CloudIntegrationsStore } from "../cloud-integrations.js";
import type { JiraIssue, JiraPerson } from "../jira-import.js";
import { markdownToSlackText, type SlackExport, slackEmoji, slackTextToMarkdown } from "../slack-import.js";
import { CHANNEL_NAME_MAX, channelNameInput, CHAT_MESSAGE_MAX } from "./chat.js";
import { type CloudServerConfig, randomId, recordActivity, recordIssueEvent, uniqueId } from "./context.js";
import { enforceDlp } from "./dlp.js";
import { HttpError } from "./http.js";

export interface SlackConfig {
  botToken: string;
  signingSecret: string;
  fetch?: typeof fetch;
  /** Defaults to https://slack.com/api */
  apiBase?: string;
}

// people

/** Space members by lower-cased email, for matching imported authors. */
function spaceMembersByEmail(config: CloudServerConfig, siteId: string): Map<string, CloudUserRecord> {
  const members = new Map<string, CloudUserRecord>();
  for (const user of config.store.listUsers()) {
    if (user.email && config.store.resourceAccess(user.id, "site", siteId)) members.set(user.email.toLowerCase(), user);
  }
  return members;
}

// Slack export

export interface SlackImportReport {
  channels: Array<{ id: string; name: string; slackName: string; created: boolean; messages: number }>;
  messages: number;
  threads: number;
  reactions: number;
  skipped: { alreadyImported: number; files: number; directMessages: number; groupMessages: number; blockedByDlp: number };
  matchedPeople: number;
  unmatchedPeople: string[];
}

export function importSlackExport(config: CloudServerConfig, importer: CloudUserRecord, site: CloudSiteRecord, data: SlackExport): SlackImportReport {
  const members = spaceMembersByEmail(config, site.id);
  const byslack = new Map<string, CloudUserRecord>();
  for (const [id, person] of data.users) {
    const match = person.email ? members.get(person.email) : undefined;
    if (match) byslack.set(id, match);
  }
  const unmatched = new Set<string>();
  const nameOf = (id: string) => data.users.get(id)?.name ?? id;
  const channelNames = new Map(data.channels.map((channel) => [channel.id, channel.name]));
  const mention = (id: string) => {
    const user = byslack.get(id);
    return user ? `@{${user.id}}` : `@${nameOf(id)}`;
  };
  const channelRef = (id: string, fallback?: string) => `#${channelNames.get(id) ?? fallback ?? id}`;
  const report: SlackImportReport = {
    channels: [],
    messages: 0,
    threads: 0,
    reactions: 0,
    skipped: { alreadyImported: 0, files: 0, directMessages: data.skipped.directMessages, groupMessages: data.skipped.groupMessages, blockedByDlp: 0 },
    matchedPeople: byslack.size,
    unmatchedPeople: [],
  };
  const now = config.now().toISOString();
  for (const source of data.channels) {
    const visibility = source.private ? "private" : "public";
    const { name, existing } = importTarget(config, site.id, importer.id, safeChannelName(source.name), visibility);
    const channel: ChatChannel =
      existing ??
      config.chat.createChannel({
            id: randomId(),
            kind: "channel",
            siteId: site.id,
            name,
            ...(source.topic || source.purpose ? { topic: (source.topic ?? source.purpose)!.slice(0, 250) } : {}),
            visibility,
            createdBy: importer.id,
            createdAt: now,
            updatedAt: now,
            ...(source.archived ? { archivedAt: now } : {}),
          });
    if (!config.chat.readMember(channel.id, importer.id)) config.chat.addMember({ channelId: channel.id, memberId: importer.id, memberType: "user", role: "admin", joinedAt: now });
    if (source.private) {
      for (const memberId of source.members) {
        const user = byslack.get(memberId);
        if (user && !config.chat.readMember(channel.id, user.id)) config.chat.addMember({ channelId: channel.id, memberId: user.id, memberType: "user", role: "member", joinedAt: now });
      }
    }
    const roots = new Map<string, string>();
    let count = 0;
    for (const message of source.messages) {
      const ledgerKey = `${site.id}:${source.id}:${message.ts}`;
      const existingId = config.integrations.ledger("slack", ledgerKey);
      if (existingId) {
        roots.set(message.ts, existingId);
        report.skipped.alreadyImported += 1;
        continue;
      }
      const author = message.user ? byslack.get(message.user) : undefined;
      if (message.user && !author) unmatched.add(nameOf(message.user));
      const body = slackTextToMarkdown(message.text, mention, channelRef);
      const files = message.files.map((file) => (file.url ? `📎 [${file.name}](${file.url})` : `📎 ${file.name}`));
      report.skipped.files += message.files.length;
      const speaker = author ? "" : `**${message.user ? nameOf(message.user) : message.botName ?? "Slack"}**${message.botName && !message.user ? " (bot)" : ""}: `;
      const text = [`${speaker}${body}`.trim(), ...files].filter(Boolean).join("\n").slice(0, CHAT_MESSAGE_MAX) || "(empty message)";
      try {
        enforceDlp(config, { text, actorId: importer.id, resourceType: "chat_channel", resourceId: channel.id, siteId: site.id });
      } catch (error) {
        if (error instanceof HttpError && error.status === 422) {
          report.skipped.blockedByDlp += 1;
          continue;
        }
        throw error;
      }
      const threadId = message.threadTs ? roots.get(message.threadTs) : undefined;
      const posted = config.chat.postMessage({
        id: stableId("slack", ledgerKey),
        channelId: channel.id,
        ...(threadId ? { threadId } : {}),
        kind: "message",
        authorId: (author ?? importer).id,
        body: text,
        links: {},
        createdAt: slackTime(message.ts),
      });
      config.integrations.recordImport("slack", ledgerKey, posted.id, now);
      roots.set(message.ts, posted.id);
      if (threadId) report.threads += 1;
      for (const reaction of message.reactions) {
        for (const reactor of reaction.users) {
          const user = byslack.get(reactor);
          if (!user) continue;
          config.chat.addReaction(posted.id, user.id, slackEmoji(reaction.name), posted.createdAt);
          report.reactions += 1;
        }
      }
      count += 1;
    }
    report.messages += count;
    report.channels.push({ id: channel.id, name: channel.name, slackName: source.name, created: !existing, messages: count });
  }
  report.unmatchedPeople = [...unmatched].sort().slice(0, 200);
  recordActivity(config, importer, "import.slack", "site", site.id, { channels: report.channels.length, messages: report.messages });
  config.platform.recordAudit(importer.id, "import.slack", "site", site.id, { channels: report.channels.length, messages: report.messages }, now);
  return report;
}

// Jira

export interface JiraImportReport {
  created: number;
  alreadyImported: number;
  comments: number;
  links: number;
  subtasks: number;
  matchedPeople: number;
  unmatchedPeople: string[];
  keys: Record<string, string>;
}

export function importJiraIssues(config: CloudServerConfig, importer: CloudUserRecord, project: CloudProject, issues: JiraIssue[]): JiraImportReport {
  const members = spaceMembersByEmail(config, project.siteId);
  const unmatched = new Set<string>();
  const matched = new Set<string>();
  const personId = (person: JiraPerson | undefined): string | undefined => {
    if (!person) return undefined;
    const user = person.email ? members.get(person.email) : undefined;
    if (user) matched.add(user.id);
    else unmatched.add(person.name);
    return user?.id;
  };
  const now = config.now().toISOString();
  const source = `jira:${project.id}`;
  const keys = new Map<string, string>();
  const report: JiraImportReport = { created: 0, alreadyImported: 0, comments: 0, links: 0, subtasks: 0, matchedPeople: 0, unmatchedPeople: [], keys: {} };
  const ordered = [...issues].sort((left, right) => Number(Boolean(left.parentKey)) - Number(Boolean(right.parentKey)));
  const pending: Array<{ item: JiraIssue; assigneeId?: string; reporterId?: string; description: string; comments: Array<{ body: string; authorId?: string; createdAt: string }> }> = [];
  for (const item of ordered) {
    const existing = config.integrations.ledger(source, item.key);
    if (existing && config.store.readIssue(existing)) {
      keys.set(item.key, existing);
      report.alreadyImported += 1;
      continue;
    }
    const assigneeId = personId(item.assignee);
    const reporterId = personId(item.reporter);
    const description = [item.description, `_Imported from Jira ${item.key}${item.reporter && !reporterId ? `, reported by ${item.reporter.name}` : ""}${item.assignee && !assigneeId ? `, assigned to ${item.assignee.name}` : ""}._`].filter(Boolean).join("\n\n").slice(0, 20_000);
    enforceDlp(config, { text: `${item.summary}\n${description}`, actorId: importer.id, resourceType: "issue", resourceId: project.id, siteId: project.siteId });
    const comments = item.comments.flatMap((comment) => {
      const authorId = personId(comment.author);
      const body = `${authorId ? "" : `**${comment.author.name}** (Jira): `}${comment.body}`.slice(0, 10_000);
      if (!body.trim()) return [];
      enforceDlp(config, { text: body, actorId: importer.id, resourceType: "issue", resourceId: project.id, siteId: project.siteId });
      return [{ body, ...(authorId ? { authorId } : {}), createdAt: Number.isNaN(Date.parse(comment.created)) ? now : new Date(comment.created).toISOString() }];
    });
    pending.push({ item, ...(assigneeId ? { assigneeId } : {}), ...(reporterId ? { reporterId } : {}), description, comments });
  }
  for (const { item, assigneeId, reporterId, description } of pending) {
    const issue = config.store.createIssue(
      {
        id: uniqueId(config),
        projectId: project.id,
        summary: item.summary,
        description,
        type: item.type,
        status: item.status,
        priority: item.priority,
        reporterId: reporterId ?? importer.id,
        ...(assigneeId ? { assigneeId } : {}),
        labels: jiraLabels(item.labels),
        ...(item.dueDate ? { dueDate: item.dueDate } : {}),
        ...(item.estimate !== undefined ? { estimate: item.estimate } : {}),
        createdAt: now,
        updatedAt: now,
      },
      project.key,
    );
    recordIssueEvent(config, importer, issue.id, "issue.created", { source: "jira", jiraKey: item.key });
    keys.set(item.key, issue.id);
    report.created += 1;
  }
  const linked = new Set<string>();
  for (const { item, comments } of pending) {
    const issueId = keys.get(item.key)!;
    if (item.parentKey && keys.has(item.parentKey)) {
      const issue = config.store.readIssue(issueId) as CloudIssue;
      config.store.writeIssue({ ...issue, parentId: keys.get(item.parentKey)! });
      report.subtasks += 1;
    }
    for (const link of item.links) {
      const other = keys.get(link.key);
      if (!other || other === issueId) continue;
      const [sourceIssueId, targetIssueId] = link.direction === "inward" ? [other, issueId] : [issueId, other];
      const identity = link.type === "relates" ? `relates:${[sourceIssueId, targetIssueId].sort().join(":")}` : `${link.type}:${sourceIssueId}:${targetIssueId}`;
      if (linked.has(identity)) continue;
      linked.add(identity);
      try {
        config.store.writeIssueLink({ id: uniqueId(config), sourceIssueId, targetIssueId, type: link.type as CloudIssueLinkType, createdBy: importer.id, createdAt: now });
        report.links += 1;
      } catch {
        continue;
      }
    }
    for (const comment of comments) {
      config.store.writeIssueComment({ id: uniqueId(config), issueId, body: comment.body, createdBy: comment.authorId ?? importer.id, createdAt: comment.createdAt, updatedAt: comment.createdAt });
      report.comments += 1;
    }
    config.integrations.recordImport(source, item.key, issueId, now);
  }
  report.matchedPeople = matched.size;
  report.unmatchedPeople = [...unmatched].sort().slice(0, 200);
  report.keys = Object.fromEntries([...keys].map(([key, id]) => [key, config.store.readIssue(id)?.key ?? id]));
  recordActivity(config, importer, "import.jira", "site", project.siteId, { projectId: project.id, created: report.created });
  config.platform.recordAudit(importer.id, "import.jira", "site", project.siteId, { projectId: project.id, created: report.created, comments: report.comments }, now);
  return report;
}

// Slack bridge

/** Queues a Noma message for Slack when its channel is bridged; messages that came from Slack are not echoed back. */
export function enqueueSlackOutbound(config: CloudServerConfig, channel: ChatChannel, message: ChatMessage): void {
  if (!config.slack || message.kind !== "message") return;
  const bridge = config.integrations.readBridge(channel.id);
  if (!bridge?.enabled || config.integrations.slackForNomaMessage(message.id)) return;
  if (!config.integrations.enqueueOutbound({ id: randomId(), channelId: channel.id, messageId: message.id, attempts: 0, createdAt: config.now().toISOString() })) return;
  setImmediate(() => void drainSlackOutbox(config).catch(() => undefined));
}

/** What draining the outbox needs — the server config satisfies it, and so does the standalone queue worker. */
export interface SlackDrainDeps {
  slack?: SlackConfig;
  integrations: CloudIntegrationsStore;
  chat: CloudChatStore;
  store: Pick<CloudServerConfig["store"], "readUser">;
  platform: Pick<CloudServerConfig["platform"], "readAgent">;
  now: () => Date;
}

const draining = new WeakSet<SlackDrainDeps>();
const OUTBOX_LEASE_MS = 60_000;

/**
 * Posts queued messages to Slack with `chat.postMessage`, keeping thread structure; retries up to 5 times.
 * Each row is leased before the request, so several processes sharing the database never post it twice.
 */
export async function drainSlackOutbox(deps: SlackDrainDeps): Promise<number> {
  const slack = deps.slack;
  if (!slack || draining.has(deps)) return 0;
  draining.add(deps);
  let sent = 0;
  try {
    for (const item of deps.integrations.pendingOutbound(deps.now().toISOString())) {
      const now = deps.now();
      if (!deps.integrations.claimOutbound(item.id, now.toISOString(), new Date(now.getTime() + OUTBOX_LEASE_MS).toISOString())) continue;
      const message = deps.chat.readMessage(item.messageId);
      const bridge = deps.integrations.readBridge(item.channelId);
      if (!message || message.deletedAt || !bridge?.enabled) {
        deps.integrations.completeOutbound(item.id);
        continue;
      }
      const parent = message.threadId ? deps.integrations.slackForNomaMessage(message.threadId) : undefined;
      const author = message.agentId ? deps.platform.readAgent(message.agentId)?.name : deps.store.readUser(message.authorId)?.name;
      try {
        const result = await slackCall(slack, "chat.postMessage", {
          channel: bridge.slackChannelId,
          text: markdownToSlackText(displayMentions(deps, message.body)),
          ...(parent ? { thread_ts: parent.slackTs } : {}),
          ...(author ? { username: `${author}${message.agentId ? " (agent)" : ""} · Noma` } : {}),
          unfurl_links: false,
        });
        const ts = typeof result.ts === "string" ? result.ts : undefined;
        if (ts) deps.integrations.mapMessage(message.id, bridge.slackChannelId, ts, "out");
        deps.integrations.completeOutbound(item.id);
        sent += 1;
      } catch (error) {
        deps.integrations.failOutbound(item.id, error instanceof Error ? error.message : String(error), 5);
      }
    }
  } finally {
    draining.delete(deps);
  }
  return sent;
}

/** Verifies `X-Slack-Signature` (v0 HMAC of `v0:timestamp:body`) and a timestamp within five minutes. */
export function verifySlackSignature(slack: SlackConfig, body: Buffer, timestamp: string | undefined, signature: string | undefined, nowMs: number): boolean {
  if (!timestamp || !signature || !/^\d+$/.test(timestamp)) return false;
  if (Math.abs(nowMs / 1000 - Number(timestamp)) > 300) return false;
  const expected = Buffer.from(`v0=${createHmac("sha256", slack.signingSecret).update(`v0:${timestamp}:`).update(body).digest("hex")}`);
  const given = Buffer.from(signature);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/** Applies one Slack Events API callback: a new human message in a bridged channel lands in Noma. */
export async function handleSlackEvent(config: CloudServerConfig, payload: Record<string, unknown>): Promise<{ handled: boolean; messageId?: string; reason?: string }> {
  const event = record(payload.event);
  if (payload.type !== "event_callback" || event.type !== "message") return { handled: false, reason: "not a message event" };
  if (event.bot_id || event.subtype === "bot_message" || (event.subtype && event.subtype !== "thread_broadcast" && event.subtype !== "file_share")) return { handled: false, reason: "ignored subtype" };
  const slackChannel = text(event.channel);
  const ts = text(event.ts);
  const userId = text(event.user);
  if (!slackChannel || !ts || !userId) return { handled: false, reason: "incomplete event" };
  const bridge = config.integrations.bridgeForSlackChannel(slackChannel);
  if (!bridge?.enabled) return { handled: false, reason: "channel is not bridged" };
  if (config.integrations.nomaMessageForSlack(slackChannel, ts)) return { handled: false, reason: "already delivered" };
  const channel = config.chat.readChannel(bridge.channelId);
  const owner = config.store.readUser(bridge.createdBy);
  if (!channel || channel.archivedAt || !owner) return { handled: false, reason: "channel unavailable" };
  const person = await slackPerson(config, userId);
  const members = spaceMembersByEmail(config, channel.siteId);
  const matched = person.email ? members.get(person.email) : undefined;
  const author = matched && (channel.visibility === "public" || config.chat.readMember(channel.id, matched.id)) ? matched : undefined;
  const threadTs = text(event.thread_ts);
  const rootId = threadTs && threadTs !== ts ? config.integrations.nomaMessageForSlack(slackChannel, threadTs) : undefined;
  const files = (Array.isArray(event.files) ? event.files : []).map((file) => `📎 ${text(record(file).name) ?? "file"}`);
  const body = [`${author ? "" : `**${person.name}** (Slack): `}${slackTextToMarkdown(text(event.text) ?? "", (id) => `@${config.integrations.readPerson(id)?.name ?? id}`, (id, name) => `#${name ?? id}`)}`, ...files]
    .join("\n")
    .trim()
    .slice(0, CHAT_MESSAGE_MAX);
  try {
    enforceDlp(config, { text: body, actorId: (author ?? owner).id, resourceType: "chat_channel", resourceId: channel.id, siteId: channel.siteId });
  } catch (error) {
    if (error instanceof HttpError && error.status === 422) return { handled: false, reason: "blocked by DLP" };
    throw error;
  }
  const messageId = stableId("slack-live", `${slackChannel}:${ts}`);
  if (!config.integrations.mapMessage(messageId, slackChannel, ts, "in")) return { handled: false, reason: "already delivered" };
  const posted = config.chat.postMessage({
    id: messageId,
    channelId: channel.id,
    ...(rootId ? { threadId: rootId } : {}),
    kind: "message",
    authorId: (author ?? owner).id,
    body: body || "(empty message)",
    links: {},
    createdAt: config.now().toISOString(),
  });
  return { handled: true, messageId: posted.id };
}

async function slackPerson(config: CloudServerConfig, userId: string): Promise<{ name: string; email?: string }> {
  const cached = config.integrations.readPerson(userId);
  if (cached && config.now().getTime() - Date.parse(cached.fetchedAt) < 24 * 60 * 60 * 1000) return cached;
  try {
    const result = await slackCall(config.slack!, "users.info", { user: userId });
    const user = record(result.user);
    const profile = record(user.profile);
    const person = { slackUserId: userId, name: text(profile.real_name) ?? text(user.real_name) ?? text(user.name) ?? userId, ...(text(profile.email) ? { email: text(profile.email)!.toLowerCase() } : {}), fetchedAt: config.now().toISOString() };
    config.integrations.writePerson(person);
    return person;
  } catch {
    return cached ?? { name: userId };
  }
}

async function slackCall(slack: SlackConfig, method: string, body: Record<string, unknown>): Promise<Record<string, unknown>> {
  const response = await (slack.fetch ?? fetch)(`${slack.apiBase ?? "https://slack.com/api"}/${method}`, {
    method: "POST",
    headers: { authorization: `Bearer ${slack.botToken}`, "content-type": "application/json; charset=utf-8" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  const result = record(await response.json().catch(() => ({})));
  if (!response.ok || result.ok !== true) throw new Error(`Slack ${method} failed: ${text(result.error) ?? response.status}`);
  return result;
}

/** `NOMA_CLOUD_SLACK_BOT_TOKEN` + `NOMA_CLOUD_SLACK_SIGNING_SECRET` (or their `_FILE` variants). */
export function slackConfigFromEnv(env: NodeJS.ProcessEnv, readSecretFile: (path: string) => string): SlackConfig | undefined {
  const secret = (name: string) => env[name]?.trim() || (env[`${name}_FILE`] ? readSecretFile(env[`${name}_FILE`]!).trim() : "");
  const botToken = secret("NOMA_CLOUD_SLACK_BOT_TOKEN");
  const signingSecret = secret("NOMA_CLOUD_SLACK_SIGNING_SECRET");
  return botToken && signingSecret ? { botToken, signingSecret } : undefined;
}

function displayMentions(deps: Pick<SlackDrainDeps, "store" | "platform">, body: string): string {
  return body.replace(/@\{([A-Za-z0-9_-]{8,80})\}/g, (_match, id: string) => `@${deps.store.readUser(id)?.name ?? deps.platform.readAgent(id)?.name ?? id}`);
}

/**
 * The channel an imported Slack channel lands in: an existing channel with the same name only when its
 * visibility matches (a private channel's history never lands in a public one) and, for a private channel,
 * the importer is already a member (an import never joins someone else's private channel); otherwise a fresh
 * `name-private` / `name-2` channel.
 */
function importTarget(config: CloudServerConfig, siteId: string, importerId: string, base: string, visibility: "public" | "private"): { name: string; existing?: ChatChannel } {
  const candidates = [base, ...(visibility === "private" ? [channelNameInput(`${base.slice(0, CHANNEL_NAME_MAX - 8)}-private`)] : []), ...Array.from({ length: 50 }, (_, index) => channelNameInput(`${base.slice(0, CHANNEL_NAME_MAX - 4)}-${index + 2}`))];
  for (const name of candidates) {
    const existing = config.chat.readChannelByName(siteId, name);
    if (!existing) return { name };
    if (existing.kind === "channel" && existing.visibility === visibility && (visibility === "public" || config.chat.readMember(existing.id, importerId))) return { name, existing };
  }
  throw new HttpError(409, `No free channel name for #${base}`);
}

function safeChannelName(name: string): string {
  try {
    return channelNameInput(name);
  } catch {
    return channelNameInput(`slack-${createHash("sha256").update(name).digest("hex").slice(0, 8)}`);
  }
}

function jiraLabels(labels: string[]): string[] {
  const normalized = labels
    .map((label) => label.trim().toLowerCase().replace(/\s+/g, "-").slice(0, 80))
    .filter((label) => /^[a-z0-9][a-z0-9._-]*$/.test(label));
  return [...new Set(["jira", ...normalized])].slice(0, 20);
}

function stableId(namespace: string, key: string): string {
  return createHash("sha256").update(`${namespace}:${key}`).digest("hex").slice(0, 18);
}

function slackTime(ts: string): string {
  return new Date(Math.round(Number(ts) * 1000)).toISOString();
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}
