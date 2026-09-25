/**
 * Notion → Noma converter. Pure: bytes in, a page tree of `.noma` sources out.
 *
 * Two inputs are supported:
 *
 * - **Markdown & CSV export** (`parseNotionExport`): the ZIP Notion produces from
 *   Settings → Export → "Markdown & CSV". Each page is `Title <32-hex-id>.md`,
 *   child pages live in a sibling folder `Title <id>/`, a database is
 *   `Name <id>.csv` (plus `Name <id>_all.csv`) with its row pages in the
 *   folder `Name <id>/`, and images/files sit in the page folder. Large
 *   exports wrap the parts in inner ZIPs; one level of nesting is unpacked.
 * - **JSON bundle** (`parseNotionBundle`): `{ format?: "noma-notion-bundle",
 *   workspace?, pages: [{ id, title, parentId?, markdown, properties?, url?,
 *   database?: { columns, rows } }] }` for pipelines that read the Notion API
 *   block tree and render it to Markdown themselves. Bundles carry no files.
 *
 * Internal links become `[[Title]]` wikilinks (they resolve by page title in
 * Noma Cloud), local images become `::figure{src="att:<file>"}` and other
 * local files `[name](att:<file>)` links whose bytes travel in
 * `NotionPage.attachments`. Database CSVs become a readable pipe table plus a
 * `::dataset{format="csv"}` copy; row-page properties (`Key: value` lines under
 * the H1) become a `::page-properties` block. Anything that cannot be carried
 * over is counted in the loss report. Archives are bounded (entry count,
 * inflated bytes, page count) and entries with unsafe paths are skipped.
 */
import yaml from "js-yaml";
import { convertMarkdownToNoma } from "./ingest-markdown.js";
import { slugify } from "./parser.js";
import { isZip, readZip, ZipFormatError } from "./zip.js";

export const MAX_NOTION_PAGES = 2_000;
const MAX_MARKDOWN_BYTES = 5_000_000;
const MAX_CSV_ROWS = 20_000;
const MAX_CSV_COLUMNS = 200;
const ZWSP = "\u200b";
const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "bmp", "avif", "heic", "tif", "tiff"]);
const IGNORED_FILES = /(^|\/)(__MACOSX\/|\.DS_Store$|Thumbs\.db$|desktop\.ini$)/i;

export interface NotionLossEntry {
  /** Construct that could not be carried over losslessly (`html`, `broken-link`, `missing-file`, …). */
  kind: string;
  count: number;
}

export interface NotionAttachment {
  /** Sanitised filename, unique within the page; the page references it as `att:<filename>`. */
  filename: string;
  /** Path of the file inside the export. */
  archivePath: string;
  data: Buffer;
}

export interface NotionPage {
  /** Notion page/database ID (32 lowercase hex), or a path-derived `path:<…>` ID when the export has none. */
  id: string;
  parentId?: string;
  title: string;
  kind: "page" | "database";
  /** Path inside the export (without extension), or the bundle ID. */
  path: string;
  /** Sibling order: position of the first link from the parent page (or CSV row), else undefined. */
  position?: number;
  /** Converted `.noma` source. */
  source: string;
  attachments: NotionAttachment[];
  labels: string[];
  loss: NotionLossEntry[];
}

export interface NotionImport {
  workspace?: string;
  pages: NotionPage[];
  loss: NotionLossEntry[];
  skipped: Array<{ path: string; reason: string }>;
}

export interface NotionImportOptions {
  maxEntries?: number;
  maxTotalBytes?: number;
  maxPages?: number;
  /** Files larger than this are not carried as attachments (counted as `attachment-too-large`). */
  maxAttachmentBytes?: number;
}

/** Prefix of the attachment references written into converted pages (`att:<filename>`). */
export const ATTACHMENT_REF_PREFIX = "att:";

export class NotionImportError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

interface RawPage {
  key: string;
  id: string;
  title: string;
  dir: string;
  markdown?: string;
  csv?: { columns: string[]; rows: string[][] };
  properties?: Array<[string, string]>;
  parentKey?: string;
  bundleUrl?: string;
}

interface Workspace {
  pages: Map<string, RawPage>;
  files: Map<string, Buffer>;
  byId: Map<string, string>;
  byTitle: Map<string, string[]>;
  skipped: Array<{ path: string; reason: string }>;
  options: NotionImportOptions;
  bundle: boolean;
}

// -- Markdown & CSV export ------------------------------------------------------

/** Convert a Notion "Markdown & CSV" export ZIP into a page tree. */
export function parseNotionExport(data: Uint8Array, options: NotionImportOptions = {}): NotionImport {
  if (!isZip(data)) throw new NotionImportError("Upload the ZIP produced by Notion's Markdown & CSV export");
  const maxEntries = options.maxEntries ?? 20_000;
  const maxTotalBytes = options.maxTotalBytes ?? 300_000_000;
  const skipped: Array<{ path: string; reason: string }> = [];
  const files = new Map<string, Buffer>();
  let budget = maxTotalBytes;
  let entryBudget = maxEntries;

  const addEntries = (archive: Uint8Array, prefix: string, nested: boolean): void => {
    let entries;
    try {
      entries = readZip(archive, { maxEntries: entryBudget, maxEntryBytes: budget, maxTotalBytes: budget });
    } catch (error) {
      if (error instanceof ZipFormatError) throw new NotionImportError(`Could not read the export ZIP${prefix ? ` (${prefix})` : ""}: ${error.message}`);
      throw error;
    }
    entryBudget -= entries.length;
    for (const entry of entries) {
      budget -= entry.data.length;
      const path = safeArchivePath(entry.path);
      if (!path) {
        skipped.push({ path: entry.path.slice(0, 300), reason: "unsafe path" });
        continue;
      }
      if (IGNORED_FILES.test(path)) continue;
      if (!nested && /\.zip$/i.test(path) && isZip(entry.data)) {
        addEntries(entry.data, path, true);
        continue;
      }
      files.set(path, entry.data);
    }
  };
  addEntries(data, "", false);

  const pages = new Map<string, RawPage>();
  const csvAll = new Set<string>();
  for (const [path, bytes] of files) {
    const extension = extensionOf(path);
    if (extension !== "md" && extension !== "csv") continue;
    const allCsv = extension === "csv" && /_all\.csv$/i.test(path);
    const key = path.replace(allCsv ? /_all\.csv$/i : /\.(md|csv)$/i, "");
    const { title: stemTitle, id } = splitNotionStem(basename(key));
    const page = pages.get(key) ?? { key, id: id ?? pathId(key), title: stemTitle, dir: dirname(key) };
    if (extension === "md") {
      if (bytes.length > MAX_MARKDOWN_BYTES) {
        skipped.push({ path, reason: "page is larger than 5 MB" });
        continue;
      }
      page.markdown = decodeText(bytes);
      const heading = firstHeading(page.markdown);
      if (heading) page.title = heading;
    } else if (!page.csv || allCsv) {
      if (allCsv) csvAll.add(key);
      else if (csvAll.has(key)) continue;
      page.csv = parseCsv(decodeText(bytes), path);
    }
    pages.set(key, page);
  }
  if (pages.size === 0) throw new NotionImportError("The ZIP has no Notion pages (.md) or databases (.csv); upload a Markdown & CSV export");
  assertPageCount(pages.size, options);
  const usedIds = new Set<string>();
  for (const page of [...pages.values()].sort((a, b) => a.key.length - b.key.length || a.key.localeCompare(b.key))) {
    if (usedIds.has(page.id)) page.id = pathId(page.key);
    usedIds.add(page.id);
  }

  for (const page of pages.values()) {
    let dir = page.dir;
    while (dir) {
      if (pages.has(dir) && dir !== page.key) {
        page.parentKey = dir;
        break;
      }
      dir = dirname(dir);
    }
  }
  const topFolders = new Set([...pages.values()].filter((page) => !page.parentKey).map((page) => page.dir.split("/")[0] ?? ""));
  const workspaceFolder = topFolders.size === 1 ? [...topFolders][0] : undefined;
  const workspace = workspaceFolder ? splitNotionStem(workspaceFolder).title.replace(/^Export-[0-9a-f-]+$/i, "") : "";
  return convertWorkspace({ pages, files, byId: new Map(), byTitle: new Map(), skipped, options, bundle: false }, workspace || undefined);
}

// -- JSON bundle ----------------------------------------------------------------

/**
 * Convert a `noma-notion-bundle` (see the module comment). `markdown` uses Notion's
 * export dialect; links to `notion.so/…<id>` URLs or bare page IDs become wikilinks.
 */
export function parseNotionBundle(value: unknown, options: NotionImportOptions = {}): NotionImport {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new NotionImportError("bundle must be an object");
  const bundle = value as Record<string, unknown>;
  if (bundle.format !== undefined && bundle.format !== "noma-notion-bundle") throw new NotionImportError('bundle.format must be "noma-notion-bundle"');
  if (!Array.isArray(bundle.pages)) throw new NotionImportError("bundle.pages must be an array");
  assertPageCount(bundle.pages.length, options);
  const pages = new Map<string, RawPage>();
  for (const [index, raw] of bundle.pages.entries()) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) throw new NotionImportError(`bundle.pages[${index}] must be an object`);
    const entry = raw as Record<string, unknown>;
    const id = normalizeNotionId(scalarText(entry.id));
    const title = scalarText(entry.title);
    if (!id || !title) throw new NotionImportError(`bundle.pages[${index}] needs a Notion id and a title`);
    if (pages.has(id)) throw new NotionImportError(`bundle.pages[${index}] repeats page ${id}`);
    const markdown = entry.markdown === undefined ? "" : entry.markdown;
    if (typeof markdown !== "string") throw new NotionImportError(`bundle.pages[${index}].markdown must be a string`);
    if (Buffer.byteLength(markdown, "utf8") > MAX_MARKDOWN_BYTES) throw new NotionImportError(`bundle.pages[${index}].markdown is larger than 5 MB`);
    const parentId = normalizeNotionId(scalarText(entry.parentId));
    const page: RawPage = { key: id, id, title: title.slice(0, 250), dir: "", markdown, ...(parentId ? { parentKey: parentId } : {}) };
    if (typeof entry.url === "string" && /^https:\/\//.test(entry.url)) page.bundleUrl = entry.url.slice(0, 500);
    if (entry.properties !== undefined) page.properties = bundleProperties(entry.properties, index);
    if (entry.database !== undefined) page.csv = bundleDatabase(entry.database, index);
    pages.set(id, page);
  }
  for (const page of pages.values()) if (page.parentKey && (!pages.has(page.parentKey) || page.parentKey === page.key)) delete page.parentKey;
  const workspace = scalarText(bundle.workspace);
  return convertWorkspace({ pages, files: new Map(), byId: new Map(), byTitle: new Map(), skipped: [], options, bundle: true }, workspace?.slice(0, 120));
}

function bundleProperties(value: unknown, index: number): Array<[string, string]> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new NotionImportError(`bundle.pages[${index}].properties must be an object`);
  return Object.entries(value as Record<string, unknown>)
    .slice(0, 100)
    .map(([key, raw]): [string, string] => [key, Array.isArray(raw) ? raw.map((item) => scalarText(item) ?? "").filter(Boolean).join(", ") : scalarText(raw) ?? ""]);
}

function bundleDatabase(value: unknown, index: number): { columns: string[]; rows: string[][] } {
  const label = `bundle.pages[${index}].database`;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new NotionImportError(`${label} must be an object`);
  const database = value as Record<string, unknown>;
  if (!Array.isArray(database.columns) || !Array.isArray(database.rows)) throw new NotionImportError(`${label} needs columns and rows arrays`);
  if (database.columns.length > MAX_CSV_COLUMNS || database.rows.length > MAX_CSV_ROWS) throw new NotionImportError(`${label} is too large`);
  const columns = database.columns.map((column) => scalarText(column) ?? "");
  const rows = database.rows.map((row) => (Array.isArray(row) ? row.slice(0, columns.length).map((cell) => scalarText(cell) ?? "") : []));
  return { columns, rows };
}

// -- Conversion -------------------------------------------------------------------

function convertWorkspace(ws: Workspace, workspace: string | undefined): NotionImport {
  for (const page of ws.pages.values()) {
    if (!page.id.startsWith("path:") && !ws.byId.has(page.id)) ws.byId.set(page.id, page.key);
    const titleKey = page.title.trim().toLowerCase();
    ws.byTitle.set(titleKey, [...(ws.byTitle.get(titleKey) ?? []), page.key]);
  }
  const totalLoss = new Map<string, number>();
  const positions = new Map<string, number>();
  const converted: NotionPage[] = [];
  for (const raw of ws.pages.values()) {
    const loss = new Map<string, number>();
    const page = convertPage(ws, raw, loss, positions);
    if ((ws.byTitle.get(raw.title.trim().toLowerCase())?.length ?? 0) > 1) countLoss(loss, "duplicate-title");
    page.loss = lossList(loss);
    for (const [kind, count] of loss) totalLoss.set(kind, (totalLoss.get(kind) ?? 0) + count);
    converted.push(page);
  }
  const idByKey = new Map([...ws.pages.values()].map((page) => [page.key, page.id]));
  for (const page of converted) {
    const raw = ws.pages.get(page.path)!;
    if (raw.parentKey) page.parentId = idByKey.get(raw.parentKey);
    const position = positions.get(raw.key);
    if (position !== undefined) page.position = position;
  }
  return {
    ...(workspace ? { workspace } : {}),
    pages: orderNotionPages(converted),
    loss: lossList(totalLoss),
    skipped: ws.skipped.slice(0, 500),
  };
}

interface PageContext {
  ws: Workspace;
  page: RawPage;
  loss: Map<string, number>;
  attachments: NotionAttachment[];
  attachmentByPath: Map<string, string>;
  linkOrder: string[];
}

function convertPage(ws: Workspace, raw: RawPage, loss: Map<string, number>, positions: Map<string, number>): NotionPage {
  const ctx: PageContext = { ws, page: raw, loss, attachments: [], attachmentByPath: new Map(), linkOrder: [] };
  let body = raw.markdown ?? "";
  body = body.replace(/^﻿/, "").replace(/\r\n?/g, "\n");
  body = stripFirstHeading(body);
  const parent = raw.parentKey ? ws.pages.get(raw.parentKey) : undefined;
  let properties = raw.properties;
  if (!properties && parent?.csv && !ws.bundle) {
    const extracted = extractProperties(body);
    if (extracted) {
      properties = extracted.properties;
      body = extracted.rest;
    }
  }
  const bodyLines = convertBody(ctx, body);
  const databaseLines = raw.csv ? databaseTable(ctx, raw) : [];
  const title = headingTitle(raw.title) || "Untitled";
  const markdown = [`# ${title}`, "", ...bodyLines, ...(databaseLines.length > 0 ? ["", ...databaseLines] : [])].join("\n").replace(/\n{3,}/g, "\n\n").trimEnd();
  const converted = convertMarkdownToNoma(markdown).split("\n");
  const titleId = converted[0]?.match(/\{id="([^"]+)"\}$/)?.[1] ?? (slugify(title) || "page");
  const blocks: string[] = [converted[0] ?? `# ${title}`];
  const labels: string[] = [];
  if (properties && properties.length > 0) {
    const lines = properties.map(([key, value]) => {
      const cleanKey = singleLine(key).replace(/:/g, " ").trim();
      const rewritten = rewriteInline(ctx, guardWikilinks(singleLine(value)), { relations: true });
      if (/^(tags|labels)$/i.test(cleanKey)) labels.push(...labelList(value.split(",")));
      return guardLine(`${cleanKey}: ${rewritten}`);
    }).filter((line) => !/^\s*:/.test(line));
    if (lines.length > 0) blocks.push("", `::page-properties{id="${titleId}-properties"}`, ...lines, "::");
  }
  const rest = converted.slice(1).join("\n").replace(/^\n+/, "");
  if (rest) blocks.push("", rest);
  if (raw.csv) blocks.push("", ...datasetBlock(`${titleId}-data`, raw.csv));
  const frontmatter = notionFrontmatter(raw, labels);
  for (const [index, key] of ctx.linkOrder.entries()) {
    const child = ws.pages.get(key);
    if (child?.parentKey === raw.key && !positions.has(key)) positions.set(key, index);
  }
  return {
    id: raw.id,
    title: raw.title.slice(0, 250) || "Untitled",
    kind: raw.csv ? "database" : "page",
    path: raw.key,
    source: `${frontmatter}\n\n${blocks.join("\n").trimEnd()}\n`,
    attachments: ctx.attachments,
    labels: [...new Set(labels)].slice(0, 50),
    loss: [],
  };
}

function notionFrontmatter(page: RawPage, labels: string[]): string {
  const notion: Record<string, unknown> = {};
  if (!page.id.startsWith("path:")) notion.id = page.id;
  if (page.bundleUrl) notion.url = page.bundleUrl;
  else if (!page.id.startsWith("path:")) notion.url = `https://www.notion.so/${page.id}`;
  if (page.csv) notion.database = true;
  const data: Record<string, unknown> = { source: "notion", notion };
  if (labels.length > 0) data.labels = [...new Set(labels)];
  return `---\n${yaml.dump(data, { lineWidth: -1, noRefs: true }).trimEnd()}\n---`;
}

function convertBody(ctx: PageContext, body: string): string[] {
  const out: string[] = [];
  const lines = body.split("\n");
  let fence: { char: string; length: number } | undefined;
  let asideDepth = 0;
  let asideStart = -1;
  for (const line of lines) {
    const trimmed = line.trim();
    if (fence) {
      out.push(line);
      const close = trimmed.match(/^(`{3,}|~{3,})\s*$/);
      if (close && close[1]![0] === fence.char && close[1]!.length >= fence.length) fence = undefined;
      continue;
    }
    const open = trimmed.match(/^(`{3,}|~{3,})/);
    if (open) {
      fence = { char: open[1]![0]!, length: open[1]!.length };
      out.push(line);
      continue;
    }
    if (/^<aside>\s*$/i.test(trimmed) && asideDepth === 0) {
      asideDepth = 1;
      asideStart = out.length;
      out.push("::callout{tone=\"info\"}");
      continue;
    }
    if (/^<\/aside>\s*$/i.test(trimmed) && asideDepth === 1) {
      asideDepth = 0;
      while (out.length > asideStart + 1 && out[out.length - 1]!.trim() === "") out.pop();
      out.push("::");
      continue;
    }
    if (/^<\/?(details|summary|aside|div|span|p|br|img|figure|table|iframe|video|audio)\b[^>]*>/i.test(trimmed)) {
      countLoss(ctx.loss, "html");
      const text = trimmed.replace(/<[^>]*>/g, "").trim();
      if (text) out.push(guardLine(rewriteInline(ctx, guardWikilinks(text))));
      continue;
    }
    const figure = trimmed.match(/^!\[([^\]]*)\]\(((?:[^()\s]|\([^()\s]*\))+)\)$/);
    if (figure) {
      const block = figureLine(ctx, figure[1] ?? "", figure[2] ?? "", asideDepth > 0 ? 3 : 2);
      if (block) {
        out.push(...block);
        continue;
      }
    }
    out.push(guardLine(rewriteInline(ctx, guardWikilinks(line))));
  }
  if (asideDepth > 0) {
    countLoss(ctx.loss, "unclosed-aside");
    out.push("::");
  }
  return out;
}

function figureLine(ctx: PageContext, alt: string, href: string, depth: number): string[] | undefined {
  const fence = ":".repeat(depth);
  const altText = attrText(alt || "Image");
  if (/^https?:\/\//i.test(href)) return [`${fence}figure{src="${attrText(href)}" alt="${altText}"}`, fence];
  const target = resolveLocal(ctx, href);
  if (!target) {
    countLoss(ctx.loss, "missing-file");
    return [`${ZWSP}${altText}`];
  }
  if (target.kind !== "file" || !isNotionImagePath(target.path)) return undefined;
  const ref = attachmentRef(ctx, target.path);
  if (!ref) return [`${ZWSP}${altText}`];
  return [`${fence}figure{src="${attrText(ref)}" alt="${altText}"}`, fence];
}

const LINK_RE = /(!?)\[((?:\\.|[^\]\\])*)\]\(((?:[^()\s]|\([^()\s]*\))+)\)/g;

interface InlineMode {
  /** Also rewrite Notion relation values (`Title (path.md)`); only for property values and database cells. */
  relations?: boolean;
  /** Emit `[[Title]]` without a label, for pipe-table rows where `|` would split the cell. */
  bare?: boolean;
}

/** Rewrites Markdown links and images in one line; leaves inline code spans alone. */
function rewriteInline(ctx: PageContext, line: string, mode: InlineMode = {}): string {
  const inlineMode: InlineMode = { ...mode, bare: mode.bare || line.trimStart().startsWith("|") };
  return line
    .split(/(`[^`\n]*`)/)
    .map((part, index) => {
      if (index % 2 === 1) return part;
      const withRelations = inlineMode.relations ? rewriteRelationMentions(ctx, part, inlineMode) : part;
      return rewriteLinks(ctx, withRelations, inlineMode);
    })
    .join("");
}

function rewriteLinks(ctx: PageContext, text: string, mode: InlineMode): string {
  return text.replace(LINK_RE, (match, bang: string, label: string, href: string) => {
    const image = bang === "!";
    if (/^[a-z][a-z0-9+.-]*:/i.test(href)) {
      const pageKey = /^https?:\/\//i.test(href) ? pageKeyFromNotionUrl(ctx.ws, href) : undefined;
      if (pageKey && !image) return wikilink(ctx, pageKey, mode.bare ? "" : label);
      return image ? `[${label || "Image"}](${href})` : match;
    }
    if (ctx.ws.bundle) {
      const pageKey = ctx.ws.byId.get(normalizeNotionId(href.split(/[?#]/)[0]) ?? "");
      if (pageKey && !image) return wikilink(ctx, pageKey, mode.bare ? "" : label);
      countLoss(ctx.loss, "broken-link");
      return label;
    }
    const target = resolveLocal(ctx, href);
    if (!target) {
      countLoss(ctx.loss, /\.(md|csv)$/i.test(href.split(/[?#]/)[0] ?? "") ? "broken-link" : "missing-file");
      return label;
    }
    if (target.kind === "page") return wikilink(ctx, target.key, mode.bare ? "" : label);
    const ref = attachmentRef(ctx, target.path);
    return ref ? `[${label || basename(target.path)}](${ref})` : label;
  });
}

/** Notion renders relation properties as `Title (Title%20<id>.md)`; turn those into wikilinks too. */
function rewriteRelationMentions(ctx: PageContext, text: string, mode: InlineMode): string {
  if (ctx.ws.bundle) return text;
  return text.replace(/(^|[\s,])([^\s,()][^,()]*?) \(((?:[^()\s])+\.(?:md|csv))\)/g, (match, lead: string, label: string, href: string) => {
    const target = resolveLocal(ctx, href);
    return target?.kind === "page" ? `${lead}${wikilink(ctx, target.key, mode.bare ? "" : label)}` : match;
  });
}

function wikilink(ctx: PageContext, key: string, label: string): string {
  const page = ctx.ws.pages.get(key);
  if (!page) return label;
  ctx.linkOrder.push(key);
  const title = page.title.trim();
  const plainLabel = label.replace(/\\([\\[\]])/g, "$1").trim();
  if (!title || /[[\]|#\n]/.test(title)) {
    countLoss(ctx.loss, "unlinkable-title");
    return plainLabel || title;
  }
  if (!plainLabel || plainLabel === title || /[[\]|]/.test(plainLabel)) return `[[${title}]]`;
  return `[[${title}|${plainLabel}]]`;
}

type LocalTarget = { kind: "page"; key: string } | { kind: "file"; path: string };

function resolveLocal(ctx: PageContext, href: string): LocalTarget | undefined {
  let decoded: string;
  try {
    decoded = decodeURIComponent(href.split(/[?#]/)[0] ?? "");
  } catch {
    return undefined;
  }
  if (!decoded) return undefined;
  const joined = decoded.startsWith("/") ? decoded.slice(1) : ctx.page.dir ? `${ctx.page.dir}/${decoded}` : decoded;
  const path = normalizePath(joined);
  if (!path) return undefined;
  const extension = extensionOf(path);
  if (extension === "md" || extension === "csv") {
    const key = path.replace(/(_all)?\.(md|csv)$/i, "");
    if (ctx.ws.pages.has(key)) return { kind: "page", key };
    const id = splitNotionStem(basename(key)).id;
    const byId = id ? ctx.ws.byId.get(id) : undefined;
    return byId ? { kind: "page", key: byId } : undefined;
  }
  return ctx.ws.files.has(path) ? { kind: "file", path } : undefined;
}

function attachmentRef(ctx: PageContext, path: string): string | undefined {
  const existing = ctx.attachmentByPath.get(path);
  if (existing) return `${ATTACHMENT_REF_PREFIX}${existing}`;
  const data = ctx.ws.files.get(path);
  if (!data) return undefined;
  if (ctx.ws.options.maxAttachmentBytes !== undefined && data.length > ctx.ws.options.maxAttachmentBytes) {
    countLoss(ctx.loss, "attachment-too-large");
    return undefined;
  }
  const base = notionAttachmentFilename(basename(path));
  const used = new Set(ctx.attachments.map((attachment) => attachment.filename.toLowerCase()));
  let filename = base;
  for (let index = 2; used.has(filename.toLowerCase()); index++) {
    const dot = base.lastIndexOf(".");
    filename = dot > 0 ? `${base.slice(0, dot)}-${index}${base.slice(dot)}` : `${base}-${index}`;
  }
  ctx.attachments.push({ filename, archivePath: path, data });
  ctx.attachmentByPath.set(path, filename);
  return `${ATTACHMENT_REF_PREFIX}${filename}`;
}

/**
 * Reduces a Notion file name to one that is safe as an attachment name and inside a Markdown link
 * target: no directories, whitespace, brackets, parentheses, `%`, or filesystem-special characters.
 */
export function notionAttachmentFilename(raw: string): string {
  let cleaned = raw
    .normalize("NFC")
    .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, "")
    .replace(/[\\/<>:"|?*`%()[\]{}#\s]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^[-.]+|[-.]+$/g, "");
  if (!cleaned) cleaned = "file";
  if (cleaned.length > 180) {
    const dot = cleaned.lastIndexOf(".");
    const extension = dot > 0 && cleaned.length - dot <= 12 ? cleaned.slice(dot) : "";
    cleaned = `${cleaned.slice(0, 180 - extension.length)}${extension}`;
  }
  return cleaned;
}

function databaseTable(ctx: PageContext, page: RawPage): string[] {
  const csv = page.csv!;
  if (csv.columns.length === 0) return [];
  const rowPages = new Map<string, string>();
  for (const candidate of ctx.ws.pages.values()) {
    if (candidate.parentKey === page.key) rowPages.set(candidate.title.trim().toLowerCase(), candidate.key);
  }
  const cell = (value: string): string => singleLine(value).replace(/\|/g, "\\|");
  const lines = [`| ${csv.columns.map(cell).join(" | ")} |`, `| ${csv.columns.map(() => "---").join(" | ")} |`];
  for (const row of csv.rows) {
    const cells = csv.columns.map((_, index) => {
      const value = row[index] ?? "";
      if (index === 0) {
        const key = rowPages.get(value.trim().toLowerCase());
        if (key) return wikilink(ctx, key, "");
      }
      return cell(rewriteInline(ctx, guardWikilinks(singleLine(value)), { relations: true, bare: true }));
    });
    lines.push(`| ${cells.join(" | ")} |`);
  }
  return lines;
}

function datasetBlock(id: string, csv: { columns: string[]; rows: string[][] }): string[] {
  if (csv.columns.length === 0) return [];
  const quote = (value: string): string => {
    const text = singleLine(value);
    return text === "" || /^[\p{L}\p{N}][^,"]*$/u.test(text) ? text : `"${text.replace(/"/g, '""')}"`;
  };
  return [
    `::dataset{id="${id}" format="csv"}`,
    csv.columns.map(quote).join(","),
    ...csv.rows.map((row) => csv.columns.map((_, index) => quote(row[index] ?? "")).join(",")),
    "::",
  ];
}

// -- Helpers ------------------------------------------------------------------------

function extractProperties(body: string): { properties: Array<[string, string]>; rest: string } | undefined {
  const lines = body.split("\n");
  let index = 0;
  while (index < lines.length && lines[index]!.trim() === "") index++;
  const properties: Array<[string, string]> = [];
  const start = index;
  for (; index < lines.length; index++) {
    const line = lines[index]!;
    if (line.trim() === "") break;
    const match = line.match(/^([^:\n#>|*\-`[!][^:\n]{0,79}):(?: (.*))?$/);
    if (!match) return undefined;
    properties.push([match[1]!.trim(), (match[2] ?? "").trim()]);
  }
  if (properties.length === 0 || properties.length > 100 || index === start) return undefined;
  return { properties, rest: lines.slice(index).join("\n") };
}

function firstHeading(markdown: string): string | undefined {
  const line = markdown.replace(/^﻿/, "").split(/\r?\n/).find((candidate) => candidate.trim() !== "");
  const match = line?.match(/^#\s+(.+?)\s*$/);
  return match ? match[1]!.slice(0, 250) : undefined;
}

function stripFirstHeading(body: string): string {
  const lines = body.split("\n");
  const index = lines.findIndex((line) => line.trim() !== "");
  if (index >= 0 && /^#\s+/.test(lines[index]!)) lines.splice(0, index + 1);
  return lines.join("\n");
}

/** `Title 0123…(32 hex)` → title + id. Notion separates them with a space. */
function splitNotionStem(stem: string): { title: string; id?: string } {
  const match = stem.match(/^(.*?)\s*\b([0-9a-f]{32})$/i);
  if (!match) return { title: stem.trim() || "Untitled" };
  return { title: match[1]!.trim() || "Untitled", id: match[2]!.toLowerCase() };
}

function normalizeNotionId(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const compact = value.trim().toLowerCase().replace(/-/g, "");
  if (/^[0-9a-f]{32}$/.test(compact)) return compact;
  return /^[A-Za-z0-9_.:-]{1,80}$/.test(value.trim()) ? value.trim() : undefined;
}

function pageKeyFromNotionUrl(ws: Workspace, href: string): string | undefined {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return undefined;
  }
  if (!/(^|\.)notion\.(so|site)$/i.test(url.hostname)) return undefined;
  const match = url.pathname.replace(/-/g, "").match(/([0-9a-f]{32})$/i) ?? url.hash.replace(/-/g, "").match(/([0-9a-f]{32})$/i);
  return match ? ws.byId.get(match[1]!.toLowerCase()) : undefined;
}

function safeArchivePath(raw: string): string | undefined {
  if (raw.includes("\0")) return undefined;
  const path = raw.replace(/\\/g, "/");
  if (path.startsWith("/") || /^[a-z]:/i.test(path)) return undefined;
  if (path.split("/").some((segment) => segment === "..")) return undefined;
  return normalizePath(path);
}

function normalizePath(path: string): string | undefined {
  const out: string[] = [];
  for (const segment of path.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (out.length === 0) return undefined;
      out.pop();
      continue;
    }
    out.push(segment);
  }
  return out.length > 0 ? out.join("/") : undefined;
}

/** Stable fallback ID for entries without a Notion ID; drops the per-export `Export-<uuid>/` folder. */
function pathId(key: string): string {
  return `path:${key.replace(/^Export-[^/]*\//i, "")}`;
}

function dirname(path: string): string {
  const index = path.lastIndexOf("/");
  return index < 0 ? "" : path.slice(0, index);
}

function basename(path: string): string {
  return path.slice(path.lastIndexOf("/") + 1);
}

function extensionOf(path: string): string {
  const name = basename(path);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

/** True for file names Notion exports as images (rendered as figures when they stand alone). */
export function isNotionImagePath(path: string): boolean {
  return IMAGE_EXTENSIONS.has(extensionOf(path));
}

function decodeText(bytes: Buffer): string {
  return bytes.toString("utf8").replace(/^﻿/, "");
}

/** RFC 4180 CSV with quoted multi-line cells, bounded in rows and columns. */
export function parseCsv(text: string, label = "CSV"): { columns: string[]; rows: string[][] } {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  const input = text.replace(/^﻿/, "");
  for (let index = 0; index < input.length; index++) {
    const char = input[index]!;
    if (quoted) {
      if (char === '"') {
        if (input[index + 1] === '"') {
          cell += '"';
          index++;
        } else quoted = false;
      } else cell += char;
      continue;
    }
    if (char === '"' && cell === "") quoted = true;
    else if (char === ",") {
      row.push(cell);
      cell = "";
      if (row.length > MAX_CSV_COLUMNS) throw new NotionImportError(`${label} has more than ${MAX_CSV_COLUMNS} columns`);
    } else if (char === "\n" || char === "\r") {
      if (char === "\r" && input[index + 1] === "\n") index++;
      row.push(cell);
      cell = "";
      if (row.some((value) => value !== "")) rows.push(row);
      row = [];
      if (rows.length > MAX_CSV_ROWS + 1) throw new NotionImportError(`${label} has more than ${MAX_CSV_ROWS} rows`);
    } else cell += char;
  }
  row.push(cell);
  if (row.some((value) => value !== "")) rows.push(row);
  const [columns = [], ...body] = rows;
  return { columns: columns.map((column) => column.trim()), rows: body };
}

function singleLine(text: string): string {
  return text.replace(/\s*\n\s*/g, " ").trim();
}

function headingText(text: string): string {
  return singleLine(text).replace(/\s+\{/g, " (").replace(/\}/g, ")").trim();
}

function headingTitle(title: string): string {
  return headingText(title).replace(/^#+\s*/, "");
}

function attrText(value: string): string {
  return singleLine(value).replace(/"/g, "'").replace(/[{}]/g, "");
}

/** Keeps literal `[[…]]` in Notion text from turning into Noma wikilinks. */
function guardWikilinks(text: string): string {
  return text.replace(/\[\[/g, `[${ZWSP}[`).replace(/\]\]/g, `]${ZWSP}]`);
}

/** Keeps a literal line that starts with a Noma fence (`::`) from opening a directive. */
function guardLine(line: string): string {
  return /^\s*:{2,}/.test(line) ? `${ZWSP}${line}` : line;
}

function labelList(values: string[]): string[] {
  return values
    .map((value) => value.trim().toLowerCase().replace(/\s+/g, "-"))
    .filter((label) => /^[\p{L}\p{N}][\p{L}\p{N}_.:-]{0,49}$/u.test(label));
}

function scalarText(value: unknown): string | undefined {
  if (typeof value === "string") return value.trim() || undefined;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  if (typeof value === "boolean") return value ? "Yes" : "No";
  return undefined;
}

function countLoss(loss: Map<string, number>, kind: string): void {
  loss.set(kind, (loss.get(kind) ?? 0) + 1);
}

function lossList(loss: Map<string, number>): NotionLossEntry[] {
  return [...loss].map(([kind, count]) => ({ kind, count })).sort((a, b) => b.count - a.count || a.kind.localeCompare(b.kind));
}

function assertPageCount(count: number, options: NotionImportOptions): void {
  const max = options.maxPages ?? MAX_NOTION_PAGES;
  if (count > max) throw new NotionImportError(`A Notion import can contain at most ${max} pages and databases`);
}

/** Parents before children; siblings by link order in the parent, then title. */
export function orderNotionPages<T extends { id: string; parentId?: string; position?: number; title: string }>(pages: T[]): T[] {
  const ids = new Set(pages.map((page) => page.id));
  const children = new Map<string | undefined, T[]>();
  for (const page of pages) {
    const parent = page.parentId && ids.has(page.parentId) && page.parentId !== page.id ? page.parentId : undefined;
    children.set(parent, [...(children.get(parent) ?? []), page]);
  }
  const sortKey = (a: T, b: T): number =>
    (a.position ?? Number.MAX_SAFE_INTEGER) - (b.position ?? Number.MAX_SAFE_INTEGER) || a.title.localeCompare(b.title) || a.id.localeCompare(b.id);
  const ordered: T[] = [];
  const seen = new Set<string>();
  const visit = (parent: string | undefined): void => {
    for (const page of (children.get(parent) ?? []).sort(sortKey)) {
      if (seen.has(page.id)) continue;
      seen.add(page.id);
      ordered.push(page);
      visit(page.id);
    }
  };
  visit(undefined);
  for (const page of pages) {
    if (!seen.has(page.id)) {
      seen.add(page.id);
      ordered.push(page);
    }
  }
  return ordered;
}

export interface NotionOutputFile {
  /** Relative output path (`/` separators). */
  path: string;
  data: string | Buffer;
}

/**
 * Lays a converted import out as a directory tree for `noma ingest --from notion`: each page is
 * `<parent-slug>/<slug>.noma`, its files sit in `<slug>.files/` next to it (so `att:` references
 * become relative `figure src` paths the loader can inline), and `notion-import-report.json`
 * summarises pages, loss, and skipped entries.
 */
export function notionOutputFiles(result: NotionImport): NotionOutputFile[] {
  const byId = new Map(result.pages.map((page) => [page.id, page]));
  const dirs = new Map<string, string>();
  const used = new Map<string, Set<string>>();
  const files: NotionOutputFile[] = [];
  const report: Array<Record<string, unknown>> = [];
  for (const page of result.pages) {
    const parentDir = page.parentId && byId.has(page.parentId) ? dirs.get(page.parentId) ?? "" : "";
    const siblings = used.get(parentDir) ?? new Set<string>(["notion-import-report"]);
    used.set(parentDir, siblings);
    const base = slugify(page.title).slice(0, 80) || "page";
    let slug = base;
    for (let index = 2; siblings.has(slug); index++) slug = `${base}-${index}`;
    siblings.add(slug);
    const prefix = parentDir ? `${parentDir}/` : "";
    dirs.set(page.id, `${prefix}${slug}`);
    let source = page.source;
    for (const attachment of page.attachments) {
      const ref = `${ATTACHMENT_REF_PREFIX}${attachment.filename}`;
      const local = `${slug}.files/${attachment.filename}`;
      source = source.split(`"${ref}"`).join(`"${local}"`).split(`](${ref})`).join(`](${local})`);
      files.push({ path: `${prefix}${local}`, data: attachment.data });
    }
    files.push({ path: `${prefix}${slug}.noma`, data: source });
    report.push({
      id: page.id,
      title: page.title,
      kind: page.kind,
      file: `${prefix}${slug}.noma`,
      ...(page.parentId ? { parentId: page.parentId } : {}),
      attachments: page.attachments.map((attachment) => attachment.filename),
      loss: page.loss,
    });
  }
  const summary = { ...(result.workspace ? { workspace: result.workspace } : {}), pages: report, loss: result.loss, skipped: result.skipped };
  files.push({ path: "notion-import-report.json", data: `${JSON.stringify(summary, null, 2)}\n` });
  return files;
}
