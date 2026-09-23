import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createNomaCloudServer, type NomaCloudServerOptions } from "../src/cloud-server.js";

export interface CloudUserResponse {
  id: string;
  name: string;
  token: string;
}

export interface CloudTestHarness {
  base: string;
  close: () => Promise<void>;
}

export interface JsonRequestOptions {
  method?: string;
  token?: string;
  share?: string;
  headers?: Record<string, string>;
  body?: unknown;
}

export async function startCloudServer(prefix: string, options: NomaCloudServerOptions = {}): Promise<CloudTestHarness> {
  const root = await mkdtemp(join(tmpdir(), prefix));
  const publicDir = join(root, "public");
  await mkdir(publicDir, { recursive: true });
  await writeFile(join(publicDir, "index.html"), "<h1>Noma</h1>", "utf8");
  const server = createNomaCloudServer({
    dataDir: join(root, "data", "documents"),
    usersDir: join(root, "data", "users"),
    sitesDir: join(root, "data", "sites"),
    dbPath: join(root, "data", "noma-cloud.sqlite"),
    publicDir,
    maxBodyBytes: 200_000,
    now: () => new Date("2026-06-06T12:00:00.000Z"),
    ...options,
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return {
    base: `http://127.0.0.1:${address.port}`,
    close: async () => {
      server.closeAllConnections();
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
      await rm(root, { recursive: true, force: true });
    },
  };
}

export async function createCloudUser(base: string, name: string): Promise<CloudUserResponse> {
  return json<CloudUserResponse>(`${base}/api/users`, { method: "POST", body: { name } });
}

/** JSON request that fails the test on a non-2xx response. */
export async function json<T = Record<string, unknown>>(url: string, options: JsonRequestOptions = {}): Promise<T> {
  const response = await request(url, options);
  if (!response.ok) assert.fail(`${options.method ?? "GET"} ${url}: ${response.status} ${await response.text()}`);
  return response.json() as Promise<T>;
}

/** JSON request that asserts the status and returns the parsed body. */
export async function jsonStatus<T = { error?: string; details?: Record<string, unknown> }>(
  url: string,
  status: number,
  options: JsonRequestOptions = {},
): Promise<T> {
  const response = await request(url, options);
  const text = await response.text();
  assert.equal(response.status, status, text);
  return (text ? JSON.parse(text) : {}) as T;
}

export async function request(url: string, options: JsonRequestOptions = {}): Promise<Response> {
  const headers = new Headers({ accept: "application/json" });
  for (const [name, value] of Object.entries(options.headers ?? {})) headers.set(name, value);
  if (options.token) headers.set("authorization", `Bearer ${options.token}`);
  if (options.share) headers.set("x-noma-share-token", options.share);
  let body: BodyInit | undefined;
  if (options.body instanceof Uint8Array) body = options.body;
  else if (options.body !== undefined) {
    headers.set("content-type", headers.get("content-type") ?? "application/json");
    body = JSON.stringify(options.body);
  }
  return fetch(url, { method: options.method ?? "GET", headers, body });
}
