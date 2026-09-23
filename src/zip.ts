/**
 * Minimal, dependency-free ZIP support for Noma Cloud exports and imports.
 * The writer emits deflated entries with a central directory; the reader is
 * bounded (entry count, per-entry and total inflated size) and rejects
 * encrypted, multi-disk, and ZIP64 archives rather than guessing.
 */
import { deflateRawSync, inflateRawSync } from "node:zlib";

export interface ZipEntryInput {
  path: string;
  data: string | Uint8Array;
  modifiedAt?: Date;
}

export interface ZipEntry {
  path: string;
  data: Buffer;
}

export interface ZipReadLimits {
  maxEntries?: number;
  maxEntryBytes?: number;
  maxTotalBytes?: number;
}

export class ZipFormatError extends Error {}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

export function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of data) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function dosTime(date: Date): { time: number; date: number } {
  const year = Math.max(1980, date.getUTCFullYear());
  return {
    time: (date.getUTCHours() << 11) | (date.getUTCMinutes() << 5) | Math.floor(date.getUTCSeconds() / 2),
    date: ((year - 1980) << 9) | ((date.getUTCMonth() + 1) << 5) | date.getUTCDate(),
  };
}

/** Build a ZIP archive. Paths use `/` separators and must be relative. */
export function createZip(entries: ZipEntryInput[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  const seen = new Set<string>();
  for (const entry of entries) {
    const path = entry.path.replace(/\\/g, "/").replace(/^\/+/, "");
    if (!path || path.split("/").includes("..")) throw new ZipFormatError(`Invalid ZIP entry path: ${entry.path}`);
    if (seen.has(path)) throw new ZipFormatError(`Duplicate ZIP entry path: ${path}`);
    seen.add(path);
    const name = Buffer.from(path, "utf8");
    const raw = typeof entry.data === "string" ? Buffer.from(entry.data, "utf8") : Buffer.from(entry.data);
    const deflated = deflateRawSync(raw);
    const useDeflate = deflated.length < raw.length;
    const body = useDeflate ? deflated : raw;
    const method = useDeflate ? 8 : 0;
    const crc = crc32(raw);
    const { time, date } = dosTime(entry.modifiedAt ?? new Date(0));
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(raw.length, 22);
    local.writeUInt16LE(name.length, 26);
    local.writeUInt16LE(0, 28);
    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(time, 12);
    central.writeUInt16LE(date, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(raw.length, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);
    locals.push(local, name, body);
    centrals.push(central, name);
    offset += local.length + name.length + body.length;
  }
  const centralSize = centrals.reduce((sum, part) => sum + part.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(seen.size, 8);
  end.writeUInt16LE(seen.size, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...locals, ...centrals, end]);
}

export function isZip(data: Uint8Array): boolean {
  return data.length >= 4 && data[0] === 0x50 && data[1] === 0x4b && (data[2] === 0x03 || data[2] === 0x05);
}

/** Read every file entry of a ZIP archive within the given limits. Directory entries are skipped. */
export function readZip(input: Uint8Array, limits: ZipReadLimits = {}): ZipEntry[] {
  const maxEntries = limits.maxEntries ?? 10_000;
  const maxEntryBytes = limits.maxEntryBytes ?? 50_000_000;
  const maxTotalBytes = limits.maxTotalBytes ?? 200_000_000;
  const data = Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  const endOffset = findEndOfCentralDirectory(data);
  const diskEntries = data.readUInt16LE(endOffset + 8);
  const totalEntries = data.readUInt16LE(endOffset + 10);
  const centralSize = data.readUInt32LE(endOffset + 12);
  const centralOffset = data.readUInt32LE(endOffset + 16);
  if (diskEntries !== totalEntries || data.readUInt16LE(endOffset + 4) !== 0) throw new ZipFormatError("Multi-disk ZIP archives are not supported");
  if (totalEntries === 0xffff || centralOffset === 0xffffffff) throw new ZipFormatError("ZIP64 archives are not supported");
  if (totalEntries > maxEntries) throw new ZipFormatError(`ZIP archive has more than ${maxEntries} entries`);
  if (centralOffset + centralSize > endOffset) throw new ZipFormatError("ZIP central directory is out of bounds");
  const entries: ZipEntry[] = [];
  let cursor = centralOffset;
  let total = 0;
  for (let index = 0; index < totalEntries; index++) {
    if (cursor + 46 > endOffset || data.readUInt32LE(cursor) !== 0x02014b50) throw new ZipFormatError("Corrupt ZIP central directory");
    const flags = data.readUInt16LE(cursor + 8);
    const method = data.readUInt16LE(cursor + 10);
    const crc = data.readUInt32LE(cursor + 16);
    const compressedSize = data.readUInt32LE(cursor + 20);
    const size = data.readUInt32LE(cursor + 24);
    const nameLength = data.readUInt16LE(cursor + 28);
    const extraLength = data.readUInt16LE(cursor + 30);
    const commentLength = data.readUInt16LE(cursor + 32);
    const localOffset = data.readUInt32LE(cursor + 42);
    const path = data.toString(flags & 0x0800 ? "utf8" : "latin1", cursor + 46, cursor + 46 + nameLength);
    cursor += 46 + nameLength + extraLength + commentLength;
    if (path.endsWith("/")) continue;
    if (flags & 0x0001) throw new ZipFormatError(`Encrypted ZIP entries are not supported: ${path}`);
    if (method !== 0 && method !== 8) throw new ZipFormatError(`Unsupported ZIP compression method ${method}: ${path}`);
    if (size > maxEntryBytes) throw new ZipFormatError(`ZIP entry is too large: ${path}`);
    total += size;
    if (total > maxTotalBytes) throw new ZipFormatError("ZIP archive expands beyond the size limit");
    if (localOffset + 30 > data.length || data.readUInt32LE(localOffset) !== 0x04034b50) throw new ZipFormatError(`Corrupt ZIP entry header: ${path}`);
    const start = localOffset + 30 + data.readUInt16LE(localOffset + 26) + data.readUInt16LE(localOffset + 28);
    const end = start + compressedSize;
    if (end > data.length) throw new ZipFormatError(`ZIP entry is out of bounds: ${path}`);
    const body = data.subarray(start, end);
    let content: Buffer;
    try {
      content = method === 0 ? Buffer.from(body) : inflateRawSync(body, { maxOutputLength: Math.max(1, size) });
    } catch {
      throw new ZipFormatError(`ZIP entry could not be inflated: ${path}`);
    }
    if (content.length !== size || crc32(content) !== crc) throw new ZipFormatError(`ZIP entry failed its integrity check: ${path}`);
    entries.push({ path, data: content });
  }
  return entries;
}

function findEndOfCentralDirectory(data: Buffer): number {
  const minimum = Math.max(0, data.length - 22 - 0xffff);
  for (let offset = data.length - 22; offset >= minimum; offset--) {
    if (data.readUInt32LE(offset) === 0x06054b50) return offset;
  }
  throw new ZipFormatError("Not a ZIP archive (no end of central directory)");
}
