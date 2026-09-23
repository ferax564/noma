/**
 * LLM provider layer for Noma Cloud AI features. Providers take a system prompt plus messages and return
 * plain text with token usage; everything that touches documents (retrieval, citation checks, patch
 * proofs, approval) stays in the Cloud routes. `createLlmProviderFromEnv` returns `undefined` when no
 * provider is configured so callers can fall back to extractive behaviour.
 */

export interface LlmMessage {
  role: "user" | "assistant";
  content: string;
}

export interface LlmCompletionRequest {
  system: string;
  messages: LlmMessage[];
  maxTokens: number;
  /** Ignored by models that reject sampling parameters (Claude Opus 5 and newer). */
  temperature?: number;
}

export interface LlmUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface LlmCompletion {
  text: string;
  usage: LlmUsage;
  /** Model that actually served the request (can differ from the requested one after a server-side fallback). */
  model: string;
  stopReason: string;
  refused: boolean;
}

export interface LlmProvider {
  readonly id: string;
  readonly model: string;
  /** Operator attestation that the provider account runs under zero data retention. */
  readonly zeroRetention: boolean;
  complete(request: LlmCompletionRequest): Promise<LlmCompletion>;
}

export type LlmErrorCode = "timeout" | "rate_limited" | "server_error" | "bad_request" | "auth" | "network" | "truncated";

export class LlmError extends Error {
  constructor(readonly code: LlmErrorCode, message: string, readonly status?: number) {
    super(message);
  }
}

export const DEFAULT_ANTHROPIC_MODEL = "claude-opus-5";

interface ModelPrice {
  inputPerMillion: number;
  outputPerMillion: number;
}

const modelPrices: Array<[RegExp, ModelPrice]> = [
  [/^claude-(fable|mythos)-/, { inputPerMillion: 10, outputPerMillion: 50 }],
  [/^claude-opus-5-5/, { inputPerMillion: 4, outputPerMillion: 20 }],
  [/^claude-opus-(5|4-[5-8])/, { inputPerMillion: 5, outputPerMillion: 25 }],
  [/^claude-sonnet-5/, { inputPerMillion: 2, outputPerMillion: 10 }],
  [/^claude-sonnet-4/, { inputPerMillion: 3, outputPerMillion: 15 }],
  [/^claude-haiku-4-5/, { inputPerMillion: 1, outputPerMillion: 5 }],
  [/^fake-/, { inputPerMillion: 1, outputPerMillion: 5 }],
];
const unknownModelPrice: ModelPrice = { inputPerMillion: 10, outputPerMillion: 50 };

export function modelPrice(model: string): ModelPrice {
  return modelPrices.find(([pattern]) => pattern.test(model))?.[1] ?? unknownModelPrice;
}

export function costUsd(model: string, usage: LlmUsage): number {
  const price = modelPrice(model);
  return roundUsd((usage.inputTokens * price.inputPerMillion + usage.outputTokens * price.outputPerMillion) / 1_000_000);
}

/** Upper bound for a request before it is sent: ~3 characters per input token plus the full output allowance. */
export function worstCaseCostUsd(model: string, request: LlmCompletionRequest): number {
  const chars = request.system.length + request.messages.reduce((sum, message) => sum + message.content.length, 0);
  return costUsd(model, { inputTokens: Math.ceil(chars / 3), outputTokens: request.maxTokens });
}

function roundUsd(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

export interface AnthropicProviderOptions {
  apiKey: string;
  model?: string;
  baseUrl?: string;
  timeoutMs?: number;
  maxRetries?: number;
  zeroRetention?: boolean;
  /** Opt into server-side refusal fallbacks (`fallbacks: "default"`). */
  fallbacks?: boolean;
  effort?: "low" | "medium" | "high" | "xhigh" | "max";
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

interface AnthropicResponseBody {
  model?: unknown;
  stop_reason?: unknown;
  content?: unknown;
  usage?: { input_tokens?: unknown; output_tokens?: unknown; cache_read_input_tokens?: unknown; cache_creation_input_tokens?: unknown };
}

const fallbackBeta = "server-side-fallback-2026-07-01";

/**
 * Claude Messages API over `fetch`. The Cloud server has no Anthropic SDK dependency, so this speaks
 * the documented wire format directly: one request per attempt, per-attempt timeout, retries on 408,
 * 409, 429, 5xx, and network errors honouring `retry-after`.
 */
export class AnthropicMessagesProvider implements LlmProvider {
  readonly id = "anthropic";
  readonly model: string;
  readonly zeroRetention: boolean;
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly fallbacks: boolean;
  private readonly effort: AnthropicProviderOptions["effort"];
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options: AnthropicProviderOptions) {
    this.apiKey = options.apiKey;
    this.model = options.model ?? DEFAULT_ANTHROPIC_MODEL;
    this.baseUrl = (options.baseUrl ?? "https://api.anthropic.com").replace(/\/+$/, "");
    this.timeoutMs = options.timeoutMs ?? 120_000;
    this.maxRetries = options.maxRetries ?? 2;
    this.zeroRetention = options.zeroRetention === true;
    this.fallbacks = options.fallbacks !== false;
    this.effort = options.effort;
    this.fetchImpl = options.fetch ?? fetch;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  async complete(request: LlmCompletionRequest): Promise<LlmCompletion> {
    const body: Record<string, unknown> = {
      model: this.model,
      max_tokens: request.maxTokens,
      system: request.system,
      messages: request.messages.map((message) => ({ role: message.role, content: message.content })),
    };
    if (request.temperature !== undefined && modelAcceptsSampling(this.model)) body.temperature = request.temperature;
    if (this.effort) body.output_config = { effort: this.effort };
    if (this.fallbacks) body.fallbacks = "default";
    const headers: Record<string, string> = {
      "content-type": "application/json",
      "x-api-key": this.apiKey,
      "anthropic-version": "2023-06-01",
    };
    if (this.fallbacks) headers["anthropic-beta"] = fallbackBeta;

    let lastError: LlmError | undefined;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeoutMs);
      let response: Response;
      try {
        response = await this.fetchImpl(`${this.baseUrl}/v1/messages`, { method: "POST", headers, body: JSON.stringify(body), signal: controller.signal });
      } catch (error) {
        clearTimeout(timer);
        lastError = controller.signal.aborted
          ? new LlmError("timeout", `Model request timed out after ${this.timeoutMs}ms`)
          : new LlmError("network", error instanceof Error ? error.message : "Model request failed");
        if (attempt < this.maxRetries) await this.sleep(backoffMs(attempt));
        continue;
      }
      let text: string;
      try {
        text = await response.text();
      } catch (error) {
        clearTimeout(timer);
        lastError = new LlmError(controller.signal.aborted ? "timeout" : "network", error instanceof Error ? error.message : "Model response failed");
        if (attempt < this.maxRetries) await this.sleep(backoffMs(attempt));
        continue;
      }
      clearTimeout(timer);
      if (response.ok) return parseAnthropicResponse(text, this.model);
      lastError = anthropicHttpError(response.status, text);
      if (!retryableStatus(response.status) || attempt >= this.maxRetries) break;
      await this.sleep(retryAfterMs(response.headers.get("retry-after")) ?? backoffMs(attempt));
    }
    throw lastError ?? new LlmError("network", "Model request failed");
  }
}

function modelAcceptsSampling(model: string): boolean {
  return /^claude-(haiku-4-5|sonnet-4-[56]|opus-4-[56]|opus-4-1|3)/.test(model);
}

function parseAnthropicResponse(text: string, requestedModel: string): LlmCompletion {
  let parsed: AnthropicResponseBody;
  try {
    parsed = JSON.parse(text) as AnthropicResponseBody;
  } catch {
    throw new LlmError("server_error", "Model returned invalid JSON");
  }
  const stopReason = typeof parsed.stop_reason === "string" ? parsed.stop_reason : "unknown";
  const blocks = Array.isArray(parsed.content) ? parsed.content : [];
  const output = stopReason === "refusal"
    ? ""
    : blocks
        .filter((block): block is { type: "text"; text: string } => Boolean(block) && typeof block === "object" && (block as { type?: unknown }).type === "text" && typeof (block as { text?: unknown }).text === "string")
        .map((block) => block.text)
        .join("");
  const usage = parsed.usage ?? {};
  const inputTokens = numberOrZero(usage.input_tokens) + numberOrZero(usage.cache_read_input_tokens) + numberOrZero(usage.cache_creation_input_tokens);
  const completion: LlmCompletion = {
    text: output,
    usage: { inputTokens, outputTokens: numberOrZero(usage.output_tokens) },
    model: typeof parsed.model === "string" && parsed.model ? parsed.model : requestedModel,
    stopReason,
    refused: stopReason === "refusal",
  };
  if (stopReason === "max_tokens" && !output.trim()) throw new LlmError("truncated", "Model used its whole output allowance before answering");
  return completion;
}

function numberOrZero(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

function anthropicHttpError(status: number, body: string): LlmError {
  let message = `Model API returned ${status}`;
  try {
    const parsed = JSON.parse(body) as { error?: { message?: unknown } };
    if (typeof parsed.error?.message === "string") message = `${message}: ${parsed.error.message.slice(0, 300)}`;
  } catch {
    // The status code alone is enough when the body is not JSON.
  }
  if (status === 401 || status === 403) return new LlmError("auth", message, status);
  if (status === 429) return new LlmError("rate_limited", message, status);
  if (status >= 500) return new LlmError("server_error", message, status);
  return new LlmError("bad_request", message, status);
}

function retryableStatus(status: number): boolean {
  return status === 408 || status === 409 || status === 429 || status >= 500;
}

function retryAfterMs(value: string | null): number | undefined {
  if (!value) return undefined;
  const seconds = Number(value);
  if (!Number.isFinite(seconds) || seconds < 0) return undefined;
  return Math.min(20_000, seconds * 1_000);
}

function backoffMs(attempt: number): number {
  return Math.min(8_000, 500 * 2 ** attempt);
}

export type FakeLlmHandler = (request: LlmCompletionRequest) => string | { text: string; usage?: Partial<LlmUsage>; refused?: boolean; model?: string };

/**
 * Deterministic in-process provider for tests and offline demos. Without a handler it answers from the
 * first retrieved block (`Noma task: ask`) and returns empty op lists for editing tasks.
 */
export class FakeLlmProvider implements LlmProvider {
  readonly id = "fake";
  readonly requests: LlmCompletionRequest[] = [];

  constructor(
    private readonly handler: FakeLlmHandler = defaultFakeHandler,
    readonly model = "fake-model",
    readonly zeroRetention = true,
  ) {}

  async complete(request: LlmCompletionRequest): Promise<LlmCompletion> {
    this.requests.push(request);
    const result = this.handler(request);
    const normalized = typeof result === "string" ? { text: result } : result;
    const chars = request.system.length + request.messages.reduce((sum, message) => sum + message.content.length, 0);
    return {
      text: normalized.refused ? "" : normalized.text,
      usage: {
        inputTokens: normalized.usage?.inputTokens ?? Math.ceil(chars / 4),
        outputTokens: normalized.usage?.outputTokens ?? Math.ceil(normalized.text.length / 4),
      },
      model: normalized.model ?? this.model,
      stopReason: normalized.refused ? "refusal" : "end_turn",
      refused: normalized.refused === true,
    };
  }
}

function defaultFakeHandler(request: LlmCompletionRequest): string {
  const task = /Noma task: (\w+)/.exec(request.system)?.[1];
  const prompt = request.messages.map((message) => message.content).join("\n");
  if (task === "ask") {
    const block = /<block ref="([^"]+)"[^>]*>\n?([\s\S]*?)<\/block>/.exec(prompt);
    if (!block) return "INSUFFICIENT_EVIDENCE";
    const excerpt = decodeEntities(block[2] ?? "").replace(/\s+/g, " ").trim().slice(0, 240);
    return `${excerpt} [${block[1]}]`;
  }
  if (task === "summarize") return "This page is summarised by the offline fake model.";
  if (task === "draft_page") return "# Draft page\n\nDrafted by the offline fake model.\n";
  return JSON.stringify({ summary: "No changes proposed by the offline fake model.", ops: [] });
}

function decodeEntities(value: string): string {
  return value.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&quot;/g, '"').replace(/&amp;/g, "&");
}

/**
 * Provider from the environment: `NOMA_CLOUD_LLM_PROVIDER=anthropic|fake|none` (default `anthropic`
 * when `ANTHROPIC_API_KEY` is set), `NOMA_CLOUD_LLM_MODEL`, `NOMA_CLOUD_LLM_TIMEOUT_MS`,
 * `NOMA_CLOUD_LLM_MAX_RETRIES`, `NOMA_CLOUD_LLM_ZERO_RETENTION`, `NOMA_CLOUD_LLM_FALLBACKS`,
 * `NOMA_CLOUD_LLM_EFFORT`, and `ANTHROPIC_BASE_URL`.
 */
export function createLlmProviderFromEnv(env: NodeJS.ProcessEnv = process.env): LlmProvider | undefined {
  const kind = env.NOMA_CLOUD_LLM_PROVIDER?.trim().toLowerCase();
  if (kind === "none" || kind === "off") return undefined;
  if (kind === "fake") return new FakeLlmProvider(undefined, env.NOMA_CLOUD_LLM_MODEL?.trim() || "fake-model");
  const apiKey = env.ANTHROPIC_API_KEY?.trim();
  if (!apiKey) return undefined;
  if (kind && kind !== "anthropic") throw new Error(`Unsupported NOMA_CLOUD_LLM_PROVIDER: ${kind}`);
  const effort = env.NOMA_CLOUD_LLM_EFFORT?.trim();
  if (effort && !["low", "medium", "high", "xhigh", "max"].includes(effort)) throw new Error("NOMA_CLOUD_LLM_EFFORT must be low, medium, high, xhigh, or max");
  return new AnthropicMessagesProvider({
    apiKey,
    model: env.NOMA_CLOUD_LLM_MODEL?.trim() || DEFAULT_ANTHROPIC_MODEL,
    ...(env.ANTHROPIC_BASE_URL?.trim() ? { baseUrl: env.ANTHROPIC_BASE_URL.trim() } : {}),
    timeoutMs: positiveEnvInteger(env.NOMA_CLOUD_LLM_TIMEOUT_MS, 120_000),
    maxRetries: Math.min(5, positiveEnvInteger(env.NOMA_CLOUD_LLM_MAX_RETRIES, 2, true)),
    zeroRetention: /^(?:1|true|yes)$/i.test(env.NOMA_CLOUD_LLM_ZERO_RETENTION?.trim() ?? ""),
    fallbacks: !/^(?:0|false|no|off)$/i.test(env.NOMA_CLOUD_LLM_FALLBACKS?.trim() ?? ""),
    ...(effort ? { effort: effort as AnthropicProviderOptions["effort"] } : {}),
  });
}

function positiveEnvInteger(value: string | undefined, fallback: number, allowZero = false): number {
  if (value === undefined || value.trim() === "") return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < (allowZero ? 0 : 1)) throw new Error(`Invalid integer setting: ${value}`);
  return parsed;
}
