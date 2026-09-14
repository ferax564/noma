import type { PaperDOMDocument } from "./paperdom-document-model.js";
import { paperDomHtmlExport } from "./enterprise-paperdom-host.js";

export function mountPaperDomHost(target: { innerHTML: string }, document: PaperDOMDocument): void {
  target.innerHTML = paperDomHtmlExport(document);
}
