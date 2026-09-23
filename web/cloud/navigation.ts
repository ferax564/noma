/** Spaces, page tree, folders, favorites, recents, trash and page selection. */
import { fetchCloudJson } from "./api.js";
import { createShare, ensureSavedBeforeShare, refreshAccessManagement } from "./collaboration.js";
import { activeSiteStorageKey } from "./constants.js";
import { showFolderContextMenu, showPageContextMenu, showSiteContextMenu } from "./context-menu.js";
import { pageList, pageTemplateSelect, siteList, siteTitleInput, trashList } from "./dom.js";
import { clearLocalDraft } from "./drafts.js";
import { setCurrentPage } from "./editor.js";
import { renderChrome } from "./layout.js";
import { pageAncestors, pageParentId } from "./page-meta.js";
import { canCreatePage, canEditSite, selectedShareRole } from "./permissions.js";
import { clearWorkspaceState, refreshWorkspaceTools, renderWorkspaceTools } from "./session.js";
import { shareToken, state } from "./state.js";
import type { CloudDocumentResponse, CloudNavigationItem, CloudPageTemplate, CloudSiteResponse, CloudTrashItem } from "./types.js";
import { absoluteUrl, copyText, emptyState, errorMessage, formatDate, iconButton, promptName, setBusy, setCloudStatus, shortId, slug } from "./util.js";
import { refreshWorkManagement } from "./work.js";

export async function refreshSites(options: { silent?: boolean } = {}): Promise<void> {
  if (!state.cloudUser) return;
  if (!options.silent) setBusy(true, "Loading spaces", "warning");
  try {
    const response = await fetchCloudJson<{ sites: CloudSiteResponse[] }>("/api/sites");
    state.sites = response.sites.map(normalizeSite);
  } finally {
    if (!options.silent) setBusy(false);
    renderNavigation();
  }
}

export async function refreshTemplates(): Promise<void> {
  const selected = pageTemplateSelect.value;
  const response = await fetchCloudJson<{ templates: CloudPageTemplate[] }>("/api/templates");
  state.pageTemplates = response.templates;
  pageTemplateSelect.textContent = "";
  for (const template of state.pageTemplates) {
    const option = document.createElement("option");
    option.value = template.id;
    option.textContent = `${template.title} · ${template.category}`;
    option.title = template.description;
    pageTemplateSelect.append(option);
  }
  pageTemplateSelect.value = state.pageTemplates.some((template) => template.id === selected) ? selected : "blank";
}

export async function refreshNavigationItems(): Promise<void> {
  const response = await fetchCloudJson<{ recents: CloudNavigationItem[]; favorites: CloudNavigationItem[] }>("/api/navigation");
  state.recentItems = response.recents;
  state.favoriteItems = response.favorites;
  renderWorkspaceTools();
}

export async function refreshTrash(): Promise<void> {
  if (!state.cloudUser) {
    state.trashItems = [];
    renderWorkspaceTools();
    return;
  }
  try {
    const response = await fetchCloudJson<{ items: CloudTrashItem[] }>("/api/trash");
    state.trashItems = response.items;
  } catch (error) {
    setCloudStatus(errorMessage(error), "error");
  } finally {
    renderWorkspaceTools();
  }
}

export function renderNavigationList(container: HTMLElement, items: CloudNavigationItem[], emptyText: string, removable: boolean): void {
  container.textContent = "";
  if (items.length === 0) {
    container.append(emptyState(emptyText));
    return;
  }
  for (const item of items) {
    const entry = document.createElement("div");
    entry.className = "navigation-entry";
    const button = navigationButton(item);
    entry.append(button);
    if (removable) {
      entry.append(iconButton("×", `Remove ${item.title} from favorites`, () => void toggleFavorite(item.resourceType, item.resourceId)));
    }
    container.append(entry);
  }
}

function navigationButton(item: CloudNavigationItem): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "navigation-row";
  const title = document.createElement("span");
  title.className = "row-title";
  title.textContent = item.title;
  const meta = document.createElement("span");
  meta.className = "row-meta";
  meta.textContent = `${item.resourceType} · ${formatDate(item.activityAt)}`;
  button.append(title, meta);
  button.addEventListener("click", () => void openNavigationItem(item));
  return button;
}

export function renderTrashList(): void {
  trashList.textContent = "";
  if (state.trashItems.length === 0) {
    trashList.append(emptyState("Trash is empty"));
    return;
  }
  for (const item of state.trashItems.slice(0, 20)) {
    const entry = document.createElement("div");
    entry.className = "navigation-entry";
    entry.append(navigationButton(item), iconButton("Restore", `Restore ${item.title}`, () => void restoreTrashItem(item)));
    trashList.append(entry);
  }
}

async function openNavigationItem(item: CloudNavigationItem): Promise<void> {
  if (item.resourceType === "site") await loadSite(item.resourceId);
  else if (item.siteId) await loadSite(item.siteId, item.resourceId);
  else await loadStandaloneDocument(item.resourceId);
}

export async function toggleFavorite(resourceType: "document" | "site", resourceId: string): Promise<void> {
  if (!state.cloudUser) return;
  const exists = state.favoriteItems.some((item) => item.resourceType === resourceType && item.resourceId === resourceId);
  try {
    await fetchCloudJson("/api/navigation/favorites", {
      method: exists ? "DELETE" : "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ resourceType, resourceId }),
    });
    await refreshNavigationItems();
    renderChrome();
    setCloudStatus(exists ? "Removed favorite" : "Added favorite", "ok");
  } catch (error) {
    setCloudStatus(errorMessage(error), "error");
  }
}

export async function recordRecent(resourceType: "document" | "site", resourceId: string): Promise<void> {
  if (!state.cloudUser) return;
  try {
    await fetchCloudJson("/api/navigation/recent", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ resourceType, resourceId }),
    });
    await refreshNavigationItems();
  } catch {
    return;
  }
}

export async function loadSite(siteId: string, preferredDocumentId?: string): Promise<void> {
  if (!confirmDiscardDirty()) return;
  setBusy(true, "Opening space", "warning");
  try {
    const site = await fetchCloudJson<CloudSiteResponse>(`/api/sites/${encodeURIComponent(siteId)}?include=documents`);
    state.currentSite = normalizeSite(site);
    state.pages = site.documents ?? [];
    siteTitleInput.value = state.currentSite.title;
    localStorage.setItem(activeSiteStorageKey, state.currentSite.id);
    const selected = preferredDocumentId ? state.pages.find((page) => page.id === preferredDocumentId) : undefined;
    setCurrentPage(selected ?? state.pages[0]);
    updateAddress();
    if (state.cloudUser) await Promise.all([refreshSites({ silent: true }), refreshWorkManagement(), refreshAccessManagement()]);
  } finally {
    setBusy(false);
    renderChrome();
  }
}

export async function loadStandaloneDocument(documentId: string): Promise<void> {
  if (!confirmDiscardDirty()) return;
  setBusy(true, "Opening page", "warning");
  try {
    const page = await fetchCloudJson<CloudDocumentResponse>(`/api/documents/${encodeURIComponent(documentId)}`);
    state.currentSite = undefined;
    state.activeFolder = "";
    state.pages = [page];
    siteTitleInput.value = "Standalone Page";
    setCurrentPage(page);
    updateAddress();
    await Promise.all([refreshWorkManagement(), refreshAccessManagement()]);
  } finally {
    setBusy(false);
    renderChrome();
  }
}

export async function createStarterWorkspace(name: string): Promise<void> {
  if (!state.cloudAvailable) return;
  if (!state.cloudUser) {
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

export async function createPage(folder = state.activeFolder, parentId?: string): Promise<void> {
  if (!state.currentSite) {
    await createStarterWorkspace(promptName("Space name", "Research Workspace"));
    return;
  }
  if (!state.cloudUser) {
    setCloudStatus("A user token is required to create pages", "error");
    return;
  }
  if (!confirmDiscardDirty()) return;

  const normalizedFolder = normalizeFolderName(folder);
  const template = selectedPageTemplate();
  const title = promptName(normalizedFolder ? `Page title in ${normalizedFolder}` : "Page title", template?.title ?? "Untitled Page");
  setBusy(true, "Creating page", "warning");
  try {
    const page = await fetchCloudJson<CloudDocumentResponse>(`/api/sites/${encodeURIComponent(state.currentSite.id)}/documents`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title,
        templateId: template?.id ?? "blank",
        folder: normalizedFolder,
        ...(parentId ? { parentId } : {}),
      }),
    });
    state.pages = [...state.pages, page];
    if (parentId) {
      const refreshed = await fetchCloudJson<CloudSiteResponse>(`/api/sites/${encodeURIComponent(state.currentSite.id)}`);
      state.currentSite = { ...state.currentSite, documentIds: refreshed.documentIds, pageParents: refreshed.pageParents ?? {} };
      state.pages = refreshed.documentIds.map((id) => state.pages.find((candidate) => candidate.id === id)).filter((candidate): candidate is CloudDocumentResponse => Boolean(candidate));
    }
    const documentIds = [...state.currentSite.documentIds, page.id];
    const pageFolders = normalizedPageFolders({ ...state.currentSite.pageFolders, ...(normalizedFolder ? { [page.id]: normalizedFolder } : {}) }, documentIds);
    state.currentSite = {
      ...state.currentSite,
      documentIds,
      folders: normalizeFolders([...(state.currentSite.folders ?? []), normalizedFolder, ...Object.values(pageFolders)]),
      pageFolders,
      documents: state.pages,
    };
    state.activeFolder = normalizedFolder;
    setCurrentPage(page);
    await refreshSites({ silent: true });
    updateAddress();
    await refreshWorkspaceTools();
    setCloudStatus("Created page", "ok");
  } catch (error) {
    setCloudStatus(errorMessage(error), "error");
  } finally {
    setBusy(false);
    renderChrome();
  }
}

export async function importPage(file: File): Promise<void> {
  if (!state.currentSite) {
    await createStarterWorkspace("Research Workspace");
  }
  if (!state.currentSite || !state.cloudUser || !canCreatePage()) return;
  if (!confirmDiscardDirty()) return;
  const source = await file.text();
  if (!source.trim()) {
    setCloudStatus("The imported file is empty", "error");
    return;
  }
  const markdown = /\.(?:md|markdown)$/i.test(file.name);
  const fileTitle = file.name.replace(/\.(?:noma|md|markdown)$/i, "").replace(/[-_]+/g, " ").trim();
  const title = sourceTitle(source) || fileTitle || "Imported Page";
  const folder = normalizeFolderName(state.activeFolder);
  setBusy(true, `Importing ${file.name}`, "warning");
  try {
    const page = await fetchCloudJson<CloudDocumentResponse>(`/api/sites/${encodeURIComponent(state.currentSite.id)}/documents`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title, source, format: markdown ? "markdown" : "noma", folder }),
    });
    state.pages = [...state.pages, page];
    const documentIds = [...state.currentSite.documentIds, page.id];
    const pageFolders = normalizedPageFolders({ ...state.currentSite.pageFolders, ...(folder ? { [page.id]: folder } : {}) }, documentIds);
    state.currentSite = {
      ...state.currentSite,
      documentIds,
      folders: normalizeFolders([...(state.currentSite.folders ?? []), folder, ...Object.values(pageFolders)]),
      pageFolders,
      documents: state.pages,
    };
    setCurrentPage(page);
    await refreshSites({ silent: true });
    await refreshWorkspaceTools();
    updateAddress();
    setCloudStatus(`Imported ${file.name}`, "ok");
  } catch (error) {
    setCloudStatus(errorMessage(error), "error");
  } finally {
    setBusy(false);
    renderChrome();
  }
}

function selectedPageTemplate(): CloudPageTemplate | undefined {
  return state.pageTemplates.find((template) => template.id === pageTemplateSelect.value);
}

export async function trashPage(page: CloudDocumentResponse): Promise<void> {
  if (!canEditSite() && page.access?.role !== "owner" && page.access?.role !== "editor") return;
  if (state.currentPage?.id === page.id && !confirmDiscardDirty()) return;
  if (!window.confirm(`Move page "${page.title}" to trash? It can be restored later.`)) return;
  setBusy(true, "Moving page to trash", "warning");
  try {
    await fetchCloudJson(`/api/trash/document/${encodeURIComponent(page.id)}`, { method: "POST" });
    state.dirty = false;
    if (state.currentSite) await loadSite(state.currentSite.id);
    else if (state.currentPage?.id === page.id) setCurrentPage(undefined);
    await refreshSites({ silent: true });
    await refreshWorkspaceTools();
    setCloudStatus("Moved page to trash", "ok");
  } catch (error) {
    setCloudStatus(errorMessage(error), "error");
  } finally {
    setBusy(false);
    renderChrome();
  }
}

export async function trashSite(site: CloudSiteResponse): Promise<void> {
  if (site.access?.role !== "owner" && site.currentRole !== "owner") return;
  if (state.currentSite?.id === site.id && !confirmDiscardDirty()) return;
  if (!window.confirm(`Move space "${site.title}" to trash? Its pages remain recoverable.`)) return;
  setBusy(true, "Moving space to trash", "warning");
  try {
    await fetchCloudJson(`/api/trash/site/${encodeURIComponent(site.id)}`, { method: "POST" });
    state.dirty = false;
    await refreshSites({ silent: true });
    const nextSite = state.sites.find((candidate) => candidate.id !== site.id);
    if (nextSite) await loadSite(nextSite.id);
    else clearWorkspaceState();
    await refreshWorkspaceTools();
    setCloudStatus("Moved space to trash", "ok");
  } catch (error) {
    setCloudStatus(errorMessage(error), "error");
  } finally {
    setBusy(false);
    renderChrome();
  }
}

async function restoreTrashItem(item: CloudTrashItem): Promise<void> {
  setBusy(true, `Restoring ${item.title}`, "warning");
  try {
    await fetchCloudJson(`/api/trash/${item.resourceType}/${encodeURIComponent(item.resourceId)}/restore`, { method: "POST" });
    await refreshSites({ silent: true });
    await refreshWorkspaceTools();
    if (item.resourceType === "site") await loadSite(item.resourceId);
    else if (item.siteId) await loadSite(item.siteId, item.resourceId);
    else await loadStandaloneDocument(item.resourceId);
    setCloudStatus(`Restored ${item.title}`, "ok");
  } catch (error) {
    setCloudStatus(errorMessage(error), "error");
  } finally {
    setBusy(false);
    renderChrome();
  }
}

export async function createFolder(): Promise<void> {
  if (!state.currentSite || !canEditSite()) return;
  const folder = promptFolder("Folder name", "Research Notes");
  if (folder === undefined) return;
  if (!folder) {
    setCloudStatus("Folder name required", "error");
    return;
  }
  if (siteFolders(state.currentSite).some((item) => sameFolder(item, folder))) {
    state.activeFolder = folder;
    setCloudStatus("Selected folder", "ok");
    renderChrome();
    return;
  }

  state.currentSite = {
    ...state.currentSite,
    folders: normalizeFolders([...(state.currentSite.folders ?? []), folder]),
    pageFolders: normalizedPageFolders(state.currentSite.pageFolders, state.currentSite.documentIds),
    documents: state.pages,
  };
  state.activeFolder = folder;
  await saveSiteStructure("Created folder");
}

export async function renameFolder(folder: string): Promise<void> {
  if (!state.currentSite || !canEditSite()) return;
  const currentFolder = normalizeFolderName(folder);
  if (!currentFolder) return;
  const nextFolder = promptFolder("Rename folder", currentFolder);
  if (nextFolder === undefined || !nextFolder || sameFolder(currentFolder, nextFolder)) return;

  const pageFolders = normalizedPageFolders(state.currentSite.pageFolders, state.currentSite.documentIds);
  for (const [pageId, pageFolder] of Object.entries(pageFolders)) {
    if (sameFolder(pageFolder, currentFolder)) pageFolders[pageId] = nextFolder;
  }
  state.currentSite = {
    ...state.currentSite,
    folders: normalizeFolders((state.currentSite.folders ?? []).map((item) => (sameFolder(item, currentFolder) ? nextFolder : item))),
    pageFolders,
    documents: state.pages,
  };
  state.activeFolder = nextFolder;
  await saveSiteStructure("Renamed folder");
}

export async function deleteFolder(folder: string): Promise<void> {
  if (!state.currentSite || !canEditSite()) return;
  const currentFolder = normalizeFolderName(folder);
  if (!currentFolder) return;
  const pagesInFolder = state.pages.filter((page) => sameFolder(pageFolder(page.id), currentFolder)).length;
  const message = pagesInFolder > 0
    ? `Delete folder "${currentFolder}"? ${pagesInFolder} page${pagesInFolder === 1 ? "" : "s"} will move to Pages.`
    : `Delete folder "${currentFolder}"?`;
  if (!window.confirm(message)) return;

  const pageFolders = normalizedPageFolders(state.currentSite.pageFolders, state.currentSite.documentIds);
  for (const [pageId, pageFolder] of Object.entries(pageFolders)) {
    if (sameFolder(pageFolder, currentFolder)) delete pageFolders[pageId];
  }
  state.currentSite = {
    ...state.currentSite,
    folders: normalizeFolders((state.currentSite.folders ?? []).filter((item) => !sameFolder(item, currentFolder))),
    pageFolders,
    documents: state.pages,
  };
  if (sameFolder(state.activeFolder, currentFolder)) state.activeFolder = "";
  await saveSiteStructure("Deleted folder");
}

export async function movePageUnder(pageId: string): Promise<void> {
  if (!state.currentSite || !canEditSite()) return;
  const page = state.pages.find((item) => item.id === pageId);
  const answer = window.prompt(`Parent page title for "${page?.title ?? "page"}" (leave empty for top level)`, "");
  if (answer === null) return;
  const parent = answer.trim() ? state.pages.find((item) => item.title.toLowerCase() === answer.trim().toLowerCase()) : undefined;
  if (answer.trim() && !parent) {
    setCloudStatus(`No page titled "${answer.trim()}" in this space`, "error");
    return;
  }
  setBusy(true, "Moving page", "warning");
  try {
    const response = await fetchCloudJson<{ site: CloudSiteResponse }>(
      `/api/sites/${encodeURIComponent(state.currentSite.id)}/documents/${encodeURIComponent(pageId)}/parent`,
      { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ parentId: parent?.id ?? null }) },
    );
    state.currentSite = { ...state.currentSite, documentIds: response.site.documentIds, pageParents: response.site.pageParents ?? {} };
    state.pages = response.site.documentIds.map((id) => state.pages.find((candidate) => candidate.id === id)).filter((candidate): candidate is CloudDocumentResponse => Boolean(candidate));
    setCloudStatus(parent ? `Moved under ${parent.title}` : "Moved to top level", "ok");
  } catch (error) {
    setCloudStatus(errorMessage(error), "error");
  } finally {
    setBusy(false);
    renderChrome();
  }
}

export async function movePage(pageId: string): Promise<void> {
  if (!state.currentSite || !canEditSite()) return;
  const page = state.pages.find((item) => item.id === pageId);
  if (!page) return;
  const folder = promptFolder(`Move "${page.title}" to folder`, pageFolder(page.id));
  if (folder === undefined) return;
  await movePageToFolder(pageId, folder);
}

export async function movePageToFolder(pageId: string, folder: string): Promise<void> {
  if (!state.currentSite || !canEditSite()) return;
  const page = state.pages.find((item) => item.id === pageId);
  if (!page) return;
  const pageFolders = normalizedPageFolders(state.currentSite.pageFolders, state.currentSite.documentIds);
  if (folder) pageFolders[page.id] = folder;
  else delete pageFolders[page.id];
  state.currentSite = {
    ...state.currentSite,
    folders: normalizeFolders([...(state.currentSite.folders ?? []), folder, ...Object.values(pageFolders)]),
    pageFolders,
    documents: state.pages,
  };
  state.activeFolder = folder;
  await saveSiteStructure(folder ? `Moved page to ${folder}` : "Moved page to Pages");
}

async function saveSiteStructure(status: string): Promise<void> {
  if (!state.currentSite || !canEditSite()) return;
  setBusy(true, "Saving folders", "warning");
  try {
    const saved = await fetchCloudJson<CloudSiteResponse>(`/api/sites/${encodeURIComponent(state.currentSite.id)}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: siteTitleInput.value.trim() || state.currentSite.title,
        documentIds: state.currentSite.documentIds,
        folders: siteFolders(state.currentSite),
        pageFolders: normalizedPageFolders(state.currentSite.pageFolders, state.currentSite.documentIds),
      }),
    });
    state.currentSite = { ...normalizeSite(saved), documents: state.pages };
    state.sites = state.sites.map((site) => (site.id === saved.id ? normalizeSite(saved) : site));
    setCloudStatus(status, "ok");
  } catch (error) {
    setCloudStatus(errorMessage(error), "error");
  } finally {
    setBusy(false);
    renderChrome();
  }
}

export async function saveCurrentSite(): Promise<void> {
  if (!state.currentSite || !canEditSite()) return;
  setBusy(true, "Saving space", "warning");
  try {
    const saved = await fetchCloudJson<CloudSiteResponse>(`/api/sites/${encodeURIComponent(state.currentSite.id)}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: siteTitleInput.value.trim() || state.currentSite.title,
        documentIds: state.currentSite.documentIds,
        folders: siteFolders(state.currentSite),
        pageFolders: normalizedPageFolders(state.currentSite.pageFolders, state.currentSite.documentIds),
      }),
    });
    state.currentSite = { ...normalizeSite(saved), documents: state.pages };
    state.sites = state.sites.map((site) => (site.id === saved.id ? saved : site));
    setCloudStatus("Saved space", "ok");
  } catch (error) {
    setCloudStatus(errorMessage(error), "error");
  } finally {
    setBusy(false);
    renderChrome();
  }
}

export async function copyPageLink(): Promise<void> {
  if (!state.currentPage) return;
  await ensureSavedBeforeShare();
  const role = selectedShareRole();
  const share = await createShare(`/api/documents/${encodeURIComponent(state.currentPage.id)}/shares`, role, "Noma Cloud page");
  await copyText(cloudAppDocumentUrl(state.currentPage.id, share.token), `Copied ${role} page link`);
}

export async function copyArtifactLink(): Promise<void> {
  if (!state.currentPage) return;
  await ensureSavedBeforeShare();
  const share = await createShare(`/api/documents/${encodeURIComponent(state.currentPage.id)}/shares`, "viewer", "Noma rendered artifact");
  await copyText(absoluteUrl(`/d/${state.currentPage.id}?share=${encodeURIComponent(share.token)}`), "Copied artifact link");
}

export async function copySiteLink(): Promise<void> {
  if (!state.currentSite) return;
  await ensureSavedBeforeShare();
  const role = selectedShareRole();
  const share = await createShare(`/api/sites/${encodeURIComponent(state.currentSite.id)}/shares`, role, "Noma Cloud space");
  await copyText(cloudAppSiteUrl(state.currentSite.id, share.token), `Copied ${role} space link`);
}

export async function openPublishedSite(): Promise<void> {
  if (!state.currentSite) return;
  await ensureSavedBeforeShare();
  const share = await createShare(`/api/sites/${encodeURIComponent(state.currentSite.id)}/shares`, "viewer", "Published site");
  window.open(absoluteUrl(`/s/${state.currentSite.id}?share=${encodeURIComponent(share.token)}`), "_blank", "noopener");
}

export function replacePage(page: CloudDocumentResponse): void {
  state.pages = state.pages.map((item) => (item.id === page.id ? page : item));
  if (state.currentSite) state.currentSite = { ...state.currentSite, documents: state.pages };
}

export function selectPage(pageId: string): boolean {
  if (state.currentPage?.id === pageId) return true;
  if (!confirmDiscardDirty()) return false;
  const page = state.pages.find((item) => item.id === pageId);
  if (!page) return false;
  setCurrentPage(page);
  updateAddress();
  return true;
}

export function renderNavigation(): void {
  siteList.textContent = "";
  if (state.sites.length === 0 && !state.currentSite) {
    siteList.append(emptyState("No spaces"));
  } else {
    for (const site of state.sites) {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "site-row";
      button.setAttribute("aria-current", String(state.currentSite?.id === site.id));
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
  if (state.pages.length === 0) {
    pageList.append(emptyState("No pages"));
    return;
  }

  const groups = groupedPages();
  for (const group of groups) {
    pageList.append(folderRow(group.folder, group.pages.length));
    for (const { page, depth } of pageTreeOrder(group.pages)) {
      pageList.append(pageRow(page, depth));
    }
  }
}

/** Depth-first page order so children render indented directly under their parent. */
function pageTreeOrder(groupPages: CloudDocumentResponse[]): Array<{ page: CloudDocumentResponse; depth: number }> {
  const inGroup = new Set(groupPages.map((page) => page.id));
  const children = new Map<string, CloudDocumentResponse[]>();
  const roots: CloudDocumentResponse[] = [];
  for (const page of groupPages) {
    const parent = pageParentId(page.id);
    if (parent && inGroup.has(parent)) children.set(parent, [...(children.get(parent) ?? []), page]);
    else roots.push(page);
  }
  const ordered: Array<{ page: CloudDocumentResponse; depth: number }> = [];
  const visit = (page: CloudDocumentResponse, depth: number) => {
    if (ordered.some((entry) => entry.page.id === page.id)) return;
    ordered.push({ page, depth });
    for (const child of children.get(page.id) ?? []) visit(child, depth + 1);
  };
  for (const root of roots) visit(root, 0);
  return ordered;
}

function folderRow(folder: string, pageCount: number): HTMLElement {
  const row = document.createElement("div");
  row.className = "folder-row";
  row.setAttribute("aria-current", String(sameFolder(state.activeFolder, folder)));

  const label = document.createElement("button");
  label.type = "button";
  label.className = "folder-label";
  label.innerHTML = `<span class="row-title"></span><span class="row-meta"></span>`;
  const title = label.querySelector<HTMLElement>(".row-title");
  const meta = label.querySelector<HTMLElement>(".row-meta");
  if (title) title.textContent = folder || "Pages";
  if (meta) meta.textContent = `${pageCount} page${pageCount === 1 ? "" : "s"}`;
  label.addEventListener("click", () => {
    state.activeFolder = folder;
    setCloudStatus(folder ? `Selected ${folder}` : "Selected Pages", "ok");
    renderChrome();
  });
  row.addEventListener("contextmenu", (event) => showFolderContextMenu(event, folder));

  const actions = document.createElement("div");
  actions.className = "folder-actions";
  const addPage = iconButton("+", folder ? `New page in ${folder}` : "New page in Pages", () => {
    state.activeFolder = folder;
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

function pageRow(page: CloudDocumentResponse, depth = 0): HTMLElement {
  const row = document.createElement("div");
  row.className = "page-entry";
  row.style.setProperty("--page-depth", String(Math.min(depth, 8)));
  if (depth > 0) row.dataset.child = "true";

  const button = document.createElement("button");
  button.type = "button";
  button.className = "page-row";
  button.setAttribute("aria-current", String(state.currentPage?.id === page.id));
  button.innerHTML = `<span class="row-title"></span><span class="row-meta"></span>`;
  const title = button.querySelector<HTMLElement>(".row-title");
  const meta = button.querySelector<HTMLElement>(".row-meta");
  if (title) title.textContent = page.title;
  if (meta) meta.textContent = `${shortId(page.id)} / ${page.access?.role ?? state.currentSite?.access?.role ?? "viewer"}`;
  button.addEventListener("click", () => selectPage(page.id));
  row.addEventListener("contextmenu", (event) => showPageContextMenu(event, page));

  const move = iconButton("Move", `Move ${page.title}`, () => void movePage(page.id));
  move.disabled = state.busy || !canEditSite();
  row.append(button, move);
  return row;
}

function groupedPages(): Array<{ folder: string; pages: CloudDocumentResponse[] }> {
  const folders = siteFolders(state.currentSite);
  const groupFolder = (page: CloudDocumentResponse) => pageFolder(pageAncestors(page.id).at(-1) ?? page.id);
  const rootPages = state.pages.filter((page) => !groupFolder(page));
  return [
    { folder: "", pages: rootPages },
    ...folders.map((folder) => ({ folder, pages: state.pages.filter((page) => sameFolder(groupFolder(page), folder)) })),
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
    pageParents: site.pageParents ?? {},
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

export function pageFolder(pageId: string): string {
  return normalizeFolderName(state.currentSite?.pageFolders?.[pageId] ?? "");
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

export function sameFolder(left: string, right: string): boolean {
  return normalizeFolderName(left).toLowerCase() === normalizeFolderName(right).toLowerCase();
}

function promptFolder(label: string, fallback = ""): string | undefined {
  const value = window.prompt(label, fallback);
  return value === null ? undefined : normalizeFolderName(value);
}

export async function runWithLoadedSite(siteId: string, action: () => void | Promise<void>): Promise<void> {
  if (state.currentSite?.id !== siteId) await loadSite(siteId);
  if (state.currentSite?.id === siteId) await action();
}

export function runAfterSelectPage(pageId: string, action: () => void | Promise<void>): void {
  if (!selectPage(pageId)) return;
  void action();
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

export function replaceFirstHeading(source: string, title: string): string {
  if (/^#\s+.+$/m.test(source)) {
    return source.replace(/^#[ \t]+(.+?)([ \t]+\{[^}\n]*\})?[ \t]*$/m, (_match, _oldTitle: string, attrs: string | undefined) => {
      return `# ${title}${attrs ?? ""}`;
    });
  }
  return `# ${title} {id="${slug(title) || "intro"}"}\n\n${source}`;
}

export function sourceTitle(source: string): string {
  return source.match(/^#\s+(.+)$/m)?.[1]?.replace(/\s+\{[^}]*\}\s*$/, "").trim() || "Untitled Page";
}

export function confirmDiscardDirty(): boolean {
  if (!state.dirty) return true;
  if (!window.confirm("Discard unsaved page changes?")) return false;
  if (state.currentPage) clearLocalDraft(state.currentPage.id);
  state.pendingLocalDraft = undefined;
  state.dirty = false;
  return true;
}

export function updateAddress(): void {
  const params = new URLSearchParams();
  if (state.currentSite) params.set("site", state.currentSite.id);
  if (state.currentPage) params.set("doc", state.currentPage.id);
  if (shareToken) params.set("share", shareToken);
  const next = `${window.location.pathname}?${params.toString()}`;
  window.history.replaceState(null, "", next);
}

function cloudAppDocumentUrl(id: string, token: string): string {
  return absoluteUrl(`/cloud.html?doc=${encodeURIComponent(id)}&share=${encodeURIComponent(token)}`);
}

function cloudAppSiteUrl(id: string, token: string): string {
  return absoluteUrl(`/cloud.html?site=${encodeURIComponent(id)}&share=${encodeURIComponent(token)}`);
}
