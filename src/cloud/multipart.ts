/**
 * Streaming, bounded `multipart/form-data` reader for attachment uploads. It accepts exactly one file
 * part named `file` plus a few small text fields, and yields the file bytes as they arrive so the
 * blob store can hash and stage them without buffering the whole upload.
 */
import { HttpError } from "./http.js";

/** Largest multipart header block, per part. */
const MAX_PART_HEADER_BYTES = 8 * 1024;
/** Largest text field value. */
const MAX_FIELD_BYTES = 4 * 1024;
/** Largest preamble before the first boundary. */
const MAX_PREAMBLE_BYTES = 4 * 1024;
const MAX_PARTS = 16;
const BOUNDARY_RE = /^[0-9A-Za-z'()+_,\-./:=? ]{0,69}[0-9A-Za-z'()+_,\-./:=?]$/;
const CRLF = Buffer.from("\r\n");
const HEADER_END = Buffer.from("\r\n\r\n");

/** Bytes of multipart framing and small fields allowed on top of the attachment size limit. */
export const MULTIPART_OVERHEAD_BYTES = 64 * 1024;

export interface MultipartUpload {
  /** The `file` part's bytes. Throws `HttpError` 400/413 on malformed bodies, a missing file part, or an oversize file. */
  file: AsyncGenerator<Uint8Array>;
  /** Populated as parsing proceeds; complete once `file` has been fully consumed. */
  readonly result: MultipartUploadResult;
}

export interface MultipartUploadResult {
  /** `filename` field, else `name` field, else the file part's `filename` parameter. */
  filename?: string;
  /** The file part's `content-type`. */
  contentType?: string;
}

/** Extracts and validates the `boundary` parameter of a `multipart/form-data` content type. */
export function multipartBoundary(contentType: string): string {
  if (!/^multipart\/form-data\s*(?:;|$)/i.test(contentType)) {
    throw malformed("Only multipart/form-data uploads are supported");
  }
  const match = /;\s*boundary=(?:"((?:[^"\\]|\\.)*)"|([^;\s]+))/i.exec(contentType);
  const boundary = match ? (match[1]?.replace(/\\(.)/g, "$1") ?? match[2] ?? "") : "";
  if (!BOUNDARY_RE.test(boundary)) throw malformed("Multipart boundary is missing or invalid");
  return boundary;
}

/**
 * Parses `source` as `multipart/form-data`. File bytes beyond `maxFileBytes` raise `tooLarge()`.
 * The caller must drain `file` completely; the closing boundary and any trailing fields are
 * validated before the generator finishes.
 */
export function readMultipartUpload(
  source: AsyncIterable<Uint8Array>,
  boundary: string,
  maxFileBytes: number,
  tooLarge: () => Error,
): MultipartUpload {
  const result: MultipartUploadResult = {};
  return { file: parse(source, boundary, maxFileBytes, tooLarge, result), result };
}

type State = "preamble" | "after-boundary" | "headers" | "body" | "done";

interface PartInfo {
  name: string;
  filename?: string;
  contentType?: string;
  isFile: boolean;
}

async function* parse(
  source: AsyncIterable<Uint8Array>,
  boundary: string,
  maxFileBytes: number,
  tooLarge: () => Error,
  result: MultipartUploadResult,
): AsyncGenerator<Uint8Array> {
  const delimiter = Buffer.from(`\r\n--${boundary}`);
  let buffer: Buffer = Buffer.from(CRLF);
  let state = "preamble" as State;
  let preambleBytes = 0;
  let parts = 0;
  let part: PartInfo | undefined;
  let fieldChunks: Buffer[] = [];
  let fieldBytes = 0;
  let fileBytes = 0;
  let sawFile = false;
  const fields = new Map<string, string>();

  const finishPart = (): void => {
    if (!part || part.isFile) return;
    if (part.name === "filename" || part.name === "name") fields.set(part.name, Buffer.concat(fieldChunks).toString("utf8"));
    fieldChunks = [];
    fieldBytes = 0;
  };

  function* consumeBody(bytes: Buffer): Generator<Uint8Array> {
    if (bytes.byteLength === 0 || !part) return;
    if (part.isFile) {
      fileBytes += bytes.byteLength;
      if (fileBytes > maxFileBytes) throw tooLarge();
      yield bytes;
      return;
    }
    fieldBytes += bytes.byteLength;
    if (fieldBytes > MAX_FIELD_BYTES) throw malformed(`Multipart field "${part.name}" is too long`);
    fieldChunks.push(bytes);
  }

  const step = function* (): Generator<Uint8Array, boolean> {
    if (state === "preamble") {
      const index = buffer.indexOf(delimiter);
      if (index < 0) {
        const keep = Math.max(0, buffer.byteLength - (delimiter.byteLength - 1));
        preambleBytes += keep;
        buffer = buffer.subarray(keep);
        if (preambleBytes > MAX_PREAMBLE_BYTES) throw malformed("Multipart body does not start with the declared boundary");
        return false;
      }
      preambleBytes += index;
      if (preambleBytes > MAX_PREAMBLE_BYTES) throw malformed("Multipart body does not start with the declared boundary");
      buffer = buffer.subarray(index + delimiter.byteLength);
      state = "after-boundary";
      return true;
    }
    if (state === "after-boundary") {
      let offset = 0;
      while (offset < buffer.byteLength && (buffer[offset] === 0x20 || buffer[offset] === 0x09)) offset++;
      if (offset > 64) throw malformed("Multipart boundary line is malformed");
      if (buffer.byteLength - offset < 2) return false;
      const marker = buffer.subarray(offset, offset + 2).toString("latin1");
      if (marker === "--") {
        buffer = Buffer.alloc(0);
        state = "done";
        return false;
      }
      if (marker !== "\r\n") throw malformed("Multipart boundary line is malformed");
      buffer = buffer.subarray(offset + 2);
      state = "headers";
      return true;
    }
    if (state === "headers") {
      const index = buffer.indexOf(HEADER_END);
      if (index < 0) {
        if (buffer.byteLength > MAX_PART_HEADER_BYTES) throw malformed("Multipart part headers are too large");
        return false;
      }
      if (index > MAX_PART_HEADER_BYTES) throw malformed("Multipart part headers are too large");
      parts += 1;
      if (parts > MAX_PARTS) throw malformed("Multipart body has too many parts");
      part = parsePartHeaders(buffer.subarray(0, index).toString("utf8"));
      if (part.isFile) {
        if (sawFile) throw malformed('Multipart body has more than one "file" part');
        sawFile = true;
        if (part.contentType) result.contentType = part.contentType;
        if (part.filename) result.filename = part.filename;
      }
      buffer = buffer.subarray(index + HEADER_END.byteLength);
      state = "body";
      return true;
    }
    if (state === "body") {
      const index = buffer.indexOf(delimiter);
      if (index < 0) {
        const keep = Math.max(0, buffer.byteLength - (delimiter.byteLength - 1));
        if (keep > 0) {
          const chunk = Buffer.from(buffer.subarray(0, keep));
          buffer = buffer.subarray(keep);
          yield* consumeBody(chunk);
        }
        return false;
      }
      const chunk = Buffer.from(buffer.subarray(0, index));
      buffer = buffer.subarray(index + delimiter.byteLength);
      yield* consumeBody(chunk);
      finishPart();
      part = undefined;
      state = "after-boundary";
      return true;
    }
    return false;
  };

  for await (const chunk of source) {
    if (state === "done") continue;
    buffer = buffer.byteLength === 0 ? Buffer.from(chunk) : Buffer.concat([buffer, chunk]);
    while (yield* step());
  }
  if (state !== "done") throw malformed("Multipart body ended before the closing boundary");
  if (!sawFile) throw new HttpError(400, 'Multipart upload needs a "file" part', { code: "attachment_multipart_missing_file" });
  const filename = fields.get("filename")?.trim() || fields.get("name")?.trim();
  if (filename) result.filename = filename;
}

function parsePartHeaders(block: string): PartInfo {
  let disposition: string | undefined;
  let contentType: string | undefined;
  for (const line of block.split("\r\n")) {
    const colon = line.indexOf(":");
    if (colon <= 0) throw malformed("Multipart part header is malformed");
    const name = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (name === "content-disposition") disposition = value;
    else if (name === "content-type") contentType = value;
  }
  if (!disposition || !/^form-data\s*(?:;|$)/i.test(disposition)) throw malformed("Multipart part needs content-disposition: form-data");
  const params = dispositionParams(disposition);
  const name = params.get("name");
  if (name === undefined) throw malformed("Multipart part is missing its name");
  const filename = params.get("filename*") ?? params.get("filename");
  return {
    name,
    ...(filename !== undefined ? { filename } : {}),
    ...(contentType ? { contentType } : {}),
    isFile: name === "file",
  };
}

function dispositionParams(value: string): Map<string, string> {
  const params = new Map<string, string>();
  const re = /;\s*([A-Za-z0-9!#$&+.^_`|~-]+\*?)\s*=\s*(?:"((?:[^"\\]|\\.)*)"|([^;\s]*))/g;
  for (let match = re.exec(value); match; match = re.exec(value)) {
    const key = (match[1] ?? "").toLowerCase();
    let param = match[2] !== undefined ? match[2].replace(/\\(.)/g, "$1") : (match[3] ?? "");
    if (key.endsWith("*")) {
      const extended = /^([A-Za-z0-9-]+)'[^']*'(.*)$/.exec(param);
      if (!extended || extended[1]?.toLowerCase() !== "utf-8") continue;
      try {
        param = decodeURIComponent(extended[2] ?? "");
      } catch {
        continue;
      }
    }
    if (!params.has(key)) params.set(key, param);
  }
  return params;
}

function malformed(message: string): HttpError {
  return new HttpError(400, message, { code: "attachment_multipart_malformed" });
}
