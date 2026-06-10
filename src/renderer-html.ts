import yaml from "js-yaml";
import type { Attrs, DirectiveNode, DocumentNode, Node, SectionNode } from "./ast.js";
import { walk } from "./ast.js";
import {
  bodyFieldText,
  buildComputedEvalContext,
  controlDefaultText,
  controlOptions,
  computedDomainText,
  evaluateComputedNode,
  evaluateComputedSeries,
  formatComputedNumber,
  formulaText,
  isComputedDirective,
  type ComputedEvalContext,
} from "./computed.js";
import { extractFormulaIdentifiers, parseFormula } from "./formula.js";
import { escapeAttr, escapeHtml, inlineToHtml, splitDelimitedRow, splitPipeRow } from "./inline.js";

export interface HtmlRenderOptions {
  /** When true, wrap output in a full HTML document with the default theme. */
  standalone?: boolean;
  /** Override page title (defaults to meta.title or the first H1). */
  title?: string;
  /** Inline CSS injected into <head> when standalone. */
  themeCss?: string;
  /**
   * When set, the standalone HTML head emits `<link rel="stylesheet" href="...">`
   * pointing here, and `themeCss` is ignored. Used by multi-page site rendering
   * to deduplicate theme bytes across pages.
   */
  stylesheetHref?: string;
  /**
   * Allow `::html`, `::svg`, `::script` escape hatches to emit raw markup.
   * Default: `true` (artifact mode). Set `false` for trusted-publishing
   * contexts where unfiltered HTML is unsafe.
   */
  allowEscapeHatches?: boolean;
  /**
   * Math rendering. `katex` injects KaTeX CDN assets in standalone HTML and
   * configures auto-render for `$..$`, `$$..$$`, `\(..\)`, `\[..\]`. Default
   * is auto-detect: enabled when the doc uses `::math` or `$$..$$` delimiters,
   * or `meta.math` is truthy.
   */
  math?: "katex" | "none";
  /**
   * When false, standalone HTML does not inject external CDN assets for math,
   * diagrams, Plotly, or figure image loads. The source/placeholder markup
   * still renders.
   */
  externalAssets?: boolean;
  /**
   * When false, controls and computed blocks render as static defaults:
   * controls are disabled and the generated computed runtime is omitted.
   */
  interactive?: boolean;
  /**
   * Emit source-line metadata on simple text nodes. This is intended for
   * editor previews and is disabled for normal publishing output.
   */
  sourcePositions?: boolean;
}

export interface DatasetTable {
  columns: string[];
  rows: unknown[][];
}

interface CitationEntry {
  id?: string;
  source?: string;
  title?: string;
  url?: string;
  doi?: string;
  accessed?: string;
  body?: string;
}

interface SectionEntry {
  id?: string;
  title: string;
  level: number;
}

interface CaptionEntry {
  id?: string;
  title: string;
  kind: "figures" | "tables" | "plots";
}

interface RenderCtx {
  allowEscapeHatches: boolean;
  externalAssets: boolean;
  interactive: boolean;
  strictInteractiveBadgeEmitted: boolean;
  datasets: Map<string, DatasetTable>;
  citations: CitationEntry[];
  sections: SectionEntry[];
  captions: CaptionEntry[];
  computed: ComputedEvalContext;
  sourcePositions: boolean;
}

export function buildDatasetRegistry(doc: DocumentNode): Map<string, DatasetTable> {
  const out = new Map<string, DatasetTable>();
  for (const node of walk(doc)) {
    if (node.type !== "directive" || node.name !== "dataset" || !node.id) continue;
    const table = parseDatasetBody(node);
    if (table) out.set(node.id, table);
  }
  return out;
}

function collectCitationEntries(doc: DocumentNode): CitationEntry[] {
  const out: CitationEntry[] = [];
  for (const node of walk(doc)) {
    if (node.type !== "directive" || node.name !== "citation") continue;
    const entry: CitationEntry = {};
    if (node.id) entry.id = node.id;
    const source = stringAttr(node.attrs, "source");
    const title = stringAttr(node.attrs, "title");
    const url = stringAttr(node.attrs, "url") ?? stringAttr(node.attrs, "href");
    const doi = stringAttr(node.attrs, "doi");
    const accessed = stringAttr(node.attrs, "accessed");
    const body = directiveText(node);
    if (source) entry.source = source;
    if (title) entry.title = title;
    if (url) entry.url = url;
    if (doi) entry.doi = doi;
    if (accessed) entry.accessed = accessed;
    if (body) entry.body = body;
    out.push(entry);
  }
  return out;
}

function collectSectionEntries(doc: DocumentNode): SectionEntry[] {
  const out: SectionEntry[] = [];
  for (const node of walk(doc)) {
    if (node.type !== "section") continue;
    out.push({ id: node.id, title: node.title, level: node.level });
  }
  return out;
}

function collectCaptionEntries(doc: DocumentNode): CaptionEntry[] {
  const out: CaptionEntry[] = [];
  for (const node of walk(doc)) {
    if (node.type !== "directive") continue;
    const entry = captionEntry(node);
    if (entry) out.push(entry);
  }
  return out;
}

function captionEntry(node: DirectiveNode): CaptionEntry | undefined {
  if (node.name === "figure") {
    return {
      ...(node.id ? { id: node.id } : {}),
      kind: "figures",
      title: stringAttr(node.attrs, "caption") ?? stringAttr(node.attrs, "title") ?? "Figure",
    };
  }
  if (node.name === "plot" || node.name === "computed_plot") {
    return {
      ...(node.id ? { id: node.id } : {}),
      kind: "plots",
      title: computedLabel(node, "Plot"),
    };
  }
  if (node.name === "table") {
    const title = stringAttr(node.attrs, "title") ?? stringAttr(node.attrs, "caption");
    if (!title) return undefined;
    return {
      ...(node.id ? { id: node.id } : {}),
      kind: "tables",
      title,
    };
  }
  return undefined;
}

function stringAttr(attrs: Attrs, key: string): string | undefined {
  const value = attrs[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function boolAttr(attrs: Attrs, key: string): boolean {
  const value = attrs[key];
  return value === true || value === "true" || value === "yes";
}

function directiveText(node: DirectiveNode): string {
  if (node.body?.trim()) return node.body.trim();
  return node.children
    .map((child) => {
      if (child.type === "paragraph" || child.type === "quote" || child.type === "code") return child.content.trim();
      if (child.type === "list") return child.items.map((item) => item.content.trim()).join(" ");
      return "";
    })
    .filter(Boolean)
    .join(" ");
}

function parseDatasetBody(node: DirectiveNode): DatasetTable | null {
  const body = node.body ?? "";
  if (!body.trim()) return null;
  const format = String(node.attrs.format ?? "").toLowerCase();
  if (format === "csv" || format === "tsv") {
    return parseDelimited(body, format === "tsv" ? "\t" : ",");
  }
  if (format === "json") return parseJsonDataset(body, node);
  let parsed: unknown;
  try {
    parsed = yaml.load(body);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const obj = parsed as Record<string, unknown>;
  const schema = obj.schema;
  const rows = obj.rows;
  if (!Array.isArray(rows)) return null;
  let columns: string[] = [];
  if (schema && typeof schema === "object" && !Array.isArray(schema)) {
    columns = Object.keys(schema as Record<string, unknown>);
  } else if (typeof node.attrs.columns === "string") {
    columns = node.attrs.columns.split(/[,\s]+/).filter(Boolean);
  }
  const cleanRows: unknown[][] = rows
    .filter((r): r is unknown[] => Array.isArray(r))
    .map((r) => [...r]);
  return { columns, rows: cleanRows };
}

function parseDelimited(body: string, delim: string): DatasetTable | null {
  const lines = body.replace(/\r\n?/g, "\n").split("\n").filter((l) => l.length > 0);
  if (lines.length === 0) return null;
  const delimiter = delim === "\t" ? "\t" : ",";
  const split = (s: string) => splitDelimitedRow(s, delimiter);
  const columns = split(lines[0]!);
  const rows: unknown[][] = lines.slice(1).map((l) => {
    const cells = split(l);
    return cells.map((c) => {
      if (c === "") return null;
      const n = Number(c);
      return Number.isFinite(n) && /^-?\d/.test(c) ? n : c;
    });
  });
  return { columns, rows };
}

function parseJsonDataset(body: string, node: DirectiveNode): DatasetTable | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return null;
  }
  if (Array.isArray(parsed)) {
    if (parsed.length === 0) return { columns: [], rows: [] };
    if (typeof parsed[0] === "object" && parsed[0] !== null && !Array.isArray(parsed[0])) {
      const columns = Object.keys(parsed[0] as Record<string, unknown>);
      const rows = (parsed as Record<string, unknown>[]).map((r) =>
        columns.map((c) => r[c] ?? null),
      );
      return { columns, rows };
    }
    if (Array.isArray(parsed[0])) {
      let columns: string[] = [];
      if (typeof node.attrs.columns === "string") {
        columns = node.attrs.columns.split(/[,\s]+/).filter(Boolean);
      }
      return { columns, rows: parsed as unknown[][] };
    }
  }
  if (parsed && typeof parsed === "object") {
    const obj = parsed as Record<string, unknown>;
    if (Array.isArray(obj.rows)) {
      const columns = Array.isArray(obj.columns)
        ? (obj.columns as string[])
        : typeof node.attrs.columns === "string"
          ? node.attrs.columns.split(/[,\s]+/).filter(Boolean)
          : [];
      return { columns, rows: obj.rows as unknown[][] };
    }
  }
  return null;
}

export function resolvePlotData(
  table: DatasetTable,
  column?: string,
): { values: number[]; column: string } | null {
  if (table.rows.length === 0) return null;
  let idx = -1;
  let name = column ?? "";
  if (column) {
    idx = table.columns.indexOf(column);
    if (idx === -1) return null;
  } else {
    for (let i = 0; i < table.columns.length; i++) {
      const sample = table.rows[0]?.[i];
      if (typeof sample === "number") {
        idx = i;
        name = table.columns[i] ?? `col${i}`;
        break;
      }
    }
    if (idx === -1) return null;
  }
  const values = table.rows
    .map((r) => Number(r[idx]))
    .filter((n) => Number.isFinite(n));
  return values.length >= 2 ? { values, column: name } : null;
}

export function resolvePlotLabels(
  table: DatasetTable,
  column: string,
): string[] | null {
  const idx = table.columns.indexOf(column);
  if (idx === -1) return null;
  return table.rows.map((r) => String(r[idx] ?? ""));
}

export function renderHtml(doc: DocumentNode, options: HtmlRenderOptions = {}): string {
  const allowExternalAssets = options.externalAssets !== false;
  const ctx: RenderCtx = {
    allowEscapeHatches: options.allowEscapeHatches !== false,
    externalAssets: allowExternalAssets,
    interactive: options.interactive !== false,
    strictInteractiveBadgeEmitted: false,
    datasets: buildDatasetRegistry(doc),
    citations: collectCitationEntries(doc),
    sections: collectSectionEntries(doc),
    captions: collectCaptionEntries(doc),
    computed: buildComputedEvalContext(doc),
    sourcePositions: options.sourcePositions === true,
  };
  const body = doc.children.map((c) => renderNode(c, ctx)).join("\n");
  if (!options.standalone) return body;

  const title =
    options.title ||
    (typeof doc.meta.title === "string" ? doc.meta.title : undefined) ||
    extractFirstHeading(doc) ||
    "Noma Document";

  const themeCss = options.themeCss ?? "";
  const stylesheetHref = options.stylesheetHref;
  const styleHead = stylesheetHref
    ? `<link rel="stylesheet" href="${escapeAttr(stylesheetHref)}" />`
    : `<style>${themeCss}</style>`;
  const mathMode = allowExternalAssets ? resolveMathMode(doc, options.math) : "none";
  const mathHead = mathMode === "katex" ? KATEX_HEAD : "";
  const mathFoot = mathMode === "katex" ? KATEX_FOOT : "";

  const diagramKinds = resolveDiagramKinds(doc);
  const diagramFoot = allowExternalAssets ? diagramScripts(diagramKinds) : "";
  const computedFoot = ctx.interactive && usesComputedRuntime(doc) ? COMPUTED_RUNTIME_FOOT : "";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="generator" content="noma" />
<title>${escapeHtml(title)}</title>
<link rel="icon" href="data:," />
${styleHead}${mathHead}
</head>
<body>
<main class="noma-doc">
${body}
</main>${mathFoot}${diagramFoot}${computedFoot}
</body>
</html>`;
}

const MERMAID_VERSION = "11.4.0";
const VIZ_VERSION = "3.11.0";
const DRAWIO_VIEWER = "https://viewer.diagrams.net/js/viewer-static.min.js";
const PLOTLY_VERSION = "2.35.2";

function resolveDiagramKinds(doc: DocumentNode): Set<string> {
  const kinds = new Set<string>();
  for (const node of walk(doc)) {
    if (node.type !== "directive") continue;
    if (node.name === "diagram") {
      const k = String(node.attrs.kind ?? "mermaid").toLowerCase();
      if (k) kinds.add(k);
    }
    if (node.name === "plotly") kinds.add("plotly");
  }
  return kinds;
}

function usesComputedRuntime(doc: DocumentNode): boolean {
  for (const node of walk(doc)) {
    if (node.type === "directive" && isComputedDirective(node)) return true;
  }
  return false;
}

function diagramScripts(kinds: Set<string>): string {
  const out: string[] = [];
  if (kinds.has("mermaid")) {
    out.push(MERMAID_FOOT);
  }
  if (kinds.has("graphviz") || kinds.has("dot")) {
    out.push(VIZ_FOOT);
  }
  if (kinds.has("drawio")) {
    out.push(`<script src="${DRAWIO_VIEWER}"></script>`);
  }
  if (kinds.has("plotly")) {
    out.push(PLOTLY_FOOT);
  }
  return out.join("");
}

const SVG_SANITIZE_JS = `function nomaSanitizedSvg(markup) {
  const tpl = document.createElement("template");
  tpl["inn" + "erHTML"] = markup;
  tpl.content.querySelectorAll("script, iframe, object, embed").forEach((n) => n.remove());
  tpl.content.querySelectorAll("*").forEach((node) => {
    for (const attr of Array.from(node.attributes)) {
      const name = attr.name.toLowerCase();
      const value = attr.value.replace(/\\s+/g, "").toLowerCase();
      if (name.startsWith("on")) node.removeAttribute(attr.name);
      else if ((name === "href" || name === "xlink:href" || name === "src") && value.startsWith("javascript:")) node.removeAttribute(attr.name);
    }
  });
  return tpl.content;
}`;

const MERMAID_FOOT = `
<script type="module">
import mermaid from "https://cdn.jsdelivr.net/npm/mermaid@${MERMAID_VERSION}/dist/mermaid.esm.min.mjs";
${SVG_SANITIZE_JS}
mermaid.initialize({ startOnLoad: false, securityLevel: "loose" });
const els = document.querySelectorAll(".noma-diagram-mermaid");
for (let i = 0; i < els.length; i++) {
  const el = els[i];
  const src = el.getAttribute("data-noma-source");
  if (!src) continue;
  try {
    const out = await mermaid.render("noma-mermaid-" + i, src);
    el.replaceChildren(nomaSanitizedSvg(out.svg));
  } catch (e) { el.textContent = String(e); }
}
</script>`;

const VIZ_FOOT = `
<script type="module">
import("https://cdn.jsdelivr.net/npm/@viz-js/viz@${VIZ_VERSION}/lib/viz-standalone.mjs").then(({ instance }) => instance().then((viz) => {
  ${SVG_SANITIZE_JS}
  document.querySelectorAll(".noma-diagram-graphviz, .noma-diagram-dot").forEach((el) => {
    const src = el.getAttribute("data-noma-source");
    if (!src) return;
    try { el.replaceChildren(nomaSanitizedSvg(viz.renderString(src, { format: "svg" }))); }
    catch (e) { el.textContent = String(e); }
  });
}));
</script>`;

const PLOTLY_FOOT = `
<script src="https://cdn.plot.ly/plotly-${PLOTLY_VERSION}.min.js" charset="utf-8"></script>
<script>
document.querySelectorAll(".noma-plotly").forEach((el) => {
  const src = el.getAttribute("data-noma-source");
  if (!src) return;
  try {
    const spec = JSON.parse(src);
    Plotly.newPlot(el, spec.data || [], spec.layout || {}, Object.assign({ responsive: true }, spec.config || {}));
  } catch (e) { el.textContent = String(e); }
});
</script>`;

const COMPUTED_RUNTIME_FOOT = `
<script>
(() => {
  const computedEls = Array.from(document.querySelectorAll("[data-noma-computed]"));
  if (computedEls.length === 0) return;
  const controls = Array.from(document.querySelectorAll("[data-noma-control-input]"));
  const computedById = new Map(computedEls.filter((el) => el.id).map((el) => [el.id, el]));
  const astCache = new WeakMap();

  function readAst(el) {
    if (astCache.has(el)) return astCache.get(el);
    const raw = el.getAttribute("data-formula-ast");
    if (!raw) return null;
    try {
      const ast = JSON.parse(raw);
      astCache.set(el, ast);
      return ast;
    } catch {
      return null;
    }
  }

  function readControls() {
    const env = {};
    for (const input of controls) {
      const id = input.getAttribute("data-noma-control-input");
      if (!id) continue;
      const value = input.type === "checkbox" ? (input.checked ? 1 : 0) : Number(input.value);
      if (Number.isFinite(value)) env[id] = value;
    }
    return env;
  }

  function evaluateComputed(el, env, visiting) {
    if (el.id && Object.prototype.hasOwnProperty.call(env, el.id)) return env[el.id];
    if (el.id && visiting.has(el.id)) return undefined;
    if (el.id) visiting.add(el.id);
    const ast = readAst(el);
    if (!ast) {
      if (el.id) visiting.delete(el.id);
      return undefined;
    }
    const value = evaluateAst(ast, env, visiting);
    if (el.id) visiting.delete(el.id);
    if (!Number.isFinite(value)) return undefined;
    if (el.id) env[el.id] = value;
    return value;
  }

  function evaluateAst(ast, env, visiting) {
    switch (ast.type) {
      case "number":
        return ast.value;
      case "identifier":
        if (Object.prototype.hasOwnProperty.call(env, ast.name)) return env[ast.name];
        if (computedById.has(ast.name)) {
          const value = evaluateComputed(computedById.get(ast.name), env, visiting);
          return value === undefined ? NaN : value;
        }
        return NaN;
      case "unary": {
        const value = evaluateAst(ast.expr, env, visiting);
        return ast.op === "-" ? -value : value;
      }
      case "binary": {
        const left = evaluateAst(ast.left, env, visiting);
        const right = evaluateAst(ast.right, env, visiting);
        switch (ast.op) {
          case "+": return left + right;
          case "-": return left - right;
          case "*": return left * right;
          case "/": return right === 0 ? NaN : left / right;
          case "^": return Math.pow(left, right);
          case ">": return left > right ? 1 : 0;
          case ">=": return left >= right ? 1 : 0;
          case "<": return left < right ? 1 : 0;
          case "<=": return left <= right ? 1 : 0;
          case "==": return left === right ? 1 : 0;
          case "!=": return left !== right ? 1 : 0;
          default: return NaN;
        }
      }
      case "call": {
        const args = ast.args.map((arg) => evaluateAst(arg, env, visiting));
        if (args.some((value) => !Number.isFinite(value))) return NaN;
        switch (ast.name) {
          case "pow": return args.length === 2 ? Math.pow(args[0], args[1]) : NaN;
          case "min": return args.length >= 1 ? Math.min.apply(Math, args) : NaN;
          case "max": return args.length >= 1 ? Math.max.apply(Math, args) : NaN;
          case "clamp": return args.length === 3 ? Math.min(Math.max(args[0], args[1]), args[2]) : NaN;
          case "round": {
            if (args.length < 1 || args.length > 2) return NaN;
            const factor = Math.pow(10, Math.trunc(args[1] || 0));
            return Math.round(args[0] * factor) / factor;
          }
          case "abs": return args.length === 1 ? Math.abs(args[0]) : NaN;
          case "if": return args.length === 3 ? (args[0] !== 0 ? args[1] : args[2]) : NaN;
          default: return NaN;
        }
      }
      default:
        return NaN;
    }
  }

  function parseDomain(raw) {
    const match = /^\\s*([A-Za-z_][A-Za-z0-9_.-]*)\\s*:\\s*(-?\\d+(?:\\.\\d+)?)\\s*\\.\\.\\s*(-?\\d+(?:\\.\\d+)?)(?:\\s*:\\s*(-?\\d+(?:\\.\\d+)?))?\\s*$/.exec(raw || "");
    if (!match) return null;
    const variable = match[1];
    const start = Number(match[2]);
    const end = Number(match[3]);
    const explicitStep = match[4] === undefined ? undefined : Number(match[4]);
    if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
    const step = explicitStep === undefined ? (Number.isInteger(start) && Number.isInteger(end) ? (start <= end ? 1 : -1) : (end - start) / 10) : explicitStep;
    if (!Number.isFinite(step) || step === 0) return null;
    const points = [];
    const forward = step > 0;
    for (let value = start; forward ? value <= end + 1e-9 : value >= end - 1e-9; value += step) {
      points.push(Number(value.toFixed(10)));
      if (points.length >= 25) break;
    }
    return points.length ? { variable, points } : null;
  }

  function formatNumber(value) {
    if (Math.abs(value) >= 1000000) return value.toFixed(0);
    if (Number.isInteger(value)) return String(value);
    return value.toFixed(6).replace(/0+$/, "").replace(/\\.$/, "");
  }

  function formatDisplay(value, unit) {
    const text = formatNumber(value);
    if (!unit) return text;
    if (text.endsWith(unit)) return text;
    return /^[%°]/.test(unit) ? text + unit : text + " " + unit;
  }

  function escapeText(value) {
    return String(value).replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[ch]);
  }

  function axisNumber(value) {
    const abs = Math.abs(value);
    if (abs >= 1000000) return (value / 1000000).toFixed(abs >= 10000000 ? 0 : 1) + "M";
    if (abs >= 1000) return (value / 1000).toFixed(abs >= 10000 ? 0 : 1) + "k";
    if (abs >= 10) return value.toFixed(1);
    return value.toFixed(2);
  }

  function placeholder(width, height) {
    return '<svg viewBox="0 0 ' + width + ' ' + height + '" xmlns="http://www.w3.org/2000/svg" aria-hidden="true"><polyline points="0,' + (height - 20) + ' ' + (width * 0.13) + ',' + (height - 40) + ' ' + (width * 0.25) + ',' + (height - 30) + ' ' + (width * 0.38) + ',' + (height - 60) + ' ' + (width * 0.5) + ',' + (height - 65) + ' ' + (width * 0.63) + ',' + (height - 80) + ' ' + (width * 0.75) + ',' + (height - 85) + ' ' + (width * 0.88) + ',' + (height - 100) + ' ' + width + ',' + (height - 105) + '" fill="none" stroke="currentColor" stroke-width="2" /></svg>';
  }

  function renderChart(values, type, width, height, labels) {
    if (!values || values.length < 2) return placeholder(width, height);
    const min = Math.min.apply(Math, values);
    const max = Math.max.apply(Math, values);
    const span = max - min || 1;
    const isBar = type === "bar";
    const padL = 28;
    const padR = isBar ? 12 : 6;
    const padT = 8;
    const padB = labels.length ? 36 : 8;
    const innerW = width - padL - padR;
    const innerH = height - padT - padB;
    const x = (index) => values.length === 1 ? padL + innerW / 2 : isBar ? padL + ((index + 0.5) / values.length) * innerW : padL + (index / (values.length - 1)) * innerW;
    const y = (value) => padT + innerH - ((value - min) / span) * innerH;
    const grid = [0, 0.25, 0.5, 0.75, 1].map((t) => '<line x1="' + padL + '" x2="' + (width - padR) + '" y1="' + (padT + t * innerH) + '" y2="' + (padT + t * innerH) + '" stroke="currentColor" stroke-opacity="0.12" />').join("");
    const ticks = [0, 0.25, 0.5, 0.75, 1].map((t, i) => {
      const value = max - t * span;
      return '<text x="' + (padL - 4) + '" y="' + (padT + i * innerH * 0.25 + 3).toFixed(1) + '" text-anchor="end" font-size="9" fill="currentColor" opacity="0.7">' + escapeText(axisNumber(value)) + '</text>';
    }).join("");
    const plot = isBar
      ? values.map((value, index) => {
          const slot = innerW / values.length;
          const barW = slot * 0.68;
          const top = y(value);
          const left = x(index) - barW / 2;
          return '<rect x="' + left.toFixed(1) + '" y="' + top.toFixed(1) + '" width="' + barW.toFixed(1) + '" height="' + (padT + innerH - top).toFixed(1) + '" fill="#2B5265" opacity="0.85" />';
        }).join("")
      : '<polyline points="' + values.map((value, index) => x(index).toFixed(1) + ',' + y(value).toFixed(1)).join(" ") + '" fill="none" stroke="#2B5265" stroke-width="2" />' +
        values.map((value, index) => '<circle cx="' + x(index).toFixed(1) + '" cy="' + y(value).toFixed(1) + '" r="2.5" fill="#2B5265" />').join("");
    const xLabels = labels.length
      ? labels.map((label, index) => {
          if (values.length > 8 && index % Math.ceil(values.length / 6) !== 0 && index !== values.length - 1) return "";
          const anchor = index === 0 ? "start" : index === values.length - 1 ? "end" : "middle";
          return '<text x="' + x(index).toFixed(1) + '" y="' + (padT + innerH + 14).toFixed(1) + '" text-anchor="' + anchor + '" font-size="9" fill="currentColor" opacity="0.7">' + escapeText(label) + '</text>';
        }).join("")
      : "";
    return '<svg viewBox="0 0 ' + width + ' ' + height + '" xmlns="http://www.w3.org/2000/svg" role="img">' + grid + plot + ticks + xLabels + '</svg>';
  }

  function update() {
    const controlEnv = readControls();
    for (const input of controls) {
      const id = input.getAttribute("data-noma-control-input");
      if (!id) continue;
      const wrap = input.closest("[data-noma-control]");
      let output = null;
      if (wrap) {
        for (const candidate of wrap.querySelectorAll("[data-noma-control-value]")) {
          if (candidate.getAttribute("data-noma-control-value") === id) output = candidate;
        }
      }
      const value = input.type === "checkbox" ? (input.checked ? 1 : 0) : Number(input.value);
      if (output && Number.isFinite(value)) output.textContent = formatDisplay(value, wrap ? wrap.getAttribute("data-unit") : "");
    }
    for (const el of computedEls) {
      if (el.getAttribute("data-noma-computed") === "plot") {
        const domain = parseDomain(el.getAttribute("data-domain"));
        const canvas = el.querySelector("[data-noma-computed-plot]");
        if (!domain || !canvas) continue;
        const values = [];
        for (const point of domain.points) {
          const env = Object.assign({}, controlEnv);
          env[domain.variable] = point;
          const value = evaluateComputed(el, env, new Set());
          if (value === undefined) {
            values.length = 0;
            break;
          }
          values.push(value);
        }
        canvas["inn" + "erHTML"] = renderChart(values, el.getAttribute("data-chart-type") || "line", Number(el.getAttribute("data-width") || 320), Number(el.getAttribute("data-height") || 140), domain.points.map(formatNumber));
      } else if (el.getAttribute("data-noma-computed") === "table") {
        const domain = parseDomain(el.getAttribute("data-domain"));
        const body = el.querySelector("[data-noma-computed-table]");
        if (!domain || !body) continue;
        const rows = [];
        for (const point of domain.points) {
          const env = Object.assign({}, controlEnv);
          env[domain.variable] = point;
          const value = evaluateComputed(el, env, new Set());
          if (value === undefined) {
            rows.length = 0;
            break;
          }
          rows.push('<tr><td>' + escapeText(formatNumber(point)) + '</td><td>' + escapeText(formatDisplay(value, el.getAttribute("data-unit") || "")) + '</td></tr>');
        }
        body["inn" + "erHTML"] = rows.length ? rows.join("") : '<tr><td colspan="2">—</td></tr>';
      } else {
        const env = Object.assign({}, controlEnv);
        const value = evaluateComputed(el, env, new Set());
        const target = el.querySelector("[data-noma-computed-value]");
        if (target) target.textContent = value === undefined ? "—" : formatDisplay(value, el.getAttribute("data-unit") || "");
      }
    }
  }

  function readHashState() {
    const raw = window.location.hash ? window.location.hash.slice(1) : "";
    if (!raw || !raw.includes("=")) return {};
    const source = raw.startsWith("noma:") ? raw.slice(5) : raw;
    const params = new URLSearchParams(source);
    const state = {};
    for (const [key, value] of params.entries()) state[key] = value;
    return state;
  }

  function applyHashState() {
    const state = readHashState();
    for (const input of controls) {
      const id = input.getAttribute("data-noma-control-input");
      if (!id || !Object.prototype.hasOwnProperty.call(state, id)) continue;
      if (input.type === "checkbox") {
        const value = String(state[id]).toLowerCase();
        input.checked = value === "1" || value === "true" || value === "yes" || value === "on" || value === "checked";
      } else {
        input.value = state[id];
      }
    }
  }

  function writeHashState() {
    const params = new URLSearchParams();
    for (const input of controls) {
      const id = input.getAttribute("data-noma-control-input");
      if (!id) continue;
      params.set(id, input.type === "checkbox" ? (input.checked ? "1" : "0") : input.value);
    }
    const hash = params.toString();
    if (hash) history.replaceState(null, "", window.location.pathname + window.location.search + "#noma:" + hash);
  }

  for (const input of controls) {
    input.addEventListener("input", () => { writeHashState(); update(); });
    input.addEventListener("change", () => { writeHashState(); update(); });
  }
  applyHashState();
  update();
})();
</script>`;

const KATEX_VERSION = "0.16.11";
const KATEX_HEAD = `
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/katex@${KATEX_VERSION}/dist/katex.min.css" crossorigin="anonymous" />`;
const KATEX_FOOT = `
<script defer src="https://cdn.jsdelivr.net/npm/katex@${KATEX_VERSION}/dist/katex.min.js" crossorigin="anonymous"></script>
<script defer src="https://cdn.jsdelivr.net/npm/katex@${KATEX_VERSION}/dist/contrib/auto-render.min.js" crossorigin="anonymous" onload="renderMathInElement(document.body, {delimiters: [{left: '$$', right: '$$', display: true}, {left: '\\\\[', right: '\\\\]', display: true}, {left: '\\\\(', right: '\\\\)', display: false}, {left: '$', right: '$', display: false}], throwOnError: false});"></script>`;

function resolveMathMode(doc: DocumentNode, override?: "katex" | "none"): "katex" | "none" {
  if (override === "katex" || override === "none") return override;
  if (typeof doc.meta.math === "string") {
    return doc.meta.math === "katex" ? "katex" : "none";
  }
  if (doc.meta.math === true) return "katex";
  for (const node of walk(doc)) {
    if (node.type === "directive" && node.name === "math") return "katex";
    const text = textForMathScan(node);
    if (text && /\$\$[^$]+\$\$|\\\(|\\\[/.test(text)) return "katex";
  }
  return "none";
}

function textForMathScan(node: Node): string | null {
  if (node.type === "paragraph" || node.type === "quote") return node.content;
  if (node.type === "list_item") return node.content;
  if (node.type === "section") return node.title;
  if (node.type === "directive" && node.body) return node.body;
  if (node.type === "code") return null;
  return null;
}

function renderNode(node: Node, ctx: RenderCtx): string {
  switch (node.type) {
    case "document":
      return node.children.map((c) => renderNode(c, ctx)).join("\n");
    case "section":
      return renderSection(node, ctx);
    case "paragraph":
      return `<p${sourceEditAttrs(node, ctx, "paragraph")}>${inlineToHtml(node.content)}</p>`;
    case "code": {
      const langClass = node.lang ? ` class="lang-${escapeAttr(node.lang)}"` : "";
      return `<pre><code${langClass}>${escapeHtml(node.content)}</code></pre>`;
    }
    case "list": {
      const tag = node.ordered ? "ol" : "ul";
      const items = node.items
        .map((item) => `  <li${sourceEditAttrs(item, ctx, "list_item")}>${inlineToHtml(item.content)}</li>`)
        .join("\n");
      return `<${tag}>\n${items}\n</${tag}>`;
    }
    case "list_item":
      return `<li${sourceEditAttrs(node, ctx, "list_item")}>${inlineToHtml(node.content)}</li>`;
    case "quote":
      return `<blockquote${sourceEditAttrs(node, ctx, "quote")}>${inlineToHtml(node.content)}</blockquote>`;
    case "thematic_break":
      return `<hr />`;
    case "table": {
      const head = node.header
        .map((cell, idx) => {
          const align = node.align[idx];
          const styleAttr = align ? ` style="text-align: ${align}"` : "";
          return `<th${styleAttr}>${inlineToHtml(cell)}</th>`;
        })
        .join("");
      const body = node.rows
        .map((row) => {
          const cells = row
            .map((cell, idx) => {
              const align = node.align[idx];
              const styleAttr = align ? ` style="text-align: ${align}"` : "";
              return `<td${styleAttr}>${inlineToHtml(cell)}</td>`;
            })
            .join("");
          return `<tr>${cells}</tr>`;
        })
        .join("\n");
      return `<table class="noma-table">\n<thead><tr>${head}</tr></thead>\n<tbody>\n${body}\n</tbody>\n</table>`;
    }
    case "directive":
      return renderDirective(node, ctx);
    case "frontmatter":
      return "";
    default: {
      const _exhaustive: never = node;
      void _exhaustive;
      return "";
    }
  }
}

function renderSection(node: SectionNode, ctx: RenderCtx): string {
  const idAttr = node.id ? ` id="${escapeAttr(node.id)}"` : "";
  const aliasAnchors = (node.aliases ?? [])
    .map((a) => `<a class="noma-alias" id="${escapeAttr(a)}" aria-hidden="true"></a>`)
    .join("");
  const heading = `<h${node.level}${sourceEditAttrs(node, ctx, "section", node.pos?.line)}>${inlineToHtml(node.title)}</h${node.level}>`;
  const inner = node.children.map((c) => renderNode(c, ctx)).join("\n");
  return `<section${idAttr} data-level="${node.level}">\n${aliasAnchors}${heading}\n${inner}\n</section>`;
}

function sourceEditAttrs(node: Node, ctx: RenderCtx, kind: string, endLine = node.endLine): string {
  if (!ctx.sourcePositions || !node.pos?.line) return "";
  const lastLine = endLine ?? node.pos.line;
  return ` data-noma-editable="${escapeAttr(kind)}" data-noma-line="${node.pos.line}" data-noma-end-line="${lastLine}"`;
}

function variantAttr(node: DirectiveNode): string {
  const v = node.attrs.variant;
  return typeof v === "string" && v.length > 0
    ? ` data-variant="${escapeAttr(v)}"`
    : "";
}

function gridLayoutAttrs(
  node: DirectiveNode,
  columns: number,
  baseClass = "noma-grid",
): { className: string; style: string } {
  const classes = [baseClass];
  const width = String(node.attrs.width ?? node.attrs.span ?? "");
  const min = cssLength(
    node.attrs.min ??
      node.attrs.min_width ??
      node.attrs.minWidth ??
      node.attrs.minColumnWidth ??
      node.attrs["min-width"],
  );
  const gap = cssLength(node.attrs.gap);
  if (node.attrs.wide === true || width === "wide") classes.push(`${baseClass}-wide`);
  if (node.attrs.full === true || width === "full") classes.push(`${baseClass}-full`);
  if (node.attrs.compact === true || node.attrs.dense === true) classes.push(`${baseClass}-compact`);
  if (min) classes.push(`${baseClass}-auto`);
  const safeColumns = Number.isFinite(columns)
    ? Math.max(1, Math.min(12, Math.floor(columns)))
    : 2;
  const vars = [`--noma-cols: ${safeColumns}`];
  if (min) vars.push(`--noma-grid-min: ${min}`);
  if (gap) vars.push(`--noma-grid-gap: ${gap}`);
  return {
    className: classes.map(escapeAttr).join(" "),
    style: escapeAttr(`${vars.join("; ")};`),
  };
}

function cssLength(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isFinite(value) && value >= 0) return `${value}px`;
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (trimmed === "0") return trimmed;
  return /^(?:\d+(?:\.\d+)?)(?:px|rem|em|ch|vw|%)$/.test(trimmed) ? trimmed : undefined;
}

function renderDirective(node: DirectiveNode, ctx: RenderCtx): string {
  const name = node.name;
  const idAttr = node.id ? ` id="${escapeAttr(node.id)}"` : "";
  const variant = variantAttr(node);
  const dataAttrs = Object.entries(node.attrs)
    .filter(([k]) => k !== "id")
    .map(([k, v]) => ` data-${escapeAttr(k)}="${escapeAttr(String(v))}"`)
    .join("");

  switch (name) {
    case "summary":
    case "abstract":
      return wrap("div", `noma-${name}`, idAttr + dataAttrs, renderChildren(node, ctx));

    case "callout":
    case "note":
    case "warning":
    case "tip": {
      const tone = name === "callout" ? String(node.attrs.tone ?? "info") : name;
      return `<aside class="noma-callout noma-callout-${escapeAttr(tone)}"${idAttr}${variant}>${renderChildren(node, ctx)}</aside>`;
    }

    case "claim":
    case "evidence":
    case "counterevidence":
    case "assumption":
    case "risk":
    case "hypothesis":
    case "result":
    case "limitation":
    case "open_question":
    case "decision":
    case "adr":
      return renderResearchBlock(node, ctx);

    case "export_button": {
      const format = node.attrs.format ? String(node.attrs.format) : "text";
      const target = node.attrs.target ? String(node.attrs.target) : "";
      const label =
        (node.attrs.Label && String(node.attrs.Label)) ||
        (node.attrs.label && String(node.attrs.label)) ||
        node.body?.trim() ||
        `Copy as ${format}`;
      const cleanLabel = label.replace(/^Label:\s*/, "");
      return `<button type="button" class="noma-export-button" data-format="${escapeAttr(format)}" data-target="${escapeAttr(target)}"${idAttr}>${escapeHtml(cleanLabel)}</button>`;
    }

    case "control": {
      return renderControl(node, idAttr + dataAttrs, ctx);
    }

    case "grid": {
      const cols = Number(node.attrs.columns ?? 2);
      const layout = gridLayoutAttrs(node, cols);
      return `<div class="${layout.className}"${idAttr} style="${layout.style}"${dataAttrs}>${renderChildren(node, ctx)}</div>`;
    }

    case "card": {
      const title = node.attrs.title ? String(node.attrs.title) : undefined;
      const icon = node.attrs.icon ? String(node.attrs.icon) : undefined;
      const head = title
        ? `<header class="noma-card-head">${icon ? `<span class="noma-icon" aria-hidden="true">◆</span>` : ""}<h3>${escapeHtml(title)}</h3></header>`
        : "";
      return `<article class="noma-card"${idAttr}${variant}>${head}<div class="noma-card-body">${renderChildren(node, ctx)}</div></article>`;
    }

    case "hero":
      return `<section class="noma-hero"${idAttr}>${renderChildren(node, ctx)}</section>`;

    case "page_setup":
      return renderPageSetup(node, idAttr + dataAttrs);

    case "header":
      return renderPageChrome("header", node, idAttr + dataAttrs, ctx);

    case "footer":
      return renderPageChrome("footer", node, idAttr + dataAttrs, ctx);

    case "toc":
      return renderToc(node, idAttr + dataAttrs, ctx);

    case "pagebreak":
      return `<div class="noma-pagebreak"${idAttr} role="separator" aria-label="Page break"></div>`;

    case "button": {
      const href = node.attrs.href ? String(node.attrs.href) : "#";
      return `<a class="noma-button" href="${escapeAttr(href)}"${idAttr}>${renderChildren(node, ctx) || escapeHtml(node.body ?? "")}</a>`;
    }

    case "figure": {
      const caption = node.attrs.caption ? String(node.attrs.caption) : undefined;
      const src = node.attrs.src ? String(node.attrs.src) : undefined;
      const alt = node.attrs.alt ? String(node.attrs.alt) : "";
      const img = src
        ? renderFigureImage(src, alt, ctx)
        : renderChildren(node, ctx);
      return `<figure${idAttr}>${img}${caption ? `<figcaption>${escapeHtml(caption)}</figcaption>` : ""}</figure>`;
    }

    case "plot":
      return renderPlotPlaceholder(node, idAttr, ctx);

    case "diagram":
      return renderDiagram(node, idAttr);

    case "plotly":
      return renderPlotly(node, idAttr);

    case "dataset": {
      const summary = `Dataset: ${escapeHtml(String(node.attrs.id ?? "dataset"))}`;
      const src = typeof node.attrs.src === "string" ? node.attrs.src : "";
      const inline = node.body ?? "";
      const body =
        inline.trim()
          ? escapeHtml(inline)
          : src
            ? `<a class="noma-dataset-src" href="${escapeAttr(src)}">${escapeHtml(src)}</a>`
            : "";
      return `<details class="noma-dataset"${idAttr}${src ? ` data-src="${escapeAttr(src)}"` : ""}><summary>${summary}</summary><pre>${body}</pre></details>`;
    }

    case "metric":
      return renderMetric(node, idAttr + dataAttrs, ctx);

    case "computed_metric":
      return renderComputedMetric(node, idAttr + variant, ctx);

    case "computed_plot":
      return renderComputedPlot(node, idAttr + variant, ctx);

    case "computed_table":
      return renderComputedTable(node, idAttr + variant, ctx);

    case "code":
      return renderCodeDirective(node, idAttr + dataAttrs, ctx);

    case "code_cell":
      return renderCodeCell(node, idAttr + dataAttrs, ctx);

    case "output":
      return renderOutputBlock(node, idAttr + dataAttrs, ctx);

    case "memory_index":
      return renderMemoryIndex(node, idAttr + dataAttrs, ctx);

    case "memory":
      return renderMemory(node, idAttr + dataAttrs, ctx);

    case "agent_task":
    case "todo":
      return renderAgentTask(node, idAttr, ctx);

    case "comment":
      return renderComment(node, idAttr + dataAttrs, ctx);

    case "review":
    case "provenance":
    case "confidence":
      return renderReviewMetaBlock(node, idAttr + dataAttrs, ctx);

    case "api":
    case "endpoint":
    case "parameter":
    case "example":
    case "query":
    case "instruction":
    case "changelog":
      return renderTechnicalDirective(node, idAttr + dataAttrs, ctx);

    case "change_request":
      return renderChangeRequest(node, idAttr + dataAttrs, ctx);

    case "state_change":
      return renderStateChange(node, idAttr, ctx);

    case "table":
      return renderTableDirective(node, idAttr);

    case "math": {
      const body = (node.body ?? "").trim();
      const display = node.attrs.display !== "inline";
      const wrapped = display ? `\\[${body}\\]` : `\\(${body}\\)`;
      const cls = display ? "noma-math noma-math-display" : "noma-math noma-math-inline";
      return `<div class="${cls}"${idAttr}>${escapeHtml(wrapped)}</div>`;
    }

    case "tabs":
    case "accordion":
    case "sidebar":
      return wrap("div", `noma-${name}`, idAttr + dataAttrs, renderChildren(node, ctx));

    case "columns": {
      const cols = Number(node.attrs.columns ?? 2);
      const layout = gridLayoutAttrs(node, cols, "noma-columns");
      return `<div class="${layout.className}"${idAttr} style="${layout.style}"${dataAttrs}>${renderChildren(node, ctx)}</div>`;
    }

    case "citation":
      return `<cite class="noma-citation"${idAttr}>${renderChildren(node, ctx) || escapeHtml(node.body ?? "")}</cite>`;

    case "bibliography":
      return renderBibliography(node, idAttr + dataAttrs, ctx);

    case "footnote":
    case "endnote": {
      const label = node.attrs.label ? `<sup>${escapeHtml(String(node.attrs.label))}</sup>` : "";
      const cls = node.name === "endnote" ? "noma-endnote" : "noma-footnote";
      return `<aside class="${cls}"${idAttr}${dataAttrs}>${label}${renderChildren(node, ctx)}</aside>`;
    }

    case "html":
      return ctx.allowEscapeHatches
        ? `<div class="noma-raw-html"${idAttr}>${node.body ?? ""}</div>`
        : `<aside class="noma-blocked-escape" data-kind="html"${idAttr}>[raw HTML escape hatch disabled]</aside>`;

    case "svg":
      return ctx.allowEscapeHatches
        ? `<div class="noma-raw-svg"${idAttr}>${node.body ?? ""}</div>`
        : `<aside class="noma-blocked-escape" data-kind="svg"${idAttr}>[raw SVG escape hatch disabled]</aside>`;

    case "script": {
      if (!ctx.allowEscapeHatches) {
        return `<aside class="noma-blocked-escape" data-kind="script"${idAttr}>[script escape hatch disabled]</aside>`;
      }
      const runtime = String(node.attrs.runtime ?? "browser");
      if (runtime !== "browser") {
        return `<!-- noma:script runtime="${escapeAttr(runtime)}" omitted -->`;
      }
      return `<script${idAttr}>${node.body ?? ""}</script>`;
    }

    default:
      return renderGenericDirective(node, idAttr + dataAttrs, ctx);
  }
}

function renderGenericDirective(node: DirectiveNode, idAndAttrs: string, ctx: RenderCtx): string {
  const title = attrValueText(node.attrs, "title") ?? attrValueText(node.attrs, "caption");
  const titleHtml = title ? `<h3>${escapeHtml(title)}</h3>` : "";
  const meta = genericDirectiveMetaHtml(node.attrs);
  const metaHtml = meta ? `<div class="noma-meta">${meta}</div>` : "";
  return `<aside class="noma-block noma-custom-directive noma-block-${escapeAttr(node.name)}"${idAndAttrs}>
  <header class="noma-block-head"><span class="noma-tag">${escapeHtml(readableDirectiveName(node.name))}</span>${titleHtml}</header>
  <div class="noma-block-body">${renderChildren(node, ctx)}</div>
  ${metaHtml}
</aside>`;
}

function renderFigureImage(src: string, alt: string, ctx: RenderCtx): string {
  if (ctx.externalAssets || /^data:image\//i.test(src)) {
    return `<img src="${escapeAttr(src)}" alt="${escapeAttr(alt)}" />`;
  }
  return `<aside class="noma-blocked-escape" data-kind="figure">[figure image asset disabled: ${escapeHtml(src)}]</aside>`;
}

function genericDirectiveMetaHtml(attrs: Attrs): string {
  const skip = new Set(["id", "title", "caption", "variant"]);
  const fields = Object.entries(attrs)
    .filter(([key]) => !skip.has(key))
    .map(([key, value]) => genericDirectiveMetaField(key, value));
  return metaFieldsHtml(fields);
}

function genericDirectiveMetaField(key: string, value: Attrs[string]): string {
  const label = readableAttributeName(key);
  if (value === true) return `<span><span class="noma-meta-key">${escapeHtml(label)}</span></span>`;
  return `<span><span class="noma-meta-key">${escapeHtml(label)}</span> ${genericDirectiveValueHtml(value)}</span>`;
}

function genericDirectiveValueHtml(value: Attrs[string]): string {
  const text = String(value);
  if (/^https?:\/\//.test(text)) return `<a href="${escapeAttr(text)}">${escapeHtml(text)}</a>`;
  return escapeHtml(text);
}

function readableDirectiveName(name: string): string {
  const words = splitIdentifierWords(name);
  if (words.length === 0) return "Directive";
  return words.map((word, index) => (index === 0 ? titleWord(word) : word.toLowerCase())).join(" ");
}

function readableAttributeName(name: string): string {
  return splitIdentifierWords(name).join(" ") || name;
}

function splitIdentifierWords(value: string): string[] {
  return value.split(/::|[:_-]+/).map((part) => part.trim()).filter(Boolean);
}

function titleWord(word: string): string {
  if (word === word.toUpperCase()) return word;
  return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
}

function renderResearchBlock(node: DirectiveNode, ctx: RenderCtx): string {
  const idAttr = node.id ? ` id="${escapeAttr(node.id)}"` : "";
  const variant = variantAttr(node);
  const confidence =
    typeof node.attrs.confidence === "number" ? node.attrs.confidence : undefined;
  const meta = researchMetaHtml(node);
  const confidenceBar =
    confidence !== undefined
      ? `<div class="noma-confidence" title="confidence ${confidence}"><div class="noma-confidence-bar" style="width: ${Math.round(confidence * 100)}%"></div></div>`
      : "";
  const metaHtml = meta ? `<div class="noma-meta">${meta}</div>` : "";
  return `<aside class="noma-research noma-${escapeAttr(node.name)}"${idAttr}${variant}>
  <header class="noma-research-head"><span class="noma-tag">${escapeHtml(node.name)}</span>${confidenceBar}</header>
  <div class="noma-research-body">${renderChildren(node, ctx)}</div>
  ${metaHtml}
</aside>`;
}

function researchMetaHtml(node: DirectiveNode): string {
  switch (node.name) {
    case "evidence":
    case "counterevidence":
      return metaFieldsHtml([
        metaReferenceField("for", attrValueText(node.attrs, "for")),
        metaReferenceField("source", attrValueText(node.attrs, "source")),
        metaReferenceField("url", attrValueText(node.attrs, "url") ?? attrValueText(node.attrs, "href")),
        metaDoiField(attrValueText(node.attrs, "doi")),
        metaTextField("accessed", attrValueText(node.attrs, "accessed")),
      ]);
    case "risk":
      return metaFieldsHtml([
        metaTextField("severity", attrValueText(node.attrs, "severity")),
        metaTextField("owner", attrValueText(node.attrs, "owner")),
        metaTextField("status", attrValueText(node.attrs, "status")),
      ]);
    case "decision":
    case "adr":
      return metaFieldsHtml([
        metaTextField("status", attrValueText(node.attrs, "status")),
        metaTextField("owner", attrValueText(node.attrs, "owner")),
        metaTextField("date", attrValueText(node.attrs, "date") ?? attrValueText(node.attrs, "decided_at") ?? attrValueText(node.attrs, "decidedAt")),
      ]);
    case "open_question":
      return metaFieldsHtml([
        metaTextField("status", attrValueText(node.attrs, "status")),
        metaTextField("owner", attrValueText(node.attrs, "owner")),
        metaTextField("due", attrValueText(node.attrs, "due") ?? attrValueText(node.attrs, "due_at") ?? attrValueText(node.attrs, "dueAt")),
      ]);
    case "assumption":
    case "hypothesis":
    case "result":
    case "limitation":
      return metaFieldsHtml([
        metaTextField("status", attrValueText(node.attrs, "status")),
        metaTextField("owner", attrValueText(node.attrs, "owner")),
        metaTextField("confidence", attrValueText(node.attrs, "confidence")),
        metaReferenceField("source", attrValueText(node.attrs, "source")),
      ]);
    default:
      return metaFieldsHtml([
        metaReferenceField("for", attrValueText(node.attrs, "for")),
        metaReferenceField("source", attrValueText(node.attrs, "source")),
        metaTextField("severity", attrValueText(node.attrs, "severity")),
      ]);
  }
}

type ChangeRequestAction = "insert" | "delete" | "replace";

interface ChangeRequestRevision {
  action: ChangeRequestAction;
  oldText?: string;
  newText?: string;
  usedBodyAsRevisionText: boolean;
}

function renderChangeRequest(node: DirectiveNode, idAndAttrs: string, ctx: RenderCtx): string {
  const revision = changeRequestRevision(node);
  const target =
    stringAttr(node.attrs, "target") ??
    stringAttr(node.attrs, "for") ??
    stringAttr(node.attrs, "parent") ??
    stringAttr(node.attrs, "block");
  const title = revision
    ? `change_request · ${revision.action}${target ? ` ${target}` : ""}`
    : "change_request";
  const delta = revision ? `<div class="noma-change-request-delta">${changeRequestDeltaHtml(revision)}</div>` : "";
  const body = revision?.usedBodyAsRevisionText ? "" : renderChildren(node, ctx);
  return `<aside class="noma-change-request"${idAndAttrs}>
  <header class="noma-change-request-head"><span class="noma-tag">${escapeHtml(title)}</span></header>
  ${delta}
  ${body}
</aside>`;
}

function changeRequestRevision(node: DirectiveNode): ChangeRequestRevision | null {
  const rawAction = (stringAttr(node.attrs, "action") ?? stringAttr(node.attrs, "type"))?.toLowerCase();
  if (rawAction !== "insert" && rawAction !== "delete" && rawAction !== "replace") return null;

  const body = directiveText(node);
  const text = stringAttr(node.attrs, "text");
  const from = stringAttr(node.attrs, "from") ?? (rawAction === "delete" ? text : undefined);
  const to = stringAttr(node.attrs, "to") ?? (rawAction === "insert" ? text : undefined);

  if (rawAction === "replace") {
    if (!from || !to) return null;
    return { action: "replace", oldText: from, newText: to, usedBodyAsRevisionText: false };
  }
  if (rawAction === "insert") {
    const newText = to ?? body;
    if (!newText) return null;
    return { action: "insert", newText, usedBodyAsRevisionText: !to && !text };
  }
  const oldText = from ?? body;
  if (!oldText) return null;
  return { action: "delete", oldText, usedBodyAsRevisionText: !from && !text };
}

function changeRequestDeltaHtml(revision: ChangeRequestRevision): string {
  if (revision.action === "replace") {
    return `<del>${escapeHtml(revision.oldText ?? "")}</del> <ins>${escapeHtml(revision.newText ?? "")}</ins>`;
  }
  if (revision.action === "delete") return `<del>${escapeHtml(revision.oldText ?? "")}</del>`;
  return `<ins>${escapeHtml(revision.newText ?? "")}</ins>`;
}

function renderPageSetup(node: DirectiveNode, idAndAttrs: string): string {
  const declarations: string[] = [];
  const size = cssPageSize(node.attrs);
  if (size) declarations.push(`size: ${size};`);
  const margin = cssLengthAttr(node.attrs, "margin");
  if (margin) declarations.push(`margin: ${margin};`);
  for (const [attr, prop] of [
    ["margin_top", "margin-top"],
    ["margin_right", "margin-right"],
    ["margin_bottom", "margin-bottom"],
    ["margin_left", "margin-left"],
  ] as const) {
    const value = cssLengthAttr(node.attrs, attr);
    if (value) declarations.push(`${prop}: ${value};`);
  }
  return `<style class="noma-page-setup"${idAndAttrs}>@page { ${declarations.join(" ")} }</style>`;
}

function renderPageChrome(tag: "header" | "footer", node: DirectiveNode, idAndAttrs: string, ctx: RenderCtx): string {
  const pageNumbers = boolAttr(node.attrs, "page_numbers") || boolAttr(node.attrs, "page_number");
  const totalPages = boolAttr(node.attrs, "total_pages") || boolAttr(node.attrs, "page_count");
  const body = renderChildren(node, ctx);
  const page = pageNumbers
    ? `<span class="noma-page-number">Page <span class="noma-page-current">1</span>${totalPages ? ' of <span class="noma-page-total">1</span>' : ""}</span>`
    : "";
  return `<${tag} class="noma-page-${tag}"${idAndAttrs}>${body}${page}</${tag}>`;
}

function renderToc(node: DirectiveNode, idAndAttrs: string, ctx: RenderCtx): string {
  const kind = tocKind(node);
  const title = stringAttr(node.attrs, "title") ?? tocTitle(kind);
  if (kind !== "sections") {
    const entries = ctx.captions
      .filter((entry) => entry.kind === kind)
      .map((entry) => {
        const label = `${captionEntryDisplayKind(entry.kind)}: ${entry.title}`;
        const content = entry.id
          ? `<a href="#${escapeAttr(entry.id)}">${escapeHtml(label)}</a>`
          : escapeHtml(label);
        return `<li data-kind="${entry.kind}">${content}</li>`;
      })
      .join("\n");
    return `<nav class="noma-toc noma-toc-${kind}"${idAndAttrs} aria-label="${escapeAttr(title)}">
  <h2>${escapeHtml(title)}</h2>
  <ol>
${entries || `<li>No ${kind} found.</li>`}
  </ol>
</nav>`;
  }
  const maxLevel = readPositiveInteger(node.attrs.depth) ?? readPositiveInteger(node.attrs.levels) ?? 3;
  const entries = ctx.sections
    .filter((entry) => entry.level <= maxLevel)
    .map((entry) => {
      const titleHtml = escapeHtml(entry.title);
      const content = entry.id
        ? `<a href="#${escapeAttr(entry.id)}">${titleHtml}</a>`
        : titleHtml;
      return `<li data-level="${entry.level}">${content}</li>`;
    })
    .join("\n");
  return `<nav class="noma-toc"${idAndAttrs} aria-label="${escapeAttr(title)}">
  <h2>${escapeHtml(title)}</h2>
  <ol>
${entries || "<li>No sections found.</li>"}
  </ol>
</nav>`;
}

function tocKind(node: DirectiveNode): "sections" | "figures" | "tables" | "plots" {
  const raw = (
    stringAttr(node.attrs, "of") ??
    stringAttr(node.attrs, "kind") ??
    stringAttr(node.attrs, "type") ??
    "sections"
  ).toLowerCase();
  if (raw === "figure" || raw === "figures") return "figures";
  if (raw === "table" || raw === "tables") return "tables";
  if (raw === "plot" || raw === "plots" || raw === "charts") return "plots";
  return "sections";
}

function tocTitle(kind: "sections" | "figures" | "tables" | "plots"): string {
  if (kind === "figures") return "List of Figures";
  if (kind === "tables") return "List of Tables";
  if (kind === "plots") return "List of Plots";
  return "Contents";
}

function captionEntryDisplayKind(kind: CaptionEntry["kind"]): string {
  if (kind === "figures") return "Figure";
  if (kind === "tables") return "Table";
  return "Plot";
}

function renderBibliography(node: DirectiveNode, idAndAttrs: string, ctx: RenderCtx): string {
  const title = stringAttr(node.attrs, "title") ?? "Bibliography";
  const intro = node.children.length > 0
    ? renderChildren(node, ctx)
    : node.body?.trim()
      ? `<p>${inlineToHtml(node.body)}</p>`
      : "";
  const items = ctx.citations.length > 0
    ? ctx.citations.map((entry) => `<li>${renderCitationEntry(entry)}</li>`).join("\n")
    : "<li>No citations found.</li>";
  return `<section class="noma-bibliography"${idAndAttrs}>
  <h2>${escapeHtml(title)}</h2>
  ${intro}
  <ol>
${items}
  </ol>
</section>`;
}

function renderCitationEntry(entry: CitationEntry): string {
  const links: string[] = [];
  if (entry.url) links.push(`<a href="${escapeAttr(entry.url)}">URL</a>`);
  if (entry.doi) links.push(`<a href="https://doi.org/${escapeAttr(entry.doi)}">DOI: ${escapeHtml(entry.doi)}</a>`);
  if (entry.accessed) links.push(`<span>Accessed: ${escapeHtml(entry.accessed)}</span>`);
  const meta = links.length > 0 ? ` <span class="noma-citation-meta">${links.join(" · ")}</span>` : "";
  return `${escapeHtml(citationEntryText(entry))}${meta}`;
}

function citationEntryText(entry: CitationEntry): string {
  const primary = entry.source ?? entry.title ?? entry.doi ?? entry.url ?? entry.id ?? "Untitled source";
  const body = entry.body?.replace(/\s+/g, " ").trim();
  return body && body !== primary ? `${primary} - ${body}` : primary;
}

function readPositiveInteger(value: Attrs[string] | undefined): number | undefined {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (!Number.isInteger(parsed) || parsed <= 0) return undefined;
  return parsed;
}

function cssPageSize(attrs: Attrs): string | undefined {
  const size = (stringAttr(attrs, "size") ?? stringAttr(attrs, "page_size"))?.toLowerCase();
  const orientation = stringAttr(attrs, "orientation") === "landscape" ? " landscape" : "";
  if (size === "a4" || size === "letter" || size === "legal") return `${size}${orientation}`;
  const width = cssLengthAttr(attrs, "width");
  const height = cssLengthAttr(attrs, "height");
  if (width && height) return `${width} ${height}${orientation}`;
  return orientation.trim() || undefined;
}

function cssLengthAttr(attrs: Attrs, key: string): string | undefined {
  const value = attrs[key];
  if (typeof value === "number") return `${value}in`;
  if (typeof value !== "string") return undefined;
  const match = /^\s*([0-9]+(?:\.[0-9]+)?)\s*(in|mm|cm|pt|px)?\s*$/i.exec(value);
  if (!match) return undefined;
  return `${match[1]}${match[2] ?? "in"}`;
}

function parseAlignSpec(raw: string, columns: number): (string | null)[] {
  const codes = raw.split(/[,\s]+/).map((c) => c.trim().toLowerCase());
  const out: (string | null)[] = [];
  for (let i = 0; i < columns; i++) {
    const c = codes[i] ?? "-";
    if (c === "l" || c === "left") out.push("left");
    else if (c === "c" || c === "center") out.push("center");
    else if (c === "r" || c === "right") out.push("right");
    else out.push(null);
  }
  return out;
}

const splitTableLine = splitPipeRow;

function renderTableDirective(node: DirectiveNode, idAttr: string): string {
  const body = node.body ?? "";
  const lines = body.split("\n").map((l) => l.trim()).filter(Boolean);
  if (lines.length === 0) return `<div class="noma-block noma-block-table"${idAttr}></div>`;
  const rows = lines.map(splitTableLine);
  const columns = rows.reduce((m, r) => Math.max(m, r.length), 0);
  for (const r of rows) while (r.length < columns) r.push("");
  const wantsHeader = node.attrs.header === true || node.attrs.header === "true";
  const headerRow = wantsHeader ? rows.shift() : undefined;
  const align = typeof node.attrs.align === "string"
    ? parseAlignSpec(node.attrs.align, columns)
    : new Array<string | null>(columns).fill(null);

  const renderCell = (tag: "th" | "td", cell: string, idx: number): string => {
    const a = align[idx];
    const styleAttr = a ? ` style="text-align: ${a}"` : "";
    return `<${tag}${styleAttr}>${inlineToHtml(cell)}</${tag}>`;
  };

  const head = headerRow
    ? `<thead><tr>${headerRow.map((c, i) => renderCell("th", c, i)).join("")}</tr></thead>\n`
    : "";
  const bodyRows = rows
    .map((r) => `<tr>${r.map((c, i) => renderCell("td", c, i)).join("")}</tr>`)
    .join("\n");
  return `<table class="noma-table"${idAttr}>\n${head}<tbody>\n${bodyRows}\n</tbody>\n</table>`;
}

function renderStateChange(
  node: DirectiveNode,
  idAttr: string,
  ctx: RenderCtx,
): string {
  const block = node.attrs.block ? String(node.attrs.block) : undefined;
  const attribute = node.attrs.attribute ? String(node.attrs.attribute) : undefined;
  const from = node.attrs.from !== undefined ? String(node.attrs.from) : undefined;
  const to = node.attrs.to !== undefined ? String(node.attrs.to) : undefined;
  const reason = node.attrs.reason ? String(node.attrs.reason) : undefined;
  const at = node.attrs.at ? String(node.attrs.at) : undefined;
  const target = block
    ? `<a class="noma-ref" href="#${escapeAttr(block)}">${escapeHtml(block)}</a>`
    : "—";
  const attrLabel = attribute ? `<code>${escapeHtml(attribute)}</code>` : "";
  const fromTo =
    from !== undefined && to !== undefined
      ? `<span class="noma-state-from">${escapeHtml(from)}</span> <span class="noma-state-arrow" aria-hidden="true">→</span> <span class="noma-state-to">${escapeHtml(to)}</span>`
      : "";
  const meta: string[] = [];
  if (at) meta.push(`<span class="noma-meta-key">at</span> ${escapeHtml(at)}`);
  if (reason) meta.push(`<span class="noma-meta-key">why</span> ${escapeHtml(reason)}`);
  const metaHtml = meta.length ? `<div class="noma-meta">${meta.join(" · ")}</div>` : "";
  const body = renderChildren(node, ctx);
  return `<aside class="noma-state-change"${idAttr}>
  <header class="noma-state-change-head"><span class="noma-tag">state_change</span> ${target}${attribute ? ` · ${attrLabel}` : ""}</header>
  ${fromTo ? `<div class="noma-state-change-delta">${fromTo}</div>` : ""}
  ${body}
  ${metaHtml}
</aside>`;
}

function renderAgentTask(node: DirectiveNode, idAttr: string, ctx: RenderCtx): string {
  const checked = node.attrs.done === true ? " checked" : "";
  return `<div class="noma-agent-task"${idAttr}>
  <label><input type="checkbox" disabled${checked} /> <span class="noma-tag">${escapeHtml(node.name)}</span></label>
  <div class="noma-agent-body">${renderChildren(node, ctx)}</div>
</div>`;
}

function renderComment(node: DirectiveNode, idAndAttrs: string, ctx: RenderCtx): string {
  const target = commentTarget(node);
  const targetHtml = target ? ` <a href="#${escapeAttr(target)}">${escapeHtml(target)}</a>` : "";
  const meta = metaFieldsHtml([
    metaReferenceField("target", target),
    metaTextField("author", attrValueText(node.attrs, "author")),
    metaTextField("date", attrValueText(node.attrs, "date") ?? attrValueText(node.attrs, "at")),
    metaTextField("status", attrValueText(node.attrs, "status")),
    metaTextField("resolved by", attrValueText(node.attrs, "resolved_by")),
    metaTextField("resolved at", attrValueText(node.attrs, "resolved_at")),
  ]);
  const metaHtml = meta ? `<div class="noma-meta">${meta}</div>` : "";
  return `<aside class="noma-comment"${idAndAttrs}>
  <header class="noma-comment-head"><span class="noma-tag">Comment</span>${targetHtml}</header>
  <div class="noma-comment-body">${renderChildren(node, ctx)}</div>
  ${metaHtml}
</aside>`;
}

function commentTarget(node: DirectiveNode): string | undefined {
  return (
    attrValueText(node.attrs, "for") ??
    attrValueText(node.attrs, "parent") ??
    attrValueText(node.attrs, "target") ??
    attrValueText(node.attrs, "block") ??
    attrValueText(node.attrs, "ref")
  );
}

function renderReviewMetaBlock(node: DirectiveNode, idAndAttrs: string, ctx: RenderCtx): string {
  const title = reviewMetaTitle(node);
  const target = reviewTarget(node);
  const targetHtml = target ? ` <a href="#${escapeAttr(target)}">${escapeHtml(target)}</a>` : "";
  const meta = reviewMetaHtml(node);
  const metaHtml = meta ? `<div class="noma-meta">${meta}</div>` : "";
  return `<aside class="noma-review-meta noma-collab-${escapeAttr(node.name)}"${idAndAttrs}>
  <header class="noma-review-meta-head"><span class="noma-tag">${escapeHtml(title)}</span>${targetHtml}</header>
  <div class="noma-review-meta-body">${renderChildren(node, ctx)}</div>
  ${metaHtml}
</aside>`;
}

function reviewMetaTitle(node: DirectiveNode): string {
  if (node.name === "review") return "Review";
  if (node.name === "provenance") return "Provenance";
  return "Confidence";
}

function reviewTarget(node: DirectiveNode): string | undefined {
  return attrValueText(node.attrs, "for") ?? attrValueText(node.attrs, "target") ?? attrValueText(node.attrs, "block") ?? attrValueText(node.attrs, "claim");
}

function reviewMetaHtml(node: DirectiveNode): string {
  switch (node.name) {
    case "review":
      return metaFieldsHtml([
        metaTextField("status", attrValueText(node.attrs, "status")),
        metaTextField("reviewer", attrValueText(node.attrs, "reviewer") ?? attrValueText(node.attrs, "author") ?? attrValueText(node.attrs, "by")),
        metaTextField("due", attrValueText(node.attrs, "due") ?? attrValueText(node.attrs, "due_at")),
        metaTextField("date", attrValueText(node.attrs, "date") ?? attrValueText(node.attrs, "at")),
      ]);
    case "provenance":
      return metaFieldsHtml([
        metaReferenceField("source", attrValueText(node.attrs, "source")),
        metaReferenceField("url", attrValueText(node.attrs, "url") ?? attrValueText(node.attrs, "href")),
        metaTextField("tool", attrValueText(node.attrs, "tool") ?? attrValueText(node.attrs, "agent")),
        metaTextField("by", attrValueText(node.attrs, "by") ?? attrValueText(node.attrs, "author")),
        metaTextField("commit", attrValueText(node.attrs, "commit") ?? attrValueText(node.attrs, "sha")),
        metaTextField("at", attrValueText(node.attrs, "at") ?? attrValueText(node.attrs, "date")),
      ]);
    case "confidence":
      return metaFieldsHtml([
        metaTextField("value", attrValueText(node.attrs, "value") ?? attrValueText(node.attrs, "score") ?? attrValueText(node.attrs, "confidence")),
        metaTextField("basis", attrValueText(node.attrs, "basis") ?? attrValueText(node.attrs, "reason")),
        metaReferenceField("source", attrValueText(node.attrs, "source")),
        metaTextField("updated", attrValueText(node.attrs, "updated") ?? attrValueText(node.attrs, "at") ?? attrValueText(node.attrs, "date")),
      ]);
    default:
      return "";
  }
}

function renderMemoryIndex(node: DirectiveNode, idAndAttrs: string, ctx: RenderCtx): string {
  return `<aside class="noma-memory-index"${idAndAttrs}>
  <header class="noma-memory-head"><span class="noma-tag">Memory index</span></header>
  <div class="noma-memory-body">${renderChildren(node, ctx)}</div>
</aside>`;
}

function renderMemory(node: DirectiveNode, idAndAttrs: string, ctx: RenderCtx): string {
  const kind = memoryTypeKind(node);
  const title = memoryDisplayTitle(node);
  const titleHtml = title ? `<h3>${escapeHtml(title)}</h3>` : "";
  const meta = memoryMetaHtml(node);
  const metaHtml = meta ? `<div class="noma-meta">${meta}</div>` : "";
  return `<aside class="noma-memory noma-memory-${escapeAttr(kind)}"${idAndAttrs}>
  <header class="noma-memory-head"><span class="noma-tag">${escapeHtml(memoryTypeLabel(kind))}</span>${titleHtml}</header>
  <div class="noma-memory-body">${renderChildren(node, ctx)}</div>
  ${metaHtml}
</aside>`;
}

function memoryDisplayTitle(node: DirectiveNode): string | undefined {
  return attrValueText(node.attrs, "title") ?? node.id;
}

function memoryTypeKind(node: DirectiveNode): string {
  const type = attrValueText(node.attrs, "type")?.toLowerCase();
  switch (type) {
    case "user":
    case "feedback":
    case "project":
    case "reference":
      return type;
    default:
      return "unknown";
  }
}

function memoryTypeLabel(kind: string): string {
  switch (kind) {
    case "user":
      return "User memory";
    case "feedback":
      return "Feedback memory";
    case "project":
      return "Project memory";
    case "reference":
      return "Reference memory";
    default:
      return "Memory";
  }
}

function memoryMetaHtml(node: DirectiveNode): string {
  return metaFieldsHtml([
    metaTextField("type", attrValueText(node.attrs, "type")),
    metaTextField("confidence", attrValueText(node.attrs, "confidence")),
    metaTextField("last seen", attrValueText(node.attrs, "last_seen") ?? attrValueText(node.attrs, "lastSeen")),
    metaTextField("scope", attrValueText(node.attrs, "scope")),
    metaReferenceField("source", attrValueText(node.attrs, "source")),
    metaTextField("valid until", attrValueText(node.attrs, "valid_until") ?? attrValueText(node.attrs, "validUntil")),
    metaReferenceField("superseded by", attrValueText(node.attrs, "superseded_by") ?? attrValueText(node.attrs, "supersededBy")),
    boolAttr(node.attrs, "expired") ? metaTextField("expired", "true") : undefined,
  ]);
}

function renderControl(node: DirectiveNode, idAndAttrs: string, ctx: RenderCtx): string {
  const controlId = node.id ?? "";
  const rawType = (attrValueText(node.attrs, "type") ?? "number").toLowerCase();
  const min = attrValueText(node.attrs, "min");
  const max = attrValueText(node.attrs, "max");
  const step = attrValueText(node.attrs, "step");
  const value = controlDefaultText(node) ?? "";
  const unit = controlUnit(node);
  const controlData = controlId ? ` data-noma-control="${escapeAttr(controlId)}"` : "";
  const unitData = unit ? ` data-unit="${escapeAttr(unit)}"` : "";
  const input = rawType === "select"
    ? controlSelectHtml(node, controlId, value, ctx.interactive)
    : controlInputHtml(rawType, controlId, value, min, max, step, ctx.interactive);
  const output = controlId
    ? `<output class="noma-control-value" data-noma-control-value="${escapeAttr(controlId)}">${escapeHtml(formatControlValue(controlOutputValue(rawType, value), unit))}</output>`
    : "";
  return `<div class="noma-control"${idAndAttrs}${controlData}${unitData}>
  ${strictInteractiveBadge(ctx)}
  <label class="noma-control-row"><span class="noma-control-label">${escapeHtml(controlLabel(node))}</span>${input}</label>
  ${output}
</div>`;
}

function controlInputHtml(
  rawType: string,
  controlId: string,
  value: string,
  min: string | undefined,
  max: string | undefined,
  step: string | undefined,
  interactive: boolean,
): string {
  const inputType = rawType === "slider" ? "range" : rawType === "toggle" ? "checkbox" : rawType;
  const checked = (inputType === "checkbox" || inputType === "toggle") && controlDefaultChecked(value);
  const inputAttrs = [
    `type="${escapeAttr(inputType)}"`,
    controlId ? `name="${escapeAttr(controlId)}"` : undefined,
    controlId ? `data-noma-control-input="${escapeAttr(controlId)}"` : undefined,
    min !== undefined ? `min="${escapeAttr(min)}"` : undefined,
    max !== undefined ? `max="${escapeAttr(max)}"` : undefined,
    step !== undefined ? `step="${escapeAttr(step)}"` : undefined,
    inputType === "checkbox" ? `value="1"` : value !== "" ? `value="${escapeAttr(value)}"` : undefined,
    checked ? "checked" : undefined,
    interactive ? undefined : "disabled",
  ].filter((attr): attr is string => Boolean(attr)).join(" ");
  return `<input ${inputAttrs} />`;
}

function controlSelectHtml(node: DirectiveNode, controlId: string, value: string, interactive: boolean): string {
  const options = controlOptionsWithDefault(node, value);
  const attrs = [
    controlId ? `name="${escapeAttr(controlId)}"` : undefined,
    controlId ? `data-noma-control-input="${escapeAttr(controlId)}"` : undefined,
    interactive ? undefined : "disabled",
  ].filter((attr): attr is string => Boolean(attr)).join(" ");
  const optionHtml = options
    .map((option) => `<option value="${escapeAttr(option.value)}"${option.value === value ? " selected" : ""}>${escapeHtml(option.label)}</option>`)
    .join("");
  return `<select${attrs ? ` ${attrs}` : ""}>${optionHtml}</select>`;
}

function controlOptionsWithDefault(node: DirectiveNode, value: string): ReturnType<typeof controlOptions> {
  const options = controlOptions(node);
  if (!value || options.some((option) => option.value === value)) return options;
  return [{ value, label: value }, ...options];
}

function controlOutputValue(rawType: string, value: string): string {
  return rawType === "checkbox" || rawType === "toggle" ? (controlDefaultChecked(value) ? "1" : "0") : value;
}

function controlDefaultChecked(value: string): boolean {
  const normalized = value.toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on" || normalized === "checked";
}

function renderComputedMetric(node: DirectiveNode, idAndAttrs: string, ctx: RenderCtx): string {
  const label = computedLabel(node, "Computed metric");
  const unit = controlUnit(node);
  const formula = formulaText(node);
  const value = evaluateComputedNode(node, ctx.computed);
  const valueText = value !== undefined ? computedValueText(value, unit) : "—";
  const body = computedBodyHtml(node, ctx);
  const meta = computedMetaHtml(node, formula);
  const metaHtml = meta ? `<div class="noma-meta">${meta}</div>` : "";
  return `<aside class="noma-computed noma-computed-metric"${idAndAttrs} data-noma-computed="metric"${unit ? ` data-unit="${escapeAttr(unit)}"` : ""}${computedDataAttrs(node)}>
  ${strictInteractiveBadge(ctx)}
  <header class="noma-computed-head"><span class="noma-tag">Computed metric</span><h3>${escapeHtml(label)}</h3></header>
  <div class="noma-computed-value" data-noma-computed-value>${escapeHtml(valueText)}</div>
  ${body}
  ${metaHtml}
</aside>`;
}

function renderComputedPlot(node: DirectiveNode, idAndAttrs: string, ctx: RenderCtx): string {
  const title = computedLabel(node, "Computed plot");
  const type = attrValueText(node.attrs, "type") ?? "line";
  const width = Number(node.attrs.width ?? 320);
  const compact = attrBool(node.attrs.compact);
  const height = Number(node.attrs.height ?? (compact ? 112 : 140));
  const series = evaluateComputedSeries(node, ctx.computed);
  const labelOptions = plotLabelOptionsFromAttrs(node.attrs, compact);
  const labels = series ? series.points.map(formatComputedNumber) : [];
  const svg = series
    ? renderChartSvg([{ name: title, values: series.values }], type, width, height, labels, labelOptions)
    : placeholderPlotSvg(width, height);
  const formula = formulaText(node);
  const domain = computedDomainText(node);
  const captionParts = [
    escapeHtml(title),
    `<span class="noma-meta-key">type</span> ${escapeHtml(type)}`,
    domain ? `<span class="noma-meta-key">domain</span> ${escapeHtml(domain)}` : undefined,
  ].filter((part): part is string => Boolean(part));
  const body = computedBodyHtml(node, ctx);
  const meta = computedMetaHtml(node, formula);
  const metaHtml = meta ? `<div class="noma-meta">${meta}</div>` : "";
  return `<figure class="noma-computed noma-computed-plot noma-plot"${idAndAttrs} data-noma-computed="plot" data-chart-type="${escapeAttr(type)}" data-width="${escapeAttr(String(width))}" data-height="${escapeAttr(String(height))}"${domain ? ` data-domain="${escapeAttr(domain)}"` : ""}${computedDataAttrs(node)}>
  ${strictInteractiveBadge(ctx)}
  <div class="noma-plot-canvas noma-computed-canvas" data-noma-computed-plot>
    ${svg}
  </div>
  <figcaption>${captionParts.join(" · ")}</figcaption>
  ${body}
  ${metaHtml}
</figure>`;
}

function renderComputedTable(node: DirectiveNode, idAndAttrs: string, ctx: RenderCtx): string {
  const title = computedLabel(node, "Computed table");
  const unit = controlUnit(node);
  const formula = formulaText(node);
  const domain = computedDomainText(node);
  const series = evaluateComputedSeries(node, ctx.computed);
  const variable = series?.variable ?? parseComputedTableVariable(domain) ?? "input";
  const [variableLabel, valueLabel] = computedTableHeaders(node, variable);
  const rows = series
    ? series.points.map((point, index) => {
      const rawValue = series.values[index];
      const value = rawValue !== undefined ? computedValueText(rawValue, unit) : "—";
      return `<tr><td>${escapeHtml(formatComputedNumber(point))}</td><td>${escapeHtml(value)}</td></tr>`;
    }).join("")
    : `<tr><td colspan="2">—</td></tr>`;
  const body = computedBodyHtml(node, ctx);
  const meta = computedMetaHtml(node, formula);
  const metaHtml = meta ? `<div class="noma-meta">${meta}</div>` : "";
  return `<aside class="noma-computed noma-computed-table"${idAndAttrs} data-noma-computed="table"${domain ? ` data-domain="${escapeAttr(domain)}"` : ""}${unit ? ` data-unit="${escapeAttr(unit)}"` : ""}${computedDataAttrs(node)}>
  ${strictInteractiveBadge(ctx)}
  <header class="noma-computed-head"><span class="noma-tag">Computed table</span><h3>${escapeHtml(title)}</h3></header>
  <table class="noma-table noma-computed-table-view">
    <thead><tr><th>${escapeHtml(variableLabel)}</th><th>${escapeHtml(valueLabel)}</th></tr></thead>
    <tbody data-noma-computed-table>${rows}</tbody>
  </table>
  ${body}
  ${metaHtml}
</aside>`;
}

function strictInteractiveBadge(ctx: RenderCtx): string {
  if (ctx.interactive || ctx.strictInteractiveBadgeEmitted) return "";
  ctx.strictInteractiveBadgeEmitted = true;
  return `<span class="noma-interactive-disabled">interactive controls disabled in strict mode</span>`;
}

function controlLabel(node: DirectiveNode): string {
  return attrValueText(node.attrs, "label") ??
    attrValueText(node.attrs, "title") ??
    attrValueText(node.attrs, "name") ??
    bodyFieldText(node, "label") ??
    freeformBodyText(node, ["label", "unit", "default", "min", "max", "step"]) ??
    node.id ??
    "Control";
}

function controlUnit(node: DirectiveNode): string | undefined {
  return attrValueText(node.attrs, "unit") ?? attrValueText(node.attrs, "suffix") ?? bodyFieldText(node, "unit");
}

function computedLabel(node: DirectiveNode, fallback: string): string {
  return attrValueText(node.attrs, "label") ??
    attrValueText(node.attrs, "title") ??
    attrValueText(node.attrs, "name") ??
    bodyFieldText(node, "label") ??
    bodyFieldText(node, "title") ??
    node.id ??
    fallback;
}

function computedBodyHtml(node: DirectiveNode, ctx: RenderCtx): string {
  if (node.body !== undefined) {
    const text = freeformBodyText(node, [
      "formula",
      "domain",
      "range",
      "title",
      "label",
      "unit",
      "variable_label",
      "variableLabel",
      "x_label",
      "xLabel",
      "value_label",
      "valueLabel",
      "y_label",
      "yLabel",
    ]);
    return text ? `<div class="noma-computed-body"><p>${inlineToHtml(text)}</p></div>` : "";
  }
  const rendered = renderChildren(node, ctx);
  return rendered ? `<div class="noma-computed-body">${rendered}</div>` : "";
}

function freeformBodyText(node: DirectiveNode, metadataKeys: string[]): string | undefined {
  const body = node.body ?? "";
  if (!body.trim()) return undefined;
  const metadata = new Set(metadataKeys.map((key) => key.toLowerCase()));
  const lines = body
    .split(/\r?\n/)
    .filter((line) => {
      const match = /^\s*([A-Za-z_][\w.-]*)\s*:/.exec(line);
      return !match || !metadata.has(match[1]!.toLowerCase());
    })
    .map((line) => line.trim())
    .filter(Boolean);
  return lines.length > 0 ? lines.join("\n") : undefined;
}

function computedMetaHtml(node: DirectiveNode, formula: string | undefined): string {
  const parsed = formula ? parseFormula(formula) : undefined;
  const deps = parsed?.ok ? extractFormulaIdentifiers(parsed.ast).join(", ") : undefined;
  return metaFieldsHtml([
    metaTextField("formula", formula),
    metaTextField("domain", computedDomainText(node)),
    metaTextField("depends on", deps),
    metaTextField("unit", controlUnit(node)),
  ]);
}

function parseComputedTableVariable(domain: string | undefined): string | undefined {
  return domain?.split(":", 1)[0]?.trim() || undefined;
}

function computedTableHeaders(node: DirectiveNode, variable: string): [string, string] {
  const variableLabel =
    attrValueText(node.attrs, "variable_label") ??
    attrValueText(node.attrs, "variableLabel") ??
    attrValueText(node.attrs, "x_label") ??
    attrValueText(node.attrs, "xLabel") ??
    bodyFieldText(node, "variable_label") ??
    bodyFieldText(node, "variableLabel") ??
    bodyFieldText(node, "x_label") ??
    bodyFieldText(node, "xLabel") ??
    variable;
  const valueLabel =
    attrValueText(node.attrs, "value_label") ??
    attrValueText(node.attrs, "valueLabel") ??
    attrValueText(node.attrs, "y_label") ??
    attrValueText(node.attrs, "yLabel") ??
    bodyFieldText(node, "value_label") ??
    bodyFieldText(node, "valueLabel") ??
    bodyFieldText(node, "y_label") ??
    bodyFieldText(node, "yLabel") ??
    computedLabel(node, "Value");
  return [variableLabel, valueLabel];
}

function computedDataAttrs(node: DirectiveNode): string {
  const formula = formulaText(node);
  if (!formula) return "";
  const parsed = parseFormula(formula);
  const astAttr = parsed.ok ? ` data-formula-ast="${escapeAttr(JSON.stringify(parsed.ast))}"` : "";
  return ` data-formula="${escapeAttr(formula)}"${astAttr}`;
}

function computedValueText(value: number, unit: string | undefined): string {
  return formatControlValue(formatComputedNumber(value), unit);
}

function formatControlValue(value: string, unit: string | undefined): string {
  if (!unit || !value) return value;
  if (value.endsWith(unit)) return value;
  if (/^[%°]/.test(unit)) return `${value}${unit}`;
  return `${value} ${unit}`;
}

function placeholderPlotSvg(width: number, height: number): string {
  return `<svg viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <polyline points="0,${height - 20} ${width * 0.13},${height - 40} ${width * 0.25},${height - 30} ${width * 0.38},${height - 60} ${width * 0.5},${height - 65} ${width * 0.63},${height - 80} ${width * 0.75},${height - 85} ${width * 0.88},${height - 100} ${width},${height - 105}"
        fill="none" stroke="currentColor" stroke-width="2" />
    </svg>`;
}

function renderMetric(node: DirectiveNode, idAndAttrs: string, ctx: RenderCtx): string {
  const label = metricLabel(node);
  const valueAttr =
    attrValueText(node.attrs, "value") ??
    attrValueText(node.attrs, "current") ??
    attrValueText(node.attrs, "amount");
  const bodyValue = directiveText(node);
  const value = valueAttr ?? bodyValue;
  const usedBodyAsValue = valueAttr === undefined && bodyValue.length > 0;
  const valueHtml = value
    ? `<div class="noma-metric-value">${escapeHtml(metricValueText(value, attrValueText(node.attrs, "unit")))}</div>`
    : "";
  const body = usedBodyAsValue ? "" : renderChildren(node, ctx);
  const meta = metricMetaHtml(node);
  const metaHtml = meta ? `<div class="noma-meta">${meta}</div>` : "";
  return `<aside class="noma-metric"${idAndAttrs}>
  <header class="noma-metric-head"><span class="noma-tag">Metric</span><h3>${escapeHtml(label)}</h3></header>
  ${valueHtml}
  ${body ? `<div class="noma-metric-body">${body}</div>` : ""}
  ${metaHtml}
</aside>`;
}

function metricLabel(node: DirectiveNode): string {
  return attrValueText(node.attrs, "label") ?? attrValueText(node.attrs, "title") ?? attrValueText(node.attrs, "name") ?? node.id ?? "Metric";
}

function metricValueText(value: string, unit: string | undefined): string {
  if (!unit || value.endsWith(unit)) return value;
  if (/^[%°]/.test(unit)) return `${value}${unit}`;
  return `${value} ${unit}`;
}

function metricMetaHtml(node: DirectiveNode): string {
  return metaFieldsHtml([
    metaTextField("status", attrValueText(node.attrs, "status")),
    metaTextField("trend", attrValueText(node.attrs, "trend")),
    metaTextField("change", attrValueText(node.attrs, "change") ?? attrValueText(node.attrs, "delta")),
    metaTextField("target", attrValueText(node.attrs, "target")),
    metaReferenceField("source", attrValueText(node.attrs, "source")),
    metaTextField("as of", attrValueText(node.attrs, "as_of") ?? attrValueText(node.attrs, "asOf") ?? attrValueText(node.attrs, "date")),
  ]);
}

function renderCodeDirective(node: DirectiveNode, idAndAttrs: string, ctx: RenderCtx): string {
  const language = attrValueText(node.attrs, "lang") ?? attrValueText(node.attrs, "language");
  const title = attrValueText(node.attrs, "title") ?? attrValueText(node.attrs, "label") ?? node.id;
  const titleHtml = title ? `<h3>${escapeHtml(title)}</h3>` : "";
  const meta = metaFieldsHtml([metaTextField("language", language)]);
  const metaHtml = meta ? `<div class="noma-technical-meta">${meta}</div>` : "";
  return `<article class="noma-technical noma-code-block"${idAndAttrs}>
  <header class="noma-technical-head"><span class="noma-tag">Code</span>${titleHtml}</header>
  ${metaHtml}
  <div class="noma-technical-body">${renderCodeLikeBody(node, language, ctx)}</div>
</article>`;
}

function renderCodeCell(node: DirectiveNode, idAndAttrs: string, ctx: RenderCtx): string {
  const language = attrValueText(node.attrs, "lang") ?? attrValueText(node.attrs, "language");
  const titleHtml = language ? `<h3>${escapeHtml(language)}</h3>` : "";
  const meta = metaFieldsHtml([
    metaTextField("kernel", attrValueText(node.attrs, "kernel") ?? attrValueText(node.attrs, "runtime")),
    metaTextField("status", attrValueText(node.attrs, "status")),
    metaTextField("execution", attrValueText(node.attrs, "execution_count") ?? attrValueText(node.attrs, "count")),
  ]);
  const metaHtml = meta ? `<div class="noma-technical-meta">${meta}</div>` : "";
  return `<article class="noma-technical noma-code-cell"${idAndAttrs}>
  <header class="noma-technical-head"><span class="noma-tag">Code cell</span>${titleHtml}</header>
  ${metaHtml}
  <div class="noma-technical-body">${renderCodeLikeBody(node, language, ctx)}</div>
</article>`;
}

function renderOutputBlock(node: DirectiveNode, idAndAttrs: string, ctx: RenderCtx): string {
  const kind = attrValueText(node.attrs, "type") ?? attrValueText(node.attrs, "mime") ?? attrValueText(node.attrs, "format");
  const titleHtml = kind ? `<h3>${escapeHtml(kind)}</h3>` : "";
  const meta = metaFieldsHtml([
    metaReferenceField("for", attrValueText(node.attrs, "for") ?? attrValueText(node.attrs, "cell") ?? attrValueText(node.attrs, "source")),
    metaTextField("status", attrValueText(node.attrs, "status")),
    metaTextField("mime", attrValueText(node.attrs, "mime")),
  ]);
  const metaHtml = meta ? `<div class="noma-technical-meta">${meta}</div>` : "";
  return `<article class="noma-technical noma-output-block"${idAndAttrs}>
  <header class="noma-technical-head"><span class="noma-tag">Output</span>${titleHtml}</header>
  ${metaHtml}
  <div class="noma-technical-body">${renderCodeLikeBody(node, kind, ctx)}</div>
</article>`;
}

function renderCodeLikeBody(node: DirectiveNode, language: string | undefined, ctx: RenderCtx): string {
  if (hasSimpleCodeBody(node)) return renderTechnicalCode(simpleCodeText(node), language ?? "");
  return renderChildren(node, ctx);
}

function hasSimpleCodeBody(node: DirectiveNode): boolean {
  if (node.body?.trim()) return true;
  return node.children.length > 0 && node.children.every((child) => child.type === "paragraph" || child.type === "code");
}

function simpleCodeText(node: DirectiveNode): string {
  if (node.body !== undefined) return node.body;
  return node.children
    .map((child) => {
      if (child.type === "paragraph" || child.type === "code") return child.content;
      return "";
    })
    .filter(Boolean)
    .join("\n");
}

function renderTechnicalDirective(node: DirectiveNode, idAndAttrs: string, ctx: RenderCtx): string {
  const label = technicalLabel(node.name);
  const title = technicalTitle(node);
  const titleHtml = title ? `<h3>${escapeHtml(title)}</h3>` : "";
  const meta = technicalMetaHtml(node);
  const body = technicalBodyHtml(node, ctx);
  const metaHtml = meta ? `<div class="noma-technical-meta">${meta}</div>` : "";
  const bodyHtml = body ? `<div class="noma-technical-body">${body}</div>` : "";
  return `<article class="noma-technical noma-technical-${escapeAttr(node.name)}"${idAndAttrs}>
  <header class="noma-technical-head"><span class="noma-tag">${escapeHtml(label)}</span>${titleHtml}</header>
  ${metaHtml}
  ${bodyHtml}
</article>`;
}

function technicalLabel(name: string): string {
  switch (name) {
    case "api":
      return "API";
    case "endpoint":
      return "Endpoint";
    case "parameter":
      return "Parameter";
    case "example":
      return "Example";
    case "query":
      return "Query";
    case "instruction":
      return "Instruction";
    case "changelog":
      return "Changelog";
    default:
      return name;
  }
}

function technicalTitle(node: DirectiveNode): string | undefined {
  const title = stringAttr(node.attrs, "title") ?? stringAttr(node.attrs, "label");
  if (title) return title;
  switch (node.name) {
    case "api":
      return stringAttr(node.attrs, "name") ?? node.id;
    case "endpoint": {
      const method = stringAttr(node.attrs, "method")?.toUpperCase();
      const path = stringAttr(node.attrs, "path");
      if (method && path) return `${method} ${path}`;
      return path ?? method ?? node.id;
    }
    case "parameter":
      return stringAttr(node.attrs, "name") ?? node.id;
    case "example":
      return stringAttr(node.attrs, "for") ? `for ${stringAttr(node.attrs, "for")}` : node.id;
    case "query":
      return stringAttr(node.attrs, "dataset") ? `for ${stringAttr(node.attrs, "dataset")}` : node.id;
    case "changelog":
      return stringAttr(node.attrs, "version") ?? stringAttr(node.attrs, "date") ?? node.id;
    case "instruction":
      return stringAttr(node.attrs, "scope") ?? stringAttr(node.attrs, "audience") ?? node.id;
    default:
      return node.id;
  }
}

function technicalMetaHtml(node: DirectiveNode): string {
  const keys = technicalMetaKeys(node.name);
  const items = keys
    .filter((key) => node.attrs[key] !== undefined)
    .map((key) => `<span><span class="noma-meta-key">${escapeHtml(technicalMetaLabel(key))}</span> ${technicalValueHtml(key, node.attrs[key])}</span>`);
  return items.join(" · ");
}

function technicalMetaKeys(name: string): string[] {
  switch (name) {
    case "api":
      return ["version", "base_url", "status", "owner"];
    case "endpoint":
      return ["method", "path", "auth", "api", "status"];
    case "parameter":
      return ["name", "in", "type", "required", "default", "enum"];
    case "example":
      return ["lang", "for", "status"];
    case "query":
      return ["lang", "dataset", "source", "status"];
    case "instruction":
      return ["scope", "audience", "priority", "owner"];
    case "changelog":
      return ["version", "date", "status"];
    default:
      return [];
  }
}

function technicalMetaLabel(key: string): string {
  if (key === "base_url") return "base URL";
  if (key === "lang") return "language";
  return key.replace(/_/g, " ");
}

function technicalValueHtml(key: string, value: Attrs[string] | undefined): string {
  const text = String(value ?? "");
  if (key === "base_url" || /^https?:\/\//.test(text)) {
    return `<a href="${escapeAttr(text)}">${escapeHtml(text)}</a>`;
  }
  if (key === "api" || key === "for" || key === "dataset") {
    return `<a href="#${escapeAttr(text)}">${escapeHtml(text)}</a>`;
  }
  if (key === "method" || key === "path" || key === "type" || key === "default" || key === "enum") {
    return `<code>${escapeHtml(text)}</code>`;
  }
  return escapeHtml(text);
}

function technicalBodyHtml(node: DirectiveNode, ctx: RenderCtx): string {
  const language = technicalLanguage(node);
  if ((node.name === "example" || node.name === "query") && language && hasSimpleCodeBody(node)) {
    return renderTechnicalCode(simpleCodeText(node), language);
  }
  return renderChildren(node, ctx);
}

function technicalLanguage(node: DirectiveNode): string | undefined {
  return stringAttr(node.attrs, "lang") ?? stringAttr(node.attrs, "language");
}

function renderTechnicalCode(source: string, language: string): string {
  const langClass = language ? ` class="lang-${escapeAttr(language)}"` : "";
  return `<pre class="noma-technical-code"><code${langClass}>${escapeHtml(source)}</code></pre>`;
}

function attrValueText(attrs: Attrs, key: string): string | undefined {
  const value = attrs[key];
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return undefined;
}

function metaTextField(label: string, value: string | undefined): string | undefined {
  return value ? `<span><span class="noma-meta-key">${escapeHtml(label)}</span> ${escapeHtml(value)}</span>` : undefined;
}

function metaReferenceField(label: string, value: string | undefined): string | undefined {
  if (!value) return undefined;
  return `<span><span class="noma-meta-key">${escapeHtml(label)}</span> ${referenceValueHtml(value)}</span>`;
}

function metaDoiField(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const href = /^https?:\/\//.test(value) ? value : `https://doi.org/${value}`;
  return `<span><span class="noma-meta-key">doi</span> <a href="${escapeAttr(href)}">${escapeHtml(value)}</a></span>`;
}

function referenceValueHtml(value: string): string {
  if (/^https?:\/\//.test(value)) return `<a href="${escapeAttr(value)}">${escapeHtml(value)}</a>`;
  return `<a href="#${escapeAttr(value)}">${escapeHtml(value)}</a>`;
}

function metaFieldsHtml(fields: Array<string | undefined>): string {
  return fields.filter((field): field is string => Boolean(field)).join(" · ");
}

function renderDiagram(node: DirectiveNode, idAttr: string): string {
  const kind = String(node.attrs.kind ?? "mermaid").toLowerCase();
  const body = node.body ?? "";
  const caption = typeof node.attrs.caption === "string" ? node.attrs.caption : "";
  if (kind === "drawio") {
    const config = JSON.stringify({
      highlight: "#0066cc",
      nav: true,
      resize: true,
      toolbar: "zoom layers tags lightbox",
      edit: "_blank",
      xml: body,
    });
    const fig = `<div class="mxgraph" data-mxgraph="${escapeAttr(config)}"></div>`;
    return wrapDiagram("drawio", idAttr, fig, caption);
  }
  const cls = `noma-diagram noma-diagram-${escapeAttr(kind)}`;
  const placeholder = `<pre class="noma-diagram-source">${escapeHtml(body)}</pre>`;
  const figure = `<div class="${cls}" data-noma-source="${escapeAttr(body)}">${placeholder}</div>`;
  return wrapDiagram(kind, idAttr, figure, caption);
}

function wrapDiagram(kind: string, idAttr: string, inner: string, caption: string): string {
  const cap = caption ? `<figcaption>${escapeHtml(caption)}</figcaption>` : "";
  return `<figure class="noma-diagram-wrap" data-kind="${escapeAttr(kind)}"${idAttr}>${inner}${cap}</figure>`;
}

function renderPlotly(node: DirectiveNode, idAttr: string): string {
  const body = node.body ?? "";
  const caption = typeof node.attrs.caption === "string" ? node.attrs.caption : "";
  const cap = caption ? `<figcaption>${escapeHtml(caption)}</figcaption>` : "";
  return `<figure class="noma-plotly-wrap"${idAttr}><div class="noma-plotly" data-noma-source="${escapeAttr(body)}"></div>${cap}</figure>`;
}

function renderPlotPlaceholder(
  node: DirectiveNode,
  idAttr: string,
  ctx: RenderCtx,
): string {
  const title = node.attrs.title ? String(node.attrs.title) : "Plot";
  const dataSrc = node.attrs.data ?? node.attrs.dataset ?? "—";
  const plot = renderPlotSvgForNode(node, ctx.datasets);
  const compactAttr = plot.compact ? ` data-compact="true"` : "";
  return `<figure class="noma-plot"${idAttr}${compactAttr}>
  <div class="noma-plot-canvas" data-type="${escapeAttr(plot.type)}" data-source="${escapeAttr(String(dataSrc))}">
    ${plot.svg}
  </div>
  <figcaption>${escapeHtml(title)} <span class="noma-meta-key">type</span> ${escapeHtml(plot.type)} · <span class="noma-meta-key">source</span> ${escapeHtml(plot.sourceLabel)}</figcaption>
</figure>`;
}

export interface PlotSvgResult {
  svg: string;
  type: string;
  width: number;
  height: number;
  compact: boolean;
  sourceLabel: string;
  totalPoints: number;
}

export function renderPlotSvgForNode(
  node: DirectiveNode,
  datasets: Map<string, DatasetTable>,
): PlotSvgResult {
  const dataSrc = node.attrs.data ?? node.attrs.dataset ?? "—";
  const type = String(node.attrs.type ?? "line");
  const width = Number(node.attrs.width ?? 320);
  const compact = attrBool(node.attrs.compact);
  const height = Number(node.attrs.height ?? (compact ? 112 : 140));
  const labelOptions = plotLabelOptionsFromAttrs(node.attrs, compact);

  const multi = resolveFromDatasetMulti(node, datasets);
  let seriesList: Array<{ name: string; values: number[] }>;
  let labels: string[];

  if (multi) {
    seriesList = multi.series;
    labels = multi.labels;
  } else {
    const single = resolveFromDataset(node, datasets);
    const values = single?.values ?? parseSeries(node);
    seriesList = values.length >= 2
      ? [{ name: single?.column ?? String(node.attrs.column ?? ""), values }]
      : [];
    labels = single?.labels ?? parseLabels(node);
  }

  const totalPoints = seriesList.reduce((s, ser) => s + ser.values.length, 0);
  const svg = seriesList.length > 0 && seriesList[0]!.values.length >= 2
    ? renderChartSvg(seriesList, type, width, height, labels, labelOptions)
    : `<svg viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <polyline points="0,${height - 20} ${width * 0.13},${height - 40} ${width * 0.25},${height - 30} ${width * 0.38},${height - 60} ${width * 0.5},${height - 65} ${width * 0.63},${height - 80} ${width * 0.75},${height - 85} ${width * 0.88},${height - 100} ${width},${height - 105}"
        fill="none" stroke="currentColor" stroke-width="2" />
    </svg>`;

  const sourceLabel = totalPoints >= 2
    ? `${seriesList[0]!.values.length} points${seriesList.length > 1 ? ` × ${seriesList.length} series` : ""}`
    : String(dataSrc);
  return { svg, type, width, height, compact, sourceLabel, totalPoints };
}

function resolveFromDataset(
  node: DirectiveNode,
  datasets: Map<string, DatasetTable>,
): { values: number[]; labels: string[]; column: string } | null {
  const dsId = node.attrs.dataset;
  if (typeof dsId !== "string") return null;
  const table = datasets.get(dsId);
  if (!table) return null;
  const column = typeof node.attrs.column === "string" ? node.attrs.column : undefined;
  const resolved = resolvePlotData(table, column);
  if (!resolved) return null;
  const xColumn = typeof node.attrs.xcolumn === "string" ? node.attrs.xcolumn : undefined;
  const labels = xColumn ? (resolvePlotLabels(table, xColumn) ?? []) : parseLabels(node);
  return { values: resolved.values, labels, column: resolved.column };
}

function resolveFromDatasetMulti(
  node: DirectiveNode,
  datasets: Map<string, DatasetTable>,
): { series: Array<{ name: string; values: number[] }>; labels: string[] } | null {
  const dsId = node.attrs.dataset;
  if (typeof dsId !== "string") return null;
  const table = datasets.get(dsId);
  if (!table) return null;
  const colsAttr = node.attrs.columns;
  if (typeof colsAttr !== "string") return null;
  const colNames = colsAttr.split(/[,\s]+/).map((s) => s.trim()).filter(Boolean);
  if (colNames.length === 0) return null;
  const series: Array<{ name: string; values: number[] }> = [];
  for (const name of colNames) {
    const resolved = resolvePlotData(table, name);
    if (!resolved) continue;
    series.push({ name: resolved.column, values: resolved.values });
  }
  if (series.length === 0) return null;
  const xColumn = typeof node.attrs.xcolumn === "string" ? node.attrs.xcolumn : undefined;
  const labels = xColumn ? (resolvePlotLabels(table, xColumn) ?? []) : parseLabels(node);
  return { series, labels };
}

function parseSeries(node: DirectiveNode): number[] {
  const tryParse = (raw: string): number[] => {
    const parts = raw.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
    const nums = parts.map(Number);
    if (nums.length >= 2 && nums.every((n) => Number.isFinite(n))) return nums;
    return [];
  };
  const data = node.attrs.data;
  if (typeof data === "string" && !data.includes("/") && !data.endsWith(".csv")) {
    const fromAttr = tryParse(data);
    if (fromAttr.length) return fromAttr;
  }
  if (typeof data === "number") return [];
  if (node.body) {
    const lines = node.body
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l && !l.startsWith("#") && !/^[a-zA-Z_]+\s*:/.test(l));
    const inline = tryParse(lines.join(" "));
    if (inline.length) return inline;
  }
  return [];
}

function parseLabels(node: DirectiveNode): string[] {
  const raw = node.attrs.xlabels;
  if (typeof raw !== "string") return [];
  return raw.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
}

// Categorical palette tuned for distinguishability on a near-white background.
// First color is the existing "currentColor" deep blue used by single-series
// charts (kept identical so single-series renders are byte-stable across the
// multi-series refactor).
const PLOT_COLORS = [
  "currentColor",
  "#cf6037",
  "#2e8b57",
  "#8b6c1a",
  "#5a6071",
  "#a8362e",
];

interface PlotLabelOptions {
  xLabelAngle?: number;
  xLabelWrap?: number;
  xLabelAbbrev?: number;
  compact: boolean;
}

function plotLabelOptionsFromAttrs(attrs: Attrs, compact: boolean): PlotLabelOptions {
  const angle = numericAttr(attrs, "xlabel_angle");
  const wrap = numericAttr(attrs, "xlabel_wrap");
  const abbrev = numericAttr(attrs, "xlabel_abbrev");
  return {
    ...(angle !== undefined ? { xLabelAngle: normalizeXLabelAngle(angle) } : {}),
    ...(wrap !== undefined ? { xLabelWrap: Math.max(1, Math.floor(wrap)) } : {}),
    ...(abbrev !== undefined ? { xLabelAbbrev: Math.max(4, Math.floor(abbrev)) } : {}),
    compact,
  };
}

function numericAttr(attrs: Attrs, key: string): number | undefined {
  const raw = attrs[key];
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  if (typeof raw !== "string" || !raw.trim()) return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

function attrBool(value: Attrs[string] | undefined): boolean {
  if (value === true) return true;
  if (typeof value === "string") return value === "true" || value === "yes";
  return false;
}

function normalizeXLabelAngle(value: number): number {
  if (value === 0) return 0;
  return -Math.min(90, Math.abs(value));
}

interface PlotLabelText {
  full: string;
  lines: string[];
  shortened: boolean;
}

function formatPlotLabel(label: string, options: PlotLabelOptions): PlotLabelText {
  let text = label;
  let shortened = false;
  if (options.xLabelAbbrev !== undefined && text.length > options.xLabelAbbrev) {
    text = `${text.slice(0, Math.max(1, options.xLabelAbbrev - 3))}...`;
    shortened = true;
  }
  const lines = options.xLabelWrap !== undefined
    ? wrapPlotLabel(text, options.xLabelWrap)
    : [text];
  return { full: label, lines, shortened };
}

function wrapPlotLabel(label: string, maxChars: number): string[] {
  if (label.length <= maxChars) return [label];
  const chunks: string[] = [];
  const parts = label.split(/([_\-\s]+)/).filter(Boolean);
  let line = "";
  const pushLine = () => {
    const trimmed = line.trim();
    if (trimmed) chunks.push(trimmed);
    line = "";
  };
  for (const part of parts) {
    if (part.length > maxChars) {
      pushLine();
      for (let i = 0; i < part.length; i += maxChars) {
        chunks.push(part.slice(i, i + maxChars));
      }
      continue;
    }
    if ((line + part).trim().length > maxChars) pushLine();
    line += part;
  }
  pushLine();
  return chunks.length > 0 ? chunks : [label];
}

function renderPlotLabel(
  label: PlotLabelText,
  x: number,
  y: number,
  angle: number,
  anchor: string,
  fontPx: number,
  lineH: number,
): string {
  const transform = angle !== 0
    ? ` transform="translate(${x.toFixed(1)} ${y.toFixed(1)}) rotate(${angle})"`
    : ` x="${x.toFixed(1)}" y="${y.toFixed(1)}"`;
  const tspanX = angle !== 0 ? "0" : x.toFixed(1);
  const title = label.shortened ? `<title>${escapeHtml(label.full)}</title>` : "";
  const tspans = label.lines
    .map((line, idx) => `<tspan x="${tspanX}" dy="${idx === 0 ? 0 : lineH}">${escapeHtml(line)}</tspan>`)
    .join("");
  return `<text${transform} text-anchor="${anchor}" font-size="${fontPx}" fill="currentColor" opacity="0.7">${title}${tspans}</text>`;
}

function renderChartSvg(
  seriesList: Array<{ name: string; values: number[] }>,
  type: string,
  w: number,
  h: number,
  labels: string[],
  labelOptions: PlotLabelOptions,
): string {
  // Bar plots reserve half a slot of margin so end bars don't run past the
  // data-area edge. Line/area plots anchor to the edges.
  const isBar = type === "bar";
  const nSeries = seriesList.length;
  const N = seriesList[0]?.values.length ?? 0;
  const showLegend = nSeries > 1;

  const FONT_PX = 9;
  const LINE_H = 11;
  const CHAR_W = 5.5; // approx avg width of a 9pt sans char
  const labelTexts = labels.map((label) => formatPlotLabel(label, labelOptions));
  const innerWProbe = w - 28 - (isBar ? 12 : 6);
  const slotW = labels.length ? innerWProbe / Math.max(1, N) : 0;
  const longest = labelTexts.reduce(
    (m, l) => Math.max(m, l.lines.reduce((lineMax, line) => Math.max(lineMax, line.length * CHAR_W), 0)),
    0,
  );
  const maxLabelLines = labelTexts.reduce((m, l) => Math.max(m, l.lines.length), 1);
  const autoAngle = isBar && labels.length > 1 && longest > slotW * 0.95 ? -35 : 0;
  const xLabelAngle = labelOptions.xLabelAngle ?? autoAngle;
  const rotateLabels = xLabelAngle !== 0;

  const padL = 28;
  const padR = isBar ? 12 : 6;
  const padT = showLegend ? 22 : labelOptions.compact ? 6 : 8;
  const straightLabelH = maxLabelLines * LINE_H + 8;
  const rotatedLabelH = Math.ceil(longest * Math.sin((Math.abs(xLabelAngle) * Math.PI) / 180)) + maxLabelLines * LINE_H + 8;
  const padB = labels.length
    ? rotateLabels
      ? Math.min(labelOptions.compact ? 48 : 82, rotatedLabelH)
      : Math.min(labelOptions.compact ? 36 : 64, straightLabelH)
    : labelOptions.compact ? 6 : 8;
  const innerW = w - padL - padR;
  const innerH = h - padT - padB;
  const allValues = seriesList.flatMap((s) => s.values);
  const min = Math.min(...allValues);
  const max = Math.max(...allValues);
  const span = max - min || 1;
  const x = (i: number) => {
    if (N === 1) return padL + innerW / 2;
    if (isBar) return padL + ((i + 0.5) / N) * innerW;
    return padL + (i / (N - 1)) * innerW;
  };
  const y = (v: number) => padT + innerH - ((v - min) / span) * innerH;

  const gridY = [0, 0.25, 0.5, 0.75, 1]
    .map(
      (t) =>
        `<line x1="${padL}" x2="${w - padR}" y1="${padT + t * innerH}" y2="${padT + t * innerH}" stroke="currentColor" stroke-opacity="0.12" />`,
    )
    .join("");

  let plot = "";
  if (type === "bar") {
    // Cluster bars within each x-slot when multi-series.
    const slotInner = (innerW / N) * 0.85;
    const barW = slotInner / nSeries;
    plot = seriesList
      .map((ser, sIdx) =>
        ser.values
          .map((v, i) => {
            const slotCenter = x(i);
            const cx = slotCenter - slotInner / 2 + sIdx * barW + barW / 2;
            const top = y(v);
            return `<rect x="${(cx - barW / 2).toFixed(1)}" y="${top.toFixed(1)}" width="${barW.toFixed(1)}" height="${(padT + innerH - top).toFixed(1)}" fill="${PLOT_COLORS[sIdx % PLOT_COLORS.length]}" opacity="0.85" />`;
          })
          .join(""),
      )
      .join("");
  } else {
    // Line/area: one polyline per series. Area-fill only on the first series
    // so multi-series doesn't get visually muddled.
    const showMarkers = N <= 30;
    plot = seriesList
      .map((ser, sIdx) => {
        const color = PLOT_COLORS[sIdx % PLOT_COLORS.length]!;
        const points = ser.values
          .map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`)
          .join(" ");
        const areaFill = sIdx === 0 && nSeries === 1
          ? `<path d="M ${x(0).toFixed(1)},${(padT + innerH).toFixed(1)} L ${points
              .split(" ")
              .join(" L ")} L ${x(N - 1).toFixed(1)},${(padT + innerH).toFixed(1)} Z" fill="${color}" opacity="0.12" />`
          : "";
        const line = `<polyline points="${points}" fill="none" stroke="${color}" stroke-width="2" />`;
        const markers = showMarkers
          ? ser.values
              .map(
                (v, i) =>
                  `<circle cx="${x(i).toFixed(1)}" cy="${y(v).toFixed(1)}" r="2.5" fill="${color}" />`,
              )
              .join("")
          : "";
        return areaFill + line + markers;
      })
      .join("");
  }

  // Y-axis labels: 5 ticks matching the gridY rule count.
  const yTickVals = [0, 0.25, 0.5, 0.75, 1].map((t) => max - t * span);
  const yLabels = yTickVals
    .map(
      (v, idx) =>
        `<text x="${padL - 4}" y="${(padT + idx * innerH * 0.25 + 3).toFixed(1)}" text-anchor="end" font-size="${FONT_PX}" fill="currentColor" opacity="0.7">${escapeHtml(formatNum(v))}</text>`,
    )
    .join("");

  let xLabels = "";
  if (labels.length) {
    if (isBar) {
      xLabels = Array.from({ length: N })
        .map((_, i) => {
          const label = labelTexts[i];
          if (!label || label.lines.length === 0) return "";
          const cx = x(i);
          const yPos = padT + innerH + 12;
          return renderPlotLabel(label, cx, yPos, rotateLabels ? xLabelAngle : 0, rotateLabels ? "end" : "middle", FONT_PX, LINE_H);
        })
        .join("");
    } else {
      const T = Math.min(6, N);
      const idxs = Array.from({ length: T }, (_, k) =>
        Math.round((k * (N - 1)) / Math.max(1, T - 1)),
      );
      xLabels = idxs
        .map((i, k) => {
          const label = labelTexts[i];
          if (!label || label.lines.length === 0) return "";
          const cx = x(i);
          const anchor = k === 0 ? "start" : k === T - 1 ? "end" : "middle";
          return renderPlotLabel(label, cx, padT + innerH + 12, rotateLabels ? xLabelAngle : 0, rotateLabels ? "end" : anchor, FONT_PX, LINE_H);
        })
        .join("");
    }
  }

  // Legend: one swatch + label per series, laid out left-to-right at top.
  let legend = "";
  if (showLegend) {
    let cursor = padL;
    legend = seriesList
      .map((ser, sIdx) => {
        const color = PLOT_COLORS[sIdx % PLOT_COLORS.length]!;
        const swatchX = cursor;
        const textX = cursor + 14;
        const labelW = ser.name.length * CHAR_W + 22;
        cursor += labelW;
        return (
          `<rect x="${swatchX}" y="6" width="10" height="10" fill="${color}" opacity="0.85" />` +
          `<text x="${textX}" y="14" font-size="${FONT_PX}" fill="currentColor" opacity="0.85">${escapeHtml(ser.name)}</text>`
        );
      })
      .join("");
  }

  return `<svg viewBox="0 0 ${w} ${h}" xmlns="http://www.w3.org/2000/svg" role="img">
    ${gridY}
    ${plot}
    ${yLabels}
    ${xLabels}
    ${legend}
  </svg>`;
}

function formatNum(n: number): string {
  const a = Math.abs(n);
  // Compact notation keeps axis labels narrow enough not to overflow the
  // 24-px left gutter of the chart SVG. Without this, six-digit NAV values
  // (e.g. 245406) clip past the SVG's left edge.
  if (a >= 1_000_000) return (n / 1_000_000).toFixed(a >= 10_000_000 ? 0 : 1) + "M";
  if (a >= 1_000) return (n / 1_000).toFixed(a >= 10_000 ? 0 : 1) + "k";
  if (a >= 10) return n.toFixed(1);
  return n.toFixed(2);
}

function renderChildren(node: DirectiveNode, ctx: RenderCtx): string {
  if (node.children.length === 0 && node.body !== undefined) {
    return `<p>${inlineToHtml(node.body)}</p>`;
  }
  return node.children.map((c) => renderNode(c, ctx)).join("\n");
}

function wrap(tag: string, className: string, idAndAttrs: string, inner: string): string {
  return `<${tag} class="${className}"${idAndAttrs}>${inner}</${tag}>`;
}

function extractFirstHeading(doc: DocumentNode): string | undefined {
  for (const n of doc.children) {
    if (n.type === "section") return n.title;
  }
  return undefined;
}
