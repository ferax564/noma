/**
 * Wiki macro resolution for the live preview. The preview renders unsaved
 * source in the browser, so macro data comes from a prefetched cache: a render
 * records every lookup it could not answer, `/api/macros/resolve` answers them
 * in one batch, and the preview re-renders with the results.
 */
import {
  type ChildrenRequest,
  type ChildrenResolution,
  type IncludeRequest,
  type IncludeResolution,
  type IssueResolution,
  type IssuesRequest,
  type IssuesResolution,
  type MacroResolvers,
  type PagePropertiesReportRequest,
  type PagePropertiesReportResolution,
} from "../../src/macros.js";
import { fetchCloudJson } from "./api.js";
import { shareToken, state } from "./state.js";

const CACHE_TTL_MS = 30_000;
const MAX_BATCH = 50;
const loading = { status: "unavailable" as const, message: "Loading…" };

interface CacheEntry {
  value: unknown;
  fetchedAt: number;
}

const cache = new Map<string, CacheEntry>();
const pending = new Map<string, Record<string, unknown>>();
let inflight = false;
let cacheDocumentId: string | undefined;

/** Resolvers for one preview render. Unknown lookups show "Loading…" and are fetched by `flushMacroRequests`. */
export function previewMacroResolvers(): MacroResolvers {
  const documentId = state.currentPage?.id;
  if (documentId !== cacheDocumentId) {
    cache.clear();
    pending.clear();
    cacheDocumentId = documentId;
  }
  if (!state.cloudUser && !shareToken) return documentId ? { documentId } : {};
  const lookup = <T>(request: Record<string, unknown>): T => {
    const key = JSON.stringify(request);
    const entry = cache.get(key);
    if (!entry || Date.now() - entry.fetchedAt > CACHE_TTL_MS) pending.set(key, request);
    return (entry?.value ?? loading) as T;
  };
  return {
    ...(documentId ? { documentId } : {}),
    resolveInclude: (request: IncludeRequest): IncludeResolution => lookup({ kind: "include", ...request }),
    resolveChildren: (request: ChildrenRequest): ChildrenResolution => lookup({ kind: "children", ...request }),
    resolveIssue: (key: string): IssueResolution => lookup({ kind: "issue", key }),
    resolveIssues: (request: IssuesRequest): IssuesResolution => lookup({ kind: "issues", ...request }),
    resolvePagePropertiesReport: (request: PagePropertiesReportRequest): PagePropertiesReportResolution =>
      lookup({ kind: "page-properties-report", ...request }),
  };
}

/** Fetch every lookup the last render could not answer, then call `rerender` once. */
export function flushMacroRequests(rerender: () => void): void {
  if (inflight || pending.size === 0) return;
  const batch = [...pending].slice(0, MAX_BATCH);
  for (const [key] of batch) pending.delete(key);
  inflight = true;
  const documentId = cacheDocumentId;
  void fetchCloudJson<{ results: unknown[] }>("/api/macros/resolve", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ ...(documentId ? { documentId } : {}), requests: batch.map(([, request]) => request) }),
  })
    .then((response) => {
      if (documentId !== cacheDocumentId) return;
      const now = Date.now();
      batch.forEach(([key], index) => cache.set(key, { value: response.results[index] ?? { status: "missing" }, fetchedAt: now }));
    })
    .catch((error: unknown) => {
      const now = Date.now();
      const message = error instanceof Error ? error.message : String(error);
      for (const [key] of batch) cache.set(key, { value: { status: "unavailable", message }, fetchedAt: now });
    })
    .finally(() => {
      inflight = false;
      rerender();
    });
}

/** Forget cached macro data, e.g. after the user saves or switches pages. */
export function clearMacroCache(): void {
  cache.clear();
  pending.clear();
}
