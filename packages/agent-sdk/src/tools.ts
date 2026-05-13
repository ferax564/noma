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
    const res = await this.client.callTool("read_doc", { file });
    if (res.isError) throw new NomaSystemError(res.text);
    return JSON.parse(res.text) as { blocks: BlockSummary[] };
  }

  async listIds(file: string): Promise<{ ids: string[]; aliases: Record<string, string> }> {
    const res = await this.client.callTool("list_ids", { file });
    if (res.isError) throw new NomaSystemError(res.text);
    return JSON.parse(res.text) as { ids: string[]; aliases: Record<string, string> };
  }

  async validateDoc(file: string): Promise<{ ok: boolean; diagnostics: Diagnostic[] }> {
    const res = await this.client.callTool("validate_doc", { file });
    if (res.isError) throw new NomaSystemError(res.text);
    return JSON.parse(res.text) as { ok: boolean; diagnostics: Diagnostic[] };
  }

  async patchBlock(file: string, op: PatchOp, options: PatchOptions = {}): Promise<PatchResult> {
    throw new Error("not implemented");
  }
}
