/**
 * Integration state for Noma Cloud: import ledgers (so Slack and Jira re-imports update instead of
 * duplicating) and the two-way Slack bridge — channel links, the message map that threads replies
 * and stops echo loops, a cache of Slack people, and the outbound queue.
 */
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import DatabaseConstructor from "better-sqlite3";

type SqliteDatabase = InstanceType<typeof DatabaseConstructor>;

export interface SlackBridge {
  channelId: string;
  slackChannelId: string;
  enabled: boolean;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface SlackPerson {
  slackUserId: string;
  name: string;
  email?: string;
  fetchedAt: string;
}

export interface SlackOutboxItem {
  id: string;
  channelId: string;
  messageId: string;
  attempts: number;
  lastError?: string;
  createdAt: string;
}

export class CloudIntegrationsStore {
  private readonly db: SqliteDatabase;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseConstructor(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("busy_timeout = 5000");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS import_ledger (
        source TEXT NOT NULL,
        external_id TEXT NOT NULL,
        noma_id TEXT NOT NULL,
        imported_at TEXT NOT NULL,
        PRIMARY KEY (source, external_id)
      );
      CREATE TABLE IF NOT EXISTS slack_bridges (
        channel_id TEXT PRIMARY KEY,
        slack_channel_id TEXT NOT NULL UNIQUE,
        enabled INTEGER NOT NULL,
        created_by TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS slack_bridge_messages (
        noma_message_id TEXT PRIMARY KEY,
        slack_channel_id TEXT NOT NULL,
        slack_ts TEXT NOT NULL,
        direction TEXT NOT NULL,
        UNIQUE (slack_channel_id, slack_ts)
      );
      CREATE TABLE IF NOT EXISTS slack_people (
        slack_user_id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        email TEXT,
        fetched_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS slack_outbox (
        id TEXT PRIMARY KEY,
        channel_id TEXT NOT NULL,
        message_id TEXT NOT NULL UNIQUE,
        attempts INTEGER NOT NULL DEFAULT 0,
        last_error TEXT,
        claimed_until TEXT,
        created_at TEXT NOT NULL
      );
    `);
  }

  close(): void {
    this.db.close();
  }

  // import ledger

  ledger(source: string, externalId: string): string | undefined {
    return (this.db.prepare("SELECT noma_id FROM import_ledger WHERE source = ? AND external_id = ?").get(source, externalId) as { noma_id: string } | undefined)?.noma_id;
  }

  recordImport(source: string, externalId: string, nomaId: string, importedAt: string): void {
    this.db.prepare("INSERT INTO import_ledger (source, external_id, noma_id, imported_at) VALUES (?, ?, ?, ?) ON CONFLICT(source, external_id) DO UPDATE SET noma_id = excluded.noma_id, imported_at = excluded.imported_at").run(source, externalId, nomaId, importedAt);
  }

  // bridges

  writeBridge(bridge: SlackBridge): SlackBridge {
    this.db
      .prepare(
        `INSERT INTO slack_bridges (channel_id, slack_channel_id, enabled, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(channel_id) DO UPDATE SET slack_channel_id = excluded.slack_channel_id, enabled = excluded.enabled, updated_at = excluded.updated_at`,
      )
      .run(bridge.channelId, bridge.slackChannelId, bridge.enabled ? 1 : 0, bridge.createdBy, bridge.createdAt, bridge.updatedAt);
    return this.readBridge(bridge.channelId)!;
  }

  readBridge(channelId: string): SlackBridge | undefined {
    const row = this.db.prepare("SELECT * FROM slack_bridges WHERE channel_id = ?").get(channelId) as BridgeRow | undefined;
    return row ? bridgeFromRow(row) : undefined;
  }

  bridgeForSlackChannel(slackChannelId: string): SlackBridge | undefined {
    const row = this.db.prepare("SELECT * FROM slack_bridges WHERE slack_channel_id = ?").get(slackChannelId) as BridgeRow | undefined;
    return row ? bridgeFromRow(row) : undefined;
  }

  deleteBridge(channelId: string): boolean {
    return this.db.prepare("DELETE FROM slack_bridges WHERE channel_id = ?").run(channelId).changes > 0;
  }

  // message map

  /** Links a Noma message to its Slack twin; false when either side is already mapped (a duplicate delivery). */
  mapMessage(nomaMessageId: string, slackChannelId: string, slackTs: string, direction: "in" | "out"): boolean {
    return this.db.prepare("INSERT OR IGNORE INTO slack_bridge_messages (noma_message_id, slack_channel_id, slack_ts, direction) VALUES (?, ?, ?, ?)").run(nomaMessageId, slackChannelId, slackTs, direction).changes > 0;
  }

  nomaMessageForSlack(slackChannelId: string, slackTs: string): string | undefined {
    return (this.db.prepare("SELECT noma_message_id FROM slack_bridge_messages WHERE slack_channel_id = ? AND slack_ts = ?").get(slackChannelId, slackTs) as { noma_message_id: string } | undefined)?.noma_message_id;
  }

  slackForNomaMessage(nomaMessageId: string): { slackChannelId: string; slackTs: string; direction: "in" | "out" } | undefined {
    const row = this.db.prepare("SELECT slack_channel_id, slack_ts, direction FROM slack_bridge_messages WHERE noma_message_id = ?").get(nomaMessageId) as { slack_channel_id: string; slack_ts: string; direction: "in" | "out" } | undefined;
    return row ? { slackChannelId: row.slack_channel_id, slackTs: row.slack_ts, direction: row.direction } : undefined;
  }

  // people

  readPerson(slackUserId: string): SlackPerson | undefined {
    const row = this.db.prepare("SELECT * FROM slack_people WHERE slack_user_id = ?").get(slackUserId) as { slack_user_id: string; name: string; email: string | null; fetched_at: string } | undefined;
    return row ? { slackUserId: row.slack_user_id, name: row.name, ...(row.email ? { email: row.email } : {}), fetchedAt: row.fetched_at } : undefined;
  }

  writePerson(person: SlackPerson): void {
    this.db
      .prepare("INSERT INTO slack_people (slack_user_id, name, email, fetched_at) VALUES (?, ?, ?, ?) ON CONFLICT(slack_user_id) DO UPDATE SET name = excluded.name, email = excluded.email, fetched_at = excluded.fetched_at")
      .run(person.slackUserId, person.name, person.email ?? null, person.fetchedAt);
  }

  // outbox

  enqueueOutbound(item: SlackOutboxItem): boolean {
    return this.db.prepare("INSERT OR IGNORE INTO slack_outbox (id, channel_id, message_id, attempts, last_error, created_at) VALUES (?, ?, ?, 0, NULL, ?)").run(item.id, item.channelId, item.messageId, item.createdAt).changes > 0;
  }

  /** Rows no process currently holds a lease on. */
  pendingOutbound(now: string, limit = 50): SlackOutboxItem[] {
    return (
      this.db.prepare("SELECT * FROM slack_outbox WHERE claimed_until IS NULL OR claimed_until < ? ORDER BY created_at, id LIMIT ?").all(now, limit) as Array<{ id: string; channel_id: string; message_id: string; attempts: number; last_error: string | null; created_at: string }>
    ).map((row) => ({ id: row.id, channelId: row.channel_id, messageId: row.message_id, attempts: row.attempts, ...(row.last_error ? { lastError: row.last_error } : {}), createdAt: row.created_at }));
  }

  /** Atomically leases a row until `until`; false when another process holds it (so only one process posts it). */
  claimOutbound(id: string, now: string, until: string): boolean {
    return this.db.prepare("UPDATE slack_outbox SET claimed_until = ? WHERE id = ? AND (claimed_until IS NULL OR claimed_until < ?)").run(until, id, now).changes > 0;
  }

  completeOutbound(id: string): void {
    this.db.prepare("DELETE FROM slack_outbox WHERE id = ?").run(id);
  }

  failOutbound(id: string, error: string, maxAttempts: number): void {
    this.db.prepare("UPDATE slack_outbox SET attempts = attempts + 1, last_error = ?, claimed_until = NULL WHERE id = ?").run(error.slice(0, 300), id);
    this.db.prepare("DELETE FROM slack_outbox WHERE id = ? AND attempts >= ?").run(id, maxAttempts);
  }
}

interface BridgeRow {
  channel_id: string;
  slack_channel_id: string;
  enabled: number;
  created_by: string;
  created_at: string;
  updated_at: string;
}

function bridgeFromRow(row: BridgeRow): SlackBridge {
  return { channelId: row.channel_id, slackChannelId: row.slack_channel_id, enabled: row.enabled === 1, createdBy: row.created_by, createdAt: row.created_at, updatedAt: row.updated_at };
}
