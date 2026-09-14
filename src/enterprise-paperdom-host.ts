import { EnterpriseError } from "./enterprise-contracts.js";
import {
  applyDocumentTransaction,
  parsePaperDOMDocument,
  type AgentTransactionPayload,
  type PaperDOMDocument,
} from "./paperdom-document-model.js";
import { PAPERDOM_UPSTREAM_COMMIT, PAPERDOM_UPSTREAM_REPO } from "./paperdom-pin.js";
import { paperCanvasStyles, semanticOutline, type PaperDocument } from "./enterprise-paperdom.js";
import { escapeAttr, escapeHtml } from "./inline.js";

export { PAPERDOM_UPSTREAM_COMMIT, PAPERDOM_UPSTREAM_REPO };

export function createUpstreamPaperDocument(id: string, title: string, now = "2026-09-13T12:00:00.000Z"): PaperDOMDocument {
  return {
    format: "paperdom",
    version: "0.1",
    id,
    title,
    revision: 0,
    pages: [
      {
        id: "page_1",
        name: "Page 1",
        size: { width: 1280, height: 720 },
        background: { color: "#ffffff" },
        elements: [],
      },
    ],
    plugins: [],
    metadata: { createdAt: now, updatedAt: now },
  };
}

export function applyHostedPaperDomTransaction(
  document: PaperDOMDocument,
  payload: AgentTransactionPayload,
  actorId: string,
): PaperDOMDocument {
  const hosted: AgentTransactionPayload = {
    ...payload,
    actor: { id: actorId, name: actorId, type: "human" },
  };
  const result = applyDocumentTransaction(document, hosted, document.pages[0]?.id ?? "page_1");
  if (!result.ok) {
    const code = result.error === "revision_conflict" ? "stale_revision" : "invalid";
    throw new EnterpriseError(code, result.message, { upstream: result.error });
  }
  return result.document;
}

export function paperDomOutline(document: PaperDOMDocument) {
  const parsed = parsePaperDOMDocument(document);
  if (!parsed.ok) throw new EnterpriseError("invalid", parsed.error);
  const asNoma: PaperDocument = {
    schemaVersion: 1,
    id: parsed.document.id,
    revision: parsed.document.revision,
    title: parsed.document.title,
    elements: parsed.document.pages.flatMap((page) =>
      page.elements.map((el, index) => ({
        id: el.id,
        type: el.type === "chart" ? "chart" : el.type === "table" ? "table" : el.type === "image" ? "image" : "text",
        geometry: { x: el.frame.x, y: el.frame.y, width: el.frame.w, height: el.frame.h, rotation: el.frame.rotation },
        zIndex: el.z,
        text: el.content?.text,
        altText: el.content?.alt ?? el.content?.text,
        readingOrder: index,
      })),
    ),
  };
  return semanticOutline(asNoma);
}

function finitePx(value: unknown, fallback = 0): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function safeCssColor(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  if (/^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(value)) return value;
  if (/^rgba?\(\s*\d+\s*,\s*\d+\s*,\s*\d+(?:\s*,\s*(?:0|1|0?\.\d+))?\s*\)$/i.test(value)) return value;
  return fallback;
}

export function paperDomHtmlExport(document: PaperDOMDocument): string {
  const title = escapeHtml(document.title);
  const body = document.pages
    .map((page) => {
      const width = finitePx(page.size?.width, 1280);
      const height = finitePx(page.size?.height, 720);
      const background = safeCssColor(page.background?.color, "#ffffff");
      const items = page.elements
        .filter((el) => !el.hidden)
        .sort((a, b) => a.z - b.z)
        .map((el) => {
          const x = finitePx(el.frame?.x);
          const y = finitePx(el.frame?.y);
          const w = Math.max(24, finitePx(el.frame?.w, 160));
          const h = Math.max(24, finitePx(el.frame?.h, 48));
          const rotation = finitePx(el.frame?.rotation);
          const fill = safeCssColor(el.style?.fill, el.type === "text" ? "transparent" : "#f4ebe4");
          const color = safeCssColor(el.style?.color, "#1a1814");
          const text = escapeHtml(el.content?.text ?? el.content?.alt ?? el.name);
          const label = `<p data-id="${escapeAttr(el.id)}">${text}</p>`;
          return `<div class="pd-el pd-el-${escapeAttr(el.type)}" data-id="${escapeAttr(el.id)}" style="left:${x}px;top:${y}px;width:${w}px;height:${h}px;transform:rotate(${rotation}deg);background:${fill};color:${color}">${label}</div>`;
        })
        .join("");
      return `<section class="pd-page" data-page="${escapeAttr(page.id)}" style="width:${width}px;min-height:${height}px;background:${background}">${items}</section>`;
    })
    .join("");
  return `<!doctype html><html><head><meta charset="utf-8"/><title>${title}</title><style>body{margin:24px;background:#f7f8f9;font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,"Noto Sans",sans-serif}${paperCanvasStyles()}</style></head><body>${body}</body></html>`;
}

export function paperDomFidelityReport(document: PaperDOMDocument, target: "pptx" | "svg" | "html"): {
  supported: string[];
  unsupported: string[];
  completeOfficeFidelity: false;
  source: { repo: string; commit: string };
} {
  const types = [...new Set(document.pages.flatMap((page) => page.elements.map((el) => el.type)))];
  const unsupported = target === "pptx" ? ["complete Office theme mapping"] : [];
  return {
    supported: types,
    unsupported,
    completeOfficeFidelity: false,
    source: { repo: PAPERDOM_UPSTREAM_REPO, commit: PAPERDOM_UPSTREAM_COMMIT },
  };
}
