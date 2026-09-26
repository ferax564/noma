/** Cloud connection, cookie-backed user session (register/login/logout), API tokens and workspace bootstrap. */
import { fetchCloudJson } from "./api.js";
import { fetchSignInProviders, forgetCsrfToken, migrateLegacyStoredToken, rememberCsrfToken, signInWithProvider } from "./auth.js";
import { refreshAccessManagement, refreshGroups, refreshNotifications, renderAccessManagement, renderCollaborationPanels } from "./collaboration.js";
import { activeDocumentStorageKey, activeSiteStorageKey, query } from "./constants.js";
import { cloudInvitationCodeInput, cloudUserNameInput, cloudUserTokenInput, favoriteList, oidcLoginButton, recentList, siteTitleInput } from "./dom.js";
import { restoreLatestOfflineDraft } from "./drafts.js";
import { setCurrentPage } from "./editor.js";
import { refreshKnowledgeWorkspace, renderSearchResults } from "./knowledge.js";
import { renderChrome } from "./layout.js";
import { confirmDiscardDirty, createStarterWorkspace, loadSite, loadStandaloneDocument, refreshNavigationItems, refreshSites, refreshTemplates, refreshTrash, renderNavigationList, renderTrashList } from "./navigation.js";
import { refreshMyTasks } from "./tasks.js";
import { readCloudId, shareToken, state, storedUserViewMode } from "./state.js";
import type { CloudAuthResponse, CloudStatusResponse, CloudUserSession } from "./types.js";
import { errorMessage, setBusy, setCloudStatus } from "./util.js";
import { refreshChat } from "./chat.js";
import { refreshWorkManagement, renderWorkManagement } from "./work.js";

export async function initializeCloud(): Promise<void> {
  setBusy(true, "Connecting to cloud", "warning");
  try {
    await migrateLegacyStoredToken();
    const status = await fetchCloudJson<CloudStatusResponse>("/api/status");
    state.cloudAvailable = true;
    applySessionUser(status.user);
    if (!state.cloudUser && !shareToken) {
      clearWorkspaceState();
      const sso = await showSignInProviders();
      setCloudStatus(sso ? `Sign in with ${sso}, or use an existing user token` : "Register with an invitation code or log in with an existing user token", "warning");
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
  const linkedDoc = readCloudId(query.get("doc"));
  const linkedSite = readCloudId(query.get("site"));
  await refreshSites({ silent: true });
  const linkedDocSite = linkedDoc && !linkedSite ? state.sites.find((site) => site.documentIds.includes(linkedDoc))?.id : undefined;
  const requestedSite = linkedSite ?? (linkedDoc ? linkedDocSite : readCloudId(localStorage.getItem(activeSiteStorageKey)));
  const requestedDoc = linkedDoc ?? readCloudId(localStorage.getItem(activeDocumentStorageKey));
  if (requestedSite) {
    await loadSite(requestedSite, requestedDoc);
  } else if (requestedDoc) {
    await loadStandaloneDocument(requestedDoc);
  } else {
    const firstSite = state.sites[0];
    if (firstSite) await loadSite(firstSite.id);
    else await createStarterWorkspace("Research Workspace", "research");
  }
  await refreshWorkspaceTools();
}

function applySessionUser(statusUser: CloudStatusResponse["user"]): void {
  if (statusUser) {
    state.cloudUser = { id: statusUser.id, name: statusUser.name, tokenPreview: statusUser.tokenPreview };
    state.viewMode = storedUserViewMode(state.cloudUser.id) ?? state.viewMode;
    cloudUserNameInput.value = statusUser.name;
    return;
  }
  state.cloudUser = undefined;
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
    void refreshChat();
    renderAccessManagement();
    void refreshMyTasks();
    return;
  }
  await Promise.all([
    refreshMyTasks(),
    refreshTemplates(),
    refreshNavigationItems(),
    refreshTrash(),
    refreshNotifications(),
    refreshGroups(),
    refreshWorkManagement().then(() => refreshChat()),
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
    activateCloudUser(response.user, response.csrfToken);
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

/** Reveals the "Sign in with <label>" button when the server offers OpenID Connect; returns the label. */
async function showSignInProviders(): Promise<string | undefined> {
  const provider = (await fetchSignInProviders()).find((item) => item.type === "oidc");
  oidcLoginButton.hidden = !provider;
  if (!provider) return undefined;
  oidcLoginButton.textContent = `Sign in with ${provider.label}`;
  oidcLoginButton.dataset.startUrl = provider.startUrl;
  return provider.label;
}

export function startOidcLogin(): void {
  const startUrl = oidcLoginButton.dataset.startUrl;
  if (!startUrl) return;
  signInWithProvider({ startUrl }, `${window.location.pathname}${window.location.search}`);
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
    activateCloudUser(response.user, response.csrfToken);
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

function activateCloudUser(user: CloudUserSession, csrfToken: string | undefined): void {
  state.cloudUser = { id: user.id, name: user.name, tokenPreview: user.tokenPreview };
  state.viewMode = storedUserViewMode(state.cloudUser.id) ?? state.viewMode;
  rememberCsrfToken(csrfToken);
  cloudUserNameInput.value = user.name;
}

export async function logoutCloudUser(): Promise<void> {
  if (!confirmDiscardDirty()) return;
  try {
    await fetchCloudJson<{ ok: boolean }>("/api/auth/logout", { method: "POST" });
  } catch (error) {
    setCloudStatus(errorMessage(error), "error");
  }
  forgetCsrfToken();
  state.cloudUser = undefined;
  cloudUserTokenInput.value = "";
  cloudInvitationCodeInput.value = "";
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
