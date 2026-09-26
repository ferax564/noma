/**
 * Run environments for the dev loop: where `/deploy` previews and `/test` builds execute. The default
 * provider drives ezkeel's headless REST API (one app per preview branch or test run); tests inject
 * `FakeRunProvider`.
 */

export interface RunStartInput {
  appName: string;
  /** `https://github.com/owner/name.git` */
  repoUrl: string;
  ref: string;
  kind: "deploy" | "test";
}

export interface RunStartResult {
  /** Provider handle to poll; absent when the provider queued the run without an ID yet. */
  providerRef?: string;
  url?: string;
}

export interface RunStatusResult {
  status: "running" | "success" | "failed" | "canceled";
  providerRef?: string;
  url?: string;
  error?: string;
  /** Tail of the failing step's output. */
  log?: string;
}

export interface RunProvider {
  readonly name: string;
  start(input: RunStartInput): Promise<RunStartResult>;
  status(appName: string, providerRef: string | undefined): Promise<RunStatusResult>;
  /** Removes the app and its resources; missing apps are not an error. */
  teardown(appName: string): Promise<void>;
}

export interface EzkeelRunProviderOptions {
  /** ezkeel control plane, e.g. `https://app.ezkeel.com`. */
  url: string;
  /** `ezk_…` API key. */
  token: string;
  /** Apps domain used to build preview URLs when ezkeel does not return one. */
  appsDomain?: string;
  fetch?: typeof fetch;
  timeoutMs?: number;
}

/** Drives ezkeel: `POST /api/apps`, `POST /api/apps/{name}/deploy {ref}`, `GET /api/deploys/{id}`, `DELETE /api/apps/{name}`. */
export class EzkeelRunProvider implements RunProvider {
  readonly name = "ezkeel";
  private readonly base: string;
  private readonly fetcher: typeof fetch;

  constructor(private readonly options: EzkeelRunProviderOptions) {
    this.base = options.url.replace(/\/+$/, "");
    this.fetcher = options.fetch ?? fetch;
  }

  async start(input: RunStartInput): Promise<RunStartResult> {
    const created = await this.call("POST", "/api/apps", { name: input.appName, repo_url: input.repoUrl });
    if (created.status !== 201 && created.status !== 409) throw new Error(`ezkeel refused the app: ${errorText(created)}`);
    const appUrl = stringField(record(created.body.app), "url") ?? this.appUrl(input.appName);
    let deployed: Awaited<ReturnType<EzkeelRunProvider["call"]>>;
    try {
      deployed = await this.call("POST", `/api/apps/${encodeURIComponent(input.appName)}/deploy`, { ref: input.ref });
      if (deployed.status !== 202) throw new Error(`ezkeel refused the deploy: ${errorText(deployed)}`);
    } catch (error) {
      if (created.status === 201) await this.teardown(input.appName).catch(() => undefined);
      throw error;
    }
    const deployId = stringField(deployed.body, "deploy_id");
    return { ...(deployId ? { providerRef: deployId } : {}), ...(appUrl ? { url: appUrl } : {}) };
  }

  async status(appName: string, providerRef: string | undefined): Promise<RunStatusResult> {
    const deployId = providerRef ?? (await this.latestDeployId(appName));
    if (!deployId) return { status: "running" };
    const response = await this.call("GET", `/api/deploys/${encodeURIComponent(deployId)}`);
    if (response.status !== 200) throw new Error(`ezkeel deploy lookup failed: ${errorText(response)}`);
    const deploy = record(response.body.deploy);
    const state = stringField(deploy, "status");
    const steps = Array.isArray(response.body.steps) ? response.body.steps.map(record) : [];
    if (state === "success") return { status: "success", providerRef: deployId };
    if (state === "canceled") return { status: "canceled", providerRef: deployId };
    if (state === "failed") {
      const failed = steps.find((step) => stringField(step, "status") === "failed");
      const log = [stringField(failed ?? {}, "output"), stringField(failed ?? {}, "error")].filter(Boolean).join("\n");
      return {
        status: "failed",
        providerRef: deployId,
        error: stringField(deploy, "error") ?? (failed ? `${stringField(failed, "step_name") ?? "step"} failed` : "Deploy failed"),
        ...(log ? { log: tail(log, 40) } : {}),
      };
    }
    return { status: "running", providerRef: deployId };
  }

  async teardown(appName: string): Promise<void> {
    const response = await this.call("DELETE", `/api/apps/${encodeURIComponent(appName)}?purge=1`);
    if (response.status >= 400 && response.status !== 404) throw new Error(`ezkeel teardown failed: ${errorText(response)}`);
  }

  private appUrl(appName: string): string | undefined {
    return this.options.appsDomain ? `https://${appName}.${this.options.appsDomain}` : undefined;
  }

  private async latestDeployId(appName: string): Promise<string | undefined> {
    const response = await this.call("GET", `/api/apps/${encodeURIComponent(appName)}/deploys?limit=1`);
    if (response.status !== 200 || !Array.isArray(response.body.deploys)) return undefined;
    return stringField(record(response.body.deploys[0]), "id");
  }

  private async call(method: string, path: string, body?: unknown): Promise<{ status: number; body: Record<string, unknown> }> {
    const response = await this.fetcher(`${this.base}${path}`, {
      method,
      headers: { authorization: `Bearer ${this.options.token}`, accept: "application/json", ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(this.options.timeoutMs ?? 15_000),
    });
    const text = await response.text();
    let parsed: unknown = {};
    try {
      parsed = text ? JSON.parse(text) : {};
    } catch {
      parsed = { error: text.slice(0, 200) };
    }
    return { status: response.status, body: record(parsed) };
  }
}

/** Scripted provider for tests: runs stay `running` until `finish()` settles them. */
export class FakeRunProvider implements RunProvider {
  readonly name = "fake";
  readonly started: RunStartInput[] = [];
  readonly tornDown: string[] = [];
  private readonly outcomes = new Map<string, RunStatusResult>();
  private counter = 0;
  failStart?: string;

  async start(input: RunStartInput): Promise<RunStartResult> {
    if (this.failStart) throw new Error(this.failStart);
    this.started.push(input);
    this.counter += 1;
    return { providerRef: `fake-${this.counter}`, url: `https://${input.appName}.apps.test` };
  }

  async status(appName: string): Promise<RunStatusResult> {
    return this.outcomes.get(appName) ?? { status: "running" };
  }

  async teardown(appName: string): Promise<void> {
    this.tornDown.push(appName);
  }

  finish(appName: string, outcome: RunStatusResult): void {
    this.outcomes.set(appName, outcome);
  }
}

/** Builds the ezkeel provider from `NOMA_CLOUD_EZKEEL_URL` / `NOMA_CLOUD_EZKEEL_TOKEN` (or `_FILE`) / `NOMA_CLOUD_EZKEEL_APPS_DOMAIN`. */
export function createRunProviderFromEnv(env: NodeJS.ProcessEnv, readSecretFile: (path: string) => string): RunProvider | undefined {
  const url = env.NOMA_CLOUD_EZKEEL_URL?.trim();
  const token = env.NOMA_CLOUD_EZKEEL_TOKEN?.trim() || (env.NOMA_CLOUD_EZKEEL_TOKEN_FILE ? readSecretFile(env.NOMA_CLOUD_EZKEEL_TOKEN_FILE).trim() : "");
  if (!url || !token) return undefined;
  if (!/^https?:\/\//.test(url)) throw new Error("NOMA_CLOUD_EZKEEL_URL must be an http(s) URL");
  const appsDomain = env.NOMA_CLOUD_EZKEEL_APPS_DOMAIN?.trim();
  return new EzkeelRunProvider({ url, token, ...(appsDomain ? { appsDomain } : {}) });
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function stringField(value: Record<string, unknown>, key: string): string | undefined {
  const field = value[key];
  return typeof field === "string" && field ? field : undefined;
}

function errorText(response: { status: number; body: Record<string, unknown> }): string {
  return `${response.status} ${stringField(response.body, "error") ?? ""}`.trim();
}

function tail(text: string, lines: number): string {
  return text.split("\n").slice(-lines).join("\n").slice(-8_000);
}
