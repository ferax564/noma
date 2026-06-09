import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { build } from "esbuild";

const builds = [
  {
    entryPoint: "web/workbench.ts",
    outfile: resolve("site/assets/workbench.js"),
  },
  {
    entryPoint: "web/cloud-app.ts",
    outfile: resolve("site/assets/cloud-app.js"),
  },
] as const;

for (const item of builds) {
  await mkdir(dirname(item.outfile), { recursive: true });

  await build({
    entryPoints: [item.entryPoint],
    outfile: item.outfile,
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

  console.log(`wrote ${item.outfile}`);
}
