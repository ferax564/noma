/**
 * The dev loop: GitHub pull requests and CI results move Work issues and land in their chat threads;
 * `/deploy` and `/test` start runs on the run environment (ezkeel) and report back in the same thread.
 * A failing test run files a linked bug, so every signal ends up in source-backed Work and chat.
 */
import type { CloudIssue, CloudIssueStatus, CloudProject, CloudUserRecord } from "../cloud-db.js";
import type { DevPullRequest, DevRepo, DevRun, DevRunKind } from "../cloud-devloop.js";
import type { ChatChannel, ChatMessage } from "../cloud-chat.js";
import { type CloudServerConfig, randomId, recordActivity, recordIssueEvent, uniqueId } from "./context.js";
import { HttpError } from "./http.js";

/** Branch, tag, or SHA; never starts with `-` so it cannot read as a git option (mirrors ezkeel). */
const REF_RE = /^[A-Za-z0-9][A-Za-z0-9._/-]{0,199}$/;
const RUN_TIMEOUT_MS = 6 * 60 * 60 * 1000;
const CHAT_LIMIT = 8_000;

export interface RunRequest {
  project: CloudProject;
  repo: DevRepo;
  actor: CloudUserRecord;
  agentId?: string;
  kind: DevRunKind;
  ref?: string;
  issueId?: string;
  pullNumber?: number;
  channelId?: string;
  threadId?: string;
}

export function refInput(value: unknown, fallback: string): string {
  const ref = typeof value === "string" && value.trim() ? value.trim() : fallback;
  if (!REF_RE.test(ref) || ref.includes("..") || ref.endsWith(".lock") || ref.endsWith("/")) throw new HttpError(400, "ref must be a branch, tag, or commit SHA");
  return ref;
}

/** Issues of `project` whose keys (`KEY-12`) appear in `text`, case-insensitively. */
export function issuesMentioned(config: CloudServerConfig, project: CloudProject, text: string): CloudIssue[] {
  const pattern = new RegExp(`(?:^|[^A-Za-z0-9])(${project.key}-\\d+)(?![0-9])`, "gi");
  const keys = new Set([...text.matchAll(pattern)].map((match) => match[1]!.toUpperCase()));
  return [...keys].flatMap((key) => {
    const issue = config.store.readIssue(key);
    return issue && issue.projectId === project.id ? [issue] : [];
  });
}

/** Starts a deploy or test run and announces it; failures to start are recorded on the run, not thrown. */
export async function requestRun(config: CloudServerConfig, request: RunRequest): Promise<DevRun> {
  const { project, repo, actor } = request;
  const provider = config.runProvider;
  if (!provider) throw new HttpError(503, "No run environment is configured (set NOMA_CLOUD_EZKEEL_URL and NOMA_CLOUD_EZKEEL_TOKEN)", { code: "run_environment_unavailable" });
  if (!repo.runsEnabled) throw new HttpError(409, "Runs are turned off for this project", { code: "runs_disabled" });
  const ref = refInput(request.ref, repo.defaultBranch);
  if (config.devloop.activeRunCount(project.id) >= repo.maxConcurrent) {
    throw new HttpError(429, `This project already has ${repo.maxConcurrent} runs in flight`, { code: "run_concurrency_limit" });
  }
  const used = config.devloop.minutesUsed(project.id, monthStart(config.now()));
  if (used >= repo.monthlyMinutes) throw new HttpError(429, `This project used its ${repo.monthlyMinutes} run minutes for the month`, { code: "run_budget_exhausted", used });
  const issue = request.issueId ? config.store.readIssue(request.issueId) : issuesMentioned(config, project, ref)[0];
  const id = randomId();
  const now = config.now().toISOString();
  const run = config.devloop.insertRun({
    id,
    projectId: project.id,
    kind: request.kind,
    ref,
    status: "queued",
    appName: runAppName(project, request.kind, ref, id),
    ...(issue && issue.projectId === project.id ? { issueId: issue.id } : {}),
    ...(request.pullNumber !== undefined ? { pullNumber: request.pullNumber } : {}),
    ...(request.channelId ? { channelId: request.channelId } : {}),
    ...(request.threadId ? { threadId: request.threadId } : {}),
    requestedBy: actor.id,
    ...(request.agentId ? { agentId: request.agentId } : {}),
    createdAt: now,
    minutes: 0,
  });
  config.platform.recordAudit(actor.id, "run.requested", "site", project.siteId, { projectId: project.id, runId: run.id, kind: run.kind, ref, provider: provider.name, ...(request.agentId ? { agentId: request.agentId } : {}) }, now);
  recordActivity(config, actor, "run.requested", "site", project.siteId, { projectId: project.id, runId: run.id, kind: run.kind, ref });
  if (run.issueId) recordIssueEvent(config, actor, run.issueId, "run.requested", { runId: run.id, kind: run.kind, ref });
  const verb = run.kind === "deploy" ? "🚀 Deploying" : "🧪 Testing";
  const placed = announce(config, project, actor, `${verb} \`${ref}\` on ${provider.name}${request.agentId ? " (requested by an agent)" : ""} · run ${run.id}`, run);
  try {
    const started = await provider.start({ appName: run.appName, repoUrl: `https://github.com/${repo.repo}.git`, ref, kind: run.kind });
    return config.devloop.updateRun(run.id, { status: "running", startedAt: config.now().toISOString(), ...placed, ...(started.providerRef ? { providerRef: started.providerRef } : {}), ...(started.url ? { url: started.url } : {}) })!;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const failed = config.devloop.updateRun(run.id, { status: "failed", error: message.slice(0, 500), finishedAt: config.now().toISOString(), ...placed })!;
    announce(config, project, actor, `❌ Could not start the ${run.kind} of \`${ref}\`: ${message.slice(0, 300)}`, failed);
    return failed;
  }
}

/** Polls one active run and settles it when the provider reports an outcome. */
export async function refreshRun(config: CloudServerConfig, run: DevRun): Promise<DevRun> {
  if (run.status !== "queued" && run.status !== "running") return run;
  const provider = config.runProvider;
  if (!provider) return run;
  const now = config.now();
  let outcome: Awaited<ReturnType<typeof provider.status>>;
  try {
    outcome = await provider.status(run.appName, run.providerRef);
  } catch (error) {
    if (now.getTime() - Date.parse(run.createdAt) < RUN_TIMEOUT_MS) return run;
    outcome = { status: "failed", error: error instanceof Error ? error.message : String(error) };
  }
  if (outcome.status === "running") {
    if (now.getTime() - Date.parse(run.createdAt) > RUN_TIMEOUT_MS) outcome = { status: "failed", error: "Run timed out after 6 hours" };
    else {
      if (outcome.providerRef && outcome.providerRef !== run.providerRef) return config.devloop.updateRun(run.id, { providerRef: outcome.providerRef }) ?? run;
      return run;
    }
  }
  const minutes = Math.max(1, Math.ceil((now.getTime() - Date.parse(run.startedAt ?? run.createdAt)) / 60_000));
  const settled = config.devloop.transitionRun(run.id, ["queued", "running"], {
    status: outcome.status,
    finishedAt: now.toISOString(),
    minutes,
    ...(outcome.providerRef ? { providerRef: outcome.providerRef } : {}),
    ...(outcome.url ? { url: outcome.url } : {}),
    ...(outcome.error ? { error: outcome.error.slice(0, 500) } : {}),
    ...(outcome.log ? { log: outcome.log } : {}),
  });
  if (!settled) return config.devloop.readRun(run.id) ?? run;
  await settleRun(config, settled);
  return config.devloop.readRun(run.id) ?? settled;
}

/** One background pass over every queued or running run. */
export async function pollDevRuns(config: CloudServerConfig): Promise<number> {
  if (!config.runProvider) return 0;
  let settled = 0;
  for (const run of config.devloop.listActiveRuns()) {
    const next = await refreshRun(config, run).catch(() => run);
    if (next.status !== run.status) settled += 1;
  }
  return settled;
}

/** Cancels an active run or removes a preview, tearing the app down on the run environment. */
export async function stopRun(config: CloudServerConfig, run: DevRun, actor: CloudUserRecord): Promise<DevRun> {
  const project = config.store.readProject(run.projectId);
  if (config.runProvider) await config.runProvider.teardown(run.appName);
  const next = retireRun(config, run) ?? run;
  const now = config.now().toISOString();
  config.platform.recordAudit(actor.id, "run.stopped", "site", project?.siteId ?? run.projectId, { projectId: run.projectId, runId: run.id, appName: run.appName }, now);
  if (project) announce(config, project, actor, run.kind === "deploy" ? `🧹 Removed the \`${run.ref}\` preview` : `⏹ Stopped the test run of \`${run.ref}\``, next);
  return config.devloop.readRun(run.id) ?? next;
}

/**
 * Ends a run after its app was torn down: an active run is `canceled` and billed for the minutes it
 * used; a live preview becomes `removed`. Undefined when the run was already over.
 */
function retireRun(config: CloudServerConfig, run: DevRun): DevRun | undefined {
  const now = config.now();
  if (run.status === "success" && run.kind === "deploy") return config.devloop.transitionRun(run.id, ["success"], { status: "removed" });
  const started = run.startedAt ?? (run.status === "running" ? run.createdAt : undefined);
  const minutes = started ? Math.max(1, Math.ceil((now.getTime() - Date.parse(started)) / 60_000)) : 0;
  return config.devloop.transitionRun(run.id, ["queued", "running"], { status: "canceled", finishedAt: now.toISOString(), minutes });
}

async function settleRun(config: CloudServerConfig, run: DevRun): Promise<void> {
  const project = config.store.readProject(run.projectId);
  const actor = config.store.readUser(run.requestedBy);
  if (!project || !actor) return;
  const at = config.now().toISOString();
  config.platform.recordAudit(actor.id, "run.finished", "site", project.siteId, { projectId: project.id, runId: run.id, kind: run.kind, ref: run.ref, status: run.status, minutes: run.minutes }, at);
  const issue = run.issueId ? config.store.readIssue(run.issueId) : undefined;
  if (issue) recordIssueEvent(config, actor, issue.id, "run.finished", { runId: run.id, kind: run.kind, status: run.status });
  const log = run.log ? `\n\`\`\`text\n${run.log.replace(/`{3,}/g, "ʼʼʼ").slice(-3_000)}\n\`\`\`` : "";
  if (run.kind === "deploy") {
    if (run.status === "success") {
      announce(config, project, actor, `✅ Preview of \`${run.ref}\` is live${run.url ? `: ${run.url}` : ""}`, run);
      if (issue?.status === "in_progress") moveIssue(config, actor, issue, "in_review", { runId: run.id, source: "run" });
    } else if (run.status === "failed") {
      announce(config, project, actor, `❌ Deploy of \`${run.ref}\` failed: ${run.error ?? "unknown error"}${log}`, run);
    }
    return;
  }
  if (config.runProvider) await config.runProvider.teardown(run.appName).catch(() => undefined);
  if (run.status === "success") {
    announce(config, project, actor, `✅ Tests passed on \`${run.ref}\` (${run.minutes} min)`, run);
    return;
  }
  if (run.status !== "failed") return;
  const bug = config.store.createIssue(
    {
      id: uniqueId(config),
      projectId: project.id,
      summary: `Tests failing on ${run.ref}`.slice(0, 240),
      description: [`Test run ${run.id} failed on \`${run.ref}\`: ${run.error ?? "unknown error"}.`, issue ? `Found while working on ${issue.key}.` : "", run.log ? `\n\`\`\`text\n${run.log.slice(-6_000)}\n\`\`\`` : ""].filter(Boolean).join("\n\n").slice(0, 20_000),
      type: "bug",
      status: "todo",
      priority: "high",
      reporterId: actor.id,
      ...(issue?.assigneeId ? { assigneeId: issue.assigneeId } : {}),
      labels: ["ci"],
      createdAt: at,
      updatedAt: at,
    },
    project.key,
  );
  recordIssueEvent(config, actor, bug.id, "issue.created", { source: "run", runId: run.id });
  if (issue) {
    config.store.writeIssueLink({ id: uniqueId(config), sourceIssueId: bug.id, targetIssueId: issue.id, type: "relates", createdBy: actor.id, createdAt: at });
    recordIssueEvent(config, actor, bug.id, "link.created", { targetIssueId: issue.id, type: "relates" });
  }
  announce(config, project, actor, `❌ Tests failed on \`${run.ref}\` — filed ${bug.key}${log}`, run, [bug.id]);
}

// GitHub

export interface GithubEventResult {
  handled: boolean;
  event: string;
  action?: string;
  issues?: string[];
  runs?: string[];
}

/** Applies one verified GitHub webhook delivery to the project. */
export async function handleGithubEvent(config: CloudServerConfig, project: CloudProject, repo: DevRepo, event: string, payload: Record<string, unknown>): Promise<GithubEventResult> {
  const actor = config.store.readUser(repo.linkedBy);
  if (!actor) return { handled: false, event };
  if (event === "ping") return { handled: true, event };
  if (event === "pull_request") return await pullRequestEvent(config, project, repo, actor, payload);
  if (event === "workflow_run") {
    const run = record(payload.workflow_run);
    if (payload.action !== "completed") return ciPending(config, project, run.head_sha, run.head_branch, event);
    return ciResult(config, project, actor, {
      name: text(run.name) ?? "CI",
      conclusion: text(run.conclusion),
      sha: text(run.head_sha),
      branch: text(run.head_branch),
      url: text(run.html_url),
    });
  }
  if (event === "check_suite") {
    const suite = record(payload.check_suite);
    if (text(record(suite.app).slug) === "github-actions") return { handled: false, event, action: "duplicate_of_workflow_run" };
    if (payload.action !== "completed") return ciPending(config, project, suite.head_sha, suite.head_branch, event);
    return ciResult(config, project, actor, {
      name: text(record(suite.app).name) ?? "Checks",
      conclusion: text(suite.conclusion),
      sha: text(suite.head_sha),
      branch: text(suite.head_branch),
    });
  }
  return { handled: false, event };
}

async function pullRequestEvent(config: CloudServerConfig, project: CloudProject, repo: DevRepo, actor: CloudUserRecord, payload: Record<string, unknown>): Promise<GithubEventResult> {
  const action = text(payload.action) ?? "";
  const pr = record(payload.pull_request);
  const number = typeof pr.number === "number" ? pr.number : Number(payload.number);
  if (!Number.isInteger(number) || number <= 0) throw new HttpError(400, "pull_request.number is required");
  const head = record(pr.head);
  const headRef = text(head.ref) ?? "";
  const title = (text(pr.title) ?? `#${number}`).slice(0, 240);
  const url = text(pr.html_url) ?? `https://github.com/${repo.repo}/pull/${number}`;
  const merged = pr.merged === true;
  const previous = config.devloop.readPull(project.id, number);
  const mentioned = issuesMentioned(config, project, `${title}\n${text(pr.body) ?? ""}\n${headRef}`);
  const issueIds = [...new Set([...(previous?.issueIds ?? []), ...mentioned.map((issue) => issue.id)])].slice(0, 20);
  const pull = config.devloop.writePull({
    projectId: project.id,
    number,
    title,
    url,
    headRef,
    headSha: text(head.sha) ?? previous?.headSha ?? "",
    state: action === "closed" ? (merged ? "merged" : "closed") : "open",
    author: text(record(pr.user).login) ?? "unknown",
    issueIds,
    ...(previous?.ciStatus && action !== "synchronize" ? { ciStatus: previous.ciStatus } : {}),
    ...(previous?.ciUrl && action !== "synchronize" ? { ciUrl: previous.ciUrl } : {}),
    updatedAt: config.now().toISOString(),
  });
  const issues = issueIds.flatMap((id) => {
    const issue = config.store.readIssue(id);
    return issue ? [issue] : [];
  });
  const newlyLinked = issues.filter((issue) => !previous?.issueIds.includes(issue.id));
  const runs: string[] = [];
  if (action === "opened" || action === "reopened" || action === "ready_for_review" || action === "edited") {
    const announced = action === "edited" ? newlyLinked : issues;
    for (const issue of announced) {
      linkPullToIssue(config, actor, issue, pull, "opened");
      if (issue.status !== "in_review" && issue.status !== "done") moveIssue(config, actor, issue, "in_review", { pullNumber: number, source: "github" });
    }
  }
  if ((action === "opened" || action === "reopened" || action === "synchronize") && repo.autoPreview && repo.runsEnabled && config.runProvider && headRef) {
    const run = await requestRun(config, { project, repo, actor, kind: "deploy", ref: headRef, pullNumber: number, ...(issues[0] ? { issueId: issues[0].id } : {}) }).catch((error: unknown) => {
      if (issues[0]) announceToIssue(config, project, actor, issues[0], `⚠️ Preview for #${number} not started: ${error instanceof Error ? error.message : String(error)}`);
      return undefined;
    });
    if (run) runs.push(run.id);
  }
  if (action === "closed") {
    for (const issue of issues) {
      if (merged) {
        linkPullToIssue(config, actor, issue, pull, "merged");
        if (issue.status !== "done") moveIssue(config, actor, config.store.readIssue(issue.id) ?? issue, "done", { pullNumber: number, source: "github" });
      } else announceToIssue(config, project, actor, issue, `🚫 [#${number}](${url}) was closed without merging`);
    }
    const preview = headRef ? config.devloop.latestPreview(project.id, headRef) : undefined;
    if (preview && config.runProvider) {
      await config.runProvider.teardown(preview.appName).catch(() => undefined);
      retireRun(config, preview);
      if (issues[0]) announceToIssue(config, project, actor, issues[0], `🧹 Removed the \`${headRef}\` preview`);
    }
  }
  return { handled: true, event: "pull_request", action, issues: issues.map((issue) => issue.key), ...(runs.length ? { runs } : {}) };
}

function linkPullToIssue(config: CloudServerConfig, actor: CloudUserRecord, issue: CloudIssue, pull: DevPullRequest, what: "opened" | "merged"): void {
  const project = config.store.readProject(issue.projectId);
  if (!project) return;
  const now = config.now().toISOString();
  const body = what === "opened" ? `Pull request [#${pull.number} ${pull.title}](${pull.url}) by ${pull.author} references this issue.` : `Pull request [#${pull.number}](${pull.url}) was merged.`;
  config.store.writeIssueComment({ id: uniqueId(config), issueId: issue.id, body, createdBy: actor.id, createdAt: now, updatedAt: now });
  recordIssueEvent(config, actor, issue.id, what === "opened" ? "pr.linked" : "pr.merged", { number: pull.number, url: pull.url });
  announceToIssue(config, project, actor, issue, what === "opened" ? `🔀 [#${pull.number} ${pull.title}](${pull.url}) opened by ${pull.author}` : `🎉 [#${pull.number}](${pull.url}) merged — ${issue.key} is done`);
}

function ciPending(config: CloudServerConfig, project: CloudProject, sha: unknown, branch: unknown, event: string): GithubEventResult {
  for (const pull of config.devloop.pullsForHead(project.id, text(sha), text(branch))) {
    config.devloop.writePull({ ...pull, ciStatus: "pending", updatedAt: config.now().toISOString() });
  }
  return { handled: true, event, action: "pending" };
}

function ciResult(config: CloudServerConfig, project: CloudProject, actor: CloudUserRecord, check: { name: string; conclusion?: string; sha?: string; branch?: string; url?: string }): GithubEventResult {
  const passed = check.conclusion === "success";
  const failed = check.conclusion === "failure" || check.conclusion === "timed_out" || check.conclusion === "action_required" || check.conclusion === "startup_failure";
  const pulls = config.devloop.pullsForHead(project.id, check.sha, check.branch);
  if (!passed && !failed) {
    for (const pull of pulls) {
      if (pull.ciStatus !== "pending") continue;
      const { ciStatus: _pending, ...rest } = pull;
      config.devloop.writePull({ ...rest, updatedAt: config.now().toISOString() });
    }
    return { handled: false, event: "ci", action: check.conclusion ?? "unknown" };
  }
  const touched: string[] = [];
  for (const pull of pulls) {
    const ciUrl = check.url ?? pull.url;
    config.devloop.writePull({ ...pull, ciStatus: passed ? "success" : "failure", ciUrl, updatedAt: config.now().toISOString() });
    for (const issueId of pull.issueIds) {
      const issue = config.store.readIssue(issueId);
      if (!issue) continue;
      touched.push(issue.key);
      announceToIssue(config, project, actor, issue, passed ? `✅ ${check.name} passed on [#${pull.number}](${ciUrl})` : `❌ ${check.name} failed on [#${pull.number}](${ciUrl})`);
      if (failed) {
        const now = config.now().toISOString();
        config.store.writeIssueComment({ id: uniqueId(config), issueId: issue.id, body: `${check.name} failed on pull request [#${pull.number}](${ciUrl}).`, createdBy: actor.id, createdAt: now, updatedAt: now });
      }
      recordIssueEvent(config, actor, issue.id, passed ? "ci.passed" : "ci.failed", { number: pull.number, check: check.name, ...(check.url ? { url: check.url } : {}) });
    }
  }
  return { handled: true, event: "ci", action: passed ? "success" : "failure", issues: touched };
}

function moveIssue(config: CloudServerConfig, actor: CloudUserRecord, issue: CloudIssue, status: CloudIssueStatus, detail: Record<string, unknown>): void {
  if (issue.status === status) return;
  config.store.writeIssue({ ...issue, status, updatedAt: config.now().toISOString() });
  recordIssueEvent(config, actor, issue.id, "issue.updated", { status: { from: issue.status, to: status }, ...detail });
}

// chat

/**
 * Posts `text` where the run belongs: its own thread, else its issue's thread, else the project channel.
 * Returns the channel and thread it landed in so later updates follow.
 */
function announce(config: CloudServerConfig, project: CloudProject, actor: CloudUserRecord, body: string, run?: DevRun, issueIds: string[] = []): { channelId?: string; threadId?: string } {
  if (run?.channelId) {
    const channel = config.chat.readChannel(run.channelId);
    if (channel && !channel.archivedAt) {
      post(config, channel, actor, body, run.threadId, issueIds);
      return { channelId: channel.id, ...(run.threadId ? { threadId: run.threadId } : {}) };
    }
  }
  const issue = run?.issueId ? config.store.readIssue(run.issueId) : undefined;
  if (issue) return announceToIssue(config, project, actor, issue, body, issueIds);
  const channel = projectChannel(config, project);
  if (!channel) return {};
  const message = post(config, channel, actor, body, undefined, issueIds);
  return { channelId: channel.id, threadId: message.id };
}

function announceToIssue(config: CloudServerConfig, project: CloudProject, actor: CloudUserRecord, issue: CloudIssue, body: string, issueIds: string[] = []): { channelId?: string; threadId?: string } {
  const linked = config.chat.findIssueMessage(issue.id);
  const channel = linked ? config.chat.readChannel(linked.channelId) : undefined;
  if (linked && channel && !channel.archivedAt) {
    const threadId = linked.threadId ?? linked.id;
    post(config, channel, actor, body, threadId, issueIds);
    return { channelId: channel.id, threadId };
  }
  const fallback = projectChannel(config, project);
  if (!fallback) return {};
  const root = post(config, fallback, actor, `**${issue.key}** ${issue.summary}\n${body}`, undefined, [issue.id, ...issueIds]);
  return { channelId: fallback.id, threadId: root.id };
}

/** The project's first public, unarchived channel. */
function projectChannel(config: CloudServerConfig, project: CloudProject): ChatChannel | undefined {
  return config.chat.listChannels([project.siteId], { projectId: project.id }).find((channel) => channel.visibility === "public");
}

function post(config: CloudServerConfig, channel: ChatChannel, actor: CloudUserRecord, body: string, threadId?: string, issueIds: string[] = []): ChatMessage {
  return config.chat.postMessage({
    id: randomId(),
    channelId: channel.id,
    ...(threadId ? { threadId } : {}),
    kind: "system",
    authorId: actor.id,
    body: body.slice(0, CHAT_LIMIT),
    links: issueIds.length ? { issueIds } : {},
    createdAt: config.now().toISOString(),
  });
}

// helpers

/** Stable, RFC 1123 app name: `<key>-<ref slug>` for previews, `<key>-test-<run>` for test builds. */
export function runAppName(project: CloudProject, kind: DevRunKind, ref: string, runId: string): string {
  const key = slug(project.key);
  if (kind === "test") return `${key}-test-${runId.slice(0, 10).toLowerCase()}`;
  const name = `${key}-${slug(ref)}`;
  if (name.length <= 63) return name;
  let hash = 0;
  for (const char of ref) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return `${name.slice(0, 54).replace(/-+$/, "")}-${hash.toString(36).slice(0, 8)}`;
}

function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "x";
}

function monthStart(now: Date): string {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).toISOString();
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}
