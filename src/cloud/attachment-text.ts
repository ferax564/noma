/**
 * Attachment text and previews: a background job that sends uploaded PDFs to a ferrox-server sidecar
 * (`extract_text`) and Office files to an officeconvert sidecar (LibreOffice → PDF) and then to
 * ferrox. The derived PDF is stored as a content-addressed preview blob; the extracted text is
 * sanitised, capped, run through DLP, and indexed into page search (and, through the knowledge
 * platform, retrieval/embeddings) as the attachment's `att:<id>` block.
 *
 * Both sidecars are optional and untrusted: every call has a timeout, a request-size cap, a
 * response-size cap and shape validation, and a failure only ever changes the attachment's
 * extraction status — uploads never wait on or fail because of a sidecar.
 */
import { createHash } from "node:crypto";
import { readBlobBuffer } from "../cloud-blobs.js";
import type { CloudAttachment, CloudAttachmentExtraction, CloudAttachmentExtractionCandidates, CloudAttachmentExtractionUpdate } from "../cloud-db.js";
import type { CloudServerConfig } from "./context.js";
import { scanStoredText } from "./dlp.js";
import { personalStorageBytes, spaceStorageBytes } from "./routes-attachments.js";

export interface SidecarEndpoint {
  /** Base URL, e.g. `http://ferrox:3001` (Noma appends `/api/v1/process` or `/v1/convert`). */
  url: string;
  /** Sent as `Authorization: Bearer <token>` when set. */
  token?: string;
}

export interface AttachmentTextSettings {
  /** ferrox-server: PDF → text. */
  pdfExtract?: SidecarEndpoint;
  /** officeconvert: Office document → PDF preview. */
  officeConvert?: SidecarEndpoint;
  /** Per sidecar request deadline (default 60 s). */
  timeoutMs: number;
  /** Largest document sent to a sidecar; bigger files are skipped (default 2 MB, the stock sidecars' body limit). */
  maxInputBytes: number;
}

/** Stored extracted text per attachment, in UTF-8 bytes. */
export const ATTACHMENT_TEXT_MAX_BYTES = 1024 * 1024;
/** Largest ferrox JSON response read (base64 text plus envelope). */
const MAX_EXTRACT_RESPONSE_BYTES = 8 * 1024 * 1024;
/** Attempts before an extraction is marked `failed`. */
export const ATTACHMENT_EXTRACTION_MAX_ATTEMPTS = 3;
const RETRY_BASE_MS = 60_000;
const QUEUE_BATCH = 100;
const PASS_BATCH = 4;

const OFFICE_TYPES = {
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};

/**
 * Office extensions sent to officeconvert, each with the sniffed content types accepted for it. HTML
 * and CSV are deliberately absent (no remote-resource loading in LibreOffice; CSV is already text).
 */
const OFFICE_CONVERTIBLE: Record<string, string[]> = {
  docx: [OFFICE_TYPES.docx, "application/zip"],
  xlsx: [OFFICE_TYPES.xlsx, "application/zip"],
  pptx: [OFFICE_TYPES.pptx, "application/zip"],
  odt: ["application/zip"],
  ods: ["application/zip"],
  odp: ["application/zip"],
  doc: ["application/octet-stream"],
  xls: ["application/octet-stream"],
  ppt: ["application/octet-stream"],
  rtf: ["text/plain"],
};

/**
 * Reads `NOMA_CLOUD_PDF_EXTRACT_URL` (+ `_TOKEN`/`_TOKEN_FILE`), `NOMA_CLOUD_OFFICE_CONVERT_URL`
 * (+ `_TOKEN`/`_TOKEN_FILE`), `NOMA_CLOUD_ATTACHMENT_TEXT_TIMEOUT_MS` and
 * `NOMA_CLOUD_ATTACHMENT_TEXT_MAX_INPUT_BYTES`. Undefined when neither sidecar URL is set.
 */
export function attachmentTextSettingsFromEnv(env: NodeJS.ProcessEnv, readSecretFile: (path: string) => string): AttachmentTextSettings | undefined {
  const endpoint = (prefix: string): SidecarEndpoint | undefined => {
    const url = env[`${prefix}_URL`]?.trim();
    if (!url) return undefined;
    const tokenFile = env[`${prefix}_TOKEN_FILE`]?.trim();
    const token = env[`${prefix}_TOKEN`]?.trim() || (tokenFile ? readSecretFile(tokenFile).trim() : "");
    return { url: sidecarBaseUrl(url, `${prefix}_URL`), ...(token ? { token } : {}) };
  };
  const pdfExtract = endpoint("NOMA_CLOUD_PDF_EXTRACT");
  const officeConvert = endpoint("NOMA_CLOUD_OFFICE_CONVERT");
  if (!pdfExtract && !officeConvert) return undefined;
  return {
    ...(pdfExtract ? { pdfExtract } : {}),
    ...(officeConvert ? { officeConvert } : {}),
    timeoutMs: positive(env.NOMA_CLOUD_ATTACHMENT_TEXT_TIMEOUT_MS, 60_000, "NOMA_CLOUD_ATTACHMENT_TEXT_TIMEOUT_MS"),
    maxInputBytes: positive(env.NOMA_CLOUD_ATTACHMENT_TEXT_MAX_INPUT_BYTES, 2_000_000, "NOMA_CLOUD_ATTACHMENT_TEXT_MAX_INPUT_BYTES"),
  };
}

/** Validates an http(s) sidecar URL and strips trailing slashes. */
export function sidecarBaseUrl(raw: string, label: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new Error(`${label} must be an http(s) URL`);
  }
  if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) throw new Error(`${label} must be an http(s) URL without credentials`);
  return url.toString().replace(/\/+$/, "");
}

function positive(raw: string | undefined, fallback: number, label: string): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} must be a positive integer`);
  return value;
}

/** Extension of an attachment that officeconvert should turn into a PDF, if any. */
export function officeConvertibleExtension(attachment: Pick<CloudAttachment, "filename" | "contentType">): string | undefined {
  const dot = attachment.filename.lastIndexOf(".");
  const extension = dot > 0 ? attachment.filename.slice(dot + 1).toLowerCase() : "";
  return OFFICE_CONVERTIBLE[extension]?.includes(attachment.contentType) ? extension : undefined;
}

function candidates(settings: AttachmentTextSettings): CloudAttachmentExtractionCandidates {
  return {
    pdf: Boolean(settings.pdfExtract),
    office: settings.officeConvert ? Object.entries(OFFICE_CONVERTIBLE).map(([extension, contentTypes]) => ({ extension, contentTypes })) : [],
  };
}

/**
 * Makes untrusted extracted text safe to index: NFC, well-formed UTF-16, no control or bidi/zero-width
 * formatting characters, collapsed whitespace, and at most `maxBytes` UTF-8 bytes (cut on a character
 * boundary).
 */
export function sanitizeExtractedText(raw: string, maxBytes = ATTACHMENT_TEXT_MAX_BYTES): { text: string; truncated: boolean } {
  const cleaned = raw
    .replace(/[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g, "")
    .normalize("NFC")
    .replace(/\r\n?/g, "\n")
    .replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, " ")
    .replace(/[­؜᠎​-‏‪-‮⁠-⁯﻿￹-�]/g, "")
    .replace(/[^\S\n]+/g, " ")
    .replace(/ ?\n ?/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  const bytes = Buffer.from(cleaned, "utf8");
  if (bytes.byteLength <= maxBytes) return { text: cleaned, truncated: false };
  const cut = new TextDecoder("utf-8", { fatal: false }).decode(bytes.subarray(0, maxBytes)).replace(/�+$/, "");
  return { text: cut.trimEnd(), truncated: true };
}

/** A sidecar call failed; `retryable` failures are retried with backoff. */
export class SidecarError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
  ) {
    super(message);
  }
}

/** `POST {url}/api/v1/process` with `x-ferrox-config: {"op":"extract_text"}`; returns the raw text artifact. */
export async function extractPdfText(endpoint: SidecarEndpoint, pdf: Buffer, timeoutMs: number): Promise<string> {
  const response = await sidecarFetch("pdf-extract", `${endpoint.url}/api/v1/process`, timeoutMs, {
    method: "POST",
    headers: { "content-type": "application/pdf", "x-ferrox-config": JSON.stringify({ op: "extract_text" }), accept: "application/json", ...bearer(endpoint) },
    body: pdf,
  });
  const body = await readCapped("pdf-extract", response, MAX_EXTRACT_RESPONSE_BYTES);
  if (!/^application\/json\b/i.test(response.headers.get("content-type") ?? "")) throw new SidecarError("pdf-extract did not return JSON", false);
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.toString("utf8"));
  } catch {
    throw new SidecarError("pdf-extract returned malformed JSON", false);
  }
  const artifacts = parsed && typeof parsed === "object" ? (parsed as { artifacts?: unknown }).artifacts : undefined;
  if (!Array.isArray(artifacts)) throw new SidecarError("pdf-extract response has no artifacts", false);
  const artifact = artifacts.find(
    (item): item is { data_base64: string } =>
      Boolean(item) && typeof item === "object" && /^text\/plain\b/i.test(String((item as { media_type?: unknown }).media_type ?? "")) && typeof (item as { data_base64?: unknown }).data_base64 === "string",
  );
  if (!artifact) throw new SidecarError("pdf-extract response has no text artifact", false);
  const encoded = artifact.data_base64.replace(/\s+/g, "");
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) throw new SidecarError("pdf-extract text artifact is not base64", false);
  return new TextDecoder("utf-8", { fatal: false }).decode(Buffer.from(encoded, "base64"));
}

/** `POST {url}/v1/convert` (multipart field `file`); returns PDF bytes, which must start with `%PDF-`. */
export async function convertOfficeToPdf(endpoint: SidecarEndpoint, bytes: Buffer, extension: string, timeoutMs: number, maxResponseBytes: number): Promise<Buffer> {
  const form = new FormData();
  form.append("file", new Blob([new Uint8Array(bytes)], { type: "application/octet-stream" }), `document.${extension}`);
  const response = await sidecarFetch("office-convert", `${endpoint.url}/v1/convert`, timeoutMs, { method: "POST", headers: { accept: "application/pdf", ...bearer(endpoint) }, body: form });
  const pdf = await readCapped("office-convert", response, maxResponseBytes);
  if (!/^application\/pdf\b/i.test(response.headers.get("content-type") ?? "")) throw new SidecarError("office-convert did not return application/pdf", false);
  if (pdf.subarray(0, 5).toString("latin1") !== "%PDF-") throw new SidecarError("office-convert returned bytes that are not a PDF", false);
  return pdf;
}

function bearer(endpoint: SidecarEndpoint): Record<string, string> {
  return endpoint.token ? { authorization: `Bearer ${endpoint.token}` } : {};
}

async function sidecarFetch(name: string, url: string, timeoutMs: number, init: RequestInit): Promise<Response> {
  let response: Response;
  try {
    response = await fetch(url, { ...init, redirect: "error", signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    const timedOut = error instanceof Error && (error.name === "TimeoutError" || error.name === "AbortError");
    throw new SidecarError(timedOut ? `${name} timed out after ${timeoutMs} ms` : `${name} is unreachable`, true);
  }
  if (!response.ok) {
    await response.body?.cancel().catch(() => undefined);
    const retryable = response.status >= 500 || [401, 403, 408, 429].includes(response.status);
    throw new SidecarError(`${name} returned HTTP ${response.status}`, retryable);
  }
  return response;
}

async function readCapped(name: string, response: Response, maxBytes: number): Promise<Buffer> {
  const declared = Number(response.headers.get("content-length") ?? Number.NaN);
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    throw new SidecarError(`${name} response exceeds ${maxBytes} bytes`, false);
  }
  if (!response.body) return Buffer.alloc(0);
  const chunks: Buffer[] = [];
  let size = 0;
  const reader = response.body.getReader();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maxBytes) {
        await reader.cancel().catch(() => undefined);
        throw new SidecarError(`${name} response exceeds ${maxBytes} bytes`, false);
      }
      chunks.push(Buffer.from(value));
    }
  } catch (error) {
    if (error instanceof SidecarError) throw error;
    throw new SidecarError(`${name} response was interrupted`, true);
  }
  return Buffer.concat(chunks);
}

export interface AttachmentExtractionPass {
  queued: number;
  processed: number;
  done: number;
  failed: number;
  skipped: number;
  retrying: number;
}

const inflight = new WeakMap<CloudServerConfig, { running: Promise<AttachmentExtractionPass | undefined>; next?: Promise<AttachmentExtractionPass | undefined> }>();

/**
 * One pass of the extraction queue: queues newly uploaded candidates, then processes up to `limit`
 * due rows one at a time. Passes never overlap; a call during a pass runs (once) right after it.
 * Never throws. Undefined when no sidecar is configured.
 */
export function runAttachmentExtraction(config: CloudServerConfig, limit = PASS_BATCH): Promise<AttachmentExtractionPass | undefined> {
  const settings = config.attachmentText;
  if (!settings) return Promise.resolve(undefined);
  const current = inflight.get(config);
  if (current?.next) return current.next;
  const start = (): Promise<AttachmentExtractionPass | undefined> => {
    const running = extractionPass(config, settings, limit).catch(() => undefined);
    const slot: { running: Promise<AttachmentExtractionPass | undefined>; next?: Promise<AttachmentExtractionPass | undefined> } = { running };
    inflight.set(config, slot);
    void running.finally(() => {
      if (inflight.get(config) === slot && !slot.next) inflight.delete(config);
    });
    return running;
  };
  if (!current) return start();
  const next = current.running.then(start);
  current.next = next;
  return next;
}

async function extractionPass(config: CloudServerConfig, settings: AttachmentTextSettings, limit: number): Promise<AttachmentExtractionPass> {
  const now = config.now().toISOString();
  const pass: AttachmentExtractionPass = { queued: config.store.queueAttachmentExtractions(candidates(settings), now, QUEUE_BATCH), processed: 0, done: 0, failed: 0, skipped: 0, retrying: 0 };
  for (const row of config.store.dueAttachmentExtractions(now, limit)) {
    const status = await processExtraction(config, settings, row);
    pass.processed += 1;
    if (status === "pending") pass.retrying += 1;
    else pass[status] += 1;
  }
  return pass;
}

async function processExtraction(config: CloudServerConfig, settings: AttachmentTextSettings, row: CloudAttachmentExtraction): Promise<CloudAttachmentExtractionUpdate["status"]> {
  const attempts = row.attempts + 1;
  const settle = (update: Omit<CloudAttachmentExtractionUpdate, "attempts" | "updatedAt">): CloudAttachmentExtractionUpdate["status"] => {
    config.store.updateAttachmentExtraction(row.attachmentId, { ...update, attempts, updatedAt: config.now().toISOString() });
    return update.status;
  };
  const attachment = config.store.readAttachment(row.attachmentId);
  if (!attachment || attachment.deletedAt) return settle({ status: "skipped", error: "attachment_deleted" });
  const officeExtension = attachment.contentType === "application/pdf" ? undefined : officeConvertibleExtension(attachment);
  const isPdf = attachment.contentType === "application/pdf";
  if (isPdf ? !settings.pdfExtract : !officeExtension || !settings.officeConvert) return settle({ status: "skipped", error: "unsupported" });
  let previewSha256: string | undefined;
  let previewSize: number | undefined;
  try {
    const reused = config.store.reusableAttachmentExtraction(attachment.sha256, attachment.id);
    let rawText: string | undefined;
    let reusedText: { text: string; textSha256?: string; truncated: boolean } | undefined;
    if (reused && (isPdf || (reused.previewSha256 && (await config.blobs.exists(reused.previewSha256))))) {
      if (reused.previewSha256 && fitsQuota(config, attachment, reused.previewSize)) {
        previewSha256 = reused.previewSha256;
        previewSize = reused.previewSize;
      }
      if (reused.text !== undefined) reusedText = { text: reused.text, truncated: reused.textTruncated, ...(reused.textSha256 ? { textSha256: reused.textSha256 } : {}) };
    } else {
      if (attachment.size > settings.maxInputBytes) return settle({ status: "skipped", error: "too_large" });
      const bytes = await readBlobBuffer(config.blobs, attachment.sha256, settings.maxInputBytes);
      if (!bytes) return settle({ status: "failed", error: "blob_missing" });
      let pdf = bytes;
      if (officeExtension && settings.officeConvert) {
        pdf = await convertOfficeToPdf(settings.officeConvert, bytes, officeExtension, settings.timeoutMs, config.maxAttachmentBytes);
        if (fitsQuota(config, attachment, pdf.byteLength)) {
          const staged = await config.blobs.stage(
            (async function* () {
              yield pdf;
            })(),
          );
          await staged.commit();
          previewSha256 = staged.sha256;
          previewSize = staged.size;
        }
      }
      if (settings.pdfExtract && pdf.byteLength <= settings.maxInputBytes) rawText = await extractPdfText(settings.pdfExtract, pdf, settings.timeoutMs);
    }
    const sanitized = reusedText ?? (rawText === undefined ? undefined : sanitizeExtractedText(rawText));
    const textSha256 = sanitized ? createHash("sha256").update(sanitized.text).digest("hex") : undefined;
    const dlp = sanitized?.text
      ? scanStoredText(config, { text: sanitized.text, actorId: attachment.uploadedBy, resourceType: "attachment", resourceId: attachment.id, ...siteOf(config, attachment) })
      : { detectors: [] };
    const status = settle({
      status: "done",
      ...(sanitized ? { text: sanitized.text, textTruncated: sanitized.truncated, ...(textSha256 ? { textSha256 } : {}) } : {}),
      ...(previewSha256 ? { previewSha256, previewSize: previewSize ?? 0 } : {}),
      dlpWithheld: dlp.outcome === "blocked",
      ...(previewSha256 === undefined && officeExtension ? { error: "preview_over_quota" } : {}),
    });
    config.store.reindexAttachments(attachment.documentId);
    return status;
  } catch (error) {
    const retryable = error instanceof SidecarError ? error.retryable : true;
    const message = error instanceof SidecarError ? error.message : "extraction_error";
    const preview = previewSha256 ? { previewSha256, previewSize: previewSize ?? 0 } : {};
    if (retryable && attempts < ATTACHMENT_EXTRACTION_MAX_ATTEMPTS) {
      const nextAttemptAt = new Date(config.now().getTime() + RETRY_BASE_MS * 4 ** (attempts - 1)).toISOString();
      return settle({ status: "pending", nextAttemptAt, error: message, ...preview });
    }
    return settle({ status: "failed", error: message, ...preview });
  }
}

/** Derived previews share the upload's storage budget; a preview that would exceed it is not stored. */
function fitsQuota(config: CloudServerConfig, attachment: CloudAttachment, previewBytes: number): boolean {
  const siteIds = config.store.documentSiteIds(attachment.documentId);
  const used = siteIds.length > 0 ? Math.max(...siteIds.map((siteId) => spaceStorageBytes(config, siteId))) : personalStorageBytes(config, attachment.uploadedBy);
  return used + previewBytes <= config.attachmentQuotaBytes;
}

function siteOf(config: CloudServerConfig, attachment: CloudAttachment): { siteId?: string } {
  const siteId = config.store.documentSiteIds(attachment.documentId)[0];
  return siteId ? { siteId } : {};
}

/** Public extraction summary attached to attachment responses once a row exists. */
export function extractionResponse(extraction: CloudAttachmentExtraction): Record<string, unknown> {
  return {
    status: extraction.status,
    attempts: extraction.attempts,
    textLength: extraction.textLength,
    ...(extraction.textTruncated ? { textTruncated: true } : {}),
    ...(extraction.previewSha256 ? { preview: true } : {}),
    ...(extraction.dlpWithheld ? { dlpWithheld: true } : {}),
    ...(extraction.error ? { error: extraction.error } : {}),
    ...(extraction.nextAttemptAt && extraction.status === "pending" ? { nextAttemptAt: extraction.nextAttemptAt } : {}),
    updatedAt: extraction.updatedAt,
  };
}
