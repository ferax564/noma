/**
 * Outbound space webhooks: event fan-out into a persisted delivery queue, HMAC-SHA256 signing,
 * SSRF-safe delivery with retries and exponential backoff, and an optional Slack formatter.
 * The queue is drained by an in-process timer and can also be drained by `apps/worker/cloud-queue.ts`.
 */
import { createHmac, randomUUID } from "node:crypto";
import { lookup } from "node:dns";
import { request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP, type LookupFunction } from "node:net";
import type { CloudDocumentRecord, CloudUserRecord, CloudWebhook, CloudWebhookDelivery, CloudWebhookEvent, NomaCloudDatabase } from "../cloud-db.js";
import type { CloudServerConfig } from "./context.js";
import { HttpError } from "./http.js";

export const WEBHOOK_MAX_ATTEMPTS = 8;
const WEBHOOK_TIMEOUT_MS = 10_000;
const WEBHOOK_LEASE_MS = 60_000;
const WEBHOOK_BASE_BACKOFF_MS = 30_000;
const WEBHOOK_MAX_BACKOFF_MS = 6 * 60 * 60 * 1000;
const WEBHOOK_MAX_RESPONSE_BYTES = 16_384;

export interface WebhookEventContext {
  actor?: CloudUserRecord;
  document?: CloudDocumentRecord;
  data?: Record<string, unknown>;
}

/** True when `NOMA_CLOUD_ALLOW_PRIVATE_WEBHOOKS=1` opts out of the private-network block (tests, on-prem). */
export function privateWebhooksAllowed(): boolean {
  return /^(?:1|true|yes)$/i.test(process.env.NOMA_CLOUD_ALLOW_PRIVATE_WEBHOOKS?.trim() ?? "");
}

/** Loopback, private, link-local, CGNAT, multicast, unspecified, and IPv4-mapped equivalents. */
export function isPrivateAddress(address: string): boolean {
  const version = isIP(address);
  if (version === 4) {
    const [a = 0, b = 0] = address.split(".").map(Number);
    return (
      a === 0 || a === 10 || a === 127 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) || (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19)) || a >= 224
    );
  }
  if (version === 6) {
    const lower = address.toLowerCase();
    const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower)?.[1];
    if (mapped) return isPrivateAddress(mapped);
    if (lower === "::" || lower === "::1") return true;
    const first = Number.parseInt(lower.split(":")[0] || "0", 16);
    return (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80 || (first & 0xff00) === 0xff00 || lower.startsWith("64:ff9b:");
  }
  return true;
}

/** Validates a webhook target URL: http(s), no credentials, and not a literal private address. */
export function webhookUrlInput(value: unknown): string {
  if (typeof value !== "string" || value.length > 2_000) throw new HttpError(400, "url must be an absolute http(s) URL");
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new HttpError(400, "url must be an absolute http(s) URL");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") throw new HttpError(400, "url must use http or https");
  if (url.username || url.password) throw new HttpError(400, "url must not contain credentials");
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (!privateWebhooksAllowed() && (host === "localhost" || host.endsWith(".localhost") || (isIP(host) && isPrivateAddress(host)))) {
    throw new HttpError(400, "url must not point at a private, loopback, or link-local address", { code: "webhook_private_address" });
  }
  url.hash = "";
  return url.toString();
}

/**
 * Queues `event` for every webhook in the page's spaces (or `siteIds`) that subscribes to it.
 * Pages under a view restriction (their own or an ancestor's) never leave the workspace this way.
 */
export function emitWebhookEvent(config: CloudServerConfig, event: CloudWebhookEvent, siteIds: string[], context: WebhookEventContext): number {
  let queued = 0;
  if (context.document && config.store.documentRestrictionCap(undefined, context.document.id) === "hidden") return 0;
  const createdAt = config.now().toISOString();
  for (const siteId of [...new Set(siteIds)]) {
    const site = config.store.readSite(siteId);
    if (!site || config.store.isTrashed("site", siteId)) continue;
    for (const hook of config.store.listWebhooks(siteId)) {
      if (!hook.events.includes(event)) continue;
      const id = `whd_${randomUUID().replace(/-/g, "")}`;
      const payload: Record<string, unknown> = {
        id,
        event,
        createdAt,
        space: { id: site.id, title: site.title, ...(site.key ? { key: site.key } : {}) },
        ...(context.document ? { page: { id: context.document.id, title: context.document.title, hash: context.document.hash, url: `/cloud.html?site=${encodeURIComponent(site.id)}&doc=${encodeURIComponent(context.document.id)}` } } : {}),
        ...(context.actor ? { actor: { id: context.actor.id, name: context.actor.name } } : {}),
        ...(context.data ?? {}),
      };
      config.store.enqueueWebhookDelivery({ id, webhookId: hook.id, siteId, event, payload, nextAttemptAt: createdAt, createdAt });
      queued += 1;
    }
  }
  if (queued > 0) scheduleQueueDrain(config);
  return queued;
}

/** Page-level convenience: fans out to every space that contains the document. */
export function emitPageWebhookEvent(config: CloudServerConfig, event: CloudWebhookEvent, document: CloudDocumentRecord, actor: CloudUserRecord | undefined, data?: Record<string, unknown>): number {
  const siteIds = config.store.siteIdsForDocument(document.id);
  if (siteIds.length === 0) return 0;
  return emitWebhookEvent(config, event, siteIds, { document, ...(actor ? { actor } : {}), ...(data ? { data } : {}) });
}

/** `sha256=<hex>` HMAC over `<timestamp>.<body>`, sent as `x-noma-signature`. */
export function webhookSignature(secret: string, timestamp: string, body: string): string {
  return `sha256=${createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex")}`;
}

/** Slack incoming-webhook body: `{text}` with a one-line summary of the event. */
export function slackWebhookBody(payload: Record<string, unknown>): { text: string } {
  const space = payload.space as { title?: string; key?: string } | undefined;
  const page = payload.page as { title?: string } | undefined;
  const actor = (payload.actor as { name?: string } | undefined)?.name ?? "Someone";
  const where = `${page?.title ? `“${page.title}”` : "a page"}${space?.title ? ` in ${space.key ? `${space.key} · ` : ""}${space.title}` : ""}`;
  const verbs: Record<string, string> = {
    "page.created": "created",
    "page.updated": "updated",
    "page.deleted": "moved to trash",
    "comment.created": "commented on",
    "label.changed": "changed labels on",
    "task.completed": "completed a task on",
  };
  const detail =
    payload.event === "comment.created"
      ? `: ${String((payload.comment as { body?: string } | undefined)?.body ?? "").slice(0, 200)}`
      : payload.event === "task.completed"
        ? `: ${String((payload.task as { title?: string } | undefined)?.title ?? "")}`
        : payload.event === "label.changed"
          ? `: ${((payload.labels as string[] | undefined) ?? []).join(", ") || "no labels"}`
          : "";
  return { text: `${actor} ${verbs[String(payload.event)] ?? String(payload.event)} ${where}${detail}` };
}

export interface DrainResult {
  attempted: number;
  delivered: number;
  failed: number;
  retrying: number;
}

/**
 * Sends due deliveries. Success is any 2xx; anything else retries with exponential backoff
 * (30s, 1m, 2m … capped at 6h) until `WEBHOOK_MAX_ATTEMPTS`, then the delivery is marked failed.
 */
export async function drainWebhookQueue(store: NomaCloudDatabase, now: () => Date, limit = 25): Promise<DrainResult> {
  const started = now();
  const due = store.claimDueWebhookDeliveries(started.toISOString(), new Date(started.getTime() + WEBHOOK_LEASE_MS).toISOString(), limit);
  const result: DrainResult = { attempted: due.length, delivered: 0, failed: 0, retrying: 0 };
  await Promise.all(
    due.map(async (delivery) => {
      const hook = store.readWebhook(delivery.webhookId);
      if (!hook) {
        store.completeWebhookDelivery(delivery.id, { status: "failed", attempts: delivery.attempts, nextAttemptAt: delivery.nextAttemptAt, lastError: "Webhook was deleted" });
        result.failed += 1;
        return;
      }
      const outcome = await sendDelivery(hook, delivery, now());
      const attempts = delivery.attempts + 1;
      const finishedAt = now();
      if (outcome.ok) {
        store.completeWebhookDelivery(delivery.id, { status: "delivered", attempts, nextAttemptAt: finishedAt.toISOString(), responseStatus: outcome.status, deliveredAt: finishedAt.toISOString() });
        result.delivered += 1;
      } else if (attempts >= WEBHOOK_MAX_ATTEMPTS || outcome.permanent) {
        store.completeWebhookDelivery(delivery.id, { status: "failed", attempts, nextAttemptAt: finishedAt.toISOString(), ...(outcome.status ? { responseStatus: outcome.status } : {}), lastError: outcome.error });
        result.failed += 1;
      } else {
        const backoff = Math.min(WEBHOOK_MAX_BACKOFF_MS, WEBHOOK_BASE_BACKOFF_MS * 2 ** (attempts - 1));
        store.completeWebhookDelivery(delivery.id, {
          status: "pending",
          attempts,
          nextAttemptAt: new Date(finishedAt.getTime() + backoff).toISOString(),
          ...(outcome.status ? { responseStatus: outcome.status } : {}),
          lastError: outcome.error,
        });
        result.retrying += 1;
      }
    }),
  );
  if (due.length > 0) store.pruneWebhookDeliveries(new Date(started.getTime() - 30 * 86_400_000).toISOString());
  return result;
}

interface DeliveryOutcome {
  ok: boolean;
  status?: number;
  error: string;
  permanent?: boolean;
}

async function sendDelivery(hook: CloudWebhook, delivery: CloudWebhookDelivery, at: Date): Promise<DeliveryOutcome> {
  const body = JSON.stringify(hook.format === "slack" ? slackWebhookBody(delivery.payload) : delivery.payload);
  const timestamp = String(Math.floor(at.getTime() / 1000));
  let url: URL;
  try {
    url = new URL(hook.url);
  } catch {
    return { ok: false, error: "Invalid webhook URL", permanent: true };
  }
  const host = url.hostname.replace(/^\[|\]$/g, "");
  if (!privateWebhooksAllowed() && isIP(host) && isPrivateAddress(host)) return { ok: false, error: "Blocked private address", permanent: true };
  const send = url.protocol === "https:" ? httpsRequest : httpRequest;
  return new Promise<DeliveryOutcome>((resolve) => {
    const req = send(
      url,
      {
        method: "POST",
        lookup: safeLookup,
        timeout: WEBHOOK_TIMEOUT_MS,
        headers: {
          "content-type": "application/json",
          "content-length": Buffer.byteLength(body),
          "user-agent": "NomaCloud-Webhooks/1",
          "x-noma-event": delivery.event,
          "x-noma-delivery": delivery.id,
          "x-noma-timestamp": timestamp,
          "x-noma-signature": webhookSignature(hook.secret, timestamp, body),
        },
      },
      (res) => {
        let received = 0;
        res.on("data", (chunk: Buffer) => {
          received += chunk.length;
          if (received > WEBHOOK_MAX_RESPONSE_BYTES) res.destroy();
        });
        res.on("close", () => {
          const status = res.statusCode ?? 0;
          resolve(status >= 200 && status < 300 ? { ok: true, status, error: "" } : { ok: false, status, error: `HTTP ${status}` });
        });
        res.on("error", () => undefined);
      },
    );
    req.on("timeout", () => req.destroy(new Error("Webhook request timed out")));
    req.on("error", (error: Error & { code?: string }) => resolve({ ok: false, error: error.message.slice(0, 300), permanent: error.code === "WEBHOOK_PRIVATE_ADDRESS" }));
    req.end(body);
  });
}

/** DNS lookup that refuses to connect to private addresses, so DNS rebinding cannot reach internal hosts. */
const safeLookup: LookupFunction = (hostname, options, callback) => {
  lookup(hostname, { ...options, all: true }, (error, addresses) => {
    if (error) {
      callback(error, "", 4);
      return;
    }
    const list = Array.isArray(addresses) ? addresses : [{ address: String(addresses), family: 4 }];
    if (!privateWebhooksAllowed() && list.some((entry) => isPrivateAddress(entry.address))) {
      const blocked = Object.assign(new Error(`Blocked private address for ${hostname}`), { code: "WEBHOOK_PRIVATE_ADDRESS" });
      callback(blocked, "", 4);
      return;
    }
    if (options.all) callback(null, list);
    else callback(null, list[0]?.address ?? "", list[0]?.family ?? 4);
  });
};

const drainTimers = new WeakMap<CloudServerConfig, { pending: boolean; running: boolean }>();

/** Drains soon after an enqueue, without overlapping an in-flight drain. */
export function scheduleQueueDrain(config: CloudServerConfig): void {
  const state = drainTimers.get(config) ?? { pending: false, running: false };
  drainTimers.set(config, state);
  if (state.pending) return;
  state.pending = true;
  setImmediate(() => {
    state.pending = false;
    void runQueueDrain(config);
  });
}

/** One drain pass for this server; no-op while another pass is running. */
export async function runQueueDrain(config: CloudServerConfig): Promise<DrainResult | undefined> {
  const state = drainTimers.get(config) ?? { pending: false, running: false };
  drainTimers.set(config, state);
  if (state.running) return undefined;
  state.running = true;
  try {
    return await drainWebhookQueue(config.store, config.now);
  } catch {
    return undefined;
  } finally {
    state.running = false;
  }
}
