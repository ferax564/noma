/**
 * Typed client for a codixing code-retrieval server (one server indexes one repository) and the
 * GitHub pull-request file listing the dev loop needs for blast radius. Every response is untrusted:
 * requests are time- and size-bounded, the target address is vetted and pinned (no DNS rebinding),
 * redirects are not followed, and payloads are shape-checked before use.
 */
import { request as httpRequest, type IncomingMessage } from "node:http";
import { request as httpsRequest } from "node:https";
import type { LookupFunction } from "node:net";
import { vettedAddress } from "./ai-sources.js";

/** Server-wide code-intelligence settings (per-repository URLs live on the linked repo). */
export interface CodixingSettings {
  /** Let codixing URLs point at private/loopback hosts (a sidecar on the same Docker network). */
  allowPrivateHosts: boolean;
  /** Deadline for one codixing request, in ms. */
  timeoutMs: number;
  /** GitHub REST base for `GET /repos/:repo/pulls/:n/files`. */
  githubApiUrl: string;
  /** Optional GitHub token; public repositories work without one (at GitHub's anonymous rate limit). */
  githubToken?: string;
}

export const DEFAULT_CODIXING_SETTINGS: CodixingSettings = { allowPrivateHosts: false, timeoutMs: 3_000, githubApiUrl: "https://api.github.com" };

/** One codixing server: its base URL and an optional bearer token for the proxy in front of it. */
export interface CodixingTarget {
  url: string;
  token?: string;
}

export type CodixingStrategy = "instant" | "fast" | "thorough" | "explore";

export interface CodixingSearchRequest {
  query: string;
  limit?: number;
  strategy?: CodixingStrategy;
  /** Asks the server for a pre-formatted context block of about this many tokens. */
  tokenBudget?: number;
  fileFilter?: string;
}

/** A ranked code chunk; lines are 1-based and inclusive (codixing reports 0-based, end-exclusive). */
export interface CodixingHit {
  filePath: string;
  lineStart: number;
  lineEnd: number;
  signature: string;
  scopeChain: string[];
  content: string;
  score: number;
  language: string;
}

export interface CodixingSearchResult {
  results: CodixingHit[];
  formattedContext?: string;
}

export class CodixingError extends Error {}

const MAX_URL_LENGTH = 500;
const MAX_PATH_LENGTH = 500;
const MAX_CONTENT_CHARS = 4_000;
const SEARCH_MAX_BYTES = 1_000_000;
const GRAPH_MAX_BYTES = 256_000;
const GITHUB_PAGE_MAX_BYTES = 2_000_000;
const MAX_RESULTS = 50;
const MAX_GRAPH_FILES = 500;

/** Normalises a codixing base URL: http(s), no credentials, query, or fragment. Throws `CodixingError`. */
export function codixingUrl(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length > MAX_URL_LENGTH) throw new CodixingError(`codixingUrl must be at most ${MAX_URL_LENGTH} characters`);
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new CodixingError("codixingUrl must be an absolute http(s) URL");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new CodixingError("codixingUrl must use http or https");
  if (url.username || url.password) throw new CodixingError("codixingUrl must not carry credentials; use codixingToken");
  if (url.search || url.hash) throw new CodixingError("codixingUrl must not have a query or fragment");
  return url.toString().replace(/\/+$/, "");
}

/** `POST /search` — ranked code chunks, and a formatted context block when `tokenBudget` is set. */
export async function codixingSearch(target: CodixingTarget, settings: CodixingSettings, search: CodixingSearchRequest, timeoutMs = settings.timeoutMs): Promise<CodixingSearchResult> {
  const limit = Math.max(1, Math.min(MAX_RESULTS, search.limit ?? 10));
  const body = {
    query: search.query.slice(0, 500),
    limit,
    strategy: search.strategy ?? "fast",
    ...(search.tokenBudget ? { token_budget: Math.max(100, Math.min(16_000, search.tokenBudget)) } : {}),
    ...(search.fileFilter ? { file_filter: search.fileFilter } : {}),
  };
  const payload = record(await requestJson(endpoint(target.url, "search"), { method: "POST", body, token: target.token, timeoutMs, maxBytes: SEARCH_MAX_BYTES, allowPrivateHosts: settings.allowPrivateHosts }));
  if (!Array.isArray(payload.results)) throw new CodixingError("codixing search response has no results array");
  const results = payload.results.flatMap((item) => {
    const hit = searchHit(item);
    return hit ? [hit] : [];
  });
  const budgetChars = (body.token_budget ?? 0) * 4;
  const formatted = typeof payload.formatted_context === "string" && budgetChars > 0 ? payload.formatted_context.slice(0, budgetChars) : undefined;
  return { results: results.slice(0, limit), ...(formatted ? { formattedContext: formatted } : {}) };
}

/** `GET /graph/callers?file=&depth=` — files that (transitively) depend on `file`. */
export async function codixingCallers(target: CodixingTarget, settings: CodixingSettings, file: string, depth = 2, timeoutMs = settings.timeoutMs): Promise<string[]> {
  const url = endpoint(target.url, "graph/callers");
  url.searchParams.set("file", file);
  url.searchParams.set("depth", String(Math.max(1, Math.min(5, depth))));
  const payload = record(await requestJson(url, { method: "GET", token: target.token, timeoutMs, maxBytes: GRAPH_MAX_BYTES, allowPrivateHosts: settings.allowPrivateHosts }));
  if (!Array.isArray(payload.files)) throw new CodixingError("codixing graph response has no files array");
  return payload.files.filter(isRepoPath).slice(0, MAX_GRAPH_FILES);
}

/** Changed file paths of a GitHub pull request, at most `maxPages` × 100. */
export async function pullRequestFiles(settings: CodixingSettings, repo: string, number: number, maxPages = 3, timeoutMs = 5_000): Promise<string[]> {
  const files: string[] = [];
  for (let page = 1; page <= maxPages; page++) {
    const url = endpoint(settings.githubApiUrl, `repos/${repo}/pulls/${number}/files`);
    url.searchParams.set("per_page", "100");
    url.searchParams.set("page", String(page));
    const payload = await requestJson(url, {
      method: "GET",
      token: settings.githubToken,
      headers: { accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28" },
      timeoutMs,
      maxBytes: GITHUB_PAGE_MAX_BYTES,
      allowPrivateHosts: true,
    });
    if (!Array.isArray(payload)) throw new CodixingError("GitHub pull request files response is not an array");
    for (const item of payload) {
      const filename = record(item).filename;
      if (isRepoPath(filename)) files.push(filename);
    }
    if (payload.length < 100) break;
  }
  return [...new Set(files)];
}

function endpoint(base: string, path: string): URL {
  return new URL(path, base.endsWith("/") ? base : `${base}/`);
}

function searchHit(value: unknown): CodixingHit | undefined {
  const item = record(value);
  if (!isRepoPath(item.file_path)) return undefined;
  const lineStart = lineNumber(item.line_start);
  const lineEnd = lineNumber(item.line_end);
  if (lineStart === undefined || lineEnd === undefined) return undefined;
  return {
    filePath: item.file_path,
    lineStart: lineStart + 1,
    lineEnd: Math.max(lineStart + 1, lineEnd),
    signature: typeof item.signature === "string" ? item.signature.slice(0, 300) : "",
    scopeChain: Array.isArray(item.scope_chain) ? item.scope_chain.filter((part): part is string => typeof part === "string").slice(0, 10).map((part) => part.slice(0, 100)) : [],
    content: typeof item.content === "string" ? item.content.slice(0, MAX_CONTENT_CHARS) : "",
    score: typeof item.score === "number" && Number.isFinite(item.score) ? item.score : 0,
    language: typeof item.language === "string" ? item.language.slice(0, 40) : "",
  };
}

function lineNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value < 10_000_000 ? value : undefined;
}

/** A relative repository path: no control characters, no absolute paths, no `..` segments. */
function isRepoPath(value: unknown): value is string {
  if (typeof value !== "string" || !value || value.length > MAX_PATH_LENGTH) return false;
  if (/[\u0000-\u001f\u007f]/.test(value) || value.startsWith("/") || value.includes("\\")) return false;
  return !value.split("/").includes("..");
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

interface JsonRequest {
  method: "GET" | "POST";
  body?: unknown;
  token?: string | undefined;
  headers?: Record<string, string>;
  timeoutMs: number;
  maxBytes: number;
  allowPrivateHosts: boolean;
}

async function requestJson(url: URL, options: JsonRequest): Promise<unknown> {
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new CodixingError("Only http and https URLs are allowed");
  const address = await vettedAddress(url, options.allowPrivateHosts).catch((error: unknown) => {
    throw new CodixingError(error instanceof Error ? error.message : String(error));
  });
  const pinned: LookupFunction = (_hostname, lookupOptions, callback) => {
    if (typeof lookupOptions === "object" && lookupOptions?.all) callback(null, [{ address: address.address, family: address.family }]);
    else callback(null, address.address, address.family);
  };
  const payload = options.body === undefined ? undefined : Buffer.from(JSON.stringify(options.body), "utf8");
  const headers: Record<string, string> = {
    accept: "application/json",
    "user-agent": "NomaCloud-CodeIntel/1",
    ...options.headers,
    ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
    ...(payload ? { "content-type": "application/json", "content-length": String(payload.byteLength) } : {}),
  };
  const send = url.protocol === "https:" ? httpsRequest : httpRequest;
  const text = await new Promise<string>((resolve, reject) => {
    const req = send(url, { method: options.method, lookup: pinned, headers });
    const timer = setTimeout(() => req.destroy(new CodixingError(`Request timed out after ${options.timeoutMs}ms`)), options.timeoutMs);
    const fail = (error: Error) => {
      clearTimeout(timer);
      reject(error instanceof CodixingError ? error : new CodixingError(`Request failed: ${error.message}`));
    };
    req.on("error", fail);
    req.on("response", (response: IncomingMessage) => {
      const status = response.statusCode ?? 0;
      if (status < 200 || status >= 300) {
        response.resume();
        fail(new CodixingError(`HTTP ${status}`));
        return;
      }
      const chunks: Buffer[] = [];
      let size = 0;
      response.on("data", (chunk: Buffer) => {
        size += chunk.byteLength;
        if (size > options.maxBytes) {
          req.destroy(new CodixingError(`Response exceeded ${options.maxBytes} bytes`));
          return;
        }
        chunks.push(chunk);
      });
      response.on("end", () => {
        clearTimeout(timer);
        resolve(Buffer.concat(chunks).toString("utf8"));
      });
      response.on("error", fail);
    });
    req.end(payload);
  });
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new CodixingError("Response is not JSON");
  }
}
