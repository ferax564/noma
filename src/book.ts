import { readFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";
import yaml from "js-yaml";
import type { DocumentNode, Node, SectionNode } from "./ast.js";
import { parse } from "./parser.js";

export interface BookManifest {
  title?: string;
  author?: string;
  chapters: string[];
  outputs?: {
    html?: { theme?: string };
    llm?: Record<string, unknown>;
    pdf?: Record<string, unknown>;
  };
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
  for (const chapter of chapters) {
    const chapterPath = isAbsolute(chapter) ? chapter : resolve(baseDir, chapter);
    const source = readFileSync(chapterPath, "utf8");
    const doc = parse(source, { filename: chapterPath });
    for (const child of doc.children) children.push(child);
  }

  return { type: "document", meta, children };
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
