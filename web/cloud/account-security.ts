/**
 * Account → Security dialog: the signed-in user's personal access tokens (list, create with scopes and
 * expiry, show the secret once, revoke) and browser sessions (list, revoke one, sign out all others).
 */
import { fetchCloudJson } from "./api.js";
import { collaborationActions, collaborationRow } from "./collaboration.js";
import { state } from "./state.js";
import { actionButton, copyText, emptyState, errorMessage, formatDate, setPanelStatus } from "./util.js";

interface PersonalAccessToken {
  id: string;
  name: string;
  tokenPreview: string;
  scopes: string[];
  createdAt: string;
  expiresAt?: string;
  lastUsedAt?: string;
  revokedAt?: string;
  active: boolean;
}

interface BrowserSession {
  id: string;
  source: string;
  scopes: string[];
  createdAt: string;
  lastSeenAt: string;
  expiresAt: string;
  userAgent?: string;
  ip?: string;
  current: boolean;
}

const scopeDescriptions: Record<string, string> = {
  read: "read pages, spaces, and search",
  write: "create and edit content",
  admin: "manage users, tokens, and workspace settings",
};

const sourceLabels: Record<string, string> = {
  register: "Registration",
  user_token: "User token sign-in",
  pat: "Access token sign-in",
  sso: "Single sign-on",
};

const dialog = requireElement<HTMLDialogElement>("accountSecurityDialog");
const tokenList = requireElement<HTMLElement>("securityTokenList");
const tokenForm = requireElement<HTMLFormElement>("securityTokenForm");
const tokenName = requireElement<HTMLInputElement>("securityTokenName");
const tokenScopes = requireElement<HTMLFieldSetElement>("securityTokenScopes");
const tokenExpiry = requireElement<HTMLSelectElement>("securityTokenExpiry");
const tokenCreateButton = requireElement<HTMLButtonElement>("securityTokenCreateButton");
const tokenSecret = requireElement<HTMLElement>("securityTokenSecret");
const tokenSecretValue = requireElement<HTMLInputElement>("securityTokenSecretValue");
const tokenCopyButton = requireElement<HTMLButtonElement>("securityTokenCopyButton");
const sessionList = requireElement<HTMLElement>("securitySessionList");
const revokeOthersButton = requireElement<HTMLButtonElement>("securityRevokeOthersButton");
const status = requireElement<HTMLElement>("securityStatus");
const closeButton = requireElement<HTMLButtonElement>("securityCloseButton");

const securityState: { tokens: PersonalAccessToken[]; sessions: BrowserSession[]; scopes: string[] } = { tokens: [], sessions: [], scopes: [] };

export function installAccountSecurity(): void {
  closeButton.addEventListener("click", () => dialog.close());
  dialog.addEventListener("close", () => {
    tokenSecretValue.value = "";
    tokenSecret.hidden = true;
  });
  tokenForm.addEventListener("submit", (event) => {
    event.preventDefault();
    void createToken();
  });
  tokenCopyButton.addEventListener("click", () => {
    if (tokenSecretValue.value) void copySecret();
  });
  revokeOthersButton.addEventListener("click", () => void revokeOtherSessions());
}

/** Opens the Security dialog and loads the current user's tokens and sessions. */
export async function openAccountSecurity(): Promise<void> {
  if (!state.cloudUser) return;
  tokenSecretValue.value = "";
  tokenSecret.hidden = true;
  tokenName.value = "";
  setPanelStatus(status, "Loading tokens and sessions", "warning");
  if (!dialog.open) dialog.showModal();
  await reload();
}

async function reload(): Promise<void> {
  try {
    const [session, tokens, sessions] = await Promise.all([
      fetchCloudJson<{ scopes?: string[] }>("/api/auth/session"),
      fetchCloudJson<{ tokens: PersonalAccessToken[] }>("/api/tokens?limit=200"),
      fetchCloudJson<{ sessions: BrowserSession[] }>("/api/auth/sessions?limit=200"),
    ]);
    securityState.scopes = session.scopes ?? [];
    securityState.tokens = tokens.tokens;
    securityState.sessions = sessions.sessions;
    renderScopeChoices();
    renderTokens();
    renderSessions();
    setPanelStatus(status, "", "ok");
  } catch (error) {
    setPanelStatus(status, errorMessage(error), "error");
  }
}

function renderScopeChoices(): void {
  const checked = new Set([...tokenScopes.querySelectorAll<HTMLInputElement>("input[data-scope]:checked")].map((input) => input.dataset.scope));
  for (const label of tokenScopes.querySelectorAll("label")) label.remove();
  for (const scope of securityState.scopes) {
    const id = `securityTokenScope_${scope}`;
    const label = document.createElement("label");
    label.className = "wiki-dialog-check";
    label.htmlFor = id;
    label.title = scopeDescriptions[scope] ?? scope;
    const input = document.createElement("input");
    input.type = "checkbox";
    input.id = id;
    input.dataset.scope = scope;
    input.checked = checked.size > 0 ? checked.has(scope) : scope === "read" || scope === "write";
    if (scope === "read") {
      input.checked = true;
      input.disabled = true;
    }
    label.append(input, document.createTextNode(` ${scope}`));
    tokenScopes.append(label);
  }
  tokenCreateButton.disabled = securityState.scopes.length === 0;
}

function renderTokens(): void {
  tokenList.textContent = "";
  const tokens = securityState.tokens.filter((token) => !token.revokedAt);
  if (tokens.length === 0) {
    tokenList.append(emptyState("No personal access tokens"));
    return;
  }
  for (const token of tokens) {
    const expiry = token.expiresAt ? `${token.active ? "expires" : "expired"} ${formatDate(token.expiresAt)}` : "never expires";
    const row = collaborationRow(
      token.name,
      `${token.tokenPreview} · ${token.scopes.join(", ")}`,
      `created ${formatDate(token.createdAt)} · ${expiry} · ${token.lastUsedAt ? `last used ${formatDate(token.lastUsedAt)}` : "never used"}`,
    );
    row.dataset.tokenId = token.id;
    row.dataset.state = token.active ? "ok" : "warning";
    const actions = collaborationActions();
    actions.append(actionButton("Revoke", () => void revokeToken(token), false, `Revoke token ${token.name}`));
    row.append(actions);
    tokenList.append(row);
  }
}

function renderSessions(): void {
  sessionList.textContent = "";
  revokeOthersButton.disabled = !securityState.sessions.some((session) => !session.current);
  if (securityState.sessions.length === 0) {
    sessionList.append(emptyState("No browser sessions"));
    return;
  }
  for (const session of securityState.sessions) {
    const row = collaborationRow(
      `${sourceLabels[session.source] ?? session.source}${session.current ? " · this browser" : ""}`,
      session.userAgent || "Unknown browser",
      `signed in ${formatDate(session.createdAt)} · last seen ${formatDate(session.lastSeenAt)}${session.ip ? ` · ${session.ip}` : ""}`,
    );
    row.dataset.sessionId = session.id;
    if (session.current) row.dataset.current = "true";
    if (!session.current) {
      const actions = collaborationActions();
      actions.append(actionButton("Revoke", () => void revokeSession(session), false, `Revoke session from ${formatDate(session.createdAt)}`));
      row.append(actions);
    }
    sessionList.append(row);
  }
}

async function createToken(): Promise<void> {
  const name = tokenName.value.trim();
  const scopes = [...tokenScopes.querySelectorAll<HTMLInputElement>("input[data-scope]:checked")].map((input) => input.dataset.scope!);
  if (!name) {
    setPanelStatus(status, "Name the token first", "error");
    return;
  }
  tokenCreateButton.disabled = true;
  try {
    const created = await fetchCloudJson<PersonalAccessToken & { token: string }>("/api/tokens", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name, scopes, ...(tokenExpiry.value ? { expiresInDays: Number(tokenExpiry.value) } : {}) }),
    });
    tokenSecretValue.value = created.token;
    tokenSecret.hidden = false;
    tokenName.value = "";
    const { token: _secret, ...listed } = created;
    securityState.tokens = [listed, ...securityState.tokens];
    renderTokens();
    tokenSecretValue.select();
    setPanelStatus(status, `Created token ${created.name}. Copy it now; it will not be shown again.`, "ok");
  } catch (error) {
    setPanelStatus(status, errorMessage(error), "error");
  } finally {
    tokenCreateButton.disabled = securityState.scopes.length === 0;
  }
}

async function copySecret(): Promise<void> {
  try {
    await copyText(tokenSecretValue.value, "Copied API token");
    setPanelStatus(status, "Token copied to the clipboard", "ok");
  } catch {
    tokenSecretValue.select();
    setPanelStatus(status, "Copy the selected token manually", "warning");
  }
}

async function revokeToken(token: PersonalAccessToken): Promise<void> {
  if (!window.confirm(`Revoke the token “${token.name}”? Scripts using it stop working immediately.`)) return;
  try {
    await fetchCloudJson(`/api/tokens/${encodeURIComponent(token.id)}`, { method: "DELETE" });
    securityState.tokens = securityState.tokens.filter((candidate) => candidate.id !== token.id);
    renderTokens();
    setPanelStatus(status, `Revoked token ${token.name}`, "ok");
  } catch (error) {
    setPanelStatus(status, errorMessage(error), "error");
  }
}

async function revokeSession(session: BrowserSession): Promise<void> {
  try {
    await fetchCloudJson(`/api/auth/sessions/${encodeURIComponent(session.id)}`, { method: "DELETE" });
    securityState.sessions = securityState.sessions.filter((candidate) => candidate.id !== session.id);
    renderSessions();
    setPanelStatus(status, "Session signed out", "ok");
  } catch (error) {
    setPanelStatus(status, errorMessage(error), "error");
  }
}

async function revokeOtherSessions(): Promise<void> {
  const others = securityState.sessions.filter((session) => !session.current);
  if (others.length === 0 || !window.confirm(`Sign out ${others.length} other session${others.length === 1 ? "" : "s"}?`)) return;
  revokeOthersButton.disabled = true;
  const failed: string[] = [];
  for (const session of others) {
    try {
      await fetchCloudJson(`/api/auth/sessions/${encodeURIComponent(session.id)}`, { method: "DELETE" });
    } catch (error) {
      failed.push(errorMessage(error));
    }
  }
  await reload();
  if (failed.length > 0) setPanelStatus(status, `${failed.length} session${failed.length === 1 ? "" : "s"} could not be signed out: ${failed[0]}`, "error");
  else setPanelStatus(status, `Signed out ${others.length} other session${others.length === 1 ? "" : "s"}`, "ok");
}

function requireElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing #${id}`);
  return element as T;
}
