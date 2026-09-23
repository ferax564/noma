/** Rendered preview iframe: document building and in-place preview editing. */
import defaultThemeCss from "../../themes/default.css";
import { closeContextMenu, showPreviewContextMenuAt } from "./context-menu.js";
import { previewFrame, sourceInput } from "./dom.js";
import { deleteSectionAtLine, insertSectionAtEnd, insertSourceBlockAtIndex, newSectionSource, replaceSourceLines, saveCurrentPage, sectionEndInsertIndex } from "./editor.js";
import { applyPreviewPaperWidth, handlePreviewPaperResizeKeydown, startPreviewPaperResize } from "./layout.js";
import { canEditPage } from "./permissions.js";
import { state } from "./state.js";
import type { PreviewEditKind, PreviewInsertKind } from "./types.js";
import { escapeHtml, normalizeBlockText, normalizeInlineText, positiveInt, setCloudStatus } from "./util.js";
import { installPreviewWikiLinks } from "./wiki.js";

export function previewDocument(body: string): string {
  const previewChrome = state.themeMode === "dark" ? "#111820" : "#f4f1e9";
  const previewBorder = state.themeMode === "dark" ? "#37323d" : "#e6dfd2";
  const previewShadow =
    state.themeMode === "dark"
      ? "0 24px 70px -46px rgba(0,0,0,.86)"
      : "0 24px 70px -46px rgba(32,36,42,.42)";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<style>
${defaultThemeCss}
body{margin:0;padding:28px;background:${previewChrome};color:#20242a}
.noma-document{max-width:${state.previewPaperWidth}px;margin:0 auto;background:#fffefa;border:1px solid ${previewBorder};box-shadow:${previewShadow};padding:44px 52px}
@media(max-width:720px){body{padding:14px}.noma-document{padding:24px 20px}}
</style>
</head>
<body><main class="noma-document">${body}</main></body>
</html>`;
}

export function installPreviewEditing(): void {
  const previewDoc = previewFrame.contentDocument;
  if (!previewDoc) return;
  applyPreviewPaperWidth(previewDoc);
  installPreviewWikiLinks(previewDoc);
  if (!state.renderState.error && canEditPage()) installPreviewContextMenus(previewDoc);
  if (state.viewMode !== "preview" || state.renderState.error || !canEditPage()) return;

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

export function previewElementBlockId(element: HTMLElement): string | undefined {
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

export function insertPreviewBlockAfter(element: HTMLElement, kind: PreviewInsertKind): void {
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

function focusPendingPreviewLine(previewDoc: Document): void {
  const line = state.pendingPreviewFocusLine;
  if (line === undefined) return;
  state.pendingPreviewFocusLine = undefined;
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
  if (!isPreviewEditKind(kind) || line === undefined) {
    setCloudStatus("Rendered edit cannot sync", "warning");
    return;
  }
  const endLine = positiveInt(element.dataset.nomaEndLine) ?? line;

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

export function deletePreviewSection(element: HTMLElement): void {
  if (element.dataset.nomaEditable !== "section") {
    setCloudStatus("Select a section heading to delete", "warning");
    return;
  }
  deleteSectionAtLine(positiveInt(element.dataset.nomaLine));
}

function isPreviewEditKind(value: string | undefined): value is PreviewEditKind {
  return value === "section" || value === "paragraph" || value === "list_item" || value === "quote";
}

export function previewError(message: string): string {
  return `<!doctype html><html lang="en"><body style="font:14px sans-serif;color:#a33a32;padding:20px">${escapeHtml(message)}</body></html>`;
}
