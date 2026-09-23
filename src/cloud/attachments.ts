/**
 * Attachment helpers shared by the attachment routes and the HTML renderers: filename sanitising,
 * magic-byte content sniffing, signed download URLs, `att:` reference resolution, and blob GC.
 */
import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import { readBlobBuffer } from "../cloud-blobs.js";
import type { CloudAttachment, CloudDocumentRecord } from "../cloud-db.js";
import type { NomaBackupAttachment, NomaBackupBundle } from "../cloud-platform.js";
import { type AccessContext, type CloudServerConfig, siteDocumentAccess } from "./context.js";
import { HttpError } from "./http.js";

/** Types a browser may render inline from `/api/attachments/:id`; everything else downloads. */
const INLINE_SAFE_TYPES = new Set(["image/png", "image/jpeg", "image/gif", "image/webp", "application/pdf"]);

/** Declared types accepted as-is when the bytes look like UTF-8 text and no magic number matched. */
const TEXT_TYPES = new Set(["text/plain", "text/csv", "text/markdown", "application/json"]);

/** Office Open XML containers are ZIPs; the declared type is kept only when the extension agrees. */
const ZIP_DOCUMENT_TYPES = new Map([
  ["docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"],
  ["xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"],
  ["pptx", "application/vnd.openxmlformats-officedocument.presentationml.presentation"],
]);

const EXECUTABLE_EXTENSIONS = new Set([
  "exe", "dll", "com", "scr", "msi", "msp", "bat", "cmd", "ps1", "psm1", "vbs", "vbe", "js", "jse", "wsf", "wsh",
  "hta", "cpl", "jar", "sh", "bash", "zsh", "csh", "command", "app", "apk", "dmg", "pkg", "deb", "rpm", "run", "bin", "elf", "so", "dylib", "lnk",
]);

/** Serves as `application/octet-stream` so a browser never executes markup or script from an attachment. */
const ACTIVE_CONTENT_TYPES = new Set(["text/html", "image/svg+xml", "application/xhtml+xml", "text/xml", "application/xml", "text/javascript"]);

const SIGNED_URL_TTL_SECONDS = 60 * 60;
const SIGNED_URL_GRANULARITY_SECONDS = 10 * 60;

export type AttachmentGrant = { kind: "user"; userId: string } | { kind: "share"; shareId: string };

/**
 * Reduces an uploaded filename to a safe display name: no directories, control characters, or
 * characters that are special on common filesystems; at most 180 characters with the extension kept.
 */
export function sanitizeAttachmentFilename(raw: string | undefined): string {
  let decoded = raw ?? "";
  if (/%[0-9a-f]{2}/i.test(decoded)) {
    try {
      decoded = decodeURIComponent(decoded);
    } catch {
      decoded = raw ?? "";
    }
  }
  const base = decoded.split(/[\\/]/).pop() ?? "";
  const cleaned = base
    .normalize("NFC")
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, "")
    .replace(/[<>:"|?*`]/g, "_")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^[.\s]+|[.\s]+$/g, "");
  if (!cleaned) return "attachment";
  if (cleaned.length <= 180) return cleaned;
  const dot = cleaned.lastIndexOf(".");
  const extension = dot > 0 && cleaned.length - dot <= 16 ? cleaned.slice(dot) : "";
  return `${cleaned.slice(0, 180 - extension.length)}${extension}`;
}

export function attachmentExtension(filename: string): string {
  const dot = filename.lastIndexOf(".");
  return dot > 0 ? filename.slice(dot + 1).toLowerCase() : "";
}

/**
 * Chooses the stored content type from the file's leading bytes. Declared types are trusted only for
 * plain text formats; a declared image or PDF whose bytes do not match becomes octet-stream.
 * Executables are rejected outright (415).
 */
export function sniffAttachmentType(head: Buffer, declared: string | undefined, filename: string): string {
  const extension = attachmentExtension(filename);
  if (EXECUTABLE_EXTENSIONS.has(extension) || isExecutable(head)) {
    throw new HttpError(415, "Executable files cannot be attached", { code: "attachment_executable" });
  }
  const declaredType = (declared ?? "").split(";")[0]!.trim().toLowerCase();
  const magic = magicType(head);
  if (magic === "application/zip") {
    const office = ZIP_DOCUMENT_TYPES.get(extension);
    return office && declaredType === office ? office : "application/zip";
  }
  if (magic) return magic;
  const text = textSample(head);
  if (text === undefined) return "application/octet-stream";
  if (/^\s*(?:<\?xml[^>]*>\s*)?(?:<!--[\s\S]*?-->\s*)*<svg[\s>]/i.test(text)) return "image/svg+xml";
  if (/^\s*(?:<!doctype\s+html|<html[\s>]|<head[\s>]|<body[\s>]|<script[\s>])/i.test(text)) return "text/html";
  if (/^\s*<\?xml/i.test(text)) return "application/xml";
  if (TEXT_TYPES.has(declaredType)) return declaredType;
  if (extension === "md" || extension === "markdown") return "text/markdown";
  if (extension === "csv") return "text/csv";
  if (extension === "json") return "application/json";
  return "text/plain";
}

function magicType(head: Buffer): string | undefined {
  const startsWith = (bytes: number[], offset = 0) => bytes.every((byte, index) => head[offset + index] === byte);
  if (startsWith([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return "image/png";
  if (startsWith([0xff, 0xd8, 0xff])) return "image/jpeg";
  if (head.subarray(0, 6).toString("latin1") === "GIF87a" || head.subarray(0, 6).toString("latin1") === "GIF89a") return "image/gif";
  if (head.subarray(0, 4).toString("latin1") === "RIFF" && head.subarray(8, 12).toString("latin1") === "WEBP") return "image/webp";
  if (head.subarray(0, 5).toString("latin1") === "%PDF-") return "application/pdf";
  if (startsWith([0x50, 0x4b, 0x03, 0x04]) || startsWith([0x50, 0x4b, 0x05, 0x06])) return "application/zip";
  if (startsWith([0x1f, 0x8b])) return "application/gzip";
  return undefined;
}

function isExecutable(head: Buffer): boolean {
  const first4 = head.subarray(0, 4).toString("hex");
  if (head.subarray(0, 2).toString("latin1") === "MZ") return true;
  if (first4 === "7f454c46") return true;
  if (["feedface", "feedfacf", "cefaedfe", "cffaedfe", "cafebabe", "bebafeca"].includes(first4)) return true;
  if (head.subarray(0, 2).toString("latin1") === "#!") return true;
  return false;
}

function textSample(head: Buffer): string | undefined {
  if (head.includes(0)) return undefined;
  const text = new TextDecoder("utf-8", { fatal: false }).decode(head);
  const replacements = (text.match(/\uFFFD/g) ?? []).length;
  return replacements > 2 ? undefined : text;
}

export function servedContentType(attachment: CloudAttachment): string {
  if (ACTIVE_CONTENT_TYPES.has(attachment.contentType)) return "application/octet-stream";
  return attachment.contentType.startsWith("text/") ? `${attachment.contentType}; charset=utf-8` : attachment.contentType;
}

export function isInlineSafe(attachment: CloudAttachment): boolean {
  return INLINE_SAFE_TYPES.has(attachment.contentType);
}

export function isImageAttachment(attachment: Pick<CloudAttachment, "contentType">): boolean {
  return INLINE_SAFE_TYPES.has(attachment.contentType) && attachment.contentType.startsWith("image/");
}

export function contentDisposition(attachment: CloudAttachment): string {
  const kind = isInlineSafe(attachment) ? "inline" : "attachment";
  const ascii = attachment.filename.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  return `${kind}; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(attachment.filename)}`;
}

/** Signs a short-lived download URL for `grant`; the grant is re-checked when the URL is used. */
export function signedAttachmentUrl(config: CloudServerConfig, attachmentId: string, grant: AttachmentGrant): string {
  const now = Math.floor(config.now().getTime() / 1000);
  const expires = Math.ceil((now + SIGNED_URL_TTL_SECONDS) / SIGNED_URL_GRANULARITY_SECONDS) * SIGNED_URL_GRANULARITY_SECONDS;
  const principal = grant.kind === "user" ? `u.${grant.userId}` : `s.${grant.shareId}`;
  const signature = attachmentSignature(config, attachmentId, expires, principal);
  return `/api/attachments/${encodeURIComponent(attachmentId)}?exp=${expires}&p=${encodeURIComponent(principal)}&sig=${signature}`;
}

/** Validates `exp`/`p`/`sig` query parameters; returns the grant they carry, or undefined when absent. */
export function verifySignedAttachmentUrl(config: CloudServerConfig, attachmentId: string, url: URL): AttachmentGrant | undefined {
  const signature = url.searchParams.get("sig");
  if (signature === null) return undefined;
  const expires = Number(url.searchParams.get("exp"));
  const principal = url.searchParams.get("p") ?? "";
  const match = /^([us])\.([A-Za-z0-9_-]{8,80})$/.exec(principal);
  if (!Number.isSafeInteger(expires) || !match || !/^[A-Za-z0-9_-]{43}$/.test(signature)) throw new HttpError(403, "Invalid attachment signature");
  const expected = Buffer.from(attachmentSignature(config, attachmentId, expires, principal));
  const actual = Buffer.from(signature);
  if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) throw new HttpError(403, "Invalid attachment signature");
  if (expires * 1000 < config.now().getTime()) throw new HttpError(403, "Attachment link has expired", { code: "attachment_link_expired" });
  return match[1] === "u" ? { kind: "user", userId: match[2]! } : { kind: "share", shareId: match[2]! };
}

function attachmentSignature(config: CloudServerConfig, attachmentId: string, expires: number, principal: string): string {
  return createHmac("sha256", config.store.attachmentSigningKey()).update(`attachment\n${attachmentId}\n${expires}\n${principal}`).digest("base64url");
}

export function attachmentGrant(access: AccessContext): AttachmentGrant | undefined {
  if (access.via === "share") return access.share ? { kind: "share", shareId: access.share.id } : undefined;
  return access.user ? { kind: "user", userId: access.user.id } : undefined;
}

/** Whether a signed URL's grant still reaches the document: user access now, or a live, unrestricted share link. */
export function grantStillValid(config: CloudServerConfig, grant: AttachmentGrant, document: CloudDocumentRecord): boolean {
  if (grant.kind === "user") return config.store.documentAccessRole(grant.userId, document.id) !== undefined;
  if (config.store.documentRestrictionCap(undefined, document.id) === "hidden") return false;
  if (document.shareLinks.some((share) => share.id === grant.shareId && !share.revokedAt)) return true;
  return config.store.documentSiteIds(document.id).some((siteId) => {
    if (config.store.isTrashed("site", siteId)) return false;
    const site = config.store.readSite(siteId);
    const share = site?.shareLinks.find((item) => item.id === grant.shareId && !item.revokedAt);
    return Boolean(site && share && siteDocumentAccess(config, site, document.id, { shareTokenHash: share.tokenHash }));
  });
}

/**
 * Resolver for `att:<id>` / `att:<filename>` references inside one page. Only that page's live
 * attachments resolve, so a page cannot embed another page's files.
 */
export function attachmentResolver(config: CloudServerConfig, documentId: string, access: AccessContext | undefined): (ref: string) => string | undefined {
  const grant = access ? attachmentGrant(access) : undefined;
  if (!grant) return () => undefined;
  const attachments = config.store.listAttachments(documentId);
  const byId = new Map(attachments.map((attachment) => [attachment.id, attachment]));
  const byName = new Map<string, CloudAttachment>();
  for (const attachment of attachments) byName.set(attachment.filename, attachment);
  const urls = new Map<string, string>();
  return (ref) => {
    const attachment = byId.get(ref) ?? byName.get(ref);
    if (!attachment) return undefined;
    let url = urls.get(attachment.id);
    if (!url) {
      url = signedAttachmentUrl(config, attachment.id, grant);
      urls.set(attachment.id, url);
    }
    return url;
  };
}

/** Deletes blobs that no attachment row references any more. Best effort: a failed delete leaves an orphaned blob, never a dangling row. */
export async function collectAttachmentGarbage(config: CloudServerConfig, hashes: string[]): Promise<number> {
  let removed = 0;
  for (const sha256 of new Set(hashes)) {
    if (config.store.isBlobReferenced(sha256)) continue;
    try {
      await config.blobs.delete(sha256);
      removed += 1;
    } catch {
      continue;
    }
  }
  return removed;
}

/** Total attachment bytes one backup export may embed (before base64). */
export const BACKUP_ATTACHMENT_BYTES = 50 * 1024 * 1024;

/** Live attachments of `documents`, read from blob storage for a backup bundle. */
export async function backupAttachments(config: CloudServerConfig, documents: CloudDocumentRecord[]): Promise<Array<NomaBackupAttachment & { data: string }>> {
  const attachments = documents.flatMap((document) => config.store.listAttachments(document.id));
  const total = attachments.reduce((sum, attachment) => sum + attachment.size, 0);
  if (total > BACKUP_ATTACHMENT_BYTES) {
    throw new HttpError(413, "Attachments exceed the backup export limit; export fewer documents or pass includeAttachments: false", {
      code: "backup_attachments_too_large",
      attachmentBytes: total,
      limitBytes: BACKUP_ATTACHMENT_BYTES,
    });
  }
  const out: Array<NomaBackupAttachment & { data: string }> = [];
  for (const attachment of attachments) {
    const data = await readBlobBuffer(config.blobs, attachment.sha256, BACKUP_ATTACHMENT_BYTES);
    if (!data) continue;
    out.push({ ...backupAttachmentMetadata(attachment), data: data.toString("base64") });
  }
  return out;
}

function backupAttachmentMetadata(attachment: CloudAttachment): NomaBackupAttachment {
  return {
    path: `attachments/${attachment.id}`,
    id: attachment.id,
    documentId: attachment.documentId,
    filename: attachment.filename,
    contentType: attachment.contentType,
    size: attachment.size,
    sha256: attachment.sha256,
  };
}

/**
 * Validates `bundle.attachments` against the digest-covered manifest: every entry names a document
 * in the bundle, its bytes match the manifest hash and size, and nothing executable slips in.
 */
export function validateBackupAttachments(bundle: NomaBackupBundle, documentIds: Set<string>): void {
  const entries: unknown = bundle.attachments ?? [];
  const manifest: unknown = bundle.manifest.attachments ?? [];
  if (!Array.isArray(entries) || !Array.isArray(manifest)) throw new HttpError(400, "Backup attachments must be arrays");
  const ids = new Set<string>();
  const typed: Array<NomaBackupAttachment & { data: string }> = [];
  for (const [index, raw] of entries.entries()) {
    const label = `bundle.attachments[${index}]`;
    if (!raw || typeof raw !== "object") throw new HttpError(400, `${label} must be an object`);
    const entry = raw as Record<string, unknown>;
    if (typeof entry.id !== "string" || !/^[A-Za-z0-9_-]{8,80}$/.test(entry.id)) throw new HttpError(400, `${label}.id is invalid`);
    if (ids.has(entry.id)) throw new HttpError(400, "Backup bundle contains duplicate attachments");
    ids.add(entry.id);
    if (entry.path !== `attachments/${entry.id}`) throw new HttpError(400, `${label}.path must match its attachment ID`);
    if (typeof entry.documentId !== "string" || !documentIds.has(entry.documentId)) throw new HttpError(400, `${label}.documentId must name a document in the bundle`);
    if (typeof entry.filename !== "string" || sanitizeAttachmentFilename(entry.filename) !== entry.filename) throw new HttpError(400, `${label}.filename is invalid`);
    if (typeof entry.contentType !== "string" || typeof entry.data !== "string") throw new HttpError(400, `${label} needs contentType and data`);
    if (typeof entry.size !== "number" || !Number.isSafeInteger(entry.size) || entry.size < 1) throw new HttpError(400, `${label}.size is invalid`);
    if (typeof entry.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(entry.sha256)) throw new HttpError(400, `${label}.sha256 is invalid`);
    const bytes = Buffer.from(entry.data, "base64");
    if (bytes.byteLength !== entry.size || createHash("sha256").update(bytes).digest("hex") !== entry.sha256) {
      throw new HttpError(400, `${label} bytes do not match its manifest hash`);
    }
    sniffAttachmentType(bytes.subarray(0, 4096), entry.contentType, entry.filename);
    typed.push(entry as unknown as NomaBackupAttachment & { data: string });
  }
  const expected = typed.map(({ data: _data, ...entry }) => entry);
  if (JSON.stringify(manifest) !== JSON.stringify(expected)) throw new HttpError(400, "Backup manifest does not match bundle attachments");
}

/**
 * Restores bundle attachments for documents the importer may edit. Attachment IDs that already
 * exist are skipped, so re-importing the same bundle is idempotent.
 */
export async function restoreBackupAttachments(
  config: CloudServerConfig,
  bundle: NomaBackupBundle,
  documentIds: Set<string>,
  uploadedBy: string,
): Promise<{ restored: string[]; skipped: string[] }> {
  const restored: string[] = [];
  const skipped: string[] = [];
  for (const entry of bundle.attachments ?? []) {
    if (!documentIds.has(entry.documentId) || config.store.readAttachment(entry.id) || config.store.hasRecordId(entry.id)) {
      skipped.push(entry.id);
      continue;
    }
    const bytes = Buffer.from(entry.data, "base64");
    const staged = await config.blobs.stage(
      (async function* () {
        yield bytes;
      })(),
    );
    const contentType = sniffAttachmentType(staged.head, entry.contentType, entry.filename);
    await staged.commit();
    config.store.insertAttachment({
      id: entry.id,
      documentId: entry.documentId,
      sha256: staged.sha256,
      filename: entry.filename,
      contentType,
      size: staged.size,
      uploadedBy,
      createdAt: config.now().toISOString(),
    });
    config.store.reindexAttachments(entry.documentId);
    restored.push(entry.id);
  }
  return { restored, skipped };
}
