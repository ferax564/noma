import DatabaseConstructor from "better-sqlite3";
import type { Database as SqliteDatabase } from "better-sqlite3";
import { randomBytes } from "node:crypto";
import { copyFileSync, mkdirSync, readdirSync, readFileSync, renameSync, rmdirSync, unlinkSync } from "node:fs";
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

export type CloudNotificationType = "mention" | "comment" | "approval_requested" | "approval_updated" | "page_updated";

export const cloudNotificationTypes: readonly CloudNotificationType[] = [
  "mention",
  "comment",
  "approval_requested",
  "approval_updated",
  "page_updated",
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

export interface CloudWatch {
  userId: string;
  resourceType: CloudResourceType;
  resourceId: string;
  watchedAt: string;
}

export interface CloudAttachment {
  id: string;
  documentId: string;
  sha256: string;
  filename: string;
  contentType: string;
  size: number;
  uploadedBy: string;
  uploadedByName?: string;
  createdAt: string;
  deletedAt?: string;
}

export type CloudRestrictionKind = "view" | "edit";

export interface CloudRestrictionPrincipals {
  users: string[];
  groups: string[];
}

export type CloudPageRestrictions = Record<CloudRestrictionKind, CloudRestrictionPrincipals>;

/** How page restrictions narrow a principal's space/page grant: hide the page, or cap it at viewer. */
export type CloudRestrictionCap = "hidden" | "viewer";

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

export type CloudTokenScope = "read" | "write" | "admin";

export const cloudTokenScopes: readonly CloudTokenScope[] = ["read", "write", "admin"];

/** A browser session backed by the HttpOnly `noma_session` cookie. Only hashes of the cookie and CSRF secrets are stored. */
export interface CloudAuthSession {
  id: string;
  userId: string;
  scopes: CloudTokenScope[];
  source: "user_token" | "register" | "pat" | "sso";
  patId?: string;
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
  userAgent?: string;
  ip?: string;
  revokedAt?: string;
}

/** A named, scoped, revocable personal access token (`noma_pat_…`). The raw token is shown once and stored hashed. */
export interface CloudPersonalAccessToken {
  id: string;
  userId: string;
  name: string;
  tokenPreview: string;
  scopes: CloudTokenScope[];
  createdAt: string;
  expiresAt?: string;
  lastUsedAt?: string;
  revokedAt?: string;
}

interface AuthSessionRow {
  id: string;
  user_id: string;
  csrf_hash: string;
  scopes_json: string;
  source: CloudAuthSession["source"];
  pat_id: string | null;
  created_at: string;
  last_seen_at: string;
  expires_at: string;
  user_agent: string | null;
  ip: string | null;
  revoked_at: string | null;
}

interface PersonalAccessTokenRow {
  id: string;
  user_id: string;
  name: string;
  token_preview: string;
  scopes_json: string;
  created_at: string;
  expires_at: string | null;
  last_used_at: string | null;
  revoked_at: string | null;
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
  /** Workspace admins, who bypass page restrictions. Empty means the first registered user. */
  adminUserIds?: string[];
  /** When false (production), an empty `adminUserIds` means no admin rather than the first registered user. */
  bootstrapFirstUserAdmin?: boolean;
}

interface AttachmentRow {
  id: string;
  document_id: string;
  sha256: string;
  filename: string;
  content_type: string;
  size: number;
  uploaded_by: string;
  uploaded_by_name: string | null;
  created_at: string;
  deleted_at: string | null;
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

// cloud-ai record types
export interface CloudAiUsageRecord {
  id: string;
  userId: string;
  agentId: string;
  feature: string;
  model: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  siteId?: string;
  documentId?: string;
  createdAt: string;
}

export interface CloudAiPageProposal {
  id: string;
  siteId: string;
  parentId?: string;
  title: string;
  source: string;
  sourceHash: string;
  instruction: string;
  proposedBy: string;
  agentId: string;
  model: string;
  citations: Array<{ documentId: string; blockId: string; versionHash: string }>;
  diagnostics: unknown[];
  status: CloudPatchProposalStatus;
  reviewedBy?: string;
  reviewedAt?: string;
  documentId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface CloudSiteMaintenanceSettings {
  siteId: string;
  enabled: boolean;
  aiRefresh: boolean;
  intervalHours: number;
  maxProposalsPerRun: number;
  /** User whose access scopes the sweep and whose AI budget pays for refresh drafts. */
  runAs: string;
  updatedBy: string;
  updatedAt: string;
  lastRunAt?: string;
}

export interface CloudHealthItemRecord {
  id: string;
  siteId: string;
  kind: string;
  severity: "info" | "warning" | "error";
  documentId?: string;
  blockId?: string;
  message: string;
  evidence: Record<string, unknown>;
  status: "open" | "resolved";
  proposalId?: string;
  firstSeenAt: string;
  lastSeenAt: string;
  resolvedAt?: string;
}

export interface CloudMaintenanceRun {
  id: string;
  siteId: string;
  trigger: "manual" | "scheduled";
  status: "running" | "completed" | "failed";
  startedAt: string;
  finishedAt?: string;
  itemsOpen: number;
  itemsResolved: number;
  proposalsCreated: number;
  detail: Record<string, unknown>;
}

interface AiUsageRow {
  id: string;
  user_id: string;
  agent_id: string;
  feature: string;
  model: string;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  site_id: string | null;
  document_id: string | null;
  created_at: string;
}

interface AiPageProposalRow {
  id: string;
  site_id: string;
  parent_id: string | null;
  title: string;
  source: string;
  source_hash: string;
  instruction: string;
  proposed_by: string;
  agent_id: string;
  model: string;
  citations_json: string;
  diagnostics_json: string;
  status: CloudPatchProposalStatus;
  reviewed_by: string | null;
  reviewed_at: string | null;
  document_id: string | null;
  created_at: string;
  updated_at: string;
}

interface SiteMaintenanceRow {
  site_id: string;
  enabled: number;
  ai_refresh: number;
  interval_hours: number;
  max_proposals_per_run: number;
  run_as: string;
  updated_by: string;
  updated_at: string;
  last_run_at: string | null;
}

interface HealthItemRow {
  id: string;
  site_id: string;
  kind: string;
  severity: string;
  document_id: string | null;
  block_id: string | null;
  message: string;
  evidence_json: string;
  status: string;
  proposal_id: string | null;
  first_seen_at: string;
  last_seen_at: string;
  resolved_at: string | null;
}

interface MaintenanceRunRow {
  id: string;
  site_id: string;
  trigger: string;
  status: string;
  started_at: string;
  finished_at: string | null;
  items_open: number;
  items_resolved: number;
  proposals_created: number;
  detail_json: string;
}

function cloudAiPageProposal(row: AiPageProposalRow): CloudAiPageProposal {
  return {
    id: row.id,
    siteId: row.site_id,
    ...(row.parent_id ? { parentId: row.parent_id } : {}),
    title: row.title,
    source: row.source,
    sourceHash: row.source_hash,
    instruction: row.instruction,
    proposedBy: row.proposed_by,
    agentId: row.agent_id,
    model: row.model,
    citations: parseRecord<CloudAiPageProposal["citations"]>(row.citations_json),
    diagnostics: parseRecord<unknown[]>(row.diagnostics_json),
    status: row.status,
    ...(row.reviewed_by ? { reviewedBy: row.reviewed_by } : {}),
    ...(row.reviewed_at ? { reviewedAt: row.reviewed_at } : {}),
    ...(row.document_id ? { documentId: row.document_id } : {}),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function cloudSiteMaintenance(row: SiteMaintenanceRow): CloudSiteMaintenanceSettings {
  return {
    siteId: row.site_id,
    enabled: row.enabled === 1,
    aiRefresh: row.ai_refresh === 1,
    intervalHours: row.interval_hours,
    maxProposalsPerRun: row.max_proposals_per_run,
    runAs: row.run_as,
    updatedBy: row.updated_by,
    updatedAt: row.updated_at,
    ...(row.last_run_at ? { lastRunAt: row.last_run_at } : {}),
  };
}

function cloudHealthItem(row: HealthItemRow): CloudHealthItemRecord {
  return {
    id: row.id,
    siteId: row.site_id,
    kind: row.kind,
    severity: row.severity === "error" || row.severity === "warning" ? row.severity : "info",
    ...(row.document_id ? { documentId: row.document_id } : {}),
    ...(row.block_id ? { blockId: row.block_id } : {}),
    message: row.message,
    evidence: parseRecord<Record<string, unknown>>(row.evidence_json),
    status: row.status === "resolved" ? "resolved" : "open",
    ...(row.proposal_id ? { proposalId: row.proposal_id } : {}),
    firstSeenAt: row.first_seen_at,
    lastSeenAt: row.last_seen_at,
    ...(row.resolved_at ? { resolvedAt: row.resolved_at } : {}),
  };
}
// end cloud-ai record types

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

/**
 * Page restrictions for the user in `current_user`. `view_denied` holds every page the user cannot
 * see: pages whose view restriction does not list them, plus every descendant of such a page in any
 * space's page tree. `edit_denied` holds pages whose edit restriction does not list them. Direct
 * page owners are exempt on their own page; workspace admins are exempt everywhere.
 */
const pageRestrictionCtes = `restriction_admin(exempt) AS (
  SELECT CASE WHEN json_array_length(noma_workspace_admin_ids()) > 0
    THEN EXISTS (SELECT 1 FROM json_each(noma_workspace_admin_ids()) admin JOIN current_user cu ON cu.user_id = admin.value)
    WHEN noma_bootstrap_first_user_admin() = 0 THEN 0
    ELSE EXISTS (SELECT 1 FROM current_user cu WHERE cu.user_id = (SELECT id FROM users ORDER BY created_at, rowid LIMIT 1))
  END
),
restriction_allowed(document_id, kind) AS (
  SELECT pr.document_id, pr.kind
  FROM page_restrictions pr
  JOIN current_user cu ON pr.principal_type = 'user' AND pr.principal_id = cu.user_id
  UNION
  SELECT pr.document_id, pr.kind
  FROM page_restrictions pr
  JOIN group_members gm ON pr.principal_type = 'group' AND pr.principal_id = gm.group_id
  JOIN current_user cu ON cu.user_id = gm.user_id
  UNION
  SELECT p.resource_id, kinds.kind
  FROM permissions p
  JOIN current_user cu ON cu.user_id = p.user_id
  CROSS JOIN (SELECT 'view' AS kind UNION ALL SELECT 'edit') kinds
  WHERE p.resource_type = 'document' AND p.role = 'owner'
),
view_denied(document_id) AS (
  SELECT document_id FROM (
    SELECT document_id FROM page_restrictions WHERE kind = 'view'
    EXCEPT
    SELECT document_id FROM restriction_allowed WHERE kind = 'view'
  )
  WHERE NOT (SELECT exempt FROM restriction_admin)
  UNION
  SELECT pp.document_id FROM page_parents pp JOIN view_denied vd ON pp.parent_id = vd.document_id
),
edit_denied(document_id) AS (
  SELECT document_id FROM page_restrictions WHERE kind = 'edit'
  EXCEPT
  SELECT document_id FROM restriction_allowed WHERE kind = 'edit'
)`;

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
granted_docs AS (
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
),
${pageRestrictionCtes},
visible_docs AS (
  SELECT g.id,
    CASE
      WHEN g.rank > 1
        AND NOT (SELECT exempt FROM restriction_admin)
        AND g.id IN (SELECT document_id FROM edit_denied)
      THEN 1
      ELSE g.rank
    END AS rank
  FROM granted_docs g
  WHERE g.id NOT IN (SELECT document_id FROM view_denied)
)`;

export class NomaCloudDatabase {
  private readonly db: SqliteDatabase;

  constructor(private readonly options: CloudDatabaseOptions) {
    mkdirSync(dirname(options.dbPath), { recursive: true });
    this.db = new DatabaseConstructor(options.dbPath);
    this.db.pragma("journal_mode = WAL");
    this.db.pragma("foreign_keys = ON");
    this.db.pragma("busy_timeout = 5000");
    this.db.function("noma_workspace_admin_ids", { deterministic: false }, () => JSON.stringify(this.options.adminUserIds ?? []));
    this.db.function("noma_bootstrap_first_user_admin", { deterministic: false }, () => (this.options.bootstrapFirstUserAdmin === false ? 0 : 1));
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
    if (!row) return undefined;
    const cap = resourceType === "document" ? this.documentRestrictionCap(userId, resourceId) : undefined;
    if (cap === "hidden") return undefined;
    const role = cap === "viewer" ? "viewer" : row.role;
    return { role, via: row.via, ...(row.group_id ? { groupId: row.group_id } : {}) };
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
      this.replacePageParents(next);
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
        for (const owned of ["document_revisions", "blocks", "comments", "approvals", "patch_proposals", "document_labels", "attachments", "page_restrictions"]) {
          this.db.prepare(`DELETE FROM ${owned} WHERE document_id = ?`).run(id);
        }
        this.db.prepare("DELETE FROM search_index WHERE document_id = ?").run(id);
        this.db.prepare("DELETE FROM knowledge_health_items WHERE document_id = ?").run(id);
        this.db.prepare("DELETE FROM site_documents WHERE document_id = ?").run(id);
        for (const row of this.db.prepare("SELECT id FROM sites").all() as Array<{ id: string }>) {
          const site = this.readSite(row.id);
          if (!site?.documentIds.includes(id)) continue;
          this.writeSite(withoutSitePage(site, id));
        }
      } else {
        this.db.prepare("DELETE FROM site_documents WHERE site_id = ?").run(id);
        this.db.prepare("DELETE FROM page_parents WHERE site_id = ?").run(id);
        for (const owned of ["ai_page_proposals", "site_maintenance", "knowledge_health_items", "maintenance_runs"]) {
          this.db.prepare(`DELETE FROM ${owned} WHERE site_id = ?`).run(id);
        }
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

  // ---- attachments ----

  insertAttachment(attachment: Omit<CloudAttachment, "uploadedByName" | "deletedAt">): void {
    this.db
      .prepare(
        `INSERT INTO attachments (id, document_id, sha256, filename, content_type, size, uploaded_by, created_at)
         VALUES (@id, @documentId, @sha256, @filename, @contentType, @size, @uploadedBy, @createdAt)`,
      )
      .run(attachment);
  }

  /** Reads an attachment row, including soft-deleted ones; callers decide whether deleted rows are usable. */
  readAttachment(id: string): CloudAttachment | undefined {
    const row = this.db
      .prepare(
        `SELECT a.*, u.name AS uploaded_by_name FROM attachments a
         LEFT JOIN users u ON u.id = a.uploaded_by
         WHERE a.id = ?`,
      )
      .get(id) as AttachmentRow | undefined;
    return row ? cloudAttachment(row) : undefined;
  }

  listAttachments(documentId: string, limit = 500): CloudAttachment[] {
    return (
      this.db
        .prepare(
          `SELECT a.*, u.name AS uploaded_by_name FROM attachments a
           LEFT JOIN users u ON u.id = a.uploaded_by
           WHERE a.document_id = ? AND a.deleted_at IS NULL
           ORDER BY a.created_at, a.rowid
           LIMIT ?`,
        )
        .all(documentId, limit) as AttachmentRow[]
    ).map(cloudAttachment);
  }

  markAttachmentDeleted(id: string, deletedAt: string): boolean {
    return this.db.prepare("UPDATE attachments SET deleted_at = ? WHERE id = ? AND deleted_at IS NULL").run(deletedAt, id).changes > 0;
  }

  /** Bytes of live attachments on pages in the space; each upload counts even when its blob is shared. */
  siteAttachmentBytes(siteId: string): number {
    const row = this.db
      .prepare(
        `SELECT COALESCE(SUM(a.size), 0) AS bytes FROM attachments a
         JOIN site_documents sd ON sd.document_id = a.document_id
         WHERE sd.site_id = ? AND a.deleted_at IS NULL`,
      )
      .get(siteId) as { bytes: number };
    return row.bytes;
  }

  /** Bytes of live attachments a user uploaded to pages that belong to no space. */
  unspacedAttachmentBytes(userId: string): number {
    const row = this.db
      .prepare(
        `SELECT COALESCE(SUM(a.size), 0) AS bytes FROM attachments a
         WHERE a.uploaded_by = ? AND a.deleted_at IS NULL
           AND NOT EXISTS (SELECT 1 FROM site_documents sd WHERE sd.document_id = a.document_id)`,
      )
      .get(userId) as { bytes: number };
    return row.bytes;
  }

  documentSiteIds(documentId: string): string[] {
    return (this.db.prepare("SELECT site_id FROM site_documents WHERE document_id = ? ORDER BY position, site_id").all(documentId) as Array<{ site_id: string }>).map(
      (row) => row.site_id,
    );
  }

  /** Every blob hash a document's attachments point at, including soft-deleted attachments. */
  attachmentBlobHashes(documentId: string): string[] {
    return (this.db.prepare("SELECT DISTINCT sha256 FROM attachments WHERE document_id = ?").all(documentId) as Array<{ sha256: string }>).map((row) => row.sha256);
  }

  isBlobReferenced(sha256: string): boolean {
    return Boolean(this.db.prepare("SELECT 1 AS found FROM attachments WHERE sha256 = ? LIMIT 1").get(sha256));
  }

  /** Re-indexes a document's attachment filenames into `blocks`/`search_index` as `attachment` rows. */
  reindexAttachments(documentId: string): void {
    const document = this.db.prepare("SELECT title FROM documents WHERE id = ?").get(documentId) as { title: string } | undefined;
    if (!document) return;
    this.db.transaction(() => this.indexAttachmentBlocks(documentId, document.title))();
  }

  /** HMAC key for signed attachment URLs; created once per database so signatures survive restarts. */
  attachmentSigningKey(): string {
    const read = () => this.db.prepare("SELECT value FROM meta WHERE key = 'attachment_signing_key'").get() as { value: string } | undefined;
    const existing = read();
    if (existing) return existing.value;
    this.db.prepare("INSERT OR IGNORE INTO meta (key, value) VALUES ('attachment_signing_key', ?)").run(randomBytes(32).toString("hex"));
    return read()!.value;
  }

  private indexAttachmentBlocks(documentId: string, documentTitle: string): void {
    const stale = this.db.prepare("SELECT row_key FROM blocks WHERE document_id = ? AND node_type = 'attachment'").all(documentId) as Array<{ row_key: string }>;
    const deleteSearch = this.db.prepare("DELETE FROM search_index WHERE row_key = ?");
    for (const row of stale) deleteSearch.run(row.row_key);
    this.db.prepare("DELETE FROM blocks WHERE document_id = ? AND node_type = 'attachment'").run(documentId);
    const insert = this.db.prepare(
      `INSERT INTO blocks
        (row_key, document_id, block_id, aliases_json, node_type, directive_name, title, text, line, depth, ordinal)
       VALUES (?, ?, ?, '[]', 'attachment', NULL, ?, ?, NULL, 0, ?)`,
    );
    const searchInsert = this.db.prepare("INSERT INTO search_index (row_key, document_id, document_title, block_id, text) VALUES (?, ?, ?, ?, ?)");
    this.listAttachments(documentId).forEach((attachment, index) => {
      const rowKey = `${documentId}:attachment:${attachment.id}`;
      const blockId = `att:${attachment.id}`;
      const text = `${attachment.filename} ${attachment.contentType}`;
      insert.run(rowKey, documentId, blockId, attachment.filename, text, 1_000_000 + index);
      searchInsert.run(rowKey, documentId, documentTitle, blockId, `${attachment.filename}\n${text}`);
    });
  }

  // ---- page restrictions ----

  readPageRestrictions(documentId: string): CloudPageRestrictions {
    const restrictions: CloudPageRestrictions = { view: { users: [], groups: [] }, edit: { users: [], groups: [] } };
    const rows = this.db
      .prepare("SELECT kind, principal_type, principal_id FROM page_restrictions WHERE document_id = ? ORDER BY kind, principal_type, principal_id")
      .all(documentId) as Array<{ kind: CloudRestrictionKind; principal_type: "user" | "group"; principal_id: string }>;
    for (const row of rows) restrictions[row.kind][row.principal_type === "user" ? "users" : "groups"].push(row.principal_id);
    return restrictions;
  }

  replacePageRestrictions(documentId: string, restrictions: CloudPageRestrictions, addedBy: string, addedAt: string): void {
    this.db.transaction(() => {
      this.db.prepare("DELETE FROM page_restrictions WHERE document_id = ?").run(documentId);
      const insert = this.db.prepare(
        `INSERT OR IGNORE INTO page_restrictions (document_id, kind, principal_type, principal_id, added_by, added_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      );
      for (const kind of ["view", "edit"] as const) {
        for (const userId of restrictions[kind].users) insert.run(documentId, kind, "user", userId, addedBy, addedAt);
        for (const groupId of restrictions[kind].groups) insert.run(documentId, kind, "group", groupId, addedBy, addedAt);
      }
    })();
  }

  /**
   * How page restrictions narrow `userId`'s access to a document (`undefined` = share-link or
   * anonymous access, which no restriction lists). A view restriction on the page or on any ancestor
   * in any space's page tree hides it; an edit restriction on the page itself caps it at viewer.
   */
  documentRestrictionCap(userId: string | undefined, documentId: string): CloudRestrictionCap | undefined {
    const rows = this.db
      .prepare(
        `WITH ancestry(id, depth) AS (
           SELECT ?, 0
           UNION
           SELECT pp.parent_id, a.depth + 1 FROM page_parents pp JOIN ancestry a ON pp.document_id = a.id WHERE a.depth < 256
         )
         SELECT DISTINCT pr.document_id, pr.kind
         FROM page_restrictions pr
         JOIN ancestry a ON a.id = pr.document_id
         WHERE pr.kind = 'view' OR a.depth = 0
         ORDER BY pr.kind DESC`,
      )
      .all(documentId) as Array<{ document_id: string; kind: CloudRestrictionKind }>;
    if (rows.length === 0) return undefined;
    if (userId && this.isWorkspaceAdmin(userId)) return undefined;
    let cap: CloudRestrictionCap | undefined;
    for (const row of rows) {
      if (userId && this.restrictionAllows(userId, row.document_id, row.kind)) continue;
      if (row.kind === "view") return "hidden";
      cap = "viewer";
    }
    return cap;
  }

  /** Per page: whether it carries its own view/edit restrictions and whether an ancestor restricts viewing. */
  pageRestrictionFlags(documentIds: string[]): Map<string, { view: boolean; edit: boolean; inheritedView: boolean }> {
    const flags = new Map<string, { view: boolean; edit: boolean; inheritedView: boolean }>();
    if (documentIds.length === 0) return flags;
    const rows = this.db
      .prepare(
        `WITH ancestry(doc, id, depth) AS (
           SELECT value, value, 0 FROM json_each(?)
           UNION
           SELECT a.doc, pp.parent_id, a.depth + 1 FROM page_parents pp JOIN ancestry a ON pp.document_id = a.id WHERE a.depth < 256
         )
         SELECT a.doc, pr.kind, MIN(a.depth) AS depth
         FROM ancestry a JOIN page_restrictions pr ON pr.document_id = a.id
         GROUP BY a.doc, pr.kind, a.depth = 0`,
      )
      .all(JSON.stringify(documentIds)) as Array<{ doc: string; kind: CloudRestrictionKind; depth: number }>;
    for (const row of rows) {
      const entry = flags.get(row.doc) ?? { view: false, edit: false, inheritedView: false };
      if (row.depth === 0) entry[row.kind] = true;
      else if (row.kind === "view") entry.inheritedView = true;
      flags.set(row.doc, entry);
    }
    return flags;
  }

  /** Ancestor pages (in any space's tree) that carry their own view restrictions, nearest first. */
  restrictedAncestors(documentId: string): string[] {
    return (
      this.db
        .prepare(
          `WITH ancestry(id, depth) AS (
             SELECT ?, 0
             UNION
             SELECT pp.parent_id, a.depth + 1 FROM page_parents pp JOIN ancestry a ON pp.document_id = a.id WHERE a.depth < 256
           )
           SELECT a.id, MIN(a.depth) AS depth FROM ancestry a
           WHERE a.depth > 0 AND EXISTS (SELECT 1 FROM page_restrictions pr WHERE pr.document_id = a.id AND pr.kind = 'view')
           GROUP BY a.id
           ORDER BY depth, a.id`,
        )
        .all(documentId) as Array<{ id: string }>
    ).map((row) => row.id);
  }

  /** Workspace admins bypass page restrictions: the configured allowlist, or else the first registered user. */
  isWorkspaceAdmin(userId: string): boolean {
    const admins = this.options.adminUserIds ?? [];
    if (admins.length > 0) return admins.includes(userId);
    return this.options.bootstrapFirstUserAdmin !== false && this.firstRegisteredUserId() === userId;
  }

  isDirectDocumentOwner(userId: string, documentId: string): boolean {
    return Boolean(
      this.db
        .prepare("SELECT 1 AS found FROM permissions WHERE resource_type = 'document' AND resource_id = ? AND user_id = ? AND role = 'owner'")
        .get(documentId, userId),
    );
  }

  private restrictionAllows(userId: string, documentId: string, kind: CloudRestrictionKind): boolean {
    if (this.isDirectDocumentOwner(userId, documentId)) return true;
    return Boolean(
      this.db
        .prepare(
          `SELECT 1 AS found FROM page_restrictions pr
           WHERE pr.document_id = ? AND pr.kind = ?
             AND ((pr.principal_type = 'user' AND pr.principal_id = ?)
               OR (pr.principal_type = 'group' AND pr.principal_id IN (SELECT group_id FROM group_members WHERE user_id = ?)))
           LIMIT 1`,
        )
        .get(documentId, kind, userId, userId),
    );
  }

  private replacePageParents(site: CloudSiteRecord): void {
    this.db.prepare("DELETE FROM page_parents WHERE site_id = ?").run(site.id);
    const members = new Set(site.documentIds);
    const insert = this.db.prepare("INSERT INTO page_parents (site_id, document_id, parent_id) VALUES (?, ?, ?)");
    for (const [child, parent] of Object.entries(site.pageParents ?? {})) {
      if (child !== parent && members.has(child) && members.has(parent)) insert.run(site.id, child, parent);
    }
  }

  private rebuildPageParents(): void {
    this.db.transaction(() => {
      this.db.prepare("DELETE FROM page_parents").run();
      for (const row of this.db.prepare("SELECT id FROM sites").all() as Array<{ id: string }>) {
        const site = this.readSite(row.id);
        if (site) this.replacePageParents(site);
      }
    })();
  }
  // cloud-ai: AI usage, drafted pages, and maintenance

  writeAiUsage(usage: CloudAiUsageRecord): void {
    this.db
      .prepare(
        `INSERT INTO ai_usage (id, user_id, agent_id, feature, model, input_tokens, output_tokens, cost_usd, site_id, document_id, created_at)
         VALUES (@id, @userId, @agentId, @feature, @model, @inputTokens, @outputTokens, @costUsd, @siteId, @documentId, @createdAt)`,
      )
      .run({ ...usage, siteId: usage.siteId ?? null, documentId: usage.documentId ?? null });
  }

  /** Total AI spend by one user since `since` (ISO timestamp). */
  aiSpendSince(userId: string, since: string): number {
    const row = this.db.prepare("SELECT COALESCE(SUM(cost_usd), 0) AS total FROM ai_usage WHERE user_id = ? AND created_at >= ?").get(userId, since) as { total: number };
    return row.total;
  }

  listAiUsage(userId: string, limit = 50): CloudAiUsageRecord[] {
    const rows = this.db.prepare("SELECT * FROM ai_usage WHERE user_id = ? ORDER BY created_at DESC, id DESC LIMIT ?").all(userId, limit) as AiUsageRow[];
    return rows.map((row) => ({
      id: row.id,
      userId: row.user_id,
      agentId: row.agent_id,
      feature: row.feature,
      model: row.model,
      inputTokens: row.input_tokens,
      outputTokens: row.output_tokens,
      costUsd: row.cost_usd,
      ...(row.site_id ? { siteId: row.site_id } : {}),
      ...(row.document_id ? { documentId: row.document_id } : {}),
      createdAt: row.created_at,
    }));
  }

  writeAiPageProposal(proposal: CloudAiPageProposal): void {
    this.db
      .prepare(
        `INSERT INTO ai_page_proposals
          (id, site_id, parent_id, title, source, source_hash, instruction, proposed_by, agent_id, model, citations_json,
           diagnostics_json, status, reviewed_by, reviewed_at, document_id, created_at, updated_at)
         VALUES
          (@id, @siteId, @parentId, @title, @source, @sourceHash, @instruction, @proposedBy, @agentId, @model, @citationsJson,
           @diagnosticsJson, @status, @reviewedBy, @reviewedAt, @documentId, @createdAt, @updatedAt)
         ON CONFLICT(id) DO UPDATE SET
           status = excluded.status,
           reviewed_by = excluded.reviewed_by,
           reviewed_at = excluded.reviewed_at,
           document_id = excluded.document_id,
           updated_at = excluded.updated_at`,
      )
      .run({
        id: proposal.id,
        siteId: proposal.siteId,
        parentId: proposal.parentId ?? null,
        title: proposal.title,
        source: proposal.source,
        sourceHash: proposal.sourceHash,
        instruction: proposal.instruction,
        proposedBy: proposal.proposedBy,
        agentId: proposal.agentId,
        model: proposal.model,
        citationsJson: JSON.stringify(proposal.citations),
        diagnosticsJson: JSON.stringify(proposal.diagnostics),
        status: proposal.status,
        reviewedBy: proposal.reviewedBy ?? null,
        reviewedAt: proposal.reviewedAt ?? null,
        documentId: proposal.documentId ?? null,
        createdAt: proposal.createdAt,
        updatedAt: proposal.updatedAt,
      });
  }

  readAiPageProposal(id: string): CloudAiPageProposal | undefined {
    const row = this.db.prepare("SELECT * FROM ai_page_proposals WHERE id = ?").get(id) as AiPageProposalRow | undefined;
    return row ? cloudAiPageProposal(row) : undefined;
  }

  listAiPageProposals(siteId: string, limit = 100): CloudAiPageProposal[] {
    const rows = this.db.prepare("SELECT * FROM ai_page_proposals WHERE site_id = ? ORDER BY created_at DESC, id DESC LIMIT ?").all(siteId, limit) as AiPageProposalRow[];
    return rows.map(cloudAiPageProposal);
  }

  readSiteMaintenance(siteId: string): CloudSiteMaintenanceSettings | undefined {
    const row = this.db.prepare("SELECT * FROM site_maintenance WHERE site_id = ?").get(siteId) as SiteMaintenanceRow | undefined;
    return row ? cloudSiteMaintenance(row) : undefined;
  }

  writeSiteMaintenance(settings: CloudSiteMaintenanceSettings): void {
    this.db
      .prepare(
        `INSERT INTO site_maintenance (site_id, enabled, ai_refresh, interval_hours, max_proposals_per_run, run_as, updated_by, updated_at, last_run_at)
         VALUES (@siteId, @enabled, @aiRefresh, @intervalHours, @maxProposalsPerRun, @runAs, @updatedBy, @updatedAt, @lastRunAt)
         ON CONFLICT(site_id) DO UPDATE SET
           enabled = excluded.enabled,
           ai_refresh = excluded.ai_refresh,
           interval_hours = excluded.interval_hours,
           max_proposals_per_run = excluded.max_proposals_per_run,
           run_as = excluded.run_as,
           updated_by = excluded.updated_by,
           updated_at = excluded.updated_at,
           last_run_at = excluded.last_run_at`,
      )
      .run({
        siteId: settings.siteId,
        enabled: settings.enabled ? 1 : 0,
        aiRefresh: settings.aiRefresh ? 1 : 0,
        intervalHours: settings.intervalHours,
        maxProposalsPerRun: settings.maxProposalsPerRun,
        runAs: settings.runAs,
        updatedBy: settings.updatedBy,
        updatedAt: settings.updatedAt,
        lastRunAt: settings.lastRunAt ?? null,
      });
  }

  /** Enabled, non-trashed spaces whose last sweep is older than their interval, oldest first. */
  listDueSiteMaintenance(now: string, limit: number): CloudSiteMaintenanceSettings[] {
    const rows = this.db
      .prepare(
        `SELECT m.* FROM site_maintenance m
         WHERE m.enabled = 1
           AND NOT EXISTS (SELECT 1 FROM trashed_resources t WHERE t.resource_type = 'site' AND t.resource_id = m.site_id)
           AND (m.last_run_at IS NULL OR datetime(m.last_run_at, '+' || m.interval_hours || ' hours') <= datetime(?))
         ORDER BY COALESCE(m.last_run_at, '') ASC LIMIT ?`,
      )
      .all(now, limit) as SiteMaintenanceRow[];
    return rows.map(cloudSiteMaintenance);
  }

  listHealthItems(siteId: string, status?: CloudHealthItemRecord["status"], limit = 500): CloudHealthItemRecord[] {
    const rows = (status
      ? this.db.prepare("SELECT * FROM knowledge_health_items WHERE site_id = ? AND status = ? ORDER BY last_seen_at DESC, id LIMIT ?").all(siteId, status, limit)
      : this.db.prepare("SELECT * FROM knowledge_health_items WHERE site_id = ? ORDER BY last_seen_at DESC, id LIMIT ?").all(siteId, limit)) as HealthItemRow[];
    return rows.map(cloudHealthItem);
  }

  writeHealthItem(item: CloudHealthItemRecord): void {
    this.db
      .prepare(
        `INSERT INTO knowledge_health_items
          (id, site_id, kind, severity, document_id, block_id, message, evidence_json, status, proposal_id, first_seen_at, last_seen_at, resolved_at)
         VALUES
          (@id, @siteId, @kind, @severity, @documentId, @blockId, @message, @evidenceJson, @status, @proposalId, @firstSeenAt, @lastSeenAt, @resolvedAt)
         ON CONFLICT(id) DO UPDATE SET
           severity = excluded.severity,
           message = excluded.message,
           evidence_json = excluded.evidence_json,
           status = excluded.status,
           proposal_id = excluded.proposal_id,
           last_seen_at = excluded.last_seen_at,
           resolved_at = excluded.resolved_at`,
      )
      .run({
        id: item.id,
        siteId: item.siteId,
        kind: item.kind,
        severity: item.severity,
        documentId: item.documentId ?? null,
        blockId: item.blockId ?? null,
        message: item.message,
        evidenceJson: JSON.stringify(item.evidence),
        status: item.status,
        proposalId: item.proposalId ?? null,
        firstSeenAt: item.firstSeenAt,
        lastSeenAt: item.lastSeenAt,
        resolvedAt: item.resolvedAt ?? null,
      });
  }

  writeMaintenanceRun(run: CloudMaintenanceRun): void {
    this.db
      .prepare(
        `INSERT INTO maintenance_runs (id, site_id, trigger, status, started_at, finished_at, items_open, items_resolved, proposals_created, detail_json)
         VALUES (@id, @siteId, @trigger, @status, @startedAt, @finishedAt, @itemsOpen, @itemsResolved, @proposalsCreated, @detailJson)
         ON CONFLICT(id) DO UPDATE SET
           status = excluded.status,
           finished_at = excluded.finished_at,
           items_open = excluded.items_open,
           items_resolved = excluded.items_resolved,
           proposals_created = excluded.proposals_created,
           detail_json = excluded.detail_json`,
      )
      .run({
        id: run.id,
        siteId: run.siteId,
        trigger: run.trigger,
        status: run.status,
        startedAt: run.startedAt,
        finishedAt: run.finishedAt ?? null,
        itemsOpen: run.itemsOpen,
        itemsResolved: run.itemsResolved,
        proposalsCreated: run.proposalsCreated,
        detailJson: JSON.stringify(run.detail),
      });
  }

  listMaintenanceRuns(siteId: string, limit = 20): CloudMaintenanceRun[] {
    const rows = this.db.prepare("SELECT * FROM maintenance_runs WHERE site_id = ? ORDER BY started_at DESC, id DESC LIMIT ?").all(siteId, limit) as MaintenanceRunRow[];
    return rows.map((row) => ({
      id: row.id,
      siteId: row.site_id,
      trigger: row.trigger === "scheduled" ? "scheduled" : "manual",
      status: row.status === "completed" || row.status === "failed" ? row.status : "running",
      startedAt: row.started_at,
      ...(row.finished_at ? { finishedAt: row.finished_at } : {}),
      itemsOpen: row.items_open,
      itemsResolved: row.items_resolved,
      proposalsCreated: row.proposals_created,
      detail: parseRecord<Record<string, unknown>>(row.detail_json),
    }));
  }

  // end cloud-ai

  query(user: CloudUserRecord, query: CloudDbQuery): CloudDbQueryResult {
    switch (query.resource) {
      case "documents":
        return { resource: query.resource, limit: query.limit, offset: query.offset, rows: this.queryDocuments(user, query) };
      case "sites":
        return { resource: query.resource, limit: query.limit, offset: query.offset, rows: this.querySites(user, query) };
      case "blocks":
        return { resource: query.resource, limit: query.limit, offset: query.offset, rows: this.queryBlocks(user, query) };
      case "users":
        return { resource: query.resource, limit: query.limit, offset: query.offset, rows: this.queryUsers(user, query) };
    }
  }

  // auth-hardening: sessions, personal access tokens, and transactional writes

  /** Runs `operation` inside one SQLite transaction; any throw rolls every write back. */
  runInTransaction<T>(operation: () => T): T {
    return this.db.transaction(operation)();
  }

  createAuthSession(session: CloudAuthSession, secretHash: string, csrfHash: string): void {
    this.db
      .prepare(
        `INSERT INTO auth_sessions
           (id, secret_hash, csrf_hash, user_id, scopes_json, source, pat_id, created_at, last_seen_at, expires_at, user_agent, ip)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        session.id,
        secretHash,
        csrfHash,
        session.userId,
        JSON.stringify(session.scopes),
        session.source,
        session.patId ?? null,
        session.createdAt,
        session.lastSeenAt,
        session.expiresAt,
        session.userAgent ?? null,
        session.ip ?? null,
      );
  }

  /** Active (unrevoked, unexpired) session for a cookie secret hash, with the stored CSRF hash. */
  findAuthSession(secretHash: string, now: string): { session: CloudAuthSession; csrfHash: string } | undefined {
    const row = this.db
      .prepare("SELECT * FROM auth_sessions WHERE secret_hash = ? AND revoked_at IS NULL AND expires_at > ?")
      .get(secretHash, now) as AuthSessionRow | undefined;
    return row ? { session: authSession(row), csrfHash: row.csrf_hash } : undefined;
  }

  touchAuthSession(id: string, lastSeenAt: string): void {
    this.db.prepare("UPDATE auth_sessions SET last_seen_at = ? WHERE id = ?").run(lastSeenAt, id);
  }

  setAuthSessionCsrf(id: string, csrfHash: string): void {
    this.db.prepare("UPDATE auth_sessions SET csrf_hash = ? WHERE id = ?").run(csrfHash, id);
  }

  listAuthSessions(userId: string, now: string, limit: number, offset: number): CloudAuthSession[] {
    const rows = this.db
      .prepare(
        `SELECT * FROM auth_sessions
         WHERE user_id = ? AND revoked_at IS NULL AND expires_at > ?
         ORDER BY last_seen_at DESC, id LIMIT ? OFFSET ?`,
      )
      .all(userId, now, limit, offset) as AuthSessionRow[];
    return rows.map(authSession);
  }

  revokeAuthSession(userId: string, id: string, revokedAt: string): boolean {
    return this.db
      .prepare("UPDATE auth_sessions SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL")
      .run(revokedAt, id, userId).changes > 0;
  }

  /** Revokes every active session of a user except `exceptId`; returns how many were revoked. */
  revokeUserAuthSessions(userId: string, revokedAt: string, exceptId?: string): number {
    return this.db
      .prepare("UPDATE auth_sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL AND id IS NOT ?")
      .run(revokedAt, userId, exceptId ?? null).changes;
  }

  /** Deletes sessions that expired or were revoked before `before`, keeping the table bounded. */
  purgeAuthSessions(before: string): number {
    return this.db
      .prepare("DELETE FROM auth_sessions WHERE expires_at < ? OR (revoked_at IS NOT NULL AND revoked_at < ?)")
      .run(before, before).changes;
  }

  createPersonalAccessToken(token: CloudPersonalAccessToken, tokenHash: string): void {
    this.db
      .prepare(
        `INSERT INTO personal_access_tokens
           (id, user_id, name, token_hash, token_preview, scopes_json, created_at, expires_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(token.id, token.userId, token.name, tokenHash, token.tokenPreview, JSON.stringify(token.scopes), token.createdAt, token.expiresAt ?? null);
  }

  /** Any token with this hash, including revoked or expired ones, so callers can report why it is rejected. */
  findPersonalAccessToken(tokenHash: string): CloudPersonalAccessToken | undefined {
    const row = this.db.prepare("SELECT * FROM personal_access_tokens WHERE token_hash = ?").get(tokenHash) as PersonalAccessTokenRow | undefined;
    return row ? personalAccessToken(row) : undefined;
  }

  readPersonalAccessToken(id: string): CloudPersonalAccessToken | undefined {
    const row = this.db.prepare("SELECT * FROM personal_access_tokens WHERE id = ?").get(id) as PersonalAccessTokenRow | undefined;
    return row ? personalAccessToken(row) : undefined;
  }

  listPersonalAccessTokens(userId: string, limit: number, offset: number): CloudPersonalAccessToken[] {
    const rows = this.db
      .prepare("SELECT * FROM personal_access_tokens WHERE user_id = ? ORDER BY created_at DESC, id LIMIT ? OFFSET ?")
      .all(userId, limit, offset) as PersonalAccessTokenRow[];
    return rows.map(personalAccessToken);
  }

  countActivePersonalAccessTokens(userId: string, now: string): number {
    const row = this.db
      .prepare(
        `SELECT COUNT(*) AS count FROM personal_access_tokens
         WHERE user_id = ? AND revoked_at IS NULL AND (expires_at IS NULL OR expires_at > ?)`,
      )
      .get(userId, now) as { count: number };
    return row.count;
  }

  /** Revokes a token and every browser session that was opened with it. */
  revokePersonalAccessToken(userId: string, id: string, revokedAt: string): boolean {
    return this.runInTransaction(() => {
      const changed = this.db
        .prepare("UPDATE personal_access_tokens SET revoked_at = ? WHERE id = ? AND user_id = ? AND revoked_at IS NULL")
        .run(revokedAt, id, userId).changes > 0;
      if (changed) this.db.prepare("UPDATE auth_sessions SET revoked_at = ? WHERE pat_id = ? AND revoked_at IS NULL").run(revokedAt, id);
      return changed;
    });
  }

  touchPersonalAccessToken(id: string, lastUsedAt: string): void {
    this.db.prepare("UPDATE personal_access_tokens SET last_used_at = ? WHERE id = ?").run(lastUsedAt, id);
  }

  // end auth-hardening

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
        type TEXT NOT NULL CHECK (type IN ('mention', 'comment', 'approval_requested', 'approval_updated', 'page_updated')),
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

      -- attachments
      CREATE TABLE IF NOT EXISTS attachments (
        id TEXT PRIMARY KEY,
        document_id TEXT NOT NULL,
        sha256 TEXT NOT NULL CHECK (length(sha256) = 64),
        filename TEXT NOT NULL,
        content_type TEXT NOT NULL,
        size INTEGER NOT NULL CHECK (size >= 0),
        uploaded_by TEXT NOT NULL,
        created_at TEXT NOT NULL,
        deleted_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_attachments_document ON attachments(document_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_attachments_sha256 ON attachments(sha256);
      CREATE INDEX IF NOT EXISTS idx_attachments_uploader ON attachments(uploaded_by, deleted_at);

      -- page restrictions
      CREATE TABLE IF NOT EXISTS page_restrictions (
        document_id TEXT NOT NULL,
        kind TEXT NOT NULL CHECK (kind IN ('view', 'edit')),
        principal_type TEXT NOT NULL CHECK (principal_type IN ('user', 'group')),
        principal_id TEXT NOT NULL,
        added_by TEXT NOT NULL,
        added_at TEXT NOT NULL,
        PRIMARY KEY (document_id, kind, principal_type, principal_id)
      );
      CREATE INDEX IF NOT EXISTS idx_page_restrictions_principal ON page_restrictions(principal_type, principal_id, kind);
      CREATE TABLE IF NOT EXISTS page_parents (
        site_id TEXT NOT NULL,
        document_id TEXT NOT NULL,
        parent_id TEXT NOT NULL,
        PRIMARY KEY (site_id, document_id)
      );
      CREATE INDEX IF NOT EXISTS idx_page_parents_parent ON page_parents(parent_id, document_id);
      CREATE INDEX IF NOT EXISTS idx_page_parents_document ON page_parents(document_id, parent_id);
      -- cloud-ai: AI usage accounting, drafted-page proposals, and stale-knowledge maintenance
      CREATE TABLE IF NOT EXISTS ai_usage (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        feature TEXT NOT NULL,
        model TEXT NOT NULL,
        input_tokens INTEGER NOT NULL,
        output_tokens INTEGER NOT NULL,
        cost_usd REAL NOT NULL,
        site_id TEXT,
        document_id TEXT,
        created_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS ai_page_proposals (
        id TEXT PRIMARY KEY,
        site_id TEXT NOT NULL,
        parent_id TEXT,
        title TEXT NOT NULL,
        source TEXT NOT NULL,
        source_hash TEXT NOT NULL,
        instruction TEXT NOT NULL,
        proposed_by TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        model TEXT NOT NULL,
        citations_json TEXT NOT NULL,
        diagnostics_json TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected', 'applied')),
        reviewed_by TEXT,
        reviewed_at TEXT,
        document_id TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS site_maintenance (
        site_id TEXT PRIMARY KEY,
        enabled INTEGER NOT NULL,
        ai_refresh INTEGER NOT NULL,
        interval_hours INTEGER NOT NULL,
        max_proposals_per_run INTEGER NOT NULL,
        run_as TEXT NOT NULL,
        updated_by TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_run_at TEXT
      );
      CREATE TABLE IF NOT EXISTS knowledge_health_items (
        id TEXT PRIMARY KEY,
        site_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        severity TEXT NOT NULL,
        document_id TEXT,
        block_id TEXT,
        message TEXT NOT NULL,
        evidence_json TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('open', 'resolved')),
        proposal_id TEXT,
        first_seen_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        resolved_at TEXT
      );
      CREATE TABLE IF NOT EXISTS maintenance_runs (
        id TEXT PRIMARY KEY,
        site_id TEXT NOT NULL,
        trigger TEXT NOT NULL,
        status TEXT NOT NULL,
        started_at TEXT NOT NULL,
        finished_at TEXT,
        items_open INTEGER NOT NULL DEFAULT 0,
        items_resolved INTEGER NOT NULL DEFAULT 0,
        proposals_created INTEGER NOT NULL DEFAULT 0,
        detail_json TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_ai_usage_user ON ai_usage(user_id, created_at);
      CREATE INDEX IF NOT EXISTS idx_ai_page_proposals_site ON ai_page_proposals(site_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_knowledge_health_items_site ON knowledge_health_items(site_id, status, last_seen_at DESC);
      CREATE INDEX IF NOT EXISTS idx_maintenance_runs_site ON maintenance_runs(site_id, started_at DESC);
      -- end cloud-ai
    `);
    this.rebuildPageParents();
    this.migrateNotificationTypes();
    this.db.exec(`
      -- auth-hardening: cookie sessions and personal access tokens
      CREATE TABLE IF NOT EXISTS auth_sessions (
        id TEXT PRIMARY KEY,
        secret_hash TEXT NOT NULL UNIQUE,
        csrf_hash TEXT NOT NULL,
        user_id TEXT NOT NULL,
        scopes_json TEXT NOT NULL,
        source TEXT NOT NULL CHECK (source IN ('user_token', 'register', 'pat', 'sso')),
        pat_id TEXT,
        created_at TEXT NOT NULL,
        last_seen_at TEXT NOT NULL,
        expires_at TEXT NOT NULL,
        user_agent TEXT,
        ip TEXT,
        revoked_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_auth_sessions_user ON auth_sessions(user_id, revoked_at, expires_at);
      CREATE INDEX IF NOT EXISTS idx_auth_sessions_pat ON auth_sessions(pat_id);
      CREATE INDEX IF NOT EXISTS idx_auth_sessions_expiry ON auth_sessions(expires_at);
      CREATE TABLE IF NOT EXISTS personal_access_tokens (
        id TEXT PRIMARY KEY,
        user_id TEXT NOT NULL,
        name TEXT NOT NULL,
        token_hash TEXT NOT NULL UNIQUE,
        token_preview TEXT NOT NULL,
        scopes_json TEXT NOT NULL,
        created_at TEXT NOT NULL,
        expires_at TEXT,
        last_used_at TEXT,
        revoked_at TEXT
      );
      CREATE INDEX IF NOT EXISTS idx_personal_access_tokens_user ON personal_access_tokens(user_id, created_at DESC);
      -- end auth-hardening
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

  /** SQLite cannot alter a CHECK constraint, so older databases rebuild the notifications table once. */
  private migrateNotificationTypes(): void {
    const row = this.db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'notifications'").get() as { sql: string } | undefined;
    if (!row || row.sql.includes("'page_updated'")) return;
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
    this.moveImportedLegacyJson();
  }

  /**
   * Moves legacy `*.json` records out of the data directories once they live in SQLite, so the
   * server never reads (or inlines) them again. Runs once per database, including databases that
   * imported before this step existed.
   */
  private moveImportedLegacyJson(): void {
    const moved = this.db.prepare("SELECT value FROM meta WHERE key = 'legacy_json_moved'").get() as { value: string } | undefined;
    if (moved) return;
    const sources: Array<[string, string]> = [
      ["documents", this.options.dataDir],
      ["users", this.options.usersDir],
      ["sites", this.options.sitesDir],
    ];
    const pending = sources.map(([label, dir]) => [label, dir, legacyJsonFileNames(dir)] as const).filter(([, , names]) => names.length > 0);
    let destination: string | undefined;
    if (pending.length > 0) {
      destination = join(dirname(this.options.dataDir), `legacy-imported-${new Date().toISOString().replace(/[:.]/g, "-")}`);
      for (const [label, dir, names] of pending) {
        const target = join(destination, label);
        mkdirSync(target, { recursive: true });
        for (const name of names) moveFile(join(dir, name), join(target, name));
      }
      removeDirectoryIfEmpty(this.options.usersDir);
      removeDirectoryIfEmpty(this.options.sitesDir);
    }
    this.db
      .prepare("INSERT INTO meta (key, value) VALUES ('legacy_json_moved', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(destination ?? "none");
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
    this.indexAttachmentBlocks(document.id, document.title);
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
    return rows.map((row) => {
      const site = parseRecord<CloudSiteRecord>(row.record_json);
      const visible = site.documentIds.filter((id) => this.documentRestrictionCap(user.id, id) !== "hidden");
      const keep = new Set(visible);
      const pageFolders = Object.fromEntries(Object.entries(site.pageFolders ?? {}).filter(([id]) => keep.has(id)));
      return siteQueryRow({ ...site, documentIds: visible, pageFolders }, rankToRole(row.rank));
    });
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

  private queryUsers(viewer: CloudUserRecord, query: CloudDbQuery): Array<Record<string, unknown>> {
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
    return rows.map((row) => publicUser(parseRecord<CloudUserRecord>(row.record_json), viewer.id));
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

function cloudAttachment(row: AttachmentRow): CloudAttachment {
  return {
    id: row.id,
    documentId: row.document_id,
    sha256: row.sha256,
    filename: row.filename,
    contentType: row.content_type,
    size: row.size,
    uploadedBy: row.uploaded_by,
    ...(row.uploaded_by_name ? { uploadedByName: row.uploaded_by_name } : {}),
    createdAt: row.created_at,
    ...(row.deleted_at ? { deletedAt: row.deleted_at } : {}),
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

function legacyJsonFileNames(dir: string): string[] {
  try {
    return readdirSync(dir).filter((name) => name.endsWith(".json"));
  } catch (error) {
    if (typeof error === "object" && error !== null && "code" in error && String(error.code) === "ENOENT") return [];
    throw error;
  }
}

function moveFile(from: string, to: string): void {
  try {
    renameSync(from, to);
  } catch (error) {
    if (!(typeof error === "object" && error !== null && "code" in error && String(error.code) === "EXDEV")) throw error;
    copyFileSync(from, to);
    unlinkSync(from);
  }
}

function removeDirectoryIfEmpty(dir: string): void {
  try {
    if (readdirSync(dir).length === 0) rmdirSync(dir);
  } catch {
    return;
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

function publicUser(user: CloudUserRecord, viewerId: string): Record<string, unknown> {
  return {
    id: user.id,
    name: user.name,
    ...(user.id === viewerId ? { tokenPreview: user.tokenPreview } : {}),
    createdAt: user.createdAt,
    updatedAt: user.updatedAt,
  };
}

function authSession(row: AuthSessionRow): CloudAuthSession {
  return {
    id: row.id,
    userId: row.user_id,
    scopes: parseScopes(row.scopes_json),
    source: row.source,
    ...(row.pat_id ? { patId: row.pat_id } : {}),
    createdAt: row.created_at,
    lastSeenAt: row.last_seen_at,
    expiresAt: row.expires_at,
    ...(row.user_agent ? { userAgent: row.user_agent } : {}),
    ...(row.ip ? { ip: row.ip } : {}),
    ...(row.revoked_at ? { revokedAt: row.revoked_at } : {}),
  };
}

function personalAccessToken(row: PersonalAccessTokenRow): CloudPersonalAccessToken {
  return {
    id: row.id,
    userId: row.user_id,
    name: row.name,
    tokenPreview: row.token_preview,
    scopes: parseScopes(row.scopes_json),
    createdAt: row.created_at,
    ...(row.expires_at ? { expiresAt: row.expires_at } : {}),
    ...(row.last_used_at ? { lastUsedAt: row.last_used_at } : {}),
    ...(row.revoked_at ? { revokedAt: row.revoked_at } : {}),
  };
}

function parseScopes(json: string): CloudTokenScope[] {
  const parsed = JSON.parse(json) as unknown;
  return Array.isArray(parsed) ? cloudTokenScopes.filter((scope) => parsed.includes(scope)) : [];
}

function rankToRole(rank: number): CloudRole {
  return rankRole[Math.max(1, Math.min(3, rank))] ?? "viewer";
}

function likePattern(value: string): string {
  return `%${value.replace(/[\\%_]/g, (match) => `\\${match}`)}%`;
}
