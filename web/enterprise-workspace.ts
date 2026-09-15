import { mountHostedCollab, type HostedCollab } from "./hosted-collab";
import { nomaToEditorHtml } from "./noma-html";
import "@tiptap/extension-table";
import "@tiptap/extension-task-list";
import { bindIssueBoard, bindMentionBox, bindVisualStage, enhanceSelects, hydrateIcons, iconSvg, positionPopup, setCanvasZoom, syncCanvasArrows, statusPath, type BoardDrop } from "./ui-kit";

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
  priority: string;
  dueAt?: string | null;
  labels?: string[];
  reporterId?: string | null;
  flagged?: boolean;
  watching?: boolean;
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

interface ProjectReports {
  throughput: Array<{ day: string; completed: number }>;
  cycleTime: Array<{ issueId: string; hours: number; key: string; summary: string }>;
  cumulativeFlow: Array<{ at: string; todo: number; in_progress: number; done: number }>;
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
let selectedSpaceId = "";
let collab: HostedCollab | undefined;
let jqlFilterIds: string[] | undefined;
let searchPopupStop: (() => void) | undefined;
let boardDndStop: (() => void) | undefined;
let canvasStop: (() => void) | undefined;
let boardFilter: "all" | "mine" | "unassigned" | "overdue" | "flagged" | "watching" = "all";
let epicFilter = "";
let boardSearch = "";
let typeFilter = "";
let swimlanes = false;
let boardView: "board" | "list" | "reports" | "backlog" = "board";
let paletteIndex = 0;
let mentionStop: (() => void) | undefined;
let canvasHistory: Array<{ id: string; x: number; y: number; width: number; height: number }> = [];
let selectedCanvasId = "";
let stickyColor: "yellow" | "pink" | "green" | "blue" = "yellow";
let findMatches: Array<{ from: number; to: number }> = [];
let findIndex = 0;
let reportsToken = 0;
let exportTarget: "svg" | "png" | "pptx" = "svg";
let presenting = false;

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

function activeSprint(): { id: string; boardId: string; name: string; goal: string | null; state: string } | undefined {
  if (!payload) return undefined;
  const project = currentProject();
  const boards = payload.boards.filter((board) => !project || board.projectId === project.id);
  const board = boards[0];
  return payload.sprints.find((sprint) => sprint.state === "active" && (!board || sprint.boardId === board.id));
}

function currentSpaceId(): string {
  return selectedSpaceId || payload?.spaces[0]?.id || "";
}

function assetUrl(id: string): string {
  return `/v1/assets/${encodeURIComponent(id)}?token=${encodeURIComponent(token)}`;
}

function rewriteAssetHtml(html: string): string {
  return html.replace(/\/v1\/assets\/([^"'?\s]+)/g, (_match, id: string) => assetUrl(id));
}

const SPACE_COLORS = ["#1d7afc", "#e56910", "#6b5eae", "#1f845a", "#c9372c", "#8270db"];

function initials(name: string): string {
  const parts = name.trim().split(/\s+/).filter(Boolean);
  const letters = `${parts[0]?.[0] ?? ""}${parts[1]?.[0] ?? parts[0]?.[1] ?? ""}`;
  return (letters || "?").toUpperCase();
}

function avatarMarkup(name: string, size: "sm" | "lg" = "sm"): string {
  return `<span class="ew-avatar${size === "lg" ? " lg" : ""}" aria-hidden="true">${escapeHtml(initials(name))}</span>`;
}

function spaceColor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i += 1) hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  return SPACE_COLORS[hash % SPACE_COLORS.length] ?? "#1d7afc";
}

function pageIcon(): string {
  return iconSvg("FileText");
}

function boardIcon(): string {
  return iconSvg("Presentation");
}

function projectIcon(): string {
  return iconSvg("SquareKanban");
}

function formatWhen(value: string | undefined): string {
  if (!value) return "";
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return date.toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

function documentAncestors(id: string): ShellDocument[] {
  const chain: ShellDocument[] = [];
  let current = payload?.documents.find((doc) => doc.id === id);
  const seen = new Set<string>();
  while (current && !seen.has(current.id)) {
    chain.unshift(current);
    seen.add(current.id);
    current = current.parentId ? payload?.documents.find((doc) => doc.id === current?.parentId) : undefined;
  }
  return chain;
}

function setSessionAvatar(name: string): void {
  $("session-avatar").textContent = initials(name);
  $("comment-avatar").textContent = initials(name);
}

function renderCrumbs(doc: ShellDocument | undefined): void {
  const crumbs = $("doc-crumbs");
  if (!doc) {
    crumbs.replaceChildren();
    return;
  }
  const space = payload?.spaces.find((item) => item.id === doc.spaceId);
  const chain = documentAncestors(doc.id);
  crumbs.innerHTML = [
    `<span>${escapeHtml(space?.name ?? "Space")}</span>`,
    ...chain.map((item, index) =>
      index === chain.length - 1
        ? `<span>${escapeHtml(item.title)}</span>`
        : `<button type="button" data-kind="document" data-id="${item.id}">${escapeHtml(item.title)}</button>`,
    ),
  ].join("");
}

function presenceColor(id: string): string {
  const palette = ["#0C66E4", "#1F845A", "#B38600", "#C9372C", "#6E5DC6", "#E56910"];
  let hash = 0;
  for (let index = 0; index < id.length; index += 1) hash = (hash * 33 + id.charCodeAt(index)) >>> 0;
  return palette[hash % palette.length] ?? "#0C66E4";
}

function renderWordCount(counts?: { words: number; characters: number }): void {
  const node = document.getElementById("doc-count");
  if (!node) return;
  const next = counts ?? collab?.counts() ?? { words: 0, characters: 0 };
  node.textContent = `${next.words} words · ${next.characters} characters`;
}

function isOverdue(issue: ShellIssue): boolean {
  const due = (issue.dueAt ?? "").slice(0, 10);
  if (!due || issue.statusId === "done" || issue.statusId === "cancelled") return false;
  const today = new Date();
  const iso = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, "0")}-${String(today.getDate()).padStart(2, "0")}`;
  return due < iso;
}

function formatHours(hours: number): string {
  if (!Number.isFinite(hours) || hours < 1 / 60) return "< 1m";
  if (hours < 1) return `${Math.max(1, Math.round(hours * 60))}m`;
  if (hours < 24) return `${hours.toFixed(1)}h`;
  return `${(hours / 24).toFixed(1)}d`;
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const left = sorted[mid - 1] ?? sorted[mid] ?? 0;
  const right = sorted[mid] ?? left;
  return sorted.length % 2 === 0 ? (left + right) / 2 : right;
}

function sampleSeries<T>(points: T[], max = 36): T[] {
  if (points.length <= max) return points;
  const step = (points.length - 1) / (max - 1);
  return Array.from({ length: max }, (_, index) => points[Math.round(index * step)]!).filter(Boolean);
}

function barChartSvg(points: Array<{ label: string; value: number }>, ariaLabel: string): string {
  const width = 640;
  const height = 220;
  const pad = { l: 40, r: 12, t: 16, b: 40 };
  const innerW = width - pad.l - pad.r;
  const innerH = height - pad.t - pad.b;
  const max = Math.max(1, ...points.map((point) => point.value));
  const ticks = [0, 0.5, 1].map((frac) => {
    const value = Math.round(max * frac);
    const y = pad.t + innerH - (value / max) * innerH;
    return `<line class="ew-chart-axis" x1="${pad.l}" x2="${width - pad.r}" y1="${y.toFixed(1)}" y2="${y.toFixed(1)}" />
      <text class="ew-chart-label" x="${pad.l - 8}" y="${(y + 4).toFixed(1)}" text-anchor="end">${value}</text>`;
  });
  const bars =
    points.length === 0
      ? `<text class="ew-chart-label" x="${width / 2}" y="${pad.t + innerH / 2}" text-anchor="middle">No completions yet</text>`
      : points
          .map((point, index) => {
            const slots = Math.max(points.length, 6);
            const slot = innerW / slots;
            const barW = Math.min(48, slot * 0.62);
            const x = pad.l + index * slot + (slot - barW) / 2;
            const h = Math.max(2, (point.value / max) * innerH);
            const y = pad.t + innerH - h;
            const caption = point.label.length > 10 ? point.label.slice(5) : point.label;
            return `<rect class="ew-bar" x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barW.toFixed(1)}" height="${h.toFixed(1)}" rx="3">
              <title>${escapeHtml(point.label)}: ${point.value} completed</title>
            </rect>
            <text class="ew-chart-label" x="${(x + barW / 2).toFixed(1)}" y="${height - 14}" text-anchor="middle">${escapeHtml(caption)}</text>`;
          })
          .join("");
  return `<svg role="img" aria-label="${escapeHtml(ariaLabel)}" viewBox="0 0 ${width} ${height}" class="ew-chart">${ticks.join("")}${bars}</svg>`;
}

function stackedAreaSvg(
  points: Array<{ at: string; todo: number; in_progress: number; done: number }>,
  ariaLabel: string,
): string {
  const sampled = sampleSeries(points, 40);
  const width = 640;
  const height = 240;
  const pad = { l: 40, r: 12, t: 16, b: 36 };
  const innerW = width - pad.l - pad.r;
  const innerH = height - pad.t - pad.b;
  if (sampled.length === 0) {
    return `<svg role="img" aria-label="${escapeHtml(ariaLabel)}" viewBox="0 0 ${width} ${height}" class="ew-chart">
      <text class="ew-chart-label" x="${width / 2}" y="${height / 2}" text-anchor="middle">No workflow events yet</text>
    </svg>`;
  }
  const max = Math.max(1, ...sampled.map((point) => point.todo + point.in_progress + point.done));
  const last = sampled.length - 1;
  const xAt = (index: number) => pad.l + (last === 0 ? innerW / 2 : (index / last) * innerW);
  const yAt = (value: number) => pad.t + innerH - (value / max) * innerH;
  const area = (values: number[], className: string) => {
    const top = values.map((value, index) => `${index === 0 ? "M" : "L"}${xAt(index).toFixed(1)},${yAt(value).toFixed(1)}`).join(" ");
    return `<path class="${className}" d="${top} L${xAt(last).toFixed(1)},${yAt(0).toFixed(1)} L${xAt(0).toFixed(1)},${yAt(0).toFixed(1)} Z" />`;
  };
  const totals = sampled.map((point) => point.todo + point.in_progress + point.done);
  const progress = sampled.map((point) => point.done + point.in_progress);
  const done = sampled.map((point) => point.done);
  const firstLabel = sampled[0]?.at.slice(0, 10) ?? "";
  const lastLabel = sampled[last]?.at.slice(0, 10) ?? "";
  return `<svg role="img" aria-label="${escapeHtml(ariaLabel)}" viewBox="0 0 ${width} ${height}" class="ew-chart">
    ${area(totals, "ew-area-todo")}
    ${area(progress, "ew-area-progress")}
    ${area(done, "ew-area-done")}
    <text class="ew-chart-label" x="${pad.l}" y="${height - 12}">${escapeHtml(firstLabel)}</text>
    <text class="ew-chart-label" x="${width - pad.r}" y="${height - 12}" text-anchor="end">${escapeHtml(lastLabel)}</text>
  </svg>`;
}

function lineChartSvg(points: Array<{ label: string; value: number }>, ariaLabel: string): string {
  const width = 640;
  const height = 220;
  const pad = { l: 40, r: 12, t: 16, b: 36 };
  const innerW = width - pad.l - pad.r;
  const innerH = height - pad.t - pad.b;
  const sampled = sampleSeries(points, 48);
  if (sampled.length === 0) {
    return `<svg role="img" aria-label="${escapeHtml(ariaLabel)}" viewBox="0 0 ${width} ${height}" class="ew-chart">
      <text class="ew-chart-label" x="${width / 2}" y="${height / 2}" text-anchor="middle">No sprint remaining yet</text>
    </svg>`;
  }
  const max = Math.max(1, ...sampled.map((point) => point.value));
  const last = sampled.length - 1;
  const xAt = (index: number) => pad.l + (last === 0 ? innerW / 2 : (index / last) * innerW);
  const yAt = (value: number) => pad.t + innerH - (value / max) * innerH;
  const line = sampled.map((point, index) => `${index === 0 ? "M" : "L"}${xAt(index).toFixed(1)},${yAt(point.value).toFixed(1)}`).join(" ");
  const area = `${line} L${xAt(last).toFixed(1)},${yAt(0).toFixed(1)} L${xAt(0).toFixed(1)},${yAt(0).toFixed(1)} Z`;
  return `<svg role="img" aria-label="${escapeHtml(ariaLabel)}" viewBox="0 0 ${width} ${height}" class="ew-chart">
    <path class="ew-area-progress" d="${area}" />
    <path class="ew-line" d="${line}" fill="none" />
    <text class="ew-chart-label" x="${pad.l}" y="${height - 12}">${escapeHtml(sampled[0]?.label ?? "")}</text>
    <text class="ew-chart-label" x="${width - pad.r}" y="${height - 12}" text-anchor="end">${escapeHtml(sampled[last]?.label ?? "")}</text>
  </svg>`;
}

function reportKpis(reports: ProjectReports): { completed: number; medianCycle: string; inProgress: number } {
  const completed = reports.throughput.reduce((sum, point) => sum + point.completed, 0);
  const last = reports.cumulativeFlow[reports.cumulativeFlow.length - 1];
  return {
    completed,
    medianCycle: reports.cycleTime.length ? formatHours(median(reports.cycleTime.map((row) => row.hours))) : "—",
    inProgress: last?.in_progress ?? 0,
  };
}

function renderReportsMarkup(
  reports: ProjectReports,
  burndown: { name: string; points: Array<{ at: string; remaining: number }> } | undefined,
): string {
  const kpis = reportKpis(reports);
  const cycleRows =
    reports.cycleTime.length === 0
      ? `<p class="ew-meta">No completed issues yet.</p>`
      : reports.cycleTime
          .slice()
          .sort((a, b) => b.hours - a.hours)
          .map(
            (row) =>
              `<button type="button" class="ew-cycle-row" data-issue="${escapeHtml(row.issueId)}">
                <span class="ew-key">${escapeHtml(row.key)}</span>
                <strong>${escapeHtml(row.summary)}</strong>
                <span class="ew-cycle-hours">${escapeHtml(formatHours(row.hours))}</span>
              </button>`,
          )
          .join("");
  const burn =
    burndown && burndown.points.length
      ? `<article id="report-burndown" class="ew-report">
      <h2>${iconSvg("ChartColumn")} Burndown</h2>
      <p class="ew-report-lead">${escapeHtml(burndown.name)} remaining estimate.</p>
      ${lineChartSvg(
        burndown.points.map((point) => ({ label: point.at.slice(0, 10), value: point.remaining })),
        `${burndown.name} sprint burndown`,
      )}
    </article>`
      : `<article id="report-burndown" class="ew-report">
      <h2>${iconSvg("ChartColumn")} Burndown</h2>
      <p class="ew-report-lead">Start a sprint to plot remaining estimate.</p>
    </article>`;
  return `<div id="work-reports" class="ew-reports">
    <div id="report-kpis" class="ew-report-kpis">
      <div class="ew-kpi"><strong>${kpis.completed}</strong><span>Completed</span></div>
      <div class="ew-kpi"><strong>${escapeHtml(kpis.medianCycle)}</strong><span>Median cycle</span></div>
      <div class="ew-kpi"><strong>${kpis.inProgress}</strong><span>In progress</span></div>
    </div>
    ${burn}
    <article id="report-throughput" class="ew-report">
      <h2>${iconSvg("ChartColumn")} Throughput</h2>
      <p class="ew-report-lead">Issues moved to Done each day.</p>
      ${barChartSvg(
        reports.throughput.map((point) => ({ label: point.day, value: point.completed })),
        "Throughput completed per day",
      )}
    </article>
    <article id="report-cycle" class="ew-report">
      <h2>${iconSvg("ChartColumnStacked")} Cycle time</h2>
      <p class="ew-report-lead">Created to Done for each completed issue.</p>
      <div class="ew-cycle-list">${cycleRows}</div>
    </article>
    <article id="report-cfd" class="ew-report">
      <h2>${iconSvg("ChartColumnStacked")} Cumulative flow</h2>
      <p class="ew-report-lead">To do, in progress, and done over the project timeline.</p>
      ${stackedAreaSvg(reports.cumulativeFlow, "Cumulative flow of to do, in progress, and done issues")}
      <ul class="ew-legend" aria-hidden="true">
        <li><span class="ew-swatch-todo"></span> To do</li>
        <li><span class="ew-swatch-progress"></span> In progress</li>
        <li><span class="ew-swatch-done"></span> Done</li>
      </ul>
    </article>
  </div>`;
}

async function loadProjectReports(): Promise<void> {
  const project = currentProject();
  if (!project || boardView !== "reports") return;
  const token = ++reportsToken;
  const board = $("work-board");
  board.innerHTML = `<p class="ew-meta">Loading reports…</p>`;
  try {
    const reports = await api<ProjectReports>(`/v1/projects/${encodeURIComponent(project.id)}/reports`);
    if (token !== reportsToken || boardView !== "reports") return;
    const sprint = activeSprint();
    const burndown = sprint
      ? {
          name: sprint.name,
          points: (await api<{ points: Array<{ at: string; remaining: number }> }>(`/v1/sprints/${encodeURIComponent(sprint.id)}/burndown`)).points,
        }
      : undefined;
    if (token !== reportsToken || boardView !== "reports") return;
    board.innerHTML = renderReportsMarkup(reports, burndown);
    hydrateIcons(board);
    document.querySelector(".ew-body")?.classList.remove("is-issue");
    $("inspector-title").textContent = "Reports";
    const kpis = reportKpis(reports);
    inspector.innerHTML = `<div class="ew-meta">
        <strong>${escapeHtml(project.key)} reports</strong>
        <span>${kpis.completed} completed</span>
        <span>Median cycle ${escapeHtml(kpis.medianCycle)}</span>
        <span>${kpis.inProgress} in progress</span>
      </div>
      <p class="ew-report-lead">Throughput, cycle time, and cumulative flow come from issue events. Filters on the board do not change these charts.</p>`;
  } catch (error) {
    if (token !== reportsToken || boardView !== "reports") return;
    board.innerHTML = `<p class="ew-error" role="alert">${escapeHtml(error instanceof Error ? error.message : "Could not load reports")}</p>`;
  }
}

function stickyAlt(color: string): string {
  return color === "yellow" ? "Sticky" : `Sticky:${color}`;
}

function beginSelectionComment(quote: string): void {
  const box = $<HTMLTextAreaElement>("doc-comment-input");
  const chip = document.getElementById("doc-comment-quote");
  if (quote) {
    box.dataset.quote = quote;
    box.placeholder = `Comment on “${quote.slice(0, 72)}”`;
    if (chip) {
      chip.hidden = false;
      chip.textContent = quote;
    }
  }
  box.focus();
  $("doc-discussion").scrollIntoView({ block: "nearest" });
}

function closePageFind(): void {
  const bar = document.getElementById("page-find");
  if (bar) bar.hidden = true;
  findMatches = [];
  findIndex = 0;
}

function collectFindMatches(query: string): Array<{ from: number; to: number }> {
  const editor = collab?.editor();
  if (!editor || !query) return [];
  const needle = query.toLowerCase();
  const matches: Array<{ from: number; to: number }> = [];
  editor.state.doc.descendants((node, pos) => {
    if (!node.isText || !node.text) return;
    const hay = node.text.toLowerCase();
    let index = 0;
    while (index < hay.length) {
      const found = hay.indexOf(needle, index);
      if (found < 0) break;
      matches.push({ from: pos + found, to: pos + found + needle.length });
      index = found + Math.max(1, needle.length);
    }
  });
  return matches;
}

function jumpFind(delta = 0): number {
  const editor = collab?.editor();
  const count = document.getElementById("page-find-count");
  if (!editor || !findMatches.length) {
    if (count) count.textContent = "0 of 0";
    return 0;
  }
  findIndex = (findIndex + delta + findMatches.length) % findMatches.length;
  const match = findMatches[findIndex];
  if (match) {
    editor.chain().focus().setTextSelection({ from: match.from, to: match.to }).scrollIntoView().run();
  }
  if (count) count.textContent = `${findIndex + 1} of ${findMatches.length}`;
  return findMatches.length;
}

function runPageFind(query: string): number {
  const bar = document.getElementById("page-find");
  if (bar) bar.hidden = false;
  const input = document.getElementById("page-find-input");
  if (input instanceof HTMLInputElement && input.value !== query) input.value = query;
  const needle = query.trim();
  if (needle.length < 2) {
    findMatches = [];
    findIndex = 0;
    const count = document.getElementById("page-find-count");
    if (count) count.textContent = "0 of 0";
    return 0;
  }
  findMatches = collectFindMatches(needle);
  findIndex = 0;
  return jumpFind(0);
}

function openPageFind(): void {
  const bar = $("page-find");
  bar.hidden = false;
  const input = $<HTMLInputElement>("page-find-input");
  input.focus();
  input.select();
  if (input.value.trim()) runPageFind(input.value);
}

function renderPresence(users: Array<{ id: string; name: string; color: string }>): void {
  const node = document.getElementById("doc-presence");
  if (!node) return;
  const unique = [...new Map(users.map((user) => [user.id, user])).values()];
  node.innerHTML = unique
    .map(
      (user) =>
        `<span class="ew-avatar" title="${escapeHtml(user.name)}" style="background:${escapeHtml(user.color)}">${escapeHtml(initials(user.name))}</span>`,
    )
    .join("");
}

function renderByline(doc: ShellDocument | undefined): void {
  const actorName = payload?.actor.name ?? "Unknown";
  const when = formatWhen(doc?.updatedAt);
  $("doc-byline").innerHTML = `${avatarMarkup(actorName)}<span><strong>${escapeHtml(actorName)}</strong>${when ? ` · ${escapeHtml(when)}` : ""}</span>`;
}

async function fileToBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const result = String(reader.result ?? "");
      resolve(result.slice(result.indexOf(",") + 1));
    };
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(file);
  });
}

function linkHref(link: { provider: string; url?: string | null; targetKind?: string | null; targetId?: string | null }): string {
  if (link.url) return link.url;
  if (link.targetKind === "issue" && link.targetId) return `?mode=work&issue=${encodeURIComponent(link.targetId)}`;
  if (link.targetKind === "document" && link.targetId) return `?mode=docs&documentId=${encodeURIComponent(link.targetId)}`;
  return "#";
}

function linksMarkup(
  links: Array<{ id: string; provider: string; url?: string | null; label?: string; targetKind?: string | null; targetId?: string | null }>,
): string {
  if (!links.length) return `<div class="ew-note">No links yet</div>`;
  return links
    .map((link) => {
      const href = linkHref(link);
      const external = Boolean(link.url);
      return `<a class="ew-link" href="${escapeHtml(href)}" ${external ? `target="_blank" rel="noreferrer"` : ""} data-kind="${escapeHtml(link.targetKind ?? link.provider)}" data-id="${escapeHtml(link.targetId ?? "")}">${escapeHtml(link.provider)} · ${escapeHtml(link.label ?? link.url ?? link.id)}</a>`;
    })
    .join("");
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

function setPresenting(on: boolean): void {
  presenting = on;
  const shell = document.getElementById("workspace-shell");
  shell?.classList.toggle("is-presenting", on);
  const exit = document.getElementById("present-exit");
  if (exit) exit.hidden = !on;
  $("page-present")?.setAttribute("aria-pressed", String(on && mode === "docs"));
  $("canvas-present")?.setAttribute("aria-pressed", String(on && mode === "visuals"));
}

function setMode(next: Mode): void {
  if (presenting) setPresenting(false);
  mode = next;
  for (const button of document.querySelectorAll<HTMLButtonElement>(".ew-modes button")) {
    button.setAttribute("aria-selected", String(button.dataset.mode === next));
  }
  for (const canvas of document.querySelectorAll<HTMLElement>(".ew-canvas")) {
    const active = canvas.dataset.mode === next;
    canvas.hidden = !active;
    canvas.classList.toggle("is-active", active);
  }
  $("rail-kicker").textContent = next === "docs" ? "Content" : next === "visuals" ? "Whiteboards" : next === "work" ? "Projects" : "Admin";
  const section = document.getElementById("rail-section");
  if (section) section.textContent = next === "docs" ? "Pages" : next === "visuals" ? "Boards" : next === "work" ? "Projects" : "Spaces";
  if (next !== "work") document.querySelector(".ew-body")?.classList.remove("is-issue");
  if (next !== "visuals") $("visual-outline").replaceChildren();
  renderRail();
  if (next === "docs") openDocument(selectedDocumentId || payload?.documents[0]?.id);
  if (next === "visuals") void openArtifact(selectedArtifactId || payload?.artifacts[0]?.id);
  if (next === "work") renderBoard();
  if (next === "admin") renderAdmin();
}

function renderRail(): void {
  if (!payload) return;
  if (!selectedSpaceId) selectedSpaceId = payload.spaces[0]?.id ?? "";
  const spaceName = payload.spaces.find((space) => space.id === currentSpaceId())?.name ?? payload.spaces[0]?.name ?? "Workspace";
  $("rail-title").textContent = spaceName;
  const icon = $("rail-space-icon");
  icon.textContent = initials(spaceName).slice(0, 1);
  icon.style.background = spaceColor(spaceName);
  const actions = $("rail-actions");
  const spaceOptions = payload.spaces
    .map((space) => `<option value="${space.id}" ${space.id === currentSpaceId() ? "selected" : ""}>${escapeHtml(space.name)}</option>`)
    .join("");
  if (mode === "docs") {
    actions.innerHTML = `
      <label for="space-switch">Space<select id="space-switch">${spaceOptions}</select></label>
      <button type="button" id="create-page">${iconSvg("Plus")} Create page</button>
      <details class="ew-rail-more">
        <summary>${iconSvg("Settings")} Space tools</summary>
        <label for="new-page-title">Page title<input id="new-page-title" placeholder="Title" /></label>
        <label for="new-space-name">New space<input id="new-space-name" placeholder="Name" /></label>
        <button type="button" id="create-space">Create space</button>
        <button type="button" id="import-page">${iconSvg("Import")} Import</button>
      </details>`;
    railList.innerHTML = orderedDocuments()
      .filter((doc) => !currentSpaceId() || doc.spaceId === currentSpaceId())
      .map((doc) => {
        const depth = Math.min(documentDepth(doc.id), 2);
        return `<button class="ew-rail-item" type="button" data-kind="document" data-id="${doc.id}" data-depth="${depth}" aria-current="${doc.id === selectedDocumentId}">
          ${pageIcon()}<strong>${escapeHtml(doc.title)}</strong><small>${escapeHtml(doc.lifecycle)} · ${escapeHtml(doc.classification)}</small>
        </button>`;
      })
      .join("");
  } else if (mode === "visuals") {
    actions.innerHTML = `<label for="space-switch">Space<select id="space-switch">${spaceOptions}</select></label>`;
    railList.innerHTML = payload.artifacts
      .filter((art) => !currentSpaceId() || art.spaceId === currentSpaceId())
      .map(
        (art) => `<button class="ew-rail-item" type="button" data-kind="artifact" data-id="${art.id}" aria-current="${art.id === selectedArtifactId}">
          ${boardIcon()}<strong>${escapeHtml(art.title)}</strong><small>rev ${art.draftRevision}</small>
        </button>`,
      )
      .join("");
  } else if (mode === "work") {
    actions.innerHTML = `
      <label for="new-issue-rail-summary">Issue summary<input id="new-issue-rail-summary" placeholder="Summary" /></label>
      <button type="button" id="create-issue">Create issue</button>`;
    railList.innerHTML = payload.projects
      .map(
        (project) => `<button class="ew-rail-item" type="button" data-kind="project" data-id="${project.id}" aria-current="${project.id === currentProject()?.id}">
          ${projectIcon()}<strong>${escapeHtml(project.name)}</strong><small>${escapeHtml(project.key)}</small>
        </button>`,
      )
      .join("");
  } else {
    actions.replaceChildren();
    railList.innerHTML = payload.spaces
      .map(
        (space) => `<button class="ew-rail-item" type="button" data-kind="space" data-id="${space.id}" aria-current="${space.id === currentSpaceId()}">
          <span class="ew-space-icon" style="background:${spaceColor(space.name)}">${escapeHtml(initials(space.name).slice(0, 1))}</span>
          <strong>${escapeHtml(space.name)}</strong><small>${escapeHtml(space.classification)}</small>
        </button>`,
      )
      .join("");
  }
  hydrateIcons(actions);
  hydrateIcons(railList);
  enhanceSelects(actions);
}

function uniqueHits<T extends { resourceKind: string; resourceId: string }>(hits: T[]): T[] {
  const seen = new Set<string>();
  return hits.filter((hit) => {
    const key = `${hit.resourceKind}:${hit.resourceId}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function bindWorkspaceMentions(): void {
  mentionStop?.();
  const people = (payload?.principals ?? []).map((person) => ({ id: person.id, name: person.name }));
  const stops: Array<() => void> = [];
  for (const id of ["doc-comment-input", "issue-comment"]) {
    const box = document.getElementById(id);
    if (box instanceof HTMLTextAreaElement) stops.push(bindMentionBox(box, people));
  }
  mentionStop = () => {
    for (const stop of stops) stop();
  };
}

function openDocument(id: string | undefined): void {
  if (!id || !payload) return;
  selectedDocumentId = id;
  closePageFind();
  const doc = payload.documents.find((item) => item.id === id);
  $("doc-title").textContent = doc?.title ?? "Untitled";
  const kicker = $("doc-kicker");
  kicker.textContent = doc?.lifecycle ?? "Draft";
  kicker.classList.toggle("published", (doc?.lifecycle ?? "").toLowerCase() === "published");
  renderCrumbs(doc);
  renderByline(doc);
  $("inspector-title").textContent = "Page";
  renderRail();
  collab?.destroy();
  editorMount.replaceChildren();
  collab = mountHostedCollab({
    element: editorMount,
    token,
    documentId: id,
    user: payload?.actor
      ? { id: payload.actor.principalId, name: payload.actor.name, color: presenceColor(payload.actor.principalId) }
      : undefined,
    people: (payload?.principals ?? []).map((person) => ({ id: person.id, name: person.name })),
    onPresence: renderPresence,
    onUpdate: () => {
      renderPageToc();
      renderWordCount();
    },
    onCount: renderWordCount,
    onComment: beginSelectionComment,
    onStatus: (text) => {
      $("collab-status").textContent = text;
      setStatus(`${payload?.actor.name ?? "Session"} · ${text}`, text.startsWith("ack") || text === "ready" ? "ok" : "connecting");
      if (text === "ready") void seedEmptyEditor(id, doc?.title ?? "Untitled");
    },
  });
  void renderDocumentInspector(id);
}

function pageHeadings(): Array<{ text: string; level: number }> {
  const headings: Array<{ text: string; level: number }> = [];
  const editor = collab?.editor();
  editor?.state.doc.descendants((node) => {
    if (node.type.name === "heading") {
      const text = node.textContent.trim();
      if (text) headings.push({ text, level: Number(node.attrs.level ?? 1) });
    }
  });
  return headings.slice(0, 24);
}

function renderPageToc(): void {
  const toc = document.getElementById("page-toc");
  if (!toc) return;
  const headings = pageHeadings();
  toc.innerHTML = headings.length
    ? headings
        .map(
          (heading) =>
            `<button type="button" class="ew-toc-item" data-toc="${escapeHtml(heading.text)}" data-level="${heading.level}">${escapeHtml(heading.text)}</button>`,
        )
        .join("")
    : `<div class="ew-note">Headings on this page appear here</div>`;
}

function setPageCover(assets: Array<{ assetId: string; filename: string; mime: string }>): void {
  const cover = document.getElementById("doc-cover");
  if (!cover) return;
  const image = assets.find((asset) => asset.mime.startsWith("image/"));
  if (!image) {
    cover.hidden = true;
    cover.replaceChildren();
    return;
  }
  cover.hidden = false;
  cover.innerHTML = `<img src="${escapeHtml(assetUrl(image.assetId))}" alt="${escapeHtml(image.filename)}" />`;
}

async function renderDocumentInspector(id: string): Promise<void> {
  const doc = payload?.documents.find((item) => item.id === id);
  const [comments, revisions, assets, grants, links] = await Promise.all([
    api<{ comments: Array<{ id: string; body: string; quote?: string | null; authorName: string; createdAt: string }> }>(`/v1/documents/${encodeURIComponent(id)}/comments`),
    api<{ revisions: Array<{ revision: number; title: string; createdAt: string }> }>(`/v1/documents/${encodeURIComponent(id)}/revisions`),
    api<{ assets: Array<{ id: string; assetId: string; filename: string; mime: string }> }>(`/v1/documents/${encodeURIComponent(id)}/assets`),
    api<{ grants: Array<{ id: string; principalId: string; role: string; name: string }> }>(`/v1/documents/${encodeURIComponent(id)}/permissions`),
    api<{ links: Array<{ id: string; provider: string; url?: string | null; label?: string; targetKind?: string | null; targetId?: string | null }> }>(
      `/v1/documents/${encodeURIComponent(id)}/links`,
    ),
  ]);
  $("doc-comments").innerHTML =
    comments.comments
      .map(
        (comment) => `<article class="ew-comment">
          ${avatarMarkup(comment.authorName, "lg")}
          <div>
            <div class="ew-comment-meta"><strong>${escapeHtml(comment.authorName)}</strong><span>${escapeHtml(formatWhen(comment.createdAt))}</span></div>
            ${comment.quote ? `<button type="button" class="ew-comment-quote" data-quote="${escapeHtml(comment.quote)}">${escapeHtml(comment.quote)}</button>` : ""}
            <p>${escapeHtml(comment.body)}</p>
          </div>
        </article>`,
      )
      .join("") || `<div class="ew-note">No comments yet</div>`;
  $("doc-media").innerHTML =
    assets.assets
      .map((asset) => {
        const src = assetUrl(asset.assetId);
        if (asset.mime.startsWith("video/")) {
          return `<video src="${escapeHtml(src)}" controls title="${escapeHtml(asset.filename)}"></video>`;
        }
        if (asset.mime.startsWith("image/")) {
          return `<img src="${escapeHtml(src)}" alt="${escapeHtml(asset.filename)}" />`;
        }
        return `<span>${escapeHtml(asset.filename)}</span>`;
      })
      .join("") || `<div class="ew-note">No images or videos on this page</div>`;
  const parents = (payload?.documents ?? []).filter((item) => item.id !== id);
  const people = (payload?.principals ?? [])
    .map((person) => `<option value="${person.id}">${escapeHtml(person.name)}</option>`)
    .join("");
  const issues = (payload?.issues ?? [])
    .map((issue) => `<option value="${issue.id}">${escapeHtml(issue.key)} ${escapeHtml(issue.summary)}</option>`)
    .join("");
  setPageCover(assets.assets);
  inspector.innerHTML = `<div class="ew-meta"><strong>${escapeHtml(doc?.title ?? "")}</strong><span>Hash ${escapeHtml((doc?.hash ?? "").slice(0, 12))}</span><span>${escapeHtml(doc?.classification ?? "")}</span></div>
    <div class="ew-meta"><strong>On this page</strong><div id="page-toc" class="ew-toc"></div></div>
    <label for="rename-page">Title<input id="rename-page" value="${escapeHtml(doc?.title ?? "")}" /></label>
    <label for="move-page">Parent
      <select id="move-page">
        <option value="">Space root</option>
        ${parents.map((item) => `<option value="${item.id}" ${item.id === doc?.parentId ? "selected" : ""}>${escapeHtml(item.title)}</option>`).join("")}
      </select>
    </label>
    <div class="ew-actions">
      <button type="button" id="save-page-meta">Save location</button>
      <label class="ew-file" for="attach-file">Attach file<input id="attach-file" type="file" /></label>
    </div>
    <div class="ew-meta"><strong>Permissions</strong>${grants.grants.map((grant) => `<span>${escapeHtml(grant.name)} · ${escapeHtml(grant.role)}</span>`).join("") || "<span>Inherited from workspace</span>"}</div>
    <label for="grant-principal">Person<select id="grant-principal">${people}</select></label>
    <label for="grant-role">Role<select id="grant-role"><option value="viewer">viewer</option><option value="editor">editor</option><option value="owner">owner</option></select></label>
    <button type="button" id="grant-document">Grant access</button>
    <div class="ew-meta"><strong>Links</strong>${linksMarkup(links.links)}</div>
    <label for="github-url">GitHub URL<input id="github-url" placeholder="https://github.com/org/repo" /></label>
    <button type="button" id="add-github-link">Link GitHub</button>
    <label for="issue-link">Work issue<select id="issue-link">${issues}</select></label>
    <button type="button" id="add-issue-link">Link issue</button>
    <div class="ew-meta"><strong>History</strong>${revisions.revisions.map((rev) => `<button type="button" data-restore="${rev.revision}">v${rev.revision} · ${escapeHtml(rev.title)}</button>`).join("") || "<span>No published revisions</span>"}</div>
    <div class="ew-meta"><strong>Attachments</strong>${assets.assets.map((asset) => `<span>${escapeHtml(asset.filename)}</span>`).join("") || "<span>None</span>"}</div>`;
  enhanceSelects(inspector);
  renderPageToc();
}

async function seedEmptyEditor(id: string, title: string): Promise<void> {
  if ((collab?.getText() ?? "").trim()) return;
  const document = await api<{ title: string; source: string }>(`/v1/documents/${encodeURIComponent(id)}`);
  const editor = collab?.editor();
  if (!editor || (editor.getText() ?? "").trim()) return;
  editor.commands.setContent(nomaToEditorHtml(document.title || title, document.source, token));
  renderPageToc();
  renderWordCount();
}

async function openArtifact(id: string | undefined): Promise<void> {
  if (!id) return;
  if (selectedArtifactId !== id) canvasHistory = [];
  selectedArtifactId = id;
  const data = await api<ArtifactPayload>(`/v1/artifacts/${encodeURIComponent(id)}`);
  $("visual-title").textContent = data.document.title;
  $("visual-stage").innerHTML = rewriteAssetHtml(data.html);
  const from = $<HTMLSelectElement>("arrow-from");
  const to = $<HTMLSelectElement>("arrow-to");
  const options = data.outline
    .filter((entry) => entry.type !== "arrow")
    .map((entry) => `<option value="${escapeHtml(entry.id)}">${escapeHtml(entry.label)}</option>`)
    .join("");
  from.innerHTML = options;
  to.innerHTML = options;
  if (data.outline[1]) to.value = data.outline[1].id;
  const page = $("visual-stage").querySelector(".pd-page");
  if (page instanceof HTMLElement) {
    const width = Math.max(page.offsetWidth, 960);
    const fit = Math.min(1, ($("visual-stage").clientWidth - 32) / width);
    const zoom = Number($("visual-stage").dataset.zoom || String(fit));
    setCanvasZoom($("visual-stage"), zoom);
    page.style.marginBottom = `${Math.max(0, page.offsetHeight * (zoom - 1))}px`;
  }
  $("visual-outline").innerHTML = data.outline
    .map((entry) => `<button type="button" data-frame="${escapeHtml(entry.id)}"><strong>${escapeHtml(entry.label)}</strong><small>${escapeHtml(entry.type)}</small></button>`)
    .join("");
  inspector.innerHTML = `<div class="ew-meta"><strong>${escapeHtml(data.document.title)}</strong><span>Revision ${data.document.revision}</span><span>${data.outline.length} frames</span></div>`;
  $("inspector-title").textContent = "Canvas";
  renderRail();
  enhanceSelects($("canvas-visuals"));
  canvasStop?.();
  const undoBtn = document.getElementById("canvas-undo");
  if (undoBtn instanceof HTMLButtonElement) undoBtn.disabled = canvasHistory.length === 0;
  canvasStop = bindVisualStage($("visual-stage"), {
    onMove: (move) => {
      if (move.previous) {
        canvasHistory.push({ id: move.id, ...move.previous });
        if (undoBtn instanceof HTMLButtonElement) undoBtn.disabled = false;
      }
      void api(`/v1/artifacts/${encodeURIComponent(id)}/elements/${encodeURIComponent(move.id)}`, {
        method: "PATCH",
        body: JSON.stringify({ geometry: { x: move.x, y: move.y, width: move.width, height: move.height } }),
      });
      syncCanvasArrows($("visual-stage"));
    },
    onEdit: (elementId, text) => {
      const card = $("visual-stage").querySelector<HTMLElement>(`.pd-el[data-id="${CSS.escape(elementId)}"]`);
      const color = card?.dataset.sticky;
      const pin = card?.dataset.comment;
      void api(`/v1/artifacts/${encodeURIComponent(id)}/elements/${encodeURIComponent(elementId)}`, {
        method: "PATCH",
        body: JSON.stringify({ text, altText: color ? stickyAlt(color) : pin ? "Comment" : text }),
      });
    },
    onPlaceSticky: (x, y) => {
      $("visual-stage").dataset.tool = "select";
      syncVisualTools();
      void addCanvasElement({
        type: "shape",
        text: "New note",
        altText: stickyAlt(stickyColor),
        geometry: { x, y, width: 200, height: 160 },
      });
    },
    onPlaceComment: (x, y) => {
      $("visual-stage").dataset.tool = "select";
      syncVisualTools();
      void addCanvasElement({
        type: "shape",
        text: "Comment",
        altText: "Comment",
        geometry: { x, y, width: 160, height: 72 },
      });
    },
    onConnect: (fromId, toId) => {
      $("visual-stage").dataset.tool = "select";
      syncVisualTools();
      void addCanvasElement({ type: "arrow", fromId, toId, altText: "Arrow" });
    },
    onSelect: (elementId) => {
      selectedCanvasId = elementId;
      for (const node of $("visual-stage").querySelectorAll(".pd-el")) {
        node.classList.toggle("is-selected", node.getAttribute("data-id") === elementId);
      }
    },
  });
  syncCanvasArrows($("visual-stage"));
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
  $("filter-all")?.setAttribute("aria-pressed", String(boardFilter === "all"));
  $("filter-mine")?.setAttribute("aria-pressed", String(boardFilter === "mine"));
  $("filter-unassigned")?.setAttribute("aria-pressed", String(boardFilter === "unassigned"));
  $("filter-overdue")?.setAttribute("aria-pressed", String(boardFilter === "overdue"));
  $("filter-flagged")?.setAttribute("aria-pressed", String(boardFilter === "flagged"));
  $("filter-watching")?.setAttribute("aria-pressed", String(boardFilter === "watching"));
  $("swimlane-epic")?.setAttribute("aria-pressed", String(swimlanes));
  $("view-board")?.setAttribute("aria-pressed", String(boardView === "board"));
  $("view-list")?.setAttribute("aria-pressed", String(boardView === "list"));
  $("view-reports")?.setAttribute("aria-pressed", String(boardView === "reports"));
  $("view-backlog")?.setAttribute("aria-pressed", String(boardView === "backlog"));
  const projectTypes = payload.issueTypes.filter((type) => type.projectId === project?.id);
  $("type-filters").innerHTML = [
    `<button type="button" data-type="" aria-pressed="${String(!typeFilter)}">All types</button>`,
    ...projectTypes.map(
      (type) =>
        `<button type="button" data-type="${escapeHtml(type.key)}" aria-pressed="${String(typeFilter === type.key)}">${escapeHtml(type.name)}</button>`,
    ),
  ].join("");
  const columns = (project?.statuses ?? []).filter((status) => status.id !== "cancelled");
  const epicSelect = document.getElementById("filter-epic");
  if (epicSelect instanceof HTMLSelectElement) {
    const epics = payload.issues.filter((issue) => issue.typeKey === "epic" && (!project || issue.projectId === project.id));
    epicSelect.innerHTML =
      `<option value="">All epics</option>` +
      epics.map((epic) => `<option value="${epic.id}" ${epic.id === epicFilter ? "selected" : ""}>${escapeHtml(epic.key)} ${escapeHtml(epic.summary)}</option>`).join("");
  }
  const inEpic = (issue: ShellIssue, epicId: string): boolean => {
    if (issue.id === epicId) return true;
    const seen = new Set<string>();
    let current: ShellIssue | undefined = issue;
    while (current?.parentId && !seen.has(current.id)) {
      seen.add(current.id);
      if (current.parentId === epicId) return true;
      current = payload.issues.find((item) => item.id === current?.parentId);
    }
    return false;
  };
  const visible = payload.issues.filter((issue) => {
    if (project && issue.projectId !== project.id) return false;
    if (jqlFilterIds && !jqlFilterIds.includes(issue.id)) return false;
    if (boardFilter === "mine" && issue.assigneeId !== payload?.actor.principalId) return false;
    if (boardFilter === "unassigned" && issue.assigneeId) return false;
    if (boardFilter === "overdue" && !isOverdue(issue)) return false;
    if (boardFilter === "flagged" && !issue.flagged) return false;
    if (boardFilter === "watching" && !issue.watching) return false;
    if (epicFilter && !inEpic(issue, epicFilter)) return false;
    if (typeFilter && issue.typeKey !== typeFilter) return false;
    if (boardSearch && !`${issue.key} ${issue.summary}`.toLowerCase().includes(boardSearch)) return false;
    return true;
  });
  const issueCard = (issue: ShellIssue): string => {
    const assignee = payload?.principals.find((person) => person.id === issue.assigneeId);
    const parent = payload?.issues.find((item) => item.id === issue.parentId);
    const due = (issue.dueAt ?? "").slice(0, 10);
    const labels = (issue.labels ?? []).map((label) => `<span class="ew-label">${escapeHtml(label)}</span>`).join("");
    return `<button class="ew-card${issue.id === selectedIssueId ? " is-open" : ""}" type="button" data-issue="${issue.id}" data-type="${escapeHtml(issue.typeKey)}">
      <span class="ew-key">${escapeHtml(issue.key)}</span>
      <strong>${escapeHtml(issue.summary)}</strong>
      <span class="ew-card-foot">
        <span class="ew-pill">${escapeHtml(issue.typeKey)}</span>
        ${parent ? `<span class="ew-epic">${escapeHtml(parent.key)}</span>` : ""}
        ${issue.estimate != null ? `<span class="ew-points">${issue.estimate}</span>` : ""}
        <span class="ew-priority" data-priority="${escapeHtml(issue.priority)}">${escapeHtml(issue.priority)}</span>
        ${issue.flagged ? `<span class="ew-flag">Flagged</span>` : ""}
        ${issue.watching ? `<span class="ew-watch">Watching</span>` : ""}
        ${due ? `<span class="ew-due${isOverdue(issue) ? " is-overdue" : ""}">${escapeHtml(due)}</span>` : ""}
        ${labels}
        ${assignee ? avatarMarkup(assignee.name) : ""}
      </span>
    </button>`;
  };
  const columnsMarkup = (laneIssues: ShellIssue[], laneId: string): string =>
    columns
      .map((status) => {
        const cards = laneIssues.filter((issue) => issue.statusId === status.id);
        const createId = laneId === "board" ? `create-${status.id}` : `create-${laneId}-${status.id}`;
        return `<section class="ew-column" data-status="${escapeHtml(status.id)}">
        <h3>${escapeHtml(status.name)} <span class="ew-column-count">${cards.length}</span></h3>
        <div class="ew-column-list">
        ${cards.map((issue) => issueCard(issue)).join("")}
        </div>
        <label class="ew-sr" for="${escapeHtml(createId)}">Create in ${escapeHtml(status.name)}</label>
        <input id="${escapeHtml(createId)}" class="ew-column-add" data-status="${escapeHtml(status.id)}" placeholder="Create" />
      </section>`;
      })
      .join("");
  const board = $("work-board");
  board.classList.toggle("has-swimlanes", swimlanes && boardView === "board");
  board.classList.toggle("is-list", boardView === "list");
  board.classList.toggle("is-reports", boardView === "reports");
  board.classList.toggle("is-backlog", boardView === "backlog");
  if (boardView === "reports") {
    boardDndStop?.();
    boardDndStop = undefined;
    void loadProjectReports();
    renderRail();
    return;
  }
  if (boardView === "backlog") {
    boardDndStop?.();
    boardDndStop = undefined;
    const sprint = activeSprint();
    const inSprint = visible.filter((issue) => sprint && issue.sprintId === sprint.id);
    const queued = visible.filter((issue) => !sprint || issue.sprintId !== sprint.id);
    const points = inSprint.reduce((sum, issue) => sum + (issue.estimate ?? 0), 0);
    const row = (issue: ShellIssue, action: "add" | "remove"): string =>
      `<div class="ew-backlog-row${issue.id === selectedIssueId ? " is-open" : ""}">
        ${issueCard(issue)}
        ${
          sprint
            ? `<button type="button" class="ew-sprint-action" data-sprint-action="${action}" data-issue="${escapeHtml(issue.id)}" data-sprint="${escapeHtml(sprint.id)}">${action === "add" ? "Add to sprint" : "Remove"}</button>`
            : ""
        }
      </div>`;
    board.innerHTML = `<div id="work-backlog" class="ew-backlog">
      <section id="sprint-plan" class="ew-backlog-pane">
        <h2>${escapeHtml(sprint ? sprint.name : "No active sprint")} <span id="sprint-points">${points} pts · ${inSprint.length}</span></h2>
        ${inSprint.map((issue) => row(issue, "remove")).join("") || `<p class="ew-meta">Pull issues from the backlog into this sprint.</p>`}
      </section>
      <section id="backlog-list" class="ew-backlog-pane">
        <h2>Backlog <span>${queued.length}</span></h2>
        ${queued.map((issue) => row(issue, "add")).join("") || `<p class="ew-meta">Backlog is empty.</p>`}
      </section>
    </div>`;
    if (!selectedIssueId) {
      document.querySelector(".ew-body")?.classList.remove("is-issue");
      $("inspector-title").textContent = "Backlog";
      inspector.innerHTML = `<div class="ew-meta"><strong>${queued.length} in backlog</strong><span>${inSprint.length} in sprint</span><span>${points} points committed</span></div>
        <p class="ew-report-lead">${sprint ? "Add work to the active sprint, then run the board." : "Plan a sprint from the sprint bar to start committing work."}</p>`;
    }
    renderRail();
    return;
  }
  if (boardView === "list") {
    const statusName = (id: string) => columns.find((status) => status.id === id)?.name ?? id;
    board.innerHTML = `<div class="ew-issue-table" role="table" aria-label="Issue list">
      <div class="ew-row ew-row-head" role="row">
        <span>Key</span><span>Summary</span><span>Status</span><span>Priority</span><span>Due</span><span>Estimate</span>
      </div>
      ${visible
        .map((issue) => {
          const due = (issue.dueAt ?? "").slice(0, 10);
          return `<button type="button" class="ew-row${issue.id === selectedIssueId ? " is-open" : ""}" data-issue="${issue.id}" data-type="${escapeHtml(issue.typeKey)}" role="row">
            <span class="ew-key">${escapeHtml(issue.key)}</span>
            <strong>${escapeHtml(issue.summary)}</strong>
            <span>${escapeHtml(statusName(issue.statusId))}</span>
            <span class="ew-priority" data-priority="${escapeHtml(issue.priority)}">${escapeHtml(issue.priority)}</span>
            <span class="ew-due${isOverdue(issue) ? " is-overdue" : ""}">${escapeHtml(due)}</span>
            <span class="ew-points">${issue.estimate ?? ""}</span>
          </button>`;
        })
        .join("")}
    </div>`;
  } else if (swimlanes) {
    const epicLane = (issue: ShellIssue): { id: string; title: string } => {
      if (issue.typeKey === "epic") return { id: issue.id, title: `${issue.key} ${issue.summary}` };
      const seen = new Set<string>();
      let current: ShellIssue | undefined = issue;
      while (current?.parentId && !seen.has(current.id)) {
        seen.add(current.id);
        const parent = payload?.issues.find((item) => item.id === current?.parentId);
        if (!parent) break;
        if (parent.typeKey === "epic") return { id: parent.id, title: `${parent.key} ${parent.summary}` };
        current = parent;
      }
      return { id: "none", title: "No epic" };
    };
    const groups = new Map<string, { title: string; issues: ShellIssue[] }>();
    for (const issue of visible) {
      const lane = epicLane(issue);
      const existing = groups.get(lane.id);
      if (existing) existing.issues.push(issue);
      else groups.set(lane.id, { title: lane.title, issues: [issue] });
    }
    board.innerHTML = [...groups.entries()]
      .map(
        ([laneId, group]) => `<section class="ew-swimlane" data-epic="${escapeHtml(laneId)}">
          <h3>${escapeHtml(group.title)} <span>${group.issues.length}</span></h3>
          <div class="ew-swimlane-cols">${columnsMarkup(group.issues, laneId)}</div>
        </section>`,
      )
      .join("");
  } else {
    board.innerHTML = columnsMarkup(visible, "board");
  }
  if (!selectedIssueId) {
    document.querySelector(".ew-body")?.classList.remove("is-issue");
    $("inspector-title").textContent = "Board";
    inspector.innerHTML = `<div class="ew-meta"><strong>${visible.length} issues</strong><span>${payload.notifications.length} notifications</span></div>
    <label for="new-issue-summary">Create issue
      <input id="new-issue-summary" placeholder="Summary" />
    </label>
    <label for="new-issue-type">Type
      <select id="new-issue-type">${(payload.issueTypes.filter((type) => type.projectId === project?.id)).map((type) => `<option value="${escapeHtml(type.key)}">${escapeHtml(type.name)}</option>`).join("")}</select>
    </label>
    <div class="ew-actions"><button type="button" id="submit-issue">${iconSvg("Plus")} Create</button></div>`;
    enhanceSelects(inspector);
  }
  renderRail();
  boardDndStop?.();
  boardDndStop = bindIssueBoard($("work-board"), (drop) => {
    void applyBoardDrop(drop);
  });
}

async function transitionIssueTo(issueId: string, from: string, to: string): Promise<void> {
  for (const status of statusPath(from, to)) {
    await api(`/v1/issues/${encodeURIComponent(issueId)}/transition`, {
      method: "POST",
      body: JSON.stringify({ to: status, fields: status === "done" ? { resolution: "completed" } : {} }),
    });
  }
}

async function applyBoardDrop(drop: BoardDrop): Promise<void> {
  const project = currentProject();
  if (!project || !payload) return;
  const issue = payload.issues.find((item) => item.id === drop.issueId);
  if (!issue) return;
  const previous = issue.statusId;
  const nextStatus = drop.statusId || previous;
  issue.statusId = nextStatus;
  renderBoard();
  try {
    if (nextStatus !== previous) await transitionIssueTo(drop.issueId, previous, nextStatus);
    const ordered = [...payload.issues.filter((item) => item.projectId === project.id)].map((item) => item.id);
    const from = ordered.indexOf(drop.issueId);
    if (from >= 0) ordered.splice(from, 1);
    if (drop.beforeId) {
      const to = ordered.indexOf(drop.beforeId);
      ordered.splice(to < 0 ? ordered.length : to, 0, drop.issueId);
    } else {
      ordered.push(drop.issueId);
    }
    await api(`/v1/projects/${encodeURIComponent(project.id)}/rank`, { method: "POST", body: JSON.stringify({ orderedIds: ordered }) });
  } catch {
    issue.statusId = previous;
  } finally {
    await refreshWorkspace();
    renderBoard();
    if (selectedIssueId) await inspectIssue(selectedIssueId);
  }
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
    reporter_id?: string | null;
    priority?: string;
    due_at?: string | null;
    labels_json?: string;
    estimate?: number | null;
    flagged?: number | boolean;
    watching?: boolean;
    watchers?: Array<{ id: string; name: string }>;
    events?: Array<{ action: string; actorName: string; createdAt: string }>;
  }>(`/v1/issues/${encodeURIComponent(id)}`);
  const project = payload.projects.find((item) => item.id === issue.projectId);
  const current = project?.statuses.find((status) => status.id === issue.statusId);
  const next = project?.statuses.find((status) => {
    const order = ["backlog", "todo", "in_progress", "in_review", "done"];
    return order.indexOf(status.id) === order.indexOf(issue.statusId) + 1;
  });
  const people = payload.principals.map((person) => `<option value="${person.id}" ${person.id === detail.assignee_id ? "selected" : ""}>${escapeHtml(person.name)}</option>`).join("");
  const sprints = payload.sprints.map((sprint) => `<option value="${sprint.id}" ${sprint.id === detail.sprint_id ? "selected" : ""}>${escapeHtml(sprint.name)}</option>`).join("");
  const reporter = payload.principals.find((person) => person.id === (detail.reporter_id ?? issue.reporterId));
  const parentId = detail.parent_id ?? issue.parentId;
  const parents = payload.issues
    .filter((item) => item.projectId === issue.projectId && item.id !== issue.id)
    .map((item) => `<option value="${item.id}" ${item.id === parentId ? "selected" : ""}>${escapeHtml(item.key)} ${escapeHtml(item.summary)}</option>`)
    .join("");
  inspector.innerHTML = `<div class="ew-issue">
      <div class="ew-issue-kicker ew-meta">
        <span class="ew-key">${escapeHtml(issue.key)}</span>
        <span class="ew-pill">${escapeHtml(detail.typeKey)}</span>
        <span class="ew-lozenge">${escapeHtml(current?.name ?? issue.statusId)}</span>
        <button type="button" id="close-issue">Close</button>
      </div>
      <p id="issue-reporter" class="ew-note">Reported by ${escapeHtml(reporter?.name ?? "Unknown")}</p>
      <label class="ew-check" for="issue-flag"><input id="issue-flag" type="checkbox" ${issue.flagged || Boolean(detail.flagged) ? "checked" : ""} /> Flagged</label>
      <div id="issue-watchers" class="ew-watchers">
        <button type="button" id="issue-watch">${detail.watching || issue.watching ? "Watching" : "Watch"}</button>
        <span>${((detail.watchers as Array<{ name: string }> | undefined) ?? []).map((watcher) => avatarMarkup(watcher.name)).join("") || "No watchers"}</span>
      </div>
      <label for="issue-summary">Summary<input id="issue-summary" value="${escapeHtml(detail.summary)}" /></label>
      <label for="issue-description">Description<textarea id="issue-description" rows="3">${escapeHtml(detail.description ?? "")}</textarea></label>
      <div class="ew-issue-grid">
        <label for="issue-assignee">Assignee<select id="issue-assignee"><option value="">Unassigned</option>${people}</select></label>
        <label for="issue-parent">Parent<select id="issue-parent"><option value="">No parent</option>${parents}</select></label>
        <label for="issue-sprint">Sprint<select id="issue-sprint"><option value="">Backlog</option>${sprints}</select></label>
        <label for="issue-priority">Priority<select id="issue-priority">${["lowest", "low", "medium", "high", "highest"].map((item) => `<option value="${item}" ${(detail.priority ?? issue.priority) === item ? "selected" : ""}>${item}</option>`).join("")}</select></label>
        <label for="issue-due">Due date<input id="issue-due" type="date" value="${escapeHtml((detail.due_at ?? issue.dueAt ?? "").slice(0, 10))}" /></label>
        <label for="issue-estimate">Estimate<input id="issue-estimate" type="number" min="0" step="1" value="${escapeHtml(String(detail.estimate ?? issue.estimate ?? ""))}" /></label>
        <label for="issue-labels">Labels<input id="issue-labels" value="${escapeHtml((() => {
          try {
            const parsed = typeof detail.labels_json === "string" ? (JSON.parse(detail.labels_json) as unknown) : issue.labels;
            return Array.isArray(parsed) ? parsed.join(", ") : (issue.labels ?? []).join(", ");
          } catch {
            return (issue.labels ?? []).join(", ");
          }
        })())}" placeholder="canvas, urgent" /></label>
      </div>
      <div id="issue-children" class="ew-activity">
        <strong>Child work</strong>
        ${payload.issues
          .filter((item) => item.parentId === issue.id)
          .map(
            (item) =>
              `<button type="button" class="ew-child" data-issue="${item.id}">${escapeHtml(item.key)} ${escapeHtml(item.summary)}</button>`,
          )
          .join("") || `<div class="ew-note">No child issues</div>`}
        <label for="issue-child-summary">Add child<input id="issue-child-summary" placeholder="Subtask summary" /></label>
        <button type="button" id="issue-child-submit">Add child</button>
      </div>
      <div class="ew-actions">
        <button type="button" id="save-issue">Save</button>
        ${next ? `<button type="button" id="advance-issue" data-to="${escapeHtml(next.id)}">Move to ${escapeHtml(next.name)}</button>` : ""}
        ${detail.transitions
          .filter((item) => item.to !== next?.id)
          .map((item) => `<button type="button" class="ew-transition" data-to="${escapeHtml(item.to)}" data-fields="${escapeHtml(item.requiredFields.join(","))}">${escapeHtml(item.to.replaceAll("_", " "))}</button>`)
          .join("")}
      </div>
      <div class="ew-activity">
        <strong>Comments</strong>
        ${detail.comments.map((comment) => `<article class="ew-comment"><div><div class="ew-comment-meta"><strong>${escapeHtml(comment.authorName)}</strong></div><p>${escapeHtml(comment.body)}</p></div></article>`).join("") || `<div class="ew-note">No comments</div>`}
        <label for="issue-comment">Comment<textarea id="issue-comment" rows="2" placeholder="Write a comment. Mention with @name"></textarea></label>
        <button type="button" id="issue-comment-submit">Comment</button>
      </div>
      <div class="ew-activity">
        <strong>Worklog</strong>
        ${detail.worklogs.map((log) => `<span>${escapeHtml(log.authorName)} · ${Math.round(log.durationSeconds / 60)}m ${escapeHtml(log.note ?? "")}</span>`).join("") || `<div class="ew-note">No time logged</div>`}
        <label for="worklog-minutes">Minutes<input id="worklog-minutes" type="number" min="1" value="30" /></label>
        <label for="worklog-note">Note<input id="worklog-note" /></label>
        <button type="button" id="worklog-submit">Log work</button>
      </div>
      <div class="ew-activity">
        <strong>Activity</strong>
        ${(detail.events ?? [])
          .map(
            (event) =>
              `<article class="ew-comment"><div><div class="ew-comment-meta"><strong>${escapeHtml(event.actorName)}</strong><span>${escapeHtml(event.action.replaceAll("_", " "))}</span></div></div></article>`,
          )
          .join("") || `<div class="ew-note">No activity yet</div>`}
      </div>
    </div>`;
  const links = await api<{ links: Array<{ id: string; provider: string; url?: string | null; label?: string; targetKind?: string | null; targetId?: string | null }> }>(
    `/v1/issues/${encodeURIComponent(id)}/links`,
  );
  const docs = (payload.documents ?? []).map((item) => `<option value="${item.id}">${escapeHtml(item.title)}</option>`).join("");
  inspector.insertAdjacentHTML(
    "beforeend",
    `<div class="ew-meta"><strong>Links</strong>${linksMarkup(links.links)}</div>
    <label for="issue-relates">Related issue<select id="issue-relates">${payload.issues
      .filter((item) => item.id !== issue.id)
      .map((item) => `<option value="${item.id}">${escapeHtml(item.key)} ${escapeHtml(item.summary)}</option>`)
      .join("")}</select></label>
    <button type="button" id="add-issue-relates">Link issue</button>
    <label for="issue-github-url">GitHub URL<input id="issue-github-url" placeholder="https://github.com/org/repo/issues/1" /></label>
    <button type="button" id="add-issue-github">Link GitHub</button>
    <label for="issue-doc-link">Page<select id="issue-doc-link">${docs}</select></label>
    <button type="button" id="add-issue-doc-link">Link page</button>`,
  );
  $("inspector-title").textContent = issue.key;
  document.querySelector(".ew-body")?.classList.add("is-issue");
  enhanceSelects(inspector);
  bindWorkspaceMentions();
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
  enhanceSelects($("admin-panel"));
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
  const badge = $("notify-badge");
  const unread = items.filter((item) => !item.read_at).length;
  badge.hidden = unread === 0;
  badge.textContent = unread > 9 ? "9+" : String(unread);
  $("notify-toggle").setAttribute("aria-label", unread ? `Notifications, ${unread} unread` : "Notifications");
}

async function refreshWorkspace(): Promise<void> {
  payload = await api<WorkspacePayload>("/v1/workspace");
  renderNotifications();
}

async function loadWorkspace(): Promise<void> {
  await refreshWorkspace();
  setSessionAvatar(payload!.actor.name);
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

async function createPage(): Promise<void> {
  const titleInput = document.getElementById("new-page-title") as HTMLInputElement | null;
  const title = titleInput?.value.trim() || "Untitled";
  if (!payload || !currentSpaceId()) return;
  const created = await api<{ id: string }>("/v1/documents", {
    method: "POST",
    body: JSON.stringify({ spaceId: currentSpaceId(), title, parentId: selectedDocumentId || undefined }),
  });
  await refreshWorkspace();
  setMode("docs");
  openDocument(created.id);
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
  if (button.dataset.kind === "space") {
    selectedSpaceId = button.dataset.id ?? "";
    renderRail();
  }
});

$("rail-actions").addEventListener("click", async (event) => {
  const target = event.target as HTMLElement;
  if (target.id === "create-space") {
    const name = $<HTMLInputElement>("new-space-name").value.trim();
    if (!name) return;
    const created = await api<{ id: string }>("/v1/spaces", { method: "POST", body: JSON.stringify({ name, homePage: true }) });
    selectedSpaceId = created.id;
    await refreshWorkspace();
    setMode("docs");
    const home = payload?.documents.find((doc) => doc.spaceId === created.id);
    if (home) openDocument(home.id);
  }
  if (target.id === "create-page") {
    await createPage();
  }
  if (target.id === "import-page") $("import-modal").hidden = false;
  if (target.id === "create-issue") {
    const summary = $<HTMLInputElement>("new-issue-rail-summary").value.trim();
    if (!summary || !currentProject()) return;
    await api(`/v1/projects/${encodeURIComponent(currentProject()!.id)}/issues`, {
      method: "POST",
      body: JSON.stringify({ summary, typeKey: "task" }),
    });
    await refreshWorkspace();
    renderBoard();
  }
});
$("rail-actions").addEventListener("change", (event) => {
  const target = event.target as HTMLElement;
  if (target.id === "space-switch") {
    selectedSpaceId = (target as HTMLSelectElement).value;
    renderRail();
    if (mode === "docs") {
      const first = payload?.documents.find((doc) => doc.spaceId === selectedSpaceId);
      if (first) openDocument(first.id);
    }
    if (mode === "visuals") {
      const first = payload?.artifacts.find((art) => art.spaceId === selectedSpaceId);
      void openArtifact(first?.id);
    }
  }
});

$("work-board").addEventListener("click", (event) => {
  const action = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-sprint-action]");
  if (action?.dataset.issue) {
    event.preventDefault();
    event.stopPropagation();
    const sprintId = action.dataset.sprintAction === "add" ? action.dataset.sprint ?? null : null;
    void (async () => {
      await api(`/v1/issues/${encodeURIComponent(action.dataset.issue!)}/sprint`, {
        method: "POST",
        body: JSON.stringify({ sprintId }),
      });
      await refreshWorkspace();
      renderBoard();
      if (selectedIssueId) await inspectIssue(selectedIssueId);
    })();
    return;
  }
  const card = (event.target as HTMLElement).closest<HTMLElement>("[data-issue]");
  if (card?.dataset.issue && !$("work-board").classList.contains("is-sorting")) void inspectIssue(card.dataset.issue);
});

inspector.addEventListener("click", async (event) => {
  const link = (event.target as HTMLElement).closest<HTMLAnchorElement>("a.ew-link");
  if (link?.dataset.kind === "issue" && link.dataset.id) {
    event.preventDefault();
    setMode("work");
    void inspectIssue(link.dataset.id);
    return;
  }
  if (link?.dataset.kind === "document" && link.dataset.id) {
    event.preventDefault();
    setMode("docs");
    openDocument(link.dataset.id);
    return;
  }
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>("button");
  if (!button) return;
  try {
    if (button.id === "close-issue") {
      selectedIssueId = "";
      document.querySelector(".ew-body")?.classList.remove("is-issue");
      renderBoard();
      return;
    }
    if (button.id === "export-svg") {
      await showCanvasExport("svg");
      return;
    }
    if (button.id === "export-png") {
      await showCanvasExport("png");
      return;
    }
    if (button.id === "export-pptx") {
      await showCanvasExport("pptx");
      return;
    }
    if (button.dataset.toc) {
      const heading = [...editorMount.querySelectorAll("h1, h2, h3")].find((node) => node.textContent?.trim() === button.dataset.toc);
      heading?.scrollIntoView({ block: "center" });
      return;
    }
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
    if (button.id === "issue-watch" && selectedIssueId) {
      const watching = button.textContent?.trim() === "Watching";
      await api(`/v1/issues/${encodeURIComponent(selectedIssueId)}/watch`, { method: watching ? "DELETE" : "POST" });
      await refreshWorkspace();
      renderBoard();
      await inspectIssue(selectedIssueId);
      return;
    }
    if (button.classList.contains("ew-child") && button.dataset.issue) {
      await inspectIssue(button.dataset.issue);
      return;
    }
    if (button.id === "issue-child-submit" && selectedIssueId && currentProject()) {
      const summary = $<HTMLInputElement>("issue-child-summary").value.trim();
      if (!summary) return;
      await api(`/v1/projects/${encodeURIComponent(currentProject()!.id)}/issues`, {
        method: "POST",
        body: JSON.stringify({ summary, typeKey: "subtask", parentId: selectedIssueId }),
      });
      await refreshWorkspace();
      renderBoard();
      await inspectIssue(selectedIssueId);
      return;
    }
    if (button.id === "add-issue-relates" && selectedIssueId) {
      const related = $<HTMLSelectElement>("issue-relates").value;
      if (!related) return;
      await api(`/v1/issues/${encodeURIComponent(selectedIssueId)}/links`, {
        method: "POST",
        body: JSON.stringify({ provider: "issue", issueId: related, label: "relates" }),
      });
      await inspectIssue(selectedIssueId);
      return;
    }
    if (button.id === "save-issue" && selectedIssueId) {
      await api(`/v1/issues/${encodeURIComponent(selectedIssueId)}`, {
        method: "PATCH",
        body: JSON.stringify({
          summary: $<HTMLInputElement>("issue-summary").value,
          description: $<HTMLTextAreaElement>("issue-description").value,
          assigneeId: $<HTMLSelectElement>("issue-assignee").value || null,
          parentId: $<HTMLSelectElement>("issue-parent").value || null,
          priority: $<HTMLSelectElement>("issue-priority").value,
          dueAt: $<HTMLInputElement>("issue-due").value || null,
          estimate: $<HTMLInputElement>("issue-estimate").value === "" ? null : Number($<HTMLInputElement>("issue-estimate").value),
          flagged: $<HTMLInputElement>("issue-flag").checked,
          labels: $<HTMLInputElement>("issue-labels")
            .value.split(",")
            .map((item) => item.trim())
            .filter(Boolean),
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
    if (button.id === "grant-document" && selectedDocumentId) {
      await api(`/v1/documents/${encodeURIComponent(selectedDocumentId)}/permissions`, {
        method: "POST",
        body: JSON.stringify({
          principalId: $<HTMLSelectElement>("grant-principal").value,
          role: $<HTMLSelectElement>("grant-role").value,
        }),
      });
      await renderDocumentInspector(selectedDocumentId);
    }
    if (button.id === "add-github-link" && selectedDocumentId) {
      await api(`/v1/documents/${encodeURIComponent(selectedDocumentId)}/links`, {
        method: "POST",
        body: JSON.stringify({ provider: "github", url: $<HTMLInputElement>("github-url").value.trim() }),
      });
      await renderDocumentInspector(selectedDocumentId);
    }
    if (button.id === "add-issue-link" && selectedDocumentId) {
      await api(`/v1/documents/${encodeURIComponent(selectedDocumentId)}/links`, {
        method: "POST",
        body: JSON.stringify({ provider: "issue", issueId: $<HTMLSelectElement>("issue-link").value }),
      });
      await renderDocumentInspector(selectedDocumentId);
    }
    if (button.id === "add-issue-github" && selectedIssueId) {
      await api(`/v1/issues/${encodeURIComponent(selectedIssueId)}/links`, {
        method: "POST",
        body: JSON.stringify({ provider: "github", url: $<HTMLInputElement>("issue-github-url").value.trim() }),
      });
      await inspectIssue(selectedIssueId);
    }
    if (button.id === "add-issue-doc-link" && selectedIssueId) {
      await api(`/v1/issues/${encodeURIComponent(selectedIssueId)}/links`, {
        method: "POST",
        body: JSON.stringify({ provider: "document", documentId: $<HTMLSelectElement>("issue-doc-link").value }),
      });
      await inspectIssue(selectedIssueId);
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
      renderRail();
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
      renderRail();
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
      renderRail();
    }
  } catch (error: unknown) {
    inspector.insertAdjacentHTML("beforeend", `<p class="ew-error">${escapeHtml(error instanceof Error ? error.message : String(error))}</p>`);
  }
});

inspector.addEventListener("change", async (event) => {
  const input = event.target as HTMLInputElement;
  if (input.id === "issue-flag" && selectedIssueId) {
    await api(`/v1/issues/${encodeURIComponent(selectedIssueId)}`, {
      method: "PATCH",
      body: JSON.stringify({ flagged: input.checked }),
    });
    await refreshWorkspace();
    renderBoard();
    await inspectIssue(selectedIssueId);
    return;
  }
  if (input.id !== "attach-file" || !input.files?.[0] || !selectedDocumentId) return;
  const file = input.files[0];
  await api(`/v1/documents/${encodeURIComponent(selectedDocumentId)}/assets`, {
    method: "POST",
    body: JSON.stringify({ filename: file.name, mime: file.type || "application/octet-stream", contentBase64: await fileToBase64(file) }),
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

async function embedPageMedia(kind: "image" | "video", file: File): Promise<void> {
  if (!selectedDocumentId) return;
  await api(`/v1/documents/${encodeURIComponent(selectedDocumentId)}/media`, {
    method: "POST",
    body: JSON.stringify({
      kind,
      filename: file.name,
      mime: file.type || (kind === "video" ? "video/mp4" : "image/png"),
      contentBase64: await fileToBase64(file),
    }),
  });
  const editor = collab?.editor();
  editor?.chain().focus().insertContent(`<p>${kind === "video" ? "Video" : "Image"}: ${escapeHtml(file.name)}</p>`).run();
  await refreshWorkspace();
  await renderDocumentInspector(selectedDocumentId);
}

$("insert-image").addEventListener("change", async (event) => {
  const file = (event.target as HTMLInputElement).files?.[0];
  if (file) await embedPageMedia("image", file);
  (event.target as HTMLInputElement).value = "";
});
$("insert-video").addEventListener("change", async (event) => {
  const file = (event.target as HTMLInputElement).files?.[0];
  if (file) await embedPageMedia("video", file);
  (event.target as HTMLInputElement).value = "";
});

async function showCanvasExport(target: "svg" | "png" | "pptx" = exportTarget): Promise<void> {
  if (!selectedArtifactId) return;
  exportTarget = target;
  const report = await api<{
    supported: string[];
    unsupported: string[];
    completeOfficeFidelity: boolean;
  }>(`/v1/artifacts/${encodeURIComponent(selectedArtifactId)}/export?target=${encodeURIComponent(target)}`);
  $("inspector-title").textContent = "Export";
  inspector.innerHTML = `<div id="canvas-export-report" class="ew-export">
    <p class="ew-kicker">${escapeHtml(target.toUpperCase())} fidelity</p>
    <strong>Supported frames</strong>
    <ul class="ew-export-list">${report.supported.map((item) => `<li>${escapeHtml(item)}</li>`).join("") || "<li>None</li>"}</ul>
    <strong>Gaps</strong>
    <ul class="ew-export-list">${report.unsupported.map((item) => `<li>${escapeHtml(item)}</li>`).join("") || "<li>No extra gaps for this target</li>"}</ul>
    <p class="ew-export-note">${report.completeOfficeFidelity ? "Complete Office fidelity" : "Office theme mapping is not complete. SVG and PNG keep PaperDOM geometry."}</p>
    <div class="ew-actions">
      <button type="button" id="export-svg" aria-pressed="${String(target === "svg")}">SVG</button>
      <button type="button" id="export-png" aria-pressed="${String(target === "png")}">PNG</button>
      <button type="button" id="export-pptx" aria-pressed="${String(target === "pptx")}">PPTX</button>
    </div>
  </div>`;
}

async function restackCanvas(direction: "front" | "back"): Promise<void> {
  if (!selectedArtifactId || !selectedCanvasId) return;
  const data = await api<ArtifactPayload>(`/v1/artifacts/${encodeURIComponent(selectedArtifactId)}`);
  const values = data.document.elements.map((element) => element.zIndex);
  const next = direction === "front" ? Math.max(0, ...values) + 1 : Math.min(0, ...values) - 1;
  await api(`/v1/artifacts/${encodeURIComponent(selectedArtifactId)}/elements/${encodeURIComponent(selectedCanvasId)}`, {
    method: "PATCH",
    body: JSON.stringify({ zIndex: next }),
  });
  await openArtifact(selectedArtifactId);
}

async function deleteCanvasSelection(): Promise<void> {
  if (!selectedArtifactId || !selectedCanvasId) return;
  const id = selectedCanvasId;
  selectedCanvasId = "";
  await api(`/v1/artifacts/${encodeURIComponent(selectedArtifactId)}/elements/${encodeURIComponent(id)}`, { method: "DELETE" });
  canvasHistory = canvasHistory.filter((item) => item.id !== id);
  await refreshWorkspace();
  await openArtifact(selectedArtifactId);
}

async function undoCanvas(): Promise<void> {
  const last = canvasHistory.pop();
  const undoBtn = document.getElementById("canvas-undo");
  if (undoBtn instanceof HTMLButtonElement) undoBtn.disabled = canvasHistory.length === 0;
  if (!last || !selectedArtifactId) return;
  const card = $("visual-stage").querySelector<HTMLElement>(`.pd-el[data-id="${CSS.escape(last.id)}"]`);
  if (card) {
    card.style.left = `${last.x}px`;
    card.style.top = `${last.y}px`;
    card.style.width = `${last.width}px`;
    card.style.height = `${last.height}px`;
    syncCanvasArrows($("visual-stage"));
  }
  await api(`/v1/artifacts/${encodeURIComponent(selectedArtifactId)}/elements/${encodeURIComponent(last.id)}`, {
    method: "PATCH",
    body: JSON.stringify({ geometry: { x: last.x, y: last.y, width: last.width, height: last.height } }),
  });
}

async function addCanvasElement(input: Record<string, unknown>): Promise<void> {
  if (!selectedArtifactId) return;
  await api(`/v1/artifacts/${encodeURIComponent(selectedArtifactId)}/elements`, {
    method: "POST",
    body: JSON.stringify(input),
  });
  await refreshWorkspace();
  await openArtifact(selectedArtifactId);
}

$("create-board").addEventListener("click", async () => {
  const title = $<HTMLInputElement>("new-board-title").value.trim() || "Untitled presentation";
  if (!currentSpaceId()) return;
  const created = await api<{ id: string }>("/v1/artifacts", { method: "POST", body: JSON.stringify({ spaceId: currentSpaceId(), title }) });
  await refreshWorkspace();
  setMode("visuals");
  await openArtifact(created.id);
  await addCanvasElement({ type: "text", text: title, altText: title, geometry: { x: 48, y: 36, width: 640, height: 64 } });
});
$("add-frame").addEventListener("click", async () => {
  await addCanvasElement({ type: "shape", text: "Frame", altText: "Frame" });
});

function syncVisualTools(): void {
  const tool = $("visual-stage").dataset.tool ?? "select";
  for (const button of document.querySelectorAll<HTMLButtonElement>("#visual-toolbar [data-tool]")) {
    button.setAttribute("aria-pressed", String(button.dataset.tool === tool));
  }
  for (const button of document.querySelectorAll<HTMLButtonElement>("#sticky-colors [data-sticky-color]")) {
    button.setAttribute("aria-pressed", String(button.dataset.stickyColor === stickyColor));
  }
  $("visual-stage").classList.toggle("is-panning", tool === "pan");
  $("visual-stage").classList.toggle("is-sticky", tool === "sticky");
  $("visual-stage").classList.toggle("is-connecting", tool === "connect");
  $("visual-stage").classList.toggle("is-commenting", tool === "comment");
}

$("visual-toolbar").addEventListener("click", (event) => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>("button");
  if (!button) return;
  const color = button.dataset.stickyColor;
  if (color === "yellow" || color === "pink" || color === "green" || color === "blue") {
    stickyColor = color;
    $("visual-stage").dataset.tool = "sticky";
    syncVisualTools();
    return;
  }
  if (button.id === "canvas-undo") {
    void undoCanvas();
    return;
  }
  if (button.id === "canvas-delete") {
    void deleteCanvasSelection();
    return;
  }
  if (button.id === "canvas-front") {
    void restackCanvas("front");
    return;
  }
  if (button.id === "canvas-back") {
    void restackCanvas("back");
    return;
  }
  if (button.id === "canvas-export") {
    void showCanvasExport(exportTarget);
    return;
  }
  if (button.id === "canvas-present") {
    setPresenting(!presenting);
    return;
  }
  if (button.dataset.tool) {
    $("visual-stage").dataset.tool = button.dataset.tool;
    syncVisualTools();
  }
  const current = Number($("visual-stage").dataset.zoom ?? "1");
  if (button.id === "zoom-in") setCanvasZoom($("visual-stage"), current + 0.1);
  if (button.id === "zoom-out") setCanvasZoom($("visual-stage"), current - 0.1);
  if (button.id === "zoom-fit") {
    const page = $("visual-stage").querySelector<HTMLElement>(".pd-page");
    if (page) setCanvasZoom($("visual-stage"), Math.min(1, ($("visual-stage").clientWidth - 32) / Math.max(page.offsetWidth, 960)));
  }
});
$("add-arrow").addEventListener("click", async () => {
  await addCanvasElement({
    type: "arrow",
    fromId: $<HTMLSelectElement>("arrow-from").value,
    toId: $<HTMLSelectElement>("arrow-to").value,
    altText: "Arrow",
  });
});
$("canvas-image").addEventListener("change", async (event) => {
  const file = (event.target as HTMLInputElement).files?.[0];
  if (!file) return;
  const uploaded = await api<{ id: string }>("/v1/assets", {
    method: "POST",
    body: JSON.stringify({ filename: file.name, mime: file.type || "image/png", contentBase64: await fileToBase64(file) }),
  });
  await addCanvasElement({ type: "image", imageAssetId: uploaded.id, altText: file.name });
  (event.target as HTMLInputElement).value = "";
});
$("canvas-video").addEventListener("change", async (event) => {
  const file = (event.target as HTMLInputElement).files?.[0];
  if (!file) return;
  const uploaded = await api<{ id: string }>("/v1/assets", {
    method: "POST",
    body: JSON.stringify({ filename: file.name, mime: file.type || "video/mp4", contentBase64: await fileToBase64(file) }),
  });
  await addCanvasElement({ type: "video", videoAssetId: uploaded.id, altText: file.name });
  (event.target as HTMLInputElement).value = "";
});

$("doc-comment-submit").addEventListener("click", async () => {
  if (!selectedDocumentId) return;
  const box = $<HTMLTextAreaElement>("doc-comment-input");
  const body = box.value.trim();
  if (!body) return;
  const quote = box.dataset.quote?.trim() || "";
  await api(`/v1/documents/${encodeURIComponent(selectedDocumentId)}/comments`, {
    method: "POST",
    body: JSON.stringify({ body, quote: quote || undefined }),
  });
  box.value = "";
  delete box.dataset.quote;
  box.placeholder = "Write a comment. Mention with @alice";
  const chip = document.getElementById("doc-comment-quote");
  if (chip) {
    chip.hidden = true;
    chip.textContent = "";
  }
  await refreshWorkspace();
  await renderDocumentInspector(selectedDocumentId);
});

$("page-find-open").addEventListener("click", () => openPageFind());
$("page-present").addEventListener("click", () => setPresenting(!presenting));
$("present-exit").addEventListener("click", () => setPresenting(false));
$("page-find-close").addEventListener("click", () => closePageFind());
$("page-find-next").addEventListener("click", () => jumpFind(1));
$("page-find-prev").addEventListener("click", () => jumpFind(-1));
$("page-find-input").addEventListener("input", (event) => {
  runPageFind((event.target as HTMLInputElement).value);
});
$("page-find-input").addEventListener("keydown", (event) => {
  if (event.key === "Enter") {
    event.preventDefault();
    jumpFind(event.shiftKey ? -1 : 1);
  }
  if (event.key === "Escape") {
    event.preventDefault();
    closePageFind();
  }
});
$("doc-comments").addEventListener("click", (event) => {
  const quote = (event.target as HTMLElement).closest<HTMLButtonElement>("button[data-quote]");
  if (!quote?.dataset.quote) return;
  runPageFind(quote.dataset.quote);
});

$("visual-outline").addEventListener("click", (event) => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>("button[data-frame]");
  const id = button?.dataset.frame;
  if (!id) return;
  for (const node of document.querySelectorAll(".pd-el")) node.classList.toggle("is-selected", node.getAttribute("data-id") === id);
});

function syncSearchPopup(): void {
  searchPopupStop?.();
  searchPopupStop = undefined;
  if (searchResults.hidden) return;
  const anchor = document.querySelector(".ew-search-box");
  if (!(anchor instanceof HTMLElement)) return;
  searchPopupStop = positionPopup(anchor, searchResults);
}

$("workspace-search").addEventListener("input", async (event) => {
  const query = (event.target as HTMLInputElement).value.trim();
  if (!query) {
    searchResults.hidden = true;
    searchResults.replaceChildren();
    syncSearchPopup();
    return;
  }
  const result = await api<{ hits: Array<{ title: string; resourceKind: string; resourceId: string; excerpt: string }> }>(
    `/v1/search?q=${encodeURIComponent(query)}`,
  );
  searchResults.hidden = false;
  const hits = uniqueHits(result.hits);
  searchResults.innerHTML = hits
    .map(
      (hit) => `<button class="ew-hit" type="button" data-kind="${escapeHtml(hit.resourceKind)}" data-id="${escapeHtml(hit.resourceId)}">
        <strong>${escapeHtml(hit.title)}</strong><small>${escapeHtml(hit.excerpt)}</small>
      </button>`,
    )
    .join("") || `<div class="ew-meta">No matches</div>`;
  syncSearchPopup();
});

document.addEventListener("pointerdown", (event) => {
  if (searchResults.hidden) return;
  const target = event.target as Node;
  const box = document.querySelector(".ew-search-box");
  if (searchResults.contains(target) || box?.contains(target)) return;
  searchResults.hidden = true;
  syncSearchPopup();
});

searchResults.addEventListener("click", (event) => {
  const hit = (event.target as HTMLElement).closest<HTMLButtonElement>("button.ew-hit");
  if (!hit) return;
  searchResults.hidden = true;
  syncSearchPopup();
  if (hit.dataset.kind === "document") {
    setMode("docs");
    openDocument(hit.dataset.id);
  }
  if (hit.dataset.kind === "issue") {
    setMode("work");
    void inspectIssue(hit.dataset.id ?? "");
  }
});

$("header-create").addEventListener("click", () => {
  void createPage();
});
$("doc-crumbs").addEventListener("click", (event) => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>("button[data-kind='document']");
  if (button?.dataset.id) openDocument(button.dataset.id);
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
  $("theme-toggle").innerHTML = iconSvg(dark ? "Moon" : "Sun");
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
    if (cmd === "underline") chain.toggleUnderline().run();
    if (cmd === "heading") chain.toggleHeading({ level: button.dataset.level === "1" ? 1 : 2 }).run();
    if (cmd === "bullet") chain.toggleBulletList().run();
    if (cmd === "ordered") chain.toggleOrderedList().run();
    if (cmd === "quote") chain.toggleBlockquote().run();
    if (cmd === "code") chain.toggleCodeBlock().run();
    if (cmd === "task") chain.toggleTaskList().run();
    if (cmd === "table") chain.insertTable({ rows: 3, cols: 3, withHeaderRow: true }).run();
    if (cmd === "panel") chain.setNomaPanel(button.dataset.kind === "warning" ? "warning" : "info").run();
    if (cmd === "align-left") chain.setTextAlign("left").run();
    if (cmd === "align-center") chain.setTextAlign("center").run();
    if (cmd === "align-right") chain.setTextAlign("right").run();
  });
});

interface PaletteItem {
  kind: "command" | "document" | "issue" | "person";
  id: string;
  title: string;
  subtitle: string;
}

function paletteItems(query: string): PaletteItem[] {
  const needle = query.trim().toLowerCase();
  const items: PaletteItem[] = [
    { kind: "command", id: "mode:docs", title: "Open Docs", subtitle: "Pages" },
    { kind: "command", id: "mode:visuals", title: "Open Visuals", subtitle: "Whiteboards" },
    { kind: "command", id: "mode:work", title: "Open Work", subtitle: "Board" },
    { kind: "command", id: "mode:reports", title: "Open reports", subtitle: "Work" },
    { kind: "command", id: "mode:backlog", title: "Open backlog", subtitle: "Work" },
    { kind: "command", id: "present", title: "Present", subtitle: "Docs and Visuals" },
    { kind: "command", id: "create-page", title: "Create page", subtitle: "Docs" },
    { kind: "command", id: "find", title: "Find in page", subtitle: "Docs" },
  ];
  for (const doc of payload?.documents ?? []) items.push({ kind: "document", id: doc.id, title: doc.title, subtitle: "Page" });
  for (const issue of payload?.issues ?? []) {
    items.push({ kind: "issue", id: issue.id, title: `${issue.key} ${issue.summary}`, subtitle: issue.typeKey });
  }
  for (const person of payload?.principals ?? []) {
    items.push({ kind: "person", id: person.id, title: person.name, subtitle: person.email ?? "Person" });
  }
  const filtered = needle
    ? items.filter((item) => item.title.toLowerCase().includes(needle) || item.subtitle.toLowerCase().includes(needle))
    : items;
  return filtered.slice(0, 12);
}

function renderPalette(): void {
  const items = paletteItems($<HTMLInputElement>("command-input").value);
  paletteIndex = Math.min(paletteIndex, Math.max(0, items.length - 1));
  $("command-list").innerHTML = items
    .map(
      (item, index) =>
        `<button type="button" class="ew-palette-item${index === paletteIndex ? " is-active" : ""}" role="option" data-kind="${item.kind}" data-id="${escapeHtml(item.id)}">
          <strong>${escapeHtml(item.title)}</strong><small>${escapeHtml(item.subtitle)}</small>
        </button>`,
    )
    .join("") || `<div class="ew-meta">No matches</div>`;
}

function openPalette(): void {
  $("command-palette").hidden = false;
  $<HTMLInputElement>("command-input").value = "";
  paletteIndex = 0;
  renderPalette();
  hydrateIcons($("command-palette"));
  $<HTMLInputElement>("command-input").focus();
}

function closePalette(): void {
  $("command-palette").hidden = true;
}

function runPalette(kind: string, id: string): void {
  closePalette();
  if (id === "mode:docs") setMode("docs");
  if (id === "mode:visuals") setMode("visuals");
  if (id === "mode:work") setMode("work");
  if (id === "mode:reports") {
    setMode("work");
    boardView = "reports";
    renderBoard();
  }
  if (id === "mode:backlog") {
    setMode("work");
    boardView = "backlog";
    renderBoard();
  }
  if (id === "present") setPresenting(true);
  if (id === "create-page") void createPage();
  if (id === "find") {
    setMode("docs");
    openPageFind();
  }
  if (kind === "document") {
    setMode("docs");
    openDocument(id);
  }
  if (kind === "issue") {
    setMode("work");
    void inspectIssue(id);
  }
}

$("command-input").addEventListener("input", () => {
  paletteIndex = 0;
  renderPalette();
});
$("command-list").addEventListener("click", (event) => {
  const item = (event.target as HTMLElement).closest<HTMLButtonElement>("[data-kind][data-id]");
  if (item?.dataset.kind && item.dataset.id) runPalette(item.dataset.kind, item.dataset.id);
});
$("command-palette").addEventListener("click", (event) => {
  if (event.target === $("command-palette")) closePalette();
});

document.addEventListener("keydown", (event) => {
  const target = event.target as HTMLElement;
  const typing = Boolean(target.closest("input, textarea, select, [contenteditable='true']"));
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "z" && mode === "visuals") {
    if (!typing) {
      event.preventDefault();
      void undoCanvas();
      return;
    }
  }
  if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
    event.preventDefault();
    if ($("command-palette").hidden) openPalette();
    else closePalette();
    return;
  }
  if (!$("command-palette").hidden) {
    const items = paletteItems($<HTMLInputElement>("command-input").value);
    if (event.key === "Escape") {
      event.preventDefault();
      closePalette();
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      paletteIndex = Math.min(items.length - 1, paletteIndex + 1);
      renderPalette();
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      paletteIndex = Math.max(0, paletteIndex - 1);
      renderPalette();
    }
    if (event.key === "Enter") {
      const item = items[paletteIndex];
      if (item) {
        event.preventDefault();
        runPalette(item.kind, item.id);
      }
    }
    return;
  }
  if (mode === "docs" && (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "f") {
    event.preventDefault();
    openPageFind();
    return;
  }
  if (presenting && event.key === "Escape") {
    event.preventDefault();
    setPresenting(false);
    return;
  }
  const findBar = document.getElementById("page-find");
  if (findBar && !findBar.hidden && event.key === "Escape") {
    event.preventDefault();
    closePageFind();
    return;
  }
  if (mode === "visuals" && (event.key === "Delete" || event.key === "Backspace") && !typing) {
    event.preventDefault();
    void deleteCanvasSelection();
  }
});

$("board-filters").addEventListener("click", (event) => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>("button");
  if (!button) return;
  if (button.id === "swimlane-epic") {
    swimlanes = !swimlanes;
    renderBoard();
    return;
  }
  if (button.id === "view-list") {
    boardView = "list";
    renderBoard();
    if (selectedIssueId) void inspectIssue(selectedIssueId);
    return;
  }
  if (button.id === "view-board") {
    boardView = "board";
    renderBoard();
    if (selectedIssueId) void inspectIssue(selectedIssueId);
    return;
  }
  if (button.id === "view-reports") {
    boardView = "reports";
    renderBoard();
    return;
  }
  if (button.id === "view-backlog") {
    boardView = "backlog";
    renderBoard();
    if (selectedIssueId) void inspectIssue(selectedIssueId);
    return;
  }
  if (!button.dataset.filter) return;
  const next = button.dataset.filter;
  boardFilter = next === "mine" || next === "unassigned" || next === "overdue" || next === "flagged" || next === "watching" ? next : "all";
  renderBoard();
});
$("type-filters").addEventListener("click", (event) => {
  const button = (event.target as HTMLElement).closest<HTMLButtonElement>("button[data-type]");
  if (button?.dataset.type === undefined) return;
  typeFilter = button.dataset.type;
  renderBoard();
});
$("filter-epic").addEventListener("change", (event) => {
  epicFilter = (event.target as HTMLSelectElement).value;
  renderBoard();
});
$("board-search").addEventListener("input", (event) => {
  boardSearch = (event.target as HTMLInputElement).value.trim().toLowerCase();
  renderBoard();
});

$("work-board").addEventListener("keydown", (event) => {
  const target = event.target as HTMLElement;
  if ((event.key === "Enter" || event.key === " ") && (target.closest(".ew-card") || target.closest(".ew-row")) && !target.classList.contains("ew-column-add")) {
    const card = target.closest<HTMLElement>("[data-issue].ew-card");
    if (card?.dataset.issue) {
      event.preventDefault();
      void inspectIssue(card.dataset.issue);
    }
    return;
  }
  if (event.key !== "Enter" || !target.classList.contains("ew-column-add")) return;
  const summary = (target as HTMLInputElement).value.trim();
  const status = target.dataset.status ?? "backlog";
  const project = currentProject();
  if (!summary || !project) return;
  void (async () => {
    const created = await api<{ id: string }>(`/v1/projects/${encodeURIComponent(project.id)}/issues`, {
      method: "POST",
      body: JSON.stringify({ summary, typeKey: "task" }),
    });
    await transitionIssueTo(created.id, "backlog", status);
    await refreshWorkspace();
    renderBoard();
  })();
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
    html: () => collab?.editor()?.getHTML() ?? "",
    selectAll: () => Boolean(collab?.editor()?.chain().focus().selectAll().run()),
    findInPage: (query: string) => runPageFind(query),
    counts: () => collab?.counts() ?? { words: 0, characters: 0 },
    boardView: () => boardView,
    presenting: () => presenting,
    undoCanvas,
    deleteCanvas: deleteCanvasSelection,
    openPalette,
    applyBoardDrop,
  },
});

hydrateIcons();
bindWorkspaceMentions();

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
