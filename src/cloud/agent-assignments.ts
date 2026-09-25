/**
 * Agents as teammates. A person hands work to an agent the same way they hand it to a colleague:
 * an `@{agentId}` mention in a comment, or a page task assigned to the agent
 * (`- [ ] Refresh the numbers @{agentId}`). Each hand-off becomes an `AgentAssignment` in the
 * agent's inbox. The agent's owner (or its MCP client) reads the inbox through the gateway, replies
 * in the comment thread as the agent, links the patch proposals it opens, and reports a status.
 * Agents never write pages directly: edits still go through proof → human approval → apply.
 *
 * An agent is assignable on a page only while it is active, holds a page or space grant covering
 * the page, and its owner can still open the page. Comments written by agents never create
 * assignments, so two agents cannot ping-pong work at each other.
 */
import type { CloudComment, CloudDocumentRecord, CloudPageTask, CloudUserRecord } from "../cloud-db.js";
import type { AgentAssignment, AgentAssignmentStatus, CloudAgentIdentity } from "../cloud-platform.js";
import { type CloudServerConfig, recordActivity, roleRank, writeNotification } from "./context.js";
import { HttpError, sha256Hex } from "./http.js";
import { extractMentions } from "./mentions.js";
import { displayTaskText } from "./tasks.js";
import { emitPageWebhookEvent } from "./webhooks.js";

export const agentAssignmentStatuses: readonly AgentAssignmentStatus[] = ["open", "in_progress", "done", "declined"];

/** The capability an agent needs to reply in comment threads. */
export const AGENT_COMMENT_CAPABILITY = "comment";

const MAX_OPEN_ASSIGNMENTS_PER_AGENT = 500;

export interface AgentDocumentAccess {
  agent: CloudAgentIdentity;
  role: "viewer" | "editor";
}

/** The agent's effective role on a page, or undefined when it cannot work there. */
export function agentDocumentAccess(config: CloudServerConfig, agentId: string, documentId: string): AgentDocumentAccess | undefined {
  const agent = config.platform.readAgent(agentId);
  if (!agent || agent.status !== "active") return undefined;
  const grants = config.platform.listAgentAccess(agentId);
  const grant =
    grants.find((candidate) => candidate.resourceType === "document" && candidate.resourceId === documentId) ??
    grants.find((candidate) => candidate.resourceType === "site" && config.store.readSite(candidate.resourceId)?.documentIds.includes(documentId));
  if (!grant) return undefined;
  const ownerRole = config.store.documentAccessRole(agent.createdBy, documentId);
  if (!ownerRole) return undefined;
  const role = ownerRole !== "owner" && roleRank[ownerRole] < roleRank[grant.role] ? ownerRole : grant.role;
  return { agent, role: role === "editor" ? "editor" : "viewer" };
}

/** Agents people can @-mention or assign tasks to on this page. */
export function assignableAgents(config: CloudServerConfig, document: CloudDocumentRecord): Array<{ id: string; name: string; description?: string; role: "viewer" | "editor"; canReply: boolean }> {
  const siteIds = config.store.siteIdsForDocument(document.id);
  const agentIds = [...new Set(config.platform.listAgentAccessCovering(document.id, siteIds).map((grant) => grant.agentId))];
  return agentIds
    .flatMap((id) => {
      const access = agentDocumentAccess(config, id, document.id);
      if (!access) return [];
      const { agent, role } = access;
      return [{ id: agent.id, name: agent.name, ...(agent.description ? { description: agent.description } : {}), role, canReply: agent.capabilities.includes(AGENT_COMMENT_CAPABILITY) }];
    })
    .sort((left, right) => left.name.localeCompare(right.name))
    .slice(0, 100);
}

/** Agents mentioned in `text` that can work on the page, in mention order. */
export function mentionedAgents(config: CloudServerConfig, text: string, documentId: string): CloudAgentIdentity[] {
  return extractMentions(text)
    .slice(0, 50)
    .flatMap((id) => {
      const access = agentDocumentAccess(config, id, documentId);
      return access ? [access.agent] : [];
    });
}

/** Opens an assignment for every agent newly mentioned in a person's comment. */
export function assignAgentsFromComment(
  config: CloudServerConfig,
  document: CloudDocumentRecord,
  comment: Pick<CloudComment, "id" | "body" | "blockId" | "agentId">,
  actor: CloudUserRecord,
  previousBody?: string,
): AgentAssignment[] {
  if (comment.agentId) return [];
  const before = new Set(previousBody === undefined ? [] : extractMentions(previousBody));
  const opened: AgentAssignment[] = [];
  for (const agent of mentionedAgents(config, comment.body, document.id)) {
    if (before.has(agent.id)) continue;
    const assignment = openAssignment(config, document, agent, {
      id: assignmentId("comment", agent.id, comment.id),
      source: "comment",
      commentId: comment.id,
      ...(comment.blockId ? { blockId: comment.blockId } : {}),
      request: comment.body.slice(0, 4_000),
      requestedBy: actor.id,
      requestedByName: actor.name,
    });
    if (assignment) opened.push(assignment);
  }
  return opened;
}

/**
 * Keeps task assignments in step with a saved page: newly assigned or reopened agent tasks open an
 * assignment, and a task a person checks off closes its open assignment as done.
 */
export function syncAgentTaskAssignments(
  config: CloudServerConfig,
  document: CloudDocumentRecord,
  changes: { assigned: CloudPageTask[]; completed: CloudPageTask[]; reopened: CloudPageTask[] },
  actor: { id?: string; name: string },
): AgentAssignment[] {
  const opened: AgentAssignment[] = [];
  for (const task of [...changes.assigned, ...changes.reopened]) {
    if (!task.assigneeId || task.status === "done") continue;
    const access = agentDocumentAccess(config, task.assigneeId, document.id);
    if (!access) continue;
    const assignment = openAssignment(config, document, access.agent, {
      id: assignmentId("task", access.agent.id, `${document.id}:${task.taskId}`),
      source: "task",
      taskId: task.taskId,
      blockId: task.taskId,
      request: displayTaskText(task.text),
      requestedBy: actor.id ?? "share-link",
      requestedByName: actor.name,
    });
    if (assignment) opened.push(assignment);
  }
  for (const task of changes.completed) {
    if (!task.assigneeId) continue;
    const existing = config.platform.readAgentAssignment(assignmentId("task", task.assigneeId, `${document.id}:${task.taskId}`));
    if (!existing || existing.status === "done" || existing.status === "declined") continue;
    const now = config.now().toISOString();
    config.platform.writeAgentAssignment({ ...existing, status: "done", note: existing.note ?? `Task checked off by ${actor.name}`, updatedAt: now, completedAt: now });
  }
  return opened;
}

/** Moves an assignment to `status`, linking `proposalId` when given, and tells the requester when it closes. */
export function updateAgentAssignment(
  config: CloudServerConfig,
  assignment: AgentAssignment,
  update: { status?: AgentAssignmentStatus; note?: string; proposalId?: string },
): AgentAssignment {
  const now = config.now().toISOString();
  const status = update.status ?? (update.proposalId && assignment.status === "open" ? "in_progress" : assignment.status);
  const closing = (status === "done" || status === "declined") && assignment.status !== status;
  const next: AgentAssignment = {
    ...assignment,
    status,
    ...(update.note !== undefined ? { note: update.note.slice(0, 2_000) } : {}),
    proposalIds: update.proposalId && !assignment.proposalIds.includes(update.proposalId) ? [...assignment.proposalIds, update.proposalId].slice(-50) : assignment.proposalIds,
    updatedAt: now,
    ...(status === "done" || status === "declined" ? { completedAt: assignment.completedAt && !closing ? assignment.completedAt : now } : {}),
  };
  if (status === "open" || status === "in_progress") delete next.completedAt;
  config.platform.writeAgentAssignment(next);
  if (closing && config.store.readUser(assignment.requestedBy) && config.store.documentAccessRole(assignment.requestedBy, assignment.documentId)) {
    const agent = config.platform.readAgent(assignment.agentId);
    const document = config.store.readDocument(assignment.documentId);
    const verb = status === "done" ? "finished" : "declined";
    const note = next.note ? `: ${next.note.slice(0, 200)}` : "";
    writeNotification(config, assignment.requestedBy, "comment", `${agent?.name ?? "An agent"} ${verb} your request`, `${document?.title ?? "A page"}${note}`, "document", assignment.documentId);
  }
  return next;
}

/** Records the agent's thread reply on the assignment and marks fresh work as in progress. */
export function recordAgentReply(config: CloudServerConfig, assignment: AgentAssignment, commentId: string): AgentAssignment {
  const next: AgentAssignment = {
    ...assignment,
    status: assignment.status === "open" ? "in_progress" : assignment.status,
    replyCommentIds: [...assignment.replyCommentIds, commentId].slice(-100),
    updatedAt: config.now().toISOString(),
  };
  config.platform.writeAgentAssignment(next);
  return next;
}

/** The comment an agent reply should thread under: the root of the requesting comment's thread. */
export function assignmentThreadRoot(config: CloudServerConfig, assignment: AgentAssignment): CloudComment | undefined {
  if (!assignment.commentId) return undefined;
  let comment = config.store.readComment(assignment.commentId);
  for (let depth = 0; comment?.parentId && depth < 50; depth++) comment = config.store.readComment(comment.parentId);
  return comment && !comment.deletedAt ? comment : undefined;
}

export function assignmentStatusInput(value: unknown): AgentAssignmentStatus {
  if (typeof value === "string" && (agentAssignmentStatuses as readonly string[]).includes(value)) return value as AgentAssignmentStatus;
  throw new HttpError(400, `status must be one of ${agentAssignmentStatuses.join(", ")}`);
}

/** Assignment as returned by the API, with display names resolved. */
export function assignmentResponse(config: CloudServerConfig, assignment: AgentAssignment): AgentAssignment & { agentName: string; documentTitle?: string } {
  const document = config.store.readDocument(assignment.documentId);
  return { ...assignment, agentName: config.platform.readAgent(assignment.agentId)?.name ?? assignment.agentId, ...(document ? { documentTitle: document.title } : {}) };
}

function openAssignment(
  config: CloudServerConfig,
  document: CloudDocumentRecord,
  agent: CloudAgentIdentity,
  input: Omit<AgentAssignment, "agentId" | "documentId" | "status" | "proposalIds" | "replyCommentIds" | "createdAt" | "updatedAt">,
): AgentAssignment | undefined {
  const existing = config.platform.readAgentAssignment(input.id);
  if (existing && (existing.status === "open" || existing.status === "in_progress")) return undefined;
  const open = config.platform.listAgentAssignments({ agentId: agent.id }).filter((item) => item.status === "open" || item.status === "in_progress").length;
  if (open >= MAX_OPEN_ASSIGNMENTS_PER_AGENT) return undefined;
  const now = config.now().toISOString();
  const assignment: AgentAssignment = {
    ...input,
    agentId: agent.id,
    documentId: document.id,
    status: "open",
    proposalIds: existing?.proposalIds ?? [],
    replyCommentIds: existing?.replyCommentIds ?? [],
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
  };
  config.platform.writeAgentAssignment(assignment);
  if (agent.createdBy !== input.requestedBy) {
    writeNotification(
      config,
      agent.createdBy,
      "task_assigned",
      `${agent.name} was asked to help on ${document.title}`,
      `${input.requestedByName}: ${input.request.slice(0, 240)}`,
      "document",
      document.id,
    );
  }
  const requester = config.store.readUser(input.requestedBy);
  if (requester) recordActivity(config, requester, "agent.assigned", "document", document.id, { assignmentId: assignment.id, agentId: agent.id, source: input.source });
  emitPageWebhookEvent(config, "agent.assigned", document, requester, {
    assignment: {
      id: assignment.id,
      agentId: agent.id,
      agentName: agent.name,
      source: assignment.source,
      request: assignment.request.slice(0, 1_000),
      ...(assignment.commentId ? { commentId: assignment.commentId } : {}),
      ...(assignment.taskId ? { taskId: assignment.taskId } : {}),
      ...(assignment.blockId ? { blockId: assignment.blockId } : {}),
    },
  });
  return assignment;
}

function assignmentId(source: AgentAssignment["source"], agentId: string, key: string): string {
  return `asg-${sha256Hex(`${source}:${agentId}:${key}`).slice(0, 24)}`;
}
