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
    const args: Record<string, unknown> = { file, op };
    if (options.reason !== undefined) args["reason"] = options.reason;
    if (options.expectedSha !== undefined) args["expected_sha"] = options.expectedSha;
    if (options.actor !== undefined) args["actor"] = options.actor;
    if (options.baseSha256 !== undefined) args["base_sha256"] = options.baseSha256;
    if (options.parentOpId !== undefined) args["parent_op_id"] = options.parentOpId;

    const res = await this.client.callTool("patch_block", args);
    if (res.isError) throw new NomaSystemError(res.text);

    const body = JSON.parse(res.text) as
      | {
          ok: true;
          post_validation: "ok" | "warn" | "error";
          transcript_entry: TranscriptRecord;
          diagnostics: Diagnostic[];
        }
      | { ok: false; error: string; code?: string };

    if (body.ok) {
      return {
        ok: true,
        postValidation: body.post_validation,
        transcriptEntry: body.transcript_entry,
        diagnostics: body.diagnostics,
      };
    }
    const failure: { ok: false; error: string; code?: PatchErrorCode | string } = {
      ok: false,
      error: body.error,
    };
    if (body.code !== undefined) failure.code = body.code;
    return failure;
  }
}
