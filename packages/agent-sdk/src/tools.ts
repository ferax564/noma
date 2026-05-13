import { StdioMcpClient, type StdioMcpClientOptions } from "./transport.js";
import { NomaSystemError } from "./errors.js";
import type {
  BlockSummary,
  Diagnostic,
  PatchOp,
  PatchResult,
  Actor,
  TranscriptRecord,
  PatchErrorCode,
} from "./types.js";

export type PatchOptions = {
  reason?: string;
  expectedSha?: string;
  actor?: Actor;
  baseSha256?: string;
  parentOpId?: string;
};

export class NomaTools {
  private readonly client: StdioMcpClient;

  private constructor(client: StdioMcpClient) {
    this.client = client;
  }

  static async spawn(options: StdioMcpClientOptions = {}): Promise<NomaTools> {
    const client = await StdioMcpClient.spawn(options);
    return new NomaTools(client);
  }

  async close(): Promise<void> {
    await this.client.close();
  }

  async readDoc(file: string): Promise<{ blocks: BlockSummary[] }> {
    throw new Error("not implemented");
  }

  async listIds(file: string): Promise<{ ids: string[]; aliases: Record<string, string> }> {
    throw new Error("not implemented");
  }

  async validateDoc(file: string): Promise<{ ok: boolean; diagnostics: Diagnostic[] }> {
    throw new Error("not implemented");
  }

  async patchBlock(file: string, op: PatchOp, options: PatchOptions = {}): Promise<PatchResult> {
    throw new Error("not implemented");
  }
}
