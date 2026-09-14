export const ENTERPRISE_SCHEMA_VERSION = 3;

export type PrincipalKind = "user" | "agent" | "group" | "service";
export type ResourceKind =
  | "tenant"
  | "space"
  | "project"
  | "document"
  | "artifact"
  | "asset"
  | "issue"
  | "changeset"
  | "dataset";
export type LifecycleState = "draft" | "published" | "archived" | "trashed" | "quarantined";
export type Classification = "public" | "internal" | "confidential" | "restricted";
export type GrantRole = "viewer" | "editor" | "owner" | "reviewer" | "agent";
export type RelationType =
  | "supports"
  | "contradicts"
  | "implements"
  | "verifies"
  | "depends_on"
  | "supersedes"
  | "illustrates";

export type ChangesetStatus =
  | "draft"
  | "validated"
  | "proposed"
  | "approved"
  | "rejected"
  | "applied"
  | "failed"
  | "expired";

export type IssueHierarchyType = "epic" | "story" | "task" | "bug" | "subtask";
export type StatusCategory = "todo" | "in_progress" | "done";
export type SprintState = "planned" | "active" | "closed";
export type AssetScanState = "pending" | "clean" | "quarantined" | "blocked";
export type ConnectorMode = "read_only_mirror" | "linked_external" | "noma_native";
export type ImportDisposition = "imported" | "excluded" | "inaccessible" | "unsupported" | "quarantined";
export type FieldType = "text" | "number" | "date" | "boolean" | "select" | "multi_select" | "principal" | "reference";
export type OutboxKind = "search_index" | "notification" | "external_write";
export type JobStatus = "queued" | "running" | "succeeded" | "failed" | "cancelled" | "dead_letter";
export type CutoverStage =
  | "inventory"
  | "dry_run"
  | "staging"
  | "reconcile"
  | "pilot"
  | "catch_up"
  | "freeze"
  | "final_delta"
  | "sign_off"
  | "switch_authority"
  | "rollback_window";
export type KnowledgeHealthKind = "stale_review" | "changed_source" | "contradiction_candidate";
export const CUTOVER_STAGES: CutoverStage[] = [
  "inventory",
  "dry_run",
  "staging",
  "reconcile",
  "pilot",
  "catch_up",
  "freeze",
  "final_delta",
  "sign_off",
  "switch_authority",
  "rollback_window",
];
export const AGENT_RECIPES = [
  "stale-source-refresh",
  "changed-test-impact",
  "issue-to-runbook",
  "meeting-notes-to-decisions",
  "release-note-preparation",
  "orphaned-requirement-review",
] as const;
export type AgentRecipeName = (typeof AGENT_RECIPES)[number];

export interface ActorContext {
  tenantId: string;
  principalId: string;
  sessionId: string;
  kind: PrincipalKind;
}

export interface ResourceRef {
  kind: ResourceKind;
  id: string;
  blockId?: string;
  elementId?: string;
  revision?: number;
}

export interface Relationship {
  id: string;
  tenantId: string;
  from: ResourceRef;
  to: ResourceRef;
  relation: RelationType;
  assertedBy: string;
  authoritative: boolean;
  createdAt: string;
}

export interface ChangesetOperation {
  resource: ResourceRef;
  op: string;
  payload: Record<string, unknown>;
}

export interface ChangesetRecord {
  id: string;
  tenantId: string;
  actorId: string;
  actorKind: PrincipalKind;
  delegatedBy?: string;
  intent: string;
  status: ChangesetStatus;
  targetRevisions: Record<string, number>;
  sourceDependencies: Array<{ resource: ResourceRef; hash: string }>;
  operations: ChangesetOperation[];
  validation: { ok: boolean; errors: string[] };
  diffs: { text?: string; visual?: string };
  risk: "low" | "medium" | "high";
  reviewerIds: string[];
  idempotencyKey: string;
  issueOwnerOverride?: string;
  result?: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

export interface QueryAst {
  type: "and" | "or" | "eq" | "neq" | "in" | "contains";
  field?: string;
  value?: string | number | boolean | string[];
  clauses?: QueryAst[];
}

export interface OidcClaims {
  sub: string;
  email: string;
  name: string;
  groups?: string[];
}

export interface OidcAdapter {
  verify(idToken: string): OidcClaims;
}

export interface ScimUserInput {
  externalId: string;
  userName: string;
  active: boolean;
  groups?: string[];
}

export type EnterpriseErrorCode =
  | "unauthorized"
  | "forbidden"
  | "not_found"
  | "conflict"
  | "stale_revision"
  | "invalid"
  | "policy"
  | "quota"
  | "killed"
  | "self_approval";

export class EnterpriseError extends Error {
  readonly code: EnterpriseErrorCode;
  readonly details?: Record<string, unknown>;

  constructor(code: EnterpriseErrorCode, message: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "EnterpriseError";
    this.code = code;
    this.details = details;
  }
}
