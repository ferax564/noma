/**
 * Pure, dependency-free text metrics for PaperDOM canvases, ported from
 * upstream `app/text-metrics.ts` and the text/page checks of `auditDocument`
 * in `app/agent-api.ts`. These are estimates for warnings, not measurements:
 * the browser lays out text with real fonts. Width factors are calibrated for
 * common sans/serif/mono stacks and deliberately overestimate slightly.
 *
 * Inputs may come from untrusted canvas JSON, so frames, styles, and text are
 * read through the same sanitising helpers the SVG renderer uses.
 */
import { canvasPageSize, frameOf, paragraphsOf } from "./canvas-svg.js";
import type { CanvasElement, CanvasPage, ElementStyle, PaperDOMDocument } from "./paperdom-document-model.js";

/** Defaults match what `canvas-svg.ts` draws when a style field is missing. */
const DEFAULT_FONT_SIZE = 24;
const DEFAULT_LINE_HEIGHT = 1.3;

function widthFactor(fontFamily: string): number {
  if (/courier|mono/i.test(fontFamily)) return 0.62;
  if (/georgia|times|garamond|serif/i.test(fontFamily)) return 0.5;
  if (/verdana/i.test(fontFamily)) return 0.58;
  return 0.53;
}

export interface TextFitEstimate {
  lines: number;
  estimatedHeight: number;
  availableHeight: number;
  overflow: boolean;
  /** Largest font size (≥ 8) estimated to fit; equals the current size when nothing overflows. */
  suggestedFontSize: number;
}

/** Estimate the rendered height of text inside a `frameW` × `frameH` box. */
export function estimateTextFit(text: string, style: Partial<ElementStyle>, frameW: number, frameH: number): TextFitEstimate {
  const fontSize = positive(style.fontSize, DEFAULT_FONT_SIZE, 800);
  const lineHeight = positive(style.lineHeight, DEFAULT_LINE_HEIGHT, 5);
  const padding = positive(style.padding, 0, 400) * 2;
  const innerWidth = Math.max(1, frameW - padding);
  const charWidth = fontSize * widthFactor(typeof style.fontFamily === "string" ? style.fontFamily : "");
  const charsPerLine = Math.max(1, Math.floor(innerWidth / charWidth));
  let lines = 0;
  for (const line of text.replace(/\r\n?/g, "\n").split("\n")) {
    lines += line.length === 0 ? 1 : Math.max(1, Math.ceil(line.length / charsPerLine));
  }
  const estimatedHeight = Math.round(lines * fontSize * lineHeight);
  const availableHeight = Math.max(1, Math.round(frameH));
  let suggestedFontSize = fontSize;
  if (estimatedHeight > availableHeight && fontSize > 8) {
    suggestedFontSize = Math.max(8, Math.floor(fontSize * (availableHeight / estimatedHeight)));
  }
  return { lines, estimatedHeight, availableHeight, overflow: estimatedHeight > availableHeight * 1.02, suggestedFontSize };
}

/** Elements whose text the renderer draws inside the frame. */
export function isTextBearing(element: CanvasElement): boolean {
  return (element.type === "text" || element.type === "shape" || element.type === "ellipse") && !element.hidden;
}

/** The text an element draws, with bullet/number markers as the SVG renderer adds them. */
export function elementDrawnText(element: CanvasElement): string {
  let number = 0;
  return paragraphsOf(element)
    .map((p) => {
      number = p.kind === "number" ? number + 1 : 0;
      const indent = p.kind === "plain" ? "" : "  ".repeat(1 + p.level);
      return `${indent}${p.kind === "bullet" ? "• " : p.kind === "number" ? `${number}. ` : ""}${p.text}`;
    })
    .join("\n");
}

export type CanvasWarningCode = "text_overflow" | "outside_page";

export interface CanvasWarning {
  code: CanvasWarningCode;
  pageId: string;
  elementId: string;
  message: string;
  fit?: TextFitEstimate;
}

/** Layout warnings for one page: estimated text overflow and elements past the page edge. */
export function auditCanvasPage(page: CanvasPage): CanvasWarning[] {
  const warnings: CanvasWarning[] = [];
  const pageId = typeof page.id === "string" ? page.id : "";
  const size = canvasPageSize(page);
  const elements = Array.isArray(page.elements) ? page.elements : [];
  for (const element of elements) {
    if (!element || typeof element !== "object" || element.hidden) continue;
    const elementId = typeof element.id === "string" ? element.id : "";
    const label = typeof element.name === "string" && element.name.trim() ? element.name : elementId;
    const frame = frameOf(element);
    if (isTextBearing(element)) {
      const text = elementDrawnText(element);
      if (text.trim()) {
        const style = (element.style && typeof element.style === "object" ? element.style : {}) as Partial<ElementStyle>;
        const fit = estimateTextFit(text, style, frame.w, frame.h);
        if (fit.overflow) {
          warnings.push({
            code: "text_overflow",
            pageId,
            elementId,
            fit,
            message: `${label} text is estimated to overflow its frame (about ${fit.estimatedHeight}px in ${fit.availableHeight}px; ~${fit.suggestedFontSize}px type would fit). Shorten the text, split the slide, or enlarge the frame.`,
          });
        }
      }
    }
    if (element.type !== "line" && element.type !== "connector") {
      const radians = (frame.rotation * Math.PI) / 180;
      const width = Math.abs(frame.w * Math.cos(radians)) + Math.abs(frame.h * Math.sin(radians));
      const height = Math.abs(frame.w * Math.sin(radians)) + Math.abs(frame.h * Math.cos(radians));
      const cx = frame.x + frame.w / 2;
      const cy = frame.y + frame.h / 2;
      if (cx - width / 2 < -0.01 || cy - height / 2 < -0.01 || cx + width / 2 > size.width + 0.01 || cy + height / 2 > size.height + 0.01) {
        warnings.push({ code: "outside_page", pageId, elementId, message: `${label} extends outside the page.` });
      }
    }
  }
  return warnings;
}

/** `auditCanvasPage` over every page of a canvas document. */
export function auditCanvasDocument(document: PaperDOMDocument): CanvasWarning[] {
  const pages = Array.isArray(document.pages) ? document.pages : [];
  return pages.filter((page) => page && typeof page === "object").flatMap((page) => auditCanvasPage(page));
}

function positive(value: unknown, fallback: number, max: number): number {
  const n = typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
  return Math.min(max, n);
}
