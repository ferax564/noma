import assert from "node:assert/strict";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { CloudSyncClient, exportSpace, runCloudCommand, stripSyncFrontmatter, syncSpace, withSyncFrontmatter } from "../src/cloud-git-sync.js";
import { createNomaCloudServer } from "../src/cloud-server.js";
import { parse } from "../src/parser.js";
import { validate } from "../src/validator.js";

interface JsonRequestOptions {
  method?: string;
  token?: string;
  body?: Record<string, unknown>;
  expectedStatus?: number;
}

interface CloudDocumentResponse {
  id: string;
  source: string;
  hash: string;
}

const handbookSource = `---
owner: ops
---
# Operations handbook

::decision{id="deployment-region" status="open"}
Production services run in Zurich.
::
`;

test("sync frontmatter round-trips page source byte for byte", () => {
  for (const source of [handbookSource, "# Plain page\n\nBody.\n", "No heading and no trailing newline"]) {
    const wrapped = withSyncFrontmatter(source, { id: "abcdefgh12", hash: "f".repeat(64), parentId: "parentid12", labels: ["how-to", "team:ops"] });
    const { meta, body } = stripSyncFrontmatter(wrapped);
    assert.equal(body, source);
    assert.deepEqual(meta, { cloudId: "abcdefgh12", cloudHash: "f".repeat(64), cloudParent: "parentid12", cloudLabels: ["how-to", "team:ops"] });
    assert.deepEqual(validate(parse(wrapped)).filter((item) => item.severity === "error"), []);
  }
});

test("a space round-trips through a directory: export, edit, push, pull, create, and conflicts", async () => {
  const harness = await startCloudServer();
  const repo = await mkdtemp(join(tmpdir(), "noma-git-sync-repo-"));
  try {
    const alice = await createCloudUser(harness.base, "Alice");
    const outsider = await createCloudUser(harness.base, "Mallory");
    const handbook = await json<CloudDocumentResponse>(`${harness.base}/api/documents`, { method: "POST", token: alice.token, body: { title: "Operations handbook", source: handbookSource } });
    const site = await json<{ id: string }>(`${harness.base}/api/sites`, { method: "POST", token: alice.token, body: { title: "Operations", documentIds: [handbook.id] } });
    const child = await json<CloudDocumentResponse>(`${harness.base}/api/sites/${site.id}/documents`, {
      method: "POST",
      token: alice.token,
      body: { title: "Deploy runbook", source: "# Deploy runbook\n\nDeploy every Tuesday.\n", parentId: handbook.id },
    });
    await json(`${harness.base}/api/documents/${child.id}/labels`, { method: "POST", token: alice.token, body: { label: "how-to" } });

    const manifest = await json<{ format: string; pages: Array<{ id: string; path: string; parentId?: string; labels: string[]; hash: string }> }>(`${harness.base}/api/sites/${site.id}/sync-manifest`, { token: alice.token });
    assert.equal(manifest.format, "noma-space-sync-v1");
    assert.deepEqual(manifest.pages.map((page) => [page.path, page.parentId ?? null, page.labels]), [
      ["operations-handbook.noma", null, []],
      ["operations-handbook/deploy-runbook.noma", handbook.id, ["how-to"]],
    ]);
    await json(`${harness.base}/api/sites/${site.id}/sync-manifest`, { token: outsider.token, expectedStatus: 403 });

    const client = new CloudSyncClient({ server: harness.base, token: alice.token });
    const exported = await exportSpace(client, { siteId: site.id, dir: repo });
    assert.equal(exported.actions.length, 2);
    const handbookPath = join(repo, "operations-handbook.noma");
    const childPath = join(repo, "operations-handbook", "deploy-runbook.noma");
    const exportedChild = readFileSync(childPath, "utf8");
    assert.match(exportedChild, new RegExp(`^---\\ncloudId: ${child.id}\\ncloudHash: ${child.hash}\\ncloudParent: ${handbook.id}\\ncloudLabels: \\["how-to"\\]\\n---\\n# Deploy runbook`));
    assert.equal(stripSyncFrontmatter(readFileSync(handbookPath, "utf8")).body, handbookSource);

    const unchanged = await syncSpace(client, { siteId: site.id, dir: repo });
    assert.ok(unchanged.actions.every((action) => action.kind === "unchanged"));

    writeFileSync(childPath, exportedChild.replace("Deploy every Tuesday.", "Deploy every Wednesday."), "utf8");
    mkdirSync(join(repo, "operations-handbook"), { recursive: true });
    writeFileSync(join(repo, "operations-handbook", "rollback.noma"), "# Rollback plan\n\nRoll back within ten minutes.\n", "utf8");
    const pushed = await syncSpace(client, { siteId: site.id, dir: repo });
    assert.deepEqual(pushed.actions.filter((action) => action.kind !== "unchanged").map((action) => [action.kind, action.path]), [
      ["pushed", "operations-handbook/deploy-runbook.noma"],
      ["created", "operations-handbook/rollback.noma"],
    ]);
    const serverChild = await json<CloudDocumentResponse>(`${harness.base}/api/documents/${child.id}`, { token: alice.token });
    assert.equal(serverChild.source, "# Deploy runbook\n\nDeploy every Wednesday.\n", "sync keys never reach the server");
    assert.equal(stripSyncFrontmatter(readFileSync(childPath, "utf8")).meta.cloudHash, serverChild.hash);
    const createdId = stripSyncFrontmatter(readFileSync(join(repo, "operations-handbook", "rollback.noma"), "utf8")).meta.cloudId;
    assert.equal(typeof createdId, "string");
    const tree = await json<{ pages: Array<{ id: string; children: Array<{ id: string }> }> }>(`${harness.base}/api/sites/${site.id}/tree`, { token: alice.token });
    assert.deepEqual(tree.pages[0]!.children.map((node) => node.id).sort(), [child.id, createdId].sort());

    await json(`${harness.base}/api/documents/${handbook.id}`, {
      method: "PUT",
      token: alice.token,
      body: { source: handbookSource.replace("Zurich", "Frankfurt"), expectedHash: handbook.hash },
    });
    const pulled = await syncSpace(client, { siteId: site.id, dir: repo, push: false });
    assert.deepEqual(pulled.actions.filter((action) => action.kind === "pulled").map((action) => action.path), ["operations-handbook.noma"]);
    assert.match(readFileSync(handbookPath, "utf8"), /Frankfurt/);

    const localEdit = readFileSync(handbookPath, "utf8").replace("Frankfurt", "Geneva");
    writeFileSync(handbookPath, localEdit, "utf8");
    const current = await json<CloudDocumentResponse>(`${harness.base}/api/documents/${handbook.id}`, { token: alice.token });
    await json(`${harness.base}/api/documents/${handbook.id}`, {
      method: "PUT",
      token: alice.token,
      body: { source: current.source.replace("Frankfurt", "Milan"), expectedHash: current.hash },
    });
    const dryRun = await syncSpace(client, { siteId: site.id, dir: repo, dryRun: true });
    assert.equal(dryRun.conflicts, 1);
    assert.equal(existsSync(`${handbookPath}.conflict`), false, "dry runs write nothing");

    const previousStderr = process.stderr.write.bind(process.stderr);
    process.stderr.write = (() => true) as typeof process.stderr.write;
    let exitCode: number;
    try {
      exitCode = await runCloudCommand(["sync", "--site", site.id, "--dir", repo, "--server", harness.base], { NOMA_CLOUD_TOKEN: alice.token });
    } finally {
      process.stderr.write = previousStderr;
    }
    assert.equal(exitCode, 1, "conflicts fail the command so CI notices");
    assert.match(readFileSync(`${handbookPath}.conflict`, "utf8"), /Milan/);
    assert.match(readFileSync(handbookPath, "utf8"), /Geneva/, "the local edit is kept");
    const serverAfter = await json<CloudDocumentResponse>(`${harness.base}/api/documents/${handbook.id}`, { token: alice.token });
    assert.match(serverAfter.source, /Milan/, "the server edit is not overwritten");

    const resolved = stripSyncFrontmatter(readFileSync(handbookPath, "utf8"));
    writeFileSync(handbookPath, withSyncFrontmatter(resolved.body, { id: handbook.id, hash: serverAfter.hash, labels: [] }), "utf8");
    const afterResolve = await syncSpace(client, { siteId: site.id, dir: repo });
    assert.deepEqual(afterResolve.actions.filter((action) => action.kind === "pushed").map((action) => action.path), ["operations-handbook.noma"]);
    assert.match((await json<CloudDocumentResponse>(`${harness.base}/api/documents/${handbook.id}`, { token: alice.token })).source, /Geneva/);

    await json(`${harness.base}/api/trash/document/${child.id}`, { method: "POST", token: alice.token });
    const missing = await syncSpace(client, { siteId: site.id, dir: repo });
    assert.deepEqual(missing.actions.filter((action) => action.kind === "remote_missing").map((action) => action.documentId), [child.id]);
  } finally {
    await rm(repo, { recursive: true, force: true });
    await harness.close();
  }
});

async function startCloudServer(): Promise<{ base: string; close: () => Promise<void> }> {
  const root = await mkdtemp(join(tmpdir(), "noma-git-sync-"));
  const publicDir = join(root, "public");
  await mkdir(publicDir, { recursive: true });
  await writeFile(join(publicDir, "index.html"), "<h1>Noma</h1>", "utf8");
  const server = createNomaCloudServer({
    dataDir: join(root, "data", "documents"),
    usersDir: join(root, "data", "users"),
    sitesDir: join(root, "data", "sites"),
    dbPath: join(root, "data", "noma-cloud.sqlite"),
    publicDir,
    maxBodyBytes: 100_000,
    rateLimitMaxRequests: 10_000,
    now: () => new Date("2026-06-06T12:00:00.000Z"),
    ai: { provider: null, maintenanceTickMs: 0 },
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  return {
    base: `http://127.0.0.1:${address.port}`,
    close: async () => {
      await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
      await rm(root, { recursive: true, force: true });
    },
  };
}

async function createCloudUser(base: string, name: string): Promise<{ id: string; token: string }> {
  return json<{ id: string; token: string }>(`${base}/api/users`, { method: "POST", body: { name } });
}

async function json<T = { error?: string }>(url: string, options: JsonRequestOptions = {}): Promise<T> {
  const headers = new Headers({ accept: "application/json" });
  if (options.token) headers.set("authorization", `Bearer ${options.token}`);
  if (options.body) headers.set("content-type", "application/json");
  const response = await fetch(url, { method: options.method ?? "GET", headers, body: options.body ? JSON.stringify(options.body) : undefined });
  if (options.expectedStatus !== undefined) {
    assert.equal(response.status, options.expectedStatus, await response.text());
    return {} as T;
  }
  if (!response.ok) assert.fail(`${response.status} ${await response.text()}`);
  return response.json() as Promise<T>;
}
