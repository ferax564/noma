/**
 * Inline page tasks. A task is a top-level list item whose text starts with a checkbox:
 * `- {#task-id} [ ] Do the thing @{userId} due:2026-10-01`. Human saves give new tasks a stable
 * `{#task-…}` ID in the source, every save re-indexes them into `page_tasks`, and newly assigned
 * people with access to the page are notified.
 */
import { randomBytes } from "node:crypto";
import { walk } from "../ast.js";
import type { CloudDocumentRecord, CloudPageTask, CloudPageTaskChanges } from "../cloud-db.js";
import { parse } from "../parser.js";
import { type CloudServerConfig, writeNotification } from "./context.js";
import { extractMentions } from "./mentions.js";

const TASK_CONTENT_RE = /^\[( |x|X)\]\s+(\S.*)$/;
const UNIDENTIFIED_TASK_LINE_RE = /^([-*]\s+)(?!\{#)(\[[ xX]\]\s+\S)/;
const DUE_RE = /(?:^|\s)due:(\d{4}-\d{2}-\d{2})(?=\s|$)/;
const MAX_TASKS_PER_PAGE = 1_000;

export type ParsedPageTask = Omit<CloudPageTask, "updatedAt" | "completedAt" | "completedBy">;

/** Gives every checkbox list item without a stable ID a fresh `{#task-…}` marker. Fenced code is left alone. */
export function assignTaskIds(source: string): string {
  const lines = source.split("\n");
  let fence: string | undefined;
  let changed = false;
  const existing = new Set<string>();
  for (const node of walk(parse(source))) if (node.id) existing.add(node.id);
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!;
    const fenceMatch = /^(```|~~~)/.exec(line.trim());
    if (fenceMatch) {
      if (!fence) fence = fenceMatch[1];
      else if (line.trim().startsWith(fence)) fence = undefined;
      continue;
    }
    if (fence) continue;
    const match = UNIDENTIFIED_TASK_LINE_RE.exec(line);
    if (!match) continue;
    let id = newTaskId();
    while (existing.has(id)) id = newTaskId();
    existing.add(id);
    lines[index] = `${match[1]}{#${id}} ${line.slice(match[1]!.length)}`;
    changed = true;
  }
  return changed ? lines.join("\n") : source;
}

/** Tasks with stable IDs in a page, in source order. */
export function parsePageTasks(document: CloudDocumentRecord): ParsedPageTask[] {
  const tasks: ParsedPageTask[] = [];
  const seen = new Set<string>();
  for (const node of walk(parse(document.source, { filename: `${document.id}.noma` }))) {
    if (node.type !== "list_item" || !node.id || seen.has(node.id)) continue;
    const match = TASK_CONTENT_RE.exec(node.content.trim());
    if (!match) continue;
    seen.add(node.id);
    const text = match[2]!.trim();
    const assigneeId = extractMentions(text)[0];
    const due = DUE_RE.exec(text)?.[1];
    tasks.push({
      documentId: document.id,
      taskId: node.id,
      text: text.slice(0, 2_000),
      status: match[1] === " " ? "open" : "done",
      ...(assigneeId ? { assigneeId } : {}),
      ...(due && Number.isFinite(Date.parse(`${due}T00:00:00Z`)) ? { dueDate: due } : {}),
      line: node.pos?.line ?? 0,
    });
    if (tasks.length >= MAX_TASKS_PER_PAGE) break;
  }
  return tasks;
}

/** Re-indexes a saved page's tasks and notifies newly assigned people who can open the page. */
export function indexPageTasks(config: CloudServerConfig, document: CloudDocumentRecord, actorId: string | undefined, actorName: string): CloudPageTaskChanges {
  const changes = config.store.replacePageTasks(document.id, parsePageTasks(document), actorId, config.now().toISOString());
  for (const task of changes.assigned) {
    if (!task.assigneeId || task.assigneeId === actorId || task.status === "done") continue;
    if (!config.store.documentAccessRole(task.assigneeId, document.id)) continue;
    const due = task.dueDate ? ` (due ${task.dueDate})` : "";
    writeNotification(config, task.assigneeId, "task_assigned", `Task assigned on ${document.title}`, `${actorName} assigned you: ${displayTaskText(task.text)}${due}`, "document", document.id);
  }
  return changes;
}

/** Task text for notifications and lists: mentions and the due marker removed. */
export function displayTaskText(text: string): string {
  return text.replace(/@\{[A-Za-z0-9_-]{8,80}\}/g, "").replace(DUE_RE, " ").replace(/\s+/g, " ").trim().slice(0, 240);
}

/** New list-item body for a checkbox toggle; `replace_body` keeps the item's `{#id}` marker itself. */
export function toggledTaskContent(content: string, done: boolean): string | undefined {
  const match = TASK_CONTENT_RE.exec(content.trim());
  if (!match) return undefined;
  return `[${done ? "x" : " "}] ${match[2]!.trim()}`;
}

function newTaskId(): string {
  return `task-${randomBytes(6).toString("base64url").replace(/[^A-Za-z0-9]/g, "").toLowerCase().slice(0, 8).padEnd(8, "0")}`;
}
