/**
 * Slack workspace export (the ZIP from Settings → Import/Export) → channels, users, and messages ready
 * to land in Noma chat. Pure: no I/O beyond the bytes it is given. Direct messages and group DMs are
 * counted but not imported (a standard export only includes them on Enterprise plans, and they are
 * personal conversations).
 */
import { readZip } from "./zip.js";

export interface SlackUser {
  id: string;
  name: string;
  email?: string;
  bot: boolean;
}

export interface SlackFile {
  name: string;
  url?: string;
}

export interface SlackReaction {
  name: string;
  users: string[];
}

export interface SlackMessage {
  ts: string;
  user?: string;
  botName?: string;
  text: string;
  threadTs?: string;
  subtype?: string;
  files: SlackFile[];
  reactions: SlackReaction[];
}

export interface SlackChannel {
  id: string;
  name: string;
  topic?: string;
  purpose?: string;
  private: boolean;
  archived: boolean;
  members: string[];
  messages: SlackMessage[];
}

export interface SlackExport {
  users: Map<string, SlackUser>;
  channels: SlackChannel[];
  skipped: { directMessages: number; groupMessages: number };
}

export class SlackImportError extends Error {}

const MAX_MESSAGES = 200_000;
/** Membership and housekeeping events that carry no conversation. */
const NOISE_SUBTYPES = new Set(["channel_join", "channel_leave", "group_join", "group_leave", "channel_purpose", "channel_topic", "channel_name", "channel_archive", "channel_unarchive", "pinned_item", "unpinned_item"]);

export function parseSlackExport(data: Uint8Array): SlackExport {
  let entries;
  try {
    entries = readZip(data, { maxEntries: 50_000, maxEntryBytes: 50_000_000, maxTotalBytes: 500_000_000 });
  } catch (error) {
    throw new SlackImportError(`Not a readable Slack export ZIP: ${error instanceof Error ? error.message : String(error)}`);
  }
  const files = new Map(entries.map((entry) => [entry.path.replace(/^\/+/, ""), entry.data]));
  const root = commonRoot([...files.keys()]);
  const read = (path: string): unknown => {
    const bytes = files.get(`${root}${path}`);
    if (!bytes) return undefined;
    try {
      return JSON.parse(Buffer.from(bytes).toString("utf8")) as unknown;
    } catch {
      throw new SlackImportError(`${path} is not valid JSON`);
    }
  };
  const channelList = read("channels.json");
  if (!Array.isArray(channelList)) throw new SlackImportError("channels.json is missing — is this a Slack workspace export?");
  const users = new Map<string, SlackUser>();
  for (const raw of arrayOf(read("users.json"))) {
    const id = text(raw.id);
    if (!id) continue;
    const profile = record(raw.profile);
    users.set(id, {
      id,
      name: text(profile.real_name) || text(raw.real_name) || text(profile.display_name) || text(raw.name) || id,
      ...(text(profile.email) ? { email: text(profile.email)!.toLowerCase() } : {}),
      bot: raw.is_bot === true || raw.is_app_user === true,
    });
  }
  const channels: SlackChannel[] = [];
  let total = 0;
  const load = (raw: Record<string, unknown>, isPrivate: boolean) => {
    const id = text(raw.id);
    const name = text(raw.name);
    if (!id || !name) return;
    const messages: SlackMessage[] = [];
    for (const path of [...files.keys()].filter((path) => path.startsWith(`${root}${name}/`) && path.endsWith(".json")).sort()) {
      for (const message of arrayOf(read(path.slice(root.length)))) {
        const parsed = slackMessage(message);
        if (!parsed) continue;
        total += 1;
        if (total > MAX_MESSAGES) throw new SlackImportError(`The export has more than ${MAX_MESSAGES} messages; import it in parts`);
        messages.push(parsed);
      }
    }
    messages.sort((left, right) => Number(left.ts) - Number(right.ts));
    channels.push({
      id,
      name,
      ...(text(record(raw.topic).value) ? { topic: text(record(raw.topic).value) } : {}),
      ...(text(record(raw.purpose).value) ? { purpose: text(record(raw.purpose).value) } : {}),
      private: isPrivate,
      archived: raw.is_archived === true,
      members: Array.isArray(raw.members) ? raw.members.filter((member): member is string => typeof member === "string") : [],
      messages,
    });
  };
  for (const raw of arrayOf(channelList)) load(raw, false);
  for (const raw of arrayOf(read("groups.json"))) load(raw, true);
  return { users, channels, skipped: { directMessages: arrayOf(read("dms.json")).length, groupMessages: arrayOf(read("mpims.json")).length } };
}

/**
 * Slack mrkdwn → Noma inline Markdown: `<@U1>` mentions, `<#C1|name>` channels, `<url|label>` links,
 * `*bold*`, `_italic_`, `~strike~`, and HTML entities.
 */
export function slackTextToMarkdown(input: string, mention: (userId: string) => string, channel: (channelId: string, fallback?: string) => string): string {
  return input
    .replace(/<@([A-Z0-9]+)(?:\|[^>]*)?>/g, (_match, id: string) => mention(id))
    .replace(/<#([A-Z0-9]+)(?:\|([^>]*))?>/g, (_match, id: string, name?: string) => channel(id, name))
    .replace(/<!(here|channel|everyone)(?:\|[^>]*)?>/g, (_match, word: string) => `@${word}`)
    .replace(/<!subteam\^[A-Z0-9]+\|([^>]+)>/g, (_match, name: string) => name)
    .replace(/<((?:https?|mailto):[^|>]+)\|([^>]+)>/g, (_match, url: string, label: string) => `[${label}](${url})`)
    .replace(/<((?:https?|mailto):[^>]+)>/g, (_match, url: string) => url)
    .replace(/(^|[\s(])\*([^*\n]+)\*(?=[\s).,!?:;]|$)/gm, "$1**$2**")
    .replace(/(^|[\s(])_([^_\n]+)_(?=[\s).,!?:;]|$)/gm, "$1*$2*")
    .replace(/(^|[\s(])~([^~\n]+)~(?=[\s).,!?:;]|$)/gm, "$1~~$2~~")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

/** Noma inline Markdown → Slack mrkdwn for the outbound bridge. */
export function markdownToSlackText(input: string): string {
  return input
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, (_match, label: string, url: string) => `<${url}|${label}>`)
    .replace(/\*\*([^*\n]+)\*\*/g, "*$1*")
    .replace(/~~([^~\n]+)~~/g, "~$1~");
}

const EMOJI: Record<string, string> = {
  "+1": "👍",
  thumbsup: "👍",
  "-1": "👎",
  thumbsdown: "👎",
  heart: "❤️",
  tada: "🎉",
  eyes: "👀",
  rocket: "🚀",
  white_check_mark: "✅",
  heavy_check_mark: "✔️",
  x: "❌",
  fire: "🔥",
  joy: "😂",
  smile: "😄",
  pray: "🙏",
  raised_hands: "🙌",
  thinking_face: "🤔",
  "100": "💯",
  clap: "👏",
  warning: "⚠️",
};

/** A Slack reaction name as a Noma reaction token: the Unicode emoji when known, `:name:` otherwise. */
export function slackEmoji(name: string): string {
  const base = name.split("::")[0]!;
  return EMOJI[base] ?? `:${base}:`.slice(0, 32);
}

function slackMessage(raw: Record<string, unknown>): SlackMessage | undefined {
  if (raw.type !== "message") return undefined;
  const subtype = text(raw.subtype);
  if (subtype && NOISE_SUBTYPES.has(subtype)) return undefined;
  const ts = text(raw.ts);
  if (!ts || !/^\d+(\.\d+)?$/.test(ts)) return undefined;
  const threadTs = text(raw.thread_ts);
  return {
    ts,
    ...(text(raw.user) ? { user: text(raw.user) } : {}),
    ...(text(raw.username) || text(record(raw.bot_profile).name) ? { botName: text(raw.username) || text(record(raw.bot_profile).name) } : {}),
    text: text(raw.text) ?? "",
    ...(threadTs && threadTs !== ts ? { threadTs } : {}),
    ...(subtype ? { subtype } : {}),
    files: arrayOf(raw.files).map((file) => ({ name: text(file.name) || text(file.title) || "file", ...(text(file.permalink) ? { url: text(file.permalink) } : {}) })),
    reactions: arrayOf(raw.reactions).flatMap((reaction) => {
      const name = text(reaction.name);
      return name ? [{ name, users: Array.isArray(reaction.users) ? reaction.users.filter((user): user is string => typeof user === "string") : [] }] : [];
    }),
  };
}

function commonRoot(paths: string[]): string {
  const channels = paths.find((path) => path.endsWith("channels.json"));
  return channels ? channels.slice(0, -"channels.json".length) : "";
}

function arrayOf(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? value.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item)) : [];
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}
