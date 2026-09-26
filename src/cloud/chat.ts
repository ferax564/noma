/** Pure chat helpers: channel-name rules and thread → `.noma` transcripts. */
import { serializeAttr } from "../parser.js";
import { HttpError } from "./http.js";

export const CHANNEL_NAME_MAX = 80;
export const CHAT_MESSAGE_MAX = 16_000;

/** Slack-style channel name: lowercase letters, digits, `-` and `_`; spaces become `-`. */
export function channelNameInput(value: unknown): string {
  if (typeof value !== "string") throw new HttpError(400, "name is required");
  const name = value
    .trim()
    .replace(/^#/, "")
    .toLowerCase()
    .replace(/\s+/g, "-")
    .replace(/[^a-z0-9_-]/g, "")
    .replace(/-{2,}/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, CHANNEL_NAME_MAX);
  if (!name) throw new HttpError(400, "name must contain letters or digits");
  return name;
}

export interface TranscriptMessage {
  id: string;
  author: string;
  agent?: string;
  at: string;
  body: string;
}

export interface ThreadTranscript {
  title: string;
  channel: string;
  space: string;
  capturedAt: string;
  capturedBy: string;
  messages: TranscriptMessage[];
}

/**
 * Renders a chat thread as a `.noma` page: one `::message` block per message, with the stable
 * message ID as block ID so agents can cite and patch individual turns. A body that could close or
 * restructure the surrounding directive (colon fences, headings, code fences) is kept verbatim in a code fence.
 */
export function chatThreadToNoma(transcript: ThreadTranscript): string {
  const lines = [
    "---",
    `title: ${JSON.stringify(transcript.title)}`,
    `source: noma-chat`,
    `channel: ${JSON.stringify(`#${transcript.channel}`)}`,
    `captured: ${JSON.stringify(transcript.capturedAt)}`,
    "---",
    "",
    `# ${transcript.title.replace(/\s+/g, " ").replace(/\{/g, "(").replace(/\}/g, ")")}`,
    "",
    `Captured from #${transcript.channel} in ${transcript.space} by ${transcript.capturedBy}.`,
    "",
    `::chat_thread{${[serializeAttr("id", `thread-${transcript.messages[0]?.id ?? "empty"}`), serializeAttr("channel", transcript.channel), serializeAttr("messages", transcript.messages.length)].join(" ")}}`,
  ];
  for (const message of transcript.messages) {
    const attrs = [serializeAttr("id", `msg-${message.id}`), serializeAttr("author", message.author), ...(message.agent ? [serializeAttr("agent", message.agent)] : []), serializeAttr("at", message.at)];
    lines.push(`:::message{${attrs.join(" ")}}`, ...messageBody(message.body), ":::");
  }
  lines.push("::", "");
  return lines.join("\n");
}

export interface ChannelTranscript {
  channel: string;
  topic?: string;
  exportedAt: string;
  messages: Array<TranscriptMessage & { thread?: string }>;
}

/**
 * Renders a whole channel as `.noma` (space exports, eDiscovery): one `::message` per message in
 * order; replies carry `thread="msg-<root>"` so the thread structure survives the round trip.
 */
export function chatChannelToNoma(transcript: ChannelTranscript): string {
  const lines = [
    "---",
    `title: ${JSON.stringify(`#${transcript.channel}`)}`,
    "source: noma-chat",
    `exported: ${JSON.stringify(transcript.exportedAt)}`,
    "---",
    "",
    `# #${transcript.channel.replace(/[{}]/g, "")}`,
    "",
    ...(transcript.topic ? [...messageBody(transcript.topic.replace(/\s+/g, " ")), ""] : []),
    `::chat_channel{${[serializeAttr("id", `channel-${transcript.channel}`), serializeAttr("messages", transcript.messages.length)].join(" ")}}`,
  ];
  for (const message of transcript.messages) {
    const attrs = [
      serializeAttr("id", `msg-${message.id}`),
      serializeAttr("author", message.author),
      ...(message.agent ? [serializeAttr("agent", message.agent)] : []),
      serializeAttr("at", message.at),
      ...(message.thread ? [serializeAttr("thread", `msg-${message.thread}`)] : []),
    ];
    lines.push(`:::message{${attrs.join(" ")}}`, ...messageBody(message.body), ":::");
  }
  lines.push("::", "");
  return lines.join("\n");
}

function messageBody(body: string): string[] {
  const text = body.replace(/\r\n?/g, "\n").trim();
  if (!text) return ["*(deleted)*"];
  if (!/^\s*(:{2,}|#{1,6}(\s|$)|---\s*$|`{3,}|~{3,})/m.test(text)) return text.split("\n");
  const longest = Math.max(2, ...[...text.matchAll(/`+/g)].map((match) => match[0].length));
  const fence = "`".repeat(longest + 1);
  return [`${fence}text`, ...text.split("\n"), fence];
}
