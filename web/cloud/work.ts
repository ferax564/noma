/** Work management: projects, issues and sprints. */
import { fetchCloudJson } from "./api.js";
import { collaborationRow } from "./collaboration.js";
import { refreshDevLoop } from "./devloop.js";
import { workIssueStatuses } from "./constants.js";
import { issueAssigneeInput, issueCommentInput, issueDetailList, issueFilterSelect, issueLabelsInput, issueLinkTargetInput, issueLinkTypeSelect, issuePrioritySelect, issueSearchInput, issueSprintSelect, issueSummaryInput, issueTypeSelect, manageSprintSelect, projectKeyInput, projectNameInput, selectedIssueSummary, sprintNameInput, workBoard, workProjectSelect, workStatus } from "./dom.js";
import { renderChrome } from "./layout.js";
import { canEditSite } from "./permissions.js";
import { state } from "./state.js";
import type { CloudIssue, CloudIssueDetail, CloudIssueStatus, CloudProject, CloudSprint } from "./types.js";
import { actionButton, emptyState, errorMessage, formatDate, setPanelStatus } from "./util.js";

export async function refreshWorkManagement(): Promise<void> {
  if (!state.cloudUser) {
    state.workProjects = [];
    state.workIssues = [];
    state.workSprints = [];
    state.selectedIssue = undefined;
    renderWorkManagement();
    return;
  }
  const selectedId = workProjectSelect.value;
  try {
    const response = await fetchCloudJson<{ projects: CloudProject[] }>("/api/projects");
    const available = state.currentSite ? response.projects.filter((project) => project.siteId === state.currentSite?.id) : response.projects;
    state.workProjects = available;
    const projectId = available.some((project) => project.id === selectedId) ? selectedId : available[0]?.id;
    if (projectId) await loadWorkProject(projectId);
    else {
      state.workIssues = [];
      state.workSprints = [];
      state.selectedIssue = undefined;
      void refreshDevLoop("", "viewer");
    }
  } catch (error) {
    setPanelStatus(workStatus, errorMessage(error), "error");
  } finally {
    renderWorkManagement();
  }
}

export async function loadWorkProject(projectId: string): Promise<void> {
  if (!projectId) return;
  const previousIssueId = state.selectedIssue?.id;
  const [issueResponse, sprintResponse] = await Promise.all([
    fetchCloudJson<{ issues: CloudIssue[] }>(`/api/projects/${encodeURIComponent(projectId)}/issues?limit=500`),
    fetchCloudJson<{ sprints: CloudSprint[] }>(`/api/projects/${encodeURIComponent(projectId)}/sprints`),
  ]);
  state.workIssues = issueResponse.issues;
  state.workSprints = sprintResponse.sprints;
  void refreshDevLoop(projectId, state.workProjects.find((project) => project.id === projectId)?.access?.role ?? "viewer");
  const nextIssue = previousIssueId ? state.workIssues.find((issue) => issue.id === previousIssueId) : undefined;
  if (nextIssue) await selectWorkIssue(nextIssue.id);
  else state.selectedIssue = undefined;
  renderWorkManagement();
  renderChrome();
}

export async function createWorkProject(): Promise<void> {
  if (!state.currentSite || !canEditSite()) {
    setPanelStatus(workStatus, "Open an editable space before creating a project", "error");
    return;
  }
  const key = projectKeyInput.value.trim().toUpperCase();
  const name = projectNameInput.value.trim();
  if (!key || !name) {
    setPanelStatus(workStatus, "Enter a project key and name", "error");
    return;
  }
  try {
    const project = await fetchCloudJson<CloudProject>("/api/projects", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ key, name, siteId: state.currentSite.id }),
    });
    projectKeyInput.value = "";
    projectNameInput.value = "";
    await refreshWorkManagement();
    workProjectSelect.value = project.id;
    await loadWorkProject(project.id);
    setPanelStatus(workStatus, `Created ${project.key}`, "ok");
  } catch (error) {
    setPanelStatus(workStatus, errorMessage(error), "error");
  }
}

export async function createWorkIssue(): Promise<void> {
  const project = selectedWorkProject();
  const summary = issueSummaryInput.value.trim();
  if (!project || !summary) {
    setPanelStatus(workStatus, "Choose a project and enter an issue summary", "error");
    return;
  }
  try {
    const issue = await fetchCloudJson<CloudIssue>(`/api/projects/${encodeURIComponent(project.id)}/issues`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        summary,
        type: issueTypeSelect.value,
        priority: issuePrioritySelect.value,
        assigneeId: issueAssigneeInput.value.trim() || undefined,
        labels: issueLabelsInput.value.trim() || undefined,
        sprintId: issueSprintSelect.value || undefined,
      }),
    });
    issueSummaryInput.value = "";
    issueAssigneeInput.value = "";
    issueLabelsInput.value = "";
    await loadWorkProject(project.id);
    await selectWorkIssue(issue.id);
    setPanelStatus(workStatus, `Created ${issue.key}`, "ok");
  } catch (error) {
    setPanelStatus(workStatus, errorMessage(error), "error");
  }
}

export async function createWorkSprint(): Promise<void> {
  const project = selectedWorkProject();
  const name = sprintNameInput.value.trim();
  if (!project || !name) {
    setPanelStatus(workStatus, "Choose a project and enter a sprint name", "error");
    return;
  }
  try {
    const sprint = await fetchCloudJson<CloudSprint>(`/api/projects/${encodeURIComponent(project.id)}/sprints`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name }),
    });
    sprintNameInput.value = "";
    await loadWorkProject(project.id);
    manageSprintSelect.value = sprint.id;
    renderWorkManagement();
    setPanelStatus(workStatus, `Created ${sprint.name}`, "ok");
  } catch (error) {
    setPanelStatus(workStatus, errorMessage(error), "error");
  }
}

export async function updateWorkSprint(status: "active" | "closed"): Promise<void> {
  const project = selectedWorkProject();
  const sprint = selectedWorkSprint();
  if (!project || !sprint) return;
  try {
    await fetchCloudJson(`/api/projects/${encodeURIComponent(project.id)}/sprints/${encodeURIComponent(sprint.id)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status }),
    });
    await loadWorkProject(project.id);
    setPanelStatus(workStatus, status === "active" ? "Sprint started" : "Sprint completed; unfinished work returned to backlog", "ok");
  } catch (error) {
    setPanelStatus(workStatus, errorMessage(error), "error");
  }
}

async function moveWorkIssue(issue: CloudIssue, status: CloudIssueStatus): Promise<void> {
  const project = selectedWorkProject();
  if (!project) return;
  try {
    await fetchCloudJson(`/api/projects/${encodeURIComponent(project.id)}/issues/${encodeURIComponent(issue.id)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status }),
    });
    await loadWorkProject(project.id);
    if (state.selectedIssue?.id === issue.id) await selectWorkIssue(issue.id);
  } catch (error) {
    setPanelStatus(workStatus, errorMessage(error), "error");
  }
}

export async function selectWorkIssue(issueId: string): Promise<void> {
  const project = selectedWorkProject();
  if (!project) return;
  try {
    state.selectedIssue = await fetchCloudJson<CloudIssueDetail>(
      `/api/projects/${encodeURIComponent(project.id)}/issues/${encodeURIComponent(issueId)}`,
    );
  } catch (error) {
    state.selectedIssue = undefined;
    setPanelStatus(workStatus, errorMessage(error), "error");
  } finally {
    renderChrome();
  }
}

export async function addWorkIssueComment(): Promise<void> {
  const project = selectedWorkProject();
  const body = issueCommentInput.value.trim();
  if (!project || !state.selectedIssue || !body) {
    setPanelStatus(workStatus, "Select an issue and write a comment", "error");
    return;
  }
  try {
    await fetchCloudJson(`/api/projects/${encodeURIComponent(project.id)}/issues/${encodeURIComponent(state.selectedIssue.id)}/comments`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ body }),
    });
    issueCommentInput.value = "";
    await selectWorkIssue(state.selectedIssue.id);
  } catch (error) {
    setPanelStatus(workStatus, errorMessage(error), "error");
  }
}

export async function addWorkIssueLink(): Promise<void> {
  const project = selectedWorkProject();
  const targetIssueId = issueLinkTargetInput.value.trim();
  if (!project || !state.selectedIssue || !targetIssueId) {
    setPanelStatus(workStatus, "Select an issue and enter a target issue key or ID", "error");
    return;
  }
  try {
    await fetchCloudJson(`/api/projects/${encodeURIComponent(project.id)}/issues/${encodeURIComponent(state.selectedIssue.id)}/links`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ targetIssueId, type: issueLinkTypeSelect.value }),
    });
    issueLinkTargetInput.value = "";
    await selectWorkIssue(state.selectedIssue.id);
  } catch (error) {
    setPanelStatus(workStatus, errorMessage(error), "error");
  }
}

export function renderWorkManagement(): void {
  renderWorkProjectSelect();
  renderWorkSprintSelects();
  renderWorkBoard();
  renderSelectedWorkIssue();
}

function renderWorkProjectSelect(): void {
  const selected = workProjectSelect.value;
  workProjectSelect.textContent = "";
  for (const project of state.workProjects) {
    const option = document.createElement("option");
    option.value = project.id;
    option.textContent = `${project.key} · ${project.name}`;
    workProjectSelect.append(option);
  }
  workProjectSelect.value = state.workProjects.some((project) => project.id === selected) ? selected : state.workProjects[0]?.id ?? "";
}

function renderWorkSprintSelects(): void {
  const manageSelected = manageSprintSelect.value;
  const issueSelected = issueSprintSelect.value;
  manageSprintSelect.textContent = "";
  issueSprintSelect.textContent = "";
  const backlog = document.createElement("option");
  backlog.value = "";
  backlog.textContent = "Backlog / no sprint";
  issueSprintSelect.append(backlog);
  for (const sprint of state.workSprints) {
    const manageOption = document.createElement("option");
    manageOption.value = sprint.id;
    manageOption.textContent = `${sprint.name} · ${sprint.status}`;
    manageSprintSelect.append(manageOption);
    if (sprint.status !== "closed") {
      const issueOption = document.createElement("option");
      issueOption.value = sprint.id;
      issueOption.textContent = `${sprint.name} · ${sprint.status}`;
      issueSprintSelect.append(issueOption);
    }
  }
  manageSprintSelect.value = state.workSprints.some((sprint) => sprint.id === manageSelected) ? manageSelected : state.workSprints[0]?.id ?? "";
  issueSprintSelect.value = state.workSprints.some((sprint) => sprint.id === issueSelected && sprint.status !== "closed") ? issueSelected : "";
}

export function renderWorkBoard(): void {
  workBoard.textContent = "";
  const filter = issueFilterSelect.value;
  const query = issueSearchInput.value.trim().toLowerCase();
  const filtered = state.workIssues.filter((issue) => {
    if (filter !== "all" && issue.status !== filter) return false;
    if (!query) return true;
    return [issue.key, issue.summary, issue.assigneeName ?? "", ...issue.labels].some((value) => value.toLowerCase().includes(query));
  });
  if (!selectedWorkProject()) {
    workBoard.append(emptyState(state.currentSite ? "Create a project for this space" : "Open a space to manage work"));
    return;
  }
  if (filtered.length === 0) {
    workBoard.append(emptyState("No matching issues"));
    return;
  }
  for (const status of workIssueStatuses) {
    const issues = filtered.filter((issue) => issue.status === status);
    if (issues.length === 0) continue;
    const column = document.createElement("section");
    column.className = "work-column";
    const title = document.createElement("div");
    title.className = "work-column-title";
    title.textContent = `${issueStatusLabel(status)} · ${issues.length}`;
    column.append(title);
    for (const issue of issues) column.append(workIssueRow(issue));
    workBoard.append(column);
  }
}

function workIssueRow(issue: CloudIssue): HTMLElement {
  const row = document.createElement("div");
  row.className = "work-issue-row";
  row.setAttribute("aria-current", String(state.selectedIssue?.id === issue.id));
  const copy = document.createElement("button");
  copy.type = "button";
  copy.className = "work-issue-copy";
  const title = document.createElement("span");
  title.className = "row-title";
  title.textContent = `${issue.key} · ${issue.summary}`;
  const meta = document.createElement("span");
  meta.className = "row-meta";
  meta.textContent = `${issue.type} · ${issue.priority}${issue.assigneeName ? ` · ${issue.assigneeName}` : ""}`;
  copy.append(title, meta);
  copy.addEventListener("click", () => void selectWorkIssue(issue.id));
  const actions = document.createElement("div");
  actions.className = "work-issue-actions";
  const previous = previousIssueStatus(issue.status);
  const next = nextIssueStatus(issue.status);
  if (previous) {
    actions.append(actionButton("←", () => void moveWorkIssue(issue, previous), false, `Move ${issue.key} to ${issueStatusLabel(previous)}`));
  }
  if (next) {
    actions.append(actionButton("→", () => void moveWorkIssue(issue, next), false, `Move ${issue.key} to ${issueStatusLabel(next)}`));
  }
  row.append(copy, actions);
  return row;
}

function renderSelectedWorkIssue(): void {
  issueDetailList.textContent = "";
  if (!state.selectedIssue) {
    selectedIssueSummary.textContent = "Select an issue";
    issueDetailList.append(emptyState("Comments, links, and history appear here"));
    return;
  }
  selectedIssueSummary.textContent = `${state.selectedIssue.key} · ${state.selectedIssue.status.replaceAll("_", " ")}`;
  for (const comment of state.selectedIssue.comments) {
    issueDetailList.append(collaborationRow(comment.createdByName, comment.body, formatDate(comment.createdAt)));
  }
  for (const link of state.selectedIssue.links) {
    issueDetailList.append(collaborationRow(`${link.type} ${link.targetIssueKey}`, link.targetIssueSummary, "issue link"));
  }
  for (const event of state.selectedIssue.events.slice(0, 8)) {
    issueDetailList.append(collaborationRow(event.action.replaceAll(".", " "), event.actorName, formatDate(event.createdAt)));
  }
}

export function selectedWorkProject(): CloudProject | undefined {
  return state.workProjects.find((project) => project.id === workProjectSelect.value);
}

export function selectedWorkSprint(): CloudSprint | undefined {
  return state.workSprints.find((sprint) => sprint.id === manageSprintSelect.value);
}

function issueStatusLabel(status: CloudIssueStatus): string {
  if (status === "todo") return "To do";
  const label = status.replaceAll("_", " ");
  return `${label[0]?.toUpperCase() ?? ""}${label.slice(1)}`;
}

function previousIssueStatus(status: CloudIssueStatus): CloudIssueStatus | undefined {
  if (status === "todo") return "backlog";
  if (status === "in_progress") return "todo";
  if (status === "in_review") return "in_progress";
  if (status === "done") return "todo";
  return undefined;
}

function nextIssueStatus(status: CloudIssueStatus): CloudIssueStatus | undefined {
  if (status === "backlog") return "todo";
  if (status === "todo") return "in_progress";
  if (status === "in_progress") return "in_review";
  if (status === "in_review") return "done";
  return undefined;
}
