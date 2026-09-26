/** Work → "Code & runs": the project's linked GitHub repo, its pull requests, and deploy/test runs on the run environment. */
import { fetchCloudJson } from "./api.js";
import {
  devAutoPreviewInput,
  devHookInfo,
  devLinkRepoButton,
  devLoopEnv,
  devLoopRepo,
  devLoopSetup,
  devPullList,
  devRepoInput,
  devRunButton,
  devRunKindSelect,
  devRunList,
  devRunRefInput,
  devRunsEnabledInput,
  workStatus,
} from "./dom.js";
import { state } from "./state.js";
import { actionButton, emptyState, errorMessage, formatDate, setPanelStatus } from "./util.js";

interface DevRepoResponse {
  linked: boolean;
  runEnvironment: string | null;
  hookPath: string;
  repo?: string;
  defaultBranch?: string;
  runsEnabled?: boolean;
  autoPreview?: boolean;
  monthlyMinutes?: number;
  webhookSecret?: string;
  usage?: { minutesUsed: number; activeRuns: number };
}

interface DevRun {
  id: string;
  kind: "deploy" | "test";
  ref: string;
  status: "queued" | "running" | "success" | "failed" | "canceled";
  url?: string;
  issueKey?: string;
  error?: string;
  requestedByName: string;
  createdAt: string;
  minutes: number;
}

interface DevPull {
  number: number;
  title: string;
  url: string;
  state: "open" | "merged" | "closed";
  ciStatus?: "pending" | "success" | "failure";
  issues: Array<{ key: string }>;
}

const statusIcon: Record<DevRun["status"], string> = { queued: "⏳", running: "⏳", success: "✅", failed: "❌", canceled: "⏹" };
const ciIcon: Record<NonNullable<DevPull["ciStatus"]>, string> = { pending: "⏳", success: "✅", failure: "❌" };

let projectId = "";
let repo: DevRepoResponse | undefined;
let role = "viewer";

export function installDevLoop(): void {
  devLinkRepoButton.addEventListener("click", () => void saveRepo());
  devRunButton.addEventListener("click", () => void startRun());
  devRunRefInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") void startRun();
  });
}

/** Loads the repo link, runs, and pull requests for the selected Work project. */
export async function refreshDevLoop(nextProjectId: string, nextRole: string): Promise<void> {
  projectId = nextProjectId;
  role = nextRole;
  if (!projectId || !state.cloudUser) {
    repo = undefined;
    render([], []);
    return;
  }
  const base = `/api/projects/${encodeURIComponent(projectId)}`;
  try {
    const [repoResponse, runs, pulls] = await Promise.all([
      fetchCloudJson<DevRepoResponse>(`${base}/repo`),
      fetchCloudJson<{ runs: DevRun[] }>(`${base}/runs?limit=10`),
      fetchCloudJson<{ pulls: DevPull[] }>(`${base}/pulls`),
    ]);
    if (projectId !== nextProjectId) return;
    repo = repoResponse;
    render(runs.runs, pulls.pulls.slice(0, 10));
  } catch (error) {
    setPanelStatus(workStatus, errorMessage(error), "error");
  }
}

function render(runs: DevRun[], pulls: DevPull[]): void {
  const owner = role === "owner";
  const canRun = role === "owner" || role === "editor";
  devLoopEnv.textContent = repo?.runEnvironment ? `runs on ${repo.runEnvironment}` : "no run environment";
  devLoopEnv.dataset.state = repo?.runEnvironment ? "ok" : "off";
  if (!repo?.linked) devLoopRepo.textContent = projectId ? "No GitHub repository linked" : "Select a project";
  else {
    const usage = repo.usage ? ` · ${repo.usage.minutesUsed}/${repo.monthlyMinutes} min this month` : "";
    devLoopRepo.textContent = `${repo.repo} · ${repo.runsEnabled ? "runs on" : "runs off"}${repo.autoPreview ? " · PR previews" : ""}${usage}`;
  }
  devLoopSetup.hidden = !owner || !projectId;
  devRepoInput.value = repo?.repo ?? "";
  devRunsEnabledInput.checked = Boolean(repo?.runsEnabled);
  devAutoPreviewInput.checked = Boolean(repo?.autoPreview);
  devHookInfo.hidden = !repo?.webhookSecret;
  if (repo?.webhookSecret) {
    devHookInfo.replaceChildren(
      hookLine("Payload URL", `${location.origin}${repo.hookPath}`),
      hookLine("Secret", repo.webhookSecret),
      hookLine("Events", "Pull requests, Workflow runs, Check suites"),
    );
  }
  const runnable = Boolean(repo?.linked && repo.runsEnabled && repo.runEnvironment && canRun);
  devRunButton.disabled = !runnable;
  devRunRefInput.disabled = !runnable;
  devRunKindSelect.disabled = !runnable;
  devRunRefInput.placeholder = repo?.defaultBranch ?? "branch, tag, or SHA";
  devRunList.replaceChildren(...(runs.length ? runs.map((run) => runRow(run, canRun)) : [emptyState(repo?.linked ? "No runs yet — try /deploy <branch> in the project channel" : "Link a repository to run deploys and tests")]));
  devPullList.replaceChildren(...pulls.map(pullRow));
}

function hookLine(label: string, value: string): HTMLElement {
  const row = document.createElement("div");
  const name = document.createElement("span");
  name.textContent = label;
  const code = document.createElement("code");
  code.textContent = value;
  row.append(name, code);
  return row;
}

function runRow(run: DevRun, canStop: boolean): HTMLElement {
  const row = document.createElement("div");
  row.className = "dev-run-row";
  row.dataset.status = run.status;
  const title = document.createElement("strong");
  title.textContent = `${statusIcon[run.status]} ${run.kind === "deploy" ? "Deploy" : "Test"} ${run.ref}`;
  const meta = document.createElement("span");
  meta.textContent = [run.issueKey, run.requestedByName, formatDate(run.createdAt), run.minutes ? `${run.minutes} min` : "", run.error ?? ""].filter(Boolean).join(" · ");
  row.append(title, meta);
  const actions = document.createElement("div");
  actions.className = "dev-run-actions";
  if (run.url && run.status === "success") {
    const link = document.createElement("a");
    link.href = run.url;
    link.target = "_blank";
    link.rel = "noopener noreferrer";
    link.textContent = "Open preview";
    actions.append(link);
  }
  if (canStop && (run.status === "running" || run.status === "queued" || (run.kind === "deploy" && run.status === "success"))) {
    actions.append(actionButton(run.kind === "deploy" && run.status === "success" ? "Remove" : "Stop", () => void stopRun(run.id), false, `Stop run ${run.id}`));
  }
  if (actions.childElementCount) row.append(actions);
  return row;
}

function pullRow(pull: DevPull): HTMLElement {
  const row = document.createElement("div");
  row.className = "dev-run-row";
  row.dataset.status = pull.state;
  const link = document.createElement("a");
  link.href = pull.url;
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  link.textContent = `#${pull.number} ${pull.title}`;
  const meta = document.createElement("span");
  meta.textContent = [pull.state, pull.ciStatus ? `CI ${ciIcon[pull.ciStatus]}` : "", pull.issues.map((issue) => issue.key).join(", ")].filter(Boolean).join(" · ");
  row.append(link, meta);
  return row;
}

async function saveRepo(): Promise<void> {
  if (!projectId) return;
  try {
    await fetchCloudJson(`/api/projects/${encodeURIComponent(projectId)}/repo`, {
      method: "PUT",
      body: JSON.stringify({ repo: devRepoInput.value.trim(), runsEnabled: devRunsEnabledInput.checked, autoPreview: devAutoPreviewInput.checked }),
    });
    setPanelStatus(workStatus, "Repository saved — add the webhook in GitHub with the URL and secret shown", "ok");
    await refreshDevLoop(projectId, role);
  } catch (error) {
    setPanelStatus(workStatus, errorMessage(error), "error");
  }
}

async function startRun(): Promise<void> {
  if (!projectId || devRunButton.disabled) return;
  try {
    const run = await fetchCloudJson<DevRun>(`/api/projects/${encodeURIComponent(projectId)}/runs`, {
      method: "POST",
      body: JSON.stringify({ kind: devRunKindSelect.value, ...(devRunRefInput.value.trim() ? { ref: devRunRefInput.value.trim() } : {}) }),
    });
    devRunRefInput.value = "";
    setPanelStatus(workStatus, run.status === "failed" ? `Run failed to start: ${run.error ?? ""}` : `${run.kind === "deploy" ? "Deploy" : "Test"} of ${run.ref} started`, run.status === "failed" ? "error" : "ok");
    await refreshDevLoop(projectId, role);
  } catch (error) {
    setPanelStatus(workStatus, errorMessage(error), "error");
  }
}

async function stopRun(runId: string): Promise<void> {
  try {
    await fetchCloudJson(`/api/projects/${encodeURIComponent(projectId)}/runs/${encodeURIComponent(runId)}`, { method: "DELETE" });
    await refreshDevLoop(projectId, role);
  } catch (error) {
    setPanelStatus(workStatus, errorMessage(error), "error");
  }
}
