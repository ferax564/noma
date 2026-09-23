/** Space settings panel (key, description, icon, home page) plus archive/unarchive and the archived-spaces toggle. */
import { fetchCloudJson } from "./api.js";
import { renderChrome } from "./layout.js";
import { loadSite, refreshSites } from "./navigation.js";
import { roleRank } from "./permissions.js";
import { state } from "./state.js";
import type { CloudSiteResponse } from "./types.js";
import { errorMessage, setPanelStatus } from "./util.js";

const keyInput = requireElement<HTMLInputElement>("spaceKeyInput");
const iconInput = requireElement<HTMLInputElement>("spaceIconInput");
const descriptionInput = requireElement<HTMLTextAreaElement>("spaceDescriptionInput");
const homeSelect = requireElement<HTMLSelectElement>("spaceHomeSelect");
const saveButton = requireElement<HTMLButtonElement>("spaceSettingsSaveButton");
const archiveButton = requireElement<HTMLButtonElement>("spaceArchiveButton");
const status = requireElement<HTMLElement>("spaceSettingsStatus");
const archivedBadge = requireElement<HTMLElement>("spaceArchivedBadge");
const showArchived = requireElement<HTMLInputElement>("spaceShowArchivedInput");

let renderedSiteId: string | undefined;
let renderedSiteUpdatedAt: string | undefined;

export function bindSpaceSettings(): void {
  saveButton.addEventListener("click", () => void saveSpaceSettings());
  archiveButton.addEventListener("click", () => void toggleArchive());
  showArchived.addEventListener("change", () => void refreshSites({ silent: true }));
}

/** `archived` query value for the space list, driven by the rail toggle. */
export function spaceListArchivedParam(): string {
  return showArchived.checked ? "?archived=include" : "";
}

/** `🛠️ Engineering · ENG` style label for rail rows. */
export function spaceLabel(site: CloudSiteResponse): string {
  return `${site.icon ? `${site.icon} ` : ""}${site.title}${site.key ? ` · ${site.key}` : ""}`;
}

export function renderSpaceSettings(): void {
  const site = state.currentSite;
  const owner = roleRank(site?.access?.role ?? "viewer") >= roleRank("owner");
  const editor = roleRank(site?.access?.role ?? "viewer") >= roleRank("editor");
  const writable = Boolean(site && editor && !site.archived && state.cloudUser);
  archivedBadge.hidden = !site?.archived;
  for (const control of [iconInput, descriptionInput, homeSelect]) control.disabled = state.busy || !writable;
  keyInput.disabled = state.busy || !writable || !owner;
  saveButton.disabled = state.busy || !writable;
  archiveButton.disabled = state.busy || !site || !owner;
  archiveButton.textContent = site?.archived ? "Unarchive space" : "Archive space";
  if (!site) {
    renderedSiteId = undefined;
    keyInput.value = "";
    iconInput.value = "";
    descriptionInput.value = "";
    homeSelect.textContent = "";
    return;
  }
  if (renderedSiteId === site.id && renderedSiteUpdatedAt === site.updatedAt && homeSelect.options.length === state.pages.length + 1) return;
  renderedSiteId = site.id;
  renderedSiteUpdatedAt = site.updatedAt;
  keyInput.value = site.key ?? "";
  iconInput.value = site.icon ?? "";
  descriptionInput.value = site.description ?? "";
  homeSelect.textContent = "";
  homeSelect.append(new Option("First page in the tree", ""));
  for (const page of state.pages) homeSelect.append(new Option(page.title, page.id));
  homeSelect.value = site.homeDocumentId ?? "";
}

async function saveSpaceSettings(): Promise<void> {
  const site = state.currentSite;
  if (!site) return;
  const body: Record<string, unknown> = {
    description: descriptionInput.value,
    icon: iconInput.value,
    homeDocumentId: homeSelect.value || null,
  };
  const key = keyInput.value.trim().toUpperCase();
  if (key && key !== site.key) body.key = key;
  try {
    const updated = await fetchCloudJson<CloudSiteResponse>(`/api/sites/${encodeURIComponent(site.id)}`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
    state.currentSite = { ...site, ...updated, documents: undefined };
    renderedSiteId = undefined;
    setPanelStatus(status, "Space settings saved", "ok");
    await refreshSites({ silent: true });
  } catch (error) {
    setPanelStatus(status, errorMessage(error), "error");
  } finally {
    renderChrome();
  }
}

async function toggleArchive(): Promise<void> {
  const site = state.currentSite;
  if (!site) return;
  const action = site.archived ? "unarchive" : "archive";
  if (action === "archive" && !window.confirm(`Archive ${site.title}? It becomes read-only and hidden from the space list.`)) return;
  try {
    await fetchCloudJson(`/api/sites/${encodeURIComponent(site.id)}/${action}`, { method: "POST" });
    setPanelStatus(status, action === "archive" ? "Space archived (read-only)" : "Space restored", "ok");
    if (action === "archive") showArchived.checked = true;
    await loadSite(site.id, state.currentPage?.id);
  } catch (error) {
    setPanelStatus(status, errorMessage(error), "error");
  }
}

function requireElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing #${id}`);
  return element as T;
}
