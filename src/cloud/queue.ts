/** One pass of Noma Cloud's background work: webhook deliveries, due digests, and the email outbox. */
import type { NomaCloudDatabase } from "../cloud-db.js";
import type { CloudServerConfig } from "./context.js";
import { buildDueDigests, drainEmailOutbox, type EmailDrainResult, type MailTransport } from "./mail.js";
import { type DrainResult, drainWebhookQueue } from "./webhooks.js";

export interface CloudQueueTickResult {
  webhooks: DrainResult;
  digestsQueued: number;
  emails: EmailDrainResult;
}

/** Runs every queue once against a store; used by the in-process timer and `apps/worker/cloud-queue.ts`. */
export async function runCloudQueueTick(store: NomaCloudDatabase, now: () => Date, transport?: MailTransport): Promise<CloudQueueTickResult> {
  const webhooks = await drainWebhookQueue(store, now);
  const digestsQueued = buildDueDigests(store, now());
  const emails = await drainEmailOutbox(store, now, transport);
  return { webhooks, digestsQueued, emails };
}

const running = new WeakSet<CloudServerConfig>();

/** Timer entry point: never overlaps itself and never throws into the event loop. */
export async function runServerQueueTick(config: CloudServerConfig): Promise<CloudQueueTickResult | undefined> {
  if (running.has(config)) return undefined;
  running.add(config);
  try {
    return await runCloudQueueTick(config.store, config.now);
  } catch {
    return undefined;
  } finally {
    running.delete(config);
  }
}
