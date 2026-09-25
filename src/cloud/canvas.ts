/**
 * `::canvas{src="att:…"}` support: canvas JSON lives in a page attachment and is
 * read before rendering, because renderers are synchronous and I/O-free.
 * Only the page's own live attachments resolve, mirroring `attachmentResolver`.
 */
import { walk, type DocumentNode } from "../ast.js";
import { MAX_CANVAS_SOURCE_BYTES } from "../canvas-svg.js";
import { readBlobBuffer } from "../cloud-blobs.js";
import { parse } from "../parser.js";
import type { CloudServerConfig } from "./context.js";

const ATTACHMENT_PREFIX = "att:";

/** `att:` references used by `::canvas` blocks in `doc`. */
export function canvasAttachmentRefs(doc: DocumentNode): string[] {
  const refs = new Set<string>();
  for (const node of walk(doc)) {
    if (node.type !== "directive" || node.name !== "canvas") continue;
    const src = typeof node.attrs.src === "string" ? node.attrs.src.trim() : "";
    if (src.toLowerCase().startsWith(ATTACHMENT_PREFIX)) refs.add(src.slice(ATTACHMENT_PREFIX.length));
  }
  return [...refs];
}

/** Reads every canvas attachment a page references and returns a synchronous lookup for the renderers. */
export async function canvasResolver(config: CloudServerConfig, documentId: string, source: string | DocumentNode): Promise<(ref: string) => string | undefined> {
  const doc = typeof source === "string" ? parse(source) : source;
  const refs = canvasAttachmentRefs(doc);
  if (refs.length === 0) return () => undefined;
  const attachments = config.store.listAttachments(documentId);
  const loaded = new Map<string, string>();
  for (const ref of refs) {
    const attachment = attachments.find((item) => item.id === ref) ?? attachments.find((item) => item.filename === ref);
    if (!attachment || attachment.size > MAX_CANVAS_SOURCE_BYTES) continue;
    try {
      const data = await readBlobBuffer(config.blobs, attachment.sha256, MAX_CANVAS_SOURCE_BYTES);
      if (data) loaded.set(ref, data.toString("utf8"));
    } catch {
      continue;
    }
  }
  return (ref) => loaded.get(ref);
}

/**
 * Copies resolved canvas JSON into each `::canvas` body so renderers without a
 * `resolveCanvas` option (Markdown, DOCX, LLM, PaperDOM) see the canvas too.
 */
export function inlineResolvedCanvases(doc: DocumentNode, resolve: (ref: string) => string | undefined): DocumentNode {
  for (const node of walk(doc)) {
    if (node.type !== "directive" || node.name !== "canvas" || node.body?.trim()) continue;
    if (node.children.some((child) => child.type === "code")) continue;
    const src = typeof node.attrs.src === "string" ? node.attrs.src.trim() : "";
    if (!src.toLowerCase().startsWith(ATTACHMENT_PREFIX)) continue;
    const json = resolve(src.slice(ATTACHMENT_PREFIX.length));
    if (json !== undefined) node.body = json;
  }
  return doc;
}
