/**
 * Code intelligence from the codixing server linked to a dev-loop repository: a pull request's blast
 * radius, code results in the command palette, and repository context for hosted agents. Everything
 * here is best-effort — a slow, missing, or misbehaving server yields nothing, never an error.
 */
import type { CloudProject, CloudUserRecord } from "../cloud-db.js";
import type { DevPullRequest, DevRepo } from "../cloud-devloop.js";
import { type CodixingSettings, type CodixingTarget, codixingCallers, codixingSearch, DEFAULT_CODIXING_SETTINGS, pullRequestFiles } from "./codixing.js";
import type { CloudServerConfig } from "./context.js";

const BLAST_MAX_FILES = 25;
const BLAST_CONCURRENCY = 5;
const BLAST_LIST_IMPACTED = 15;
const BLAST_LIST_TESTS = 10;
const FIND_MAX_REPOS = 5;
const FIND_TIMEOUT_MS = 1_500;
const AGENT_TOKEN_BUDGET = 1_500;
const AGENT_MAX_CHARS = 6_000;

const TEST_PATTERNS = [
  /(^|\/)(test|tests|__tests__|spec|specs)\//i,
  /\.(test|spec)\.[a-z0-9]+$/i,
  /_test\.(go|py|rb|exs?)$/i,
  /(^|\/)test_[^/]+\.py$/i,
  /_spec\.rb$/i,
  /(Test|Tests|IT)\.(java|kt|scala|cs)$/,
];

export interface CodeFindResult {
  repo: string;
  projectId: string;
  siteId: string;
  filePath: string;
  lineStart: number;
  lineEnd: number;
  signature: string;
  snippet: string;
  language: string;
  url: string;
}

export function codixingSettingsOf(config: CloudServerConfig): CodixingSettings {
  return config.codixing ?? DEFAULT_CODIXING_SETTINGS;
}

export function codixingTarget(repo: DevRepo | undefined): CodixingTarget | undefined {
  if (!repo?.codixingUrl) return undefined;
  return { url: repo.codixingUrl, ...(repo.codixingToken ? { token: repo.codixingToken } : {}) };
}

export function isTestPath(path: string): boolean {
  return TEST_PATTERNS.some((pattern) => pattern.test(path));
}

/**
 * The chat reply describing what a pull request head touches: changed files, files that depend on
 * them (codixing callers, depth 2), and likely affected tests. Reported once per head SHA; undefined
 * when already reported, not configured, or when GitHub or codixing could not answer.
 */
export async function blastRadiusReport(config: CloudServerConfig, repo: DevRepo, pull: DevPullRequest): Promise<string | undefined> {
  const target = codixingTarget(repo);
  if (!target || !pull.headSha || pull.state !== "open") return undefined;
  if (!config.devloop.claimBlastRadius(pull.projectId, pull.number, pull.headSha, config.now().toISOString())) return undefined;
  const settings = codixingSettingsOf(config);
  try {
    const changed = await pullRequestFiles(settings, repo.repo, pull.number);
    if (changed.length === 0) throw new Error("GitHub listed no changed files");
    const analysed = changed.slice(0, BLAST_MAX_FILES);
    const callers = await mapLimit(analysed, BLAST_CONCURRENCY, (file) => codixingCallers(target, settings, file, 2).catch(() => undefined));
    if (callers.every((files) => files === undefined)) throw new Error("codixing did not answer");
    const changedSet = new Set(changed);
    const impacted = [...new Set(callers.flatMap((files) => files ?? []))].filter((file) => !changedSet.has(file)).sort();
    const tests = [...new Set([...changed, ...impacted])].filter(isTestPath).sort();
    const lines = [
      `🧭 **Blast radius** of [#${pull.number}](${pull.url}) at \`${pull.headSha.slice(0, 7)}\`: ${plural(changed.length, "changed file")} → ${plural(impacted.length, "impacted file")}` +
        (analysed.length < changed.length ? ` (callers of the first ${analysed.length} changed files)` : ""),
      impacted.length ? `Impacted: ${codeList(impacted, BLAST_LIST_IMPACTED)}` : "No other indexed files depend on the changed files.",
      ...(tests.length ? [`Likely affected tests: ${codeList(tests, BLAST_LIST_TESTS)}`] : []),
    ];
    return lines.join("\n");
  } catch (error) {
    config.devloop.releaseBlastRadius(pull.projectId, pull.number, pull.headSha);
    console.warn(`noma cloud: blast radius for ${repo.repo}#${pull.number} skipped: ${error instanceof Error ? error.message : String(error)}`);
    return undefined;
  }
}

/**
 * Code hits for the command palette from every codixing-enabled repository linked to a project the
 * user can see. Undefined when no such repository exists (the palette then has no code group).
 */
export async function findCode(config: CloudServerConfig, user: CloudUserRecord, q: string, limit: number): Promise<CodeFindResult[] | undefined> {
  const projects = new Map(config.store.listProjects(user).map((project) => [project.id, project]));
  const repos = config.devloop.listCodixingRepos([...projects.keys()]).filter((repo) => projects.get(repo.projectId)?.siteId === repo.siteId);
  if (repos.length === 0) return undefined;
  const settings = codixingSettingsOf(config);
  const timeoutMs = Math.min(settings.timeoutMs, FIND_TIMEOUT_MS);
  const perRepo = await Promise.all(
    repos.slice(0, FIND_MAX_REPOS).map(async (repo) => {
      const target = codixingTarget(repo)!;
      const found = await codixingSearch(target, settings, { query: q, limit: Math.min(limit, 8), strategy: "instant" }, timeoutMs).catch(() => undefined);
      return (found?.results ?? []).map(
        (hit): CodeFindResult => ({
          repo: repo.repo,
          projectId: repo.projectId,
          siteId: repo.siteId,
          filePath: hit.filePath,
          lineStart: hit.lineStart,
          lineEnd: hit.lineEnd,
          signature: hit.signature,
          snippet: hit.content.slice(0, 300),
          language: hit.language,
          url: githubBlobUrl(repo, hit.filePath, hit.lineStart, hit.lineEnd),
        }),
      );
    }),
  );
  const merged: CodeFindResult[] = [];
  for (let index = 0; merged.length < limit && perRepo.some((hits) => index < hits.length); index++) {
    for (const hits of perRepo) if (hits[index] && merged.length < limit) merged.push(hits[index]!);
  }
  return merged;
}

/**
 * Repository code relevant to `query` from the project's codixing server, for an agent prompt.
 * The text is untrusted repository content; callers must wrap it as data.
 */
export async function agentCodeContext(config: CloudServerConfig, project: CloudProject, query: string): Promise<{ repo: string; text: string } | undefined> {
  const repo = config.devloop.readRepo(project.id);
  const target = codixingTarget(repo);
  const trimmed = query.replace(/\s+/g, " ").trim().slice(0, 500);
  if (!repo || !target || trimmed.length < 2) return undefined;
  const settings = codixingSettingsOf(config);
  const found = await codixingSearch(target, settings, { query: trimmed, limit: 6, strategy: "fast", tokenBudget: AGENT_TOKEN_BUDGET }).catch(() => undefined);
  if (!found) return undefined;
  const text = found.formattedContext ?? found.results.map((hit) => `// ${hit.filePath}:${hit.lineStart}-${hit.lineEnd}${hit.signature ? ` ${hit.signature}` : ""}\n${hit.content}`).join("\n\n");
  return text.trim() ? { repo: repo.repo, text: text.slice(0, AGENT_MAX_CHARS) } : undefined;
}

function githubBlobUrl(repo: DevRepo, path: string, start: number, end: number): string {
  const encode = (value: string) => value.split("/").map(encodeURIComponent).join("/");
  return `https://github.com/${repo.repo}/blob/${encode(repo.defaultBranch)}/${encode(path)}#L${start}-L${end}`;
}

function codeList(items: string[], max: number): string {
  const shown = items.slice(0, max).map((item) => `\`${item.replace(/`/g, "ʼ")}\``);
  return shown.join(", ") + (items.length > max ? ` and ${items.length - max} more` : "");
}

function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

async function mapLimit<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]!);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}
