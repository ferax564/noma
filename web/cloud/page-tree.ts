/** Page tree reordering: drag and drop in the rail, plus keyboard and context-menu moves (up, down, indent, outdent). */
import { fetchCloudJson } from "./api.js";
import { renderChrome } from "./layout.js";
import { pageAncestors, pageParentId } from "./page-meta.js";
import { canEditSite } from "./permissions.js";
import { state } from "./state.js";
import type { CloudDocumentResponse, CloudSiteResponse } from "./types.js";
import { errorMessage, setBusy, setCloudStatus } from "./util.js";

type DropZone = "before" | "inside" | "after";

let draggedPageId: string | undefined;

/** Siblings of `pageId` (same parent) in space order, including the page itself. */
export function pageSiblings(pageId: string): string[] {
  const parent = pageParentId(pageId);
  return state.pages.map((page) => page.id).filter((id) => pageParentId(id) === parent);
}

/** Moves a page to `parentId` (null for top level) at `position` among its new siblings. */
export async function movePageInTree(pageId: string, parentId: string | null, position: number, status: string): Promise<void> {
  const site = state.currentSite;
  if (!site || !canEditSite()) return;
  if (parentId && (parentId === pageId || pageAncestors(parentId).includes(pageId))) {
    setCloudStatus("A page cannot be moved under itself", "error");
    return;
  }
  setBusy(true, "Moving page", "warning");
  try {
    const response = await fetchCloudJson<{ site: CloudSiteResponse }>(
      `/api/sites/${encodeURIComponent(site.id)}/documents/${encodeURIComponent(pageId)}/parent`,
      { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ parentId, position: Math.max(0, position) }) },
    );
    state.currentSite = { ...site, documentIds: response.site.documentIds, pageParents: response.site.pageParents ?? {} };
    state.pages = response.site.documentIds
      .map((id) => state.pages.find((candidate) => candidate.id === id))
      .filter((candidate): candidate is CloudDocumentResponse => Boolean(candidate));
    setCloudStatus(status, "ok");
  } catch (error) {
    setCloudStatus(errorMessage(error), "error");
  } finally {
    setBusy(false);
    renderChrome();
    focusPageRow(pageId);
  }
}

export async function movePageUp(pageId: string): Promise<void> {
  const siblings = pageSiblings(pageId);
  const index = siblings.indexOf(pageId);
  if (index <= 0) return;
  await movePageInTree(pageId, pageParentId(pageId) ?? null, index - 1, "Moved page up");
}

export async function movePageDown(pageId: string): Promise<void> {
  const siblings = pageSiblings(pageId);
  const index = siblings.indexOf(pageId);
  if (index < 0 || index >= siblings.length - 1) return;
  await movePageInTree(pageId, pageParentId(pageId) ?? null, index + 1, "Moved page down");
}

/** Makes the page the last child of the sibling directly above it. */
export async function indentPage(pageId: string): Promise<void> {
  const siblings = pageSiblings(pageId);
  const previous = siblings[siblings.indexOf(pageId) - 1];
  if (!previous) return;
  const children = state.pages.filter((page) => pageParentId(page.id) === previous).length;
  const title = state.pages.find((page) => page.id === previous)?.title ?? "page";
  await movePageInTree(pageId, previous, children, `Moved under ${title}`);
}

/** Moves the page out one level, directly after its current parent. */
export async function outdentPage(pageId: string): Promise<void> {
  const parent = pageParentId(pageId);
  if (!parent) return;
  const parentSiblings = pageSiblings(parent);
  await movePageInTree(pageId, pageParentId(parent) ?? null, parentSiblings.indexOf(parent) + 1, "Moved up a level");
}

export function canMoveUp(pageId: string): boolean {
  return pageSiblings(pageId).indexOf(pageId) > 0;
}

export function canMoveDown(pageId: string): boolean {
  const siblings = pageSiblings(pageId);
  const index = siblings.indexOf(pageId);
  return index >= 0 && index < siblings.length - 1;
}

export function canOutdent(pageId: string): boolean {
  return Boolean(pageParentId(pageId));
}

/** Adds drag-and-drop and Alt+Arrow keyboard moves to a rendered page row. */
export function installPageRowReordering(row: HTMLElement, button: HTMLElement, page: CloudDocumentResponse): void {
  row.dataset.pageId = page.id;
  if (!canEditSite() || state.busy) return;
  row.draggable = true;
  button.setAttribute("aria-keyshortcuts", "Alt+ArrowUp Alt+ArrowDown Alt+ArrowRight Alt+ArrowLeft");
  button.title = `${page.title} — Alt+↑/↓ to reorder, Alt+→/← to indent or outdent`;
  row.addEventListener("dragstart", (event) => {
    draggedPageId = page.id;
    row.classList.add("page-dragging");
    event.dataTransfer?.setData("text/plain", page.id);
    if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
  });
  row.addEventListener("dragend", () => {
    draggedPageId = undefined;
    row.classList.remove("page-dragging");
    clearDropMarkers();
  });
  row.addEventListener("dragover", (event) => {
    if (!draggedPageId || draggedPageId === page.id || pageAncestors(page.id).includes(draggedPageId)) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "move";
    clearDropMarkers();
    row.dataset.drop = dropZone(row, event.clientY);
  });
  row.addEventListener("dragleave", () => {
    delete row.dataset.drop;
  });
  row.addEventListener("drop", (event) => {
    event.preventDefault();
    const moving = draggedPageId ?? event.dataTransfer?.getData("text/plain");
    const zone = dropZone(row, event.clientY);
    clearDropMarkers();
    if (!moving || moving === page.id || pageAncestors(page.id).includes(moving)) return;
    void dropPage(moving, page.id, zone);
  });
  button.addEventListener("keydown", (event) => {
    if (!event.altKey) return;
    const action = { ArrowUp: movePageUp, ArrowDown: movePageDown, ArrowRight: indentPage, ArrowLeft: outdentPage }[event.key];
    if (!action) return;
    event.preventDefault();
    void action(page.id);
  });
}

async function dropPage(movingId: string, targetId: string, zone: DropZone): Promise<void> {
  const title = state.pages.find((page) => page.id === targetId)?.title ?? "page";
  if (zone === "inside") {
    const children = state.pages.filter((page) => pageParentId(page.id) === targetId && page.id !== movingId).length;
    await movePageInTree(movingId, targetId, children, `Moved under ${title}`);
    return;
  }
  const parent = pageParentId(targetId) ?? null;
  const siblings = pageSiblings(targetId).filter((id) => id !== movingId);
  const index = siblings.indexOf(targetId) + (zone === "after" ? 1 : 0);
  await movePageInTree(movingId, parent, index, zone === "after" ? `Moved after ${title}` : `Moved before ${title}`);
}

function dropZone(row: HTMLElement, clientY: number): DropZone {
  const rect = row.getBoundingClientRect();
  const offset = (clientY - rect.top) / Math.max(1, rect.height);
  return offset < 0.28 ? "before" : offset > 0.72 ? "after" : "inside";
}

function clearDropMarkers(): void {
  for (const element of document.querySelectorAll<HTMLElement>(".page-entry[data-drop]")) delete element.dataset.drop;
}

function focusPageRow(pageId: string): void {
  document.querySelector<HTMLElement>(`.page-entry[data-page-id="${CSS.escape(pageId)}"] .page-row`)?.focus();
}
