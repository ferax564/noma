/**
 * `/api/approvals` — one queue of everything waiting on the caller: agent page patches, AI-drafted
 * pages, page approval requests addressed to them, deploy/test runs agents asked for, and propose-only
 * (bright-line) actions agents asked a person to perform. Agent items carry their capability class,
 * the sha256 their approval binds to, and their decision-log history.
 *
 * `POST /api/approvals/runs/:id {decision, payloadHash?, reason?}` decides a run;
 * `POST /api/approvals/actions/:id {decision, payloadHash?, reason?}` decides a propose-only action
 * (recorded only — nothing executes); `GET /api/approvals/capabilities` lists the registry;
 * `GET /api/approvals/history?siteId=` reads the decision log; `GET|PUT /api/approvals/trust/:siteId`
 * reads or sets a space's agent trust tier (space owners and workspace admins).
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { type CloudServerConfig, isWorkspaceAdmin, type Principal, requireProjectAccess, requireUser, roleRank } from "./context.js";
import { requireAgentsRunning } from "./agent-runner.js";
import { decideRun } from "./devloop.js";
import { HttpError, readJsonBody, sendJson } from "./http.js";
import { optionalString, stringPathPart } from "./input.js";
import { DEFAULT_TRUST_TIER, listCapabilities, TRUST_TIER_LABELS, trustTierInput } from "./capabilities.js";
import { actionProposalPayload, agentTrustTier, governanceSummary, pageProposalPayload, patchPayload, patchProposalAgentId, recordAgentDecision, runKind, runPayload } from "./governance.js";
import { requireScope } from "./security.js";
import { knowledgeDocuments } from "./routes-knowledge.js";

interface QueueItem {
  kind: "run" | "patch" | "page_proposal" | "page_approval" | "action";
  id: string;
  title: string;
  detail: string;
  requestedBy: string;
  requestedByName: string;
  agentId?: string;
  agentName?: string;
  siteId?: string;
  documentId?: string;
  projectId?: string;
  createdAt: string;
  /** Whether the caller may decide it here (runs, actions) — other kinds are reviewed where they live. */
  decidable: boolean;
  /** Agent governance: action kind, capability class, bound payload hash, and decision-log history. */
  governance?: Record<string, unknown>;
  /** Bright-line proposals: the full payload the reviewer is asked to act on (bound by `governance.payloadHash`). */
  payload?: Record<string, unknown>;
}

export async function routeApprovals(req: IncomingMessage, res: ServerResponse, parts: string[], config: CloudServerConfig, principal: Principal): Promise<void> {
  const user = requireUser(principal);
  const method = req.method ?? "GET";
  if (!parts[2] && method === "GET") {
    const killSwitch = config.agentOps.killSwitch();
    sendJson(res, 200, { items: approvalQueue(config, user), paused: killSwitch.paused, ...(canAdminister(config, principal, user) ? { killSwitch } : {}) });
    return;
  }
  if (parts[2] === "runs" && parts[3] && method === "POST") {
    const run = config.devloop.readRun(stringPathPart(parts[3], "Run ID"));
    if (!run) throw new HttpError(404, "Run not found");
    const project = config.store.readProject(run.projectId);
    const repo = project ? config.devloop.readRepo(project.id) : undefined;
    if (!project || !repo) throw new HttpError(404, "Run not found");
    const access = requireProjectAccess(config, project, principal, "viewer");
    if (roleRank[access.role] < roleRank[repo.minRole]) throw new HttpError(403, `${repo.minRole} access is required`);
    const input = await readJsonBody(req, config.maxBodyBytes);
    if (input.decision !== "approve" && input.decision !== "reject") throw new HttpError(400, "decision must be approve or reject");
    if (input.decision === "approve" && run.agentId) requireAgentsRunning(config);
    const reason = optionalString(input.reason);
    const payloadHash = optionalString(input.payloadHash);
    sendJson(res, 200, await decideRun(config, run, user, input.decision, { ...(reason ? { reason } : {}), ...(payloadHash ? { payloadHash } : {}) }));
    return;
  }
  if (parts[2] === "actions" && parts[3] && method === "POST") {
    const proposal = config.governance.readActionProposal(stringPathPart(parts[3], "Action proposal ID"));
    if (!proposal) throw new HttpError(404, "Action proposal not found");
    const role = config.store.resourceAccess(user.id, "site", proposal.siteId)?.role;
    if (!role || roleRank[role] < roleRank.owner) throw new HttpError(403, "owner access to the space is required");
    const input = await readJsonBody(req, config.maxBodyBytes);
    const decision = input.decision === "approve" ? "approved" : input.decision === "reject" ? "rejected" : input.decision === "revise" ? "revision_requested" : undefined;
    if (!decision) throw new HttpError(400, "decision must be approve, reject, or revise");
    if (proposal.status !== "pending") throw new HttpError(409, "The action proposal was already decided");
    if (decision === "approved" && proposal.proposedBy === user.id) throw new HttpError(409, "A different person must approve an action your agent proposed");
    const reason = optionalString(input.reason);
    const payloadHash = optionalString(input.payloadHash);
    const recorded = recordAgentDecision(config, {
      subject: { type: "action", id: proposal.id },
      kind: proposal.kind,
      decision,
      decidedBy: user.id,
      payload: actionProposalPayload(proposal),
      ...(reason ? { reason } : {}),
      ...(payloadHash ? { expectedHash: payloadHash } : {}),
      siteId: proposal.siteId,
      agentId: proposal.agentId,
    });
    const settled = config.governance.settleActionProposal(proposal.id, decision, recorded.decidedAt);
    if (!settled) throw new HttpError(409, "The action proposal was already decided");
    sendJson(res, 200, {
      proposal: settled,
      decision: recorded,
      executed: false,
      note: "Propose-only actions are never executed by an agent or by Noma on its behalf; a person performs them by hand.",
    });
    return;
  }
  if (parts[2] === "capabilities" && !parts[3] && method === "GET") {
    sendJson(res, 200, { capabilities: listCapabilities(), tiers: TRUST_TIER_LABELS, defaultTier: DEFAULT_TRUST_TIER });
    return;
  }
  if (parts[2] === "history" && !parts[3] && method === "GET") {
    const url = new URL(req.url ?? "/", "http://noma.local");
    const siteId = optionalString(url.searchParams.get("siteId"));
    const visible = config.store.listSites(user).map((site) => site.id);
    const siteIds = siteId ? visible.filter((id) => id === siteId) : visible;
    if (siteId && siteIds.length === 0) throw new HttpError(404, "Space not found");
    sendJson(res, 200, { decisions: config.governance.recentDecisions(siteIds, 200) });
    return;
  }
  if (parts[2] === "trust" && parts[3] && (method === "GET" || method === "PUT")) {
    const siteId = stringPathPart(parts[3], "Space ID");
    const role = config.store.resourceAccess(user.id, "site", siteId)?.role;
    if (!role) throw new HttpError(404, "Space not found");
    if (method === "PUT") {
      if (role !== "owner" && !canAdminister(config, principal, user)) throw new HttpError(403, "Only space owners and workspace admins can change the agent trust tier");
      requireScope(principal, "admin");
      const input = await readJsonBody(req, config.maxBodyBytes);
      const tier = trustTierInput(input.tier);
      if (tier === undefined) throw new HttpError(400, "tier must be 0 (read-only), 1 (propose content), 2 (run tests), or 3 (run deploys)");
      const previous = agentTrustTier(config, siteId);
      const now = config.now().toISOString();
      config.governance.writeTrust({ siteId, tier, updatedBy: user.id, updatedAt: now });
      config.platform.recordAudit(user.id, "agent.trust_changed", "site", siteId, { from: previous, to: tier }, now);
    }
    const setting = config.governance.readTrust(siteId);
    sendJson(res, 200, { siteId, tier: setting?.tier ?? DEFAULT_TRUST_TIER, label: TRUST_TIER_LABELS[setting?.tier ?? DEFAULT_TRUST_TIER], configured: Boolean(setting), ...(setting ? { updatedBy: setting.updatedBy, updatedAt: setting.updatedAt } : {}) });
    return;
  }
  throw new HttpError(404, "Unknown approvals route");
}

/** Workspace admins whose credential also carries the `admin` scope that `/api/enterprise` requires. */
function canAdminister(config: CloudServerConfig, principal: Principal, user: NonNullable<Principal["user"]>): boolean {
  if (principal.auth && !principal.auth.scopes.includes("admin")) return false;
  try {
    return isWorkspaceAdmin(config, user);
  } catch {
    return false;
  }
}

function approvalQueue(config: CloudServerConfig, user: NonNullable<Principal["user"]>): QueueItem[] {
  const userName = (id: string) => config.store.readUser(id)?.name ?? id;
  const agentName = (id: string) => config.platform.readAgent(id)?.name ?? id;
  const items: QueueItem[] = [];

  const projects = config.store.listProjects(user).filter((project) => {
    const repo = config.devloop.readRepo(project.id);
    const role = config.store.resourceAccess(user.id, "site", project.siteId)?.role;
    return repo && role && roleRank[role] >= roleRank[repo.minRole];
  });
  for (const run of config.devloop.listPendingApprovals(projects.map((project) => project.id))) {
    const project = projects.find((item) => item.id === run.projectId);
    items.push({
      kind: "run",
      id: run.id,
      title: `${run.kind === "deploy" ? "Deploy" : "Test"} ${run.ref}`,
      detail: `${project?.key ?? ""} · asked by ${run.agentId ? agentName(run.agentId) : userName(run.requestedBy)}`,
      requestedBy: run.requestedBy,
      requestedByName: userName(run.requestedBy),
      ...(run.agentId ? { agentId: run.agentId, agentName: agentName(run.agentId) } : {}),
      ...(project ? { siteId: project.siteId, projectId: project.id } : {}),
      createdAt: run.createdAt,
      decidable: run.requestedBy !== user.id,
      ...(run.agentId ? { governance: governanceSummary(config, runKind(run), { type: "run", id: run.id }, runPayload(run, config.devloop.readRepo(run.projectId)!)) } : {}),
    });
  }

  const documents = knowledgeDocuments(config, user).filter((item) => roleRank[item.role] >= roleRank.editor);
  for (const { document } of documents) {
    for (const proposal of config.store.listPatchProposals(document.id)) {
      if (proposal.status !== "pending" || proposal.proposedBy === user.id) continue;
      items.push({
        kind: "patch",
        id: proposal.id,
        title: proposal.summary ?? `Patch to ${document.title}`,
        detail: `${document.title} · ${proposal.ops.length} change${proposal.ops.length === 1 ? "" : "s"}`,
        requestedBy: proposal.proposedBy,
        requestedByName: proposal.proposedByName,
        documentId: document.id,
        createdAt: proposal.createdAt,
        decidable: false,
        ...(patchProposalAgentId(proposal) ? { agentId: patchProposalAgentId(proposal)!, agentName: agentName(patchProposalAgentId(proposal)!) } : {}),
        governance: governanceSummary(config, "page.patch", { type: "patch", id: proposal.id }, patchPayload(proposal)),
      });
    }
    for (const approval of config.store.listApprovals(document.id)) {
      if (approval.status !== "pending" || approval.reviewerId !== user.id) continue;
      items.push({
        kind: "page_approval",
        id: approval.id,
        title: `Approve ${document.title}`,
        detail: approval.note ?? "Page approval requested",
        requestedBy: approval.requestedBy,
        requestedByName: userName(approval.requestedBy),
        documentId: document.id,
        createdAt: approval.createdAt,
        decidable: false,
      });
    }
  }

  for (const site of config.store.listSites(user)) {
    const role = config.store.resourceAccess(user.id, "site", site.id)?.role;
    if (!role || roleRank[role] < roleRank.editor) continue;
    for (const proposal of config.store.listAiPageProposals(site.id)) {
      if (proposal.status !== "pending" || proposal.proposedBy === user.id) continue;
      items.push({
        kind: "page_proposal",
        id: proposal.id,
        title: `New page: ${proposal.title}`,
        detail: `${site.title} · drafted by ${agentName(proposal.agentId)}`,
        requestedBy: proposal.proposedBy,
        requestedByName: userName(proposal.proposedBy),
        agentId: proposal.agentId,
        agentName: agentName(proposal.agentId),
        siteId: site.id,
        createdAt: proposal.createdAt,
        decidable: false,
        governance: governanceSummary(config, "page.create", { type: "page_proposal", id: proposal.id }, pageProposalPayload(proposal)),
      });
    }
  }
  const editorSites = config.store.listSites(user).filter((site) => {
    const role = config.store.resourceAccess(user.id, "site", site.id)?.role;
    return role && roleRank[role] >= roleRank.editor;
  });
  for (const proposal of config.governance.listPendingActionProposals(editorSites.map((site) => site.id))) {
    const site = editorSites.find((item) => item.id === proposal.siteId);
    const role = config.store.resourceAccess(user.id, "site", proposal.siteId)?.role;
    items.push({
      kind: "action",
      id: proposal.id,
      title: `Bright line: ${proposal.kind}`,
      detail: `${site?.title ?? ""} · proposed by ${agentName(proposal.agentId)} · ${proposal.reason}`.slice(0, 500),
      requestedBy: proposal.proposedBy,
      requestedByName: userName(proposal.proposedBy),
      agentId: proposal.agentId,
      agentName: agentName(proposal.agentId),
      siteId: proposal.siteId,
      createdAt: proposal.createdAt,
      decidable: role === "owner" && proposal.proposedBy !== user.id,
      governance: governanceSummary(config, proposal.kind, { type: "action", id: proposal.id }, actionProposalPayload(proposal)),
      payload: proposal.payload,
    });
  }
  return items.sort((left, right) => right.createdAt.localeCompare(left.createdAt)).slice(0, 200);
}
