/** Revision history, revision diff and restore. */
import { fetchCloudJson } from "./api.js";
import { addIssueCommentButton, addIssueLinkButton, completeSprintButton, createIssueButton, createProjectButton, createSprintButton, historyList, historyStatus, issueAssigneeInput, issueCommentInput, issueFilterSelect, issueLabelsInput, issueLinkTargetInput, issueLinkTypeSelect, issuePrioritySelect, issueSearchInput, issueSprintSelect, issueSummaryInput, issueTypeSelect, manageSprintSelect, projectKeyInput, projectNameInput, refreshHistoryButton, refreshWorkButton, revisionDiffOutput, sprintNameInput, startSprintButton, workProjectSelect } from "./dom.js";
import { currentPageEndpoint, setCurrentPage } from "./editor.js";
import { renderChrome } from "./layout.js";
import { replacePage } from "./navigation.js";
import { canEditPage, canEditSite, canEditWorkProject } from "./permissions.js";
import { state } from "./state.js";
import type { CloudDocumentResponse, CloudDocumentRevisionSummary } from "./types.js";
import { emptyState, errorMessage, formatDate, setBusy, setCloudStatus, setPanelStatus, shortId } from "./util.js";
import { selectedWorkProject, selectedWorkSprint } from "./work.js";

async function showRevisionDiff(revision: CloudDocumentRevisionSummary): Promise<void> {
  if (!state.currentPage) return;
  try {
    const response = await fetchCloudJson<{
      from: { revision: number } | null;
      stats: { added: number; removed: number };
      blocks: { added: string[]; removed: string[]; changed: string[] };
      diff: string;
    }>(`${currentPageEndpoint()}/revisions/${revision.revision}/diff`);
    revisionDiffOutput.textContent = "";
    const heading = document.createElement("strong");
    heading.textContent = `Version ${revision.revision} vs ${response.from ? `version ${response.from.revision}` : "empty page"}: +${response.stats.added} −${response.stats.removed}`;
    revisionDiffOutput.append(heading);
    const changedBlocks = [
      ...response.blocks.added.map((id) => `+${id}`),
      ...response.blocks.removed.map((id) => `−${id}`),
      ...response.blocks.changed.map((id) => `~${id}`),
    ];
    if (changedBlocks.length > 0) {
      const blocks = document.createElement("div");
      blocks.className = "revision-diff-blocks";
      blocks.textContent = `Blocks: ${changedBlocks.join(", ")}`;
      revisionDiffOutput.append(blocks);
    }
    const pre = document.createElement("pre");
    for (const line of response.diff.split("\n")) {
      const row = document.createElement("span");
      row.className = line.startsWith("+") ? "diff-add" : line.startsWith("-") ? "diff-del" : "diff-ctx";
      row.textContent = `${line}\n`;
      pre.append(row);
    }
    revisionDiffOutput.append(pre);
    revisionDiffOutput.hidden = false;
  } catch (error) {
    setPanelStatus(historyStatus, errorMessage(error), "error");
  }
}

export async function refreshHistory(options: { silent?: boolean } = {}): Promise<void> {
  if (!state.currentPage) {
    state.documentRevisions = [];
    renderHistory();
    return;
  }
  const pageId = state.currentPage.id;
  if (!options.silent) setPanelStatus(historyStatus, "Loading history", "warning");
  try {
    const response = await fetchCloudJson<{ revisions: CloudDocumentRevisionSummary[] }>(`${currentPageEndpoint()}/revisions`);
    if (state.currentPage?.id !== pageId) return;
    state.documentRevisions = response.revisions;
    if (!options.silent) setPanelStatus(historyStatus, `${state.documentRevisions.length} saved version${state.documentRevisions.length === 1 ? "" : "s"}`, "ok");
  } catch (error) {
    if (!options.silent) setPanelStatus(historyStatus, errorMessage(error), "error");
  } finally {
    renderHistory();
  }
}

export function renderHistory(): void {
  historyList.textContent = "";
  refreshHistoryButton.disabled = state.busy || !state.currentPage;
  refreshWorkButton.disabled = state.busy || !state.cloudUser;
  workProjectSelect.disabled = state.busy || state.workProjects.length === 0;
  projectKeyInput.disabled = state.busy || !canEditSite();
  projectNameInput.disabled = state.busy || !canEditSite();
  createProjectButton.disabled = state.busy || !canEditSite();
  issueSummaryInput.disabled = state.busy || !canEditWorkProject();
  issueTypeSelect.disabled = state.busy || !canEditWorkProject();
  issuePrioritySelect.disabled = state.busy || !canEditWorkProject();
  issueAssigneeInput.disabled = state.busy || !canEditWorkProject();
  issueLabelsInput.disabled = state.busy || !canEditWorkProject();
  issueSprintSelect.disabled = state.busy || !canEditWorkProject();
  createIssueButton.disabled = state.busy || !canEditWorkProject();
  sprintNameInput.disabled = state.busy || !canEditWorkProject();
  createSprintButton.disabled = state.busy || !canEditWorkProject();
  manageSprintSelect.disabled = state.busy || state.workSprints.length === 0;
  startSprintButton.disabled = state.busy || !canEditWorkProject() || selectedWorkSprint()?.status !== "planned";
  completeSprintButton.disabled = state.busy || !canEditWorkProject() || selectedWorkSprint()?.status !== "active";
  issueFilterSelect.disabled = state.busy || !selectedWorkProject();
  issueSearchInput.disabled = state.busy || !selectedWorkProject();
  issueCommentInput.disabled = state.busy || !state.selectedIssue || !state.cloudUser;
  addIssueCommentButton.disabled = state.busy || !state.selectedIssue || !state.cloudUser;
  issueLinkTargetInput.disabled = state.busy || !state.selectedIssue || !canEditWorkProject();
  issueLinkTypeSelect.disabled = state.busy || !state.selectedIssue || !canEditWorkProject();
  addIssueLinkButton.disabled = state.busy || !state.selectedIssue || !canEditWorkProject();
  if (!state.currentPage) {
    historyList.append(emptyState("Select a page"));
    return;
  }
  if (state.documentRevisions.length === 0) {
    historyList.append(emptyState("No saved versions"));
    return;
  }
  for (const [index, revision] of state.documentRevisions.entries()) {
    const row = document.createElement("div");
    row.className = "history-row";
    const copy = document.createElement("div");
    copy.className = "history-copy";
    const title = document.createElement("strong");
    const isCurrent = index === 0 && revision.hash === state.currentPage.hash;
    title.textContent = `Version ${revision.revision}${isCurrent ? " · current" : ""}`;
    const meta = document.createElement("span");
    meta.className = "history-meta";
    meta.textContent = `${formatDate(revision.createdAt)} · ${shortId(revision.createdBy)} · ${revision.hash.slice(0, 8)}`;
    copy.append(title, meta);
    const restore = document.createElement("button");
    restore.type = "button";
    restore.textContent = "Restore";
    restore.disabled = state.busy || isCurrent || !canEditPage();
    restore.addEventListener("click", () => {
      void restoreRevision(revision);
    });
    const diff = document.createElement("button");
    diff.type = "button";
    diff.textContent = "Diff";
    diff.disabled = state.busy;
    diff.setAttribute("aria-label", `Compare version ${revision.revision} with the previous version`);
    diff.addEventListener("click", () => {
      void showRevisionDiff(revision);
    });
    const actions = document.createElement("div");
    actions.className = "history-actions";
    actions.append(restore, diff);
    row.append(copy, actions);
    historyList.append(row);
  }
}

async function restoreRevision(revision: CloudDocumentRevisionSummary): Promise<void> {
  if (!state.currentPage || !canEditPage()) return;
  if (state.dirty && !window.confirm("Discard the unsaved draft and restore this saved version?")) return;
  if (!window.confirm(`Restore version ${revision.revision} as a new current version?`)) return;
  setBusy(true, `Restoring version ${revision.revision}`, "warning");
  try {
    const restored = await fetchCloudJson<CloudDocumentResponse>(`${currentPageEndpoint()}/revisions/${revision.revision}/restore`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ expectedHash: state.currentPage.hash }),
    });
    replacePage(restored);
    setCurrentPage(restored);
    setCloudStatus(`Restored version ${revision.revision}`, "ok");
    await refreshHistory({ silent: true });
  } catch (error) {
    setPanelStatus(historyStatus, errorMessage(error), "error");
    setCloudStatus(errorMessage(error), "error");
  } finally {
    setBusy(false);
    renderChrome();
  }
}
