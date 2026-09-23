/**
 * Content-addressed blob storage for Noma Cloud attachments. Blobs are keyed by the SHA-256 of their
 * bytes, so identical uploads share one stored object. Writes are two-phase: `stage` streams bytes to
 * a private temp file while hashing, the caller inspects the result (size, magic bytes, quota), and
 * then either `commit`s (atomic rename into place) or `discard`s.
 *
 * `LocalDiskBlobStore` lays blobs out as `<root>/blobs/ab/cd/<sha256>`. The `BlobStore` interface is
 * the seam for an S3-compatible driver: `stage` stays local (hash before upload), `commit` becomes a
 * `PutObject` keyed by the hash, `get` a streaming `GetObject`, `exists` a `HeadObject`, and `delete`
 * a `DeleteObject`.
 */
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, open, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import type { Readable } from "node:stream";

const SHA256_RE = /^[a-f0-9]{64}$/;

/** Bytes kept from the start of a staged blob for content sniffing. */
export const BLOB_HEAD_BYTES = 4096;

export interface StagedBlob {
  sha256: string;
  size: number;
  /** The first `BLOB_HEAD_BYTES` bytes, for magic-byte sniffing before the blob is committed. */
  head: Buffer;
  /** Moves the staged bytes to their content address. Idempotent when the blob already exists. */
  commit(): Promise<void>;
  /** Removes the staged bytes without storing them. */
  discard(): Promise<void>;
}

export interface StoredBlob {
  size: number;
  stream: Readable;
}

export interface BlobStore {
  readonly kind: string;
  stage(source: AsyncIterable<Uint8Array>): Promise<StagedBlob>;
  get(sha256: string): Promise<StoredBlob | undefined>;
  exists(sha256: string): Promise<boolean>;
  delete(sha256: string): Promise<void>;
}

export class LocalDiskBlobStore implements BlobStore {
  readonly kind = "local-disk";
  private readonly blobRoot: string;
  private readonly tempRoot: string;

  constructor(storageRoot: string) {
    this.blobRoot = join(storageRoot, "blobs");
    this.tempRoot = join(this.blobRoot, "tmp");
  }

  async stage(source: AsyncIterable<Uint8Array>): Promise<StagedBlob> {
    await mkdir(this.tempRoot, { recursive: true, mode: 0o700 });
    const tempPath = join(this.tempRoot, `${randomUUID()}.part`);
    const hash = createHash("sha256");
    const headChunks: Buffer[] = [];
    let headSize = 0;
    let size = 0;
    const output = createWriteStream(tempPath, { flags: "wx", mode: 0o600 });
    const closed = new Promise<void>((resolve, reject) => {
      output.once("close", resolve);
      output.once("error", reject);
    });
    try {
      for await (const chunk of source) {
        const buffer = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
        hash.update(buffer);
        size += buffer.byteLength;
        if (headSize < BLOB_HEAD_BYTES) {
          const slice = buffer.subarray(0, BLOB_HEAD_BYTES - headSize);
          headChunks.push(Buffer.from(slice));
          headSize += slice.byteLength;
        }
        if (!output.write(buffer)) await new Promise<void>((resolve) => output.once("drain", resolve));
      }
      output.end();
      await closed;
      const handle = await open(tempPath, "r");
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
    } catch (error) {
      output.destroy();
      await closed.catch(() => undefined);
      await rm(tempPath, { force: true });
      throw error;
    }
    const sha256 = hash.digest("hex");
    const finalPath = this.pathFor(sha256);
    let settled = false;
    return {
      sha256,
      size,
      head: Buffer.concat(headChunks),
      commit: async () => {
        if (settled) return;
        settled = true;
        if (await this.exists(sha256)) {
          await rm(tempPath, { force: true });
          return;
        }
        await mkdir(join(finalPath, ".."), { recursive: true, mode: 0o700 });
        await rename(tempPath, finalPath);
      },
      discard: async () => {
        if (settled) return;
        settled = true;
        await rm(tempPath, { force: true });
      },
    };
  }

  async get(sha256: string): Promise<StoredBlob | undefined> {
    const path = this.pathFor(sha256);
    try {
      const info = await stat(path);
      if (!info.isFile()) return undefined;
      return { size: info.size, stream: createReadStream(path) };
    } catch {
      return undefined;
    }
  }

  async exists(sha256: string): Promise<boolean> {
    try {
      return (await stat(this.pathFor(sha256))).isFile();
    } catch {
      return false;
    }
  }

  async delete(sha256: string): Promise<void> {
    await rm(this.pathFor(sha256), { force: true });
  }

  private pathFor(sha256: string): string {
    if (!SHA256_RE.test(sha256)) throw new Error("Blob key must be a lowercase SHA-256 hash");
    return join(this.blobRoot, sha256.slice(0, 2), sha256.slice(2, 4), sha256);
  }
}

/** Reads a whole stored blob into memory; callers bound `maxBytes` before calling. */
export async function readBlobBuffer(store: BlobStore, sha256: string, maxBytes: number): Promise<Buffer | undefined> {
  const blob = await store.get(sha256);
  if (!blob) return undefined;
  if (blob.size > maxBytes) {
    blob.stream.destroy();
    throw new Error("Blob exceeds the read limit");
  }
  const chunks: Buffer[] = [];
  for await (const chunk of blob.stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
  return Buffer.concat(chunks);
}
