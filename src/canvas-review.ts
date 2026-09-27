/**
 * Visual review of agent edits to slides and canvases, ported as pure TS from
 * upstream PaperDOM `app/agent-review.tsx` (before/after previews of changed
 * pages) and `diffDocuments` in `app/agent-api.ts` (per-element changes).
 *
 * `reviewSlideChanges` compares two parsed `.noma` documents: every `::deck`
 * is laid out with `buildPaperDom` and every inline `::canvas` is read as
 * canvas JSON, then pages whose elements changed get sanitised SVG previews
 * (from `canvas-svg.ts`) and a change list. No I/O and no script execution.
 */
import type { DirectiveNode, DocumentNode } from "./ast.js";
import { walk } from "./ast.js";
import { canvasPageSvg, canvasSourceOf, frameOf, readCanvasDocument } from "./canvas-svg.js";
import { escapeAttr, escapeHtml } from "./inline.js";
import type { ComponentKit } from "./components.js";
import type { CanvasElement, CanvasPage, PaperDOMDocument } from "./paperdom-document-model.js";
import { auditCanvasPage, type CanvasWarning } from "./canvas-text-metrics.js";
import { buildPaperDom } from "./renderer-paperdom.js";
import { findDecks } from "./slides.js";

export type ElementChangeKind = "created" | "deleted" | "moved" | "resized" | "rotated" | "text" | "style" | "reordered" | "other";

export interface CanvasChange {
  pageId: string;
  elementId?: string;
  action: "created" | "deleted" | "updated" | "moved";
  /** Changed top-level fields (upstream `DocumentChange.fields`). */
  fields: string[];
  /** Human-level classification of an element change: moved/resized/text changed/… */
  kinds: ElementChangeKind[];
}

/** Page-and-element diff of two canvas documents (upstream `diffDocuments`, plus change kinds). */
export function diffCanvasDocuments(before: PaperDOMDocument, after: PaperDOMDocument): CanvasChange[] {
  const changes: CanvasChange[] = [];
  const beforePages = pagesOf(before);
  const afterPages = pagesOf(after);
  for (const pageId of new Set([...beforePages, ...afterPages].map((page) => page.id))) {
    const a = beforePages.find((page) => page.id === pageId);
    const b = afterPages.find((page) => page.id === pageId);
    if (!a || !b) changes.push({ pageId, action: a ? "deleted" : "created", fields: [], kinds: [a ? "deleted" : "created"] });
    else {
      const fields = changedFields(a, b).filter((field) => field !== "elements");
      if (fields.length) changes.push({ pageId, action: "updated", fields, kinds: ["other"] });
      if (beforePages.indexOf(a) !== afterPages.indexOf(b)) changes.push({ pageId, action: "moved", fields: ["index"], kinds: ["reordered"] });
    }
    const oldList = elementsOf(a);
    const newList = elementsOf(b);
    const oldElements = new Map(oldList.map((e) => [e.id, e]));
    const newElements = new Map(newList.map((e) => [e.id, e]));
    for (const elementId of new Set([...oldElements.keys(), ...newElements.keys()])) {
      const old = oldElements.get(elementId);
      const next = newElements.get(elementId);
      if (!old || !next) {
        changes.push({ pageId, elementId, action: old ? "deleted" : "created", fields: [], kinds: [old ? "deleted" : "created"] });
        continue;
      }
      const fields = changedFields(old, next);
      if (fields.length) changes.push({ pageId, elementId, action: "updated", fields, kinds: changeKinds(old, next, fields) });
      if (oldList.indexOf(old) !== newList.indexOf(next)) changes.push({ pageId, elementId, action: "moved", fields: ["index"], kinds: ["reordered"] });
    }
  }
  return changes;
}

function changeKinds(old: CanvasElement, next: CanvasElement, fields: string[]): ElementChangeKind[] {
  const kinds = new Set<ElementChangeKind>();
  for (const field of fields) {
    if (field === "frame") {
      const a = frameOf(old);
      const b = frameOf(next);
      if (a.x !== b.x || a.y !== b.y) kinds.add("moved");
      if (a.w !== b.w || a.h !== b.h) kinds.add("resized");
      if (a.rotation !== b.rotation) kinds.add("rotated");
    } else if (field === "content" || field === "table" || field === "chart" || field === "runs") kinds.add("text");
    else if (field === "style") kinds.add("style");
    else if (field === "z") kinds.add("reordered");
    else kinds.add("other");
  }
  return [...kinds];
}

const KIND_LABELS: Record<ElementChangeKind, string> = {
  created: "added",
  deleted: "removed",
  moved: "moved",
  resized: "resized",
  rotated: "rotated",
  text: "text changed",
  style: "restyled",
  reordered: "reordered",
  other: "changed",
};

const CLASSIFIED_FIELDS = new Set(["frame", "content", "table", "chart", "runs", "style", "z"]);

/** "moved, resized, text changed" for one change. */
export function describeChange(change: CanvasChange): string {
  const other = change.fields.filter((field) => !CLASSIFIED_FIELDS.has(field) && field !== "index");
  return change.kinds.map((kind) => (kind === "other" && other.length ? `changed ${other.join(", ")}` : KIND_LABELS[kind])).join(", ");
}

export interface SlideReviewPage {
  /** `deck` for a `::deck` slide, `canvas` for a `::canvas` page. */
  source: "deck" | "canvas";
  /** Block ID of the `::deck` or `::canvas`. */
  containerId: string;
  pageId: string;
  name: string;
  /** Sanitised SVG of the page before the edit; absent for a new page. */
  beforeSvg?: string;
  /** Sanitised SVG of the page after the edit; absent for a deleted page. */
  afterSvg?: string;
  changes: CanvasChange[];
  /** Layout warnings on the page after the edit (estimated text overflow, off-page elements). */
  warnings: CanvasWarning[];
}

export interface SlideReview {
  pages: SlideReviewPage[];
}

export interface SlideReviewOptions {
  components?: ComponentKit;
}

/**
 * Before/after review of every deck slide and inline canvas page whose layout
 * changed between two documents. Returns `undefined` when neither document
 * has a `::deck` or `::canvas`, or nothing visual changed.
 */
export function reviewSlideChanges(before: DocumentNode, after: DocumentNode, options: SlideReviewOptions = {}): SlideReview | undefined {
  const pages: SlideReviewPage[] = [];
  const containers = new Map<string, { source: "deck" | "canvas"; before?: PaperDOMDocument; after?: PaperDOMDocument }>();
  const collect = (doc: DocumentNode, side: "before" | "after"): void => {
    for (const [key, entry] of visualContainers(doc, options)) {
      const slot = containers.get(key) ?? { source: entry.source };
      slot[side] = entry.document;
      containers.set(key, slot);
    }
  };
  collect(before, "before");
  collect(after, "after");
  for (const [key, entry] of containers) {
    const containerId = key.slice(key.indexOf(":") + 1);
    const a = entry.before ?? emptyCanvas();
    const b = entry.after ?? emptyCanvas();
    const changes = diffCanvasDocuments(a, b);
    const changedPageIds = [...new Set(changes.map((change) => change.pageId))];
    for (const pageId of changedPageIds) {
      const beforePage = pagesOf(a).find((page) => page.id === pageId);
      const afterPage = pagesOf(b).find((page) => page.id === pageId);
      const prefix = `review-${containerId}-${pageId}`;
      pages.push({
        source: entry.source,
        containerId,
        pageId,
        name: pageName(afterPage ?? beforePage, pageId),
        ...(beforePage ? { beforeSvg: canvasPageSvg(beforePage, { idPrefix: `${prefix}-before`, label: `Before: ${pageName(beforePage, pageId)}` }) } : {}),
        ...(afterPage ? { afterSvg: canvasPageSvg(afterPage, { idPrefix: `${prefix}-after`, label: `After: ${pageName(afterPage, pageId)}` }) } : {}),
        changes: changes.filter((change) => change.pageId === pageId),
        warnings: afterPage ? auditCanvasPage(afterPage) : [],
      });
    }
  }
  return pages.length > 0 ? { pages } : undefined;
}

function visualContainers(doc: DocumentNode, options: SlideReviewOptions): Map<string, { source: "deck" | "canvas"; document: PaperDOMDocument }> {
  const out = new Map<string, { source: "deck" | "canvas"; document: PaperDOMDocument }>();
  findDecks(doc).forEach((deck, index) => {
    if (!deck.id && index > 0) return;
    try {
      const built = buildPaperDom(doc, { ...(options.components ? { components: options.components } : {}), ...(deck.id ? { deck: deck.id } : {}) });
      out.set(`deck:${deck.id ?? "deck"}`, { source: "deck", document: built.document });
    } catch {
      // A deck that cannot be laid out has nothing to preview.
    }
  });
  let anonymous = 0;
  for (const node of walk(doc)) {
    if (node.type !== "directive" || node.name !== "canvas") continue;
    const { json } = canvasSourceOf(node as DirectiveNode);
    if (json === undefined) continue;
    const read = readCanvasDocument(json);
    if (read.ok) out.set(`canvas:${node.id ?? `canvas-${++anonymous}`}`, { source: "canvas", document: read.document });
  }
  return out;
}

/** Proof-page section: before/after previews side by side with the change list and layout warnings. */
export function slideReviewHtml(review: SlideReview): string {
  const figures = review.pages
    .map((page) => {
      const side = (label: string, svg: string | undefined, missing: string): string =>
        `<figure class="slide-review-frame"><figcaption>${label}</figcaption>${svg ? `<div class="slide-review-svg">${svg}</div>` : `<div class="slide-review-missing">${missing}</div>`}</figure>`;
      const changes = page.changes
        .map((change) => `<li><strong>${escapeHtml(describeChange(change))}</strong> <code>${escapeHtml(change.elementId ?? change.pageId)}</code></li>`)
        .join("");
      const warnings = page.warnings.length
        ? `<ul class="slide-review-warnings">${page.warnings.map((w) => `<li><code>${escapeHtml(w.elementId)}</code> ${escapeHtml(w.message)}</li>`).join("")}</ul>`
        : "";
      return `<article class="slide-review" data-page="${escapeAttr(page.pageId)}">
<h3>${escapeHtml(page.name)} <code>${escapeHtml(page.source)}:${escapeHtml(page.containerId)}/${escapeHtml(page.pageId)}</code></h3>
<div class="slide-review-pair">${side("Before", page.beforeSvg, "New slide")}${side("After", page.afterSvg, "Slide removed")}</div>
<ul class="slide-review-changes">${changes}</ul>${warnings}
</article>`;
    })
    .join("\n");
  return `<section class="proof-section">
    <h2>Visual Review</h2>
    <p class="muted">${review.pages.length} changed slide${review.pages.length === 1 ? "" : "s"} or canvas page${review.pages.length === 1 ? "" : "s"}. Previews are static SVG renders of the PaperDOM layout.</p>
    ${figures}
  </section>`;
}

/** Styles for `slideReviewHtml`, appended to the proof page stylesheet. */
export const SLIDE_REVIEW_CSS = `
  .slide-review { border-top: 1px solid var(--rule); padding-top: 14px; margin-top: 14px; }
  .slide-review h3 { margin: 0 0 10px; font-size: .98rem; }
  .slide-review-pair { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 14px; }
  .slide-review-frame { margin: 0; }
  .slide-review-frame figcaption { color: var(--muted); font-size: .76rem; font-weight: 720; text-transform: uppercase; margin-bottom: 4px; }
  .slide-review-svg svg { display: block; width: 100%; height: auto; border: 1px solid var(--rule); border-radius: 6px; background: white; }
  .slide-review-missing { border: 1px dashed var(--rule); border-radius: 6px; padding: 32px; text-align: center; color: var(--muted); }
  .slide-review-changes, .slide-review-warnings { margin: 10px 0 0; padding-left: 20px; font-size: .9rem; }
  .slide-review-warnings { color: var(--warn); }
  @media (max-width: 860px) { .slide-review-pair { grid-template-columns: 1fr; } }
`;

function pagesOf(document: PaperDOMDocument): CanvasPage[] {
  return (Array.isArray(document.pages) ? document.pages : []).filter((page): page is CanvasPage => isRecord(page) && typeof page.id === "string");
}

function elementsOf(page: CanvasPage | undefined): CanvasElement[] {
  return (page && Array.isArray(page.elements) ? page.elements : []).filter((el): el is CanvasElement => isRecord(el) && typeof el.id === "string");
}

function pageName(page: CanvasPage | undefined, fallback: string): string {
  return page && typeof page.name === "string" && page.name.trim() ? page.name : fallback;
}

function emptyCanvas(): PaperDOMDocument {
  return { format: "paperdom", version: "0.1", id: "empty", title: "", revision: 0, pages: [], plugins: [], metadata: { createdAt: "", updatedAt: "" } } as PaperDOMDocument;
}

function equalValues(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (!a || !b || typeof a !== "object" || typeof b !== "object") return false;
  if (Array.isArray(a) || Array.isArray(b)) return Array.isArray(a) && Array.isArray(b) && a.length === b.length && a.every((value, index) => equalValues(value, b[index]));
  const first = a as Record<string, unknown>;
  const second = b as Record<string, unknown>;
  const keys = new Set([...Object.keys(first), ...Object.keys(second)]);
  return [...keys].every((key) => equalValues(first[key], second[key]));
}

function changedFields(before: object, after: object): string[] {
  const a = before as Record<string, unknown>;
  const b = after as Record<string, unknown>;
  return [...new Set([...Object.keys(a), ...Object.keys(b)])].filter((key) => !equalValues(a[key], b[key]));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
