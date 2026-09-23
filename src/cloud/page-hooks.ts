/**
 * Side effects of a saved page shared by every write path (`createDocument`, `updateDocument`):
 * source mentions, the inline task index, and other derived indexes. Runs after the record is committed.
 */
import type { CloudDocumentRecord, CloudUserRecord } from "../cloud-db.js";
import type { CloudServerConfig } from "./context.js";
import { notifySourceMentions } from "./mentions.js";
import { displayTaskText, indexPageTasks } from "./tasks.js";
import { emitPageWebhookEvent } from "./webhooks.js";

export interface PageSaveActor {
  user?: CloudUserRecord;
  /** Display name for notifications, e.g. the user name or "A share-link editor". */
  name: string;
}

export function afterDocumentSaved(
  config: CloudServerConfig,
  previous: CloudDocumentRecord | undefined,
  record: CloudDocumentRecord,
  actor: PageSaveActor,
): void {
  if (previous && previous.source === record.source) return;
  notifySourceMentions(config, record, previous?.source, actor.user?.id, actor.name);
  const tasks = indexPageTasks(config, record, actor.user?.id, actor.name);
  emitPageWebhookEvent(config, previous ? "page.updated" : "page.created", record, actor.user, previous ? { previousHash: previous.hash } : undefined);
  for (const task of tasks.completed) {
    emitPageWebhookEvent(config, "task.completed", record, actor.user, {
      task: { id: task.taskId, title: displayTaskText(task.text), assigneeId: task.assigneeId ?? null, dueDate: task.dueDate ?? null, completedAt: task.completedAt ?? null },
    });
  }
}
