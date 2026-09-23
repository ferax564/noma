/** Shared types for the Noma Cloud browser app. */
import type { Diagnostic, DocumentNode } from "../../src/ast.js";
import type { Wikilink } from "../../src/inline.js";

export type CloudRole = "viewer" | "editor" | "owner";

export type PanelState = "ok" | "warning" | "error";

export type ViewMode = "visual" | "source" | "split" | "preview";

export type ThemeMode = "light" | "dark";

export type PreviewEditKind = "section" | "paragraph" | "list_item" | "quote";

export type PreviewInsertKind = "section" | "paragraph";

export interface AccessInfo {
  role?: CloudRole;
  via?: string;
}

export interface CloudUserSession {
  id: string;
  name: string;
  tokenPreview?: string;
}

export interface CloudAuthResponse {
  ok: boolean;
  user?: CloudUserSession;
  csrfToken?: string;
}

export interface CloudPersonalAccessTokenResponse {
  id: string;
  name: string;
  scopes: string[];
  expiresAt?: string;
  token: string;
}

export interface CloudStatusResponse {
  ok: boolean;
  user?: {
    id: string;
    name: string;
    tokenPreview?: string;
  };
}

export interface CloudDocumentResponse {
  id: string;
  title: string;
  source: string;
  hash: string;
  createdAt: string;
  updatedAt: string;
  diagnostics: Diagnostic[];
  access?: AccessInfo;
}

export interface CloudDocumentRevisionSummary {
  documentId: string;
  revision: number;
  title: string;
  hash: string;
  createdAt: string;
  createdBy: string;
}

export interface CloudPageTemplate {
  id: string;
  title: string;
  description: string;
  category: string;
  source: string;
  scope?: "built-in" | "workspace" | "site";
  siteId?: string;
  variables?: Array<{ name: string; label: string; default?: string; required: boolean }>;
  editable?: boolean;
}

export interface CloudSearchResult {
  documentId: string;
  siteId?: string;
  documentTitle: string;
  blockId?: string;
  nodeType?: string;
  contentType?: string;
  directiveName?: string;
  title?: string;
  excerpt?: string;
  exactSource?: string;
  score?: number;
  freshness?: { state: string };
  line?: number;
  sourceSpan?: { line: number; endLine: number };
}

export interface CloudNavigationItem {
  resourceType: "document" | "site";
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
  resolvedAt?: string;
}

export interface CloudNotification {
  id: string;
  type: string;
  title: string;
  body: string;
  resourceType?: "document" | "site";
  resourceId?: string;
  createdAt: string;
  readAt?: string;
}

export interface CloudApproval {
  id: string;
  documentId: string;
  documentHash: string;
  requestedBy: string;
  reviewerId: string;
  reviewerName: string;
  status: "pending" | "approved" | "changes_requested" | "cancelled";
  note?: string;
  updatedAt: string;
}

export interface CloudActivityEvent {
  id: string;
  actorId: string;
  actorName: string;
  action: string;
  resourceType: "document" | "site";
  resourceId: string;
  detail: Record<string, unknown>;
  createdAt: string;
}

export interface CloudGroup {
  id: string;
  name: string;
  createdBy: string;
  members: Array<{ userId: string; userName: string; role: "member" | "manager"; addedAt: string }>;
}

export type CloudIssueStatus = "backlog" | "todo" | "in_progress" | "in_review" | "done";

export type CloudSprintStatus = "planned" | "active" | "closed";

export interface CloudProject {
  id: string;
  key: string;
  name: string;
  siteId: string;
  access?: { role: CloudRole };
}

export interface CloudIssue {
  id: string;
  key: string;
  projectId: string;
  summary: string;
  description?: string;
  type: "task" | "story" | "bug" | "epic";
  status: CloudIssueStatus;
  priority: "lowest" | "low" | "medium" | "high" | "highest";
  reporterId: string;
  assigneeId?: string;
  assigneeName?: string;
  labels: string[];
  sprintId?: string;
  estimate?: number;
  dueDate?: string;
  updatedAt: string;
}

export interface CloudSprint {
  id: string;
  projectId: string;
  name: string;
  goal?: string;
  status: CloudSprintStatus;
}

export interface CloudIssueDetail extends CloudIssue {
  comments: Array<{ id: string; body: string; createdByName: string; createdAt: string }>;
  links: Array<{ id: string; type: string; targetIssueKey: string; targetIssueSummary: string }>;
  events: Array<{ id: string; action: string; actorName: string; createdAt: string }>;
}

export interface CloudPatchProposal {
  id: string;
  documentId: string;
  documentHash: string;
  issueId?: string;
  proposedBy: string;
  proposedByName: string;
  summary?: string;
  status: "pending" | "approved" | "rejected" | "applied";
  appliedHash?: string;
  proof: {
    status?: string;
    canWrite?: boolean;
    diff?: string;
    sourceMetrics?: { preservedPercent?: number };
  };
  createdAt: string;
}

export interface KnowledgeCitation {
  citation: number;
  documentId: string;
  documentTitle: string;
  blockId: string;
  versionHash: string;
  exactSource: string;
  sourceSpan: { line: number; endLine: number };
  confidence?: number;
  score: number;
  freshness: { state: "current" | "review_due" | "stale" };
}

export interface AskNomaResponse {
  state: "answered" | "insufficient_evidence";
  answer: string;
  confidence: { score: number; label: "low" | "medium" | "high" };
  citations: KnowledgeCitation[];
  conflicts: Array<{ concept: string; reason: string }>;
  mode?: "extractive" | "generative";
  ai?: { available: boolean; reason?: string };
  generation?: { model?: string; abstainedReason?: string; invalidCitations?: string[] };
}

export interface KnowledgeHealthItem {
  id: string;
  kind: string;
  severity: "info" | "warning" | "error";
  documentId?: string;
  blockId?: string;
  message: string;
}

export interface AgentInboxItem {
  id: string;
  documentId: string;
  plan: string[];
  affectedIds: string[];
  applyStatus: "awaiting_review" | "ready" | "rejected" | "applied";
  updatedAt: string;
}

export interface ScopedAgentSummary {
  id: string;
  name: string;
  status: "active" | "paused" | "revoked";
  modelPolicy: { model: string; zeroRetention: boolean };
  capabilities: string[];
  budgetUsd: number;
  spentUsd: number;
}

export interface LocalOfflineDraft {
  id?: string;
  userId: string;
  documentId: string;
  title: string;
  baseHash: string;
  baseSource: string;
  source: string;
  updatedAt: string;
}

export interface OfflineMergeResponse {
  state: "clean" | "merged" | "conflict";
  source: string;
  expectedHash: string;
  conflicts: Array<{ line: number; base: string; current: string; draft: string }>;
}

export interface CloudErrorPayload {
  error?: string;
  code?: string;
  currentHash?: string;
  currentUpdatedAt?: string;
}

export interface CloudSiteResponse {
  id: string;
  title: string;
  slug: string;
  documentIds: string[];
  folders?: string[];
  pageFolders?: Record<string, string>;
  pageParents?: Record<string, string>;
  createdAt: string;
  updatedAt: string;
  currentRole?: CloudRole;
  access?: AccessInfo;
  documents?: CloudDocumentResponse[];
}

export interface CloudShareResponse {
  id: string;
  role: Exclude<CloudRole, "owner">;
  token: string;
  url: string;
  artifactUrl: string;
}

export interface CloudCollaboratorGrant {
  userId: string;
  role: CloudRole;
  addedAt: string;
}

export interface CloudGroupGrant {
  groupId: string;
  groupName: string;
  role: Exclude<CloudRole, "owner">;
  addedAt: string;
}

export interface CloudShareGrant {
  id: string;
  role: Exclude<CloudRole, "owner">;
  label?: string;
  tokenPreview: string;
  revokedAt?: string;
}

export interface RenderState {
  doc: DocumentNode | null;
  diagnostics: Diagnostic[];
  llm: string;
  error?: Error;
}

export interface ContextMenuAction {
  label: string;
  hint?: string;
  disabled?: boolean;
  danger?: boolean;
  separatorBefore?: boolean;
  action: () => void | Promise<void>;
}

export interface WikiResolvedLink extends Wikilink {
  page?: CloudDocumentResponse;
  missing: boolean;
}
