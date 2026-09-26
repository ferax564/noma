/**
 * `/api/approvals` — one queue of everything waiting on the caller: agent page patches, AI-drafted
 * pages, page approval requests addressed to them, and deploy/test runs agents asked for.
 * `POST /api/approvals/runs/:id {decision}` decides a run; the other kinds link to their own review flows.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { type CloudServerConfig, isWorkspaceAdmin, type Principal, requireProjectAccess, requireUser, roleRank } from "./context.js";
import { decideRun } from "./devloop.js";
import { HttpError, readJsonBody, sendJson } from "./http.js";
import { stringPathPart } from "./input.js";
import { knowledgeDocuments } from "./routes-knowledge.js";

interface QueueItem {
  kind: "run" | "patch" | "page_proposal" | "page_approval";
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
  /** Whether the caller may decide it here (runs) — other kinds are reviewed where they live. */
  decidable: boolean;
}

export async function routeApprovals(req: IncomingMessage, res: ServerResponse, parts: string[], config: CloudServerConfig, principal: Principal): Promise<void> {
  const user = requireUser(principal);
  const method = req.method ?? "GET";
  if (!parts[2] && method === "GET") {
    const killSwitch = config.agentOps.killSwitch();
    sendJson(res, 200, { items: approvalQueue(config, user), paused: killSwitch.paused, ...(canAdminister(config, user) ? { killSwitch } : {}) });
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
    sendJson(res, 200, await decideRun(config, run, user, input.decision));
    return;
  }
  throw new HttpError(404, "Unknown approvals route");
}

function canAdminister(config: CloudServerConfig, user: NonNullable<Principal["user"]>): boolean {
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
      });
    }
  }
  return items.sort((left, right) => right.createdAt.localeCompare(left.createdAt)).slice(0, 200);
}
