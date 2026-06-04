import type { Attrs, DirectiveNode, DocumentNode } from "./ast.js";
import { walk } from "./ast.js";
import { evaluateFormula, extractFormulaIdentifiers, parseFormula } from "./formula.js";

export interface ComputedEvalContext {
  controls: Map<string, number>;
  computedNodes: Map<string, DirectiveNode>;
  cache: Map<string, number | null>;
}

export interface ControlOption {
  value: string;
  label: string;
}

export function buildComputedEvalContext(doc: DocumentNode): ComputedEvalContext {
  const controls = new Map<string, number>();
  const computedNodes = new Map<string, DirectiveNode>();
  for (const node of walk(doc)) {
    if (node.type !== "directive" || !node.id) continue;
    if (node.name === "control") {
      const value = controlDefaultNumber(node);
      if (value !== undefined) controls.set(node.id, value);
    } else if (isComputedDirective(node)) {
      computedNodes.set(node.id, node);
    }
  }
  return { controls, computedNodes, cache: new Map() };
}

export function isComputedDirective(node: DirectiveNode): boolean {
  return node.name === "computed_metric" || node.name === "computed_plot" || node.name === "computed_table";
}

export function formulaText(node: DirectiveNode): string | undefined {
  return stringAttr(node.attrs, "formula") ?? bodyFieldText(node, "formula");
}

export function computedDomainText(node: DirectiveNode): string | undefined {
  return stringAttr(node.attrs, "domain") ?? stringAttr(node.attrs, "range") ?? bodyFieldText(node, "domain") ?? bodyFieldText(node, "range");
}

export function computedDomainVars(node: DirectiveNode): Set<string> {
  const out = new Set<string>();
  const raw = computedDomainText(node);
  if (!raw) return out;
  for (const part of raw.split(/[,\s]+/)) {
    const match = /^([A-Za-z_][A-Za-z0-9_.-]*)\s*:/.exec(part.trim());
    if (match) out.add(match[1]!);
  }
  return out;
}

export function parseComputedDomain(node: DirectiveNode): { variable: string; points: number[] } | null {
  const raw = computedDomainText(node);
  if (!raw) return null;
  const match = /^\s*([A-Za-z_][A-Za-z0-9_.-]*)\s*:\s*(-?\d+(?:\.\d+)?)\s*\.\.\s*(-?\d+(?:\.\d+)?)(?:\s*:\s*(-?\d+(?:\.\d+)?))?\s*$/.exec(raw);
  if (!match) return null;
  const variable = match[1]!;
  const start = Number(match[2]);
  const end = Number(match[3]);
  const explicitStep = match[4] !== undefined ? Number(match[4]) : undefined;
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  const step = explicitStep ?? (Number.isInteger(start) && Number.isInteger(end) ? (start <= end ? 1 : -1) : (end - start) / 10);
  if (!Number.isFinite(step) || step === 0) return null;
  const points: number[] = [];
  const forward = step > 0;
  for (let value = start; forward ? value <= end + 1e-9 : value >= end - 1e-9; value += step) {
    points.push(Number(value.toFixed(10)));
    if (points.length >= 25) break;
  }
  return points.length > 0 ? { variable, points } : null;
}

export function evaluateComputedSeries(
  node: DirectiveNode,
  ctx: ComputedEvalContext,
): { variable: string; points: number[]; values: number[] } | null {
  const domain = parseComputedDomain(node);
  if (!domain) return null;
  const values: number[] = [];
  for (const point of domain.points) {
    const value = evaluateComputedNode(node, ctx, { [domain.variable]: point });
    if (value === undefined) return null;
    values.push(value);
  }
  return { variable: domain.variable, points: domain.points, values };
}

export function evaluateComputedNode(
  node: DirectiveNode,
  ctx: ComputedEvalContext,
  extraEnv: Record<string, number> = {},
): number | undefined {
  return evaluateComputedNodeInner(node, ctx, new Set(), extraEnv);
}

export function formatComputedNumber(value: number): string {
  if (Math.abs(value) >= 1_000_000) return value.toFixed(0);
  if (Number.isInteger(value)) return String(value);
  return value.toFixed(6).replace(/0+$/, "").replace(/\.$/, "");
}

export function controlDefaultText(node: DirectiveNode): string | undefined {
  const value = node.attrs.default;
  if (typeof value === "string" && value.trim()) return value.trim();
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  return bodyFieldText(node, "default");
}

export function controlDefaultNumber(node: DirectiveNode): number | undefined {
  const numeric = numericAttr(node.attrs, "default");
  if (numeric !== undefined) return numeric;
  const type = stringAttr(node.attrs, "type")?.toLowerCase();
  if (type !== "checkbox" && type !== "toggle") return undefined;
  const value = controlDefaultText(node)?.toLowerCase();
  if (value === "true" || value === "yes" || value === "on" || value === "checked") return 1;
  if (value === "false" || value === "no" || value === "off" || value === "unchecked") return 0;
  return undefined;
}

export function controlOptions(node: DirectiveNode): ControlOption[] {
  const raw = stringAttr(node.attrs, "options") ?? bodyFieldText(node, "options");
  if (!raw) return [];
  return raw
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .map((item) => {
      const sep = item.indexOf("=");
      if (sep === -1) return { value: item, label: item };
      const value = item.slice(0, sep).trim();
      const label = item.slice(sep + 1).trim();
      return { value: value || label, label: label || value };
    })
    .filter((option) => option.value || option.label);
}

export function numericAttr(attrs: Attrs, key: string): number | undefined {
  const value = attrs[key];
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim()) {
    const n = Number(value);
    if (Number.isFinite(n)) return n;
  }
  return undefined;
}

export function stringAttr(attrs: Attrs, key: string): string | undefined {
  const value = attrs[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function bodyFieldText(node: DirectiveNode, key: string): string | undefined {
  const body = node.body ?? "";
  const pattern = new RegExp(`^\\s*${escapeRegExp(key)}\\s*:`, "i");
  const line = body.split(/\r?\n/).find((candidate) => pattern.test(candidate));
  return line?.replace(pattern, "").trim() || undefined;
}

function evaluateComputedNodeInner(
  node: DirectiveNode,
  ctx: ComputedEvalContext,
  seen: Set<string>,
  extraEnv: Record<string, number>,
): number | undefined {
  let trackedId: string | undefined;
  if (node.id && !Object.prototype.hasOwnProperty.call(extraEnv, node.id)) {
    const cacheable = Object.keys(extraEnv).length === 0;
    const cached = cacheable ? ctx.cache.get(node.id) : undefined;
    if (cached !== undefined) return cached ?? undefined;
    if (seen.has(node.id)) {
      if (cacheable) ctx.cache.set(node.id, null);
      return undefined;
    }
    seen.add(node.id);
    trackedId = node.id;
  }

  const formula = formulaText(node);
  if (!formula) {
    if (trackedId) seen.delete(trackedId);
    return undefined;
  }
  const parsed = parseFormula(formula);
  if (!parsed.ok) {
    if (trackedId) seen.delete(trackedId);
    return undefined;
  }

  const env: Record<string, number> = { ...Object.fromEntries(ctx.controls), ...extraEnv };
  for (const id of extractFormulaIdentifiers(parsed.ast)) {
    if (Object.prototype.hasOwnProperty.call(env, id)) continue;
    const dep = ctx.computedNodes.get(id);
    if (!dep) continue;
    const value = evaluateComputedNodeInner(dep, ctx, seen, extraEnv);
    if (value !== undefined) env[id] = value;
  }

  const evaluated = evaluateFormula(parsed.ast, env);
  const value = evaluated.ok ? evaluated.value : undefined;
  if (node.id && Object.keys(extraEnv).length === 0) ctx.cache.set(node.id, value ?? null);
  if (trackedId) seen.delete(trackedId);
  return value;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
