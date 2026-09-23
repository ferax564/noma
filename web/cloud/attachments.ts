/** Page attachments: inspector panel, uploads (button, drag-and-drop, paste), and `att:` resolution for the preview. */
import { CloudRequestError, fetchCloudJson } from "./api.js";
import { collaborationActions, collaborationRow } from "./collaboration.js";
import { sourceInput } from "./dom.js";
import { renderCurrent } from "./editor.js";
import { canEditPage } from "./permissions.js";
import { shareToken, state } from "./state.js";
import { actionButton, copyText, emptyState, errorMessage, formatDate, setPanelStatus } from "./util.js";

export interface CloudAttachmentInfo {
  id: string;
  documentId: string;
  filename: string;
  contentType: string;
  size: number;
  sha256: string;
  image: boolean;
  reference: string;
  url?: string;
  createdAt: string;
  uploadedByName?: string;
}

const attachmentList = requireElement<HTMLElement>("attachmentsList");
const attachmentStatus = requireElement<HTMLElement>("attachmentsStatus");
const uploadButton = requireElement<HTMLButtonElement>("attachmentsUploadButton");
const fileInput = requireElement<HTMLInputElement>("attachmentsFileInput");
const refreshButton = requireElement<HTMLButtonElement>("attachmentsRefreshButton");

let attachments: CloudAttachmentInfo[] = [];
let attachmentsPageId: string | undefined;

/** Maps an `att:` reference in the current page to its signed download URL (renderer resolver). */
export function resolveAttachmentUrl(ref: string): string | undefined {
  if (!state.currentPage || attachmentsPageId !== state.currentPage.id) return undefined;
  const attachment = attachments.find((item) => item.id === ref) ?? [...attachments].reverse().find((item) => item.filename === ref);
  return attachment?.url;
}

export function installAttachments(): void {
  uploadButton.addEventListener("click", () => fileInput.click());
  fileInput.addEventListener("change", () => {
    const files = [...(fileInput.files ?? [])];
    fileInput.value = "";
    if (files.length) void uploadAttachments(files, false);
  });
  refreshButton.addEventListener("click", () => void refreshAttachments());

  sourceInput.addEventListener("dragover", (event) => {
    if (!hasFiles(event.dataTransfer) || !canEditPage()) return;
    event.preventDefault();
    if (event.dataTransfer) event.dataTransfer.dropEffect = "copy";
    sourceInput.dataset.attachmentDrop = "true";
  });
  sourceInput.addEventListener("dragleave", () => {
    delete sourceInput.dataset.attachmentDrop;
  });
  sourceInput.addEventListener("drop", (event) => {
    delete sourceInput.dataset.attachmentDrop;
    const files = [...(event.dataTransfer?.files ?? [])];
    if (!files.length || !canEditPage()) return;
    event.preventDefault();
    void uploadAttachments(files, true);
  });
  sourceInput.addEventListener("paste", (event) => {
    const files = [...(event.clipboardData?.files ?? [])];
    if (!files.length || !canEditPage()) return;
    event.preventDefault();
    void uploadAttachments(files, true);
  });
}

export async function refreshAttachments(): Promise<void> {
  const page = state.currentPage;
  if (!page || (!state.cloudUser && !shareToken)) {
    attachments = [];
    attachmentsPageId = undefined;
    renderAttachments();
    return;
  }
  try {
    const response = await fetchCloudJson<{ attachments: CloudAttachmentInfo[] }>(`/api/documents/${encodeURIComponent(page.id)}/attachments`);
    if (state.currentPage?.id !== page.id) return;
    const referencedBefore = attachmentsPageId === page.id ? attachments.map((item) => item.id).join(",") : "";
    attachments = response.attachments;
    attachmentsPageId = page.id;
    renderAttachments();
    if (attachments.map((item) => item.id).join(",") !== referencedBefore && /\batt:/.test(sourceInput.value)) renderCurrent();
  } catch (error) {
    if (state.currentPage?.id !== page.id) return;
    attachments = [];
    attachmentsPageId = page.id;
    renderAttachments();
    if (!(error instanceof CloudRequestError && error.status === 403)) setPanelStatus(attachmentStatus, errorMessage(error), "error");
  }
}

export function renderAttachments(): void {
  const editable = Boolean(state.currentPage) && canEditPage();
  uploadButton.disabled = state.busy || !editable;
  refreshButton.disabled = state.busy || !state.currentPage;
  attachmentList.textContent = "";
  if (!state.currentPage) {
    attachmentList.append(emptyState("Open a page to see its attachments."));
    return;
  }
  const current = attachmentsPageId === state.currentPage.id ? attachments : [];
  if (current.length === 0) {
    attachmentList.append(emptyState(editable ? "No attachments. Drop or paste files into the source to upload." : "No attachments."));
    return;
  }
  for (const attachment of current) {
    const row = collaborationRow(attachment.filename, `${attachment.contentType} · ${formatBytes(attachment.size)}`, `${attachment.uploadedByName ?? "Uploaded"} · ${formatDate(attachment.createdAt)}`);
    row.classList.add("attachment-row");
    row.dataset.attachmentId = attachment.id;
    const actions = collaborationActions();
    if (attachment.url) {
      const open = document.createElement("a");
      open.className = "attachment-open";
      open.href = attachment.url;
      open.target = "_blank";
      open.rel = "noopener noreferrer";
      open.textContent = "Open";
      actions.append(open);
    }
    actions.append(
      actionButton("Copy ref", () => void copyText(attachmentSnippet(attachment), "Copied attachment reference"), false, `Copy reference to ${attachment.filename}`),
      actionButton("Insert", () => insertAtCursor(attachmentSnippet(attachment)), !editable, `Insert ${attachment.filename} at the cursor`),
      actionButton("Delete", () => void deleteAttachment(attachment), !editable, `Delete ${attachment.filename}`),
    );
    row.append(actions);
    attachmentList.append(row);
  }
}

async function uploadAttachments(files: File[], insert: boolean): Promise<void> {
  const page = state.currentPage;
  if (!page || !canEditPage()) return;
  const snippets: string[] = [];
  for (const [index, file] of files.entries()) {
    setPanelStatus(attachmentStatus, `Uploading ${file.name || "file"} (${index + 1}/${files.length})`, "warning");
    try {
      const attachment = await fetchCloudJson<CloudAttachmentInfo>(`/api/documents/${encodeURIComponent(page.id)}/attachments`, {
        method: "POST",
        headers: { "content-type": file.type || "application/octet-stream", "x-filename": encodeURIComponent(file.name || defaultName(file)) },
        body: file,
      });
      if (state.currentPage?.id !== page.id) return;
      attachments = [...(attachmentsPageId === page.id ? attachments : []), attachment];
      attachmentsPageId = page.id;
      snippets.push(attachmentSnippet(attachment));
    } catch (error) {
      setPanelStatus(attachmentStatus, `${file.name || "File"}: ${errorMessage(error)}`, "error");
      renderAttachments();
      if (insert && snippets.length) insertAtCursor(snippets.join("\n\n"));
      return;
    }
  }
  setPanelStatus(attachmentStatus, files.length === 1 ? "Uploaded 1 attachment" : `Uploaded ${files.length} attachments`, "ok");
  renderAttachments();
  if (insert && snippets.length) insertAtCursor(snippets.join("\n\n"));
  else renderCurrent();
}

async function deleteAttachment(attachment: CloudAttachmentInfo): Promise<void> {
  if (!state.currentPage || !window.confirm(`Delete ${attachment.filename}? Pages that reference it will show a placeholder.`)) return;
  try {
    await fetchCloudJson(`/api/documents/${encodeURIComponent(attachment.documentId)}/attachments/${encodeURIComponent(attachment.id)}`, { method: "DELETE" });
    attachments = attachments.filter((item) => item.id !== attachment.id);
    setPanelStatus(attachmentStatus, `Deleted ${attachment.filename}`, "ok");
    renderAttachments();
    renderCurrent();
  } catch (error) {
    setPanelStatus(attachmentStatus, errorMessage(error), "error");
  }
}

/** Figure block for images, inline link for everything else; both round-trip through `.noma` source. */
export function attachmentSnippet(attachment: Pick<CloudAttachmentInfo, "id" | "filename" | "image">): string {
  if (attachment.image) {
    const alt = attachment.filename.replace(/\.[^.]+$/, "").replace(/["\\]/g, "").trim() || "Attachment";
    return `::figure{src="att:${attachment.id}" alt="${alt}"}\n::`;
  }
  return `[${attachment.filename.replace(/([[\]\\])/g, "\\$1")}](att:${attachment.id})`;
}

function insertAtCursor(snippet: string): void {
  const start = sourceInput.selectionStart ?? sourceInput.value.length;
  const end = sourceInput.selectionEnd ?? start;
  const before = sourceInput.value.slice(0, start);
  const after = sourceInput.value.slice(end);
  const block = snippet.startsWith("::");
  const prefix = block && before && !before.endsWith("\n\n") ? (before.endsWith("\n") ? "\n" : "\n\n") : "";
  const suffix = block ? (after.startsWith("\n") ? "\n" : "\n\n") : "";
  sourceInput.setRangeText(`${prefix}${snippet}${suffix}`, start, end, "end");
  sourceInput.focus();
  sourceInput.dispatchEvent(new Event("input", { bubbles: true }));
}

function hasFiles(transfer: DataTransfer | null): boolean {
  return Boolean(transfer && [...transfer.types].includes("Files"));
}

function defaultName(file: File): string {
  const extension = file.type.split("/")[1]?.replace(/[^a-z0-9]/gi, "") || "bin";
  return `pasted-${new Date().toISOString().replace(/[:.]/g, "-")}.${extension}`;
}

function formatBytes(size: number): string {
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / (1024 * 1024)).toFixed(1)} MB`;
}

function requireElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing #${id}`);
  return element as T;
}
