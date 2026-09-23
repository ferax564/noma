import { assertSafeImportUrl, parseConfluenceStorage, parseJiraIssue } from "./enterprise-connectors.js";
import { EnterpriseError } from "./enterprise-contracts.js";

export type AtlassianEdition = "cloud" | "datacenter";

export interface AtlassianAuth {
  /**
   * Site root. Cloud: `https://<site>.atlassian.net`. Data Center: the
   * product base URL including any context path (e.g. `https://wiki.corp/confluence`).
   */
  baseUrl: string;
  email?: string;
  apiToken?: string;
  personalAccessToken?: string;
  edition: AtlassianEdition;
  /**
   * Exact hostnames that may resolve to private or loopback addresses.
   * Data Center often lives on an internal network; list its host here to
   * opt it out of the SSRF denylist. Every other host is still checked.
   */
  trustedPrivateHosts?: string[];
}

export interface AtlassianHttp {
  fetch(url: string, init?: RequestInit): Promise<Response>;
}

export interface AtlassianPageOptions {
  /** Items requested per page. Default 50; capped at 100 (Jira Cloud's max). */
  pageSize?: number;
  /** Stop after this many pages and report `truncated`. Default 100. */
  maxPages?: number;
}

export interface AtlassianPaged<T> {
  items: T[];
  pages: number;
  /** True when `maxPages` stopped the walk while the server still had more. */
  truncated: boolean;
}

const MAX_RETRIES = 5;
const MAX_RETRY_AFTER_SECONDS = 60;
const DEFAULT_PAGE_SIZE = 50;
const DEFAULT_MAX_PAGES = 100;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function siteRoot(auth: AtlassianAuth): URL {
  return new URL(auth.baseUrl.endsWith("/") ? auth.baseUrl : `${auth.baseUrl}/`);
}

/**
 * Confluence REST base path relative to `baseUrl`. Cloud serves Confluence
 * under `/wiki`; Data Center serves `/rest/api` directly under its context path.
 */
export function confluenceApiBase(auth: AtlassianAuth): string {
  return auth.edition === "cloud" ? "wiki/rest/api" : "rest/api";
}

/** Jira REST base path. Cloud uses v3 (ADF bodies); Data Center uses v2. */
export function jiraApiBase(auth: AtlassianAuth): string {
  return auth.edition === "cloud" ? "rest/api/3" : "rest/api/2";
}

function assertAllowedUrl(auth: AtlassianAuth, url: string): void {
  const parsed = new URL(url);
  if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
    throw new EnterpriseError("policy", "Atlassian URL scheme is not allowed", { protocol: parsed.protocol });
  }
  const trusted = (auth.trustedPrivateHosts ?? []).map((host) => host.toLowerCase());
  if (!trusted.includes(parsed.hostname.toLowerCase())) assertSafeImportUrl(url);
  if (parsed.origin !== siteRoot(auth).origin) {
    throw new EnterpriseError("policy", "Atlassian request left the configured site", { origin: parsed.origin });
  }
}

function retryDelaySeconds(raw: string | null): number {
  if (raw === null) return 1;
  const seconds = Number(raw);
  if (Number.isFinite(seconds)) return Math.min(MAX_RETRY_AFTER_SECONDS, Math.max(0, seconds));
  const date = Date.parse(raw);
  if (Number.isFinite(date)) return Math.min(MAX_RETRY_AFTER_SECONDS, Math.max(0, (date - Date.now()) / 1000));
  return 1;
}

export async function atlassianFetch(
  auth: AtlassianAuth,
  path: string,
  init: RequestInit = {},
  http: AtlassianHttp = globalThis,
  attempt = 0,
): Promise<Response> {
  const url = new URL(path.replace(/^\/+/, ""), siteRoot(auth)).toString();
  assertAllowedUrl(auth, url);
  const headers = new Headers(init.headers);
  headers.set("accept", "application/json");
  if (auth.edition === "cloud") {
    if (!auth.email || !auth.apiToken) throw new EnterpriseError("unauthorized", "cloud Atlassian auth requires email and apiToken");
    headers.set("authorization", `Basic ${Buffer.from(`${auth.email}:${auth.apiToken}`).toString("base64")}`);
  } else if (auth.personalAccessToken) {
    headers.set("authorization", `Bearer ${auth.personalAccessToken}`);
  }
  const response = await http.fetch(url, { ...init, headers, redirect: "manual" });
  if (response.status === 429 && attempt < MAX_RETRIES) {
    await sleep(retryDelaySeconds(response.headers.get("retry-after")) * 1000);
    return atlassianFetch(auth, path, init, http, attempt + 1);
  }
  return response;
}

async function readJson<T>(response: Response, label: string): Promise<T> {
  if (!response.ok) throw new EnterpriseError("invalid", `${label} HTTP ${response.status}`);
  return (await response.json()) as T;
}

function pageSizeOf(options: AtlassianPageOptions): number {
  return Math.max(1, Math.min(100, Math.floor(options.pageSize ?? DEFAULT_PAGE_SIZE)));
}

function maxPagesOf(options: AtlassianPageOptions): number {
  return Math.max(1, Math.floor(options.maxPages ?? DEFAULT_MAX_PAGES));
}

export async function fetchConfluencePage(auth: AtlassianAuth, pageId: string, http?: AtlassianHttp) {
  const path = `${confluenceApiBase(auth)}/content/${encodeURIComponent(pageId)}?expand=body.storage,version`;
  const json = await readJson<{ title?: unknown; body?: { storage?: { value?: unknown } } }>(
    await atlassianFetch(auth, path, {}, http),
    "confluence",
  );
  const title = String(json.title ?? "Imported page");
  const storage = String(json.body?.storage?.value ?? "");
  return parseConfluenceStorage(storage || `<p>${title}</p>`, title);
}

export interface ConfluenceContentSummary {
  id: string;
  title: string;
  type: string;
}

interface ConfluenceContentPage {
  results?: Array<{ id?: unknown; title?: unknown; type?: unknown }>;
  start?: number;
  size?: number;
  _links?: { next?: string };
}

/**
 * List pages in a Confluence space, following `_links.next` until the server
 * stops returning one or `maxPages` is reached. The continuation is rebuilt
 * from the next link's `start` offset against the configured site, so a
 * hostile `_links.next` cannot redirect the crawl to another host.
 */
export async function listConfluencePages(
  auth: AtlassianAuth,
  spaceKey: string,
  http?: AtlassianHttp,
  options: AtlassianPageOptions = {},
): Promise<AtlassianPaged<ConfluenceContentSummary>> {
  const limit = pageSizeOf(options);
  const maxPages = maxPagesOf(options);
  const items: ConfluenceContentSummary[] = [];
  let start = 0;
  for (let page = 1; ; page++) {
    const query = new URLSearchParams({ spaceKey, type: "page", start: String(start), limit: String(limit) });
    const json = await readJson<ConfluenceContentPage>(
      await atlassianFetch(auth, `${confluenceApiBase(auth)}/content?${query.toString()}`, {}, http),
      "confluence list",
    );
    const results = json.results ?? [];
    for (const row of results) {
      items.push({ id: String(row.id ?? ""), title: String(row.title ?? ""), type: String(row.type ?? "page") });
    }
    const next = json._links?.next;
    if (!next || results.length === 0) return { items, pages: page, truncated: false };
    if (page >= maxPages) return { items, pages: page, truncated: true };
    const nextStart = Number(new URL(next, "http://atlassian.invalid/").searchParams.get("start"));
    const advanced = Number.isFinite(nextStart) && nextStart > start ? nextStart : start + (json.size ?? results.length);
    if (advanced <= start) throw new EnterpriseError("invalid", "confluence pagination did not advance");
    start = advanced;
  }
}

export async function fetchJiraIssuePayload(auth: AtlassianAuth, key: string, http?: AtlassianHttp): Promise<Record<string, unknown>> {
  return readJson<Record<string, unknown>>(
    await atlassianFetch(auth, `${jiraApiBase(auth)}/issue/${encodeURIComponent(key)}`, {}, http),
    "jira",
  );
}

export async function fetchJiraIssue(auth: AtlassianAuth, key: string, http?: AtlassianHttp) {
  return parseJiraIssue(await fetchJiraIssuePayload(auth, key, http));
}

interface JiraCloudSearchPage {
  issues?: unknown[];
  nextPageToken?: string;
  isLast?: boolean;
}

interface JiraDcSearchPage {
  issues?: unknown[];
  startAt?: number;
  maxResults?: number;
  total?: number;
}

/**
 * Run a JQL search and walk every page. Cloud uses the enhanced
 * `/rest/api/3/search/jql` endpoint with `nextPageToken`; Data Center uses
 * `/rest/api/2/search` with `startAt`/`maxResults`/`total`. Stops at
 * `maxPages` and reports `truncated` rather than looping forever.
 */
export async function searchJira(
  auth: AtlassianAuth,
  jql: string,
  http?: AtlassianHttp,
  options: AtlassianPageOptions & { fields?: string[] } = {},
): Promise<{ issues: unknown[]; pages: number; truncated: boolean }> {
  const maxResults = pageSizeOf(options);
  const maxPages = maxPagesOf(options);
  const path = auth.edition === "cloud" ? `${jiraApiBase(auth)}/search/jql` : `${jiraApiBase(auth)}/search`;
  const post = (body: Record<string, unknown>) =>
    atlassianFetch(
      auth,
      path,
      { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) },
      http,
    );
  const fields = options.fields ?? ["*all"];
  const issues: unknown[] = [];
  if (auth.edition === "cloud") {
    let nextPageToken: string | undefined;
    for (let page = 1; ; page++) {
      const json = await readJson<JiraCloudSearchPage>(
        await post({ jql, maxResults, fields, ...(nextPageToken ? { nextPageToken } : {}) }),
        "jira search",
      );
      issues.push(...(json.issues ?? []));
      const done = json.isLast === true || !json.nextPageToken;
      if (done) return { issues, pages: page, truncated: false };
      if (page >= maxPages) return { issues, pages: page, truncated: true };
      if (json.nextPageToken === nextPageToken) throw new EnterpriseError("invalid", "jira pagination did not advance");
      nextPageToken = json.nextPageToken;
    }
  }
  let startAt = 0;
  for (let page = 1; ; page++) {
    const json = await readJson<JiraDcSearchPage>(await post({ jql, startAt, maxResults, fields }), "jira search");
    const batch = json.issues ?? [];
    issues.push(...batch);
    startAt = (json.startAt ?? startAt) + batch.length;
    const total = json.total ?? startAt;
    if (batch.length === 0 || startAt >= total) return { issues, pages: page, truncated: false };
    if (page >= maxPages) return { issues, pages: page, truncated: true };
  }
}
