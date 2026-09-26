/** Moving in from Slack and Jira: upload a Slack export into the space, or Jira search JSON into the selected project. */
import { fetchCloudJson } from "./api.js";
import { refreshChat } from "./chat.js";
import { chatStatus, jiraImportButton, jiraImportInput, slackImportButton, slackImportInput, workProjectSelect, workStatus } from "./dom.js";
import { state } from "./state.js";
import { errorMessage, setPanelStatus } from "./util.js";

interface SlackReport {
  channels: unknown[];
  messages: number;
  threads: number;
  matchedPeople: number;
  unmatchedPeople: string[];
  skipped: { alreadyImported: number; files: number };
}

interface JiraReport {
  created: number;
  alreadyImported: number;
  comments: number;
  links: number;
  unmatchedPeople: string[];
}

export function installSwitching(): void {
  slackImportButton.addEventListener("click", () => slackImportInput.click());
  jiraImportButton.addEventListener("click", () => jiraImportInput.click());
  slackImportInput.addEventListener("change", () => void importSlack());
  jiraImportInput.addEventListener("change", () => void importJira());
}

async function importSlack(): Promise<void> {
  const file = slackImportInput.files?.[0];
  slackImportInput.value = "";
  if (!file || !state.currentSite) return;
  setPanelStatus(chatStatus, `Importing ${file.name}…`, "ok");
  try {
    const report = await fetchCloudJson<SlackReport>(`/api/import/slack?siteId=${encodeURIComponent(state.currentSite.id)}`, { method: "POST", headers: { "content-type": "application/zip" }, body: file });
    const people = report.unmatchedPeople.length ? ` · ${report.unmatchedPeople.length} people without a Noma account kept as names` : "";
    await refreshChat();
    setPanelStatus(chatStatus, `Imported ${report.messages} messages (${report.threads} in threads) into ${report.channels.length} channels${report.skipped.alreadyImported ? ` · ${report.skipped.alreadyImported} already here` : ""}${people}`, "ok");
  } catch (error) {
    setPanelStatus(chatStatus, errorMessage(error), "error");
  }
}

async function importJira(): Promise<void> {
  const file = jiraImportInput.files?.[0];
  jiraImportInput.value = "";
  const projectId = workProjectSelect.value;
  if (!file) return;
  if (!projectId) {
    setPanelStatus(workStatus, "Choose a project to import into", "error");
    return;
  }
  try {
    const search = JSON.parse(await file.text()) as unknown;
    const report = await fetchCloudJson<JiraReport>("/api/import/jira", { method: "POST", body: JSON.stringify({ projectId, search }) });
    setPanelStatus(workStatus, `Imported ${report.created} issues, ${report.comments} comments, ${report.links} links${report.alreadyImported ? ` · ${report.alreadyImported} already here` : ""}`, "ok");
    workProjectSelect.dispatchEvent(new Event("change"));
  } catch (error) {
    setPanelStatus(workStatus, errorMessage(error), "error");
  }
}
