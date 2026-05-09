import type { DocumentNode } from "./ast.js";

export interface JsonRenderOptions {
  pretty?: boolean;
}

export function renderJson(doc: DocumentNode, options: JsonRenderOptions = {}): string {
  return JSON.stringify(doc, null, options.pretty === false ? 0 : 2);
}
