import { readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import yaml from "js-yaml";
import type { DocumentNode, Node, SectionNode } from "./ast.js";
import { walk } from "./ast.js";
import { parse } from "./parser.js";

export interface BookManifest {
  title?: string;
  author?: string;
  chapters: string[];
  outputs?: {
    html?: { theme?: string; math?: "katex" | "none" };
    llm?: Record<string, unknown>;
    pdf?: Record<string, unknown>;
  };
}

export interface LoadedChapter {
  /** Path-safe chapter slug derived from filename (or root H1 id). */
  slug: string;
  /** Source path of the chapter file (absolute). */
  source: string;
  /** Parsed chapter document with scoped IDs applied. */
  doc: DocumentNode;
}

/**
 * Load a YAML book manifest and assemble a single DocumentNode by
 * concatenating each chapter's parsed AST. Chapter file paths are
 * resolved relative to the manifest's directory.
 */
export function loadBook(manifestPath: string): DocumentNode {
  const absManifest = resolve(manifestPath);
  const raw = readFileSync(absManifest, "utf8");
  const parsed = yaml.load(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`book manifest must be a YAML object: ${manifestPath}`);
  }
  const manifest = parsed as Record<string, unknown>;
  const chapters = Array.isArray(manifest.chapters)
    ? (manifest.chapters as unknown[]).filter((c): c is string => typeof c === "string")
    : [];
  if (chapters.length === 0) {
    throw new Error(`book manifest has no chapters: ${manifestPath}`);
  }
  const baseDir = dirname(absManifest);

  const meta: Record<string, unknown> = {};
  if (typeof manifest.title === "string") meta.title = manifest.title;
  if (typeof manifest.author === "string") meta.author = manifest.author;
  meta.book = {
    chapters: chapters.length,
    manifest: manifestPath,
  };

  const children: Node[] = [];
  const loaded = loadChapters(chapters, baseDir);
  for (const ch of loaded) {
    for (const child of ch.doc.children) children.push(child);
  }

  return { type: "document", meta, children };
}

/**
 * Load every chapter listed in a book manifest as a separate DocumentNode,
 * applying chapter-scoped heading IDs in book mode. Used by the multi-page
 * site renderer; loadBook() concatenates the same set into one doc.
 */
export function loadBookChapters(manifestPath: string): {
  manifest: Record<string, unknown>;
  chapters: LoadedChapter[];
  baseDir: string;
} {
  const absManifest = resolve(manifestPath);
  const raw = readFileSync(absManifest, "utf8");
  const parsed = yaml.load(raw);
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`book manifest must be a YAML object: ${manifestPath}`);
  }
  const manifest = parsed as Record<string, unknown>;
  const chapterPaths = Array.isArray(manifest.chapters)
    ? (manifest.chapters as unknown[]).filter((c): c is string => typeof c === "string")
    : [];
  if (chapterPaths.length === 0) {
    throw new Error(`book manifest has no chapters: ${manifestPath}`);
  }
  const baseDir = dirname(absManifest);
  return { manifest, chapters: loadChapters(chapterPaths, baseDir), baseDir };
}

function loadChapters(chapterPaths: string[], baseDir: string): LoadedChapter[] {
  const out: LoadedChapter[] = [];
  for (const chapter of chapterPaths) {
    const chapterPath = isAbsolute(chapter) ? chapter : resolve(baseDir, chapter);
    const source = readFileSync(chapterPath, "utf8");
    const doc = parse(source, { filename: chapterPath });
    const slug = chapterSlug(chapterPath, doc);
    scopeHeadingIds(doc, slug);
    out.push({ slug, source: chapterPath, doc });
  }
  return out;
}

function chapterSlug(chapterPath: string, doc: DocumentNode): string {
  const root = doc.children.find(
    (n): n is SectionNode => n.type === "section" && n.level === 1,
  );
  if (root && root.id) return root.id;
  const base = chapterPath.replace(/\\/g, "/").split("/").pop() ?? chapterPath;
  const stem = base.replace(/\.noma$/i, "").replace(/^\d+[-_]/, "");
  return stem.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-|-$/g, "");
}

/**
 * In book mode, every heading slug is path-prefixed by its chapter root.
 * `# Risk Premia 3` + `## Risks` → `risk-premia-3` and `risk-premia-3/risks`.
 * Original (un-prefixed) ID is kept as an alias on the same node so any
 * legacy `[[risks]]` writes still resolve to the first occurrence.
 */
function scopeHeadingIds(doc: DocumentNode, chapterSlug: string): void {
  for (const node of walk(doc)) {
    if (node.type !== "section") continue;
    if (node.level === 1) continue;
    if (!node.id) continue;
    if (node.id.startsWith(`${chapterSlug}/`)) continue;
    const original = node.id;
    node.id = `${chapterSlug}/${original}`;
    const aliases = new Set<string>(node.aliases ?? []);
    aliases.add(original);
    node.aliases = [...aliases];
  }
}

export function isBookManifestPath(path: string): boolean {
  return /\.ya?ml$/i.test(path);
}

/**
 * Pull the implicit chapter list off a fully-loaded document for TOC
 * purposes. Each top-level h1 section is treated as a chapter heading.
 */
export function listChapters(doc: DocumentNode): SectionNode[] {
  return doc.children.filter(
    (n): n is SectionNode => n.type === "section" && n.level === 1,
  );
}
