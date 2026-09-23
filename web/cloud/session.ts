/** Cloud connection, user session (register/login/logout) and workspace bootstrap. */
import { fetchCloudJson } from "./api.js";
import { refreshAccessManagement, refreshGroups, refreshNotifications, renderAccessManagement, renderCollaborationPanels } from "./collaboration.js";
import { activeDocumentStorageKey, activeSiteStorageKey, query, userStorageKey } from "./constants.js";
import { cloudInvitationCodeInput, cloudUserNameInput, cloudUserTokenInput, favoriteList, recentList, siteTitleInput } from "./dom.js";
import { restoreLatestOfflineDraft } from "./drafts.js";
import { setCurrentPage } from "./editor.js";
import { refreshKnowledgeWorkspace, renderSearchResults } from "./knowledge.js";
import { renderChrome } from "./layout.js";
import { confirmDiscardDirty, createStarterWorkspace, loadSite, loadStandaloneDocument, refreshNavigationItems, refreshSites, refreshTemplates, refreshTrash, renderNavigationList, renderTrashList } from "./navigation.js";
import { readCloudId, shareToken, state } from "./state.js";
import type { CloudAuthResponse, CloudStatusResponse, CloudUserSession } from "./types.js";
import { errorMessage, setBusy, setCloudStatus } from "./util.js";
import { refreshWorkManagement, renderWorkManagement } from "./work.js";

export async function initializeCloud(): Promise<void> {
  setBusy(true, "Connecting to cloud", "warning");
  try {
    const status = await fetchCloudJson<CloudStatusResponse>("/api/status");
    state.cloudAvailable = true;
    validateStoredCloudUser(status.user);
    if (!state.cloudUser && !shareToken) {
      clearWorkspaceState();
      setCloudStatus("Register with an invitation code or log in with an existing user token", "warning");
      return;
    }

    await openInitialWorkspace();
    setCloudStatus("Ready", "ok");
  } catch (error) {
    state.cloudAvailable = false;
    if (restoreLatestOfflineDraft()) setCloudStatus("Offline draft recovered from this device", "warning");
    else setCloudStatus(errorMessage(error), "error");
  } finally {
    setBusy(false);
    renderChrome();
  }
}

async function openInitialWorkspace(): Promise<void> {
  const requestedSite = readCloudId(query.get("site")) ?? readCloudId(localStorage.getItem(activeSiteStorageKey));
  const requestedDoc = readCloudId(query.get("doc")) ?? readCloudId(localStorage.getItem(activeDocumentStorageKey));
  await refreshSites({ silent: true });
  if (requestedSite) {
    await loadSite(requestedSite, requestedDoc);
  } else if (requestedDoc) {
    await loadStandaloneDocument(requestedDoc);
  } else {
    const firstSite = state.sites[0];
    if (firstSite) await loadSite(firstSite.id);
    else await createStarterWorkspace("Research Workspace");
  }
  await refreshWorkspaceTools();
}

function validateStoredCloudUser(statusUser: CloudStatusResponse["user"]): void {
  if (!state.cloudUser) return;
  if (statusUser && statusUser.id === state.cloudUser.id) {
    state.cloudUser = {
      id: statusUser.id,
      name: statusUser.name,
      token: state.cloudUser.token,
      tokenPreview: statusUser.tokenPreview ?? state.cloudUser.tokenPreview,
    };
    localStorage.setItem(userStorageKey, JSON.stringify(state.cloudUser));
    cloudUserNameInput.value = state.cloudUser.name;
    return;
  }
  state.cloudUser = undefined;
  localStorage.removeItem(userStorageKey);
  localStorage.removeItem(activeSiteStorageKey);
  localStorage.removeItem(activeDocumentStorageKey);
}

export function clearWorkspaceState(): void {
  state.sites = [];
  state.currentSite = undefined;
  state.activeFolder = "";
  state.pages = [];
  state.cloudSearchResults = [];
  state.recentItems = [];
  state.favoriteItems = [];
  state.trashItems = [];
  state.notifications = [];
  state.comments = [];
  state.approvals = [];
  state.activityEvents = [];
  state.groups = [];
  state.workProjects = [];
  state.workIssues = [];
  state.workSprints = [];
  state.selectedIssue = undefined;
  state.patchProposals = [];
  state.collaboratorGrants = [];
  state.groupGrants = [];
  state.shareGrants = [];
  state.askNomaResponse = undefined;
  state.knowledgeHealth = [];
  state.agentInbox = [];
  state.scopedAgents = [];
  state.pendingLocalDraft = undefined;
  setCurrentPage(undefined);
  siteTitleInput.value = "Research Workspace";
  renderWorkspaceTools();
}

export async function refreshWorkspaceTools(): Promise<void> {
  if (!state.cloudUser) {
    state.pageTemplates = [];
    state.recentItems = [];
    state.favoriteItems = [];
    state.trashItems = [];
    state.notifications = [];
    state.groups = [];
    state.workProjects = [];
    state.workIssues = [];
    state.workSprints = [];
    state.selectedIssue = undefined;
    state.patchProposals = [];
    state.collaboratorGrants = [];
    state.groupGrants = [];
    state.shareGrants = [];
    state.askNomaResponse = undefined;
    state.knowledgeHealth = [];
    state.agentInbox = [];
    state.scopedAgents = [];
    renderWorkspaceTools();
    renderCollaborationPanels();
    renderWorkManagement();
    renderAccessManagement();
    return;
  }
  await Promise.all([
    refreshTemplates(),
    refreshNavigationItems(),
    refreshTrash(),
    refreshNotifications(),
    refreshGroups(),
    refreshWorkManagement(),
    refreshAccessManagement(),
    refreshKnowledgeWorkspace(),
  ]);
}

export function renderWorkspaceTools(): void {
  renderNavigationList(favoriteList, state.favoriteItems.slice(0, 8), "No favorites", true);
  renderNavigationList(recentList, state.recentItems.slice(0, 8), "No recent items", false);
  renderTrashList();
  renderSearchResults();
}

export async function createCloudUser(options: { silent?: boolean } = {}): Promise<void> {
  if (!state.cloudAvailable && !options.silent) return;
  setBusy(true, "Creating user", "warning");
  try {
    const response = await fetchCloudJson<CloudAuthResponse>("/api/auth/register", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: cloudUserNameInput.value || "Noma collaborator",
        invitationCode: cloudInvitationCodeInput.value || undefined,
      }),
    });
    if (!response.user) throw new Error("Registration did not return a user session");
    activateCloudUser(response.user);
    cloudInvitationCodeInput.value = "";
    await openInitialWorkspace();
    if (!options.silent) setCloudStatus("Created user", "ok");
  } catch (error) {
    setCloudStatus(errorMessage(error), "error");
  } finally {
    setBusy(false);
    renderChrome();
  }
}

export async function loginCloudUser(): Promise<void> {
  if (!state.cloudAvailable) return;
  const userToken = cloudUserTokenInput.value.trim();
  if (!userToken) {
    setCloudStatus("Enter an existing user token", "error");
    return;
  }
  setBusy(true, "Logging in", "warning");
  try {
    const response = await fetchCloudJson<CloudAuthResponse>("/api/auth/session", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ userToken }),
    });
    if (!response.user) throw new Error("Invalid Noma user token");
    activateCloudUser(response.user);
    cloudUserTokenInput.value = "";
    await openInitialWorkspace();
    setCloudStatus("Logged in", "ok");
  } catch (error) {
    setCloudStatus(errorMessage(error), "error");
  } finally {
    setBusy(false);
    renderChrome();
  }
}

function activateCloudUser(user: CloudUserSession): void {
  state.cloudUser = user;
  localStorage.setItem(userStorageKey, JSON.stringify(user));
  cloudUserNameInput.value = user.name;
}

export function logoutCloudUser(): void {
  if (!confirmDiscardDirty()) return;
  state.cloudUser = undefined;
  cloudUserTokenInput.value = "";
  cloudInvitationCodeInput.value = "";
  localStorage.removeItem(userStorageKey);
  localStorage.removeItem(activeSiteStorageKey);
  localStorage.removeItem(activeDocumentStorageKey);
  clearWorkspaceState();
  setCloudStatus("Signed out", "ok");
  renderChrome();
}

export function registerCloudPwa(): void {
  if (!("serviceWorker" in navigator)) return;
  window.addEventListener("load", () => {
    void navigator.serviceWorker.register("/cloud-sw.js").catch(() => undefined);
  });
}
