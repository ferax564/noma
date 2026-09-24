/**
 * Exports: `GET /api/documents/:id/export?to=pdf|docx|markdown|html|noma|llm|json` and
 * `GET /api/sites/:id/export?to=site-zip|noma-zip`. Macros are resolved for
 * the requesting viewer; escape hatches and external assets stay off.
 */
import type { ServerResponse } from "node:http";
import yaml from "js-yaml";
import type { CloudDocumentRecord, CloudSiteRecord } from "../cloud-db.js";
import { expandMacros } from "../macros.js";
import { parse, slugify } from "../parser.js";
import { PdfUnavailableError, renderPdfBuffer } from "../pdf.js";
import { renderDocx } from "../renderer-docx.js";
import { renderHtml } from "../renderer-html.js";
import { renderJson } from "../renderer-json.js";
import { renderLlm } from "../renderer-llm.js";
import { renderMarkdown } from "../renderer-markdown.js";
import { createZip, type ZipEntryInput } from "../zip.js";
import { type AccessContext, type CloudServerConfig, type Principal, requireRecordAccess } from "./context.js";
import { escapeAttr, escapeHtml, HttpError, setSecurityHeaders } from "./http.js";
import { cloudMacroResolvers } from "./macros.js";
import { defaultThemeCss } from "./theme.js";
import { documentComponentKit } from "./spaces.js";
import type { ComponentKit } from "../components.js";

export const DOCUMENT_EXPORT_FORMATS = ["pdf", "docx", "markdown", "html", "noma", "llm", "json"] as const;
export const SITE_EXPORT_FORMATS = ["site-zip", "noma-zip"] as const;
const MAX_SITE_EXPORT_PAGES = 2_000;
const MAX_CONCURRENT_PDF_RENDERS = 2;
let activePdfRenders = 0;

export async function routeDocumentExport(
  req: { method?: string },
  res: ServerResponse,
  url: URL,
  config: CloudServerConfig,
  principal: Principal,
  record: CloudDocumentRecord,
): Promise<void> {
  if ((req.method ?? "GET") !== "GET") throw new HttpError(405, "Method not allowed");
  requireRecordAccess(config, record, principal, "viewer");
  const to = formatInput(url.searchParams.get("to"), DOCUMENT_EXPORT_FORMATS);
  const base = fileSlug(record.title, record.id);
  const doc = parse(record.source, { filename: `${record.id}.noma` });
  const macros = cloudMacroResolvers(config, principal, record.id);
  switch (to) {
    case "noma":
      sendDownload(res, record.source, "text/plain; charset=utf-8", `${base}.noma`);
      return;
    case "llm":
      sendDownload(res, renderLlm(doc, macros), "text/plain; charset=utf-8", `${base}.llm.txt`);
      return;
    case "json":
      sendDownload(res, renderJson(doc), "application/json; charset=utf-8", `${base}.json`);
      return;
    case "markdown":
      sendDownload(res, renderMarkdown(expandMacros(doc, macros), { components: documentComponentKit(config, record.id) }), "text/markdown; charset=utf-8", `${base}.md`);
      return;
    case "html":
      sendDownload(res, standaloneHtml(record, macros, documentComponentKit(config, record.id)), "text/html; charset=utf-8", `${base}.html`);
      return;
    case "docx": {
      const docx = renderDocx(expandMacros(doc, macros), { title: record.title, creator: "Noma Cloud", components: documentComponentKit(config, record.id) });
      sendDownload(res, docx, "application/vnd.openxmlformats-officedocument.wordprocessingml.document", `${base}.docx`);
      return;
    }
    case "pdf": {
      if (activePdfRenders >= MAX_CONCURRENT_PDF_RENDERS) {
        res.setHeader("retry-after", "5");
        throw new HttpError(503, "Too many PDF exports are running; try again shortly", { code: "pdf_busy" });
      }
      activePdfRenders += 1;
      try {
        sendDownload(res, await renderPdfBuffer(standaloneHtml(record, macros, documentComponentKit(config, record.id))), "application/pdf", `${base}.pdf`);
      } catch (error) {
        if (error instanceof PdfUnavailableError) {
          throw new HttpError(501, "PDF export is not available on this server: install Puppeteer and its Chrome build (npx puppeteer browsers install chrome).", {
            code: "pdf_unavailable",
            alternatives: ["html", "docx", "markdown", "noma"],
          });
        }
        throw error;
      } finally {
        activePdfRenders -= 1;
      }
      return;
    }
  }
}

export async function routeSiteExport(
  req: { method?: string },
  res: ServerResponse,
  url: URL,
  config: CloudServerConfig,
  principal: Principal,
  site: CloudSiteRecord,
): Promise<void> {
  if ((req.method ?? "GET") !== "GET") throw new HttpError(405, "Method not allowed");
  const access = requireRecordAccess(config, site, principal, "viewer");
  const to = formatInput(url.searchParams.get("to"), SITE_EXPORT_FORMATS);
  const pages = site.documentIds
    .filter((id) => !config.store.isTrashed("document", id))
    .map((id) => config.store.readDocument(id))
    .filter((record): record is CloudDocumentRecord => Boolean(record));
  if (pages.length > MAX_SITE_EXPORT_PAGES) throw new HttpError(413, `Spaces with more than ${MAX_SITE_EXPORT_PAGES} pages cannot be exported in one archive`);
  const paths = uniquePagePaths(pages);
  const parents = visibleParents(site, pages);
  const base = fileSlug(site.title, site.id);
  const exportedAt = config.now();
  const entries: ZipEntryInput[] =
    to === "noma-zip"
      ? nomaArchive(config, site, pages, paths, parents, exportedAt)
      : siteArchive(config, principal, site, pages, paths, parents, access, exportedAt);
  sendDownload(res, createZip(entries.map((entry) => ({ ...entry, modifiedAt: exportedAt }))), "application/zip", `${base}-${to}.zip`);
}

function nomaArchive(
  config: CloudServerConfig,
  site: CloudSiteRecord,
  pages: CloudDocumentRecord[],
  paths: Map<string, string>,
  parents: Record<string, string>,
  exportedAt: Date,
): ZipEntryInput[] {
  const manifest = {
    format: "noma-space-export",
    version: 1,
    exportedAt: exportedAt.toISOString(),
    site: { id: site.id, title: site.title, slug: site.slug },
    pages: pages.map((page) => ({
      id: page.id,
      title: page.title,
      path: `pages/${paths.get(page.id)}.noma`,
      ...(parents[page.id] ? { parentId: parents[page.id] } : {}),
      ...(site.pageFolders?.[page.id] ? { folder: site.pageFolders[page.id] } : {}),
      labels: config.store.listDocumentLabels(page.id),
      hash: page.hash,
      updatedAt: page.updatedAt,
    })),
  };
  const book = yaml.dump({
    title: site.title,
    description: `Exported from Noma Cloud on ${exportedAt.toISOString().slice(0, 10)}`,
    chapters: pages.map((page) => `pages/${paths.get(page.id)}.noma`),
  });
  return [
    { path: "manifest.json", data: `${JSON.stringify(manifest, null, 2)}\n` },
    { path: "book.noma.yml", data: book },
    ...pages.map((page) => ({ path: `pages/${paths.get(page.id)}.noma`, data: page.source })),
  ];
}

function siteArchive(
  config: CloudServerConfig,
  principal: Principal,
  site: CloudSiteRecord,
  pages: CloudDocumentRecord[],
  paths: Map<string, string>,
  parents: Record<string, string>,
  access: AccessContext,
  exportedAt: Date,
): ZipEntryInput[] {
  const pageHref = (id: string): string | undefined => {
    const path = paths.get(id);
    return path ? `${path}.html` : undefined;
  };
  const nav = pageTreeHtml(pages, parents, (id) => `pages/${paths.get(id)}.html`);
  const entries: ZipEntryInput[] = pages.map((page) => {
    const macros = cloudMacroResolvers(config, principal, page.id, { pageHref });
    const html = renderHtml(parse(page.source, { filename: `${page.id}.noma` }), {
      ...macros,
      components: documentComponentKit(config, page.id),
      standalone: true,
      title: page.title,
      allowEscapeHatches: false,
      externalAssets: false,
      interactive: false,
      themeCss: themeCss(),
    });
    const back = `<nav class="noma-export-nav"><a href="../index.html">${escapeHtml(site.title)}</a></nav>`;
    return { path: `pages/${paths.get(page.id)}.html`, data: html.replace("<body>", `<body>${back}`) };
  });
  const index = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="generator" content="noma-cloud" />
<title>${escapeHtml(site.title)}</title>
<style>${themeCss()}</style>
</head>
<body>
<main class="noma-doc">
<h1>${escapeHtml(site.title)}</h1>
<p>Exported from Noma Cloud on ${escapeHtml(exportedAt.toISOString().slice(0, 10))} · ${escapeHtml(access.role)} access · ${pages.length} pages</p>
${nav}
</main>
</body>
</html>
`;
  return [{ path: "index.html", data: index }, ...entries];
}

function pageTreeHtml(pages: CloudDocumentRecord[], parents: Record<string, string>, href: (id: string) => string): string {
  const children = new Map<string | undefined, CloudDocumentRecord[]>();
  for (const page of pages) {
    const parent = parents[page.id];
    const list = children.get(parent) ?? [];
    list.push(page);
    children.set(parent, list);
  }
  const render = (parent: string | undefined, depth: number): string => {
    const list = children.get(parent);
    if (!list || depth > 50) return "";
    return `<ul>${list.map((page) => `<li><a href="${escapeAttr(href(page.id))}">${escapeHtml(page.title)}</a>${render(page.id, depth + 1)}</li>`).join("")}</ul>`;
  };
  return `<nav class="noma-children" aria-label="Pages">${render(undefined, 0)}</nav>`;
}

/** Parent map restricted to exported pages; a page whose parent is not exported becomes a root. */
function visibleParents(site: CloudSiteRecord, pages: CloudDocumentRecord[]): Record<string, string> {
  const exported = new Set(pages.map((page) => page.id));
  const parents: Record<string, string> = {};
  for (const page of pages) {
    let parent = site.pageParents?.[page.id];
    const seen = new Set<string>();
    while (parent && !exported.has(parent) && !seen.has(parent)) {
      seen.add(parent);
      parent = site.pageParents?.[parent];
    }
    if (parent && exported.has(parent)) parents[page.id] = parent;
  }
  return parents;
}

function uniquePagePaths(pages: CloudDocumentRecord[]): Map<string, string> {
  const used = new Set<string>();
  const paths = new Map<string, string>();
  for (const page of pages) {
    const base = fileSlug(page.title, page.id);
    let candidate = base;
    for (let suffix = 2; used.has(candidate); suffix++) candidate = `${base}-${suffix}`;
    used.add(candidate);
    paths.set(page.id, candidate);
  }
  return paths;
}

function standaloneHtml(record: CloudDocumentRecord, macros: ReturnType<typeof cloudMacroResolvers>, components: ComponentKit): string {
  return renderHtml(parse(record.source, { filename: `${record.id}.noma` }), {
    ...macros,
    components,
    standalone: true,
    title: record.title,
    allowEscapeHatches: false,
    externalAssets: false,
    interactive: false,
    themeCss: themeCss(),
  });
}

function themeCss(): string {
  return defaultThemeCss();
}

function formatInput<T extends string>(value: string | null, formats: readonly T[]): T {
  if (value && (formats as readonly string[]).includes(value)) return value as T;
  throw new HttpError(400, `to must be one of ${formats.join(", ")}`);
}

function fileSlug(title: string, fallback: string): string {
  return (slugify(title) || fallback).slice(0, 80);
}

function sendDownload(res: ServerResponse, body: string | Buffer, type: string, filename: string): void {
  const payload = typeof body === "string" ? Buffer.from(body, "utf8") : body;
  res.statusCode = 200;
  setSecurityHeaders(res, "default-src 'none'; style-src 'unsafe-inline'; img-src data:; sandbox");
  res.setHeader("content-type", type);
  res.setHeader("content-length", String(payload.length));
  res.setHeader("cache-control", "no-store");
  const ascii = filename.replace(/[^\x20-\x7e]/g, "_").replace(/["\\]/g, "_");
  res.setHeader("content-disposition", `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(filename)}`);
  res.end(payload);
}
