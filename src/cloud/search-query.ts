/**
 * Search query language and filters shared by `/api/search` and `/api/knowledge/search`.
 *
 * `q` accepts free words, `"exact phrases"`, and `key:value` filters:
 * `label:how-to author:@ada space:ENG type:page after:2026-01-01 before:2026-07-01 "exact phrase"`.
 * The same filters can be passed as query parameters (`label=`, `author=`, `space=`,
 * `updatedAfter=`, `updatedBefore=`, `type=`); both sources are merged.
 */
import type { CloudSearchFilters, CloudUserRecord } from "../cloud-db.js";
import type { CloudServerConfig } from "./context.js";
import { HttpError } from "./http.js";
import { labelInput } from "./input.js";

export interface ParsedSearchQuery {
  text: string;
  words: string[];
  phrases: string[];
  labels: string[];
  authors: string[];
  spaces: string[];
  types: string[];
  updatedAfter?: string;
  updatedBefore?: string;
  includeArchived: boolean;
}

const FILTER_KEYS = new Set(["label", "author", "space", "type", "after", "before", "updatedafter", "updatedbefore", "archived", "is"]);
const TOKEN_RE = /(-?)([A-Za-z]+):("([^"]*)"|\S+)|"([^"]*)"|(\S+)/g;
const MAX_FILTER_VALUES = 10;

/** Splits `q` into free text, phrases and `key:value` filters. Unknown keys stay free text. */
export function parseSearchQuery(q: string): ParsedSearchQuery {
  const parsed: ParsedSearchQuery = { text: "", words: [], phrases: [], labels: [], authors: [], spaces: [], types: [], includeArchived: false };
  for (const match of q.matchAll(TOKEN_RE)) {
    const [, , key, rawValue, quotedValue, phrase, word] = match;
    if (key && rawValue !== undefined && FILTER_KEYS.has(key.toLowerCase())) {
      applyFilter(parsed, key.toLowerCase(), (quotedValue ?? rawValue).trim());
      continue;
    }
    if (phrase !== undefined) {
      const value = phrase.trim();
      if (value) parsed.phrases.push(value.slice(0, 200));
      continue;
    }
    const value = (word ?? match[0]).trim();
    if (value) parsed.words.push(value);
  }
  parsed.words = parsed.words.slice(0, 12);
  parsed.phrases = parsed.phrases.slice(0, 5);
  parsed.text = [...parsed.words, ...parsed.phrases].join(" ").trim();
  return parsed;
}

/** Folds the explicit query parameters into a parsed query. */
export function mergeSearchParams(parsed: ParsedSearchQuery, params: URLSearchParams): ParsedSearchQuery {
  for (const value of params.getAll("label")) applyFilter(parsed, "label", value);
  for (const value of params.getAll("author")) applyFilter(parsed, "author", value);
  for (const value of params.getAll("space")) applyFilter(parsed, "space", value);
  for (const value of params.getAll("type")) applyFilter(parsed, "type", value);
  const after = params.get("updatedAfter");
  if (after) applyFilter(parsed, "after", after);
  const before = params.get("updatedBefore");
  if (before) applyFilter(parsed, "before", before);
  if (/^(?:1|true|include|yes)$/i.test(params.get("archived") ?? params.get("includeArchived") ?? "")) parsed.includeArchived = true;
  return parsed;
}

function applyFilter(parsed: ParsedSearchQuery, key: string, value: string): void {
  if (!value) return;
  switch (key) {
    case "label":
      pushLimited(parsed.labels, labelInput(value), "label");
      return;
    case "author":
      pushLimited(parsed.authors, value.replace(/^@/, "").slice(0, 80), "author");
      return;
    case "space":
      pushLimited(parsed.spaces, value.slice(0, 120), "space");
      return;
    case "type": {
      const type = value.toLowerCase();
      if (!/^[a-z][a-z0-9_-]{0,63}$/.test(type)) throw new HttpError(400, "type must be page or a block/directive name");
      pushLimited(parsed.types, type, "type");
      return;
    }
    case "after":
    case "updatedafter":
      parsed.updatedAfter = searchDate(value, "updatedAfter");
      return;
    case "before":
    case "updatedbefore":
      parsed.updatedBefore = searchDate(value, "updatedBefore");
      return;
    case "archived":
      parsed.includeArchived = /^(?:1|true|include|yes|only)$/i.test(value);
      return;
    case "is":
      if (value.toLowerCase() === "archived") parsed.includeArchived = true;
      return;
  }
}

function pushLimited(list: string[], value: string, label: string): void {
  if (list.includes(value)) return;
  if (list.length >= MAX_FILTER_VALUES) throw new HttpError(400, `At most ${MAX_FILTER_VALUES} ${label} filters are allowed`);
  list.push(value);
}

function searchDate(value: string, label: string): string {
  const time = Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00.000Z` : value);
  if (!Number.isFinite(time)) throw new HttpError(400, `${label} must be an ISO date`);
  return new Date(time).toISOString();
}

/**
 * Resolves user-facing filter values to IDs. Authors match `me`, a user ID, or a user name
 * (case-insensitive, spaces optional); spaces match a site ID, key, slug or title the caller can see.
 * An unresolvable value yields an impossible filter so results are empty rather than unfiltered.
 */
export function resolveSearchFilters(config: CloudServerConfig, user: CloudUserRecord, parsed: ParsedSearchQuery): CloudSearchFilters {
  const filters: CloudSearchFilters = { includeArchived: parsed.includeArchived };
  if (parsed.labels.length) filters.labels = parsed.labels;
  if (parsed.types.length) filters.types = parsed.types;
  if (parsed.updatedAfter) filters.updatedAfter = parsed.updatedAfter;
  if (parsed.updatedBefore) filters.updatedBefore = parsed.updatedBefore;
  if (parsed.authors.length) {
    const users = config.store.listUsers();
    filters.authorIds = [...new Set(parsed.authors.flatMap((value) => resolveAuthor(users, user, value)))];
    if (filters.authorIds.length === 0) filters.authorIds = ["\u0000none"];
  }
  if (parsed.spaces.length) {
    const sites = config.store.listSites(user);
    filters.siteIds = [...new Set(parsed.spaces.flatMap((value) => resolveSpace(sites, value)))];
    if (filters.siteIds.length === 0) filters.siteIds = ["\u0000none"];
    if (sites.some((site) => site.archivedAt && filters.siteIds?.includes(site.id))) filters.includeArchived = true;
  }
  return filters;
}

function resolveAuthor(users: CloudUserRecord[], caller: CloudUserRecord, value: string): string[] {
  const needle = value.trim().toLowerCase();
  if (needle === "me") return [caller.id];
  const compact = needle.replace(/[\s._-]+/g, "");
  return users
    .filter((candidate) => {
      if (candidate.id === value) return true;
      const name = candidate.name.toLowerCase();
      return name === needle || name.replace(/[\s._-]+/g, "") === compact || name.split(/\s+/)[0] === needle;
    })
    .map((candidate) => candidate.id);
}

function resolveSpace(sites: Array<{ id: string; title: string; slug: string; key?: string }>, value: string): string[] {
  const needle = value.trim().toLowerCase();
  return sites
    .filter((site) => site.id === value || site.key?.toLowerCase() === needle || site.slug.toLowerCase() === needle || site.title.toLowerCase() === needle)
    .map((site) => site.id);
}

/** Echo of the interpreted query so clients can render active filter chips. */
export function searchQueryResponse(parsed: ParsedSearchQuery): Record<string, unknown> {
  return {
    text: parsed.text,
    words: parsed.words,
    phrases: parsed.phrases,
    labels: parsed.labels,
    authors: parsed.authors,
    spaces: parsed.spaces,
    types: parsed.types,
    ...(parsed.updatedAfter ? { updatedAfter: parsed.updatedAfter } : {}),
    ...(parsed.updatedBefore ? { updatedBefore: parsed.updatedBefore } : {}),
    includeArchived: parsed.includeArchived,
  };
}

/** True when the query narrows by anything other than free text. */
export function hasSearchFilterTerms(parsed: ParsedSearchQuery): boolean {
  return Boolean(
    parsed.labels.length || parsed.authors.length || parsed.spaces.length || parsed.types.length || parsed.updatedAfter || parsed.updatedBefore,
  );
}
