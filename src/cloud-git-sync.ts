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

export type SyncActionKind = "pulled" | "pushed" | "created" | "moved" | "converged" | "conflict" | "remote_missing" | "unchanged";

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
}

const syncKeys = ["cloudId", "cloudHash", "cloudParent", "cloudLabels"] as const;
const syncKeyPattern = /^(cloudId|cloudHash|cloudParent|cloudLabels):/;

class CloudApiError extends Error {
  constructor(readonly status: number, message: string, readonly body: Record<string, unknown>) {
    super(message);
  }
}

/** Minimal authenticated client for the Cloud endpoints the sync needs. */
export class CloudSyncClient {
  private readonly base: string;
  private readonly fetchImpl: typeof fetch;

  constructor(private readonly options: CloudSyncClientOptions) {
    this.base = options.server.replace(/\/+$/, "");
    this.fetchImpl = options.fetch ?? fetch;
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
export async function exportSpace(client: CloudSyncClient, options: { siteId: string; dir: string }): Promise<SyncReport> {
  const dir = resolve(options.dir);
  mkdirSync(dir, { recursive: true });
  const manifest = await client.manifest(options.siteId);
  const local = indexLocalFiles(dir);
  const actions: SyncAction[] = [];
  for (const page of manifest.pages) {
    const existing = local.byId.get(page.id);
    const document = await client.document(page.id);
    if (existing && existing.path !== page.path) rmSync(existing.absolutePath);
    writeManagedFile(dir, page, document.source, document.hash);
    actions.push({ kind: "pulled", path: page.path, documentId: page.id });
  }
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
  const manifest = await client.manifest(options.siteId);
  const local = indexLocalFiles(dir);
  const actions: SyncAction[] = [];
  const manifestIds = new Set(manifest.pages.map((page) => page.id));

  for (const page of manifest.pages) {
    const file = local.byId.get(page.id);
    if (!file) {
      if (!pull) continue;
      if (!dryRun) {
        const document = await client.document(page.id);
        writeManagedFile(dir, page, document.source, document.hash);
      }
      actions.push({ kind: "pulled", path: page.path, documentId: page.id });
      continue;
    }
    const base = typeof file.meta.cloudHash === "string" ? file.meta.cloudHash : "";
    const localHash = sha256(file.body);
    const localChanged = localHash !== base;
    const remoteChanged = page.hash !== base;
    if (!localChanged && !remoteChanged) {
      if (file.path !== page.path && pull) {
        if (!dryRun) moveManagedFile(dir, file, page);
        actions.push({ kind: "moved", path: page.path, documentId: page.id, detail: `from ${file.path}` });
      } else {
        actions.push({ kind: "unchanged", path: file.path, documentId: page.id });
      }
      continue;
    }
    if (localChanged && remoteChanged && localHash === page.hash) {
      if (!dryRun) {
        if (file.path !== page.path) rmSync(file.absolutePath);
        writeManagedFile(dir, page, file.body, page.hash);
      }
      actions.push({ kind: "converged", path: page.path, documentId: page.id });
      continue;
    }
    if (!localChanged && remoteChanged) {
      if (!pull) continue;
      if (!dryRun) {
        const document = await client.document(page.id);
        if (file.path !== page.path) rmSync(file.absolutePath);
        writeManagedFile(dir, page, document.source, document.hash);
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
        writeManagedFile(dir, { ...page, path: file.path }, file.body, updated.hash);
        actions.push({ kind: "pushed", path: file.path, documentId: page.id });
      } catch (error) {
        if (!(error instanceof CloudApiError) || error.status !== 409) throw error;
        actions.push(await recordConflict(client, dir, file, page, "server changed during push"));
      }
      continue;
    }
    actions.push(dryRun ? { kind: "conflict", path: file.path, documentId: page.id, detail: "changed locally and on the server" } : await recordConflict(client, dir, file, page, "changed locally and on the server"));
  }

  for (const file of local.files) {
    const cloudId = typeof file.meta.cloudId === "string" ? file.meta.cloudId : undefined;
    if (cloudId) {
      if (!manifestIds.has(cloudId)) actions.push({ kind: "remote_missing", path: file.path, documentId: cloudId, detail: "page was removed, trashed, or is no longer visible" });
      continue;
    }
    if (!push) continue;
    const parentId = typeof file.meta.cloudParent === "string" ? file.meta.cloudParent : parentFromDirectory(manifest.pages, file.path);
    if (dryRun) {
      actions.push({ kind: "created", path: file.path, detail: "new page" });
      continue;
    }
    const created = await client.createPage(options.siteId, file.body, parentId);
    writeFileSync(file.absolutePath, withSyncFrontmatter(file.body, { id: created.id, hash: created.hash, ...(parentId ? { parentId } : {}), labels: [] }), "utf8");
    actions.push({ kind: "created", path: file.path, documentId: created.id });
  }

  return { siteId: options.siteId, dir, dryRun, actions, conflicts: actions.filter((action) => action.kind === "conflict").length };
}

async function recordConflict(client: CloudSyncClient, dir: string, file: LocalFile, page: SyncManifestPage, reason: string): Promise<SyncAction> {
  const document = await client.document(page.id);
  const conflictPath = `${file.absolutePath}.conflict`;
  writeFileSync(conflictPath, withSyncFrontmatter(document.source, { id: page.id, hash: document.hash, ...(page.parentId ? { parentId: page.parentId } : {}), labels: page.labels }), "utf8");
  return { kind: "conflict", path: file.path, documentId: page.id, detail: `${reason}; server version written to ${relative(dir, conflictPath).split(sep).join("/")}` };
}

function writeManagedFile(dir: string, page: Pick<SyncManifestPage, "id" | "path" | "parentId" | "labels">, source: string, hash: string): void {
  const target = safeJoin(dir, page.path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, withSyncFrontmatter(source, { id: page.id, hash, ...(page.parentId ? { parentId: page.parentId } : {}), labels: page.labels }), "utf8");
}

function moveManagedFile(dir: string, file: LocalFile, page: SyncManifestPage): void {
  const target = safeJoin(dir, page.path);
  mkdirSync(dirname(target), { recursive: true });
  renameSync(file.absolutePath, target);
  writeManagedFile(dir, page, file.body, page.hash);
}

function safeJoin(dir: string, path: string): string {
  const target = resolve(dir, path);
  if (target !== dir && !target.startsWith(`${dir}${sep}`)) throw new Error(`Refusing to write outside the sync directory: ${path}`);
  if (!target.endsWith(".noma")) throw new Error(`Manifest path is not a .noma file: ${path}`);
  return target;
}

function parentFromDirectory(pages: SyncManifestPage[], path: string): string | undefined {
  const directory = path.includes("/") ? path.slice(0, path.lastIndexOf("/")) : "";
  if (!directory) return undefined;
  return pages.find((page) => page.path === `${directory}.noma`)?.id;
}

function indexLocalFiles(dir: string): { files: LocalFile[]; byId: Map<string, LocalFile> } {
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
        files.push({ absolutePath, path: relative(dir, absolutePath).split(sep).join("/"), content, meta, body });
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
  noma cloud export-space --site <id> --out <dir>      Write every page of the space to <dir>
  noma cloud sync --site <id> --dir <dir> [opts]       Two-way sync (pull, then push local edits)

Options:
  --server <url>        Cloud base URL (default: $NOMA_CLOUD_URL)
  --token <token>       Personal user token (default: $NOMA_CLOUD_TOKEN)
  --access-token <t>    Deployment gate token (default: $NOMA_CLOUD_ACCESS_TOKEN)
  --pull-only           Only write server changes to disk
  --push-only           Only send local changes to the server
  --dry-run             Report what would change without writing anything
  --json                Print the sync report as JSON on stdout

Conflicts (changed locally and on the server) are written as <file>.noma.conflict
and make the command exit with status 1.`;

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
  const siteId = flags.get("site");
  if (!server || !token || !siteId) {
    process.stderr.write("error: --site, --server (or NOMA_CLOUD_URL), and --token (or NOMA_CLOUD_TOKEN) are required\n");
    return 2;
  }
  const accessToken = flags.get("access-token") ?? env.NOMA_CLOUD_ACCESS_TOKEN;
  const client = new CloudSyncClient({ server, token, ...(accessToken ? { accessToken } : {}) });
  let report: SyncReport;
  if (command === "export-space") {
    const out = flags.get("out");
    if (!out) {
      process.stderr.write("error: export-space requires --out <dir>\n");
      return 2;
    }
    report = await exportSpace(client, { siteId, dir: out });
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
    report = await syncSpace(client, { siteId, dir, pull: !flags.has("push-only"), push: !flags.has("pull-only"), dryRun: flags.has("dry-run") });
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
