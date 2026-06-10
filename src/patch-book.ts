import { readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Diagnostic, DocumentNode, Node } from "./ast.js";
import { walk } from "./ast.js";
import {
  chapterSlug,
  loadBookChapters,
  scopeHeadingIds,
  type LoadBookOptions,
} from "./book.js";
import { inlineDatasetSources } from "./loader.js";
import { parse } from "./parser.js";
import { PatchError, patchSource, patchTargetId, type PatchOp } from "./patch.js";
import { validate, type ValidateOptions } from "./validator.js";

export interface BookPatchFile {
  file: string;
  changed: boolean;
}

export interface BookPatchResult {
  files: BookPatchFile[];
  /** Diagnostics for the patched book as a whole (chapters re-scoped and concatenated). */
  postDiagnostics: Diagnostic[];
}

export interface PatchBookOptions extends LoadBookOptions {
  /** Write patched chapter files back to disk. Off by default (dry run). */
  write?: boolean;
  /** Refuse to write when the patched book validates with errors. */
  blockOnErrors?: boolean;
  validateOptions?: ValidateOptions;
}

interface Route {
  file: string;
  rawId: string;
  ambiguous: boolean;
}

/**
 * Apply patch ops across a multi-file book. Each op is routed to the chapter
 * that owns its target block ID — scoped section IDs (`chapter/heading`),
 * their unscoped aliases, and directive IDs all resolve — then applied with
 * the source-preserving `patchSource`. All chapters are patched in memory
 * first; nothing is written unless every op succeeds (`write` opt-in).
 */
export function patchBookSource(
  manifestPath: string,
  ops: PatchOp[],
  options: PatchBookOptions = {},
): BookPatchResult {
  const { chapters } = loadBookChapters(manifestPath, options);
  const sources = new Map<string, string>();
  const routes = new Map<string, Route>();

  const addRoute = (key: string, file: string, rawId: string): void => {
    const existing = routes.get(key);
    if (existing && (existing.file !== file || existing.rawId !== rawId)) {
      existing.ambiguous = true;
      return;
    }
    routes.set(key, { file, rawId, ambiguous: false });
  };

  for (const chapter of chapters) {
    const raw = readFileSync(chapter.source, "utf8");
    sources.set(chapter.source, raw);
    const rawDoc = parse(raw, { filename: chapter.source });
    const rawIds = new Set<string>();
    for (const node of walk(rawDoc)) {
      if (node.id) rawIds.add(node.id);
    }
    for (const id of rawIds) addRoute(id, chapter.source, id);
    for (const node of walk(chapter.doc)) {
      if (!node.id || rawIds.has(node.id)) continue;
      const rawEquivalent = (node.aliases ?? []).find((alias) => rawIds.has(alias));
      if (rawEquivalent) addRoute(node.id, chapter.source, rawEquivalent);
    }
  }

  const touched = new Set<string>();
  for (const op of ops) {
    const target = patchTargetId(op);
    const route = routes.get(target);
    if (!route) {
      throw new PatchError("target_missing", `block "${target}" not found in any chapter of ${manifestPath}`, op);
    }
    if (route.ambiguous) {
      throw new PatchError(
        "id_conflict",
        `block ID "${target}" exists in multiple chapters — use the chapter-scoped ID`,
        op,
      );
    }
    const routedOp = route.rawId === target ? op : retargetOp(op, route.rawId);
    const before = sources.get(route.file)!;
    const after = patchSource(before, routedOp);
    if (after !== before) {
      sources.set(route.file, after);
      touched.add(route.file);
    }
  }

  const combined: Node[] = [];
  for (const chapter of chapters) {
    const doc = parse(sources.get(chapter.source)!, { filename: chapter.source });
    inlineDatasetSources(doc, dirname(chapter.source), options);
    scopeHeadingIds(doc, chapterSlug(chapter.source, doc));
    for (const child of doc.children) combined.push(child);
  }
  const bookDoc: DocumentNode = { type: "document", meta: {}, children: combined };
  const postDiagnostics = validate(bookDoc, options.validateOptions ?? {});

  const blocked =
    options.blockOnErrors === true && postDiagnostics.some((d) => d.severity === "error");
  if (options.write && !blocked) {
    for (const file of touched) {
      writeFileSync(file, sources.get(file)!, "utf8");
    }
  }
  if (blocked) {
    throw new PatchError(
      "pre_validation_blocked",
      "patched book validates with errors; no files written",
      ops[ops.length - 1]!,
    );
  }

  return {
    files: chapters.map((chapter) => ({
      file: chapter.source,
      changed: touched.has(chapter.source),
    })),
    postDiagnostics,
  };
}

function retargetOp(op: PatchOp, rawId: string): PatchOp {
  switch (op.op) {
    case "rename_id":
      return { ...op, from: rawId };
    case "add_block":
      return { ...op, parent: rawId };
    case "add_comment":
    case "add_footnote":
    case "add_endnote":
    case "add_change_request":
      return { ...op, target: rawId };
    default:
      return { ...op, id: rawId };
  }
}
