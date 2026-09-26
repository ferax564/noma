/**
 * Unattended-agent persistence for Noma Cloud: hosted agents (answer chat mentions on the configured
 * language model), scheduled agents (post digests and triage on a cadence), their job queue, and the
 * workspace agent kill switch. Shares the Cloud SQLite file through its own connection.
 */
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import DatabaseConstructor from "better-sqlite3";

type SqliteDatabase = InstanceType<typeof DatabaseConstructor>;

export interface AgentHosting {
  agentId: string;
  enabled: boolean;
  /** Standing instructions prepended to every run (role, tone, what to do and not do). */
  instructions: string;
  updatedBy: string;
  updatedAt: string;
}

export type AgentScheduleCadence = "hourly" | "daily" | "weekly";

export interface AgentSchedule {
  id: string;
  agentId: string;
  siteId: string;
  channelId: string;
  title: string;
  prompt: string;
  cadence: AgentScheduleCadence;
  /** UTC hour for daily and weekly runs. */
  hourUtc: number;
  /** 0 = Sunday, for weekly runs. */
  weekday: number;
  enabled: boolean;
  nextRunAt: string;
  lastRunAt?: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export type AgentJobKind = "mention" | "schedule";
export type AgentJobStatus = "queued" | "running" | "done" | "failed" | "skipped";

export interface AgentJob {
  id: string;
  agentId: string;
  kind: AgentJobKind;
  /** `mention`: channelId + messageId; `schedule`: scheduleId. */
  source: { channelId?: string; messageId?: string; scheduleId?: string };
  status: AgentJobStatus;
  error?: string;
  costUsd: number;
  resultMessageId?: string;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
}

export interface AgentKillSwitch {
  paused: boolean;
  reason?: string;
  updatedBy?: string;
  updatedAt?: string;
}

interface HostingRow {
  agent_id: string;
  enabled: number;
  instructions: string;
  updated_by: string;
  updated_at: string;
}

interface ScheduleRow {
  id: string;
  agent_id: string;
  site_id: string;
  channel_id: string;
  title: string;
  prompt: string;
  cadence: AgentScheduleCadence;
  hour_utc: number;
  weekday: number;
  enabled: number;
  next_run_at: string;
  last_run_at: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
}

interface JobRow {
  id: string;
  agent_id: string;
  kind: AgentJobKind;
  source_json: string;
  status: AgentJobStatus;
  error: string | null;
  cost_usd: number;
  result_message_id: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
}

export class CloudAgentOpsStore {
  private readonly db: SqliteDatabase;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseConstructor(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("busy_timeout = 5000");
    this.applySchema();
  }

  close(): void {
    this.db.close();
  }

  // kill switch

  killSwitch(): AgentKillSwitch {
    const row = this.db.prepare("SELECT value_json FROM agent_ops_settings WHERE key = 'kill_switch'").get() as { value_json: string } | undefined;
    return row ? (JSON.parse(row.value_json) as AgentKillSwitch) : { paused: false };
  }

  setKillSwitch(value: AgentKillSwitch): AgentKillSwitch {
    this.db.prepare("INSERT INTO agent_ops_settings (key, value_json) VALUES ('kill_switch', ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json").run(JSON.stringify(value));
    return this.killSwitch();
  }

  // hosting

  readHosting(agentId: string): AgentHosting | undefined {
    const row = this.db.prepare("SELECT * FROM agent_hosting WHERE agent_id = ?").get(agentId) as HostingRow | undefined;
    return row ? { agentId: row.agent_id, enabled: row.enabled === 1, instructions: row.instructions, updatedBy: row.updated_by, updatedAt: row.updated_at } : undefined;
  }

  writeHosting(hosting: AgentHosting): AgentHosting {
    this.db
      .prepare(
        `INSERT INTO agent_hosting (agent_id, enabled, instructions, updated_by, updated_at) VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(agent_id) DO UPDATE SET enabled = excluded.enabled, instructions = excluded.instructions, updated_by = excluded.updated_by, updated_at = excluded.updated_at`,
      )
      .run(hosting.agentId, hosting.enabled ? 1 : 0, hosting.instructions, hosting.updatedBy, hosting.updatedAt);
    return this.readHosting(hosting.agentId)!;
  }

  // schedules

  writeSchedule(schedule: AgentSchedule): AgentSchedule {
    this.db
      .prepare(
        `INSERT INTO agent_schedules (id, agent_id, site_id, channel_id, title, prompt, cadence, hour_utc, weekday, enabled, next_run_at, last_run_at, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET channel_id = excluded.channel_id, title = excluded.title, prompt = excluded.prompt, cadence = excluded.cadence,
           hour_utc = excluded.hour_utc, weekday = excluded.weekday, enabled = excluded.enabled, next_run_at = excluded.next_run_at,
           last_run_at = excluded.last_run_at, updated_at = excluded.updated_at`,
      )
      .run(
        schedule.id,
        schedule.agentId,
        schedule.siteId,
        schedule.channelId,
        schedule.title,
        schedule.prompt,
        schedule.cadence,
        schedule.hourUtc,
        schedule.weekday,
        schedule.enabled ? 1 : 0,
        schedule.nextRunAt,
        schedule.lastRunAt ?? null,
        schedule.createdBy,
        schedule.createdAt,
        schedule.updatedAt,
      );
    return this.readSchedule(schedule.id)!;
  }

  readSchedule(id: string): AgentSchedule | undefined {
    const row = this.db.prepare("SELECT * FROM agent_schedules WHERE id = ?").get(id) as ScheduleRow | undefined;
    return row ? scheduleFromRow(row) : undefined;
  }

  listSchedules(agentId: string): AgentSchedule[] {
    return (this.db.prepare("SELECT * FROM agent_schedules WHERE agent_id = ? ORDER BY created_at, id").all(agentId) as ScheduleRow[]).map(scheduleFromRow);
  }

  deleteSchedule(id: string): boolean {
    return this.db.prepare("DELETE FROM agent_schedules WHERE id = ?").run(id).changes > 0;
  }

  /** Enabled schedules whose next run is at or before `now`. */
  dueSchedules(now: string, limit = 20): AgentSchedule[] {
    return (this.db.prepare("SELECT * FROM agent_schedules WHERE enabled = 1 AND next_run_at <= ? ORDER BY next_run_at, id LIMIT ?").all(now, limit) as ScheduleRow[]).map(scheduleFromRow);
  }

  // jobs

  insertJob(job: AgentJob): AgentJob {
    this.db
      .prepare("INSERT INTO agent_jobs (id, agent_id, kind, source_json, status, error, cost_usd, result_message_id, created_at, started_at, finished_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)")
      .run(job.id, job.agentId, job.kind, JSON.stringify(job.source), job.status, job.error ?? null, job.costUsd, job.resultMessageId ?? null, job.createdAt, job.startedAt ?? null, job.finishedAt ?? null);
    return this.readJob(job.id)!;
  }

  readJob(id: string): AgentJob | undefined {
    const row = this.db.prepare("SELECT * FROM agent_jobs WHERE id = ?").get(id) as JobRow | undefined;
    return row ? jobFromRow(row) : undefined;
  }

  listJobs(agentId: string, limit = 50): AgentJob[] {
    return (this.db.prepare("SELECT * FROM agent_jobs WHERE agent_id = ? ORDER BY created_at DESC, id DESC LIMIT ?").all(agentId, limit) as JobRow[]).map(jobFromRow);
  }

  queuedJobs(limit = 10): AgentJob[] {
    return (this.db.prepare("SELECT * FROM agent_jobs WHERE status = 'queued' ORDER BY created_at, id LIMIT ?").all(limit) as JobRow[]).map(jobFromRow);
  }

  /** Claims a queued job; undefined when another worker already took it. */
  claimJob(id: string, startedAt: string): AgentJob | undefined {
    const changed = this.db.prepare("UPDATE agent_jobs SET status = 'running', started_at = ? WHERE id = ? AND status = 'queued'").run(startedAt, id).changes;
    return changed ? this.readJob(id) : undefined;
  }

  finishJob(id: string, patch: { status: Exclude<AgentJobStatus, "queued" | "running">; error?: string; costUsd?: number; resultMessageId?: string; finishedAt: string }): AgentJob | undefined {
    this.db
      .prepare("UPDATE agent_jobs SET status = ?, error = ?, cost_usd = ?, result_message_id = ?, finished_at = ? WHERE id = ?")
      .run(patch.status, patch.error ?? null, patch.costUsd ?? 0, patch.resultMessageId ?? null, patch.finishedAt, id);
    return this.readJob(id);
  }

  /** Jobs left `running` by a crashed worker go back to the queue. */
  requeueStale(before: string): number {
    return this.db.prepare("UPDATE agent_jobs SET status = 'queued', started_at = NULL WHERE status = 'running' AND started_at < ?").run(before).changes;
  }

  hasJobForMessage(agentId: string, messageId: string): boolean {
    return Boolean(this.db.prepare("SELECT 1 FROM agent_jobs WHERE agent_id = ? AND kind = 'mention' AND json_extract(source_json, '$.messageId') = ?").get(agentId, messageId));
  }

  private applySchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS agent_ops_settings (
        key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS agent_hosting (
        agent_id TEXT PRIMARY KEY,
        enabled INTEGER NOT NULL,
        instructions TEXT NOT NULL,
        updated_by TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS agent_schedules (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        site_id TEXT NOT NULL,
        channel_id TEXT NOT NULL,
        title TEXT NOT NULL,
        prompt TEXT NOT NULL,
        cadence TEXT NOT NULL,
        hour_utc INTEGER NOT NULL,
        weekday INTEGER NOT NULL,
        enabled INTEGER NOT NULL,
        next_run_at TEXT NOT NULL,
        last_run_at TEXT,
        created_by TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS agent_schedules_due ON agent_schedules (enabled, next_run_at);
      CREATE TABLE IF NOT EXISTS agent_jobs (
        id TEXT PRIMARY KEY,
        agent_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        source_json TEXT NOT NULL,
        status TEXT NOT NULL,
        error TEXT,
        cost_usd REAL NOT NULL DEFAULT 0,
        result_message_id TEXT,
        created_at TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT
      );
      CREATE INDEX IF NOT EXISTS agent_jobs_status ON agent_jobs (status, created_at);
      CREATE INDEX IF NOT EXISTS agent_jobs_agent ON agent_jobs (agent_id, created_at);
    `);
  }
}

/** The next run strictly after `from` for a cadence. */
export function nextScheduleRun(cadence: AgentScheduleCadence, hourUtc: number, weekday: number, from: Date): string {
  const next = new Date(from.getTime());
  next.setUTCSeconds(0, 0);
  if (cadence === "hourly") {
    next.setUTCMinutes(0);
    next.setUTCHours(next.getUTCHours() + 1);
    return next.toISOString();
  }
  next.setUTCMinutes(0);
  next.setUTCHours(hourUtc);
  if (next.getTime() <= from.getTime()) next.setUTCDate(next.getUTCDate() + 1);
  if (cadence === "weekly") {
    while (next.getUTCDay() !== weekday) next.setUTCDate(next.getUTCDate() + 1);
  }
  return next.toISOString();
}

function scheduleFromRow(row: ScheduleRow): AgentSchedule {
  return {
    id: row.id,
    agentId: row.agent_id,
    siteId: row.site_id,
    channelId: row.channel_id,
    title: row.title,
    prompt: row.prompt,
    cadence: row.cadence,
    hourUtc: row.hour_utc,
    weekday: row.weekday,
    enabled: row.enabled === 1,
    nextRunAt: row.next_run_at,
    ...(row.last_run_at ? { lastRunAt: row.last_run_at } : {}),
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function jobFromRow(row: JobRow): AgentJob {
  return {
    id: row.id,
    agentId: row.agent_id,
    kind: row.kind,
    source: JSON.parse(row.source_json) as AgentJob["source"],
    status: row.status,
    ...(row.error ? { error: row.error } : {}),
    costUsd: row.cost_usd,
    ...(row.result_message_id ? { resultMessageId: row.result_message_id } : {}),
    createdAt: row.created_at,
    ...(row.started_at ? { startedAt: row.started_at } : {}),
    ...(row.finished_at ? { finishedAt: row.finished_at } : {}),
  };
}
