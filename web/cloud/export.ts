/** Export menu: download the current page (PDF, Word, PowerPoint, PaperDOM, Markdown, HTML, .noma) or the current space (HTML site or .noma bundle). */
import { CloudRequestError } from "./api.js";
import { shareToken, state } from "./state.js";
import { errorMessage, setBusy, setCloudStatus } from "./util.js";

const exportSelect = element<HTMLSelectElement>("exportFormatSelect");

export function installExportMenu(): void {
  exportSelect.addEventListener("change", () => {
    const value = exportSelect.value;
    exportSelect.value = "";
    if (value) void downloadExport(value);
  });
}

export function renderExportChrome(): void {
  exportSelect.disabled = state.busy || !state.currentPage;
  for (const option of exportSelect.querySelectorAll<HTMLOptionElement>("option[data-export-scope='site']")) {
    option.disabled = !state.currentSite;
  }
}

/** Short summary of what a .pptx export could not carry exactly (from the `x-noma-fidelity` header). */
function fidelityNote(header: string | null): string {
  if (!header) return "";
  try {
    const report = JSON.parse(header) as { approximated?: string[]; unsupported?: string[] };
    const items = [...(report.approximated ?? []), ...(report.unsupported ?? [])];
    return items.length ? ` · not exact in PowerPoint: ${items.map((item) => item.split(":")[0]).join(", ")}` : "";
  } catch {
    return "";
  }
}

async function downloadExport(value: string): Promise<void> {
  const [scope, format] = value.split(":");
  const url =
    scope === "site" && state.currentSite
      ? `/api/sites/${encodeURIComponent(state.currentSite.id)}/export?to=${encodeURIComponent(format ?? "")}`
      : state.currentPage
        ? `/api/documents/${encodeURIComponent(state.currentPage.id)}/export?to=${encodeURIComponent(format ?? "")}`
        : undefined;
  if (!url) return;
  if (state.dirty && scope !== "site") setCloudStatus("Exporting the last saved version; save to include your edits", "warning");
  setBusy(true, format === "pdf" ? "Rendering PDF" : "Preparing export", "warning");
  try {
    const headers = new Headers();
    if (shareToken) headers.set("x-noma-share-token", shareToken);
    const response = await fetch(url, { headers, credentials: "same-origin" });
    if (!response.ok) {
      const text = await response.text();
      let message = `${response.status} ${response.statusText}`;
      try {
        message = (JSON.parse(text) as { error?: string }).error ?? message;
      } catch {
        if (text) message = text;
      }
      throw new CloudRequestError(response.status, message, {});
    }
    const blob = await response.blob();
    const filename = /filename="([^"]+)"/.exec(response.headers.get("content-disposition") ?? "")?.[1] ?? "export";
    const link = document.createElement("a");
    link.href = URL.createObjectURL(blob);
    link.download = filename;
    document.body.append(link);
    link.click();
    link.remove();
    window.setTimeout(() => URL.revokeObjectURL(link.href), 10_000);
    const fidelity = fidelityNote(response.headers.get("x-noma-fidelity"));
    setCloudStatus(`Downloaded ${filename}${fidelity}`, fidelity ? "warning" : "ok");
  } catch (error) {
    setCloudStatus(errorMessage(error), "error");
  } finally {
    setBusy(false);
  }
}

function element<T extends HTMLElement>(id: string): T {
  const found = document.getElementById(id);
  if (!found) throw new Error(`Missing #${id}`);
  return found as T;
}
