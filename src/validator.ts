import type { Diagnostic, DocumentNode, Node } from "./ast.js";
import { walk } from "./ast.js";

export interface ValidateOptions {
  /**
   * When true, claims must be backed by at least one evidence block.
   * Off by default — schema-driven later.
   */
  requireEvidenceForClaims?: boolean;
}

export function validate(doc: DocumentNode, options: ValidateOptions = {}): Diagnostic[] {
  const diagnostics: Diagnostic[] = [];
  const ids = new Map<string, Node>();
  const claimIds = new Set<string>();
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

    if (node.type === "directive") {
      if (node.name === "claim" && node.id) claimIds.add(node.id);

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

  if (options.requireEvidenceForClaims) {
    for (const claim of claimIds) {
      if (!evidenceTargets.has(claim)) {
        diagnostics.push({
          severity: "warning",
          code: "claim-without-evidence",
          message: `Claim "${claim}" has no evidence backing it.`,
          nodeId: claim,
        });
      }
    }
  }

  return diagnostics;
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
