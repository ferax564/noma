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
    throw new Error("not implemented");
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
}
