import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import type { Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNomaCloudServer, type NomaCloudServerOptions } from "../src/cloud-server.js";

export interface CloudUserResponse {
  id: string;
  name: string;
  token: string;
}

export interface CloudDocumentResponse {
  id: string;
  title: string;
  source: string;
  hash: string;
}

export interface CloudSiteResponse {
  id: string;
  title: string;
  documentIds: string[];
}

export interface JsonRequestOptions {
  method?: string;
  token?: string;
  share?: string;
  headers?: Record<string, string>;
  body?: Record<string, unknown>;
  expectedStatus?: number;
}

export interface TestClock {
  now: () => Date;
  set(value: string): void;
  advance(ms: number): void;
}

export interface CloudTestHarness {
  base: string;
  root: string;
  server: Server;
  clock: TestClock;
  close: () => Promise<void>;
}

export function testClock(start = "2026-06-06T12:00:00.000Z"): TestClock {
  let current = Date.parse(start);
  return {
    now: () => new Date(current),
    set(value) {
      current = Date.parse(value);
    },
    advance(ms) {
      current += ms;
    },
  };
}

export async function startCloudServer(prefix: string, options: Partial<NomaCloudServerOptions> = {}): Promise<CloudTestHarness> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const publicDir = join(root, "public");
  await mkdir(publicDir, { recursive: true });
  await writeFile(join(publicDir, "index.html"), "<h1>Noma</h1>", "utf8");
  const clock = testClock();
  const server = createNomaCloudServer({
    dataDir: join(root, "data", "documents"),
    usersDir: join(root, "data", "users"),
    sitesDir: join(root, "data", "sites"),
    dbPath: join(root, "data", "noma-cloud.sqlite"),
    publicDir,
    maxBodyBytes: 100_000,
    rateLimitMaxRequests: 10_000,
    authRateLimitMaxRequests: 1_000,
    now: clock.now,
    ...options,
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return {
    base: `http://127.0.0.1:${address.port}`,
    root,
    server,
    clock,
    close: async () => {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
      await rm(root, { recursive: true, force: true });
    },
  };
}

export async function createCloudUser(base: string, name: string): Promise<CloudUserResponse> {
  return json<CloudUserResponse>(`${base}/api/users`, { method: "POST", body: { name } });
}

export async function request<T = Record<string, unknown>>(url: string, options: JsonRequestOptions = {}): Promise<{ status: number; body: T }> {
  const headers = new Headers({ accept: "application/json" });
  for (const [name, value] of Object.entries(options.headers ?? {})) headers.set(name, value);
  if (options.token) headers.set("authorization", `Bearer ${options.token}`);
  if (options.share) headers.set("x-noma-share-token", options.share);
  if (options.body) headers.set("content-type", "application/json");
  const response = await fetch(url, {
    method: options.method ?? "GET",
    headers,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const text = await response.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return { status: response.status, body: body as T };
}

export async function json<T = { error?: string }>(url: string, options: JsonRequestOptions = {}): Promise<T> {
  const response = await request<T>(url, options);
  if (options.expectedStatus !== undefined) {
    assert.equal(response.status, options.expectedStatus, JSON.stringify(response.body));
    return response.body;
  }
  if (response.status < 200 || response.status >= 300) assert.fail(`${response.status} ${JSON.stringify(response.body)}`);
  return response.body;
}

/** Creates a space owned by `token` with one page per source, in order. */
export async function createSpace(
  base: string,
  token: string,
  title: string,
  sources: string[],
  extra: Record<string, unknown> = {},
): Promise<{ site: CloudSiteResponse; pages: CloudDocumentResponse[] }> {
  const site = await json<CloudSiteResponse>(`${base}/api/sites`, { method: "POST", token, body: { title, documentIds: [], ...extra } });
  const pages: CloudDocumentResponse[] = [];
  for (const source of sources) {
    pages.push(await json<CloudDocumentResponse>(`${base}/api/sites/${site.id}/documents`, { method: "POST", token, body: { source } }));
  }
  return { site, pages };
}

export async function savePage(base: string, token: string, page: CloudDocumentResponse, source: string): Promise<CloudDocumentResponse> {
  return json<CloudDocumentResponse>(`${base}/api/documents/${page.id}`, { method: "PUT", token, body: { source, expectedHash: page.hash } });
}
