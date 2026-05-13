import { readFile } from "node:fs/promises";
import yaml from "js-yaml";
import { NomaCapabilityError } from "./errors.js";
import type { PatchOpName } from "./types.js";

export type AttrConstraint = {
  type?: "string" | "number" | "boolean";
  min?: number;
  max?: number;
  enum?: ReadonlyArray<string | number>;
};

export type BlockPolicy = {
  ops: Set<PatchOpName>;
  attrs?: Map<string, AttrConstraint>;
};

const KNOWN_OPS: ReadonlySet<PatchOpName> = new Set([
  "replace_block",
  "add_block",
  "delete_block",
  "update_attribute",
  "rename_id",
]);

export class CapabilityDescriptor {
  readonly version: 1;
  readonly profile?: string;
  readonly blocks: ReadonlyMap<string, BlockPolicy>;
  readonly idsRename: boolean;
  readonly validationRequired: boolean;

  private constructor(args: {
    version: 1;
    profile?: string;
    blocks: Map<string, BlockPolicy>;
    idsRename: boolean;
    validationRequired: boolean;
  }) {
    this.version = args.version;
    if (args.profile !== undefined) this.profile = args.profile;
    this.blocks = args.blocks;
    this.idsRename = args.idsRename;
    this.validationRequired = args.validationRequired;
  }

  static fromYaml(source: string): CapabilityDescriptor {
    let parsed: unknown;
    try {
      parsed = yaml.load(source);
    } catch (cause) {
      throw new NomaCapabilityError(`invalid YAML: ${(cause as Error).message}`, cause);
    }
    if (!parsed || typeof parsed !== "object" || !("nomaAgent" in parsed)) {
      throw new NomaCapabilityError("descriptor missing root key 'nomaAgent'");
    }
    const root = (parsed as { nomaAgent: unknown }).nomaAgent;
    if (!root || typeof root !== "object") {
      throw new NomaCapabilityError("nomaAgent must be a mapping");
    }
    const r = root as Record<string, unknown>;
    if (r["version"] !== 1) {
      throw new NomaCapabilityError(`unsupported descriptor version: ${String(r["version"])}`);
    }

    const blocks = new Map<string, BlockPolicy>();
    if (r["blocks"] && typeof r["blocks"] === "object") {
      for (const [name, raw] of Object.entries(r["blocks"] as Record<string, unknown>)) {
        if (!raw || typeof raw !== "object") continue;
        const b = raw as Record<string, unknown>;
        const ops = new Set<PatchOpName>();
        if (Array.isArray(b["ops"])) {
          for (const op of b["ops"]) {
            if (typeof op === "string" && KNOWN_OPS.has(op as PatchOpName)) {
              ops.add(op as PatchOpName);
            }
          }
        }
        let attrs: Map<string, AttrConstraint> | undefined;
        if (b["attrs"] && typeof b["attrs"] === "object") {
          attrs = new Map();
          for (const [key, rawAttr] of Object.entries(b["attrs"] as Record<string, unknown>)) {
            if (!rawAttr || typeof rawAttr !== "object") continue;
            const a = rawAttr as Record<string, unknown>;
            const constraint: AttrConstraint = {};
            if (typeof a["type"] === "string" && (a["type"] === "string" || a["type"] === "number" || a["type"] === "boolean")) {
              constraint.type = a["type"];
            }
            if (typeof a["min"] === "number") constraint.min = a["min"];
            if (typeof a["max"] === "number") constraint.max = a["max"];
            if (Array.isArray(a["enum"])) {
              constraint.enum = a["enum"].filter(
                (v): v is string | number => typeof v === "string" || typeof v === "number",
              );
            }
            attrs.set(key, constraint);
          }
        }
        const policy: BlockPolicy = attrs ? { ops, attrs } : { ops };
        blocks.set(name, policy);
      }
    }

    const idsRename =
      r["ids"] && typeof r["ids"] === "object" && (r["ids"] as Record<string, unknown>)["rename"] === true;
    const validationRequired =
      r["validation"] && typeof r["validation"] === "object" &&
      (r["validation"] as Record<string, unknown>)["required"] === true;

    return new CapabilityDescriptor({
      version: 1,
      ...(typeof r["profile"] === "string" ? { profile: r["profile"] } : {}),
      blocks,
      idsRename: Boolean(idsRename),
      validationRequired: Boolean(validationRequired),
    });
  }

  static async fromFile(file: string): Promise<CapabilityDescriptor | null> {
    let raw: string;
    try {
      raw = await readFile(file, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw new NomaCapabilityError(`cannot read ${file}: ${(e as Error).message}`, e);
    }
    return CapabilityDescriptor.fromYaml(raw);
  }

  allows(blockName: string, op: PatchOpName): boolean {
    const policy = this.blocks.get(blockName);
    if (!policy) return false;
    return policy.ops.has(op);
  }

  validateAttr(
    blockName: string,
    key: string,
    value: unknown,
  ): { ok: true } | { ok: false; reason: string } {
    const policy = this.blocks.get(blockName);
    if (!policy || !policy.attrs) return { ok: true };
    const constraint = policy.attrs.get(key);
    if (!constraint) return { ok: true };
    if (constraint.type === "string" && typeof value !== "string") {
      return { ok: false, reason: `expected string, got ${typeof value}` };
    }
    if (constraint.type === "boolean" && typeof value !== "boolean") {
      return { ok: false, reason: `expected boolean, got ${typeof value}` };
    }
    if (constraint.type === "number") {
      if (typeof value !== "number" || !Number.isFinite(value)) {
        return { ok: false, reason: `expected finite number, got ${typeof value}` };
      }
      if (constraint.min !== undefined && value < constraint.min) {
        return { ok: false, reason: `value ${value} < min ${constraint.min}` };
      }
      if (constraint.max !== undefined && value > constraint.max) {
        return { ok: false, reason: `value ${value} > max ${constraint.max}` };
      }
    }
    if (constraint.enum && !constraint.enum.includes(value as string | number)) {
      return { ok: false, reason: `value ${String(value)} not in enum [${constraint.enum.join(", ")}]` };
    }
    return { ok: true };
  }
}
