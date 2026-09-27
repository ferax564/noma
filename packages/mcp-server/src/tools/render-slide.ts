import { readFileSync } from "node:fs";
import { canvasPageSvg, isBookManifestPath, parse, renderPaperDom, renderSlidePngs, slidePngPages } from "@ferax564/noma-cli";

export interface RenderSlideInput {
  file: string;
  slide: string;
  deck?: string;
  png?: boolean;
}

export interface RenderSlideResult {
  id: string;
  name: string;
  width: number;
  height: number;
  /** Sanitised static SVG of the slide. */
  svg: string;
  /** Base64 PNG, when requested and a headless browser is available. */
  png?: string;
  /** Why the PNG is missing, when requested but unavailable. */
  pngError?: string;
}

/** Lays a deck slide out as PaperDOM and returns its SVG (and PNG on request). */
export async function renderSlide(input: RenderSlideInput): Promise<RenderSlideResult> {
  if (isBookManifestPath(input.file)) {
    throw new Error("book manifests are not supported by render_slide — use the CLI");
  }
  const doc = parse(readFileSync(input.file, "utf8"), { filename: input.file });
  const canvas = renderPaperDom(doc, input.deck ? { deck: input.deck } : {});
  const page = canvas.pages.find((candidate) => candidate.id === input.slide);
  if (!page) throw new Error(`No slide "${input.slide}". Slides: ${canvas.pages.map((p) => p.id).join(", ")}`);
  const result: RenderSlideResult = {
    id: page.id,
    name: page.name,
    width: page.size.width,
    height: page.size.height,
    svg: canvasPageSvg(page),
  };
  if (input.png) {
    try {
      const [rendered] = await renderSlidePngs(slidePngPages(canvas, { slide: page.id }));
      if (rendered) result.png = rendered.png.toString("base64");
    } catch (error) {
      result.pngError = error instanceof Error ? error.message : String(error);
    }
  }
  return result;
}
