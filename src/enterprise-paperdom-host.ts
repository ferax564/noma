import { EnterpriseError } from "./enterprise-contracts.js";
import {
  applyDocumentTransaction,
  parsePaperDOMDocument,
  type AgentTransactionPayload,
  type PaperDOMDocument,
} from "./paperdom-document-model.js";
import { PAPERDOM_UPSTREAM_COMMIT, PAPERDOM_UPSTREAM_REPO } from "./paperdom-pin.js";
import { semanticOutline, type PaperDocument } from "./enterprise-paperdom.js";

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

export function paperDomHtmlExport(document: PaperDOMDocument): string {
  const title = document.title;
  const body = document.pages
    .map((page) => {
      const items = page.elements
        .filter((el) => !el.hidden)
        .sort((a, b) => a.z - b.z)
        .map((el) => `<p data-id="${el.id}">${el.content?.text ?? el.name}</p>`)
        .join("");
      return `<section data-page="${page.id}">${items}</section>`;
    })
    .join("");
  return `<!doctype html><html><head><title>${title}</title></head><body>${body}</body></html>`;
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
