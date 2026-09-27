/**
 * PaperDOM is a maintained fork inside this repository: `src/paperdom-*.ts`
 * started from the upstream commit below and is now edited, type-checked, and
 * tested here. The constants record where the fork came from for licensing and
 * provenance (MIT); they are not a pin that must be re-vendored.
 */
export const PAPERDOM_UPSTREAM_REPO = "https://github.com/ferax564/paperDOM";
export const PAPERDOM_UPSTREAM_COMMIT = "a12198cdad8c7487242834941a34ed5adf5d4d74";
export const PAPERDOM_UPSTREAM_LICENSE = "MIT";
/** Fork provenance, preferred over the historical `UPSTREAM` names. */
export const PAPERDOM_FORK_BASE_REPO = PAPERDOM_UPSTREAM_REPO;
export const PAPERDOM_FORK_BASE_COMMIT = PAPERDOM_UPSTREAM_COMMIT;

/**
 * Upstream files ported after the fork base (same base commit, re-implemented
 * as pure TS against Noma's sanitised canvas renderer):
 * - `app/text-metrics.ts` + `auditDocument` (app/agent-api.ts) → `canvas-text-metrics.ts`
 * - `diffDocuments` (app/agent-api.ts) + `app/agent-review.tsx` → `canvas-review.ts`
 * - `scripts/paperdom-render.mjs` → `slide-png.ts` (Puppeteer, SVG input, JS off)
 */
export const PAPERDOM_PORTED_UPSTREAM_FILES = [
  "app/text-metrics.ts",
  "app/agent-api.ts#auditDocument",
  "app/agent-api.ts#diffDocuments",
  "app/agent-review.tsx",
  "scripts/paperdom-render.mjs",
] as const;
