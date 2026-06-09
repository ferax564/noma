import { readFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import type { DocumentNode } from "./ast.js";
import { walk } from "./ast.js";

export interface InlineSourceOptions {
  /**
   * Permit `src` references that resolve outside the document's directory
   * (absolute paths or `../` escapes). Off by default so rendering an
   * untrusted document cannot embed arbitrary local files into the output.
   */
  allowExternalPaths?: boolean;
}

/**
 * Resolve a file reference against `baseDir`, refusing paths that land
 * outside it unless `allowExternalPaths` is set. Returns `undefined` for
 * refused paths.
 */
export function resolveSourcePath(
  baseDir: string,
  ref: string,
  allowExternalPaths = false,
): string | undefined {
  const path = isAbsolute(ref) ? ref : resolve(baseDir, ref);
  if (allowExternalPaths) return path;
  const rel = relative(resolve(baseDir), path);
  if (rel === "" || (!rel.startsWith("..") && !isAbsolute(rel))) return path;
  return undefined;
}

/**
 * In-place: for every `::dataset{src="..."}` block without an inline body,
 * read the referenced file and stuff its contents into `body`. Sets the
 * `format` attribute (csv/tsv/json/yaml) when not already provided.
 *
 * Path resolution: relative paths resolved against `baseDir` (or the
 * document's own filename's directory) and contained within it; absolute
 * or escaping paths require `allowExternalPaths`.
 *
 * Renderers stay pure — they read `body` and `format`, never the filesystem.
 */
export function inlineDatasetSources(
  doc: DocumentNode,
  baseDir?: string,
  options: InlineSourceOptions = {},
): DocumentNode {
  const dir =
    baseDir ??
    (typeof doc.meta.filename === "string"
      ? dirname(doc.meta.filename)
      : process.cwd());
  for (const node of walk(doc)) {
    if (node.type !== "directive" || node.name !== "dataset") continue;
    const src = node.attrs.src;
    if (typeof src !== "string" || !src.trim()) continue;
    if (node.body && node.body.trim()) continue;
    const path = resolveSourcePath(dir, src, options.allowExternalPaths);
    if (!path) {
      node.body = `# error loading ${src}: path escapes the document directory (use --allow-external-paths to permit)`;
      node.attrs.format = "error";
      continue;
    }
    try {
      const content = readFileSync(path, "utf8");
      node.body = content;
      if (!node.attrs.format) {
        node.attrs.format = inferFormat(src, content);
      }
    } catch (e) {
      node.body = `# error loading ${src}: ${(e as Error).message}`;
      node.attrs.format = "error";
    }
  }
  return doc;
}

export function inlineFigureSources(
  doc: DocumentNode,
  baseDir?: string,
  options: InlineSourceOptions = {},
): DocumentNode {
  const dir =
    baseDir ??
    (typeof doc.meta.filename === "string"
      ? dirname(doc.meta.filename)
      : process.cwd());
  for (const node of walk(doc)) {
    if (node.type !== "directive" || node.name !== "figure") continue;
    const src = node.attrs.src;
    if (typeof src !== "string" || !src.trim()) continue;
    if (typeof node.attrs.data === "string" && node.attrs.data.trim()) continue;
    if (/^(?:https?:|data:)/i.test(src)) continue;
    const contentType = imageMimeType(src);
    if (!contentType) continue;
    const path = resolveSourcePath(dir, src, options.allowExternalPaths);
    if (!path) continue;
    try {
      node.attrs.data = `data:${contentType};base64,${readFileSync(path).toString("base64")}`;
    } catch {
      // Keep the figure renderable as a source reference when the asset is absent.
    }
  }
  return doc;
}

function inferFormat(src: string, content: string): string {
  const ext = src.split(".").pop()?.toLowerCase();
  if (ext === "csv") return "csv";
  if (ext === "tsv") return "tsv";
  if (ext === "json") return "json";
  if (ext === "yaml" || ext === "yml") return "yaml";
  const head = content.trimStart()[0];
  if (head === "{" || head === "[") return "json";
  if (/^[^\n]*,[^\n]*\n/.test(content)) return "csv";
  return "yaml";
}

function imageMimeType(src: string): string | undefined {
  const ext = src.split(/[?#]/, 1)[0]?.split(".").pop()?.toLowerCase();
  if (ext === "png") return "image/png";
  if (ext === "jpg" || ext === "jpeg") return "image/jpeg";
  if (ext === "gif") return "image/gif";
  if (ext === "svg") return "image/svg+xml";
  return undefined;
}
