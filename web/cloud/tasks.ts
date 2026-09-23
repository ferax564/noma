/** "My tasks" rail list and clickable checkboxes for inline `- [ ]` tasks in the preview. */
import { CloudRequestError, fetchCloudJson } from "./api.js";
import { reloadCurrentPage } from "./editor.js";
import { loadSite, loadStandaloneDocument, selectPage } from "./navigation.js";
import { canEditPage } from "./permissions.js";
import { state } from "./state.js";
import { emptyState, errorMessage, setCloudStatus } from "./util.js";

interface TaskItem {
  documentId: string;
  documentTitle?: string;
  siteId?: string;
  taskId: string;
  title: string;
  status: "open" | "done";
  assigneeId?: string;
  dueDate?: string;
  overdue: boolean;
  blockHash?: string;
}

const list = requireElement<HTMLElement>("myTasksList");
const refreshButton = requireElement<HTMLButtonElement>("myTasksRefreshButton");
let tasks: TaskItem[] = [];

export function bindTasks(): void {
  refreshButton.addEventListener("click", () => void refreshMyTasks());
}

export async function refreshMyTasks(): Promise<void> {
  if (!state.cloudUser) {
    tasks = [];
    renderMyTasks();
    return;
  }
  try {
    tasks = (await fetchCloudJson<{ tasks: TaskItem[] }>("/api/tasks?assignee=me&status=open&limit=50")).tasks;
  } catch {
    tasks = [];
  }
  renderMyTasks();
}

function renderMyTasks(): void {
  list.textContent = "";
  refreshButton.disabled = !state.cloudUser;
  if (tasks.length === 0) {
    list.append(emptyState(state.cloudUser ? "No open tasks" : "Sign in to see your tasks"));
    return;
  }
  for (const task of tasks) {
    const row = document.createElement("div");
    row.className = `task-row${task.overdue ? " task-overdue" : ""}`;
    const checkbox = document.createElement("input");
    checkbox.type = "checkbox";
    checkbox.checked = task.status === "done";
    checkbox.setAttribute("aria-label", `Complete ${task.title}`);
    checkbox.addEventListener("change", () => void completeTask(task, checkbox.checked));
    const open = document.createElement("button");
    open.type = "button";
    open.className = "navigation-row";
    const title = document.createElement("span");
    title.className = "row-title";
    title.textContent = task.title || "Untitled task";
    const meta = document.createElement("span");
    meta.className = "row-meta";
    meta.textContent = `${task.documentTitle ?? "Page"}${task.dueDate ? ` · due ${task.dueDate}${task.overdue ? " (overdue)" : ""}` : ""}`;
    open.append(title, meta);
    open.addEventListener("click", () => void openTask(task));
    row.append(checkbox, open);
    list.append(row);
  }
}

async function completeTask(task: TaskItem, done: boolean): Promise<void> {
  const isCurrent = state.currentPage?.id === task.documentId;
  if (isCurrent && state.dirty) {
    setCloudStatus("Save or discard your edits to this page before completing its tasks", "warning");
    renderMyTasks();
    return;
  }
  try {
    await fetchCloudJson(`/api/documents/${encodeURIComponent(task.documentId)}/tasks/${encodeURIComponent(task.taskId)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ done, ...(task.blockHash ? { baseHash: task.blockHash } : {}) }),
    });
    setCloudStatus(done ? "Task completed" : "Task reopened", "ok");
    if (isCurrent) await reloadCurrentPage();
  } catch (error) {
    const changed = error instanceof CloudRequestError && error.status === 409;
    setCloudStatus(changed ? "The task changed since it was loaded; refreshed the list" : errorMessage(error), "error");
  }
  await refreshMyTasks();
}

async function openTask(task: TaskItem): Promise<void> {
  if (state.currentSite && task.siteId === state.currentSite.id && selectPage(task.documentId)) return;
  if (task.siteId) await loadSite(task.siteId, task.documentId);
  else await loadStandaloneDocument(task.documentId);
}

/** Turns the `[ ]` / `[x]` prefix of task list items in the preview into clickable checkboxes. */
export function decoratePreviewTasks(previewDoc: Document | null): void {
  if (!previewDoc?.body || !state.currentPage) return;
  if (!previewDoc.getElementById("noma-task-style")) {
    const style = previewDoc.createElement("style");
    style.id = "noma-task-style";
    style.textContent =
      "li.noma-task-item{list-style:none;margin-left:-1.2em}.noma-task-box{display:inline-block;width:1.4rem;height:1.35rem;overflow:hidden;font-size:0;line-height:1.35rem;vertical-align:-0.25rem;cursor:pointer}.noma-task-box::before{content:'☐';font-size:1.15rem;margin-right:.35em;color:#0f666b}.noma-task-box[data-done='true']::before{content:'☑'}li.noma-task-item[data-done='true']{color:#6b737b;text-decoration:line-through}";
    previewDoc.head.append(style);
  }
  const sourceLines = state.currentPage.source.split("\n");
  const saved = !state.dirty;
  for (const item of [...previewDoc.querySelectorAll<HTMLLIElement>("li[data-noma-line]")]) {
    const first = item.firstChild;
    if (!(first instanceof previewDoc.defaultView!.Text)) continue;
    const match = /^\[( |x|X)\]\s/.exec(first.data);
    if (!match) continue;
    const line = Number(item.dataset.nomaLine);
    const taskId = /^[-*]\s+\{#([^}\s]+)\}/.exec(sourceLines[line - 1] ?? "")?.[1];
    const done = match[1] !== " ";
    const box = previewDoc.createElement("span");
    box.className = "noma-task-box";
    box.dataset.done = String(done);
    box.textContent = first.data.slice(0, 3);
    box.title = taskId && saved ? (done ? "Reopen task" : "Complete task") : "Save the page to track this task";
    first.data = first.data.slice(3);
    item.insertBefore(box, first);
    item.classList.add("noma-task-item");
    item.dataset.done = String(done);
    if (!taskId) continue;
    box.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      if (state.dirty) {
        setCloudStatus("Save the page before completing tasks from the preview", "warning");
        return;
      }
      const task = { documentId: state.currentPage!.id, taskId, title: "", status: done ? "done" : "open", overdue: false } satisfies TaskItem;
      if (!canEditPage() && !tasks.some((candidate) => candidate.taskId === taskId)) {
        setCloudStatus("Only editors or the assignee can complete this task", "warning");
        return;
      }
      void completeTask(task, !done);
    });
  }
}

function requireElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing #${id}`);
  return element as T;
}
