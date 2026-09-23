/** HTTP client for the Noma Cloud API (cookie session + CSRF header, share token, JSON errors). */
import { csrfHeaderName, currentCsrfToken, isMutatingMethod } from "./auth.js";
import { shareToken } from "./state.js";
import type { CloudErrorPayload } from "./types.js";

export class CloudRequestError extends Error {
  constructor(readonly status: number, message: string, readonly payload: CloudErrorPayload) {
    super(message);
    this.name = "CloudRequestError";
  }
}

export async function fetchCloudJson<T>(url: string, init?: RequestInit): Promise<T> {
  const headers = new Headers(init?.headers);
  headers.set("accept", "application/json");
  const csrf = currentCsrfToken();
  if (csrf && isMutatingMethod(init?.method)) headers.set(csrfHeaderName, csrf);
  if (shareToken) headers.set("x-noma-share-token", shareToken);
  const response = await fetch(url, {
    ...init,
    credentials: "same-origin",
    headers,
  });
  if (!response.ok) {
    let message = `${response.status} ${response.statusText}`;
    const text = await response.text();
    let payload: CloudErrorPayload = {};
    try {
      payload = JSON.parse(text) as CloudErrorPayload;
      if (payload.error) message = payload.error;
    } catch {
      if (text) message = text;
    }
    if (response.status === 401 && message.includes("Noma Cloud access token required")) {
      const next = `${window.location.pathname}${window.location.search}`;
      window.location.assign(`/login.html?next=${encodeURIComponent(next)}`);
    }
    throw new CloudRequestError(response.status, message, payload);
  }
  return response.json() as Promise<T>;
}
