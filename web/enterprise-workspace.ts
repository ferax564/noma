import { mountHostedCollab, type HostedCollab } from "./hosted-collab";

type Mode = "docs" | "visuals" | "work";

interface ShellActor {
  principalId: string;
  tenantId: string;
  kind: string;
  name: string;
}

interface ShellDocument {
  id: string;
  spaceId: string;
  title: string;
  lifecycle: string;
  classification: string;
  updatedAt: string;
  hash: string;
}

interface ShellArtifact {
  id: string;
  spaceId: string;
  title: string;
  draftRevision: number;
}

interface ShellProject {
  id: string;
  key: string;
  name: string;
  statuses: Array<{ id: string; name: string; category: string }>;
}

interface ShellIssue {
  id: string;
  projectId: string;
  key: string;
  summary: string;
  description: string | null;
  statusId: string;
  typeKey: string;
  estimate: number | null;
}

interface WorkspacePayload {
  actor: ShellActor;
  spaces: Array<{ id: string; name: string; classification: string }>;
  documents: ShellDocument[];
  artifacts: ShellArtifact[];
  projects: ShellProject[];
  issues: ShellIssue[];
  notifications: Array<Record<string, unknown>>;
}

interface ArtifactPayload {
  document: {
    id: string;
    title: string;
    revision: number;
    elements: Array<{
      id: string;
      type: string;
      text?: string;
      altText?: string;
      zIndex: number;
      geometry: { x: number; y: number; width: number; height: number; rotation?: number };
    }>;
  };
  outline: Array<{ id: string; type: string; label: string }>;
  html: string;
}

const STORAGE_KEY = "noma.enterprise.session.v1";
const params = new URLSearchParams(window.location.search);
let token = params.get("token") ?? localStorage.getItem(STORAGE_KEY) ?? "";
let mode: Mode = (params.get("mode") as Mode) || "docs";
let payload: WorkspacePayload | undefined;
let selectedDocumentId = params.get("documentId") ?? "";
let selectedArtifactId = "";
let selectedIssueId = "";
let collab: HostedCollab | undefined;

const $ = <T extends HTMLElement>(id: string): T => {
  const node = document.getElementById(id);
  if (!node) throw new Error(`missing #${id}`);
  return node as T;
};

const gate = $("login-gate");
const statusEl = $("session-status");
const railList = $("rail-list");
const inspector = $("inspector");
const searchResults = $("search-results");
const editorMount = $("editor");

function meta(name: string): string {
  return document.querySelector(`meta[name="${name}"]`)?.getAttribute("content") ?? "";
}

function setStatus(text: string, state: "connecting" | "ok" | "error" = "connecting"): void {
  statusEl.textContent = text;
  statusEl.dataset.state = state;
}

async function api<T>(path: string, init: RequestInit = {}): Promise<T> {
  const headers = new Headers(init.headers);
  if (token) headers.set("authorization", `Bearer ${token}`);
  if (init.body && !headers.has("content-type")) headers.set("content-type", "application/json");
  const response = await fetch(path, { ...init, headers });
  const text = await response.text();
  const body = text ? (JSON.parse(text) as T & { error?: string; message?: string }) : ({} as T);
  if (!response.ok) throw new Error((body as { message?: string }).message ?? (body as { error?: string }).error ?? response.statusText);
  return body;
}

function showGate(visible: boolean): void {
  gate.hidden = !visible;
}

function setMode(next: Mode): void {
  mode = next;
  for (const button of document.querySelectorAll<HTMLButtonElement>(".ew-modes button")) {
    button.setAttribute("aria-selected", String(button.dataset.mode === next));
  }
  for (const canvas of document.querySelectorAll<HTMLElement>(".ew-canvas")) {
    const active = canvas.dataset.mode === next;
    canvas.hidden = !active;
    canvas.classList.toggle("is-active", active);
  }
  $("rail-kicker").textContent = next === "docs" ? "Pages" : next === "visuals" ? "Canvases" : "Projects";
  renderRail();
  if (next === "docs") openDocument(selectedDocumentId || payload?.documents[0]?.id);
  if (next === "visuals") void openArtifact(selectedArtifactId || payload?.artifacts[0]?.id);
  if (next === "work") renderBoard();
}

function renderRail(): void {
  if (!payload) return;
  const spaceName = payload.spaces[0]?.name ?? "Workspace";
  $("rail-title").textContent = spaceName;
  if (mode === "docs") {
    railList.innerHTML = payload.documents
      .map(
        (doc) => `<button class="ew-rail-item" type="button" data-kind="document" data-id="${doc.id}" aria-current="${doc.id === selectedDocumentId}">
          <strong>${escapeHtml(doc.title)}</strong><small>${escapeHtml(doc.lifecycle)} · ${escapeHtml(doc.classification)}</small>
        </button>`,
      )
      .join("");
  } else if (mode === "visuals") {
    railList.innerHTML = payload.artifacts
      .map(
        (art) => `<button class="ew-rail-item" type="button" data-kind="artifact" data-id="${art.id}" aria-current="${art.id === selectedArtifactId}">
          <strong>${escapeHtml(art.title)}</strong><small>rev ${art.draftRevision}</small>
        </button>`,
      )
      .join("");
  } else {
    railList.innerHTML = payload.projects
      .map(
        (project) => `<button class="ew-rail-item" type="button" data-kind="project" data-id="${project.id}" aria-current="true">
          <strong>${escapeHtml(project.name)}</strong><small>${escapeHtml(project.key)}</small>
        </button>`,
      )
      .join("");
  }
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function nomaToEditorHtml(title: string, source: string): string {
  const stripped = source.replace(/^---[\s\S]*?---\n/, "").trim();
  const blocks = stripped.split(/\n{2,}/).map((block) => block.trim()).filter(Boolean);
  const body = blocks
    .map((block) => {
      const text = escapeHtml(block.replace(/^#{1,6}\s+/, "").replace(/^::\w+.*$/gm, "").trim());
      if (!text) return "";
      if (/^#\s+/.test(block)) return `<h1>${escapeHtml(block.replace(/^#\s+/, ""))}</h1>`;
      if (/^##\s+/.test(block)) return `<h2>${escapeHtml(block.replace(/^##\s+/, ""))}</h2>`;
      return `<p>${text}</p>`;
    })
    .filter(Boolean)
    .join("");
  return body || `<h1>${escapeHtml(title)}</h1><p></p>`;
}

function openDocument(id: string | undefined): void {
  if (!id || !payload) return;
  selectedDocumentId = id;
  const doc = payload.documents.find((item) => item.id === id);
  $("doc-title").textContent = doc?.title ?? "Untitled";
  $("doc-kicker").textContent = doc?.lifecycle ?? "Draft";
  inspector.innerHTML = `<div class="ew-meta"><strong>${escapeHtml(doc?.title ?? "")}</strong><span>Hash ${escapeHtml((doc?.hash ?? "").slice(0, 12))}</span><span>${escapeHtml(doc?.classification ?? "")}</span></div>`;
  $("inspector-title").textContent = "Document";
  renderRail();
  collab?.destroy();
  editorMount.replaceChildren();
  collab = mountHostedCollab({
    element: editorMount,
    token,
    documentId: id,
    onStatus: (text) => {
      $("collab-status").textContent = text;
      setStatus(`${payload?.actor.name ?? "Session"} · ${text}`, text.startsWith("ack") || text === "ready" ? "ok" : "connecting");
      if (text === "ready") void seedEmptyEditor(id, doc?.title ?? "Untitled");
    },
  });
}

async function seedEmptyEditor(id: string, title: string): Promise<void> {
  if ((collab?.getText() ?? "").trim()) return;
  const document = await api<{ title: string; source: string }>(`/v1/documents/${encodeURIComponent(id)}`);
  const editor = collab?.editor();
  if (!editor || (editor.getText() ?? "").trim()) return;
  editor.commands.setContent(nomaToEditorHtml(document.title || title, document.source));
}

async function openArtifact(id: string | undefined): Promise<void> {
  if (!id) return;
  selectedArtifactId = id;
  const data = await api<ArtifactPayload>(`/v1/artifacts/${encodeURIComponent(id)}`);
  $("visual-title").textContent = data.document.title;
  $("visual-stage").innerHTML = data.html;
  const page = $("visual-stage").querySelector(".pd-page");
  if (page instanceof HTMLElement) {
    const width = Math.max(page.offsetWidth, 960);
    const scale = Math.min(1, ($("visual-stage").clientWidth - 32) / width);
    page.style.transform = `scale(${scale})`;
    page.style.transformOrigin = "top left";
    page.style.marginBottom = `${Math.max(0, page.offsetHeight * (scale - 1))}px`;
  }
  $("visual-outline").innerHTML = data.outline
    .map((entry) => `<button type="button" data-frame="${escapeHtml(entry.id)}"><strong>${escapeHtml(entry.label)}</strong><small>${escapeHtml(entry.type)}</small></button>`)
    .join("");
  inspector.innerHTML = `<div class="ew-meta"><strong>${escapeHtml(data.document.title)}</strong><span>Revision ${data.document.revision}</span><span>${data.outline.length} frames</span></div>`;
  $("inspector-title").textContent = "Canvas";
  renderRail();
}

function renderBoard(): void {
  if (!payload) return;
  const project = payload.projects[0];
  $("work-title").textContent = project ? `${project.key} · ${project.name}` : "Work";
  const columns = (project?.statuses ?? []).filter((status) => status.id !== "cancelled");
  $("work-board").innerHTML = columns
    .map((status) => {
      const cards = payload!.issues.filter((issue) => issue.statusId === status.id && (!project || issue.projectId === project.id));
      return `<section class="ew-column" data-status="${escapeHtml(status.id)}">
        <h3>${escapeHtml(status.name)} · ${cards.length}</h3>
        ${cards
          .map(
            (issue) => `<button class="ew-card" type="button" data-issue="${issue.id}">
              <span class="ew-key">${escapeHtml(issue.key)}</span>
              <strong>${escapeHtml(issue.summary)}</strong>
              <span class="ew-pill">${escapeHtml(issue.typeKey)}</span>
            </button>`,
          )
          .join("")}
      </section>`;
    })
    .join("");
  $("inspector-title").textContent = "Board";
  inspector.innerHTML = `<div class="ew-meta"><strong>${payload.issues.length} issues</strong><span>${payload.notifications.length} notifications</span></div>`;
  renderRail();
}

function inspectIssue(id: string): void {
  if (!payload) return;
  selectedIssueId = id;
  const issue = payload.issues.find((item) => item.id === id);
  if (!issue) return;
  const project = payload.projects.find((item) => item.id === issue.projectId);
  const current = project?.statuses.find((status) => status.id === issue.statusId);
  const next = project?.statuses.find((status) => {
    const order = ["backlog", "todo", "in_progress", "in_review", "done"];
    return order.indexOf(status.id) === order.indexOf(issue.statusId) + 1;
  });
  inspector.innerHTML = `<div class="ew-meta">
      <span class="ew-key">${escapeHtml(issue.key)}</span>
      <strong>${escapeHtml(issue.summary)}</strong>
      <span>${escapeHtml(current?.name ?? issue.statusId)} · ${escapeHtml(issue.typeKey)}</span>
    </div>
    <div class="ew-actions">${next ? `<button type="button" id="advance-issue" data-to="${escapeHtml(next.id)}">Move to ${escapeHtml(next.name)}</button>` : ""}</div>`;
}

async function loadWorkspace(): Promise<void> {
  payload = await api<WorkspacePayload>("/v1/workspace");
  setStatus(`${payload.actor.name} · ${payload.actor.kind}`, "ok");
  showGate(false);
  setMode(mode);
}

async function signIn(tenantId: string, idToken: string): Promise<void> {
  const session = await api<{ token: string }>("/v1/session", {
    method: "POST",
    body: JSON.stringify({ tenantId, idToken }),
  });
  token = session.token;
  localStorage.setItem(STORAGE_KEY, token);
  await loadWorkspace();
}

document.querySelectorAll<HTMLButtonElement>(".ew-modes button").forEach((button) => {
  button.addEventListener("click", () => setMode((button.dataset.mode as Mode) ?? "docs"));
});

railList.addEventListener("click", (event) => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>("button[data-kind]");
  if (!button) return;
  if (button.dataset.kind === "document") openDocument(button.dataset.id);
  if (button.dataset.kind === "artifact") void openArtifact(button.dataset.id);
});

$("work-board").addEventListener("click", (event) => {
  const card = (event.target as HTMLElement).closest<HTMLButtonElement>("button[data-issue]");
  if (card?.dataset.issue) inspectIssue(card.dataset.issue);
});

inspector.addEventListener("click", async (event) => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>("#advance-issue");
  if (!button || !selectedIssueId) return;
  const to = button.dataset.to ?? "";
  await api(`/v1/issues/${encodeURIComponent(selectedIssueId)}/transition`, {
    method: "POST",
    body: JSON.stringify({ to, fields: to === "done" ? { resolution: "completed" } : {} }),
  });
  payload = await api<WorkspacePayload>("/v1/workspace");
  renderBoard();
  inspectIssue(selectedIssueId);
});

$("visual-outline").addEventListener("click", (event) => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>("button[data-frame]");
  const id = button?.dataset.frame;
  if (!id) return;
  for (const node of document.querySelectorAll(".pd-el")) node.classList.toggle("is-selected", node.getAttribute("data-id") === id);
});

$("workspace-search").addEventListener("input", async (event) => {
  const query = (event.target as HTMLInputElement).value.trim();
  if (!query) {
    searchResults.hidden = true;
    searchResults.replaceChildren();
    return;
  }
  const result = await api<{ hits: Array<{ title: string; resourceKind: string; resourceId: string; excerpt: string }> }>(
    `/v1/search?q=${encodeURIComponent(query)}`,
  );
  searchResults.hidden = false;
  searchResults.innerHTML = result.hits
    .map(
      (hit) => `<button class="ew-hit" type="button" data-kind="${escapeHtml(hit.resourceKind)}" data-id="${escapeHtml(hit.resourceId)}">
        <strong>${escapeHtml(hit.title)}</strong><small>${escapeHtml(hit.excerpt)}</small>
      </button>`,
    )
    .join("") || `<div class="ew-meta">No matches</div>`;
});

searchResults.addEventListener("click", (event) => {
  const hit = (event.target as HTMLElement).closest<HTMLButtonElement>("button.ew-hit");
  if (!hit) return;
  if (hit.dataset.kind === "document") {
    setMode("docs");
    openDocument(hit.dataset.id);
  }
});

$("theme-toggle").addEventListener("click", () => {
  const dark = document.documentElement.getAttribute("data-theme") === "dark";
  document.documentElement.setAttribute("data-theme", dark ? "light" : "dark");
  $("theme-toggle").setAttribute("aria-pressed", String(!dark));
  $("theme-toggle").textContent = dark ? "Dark" : "Light";
});

document.querySelectorAll<HTMLButtonElement>("#doc-toolbar [data-cmd]").forEach((button) => {
  button.addEventListener("click", () => {
    const editor = collab?.editor();
    if (!editor) return;
    const cmd = button.dataset.cmd;
    const chain = editor.chain().focus();
    if (cmd === "bold") chain.toggleBold().run();
    if (cmd === "italic") chain.toggleItalic().run();
    if (cmd === "strike") chain.toggleStrike().run();
    if (cmd === "heading") chain.toggleHeading({ level: button.dataset.level === "1" ? 1 : 2 }).run();
    if (cmd === "bullet") chain.toggleBulletList().run();
    if (cmd === "ordered") chain.toggleOrderedList().run();
  });
});

$("login-submit").addEventListener("click", () => {
  void signIn($<HTMLInputElement>("login-tenant").value.trim(), $<HTMLInputElement>("login-token").value.trim()).catch((error: unknown) => {
    $("login-error").textContent = error instanceof Error ? error.message : String(error);
  });
});

$("login-demo").addEventListener("click", () => {
  void signIn(meta("noma-tenant-id") || $<HTMLInputElement>("login-tenant").value.trim(), meta("noma-demo-user") || "alice").catch(
    (error: unknown) => {
      $("login-error").textContent = error instanceof Error ? error.message : String(error);
    },
  );
});

Object.assign(window, {
  nomaWorkspace: {
    ready: () => Boolean(payload),
    mode: () => mode,
    setMode,
    text: () => collab?.getText() ?? "",
  },
});

window.addEventListener("pointermove", (event) => {
  const x = `${Math.round((event.clientX / Math.max(window.innerWidth, 1)) * 100)}%`;
  const y = `${Math.round((event.clientY / Math.max(window.innerHeight, 1)) * 100)}%`;
  document.documentElement.style.setProperty("--mx", x);
  document.documentElement.style.setProperty("--my", y);
});

if (token) {
  void loadWorkspace().catch(() => {
    localStorage.removeItem(STORAGE_KEY);
    token = "";
    showGate(true);
    setStatus("Sign in", "error");
  });
} else {
  const tenant = meta("noma-tenant-id");
  const demoUser = meta("noma-demo-user");
  $<HTMLInputElement>("login-tenant").value = tenant;
  $<HTMLInputElement>("login-token").value = demoUser;
  if (tenant && demoUser && params.get("autologin") !== "0") {
    void signIn(tenant, demoUser).catch(() => {
      showGate(true);
      setStatus("Sign in", "error");
    });
  } else {
    showGate(true);
    setStatus("Sign in", "error");
  }
}
