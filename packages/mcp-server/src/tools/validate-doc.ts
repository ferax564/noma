import { readFileSync } from "node:fs";
import { parse, validate, isBookManifestPath } from "@ferax564/noma-cli";
import type { Diagnostic } from "@ferax564/noma-cli";
import type { ValidationSummary } from "../transcript.js";

export interface ValidateDocResult {
  ok: boolean;
  diagnostics: Diagnostic[];
}

export function validateDoc(file: string): ValidateDocResult {
  if (isBookManifestPath(file)) {
    throw new Error("book manifests are not supported by validate_doc — use the CLI");
  }
  const source = readFileSync(file, "utf8");
  const doc = parse(source);
  const diagnostics = validate(doc);
  const ok = !diagnostics.some(d => d.severity === "error");
  return { ok, diagnostics };
}

export function summarizeValidation(diagnostics: Diagnostic[]): ValidationSummary {
  if (diagnostics.some(d => d.severity === "error")) return "error";
  // Diagnostic.severity uses "warning" (not "warn") — map to our compact "warn"
  if (diagnostics.some(d => d.severity === "warning")) return "warn";
  return "ok";
}
