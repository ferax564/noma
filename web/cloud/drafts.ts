/** Local offline drafts: persist, recover, merge and discard. */
import { fetchCloudJson } from "./api.js";
import { offlineDraftStorageKey } from "./constants.js";
import { discardDraftButton, draftRecoveryStatus, mergeDraftButton, pageTitleInput, recoverDraftButton, sourceInput } from "./dom.js";
import { scheduleRender, setCurrentPage } from "./editor.js";
import { renderChrome } from "./layout.js";
import { sourceTitle } from "./navigation.js";
import { state } from "./state.js";
import type { CloudDocumentResponse, LocalOfflineDraft, OfflineMergeResponse } from "./types.js";
import { errorMessage, setPanelStatus } from "./util.js";

export function persistLocalDraft(): void {
  if (!state.cloudUser || !state.currentPage || !state.dirty) return;
  const drafts = readLocalDrafts();
  const existing = drafts[state.currentPage.id];
  const draft: LocalOfflineDraft = {
    ...(existing?.id ? { id: existing.id } : {}),
    userId: state.cloudUser.id,
    documentId: state.currentPage.id,
    title: pageTitleInput.value.trim() || sourceTitle(sourceInput.value),
    baseHash: existing?.baseHash ?? (state.savedPageHash || state.currentPage.hash),
    baseSource: existing?.baseSource ?? state.savedPageSource,
    source: sourceInput.value,
    updatedAt: new Date().toISOString(),
  };
  drafts[state.currentPage.id] = draft;
  localStorage.setItem(offlineDraftStorageKey, JSON.stringify(drafts));
  state.pendingLocalDraft = draft;
  renderDraftRecovery();
}

function readLocalDrafts(): Record<string, LocalOfflineDraft> {
  try {
    const parsed = JSON.parse(localStorage.getItem(offlineDraftStorageKey) ?? "{}") as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    const drafts: Record<string, LocalOfflineDraft> = {};
    for (const [id, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (!value || typeof value !== "object" || Array.isArray(value)) continue;
      const candidate = value as Partial<LocalOfflineDraft>;
      if (typeof candidate.documentId !== "string" || typeof candidate.baseHash !== "string" || typeof candidate.baseSource !== "string" || typeof candidate.source !== "string" || typeof candidate.title !== "string" || typeof candidate.updatedAt !== "string" || typeof candidate.userId !== "string") continue;
      if (state.cloudUser && candidate.userId !== state.cloudUser.id) continue;
      drafts[id] = candidate as LocalOfflineDraft;
    }
    return drafts;
  } catch {
    return {};
  }
}

export function readLocalDraft(documentId: string): LocalOfflineDraft | undefined {
  return readLocalDrafts()[documentId];
}

export function clearLocalDraft(documentId: string): void {
  const drafts = readLocalDrafts();
  delete drafts[documentId];
  localStorage.setItem(offlineDraftStorageKey, JSON.stringify(drafts));
}

export function restoreLatestOfflineDraft(): boolean {
  const draft = Object.values(readLocalDrafts()).sort((left, right) => right.updatedAt.localeCompare(left.updatedAt))[0];
  if (!draft) return false;
  const page: CloudDocumentResponse = {
    id: draft.documentId,
    title: draft.title,
    source: draft.baseSource,
    hash: draft.baseHash,
    createdAt: draft.updatedAt,
    updatedAt: draft.updatedAt,
    diagnostics: [],
    access: { role: "editor", via: "offline-cache" },
  };
  state.currentSite = undefined;
  state.pages = [page];
  setCurrentPage(page);
  return true;
}

export function recoverLocalDraft(): void {
  if (!state.pendingLocalDraft || !state.currentPage) return;
  sourceInput.value = state.pendingLocalDraft.source;
  pageTitleInput.value = state.pendingLocalDraft.title;
  state.dirty = true;
  setPanelStatus(draftRecoveryStatus, "Recovered the cached draft. Save or merge when connected.", "warning");
  scheduleRender();
  renderChrome();
}

export async function mergeLocalDraft(): Promise<void> {
  if (!state.pendingLocalDraft || !state.currentPage) return;
  setPanelStatus(draftRecoveryStatus, "Merging saved, current, and offline sources", "warning");
  try {
    let merged: OfflineMergeResponse;
    if (state.cloudAvailable && state.cloudUser) {
      const savedDraft = await fetchCloudJson<{ id: string }>("/api/offline/drafts", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ documentId: state.pendingLocalDraft.documentId, baseHash: state.pendingLocalDraft.baseHash, baseSource: state.pendingLocalDraft.baseSource, source: state.pendingLocalDraft.source }),
      });
      merged = await fetchCloudJson<OfflineMergeResponse>(`/api/offline/drafts/${encodeURIComponent(savedDraft.id)}/merge`, { method: "POST" });
    } else {
      merged = mergeOfflineSources(state.pendingLocalDraft.baseSource, state.savedPageSource, state.pendingLocalDraft.source, state.savedPageHash);
    }
    sourceInput.value = merged.source;
    pageTitleInput.value = sourceTitle(merged.source);
    state.dirty = true;
    persistLocalDraft();
    setPanelStatus(draftRecoveryStatus, merged.state === "conflict" ? `${merged.conflicts.length} merge conflict${merged.conflicts.length === 1 ? "" : "s"}; resolve the markers before saving` : "Draft merged against the current saved source", merged.state === "conflict" ? "error" : "ok");
    scheduleRender();
  } catch (error) {
    setPanelStatus(draftRecoveryStatus, errorMessage(error), "error");
  } finally {
    renderChrome();
  }
}

function mergeOfflineSources(baseSource: string, currentSource: string, draftSource: string, expectedHash: string): OfflineMergeResponse {
  const base = baseSource.split("\n");
  const current = currentSource.split("\n");
  const draft = draftSource.split("\n");
  const output: string[] = [];
  const conflicts: OfflineMergeResponse["conflicts"] = [];
  for (let index = 0; index < Math.max(base.length, current.length, draft.length); index++) {
    const baseLine = base[index] ?? "";
    const currentLine = current[index] ?? "";
    const draftLine = draft[index] ?? "";
    if (currentLine === draftLine) output.push(currentLine);
    else if (currentLine === baseLine) output.push(draftLine);
    else if (draftLine === baseLine) output.push(currentLine);
    else {
      conflicts.push({ line: index + 1, base: baseLine, current: currentLine, draft: draftLine });
      output.push(`<!-- NOMA MERGE CONFLICT: CURRENT -->\n${currentLine}\n<!-- NOMA MERGE CONFLICT: OFFLINE DRAFT -->\n${draftLine}\n<!-- NOMA MERGE CONFLICT: END -->`);
    }
  }
  return { state: conflicts.length > 0 ? "conflict" : "merged", source: output.join("\n"), expectedHash, conflicts };
}

export function discardCurrentLocalDraft(): void {
  if (!state.currentPage || !state.pendingLocalDraft) return;
  clearLocalDraft(state.currentPage.id);
  state.pendingLocalDraft = undefined;
  setPanelStatus(draftRecoveryStatus, "Cached draft discarded", "ok");
  renderChrome();
}

export function renderDraftRecovery(): void {
  const hasDraft = Boolean(state.pendingLocalDraft && state.currentPage?.id === state.pendingLocalDraft.documentId);
  recoverDraftButton.disabled = state.busy || !hasDraft;
  mergeDraftButton.disabled = state.busy || !hasDraft;
  discardDraftButton.disabled = state.busy || !hasDraft;
  if (!hasDraft && !state.dirty) setPanelStatus(draftRecoveryStatus, "Drafts are cached locally as you type.", "ok");
}
