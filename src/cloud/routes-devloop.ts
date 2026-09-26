/**
 * Dev-loop routes: `/api/projects/:id/repo|pulls|runs`, the signed GitHub webhook at
 * `/api/hooks/github/:projectId` (served before the Cloud access gate — the HMAC is the credential),
 * `/deploy` and `/test` chat commands, and the `run_request` gateway tool.
 */
import { handleSlackEvent, verifySlackSignature } from "./integrations.js";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import type { CloudAgentIdentity } from "../cloud-platform.js";
import type { CloudProject, CloudUserRecord } from "../cloud-db.js";
import type { ChatChannel, ChatMessage } from "../cloud-chat.js";
import type { DevRepo, DevRun, DevRunKind } from "../cloud-devloop.js";
import { type AccessContext, type CloudServerConfig, type Principal, randomId, requireAccessRole, requireProjectAccess, requireUser } from "./context.js";
import { requireAgentsRunning } from "./agent-runner.js";
import { ownedAgent } from "./routes-knowledge.js";
import { handleGithubEvent, refInput, refreshRun, requestRun, stopRun } from "./devloop.js";
import { HttpError, headerValue, readJsonBody, readRawBody, sendJson } from "./http.js";
import { boundedInteger, numberQuery, optionalString, stringInput, stringPathPart } from "./input.js";

/** Agents need this capability to start runs from chat or the gateway. */
export const AGENT_RUN_CAPABILITY = "run";
const HOOK_MAX_BYTES = 10 * 1024 * 1024;
const REPO_RE = /^[A-Za-z0-9_.-]{1,100}\/[A-Za-z0-9_.-]{1,100}$/;
const COMMAND_RE = /^\/(deploy|test)(?:\s+(\S+))?\s*$/;

export async function routeProjectDevLoop(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  resource: string,
  resourceId: string | undefined,
  config: CloudServerConfig,
  principal: Principal,
  user: CloudUserRecord,
  project: CloudProject,
  access: AccessContext,
): Promise<void> {
  const method = req.method ?? "GET";
  if (resource === "repo") {
    if (method === "GET") {
      sendJson(res, 200, repoResponse(config, project, config.devloop.readRepo(project.id), access.role === "owner"));
      return;
    }
    if (method === "PUT") {
      requireAccessRole(access, "owner");
      const input = await readJsonBody(req, config.maxBodyBytes);
      const current = config.devloop.readRepo(project.id);
      const repo = optionalString(input.repo) ?? current?.repo;
      if (!repo || !REPO_RE.test(repo)) throw new HttpError(400, "repo must be a GitHub repository as owner/name");
      const now = config.now().toISOString();
      const saved = config.devloop.writeRepo({
        projectId: project.id,
        siteId: project.siteId,
        provider: "github",
        repo,
        webhookSecret: current && input.rotateSecret !== true && current.repo === repo ? current.webhookSecret : randomBytes(24).toString("hex"),
        defaultBranch: input.defaultBranch === undefined ? current?.defaultBranch ?? "main" : refInput(input.defaultBranch, "main"),
        runsEnabled: typeof input.runsEnabled === "boolean" ? input.runsEnabled : current?.runsEnabled ?? false,
        autoPreview: typeof input.autoPreview === "boolean" ? input.autoPreview : current?.autoPreview ?? false,
        monthlyMinutes: boundedInteger(input.monthlyMinutes, current?.monthlyMinutes ?? 600, 0, 100_000, "monthlyMinutes"),
        maxConcurrent: boundedInteger(input.maxConcurrent, current?.maxConcurrent ?? 2, 1, 20, "maxConcurrent"),
        minRole: input.minRole === undefined ? current?.minRole ?? "editor" : minRoleInput(input.minRole),
        agentRunsNeedApproval: typeof input.agentRunsNeedApproval === "boolean" ? input.agentRunsNeedApproval : current?.agentRunsNeedApproval ?? true,
        linkedBy: current?.linkedBy ?? user.id,
        createdAt: current?.createdAt ?? now,
        updatedAt: now,
      });
      config.platform.recordAudit(user.id, current ? "repo.updated" : "repo.linked", "site", project.siteId, { projectId: project.id, repo, runsEnabled: saved.runsEnabled, autoPreview: saved.autoPreview, monthlyMinutes: saved.monthlyMinutes }, now);
      sendJson(res, current ? 200 : 201, repoResponse(config, project, saved, true));
      return;
    }
    if (method === "DELETE") {
      requireAccessRole(access, "owner");
      if (!config.devloop.deleteRepo(project.id)) throw new HttpError(404, "No repository is linked");
      config.platform.recordAudit(user.id, "repo.unlinked", "site", project.siteId, { projectId: project.id }, config.now().toISOString());
      sendJson(res, 200, { unlinked: true });
      return;
    }
    throw new HttpError(405, "Method not allowed");
  }
  if (resource === "pulls" && method === "GET") {
    const issueId = optionalString(url.searchParams.get("issue"));
    const pulls = issueId ? config.devloop.pullsForIssue(config.store.readIssue(issueId)?.id ?? issueId).filter((pull) => pull.projectId === project.id) : config.devloop.listPulls(project.id);
    sendJson(res, 200, { pulls: pulls.map((pull) => ({ ...pull, issues: issueKeys(config, pull.issueIds) })) });
    return;
  }
  if (resource === "runs") {
    if (!resourceId && method === "GET") {
      const issueId = optionalString(url.searchParams.get("issue"));
      const runs = config.devloop.listRuns(project.id, { limit: boundedInteger(numberQuery(url.searchParams.get("limit")), 50, 1, 200, "limit"), ...(issueId ? { issueId: config.store.readIssue(issueId)?.id ?? issueId } : {}) });
      const fresh = await Promise.all(runs.map((run) => (run.status === "queued" || run.status === "running" ? refreshRun(config, run).catch(() => run) : run)));
      sendJson(res, 200, { runs: fresh.map((run) => runResponse(config, run)) });
      return;
    }
    if (!resourceId && method === "POST") {
      const input = await readJsonBody(req, config.maxBodyBytes);
      const repo = requireRepo(config, project);
      requireAccessRole(access, repo.minRole);
      const agentId = optionalString(input.agentId);
      const agent = agentId ? runAgent(config, user, agentId, project) : undefined;
      const issue = optionalString(input.issueId) ? config.store.readIssue(optionalString(input.issueId)!) : undefined;
      if (issue && issue.projectId !== project.id) throw new HttpError(400, "issueId must be an issue in this project");
      const channel = optionalString(input.channelId) ? projectChannelInput(config, principal, project, optionalString(input.channelId)!) : undefined;
      const run = await requestRun(config, {
        project,
        repo,
        actor: user,
        kind: runKindInput(input.kind),
        ...(optionalString(input.ref) ? { ref: optionalString(input.ref)! } : {}),
        ...(issue ? { issueId: issue.id } : {}),
        ...(agent ? { agentId: agent.id } : {}),
        ...(channel ? { channelId: channel.id } : {}),
        ...(channel && optionalString(input.threadId) ? { threadId: optionalString(input.threadId)! } : {}),
      });
      sendJson(res, 201, runResponse(config, run));
      return;
    }
    if (!resourceId) throw new HttpError(405, "Method not allowed");
    const run = config.devloop.readRun(stringPathPart(resourceId, "Run ID"));
    if (!run || run.projectId !== project.id) throw new HttpError(404, "Run not found");
    if (method === "GET") {
      sendJson(res, 200, runResponse(config, await refreshRun(config, run)));
      return;
    }
    if (method === "DELETE") {
      const repo = config.devloop.readRepo(project.id);
      requireAccessRole(access, repo?.minRole ?? "editor");
      sendJson(res, 200, runResponse(config, await stopRun(config, run, user)));
      return;
    }
    throw new HttpError(405, "Method not allowed");
  }
  throw new HttpError(404, "Unknown project route");
}

/** `POST /api/hooks/github/:projectId` — authenticated by the repository's webhook secret, not a Cloud session. */
export async function routeHooks(req: IncomingMessage, res: ServerResponse, url: URL, config: CloudServerConfig): Promise<void> {
  const parts = url.pathname.split("/").filter(Boolean);
  if (parts[2] === "slack" && parts.length === 3) {
    await routeSlackHook(req, res, config);
    return;
  }
  if (parts[2] !== "github" || !parts[3] || parts.length !== 4) throw new HttpError(404, "Unknown hook");
  if ((req.method ?? "GET") !== "POST") throw new HttpError(405, "Method not allowed");
  const body = await readRawBody(req, HOOK_MAX_BYTES);
  const project = config.store.readProject(decodeURIComponent(parts[3]));
  const repo = project ? config.devloop.readRepo(project.id) : undefined;
  if (!project || !repo) throw new HttpError(404, "No repository is linked to this project");
  if (!validSignature(body, repo.webhookSecret, headerValue(req, "x-hub-signature-256"))) throw new HttpError(401, "Invalid webhook signature");
  const event = headerValue(req, "x-github-event") ?? "";
  let payload: Record<string, unknown>;
  try {
    const parsed = JSON.parse(body.toString("utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("not an object");
    payload = parsed as Record<string, unknown>;
  } catch {
    throw new HttpError(400, "Invalid JSON body");
  }
  const fullName = (payload.repository as Record<string, unknown> | undefined)?.full_name;
  if (typeof fullName === "string" && fullName.toLowerCase() !== repo.repo.toLowerCase()) {
    sendJson(res, 202, { handled: false, reason: "repository does not match the linked repo" });
    return;
  }
  if (!config.store.resourceAccess(repo.linkedBy, "site", project.siteId)) {
    sendJson(res, 202, { handled: false, reason: "the person who linked the repository no longer has access to the space" });
    return;
  }
  const delivery = headerValue(req, "x-github-delivery")?.slice(0, 100);
  if (delivery && !config.devloop.claimDelivery(delivery, project.id, event, config.now().toISOString())) {
    sendJson(res, 200, { handled: false, duplicate: true });
    return;
  }
  try {
    sendJson(res, 202, await handleGithubEvent(config, project, repo, event, payload));
  } catch (error) {
    if (delivery) config.devloop.releaseDelivery(delivery);
    throw error;
  }
}

/**
 * `/deploy [ref]` and `/test [ref]` in a project channel. Called after the message is posted; a
 * refusal (no repo, budget, permissions) becomes a reply in the thread instead of an HTTP error.
 */
export async function runChatCommand(config: CloudServerConfig, principal: Principal, channel: ChatChannel, message: ChatMessage, agent?: CloudAgentIdentity): Promise<DevRun | undefined> {
  const match = COMMAND_RE.exec(message.body.trim());
  if (!match || channel.kind !== "channel") return undefined;
  const user = requireUser(principal);
  const threadId = message.threadId ?? message.id;
  try {
    if (!channel.projectId) throw new HttpError(400, "Link this channel to a Work project to use /deploy and /test");
    const project = config.store.readProject(channel.projectId);
    if (!project) throw new HttpError(404, "Project not found");
    const repo = requireRepo(config, project);
    const access = requireProjectAccess(config, project, principal, "viewer");
    requireAccessRole(access, repo.minRole);
    if (agent) runAgent(config, user, agent.id, project);
    return await requestRun(config, {
      project,
      repo,
      actor: user,
      kind: match[1] as DevRunKind,
      ...(match[2] ? { ref: match[2] } : {}),
      ...(agent ? { agentId: agent.id } : {}),
      channelId: channel.id,
      threadId,
      ...(message.links.issueIds?.[0] ? { issueId: message.links.issueIds[0] } : {}),
    });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    config.chat.postMessage({ id: randomId(), channelId: channel.id, threadId, kind: "system", authorId: user.id, body: `⚠️ ${match[0].trim()} was not started: ${reason}`.slice(0, 2_000), links: {}, createdAt: config.now().toISOString() });
    return undefined;
  }
}

/** Gateway (`/api/gateway/mcp`) `run_request` tool. */
export async function callRunGatewayTool(args: Record<string, unknown>, config: CloudServerConfig, principal: Principal): Promise<Record<string, unknown>> {
  const user = requireUser(principal);
  const project = config.store.readProject(stringInput(args, "projectId"));
  if (!project) throw new HttpError(404, "Project not found");
  const repo = requireRepo(config, project);
  const access = requireProjectAccess(config, project, principal, "viewer");
  requireAccessRole(access, repo.minRole);
  const agent = runAgent(config, user, stringInput(args, "agentId"), project);
  const issue = optionalString(args.issueKey) ? config.store.readIssue(optionalString(args.issueKey)!) : undefined;
  if (issue && issue.projectId !== project.id) throw new HttpError(400, "issueKey must be an issue in this project");
  const run = await requestRun(config, {
    project,
    repo,
    actor: user,
    agentId: agent.id,
    kind: runKindInput(args.kind),
    ...(optionalString(args.ref) ? { ref: optionalString(args.ref)! } : {}),
    ...(issue ? { issueId: issue.id } : {}),
  });
  return { run: runResponse(config, run) };
}

function runAgent(config: CloudServerConfig, user: CloudUserRecord, agentId: string, project: CloudProject): CloudAgentIdentity {
  requireAgentsRunning(config);
  const agent = ownedAgent(config, user, agentId);
  if (agent.status !== "active") throw new HttpError(403, "The agent is not active");
  if (!agent.capabilities.includes(AGENT_RUN_CAPABILITY)) throw new HttpError(403, `Agent lacks capability: ${AGENT_RUN_CAPABILITY}`);
  if (!config.platform.listAgentAccess(agent.id).some((grant) => grant.resourceType === "site" && grant.resourceId === project.siteId)) {
    throw new HttpError(403, "The agent has no access grant on this project's space");
  }
  return agent;
}

function requireRepo(config: CloudServerConfig, project: CloudProject): DevRepo {
  const repo = config.devloop.readRepo(project.id);
  if (!repo) throw new HttpError(409, "Link a GitHub repository to this project first", { code: "repo_not_linked" });
  return repo;
}

function projectChannelInput(config: CloudServerConfig, principal: Principal, project: CloudProject, channelId: string): ChatChannel {
  const channel = config.chat.readChannel(channelId);
  const user = requireUser(principal);
  if (!channel || channel.siteId !== project.siteId || channel.kind !== "channel") throw new HttpError(400, "channelId must be a channel in this project's space");
  if (channel.visibility === "private" && !config.chat.readMember(channel.id, user.id)) throw new HttpError(400, "channelId must be a channel in this project's space");
  return channel;
}

function repoResponse(config: CloudServerConfig, project: CloudProject, repo: DevRepo | undefined, owner: boolean): Record<string, unknown> {
  const runEnvironment = config.runProvider?.name ?? null;
  if (!repo) return { linked: false, runEnvironment, hookPath: `/api/hooks/github/${project.id}` };
  const { webhookSecret, ...rest } = repo;
  const monthStart = new Date(Date.UTC(config.now().getUTCFullYear(), config.now().getUTCMonth(), 1)).toISOString();
  return {
    linked: true,
    runEnvironment,
    hookPath: `/api/hooks/github/${project.id}`,
    ...rest,
    ...(owner ? { webhookSecret } : {}),
    usage: { minutesUsed: config.devloop.minutesUsed(project.id, monthStart), activeRuns: config.devloop.activeRunCount(project.id) },
  };
}

function runResponse(config: CloudServerConfig, run: DevRun): Record<string, unknown> {
  const issue = run.issueId ? config.store.readIssue(run.issueId) : undefined;
  return { ...run, ...(issue ? { issueKey: issue.key } : {}), requestedByName: config.store.readUser(run.requestedBy)?.name ?? run.requestedBy };
}

function issueKeys(config: CloudServerConfig, ids: string[]): Array<{ id: string; key: string; status: string }> {
  return ids.flatMap((id) => {
    const issue = config.store.readIssue(id);
    return issue ? [{ id: issue.id, key: issue.key, status: issue.status }] : [];
  });
}

function runKindInput(value: unknown): DevRunKind {
  if (value === "deploy" || value === "test") return value;
  throw new HttpError(400, "kind must be deploy or test");
}

function minRoleInput(value: unknown): "editor" | "owner" {
  if (value === "editor" || value === "owner") return value;
  throw new HttpError(400, "minRole must be editor or owner");
}

function validSignature(body: Buffer, secret: string, header: string | undefined): boolean {
  if (!header?.startsWith("sha256=")) return false;
  const expected = Buffer.from(`sha256=${createHmac("sha256", secret).update(body).digest("hex")}`);
  const given = Buffer.from(header);
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/** `POST /api/hooks/slack` — Slack Events API, authenticated by the app's signing secret. */
async function routeSlackHook(req: IncomingMessage, res: ServerResponse, config: CloudServerConfig): Promise<void> {
  if ((req.method ?? "GET") !== "POST") throw new HttpError(405, "Method not allowed");
  if (!config.slack) throw new HttpError(404, "The Slack bridge is not configured");
  const body = await readRawBody(req, 1_000_000);
  if (!verifySlackSignature(config.slack, body, headerValue(req, "x-slack-request-timestamp"), headerValue(req, "x-slack-signature"), config.now().getTime())) {
    throw new HttpError(401, "Invalid Slack signature");
  }
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(body.toString("utf8")) as Record<string, unknown>;
  } catch {
    throw new HttpError(400, "Invalid JSON body");
  }
  if (payload.type === "url_verification" && typeof payload.challenge === "string") {
    sendJson(res, 200, { challenge: payload.challenge });
    return;
  }
  sendJson(res, 200, await handleSlackEvent(config, payload));
}
