export type EnterpriseDialect = "sqlite" | "postgres";

export interface SqlRunResult {
  changes: number;
}

export interface SqlStatement {
  run(...params: unknown[]): SqlRunResult;
  get(...params: unknown[]): unknown;
  all(...params: unknown[]): unknown[];
}

export interface SqlDatabase {
  dialect: EnterpriseDialect;
  prepare(sql: string): SqlStatement;
  exec(sql: string): void;
  pragma(source: string): void;
  transaction<T>(fn: () => T): () => T;
  close(): void;
}

const REPLACE_TABLE_PK: Record<string, string[]> = {
  meta: ["key"],
  tenants: ["id"],
  principals: ["id"],
  memberships: ["group_id", "principal_id"],
  sessions: ["id"],
  spaces: ["id"],
  projects: ["id"],
  project_spaces: ["project_id", "space_id"],
  grants: ["id"],
  documents: ["id"],
  document_revisions: ["document_id", "revision"],
  document_comments: ["id"],
  document_assets: ["id"],
  external_links: ["id"],
  artifacts: ["id"],
  artifact_revisions: ["artifact_id", "revision"],
  assets: ["id"],
  issue_types: ["id"],
  workflows: ["id"],
  issues: ["id"],
  issue_events: ["id"],
  issue_comments: ["id"],
  custom_fields: ["id"],
  field_values: ["issue_id", "field_id", "schema_version"],
  boards: ["id"],
  sprints: ["id"],
  worklogs: ["id"],
  automations: ["id"],
  references_edge: ["id"],
  changesets: ["id"],
  audit_events: ["id"],
  outbox: ["id"],
  jobs: ["id"],
  notifications: ["id"],
  legal_holds: ["id"],
  connectors: ["id"],
  import_objects: ["connector_id", "source_id"],
  search_index: ["id"],
  policy: ["tenant_id"],
  crdt_updates: ["id"],
  issue_security_levels: ["id"],
  issue_security_grants: ["level_id", "principal_id"],
  knowledge_health: ["id"],
  cutover_runs: ["id"],
  rag_evals: ["id"],
  jobs_dead_letter: ["id"],
};

export function translateSqliteToPostgres(sql: string): string {
  const trimmed = sql.trim();
  const ignore = /^INSERT\s+OR\s+IGNORE\s+INTO/i.test(trimmed);
  const replace = /^INSERT\s+OR\s+REPLACE\s+INTO/i.test(trimmed);
  let body = trimmed
    .replace(/^INSERT\s+OR\s+IGNORE\s+INTO/i, "INSERT INTO")
    .replace(/^INSERT\s+OR\s+REPLACE\s+INTO/i, "INSERT INTO");
  let index = 0;
  body = body.replace(/\?/g, () => `$${++index}`);
  if (ignore) return `${body} ON CONFLICT DO NOTHING`;
  if (replace) {
    const table = body.match(/^INSERT INTO\s+(\w+)/i)?.[1];
    const columns = body.match(/\(([^)]+)\)\s*VALUES/i)?.[1];
    if (!table || !columns) return body;
    const cols = columns.split(",").map((item) => item.trim());
    const pk = REPLACE_TABLE_PK[table] ?? (cols[0] ? [cols[0]] : []);
    const updates = cols.filter((col) => !pk.includes(col)).map((col) => `${col} = excluded.${col}`);
    if (pk.length === 0) return body;
    if (updates.length === 0) return `${body} ON CONFLICT (${pk.join(", ")}) DO NOTHING`;
    return `${body} ON CONFLICT (${pk.join(", ")}) DO UPDATE SET ${updates.join(", ")}`;
  }
  return body;
}

export interface PostgresBridge {
  exec(sql: string): void;
  query(sql: string, params: unknown[]): { rows: unknown[]; rowCount: number };
  close(): void;
}

class PostgresStatement implements SqlStatement {
  constructor(
    private readonly bridge: PostgresBridge,
    private readonly sql: string,
  ) {}

  run(...params: unknown[]): SqlRunResult {
    const result = this.bridge.query(this.sql, params);
    return { changes: result.rowCount };
  }

  get(...params: unknown[]): unknown {
    return this.bridge.query(this.sql, params).rows[0];
  }

  all(...params: unknown[]): unknown[] {
    return this.bridge.query(this.sql, params).rows;
  }
}

export class PostgresDatabase implements SqlDatabase {
  readonly dialect = "postgres" as const;

  constructor(private readonly bridge: PostgresBridge) {}

  prepare(sql: string): SqlStatement {
    return new PostgresStatement(this.bridge, translateSqliteToPostgres(sql));
  }

  exec(sql: string): void {
    const statements = sql
      .split(";")
      .map((part) => part.trim())
      .filter(Boolean);
    for (const statement of statements) this.bridge.exec(translateSqliteToPostgres(statement));
  }

  pragma(): void {}

  transaction<T>(fn: () => T): () => T {
    return () => {
      this.bridge.exec("BEGIN");
      try {
        const result = fn();
        this.bridge.exec("COMMIT");
        return result;
      } catch (error) {
        this.bridge.exec("ROLLBACK");
        throw error;
      }
    };
  }

  close(): void {
    this.bridge.close();
  }
}
