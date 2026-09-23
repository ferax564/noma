/** Breadcrumbs, labels and watch state for the current page. */
import { trackPageView } from "./analytics.js";
import { fetchCloudJson } from "./api.js";
import { addLabelButton, pageBreadcrumbs, pageLabels, revisionDiffOutput, watchPageButton } from "./dom.js";
import { renderChrome } from "./layout.js";
import { selectPage } from "./navigation.js";
import { canEditPage } from "./permissions.js";
import { state } from "./state.js";
import { errorMessage, setCloudStatus } from "./util.js";

export async function refreshPageMeta(): Promise<void> {
  state.currentLabels = [];
  state.currentWatching = false;
  revisionDiffOutput.hidden = true;
  const page = state.currentPage;
  void trackPageView();
  if (!page || !state.cloudUser) {
    renderChrome();
    return;
  }
  try {
    const [labels, watch] = await Promise.all([
      fetchCloudJson<{ labels: string[] }>(`/api/documents/${encodeURIComponent(page.id)}/labels`),
      fetchCloudJson<{ watching: boolean }>(`/api/documents/${encodeURIComponent(page.id)}/watch`),
    ]);
    if (state.currentPage?.id !== page.id) return;
    state.currentLabels = labels.labels;
    state.currentWatching = watch.watching;
  } catch {
    return;
  } finally {
    renderChrome();
  }
}

export async function toggleWatch(): Promise<void> {
  if (!state.currentPage || !state.cloudUser) return;
  try {
    const response = await fetchCloudJson<{ watching: boolean }>(`/api/documents/${encodeURIComponent(state.currentPage.id)}/watch`, {
      method: state.currentWatching ? "DELETE" : "PUT",
    });
    state.currentWatching = response.watching;
    setCloudStatus(state.currentWatching ? "Watching page: you will be notified of edits" : "Stopped watching page", "ok");
  } catch (error) {
    setCloudStatus(errorMessage(error), "error");
  } finally {
    renderChrome();
  }
}

export async function addLabel(): Promise<void> {
  if (!state.currentPage || !canEditPage()) return;
  const label = window.prompt("Add label", "")?.trim();
  if (!label) return;
  await updateLabels({ method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ label }) });
}

async function removeLabel(label: string): Promise<void> {
  if (!state.currentPage || !canEditPage()) return;
  await updateLabels({ method: "DELETE" }, `/${encodeURIComponent(label)}`);
}

async function updateLabels(init: RequestInit, suffix = ""): Promise<void> {
  if (!state.currentPage) return;
  try {
    const response = await fetchCloudJson<{ labels: string[] }>(`/api/documents/${encodeURIComponent(state.currentPage.id)}/labels${suffix}`, init);
    state.currentLabels = response.labels;
    setCloudStatus("Updated labels", "ok");
  } catch (error) {
    setCloudStatus(errorMessage(error), "error");
  } finally {
    renderChrome();
  }
}

export function renderPageMeta(): void {
  pageLabels.textContent = "";
  for (const label of state.currentLabels) {
    const chip = document.createElement("span");
    chip.className = "label-chip";
    chip.textContent = label;
    if (canEditPage()) {
      const remove = document.createElement("button");
      remove.type = "button";
      remove.textContent = "×";
      remove.setAttribute("aria-label", `Remove label ${label}`);
      remove.addEventListener("click", () => void removeLabel(label));
      chip.append(remove);
    }
    pageLabels.append(chip);
  }
  addLabelButton.hidden = !state.currentPage || !canEditPage();
  addLabelButton.disabled = state.busy;
  watchPageButton.disabled = state.busy || !state.cloudUser || !state.currentPage;
  watchPageButton.textContent = state.currentWatching ? "Unwatch" : "Watch";
  watchPageButton.setAttribute("aria-pressed", String(state.currentWatching));

  pageBreadcrumbs.textContent = "";
  if (!state.currentSite || !state.currentPage) return;
  const siteCrumb = document.createElement("span");
  siteCrumb.className = "crumb crumb-site";
  siteCrumb.textContent = state.currentSite.title;
  pageBreadcrumbs.append(siteCrumb);
  for (const ancestorId of pageAncestors(state.currentPage.id).reverse()) {
    const ancestor = state.pages.find((page) => page.id === ancestorId);
    if (!ancestor) continue;
    const crumb = document.createElement("button");
    crumb.type = "button";
    crumb.className = "crumb";
    crumb.textContent = ancestor.title;
    crumb.addEventListener("click", () => selectPage(ancestor.id));
    pageBreadcrumbs.append(crumb);
  }
}

export function pageParentId(pageId: string): string | undefined {
  const parent = state.currentSite?.pageParents?.[pageId];
  return parent && state.pages.some((page) => page.id === parent) ? parent : undefined;
}

export function pageAncestors(pageId: string): string[] {
  const ancestors: string[] = [];
  let cursor = pageParentId(pageId);
  while (cursor && !ancestors.includes(cursor) && cursor !== pageId) {
    ancestors.push(cursor);
    cursor = pageParentId(cursor);
  }
  return ancestors;
}
