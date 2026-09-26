/** One pass of Noma Cloud's background work: webhook deliveries, due digests, the email outbox, embedding backfill, daily chat retention, and dev-loop run polling. */
import type { NomaCloudDatabase } from "../cloud-db.js";
import type { CloudKnowledgePlatform, EmbeddingBackfillResult } from "../cloud-platform.js";
import type { CloudServerConfig } from "./context.js";
import { pollDevRuns } from "./devloop.js";
import { enforceChatRetention } from "./routes-chat.js";
import { buildDueDigests, drainEmailOutbox, type EmailDrainResult, type MailTransport } from "./mail.js";
import { type DrainResult, drainWebhookQueue } from "./webhooks.js";

export interface CloudQueueTickResult {
  webhooks: DrainResult;
  digestsQueued: number;
  emails: EmailDrainResult;
  /** Present when a knowledge platform was passed: one embedding backfill pass. */
  embeddings?: EmbeddingBackfillResult;
}

/** Runs every queue once against a store; used by the in-process timer and `apps/worker/cloud-queue.ts`. */
export async function runCloudQueueTick(store: NomaCloudDatabase, now: () => Date, transport?: MailTransport, platform?: CloudKnowledgePlatform): Promise<CloudQueueTickResult> {
  const webhooks = await drainWebhookQueue(store, now);
  const digestsQueued = buildDueDigests(store, now());
  const emails = await drainEmailOutbox(store, now, transport);
  if (!platform) return { webhooks, digestsQueued, emails };
  return { webhooks, digestsQueued, emails, embeddings: await platform.backfillEmbeddings() };
}

const running = new WeakSet<CloudServerConfig>();
const lastChatRetention = new WeakMap<CloudServerConfig, number>();
const CHAT_RETENTION_INTERVAL_MS = 24 * 60 * 60 * 1000;

/** Timer entry point: never overlaps itself and never throws into the event loop. */
export async function runServerQueueTick(config: CloudServerConfig): Promise<CloudQueueTickResult | undefined> {
  if (running.has(config)) return undefined;
  running.add(config);
  try {
    const result = await runCloudQueueTick(config.store, config.now, undefined, config.platform);
    await runDueChatRetention(config);
    await pollDevRuns(config);
    return result;
  } catch {
    return undefined;
  } finally {
    running.delete(config);
  }
}

/** Applies the workspace chat retention policy at most once a day. */
async function runDueChatRetention(config: CloudServerConfig): Promise<void> {
  const days = config.platform.enterprisePolicy().chatRetentionDays ?? 0;
  if (days <= 0) return;
  const now = config.now().getTime();
  if (now - (lastChatRetention.get(config) ?? 0) < CHAT_RETENTION_INTERVAL_MS) return;
  lastChatRetention.set(config, now);
  await enforceChatRetention(config, days, "system");
}
