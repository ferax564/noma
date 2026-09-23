/** Search, Ask Noma, knowledge health, agent inbox/directory and agent patch proposals. */
import { type PatchOp, patchSource } from "../../src/patch.js";
import { parse } from "../../src/parser.js";
import { validate } from "../../src/validator.js";
import { fetchCloudJson } from "./api.js";
import { collaborationActions, collaborationRow, refreshActivity } from "./collaboration.js";
import { agentChangeInboxList, agentDirectoryList, agentStatus, askNomaButton, askNomaInput, askNomaResult, askNomaStatus, globalSearchInput, knowledgeHealthList, offlineStatus, patchInput, patchProposalList, refreshKnowledgeButton, searchButton, searchResults, searchScopeSelect, sourceInput } from "./dom.js";
import { renderDraftRecovery } from "./drafts.js";
import { currentPageEndpoint, focusBlock, focusSourceLine, markDirty, renderCurrent, setCurrentPage, syncTitleFromSource } from "./editor.js";
import { loadSite, loadStandaloneDocument, replacePage } from "./navigation.js";
import { canEditPage } from "./permissions.js";
import { state } from "./state.js";
import type { AgentInboxItem, AskNomaResponse, CloudDocumentResponse, CloudPatchProposal, CloudSearchResult, KnowledgeCitation, KnowledgeHealthItem, PanelState, ScopedAgentSummary } from "./types.js";
import { actionButton, copyText, emptyState, errorMessage, formatDate, setCloudStatus, setPanelStatus, shortId } from "./util.js";
import { selectWorkIssue } from "./work.js";

export async function searchCloud(): Promise<void> {
  const q = globalSearchInput.value.trim();
  if (!q || !state.cloudUser) {
    state.cloudSearchResults = [];
    renderSearchResults();
    return;
  }
  searchButton.disabled = true;
  try {
    const params = new URLSearchParams({ q });
    if (searchScopeSelect.value === "site" && state.currentSite) params.set("site", state.currentSite.id);
    const response = await fetchCloudJson<{ results: CloudSearchResult[] }>(`/api/knowledge/search?${params.toString()}`);
    state.cloudSearchResults = response.results;
    setCloudStatus(`${state.cloudSearchResults.length} search result${state.cloudSearchResults.length === 1 ? "" : "s"}`, "ok");
  } catch (error) {
    state.cloudSearchResults = [];
    setCloudStatus(errorMessage(error), "error");
  } finally {
    searchButton.disabled = state.busy || !state.cloudUser;
    renderSearchResults();
  }
}

export function renderSearchResults(): void {
  searchResults.textContent = "";
  if (!globalSearchInput.value.trim()) return;
  if (state.cloudSearchResults.length === 0) {
    searchResults.append(emptyState("No matches"));
    return;
  }
  for (const result of state.cloudSearchResults.slice(0, 20)) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "search-result";
    const title = document.createElement("span");
    title.className = "row-title";
    title.textContent = result.title || result.documentTitle;
    const meta = document.createElement("span");
    meta.className = "row-meta";
    const excerpt = result.excerpt ?? result.exactSource?.replace(/\s+/g, " ").slice(0, 180) ?? "";
    const score = result.score === undefined ? "" : ` · ${Math.round(result.score * 100)}%`;
    const freshness = result.freshness ? ` · ${result.freshness.state.replace("_", " ")}` : "";
    const line = result.line ?? result.sourceSpan?.line;
    meta.textContent = `${result.documentTitle}${line ? ` · line ${line}` : ""}${score}${freshness} · ${excerpt}`;
    button.append(title, meta);
    button.addEventListener("click", () => void openSearchResult(result));
    searchResults.append(button);
  }
}

export async function askNoma(): Promise<void> {
  const query = askNomaInput.value.trim();
  if (!query || !state.cloudUser || !state.cloudAvailable) return;
  askNomaButton.disabled = true;
  setPanelStatus(askNomaStatus, "Retrieving exact, permission-scoped evidence", "warning");
  try {
    state.askNomaResponse = await fetchCloudJson<AskNomaResponse>("/api/ask", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ query, ...(state.currentSite ? { siteId: state.currentSite.id } : {}) }),
    });
    setPanelStatus(
      askNomaStatus,
      state.askNomaResponse.state === "answered"
        ? `${state.askNomaResponse.confidence.label} confidence · ${state.askNomaResponse.citations.length} exact citation${state.askNomaResponse.citations.length === 1 ? "" : "s"}`
        : "Insufficient evidence — Noma abstained",
      state.askNomaResponse.state === "answered" ? "ok" : "warning",
    );
  } catch (error) {
    state.askNomaResponse = undefined;
    setPanelStatus(askNomaStatus, errorMessage(error), "error");
  } finally {
    askNomaButton.disabled = false;
    renderKnowledgeWorkspace();
  }
}

export async function refreshKnowledgeWorkspace(): Promise<void> {
  if (!state.cloudAvailable || !state.cloudUser) {
    state.knowledgeHealth = [];
    state.agentInbox = [];
    state.scopedAgents = [];
    renderKnowledgeWorkspace();
    return;
  }
  const siteQuery = state.currentSite ? `?site=${encodeURIComponent(state.currentSite.id)}` : "";
  try {
    const [health, inbox, agents] = await Promise.all([
      fetchCloudJson<{ items: KnowledgeHealthItem[] }>(`/api/knowledge/health${siteQuery}`),
      fetchCloudJson<{ changes: AgentInboxItem[] }>(`/api/agent-inbox${siteQuery}`),
      fetchCloudJson<{ agents: ScopedAgentSummary[] }>("/api/agents"),
    ]);
    state.knowledgeHealth = health.items;
    state.agentInbox = inbox.changes;
    state.scopedAgents = agents.agents;
  } catch (error) {
    setPanelStatus(askNomaStatus, errorMessage(error), "error");
  } finally {
    renderKnowledgeWorkspace();
  }
}

export function renderKnowledgeWorkspace(): void {
  offlineStatus.textContent = navigator.onLine && state.cloudAvailable ? "online" : "offline";
  offlineStatus.dataset.state = navigator.onLine && state.cloudAvailable ? "ok" : "warning";
  askNomaButton.disabled = state.busy || !state.cloudUser || !state.cloudAvailable || !askNomaInput.value.trim();
  refreshKnowledgeButton.disabled = state.busy || !state.cloudUser || !state.cloudAvailable;
  renderAskNomaAnswer();
  renderKnowledgeHealth();
  renderAgentInbox();
  renderAgentDirectory();
  renderDraftRecovery();
}

function renderAskNomaAnswer(): void {
  askNomaResult.textContent = "";
  if (!state.askNomaResponse) {
    askNomaResult.append(emptyState("Ask a question to retrieve exact block and version citations"));
    return;
  }
  const answer = document.createElement("div");
  answer.className = "knowledge-answer-text";
  answer.textContent = state.askNomaResponse.answer;
  askNomaResult.append(answer);
  for (const citation of state.askNomaResponse.citations) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "knowledge-citation";
    const title = document.createElement("span");
    title.className = "row-title";
    title.textContent = `[${citation.citation}] ${citation.documentTitle} · #${citation.blockId}`;
    const meta = document.createElement("span");
    meta.className = "row-meta";
    meta.textContent = `lines ${citation.sourceSpan.line}-${citation.sourceSpan.endLine} · ${citation.freshness.state.replace("_", " ")} · ${Math.round(citation.score * 100)}% · ${citation.versionHash.slice(0, 10)}`;
    button.append(title, meta);
    button.addEventListener("click", () => void openKnowledgeCitation(citation));
    askNomaResult.append(button);
  }
  for (const conflict of state.askNomaResponse.conflicts) {
    const row = knowledgePanelRow(`Conflict: ${conflict.concept}`, conflict.reason, "error");
    askNomaResult.append(row);
  }
}

async function openKnowledgeCitation(citation: KnowledgeCitation): Promise<void> {
  const sitePage = state.currentSite?.documentIds.includes(citation.documentId);
  if (sitePage && state.currentSite) await loadSite(state.currentSite.id, citation.documentId);
  else await loadStandaloneDocument(citation.documentId);
  focusSourceLine(citation.sourceSpan.line);
  try {
    await fetchCloudJson("/api/analytics", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ type: "citation_opened", documentId: citation.documentId, query: askNomaInput.value.trim() }),
    });
  } catch {
    return;
  }
}

function renderKnowledgeHealth(): void {
  knowledgeHealthList.textContent = "";
  if (state.knowledgeHealth.length === 0) {
    knowledgeHealthList.append(emptyState("No active health issues"));
    return;
  }
  for (const item of state.knowledgeHealth.slice(0, 12)) {
    const row = knowledgePanelRow(item.kind.replaceAll("_", " "), item.message, item.severity);
    if (item.documentId) row.addEventListener("click", () => void openHealthItem(item));
    knowledgeHealthList.append(row);
  }
}

async function openHealthItem(item: KnowledgeHealthItem): Promise<void> {
  if (!item.documentId) return;
  if (state.currentSite?.documentIds.includes(item.documentId)) await loadSite(state.currentSite.id, item.documentId);
  else await loadStandaloneDocument(item.documentId);
  if (item.blockId) focusBlock(item.blockId);
}

function renderAgentInbox(): void {
  agentChangeInboxList.textContent = "";
  if (state.agentInbox.length === 0) {
    agentChangeInboxList.append(emptyState("No agent changes awaiting review"));
    return;
  }
  for (const item of state.agentInbox.slice(0, 12)) {
    const row = knowledgePanelRow(item.applyStatus.replaceAll("_", " "), item.plan[0] ?? "Agent change", item.applyStatus === "rejected" ? "error" : item.applyStatus === "applied" ? "ok" : "warning");
    row.addEventListener("click", () => void openAgentInboxItem(item));
    agentChangeInboxList.append(row);
  }
}

async function openAgentInboxItem(item: AgentInboxItem): Promise<void> {
  if (state.currentSite?.documentIds.includes(item.documentId)) await loadSite(state.currentSite.id, item.documentId);
  else await loadStandaloneDocument(item.documentId);
  if (item.affectedIds[0]) focusBlock(item.affectedIds[0]);
}

function renderAgentDirectory(): void {
  agentDirectoryList.textContent = "";
  if (state.scopedAgents.length === 0) {
    agentDirectoryList.append(emptyState("No scoped agents"));
    return;
  }
  for (const agent of state.scopedAgents.slice(0, 10)) {
    const retention = agent.modelPolicy.zeroRetention ? "zero retention" : "provider retention";
    agentDirectoryList.append(knowledgePanelRow(`${agent.name} · ${agent.status}`, `${agent.modelPolicy.model} · ${retention} · $${agent.spentUsd.toFixed(2)} / $${agent.budgetUsd.toFixed(2)} · ${agent.capabilities.length} capabilities`, agent.status === "active" ? "ok" : "warning"));
  }
}

function knowledgePanelRow(titleText: string, metaText: string, panelState: PanelState | "info"): HTMLElement {
  const row = document.createElement("button");
  row.type = "button";
  row.className = "collaboration-row";
  row.dataset.state = panelState;
  const title = document.createElement("span");
  title.className = "row-title";
  title.textContent = titleText;
  const meta = document.createElement("span");
  meta.className = "row-meta";
  meta.textContent = metaText;
  row.append(title, meta);
  return row;
}

async function openSearchResult(result: CloudSearchResult): Promise<void> {
  if (result.siteId) await loadSite(result.siteId, result.documentId);
  else await loadStandaloneDocument(result.documentId);
  const line = result.line ?? result.sourceSpan?.line;
  if (line) focusSourceLine(line);
}

export async function refreshPatchProposals(): Promise<void> {
  if (!state.currentPage) {
    state.patchProposals = [];
    renderPatchProposals();
    return;
  }
  const pageId = state.currentPage.id;
  try {
    const response = await fetchCloudJson<{ proposals: CloudPatchProposal[] }>(`${currentPageEndpoint()}/patch-proposals`);
    if (state.currentPage?.id === pageId) state.patchProposals = response.proposals;
  } catch (error) {
    setPanelStatus(agentStatus, errorMessage(error), "error");
  } finally {
    renderPatchProposals();
  }
}

export async function proposeAgentPatch(): Promise<void> {
  if (!state.currentPage || !canEditPage()) return;
  if (state.dirty) {
    setPanelStatus(agentStatus, "Save the current draft before creating a version-bound patch proposal", "error");
    return;
  }
  try {
    const ops = parsePatchOps(patchInput.value);
    const proposal = await fetchCloudJson<CloudPatchProposal>(`${currentPageEndpoint()}/patch-proposals`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        ops,
        issueId: state.selectedIssue?.id,
        summary: state.selectedIssue ? `Agent patch for ${state.selectedIssue.key}` : "Agent patch proposal",
      }),
    });
    await Promise.all([refreshPatchProposals(), refreshActivity()]);
    if (state.selectedIssue) await selectWorkIssue(state.selectedIssue.id);
    setPanelStatus(
      agentStatus,
      `Proof ${proposal.proof.status ?? "created"}; proposal awaits review${state.selectedIssue ? ` on ${state.selectedIssue.key}` : ""}`,
      "ok",
    );
  } catch (error) {
    setPanelStatus(agentStatus, errorMessage(error), "error");
  }
}

async function reviewPatchProposal(proposal: CloudPatchProposal, decision: "approved" | "rejected"): Promise<void> {
  try {
    await fetchCloudJson(`${currentPageEndpoint()}/patch-proposals/${encodeURIComponent(proposal.id)}/review`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ decision }),
    });
    await Promise.all([refreshPatchProposals(), refreshActivity()]);
    if (proposal.issueId && state.selectedIssue?.id === proposal.issueId) await selectWorkIssue(proposal.issueId);
  } catch (error) {
    setPanelStatus(agentStatus, errorMessage(error), "error");
  }
}

async function applyPatchProposal(proposal: CloudPatchProposal): Promise<void> {
  if (state.dirty && !window.confirm("Discard the unsaved draft and apply this reviewed patch to the saved page?")) return;
  try {
    const response = await fetchCloudJson<{ proposal: CloudPatchProposal; document: CloudDocumentResponse }>(
      `${currentPageEndpoint()}/patch-proposals/${encodeURIComponent(proposal.id)}/apply`,
      { method: "POST" },
    );
    replacePage(response.document);
    setCurrentPage(response.document);
    setPanelStatus(agentStatus, `Applied reviewed patch · ${response.document.hash.slice(0, 8)}`, "ok");
    if (proposal.issueId && state.selectedIssue?.id === proposal.issueId) await selectWorkIssue(proposal.issueId);
  } catch (error) {
    setPanelStatus(agentStatus, errorMessage(error), "error");
  }
}

export function renderPatchProposals(): void {
  patchProposalList.textContent = "";
  if (!state.currentPage) {
    patchProposalList.append(emptyState("Select a page"));
    return;
  }
  if (state.patchProposals.length === 0) {
    patchProposalList.append(emptyState("No patch proposals"));
    return;
  }
  for (const proposal of state.patchProposals.slice(0, 20)) {
    const linkedIssue = proposal.issueId ? state.workIssues.find((issue) => issue.id === proposal.issueId)?.key ?? shortId(proposal.issueId) : undefined;
    const stale = proposal.documentHash !== state.currentPage.hash && proposal.status !== "applied";
    const preserved = proposal.proof.sourceMetrics?.preservedPercent;
    const row = collaborationRow(
      `${proposal.status} · ${proposal.proposedByName}`,
      proposal.summary || proposal.proof.diff?.slice(0, 260) || "Agent patch",
      `${linkedIssue ? `${linkedIssue} · ` : ""}${proposal.proof.status ?? "proof"}${typeof preserved === "number" ? ` · ${preserved.toFixed(1)}% preserved` : ""}${stale ? " · stale" : ""} · ${formatDate(proposal.createdAt)}`,
    );
    const actions = collaborationActions();
    if (proposal.status === "pending" && !stale) {
      if (proposal.proposedBy !== state.cloudUser?.id && canEditPage()) {
        actions.append(
          actionButton("Approve", () => void reviewPatchProposal(proposal, "approved")),
          actionButton("Reject", () => void reviewPatchProposal(proposal, "rejected")),
        );
      } else if (proposal.proposedBy === state.cloudUser?.id) {
        actions.append(actionButton("Withdraw", () => void reviewPatchProposal(proposal, "rejected")));
      }
    }
    if (proposal.status === "approved" && !stale && canEditPage()) {
      actions.append(actionButton("Apply", () => void applyPatchProposal(proposal)));
    }
    row.append(actions);
    patchProposalList.append(row);
  }
}

export async function applyAgentPatch(): Promise<void> {
  try {
    const ops = parsePatchOps(patchInput.value);
    const nextSource = patchSource(sourceInput.value, ops);
    const nextDoc = parse(nextSource, { filename: `${state.currentPage?.id ?? "draft"}.noma` });
    const nextDiagnostics = validate(nextDoc);
    const errors = nextDiagnostics.filter((item) => item.severity === "error");
    if (errors.length > 0) {
      throw new Error(`Patch produced ${errors.length} validation error${errors.length === 1 ? "" : "s"}`);
    }
    sourceInput.value = nextSource;
    markDirty();
    syncTitleFromSource();
    renderCurrent();
    setPanelStatus(agentStatus, `Applied ${ops.length} patch op${ops.length === 1 ? "" : "s"}`, "ok");
    setCloudStatus("Applied patch", "ok");
  } catch (error) {
    setPanelStatus(agentStatus, errorMessage(error), "error");
  }
}

export async function copyLlmContext(): Promise<void> {
  if (state.renderState.error || !state.renderState.llm) {
    setPanelStatus(agentStatus, "Render the page before copying LLM context", "error");
    return;
  }
  await copyText(state.renderState.llm, "Copied LLM context");
  setPanelStatus(agentStatus, "Copied LLM context", "ok");
}

function parsePatchOps(text: string): PatchOp[] {
  const parsed = JSON.parse(text) as unknown;
  const list = Array.isArray(parsed) ? parsed : [parsed];
  for (const item of list) {
    if (!item || typeof item !== "object" || typeof (item as { op?: unknown }).op !== "string") {
      throw new Error("Patch operations must be objects with an op field");
    }
  }
  return list as PatchOp[];
}
