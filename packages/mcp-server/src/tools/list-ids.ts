import { readFileSync } from "node:fs";
import { parse, isBookManifestPath } from "@ferax564/noma-cli";
import type { Node } from "@ferax564/noma-cli";

export interface ListIdsResult {
  ids: string[];
  aliases: Record<string, string>;
}

export function listIds(file: string): ListIdsResult {
  if (isBookManifestPath(file)) {
    throw new Error("book manifests are not supported by list_ids — use the CLI");
  }
  const source = readFileSync(file, "utf8");
  const doc = parse(source);
  const ids: string[] = [];
  const aliases: Record<string, string> = {};
  collectIds(doc.children, ids, aliases);
  return { ids, aliases };
}

function nodeChildren(node: Node): Node[] {
  if (node.type === "list") return node.items as unknown as Node[];
  if ("children" in node) return (node as { children: Node[] }).children;
  return [];
}

function collectIds(nodes: Node[], ids: string[], aliases: Record<string, string>): void {
  for (const node of nodes) {
    if (node.id) {
      ids.push(node.id);
      for (const alias of node.aliases ?? []) {
        aliases[alias] = node.id;
      }
    }
    collectIds(nodeChildren(node), ids, aliases);
  }
}
