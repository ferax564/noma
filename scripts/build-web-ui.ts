import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { build } from "esbuild";

const outfile = resolve("site/assets/workbench.js");

await mkdir(dirname(outfile), { recursive: true });

await build({
  entryPoints: ["web/workbench.ts"],
  outfile,
  bundle: true,
  format: "iife",
  platform: "browser",
  target: "es2022",
  sourcemap: false,
  minify: false,
  loader: {
    ".css": "text",
    ".noma": "text",
  },
});

console.log(`wrote ${outfile}`);
