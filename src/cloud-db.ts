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
  /** Address for email notifications and digests; visible only to the user. */
  email?: string;
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

/** Document- and block-level search filters; every present filter must match. */
export interface CloudSearchFilters {
  labels?: string[];
  authorIds?: string[];
  siteIds?: string[];
  updatedAfter?: string;
  updatedBefore?: string;
  /** `page` collapses results to one per document; other values match a node type or directive name. */
  types?: string[];
  includeArchived?: boolean;
}

export interface CloudSearchRequest {
  words: string[];
  phrases: string[];
  siteId?: string;
  filters: CloudSearchFilters;
  limit: number;
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
  editedAt?: string;
  deletedAt?: string;
  deletedBy?: string;
  anchor?: CloudCommentAnchor;
}

/** Text-range anchor: `quote` inside block `blockId`, disambiguated by up to 64 chars of surrounding text. */
export interface CloudCommentAnchor {
  blockId: string;
  quote: string;
  prefix?: string;
  suffix?: string;
}

export interface CloudCommentReaction {
  emoji: string;
  userId: string;
  userName: string;
  createdAt: string;
}

export type CloudNotificationType = "mention" | "comment" | "approval_requested" | "approval_updated" | "page_updated" | "task_assigned";

export const cloudNotificationTypes: readonly CloudNotificationType[] = [
  "mention",
  "comment",
  "approval_requested",
  "approval_updated",
  "page_updated",
  "task_assigned",
];

export interface CloudNotification {
  id: string;
  userId: string;
  type: CloudNotificationType;
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
  /** Page tree: child document ID → parent document ID, both members of `documentIds`. */
  pageParents?: Record<string, string>;
  /** Unique uppercase space key (2–10 chars), e.g. `ENG`. */
  key?: string;
  description?: string;
  /** Emoji or short text shown beside the space title. */
  icon?: string;
  /** Page shown at the space root (`/s/<id>`); must be one of `documentIds`. */
  homeDocumentId?: string;
  /** Archived spaces are read-only and hidden from default lists. */
  archivedAt?: string;
  archivedBy?: string;
  createdAt: string;
  updatedAt: string;
  createdBy: string;
  updatedBy: string;
  permissions: Record<string, CloudPermission>;
  shareLinks: CloudShareLink[];
}

export interface CloudLabelCount {
  label: string;
  count: number;
}

export interface CloudLabeledDocument {
  documentId: string;
  siteId?: string;
  title: string;
  updatedAt: string;
  labels: string[];
  access: { role: CloudRole };
}

export interface CloudPageViewStats {
  documentId: string;
  since: string;
  totalViews: number;
  uniqueViewers: number;
  anonymousViews: number;
  viewsByDay: Array<{ date: string; views: number; uniqueViewers: number }>;
}

export interface CloudPageViewer {
  userId: string;
  name: string;
  views: number;
  lastViewedAt: string;
}

export interface CloudPopularPage {
  documentId: string;
  title: string;
  views: number;
  uniqueViewers: number;
  lastViewedAt: string;
}

export type CloudPageTaskStatus = "open" | "done";

/** An inline `- {#id} [ ] text @{user} due:YYYY-MM-DD` task indexed from page source. */
export interface CloudPageTask {
  documentId: string;
  taskId: string;
  text: string;
  status: CloudPageTaskStatus;
  assigneeId?: string;
  dueDate?: string;
  line: number;
  updatedAt: string;
  completedAt?: string;
  completedBy?: string;
}

export interface CloudPageTaskListItem extends CloudPageTask {
  documentTitle: string;
  siteId?: string;
  assigneeName?: string;
  access: { role: CloudRole };
}

export interface CloudPageTaskFilter {
  assigneeId?: string;
  status?: CloudPageTaskStatus;
  siteId?: string;
  documentId?: string;
  dueBefore?: string;
  limit: number;
}

export interface CloudPageTaskChanges {
  assigned: CloudPageTask[];
  completed: CloudPageTask[];
  reopened: CloudPageTask[];
}

export const cloudWebhookEvents = ["page.created", "page.updated", "page.deleted", "comment.created", "label.changed", "task.completed"] as const;
export type CloudWebhookEvent = (typeof cloudWebhookEvents)[number];
export type CloudWebhookFormat = "json" | "slack";
export type CloudWebhookDeliveryStatus = "pending" | "delivered" | "failed";

export interface CloudWebhook {
  id: string;
  siteId: string;
  url: string;
  events: CloudWebhookEvent[];
  format: CloudWebhookFormat;
  /** HMAC-SHA256 signing secret; never returned by the API after creation. */
  secret: string;
  createdBy: string;
  createdAt: string;
}

export interface CloudWebhookDelivery {
  id: string;
  webhookId: string;
  siteId: string;
  event: string;
  payload: Record<string, unknown>;
  status: CloudWebhookDeliveryStatus;
  attempts: number;
  nextAttemptAt: string;
  responseStatus?: number;
  lastError?: string;
  createdAt: string;
  deliveredAt?: string;
}

export type CloudNotificationChannel = "in_app" | "email" | "off";
export type CloudDigestFrequency = "off" | "daily" | "weekly";

export interface CloudNotificationPreferences {
  userId: string;
  channels: Record<CloudNotificationType, CloudNotificationChannel>;
  digest: CloudDigestFrequency;
  lastDigestAt?: string;
  updatedAt?: string;
}

export type CloudEmailKind = "notification" | "digest";
export type CloudEmailStatus = "pending" | "sent" | "failed";

export interface CloudEmail {
  id: string;
  userId: string;
  to: string;
  subject: string;
  text: string;
  kind: CloudEmailKind;
  status: CloudEmailStatus;
  attempts: number;
  nextAttemptAt: string;
  lastError?: string;
  createdAt: string;
  sentAt?: string;
}

export interface CloudWatch {
  userId: string;
  resourceType: CloudResourceType;
  resourceId: string;
  watchedAt: string;
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
  edited_at?: string | null;
  deleted_at?: string | null;
  deleted_by?: string | null;
  anchor_json?: string | null;
}

interface PageTaskRow {
  document_id: string;
  task_id: string;
  text: string;
  status: CloudPageTaskStatus;
  assignee_id: string | null;
  due_date: string | null;
  line: number;
  updated_at: string;
  completed_at: string | null;
  completed_by: string | null;
}

interface WebhookRow {
  id: string;
  site_id: string;
  url: string;
  events_json: string;
  format: CloudWebhookFormat;
  secret: string;
  created_by: string;
  created_at: string;
}

interface WebhookDeliveryRow {
  id: string;
  webhook_id: string;
  site_id: string;
  event: string;
  payload_json: string;
  status: CloudWebhookDeliveryStatus;
  attempts: number;
  next_attempt_at: string;
  response_status: number | null;
  last_error: string | null;
  created_at: string;
  delivered_at: string | null;
}

interface EmailRow {
  id: string;
  user_id: string;
  to_address: string;
  subject: string;
  body_text: string;
  kind: CloudEmailKind;
  status: CloudEmailStatus;
  attempts: number;
  next_attempt_at: string;
  last_error: string | null;
  created_at: string;
  sent_at: string | null;
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

const schemaVersion = "8";

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

  /** The earliest-inserted user; the bootstrap workspace admin when no admin allowlist is configured. */
  firstRegisteredUserId(): string | undefined {
    const row = this.db.prepare("SELECT id FROM users ORDER BY created_at, rowid LIMIT 1").get() as { id: string } | undefined;
    return row?.id;
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
      this.db.prepare("UPDATE sites SET space_key = ?, archived_at = ? WHERE id = ?").run(next.key ?? null, next.archivedAt ?? null, next.id);
      this.replacePermissions("site", next.id, next.permissions);
      this.replaceShares("site", next.id, next.shareLinks);
      this.replaceSiteDocuments(next);
    });
    write(record);
  }

  search(user: CloudUserRecord, q: string, siteId?: string, limit = 25): CloudSearchResult[] {
    return this.searchFiltered(user, { words: [q], phrases: [], ...(siteId ? { siteId } : {}), filters: {}, limit });
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

  /**
   * Permanently deletes a trashed document or site and every row that hangs off it.
   * Revisions, comments, approvals, and permissions for a purged document are gone;
   * callers must check legal holds before calling.
   */
  purgeResource(resourceType: CloudResourceType, resourceId: string): boolean {
    const purge = this.db.transaction((type: CloudResourceType, id: string): boolean => {
      if (!this.isTrashed(type, id)) return false;
      const table = type === "document" ? "documents" : "sites";
      const removed = this.db.prepare(`DELETE FROM ${table} WHERE id = ?`).run(id).changes > 0;
      for (const shared of ["permissions", "share_links", "group_permissions", "recent_items", "favorites", "watchers", "trashed_resources", "activity_events"]) {
        this.db.prepare(`DELETE FROM ${shared} WHERE resource_type = ? AND resource_id = ?`).run(type, id);
      }
      this.db.prepare("DELETE FROM notifications WHERE resource_type = ? AND resource_id = ?").run(type, id);
      if (type === "document") {
        this.db.prepare("DELETE FROM comment_reactions WHERE comment_id IN (SELECT id FROM comments WHERE document_id = ?)").run(id);
        for (const owned of ["document_revisions", "blocks", "comments", "approvals", "patch_proposals", "document_labels", "page_views", "page_tasks"]) {
          this.db.prepare(`DELETE FROM ${owned} WHERE document_id = ?`).run(id);
        }
        this.db.prepare("DELETE FROM search_index WHERE document_id = ?").run(id);
        this.db.prepare("DELETE FROM site_documents WHERE document_id = ?").run(id);
        for (const row of this.db.prepare("SELECT id FROM sites").all() as Array<{ id: string }>) {
          const site = this.readSite(row.id);
          if (!site?.documentIds.includes(id)) continue;
          this.writeSite(withoutSitePage(site, id));
        }
      } else {
        this.db.prepare("DELETE FROM site_documents WHERE site_id = ?").run(id);
        this.db.prepare("DELETE FROM webhook_deliveries WHERE site_id = ?").run(id);
        this.db.prepare("DELETE FROM space_webhooks WHERE site_id = ?").run(id);
      }
      return removed;
    });
    return purge(resourceType, resourceId);
  }

  listDocumentLabels(documentId: string): string[] {
    return (this.db.prepare("SELECT label FROM document_labels WHERE document_id = ? ORDER BY label").all(documentId) as Array<{ label: string }>).map(
      (row) => row.label,
    );
  }

  replaceDocumentLabels(documentId: string, labels: string[], addedBy: string, addedAt: string): string[] {
    const replace = this.db.transaction((id: string, next: string[]) => {
      this.db.prepare("DELETE FROM document_labels WHERE document_id = ?").run(id);
      const insert = this.db.prepare("INSERT INTO document_labels (document_id, label, added_by, added_at) VALUES (?, ?, ?, ?)");
      for (const label of next) insert.run(id, label, addedBy, addedAt);
    });
    replace(documentId, labels);
    return this.listDocumentLabels(documentId);
  }

  /** Labels on documents the user can see, with how many visible, non-trashed pages carry each. */
  listLabels(user: CloudUserRecord, siteId?: string): CloudLabelCount[] {
    const params: unknown[] = [user.id];
    const siteFilter = siteId ? "AND EXISTS (SELECT 1 FROM site_documents sd WHERE sd.site_id = ? AND sd.document_id = dl.document_id)" : "";
    if (siteId) params.push(siteId);
    return this.db
      .prepare(
        `WITH ${visibleResourcesCtes}
         SELECT dl.label, COUNT(*) AS count
         FROM document_labels dl
         JOIN visible_docs ON visible_docs.id = dl.document_id
         WHERE NOT EXISTS (SELECT 1 FROM trashed_resources t WHERE t.resource_type = 'document' AND t.resource_id = dl.document_id)
           ${siteFilter}
         GROUP BY dl.label
         ORDER BY count DESC, dl.label
         LIMIT 500`,
      )
      .all(...params) as CloudLabelCount[];
  }

  listDocumentsByLabel(user: CloudUserRecord, label: string, siteId?: string, limit = 200): CloudLabeledDocument[] {
    const params: unknown[] = [user.id, label];
    const siteFilter = siteId ? "AND EXISTS (SELECT 1 FROM site_documents sd WHERE sd.site_id = ? AND sd.document_id = d.id)" : "";
    if (siteId) params.push(siteId);
    params.push(limit);
    const rows = this.db
      .prepare(
        `WITH ${visibleResourcesCtes}
         SELECT d.id, d.title, d.updated_at, visible_docs.rank,
           (SELECT sd.site_id FROM site_documents sd WHERE sd.document_id = d.id ORDER BY sd.position LIMIT 1) AS site_id,
           (SELECT json_group_array(label) FROM (SELECT label FROM document_labels WHERE document_id = d.id ORDER BY label)) AS labels_json
         FROM document_labels dl
         JOIN documents d ON d.id = dl.document_id
         JOIN visible_docs ON visible_docs.id = d.id
         WHERE dl.label = ?
           AND NOT EXISTS (SELECT 1 FROM trashed_resources t WHERE t.resource_type = 'document' AND t.resource_id = d.id)
           ${siteFilter}
         ORDER BY d.updated_at DESC, d.id
         LIMIT ?`,
      )
      .all(...params) as Array<{ id: string; title: string; updated_at: string; rank: number; site_id: string | null; labels_json: string }>;
    return rows.map((row) => ({
      documentId: row.id,
      ...(row.site_id ? { siteId: row.site_id } : {}),
      title: row.title,
      updatedAt: row.updated_at,
      labels: JSON.parse(row.labels_json) as string[],
      access: { role: rankToRole(row.rank) },
    }));
  }

  setWatch(userId: string, resourceType: CloudResourceType, resourceId: string, watchedAt: string): void {
    this.db
      .prepare(
        `INSERT INTO watchers (user_id, resource_type, resource_id, watched_at)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(user_id, resource_type, resource_id) DO NOTHING`,
      )
      .run(userId, resourceType, resourceId, watchedAt);
  }

  removeWatch(userId: string, resourceType: CloudResourceType, resourceId: string): void {
    this.db.prepare("DELETE FROM watchers WHERE user_id = ? AND resource_type = ? AND resource_id = ?").run(userId, resourceType, resourceId);
  }

  isWatching(userId: string, resourceType: CloudResourceType, resourceId: string): boolean {
    return Boolean(
      this.db.prepare("SELECT 1 AS found FROM watchers WHERE user_id = ? AND resource_type = ? AND resource_id = ?").get(userId, resourceType, resourceId),
    );
  }

  /** Users watching the document directly or through any space that contains it. */
  documentWatchers(documentId: string): string[] {
    return (
      this.db
        .prepare(
          `SELECT DISTINCT user_id FROM (
             SELECT user_id FROM watchers WHERE resource_type = 'document' AND resource_id = ?
             UNION ALL
             SELECT w.user_id FROM watchers w
             JOIN site_documents sd ON sd.site_id = w.resource_id
             WHERE w.resource_type = 'site' AND sd.document_id = ?
           )
           ORDER BY user_id`,
        )
        .all(documentId, documentId) as Array<{ user_id: string }>
    ).map((row) => row.user_id);
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

  // --- wiki experience: search filters -------------------------------------------------

  /** Full-text block search narrowed by filters; a filter-only request lists matching pages. */
  searchFiltered(user: CloudUserRecord, request: CloudSearchRequest): CloudSearchResult[] {
    const match = fullTextMatch(request.words, request.phrases);
    const pageOnly = request.filters.types?.includes("page") ?? false;
    const blockTypes = (request.filters.types ?? []).filter((type) => type !== "page");
    const documentFilter = searchDocumentFilterSql(request.filters, "search_index.document_id");
    if (!match) {
      if (!hasSearchFilters(request.filters)) return [];
      return this.filteredPages(user, request);
    }
    const params: unknown[] = [user.id, match, ...documentFilter.params];
    const clauses = [...documentFilter.clauses];
    if (request.siteId) {
      clauses.push("EXISTS (SELECT 1 FROM site_documents filter_sd WHERE filter_sd.site_id = ? AND filter_sd.document_id = search_index.document_id)");
      params.push(request.siteId);
    }
    if (blockTypes.length) {
      const marks = blockTypes.map(() => "?").join(", ");
      clauses.push(`(b.directive_name IN (${marks}) OR b.node_type IN (${marks}))`);
      params.push(...blockTypes, ...blockTypes);
    }
    params.push(pageOnly ? Math.min(request.limit * 8, 800) : request.limit);
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
           ${clauses.map((clause) => `AND ${clause}`).join("\n           ")}
         ORDER BY rank, search_index.document_id, b.ordinal
         LIMIT ?`,
      )
      .all(...params) as SearchResultRow[];
    const results = rows.map(searchResult);
    if (!pageOnly) return results;
    const seen = new Set<string>();
    return results
      .filter((result) => (seen.has(result.documentId) ? false : (seen.add(result.documentId), true)))
      .map((result) => ({ ...result, nodeType: "page" }))
      .slice(0, request.limit);
  }

  /** Visible, non-trashed document IDs matching the document-level filters (labels, authors, spaces, dates). */
  filteredDocumentIds(user: CloudUserRecord, filters: CloudSearchFilters, limit = 10_000): Set<string> {
    const documentFilter = searchDocumentFilterSql(filters, "d.id");
    const rows = this.db
      .prepare(
        `WITH ${visibleResourcesCtes}
         SELECT d.id FROM documents d
         JOIN visible_docs ON visible_docs.id = d.id
         WHERE NOT EXISTS (SELECT 1 FROM trashed_resources t WHERE t.resource_type = 'document' AND t.resource_id = d.id)
           ${documentFilter.clauses.map((clause) => `AND ${clause}`).join(" ")}
         LIMIT ?`,
      )
      .all(user.id, ...documentFilter.params, limit) as Array<{ id: string }>;
    return new Set(rows.map((row) => row.id));
  }

  // --- wiki experience: comments --------------------------------------------------------

  setCommentAnchor(commentId: string, anchor: CloudCommentAnchor): void {
    this.db.prepare("UPDATE comments SET anchor_json = ? WHERE id = ?").run(JSON.stringify(anchor), commentId);
  }

  editComment(commentId: string, body: string, editedAt: string): void {
    this.db.prepare("UPDATE comments SET body = ?, edited_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL").run(body, editedAt, editedAt, commentId);
  }

  /** Soft delete: the row stays so replies keep their parent, but the body and reactions are dropped. */
  softDeleteComment(commentId: string, deletedBy: string, deletedAt: string): void {
    const remove = this.db.transaction(() => {
      this.db
        .prepare("UPDATE comments SET body = '', deleted_at = ?, deleted_by = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL")
        .run(deletedAt, deletedBy, deletedAt, commentId);
      this.db.prepare("DELETE FROM comment_reactions WHERE comment_id = ?").run(commentId);
    });
    remove();
  }

  addCommentReaction(commentId: string, userId: string, emoji: string, createdAt: string): void {
    this.db
      .prepare("INSERT INTO comment_reactions (comment_id, user_id, emoji, created_at) VALUES (?, ?, ?, ?) ON CONFLICT DO NOTHING")
      .run(commentId, userId, emoji, createdAt);
  }

  removeCommentReaction(commentId: string, userId: string, emoji: string): boolean {
    return this.db.prepare("DELETE FROM comment_reactions WHERE comment_id = ? AND user_id = ? AND emoji = ?").run(commentId, userId, emoji).changes > 0;
  }

  /** Reactions for every comment on a document, keyed by comment ID. */
  listCommentReactions(documentId: string): Map<string, CloudCommentReaction[]> {
    const rows = this.db
      .prepare(
        `SELECT r.comment_id, r.user_id, u.name AS user_name, r.emoji, r.created_at
         FROM comment_reactions r
         JOIN comments c ON c.id = r.comment_id
         JOIN users u ON u.id = r.user_id
         WHERE c.document_id = ?
         ORDER BY r.created_at, r.user_id`,
      )
      .all(documentId) as Array<{ comment_id: string; user_id: string; user_name: string; emoji: string; created_at: string }>;
    const byComment = new Map<string, CloudCommentReaction[]>();
    for (const row of rows) {
      const list = byComment.get(row.comment_id) ?? [];
      list.push({ emoji: row.emoji, userId: row.user_id, userName: row.user_name, createdAt: row.created_at });
      byComment.set(row.comment_id, list);
    }
    return byComment;
  }

  countCommentReactions(commentId: string): number {
    return (this.db.prepare("SELECT COUNT(*) AS count FROM comment_reactions WHERE comment_id = ?").get(commentId) as { count: number }).count;
  }

  // --- wiki experience: spaces ----------------------------------------------------------

  /** Site ID that owns `key` (case-insensitive), if any. */
  siteIdForKey(key: string): string | undefined {
    const row = this.db.prepare("SELECT id FROM sites WHERE space_key = ?").get(key.toUpperCase()) as { id: string } | undefined;
    return row?.id;
  }

  /** True when the page belongs to at least one space and every space it belongs to is archived. */
  isDocumentArchived(documentId: string): boolean {
    const row = this.db
      .prepare(
        `SELECT
           EXISTS (SELECT 1 FROM site_documents sd JOIN sites s ON s.id = sd.site_id WHERE sd.document_id = ? AND s.archived_at IS NOT NULL) AS archived,
           EXISTS (SELECT 1 FROM site_documents sd JOIN sites s ON s.id = sd.site_id WHERE sd.document_id = ? AND s.archived_at IS NULL) AS live`,
      )
      .get(documentId, documentId) as { archived: number; live: number };
    return row.archived === 1 && row.live === 0;
  }

  // --- wiki experience: page analytics --------------------------------------------------

  /**
   * Records a page view unless the same viewer already viewed the page within `dedupeMs`.
   * `viewerKey` is a user ID for signed-in viewers or an opaque hash for anonymous share-link views.
   * Views older than `retainDays` are pruned opportunistically.
   */
  recordPageView(view: { documentId: string; viewerKey: string; userId?: string; via: "user" | "share"; viewedAt: string }, dedupeMs: number, retainDays = 400): boolean {
    const record = this.db.transaction((): boolean => {
      const last = this.db
        .prepare("SELECT viewed_at FROM page_views WHERE document_id = ? AND viewer_key = ? ORDER BY viewed_at DESC LIMIT 1")
        .get(view.documentId, view.viewerKey) as { viewed_at: string } | undefined;
      const now = Date.parse(view.viewedAt);
      if (last && now - Date.parse(last.viewed_at) < dedupeMs) return false;
      this.db
        .prepare("INSERT INTO page_views (document_id, viewer_key, user_id, via, viewed_at) VALUES (?, ?, ?, ?, ?)")
        .run(view.documentId, view.viewerKey, view.userId ?? null, view.via, view.viewedAt);
      if (Math.random() < 0.01) {
        this.db.prepare("DELETE FROM page_views WHERE viewed_at < ?").run(new Date(now - retainDays * 86_400_000).toISOString());
      }
      return true;
    });
    return record();
  }

  pageViewStats(documentId: string, since: string): CloudPageViewStats {
    const totals = this.db
      .prepare(
        `SELECT COUNT(*) AS views,
           COUNT(DISTINCT CASE WHEN user_id IS NOT NULL THEN user_id END) AS unique_users,
           SUM(CASE WHEN user_id IS NULL THEN 1 ELSE 0 END) AS anonymous
         FROM page_views WHERE document_id = ? AND viewed_at >= ?`,
      )
      .get(documentId, since) as { views: number; unique_users: number; anonymous: number | null };
    const days = this.db
      .prepare(
        `SELECT substr(viewed_at, 1, 10) AS day, COUNT(*) AS views, COUNT(DISTINCT viewer_key) AS unique_viewers
         FROM page_views WHERE document_id = ? AND viewed_at >= ?
         GROUP BY day ORDER BY day`,
      )
      .all(documentId, since) as Array<{ day: string; views: number; unique_viewers: number }>;
    return {
      documentId,
      since,
      totalViews: totals.views,
      uniqueViewers: totals.unique_users,
      anonymousViews: totals.anonymous ?? 0,
      viewsByDay: days.map((row) => ({ date: row.day, views: row.views, uniqueViewers: row.unique_viewers })),
    };
  }

  pageViewers(documentId: string, since: string, limit = 100): CloudPageViewer[] {
    const rows = this.db
      .prepare(
        `SELECT v.user_id, u.name, COUNT(*) AS views, MAX(v.viewed_at) AS last_viewed_at
         FROM page_views v JOIN users u ON u.id = v.user_id
         WHERE v.document_id = ? AND v.viewed_at >= ? AND v.user_id IS NOT NULL
         GROUP BY v.user_id
         ORDER BY last_viewed_at DESC, v.user_id
         LIMIT ?`,
      )
      .all(documentId, since, limit) as Array<{ user_id: string; name: string; views: number; last_viewed_at: string }>;
    return rows.map((row) => ({ userId: row.user_id, name: row.name, views: row.views, lastViewedAt: row.last_viewed_at }));
  }

  /** Most viewed, non-trashed pages of a space since `since`. */
  popularPages(siteId: string, since: string, limit: number): CloudPopularPage[] {
    const rows = this.db
      .prepare(
        `SELECT v.document_id, d.title, COUNT(*) AS views, COUNT(DISTINCT v.viewer_key) AS unique_viewers, MAX(v.viewed_at) AS last_viewed_at
         FROM page_views v
         JOIN site_documents sd ON sd.document_id = v.document_id AND sd.site_id = ?
         JOIN documents d ON d.id = v.document_id
         WHERE v.viewed_at >= ?
           AND NOT EXISTS (SELECT 1 FROM trashed_resources t WHERE t.resource_type = 'document' AND t.resource_id = v.document_id)
         GROUP BY v.document_id
         ORDER BY views DESC, unique_viewers DESC, last_viewed_at DESC, v.document_id
         LIMIT ?`,
      )
      .all(siteId, since, limit) as Array<{ document_id: string; title: string; views: number; unique_viewers: number; last_viewed_at: string }>;
    return rows.map((row) => ({ documentId: row.document_id, title: row.title, views: row.views, uniqueViewers: row.unique_viewers, lastViewedAt: row.last_viewed_at }));
  }

  // --- wiki experience: inline tasks ----------------------------------------------------

  /**
   * Replaces a page's task index with `tasks` and reports what changed: tasks whose assignee is
   * new, and tasks that moved between open and done. `actorId` is stamped on completions.
   */
  replacePageTasks(documentId: string, tasks: Array<Omit<CloudPageTask, "updatedAt" | "completedAt" | "completedBy">>, actorId: string | undefined, at: string): CloudPageTaskChanges {
    const replace = this.db.transaction((): CloudPageTaskChanges => {
      const previous = new Map(this.listPageTasks(documentId).map((task) => [task.taskId, task]));
      const changes: CloudPageTaskChanges = { assigned: [], completed: [], reopened: [] };
      this.db.prepare("DELETE FROM page_tasks WHERE document_id = ?").run(documentId);
      const insert = this.db.prepare(
        `INSERT INTO page_tasks (document_id, task_id, text, status, assignee_id, due_date, line, updated_at, completed_at, completed_by)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      );
      for (const task of tasks) {
        const before = previous.get(task.taskId);
        const unchanged = before && before.text === task.text && before.status === task.status && before.assigneeId === task.assigneeId && before.dueDate === task.dueDate;
        const completedAt = task.status === "done" ? (before?.status === "done" ? before.completedAt : at) : undefined;
        const completedBy = task.status === "done" ? (before?.status === "done" ? before.completedBy : actorId) : undefined;
        const row: CloudPageTask = {
          ...task,
          updatedAt: unchanged ? before.updatedAt : at,
          ...(completedAt ? { completedAt } : {}),
          ...(completedBy ? { completedBy } : {}),
        };
        insert.run(documentId, row.taskId, row.text, row.status, row.assigneeId ?? null, row.dueDate ?? null, row.line, row.updatedAt, row.completedAt ?? null, row.completedBy ?? null);
        if (row.assigneeId && row.assigneeId !== before?.assigneeId) changes.assigned.push(row);
        if (before && before.status !== row.status) (row.status === "done" ? changes.completed : changes.reopened).push(row);
      }
      return changes;
    });
    return replace();
  }

  listPageTasks(documentId: string): CloudPageTask[] {
    const rows = this.db.prepare("SELECT * FROM page_tasks WHERE document_id = ? ORDER BY line, task_id").all(documentId) as PageTaskRow[];
    return rows.map(pageTask);
  }

  readPageTask(documentId: string, taskId: string): CloudPageTask | undefined {
    const row = this.db.prepare("SELECT * FROM page_tasks WHERE document_id = ? AND task_id = ?").get(documentId, taskId) as PageTaskRow | undefined;
    return row ? pageTask(row) : undefined;
  }

  /** Tasks on pages the user can see, excluding trashed pages and pages only in archived spaces. */
  listVisibleTasks(user: CloudUserRecord, filter: CloudPageTaskFilter): CloudPageTaskListItem[] {
    const params: unknown[] = [user.id];
    const clauses = ["NOT EXISTS (SELECT 1 FROM trashed_resources t WHERE t.resource_type = 'document' AND t.resource_id = pt.document_id)", archivedDocumentSql("pt.document_id")];
    if (filter.assigneeId) {
      clauses.push("pt.assignee_id = ?");
      params.push(filter.assigneeId);
    }
    if (filter.status) {
      clauses.push("pt.status = ?");
      params.push(filter.status);
    }
    if (filter.siteId) {
      clauses.push("EXISTS (SELECT 1 FROM site_documents fs WHERE fs.site_id = ? AND fs.document_id = pt.document_id)");
      params.push(filter.siteId);
    }
    if (filter.documentId) {
      clauses.push("pt.document_id = ?");
      params.push(filter.documentId);
    }
    if (filter.dueBefore) {
      clauses.push("pt.due_date IS NOT NULL AND pt.due_date < ?");
      params.push(filter.dueBefore);
    }
    params.push(filter.limit);
    const rows = this.db
      .prepare(
        `WITH ${visibleResourcesCtes}
         SELECT pt.*, d.title AS document_title, u.name AS assignee_name, visible_docs.rank AS access_rank,
           (SELECT sd.site_id FROM site_documents sd WHERE sd.document_id = pt.document_id ORDER BY sd.position LIMIT 1) AS site_id
         FROM page_tasks pt
         JOIN documents d ON d.id = pt.document_id
         JOIN visible_docs ON visible_docs.id = pt.document_id
         LEFT JOIN users u ON u.id = pt.assignee_id
         WHERE ${clauses.join(" AND ")}
         ORDER BY CASE pt.status WHEN 'open' THEN 0 ELSE 1 END, pt.due_date IS NULL, pt.due_date, d.title, pt.line
         LIMIT ?`,
      )
      .all(...params) as Array<PageTaskRow & { document_title: string; assignee_name: string | null; access_rank: number; site_id: string | null }>;
    return rows.map((row) => ({
      ...pageTask(row),
      documentTitle: row.document_title,
      ...(row.site_id ? { siteId: row.site_id } : {}),
      ...(row.assignee_name ? { assigneeName: row.assignee_name } : {}),
      access: { role: rankToRole(row.access_rank) },
    }));
  }

  // --- wiki experience: outbound webhooks -----------------------------------------------

  insertWebhook(webhook: CloudWebhook): void {
    this.db
      .prepare("INSERT INTO space_webhooks (id, site_id, url, events_json, format, secret, created_by, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)")
      .run(webhook.id, webhook.siteId, webhook.url, JSON.stringify(webhook.events), webhook.format, webhook.secret, webhook.createdBy, webhook.createdAt);
  }

  listWebhooks(siteId: string): CloudWebhook[] {
    return (this.db.prepare("SELECT * FROM space_webhooks WHERE site_id = ? ORDER BY created_at, id").all(siteId) as WebhookRow[]).map(cloudWebhook);
  }

  readWebhook(id: string): CloudWebhook | undefined {
    const row = this.db.prepare("SELECT * FROM space_webhooks WHERE id = ?").get(id) as WebhookRow | undefined;
    return row ? cloudWebhook(row) : undefined;
  }

  deleteWebhook(id: string): boolean {
    const remove = this.db.transaction((): boolean => {
      this.db.prepare("DELETE FROM webhook_deliveries WHERE webhook_id = ?").run(id);
      return this.db.prepare("DELETE FROM space_webhooks WHERE id = ?").run(id).changes > 0;
    });
    return remove();
  }

  /** Space IDs that contain the page (a page can live in several spaces). */
  siteIdsForDocument(documentId: string): string[] {
    return (this.db.prepare("SELECT site_id FROM site_documents WHERE document_id = ? ORDER BY position").all(documentId) as Array<{ site_id: string }>).map((row) => row.site_id);
  }

  enqueueWebhookDelivery(delivery: Omit<CloudWebhookDelivery, "status" | "attempts" | "responseStatus" | "lastError" | "deliveredAt">): void {
    this.db
      .prepare(
        `INSERT INTO webhook_deliveries (id, webhook_id, site_id, event, payload_json, status, attempts, next_attempt_at, created_at)
         VALUES (?, ?, ?, ?, ?, 'pending', 0, ?, ?)`,
      )
      .run(delivery.id, delivery.webhookId, delivery.siteId, delivery.event, JSON.stringify(delivery.payload), delivery.nextAttemptAt, delivery.createdAt);
  }

  /**
   * Claims up to `limit` due deliveries with a lease so concurrent drainers (the in-process timer
   * and an external worker) never send the same delivery twice at once.
   */
  claimDueWebhookDeliveries(now: string, leaseUntil: string, limit: number): CloudWebhookDelivery[] {
    const claim = this.db.transaction((): CloudWebhookDelivery[] => {
      const rows = this.db
        .prepare(
          `SELECT * FROM webhook_deliveries
           WHERE status = 'pending' AND next_attempt_at <= ? AND (lease_until IS NULL OR lease_until <= ?)
           ORDER BY next_attempt_at, created_at LIMIT ?`,
        )
        .all(now, now, limit) as WebhookDeliveryRow[];
      const lease = this.db.prepare("UPDATE webhook_deliveries SET lease_until = ? WHERE id = ?");
      for (const row of rows) lease.run(leaseUntil, row.id);
      return rows.map(cloudWebhookDelivery);
    });
    return claim();
  }

  completeWebhookDelivery(id: string, result: { status: CloudWebhookDeliveryStatus; attempts: number; nextAttemptAt: string; responseStatus?: number; lastError?: string; deliveredAt?: string }): void {
    this.db
      .prepare(
        `UPDATE webhook_deliveries
         SET status = ?, attempts = ?, next_attempt_at = ?, lease_until = NULL, response_status = ?, last_error = ?, delivered_at = ?
         WHERE id = ?`,
      )
      .run(result.status, result.attempts, result.nextAttemptAt, result.responseStatus ?? null, result.lastError ?? null, result.deliveredAt ?? null, id);
  }

  listWebhookDeliveries(webhookId: string, limit: number): CloudWebhookDelivery[] {
    return (this.db.prepare("SELECT * FROM webhook_deliveries WHERE webhook_id = ? ORDER BY created_at DESC, id DESC LIMIT ?").all(webhookId, limit) as WebhookDeliveryRow[]).map(cloudWebhookDelivery);
  }

  /** Drops finished deliveries older than `before`, keeping the log bounded. */
  pruneWebhookDeliveries(before: string): number {
    return this.db.prepare("DELETE FROM webhook_deliveries WHERE status <> 'pending' AND created_at < ?").run(before).changes;
  }

  // --- wiki experience: notification preferences, email outbox, digests ------------------

  notificationPreferences(userId: string): CloudNotificationPreferences {
    const row = this.db.prepare("SELECT * FROM notification_preferences WHERE user_id = ?").get(userId) as
      | { channels_json: string; digest: CloudDigestFrequency; last_digest_at: string | null; updated_at: string }
      | undefined;
    const stored = row ? parseRecord<Partial<Record<CloudNotificationType, CloudNotificationChannel>>>(row.channels_json) : {};
    const channels = Object.fromEntries(cloudNotificationTypes.map((type) => [type, stored[type] ?? "in_app"])) as Record<CloudNotificationType, CloudNotificationChannel>;
    return {
      userId,
      channels,
      digest: row?.digest ?? "off",
      ...(row?.last_digest_at ? { lastDigestAt: row.last_digest_at } : {}),
      ...(row?.updated_at ? { updatedAt: row.updated_at } : {}),
    };
  }

  writeNotificationPreferences(preferences: CloudNotificationPreferences, updatedAt: string): void {
    this.db
      .prepare(
        `INSERT INTO notification_preferences (user_id, channels_json, digest, last_digest_at, updated_at)
         VALUES (?, ?, ?, ?, ?)
         ON CONFLICT(user_id) DO UPDATE SET channels_json = excluded.channels_json, digest = excluded.digest, last_digest_at = excluded.last_digest_at, updated_at = excluded.updated_at`,
      )
      .run(preferences.userId, JSON.stringify(preferences.channels), preferences.digest, preferences.lastDigestAt ?? null, updatedAt);
  }

  /** Users with a digest schedule whose previous digest is older than their period (or who never had one). */
  dueDigestUsers(now: string, limit: number): Array<{ userId: string; digest: Exclude<CloudDigestFrequency, "off">; lastDigestAt?: string }> {
    const nowMs = Date.parse(now);
    const dailyCutoff = new Date(nowMs - 86_400_000).toISOString();
    const weeklyCutoff = new Date(nowMs - 7 * 86_400_000).toISOString();
    const rows = this.db
      .prepare(
        `SELECT user_id, digest, last_digest_at FROM notification_preferences
         WHERE (digest = 'daily' AND (last_digest_at IS NULL OR last_digest_at <= ?))
            OR (digest = 'weekly' AND (last_digest_at IS NULL OR last_digest_at <= ?))
         ORDER BY COALESCE(last_digest_at, ''), user_id
         LIMIT ?`,
      )
      .all(dailyCutoff, weeklyCutoff, limit) as Array<{ user_id: string; digest: "daily" | "weekly"; last_digest_at: string | null }>;
    return rows.map((row) => ({ userId: row.user_id, digest: row.digest, ...(row.last_digest_at ? { lastDigestAt: row.last_digest_at } : {}) }));
  }

  markDigestSent(userId: string, at: string): void {
    this.db.prepare("UPDATE notification_preferences SET last_digest_at = ? WHERE user_id = ?").run(at, userId);
  }

  /** Unread notifications for the user created at or after `since`, newest first. */
  unreadNotificationsSince(userId: string, since: string, limit: number): CloudNotification[] {
    const rows = this.db
      .prepare("SELECT * FROM notifications WHERE user_id = ? AND read_at IS NULL AND created_at >= ? ORDER BY created_at DESC, id DESC LIMIT ?")
      .all(userId, since, limit) as NotificationRow[];
    return rows.map(cloudNotification);
  }

  enqueueEmail(email: Omit<CloudEmail, "status" | "attempts" | "lastError" | "sentAt">): void {
    this.db
      .prepare(
        `INSERT INTO email_outbox (id, user_id, to_address, subject, body_text, kind, status, attempts, next_attempt_at, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 'pending', 0, ?, ?)`,
      )
      .run(email.id, email.userId, email.to, email.subject, email.text, email.kind, email.nextAttemptAt, email.createdAt);
  }

  claimDueEmails(now: string, leaseUntil: string, limit: number): CloudEmail[] {
    const claim = this.db.transaction((): CloudEmail[] => {
      const rows = this.db
        .prepare(
          `SELECT * FROM email_outbox
           WHERE status = 'pending' AND next_attempt_at <= ? AND (lease_until IS NULL OR lease_until <= ?)
           ORDER BY next_attempt_at, created_at LIMIT ?`,
        )
        .all(now, now, limit) as EmailRow[];
      const lease = this.db.prepare("UPDATE email_outbox SET lease_until = ? WHERE id = ?");
      for (const row of rows) lease.run(leaseUntil, row.id);
      return rows.map(cloudEmail);
    });
    return claim();
  }

  completeEmail(id: string, result: { status: CloudEmailStatus; attempts: number; nextAttemptAt: string; lastError?: string; sentAt?: string }): void {
    this.db
      .prepare("UPDATE email_outbox SET status = ?, attempts = ?, next_attempt_at = ?, lease_until = NULL, last_error = ?, sent_at = ? WHERE id = ?")
      .run(result.status, result.attempts, result.nextAttemptAt, result.lastError ?? null, result.sentAt ?? null, id);
  }

  listEmails(userId: string, limit: number): CloudEmail[] {
    return (this.db.prepare("SELECT * FROM email_outbox WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT ?").all(userId, limit) as EmailRow[]).map(cloudEmail);
  }

  pruneEmails(before: string): number {
    return this.db.prepare("DELETE FROM email_outbox WHERE status <> 'pending' AND created_at < ?").run(before).changes;
  }

  // --- wiki experience: people directory ----------------------------------------------

  /**
   * Users who share at least one non-trashed space with `userId` (directly or through a group),
   * plus the caller. Matches `q` against name prefix/substring or exact ID. This is the mention
   * picker's directory, so it never lists the whole workspace.
   */
  coMemberUsers(userId: string, q: string, limit: number, documentId?: string): Array<{ id: string; name: string }> {
    const pattern = likePattern(q.toLowerCase());
    const rows = this.db
      .prepare(
        `WITH ${visibleResourcesCtes},
         members AS (
           SELECT ? AS user_id
           UNION
           SELECT p.user_id FROM permissions p
           JOIN visible_sites vs ON p.resource_type = 'site' AND p.resource_id = vs.id
           WHERE NOT EXISTS (SELECT 1 FROM trashed_resources t WHERE t.resource_type = 'site' AND t.resource_id = vs.id)
           UNION
           SELECT gm.user_id FROM group_permissions gp
           JOIN visible_sites vs ON gp.resource_type = 'site' AND gp.resource_id = vs.id
           JOIN group_members gm ON gm.group_id = gp.group_id
           WHERE NOT EXISTS (SELECT 1 FROM trashed_resources t WHERE t.resource_type = 'site' AND t.resource_id = vs.id)
         )
         SELECT u.id, u.name FROM users u
         JOIN members m ON m.user_id = u.id
         WHERE (lower(u.name) LIKE ? ESCAPE '\\' OR u.id = ?)
         ORDER BY CASE WHEN lower(u.name) LIKE ? ESCAPE '\\' THEN 0 ELSE 1 END, lower(u.name), u.id
         LIMIT ?`,
      )
      .all(userId, userId, pattern, q, `${likePattern(q.toLowerCase()).slice(1)}`, documentId ? 200 : limit) as Array<{ id: string; name: string }>;
    const filtered = documentId ? rows.filter((row) => this.documentAccessRole(row.id, documentId)) : rows;
    return filtered.slice(0, limit);
  }

  /** Display names for `ids` restricted to the caller's co-members (and, with `documentId`, anyone who can see that page). */
  userNames(callerId: string, ids: string[], documentId?: string): Array<{ id: string; name: string }> {
    if (ids.length === 0) return [];
    const coMembers = new Set(this.coMemberUsers(callerId, "", 10_000).map((row) => row.id));
    const marks = ids.map(() => "?").join(", ");
    const rows = this.db.prepare(`SELECT id, name FROM users WHERE id IN (${marks}) ORDER BY lower(name), id`).all(...ids) as Array<{ id: string; name: string }>;
    return rows.filter((row) => coMembers.has(row.id) || (documentId !== undefined && this.documentAccessRole(row.id, documentId) !== undefined));
  }

  private filteredPages(user: CloudUserRecord, request: CloudSearchRequest): CloudSearchResult[] {
    const documentFilter = searchDocumentFilterSql(request.filters, "d.id");
    const blockTypes = (request.filters.types ?? []).filter((type) => type !== "page");
    const typeMarks = blockTypes.map(() => "?").join(", ");
    const blockSelect = blockTypes.length
      ? `(SELECT row_key FROM blocks fb WHERE fb.document_id = d.id AND (fb.directive_name IN (${typeMarks}) OR fb.node_type IN (${typeMarks})) ORDER BY fb.ordinal LIMIT 1)`
      : "(SELECT row_key FROM blocks fb WHERE fb.document_id = d.id AND fb.node_type = 'paragraph' ORDER BY fb.ordinal LIMIT 1)";
    const blockParams = blockTypes.length ? [...blockTypes, ...blockTypes] : [];
    const clauses = [...documentFilter.clauses];
    const params: unknown[] = [user.id, ...blockParams, ...documentFilter.params];
    if (request.siteId) {
      clauses.push("EXISTS (SELECT 1 FROM site_documents filter_sd WHERE filter_sd.site_id = ? AND filter_sd.document_id = d.id)");
      params.push(request.siteId);
    }
    if (blockTypes.length) {
      clauses.push(`${blockSelect} IS NOT NULL`);
      params.push(...blockParams);
    }
    params.push(request.limit);
    const rows = this.db
      .prepare(
        `WITH ${visibleResourcesCtes},
         matches AS (
           SELECT d.id, d.title, d.updated_at, visible_docs.rank AS access_rank, ${blockSelect} AS row_key
           FROM documents d
           JOIN visible_docs ON visible_docs.id = d.id
           WHERE NOT EXISTS (SELECT 1 FROM trashed_resources t WHERE t.resource_type = 'document' AND t.resource_id = d.id)
             ${clauses.map((clause) => `AND ${clause}`).join(" ")}
           ORDER BY d.updated_at DESC, d.id
           LIMIT ?
         )
         SELECT
           m.id AS document_id,
           (SELECT sd.site_id FROM site_documents sd WHERE sd.document_id = m.id ORDER BY sd.position LIMIT 1) AS site_id,
           m.title AS document_title,
           b.block_id,
           COALESCE(b.node_type, 'page') AS node_type,
           b.directive_name,
           b.title,
           substr(COALESCE(b.text, ''), 1, 200) AS excerpt,
           b.line,
           0 AS rank,
           m.access_rank
         FROM matches m
         LEFT JOIN blocks b ON b.row_key = m.row_key
         ORDER BY m.updated_at DESC, m.id`,
      )
      .all(...params) as SearchResultRow[];
    return rows.map((row) => (blockTypes.length ? searchResult(row) : { ...searchResult(row), nodeType: "page" }));
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
        type TEXT NOT NULL CHECK (type IN ('mention', 'comment', 'approval_requested', 'approval_updated', 'page_updated', 'task_assigned')),
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

      CREATE TABLE IF NOT EXISTS document_labels (
        document_id TEXT NOT NULL,
        label TEXT NOT NULL,
        added_by TEXT NOT NULL,
        added_at TEXT NOT NULL,
        PRIMARY KEY (document_id, label)
      );

      CREATE TABLE IF NOT EXISTS watchers (
        user_id TEXT NOT NULL,
        resource_type TEXT NOT NULL CHECK (resource_type IN ('document', 'site')),
        resource_id TEXT NOT NULL,
        watched_at TEXT NOT NULL,
        PRIMARY KEY (user_id, resource_type, resource_id)
      );

      -- comments: reactions (edit/delete/anchor columns are added by migrateCommentColumns)
      CREATE TABLE IF NOT EXISTS comment_reactions (
        comment_id TEXT NOT NULL,
        user_id TEXT NOT NULL,
        emoji TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (comment_id, user_id, emoji)
      );

      -- inline tasks
      CREATE TABLE IF NOT EXISTS page_tasks (
        document_id TEXT NOT NULL,
        task_id TEXT NOT NULL,
        text TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('open', 'done')),
        assignee_id TEXT,
        due_date TEXT,
        line INTEGER NOT NULL,
        updated_at TEXT NOT NULL,
        completed_at TEXT,
        completed_by TEXT,
        PRIMARY KEY (document_id, task_id)
      );
      CREATE INDEX IF NOT EXISTS idx_page_tasks_assignee ON page_tasks(assignee_id, status, due_date);

      -- outbound webhooks
      CREATE TABLE IF NOT EXISTS space_webhooks (
        id TEXT PRIMARY KEY,
        site_id TEXT NOT NULL,
        url TEXT NOT NULL,
        events_json TEXT NOT NULL,
        format TEXT NOT NULL CHECK (format IN ('json', 'slack')),
        secret TEXT NOT NULL,
        created_by TEXT NOT NULL,
        created_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_space_webhooks_site ON space_webhooks(site_id);
      CREATE TABLE IF NOT EXISTS webhook_deliveries (
        id TEXT PRIMARY KEY,
        webhook_id TEXT NOT NULL,
        site_id TEXT NOT NULL,
        event TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending', 'delivered', 'failed')),
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at TEXT NOT NULL,
        lease_until TEXT,
        response_status INTEGER,
        last_error TEXT,
        created_at TEXT NOT NULL,
        delivered_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_due ON webhook_deliveries(status, next_attempt_at);
      CREATE INDEX IF NOT EXISTS idx_webhook_deliveries_hook ON webhook_deliveries(webhook_id, created_at DESC);

      -- notification preferences and email
      CREATE TABLE IF NOT EXISTS notification_preferences (
        user_id TEXT PRIMARY KEY,
        channels_json TEXT NOT NULL,
        digest TEXT NOT NULL CHECK (digest IN ('off', 'daily', 'weekly')),
        last_digest_at TEXT,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_notification_preferences_digest ON notification_preferences(digest, last_digest_at);
      CREATE TABLE IF NOT EXISTS email_outbox (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        to_address TEXT NOT NULL,
        subject TEXT NOT NULL,
        body_text TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('notification', 'digest')),
        status TEXT NOT NULL CHECK (status IN ('pending', 'sent', 'failed')),
        attempts INTEGER NOT NULL DEFAULT 0,
        next_attempt_at TEXT NOT NULL,
        lease_until TEXT,
        last_error TEXT,
        created_at TEXT NOT NULL,
        sent_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_email_outbox_due ON email_outbox(status, next_attempt_at);
      CREATE INDEX IF NOT EXISTS idx_email_outbox_user ON email_outbox(user_id, created_at DESC);

      -- page analytics
      CREATE TABLE IF NOT EXISTS page_views (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        document_id TEXT NOT NULL,
        viewer_key TEXT NOT NULL,
        user_id TEXT,
        via TEXT NOT NULL CHECK (via IN ('user', 'share')),
        viewed_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_page_views_document ON page_views(document_id, viewed_at);
      CREATE INDEX IF NOT EXISTS idx_page_views_viewer ON page_views(document_id, viewer_key, viewed_at DESC);

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
      CREATE INDEX IF NOT EXISTS idx_document_labels_label ON document_labels(label, document_id);
      CREATE INDEX IF NOT EXISTS idx_watchers_resource ON watchers(resource_type, resource_id, user_id);
    `);
    this.migrateNotificationTypes();
    this.migrateCommentColumns();
    this.migrateSpaceColumns();
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

  /** SQLite cannot alter a CHECK constraint, so older databases rebuild the notifications table once. */
  private migrateNotificationTypes(): void {
    const row = this.db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'notifications'").get() as { sql: string } | undefined;
    if (!row || cloudNotificationTypes.every((type) => row.sql.includes(`'${type}'`))) return;
    const allowed = cloudNotificationTypes.map((type) => `'${type}'`).join(", ");
    this.db.transaction(() => {
      this.db.exec(`
        ALTER TABLE notifications RENAME TO notifications_v7;
        CREATE TABLE notifications (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL,
          type TEXT NOT NULL CHECK (type IN (${allowed})),
          title TEXT NOT NULL,
          body TEXT NOT NULL,
          resource_type TEXT CHECK (resource_type IN ('document', 'site')),
          resource_id TEXT,
          created_at TEXT NOT NULL,
          read_at TEXT
        );
        INSERT INTO notifications SELECT id, user_id, type, title, body, resource_type, resource_id, created_at, read_at FROM notifications_v7;
        DROP TABLE notifications_v7;
        CREATE INDEX IF NOT EXISTS idx_notifications_user ON notifications(user_id, read_at, created_at DESC);
      `);
    })();
  }

  /** Adds the comment edit/soft-delete/anchor columns to databases created before they existed. */
  private migrateCommentColumns(): void {
    const columns = new Set((this.db.prepare("PRAGMA table_info(comments)").all() as Array<{ name: string }>).map((column) => column.name));
    for (const [name, type] of [["edited_at", "TEXT"], ["deleted_at", "TEXT"], ["deleted_by", "TEXT"], ["anchor_json", "TEXT"]] as const) {
      if (!columns.has(name)) this.db.exec(`ALTER TABLE comments ADD COLUMN ${name} ${type}`);
    }
  }

  /** Adds indexed space key / archive columns (mirrors of the site record) to older databases. */
  private migrateSpaceColumns(): void {
    const columns = new Set((this.db.prepare("PRAGMA table_info(sites)").all() as Array<{ name: string }>).map((column) => column.name));
    if (!columns.has("space_key")) this.db.exec("ALTER TABLE sites ADD COLUMN space_key TEXT");
    if (!columns.has("archived_at")) this.db.exec("ALTER TABLE sites ADD COLUMN archived_at TEXT");
    this.db.exec(`
      CREATE UNIQUE INDEX IF NOT EXISTS idx_sites_space_key ON sites(space_key) WHERE space_key IS NOT NULL;
      CREATE INDEX IF NOT EXISTS idx_sites_archived ON sites(archived_at);
    `);
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
    ...(row.edited_at ? { editedAt: row.edited_at } : {}),
    ...(row.deleted_at ? { deletedAt: row.deleted_at } : {}),
    ...(row.deleted_by ? { deletedBy: row.deleted_by } : {}),
    ...(row.anchor_json ? { anchor: parseRecord<CloudCommentAnchor>(row.anchor_json) } : {}),
  };
}

function withoutSitePage(site: CloudSiteRecord, documentId: string): CloudSiteRecord {
  const documentIds = site.documentIds.filter((id) => id !== documentId);
  const pageFolders = Object.fromEntries(Object.entries(site.pageFolders ?? {}).filter(([id]) => id !== documentId));
  const removedParent = site.pageParents?.[documentId];
  const pageParents: Record<string, string> = {};
  for (const [child, parent] of Object.entries(site.pageParents ?? {})) {
    if (child === documentId) continue;
    if (parent !== documentId) pageParents[child] = parent;
    else if (removedParent) pageParents[child] = removedParent;
  }
  return { ...site, documentIds, pageFolders, pageParents };
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

function searchResult(row: SearchResultRow): CloudSearchResult {
  return {
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
  };
}

/** FTS5 MATCH expression: prefix-matched words AND exact phrases; empty when nothing searchable remains. */
function fullTextMatch(words: string[], phrases: string[]): string {
  const terms = [fullTextQuery(words.join(" "))];
  for (const phrase of phrases) {
    const parts = phrase
      .normalize("NFKC")
      .split(/[^\p{L}\p{N}_]+/u)
      .filter(Boolean)
      .slice(0, 16);
    if (parts.length) terms.push(`"${parts.join(" ").replaceAll('"', '""')}"`);
  }
  return terms.filter(Boolean).join(" AND ");
}

function archivedDocumentSql(documentColumn: string): string {
  return `NOT (EXISTS (SELECT 1 FROM site_documents fad JOIN sites fas ON fas.id = fad.site_id WHERE fad.document_id = ${documentColumn} AND fas.archived_at IS NOT NULL)
    AND NOT EXISTS (SELECT 1 FROM site_documents fld JOIN sites fls ON fls.id = fld.site_id WHERE fld.document_id = ${documentColumn} AND fls.archived_at IS NULL))`;
}

function hasSearchFilters(filters: CloudSearchFilters): boolean {
  return Boolean(
    filters.labels?.length || filters.authorIds?.length || filters.siteIds?.length || filters.updatedAfter || filters.updatedBefore || filters.types?.length,
  );
}

/** SQL clauses (joined with AND by the caller) restricting `documentColumn` to documents matching the filters. */
function searchDocumentFilterSql(filters: CloudSearchFilters, documentColumn: string): { clauses: string[]; params: unknown[] } {
  const clauses: string[] = filters.includeArchived ? [] : [archivedDocumentSql(documentColumn)];
  const params: unknown[] = [];
  for (const label of filters.labels ?? []) {
    clauses.push(`EXISTS (SELECT 1 FROM document_labels fl WHERE fl.document_id = ${documentColumn} AND fl.label = ?)`);
    params.push(label);
  }
  if (filters.authorIds?.length) {
    const marks = filters.authorIds.map(() => "?").join(", ");
    clauses.push(
      `EXISTS (SELECT 1 FROM documents fa WHERE fa.id = ${documentColumn} AND (fa.created_by IN (${marks}) OR fa.updated_by IN (${marks})
        OR EXISTS (SELECT 1 FROM document_revisions fr WHERE fr.document_id = fa.id AND fr.created_by IN (${marks}))))`,
    );
    params.push(...filters.authorIds, ...filters.authorIds, ...filters.authorIds);
  }
  if (filters.siteIds?.length) {
    clauses.push(`EXISTS (SELECT 1 FROM site_documents fs WHERE fs.document_id = ${documentColumn} AND fs.site_id IN (${filters.siteIds.map(() => "?").join(", ")}))`);
    params.push(...filters.siteIds);
  }
  if (filters.updatedAfter) {
    clauses.push(`EXISTS (SELECT 1 FROM documents fu WHERE fu.id = ${documentColumn} AND fu.updated_at >= ?)`);
    params.push(filters.updatedAfter);
  }
  if (filters.updatedBefore) {
    clauses.push(`EXISTS (SELECT 1 FROM documents fu WHERE fu.id = ${documentColumn} AND fu.updated_at < ?)`);
    params.push(filters.updatedBefore);
  }
  return { clauses, params };
}

function pageTask(row: PageTaskRow): CloudPageTask {
  return {
    documentId: row.document_id,
    taskId: row.task_id,
    text: row.text,
    status: row.status,
    ...(row.assignee_id ? { assigneeId: row.assignee_id } : {}),
    ...(row.due_date ? { dueDate: row.due_date } : {}),
    line: row.line,
    updatedAt: row.updated_at,
    ...(row.completed_at ? { completedAt: row.completed_at } : {}),
    ...(row.completed_by ? { completedBy: row.completed_by } : {}),
  };
}

function cloudWebhook(row: WebhookRow): CloudWebhook {
  return {
    id: row.id,
    siteId: row.site_id,
    url: row.url,
    events: parseRecord<CloudWebhookEvent[]>(row.events_json),
    format: row.format,
    secret: row.secret,
    createdBy: row.created_by,
    createdAt: row.created_at,
  };
}

function cloudWebhookDelivery(row: WebhookDeliveryRow): CloudWebhookDelivery {
  return {
    id: row.id,
    webhookId: row.webhook_id,
    siteId: row.site_id,
    event: row.event,
    payload: parseRecord<Record<string, unknown>>(row.payload_json),
    status: row.status,
    attempts: row.attempts,
    nextAttemptAt: row.next_attempt_at,
    ...(row.response_status === null ? {} : { responseStatus: row.response_status }),
    ...(row.last_error ? { lastError: row.last_error } : {}),
    createdAt: row.created_at,
    ...(row.delivered_at ? { deliveredAt: row.delivered_at } : {}),
  };
}

function cloudEmail(row: EmailRow): CloudEmail {
  return {
    id: row.id,
    userId: row.user_id,
    to: row.to_address,
    subject: row.subject,
    text: row.body_text,
    kind: row.kind,
    status: row.status,
    attempts: row.attempts,
    nextAttemptAt: row.next_attempt_at,
    ...(row.last_error ? { lastError: row.last_error } : {}),
    createdAt: row.created_at,
    ...(row.sent_at ? { sentAt: row.sent_at } : {}),
  };
}
