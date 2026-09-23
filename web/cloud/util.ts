/** Small DOM, formatting and status helpers shared across modules. */
import { cloudStatus } from "./dom.js";
import { renderChrome } from "./layout.js";
import { state } from "./state.js";
import type { PanelState } from "./types.js";

export function actionButton(label: string, action: () => void, disabled = false, accessibleLabel?: string): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.textContent = label;
  button.disabled = disabled;
  if (accessibleLabel) {
    button.setAttribute("aria-label", accessibleLabel);
    button.title = accessibleLabel;
  }
  button.addEventListener("click", action);
  return button;
}

export function iconButton(text: string, title: string, onClick: () => void, variant?: "danger"): HTMLButtonElement {
  const button = document.createElement("button");
  button.type = "button";
  button.className = variant === "danger" ? "row-action row-action-danger" : "row-action";
  button.textContent = text;
  button.title = title;
  button.setAttribute("aria-label", title);
  button.addEventListener("click", (event) => {
    event.stopPropagation();
    onClick();
  });
  return button;
}

export function emptyState(text: string): HTMLElement {
  const row = document.createElement("div");
  row.className = "empty-state";
  row.textContent = text;
  return row;
}

export function normalizeInlineText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

export function normalizeBlockText(text: string): string {
  return text
    .replace(/\u00a0/g, " ")
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .join("\n");
}

export function positiveInt(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : undefined;
}

export function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

export function promptName(label: string, fallback: string): string {
  const value = window.prompt(label, fallback);
  return value?.trim() || fallback;
}

export function absoluteUrl(path: string): string {
  return new URL(path, window.location.origin).toString();
}

export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

export function setBusy(value: boolean, message?: string, panelState: PanelState = "warning"): void {
  state.busy = value;
  if (message) setCloudStatus(message, panelState);
  renderChrome();
}

export function setCloudStatus(message: string, panelState: PanelState): void {
  cloudStatus.textContent = message;
  cloudStatus.dataset.state = panelState;
}

export function setPanelStatus(element: HTMLElement, message: string, panelState: PanelState): void {
  element.textContent = message;
  element.dataset.state = panelState;
}

export async function copyText(text: string, status: string): Promise<void> {
  await navigator.clipboard.writeText(text);
  setCloudStatus(status, "ok");
}

export function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function shortId(value: string): string {
  return `${value.slice(0, 6)}...${value.slice(-4)}`;
}

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => {
    switch (char) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#39;";
    }
  });
}
