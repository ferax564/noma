import { sha256Hex } from "./hash.js";
import { EnterpriseError } from "./enterprise-contracts.js";

export const PAPERDOM_SCHEMA_VERSION = 1;

export interface PaperGeometry {
  x: number;
  y: number;
  width: number;
  height: number;
  rotation?: number;
}

export interface PaperChartData {
  datasetId: string;
  datasetRevision: number;
  values: number[];
  labels: string[];
  units?: string;
}

export interface PaperElement {
  id: string;
  type: "shape" | "text" | "image" | "chart" | "table" | "group";
  geometry: PaperGeometry;
  zIndex: number;
  text?: string;
  altText?: string;
  readingOrder?: number;
  chart?: PaperChartData;
  imageAssetId?: string;
  table?: { headers: string[]; rows: string[][]; columnIds?: string[]; rowIds?: string[]; cellIds?: string[][] };
  children?: string[];
}

export interface PaperDocument {
  schemaVersion: number;
  id: string;
  revision: number;
  title: string;
  elements: PaperElement[];
  theme?: Record<string, unknown>;
}

export type VisualCommand =
  | { op: "insert_element"; element: PaperElement; expectedRevision?: number; actor?: unknown }
  | { op: "delete_element"; elementId: string; expectedRevision?: number; actor?: unknown }
  | { op: "update_element"; elementId: string; patch: Partial<Pick<PaperElement, "geometry" | "text" | "altText" | "zIndex">>; expectedRevision?: number; actor?: unknown }
  | { op: "update_chart"; elementId: string; chart: PaperChartData; expectedRevision?: number; actor?: unknown };

export interface VisualApplyOptions {
  actorId: string;
  expectedRevision: number;
}

export interface VisualApplyResult {
  document: PaperDocument;
  conflicts: string[];
  hash: string;
}

export interface PaperOutlineEntry {
  id: string;
  type: PaperElement["type"];
  readingOrder: number;
  label: string;
  altText?: string;
  chartValues?: { labels: string[]; values: number[]; units?: string; datasetId: string; datasetRevision: number };
}

export function createPaperDocument(id: string, title: string): PaperDocument {
  return { schemaVersion: PAPERDOM_SCHEMA_VERSION, id, revision: 0, title, elements: [] };
}

export function paperHash(doc: PaperDocument): string {
  return sha256Hex(JSON.stringify(canonicalPaper(doc)));
}

export function canonicalPaper(doc: PaperDocument): PaperDocument {
  return {
    ...doc,
    elements: [...doc.elements].sort((a, b) => a.id.localeCompare(b.id)),
  };
}

export function semanticOutline(doc: PaperDocument): PaperOutlineEntry[] {
  return [...doc.elements]
    .sort((a, b) => (a.readingOrder ?? a.zIndex) - (b.readingOrder ?? b.zIndex) || a.id.localeCompare(b.id))
    .map((el, index) => ({
      id: el.id,
      type: el.type,
      readingOrder: el.readingOrder ?? index,
      label: el.text ?? el.altText ?? el.type,
      altText: el.altText,
      chartValues: el.chart
        ? {
            labels: el.chart.labels,
            values: el.chart.values,
            units: el.chart.units,
            datasetId: el.chart.datasetId,
            datasetRevision: el.chart.datasetRevision,
          }
        : undefined,
    }));
}

export function applyVisualCommands(
  current: PaperDocument,
  commands: VisualCommand[],
  options: VisualApplyOptions,
): VisualApplyResult {
  void options.actorId;
  if (current.revision !== options.expectedRevision) {
    throw new EnterpriseError("stale_revision", "visual revision precondition failed", {
      expected: options.expectedRevision,
      actual: current.revision,
    });
  }
  const next: PaperDocument = {
    ...current,
    elements: current.elements.map((el) => ({ ...el, geometry: { ...el.geometry } })),
    revision: current.revision + 1,
  };
  const conflicts: string[] = [];
  const touched = new Set<string>();

  for (const command of commands) {
    if (command.actor !== undefined) {
      // Host identity is derived server-side; supplied actor metadata is ignored.
    }
    if (command.expectedRevision !== undefined && command.expectedRevision !== current.revision) {
      throw new EnterpriseError("stale_revision", "command expectedRevision does not match document head");
    }
    if (command.op === "insert_element") {
      if (next.elements.some((el) => el.id === command.element.id)) {
        throw new EnterpriseError("conflict", `element "${command.element.id}" already exists`);
      }
      next.elements.push({ ...command.element, geometry: { ...command.element.geometry } });
      continue;
    }
    const target = next.elements.find((el) => el.id === command.elementId);
    if (!target) throw new EnterpriseError("not_found", `element "${command.elementId}" not found`);
    if (touched.has(target.id) && (command.op === "update_element" || command.op === "delete_element")) {
      conflicts.push(target.id);
    }
    touched.add(target.id);
    if (command.op === "delete_element") {
      next.elements = next.elements.filter((el) => el.id !== command.elementId);
    } else if (command.op === "update_element") {
      if (command.patch.geometry) target.geometry = { ...target.geometry, ...command.patch.geometry };
      if (command.patch.text !== undefined) target.text = command.patch.text;
      if (command.patch.altText !== undefined) target.altText = command.patch.altText;
      if (command.patch.zIndex !== undefined) target.zIndex = command.patch.zIndex;
    } else if (command.op === "update_chart") {
      target.chart = { ...command.chart, values: [...command.chart.values], labels: [...command.chart.labels] };
    }
  }

  if (conflicts.length > 0) {
    throw new EnterpriseError("conflict", "overlapping visual transforms", { conflicts });
  }
  return { document: next, conflicts, hash: paperHash(next) };
}

export function exportFidelityReport(doc: PaperDocument, target: "pptx" | "svg" | "png"): {
  supported: string[];
  unsupported: string[];
  completeOfficeFidelity: false;
} {
  const types = new Set(doc.elements.map((el) => el.type));
  const unsupported: string[] = [];
  if (target === "pptx") {
    if (types.has("group")) unsupported.push("nested groups");
    unsupported.push("complete Office theme mapping");
  }
  return {
    supported: [...types],
    unsupported,
    completeOfficeFidelity: false,
  };
}
