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
    case "table": {
      const widths = node.header.map((h, i) =>
        Math.max(
          h.length,
          ...node.rows.map((r) => (r[i] ?? "").length),
          3,
        ),
      );
      const fmt = (cells: string[]) =>
        "| " +
        cells.map((c, i) => c.padEnd(widths[i] ?? c.length)).join(" | ") +
        " |";
      out.push(fmt(node.header));
      out.push(
        "| " +
          widths.map((w, i) => {
            const a = node.align[i];
            const dashes = "-".repeat(Math.max(3, w));
            if (a === "center") return `:${dashes.slice(0, -2)}-:`;
            if (a === "right") return `${dashes.slice(0, -1)}:`;
            if (a === "left") return `:${dashes.slice(0, -1)}`;
            return dashes;
          }).join(" | ") +
          " |",
      );
      for (const row of node.rows) out.push(fmt(row));
      out.push("");
      return;
    }
    case "directive":
      emitDirective(node, out, depth);
      return;
    case "frontmatter":
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

const VERBATIM_BODY = new Set(["diagram", "plotly", "math"]);

function emitDirective(node: DirectiveNode, out: string[], depth: number): void {
  if (node.name === "html" || node.name === "svg" || node.name === "script") {
    out.push(`[${node.name.toUpperCase()} escape-hatch block omitted from LLM context]`);
    out.push("");
    return;
  }
  const tag = node.name.toUpperCase();
  const attrs = Object.entries(node.attrs)
    .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
    .join(" ");
  out.push(`[${tag}${attrs ? " " + attrs : ""}]`);
  if (VERBATIM_BODY.has(node.name) && node.body !== undefined) {
    out.push(node.body);
  } else if (node.children.length === 0 && node.body !== undefined) {
    out.push(inlineToPlain(node.body));
  } else {
    for (const child of node.children) emit(child, out, depth + 1);
  }
  out.push(`[/${tag}]`);
  out.push("");
}
