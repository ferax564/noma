/** `/api/agents/:id/hosting|schedules|jobs` — hosted and scheduled agents, managed by the agent's owner. */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { AgentScheduleCadence } from "../cloud-agent-ops.js";
import { nextScheduleRun } from "../cloud-agent-ops.js";
import type { CloudUserRecord } from "../cloud-db.js";
import type { CloudAgentIdentity } from "../cloud-platform.js";
import { enqueueSchedule, requireAgentsRunning, runAgentJobs } from "./agent-runner.js";
import { type CloudServerConfig, randomId } from "./context.js";
import { HttpError, readJsonBody, sendJson } from "./http.js";
import { boundedInteger, optionalString, stringInput, stringPathPart } from "./input.js";
import { agentChannelAccess } from "./routes-chat.js";

/** Returns true when the route was handled. */
export async function routeAgentOps(
  req: IncomingMessage,
  res: ServerResponse,
  action: string | undefined,
  childId: string | undefined,
  subAction: string | undefined,
  config: CloudServerConfig,
  user: CloudUserRecord,
  agent: CloudAgentIdentity,
): Promise<boolean> {
  const method = req.method ?? "GET";
  if (action === "hosting") {
    if (method === "GET") {
      sendJson(res, 200, hostingResponse(config, agent));
      return true;
    }
    if (method === "PUT") {
      const input = await readJsonBody(req, config.maxBodyBytes);
      const current = config.agentOps.readHosting(agent.id);
      const enabled = typeof input.enabled === "boolean" ? input.enabled : current?.enabled ?? false;
      if (enabled) {
        const provider = config.ai.provider;
        if (!provider) throw new HttpError(409, "No language model is configured on this server", { code: "ai_not_configured" });
        if (agent.modelPolicy.model !== provider.model) throw new HttpError(409, `Set this agent's model policy to ${provider.model} before hosting it`, { code: "model_mismatch" });
        if (!agent.capabilities.includes("chat")) throw new HttpError(409, "Hosted agents need the chat capability", { code: "chat_capability_required" });
      }
      const now = config.now().toISOString();
      config.agentOps.writeHosting({
        agentId: agent.id,
        enabled,
        instructions: input.instructions === undefined ? current?.instructions ?? "" : (optionalString(input.instructions) ?? "").slice(0, 8_000),
        updatedBy: user.id,
        updatedAt: now,
      });
      config.platform.recordAudit(user.id, enabled ? "agent.hosted" : "agent.unhosted", "workspace", `agent:${agent.id}`, { agentId: agent.id }, now);
      sendJson(res, 200, hostingResponse(config, agent));
      return true;
    }
    throw new HttpError(405, "Method not allowed");
  }
  if (action === "schedules") {
    if (!childId && method === "GET") {
      sendJson(res, 200, { schedules: config.agentOps.listSchedules(agent.id) });
      return true;
    }
    if (!childId && method === "POST") {
      const input = await readJsonBody(req, config.maxBodyBytes);
      if (config.agentOps.listSchedules(agent.id).length >= 20) throw new HttpError(409, "An agent can have at most 20 schedules");
      const channel = scheduleChannel(config, agent, stringInput(input, "channelId"));
      const cadence = cadenceInput(input.cadence);
      const hourUtc = boundedInteger(input.hourUtc, 8, 0, 23, "hourUtc");
      const weekday = boundedInteger(input.weekday, 1, 0, 6, "weekday");
      const now = config.now();
      const schedule = config.agentOps.writeSchedule({
        id: randomId(),
        agentId: agent.id,
        siteId: channel.siteId,
        channelId: channel.id,
        title: (optionalString(input.title) ?? "Digest").slice(0, 120),
        prompt: stringInput(input, "prompt").slice(0, 4_000),
        cadence,
        hourUtc,
        weekday,
        enabled: input.enabled !== false,
        nextRunAt: nextScheduleRun(cadence, hourUtc, weekday, now),
        createdBy: user.id,
        createdAt: now.toISOString(),
        updatedAt: now.toISOString(),
      });
      config.platform.recordAudit(user.id, "agent.schedule_created", "workspace", `agent:${agent.id}`, { agentId: agent.id, scheduleId: schedule.id, channelId: channel.id, cadence }, now.toISOString());
      sendJson(res, 201, schedule);
      return true;
    }
    if (!childId) throw new HttpError(405, "Method not allowed");
    const schedule = config.agentOps.readSchedule(stringPathPart(childId, "Schedule ID"));
    if (!schedule || schedule.agentId !== agent.id) throw new HttpError(404, "Schedule not found");
    if (subAction === "run" && method === "POST") {
      requireAgentsRunning(config);
      const job = enqueueSchedule(config, schedule);
      await runAgentJobs(config);
      sendJson(res, 202, config.agentOps.readJob(job.id));
      return true;
    }
    if (subAction) throw new HttpError(404, "Unknown schedule route");
    if (method === "PATCH") {
      const input = await readJsonBody(req, config.maxBodyBytes);
      const cadence = input.cadence === undefined ? schedule.cadence : cadenceInput(input.cadence);
      const hourUtc = input.hourUtc === undefined ? schedule.hourUtc : boundedInteger(input.hourUtc, 8, 0, 23, "hourUtc");
      const weekday = input.weekday === undefined ? schedule.weekday : boundedInteger(input.weekday, 1, 0, 6, "weekday");
      const channel = input.channelId === undefined ? undefined : scheduleChannel(config, agent, stringInput(input, "channelId"));
      const timingChanged = cadence !== schedule.cadence || hourUtc !== schedule.hourUtc || weekday !== schedule.weekday;
      const saved = config.agentOps.writeSchedule({
        ...schedule,
        ...(channel ? { channelId: channel.id, siteId: channel.siteId } : {}),
        title: input.title === undefined ? schedule.title : (optionalString(input.title) ?? schedule.title).slice(0, 120),
        prompt: input.prompt === undefined ? schedule.prompt : stringInput(input, "prompt").slice(0, 4_000),
        cadence,
        hourUtc,
        weekday,
        enabled: typeof input.enabled === "boolean" ? input.enabled : schedule.enabled,
        nextRunAt: timingChanged ? nextScheduleRun(cadence, hourUtc, weekday, config.now()) : schedule.nextRunAt,
        updatedAt: config.now().toISOString(),
      });
      sendJson(res, 200, saved);
      return true;
    }
    if (method === "DELETE") {
      config.agentOps.deleteSchedule(schedule.id);
      config.platform.recordAudit(user.id, "agent.schedule_deleted", "workspace", `agent:${agent.id}`, { agentId: agent.id, scheduleId: schedule.id }, config.now().toISOString());
      sendJson(res, 200, { deleted: schedule.id });
      return true;
    }
    throw new HttpError(405, "Method not allowed");
  }
  if (action === "jobs" && method === "GET") {
    sendJson(res, 200, { jobs: config.agentOps.listJobs(agent.id) });
    return true;
  }
  return false;
}

function hostingResponse(config: CloudServerConfig, agent: CloudAgentIdentity): Record<string, unknown> {
  const hosting = config.agentOps.readHosting(agent.id);
  return {
    agentId: agent.id,
    enabled: hosting?.enabled ?? false,
    instructions: hosting?.instructions ?? "",
    model: config.ai.provider?.model ?? null,
    budget: { limitUsd: agent.budgetUsd, spentUsd: agent.spentUsd },
    paused: config.agentOps.killSwitch().paused,
  };
}

function scheduleChannel(config: CloudServerConfig, agent: CloudAgentIdentity, channelId: string) {
  const channel = config.chat.readChannel(channelId);
  if (!channel || channel.kind !== "channel" || channel.archivedAt || !agentChannelAccess(config, agent.id, channel)) {
    throw new HttpError(400, "channelId must be a channel this agent can chat in (chat capability, a grant on the space, and membership for private channels)");
  }
  return channel;
}

function cadenceInput(value: unknown): AgentScheduleCadence {
  if (value === "hourly" || value === "daily" || value === "weekly") return value;
  throw new HttpError(400, "cadence must be hourly, daily, or weekly");
}
