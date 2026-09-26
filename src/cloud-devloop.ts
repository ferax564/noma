/**
 * Dev-loop persistence for Noma Cloud: a Work project's linked repository, the pull requests that
 * reference its issues, webhook delivery dedupe, and deploy/test runs on a run environment (ezkeel).
 * Shares the Cloud SQLite file through its own connection, like `CloudChatStore`.
 */
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import DatabaseConstructor from "better-sqlite3";

type SqliteDatabase = InstanceType<typeof DatabaseConstructor>;

export type DevRunKind = "deploy" | "test";
export type DevRunStatus = "queued" | "running" | "success" | "failed" | "canceled";
export type DevPullState = "open" | "merged" | "closed";
export type DevCiStatus = "pending" | "success" | "failure";

/** A GitHub repository linked to a Work project, with its run-environment policy. */
export interface DevRepo {
  projectId: string;
  siteId: string;
  provider: "github";
  /** `owner/name`. */
  repo: string;
  /** HMAC secret GitHub signs webhook deliveries with (`X-Hub-Signature-256`). */
  webhookSecret: string;
  defaultBranch: string;
  runsEnabled: boolean;
  /** Deploy a preview for every opened or updated pull request. */
  autoPreview: boolean;
  /** Run-environment minutes the project may use per calendar month (UTC). */
  monthlyMinutes: number;
  maxConcurrent: number;
  /** Least space role that may request runs: `editor` (default) or `owner`. */
  minRole: "editor" | "owner";
  linkedBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface DevPullRequest {
  projectId: string;
  number: number;
  title: string;
  url: string;
  headRef: string;
  headSha: string;
  state: DevPullState;
  author: string;
  issueIds: string[];
  ciStatus?: DevCiStatus;
  ciUrl?: string;
  updatedAt: string;
}

export interface DevRun {
  id: string;
  projectId: string;
  kind: DevRunKind;
  ref: string;
  status: DevRunStatus;
  /** Run-environment app name (one per preview branch, one per test run). */
  appName: string;
  /** Provider-side handle (an ezkeel deploy ID) once the run has started. */
  providerRef?: string;
  url?: string;
  issueId?: string;
  pullNumber?: number;
  channelId?: string;
  threadId?: string;
  requestedBy: string;
  agentId?: string;
  error?: string;
  log?: string;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  minutes: number;
}

interface RepoRow {
  project_id: string;
  site_id: string;
  provider: "github";
  repo: string;
  webhook_secret: string;
  default_branch: string;
  runs_enabled: number;
  auto_preview: number;
  monthly_minutes: number;
  max_concurrent: number;
  min_role: "editor" | "owner";
  linked_by: string;
  created_at: string;
  updated_at: string;
}

interface PullRow {
  project_id: string;
  number: number;
  title: string;
  url: string;
  head_ref: string;
  head_sha: string;
  state: DevPullState;
  author: string;
  issue_ids_json: string;
  ci_status: DevCiStatus | null;
  ci_url: string | null;
  updated_at: string;
}

interface RunRow {
  id: string;
  project_id: string;
  kind: DevRunKind;
  ref: string;
  status: DevRunStatus;
  app_name: string;
  provider_ref: string | null;
  url: string | null;
  issue_id: string | null;
  pull_number: number | null;
  channel_id: string | null;
  thread_id: string | null;
  requested_by: string;
  agent_id: string | null;
  error: string | null;
  log: string | null;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  minutes: number;
}

export class CloudDevLoopStore {
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

  // repositories

  writeRepo(repo: DevRepo): DevRepo {
    this.db
      .prepare(
        `INSERT INTO dev_repos (project_id, site_id, provider, repo, webhook_secret, default_branch, runs_enabled, auto_preview, monthly_minutes, max_concurrent, min_role, linked_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(project_id) DO UPDATE SET repo = excluded.repo, webhook_secret = excluded.webhook_secret, default_branch = excluded.default_branch,
           runs_enabled = excluded.runs_enabled, auto_preview = excluded.auto_preview, monthly_minutes = excluded.monthly_minutes,
           max_concurrent = excluded.max_concurrent, min_role = excluded.min_role, updated_at = excluded.updated_at`,
      )
      .run(
        repo.projectId,
        repo.siteId,
        repo.provider,
        repo.repo,
        repo.webhookSecret,
        repo.defaultBranch,
        repo.runsEnabled ? 1 : 0,
        repo.autoPreview ? 1 : 0,
        repo.monthlyMinutes,
        repo.maxConcurrent,
        repo.minRole,
        repo.linkedBy,
        repo.createdAt,
        repo.updatedAt,
      );
    return this.readRepo(repo.projectId)!;
  }

  readRepo(projectId: string): DevRepo | undefined {
    const row = this.db.prepare("SELECT * FROM dev_repos WHERE project_id = ?").get(projectId) as RepoRow | undefined;
    return row ? repoFromRow(row) : undefined;
  }

  deleteRepo(projectId: string): boolean {
    return this.db.prepare("DELETE FROM dev_repos WHERE project_id = ?").run(projectId).changes > 0;
  }

  // webhook deliveries

  /** Records a delivery ID; false when it was already seen (GitHub retries and redeliveries). */
  claimDelivery(deliveryId: string, projectId: string, event: string, receivedAt: string): boolean {
    const result = this.db.prepare("INSERT OR IGNORE INTO dev_hook_deliveries (delivery_id, project_id, event, received_at) VALUES (?, ?, ?, ?)").run(deliveryId, projectId, event, receivedAt);
    return result.changes > 0;
  }

  /** Forgets a delivery whose handling failed, so GitHub's retry is processed. */
  releaseDelivery(deliveryId: string): void {
    this.db.prepare("DELETE FROM dev_hook_deliveries WHERE delivery_id = ?").run(deliveryId);
  }

  // pull requests

  writePull(pull: DevPullRequest): DevPullRequest {
    this.db
      .prepare(
        `INSERT INTO dev_pull_requests (project_id, number, title, url, head_ref, head_sha, state, author, issue_ids_json, ci_status, ci_url, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(project_id, number) DO UPDATE SET title = excluded.title, url = excluded.url, head_ref = excluded.head_ref, head_sha = excluded.head_sha,
           state = excluded.state, author = excluded.author, issue_ids_json = excluded.issue_ids_json, ci_status = excluded.ci_status, ci_url = excluded.ci_url,
           updated_at = excluded.updated_at`,
      )
      .run(
        pull.projectId,
        pull.number,
        pull.title,
        pull.url,
        pull.headRef,
        pull.headSha,
        pull.state,
        pull.author,
        JSON.stringify(pull.issueIds),
        pull.ciStatus ?? null,
        pull.ciUrl ?? null,
        pull.updatedAt,
      );
    return this.readPull(pull.projectId, pull.number)!;
  }

  readPull(projectId: string, number: number): DevPullRequest | undefined {
    const row = this.db.prepare("SELECT * FROM dev_pull_requests WHERE project_id = ? AND number = ?").get(projectId, number) as PullRow | undefined;
    return row ? pullFromRow(row) : undefined;
  }

  listPulls(projectId: string, limit = 100): DevPullRequest[] {
    return (this.db.prepare("SELECT * FROM dev_pull_requests WHERE project_id = ? ORDER BY updated_at DESC, number DESC LIMIT ?").all(projectId, limit) as PullRow[]).map(pullFromRow);
  }

  /** Pull requests whose head is `sha`, or (when no SHA matches) whose open head branch is `ref`. */
  pullsForHead(projectId: string, sha: string | undefined, ref: string | undefined): DevPullRequest[] {
    const bySha = sha ? (this.db.prepare("SELECT * FROM dev_pull_requests WHERE project_id = ? AND head_sha = ?").all(projectId, sha) as PullRow[]) : [];
    if (bySha.length > 0 || !ref) return bySha.map(pullFromRow);
    return (this.db.prepare("SELECT * FROM dev_pull_requests WHERE project_id = ? AND head_ref = ? AND state = 'open'").all(projectId, ref) as PullRow[]).map(pullFromRow);
  }

  pullsForIssue(issueId: string): DevPullRequest[] {
    return (
      this.db
        .prepare("SELECT p.* FROM dev_pull_requests p WHERE EXISTS (SELECT 1 FROM json_each(p.issue_ids_json) WHERE value = ?) ORDER BY p.updated_at DESC")
        .all(issueId) as PullRow[]
    ).map(pullFromRow);
  }

  // runs

  insertRun(run: DevRun): DevRun {
    this.db
      .prepare(
        `INSERT INTO dev_runs (id, project_id, kind, ref, status, app_name, provider_ref, url, issue_id, pull_number, channel_id, thread_id, requested_by, agent_id, error, log, created_at, started_at, finished_at, minutes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        run.id,
        run.projectId,
        run.kind,
        run.ref,
        run.status,
        run.appName,
        run.providerRef ?? null,
        run.url ?? null,
        run.issueId ?? null,
        run.pullNumber ?? null,
        run.channelId ?? null,
        run.threadId ?? null,
        run.requestedBy,
        run.agentId ?? null,
        run.error ?? null,
        run.log ?? null,
        run.createdAt,
        run.startedAt ?? null,
        run.finishedAt ?? null,
        run.minutes,
      );
    return this.readRun(run.id)!;
  }

  updateRun(id: string, patch: Partial<Pick<DevRun, "status" | "providerRef" | "url" | "error" | "log" | "startedAt" | "finishedAt" | "minutes" | "channelId" | "threadId">>): DevRun | undefined {
    const current = this.readRun(id);
    if (!current) return undefined;
    const next = { ...current, ...patch };
    this.db
      .prepare("UPDATE dev_runs SET status = ?, provider_ref = ?, url = ?, error = ?, log = ?, started_at = ?, finished_at = ?, minutes = ?, channel_id = ?, thread_id = ? WHERE id = ?")
      .run(next.status, next.providerRef ?? null, next.url ?? null, next.error ?? null, next.log ?? null, next.startedAt ?? null, next.finishedAt ?? null, next.minutes, next.channelId ?? null, next.threadId ?? null, id);
    return this.readRun(id);
  }

  /**
   * Moves a run out of `from` statuses and applies `patch`; false when another caller already moved it
   * (the poller and a status read can race — only one may post the outcome).
   */
  transitionRun(id: string, from: DevRunStatus[], patch: Parameters<CloudDevLoopStore["updateRun"]>[1]): DevRun | undefined {
    return this.db.transaction(() => {
      const current = this.readRun(id);
      if (!current || !from.includes(current.status)) return undefined;
      return this.updateRun(id, patch);
    })();
  }

  readRun(id: string): DevRun | undefined {
    const row = this.db.prepare("SELECT * FROM dev_runs WHERE id = ?").get(id) as RunRow | undefined;
    return row ? runFromRow(row) : undefined;
  }

  listRuns(projectId: string, filter: { limit?: number; issueId?: string } = {}): DevRun[] {
    const rows = filter.issueId
      ? (this.db.prepare("SELECT * FROM dev_runs WHERE project_id = ? AND issue_id = ? ORDER BY created_at DESC, id DESC LIMIT ?").all(projectId, filter.issueId, filter.limit ?? 50) as RunRow[])
      : (this.db.prepare("SELECT * FROM dev_runs WHERE project_id = ? ORDER BY created_at DESC, id DESC LIMIT ?").all(projectId, filter.limit ?? 50) as RunRow[]);
    return rows.map(runFromRow);
  }

  /** Runs still queued or running, oldest first — the poller's work list. */
  listActiveRuns(limit = 100): DevRun[] {
    return (this.db.prepare("SELECT * FROM dev_runs WHERE status IN ('queued', 'running') ORDER BY created_at, id LIMIT ?").all(limit) as RunRow[]).map(runFromRow);
  }

  activeRunCount(projectId: string): number {
    return (this.db.prepare("SELECT COUNT(*) AS n FROM dev_runs WHERE project_id = ? AND status IN ('queued', 'running')").get(projectId) as { n: number }).n;
  }

  /** Billed run minutes since `since` (the start of the month). */
  minutesUsed(projectId: string, since: string): number {
    return (this.db.prepare("SELECT COALESCE(SUM(minutes), 0) AS n FROM dev_runs WHERE project_id = ? AND created_at >= ?").get(projectId, since) as { n: number }).n;
  }

  /** The latest successful deploy of a branch, to tear its preview down when the pull request closes. */
  latestPreview(projectId: string, ref: string): DevRun | undefined {
    const row = this.db.prepare("SELECT * FROM dev_runs WHERE project_id = ? AND kind = 'deploy' AND ref = ? ORDER BY created_at DESC, id DESC LIMIT 1").get(projectId, ref) as RunRow | undefined;
    return row ? runFromRow(row) : undefined;
  }

  private applySchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS dev_repos (
        project_id TEXT PRIMARY KEY,
        site_id TEXT NOT NULL,
        provider TEXT NOT NULL,
        repo TEXT NOT NULL,
        webhook_secret TEXT NOT NULL,
        default_branch TEXT NOT NULL,
        runs_enabled INTEGER NOT NULL DEFAULT 0,
        auto_preview INTEGER NOT NULL DEFAULT 0,
        monthly_minutes INTEGER NOT NULL DEFAULT 600,
        max_concurrent INTEGER NOT NULL DEFAULT 2,
        min_role TEXT NOT NULL DEFAULT 'editor',
        linked_by TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS dev_hook_deliveries (
        delivery_id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        event TEXT NOT NULL,
        received_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS dev_pull_requests (
        project_id TEXT NOT NULL,
        number INTEGER NOT NULL,
        title TEXT NOT NULL,
        url TEXT NOT NULL,
        head_ref TEXT NOT NULL,
        head_sha TEXT NOT NULL,
        state TEXT NOT NULL,
        author TEXT NOT NULL,
        issue_ids_json TEXT NOT NULL,
        ci_status TEXT,
        ci_url TEXT,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (project_id, number)
      );
      CREATE INDEX IF NOT EXISTS dev_pull_requests_head ON dev_pull_requests (project_id, head_sha);
      CREATE TABLE IF NOT EXISTS dev_runs (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        ref TEXT NOT NULL,
        status TEXT NOT NULL,
        app_name TEXT NOT NULL,
        provider_ref TEXT,
        url TEXT,
        issue_id TEXT,
        pull_number INTEGER,
        channel_id TEXT,
        thread_id TEXT,
        requested_by TEXT NOT NULL,
        agent_id TEXT,
        error TEXT,
        log TEXT,
        created_at TEXT NOT NULL,
        started_at TEXT,
        finished_at TEXT,
        minutes INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS dev_runs_project ON dev_runs (project_id, created_at);
      CREATE INDEX IF NOT EXISTS dev_runs_status ON dev_runs (status);
    `);
  }
}

function repoFromRow(row: RepoRow): DevRepo {
  return {
    projectId: row.project_id,
    siteId: row.site_id,
    provider: row.provider,
    repo: row.repo,
    webhookSecret: row.webhook_secret,
    defaultBranch: row.default_branch,
    runsEnabled: row.runs_enabled === 1,
    autoPreview: row.auto_preview === 1,
    monthlyMinutes: row.monthly_minutes,
    maxConcurrent: row.max_concurrent,
    minRole: row.min_role,
    linkedBy: row.linked_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function pullFromRow(row: PullRow): DevPullRequest {
  return {
    projectId: row.project_id,
    number: row.number,
    title: row.title,
    url: row.url,
    headRef: row.head_ref,
    headSha: row.head_sha,
    state: row.state,
    author: row.author,
    issueIds: JSON.parse(row.issue_ids_json) as string[],
    ...(row.ci_status ? { ciStatus: row.ci_status } : {}),
    ...(row.ci_url ? { ciUrl: row.ci_url } : {}),
    updatedAt: row.updated_at,
  };
}

function runFromRow(row: RunRow): DevRun {
  return {
    id: row.id,
    projectId: row.project_id,
    kind: row.kind,
    ref: row.ref,
    status: row.status,
    appName: row.app_name,
    ...(row.provider_ref ? { providerRef: row.provider_ref } : {}),
    ...(row.url ? { url: row.url } : {}),
    ...(row.issue_id ? { issueId: row.issue_id } : {}),
    ...(row.pull_number !== null ? { pullNumber: row.pull_number } : {}),
    ...(row.channel_id ? { channelId: row.channel_id } : {}),
    ...(row.thread_id ? { threadId: row.thread_id } : {}),
    requestedBy: row.requested_by,
    ...(row.agent_id ? { agentId: row.agent_id } : {}),
    ...(row.error ? { error: row.error } : {}),
    ...(row.log ? { log: row.log } : {}),
    createdAt: row.created_at,
    ...(row.started_at ? { startedAt: row.started_at } : {}),
    ...(row.finished_at ? { finishedAt: row.finished_at } : {}),
    minutes: row.minutes,
  };
}
