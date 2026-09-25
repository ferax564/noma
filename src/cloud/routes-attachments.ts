/** `/api/documents/:id/attachments` (list/upload/delete) and `/api/attachments/:id` (download). */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { CloudAttachment, CloudDocumentRecord } from "../cloud-db.js";
import {
  type AccessContext,
  type CloudServerConfig,
  documentAccessAnywhere,
  type Principal,
  randomId,
  recordActivity,
  requireRecordAccess,
} from "./context.js";
import {
  attachmentGrant,
  collectAttachmentGarbage,
  contentDisposition,
  grantStillValid,
  isImageAttachment,
  sanitizeAttachmentFilename,
  servedContentType,
  signedAttachmentUrl,
  sniffAttachmentType,
  verifySignedAttachmentUrl,
} from "./attachments.js";
import { decodePathSegment, headerValue, HttpError, sendJson, setSecurityHeaders } from "./http.js";
import { assertCloudId } from "./input.js";
import { MULTIPART_OVERHEAD_BYTES, multipartBoundary, readMultipartUpload } from "./multipart.js";

/** Extra bytes read (and discarded) past the limit so the client sees the 413 instead of a reset. */
const OVERSIZE_DRAIN_BYTES = 1024 * 1024;

const attachmentContentSecurityPolicy = "default-src 'none'; img-src 'self' data:; style-src 'unsafe-inline'; sandbox";

export async function routeDocumentAttachments(
  req: IncomingMessage,
  res: ServerResponse,
  attachmentId: string | undefined,
  config: CloudServerConfig,
  principal: Principal,
  document: CloudDocumentRecord,
): Promise<void> {
  const method = req.method ?? "GET";
  if (!attachmentId && method === "GET") {
    const access = requireRecordAccess(config, document, principal, "viewer");
    sendJson(res, 200, {
      documentId: document.id,
      attachments: config.store.listAttachments(document.id).map((attachment) => attachmentResponse(config, attachment, access)),
      limits: { maxAttachmentBytes: config.maxAttachmentBytes, quotaBytes: config.attachmentQuotaBytes },
    });
    return;
  }
  if (!attachmentId && method === "POST") {
    const access = requireRecordAccess(config, document, principal, "editor");
    const attachment = await uploadAttachment(req, res, config, document, access);
    sendJson(res, 201, attachmentResponse(config, attachment, access));
    return;
  }
  if (attachmentId && method === "DELETE") {
    const access = requireRecordAccess(config, document, principal, "editor");
    assertCloudId(attachmentId, "Attachment");
    const attachment = config.store.readAttachment(attachmentId);
    if (!attachment || attachment.documentId !== document.id || attachment.deletedAt) throw new HttpError(404, "Attachment not found");
    config.store.markAttachmentDeleted(attachment.id, config.now().toISOString());
    config.store.reindexAttachments(document.id);
    if (access.user) recordActivity(config, access.user, "attachment.deleted", "document", document.id, { attachmentId: attachment.id, filename: attachment.filename });
    sendJson(res, 200, { ok: true, attachmentId: attachment.id });
    return;
  }
  throw new HttpError(attachmentId ? 405 : 404, attachmentId ? "Method not allowed" : "Unknown attachment route");
}

/** `GET|HEAD /api/attachments/:id` — bearer/share access to the owning page, or a signed URL. */
export async function routeAttachments(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  parts: string[],
  config: CloudServerConfig,
  principal: Principal,
): Promise<void> {
  const method = req.method ?? "GET";
  if (method !== "GET" && method !== "HEAD") throw new HttpError(405, "Method not allowed");
  const attachmentId = decodePathSegment(parts[2] ?? "");
  if (!attachmentId || parts.length > 3) throw new HttpError(404, "Unknown attachment route");
  assertCloudId(attachmentId, "Attachment");
  const grant = verifySignedAttachmentUrl(config, attachmentId, url);
  const attachment = config.store.readAttachment(attachmentId);
  if (!attachment || attachment.deletedAt) throw new HttpError(404, "Attachment not found");
  const document = config.store.readDocument(attachment.documentId);
  if (!document || config.store.isTrashed("document", document.id)) throw new HttpError(404, "Attachment not found");
  if (grant) {
    if (!grantStillValid(config, grant, document)) throw new HttpError(403, "Attachment access was revoked");
  } else if (!documentAccessAnywhere(config, document, principal)) {
    throw new HttpError(principal.user || principal.shareTokenHash ? 403 : 401, "viewer access is required");
  }
  const blob = await config.blobs.get(attachment.sha256);
  if (!blob) throw new HttpError(404, "Attachment content is missing");
  const etag = `"${attachment.sha256}"`;
  res.statusCode = headerValue(req, "if-none-match") === etag ? 304 : 200;
  setSecurityHeaders(res, attachmentContentSecurityPolicy);
  res.setHeader("cache-control", "private, max-age=0, must-revalidate");
  res.setHeader("etag", etag);
  // Rendered artifacts are CSP-sandboxed (opaque origin), so their signed <img> loads count as cross-origin.
  res.setHeader("cross-origin-resource-policy", grant ? "cross-origin" : "same-origin");
  res.setHeader("content-type", servedContentType(attachment));
  res.setHeader("content-disposition", contentDisposition(attachment));
  if (res.statusCode === 304 || method === "HEAD") {
    if (method === "HEAD") res.setHeader("content-length", String(blob.size));
    blob.stream.destroy();
    res.end();
    return;
  }
  res.setHeader("content-length", String(blob.size));
  await new Promise<void>((resolve, reject) => {
    blob.stream.once("error", reject);
    res.once("finish", resolve);
    res.once("close", () => {
      blob.stream.destroy();
      resolve();
    });
    blob.stream.pipe(res);
  });
}

async function uploadAttachment(
  req: IncomingMessage,
  res: ServerResponse,
  config: CloudServerConfig,
  document: CloudDocumentRecord,
  access: AccessContext,
): Promise<CloudAttachment> {
  const requestType = headerValue(req, "content-type") ?? "application/octet-stream";
  const multipart = /^multipart\//i.test(requestType);
  const boundary = multipart ? multipartBoundary(requestType) : undefined;
  const maxBodyBytes = config.maxAttachmentBytes + (multipart ? MULTIPART_OVERHEAD_BYTES : 0);
  const declaredLength = Number(headerValue(req, "content-length") ?? Number.NaN);
  if (Number.isFinite(declaredLength) && declaredLength > maxBodyBytes) {
    res.setHeader("connection", "close");
    throw tooLarge(config);
  }
  const body = limitedBody(req, maxBodyBytes, config);
  const form = boundary ? readMultipartUpload(body, boundary, config.maxAttachmentBytes, () => tooLarge(config)) : undefined;
  let staged;
  try {
    staged = await config.blobs.stage(form ? form.file : body);
  } catch (error) {
    if (error instanceof HttpError && (error.status === 413 || form)) res.setHeader("connection", "close");
    throw error;
  }
  const declaredType = (form ? form.result.contentType : requestType) ?? "application/octet-stream";
  const formFilename = form?.result.filename;
  const filename = sanitizeAttachmentFilename(formFilename !== undefined ? encodeURIComponent(formFilename) : headerValue(req, "x-filename"));
  let contentType: string;
  try {
    if (staged.size === 0) throw new HttpError(400, "Attachment body is empty");
    contentType = sniffAttachmentType(staged.head, declaredType, filename);
    requireAttachmentQuota(config, document, access, staged.size);
    await staged.commit();
  } catch (error) {
    await staged.discard();
    throw error;
  }
  const attachment: Omit<CloudAttachment, "uploadedByName" | "deletedAt"> = {
    id: attachmentIdFor(config),
    documentId: document.id,
    sha256: staged.sha256,
    filename,
    contentType,
    size: staged.size,
    uploadedBy: uploaderId(access),
    createdAt: config.now().toISOString(),
  };
  try {
    config.store.insertAttachment(attachment);
  } catch (error) {
    await collectAttachmentGarbage(config, [staged.sha256]);
    throw error;
  }
  config.store.reindexAttachments(document.id);
  if (access.user) {
    recordActivity(config, access.user, "attachment.uploaded", "document", document.id, {
      attachmentId: attachment.id,
      filename,
      size: attachment.size,
      contentType: attachment.contentType,
    });
  }
  return config.store.readAttachment(attachment.id)!;
}

async function* limitedBody(req: IncomingMessage, maxBytes: number, config: CloudServerConfig): AsyncGenerator<Uint8Array> {
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(String(chunk));
    size += buffer.byteLength;
    if (size > maxBytes) {
      if (size > maxBytes + OVERSIZE_DRAIN_BYTES) throw tooLarge(config);
      continue;
    }
    yield buffer;
  }
  if (size > maxBytes) throw tooLarge(config);
}

function tooLarge(config: CloudServerConfig): HttpError {
  return new HttpError(413, `Attachments are limited to ${config.maxAttachmentBytes} bytes`, {
    code: "attachment_too_large",
    maxAttachmentBytes: config.maxAttachmentBytes,
  });
}

function requireAttachmentQuota(config: CloudServerConfig, document: CloudDocumentRecord, access: AccessContext, size: number): void {
  const siteIds = config.store.documentSiteIds(document.id);
  const uploader = uploaderId(access);
  const scopes = siteIds.length > 0
    ? siteIds.map((siteId) => ({ scope: "site" as const, id: siteId, used: config.store.siteAttachmentBytes(siteId) }))
    : [{ scope: "user" as const, id: uploader, used: config.store.unspacedAttachmentBytes(uploader) }];
  const exceeded = scopes.find((scope) => scope.used + size > config.attachmentQuotaBytes);
  if (exceeded) {
    throw new HttpError(413, "Attachment storage quota exceeded", {
      code: "attachment_quota_exceeded",
      scope: exceeded.scope,
      ...(exceeded.scope === "site" ? { siteId: exceeded.id } : {}),
      usedBytes: exceeded.used,
      quotaBytes: config.attachmentQuotaBytes,
    });
  }
}

function uploaderId(access: AccessContext): string {
  return access.user?.id ?? `share:${access.share?.id ?? "unknown"}`;
}

export function attachmentIdFor(config: CloudServerConfig): string {
  for (let attempt = 0; attempt < 12; attempt++) {
    const id = randomId();
    if (!config.store.readAttachment(id) && !config.store.hasRecordId(id)) return id;
  }
  throw new HttpError(500, "Could not allocate attachment ID");
}

export function attachmentResponse(config: CloudServerConfig, attachment: CloudAttachment, access: AccessContext): Record<string, unknown> {
  const grant = attachmentGrant(access);
  return {
    id: attachment.id,
    documentId: attachment.documentId,
    filename: attachment.filename,
    contentType: attachment.contentType,
    size: attachment.size,
    sha256: attachment.sha256,
    uploadedBy: attachment.uploadedBy,
    ...(attachment.uploadedByName ? { uploadedByName: attachment.uploadedByName } : {}),
    createdAt: attachment.createdAt,
    image: isImageAttachment(attachment),
    reference: `att:${attachment.id}`,
    ...(grant ? { url: signedAttachmentUrl(config, attachment.id, grant) } : {}),
  };
}
