import type { DirectiveNode, DocumentNode, Node, SectionNode } from "./ast.js";
import { escapeAttr, escapeHtml, inlineToHtml } from "./inline.js";

export interface HtmlRenderOptions {
  /** When true, wrap output in a full HTML document with the default theme. */
  standalone?: boolean;
  /** Override page title (defaults to meta.title or the first H1). */
  title?: string;
  /** Inline CSS injected into <head> when standalone. */
  themeCss?: string;
}

export function renderHtml(doc: DocumentNode, options: HtmlRenderOptions = {}): string {
  const body = doc.children.map(renderNode).join("\n");
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

function renderNode(node: Node): string {
  switch (node.type) {
    case "document":
      return node.children.map(renderNode).join("\n");
    case "section":
      return renderSection(node);
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
      return renderDirective(node);
    default: {
      const _exhaustive: never = node;
      void _exhaustive;
      return "";
    }
  }
}

function renderSection(node: SectionNode): string {
  const idAttr = node.id ? ` id="${escapeAttr(node.id)}"` : "";
  const heading = `<h${node.level}${idAttr}>${inlineToHtml(node.title)}</h${node.level}>`;
  const inner = node.children.map(renderNode).join("\n");
  return `<section${idAttr} data-level="${node.level}">\n${heading}\n${inner}\n</section>`;
}

function renderDirective(node: DirectiveNode): string {
  const name = node.name;
  const idAttr = node.id ? ` id="${escapeAttr(node.id)}"` : "";
  const dataAttrs = Object.entries(node.attrs)
    .filter(([k]) => k !== "id")
    .map(([k, v]) => ` data-${escapeAttr(k)}="${escapeAttr(String(v))}"`)
    .join("");

  switch (name) {
    case "summary":
    case "abstract":
      return wrap("div", `noma-${name}`, idAttr + dataAttrs, renderChildren(node));

    case "callout":
    case "note":
    case "warning":
    case "tip": {
      const tone = name === "callout" ? String(node.attrs.tone ?? "info") : name;
      return `<aside class="noma-callout noma-callout-${escapeAttr(tone)}"${idAttr}>${renderChildren(node)}</aside>`;
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
      return renderResearchBlock(node);

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
      return `<div class="noma-grid"${idAttr} style="--noma-cols: ${cols};"${dataAttrs}>${renderChildren(node)}</div>`;
    }

    case "card": {
      const title = node.attrs.title ? String(node.attrs.title) : undefined;
      const icon = node.attrs.icon ? String(node.attrs.icon) : undefined;
      const head = title
        ? `<header class="noma-card-head">${icon ? `<span class="noma-icon" aria-hidden="true">◆</span>` : ""}<h3>${escapeHtml(title)}</h3></header>`
        : "";
      return `<article class="noma-card"${idAttr}>${head}<div class="noma-card-body">${renderChildren(node)}</div></article>`;
    }

    case "hero":
      return `<section class="noma-hero"${idAttr}>${renderChildren(node)}</section>`;

    case "button": {
      const href = node.attrs.href ? String(node.attrs.href) : "#";
      return `<a class="noma-button" href="${escapeAttr(href)}"${idAttr}>${renderChildren(node) || escapeHtml(node.body ?? "")}</a>`;
    }

    case "figure": {
      const caption = node.attrs.caption ? String(node.attrs.caption) : undefined;
      const src = node.attrs.src ? String(node.attrs.src) : undefined;
      const alt = node.attrs.alt ? String(node.attrs.alt) : "";
      const img = src ? `<img src="${escapeAttr(src)}" alt="${escapeAttr(alt)}" />` : renderChildren(node);
      return `<figure${idAttr}>${img}${caption ? `<figcaption>${escapeHtml(caption)}</figcaption>` : ""}</figure>`;
    }

    case "plot":
      return renderPlotPlaceholder(node, idAttr);

    case "dataset":
      return `<details class="noma-dataset"${idAttr}><summary>Dataset: ${escapeHtml(String(node.attrs.id ?? "dataset"))}</summary><pre>${escapeHtml(node.body ?? "")}</pre></details>`;

    case "agent_task":
    case "todo":
      return renderAgentTask(node, idAttr);

    case "tabs":
    case "accordion":
    case "sidebar":
    case "columns":
      return wrap("div", `noma-${name}`, idAttr + dataAttrs, renderChildren(node));

    case "citation":
      return `<cite class="noma-citation"${idAttr}>${renderChildren(node) || escapeHtml(node.body ?? "")}</cite>`;

    default:
      return wrap(
        "div",
        `noma-block noma-block-${escapeAttr(name)}`,
        idAttr + dataAttrs,
        renderChildren(node),
      );
  }
}

function renderResearchBlock(node: DirectiveNode): string {
  const idAttr = node.id ? ` id="${escapeAttr(node.id)}"` : "";
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
  return `<aside class="noma-research noma-${escapeAttr(node.name)}"${idAttr}>
  <header class="noma-research-head"><span class="noma-tag">${escapeHtml(node.name)}</span>${confidenceBar}</header>
  <div class="noma-research-body">${renderChildren(node)}</div>
  ${metaHtml}
</aside>`;
}

function renderAgentTask(node: DirectiveNode, idAttr: string): string {
  const checked = node.attrs.done === true ? " checked" : "";
  return `<div class="noma-agent-task"${idAttr}>
  <label><input type="checkbox" disabled${checked} /> <span class="noma-tag">${escapeHtml(node.name)}</span></label>
  <div class="noma-agent-body">${renderChildren(node)}</div>
</div>`;
}

function renderPlotPlaceholder(node: DirectiveNode, idAttr: string): string {
  const title = node.attrs.title ? String(node.attrs.title) : "Plot";
  const dataSrc = node.attrs.data ?? node.attrs.dataset ?? "—";
  const type = node.attrs.type ?? "line";
  return `<figure class="noma-plot"${idAttr}>
  <div class="noma-plot-canvas" data-type="${escapeAttr(String(type))}" data-source="${escapeAttr(String(dataSrc))}">
    <svg viewBox="0 0 320 120" xmlns="http://www.w3.org/2000/svg" aria-hidden="true">
      <polyline points="0,100 40,80 80,90 120,60 160,55 200,40 240,35 280,20 320,15"
        fill="none" stroke="currentColor" stroke-width="2" />
    </svg>
  </div>
  <figcaption>${escapeHtml(title)} <span class="noma-meta-key">type</span> ${escapeHtml(String(type))} · <span class="noma-meta-key">source</span> ${escapeHtml(String(dataSrc))}</figcaption>
</figure>`;
}

function renderChildren(node: DirectiveNode): string {
  if (node.children.length === 0 && node.body !== undefined) {
    return `<p>${inlineToHtml(node.body)}</p>`;
  }
  return node.children.map(renderNode).join("\n");
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
