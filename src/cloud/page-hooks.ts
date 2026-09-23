/**
 * Side effects of a saved page shared by every write path (`createDocument`, `updateDocument`):
 * source mentions, the inline task index, and other derived indexes. Runs after the record is committed.
 */
import type { CloudDocumentRecord, CloudUserRecord } from "../cloud-db.js";
import type { CloudServerConfig } from "./context.js";
import { notifySourceMentions } from "./mentions.js";
import { indexPageTasks } from "./tasks.js";

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
  indexPageTasks(config, record, actor.user?.id, actor.name);
}
