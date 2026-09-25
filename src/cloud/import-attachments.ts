/**
 * Copies Confluence page attachments into Noma Cloud during an import. Bytes are staged through the
 * BlobStore with the same size, magic-byte, and quota rules as `/api/documents/:id/attachments`
 * uploads, then committed only once the owning page is written. An attachment already on the page
 * with the same filename and content hash is reused, so re-imports never duplicate rows.
 */
import type { StagedBlob } from "../cloud-blobs.js";
import type { CloudAttachment } from "../cloud-db.js";
import { type ConfluenceAttachmentSource, ConfluenceImportError, type ConfluencePage } from "../confluence-import.js";
import { collectAttachmentGarbage, sanitizeAttachmentFilename, sniffAttachmentType } from "./attachments.js";
import { type CloudServerConfig, randomId } from "./context.js";
import { HttpError } from "./http.js";

/** Most skipped-attachment details kept in an import result. */
const MAX_SKIP_DETAILS = 500;

export interface AttachmentSkip {
  pageId: string;
  filename: string;
  reason: string;
}

/** Import-wide attachment accounting: limits, quota headroom, and the loss report. */
export class ImportAttachmentLedger {
  copied = 0;
  reused = 0;
  skipped = 0;
  bytesCopied = 0;
  bytesRead = 0;
  readonly skips: AttachmentSkip[] = [];
  private quotaUsed: number;

  constructor(
    readonly config: CloudServerConfig,
    readonly siteId: string,
    readonly maxFileBytes: number,
    readonly maxImportBytes: number,
  ) {
    this.quotaUsed = config.store.siteAttachmentBytes(siteId);
  }

  skip(pageId: string, filename: string, reason: string): void {
    this.skipped += 1;
    if (this.skips.length < MAX_SKIP_DETAILS) this.skips.push({ pageId, filename: filename.slice(0, 250), reason: reason.slice(0, 300) });
  }

  /** Reserves quota for a newly stored blob; false when the space's attachment quota would overflow. */
  reserveQuota(size: number): boolean {
    if (this.quotaUsed + size > this.config.attachmentQuotaBytes) return false;
    this.quotaUsed += size;
    return true;
  }

  releaseQuota(size: number): void {
    this.quotaUsed = Math.max(0, this.quotaUsed - size);
  }

  summary(): Record<string, unknown> {
    return {
      copied: this.copied,
      reused: this.reused,
      skipped: this.skipped,
      bytesCopied: this.bytesCopied,
      ...(this.skips.length > 0 ? { skippedDetails: this.skips } : {}),
    };
  }
}

interface PendingAttachment {
  id: string;
  filename: string;
  contentType: string;
  staged: StagedBlob;
}

/** A page's attachments, staged but not yet stored. `commit` after the page is written; `discard` otherwise. */
export interface PreparedPageAttachments {
  /** Confluence filename → `att:` reference target (attachment ID). */
  refs: Map<string, string>;
  /** Reasons for attachments that could not be copied, by Confluence filename. */
  reasons: Map<string, string>;
  /** Listing error or source-level reason, for referenced files the source never listed. */
  sourceReason?: string;
  commit(documentId: string, uploadedBy: string): Promise<void>;
  discard(): Promise<void>;
}

export async function preparePageAttachments(
  ledger: ImportAttachmentLedger,
  source: ConfluenceAttachmentSource | undefined,
  unavailable: string | undefined,
  page: ConfluencePage,
  existing: CloudAttachment[],
): Promise<PreparedPageAttachments> {
  const { config } = ledger;
  const refs = new Map<string, string>();
  const reasons = new Map<string, string>();
  const pending: PendingAttachment[] = [];
  const live = existing.filter((attachment) => !attachment.deletedAt);
  const reusable = (filename: string, sha256?: string): CloudAttachment | undefined =>
    live.find((attachment) => attachment.filename === filename && (sha256 === undefined || attachment.sha256 === sha256));
  const fallback = (rawName: string, filename: string, reason: string): void => {
    ledger.skip(page.id, rawName, reason);
    reasons.set(rawName, reason);
    const previous = reusable(filename);
    if (previous) refs.set(rawName, previous.id);
  };
  const discard = async (): Promise<void> => {
    for (const item of pending.splice(0)) {
      ledger.releaseQuota(item.staged.size);
      await item.staged.discard().catch(() => undefined);
    }
  };

  let sourceReason = unavailable;
  const listing = source ? await source.list(page) : { entries: [] };
  if (listing.error) sourceReason = listing.error;
  try {
    for (const entry of listing.entries) {
      const filename = sanitizeAttachmentFilename(entry.filename);
      if (refs.has(entry.filename)) continue;
      const remaining = ledger.maxImportBytes - ledger.bytesRead;
      const limit = Math.min(ledger.maxFileBytes, remaining);
      if (entry.size !== undefined && entry.size > ledger.maxFileBytes) {
        fallback(entry.filename, filename, `Larger than the ${ledger.maxFileBytes}-byte attachment limit`);
        continue;
      }
      if (limit <= 0 || (entry.size !== undefined && entry.size > remaining)) {
        fallback(entry.filename, filename, `The import's ${ledger.maxImportBytes}-byte attachment budget is used up`);
        continue;
      }
      let staged: StagedBlob;
      try {
        const bytes = await source!.open(page, entry, limit);
        staged = await config.blobs.stage(boundedStream(bytes, limit, ledger.maxFileBytes, ledger.maxImportBytes));
      } catch (error) {
        fallback(entry.filename, filename, error instanceof ConfluenceImportError || error instanceof LimitError ? error.message : `Download failed: ${errorText(error)}`);
        continue;
      }
      ledger.bytesRead += staged.size;
      if (staged.size === 0) {
        await staged.discard();
        fallback(entry.filename, filename, "The attachment is empty");
        continue;
      }
      const same = reusable(filename, staged.sha256);
      if (same) {
        await staged.discard();
        refs.set(entry.filename, same.id);
        ledger.reused += 1;
        continue;
      }
      let contentType: string;
      try {
        contentType = sniffAttachmentType(staged.head, entry.mediaType, filename);
      } catch (error) {
        await staged.discard();
        fallback(entry.filename, filename, error instanceof HttpError ? error.message : errorText(error));
        continue;
      }
      if (!ledger.reserveQuota(staged.size)) {
        await staged.discard();
        fallback(entry.filename, filename, "The space's attachment storage quota is exceeded");
        continue;
      }
      const id = attachmentId(config, pending);
      pending.push({ id, filename, contentType, staged });
      refs.set(entry.filename, id);
    }
  } catch (error) {
    await discard();
    throw error;
  }

  return {
    refs,
    reasons,
    ...(sourceReason ? { sourceReason } : {}),
    discard,
    async commit(documentId, uploadedBy) {
      const items = pending.splice(0);
      if (items.length === 0) return;
      const now = config.now().toISOString();
      const committed: string[] = [];
      try {
        for (const item of items) {
          await item.staged.commit();
          committed.push(item.staged.sha256);
          config.store.insertAttachment({
            id: item.id,
            documentId,
            sha256: item.staged.sha256,
            filename: item.filename,
            contentType: item.contentType,
            size: item.staged.size,
            uploadedBy,
            createdAt: now,
          });
          ledger.copied += 1;
          ledger.bytesCopied += item.staged.size;
        }
      } catch (error) {
        for (const item of items) await item.staged.discard().catch(() => undefined);
        await collectAttachmentGarbage(config, committed);
        throw error;
      } finally {
        config.store.reindexAttachments(documentId);
      }
    },
  };
}

class LimitError extends Error {}

async function* boundedStream(source: AsyncIterable<Uint8Array>, limit: number, fileLimit: number, importLimit: number): AsyncGenerator<Uint8Array> {
  let size = 0;
  for await (const chunk of source) {
    size += chunk.byteLength;
    if (size > limit) {
      throw new LimitError(limit >= fileLimit ? `Larger than the ${fileLimit}-byte attachment limit` : `The import's ${importLimit}-byte attachment budget is used up`);
    }
    yield chunk;
  }
}

function attachmentId(config: CloudServerConfig, pending: PendingAttachment[]): string {
  for (let attempt = 0; attempt < 12; attempt++) {
    const id = randomId();
    if (!pending.some((item) => item.id === id) && !config.store.readAttachment(id) && !config.store.hasRecordId(id)) return id;
  }
  throw new HttpError(500, "Could not allocate attachment ID");
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
