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
  type: "shape" | "text" | "image" | "chart" | "table" | "group" | "arrow" | "video";
  geometry: PaperGeometry;
  zIndex: number;
  text?: string;
  altText?: string;
  readingOrder?: number;
  chart?: PaperChartData;
  imageAssetId?: string;
  videoAssetId?: string;
  href?: string;
  fromId?: string;
  toId?: string;
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
      let inner = `<span class="pd-el-text">${escapeMarkup(label)}</span>`;
      if (el.chart) inner = chartBars(el.chart);
      else if (el.table) {
        inner = `<table class="pd-table">${el.table.headers.length ? `<thead><tr>${el.table.headers.map((cell) => `<th>${escapeMarkup(cell)}</th>`).join("")}</tr></thead>` : ""}<tbody>${el.table.rows.map((row) => `<tr>${row.map((cell) => `<td>${escapeMarkup(cell)}</td>`).join("")}</tr>`).join("")}</tbody></table>`;
      } else if (el.type === "image" && el.imageAssetId) {
        inner = `<img class="pd-media" src="/v1/assets/${escapeMarkup(el.imageAssetId)}" alt="${escapeMarkup(el.altText ?? label)}" />`;
      } else if (el.type === "video" && (el.videoAssetId || el.href)) {
        const src = el.videoAssetId ? `/v1/assets/${escapeMarkup(el.videoAssetId)}` : escapeMarkup(el.href ?? "");
        inner = `<video class="pd-media" controls src="${src}" title="${escapeMarkup(el.altText ?? label)}"></video>`;
      } else if (el.type === "arrow") {
        const from = el.fromId ? doc.elements.find((item) => item.id === el.fromId) : undefined;
        const to = el.toId ? doc.elements.find((item) => item.id === el.toId) : undefined;
        const x1 = from ? finitePx(from.geometry.x) + finitePx(from.geometry.width) / 2 - x : 8;
        const y1 = from ? finitePx(from.geometry.y) + finitePx(from.geometry.height) / 2 - y : h / 2;
        const x2 = to ? finitePx(to.geometry.x) + finitePx(to.geometry.width) / 2 - x : w - 8;
        const y2 = to ? finitePx(to.geometry.y) + finitePx(to.geometry.height) / 2 - y : h / 2;
        const markerId = `ah-${escapeMarkup(el.id)}`;
        inner = `<svg class="pd-arrow" viewBox="0 0 ${w} ${h}" aria-hidden="true"><defs><marker id="${markerId}" markerWidth="10" markerHeight="7" refX="9" refY="3.5" orient="auto"><polygon points="0 0, 10 3.5, 0 7" fill="#c45a2e"/></marker></defs><line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="#c45a2e" stroke-width="3" marker-end="url(#${markerId})"/></svg>`;
      }
      return `<div class="pd-el pd-el-${escapeMarkup(el.type)}" data-id="${escapeMarkup(el.id)}" style="left:${x}px;top:${y}px;width:${w}px;height:${h}px;transform:rotate(${rotation}deg)">${inner}</div>`;
    })
    .join("");
  return `<div class="pd-page" data-paper-id="${escapeMarkup(doc.id)}" style="width:${width}px;min-height:${height}px">${items}</div>`;
}

export function paperCanvasStyles(): string {
  return `.pd-page{position:relative;background:
    linear-gradient(180deg,rgba(255,255,255,.28),rgba(255,255,255,.06)),
    rgba(255,252,248,.42);border:1px solid rgba(255,255,255,.46);border-radius:28px;box-shadow:0 30px 80px -40px rgba(8,10,16,.55),0 1px 0 rgba(255,255,255,.7) inset;backdrop-filter:blur(28px) saturate(170%);overflow:hidden}
.pd-el{position:absolute;box-sizing:border-box;padding:14px 16px;border-radius:18px;background:rgba(255,255,255,.28);border:1px solid rgba(255,255,255,.42);box-shadow:0 1px 0 rgba(255,255,255,.7) inset,0 16px 36px -28px rgba(16,12,8,.55);backdrop-filter:blur(18px);overflow:hidden}
.pd-el-text{font:650 15px/1.35 Inter,system-ui,sans-serif;color:#1a1814;white-space:pre-wrap}
.pd-el-shape{background:rgba(255,248,242,.34);border-color:rgba(196,90,46,.22)}
.pd-el-chart{background:rgba(10,14,20,.62);color:#edf3f7;border-color:rgba(255,255,255,.12)}
.pd-el-chart .pd-el-text{color:#edf3f7}
.pd-chart{display:flex;align-items:flex-end;gap:8px;height:100%;padding-top:8px}
.pd-bar-col{flex:1;display:flex;flex-direction:column;align-items:center;justify-content:flex-end;gap:6px;min-width:0;height:100%}
.pd-bar{width:100%;border-radius:9px 9px 4px 4px;background:linear-gradient(180deg,#ffb089,#c45a2e)}
.pd-bar-label{font:650 10px/1 Inter,system-ui,sans-serif;color:rgba(237,243,247,.72);text-transform:uppercase;letter-spacing:.04em}
.pd-table{width:100%;border-collapse:collapse;font:13px/1.4 Inter,system-ui,sans-serif}
.pd-table th,.pd-table td{border-bottom:1px solid rgba(40,32,24,.08);padding:4px 6px;text-align:left}
.pd-el-title,.pd-el-text:first-child{display:block}
.pd-el-arrow{background:transparent;border:none;box-shadow:none;padding:0;overflow:visible;pointer-events:none}
.pd-arrow{width:100%;height:100%;overflow:visible}
.pd-media{width:100%;height:100%;object-fit:cover;border-radius:12px;background:#111}
.pd-el-image,.pd-el-video{padding:8px}`;
}
