import { type ComponentKit, expandComponents } from "./components.js";
import type { DirectiveNode, DocumentNode, Node } from "./ast.js";
import { inlineToPlain } from "./inline.js";
import type {
  CanvasElement,
  CanvasPage,
  ElementStyle,
  Paragraph,
  PaperDOMDocument,
} from "./paperdom-document-model.js";
import { DECK_ASPECTS, presentationSlides, slideLayout, slideParts, type SlideLayout } from "./slides.js";

export interface RenderPaperDomOptions {
  /** Host component kit; component uses are expanded in place and definitions dropped. */
  components?: ComponentKit;
  /** Deck to export when the document has several. Defaults to the first `::deck`. */
  deck?: string;
  /** Timestamp written to `metadata`. Defaults to the document `date`, else the Unix epoch, so output is deterministic. */
  now?: string;
}

/**
 * AST → PaperDOM presentation document (the JSON slide model forked from
 * ferax564/paperDOM). Each `::slide` becomes a page whose id is the slide's
 * block ID; element ids are `<slide-id>--<part>`, so an agent can map a canvas
 * element back to the `.noma` block that owns it. Documents without a
 * `::deck` convert section-per-slide. Pure: no I/O, input is not mutated.
 */
export function renderPaperDom(source: DocumentNode, options: RenderPaperDomOptions = {}): PaperDOMDocument {
  return buildPaperDom(source, options).document;
}

/** Where one canvas page came from: the slide block and the blocks behind each element. */
export interface PaperDomPageSource {
  pageId: string;
  /** The `::slide` block, or a synthetic slide for a section-derived page. */
  slide: DirectiveNode;
  /** Element id → the text or table blocks rendered into it, in order. */
  elements: Map<string, Node[]>;
}

/** `renderPaperDom` plus provenance, so canvas edits can be mapped back to `.noma` blocks. */
export function buildPaperDom(source: DocumentNode, options: RenderPaperDomOptions = {}): { document: PaperDOMDocument; pages: PaperDomPageSource[] } {
  const doc = expandComponents(source, { ...(options.components ? { kit: options.components } : {}), wrap: false, dropDefinitions: true });
  const presentation = presentationSlides(doc, options.deck);
  const deck = presentation.deck;
  const size = DECK_ASPECTS[presentation.aspect] ?? { width: 1280, height: 720 };
  const theme = deckTheme(deck);
  const now = options.now ?? (typeof doc.meta.date === "string" ? isoDate(doc.meta.date) : undefined) ?? "1970-01-01T00:00:00.000Z";
  const title = presentation.title ?? "Untitled deck";

  const specs: SlideSpec[] = presentation.slides.map((slide, index) => {
    const parts = slideParts(slide);
    return {
      slide,
      id: slide.id ?? `slide-${index + 1}`,
      title: parts.title,
      layout: slideLayout(slide),
      body: parts.body,
      notes: parts.notes.map(notesText).filter(Boolean).join("\n\n"),
      hidden: slide.attrs.hidden === true,
      transition: transitionOf(slide.attrs.transition),
    };
  });

  const used = new Set<string>();
  const sources: PaperDomPageSource[] = [];
  const pages: CanvasPage[] = specs.map((spec) => {
    const pageId = uniqueId(spec.id, used);
    const elements = new Map<string, Node[]>();
    sources.push({ pageId, slide: spec.slide, elements });
    const page: CanvasPage = {
      id: pageId,
      name: spec.title ? inlineToPlain(spec.title) : pageId,
      size,
      background: { color: spec.layout === "section" ? theme.accent : theme.background },
      elements: layoutElements(pageId, spec, size, theme, used, elements),
    };
    if (spec.notes) page.notes = spec.notes;
    if (spec.hidden) page.hidden = true;
    if (spec.transition !== "none") page.transition = spec.transition;
    return page;
  });
  if (pages.length === 0) {
    pages.push({ id: uniqueId("slide-1", used), name: title, size, background: { color: theme.background }, elements: [] });
  }
  if (pages.every((page) => page.hidden)) delete pages[0]!.hidden;

  return {
    document: {
      format: "paperdom",
      version: "0.1",
      id: deck?.id ?? slug(title),
      title,
      revision: 0,
      pages,
      plugins: [],
      metadata: { createdAt: now, updatedAt: now },
    },
    pages: sources,
  };
}

interface SlideSpec {
  slide: DirectiveNode;
  id: string;
  title?: string;
  layout: SlideLayout;
  body: Node[];
  notes: string;
  hidden: boolean;
  transition: "none" | "fade" | "slide";
}

interface DeckTheme {
  background: string;
  ink: string;
  accent: string;
  onAccent: string;
  font: string;
}

const SAFE_COLOR = /^(#[0-9a-fA-F]{3,8}|[a-z]+)$/;

function deckTheme(deck: DirectiveNode | undefined): DeckTheme {
  const color = (key: string, fallback: string): string => {
    const value = attrString(deck, key);
    return value && SAFE_COLOR.test(value) ? value : fallback;
  };
  return {
    background: color("background", "#ffffff"),
    ink: color("ink", "#1d1c1a"),
    accent: color("accent", "#b9522a"),
    onAccent: "#ffffff",
    font: "Inter, ui-sans-serif, system-ui, sans-serif",
  };
}

function baseStyle(theme: DeckTheme, overrides: Partial<ElementStyle> = {}): ElementStyle {
  return {
    fill: "transparent",
    stroke: "transparent",
    strokeWidth: 0,
    radius: 0,
    opacity: 1,
    color: theme.ink,
    fontSize: 24,
    fontWeight: 400,
    textAlign: "left",
    fontFamily: theme.font,
    fontStyle: "normal",
    underline: false,
    strike: false,
    lineHeight: 1.3,
    letterSpacing: 0,
    verticalAlign: "top",
    padding: 0,
    ...overrides,
  };
}

function layoutElements(
  pageId: string,
  spec: SlideSpec,
  size: { width: number; height: number },
  theme: DeckTheme,
  used: Set<string>,
  provenance: Map<string, Node[]>,
): CanvasElement[] {
  const { width: W, height: H } = size;
  const margin = Math.round(W * 0.05);
  const inner = W - margin * 2;
  const out: CanvasElement[] = [];
  let z = 1;
  const push = (part: string, element: Omit<CanvasElement, "id" | "z">, from: Node[] = []): void => {
    const id = uniqueId(`${pageId}--${part}`, used);
    provenance.set(id, from);
    out.push({ ...element, id, z: z++ });
  };
  const titleText = spec.title ? inlineToPlain(spec.title).replace(/\s+/g, " ").trim() : "";
  const ink = spec.layout === "section" ? theme.onAccent : theme.ink;

  if (spec.layout === "title" || spec.layout === "section" || spec.layout === "statement" || spec.layout === "quote") {
    const centered = spec.layout !== "section";
    const align = centered ? "center" : "left";
    if (titleText) {
      push("title", {
        type: "text",
        name: "title",
        frame: { x: margin, y: Math.round(H * 0.3), w: inner, h: Math.round(H * 0.2), rotation: 0 },
        style: baseStyle(theme, { color: ink, fontSize: spec.layout === "title" ? 56 : 48, fontWeight: 700, textAlign: align, verticalAlign: "bottom" }),
        content: { text: titleText },
      });
    }
    const paragraphs = spec.body.flatMap(blockParagraphs);
    if (paragraphs.length > 0) {
      push("body", textElement("body", paragraphs, { x: margin, y: Math.round(H * 0.54), w: inner, h: Math.round(H * 0.3) }, baseStyle(theme, {
        color: ink,
        fontSize: spec.layout === "statement" ? 36 : 26,
        fontStyle: spec.layout === "quote" ? "italic" : "normal",
        textAlign: align,
      })), spec.body);
    }
    return out;
  }

  const top = titleText ? Math.round(H * 0.22) : margin;
  if (titleText) {
    push("title", {
      type: "text",
      name: "title",
      frame: { x: margin, y: margin, w: inner, h: Math.round(H * 0.12), rotation: 0 },
      style: baseStyle(theme, { fontSize: 40, fontWeight: 700, verticalAlign: "bottom" }),
      content: { text: titleText },
    });
  }
  const bodyHeight = H - top - margin;
  const columns = spec.layout === "two-column" ? splitColumns(spec.body) : [spec.body];
  const gap = Math.round(W * 0.03);
  const colWidth = Math.round((inner - gap * (columns.length - 1)) / columns.length);
  columns.forEach((blocks, col) => {
    const x = margin + col * (colWidth + gap);
    const tables = blocks.filter((b) => b.type === "table");
    const textBlocks = blocks.filter((b) => b.type !== "table");
    const paragraphs = textBlocks.flatMap(blockParagraphs);
    const textShare = tables.length === 0 ? 1 : paragraphs.length === 0 ? 0 : 0.45;
    const suffix = columns.length > 1 ? `-${col + 1}` : "";
    if (paragraphs.length > 0) {
      push(`body${suffix}`, textElement(`body${suffix}`, paragraphs, { x, y: top, w: colWidth, h: Math.max(40, Math.round(bodyHeight * textShare)) }, baseStyle(theme, {
        fontSize: spec.layout === "media" ? 20 : 24,
      })), textBlocks);
    }
    let tableY = top + Math.round(bodyHeight * textShare);
    const tableHeight = tables.length ? Math.round((bodyHeight * (1 - textShare)) / tables.length) : 0;
    tables.forEach((table, index) => {
      if (table.type !== "table") return;
      push(table.id ?? `table${suffix}-${index + 1}`, {
        type: "table",
        name: table.id ?? "table",
        frame: { x, y: tableY, w: colWidth, h: Math.max(40, tableHeight), rotation: 0 },
        style: baseStyle(theme, { fontSize: 18, stroke: "#cbd5e1", strokeWidth: 1 }),
        table: {
          header: true,
          rows: [table.header, ...table.rows].map((row) => row.map((cell) => inlineToPlain(cell))),
        },
      }, [table]);
      tableY += tableHeight;
    });
  });
  return out;
}

function textElement(
  name: string,
  paragraphs: Paragraph[],
  box: { x: number; y: number; w: number; h: number },
  style: ElementStyle,
): Omit<CanvasElement, "id" | "z"> {
  return {
    type: "text",
    name,
    frame: { ...box, rotation: 0 },
    style,
    content: { text: paragraphs.map((p) => p.text).join("\n"), paragraphs },
  };
}

function oneLine(text: string): string {
  return inlineToPlain(text).replace(/\s+/g, " ").trim();
}

/** The paragraphs a block contributes to a canvas text element, in order (the sync mirrors this). */
export function blockParagraphs(node: Node): Paragraph[] {
  switch (node.type) {
    case "paragraph":
    case "quote":
      return [{ text: oneLine(node.content), kind: "plain" }];
    case "list":
      return node.items.map((item) => ({ text: oneLine(item.content), kind: node.ordered ? "number" : "bullet", level: 0 }));
    case "code":
      return node.content.split("\n").map((line) => ({ text: line, kind: "plain" }));
    case "section":
      return [{ text: oneLine(node.title), kind: "plain" }, ...node.children.flatMap(blockParagraphs)];
    case "directive":
      if (node.name === "notes" || node.name === "html" || node.name === "svg" || node.name === "script" || node.name === "canvas") return [];
      if (node.children.length > 0) return node.children.flatMap(blockParagraphs);
      return node.body ? node.body.split(/\n{2,}/).map((chunk) => ({ text: oneLine(chunk), kind: "plain" as const })).filter((p) => p.text) : [];
    default:
      return [];
  }
}

function splitColumns(body: Node[]): Node[][] {
  const columnDirectives = body.filter((b): b is DirectiveNode => b.type === "directive" && (b.name === "column" || b.name === "card"));
  if (columnDirectives.length >= 2) return columnDirectives.map((c) => c.children);
  const grid = body.find((b): b is DirectiveNode => b.type === "directive" && (b.name === "grid" || b.name === "columns"));
  if (grid && grid.children.length >= 2) {
    return grid.children.map((c) => (c.type === "directive" ? c.children : [c]));
  }
  const half = Math.ceil(body.length / 2);
  return [body.slice(0, half), body.slice(half)];
}

function notesText(node: DirectiveNode): string {
  if (node.children.length === 0) return (node.body ?? "").trim();
  return node.children.flatMap(blockParagraphs).map((p) => p.text).join("\n");
}

function transitionOf(value: unknown): "none" | "fade" | "slide" {
  return value === "fade" || value === "slide" ? value : "none";
}

function attrString(node: DirectiveNode | undefined, key: string): string | undefined {
  const value = node?.attrs[key];
  return typeof value === "string" && value.trim() ? value : undefined;
}

function isoDate(value: string): string | undefined {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) ? `${value}T00:00:00.000Z` : undefined;
}

function uniqueId(base: string, used: Set<string>): string {
  let id = base;
  for (let n = 2; used.has(id); n += 1) id = `${base}-${n}`;
  used.add(id);
  return id;
}

function slug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "") || "deck";
}
