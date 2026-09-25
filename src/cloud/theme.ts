/** The default theme stylesheet, read once from `themes/default.css` (source or built layout). */
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

let cachedThemeCss: string | undefined;

export function defaultThemeCss(): string {
  if (cachedThemeCss !== undefined) return cachedThemeCss;
  const here = dirname(fileURLToPath(import.meta.url));
  for (const candidate of [resolve(here, "..", "..", "themes", "default.css"), resolve(here, "..", "..", "..", "themes", "default.css")]) {
    try {
      cachedThemeCss = readFileSync(candidate, "utf8");
      return cachedThemeCss;
    } catch {
      continue;
    }
  }
  cachedThemeCss = "";
  return cachedThemeCss;
}
