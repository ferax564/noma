/**
 * `/api/tasks` ("My tasks" across spaces) and `/api/documents/:id/tasks[/:taskId]`. Completing a
 * task rewrites only that list item through a block-level `replace_body` patch, guarded by the
 * item's `baseHash` and the page hash, so the `.noma` source stays the single source of truth.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { walk } from "../ast.js";
import type { CloudDocumentRecord, CloudPageTask, CloudPageTaskStatus } from "../cloud-db.js";
import { parse } from "../parser.js";
import { blockSourceHash, PatchError, patchSource } from "../patch.js";
import { type AccessContext, type CloudServerConfig, type Principal, recordActivity, requireRecordAccess, requireUser, roleRank } from "./context.js";
import { HttpError, readJsonBody, sendJson, sha256Hex } from "./http.js";
import { assertCloudId, boundedInteger, numberQuery, optionalCloudId } from "./input.js";
import { updateDocument } from "./records.js";
import { displayTaskText, toggledTaskContent } from "./tasks.js";

export function routeTasks(req: IncomingMessage, res: ServerResponse, url: URL, config: CloudServerConfig, principal: Principal): void {
  if ((req.method ?? "GET") !== "GET") throw new HttpError(405, "Method not allowed");
  const user = requireUser(principal);
  const assignee = url.searchParams.get("assignee") ?? "me";
  const status = url.searchParams.get("status") ?? "open";
  if (status !== "open" && status !== "done" && status !== "all") throw new HttpError(400, "status must be open, done, or all");
  let assigneeId: string | undefined;
  if (assignee === "me") assigneeId = user.id;
  else if (assignee !== "any") {
    assertCloudId(assignee, "Assignee");
    assigneeId = assignee;
  }
  const tasks = config.store.listVisibleTasks(user, {
    ...(assigneeId ? { assigneeId } : {}),
    ...(status === "all" ? {} : { status: status as CloudPageTaskStatus }),
    ...(optionalCloudId(url.searchParams.get("site"), "Site") ? { siteId: url.searchParams.get("site")! } : {}),
    ...(optionalCloudId(url.searchParams.get("document"), "Document") ? { documentId: url.searchParams.get("document")! } : {}),
    limit: boundedInteger(numberQuery(url.searchParams.get("limit")), 100, 1, 500, "limit"),
  });
  const today = config.now().toISOString().slice(0, 10);
  const hashes = new Map<string, Map<string, string>>();
  sendJson(res, 200, {
    tasks: tasks.map((task) => {
      if (!hashes.has(task.documentId)) hashes.set(task.documentId, taskBlockHashes(config.store.readDocument(task.documentId)?.source ?? ""));
      return { ...taskResponse(task, hashes.get(task.documentId)!, today), documentTitle: task.documentTitle, siteId: task.siteId, assigneeName: task.assigneeName, access: task.access };
    }),
  });
}

/** `GET /api/documents/:id/tasks` and `POST /api/documents/:id/tasks/:taskId {done, baseHash}`. */
export async function routeDocumentTasks(
  req: IncomingMessage,
  res: ServerResponse,
  taskId: string | undefined,
  config: CloudServerConfig,
  principal: Principal,
  document: CloudDocumentRecord,
  inheritedAccess?: AccessContext,
): Promise<void> {
  const method = req.method ?? "GET";
  const access = inheritedAccess ?? requireRecordAccess(config, document, principal, "viewer");
  const today = config.now().toISOString().slice(0, 10);
  if (!taskId && method === "GET") {
    const hashes = taskBlockHashes(document.source);
    sendJson(res, 200, { documentId: document.id, tasks: config.store.listPageTasks(document.id).map((task) => taskResponse(task, hashes, today)) });
    return;
  }
  if (!taskId) throw new HttpError(405, "Method not allowed");
  const task = config.store.readPageTask(document.id, taskId);
  if (!task) throw new HttpError(404, "Task not found");
  if (method === "GET") {
    sendJson(res, 200, taskResponse(task, taskBlockHashes(document.source), today));
    return;
  }
  if (method !== "POST" && method !== "PATCH") throw new HttpError(405, "Method not allowed");
  const isAssignee = Boolean(access.user && task.assigneeId === access.user.id);
  if (roleRank[access.role] < roleRank.editor && !isAssignee) throw new HttpError(403, "Only editors or the assignee can complete this task");
  const input = await readJsonBody(req, config.maxBodyBytes);
  if (typeof input.done !== "boolean") throw new HttpError(400, "done must be a boolean");
  const baseHash = input.baseHash === undefined ? undefined : typeof input.baseHash === "string" ? input.baseHash : "";
  if (baseHash !== undefined && !/^[a-f0-9]{8,64}$/.test(baseHash)) throw new HttpError(400, "baseHash must be 8-64 lowercase hex characters");
  const item = [...walk(parse(document.source, { filename: `${document.id}.noma` }))].find((node) => node.type === "list_item" && node.id === taskId);
  const content = item?.type === "list_item" ? toggledTaskContent(taskId, item.content, input.done) : undefined;
  if (!content) throw new HttpError(409, "The task is no longer a checkbox item in the page source", { code: "task_changed" });
  if ((task.status === "done") === input.done && item?.type === "list_item" && (/^\[[xX]\]/.test(item.content.trim()) === input.done)) {
    sendJson(res, 200, { ...taskResponse(task, taskBlockHashes(document.source), today), changed: false });
    return;
  }
  let source: string;
  try {
    source = patchSource(document.source, { op: "replace_body", id: taskId, content, ...(baseHash ? { baseHash } : {}) });
  } catch (error) {
    if (error instanceof PatchError && error.code === "sha_mismatch") {
      throw new HttpError(409, "The task changed since it was loaded", { code: "task_changed", currentHash: blockSourceHash(document.source, taskId) });
    }
    throw new HttpError(409, error instanceof Error ? error.message : "Task patch failed", { code: "task_changed" });
  }
  const updated = await updateDocument(config, document, { source }, access);
  if (access.user) recordActivity(config, access.user, input.done ? "task.completed" : "task.reopened", "document", document.id, { taskId, text: displayTaskText(task.text) });
  const next = config.store.readPageTask(document.id, taskId) ?? task;
  sendJson(res, 200, { ...taskResponse(next, taskBlockHashes(updated.source), today), changed: true, documentHash: updated.hash });
}

/** `blockSourceHash` for every identified list item, computed from one parse of the page. */
function taskBlockHashes(source: string): Map<string, string> {
  const lines = source.split("\n");
  const hashes = new Map<string, string>();
  for (const node of walk(parse(source))) {
    if (node.type !== "list_item" || !node.id || !node.pos?.line || hashes.has(node.id)) continue;
    hashes.set(node.id, sha256Hex(lines.slice(node.pos.line - 1, node.endLine ?? node.pos.line).join("\n")));
  }
  return hashes;
}

function taskResponse(task: CloudPageTask, hashes: Map<string, string>, today: string): Record<string, unknown> {
  const blockHash = hashes.get(task.taskId);
  return {
    ...task,
    title: displayTaskText(task.text),
    overdue: task.status === "open" && Boolean(task.dueDate && task.dueDate < today),
    ...(blockHash ? { blockHash } : {}),
  };
}

