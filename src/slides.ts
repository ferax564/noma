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
 * Doc-to-deck fallback for documents without a `::deck`: every section at the
 * shallowest level that has at least two headings becomes one slide.
 */
export function sectionsAsSlides(doc: DocumentNode): Array<{ section: SectionNode; body: Node[] }> {
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
  const levels = [...byLevel.keys()].sort((a, b) => a - b);
  const level = levels.find((l) => (byLevel.get(l)?.length ?? 0) >= 2) ?? levels[0];
  if (level === undefined) return [];
  return (byLevel.get(level) ?? []).map((section) => ({
    section,
    body: section.children.filter((child) => child.type !== "section"),
  }));
}
