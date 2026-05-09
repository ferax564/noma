import type { DirectiveNode, DocumentNode, Node, SectionNode } from "./ast.js";
import { inlineToPlain } from "./inline.js";

/**
 * Deterministic plain-text export designed for LLM context windows.
 * Stable line ordering, explicit semantic tags, no HTML noise.
 */
export function renderLlm(doc: DocumentNode): string {
  const out: string[] = [];
  if (doc.meta.title) out.push(`# ${String(doc.meta.title)}`);
  for (const child of doc.children) emit(child, out, 0);
  return out.join("\n").replace(/\n{3,}/g, "\n\n").trim() + "\n";
}

function emit(node: Node, out: string[], depth: number): void {
  switch (node.type) {
    case "document":
      for (const child of node.children) emit(child, out, depth);
      return;
    case "section":
      emitSection(node, out, depth);
      return;
    case "paragraph":
      out.push(inlineToPlain(node.content));
      out.push("");
      return;
    case "code":
      out.push("```" + (node.lang ?? ""));
      out.push(node.content);
      out.push("```");
      out.push("");
      return;
    case "list":
      for (const item of node.items) {
        out.push(`- ${inlineToPlain(item.content)}`);
      }
      out.push("");
      return;
    case "list_item":
      out.push(`- ${inlineToPlain(node.content)}`);
      return;
    case "quote":
      for (const line of node.content.split("\n")) out.push(`> ${line}`);
      out.push("");
      return;
    case "thematic_break":
      out.push("---");
      out.push("");
      return;
    case "directive":
      emitDirective(node, out, depth);
      return;
    default: {
      const _exhaustive: never = node;
      void _exhaustive;
    }
  }
}

function emitSection(node: SectionNode, out: string[], depth: number): void {
  const hashes = "#".repeat(node.level);
  out.push(`${hashes} ${node.title}${node.id ? `  [#${node.id}]` : ""}`);
  out.push("");
  for (const child of node.children) emit(child, out, depth);
}

function emitDirective(node: DirectiveNode, out: string[], depth: number): void {
  const tag = node.name.toUpperCase();
  const attrs = Object.entries(node.attrs)
    .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
    .join(" ");
  out.push(`[${tag}${attrs ? " " + attrs : ""}]`);
  if (node.children.length === 0 && node.body !== undefined) {
    out.push(inlineToPlain(node.body));
  } else {
    for (const child of node.children) emit(child, out, depth + 1);
  }
  out.push(`[/${tag}]`);
  out.push("");
}
