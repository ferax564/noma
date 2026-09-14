import type { DocumentNode, Node, TableNode } from "./ast.js";
import { parse } from "./parser.js";
import { renderNoma } from "./renderer-noma.js";
import { assignPersistentIdentities, type IdentityFactory } from "./stable-identity.js";

export const EDITOR_SCHEMA_VERSION = 1;

export interface EditorMark {
  type: string;
  attrs?: Record<string, unknown>;
}

export interface EditorNode {
  type: string;
  attrs?: Record<string, unknown>;
  text?: string;
  marks?: EditorMark[];
  content?: EditorNode[];
}

export interface EditorDocument {
  type: "doc";
  attrs: { schemaVersion: number; unknownPreserved: true };
  content: EditorNode[];
}

export function nomaToEditor(doc: DocumentNode): EditorDocument {
  return {
    type: "doc",
    attrs: { schemaVersion: EDITOR_SCHEMA_VERSION, unknownPreserved: true },
    content: flattenNodes(doc.children),
  };
}

function flattenNodes(nodes: Node[]): EditorNode[] {
  const out: EditorNode[] = [];
  for (const node of nodes) {
    if (node.type === "section") {
      out.push({
        type: "heading",
        attrs: { level: node.level, id: node.id, aliases: node.aliases ?? [] },
        content: [{ type: "text", text: node.title }],
      });
      out.push(...flattenNodes(node.children));
    } else {
      out.push(nodeToEditor(node));
    }
  }
  return out;
}

export function editorToNoma(editor: EditorDocument, meta: Record<string, unknown> = {}): DocumentNode {
  if (editor.attrs.schemaVersion > EDITOR_SCHEMA_VERSION) {
    throw new Error("incompatible editor schema");
  }
  const source = editor.content.map(editorNodeToSource).join("\n\n");
  return parse(source ? `${source}\n` : "\n", { filename: typeof meta.filename === "string" ? meta.filename : undefined });
}

export function visualRoundTrip(source: string, factory?: IdentityFactory): {
  source: string;
  doc: DocumentNode;
  editor: EditorDocument;
} {
  const parsed = parse(source);
  assignPersistentIdentities(parsed, factory ? { factory } : undefined);
  const editor = nomaToEditor(parsed);
  const back = editorToNoma(editor, parsed.meta);
  assignPersistentIdentities(back, factory ? { factory } : undefined);
  return { source: renderNoma(back), doc: back, editor };
}

function nodeToEditor(node: Node): EditorNode {
  switch (node.type) {
    case "document":
      return { type: "doc", content: node.children.map(nodeToEditor) };
    case "frontmatter":
      return { type: "nomaFrontmatter", attrs: { raw: node.raw, data: node.data } };
    case "section":
      return {
        type: "heading",
        attrs: { level: node.level, id: node.id, aliases: node.aliases ?? [] },
        content: [{ type: "text", text: node.title }],
      };
    case "paragraph":
      return {
        type: "paragraph",
        attrs: { id: node.id },
        content: [{ type: "text", text: node.content }],
      };
    case "code":
      return { type: "codeBlock", attrs: { id: node.id, lang: node.lang }, content: [{ type: "text", text: node.content }] };
    case "list":
      return {
        type: node.ordered ? "orderedList" : "bulletList",
        attrs: { id: node.id },
        content: node.items.map((item) => ({
          type: "listItem",
          attrs: { id: item.id },
          content: [{ type: "paragraph", content: [{ type: "text", text: item.content }] }],
        })),
      };
    case "list_item":
      return { type: "listItem", attrs: { id: node.id }, content: [{ type: "text", text: node.content }] };
    case "quote":
      return { type: "blockquote", attrs: { id: node.id }, content: [{ type: "text", text: node.content }] };
    case "thematic_break":
      return { type: "horizontalRule", attrs: { id: node.id } };
    case "table":
      return tableToEditor(node);
    case "directive":
      return {
        type: "nomaUnknown",
        attrs: {
          name: node.name,
          id: node.id,
          nomaAttrs: node.attrs,
          body: node.body,
          source: renderDirectiveSource(node),
        },
        content: node.children.map(nodeToEditor),
      };
    default: {
      const _exhaustive: never = node;
      void _exhaustive;
      return { type: "nomaUnknown", attrs: { name: "unknown" } };
    }
  }
}

function tableToEditor(node: TableNode): EditorNode {
  const header = {
    type: "tableRow",
    attrs: { kind: "header" },
    content: node.header.map((cell, i) => ({
      type: "tableHeader",
      attrs: { id: node.headerIds?.[i], columnId: node.columnIds?.[i] },
      content: [{ type: "text", text: cell }],
    })),
  };
  const rows = node.rows.map((row, r) => ({
    type: "tableRow",
    attrs: { id: node.rowIds?.[r] },
    content: row.map((cell, c) => ({
      type: "tableCell",
      attrs: { id: node.cellIds?.[r]?.[c], columnId: node.columnIds?.[c] },
      content: [{ type: "text", text: cell }],
    })),
  }));
  return {
    type: "table",
    attrs: { id: node.id, align: node.align, columnIds: node.columnIds, rowIds: node.rowIds },
    content: [header, ...rows],
  };
}

function editorNodeToSource(node: EditorNode): string {
  switch (node.type) {
    case "nomaFrontmatter":
      return `---\n${String(node.attrs?.raw ?? "")}\n---`;
    case "heading": {
      const level = Number(node.attrs?.level ?? 1);
      const title = textOf(node);
      const id = typeof node.attrs?.id === "string" ? node.attrs.id : undefined;
      const aliases = Array.isArray(node.attrs?.aliases) ? (node.attrs.aliases as string[]).join(",") : "";
      const extra = [id ? `id="${id}"` : "", aliases ? `aliases="${aliases}"` : ""].filter(Boolean).join(" ");
      return `${"#".repeat(level)} ${title}${extra ? ` {${extra}}` : ""}`;
    }
    case "paragraph":
      return (typeof node.attrs?.id === "string" ? `{#${node.attrs.id}}\n` : "") + textOf(node);
    case "codeBlock": {
      const lang = typeof node.attrs?.lang === "string" ? node.attrs.lang : "";
      const prefix = typeof node.attrs?.id === "string" ? `{#${node.attrs.id}}\n` : "";
      return `${prefix}\`\`\`${lang}\n${textOf(node)}\n\`\`\``;
    }
    case "bulletList":
    case "orderedList": {
      const prefix = typeof node.attrs?.id === "string" ? `{#${node.attrs.id}}\n` : "";
      const lines = (node.content ?? []).map((item, i) => {
        const id = typeof item.attrs?.id === "string" ? `{#${item.attrs.id}} ` : "";
        const marker = node.type === "orderedList" ? `${i + 1}.` : "-";
        return `${marker} ${id}${textOf(item)}`;
      });
      return prefix + lines.join("\n");
    }
    case "blockquote": {
      const prefix = typeof node.attrs?.id === "string" ? `{#${node.attrs.id}}\n` : "";
      return prefix + textOf(node).split("\n").map((line) => `> ${line}`).join("\n");
    }
    case "horizontalRule":
      return "---";
    case "table":
      return tableToSource(node);
    case "nomaUnknown":
      return String(node.attrs?.source ?? `::${String(node.attrs?.name ?? "unknown")}\n::`);
    default:
      return textOf(node);
  }
}

function tableToSource(node: EditorNode): string {
  const id = typeof node.attrs?.id === "string" ? node.attrs.id : undefined;
  const columnIds = Array.isArray(node.attrs?.columnIds) ? (node.attrs.columnIds as string[]) : [];
  const rowIds = Array.isArray(node.attrs?.rowIds) ? (node.attrs.rowIds as string[]) : [];
  const rows = node.content ?? [];
  const header = rows[0]?.content ?? [];
  const body = rows.slice(1);
  const fmtCell = (cell: EditorNode | undefined): string => {
    const cellId = typeof cell?.attrs?.id === "string" ? cell.attrs.id : undefined;
    const text = textOf(cell);
    return cellId ? `{#${cellId}} ${text}` : text;
  };
  const headerLine = `| ${header.map((cell) => fmtCell(cell)).join(" | ")} |`;
  const sep = `| ${header.map(() => "---").join(" | ")} |`;
  const bodyLines = body.map((row) => `| ${(row.content ?? []).map((cell) => fmtCell(cell)).join(" | ")} |`);
  const marker = id
    ? `{#${id}${columnIds.length ? ` cols="${columnIds.join(",")}"` : ""}${rowIds.length ? ` rows="${rowIds.join(",")}"` : ""}}`
    : undefined;
  return [marker, headerLine, sep, ...bodyLines].filter(Boolean).join("\n");
}

function textOf(node: EditorNode | undefined): string {
  if (!node) return "";
  if (node.text) return node.text;
  return (node.content ?? []).map((child) => textOf(child)).join("");
}

function renderDirectiveSource(node: Extract<Node, { type: "directive" }>): string {
  const attrs = Object.entries(node.attrs)
    .map(([key, value]) => (value === true ? key : `${key}=${JSON.stringify(value)}`))
    .join(" ");
  const open = `::${node.name}${attrs ? `{${attrs}}` : ""}`;
  if (node.children.length === 0) {
    return node.body ? `${open}\n${node.body}\n::` : `${open}\n::`;
  }
  return `${open}\n${node.children.map((child) => editorNodeToSource(nodeToEditor(child))).join("\n\n")}\n::`;
}

export function incompatibleEditorIsReadonly(clientSchema: number): boolean {
  return clientSchema !== EDITOR_SCHEMA_VERSION;
}
