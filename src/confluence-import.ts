/**
 * Confluence space sources for import: the live REST API (Cloud v2 or Data
 * Center v1, through `enterprise-atlassian` with SSRF-checked fetches), the
 * XML space export (`entities.xml`, optionally inside the export ZIP), and a
 * JSON bundle of storage-format pages. All sources produce the same bounded
 * `ConfluenceSpace` shape.
 */
import { lookup } from "node:dns/promises";
import { isIP } from "node:net";
import { type AtlassianAuth, atlassianFetch, type AtlassianHttp } from "./enterprise-atlassian.js";
import { assertSafeImportUrl } from "./enterprise-connectors.js";
import { decodeEntities, MAX_STORAGE_BYTES } from "./confluence-storage.js";
import { isZip, readZip } from "./zip.js";

export const MAX_IMPORT_PAGES = 2_000;

export interface ConfluencePage {
  id: string;
  title: string;
  parentId?: string;
  storage: string;
  labels: string[];
  author?: string;
  createdAt?: string;
  updatedAt?: string;
  version?: string;
  position?: number;
  url?: string;
}

export interface ConfluenceSpace {
  spaceKey: string;
  spaceName?: string;
  baseUrl?: string;
  pages: ConfluencePage[];
}

export class ConfluenceImportError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

// -- JSON bundle -------------------------------------------------------------

/**
 * `{ format: "noma-confluence-bundle", spaceKey, spaceName?, baseUrl?, pages: [{ id, title,
 * parentId?, storage, labels?, author?, createdAt?, updatedAt?, version?, position? }] }`
 */
export function parseConfluenceBundle(value: unknown): ConfluenceSpace {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ConfluenceImportError("bundle must be an object");
  const bundle = value as Record<string, unknown>;
  if (bundle.format !== undefined && bundle.format !== "noma-confluence-bundle") throw new ConfluenceImportError('bundle.format must be "noma-confluence-bundle"');
  const spaceKey = spaceKeyInput(bundle.spaceKey);
  if (!Array.isArray(bundle.pages)) throw new ConfluenceImportError("bundle.pages must be an array");
  if (bundle.pages.length > MAX_IMPORT_PAGES) throw new ConfluenceImportError(`A bundle can contain at most ${MAX_IMPORT_PAGES} pages`);
  const pages = bundle.pages.map((raw, index): ConfluencePage => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new ConfluenceImportError(`bundle.pages[${index}] must be an object`);
    const page = raw as Record<string, unknown>;
    const id = scalarText(page.id);
    const title = scalarText(page.title);
    if (!id || !title) throw new ConfluenceImportError(`bundle.pages[${index}] needs id and title`);
    if (typeof page.storage !== "string") throw new ConfluenceImportError(`bundle.pages[${index}].storage must be a string`);
    return {
      id: id.slice(0, 80),
      title: title.slice(0, 250),
      ...(scalarText(page.parentId) ? { parentId: scalarText(page.parentId)!.slice(0, 80) } : {}),
      storage: boundedStorage(page.storage, id),
      labels: labelList(page.labels),
      ...optionalText("author", page.author),
      ...optionalText("createdAt", page.createdAt),
      ...optionalText("updatedAt", page.updatedAt),
      ...optionalText("version", page.version),
      ...(typeof page.position === "number" && Number.isFinite(page.position) ? { position: page.position } : {}),
    };
  });
  return {
    spaceKey,
    ...optionalText("spaceName", bundle.spaceName),
    ...(typeof bundle.baseUrl === "string" && /^https?:\/\//.test(bundle.baseUrl) ? { baseUrl: bundle.baseUrl } : {}),
    pages,
  };
}

// -- XML space export (entities.xml) -------------------------------------------

interface ExportObject {
  className: string;
  id: string;
  properties: Map<string, { text: string; refId?: string; refClass?: string }>;
  collections: Map<string, string[]>;
}

/** Read a Confluence XML space export: the export ZIP, or `entities.xml` itself. */
export function parseConfluenceArchive(data: Uint8Array): ConfluenceSpace {
  if (isZip(data)) {
    let entries;
    try {
      entries = readZip(data, { maxEntries: 50_000, maxEntryBytes: 300_000_000, maxTotalBytes: 300_000_000 });
    } catch (error) {
      throw new ConfluenceImportError(`Could not read the export ZIP: ${error instanceof Error ? error.message : String(error)}`);
    }
    const entities = entries.find((entry) => /(^|\/)entities\.xml$/i.test(entry.path));
    if (!entities) {
      const html = entries.some((entry) => /\.html?$/i.test(entry.path));
      throw new ConfluenceImportError(
        html
          ? "This looks like a Confluence HTML export. Export the space as XML (Space settings → Export space → XML) and upload that ZIP."
          : "The ZIP has no entities.xml; upload a Confluence XML space export.",
      );
    }
    return parseConfluenceEntitiesXml(entities.data.toString("utf8"));
  }
  return parseConfluenceEntitiesXml(Buffer.from(data).toString("utf8"));
}

/**
 * Parse `entities.xml` (Hibernate object dump). Only current pages are kept:
 * historical versions carry `originalVersion`, drafts and trashed pages have a
 * non-`current` content status.
 */
export function parseConfluenceEntitiesXml(xml: string): ConfluenceSpace {
  if (!/<hibernate-generic\b/i.test(xml.slice(0, 4096)) && !/<object\s+class=/i.test(xml)) {
    throw new ConfluenceImportError("entities.xml does not look like a Confluence XML export");
  }
  const objects = scanExportObjects(xml);
  const byClass = (name: string): ExportObject[] => objects.filter((object) => object.className === name);
  const space = byClass("Space")[0];
  const spaceKey = spaceKeyInput(space?.properties.get("key")?.text ?? "IMPORT");
  const bodies = new Map<string, string>();
  for (const body of byClass("BodyContent")) {
    const owner = body.properties.get("content")?.refId;
    const text = body.properties.get("body")?.text;
    if (owner && text !== undefined && !bodies.has(owner)) bodies.set(owner, text);
  }
  const users = new Map<string, string>();
  for (const user of byClass("ConfluenceUserImpl")) {
    const name = user.properties.get("name")?.text ?? user.properties.get("lowerName")?.text;
    if (name) users.set(user.id, name);
  }
  const labels = new Map<string, string>();
  for (const label of byClass("Label")) {
    const name = label.properties.get("name")?.text;
    const namespace = label.properties.get("namespace")?.text ?? "global";
    if (name && namespace === "global") labels.set(label.id, name);
  }
  const pageLabels = new Map<string, string[]>();
  for (const labelling of byClass("Labelling")) {
    const labelId = labelling.properties.get("label")?.refId;
    const contentId = labelling.properties.get("content")?.refId;
    const name = labelId ? labels.get(labelId) : undefined;
    if (!name || !contentId) continue;
    pageLabels.set(contentId, [...(pageLabels.get(contentId) ?? []), name]);
  }
  const pageObjects = byClass("Page").filter(
    (page) => !page.properties.get("originalVersion")?.refId && (page.properties.get("contentStatus")?.text ?? "current") === "current",
  );
  if (pageObjects.length > MAX_IMPORT_PAGES) throw new ConfluenceImportError(`The export contains more than ${MAX_IMPORT_PAGES} pages`);
  const pages = pageObjects.map((page): ConfluencePage => {
    const author = page.properties.get("creator")?.refId ?? page.properties.get("lastModifier")?.refId;
    const position = Number(page.properties.get("position")?.text);
    return {
      id: page.id,
      title: (page.properties.get("title")?.text ?? `Page ${page.id}`).slice(0, 250),
      ...(page.properties.get("parent")?.refId ? { parentId: page.properties.get("parent")!.refId } : {}),
      storage: boundedStorage(bodies.get(page.id) ?? "", page.id),
      labels: labelList(pageLabels.get(page.id)),
      ...(author ? { author: users.get(author) ?? author } : {}),
      ...optionalText("createdAt", exportDate(page.properties.get("creationDate")?.text)),
      ...optionalText("updatedAt", exportDate(page.properties.get("lastModificationDate")?.text)),
      ...optionalText("version", page.properties.get("version")?.text),
      ...(Number.isFinite(position) ? { position } : {}),
    };
  });
  return { spaceKey, ...optionalText("spaceName", space?.properties.get("name")?.text), pages };
}

function scanExportObjects(xml: string): ExportObject[] {
  const objects: ExportObject[] = [];
  let index = 0;
  while (index < xml.length) {
    const start = xml.indexOf("<object ", index);
    if (start === -1) break;
    const headEnd = xml.indexOf(">", start);
    if (headEnd === -1) break;
    const head = xml.slice(start, headEnd);
    const end = closingIndex(xml, headEnd + 1, "</object>");
    const body = xml.slice(headEnd + 1, end);
    index = end + "</object>".length;
    const className = /class="([^"]+)"/.exec(head)?.[1];
    if (!className || !["Page", "BodyContent", "Space", "ConfluenceUserImpl", "Label", "Labelling"].includes(className)) continue;
    objects.push(parseExportObject(className, body));
    if (objects.length > 500_000) throw new ConfluenceImportError("The export has too many objects");
  }
  return objects;
}

function parseExportObject(className: string, body: string): ExportObject {
  const object: ExportObject = { className, id: "", properties: new Map(), collections: new Map() };
  const tagRe = /<(property|collection|id)\b([^>]*?)(\/?)>/g;
  let cursor = 0;
  for (;;) {
    tagRe.lastIndex = cursor;
    const match = tagRe.exec(body);
    if (!match) break;
    const [head, kind, attrs = "", selfClosing] = match;
    const contentStart = match.index + head.length;
    const closeTag = `</${kind}>`;
    const contentEnd = selfClosing ? contentStart : closingIndex(body, contentStart, closeTag);
    cursor = selfClosing ? contentStart : contentEnd + closeTag.length;
    const content = body.slice(contentStart, contentEnd);
    if (kind === "id") {
      if (!object.id) object.id = xmlText(content).trim();
      continue;
    }
    const name = /name="([^"]+)"/.exec(attrs)?.[1];
    if (!name) continue;
    if (kind === "collection") {
      object.collections.set(name, [...content.matchAll(/<id\b[^>]*>([^<]*)<\/id>/g)].map((id) => id[1]!.trim()));
      continue;
    }
    const refClass = /class="([^"]+)"/.exec(attrs)?.[1];
    const refRaw = refClass ? /<id\b[^>]*>([\s\S]*?)<\/id>/.exec(content)?.[1] : undefined;
    const refId = refRaw === undefined ? undefined : xmlText(refRaw).trim() || undefined;
    object.properties.set(name, { text: refClass ? "" : xmlText(content), ...(refId ? { refId } : {}), ...(refClass ? { refClass } : {}) });
  }
  return object;
}

/** Index of `closeTag` at or after `from`, skipping CDATA sections. */
function closingIndex(body: string, from: number, closeTag: string): number {
  let cursor = from;
  while (cursor < body.length) {
    const close = body.indexOf(closeTag, cursor);
    const cdata = body.indexOf("<![CDATA[", cursor);
    if (close === -1) return body.length;
    if (cdata === -1 || close < cdata) return close;
    const cdataEnd = body.indexOf("]]>", cdata + 9);
    if (cdataEnd === -1) return body.length;
    cursor = cdataEnd + 3;
  }
  return body.length;
}

function xmlText(raw: string): string {
  let out = "";
  let cursor = 0;
  while (cursor < raw.length) {
    const cdata = raw.indexOf("<![CDATA[", cursor);
    if (cdata === -1) {
      out += decodeEntities(raw.slice(cursor));
      break;
    }
    out += decodeEntities(raw.slice(cursor, cdata));
    const end = raw.indexOf("]]>", cdata + 9);
    out += raw.slice(cdata + 9, end === -1 ? raw.length : end);
    cursor = end === -1 ? raw.length : end + 3;
  }
  return out;
}

function exportDate(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const iso = value.trim().replace(" ", "T");
  return Number.isFinite(Date.parse(iso)) ? new Date(iso.endsWith("Z") ? iso : `${iso}Z`).toISOString() : undefined;
}

// -- Live REST API ----------------------------------------------------------------

export interface LiveConfluenceOptions {
  baseUrl: string;
  deployment: "cloud" | "datacenter";
  email?: string;
  apiToken?: string;
  personalAccessToken?: string;
  spaceKey: string;
  /** Allow private/loopback targets. Only for tests and self-hosted Data Center on a private network. */
  allowPrivateHosts?: boolean;
  timeoutMs?: number;
}

/** Fetch every current page of a space with bodies, parents, and labels. */
export async function fetchConfluenceSpace(options: LiveConfluenceOptions, onProgress?: (fetched: number) => void): Promise<ConfluenceSpace> {
  const normalized = normalizeBaseUrl(options.baseUrl, options.allowPrivateHosts === true);
  const baseUrl = options.deployment === "cloud" ? normalized.replace(/\/wiki$/, "") : normalized;
  const spaceKey = spaceKeyInput(options.spaceKey);
  if (options.deployment === "cloud" && (!options.email || !options.apiToken)) throw new ConfluenceImportError("Confluence Cloud needs email and apiToken");
  if (options.deployment === "datacenter" && !options.personalAccessToken) throw new ConfluenceImportError("Confluence Data Center needs a personal access token (pat)");
  const auth: AtlassianAuth = {
    baseUrl,
    edition: options.deployment,
    ...(options.email ? { email: options.email } : {}),
    ...(options.apiToken ? { apiToken: options.apiToken } : {}),
    ...(options.personalAccessToken ? { personalAccessToken: options.personalAccessToken } : {}),
    ...(options.allowPrivateHosts ? { allowPrivateHosts: true } : {}),
  };
  const http = guardedHttp(baseUrl, options.allowPrivateHosts === true, options.timeoutMs ?? 30_000);
  const get = async (path: string): Promise<Record<string, unknown>> => {
    const response = await atlassianFetch(auth, path, {}, http).catch((error: unknown) => {
      if (error instanceof ConfluenceImportError) throw error;
      throw new ConfluenceImportError(`Could not reach Confluence: ${error instanceof Error ? error.message : String(error)}`, 502);
    });
    if (response.status === 401 || response.status === 403) throw new ConfluenceImportError(`Confluence rejected the credentials (HTTP ${response.status})`, 502);
    if (response.status === 404) throw new ConfluenceImportError(`Confluence returned 404 for ${path.split("?")[0]}`, 502);
    if (!response.ok) throw new ConfluenceImportError(`Confluence request failed (HTTP ${response.status})`, 502);
    const text = await response.text();
    if (text.length > 60_000_000) throw new ConfluenceImportError("Confluence response is too large", 502);
    try {
      return JSON.parse(text) as Record<string, unknown>;
    } catch {
      throw new ConfluenceImportError("Confluence returned invalid JSON", 502);
    }
  };
  return options.deployment === "cloud"
    ? fetchCloudSpace(get, baseUrl, spaceKey, onProgress)
    : fetchDataCenterSpace(get, baseUrl, spaceKey, onProgress);
}

type JsonGet = (path: string) => Promise<Record<string, unknown>>;

async function fetchCloudSpace(get: JsonGet, baseUrl: string, spaceKey: string, onProgress?: (fetched: number) => void): Promise<ConfluenceSpace> {
  const spaces = await get(`wiki/api/v2/spaces?keys=${encodeURIComponent(spaceKey)}&limit=1`);
  const space = asRecords(spaces.results)[0];
  if (!space) throw new ConfluenceImportError(`No Confluence space with key ${spaceKey}`, 404);
  const spaceId = scalarText(space.id);
  if (!spaceId) throw new ConfluenceImportError("Confluence space has no id", 502);
  const pages: ConfluencePage[] = [];
  let next: string | undefined = `wiki/api/v2/spaces/${encodeURIComponent(spaceId)}/pages?body-format=storage&status=current&limit=100`;
  for (let requests = 0; next && requests < 100; requests++) {
    const batch = await get(next);
    for (const raw of asRecords(batch.results)) {
      if (pages.length >= MAX_IMPORT_PAGES) throw new ConfluenceImportError(`The space has more than ${MAX_IMPORT_PAGES} pages`);
      const id = scalarText(raw.id);
      if (!id) continue;
      const version = record(raw.version);
      const body = record(record(raw.body).storage);
      const links = record(raw._links);
      pages.push({
        id,
        title: (scalarText(raw.title) ?? `Page ${id}`).slice(0, 250),
        ...(raw.parentType === "page" && scalarText(raw.parentId) ? { parentId: scalarText(raw.parentId)! } : {}),
        storage: boundedStorage(typeof body.value === "string" ? body.value : "", id),
        labels: [],
        ...optionalText("author", raw.authorId),
        ...optionalText("createdAt", raw.createdAt),
        ...optionalText("updatedAt", version.createdAt),
        ...optionalText("version", version.number),
        ...(typeof raw.position === "number" ? { position: raw.position } : {}),
        ...(typeof links.webui === "string" ? { url: `${baseUrl}/wiki${links.webui.startsWith("/") ? "" : "/"}${links.webui}` } : {}),
      });
    }
    onProgress?.(pages.length);
    next = nextPath(record(batch._links).next, baseUrl);
  }
  for (const page of pages) {
    const labels = await get(`wiki/api/v2/pages/${encodeURIComponent(page.id)}/labels?limit=100`);
    page.labels = labelList(asRecords(labels.results).filter((label) => (label.prefix ?? "global") === "global").map((label) => label.name));
  }
  return { spaceKey, ...optionalText("spaceName", space.name), baseUrl: `${baseUrl}/wiki`, pages };
}

async function fetchDataCenterSpace(get: JsonGet, baseUrl: string, spaceKey: string, onProgress?: (fetched: number) => void): Promise<ConfluenceSpace> {
  const space = await get(`rest/api/space/${encodeURIComponent(spaceKey)}`);
  const pages: ConfluencePage[] = [];
  const expand = "body.storage,ancestors,metadata.labels,version,history";
  for (let start = 0, requests = 0; requests < 100; requests++) {
    const batch = await get(`rest/api/content?spaceKey=${encodeURIComponent(spaceKey)}&type=page&status=current&expand=${expand}&limit=100&start=${start}`);
    const results = asRecords(batch.results);
    for (const raw of results) {
      if (pages.length >= MAX_IMPORT_PAGES) throw new ConfluenceImportError(`The space has more than ${MAX_IMPORT_PAGES} pages`);
      const id = scalarText(raw.id);
      if (!id) continue;
      const ancestors = asRecords(raw.ancestors);
      const parent = ancestors[ancestors.length - 1];
      const version = record(raw.version);
      const history = record(raw.history);
      const links = record(raw._links);
      pages.push({
        id,
        title: (scalarText(raw.title) ?? `Page ${id}`).slice(0, 250),
        ...(parent && scalarText(parent.id) ? { parentId: scalarText(parent.id)! } : {}),
        storage: boundedStorage(String(record(record(raw.body).storage).value ?? ""), id),
        labels: labelList(asRecords(record(record(raw.metadata).labels).results).map((label) => label.name)),
        ...optionalText("author", record(history.createdBy).displayName ?? record(history.createdBy).username),
        ...optionalText("createdAt", history.createdDate),
        ...optionalText("updatedAt", version.when),
        ...optionalText("version", version.number),
        ...(typeof links.webui === "string" ? { url: `${baseUrl.replace(/\/+$/, "")}${links.webui.startsWith("/") ? "" : "/"}${links.webui}` } : {}),
      });
    }
    onProgress?.(pages.length);
    if (results.length === 0 || !record(batch._links).next) break;
    start += results.length;
  }
  return { spaceKey, ...optionalText("spaceName", space.name), baseUrl, pages };
}

function nextPath(value: unknown, baseUrl: string): string | undefined {
  if (typeof value !== "string" || !value) return undefined;
  const base = new URL(baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`);
  const target = new URL(value, base.origin);
  if (target.origin !== base.origin) throw new ConfluenceImportError("Confluence pagination left the configured site", 502);
  const relative = target.pathname.startsWith(base.pathname) ? target.pathname.slice(base.pathname.length) : target.pathname.replace(/^\/+/, "");
  return `${relative}${target.search}`;
}

/** Validate a live import target before a job is queued: https, no credentials, public address unless allowed. */
export async function assertImportTarget(baseUrl: string, allowPrivate: boolean): Promise<string> {
  const normalized = normalizeBaseUrl(baseUrl, allowPrivate);
  if (!allowPrivate) {
    try {
      assertSafeImportUrl(normalized);
    } catch {
      throw new ConfluenceImportError("baseUrl points at a private or disallowed host");
    }
    await assertPublicHost(new URL(normalized).hostname);
  }
  return normalized;
}

function normalizeBaseUrl(value: string, allowPrivate: boolean): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new ConfluenceImportError("baseUrl must be an absolute URL");
  }
  if (url.protocol !== "https:" && !(allowPrivate && url.protocol === "http:")) throw new ConfluenceImportError("baseUrl must use https");
  if (url.username || url.password) throw new ConfluenceImportError("baseUrl must not contain credentials");
  url.search = "";
  url.hash = "";
  return url.toString().replace(/\/+$/, "");
}

/**
 * Fetch wrapper that re-checks every URL (scheme, literal and resolved IPs),
 * refuses redirects, and times out. Resolution happens right before the
 * request; a DNS answer that changes in between is a residual risk.
 */
export function guardedHttp(baseUrl: string, allowPrivate: boolean, timeoutMs: number): AtlassianHttp {
  const origin = new URL(baseUrl).origin;
  return {
    async fetch(url: string, init?: RequestInit): Promise<Response> {
      const target = new URL(url);
      if (target.origin !== origin) throw new ConfluenceImportError("Confluence request left the configured site", 502);
      if (!allowPrivate) {
        try {
          assertSafeImportUrl(url);
        } catch {
          throw new ConfluenceImportError("baseUrl points at a private or disallowed host");
        }
        await assertPublicHost(target.hostname);
      }
      return fetch(url, { ...init, redirect: "manual", signal: AbortSignal.timeout(timeoutMs) }).then((response) => {
        if (response.status >= 300 && response.status < 400) throw new ConfluenceImportError(`Confluence redirected (HTTP ${response.status}); use the final site URL as baseUrl`, 502);
        return response;
      });
    },
  };
}

export async function assertPublicHost(hostname: string): Promise<void> {
  const host = hostname.replace(/^\[|\]$/g, "");
  const addresses = isIP(host) ? [host] : (await lookup(host, { all: true, verbatim: true }).catch(() => [])).map((entry) => entry.address);
  if (addresses.length === 0) throw new ConfluenceImportError(`Could not resolve ${hostname}`, 502);
  for (const address of addresses) {
    if (isPrivateAddress(address)) throw new ConfluenceImportError("baseUrl points at a private or disallowed host");
  }
}

export function isPrivateAddress(address: string): boolean {
  const lower = address.toLowerCase();
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/.exec(lower)?.[1];
  if (mapped) return isPrivateAddress(mapped);
  if (isIP(lower) === 4) {
    const [a = 0, b = 0] = lower.split(".").map(Number);
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      (a === 198 && (b === 18 || b === 19)) ||
      a >= 224
    );
  }
  return lower === "::" || lower === "::1" || /^f[cd]/.test(lower) || /^fe[89ab]/.test(lower) || /^ff/.test(lower) || lower.startsWith("64:ff9b:");
}

// -- helpers ------------------------------------------------------------------------

export function spaceKeyInput(value: unknown): string {
  const key = scalarText(value)?.trim();
  if (!key || !/^~?[A-Za-z0-9_-]{1,255}$/.test(key)) throw new ConfluenceImportError("spaceKey must be a Confluence space key");
  return key;
}

function boundedStorage(value: string, id: string): string {
  if (value.length > MAX_STORAGE_BYTES) throw new ConfluenceImportError(`Page ${id} body is larger than ${MAX_STORAGE_BYTES} bytes`);
  return value;
}

function labelList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const labels = value
    .map((item) => (typeof item === "string" ? item.trim().toLowerCase().replace(/\s+/g, "-") : ""))
    .filter((label) => /^[\p{L}\p{N}][\p{L}\p{N}_.:-]{0,49}$/u.test(label));
  return [...new Set(labels)].slice(0, 50);
}

function scalarText(value: unknown): string | undefined {
  if (typeof value === "string") return value.trim() || undefined;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

function optionalText<K extends string>(key: K, value: unknown): Partial<Record<K, string>> {
  const text = scalarText(value);
  return text ? ({ [key]: text.slice(0, 200) } as Partial<Record<K, string>>) : {};
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function asRecords(value: unknown): Array<Record<string, unknown>> {
  return Array.isArray(value) ? value.filter((item): item is Record<string, unknown> => Boolean(item) && typeof item === "object" && !Array.isArray(item)) : [];
}
