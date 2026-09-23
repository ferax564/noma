/** ProseMirror schema for the visual editor, generated from the shared `src/editor-model.ts` specs. */
import { type DOMOutputSpec, type MarkSpec, type NodeSpec, Schema, type Node as PMNode, type Mark as PMMark } from "@tiptap/pm/model";
import { EDITOR_MARK_SPECS, EDITOR_NODE_SPECS, type EditorAttrs } from "../../src/editor-model.js";
import { safeHref } from "../../src/inline.js";

type DomAttrs = Record<string, string>;

function dataAttrs(node: PMNode, keys: string[]): DomAttrs {
  const out: DomAttrs = {};
  for (const key of keys) {
    const value = node.attrs[key] as unknown;
    if (value === null || value === undefined) continue;
    out[`data-${key}`] = typeof value === "string" ? value : JSON.stringify(value);
  }
  return out;
}

function readData(element: HTMLElement, defaults: EditorAttrs): EditorAttrs {
  const attrs: EditorAttrs = {};
  for (const [key, fallback] of Object.entries(defaults)) {
    const raw = element.getAttribute(`data-${key}`);
    if (raw === null) {
      attrs[key] = fallback;
      continue;
    }
    if (typeof fallback === "number") attrs[key] = Number(raw) || fallback;
    else if (key === "checked") attrs[key] = raw === "true" ? true : raw === "false" ? false : null;
    else if (key === "level") attrs[key] = Number(raw) || 1;
    else attrs[key] = raw;
  }
  return attrs;
}

function toDom(name: string, node: PMNode): DOMOutputSpec {
  const keys = Object.keys(EDITOR_NODE_SPECS[name]?.attrs ?? {});
  const data = dataAttrs(node, keys);
  switch (name) {
    case "paragraph":
      return ["p", data, 0];
    case "heading":
      return [`h${Math.max(1, Math.min(6, Number(node.attrs.level) || 1))}`, data, 0];
    case "blockquote":
      return ["blockquote", data, 0];
    case "bullet_list":
      return ["ul", data, 0];
    case "ordered_list":
      return ["ol", data, 0];
    case "list_item":
      return ["li", { ...data, class: node.attrs.checked === null ? "" : "nv-task" }, 0];
    case "code_block":
      return ["pre", { ...data, class: "nv-code" }, ["code", 0]];
    case "horizontal_rule":
      return ["hr", data];
    case "table":
      return ["table", { ...data, class: "nv-table" }, ["tbody", 0]];
    case "table_row":
      return ["tr", 0];
    case "table_header":
      return ["th", data, 0];
    case "table_cell":
      return ["td", data, 0];
    case "directive":
      return ["div", { ...data, class: `nv-directive nv-directive-${String(node.attrs.name).replace(/[^\w-]/g, "")}` }, 0];
    case "text_directive":
      return ["pre", { ...data, class: "nv-text-directive" }, ["code", 0]];
    case "raw":
      return ["pre", { ...data, class: "nv-raw" }, String(node.attrs.src ?? "")];
    case "frontmatter":
      return ["pre", { ...data, class: "nv-frontmatter" }, String(node.attrs.src ?? "")];
    case "hard_break":
      return ["br"];
    case "wikilink":
      return ["span", { ...data, class: "nv-wikilink" }, wikilinkLabel(String(node.attrs.raw ?? ""))];
    case "math_inline":
      return ["span", { ...data, class: "nv-math-inline" }, String(node.attrs.tex ?? "")];
    default:
      return ["div", data, 0];
  }
}

export function wikilinkLabel(raw: string): string {
  const pipe = raw.indexOf("|");
  return (pipe >= 0 ? raw.slice(pipe + 1) : raw).trim() || raw;
}

function parseRules(name: string): NodeSpec["parseDOM"] {
  const defaults = EDITOR_NODE_SPECS[name]?.attrs ?? {};
  const getAttrs = (element: HTMLElement | string): EditorAttrs => (typeof element === "string" ? { ...defaults } : readData(element, defaults));
  switch (name) {
    case "paragraph":
      return [{ tag: "p", getAttrs }];
    case "heading":
      return [1, 2, 3, 4, 5, 6].map((level) => ({ tag: `h${level}`, getAttrs: (element: HTMLElement | string) => ({ ...getAttrs(element), level }) }));
    case "blockquote":
      return [{ tag: "blockquote", getAttrs }];
    case "bullet_list":
      return [{ tag: "ul", getAttrs }];
    case "ordered_list":
      return [{ tag: "ol", getAttrs }];
    case "list_item":
      return [{ tag: "li", getAttrs }];
    case "code_block":
      return [{ tag: "pre.nv-code", preserveWhitespace: "full", getAttrs }, { tag: "pre", preserveWhitespace: "full" }];
    case "horizontal_rule":
      return [{ tag: "hr", getAttrs }];
    case "table":
      return [{ tag: "table", getAttrs }];
    case "table_row":
      return [{ tag: "tr" }];
    case "table_header":
      return [{ tag: "th", getAttrs }];
    case "table_cell":
      return [{ tag: "td", getAttrs }];
    case "directive":
      return [{ tag: "div.nv-directive", getAttrs }];
    case "text_directive":
      return [{ tag: "pre.nv-text-directive", preserveWhitespace: "full", getAttrs }];
    case "raw":
      return [{ tag: "pre.nv-raw", getAttrs }];
    case "frontmatter":
      return [{ tag: "pre.nv-frontmatter", getAttrs }];
    case "hard_break":
      return [{ tag: "br" }];
    case "wikilink":
      return [{ tag: "span.nv-wikilink", getAttrs }];
    case "math_inline":
      return [{ tag: "span.nv-math-inline", getAttrs }];
    default:
      return [];
  }
}

function nodeSpec(name: string): NodeSpec {
  const spec = EDITOR_NODE_SPECS[name]!;
  const out: NodeSpec = {
    attrs: Object.fromEntries(Object.entries(spec.attrs).map(([key, value]) => [key, { default: value }])),
  };
  if (spec.content) out.content = spec.content;
  if (spec.group) out.group = spec.group;
  if (spec.inline) out.inline = true;
  if (spec.atom) out.atom = true;
  if (spec.code) out.code = true;
  if (spec.marks !== undefined) out.marks = spec.marks;
  if (spec.defining) out.defining = true;
  if (spec.isolating) out.isolating = true;
  if (spec.tableRole) out.tableRole = spec.tableRole;
  if (name === "text") return { group: "inline" };
  if (name === "doc") return { content: spec.content };
  if (spec.atom && !spec.inline) out.selectable = true;
  out.toDOM = (node: PMNode) => toDom(name, node);
  out.parseDOM = parseRules(name);
  return out;
}

function markSpec(name: string): MarkSpec {
  const spec = EDITOR_MARK_SPECS[name]!;
  const out: MarkSpec = {
    attrs: Object.fromEntries(Object.entries(spec.attrs).map(([key, value]) => [key, { default: value }])),
  };
  if (spec.inclusive !== undefined) out.inclusive = spec.inclusive;
  switch (name) {
    case "link":
      out.toDOM = (mark: PMMark) => ["a", { href: safeHref(String(mark.attrs.href ?? "")), rel: "noopener noreferrer", title: String(mark.attrs.href ?? "") }, 0];
      out.parseDOM = [{ tag: "a[href]", getAttrs: (element: HTMLElement | string) => (typeof element === "string" ? {} : { href: element.getAttribute("href") ?? "" }) }];
      break;
    case "strong":
      out.toDOM = () => ["strong", 0];
      out.parseDOM = [{ tag: "strong" }, { tag: "b" }];
      break;
    case "em":
      out.toDOM = () => ["em", 0];
      out.parseDOM = [{ tag: "em" }, { tag: "i" }];
      break;
    case "code":
      out.toDOM = () => ["code", 0];
      out.parseDOM = [{ tag: "code" }];
      break;
  }
  return out;
}

/** The visual-editor schema; node and mark names match the Noma editor model 1:1. */
export const visualSchema = new Schema({
  nodes: Object.fromEntries(Object.keys(EDITOR_NODE_SPECS).map((name) => [name, nodeSpec(name)])),
  marks: Object.fromEntries(Object.keys(EDITOR_MARK_SPECS).map((name) => [name, markSpec(name)])),
});
