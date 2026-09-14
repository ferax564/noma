import { mountHostedCollab, type HostedCollab } from "./hosted-collab";

type Mode = "docs" | "visuals" | "work" | "admin";

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
  parentId: string | null;
  rank: string;
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
  assigneeId: string | null;
  parentId: string | null;
  rank: string;
  sprintId: string | null;
}

interface WorkspacePayload {
  actor: ShellActor;
  spaces: Array<{ id: string; name: string; classification: string }>;
  documents: ShellDocument[];
  artifacts: ShellArtifact[];
  projects: ShellProject[];
  issues: ShellIssue[];
  notifications: Array<{ id: string; title: string; body: string; resource_kind?: string; resource_id?: string; read_at?: string | null }>;
  principals: Array<{ id: string; name: string; kind: string; email: string | null }>;
  boards: Array<{ id: string; projectId: string; name: string; kind: string }>;
  sprints: Array<{ id: string; boardId: string; name: string; goal: string | null; state: string }>;
  grants: Array<{ id: string; principalId: string; resourceKind: string; resourceId: string; role: string }>;
  issueTypes: Array<{ projectId: string; key: string; name: string; hierarchy: string }>;
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
let selectedProjectId = "";
let collab: HostedCollab | undefined;
let jqlFilterIds: string[] | undefined;
let draggingIssueId = "";

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
  const body = text ? (JSON.parse(text) as T & { error?: string; message?: string; field?: string; reported?: boolean }) : ({} as T);
  if (!response.ok) {
    const err = body as { message?: string; error?: string; field?: string; reported?: boolean };
    const error = new Error(err.message ?? err.error ?? response.statusText) as Error & { field?: string; reported?: boolean };
    error.field = err.field;
    error.reported = err.reported;
    throw error;
  }
  return body;
}

function showGate(visible: boolean): void {
  gate.hidden = !visible;
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function currentProject(): ShellProject | undefined {
  return payload?.projects.find((project) => project.id === selectedProjectId) ?? payload?.projects[0];
}

function currentSpaceId(): string {
  return payload?.spaces[0]?.id ?? "";
}

function documentDepth(id: string, seen = new Set<string>()): number {
  const doc = payload?.documents.find((item) => item.id === id);
  if (!doc?.parentId || seen.has(id)) return 0;
  seen.add(id);
  return 1 + documentDepth(doc.parentId, seen);
}

function orderedDocuments(): ShellDocument[] {
  const docs = payload?.documents ?? [];
  const byParent = new Map<string, ShellDocument[]>();
  for (const doc of docs) {
    const key = doc.parentId ?? "";
    const list = byParent.get(key) ?? [];
    list.push(doc);
    byParent.set(key, list);
  }
  for (const list of byParent.values()) list.sort((a, b) => a.rank.localeCompare(b.rank) || a.title.localeCompare(b.title));
  const walk = (parentId: string): ShellDocument[] => (byParent.get(parentId) ?? []).flatMap((doc) => [doc, ...walk(doc.id)]);
  return walk("");
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
  $("rail-kicker").textContent = next === "docs" ? "Pages" : next === "visuals" ? "Canvases" : next === "work" ? "Projects" : "Admin";
  renderRail();
  if (next === "docs") openDocument(selectedDocumentId || payload?.documents[0]?.id);
  if (next === "visuals") void openArtifact(selectedArtifactId || payload?.artifacts[0]?.id);
  if (next === "work") renderBoard();
  if (next === "admin") renderAdmin();
}

function renderRail(): void {
  if (!payload) return;
  const spaceName = payload.spaces[0]?.name ?? "Workspace";
  $("rail-title").textContent = spaceName;
  const actions = $("rail-actions");
  if (mode === "docs") {
    actions.innerHTML = `<button type="button" id="create-page">New page</button><button type="button" id="import-page">Import</button>`;
    railList.innerHTML = orderedDocuments()
      .map((doc) => {
        const depth = Math.min(documentDepth(doc.id), 2);
        return `<button class="ew-rail-item" type="button" data-kind="document" data-id="${doc.id}" data-depth="${depth}" aria-current="${doc.id === selectedDocumentId}">
          <strong>${escapeHtml(doc.title)}</strong><small>${escapeHtml(doc.lifecycle)} · ${escapeHtml(doc.classification)}</small>
        </button>`;
      })
      .join("");
  } else if (mode === "visuals") {
    actions.replaceChildren();
    railList.innerHTML = payload.artifacts
      .map(
        (art) => `<button class="ew-rail-item" type="button" data-kind="artifact" data-id="${art.id}" aria-current="${art.id === selectedArtifactId}">
          <strong>${escapeHtml(art.title)}</strong><small>rev ${art.draftRevision}</small>
        </button>`,
      )
      .join("");
  } else if (mode === "work") {
    actions.innerHTML = `<button type="button" id="create-issue">New issue</button>`;
    railList.innerHTML = payload.projects
      .map(
        (project) => `<button class="ew-rail-item" type="button" data-kind="project" data-id="${project.id}" aria-current="${project.id === currentProject()?.id}">
          <strong>${escapeHtml(project.name)}</strong><small>${escapeHtml(project.key)}</small>
        </button>`,
      )
      .join("");
  } else {
    actions.replaceChildren();
    railList.innerHTML = payload.spaces
      .map(
        (space) => `<button class="ew-rail-item" type="button" data-kind="space" data-id="${space.id}">
          <strong>${escapeHtml(space.name)}</strong><small>${escapeHtml(space.classification)}</small>
        </button>`,
      )
      .join("");
  }
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
  void renderDocumentInspector(id);
}

async function renderDocumentInspector(id: string): Promise<void> {
  const doc = payload?.documents.find((item) => item.id === id);
  const [comments, revisions, assets] = await Promise.all([
    api<{ comments: Array<{ id: string; body: string; authorName: string; createdAt: string }> }>(`/v1/documents/${encodeURIComponent(id)}/comments`),
    api<{ revisions: Array<{ revision: number; title: string; createdAt: string }> }>(`/v1/documents/${encodeURIComponent(id)}/revisions`),
    api<{ assets: Array<{ id: string; filename: string }> }>(`/v1/documents/${encodeURIComponent(id)}/assets`),
  ]);
  $("doc-comments").innerHTML =
    comments.comments
      .map((comment) => `<div class="ew-note"><strong>${escapeHtml(comment.authorName)}</strong><span>${escapeHtml(comment.body)}</span></div>`)
      .join("") || `<div class="ew-note">No comments yet</div>`;
  const parents = (payload?.documents ?? []).filter((item) => item.id !== id);
  inspector.innerHTML = `<div class="ew-meta"><strong>${escapeHtml(doc?.title ?? "")}</strong><span>Hash ${escapeHtml((doc?.hash ?? "").slice(0, 12))}</span><span>${escapeHtml(doc?.classification ?? "")}</span></div>
    <label for="rename-page">Title<input id="rename-page" value="${escapeHtml(doc?.title ?? "")}" /></label>
    <label for="move-page">Parent
      <select id="move-page">
        <option value="">Space root</option>
        ${parents.map((item) => `<option value="${item.id}" ${item.id === doc?.parentId ? "selected" : ""}>${escapeHtml(item.title)}</option>`).join("")}
      </select>
    </label>
    <div class="ew-actions">
      <button type="button" id="save-page-meta">Save location</button>
      <label for="attach-file">Attach<input id="attach-file" type="file" /></label>
    </div>
    <div class="ew-meta"><strong>History</strong>${revisions.revisions.map((rev) => `<button type="button" data-restore="${rev.revision}">v${rev.revision} · ${escapeHtml(rev.title)}</button>`).join("") || "<span>No published revisions</span>"}</div>
    <div class="ew-meta"><strong>Attachments</strong>${assets.assets.map((asset) => `<span>${escapeHtml(asset.filename)}</span>`).join("") || "<span>None</span>"}</div>`;
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

function renderSprintBar(): void {
  if (!payload) return;
  const project = currentProject();
  const boards = payload.boards.filter((board) => !project || board.projectId === project.id);
  const board = boards[0];
  const sprints = payload.sprints.filter((sprint) => !board || sprint.boardId === board.id);
  const active = sprints.find((sprint) => sprint.state === "active");
  $("sprint-bar").innerHTML = `
    <span>${escapeHtml(active ? `${active.name} · ${active.state}` : "No active sprint")}</span>
    ${board && !active ? `<button type="button" id="create-sprint" data-board="${board.id}">Plan sprint</button>` : ""}
    ${active ? `<button type="button" id="close-sprint" data-sprint="${active.id}">Close sprint</button>` : ""}
    ${board && sprints.some((sprint) => sprint.state === "planned") ? `<button type="button" id="start-sprint" data-sprint="${sprints.find((sprint) => sprint.state === "planned")?.id ?? ""}">Start sprint</button>` : ""}
  `;
}

function renderBoard(): void {
  if (!payload) return;
  const project = currentProject();
  selectedProjectId = project?.id ?? "";
  $("work-title").textContent = project ? `${project.key} · ${project.name}` : "Work";
  renderSprintBar();
  const columns = (project?.statuses ?? []).filter((status) => status.id !== "cancelled");
  const visible = payload.issues.filter((issue) => (!project || issue.projectId === project.id) && (!jqlFilterIds || jqlFilterIds.includes(issue.id)));
  $("work-board").innerHTML = columns
    .map((status) => {
      const cards = visible.filter((issue) => issue.statusId === status.id);
      return `<section class="ew-column" data-status="${escapeHtml(status.id)}">
        <h3>${escapeHtml(status.name)} · ${cards.length}</h3>
        ${cards
          .map(
            (issue) => `<button class="ew-card" type="button" draggable="true" data-issue="${issue.id}">
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
  inspector.innerHTML = `<div class="ew-meta"><strong>${visible.length} issues</strong><span>${payload.notifications.length} notifications</span></div>
    <label for="new-issue-summary">Create issue
      <input id="new-issue-summary" placeholder="Summary" />
    </label>
    <label for="new-issue-type">Type
      <select id="new-issue-type">${(payload.issueTypes.filter((type) => type.projectId === project?.id)).map((type) => `<option value="${escapeHtml(type.key)}">${escapeHtml(type.name)}</option>`).join("")}</select>
    </label>
    <div class="ew-actions"><button type="button" id="submit-issue">Create</button></div>`;
  renderRail();
}

async function inspectIssue(id: string): Promise<void> {
  if (!payload) return;
  selectedIssueId = id;
  const issue = payload.issues.find((item) => item.id === id);
  if (!issue) return;
  const detail = await api<{
    summary: string;
    description: string | null;
    assignee_id: string | null;
    parent_id: string | null;
    sprint_id: string | null;
    comments: Array<{ id: string; body: string; authorName: string }>;
    worklogs: Array<{ id: string; durationSeconds: number; note: string | null; authorName: string }>;
    transitions: Array<{ id: string; to: string; requiredFields: string[] }>;
    typeKey: string;
    key?: string;
    status_id: string;
  }>(`/v1/issues/${encodeURIComponent(id)}`);
  const project = payload.projects.find((item) => item.id === issue.projectId);
  const current = project?.statuses.find((status) => status.id === issue.statusId);
  const next = project?.statuses.find((status) => {
    const order = ["backlog", "todo", "in_progress", "in_review", "done"];
    return order.indexOf(status.id) === order.indexOf(issue.statusId) + 1;
  });
  const people = payload.principals.map((person) => `<option value="${person.id}" ${person.id === detail.assignee_id ? "selected" : ""}>${escapeHtml(person.name)}</option>`).join("");
  const sprints = payload.sprints.map((sprint) => `<option value="${sprint.id}" ${sprint.id === detail.sprint_id ? "selected" : ""}>${escapeHtml(sprint.name)}</option>`).join("");
  inspector.innerHTML = `<div class="ew-meta">
      <span class="ew-key">${escapeHtml(issue.key)}</span>
      <strong>${escapeHtml(detail.summary)}</strong>
      <span>${escapeHtml(current?.name ?? issue.statusId)} · ${escapeHtml(detail.typeKey)}</span>
    </div>
    <label for="issue-summary">Summary<input id="issue-summary" value="${escapeHtml(detail.summary)}" /></label>
    <label for="issue-description">Description<textarea id="issue-description" rows="3">${escapeHtml(detail.description ?? "")}</textarea></label>
    <label for="issue-assignee">Assignee<select id="issue-assignee"><option value="">Unassigned</option>${people}</select></label>
    <label for="issue-sprint">Sprint<select id="issue-sprint"><option value="">Backlog</option>${sprints}</select></label>
    <div class="ew-actions">
      <button type="button" id="save-issue">Save</button>
      ${next ? `<button type="button" id="advance-issue" data-to="${escapeHtml(next.id)}">Move to ${escapeHtml(next.name)}</button>` : ""}
      ${detail.transitions.map((item) => `<button type="button" class="ew-transition" data-to="${escapeHtml(item.to)}" data-fields="${escapeHtml(item.requiredFields.join(","))}">${escapeHtml(item.to)}</button>`).join("")}
    </div>
    <div class="ew-meta"><strong>Comments</strong>${detail.comments.map((comment) => `<span>${escapeHtml(comment.authorName)}: ${escapeHtml(comment.body)}</span>`).join("") || "<span>None</span>"}</div>
    <label for="issue-comment">Comment<textarea id="issue-comment" rows="2"></textarea></label>
    <button type="button" id="issue-comment-submit">Comment</button>
    <div class="ew-meta"><strong>Worklog</strong>${detail.worklogs.map((log) => `<span>${escapeHtml(log.authorName)} · ${Math.round(log.durationSeconds / 60)}m ${escapeHtml(log.note ?? "")}</span>`).join("") || "<span>None</span>"}</div>
    <label for="worklog-minutes">Minutes<input id="worklog-minutes" type="number" min="1" value="30" /></label>
    <label for="worklog-note">Note<input id="worklog-note" /></label>
    <button type="button" id="worklog-submit">Log work</button>`;
}

function renderAdmin(): void {
  if (!payload) return;
  $("inspector-title").textContent = "Admin";
  inspector.innerHTML = `<div class="ew-meta"><strong>${payload.principals.length} people</strong><span>${payload.grants.length} grants</span></div>`;
  $("admin-panel").innerHTML = `
    <section>
      <h2>Create space</h2>
      <div class="ew-form-row">
        <input id="admin-space-name" placeholder="Space name" />
        <button type="button" id="admin-space-submit">Create space</button>
      </div>
    </section>
    <section>
      <h2>Create project</h2>
      <div class="ew-form-row">
        <input id="admin-project-key" placeholder="KEY" />
        <input id="admin-project-name" placeholder="Name" />
        <button type="button" id="admin-project-submit">Create project</button>
      </div>
    </section>
    <section>
      <h2>Grant</h2>
      <div class="ew-form-row">
        <select id="admin-grant-principal">${payload.principals.map((person) => `<option value="${person.id}">${escapeHtml(person.name)}</option>`).join("")}</select>
        <select id="admin-grant-kind"><option value="space">space</option><option value="project">project</option><option value="document">document</option></select>
        <input id="admin-grant-resource" placeholder="Resource id" />
        <select id="admin-grant-role"><option value="viewer">viewer</option><option value="editor">editor</option><option value="owner">owner</option></select>
        <button type="button" id="admin-grant-submit">Grant</button>
      </div>
    </section>
    <section>
      <h2>Grants</h2>
      ${payload.grants.map((grant) => `<div class="ew-note">${escapeHtml(grant.role)} on ${escapeHtml(grant.resourceKind)} ${escapeHtml(grant.resourceId)}</div>`).join("") || `<div class="ew-note">None listed</div>`}
    </section>`;
}

function renderNotifications(): void {
  const items = payload?.notifications ?? [];
  $("notify-list").innerHTML =
    items
      .map(
        (item) => `<button class="ew-hit" type="button" data-notification="${escapeHtml(item.id)}" data-kind="${escapeHtml(item.resource_kind ?? "")}" data-id="${escapeHtml(item.resource_id ?? "")}">
          <strong>${escapeHtml(item.title)}</strong><small>${escapeHtml(item.body)}</small>
        </button>`,
      )
      .join("") || `<div class="ew-note">Inbox empty</div>`;
  $("notify-toggle").textContent = items.length ? `Inbox (${items.length})` : "Inbox";
}

async function refreshWorkspace(): Promise<void> {
  payload = await api<WorkspacePayload>("/v1/workspace");
  renderNotifications();
}

async function loadWorkspace(): Promise<void> {
  await refreshWorkspace();
  setStatus(`${payload!.actor.name} · ${payload!.actor.kind}`, "ok");
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
  if (button.dataset.kind === "project") {
    selectedProjectId = button.dataset.id ?? "";
    renderBoard();
  }
});

$("rail-actions").addEventListener("click", async (event) => {
  const target = event.target as HTMLElement;
  if (target.id === "create-page") {
    const title = window.prompt("Page title", "New page");
    if (!title || !payload) return;
    const created = await api<{ id: string }>("/v1/documents", {
      method: "POST",
      body: JSON.stringify({ spaceId: currentSpaceId(), title, parentId: selectedDocumentId || undefined }),
    });
    await refreshWorkspace();
    setMode("docs");
    openDocument(created.id);
  }
  if (target.id === "import-page") $("import-modal").hidden = false;
  if (target.id === "create-issue") {
    const summary = window.prompt("Issue summary");
    if (!summary || !currentProject()) return;
    await api(`/v1/projects/${encodeURIComponent(currentProject()!.id)}/issues`, {
      method: "POST",
      body: JSON.stringify({ summary, typeKey: "task" }),
    });
    await refreshWorkspace();
    renderBoard();
  }
});

$("work-board").addEventListener("click", (event) => {
  const card = (event.target as HTMLElement).closest<HTMLButtonElement>("button[data-issue]");
  if (card?.dataset.issue) void inspectIssue(card.dataset.issue);
});

$("work-board").addEventListener("dragstart", (event) => {
  const card = (event.target as HTMLElement).closest<HTMLButtonElement>("button[data-issue]");
  draggingIssueId = card?.dataset.issue ?? "";
});
$("work-board").addEventListener("dragover", (event) => event.preventDefault());
$("work-board").addEventListener("drop", async (event) => {
  event.preventDefault();
  const column = (event.target as HTMLElement).closest<HTMLElement>(".ew-column");
  const project = currentProject();
  if (!column || !draggingIssueId || !project || !payload) return;
  const ordered = [...payload.issues.filter((issue) => issue.projectId === project.id)].map((issue) => issue.id);
  const from = ordered.indexOf(draggingIssueId);
  const targetCard = (event.target as HTMLElement).closest<HTMLButtonElement>("button[data-issue]");
  const toId = targetCard?.dataset.issue;
  if (from >= 0 && toId) {
    ordered.splice(from, 1);
    const to = ordered.indexOf(toId);
    ordered.splice(to < 0 ? ordered.length : to, 0, draggingIssueId);
    await api(`/v1/projects/${encodeURIComponent(project.id)}/rank`, { method: "POST", body: JSON.stringify({ orderedIds: ordered }) });
    await refreshWorkspace();
    renderBoard();
  }
});

inspector.addEventListener("click", async (event) => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>("button");
  if (!button) return;
  try {
    if (button.id === "advance-issue" || button.classList.contains("ew-transition")) {
      if (!selectedIssueId) return;
      const to = button.dataset.to ?? "";
      const fields = (button.dataset.fields ?? "").split(",").filter(Boolean);
      const payloadFields: Record<string, unknown> = to === "done" || fields.includes("resolution") ? { resolution: "completed" } : {};
      if (fields.includes("decisionId")) payloadFields.decisionId = "ui";
      await api(`/v1/issues/${encodeURIComponent(selectedIssueId)}/transition`, { method: "POST", body: JSON.stringify({ to, fields: payloadFields }) });
      await refreshWorkspace();
      renderBoard();
      await inspectIssue(selectedIssueId);
    }
    if (button.id === "save-issue" && selectedIssueId) {
      await api(`/v1/issues/${encodeURIComponent(selectedIssueId)}`, {
        method: "PATCH",
        body: JSON.stringify({
          summary: $<HTMLInputElement>("issue-summary").value,
          description: $<HTMLTextAreaElement>("issue-description").value,
          assigneeId: $<HTMLSelectElement>("issue-assignee").value || null,
        }),
      });
      const sprintId = $<HTMLSelectElement>("issue-sprint").value || null;
      await api(`/v1/issues/${encodeURIComponent(selectedIssueId)}/sprint`, { method: "POST", body: JSON.stringify({ sprintId }) });
      await refreshWorkspace();
      await inspectIssue(selectedIssueId);
    }
    if (button.id === "issue-comment-submit" && selectedIssueId) {
      await api(`/v1/issues/${encodeURIComponent(selectedIssueId)}/comments`, {
        method: "POST",
        body: JSON.stringify({ body: $<HTMLTextAreaElement>("issue-comment").value }),
      });
      await inspectIssue(selectedIssueId);
    }
    if (button.id === "worklog-submit" && selectedIssueId) {
      await api(`/v1/issues/${encodeURIComponent(selectedIssueId)}/worklog`, {
        method: "POST",
        body: JSON.stringify({
          durationSeconds: Number($<HTMLInputElement>("worklog-minutes").value) * 60,
          note: $<HTMLInputElement>("worklog-note").value,
        }),
      });
      await inspectIssue(selectedIssueId);
    }
    if (button.id === "submit-issue" && currentProject()) {
      await api(`/v1/projects/${encodeURIComponent(currentProject()!.id)}/issues`, {
        method: "POST",
        body: JSON.stringify({
          summary: $<HTMLInputElement>("new-issue-summary").value,
          typeKey: $<HTMLSelectElement>("new-issue-type").value,
        }),
      });
      await refreshWorkspace();
      renderBoard();
    }
    if (button.id === "save-page-meta" && selectedDocumentId) {
      await api(`/v1/documents/${encodeURIComponent(selectedDocumentId)}`, {
        method: "PATCH",
        body: JSON.stringify({
          title: $<HTMLInputElement>("rename-page").value,
          parentId: $<HTMLSelectElement>("move-page").value || null,
        }),
      });
      await refreshWorkspace();
      openDocument(selectedDocumentId);
    }
    if (button.dataset.restore && selectedDocumentId) {
      await api(`/v1/documents/${encodeURIComponent(selectedDocumentId)}/revisions/${button.dataset.restore}/restore`, { method: "POST" });
      await refreshWorkspace();
      openDocument(selectedDocumentId);
    }
    if (button.id === "admin-space-submit") {
      await api("/v1/spaces", { method: "POST", body: JSON.stringify({ name: $<HTMLInputElement>("admin-space-name").value }) });
      await refreshWorkspace();
      renderAdmin();
    }
    if (button.id === "admin-project-submit") {
      await api("/v1/projects", {
        method: "POST",
        body: JSON.stringify({
          key: $<HTMLInputElement>("admin-project-key").value,
          name: $<HTMLInputElement>("admin-project-name").value,
          spaceId: currentSpaceId(),
        }),
      });
      await refreshWorkspace();
      renderAdmin();
    }
    if (button.id === "admin-grant-submit") {
      await api("/v1/grants", {
        method: "POST",
        body: JSON.stringify({
          principalId: $<HTMLSelectElement>("admin-grant-principal").value,
          resourceKind: $<HTMLSelectElement>("admin-grant-kind").value,
          resourceId: $<HTMLInputElement>("admin-grant-resource").value,
          role: $<HTMLSelectElement>("admin-grant-role").value,
        }),
      });
      await refreshWorkspace();
      renderAdmin();
    }
  } catch (error: unknown) {
    inspector.insertAdjacentHTML("beforeend", `<p class="ew-error">${escapeHtml(error instanceof Error ? error.message : String(error))}</p>`);
  }
});

inspector.addEventListener("change", async (event) => {
  const input = event.target as HTMLInputElement;
  if (input.id !== "attach-file" || !input.files?.[0] || !selectedDocumentId) return;
  const file = input.files[0];
  const contentBase64 = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result ?? "");
      resolve(result.slice(result.indexOf(",") + 1));
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
  await api(`/v1/documents/${encodeURIComponent(selectedDocumentId)}/assets`, {
    method: "POST",
    body: JSON.stringify({ filename: file.name, mime: file.type || "application/octet-stream", contentBase64 }),
  });
  await renderDocumentInspector(selectedDocumentId);
});

$("sprint-bar").addEventListener("click", async (event) => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>("button");
  if (!button) return;
  if (button.id === "create-sprint" && button.dataset.board) {
    const name = window.prompt("Sprint name", "Sprint");
    if (!name) return;
    await api(`/v1/boards/${encodeURIComponent(button.dataset.board)}/sprints`, { method: "POST", body: JSON.stringify({ name }) });
  }
  if (button.id === "start-sprint" && button.dataset.sprint) {
    await api(`/v1/sprints/${encodeURIComponent(button.dataset.sprint)}/start`, { method: "POST" });
  }
  if (button.id === "close-sprint" && button.dataset.sprint) {
    await api(`/v1/sprints/${encodeURIComponent(button.dataset.sprint)}/close`, { method: "POST", body: JSON.stringify({ carry: true }) });
  }
  await refreshWorkspace();
  renderBoard();
});

$("jql-input").addEventListener("change", async (event) => {
  const jql = (event.target as HTMLInputElement).value.trim();
  $("jql-error").textContent = "";
  const project = currentProject();
  if (!project) return;
  if (!jql) {
    jqlFilterIds = undefined;
    renderBoard();
    return;
  }
  try {
    const result = await api<{ issues: Array<{ id: string }> }>(`/v1/projects/${encodeURIComponent(project.id)}/issues?jql=${encodeURIComponent(jql)}`);
    jqlFilterIds = result.issues.map((issue) => issue.id);
    renderBoard();
  } catch (error: unknown) {
    const err = error as Error & { field?: string; reported?: boolean };
    $("jql-error").textContent = err.reported && err.field ? `Unsupported JQL field: ${err.field}` : err.message;
    jqlFilterIds = [];
    renderBoard();
  }
});

$("doc-publish").addEventListener("click", async () => {
  if (!selectedDocumentId) return;
  await api(`/v1/documents/${encodeURIComponent(selectedDocumentId)}/publish`, { method: "POST" });
  await refreshWorkspace();
  openDocument(selectedDocumentId);
});

$("doc-comment-submit").addEventListener("click", async () => {
  if (!selectedDocumentId) return;
  await api(`/v1/documents/${encodeURIComponent(selectedDocumentId)}/comments`, {
    method: "POST",
    body: JSON.stringify({ body: $<HTMLTextAreaElement>("doc-comment-input").value }),
  });
  $<HTMLTextAreaElement>("doc-comment-input").value = "";
  await refreshWorkspace();
  await renderDocumentInspector(selectedDocumentId);
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
  if (hit.dataset.kind === "issue") {
    setMode("work");
    void inspectIssue(hit.dataset.id ?? "");
  }
});

$("notify-toggle").addEventListener("click", () => {
  const drawer = $("notify-drawer");
  drawer.hidden = !drawer.hidden;
  $("notify-toggle").setAttribute("aria-expanded", String(!drawer.hidden));
  renderNotifications();
});
$("notify-close").addEventListener("click", () => {
  $("notify-drawer").hidden = true;
  $("notify-toggle").setAttribute("aria-expanded", "false");
});
$("notify-list").addEventListener("click", async (event) => {
  const hit = (event.target as HTMLElement).closest<HTMLButtonElement>("button.ew-hit");
  if (!hit) return;
  if (hit.dataset.notification) {
    await api(`/v1/notifications/${encodeURIComponent(hit.dataset.notification)}/read`, { method: "POST" });
  }
  if (hit.dataset.kind === "document") {
    setMode("docs");
    openDocument(hit.dataset.id);
  }
  if (hit.dataset.kind === "issue") {
    setMode("work");
    void inspectIssue(hit.dataset.id ?? "");
  }
  await refreshWorkspace();
  renderNotifications();
});

$("import-cancel").addEventListener("click", () => {
  $("import-modal").hidden = true;
});
$("import-submit").addEventListener("click", async () => {
  $("import-error").textContent = "";
  try {
    const result = await api<{ documentId: string; lossReport: Array<{ name: string }> }>("/v1/spaces/" + encodeURIComponent(currentSpaceId()) + "/import/confluence", {
      method: "POST",
      body: JSON.stringify({ title: $<HTMLInputElement>("import-title").value || "Imported page", xml: $<HTMLTextAreaElement>("import-xml").value }),
    });
    await refreshWorkspace();
    $("import-modal").hidden = true;
    setMode("docs");
    openDocument(result.documentId);
    inspector.insertAdjacentHTML(
      "beforeend",
      result.lossReport.length
        ? `<div class="ew-tree-loss">${result.lossReport.map((item) => `<div>Unsupported macro: ${escapeHtml(item.name)}</div>`).join("")}</div>`
        : `<div class="ew-note">Imported with no macro loss</div>`,
    );
  } catch (error: unknown) {
    $("import-error").textContent = error instanceof Error ? error.message : String(error);
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
