/**
 * PaperDOM → `.noma` text sync.
 *
 * A deck exported with `renderPaperDom` can be edited on a canvas. This module
 * turns the *text* edits made there back into ordinary Noma patch ops, so they
 * go through the same proof → approval → hash-checked apply loop as any agent
 * or human edit. Words live in `.noma`; geometry stays in PaperDOM.
 *
 * What syncs: slide titles, body paragraphs and list items, code lines, table
 * cells, speaker notes, `hidden`, `transition`, and slide order. Everything
 * else (new or deleted pages or elements, moved or restyled elements, added or
 * removed paragraphs) is reported in `skipped` with a reason instead of being
 * guessed. Pure: no I/O, the inputs are not mutated.
 */
import type { DirectiveNode, DocumentNode, Node, SectionNode } from "./ast.js";
import { walk } from "./ast.js";
import { inlineToPlain } from "./inline.js";
import type { PatchOp } from "./patch.js";
import { type CanvasElement, type PaperDOMDocument, parsePaperDOMDocument } from "./paperdom-document-model.js";
import { blockParagraphs, buildPaperDom, type PaperDomPageSource, type RenderPaperDomOptions } from "./renderer-paperdom.js";
import { renderNomaBlock } from "./renderer-noma.js";

export interface PaperDomSyncChange {
  pageId: string;
  elementId?: string;
  /** Block the op targets. */
  target: string;
  description: string;
}

export interface PaperDomSyncSkip {
  pageId?: string;
  elementId?: string;
  reason: string;
}

export interface PaperDomSyncResult {
  ops: PatchOp[];
  changes: PaperDomSyncChange[];
  skipped: PaperDomSyncSkip[];
}

/**
 * Compares an edited PaperDOM document with the one `doc` exports today and
 * returns patch ops that carry the canvas text edits back into `doc`. Pass
 * the same options (`deck`, `components`) that produced the canvas.
 */
export function paperDomToPatchOps(doc: DocumentNode, edited: PaperDOMDocument, options: RenderPaperDomOptions = {}): PaperDomSyncResult {
  const parsed = parsePaperDOMDocument(edited);
  if (!parsed.ok) throw new Error(`Invalid PaperDOM document: ${parsed.error}`);
  const canvas = parsed.document;
  const built = buildPaperDom(doc, options);
  const normalized = parsePaperDOMDocument(built.document);
  const baseline = normalized.ok ? normalized.document : built.document;
  const sources = built.pages;
  const index = sourceIndex(doc);
  const result: PaperDomSyncResult = { ops: [], changes: [], skipped: [] };
  const baselinePages = new Map(baseline.pages.map((page) => [page.id, page]));
  const sourceByPage = new Map(sources.map((source) => [source.pageId, source]));

  for (const page of canvas.pages) {
    const before = baselinePages.get(page.id);
    const source = sourceByPage.get(page.id);
    if (!before || !source) {
      result.skipped.push({ pageId: page.id, reason: "new page on the canvas; add the slide in Noma" });
      continue;
    }
    syncPage(page, before, source, index, result);
  }
  for (const page of baseline.pages) {
    if (!canvas.pages.some((candidate) => candidate.id === page.id)) {
      result.skipped.push({ pageId: page.id, reason: "page deleted on the canvas; delete the slide in Noma" });
    }
  }
  syncOrder(canvas, baseline, sources, index, result);
  return result;
}

interface SourceIndex {
  nodes: Set<Node>;
  parent: Map<Node, Node>;
  colons: Map<Node, number>;
  doc: DocumentNode;
}

function sourceIndex(doc: DocumentNode): SourceIndex {
  const nodes = new Set<Node>(walk(doc));
  const parent = new Map<Node, Node>();
  const colons = new Map<Node, number>();
  const visit = (node: Node, depth: number): void => {
    const children = node.type === "document" || node.type === "section" || node.type === "directive" ? node.children : [];
    for (const child of children) {
      parent.set(child, node);
      const childDepth = child.type === "directive" ? depth + 1 : depth;
      colons.set(child, child.type === "directive" ? childDepth : depth);
      visit(child, childDepth);
    }
  };
  visit(doc, 1);
  return { nodes, parent, colons, doc };
}

type Page = PaperDOMDocument["pages"][number];

function syncPage(page: Page, before: Page, source: PaperDomPageSource, index: SourceIndex, result: PaperDomSyncResult): void {
  const slide = source.slide;
  const isDeckSlide = index.nodes.has(slide);
  const later: PaperDomSyncResult = { ops: [], changes: [], skipped: result.skipped };
  const replacements = new Map<Node, Node>();
  let notesText: string | undefined;

  const beforeElements = new Map(before.elements.map((element) => [element.id, element]));
  for (const element of page.elements) {
    const original = beforeElements.get(element.id);
    if (!original) {
      result.skipped.push({ pageId: page.id, elementId: element.id, reason: "new element on the canvas; it stays in PaperDOM" });
      continue;
    }
    if (JSON.stringify([element.frame, element.style, element.z, element.hidden ?? false]) !== JSON.stringify([original.frame, original.style, original.z, original.hidden ?? false])) {
      result.skipped.push({ pageId: page.id, elementId: element.id, reason: "position or style changed; layout stays in PaperDOM" });
    }
    if (element.id === `${page.id}--title`) {
      syncTitle(page.id, element, original, slide, index, later);
      continue;
    }
    const blocks = source.elements.get(element.id) ?? [];
    if (element.type === "table" && original.type === "table") {
      syncTable(page.id, element, original, blocks, index, replacements, result);
      continue;
    }
    if (element.type === "text" && original.type === "text") {
      syncTextBlocks(page.id, element, original, blocks, index, replacements, result);
    }
  }
  for (const original of before.elements) {
    if (!page.elements.some((element) => element.id === original.id)) {
      result.skipped.push({ pageId: page.id, elementId: original.id, reason: "element deleted on the canvas; edit the slide in Noma" });
    }
  }

  if ((page.notes ?? "") !== (before.notes ?? "")) {
    if (isDeckSlide) notesText = page.notes ?? "";
    else result.skipped.push({ pageId: page.id, reason: "speaker notes need a ::slide; this page comes from a section" });
  }
  if (isDeckSlide && slide.id) {
    if ((page.hidden === true) !== (before.hidden === true)) {
      later.ops.push(page.hidden ? { op: "update_attribute", id: slide.id, key: "hidden", value: true } : { op: "remove_attribute", id: slide.id, key: "hidden" });
      later.changes.push({ pageId: page.id, target: slide.id, description: page.hidden ? "hide slide" : "show slide" });
    }
    const transition = page.transition ?? "none";
    if (transition !== (before.transition ?? "none")) {
      later.ops.push(transition === "none" ? { op: "remove_attribute", id: slide.id, key: "transition" } : { op: "update_attribute", id: slide.id, key: "transition", value: transition });
      later.changes.push({ pageId: page.id, target: slide.id, description: `transition → ${transition}` });
    }
  }

  emitBlockReplacements(page.id, slide, replacements, notesText, index, result);
  // Attribute and heading ops run after block replacements: a replaced slide is
  // re-rendered from its source node and would otherwise undo them.
  result.ops.push(...later.ops);
  result.changes.push(...later.changes);
}

function syncTitle(pageId: string, element: CanvasElement, original: CanvasElement, slide: DirectiveNode, index: SourceIndex, result: PaperDomSyncResult): void {
  const next = element.content?.text ?? "";
  const prev = original.content?.text ?? "";
  if (next === prev) return;
  const oneLine = next.replace(/\s+/g, " ").trim();
  if (index.nodes.has(slide) && slide.id && typeof slide.attrs.title === "string") {
    result.ops.push({ op: "update_attribute", id: slide.id, key: "title", value: rebaseInlineEdit(slide.attrs.title, prev, oneLine) });
    result.changes.push({ pageId, elementId: element.id, target: slide.id, description: `slide title → "${oneLine}"` });
    return;
  }
  const heading = headingFor(slide, index);
  if (heading?.id) {
    result.ops.push({ op: "update_heading", id: heading.id, title: rebaseInlineEdit(heading.title, prev, oneLine) });
    result.changes.push({ pageId, elementId: element.id, target: heading.id, description: `heading → "${oneLine}"` });
    return;
  }
  result.skipped.push({ pageId, elementId: element.id, reason: "the title has no addressable source (give the slide an id)" });
}

function headingFor(slide: DirectiveNode, index: SourceIndex): SectionNode | undefined {
  if (index.nodes.has(slide)) {
    const first = slide.children.find((child) => !(child.type === "directive" && child.name === "notes"));
    return first?.type === "section" ? first : undefined;
  }
  for (const node of index.nodes) if (node.type === "section" && node.id === slide.id) return node;
  return undefined;
}

function syncTextBlocks(
  pageId: string,
  element: CanvasElement,
  original: CanvasElement,
  blocks: Node[],
  index: SourceIndex,
  replacements: Map<Node, Node>,
  result: PaperDomSyncResult,
): void {
  const next = (element.content?.paragraphs ?? splitText(element.content?.text)).map((p) => p.text);
  const prev = (original.content?.paragraphs ?? splitText(original.content?.text)).map((p) => p.text);
  if (sameList(next, prev)) return;
  if (next.length !== prev.length) {
    result.skipped.push({ pageId, elementId: element.id, reason: `paragraphs were ${next.length > prev.length ? "added" : "removed"} on the canvas; add or remove them in Noma` });
    return;
  }
  let cursor = 0;
  for (const block of blocks) {
    const span = blockParagraphs(block).length;
    const oldTexts = prev.slice(cursor, cursor + span);
    const newTexts = next.slice(cursor, cursor + span);
    cursor += span;
    if (sameList(oldTexts, newTexts)) continue;
    if (!index.nodes.has(block)) {
      result.skipped.push({ pageId, elementId: element.id, reason: "this text comes from a component; edit the component use or the kit" });
      continue;
    }
    replacements.set(block, applyTexts(block, newTexts, oldTexts));
  }
}

function syncTable(
  pageId: string,
  element: CanvasElement,
  original: CanvasElement,
  blocks: Node[],
  index: SourceIndex,
  replacements: Map<Node, Node>,
  result: PaperDomSyncResult,
): void {
  const table = blocks[0];
  const next = element.table?.rows ?? [];
  const prev = original.table?.rows ?? [];
  if (JSON.stringify(next) === JSON.stringify(prev)) return;
  if (!table || table.type !== "table" || !index.nodes.has(table)) {
    result.skipped.push({ pageId, elementId: element.id, reason: "this table has no addressable source" });
    return;
  }
  if (next.length !== prev.length || next.some((row, r) => row.length !== (prev[r]?.length ?? -1))) {
    result.skipped.push({ pageId, elementId: element.id, reason: "rows or columns were added or removed on the canvas; change the table in Noma" });
    return;
  }
  const header = table.header.map((cell, c) => (next[0]![c] === prev[0]![c] ? cell : rebaseInlineEdit(cell, prev[0]![c]!, next[0]![c]!)));
  const rows = table.rows.map((row, r) => row.map((cell, c) => (next[r + 1]![c] === prev[r + 1]![c] ? cell : rebaseInlineEdit(cell, prev[r + 1]![c]!, next[r + 1]![c]!))));
  replacements.set(table, { ...table, header, rows });
}

/**
 * Turns block replacements (and a notes change) into ops: blocks with their own
 * ID get `replace_block`; anything else is carried by re-rendering the nearest
 * addressable ancestor (normally the slide or section) at its fence depth.
 */
function emitBlockReplacements(
  pageId: string,
  slide: DirectiveNode,
  replacements: Map<Node, Node>,
  notesText: string | undefined,
  index: SourceIndex,
  result: PaperDomSyncResult,
): void {
  if (notesText !== undefined) {
    const notes = slide.children.filter((child): child is DirectiveNode => child.type === "directive" && child.name === "notes");
    const paragraphs: Node[] = notesText.split("\n").map((line) => line.trim()).filter(Boolean).map((content) => ({ type: "paragraph", content }));
    if (notes.length === 1 && notes[0]!.id && notes[0]!.children.every((child) => child.type === "paragraph")) {
      result.ops.push({ op: "replace_body", id: notes[0]!.id, content: paragraphs.map((p) => (p.type === "paragraph" ? p.content : "")).join("\n\n") });
      result.changes.push({ pageId, target: notes[0]!.id, description: "speaker notes" });
    } else if (notes.length <= 1) {
      const notesNode = notes[0];
      if (notesNode) replacements.set(notesNode, { ...notesNode, body: undefined, children: paragraphs });
      else if (paragraphs.length > 0) replacements.set(slide, { ...(replacements.get(slide) as DirectiveNode | undefined ?? slide), children: [...slide.children, { type: "directive", name: "notes", attrs: {}, children: paragraphs }] });
    } else {
      result.skipped.push({ pageId, reason: "the slide has several ::notes blocks; edit the notes in Noma" });
    }
  }
  if (replacements.size === 0) return;

  const viaAncestor = new Map<Node, Node[]>();
  for (const [block, next] of replacements) {
    const ops = block === slide ? undefined : directOps(block, next, index);
    if (ops) {
      result.ops.push(...ops);
      result.changes.push({ pageId, target: block.id ?? describe(block), description: `text of ${describe(block)}` });
      continue;
    }
    const anchor = addressableAncestor(block, index);
    if (!anchor) {
      result.skipped.push({ pageId, reason: `${describe(block)} has no id and sits outside any ::slide or block with an id; add a {#id} line before it, or use a ::deck` });
      continue;
    }
    viaAncestor.set(anchor, [...(viaAncestor.get(anchor) ?? []), block]);
  }
  for (const [anchor, blocks] of viaAncestor) {
    const rebuilt = rebuild(anchor, replacements);
    result.ops.push({ op: "replace_block", id: anchor.id!, content: renderNomaBlock(rebuilt, index.colons.get(anchor) ?? 2, index.doc) });
    result.changes.push({ pageId, target: anchor.id!, description: `text of ${blocks.map(describe).join(", ")}` });
  }
}

/** Nearest directive with an id: `replace_block` can rewrite directives, not heading sections. */
/**
 * Ops that rewrite `block` by its own id, or undefined when it has none the
 * patch engine can address: directives take `replace_block`; paragraphs,
 * quotes, and code take `replace_body`; a list takes `replace_body` per item
 * when every changed item carries an id. Pipe tables and sections go through
 * their nearest directive ancestor.
 */
function directOps(block: Node, next: Node, index: SourceIndex): PatchOp[] | undefined {
  if (block.type === "directive" && block.id) {
    return [{ op: "replace_block", id: block.id, content: renderNomaBlock(next, index.colons.get(block) ?? 2, index.doc) }];
  }
  if ((block.type === "paragraph" || block.type === "quote" || block.type === "code") && block.id && next.type === block.type) {
    return [{ op: "replace_body", id: block.id, content: next.content }];
  }
  if (block.type === "list" && next.type === "list") {
    const changed = block.items.map((item, i) => [item, next.items[i]!] as const).filter(([item, updated]) => item.content !== updated.content);
    if (changed.length > 0 && changed.every(([item]) => item.id)) {
      return changed.map(([item, updated]) => ({ op: "replace_body" as const, id: item.id!, content: updated.content }));
    }
  }
  return undefined;
}

function addressableAncestor(block: Node, index: SourceIndex): Node | undefined {
  let current: Node | undefined = block;
  while (current && current.type !== "document") {
    if (current.id && current.type === "directive") return current;
    current = index.parent.get(current);
  }
  return undefined;
}

/** Copy of `node` with every replaced descendant swapped in. */
function rebuild(node: Node, replacements: Map<Node, Node>): Node {
  const own = replacements.get(node) ?? node;
  if (own.type !== "section" && own.type !== "directive") return own;
  return { ...own, children: own.children.map((child) => rebuild(child, replacements)) } as Node;
}

function describe(node: Node): string {
  if (node.type === "directive") return `::${node.name}${node.id ? ` ${node.id}` : ""}`;
  return node.id ? `${node.type} ${node.id}` : node.type;
}

/** New block with `texts` written back in the same order `blockParagraphs` read them. */
function applyTexts(node: Node, texts: string[], oldTexts: string[]): Node {
  let i = 0;
  const take = (source: string): string => {
    const next = texts[i] ?? "";
    const prev = oldTexts[i] ?? "";
    i += 1;
    return next === prev ? source : rebaseInlineEdit(source, prev, next);
  };
  const visit = (current: Node): Node => {
    switch (current.type) {
      case "paragraph":
        return { ...current, content: take(current.content) };
      case "quote":
        return { ...current, content: take(current.content) };
      case "list":
        return { ...current, items: current.items.map((item) => ({ ...item, content: take(item.content) })) };
      case "code": {
        const lines = current.content.split("\n").map((line) => {
          const next = texts[i] ?? line;
          i += 1;
          return next;
        });
        return { ...current, content: lines.join("\n") };
      }
      case "section":
        return { ...current, title: take(current.title), children: current.children.map(visit) };
      case "directive": {
        if (current.name === "notes" || current.name === "html" || current.name === "svg" || current.name === "script") return current;
        if (current.children.length > 0) return { ...current, children: current.children.map(visit) };
        if (!current.body) return current;
        const chunks = current.body.split(/\n{2,}/).map((chunk) => (inlineToPlain(chunk).replace(/\s+/g, " ").trim() ? take(chunk) : chunk));
        return { ...current, body: chunks.join("\n\n") };
      }
      default:
        return current;
    }
  };
  return visit(node);
}

/**
 * Re-applies a plain-text edit onto the original inline-markdown source, so
 * `**$8** per month` edited to `$9 per month` becomes `**$9** per month`.
 * Only the changed span is rewritten; inserted text joins the character that
 * follows it (so it lands inside a span it prefixes). When the plain text
 * cannot be aligned with the source, the new plain text is used as-is.
 */
export function rebaseInlineEdit(source: string, oldPlain: string, newPlain: string): string {
  if (oldPlain === newPlain) return source;
  const flat = (value: string): string => value.replace(/\s+/g, " ").trim();
  if (flat(source) === flat(oldPlain)) return newPlain;
  let start = 0;
  while (start < oldPlain.length && start < newPlain.length && oldPlain[start] === newPlain[start]) start++;
  let endOld = oldPlain.length;
  let endNew = newPlain.length;
  while (endOld > start && endNew > start && oldPlain[endOld - 1] === newPlain[endNew - 1]) {
    endOld--;
    endNew--;
  }
  const map: number[] = [];
  let p = 0;
  for (let s = 0; s < source.length && p < oldPlain.length; s++) {
    if (source[s] === oldPlain[p] || (/\s/.test(source[s]!) && oldPlain[p] === " ")) {
      map[p] = s;
      p++;
    }
  }
  if (p < oldPlain.length) return newPlain;
  const sourceStart = start < oldPlain.length ? map[start]! : source.length;
  const sourceEnd = endOld > start ? map[endOld - 1]! + 1 : sourceStart;
  return source.slice(0, sourceStart) + newPlain.slice(start, endNew) + source.slice(sourceEnd);
}

function syncOrder(canvas: PaperDOMDocument, baseline: PaperDOMDocument, sources: PaperDomPageSource[], index: SourceIndex, result: PaperDomSyncResult): void {
  const known = new Set(baseline.pages.map((page) => page.id));
  const nextOrder = canvas.pages.map((page) => page.id).filter((id) => known.has(id));
  const prevOrder = baseline.pages.map((page) => page.id).filter((id) => nextOrder.includes(id));
  if (sameList(nextOrder, prevOrder)) return;
  const slides = new Map(sources.map((source) => [source.pageId, source.slide]));
  const first = slides.get(nextOrder[0] ?? "");
  const deck = first ? index.parent.get(first) : undefined;
  const allDeckSlides = nextOrder.every((id) => {
    const slide = slides.get(id);
    return slide && index.nodes.has(slide) && slide.id === id && index.parent.get(slide) === deck;
  });
  if (!deck || deck.type !== "directive" || !deck.id || !allDeckSlides) {
    result.skipped.push({ reason: "slides were reordered, but they are not all `::slide` blocks with ids in one `::deck` with an id; reorder in Noma" });
    return;
  }
  const slideOnly = deck.children.every((child) => child.type === "directive" && child.name === "slide");
  if (!slideOnly) {
    result.skipped.push({ reason: "slides were reordered, but the deck also holds non-slide blocks; reorder in Noma" });
    return;
  }
  nextOrder.forEach((id, position) => result.ops.push({ op: "move_block", id, parent: deck.id!, position }));
  result.changes.push({ pageId: nextOrder[0]!, target: deck.id, description: `slide order → ${nextOrder.join(", ")}` });
}

function splitText(text: string | undefined): Array<{ text: string }> {
  return (text ?? "").split("\n").map((line) => ({ text: line }));
}

function sameList(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && a.every((value, i) => value === b[i]);
}
