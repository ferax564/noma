/**
 * Noma Cloud chat persistence: channels scoped to a space (optionally to a Work project), threaded
 * messages, reactions, mentions, and per-member read markers. Opens its own connection to the Cloud
 * SQLite file, like `CloudKnowledgePlatform`.
 *
 * Every message takes the next per-channel `seq`, thread replies included, so a client can poll
 * `after=<seq>` or follow the in-process event stream and never miss a write.
 */
import { EventEmitter } from "node:events";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import DatabaseConstructor from "better-sqlite3";
import type { Database as SqliteDatabase } from "better-sqlite3";

export type ChatChannelVisibility = "public" | "private";
export type ChatMemberRole = "member" | "admin";
export type ChatMemberType = "user" | "agent";
export type ChatMessageKind = "message" | "system";
/** `channel` lives in a space; `dm` is a direct or group conversation between members only. */
export type ChatChannelKind = "channel" | "dm";

export interface ChatChannel {
  id: string;
  kind: ChatChannelKind;
  /** Empty for direct messages. */
  siteId: string;
  projectId?: string;
  name: string;
  topic?: string;
  visibility: ChatChannelVisibility;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  archivedAt?: string;
  lastSeq: number;
  lastMessageAt?: string;
}

export interface ChatMember {
  channelId: string;
  memberId: string;
  memberType: ChatMemberType;
  role: ChatMemberRole;
  joinedAt: string;
  lastReadSeq: number;
}

/** Work items created from a message: an issue, or a page capturing its thread. */
export interface ChatMessageLinks {
  issueIds?: string[];
  documentIds?: string[];
  fileIds?: string[];
}

/** A file uploaded into a channel; its bytes live in the attachment blob store by SHA-256. */
export interface ChatFile {
  id: string;
  channelId: string;
  messageId?: string;
  sha256: string;
  filename: string;
  contentType: string;
  size: number;
  uploadedBy: string;
  createdAt: string;
}

/** A previous body of an edited or deleted message, kept for eDiscovery until retention removes it. */
export interface ChatRevision {
  messageId: string;
  body: string;
  action: "edit" | "delete";
  revisedBy: string;
  revisedAt: string;
}

export interface ChatPurgeResult {
  deletedMessages: number;
  blankedRoots: number;
  protectedMessages: number;
  deletedFiles: number;
  fileHashes: string[];
}

export interface ChatMessage {
  id: string;
  channelId: string;
  seq: number;
  threadId?: string;
  kind: ChatMessageKind;
  authorId: string;
  /** Set when the author posted as one of their agents. */
  agentId?: string;
  body: string;
  links: ChatMessageLinks;
  replyCount: number;
  lastReplyAt?: string;
  createdAt: string;
  editedAt?: string;
  deletedAt?: string;
}

export interface ChatReaction {
  emoji: string;
  memberIds: string[];
}

export interface ChatMention {
  messageId: string;
  channelId: string;
  mentionedId: string;
  isAgent: boolean;
  createdAt: string;
}

/** Light notice published to stream subscribers after every channel write. */
export interface ChatEvent {
  type: "message" | "message_updated" | "reaction" | "channel";
  channelId: string;
  seq: number;
  messageId?: string;
  threadId?: string;
}

export interface ChatMessagePage {
  after?: number;
  before?: number;
  limit: number;
  /** Replies to this root when set; top-level messages otherwise. */
  threadId?: string;
  /** Every message (top-level and replies) after `after`; used by pollers. */
  all?: boolean;
}

interface ChannelRow {
  id: string;
  kind: ChatChannelKind;
  dm_key: string | null;
  site_id: string;
  project_id: string | null;
  name: string;
  topic: string | null;
  visibility: ChatChannelVisibility;
  created_by: string;
  created_at: string;
  updated_at: string;
  archived_at: string | null;
  last_seq: number;
  last_message_at: string | null;
}

interface MemberRow {
  channel_id: string;
  member_id: string;
  member_type: ChatMemberType;
  role: ChatMemberRole;
  joined_at: string;
  last_read_seq: number;
}

interface MessageRow {
  id: string;
  channel_id: string;
  seq: number;
  thread_id: string | null;
  kind: ChatMessageKind;
  author_id: string;
  agent_id: string | null;
  body: string;
  links_json: string;
  reply_count: number;
  last_reply_at: string | null;
  created_at: string;
  edited_at: string | null;
  deleted_at: string | null;
}

export class CloudChatStore {
  private readonly db: SqliteDatabase;
  private readonly events = new EventEmitter();
  private readonly streams = new Map<() => void, string>();

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseConstructor(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("busy_timeout = 5000");
    this.events.setMaxListeners(0);
    this.applySchema();
  }

  close(): void {
    this.closeStreams();
    this.db.close();
  }

  // channels

  createChannel(channel: Omit<ChatChannel, "lastSeq" | "lastMessageAt">, dmKey?: string): ChatChannel {
    this.db
      .prepare(
        `INSERT INTO chat_channels (id, kind, dm_key, site_id, project_id, name, topic, visibility, created_by, created_at, updated_at, archived_at, last_seq, last_message_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL)`,
      )
      .run(channel.id, channel.kind, dmKey ?? null, channel.siteId, channel.projectId ?? null, channel.name, channel.topic ?? null, channel.visibility, channel.createdBy, channel.createdAt, channel.updatedAt, channel.archivedAt ?? null);
    return this.readChannel(channel.id)!;
  }

  /** The direct-message conversation for exactly this member set, if one exists. */
  readDmByKey(dmKey: string): ChatChannel | undefined {
    const row = this.db.prepare("SELECT * FROM chat_channels WHERE dm_key = ?").get(dmKey) as ChannelRow | undefined;
    return row ? channelFromRow(row) : undefined;
  }

  /** Direct-message conversations `memberId` belongs to, most recently active first. */
  listDms(memberId: string): ChatChannel[] {
    return (
      this.db
        .prepare(
          `SELECT c.* FROM chat_channels c JOIN chat_members m ON m.channel_id = c.id AND m.member_id = ?
           WHERE c.kind = 'dm' ORDER BY COALESCE(c.last_message_at, c.created_at) DESC, c.id`,
        )
        .all(memberId) as ChannelRow[]
    ).map(channelFromRow);
  }

  /** Every channel (DMs included) for compliance exports and retention, optionally narrowed to spaces. */
  listAllChannels(siteIds?: string[]): ChatChannel[] {
    const rows = siteIds
      ? (this.db.prepare("SELECT * FROM chat_channels WHERE site_id IN (SELECT value FROM json_each(?)) ORDER BY created_at, id").all(JSON.stringify(siteIds)) as ChannelRow[])
      : (this.db.prepare("SELECT * FROM chat_channels ORDER BY created_at, id").all() as ChannelRow[]);
    return rows.map(channelFromRow);
  }

  readChannel(id: string): ChatChannel | undefined {
    const row = this.db.prepare("SELECT * FROM chat_channels WHERE id = ?").get(id) as ChannelRow | undefined;
    return row ? channelFromRow(row) : undefined;
  }

  readChannelByName(siteId: string, name: string): ChatChannel | undefined {
    const row = this.db.prepare("SELECT * FROM chat_channels WHERE site_id = ? AND name = ?").get(siteId, name) as ChannelRow | undefined;
    return row ? channelFromRow(row) : undefined;
  }

  /** Channels in the given spaces, most recently active first. */
  listChannels(siteIds: string[], filter: { projectId?: string; includeArchived?: boolean } = {}): ChatChannel[] {
    if (siteIds.length === 0) return [];
    const clauses = ["kind = 'channel'", "site_id IN (SELECT value FROM json_each(?))"];
    const params: Array<string> = [JSON.stringify(siteIds)];
    if (filter.projectId) {
      clauses.push("project_id = ?");
      params.push(filter.projectId);
    }
    if (!filter.includeArchived) clauses.push("archived_at IS NULL");
    return (this.db.prepare(`SELECT * FROM chat_channels WHERE ${clauses.join(" AND ")} ORDER BY COALESCE(last_message_at, created_at) DESC, name`).all(...params) as ChannelRow[]).map(channelFromRow);
  }

  updateChannel(id: string, patch: { name?: string; topic?: string | null; visibility?: ChatChannelVisibility; projectId?: string | null; archivedAt?: string | null; updatedAt: string }): ChatChannel | undefined {
    const current = this.readChannel(id);
    if (!current) return undefined;
    this.db
      .prepare("UPDATE chat_channels SET name = ?, topic = ?, visibility = ?, project_id = ?, archived_at = ?, updated_at = ? WHERE id = ?")
      .run(
        patch.name ?? current.name,
        patch.topic === undefined ? current.topic ?? null : patch.topic,
        patch.visibility ?? current.visibility,
        patch.projectId === undefined ? current.projectId ?? null : patch.projectId,
        patch.archivedAt === undefined ? current.archivedAt ?? null : patch.archivedAt,
        patch.updatedAt,
        id,
      );
    const next = this.readChannel(id)!;
    this.publish({ type: "channel", channelId: id, seq: next.lastSeq });
    return next;
  }

  // members

  readMember(channelId: string, memberId: string): ChatMember | undefined {
    const row = this.db.prepare("SELECT * FROM chat_members WHERE channel_id = ? AND member_id = ?").get(channelId, memberId) as MemberRow | undefined;
    return row ? memberFromRow(row) : undefined;
  }

  listMembers(channelId: string): ChatMember[] {
    return (this.db.prepare("SELECT * FROM chat_members WHERE channel_id = ? ORDER BY joined_at, member_id").all(channelId) as MemberRow[]).map(memberFromRow);
  }

  /** Channel IDs `memberId` belongs to, among `channelIds`. */
  memberChannelIds(memberId: string, channelIds: string[]): Map<string, ChatMember> {
    if (channelIds.length === 0) return new Map();
    const rows = this.db
      .prepare("SELECT * FROM chat_members WHERE member_id = ? AND channel_id IN (SELECT value FROM json_each(?))")
      .all(memberId, JSON.stringify(channelIds)) as MemberRow[];
    return new Map(rows.map((row) => [row.channel_id, memberFromRow(row)]));
  }

  /** Adds the member, keeping an existing membership (and its read marker) unchanged except for a role upgrade. */
  addMember(member: Omit<ChatMember, "lastReadSeq"> & { lastReadSeq?: number }): ChatMember {
    this.db
      .prepare(
        `INSERT INTO chat_members (channel_id, member_id, member_type, role, joined_at, last_read_seq)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(channel_id, member_id) DO UPDATE SET role = CASE WHEN excluded.role = 'admin' THEN 'admin' ELSE chat_members.role END`,
      )
      .run(member.channelId, member.memberId, member.memberType, member.role, member.joinedAt, member.lastReadSeq ?? 0);
    return this.readMember(member.channelId, member.memberId)!;
  }

  /** Detaches a group DM from its original member set once people join or leave it. */
  clearDmKey(channelId: string): void {
    this.db.prepare("UPDATE chat_channels SET dm_key = NULL WHERE id = ?").run(channelId);
  }

  removeMember(channelId: string, memberId: string): boolean {
    return this.db.prepare("DELETE FROM chat_members WHERE channel_id = ? AND member_id = ?").run(channelId, memberId).changes > 0;
  }

  /** Moves the read marker forward only. */
  markRead(channelId: string, memberId: string, seq: number): number {
    this.db.prepare("UPDATE chat_members SET last_read_seq = MAX(last_read_seq, ?) WHERE channel_id = ? AND member_id = ?").run(seq, channelId, memberId);
    return this.readMember(channelId, memberId)?.lastReadSeq ?? 0;
  }

  /** Unread top-level messages and unread mentions of `memberId` per channel, ignoring their own posts (but not their agents'). */
  unreadCounts(memberId: string, channelIds: string[]): Map<string, { unread: number; mentions: number }> {
    const counts = new Map<string, { unread: number; mentions: number }>();
    if (channelIds.length === 0) return counts;
    const rows = this.db
      .prepare(
        `SELECT m.channel_id AS channel_id,
                SUM(CASE WHEN msg.thread_id IS NULL THEN 1 ELSE 0 END) AS unread,
                SUM(CASE WHEN EXISTS (SELECT 1 FROM chat_mentions men WHERE men.message_id = msg.id AND men.mentioned_id = m.member_id) THEN 1 ELSE 0 END) AS mentions
         FROM chat_members m
         JOIN chat_messages msg ON msg.channel_id = m.channel_id AND msg.seq > m.last_read_seq AND (msg.author_id != m.member_id OR msg.agent_id IS NOT NULL) AND msg.deleted_at IS NULL
         WHERE m.member_id = ? AND m.channel_id IN (SELECT value FROM json_each(?))
         GROUP BY m.channel_id`,
      )
      .all(memberId, JSON.stringify(channelIds)) as Array<{ channel_id: string; unread: number; mentions: number }>;
    for (const row of rows) counts.set(row.channel_id, { unread: row.unread, mentions: row.mentions });
    return counts;
  }

  // messages

  /**
   * Appends a message with the channel's next `seq` and records its mentions. A reply (not a system
   * note) bumps its root's reply count.
   */
  postMessage(message: Omit<ChatMessage, "seq" | "replyCount" | "lastReplyAt" | "editedAt" | "deletedAt">, mentions: Array<{ id: string; isAgent: boolean }> = []): ChatMessage {
    const insert = this.db.transaction(() => {
      this.db.prepare("UPDATE chat_channels SET last_seq = last_seq + 1, last_message_at = ? WHERE id = ?").run(message.createdAt, message.channelId);
      const { last_seq: seq } = this.db.prepare("SELECT last_seq FROM chat_channels WHERE id = ?").get(message.channelId) as { last_seq: number };
      this.db
        .prepare(
          `INSERT INTO chat_messages (id, channel_id, seq, thread_id, kind, author_id, agent_id, body, links_json, reply_count, last_reply_at, created_at, edited_at, deleted_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 0, NULL, ?, NULL, NULL)`,
        )
        .run(message.id, message.channelId, seq, message.threadId ?? null, message.kind, message.authorId, message.agentId ?? null, message.body, JSON.stringify(message.links), message.createdAt);
      if (message.threadId && message.kind === "message") {
        this.db.prepare("UPDATE chat_messages SET reply_count = reply_count + 1, last_reply_at = ? WHERE id = ?").run(message.createdAt, message.threadId);
      }
      const mention = this.db.prepare("INSERT OR IGNORE INTO chat_mentions (message_id, channel_id, mentioned_id, is_agent, created_at) VALUES (?, ?, ?, ?, ?)");
      for (const item of mentions) mention.run(message.id, message.channelId, item.id, item.isAgent ? 1 : 0, message.createdAt);
      return seq;
    });
    const seq = insert();
    const stored = this.readMessage(message.id)!;
    this.publish({ type: "message", channelId: message.channelId, seq, messageId: message.id, ...(message.threadId ? { threadId: message.threadId } : {}) });
    return stored;
  }

  readMessage(id: string): ChatMessage | undefined {
    const row = this.db.prepare("SELECT * FROM chat_messages WHERE id = ?").get(id) as MessageRow | undefined;
    return row ? messageFromRow(row) : undefined;
  }

  /**
   * A page of messages in ascending `seq` order. With `before`, the newest `limit` messages below it;
   * otherwise the oldest `limit` messages above `after` (default 0).
   */
  listMessages(channelId: string, page: ChatMessagePage): ChatMessage[] {
    const clauses = ["channel_id = ?"];
    const params: Array<string | number> = [channelId];
    if (!page.all) {
      if (page.threadId) {
        clauses.push("thread_id = ?");
        params.push(page.threadId);
      } else clauses.push("thread_id IS NULL");
    }
    if (page.before !== undefined) {
      clauses.push("seq < ?");
      params.push(page.before);
      const rows = this.db.prepare(`SELECT * FROM chat_messages WHERE ${clauses.join(" AND ")} ORDER BY seq DESC LIMIT ?`).all(...params, page.limit) as MessageRow[];
      return rows.reverse().map(messageFromRow);
    }
    if (page.after !== undefined) {
      clauses.push("seq > ?");
      params.push(page.after);
      return (this.db.prepare(`SELECT * FROM chat_messages WHERE ${clauses.join(" AND ")} ORDER BY seq LIMIT ?`).all(...params, page.limit) as MessageRow[]).map(messageFromRow);
    }
    const rows = this.db.prepare(`SELECT * FROM chat_messages WHERE ${clauses.join(" AND ")} ORDER BY seq DESC LIMIT ?`).all(...params, page.limit) as MessageRow[];
    return rows.reverse().map(messageFromRow);
  }

  /** Replaces the body and the stored mention set; mentions kept from the old body keep their original time. */
  editMessage(id: string, body: string, editedAt: string, mentions: Array<{ id: string; isAgent: boolean }> = [], editedBy?: string): ChatMessage | undefined {
    const current = this.readMessage(id);
    if (!current) return undefined;
    this.db.transaction(() => {
      this.insertRevision({ messageId: id, body: current.body, action: "edit", revisedBy: editedBy ?? current.authorId, revisedAt: editedAt });
      this.db.prepare("UPDATE chat_messages SET body = ?, edited_at = ? WHERE id = ?").run(body, editedAt, id);
      this.db
        .prepare("DELETE FROM chat_mentions WHERE message_id = ? AND mentioned_id NOT IN (SELECT value FROM json_each(?))")
        .run(id, JSON.stringify(mentions.map((mention) => mention.id)));
      const mention = this.db.prepare("INSERT OR IGNORE INTO chat_mentions (message_id, channel_id, mentioned_id, is_agent, created_at) VALUES (?, ?, ?, ?, ?)");
      for (const item of mentions) mention.run(id, current.channelId, item.id, item.isAgent ? 1 : 0, editedAt);
    })();
    const next = this.readMessage(id)!;
    this.publish({ type: "message_updated", channelId: current.channelId, seq: current.seq, messageId: id, ...(current.threadId ? { threadId: current.threadId } : {}) });
    return next;
  }

  /**
   * Blanks the body and drops mentions and reactions; the row stays so thread structure survives,
   * and the old body is kept as a revision for eDiscovery.
   */
  deleteMessage(id: string, deletedAt: string, deletedBy?: string): ChatMessage | undefined {
    const current = this.readMessage(id);
    if (!current) return undefined;
    this.db.transaction(() => {
      if (!current.deletedAt) this.insertRevision({ messageId: id, body: current.body, action: "delete", revisedBy: deletedBy ?? current.authorId, revisedAt: deletedAt });
      this.db.prepare("UPDATE chat_messages SET body = '', deleted_at = ? WHERE id = ?").run(deletedAt, id);
      this.db.prepare("DELETE FROM chat_mentions WHERE message_id = ?").run(id);
      this.db.prepare("DELETE FROM chat_reactions WHERE message_id = ?").run(id);
    })();
    this.publish({ type: "message_updated", channelId: current.channelId, seq: current.seq, messageId: id, ...(current.threadId ? { threadId: current.threadId } : {}) });
    return this.readMessage(id);
  }

  addMessageLinks(id: string, links: ChatMessageLinks): ChatMessage | undefined {
    const current = this.readMessage(id);
    if (!current) return undefined;
    const merged: ChatMessageLinks = {
      ...(links.issueIds || current.links.issueIds ? { issueIds: [...new Set([...(current.links.issueIds ?? []), ...(links.issueIds ?? [])])].slice(-50) } : {}),
      ...(links.documentIds || current.links.documentIds ? { documentIds: [...new Set([...(current.links.documentIds ?? []), ...(links.documentIds ?? [])])].slice(-50) } : {}),
      ...(links.fileIds || current.links.fileIds ? { fileIds: [...new Set([...(current.links.fileIds ?? []), ...(links.fileIds ?? [])])].slice(-20) } : {}),
    };
    this.db.prepare("UPDATE chat_messages SET links_json = ? WHERE id = ?").run(JSON.stringify(merged), id);
    this.publish({ type: "message_updated", channelId: current.channelId, seq: current.seq, messageId: id, ...(current.threadId ? { threadId: current.threadId } : {}) });
    return this.readMessage(id);
  }

  /** Case-insensitive substring search over live messages in `channelIds`, newest first. */
  searchMessages(channelIds: string[], q: string, limit: number): ChatMessage[] {
    if (channelIds.length === 0) return [];
    const pattern = `%${q.replace(/[\\%_]/g, (char) => `\\${char}`)}%`;
    return (
      this.db
        .prepare("SELECT * FROM chat_messages WHERE channel_id IN (SELECT value FROM json_each(?)) AND deleted_at IS NULL AND body LIKE ? ESCAPE '\\' ORDER BY created_at DESC, seq DESC LIMIT ?")
        .all(JSON.stringify(channelIds), pattern, limit) as MessageRow[]
    ).map(messageFromRow);
  }

  // reactions

  addReaction(messageId: string, memberId: string, emoji: string, createdAt: string): void {
    this.db.prepare("INSERT OR IGNORE INTO chat_reactions (message_id, member_id, emoji, created_at) VALUES (?, ?, ?, ?)").run(messageId, memberId, emoji, createdAt);
    this.publishReaction(messageId);
  }

  removeReaction(messageId: string, memberId: string, emoji: string): boolean {
    const removed = this.db.prepare("DELETE FROM chat_reactions WHERE message_id = ? AND member_id = ? AND emoji = ?").run(messageId, memberId, emoji).changes > 0;
    if (removed) this.publishReaction(messageId);
    return removed;
  }

  countReactions(messageId: string): number {
    return (this.db.prepare("SELECT COUNT(*) AS count FROM chat_reactions WHERE message_id = ?").get(messageId) as { count: number }).count;
  }

  listReactions(messageIds: string[]): Map<string, ChatReaction[]> {
    const grouped = new Map<string, ChatReaction[]>();
    if (messageIds.length === 0) return grouped;
    const rows = this.db
      .prepare("SELECT message_id, emoji, member_id FROM chat_reactions WHERE message_id IN (SELECT value FROM json_each(?)) ORDER BY created_at, member_id")
      .all(JSON.stringify(messageIds)) as Array<{ message_id: string; emoji: string; member_id: string }>;
    for (const row of rows) {
      const reactions = grouped.get(row.message_id) ?? [];
      const reaction = reactions.find((item) => item.emoji === row.emoji);
      if (reaction) reaction.memberIds.push(row.member_id);
      else reactions.push({ emoji: row.emoji, memberIds: [row.member_id] });
      grouped.set(row.message_id, reactions);
    }
    return grouped;
  }

  // mentions

  listMessageMentions(messageIds: string[]): Map<string, string[]> {
    const grouped = new Map<string, string[]>();
    if (messageIds.length === 0) return grouped;
    const rows = this.db
      .prepare("SELECT message_id, mentioned_id FROM chat_mentions WHERE message_id IN (SELECT value FROM json_each(?)) ORDER BY rowid")
      .all(JSON.stringify(messageIds)) as Array<{ message_id: string; mentioned_id: string }>;
    for (const row of rows) grouped.set(row.message_id, [...(grouped.get(row.message_id) ?? []), row.mentioned_id]);
    return grouped;
  }

  /**
   * Messages that mention the agent, newest first. `pending` keeps those the agent has not yet
   * answered with a later message in the same thread.
   */
  listAgentMentions(agentId: string, filter: { pending?: boolean; limit: number }): ChatMention[] {
    const pendingClause = filter.pending
      ? `AND NOT EXISTS (
           SELECT 1 FROM chat_messages reply
           WHERE reply.channel_id = msg.channel_id
             AND reply.agent_id = men.mentioned_id
             AND reply.seq > msg.seq
             AND COALESCE(reply.thread_id, reply.id) = COALESCE(msg.thread_id, msg.id)
         )`
      : "";
    const rows = this.db
      .prepare(
        `SELECT men.message_id, men.channel_id, men.mentioned_id, men.is_agent, men.created_at
         FROM chat_mentions men
         JOIN chat_messages msg ON msg.id = men.message_id AND msg.deleted_at IS NULL
         WHERE men.mentioned_id = ? AND men.is_agent = 1 ${pendingClause}
         ORDER BY men.created_at DESC, msg.seq DESC LIMIT ?`,
      )
      .all(agentId, filter.limit) as Array<{ message_id: string; channel_id: string; mentioned_id: string; is_agent: number; created_at: string }>;
    return rows.map((row) => ({ messageId: row.message_id, channelId: row.channel_id, mentionedId: row.mentioned_id, isAgent: row.is_agent === 1, createdAt: row.created_at }));
  }

  // files

  insertFile(file: ChatFile): ChatFile {
    this.db
      .prepare("INSERT INTO chat_files (id, channel_id, message_id, sha256, filename, content_type, size, uploaded_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(file.id, file.channelId, file.messageId ?? null, file.sha256, file.filename, file.contentType, file.size, file.uploadedBy, file.createdAt);
    return this.readFile(file.id)!;
  }

  readFile(id: string): ChatFile | undefined {
    const row = this.db.prepare("SELECT * FROM chat_files WHERE id = ?").get(id) as FileRow | undefined;
    return row ? fileFromRow(row) : undefined;
  }

  listFiles(ids: string[]): ChatFile[] {
    if (ids.length === 0) return [];
    return (this.db.prepare("SELECT * FROM chat_files WHERE id IN (SELECT value FROM json_each(?)) ORDER BY created_at, id").all(JSON.stringify(ids)) as FileRow[]).map(fileFromRow);
  }

  /** Binds uploaded, still-unattached files to the message that shares them. */
  attachFiles(messageId: string, fileIds: string[]): void {
    const attach = this.db.prepare("UPDATE chat_files SET message_id = ? WHERE id = ? AND message_id IS NULL");
    this.db.transaction(() => {
      for (const id of fileIds) attach.run(messageId, id);
    })();
  }

  /** Bytes of chat files in the space's channels. */
  siteFileBytes(siteId: string): number {
    return (this.db.prepare("SELECT COALESCE(SUM(f.size), 0) AS total FROM chat_files f JOIN chat_channels c ON c.id = f.channel_id WHERE c.site_id = ?").get(siteId) as { total: number }).total;
  }

  /** Bytes of files a user shared in direct messages. */
  dmFileBytes(userId: string): number {
    return (this.db.prepare("SELECT COALESCE(SUM(f.size), 0) AS total FROM chat_files f JOIN chat_channels c ON c.id = f.channel_id WHERE c.kind = 'dm' AND f.uploaded_by = ?").get(userId) as { total: number }).total;
  }

  isBlobReferenced(sha256: string): boolean {
    return Boolean(this.db.prepare("SELECT 1 FROM chat_files WHERE sha256 = ? LIMIT 1").get(sha256));
  }

  // compliance

  listRevisions(messageIds: string[]): Map<string, ChatRevision[]> {
    const grouped = new Map<string, ChatRevision[]>();
    if (messageIds.length === 0) return grouped;
    const rows = this.db
      .prepare("SELECT * FROM chat_revisions WHERE message_id IN (SELECT value FROM json_each(?)) ORDER BY revised_at, rowid")
      .all(JSON.stringify(messageIds)) as Array<{ message_id: string; body: string; action: "edit" | "delete"; revised_by: string; revised_at: string }>;
    for (const row of rows) {
      grouped.set(row.message_id, [...(grouped.get(row.message_id) ?? []), { messageId: row.message_id, body: row.body, action: row.action, revisedBy: row.revised_by, revisedAt: row.revised_at }]);
    }
    return grouped;
  }

  /** Every message of a channel in `seq` order, deleted ones included, optionally within a time window. */
  exportMessages(channelId: string, window: { since?: string; until?: string } = {}): ChatMessage[] {
    return (
      this.db
        .prepare("SELECT * FROM chat_messages WHERE channel_id = ? AND created_at >= ? AND created_at <= ? ORDER BY seq")
        .all(channelId, window.since ?? "", window.until ?? "\uffff") as MessageRow[]
    ).map(messageFromRow);
  }

  /**
   * Retention: removes messages created before `cutoff` in channels `keep` does not protect, with
   * their revisions, mentions, reactions and files. A root whose thread still has newer replies is
   * blanked instead, so the surviving replies keep their thread.
   */
  purgeBefore(cutoff: string, keep: (channel: ChatChannel) => boolean, keepAuthor: (authorId: string) => boolean): ChatPurgeResult {
    const result: ChatPurgeResult = { deletedMessages: 0, blankedRoots: 0, protectedMessages: 0, deletedFiles: 0, fileHashes: [] };
    const channels = new Map(this.listAllChannels().map((channel) => [channel.id, channel]));
    const old = this.db.prepare("SELECT * FROM chat_messages WHERE created_at < ? ORDER BY seq DESC").all(cutoff) as MessageRow[];
    this.db.transaction(() => {
      for (const row of old) {
        const channel = channels.get(row.channel_id);
        if (!channel || keep(channel) || keepAuthor(row.author_id)) {
          result.protectedMessages += 1;
          continue;
        }
        const files = this.db.prepare("SELECT id, sha256 FROM chat_files WHERE message_id = ?").all(row.id) as Array<{ id: string; sha256: string }>;
        for (const file of files) result.fileHashes.push(file.sha256);
        result.deletedFiles += files.length;
        this.db.prepare("DELETE FROM chat_files WHERE message_id = ?").run(row.id);
        this.db.prepare("DELETE FROM chat_revisions WHERE message_id = ?").run(row.id);
        this.db.prepare("DELETE FROM chat_mentions WHERE message_id = ?").run(row.id);
        this.db.prepare("DELETE FROM chat_reactions WHERE message_id = ?").run(row.id);
        const newerReplies = this.db.prepare("SELECT 1 FROM chat_messages WHERE thread_id = ? LIMIT 1").get(row.id);
        if (newerReplies) {
          this.db.prepare("UPDATE chat_messages SET body = '', links_json = '{}', deleted_at = COALESCE(deleted_at, ?) WHERE id = ?").run(cutoff, row.id);
          result.blankedRoots += 1;
        } else {
          this.db.prepare("DELETE FROM chat_messages WHERE id = ?").run(row.id);
          if (row.thread_id) this.db.prepare("UPDATE chat_messages SET reply_count = MAX(reply_count - 1, 0) WHERE id = ?").run(row.thread_id);
          result.deletedMessages += 1;
        }
      }
      const orphans = this.db.prepare("SELECT id, channel_id, sha256 FROM chat_files WHERE message_id IS NULL AND created_at < ?").all(cutoff) as Array<{ id: string; channel_id: string; sha256: string }>;
      for (const file of orphans) {
        const channel = channels.get(file.channel_id);
        if (channel && keep(channel)) continue;
        this.db.prepare("DELETE FROM chat_files WHERE id = ?").run(file.id);
        result.fileHashes.push(file.sha256);
        result.deletedFiles += 1;
      }
    })();
    result.fileHashes = [...new Set(result.fileHashes)];
    return result;
  }

  private insertRevision(revision: ChatRevision): void {
    this.db
      .prepare("INSERT INTO chat_revisions (message_id, body, action, revised_by, revised_at) VALUES (?, ?, ?, ?, ?)")
      .run(revision.messageId, revision.body, revision.action, revision.revisedBy, revision.revisedAt);
  }

  // realtime

  /** Calls `listener` for every write to the channel until the returned function is called. */
  subscribe(channelId: string, listener: (event: ChatEvent) => void): () => void {
    const key = `channel:${channelId}`;
    this.events.on(key, listener);
    return () => this.events.off(key, listener);
  }

  /**
   * Registers a long-lived stream for `ownerId` so `closeStreams` (server shutdown) can end it.
   * Returns undefined, without registering, when the owner already holds `maxPerOwner` streams.
   */
  trackStream(ownerId: string, close: () => void, maxPerOwner: number): (() => void) | undefined {
    let open = 0;
    for (const owner of this.streams.values()) if (owner === ownerId) open += 1;
    if (open >= maxPerOwner) return undefined;
    this.streams.set(close, ownerId);
    return () => this.streams.delete(close);
  }

  closeStreams(): void {
    for (const close of [...this.streams.keys()]) close();
    this.streams.clear();
  }

  private publish(event: ChatEvent): void {
    this.events.emit(`channel:${event.channelId}`, event);
  }

  private publishReaction(messageId: string): void {
    const message = this.readMessage(messageId);
    if (message) this.publish({ type: "reaction", channelId: message.channelId, seq: message.seq, messageId, ...(message.threadId ? { threadId: message.threadId } : {}) });
  }

  private applySchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS chat_channels (
        id TEXT PRIMARY KEY,
        site_id TEXT NOT NULL,
        project_id TEXT,
        name TEXT NOT NULL,
        topic TEXT,
        visibility TEXT NOT NULL CHECK (visibility IN ('public', 'private')),
        created_by TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        archived_at TEXT,
        last_seq INTEGER NOT NULL DEFAULT 0,
        last_message_at TEXT,
        UNIQUE (site_id, name)
      );
      CREATE INDEX IF NOT EXISTS chat_channels_project ON chat_channels (project_id);

      CREATE TABLE IF NOT EXISTS chat_members (
        channel_id TEXT NOT NULL,
        member_id TEXT NOT NULL,
        member_type TEXT NOT NULL CHECK (member_type IN ('user', 'agent')),
        role TEXT NOT NULL CHECK (role IN ('member', 'admin')),
        joined_at TEXT NOT NULL,
        last_read_seq INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (channel_id, member_id)
      );
      CREATE INDEX IF NOT EXISTS chat_members_member ON chat_members (member_id);

      CREATE TABLE IF NOT EXISTS chat_messages (
        id TEXT PRIMARY KEY,
        channel_id TEXT NOT NULL,
        seq INTEGER NOT NULL,
        thread_id TEXT,
        kind TEXT NOT NULL CHECK (kind IN ('message', 'system')),
        author_id TEXT NOT NULL,
        agent_id TEXT,
        body TEXT NOT NULL,
        links_json TEXT NOT NULL,
        reply_count INTEGER NOT NULL DEFAULT 0,
        last_reply_at TEXT,
        created_at TEXT NOT NULL,
        edited_at TEXT,
        deleted_at TEXT,
        UNIQUE (channel_id, seq)
      );
      CREATE INDEX IF NOT EXISTS chat_messages_thread ON chat_messages (thread_id, seq);

      CREATE TABLE IF NOT EXISTS chat_reactions (
        message_id TEXT NOT NULL,
        member_id TEXT NOT NULL,
        emoji TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (message_id, member_id, emoji)
      );

      CREATE TABLE IF NOT EXISTS chat_mentions (
        message_id TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        mentioned_id TEXT NOT NULL,
        is_agent INTEGER NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (message_id, mentioned_id)
      );
      CREATE INDEX IF NOT EXISTS chat_mentions_mentioned ON chat_mentions (mentioned_id, created_at);

      CREATE TABLE IF NOT EXISTS chat_files (
        id TEXT PRIMARY KEY,
        channel_id TEXT NOT NULL,
        message_id TEXT,
        sha256 TEXT NOT NULL,
        filename TEXT NOT NULL,
        content_type TEXT NOT NULL,
        size INTEGER NOT NULL,
        uploaded_by TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS chat_files_message ON chat_files (message_id);
      CREATE INDEX IF NOT EXISTS chat_files_sha ON chat_files (sha256);

      CREATE TABLE IF NOT EXISTS chat_revisions (
        message_id TEXT NOT NULL,
        body TEXT NOT NULL,
        action TEXT NOT NULL CHECK (action IN ('edit', 'delete')),
        revised_by TEXT NOT NULL,
        revised_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS chat_revisions_message ON chat_revisions (message_id);
    `);
    const columns = new Set((this.db.prepare("PRAGMA table_info(chat_channels)").all() as Array<{ name: string }>).map((column) => column.name));
    if (!columns.has("kind")) this.db.exec("ALTER TABLE chat_channels ADD COLUMN kind TEXT NOT NULL DEFAULT 'channel'");
    if (!columns.has("dm_key")) this.db.exec("ALTER TABLE chat_channels ADD COLUMN dm_key TEXT");
    this.db.exec("CREATE UNIQUE INDEX IF NOT EXISTS chat_channels_dm_key ON chat_channels (dm_key) WHERE dm_key IS NOT NULL");
  }
}

interface FileRow {
  id: string;
  channel_id: string;
  message_id: string | null;
  sha256: string;
  filename: string;
  content_type: string;
  size: number;
  uploaded_by: string;
  created_at: string;
}

function fileFromRow(row: FileRow): ChatFile {
  return {
    id: row.id,
    channelId: row.channel_id,
    ...(row.message_id ? { messageId: row.message_id } : {}),
    sha256: row.sha256,
    filename: row.filename,
    contentType: row.content_type,
    size: row.size,
    uploadedBy: row.uploaded_by,
    createdAt: row.created_at,
  };
}

function channelFromRow(row: ChannelRow): ChatChannel {
  return {
    id: row.id,
    kind: row.kind ?? "channel",
    siteId: row.site_id,
    ...(row.project_id ? { projectId: row.project_id } : {}),
    name: row.name,
    ...(row.topic ? { topic: row.topic } : {}),
    visibility: row.visibility,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.archived_at ? { archivedAt: row.archived_at } : {}),
    lastSeq: row.last_seq,
    ...(row.last_message_at ? { lastMessageAt: row.last_message_at } : {}),
  };
}

function memberFromRow(row: MemberRow): ChatMember {
  return { channelId: row.channel_id, memberId: row.member_id, memberType: row.member_type, role: row.role, joinedAt: row.joined_at, lastReadSeq: row.last_read_seq };
}

function messageFromRow(row: MessageRow): ChatMessage {
  return {
    id: row.id,
    channelId: row.channel_id,
    seq: row.seq,
    ...(row.thread_id ? { threadId: row.thread_id } : {}),
    kind: row.kind,
    authorId: row.author_id,
    ...(row.agent_id ? { agentId: row.agent_id } : {}),
    body: row.body,
    links: JSON.parse(row.links_json) as ChatMessageLinks,
    replyCount: row.reply_count,
    ...(row.last_reply_at ? { lastReplyAt: row.last_reply_at } : {}),
    createdAt: row.created_at,
    ...(row.edited_at ? { editedAt: row.edited_at } : {}),
    ...(row.deleted_at ? { deletedAt: row.deleted_at } : {}),
  };
}
