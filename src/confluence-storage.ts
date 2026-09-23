/**
 * Confluence storage format (XHTML + `ac:`/`ri:` macros) → `.noma` source.
 *
 * A small tolerant XML tokenizer builds a bounded element tree, which is then
 * converted block by block: headings, paragraphs, lists, task lists, tables,
 * code/noformat, info/note/warning/tip/panel callouts, expand, status, page
 * links (→ wikilinks), images (→ figures), excerpt/include/children/jira/page
 * properties (→ Noma wiki macros). Anything else is kept as readable text and
 * listed in the loss report. Entities are never expanded beyond the fixed
 * HTML set, so DOCTYPE/ENTITY declarations have no effect.
 */
import yaml from "js-yaml";
import { escapePipeTableCell } from "./inline.js";
import { slugify } from "./parser.js";

export const MAX_STORAGE_BYTES = 5_000_000;
const MAX_NODES = 250_000;
const MAX_DEPTH = 200;
const ZWSP = "\u200b";

interface XmlElement {
  kind: "element";
  name: string;
  attrs: Record<string, string>;
  children: XmlNode[];
}

interface XmlText {
  kind: "text";
  text: string;
  cdata?: boolean;
}

type XmlNode = XmlElement | XmlText;

export interface ConfluenceLossEntry {
  macro: string;
  count: number;
}

export interface ConfluenceAttachmentRef {
  filename: string;
  pageId?: string;
  url: string;
}

export interface ConfluencePageMeta {
  title: string;
  pageId?: string;
  spaceKey?: string;
  /** Site base URL, used to build attachment and page URLs. */
  baseUrl?: string;
  url?: string;
  author?: string;
  createdAt?: string;
  updatedAt?: string;
  version?: number | string;
  labels?: string[];
}

export interface ConfluenceConversion {
  source: string;
  loss: ConfluenceLossEntry[];
  attachments: ConfluenceAttachmentRef[];
}

const VOID_ELEMENTS = new Set(["br", "hr", "img", "col", "meta", "link", "input", "wbr", "area", "base", "source"]);
const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
  ndash: "–",
  mdash: "—",
  hellip: "…",
  lsquo: "‘",
  rsquo: "’",
  ldquo: "“",
  rdquo: "”",
  laquo: "«",
  raquo: "»",
  copy: "©",
  reg: "®",
  trade: "™",
  bull: "•",
  middot: "·",
  times: "×",
  divide: "÷",
  rarr: "→",
  larr: "←",
  uarr: "↑",
  darr: "↓",
  harr: "↔",
  deg: "°",
  plusmn: "±",
  euro: "€",
  pound: "£",
  yen: "¥",
  sect: "§",
  para: "¶",
  shy: "",
  zwj: "",
  zwnj: "",
};

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-fA-F]{1,6}|#[0-9]{1,7}|[a-zA-Z][a-zA-Z0-9]{1,31});/g, (match, body: string) => {
    if (body.startsWith("#x") || body.startsWith("#X")) return codePoint(Number.parseInt(body.slice(2), 16), match);
    if (body.startsWith("#")) return codePoint(Number.parseInt(body.slice(1), 10), match);
    return NAMED_ENTITIES[body] ?? match;
  });
}

function codePoint(value: number, fallback: string): string {
  if (!Number.isFinite(value) || value <= 0 || value > 0x10ffff || (value >= 0xd800 && value <= 0xdfff)) return fallback;
  return String.fromCodePoint(value);
}

/** Tolerant XHTML tokenizer: unknown/mismatched tags never throw, and the tree is size- and depth-bounded. */
export function parseStorageXml(input: string): XmlElement {
  if (input.length > MAX_STORAGE_BYTES) throw new Error("Confluence page body is too large");
  const root: XmlElement = { kind: "element", name: "#root", attrs: {}, children: [] };
  const stack: XmlElement[] = [root];
  let index = 0;
  let nodes = 0;
  const top = (): XmlElement => stack[stack.length - 1]!;
  const pushText = (text: string, cdata = false): void => {
    if (!text) return;
    const parent = top();
    const last = parent.children[parent.children.length - 1];
    if (last?.kind === "text" && !cdata && !last.cdata) last.text += text;
    else parent.children.push({ kind: "text", text, ...(cdata ? { cdata: true } : {}) });
  };
  while (index < input.length) {
    const lt = input.indexOf("<", index);
    if (lt === -1) {
      pushText(decodeEntities(input.slice(index)));
      break;
    }
    if (lt > index) pushText(decodeEntities(input.slice(index, lt)));
    if (input.startsWith("<!--", lt)) {
      const end = input.indexOf("-->", lt + 4);
      index = end === -1 ? input.length : end + 3;
      continue;
    }
    if (input.startsWith("<![CDATA[", lt)) {
      const end = input.indexOf("]]>", lt + 9);
      pushText(input.slice(lt + 9, end === -1 ? input.length : end), true);
      index = end === -1 ? input.length : end + 3;
      continue;
    }
    if (input.startsWith("<!", lt) || input.startsWith("<?", lt)) {
      const end = input.indexOf(">", lt + 2);
      index = end === -1 ? input.length : end + 1;
      continue;
    }
    const end = findTagEnd(input, lt + 1);
    if (end === -1) {
      pushText(decodeEntities(input.slice(lt)));
      break;
    }
    const raw = input.slice(lt + 1, end);
    index = end + 1;
    if (raw.startsWith("/")) {
      const name = raw.slice(1).trim().toLowerCase();
      for (let depth = stack.length - 1; depth > 0; depth--) {
        if (stack[depth]!.name === name) {
          stack.length = depth;
          break;
        }
      }
      continue;
    }
    const selfClosing = raw.endsWith("/");
    const body = selfClosing ? raw.slice(0, -1) : raw;
    const nameMatch = /^([A-Za-z_][\w:.-]*)/.exec(body.trim());
    if (!nameMatch) {
      pushText(decodeEntities(`<${raw}>`));
      continue;
    }
    if (++nodes > MAX_NODES) throw new Error("Confluence page body has too many elements");
    const name = nameMatch[1]!.toLowerCase();
    const element: XmlElement = { kind: "element", name, attrs: parseXmlAttrs(body.trim().slice(nameMatch[1]!.length)), children: [] };
    top().children.push(element);
    if (!selfClosing && !VOID_ELEMENTS.has(name) && stack.length < MAX_DEPTH) stack.push(element);
  }
  return root;
}

function findTagEnd(input: string, from: number): number {
  let quote: string | undefined;
  for (let index = from; index < input.length; index++) {
    const char = input[index];
    if (quote) {
      if (char === quote) quote = undefined;
    } else if (char === '"' || char === "'") quote = char;
    else if (char === ">") return index;
    else if (char === "<") return -1;
  }
  return -1;
}

function parseXmlAttrs(raw: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  for (const match of raw.matchAll(/([A-Za-z_][\w:.-]*)\s*(?:=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g)) {
    attrs[match[1]!.toLowerCase()] = decodeEntities(match[3] ?? match[4] ?? match[5] ?? "");
  }
  return attrs;
}

interface ConvertContext {
  meta: ConfluencePageMeta;
  loss: Map<string, number>;
  attachments: ConfluenceAttachmentRef[];
  usedIds: Set<string>;
}

/** Convert one Confluence page (storage-format body plus metadata) into `.noma` source. */
export function convertConfluencePage(storage: string, meta: ConfluencePageMeta): ConfluenceConversion {
  const ctx: ConvertContext = { meta, loss: new Map(), attachments: [], usedIds: new Set() };
  const titleId = uniqueId(ctx, slugify(meta.title) || "page");
  const body = convertBlocks(parseStorageXml(storage).children, ctx, 2).join("\n\n");
  const frontmatter = confluenceFrontmatter(meta);
  const heading = `# ${headingText(meta.title) || "Untitled Page"} {id="${titleId}"}`;
  const source = `${frontmatter}\n\n${heading}\n${body ? `\n${body}\n` : ""}`;
  return {
    source,
    loss: [...ctx.loss].map(([macro, count]) => ({ macro, count })).sort((a, b) => b.count - a.count || a.macro.localeCompare(b.macro)),
    attachments: ctx.attachments,
  };
}

function confluenceFrontmatter(meta: ConfluencePageMeta): string {
  const confluence: Record<string, unknown> = {};
  if (meta.pageId) confluence.id = String(meta.pageId);
  if (meta.spaceKey) confluence.space = meta.spaceKey;
  if (meta.url) confluence.url = meta.url;
  if (meta.author) confluence.author = meta.author;
  if (meta.createdAt) confluence.created = meta.createdAt;
  if (meta.updatedAt) confluence.updated = meta.updatedAt;
  if (meta.version !== undefined) confluence.version = String(meta.version);
  const data: Record<string, unknown> = { source: "confluence", confluence };
  if (meta.labels && meta.labels.length > 0) data.labels = meta.labels;
  return `---\n${yaml.dump(data, { lineWidth: -1, noRefs: true }).trimEnd()}\n---`;
}

const INLINE_ELEMENTS = new Set([
  "a",
  "abbr",
  "b",
  "big",
  "br",
  "cite",
  "code",
  "del",
  "dfn",
  "em",
  "font",
  "i",
  "ins",
  "kbd",
  "mark",
  "q",
  "s",
  "samp",
  "small",
  "span",
  "strike",
  "strong",
  "sub",
  "sup",
  "time",
  "tt",
  "u",
  "var",
  "ac:link",
  "ac:emoticon",
  "ac:placeholder",
  "ac:inline-comment-marker",
  "ri:page",
  "ri:user",
  "ri:attachment",
  "ri:url",
]);
const INLINE_MACROS = new Set(["status", "anchor"]);

function isInline(node: XmlNode): boolean {
  if (node.kind === "text") return true;
  if (INLINE_ELEMENTS.has(node.name)) return true;
  if (node.name === "ac:structured-macro" || node.name === "ac:macro") return INLINE_MACROS.has(macroName(node));
  return false;
}

function convertBlocks(nodes: XmlNode[], ctx: ConvertContext, depth: number): string[] {
  const blocks: string[] = [];
  let run: XmlNode[] = [];
  const flush = (): void => {
    if (run.length === 0) return;
    const paragraph = paragraphText(run, ctx);
    if (paragraph) blocks.push(paragraph);
    run = [];
  };
  for (const node of nodes) {
    if (isInline(node)) {
      run.push(node);
      continue;
    }
    flush();
    blocks.push(...convertBlock(node as XmlElement, ctx, depth));
  }
  flush();
  return blocks.filter((block) => block.trim().length > 0);
}

function convertBlock(element: XmlElement, ctx: ConvertContext, depth: number): string[] {
  const name = element.name;
  const heading = /^h([1-6])$/.exec(name);
  if (heading) {
    const text = headingText(inlineText(element.children, ctx, { singleLine: true }));
    if (!text) return [];
    const level = Math.min(6, Number(heading[1]) + 1);
    return [`${"#".repeat(level)} ${text} {id="${uniqueId(ctx, slugify(text) || "section")}"}`];
  }
  switch (name) {
    case "p": {
      const paragraph = paragraphText(element.children.filter((child) => !(child.kind === "element" && child.name === "ac:image")), ctx);
      const figures = element.children.filter((child): child is XmlElement => child.kind === "element" && child.name === "ac:image").map((image) => figureBlock(image, ctx, depth));
      return [paragraph, ...figures].filter(Boolean);
    }
    case "ul":
    case "ol":
      return [listBlock(element, ctx, name === "ol")];
    case "ac:task-list":
      return [taskListBlock(element, ctx)];
    case "table":
      return [tableBlock(element, ctx)];
    case "pre":
      return [codeFence(textContent(element), undefined)];
    case "blockquote":
      return [
        convertBlocks(element.children, ctx, depth)
          .join("\n\n")
          .split("\n")
          .map((line) => (line.trim() ? `> ${line}` : ">"))
          .join("\n"),
      ];
    case "hr":
      return ["---"];
    case "ac:image":
      return [figureBlock(element, ctx, depth)];
    case "ac:structured-macro":
    case "ac:macro":
      return convertMacro(element, ctx, depth);
    case "ac:layout":
    case "ac:layout-section":
    case "ac:layout-cell":
    case "ac:rich-text-body":
    case "div":
    case "section":
    case "article":
    case "main":
    case "header":
    case "footer":
    case "center":
    case "tbody":
    case "thead":
    case "li":
      return convertBlocks(element.children, ctx, depth);
    case "ac:adf-extension":
    case "ac:adf-node":
    case "ac:adf-content":
      countLoss(ctx, "adf-extension");
      return convertBlocks(element.children, ctx, depth);
    case "ac:parameter":
    case "ac:plain-text-body":
    case "script":
    case "style":
      return [];
    default:
      return convertBlocks(element.children, ctx, depth);
  }
}

function convertMacro(element: XmlElement, ctx: ConvertContext, depth: number): string[] {
  const name = macroName(element);
  const params = macroParams(element);
  const body = childElement(element, "ac:rich-text-body");
  const bodyBlocks = (): string[] => (body ? convertBlocks(body.children, ctx, depth + 1) : []);
  switch (name) {
    case "code":
    case "noformat": {
      const plain = childElement(element, "ac:plain-text-body");
      return [codeFence(plain ? textContent(plain) : body ? textContent(body) : "", params.language)];
    }
    case "info":
    case "note":
    case "warning":
    case "tip":
    case "panel": {
      const directive = name === "info" || name === "panel" ? "callout" : name;
      const attrs: Record<string, string> = {};
      if (directive === "callout") attrs.tone = "info";
      if (params.title) attrs.title = params.title;
      return [directiveBlock(directive, attrs, bodyBlocks(), depth)];
    }
    case "expand":
      return [directiveBlock("accordion", params.title ? { title: params.title } : {}, bodyBlocks(), depth)];
    case "toc":
      return [directiveBlock("toc", {}, [], depth)];
    case "children": {
      const attrs: Record<string, string> = {};
      const childDepth = Number(params.depth);
      if (params.all === "true") attrs.depth = "5";
      else if (Number.isInteger(childDepth) && childDepth > 0) attrs.depth = String(Math.min(5, childDepth));
      const sort = params.sort === "title" ? "title" : params.sort === "modified" ? "updated" : undefined;
      if (sort) attrs.sort = sort;
      return [directiveBlock("children", attrs, [], depth, true)];
    }
    case "excerpt":
      return [directiveBlock("excerpt", { id: uniqueId(ctx, "excerpt") }, bodyBlocks(), depth)];
    case "excerpt-include":
    case "include": {
      const title = macroPageTitle(element) ?? params[""] ?? params.default;
      if (!title) {
        countLoss(ctx, name);
        return [];
      }
      return [directiveBlock("include", { page: title, ...(name === "excerpt-include" ? { excerpt: "" } : {}) }, [], depth, true)];
    }
    case "jira": {
      const key = (params.key ?? "").toUpperCase();
      if (/^[A-Z][A-Z0-9_]{1,19}-\d{1,9}$/.test(key)) return [directiveBlock("issue", { key }, [], depth, true)];
      countLoss(ctx, "jira");
      return [guardLine(`Jira query: ${singleLineText(params.jqlquery ?? params.jql ?? textContent(element))}`)];
    }
    case "details":
    case "page-properties": {
      const rows = body ? propertyRows(body, ctx) : [];
      return [directiveBlockRaw("page-properties", {}, rows.join("\n"), depth)];
    }
    case "detailssummary":
    case "page-properties-report": {
      const label = params.label ?? /label\s*=\s*"([^"]+)"/i.exec(params.cql ?? "")?.[1] ?? /label\s*=\s*'([^']+)'/i.exec(params.cql ?? "")?.[1];
      if (!label) {
        countLoss(ctx, name);
        return [];
      }
      return [directiveBlock("page-properties-report", { label: label.toLowerCase().replace(/\s+/g, "-") }, [], depth, true)];
    }
    case "status":
    case "anchor":
      return [paragraphText([element], ctx)].filter(Boolean);
    default: {
      countLoss(ctx, name || "unknown");
      const inner = body ? convertBlocks(body.children, ctx, depth + 1) : [];
      const text = inner.length === 0 ? singleLineText(textContent(element)) : "";
      return [directiveBlock("confluence_macro", { name: name || "unknown" }, text ? [guardLine(text)] : inner, depth)];
    }
  }
}

function propertyRows(body: XmlElement, ctx: ConvertContext): string[] {
  const rows: string[] = [];
  for (const row of descendants(body, "tr")) {
    const cells = row.children.filter((child): child is XmlElement => child.kind === "element" && (child.name === "th" || child.name === "td"));
    if (cells.length < 2) continue;
    const key = escapePipeTableCell(inlineText(cells[0]!.children, ctx, { singleLine: true }));
    const value = escapePipeTableCell(inlineText(cells[1]!.children, ctx, { singleLine: true }));
    if (key) rows.push(`| ${key} | ${value} |`);
  }
  return rows;
}

function listBlock(element: XmlElement, ctx: ConvertContext, ordered: boolean, level = 0): string {
  const lines: string[] = [];
  let number = 1;
  for (const item of element.children) {
    if (item.kind !== "element" || item.name !== "li") continue;
    const nested = item.children.filter((child): child is XmlElement => child.kind === "element" && (child.name === "ul" || child.name === "ol"));
    const own = item.children.filter((child) => !(child.kind === "element" && (child.name === "ul" || child.name === "ol")));
    const text = inlineText(own, ctx, { singleLine: true }) || " ";
    const indent = level > 0 ? `${"› ".repeat(level)}` : "";
    lines.push(`${ordered && level === 0 ? `${number++}.` : "-"} ${indent}${text}`);
    for (const child of nested) lines.push(listBlock(child, ctx, child.name === "ol", level + 1));
  }
  return lines.join("\n");
}

function taskListBlock(element: XmlElement, ctx: ConvertContext): string {
  const lines: string[] = [];
  for (const task of element.children) {
    if (task.kind !== "element" || task.name !== "ac:task") continue;
    const status = childElement(task, "ac:task-status");
    const body = childElement(task, "ac:task-body");
    const done = status ? textContent(status).trim() === "complete" : false;
    lines.push(`- [${done ? "x" : " "}] ${body ? inlineText(body.children, ctx, { singleLine: true }) : ""}`.trimEnd());
    for (const nested of task.children) {
      if (nested.kind === "element" && nested.name === "ac:task-list") lines.push(taskListBlock(nested, ctx));
    }
  }
  return lines.join("\n");
}

function tableBlock(element: XmlElement, ctx: ConvertContext): string {
  const rows = descendants(element, "tr")
    .map((row) => row.children.filter((child): child is XmlElement => child.kind === "element" && (child.name === "th" || child.name === "td")))
    .filter((cells) => cells.length > 0);
  if (rows.length === 0) return "";
  const width = Math.min(50, Math.max(...rows.map((cells) => cells.length)));
  const cellText = (cell: XmlElement | undefined): string =>
    cell ? escapePipeTableCell(singleLineText(cellInline(cell.children, ctx))) : "";
  const line = (cells: XmlElement[]): string => `| ${Array.from({ length: width }, (_, index) => cellText(cells[index]) || " ").join(" | ")} |`;
  const [header, ...body] = rows;
  return [line(header!), `| ${Array.from({ length: width }, () => "---").join(" | ")} |`, ...body.map(line)].join("\n");
}

/** Table cells are one line: block children flatten to their inline text, block macros to plain text. */
function cellInline(nodes: XmlNode[], ctx: ConvertContext): string {
  return nodes
    .map((node) => {
      if (isInline(node)) return inlineNode(node, ctx, { singleLine: true });
      const element = node as XmlElement;
      if (element.name === "ac:structured-macro" || element.name === "ac:macro") {
        const name = macroName(element);
        if (name === "code" || name === "noformat") {
          const text = singleLineText(textContent(element));
          return text && !text.includes("`") ? ` \`${text}\` ` : ` ${escapeInlineText(text)} `;
        }
        return ` ${escapeInlineText(singleLineText(textContent(element)))} `;
      }
      if (element.name === "ac:image") return "";
      if (element.name === "li") return ` ${cellInline(element.children, ctx)};`;
      return ` ${cellInline(element.children, ctx)} `;
    })
    .join("");
}

function figureBlock(image: XmlElement, ctx: ConvertContext, depth: number): string {
  const attachment = childElement(image, "ri:attachment");
  const external = childElement(image, "ri:url");
  let src: string | undefined;
  let filename: string | undefined;
  if (attachment) {
    filename = attachment.attrs["ri:filename"];
    const owner = childElement(attachment, "ri:page");
    if (filename) {
      const pageId = ctx.meta.pageId;
      src = ctx.meta.baseUrl && pageId && !owner
        ? `${ctx.meta.baseUrl.replace(/\/+$/, "")}/download/attachments/${encodeURIComponent(pageId)}/${encodeURIComponent(filename)}`
        : `attachments/${encodeURIComponent(pageId ?? "page")}/${encodeURIComponent(filename)}`;
      ctx.attachments.push({ filename, ...(pageId ? { pageId } : {}), url: src });
    }
  } else if (external) {
    src = external.attrs["ri:value"];
  }
  if (!src || !/^(https?:\/\/|attachments\/)/i.test(src)) {
    countLoss(ctx, "image");
    return "";
  }
  const alt = image.attrs["ac:alt"] ?? image.attrs["ac:title"] ?? filename ?? "Image";
  const caption = childElement(image, "ac:caption");
  const attrs: Record<string, string> = { src, alt };
  const captionText = caption ? inlineText(caption.children, ctx, { singleLine: true }) : "";
  if (captionText) attrs.caption = captionText;
  return directiveBlock("figure", attrs, [], depth, true);
}

interface InlineOptions {
  singleLine?: boolean;
}

function paragraphText(nodes: XmlNode[], ctx: ConvertContext): string {
  const text = inlineText(nodes, ctx, {});
  return text
    .split("\n")
    .map((line) => guardLine(line.trim()))
    .filter((line, index, all) => line || (index > 0 && index < all.length - 1))
    .join("\n")
    .trim();
}

function inlineText(nodes: XmlNode[], ctx: ConvertContext, options: InlineOptions): string {
  const out = nodes.map((node) => inlineNode(node, ctx, options)).join("");
  const collapsed = out.replace(/[ \t\r\f\v\u00a0]+/g, " ").replace(/ *\n */g, "\n");
  return options.singleLine ? collapsed.replace(/\\?\n/g, " ").replace(/ {2,}/g, " ").trim() : collapsed.trim();
}

function inlineNode(node: XmlNode, ctx: ConvertContext, options: InlineOptions): string {
  if (node.kind === "text") return escapeInlineText(node.cdata ? node.text : node.text.replace(/\s+/g, " "));
  const inner = (): string => node.children.map((child) => inlineNode(child, ctx, options)).join("");
  switch (node.name) {
    case "strong":
    case "b":
      return wrapInline(inner(), "**");
    case "em":
    case "i":
    case "cite":
    case "dfn":
      return wrapInline(inner(), "*");
    case "code":
    case "tt":
    case "kbd":
    case "samp": {
      const text = textContent(node).replace(/\s+/g, " ");
      return text.trim() && !text.includes("`") ? `\`${text.trim()}\`` : escapeInlineText(text);
    }
    case "br":
      return options.singleLine ? " " : "\\\n";
    case "a": {
      const label = inner().trim();
      const href = node.attrs.href ?? "";
      if (!/^(https?:|mailto:)/i.test(href)) return label;
      const safeHref = href.replace(/\s/g, "%20").replace(/\(/g, "%28").replace(/\)/g, "%29");
      return `[${(label || href).replace(/([\[\]])/g, "\\$1")}](${safeHref})`;
    }
    case "ac:link":
      return linkMarkup(node, ctx);
    case "ac:emoticon":
      return EMOTICONS[node.attrs["ac:name"] ?? ""] ?? "";
    case "time":
      return escapeInlineText(node.attrs.datetime ?? textContent(node));
    case "ac:placeholder":
    case "ac:parameter":
      return "";
    case "ri:user":
      return "@user";
    case "ac:structured-macro":
    case "ac:macro": {
      const name = macroName(node);
      const params = macroParams(node);
      if (name === "status") {
        const title = singleLineText(params.title ?? params.colour ?? "status").toUpperCase();
        return `**[${escapeInlineText(title)}]**`;
      }
      if (name === "anchor") return "";
      countLoss(ctx, name || "unknown");
      return escapeInlineText(singleLineText(textContent(node)));
    }
    case "ac:image":
      return "";
    default:
      return inner();
  }
}

const EMOTICONS: Record<string, string> = {
  smile: "🙂",
  sad: "🙁",
  cheeky: "😛",
  laugh: "😄",
  wink: "😉",
  thumbs_up: "👍",
  "thumbs-up": "👍",
  thumbs_down: "👎",
  "thumbs-down": "👎",
  information: "ℹ️",
  tick: "✅",
  cross: "❌",
  warning: "⚠️",
  plus: "➕",
  minus: "➖",
  question: "❓",
  "light-on": "💡",
  "light-off": "💡",
  "yellow-star": "⭐",
  "red-star": "⭐",
  "green-star": "⭐",
  "blue-star": "⭐",
};

function linkMarkup(link: XmlElement, ctx: ConvertContext): string {
  const page = childElement(link, "ri:page");
  const attachment = childElement(link, "ri:attachment");
  const user = childElement(link, "ri:user");
  const bodyNode = childElement(link, "ac:link-body") ?? childElement(link, "ac:plain-text-link-body");
  const label = bodyNode ? singleLineText(textContent(bodyNode)) : "";
  if (page) {
    const title = singleLineText(page.attrs["ri:content-title"] ?? "");
    if (!title) return escapeInlineText(label);
    const target = title.replace(/[[\]|]/g, " ").trim();
    const shown = label.replace(/[[\]|]/g, " ").trim();
    return shown && shown !== target ? `[[${target}|${shown}]]` : `[[${target}]]`;
  }
  if (attachment) return escapeInlineText(label || attachment.attrs["ri:filename"] || "attachment");
  if (user) return escapeInlineText(label || "@user");
  const anchor = link.attrs["ac:anchor"];
  if (anchor) return escapeInlineText(label || anchor);
  countLoss(ctx, "link");
  return escapeInlineText(label);
}

function wrapInline(text: string, marker: string): string {
  const trimmed = text.trim();
  if (!trimmed) return text;
  const lead = text.startsWith(" ") ? " " : "";
  const trail = text.endsWith(" ") ? " " : "";
  return `${lead}${marker}${trimmed}${marker}${trail}`;
}

function escapeInlineText(text: string): string {
  return text.replace(/\[\[/g, `[${ZWSP}[`).replace(/\]\]/g, `]${ZWSP}]`);
}

function codeFence(content: string, language: string | undefined): string {
  const lang = language && /^[\w+#.-]{1,30}$/.test(language) ? language.toLowerCase().replace(/[^\w]/g, "") : "";
  const body = content
    .replace(/\r\n?/g, "\n")
    .replace(/^\n+|\n+$/g, "")
    .split("\n")
    .map((line) => (/^\s*```/.test(line) ? `${ZWSP}${line}` : line))
    .join("\n");
  return `\`\`\`${lang}\n${body}\n\`\`\``;
}

function directiveBlock(name: string, attrs: Record<string, string>, children: string[], depth: number, empty = false): string {
  return directiveBlockRaw(name, attrs, empty ? "" : children.join("\n\n"), depth);
}

function directiveBlockRaw(name: string, attrs: Record<string, string>, body: string, depth: number): string {
  const fence = ":".repeat(Math.min(64, depth));
  const attrText = Object.entries(attrs)
    .map(([key, value]) => (value === "" ? key : /^\d{1,6}$/.test(value) ? `${key}=${value}` : `${key}="${attrValue(value)}"`))
    .join(" ");
  const open = `${fence}${name}${attrText ? `{${attrText}}` : ""}`;
  return body.trim() ? `${open}\n${body}\n${fence}` : `${open}\n${fence}`;
}

function attrValue(value: string): string {
  return singleLineText(value).replace(/"/g, "'").replace(/[{}]/g, "");
}

function guardLine(line: string): string {
  if (!line) return line;
  return /^(#{1,6}\s|:{2,}|[-*+]\s|\d+\.\s|>|\||```|~~~|-{3,}\s*$|\*{3,}\s*$|_{3,}\s*$)/.test(line) ? `${ZWSP}${line}` : line;
}

function headingText(text: string): string {
  return singleLineText(text).replace(/\s+\{/g, " (").replace(/\}/g, ")").trim();
}

function singleLineText(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function uniqueId(ctx: ConvertContext, base: string): string {
  const clean = base.slice(0, 60).replace(/-+$/g, "") || "section";
  let candidate = clean;
  for (let suffix = 2; ctx.usedIds.has(candidate); suffix++) candidate = `${clean}-${suffix}`;
  ctx.usedIds.add(candidate);
  return candidate;
}

function countLoss(ctx: ConvertContext, macro: string): void {
  ctx.loss.set(macro, (ctx.loss.get(macro) ?? 0) + 1);
}

function macroName(element: XmlElement): string {
  return (element.attrs["ac:name"] ?? "").toLowerCase();
}

function macroParams(element: XmlElement): Record<string, string> {
  const params: Record<string, string> = {};
  for (const child of element.children) {
    if (child.kind === "element" && child.name === "ac:parameter") {
      params[(child.attrs["ac:name"] ?? "").toLowerCase()] = child.children.map(textContent).join("").trim();
    }
  }
  return params;
}

function macroPageTitle(element: XmlElement): string | undefined {
  for (const param of element.children) {
    if (param.kind !== "element" || param.name !== "ac:parameter") continue;
    const page = descendants(param, "ri:page")[0];
    const title = page?.attrs["ri:content-title"];
    if (title) return singleLineText(title);
  }
  return undefined;
}

function childElement(element: XmlElement, name: string): XmlElement | undefined {
  return element.children.find((child): child is XmlElement => child.kind === "element" && child.name === name);
}

/** Matching descendants; rows of tables nested inside the first table level are not included. */
function descendants(element: XmlElement, name: string): XmlElement[] {
  const out: XmlElement[] = [];
  const visit = (node: XmlElement, inTable: boolean): void => {
    for (const child of node.children) {
      if (child.kind !== "element") continue;
      if (child.name === name) out.push(child);
      if (child.name === "table") {
        if (!inTable) visit(child, true);
      } else visit(child, inTable);
    }
  };
  visit(element, element.name === "table");
  return out;
}

function textContent(node: XmlNode): string {
  if (node.kind === "text") return node.text;
  if (node.name === "ac:parameter" || node.name === "br") return node.name === "br" ? "\n" : "";
  return node.children.map(textContent).join("");
}
