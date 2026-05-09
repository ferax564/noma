import { existsSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const DEMOS = [
  { html: "dist/examples/agent-plan.html", pdf: "dist/examples/agent-plan.pdf" },
  { html: "dist/examples/tech-doc.html", pdf: "dist/examples/tech-doc.pdf" },
  {
    html: "dist/examples/research-thesis.html",
    pdf: "dist/examples/research-thesis.pdf",
  },
];

async function main() {
  for (const d of DEMOS) {
    const inPath = resolve(d.html);
    if (!existsSync(inPath)) {
      console.error(`missing input: ${inPath} — run \`npm run render:examples\` first`);
      process.exit(1);
    }
  }

  const puppeteer = await import("puppeteer");
  const browser = await puppeteer.default.launch({
    headless: true,
    args: ["--no-sandbox"],
  });
  try {
    for (const d of DEMOS) {
      const inPath = resolve(d.html);
      const outPath = resolve(d.pdf);
      const outDir = dirname(outPath);
      if (!existsSync(outDir)) mkdirSync(outDir, { recursive: true });

      const page = await browser.newPage();
      await page.goto(pathToFileURL(inPath).toString(), { waitUntil: "networkidle0" });
      await page.emulateMediaType("print");
      await page.pdf({
        path: outPath,
        format: "A4",
        printBackground: true,
        margin: { top: "20mm", right: "18mm", bottom: "20mm", left: "18mm" },
      });
      await page.close();
      console.log(`✓ wrote ${outPath}`);
    }
  } finally {
    await browser.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
