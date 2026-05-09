import type { DirectiveNode, DocumentNode, Node, SectionNode } from "./ast.js";
import { escapeAttr, escapeHtml, inlineToHtml } from "./inline.js";

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
}

interface RenderCtx {
  allowEscapeHatches: boolean;
}

export function renderHtml(doc: DocumentNode, options: HtmlRenderOptions = {}): string {
  const ctx: RenderCtx = {
    allowEscapeHatches: options.allowEscapeHatches !== false,
  };
  const body = doc.children.map((c) => renderNode(c, ctx)).join("\n");
  if (!options.standalone) return body;

  const title =
    options.title ||
    (typeof doc.meta.title === "string" ? doc.meta.title : undefined) ||
    extractFirstHeading(doc) ||
    "Noma Document";

  const themeCss = options.themeCss ?? "";

  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<meta name="generator" content="noma" />
<title>${escapeHtml(title)}</title>
<style>${themeCss}</style>
</head>
<body>
<main class="noma-doc">
${body}
</main>
</body>
</html>`;
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
    default: {
      const _exhaustive: never = node;
      void _exhaustive;
      return "";
    }
  }
}

function renderSection(node: SectionNode, ctx: RenderCtx): string {
  const idAttr = node.id ? ` id="${escapeAttr(node.id)}"` : "";
  const heading = `<h${node.level}${idAttr}>${inlineToHtml(node.title)}</h${node.level}>`;
  const inner = node.children.map((c) => renderNode(c, ctx)).join("\n");
  return `<section${idAttr} data-level="${node.level}">\n${heading}\n${inner}\n</section>`;
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
      return renderPlotPlaceholder(node, idAttr);

    case "dataset":
      return `<details class="noma-dataset"${idAttr}><summary>Dataset: ${escapeHtml(String(node.attrs.id ?? "dataset"))}</summary><pre>${escapeHtml(node.body ?? "")}</pre></details>`;

    case "agent_task":
    case "todo":
      return renderAgentTask(node, idAttr, ctx);

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

function renderAgentTask(node: DirectiveNode, idAttr: string, ctx: RenderCtx): string {
  const checked = node.attrs.done === true ? " checked" : "";
  return `<div class="noma-agent-task"${idAttr}>
  <label><input type="checkbox" disabled${checked} /> <span class="noma-tag">${escapeHtml(node.name)}</span></label>
  <div class="noma-agent-body">${renderChildren(node, ctx)}</div>
</div>`;
}

function renderPlotPlaceholder(node: DirectiveNode, idAttr: string): string {
  const title = node.attrs.title ? String(node.attrs.title) : "Plot";
  const dataSrc = node.attrs.data ?? node.attrs.dataset ?? "—";
  const type = String(node.attrs.type ?? "line");
  const w = Number(node.attrs.width ?? 320);
  const h = Number(node.attrs.height ?? 140);
  const series = parseSeries(node);
  const labels = parseLabels(node);

  const svg = series.length >= 2
    ? renderChartSvg(series, type, w, h, labels)
    : `<svg viewBox="0 0 ${w} ${h}" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <polyline points="0,${h - 20} ${w * 0.13},${h - 40} ${w * 0.25},${h - 30} ${w * 0.38},${h - 60} ${w * 0.5},${h - 65} ${w * 0.63},${h - 80} ${w * 0.75},${h - 85} ${w * 0.88},${h - 100} ${w},${h - 105}"
        fill="none" stroke="currentColor" stroke-width="2" />
    </svg>`;

  const sourceLabel = series.length >= 2 ? `${series.length} points` : String(dataSrc);
  return `<figure class="noma-plot"${idAttr}>
  <div class="noma-plot-canvas" data-type="${escapeAttr(type)}" data-source="${escapeAttr(String(dataSrc))}">
    ${svg}
  </div>
  <figcaption>${escapeHtml(title)} <span class="noma-meta-key">type</span> ${escapeHtml(type)} · <span class="noma-meta-key">source</span> ${escapeHtml(sourceLabel)}</figcaption>
</figure>`;
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
  return raw.split(/\s*,\s*/).filter(Boolean);
}

function renderChartSvg(
  series: number[],
  type: string,
  w: number,
  h: number,
  labels: string[],
): string {
  const padL = 28;
  const padR = 6;
  const padT = 8;
  const padB = labels.length ? 22 : 8;
  const innerW = w - padL - padR;
  const innerH = h - padT - padB;
  const min = Math.min(...series);
  const max = Math.max(...series);
  const span = max - min || 1;
  const x = (i: number) =>
    padL + (series.length === 1 ? innerW / 2 : (i / (series.length - 1)) * innerW);
  const y = (v: number) => padT + innerH - ((v - min) / span) * innerH;

  const gridY = [0, 0.25, 0.5, 0.75, 1].map(
    (t) =>
      `<line x1="${padL}" x2="${w - padR}" y1="${padT + t * innerH}" y2="${padT + t * innerH}" stroke="currentColor" stroke-opacity="0.12" />`,
  ).join("");

  let plot: string;
  if (type === "bar") {
    const barW = (innerW / series.length) * 0.7;
    plot = series
      .map((v, i) => {
        const cx = x(i);
        const top = y(v);
        return `<rect x="${cx - barW / 2}" y="${top}" width="${barW}" height="${padT + innerH - top}" fill="currentColor" opacity="0.85" />`;
      })
      .join("");
  } else {
    const points = series.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
    const area = `M ${x(0).toFixed(1)},${(padT + innerH).toFixed(1)} L ${points
      .split(" ")
      .join(" L ")} L ${x(series.length - 1).toFixed(1)},${(padT + innerH).toFixed(1)} Z`;
    plot =
      `<path d="${area}" fill="currentColor" opacity="0.12" />` +
      `<polyline points="${points}" fill="none" stroke="currentColor" stroke-width="2" />` +
      series
        .map((v, i) => `<circle cx="${x(i).toFixed(1)}" cy="${y(v).toFixed(1)}" r="2.5" fill="currentColor" />`)
        .join("");
  }

  const minLabel = `<text x="${padL - 4}" y="${(padT + innerH).toFixed(1)}" text-anchor="end" font-size="9" fill="currentColor" opacity="0.7">${escapeHtml(formatNum(min))}</text>`;
  const maxLabel = `<text x="${padL - 4}" y="${(padT + 8).toFixed(1)}" text-anchor="end" font-size="9" fill="currentColor" opacity="0.7">${escapeHtml(formatNum(max))}</text>`;

  const xLabels = labels.length
    ? series
        .map((_, i) => {
          const lbl = labels[i] ?? "";
          if (!lbl) return "";
          return `<text x="${x(i).toFixed(1)}" y="${(h - 6).toFixed(1)}" text-anchor="middle" font-size="9" fill="currentColor" opacity="0.7">${escapeHtml(lbl)}</text>`;
        })
        .join("")
    : "";

  return `<svg viewBox="0 0 ${w} ${h}" xmlns="http://www.w3.org/2000/svg" role="img">
    ${gridY}
    ${plot}
    ${minLabel}
    ${maxLabel}
    ${xLabels}
  </svg>`;
}

function formatNum(n: number): string {
  if (Math.abs(n) >= 1000) return n.toFixed(0);
  if (Math.abs(n) >= 10) return n.toFixed(1);
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
