import DatabaseConstructor from "better-sqlite3";
import type { Database as SqliteDatabase } from "better-sqlite3";
import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Node } from "./ast.js";
import { parse } from "./parser.js";

export type CloudRole = "viewer" | "editor" | "owner";

export interface CloudPermission {
  role: CloudRole;
  addedAt: string;
}

export interface CloudShareLink {
  id: string;
  role: Exclude<CloudRole, "owner">;
  tokenHash: string;
  tokenPreview: string;
  label?: string;
  createdBy: string;
  createdAt: string;
  revokedAt?: string;
}

export interface CloudUserRecord {
  version: 1;
  id: string;
  name: string;
  tokenHash: string;
  tokenPreview: string;
  createdAt: string;
  updatedAt: string;
}

export interface CloudDocumentRecord {
  version: 2;
  id: string;
  title: string;
  source: string;
  hash: string;
  createdAt: string;
  updatedAt: string;
  createdBy: string;
  updatedBy: string;
  permissions: Record<string, CloudPermission>;
  shareLinks: CloudShareLink[];
}

export interface CloudSiteRecord {
  version: 1;
  id: string;
  title: string;
  slug: string;
  documentIds: string[];
  folders?: string[];
  pageFolders?: Record<string, string>;
  createdAt: string;
  updatedAt: string;
  createdBy: string;
  updatedBy: string;
  permissions: Record<string, CloudPermission>;
  shareLinks: CloudShareLink[];
}

export type CloudDbQueryResource = "documents" | "sites" | "blocks" | "users";

export interface CloudDbQuery {
  resource: CloudDbQueryResource;
  q?: string;
  siteId?: string;
  documentId?: string;
  includeSource: boolean;
  limit: number;
  offset: number;
}

export interface CloudDbQueryResult {
  resource: CloudDbQueryResource;
  limit: number;
  offset: number;
  rows: Array<Record<string, unknown>>;
}

export interface DocumentSummary extends Omit<CloudDocumentRecord, "source"> {
  currentRole?: CloudRole;
}

export interface SiteSummary extends CloudSiteRecord {
  currentRole?: CloudRole;
}

interface LegacyCloudDocumentRecord {
  version: 1;
  id: string;
  title: string;
  source: string;
  hash: string;
  createdAt: string;
  updatedAt: string;
}

interface CloudDatabaseOptions {
  dbPath: string;
  dataDir: string;
  usersDir: string;
  sitesDir: string;
}

interface RecordJsonRow {
  record_json: string;
}

interface RecordJsonRoleRow extends RecordJsonRow {
  role: CloudRole;
}

interface RecordJsonRankRow extends RecordJsonRow {
  rank: number;
}

interface BlockQueryRow {
  row_key: string;
  document_id: string;
  document_title: string;
  block_id: string | null;
  aliases_json: string;
  node_type: string;
  directive_name: string | null;
  title: string | null;
  text: string;
  line: number | null;
  depth: number;
  ordinal: number;
  rank: number;
}

interface BlockIndexRow {
  rowKey: string;
  documentId: string;
  blockId: string | null;
  aliases: string[];
  nodeType: string;
  directiveName: string | null;
  title: string | null;
  text: string;
  line: number | null;
  depth: number;
  ordinal: number;
}

const schemaVersion = "1";

const roleRank: Record<CloudRole, number> = {
  viewer: 1,
  editor: 2,
  owner: 3,
};

const rankRole: Record<number, CloudRole> = {
  1: "viewer",
  2: "editor",
  3: "owner",
};

const visibleDocumentsCte = `visible_docs AS (
  SELECT id, MAX(rank) AS rank
  FROM (
    SELECT d.id AS id,
      CASE p.role WHEN 'owner' THEN 3 WHEN 'editor' THEN 2 ELSE 1 END AS rank
    FROM documents d
    JOIN permissions p
      ON p.resource_type = 'document'
      AND p.resource_id = d.id
      AND p.user_id = ?
    UNION ALL
    SELECT sd.document_id AS id,
      CASE p.role WHEN 'owner' THEN 3 WHEN 'editor' THEN 2 ELSE 1 END AS rank
    FROM site_documents sd
    JOIN permissions p
      ON p.resource_type = 'site'
      AND p.resource_id = sd.site_id
      AND p.user_id = ?
  )
  GROUP BY id
)`;

export class NomaCloudDatabase {
  private readonly db: SqliteDatabase;

  constructor(private readonly options: CloudDatabaseOptions) {
    mkdirSync(dirname(options.dbPath), { recursive: true });
    this.db = new DatabaseConstructor(options.dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.db.pragma("busy_timeout = 5000");
    this.applySchema();
    this.importLegacyJsonOnce();
  }

  close(): void {
    this.db.close();
  }

  hasRecordId(id: string): boolean {
    const row = this.db
      .prepare(
        `SELECT 1 AS found FROM users WHERE id = ?
         UNION ALL SELECT 1 FROM documents WHERE id = ?
         UNION ALL SELECT 1 FROM sites WHERE id = ?
         LIMIT 1`,
      )
      .get(id, id, id) as { found: number } | undefined;
    return row !== undefined;
  }

  readUser(id: string): CloudUserRecord | undefined {
    const row = this.db.prepare("SELECT record_json FROM users WHERE id = ?").get(id) as RecordJsonRow | undefined;
    return row ? parseRecord<CloudUserRecord>(row.record_json) : undefined;
  }

  findUserByToken(tokenHash: string): CloudUserRecord | undefined {
    const row = this.db.prepare("SELECT record_json FROM users WHERE token_hash = ?").get(tokenHash) as RecordJsonRow | undefined;
    return row ? parseRecord<CloudUserRecord>(row.record_json) : undefined;
  }

  listUsers(): CloudUserRecord[] {
    return this.db
      .prepare("SELECT record_json FROM users ORDER BY lower(name), id")
      .all()
      .map((row) => parseRecord<CloudUserRecord>((row as RecordJsonRow).record_json));
  }

  writeUser(record: CloudUserRecord): void {
    const payload = JSON.stringify(record);
    this.db
      .prepare(
        `INSERT INTO users (id, name, token_hash, token_preview, created_at, updated_at, record_json)
         VALUES (@id, @name, @tokenHash, @tokenPreview, @createdAt, @updatedAt, @payload)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name,
           token_hash = excluded.token_hash,
           token_preview = excluded.token_preview,
           created_at = excluded.created_at,
           updated_at = excluded.updated_at,
           record_json = excluded.record_json`,
      )
      .run({ ...record, payload });
  }

  readDocument(id: string): CloudDocumentRecord | undefined {
    const row = this.db.prepare("SELECT record_json FROM documents WHERE id = ?").get(id) as RecordJsonRow | undefined;
    return row ? parseRecord<CloudDocumentRecord>(row.record_json) : undefined;
  }

  listDocuments(user: CloudUserRecord): DocumentSummary[] {
    const rows = this.db
      .prepare(
        `SELECT d.record_json, p.role
         FROM documents d
         JOIN permissions p
           ON p.resource_type = 'document'
           AND p.resource_id = d.id
           AND p.user_id = ?
         ORDER BY d.updated_at DESC, d.id
         LIMIT 100`,
      )
      .all(user.id) as RecordJsonRoleRow[];

    return rows.map((row) => {
      const { source, ...summary } = parseRecord<CloudDocumentRecord>(row.record_json);
      return { ...summary, currentRole: row.role };
    });
  }

  writeDocument(record: CloudDocumentRecord): void {
    const write = this.db.transaction((next: CloudDocumentRecord) => {
      const payload = JSON.stringify(next);
      this.db
        .prepare(
          `INSERT INTO documents (id, title, source, hash, created_at, updated_at, created_by, updated_by, record_json)
           VALUES (@id, @title, @source, @hash, @createdAt, @updatedAt, @createdBy, @updatedBy, @payload)
           ON CONFLICT(id) DO UPDATE SET
             title = excluded.title,
             source = excluded.source,
             hash = excluded.hash,
             created_at = excluded.created_at,
             updated_at = excluded.updated_at,
             created_by = excluded.created_by,
             updated_by = excluded.updated_by,
             record_json = excluded.record_json`,
        )
        .run({ ...next, payload });
      this.replacePermissions("document", next.id, next.permissions);
      this.replaceShares("document", next.id, next.shareLinks);
      this.replaceBlocks(next);
    });
    write(record);
  }

  readSite(id: string): CloudSiteRecord | undefined {
    const row = this.db.prepare("SELECT record_json FROM sites WHERE id = ?").get(id) as RecordJsonRow | undefined;
    return row ? parseRecord<CloudSiteRecord>(row.record_json) : undefined;
  }

  listSites(user: CloudUserRecord): SiteSummary[] {
    const rows = this.db
      .prepare(
        `SELECT s.record_json, p.role
         FROM sites s
         JOIN permissions p
           ON p.resource_type = 'site'
           AND p.resource_id = s.id
           AND p.user_id = ?
         ORDER BY s.updated_at DESC, s.id
         LIMIT 100`,
      )
      .all(user.id) as RecordJsonRoleRow[];

    return rows.map((row) => ({ ...parseRecord<CloudSiteRecord>(row.record_json), currentRole: row.role }));
  }

  writeSite(record: CloudSiteRecord): void {
    const write = this.db.transaction((next: CloudSiteRecord) => {
      const payload = JSON.stringify(next);
      this.db
        .prepare(
          `INSERT INTO sites (id, title, slug, document_ids_json, created_at, updated_at, created_by, updated_by, record_json)
           VALUES (@id, @title, @slug, @documentIdsJson, @createdAt, @updatedAt, @createdBy, @updatedBy, @payload)
           ON CONFLICT(id) DO UPDATE SET
             title = excluded.title,
             slug = excluded.slug,
             document_ids_json = excluded.document_ids_json,
             created_at = excluded.created_at,
             updated_at = excluded.updated_at,
             created_by = excluded.created_by,
             updated_by = excluded.updated_by,
             record_json = excluded.record_json`,
        )
        .run({ ...next, documentIdsJson: JSON.stringify(next.documentIds), payload });
      this.replacePermissions("site", next.id, next.permissions);
      this.replaceShares("site", next.id, next.shareLinks);
      this.replaceSiteDocuments(next);
    });
    write(record);
  }

  query(user: CloudUserRecord, query: CloudDbQuery): CloudDbQueryResult {
    switch (query.resource) {
      case "documents":
        return { resource: query.resource, limit: query.limit, offset: query.offset, rows: this.queryDocuments(user, query) };
      case "sites":
        return { resource: query.resource, limit: query.limit, offset: query.offset, rows: this.querySites(user, query) };
      case "blocks":
        return { resource: query.resource, limit: query.limit, offset: query.offset, rows: this.queryBlocks(user, query) };
      case "users":
        return { resource: query.resource, limit: query.limit, offset: query.offset, rows: this.queryUsers(query) };
    }
  }

  private applySchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS meta (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        token_hash TEXT NOT NULL UNIQUE,
        token_preview TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        record_json TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS documents (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        source TEXT NOT NULL,
        hash TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        created_by TEXT NOT NULL,
        updated_by TEXT NOT NULL,
        record_json TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS sites (
        id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        slug TEXT NOT NULL,
        document_ids_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        created_by TEXT NOT NULL,
        updated_by TEXT NOT NULL,
        record_json TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS permissions (
        resource_type TEXT NOT NULL CHECK (resource_type IN ('document', 'site')),
        resource_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('viewer', 'editor', 'owner')),
        added_at TEXT NOT NULL,
        PRIMARY KEY (resource_type, resource_id, user_id)
      );

      CREATE TABLE IF NOT EXISTS share_links (
        resource_type TEXT NOT NULL CHECK (resource_type IN ('document', 'site')),
        resource_id TEXT NOT NULL,
        id TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('viewer', 'editor')),
        token_hash TEXT NOT NULL,
        token_preview TEXT NOT NULL,
        label TEXT,
        created_by TEXT NOT NULL,
        created_at TEXT NOT NULL,
        revoked_at TEXT,
        PRIMARY KEY (resource_type, resource_id, id)
      );

      CREATE TABLE IF NOT EXISTS site_documents (
        site_id TEXT NOT NULL,
        document_id TEXT NOT NULL,
        position INTEGER NOT NULL,
        PRIMARY KEY (site_id, document_id)
      );

      CREATE TABLE IF NOT EXISTS blocks (
        row_key TEXT PRIMARY KEY,
        document_id TEXT NOT NULL,
        block_id TEXT,
        aliases_json TEXT NOT NULL,
        node_type TEXT NOT NULL,
        directive_name TEXT,
        title TEXT,
        text TEXT NOT NULL,
        line INTEGER,
        depth INTEGER NOT NULL,
        ordinal INTEGER NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_permissions_user ON permissions(user_id, resource_type, resource_id);
      CREATE INDEX IF NOT EXISTS idx_share_links_token ON share_links(token_hash);
      CREATE INDEX IF NOT EXISTS idx_site_documents_document ON site_documents(document_id, site_id);
      CREATE INDEX IF NOT EXISTS idx_documents_updated ON documents(updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_sites_updated ON sites(updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_blocks_document ON blocks(document_id, ordinal);
      CREATE INDEX IF NOT EXISTS idx_blocks_block_id ON blocks(block_id);
      CREATE INDEX IF NOT EXISTS idx_blocks_text ON blocks(text);
    `);
    this.db
      .prepare("INSERT INTO meta (key, value) VALUES ('schema_version', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(schemaVersion);
  }

  private importLegacyJsonOnce(): void {
    const imported = this.db.prepare("SELECT value FROM meta WHERE key = 'legacy_json_imported'").get() as { value: string } | undefined;
    if (imported?.value === "true") return;

    const importRecords = this.db.transaction(() => {
      for (const user of legacyJsonRecords<CloudUserRecord>(this.options.usersDir)) {
        if (isCloudUserRecord(user)) this.writeUser(user);
      }
      for (const document of legacyJsonRecords<CloudDocumentRecord | LegacyCloudDocumentRecord>(this.options.dataDir)) {
        const normalized = normalizeDocumentRecord(document);
        if (normalized) this.writeDocument(normalized);
      }
      for (const site of legacyJsonRecords<CloudSiteRecord>(this.options.sitesDir)) {
        if (isCloudSiteRecord(site)) this.writeSite(site);
      }
      this.db
        .prepare("INSERT INTO meta (key, value) VALUES ('legacy_json_imported', 'true') ON CONFLICT(key) DO UPDATE SET value = 'true'")
        .run();
    });
    importRecords();
  }

  private replacePermissions(resourceType: "document" | "site", resourceId: string, permissions: Record<string, CloudPermission>): void {
    this.db.prepare("DELETE FROM permissions WHERE resource_type = ? AND resource_id = ?").run(resourceType, resourceId);
    const insert = this.db.prepare(
      `INSERT INTO permissions (resource_type, resource_id, user_id, role, added_at)
       VALUES (?, ?, ?, ?, ?)`,
    );
    for (const [userId, permission] of Object.entries(permissions)) {
      insert.run(resourceType, resourceId, userId, permission.role, permission.addedAt);
    }
  }

  private replaceShares(resourceType: "document" | "site", resourceId: string, shares: CloudShareLink[]): void {
    this.db.prepare("DELETE FROM share_links WHERE resource_type = ? AND resource_id = ?").run(resourceType, resourceId);
    const insert = this.db.prepare(
      `INSERT INTO share_links
        (resource_type, resource_id, id, role, token_hash, token_preview, label, created_by, created_at, revoked_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const share of shares) {
      insert.run(
        resourceType,
        resourceId,
        share.id,
        share.role,
        share.tokenHash,
        share.tokenPreview,
        share.label ?? null,
        share.createdBy,
        share.createdAt,
        share.revokedAt ?? null,
      );
    }
  }

  private replaceSiteDocuments(site: CloudSiteRecord): void {
    this.db.prepare("DELETE FROM site_documents WHERE site_id = ?").run(site.id);
    const insert = this.db.prepare("INSERT INTO site_documents (site_id, document_id, position) VALUES (?, ?, ?)");
    site.documentIds.forEach((documentId, index) => insert.run(site.id, documentId, index));
  }

  private replaceBlocks(document: CloudDocumentRecord): void {
    this.db.prepare("DELETE FROM blocks WHERE document_id = ?").run(document.id);
    const insert = this.db.prepare(
      `INSERT INTO blocks
        (row_key, document_id, block_id, aliases_json, node_type, directive_name, title, text, line, depth, ordinal)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const row of indexDocumentBlocks(document)) {
      insert.run(
        row.rowKey,
        row.documentId,
        row.blockId,
        JSON.stringify(row.aliases),
        row.nodeType,
        row.directiveName,
        row.title,
        row.text,
        row.line,
        row.depth,
        row.ordinal,
      );
    }
  }

  private queryDocuments(user: CloudUserRecord, query: CloudDbQuery): Array<Record<string, unknown>> {
    const params: unknown[] = [user.id, user.id];
    const filters: string[] = [];
    if (query.q) {
      const pattern = likePattern(query.q);
      filters.push("(d.title LIKE ? ESCAPE '\\' OR d.source LIKE ? ESCAPE '\\')");
      params.push(pattern, pattern);
    }
    if (query.siteId) {
      filters.push("EXISTS (SELECT 1 FROM site_documents sd WHERE sd.site_id = ? AND sd.document_id = d.id)");
      params.push(query.siteId);
    }
    if (query.documentId) {
      filters.push("d.id = ?");
      params.push(query.documentId);
    }
    params.push(query.limit, query.offset);
    const sql = `WITH ${visibleDocumentsCte}
      SELECT d.record_json, visible_docs.rank
      FROM documents d
      JOIN visible_docs ON visible_docs.id = d.id
      ${filters.length ? `WHERE ${filters.join(" AND ")}` : ""}
      ORDER BY d.updated_at DESC, d.id
      LIMIT ? OFFSET ?`;
    const rows = this.db.prepare(sql).all(...params) as RecordJsonRankRow[];
    return rows.map((row) => documentQueryRow(parseRecord<CloudDocumentRecord>(row.record_json), rankToRole(row.rank), query.includeSource));
  }

  private querySites(user: CloudUserRecord, query: CloudDbQuery): Array<Record<string, unknown>> {
    const params: unknown[] = [user.id];
    const filters: string[] = [];
    if (query.q) {
      filters.push("(s.title LIKE ? ESCAPE '\\' OR s.slug LIKE ? ESCAPE '\\')");
      const pattern = likePattern(query.q);
      params.push(pattern, pattern);
    }
    if (query.siteId) {
      filters.push("s.id = ?");
      params.push(query.siteId);
    }
    params.push(query.limit, query.offset);
    const sql = `SELECT s.record_json, p.role
      FROM sites s
      JOIN permissions p
        ON p.resource_type = 'site'
        AND p.resource_id = s.id
        AND p.user_id = ?
      ${filters.length ? `WHERE ${filters.join(" AND ")}` : ""}
      ORDER BY s.updated_at DESC, s.id
      LIMIT ? OFFSET ?`;
    const rows = this.db.prepare(sql).all(...params) as RecordJsonRoleRow[];
    return rows.map((row) => siteQueryRow(parseRecord<CloudSiteRecord>(row.record_json), row.role));
  }

  private queryBlocks(user: CloudUserRecord, query: CloudDbQuery): Array<Record<string, unknown>> {
    const params: unknown[] = [user.id, user.id];
    const filters: string[] = [];
    if (query.q) {
      const pattern = likePattern(query.q);
      filters.push("(b.text LIKE ? ESCAPE '\\' OR b.block_id LIKE ? ESCAPE '\\' OR b.title LIKE ? ESCAPE '\\')");
      params.push(pattern, pattern, pattern);
    }
    if (query.siteId) {
      filters.push("EXISTS (SELECT 1 FROM site_documents sd WHERE sd.site_id = ? AND sd.document_id = b.document_id)");
      params.push(query.siteId);
    }
    if (query.documentId) {
      filters.push("b.document_id = ?");
      params.push(query.documentId);
    }
    params.push(query.limit, query.offset);
    const sql = `WITH ${visibleDocumentsCte}
      SELECT
        b.row_key,
        b.document_id,
        d.title AS document_title,
        b.block_id,
        b.aliases_json,
        b.node_type,
        b.directive_name,
        b.title,
        b.text,
        b.line,
        b.depth,
        b.ordinal,
        visible_docs.rank
      FROM blocks b
      JOIN documents d ON d.id = b.document_id
      JOIN visible_docs ON visible_docs.id = b.document_id
      ${filters.length ? `WHERE ${filters.join(" AND ")}` : ""}
      ORDER BY d.updated_at DESC, b.ordinal
      LIMIT ? OFFSET ?`;
    const rows = this.db.prepare(sql).all(...params) as BlockQueryRow[];
    return rows.map(blockQueryRow);
  }

  private queryUsers(query: CloudDbQuery): Array<Record<string, unknown>> {
    const params: unknown[] = [];
    const filters: string[] = [];
    if (query.q) {
      const pattern = likePattern(query.q);
      filters.push("(name LIKE ? ESCAPE '\\' OR id LIKE ? ESCAPE '\\')");
      params.push(pattern, pattern);
    }
    params.push(query.limit, query.offset);
    const sql = `SELECT record_json FROM users
      ${filters.length ? `WHERE ${filters.join(" AND ")}` : ""}
      ORDER BY lower(name), id
      LIMIT ? OFFSET ?`;
    const rows = this.db.prepare(sql).all(...params) as RecordJsonRow[];
    return rows.map((row) => publicUser(parseRecord<CloudUserRecord>(row.record_json)));
  }
}

export function openNomaCloudDatabase(options: CloudDatabaseOptions): NomaCloudDatabase {
  return new NomaCloudDatabase(options);
}

function indexDocumentBlocks(record: CloudDocumentRecord): BlockIndexRow[] {
  const doc = parse(record.source, { filename: `${record.id}.noma` });
  const rows: BlockIndexRow[] = [];
  let ordinal = 0;
  const visit = (node: Node, depth: number, inheritedId: string | undefined): void => {
    const targetId = node.id ?? inheritedId;
    if (node.type !== "document" && node.type !== "frontmatter") {
      const rowOrdinal = ordinal;
      ordinal += 1;
      rows.push({
        rowKey: `${record.id}:${String(rowOrdinal).padStart(6, "0")}`,
        documentId: record.id,
        blockId: targetId ?? null,
        aliases: node.aliases ?? [],
        nodeType: node.type,
        directiveName: node.type === "directive" ? node.name : null,
        title: nodeTitle(node),
        text: nodeSearchText(node),
        line: node.pos?.line ?? null,
        depth,
        ordinal: rowOrdinal,
      });
    }
    if (node.type === "document" || node.type === "section" || node.type === "directive") {
      for (const child of node.children) visit(child, depth + 1, targetId);
    } else if (node.type === "list") {
      for (const item of node.items) visit(item, depth + 1, targetId);
    }
  };
  visit(doc, 0, undefined);
  return rows;
}

function nodeTitle(node: Node): string | null {
  if (node.type === "section") return node.title;
  if (node.type === "directive") {
    const title = node.attrs.title ?? node.attrs.label ?? node.attrs.name;
    return typeof title === "string" ? title : null;
  }
  return null;
}

function nodeSearchText(node: Node): string {
  switch (node.type) {
    case "document":
      return "";
    case "frontmatter":
      return node.raw;
    case "section":
      return node.title;
    case "paragraph":
    case "code":
    case "list_item":
    case "quote":
      return node.content;
    case "list":
      return node.items.map((item) => item.content).join("\n");
    case "thematic_break":
      return "";
    case "table":
      return [node.header.join(" "), ...node.rows.map((row) => row.join(" "))].join("\n");
    case "directive": {
      const attrs = Object.entries(node.attrs)
        .map(([key, value]) => `${key}=${String(value)}`)
        .join(" ");
      const body = node.children.length > 0 ? "" : (node.body ?? "");
      return [node.name, attrs, body].filter(Boolean).join("\n");
    }
  }
}

function legacyJsonRecords<T>(dir: string): T[] {
  try {
    return readdirSync(dir)
      .filter((name) => name.endsWith(".json"))
      .flatMap((name) => {
        try {
          return [JSON.parse(readFileSync(join(dir, name), "utf8")) as T];
        } catch {
          return [];
        }
      });
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && String(error.code) === "ENOENT") return [];
    throw error;
  }
}

function normalizeDocumentRecord(record: CloudDocumentRecord | LegacyCloudDocumentRecord): CloudDocumentRecord | undefined {
  if (record.version === 2 && isCloudDocumentRecord(record)) return record;
  if (record.version === 1 && typeof record.id === "string" && typeof record.source === "string") {
    return {
      ...record,
      version: 2,
      createdBy: "legacy",
      updatedBy: "legacy",
      permissions: {},
      shareLinks: [],
    };
  }
  return undefined;
}

function isCloudUserRecord(value: unknown): value is CloudUserRecord {
  return (
    typeof value === "object" &&
    value !== null &&
    "version" in value &&
    value.version === 1 &&
    "id" in value &&
    typeof value.id === "string" &&
    "tokenHash" in value &&
    typeof value.tokenHash === "string"
  );
}

function isCloudDocumentRecord(value: unknown): value is CloudDocumentRecord {
  return (
    typeof value === "object" &&
    value !== null &&
    "version" in value &&
    value.version === 2 &&
    "id" in value &&
    typeof value.id === "string" &&
    "source" in value &&
    typeof value.source === "string" &&
    "permissions" in value &&
    typeof value.permissions === "object" &&
    value.permissions !== null &&
    "shareLinks" in value &&
    Array.isArray(value.shareLinks)
  );
}

function isCloudSiteRecord(value: unknown): value is CloudSiteRecord {
  return (
    typeof value === "object" &&
    value !== null &&
    "version" in value &&
    value.version === 1 &&
    "id" in value &&
    typeof value.id === "string" &&
    "documentIds" in value &&
    Array.isArray(value.documentIds) &&
    "permissions" in value &&
    typeof value.permissions === "object" &&
    value.permissions !== null &&
    "shareLinks" in value &&
    Array.isArray(value.shareLinks)
  );
}

function parseRecord<T>(json: string): T {
  return JSON.parse(json) as T;
}

function documentQueryRow(record: CloudDocumentRecord, role: CloudRole, includeSource: boolean): Record<string, unknown> {
  const base: Record<string, unknown> = {
    id: record.id,
    title: record.title,
    hash: record.hash,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    createdBy: record.createdBy,
    updatedBy: record.updatedBy,
    access: { role },
  };
  if (includeSource) base.source = record.source;
  return base;
}

function siteQueryRow(record: CloudSiteRecord, role: CloudRole): Record<string, unknown> {
  return {
    id: record.id,
    title: record.title,
    slug: record.slug,
    documentIds: record.documentIds,
    folders: record.folders ?? [],
    pageFolders: record.pageFolders ?? {},
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    createdBy: record.createdBy,
    updatedBy: record.updatedBy,
    access: { role },
  };
}

function blockQueryRow(row: BlockQueryRow): Record<string, unknown> {
  return {
    rowKey: row.row_key,
    documentId: row.document_id,
    documentTitle: row.document_title,
    id: row.block_id,
    aliases: parseRecord<string[]>(row.aliases_json),
    type: row.node_type,
    name: row.directive_name,
    title: row.title,
    text: row.text,
    line: row.line,
    depth: row.depth,
    ordinal: row.ordinal,
    access: { role: rankToRole(row.rank) },
  };
}

function publicUser(user: CloudUserRecord): Record<string, unknown> {
  return {
    id: user.id,
    name: user.name,
    tokenPreview: user.tokenPreview,
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  };
}

function rankToRole(rank: number): CloudRole {
  return rankRole[Math.max(1, Math.min(3, rank))] ?? "viewer";
}

function likePattern(value: string): string {
  return `%${value.replace(/[\\%_]/g, (match) => `\\${match}`)}%`;
}
