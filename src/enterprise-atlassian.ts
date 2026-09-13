import { assertSafeImportUrl, parseConfluenceStorage, parseJiraIssue } from "./enterprise-connectors.js";
import { EnterpriseError } from "./enterprise-contracts.js";

export type AtlassianEdition = "cloud" | "datacenter";

export interface AtlassianAuth {
  baseUrl: string;
  email?: string;
  apiToken?: string;
  personalAccessToken?: string;
  edition: AtlassianEdition;
}

export interface AtlassianHttp {
  fetch(url: string, init?: RequestInit): Promise<Response>;
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export async function atlassianFetch(
  auth: AtlassianAuth,
  path: string,
  init: RequestInit = {},
  http: AtlassianHttp = globalThis,
  attempt = 0,
): Promise<Response> {
  const url = new URL(path, auth.baseUrl.endsWith("/") ? auth.baseUrl : `${auth.baseUrl}/`).toString();
  assertSafeImportUrl(url);
  const headers = new Headers(init.headers);
  headers.set("accept", "application/json");
  if (auth.edition === "cloud") {
    if (!auth.email || !auth.apiToken) throw new EnterpriseError("unauthorized", "cloud Atlassian auth requires email and apiToken");
    headers.set("authorization", `Basic ${Buffer.from(`${auth.email}:${auth.apiToken}`).toString("base64")}`);
  } else if (auth.personalAccessToken) {
    headers.set("authorization", `Bearer ${auth.personalAccessToken}`);
  }
  const response = await http.fetch(url, { ...init, headers });
  if (response.status === 429 && attempt < 5) {
    const raw = response.headers.get("retry-after");
    const retryAfter = raw === null ? 1 : Number(raw);
    await sleep(Math.max(0, Number.isFinite(retryAfter) ? retryAfter : 1) * 1000);
    return atlassianFetch(auth, path, init, http, attempt + 1);
  }
  return response;
}

export async function fetchConfluencePage(auth: AtlassianAuth, pageId: string, http?: AtlassianHttp) {
  const path =
    auth.edition === "cloud"
      ? `wiki/api/v2/pages/${encodeURIComponent(pageId)}?body-format=storage`
      : `rest/api/content/${encodeURIComponent(pageId)}?expand=body.storage`;
  const response = await atlassianFetch(auth, path, {}, http);
  if (!response.ok) throw new EnterpriseError("invalid", `confluence HTTP ${response.status}`);
  const json = (await response.json()) as Record<string, unknown>;
  const title = String(json.title ?? "Imported page");
  const storage =
    auth.edition === "cloud"
      ? String(((json.body as { storage?: { value?: string } } | undefined)?.storage?.value) ?? "")
      : String(((json.body as { storage?: { value?: string } } | undefined)?.storage?.value) ?? "");
  return parseConfluenceStorage(storage || `<p>${title}</p>`, title);
}

export async function fetchJiraIssuePayload(auth: AtlassianAuth, key: string, http?: AtlassianHttp): Promise<Record<string, unknown>> {
  const path = auth.edition === "cloud" ? `rest/api/3/issue/${encodeURIComponent(key)}` : `rest/api/2/issue/${encodeURIComponent(key)}`;
  const response = await atlassianFetch(auth, path, {}, http);
  if (!response.ok) throw new EnterpriseError("invalid", `jira HTTP ${response.status}`);
  return (await response.json()) as Record<string, unknown>;
}

export async function fetchJiraIssue(auth: AtlassianAuth, key: string, http?: AtlassianHttp) {
  return parseJiraIssue(await fetchJiraIssuePayload(auth, key, http));
}

export async function searchJira(auth: AtlassianAuth, jql: string, http?: AtlassianHttp) {
  const path = auth.edition === "cloud" ? "rest/api/3/search/jql" : "rest/api/2/search";
  const response = await atlassianFetch(
    auth,
    path,
    { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jql, maxResults: 50 }) },
    http,
  );
  if (!response.ok) throw new EnterpriseError("invalid", `jira search HTTP ${response.status}`);
  return (await response.json()) as { issues?: unknown[] };
}
