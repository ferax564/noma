import type { DirectiveNode, DocumentNode, Node, SectionNode } from "./ast.js";

/** Layouts a `::slide{layout="..."}` may declare. `content` is the default. */
export const SLIDE_LAYOUTS = ["title", "section", "content", "two-column", "statement", "quote", "media", "blank"] as const;
export type SlideLayout = (typeof SLIDE_LAYOUTS)[number];

export const DECK_ASPECTS: Record<string, { width: number; height: number }> = {
  "16:9": { width: 1280, height: 720 },
  "4:3": { width: 1024, height: 768 },
  "1:1": { width: 1080, height: 1080 },
};

export function isSlideLayout(value: unknown): value is SlideLayout {
  return typeof value === "string" && (SLIDE_LAYOUTS as readonly string[]).includes(value);
}

export function slideLayout(node: DirectiveNode): SlideLayout {
  return isSlideLayout(node.attrs.layout) ? node.attrs.layout : "content";
}

export function deckAspect(node: DirectiveNode | undefined): string {
  const aspect = node?.attrs.aspect;
  return typeof aspect === "string" && DECK_ASPECTS[aspect] ? aspect : "16:9";
}

export function isDirective(node: Node, name: string): node is DirectiveNode {
  return node.type === "directive" && node.name === name;
}

/** Slides of a deck in source order. */
export function deckSlides(deck: DirectiveNode): DirectiveNode[] {
  return deck.children.filter((child): child is DirectiveNode => isDirective(child, "slide"));
}

/**
 * A slide's parts: the explicit `title=` wins; otherwise a leading heading is
 * the title. Speaker notes come from `::notes` children and never reach `body`.
 */
export interface SlideParts {
  title?: string;
  /** ID of the heading section the title came from, so anchors to it still resolve. */
  titleId?: string;
  titleFromHeading: boolean;
  body: Node[];
  notes: DirectiveNode[];
}

export function slideParts(slide: DirectiveNode): SlideParts {
  const notes = slide.children.filter((child): child is DirectiveNode => isDirective(child, "notes"));
  const rest = slide.children.filter((child) => !isDirective(child, "notes"));
  const explicit = typeof slide.attrs.title === "string" && slide.attrs.title.trim() ? slide.attrs.title : undefined;
  if (explicit) return { title: explicit, titleFromHeading: false, body: rest, notes };
  const first = rest[0];
  if (first?.type === "section") {
    return { title: first.title, ...(first.id ? { titleId: first.id } : {}), titleFromHeading: true, body: [...first.children, ...rest.slice(1)], notes };
  }
  return { titleFromHeading: false, body: rest, notes };
}

export function findDecks(doc: DocumentNode): DirectiveNode[] {
  const out: DirectiveNode[] = [];
  const visit = (nodes: Node[]): void => {
    for (const node of nodes) {
      if (isDirective(node, "deck")) out.push(node);
      if ("children" in node && Array.isArray(node.children)) visit(node.children as Node[]);
    }
  };
  visit(doc.children);
  return out;
}

/**
 * Doc-to-deck fallback for documents without a `::deck`. Every section at the
 * shallowest level with at least two headings becomes one slide. When that
 * level sits under a single top heading (the usual `# Title` + `## Parts`
 * page), the top heading and its intro become a leading `title` slide. A page
 * with no headings becomes one slide.
 */
export function sectionsAsSlides(doc: DocumentNode): Array<{ section?: SectionNode; title?: string; body: Node[]; layout: SlideLayout }> {
  const byLevel = new Map<number, SectionNode[]>();
  const visit = (nodes: Node[]): void => {
    for (const node of nodes) {
      if (node.type !== "section") continue;
      const list = byLevel.get(node.level) ?? [];
      list.push(node);
      byLevel.set(node.level, list);
      visit(node.children);
    }
  };
  visit(doc.children);
  const preamble = doc.children.filter((child) => child.type !== "section" && child.type !== "frontmatter");
  const levels = [...byLevel.keys()].sort((a, b) => a - b);
  const docTitle = typeof doc.meta.title === "string" ? doc.meta.title : undefined;
  if (levels.length === 0) return preamble.length > 0 ? [{ title: docTitle, body: preamble, layout: "content" }] : [];
  const level = levels.find((l) => (byLevel.get(l)?.length ?? 0) >= 2) ?? levels[0]!;
  const out: Array<{ section?: SectionNode; title?: string; body: Node[]; layout: SlideLayout }> = [];
  const top = byLevel.get(levels[0]!) ?? [];
  if (level !== levels[0] && top.length === 1) {
    const root = top[0]!;
    out.push({ section: root, body: [...preamble, ...root.children.filter((child) => child.type !== "section")], layout: "title" });
  } else if (preamble.length > 0) {
    out.push({ title: docTitle, body: preamble, layout: "title" });
  }
  for (const section of byLevel.get(level) ?? []) {
    out.push({ section, body: section.children.filter((child) => child.type !== "section"), layout: "content" });
  }
  return out;
}

export interface PresentationSlides {
  /** The `::deck` being presented, when the document has one. */
  deck?: DirectiveNode;
  title?: string;
  aspect: string;
  /** Real `::slide` blocks, or synthetic ones built from sections (IDs = section IDs). */
  slides: DirectiveNode[];
  /** True when the slides were derived from sections rather than a `::deck`. */
  fromSections: boolean;
}

/**
 * What "Present" shows for a document: the chosen (or first) `::deck`, else
 * one slide per section. Synthetic slides are fresh nodes; the AST is not mutated.
 */
export function presentationSlides(doc: DocumentNode, deckId?: string): PresentationSlides {
  const decks = findDecks(doc);
  const deck = deckId ? decks.find((d) => d.id === deckId) : decks[0];
  if (deckId && !deck) throw new Error(`No ::deck with id "${deckId}".`);
  const docTitle = typeof doc.meta.title === "string" ? doc.meta.title : undefined;
  if (deck) {
    const title = typeof deck.attrs.title === "string" ? deck.attrs.title : docTitle;
    return { deck, ...(title ? { title } : {}), aspect: deckAspect(deck), slides: deckSlides(deck), fromSections: false };
  }
  const used = new Set<string>();
  const slides = sectionsAsSlides(doc).map((entry, index): DirectiveNode => {
    let id = entry.section?.id ?? `slide-${index + 1}`;
    for (let n = 2; used.has(id); n += 1) id = `${entry.section?.id ?? "slide"}-${n}`;
    used.add(id);
    const title = entry.section?.title ?? entry.title;
    return {
      type: "directive",
      name: "slide",
      id,
      attrs: { id, layout: entry.layout, ...(title ? { title } : {}) },
      children: entry.body,
      ...(entry.section?.pos ? { pos: entry.section.pos } : {}),
    };
  });
  const title = docTitle ?? sectionsTitle(doc);
  return { ...(title ? { title } : {}), aspect: "16:9", slides, fromSections: true };
}

function sectionsTitle(doc: DocumentNode): string | undefined {
  const first = doc.children.find((child): child is SectionNode => child.type === "section");
  return first?.title;
}
