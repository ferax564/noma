import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { DocumentNode, Node, SectionNode } from "./ast.js";
import { walk } from "./ast.js";
import { escapeAttr, escapeHtml, inlineToHtml, inlineToPlain } from "./inline.js";
import { renderHtml } from "./renderer-html.js";
import type { LoadedChapter } from "./book.js";

export interface SiteRenderOptions {
  themeCss?: string;
  title?: string;
  allowEscapeHatches?: boolean;
  math?: "katex" | "none";
  externalAssets?: boolean;
  interactive?: boolean;
}

interface IdLocation {
  chapterSlug: string;
  /** Anchor name to link to (block ID or alias). */
  anchor: string;
}

interface SpacePage {
  slug: string;
  title: string;
  summary?: string;
  source: string;
  href: string;
  path: string[];
  tags: string[];
  status?: string;
  owner?: string;
  updated?: string;
  text: string;
}

interface SpaceModel {
  title: string;
  description?: string;
  author?: string;
  pages: SpacePage[];
  idMap: Map<string, IdLocation>;
  backlinks: Map<string, SpacePage[]>;
}

export function renderSite(
  manifest: Record<string, unknown>,
  chapters: LoadedChapter[],
  outDir: string,
  options: SiteRenderOptions = {},
): void {
  const absOut = resolve(outDir);
  mkdirSync(absOut, { recursive: true });

  const themeCss = options.themeCss ?? "";
  const hasTheme = themeCss.length > 0;
  if (hasTheme) {
    const assetsDir = join(absOut, "_assets");
    mkdirSync(assetsDir, { recursive: true });
    writeFileSync(join(assetsDir, "theme.css"), themeCss, "utf8");
  }

  const idMap = buildIdMap(chapters);
  const bookTitle =
    options.title ||
    (typeof manifest.title === "string" ? manifest.title : undefined) ||
    "Noma Space";
  const space = buildSpaceModel(bookTitle, manifest, chapters, idMap);
  const assetsDir = join(absOut, "_assets");
  mkdirSync(assetsDir, { recursive: true });
  writeFileSync(join(assetsDir, "search-index.json"), JSON.stringify(searchIndex(space), null, 2), "utf8");

  for (const ch of chapters) {
    const prefix = pagePrefix(ch.slug);
    const page = space.pages.find((item) => item.slug === ch.slug)!;
    const html = renderHtml(ch.doc, {
      standalone: true,
      ...(hasTheme ? { stylesheetHref: `${prefix}${THEME_HREF}` } : { themeCss: "" }),
      title: chapterTitle(ch) || bookTitle,
      allowEscapeHatches: options.allowEscapeHatches !== false,
      externalAssets: options.externalAssets !== false,
      interactive: options.interactive !== false,
      ...(options.math ? { math: options.math } : {}),
    });
    const rewritten = rewriteWikilinks(html, ch.slug, idMap, prefix);
    const withNav = injectSpaceChrome(rewritten, space, page, prefix, options.interactive !== false);
    const target = join(absOut, `${ch.slug}.html`);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, withNav, "utf8");
  }

  const indexHtml = renderIndex(space, hasTheme, options.interactive !== false);
  writeFileSync(join(absOut, "index.html"), indexHtml, "utf8");
}

function pagePrefix(slug: string | null): string {
  if (!slug) return "";
  const depth = (slug.match(/\//g) ?? []).length;
  return "../".repeat(depth);
}

function chapterTitle(ch: LoadedChapter): string | undefined {
  const root = ch.doc.children.find(
    (n): n is SectionNode => n.type === "section" && n.level === 1,
  );
  return root?.title;
}

function buildIdMap(chapters: LoadedChapter[]): Map<string, IdLocation> {
  const map = new Map<string, IdLocation>();
  for (const ch of chapters) {
    for (const node of walk(ch.doc)) {
      if (node.id) {
        map.set(node.id, { chapterSlug: ch.slug, anchor: node.id });
      }
      if (node.aliases) {
        for (const a of node.aliases) {
          if (!map.has(a)) map.set(a, { chapterSlug: ch.slug, anchor: a });
        }
      }
    }
  }
  return map;
}

const THEME_HREF = "_assets/theme.css";

const WIKILINK_HREF_RE =
  /<a\s+class="noma-ref"\s+href="#([^"]+)">([^<]+)<\/a>/g;

function rewriteWikilinks(
  html: string,
  currentSlug: string,
  idMap: Map<string, IdLocation>,
  prefix: string,
): string {
  return html.replace(WIKILINK_HREF_RE, (match, id: string, label: string) => {
    const loc = idMap.get(id);
    if (!loc || loc.chapterSlug === currentSlug) return match;
    return `<a class="noma-ref noma-xchapter" href="${escapeAttr(prefix + loc.chapterSlug)}.html#${escapeAttr(loc.anchor)}">${label}</a>`;
  });
}

function buildSpaceModel(
  title: string,
  manifest: Record<string, unknown>,
  chapters: LoadedChapter[],
  idMap: Map<string, IdLocation>,
): SpaceModel {
  const pages = chapters.map((ch) => spacePage(ch, idMap));
  return {
    title,
    ...(stringValue(manifest.description) ? { description: stringValue(manifest.description)! } : {}),
    ...(stringValue(manifest.author) ? { author: stringValue(manifest.author)! } : {}),
    pages,
    idMap,
    backlinks: buildBacklinks(pages, chapters, idMap),
  };
}

function spacePage(ch: LoadedChapter, idMap: Map<string, IdLocation>): SpacePage {
  const summary = chapterSummaryRaw(ch.doc);
  return {
    slug: ch.slug,
    title: chapterTitle(ch) ?? ch.slug,
    source: ch.source,
    href: `${ch.slug}.html`,
    path: ch.slug.split("/").filter(Boolean),
    tags: stringList(ch.doc.meta.tags),
    ...(stringValue(ch.doc.meta.status) ? { status: stringValue(ch.doc.meta.status)! } : {}),
    ...(stringValue(ch.doc.meta.owner) ? { owner: stringValue(ch.doc.meta.owner)! } : {}),
    ...(pageUpdated(ch.doc) ? { updated: pageUpdated(ch.doc)! } : {}),
    ...(summary ? { summary: firstSentence(summary) } : {}),
    text: documentPlainText(ch.doc, idMap),
  };
}

function injectSpaceChrome(
  html: string,
  space: SpaceModel,
  current: SpacePage,
  prefix: string,
  interactive: boolean,
): string {
  const withBodyClass = html.replace("<body>", `<body class="noma-space-body">`);
  const searchData = interactive ? searchDataScript(space, prefix) : "";
  const script = interactive ? spaceRuntimeScript() : "";
  return withBodyClass
    .replace(
      /<main class="noma-doc">/,
      `${buildSpaceSidebar(space, current.slug, prefix, interactive)}
<div class="noma-space-main">
${buildSpaceTopbar(space, current, prefix, interactive)}
<main class="noma-doc noma-space-page">`,
    )
    .replace(
      /<\/main>([\s\S]*?)<\/body>/,
      `</main>
${buildPageInspector(space, current, prefix)}
</div>
</div>
${searchData}${script}$1</body>`,
    );
}

function buildSpaceSidebar(
  space: SpaceModel,
  currentSlug: string | null,
  prefix: string,
  interactive: boolean,
): string {
  const search = interactive
    ? `<label class="noma-space-search">
  <span>Search this space</span>
  <input type="search" data-noma-space-search placeholder="Search pages, tags, IDs" autocomplete="off" />
</label>
<div class="noma-space-search-results" data-noma-search-results hidden></div>`
    : `<p class="noma-space-search-disabled">Search index is available at <a href="${escapeAttr(prefix)}_assets/search-index.json"><code>${escapeHtml(prefix)}_assets/search-index.json</code></a>.</p>`;
  return `<div class="noma-space-shell">
<aside class="noma-space-sidebar" aria-label="Space navigation">
  <a class="noma-space-home${currentSlug === null ? " noma-nav-current" : ""}" href="${escapeAttr(prefix)}index.html">${escapeHtml(space.title)}</a>
  ${space.description ? `<p class="noma-space-description">${escapeHtml(space.description)}</p>` : ""}
  ${search}
  <nav class="noma-site-nav" aria-label="Pages">
    <ol>${space.pages.map((page) => spaceNavItem(page, currentSlug, prefix)).join("")}</ol>
  </nav>
</aside>`;
}

function spaceNavItem(page: SpacePage, currentSlug: string | null, prefix: string): string {
  const isCurrent = page.slug === currentSlug;
  const depth = Math.max(0, page.path.length - 1);
  const meta = [page.status, page.owner].filter(Boolean).join(" / ");
  return `<li class="${isCurrent ? "noma-nav-current" : ""}" style="--depth:${depth}">
    ${isCurrent
      ? `<span>${escapeHtml(page.title)}</span>`
      : `<a href="${escapeAttr(prefix + page.href)}">${escapeHtml(page.title)}</a>`}
    ${meta ? `<small>${escapeHtml(meta)}</small>` : ""}
  </li>`;
}

function buildSpaceTopbar(space: SpaceModel, page: SpacePage, prefix: string, interactive: boolean): string {
  return `<header class="noma-space-topbar">
  <nav class="noma-space-breadcrumbs" aria-label="Breadcrumbs">
    <a href="${escapeAttr(prefix)}index.html">${escapeHtml(space.title)}</a>
    ${page.path.map((part, index) => {
      const isLast = index === page.path.length - 1;
      const label = isLast ? page.title : part;
      return `<span>${escapeHtml(label)}</span>`;
    }).join("")}
  </nav>
  ${buildSpaceActions(interactive)}
</header>`;
}

function buildSpaceActions(interactive: boolean): string {
  if (!interactive) return "";
  return `<div class="noma-space-actions">
    <button type="button" data-noma-copy-link>Copy link</button>
    <button type="button" data-noma-print>Print</button>
  </div>`;
}

function buildPageInspector(space: SpaceModel, page: SpacePage, prefix: string): string {
  const backlinks = space.backlinks.get(page.slug) ?? [];
  const related = relatedPages(space, page);
  return `<aside class="noma-space-inspector" aria-label="Page context">
  <section>
    <h2>Page Info</h2>
    <p><span>Path</span><strong>${escapeHtml(page.slug)}</strong></p>
    ${page.status ? `<p><span>Status</span><strong>${escapeHtml(page.status)}</strong></p>` : ""}
    ${page.owner ? `<p><span>Owner</span><strong>${escapeHtml(page.owner)}</strong></p>` : ""}
    ${page.updated ? `<p><span>Updated</span><strong>${escapeHtml(page.updated)}</strong></p>` : ""}
    ${page.tags.length ? `<div class="noma-space-tags">${page.tags.map((tag) => `<span>${escapeHtml(tag)}</span>`).join("")}</div>` : ""}
  </section>
  <section>
    <h2>Backlinks</h2>
    ${backlinks.length
      ? `<ul>${backlinks.map((item) => `<li><a href="${escapeAttr(prefix + item.href)}">${escapeHtml(item.title)}</a></li>`).join("")}</ul>`
      : `<p class="noma-space-empty">No incoming links yet.</p>`}
  </section>
  <section>
    <h2>Related</h2>
    ${related.length
      ? `<ul>${related.map((item) => `<li><a href="${escapeAttr(prefix + item.href)}">${escapeHtml(item.title)}</a></li>`).join("")}</ul>`
      : `<p class="noma-space-empty">No tag-related pages yet.</p>`}
  </section>
</aside>`;
}

function renderIndex(
  space: SpaceModel,
  hasTheme: boolean,
  interactive: boolean,
): string {
  const nav = buildSpaceSidebar(space, null, "", interactive);
  const items = space.pages
    .map((page) => {
      const descHtml = page.summary ? renderCardDescription(page.summary, space.idMap) : "";
      return `<li>
        <a class="noma-site-chapter" href="${escapeAttr(page.href)}">
          <span class="noma-site-chapter-title">${escapeHtml(page.title)}</span>
          ${descHtml ? `<span class="noma-site-chapter-summary">${descHtml}</span>` : ""}
          ${page.tags.length ? `<span class="noma-site-chapter-tags">${page.tags.map((tag) => `<span>${escapeHtml(tag)}</span>`).join("")}</span>` : ""}
        </a>
      </li>`;
    })
    .join("\n");

  const themeLink = hasTheme
    ? `<link rel="stylesheet" href="${THEME_HREF}" />`
    : "";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="generator" content="noma" />
<title>${escapeHtml(space.title)}</title>
<link rel="icon" href="data:," />
${themeLink}
</head>
<body class="noma-space-body">
${nav}
<div class="noma-space-main">
<header class="noma-space-topbar">
  <nav class="noma-space-breadcrumbs" aria-label="Breadcrumbs">
    <span>${escapeHtml(space.title)}</span>
  </nav>
  ${buildSpaceActions(interactive)}
</header>
<main class="noma-doc noma-site-index noma-space-page">
<header class="noma-site-header">
  <h1>${escapeHtml(space.title)}</h1>
  ${space.author ? `<p class="noma-site-author">${escapeHtml(space.author)}</p>` : ""}
  ${space.description ? `<p class="noma-site-description">${escapeHtml(space.description)}</p>` : ""}
  <div class="noma-space-stats">
    <span>${space.pages.length} pages</span>
    <span>${countSpaceTags(space)} tags</span>
    <span>${countBacklinks(space)} links</span>
  </div>
</header>
<ol class="noma-site-toc">
${items}
</ol>
</main>
<aside class="noma-space-inspector" aria-label="Space context">
  <section>
    <h2>Space</h2>
    <p><span>Pages</span><strong>${space.pages.length}</strong></p>
    <p><span>Tags</span><strong>${countSpaceTags(space)}</strong></p>
    ${space.author ? `<p><span>Owner</span><strong>${escapeHtml(space.author)}</strong></p>` : ""}
  </section>
  <section>
    <h2>Recently Updated</h2>
    ${recentPages(space).length
      ? `<ul>${recentPages(space).map((page) => `<li><a href="${escapeAttr(page.href)}">${escapeHtml(page.title)}</a></li>`).join("")}</ul>`
      : `<p class="noma-space-empty">No page dates yet.</p>`}
  </section>
</aside>
</div>
</div>
${interactive ? searchDataScript(space, "") + spaceRuntimeScript() : ""}
</body>
</html>`;
}

function stringValue(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (value instanceof Date && !Number.isNaN(value.valueOf())) {
    return value.toISOString().slice(0, 10);
  }
  return undefined;
}

function stringList(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map(String).map((item) => item.trim()).filter(Boolean);
  }
  if (typeof value === "string") {
    return value.split(/[,\s]+/).map((item) => item.trim()).filter(Boolean);
  }
  return [];
}

function pageUpdated(doc: DocumentNode): string | undefined {
  return stringValue(doc.meta.updated) ?? stringValue(doc.meta.date);
}

function documentPlainText(doc: DocumentNode, idMap: Map<string, IdLocation>): string {
  const parts: string[] = [];
  for (const node of walk(doc)) {
    switch (node.type) {
      case "section":
        parts.push(node.title);
        break;
      case "paragraph":
      case "quote":
      case "list_item":
        parts.push(node.content);
        break;
      case "code":
        parts.push(node.content);
        break;
      case "table":
        parts.push(...node.header, ...node.rows.flat());
        break;
      case "directive":
        parts.push(node.name);
        if (node.id) parts.push(node.id);
        if (node.body) parts.push(node.body);
        for (const value of Object.values(node.attrs)) parts.push(String(value));
        break;
      default:
        break;
    }
  }
  return inlineToPlain(parts.join(" "))
    .replace(/\[\[([a-zA-Z_][\w\-./:]*)\]\]/g, (_match, id: string) => {
      const loc = idMap.get(id);
      return loc?.anchor ?? id;
    })
    .replace(/\s+/g, " ")
    .trim();
}

function buildBacklinks(
  pages: SpacePage[],
  chapters: LoadedChapter[],
  idMap: Map<string, IdLocation>,
): Map<string, SpacePage[]> {
  const bySlug = new Map(pages.map((page) => [page.slug, page]));
  const out = new Map<string, SpacePage[]>();
  for (const ch of chapters) {
    const sourcePage = bySlug.get(ch.slug);
    if (!sourcePage) continue;
    const linkedSlugs = new Set<string>();
    for (const id of linkedIds(ch.doc)) {
      const loc = idMap.get(id);
      if (!loc || loc.chapterSlug === ch.slug) continue;
      linkedSlugs.add(loc.chapterSlug);
    }
    for (const slug of linkedSlugs) {
      const current = out.get(slug) ?? [];
      current.push(sourcePage);
      out.set(slug, current);
    }
  }
  return out;
}

function linkedIds(doc: DocumentNode): Set<string> {
  const out = new Set<string>();
  const scan = (value: string | undefined): void => {
    if (!value) return;
    const re = /\[\[([a-zA-Z_][\w\-./:]*)\]\]/g;
    let match: RegExpExecArray | null;
    while ((match = re.exec(value)) !== null) {
      const id = match[1];
      if (id) out.add(id);
    }
  };
  for (const node of walk(doc)) {
    if (node.type === "section") scan(node.title);
    if (node.type === "paragraph" || node.type === "quote" || node.type === "list_item") scan(node.content);
    if (node.type === "directive") scan(node.body);
    if (node.type === "table") {
      for (const cell of node.header) scan(cell);
      for (const row of node.rows) for (const cell of row) scan(cell);
    }
  }
  return out;
}

function relatedPages(space: SpaceModel, current: SpacePage): SpacePage[] {
  if (current.tags.length === 0) return [];
  const tags = new Set(current.tags);
  return space.pages
    .filter((page) => page.slug !== current.slug && page.tags.some((tag) => tags.has(tag)))
    .slice(0, 6);
}

function recentPages(space: SpaceModel): SpacePage[] {
  return space.pages
    .filter((page) => page.updated)
    .sort((a, b) => String(b.updated).localeCompare(String(a.updated)))
    .slice(0, 6);
}

function countSpaceTags(space: SpaceModel): number {
  return new Set(space.pages.flatMap((page) => page.tags)).size;
}

function countBacklinks(space: SpaceModel): number {
  let count = 0;
  for (const pages of space.backlinks.values()) count += pages.length;
  return count;
}

function searchIndex(space: SpaceModel, prefix = ""): Array<Record<string, unknown>> {
  return space.pages.map((page) => ({
    title: page.title,
    href: `${prefix}${page.href}`,
    summary: page.summary ?? "",
    path: page.path,
    tags: page.tags,
    status: page.status ?? "",
    owner: page.owner ?? "",
    updated: page.updated ?? "",
    text: page.text,
  }));
}

function searchDataScript(space: SpaceModel, prefix: string): string {
  const json = JSON.stringify(searchIndex(space, prefix)).replace(/</g, "\\u003c");
  return `<script type="application/json" id="noma-space-search-data">${json}</script>`;
}

function spaceRuntimeScript(): string {
  return `<script>
(() => {
  const dataEl = document.getElementById("noma-space-search-data");
  const pages = dataEl ? JSON.parse(dataEl.textContent || "[]") : [];
  const inputs = document.querySelectorAll("[data-noma-space-search]");
  const results = document.querySelectorAll("[data-noma-search-results]");
  const normalize = (value) => String(value || "").toLowerCase();
  const scorePage = (page, query) => {
    const q = normalize(query);
    if (!q) return 0;
    let score = 0;
    if (normalize(page.title).includes(q)) score += 8;
    if (normalize(page.tags?.join(" ")).includes(q)) score += 5;
    if (normalize(page.summary).includes(q)) score += 3;
    if (normalize(page.text).includes(q)) score += 1;
    return score;
  };
  const render = (query) => {
    const q = query.trim();
    for (const panel of results) {
      if (!q) {
        panel.hidden = true;
        panel.innerHTML = "";
        continue;
      }
      const matches = pages
        .map((page) => ({ page, score: scorePage(page, q) }))
        .filter((item) => item.score > 0)
        .sort((a, b) => b.score - a.score)
        .slice(0, 8);
      panel.hidden = false;
      panel.innerHTML = matches.length
        ? matches.map(({ page }) => {
            const tags = (page.tags || []).slice(0, 3).map((tag) => "<span>" + escapeHtml(String(tag)) + "</span>").join("");
            return '<a href="' + escapeAttr(page.href) + '"><strong>' + escapeHtml(page.title) + '</strong><small>' + escapeHtml(page.summary || page.path.join(" / ")) + '</small><em>' + tags + '</em></a>';
          }).join("")
        : '<p>No matching pages.</p>';
    }
  };
  const escapeHtml = (value) => String(value).replace(/[&<>"]/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[ch]));
  const escapeAttr = escapeHtml;
  for (const input of inputs) input.addEventListener("input", () => render(input.value || ""));
  for (const button of document.querySelectorAll("[data-noma-copy-link]")) {
    button.addEventListener("click", async () => {
      try {
        await navigator.clipboard.writeText(location.href);
        button.textContent = "Copied";
        setTimeout(() => { button.textContent = "Copy link"; }, 1300);
      } catch {
        button.textContent = "Copy blocked";
        setTimeout(() => { button.textContent = "Copy link"; }, 1300);
      }
    });
  }
  for (const button of document.querySelectorAll("[data-noma-print]")) {
    button.addEventListener("click", () => window.print());
  }
})();
</script>`;
}

function chapterSummaryRaw(doc: DocumentNode): string | undefined {
  for (const node of walk(doc)) {
    if (node.type === "directive" && (node.name === "summary" || node.name === "abstract")) {
      const body = (node.body ?? "").trim();
      if (body) return body;
    }
    if (node.type === "paragraph") {
      const body = node.content.trim();
      if (body) return body;
    }
  }
  return undefined;
}

const SENTENCE_END_RE = /([.!?])(?=\s|$)/;

function firstSentence(s: string): string {
  const collapsed = s.replace(/\s+/g, " ").trim();
  const m = collapsed.match(SENTENCE_END_RE);
  if (m && m.index !== undefined) {
    return collapsed.slice(0, m.index + 1);
  }
  return collapsed.length > 200 ? collapsed.slice(0, 197) + "..." : collapsed;
}

const CARD_REF_RE = /<a class="noma-ref" href="#([^"]+)">([^<]+)<\/a>/g;

function renderCardDescription(
  raw: string,
  idMap: Map<string, IdLocation>,
): string {
  const sentence = firstSentence(raw);
  const html = inlineToHtml(sentence);
  return html.replace(CARD_REF_RE, (_m, id: string, label: string) => {
    const loc = idMap.get(id);
    if (!loc) return label;
    return `<a class="noma-ref noma-xchapter" href="${escapeAttr(loc.chapterSlug)}.html#${escapeAttr(loc.anchor)}">${label}</a>`;
  });
}

export type { LoadedChapter, Node };
