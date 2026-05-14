import type { DocumentNode, Node } from "./ast.js";
import { walk } from "./ast.js";

export interface IdRecord {
  id: string;
  type: Node["type"];
  name?: string;
  title?: string;
  aliases?: string[];
  line?: number;
}

export interface IdRegistry {
  ids: string[];
  aliases: Record<string, string>;
  records: IdRecord[];
}

export function collectIdRegistry(doc: DocumentNode): IdRegistry {
  const ids: string[] = [];
  const aliases: Record<string, string> = {};
  const records: IdRecord[] = [];

  for (const node of walk(doc)) {
    if (!node.id) continue;
    ids.push(node.id);
    const record: IdRecord = {
      id: node.id,
      type: node.type,
      ...(node.aliases && node.aliases.length > 0 ? { aliases: node.aliases } : {}),
      ...(node.pos?.line ? { line: node.pos.line } : {}),
    };
    if (node.type === "directive") record.name = node.name;
    if (node.type === "section") record.title = node.title;
    records.push(record);
    for (const alias of node.aliases ?? []) {
      aliases[alias] = node.id;
    }
  }

  return { ids, aliases, records };
}
