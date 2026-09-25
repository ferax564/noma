/**
 * Embedding provider layer for Noma Cloud hybrid retrieval. The knowledge index always keeps the
 * deterministic 96-dimension local hash vector (synchronous, offline, no data leaves the process);
 * a configured remote provider adds real model embeddings that are computed asynchronously, cached
 * by `(provider id, model, sha256(text))`, and used for semantic scoring once available.
 * `createEmbeddingProviderFromEnv` returns the local provider unless a remote one is configured.
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { modelAllowedByPolicy } from "./cloud-llm.js";
import { sha256Hex } from "./hash.js";

export type EmbeddingInputType = "document" | "query";

export interface EmbeddingRequestOptions {
  /** Retrieval role of the texts; providers that support asymmetric embeddings (Voyage) use it. */
  inputType?: EmbeddingInputType;
  /** Overall deadline for this call across batches and retries. */
  timeoutMs?: number;
}

export interface EmbeddingProvider {
  /** Stable provider id (`local-hash`, `openai`, `voyage`, `fake`); part of the cache key. */
  readonly id: string;
  readonly model: string;
  /** Declared vector length; `undefined` when the model's length is only known from responses. */
  readonly dimensions?: number;
  /** `true` when `embed` sends text off this process, so enterprise model policy applies. */
  readonly remote: boolean;
  /** Operator attestation that the provider account runs under zero data retention. */
  readonly zeroRetention: boolean;
  /** Embeds every text, batching internally; the result has one vector per input, in order. */
  embed(texts: string[], options?: EmbeddingRequestOptions): Promise<number[][]>;
}

export type EmbeddingErrorCode = "timeout" | "rate_limited" | "server_error" | "bad_request" | "auth" | "network" | "invalid_response" | "dimension_mismatch";

export class EmbeddingError extends Error {
  constructor(readonly code: EmbeddingErrorCode, message: string, readonly status?: number) {
    super(message);
  }
}

/** Label used in `retrieval.semantic` for a provider, e.g. `voyage:voyage-3.5`. */
export function embeddingLabel(provider: Pick<EmbeddingProvider, "id" | "model">): string {
  return provider.id === LOCAL_HASH_PROVIDER_ID ? LOCAL_HASH_PROVIDER_ID : `${provider.id}:${provider.model}`;
}

/** Cache key for one text under one provider/model. */
export function embeddingTextHash(text: string): string {
  return sha256Hex(text);
}

/** Minimal slice of the workspace enterprise policy that governs model use. */
export interface EmbeddingPolicy {
  modelAllowlist: string[];
  requireZeroRetentionModels: boolean;
  updatedBy: string;
}

export type EmbeddingPolicyBlock = "model_not_allowed" | "zero_retention_required";

/**
 * Same gate the LLM layer applies (`modelAllowed` + zero retention): a remote embedding provider may
 * only receive workspace text when its model (or `id:model`) is allowlisted — an untouched default
 * policy allows the operator-configured model — and, when the policy demands it, when the provider is
 * attested zero-retention. Local providers are never blocked.
 */
export function embeddingPolicyBlock(policy: EmbeddingPolicy, provider: EmbeddingProvider): EmbeddingPolicyBlock | undefined {
  if (!provider.remote) return undefined;
  const allowed = modelAllowedByPolicy(policy, provider.model, provider.model) || policy.modelAllowlist.includes(`${provider.id}:${provider.model}`);
  if (!allowed) return "model_not_allowed";
  if (policy.requireZeroRetentionModels && !provider.zeroRetention) return "zero_retention_required";
  return undefined;
}

export const LOCAL_HASH_PROVIDER_ID = "local-hash";
export const LOCAL_HASH_DIMENSIONS = 96;

const retrievalStopWords = new Set(["a", "an", "and", "are", "as", "at", "be", "by", "do", "does", "for", "from", "how", "in", "is", "it", "of", "on", "or", "the", "to", "was", "were", "what", "when", "where", "which", "who", "why", "with"]);

/** Lower-cased word tokens (2+ chars) without retrieval stop words; shared by lexical scoring and hashing. */
export function retrievalTokens(value: string): string[] {
  return (value.normalize("NFKC").toLocaleLowerCase().match(/[\p{L}\p{N}_-]{2,}/gu) ?? []).filter((token) => !retrievalStopWords.has(token));
}

/** The deterministic 96-dimension signed feature-hash vector over word tokens and character trigrams. */
export function localHashEmbedding(value: string): number[] {
  const vector = Array.from({ length: LOCAL_HASH_DIMENSIONS }, () => 0);
  const normalized = ` ${value.normalize("NFKC").toLocaleLowerCase()} `;
  const features = [...retrievalTokens(normalized), ...Array.from({ length: Math.max(0, normalized.length - 2) }, (_, index) => normalized.slice(index, index + 3))];
  for (const feature of features) {
    const hash = sha256Hex(feature);
    const index = Number.parseInt(hash.slice(0, 8), 16) % LOCAL_HASH_DIMENSIONS;
    const sign = Number.parseInt(hash.slice(8, 10), 16) % 2 === 0 ? 1 : -1;
    vector[index] = vector[index]! + sign;
  }
  const magnitude = Math.sqrt(vector.reduce((sum, item) => sum + item * item, 0)) || 1;
  return vector.map((item) => Math.round((item / magnitude) * 1_000_000) / 1_000_000);
}

/**
 * Cosine similarity clamped to `[0, 1]`. Vectors of different lengths come from different embedding
 * spaces and are never compared: the result is 0.
 */
export function cosineSimilarity(left: ArrayLike<number>, right: ArrayLike<number>): number {
  if (left.length !== right.length || left.length === 0) return 0;
  let dot = 0;
  let leftMagnitude = 0;
  let rightMagnitude = 0;
  for (let index = 0; index < left.length; index++) {
    const l = left[index]!;
    const r = right[index]!;
    dot += l * r;
    leftMagnitude += l * l;
    rightMagnitude += r * r;
  }
  if (leftMagnitude === 0 || rightMagnitude === 0) return 0;
  return Math.max(0, dot / Math.sqrt(leftMagnitude * rightMagnitude));
}

/** Default provider: the local hash vector. Deterministic, synchronous under the hood, never remote. */
export class LocalHashEmbeddingProvider implements EmbeddingProvider {
  readonly id = LOCAL_HASH_PROVIDER_ID;
  readonly model = "hash-96";
  readonly dimensions = LOCAL_HASH_DIMENSIONS;
  readonly remote = false;
  readonly zeroRetention = true;

  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((text) => localHashEmbedding(text));
  }
}

interface HttpEmbeddingOptions {
  apiKey?: string;
  model: string;
  url: string;
  dimensions?: number;
  /** Send `dimensions`/`output_dimension` in the request (only for models that support shortening). */
  requestDimensions?: boolean;
  timeoutMs?: number;
  maxRetries?: number;
  maxBatchSize?: number;
  maxInputChars?: number;
  zeroRetention?: boolean;
  fetch?: typeof fetch;
  sleep?: (ms: number) => Promise<void>;
}

export type OpenAiEmbeddingProviderOptions = Omit<HttpEmbeddingOptions, "url" | "model"> & {
  model?: string;
  /** Base URL (`https://api.openai.com`, `http://localhost:11434`, `https://gw/v1`) or the full `/embeddings` endpoint. */
  baseUrl?: string;
};

export type VoyageEmbeddingProviderOptions = Omit<HttpEmbeddingOptions, "url" | "model"> & {
  model?: string;
  baseUrl?: string;
};

export const DEFAULT_OPENAI_EMBEDDING_MODEL = "text-embedding-3-small";
export const DEFAULT_VOYAGE_EMBEDDING_MODEL = "voyage-3.5";

const knownDimensions: Array<[RegExp, number]> = [
  [/^text-embedding-3-small$/, 1536],
  [/^text-embedding-3-large$/, 3072],
  [/^text-embedding-ada-002$/, 1536],
  [/^voyage-3\.5-lite$/, 1024],
  [/^voyage-(3\.5|3-large|code-3|context-3)$/, 1024],
];

function defaultDimensions(model: string): number | undefined {
  return knownDimensions.find(([pattern]) => pattern.test(model))?.[1];
}

interface EmbeddingResponseBody {
  data?: unknown;
}

/**
 * Shared transport for `/v1/embeddings`-shaped APIs: batches of at most `maxBatchSize` inputs, a
 * per-attempt timeout bounded by the call deadline, retries on 408/409/429/5xx and network errors
 * honouring `retry-after`, and a strict response check (one vector per input, one length throughout,
 * matching the declared dimensions).
 */
abstract class HttpEmbeddingProvider implements EmbeddingProvider {
  abstract readonly id: string;
  readonly model: string;
  readonly dimensions?: number;
  readonly remote = true;
  readonly zeroRetention: boolean;
  protected readonly apiKey?: string;
  protected readonly requestDimensions: boolean;
  private readonly url: string;
  private readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly maxBatchSize: number;
  private readonly maxInputChars: number;
  private readonly fetchImpl: typeof fetch;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(options: HttpEmbeddingOptions, defaultBatchSize: number) {
    this.model = options.model;
    const dimensions = options.dimensions ?? defaultDimensions(options.model);
    if (dimensions !== undefined) this.dimensions = dimensions;
    this.zeroRetention = options.zeroRetention === true;
    if (options.apiKey) this.apiKey = options.apiKey;
    this.requestDimensions = options.requestDimensions === true && options.dimensions !== undefined;
    this.url = options.url;
    this.timeoutMs = options.timeoutMs ?? 30_000;
    this.maxRetries = options.maxRetries ?? 2;
    this.maxBatchSize = Math.max(1, options.maxBatchSize ?? defaultBatchSize);
    this.maxInputChars = Math.max(1, options.maxInputChars ?? 12_000);
    this.fetchImpl = options.fetch ?? fetch;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  protected abstract requestBody(input: string[], inputType: EmbeddingInputType | undefined): Record<string, unknown>;

  protected headers(): Record<string, string> {
    return { "content-type": "application/json", ...(this.apiKey ? { authorization: `Bearer ${this.apiKey}` } : {}) };
  }

  async embed(texts: string[], options: EmbeddingRequestOptions = {}): Promise<number[][]> {
    const deadline = options.timeoutMs === undefined ? undefined : Date.now() + options.timeoutMs;
    const vectors: number[][] = [];
    for (let start = 0; start < texts.length; start += this.maxBatchSize) {
      const batch = texts.slice(start, start + this.maxBatchSize).map((text) => (text.length > this.maxInputChars ? text.slice(0, this.maxInputChars) : text) || " ");
      vectors.push(...(await this.embedBatch(batch, options.inputType, deadline)));
    }
    const length = vectors[0]?.length;
    if (vectors.some((vector) => vector.length !== length)) throw new EmbeddingError("dimension_mismatch", "Embedding API returned vectors of different lengths");
    return vectors;
  }

  private async embedBatch(input: string[], inputType: EmbeddingInputType | undefined, deadline: number | undefined): Promise<number[][]> {
    const body = JSON.stringify(this.requestBody(input, inputType));
    let lastError: EmbeddingError | undefined;
    for (let attempt = 0; attempt <= this.maxRetries; attempt++) {
      const remaining = deadline === undefined ? this.timeoutMs : Math.min(this.timeoutMs, deadline - Date.now());
      if (remaining <= 0) throw lastError ?? new EmbeddingError("timeout", "Embedding request deadline passed");
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), remaining);
      let status = 0;
      let retryAfter: string | null = null;
      let text: string;
      try {
        const response = await this.fetchImpl(this.url, { method: "POST", headers: this.headers(), body, signal: controller.signal });
        status = response.status;
        retryAfter = response.headers.get("retry-after");
        text = await response.text();
      } catch (error) {
        clearTimeout(timer);
        lastError = controller.signal.aborted
          ? new EmbeddingError("timeout", `Embedding request timed out after ${remaining}ms`)
          : new EmbeddingError("network", error instanceof Error ? error.message : "Embedding request failed");
        if (attempt < this.maxRetries) await this.backoff(backoffMs(attempt), deadline);
        continue;
      }
      clearTimeout(timer);
      if (status >= 200 && status < 300) return this.parse(text, input.length);
      lastError = httpError(status, text);
      if (!retryableStatus(status) || attempt >= this.maxRetries) break;
      await this.backoff(retryAfterMs(retryAfter) ?? backoffMs(attempt), deadline);
    }
    throw lastError ?? new EmbeddingError("network", "Embedding request failed");
  }

  private async backoff(ms: number, deadline: number | undefined): Promise<void> {
    await this.sleep(deadline === undefined ? ms : Math.max(0, Math.min(ms, deadline - Date.now())));
  }

  private parse(text: string, expected: number): number[][] {
    let parsed: EmbeddingResponseBody;
    try {
      parsed = JSON.parse(text) as EmbeddingResponseBody;
    } catch {
      throw new EmbeddingError("invalid_response", "Embedding API returned invalid JSON");
    }
    const data = Array.isArray(parsed.data) ? parsed.data : [];
    const vectors: Array<number[] | undefined> = Array.from({ length: expected }, () => undefined);
    data.forEach((item: unknown, position) => {
      if (!item || typeof item !== "object") return;
      const { embedding, index } = item as { embedding?: unknown; index?: unknown };
      const slot = typeof index === "number" && Number.isSafeInteger(index) ? index : position;
      if (slot < 0 || slot >= expected || !Array.isArray(embedding)) return;
      if (!embedding.every((value) => typeof value === "number" && Number.isFinite(value))) return;
      vectors[slot] = embedding as number[];
    });
    if (vectors.some((vector) => vector === undefined)) throw new EmbeddingError("invalid_response", `Embedding API returned ${data.length} vectors for ${expected} inputs`);
    const complete = vectors as number[][];
    const length = complete[0]?.length ?? 0;
    if (length === 0 || complete.some((vector) => vector.length !== length)) throw new EmbeddingError("dimension_mismatch", "Embedding API returned vectors of different lengths");
    if (this.dimensions !== undefined && length !== this.dimensions) {
      throw new EmbeddingError("dimension_mismatch", `Embedding API returned ${length}-dimension vectors; ${this.model} is configured for ${this.dimensions}`);
    }
    return complete;
  }
}

/** OpenAI-compatible `/v1/embeddings` (OpenAI, OpenAI-compatible gateways, Ollama, local servers). */
export class OpenAiCompatibleEmbeddingProvider extends HttpEmbeddingProvider {
  readonly id = "openai";

  constructor(options: OpenAiEmbeddingProviderOptions = {}) {
    super({ ...options, model: options.model ?? DEFAULT_OPENAI_EMBEDDING_MODEL, url: embeddingsEndpoint(options.baseUrl ?? "https://api.openai.com") }, 256);
  }

  protected requestBody(input: string[]): Record<string, unknown> {
    return { model: this.model, input, encoding_format: "float", ...(this.requestDimensions ? { dimensions: this.dimensions } : {}) };
  }
}

/** Voyage AI embeddings (`https://api.voyageai.com/v1/embeddings`) with `input_type` document/query. */
export class VoyageEmbeddingProvider extends HttpEmbeddingProvider {
  readonly id = "voyage";

  constructor(options: VoyageEmbeddingProviderOptions = {}) {
    super({ ...options, model: options.model ?? DEFAULT_VOYAGE_EMBEDDING_MODEL, url: embeddingsEndpoint(options.baseUrl ?? "https://api.voyageai.com") }, 128);
  }

  protected requestBody(input: string[], inputType: EmbeddingInputType | undefined): Record<string, unknown> {
    return {
      model: this.model,
      input,
      truncation: true,
      ...(inputType ? { input_type: inputType } : {}),
      ...(this.requestDimensions ? { output_dimension: this.dimensions } : {}),
    };
  }
}

/** Resolves a base URL to its embeddings endpoint: `…/embeddings` as given, `…/v1` + `/embeddings`, else `/v1/embeddings`. */
export function embeddingsEndpoint(baseUrl: string): string {
  const trimmed = baseUrl.trim().replace(/\/+$/, "");
  if (/\/embeddings$/.test(trimmed)) return trimmed;
  if (/\/v\d+$/.test(trimmed)) return `${trimmed}/embeddings`;
  return `${trimmed}/v1/embeddings`;
}

export type FakeEmbeddingHandler = (text: string, inputType: EmbeddingInputType | undefined) => number[];

export interface FakeEmbeddingProviderOptions {
  id?: string;
  model?: string;
  dimensions?: number;
  remote?: boolean;
  zeroRetention?: boolean;
  /** Makes every call reject, to exercise the lexical + hash fallback. */
  fail?: boolean;
}

/**
 * Deterministic in-process provider for tests and offline demos. It behaves like a remote provider
 * (policy gating applies) unless `remote: false`, records every call, and without a handler returns
 * a signed token-hash vector of `dimensions` length.
 */
export class FakeEmbeddingProvider implements EmbeddingProvider {
  readonly id: string;
  readonly model: string;
  readonly dimensions: number;
  readonly remote: boolean;
  readonly zeroRetention: boolean;
  readonly calls: Array<{ texts: string[]; inputType?: EmbeddingInputType }> = [];
  fail: boolean;

  constructor(private readonly handler?: FakeEmbeddingHandler, options: FakeEmbeddingProviderOptions = {}) {
    this.id = options.id ?? "fake";
    this.model = options.model ?? "fake-embedding";
    this.dimensions = options.dimensions ?? 16;
    this.remote = options.remote !== false;
    this.zeroRetention = options.zeroRetention !== false;
    this.fail = options.fail === true;
  }

  async embed(texts: string[], options: EmbeddingRequestOptions = {}): Promise<number[][]> {
    this.calls.push({ texts: [...texts], ...(options.inputType ? { inputType: options.inputType } : {}) });
    if (this.fail) throw new EmbeddingError("network", "Fake embedding provider is down");
    return texts.map((text) => {
      const vector = this.handler ? this.handler(text, options.inputType) : fakeHashVector(text, this.dimensions);
      if (vector.length !== this.dimensions) throw new EmbeddingError("dimension_mismatch", `Fake embedding returned ${vector.length} dimensions; expected ${this.dimensions}`);
      return vector;
    });
  }
}

function fakeHashVector(text: string, dimensions: number): number[] {
  const vector = Array.from({ length: dimensions }, () => 0);
  for (const token of retrievalTokens(text)) {
    const hash = sha256Hex(token);
    const index = Number.parseInt(hash.slice(0, 8), 16) % dimensions;
    vector[index] = vector[index]! + (Number.parseInt(hash.slice(8, 10), 16) % 2 === 0 ? 1 : -1);
  }
  return vector;
}

function httpError(status: number, body: string): EmbeddingError {
  let message = `Embedding API returned ${status}`;
  try {
    const parsed = JSON.parse(body) as { error?: { message?: unknown } | string; detail?: unknown };
    const detail = typeof parsed.error === "string" ? parsed.error : typeof parsed.error?.message === "string" ? parsed.error.message : typeof parsed.detail === "string" ? parsed.detail : undefined;
    if (detail) message = `${message}: ${detail.slice(0, 300)}`;
  } catch {
    // The status code alone is enough when the body is not JSON.
  }
  if (status === 401 || status === 403) return new EmbeddingError("auth", message, status);
  if (status === 429) return new EmbeddingError("rate_limited", message, status);
  if (status >= 500) return new EmbeddingError("server_error", message, status);
  return new EmbeddingError("bad_request", message, status);
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

/**
 * Provider from the environment: `NOMA_CLOUD_EMBEDDINGS=local|openai|voyage|fake` (default `local`),
 * `NOMA_CLOUD_EMBEDDINGS_MODEL`, `NOMA_CLOUD_EMBEDDINGS_URL`, `NOMA_CLOUD_EMBEDDINGS_API_KEY` (or
 * `NOMA_CLOUD_EMBEDDINGS_API_KEY_FILE`; Voyage also reads `VOYAGE_API_KEY`, OpenAI `OPENAI_API_KEY`),
 * `NOMA_CLOUD_EMBEDDINGS_DIMENSIONS`, `NOMA_CLOUD_EMBEDDINGS_TIMEOUT_MS`,
 * `NOMA_CLOUD_EMBEDDINGS_MAX_RETRIES`, `NOMA_CLOUD_EMBEDDINGS_BATCH_SIZE`, and
 * `NOMA_CLOUD_EMBEDDINGS_ZERO_RETENTION`.
 */
export function createEmbeddingProviderFromEnv(env: NodeJS.ProcessEnv = process.env): EmbeddingProvider {
  const kind = env.NOMA_CLOUD_EMBEDDINGS?.trim().toLowerCase() || "local";
  const model = env.NOMA_CLOUD_EMBEDDINGS_MODEL?.trim() || undefined;
  if (kind === "local" || kind === "local-hash" || kind === "none" || kind === "off") return new LocalHashEmbeddingProvider();
  const dimensions = optionalPositiveInteger(env.NOMA_CLOUD_EMBEDDINGS_DIMENSIONS, "NOMA_CLOUD_EMBEDDINGS_DIMENSIONS");
  if (kind === "fake") return new FakeEmbeddingProvider(undefined, { ...(model ? { model } : {}), ...(dimensions ? { dimensions } : {}) });
  const url = env.NOMA_CLOUD_EMBEDDINGS_URL?.trim() || undefined;
  const common = {
    ...(model ? { model } : {}),
    ...(url ? { baseUrl: url } : {}),
    ...(dimensions ? { dimensions, requestDimensions: true } : {}),
    timeoutMs: optionalPositiveInteger(env.NOMA_CLOUD_EMBEDDINGS_TIMEOUT_MS, "NOMA_CLOUD_EMBEDDINGS_TIMEOUT_MS") ?? 30_000,
    maxRetries: Math.min(5, optionalPositiveInteger(env.NOMA_CLOUD_EMBEDDINGS_MAX_RETRIES, "NOMA_CLOUD_EMBEDDINGS_MAX_RETRIES", true) ?? 2),
    ...(env.NOMA_CLOUD_EMBEDDINGS_BATCH_SIZE?.trim() ? { maxBatchSize: optionalPositiveInteger(env.NOMA_CLOUD_EMBEDDINGS_BATCH_SIZE, "NOMA_CLOUD_EMBEDDINGS_BATCH_SIZE")! } : {}),
    zeroRetention: /^(?:1|true|yes)$/i.test(env.NOMA_CLOUD_EMBEDDINGS_ZERO_RETENTION?.trim() ?? ""),
  };
  if (kind === "openai") {
    const apiKey = embeddingApiKey(env) ?? (env.OPENAI_API_KEY?.trim() || undefined);
    if (!apiKey && !url) throw new Error("NOMA_CLOUD_EMBEDDINGS=openai needs NOMA_CLOUD_EMBEDDINGS_API_KEY (or a keyless NOMA_CLOUD_EMBEDDINGS_URL such as Ollama)");
    return new OpenAiCompatibleEmbeddingProvider({ ...common, ...(apiKey ? { apiKey } : {}) });
  }
  if (kind === "voyage") {
    const apiKey = embeddingApiKey(env) ?? (env.VOYAGE_API_KEY?.trim() || undefined);
    if (!apiKey) throw new Error("NOMA_CLOUD_EMBEDDINGS=voyage needs NOMA_CLOUD_EMBEDDINGS_API_KEY or VOYAGE_API_KEY");
    return new VoyageEmbeddingProvider({ ...common, apiKey });
  }
  throw new Error(`Unsupported NOMA_CLOUD_EMBEDDINGS: ${kind} (use local, openai, or voyage)`);
}

function embeddingApiKey(env: NodeJS.ProcessEnv): string | undefined {
  const inline = env.NOMA_CLOUD_EMBEDDINGS_API_KEY?.trim();
  if (inline) return inline;
  const file = env.NOMA_CLOUD_EMBEDDINGS_API_KEY_FILE?.trim();
  if (!file) return undefined;
  const key = readFileSync(resolve(file), "utf8").trim();
  if (!key) throw new Error(`Embeddings API key file is empty: ${file}`);
  return key;
}

function optionalPositiveInteger(value: string | undefined, label: string, allowZero = false): number | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < (allowZero ? 0 : 1)) throw new Error(`${label} must be a ${allowZero ? "non-negative" : "positive"} integer`);
  return parsed;
}
