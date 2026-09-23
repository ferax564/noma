/** Source editor: current page, save/reload, render pipeline, diagnostics, outline and source edits. */
import { parse } from "../../src/parser.js";
import { validate } from "../../src/validator.js";
import { renderHtml } from "../../src/renderer-html.js";
import { renderLlm } from "../../src/renderer-llm.js";
import { type Diagnostic, walk } from "../../src/ast.js";
import { CloudRequestError, fetchCloudJson } from "./api.js";
import { refreshActivity, refreshApprovals, refreshPageCollaboration, renderCollaborationPanels } from "./collaboration.js";
import { activeDocumentStorageKey } from "./constants.js";
import { showOutlineContextMenu } from "./context-menu.js";
import { diagnosticsList, diagnosticsSummary, draftRecoveryStatus, historyStatus, outlineList, pageTitleInput, previewFrame, sourceInput } from "./dom.js";
import { clearLocalDraft, persistLocalDraft, readLocalDraft } from "./drafts.js";
import { refreshHistory, renderHistory } from "./history.js";
import { renderChrome } from "./layout.js";
import { confirmDiscardDirty, pageFolder, recordRecent, replacePage, sourceTitle, updateAddress } from "./navigation.js";
import { refreshPageMeta } from "./page-meta.js";
import { canEditPage } from "./permissions.js";
import { previewDocument, previewError } from "./preview.js";
import { state } from "./state.js";
import type { CloudDocumentResponse } from "./types.js";
import { emptyState, errorMessage, formatDate, iconButton, setBusy, setCloudStatus, setPanelStatus } from "./util.js";
import { renderWikiPanel } from "./wiki.js";

export async function saveCurrentPage(): Promise<void> {
  if (!state.currentPage || !canEditPage()) return;
  if (state.renderState.error) {
    setCloudStatus("Fix the render error before saving", "error");
    return;
  }

  setBusy(true, "Saving page", "warning");
  try {
    const endpoint = currentPageEndpoint();
    const saved = await fetchCloudJson<CloudDocumentResponse>(endpoint, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        title: pageTitleInput.value.trim() || sourceTitle(sourceInput.value),
        source: sourceInput.value,
        expectedHash: state.currentPage.hash,
      }),
    });
    replacePage(saved);
    state.currentPage = saved;
    state.savedPageSource = saved.source;
    state.savedPageHash = saved.hash;
    state.savedPageTitle = saved.title;
    state.dirty = false;
    clearLocalDraft(saved.id);
    state.pendingLocalDraft = undefined;
    syncTitleFromSource();
    setCloudStatus("Saved page", "ok");
    updateAddress();
    await Promise.all([refreshHistory({ silent: true }), refreshApprovals(), refreshActivity()]);
  } catch (error) {
    if (error instanceof CloudRequestError && error.status === 409) {
      setCloudStatus("This page changed elsewhere. Your draft is preserved; reload to review the latest saved version.", "error");
      setPanelStatus(historyStatus, "Save conflict: reload the page before merging or saving again.", "error");
    } else {
      setCloudStatus(errorMessage(error), "error");
    }
  } finally {
    setBusy(false);
    renderChrome();
  }
}

export async function reloadCurrentPage(): Promise<void> {
  if (!state.currentPage || !confirmDiscardDirty()) return;
  setBusy(true, "Reloading page", "warning");
  try {
    const page = await fetchCloudJson<CloudDocumentResponse>(currentPageEndpoint());
    replacePage(page);
    setCurrentPage(page);
    setCloudStatus("Reloaded latest page", "ok");
  } catch (error) {
    setCloudStatus(errorMessage(error), "error");
  } finally {
    setBusy(false);
    renderChrome();
  }
}

export function currentPageEndpoint(): string {
  if (!state.currentPage) throw new Error("No page is selected");
  return state.currentSite?.documentIds.includes(state.currentPage.id)
    ? `/api/sites/${encodeURIComponent(state.currentSite.id)}/documents/${encodeURIComponent(state.currentPage.id)}`
    : `/api/documents/${encodeURIComponent(state.currentPage.id)}`;
}

export function setCurrentPage(page: CloudDocumentResponse | undefined): void {
  state.currentPage = page;
  state.documentRevisions = [];
  state.comments = [];
  state.approvals = [];
  state.activityEvents = [];
  state.patchProposals = [];
  if (!page) {
    pageTitleInput.value = "";
    sourceInput.value = "";
    state.dirty = false;
    state.savedPageSource = "";
    state.savedPageHash = "";
    state.savedPageTitle = "";
    state.pendingLocalDraft = undefined;
    renderCurrent();
    renderHistory();
    renderCollaborationPanels();
    renderChrome();
    return;
  }
  state.savedPageSource = page.source;
  state.savedPageHash = page.hash;
  state.savedPageTitle = page.title;
  state.pendingLocalDraft = readLocalDraft(page.id);
  const recoverableDraft = state.pendingLocalDraft?.baseHash === page.hash ? state.pendingLocalDraft : undefined;
  const recoverable = recoverableDraft !== undefined;
  pageTitleInput.value = recoverableDraft ? recoverableDraft.title : page.title;
  sourceInput.value = recoverableDraft ? recoverableDraft.source : page.source;
  state.activeFolder = pageFolder(page.id);
  state.dirty = Boolean(recoverable);
  localStorage.setItem(activeDocumentStorageKey, page.id);
  if (recoverable) setPanelStatus(draftRecoveryStatus, `Recovered local draft from ${formatDate(state.pendingLocalDraft!.updatedAt)}`, "warning");
  else if (state.pendingLocalDraft) setPanelStatus(draftRecoveryStatus, "Saved source changed since this local draft. Recover or run an explicit three-way merge.", "error");
  renderCurrent();
  renderHistory();
  renderCollaborationPanels();
  renderChrome();
  void refreshHistory({ silent: true });
  void refreshPageCollaboration();
  void refreshPageMeta();
  void recordRecent("document", page.id);
}

export function renderCurrent(): void {
  const source = sourceInput.value;
  try {
    const doc = parse(source, { filename: `${state.currentPage?.id ?? "draft"}.noma` });
    const diagnostics = validate(doc);
    const body = renderHtml(doc, {
      standalone: false,
      allowEscapeHatches: false,
      externalAssets: false,
      interactive: false,
      sourcePositions: true,
    });
    state.renderState = {
      doc,
      diagnostics,
      llm: renderLlm(doc),
    };
    previewFrame.srcdoc = previewDocument(body);
  } catch (error) {
    state.renderState = {
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

export function scheduleRender(): void {
  if (state.renderTimer !== undefined) window.clearTimeout(state.renderTimer);
  state.renderTimer = window.setTimeout(() => {
    state.renderTimer = undefined;
    renderCurrent();
  }, 180);
}

function renderDiagnostics(): void {
  diagnosticsList.textContent = "";
  if (state.renderState.error) {
    diagnosticsSummary.textContent = "Render failed";
    diagnosticsSummary.dataset.state = "error";
    diagnosticsList.append(diagnosticRow("error", "render", state.renderState.error.message));
    return;
  }

  const errors = state.renderState.diagnostics.filter((item) => item.severity === "error").length;
  const warnings = state.renderState.diagnostics.filter((item) => item.severity === "warning").length;
  const infos = state.renderState.diagnostics.filter((item) => item.severity === "info").length;
  diagnosticsSummary.textContent = `${errors} errors / ${warnings} warnings / ${infos} info`;
  diagnosticsSummary.dataset.state = errors > 0 ? "error" : warnings > 0 ? "warning" : "ok";

  if (state.renderState.diagnostics.length === 0) {
    diagnosticsList.append(emptyState("No diagnostics"));
    return;
  }

  for (const item of state.renderState.diagnostics) {
    diagnosticsList.append(diagnosticRow(item.severity, item.code, item.message, item.pos?.line));
  }
}

function renderOutline(): void {
  outlineList.textContent = "";
  const doc = state.renderState.doc;
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

export function markDirty(): void {
  state.dirty = true;
  if (state.currentPage) state.currentPage = { ...state.currentPage, source: sourceInput.value, title: pageTitleInput.value.trim() || sourceTitle(sourceInput.value) };
  persistLocalDraft();
  renderChrome();
}

export function syncTitleFromSource(): void {
  if (document.activeElement === pageTitleInput) return;
  const title = sourceTitle(sourceInput.value);
  pageTitleInput.value = title;
  if (state.currentPage) state.currentPage = { ...state.currentPage, title };
}

export function insertSectionAtEnd(): void {
  const lines = sourceInput.value.split("\n");
  insertSourceBlockAtIndex(lines.length, newSectionSource(lines.length), "Added section at end");
}

export function insertSectionAtCursor(): void {
  const index = sourceCursorInsertIndex();
  insertSourceBlockAtIndex(index, newSectionSource(index + 1), "Added section at cursor");
}

export function insertParagraphAtCursor(): void {
  insertSourceBlockAtIndex(sourceCursorInsertIndex(), "New paragraph.", "Added paragraph at cursor");
}

function sourceCursorInsertIndex(): number {
  const beforeCursor = sourceInput.value.slice(0, sourceInput.selectionStart);
  return beforeCursor.split("\n").length;
}

export function insertSourceBlockAtIndex(index: number, sourceBlock: string, status: string): void {
  if (state.renderTimer !== undefined) {
    window.clearTimeout(state.renderTimer);
    state.renderTimer = undefined;
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
  state.pendingPreviewFocusLine = boundedIndex + (needsPrefix ? 2 : 1);
  lines.splice(boundedIndex, 0, ...insertLines);
  sourceInput.value = lines.join("\n");
  syncTitleFromSource();
  markDirty();
  setCloudStatus(status, "ok");
  renderCurrent();
}

export function newSectionSource(contextLine: number): string {
  const currentLevel = headingLevelAtLine(contextLine) ?? nearestHeadingLevelBefore(contextLine) ?? 2;
  const level = Math.max(2, currentLevel);
  const id = uniqueSourceId("new-section");
  return `${"#".repeat(level)} New section {id="${id}"}\n\nStart writing here.`;
}

export function sectionEndInsertIndex(headingLine: number): number {
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

export function replaceSourceLines(startLine: number, endLine: number, replacement: string): void {
  if (state.renderTimer !== undefined) {
    window.clearTimeout(state.renderTimer);
    state.renderTimer = undefined;
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

export function deleteSectionAtLine(line: number | undefined): void {
  if (!line || !canEditPage()) return;
  const level = headingLevelAtLine(line);
  if (level === undefined || level <= 1) {
    setCloudStatus("Root section cannot be deleted here", "warning");
    return;
  }
  const title = sourceSectionTitleAtLine(line);
  if (!window.confirm(`Delete section "${title}" and all nested content?`)) return;

  if (state.renderTimer !== undefined) {
    window.clearTimeout(state.renderTimer);
    state.renderTimer = undefined;
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

export function focusBlock(blockId: string): void {
  const doc = parse(sourceInput.value, { filename: `${state.currentPage?.id ?? "draft"}.noma` });
  for (const node of walk(doc)) {
    if ((node.id === blockId || node.aliases?.includes(blockId)) && node.pos) {
      focusSourceLine(node.pos.line);
      return;
    }
  }
}

export function focusSourceLine(line: number): void {
  const lines = sourceInput.value.split("\n");
  const boundedLine = Math.max(1, Math.min(lines.length, line));
  const offset = lines.slice(0, boundedLine - 1).join("\n").length + (boundedLine > 1 ? 1 : 0);
  sourceInput.focus();
  sourceInput.setSelectionRange(offset, offset);
  const lineHeight = Number.parseFloat(window.getComputedStyle(sourceInput).lineHeight) || 20;
  sourceInput.scrollTop = Math.max(0, (boundedLine - 4) * lineHeight);
}
