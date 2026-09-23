/**
 * Fetches external source material for AI refresh. Every hop resolves DNS once, rejects private,
 * loopback, link-local, and metadata addresses, and pins the connection to the vetted address so a
 * rebinding DNS answer cannot redirect the request. Responses are size- and time-bounded text.
 */
import { lookup } from "node:dns/promises";
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP, type LookupFunction } from "node:net";
import { sha256Hex } from "./http.js";

export interface FetchedSource {
  url: string;
  finalUrl: string;
  contentType: string;
  text: string;
  contentHash: string;
  truncated: boolean;
}

export class SourceFetchError extends Error {}

export interface SourceFetchOptions {
  allowPrivateHosts: boolean;
  timeoutMs?: number;
  maxBytes?: number;
  maxChars?: number;
}

const maxRedirects = 3;

export async function fetchSourceText(rawUrl: string, options: SourceFetchOptions): Promise<FetchedSource> {
  let url = parseSourceUrl(rawUrl);
  for (let hop = 0; hop <= maxRedirects; hop++) {
    const address = await vettedAddress(url, options.allowPrivateHosts);
    const response = await requestOnce(url, address, options.timeoutMs ?? 10_000);
    const status = response.statusCode ?? 0;
    if (status >= 300 && status < 400 && response.headers.location) {
      response.resume();
      url = parseSourceUrl(new URL(response.headers.location, url).toString());
      continue;
    }
    if (status < 200 || status >= 300) {
      response.resume();
      throw new SourceFetchError(`Source returned HTTP ${status}`);
    }
    const contentType = String(response.headers["content-type"] ?? "text/plain").toLowerCase();
    if (!/^(text\/|application\/(json|xml|xhtml\+xml|ld\+json))/.test(contentType)) {
      response.resume();
      throw new SourceFetchError(`Unsupported source content type: ${contentType.split(";")[0]}`);
    }
    const { body, truncated } = await readBounded(response, options.maxBytes ?? 1_000_000);
    const raw = body.toString("utf8");
    const text = contentType.includes("html") ? htmlToText(raw) : raw;
    const maxChars = options.maxChars ?? 40_000;
    return {
      url: rawUrl,
      finalUrl: url.toString(),
      contentType: contentType.split(";")[0] ?? contentType,
      text: text.slice(0, maxChars),
      contentHash: sha256Hex(raw),
      truncated: truncated || text.length > maxChars,
    };
  }
  throw new SourceFetchError("Too many redirects");
}

function parseSourceUrl(value: string): URL {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new SourceFetchError("Source URL is not valid");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new SourceFetchError("Source URL must use http or https");
  if (url.username || url.password) throw new SourceFetchError("Source URL must not carry credentials");
  return url;
}

async function vettedAddress(url: URL, allowPrivateHosts: boolean): Promise<{ address: string; family: number }> {
  const host = url.hostname.replace(/^\[|\]$/g, "");
  const answers = isIP(host) ? [{ address: host, family: isIP(host) }] : await lookup(host, { all: true, verbatim: true }).catch(() => {
    throw new SourceFetchError("Source host does not resolve");
  });
  if (answers.length === 0) throw new SourceFetchError("Source host does not resolve");
  if (!allowPrivateHosts && answers.some((answer) => isNonPublicAddress(answer.address))) {
    throw new SourceFetchError("Source host resolves to a private or reserved address");
  }
  return answers[0]!;
}

function requestOnce(url: URL, address: { address: string; family: number }, timeoutMs: number): Promise<IncomingMessage> {
  const pinned: LookupFunction = (_hostname, options, callback) => {
    if (typeof options === "object" && options?.all) callback(null, [{ address: address.address, family: address.family }]);
    else callback(null, address.address, address.family);
  };
  const send = url.protocol === "https:" ? httpsRequest : httpRequest;
  return new Promise((resolve, reject) => {
    const req = send(url, { method: "GET", lookup: pinned, headers: { accept: "text/html, text/plain, application/json;q=0.9, */*;q=0.1", "user-agent": "NomaCloud-AI-Refresh/1" }, timeout: timeoutMs }, resolve);
    req.on("timeout", () => req.destroy(new SourceFetchError(`Source timed out after ${timeoutMs}ms`)));
    req.on("error", (error) => reject(error instanceof SourceFetchError ? error : new SourceFetchError(`Source request failed: ${error.message}`)));
    req.end();
  });
}

function readBounded(response: IncomingMessage, maxBytes: number): Promise<{ body: Buffer; truncated: boolean }> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let truncated = false;
    response.on("data", (chunk: Buffer) => {
      if (truncated) return;
      const remaining = maxBytes - size;
      if (chunk.byteLength > remaining) {
        chunks.push(chunk.subarray(0, remaining));
        size = maxBytes;
        truncated = true;
        response.destroy();
        resolve({ body: Buffer.concat(chunks), truncated });
        return;
      }
      chunks.push(chunk);
      size += chunk.byteLength;
    });
    response.on("end", () => resolve({ body: Buffer.concat(chunks), truncated }));
    response.on("error", (error) => (truncated ? undefined : reject(new SourceFetchError(`Source read failed: ${error.message}`))));
  });
}

export function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|noscript|template)[\s\S]*?<\/\1>/gi, " ")
    .replace(/<!--[\s\S]*?-->/g, " ")
    .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr)\b[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/[ \t]+/g, " ")
    .replace(/\n\s*\n+/g, "\n\n")
    .trim();
}

export function isNonPublicAddress(address: string): boolean {
  const version = isIP(address);
  if (version === 4) return nonPublicIpv4(address);
  if (version !== 6) return true;
  const lower = address.toLowerCase();
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower)?.[1];
  if (mapped) return nonPublicIpv4(mapped);
  if (lower === "::" || lower === "::1") return true;
  const first = parseInt(lower.split(":")[0] || "0", 16);
  if ((first & 0xfe00) === 0xfc00) return true;
  if ((first & 0xffc0) === 0xfe80) return true;
  if ((first & 0xff00) === 0xff00) return true;
  if (lower.startsWith("64:ff9b:") || lower.startsWith("2001:db8:") || lower.startsWith("2002:")) return true;
  return false;
}

function nonPublicIpv4(address: string): boolean {
  const [a = 0, b = 0, c = 0] = address.split(".").map(Number);
  if (a === 0 || a === 10 || a === 127) return true;
  if (a === 100 && b >= 64 && b <= 127) return true;
  if (a === 169 && b === 254) return true;
  if (a === 172 && b >= 16 && b <= 31) return true;
  if (a === 192 && b === 168) return true;
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return true;
  if (a === 198 && (b === 18 || b === 19)) return true;
  if (a === 198 && b === 51 && c === 100) return true;
  if (a === 203 && b === 0 && c === 113) return true;
  return a >= 224;
}
