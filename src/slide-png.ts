/**
 * Headless slide rendering: one PNG per slide so agents can see their work.
 * Ported from upstream PaperDOM `scripts/paperdom-render.mjs`, but rendered
 * from Noma's sanitised static SVG (`canvas-svg.ts`) instead of the editor's
 * HTML, inside a Chromium page with JavaScript disabled, a CSP that forbids
 * scripts, and every non-`data:` request blocked.
 *
 * `slidePngPages` is pure (canvas → page HTML); `renderSlidePngs` drives
 * Puppeteer, which is an optional peer dependency (see `pdf.ts`).
 */
import type { DocumentNode } from "./ast.js";
import { canvasPageSize, canvasPageSvg } from "./canvas-svg.js";
import type { ComponentKit } from "./components.js";
import type { CanvasPage, PaperDOMDocument } from "./paperdom-document-model.js";
import { renderPaperDom } from "./renderer-paperdom.js";

export interface SlidePngPage {
  /** Slide block ID (the PaperDOM page id). */
  id: string;
  /** Deterministic output name: `<NN>-<slide-id>.png`, NN = 1-based position in the deck. */
  fileName: string;
  width: number;
  height: number;
  /** Self-contained HTML page holding only the slide SVG; no scripts, no external resources. */
  html: string;
}

export interface SlidePngSelection {
  /** Only this slide (page id). Hidden slides are included when asked for by ID. */
  slide?: string;
}

/** HTML pages to screenshot for a canvas document, one per visible page (or just `slide`). */
export function slidePngPages(document: PaperDOMDocument, selection: SlidePngSelection = {}): SlidePngPage[] {
  const all = (Array.isArray(document.pages) ? document.pages : []).filter((page): page is CanvasPage => typeof page === "object" && page !== null && typeof page.id === "string");
  const width = Math.max(2, String(all.length).length);
  const chosen = all
    .map((page, index) => ({ page, index }))
    .filter(({ page }) => (selection.slide ? page.id === selection.slide : !page.hidden));
  if (selection.slide && chosen.length === 0) {
    throw new Error(`No slide "${selection.slide}". Slides: ${all.map((page) => page.id).join(", ") || "none"}.`);
  }
  return chosen.map(({ page, index }) => {
    const size = canvasPageSize(page);
    return {
      id: page.id,
      fileName: `${String(index + 1).padStart(width, "0")}-${safeFileName(page.id)}.png`,
      width: size.width,
      height: size.height,
      html: slidePageHtml(page),
    };
  });
}

/** `slidePngPages` for a `.noma` document: its `::deck` (or one slide per section). */
export function documentSlidePngPages(doc: DocumentNode, options: SlidePngSelection & { deck?: string; components?: ComponentKit } = {}): SlidePngPage[] {
  const canvas = renderPaperDom(doc, { ...(options.deck ? { deck: options.deck } : {}), ...(options.components ? { components: options.components } : {}) });
  return slidePngPages(canvas, options.slide ? { slide: options.slide } : {});
}

const PAGE_CSP = "default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:";

function slidePageHtml(page: CanvasPage): string {
  return `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${PAGE_CSP}"><style>html,body{margin:0;padding:0;overflow:hidden;background:#fff}svg{display:block}</style></head><body>${canvasPageSvg(page)}</body></html>`;
}

function safeFileName(id: string): string {
  return id.replace(/[^A-Za-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 120) || "slide";
}

export class SlideRenderUnavailableError extends Error {}

export interface SlidePngRenderOptions {
  /** Device scale factor (1 = slide pixels, 2 = retina). Clamped to 0.25–4. */
  scale?: number;
  timeoutMs?: number;
}

/**
 * Screenshots each page with Puppeteer. JavaScript is disabled and only
 * `data:` requests are allowed, so a slide can never run script or reach the
 * network. Throws `SlideRenderUnavailableError` when Puppeteer or its browser
 * is not installed.
 */
export async function renderSlidePngs(pages: SlidePngPage[], options: SlidePngRenderOptions = {}): Promise<Array<{ page: SlidePngPage; png: Buffer }>> {
  if (pages.length === 0) return [];
  const puppeteer = await import("puppeteer").catch((error: unknown) => {
    throw new SlideRenderUnavailableError(`PNG rendering requires Puppeteer: npm i puppeteer (${error instanceof Error ? error.message : String(error)})`);
  });
  const browser = await puppeteer.default.launch({ headless: true, args: ["--no-sandbox"] }).catch((error: unknown) => {
    throw new SlideRenderUnavailableError(`PNG rendering could not start a browser (${error instanceof Error ? error.message : String(error)})`);
  });
  const scale = Math.min(4, Math.max(0.25, options.scale ?? 1));
  const timeout = options.timeoutMs ?? 30_000;
  try {
    const out: Array<{ page: SlidePngPage; png: Buffer }> = [];
    for (const slide of pages) {
      const tab = await browser.newPage();
      try {
        tab.setDefaultTimeout(timeout);
        await tab.setJavaScriptEnabled(false);
        await tab.setRequestInterception(true);
        tab.on("request", (request) => {
          if (request.url().startsWith("data:")) void request.continue();
          else void request.abort("blockedbyclient");
        });
        await tab.setViewport({ width: slide.width, height: slide.height, deviceScaleFactor: scale });
        await tab.setContent(slide.html, { waitUntil: "load", timeout });
        const png = await tab.screenshot({ type: "png", clip: { x: 0, y: 0, width: slide.width, height: slide.height } });
        out.push({ page: slide, png: Buffer.from(png) });
      } finally {
        await tab.close();
      }
    }
    return out;
  } finally {
    await browser.close();
  }
}
