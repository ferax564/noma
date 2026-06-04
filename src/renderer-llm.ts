import type { DirectiveNode, DocumentNode, Node, SectionNode } from "./ast.js";
import { walk } from "./ast.js";
import {
  buildComputedEvalContext,
  evaluateComputedNode,
  evaluateComputedSeries,
  formatComputedNumber,
  formulaText,
  type ComputedEvalContext,
} from "./computed.js";
import { inlineToPlain } from "./inline.js";

export interface RenderLlmOptions {
  /**
   * When set, ::memory directives whose `last_seen` attribute is older than
   * `days` from `now` are omitted from the output, AND ::memory_index body
   * lines whose [[wikilinks]] resolve only to omitted memories are dropped
   * (no dangling references in the LLM context).
   *
   * Durable memory types (`user`, `feedback`) are kept regardless of
   * `last_seen` unless they carry `expired=true`. Time-window staleness
   * applies only to `project` and `reference` memories by default, since
   * those are the types whose facts go stale over calendar time.
   */
  excludeStale?: { now: Date; days: number };
  /** Include only matching AST node types or directive names, plus ancestors. */
  select?: string[];
  /** Omit matching AST node types or directive names and their children. */
  exclude?: string[];
  /** Maximum output length in characters, trimmed at a line boundary when possible. */
  budget?: number;
}

interface RenderCtx extends RenderLlmOptions {
  excludedMemoryIds: Set<string>;
  selectSet: Set<string>;
  excludeSet: Set<string>;
  computed: ComputedEvalContext;
}

const STALE_OPT_IN_TYPES = new Set(["project", "reference"]);

/**
 * Deterministic plain-text export designed for LLM context windows.
 * Stable line ordering, explicit semantic tags, no HTML noise.
 */
export function renderLlm(doc: DocumentNode, options: RenderLlmOptions = {}): string {
  const ctx: RenderCtx = {
    ...options,
    excludedMemoryIds: computeExcludedMemoryIds(doc, options),
    selectSet: normalizeSelectors(options.select),
    excludeSet: normalizeSelectors(options.exclude),
    computed: buildComputedEvalContext(doc),
  };
  const out: string[] = [];
  if (doc.meta.title) out.push(`# ${String(doc.meta.title)}`);
  for (const child of doc.children) {
    if (shouldEmit(child, ctx, false)) emit(child, out, 0, ctx, false);
  }
  const rendered = out.join("\n").replace(/\n{3,}/g, "\n\n").trim() + "\n";
  return applyBudget(rendered, options.budget);
}

function normalizeSelectors(values: string[] | undefined): Set<string> {
  const out = new Set<string>();
  for (const raw of values ?? []) {
    for (const part of raw.split(/[,\s]+/)) {
      const clean = part.trim().toLowerCase();
      if (clean) out.add(clean);
    }
  }
  return out;
}

function applyBudget(text: string, budget: number | undefined): string {
  if (budget === undefined || !Number.isFinite(budget) || budget <= 0) return text;
  if (text.length <= budget) return text;
  const marker = `\n\n[LLM context truncated at ${budget} characters]\n`;
  if (budget <= marker.length) return marker.slice(0, budget);
  const limit = budget - marker.length;
  const cut = text.lastIndexOf("\n", limit);
  return text.slice(0, cut > 0 ? cut : limit).trimEnd() + marker;
}

function computeExcludedMemoryIds(
  doc: DocumentNode,
  options: RenderLlmOptions,
): Set<string> {
  const excluded = new Set<string>();
  if (!options.excludeStale) return excluded;
  for (const node of walk(doc)) {
    if (node.type !== "directive") continue;
    if (node.name !== "memory") continue;
    if (!node.id) continue;
    if (isStale(node, options.excludeStale)) excluded.add(node.id);
  }
  return excluded;
}

function emit(
  node: Node,
  out: string[],
  depth: number,
  opts: RenderCtx,
  forceSubtree: boolean,
): void {
  switch (node.type) {
    case "document":
      for (const child of node.children) {
        if (shouldEmit(child, opts, forceSubtree)) emit(child, out, depth, opts, forceSubtree);
      }
      return;
    case "section":
      emitSection(node, out, depth, opts, forceSubtree);
      return;
    case "paragraph":
      out.push(inlineToPlain(node.content));
      out.push("");
      return;
    case "code":
      out.push("```" + (node.lang ?? ""));
      out.push(node.content);
      out.push("```");
      out.push("");
      return;
    case "list":
      for (const item of node.items) {
        out.push(`- ${inlineToPlain(item.content)}`);
      }
      out.push("");
      return;
    case "list_item":
      out.push(`- ${inlineToPlain(node.content)}`);
      return;
    case "quote":
      for (const line of node.content.split("\n")) out.push(`> ${line}`);
      out.push("");
      return;
    case "thematic_break":
      out.push("---");
      out.push("");
      return;
    case "table": {
      const widths = node.header.map((h, i) =>
        Math.max(
          h.length,
          ...node.rows.map((r) => (r[i] ?? "").length),
          3,
        ),
      );
      const fmt = (cells: string[]) =>
        "| " +
        cells.map((c, i) => c.padEnd(widths[i] ?? c.length)).join(" | ") +
        " |";
      out.push(fmt(node.header));
      out.push(
        "| " +
          widths.map((w, i) => {
            const a = node.align[i];
            const dashes = "-".repeat(Math.max(3, w));
            if (a === "center") return `:${dashes.slice(0, -2)}-:`;
            if (a === "right") return `${dashes.slice(0, -1)}:`;
            if (a === "left") return `:${dashes.slice(0, -1)}`;
            return dashes;
          }).join(" | ") +
          " |",
      );
      for (const row of node.rows) out.push(fmt(row));
      out.push("");
      return;
    }
    case "directive":
      emitDirective(node, out, depth, opts, forceSubtree);
      return;
    case "frontmatter":
      return;
    default: {
      const _exhaustive: never = node;
      void _exhaustive;
    }
  }
}

function emitSection(
  node: SectionNode,
  out: string[],
  depth: number,
  opts: RenderCtx,
  forceSubtree: boolean,
): void {
  const hashes = "#".repeat(node.level);
  out.push(`${hashes} ${node.title}${node.id ? `  [#${node.id}]` : ""}`);
  out.push("");
  const childForce = forceSubtree || matchesSelector(node, opts.selectSet);
  for (const child of node.children) {
    if (shouldEmit(child, opts, childForce)) emit(child, out, depth, opts, childForce);
  }
}

const VERBATIM_BODY = new Set(["diagram", "plotly", "math"]);

function emitDirective(
  node: DirectiveNode,
  out: string[],
  depth: number,
  opts: RenderCtx,
  forceSubtree: boolean,
): void {
  if (node.name === "html" || node.name === "svg" || node.name === "script") {
    out.push(`[${node.name.toUpperCase()} escape-hatch block omitted from LLM context]`);
    out.push("");
    return;
  }
  if (node.name === "memory" && opts.excludeStale && isStale(node, opts.excludeStale)) {
    return;
  }
  const tag = node.name.toUpperCase();
  const attrs = Object.entries(node.attrs)
    .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
    .join(" ");
  out.push(`[${tag}${attrs ? " " + attrs : ""}]`);
  if (node.name === "computed_metric" || node.name === "computed_plot" || node.name === "computed_table") {
    emitComputedSummary(node, out, opts);
  }
  const isIndexWithExclusions =
    node.name === "memory_index" && opts.excludedMemoryIds.size > 0;
  const childForce = forceSubtree || matchesSelector(node, opts.selectSet);
  if (VERBATIM_BODY.has(node.name) && node.body !== undefined) {
    out.push(node.body);
  } else if (node.children.length === 0 && node.body !== undefined) {
    const body = isIndexWithExclusions
      ? filterMemoryIndexBody(node.body, opts.excludedMemoryIds)
      : node.body;
    out.push(inlineToPlain(body));
  } else if (isIndexWithExclusions) {
    for (const child of node.children)
      emitFilteredIndexChild(child, out, depth + 1, opts);
  } else {
    for (const child of node.children) {
      if (shouldEmit(child, opts, childForce)) emit(child, out, depth + 1, opts, childForce);
    }
  }
  out.push(`[/${tag}]`);
  out.push("");
}

function emitComputedSummary(node: DirectiveNode, out: string[], opts: RenderCtx): void {
  const formula = formulaText(node);
  if (!formula) {
    out.push("formula: <missing>");
    return;
  }
  out.push(`formula: ${formula}`);
  if (node.name === "computed_plot" || node.name === "computed_table") {
    const series = evaluateComputedSeries(node, opts.computed);
    if (series) {
      const values = node.name === "computed_table"
        ? series.points.map((point, index) => `${formatComputedNumber(point)}=${formatComputedNumber(series.values[index]!)}`)
        : series.values.map(formatComputedNumber);
      out.push(`default_series (${series.variable}): ${values.join(", ")}`);
      return;
    }
  }
  const value = evaluateComputedNode(node, opts.computed);
  if (value !== undefined) out.push(`default: ${formatComputedNumber(value)}`);
}

function shouldEmit(node: Node, opts: RenderCtx, forceSubtree: boolean): boolean {
  if (matchesSelector(node, opts.excludeSet)) return false;
  if (forceSubtree || opts.selectSet.size === 0) return true;
  if (matchesSelector(node, opts.selectSet)) return true;
  return hasSelectableDescendant(node, opts);
}

function hasSelectableDescendant(node: Node, opts: RenderCtx): boolean {
  for (const child of childrenOf(node)) {
    if (matchesSelector(child, opts.excludeSet)) continue;
    if (matchesSelector(child, opts.selectSet)) return true;
    if (hasSelectableDescendant(child, opts)) return true;
  }
  return false;
}

function matchesSelector(node: Node, selectors: Set<string>): boolean {
  if (selectors.size === 0) return false;
  if (selectors.has(node.type)) return true;
  return node.type === "directive" && selectors.has(node.name.toLowerCase());
}

function childrenOf(node: Node): Node[] {
  if (node.type === "document" || node.type === "section" || node.type === "directive") {
    return node.children;
  }
  if (node.type === "list") return node.items;
  return [];
}

const WIKILINK_RE = /\[\[([a-zA-Z_][\w\-./:]*)\]\]/g;

function filterMemoryIndexBody(body: string, excluded: Set<string>): string {
  if (excluded.size === 0) return body;
  return body
    .split("\n")
    .filter((line) => {
      const matches = [...line.matchAll(WIKILINK_RE)];
      if (matches.length === 0) return true;
      return !matches.every((m) => excluded.has(m[1]!));
    })
    .join("\n");
}

function emitFilteredIndexChild(
  node: Node,
  out: string[],
  depth: number,
  opts: RenderCtx,
): void {
  if (node.type === "list") {
    const survivors = node.items.filter((item) => {
      const matches = [...item.content.matchAll(WIKILINK_RE)];
      if (matches.length === 0) return true;
      return !matches.every((m) => opts.excludedMemoryIds.has(m[1]!));
    });
    if (survivors.length === 0) return;
    for (const item of survivors)
      out.push(`- ${inlineToPlain(item.content)}`);
    out.push("");
    return;
  }
  if (node.type === "paragraph") {
    const matches = [...node.content.matchAll(WIKILINK_RE)];
    const allExcluded =
      matches.length > 0 && matches.every((m) => opts.excludedMemoryIds.has(m[1]!));
    if (allExcluded) return;
    out.push(inlineToPlain(node.content));
    out.push("");
    return;
  }
  emit(node, out, depth, opts, false);
}

function isStale(
  node: DirectiveNode,
  cfg: { now: Date; days: number },
): boolean {
  const ls = node.attrs.last_seen;
  if (typeof ls !== "string" || !ls) return false;
  const t = Date.parse(ls);
  if (Number.isNaN(t)) return false;
  const type = typeof node.attrs.type === "string" ? node.attrs.type : "";
  const expired = node.attrs.expired === true;
  if (!STALE_OPT_IN_TYPES.has(type) && !expired) return false;
  return cfg.now.getTime() - t > cfg.days * 24 * 60 * 60 * 1000;
}
