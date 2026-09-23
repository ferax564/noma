/** Context menus for sites, folders, pages, outline, wiki links, source and preview. */
import { deleteSectionAtLine, focusSourceLine, insertParagraphAtCursor, insertSectionAtCursor, insertSourceBlockAtIndex, newSectionSource, saveCurrentPage, sectionEndInsertIndex } from "./editor.js";
import { copyLlmContext } from "./knowledge.js";
import { renderChrome, setViewMode } from "./layout.js";
import { copyArtifactLink, copyPageLink, copySiteLink, createFolder, createPage, deleteFolder, loadSite, movePage, movePageToFolder, movePageUnder, pageFolder, renameFolder, runAfterSelectPage, runWithLoadedSite, sameFolder, saveCurrentSite, selectPage, toggleFavorite, trashPage, trashSite } from "./navigation.js";
import { pageAncestors } from "./page-meta.js";
import { canMoveDown, canMoveUp, canOutdent, indentPage, movePageDown, movePageUp, outdentPage } from "./page-tree.js";
import { canCreatePage, canEditPage, canEditSite, canEditSiteRecord } from "./permissions.js";
import { deletePreviewSection, insertPreviewBlockAfter, previewElementBlockId } from "./preview.js";
import { openRestrictionsDialog } from "./restrictions.js";
import { state } from "./state.js";
import type { CloudDocumentResponse, CloudSiteResponse, ContextMenuAction, WikiResolvedLink } from "./types.js";
import { copyText, positiveInt, setCloudStatus } from "./util.js";
import { openWikiTarget } from "./wiki.js";

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

export function closeContextMenu(): void {
  for (const menu of [...document.querySelectorAll(".cloud-context-menu")]) menu.remove();
}

export function showSiteContextMenu(event: MouseEvent, site: CloudSiteResponse): void {
  const isCurrent = state.currentSite?.id === site.id;
  const canEdit = canEditSiteRecord(site);
  const favorite = state.favoriteItems.some((item) => item.resourceType === "site" && item.resourceId === site.id);
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
      label: favorite ? "Remove from favorites" : "Add to favorites",
      action: () => void toggleFavorite("site", site.id),
    },
    {
      label: "Save space",
      disabled: !isCurrent || !canEditSite(),
      action: () => void saveCurrentSite(),
    },
    {
      label: "Move space to trash",
      disabled: site.access?.role !== "owner" && site.currentRole !== "owner",
      danger: true,
      action: () => void trashSite(site),
    },
  ]);
}

export function showFolderContextMenu(event: MouseEvent, folder: string): void {
  const title = folder || "Pages";
  const sameAsCurrentPage = state.currentPage ? sameFolder(pageFolder(state.currentPage.id), folder) : false;
  showContextMenu(event, [
    {
      label: "Select folder",
      hint: title,
      action: () => {
        state.activeFolder = folder;
        setCloudStatus(folder ? `Selected ${folder}` : "Selected Pages", "ok");
        renderChrome();
      },
    },
    {
      label: "New page here",
      disabled: !canCreatePage(),
      action: () => {
        state.activeFolder = folder;
        void createPage(folder);
      },
    },
    {
      label: "Move current page here",
      disabled: !state.currentPage || !canEditSite() || sameAsCurrentPage,
      action: () => {
        if (state.currentPage) void movePageToFolder(state.currentPage.id, folder);
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

export function showPageContextMenu(event: MouseEvent, page: CloudDocumentResponse): void {
  const isCurrent = state.currentPage?.id === page.id;
  const favorite = state.favoriteItems.some((item) => item.resourceType === "document" && item.resourceId === page.id);
  showContextMenu(event, [
    {
      label: isCurrent ? "Focus page" : "Open page",
      hint: page.access?.role ?? state.currentSite?.access?.role ?? "viewer",
      action: () => {
        selectPage(page.id);
      },
    },
    {
      label: "Open in preview",
      action: () => {
        if (selectPage(page.id)) setViewMode("preview");
      },
    },
    {
      label: "Add child page",
      disabled: !canEditSite(),
      action: () => void createPage(pageFolder(pageAncestors(page.id).at(-1) ?? page.id), page.id),
    },
    {
      label: "Move under page...",
      disabled: !canEditSite(),
      action: () => void movePageUnder(page.id),
    },
    {
      label: "Move up",
      hint: "Alt+↑",
      disabled: !canEditSite() || !canMoveUp(page.id),
      action: () => void movePageUp(page.id),
    },
    {
      label: "Move down",
      hint: "Alt+↓",
      disabled: !canEditSite() || !canMoveDown(page.id),
      action: () => void movePageDown(page.id),
    },
    {
      label: "Indent",
      hint: "Alt+→",
      disabled: !canEditSite() || !canMoveUp(page.id),
      action: () => void indentPage(page.id),
    },
    {
      label: "Outdent",
      hint: "Alt+←",
      disabled: !canEditSite() || !canOutdent(page.id),
      action: () => void outdentPage(page.id),
    },
    {
      label: "Move to folder...",
      disabled: !canEditSite(),
      action: () => void movePage(page.id),
    },
    {
      label: state.activeFolder ? `Move to ${state.activeFolder}` : "Move to Pages",
      disabled: !canEditSite() || sameFolder(pageFolder(page.id), state.activeFolder),
      action: () => void movePageToFolder(page.id, state.activeFolder),
    },
    {
      label: "Copy page link",
      disabled: !state.currentSite,
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
      label: "Restrictions...",
      disabled: !state.cloudUser,
      action: () => void openRestrictionsDialog(page.id, page.title),
    },
    {
      label: favorite ? "Remove from favorites" : "Add to favorites",
      action: () => void toggleFavorite("document", page.id),
    },
    {
      label: "Save page",
      disabled: !isCurrent || !canEditPage(),
      separatorBefore: true,
      action: () => void saveCurrentPage(),
    },
    {
      label: "Move page to trash",
      disabled: !canEditSite() && page.access?.role !== "owner" && page.access?.role !== "editor",
      danger: true,
      action: () => void trashPage(page),
    },
  ]);
}

export function showOutlineContextMenu(
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

export function showWikiContextMenu(event: MouseEvent, link: WikiResolvedLink, kind: "link" | "backlink"): void {
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

export function showSourceContextMenu(event: MouseEvent): void {
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
      disabled: !canEditPage() || !state.currentPage,
      separatorBefore: true,
      hint: "Cmd/Ctrl S",
      action: () => void saveCurrentPage(),
    },
    {
      label: "Copy LLM context",
      disabled: Boolean(state.renderState.error) || !state.renderState.llm,
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

export function showPreviewContextMenuAt(clientX: number, clientY: number, element: HTMLElement): void {
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
