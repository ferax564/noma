/** Workspace admin: usage overview, data-loss prevention, and audit / SIEM export. Shown to workspace admins only. */
import { fetchCloudJson } from "./api.js";
import { dlpModeSelect, dlpSaveButton, dlpSummary, siemShipButton, siemSummary, workspaceAdminSection, workspaceAdminStatus, workspaceOverview } from "./dom.js";
import { errorMessage, formatDate, setPanelStatus } from "./util.js";

interface Overview {
  people: { users: number; activeLast30d: number };
  knowledge: { spaces: number; pages: number };
  work: { projects: number; openIssues: number };
  chat: { channels: number; directMessages: number; messages: number };
  storage: { attachmentBytes: number; chatFileBytes: number };
  ai: { spendLast30dUsd: number; agents: { active: number; paused: number }; paused: boolean };
  runs: { environment: string | null; runs: number; minutes: number; failed: number; pendingApproval: number };
  compliance: { dlp: { mode: string; blocked: number; flagged: number }; audit: { latestSequence: number; recent: number }; siem: Siem; chatRetentionDays: number };
}

interface Siem {
  configured: boolean;
  url?: string;
  cursor: number;
  lag: number;
  lastShippedAt?: string;
  lastError?: string;
}

interface DlpPolicy {
  mode: "off" | "warn" | "block";
  detectors: string[];
}

export function installWorkspaceAdmin(): void {
  dlpSaveButton.addEventListener("click", () => void saveDlp());
  siemShipButton.addEventListener("click", () => void shipNow());
}

/** Shows the section to admins and loads it; hides it for everyone else. */
export async function refreshWorkspaceAdmin(isAdmin: boolean): Promise<void> {
  workspaceAdminSection.hidden = !isAdmin;
  if (!isAdmin) return;
  try {
    const [overview, dlp] = await Promise.all([fetchCloudJson<Overview>("/api/enterprise/overview"), fetchCloudJson<DlpPolicy>("/api/enterprise/dlp")]);
    renderOverview(overview);
    dlpModeSelect.value = dlp.mode;
    dlpSummary.textContent = `${overview.compliance.dlp.blocked} blocked · ${overview.compliance.dlp.flagged} flagged (30 d)`;
    renderSiem(overview.compliance.siem, overview.compliance.audit.recent);
  } catch (error) {
    setPanelStatus(workspaceAdminStatus, errorMessage(error), "error");
  }
}

function renderOverview(overview: Overview): void {
  const tiles: Array<[string, string, string?]> = [
    ["People", `${overview.people.users}`, `${overview.people.activeLast30d} active in 30 d`],
    ["Spaces · pages", `${overview.knowledge.spaces} · ${overview.knowledge.pages}`],
    ["Open issues", `${overview.work.openIssues}`, `${overview.work.projects} projects`],
    ["Messages (30 d)", `${overview.chat.messages}`, `${overview.chat.channels} channels · ${overview.chat.directMessages} DMs`],
    ["AI spend (30 d)", `$${overview.ai.spendLast30dUsd.toFixed(2)}`, `${overview.ai.agents.active} agents${overview.ai.paused ? " · paused" : ""}`],
    ["Runs this month", `${overview.runs.runs}`, overview.runs.environment ? `${overview.runs.minutes} min · ${overview.runs.failed} failed` : "no run environment"],
    ["Storage", bytes(overview.storage.attachmentBytes + overview.storage.chatFileBytes), `${bytes(overview.storage.chatFileBytes)} in chat`],
    ["Chat retention", overview.compliance.chatRetentionDays ? `${overview.compliance.chatRetentionDays} d` : "Forever"],
  ];
  workspaceOverview.replaceChildren(
    ...tiles.map(([label, value, note]) => {
      const tile = document.createElement("div");
      tile.className = "admin-tile";
      const name = document.createElement("span");
      name.textContent = label;
      const number = document.createElement("strong");
      number.textContent = value;
      tile.append(name, number);
      if (note) {
        const small = document.createElement("small");
        small.textContent = note;
        tile.append(small);
      }
      return tile;
    }),
  );
}

function renderSiem(siem: Siem, recent: number): void {
  siemShipButton.disabled = !siem.configured;
  siemSummary.dataset.state = siem.lastError ? "error" : "ok";
  siemSummary.textContent = siem.configured
    ? `Shipping to ${siem.url} · ${siem.lag === 0 ? "up to date" : `${siem.lag} records behind`}${siem.lastShippedAt ? ` · last ${formatDate(siem.lastShippedAt)}` : ""}${siem.lastError ? ` · ${siem.lastError}` : ""}`
    : `No SIEM configured (NOMA_CLOUD_SIEM_URL) · ${recent} audit records in the last 24 h`;
}

async function saveDlp(): Promise<void> {
  try {
    const saved = await fetchCloudJson<DlpPolicy>("/api/enterprise/dlp", { method: "PUT", body: JSON.stringify({ mode: dlpModeSelect.value }) });
    setPanelStatus(workspaceAdminStatus, `DLP is ${saved.mode === "off" ? "off" : saved.mode === "warn" ? "recording findings" : "blocking secrets and card numbers"}`, "ok");
  } catch (error) {
    setPanelStatus(workspaceAdminStatus, errorMessage(error), "error");
  }
}

async function shipNow(): Promise<void> {
  try {
    const siem = await fetchCloudJson<Siem>("/api/enterprise/siem/ship", { method: "POST" });
    renderSiem(siem, 0);
    setPanelStatus(workspaceAdminStatus, siem.lastError ? `SIEM delivery failed: ${siem.lastError}` : "Audit log shipped", siem.lastError ? "error" : "ok");
  } catch (error) {
    setPanelStatus(workspaceAdminStatus, errorMessage(error), "error");
  }
}

function bytes(value: number): string {
  if (value < 1024) return `${value} B`;
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 ** 3) return `${(value / 1024 / 1024).toFixed(1)} MB`;
  return `${(value / 1024 ** 3).toFixed(2)} GB`;
}
