/** Space webhooks panel (owners): register a URL for events, see the signing secret once, inspect deliveries, delete. */
import { fetchCloudJson } from "./api.js";
import { state } from "./state.js";
import { actionButton, emptyState, errorMessage, formatDate, setPanelStatus } from "./util.js";

interface WebhookSummary {
  id: string;
  url: string;
  events: string[];
  format: "json" | "slack";
  secretPreview: string;
  createdAt: string;
}

interface DeliverySummary {
  id: string;
  event: string;
  status: string;
  attempts: number;
  responseStatus?: number;
  lastError?: string;
  createdAt: string;
}

const section = requireElement<HTMLElement>("webhookSection");
const urlInput = requireElement<HTMLInputElement>("webhookUrlInput");
const formatSelect = requireElement<HTMLSelectElement>("webhookFormatSelect");
const eventsBox = requireElement<HTMLElement>("webhookEvents");
const createButton = requireElement<HTMLButtonElement>("webhookCreateButton");
const list = requireElement<HTMLElement>("webhookList");
const status = requireElement<HTMLElement>("webhookStatus");

let loadedSiteId: string | undefined;
let webhooks: WebhookSummary[] = [];

export function bindWebhooks(): void {
  createButton.addEventListener("click", () => void createWebhook());
}

/** Shows the panel for space owners and reloads hooks when the space changes. */
export function renderWebhooksPanel(): void {
  const site = state.currentSite;
  const owner = site?.access?.role === "owner" && Boolean(state.cloudUser);
  section.hidden = !owner;
  createButton.disabled = state.busy || !owner || Boolean(site?.archived);
  if (!owner || !site) {
    loadedSiteId = undefined;
    return;
  }
  if (loadedSiteId === site.id) return;
  loadedSiteId = site.id;
  void refreshWebhooks();
}

async function refreshWebhooks(): Promise<void> {
  const siteId = loadedSiteId;
  if (!siteId) return;
  try {
    webhooks = (await fetchCloudJson<{ webhooks: WebhookSummary[] }>(`/api/sites/${encodeURIComponent(siteId)}/webhooks`)).webhooks;
  } catch (error) {
    webhooks = [];
    setPanelStatus(status, errorMessage(error), "error");
  }
  renderList();
}

function renderList(): void {
  list.textContent = "";
  if (webhooks.length === 0) {
    list.append(emptyState("No webhooks"));
    return;
  }
  for (const hook of webhooks) {
    const row = document.createElement("div");
    row.className = "collaboration-row";
    const copy = document.createElement("div");
    copy.className = "collaboration-copy";
    const title = document.createElement("strong");
    title.textContent = hook.url;
    const body = document.createElement("span");
    body.textContent = `${hook.format === "slack" ? "Slack · " : ""}${hook.events.join(", ")}`;
    const meta = document.createElement("span");
    meta.className = "history-meta";
    meta.textContent = `secret ${hook.secretPreview} · ${formatDate(hook.createdAt)}`;
    const deliveries = document.createElement("div");
    deliveries.className = "webhook-deliveries";
    copy.append(title, body, meta, deliveries);
    const actions = document.createElement("div");
    actions.className = "collaboration-actions";
    actions.append(
      actionButton("Deliveries", () => void showDeliveries(hook, deliveries), false, `Show deliveries for ${hook.url}`),
      actionButton("Delete", () => void deleteWebhook(hook), false, `Delete webhook ${hook.url}`),
    );
    row.append(copy, actions);
    list.append(row);
  }
}

async function createWebhook(): Promise<void> {
  const site = state.currentSite;
  if (!site) return;
  const events = [...eventsBox.querySelectorAll<HTMLInputElement>("input[type=checkbox]:checked")].map((input) => input.value);
  try {
    const created = await fetchCloudJson<WebhookSummary & { secret: string }>(`/api/sites/${encodeURIComponent(site.id)}/webhooks`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ url: urlInput.value.trim(), events, format: formatSelect.value }),
    });
    urlInput.value = "";
    setPanelStatus(status, `Webhook created. Signing secret (shown once): ${created.secret}`, "ok");
    await refreshWebhooks();
  } catch (error) {
    setPanelStatus(status, errorMessage(error), "error");
  }
}

async function deleteWebhook(hook: WebhookSummary): Promise<void> {
  const site = state.currentSite;
  if (!site || !window.confirm(`Delete the webhook to ${hook.url}?`)) return;
  try {
    await fetchCloudJson(`/api/sites/${encodeURIComponent(site.id)}/webhooks/${encodeURIComponent(hook.id)}`, { method: "DELETE" });
    setPanelStatus(status, "Webhook deleted", "ok");
    await refreshWebhooks();
  } catch (error) {
    setPanelStatus(status, errorMessage(error), "error");
  }
}

async function showDeliveries(hook: WebhookSummary, container: HTMLElement): Promise<void> {
  const site = state.currentSite;
  if (!site) return;
  try {
    const response = await fetchCloudJson<{ deliveries: DeliverySummary[] }>(`/api/sites/${encodeURIComponent(site.id)}/webhooks/${encodeURIComponent(hook.id)}/deliveries?limit=10`);
    container.textContent = "";
    if (response.deliveries.length === 0) container.append(emptyState("No deliveries yet"));
    for (const delivery of response.deliveries) {
      const line = document.createElement("div");
      line.className = `webhook-delivery webhook-delivery-${delivery.status}`;
      line.textContent = `${delivery.event} · ${delivery.status}${delivery.responseStatus ? ` · HTTP ${delivery.responseStatus}` : ""} · ${delivery.attempts} attempt${delivery.attempts === 1 ? "" : "s"}${delivery.lastError && delivery.status !== "delivered" ? ` · ${delivery.lastError}` : ""}`;
      container.append(line);
    }
  } catch (error) {
    setPanelStatus(status, errorMessage(error), "error");
  }
}

function requireElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing #${id}`);
  return element as T;
}
