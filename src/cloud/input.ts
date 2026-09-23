/** Request-input validators shared across Noma Cloud routes. Each throws `HttpError(400)` on bad input. */
import type { CloudResourceType } from "../cloud-db.js";
import { HttpError } from "./http.js";

export function optionalCloudId(value: unknown, label: string): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") throw new HttpError(400, `${label} ID must be a string`);
  assertCloudId(value, label);
  return value;
}

export function resourceTypeInput(value: unknown): CloudResourceType {
  if (value === "document" || value === "site") return value;
  throw new HttpError(400, "resourceType must be document or site");
}

export function resourceIdInput(value: unknown, resourceType: CloudResourceType): string {
  if (typeof value !== "string") throw new HttpError(400, "resourceId must be a string");
  assertCloudId(value, resourceType === "document" ? "Document" : "Site");
  return value;
}

export function numberQuery(value: string | null): number | undefined {
  if (value === null || value === "") return undefined;
  return Number(value);
}

export function boundedInteger(value: unknown, fallback: number, min: number, max: number, label: string): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isInteger(value)) throw new HttpError(400, `${label} must be an integer`);
  if (value < min || value > max) throw new HttpError(400, `${label} must be between ${min} and ${max}`);
  return value;
}

export function documentIdList(value: unknown): string[] {
  if (!Array.isArray(value)) throw new HttpError(400, "documentIds must be an array");
  const ids = value.map((item) => {
    if (typeof item !== "string") throw new HttpError(400, "documentIds must contain strings");
    assertCloudId(item, "Document");
    return item;
  });
  return [...new Set(ids)];
}

export function optionalStringArray(value: unknown, label: string, max: number): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw new HttpError(400, `${label} must be an array`);
  const items = value.map((item) => {
    if (typeof item !== "string" || !item.trim()) throw new HttpError(400, `${label} must contain non-empty strings`);
    return item.trim().slice(0, 1_000);
  });
  if (items.length > max) throw new HttpError(400, `${label} cannot contain more than ${max} items`);
  return [...new Set(items)];
}

export function requiredStringArray(value: unknown, label: string, max: number): string[] {
  const items = optionalStringArray(value, label, max);
  if (!items || items.length === 0) throw new HttpError(400, `${label} must contain at least one item`);
  return items;
}

export function optionalRecord(value: unknown, label: string): Record<string, unknown> | undefined {
  if (value === undefined) return undefined;
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new HttpError(400, `${label} must be an object`);
  return value as Record<string, unknown>;
}

export function scalarRecord(value: unknown, label: string): Record<string, string | number | boolean> {
  const record = optionalRecord(value, label) ?? {};
  const result: Record<string, string | number | boolean> = {};
  for (const [key, item] of Object.entries(record)) {
    if (typeof item !== "string" && typeof item !== "number" && typeof item !== "boolean") throw new HttpError(400, `${label}.${key} must be a string, number, or boolean`);
    result[key] = item;
  }
  return result;
}

export function boundedNumber(value: unknown, fallback: number, min: number, max: number, label: string): number {
  if (value === undefined) return fallback;
  if (typeof value !== "number" || !Number.isFinite(value)) throw new HttpError(400, `${label} must be a finite number`);
  if (value < min || value > max) throw new HttpError(400, `${label} must be between ${min} and ${max}`);
  return value;
}

export function stringPathPart(value: string | undefined, label: string): string {
  if (!value) throw new HttpError(400, `${label} is required`);
  return value;
}

export function optionalIsoDate(value: unknown, label: string): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || !Number.isFinite(Date.parse(value))) throw new HttpError(400, `${label} must be an ISO date`);
  return value;
}

export function requiredIsoDate(value: unknown, label: string): string {
  const date = optionalIsoDate(value, label);
  if (!date) throw new HttpError(400, `${label} is required`);
  return date;
}

export function absoluteUrl(value: unknown, label: string): string {
  if (typeof value !== "string") throw new HttpError(400, `${label} must be a URL`);
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("invalid protocol");
    return url.toString();
  } catch {
    throw new HttpError(400, `${label} must be an absolute HTTP URL`);
  }
}

export function shaInput(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) throw new HttpError(400, `${label} must be a lowercase SHA-256 hash`);
  return value;
}

export function stringInput(input: Record<string, unknown>, key: string, fallback?: string): string {
  const value = optionalString(input[key]);
  if (value) return value;
  if (fallback !== undefined) return fallback;
  throw new HttpError(400, `${key} must be a string`);
}

export function optionalString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

export function assertCloudId(id: string, label: string): void {
  if (!/^[A-Za-z0-9_-]{8,80}$/.test(id)) throw new HttpError(400, `Invalid ${label.toLowerCase()} ID`);
}

const LABEL_RE = /^[\p{L}\p{N}][\p{L}\p{N}_.:-]{0,49}$/u;

/** Confluence-style label: lowercase, whitespace becomes `-`, 1–50 word characters. */
export function labelInput(value: unknown): string {
  if (typeof value !== "string") throw new HttpError(400, "label must be a string");
  const label = value.trim().toLowerCase().replace(/\s+/g, "-");
  if (!LABEL_RE.test(label)) throw new HttpError(400, "label must be 1-50 letters, digits, '-', '_', '.', or ':'");
  return label;
}
