/** "Import from Confluence" dialog: live Cloud/Data Center import or an XML export/JSON bundle upload, with job polling. */
import { CloudRequestError, fetchCloudJson } from "./api.js";
import { renderChrome } from "./layout.js";
import { loadSite } from "./navigation.js";
import { canEditSite } from "./permissions.js";
import { shareToken, state } from "./state.js";
import { errorMessage, setCloudStatus, setPanelStatus } from "./util.js";

interface ImportJobResponse {
  id: string;
  status: "queued" | "running" | "succeeded" | "failed";
  spaceKey?: string;
  progress: { total: number; processed: number; created: number; updated: number; unchanged: number; skipped: number; failed: number };
  result?: { loss?: Array<{ macro: string; count: number }>; attachments?: { referenced: number; copied?: number; reused?: number; skipped?: number; note?: string } };
  error?: string;
}

const openButton = element<HTMLButtonElement>("confluenceImportButton");
const dialog = element<HTMLDialogElement>("confluenceImportDialog");
const form = element<HTMLFormElement>("confluenceImportForm");
const modeSelect = element<HTMLSelectElement>("confluenceImportMode");
const baseUrlInput = element<HTMLInputElement>("confluenceImportBaseUrl");
const spaceKeyInput = element<HTMLInputElement>("confluenceImportSpaceKey");
const emailInput = element<HTMLInputElement>("confluenceImportEmail");
const tokenInput = element<HTMLInputElement>("confluenceImportToken");
const fileInput = element<HTMLInputElement>("confluenceImportFile");
const overwriteInput = element<HTMLInputElement>("confluenceImportOverwrite");
const startButton = element<HTMLButtonElement>("confluenceImportStart");
const cancelButton = element<HTMLButtonElement>("confluenceImportCancel");
const status = element<HTMLElement>("confluenceImportStatus");
let polling = false;

export function installConfluenceImport(): void {
  openButton.addEventListener("click", () => openDialog());
  cancelButton.addEventListener("click", () => dialog.close());
  modeSelect.addEventListener("change", () => syncMode());
  form.addEventListener("submit", (event) => {
    event.preventDefault();
    void startImport();
  });
  syncMode();
}

export function renderConfluenceImportChrome(): void {
  openButton.disabled = state.busy || !state.cloudUser || !state.currentSite || !canEditSite() || Boolean(shareToken);
}

function openDialog(): void {
  if (!state.currentSite) {
    setCloudStatus("Open a space to import into", "error");
    return;
  }
  setPanelStatus(status, `Pages are added to "${state.currentSite.title}". Credentials are used once and never stored.`, "ok");
  startButton.disabled = false;
  dialog.showModal();
}

function syncMode(): void {
  const mode = modeSelect.value;
  const live = mode === "cloud" || mode === "datacenter";
  for (const field of form.querySelectorAll<HTMLElement>("[data-import-mode]")) {
    const modes = (field.dataset.importMode ?? "").split(" ");
    field.hidden = !modes.includes(mode);
  }
  baseUrlInput.required = live;
  spaceKeyInput.required = live;
  emailInput.required = mode === "cloud";
  tokenInput.required = live;
  fileInput.required = !live;
  tokenInput.placeholder = mode === "datacenter" ? "Personal access token" : "API token";
  fileInput.accept = mode === "bundle" ? ".json,application/json" : ".zip,.xml,application/zip,application/xml";
}

async function startImport(): Promise<void> {
  const site = state.currentSite;
  if (!site || polling) return;
  const mode = modeSelect.value;
  startButton.disabled = true;
  setPanelStatus(status, "Starting import…", "warning");
  try {
    let started: { job: ImportJobResponse };
    if (mode === "cloud" || mode === "datacenter") {
      started = await fetchCloudJson(`/api/import/confluence`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          siteId: site.id,
          deployment: mode,
          baseUrl: baseUrlInput.value.trim(),
          spaceKey: spaceKeyInput.value.trim(),
          overwrite: overwriteInput.checked,
          ...(mode === "cloud" ? { email: emailInput.value.trim(), apiToken: tokenInput.value } : { pat: tokenInput.value }),
        }),
      });
      tokenInput.value = "";
    } else {
      const file = fileInput.files?.[0];
      if (!file) throw new Error("Choose a file to import");
      if (mode === "bundle") {
        const bundle = JSON.parse(await file.text()) as unknown;
        started = await fetchCloudJson(`/api/import/confluence`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ siteId: site.id, overwrite: overwriteInput.checked, bundle }),
        });
      } else {
        const type = /\.xml$/i.test(file.name) ? "application/xml" : "application/zip";
        started = await fetchCloudJson(`/api/import/confluence?site=${encodeURIComponent(site.id)}&overwrite=${overwriteInput.checked}`, {
          method: "POST",
          headers: { "content-type": type },
          body: file,
        });
      }
    }
    await pollJob(started.job.id, site.id);
  } catch (error) {
    const message = error instanceof CloudRequestError ? error.message : errorMessage(error);
    setPanelStatus(status, message, "error");
    startButton.disabled = false;
  }
}

async function pollJob(jobId: string, siteId: string): Promise<void> {
  polling = true;
  try {
    for (;;) {
      const { job } = await fetchCloudJson<{ job: ImportJobResponse }>(`/api/import/jobs/${encodeURIComponent(jobId)}`);
      const { progress } = job;
      if (job.status === "failed") {
        setPanelStatus(status, job.error ?? "Import failed", "error");
        startButton.disabled = false;
        return;
      }
      if (job.status === "succeeded") {
        const lossy = job.result?.loss?.length ? ` Unsupported macros kept as text: ${job.result.loss.map((entry) => `${entry.macro} ×${entry.count}`).join(", ")}.` : "";
        const copied = (job.result?.attachments?.copied ?? 0) + (job.result?.attachments?.reused ?? 0);
        const skippedFiles = job.result?.attachments?.skipped ?? 0;
        const attachments = copied || skippedFiles
          ? ` Attachments: ${copied} copied${skippedFiles ? `, ${skippedFiles} skipped (kept as Confluence links)` : ""}.`
          : "";
        setPanelStatus(
          status,
          `Imported ${job.spaceKey ?? "space"}: ${progress.created} created, ${progress.updated} updated, ${progress.unchanged} unchanged, ${progress.skipped} skipped, ${progress.failed} failed.${lossy}${attachments}`,
          progress.failed > 0 || progress.skipped > 0 ? "warning" : "ok",
        );
        startButton.disabled = false;
        setCloudStatus("Confluence import finished", "ok");
        if (state.currentSite?.id === siteId) await loadSite(siteId, state.currentPage?.id);
        return;
      }
      setPanelStatus(status, `Importing${job.spaceKey ? ` ${job.spaceKey}` : ""}: ${progress.processed}/${progress.total || "?"} pages…`, "warning");
      await new Promise((resolve) => window.setTimeout(resolve, 1_000));
    }
  } finally {
    polling = false;
    renderChrome();
  }
}

function element<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`Missing #${id}`);
  return found as T;
}
