/** Comments, approvals, notifications, activity, shares, collaborators and groups. */
import { fetchCloudJson } from "./api.js";
import { accessList, activityList, approvalList, approvalNoteInput, approvalReviewerInput, approvalStatus, commentBlockIdInput, commentBodyInput, commentList, commentStatus, groupList, groupMemberIdInput, groupMemberRoleSelect, groupNameInput, groupStatus, inviteGroupSelect, inviteUserIdInput, manageGroupSelect, notificationList, shareStatus } from "./dom.js";
import { currentPageEndpoint, saveCurrentPage } from "./editor.js";
import { refreshPatchProposals } from "./knowledge.js";
import { renderChrome } from "./layout.js";
import { loadSite, loadStandaloneDocument, selectPage } from "./navigation.js";
import { canEditPage, canManagePermissions, selectedInviteRole } from "./permissions.js";
import { readCloudId, state } from "./state.js";
import type { CloudActivityEvent, CloudApproval, CloudCollaboratorGrant, CloudComment, CloudGroup, CloudGroupGrant, CloudNotification, CloudRole, CloudShareGrant, CloudShareResponse } from "./types.js";
import { actionButton, emptyState, errorMessage, formatDate, setBusy, setCloudStatus, setPanelStatus, shortId } from "./util.js";

export async function inviteCollaborator(): Promise<void> {
  const userId = inviteUserIdInput.value.trim();
  if (!readCloudId(userId)) {
    setPanelStatus(shareStatus, "Enter a valid user ID", "error");
    return;
  }
  const role = selectedInviteRole();
  if (!state.currentSite && !state.currentPage) return;

  setBusy(true, "Inviting collaborator", "warning");
  try {
    if (state.currentSite) {
      await postCollaborator(`/api/sites/${encodeURIComponent(state.currentSite.id)}/collaborators`, userId, role);
    } else if (state.currentPage) {
      await postCollaborator(`/api/documents/${encodeURIComponent(state.currentPage.id)}/collaborators`, userId, role);
    }
    inviteUserIdInput.value = "";
    await refreshAccessManagement();
    setPanelStatus(shareStatus, `Invited ${userId} as ${role}`, "ok");
    setCloudStatus("Invited collaborator", "ok");
  } catch (error) {
    setPanelStatus(shareStatus, errorMessage(error), "error");
  } finally {
    setBusy(false);
    renderChrome();
  }
}

async function postCollaborator(url: string, userId: string, role: Exclude<CloudRole, "owner">): Promise<void> {
  await fetchCloudJson<{ collaborators: unknown[] }>(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ userId, role }),
  });
}

export async function refreshAccessManagement(): Promise<void> {
  if (!state.cloudUser || (!state.currentSite && !state.currentPage)) {
    state.collaboratorGrants = [];
    state.groupGrants = [];
    state.shareGrants = [];
    renderAccessManagement();
    return;
  }
  const base = accessTargetEndpoint();
  try {
    if (canManagePermissions()) {
      const [collaborators, groupAccess, shares] = await Promise.all([
        fetchCloudJson<{ collaborators: CloudCollaboratorGrant[] }>(`${base}/collaborators`),
        fetchCloudJson<{ groups: CloudGroupGrant[] }>(`${base}/group-collaborators`),
        fetchCloudJson<{ shares: CloudShareGrant[] }>(`${base}/shares`),
      ]);
      state.collaboratorGrants = collaborators.collaborators;
      state.groupGrants = groupAccess.groups;
      state.shareGrants = shares.shares;
    } else if (canEditPage()) {
      state.collaboratorGrants = [];
      state.groupGrants = [];
      state.shareGrants = (await fetchCloudJson<{ shares: CloudShareGrant[] }>(`${base}/shares`)).shares;
    } else {
      state.collaboratorGrants = [];
      state.groupGrants = [];
      state.shareGrants = [];
    }
  } catch (error) {
    setPanelStatus(shareStatus, errorMessage(error), "error");
  } finally {
    renderAccessManagement();
  }
}

async function removeCollaboratorGrant(userId: string): Promise<void> {
  try {
    await fetchCloudJson(`${accessTargetEndpoint()}/collaborators/${encodeURIComponent(userId)}`, { method: "DELETE" });
    await refreshAccessManagement();
  } catch (error) {
    setPanelStatus(shareStatus, errorMessage(error), "error");
  }
}

async function removeGroupGrant(groupId: string): Promise<void> {
  try {
    await fetchCloudJson(`${accessTargetEndpoint()}/group-collaborators/${encodeURIComponent(groupId)}`, { method: "DELETE" });
    await refreshAccessManagement();
  } catch (error) {
    setPanelStatus(shareStatus, errorMessage(error), "error");
  }
}

async function revokeShareGrant(shareId: string): Promise<void> {
  try {
    await fetchCloudJson(`${accessTargetEndpoint()}/shares/${encodeURIComponent(shareId)}`, { method: "DELETE" });
    await refreshAccessManagement();
  } catch (error) {
    setPanelStatus(shareStatus, errorMessage(error), "error");
  }
}

export function renderAccessManagement(): void {
  accessList.textContent = "";
  const activeShares = state.shareGrants.filter((share) => !share.revokedAt);
  if (state.collaboratorGrants.length === 0 && state.groupGrants.length === 0 && activeShares.length === 0) {
    accessList.append(emptyState(canManagePermissions() || canEditPage() ? "No additional access" : "Owner/editor access required"));
    return;
  }
  for (const grant of state.collaboratorGrants) {
    const row = collaborationRow(`User ${shortId(grant.userId)}`, grant.role, formatDate(grant.addedAt));
    if (grant.role !== "owner") row.append(collaborationActionsWith(actionButton("Remove", () => void removeCollaboratorGrant(grant.userId))));
    accessList.append(row);
  }
  for (const grant of state.groupGrants) {
    const row = collaborationRow(grant.groupName, `group · ${grant.role}`, formatDate(grant.addedAt));
    row.append(collaborationActionsWith(actionButton("Remove", () => void removeGroupGrant(grant.groupId))));
    accessList.append(row);
  }
  for (const share of activeShares) {
    const row = collaborationRow(share.label || "Share link", `${share.role} · ${share.tokenPreview}`, "token link");
    row.append(collaborationActionsWith(actionButton("Revoke", () => void revokeShareGrant(share.id))));
    accessList.append(row);
  }
}

function collaborationActionsWith(...buttons: HTMLButtonElement[]): HTMLElement {
  const actions = collaborationActions();
  actions.append(...buttons);
  return actions;
}

function accessTargetEndpoint(): string {
  if (state.currentSite) return `/api/sites/${encodeURIComponent(state.currentSite.id)}`;
  if (state.currentPage) return `/api/documents/${encodeURIComponent(state.currentPage.id)}`;
  throw new Error("No page or space is selected");
}

export async function inviteGroup(): Promise<void> {
  const groupId = inviteGroupSelect.value;
  if (!groupId || (!state.currentSite && !state.currentPage)) {
    setPanelStatus(shareStatus, "Create or join a group before inviting it", "error");
    return;
  }
  const role = selectedInviteRole();
  const endpoint = state.currentSite
    ? `/api/sites/${encodeURIComponent(state.currentSite.id)}/group-collaborators`
    : `/api/documents/${encodeURIComponent(state.currentPage?.id ?? "")}/group-collaborators`;
  setBusy(true, "Inviting group", "warning");
  try {
    await fetchCloudJson(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ groupId, role }),
    });
    setPanelStatus(shareStatus, `Invited ${groupName(groupId)} as ${role}`, "ok");
    await refreshAccessManagement();
    setCloudStatus("Invited group", "ok");
  } catch (error) {
    setPanelStatus(shareStatus, errorMessage(error), "error");
  } finally {
    setBusy(false);
  }
}

export async function refreshNotifications(): Promise<void> {
  if (!state.cloudUser) {
    state.notifications = [];
    renderNotifications();
    return;
  }
  try {
    const response = await fetchCloudJson<{ notifications: CloudNotification[] }>("/api/notifications");
    state.notifications = response.notifications;
  } catch (error) {
    setCloudStatus(errorMessage(error), "error");
  } finally {
    renderNotifications();
  }
}

export async function readAllNotifications(): Promise<void> {
  if (!state.cloudUser) return;
  try {
    await fetchCloudJson("/api/notifications/read-all", { method: "POST" });
    await refreshNotifications();
  } catch (error) {
    setCloudStatus(errorMessage(error), "error");
  }
}

async function markNotificationRead(notification: CloudNotification): Promise<void> {
  if (!notification.readAt) {
    await fetchCloudJson(`/api/notifications/${encodeURIComponent(notification.id)}/read`, { method: "POST" });
  }
  if (notification.resourceType === "document" && notification.resourceId) {
    if (state.pages.some((page) => page.id === notification.resourceId)) selectPage(notification.resourceId);
    else await loadStandaloneDocument(notification.resourceId);
  } else if (notification.resourceType === "site" && notification.resourceId) {
    await loadSite(notification.resourceId);
  }
  await refreshNotifications();
}

function renderNotifications(): void {
  notificationList.textContent = "";
  if (state.notifications.length === 0) {
    notificationList.append(emptyState("No notifications"));
    return;
  }
  for (const notification of state.notifications.slice(0, 30)) {
    const row = collaborationRow(notification.title, notification.body, `${notification.type.replaceAll("_", " ")} · ${formatDate(notification.createdAt)}`);
    row.dataset.unread = String(!notification.readAt);
    const actions = collaborationActions();
    actions.append(actionButton(notification.readAt ? "Open" : "Read", () => void markNotificationRead(notification)));
    row.append(actions);
    notificationList.append(row);
  }
}

export async function refreshPageCollaboration(): Promise<void> {
  await Promise.all([refreshComments(), refreshApprovals(), refreshActivity(), refreshPatchProposals()]);
}

export async function refreshComments(): Promise<void> {
  if (!state.currentPage) {
    state.comments = [];
    renderComments();
    return;
  }
  const pageId = state.currentPage.id;
  try {
    const response = await fetchCloudJson<{ comments: CloudComment[] }>(`${currentPageEndpoint()}/comments`);
    if (state.currentPage?.id === pageId) state.comments = response.comments;
  } catch (error) {
    setPanelStatus(commentStatus, errorMessage(error), "error");
  } finally {
    renderComments();
  }
}

export async function addComment(parentId?: string, replyBody?: string): Promise<void> {
  if (!state.currentPage) return;
  const body = (replyBody ?? commentBodyInput.value).trim();
  if (!body) {
    setPanelStatus(commentStatus, "Write a comment first", "error");
    return;
  }
  try {
    await fetchCloudJson(`${currentPageEndpoint()}/comments`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        body,
        blockId: parentId ? undefined : commentBlockIdInput.value.trim() || undefined,
        parentId,
      }),
    });
    if (!parentId) {
      commentBodyInput.value = "";
      commentBlockIdInput.value = "";
    }
    setPanelStatus(commentStatus, parentId ? "Reply added" : "Comment added", "ok");
    await Promise.all([refreshComments(), refreshActivity(), refreshNotifications()]);
  } catch (error) {
    setPanelStatus(commentStatus, errorMessage(error), "error");
  }
}

async function replyToComment(comment: CloudComment): Promise<void> {
  const body = window.prompt(`Reply to ${comment.createdByName}`)?.trim();
  if (body) await addComment(comment.id, body);
}

async function toggleCommentResolution(comment: CloudComment): Promise<void> {
  try {
    await fetchCloudJson(`${currentPageEndpoint()}/comments/${encodeURIComponent(comment.id)}/resolve`, { method: "POST" });
    await Promise.all([refreshComments(), refreshActivity()]);
  } catch (error) {
    setPanelStatus(commentStatus, errorMessage(error), "error");
  }
}

function renderComments(): void {
  commentList.textContent = "";
  if (!state.currentPage) {
    commentList.append(emptyState("Select a page"));
    return;
  }
  if (state.comments.length === 0) {
    commentList.append(emptyState("No comments"));
    return;
  }
  for (const comment of state.comments) {
    const target = [comment.blockId ? `#${comment.blockId}` : undefined, comment.line ? `line ${comment.line}` : undefined]
      .filter(Boolean)
      .join(" · ");
    const row = collaborationRow(
      `${comment.parentId ? "↳ " : ""}${comment.createdByName}${comment.resolvedAt ? " · resolved" : ""}`,
      comment.body,
      `${target ? `${target} · ` : ""}${formatDate(comment.createdAt)}`,
    );
    const actions = collaborationActions();
    actions.append(actionButton("Reply", () => void replyToComment(comment)));
    if (comment.createdBy === state.cloudUser?.id || canEditPage()) {
      actions.append(actionButton(comment.resolvedAt ? "Reopen" : "Resolve", () => void toggleCommentResolution(comment)));
    }
    row.append(actions);
    commentList.append(row);
  }
}

export async function refreshApprovals(): Promise<void> {
  if (!state.currentPage) {
    state.approvals = [];
    renderApprovals();
    return;
  }
  const pageId = state.currentPage.id;
  try {
    const response = await fetchCloudJson<{ approvals: CloudApproval[] }>(`${currentPageEndpoint()}/approvals`);
    if (state.currentPage?.id === pageId) state.approvals = response.approvals;
  } catch (error) {
    setPanelStatus(approvalStatus, errorMessage(error), "error");
  } finally {
    renderApprovals();
  }
}

export async function requestApproval(): Promise<void> {
  if (!state.currentPage) return;
  const reviewerId = approvalReviewerInput.value.trim();
  if (!readCloudId(reviewerId)) {
    setPanelStatus(approvalStatus, "Enter a valid reviewer user ID", "error");
    return;
  }
  try {
    await fetchCloudJson(`${currentPageEndpoint()}/approvals`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ reviewerId, note: approvalNoteInput.value.trim() || undefined }),
    });
    approvalReviewerInput.value = "";
    approvalNoteInput.value = "";
    setPanelStatus(approvalStatus, "Approval requested for the current saved version", "ok");
    await Promise.all([refreshApprovals(), refreshActivity()]);
  } catch (error) {
    setPanelStatus(approvalStatus, errorMessage(error), "error");
  }
}

async function updateApproval(approval: CloudApproval, status: Exclude<CloudApproval["status"], "pending">): Promise<void> {
  try {
    await fetchCloudJson(`${currentPageEndpoint()}/approvals/${encodeURIComponent(approval.id)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ status }),
    });
    await Promise.all([refreshApprovals(), refreshActivity(), refreshNotifications()]);
  } catch (error) {
    setPanelStatus(approvalStatus, errorMessage(error), "error");
  }
}

function renderApprovals(): void {
  approvalList.textContent = "";
  if (!state.currentPage) {
    approvalList.append(emptyState("Select a page"));
    return;
  }
  if (state.approvals.length === 0) {
    approvalList.append(emptyState("No approval requests"));
    return;
  }
  for (const approval of state.approvals) {
    const currentVersion = approval.documentHash === state.currentPage.hash;
    const row = collaborationRow(
      `${approval.reviewerName} · ${approval.status.replaceAll("_", " ")}`,
      approval.note || "No review note",
      `${currentVersion ? "current version" : "older version"} · ${approval.documentHash.slice(0, 8)} · ${formatDate(approval.updatedAt)}`,
    );
    if (approval.status === "pending") {
      const actions = collaborationActions();
      if (approval.reviewerId === state.cloudUser?.id) {
        actions.append(
          actionButton("Approve", () => void updateApproval(approval, "approved"), !currentVersion),
          actionButton("Request changes", () => void updateApproval(approval, "changes_requested")),
        );
      }
      if (approval.requestedBy === state.cloudUser?.id) {
        actions.append(actionButton("Cancel", () => void updateApproval(approval, "cancelled")));
      }
      row.append(actions);
    }
    approvalList.append(row);
  }
}

export async function refreshActivity(): Promise<void> {
  if (!state.cloudUser || !state.currentPage) {
    state.activityEvents = [];
    renderActivity();
    return;
  }
  const pageId = state.currentPage.id;
  try {
    const response = await fetchCloudJson<{ events: CloudActivityEvent[] }>(`/api/activity?document=${encodeURIComponent(pageId)}&limit=30`);
    if (state.currentPage?.id === pageId) state.activityEvents = response.events;
  } catch (error) {
    setCloudStatus(errorMessage(error), "error");
  } finally {
    renderActivity();
  }
}

function renderActivity(): void {
  activityList.textContent = "";
  if (state.activityEvents.length === 0) {
    activityList.append(emptyState(state.currentPage ? "No activity" : "Select a page"));
    return;
  }
  for (const event of state.activityEvents) {
    activityList.append(
      collaborationRow(event.action.replaceAll(".", " "), event.actorName, `${event.resourceType} · ${formatDate(event.createdAt)}`),
    );
  }
}

export async function refreshGroups(): Promise<void> {
  if (!state.cloudUser) {
    state.groups = [];
    renderGroups();
    return;
  }
  try {
    const response = await fetchCloudJson<{ groups: CloudGroup[] }>("/api/groups");
    state.groups = response.groups;
  } catch (error) {
    setPanelStatus(groupStatus, errorMessage(error), "error");
  } finally {
    renderGroups();
  }
}

export async function createGroup(): Promise<void> {
  const name = groupNameInput.value.trim();
  if (!name) {
    setPanelStatus(groupStatus, "Enter a group name", "error");
    return;
  }
  try {
    const group = await fetchCloudJson<CloudGroup>("/api/groups", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name }),
    });
    groupNameInput.value = "";
    await refreshGroups();
    manageGroupSelect.value = group.id;
    inviteGroupSelect.value = group.id;
    renderChrome();
    setPanelStatus(groupStatus, `Created ${group.name}`, "ok");
  } catch (error) {
    setPanelStatus(groupStatus, errorMessage(error), "error");
  }
}

export async function addGroupMember(): Promise<void> {
  const groupId = manageGroupSelect.value;
  const userId = groupMemberIdInput.value.trim();
  if (!groupId || !readCloudId(userId)) {
    setPanelStatus(groupStatus, "Choose a group and enter a valid user ID", "error");
    return;
  }
  try {
    await fetchCloudJson(`/api/groups/${encodeURIComponent(groupId)}/members`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userId, role: groupMemberRoleSelect.value }),
    });
    groupMemberIdInput.value = "";
    await refreshGroups();
    setPanelStatus(groupStatus, "Group member updated", "ok");
  } catch (error) {
    setPanelStatus(groupStatus, errorMessage(error), "error");
  }
}

async function removeGroupMember(groupId: string, userId: string): Promise<void> {
  try {
    await fetchCloudJson(`/api/groups/${encodeURIComponent(groupId)}/members/${encodeURIComponent(userId)}`, { method: "DELETE" });
    await refreshGroups();
  } catch (error) {
    setPanelStatus(groupStatus, errorMessage(error), "error");
  }
}

function renderGroups(): void {
  const managedSelection = manageGroupSelect.value;
  const inviteSelection = inviteGroupSelect.value;
  for (const select of [manageGroupSelect, inviteGroupSelect]) select.textContent = "";
  for (const group of state.groups) {
    for (const select of [manageGroupSelect, inviteGroupSelect]) {
      const option = document.createElement("option");
      option.value = group.id;
      option.textContent = group.name;
      select.append(option);
    }
  }
  manageGroupSelect.value = state.groups.some((group) => group.id === managedSelection) ? managedSelection : state.groups[0]?.id ?? "";
  inviteGroupSelect.value = state.groups.some((group) => group.id === inviteSelection) ? inviteSelection : state.groups[0]?.id ?? "";
  groupList.textContent = "";
  const selected = state.groups.find((group) => group.id === manageGroupSelect.value);
  if (!selected) {
    groupList.append(emptyState("No groups"));
    return;
  }
  const isManager = selected.members.some((member) => member.userId === state.cloudUser?.id && member.role === "manager");
  for (const member of selected.members) {
    const row = collaborationRow(member.userName, member.role, shortId(member.userId));
    if (isManager) {
      const actions = collaborationActions();
      actions.append(actionButton("Remove", () => void removeGroupMember(selected.id, member.userId)));
      row.append(actions);
    }
    groupList.append(row);
  }
}

function groupName(groupId: string): string {
  return state.groups.find((group) => group.id === groupId)?.name ?? shortId(groupId);
}

export function selectedGroupManagedByCurrentUser(): boolean {
  return Boolean(
    state.groups
      .find((group) => group.id === manageGroupSelect.value)
      ?.members.some((member) => member.userId === state.cloudUser?.id && member.role === "manager"),
  );
}

export function renderCollaborationPanels(): void {
  renderNotifications();
  renderComments();
  renderApprovals();
  renderActivity();
  renderGroups();
}

export function collaborationRow(titleText: string, bodyText: string, metaText: string): HTMLElement {
  const row = document.createElement("div");
  row.className = "collaboration-row";
  const copy = document.createElement("div");
  copy.className = "collaboration-copy";
  const title = document.createElement("strong");
  title.textContent = titleText;
  const body = document.createElement("span");
  body.textContent = bodyText;
  const meta = document.createElement("span");
  meta.className = "history-meta";
  meta.textContent = metaText;
  copy.append(title, body, meta);
  row.append(copy);
  return row;
}

export function collaborationActions(): HTMLElement {
  const actions = document.createElement("div");
  actions.className = "collaboration-actions";
  return actions;
}

export async function ensureSavedBeforeShare(): Promise<void> {
  if (state.dirty) await saveCurrentPage();
}

export async function createShare(
  url: string,
  role: Exclude<CloudRole, "owner">,
  label: string,
): Promise<CloudShareResponse> {
  const share = await fetchCloudJson<CloudShareResponse>(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ role, label }),
  });
  await refreshAccessManagement();
  return share;
}
