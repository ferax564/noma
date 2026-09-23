/** `/api/projects`: projects, issues, and sprints. */
import type { IncomingMessage, ServerResponse } from "node:http";
import type {
  CloudIssue,
  CloudIssueComment,
  CloudIssueFilter,
  CloudIssueLink,
  CloudIssueLinkType,
  CloudIssuePriority,
  CloudIssueStatus,
  CloudIssueType,
  CloudProject,
  CloudSprint,
  CloudSprintStatus,
  CloudUserRecord,
} from "../cloud-db.js";
import {
  type AccessContext,
  type CloudServerConfig,
  type Principal,
  readSite,
  readUser,
  recordIssueEvent,
  requireAccessRole,
  requireNotTrashed,
  requireProjectAccess,
  requireRecordAccess,
  requireUser,
  sqliteConstraint,
  uniqueId,
} from "./context.js";
import { HttpError, readJsonBody, sendJson } from "./http.js";
import { boundedInteger, numberQuery, optionalString, stringInput } from "./input.js";

const issueStatuses: CloudIssueStatus[] = ["backlog", "todo", "in_progress", "in_review", "done"];

const issueTransitions: Record<CloudIssueStatus, CloudIssueStatus[]> = {
  backlog: ["todo"],
  todo: ["backlog", "in_progress"],
  in_progress: ["todo", "in_review", "done"],
  in_review: ["in_progress", "done"],
  done: ["todo"],
};

const sprintTransitions: Record<CloudSprintStatus, CloudSprintStatus[]> = {
  planned: ["active"],
  active: ["closed"],
  closed: [],
};

export async function routeProjects(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  parts: string[],
  config: CloudServerConfig,
  principal: Principal,
): Promise<void> {
  const method = req.method ?? "GET";
  const user = requireUser(principal);
  const projectId = parts[2];
  if (!projectId && method === "GET") {
    sendJson(res, 200, { projects: config.store.listProjects(user) });
    return;
  }
  if (!projectId && method === "POST") {
    const input = await readJsonBody(req, config.maxBodyBytes);
    const siteId = stringInput(input, "siteId");
    const site = await readSite(config, siteId);
    requireNotTrashed(config, "site", siteId);
    requireRecordAccess(config, site, principal, "editor");
    const now = config.now().toISOString();
    const project: CloudProject = {
      id: uniqueId(config),
      key: projectKeyInput(input.key),
      name: stringInput(input, "name").slice(0, 120),
      siteId,
      ...(optionalString(input.description) ? { description: optionalString(input.description)?.slice(0, 4_000) } : {}),
      createdBy: user.id,
      createdAt: now,
      updatedAt: now,
    };
    try {
      config.store.writeProject(project);
    } catch (error) {
      if (sqliteConstraint(error)) throw new HttpError(409, "Project key already exists");
      throw error;
    }
    sendJson(res, 201, { ...project, access: { role: config.store.resourceAccess(user.id, "site", siteId)?.role ?? "viewer" } });
    return;
  }
  if (!projectId) throw new HttpError(404, "Project ID or key is required");
  const project = config.store.readProject(projectId);
  if (!project) throw new HttpError(404, "Project not found");
  const access = requireProjectAccess(config, project, principal, "viewer");
  const resource = parts[3];
  const resourceId = parts[4];
  const subresource = parts[5];

  if (!resource && method === "GET") {
    sendJson(res, 200, { ...project, access: { role: access.role } });
    return;
  }
  if (!resource && method === "PATCH") {
    requireAccessRole(access, "editor");
    const input = await readJsonBody(req, config.maxBodyBytes);
    const next: CloudProject = {
      ...project,
      name: optionalString(input.name)?.slice(0, 120) ?? project.name,
      description: input.description === null ? undefined : optionalString(input.description)?.slice(0, 4_000) ?? project.description,
      updatedAt: config.now().toISOString(),
    };
    config.store.writeProject(next);
    sendJson(res, 200, { ...next, access: { role: access.role } });
    return;
  }
  if (resource === "issues") {
    await routeProjectIssues(req, res, url, resourceId, subresource, config, principal, user, project, access);
    return;
  }
  if (resource === "sprints") {
    await routeProjectSprints(req, res, resourceId, config, user, project, access);
    return;
  }
  if ((resource === "board" || resource === "backlog") && method === "GET") {
    const issues = config.store.listIssues(project.id, { limit: 500 });
    const sprints = config.store.listSprints(project.id);
    if (resource === "backlog") {
      sendJson(res, 200, {
        project,
        issues: issues.filter((issue) => !issue.sprintId && (issue.status === "backlog" || issue.status === "todo")),
        plannedSprints: sprints.filter((sprint) => sprint.status === "planned"),
      });
    } else {
      sendJson(res, 200, {
        project,
        columns: Object.fromEntries(issueStatuses.map((status) => [status, issues.filter((issue) => issue.status === status)])),
        activeSprint: sprints.find((sprint) => sprint.status === "active"),
      });
    }
    return;
  }
  throw new HttpError(404, "Unknown project route");
}

async function routeProjectIssues(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  issueId: string | undefined,
  subresource: string | undefined,
  config: CloudServerConfig,
  principal: Principal,
  user: CloudUserRecord,
  project: CloudProject,
  access: AccessContext,
): Promise<void> {
  const method = req.method ?? "GET";
  if (!issueId && method === "GET") {
    sendJson(res, 200, { issues: config.store.listIssues(project.id, issueFilterInput(url)) });
    return;
  }
  if (!issueId && method === "POST") {
    requireAccessRole(access, "editor");
    const input = await readJsonBody(req, config.maxBodyBytes);
    const assigneeId = await issueAssignee(config, project, input.assigneeId);
    const sprintId = issueSprint(config, project.id, input.sprintId);
    const parentId = issueParent(config, project.id, input.parentId);
    const now = config.now().toISOString();
    const issue = config.store.createIssue(
      {
        id: uniqueId(config),
        projectId: project.id,
        summary: stringInput(input, "summary").slice(0, 240),
        ...(optionalString(input.description) ? { description: optionalString(input.description)?.slice(0, 20_000) } : {}),
        type: issueTypeInput(input.type, "task"),
        status: issueStatusInput(input.status, "backlog"),
        priority: issuePriorityInput(input.priority, "medium"),
        reporterId: user.id,
        ...(assigneeId ? { assigneeId } : {}),
        labels: issueLabels(input.labels),
        ...(sprintId ? { sprintId } : {}),
        ...(parentId ? { parentId } : {}),
        ...(issueEstimate(input.estimate) === undefined ? {} : { estimate: issueEstimate(input.estimate) }),
        ...(issueDueDate(input.dueDate) ? { dueDate: issueDueDate(input.dueDate) } : {}),
        createdAt: now,
        updatedAt: now,
      },
      project.key,
    );
    recordIssueEvent(config, user, issue.id, "issue.created", { status: issue.status, assigneeId });
    sendJson(res, 201, issue);
    return;
  }
  if (!issueId) throw new HttpError(404, "Issue ID or key is required");
  const issue = config.store.readIssue(issueId);
  if (!issue || issue.projectId !== project.id) throw new HttpError(404, "Issue not found");
  if (subresource === "comments") {
    if (method === "GET") {
      sendJson(res, 200, { comments: config.store.listIssueComments(issue.id) });
      return;
    }
    if (method === "POST") {
      const input = await readJsonBody(req, config.maxBodyBytes);
      const now = config.now().toISOString();
      const comment: Omit<CloudIssueComment, "createdByName"> = {
        id: uniqueId(config),
        issueId: issue.id,
        body: stringInput(input, "body").slice(0, 10_000),
        createdBy: user.id,
        createdAt: now,
        updatedAt: now,
      };
      config.store.writeIssueComment(comment);
      recordIssueEvent(config, user, issue.id, "comment.created", { commentId: comment.id });
      sendJson(res, 201, config.store.listIssueComments(issue.id).find((item) => item.id === comment.id));
      return;
    }
  }
  if (subresource === "links") {
    if (method === "GET") {
      sendJson(res, 200, { links: config.store.listIssueLinks(issue.id) });
      return;
    }
    if (method === "POST") {
      requireAccessRole(access, "editor");
      const input = await readJsonBody(req, config.maxBodyBytes);
      const target = config.store.readIssue(stringInput(input, "targetIssueId"));
      if (!target) throw new HttpError(404, "Target issue not found");
      const targetProject = config.store.readProject(target.projectId);
      if (!targetProject) throw new HttpError(404, "Target project not found");
      requireProjectAccess(config, targetProject, principal, "viewer");
      if (target.id === issue.id) throw new HttpError(400, "An issue cannot link to itself");
      const link: Omit<CloudIssueLink, "targetIssueKey" | "targetIssueSummary"> = {
        id: uniqueId(config),
        sourceIssueId: issue.id,
        targetIssueId: target.id,
        type: issueLinkTypeInput(input.type),
        createdBy: user.id,
        createdAt: config.now().toISOString(),
      };
      try {
        config.store.writeIssueLink(link);
      } catch (error) {
        if (sqliteConstraint(error)) throw new HttpError(409, "This issue link already exists");
        throw error;
      }
      recordIssueEvent(config, user, issue.id, "link.created", { targetIssueId: target.id, type: link.type });
      sendJson(res, 201, config.store.listIssueLinks(issue.id).find((item) => item.id === link.id));
      return;
    }
  }
  if (subresource === "history" && method === "GET") {
    sendJson(res, 200, { events: config.store.listIssueEvents(issue.id) });
    return;
  }
  if (subresource) throw new HttpError(404, "Unknown issue route");
  if (method === "GET") {
    sendJson(res, 200, {
      ...issue,
      links: config.store.listIssueLinks(issue.id),
      comments: config.store.listIssueComments(issue.id),
      events: config.store.listIssueEvents(issue.id),
    });
    return;
  }
  if (method === "PATCH") {
    requireAccessRole(access, "editor");
    const input = await readJsonBody(req, config.maxBodyBytes);
    const nextStatus = input.status === undefined ? issue.status : issueStatusInput(input.status);
    if (nextStatus !== issue.status && !issueTransitions[issue.status].includes(nextStatus)) {
      throw new HttpError(409, `Issue cannot move from ${issue.status} to ${nextStatus}`);
    }
    const assigneeId = input.assigneeId === undefined ? issue.assigneeId : await issueAssignee(config, project, input.assigneeId);
    const sprintId = input.sprintId === undefined ? issue.sprintId : issueSprint(config, project.id, input.sprintId);
    const parentId = input.parentId === undefined ? issue.parentId : issueParent(config, project.id, input.parentId, issue.id);
    const next: CloudIssue = {
      ...issue,
      summary: optionalString(input.summary)?.slice(0, 240) ?? issue.summary,
      description: input.description === null ? undefined : optionalString(input.description)?.slice(0, 20_000) ?? issue.description,
      type: input.type === undefined ? issue.type : issueTypeInput(input.type),
      status: nextStatus,
      priority: input.priority === undefined ? issue.priority : issuePriorityInput(input.priority),
      assigneeId,
      labels: input.labels === undefined ? issue.labels : issueLabels(input.labels),
      sprintId,
      parentId,
      estimate: input.estimate === undefined ? issue.estimate : issueEstimate(input.estimate),
      dueDate: input.dueDate === undefined ? issue.dueDate : issueDueDate(input.dueDate),
      updatedAt: config.now().toISOString(),
    };
    config.store.writeIssue(next);
    recordIssueEvent(config, user, issue.id, "issue.updated", issueChanges(issue, next));
    sendJson(res, 200, config.store.readIssue(issue.id));
    return;
  }
  throw new HttpError(405, "Method not allowed");
}

async function routeProjectSprints(
  req: IncomingMessage,
  res: ServerResponse,
  sprintId: string | undefined,
  config: CloudServerConfig,
  user: CloudUserRecord,
  project: CloudProject,
  access: AccessContext,
): Promise<void> {
  const method = req.method ?? "GET";
  if (!sprintId && method === "GET") {
    sendJson(res, 200, { sprints: config.store.listSprints(project.id) });
    return;
  }
  if (!sprintId && method === "POST") {
    requireAccessRole(access, "editor");
    const input = await readJsonBody(req, config.maxBodyBytes);
    const now = config.now().toISOString();
    const status = sprintStatusInput(input.status, "planned");
    if (status === "closed") throw new HttpError(400, "New sprints must be planned or active");
    if (status === "active" && config.store.activeSprint(project.id)) throw new HttpError(409, "This project already has an active sprint");
    const sprint: CloudSprint = {
      id: uniqueId(config),
      projectId: project.id,
      name: stringInput(input, "name").slice(0, 160),
      ...(optionalString(input.goal) ? { goal: optionalString(input.goal)?.slice(0, 4_000) } : {}),
      status,
      ...(status === "active" ? { startAt: issueDateTime(input.startAt) ?? now } : {}),
      ...(issueDateTime(input.endAt) ? { endAt: issueDateTime(input.endAt) } : {}),
      createdBy: user.id,
      createdAt: now,
      updatedAt: now,
    };
    config.store.writeSprint(sprint);
    sendJson(res, 201, sprint);
    return;
  }
  if (!sprintId) throw new HttpError(404, "Sprint ID is required");
  const sprint = config.store.readSprint(sprintId);
  if (!sprint || sprint.projectId !== project.id) throw new HttpError(404, "Sprint not found");
  if (method === "GET") {
    sendJson(res, 200, sprint);
    return;
  }
  if (method === "PATCH") {
    requireAccessRole(access, "editor");
    const input = await readJsonBody(req, config.maxBodyBytes);
    const status = input.status === undefined ? sprint.status : sprintStatusInput(input.status);
    if (status !== sprint.status && !sprintTransitions[sprint.status].includes(status)) {
      throw new HttpError(409, `Sprint cannot move from ${sprint.status} to ${status}`);
    }
    if (status === "active" && config.store.activeSprint(project.id)) throw new HttpError(409, "This project already has an active sprint");
    const now = config.now().toISOString();
    const next: CloudSprint = {
      ...sprint,
      name: optionalString(input.name)?.slice(0, 160) ?? sprint.name,
      goal: input.goal === null ? undefined : optionalString(input.goal)?.slice(0, 4_000) ?? sprint.goal,
      status,
      startAt: status === "active" ? issueDateTime(input.startAt) ?? sprint.startAt ?? now : sprint.startAt,
      endAt: issueDateTime(input.endAt) ?? sprint.endAt,
      updatedAt: now,
    };
    if (status === "closed" && sprint.status !== "closed") config.store.closeSprint(next, now);
    else config.store.writeSprint(next);
    sendJson(res, 200, config.store.readSprint(sprint.id));
    return;
  }
  throw new HttpError(405, "Method not allowed");
}

function projectKeyInput(value: unknown): string {
  const key = optionalString(value)?.toUpperCase();
  if (!key || !/^[A-Z][A-Z0-9]{1,9}$/.test(key)) throw new HttpError(400, "Project key must be 2-10 letters or digits and start with a letter");
  return key;
}

function issueTypeInput(value: unknown, fallback?: CloudIssueType): CloudIssueType {
  if (value === undefined && fallback) return fallback;
  if (value === "task" || value === "story" || value === "bug" || value === "epic") return value;
  throw new HttpError(400, "type must be task, story, bug, or epic");
}

function issueStatusInput(value: unknown, fallback?: CloudIssueStatus): CloudIssueStatus {
  if (value === undefined && fallback) return fallback;
  if (typeof value === "string" && issueStatuses.includes(value as CloudIssueStatus)) return value as CloudIssueStatus;
  throw new HttpError(400, "status must be backlog, todo, in_progress, in_review, or done");
}

function issuePriorityInput(value: unknown, fallback?: CloudIssuePriority): CloudIssuePriority {
  if (value === undefined && fallback) return fallback;
  if (value === "lowest" || value === "low" || value === "medium" || value === "high" || value === "highest") return value;
  throw new HttpError(400, "priority must be lowest, low, medium, high, or highest");
}

function sprintStatusInput(value: unknown, fallback?: CloudSprintStatus): CloudSprintStatus {
  if (value === undefined && fallback) return fallback;
  if (value === "planned" || value === "active" || value === "closed") return value;
  throw new HttpError(400, "status must be planned, active, or closed");
}

function issueLinkTypeInput(value: unknown): CloudIssueLinkType {
  if (value === "blocks" || value === "duplicates") return value;
  if (value === undefined || value === "relates") return "relates";
  throw new HttpError(400, "type must be blocks, relates, or duplicates");
}

function issueFilterInput(url: URL): CloudIssueFilter {
  const sprint = url.searchParams.get("sprint");
  return {
    ...(optionalString(url.searchParams.get("q")) ? { q: optionalString(url.searchParams.get("q"))?.slice(0, 200) } : {}),
    ...(url.searchParams.has("status") ? { status: issueStatusInput(url.searchParams.get("status")) } : {}),
    ...(url.searchParams.has("type") ? { type: issueTypeInput(url.searchParams.get("type")) } : {}),
    ...(url.searchParams.has("priority") ? { priority: issuePriorityInput(url.searchParams.get("priority")) } : {}),
    ...(optionalString(url.searchParams.get("assignee")) ? { assigneeId: optionalString(url.searchParams.get("assignee")) } : {}),
    ...(optionalString(url.searchParams.get("label")) ? { label: optionalString(url.searchParams.get("label"))?.slice(0, 80) } : {}),
    ...(sprint === "none" ? { sprintId: null } : optionalString(sprint) ? { sprintId: optionalString(sprint) } : {}),
    limit: boundedInteger(numberQuery(url.searchParams.get("limit")), 200, 1, 500, "limit"),
  };
}

async function issueAssignee(config: CloudServerConfig, project: CloudProject, value: unknown): Promise<string | undefined> {
  if (value === null || value === "" || value === undefined) return undefined;
  if (typeof value !== "string") throw new HttpError(400, "assigneeId must be a user ID or null");
  const assignee = await readUser(config, value);
  if (!config.store.resourceAccess(assignee.id, "site", project.siteId)) throw new HttpError(400, "Assignee needs access to the project space");
  return assignee.id;
}

function issueSprint(config: CloudServerConfig, projectId: string, value: unknown): string | undefined {
  if (value === null || value === "" || value === undefined) return undefined;
  if (typeof value !== "string") throw new HttpError(400, "sprintId must be a sprint ID or null");
  const sprint = config.store.readSprint(value);
  if (!sprint || sprint.projectId !== projectId) throw new HttpError(400, "Sprint does not belong to this project");
  if (sprint.status === "closed") throw new HttpError(409, "Closed sprints cannot accept issues");
  return sprint.id;
}

function issueParent(config: CloudServerConfig, projectId: string, value: unknown, issueId?: string): string | undefined {
  if (value === null || value === "" || value === undefined) return undefined;
  if (typeof value !== "string") throw new HttpError(400, "parentId must be an issue ID or null");
  const parent = config.store.readIssue(value);
  if (!parent || parent.projectId !== projectId) throw new HttpError(400, "Parent issue does not belong to this project");
  if (parent.id === issueId) throw new HttpError(400, "An issue cannot be its own parent");
  if (parent.type !== "epic") throw new HttpError(400, "Parent issues must be epics");
  return parent.id;
}

function issueLabels(value: unknown): string[] {
  if (value === undefined) return [];
  const values = Array.isArray(value) ? value : typeof value === "string" ? value.split(",") : undefined;
  if (!values) throw new HttpError(400, "labels must be an array or comma-separated string");
  const labels = values.map((label) => {
    if (typeof label !== "string") throw new HttpError(400, "labels must contain strings");
    const normalized = label.trim().toLowerCase().replace(/\s+/g, "-").slice(0, 80);
    if (!normalized || !/^[a-z0-9][a-z0-9._-]*$/.test(normalized)) throw new HttpError(400, "labels may contain letters, digits, dots, underscores, and dashes");
    return normalized;
  });
  return [...new Set(labels)].slice(0, 20);
}

function issueEstimate(value: unknown): number | undefined {
  if (value === null || value === "" || value === undefined) return undefined;
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 100_000) {
    throw new HttpError(400, "estimate must be a number between 0 and 100000");
  }
  return value;
}

function issueDueDate(value: unknown): string | undefined {
  if (value === null || value === "" || value === undefined) return undefined;
  const parsed = typeof value === "string" ? new Date(`${value}T00:00:00Z`) : undefined;
  if (
    typeof value !== "string" ||
    !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
    !parsed ||
    Number.isNaN(parsed.getTime()) ||
    parsed.toISOString().slice(0, 10) !== value
  ) {
    throw new HttpError(400, "dueDate must be YYYY-MM-DD or null");
  }
  return value;
}

function issueDateTime(value: unknown): string | undefined {
  if (value === null || value === "" || value === undefined) return undefined;
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) throw new HttpError(400, "Sprint dates must be ISO date-time strings");
  return new Date(value).toISOString();
}

function issueChanges(before: CloudIssue, after: CloudIssue): Record<string, unknown> {
  const detail: Record<string, unknown> = {};
  for (const key of ["summary", "description", "type", "status", "priority", "assigneeId", "labels", "sprintId", "parentId", "estimate", "dueDate"] as const) {
    if (JSON.stringify(before[key]) !== JSON.stringify(after[key])) detail[key] = { from: before[key], to: after[key] };
  }
  return detail;
}
