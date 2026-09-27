/**
 * The agent governance gate — the one chokepoint every agent-initiated action goes through before it
 * is proposed or executed (ported from keepop's executor). Checks, deny by default:
 *
 *   ┌─ unregistered kind?                    → deny (action_unregistered)
 *   ├─ agent below the space's trust tier?   → deny (agent_tier_too_low)
 *   ├─ execute a propose_only kind?          → deny ALWAYS, even with an approval (bright_line_propose_only)
 *   ├─ execute approve_to_execute without a  → deny (approval_required)
 *   │   decision or allowed standing policy?
 *   ├─ approved payload hash ≠ this payload? → deny (payload_hash_mismatch)
 *   └─ else                                  → allow
 *
 * Every allow and deny is written to the audit log (`agent.gate.allowed` / `agent.gate.denied`), which
 * the SIEM forwarder ships. Human decisions go to the append-only decision log via `recordAgentDecision`.
 */
import type { AgentActionProposal, AgentDecision, DecisionSubjectType, DecisionValue } from "../cloud-governance.js";
import type { CloudAiPageProposal, CloudPatchProposal } from "../cloud-db.js";
import type { DevRepo, DevRun } from "../cloud-devloop.js";
import { sha256Hex } from "../hash.js";
import { type ActionCapability, type AgentTrustTier, canonicalJson, DEFAULT_TRUST_TIER, lookupCapability, TRUST_TIER_LABELS } from "./capabilities.js";
import { type CloudServerConfig, randomId } from "./context.js";
import { HttpError } from "./http.js";

export interface GateRequest {
  kind: string;
  /** `propose` queues the action for a person; `execute` performs it. */
  phase: "propose" | "execute";
  /** The person on whose behalf the call runs (the agent's owner, or the reviewer executing it). */
  actorId: string;
  /** Set when an agent initiated the action; tiers only bind agents. */
  agentId?: string;
  /** Spaces the action touches; the most restrictive trust tier applies. */
  siteIds?: string[];
  /** The exact payload that will run; its canonical sha256 must match the approved one. */
  payload: unknown;
  /** The approvable record whose decisions authorize execution. */
  subject?: { type: DecisionSubjectType; id: string };
  /** A human policy standing in for a per-action approval (see `ActionCapability.standingPolicy`). */
  standing?: string;
}

export interface GateResult {
  kind: string;
  capabilityClass: ActionCapability["capabilityClass"];
  payloadHash: string;
  tier: AgentTrustTier;
  decisionId?: string;
}

/** sha256 of the canonical JSON of `payload` — what an approval binds to. */
export function payloadHash(payload: unknown): string {
  return sha256Hex(canonicalJson(payload));
}

/** The space's agent trust tier (default 3 — everything agents could do before tiers existed). */
export function agentTrustTier(config: CloudServerConfig, siteId: string | undefined): AgentTrustTier {
  return siteId ? config.governance.readTrust(siteId)?.tier ?? DEFAULT_TRUST_TIER : DEFAULT_TRUST_TIER;
}

function effectiveTier(config: CloudServerConfig, siteIds: string[]): AgentTrustTier {
  return siteIds.reduce<AgentTrustTier>((lowest, siteId) => Math.min(lowest, agentTrustTier(config, siteId)) as AgentTrustTier, DEFAULT_TRUST_TIER);
}

/** Runs `request` through the gate; throws a 403/409 `HttpError` with a `code` on denial. */
export function governAgentAction(config: CloudServerConfig, request: GateRequest): GateResult {
  const siteIds = [...new Set(request.siteIds ?? [])];
  const hash = payloadHash(request.payload);
  const tier = effectiveTier(config, siteIds);
  const meta = lookupCapability(request.kind);
  const base = { kind: request.kind, phase: request.phase, payloadHash: hash, tier, ...(request.agentId ? { agentId: request.agentId } : {}), ...(request.subject ? { subjectType: request.subject.type, subjectId: request.subject.id } : {}) };
  const deny = (status: number, code: string, message: string, extra: Record<string, unknown> = {}): never => {
    audit(config, request.actorId, "agent.gate.denied", siteIds, { ...base, ...(meta ? { capabilityClass: meta.capabilityClass } : {}), code, reason: message, ...extra });
    throw new HttpError(status, message, { code, kind: request.kind, ...(meta ? { capabilityClass: meta.capabilityClass } : {}), payloadHash: hash, ...extra });
  };
  if (!meta) return deny(403, "action_unregistered", `Agent action ${request.kind} is not registered, so it is denied`);
  if (request.agentId && tier < meta.minTier) {
    return deny(403, "agent_tier_too_low", `This space's agent trust tier is ${tier} (${TRUST_TIER_LABELS[tier]}); ${request.kind} needs tier ${meta.minTier} (${TRUST_TIER_LABELS[meta.minTier]})`, { requiredTier: meta.minTier });
  }
  let decisionId: string | undefined;
  let standing: string | undefined;
  if (request.phase === "execute") {
    if (meta.capabilityClass === "propose_only") {
      return deny(403, "bright_line_propose_only", `${request.kind} is a bright line: agents may propose it, but a person must perform it by hand`);
    }
    if (meta.capabilityClass === "approve_to_execute") {
      if (request.standing !== undefined && (!request.agentId || meta.standingPolicy)) {
        standing = request.standing;
      } else if (request.subject) {
        const decision = config.governance.latestDecision(request.subject.type, request.subject.id);
        if (!decision || decision.decision !== "approved") return deny(403, "approval_required", `${request.kind} needs a person's approval before it runs`, decision ? { decision: decision.decision } : {});
        if (decision.payloadHash !== hash) {
          return deny(409, "payload_hash_mismatch", `The ${request.kind} payload changed after it was approved; it must be approved again`, { approvedHash: decision.payloadHash, decisionId: decision.id });
        }
        decisionId = decision.id;
      } else {
        return deny(403, "approval_required", `${request.kind} needs a person's approval before it runs`);
      }
    }
  }
  audit(config, request.actorId, "agent.gate.allowed", siteIds, { ...base, capabilityClass: meta.capabilityClass, ...(decisionId ? { decisionId } : {}), ...(standing ? { standing } : {}) });
  return { kind: request.kind, capabilityClass: meta.capabilityClass, payloadHash: hash, tier, ...(decisionId ? { decisionId } : {}) };
}

export interface DecisionInput {
  subject: { type: DecisionSubjectType; id: string };
  kind: string;
  decision: DecisionValue;
  decidedBy: string;
  payload: unknown;
  reason?: string;
  siteId?: string;
  agentId?: string;
  source?: AgentDecision["source"];
  decidedAt?: string;
  /** The hash the person saw when deciding; a mismatch means the payload changed under them (409). */
  expectedHash?: string;
}

/** Appends a human decision, bound to the payload's hash, to the decision log and the audit log. */
export function recordAgentDecision(config: CloudServerConfig, input: DecisionInput): AgentDecision {
  const meta = lookupCapability(input.kind);
  if (!meta) throw new HttpError(403, `Agent action ${input.kind} is not registered`, { code: "action_unregistered", kind: input.kind });
  const hash = payloadHash(input.payload);
  if (input.expectedHash !== undefined && input.expectedHash !== hash) {
    throw new HttpError(409, "The payload changed since you looked at it; review it again", { code: "payload_hash_mismatch", kind: input.kind, payloadHash: hash, expectedHash: input.expectedHash });
  }
  const decision = config.governance.appendDecision({
    id: randomId(),
    subjectType: input.subject.type,
    subjectId: input.subject.id,
    actionKind: input.kind,
    capabilityClass: meta.capabilityClass,
    decision: input.decision,
    decidedBy: input.decidedBy,
    decidedAt: input.decidedAt ?? config.now().toISOString(),
    payloadHash: hash,
    ...(input.reason ? { reason: input.reason.slice(0, 2_000) } : {}),
    ...(input.siteId ? { siteId: input.siteId } : {}),
    ...(input.agentId ? { agentId: input.agentId } : {}),
    source: input.source ?? "decision",
  });
  audit(config, input.decidedBy, "agent.decision.recorded", input.siteId ? [input.siteId] : [], {
    decisionId: decision.id,
    kind: decision.actionKind,
    capabilityClass: decision.capabilityClass,
    decision: decision.decision,
    subjectType: decision.subjectType,
    subjectId: decision.subjectId,
    payloadHash: decision.payloadHash,
    source: decision.source,
    ...(decision.agentId ? { agentId: decision.agentId } : {}),
  });
  return decision;
}

function audit(config: CloudServerConfig, actorId: string, action: string, siteIds: string[], detail: Record<string, unknown>): void {
  const siteId = siteIds[0];
  config.platform.recordAudit(actorId, action, siteId ? "site" : "workspace", siteId ?? "workspace", { gateId: randomId(), ...detail }, config.now().toISOString());
}

// canonical payloads — what each approval binds to

/** The agent (or built-in AI agent) that drafted a patch proposal, when one did. */
export function patchProposalAgentId(proposal: Pick<CloudPatchProposal, "proof">): string | undefined {
  const agentId = proposal.proof.agentId;
  return typeof agentId === "string" && agentId ? agentId : undefined;
}

export function patchPayload(proposal: Pick<CloudPatchProposal, "documentId" | "documentHash" | "ops">): Record<string, unknown> {
  return { kind: "page.patch", documentId: proposal.documentId, documentHash: proposal.documentHash, ops: proposal.ops };
}

export function pageProposalPayload(proposal: Pick<CloudAiPageProposal, "siteId" | "parentId" | "title" | "source">): Record<string, unknown> {
  return { kind: "page.create", siteId: proposal.siteId, parentId: proposal.parentId ?? null, title: proposal.title, sourceHash: sha256Hex(proposal.source) };
}

export function runKind(run: Pick<DevRun, "kind">): "run.deploy" | "run.test" {
  return run.kind === "deploy" ? "run.deploy" : "run.test";
}

/** A run's payload includes the linked repository, so relinking the project after approval voids the approval. */
export function runPayload(run: Pick<DevRun, "kind" | "projectId" | "ref" | "appName">, repo: Pick<DevRepo, "repo">): Record<string, unknown> {
  return { kind: runKind(run), projectId: run.projectId, repo: repo.repo, ref: run.ref, appName: run.appName };
}

export function actionProposalPayload(proposal: Pick<AgentActionProposal, "kind" | "siteId" | "payload">): Record<string, unknown> {
  return { kind: proposal.kind, siteId: proposal.siteId, payload: proposal.payload };
}

/** The decision history and hash binding shown next to an approvable item. */
export function governanceSummary(config: CloudServerConfig, kind: string, subject: { type: DecisionSubjectType; id: string }, payload: unknown): Record<string, unknown> {
  return {
    actionKind: kind,
    capabilityClass: lookupCapability(kind)?.capabilityClass ?? "unregistered",
    payloadHash: payloadHash(payload),
    history: config.governance.listDecisions(subject.type, subject.id),
  };
}

/**
 * Carries approval state that predates the decision log into it: every approved-but-unapplied patch
 * or AI page proposal gets a `migrated` decision bound to its current payload, so it stays applicable.
 * Runs need nothing — an approved run started in the same request. Idempotent.
 */
export function migrateLegacyApprovals(config: CloudServerConfig): number {
  let migrated = 0;
  for (const id of config.governance.legacyApprovedIds("patch_proposals")) {
    if (config.governance.latestDecision("patch", id)) continue;
    const proposal = config.store.readPatchProposal(id);
    if (!proposal || proposal.status !== "approved") continue;
    const agentId = patchProposalAgentId(proposal);
    const siteId = config.store.documentSiteIds(proposal.documentId)[0];
    recordAgentDecision(config, {
      subject: { type: "patch", id },
      kind: "page.patch",
      decision: "approved",
      decidedBy: proposal.reviewedBy ?? proposal.proposedBy,
      payload: patchPayload(proposal),
      reason: "Migrated from approval state recorded before the decision log",
      ...(siteId ? { siteId } : {}),
      ...(agentId ? { agentId } : {}),
      source: "migrated",
      ...(proposal.reviewedAt ? { decidedAt: proposal.reviewedAt } : {}),
    });
    migrated += 1;
  }
  for (const id of config.governance.legacyApprovedIds("ai_page_proposals")) {
    if (config.governance.latestDecision("page_proposal", id)) continue;
    const proposal = config.store.readAiPageProposal(id);
    if (!proposal || proposal.status !== "approved") continue;
    recordAgentDecision(config, {
      subject: { type: "page_proposal", id },
      kind: "page.create",
      decision: "approved",
      decidedBy: proposal.reviewedBy ?? proposal.proposedBy,
      payload: pageProposalPayload(proposal),
      reason: "Migrated from approval state recorded before the decision log",
      siteId: proposal.siteId,
      agentId: proposal.agentId,
      source: "migrated",
      ...(proposal.reviewedAt ? { decidedAt: proposal.reviewedAt } : {}),
    });
    migrated += 1;
  }
  return migrated;
}
