import yaml from "js-yaml";
import type { DirectiveNode, DocumentNode, Node, SectionNode } from "./ast.js";
import { walk } from "./ast.js";
import { escapeAttr, escapeHtml, inlineToHtml, splitPipeRow } from "./inline.js";

export interface HtmlRenderOptions {
  /** When true, wrap output in a full HTML document with the default theme. */
  standalone?: boolean;
  /** Override page title (defaults to meta.title or the first H1). */
  title?: string;
  /** Inline CSS injected into <head> when standalone. */
  themeCss?: string;
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
}

interface DatasetTable {
  columns: string[];
  rows: unknown[][];
}

interface RenderCtx {
  allowEscapeHatches: boolean;
  datasets: Map<string, DatasetTable>;
}

function buildDatasetRegistry(doc: DocumentNode): Map<string, DatasetTable> {
  const out = new Map<string, DatasetTable>();
  for (const node of walk(doc)) {
    if (node.type !== "directive" || node.name !== "dataset" || !node.id) continue;
    const table = parseDatasetBody(node);
    if (table) out.set(node.id, table);
  }
  return out;
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
  const split = (s: string) => s.split(delim).map((c) => c.trim());
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
  const ctx: RenderCtx = {
    allowEscapeHatches: options.allowEscapeHatches !== false,
    datasets: buildDatasetRegistry(doc),
  };
  const body = doc.children.map((c) => renderNode(c, ctx)).join("\n");
  if (!options.standalone) return body;

  const title =
    options.title ||
    (typeof doc.meta.title === "string" ? doc.meta.title : undefined) ||
    extractFirstHeading(doc) ||
    "Noma Document";

  const themeCss = options.themeCss ?? "";
  const mathMode = resolveMathMode(doc, options.math);
  const mathHead = mathMode === "katex" ? KATEX_HEAD : "";
  const mathFoot = mathMode === "katex" ? KATEX_FOOT : "";

  const diagramKinds = resolveDiagramKinds(doc);
  const diagramFoot = diagramScripts(diagramKinds);

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="generator" content="noma" />
<title>${escapeHtml(title)}</title>
<style>${themeCss}</style>${mathHead}
</head>
<body>
<main class="noma-doc">
${body}
</main>${mathFoot}${diagramFoot}
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

const MERMAID_FOOT = `
<script type="module">
import mermaid from "https://cdn.jsdelivr.net/npm/mermaid@${MERMAID_VERSION}/dist/mermaid.esm.min.mjs";
mermaid.initialize({ startOnLoad: false, securityLevel: "loose" });
const els = document.querySelectorAll(".noma-diagram-mermaid");
for (let i = 0; i < els.length; i++) {
  const el = els[i];
  const src = el.getAttribute("data-noma-source");
  if (!src) continue;
  try {
    const out = await mermaid.render("noma-mermaid-" + i, src);
    el["inn" + "erHTML"] = out.svg;
  } catch (e) { el.textContent = String(e); }
}
</script>`;

const VIZ_FOOT = `
<script type="module">
import("https://cdn.jsdelivr.net/npm/@viz-js/viz@${VIZ_VERSION}/lib/viz-standalone.mjs").then(({ instance }) => instance().then((viz) => {
  document.querySelectorAll(".noma-diagram-graphviz, .noma-diagram-dot").forEach((el) => {
    const src = el.getAttribute("data-noma-source");
    if (!src) return;
    try { el["inn" + "erHTML"] = viz.renderString(src, { format: "svg" }); }
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
      return `<p>${inlineToHtml(node.content)}</p>`;
    case "code": {
      const langClass = node.lang ? ` class="lang-${escapeAttr(node.lang)}"` : "";
      return `<pre><code${langClass}>${escapeHtml(node.content)}</code></pre>`;
    }
    case "list": {
      const tag = node.ordered ? "ol" : "ul";
      const items = node.items
        .map((item) => `  <li>${inlineToHtml(item.content)}</li>`)
        .join("\n");
      return `<${tag}>\n${items}\n</${tag}>`;
    }
    case "list_item":
      return `<li>${inlineToHtml(node.content)}</li>`;
    case "quote":
      return `<blockquote>${inlineToHtml(node.content)}</blockquote>`;
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
  const heading = `<h${node.level}${idAttr}>${inlineToHtml(node.title)}</h${node.level}>`;
  const inner = node.children.map((c) => renderNode(c, ctx)).join("\n");
  return `<section${idAttr} data-level="${node.level}">\n${aliasAnchors}${heading}\n${inner}\n</section>`;
}

function variantAttr(node: DirectiveNode): string {
  const v = node.attrs.variant;
  return typeof v === "string" && v.length > 0
    ? ` data-variant="${escapeAttr(v)}"`
    : "";
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
      const ctype = node.attrs.type ? String(node.attrs.type) : "text";
      const min = node.attrs.min ?? "";
      const max = node.attrs.max ?? "";
      const def = node.attrs.default ?? "";
      const label = node.body ?? "";
      return `<div class="noma-control"${idAttr}><label>${escapeHtml(label)}<input type="${escapeAttr(ctype)}" min="${escapeAttr(String(min))}" max="${escapeAttr(String(max))}" value="${escapeAttr(String(def))}" /></label></div>`;
    }

    case "grid": {
      const cols = Number(node.attrs.columns ?? 2);
      return `<div class="noma-grid"${idAttr} style="--noma-cols: ${cols};"${dataAttrs}>${renderChildren(node, ctx)}</div>`;
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

    case "button": {
      const href = node.attrs.href ? String(node.attrs.href) : "#";
      return `<a class="noma-button" href="${escapeAttr(href)}"${idAttr}>${renderChildren(node, ctx) || escapeHtml(node.body ?? "")}</a>`;
    }

    case "figure": {
      const caption = node.attrs.caption ? String(node.attrs.caption) : undefined;
      const src = node.attrs.src ? String(node.attrs.src) : undefined;
      const alt = node.attrs.alt ? String(node.attrs.alt) : "";
      const img = src ? `<img src="${escapeAttr(src)}" alt="${escapeAttr(alt)}" />` : renderChildren(node, ctx);
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

    case "agent_task":
    case "todo":
      return renderAgentTask(node, idAttr, ctx);

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
    case "columns":
      return wrap("div", `noma-${name}`, idAttr + dataAttrs, renderChildren(node, ctx));

    case "citation":
      return `<cite class="noma-citation"${idAttr}>${renderChildren(node, ctx) || escapeHtml(node.body ?? "")}</cite>`;

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
      return wrap(
        "div",
        `noma-block noma-block-${escapeAttr(name)}`,
        idAttr + dataAttrs,
        renderChildren(node, ctx),
      );
  }
}

function renderResearchBlock(node: DirectiveNode, ctx: RenderCtx): string {
  const idAttr = node.id ? ` id="${escapeAttr(node.id)}"` : "";
  const variant = variantAttr(node);
  const confidence =
    typeof node.attrs.confidence === "number" ? node.attrs.confidence : undefined;
  const meta: string[] = [];
  if (typeof node.attrs.for === "string") {
    meta.push(`<span class="noma-meta-key">for</span> <a href="#${escapeAttr(node.attrs.for)}">${escapeHtml(node.attrs.for)}</a>`);
  }
  if (typeof node.attrs.source === "string") {
    meta.push(`<span class="noma-meta-key">source</span> ${escapeHtml(node.attrs.source)}`);
  }
  if (typeof node.attrs.severity === "string") {
    meta.push(`<span class="noma-meta-key">severity</span> ${escapeHtml(node.attrs.severity)}`);
  }
  const confidenceBar =
    confidence !== undefined
      ? `<div class="noma-confidence" title="confidence ${confidence}"><div class="noma-confidence-bar" style="width: ${Math.round(confidence * 100)}%"></div></div>`
      : "";
  const metaHtml = meta.length ? `<div class="noma-meta">${meta.join(" · ")}</div>` : "";
  return `<aside class="noma-research noma-${escapeAttr(node.name)}"${idAttr}${variant}>
  <header class="noma-research-head"><span class="noma-tag">${escapeHtml(node.name)}</span>${confidenceBar}</header>
  <div class="noma-research-body">${renderChildren(node, ctx)}</div>
  ${metaHtml}
</aside>`;
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
  const type = String(node.attrs.type ?? "line");
  const w = Number(node.attrs.width ?? 320);
  const h = Number(node.attrs.height ?? 140);

  // Multi-series via `columns="a,b,c"`. Falls back to single-series via
  // `column="a"` (legacy form) or inline body data.
  const multi = resolveFromDatasetMulti(node, ctx);
  let seriesList: Array<{ name: string; values: number[] }>;
  let labels: string[];

  if (multi) {
    seriesList = multi.series;
    labels = multi.labels;
  } else {
    const single = resolveFromDataset(node, ctx);
    const values = single?.values ?? parseSeries(node);
    seriesList = values.length >= 2
      ? [{ name: single?.column ?? String(node.attrs.column ?? ""), values }]
      : [];
    labels = single?.labels ?? parseLabels(node);
  }

  const totalPoints = seriesList.reduce((s, ser) => s + ser.values.length, 0);
  const svg = seriesList.length > 0 && seriesList[0]!.values.length >= 2
    ? renderChartSvg(seriesList, type, w, h, labels)
    : `<svg viewBox="0 0 ${w} ${h}" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <polyline points="0,${h - 20} ${w * 0.13},${h - 40} ${w * 0.25},${h - 30} ${w * 0.38},${h - 60} ${w * 0.5},${h - 65} ${w * 0.63},${h - 80} ${w * 0.75},${h - 85} ${w * 0.88},${h - 100} ${w},${h - 105}"
        fill="none" stroke="currentColor" stroke-width="2" />
    </svg>`;

  const sourceLabel = totalPoints >= 2
    ? `${seriesList[0]!.values.length} points${seriesList.length > 1 ? ` × ${seriesList.length} series` : ""}`
    : String(dataSrc);
  return `<figure class="noma-plot"${idAttr}>
  <div class="noma-plot-canvas" data-type="${escapeAttr(type)}" data-source="${escapeAttr(String(dataSrc))}">
    ${svg}
  </div>
  <figcaption>${escapeHtml(title)} <span class="noma-meta-key">type</span> ${escapeHtml(type)} · <span class="noma-meta-key">source</span> ${escapeHtml(sourceLabel)}</figcaption>
</figure>`;
}

function resolveFromDataset(
  node: DirectiveNode,
  ctx: RenderCtx,
): { values: number[]; labels: string[]; column: string } | null {
  const dsId = node.attrs.dataset;
  if (typeof dsId !== "string") return null;
  const table = ctx.datasets.get(dsId);
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
  ctx: RenderCtx,
): { series: Array<{ name: string; values: number[] }>; labels: string[] } | null {
  const dsId = node.attrs.dataset;
  if (typeof dsId !== "string") return null;
  const table = ctx.datasets.get(dsId);
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

function renderChartSvg(
  seriesList: Array<{ name: string; values: number[] }>,
  type: string,
  w: number,
  h: number,
  labels: string[],
): string {
  // Bar plots reserve half a slot of margin so end bars don't run past the
  // data-area edge. Line/area plots anchor to the edges.
  const isBar = type === "bar";
  const nSeries = seriesList.length;
  const N = seriesList[0]?.values.length ?? 0;
  const showLegend = nSeries > 1;

  // Decide bar-label rotation up-front: rotated labels need a taller bottom
  // gutter. We rotate when the longest label is wider than the per-bar slot.
  const FONT_PX = 9;
  const CHAR_W = 5.5; // approx avg width of a 9pt sans char
  const innerWProbe = w - 28 - (isBar ? 12 : 6);
  const slotW = labels.length ? innerWProbe / Math.max(1, N) : 0;
  const longest = labels.reduce(
    (m, l) => Math.max(m, (l ?? "").length * CHAR_W),
    0,
  );
  const rotateBarLabels = isBar && labels.length > 1 && longest > slotW * 0.95;

  const padL = 28;
  const padR = isBar ? 12 : 6;
  const padT = showLegend ? 22 : 8;
  const padB = labels.length
    ? rotateBarLabels
      ? Math.min(70, Math.ceil(longest * Math.sin(0.45)) + 16)
      : 22
    : 8;
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

  // X-axis labels.
  // - bar: one label per bar, optionally rotated -35° to fit.
  // - line: at most 6 evenly-spaced ticks sampled from the labels[] array
  //   (typical case: dates from xcolumn). Suppress when labels are absent.
  let xLabels = "";
  if (labels.length) {
    if (isBar) {
      xLabels = Array.from({ length: N })
        .map((_, i) => {
          const lbl = labels[i] ?? "";
          if (!lbl) return "";
          const cx = x(i);
          const yPos = padT + innerH + 12;
          if (rotateBarLabels) {
            return `<text transform="translate(${cx.toFixed(1)} ${yPos}) rotate(-35)" text-anchor="end" font-size="${FONT_PX}" fill="currentColor" opacity="0.7">${escapeHtml(lbl)}</text>`;
          }
          return `<text x="${cx.toFixed(1)}" y="${yPos}" text-anchor="middle" font-size="${FONT_PX}" fill="currentColor" opacity="0.7">${escapeHtml(lbl)}</text>`;
        })
        .join("");
    } else {
      const T = Math.min(6, N);
      const idxs = Array.from({ length: T }, (_, k) =>
        Math.round((k * (N - 1)) / Math.max(1, T - 1)),
      );
      xLabels = idxs
        .map((i, k) => {
          const lbl = labels[i] ?? "";
          if (!lbl) return "";
          const cx = x(i);
          const anchor = k === 0 ? "start" : k === T - 1 ? "end" : "middle";
          return `<text x="${cx.toFixed(1)}" y="${(padT + innerH + 12).toFixed(1)}" text-anchor="${anchor}" font-size="${FONT_PX}" fill="currentColor" opacity="0.7">${escapeHtml(lbl)}</text>`;
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
