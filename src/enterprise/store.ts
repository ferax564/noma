import DatabaseConstructor from "better-sqlite3";
import type { Database as SqliteDatabase } from "better-sqlite3";
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import { ENTERPRISE_SCHEMA_VERSION } from "./contracts.js";

export function enterpriseSchema(dialect: "sqlite" | "postgres"): string {
  const json = dialect === "postgres" ? "JSONB" : "TEXT";
  const blob = dialect === "postgres" ? "BYTEA" : "BLOB";
  const pk = "TEXT PRIMARY KEY";
  return `
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS tenants (
  id ${pk},
  name TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS principals (
  id ${pk},
  tenant_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  name TEXT NOT NULL,
  email TEXT,
  external_id TEXT,
  active INTEGER NOT NULL DEFAULT 1,
  classification TEXT NOT NULL DEFAULT 'internal',
  capabilities_json ${json},
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS principals_external ON principals(tenant_id, external_id) WHERE external_id IS NOT NULL;
CREATE TABLE IF NOT EXISTS memberships (
  group_id TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  role TEXT NOT NULL,
  PRIMARY KEY (group_id, principal_id)
);
CREATE TABLE IF NOT EXISTS sessions (
  id ${pk},
  principal_id TEXT NOT NULL,
  tenant_id TEXT NOT NULL,
  issued_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  revoked_at TEXT,
  token_hash TEXT NOT NULL UNIQUE
);
CREATE TABLE IF NOT EXISTS spaces (
  id ${pk},
  tenant_id TEXT NOT NULL,
  name TEXT NOT NULL,
  classification TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS projects (
  id ${pk},
  tenant_id TEXT NOT NULL,
  key TEXT NOT NULL,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (tenant_id, key)
);
CREATE TABLE IF NOT EXISTS project_spaces (
  project_id TEXT NOT NULL,
  space_id TEXT NOT NULL,
  PRIMARY KEY (project_id, space_id)
);
CREATE TABLE IF NOT EXISTS grants (
  id ${pk},
  tenant_id TEXT NOT NULL,
  principal_id TEXT NOT NULL,
  resource_kind TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  role TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS documents (
  id ${pk},
  tenant_id TEXT NOT NULL,
  space_id TEXT NOT NULL,
  title TEXT NOT NULL,
  lifecycle TEXT NOT NULL,
  classification TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  published_revision INTEGER,
  draft_revision INTEGER NOT NULL DEFAULT 0,
  draft_source TEXT NOT NULL,
  draft_hash TEXT NOT NULL,
  editor_schema INTEGER NOT NULL DEFAULT 1,
  crdt_json ${json} NOT NULL,
  update_log_json ${json} NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS document_revisions (
  document_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  source TEXT NOT NULL,
  hash TEXT NOT NULL,
  title TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (document_id, revision)
);
CREATE TABLE IF NOT EXISTS artifacts (
  id ${pk},
  tenant_id TEXT NOT NULL,
  space_id TEXT NOT NULL,
  title TEXT NOT NULL,
  classification TEXT NOT NULL,
  owner_id TEXT NOT NULL,
  published_revision INTEGER,
  draft_revision INTEGER NOT NULL DEFAULT 0,
  draft_json ${json} NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS artifact_revisions (
  artifact_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  document_json ${json} NOT NULL,
  hash TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  PRIMARY KEY (artifact_id, revision)
);
CREATE TABLE IF NOT EXISTS assets (
  id ${pk},
  tenant_id TEXT NOT NULL,
  hash TEXT NOT NULL,
  mime TEXT NOT NULL,
  size INTEGER NOT NULL,
  owner_id TEXT NOT NULL,
  classification TEXT NOT NULL,
  scan_state TEXT NOT NULL,
  provenance_json ${json} NOT NULL,
  bytes ${blob} NOT NULL,
  sanitized_bytes ${blob},
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS issue_types (
  id ${pk},
  tenant_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  key TEXT NOT NULL,
  name TEXT NOT NULL,
  hierarchy TEXT NOT NULL,
  schema_version INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS workflows (
  id ${pk},
  tenant_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  activated INTEGER NOT NULL DEFAULT 0,
  definition_json ${json} NOT NULL
);
CREATE TABLE IF NOT EXISTS issues (
  id ${pk},
  tenant_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  key TEXT NOT NULL,
  type_id TEXT NOT NULL,
  summary TEXT NOT NULL,
  description TEXT,
  status_id TEXT NOT NULL,
  resolution TEXT,
  priority TEXT NOT NULL DEFAULT 'medium',
  severity TEXT,
  reporter_id TEXT NOT NULL,
  assignee_id TEXT,
  accountable_id TEXT,
  parent_id TEXT,
  rank TEXT NOT NULL,
  estimate REAL,
  estimate_unit TEXT,
  start_at TEXT,
  due_at TEXT,
  labels_json ${json} NOT NULL,
  components_json ${json} NOT NULL,
  versions_json ${json} NOT NULL,
  sprint_id TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (tenant_id, key)
);
CREATE TABLE IF NOT EXISTS issue_events (
  id ${pk},
  issue_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  action TEXT NOT NULL,
  detail_json ${json} NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS issue_comments (
  id ${pk},
  issue_id TEXT NOT NULL,
  body TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS custom_fields (
  id ${pk},
  tenant_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  key TEXT NOT NULL,
  field_type TEXT NOT NULL,
  schema_version INTEGER NOT NULL DEFAULT 1,
  options_json ${json}
);
CREATE TABLE IF NOT EXISTS field_values (
  issue_id TEXT NOT NULL,
  field_id TEXT NOT NULL,
  schema_version INTEGER NOT NULL,
  value_json ${json} NOT NULL,
  PRIMARY KEY (issue_id, field_id, schema_version)
);
CREATE TABLE IF NOT EXISTS boards (
  id ${pk},
  tenant_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  query_json ${json} NOT NULL,
  columns_json ${json} NOT NULL
);
CREATE TABLE IF NOT EXISTS sprints (
  id ${pk},
  tenant_id TEXT NOT NULL,
  board_id TEXT NOT NULL,
  name TEXT NOT NULL,
  goal TEXT,
  state TEXT NOT NULL,
  start_at TEXT,
  end_at TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS worklogs (
  id ${pk},
  issue_id TEXT NOT NULL,
  author_id TEXT NOT NULL,
  duration_seconds INTEGER NOT NULL,
  visibility TEXT NOT NULL,
  note TEXT,
  created_at TEXT NOT NULL,
  corrected_from TEXT
);
CREATE TABLE IF NOT EXISTS automations (
  id ${pk},
  tenant_id TEXT NOT NULL,
  project_id TEXT NOT NULL,
  event TEXT NOT NULL,
  condition_json ${json} NOT NULL,
  action_json ${json} NOT NULL,
  quota INTEGER NOT NULL DEFAULT 20
);
CREATE TABLE IF NOT EXISTS references_edge (
  id ${pk},
  tenant_id TEXT NOT NULL,
  from_kind TEXT NOT NULL,
  from_id TEXT NOT NULL,
  from_block TEXT,
  to_kind TEXT NOT NULL,
  to_id TEXT NOT NULL,
  to_block TEXT,
  to_revision INTEGER,
  relation TEXT NOT NULL,
  asserted_by TEXT NOT NULL,
  authoritative INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS changesets (
  id ${pk},
  tenant_id TEXT NOT NULL,
  record_json ${json} NOT NULL,
  status TEXT NOT NULL,
  idempotency_key TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (tenant_id, idempotency_key)
);
CREATE TABLE IF NOT EXISTS audit_events (
  id ${pk},
  tenant_id TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  action TEXT NOT NULL,
  resource_kind TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  detail_json ${json} NOT NULL,
  created_at TEXT NOT NULL,
  prev_hash TEXT,
  hash TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS outbox (
  id ${pk},
  tenant_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  payload_json ${json} NOT NULL,
  created_at TEXT NOT NULL,
  processed_at TEXT
);
CREATE TABLE IF NOT EXISTS jobs (
  id ${pk},
  tenant_id TEXT NOT NULL,
  recipe TEXT NOT NULL,
  status TEXT NOT NULL,
  actor_id TEXT NOT NULL,
  payload_json ${json} NOT NULL,
  cost_reserved REAL NOT NULL DEFAULT 0,
  cost_actual REAL NOT NULL DEFAULT 0,
  attempts INTEGER NOT NULL DEFAULT 0,
  lease_until TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS notifications (
  id ${pk},
  tenant_id TEXT NOT NULL,
  user_id TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  resource_kind TEXT,
  resource_id TEXT,
  created_at TEXT NOT NULL,
  read_at TEXT
);
CREATE TABLE IF NOT EXISTS legal_holds (
  id ${pk},
  tenant_id TEXT NOT NULL,
  resource_kind TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  reason TEXT NOT NULL,
  created_by TEXT NOT NULL,
  created_at TEXT NOT NULL,
  released_at TEXT
);
CREATE TABLE IF NOT EXISTS connectors (
  id ${pk},
  tenant_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  mode TEXT NOT NULL,
  cursor TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS import_objects (
  id ${pk},
  connector_id TEXT NOT NULL,
  source_id TEXT NOT NULL,
  noma_id TEXT,
  disposition TEXT NOT NULL,
  report_json ${json} NOT NULL,
  UNIQUE (connector_id, source_id)
);
CREATE TABLE IF NOT EXISTS search_index (
  id ${pk},
  tenant_id TEXT NOT NULL,
  resource_kind TEXT NOT NULL,
  resource_id TEXT NOT NULL,
  block_id TEXT,
  revision INTEGER,
  hash TEXT NOT NULL,
  classification TEXT NOT NULL,
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  policy_version INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS policy (
  tenant_id TEXT PRIMARY KEY,
  kill_switch INTEGER NOT NULL DEFAULT 0,
  policy_version INTEGER NOT NULL DEFAULT 1,
  budget_json ${json} NOT NULL
);
`;
}

export class EnterpriseStore {
  readonly db: SqliteDatabase;

  constructor(dbPath: string) {
    if (dbPath !== ":memory:") mkdirSync(dirname(dbPath), { recursive: true });
    this.db = new DatabaseConstructor(dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.db.exec(enterpriseSchema("sqlite"));
    this.db
      .prepare("INSERT OR IGNORE INTO meta(key, value) VALUES ('schema_version', ?)")
      .run(String(ENTERPRISE_SCHEMA_VERSION));
  }

  close(): void {
    this.db.close();
  }
}
