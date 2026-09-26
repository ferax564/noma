/** Approvals (one queue for agent runs, patches, AI pages, page approvals), the workspace agent kill switch, and hosted/scheduled agents. */
import { refreshWorkspaceAdmin } from "./admin.js";
import { fetchCloudJson } from "./api.js";
import {
  agentHostedInput,
  agentHostingSaveButton,
  agentInstructionsInput,
  agentKillSwitch,
  agentKillSwitchButton,
  agentKillSwitchState,
  agentScheduleAddButton,
  agentScheduleCadenceSelect,
  agentScheduleChannelSelect,
  agentScheduleList,
  agentSchedulePromptInput,
  agentScheduleTitleInput,
  approvalQueueList,
  approvalQueueStatus,
  myAgentBudget,
  myAgentSelect,
  myAgentsStatus,
  refreshApprovalQueueButton,
} from "./dom.js";
import { loadSite, loadStandaloneDocument } from "./navigation.js";
import { state } from "./state.js";
import type { ChatChannel } from "./types.js";
import { actionButton, emptyState, errorMessage, formatDate, setPanelStatus } from "./util.js";

interface QueueItem {
  kind: "run" | "patch" | "page_proposal" | "page_approval";
  id: string;
  title: string;
  detail: string;
  agentName?: string;
  siteId?: string;
  documentId?: string;
  createdAt: string;
  decidable: boolean;
}

interface KillSwitch {
  paused: boolean;
  reason?: string;
}

interface AgentSummary {
  id: string;
  name: string;
  capabilities: string[];
  budgetUsd: number;
  spentUsd: number;
  status: string;
}

interface Hosting {
  enabled: boolean;
  instructions: string;
  model: string | null;
  paused: boolean;
}

interface Schedule {
  id: string;
  title: string;
  channelId: string;
  cadence: "hourly" | "daily" | "weekly";
  enabled: boolean;
  nextRunAt: string;
  lastRunAt?: string;
}

const kindLabel: Record<QueueItem["kind"], string> = { run: "Run", patch: "Page patch", page_proposal: "AI page", page_approval: "Page approval" };

let agents: AgentSummary[] = [];
let channels: ChatChannel[] = [];
let killSwitch: KillSwitch | undefined;

export function installAgentOps(): void {
  refreshApprovalQueueButton.addEventListener("click", () => void refreshApprovalQueue());
  agentKillSwitchButton.addEventListener("click", () => void toggleKillSwitch());
  myAgentSelect.addEventListener("change", () => void loadAgent());
  agentHostingSaveButton.addEventListener("click", () => void saveHosting());
  agentScheduleAddButton.addEventListener("click", () => void addSchedule());
}

/** Reloads the approval queue and, for workspace admins, the kill switch. */
export async function refreshApprovalQueue(): Promise<void> {
  if (!state.cloudUser) {
    approvalQueueList.replaceChildren(emptyState("Log in to see approvals"));
    agentKillSwitch.hidden = true;
    return;
  }
  try {
    const queue = await fetchCloudJson<{ items: QueueItem[]; paused: boolean; killSwitch?: KillSwitch }>("/api/approvals");
    killSwitch = queue.killSwitch;
    void refreshWorkspaceAdmin(Boolean(queue.killSwitch));
    renderKillSwitch(queue.paused);
    approvalQueueList.replaceChildren(...(queue.items.length ? queue.items.map(queueRow) : [emptyState("Nothing is waiting for you")]));
  } catch (error) {
    setPanelStatus(approvalQueueStatus, errorMessage(error), "error");
  }
}

function renderKillSwitch(paused: boolean): void {
  agentKillSwitch.hidden = !killSwitch && !paused;
  agentKillSwitch.dataset.state = paused ? "paused" : "running";
  agentKillSwitchState.textContent = paused ? `⏸ Agents paused${killSwitch?.reason ? ` — ${killSwitch.reason}` : ""}` : "Agents running";
  agentKillSwitchButton.hidden = !killSwitch;
  agentKillSwitchButton.textContent = paused ? "Resume agents" : "Pause all agents";
}

function queueRow(item: QueueItem): HTMLElement {
  const row = document.createElement("div");
  row.className = "dev-run-row";
  row.dataset.status = item.kind === "run" ? "running" : "open";
  const title = document.createElement("strong");
  title.textContent = `${kindLabel[item.kind]} · ${item.title}`;
  const meta = document.createElement("span");
  meta.textContent = [item.detail, formatDate(item.createdAt)].join(" · ");
  const actions = document.createElement("div");
  actions.className = "dev-run-actions";
  if (item.kind === "run") {
    actions.append(
      actionButton("Approve", () => void decideRun(item.id, "approve"), !item.decidable, `Approve ${item.title}`),
      actionButton("Reject", () => void decideRun(item.id, "reject"), false, `Reject ${item.title}`),
    );
    if (!item.decidable) {
      const note = document.createElement("span");
      note.textContent = "Your agent asked — someone else approves";
      actions.append(note);
    }
  } else {
    actions.append(actionButton("Open", () => void openItem(item), false, `Open ${item.title}`));
  }
  row.append(title, meta, actions);
  return row;
}

async function openItem(item: QueueItem): Promise<void> {
  try {
    if (item.siteId) await loadSite(item.siteId, item.documentId);
    else if (item.documentId) await loadStandaloneDocument(item.documentId);
  } catch (error) {
    setPanelStatus(approvalQueueStatus, errorMessage(error), "error");
  }
}

async function decideRun(runId: string, decision: "approve" | "reject"): Promise<void> {
  try {
    const run = await fetchCloudJson<{ status: string; ref: string }>(`/api/approvals/runs/${encodeURIComponent(runId)}`, { method: "POST", body: JSON.stringify({ decision }) });
    setPanelStatus(approvalQueueStatus, decision === "approve" ? `Approved — ${run.ref} is ${run.status}` : `Rejected ${run.ref}`, "ok");
    await refreshApprovalQueue();
  } catch (error) {
    setPanelStatus(approvalQueueStatus, errorMessage(error), "error");
  }
}

async function toggleKillSwitch(): Promise<void> {
  const pausing = !(killSwitch?.paused ?? false);
  const reason = pausing ? window.prompt("Why are you pausing every agent? (recorded in the audit log)", "") : "";
  if (pausing && reason === null) return;
  try {
    killSwitch = await fetchCloudJson<KillSwitch>("/api/enterprise/agents", { method: "PUT", body: JSON.stringify({ paused: pausing, ...(reason ? { reason } : {}) }) });
    renderKillSwitch(killSwitch.paused);
    setPanelStatus(approvalQueueStatus, killSwitch.paused ? "Every agent is paused" : "Agents resumed", killSwitch.paused ? "warning" : "ok");
  } catch (error) {
    setPanelStatus(approvalQueueStatus, errorMessage(error), "error");
  }
}

/** Loads the caller's agents and the current space's channels for scheduling. */
export async function refreshMyAgents(): Promise<void> {
  if (!state.cloudUser) return;
  try {
    const siteId = state.currentSite?.id;
    const [agentResponse, channelResponse] = await Promise.all([
      fetchCloudJson<{ agents: AgentSummary[] }>("/api/agents"),
      siteId ? fetchCloudJson<{ channels: ChatChannel[] }>(`/api/channels?siteId=${encodeURIComponent(siteId)}`) : Promise.resolve({ channels: [] }),
    ]);
    agents = agentResponse.agents.filter((agent) => !agent.id.startsWith("noma-ai-"));
    channels = channelResponse.channels.filter((channel) => channel.kind === "channel");
    const selected = myAgentSelect.value;
    myAgentSelect.replaceChildren(
      ...agents.map((agent) => {
        const option = document.createElement("option");
        option.value = agent.id;
        option.textContent = agent.name;
        return option;
      }),
    );
    if (agents.some((agent) => agent.id === selected)) myAgentSelect.value = selected;
    agentScheduleChannelSelect.replaceChildren(
      ...channels.map((channel) => {
        const option = document.createElement("option");
        option.value = channel.id;
        option.textContent = `#${channel.name}`;
        return option;
      }),
    );
    await loadAgent();
  } catch (error) {
    setPanelStatus(myAgentsStatus, errorMessage(error), "error");
  }
}

async function loadAgent(): Promise<void> {
  const agent = agents.find((item) => item.id === myAgentSelect.value);
  const disabled = !agent;
  for (const control of [agentHostedInput, agentInstructionsInput, agentHostingSaveButton, agentScheduleAddButton]) control.disabled = disabled;
  if (!agent) {
    myAgentBudget.textContent = "Create an agent with the chat capability to host or schedule it";
    agentScheduleList.replaceChildren();
    return;
  }
  const base = `/api/agents/${encodeURIComponent(agent.id)}`;
  const [hosting, schedules] = await Promise.all([fetchCloudJson<Hosting>(`${base}/hosting`), fetchCloudJson<{ schedules: Schedule[] }>(`${base}/schedules`)]);
  myAgentBudget.textContent = `$${agent.spentUsd.toFixed(2)} of $${agent.budgetUsd.toFixed(2)} spent · ${hosting.model ? `model ${hosting.model}` : "no language model configured"}${hosting.paused ? " · paused by an admin" : ""}`;
  agentHostedInput.checked = hosting.enabled;
  agentInstructionsInput.value = hosting.instructions;
  agentScheduleAddButton.disabled = channels.length === 0;
  agentScheduleList.replaceChildren(...(schedules.schedules.length ? schedules.schedules.map((schedule) => scheduleRow(agent, schedule)) : [emptyState("No schedules")]));
}

function scheduleRow(agent: AgentSummary, schedule: Schedule): HTMLElement {
  const row = document.createElement("div");
  row.className = "dev-run-row";
  row.dataset.status = schedule.enabled ? "open" : "canceled";
  const title = document.createElement("strong");
  const channel = channels.find((item) => item.id === schedule.channelId);
  title.textContent = `${schedule.title} → ${channel ? `#${channel.name}` : "another space"}`;
  const meta = document.createElement("span");
  meta.textContent = [`every ${schedule.cadence === "hourly" ? "hour" : schedule.cadence === "daily" ? "day" : "week"}`, `next ${formatDate(schedule.nextRunAt)}`, schedule.lastRunAt ? `last ${formatDate(schedule.lastRunAt)}` : ""].filter(Boolean).join(" · ");
  const actions = document.createElement("div");
  actions.className = "dev-run-actions";
  const base = `/api/agents/${encodeURIComponent(agent.id)}/schedules/${encodeURIComponent(schedule.id)}`;
  actions.append(
    actionButton("Run now", () => void scheduleAction(fetchCloudJson(`${base}/run`, { method: "POST" }), "Posted"), false, `Run ${schedule.title} now`),
    actionButton("Delete", () => void scheduleAction(fetchCloudJson(base, { method: "DELETE" }), "Deleted"), false, `Delete ${schedule.title}`),
  );
  row.append(title, meta, actions);
  return row;
}

async function scheduleAction(request: Promise<unknown>, done: string): Promise<void> {
  try {
    const result = (await request) as { status?: string; error?: string } | undefined;
    setPanelStatus(myAgentsStatus, result?.status === "failed" ? `Run failed: ${result.error ?? ""}` : done, result?.status === "failed" ? "error" : "ok");
    await loadAgent();
  } catch (error) {
    setPanelStatus(myAgentsStatus, errorMessage(error), "error");
  }
}

async function saveHosting(): Promise<void> {
  try {
    await fetchCloudJson(`/api/agents/${encodeURIComponent(myAgentSelect.value)}/hosting`, {
      method: "PUT",
      body: JSON.stringify({ enabled: agentHostedInput.checked, instructions: agentInstructionsInput.value }),
    });
    setPanelStatus(myAgentsStatus, agentHostedInput.checked ? "Hosted — the agent answers @mentions in channels it can chat in" : "Hosting off", "ok");
    await loadAgent();
  } catch (error) {
    setPanelStatus(myAgentsStatus, errorMessage(error), "error");
  }
}

async function addSchedule(): Promise<void> {
  try {
    await fetchCloudJson(`/api/agents/${encodeURIComponent(myAgentSelect.value)}/schedules`, {
      method: "POST",
      body: JSON.stringify({
        channelId: agentScheduleChannelSelect.value,
        cadence: agentScheduleCadenceSelect.value,
        title: agentScheduleTitleInput.value.trim() || "Digest",
        prompt: agentSchedulePromptInput.value.trim(),
      }),
    });
    agentScheduleTitleInput.value = "";
    agentSchedulePromptInput.value = "";
    setPanelStatus(myAgentsStatus, "Schedule added", "ok");
    await loadAgent();
  } catch (error) {
    setPanelStatus(myAgentsStatus, errorMessage(error), "error");
  }
}
