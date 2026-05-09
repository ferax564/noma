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
}

const DEFAULT_STALE_DAYS = 365;

export function validate(doc: DocumentNode, options: ValidateOptions = {}): Diagnostic[] {
  const requireEvidence = options.requireEvidenceForClaims !== false;
  const staleDays = options.staleCitationDays ?? DEFAULT_STALE_DAYS;
  const now = options.now ?? new Date();

  const diagnostics: Diagnostic[] = [];
  const ids = new Map<string, Node>();
  const claims: DirectiveNode[] = [];
  const evidenceTargets = new Set<string>();
  const referenced = new Set<string>();

  for (const node of walk(doc)) {
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

    if (node.type !== "directive") continue;

    if (node.name === "claim" && node.id) claims.push(node);

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
      if (!hasData) {
        diagnostics.push({
          severity: "error",
          code: "plot-missing-data",
          message: `Plot has no data or dataset attribute.`,
          pos: node.pos,
          nodeId: node.id,
        });
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
      const stale = isStale(String(node.attrs.accessed), now, staleDays);
      if (stale) {
        diagnostics.push({
          severity: "warning",
          code: "stale-citation",
          message: `Citation "${node.id ?? "?"}" was last accessed ${node.attrs.accessed} (>${staleDays} days ago).`,
          pos: node.pos,
          nodeId: node.id,
        });
      }
    }
  }

  for (const target of referenced) {
    if (!ids.has(target)) {
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

  return diagnostics;
}

function suppressed(node: DirectiveNode): boolean {
  return node.attrs.noverify === true;
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
