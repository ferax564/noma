/**
 * Strict validation of model-produced patch operations against the bundled
 * `schemas/patch-op.schema.json`. Implements the JSON Schema subset that file uses (type, const, enum,
 * required, properties, additionalProperties, minLength, minimum, pattern, items, oneOf, anyOf, allOf,
 * not, if/then, local $ref) so the server has no runtime schema-validator dependency.
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import type { PatchOp } from "../patch.js";

type Schema = Record<string, unknown>;

let cachedSchema: Schema | undefined;

function patchOpSchema(): Schema {
  if (cachedSchema) return cachedSchema;
  const here = dirname(fileURLToPath(import.meta.url));
  const path = [resolve(here, "..", "..", "schemas", "patch-op.schema.json"), resolve(here, "..", "schemas", "patch-op.schema.json")].find((candidate) => existsSync(candidate));
  if (!path) throw new Error("patch-op.schema.json is not bundled with this build");
  cachedSchema = JSON.parse(readFileSync(path, "utf8")) as Schema;
  return cachedSchema;
}

/** AI drafts may not rename block IDs: IDs are user-facing API and a rename breaks every reference. */
const aiForbiddenOps = new Set(["rename_id"]);

export interface AiOpsValidation {
  ops: PatchOp[];
  errors: string[];
}

export function validateAiPatchOps(value: unknown, maxOps: number): AiOpsValidation {
  if (!Array.isArray(value)) return { ops: [], errors: ["ops must be an array"] };
  if (value.length > maxOps) return { ops: [], errors: [`at most ${maxOps} operations are allowed`] };
  const root = patchOpSchema();
  const errors: string[] = [];
  value.forEach((op, index) => {
    if (!validates(op, root, root)) errors.push(`ops[${index}] does not match the patch-op schema`);
    else if (aiForbiddenOps.has((op as { op: string }).op)) errors.push(`ops[${index}]: ${(op as { op: string }).op} is not allowed in AI drafts`);
  });
  return { ops: errors.length === 0 ? (value as PatchOp[]) : [], errors };
}

export function validatesPatchOp(value: unknown): boolean {
  const root = patchOpSchema();
  return validates(value, root, root);
}

function validates(value: unknown, schema: unknown, root: Schema): boolean {
  if (schema === true || schema === undefined) return true;
  if (schema === false || !schema || typeof schema !== "object") return false;
  const s = schema as Schema;
  if (typeof s.$ref === "string") {
    const target = resolveRef(s.$ref, root);
    if (!target || !validates(value, target, root)) return false;
  }
  if (s.type !== undefined && !typeMatches(value, s.type)) return false;
  if ("const" in s && !sameJson(value, s.const)) return false;
  if (Array.isArray(s.enum) && !s.enum.some((item) => sameJson(value, item))) return false;
  if (typeof value === "string") {
    if (typeof s.minLength === "number" && [...value].length < s.minLength) return false;
    if (typeof s.pattern === "string" && !new RegExp(s.pattern, "u").test(value)) return false;
  }
  if (typeof value === "number" && typeof s.minimum === "number" && value < s.minimum) return false;
  if (Array.isArray(value) && s.items !== undefined && !value.every((item) => validates(item, s.items, root))) return false;
  if (value && typeof value === "object" && !Array.isArray(value)) {
    const record = value as Record<string, unknown>;
    if (Array.isArray(s.required) && !s.required.every((key) => typeof key === "string" && Object.prototype.hasOwnProperty.call(record, key))) return false;
    const properties = (s.properties && typeof s.properties === "object" ? s.properties : {}) as Record<string, unknown>;
    for (const [key, item] of Object.entries(record)) {
      if (Object.prototype.hasOwnProperty.call(properties, key)) {
        if (!validates(item, properties[key], root)) return false;
      } else if (s.additionalProperties === false) {
        return false;
      } else if (s.additionalProperties && typeof s.additionalProperties === "object" && !validates(item, s.additionalProperties, root)) {
        return false;
      }
    }
  }
  if (Array.isArray(s.allOf) && !s.allOf.every((item) => validates(value, item, root))) return false;
  if (Array.isArray(s.anyOf) && !s.anyOf.some((item) => validates(value, item, root))) return false;
  if (Array.isArray(s.oneOf) && s.oneOf.filter((item) => validates(value, item, root)).length !== 1) return false;
  if (s.not !== undefined && validates(value, s.not, root)) return false;
  if (s.if !== undefined && validates(value, s.if, root) && s.then !== undefined && !validates(value, s.then, root)) return false;
  return true;
}

function resolveRef(ref: string, root: Schema): unknown {
  if (!ref.startsWith("#/")) return undefined;
  let current: unknown = root;
  for (const part of ref.slice(2).split("/")) {
    if (!current || typeof current !== "object") return undefined;
    current = (current as Record<string, unknown>)[part.replace(/~1/g, "/").replace(/~0/g, "~")];
  }
  return current;
}

function typeMatches(value: unknown, type: unknown): boolean {
  const types = Array.isArray(type) ? type : [type];
  return types.some((item) => {
    switch (item) {
      case "string":
        return typeof value === "string";
      case "number":
        return typeof value === "number" && Number.isFinite(value);
      case "integer":
        return typeof value === "number" && Number.isInteger(value);
      case "boolean":
        return typeof value === "boolean";
      case "array":
        return Array.isArray(value);
      case "object":
        return Boolean(value) && typeof value === "object" && !Array.isArray(value);
      case "null":
        return value === null;
      default:
        return false;
    }
  });
}

function sameJson(left: unknown, right: unknown): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}
