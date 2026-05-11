import { readFileSync } from "node:fs";
import { parse, isBookManifestPath } from "@noma/cli";
import type { AttrValue, Node } from "@noma/cli";

export interface BlockSummary {
  id?: string;
  type: string;
  name?: string;
  attrs?: Record<string, AttrValue>;
  title?: string;
  level?: number;
  aliases?: string[];
  childCount: number;
  lines: [number, number];
  patchable: boolean;
}

export function readDoc(file: string): BlockSummary[] {
  if (isBookManifestPath(file)) {
    throw new Error("book manifests are not supported by read_doc — use the CLI");
  }
  const source = readFileSync(file, "utf8");
  const doc = parse(source);
  const summaries: BlockSummary[] = [];
  collectBlocks(doc.children, summaries);
  return summaries;
}

function nodeChildren(node: Node): Node[] {
  if (node.type === "list") return node.items as unknown as Node[];
  if ("children" in node) return (node as { children: Node[] }).children;
  return [];
}

function collectBlocks(nodes: Node[], out: BlockSummary[]): void {
  for (const node of nodes) {
    const startLine = node.pos?.line ?? 1;
    const endLine = node.endLine ?? startLine;
    const children = nodeChildren(node);
    const base: BlockSummary = {
      type: node.type,
      childCount: children.length,
      lines: [startLine, endLine],
      patchable: typeof node.id === "string" && node.id.length > 0,
    };
    if (node.id) base.id = node.id;
    if (node.aliases?.length) base.aliases = node.aliases;

    if (node.type === "section") {
      base.title = node.title;
      base.level = node.level;
    } else if (node.type === "directive") {
      base.name = node.name;
      // exclude id — already surfaced in base.id
      const { id: _id, ...rest } = node.attrs ?? {};
      base.attrs = rest as Record<string, AttrValue>;
    }

    out.push(base);
    collectBlocks(children, out);
  }
}
