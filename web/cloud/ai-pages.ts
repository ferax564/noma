/**
 * AI-drafted pages: "Draft with AI" in the space rail posts to `/api/sites/:id/ai/draft-page`, and the
 * resulting page proposal is listed under Agent Review → AI page proposals, where a different
 * collaborator approves it before anyone can create the page. Model text is only rendered with `textContent`.
 */
import { CloudRequestError, fetchCloudJson } from "./api.js";
import { collaborationActions, collaborationRow } from "./collaboration.js";
import { renderChrome } from "./layout.js";
import { loadSite } from "./navigation.js";
import { canCreatePage, canEditSite } from "./permissions.js";
import { shareToken, state } from "./state.js";
import { actionButton, emptyState, errorMessage, formatDate, setPanelStatus } from "./util.js";

interface AiPageProposal {
  id: string;
  siteId: string;
  parentId?: string;
  title: string;
  source: string;
  instruction: string;
  proposedBy: string;
  model: string;
  citations: Array<{ documentId: string; blockId: string }>;
  diagnostics: Array<{ severity: string; message: string }>;
  status: "pending" | "approved" | "rejected" | "applied";
  documentId?: string;
  createdAt: string;
}

const draftButton = requireElement<HTMLButtonElement>("aiDraftPageButton");
const dialog = requireElement<HTMLDialogElement>("aiDraftPageDialog");
const form = requireElement<HTMLFormElement>("aiDraftPageForm");
const titleInput = requireElement<HTMLInputElement>("aiDraftPageTitleInput");
const instructionInput = requireElement<HTMLTextAreaElement>("aiDraftPageInstruction");
const underCurrentInput = requireElement<HTMLInputElement>("aiDraftPageUnderCurrent");
const dialogStatus = requireElement<HTMLElement>("aiDraftPageStatus");
const result = requireElement<HTMLElement>("aiDraftPageResult");
const submitButton = requireElement<HTMLButtonElement>("aiDraftPageSubmit");
const cancelButton = requireElement<HTMLButtonElement>("aiDraftPageCancel");
const proposalList = requireElement<HTMLElement>("aiPageProposalList");
const proposalStatus = requireElement<HTMLElement>("aiPageProposalStatus");
const refreshButton = requireElement<HTMLButtonElement>("refreshAiPageProposalsButton");

const pagesState: { key?: string; proposals: AiPageProposal[]; drafting: boolean; aiUnavailable?: string } = { proposals: [], drafting: false };

export function installAiPageDrafts(): void {
  draftButton.addEventListener("click", () => void openDraftDialog());
  cancelButton.addEventListener("click", () => dialog.close());
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    void draftPage();
  });
  refreshButton.addEventListener("click", () => {
    const siteId = state.currentSite?.id;
    if (siteId) void loadProposals(siteId, pagesState.key);
  });
}

/** Called from `renderChrome`: keeps the draft button and the proposal list in step with the space and user. */
export function renderAiPagesChrome(): void {
  draftButton.disabled = state.busy || !canCreatePage() || Boolean(shareToken);
  refreshButton.disabled = state.busy || !state.cloudUser || !state.currentSite;
  submitButton.disabled = pagesState.drafting || Boolean(pagesState.aiUnavailable);
  const key = state.cloudAvailable && state.cloudUser && state.currentSite && !shareToken ? `${state.cloudUser.id}:${state.currentSite.id}` : undefined;
  if (key === pagesState.key) return;
  pagesState.key = key;
  pagesState.proposals = [];
  renderProposals();
  const siteId = state.currentSite?.id;
  if (key && siteId) void loadProposals(siteId, key);
}

async function openDraftDialog(): Promise<void> {
  if (!state.currentSite || !canCreatePage()) return;
  titleInput.value = "";
  instructionInput.value = "";
  result.textContent = "";
  const currentInSite = Boolean(state.currentPage && state.currentSite.documentIds.includes(state.currentPage.id));
  underCurrentInput.checked = false;
  underCurrentInput.disabled = !currentInSite;
  underCurrentInput.parentElement?.setAttribute("title", currentInSite ? `Nest the new page under “${state.currentPage?.title ?? ""}”` : "Open a page in this space to nest the draft under it");
  pagesState.aiUnavailable = undefined;
  setPanelStatus(dialogStatus, "", "ok");
  renderAiPagesChrome();
  dialog.showModal();
  titleInput.focus();
  try {
    const status = await fetchCloudJson<{ available: boolean; reason?: string; message?: string }>("/api/ai/status");
    if (!status.available) showUnavailable(status.reason, status.message);
  } catch {
    // The draft request reports availability itself; the status probe is only a courtesy.
  }
}

function showUnavailable(reason: string | undefined, message: string | undefined): void {
  pagesState.aiUnavailable = reason ?? "unavailable";
  setPanelStatus(dialogStatus, `AI drafting is unavailable (${pagesState.aiUnavailable.replaceAll("_", " ")})${message ? `: ${message}` : ""}. You can still create pages by hand.`, "warning");
  renderAiPagesChrome();
}

async function draftPage(): Promise<void> {
  const site = state.currentSite;
  if (!site) return;
  const title = titleInput.value.trim();
  const instruction = instructionInput.value.trim();
  if (!title || !instruction) {
    setPanelStatus(dialogStatus, "Enter a title and describe the page", "error");
    return;
  }
  const parentId = underCurrentInput.checked && state.currentPage ? state.currentPage.id : undefined;
  pagesState.drafting = true;
  result.textContent = "";
  setPanelStatus(dialogStatus, "Drafting the page from pages you can read", "warning");
  renderAiPagesChrome();
  try {
    const response = await fetchCloudJson<{ proposal: AiPageProposal; model: string; costUsd: number }>(`/api/sites/${encodeURIComponent(site.id)}/ai/draft-page`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title, instruction, ...(parentId ? { parentId } : {}) }),
    });
    renderDraftResult(response.proposal);
    setPanelStatus(dialogStatus, `Page proposal drafted by ${response.model} · $${response.costUsd.toFixed(4)} · awaiting independent review`, "ok");
    if (pagesState.key === `${state.cloudUser?.id}:${site.id}`) {
      pagesState.proposals = [response.proposal, ...pagesState.proposals.filter((proposal) => proposal.id !== response.proposal.id)];
      renderProposals();
    }
  } catch (error) {
    if (error instanceof CloudRequestError && error.payload.code === "ai_unavailable") showUnavailable(error.payload.reason, error.message);
    else setPanelStatus(dialogStatus, errorMessage(error), "error");
  } finally {
    pagesState.drafting = false;
    renderAiPagesChrome();
  }
}

function renderDraftResult(proposal: AiPageProposal): void {
  result.textContent = "";
  const summary = document.createElement("p");
  summary.className = "security-help";
  const warnings = proposal.diagnostics.filter((item) => item.severity !== "info").length;
  summary.textContent = `“${proposal.title}” is a pending page proposal with ${proposal.citations.length} cited block${proposal.citations.length === 1 ? "" : "s"}${warnings ? ` and ${warnings} validation warning${warnings === 1 ? "" : "s"}` : ""}. Another collaborator must approve it in Agent Review before the page is created.`;
  const source = document.createElement("pre");
  source.textContent = proposal.source;
  const actions = collaborationActions();
  actions.append(actionButton("Show in Agent Review", () => revealProposals()));
  result.append(summary, source, actions);
}

function revealProposals(): void {
  dialog.close();
  if (!state.panelsOpen) {
    state.panelsOpen = true;
    renderChrome();
  }
  proposalList.scrollIntoView({ block: "center" });
}

async function loadProposals(siteId: string, key: string | undefined): Promise<void> {
  try {
    const response = await fetchCloudJson<{ proposals: AiPageProposal[] }>(`/api/sites/${encodeURIComponent(siteId)}/ai/page-proposals`);
    if (pagesState.key !== key) return;
    pagesState.proposals = response.proposals;
    setPanelStatus(proposalStatus, "", "ok");
  } catch (error) {
    if (pagesState.key === key) setPanelStatus(proposalStatus, errorMessage(error), "error");
  }
  renderProposals();
}

function renderProposals(): void {
  proposalList.textContent = "";
  if (!pagesState.key) {
    proposalList.append(emptyState("Open a space"));
    return;
  }
  const visible = pagesState.proposals.filter((proposal) => proposal.status !== "rejected").slice(0, 20);
  if (visible.length === 0) {
    proposalList.append(emptyState("No AI page proposals"));
    return;
  }
  const me = state.cloudUser?.id;
  const editable = canEditSite();
  for (const proposal of visible) {
    const row = collaborationRow(
      `${proposal.status} · ${proposal.title}`,
      proposal.instruction,
      `${proposal.proposedBy === me ? "drafted by you" : "drafted by a collaborator"} · ${proposal.model} · ${proposal.citations.length} citation${proposal.citations.length === 1 ? "" : "s"} · ${formatDate(proposal.createdAt)}`,
    );
    row.dataset.proposalId = proposal.id;
    row.dataset.state = proposal.status === "applied" ? "ok" : "warning";
    const preview = document.createElement("details");
    const summary = document.createElement("summary");
    summary.textContent = "Proposed source";
    const source = document.createElement("pre");
    source.textContent = proposal.source;
    preview.append(summary, source);
    row.querySelector(".collaboration-copy")?.append(preview);
    const actions = collaborationActions();
    if (proposal.status === "pending" && editable) {
      if (proposal.proposedBy !== me) {
        actions.append(
          actionButton("Approve", () => void reviewProposal(proposal, "approved"), false, `Approve page proposal ${proposal.title}`),
          actionButton("Reject", () => void reviewProposal(proposal, "rejected"), false, `Reject page proposal ${proposal.title}`),
        );
      } else {
        actions.append(actionButton("Withdraw", () => void reviewProposal(proposal, "rejected"), false, `Withdraw page proposal ${proposal.title}`));
      }
    }
    if (proposal.status === "approved" && editable) {
      actions.append(actionButton("Create page", () => void applyProposal(proposal), false, `Create page from proposal ${proposal.title}`));
    }
    if (proposal.status === "applied" && proposal.documentId) {
      const documentId = proposal.documentId;
      actions.append(actionButton("Open page", () => void loadSite(proposal.siteId, documentId), false, `Open page ${proposal.title}`));
    }
    row.append(actions);
    proposalList.append(row);
  }
}

function proposalEndpoint(proposal: AiPageProposal, action: string): string {
  return `/api/sites/${encodeURIComponent(proposal.siteId)}/ai/page-proposals/${encodeURIComponent(proposal.id)}/${action}`;
}

function replaceProposal(updated: AiPageProposal): void {
  pagesState.proposals = pagesState.proposals.map((proposal) => (proposal.id === updated.id ? updated : proposal));
  renderProposals();
}

async function reviewProposal(proposal: AiPageProposal, decision: "approved" | "rejected"): Promise<void> {
  try {
    const updated = await fetchCloudJson<AiPageProposal>(proposalEndpoint(proposal, "review"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision }),
    });
    replaceProposal(updated);
    setPanelStatus(proposalStatus, decision === "approved" ? `Approved “${proposal.title}”; it can now be created` : `Rejected “${proposal.title}”`, "ok");
  } catch (error) {
    setPanelStatus(proposalStatus, errorMessage(error), "error");
  }
}

async function applyProposal(proposal: AiPageProposal): Promise<void> {
  try {
    const response = await fetchCloudJson<{ proposal: AiPageProposal; document: { id: string } }>(proposalEndpoint(proposal, "apply"), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    replaceProposal(response.proposal);
    setPanelStatus(proposalStatus, `Created “${proposal.title}”`, "ok");
    await loadSite(proposal.siteId, response.document.id);
  } catch (error) {
    setPanelStatus(proposalStatus, errorMessage(error), "error");
  }
}

function requireElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing #${id}`);
  return element as T;
}
