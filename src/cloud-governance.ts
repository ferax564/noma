/**
 * Agent governance persistence for Noma Cloud: the append-only decision log (every human approval,
 * rejection, or revision request on an agent-initiated action, bound to the sha256 of the payload it
 * covers), per-space agent trust tiers, and propose-only action proposals. Shares the Cloud SQLite
 * file through its own connection. The decision log mirrors keepop's `operator_approvals`: SQLite
 * triggers abort any UPDATE or DELETE, so a decision can be superseded by a later row but never
 * rewritten or erased.
 */
import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import DatabaseConstructor from "better-sqlite3";
import type { AgentTrustTier, CapabilityClass } from "./cloud/capabilities.js";

type SqliteDatabase = InstanceType<typeof DatabaseConstructor>;

export type DecisionSubjectType = "patch" | "page_proposal" | "run" | "action";
export type DecisionValue = "approved" | "rejected" | "revision_requested";

export interface AgentDecision {
  seq: number;
  id: string;
  subjectType: DecisionSubjectType;
  subjectId: string;
  actionKind: string;
  capabilityClass: CapabilityClass;
  decision: DecisionValue;
  decidedBy: string;
  decidedAt: string;
  payloadHash: string;
  reason?: string;
  siteId?: string;
  agentId?: string;
  /** `migrated` rows were carried over from approval state that predates the log. */
  source: "decision" | "migrated";
}

export interface AgentTrustSetting {
  siteId: string;
  tier: AgentTrustTier;
  updatedBy: string;
  updatedAt: string;
}

export type ActionProposalStatus = "pending" | DecisionValue;

/** A bright-line action an agent asked a person to perform. The gate never executes it. */
export interface AgentActionProposal {
  id: string;
  siteId: string;
  agentId: string;
  kind: string;
  payload: Record<string, unknown>;
  payloadHash: string;
  reason: string;
  proposedBy: string;
  status: ActionProposalStatus;
  createdAt: string;
  updatedAt: string;
}

interface DecisionRow {
  seq: number;
  id: string;
  subject_type: DecisionSubjectType;
  subject_id: string;
  action_kind: string;
  capability_class: CapabilityClass;
  decision: DecisionValue;
  decided_by: string;
  decided_at: string;
  payload_hash: string;
  reason: string | null;
  site_id: string | null;
  agent_id: string | null;
  source: "decision" | "migrated";
}

interface ActionProposalRow {
  id: string;
  site_id: string;
  agent_id: string;
  kind: string;
  payload_json: string;
  payload_hash: string;
  reason: string;
  proposed_by: string;
  status: ActionProposalStatus;
  created_at: string;
  updated_at: string;
}

export class CloudGovernanceStore {
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

  // decision log (append-only)

  appendDecision(decision: Omit<AgentDecision, "seq">): AgentDecision {
    this.db
      .prepare(
        `INSERT INTO agent_decisions (id, subject_type, subject_id, action_kind, capability_class, decision, decided_by, decided_at, payload_hash, reason, site_id, agent_id, source)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        decision.id,
        decision.subjectType,
        decision.subjectId,
        decision.actionKind,
        decision.capabilityClass,
        decision.decision,
        decision.decidedBy,
        decision.decidedAt,
        decision.payloadHash,
        decision.reason ?? null,
        decision.siteId ?? null,
        decision.agentId ?? null,
        decision.source,
      );
    return this.readDecision(decision.id)!;
  }

  readDecision(id: string): AgentDecision | undefined {
    const row = this.db.prepare("SELECT * FROM agent_decisions WHERE id = ?").get(id) as DecisionRow | undefined;
    return row ? decisionFromRow(row) : undefined;
  }

  /** Every decision on one subject, oldest first. */
  listDecisions(subjectType: DecisionSubjectType, subjectId: string): AgentDecision[] {
    return (this.db.prepare("SELECT * FROM agent_decisions WHERE subject_type = ? AND subject_id = ? ORDER BY seq").all(subjectType, subjectId) as DecisionRow[]).map(decisionFromRow);
  }

  /** The decision in force for a subject: the most recent one. */
  latestDecision(subjectType: DecisionSubjectType, subjectId: string): AgentDecision | undefined {
    const row = this.db.prepare("SELECT * FROM agent_decisions WHERE subject_type = ? AND subject_id = ? ORDER BY seq DESC LIMIT 1").get(subjectType, subjectId) as DecisionRow | undefined;
    return row ? decisionFromRow(row) : undefined;
  }

  /** Most recent decisions in the given spaces, newest first. */
  recentDecisions(siteIds: string[], limit = 100): AgentDecision[] {
    if (siteIds.length === 0) return [];
    return (
      this.db.prepare("SELECT * FROM agent_decisions WHERE site_id IN (SELECT value FROM json_each(?)) ORDER BY seq DESC LIMIT ?").all(JSON.stringify(siteIds), limit) as DecisionRow[]
    ).map(decisionFromRow);
  }

  /** IDs of legacy approved-but-unapplied proposals in `table` (`patch_proposals` or `ai_page_proposals`), when that table exists. */
  legacyApprovedIds(table: "patch_proposals" | "ai_page_proposals"): string[] {
    const exists = this.db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
    if (!exists) return [];
    return (this.db.prepare(`SELECT id FROM ${table} WHERE status = 'approved'`).all() as Array<{ id: string }>).map((row) => row.id);
  }

  // trust tiers

  readTrust(siteId: string): AgentTrustSetting | undefined {
    const row = this.db.prepare("SELECT * FROM agent_trust_tiers WHERE site_id = ?").get(siteId) as { site_id: string; tier: AgentTrustTier; updated_by: string; updated_at: string } | undefined;
    return row ? { siteId: row.site_id, tier: row.tier, updatedBy: row.updated_by, updatedAt: row.updated_at } : undefined;
  }

  writeTrust(setting: AgentTrustSetting): AgentTrustSetting {
    this.db
      .prepare("INSERT INTO agent_trust_tiers (site_id, tier, updated_by, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(site_id) DO UPDATE SET tier = excluded.tier, updated_by = excluded.updated_by, updated_at = excluded.updated_at")
      .run(setting.siteId, setting.tier, setting.updatedBy, setting.updatedAt);
    return this.readTrust(setting.siteId)!;
  }

  // propose-only action proposals

  insertActionProposal(proposal: AgentActionProposal): AgentActionProposal {
    this.db
      .prepare(
        `INSERT INTO agent_action_proposals (id, site_id, agent_id, kind, payload_json, payload_hash, reason, proposed_by, status, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(proposal.id, proposal.siteId, proposal.agentId, proposal.kind, JSON.stringify(proposal.payload), proposal.payloadHash, proposal.reason, proposal.proposedBy, proposal.status, proposal.createdAt, proposal.updatedAt);
    return this.readActionProposal(proposal.id)!;
  }

  readActionProposal(id: string): AgentActionProposal | undefined {
    const row = this.db.prepare("SELECT * FROM agent_action_proposals WHERE id = ?").get(id) as ActionProposalRow | undefined;
    return row ? actionProposalFromRow(row) : undefined;
  }

  /** Moves a pending proposal to its decided status; undefined when it was already decided. */
  settleActionProposal(id: string, status: DecisionValue, at: string): AgentActionProposal | undefined {
    const changed = this.db.prepare("UPDATE agent_action_proposals SET status = ?, updated_at = ? WHERE id = ? AND status = 'pending'").run(status, at, id).changes;
    return changed ? this.readActionProposal(id) : undefined;
  }

  listPendingActionProposals(siteIds: string[], limit = 200): AgentActionProposal[] {
    if (siteIds.length === 0) return [];
    return (
      this.db
        .prepare("SELECT * FROM agent_action_proposals WHERE status = 'pending' AND site_id IN (SELECT value FROM json_each(?)) ORDER BY created_at DESC LIMIT ?")
        .all(JSON.stringify(siteIds), limit) as ActionProposalRow[]
    ).map(actionProposalFromRow);
  }

  private applySchema(): void {
    this.db.exec(`
      CREATE TABLE IF NOT EXISTS agent_decisions (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        subject_type TEXT NOT NULL CHECK (subject_type IN ('patch', 'page_proposal', 'run', 'action')),
        subject_id TEXT NOT NULL,
        action_kind TEXT NOT NULL,
        capability_class TEXT NOT NULL CHECK (capability_class IN ('read_only', 'approve_to_execute', 'propose_only')),
        decision TEXT NOT NULL CHECK (decision IN ('approved', 'rejected', 'revision_requested')),
        decided_by TEXT NOT NULL,
        decided_at TEXT NOT NULL,
        payload_hash TEXT NOT NULL,
        reason TEXT,
        site_id TEXT,
        agent_id TEXT,
        source TEXT NOT NULL DEFAULT 'decision' CHECK (source IN ('decision', 'migrated'))
      );
      CREATE INDEX IF NOT EXISTS agent_decisions_subject ON agent_decisions (subject_type, subject_id, seq);
      CREATE INDEX IF NOT EXISTS agent_decisions_site ON agent_decisions (site_id, seq);
      CREATE TRIGGER IF NOT EXISTS agent_decisions_no_update
        BEFORE UPDATE ON agent_decisions
      BEGIN
        SELECT RAISE(ABORT, 'agent_decisions is append-only');
      END;
      CREATE TRIGGER IF NOT EXISTS agent_decisions_no_delete
        BEFORE DELETE ON agent_decisions
      BEGIN
        SELECT RAISE(ABORT, 'agent_decisions is append-only');
      END;
      CREATE TABLE IF NOT EXISTS agent_trust_tiers (
        site_id TEXT PRIMARY KEY,
        tier INTEGER NOT NULL CHECK (tier BETWEEN 0 AND 3),
        updated_by TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS agent_action_proposals (
        id TEXT PRIMARY KEY,
        site_id TEXT NOT NULL,
        agent_id TEXT NOT NULL,
        kind TEXT NOT NULL,
        payload_json TEXT NOT NULL,
        payload_hash TEXT NOT NULL,
        reason TEXT NOT NULL,
        proposed_by TEXT NOT NULL,
        status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected', 'revision_requested')),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS agent_action_proposals_site ON agent_action_proposals (site_id, status, created_at);
    `);
  }
}

function decisionFromRow(row: DecisionRow): AgentDecision {
  return {
    seq: row.seq,
    id: row.id,
    subjectType: row.subject_type,
    subjectId: row.subject_id,
    actionKind: row.action_kind,
    capabilityClass: row.capability_class,
    decision: row.decision,
    decidedBy: row.decided_by,
    decidedAt: row.decided_at,
    payloadHash: row.payload_hash,
    ...(row.reason ? { reason: row.reason } : {}),
    ...(row.site_id ? { siteId: row.site_id } : {}),
    ...(row.agent_id ? { agentId: row.agent_id } : {}),
    source: row.source,
  };
}

function actionProposalFromRow(row: ActionProposalRow): AgentActionProposal {
  return {
    id: row.id,
    siteId: row.site_id,
    agentId: row.agent_id,
    kind: row.kind,
    payload: JSON.parse(row.payload_json) as Record<string, unknown>,
    payloadHash: row.payload_hash,
    reason: row.reason,
    proposedBy: row.proposed_by,
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}
