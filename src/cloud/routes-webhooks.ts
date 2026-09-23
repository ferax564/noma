/** `/api/sites/:id/webhooks`: space owners register, list, and delete outbound webhooks and read their delivery log. */
import { randomBytes, randomUUID } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { type CloudSiteRecord, type CloudWebhook, type CloudWebhookEvent, cloudWebhookEvents } from "../cloud-db.js";
import { type CloudServerConfig, type Principal, recordActivity, requireRecordAccess, requireUser } from "./context.js";
import { HttpError, readJsonBody, sendJson } from "./http.js";
import { boundedInteger, numberQuery } from "./input.js";
import { webhookUrlInput } from "./webhooks.js";

const MAX_WEBHOOKS_PER_SPACE = 20;

export async function routeSiteWebhooks(
  req: IncomingMessage,
  res: ServerResponse,
  hookId: string | undefined,
  action: string | undefined,
  config: CloudServerConfig,
  principal: Principal,
  site: CloudSiteRecord,
): Promise<void> {
  const method = req.method ?? "GET";
  const user = requireUser(principal);
  requireRecordAccess(config, site, principal, "owner");

  if (!hookId && method === "GET") {
    sendJson(res, 200, { siteId: site.id, events: cloudWebhookEvents, webhooks: config.store.listWebhooks(site.id).map(webhookResponse) });
    return;
  }

  if (!hookId && method === "POST") {
    const input = await readJsonBody(req, config.maxBodyBytes);
    if (config.store.listWebhooks(site.id).length >= MAX_WEBHOOKS_PER_SPACE) throw new HttpError(409, `A space can have at most ${MAX_WEBHOOKS_PER_SPACE} webhooks`);
    const secret = secretInput(input.secret);
    const webhook: CloudWebhook = {
      id: `wh_${randomUUID().replace(/-/g, "").slice(0, 20)}`,
      siteId: site.id,
      url: webhookUrlInput(input.url),
      events: eventsInput(input.events),
      format: formatInput(input.format),
      secret,
      createdBy: user.id,
      createdAt: config.now().toISOString(),
    };
    config.store.insertWebhook(webhook);
    recordActivity(config, user, "webhook.created", "site", site.id, { webhookId: webhook.id, events: webhook.events });
    sendJson(res, 201, { ...webhookResponse(webhook), secret });
    return;
  }

  if (!hookId) throw new HttpError(405, "Method not allowed");
  const webhook = config.store.readWebhook(hookId);
  if (!webhook || webhook.siteId !== site.id) throw new HttpError(404, "Webhook not found");

  if (!action && method === "GET") {
    sendJson(res, 200, webhookResponse(webhook));
    return;
  }

  if (!action && method === "DELETE") {
    config.store.deleteWebhook(webhook.id);
    recordActivity(config, user, "webhook.deleted", "site", site.id, { webhookId: webhook.id });
    sendJson(res, 200, { ok: true, id: webhook.id });
    return;
  }

  if (action === "deliveries" && method === "GET") {
    const url = new URL(req.url ?? "/", "http://noma.local");
    const limit = boundedInteger(numberQuery(url.searchParams.get("limit")), 50, 1, 200, "limit");
    sendJson(res, 200, { webhookId: webhook.id, deliveries: config.store.listWebhookDeliveries(webhook.id, limit) });
    return;
  }

  throw new HttpError(404, "Unknown webhook route");
}

function webhookResponse(webhook: CloudWebhook): Record<string, unknown> {
  return {
    id: webhook.id,
    siteId: webhook.siteId,
    url: webhook.url,
    events: webhook.events,
    format: webhook.format,
    secretPreview: `…${webhook.secret.slice(-4)}`,
    createdBy: webhook.createdBy,
    createdAt: webhook.createdAt,
  };
}

function eventsInput(value: unknown): CloudWebhookEvent[] {
  if (!Array.isArray(value) || value.length === 0) throw new HttpError(400, `events must list one or more of ${cloudWebhookEvents.join(", ")}`);
  const events = [...new Set(value)].map((event) => {
    if (typeof event !== "string" || !(cloudWebhookEvents as readonly string[]).includes(event)) {
      throw new HttpError(400, `Unknown webhook event: ${String(event)}`);
    }
    return event as CloudWebhookEvent;
  });
  return events;
}

function formatInput(value: unknown): "json" | "slack" {
  if (value === undefined || value === "json") return "json";
  if (value === "slack") return "slack";
  throw new HttpError(400, "format must be json or slack");
}

function secretInput(value: unknown): string {
  if (value === undefined || value === null || value === "") return `whsec_${randomBytes(24).toString("base64url")}`;
  if (typeof value !== "string" || value.length < 16 || value.length > 256) throw new HttpError(400, "secret must be 16-256 characters");
  return value;
}
