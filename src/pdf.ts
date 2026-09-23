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

export class PdfUnavailableError extends Error {}

/**
 * Render untrusted HTML to a PDF buffer with JavaScript disabled and every
 * network request blocked, so the page can only use what is inlined. Throws
 * `PdfUnavailableError` when Puppeteer or its browser is not installed.
 */
export async function renderPdfBuffer(html: string, options: PdfWriteOptions & { timeoutMs?: number } = {}): Promise<Buffer> {
  const puppeteer = await import("puppeteer").catch((error: unknown) => {
    throw new PdfUnavailableError(`PDF rendering requires Puppeteer (${error instanceof Error ? error.message : String(error)})`);
  });
  const browser = await puppeteer.default.launch({ headless: true, args: ["--no-sandbox"] }).catch((error: unknown) => {
    throw new PdfUnavailableError(`PDF rendering could not start a browser (${error instanceof Error ? error.message : String(error)})`);
  });
  try {
    const page = await browser.newPage();
    const timeout = options.timeoutMs ?? 30_000;
    page.setDefaultTimeout(timeout);
    await page.setJavaScriptEnabled(false);
    await page.setRequestInterception(true);
    page.on("request", (request) => {
      if (request.url().startsWith("data:")) void request.continue();
      else void request.abort("blockedbyclient");
    });
    await page.setContent(html, { waitUntil: "load", timeout });
    await page.emulateMediaType("print");
    const pdf = await page.pdf({
      format: (options.pageSize ?? "A4") as PaperFormat,
      printBackground: options.printBackground !== false,
      margin: options.margin ?? DEFAULT_MARGIN,
      timeout,
    });
    return Buffer.from(pdf);
  } finally {
    await browser.close();
  }
}
