/**
 * Sandboxed `::html` / `::svg` widgets. Cloud never inlines raw markup into a
 * page; each widget is served on its own URL with a CSP that forces an opaque
 * origin (`sandbox allow-scripts`) and denies all network access, and the page
 * embeds it in `<iframe sandbox="allow-scripts">`. Pages themselves are opaque
 * origins, so session cookies do not reach the frame request: the URL carries a
 * short-lived HMAC grant, re-checked against current access on every load.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { DirectiveNode } from "../ast.js";
import { walk } from "../ast.js";
import type { CloudDocumentRecord } from "../cloud-db.js";
import { parse } from "../parser.js";
import { type ComponentKit, expandComponents } from "../components.js";
import { documentComponentKit } from "./spaces.js";
import { type AttachmentGrant, attachmentGrant, grantStillValid } from "./attachments.js";
import { type AccessContext, type CloudServerConfig, type Principal, documentAccessAnywhere } from "./context.js";
import { HttpError, setSecurityHeaders } from "./http.js";

const WIDGET_KINDS = new Set(["html", "svg"]);
const WIDGET_URL_TTL_SECONDS = 60 * 60;
const WIDGET_URL_GRANULARITY_SECONDS = 5 * 60;

export const widgetContentSecurityPolicy = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  "img-src data:",
  "font-src data:",
  "media-src data:",
  "connect-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
  "sandbox allow-scripts",
].join("; ");

/** Resolver for `renderHtml({ resolveWidgetFrame })`; returns nothing when the viewer has no signable grant. */
export function widgetFrameResolver(config: CloudServerConfig, documentId: string, access: AccessContext | undefined): (node: DirectiveNode) => string | undefined {
  const grant = access ? attachmentGrant(access) : undefined;
  if (!grant) return () => undefined;
  return (node) => (node.id && WIDGET_KINDS.has(node.name) ? signedWidgetUrl(config, documentId, node.id, grant) : undefined);
}

export function signedWidgetUrl(config: CloudServerConfig, documentId: string, blockId: string, grant: AttachmentGrant): string {
  const now = Math.floor(config.now().getTime() / 1000);
  const expires = Math.ceil((now + WIDGET_URL_TTL_SECONDS) / WIDGET_URL_GRANULARITY_SECONDS) * WIDGET_URL_GRANULARITY_SECONDS;
  const principal = grant.kind === "user" ? `u.${grant.userId}` : `s.${grant.shareId}`;
  const signature = widgetSignature(config, documentId, blockId, expires, principal);
  return `/api/documents/${encodeURIComponent(documentId)}/widgets/${encodeURIComponent(blockId)}?exp=${expires}&p=${encodeURIComponent(principal)}&sig=${signature}`;
}

function verifySignedWidgetUrl(config: CloudServerConfig, documentId: string, blockId: string, url: URL): AttachmentGrant | undefined {
  const signature = url.searchParams.get("sig");
  if (signature === null) return undefined;
  const expires = Number(url.searchParams.get("exp"));
  const principal = url.searchParams.get("p") ?? "";
  const match = /^([us])\.([A-Za-z0-9_-]{8,80})$/.exec(principal);
  if (!Number.isSafeInteger(expires) || !match || !/^[A-Za-z0-9_-]{43}$/.test(signature)) throw new HttpError(403, "Invalid widget signature");
  const expected = Buffer.from(widgetSignature(config, documentId, blockId, expires, principal));
  const actual = Buffer.from(signature);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) throw new HttpError(403, "Invalid widget signature");
  if (expires * 1000 < config.now().getTime()) throw new HttpError(403, "Widget link has expired", { code: "widget_link_expired" });
  return match[1] === "u" ? { kind: "user", userId: match[2]! } : { kind: "share", shareId: match[2]! };
}

function widgetSignature(config: CloudServerConfig, documentId: string, blockId: string, expires: number, principal: string): string {
  return createHmac("sha256", config.store.attachmentSigningKey()).update(`widget\n${documentId}\n${blockId}\n${expires}\n${principal}`).digest("base64url");
}

/** The `::html` / `::svg` block with this ID in the page's current source. */
export function findWidgetBlock(source: string, documentId: string, blockId: string, components?: ComponentKit): DirectiveNode | undefined {
  const doc = expandComponents(parse(source, { filename: `${documentId}.noma` }), { ...(components ? { kit: components } : {}), wrap: false });
  for (const node of walk(doc)) {
    if (node.type === "directive" && WIDGET_KINDS.has(node.name) && node.id === blockId) return node;
  }
  return undefined;
}

export function widgetDocument(node: DirectiveNode): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<style>html,body{margin:0}body{font:14px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",system-ui,sans-serif;color:#20242a;background:transparent}</style>
</head>
<body>
${node.body ?? ""}
</body>
</html>`;
}

/** `GET /api/documents/:id/widgets/:blockId` — the widget body under the isolating CSP. */
export function routeDocumentWidget(
  req: IncomingMessage,
  res: ServerResponse,
  blockId: string | undefined,
  config: CloudServerConfig,
  principal: Principal,
  record: CloudDocumentRecord,
): void {
  if ((req.method ?? "GET") !== "GET") throw new HttpError(405, "Method not allowed");
  if (!blockId) throw new HttpError(404, "Widget block ID is required");
  const url = new URL(req.url ?? "/", "http://noma.local");
  const grant = verifySignedWidgetUrl(config, record.id, blockId, url);
  if (grant) {
    if (!grantStillValid(config, grant, record)) throw new HttpError(403, "Widget access was revoked");
  } else if (!documentAccessAnywhere(config, record, principal)) {
    throw new HttpError(principal.user || principal.shareTokenHash ? 403 : 401, "viewer access is required");
  }
  const node = findWidgetBlock(record.source, record.id, blockId, documentComponentKit(config, record.id));
  if (!node) throw new HttpError(404, `No ::html or ::svg block "${blockId}" on this page`);
  res.statusCode = 200;
  setSecurityHeaders(res, widgetContentSecurityPolicy);
  res.removeHeader("x-frame-options");
  res.setHeader("cross-origin-resource-policy", "cross-origin");
  res.setHeader("content-type", "text/html; charset=utf-8");
  res.setHeader("cache-control", "private, no-store");
  res.end(widgetDocument(node));
}
