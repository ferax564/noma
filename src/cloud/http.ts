/**
 * HTTP primitives shared by every Noma Cloud route: errors, JSON/text responses, security headers,
 * body parsing, and hashing/escaping helpers. Imports nothing from other cloud modules.
 */
import { createHash } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

export class HttpError extends Error {
  constructor(readonly status: number, message: string, readonly details: Record<string, unknown> = {}) {
    super(message);
  }
}

export function authBearer(req: IncomingMessage): string | undefined {
  const value = headerValue(req, "authorization");
  if (!value) return undefined;
  const match = /^Bearer\s+(.+)$/i.exec(value);
  return match?.[1];
}

export function headerValue(req: IncomingMessage, name: string): string | undefined {
  const value = req.headers[name.toLowerCase()];
  return Array.isArray(value) ? value[0] : value;
}

export async function readJsonBody(req: IncomingMessage, maxBodyBytes: number): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  let tooLarge = false;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buffer.byteLength;
    if (tooLarge || size > maxBodyBytes) {
      tooLarge = true;
      continue;
    }
    chunks.push(buffer);
  }
  if (tooLarge) throw new HttpError(413, "Request body is too large");
  const text = Buffer.concat(chunks).toString("utf8");
  if (!text.trim()) throw new HttpError(400, "JSON body is required");
  try {
    const parsed = JSON.parse(text) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("body must be an object");
    return parsed as Record<string, unknown>;
  } catch {
    throw new HttpError(400, "Invalid JSON body");
  }
}

export function decodePathSegment(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new HttpError(400, "Malformed URL path");
  }
}

export function sendJson(res: ServerResponse, status: number, payload: unknown): void {
  sendText(res, status, `${JSON.stringify(payload)}\n`, "application/json; charset=utf-8");
}

export function sendText(res: ServerResponse, status: number, body: string, type: string): void {
  res.statusCode = status;
  setSecurityHeaders(res, type.startsWith("text/html") ? artifactContentSecurityPolicy : undefined);
  res.setHeader("content-type", type);
  res.setHeader("cache-control", "no-store");
  res.end(body);
}

const artifactContentSecurityPolicy = [
  "default-src 'none'",
  "script-src 'unsafe-inline'",
  "style-src 'unsafe-inline'",
  "font-src data:",
  "img-src data: 'self'",
  "frame-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
  "sandbox allow-scripts allow-popups allow-popups-to-escape-sandbox",
].join("; ");

export function setSecurityHeaders(res: ServerResponse, contentSecurityPolicy?: string): void {
  res.setHeader("x-content-type-options", "nosniff");
  res.setHeader("referrer-policy", "no-referrer");
  res.setHeader("x-frame-options", "DENY");
  res.setHeader("permissions-policy", "camera=(), microphone=(), geolocation=(), payment=()");
  if (contentSecurityPolicy) res.setHeader("content-security-policy", contentSecurityPolicy);
}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => {
    switch (char) {
      case "&":
        return "&amp;";
      case "<":
        return "&lt;";
      case ">":
        return "&gt;";
      case '"':
        return "&quot;";
      default:
        return "&#39;";
    }
  });
}

export function escapeAttr(value: string): string {
  return escapeHtml(value);
}
