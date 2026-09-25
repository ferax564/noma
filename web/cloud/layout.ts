/** View mode, chrome state, theme and split/paper resizing. */
import { renderAiChrome } from "./ai.js";
import { renderAiPagesChrome } from "./ai-pages.js";
import { renderAccessManagement, renderCollaborationPanels, selectedGroupManagedByCurrentUser } from "./collaboration.js";
import { panelsOpenStorageKey, previewPaperWidthStorageKey, splitSourceRatioStorageKey, viewModeStorageKey } from "./constants.js";
import { addCommentButton, addGroupMemberButton, applyPatchButton, approvalNoteInput, approvalReviewerInput, cloudInvitationCodeInput, cloudUserNameInput, cloudUserTokenInput, commentBlockIdInput, commentBodyInput, copyArtifactLinkButton, copyLlmButton, copyPageLinkButton, copySiteLinkButton, presentPageButton, copyUserIdButton, copyUserTokenButton, createGroupButton, dirtyBadge, documentGrid, favoritePageButton, globalSearchInput, groupMemberIdInput, groupMemberRoleSelect, importPageButton, inviteGroupButton, inviteGroupSelect, inviteUserButton, loginUserButton, logoutUserButton, manageGroupSelect, newFolderButton, newPageButton, newSpaceButton, newUserButton, openPublishedSiteButton, pageTemplateSelect, pageTitleInput, previewViewButton, proposePatchButton, readAllNotificationsButton, refreshAccessButton, refreshActivityButton, refreshApprovalsButton, refreshCommentsButton, refreshGroupsButton, refreshNotificationsButton, refreshPatchProposalsButton, refreshTrashButton, reloadPageButton, requestApprovalButton, roleBadge, savePageButton, saveSpaceButton, searchButton, searchScopeSelect, sourceInput, sourceViewButton, splitResizeHandle, splitViewButton, themeToggleButton, togglePanelsButton, updatedText } from "./dom.js";
import { renderCurrent } from "./editor.js";
import { renderExportChrome } from "./export.js";
import { renderHistory } from "./history.js";
import { renderConfluenceImportChrome } from "./import.js";
import { renderKnowledgeWorkspace, renderPatchProposals } from "./knowledge.js";
import { renderNavigation } from "./navigation.js";
import { renderAttachments } from "./attachments.js";
import { renderPageMeta } from "./page-meta.js";
import { renderRestrictionBadge } from "./restrictions.js";
import { canCreatePage, canEditPage, canEditSite, canManagePermissions, currentPageRole, roleRank } from "./permissions.js";
import { renderWorkspaceTools } from "./session.js";
import { renderSpaceSettings } from "./spaces.js";
import { renderPopularPages } from "./analytics.js";
import { renderWebhooksPanel } from "./webhooks.js";
import { renderTemplateToolsChrome } from "./templates.js";
import { state } from "./state.js";
import type { ViewMode } from "./types.js";
import { clamp, formatDate, setCloudStatus } from "./util.js";
import { renderVisualChrome } from "./visual.js";
import { renderWorkManagement } from "./work.js";

export function setViewMode(mode: ViewMode): void {
  state.viewMode = mode;
  if (mode === "preview") state.panelsOpen = false;
  localStorage.setItem(viewModeStorageKey, state.viewMode);
  if (state.cloudUser) localStorage.setItem(`${viewModeStorageKey}:${state.cloudUser.id}`, state.viewMode);
  localStorage.setItem(panelsOpenStorageKey, state.panelsOpen ? "true" : "false");
  renderChrome();
  renderCurrent();
}

export function renderChrome(): void {
  renderAiChrome();
  const shell = document.querySelector<HTMLElement>(".cloud-shell");
  if (shell) {
    shell.dataset.viewMode = state.viewMode;
    shell.dataset.panels = state.panelsOpen ? "open" : "closed";
  }
  documentGrid.style.setProperty("--source-pane-width", `${state.splitSourceRatio}%`);

  cloudUserNameInput.disabled = state.busy;
  cloudInvitationCodeInput.disabled = state.busy || Boolean(state.cloudUser);
  cloudUserTokenInput.disabled = state.busy || Boolean(state.cloudUser);
  newUserButton.disabled = state.busy || !state.cloudAvailable || Boolean(state.cloudUser);
  loginUserButton.disabled = state.busy || !state.cloudAvailable || Boolean(state.cloudUser);
  logoutUserButton.disabled = state.busy || !state.cloudUser;
  copyUserIdButton.disabled = state.busy || !state.cloudUser;
  copyUserTokenButton.disabled = state.busy || !state.cloudUser;
  renderAccountChrome();
  themeToggleButton.textContent = state.themeMode === "dark" ? "Light" : "Dark";
  themeToggleButton.setAttribute("aria-pressed", String(state.themeMode === "dark"));
  newSpaceButton.disabled = state.busy || !state.cloudAvailable || !state.cloudUser;
  saveSpaceButton.disabled = state.busy || !canEditSite();
  newPageButton.disabled = state.busy || !canCreatePage();
  newFolderButton.disabled = state.busy || !canEditSite();
  importPageButton.disabled = state.busy || !canCreatePage();
  pageTemplateSelect.disabled = state.busy || !canCreatePage() || state.pageTemplates.length === 0;
  renderConfluenceImportChrome();
  renderTemplateToolsChrome();
  renderAiPagesChrome();
  renderExportChrome();
  globalSearchInput.disabled = state.busy || !state.cloudUser;
  searchScopeSelect.disabled = state.busy || !state.cloudUser;
  searchButton.disabled = state.busy || !state.cloudUser || !globalSearchInput.value.trim();
  refreshTrashButton.disabled = state.busy || !state.cloudUser;
  savePageButton.disabled = state.busy || !canEditPage() || !state.currentPage;
  reloadPageButton.disabled = state.busy || !state.currentPage;
  favoritePageButton.disabled = state.busy || !state.cloudUser || !state.currentPage;
  sourceInput.disabled = state.busy || !canEditPage();
  pageTitleInput.disabled = state.busy || !canEditPage();
  copyPageLinkButton.disabled = state.busy || !state.currentPage;
  presentPageButton.disabled = !state.currentPage;
  copyArtifactLinkButton.disabled = state.busy || !state.currentPage;
  copySiteLinkButton.disabled = state.busy || !state.currentSite;
  openPublishedSiteButton.disabled = state.busy || !state.currentSite;
  inviteUserButton.disabled = state.busy || !canManagePermissions();
  inviteGroupSelect.disabled = state.busy || !canManagePermissions() || state.groups.length === 0;
  inviteGroupButton.disabled = state.busy || !canManagePermissions() || state.groups.length === 0;
  refreshAccessButton.disabled = state.busy || (!canManagePermissions() && !canEditPage());
  refreshNotificationsButton.disabled = state.busy || !state.cloudUser;
  readAllNotificationsButton.disabled = state.busy || !state.cloudUser || !state.notifications.some((notification) => !notification.readAt);
  refreshCommentsButton.disabled = state.busy || !state.currentPage;
  addCommentButton.disabled = state.busy || !state.currentPage || !state.cloudUser;
  commentBlockIdInput.disabled = state.busy || !state.currentPage;
  commentBodyInput.disabled = state.busy || !state.currentPage;
  refreshApprovalsButton.disabled = state.busy || !state.currentPage;
  requestApprovalButton.disabled = state.busy || !state.currentPage || !canEditPage();
  approvalReviewerInput.disabled = state.busy || !state.currentPage || !canEditPage();
  approvalNoteInput.disabled = state.busy || !state.currentPage || !canEditPage();
  refreshActivityButton.disabled = state.busy || !state.currentPage;
  refreshGroupsButton.disabled = state.busy || !state.cloudUser;
  createGroupButton.disabled = state.busy || !state.cloudUser;
  manageGroupSelect.disabled = state.busy || state.groups.length === 0;
  groupMemberIdInput.disabled = state.busy || !selectedGroupManagedByCurrentUser();
  groupMemberRoleSelect.disabled = state.busy || !selectedGroupManagedByCurrentUser();
  addGroupMemberButton.disabled = state.busy || !selectedGroupManagedByCurrentUser();
  applyPatchButton.disabled = state.busy || !canEditPage();
  proposePatchButton.disabled = state.busy || !canEditPage() || !state.currentPage || state.dirty;
  refreshPatchProposalsButton.disabled = state.busy || !state.currentPage;
  copyLlmButton.disabled = state.busy || Boolean(state.renderState.error) || !state.renderState.llm;
  togglePanelsButton.setAttribute("aria-pressed", String(state.panelsOpen));
  togglePanelsButton.textContent = state.panelsOpen ? "Hide Panels" : "Panels";

  for (const button of [sourceViewButton, splitViewButton, previewViewButton]) {
    button.setAttribute("aria-pressed", String(button.dataset.viewMode === state.viewMode));
  }

  const role = currentPageRole();
  const currentFavorite = Boolean(state.currentPage && state.favoriteItems.some((item) => item.resourceType === "document" && item.resourceId === state.currentPage?.id));
  favoritePageButton.textContent = currentFavorite ? "Unfavorite" : "Favorite";
  favoritePageButton.setAttribute("aria-pressed", String(currentFavorite));
  roleBadge.textContent = role;
  roleBadge.dataset.state = roleRank(role) >= roleRank("editor") ? "ok" : "warning";
  dirtyBadge.textContent = state.dirty ? "unsaved" : "saved";
  dirtyBadge.dataset.state = state.dirty ? "dirty" : "ok";
  updatedText.textContent = state.currentPage ? `Updated ${formatDate(state.currentPage.updatedAt)}` : "";
  renderPageMeta();
  renderRestrictionBadge();
  renderAttachments();

  renderNavigation();
  renderHistory();
  renderWorkspaceTools();
  renderCollaborationPanels();
  renderWorkManagement();
  renderPatchProposals();
  renderAccessManagement();
  renderKnowledgeWorkspace();
  renderSpaceSettings();
  renderPopularPages();
  renderWebhooksPanel();
  renderVisualChrome();
}

export function applyPreviewPaperWidth(previewDoc: Document): void {
  const paper = previewDoc.querySelector<HTMLElement>(".noma-document");
  if (paper) paper.style.maxWidth = `${state.previewPaperWidth}px`;
}

export function startSplitResize(event: PointerEvent): void {
  if (state.viewMode !== "split") return;
  event.preventDefault();
  const rect = documentGrid.getBoundingClientRect();
  documentGrid.dataset.resizing = "true";
  splitResizeHandle.setPointerCapture(event.pointerId);

  const onMove = (moveEvent: PointerEvent): void => {
    const nextRatio = ((moveEvent.clientX - rect.left) / rect.width) * 100;
    setSplitSourceRatio(nextRatio);
  };

  const onUp = (): void => {
    delete documentGrid.dataset.resizing;
    splitResizeHandle.removeEventListener("pointermove", onMove);
    splitResizeHandle.removeEventListener("pointerup", onUp);
    splitResizeHandle.removeEventListener("pointercancel", onUp);
    setCloudStatus("Resized split view", "ok");
  };

  splitResizeHandle.addEventListener("pointermove", onMove);
  splitResizeHandle.addEventListener("pointerup", onUp);
  splitResizeHandle.addEventListener("pointercancel", onUp);
}

export function handleSplitResizeKeydown(event: KeyboardEvent): void {
  if (state.viewMode !== "split") return;
  if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
  event.preventDefault();
  setSplitSourceRatio(state.splitSourceRatio + (event.key === "ArrowRight" ? 3 : -3));
  setCloudStatus("Resized split view", "ok");
}

function setSplitSourceRatio(value: number): void {
  state.splitSourceRatio = Math.round(clamp(value, 30, 66) * 10) / 10;
  localStorage.setItem(splitSourceRatioStorageKey, String(state.splitSourceRatio));
  documentGrid.style.setProperty("--source-pane-width", `${state.splitSourceRatio}%`);
}

export function startPreviewPaperResize(event: PointerEvent, paper: HTMLElement): void {
  event.preventDefault();
  event.stopPropagation();
  const handle = event.currentTarget as HTMLElement | null;
  const startX = event.clientX;
  const startWidth = paper.getBoundingClientRect().width;
  const ownerWindow = paper.ownerDocument.defaultView;
  if (!handle || !ownerWindow) return;
  handle.setPointerCapture(event.pointerId);

  const onMove = (moveEvent: PointerEvent): void => {
    const nextWidth = startWidth + (moveEvent.clientX - startX) * 2;
    setPreviewPaperWidth(nextWidth, paper);
  };

  const onUp = (): void => {
    ownerWindow.removeEventListener("pointermove", onMove);
    ownerWindow.removeEventListener("pointerup", onUp);
    ownerWindow.removeEventListener("pointercancel", onUp);
    setCloudStatus("Resized preview paper", "ok");
  };

  ownerWindow.addEventListener("pointermove", onMove);
  ownerWindow.addEventListener("pointerup", onUp);
  ownerWindow.addEventListener("pointercancel", onUp);
}

export function handlePreviewPaperResizeKeydown(event: KeyboardEvent, paper: HTMLElement): void {
  if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
  event.preventDefault();
  event.stopPropagation();
  setPreviewPaperWidth(state.previewPaperWidth + (event.key === "ArrowRight" ? 40 : -40), paper);
  setCloudStatus("Resized preview paper", "ok");
}

function setPreviewPaperWidth(value: number, paper?: HTMLElement): void {
  state.previewPaperWidth = Math.round(clamp(value, 680, 1280));
  localStorage.setItem(previewPaperWidthStorageKey, String(state.previewPaperWidth));
  if (paper) paper.style.maxWidth = `${state.previewPaperWidth}px`;
}

export function applyThemeMode(): void {
  document.documentElement.dataset.theme = state.themeMode;
  document.documentElement.style.colorScheme = state.themeMode;
}

function renderAccountChrome(): void {
  const signedIn = Boolean(state.cloudUser);
  const auth = document.getElementById("authControls");
  const account = document.getElementById("accountControls");
  if (auth) auth.hidden = signedIn;
  if (account) account.hidden = !signedIn;
  const name = document.getElementById("accountName");
  const avatar = document.getElementById("accountAvatar");
  if (name) name.textContent = state.cloudUser?.name ?? "";
  if (avatar) {
    avatar.textContent = (state.cloudUser?.name ?? "")
      .split(/\s+/)
      .filter(Boolean)
      .slice(0, 2)
      .map((part) => part[0]?.toUpperCase() ?? "")
      .join("");
  }
}
