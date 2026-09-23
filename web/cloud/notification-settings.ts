/** Notification settings: email address, per-type channel (in-app / email / off), and digest frequency. */
import { fetchCloudJson } from "./api.js";
import { state } from "./state.js";
import { errorMessage, setPanelStatus } from "./util.js";

interface Preferences {
  channels: Record<string, "in_app" | "email" | "off">;
  digest: "off" | "daily" | "weekly";
  email: string | null;
  types: string[];
}

const typeLabels: Record<string, string> = {
  mention: "Mentions",
  comment: "Comments on my pages",
  approval_requested: "Approval requests",
  approval_updated: "Approval updates",
  page_updated: "Watched page edits",
  task_assigned: "Tasks assigned to me",
};

const details = requireElement<HTMLDetailsElement>("notificationSettings");
const emailInput = requireElement<HTMLInputElement>("notificationEmailInput");
const channelList = requireElement<HTMLElement>("notificationChannelList");
const digestSelect = requireElement<HTMLSelectElement>("notificationDigestSelect");
const saveButton = requireElement<HTMLButtonElement>("notificationSettingsSaveButton");
const status = requireElement<HTMLElement>("notificationSettingsStatus");

export function bindNotificationSettings(): void {
  details.addEventListener("toggle", () => {
    if (details.open) void loadPreferences();
  });
  saveButton.addEventListener("click", () => void savePreferences());
}

async function loadPreferences(): Promise<void> {
  if (!state.cloudUser) {
    setPanelStatus(status, "Sign in to change notification settings", "warning");
    return;
  }
  try {
    const preferences = await fetchCloudJson<Preferences>("/api/users/me/preferences");
    emailInput.value = preferences.email ?? "";
    digestSelect.value = preferences.digest;
    channelList.textContent = "";
    for (const type of preferences.types) {
      const id = `notificationChannel_${type}`;
      const label = document.createElement("label");
      label.className = "notification-channel";
      label.htmlFor = id;
      label.textContent = typeLabels[type] ?? type;
      const select = document.createElement("select");
      select.id = id;
      select.dataset.type = type;
      select.append(new Option("In app", "in_app"), new Option("In app + email", "email"), new Option("Off", "off"));
      select.value = preferences.channels[type] ?? "in_app";
      label.append(select);
      channelList.append(label);
    }
    setPanelStatus(status, preferences.email ? "" : "Add an email address to receive email and digests", preferences.email ? "ok" : "warning");
  } catch (error) {
    setPanelStatus(status, errorMessage(error), "error");
  }
}

async function savePreferences(): Promise<void> {
  if (!state.cloudUser) return;
  const channels = Object.fromEntries([...channelList.querySelectorAll<HTMLSelectElement>("select[data-type]")].map((select) => [select.dataset.type!, select.value]));
  try {
    await fetchCloudJson("/api/users/me", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ email: emailInput.value.trim() || null }),
    });
    await fetchCloudJson("/api/users/me/preferences", {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ channels, digest: digestSelect.value }),
    });
    setPanelStatus(status, "Notification settings saved", "ok");
  } catch (error) {
    setPanelStatus(status, errorMessage(error), "error");
  }
}

function requireElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing #${id}`);
  return element as T;
}
