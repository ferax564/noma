import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { resolve as resolvePath } from "node:path";
import { NomaTools, type PatchOptions } from "./tools.js";
import { CapabilityDescriptor } from "./capabilities.js";
import type {
  Actor,
  CapabilityCheckResult,
  PatchOp,
  PatchResult,
  TranscriptRecord,
} from "./types.js";

export type SafePatchOptions = {
  retryOnShaMismatch?: number;
  reason?: string;
  actor?: Actor;
};

export type ApplyOpsOptions = {
  stopOnFirstError?: boolean;
  actor?: Actor;
  parentChain?: boolean;
};

export class NomaWorkflow {
  private readonly tools: NomaTools;
  private readonly fileLocks = new Map<string, Promise<void>>();

  constructor(tools: NomaTools) {
    this.tools = tools;
  }

  async safePatch(file: string, op: PatchOp, options: SafePatchOptions = {}): Promise<PatchResult> {
    return this.withFileLock(file, async () => {
      // Clamp retries to [0, MAX_RETRIES]. Negative or non-finite values
      // would skip the loop entirely (returning `undefined as PatchResult`,
      // a type lie); huge values would burn API budget against a server
      // that keeps returning sha_mismatch. 10 is an arbitrary but sufficient
      // cap — concurrent same-process races are serialized by the mutex;
      // anything past ~3 retries means a different process is contending.
      const requested = options.retryOnShaMismatch ?? 3;
      const retries = Number.isFinite(requested) ? Math.max(0, Math.min(10, Math.floor(requested))) : 3;
      let last: PatchResult = {
        ok: false,
        error: "no attempts made",
        code: "sha_mismatch",
      };
      for (let attempt = 0; attempt <= retries; attempt++) {
        const sha = await sha8(file);
        const patchOptions: PatchOptions = { expectedSha: sha };
        if (options.reason !== undefined) patchOptions.reason = options.reason;
        if (options.actor !== undefined) patchOptions.actor = options.actor;
        last = await this.tools.patchBlock(file, op, patchOptions);
        if (last.ok) return last;
        if (last.code !== "sha_mismatch") return last;
      }
      return last;
    });
  }

  async applyOps(file: string, ops: PatchOp[], options: ApplyOpsOptions = {}): Promise<PatchResult[]> {
    throw new Error("not implemented");
  }

  async replayTranscript(file: string): Promise<TranscriptRecord[]> {
    throw new Error("not implemented");
  }

  async readCapabilities(file: string): Promise<CapabilityDescriptor | null> {
    throw new Error("not implemented");
  }

  async checkCapability(file: string, op: PatchOp): Promise<CapabilityCheckResult> {
    throw new Error("not implemented");
  }

  private async withFileLock<T>(file: string, fn: () => Promise<T>): Promise<T> {
    // Key by absolute path so `./doc.noma` and `/abs/doc.noma` map to the
    // same mutex slot. Without this, two safePatch calls with different
    // path spellings would bypass each other's serialization and race.
    const key = resolvePath(file);
    const previous = this.fileLocks.get(key) ?? Promise.resolve();
    let release!: () => void;
    const next = new Promise<void>((r) => (release = r));
    const chained = previous.then(() => next);
    this.fileLocks.set(key, chained);
    await previous;
    try {
      return await fn();
    } finally {
      release();
      if (this.fileLocks.get(key) === chained) {
        this.fileLocks.delete(key);
      }
    }
  }
}

async function sha8(file: string): Promise<string> {
  const buf = await readFile(file);
  return createHash("sha256").update(buf).digest("hex").slice(0, 8);
}
