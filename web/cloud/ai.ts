/**
 * Generative AI in the Cloud app: the "Generate answer" Ask toggle with clickable citations, the
 * page-header AI menu (summarize, draft changes, refresh from sources) whose results open in the patch
 * review panel, and per-space maintenance settings. Model text is only ever rendered with `textContent`.
 */
import { fetchCloudJson } from "./api.js";
import { collaborationActions, collaborationRow } from "./collaboration.js";
import { patchProposalList } from "./dom.js";
import { refreshPatchProposals } from "./knowledge.js";
import { renderChrome } from "./layout.js";
import { canEditPage, canEditSite } from "./permissions.js";
import { state } from "./state.js";
import type { CloudPatchProposal } from "./types.js";
import { actionButton, emptyState, errorMessage, formatDate, setPanelStatus } from "./util.js";

interface AiStatusResponse {
  available: boolean;
  reason?: string;
  message?: string;
  model?: string;
  budget: { userLimitUsd: number; userSpentUsd: number };
}

interface MaintenanceSettingsResponse {
  settings: { enabled: boolean; aiRefresh: boolean; intervalHours: number; maxProposalsPerRun: number; configured: boolean; lastRunAt?: string };
  ai: AiStatusResponse;
  openItems: number;
  runs: Array<{ trigger: string; status: string; startedAt: string; itemsOpen: number; itemsResolved: number; proposalsCreated: number }>;
}

interface MaintenanceItem {
  id: string;
  kind: string;
  severity: "info" | "warning" | "error";
  documentId?: string;
  blockId?: string;
  message: string;
  proposalId?: string;
}

const aiMenu = requireElement<HTMLDetailsElement>("aiMenu");
const aiMenuButton = requireElement<HTMLElement>("aiMenuButton");
const aiMenuItems = requireElement<HTMLElement>("aiMenuItems");
const aiMenuStatus = requireElement<HTMLElement>("aiMenuStatus");
const aiSummarizeButton = requireElement<HTMLButtonElement>("aiSummarizeButton");
const aiDraftButton = requireElement<HTMLButtonElement>("aiDraftButton");
const aiRefreshButton = requireElement<HTMLButtonElement>("aiRefreshButton");
const aiGenerateToggle = requireElement<HTMLInputElement>("aiGenerateToggle");
const aiAssistantSection = requireElement<HTMLElement>("aiAssistantSection");
const aiAssistantStatus = requireElement<HTMLElement>("aiAssistantStatus");
const aiAssistantOutput = requireElement<HTMLElement>("aiAssistantOutput");
const maintenanceSection = requireElement<HTMLElement>("aiMaintenanceSection");
const maintenanceDetails = requireElement<HTMLDetailsElement>("aiMaintenanceDetails");
const maintenanceEnabled = requireElement<HTMLInputElement>("aiMaintenanceEnabled");
const maintenanceRefresh = requireElement<HTMLInputElement>("aiMaintenanceRefresh");
const maintenanceInterval = requireElement<HTMLInputElement>("aiMaintenanceInterval");
const maintenanceLimit = requireElement<HTMLInputElement>("aiMaintenanceLimit");
const maintenanceSaveButton = requireElement<HTMLButtonElement>("aiMaintenanceSaveButton");
const maintenanceRunButton = requireElement<HTMLButtonElement>("aiMaintenanceRunButton");
const maintenanceStatus = requireElement<HTMLElement>("aiMaintenanceStatus");
const maintenanceItems = requireElement<HTMLElement>("aiMaintenanceItems");

const aiState: {
  status?: AiStatusResponse;
  statusUserId?: string;
  maintenanceKey?: string;
  maintenanceLoading?: boolean;
  maintenance?: MaintenanceSettingsResponse;
  items: MaintenanceItem[];
  running: boolean;
} = { items: [], running: false };

/** Whether Ask should request a generated answer. */
export function aiAskMode(): "generative" | undefined {
  return aiGenerateToggle.checked ? "generative" : undefined;
}

/**
 * Renders answer text safely: plain text with `[n]` markers turned into buttons that open the cited
 * block. Nothing from the model is ever parsed as HTML.
 */
export function renderAnswerText(container: HTMLElement, text: string, citationNumbers: number[], openCitation: (citation: number) => void): void {
  container.textContent = "";
  container.classList.add("ai-answer-text");
  const known = new Set(citationNumbers);
  let last = 0;
  for (const match of text.matchAll(/\[(\d{1,3})\]/g)) {
    const number = Number(match[1]);
    if (!known.has(number) || match.index === undefined) continue;
    container.append(document.createTextNode(text.slice(last, match.index)));
    const cite = document.createElement("button");
    cite.type = "button";
    cite.className = "ai-cite";
    cite.textContent = String(number);
    cite.setAttribute("aria-label", `Open citation ${number}`);
    cite.addEventListener("click", () => openCitation(number));
    container.append(cite);
    last = match.index + match[0].length;
  }
  container.append(document.createTextNode(text.slice(last)));
}

/** Short note shown under a generated (or fallen-back) answer. */
export function answerNote(response: { mode?: string; ai?: { available: boolean; reason?: string }; generation?: { model?: string; abstainedReason?: string; invalidCitations?: string[] } }): string | undefined {
  if (response.mode === "extractive" && response.ai && !response.ai.available) return `Generated answers are unavailable (${(response.ai.reason ?? "unknown").replaceAll("_", " ")}); showing the extractive answer.`;
  if (response.mode !== "generative" || !response.generation) return undefined;
  if (response.generation.abstainedReason) return `The model abstained: ${response.generation.abstainedReason.replaceAll("_", " ")}.`;
  const dropped = response.generation.invalidCitations?.length ?? 0;
  return `Generated by ${response.generation.model ?? "the model"} from the cited blocks only${dropped ? ` · ${dropped} unverifiable citation${dropped === 1 ? "" : "s"} removed` : ""}.`;
}

export function installCloudAi(): void {
  aiMenu.addEventListener("toggle", () => {
    if (!aiMenu.open) {
      aiMenu.append(aiMenuItems);
      return;
    }
    if (aiMenu.dataset.disabled === "true") {
      aiMenu.open = false;
      return;
    }
    // The header action bar scrolls horizontally, so the open menu is lifted to <body> to avoid clipping.
    const rect = aiMenuButton.getBoundingClientRect();
    document.body.append(aiMenuItems);
    aiMenuItems.style.top = `${Math.round(rect.bottom + 4)}px`;
    aiMenuItems.style.left = `${Math.max(8, Math.min(window.innerWidth - 228, Math.round(rect.right - 220)))}px`;
    void loadAiStatus(true);
  });
  document.addEventListener("click", (event) => {
    if (!aiMenu.open || !(event.target instanceof Node)) return;
    if (!aiMenu.contains(event.target) && !aiMenuItems.contains(event.target)) aiMenu.open = false;
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && aiMenu.open) aiMenu.open = false;
  });
  aiSummarizeButton.addEventListener("click", () => void summarizePage());
  aiDraftButton.addEventListener("click", () => void draftChanges());
  aiRefreshButton.addEventListener("click", () => void refreshFromSources());
  maintenanceDetails.addEventListener("toggle", () => syncMaintenance());
  maintenanceSaveButton.addEventListener("click", () => void saveMaintenance());
  maintenanceRunButton.addEventListener("click", () => void runMaintenance());
}

/** Called from `renderChrome`: keeps AI controls in step with the selected page, space, and user. */
export function renderAiChrome(): void {
  const signedIn = Boolean(state.cloudAvailable && state.cloudUser);
  const hasPage = Boolean(signedIn && state.currentPage);
  const unavailable = aiState.status && !aiState.status.available;
  aiMenu.dataset.disabled = String(!hasPage);
  if (!hasPage && aiMenu.open) aiMenu.open = false;
  aiSummarizeButton.disabled = !hasPage || aiState.running || Boolean(unavailable);
  aiDraftButton.disabled = !hasPage || aiState.running || Boolean(unavailable) || !canEditPage();
  aiRefreshButton.disabled = aiDraftButton.disabled;
  aiMenuStatus.textContent = unavailable ? `AI unavailable: ${(aiState.status?.reason ?? "").replaceAll("_", " ")}` : "";
  aiGenerateToggle.disabled = !signedIn;
  if (aiState.statusUserId && aiState.statusUserId !== state.cloudUser?.id) {
    aiState.status = undefined;
    aiState.statusUserId = undefined;
  }
  maintenanceSection.hidden = !state.currentSite || !signedIn;
  const editable = canEditSite();
  for (const control of [maintenanceEnabled, maintenanceRefresh, maintenanceInterval, maintenanceLimit, maintenanceSaveButton, maintenanceRunButton]) control.disabled = !editable || aiState.running;
  syncMaintenance();
}

/** Loads maintenance settings lazily: only while the section is expanded, once per user and space. */
function syncMaintenance(): void {
  const key = state.cloudAvailable && state.cloudUser && state.currentSite ? `${state.cloudUser.id}:${state.currentSite.id}` : undefined;
  if (key === aiState.maintenanceKey && (aiState.maintenance || !maintenanceDetails.open)) return;
  if (key !== aiState.maintenanceKey) {
    aiState.maintenanceKey = key;
    aiState.maintenance = undefined;
    aiState.items = [];
    renderMaintenance();
  }
  const siteId = state.currentSite?.id;
  if (key && siteId && maintenanceDetails.open && !aiState.maintenanceLoading) void loadMaintenance(siteId, key);
}

async function loadAiStatus(force: boolean): Promise<void> {
  const userId = state.cloudUser?.id;
  if (!userId || (!force && aiState.statusUserId === userId)) return;
  aiState.statusUserId = userId;
  try {
    aiState.status = await fetchCloudJson<AiStatusResponse>("/api/ai/status");
  } catch {
    aiState.status = undefined;
  }
  renderAiChrome();
}

async function runAiAction(label: string, action: () => Promise<void>): Promise<void> {
  aiMenu.open = false;
  aiState.running = true;
  aiAssistantOutput.textContent = "";
  setPanelStatus(aiAssistantStatus, label, "warning");
  aiAssistantSection.scrollIntoView({ block: "nearest" });
  renderAiChrome();
  try {
    await action();
  } catch (error) {
    setPanelStatus(aiAssistantStatus, errorMessage(error), "error");
  } finally {
    aiState.running = false;
    renderAiChrome();
    void loadAiStatus(true);
  }
}

function pageAiEndpoint(action: string): string {
  if (!state.currentPage) throw new Error("No page is selected");
  return `/api/documents/${encodeURIComponent(state.currentPage.id)}/ai/${action}`;
}

async function summarizePage(): Promise<void> {
  await runAiAction("Summarizing this page", async () => {
    const response = await postJson<{ summary: string; model: string; costUsd: number }>(pageAiEndpoint("summarize"), {});
    const text = document.createElement("div");
    text.className = "knowledge-answer-text ai-answer-text";
    text.textContent = response.summary;
    aiAssistantOutput.append(text);
    if (canEditPage()) {
      const actions = collaborationActions();
      actions.append(actionButton("Insert as summary block", () => void insertSummary()));
      aiAssistantOutput.append(actions);
    }
    setPanelStatus(aiAssistantStatus, `Summary by ${response.model} · $${response.costUsd.toFixed(4)}`, "ok");
  });
}

async function insertSummary(): Promise<void> {
  await runAiAction("Drafting a summary block proposal", async () => {
    const response = await postJson<{ proposal: CloudPatchProposal }>(pageAiEndpoint("summarize"), { insert: true });
    await openProposal(response.proposal, "Summary block proposed");
  });
}

async function draftChanges(): Promise<void> {
  if (state.dirty) {
    setPanelStatus(aiAssistantStatus, "Save the page before drafting AI changes against it", "error");
    return;
  }
  const instruction = window.prompt("Describe the change you want the AI to draft", "")?.trim();
  if (!instruction) return;
  await runAiAction("Drafting changes as a proofed proposal", async () => {
    const response = await postJson<{ proposal: CloudPatchProposal }>(pageAiEndpoint("draft"), { instruction });
    await openProposal(response.proposal, "AI draft proposed");
  });
}

async function refreshFromSources(): Promise<void> {
  if (state.dirty) {
    setPanelStatus(aiAssistantStatus, "Save the page before refreshing it from sources", "error");
    return;
  }
  const answer = window.prompt("Source URLs to refresh this page from (space or comma separated)", "")?.trim();
  if (!answer) return;
  const sourceUrls = answer.split(/[\s,]+/).filter(Boolean).slice(0, 5);
  await runAiAction("Reading sources and drafting a refresh proposal", async () => {
    const response = await postJson<{ proposal: CloudPatchProposal; citations: Array<{ source: string; claim: string }> }>(pageAiEndpoint("refresh"), { sourceUrls });
    await openProposal(response.proposal, `Refresh proposed with ${response.citations.length} citation${response.citations.length === 1 ? "" : "s"}`);
  });
}

async function openProposal(proposal: CloudPatchProposal, message: string): Promise<void> {
  await refreshPatchProposals();
  const summary = document.createElement("div");
  summary.className = "knowledge-answer-text ai-answer-text";
  summary.textContent = `${proposal.summary ?? "AI proposal"}\n\nAnother collaborator must approve it in Agent Review before it can be applied.`;
  aiAssistantOutput.append(summary);
  setPanelStatus(aiAssistantStatus, `${message} · awaiting independent review`, "ok");
  if (!state.panelsOpen) {
    state.panelsOpen = true;
    renderChrome();
  }
  patchProposalList.scrollIntoView({ block: "center" });
}

async function loadMaintenance(siteId: string, key = aiState.maintenanceKey): Promise<void> {
  aiState.maintenanceLoading = true;
  try {
    const [settings, items] = await Promise.all([
      fetchCloudJson<MaintenanceSettingsResponse>(`/api/sites/${encodeURIComponent(siteId)}/maintenance`),
      fetchCloudJson<{ items: MaintenanceItem[] }>(`/api/sites/${encodeURIComponent(siteId)}/maintenance/items?status=open`),
    ]);
    if (aiState.maintenanceKey !== key) return;
    aiState.maintenance = settings;
    aiState.items = items.items;
  } catch (error) {
    setPanelStatus(maintenanceStatus, errorMessage(error), "error");
  } finally {
    aiState.maintenanceLoading = false;
  }
  renderMaintenance();
}

function renderMaintenance(): void {
  const data = aiState.maintenance;
  maintenanceItems.textContent = "";
  if (!data) {
    maintenanceStatus.textContent = "";
    return;
  }
  maintenanceEnabled.checked = data.settings.enabled;
  maintenanceRefresh.checked = data.settings.aiRefresh;
  maintenanceInterval.value = String(data.settings.intervalHours);
  maintenanceLimit.value = String(data.settings.maxProposalsPerRun);
  const lastRun = data.runs[0];
  const aiNote = data.ai.available ? "" : ` · AI drafts off (${(data.ai.reason ?? "").replaceAll("_", " ")})`;
  setPanelStatus(
    maintenanceStatus,
    `${data.openItems} open item${data.openItems === 1 ? "" : "s"}${lastRun ? ` · last ${lastRun.trigger} sweep ${formatDate(lastRun.startedAt)}: ${lastRun.proposalsCreated} draft${lastRun.proposalsCreated === 1 ? "" : "s"}` : " · never swept"}${aiNote}`,
    lastRun?.status === "failed" ? "error" : data.openItems > 0 ? "warning" : "ok",
  );
  if (aiState.items.length === 0) {
    maintenanceItems.append(emptyState("No open maintenance items"));
    return;
  }
  for (const item of aiState.items.slice(0, 12)) {
    const page = state.pages.find((candidate) => candidate.id === item.documentId);
    const row = collaborationRow(item.kind.replaceAll("_", " "), item.message, `${page?.title ?? "page"}${item.blockId ? ` · #${item.blockId}` : ""}${item.proposalId ? " · refresh drafted" : ""}`);
    row.dataset.state = item.severity === "info" ? "ok" : item.severity;
    maintenanceItems.append(row);
  }
}

async function saveMaintenance(): Promise<void> {
  const siteId = state.currentSite?.id;
  if (!siteId) return;
  try {
    aiState.maintenance = await putJson<MaintenanceSettingsResponse>(`/api/sites/${encodeURIComponent(siteId)}/maintenance`, {
      enabled: maintenanceEnabled.checked,
      aiRefresh: maintenanceRefresh.checked,
      intervalHours: clampInteger(maintenanceInterval.value, 1, 720, 24),
      maxProposalsPerRun: clampInteger(maintenanceLimit.value, 0, 20, 3),
    });
    renderMaintenance();
    setPanelStatus(maintenanceStatus, "Maintenance settings saved", "ok");
  } catch (error) {
    setPanelStatus(maintenanceStatus, errorMessage(error), "error");
  }
}

async function runMaintenance(): Promise<void> {
  const siteId = state.currentSite?.id;
  if (!siteId) return;
  aiState.running = true;
  renderAiChrome();
  setPanelStatus(maintenanceStatus, "Sweeping this space", "warning");
  try {
    const result = await postJson<{ run: { proposalsCreated: number; itemsOpen: number } }>(`/api/sites/${encodeURIComponent(siteId)}/maintenance/run`, {});
    await loadMaintenance(siteId);
    if (result.run.proposalsCreated > 0) await refreshPatchProposals();
  } catch (error) {
    setPanelStatus(maintenanceStatus, errorMessage(error), "error");
  } finally {
    aiState.running = false;
    renderAiChrome();
  }
}

function clampInteger(value: string, min: number, max: number, fallback: number): number {
  const parsed = Number.parseInt(value, 10);
  return Number.isFinite(parsed) ? Math.min(max, Math.max(min, parsed)) : fallback;
}

function postJson<T>(url: string, body: Record<string, unknown>): Promise<T> {
  return fetchCloudJson<T>(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}

function putJson<T>(url: string, body: Record<string, unknown>): Promise<T> {
  return fetchCloudJson<T>(url, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
}

function requireElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing #${id}`);
  return element as T;
}
