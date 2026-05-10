import yaml from "js-yaml";
import type { Diagnostic, DirectiveNode, DocumentNode, Node } from "./ast.js";
import { walk } from "./ast.js";

export interface ValidateOptions {
  /**
   * Disable claim-without-evidence warnings entirely (default: enabled).
   * Per-block opt-out: add the `noverify` flag attribute to the claim.
   */
  requireEvidenceForClaims?: boolean;
  /**
   * Reference time for `stale-citation` checks. Defaults to `new Date()`.
   * Tests pass a fixed clock for determinism.
   */
  now?: Date;
  /** Citations older than this many days are flagged stale. Default: 365. */
  staleCitationDays?: number;
  /**
   * Rule codes to drop from the result. Diagnostics whose `code` matches an
   * entry are filtered out and do not affect exit status. Mirrors the per-block
   * `noverify` flag at file level. Used by `noma check --ignore-rule X`.
   */
  ignoreRules?: string[];
}

const DEFAULT_STALE_DAYS = 365;

/**
 * Directive allow-lists per declared `profile`. A document that opts in to a
 * profile guarantees to downstream tools that it only uses these directive
 * names. The validator warns on out-of-profile directives so authors notice
 * before their consumers do.
 */
const PROFILES: Record<string, ReadonlySet<string>> = {
  minimal: new Set([
    "summary",
    "abstract",
    "callout",
    "note",
    "warning",
    "tip",
    "figure",
    "citation",
    "math",
    "table",
  ]),
  technical: new Set([
    "summary",
    "abstract",
    "callout",
    "note",
    "warning",
    "tip",
    "hero",
    "grid",
    "card",
    "columns",
    "tabs",
    "accordion",
    "sidebar",
    "button",
    "figure",
    "plot",
    "dataset",
    "code_cell",
    "output",
    "control",
    "export_button",
    "agent_task",
    "todo",
    "citation",
    "math",
    "table",
    "html",
    "svg",
    "script",
  ]),
  research: new Set([
    "summary",
    "abstract",
    "callout",
    "note",
    "warning",
    "tip",
    "claim",
    "evidence",
    "counterevidence",
    "assumption",
    "risk",
    "hypothesis",
    "result",
    "limitation",
    "open_question",
    "decision",
    "adr",
    "dataset",
    "plot",
    "metric",
    "figure",
    "agent_task",
    "todo",
    "review",
    "comment",
    "change_request",
    "provenance",
    "confidence",
    "citation",
    "state_change",
    "math",
    "table",
  ]),
};

export const KNOWN_PROFILES = Object.keys(PROFILES);

export function validate(doc: DocumentNode, options: ValidateOptions = {}): Diagnostic[] {
  const requireEvidence = options.requireEvidenceForClaims !== false;
  const metaStale = readPositiveNumber(doc.meta.stale_citation_days);
  const staleDays =
    options.staleCitationDays ?? metaStale ?? DEFAULT_STALE_DAYS;
  const now = options.now ?? new Date();

  const diagnostics: Diagnostic[] = [];
  const ids = new Map<string, Node>();
  const aliasIds = new Set<string>();
  const claims: DirectiveNode[] = [];
  const evidenceTargets = new Set<string>();
  const referenced = new Set<string>();
  const datasetIds = new Map<string, DirectiveNode>();
  const datasetColumns = new Map<string, Set<string>>();

  const declaredProfiles = readDeclaredProfiles(doc.meta);
  const profileSet: Set<string> | undefined = (() => {
    if (declaredProfiles.length === 0) return undefined;
    const union = new Set<string>();
    let any = false;
    for (const name of declaredProfiles) {
      const set = PROFILES[name];
      if (!set) {
        diagnostics.push({
          severity: "warning",
          code: "unknown-profile",
          message: `Document declares unknown profile "${name}". Known: ${KNOWN_PROFILES.join(", ")}.`,
        });
        continue;
      }
      any = true;
      for (const directive of set) union.add(directive);
    }
    return any ? union : undefined;
  })();
  const profileLabel = declaredProfiles.join("+");

  const wikilinkRe = /\[\[([a-zA-Z_][\w\-./:]*)\]\]/g;
  const collectWikilinks = (text: string): void => {
    const stripped = text.replace(/`[^`]*`/g, "");
    for (const m of stripped.matchAll(wikilinkRe)) referenced.add(m[1]!);
  };

  for (const node of walk(doc)) {
    if (node.type === "paragraph" || node.type === "quote") collectWikilinks(node.content);
    else if (node.type === "list_item") collectWikilinks(node.content);
    else if (node.type === "section") collectWikilinks(node.title);
    else if (node.type === "directive" && node.body) collectWikilinks(node.body);
    else if (node.type === "table") {
      for (const cell of node.header) collectWikilinks(cell);
      for (const row of node.rows) for (const cell of row) collectWikilinks(cell);
    }
    if (node.id) {
      if (ids.has(node.id)) {
        diagnostics.push({
          severity: "error",
          code: "duplicate-id",
          message: `Duplicate block ID "${node.id}".`,
          pos: node.pos,
          nodeId: node.id,
        });
      } else {
        ids.set(node.id, node);
      }
    }
    if (node.aliases) {
      for (const a of node.aliases) aliasIds.add(a);
    }

    if (node.type !== "directive") continue;

    if (profileSet && !suppressed(node) && !profileSet.has(node.name)) {
      diagnostics.push({
        severity: "warning",
        code: "out-of-profile-directive",
        message: `Directive "${node.name}" is not part of the declared "${profileLabel}" profile.`,
        pos: node.pos,
        nodeId: node.id,
      });
    }

    if (node.name === "dataset" && node.id) {
      datasetIds.set(node.id, node);
      datasetColumns.set(node.id, readDatasetColumns(node));
    }

    if (node.name === "claim" && node.id) claims.push(node);

    if (node.name === "state_change" && !suppressed(node)) {
      const block = node.attrs.block;
      if (typeof block === "string") {
        referenced.add(block);
      } else {
        diagnostics.push({
          severity: "warning",
          code: "state-change-missing-block",
          message: `state_change has no \`block=\` attribute pointing at the changed block.`,
          pos: node.pos,
          nodeId: node.id,
        });
      }
      const hasFrom = "from" in node.attrs;
      const hasTo = "to" in node.attrs;
      if (!hasFrom || !hasTo) {
        diagnostics.push({
          severity: "warning",
          code: "state-change-missing-from-to",
          message: `state_change "${node.id ?? "?"}" needs both \`from=\` and \`to=\` attributes.`,
          pos: node.pos,
          nodeId: node.id,
        });
      }
    }

    if (node.name === "evidence" || node.name === "counterevidence") {
      const target = node.attrs.for;
      if (typeof target === "string") {
        referenced.add(target);
        evidenceTargets.add(target);
      } else {
        diagnostics.push({
          severity: "warning",
          code: "evidence-missing-for",
          message: `${node.name} block has no \`for=\` attribute.`,
          pos: node.pos,
          nodeId: node.id,
        });
      }
    }

    if (node.name === "figure" && !node.attrs.alt && !node.attrs.caption) {
      diagnostics.push({
        severity: "warning",
        code: "figure-missing-alt",
        message: `Figure block has no alt or caption text.`,
        pos: node.pos,
        nodeId: node.id,
      });
    }

    if (node.name === "plot") {
      const hasData = "data" in node.attrs || "dataset" in node.attrs;
      if (typeof node.attrs.dataset === "string") {
        const ref = node.attrs.dataset;
        if (!datasetIds.has(ref)) {
          diagnostics.push({
            severity: "error",
            code: "plot-unknown-dataset",
            message: `Plot "${node.id ?? "?"}" references unknown dataset "${ref}".`,
            pos: node.pos,
            nodeId: node.id,
          });
        } else if (typeof node.attrs.column === "string") {
          const cols = datasetColumns.get(ref) ?? new Set<string>();
          if (cols.size > 0 && !cols.has(node.attrs.column)) {
            diagnostics.push({
              severity: "error",
              code: "plot-unknown-column",
              message: `Plot "${node.id ?? "?"}" references unknown column "${node.attrs.column}" in dataset "${ref}".`,
              pos: node.pos,
              nodeId: node.id,
            });
          }
        }
      }
      if (!hasData) {
        diagnostics.push({
          severity: "error",
          code: "plot-missing-data",
          message: `Plot has no data or dataset attribute.`,
          pos: node.pos,
          nodeId: node.id,
        });
      }
      if (!suppressed(node)) {
        const data = typeof node.attrs.data === "string" ? node.attrs.data : "";
        const labels = typeof node.attrs.xlabels === "string" ? node.attrs.xlabels : "";
        const delim = (s: string): "comma" | "space" | null => {
          const hasComma = /,/.test(s);
          const hasSpace = /\s/.test(s.trim());
          if (hasComma && !hasSpace) return "comma";
          if (hasSpace && !hasComma) return "space";
          return null;
        };
        const a = delim(data);
        const b = delim(labels);
        if (a && b && a !== b) {
          diagnostics.push({
            severity: "warning",
            code: "plot-mixed-delimiters",
            message: `Plot "${node.id ?? "?"}" mixes ${a}-separated data with ${b}-separated xlabels. Use commas for both (preferred).`,
            pos: node.pos,
            nodeId: node.id,
          });
        }
      }
    }

    if (node.name === "risk" && !suppressed(node) && !node.attrs.owner) {
      diagnostics.push({
        severity: "warning",
        code: "risk-without-owner",
        message: `Risk "${node.id ?? "?"}" has no \`owner=\` attribute.`,
        pos: node.pos,
        nodeId: node.id,
      });
    }

    if (
      (node.name === "decision" || node.name === "adr") &&
      !suppressed(node) &&
      !node.attrs.status
    ) {
      diagnostics.push({
        severity: "warning",
        code: "decision-without-status",
        message: `${node.name} "${node.id ?? "?"}" has no \`status=\` attribute.`,
        pos: node.pos,
        nodeId: node.id,
      });
    }

    if (
      (node.name === "agent_task" || node.name === "todo") &&
      !suppressed(node) &&
      !node.attrs.scope &&
      !(node.body && node.body.trim().length > 0) &&
      node.children.length === 0
    ) {
      diagnostics.push({
        severity: "warning",
        code: "agent-task-without-scope",
        message: `Agent task "${node.id ?? "?"}" has no scope or body.`,
        pos: node.pos,
        nodeId: node.id,
      });
    }

    if (
      (node.name === "html" || node.name === "svg" || node.name === "script") &&
      !suppressed(node) &&
      node.attrs.trusted !== true
    ) {
      diagnostics.push({
        severity: "warning",
        code: "escape-hatch-untrusted",
        message: `${node.name} escape-hatch block has no \`trusted\` attribute. Add \`trusted\` to silence this warning, or \`noverify\` to suppress all checks on this block.`,
        pos: node.pos,
        nodeId: node.id,
      });
    }

    if (node.name === "citation" && !suppressed(node) && node.attrs.accessed) {
      const perBlock = readPositiveNumber(node.attrs.stale_after_days);
      const window = perBlock ?? staleDays;
      const stale = isStale(String(node.attrs.accessed), now, window);
      if (stale) {
        diagnostics.push({
          severity: "warning",
          code: "stale-citation",
          message: `Citation "${node.id ?? "?"}" was last accessed ${node.attrs.accessed} (>${window} days ago).`,
          pos: node.pos,
          nodeId: node.id,
        });
      }
    }
  }

  for (const target of referenced) {
    if (!ids.has(target) && !aliasIds.has(target)) {
      diagnostics.push({
        severity: "error",
        code: "broken-reference",
        message: `Reference to unknown block ID "${target}".`,
      });
    }
  }

  if (requireEvidence) {
    for (const claim of claims) {
      if (suppressed(claim)) continue;
      if (claim.id && !evidenceTargets.has(claim.id)) {
        diagnostics.push({
          severity: "warning",
          code: "claim-without-evidence",
          message: `Claim "${claim.id}" has no evidence backing it.`,
          pos: claim.pos,
          nodeId: claim.id,
        });
      }
    }
  }

  const ignore = options.ignoreRules;
  if (ignore && ignore.length > 0) {
    const known = collectRuleCodes();
    for (const rule of ignore) {
      if (!known.has(rule)) {
        diagnostics.push({
          severity: "info",
          code: "unknown-ignore-rule",
          message: `--ignore-rule "${rule}" matches no known validator rule (ignored).`,
        });
      }
    }
    const set = new Set(ignore);
    return diagnostics.filter((d) => !set.has(d.code));
  }

  return diagnostics;
}

function readDeclaredProfiles(meta: Record<string, unknown>): string[] {
  if (Array.isArray(meta.profiles)) {
    const out: string[] = [];
    for (const p of meta.profiles) {
      if (typeof p === "string" && p.trim()) out.push(p.trim());
    }
    if (out.length > 0) return out;
  }
  if (typeof meta.profile === "string" && meta.profile.trim()) {
    return [meta.profile.trim()];
  }
  return [];
}

const KNOWN_RULES = [
  "duplicate-id",
  "out-of-profile-directive",
  "unknown-profile",
  "broken-reference",
  "evidence-missing-for",
  "figure-missing-alt",
  "plot-unknown-dataset",
  "plot-unknown-column",
  "plot-missing-data",
  "plot-mixed-delimiters",
  "risk-without-owner",
  "decision-without-status",
  "agent-task-without-scope",
  "escape-hatch-untrusted",
  "stale-citation",
  "claim-without-evidence",
  "state-change-missing-block",
  "state-change-missing-from-to",
];

function collectRuleCodes(): Set<string> {
  return new Set(KNOWN_RULES);
}

function suppressed(node: DirectiveNode): boolean {
  return node.attrs.noverify === true;
}

function readDatasetColumns(node: DirectiveNode): Set<string> {
  const cols = new Set<string>();
  if (typeof node.attrs.columns === "string") {
    for (const c of node.attrs.columns.split(/[,\s]+/).filter(Boolean)) cols.add(c);
  }
  const body = node.body ?? "";
  if (body.trim()) {
    let parsed: unknown;
    try {
      parsed = yaml.load(body);
    } catch {
      parsed = null;
    }
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const schema = (parsed as Record<string, unknown>).schema;
      if (schema && typeof schema === "object" && !Array.isArray(schema)) {
        for (const k of Object.keys(schema as Record<string, unknown>)) cols.add(k);
      }
    }
  }
  return cols;
}

function readPositiveNumber(v: unknown): number | undefined {
  if (typeof v === "number" && Number.isFinite(v) && v > 0) return v;
  if (typeof v === "string") {
    const n = Number(v);
    if (Number.isFinite(n) && n > 0) return n;
  }
  return undefined;
}

function isStale(accessed: string, now: Date, days: number): boolean {
  const t = Date.parse(accessed);
  if (Number.isNaN(t)) return false;
  const ageMs = now.getTime() - t;
  return ageMs > days * 24 * 60 * 60 * 1000;
}

export function formatDiagnostics(diagnostics: Diagnostic[], filename?: string): string {
  if (diagnostics.length === 0) return "✓ No issues found.";
  const lines: string[] = [];
  for (const d of diagnostics) {
    const where = d.pos ? `${filename ?? "input"}:${d.pos.line}:${d.pos.column}` : (filename ?? "");
    lines.push(`${d.severity.toUpperCase()} [${d.code}] ${where}: ${d.message}`);
  }
  return lines.join("\n");
}
