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

function safeCssColor(value: unknown, fallback: string): string {
  if (typeof value !== "string") return fallback;
  if (/^#([0-9a-f]{3}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(value)) return value;
  if (/^rgba?\(\s*\d+\s*,\s*\d+\s*,\s*\d+(?:\s*,\s*(?:0|1|0?\.\d+))?\s*\)$/i.test(value)) return value;
  return fallback;
}

function finitePx(value: unknown, fallback = 0): number {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? n : fallback;
}

function escapeMarkup(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function chartBars(chart: PaperChartData): string {
  const max = Math.max(1, ...chart.values);
  return `<div class="pd-chart" role="img" aria-label="${escapeMarkup(chart.datasetId)}">${chart.values
    .map((value, index) => {
      const label = chart.labels[index] ?? String(index + 1);
      const height = Math.max(8, Math.round((value / max) * 100));
      return `<div class="pd-bar-col"><span class="pd-bar" style="height:${height}%"></span><span class="pd-bar-label">${escapeMarkup(label)}</span></div>`;
    })
    .join("")}</div>`;
}

export function paperCanvasMarkup(doc: PaperDocument): string {
  const width = Math.max(960, ...doc.elements.map((el) => finitePx(el.geometry.x) + finitePx(el.geometry.width)));
  const height = Math.max(540, ...doc.elements.map((el) => finitePx(el.geometry.y) + finitePx(el.geometry.height)));
  const items = [...doc.elements]
    .sort((a, b) => a.zIndex - b.zIndex)
    .map((el) => {
      const x = finitePx(el.geometry.x);
      const y = finitePx(el.geometry.y);
      const w = Math.max(24, finitePx(el.geometry.width, 120));
      const h = Math.max(24, finitePx(el.geometry.height, 48));
      const rotation = finitePx(el.geometry.rotation);
      const label = el.text ?? el.altText ?? el.type;
      const inner = el.chart ? chartBars(el.chart) : el.table
        ? `<table class="pd-table">${el.table.headers.length ? `<thead><tr>${el.table.headers.map((cell) => `<th>${escapeMarkup(cell)}</th>`).join("")}</tr></thead>` : ""}<tbody>${el.table.rows.map((row) => `<tr>${row.map((cell) => `<td>${escapeMarkup(cell)}</td>`).join("")}</tr>`).join("")}</tbody></table>`
        : `<span class="pd-el-text">${escapeMarkup(label)}</span>`;
      return `<div class="pd-el pd-el-${escapeMarkup(el.type)}" data-id="${escapeMarkup(el.id)}" style="left:${x}px;top:${y}px;width:${w}px;height:${h}px;transform:rotate(${rotation}deg)">${inner}</div>`;
    })
    .join("");
  return `<div class="pd-page" data-paper-id="${escapeMarkup(doc.id)}" style="width:${width}px;min-height:${height}px">${items}</div>`;
}

export function paperCanvasStyles(): string {
  return `.pd-page{position:relative;background:
    linear-gradient(180deg,rgba(255,255,255,.72),rgba(255,255,255,0)),
    radial-gradient(1200px 480px at 20% -10%,rgba(166,79,43,.08),transparent 55%),
    #fffdf8;border:1px solid rgba(40,32,24,.08);border-radius:18px;box-shadow:0 28px 70px -36px rgba(28,22,16,.55),0 1px 0 rgba(255,255,255,.8) inset;overflow:hidden}
.pd-el{position:absolute;box-sizing:border-box;padding:14px 16px;border-radius:14px;background:rgba(255,255,255,.86);border:1px solid rgba(40,32,24,.08);box-shadow:0 10px 28px -22px rgba(28,22,16,.55);overflow:hidden}
.pd-el-text{font:650 15px/1.35 Inter,system-ui,sans-serif;color:#1a1814;white-space:pre-wrap}
.pd-el-shape{background:linear-gradient(180deg,#f7efe8,#fff);border-color:rgba(166,79,43,.18)}
.pd-el-chart{background:#141a21;color:#edf3f7}
.pd-el-chart .pd-el-text{color:#edf3f7}
.pd-chart{display:flex;align-items:flex-end;gap:8px;height:100%;padding-top:8px}
.pd-bar-col{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:flex-end;gap:6px;min-width:0;height:100%}
.pd-bar{width:100%;border-radius:7px 7px 3px 3px;background:linear-gradient(180deg,#d9784d,#a64f2b)}
.pd-bar-label{font:650 10px/1 Inter,system-ui,sans-serif;color:rgba(237,243,247,.72);text-transform:uppercase;letter-spacing:.04em}
.pd-table{width:100%;border-collapse:collapse;font:13px/1.4 Inter,system-ui,sans-serif}
.pd-table th,.pd-table td{border-bottom:1px solid rgba(40,32,24,.08);padding:4px 6px;text-align:left}
.pd-el-title,.pd-el-text:first-child{display:block}`;
}
