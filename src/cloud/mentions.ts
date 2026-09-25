/** `@{userId}` mentions in comments and page source: extraction, display names, and notifications. */
import type { CloudDocumentRecord, CloudUserRecord } from "../cloud-db.js";
import { agentDocumentAccess } from "./agent-assignments.js";
import { type CloudServerConfig, writeNotification } from "./context.js";

const MENTION_RE = /@\{([A-Za-z0-9_-]{8,80})\}/g;

/** Distinct user IDs mentioned in `text`, ignoring fenced code blocks. */
export function extractMentions(text: string): string[] {
  const withoutCode = text.replace(/^(```|~~~)[^\n]*\n[\s\S]*?^\1[^\n]*$/gm, "");
  return [...new Set([...withoutCode.matchAll(MENTION_RE)].map((match) => match[1]!))];
}

/**
 * Display names for the users mentioned in `text` that the caller may see, plus the agents
 * assignable on the page (flagged `agent: true`).
 */
export function mentionNames(config: CloudServerConfig, caller: CloudUserRecord | undefined, text: string, documentId: string): Array<{ id: string; name: string; agent?: true }> {
  const ids = extractMentions(text);
  if (ids.length === 0) return [];
  const users = caller
    ? config.store.userNames(caller.id, ids.slice(0, 200), documentId)
    : ids.flatMap((id) => (config.store.documentAccessRole(id, documentId) ? [{ id, name: config.store.readUser(id)?.name ?? id }] : []));
  const known = new Set(users.map((user) => user.id));
  const agents = ids.slice(0, 200).flatMap((id) => {
    if (known.has(id)) return [];
    const access = agentDocumentAccess(config, id, documentId);
    return access ? [{ id, name: access.agent.name, agent: true as const }] : [];
  });
  return [...users, ...agents];
}

/**
 * Notifies users newly mentioned in a page's source. Only mentions absent from `previousSource`
 * count, and only users who can open the page are told about it.
 */
export function notifySourceMentions(
  config: CloudServerConfig,
  document: CloudDocumentRecord,
  previousSource: string | undefined,
  actorId: string | undefined,
  actorName: string,
): string[] {
  const before = new Set(previousSource === undefined ? [] : extractMentions(previousSource));
  const notified: string[] = [];
  for (const userId of extractMentions(document.source).slice(0, 100)) {
    if (before.has(userId) || userId === actorId) continue;
    if (!config.store.documentAccessRole(userId, document.id)) continue;
    writeNotification(config, userId, "mention", `Mentioned in ${document.title}`, `${actorName} mentioned you on ${document.title}.`, "document", document.id);
    notified.push(userId);
  }
  return notified;
}
