/**
 * Confluence space sources for import: the live REST API (Cloud v2 or Data
 * Center v1, through `enterprise-atlassian` with SSRF-checked fetches), the
 * XML space export (`entities.xml`, optionally inside the export ZIP), and a
 * JSON bundle of storage-format pages. All sources produce the same bounded
 * `ConfluenceSpace` shape.
 */
import { lookup } from "node:dns/promises";
import { type IncomingMessage, request as httpRequest } from "node:http";
import { request as httpsRequest } from "node:https";
import { isIP, type LookupFunction } from "node:net";
import { Readable } from "node:stream";
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
  /** Attachments known from the source itself (XML export, JSON bundle); live imports list them lazily. */
  attachments?: ConfluenceAttachmentEntry[];
}

/** One file attached to a Confluence page (current version only). */
export interface ConfluenceAttachmentEntry {
  id: string;
  filename: string;
  mediaType?: string;
  /** Size reported by the source, when known; the copied bytes are still bounded while streaming. */
  size?: number;
  version?: string;
  /** Live API only: the `_links.download` path. */
  download?: string;
}

/**
 * Where an import reads attachment bytes from. `list` never throws: a listing failure comes back as
 * `error` so the page still imports with its original attachment links.
 */
export interface ConfluenceAttachmentSource {
  list(page: ConfluencePage): Promise<{ entries: ConfluenceAttachmentEntry[]; error?: string }>;
  /** Streams one attachment's bytes. Throws `ConfluenceImportError` with a reportable reason. */
  open(page: ConfluencePage, entry: ConfluenceAttachmentEntry, maxBytes: number): Promise<AsyncIterable<Uint8Array>>;
}

export interface ConfluenceSpace {
  spaceKey: string;
  spaceName?: string;
  baseUrl?: string;
  pages: ConfluencePage[];
  /** Attachment bytes, when the source carries them. */
  attachmentSource?: ConfluenceAttachmentSource;
  /** Why attachments cannot be copied from this source (e.g. a bare entities.xml upload). */
  attachmentsUnavailable?: string;
}

/** Attachments listed per page at most (live listing pagination is bounded by this too). */
export const MAX_PAGE_ATTACHMENTS = 500;

export class ConfluenceImportError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

// -- JSON bundle -------------------------------------------------------------

/**
 * `{ format: "noma-confluence-bundle", spaceKey, spaceName?, baseUrl?, pages: [{ id, title,
 * parentId?, storage, labels?, author?, createdAt?, updatedAt?, version?, position?,
 * attachments?: [{ filename, dataBase64, id?, mediaType? }] }] }`
 */
export function parseConfluenceBundle(value: unknown): ConfluenceSpace {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new ConfluenceImportError("bundle must be an object");
  const bundle = value as Record<string, unknown>;
  if (bundle.format !== undefined && bundle.format !== "noma-confluence-bundle") throw new ConfluenceImportError('bundle.format must be "noma-confluence-bundle"');
  const spaceKey = spaceKeyInput(bundle.spaceKey);
  if (!Array.isArray(bundle.pages)) throw new ConfluenceImportError("bundle.pages must be an array");
  if (bundle.pages.length > MAX_IMPORT_PAGES) throw new ConfluenceImportError(`A bundle can contain at most ${MAX_IMPORT_PAGES} pages`);
  const attachmentBytes = new Map<string, Map<string, Buffer>>();
  const pages = bundle.pages.map((raw, index): ConfluencePage => {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new ConfluenceImportError(`bundle.pages[${index}] must be an object`);
    const page = raw as Record<string, unknown>;
    const id = scalarText(page.id);
    const title = scalarText(page.title);
    if (!id || !title) throw new ConfluenceImportError(`bundle.pages[${index}] needs id and title`);
    if (typeof page.storage !== "string") throw new ConfluenceImportError(`bundle.pages[${index}].storage must be a string`);
    const attachments = bundleAttachments(page.attachments, `bundle.pages[${index}]`);
    if (attachments.length > 0) attachmentBytes.set(id.slice(0, 80), new Map(attachments.map(({ entry, data }) => [entry.id, data])));
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
      ...(attachments.length > 0 ? { attachments: attachments.map(({ entry }) => entry) } : {}),
    };
  });
  return {
    spaceKey,
    ...optionalText("spaceName", bundle.spaceName),
    ...(typeof bundle.baseUrl === "string" && /^https?:\/\//.test(bundle.baseUrl) ? { baseUrl: bundle.baseUrl } : {}),
    pages,
    attachmentSource: inMemoryAttachmentSource((page, entry) => attachmentBytes.get(page.id)?.get(entry.id)),
  };
}

function bundleAttachments(value: unknown, label: string): Array<{ entry: ConfluenceAttachmentEntry; data: Buffer }> {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new ConfluenceImportError(`${label}.attachments must be an array`);
  if (value.length > MAX_PAGE_ATTACHMENTS) throw new ConfluenceImportError(`${label} has more than ${MAX_PAGE_ATTACHMENTS} attachments`);
  const seen = new Set<string>();
  return value.map((raw, index) => {
    const item = record(raw);
    const filename = scalarText(item.filename);
    if (!filename || typeof item.dataBase64 !== "string") throw new ConfluenceImportError(`${label}.attachments[${index}] needs filename and dataBase64`);
    const clean = item.dataBase64.replace(/\s+/g, "");
    if (!/^[A-Za-z0-9+/]*={0,2}$/.test(clean)) throw new ConfluenceImportError(`${label}.attachments[${index}].dataBase64 must be base64`);
    const id = (scalarText(item.id) ?? `file-${index}`).slice(0, 80);
    if (seen.has(id)) throw new ConfluenceImportError(`${label}.attachments has a duplicate id ${id}`);
    seen.add(id);
    const data = Buffer.from(clean, "base64");
    return {
      entry: { id, filename: filename.slice(0, 250), size: data.byteLength, ...optionalText("mediaType", item.mediaType) },
      data,
    };
  });
}

function inMemoryAttachmentSource(bytesFor: (page: ConfluencePage, entry: ConfluenceAttachmentEntry) => Uint8Array | undefined): ConfluenceAttachmentSource {
  return {
    list: async (page) => ({ entries: page.attachments ?? [] }),
    open: async (page, entry, maxBytes) => {
      const data = bytesFor(page, entry);
      if (!data) throw new ConfluenceImportError("The attachment's bytes are not in the upload");
      if (data.byteLength > maxBytes) throw new ConfluenceImportError(`Larger than the ${maxBytes}-byte limit`, 413);
      return (async function* () {
        yield data;
      })();
    },
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
    const { attachmentsUnavailable: _unavailable, ...space } = parseConfluenceEntitiesXml(entities.data.toString("utf8"));
    const prefix = entities.path.slice(0, entities.path.length - "entities.xml".length);
    const files = new Map<string, Buffer>();
    for (const entry of entries) {
      if (entry.path.startsWith(`${prefix}attachments/`)) files.set(entry.path.slice(prefix.length + "attachments/".length), entry.data);
    }
    return { ...space, attachmentSource: inMemoryAttachmentSource((page, entry) => exportAttachmentBytes(files, page.id, entry)) };
  }
  return parseConfluenceEntitiesXml(Buffer.from(data).toString("utf8"));
}

/**
 * Export ZIPs store attachment bytes at `attachments/<pageId>/<attachmentId>/<version>`; older
 * exports drop the version directory or keep several versions, so fall back to the newest one.
 */
function exportAttachmentBytes(files: Map<string, Buffer>, pageId: string, entry: ConfluenceAttachmentEntry): Buffer | undefined {
  const base = `${pageId}/${entry.id}`;
  if (entry.version && files.has(`${base}/${entry.version}`)) return files.get(`${base}/${entry.version}`);
  let newest: { version: number; data: Buffer } | undefined;
  for (const [path, data] of files) {
    if (!path.startsWith(`${base}/`)) continue;
    const version = Number(path.slice(base.length + 1));
    if (Number.isInteger(version) && (!newest || version > newest.version)) newest = { version, data };
  }
  return newest?.data ?? files.get(base);
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
  const pageAttachments = new Map<string, ConfluenceAttachmentEntry[]>();
  for (const attachment of byClass("Attachment")) {
    if (attachment.properties.get("originalVersion")?.refId) continue;
    if ((attachment.properties.get("contentStatus")?.text ?? "current") !== "current") continue;
    const owner = attachment.properties.get("containerContent")?.refId ?? attachment.properties.get("content")?.refId;
    const filename = attachment.properties.get("title")?.text ?? attachment.properties.get("fileName")?.text;
    if (!owner || !filename || !attachment.id) continue;
    const list = pageAttachments.get(owner) ?? [];
    if (list.length >= MAX_PAGE_ATTACHMENTS) continue;
    const size = Number(attachment.properties.get("fileSize")?.text);
    list.push({
      id: attachment.id,
      filename: filename.slice(0, 250),
      ...optionalText("version", attachment.properties.get("version")?.text),
      ...optionalText("mediaType", attachment.properties.get("contentType")?.text ?? attachment.properties.get("mediaType")?.text),
      ...(Number.isSafeInteger(size) && size >= 0 ? { size } : {}),
    });
    pageAttachments.set(owner, list);
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
      ...(pageAttachments.has(page.id) ? { attachments: pageAttachments.get(page.id)! } : {}),
    };
  });
  return {
    spaceKey,
    ...optionalText("spaceName", space?.properties.get("name")?.text),
    pages,
    attachmentsUnavailable: "entities.xml alone carries no attachment bytes; upload the whole XML export ZIP to copy attachments",
  };
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
    if (!className || !["Page", "BodyContent", "Space", "ConfluenceUserImpl", "Label", "Labelling", "Attachment"].includes(className)) continue;
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
  /** DNS resolver override (tests); defaults to the system resolver. */
  resolveHost?: HostResolver;
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
  const http = guardedHttp(baseUrl, options.allowPrivateHosts === true, options.timeoutMs ?? 30_000, options.resolveHost ? { resolveHost: options.resolveHost } : {});
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
  const space = options.deployment === "cloud"
    ? await fetchCloudSpace(get, baseUrl, spaceKey, onProgress)
    : await fetchDataCenterSpace(get, baseUrl, spaceKey, onProgress);
  return { ...space, attachmentSource: liveAttachmentSource(auth, http, get, options.deployment) };
}

/**
 * Lists a page's attachments through the v1 REST API (served by both Cloud and Data Center) and
 * downloads them from `_links.download` with the import's credentials and guarded transport.
 */
function liveAttachmentSource(auth: AtlassianAuth, http: AtlassianHttp, get: JsonGet, deployment: "cloud" | "datacenter"): ConfluenceAttachmentSource {
  const wikiRoot = deployment === "cloud" ? "wiki/" : "";
  return {
    async list(page) {
      const entries: ConfluenceAttachmentEntry[] = [];
      try {
        for (let start = 0, requests = 0; requests < Math.ceil(MAX_PAGE_ATTACHMENTS / 100); requests++) {
          const batch = await get(`${wikiRoot}rest/api/content/${encodeURIComponent(page.id)}/child/attachment?limit=100&start=${start}&expand=version`);
          const results = asRecords(batch.results);
          for (const raw of results) {
            const id = scalarText(raw.id);
            const filename = scalarText(raw.title);
            const download = scalarText(record(raw._links).download);
            if (!id || !filename || !download || entries.length >= MAX_PAGE_ATTACHMENTS) continue;
            const extensions = record(raw.extensions);
            const size = Number(extensions.fileSize);
            entries.push({
              id: id.slice(0, 80),
              filename: filename.slice(0, 250),
              download,
              ...optionalText("mediaType", extensions.mediaType ?? record(raw.metadata).mediaType),
              ...optionalText("version", record(raw.version).number),
              ...(Number.isSafeInteger(size) && size >= 0 ? { size } : {}),
            });
          }
          if (results.length === 0 || !record(batch._links).next) break;
          start += results.length;
        }
      } catch (error) {
        return { entries, error: `Could not list attachments: ${error instanceof Error ? error.message : String(error)}` };
      }
      return { entries };
    },
    async open(_page, entry, maxBytes) {
      if (!entry.download) throw new ConfluenceImportError("Confluence did not return a download link");
      if (entry.size !== undefined && entry.size > maxBytes) throw new ConfluenceImportError(`Larger than the ${maxBytes}-byte limit`, 413);
      const path = /^https?:\/\//i.test(entry.download) ? entry.download : `${wikiRoot}${entry.download.replace(/^\/+/, "")}`;
      let response: Response;
      try {
        response = await atlassianFetch(auth, path, { headers: { accept: "*/*" } }, http);
      } catch (error) {
        if (error instanceof ConfluenceImportError) throw error;
        throw new ConfluenceImportError(`Download failed: ${error instanceof Error ? error.message : String(error)}`, 502);
      }
      if (!response.ok || !response.body) {
        await response.body?.cancel().catch(() => undefined);
        throw new ConfluenceImportError(`Download failed (HTTP ${response.status})`, 502);
      }
      const declared = Number(response.headers.get("content-length"));
      if (Number.isFinite(declared) && declared > maxBytes) {
        await response.body.cancel().catch(() => undefined);
        throw new ConfluenceImportError(`Larger than the ${maxBytes}-byte limit`, 413);
      }
      return response.body;
    },
  };
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

/** Resolves a hostname to its addresses (all families). Injectable so tests can simulate DNS answers. */
export type HostResolver = (hostname: string) => Promise<string[]>;

export interface GuardedHttpOptions {
  resolveHost?: HostResolver;
}

const systemResolver: HostResolver = async (hostname) => (await lookup(hostname, { all: true, verbatim: true }).catch(() => [])).map((entry) => entry.address);

/**
 * Fetch wrapper for import traffic: every URL must stay on the configured origin, redirects are
 * refused, and requests time out. The hostname is resolved exactly once per request, every
 * answer is checked against the private-address guard, and the socket is pinned to the checked
 * address through a custom `lookup`, so a DNS answer that changes between check and connect
 * (DNS rebinding) cannot redirect the request. TLS still verifies the certificate for the hostname.
 */
export function guardedHttp(baseUrl: string, allowPrivate: boolean, timeoutMs: number, options: GuardedHttpOptions = {}): AtlassianHttp {
  const origin = new URL(baseUrl).origin;
  const resolveHost = options.resolveHost ?? systemResolver;
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
      }
      const address = await resolveCheckedAddress(target.hostname, allowPrivate, resolveHost);
      const response = await pinnedRequest(target, address, init, timeoutMs);
      if (response.status >= 300 && response.status < 400) {
        await response.body?.cancel().catch(() => undefined);
        throw new ConfluenceImportError(`Confluence redirected (HTTP ${response.status}); use the final site URL as baseUrl`, 502);
      }
      return response;
    },
  };
}

async function resolveCheckedAddress(hostname: string, allowPrivate: boolean, resolveHost: HostResolver): Promise<string> {
  const host = hostname.replace(/^\[|\]$/g, "");
  const addresses = isIP(host) ? [host] : await resolveHost(host);
  const usable = addresses.filter((address) => isIP(address) !== 0);
  if (usable.length === 0) throw new ConfluenceImportError(`Could not resolve ${hostname}`, 502);
  if (!allowPrivate && usable.some((address) => isPrivateAddress(address))) throw new ConfluenceImportError("baseUrl points at a private or disallowed host");
  return usable[0]!;
}

const NULL_BODY_STATUSES = new Set([204, 205, 304]);

function pinnedRequest(target: URL, address: string, init: RequestInit | undefined, timeoutMs: number): Promise<Response> {
  const family = isIP(address);
  const pinnedLookup: LookupFunction = (_hostname, lookupOptions, callback) => {
    if (lookupOptions.all) callback(null, [{ address, family }]);
    else callback(null, address, family);
  };
  const headers: Record<string, string> = {};
  new Headers(init?.headers).forEach((value, key) => {
    headers[key] = value;
  });
  const hostname = target.hostname.replace(/^\[|\]$/g, "");
  const secure = target.protocol === "https:";
  const requestOptions = {
    protocol: target.protocol,
    hostname,
    port: target.port || (secure ? 443 : 80),
    path: `${target.pathname}${target.search}`,
    method: init?.method ?? "GET",
    headers,
    lookup: pinnedLookup,
    ...(secure && isIP(hostname) === 0 ? { servername: hostname } : {}),
  };
  return new Promise<Response>((resolve, reject) => {
    const deadline = setTimeout(() => request.destroy(new ConfluenceImportError(`Confluence did not respond within ${timeoutMs} ms`, 504)), timeoutMs);
    const onResponse = (message: IncomingMessage): void => {
      clearTimeout(deadline);
      message.setTimeout(timeoutMs, () => message.destroy(new ConfluenceImportError("Confluence response stalled", 504)));
      const status = message.statusCode ?? 502;
      if (status < 200 || status > 599) {
        message.destroy();
        reject(new ConfluenceImportError(`Confluence returned HTTP ${status}`, 502));
        return;
      }
      const responseHeaders = new Headers();
      for (const [key, value] of Object.entries(message.headers)) {
        if (value !== undefined) responseHeaders.set(key, Array.isArray(value) ? value.join(", ") : value);
      }
      if (NULL_BODY_STATUSES.has(status)) {
        message.resume();
        resolve(new Response(null, { status, headers: responseHeaders }));
        return;
      }
      // reason: node:stream/web's ReadableStream and the global fetch BodyInit are the same runtime type but distinct declarations.
      const body = Readable.toWeb(message) as unknown as ReadableStream<Uint8Array>;
      resolve(new Response(body, { status, headers: responseHeaders }));
    };
    const request = secure ? httpsRequest(requestOptions, onResponse) : httpRequest(requestOptions, onResponse);
    request.once("error", (error) => {
      clearTimeout(deadline);
      reject(error);
    });
    request.end();
  });
}

export async function assertPublicHost(hostname: string, resolveHost: HostResolver = systemResolver): Promise<void> {
  await resolveCheckedAddress(hostname, false, resolveHost);
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
