/**
 * Compliance state for Noma Cloud: the data-loss-prevention policy and its findings, and the SIEM
 * forwarder's cursor. Shares the Cloud SQLite file through its own connection. Findings never store
 * the matched text — only which detector fired, where, and for whom.
 */
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import DatabaseConstructor from "better-sqlite3";

type SqliteDatabase = InstanceType<typeof DatabaseConstructor>;

export type DlpMode = "off" | "warn" | "block";
export const DLP_DETECTORS = ["aws_access_key", "github_token", "slack_token", "private_key", "api_key", "credit_card"] as const;
export type DlpDetector = (typeof DLP_DETECTORS)[number];

export interface DlpPolicy {
  mode: DlpMode;
  detectors: DlpDetector[];
  updatedBy?: string;
  updatedAt?: string;
}

export interface DlpFinding {
  id: string;
  detectors: DlpDetector[];
  outcome: "blocked" | "flagged";
  resourceType: "chat_message" | "chat_channel" | "document" | "issue";
  resourceId: string;
  siteId?: string;
  actorId: string;
  createdAt: string;
}

export interface SiemStatus {
  /** Highest audit sequence delivered to the SIEM. */
  cursor: number;
  lastShippedAt?: string;
  lastBatch?: number;
  lastError?: string;
  lastErrorAt?: string;
}

interface FindingRow {
  id: string;
  detectors_json: string;
  outcome: "blocked" | "flagged";
  resource_type: DlpFinding["resourceType"];
  resource_id: string;
  site_id: string | null;
  actor_id: string;
  created_at: string;
}

export class CloudComplianceStore {
  private readonly db: SqliteDatabase;

  constructor(dbPath: string) {
    mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseConstructor(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("busy_timeout = 5000");
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS compliance_settings (
        key TEXT PRIMARY KEY,
        value_json TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS dlp_findings (
        id TEXT PRIMARY KEY,
        detectors_json TEXT NOT NULL,
        outcome TEXT NOT NULL,
        resource_type TEXT NOT NULL,
        resource_id TEXT NOT NULL,
        site_id TEXT,
        actor_id TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS dlp_findings_created ON dlp_findings (created_at);
    `);
  }

  close(): void {
    this.db.close();
  }

  dlpPolicy(): DlpPolicy {
    return this.setting<DlpPolicy>("dlp") ?? { mode: "off", detectors: [...DLP_DETECTORS] };
  }

  setDlpPolicy(policy: DlpPolicy): DlpPolicy {
    this.writeSetting("dlp", policy);
    return this.dlpPolicy();
  }

  siemStatus(): SiemStatus {
    return this.setting<SiemStatus>("siem") ?? { cursor: 0 };
  }

  setSiemStatus(status: SiemStatus): SiemStatus {
    this.writeSetting("siem", status);
    return this.siemStatus();
  }

  recordFinding(finding: DlpFinding): void {
    this.db
      .prepare("INSERT INTO dlp_findings (id, detectors_json, outcome, resource_type, resource_id, site_id, actor_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(finding.id, JSON.stringify(finding.detectors), finding.outcome, finding.resourceType, finding.resourceId, finding.siteId ?? null, finding.actorId, finding.createdAt);
  }

  listFindings(since: string, limit = 100): DlpFinding[] {
    return (this.db.prepare("SELECT * FROM dlp_findings WHERE created_at >= ? ORDER BY created_at DESC, id DESC LIMIT ?").all(since, limit) as FindingRow[]).map((row) => ({
      id: row.id,
      detectors: JSON.parse(row.detectors_json) as DlpDetector[],
      outcome: row.outcome,
      resourceType: row.resource_type,
      resourceId: row.resource_id,
      ...(row.site_id ? { siteId: row.site_id } : {}),
      actorId: row.actor_id,
      createdAt: row.created_at,
    }));
  }

  findingCounts(since: string): { blocked: number; flagged: number } {
    const rows = this.db.prepare("SELECT outcome, COUNT(*) AS n FROM dlp_findings WHERE created_at >= ? GROUP BY outcome").all(since) as Array<{ outcome: string; n: number }>;
    return { blocked: rows.find((row) => row.outcome === "blocked")?.n ?? 0, flagged: rows.find((row) => row.outcome === "flagged")?.n ?? 0 };
  }

  private setting<T>(key: string): T | undefined {
    const row = this.db.prepare("SELECT value_json FROM compliance_settings WHERE key = ?").get(key) as { value_json: string } | undefined;
    return row ? (JSON.parse(row.value_json) as T) : undefined;
  }

  private writeSetting(key: string, value: unknown): void {
    this.db.prepare("INSERT INTO compliance_settings (key, value_json) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value_json = excluded.value_json").run(key, JSON.stringify(value));
  }
}
