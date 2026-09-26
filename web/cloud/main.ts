/** Noma Cloud browser app entry: wires event listeners and boots the app. */
import { installAccountSecurity, openAccountSecurity } from "./account-security.js";
import { installChat } from "./chat.js";
import { installAttachments } from "./attachments.js";
import { installCloudAi } from "./ai.js";
import { installAiPageDrafts } from "./ai-pages.js";
import { addComment, addGroupMember, createGroup, inviteCollaborator, inviteGroup, readAllNotifications, refreshAccessManagement, refreshActivity, refreshApprovals, refreshComments, refreshGroups, refreshNotifications, requestApproval } from "./collaboration.js";
import { panelsOpenStorageKey, themeStorageKey } from "./constants.js";
import { closeContextMenu, showSourceContextMenu } from "./context-menu.js";
import { addCommentButton, addGroupMemberButton, commentBodyInput, addIssueCommentButton, addIssueLinkButton, addLabelButton, applyPatchButton, askNomaButton, askNomaInput, cloudUserNameInput, completeSprintButton, copyArtifactLinkButton, copyLlmButton, copyPageLinkButton, copySiteLinkButton, copyUserIdButton, copyUserTokenButton, createGroupButton, createIssueButton, createProjectButton, createSprintButton, discardDraftButton, favoritePageButton, globalSearchInput, importPageButton, importPageInput, inviteGroupButton, inviteUserButton, issueFilterSelect, issueSearchInput, loginUserButton, logoutUserButton, manageGroupSelect, oidcLoginButton, mergeDraftButton, newFolderButton, newPageButton, newSpaceButton, newUserButton, openPublishedSiteButton, pageTitleInput, previewFrame, previewViewButton, proposePatchButton, readAllNotificationsButton, recoverDraftButton, refreshAccessButton, refreshActivityButton, refreshApprovalsButton, refreshCommentsButton, refreshGroupsButton, refreshHistoryButton, refreshKnowledgeButton, refreshNotificationsButton, refreshPatchProposalsButton, refreshTrashButton, refreshWorkButton, reloadPageButton, requestApprovalButton, savePageButton, saveSpaceButton, searchButton, sourceInput, sourceViewButton, splitResizeHandle, splitViewButton, startSprintButton, visualViewButton, themeToggleButton, togglePanelsButton, watchPageButton, workProjectSelect } from "./dom.js";
import { discardCurrentLocalDraft, mergeLocalDraft, persistLocalDraft, recoverLocalDraft } from "./drafts.js";
import { markDirty, reloadCurrentPage, renderCurrent, saveCurrentPage, scheduleRender, syncTitleFromSource } from "./editor.js";
import { refreshHistory } from "./history.js";
import { applyAgentPatch, askNoma, copyLlmContext, proposeAgentPatch, refreshKnowledgeWorkspace, refreshPatchProposals, renderKnowledgeWorkspace, renderSearchResults, searchCloud } from "./knowledge.js";
import { applyThemeMode, handleSplitResizeKeydown, renderChrome, setViewMode, startSplitResize } from "./layout.js";
import { copyArtifactLink, copyPageLink, copySiteLink, createFolder, createPage, createStarterWorkspace, importPage, openPublishedSite, refreshTrash, replaceFirstHeading, saveCurrentSite, toggleFavorite } from "./navigation.js";
import { addLabel, toggleWatch } from "./page-meta.js";
import { installExportMenu } from "./export.js";
import { installPresentButton } from "./present.js";
import { installSlideStrip } from "./slide-strip.js";
import { installConfluenceImport } from "./import.js";
import { installPreviewEditing } from "./preview.js";
import { installCommentSelectionCapture } from "./comments.js";
import { attachMentionPicker, decoratePreviewMentions } from "./mentions.js";
import { bindSearchFilters } from "./search-filters.js";
import { bindSpaceSettings } from "./spaces.js";
import { bindPageAnalytics } from "./analytics.js";
import { bindTasks, decoratePreviewTasks } from "./tasks.js";
import { bindWebhooks } from "./webhooks.js";
import { bindNotificationSettings } from "./notification-settings.js";
import { installRestrictions } from "./restrictions.js";
import { createCloudUser, initializeCloud, loginCloudUser, logoutCloudUser, registerCloudPwa, startOidcLogin } from "./session.js";
import { installTemplateTools } from "./templates.js";
import { state } from "./state.js";
import { copyText, promptName, setCloudStatus } from "./util.js";
import { visualSourceTyped } from "./visual.js";
import { addWorkIssueComment, addWorkIssueLink, createWorkIssue, createWorkProject, createWorkSprint, loadWorkProject, refreshWorkManagement, renderWorkBoard, updateWorkSprint } from "./work.js";

applyThemeMode();
installConfluenceImport();
installTemplateTools();
installExportMenu();
cloudUserNameInput.value = state.cloudUser?.name ?? "Noma collaborator";
bindEvents();
renderChrome();
registerCloudPwa();
void initializeCloud();

function bindEvents(): void {
  installCloudAi();
  installAiPageDrafts();
  installAccountSecurity();
  installChat();
  document.addEventListener("click", () => closeContextMenu());
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeContextMenu();
  });
  window.addEventListener("resize", () => closeContextMenu());

  newUserButton.addEventListener("click", () => {
    void createCloudUser();
  });

  oidcLoginButton.addEventListener("click", () => {
    startOidcLogin();
  });
  loginUserButton.addEventListener("click", () => {
    void loginCloudUser();
  });

  logoutUserButton.addEventListener("click", () => {
    void logoutCloudUser();
  });

  copyUserIdButton.addEventListener("click", () => {
    if (state.cloudUser) void copyText(state.cloudUser.id, "Copied user ID");
  });

  copyUserTokenButton.addEventListener("click", () => {
    void openAccountSecurity();
  });

  themeToggleButton.addEventListener("click", () => {
    state.themeMode = state.themeMode === "dark" ? "light" : "dark";
    localStorage.setItem(themeStorageKey, state.themeMode);
    applyThemeMode();
    renderChrome();
    renderCurrent();
  });

  newSpaceButton.addEventListener("click", () => {
    void createStarterWorkspace(promptName("Space name", "Research Workspace"));
  });

  saveSpaceButton.addEventListener("click", () => {
    void saveCurrentSite();
  });

  newPageButton.addEventListener("click", () => {
    void createPage();
  });

  newFolderButton.addEventListener("click", () => {
    void createFolder();
  });

  importPageButton.addEventListener("click", () => importPageInput.click());
  importPageInput.addEventListener("change", () => {
    const file = importPageInput.files?.[0];
    if (file) void importPage(file);
    importPageInput.value = "";
  });

  searchButton.addEventListener("click", () => {
    void searchCloud();
  });
  globalSearchInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") void searchCloud();
    if (event.key === "Escape") {
      globalSearchInput.value = "";
      state.cloudSearchResults = [];
      renderSearchResults();
    }
  });
  bindSearchFilters(() => void searchCloud());
  bindSpaceSettings();
  bindPageAnalytics();
  bindTasks();
  bindWebhooks();
  bindNotificationSettings();
  globalSearchInput.addEventListener("input", () => {
    searchButton.disabled = state.busy || !state.cloudUser || !globalSearchInput.value.trim();
    if (!globalSearchInput.value.trim()) {
      state.cloudSearchResults = [];
      renderSearchResults();
    }
  });

  favoritePageButton.addEventListener("click", () => {
    if (state.currentPage) void toggleFavorite("document", state.currentPage.id);
  });

  installPresentButton();
  installSlideStrip();

  watchPageButton.addEventListener("click", () => {
    void toggleWatch();
  });

  addLabelButton.addEventListener("click", () => {
    void addLabel();
  });

  refreshTrashButton.addEventListener("click", () => {
    void refreshTrash();
  });

  savePageButton.addEventListener("click", () => {
    void saveCurrentPage();
  });

  reloadPageButton.addEventListener("click", () => {
    void reloadCurrentPage();
  });

  refreshHistoryButton.addEventListener("click", () => {
    void refreshHistory();
  });

  refreshWorkButton.addEventListener("click", () => void refreshWorkManagement());
  workProjectSelect.addEventListener("change", () => void loadWorkProject(workProjectSelect.value));
  createProjectButton.addEventListener("click", () => void createWorkProject());
  createIssueButton.addEventListener("click", () => void createWorkIssue());
  createSprintButton.addEventListener("click", () => void createWorkSprint());
  startSprintButton.addEventListener("click", () => void updateWorkSprint("active"));
  completeSprintButton.addEventListener("click", () => void updateWorkSprint("closed"));
  issueFilterSelect.addEventListener("change", () => renderWorkBoard());
  issueSearchInput.addEventListener("input", () => renderWorkBoard());
  addIssueCommentButton.addEventListener("click", () => void addWorkIssueComment());
  addIssueLinkButton.addEventListener("click", () => void addWorkIssueLink());

  copyPageLinkButton.addEventListener("click", () => {
    void copyPageLink();
  });

  copyArtifactLinkButton.addEventListener("click", () => {
    void copyArtifactLink();
  });

  copySiteLinkButton.addEventListener("click", () => {
    void copySiteLink();
  });

  openPublishedSiteButton.addEventListener("click", () => {
    void openPublishedSite();
  });

  inviteUserButton.addEventListener("click", () => {
    void inviteCollaborator();
  });

  inviteGroupButton.addEventListener("click", () => {
    void inviteGroup();
  });
  refreshAccessButton.addEventListener("click", () => void refreshAccessManagement());

  refreshNotificationsButton.addEventListener("click", () => void refreshNotifications());
  readAllNotificationsButton.addEventListener("click", () => void readAllNotifications());
  refreshCommentsButton.addEventListener("click", () => void refreshComments());
  addCommentButton.addEventListener("click", () => void addComment());
  refreshApprovalsButton.addEventListener("click", () => void refreshApprovals());
  requestApprovalButton.addEventListener("click", () => void requestApproval());
  refreshActivityButton.addEventListener("click", () => void refreshActivity());
  refreshGroupsButton.addEventListener("click", () => void refreshGroups());
  createGroupButton.addEventListener("click", () => void createGroup());
  addGroupMemberButton.addEventListener("click", () => void addGroupMember());
  manageGroupSelect.addEventListener("change", () => renderChrome());

  applyPatchButton.addEventListener("click", () => {
    void applyAgentPatch();
  });

  proposePatchButton.addEventListener("click", () => void proposeAgentPatch());
  refreshPatchProposalsButton.addEventListener("click", () => void refreshPatchProposals());

  copyLlmButton.addEventListener("click", () => {
    void copyLlmContext();
  });

  askNomaButton.addEventListener("click", () => void askNoma());
  askNomaInput.addEventListener("input", () => renderKnowledgeWorkspace());
  askNomaInput.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" || (!event.metaKey && !event.ctrlKey)) return;
    event.preventDefault();
    void askNoma();
  });
  refreshKnowledgeButton.addEventListener("click", () => void refreshKnowledgeWorkspace());
  recoverDraftButton.addEventListener("click", () => recoverLocalDraft());
  mergeDraftButton.addEventListener("click", () => void mergeLocalDraft());
  discardDraftButton.addEventListener("click", () => discardCurrentLocalDraft());
  window.addEventListener("online", () => {
    state.cloudAvailable = true;
    renderKnowledgeWorkspace();
    void refreshKnowledgeWorkspace();
  });
  window.addEventListener("offline", () => {
    state.cloudAvailable = false;
    renderKnowledgeWorkspace();
    setCloudStatus("Offline — your draft remains editable and cached locally", "warning");
  });

  for (const button of [visualViewButton, sourceViewButton, splitViewButton, previewViewButton]) {
    button.addEventListener("click", () => {
      const mode = button.dataset.viewMode;
      setViewMode(mode === "source" || mode === "preview" || mode === "visual" ? mode : "split");
    });
  }

  togglePanelsButton.addEventListener("click", () => {
    state.panelsOpen = !state.panelsOpen;
    localStorage.setItem(panelsOpenStorageKey, state.panelsOpen ? "true" : "false");
    renderChrome();
  });

  sourceInput.addEventListener("input", () => {
    visualSourceTyped();
    markDirty();
    persistLocalDraft();
    syncTitleFromSource();
    scheduleRender();
  });

  pageTitleInput.addEventListener("input", () => {
    const nextTitle = pageTitleInput.value.trim() || "Untitled Page";
    sourceInput.value = replaceFirstHeading(sourceInput.value, nextTitle);
    if (state.currentPage) state.currentPage = { ...state.currentPage, title: nextTitle, source: sourceInput.value };
    markDirty();
    persistLocalDraft();
    scheduleRender();
  });

  sourceInput.addEventListener("keydown", (event) => {
    if ((!event.metaKey && !event.ctrlKey) || event.key.toLowerCase() !== "s") return;
    event.preventDefault();
    void saveCurrentPage();
  });
  sourceInput.addEventListener("contextmenu", (event) => showSourceContextMenu(event));

  splitResizeHandle.addEventListener("pointerdown", (event) => startSplitResize(event));
  splitResizeHandle.addEventListener("keydown", (event) => handleSplitResizeKeydown(event));

  previewFrame.addEventListener("load", () => installPreviewEditing());
  previewFrame.addEventListener("load", () => decoratePreviewMentions(previewFrame.contentDocument));
  previewFrame.addEventListener("load", () => installCommentSelectionCapture(previewFrame.contentDocument));
  previewFrame.addEventListener("load", () => decoratePreviewTasks(previewFrame.contentDocument));
  attachMentionPicker(commentBodyInput);
  attachMentionPicker(sourceInput);
  installAttachments();
  installRestrictions();
  installPageMoreMenu();
}

/** "Share & export" closes after an action or an outside click, like the AI menu. */
function installPageMoreMenu(): void {
  const menu = document.getElementById("pageMoreMenu");
  if (!(menu instanceof HTMLDetailsElement)) return;
  menu.addEventListener("click", (event) => {
    if (event.target instanceof HTMLElement && event.target.closest("button")) menu.open = false;
  });
  menu.addEventListener("change", () => {
    menu.open = false;
  });
  document.addEventListener("click", (event) => {
    if (menu.open && event.target instanceof Node && !menu.contains(event.target)) menu.open = false;
  });
}
