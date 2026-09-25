/**
 * Slide strip: a filmstrip of the current page's slides above the editor.
 * Thumbnails are drawn from the page source through the PaperDOM canvas model,
 * so they match `--to paperdom` / `.pptx`. Clicking a slide reveals it in the
 * source, visual editor, and preview; dragging (or Alt+←/→) reorders slides with a
 * `move_block` patch, and the eye button toggles `hidden`. Every change is an
 * ordinary source edit that goes through save/proposals like any other.
 */
import type { DirectiveNode, DocumentNode, Node } from "../../src/ast.js";
import { walk } from "../../src/ast.js";
import { canvasPageSvg } from "../../src/canvas-svg.js";
import { type PatchOp, patchSource } from "../../src/patch.js";
import { parse } from "../../src/parser.js";
import { buildPaperDom } from "../../src/renderer-paperdom.js";
import { presentationSlides } from "../../src/slides.js";
import type { ComponentKit } from "../../src/components.js";
import { sourceInput } from "./dom.js";
import { focusSourceLine, markDirty, renderCurrent, syncTitleFromSource } from "./editor.js";
import { canEditPage } from "./permissions.js";
import { state } from "./state.js";
import { errorMessage, setCloudStatus } from "./util.js";

const strip = requireElement<HTMLElement>("slideStrip");
const list = requireElement<HTMLOListElement>("slideStripList");
const summary = requireElement<HTMLElement>("slideStripSummary");
const addButton = requireElement<HTMLButtonElement>("slideStripAddButton");
const toggleButton = requireElement<HTMLButtonElement>("slideStripToggleButton");

interface StripSlide {
  id: string;
  title: string;
  hidden: boolean;
  notes: boolean;
  line?: number;
  svg: string;
}

interface StripModel {
  pageId: string;
  deck?: DirectiveNode;
  /** Slides are real `::slide` blocks in a deck that holds only slides, so they can be moved and hidden. */
  editable: boolean;
  fromSections: boolean;
  slides: StripSlide[];
}

let model: StripModel | undefined;
/** Per-page user choice; unset means "show when the page has a deck". */
const shownOverride = new Map<string, boolean>();
let dragId: string | undefined;
let lastKey = "";

export function installSlideStrip(): void {
  toggleButton.addEventListener("click", () => {
    const pageId = state.currentPage?.id;
    if (!pageId) return;
    shownOverride.set(pageId, !stripShown());
    lastKey = "";
    renderSlideStrip();
  });
  addButton.addEventListener("click", () => addSlide());
  sourceInput.addEventListener("click", markActiveFromCursor);
  sourceInput.addEventListener("keyup", markActiveFromCursor);
}

function stripShown(): boolean {
  const pageId = state.currentPage?.id;
  if (!pageId) return false;
  return shownOverride.get(pageId) ?? Boolean(model?.deck);
}

/** Rebuilds the strip from the last render (called after every preview render). */
export function renderSlideStrip(components?: ComponentKit): void {
  const doc = state.renderState.doc;
  const page = state.currentPage;
  if (!doc || !page) {
    model = undefined;
    strip.hidden = true;
    toggleButton.hidden = true;
    lastKey = "";
    return;
  }
  const presentation = presentationSlides(doc);
  const deck = presentation.deck;
  const shownBefore = shownOverride.get(page.id) ?? Boolean(deck);
  toggleButton.hidden = false;
  toggleButton.setAttribute("aria-pressed", String(shownBefore));
  if (!shownBefore) {
    model = { pageId: page.id, ...(deck ? { deck } : {}), editable: false, fromSections: presentation.fromSections, slides: [] };
    strip.hidden = true;
    lastKey = "";
    return;
  }
  const key = `${page.id}\u0000${sourceInput.value}\u0000${canEditPage()}`;
  if (key === lastKey) return;
  lastKey = key;
  try {
    model = buildModel(doc, page.id, components);
  } catch (error) {
    model = undefined;
    summary.textContent = `Slides unavailable: ${errorMessage(error)}`;
    list.textContent = "";
    strip.hidden = false;
    return;
  }
  strip.hidden = false;
  drawStrip(model);
}

function buildModel(doc: DocumentNode, pageId: string, components?: ComponentKit): StripModel {
  const presentation = presentationSlides(doc);
  const deck = presentation.deck;
  const { document, pages } = buildPaperDom(doc, components ? { components } : {});
  const lines = blockLines(doc);
  const slides: StripSlide[] = pages.map((source, index) => {
    const page = document.pages[index]!;
    const id = source.slide.id ?? source.pageId;
    return {
      id,
      title: page.name || id,
      hidden: source.slide.attrs.hidden === true,
      notes: Boolean(page.notes),
      ...(lines.has(id) ? { line: lines.get(id)! } : {}),
      svg: canvasPageSvg({ ...page, hidden: false }, { idPrefix: `strip-${index}`, label: `Slide ${index + 1}: ${page.name || id}` }),
    };
  });
  const editable = Boolean(
    deck?.id &&
      canEditPage() &&
      deck.children.length > 0 &&
      deck.children.every((child) => child.type === "directive" && child.name === "slide" && Boolean(child.id)),
  );
  return { pageId, ...(deck ? { deck } : {}), editable, fromSections: presentation.fromSections, slides: presentation.slides.length ? slides : [] };
}

function blockLines(doc: DocumentNode): Map<string, number> {
  const out = new Map<string, number>();
  for (const node of walk(doc) as Iterable<Node>) {
    if (node.id && node.pos?.line && !out.has(node.id)) out.set(node.id, node.pos.line);
  }
  return out;
}

function drawStrip(current: StripModel): void {
  list.textContent = "";
  const count = current.slides.length;
  const hidden = current.slides.filter((slide) => slide.hidden).length;
  summary.textContent = current.fromSections
    ? `${count} slide${count === 1 ? "" : "s"} from sections`
    : `${count} slide${count === 1 ? "" : "s"}${hidden ? ` · ${hidden} hidden` : ""}`;
  addButton.hidden = !current.deck?.id || !canEditPage();
  list.dataset.editable = String(current.editable);
  current.slides.forEach((slide, index) => list.append(thumb(slide, index, current)));
  if (count === 0) {
    const empty = document.createElement("li");
    empty.className = "slide-strip-empty";
    empty.textContent = "No slides yet";
    list.append(empty);
  }
  markActiveFromCursor();
}

function thumb(slide: StripSlide, index: number, current: StripModel): HTMLLIElement {
  const item = document.createElement("li");
  item.className = "slide-thumb";
  item.dataset.slideId = slide.id;
  if (slide.hidden) item.dataset.hidden = "true";
  const open = document.createElement("button");
  open.type = "button";
  open.className = "slide-thumb-open";
  open.setAttribute("aria-label", `Slide ${index + 1}: ${slide.title}${slide.hidden ? " (hidden)" : ""}${current.editable ? ". Alt+Left or Alt+Right to move" : ""}`);
  const frame = document.createElement("span");
  frame.className = "slide-thumb-frame";
  frame.innerHTML = slide.svg;
  const meta = document.createElement("span");
  meta.className = "slide-thumb-meta";
  const number = document.createElement("span");
  number.className = "slide-thumb-number";
  number.textContent = String(index + 1);
  const title = document.createElement("span");
  title.className = "slide-thumb-title";
  title.textContent = slide.title;
  meta.append(number, title);
  if (slide.notes) {
    const notes = document.createElement("span");
    notes.className = "slide-thumb-badge";
    notes.title = "Has speaker notes";
    notes.textContent = "notes";
    meta.append(notes);
  }
  open.append(frame, meta);
  open.addEventListener("click", () => revealSlide(slide));
  open.addEventListener("keydown", (event) => {
    if (!current.editable || !event.altKey || (event.key !== "ArrowLeft" && event.key !== "ArrowRight")) return;
    event.preventDefault();
    moveSlide(slide.id, index + (event.key === "ArrowLeft" ? -1 : 1), true);
  });
  item.append(open);
  if (current.editable) {
    const eye = document.createElement("button");
    eye.type = "button";
    eye.className = "slide-thumb-hide";
    eye.textContent = slide.hidden ? "Show" : "Hide";
    eye.setAttribute("aria-label", `${slide.hidden ? "Show" : "Hide"} slide ${index + 1} when presenting`);
    eye.addEventListener("click", () => toggleHidden(slide));
    item.append(eye);
    item.draggable = true;
    item.addEventListener("dragstart", (event) => {
      dragId = slide.id;
      item.dataset.dragging = "true";
      event.dataTransfer?.setData("text/plain", slide.id);
      if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
    });
    item.addEventListener("dragend", () => {
      dragId = undefined;
      delete item.dataset.dragging;
      for (const el of list.querySelectorAll<HTMLElement>("[data-drop]")) delete el.dataset.drop;
    });
    item.addEventListener("dragover", (event) => {
      if (!dragId || dragId === slide.id) return;
      event.preventDefault();
      const after = event.offsetX > item.clientWidth / 2;
      item.dataset.drop = after ? "after" : "before";
    });
    item.addEventListener("dragleave", () => delete item.dataset.drop);
    item.addEventListener("drop", (event) => {
      event.preventDefault();
      const moving = dragId ?? event.dataTransfer?.getData("text/plain");
      const after = item.dataset.drop === "after";
      delete item.dataset.drop;
      if (!moving || moving === slide.id) return;
      const from = current.slides.findIndex((s) => s.id === moving);
      let to = index + (after ? 1 : 0);
      if (from !== -1 && from < to) to -= 1;
      moveSlide(moving, to, false);
    });
  }
  return item;
}

/** Shows a slide in every open view: source cursor, visual card, and preview. */
export function revealSlide(slide: { id: string; line?: number }): void {
  if (slide.line) focusSourceLine(slide.line);
  const visual = document.querySelector<HTMLElement>(`#visualEditor [data-id="${cssEscape(slide.id)}"]`);
  visual?.scrollIntoView({ block: "start", behavior: "smooth" });
  const frame = document.querySelector<HTMLIFrameElement>("#previewFrame");
  try {
    frame?.contentDocument?.getElementById(slide.id)?.scrollIntoView({ block: "start", behavior: "smooth" });
  } catch {
    // The preview is same-origin; a blocked frame just keeps its scroll position.
  }
  setActive(slide.id);
}

function moveSlide(id: string, position: number, keepFocus: boolean): void {
  const current = model;
  const deckId = current?.deck?.id;
  if (!current?.editable || !deckId) return;
  const bounded = Math.max(0, Math.min(current.slides.length - 1, position));
  const from = current.slides.findIndex((slide) => slide.id === id);
  if (from === -1 || from === bounded) return;
  applyOps([{ op: "move_block", id, parent: deckId, position: bounded }], `Moved slide to position ${bounded + 1}`);
  if (keepFocus) list.querySelector<HTMLButtonElement>(`[data-slide-id="${cssEscape(id)}"] .slide-thumb-open`)?.focus();
}

function toggleHidden(slide: StripSlide): void {
  const op: PatchOp = slide.hidden
    ? { op: "remove_attribute", id: slide.id, key: "hidden" }
    : { op: "update_attribute", id: slide.id, key: "hidden", value: true };
  applyOps([op], slide.hidden ? "Slide shown when presenting" : "Slide hidden when presenting");
}

function addSlide(): void {
  const deck = model?.deck;
  if (!deck?.id || !canEditPage()) return;
  const doc = parse(sourceInput.value);
  const ids = new Set<string>();
  for (const node of walk(doc) as Iterable<Node>) if (node.id) ids.add(node.id);
  let n = model!.slides.length + 1;
  while (ids.has(`slide-${n}`)) n += 1;
  const id = `slide-${n}`;
  const deckLine = sourceInput.value.split("\n")[(deck.pos?.line ?? 1) - 1] ?? "::";
  const fence = ":".repeat(Math.max(2, /^(:+)/.exec(deckLine)?.[1]?.length ?? 2) + 1);
  const content = `${fence}slide{id="${id}" title="New slide"}\n- First point\n${fence}`;
  if (applyOps([{ op: "add_block", parent: deck.id, content }], "Added a slide")) {
    const line = blockLines(parse(sourceInput.value)).get(id);
    revealSlide({ id, ...(line ? { line } : {}) });
  }
}

function applyOps(ops: PatchOp[], status: string): boolean {
  try {
    const next = patchSource(sourceInput.value, ops);
    if (next === sourceInput.value) return false;
    sourceInput.value = next;
    markDirty();
    syncTitleFromSource();
    renderCurrent();
    setCloudStatus(status, "ok");
    return true;
  } catch (error) {
    setCloudStatus(errorMessage(error), "error");
    return false;
  }
}

function markActiveFromCursor(): void {
  if (!model || strip.hidden) return;
  const line = sourceInput.value.slice(0, sourceInput.selectionStart).split("\n").length;
  let active: string | undefined;
  for (const slide of model.slides) if (slide.line && slide.line <= line) active = slide.id;
  setActive(active);
}

function setActive(id: string | undefined): void {
  for (const item of list.querySelectorAll<HTMLElement>(".slide-thumb")) {
    if (item.dataset.slideId === id) item.setAttribute("aria-current", "true");
    else item.removeAttribute("aria-current");
  }
}

function cssEscape(value: string): string {
  return typeof CSS !== "undefined" && typeof CSS.escape === "function" ? CSS.escape(value) : value.replace(/["\\\]]/g, "\\$&");
}

function requireElement<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`Missing #${id}`);
  return el as T;
}
