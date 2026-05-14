import { createRequire } from "node:module";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { NomaSpawnError, NomaTimeoutError, NomaTransportError } from "./errors.js";

const require_ = createRequire(import.meta.url);

export type StdioMcpClientOptions = {
  mcpServerBin?: string;
  env?: NodeJS.ProcessEnv;
  requestTimeoutMs?: number;
};

export type ToolDescriptor = { name: string };

export type ToolCallResult = {
  isError: boolean;
  text: string;
};

const DEFAULT_TIMEOUT_MS = 30_000;

function resolveServerBin(override?: string): string {
  if (override) return override;
  try {
    return require_.resolve("@ferax564/noma-mcp-server/dist/index.js");
  } catch (cause) {
    throw new NomaSpawnError("could not resolve @ferax564/noma-mcp-server binary", cause);
  }
}

export class StdioMcpClient {
  private readonly client: Client;
  private readonly transport: StdioClientTransport;
  private readonly timeoutMs: number;
  private closed = false;

  private constructor(client: Client, transport: StdioClientTransport, timeoutMs: number) {
    this.client = client;
    this.transport = transport;
    this.timeoutMs = timeoutMs;
  }

  static async spawn(options: StdioMcpClientOptions = {}): Promise<StdioMcpClient> {
    const bin = resolveServerBin(options.mcpServerBin);
    // StdioClientTransport expects env as Record<string, string> — NodeJS.ProcessEnv
    // is Record<string, string | undefined>, so we must drop undefined values
    // before passing through (or the strict-TS build fails).
    const env = options.env
      ? Object.fromEntries(
          Object.entries(options.env).filter(
            (entry): entry is [string, string] => typeof entry[1] === "string",
          ),
        )
      : undefined;
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [bin],
      ...(env ? { env } : {}),
    });
    const client = new Client(
      { name: "@ferax564/noma-agent-sdk", version: "0.1.0" },
      { capabilities: {} },
    );
    try {
      await client.connect(transport);
    } catch (cause) {
      throw new NomaSpawnError(`failed to start mcp-server: ${(cause as Error).message}`, cause);
    }
    return new StdioMcpClient(client, transport, options.requestTimeoutMs ?? DEFAULT_TIMEOUT_MS);
  }

  async listTools(): Promise<ToolDescriptor[]> {
    this.assertOpen();
    const res = await this.withTimeout(this.client.listTools());
    return res.tools.map((t) => ({ name: t.name }));
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<ToolCallResult> {
    this.assertOpen();
    // The MCP SDK's callTool return type is a union: it can be the
    // CallToolResult shape (`{ content, isError? }`) OR a legacy
    // `{ toolResult }` envelope. Strict TS rejects direct field access.
    // The @ferax564/noma-mcp-server always emits the CallToolResult shape, but the
    // SDK's static type doesn't know that — narrow by sniffing for
    // `content`. Throw a transport error if the envelope is unexpected.
    const raw = await this.withTimeout(
      this.client.callTool({ name, arguments: args }),
    );
    if (!("content" in raw)) {
      throw new NomaTransportError(`tool ${name} returned legacy toolResult envelope; expected CallToolResult`);
    }
    const content = raw.content;
    if (!Array.isArray(content) || content.length === 0 || content[0]?.type !== "text") {
      throw new NomaTransportError(`tool ${name} returned no text content`);
    }
    return { isError: raw.isError === true, text: String(content[0].text) };
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    await this.client.close();
  }

  private assertOpen(): void {
    if (this.closed) throw new NomaTransportError("client closed");
  }

  private withTimeout<T>(p: Promise<T>): Promise<T> {
    return new Promise<T>((resolve, reject) => {
      const handle = setTimeout(
        () => reject(new NomaTimeoutError(`request exceeded ${this.timeoutMs}ms`)),
        this.timeoutMs,
      );
      p.then((v) => {
        clearTimeout(handle);
        resolve(v);
      }).catch((e) => {
        clearTimeout(handle);
        reject(e);
      });
    });
  }
}
