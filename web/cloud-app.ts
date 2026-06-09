import { walk, type Diagnostic, type DocumentNode } from "../src/ast.js";
import { parse } from "../src/parser.js";
import { patchSource, type PatchOp } from "../src/patch.js";
import { renderHtml } from "../src/renderer-html.js";
import { renderLlm } from "../src/renderer-llm.js";
import { validate } from "../src/validator.js";
import { extractWikilinks, type Wikilink } from "../src/inline.js";
import defaultThemeCss from "../themes/default.css";

type CloudRole = "viewer" | "editor" | "owner";
type PanelState = "ok" | "warning" | "error";
type ViewMode = "source" | "split" | "preview";
type ThemeMode = "light" | "dark";
type PreviewEditKind = "section" | "paragraph" | "list_item" | "quote";
type PreviewInsertKind = "section" | "paragraph";

interface AccessInfo {
  role?: CloudRole;
  via?: string;
}

interface CloudUserSession {
  id: string;
  name: string;
  token: string;
  tokenPreview?: string;
}

interface CloudUserResponse extends CloudUserSession {
  createdAt: string;
  updatedAt: string;
}

interface CloudStatusResponse {
  ok: boolean;
  user?: {
    id: string;
    name: string;
    tokenPreview?: string;
  };
}

interface CloudDocumentResponse {
  id: string;
  title: string;
  source: string;
  hash: string;
  createdAt: string;
  updatedAt: string;
  diagnostics: Diagnostic[];
  access?: AccessInfo;
}

interface CloudSiteResponse {
  id: string;
  title: string;
  slug: string;
  documentIds: string[];
  folders?: string[];
  pageFolders?: Record<string, string>;
  createdAt: string;
  updatedAt: string;
  currentRole?: CloudRole;
  access?: AccessInfo;
  documents?: CloudDocumentResponse[];
}

interface CloudShareResponse {
  id: string;
  role: Exclude<CloudRole, "owner">;
  token: string;
  url: string;
  artifactUrl: string;
}

interface RenderState {
  doc: DocumentNode | null;
  diagnostics: Diagnostic[];
  llm: string;
  error?: Error;
}

interface ContextMenuAction {
  label: string;
  hint?: string;
  disabled?: boolean;
  danger?: boolean;
  separatorBefore?: boolean;
  action: () => void | Promise<void>;
}

interface WikiResolvedLink extends Wikilink {
  page?: CloudDocumentResponse;
  missing: boolean;
}

const userStorageKey = "noma.cloud.user.v1";
const activeSiteStorageKey = "noma.cloud.activeSite.v1";
const activeDocumentStorageKey = "noma.cloud.activeDocument.v1";
const viewModeStorageKey = "noma.cloud.viewMode.v1";
const panelsOpenStorageKey = "noma.cloud.panelsOpen.v1";
const splitSourceRatioStorageKey = "noma.cloud.splitSourceRatio.v1";
const previewPaperWidthStorageKey = "noma.cloud.previewPaperWidth.v1";
const themeStorageKey = "noma.cloud.theme.v1";
const query = new URLSearchParams(window.location.search);

const cloudUserNameInput = requireElement<HTMLInputElement>("cloudUserName");
const newUserButton = requireElement<HTMLButtonElement>("newUserButton");
const copyUserIdButton = requireElement<HTMLButtonElement>("copyUserIdButton");
const copyUserTokenButton = requireElement<HTMLButtonElement>("copyUserTokenButton");
const themeToggleButton = requireElement<HTMLButtonElement>("themeToggleButton");
const cloudStatus = requireElement<HTMLElement>("cloudStatus");
const siteTitleInput = requireElement<HTMLInputElement>("siteTitleInput");
const newSpaceButton = requireElement<HTMLButtonElement>("newSpaceButton");
const saveSpaceButton = requireElement<HTMLButtonElement>("saveSpaceButton");
const siteList = requireElement<HTMLElement>("siteList");
const newPageButton = requireElement<HTMLButtonElement>("newPageButton");
const newFolderButton = requireElement<HTMLButtonElement>("newFolderButton");
const pageList = requireElement<HTMLElement>("pageList");
const pageTitleInput = requireElement<HTMLInputElement>("pageTitleInput");
const roleBadge = requireElement<HTMLElement>("roleBadge");
const dirtyBadge = requireElement<HTMLElement>("dirtyBadge");
const updatedText = requireElement<HTMLElement>("updatedText");
const sourceViewButton = requireElement<HTMLButtonElement>("sourceViewButton");
const splitViewButton = requireElement<HTMLButtonElement>("splitViewButton");
const previewViewButton = requireElement<HTMLButtonElement>("previewViewButton");
const togglePanelsButton = requireElement<HTMLButtonElement>("togglePanelsButton");
const savePageButton = requireElement<HTMLButtonElement>("savePageButton");
const copyPageLinkButton = requireElement<HTMLButtonElement>("copyPageLinkButton");
const copyArtifactLinkButton = requireElement<HTMLButtonElement>("copyArtifactLinkButton");
const copySiteLinkButton = requireElement<HTMLButtonElement>("copySiteLinkButton");
const openPublishedSiteButton = requireElement<HTMLButtonElement>("openPublishedSiteButton");
const documentGrid = requireElement<HTMLElement>("documentGrid");
const splitResizeHandle = requireElement<HTMLElement>("splitResizeHandle");
const sourceInput = requireElement<HTMLTextAreaElement>("sourceInput");
const previewFrame = requireElement<HTMLIFrameElement>("previewFrame");
const shareRoleSelect = requireElement<HTMLSelectElement>("shareRoleSelect");
const inviteUserIdInput = requireElement<HTMLInputElement>("inviteUserIdInput");
const inviteRoleSelect = requireElement<HTMLSelectElement>("inviteRoleSelect");
const inviteUserButton = requireElement<HTMLButtonElement>("inviteUserButton");
const shareStatus = requireElement<HTMLElement>("shareStatus");
const patchInput = requireElement<HTMLTextAreaElement>("patchInput");
const applyPatchButton = requireElement<HTMLButtonElement>("applyPatchButton");
const copyLlmButton = requireElement<HTMLButtonElement>("copyLlmButton");
const agentStatus = requireElement<HTMLElement>("agentStatus");
const diagnosticsSummary = requireElement<HTMLElement>("diagnosticsSummary");
const diagnosticsList = requireElement<HTMLElement>("diagnosticsList");
const outlineList = requireElement<HTMLElement>("outlineList");
const wikiSummary = requireElement<HTMLElement>("wikiSummary");
const wikiLinksList = requireElement<HTMLElement>("wikiLinksList");

let cloudAvailable = false;
let busy = false;
let cloudUser = readCloudUser();
const shareToken = readShareToken();
let sites: CloudSiteResponse[] = [];
let currentSite: CloudSiteResponse | undefined;
let pages: CloudDocumentResponse[] = [];
let currentPage: CloudDocumentResponse | undefined;
let activeFolder = "";
let dirty = false;
let renderTimer: ReturnType<typeof window.setTimeout> | undefined;
let renderState: RenderState = emptyRenderState();
let viewMode: ViewMode = readViewMode();
let panelsOpen = readPanelsOpen();
let splitSourceRatio = readSplitSourceRatio();
let previewPaperWidth = readPreviewPaperWidth();
let themeMode: ThemeMode = readThemeMode();
let pendingPreviewFocusLine: number | undefined;

applyThemeMode();
cloudUserNameInput.value = cloudUser?.name ?? "Noma collaborator";
bindEvents();
renderChrome();
void initializeCloud();

function requireElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing #${id}`);
  return element as T;
}

function bindEvents(): void {
  document.addEventListener("click", () => closeContextMenu());
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeContextMenu();
  });
  window.addEventListener("resize", () => closeContextMenu());

  newUserButton.addEventListener("click", () => {
    void createCloudUser();
  });

  copyUserIdButton.addEventListener("click", () => {
    if (cloudUser) void copyText(cloudUser.id, "Copied user ID");
  });

  copyUserTokenButton.addEventListener("click", () => {
    if (cloudUser) void copyText(cloudUser.token, "Copied user token");
  });

  themeToggleButton.addEventListener("click", () => {
    themeMode = themeMode === "dark" ? "light" : "dark";
    localStorage.setItem(themeStorageKey, themeMode);
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

  savePageButton.addEventListener("click", () => {
    void saveCurrentPage();
  });

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

  applyPatchButton.addEventListener("click", () => {
    void applyAgentPatch();
  });

  copyLlmButton.addEventListener("click", () => {
    void copyLlmContext();
  });

  for (const button of [sourceViewButton, splitViewButton, previewViewButton]) {
    button.addEventListener("click", () => {
      const mode = button.dataset.viewMode;
      setViewMode(mode === "source" || mode === "preview" ? mode : "split");
    });
  }

  togglePanelsButton.addEventListener("click", () => {
    panelsOpen = !panelsOpen;
    localStorage.setItem(panelsOpenStorageKey, panelsOpen ? "true" : "false");
    renderChrome();
  });

  sourceInput.addEventListener("input", () => {
    markDirty();
    syncTitleFromSource();
    scheduleRender();
  });

  pageTitleInput.addEventListener("input", () => {
    const nextTitle = pageTitleInput.value.trim() || "Untitled Page";
    sourceInput.value = replaceFirstHeading(sourceInput.value, nextTitle);
    if (currentPage) currentPage = { ...currentPage, title: nextTitle, source: sourceInput.value };
    markDirty();
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
}

async function initializeCloud(): Promise<void> {
  setBusy(true, "Connecting to cloud", "warning");
  try {
    const status = await fetchCloudJson<CloudStatusResponse>("/api/status");
    cloudAvailable = true;
    validateStoredCloudUser(status.user);
    if (!cloudUser && !shareToken) {
      clearWorkspaceState();
      setCloudStatus("Register with an invitation code or log in with an existing user token", "warning");
      return;
    }

    const requestedSite = readCloudId(query.get("site")) ?? readCloudId(localStorage.getItem(activeSiteStorageKey));
    const requestedDoc = readCloudId(query.get("doc")) ?? readCloudId(localStorage.getItem(activeDocumentStorageKey));

    if (requestedSite) {
      await refreshSites({ silent: true });
      await loadSite(requestedSite, requestedDoc);
    } else if (requestedDoc) {
      await refreshSites({ silent: true });
      await loadStandaloneDocument(requestedDoc);
    } else {
      await refreshSites({ silent: true });
      const firstSite = sites[0];
      if (firstSite) await loadSite(firstSite.id);
      else await createStarterWorkspace("Research Workspace");
    }
    setCloudStatus("Ready", "ok");
  } catch (error) {
    cloudAvailable = false;
    setCloudStatus(errorMessage(error), "error");
  } finally {
    setBusy(false);
    renderChrome();
  }
}

function validateStoredCloudUser(statusUser: CloudStatusResponse["user"]): void {
  if (!cloudUser) return;
  if (statusUser && statusUser.id === cloudUser.id) {
    cloudUser = {
      id: statusUser.id,
      name: statusUser.name,
      token: cloudUser.token,
      tokenPreview: statusUser.tokenPreview ?? cloudUser.tokenPreview,
    };
    localStorage.setItem(userStorageKey, JSON.stringify(cloudUser));
    cloudUserNameInput.value = cloudUser.name;
    return;
  }
  cloudUser = undefined;
  localStorage.removeItem(userStorageKey);
  localStorage.removeItem(activeSiteStorageKey);
  localStorage.removeItem(activeDocumentStorageKey);
}

function clearWorkspaceState(): void {
  sites = [];
  currentSite = undefined;
  activeFolder = "";
  pages = [];
  setCurrentPage(undefined);
  siteTitleInput.value = "Research Workspace";
}

async function refreshSites(options: { silent?: boolean } = {}): Promise<void> {
  if (!cloudUser) return;
  if (!options.silent) setBusy(true, "Loading spaces", "warning");
  try {
    const response = await fetchCloudJson<{ sites: CloudSiteResponse[] }>("/api/sites");
    sites = response.sites.map(normalizeSite);
  } finally {
    if (!options.silent) setBusy(false);
    renderNavigation();
  }
}

async function loadSite(siteId: string, preferredDocumentId?: string): Promise<void> {
  if (!confirmDiscardDirty()) return;
  setBusy(true, "Opening space", "warning");
  try {
    const site = await fetchCloudJson<CloudSiteResponse>(`/api/sites/${encodeURIComponent(siteId)}?include=documents`);
    currentSite = normalizeSite(site);
    pages = site.documents ?? [];
    siteTitleInput.value = currentSite.title;
    localStorage.setItem(activeSiteStorageKey, currentSite.id);
    const selected = preferredDocumentId ? pages.find((page) => page.id === preferredDocumentId) : undefined;
    setCurrentPage(selected ?? pages[0]);
    updateAddress();
    if (cloudUser) await refreshSites({ silent: true });
  } finally {
    setBusy(false);
    renderChrome();
  }
}

async function loadStandaloneDocument(documentId: string): Promise<void> {
  if (!confirmDiscardDirty()) return;
  setBusy(true, "Opening page", "warning");
  try {
    const page = await fetchCloudJson<CloudDocumentResponse>(`/api/documents/${encodeURIComponent(documentId)}`);
    currentSite = undefined;
    activeFolder = "";
    pages = [page];
    siteTitleInput.value = "Standalone Page";
    setCurrentPage(page);
    updateAddress();
  } finally {
    setBusy(false);
    renderChrome();
  }
}

async function createStarterWorkspace(name: string): Promise<void> {
  if (!cloudAvailable) return;
  if (!cloudUser) {
    setCloudStatus("Register a user before creating workspaces", "error");
    return;
  }
  if (!confirmDiscardDirty()) return;

  setBusy(true, "Creating space", "warning");
  try {
    const page = await fetchCloudJson<CloudDocumentResponse>("/api/documents", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: "Research Paper Draft",
        source: starterPage("Research Paper Draft", name),
      }),
    });
    const site = await fetchCloudJson<CloudSiteResponse>("/api/sites", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: name,
        documentIds: [page.id],
        folders: ["Drafts"],
        pageFolders: { [page.id]: "Drafts" },
      }),
    });
    await refreshSites({ silent: true });
    await loadSite(site.id, page.id);
    setCloudStatus("Created space", "ok");
  } catch (error) {
    setCloudStatus(errorMessage(error), "error");
  } finally {
    setBusy(false);
    renderChrome();
  }
}

async function createPage(folder = activeFolder): Promise<void> {
  if (!currentSite) {
    await createStarterWorkspace(promptName("Space name", "Research Workspace"));
    return;
  }
  if (!cloudUser) {
    setCloudStatus("A user token is required to create pages", "error");
    return;
  }
  if (!confirmDiscardDirty()) return;

  const normalizedFolder = normalizeFolderName(folder);
  const title = promptName(normalizedFolder ? `Page title in ${normalizedFolder}` : "Page title", "Untitled Page");
  setBusy(true, "Creating page", "warning");
  try {
    const page = await fetchCloudJson<CloudDocumentResponse>(`/api/sites/${encodeURIComponent(currentSite.id)}/documents`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title,
        source: starterPage(title, currentSite.title),
        folder: normalizedFolder,
      }),
    });
    pages = [...pages, page];
    const documentIds = [...currentSite.documentIds, page.id];
    const pageFolders = normalizedPageFolders({ ...currentSite.pageFolders, ...(normalizedFolder ? { [page.id]: normalizedFolder } : {}) }, documentIds);
    currentSite = {
      ...currentSite,
      documentIds,
      folders: normalizeFolders([...(currentSite.folders ?? []), normalizedFolder, ...Object.values(pageFolders)]),
      pageFolders,
      documents: pages,
    };
    activeFolder = normalizedFolder;
    setCurrentPage(page);
    await refreshSites({ silent: true });
    updateAddress();
    setCloudStatus("Created page", "ok");
  } catch (error) {
    setCloudStatus(errorMessage(error), "error");
  } finally {
    setBusy(false);
    renderChrome();
  }
}

async function createFolder(): Promise<void> {
  if (!currentSite || !canEditSite()) return;
  const folder = promptFolder("Folder name", "Research Notes");
  if (folder === undefined) return;
  if (!folder) {
    setCloudStatus("Folder name required", "error");
    return;
  }
  if (siteFolders(currentSite).some((item) => sameFolder(item, folder))) {
    activeFolder = folder;
    setCloudStatus("Selected folder", "ok");
    renderChrome();
    return;
  }

  currentSite = {
    ...currentSite,
    folders: normalizeFolders([...(currentSite.folders ?? []), folder]),
    pageFolders: normalizedPageFolders(currentSite.pageFolders, currentSite.documentIds),
    documents: pages,
  };
  activeFolder = folder;
  await saveSiteStructure("Created folder");
}

async function renameFolder(folder: string): Promise<void> {
  if (!currentSite || !canEditSite()) return;
  const currentFolder = normalizeFolderName(folder);
  if (!currentFolder) return;
  const nextFolder = promptFolder("Rename folder", currentFolder);
  if (nextFolder === undefined || !nextFolder || sameFolder(currentFolder, nextFolder)) return;

  const pageFolders = normalizedPageFolders(currentSite.pageFolders, currentSite.documentIds);
  for (const [pageId, pageFolder] of Object.entries(pageFolders)) {
    if (sameFolder(pageFolder, currentFolder)) pageFolders[pageId] = nextFolder;
  }
  currentSite = {
    ...currentSite,
    folders: normalizeFolders((currentSite.folders ?? []).map((item) => (sameFolder(item, currentFolder) ? nextFolder : item))),
    pageFolders,
    documents: pages,
  };
  activeFolder = nextFolder;
  await saveSiteStructure("Renamed folder");
}

async function deleteFolder(folder: string): Promise<void> {
  if (!currentSite || !canEditSite()) return;
  const currentFolder = normalizeFolderName(folder);
  if (!currentFolder) return;
  const pagesInFolder = pages.filter((page) => sameFolder(pageFolder(page.id), currentFolder)).length;
  const message = pagesInFolder > 0
    ? `Delete folder "${currentFolder}"? ${pagesInFolder} page${pagesInFolder === 1 ? "" : "s"} will move to Pages.`
    : `Delete folder "${currentFolder}"?`;
  if (!window.confirm(message)) return;

  const pageFolders = normalizedPageFolders(currentSite.pageFolders, currentSite.documentIds);
  for (const [pageId, pageFolder] of Object.entries(pageFolders)) {
    if (sameFolder(pageFolder, currentFolder)) delete pageFolders[pageId];
  }
  currentSite = {
    ...currentSite,
    folders: normalizeFolders((currentSite.folders ?? []).filter((item) => !sameFolder(item, currentFolder))),
    pageFolders,
    documents: pages,
  };
  if (sameFolder(activeFolder, currentFolder)) activeFolder = "";
  await saveSiteStructure("Deleted folder");
}

async function movePage(pageId: string): Promise<void> {
  if (!currentSite || !canEditSite()) return;
  const page = pages.find((item) => item.id === pageId);
  if (!page) return;
  const folder = promptFolder(`Move "${page.title}" to folder`, pageFolder(page.id));
  if (folder === undefined) return;
  await movePageToFolder(pageId, folder);
}

async function movePageToFolder(pageId: string, folder: string): Promise<void> {
  if (!currentSite || !canEditSite()) return;
  const page = pages.find((item) => item.id === pageId);
  if (!page) return;
  const pageFolders = normalizedPageFolders(currentSite.pageFolders, currentSite.documentIds);
  if (folder) pageFolders[page.id] = folder;
  else delete pageFolders[page.id];
  currentSite = {
    ...currentSite,
    folders: normalizeFolders([...(currentSite.folders ?? []), folder, ...Object.values(pageFolders)]),
    pageFolders,
    documents: pages,
  };
  activeFolder = folder;
  await saveSiteStructure(folder ? `Moved page to ${folder}` : "Moved page to Pages");
}

async function saveSiteStructure(status: string): Promise<void> {
  if (!currentSite || !canEditSite()) return;
  setBusy(true, "Saving folders", "warning");
  try {
    const saved = await fetchCloudJson<CloudSiteResponse>(`/api/sites/${encodeURIComponent(currentSite.id)}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: siteTitleInput.value.trim() || currentSite.title,
        documentIds: currentSite.documentIds,
        folders: siteFolders(currentSite),
        pageFolders: normalizedPageFolders(currentSite.pageFolders, currentSite.documentIds),
      }),
    });
    currentSite = { ...normalizeSite(saved), documents: pages };
    sites = sites.map((site) => (site.id === saved.id ? normalizeSite(saved) : site));
    setCloudStatus(status, "ok");
  } catch (error) {
    setCloudStatus(errorMessage(error), "error");
  } finally {
    setBusy(false);
    renderChrome();
  }
}

async function saveCurrentPage(): Promise<void> {
  if (!currentPage || !canEditPage()) return;
  if (renderState.error) {
    setCloudStatus("Fix the render error before saving", "error");
    return;
  }

  setBusy(true, "Saving page", "warning");
  try {
    const endpoint = currentSite?.documentIds.includes(currentPage.id)
      ? `/api/sites/${encodeURIComponent(currentSite.id)}/documents/${encodeURIComponent(currentPage.id)}`
      : `/api/documents/${encodeURIComponent(currentPage.id)}`;
    const saved = await fetchCloudJson<CloudDocumentResponse>(endpoint, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: pageTitleInput.value.trim() || sourceTitle(sourceInput.value),
        source: sourceInput.value,
      }),
    });
    replacePage(saved);
    currentPage = saved;
    dirty = false;
    syncTitleFromSource();
    setCloudStatus("Saved page", "ok");
    updateAddress();
  } catch (error) {
    setCloudStatus(errorMessage(error), "error");
  } finally {
    setBusy(false);
    renderChrome();
  }
}

async function saveCurrentSite(): Promise<void> {
  if (!currentSite || !canEditSite()) return;
  setBusy(true, "Saving space", "warning");
  try {
    const saved = await fetchCloudJson<CloudSiteResponse>(`/api/sites/${encodeURIComponent(currentSite.id)}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: siteTitleInput.value.trim() || currentSite.title,
        documentIds: currentSite.documentIds,
        folders: siteFolders(currentSite),
        pageFolders: normalizedPageFolders(currentSite.pageFolders, currentSite.documentIds),
      }),
    });
    currentSite = { ...normalizeSite(saved), documents: pages };
    sites = sites.map((site) => (site.id === saved.id ? saved : site));
    setCloudStatus("Saved space", "ok");
  } catch (error) {
    setCloudStatus(errorMessage(error), "error");
  } finally {
    setBusy(false);
    renderChrome();
  }
}

async function copyPageLink(): Promise<void> {
  if (!currentPage) return;
  await ensureSavedBeforeShare();
  const role = selectedShareRole();
  const share = await createShare(`/api/documents/${encodeURIComponent(currentPage.id)}/shares`, role, "Noma Cloud page");
  await copyText(cloudAppDocumentUrl(currentPage.id, share.token), `Copied ${role} page link`);
}

async function copyArtifactLink(): Promise<void> {
  if (!currentPage) return;
  await ensureSavedBeforeShare();
  const share = await createShare(`/api/documents/${encodeURIComponent(currentPage.id)}/shares`, "viewer", "Noma rendered artifact");
  await copyText(absoluteUrl(`/d/${currentPage.id}?share=${encodeURIComponent(share.token)}`), "Copied artifact link");
}

async function copySiteLink(): Promise<void> {
  if (!currentSite) return;
  await ensureSavedBeforeShare();
  const role = selectedShareRole();
  const share = await createShare(`/api/sites/${encodeURIComponent(currentSite.id)}/shares`, role, "Noma Cloud space");
  await copyText(cloudAppSiteUrl(currentSite.id, share.token), `Copied ${role} space link`);
}

async function openPublishedSite(): Promise<void> {
  if (!currentSite) return;
  await ensureSavedBeforeShare();
  const share = await createShare(`/api/sites/${encodeURIComponent(currentSite.id)}/shares`, "viewer", "Published site");
  window.open(absoluteUrl(`/s/${currentSite.id}?share=${encodeURIComponent(share.token)}`), "_blank", "noopener");
}

async function inviteCollaborator(): Promise<void> {
  const userId = inviteUserIdInput.value.trim();
  if (!readCloudId(userId)) {
    setPanelStatus(shareStatus, "Enter a valid user ID", "error");
    return;
  }
  const role = selectedInviteRole();
  if (!currentSite && !currentPage) return;

  setBusy(true, "Inviting collaborator", "warning");
  try {
    if (currentSite) {
      await postCollaborator(`/api/sites/${encodeURIComponent(currentSite.id)}/collaborators`, userId, role);
      for (const page of pages) {
        await postCollaborator(`/api/documents/${encodeURIComponent(page.id)}/collaborators`, userId, role);
      }
    } else if (currentPage) {
      await postCollaborator(`/api/documents/${encodeURIComponent(currentPage.id)}/collaborators`, userId, role);
    }
    inviteUserIdInput.value = "";
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

async function applyAgentPatch(): Promise<void> {
  try {
    const ops = parsePatchOps(patchInput.value);
    const nextSource = patchSource(sourceInput.value, ops);
    const nextDoc = parse(nextSource, { filename: `${currentPage?.id ?? "draft"}.noma` });
    const nextDiagnostics = validate(nextDoc);
    const errors = nextDiagnostics.filter((item) => item.severity === "error");
    if (errors.length > 0) {
      throw new Error(`Patch produced ${errors.length} validation error${errors.length === 1 ? "" : "s"}`);
    }
    sourceInput.value = nextSource;
    markDirty();
    syncTitleFromSource();
    renderCurrent();
    setPanelStatus(agentStatus, `Applied ${ops.length} patch op${ops.length === 1 ? "" : "s"}`, "ok");
    setCloudStatus("Applied patch", "ok");
  } catch (error) {
    setPanelStatus(agentStatus, errorMessage(error), "error");
  }
}

async function copyLlmContext(): Promise<void> {
  if (renderState.error || !renderState.llm) {
    setPanelStatus(agentStatus, "Render the page before copying LLM context", "error");
    return;
  }
  await copyText(renderState.llm, "Copied LLM context");
  setPanelStatus(agentStatus, "Copied LLM context", "ok");
}

async function createCloudUser(options: { silent?: boolean } = {}): Promise<void> {
  if (!cloudAvailable && !options.silent) return;
  const invitationCode = promptSecret("Invitation code");
  if (!invitationCode) {
    setCloudStatus("Invitation code required", "error");
    return;
  }
  setBusy(true, "Creating user", "warning");
  try {
    const user = await fetchCloudJson<CloudUserResponse>("/api/users", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: cloudUserNameInput.value || "Noma collaborator", invitationCode }),
    });
    cloudUser = {
      id: user.id,
      name: user.name,
      token: user.token,
      tokenPreview: user.tokenPreview,
    };
    localStorage.setItem(userStorageKey, JSON.stringify(cloudUser));
    cloudUserNameInput.value = cloudUser.name;
    if (!options.silent) setCloudStatus("Created user", "ok");
  } catch (error) {
    setCloudStatus(errorMessage(error), "error");
  } finally {
    setBusy(false);
    renderChrome();
  }
}

async function ensureSavedBeforeShare(): Promise<void> {
  if (dirty) await saveCurrentPage();
}

async function createShare(
  url: string,
  role: Exclude<CloudRole, "owner">,
  label: string,
): Promise<CloudShareResponse> {
  return fetchCloudJson<CloudShareResponse>(url, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ role, label }),
  });
}

function setCurrentPage(page: CloudDocumentResponse | undefined): void {
  currentPage = page;
  if (!page) {
    pageTitleInput.value = "";
    sourceInput.value = "";
    dirty = false;
    renderCurrent();
    renderChrome();
    return;
  }
  pageTitleInput.value = page.title;
  sourceInput.value = page.source;
  activeFolder = pageFolder(page.id);
  dirty = false;
  localStorage.setItem(activeDocumentStorageKey, page.id);
  renderCurrent();
  renderChrome();
}

function replacePage(page: CloudDocumentResponse): void {
  pages = pages.map((item) => (item.id === page.id ? page : item));
  if (currentSite) currentSite = { ...currentSite, documents: pages };
}

function selectPage(pageId: string): boolean {
  if (currentPage?.id === pageId) return true;
  if (!confirmDiscardDirty()) return false;
  const page = pages.find((item) => item.id === pageId);
  if (!page) return false;
  setCurrentPage(page);
  updateAddress();
  return true;
}

function renderCurrent(): void {
  const source = sourceInput.value;
  try {
    const doc = parse(source, { filename: `${currentPage?.id ?? "draft"}.noma` });
    const diagnostics = validate(doc);
    const body = renderHtml(doc, {
      standalone: false,
      allowEscapeHatches: false,
      externalAssets: false,
      interactive: false,
      sourcePositions: true,
    });
    renderState = {
      doc,
      diagnostics,
      llm: renderLlm(doc),
    };
    previewFrame.srcdoc = previewDocument(body);
  } catch (error) {
    renderState = {
      doc: null,
      diagnostics: [],
      llm: "",
      error: error instanceof Error ? error : new Error(String(error)),
    };
    previewFrame.srcdoc = previewError(errorMessage(error));
  }
  renderDiagnostics();
  renderOutline();
  renderWikiPanel();
  renderChrome();
}

function scheduleRender(): void {
  if (renderTimer !== undefined) window.clearTimeout(renderTimer);
  renderTimer = window.setTimeout(() => {
    renderTimer = undefined;
    renderCurrent();
  }, 180);
}

function setViewMode(mode: ViewMode): void {
  viewMode = mode;
  if (mode === "preview") panelsOpen = false;
  localStorage.setItem(viewModeStorageKey, viewMode);
  localStorage.setItem(panelsOpenStorageKey, panelsOpen ? "true" : "false");
  renderChrome();
  renderCurrent();
}

function renderChrome(): void {
  const shell = document.querySelector<HTMLElement>(".cloud-shell");
  if (shell) {
    shell.dataset.viewMode = viewMode;
    shell.dataset.panels = panelsOpen ? "open" : "closed";
  }
  documentGrid.style.setProperty("--source-pane-width", `${splitSourceRatio}%`);

  cloudUserNameInput.disabled = busy;
  newUserButton.disabled = busy || !cloudAvailable;
  copyUserIdButton.disabled = busy || !cloudUser;
  copyUserTokenButton.disabled = busy || !cloudUser;
  themeToggleButton.textContent = themeMode === "dark" ? "Light" : "Dark";
  themeToggleButton.setAttribute("aria-pressed", String(themeMode === "dark"));
  newSpaceButton.disabled = busy || !cloudAvailable || !cloudUser;
  saveSpaceButton.disabled = busy || !canEditSite();
  newPageButton.disabled = busy || !canCreatePage();
  newFolderButton.disabled = busy || !canEditSite();
  savePageButton.disabled = busy || !canEditPage() || !currentPage;
  sourceInput.disabled = busy || !canEditPage();
  pageTitleInput.disabled = busy || !canEditPage();
  copyPageLinkButton.disabled = busy || !currentPage;
  copyArtifactLinkButton.disabled = busy || !currentPage;
  copySiteLinkButton.disabled = busy || !currentSite;
  openPublishedSiteButton.disabled = busy || !currentSite;
  inviteUserButton.disabled = busy || !canManagePermissions();
  applyPatchButton.disabled = busy || !canEditPage();
  copyLlmButton.disabled = busy || Boolean(renderState.error) || !renderState.llm;
  togglePanelsButton.setAttribute("aria-pressed", String(panelsOpen));
  togglePanelsButton.textContent = panelsOpen ? "Hide Panels" : "Panels";

  for (const button of [sourceViewButton, splitViewButton, previewViewButton]) {
    button.setAttribute("aria-pressed", String(button.dataset.viewMode === viewMode));
  }

  const role = currentPageRole();
  roleBadge.textContent = role;
  roleBadge.dataset.state = roleRank(role) >= roleRank("editor") ? "ok" : "warning";
  dirtyBadge.textContent = dirty ? "unsaved" : "saved";
  dirtyBadge.dataset.state = dirty ? "dirty" : "ok";
  updatedText.textContent = currentPage ? `Updated ${formatDate(currentPage.updatedAt)}` : "";

  renderNavigation();
}

function renderNavigation(): void {
  siteList.textContent = "";
  if (sites.length === 0 && !currentSite) {
    siteList.append(emptyState("No spaces"));
  } else {
    for (const site of sites) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "site-row";
      button.setAttribute("aria-current", String(currentSite?.id === site.id));
      button.innerHTML = `<span class="row-title"></span><span class="row-meta"></span>`;
      const title = button.querySelector<HTMLElement>(".row-title");
      const meta = button.querySelector<HTMLElement>(".row-meta");
      if (title) title.textContent = site.title;
      if (meta) meta.textContent = `${site.documentIds.length} page${site.documentIds.length === 1 ? "" : "s"} / ${site.access?.role ?? site.currentRole ?? "viewer"}`;
      button.addEventListener("click", () => {
        void loadSite(site.id);
      });
      button.addEventListener("contextmenu", (event) => showSiteContextMenu(event, site));
      siteList.append(button);
    }
  }

  pageList.textContent = "";
  if (pages.length === 0) {
    pageList.append(emptyState("No pages"));
    return;
  }

  const groups = groupedPages();
  for (const group of groups) {
    pageList.append(folderRow(group.folder, group.pages.length));
    for (const page of group.pages) {
      pageList.append(pageRow(page));
    }
  }
}

function folderRow(folder: string, pageCount: number): HTMLElement {
  const row = document.createElement("div");
  row.className = "folder-row";
  row.setAttribute("aria-current", String(sameFolder(activeFolder, folder)));

  const label = document.createElement("button");
  label.type = "button";
  label.className = "folder-label";
  label.innerHTML = `<span class="row-title"></span><span class="row-meta"></span>`;
  const title = label.querySelector<HTMLElement>(".row-title");
  const meta = label.querySelector<HTMLElement>(".row-meta");
  if (title) title.textContent = folder || "Pages";
  if (meta) meta.textContent = `${pageCount} page${pageCount === 1 ? "" : "s"}`;
  label.addEventListener("click", () => {
    activeFolder = folder;
    setCloudStatus(folder ? `Selected ${folder}` : "Selected Pages", "ok");
    renderChrome();
  });
  row.addEventListener("contextmenu", (event) => showFolderContextMenu(event, folder));

  const actions = document.createElement("div");
  actions.className = "folder-actions";
  const addPage = iconButton("+", folder ? `New page in ${folder}` : "New page in Pages", () => {
    activeFolder = folder;
    void createPage(folder);
  });
  actions.append(addPage);

  if (folder) {
    actions.append(
      iconButton("Rename", `Rename ${folder}`, () => void renameFolder(folder)),
      iconButton("Delete", `Delete ${folder}`, () => void deleteFolder(folder), "danger"),
    );
  }

  row.append(label, actions);
  return row;
}

function pageRow(page: CloudDocumentResponse): HTMLElement {
  const row = document.createElement("div");
  row.className = "page-entry";

  const button = document.createElement("button");
  button.type = "button";
  button.className = "page-row";
  button.setAttribute("aria-current", String(currentPage?.id === page.id));
  button.innerHTML = `<span class="row-title"></span><span class="row-meta"></span>`;
  const title = button.querySelector<HTMLElement>(".row-title");
  const meta = button.querySelector<HTMLElement>(".row-meta");
  if (title) title.textContent = page.title;
  if (meta) meta.textContent = `${shortId(page.id)} / ${page.access?.role ?? currentSite?.access?.role ?? "viewer"}`;
  button.addEventListener("click", () => selectPage(page.id));
  row.addEventListener("contextmenu", (event) => showPageContextMenu(event, page));

  const move = iconButton("Move", `Move ${page.title}`, () => void movePage(page.id));
  move.disabled = busy || !canEditSite();
  row.append(button, move);
  return row;
}

function groupedPages(): Array<{ folder: string; pages: CloudDocumentResponse[] }> {
  const folders = siteFolders(currentSite);
  const rootPages = pages.filter((page) => !pageFolder(page.id));
  return [
    { folder: "", pages: rootPages },
    ...folders.map((folder) => ({ folder, pages: pages.filter((page) => sameFolder(pageFolder(page.id), folder)) })),
  ];
}

function siteFolders(site: CloudSiteResponse | undefined): string[] {
  if (!site) return [];
  return normalizeFolders([...(site.folders ?? []), ...Object.values(site.pageFolders ?? {})]);
}

function normalizeSite(site: CloudSiteResponse): CloudSiteResponse {
  const pageFolders = normalizedPageFolders(site.pageFolders, site.documentIds);
  return {
    ...site,
    folders: normalizeFolders([...(site.folders ?? []), ...Object.values(pageFolders)]),
    pageFolders,
  };
}

function normalizedPageFolders(value: Record<string, string> | undefined, documentIds: string[]): Record<string, string> {
  const allowed = new Set(documentIds);
  const next: Record<string, string> = {};
  for (const [pageId, folder] of Object.entries(value ?? {})) {
    if (!allowed.has(pageId)) continue;
    const normalized = normalizeFolderName(folder);
    if (normalized) next[pageId] = normalized;
  }
  return next;
}

function pageFolder(pageId: string): string {
  return normalizeFolderName(currentSite?.pageFolders?.[pageId] ?? "");
}

function normalizeFolders(values: Array<string | undefined>): string[] {
  const seen = new Set<string>();
  const next: string[] = [];
  for (const value of values) {
    const folder = normalizeFolderName(value ?? "");
    if (!folder) continue;
    const key = folder.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    next.push(folder);
  }
  return next.slice(0, 80);
}

function normalizeFolderName(value: string): string {
  return value
    .replace(/\\/g, "/")
    .split("/")
    .map((part) => part.trim().replace(/\s+/g, " "))
    .filter(Boolean)
    .join("/")
    .slice(0, 80);
}

function sameFolder(left: string, right: string): boolean {
  return normalizeFolderName(left).toLowerCase() === normalizeFolderName(right).toLowerCase();
}

function promptFolder(label: string, fallback = ""): string | undefined {
  const value = window.prompt(label, fallback);
  return value === null ? undefined : normalizeFolderName(value);
}

function iconButton(text: string, title: string, onClick: () => void, variant?: "danger"): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = variant === "danger" ? "row-action row-action-danger" : "row-action";
  button.textContent = text;
  button.title = title;
  button.addEventListener("click", (event) => {
    event.stopPropagation();
    onClick();
  });
  return button;
}

function showContextMenu(event: MouseEvent, actions: ContextMenuAction[]): void {
  event.preventDefault();
  event.stopPropagation();
  showContextMenuAt(event.clientX, event.clientY, actions);
}

function showContextMenuAt(clientX: number, clientY: number, actions: ContextMenuAction[]): void {
  closeContextMenu();
  if (actions.length === 0) return;

  const menu = document.createElement("div");
  menu.className = "cloud-context-menu";
  menu.setAttribute("role", "menu");
  menu.addEventListener("click", (event) => event.stopPropagation());
  menu.addEventListener("pointerdown", (event) => event.stopPropagation());

  for (const item of actions) {
    if (item.separatorBefore) {
      const separator = document.createElement("div");
      separator.className = "cloud-context-menu-separator";
      separator.setAttribute("role", "separator");
      menu.append(separator);
    }

    const button = document.createElement("button");
    button.type = "button";
    button.setAttribute("role", "menuitem");
    button.disabled = item.disabled === true;
    if (item.danger) button.dataset.danger = "true";
    const label = document.createElement("span");
    label.textContent = item.label;
    button.append(label);
    if (item.hint) {
      const hint = document.createElement("span");
      hint.className = "cloud-context-menu-hint";
      hint.textContent = item.hint;
      button.append(hint);
    }
    button.addEventListener("click", () => {
      if (button.disabled) return;
      closeContextMenu();
      void item.action();
    });
    menu.append(button);
  }

  menu.style.visibility = "hidden";
  document.body.append(menu);
  const rect = menu.getBoundingClientRect();
  const left = Math.min(Math.max(8, clientX), Math.max(8, window.innerWidth - rect.width - 8));
  const top = Math.min(Math.max(8, clientY), Math.max(8, window.innerHeight - rect.height - 8));
  menu.style.left = `${left}px`;
  menu.style.top = `${top}px`;
  menu.style.visibility = "visible";
}

function closeContextMenu(): void {
  for (const menu of [...document.querySelectorAll(".cloud-context-menu")]) menu.remove();
}

function showSiteContextMenu(event: MouseEvent, site: CloudSiteResponse): void {
  const isCurrent = currentSite?.id === site.id;
  const canEdit = canEditSiteRecord(site);
  showContextMenu(event, [
    {
      label: isCurrent ? "Refresh space" : "Open space",
      hint: site.documentIds.length === 1 ? "1 page" : `${site.documentIds.length} pages`,
      action: () => void loadSite(site.id),
    },
    {
      label: "New page in space",
      disabled: !canEdit,
      action: () => void runWithLoadedSite(site.id, () => createPage()),
    },
    {
      label: "New folder",
      disabled: !canEdit,
      action: () => void runWithLoadedSite(site.id, () => createFolder()),
    },
    {
      label: "Copy space link",
      disabled: !canEdit,
      separatorBefore: true,
      action: () => void runWithLoadedSite(site.id, () => copySiteLink()),
    },
    {
      label: "Save space",
      disabled: !isCurrent || !canEditSite(),
      action: () => void saveCurrentSite(),
    },
  ]);
}

function showFolderContextMenu(event: MouseEvent, folder: string): void {
  const title = folder || "Pages";
  const sameAsCurrentPage = currentPage ? sameFolder(pageFolder(currentPage.id), folder) : false;
  showContextMenu(event, [
    {
      label: "Select folder",
      hint: title,
      action: () => {
        activeFolder = folder;
        setCloudStatus(folder ? `Selected ${folder}` : "Selected Pages", "ok");
        renderChrome();
      },
    },
    {
      label: "New page here",
      disabled: !canCreatePage(),
      action: () => {
        activeFolder = folder;
        void createPage(folder);
      },
    },
    {
      label: "Move current page here",
      disabled: !currentPage || !canEditSite() || sameAsCurrentPage,
      action: () => {
        if (currentPage) void movePageToFolder(currentPage.id, folder);
      },
    },
    {
      label: "Rename folder",
      disabled: !folder || !canEditSite(),
      separatorBefore: true,
      action: () => void renameFolder(folder),
    },
    {
      label: "Delete folder",
      disabled: !folder || !canEditSite(),
      danger: true,
      action: () => void deleteFolder(folder),
    },
  ]);
}

function showPageContextMenu(event: MouseEvent, page: CloudDocumentResponse): void {
  const isCurrent = currentPage?.id === page.id;
  showContextMenu(event, [
    {
      label: isCurrent ? "Focus page" : "Open page",
      hint: page.access?.role ?? currentSite?.access?.role ?? "viewer",
      action: () => selectPage(page.id),
    },
    {
      label: "Open in preview",
      action: () => {
        if (selectPage(page.id)) setViewMode("preview");
      },
    },
    {
      label: "Move to folder...",
      disabled: !canEditSite(),
      action: () => void movePage(page.id),
    },
    {
      label: activeFolder ? `Move to ${activeFolder}` : "Move to Pages",
      disabled: !canEditSite() || sameFolder(pageFolder(page.id), activeFolder),
      action: () => void movePageToFolder(page.id, activeFolder),
    },
    {
      label: "Copy page link",
      disabled: !currentSite,
      separatorBefore: true,
      action: () => runAfterSelectPage(page.id, () => copyPageLink()),
    },
    {
      label: "Copy artifact link",
      action: () => runAfterSelectPage(page.id, () => copyArtifactLink()),
    },
    {
      label: "Copy page ID",
      action: () => void copyText(page.id, "Copied page ID"),
    },
    {
      label: "Save page",
      disabled: !isCurrent || !canEditPage(),
      separatorBefore: true,
      action: () => void saveCurrentPage(),
    },
  ]);
}

function showOutlineContextMenu(
  event: MouseEvent,
  node: { id?: string; title: string; level: number; line?: number },
): void {
  const line = node.line;
  const canEdit = canEditPage();
  showContextMenu(event, [
    {
      label: "Focus in source",
      disabled: line === undefined,
      hint: line ? `Line ${line}` : undefined,
      action: () => {
        if (line) focusSourceLine(line);
      },
    },
    {
      label: "Insert section after",
      disabled: !canEdit || line === undefined,
      action: () => {
        if (line) insertSourceBlockAtIndex(sectionEndInsertIndex(line), newSectionSource(line), "Added section from outline");
      },
    },
    {
      label: "Insert text after heading",
      disabled: !canEdit || line === undefined,
      action: () => {
        if (line) insertSourceBlockAtIndex(line, "New paragraph.", "Added paragraph from outline");
      },
    },
    {
      label: "Copy block ID",
      disabled: !node.id,
      separatorBefore: true,
      action: () => {
        if (node.id) void copyText(node.id, "Copied block ID");
      },
    },
    {
      label: "Delete section",
      disabled: !canEdit || node.level <= 1 || line === undefined,
      danger: true,
      action: () => deleteSectionAtLine(line),
    },
  ]);
}

function showWikiContextMenu(event: MouseEvent, link: WikiResolvedLink, kind: "link" | "backlink"): void {
  showContextMenu(event, [
    {
      label: link.missing ? "Create linked page" : "Open linked page",
      hint: `[[${link.target}]]`,
      action: () => void openWikiTarget(link.target),
    },
    {
      label: "Open backlink source",
      disabled: kind !== "backlink" || !link.page,
      action: () => {
        if (link.page) selectPage(link.page.id);
      },
    },
    {
      label: "Copy wiki link",
      separatorBefore: true,
      action: () => void copyText(`[[${link.target}]]`, "Copied wiki link"),
    },
    {
      label: "Copy target",
      action: () => void copyText(link.target, "Copied wiki target"),
    },
  ]);
}

function showSourceContextMenu(event: MouseEvent): void {
  showContextMenu(event, [
    {
      label: "Insert section at cursor",
      disabled: !canEditPage(),
      action: () => insertSectionAtCursor(),
    },
    {
      label: "Insert text at cursor",
      disabled: !canEditPage(),
      action: () => insertParagraphAtCursor(),
    },
    {
      label: "Save page",
      disabled: !canEditPage() || !currentPage,
      separatorBefore: true,
      hint: "Cmd/Ctrl S",
      action: () => void saveCurrentPage(),
    },
    {
      label: "Copy LLM context",
      disabled: Boolean(renderState.error) || !renderState.llm,
      action: () => void copyLlmContext(),
    },
    {
      label: "Preview only",
      separatorBefore: true,
      action: () => setViewMode("preview"),
    },
    {
      label: "Split view",
      action: () => setViewMode("split"),
    },
  ]);
}

function canEditSiteRecord(site: CloudSiteResponse): boolean {
  const role = cloudRole(site.access?.role ?? site.currentRole);
  return Boolean(cloudAvailable && cloudUser && roleRank(role) >= roleRank("editor"));
}

function cloudRole(value: unknown): CloudRole {
  return value === "owner" || value === "editor" || value === "viewer" ? value : "viewer";
}

async function runWithLoadedSite(siteId: string, action: () => void | Promise<void>): Promise<void> {
  if (currentSite?.id !== siteId) await loadSite(siteId);
  if (currentSite?.id === siteId) await action();
}

function runAfterSelectPage(pageId: string, action: () => void | Promise<void>): void {
  if (!selectPage(pageId)) return;
  void action();
}

function renderDiagnostics(): void {
  diagnosticsList.textContent = "";
  if (renderState.error) {
    diagnosticsSummary.textContent = "Render failed";
    diagnosticsSummary.dataset.state = "error";
    diagnosticsList.append(diagnosticRow("error", "render", renderState.error.message));
    return;
  }

  const errors = renderState.diagnostics.filter((item) => item.severity === "error").length;
  const warnings = renderState.diagnostics.filter((item) => item.severity === "warning").length;
  const infos = renderState.diagnostics.filter((item) => item.severity === "info").length;
  diagnosticsSummary.textContent = `${errors} errors / ${warnings} warnings / ${infos} info`;
  diagnosticsSummary.dataset.state = errors > 0 ? "error" : warnings > 0 ? "warning" : "ok";

  if (renderState.diagnostics.length === 0) {
    diagnosticsList.append(emptyState("No diagnostics"));
    return;
  }

  for (const item of renderState.diagnostics) {
    diagnosticsList.append(diagnosticRow(item.severity, item.code, item.message, item.pos?.line));
  }
}

function renderOutline(): void {
  outlineList.textContent = "";
  const doc = renderState.doc;
  if (!doc) {
    outlineList.append(emptyState("No outline"));
    return;
  }

  let count = 0;
  for (const node of walk(doc)) {
    if (node.type !== "section") continue;
    count += 1;
    const row = document.createElement("div");
    row.className = "outline-row";
    row.style.paddingLeft = `${Math.min(node.level - 1, 4) * 10 + 9}px`;
    if (node.pos?.line) row.dataset.line = String(node.pos.line);
    const title = document.createElement("span");
    title.className = "row-title";
    title.textContent = node.title;
    const meta = document.createElement("span");
    meta.className = "row-meta";
    meta.textContent = node.id ?? `h${node.level}`;
    row.addEventListener("click", () => {
      if (node.pos?.line) focusSourceLine(node.pos.line);
    });
    row.addEventListener("contextmenu", (event) => showOutlineContextMenu(event, {
      id: node.id,
      title: node.title,
      level: node.level,
      line: node.pos?.line,
    }));
    row.append(title, meta);
    if (node.level > 1 && node.pos?.line && canEditPage()) {
      const deleteButton = iconButton("Delete", `Delete ${node.title}`, () => deleteSectionAtLine(node.pos?.line), "danger");
      row.append(deleteButton);
    }
    outlineList.append(row);
  }

  if (count === 0) outlineList.append(emptyState("No outline"));
}

function renderWikiPanel(): void {
  wikiLinksList.textContent = "";
  if (!currentPage) {
    wikiSummary.textContent = "No wiki links";
    wikiSummary.dataset.state = "ok";
    wikiLinksList.append(emptyState("No page"));
    return;
  }

  const outgoing = wikiLinksForPage(currentPage);
  const backlinks = pages
    .filter((page) => page.id !== currentPage?.id)
    .flatMap((page) => wikiLinksForPage(page).filter((link) => link.page?.id === currentPage?.id).map((link) => ({ page, link })));
  const missing = outgoing.filter((link) => link.missing);
  wikiSummary.textContent = `${outgoing.length} links / ${backlinks.length} backlinks / ${missing.length} missing`;
  wikiSummary.dataset.state = missing.length > 0 ? "warning" : "ok";

  if (outgoing.length > 0) {
    wikiLinksList.append(wikiLabel("Links"));
    for (const link of outgoing) wikiLinksList.append(wikiLinkRow(link));
  }

  if (backlinks.length > 0) {
    wikiLinksList.append(wikiLabel("Backlinks"));
    for (const item of backlinks) {
      wikiLinksList.append(wikiLinkRow({ ...item.link, page: item.page, missing: false }, "backlink"));
    }
  }

  if (outgoing.length === 0 && backlinks.length === 0) {
    wikiLinksList.append(emptyState("No wiki links on this page"));
  }
}

function wikiLabel(text: string): HTMLElement {
  const label = document.createElement("div");
  label.className = "wiki-section-label";
  label.textContent = text;
  return label;
}

function wikiLinkRow(link: WikiResolvedLink, kind: "link" | "backlink" = "link"): HTMLElement {
  const row = document.createElement("button");
  row.type = "button";
  row.className = "wiki-row";
  row.dataset.kind = kind;
  row.dataset.state = link.missing ? "missing" : "resolved";
  row.innerHTML = `<span class="row-title"></span><span class="row-meta"></span>`;
  const title = row.querySelector<HTMLElement>(".row-title");
  const meta = row.querySelector<HTMLElement>(".row-meta");
  if (title) title.textContent = link.page?.title ?? link.label;
  if (meta) meta.textContent = link.missing ? `Create [[${link.target}]]` : kind === "backlink" ? `Linked from ${link.page?.title ?? "page"}` : `Open [[${link.target}]]`;
  row.addEventListener("click", () => {
    if (kind === "backlink" && link.page) {
      selectPage(link.page.id);
      return;
    }
    void openWikiTarget(link.target);
  });
  row.addEventListener("contextmenu", (event) => showWikiContextMenu(event, link, kind));
  return row;
}

function wikiLinksForPage(page: CloudDocumentResponse): WikiResolvedLink[] {
  return extractWikilinks(stripFencedCode(page.source)).map((link) => {
    const resolved = resolveWikiPage(link.target) ?? resolveWikiBlockPage(link.target);
    return {
      ...link,
      ...(resolved ? { page: resolved } : {}),
      missing: !resolved,
    };
  });
}

function installPreviewWikiLinks(previewDoc: Document): void {
  for (const anchor of [...previewDoc.querySelectorAll<HTMLAnchorElement>("a.noma-ref[href^='#']")]) {
    const target = decodeWikiHrefTarget(anchor.getAttribute("href") ?? "");
    if (!target) continue;
    const page = resolveWikiPage(target) ?? resolveWikiBlockPage(target);
    if (page || canCreatePage()) {
      anchor.dataset.nomaWikiTarget = target;
      anchor.title = page ? `Open ${page.title}` : `Create ${target}`;
    }
    anchor.addEventListener("click", (event) => {
      const currentBlock = target.split("#", 1)[0] ?? target;
      if (!page && hasCurrentDocumentBlock(currentBlock)) return;
      event.preventDefault();
      event.stopPropagation();
      void openWikiTarget(target);
    });
  }
}

async function openWikiTarget(target: string): Promise<void> {
  const page = resolveWikiPage(target) ?? resolveWikiBlockPage(target);
  if (page) {
    selectPage(page.id);
    return;
  }
  if (!canCreatePage()) {
    setCloudStatus(`Missing page: ${target}`, "warning");
    return;
  }
  await createWikiPage(wikiPageTitleFromTarget(target));
}

async function createWikiPage(title: string): Promise<void> {
  if (!currentSite || !cloudUser) return;
  if (dirty) await saveCurrentPage();
  setBusy(true, "Creating wiki page", "warning");
  try {
    const page = await fetchCloudJson<CloudDocumentResponse>(`/api/sites/${encodeURIComponent(currentSite.id)}/documents`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title,
        source: wikiPage(title, currentSite.title, currentPage?.title ?? currentSite.title),
      }),
    });
    pages = [...pages, page];
    currentSite = {
      ...currentSite,
      documentIds: [...currentSite.documentIds, page.id],
      documents: pages,
    };
    setCurrentPage(page);
    await refreshSites({ silent: true });
    updateAddress();
    setCloudStatus(`Created wiki page: ${title}`, "ok");
  } catch (error) {
    setCloudStatus(errorMessage(error), "error");
  } finally {
    setBusy(false);
    renderChrome();
  }
}

function resolveWikiPage(target: string): CloudDocumentResponse | undefined {
  const base = wikiPageTitleFromTarget(target);
  const key = wikiKey(base);
  const slugKey = slug(base);
  return pages.find((page) => {
    const title = sourceTitle(page.source) || page.title;
    return (
      wikiKey(page.id) === key ||
      wikiKey(page.title) === key ||
      wikiKey(title) === key ||
      slug(page.title) === slugKey ||
      slug(title) === slugKey
    );
  });
}

function resolveWikiBlockPage(target: string): CloudDocumentResponse | undefined {
  const base = wikiPageTitleFromTarget(target);
  const key = wikiKey(base);
  for (const page of pages) {
    try {
      const doc = parse(page.source, { filename: `${page.id}.noma` });
      for (const node of walk(doc)) {
        if (wikiKey(node.id ?? "") === key || (node.aliases ?? []).some((alias) => wikiKey(alias) === key)) return page;
      }
    } catch {
      continue;
    }
  }
  return undefined;
}

function hasCurrentDocumentBlock(target: string): boolean {
  const doc = renderState.doc;
  if (!doc) return false;
  for (const node of walk(doc)) {
    if (node.id === target || node.aliases?.includes(target)) return true;
  }
  return false;
}

function decodeWikiHrefTarget(href: string): string {
  if (!href.startsWith("#")) return "";
  const raw = href.slice(1);
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

function wikiPageTitleFromTarget(target: string): string {
  return (target.split("#", 1)[0] || target).trim();
}

function wikiKey(value: string): string {
  return value.trim().toLowerCase().replace(/\.noma$/i, "").replace(/\s+/g, " ");
}

function stripFencedCode(source: string): string {
  return source.replace(/```[\s\S]*?```/g, "");
}

function diagnosticRow(severity: Diagnostic["severity"], code: string, message: string, line?: number): HTMLElement {
  const row = document.createElement("div");
  row.className = "diagnostic-row";
  row.dataset.severity = severity;
  const title = document.createElement("span");
  title.className = "row-title";
  title.textContent = `${severity} / ${code}`;
  const meta = document.createElement("span");
  meta.className = "row-meta";
  meta.textContent = line ? `Line ${line}: ${message}` : message;
  row.append(title, meta);
  return row;
}

function emptyState(text: string): HTMLElement {
  const row = document.createElement("div");
  row.className = "empty-state";
  row.textContent = text;
  return row;
}

function markDirty(): void {
  dirty = true;
  if (currentPage) currentPage = { ...currentPage, source: sourceInput.value, title: pageTitleInput.value.trim() || sourceTitle(sourceInput.value) };
  renderChrome();
}

function syncTitleFromSource(): void {
  if (document.activeElement === pageTitleInput) return;
  const title = sourceTitle(sourceInput.value);
  pageTitleInput.value = title;
  if (currentPage) currentPage = { ...currentPage, title };
}

function canEditPage(): boolean {
  return roleRank(currentPageRole()) >= roleRank("editor");
}

function canCreatePage(): boolean {
  return Boolean(cloudAvailable && cloudUser && currentSite && roleRank(currentSite.access?.role ?? "viewer") >= roleRank("editor"));
}

function canEditSite(): boolean {
  return Boolean(cloudAvailable && cloudUser && currentSite && roleRank(currentSite.access?.role ?? "viewer") >= roleRank("editor"));
}

function canManagePermissions(): boolean {
  const role = currentSite?.access?.role ?? currentPage?.access?.role ?? "viewer";
  return role === "owner";
}

function currentPageRole(): CloudRole {
  return currentPage?.access?.role ?? currentSite?.access?.role ?? "viewer";
}

function selectedShareRole(): Exclude<CloudRole, "owner"> {
  return shareRoleSelect.value === "viewer" ? "viewer" : "editor";
}

function selectedInviteRole(): Exclude<CloudRole, "owner"> {
  return inviteRoleSelect.value === "viewer" ? "viewer" : "editor";
}

function roleRank(role: CloudRole): number {
  return role === "owner" ? 3 : role === "editor" ? 2 : 1;
}

async function fetchCloudJson<T>(url: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  headers.set("accept", "application/json");
  if (cloudUser) headers.set("authorization", `Bearer ${cloudUser.token}`);
  if (shareToken) headers.set("x-noma-share-token", shareToken);
  const response = await fetch(url, {
    ...init,
    headers,
  });
  if (!response.ok) {
    let message = `${response.status} ${response.statusText}`;
    const text = await response.text();
    try {
      const payload = JSON.parse(text) as { error?: string };
      if (payload.error) message = payload.error;
    } catch {
      if (text) message = text;
    }
    if (response.status === 401 && message.includes("Noma Cloud access token required")) {
      const next = `${window.location.pathname}${window.location.search}`;
      window.location.assign(`/login.html?next=${encodeURIComponent(next)}`);
    }
    throw new Error(message);
  }
  return response.json() as Promise<T>;
}

function parsePatchOps(text: string): PatchOp[] {
  const parsed = JSON.parse(text) as unknown;
  const list = Array.isArray(parsed) ? parsed : [parsed];
  for (const item of list) {
    if (!item || typeof item !== "object" || typeof (item as { op?: unknown }).op !== "string") {
      throw new Error("Patch operations must be objects with an op field");
    }
  }
  return list as PatchOp[];
}

function previewDocument(body: string): string {
  const previewChrome = themeMode === "dark" ? "#111820" : "#f4f1e9";
  const previewBorder = themeMode === "dark" ? "#37323d" : "#e6dfd2";
  const previewShadow =
    themeMode === "dark"
      ? "0 24px 70px -46px rgba(0,0,0,.86)"
      : "0 24px 70px -46px rgba(32,36,42,.42)";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<style>
${defaultThemeCss}
body{margin:0;padding:28px;background:${previewChrome};color:#20242a}
.noma-document{max-width:${previewPaperWidth}px;margin:0 auto;background:#fffefa;border:1px solid ${previewBorder};box-shadow:${previewShadow};padding:44px 52px}
@media(max-width:720px){body{padding:14px}.noma-document{padding:24px 20px}}
</style>
</head>
<body><main class="noma-document">${body}</main></body>
</html>`;
}

function installPreviewEditing(): void {
  const previewDoc = previewFrame.contentDocument;
  if (!previewDoc) return;
  applyPreviewPaperWidth(previewDoc);
  installPreviewWikiLinks(previewDoc);
  if (!renderState.error && canEditPage()) installPreviewContextMenus(previewDoc);
  if (viewMode !== "preview" || renderState.error || !canEditPage()) return;

  const style = previewDoc.createElement("style");
  style.textContent = previewEditCss();
  previewDoc.head.append(style);

  let selectedElement: HTMLElement | undefined;
  const toolbar = createPreviewToolbar(previewDoc, (kind) => {
    if (!selectedElement) return;
    insertPreviewBlockAfter(selectedElement, kind);
  }, () => {
    if (!selectedElement) return;
    deletePreviewSection(selectedElement);
  });

  const selectElement = (element: HTMLElement): void => {
    if (selectedElement && selectedElement !== element) selectedElement.classList.remove("noma-preview-selected");
    selectedElement = element;
    selectedElement.classList.add("noma-preview-selected");
    toolbar.dataset.selectedKind = element.dataset.nomaEditable ?? "";
    placePreviewToolbar(toolbar, selectedElement);
  };

  previewDoc.addEventListener("scroll", () => {
    if (selectedElement) placePreviewToolbar(toolbar, selectedElement);
  });

	  for (const element of [...previewDoc.querySelectorAll<HTMLElement>("[data-noma-editable]")]) {
    const kind = element.dataset.nomaEditable;
    if (!isPreviewEditKind(kind)) continue;
    element.contentEditable = "true";
    element.spellcheck = true;
    element.tabIndex = 0;
    element.dataset.nomaOriginalText = editableText(element);
    element.addEventListener("click", (event) => {
      event.stopPropagation();
      selectElement(element);
    });
    element.addEventListener("focus", () => {
      element.dataset.nomaEditing = "true";
      selectElement(element);
    });
    element.addEventListener("blur", () => {
      delete element.dataset.nomaEditing;
      commitPreviewEdit(element);
    });
    element.addEventListener("keydown", (event) => handlePreviewEditKeydown(event, element));
    element.addEventListener("paste", (event) => pastePlainText(event, element));
  }

  previewDoc.addEventListener("click", (event) => {
    const view = previewDoc.defaultView;
    const target = view && event.target instanceof view.Element ? event.target : undefined;
    if (target?.closest(".noma-preview-toolbar, .noma-preview-resize-handle, .noma-preview-end-add")) return;
    if (selectedElement) selectedElement.classList.remove("noma-preview-selected");
    selectedElement = undefined;
    toolbar.dataset.visible = "false";
  });

  installPreviewPaperResize(previewDoc);
  installPreviewEndAdd(previewDoc);
	  focusPendingPreviewLine(previewDoc);
	}

function installPreviewContextMenus(previewDoc: Document): void {
  previewDoc.addEventListener("click", () => closeContextMenu());
  previewDoc.addEventListener("keydown", (event) => {
    if (event.key === "Escape") closeContextMenu();
  });

  for (const element of [...previewDoc.querySelectorAll<HTMLElement>("[data-noma-editable]")]) {
    const kind = element.dataset.nomaEditable;
    if (!isPreviewEditKind(kind)) continue;
    element.addEventListener("contextmenu", (event) => {
      event.preventDefault();
      event.stopPropagation();
      const frameRect = previewFrame.getBoundingClientRect();
      showPreviewContextMenuAt(frameRect.left + event.clientX, frameRect.top + event.clientY, element);
    });
  }
}

function showPreviewContextMenuAt(clientX: number, clientY: number, element: HTMLElement): void {
  const line = positiveInt(element.dataset.nomaLine);
  const kind = element.dataset.nomaEditable;
  const blockId = previewElementBlockId(element);
  showContextMenuAt(clientX, clientY, [
    {
      label: "Edit in source",
      disabled: line === undefined,
      hint: line ? `Line ${line}` : undefined,
      action: () => {
        if (line) focusSourceLine(line);
      },
    },
    {
      label: "Add section after",
      action: () => insertPreviewBlockAfter(element, "section"),
    },
    {
      label: "Add text after",
      action: () => insertPreviewBlockAfter(element, "paragraph"),
    },
    {
      label: "Copy block ID",
      disabled: !blockId,
      separatorBefore: true,
      action: () => {
        if (blockId) void copyText(blockId, "Copied block ID");
      },
    },
    {
      label: "Delete section",
      disabled: kind !== "section",
      danger: true,
      action: () => deletePreviewSection(element),
    },
  ]);
}

function previewElementBlockId(element: HTMLElement): string | undefined {
  const owned = element.closest<HTMLElement>("[id]");
  return owned?.id || element.closest<HTMLElement>("section[id]")?.id;
}

function previewEditCss(): string {
  return `
.noma-document {
  position: relative;
}
[data-noma-editable][contenteditable="true"] {
  cursor: text;
  outline: 1px dashed rgba(15, 102, 107, 0.36);
  outline-offset: 5px;
  border-radius: 3px;
}
[data-noma-editable][contenteditable="true"]:hover {
  outline-color: rgba(15, 102, 107, 0.62);
}
[data-noma-editable][data-noma-editing="true"] {
  background: rgba(237, 247, 245, 0.72);
  outline: 2px solid #0f666b;
}
[data-noma-editable].noma-preview-selected:not([data-noma-editing="true"]) {
  outline: 2px solid rgba(15, 102, 107, 0.64);
}
.noma-preview-toolbar {
  position: fixed;
  z-index: 50;
  display: none;
  align-items: center;
  gap: 4px;
  padding: 4px;
  border: 1px solid rgba(15, 102, 107, 0.28);
  border-radius: 8px;
  background: rgba(255, 253, 248, 0.96);
  box-shadow: 0 14px 34px -24px rgba(20, 28, 34, 0.5);
}
.noma-preview-toolbar[data-visible="true"] {
  display: inline-flex;
}
.noma-preview-toolbar button,
.noma-preview-end-add {
  min-height: 26px;
  border: 1px solid rgba(15, 102, 107, 0.22);
  border-radius: 6px;
  background: #fffefa;
  color: #124d55;
  padding: 0 8px;
  font: 700 12px Inter, -apple-system, BlinkMacSystemFont, "Segoe UI", system-ui, sans-serif;
  cursor: pointer;
}
.noma-preview-toolbar button:hover,
.noma-preview-end-add:hover {
  border-color: rgba(15, 102, 107, 0.58);
  background: #edf7f5;
}
.noma-preview-toolbar .noma-preview-delete-section {
  display: none;
  color: #9c342e;
}
.noma-preview-toolbar[data-selected-kind="section"] .noma-preview-delete-section {
  display: inline-block;
}
.noma-preview-toolbar .noma-preview-delete-section:hover {
  border-color: rgba(163, 58, 50, 0.48);
  background: #fbebe9;
}
.noma-preview-resize-handle {
  position: absolute;
  z-index: 45;
  top: 18px;
  right: -13px;
  bottom: 18px;
  width: 18px;
  cursor: ew-resize;
  border-radius: 999px;
}
.noma-preview-resize-handle::before {
  content: "";
  position: absolute;
  top: 50%;
  right: 6px;
  width: 4px;
  height: 72px;
  transform: translateY(-50%);
  border-radius: 999px;
  background: rgba(15, 102, 107, 0.38);
}
.noma-preview-resize-handle:hover::before,
.noma-preview-resize-handle:focus-visible::before {
  background: #0f666b;
}
.noma-preview-end-add {
  display: block;
  margin: 32px auto 0;
}
`;
}

function createPreviewToolbar(
  previewDoc: Document,
  onInsert: (kind: PreviewInsertKind) => void,
  onDeleteSection: () => void,
): HTMLElement {
  const toolbar = previewDoc.createElement("div");
  toolbar.className = "noma-preview-toolbar";
  toolbar.dataset.visible = "false";
  toolbar.setAttribute("aria-label", "Preview block actions");

  const sectionButton = previewDoc.createElement("button");
  sectionButton.type = "button";
  sectionButton.textContent = "+ Section";
  sectionButton.title = "Add a section after this block";
  sectionButton.addEventListener("click", () => onInsert("section"));

  const paragraphButton = previewDoc.createElement("button");
  paragraphButton.type = "button";
  paragraphButton.textContent = "+ Text";
  paragraphButton.title = "Add a paragraph after this block";
  paragraphButton.addEventListener("click", () => onInsert("paragraph"));

  const deleteButton = previewDoc.createElement("button");
  deleteButton.type = "button";
  deleteButton.className = "noma-preview-delete-section";
  deleteButton.textContent = "Delete";
  deleteButton.title = "Delete this section";
  deleteButton.addEventListener("click", () => onDeleteSection());

  toolbar.addEventListener("pointerdown", (event) => event.preventDefault());
  toolbar.append(sectionButton, paragraphButton, deleteButton);
  previewDoc.body.append(toolbar);
  return toolbar;
}

function placePreviewToolbar(toolbar: HTMLElement, element: HTMLElement): void {
  const doc = element.ownerDocument;
  const rect = element.getBoundingClientRect();
  const top = Math.max(8, rect.top - 38);
  const maxLeft = Math.max(8, doc.documentElement.clientWidth - toolbar.offsetWidth - 8);
  const left = Math.min(maxLeft, Math.max(8, rect.right - toolbar.offsetWidth));
  toolbar.style.top = `${top}px`;
  toolbar.style.left = `${left}px`;
  toolbar.dataset.visible = "true";
}

function installPreviewPaperResize(previewDoc: Document): void {
  const paper = previewDoc.querySelector<HTMLElement>(".noma-document");
  if (!paper) return;

  const handle = previewDoc.createElement("div");
  handle.className = "noma-preview-resize-handle";
  handle.tabIndex = 0;
  handle.setAttribute("role", "separator");
  handle.setAttribute("aria-orientation", "vertical");
  handle.setAttribute("aria-label", "Resize preview paper");
  handle.title = "Drag to resize preview paper";
  handle.addEventListener("pointerdown", (event) => startPreviewPaperResize(event, paper));
  handle.addEventListener("keydown", (event) => handlePreviewPaperResizeKeydown(event, paper));
  paper.append(handle);
}

function installPreviewEndAdd(previewDoc: Document): void {
  const paper = previewDoc.querySelector<HTMLElement>(".noma-document");
  if (!paper) return;
  const button = previewDoc.createElement("button");
  button.type = "button";
  button.className = "noma-preview-end-add";
  button.textContent = "+ Section";
  button.title = "Add a section at the end of the page";
  button.addEventListener("click", () => insertSectionAtEnd());
  paper.append(button);
}

function applyPreviewPaperWidth(previewDoc: Document): void {
  const paper = previewDoc.querySelector<HTMLElement>(".noma-document");
  if (paper) paper.style.maxWidth = `${previewPaperWidth}px`;
}

function startSplitResize(event: PointerEvent): void {
  if (viewMode !== "split") return;
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

function handleSplitResizeKeydown(event: KeyboardEvent): void {
  if (viewMode !== "split") return;
  if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
  event.preventDefault();
  setSplitSourceRatio(splitSourceRatio + (event.key === "ArrowRight" ? 3 : -3));
  setCloudStatus("Resized split view", "ok");
}

function setSplitSourceRatio(value: number): void {
  splitSourceRatio = Math.round(clamp(value, 30, 66) * 10) / 10;
  localStorage.setItem(splitSourceRatioStorageKey, String(splitSourceRatio));
  documentGrid.style.setProperty("--source-pane-width", `${splitSourceRatio}%`);
}

function startPreviewPaperResize(event: PointerEvent, paper: HTMLElement): void {
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

function handlePreviewPaperResizeKeydown(event: KeyboardEvent, paper: HTMLElement): void {
  if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
  event.preventDefault();
  event.stopPropagation();
  setPreviewPaperWidth(previewPaperWidth + (event.key === "ArrowRight" ? 40 : -40), paper);
  setCloudStatus("Resized preview paper", "ok");
}

function setPreviewPaperWidth(value: number, paper?: HTMLElement): void {
  previewPaperWidth = Math.round(clamp(value, 680, 1280));
  localStorage.setItem(previewPaperWidthStorageKey, String(previewPaperWidth));
  if (paper) paper.style.maxWidth = `${previewPaperWidth}px`;
}

function insertPreviewBlockAfter(element: HTMLElement, kind: PreviewInsertKind): void {
  const editableKind = element.dataset.nomaEditable;
  const line = positiveInt(element.dataset.nomaLine);
  const endLine = positiveInt(element.dataset.nomaEndLine) ?? line;
  if (!isPreviewEditKind(editableKind) || line === undefined || endLine === undefined) {
    setCloudStatus("Preview insert cannot sync", "warning");
    return;
  }

  if (kind === "section") {
    const index = editableKind === "section" ? sectionEndInsertIndex(line) : endLine;
    insertSourceBlockAtIndex(index, newSectionSource(line), "Added section from preview");
    return;
  }

  const index = editableKind === "section" ? line : endLine;
  insertSourceBlockAtIndex(index, "New paragraph.", "Added paragraph from preview");
}

function insertSectionAtEnd(): void {
  const lines = sourceInput.value.split("\n");
  insertSourceBlockAtIndex(lines.length, newSectionSource(lines.length), "Added section at end");
}

function insertSectionAtCursor(): void {
  const index = sourceCursorInsertIndex();
  insertSourceBlockAtIndex(index, newSectionSource(index + 1), "Added section at cursor");
}

function insertParagraphAtCursor(): void {
  insertSourceBlockAtIndex(sourceCursorInsertIndex(), "New paragraph.", "Added paragraph at cursor");
}

function sourceCursorInsertIndex(): number {
  const beforeCursor = sourceInput.value.slice(0, sourceInput.selectionStart);
  return beforeCursor.split("\n").length;
}

function insertSourceBlockAtIndex(index: number, sourceBlock: string, status: string): void {
  if (renderTimer !== undefined) {
    window.clearTimeout(renderTimer);
    renderTimer = undefined;
  }

  const lines = sourceInput.value.split("\n");
  const boundedIndex = Math.max(0, Math.min(lines.length, index));
  const needsPrefix = boundedIndex > 0 && lines[boundedIndex - 1]?.trim() !== "";
  const needsSuffix = boundedIndex < lines.length && lines[boundedIndex]?.trim() !== "";
  const insertLines = [
    ...(needsPrefix ? [""] : []),
    ...sourceBlock.split("\n"),
    ...(needsSuffix ? [""] : []),
  ];
  pendingPreviewFocusLine = boundedIndex + (needsPrefix ? 2 : 1);
  lines.splice(boundedIndex, 0, ...insertLines);
  sourceInput.value = lines.join("\n");
  syncTitleFromSource();
  markDirty();
  setCloudStatus(status, "ok");
  renderCurrent();
}

function newSectionSource(contextLine: number): string {
  const currentLevel = headingLevelAtLine(contextLine) ?? nearestHeadingLevelBefore(contextLine) ?? 2;
  const level = Math.max(2, currentLevel);
  const id = uniqueSourceId("new-section");
  return `${"#".repeat(level)} New section {id="${id}"}\n\nStart writing here.`;
}

function sectionEndInsertIndex(headingLine: number): number {
  const lines = sourceInput.value.split("\n");
  const level = headingLevelAtLine(headingLine);
  if (level === undefined) return headingLine;
  for (let index = headingLine; index < lines.length; index += 1) {
    const nextLevel = headingLevel(lines[index]);
    if (nextLevel !== undefined && nextLevel <= level) return index;
  }
  return lines.length;
}

function headingLevelAtLine(line: number): number | undefined {
  const lines = sourceInput.value.split("\n");
  return headingLevel(lines[line - 1]);
}

function nearestHeadingLevelBefore(line: number): number | undefined {
  const lines = sourceInput.value.split("\n");
  for (let index = Math.min(line - 1, lines.length - 1); index >= 0; index -= 1) {
    const level = headingLevel(lines[index]);
    if (level !== undefined) return level;
  }
  return undefined;
}

function headingLevel(line: string | undefined): number | undefined {
  const match = /^(#{1,6})\s+/.exec(line ?? "");
  return match?.[1]?.length;
}

function uniqueSourceId(base: string): string {
  const ids = new Set(
    [...sourceInput.value.matchAll(/\bid="([^"]+)"/g)]
      .map((match) => match[1])
      .filter((id): id is string => id !== undefined),
  );
  if (!ids.has(base)) return base;
  for (let suffix = 2; suffix < 1000; suffix += 1) {
    const candidate = `${base}-${suffix}`;
    if (!ids.has(candidate)) return candidate;
  }
  return `${base}-${Date.now().toString(36)}`;
}

function focusPendingPreviewLine(previewDoc: Document): void {
  const line = pendingPreviewFocusLine;
  if (line === undefined) return;
  pendingPreviewFocusLine = undefined;
  window.setTimeout(() => {
    const element = previewDoc.querySelector<HTMLElement>(`[data-noma-line="${line}"]`);
    if (!element) return;
    element.focus();
    selectElementContents(element);
  }, 0);
}

function selectElementContents(element: HTMLElement): void {
  const selection = element.ownerDocument.getSelection();
  if (!selection) return;
  const range = element.ownerDocument.createRange();
  range.selectNodeContents(element);
  selection.removeAllRanges();
  selection.addRange(range);
}

function handlePreviewEditKeydown(event: KeyboardEvent, element: HTMLElement): void {
  const kind = element.dataset.nomaEditable;
  const key = event.key.toLowerCase();

  if (key === "escape") {
    event.preventDefault();
    element.textContent = element.dataset.nomaOriginalText ?? "";
    element.blur();
    return;
  }

  if ((event.metaKey || event.ctrlKey) && key === "s") {
    event.preventDefault();
    element.blur();
    void saveCurrentPage();
    return;
  }

  if (key === "enter" && !event.shiftKey && (kind === "section" || kind === "list_item")) {
    event.preventDefault();
    element.blur();
  }
}

function pastePlainText(event: ClipboardEvent, element: HTMLElement): void {
  const text = event.clipboardData?.getData("text/plain");
  if (text === undefined) return;
  event.preventDefault();
  element.ownerDocument.execCommand("insertText", false, text);
}

function commitPreviewEdit(element: HTMLElement): void {
  const originalText = element.dataset.nomaOriginalText ?? "";
  const nextText = editableText(element);
  if (nextText === originalText) return;

  const kind = element.dataset.nomaEditable;
  const line = positiveInt(element.dataset.nomaLine);
  const endLine = positiveInt(element.dataset.nomaEndLine) ?? line;
  if (!isPreviewEditKind(kind) || line === undefined) {
    setCloudStatus("Rendered edit cannot sync", "warning");
    return;
  }

  const replacement = previewSourceReplacement(kind, line, endLine, nextText);
  if (replacement === null) {
    setCloudStatus("Rendered edit cannot sync", "warning");
    return;
  }

  replaceSourceLines(line, endLine, replacement);
  setCloudStatus("Synced preview edit", "ok");
}

function editableText(element: HTMLElement): string {
  return (element.innerText || element.textContent || "")
    .replace(/\u00a0/g, " ")
    .replace(/\r\n?/g, "\n")
    .replace(/\n+$/g, "");
}

function previewSourceReplacement(
  kind: PreviewEditKind,
  line: number,
  endLine: number,
  text: string,
): string | null {
  const lines = sourceInput.value.split("\n");
  const currentLine = lines[line - 1];
  if (currentLine === undefined) return null;

  switch (kind) {
    case "section": {
      const match = /^(#{1,6}\s+)(.*?)(\s+\{[^}]+\})?\s*$/.exec(currentLine);
      if (!match) return null;
      return `${match[1] ?? ""}${normalizeInlineText(text) || "Untitled"}${match[3] ?? ""}`;
    }
    case "paragraph":
      return normalizeBlockText(text);
    case "list_item": {
      const match = /^(\s*(?:[-*]|\d+\.)\s+)(.*)$/.exec(currentLine);
      if (!match) return null;
      return `${match[1] ?? ""}${normalizeInlineText(text)}`;
    }
    case "quote": {
      const body = normalizeBlockText(text);
      const quoteLines = body ? body.split("\n") : [""];
      return quoteLines.map((quoteLine) => `> ${quoteLine}`).join("\n");
    }
  }
}

function replaceSourceLines(startLine: number, endLine: number, replacement: string): void {
  if (renderTimer !== undefined) {
    window.clearTimeout(renderTimer);
    renderTimer = undefined;
  }

  const lines = sourceInput.value.split("\n");
  const startIndex = startLine - 1;
  const endIndex = Math.max(startIndex, Math.min(lines.length - 1, endLine - 1));
  lines.splice(startIndex, endIndex - startIndex + 1, ...replacement.split("\n"));
  sourceInput.value = lines.join("\n");
  syncTitleFromSource();
  markDirty();
  renderCurrent();
}

function deletePreviewSection(element: HTMLElement): void {
  if (element.dataset.nomaEditable !== "section") {
    setCloudStatus("Select a section heading to delete", "warning");
    return;
  }
  deleteSectionAtLine(positiveInt(element.dataset.nomaLine));
}

function deleteSectionAtLine(line: number | undefined): void {
  if (!line || !canEditPage()) return;
  const level = headingLevelAtLine(line);
  if (level === undefined || level <= 1) {
    setCloudStatus("Root section cannot be deleted here", "warning");
    return;
  }
  const title = sourceSectionTitleAtLine(line);
  if (!window.confirm(`Delete section "${title}" and all nested content?`)) return;

  if (renderTimer !== undefined) {
    window.clearTimeout(renderTimer);
    renderTimer = undefined;
  }

  const lines = sourceInput.value.split("\n");
  const startIndex = line - 1;
  const endIndex = sectionEndInsertIndex(line);
  lines.splice(startIndex, Math.max(1, endIndex - startIndex));
  collapseBlankAt(lines, startIndex);
  sourceInput.value = lines.join("\n");
  syncTitleFromSource();
  markDirty();
  setCloudStatus(`Deleted section: ${title}`, "ok");
  renderCurrent();
}

function collapseBlankAt(lines: string[], index: number): void {
  const bounded = Math.max(1, Math.min(lines.length - 1, index));
  while (bounded < lines.length && lines[bounded - 1]?.trim() === "" && lines[bounded]?.trim() === "") {
    lines.splice(bounded, 1);
  }
}

function sourceSectionTitleAtLine(line: number): string {
  const currentLine = sourceInput.value.split("\n")[line - 1] ?? "";
  return currentLine.replace(/^#{1,6}\s+/, "").replace(/\s+\{[^}]*\}\s*$/, "").trim() || "Untitled";
}

function focusSourceLine(line: number): void {
  const lines = sourceInput.value.split("\n");
  const boundedLine = Math.max(1, Math.min(lines.length, line));
  const offset = lines.slice(0, boundedLine - 1).join("\n").length + (boundedLine > 1 ? 1 : 0);
  sourceInput.focus();
  sourceInput.setSelectionRange(offset, offset);
  const lineHeight = Number.parseFloat(window.getComputedStyle(sourceInput).lineHeight) || 20;
  sourceInput.scrollTop = Math.max(0, (boundedLine - 4) * lineHeight);
}

function normalizeInlineText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function normalizeBlockText(text: string): string {
  return text
    .replace(/\u00a0/g, " ")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join("\n");
}

function positiveInt(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function isPreviewEditKind(value: string | undefined): value is PreviewEditKind {
  return value === "section" || value === "paragraph" || value === "list_item" || value === "quote";
}

function previewError(message: string): string {
  return `<!doctype html><html lang="en"><body style="font:14px sans-serif;color:#a33a32;padding:20px">${escapeHtml(message)}</body></html>`;
}

function starterPage(title: string, siteName: string): string {
  return `# ${title} {id="${slug(title) || "intro"}"}

::abstract{id="abstract" status="draft"}
${siteName} draft abstract. State the research question, method, primary result, and confidence in one paragraph.
::

## Research Question {id="research-question"}

::claim{id="claim-main" confidence=0.68}
The central claim of this paper goes here.
::

::evidence{id="evidence-primary" for="claim-main" source="source-primary"}
Summarize the strongest evidence for the central claim.
::

## Methods {id="methods"}

Describe the study design, corpus, data collection window, and analysis method.

::table{id="review-checklist" header align="l,c,l"}
| Section | Status | Owner |
| Abstract | draft | Research |
| Methods | draft | Research |
| Evidence | needs source check | Reviewer |
::

## Findings {id="findings"}

Draft the result narrative here. Use stable IDs on claims, evidence, figures, tables, citations, and review tasks so collaborators and agents can patch exactly the right block.

::citation{id="source-primary" source="Primary source placeholder" url="https://example.com/source" accessed="2026-06-07"}
Replace this placeholder with the paper's canonical source.
::

::bibliography{id="references"}
::

## Review Queue {id="review-queue"}

::agent_task{id="task-source-check" scope="paper-review" owner="reviewer"}
Verify the primary source, update the citation metadata, and leave unrelated blocks unchanged.
::
`;
}

function wikiPage(title: string, siteName: string, relatedTitle: string): string {
  const id = slug(title) || "wiki-page";
  return `# ${title} {id="${id}"}

::summary{id="summary"}
Summarize what this page captures in ${siteName}. Keep it connected to the related pages below.
::

## Notes {id="notes"}

Start writing the durable explanation here.

## Related {id="related"}

- [[${relatedTitle}]]

## Agent Tasks {id="agent-tasks"}

::agent_task{id="task-expand-${id}" scope="wiki-maintenance" owner="agent"}
Expand this page with definitions, sources, backlinks, and missing related pages without rewriting unrelated pages.
::
`;
}

function replaceFirstHeading(source: string, title: string): string {
  if (/^#\s+.+$/m.test(source)) {
    return source.replace(/^#\s+(.+?)(\s+\{[^}]*\})?\s*$/m, (_match, _oldTitle: string, attrs: string | undefined) => {
      return `# ${title}${attrs ?? ""}`;
    });
  }
  return `# ${title} {id="${slug(title) || "intro"}"}\n\n${source}`;
}

function sourceTitle(source: string): string {
  return source.match(/^#\s+(.+)$/m)?.[1]?.replace(/\s+\{[^}]*\}\s*$/, "").trim() || "Untitled Page";
}

function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

function promptName(label: string, fallback: string): string {
  const value = window.prompt(label, fallback);
  return value?.trim() || fallback;
}

function promptSecret(label: string): string | undefined {
  const value = window.prompt(label);
  return value?.trim() || undefined;
}

function confirmDiscardDirty(): boolean {
  return !dirty || window.confirm("Discard unsaved page changes?");
}

function updateAddress(): void {
  const params = new URLSearchParams();
  if (currentSite) params.set("site", currentSite.id);
  if (currentPage) params.set("doc", currentPage.id);
  if (shareToken) params.set("share", shareToken);
  const next = `${window.location.pathname}?${params.toString()}`;
  window.history.replaceState(null, "", next);
}

function absoluteUrl(path: string): string {
  return new URL(path, window.location.origin).toString();
}

function cloudAppDocumentUrl(id: string, token: string): string {
  return absoluteUrl(`/cloud.html?doc=${encodeURIComponent(id)}&share=${encodeURIComponent(token)}`);
}

function cloudAppSiteUrl(id: string, token: string): string {
  return absoluteUrl(`/cloud.html?site=${encodeURIComponent(id)}&share=${encodeURIComponent(token)}`);
}

function readCloudUser(): CloudUserSession | undefined {
  const stored = localStorage.getItem(userStorageKey);
  if (!stored) return undefined;
  try {
    const parsed = JSON.parse(stored) as Partial<CloudUserSession>;
    if (parsed.id && parsed.name && parsed.token) {
      return {
        id: parsed.id,
        name: parsed.name,
        token: parsed.token,
        tokenPreview: parsed.tokenPreview,
      };
    }
  } catch {
    return undefined;
  }
  return undefined;
}

function readShareToken(): string | undefined {
  const token = query.get("share");
  return token && /^ns_[A-Za-z0-9_-]{16,}$/.test(token) ? token : undefined;
}

function readCloudId(value: string | null): string | undefined {
  return value && /^[A-Za-z0-9_-]{8,80}$/.test(value) ? value : undefined;
}

function readViewMode(): ViewMode {
  const stored = localStorage.getItem(viewModeStorageKey);
  return stored === "source" || stored === "preview" ? stored : "split";
}

function readPanelsOpen(): boolean {
  return localStorage.getItem(panelsOpenStorageKey) !== "false";
}

function readSplitSourceRatio(): number {
  const stored = localStorage.getItem(splitSourceRatioStorageKey);
  if (stored === null) return 46;
  const parsed = Number(stored);
  return Number.isFinite(parsed) ? clamp(parsed, 30, 66) : 46;
}

function readPreviewPaperWidth(): number {
  const stored = localStorage.getItem(previewPaperWidthStorageKey);
  if (stored === null) return 1040;
  const parsed = Number(stored);
  return Number.isFinite(parsed) ? clamp(parsed, 680, 1280) : 1040;
}

function readThemeMode(): ThemeMode {
  const stored = localStorage.getItem(themeStorageKey);
  if (stored === "light" || stored === "dark") return stored;
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "light";
}

function applyThemeMode(): void {
  document.documentElement.dataset.theme = themeMode;
  document.documentElement.style.colorScheme = themeMode;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

function setBusy(value: boolean, message?: string, state: PanelState = "warning"): void {
  busy = value;
  if (message) setCloudStatus(message, state);
  renderChrome();
}

function setCloudStatus(message: string, state: PanelState): void {
  cloudStatus.textContent = message;
  cloudStatus.dataset.state = state;
}

function setPanelStatus(element: HTMLElement, message: string, state: PanelState): void {
  element.textContent = message;
  element.dataset.state = state;
}

function emptyRenderState(): RenderState {
  return {
    doc: null,
    diagnostics: [],
    llm: "",
  };
}

async function copyText(text: string, status: string): Promise<void> {
  await navigator.clipboard.writeText(text);
  setCloudStatus(status, "ok");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function shortId(value: string): string {
  return `${value.slice(0, 6)}...${value.slice(-4)}`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => {
    switch (char) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#39;";
    }
  });
}
