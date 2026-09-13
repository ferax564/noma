import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";

export interface HealthStatus {
  status: "ok" | "degraded" | "unready";
  checks: Record<string, boolean>;
}

export function healthProbe(input: { dbOk: boolean; killSwitch: boolean; objectStoreOk: boolean }): HealthStatus {
  const checks = {
    database: input.dbOk,
    objectStore: input.objectStoreOk,
    writersEnabled: !input.killSwitch,
  };
  if (!checks.database) return { status: "unready", checks };
  if (!checks.objectStore || !checks.writersEnabled) return { status: "degraded", checks };
  return { status: "ok", checks };
}

export function redactSupportBundle(bundle: Record<string, unknown>): Record<string, unknown> {
  const encoded = JSON.stringify(bundle, (_key, value) => {
    if (typeof value === "string" && /(secret|token|password|authorization)/i.test(_key)) return "[redacted]";
    return value;
  });
  return JSON.parse(encoded) as Record<string, unknown>;
}

export function generateSbom(lockfilePath: string): { bomFormat: string; components: Array<{ name: string; version: string; purl: string }> } {
  const lock = JSON.parse(readFileSync(lockfilePath, "utf8")) as {
    packages?: Record<string, { version?: string }>;
  };
  const components: Array<{ name: string; version: string; purl: string }> = [];
  for (const [path, meta] of Object.entries(lock.packages ?? {})) {
    if (!path.startsWith("node_modules/")) continue;
    const name = path.replace(/^node_modules\//, "");
    if (name.includes("/node_modules/")) continue;
    const version = meta.version ?? "0.0.0";
    components.push({ name, version, purl: `pkg:npm/${name}@${version}` });
  }
  return { bomFormat: "CycloneDX", components };
}

export function percentile(values: number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return sorted[index] ?? 0;
}

export function digestObject(value: unknown): string {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex");
}
