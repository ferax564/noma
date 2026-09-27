/**
 * Git-native spaces: map a Noma Cloud space to a directory of `.noma` files and sync both ways over the
 * Cloud HTTP API. Each file carries sync keys in its frontmatter (`cloudId`, `cloudHash`, `cloudParent`,
 * `cloudLabels`); `cloudHash` is the server revision the file was last synced with and is the base for
 * three-way decisions. Local edits are pushed with `expectedHash`, so a concurrent server edit is never
 * overwritten: both-sides changes are written next to the file as `<name>.noma.conflict`.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";

export interface CloudSyncClientOptions {
  server: string;
  token: string;
  accessToken?: string;
  fetch?: typeof fetch;
}

export interface SyncManifestPage {
  id: string;
  title: string;
  path: string;
  parentId?: string;
  labels: string[];
  hash: string;
  updatedAt: string;
}

export interface SyncManifest {
  format: string;
  site: { id: string; title: string; slug: string };
  pages: SyncManifestPage[];
}

export type SyncActionKind = "pulled" | "pushed" | "created" | "moved" | "converged" | "conflict" | "remote_missing" | "trashed" | "deleted" | "restored" | "unchanged";

export interface SyncAction {
  kind: SyncActionKind;
  path: string;
  documentId?: string;
  detail?: string;
}

export interface SyncReport {
  siteId: string;
  dir: string;
  dryRun: boolean;
  actions: SyncAction[];
  conflicts: number;
}

export interface SyncOptions {
  siteId: string;
  dir: string;
  pull?: boolean;
  push?: boolean;
  dryRun?: boolean;
  /**
   * Keep the sync keys in this JSON file instead of each page's frontmatter, so the directory holds
   * exactly the page sources (a clean Git checkout stays clean until the wiki actually changes a page).
   * The directory's layout is then Git's: a synced file keeps its path whatever the page is titled, and
   * only pages that have no local file yet are written at the server's path.
   */
  stateFile?: string;
}

/** Sync keys as stored per file in a `--state` sidecar, keyed by the file's path relative to the directory. */
export interface SyncStateFile {
  format: typeof syncStateFormat;
  siteId: string;
  files: Record<string, { cloudId: string; cloudHash: string; cloudParent?: string; cloudLabels?: string[]; conflictHash?: string }>;
}

const syncStateFormat = "noma-cloud-sync-state/1";

const syncKeys = ["cloudId", "cloudHash", "cloudParent", "cloudLabels"] as const;
const syncKeyPattern = /^(cloudId|cloudHash|cloudParent|cloudLabels):/;

class CloudApiError extends Error {
  constructor(readonly status: number, message: string, readonly body: Record<string, unknown>) {
    super(message);
  }
}

type SyncKeys = { id: string; hash: string; parentId?: string; labels: string[] };

/** Where a file's sync keys live: its own frontmatter (default) or a sidecar state file. */
interface SyncKeyStore {
  meta(path: string, frontmatter: LocalFile["meta"]): LocalFile["meta"];
  render(path: string, source: string, keys: SyncKeys): string;
  forget(path: string): void;
  /** Remembers the server revision a `.conflict` file was written from, so deleting that file resolves it. */
  conflict(path: string, serverHash: string): void;
  /** Synced pages whose file is gone from the directory (deleted or renamed since the last sync). */
  orphans(): Array<{ path: string; cloudId: string; cloudHash: string; cloudParent?: string }>;
  save(dir: string): void;
}

const frontmatterKeyStore: SyncKeyStore = {
  meta: (_path, frontmatter) => frontmatter,
  render: (_path, source, keys) => withSyncFrontmatter(source, keys),
  forget: () => undefined,
  conflict: () => undefined,
  orphans: () => [],
  save: () => undefined,
};

function sidecarKeyStore(stateFile: string, siteId: string, dir: string): SyncKeyStore {
  const path = resolve(stateFile);
  let state: SyncStateFile = { format: syncStateFormat, siteId, files: {} };
  if (existsSync(path)) {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as Partial<SyncStateFile>;
    if (parsed.format !== syncStateFormat || typeof parsed.files !== "object" || parsed.files === null) throw new Error(`${stateFile} is not a ${syncStateFormat} file`);
    if (parsed.siteId !== siteId) throw new Error(`${stateFile} belongs to space ${String(parsed.siteId)}, not ${siteId}`);
    state = { format: syncStateFormat, siteId, files: parsed.files };
  }
  return {
    meta: (file, frontmatter) => {
      if (typeof frontmatter.cloudId === "string") return frontmatter;
      const entry = state.files[file];
      if (!entry) return {};
      const { conflictHash, ...keys } = entry;
      const resolved = conflictHash && !existsSync(join(dir, `${file}.conflict`));
      return resolved ? { ...keys, cloudHash: conflictHash } : keys;
    },
    render: (file, source, keys) => {
      state.files[file] = { cloudId: keys.id, cloudHash: keys.hash, ...(keys.parentId ? { cloudParent: keys.parentId } : {}), ...(keys.labels.length > 0 ? { cloudLabels: keys.labels } : {}) };
      return source;
    },
    forget: (file) => {
      delete state.files[file];
    },
    conflict: (file, serverHash) => {
      const entry = state.files[file];
      if (entry) entry.conflictHash = serverHash;
    },
    orphans: () =>
      Object.entries(state.files)
        .filter(([file]) => !existsSync(join(dir, file)))
        .map(([path, entry]) => ({ path, cloudId: entry.cloudId, cloudHash: entry.cloudHash, ...(entry.cloudParent ? { cloudParent: entry.cloudParent } : {}) })),
    save: (dir) => {
      const files = Object.fromEntries(Object.entries(state.files).filter(([file]) => existsSync(join(dir, file))).sort(([a], [b]) => a.localeCompare(b)));
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, `${JSON.stringify({ ...state, files }, null, 2)}\n`, "utf8");
    },
  };
}

function keyStoreFor(options: { siteId: string; dir: string; stateFile?: string }): SyncKeyStore {
  return options.stateFile ? sidecarKeyStore(options.stateFile, options.siteId, resolve(options.dir)) : frontmatterKeyStore;
}

/** Minimal authenticated client for the Cloud endpoints the sync needs. */
export class CloudSyncClient {
  private readonly base: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: CloudSyncClientOptions) {
    this.base = options.server.replace(/\/+$/, "");
    this.fetchImpl = options.fetch ?? fetch;
  }

  sites(): Promise<{ sites: Array<{ id: string; title: string; key: string | null; archived?: boolean }> }> {
    return this.request("GET", "/api/sites");
  }

  createSite(title: string, key?: string): Promise<{ id: string; title: string; key: string | null }> {
    return this.request("POST", "/api/sites", { title, documentIds: [], ...(key ? { key } : {}) });
  }

  manifest(siteId: string): Promise<SyncManifest> {
    return this.request<SyncManifest>("GET", `/api/sites/${encodeURIComponent(siteId)}/sync-manifest`);
  }

  document(id: string): Promise<{ id: string; title: string; source: string; hash: string }> {
    return this.request("GET", `/api/documents/${encodeURIComponent(id)}`);
  }

  updateDocument(id: string, source: string, expectedHash: string): Promise<{ id: string; hash: string }> {
    return this.request("PUT", `/api/documents/${encodeURIComponent(id)}`, { source, expectedHash });
  }

  movePage(siteId: string, documentId: string, parentId: string | null): Promise<unknown> {
    return this.request("PUT", `/api/sites/${encodeURIComponent(siteId)}/documents/${encodeURIComponent(documentId)}/parent`, { parentId });
  }

  trashPage(documentId: string): Promise<unknown> {
    return this.request("POST", `/api/trash/document/${encodeURIComponent(documentId)}`);
  }

  /** `gone` when the page is trashed or deleted; `present` when it exists, or is only hidden from this token. */
  async pageState(documentId: string): Promise<"gone" | "present"> {
    try {
      await this.document(documentId);
      return "present";
    } catch (error) {
      if (error instanceof CloudApiError && (error.status === 404 || error.status === 410)) return "gone";
      if (error instanceof CloudApiError && error.status === 403) return "present";
      throw error;
    }
  }

  createPage(siteId: string, source: string, parentId?: string): Promise<{ id: string; hash: string; title: string }> {
    return this.request("POST", `/api/sites/${encodeURIComponent(siteId)}/documents`, { source, ...(parentId ? { parentId } : {}) });
  }

  private async request<T>(method: string, path: string, body?: Record<string, unknown>): Promise<T> {
    const headers: Record<string, string> = { accept: "application/json", authorization: `Bearer ${this.options.token}` };
    if (this.options.accessToken) headers["x-noma-cloud-access-token"] = this.options.accessToken;
    if (body) headers["content-type"] = "application/json";
    const response = await this.fetchImpl(`${this.base}${path}`, { method, headers, ...(body ? { body: JSON.stringify(body) } : {}) });
    const text = await response.text();
    let parsed: Record<string, unknown> = {};
    try {
      parsed = text ? (JSON.parse(text) as Record<string, unknown>) : {};
    } catch {
      parsed = { error: text.slice(0, 200) };
    }
    if (!response.ok) throw new CloudApiError(response.status, `${method} ${path} failed with ${response.status}: ${String(parsed.error ?? "")}`, parsed);
    return parsed as T;
  }
}

interface LocalFile {
  absolutePath: string;
  path: string;
  content: string;
  meta: Partial<Record<(typeof syncKeys)[number], string | string[]>>;
  body: string;
}

/** Writes every page of the space into `dir` (created if missing), replacing files it already manages. */
export async function exportSpace(client: CloudSyncClient, options: { siteId: string; dir: string; stateFile?: string }): Promise<SyncReport> {
  const dir = resolve(options.dir);
  mkdirSync(dir, { recursive: true });
  const keys = keyStoreFor(options);
  const manifest = await client.manifest(options.siteId);
  const local = indexLocalFiles(dir, keys);
  const actions: SyncAction[] = [];
  for (const manifestPage of manifest.pages) {
    const existing = local.byId.get(manifestPage.id);
    const page = existing && options.stateFile ? { ...manifestPage, path: existing.path } : manifestPage;
    const document = await client.document(page.id);
    if (existing && existing.path !== page.path) removeManagedFile(keys, existing);
    writeManagedFile(keys, dir, page, document.source, document.hash);
    actions.push({ kind: "pulled", path: page.path, documentId: page.id });
  }
  keys.save(dir);
  return { siteId: options.siteId, dir, dryRun: false, actions, conflicts: 0 };
}

export async function syncSpace(client: CloudSyncClient, options: SyncOptions): Promise<SyncReport> {
  const dir = resolve(options.dir);
  const pull = options.pull !== false;
  const push = options.push !== false;
  const dryRun = options.dryRun === true;
  if (!existsSync(dir)) {
    if (dryRun) throw new Error(`Directory does not exist: ${dir}`);
    mkdirSync(dir, { recursive: true });
  }
  const keys = keyStoreFor(options);
  const keepLocalPaths = Boolean(options.stateFile);
  const manifest = await client.manifest(options.siteId);
  const local = indexLocalFiles(dir, keys);
  const actions: SyncAction[] = [];
  const manifestIds = new Set(manifest.pages.map((page) => page.id));
  const settled = new Set<string>();
  const restorePaths = new Map<string, string>();
  if (keepLocalPaths) {
    await mirrorLocalRenamesAndDeletes(client, keys, manifest, local, { siteId: options.siteId, pull, push, dryRun }, actions, settled, restorePaths);
  }

  for (const manifestPage of manifest.pages) {
    if (settled.has(manifestPage.id)) continue;
    const file = local.byId.get(manifestPage.id);
    const page = file && keepLocalPaths ? { ...manifestPage, path: wikiMoveTarget(dir, file, manifestPage, local) ?? file.path } : manifestPage;
    if (!file) {
      if (!pull) continue;
      const restorePath = restorePaths.get(page.id);
      const target = restorePath ? { ...page, path: restorePath } : page;
      if (!dryRun) {
        const document = await client.document(page.id);
        writeManagedFile(keys, dir, target, document.source, document.hash);
      }
      actions.push(restorePath
        ? { kind: "restored", path: restorePath, documentId: page.id, detail: "deleted locally but changed on the server since the last sync; server version restored" }
        : { kind: "pulled", path: page.path, documentId: page.id });
      continue;
    }
    const base = typeof file.meta.cloudHash === "string" ? file.meta.cloudHash : "";
    const localHash = sha256(file.body);
    const localChanged = localHash !== base;
    const remoteChanged = page.hash !== base;
    if (!localChanged && !remoteChanged) {
      if (file.path !== page.path && pull) {
        if (!dryRun) moveManagedFile(keys, dir, file, page);
        actions.push({ kind: "moved", path: page.path, documentId: page.id, detail: `from ${file.path}` });
      } else {
        actions.push({ kind: "unchanged", path: file.path, documentId: page.id });
      }
      continue;
    }
    if (localChanged && remoteChanged && localHash === page.hash) {
      if (!dryRun) {
        if (file.path !== page.path) removeManagedFile(keys, file);
        writeManagedFile(keys, dir, page, file.body, page.hash);
      }
      actions.push({ kind: "converged", path: page.path, documentId: page.id });
      continue;
    }
    if (!localChanged && remoteChanged) {
      if (!pull) continue;
      if (!dryRun) {
        const document = await client.document(page.id);
        if (file.path !== page.path) removeManagedFile(keys, file);
        writeManagedFile(keys, dir, page, document.source, document.hash);
      }
      actions.push({ kind: "pulled", path: page.path, documentId: page.id });
      continue;
    }
    if (localChanged && !remoteChanged) {
      if (!push) continue;
      if (dryRun) {
        actions.push({ kind: "pushed", path: file.path, documentId: page.id });
        continue;
      }
      try {
        const updated = await client.updateDocument(page.id, file.body, base);
        writeManagedFile(keys, dir, { ...page, path: file.path }, file.body, updated.hash);
        actions.push({ kind: "pushed", path: file.path, documentId: page.id });
      } catch (error) {
        if (!(error instanceof CloudApiError) || error.status !== 409) throw error;
        actions.push(await recordConflict(client, keys, dir, file, page, "server changed during push"));
      }
      continue;
    }
    actions.push(dryRun ? { kind: "conflict", path: file.path, documentId: page.id, detail: "changed locally and on the server" } : await recordConflict(client, keys, dir, file, page, "changed locally and on the server"));
  }

  const createdByPath = new Map<string, string>();
  const parentFirst = [...local.files].sort((a, b) => a.path.split("/").length - b.path.split("/").length || a.path.localeCompare(b.path));
  for (const file of parentFirst) {
    const cloudId = typeof file.meta.cloudId === "string" ? file.meta.cloudId : undefined;
    if (cloudId) {
      if (manifestIds.has(cloudId)) continue;
      const unchangedLocally = typeof file.meta.cloudHash === "string" && sha256(file.body) === file.meta.cloudHash;
      if (keepLocalPaths && pull && unchangedLocally && (await client.pageState(cloudId)) === "gone") {
        if (!dryRun) removeManagedFile(keys, file);
        actions.push({ kind: "deleted", path: file.path, documentId: cloudId, detail: "trashed in the wiki" });
        continue;
      }
      actions.push({
        kind: "remote_missing",
        path: file.path,
        documentId: cloudId,
        detail: keepLocalPaths && unchangedLocally === false ? "page is gone from the space but the file changed locally; kept" : "page was removed, trashed, or is no longer visible",
      });
      continue;
    }
    if (!push) continue;
    const parentId = typeof file.meta.cloudParent === "string" ? file.meta.cloudParent : parentFromDirectory(manifest.pages, local.files, file.path, createdByPath);
    if (dryRun) {
      actions.push({ kind: "created", path: file.path, detail: "new page" });
      continue;
    }
    const created = await client.createPage(options.siteId, file.body, parentId);
    createdByPath.set(file.path, created.id);
    const content = keys.render(file.path, file.body, { id: created.id, hash: created.hash, ...(parentId ? { parentId } : {}), labels: [] });
    if (content !== file.content) writeFileSync(file.absolutePath, content, "utf8");
    actions.push({ kind: "created", path: file.path, documentId: created.id });
  }

  if (!dryRun) keys.save(dir);

  return { siteId: options.siteId, dir, dryRun, actions, conflicts: actions.filter((action) => action.kind === "conflict").length };
}

async function recordConflict(client: CloudSyncClient, keys: SyncKeyStore, dir: string, file: LocalFile, page: SyncManifestPage, reason: string): Promise<SyncAction> {
  const document = await client.document(page.id);
  const conflictPath = `${file.absolutePath}.conflict`;
  const conflictSource = keys === frontmatterKeyStore
    ? withSyncFrontmatter(document.source, { id: page.id, hash: document.hash, ...(page.parentId ? { parentId: page.parentId } : {}), labels: page.labels })
    : document.source;
  writeFileSync(conflictPath, conflictSource, "utf8");
  keys.conflict(file.path, document.hash);
  return { kind: "conflict", path: file.path, documentId: page.id, detail: `${reason}; server version written to ${relative(dir, conflictPath).split(sep).join("/")}` };
}

/**
 * `--state` mode: a synced file that disappeared was deleted or renamed in the directory. A new file
 * with exactly its last synced source is the same page under a new path (moved under the page of its
 * new directory); otherwise the page is trashed, unless the server changed it since the last sync, in
 * which case the server version is restored at the old path.
 */
async function mirrorLocalRenamesAndDeletes(
  client: CloudSyncClient,
  keys: SyncKeyStore,
  manifest: SyncManifest,
  local: { files: LocalFile[]; byId: Map<string, LocalFile> },
  options: { siteId: string; pull: boolean; push: boolean; dryRun: boolean },
  actions: SyncAction[],
  settled: Set<string>,
  restorePaths: Map<string, string>,
): Promise<void> {
  const pages = new Map(manifest.pages.map((page) => [page.id, page]));
  const unclaimed = local.files.filter((file) => typeof file.meta.cloudId !== "string");
  for (const orphan of keys.orphans()) {
    const page = pages.get(orphan.cloudId);
    if (!page) {
      if (!options.dryRun) keys.forget(orphan.path);
      continue;
    }
    if (local.byId.has(orphan.cloudId)) continue;
    const renamed = unclaimed.find((file) => sha256(file.body) === orphan.cloudHash);
    if (renamed) {
      unclaimed.splice(unclaimed.indexOf(renamed), 1);
      renamed.meta = { cloudId: orphan.cloudId, cloudHash: orphan.cloudHash, ...(orphan.cloudParent ? { cloudParent: orphan.cloudParent } : {}) };
      local.byId.set(orphan.cloudId, renamed);
      const parentId = parentFromDirectory(manifest.pages, local.files, renamed.path, new Map());
      if (options.push && (parentId ?? null) !== (page.parentId ?? null)) {
        if (!options.dryRun) await client.movePage(options.siteId, page.id, parentId ?? null);
        if (parentId) page.parentId = parentId;
        else delete page.parentId;
      }
      renamed.meta = { cloudId: orphan.cloudId, cloudHash: orphan.cloudHash, ...(page.parentId ? { cloudParent: page.parentId } : {}) };
      if (!options.dryRun) {
        keys.forget(orphan.path);
        keys.render(renamed.path, renamed.body, { id: page.id, hash: orphan.cloudHash, ...(page.parentId ? { parentId: page.parentId } : {}), labels: page.labels });
      }
      actions.push({ kind: "moved", path: renamed.path, documentId: page.id, detail: `renamed from ${orphan.path}` });
      continue;
    }
    if (page.hash !== orphan.cloudHash) {
      restorePaths.set(page.id, orphan.path);
      continue;
    }
    if (!options.push) continue;
    if (!options.dryRun) {
      await client.trashPage(page.id);
      keys.forget(orphan.path);
    }
    settled.add(page.id);
    actions.push({ kind: "trashed", path: orphan.path, documentId: page.id, detail: "deleted in the directory" });
  }
}

/**
 * `--state` mode: a page moved to another parent in the wiki moves its (locally unchanged) file into
 * the directory of the new parent's file, keeping its file name. Returns undefined when nothing moves.
 */
function wikiMoveTarget(dir: string, file: LocalFile, page: SyncManifestPage, local: { byId: Map<string, LocalFile> }): string | undefined {
  const knownParent = typeof file.meta.cloudParent === "string" ? file.meta.cloudParent : undefined;
  if ((page.parentId ?? undefined) === knownParent) return undefined;
  if (typeof file.meta.cloudHash !== "string" || sha256(file.body) !== file.meta.cloudHash) return undefined;
  const name = file.path.slice(file.path.lastIndexOf("/") + 1);
  let directory = "";
  if (page.parentId) {
    const parent = local.byId.get(page.parentId);
    if (!parent) return undefined;
    directory = `${parent.path.slice(0, -".noma".length)}/`;
  }
  const target = `${directory}${name}`;
  if (target === file.path || existsSync(join(dir, target))) return undefined;
  return target;
}

function writeManagedFile(keys: SyncKeyStore, dir: string, page: Pick<SyncManifestPage, "id" | "path" | "parentId" | "labels">, source: string, hash: string): void {
  const target = safeJoin(dir, page.path);
  mkdirSync(dirname(target), { recursive: true });
  const content = keys.render(page.path, source, { id: page.id, hash, ...(page.parentId ? { parentId: page.parentId } : {}), labels: page.labels });
  if (!existsSync(target) || readFileSync(target, "utf8") !== content) writeFileSync(target, content, "utf8");
}

function removeManagedFile(keys: SyncKeyStore, file: LocalFile): void {
  rmSync(file.absolutePath);
  keys.forget(file.path);
}

function moveManagedFile(keys: SyncKeyStore, dir: string, file: LocalFile, page: SyncManifestPage): void {
  const target = safeJoin(dir, page.path);
  mkdirSync(dirname(target), { recursive: true });
  renameSync(file.absolutePath, target);
  keys.forget(file.path);
  writeManagedFile(keys, dir, page, file.body, page.hash);
}

function safeJoin(dir: string, path: string): string {
  const target = resolve(dir, path);
  if (target !== dir && !target.startsWith(`${dir}${sep}`)) throw new Error(`Refusing to write outside the sync directory: ${path}`);
  if (!target.endsWith(".noma")) throw new Error(`Manifest path is not a .noma file: ${path}`);
  return target;
}

function parentFromDirectory(pages: SyncManifestPage[], files: LocalFile[], path: string, createdByPath: Map<string, string>): string | undefined {
  const directory = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
  if (!directory) return undefined;
  const parentPath = `${directory}.noma`;
  const localParent = files.find((file) => file.path === parentPath)?.meta.cloudId;
  if (typeof localParent === "string") return localParent;
  return createdByPath.get(parentPath) ?? pages.find((page) => page.path === parentPath)?.id;
}

function indexLocalFiles(dir: string, keys: SyncKeyStore): { files: LocalFile[]; byId: Map<string, LocalFile> } {
  const files: LocalFile[] = [];
  const walkDir = (current: string): void => {
    for (const entry of readdirSync(current)) {
      if (entry.startsWith(".") || entry === "node_modules") continue;
      const absolutePath = join(current, entry);
      const stats = statSync(absolutePath);
      if (stats.isDirectory()) walkDir(absolutePath);
      else if (stats.isFile() && entry.endsWith(".noma")) {
        const content = readFileSync(absolutePath, "utf8").replace(/\r\n?/g, "\n");
        const { meta, body } = stripSyncFrontmatter(content);
        const path = relative(dir, absolutePath).split(sep).join("/");
        files.push({ absolutePath, path, content, meta: keys.meta(path, meta), body });
      }
    }
  };
  walkDir(dir);
  const byId = new Map<string, LocalFile>();
  for (const file of files) {
    const id = file.meta.cloudId;
    if (typeof id !== "string") continue;
    if (byId.has(id)) throw new Error(`Two files claim cloudId ${id}: ${byId.get(id)!.path} and ${file.path}`);
    byId.set(id, file);
  }
  return { files, byId };
}

/** Adds the sync keys to the top of the page's frontmatter, creating one when the page has none. */
export function withSyncFrontmatter(source: string, sync: { id: string; hash: string; parentId?: string; labels: string[] }): string {
  const lines = [`cloudId: ${sync.id}`, `cloudHash: ${sync.hash}`];
  if (sync.parentId) lines.push(`cloudParent: ${sync.parentId}`);
  if (sync.labels.length > 0) lines.push(`cloudLabels: [${sync.labels.map((label) => JSON.stringify(label)).join(", ")}]`);
  const split = splitFrontmatter(source);
  if (!split) return `---\n${lines.join("\n")}\n---\n${source}`;
  return `---\n${[...lines, ...split.lines].join("\n")}\n---\n${split.body}`;
}

/** Inverse of `withSyncFrontmatter`: returns the page source exactly as stored on the server, plus the sync keys. */
export function stripSyncFrontmatter(content: string): { meta: LocalFile["meta"]; body: string } {
  const split = splitFrontmatter(content);
  if (!split) return { meta: {}, body: content };
  const meta: LocalFile["meta"] = {};
  const kept: string[] = [];
  for (const line of split.lines) {
    const match = syncKeyPattern.exec(line);
    if (!match) {
      kept.push(line);
      continue;
    }
    const key = match[1] as (typeof syncKeys)[number];
    const value = line.slice(match[0].length).trim();
    meta[key] = key === "cloudLabels" ? parseLabelList(value) : value.replace(/^["']|["']$/g, "");
  }
  if (Object.keys(meta).length === 0) return { meta, body: content };
  const body = kept.length === 0 ? split.body : `---\n${kept.join("\n")}\n---\n${split.body}`;
  return { meta, body };
}

function splitFrontmatter(source: string): { lines: string[]; body: string } | undefined {
  if (!source.startsWith("---\n")) return undefined;
  const end = source.indexOf("\n---", 3);
  if (end < 0) return undefined;
  const after = end + 4;
  if (after < source.length && source[after] !== "\n") return undefined;
  const inner = source.slice(4, end);
  return { lines: inner === "" ? [] : inner.split("\n"), body: source.slice(after < source.length ? after + 1 : after) };
}

function parseLabelList(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown;
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : [];
  } catch {
    return value.replace(/^\[|\]$/g, "").split(",").map((item) => item.trim()).filter(Boolean);
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

const cloudHelp = `noma cloud — sync a Noma Cloud space with a directory of .noma files

Usage:
  noma cloud spaces [--json]                           List the spaces you can see (id, key, title)
  noma cloud create-space --title <t> [--key <KEY>]    Create a space; with --key, reuse the one that has it
  noma cloud export-space --site <id> --out <dir>      Write every page of the space to <dir>
  noma cloud sync --site <id> --dir <dir> [opts]       Two-way sync (pull, then push local edits)

Options:
  --server <url>        Cloud base URL (default: $NOMA_CLOUD_URL)
  --token <token>       Personal user token (default: $NOMA_CLOUD_TOKEN)
  --access-token <t>    Deployment gate token (default: $NOMA_CLOUD_ACCESS_TOKEN)
  --pull-only           Only write server changes to disk
  --push-only           Only send local changes to the server
  --dry-run             Report what would change without writing anything
  --state <file>        Keep sync keys in this JSON file instead of page frontmatter,
                        so a Git checkout holds only the page sources (and keeps its
                        file names); delete a .conflict file to mark it resolved
  --json                Print the sync report as JSON on stdout

Conflicts (changed locally and on the server) are written as <file>.noma.conflict
and make the command exit with status 1.

A directory is a page tree: dir/guide.noma is the parent of every page in dir/guide/.`;

/** Entry point for `noma cloud …`; returns the process exit code. */
export async function runCloudCommand(argv: string[], env: NodeJS.ProcessEnv = process.env): Promise<number> {
  const [command, ...rest] = argv;
  if (!command || command === "--help" || command === "-h") {
    process.stdout.write(`${cloudHelp}\n`);
    return command ? 0 : 2;
  }
  const flags = parseFlags(rest);
  const server = flags.get("server") ?? env.NOMA_CLOUD_URL;
  const token = flags.get("token") ?? env.NOMA_CLOUD_TOKEN;
  if (!server || !token) {
    process.stderr.write("error: --server (or NOMA_CLOUD_URL) and --token (or NOMA_CLOUD_TOKEN) are required\n");
    return 2;
  }
  const accessToken = flags.get("access-token") ?? env.NOMA_CLOUD_ACCESS_TOKEN;
  const client = new CloudSyncClient({ server, token, ...(accessToken ? { accessToken } : {}) });
  if (command === "spaces") {
    const { sites } = await client.sites();
    if (flags.has("json")) process.stdout.write(`${JSON.stringify(sites.map(({ id, key, title }) => ({ id, key, title })), null, 2)}\n`);
    else for (const site of sites) process.stdout.write(`${site.id}\t${site.key ?? ""}\t${site.title}\n`);
    return 0;
  }
  if (command === "create-space") {
    const title = flags.get("title");
    if (!title) {
      process.stderr.write("error: create-space requires --title <title>\n");
      return 2;
    }
    const key = flags.get("key")?.trim().toUpperCase();
    if (key) {
      const existing = (await client.sites()).sites.find((site) => site.key === key);
      if (existing) {
        process.stdout.write(`${JSON.stringify({ id: existing.id, key: existing.key, title: existing.title, created: false })}\n`);
        return 0;
      }
    }
    const created = await client.createSite(title, key);
    process.stdout.write(`${JSON.stringify({ id: created.id, key: created.key, title: created.title, created: true })}\n`);
    return 0;
  }
  const siteId = flags.get("site");
  if (!siteId) {
    process.stderr.write("error: --site is required\n");
    return 2;
  }
  const stateFile = flags.get("state");
  let report: SyncReport;
  if (command === "export-space") {
    const out = flags.get("out");
    if (!out) {
      process.stderr.write("error: export-space requires --out <dir>\n");
      return 2;
    }
    report = await exportSpace(client, { siteId, dir: out, ...(stateFile ? { stateFile } : {}) });
  } else if (command === "sync") {
    const dir = flags.get("dir");
    if (!dir) {
      process.stderr.write("error: sync requires --dir <dir>\n");
      return 2;
    }
    if (flags.has("pull-only") && flags.has("push-only")) {
      process.stderr.write("error: --pull-only and --push-only are exclusive\n");
      return 2;
    }
    report = await syncSpace(client, { siteId, dir, pull: !flags.has("push-only"), push: !flags.has("pull-only"), dryRun: flags.has("dry-run"), ...(stateFile ? { stateFile } : {}) });
  } else {
    process.stderr.write(`error: unknown cloud command "${command}"\n\n${cloudHelp}\n`);
    return 2;
  }
  if (flags.has("json")) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  for (const action of report.actions) {
    if (action.kind === "unchanged") continue;
    process.stderr.write(`${action.kind.padEnd(14)} ${action.path}${action.detail ? `  (${action.detail})` : ""}\n`);
  }
  const changed = report.actions.filter((action) => action.kind !== "unchanged").length;
  process.stderr.write(`${report.dryRun ? "would apply" : "applied"} ${changed} change(s); ${report.conflicts} conflict(s)\n`);
  return report.conflicts > 0 ? 1 : 0;
}

function parseFlags(argv: string[]): Map<string, string> {
  const flags = new Map<string, string>();
  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index]!;
    if (!arg.startsWith("--")) throw new Error(`Unexpected argument: ${arg}`);
    const [name, inline] = arg.slice(2).split("=", 2) as [string, string | undefined];
    if (["pull-only", "push-only", "dry-run", "json"].includes(name)) {
      flags.set(name, "true");
      continue;
    }
    const value = inline ?? argv[++index];
    if (value === undefined) throw new Error(`--${name} requires a value`);
    flags.set(name, value);
  }
  return flags;
}
