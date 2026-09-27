/**
 * Validates a directory of `.noma` files as one space — a wiki directory synced to a Noma Cloud
 * space, where `[[id]]` links resolve to whichever page defines that ID. Each file is validated on
 * its own, with the IDs of the other pages passed as `spaceIds`, and an ID defined on two pages is
 * reported because a space-wide link to it is ambiguous.
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import type { Diagnostic, DocumentNode } from "./ast.js";
import { walk } from "./ast.js";
import { parse } from "./parser.js";
import { validate, type ValidateOptions } from "./validator.js";

export interface SpaceFileResult {
  /** Path relative to the space directory, with `/` separators. */
  path: string;
  diagnostics: Diagnostic[];
}

export interface SpacePage {
  path: string;
  doc: DocumentNode;
}

/** Lists the `.noma` files of a space directory (dot entries and `node_modules` skipped), sorted. */
export function spaceFiles(dir: string): string[] {
  const files: string[] = [];
  const walkDir = (current: string): void => {
    for (const entry of readdirSync(current).sort()) {
      if (entry.startsWith(".") || entry === "node_modules") continue;
      const path = join(current, entry);
      const stats = statSync(path);
      if (stats.isDirectory()) walkDir(path);
      else if (stats.isFile() && entry.endsWith(".noma")) files.push(relative(dir, path).split(sep).join("/"));
    }
  };
  walkDir(dir);
  return files;
}

/** Validates parsed pages as one space. Pure: the caller does the reading. */
export function validateSpace(pages: SpacePage[], options: ValidateOptions = {}): SpaceFileResult[] {
  const idOwners = new Map<string, string[]>();
  const keysByPage = new Map<string, Set<string>>();
  for (const page of pages) {
    const keys = new Set<string>();
    for (const node of walk(page.doc)) {
      for (const key of nodeKeys(node)) {
        keys.add(key);
        const owners = idOwners.get(key) ?? [];
        if (!owners.includes(page.path)) owners.push(page.path);
        idOwners.set(key, owners);
      }
    }
    keysByPage.set(page.path, keys);
  }

  return pages.map((page) => {
    const spaceIds = new Set<string>();
    for (const [path, keys] of keysByPage) {
      if (path === page.path) continue;
      for (const key of keys) spaceIds.add(key);
    }
    const diagnostics = validate(page.doc, { ...options, spaceIds });
    const duplicates: Diagnostic[] = [];
    for (const node of walk(page.doc)) {
      for (const key of nodeKeys(node)) {
        const owners = idOwners.get(key);
        if (!owners || owners.length < 2) continue;
        const others = owners.filter((path) => path !== page.path);
        const kind = key === node.id ? "ID" : "Alias";
        duplicates.push({
          severity: "warning",
          code: "duplicate-space-id",
          message: `${kind} "${key}" is also an ID or alias in ${others.join(", ")}; a [[${key}]] link in this space is ambiguous.`,
          ...(node.pos ? { pos: node.pos } : {}),
          ...(node.id ? { nodeId: node.id } : {}),
        });
      }
    }
    const ignored = new Set(options.ignoreRules ?? []);
    return { path: page.path, diagnostics: [...diagnostics, ...duplicates.filter((d) => !ignored.has(d.code))] };
  });
}

/** Reads every `.noma` file under `dir` and validates them as one space. */
export function checkSpaceDirectory(dir: string, options: ValidateOptions = {}): SpaceFileResult[] {
  const pages = spaceFiles(dir).map((path) => ({ path, doc: parse(readFileSync(join(dir, path), "utf8"), { filename: join(dir, path) }) }));
  return validateSpace(pages, options);
}

function nodeKeys(node: { id?: string; aliases?: string[] }): string[] {
  return [...new Set([...(node.id ? [node.id] : []), ...(node.aliases ?? [])])];
}
