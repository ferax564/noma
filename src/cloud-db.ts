import DatabaseConstructor from "better-sqlite3";
import type { Database as SqliteDatabase } from "better-sqlite3";
import { mkdirSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Node } from "./ast.js";
import { parse } from "./parser.js";

export type CloudRole = "viewer" | "editor" | "owner";
export type CloudResourceType = "document" | "site";

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

export interface CloudDocumentRevision {
  documentId: string;
  revision: number;
  title: string;
  source: string;
  hash: string;
  createdAt: string;
  createdBy: string;
}

export type CloudDocumentRevisionSummary = Omit<CloudDocumentRevision, "source">;

export interface CloudSearchResult {
  documentId: string;
  siteId?: string;
  documentTitle: string;
  blockId?: string;
  nodeType: string;
  directiveName?: string;
  title?: string;
  excerpt: string;
  line?: number;
  rank: number;
  access: { role: CloudRole };
}

export interface CloudNavigationItem {
  resourceType: CloudResourceType;
  resourceId: string;
  siteId?: string;
  title: string;
  updatedAt: string;
  activityAt: string;
  access: { role: CloudRole };
}

export interface CloudTrashItem extends CloudNavigationItem {
  trashedBy: string;
}

export interface CloudComment {
  id: string;
  documentId: string;
  blockId?: string;
  line?: number;
  parentId?: string;
  body: string;
  createdBy: string;
  createdByName: string;
  createdAt: string;
  updatedAt: string;
  resolvedAt?: string;
  resolvedBy?: string;
}

export interface CloudNotification {
  id: string;
  userId: string;
  type: "mention" | "comment" | "approval_requested" | "approval_updated";
  title: string;
  body: string;
  resourceType?: CloudResourceType;
  resourceId?: string;
  createdAt: string;
  readAt?: string;
}

export interface CloudActivityEvent {
  id: string;
  actorId: string;
  actorName: string;
  action: string;
  resourceType: CloudResourceType;
  resourceId: string;
  detail: Record<string, unknown>;
  createdAt: string;
}

export type CloudApprovalStatus = "pending" | "approved" | "changes_requested" | "cancelled";

export interface CloudApproval {
  id: string;
  documentId: string;
  documentHash: string;
  requestedBy: string;
  reviewerId: string;
  reviewerName: string;
  status: CloudApprovalStatus;
  note?: string;
  createdAt: string;
  updatedAt: string;
}

export interface CloudGroup {
  id: string;
  name: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  members: Array<{ userId: string; userName: string; role: "member" | "manager"; addedAt: string }>;
}

export interface CloudGroupPermission {
  groupId: string;
  groupName: string;
  role: Exclude<CloudRole, "owner">;
  addedAt: string;
}

export interface CloudAccessGrant {
  role: CloudRole;
  via: "user" | "group";
  groupId?: string;
}

export type CloudIssueType = "task" | "story" | "bug" | "epic";
export type CloudIssueStatus = "backlog" | "todo" | "in_progress" | "in_review" | "done";
export type CloudIssuePriority = "lowest" | "low" | "medium" | "high" | "highest";
export type CloudSprintStatus = "planned" | "active" | "closed";
export type CloudIssueLinkType = "blocks" | "relates" | "duplicates";

export interface CloudProject {
  id: string;
  key: string;
  name: string;
  siteId: string;
  description?: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
  access?: { role: CloudRole };
}

export interface CloudIssue {
  id: string;
  key: string;
  projectId: string;
  sequence: number;
  summary: string;
  description?: string;
  type: CloudIssueType;
  status: CloudIssueStatus;
  priority: CloudIssuePriority;
  reporterId: string;
  assigneeId?: string;
  assigneeName?: string;
  labels: string[];
  sprintId?: string;
  parentId?: string;
  estimate?: number;
  dueDate?: string;
  createdAt: string;
  updatedAt: string;
}

export interface CloudIssueFilter {
  q?: string;
  status?: CloudIssueStatus;
  type?: CloudIssueType;
  priority?: CloudIssuePriority;
  assigneeId?: string;
  label?: string;
  sprintId?: string | null;
  limit: number;
}

export interface CloudSprint {
  id: string;
  projectId: string;
  name: string;
  goal?: string;
  status: CloudSprintStatus;
  startAt?: string;
  endAt?: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface CloudIssueLink {
  id: string;
  sourceIssueId: string;
  targetIssueId: string;
  targetIssueKey: string;
  targetIssueSummary: string;
  type: CloudIssueLinkType;
  createdBy: string;
  createdAt: string;
}

export interface CloudIssueComment {
  id: string;
  issueId: string;
  body: string;
  createdBy: string;
  createdByName: string;
  createdAt: string;
  updatedAt: string;
}

export interface CloudIssueEvent {
  id: string;
  issueId: string;
  actorId: string;
  actorName: string;
  action: string;
  detail: Record<string, unknown>;
  createdAt: string;
}

export type CloudPatchProposalStatus = "pending" | "approved" | "rejected" | "applied";

export interface CloudPatchProposal {
  id: string;
  documentId: string;
  documentHash: string;
  issueId?: string;
  proposedBy: string;
  proposedByName: string;
  summary?: string;
  ops: unknown[];
  proof: Record<string, unknown>;
  status: CloudPatchProposalStatus;
  reviewedBy?: string;
  reviewedAt?: string;
  appliedHash?: string;
  createdAt: string;
  updatedAt: string;
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

interface DocumentHeadRow {
  title: string;
  hash: string;
}

interface DocumentRevisionRow {
  document_id: string;
  revision: number;
  title: string;
  source: string;
  hash: string;
  created_at: string;
  created_by: string;
}

interface SearchResultRow {
  document_id: string;
  site_id: string | null;
  document_title: string;
  block_id: string | null;
  node_type: string;
  directive_name: string | null;
  title: string | null;
  excerpt: string;
  line: number | null;
  rank: number;
  access_rank: number;
}

interface NavigationRow {
  resource_type: CloudResourceType;
  resource_id: string;
  site_id: string | null;
  title: string;
  updated_at: string;
  activity_at: string;
  access_rank: number;
  actor_id?: string;
}

interface CommentRow {
  id: string;
  document_id: string;
  block_id: string | null;
  line: number | null;
  parent_id: string | null;
  body: string;
  created_by: string;
  created_by_name: string;
  created_at: string;
  updated_at: string;
  resolved_at: string | null;
  resolved_by: string | null;
}

interface NotificationRow {
  id: string;
  user_id: string;
  type: CloudNotification["type"];
  title: string;
  body: string;
  resource_type: CloudResourceType | null;
  resource_id: string | null;
  created_at: string;
  read_at: string | null;
}

interface ActivityRow {
  id: string;
  actor_id: string;
  actor_name: string;
  action: string;
  resource_type: CloudResourceType;
  resource_id: string;
  detail_json: string;
  created_at: string;
}

interface ApprovalRow {
  id: string;
  document_id: string;
  document_hash: string;
  requested_by: string;
  reviewer_id: string;
  reviewer_name: string;
  status: CloudApprovalStatus;
  note: string | null;
  created_at: string;
  updated_at: string;
}

interface GroupRow {
  id: string;
  name: string;
  created_by: string;
  created_at: string;
  updated_at: string;
}

interface GroupMemberRow {
  user_id: string;
  user_name: string;
  role: "member" | "manager";
  added_at: string;
}

interface GroupPermissionRow {
  group_id: string;
  group_name: string;
  role: Exclude<CloudRole, "owner">;
  added_at: string;
}

interface ProjectRow {
  id: string;
  project_key: string;
  name: string;
  site_id: string;
  description: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
  access_rank?: number;
}

interface IssueRow {
  id: string;
  issue_key: string;
  project_id: string;
  sequence: number;
  summary: string;
  description: string | null;
  issue_type: CloudIssueType;
  status: CloudIssueStatus;
  priority: CloudIssuePriority;
  reporter_id: string;
  assignee_id: string | null;
  assignee_name: string | null;
  labels_json: string;
  sprint_id: string | null;
  parent_id: string | null;
  estimate: number | null;
  due_date: string | null;
  created_at: string;
  updated_at: string;
}

interface SprintRow {
  id: string;
  project_id: string;
  name: string;
  goal: string | null;
  status: CloudSprintStatus;
  start_at: string | null;
  end_at: string | null;
  created_by: string;
  created_at: string;
  updated_at: string;
}

interface IssueLinkRow {
  id: string;
  source_issue_id: string;
  target_issue_id: string;
  target_issue_key: string;
  target_issue_summary: string;
  link_type: CloudIssueLinkType;
  created_by: string;
  created_at: string;
}

interface IssueCommentRow {
  id: string;
  issue_id: string;
  body: string;
  created_by: string;
  created_by_name: string;
  created_at: string;
  updated_at: string;
}

interface IssueEventRow {
  id: string;
  issue_id: string;
  actor_id: string;
  actor_name: string;
  action: string;
  detail_json: string;
  created_at: string;
}

interface PatchProposalRow {
  id: string;
  document_id: string;
  document_hash: string;
  issue_id: string | null;
  proposed_by: string;
  proposed_by_name: string;
  summary: string | null;
  ops_json: string;
  proof_json: string;
  status: CloudPatchProposalStatus;
  reviewed_by: string | null;
  reviewed_at: string | null;
  applied_hash: string | null;
  created_at: string;
  updated_at: string;
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

const schemaVersion = "7";

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

const visibleResourcesCtes = `current_user(user_id) AS (VALUES (?)),
visible_sites AS (
  SELECT id, MAX(rank) AS rank
  FROM (
    SELECT s.id,
      CASE p.role WHEN 'owner' THEN 3 WHEN 'editor' THEN 2 ELSE 1 END AS rank
    FROM sites s
    JOIN permissions p
      ON p.resource_type = 'site'
      AND p.resource_id = s.id
    JOIN current_user cu ON cu.user_id = p.user_id
    UNION ALL
    SELECT s.id,
      CASE gp.role WHEN 'editor' THEN 2 ELSE 1 END AS rank
    FROM sites s
    JOIN group_permissions gp
      ON gp.resource_type = 'site'
      AND gp.resource_id = s.id
    JOIN group_members gm ON gm.group_id = gp.group_id
    JOIN current_user cu ON cu.user_id = gm.user_id
  )
  GROUP BY id
),
visible_docs AS (
  SELECT id, MAX(rank) AS rank
  FROM (
    SELECT d.id AS id,
      CASE p.role WHEN 'owner' THEN 3 WHEN 'editor' THEN 2 ELSE 1 END AS rank
    FROM documents d
    JOIN permissions p
      ON p.resource_type = 'document'
      AND p.resource_id = d.id
    JOIN current_user cu ON cu.user_id = p.user_id
    UNION ALL
    SELECT d.id,
      CASE gp.role WHEN 'editor' THEN 2 ELSE 1 END AS rank
    FROM documents d
    JOIN group_permissions gp
      ON gp.resource_type = 'document'
      AND gp.resource_id = d.id
    JOIN group_members gm ON gm.group_id = gp.group_id
    JOIN current_user cu ON cu.user_id = gm.user_id
    UNION ALL
    SELECT sd.document_id, visible_sites.rank
    FROM site_documents sd
    JOIN visible_sites ON visible_sites.id = sd.site_id
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
         UNION ALL SELECT 1 FROM groups WHERE id = ?
         UNION ALL SELECT 1 FROM projects WHERE id = ?
         UNION ALL SELECT 1 FROM issues WHERE id = ?
         UNION ALL SELECT 1 FROM sprints WHERE id = ?
         UNION ALL SELECT 1 FROM patch_proposals WHERE id = ?
         LIMIT 1`,
      )
      .get(id, id, id, id, id, id, id, id) as { found: number } | undefined;
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

  documentAccessRole(userId: string, documentId: string): CloudRole | undefined {
    return this.resourceAccess(userId, "document", documentId)?.role;
  }

  resourceAccess(userId: string, resourceType: CloudResourceType, resourceId: string): CloudAccessGrant | undefined {
    const rows = this.db
      .prepare(
        `SELECT role, via, group_id FROM (
           SELECT p.role, 'user' AS via, NULL AS group_id,
             CASE p.role WHEN 'owner' THEN 3 WHEN 'editor' THEN 2 ELSE 1 END AS rank
           FROM permissions p
           WHERE p.resource_type = ? AND p.resource_id = ? AND p.user_id = ?
           UNION ALL
           SELECT gp.role, 'group' AS via, gp.group_id,
             CASE gp.role WHEN 'editor' THEN 2 ELSE 1 END AS rank
           FROM group_permissions gp
           JOIN group_members gm ON gm.group_id = gp.group_id AND gm.user_id = ?
           WHERE gp.resource_type = ? AND gp.resource_id = ?
           UNION ALL
           SELECT p.role, 'user' AS via, NULL AS group_id,
             CASE p.role WHEN 'owner' THEN 3 WHEN 'editor' THEN 2 ELSE 1 END AS rank
           FROM site_documents sd
           JOIN permissions p ON p.resource_type = 'site' AND p.resource_id = sd.site_id AND p.user_id = ?
           WHERE ? = 'document' AND sd.document_id = ?
           UNION ALL
           SELECT gp.role, 'group' AS via, gp.group_id,
             CASE gp.role WHEN 'editor' THEN 2 ELSE 1 END AS rank
           FROM site_documents sd
           JOIN group_permissions gp ON gp.resource_type = 'site' AND gp.resource_id = sd.site_id
           JOIN group_members gm ON gm.group_id = gp.group_id AND gm.user_id = ?
           WHERE ? = 'document' AND sd.document_id = ?
         )
         ORDER BY rank DESC, CASE via WHEN 'user' THEN 0 ELSE 1 END, group_id
         LIMIT 1`,
      )
      .all(
        resourceType,
        resourceId,
        userId,
        userId,
        resourceType,
        resourceId,
        userId,
        resourceType,
        resourceId,
        userId,
        resourceType,
        resourceId,
      ) as Array<{ role: CloudRole; via: "user" | "group"; group_id: string | null }>;
    const row = rows[0];
    return row ? { role: row.role, via: row.via, ...(row.group_id ? { groupId: row.group_id } : {}) } : undefined;
  }

  listDocumentRevisions(id: string): CloudDocumentRevisionSummary[] {
    const rows = this.db
      .prepare(
        `SELECT document_id, revision, title, source, hash, created_at, created_by
         FROM document_revisions
         WHERE document_id = ?
         ORDER BY revision DESC`,
      )
      .all(id) as DocumentRevisionRow[];
    return rows.map(documentRevisionSummary);
  }

  readDocumentRevision(id: string, revision: number): CloudDocumentRevision | undefined {
    const row = this.db
      .prepare(
        `SELECT document_id, revision, title, source, hash, created_at, created_by
         FROM document_revisions
         WHERE document_id = ? AND revision = ?`,
      )
      .get(id, revision) as DocumentRevisionRow | undefined;
    return row ? documentRevision(row) : undefined;
  }

  listDocuments(user: CloudUserRecord, limit = 100): DocumentSummary[] {
    const rows = this.db
      .prepare(
        `WITH ${visibleResourcesCtes}
         SELECT d.record_json, visible_docs.rank
         FROM documents d
         JOIN visible_docs ON visible_docs.id = d.id
         WHERE NOT EXISTS (
           SELECT 1 FROM trashed_resources t
           WHERE t.resource_type = 'document' AND t.resource_id = d.id
         )
         ORDER BY d.updated_at DESC, d.id
         LIMIT ?`,
      )
      .all(user.id, limit) as RecordJsonRankRow[];

    return rows.map((row) => {
      const { source, ...summary } = parseRecord<CloudDocumentRecord>(row.record_json);
      return { ...summary, currentRole: rankToRole(row.rank) };
    });
  }

  writeDocument(record: CloudDocumentRecord, expectedHash?: string): boolean {
    const write = this.db.transaction((next: CloudDocumentRecord, expected: string | undefined): boolean => {
      const previous = this.db.prepare("SELECT title, hash FROM documents WHERE id = ?").get(next.id) as DocumentHeadRow | undefined;
      if (expected !== undefined && previous?.hash !== expected) return false;
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
      if (!previous || previous.hash !== next.hash || previous.title !== next.title) {
        const nextRevision = this.db
          .prepare("SELECT COALESCE(MAX(revision), 0) + 1 AS revision FROM document_revisions WHERE document_id = ?")
          .get(next.id) as { revision: number };
        this.db
          .prepare(
            `INSERT INTO document_revisions
              (document_id, revision, title, source, hash, created_at, created_by)
             VALUES (?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            next.id,
            nextRevision.revision,
            next.title,
            next.source,
            next.hash,
            previous ? next.updatedAt : next.createdAt,
            previous ? next.updatedBy : next.createdBy,
          );
      }
      this.replacePermissions("document", next.id, next.permissions);
      this.replaceShares("document", next.id, next.shareLinks);
      this.replaceBlocks(next);
      return true;
    });
    return write(record, expectedHash);
  }

  readSite(id: string): CloudSiteRecord | undefined {
    const row = this.db.prepare("SELECT record_json FROM sites WHERE id = ?").get(id) as RecordJsonRow | undefined;
    return row ? parseRecord<CloudSiteRecord>(row.record_json) : undefined;
  }

  listSites(user: CloudUserRecord): SiteSummary[] {
    const rows = this.db
      .prepare(
        `WITH ${visibleResourcesCtes}
         SELECT s.record_json, visible_sites.rank
         FROM sites s
         JOIN visible_sites ON visible_sites.id = s.id
         WHERE NOT EXISTS (
           SELECT 1 FROM trashed_resources t
           WHERE t.resource_type = 'site' AND t.resource_id = s.id
         )
         ORDER BY s.updated_at DESC, s.id
         LIMIT 100`,
      )
      .all(user.id) as RecordJsonRankRow[];

    return rows.map((row) => ({ ...parseRecord<CloudSiteRecord>(row.record_json), currentRole: rankToRole(row.rank) }));
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

  search(user: CloudUserRecord, q: string, siteId?: string, limit = 25): CloudSearchResult[] {
    const query = fullTextQuery(q);
    if (!query) return [];
    const params: unknown[] = [user.id, query];
    const siteFilter = siteId
      ? "AND EXISTS (SELECT 1 FROM site_documents filter_sd WHERE filter_sd.site_id = ? AND filter_sd.document_id = search_index.document_id)"
      : "";
    if (siteId) params.push(siteId);
    params.push(limit);
    const rows = this.db
      .prepare(
        `WITH ${visibleResourcesCtes}
         SELECT
           search_index.document_id,
           (SELECT sd.site_id FROM site_documents sd WHERE sd.document_id = search_index.document_id ORDER BY sd.position LIMIT 1) AS site_id,
           search_index.document_title,
           search_index.block_id,
           b.node_type,
           b.directive_name,
           b.title,
           snippet(search_index, 4, '', '', ' … ', 18) AS excerpt,
           b.line,
           bm25(search_index, 2.5, 1.5, 1.0) AS rank,
           visible_docs.rank AS access_rank
         FROM search_index
         JOIN blocks b ON b.row_key = search_index.row_key
         JOIN visible_docs ON visible_docs.id = search_index.document_id
         WHERE search_index MATCH ?
           AND NOT EXISTS (
             SELECT 1 FROM trashed_resources t
             WHERE t.resource_type = 'document' AND t.resource_id = search_index.document_id
           )
           ${siteFilter}
         ORDER BY rank, search_index.document_id, b.ordinal
         LIMIT ?`,
      )
      .all(...params) as SearchResultRow[];
    return rows.map((row) => ({
      documentId: row.document_id,
      ...(row.site_id ? { siteId: row.site_id } : {}),
      documentTitle: row.document_title,
      ...(row.block_id ? { blockId: row.block_id } : {}),
      nodeType: row.node_type,
      ...(row.directive_name ? { directiveName: row.directive_name } : {}),
      ...(row.title ? { title: row.title } : {}),
      excerpt: row.excerpt,
      ...(row.line === null ? {} : { line: row.line }),
      rank: row.rank,
      access: { role: rankToRole(row.access_rank) },
    }));
  }

  recordRecent(userId: string, resourceType: CloudResourceType, resourceId: string, viewedAt: string): void {
    this.db
      .prepare(
        `INSERT INTO recent_items (user_id, resource_type, resource_id, viewed_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(user_id, resource_type, resource_id) DO UPDATE SET viewed_at = excluded.viewed_at`,
      )
      .run(userId, resourceType, resourceId, viewedAt);
    this.db
      .prepare(
        `DELETE FROM recent_items
         WHERE user_id = ? AND rowid NOT IN (
           SELECT rowid FROM recent_items WHERE user_id = ? ORDER BY viewed_at DESC LIMIT 100
         )`,
      )
      .run(userId, userId);
  }

  listRecents(user: CloudUserRecord, limit = 25): CloudNavigationItem[] {
    return this.listNavigationItems("recent_items", "viewed_at", user, limit);
  }

  setFavorite(userId: string, resourceType: CloudResourceType, resourceId: string, favoritedAt: string): void {
    this.db
      .prepare(
        `INSERT INTO favorites (user_id, resource_type, resource_id, favorited_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(user_id, resource_type, resource_id) DO UPDATE SET favorited_at = excluded.favorited_at`,
      )
      .run(userId, resourceType, resourceId, favoritedAt);
  }

  removeFavorite(userId: string, resourceType: CloudResourceType, resourceId: string): void {
    this.db.prepare("DELETE FROM favorites WHERE user_id = ? AND resource_type = ? AND resource_id = ?").run(userId, resourceType, resourceId);
  }

  listFavorites(user: CloudUserRecord, limit = 100): CloudNavigationItem[] {
    return this.listNavigationItems("favorites", "favorited_at", user, limit);
  }

  trashResource(resourceType: CloudResourceType, resourceId: string, trashedAt: string, trashedBy: string): void {
    this.db
      .prepare(
        `INSERT INTO trashed_resources (resource_type, resource_id, trashed_at, trashed_by)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(resource_type, resource_id) DO UPDATE SET
           trashed_at = excluded.trashed_at,
           trashed_by = excluded.trashed_by`,
      )
      .run(resourceType, resourceId, trashedAt, trashedBy);
  }

  restoreResource(resourceType: CloudResourceType, resourceId: string): void {
    this.db.prepare("DELETE FROM trashed_resources WHERE resource_type = ? AND resource_id = ?").run(resourceType, resourceId);
  }

  isTrashed(resourceType: CloudResourceType, resourceId: string): boolean {
    return Boolean(
      this.db
        .prepare("SELECT 1 AS found FROM trashed_resources WHERE resource_type = ? AND resource_id = ?")
        .get(resourceType, resourceId),
    );
  }

  listTrash(user: CloudUserRecord, limit = 100): CloudTrashItem[] {
    const rows = this.navigationRows("trashed_resources", "trashed_at", user, limit, "trashed_by");
    return rows.map((row) => ({ ...navigationItem(row), trashedBy: row.actor_id ?? "unknown" }));
  }

  writeComment(comment: Omit<CloudComment, "createdByName">): void {
    this.db
      .prepare(
        `INSERT INTO comments
          (id, document_id, block_id, line, parent_id, body, created_by, created_at, updated_at, resolved_at, resolved_by)
         VALUES (@id, @documentId, @blockId, @line, @parentId, @body, @createdBy, @createdAt, @updatedAt, @resolvedAt, @resolvedBy)
         ON CONFLICT(id) DO UPDATE SET
           body = excluded.body,
           updated_at = excluded.updated_at,
           resolved_at = excluded.resolved_at,
           resolved_by = excluded.resolved_by`,
      )
      .run({
        ...comment,
        blockId: comment.blockId ?? null,
        line: comment.line ?? null,
        parentId: comment.parentId ?? null,
        resolvedAt: comment.resolvedAt ?? null,
        resolvedBy: comment.resolvedBy ?? null,
      });
  }

  readComment(id: string): CloudComment | undefined {
    const row = this.db
      .prepare(
        `SELECT c.*, u.name AS created_by_name
         FROM comments c JOIN users u ON u.id = c.created_by
         WHERE c.id = ?`,
      )
      .get(id) as CommentRow | undefined;
    return row ? cloudComment(row) : undefined;
  }

  listComments(documentId: string): CloudComment[] {
    const rows = this.db
      .prepare(
        `SELECT c.*, u.name AS created_by_name
         FROM comments c JOIN users u ON u.id = c.created_by
         WHERE c.document_id = ?
         ORDER BY c.created_at, c.id`,
      )
      .all(documentId) as CommentRow[];
    return rows.map(cloudComment);
  }

  writeNotification(notification: CloudNotification): void {
    this.db
      .prepare(
        `INSERT INTO notifications
          (id, user_id, type, title, body, resource_type, resource_id, created_at, read_at)
         VALUES (@id, @userId, @type, @title, @body, @resourceType, @resourceId, @createdAt, @readAt)
         ON CONFLICT(id) DO UPDATE SET read_at = excluded.read_at`,
      )
      .run({
        ...notification,
        resourceType: notification.resourceType ?? null,
        resourceId: notification.resourceId ?? null,
        readAt: notification.readAt ?? null,
      });
  }

  listNotifications(userId: string, limit = 100): CloudNotification[] {
    const rows = this.db
      .prepare("SELECT * FROM notifications WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT ?")
      .all(userId, limit) as NotificationRow[];
    return rows.map(cloudNotification);
  }

  markNotificationRead(userId: string, id: string, readAt: string): boolean {
    return this.db.prepare("UPDATE notifications SET read_at = ? WHERE id = ? AND user_id = ?").run(readAt, id, userId).changes > 0;
  }

  markAllNotificationsRead(userId: string, readAt: string): number {
    return this.db.prepare("UPDATE notifications SET read_at = ? WHERE user_id = ? AND read_at IS NULL").run(readAt, userId).changes;
  }

  writeActivity(event: Omit<CloudActivityEvent, "actorName">): void {
    this.db
      .prepare(
        `INSERT INTO activity_events (id, actor_id, action, resource_type, resource_id, detail_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(event.id, event.actorId, event.action, event.resourceType, event.resourceId, JSON.stringify(event.detail), event.createdAt);
  }

  listActivity(user: CloudUserRecord, siteId?: string, documentId?: string, limit = 100): CloudActivityEvent[] {
    const params: unknown[] = [user.id];
    const filters: string[] = [];
    if (siteId) {
      filters.push(
        `((e.resource_type = 'site' AND e.resource_id = ?)
          OR (e.resource_type = 'document' AND EXISTS (
            SELECT 1 FROM site_documents filter_sd WHERE filter_sd.site_id = ? AND filter_sd.document_id = e.resource_id
          )))`,
      );
      params.push(siteId, siteId);
    }
    if (documentId) {
      filters.push("e.resource_type = 'document' AND e.resource_id = ?");
      params.push(documentId);
    }
    params.push(limit);
    const rows = this.db
      .prepare(
        `WITH ${visibleResourcesCtes}
         SELECT e.*, u.name AS actor_name
         FROM activity_events e
         JOIN users u ON u.id = e.actor_id
         LEFT JOIN visible_docs ON e.resource_type = 'document' AND visible_docs.id = e.resource_id
         LEFT JOIN visible_sites ON e.resource_type = 'site' AND visible_sites.id = e.resource_id
         WHERE ((e.resource_type = 'document' AND visible_docs.id IS NOT NULL)
           OR (e.resource_type = 'site' AND visible_sites.id IS NOT NULL))
           ${filters.length ? `AND ${filters.join(" AND ")}` : ""}
         ORDER BY e.created_at DESC, e.id DESC
         LIMIT ?`,
      )
      .all(...params) as ActivityRow[];
    return rows.map(cloudActivity);
  }

  writeApproval(approval: Omit<CloudApproval, "reviewerName">): void {
    this.db
      .prepare(
        `INSERT INTO approvals
          (id, document_id, document_hash, requested_by, reviewer_id, status, note, created_at, updated_at)
         VALUES (@id, @documentId, @documentHash, @requestedBy, @reviewerId, @status, @note, @createdAt, @updatedAt)
         ON CONFLICT(id) DO UPDATE SET
           status = excluded.status,
           note = excluded.note,
           updated_at = excluded.updated_at`,
      )
      .run({ ...approval, note: approval.note ?? null });
  }

  readApproval(id: string): CloudApproval | undefined {
    const row = this.db
      .prepare(
        `SELECT a.*, u.name AS reviewer_name
         FROM approvals a JOIN users u ON u.id = a.reviewer_id
         WHERE a.id = ?`,
      )
      .get(id) as ApprovalRow | undefined;
    return row ? cloudApproval(row) : undefined;
  }

  listApprovals(documentId: string): CloudApproval[] {
    const rows = this.db
      .prepare(
        `SELECT a.*, u.name AS reviewer_name
         FROM approvals a JOIN users u ON u.id = a.reviewer_id
         WHERE a.document_id = ?
         ORDER BY a.updated_at DESC, a.id DESC`,
      )
      .all(documentId) as ApprovalRow[];
    return rows.map(cloudApproval);
  }

  createGroup(group: Omit<CloudGroup, "members">, managerId: string): void {
    const write = this.db.transaction(() => {
      this.db
        .prepare("INSERT INTO groups (id, name, created_by, created_at, updated_at) VALUES (?, ?, ?, ?, ?)")
        .run(group.id, group.name, group.createdBy, group.createdAt, group.updatedAt);
      this.db
        .prepare("INSERT INTO group_members (group_id, user_id, role, added_at) VALUES (?, ?, 'manager', ?)")
        .run(group.id, managerId, group.createdAt);
    });
    write();
  }

  readGroup(id: string): CloudGroup | undefined {
    const row = this.db.prepare("SELECT * FROM groups WHERE id = ?").get(id) as GroupRow | undefined;
    return row ? this.groupFromRow(row) : undefined;
  }

  listGroups(userId: string): CloudGroup[] {
    const rows = this.db
      .prepare(
        `SELECT g.* FROM groups g
         JOIN group_members gm ON gm.group_id = g.id AND gm.user_id = ?
         ORDER BY lower(g.name), g.id`,
      )
      .all(userId) as GroupRow[];
    return rows.map((row) => this.groupFromRow(row));
  }

  addGroupMember(groupId: string, userId: string, role: "member" | "manager", addedAt: string): void {
    this.db
      .prepare(
        `INSERT INTO group_members (group_id, user_id, role, added_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(group_id, user_id) DO UPDATE SET role = excluded.role`,
      )
      .run(groupId, userId, role, addedAt);
    this.db.prepare("UPDATE groups SET updated_at = ? WHERE id = ?").run(addedAt, groupId);
  }

  removeGroupMember(groupId: string, userId: string, updatedAt: string): boolean {
    const removed = this.db.prepare("DELETE FROM group_members WHERE group_id = ? AND user_id = ?").run(groupId, userId).changes > 0;
    if (removed) this.db.prepare("UPDATE groups SET updated_at = ? WHERE id = ?").run(updatedAt, groupId);
    return removed;
  }

  listGroupPermissions(resourceType: CloudResourceType, resourceId: string): CloudGroupPermission[] {
    const rows = this.db
      .prepare(
        `SELECT gp.group_id, g.name AS group_name, gp.role, gp.added_at
         FROM group_permissions gp
         JOIN groups g ON g.id = gp.group_id
         WHERE gp.resource_type = ? AND gp.resource_id = ?
         ORDER BY lower(g.name), g.id`,
      )
      .all(resourceType, resourceId) as GroupPermissionRow[];
    return rows.map((row) => ({
      groupId: row.group_id,
      groupName: row.group_name,
      role: row.role,
      addedAt: row.added_at,
    }));
  }

  setGroupPermission(
    resourceType: CloudResourceType,
    resourceId: string,
    groupId: string,
    role: Exclude<CloudRole, "owner">,
    addedAt: string,
  ): void {
    this.db
      .prepare(
        `INSERT INTO group_permissions (resource_type, resource_id, group_id, role, added_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(resource_type, resource_id, group_id) DO UPDATE SET
           role = excluded.role,
           added_at = excluded.added_at`,
      )
      .run(resourceType, resourceId, groupId, role, addedAt);
  }

  removeGroupPermission(resourceType: CloudResourceType, resourceId: string, groupId: string): boolean {
    return this.db
      .prepare("DELETE FROM group_permissions WHERE resource_type = ? AND resource_id = ? AND group_id = ?")
      .run(resourceType, resourceId, groupId).changes > 0;
  }

  private groupFromRow(row: GroupRow): CloudGroup {
    const members = this.db
      .prepare(
        `SELECT gm.user_id, u.name AS user_name, gm.role, gm.added_at
         FROM group_members gm JOIN users u ON u.id = gm.user_id
         WHERE gm.group_id = ?
         ORDER BY CASE gm.role WHEN 'manager' THEN 0 ELSE 1 END, lower(u.name), u.id`,
      )
      .all(row.id) as GroupMemberRow[];
    return {
      id: row.id,
      name: row.name,
      createdBy: row.created_by,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      members: members.map((member) => ({
        userId: member.user_id,
        userName: member.user_name,
        role: member.role,
        addedAt: member.added_at,
      })),
    };
  }

  writeProject(project: CloudProject): void {
    this.db
      .prepare(
        `INSERT INTO projects (id, project_key, name, site_id, description, created_by, created_at, updated_at)
         VALUES (@id, @key, @name, @siteId, @description, @createdBy, @createdAt, @updatedAt)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name,
           description = excluded.description,
           updated_at = excluded.updated_at`,
      )
      .run({ ...project, description: project.description ?? null });
  }

  readProject(idOrKey: string): CloudProject | undefined {
    const row = this.db
      .prepare("SELECT * FROM projects WHERE id = ? OR project_key = upper(?)")
      .get(idOrKey, idOrKey) as ProjectRow | undefined;
    return row ? cloudProject(row) : undefined;
  }

  listProjects(user: CloudUserRecord): CloudProject[] {
    const rows = this.db
      .prepare(
        `WITH ${visibleResourcesCtes}
         SELECT p.*, visible_sites.rank AS access_rank
         FROM projects p
         JOIN visible_sites ON visible_sites.id = p.site_id
         WHERE NOT EXISTS (
           SELECT 1 FROM trashed_resources t WHERE t.resource_type = 'site' AND t.resource_id = p.site_id
         )
         ORDER BY lower(p.name), p.project_key`,
      )
      .all(user.id) as ProjectRow[];
    return rows.map((row) => ({ ...cloudProject(row), access: { role: rankToRole(row.access_rank ?? 1) } }));
  }

  createIssue(issue: Omit<CloudIssue, "key" | "sequence" | "assigneeName">, projectKey: string): CloudIssue {
    const create = this.db.transaction(() => {
      const next = this.db
        .prepare("SELECT COALESCE(MAX(sequence), 0) + 1 AS sequence FROM issues WHERE project_id = ?")
        .get(issue.projectId) as { sequence: number };
      const key = `${projectKey}-${next.sequence}`;
      this.db
        .prepare(
          `INSERT INTO issues
            (id, issue_key, project_id, sequence, summary, description, issue_type, status, priority,
             reporter_id, assignee_id, labels_json, sprint_id, parent_id, estimate, due_date, created_at, updated_at)
           VALUES
            (@id, @key, @projectId, @sequence, @summary, @description, @type, @status, @priority,
             @reporterId, @assigneeId, @labelsJson, @sprintId, @parentId, @estimate, @dueDate, @createdAt, @updatedAt)`,
        )
        .run({
          ...issue,
          key,
          sequence: next.sequence,
          description: issue.description ?? null,
          assigneeId: issue.assigneeId ?? null,
          labelsJson: JSON.stringify(issue.labels),
          sprintId: issue.sprintId ?? null,
          parentId: issue.parentId ?? null,
          estimate: issue.estimate ?? null,
          dueDate: issue.dueDate ?? null,
        });
      return this.readIssue(issue.id);
    });
    const created = create();
    if (!created) throw new Error("Created issue could not be read");
    return created;
  }

  readIssue(idOrKey: string): CloudIssue | undefined {
    const row = this.db
      .prepare(
        `SELECT i.*, u.name AS assignee_name
         FROM issues i LEFT JOIN users u ON u.id = i.assignee_id
         WHERE i.id = ? OR i.issue_key = upper(?)`,
      )
      .get(idOrKey, idOrKey) as IssueRow | undefined;
    return row ? cloudIssue(row) : undefined;
  }

  listIssues(projectId: string, filter: CloudIssueFilter): CloudIssue[] {
    const params: unknown[] = [projectId];
    const clauses = ["i.project_id = ?"];
    if (filter.q) {
      const pattern = likePattern(filter.q);
      clauses.push("(i.issue_key LIKE ? ESCAPE '\\' OR i.summary LIKE ? ESCAPE '\\' OR i.description LIKE ? ESCAPE '\\')");
      params.push(pattern, pattern, pattern);
    }
    if (filter.status) {
      clauses.push("i.status = ?");
      params.push(filter.status);
    }
    if (filter.type) {
      clauses.push("i.issue_type = ?");
      params.push(filter.type);
    }
    if (filter.priority) {
      clauses.push("i.priority = ?");
      params.push(filter.priority);
    }
    if (filter.assigneeId) {
      clauses.push("i.assignee_id = ?");
      params.push(filter.assigneeId);
    }
    if (filter.label) {
      clauses.push("EXISTS (SELECT 1 FROM json_each(i.labels_json) WHERE lower(value) = lower(?))");
      params.push(filter.label);
    }
    if (filter.sprintId === null) clauses.push("i.sprint_id IS NULL");
    else if (filter.sprintId) {
      clauses.push("i.sprint_id = ?");
      params.push(filter.sprintId);
    }
    params.push(filter.limit);
    const rows = this.db
      .prepare(
        `SELECT i.*, u.name AS assignee_name
         FROM issues i LEFT JOIN users u ON u.id = i.assignee_id
         WHERE ${clauses.join(" AND ")}
         ORDER BY
           CASE i.status WHEN 'in_progress' THEN 0 WHEN 'in_review' THEN 1 WHEN 'todo' THEN 2 WHEN 'backlog' THEN 3 ELSE 4 END,
           CASE i.priority WHEN 'highest' THEN 0 WHEN 'high' THEN 1 WHEN 'medium' THEN 2 WHEN 'low' THEN 3 ELSE 4 END,
           i.sequence
         LIMIT ?`,
      )
      .all(...params) as IssueRow[];
    return rows.map(cloudIssue);
  }

  writeIssue(issue: CloudIssue): void {
    this.db
      .prepare(
        `UPDATE issues SET
           summary = @summary,
           description = @description,
           issue_type = @type,
           status = @status,
           priority = @priority,
           assignee_id = @assigneeId,
           labels_json = @labelsJson,
           sprint_id = @sprintId,
           parent_id = @parentId,
           estimate = @estimate,
           due_date = @dueDate,
           updated_at = @updatedAt
         WHERE id = @id`,
      )
      .run({
        ...issue,
        description: issue.description ?? null,
        assigneeId: issue.assigneeId ?? null,
        labelsJson: JSON.stringify(issue.labels),
        sprintId: issue.sprintId ?? null,
        parentId: issue.parentId ?? null,
        estimate: issue.estimate ?? null,
        dueDate: issue.dueDate ?? null,
      });
  }

  writeSprint(sprint: CloudSprint): void {
    this.db
      .prepare(
        `INSERT INTO sprints
          (id, project_id, name, goal, status, start_at, end_at, created_by, created_at, updated_at)
         VALUES (@id, @projectId, @name, @goal, @status, @startAt, @endAt, @createdBy, @createdAt, @updatedAt)
         ON CONFLICT(id) DO UPDATE SET
           name = excluded.name,
           goal = excluded.goal,
           status = excluded.status,
           start_at = excluded.start_at,
           end_at = excluded.end_at,
           updated_at = excluded.updated_at`,
      )
      .run({ ...sprint, goal: sprint.goal ?? null, startAt: sprint.startAt ?? null, endAt: sprint.endAt ?? null });
  }

  readSprint(id: string): CloudSprint | undefined {
    const row = this.db.prepare("SELECT * FROM sprints WHERE id = ?").get(id) as SprintRow | undefined;
    return row ? cloudSprint(row) : undefined;
  }

  listSprints(projectId: string): CloudSprint[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM sprints WHERE project_id = ?
         ORDER BY CASE status WHEN 'active' THEN 0 WHEN 'planned' THEN 1 ELSE 2 END, created_at DESC, id`,
      )
      .all(projectId) as SprintRow[];
    return rows.map(cloudSprint);
  }

  activeSprint(projectId: string): CloudSprint | undefined {
    const row = this.db.prepare("SELECT * FROM sprints WHERE project_id = ? AND status = 'active' LIMIT 1").get(projectId) as SprintRow | undefined;
    return row ? cloudSprint(row) : undefined;
  }

  closeSprint(sprint: CloudSprint, updatedAt: string): void {
    const close = this.db.transaction(() => {
      this.writeSprint({ ...sprint, status: "closed", endAt: sprint.endAt ?? updatedAt, updatedAt });
      this.db
        .prepare("UPDATE issues SET sprint_id = NULL, status = 'backlog', updated_at = ? WHERE sprint_id = ? AND status != 'done'")
        .run(updatedAt, sprint.id);
    });
    close();
  }

  writeIssueLink(link: Omit<CloudIssueLink, "targetIssueKey" | "targetIssueSummary">): void {
    this.db
      .prepare(
        `INSERT INTO issue_links (id, source_issue_id, target_issue_id, link_type, created_by, created_at)
         VALUES (@id, @sourceIssueId, @targetIssueId, @type, @createdBy, @createdAt)`,
      )
      .run(link);
  }

  listIssueLinks(issueId: string): CloudIssueLink[] {
    const rows = this.db
      .prepare(
        `SELECT l.*, target.issue_key AS target_issue_key, target.summary AS target_issue_summary
         FROM issue_links l JOIN issues target ON target.id = l.target_issue_id
         WHERE l.source_issue_id = ?
         ORDER BY l.created_at, l.id`,
      )
      .all(issueId) as IssueLinkRow[];
    return rows.map(cloudIssueLink);
  }

  writeIssueComment(comment: Omit<CloudIssueComment, "createdByName">): void {
    this.db
      .prepare(
        `INSERT INTO issue_comments (id, issue_id, body, created_by, created_at, updated_at)
         VALUES (@id, @issueId, @body, @createdBy, @createdAt, @updatedAt)`
      )
      .run(comment);
  }

  listIssueComments(issueId: string): CloudIssueComment[] {
    const rows = this.db
      .prepare(
        `SELECT c.*, u.name AS created_by_name
         FROM issue_comments c JOIN users u ON u.id = c.created_by
         WHERE c.issue_id = ? ORDER BY c.created_at, c.id`,
      )
      .all(issueId) as IssueCommentRow[];
    return rows.map(cloudIssueComment);
  }

  writeIssueEvent(event: Omit<CloudIssueEvent, "actorName">): void {
    this.db
      .prepare(
        `INSERT INTO issue_events (id, issue_id, actor_id, action, detail_json, created_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(event.id, event.issueId, event.actorId, event.action, JSON.stringify(event.detail), event.createdAt);
  }

  listIssueEvents(issueId: string): CloudIssueEvent[] {
    const rows = this.db
      .prepare(
        `SELECT e.*, u.name AS actor_name
         FROM issue_events e JOIN users u ON u.id = e.actor_id
         WHERE e.issue_id = ? ORDER BY e.created_at DESC, e.id DESC`,
      )
      .all(issueId) as IssueEventRow[];
    return rows.map(cloudIssueEvent);
  }

  writePatchProposal(proposal: Omit<CloudPatchProposal, "proposedByName">): void {
    this.db
      .prepare(
        `INSERT INTO patch_proposals
          (id, document_id, document_hash, issue_id, proposed_by, summary, ops_json, proof_json, status,
           reviewed_by, reviewed_at, applied_hash, created_at, updated_at)
         VALUES
          (@id, @documentId, @documentHash, @issueId, @proposedBy, @summary, @opsJson, @proofJson, @status,
           @reviewedBy, @reviewedAt, @appliedHash, @createdAt, @updatedAt)
         ON CONFLICT(id) DO UPDATE SET
           status = excluded.status,
           reviewed_by = excluded.reviewed_by,
           reviewed_at = excluded.reviewed_at,
           applied_hash = excluded.applied_hash,
           updated_at = excluded.updated_at`,
      )
      .run({
        ...proposal,
        issueId: proposal.issueId ?? null,
        summary: proposal.summary ?? null,
        opsJson: JSON.stringify(proposal.ops),
        proofJson: JSON.stringify(proposal.proof),
        reviewedBy: proposal.reviewedBy ?? null,
        reviewedAt: proposal.reviewedAt ?? null,
        appliedHash: proposal.appliedHash ?? null,
      });
  }

  readPatchProposal(id: string): CloudPatchProposal | undefined {
    const row = this.db
      .prepare(
        `SELECT p.*, u.name AS proposed_by_name
         FROM patch_proposals p JOIN users u ON u.id = p.proposed_by
         WHERE p.id = ?`,
      )
      .get(id) as PatchProposalRow | undefined;
    return row ? cloudPatchProposal(row) : undefined;
  }

  listPatchProposals(documentId: string): CloudPatchProposal[] {
    const rows = this.db
      .prepare(
        `SELECT p.*, u.name AS proposed_by_name
         FROM patch_proposals p JOIN users u ON u.id = p.proposed_by
         WHERE p.document_id = ? ORDER BY p.created_at DESC, p.id DESC`,
      )
      .all(documentId) as PatchProposalRow[];
    return rows.map(cloudPatchProposal);
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

      CREATE TABLE IF NOT EXISTS document_revisions (
        document_id TEXT NOT NULL,
        revision INTEGER NOT NULL CHECK (revision > 0),
        title TEXT NOT NULL,
        source TEXT NOT NULL,
        hash TEXT NOT NULL,
        created_at TEXT NOT NULL,
        created_by TEXT NOT NULL,
        PRIMARY KEY (document_id, revision)
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

      CREATE VIRTUAL TABLE IF NOT EXISTS search_index USING fts5(
        row_key UNINDEXED,
        document_id UNINDEXED,
        document_title,
        block_id,
        text,
        tokenize = 'unicode61 remove_diacritics 2'
      );

      CREATE TABLE IF NOT EXISTS recent_items (
        user_id TEXT NOT NULL,
        resource_type TEXT NOT NULL CHECK (resource_type IN ('document', 'site')),
        resource_id TEXT NOT NULL,
        viewed_at TEXT NOT NULL,
        PRIMARY KEY (user_id, resource_type, resource_id)
      );

      CREATE TABLE IF NOT EXISTS favorites (
        user_id TEXT NOT NULL,
        resource_type TEXT NOT NULL CHECK (resource_type IN ('document', 'site')),
        resource_id TEXT NOT NULL,
        favorited_at TEXT NOT NULL,
        PRIMARY KEY (user_id, resource_type, resource_id)
      );

      CREATE TABLE IF NOT EXISTS trashed_resources (
        resource_type TEXT NOT NULL CHECK (resource_type IN ('document', 'site')),
        resource_id TEXT NOT NULL,
        trashed_at TEXT NOT NULL,
        trashed_by TEXT NOT NULL,
        PRIMARY KEY (resource_type, resource_id)
      );

      CREATE TABLE IF NOT EXISTS comments (
        id TEXT PRIMARY KEY,
        document_id TEXT NOT NULL,
        block_id TEXT,
        line INTEGER,
        parent_id TEXT,
        body TEXT NOT NULL,
        created_by TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        resolved_at TEXT,
        resolved_by TEXT
      );

      CREATE TABLE IF NOT EXISTS notifications (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        type TEXT NOT NULL CHECK (type IN ('mention', 'comment', 'approval_requested', 'approval_updated')),
        title TEXT NOT NULL,
        body TEXT NOT NULL,
        resource_type TEXT CHECK (resource_type IN ('document', 'site')),
        resource_id TEXT,
        created_at TEXT NOT NULL,
        read_at TEXT
      );

      CREATE TABLE IF NOT EXISTS activity_events (
        id TEXT PRIMARY KEY,
        actor_id TEXT NOT NULL,
        action TEXT NOT NULL,
        resource_type TEXT NOT NULL CHECK (resource_type IN ('document', 'site')),
        resource_id TEXT NOT NULL,
        detail_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS approvals (
        id TEXT PRIMARY KEY,
        document_id TEXT NOT NULL,
        document_hash TEXT NOT NULL,
        requested_by TEXT NOT NULL,
        reviewer_id TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'changes_requested', 'cancelled')),
        note TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS groups (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        created_by TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS group_members (
        group_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('member', 'manager')),
        added_at TEXT NOT NULL,
        PRIMARY KEY (group_id, user_id)
      );

      CREATE TABLE IF NOT EXISTS group_permissions (
        resource_type TEXT NOT NULL CHECK (resource_type IN ('document', 'site')),
        resource_id TEXT NOT NULL,
        group_id TEXT NOT NULL,
        role TEXT NOT NULL CHECK (role IN ('viewer', 'editor')),
        added_at TEXT NOT NULL,
        PRIMARY KEY (resource_type, resource_id, group_id)
      );

      CREATE TABLE IF NOT EXISTS projects (
        id TEXT PRIMARY KEY,
        project_key TEXT NOT NULL UNIQUE,
        name TEXT NOT NULL,
        site_id TEXT NOT NULL,
        description TEXT,
        created_by TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS sprints (
        id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        name TEXT NOT NULL,
        goal TEXT,
        status TEXT NOT NULL CHECK (status IN ('planned', 'active', 'closed')),
        start_at TEXT,
        end_at TEXT,
        created_by TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS issues (
        id TEXT PRIMARY KEY,
        issue_key TEXT NOT NULL UNIQUE,
        project_id TEXT NOT NULL,
        sequence INTEGER NOT NULL CHECK (sequence > 0),
        summary TEXT NOT NULL,
        description TEXT,
        issue_type TEXT NOT NULL CHECK (issue_type IN ('task', 'story', 'bug', 'epic')),
        status TEXT NOT NULL CHECK (status IN ('backlog', 'todo', 'in_progress', 'in_review', 'done')),
        priority TEXT NOT NULL CHECK (priority IN ('lowest', 'low', 'medium', 'high', 'highest')),
        reporter_id TEXT NOT NULL,
        assignee_id TEXT,
        labels_json TEXT NOT NULL,
        sprint_id TEXT,
        parent_id TEXT,
        estimate REAL CHECK (estimate IS NULL OR estimate >= 0),
        due_date TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        UNIQUE (project_id, sequence)
      );

      CREATE TABLE IF NOT EXISTS issue_links (
        id TEXT PRIMARY KEY,
        source_issue_id TEXT NOT NULL,
        target_issue_id TEXT NOT NULL,
        link_type TEXT NOT NULL CHECK (link_type IN ('blocks', 'relates', 'duplicates')),
        created_by TEXT NOT NULL,
        created_at TEXT NOT NULL,
        UNIQUE (source_issue_id, target_issue_id, link_type)
      );

      CREATE TABLE IF NOT EXISTS issue_comments (
        id TEXT PRIMARY KEY,
        issue_id TEXT NOT NULL,
        body TEXT NOT NULL,
        created_by TEXT NOT NULL,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS issue_events (
        id TEXT PRIMARY KEY,
        issue_id TEXT NOT NULL,
        actor_id TEXT NOT NULL,
        action TEXT NOT NULL,
        detail_json TEXT NOT NULL,
        created_at TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS patch_proposals (
        id TEXT PRIMARY KEY,
        document_id TEXT NOT NULL,
        document_hash TEXT NOT NULL,
        issue_id TEXT,
        proposed_by TEXT NOT NULL,
        summary TEXT,
        ops_json TEXT NOT NULL,
        proof_json TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected', 'applied')),
        reviewed_by TEXT,
        reviewed_at TEXT,
        applied_hash TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );

      CREATE INDEX IF NOT EXISTS idx_permissions_user ON permissions(user_id, resource_type, resource_id);
      CREATE INDEX IF NOT EXISTS idx_share_links_token ON share_links(token_hash);
      CREATE INDEX IF NOT EXISTS idx_site_documents_document ON site_documents(document_id, site_id);
      CREATE INDEX IF NOT EXISTS idx_documents_updated ON documents(updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_document_revisions_hash ON document_revisions(document_id, hash);
      CREATE INDEX IF NOT EXISTS idx_sites_updated ON sites(updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_blocks_document ON blocks(document_id, ordinal);
      CREATE INDEX IF NOT EXISTS idx_blocks_block_id ON blocks(block_id);
      CREATE INDEX IF NOT EXISTS idx_blocks_text ON blocks(text);
      CREATE INDEX IF NOT EXISTS idx_recent_items_user ON recent_items(user_id, viewed_at DESC);
      CREATE INDEX IF NOT EXISTS idx_favorites_user ON favorites(user_id, favorited_at DESC);
      CREATE INDEX IF NOT EXISTS idx_trash_time ON trashed_resources(trashed_at DESC);
      CREATE INDEX IF NOT EXISTS idx_comments_document ON comments(document_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_comments_parent ON comments(parent_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, read_at, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_activity_resource ON activity_events(resource_type, resource_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_approvals_document ON approvals(document_id, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_approvals_reviewer ON approvals(reviewer_id, status, updated_at DESC);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_groups_name ON groups(lower(name));
      CREATE INDEX IF NOT EXISTS idx_group_members_user ON group_members(user_id, group_id);
      CREATE INDEX IF NOT EXISTS idx_group_permissions_group ON group_permissions(group_id, resource_type, resource_id);
      CREATE INDEX IF NOT EXISTS idx_projects_site ON projects(site_id, project_key);
      CREATE INDEX IF NOT EXISTS idx_sprints_project ON sprints(project_id, status, created_at DESC);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_sprints_one_active ON sprints(project_id) WHERE status = 'active';
      CREATE INDEX IF NOT EXISTS idx_issues_project_status ON issues(project_id, status, sequence);
      CREATE INDEX IF NOT EXISTS idx_issues_assignee ON issues(assignee_id, status, updated_at DESC);
      CREATE INDEX IF NOT EXISTS idx_issues_sprint ON issues(sprint_id, status, sequence);
      CREATE INDEX IF NOT EXISTS idx_issue_links_source ON issue_links(source_issue_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_issue_comments_issue ON issue_comments(issue_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_issue_events_issue ON issue_events(issue_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_patch_proposals_document ON patch_proposals(document_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_patch_proposals_issue ON patch_proposals(issue_id, created_at DESC);
    `);
    this.db.exec(`
      INSERT OR IGNORE INTO document_revisions
        (document_id, revision, title, source, hash, created_at, created_by)
      SELECT id, 1, title, source, hash, created_at, created_by
      FROM documents;
    `);
    this.rebuildSearchIndexOnce();
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
    this.db.prepare("DELETE FROM search_index WHERE document_id = ?").run(document.id);
    const insert = this.db.prepare(
      `INSERT INTO blocks
        (row_key, document_id, block_id, aliases_json, node_type, directive_name, title, text, line, depth, ordinal)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const searchInsert = this.db.prepare(
      `INSERT INTO search_index (row_key, document_id, document_title, block_id, text)
       VALUES (?, ?, ?, ?, ?)`,
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
      searchInsert.run(row.rowKey, row.documentId, document.title, row.blockId ?? "", [row.title, row.text].filter(Boolean).join("\n"));
    }
  }

  private rebuildSearchIndexOnce(): void {
    const version = this.db.prepare("SELECT value FROM meta WHERE key = 'search_index_version'").get() as { value: string } | undefined;
    if (version?.value === "1") return;
    const rebuild = this.db.transaction(() => {
      this.db.prepare("DELETE FROM search_index").run();
      this.db
        .prepare(
          `INSERT INTO search_index (row_key, document_id, document_title, block_id, text)
           SELECT b.row_key, b.document_id, d.title, COALESCE(b.block_id, ''),
             trim(COALESCE(b.title || char(10), '') || b.text)
           FROM blocks b
           JOIN documents d ON d.id = b.document_id`,
        )
        .run();
      this.db
        .prepare("INSERT INTO meta (key, value) VALUES ('search_index_version', '1') ON CONFLICT(key) DO UPDATE SET value = '1'")
        .run();
    });
    rebuild();
  }

  private listNavigationItems(table: "recent_items" | "favorites", timeColumn: "viewed_at" | "favorited_at", user: CloudUserRecord, limit: number): CloudNavigationItem[] {
    return this.navigationRows(table, timeColumn, user, limit).map(navigationItem);
  }

  private navigationRows(
    table: "recent_items" | "favorites" | "trashed_resources",
    timeColumn: "viewed_at" | "favorited_at" | "trashed_at",
    user: CloudUserRecord,
    limit: number,
    actorColumn?: "trashed_by",
  ): NavigationRow[] {
    const userFilter = table === "trashed_resources" ? "" : "nav.user_id = ? AND";
    const params: unknown[] = [user.id];
    if (table !== "trashed_resources") params.push(user.id);
    params.push(limit);
    return this.db
      .prepare(
        `WITH ${visibleResourcesCtes}
         SELECT
           nav.resource_type,
           nav.resource_id,
           CASE nav.resource_type
             WHEN 'document' THEN (SELECT sd.site_id FROM site_documents sd WHERE sd.document_id = nav.resource_id ORDER BY sd.position LIMIT 1)
             ELSE nav.resource_id
           END AS site_id,
           CASE nav.resource_type WHEN 'document' THEN d.title ELSE s.title END AS title,
           CASE nav.resource_type WHEN 'document' THEN d.updated_at ELSE s.updated_at END AS updated_at,
           nav.${timeColumn} AS activity_at,
           CASE nav.resource_type
             WHEN 'document' THEN visible_docs.rank
             ELSE visible_sites.rank
           END AS access_rank
           ${actorColumn ? `, nav.${actorColumn} AS actor_id` : ""}
         FROM ${table} nav
         LEFT JOIN documents d ON nav.resource_type = 'document' AND d.id = nav.resource_id
         LEFT JOIN sites s ON nav.resource_type = 'site' AND s.id = nav.resource_id
         LEFT JOIN visible_docs ON nav.resource_type = 'document' AND visible_docs.id = nav.resource_id
         LEFT JOIN visible_sites ON nav.resource_type = 'site' AND visible_sites.id = nav.resource_id
         WHERE ${userFilter}
           ((nav.resource_type = 'document' AND visible_docs.id IS NOT NULL)
             OR (nav.resource_type = 'site' AND visible_sites.id IS NOT NULL))
           ${table === "trashed_resources" ? "" : "AND NOT EXISTS (SELECT 1 FROM trashed_resources trash WHERE trash.resource_type = nav.resource_type AND trash.resource_id = nav.resource_id)"}
         ORDER BY nav.${timeColumn} DESC
         LIMIT ?`,
      )
      .all(...params) as NavigationRow[];
  }

  private queryDocuments(user: CloudUserRecord, query: CloudDbQuery): Array<Record<string, unknown>> {
    const params: unknown[] = [user.id];
    const filters: string[] = [];
    if (query.q) {
      const pattern = likePattern(query.q);
      filters.push("(d.title LIKE ? ESCAPE '\\' OR d.source LIKE ? ESCAPE '\\')");
      params.push(pattern, pattern);
    }
    filters.push("NOT EXISTS (SELECT 1 FROM trashed_resources t WHERE t.resource_type = 'document' AND t.resource_id = d.id)");
    if (query.siteId) {
      filters.push("EXISTS (SELECT 1 FROM site_documents sd WHERE sd.site_id = ? AND sd.document_id = d.id)");
      params.push(query.siteId);
    }
    if (query.documentId) {
      filters.push("d.id = ?");
      params.push(query.documentId);
    }
    params.push(query.limit, query.offset);
    const sql = `WITH ${visibleResourcesCtes}
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
    filters.push("NOT EXISTS (SELECT 1 FROM trashed_resources t WHERE t.resource_type = 'site' AND t.resource_id = s.id)");
    if (query.siteId) {
      filters.push("s.id = ?");
      params.push(query.siteId);
    }
    params.push(query.limit, query.offset);
    const sql = `WITH ${visibleResourcesCtes}
      SELECT s.record_json, visible_sites.rank
      FROM sites s
      JOIN visible_sites ON visible_sites.id = s.id
      ${filters.length ? `WHERE ${filters.join(" AND ")}` : ""}
      ORDER BY s.updated_at DESC, s.id
      LIMIT ? OFFSET ?`;
    const rows = this.db.prepare(sql).all(...params) as RecordJsonRankRow[];
    return rows.map((row) => siteQueryRow(parseRecord<CloudSiteRecord>(row.record_json), rankToRole(row.rank)));
  }

  private queryBlocks(user: CloudUserRecord, query: CloudDbQuery): Array<Record<string, unknown>> {
    const params: unknown[] = [user.id];
    const filters: string[] = [];
    if (query.q) {
      const pattern = likePattern(query.q);
      filters.push("(b.text LIKE ? ESCAPE '\\' OR b.block_id LIKE ? ESCAPE '\\' OR b.title LIKE ? ESCAPE '\\')");
      params.push(pattern, pattern, pattern);
    }
    filters.push("NOT EXISTS (SELECT 1 FROM trashed_resources t WHERE t.resource_type = 'document' AND t.resource_id = b.document_id)");
    if (query.siteId) {
      filters.push("EXISTS (SELECT 1 FROM site_documents sd WHERE sd.site_id = ? AND sd.document_id = b.document_id)");
      params.push(query.siteId);
    }
    if (query.documentId) {
      filters.push("b.document_id = ?");
      params.push(query.documentId);
    }
    params.push(query.limit, query.offset);
    const sql = `WITH ${visibleResourcesCtes}
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

function documentRevision(row: DocumentRevisionRow): CloudDocumentRevision {
  return {
    documentId: row.document_id,
    revision: row.revision,
    title: row.title,
    source: row.source,
    hash: row.hash,
    createdAt: row.created_at,
    createdBy: row.created_by,
  };
}

function documentRevisionSummary(row: DocumentRevisionRow): CloudDocumentRevisionSummary {
  return {
    documentId: row.document_id,
    revision: row.revision,
    title: row.title,
    hash: row.hash,
    createdAt: row.created_at,
    createdBy: row.created_by,
  };
}

function navigationItem(row: NavigationRow): CloudNavigationItem {
  return {
    resourceType: row.resource_type,
    resourceId: row.resource_id,
    ...(row.site_id ? { siteId: row.site_id } : {}),
    title: row.title,
    updatedAt: row.updated_at,
    activityAt: row.activity_at,
    access: { role: rankToRole(row.access_rank) },
  };
}

function cloudComment(row: CommentRow): CloudComment {
  return {
    id: row.id,
    documentId: row.document_id,
    ...(row.block_id ? { blockId: row.block_id } : {}),
    ...(row.line === null ? {} : { line: row.line }),
    ...(row.parent_id ? { parentId: row.parent_id } : {}),
    body: row.body,
    createdBy: row.created_by,
    createdByName: row.created_by_name,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.resolved_at ? { resolvedAt: row.resolved_at } : {}),
    ...(row.resolved_by ? { resolvedBy: row.resolved_by } : {}),
  };
}

function cloudNotification(row: NotificationRow): CloudNotification {
  return {
    id: row.id,
    userId: row.user_id,
    type: row.type,
    title: row.title,
    body: row.body,
    ...(row.resource_type ? { resourceType: row.resource_type } : {}),
    ...(row.resource_id ? { resourceId: row.resource_id } : {}),
    createdAt: row.created_at,
    ...(row.read_at ? { readAt: row.read_at } : {}),
  };
}

function cloudActivity(row: ActivityRow): CloudActivityEvent {
  return {
    id: row.id,
    actorId: row.actor_id,
    actorName: row.actor_name,
    action: row.action,
    resourceType: row.resource_type,
    resourceId: row.resource_id,
    detail: parseRecord<Record<string, unknown>>(row.detail_json),
    createdAt: row.created_at,
  };
}

function cloudApproval(row: ApprovalRow): CloudApproval {
  return {
    id: row.id,
    documentId: row.document_id,
    documentHash: row.document_hash,
    requestedBy: row.requested_by,
    reviewerId: row.reviewer_id,
    reviewerName: row.reviewer_name,
    status: row.status,
    ...(row.note ? { note: row.note } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function cloudProject(row: ProjectRow): CloudProject {
  return {
    id: row.id,
    key: row.project_key,
    name: row.name,
    siteId: row.site_id,
    ...(row.description ? { description: row.description } : {}),
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function cloudIssue(row: IssueRow): CloudIssue {
  return {
    id: row.id,
    key: row.issue_key,
    projectId: row.project_id,
    sequence: row.sequence,
    summary: row.summary,
    ...(row.description ? { description: row.description } : {}),
    type: row.issue_type,
    status: row.status,
    priority: row.priority,
    reporterId: row.reporter_id,
    ...(row.assignee_id ? { assigneeId: row.assignee_id } : {}),
    ...(row.assignee_name ? { assigneeName: row.assignee_name } : {}),
    labels: parseRecord<string[]>(row.labels_json),
    ...(row.sprint_id ? { sprintId: row.sprint_id } : {}),
    ...(row.parent_id ? { parentId: row.parent_id } : {}),
    ...(row.estimate === null ? {} : { estimate: row.estimate }),
    ...(row.due_date ? { dueDate: row.due_date } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function cloudSprint(row: SprintRow): CloudSprint {
  return {
    id: row.id,
    projectId: row.project_id,
    name: row.name,
    ...(row.goal ? { goal: row.goal } : {}),
    status: row.status,
    ...(row.start_at ? { startAt: row.start_at } : {}),
    ...(row.end_at ? { endAt: row.end_at } : {}),
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function cloudIssueLink(row: IssueLinkRow): CloudIssueLink {
  return {
    id: row.id,
    sourceIssueId: row.source_issue_id,
    targetIssueId: row.target_issue_id,
    targetIssueKey: row.target_issue_key,
    targetIssueSummary: row.target_issue_summary,
    type: row.link_type,
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
}

function cloudIssueComment(row: IssueCommentRow): CloudIssueComment {
  return {
    id: row.id,
    issueId: row.issue_id,
    body: row.body,
    createdBy: row.created_by,
    createdByName: row.created_by_name,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function cloudIssueEvent(row: IssueEventRow): CloudIssueEvent {
  return {
    id: row.id,
    issueId: row.issue_id,
    actorId: row.actor_id,
    actorName: row.actor_name,
    action: row.action,
    detail: parseRecord<Record<string, unknown>>(row.detail_json),
    createdAt: row.created_at,
  };
}

function cloudPatchProposal(row: PatchProposalRow): CloudPatchProposal {
  return {
    id: row.id,
    documentId: row.document_id,
    documentHash: row.document_hash,
    ...(row.issue_id ? { issueId: row.issue_id } : {}),
    proposedBy: row.proposed_by,
    proposedByName: row.proposed_by_name,
    ...(row.summary ? { summary: row.summary } : {}),
    ops: parseRecord<unknown[]>(row.ops_json),
    proof: parseRecord<Record<string, unknown>>(row.proof_json),
    status: row.status,
    ...(row.reviewed_by ? { reviewedBy: row.reviewed_by } : {}),
    ...(row.reviewed_at ? { reviewedAt: row.reviewed_at } : {}),
    ...(row.applied_hash ? { appliedHash: row.applied_hash } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function fullTextQuery(value: string): string {
  return value
    .normalize("NFKC")
    .split(/[^\p{L}\p{N}_-]+/u)
    .map((part) => part.trim())
    .filter((part) => Boolean(part) && !["AND", "OR", "NOT", "NEAR"].includes(part.toUpperCase()))
    .slice(0, 12)
    .map((part) => `"${part.replaceAll('"', '""')}"*`)
    .join(" AND ");
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
