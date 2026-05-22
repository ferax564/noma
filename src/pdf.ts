import { existsSync, mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { PDFOptions, PaperFormat } from "puppeteer";

export interface PdfMarginOptions {
  top: string;
  right: string;
  bottom: string;
  left: string;
}

export interface PdfWriteOptions {
  pageSize?: string;
  margin?: PdfMarginOptions;
  printBackground?: boolean;
}

const DEFAULT_MARGIN: PdfMarginOptions = {
  top: "20mm",
  right: "18mm",
  bottom: "20mm",
  left: "18mm",
};

export async function writePdfFromHtml(
  html: string,
  outPath: string,
  options: PdfWriteOptions = {},
): Promise<void> {
  const outputPath = resolve(outPath);
  const outDir = dirname(outputPath);
  if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

  const tempHtmlPath = resolve(
    outDir,
    `.${basename(outputPath)}.${process.pid}.${Date.now()}.html`,
  );

  try {
    writeFileSync(tempHtmlPath, html, "utf8");
    const puppeteer = await import("puppeteer").catch((error: unknown) => {
      const cause = error instanceof Error ? ` (${error.message})` : "";
      throw new Error(
        `PDF rendering requires Puppeteer. Install it with "npm install puppeteer" or run inside the Noma repo after "npm install".${cause}`,
      );
    });
    const browser = await puppeteer.default.launch({
      headless: true,
      args: ["--no-sandbox"],
    });
    try {
      const page = await browser.newPage();
      await page.goto(pathToFileURL(tempHtmlPath).toString(), { waitUntil: "networkidle0" });
      await page.emulateMediaType("print");
      const pdfOptions: PDFOptions = {
        path: outputPath,
        format: (options.pageSize ?? "A4") as PaperFormat,
        printBackground: options.printBackground !== false,
        margin: options.margin ?? DEFAULT_MARGIN,
      };
      await page.pdf(pdfOptions);
      await page.close();
    } finally {
      await browser.close();
    }
  } finally {
    try {
      unlinkSync(tempHtmlPath);
    } catch {
      // Best-effort cleanup; PDF output has already succeeded or failed.
    }
  }
}
