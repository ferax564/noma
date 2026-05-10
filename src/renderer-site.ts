import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { DocumentNode, Node, SectionNode } from "./ast.js";
import { walk } from "./ast.js";
import { escapeAttr, escapeHtml } from "./inline.js";
import { renderHtml } from "./renderer-html.js";
import type { LoadedChapter } from "./book.js";

export interface SiteRenderOptions {
  themeCss?: string;
  title?: string;
  allowEscapeHatches?: boolean;
  math?: "katex" | "none";
}

interface IdLocation {
  chapterSlug: string;
  /** Anchor name to link to (block ID or alias). */
  anchor: string;
}

export function renderSite(
  manifest: Record<string, unknown>,
  chapters: LoadedChapter[],
  outDir: string,
  options: SiteRenderOptions = {},
): void {
  const absOut = resolve(outDir);
  mkdirSync(absOut, { recursive: true });

  const idMap = buildIdMap(chapters);
  const bookTitle =
    options.title ||
    (typeof manifest.title === "string" ? manifest.title : undefined) ||
    "Noma Book";

  for (const ch of chapters) {
    const html = renderHtml(ch.doc, {
      standalone: true,
      themeCss: options.themeCss ?? "",
      title: chapterTitle(ch) || bookTitle,
      allowEscapeHatches: options.allowEscapeHatches !== false,
      ...(options.math ? { math: options.math } : {}),
    });
    const rewritten = rewriteWikilinks(html, ch.slug, idMap);
    const withNav = injectNav(rewritten, chapters, ch.slug, bookTitle);
    const target = join(absOut, `${ch.slug}.html`);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, withNav, "utf8");
  }

  const indexHtml = renderIndex(bookTitle, manifest, chapters, options.themeCss ?? "");
  writeFileSync(join(absOut, "index.html"), indexHtml, "utf8");
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

const WIKILINK_HREF_RE =
  /<a\s+class="noma-ref"\s+href="#([^"]+)">([^<]+)<\/a>/g;

function rewriteWikilinks(
  html: string,
  currentSlug: string,
  idMap: Map<string, IdLocation>,
): string {
  return html.replace(WIKILINK_HREF_RE, (match, id: string, label: string) => {
    const loc = idMap.get(id);
    if (!loc || loc.chapterSlug === currentSlug) return match;
    return `<a class="noma-ref noma-xchapter" href="${escapeAttr(loc.chapterSlug)}.html#${escapeAttr(loc.anchor)}">${label}</a>`;
  });
}

function injectNav(
  html: string,
  chapters: LoadedChapter[],
  currentSlug: string,
  bookTitle: string,
): string {
  const items = chapters
    .map((c) => {
      const isCurrent = c.slug === currentSlug;
      const label = chapterTitle(c) ?? c.slug;
      return isCurrent
        ? `<li class="noma-nav-current"><span>${escapeHtml(label)}</span></li>`
        : `<li><a href="${escapeAttr(c.slug)}.html">${escapeHtml(label)}</a></li>`;
    })
    .join("");
  const nav = `<nav class="noma-site-nav" aria-label="Chapters">
<a class="noma-site-home" href="index.html">${escapeHtml(bookTitle)}</a>
<ol>${items}</ol>
</nav>`;
  return html.replace(
    /<main class="noma-doc">/,
    `${nav}\n<main class="noma-doc">`,
  );
}

function renderIndex(
  bookTitle: string,
  manifest: Record<string, unknown>,
  chapters: LoadedChapter[],
  themeCss: string,
): string {
  const author =
    typeof manifest.author === "string" ? manifest.author : undefined;
  const items = chapters
    .map((c) => {
      const label = chapterTitle(c) ?? c.slug;
      const summary = chapterSummary(c.doc);
      return `<li>
        <a class="noma-site-chapter" href="${escapeAttr(c.slug)}.html">
          <span class="noma-site-chapter-title">${escapeHtml(label)}</span>
          ${summary ? `<span class="noma-site-chapter-summary">${escapeHtml(summary)}</span>` : ""}
        </a>
      </li>`;
    })
    .join("\n");

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="generator" content="noma" />
<title>${escapeHtml(bookTitle)}</title>
<style>${themeCss}</style>
</head>
<body>
<main class="noma-doc noma-site-index">
<header class="noma-site-header">
  <h1>${escapeHtml(bookTitle)}</h1>
  ${author ? `<p class="noma-site-author">${escapeHtml(author)}</p>` : ""}
</header>
<ol class="noma-site-toc">
${items}
</ol>
</main>
</body>
</html>`;
}

function chapterSummary(doc: DocumentNode): string | undefined {
  for (const node of walk(doc)) {
    if (node.type === "directive" && (node.name === "summary" || node.name === "abstract")) {
      const body = (node.body ?? "").trim();
      if (body) return firstLine(body);
    }
    if (node.type === "paragraph") {
      const body = node.content.trim();
      if (body) return firstLine(body);
    }
  }
  return undefined;
}

function firstLine(s: string): string {
  const line = s.split("\n")[0]!.trim();
  return line.length > 200 ? line.slice(0, 197) + "…" : line;
}

export type { LoadedChapter, Node };
