/**
 * Gatekeeper for every Noma Cloud model call: provider configuration, enterprise model policy,
 * per-user and per-agent budgets, and usage accounting. Routes never call an `LlmProvider` directly.
 */
import type { CloudUserRecord } from "../cloud-db.js";
import { costUsd, type LlmCompletion, LlmError, type LlmMessage, modelAllowedByPolicy, worstCaseCostUsd } from "../cloud-llm.js";
import type { CloudAgentIdentity, EnterprisePolicy } from "../cloud-platform.js";
import { type CloudServerConfig, randomId } from "./context.js";

export type AiUnavailableReason =
  | "not_configured"
  | "model_not_allowed"
  | "zero_retention_required"
  | "user_budget_exhausted"
  | "agent_budget_exhausted"
  | "agent_inactive"
  | "provider_error"
  | "refused"
  | "agents_paused";

export class AiUnavailable extends Error {
  constructor(readonly reason: AiUnavailableReason, message: string) {
    super(message);
  }
}

export type AiFeature = "ask" | "summarize" | "draft" | "refresh" | "draft_page" | "maintenance_refresh" | "agent_chat" | "agent_schedule";

export interface AiCallRequest {
  feature: AiFeature;
  system: string;
  messages: LlmMessage[];
  maxTokens: number;
  /** A user-owned agent to charge instead of the caller's system agent. */
  agentId?: string;
  siteId?: string;
  documentId?: string;
  trigger?: "manual" | "scheduled";
}

export interface AiCallResult {
  completion: LlmCompletion;
  costUsd: number;
  agentId: string;
  model: string;
}

export interface AiStatus {
  available: boolean;
  reason?: AiUnavailableReason;
  message?: string;
  provider?: string;
  model?: string;
  zeroRetention?: boolean;
  budget: { userLimitUsd: number; userSpentUsd: number; agentId: string; agentLimitUsd: number; agentSpentUsd: number };
}

const budgetWindowMs = 30 * 24 * 60 * 60 * 1000;

export function systemAgentId(userId: string): string {
  return `noma-ai-${userId}`;
}

/** The caller's system agent, created on first use and kept in step with the configured model and budget. */
export function ensureSystemAgent(config: CloudServerConfig, user: CloudUserRecord): CloudAgentIdentity {
  const now = config.now().toISOString();
  const provider = config.ai.provider;
  return config.platform.upsertSystemAgent({
    id: systemAgentId(user.id),
    name: "Noma AI",
    description: `System assistant acting for ${user.name}. Every edit it drafts is a proofed proposal that needs another collaborator's approval.`,
    createdBy: user.id,
    modelPolicy: { model: provider?.model ?? "none", zeroRetention: provider?.zeroRetention === true, maxTokensPerRun: 32_000 },
    capabilities: ["read_doc", "list_ids", "validate_doc", "patch_block", "cited_answer"],
    budgetUsd: config.ai.agentBudgetUsd,
    spentUsd: 0,
    status: "active",
    createdAt: now,
    updatedAt: now,
  });
}

export function aiStatus(config: CloudServerConfig, user: CloudUserRecord, agentId?: string): AiStatus {
  if (!config.ai.provider) {
    return { available: false, reason: "not_configured", message: "No language model is configured on this server", budget: budgetView(config, user, config.platform.readAgent(systemAgentId(user.id))) };
  }
  let agent: CloudAgentIdentity | undefined;
  try {
    agent = resolveAgent(config, user, agentId);
  } catch (error) {
    if (!(error instanceof AiUnavailable)) throw error;
    return { available: false, reason: error.reason, message: error.message, budget: budgetView(config, user, undefined) };
  }
  const budget = budgetView(config, user, agent);
  try {
    requireCallable(config, user, agent, 0);
  } catch (error) {
    if (!(error instanceof AiUnavailable)) throw error;
    return { available: false, reason: error.reason, message: error.message, budget, ...providerView(config) };
  }
  return { available: true, budget, ...providerView(config) };
}

export async function runAiCompletion(config: CloudServerConfig, user: CloudUserRecord, request: AiCallRequest): Promise<AiCallResult> {
  const provider = config.ai.provider;
  if (!provider) throw new AiUnavailable("not_configured", "No language model is configured on this server");
  const agent = resolveAgent(config, user, request.agentId);
  const maxTokens = Math.min(request.maxTokens, agent.modelPolicy.maxTokensPerRun);
  const llmRequest = { system: request.system, messages: request.messages, maxTokens };
  requireCallable(config, user, agent, worstCaseCostUsd(provider.model, llmRequest));
  const startedAt = config.now().toISOString();
  let completion: LlmCompletion;
  try {
    completion = await provider.complete(llmRequest);
  } catch (error) {
    if (error instanceof LlmError) throw new AiUnavailable("provider_error", `Language model request failed (${error.code})`);
    throw error;
  }
  const spent = costUsd(completion.model, completion.usage);
  const completedAt = config.now().toISOString();
  const runId = randomId();
  config.platform.recordAgentUsage({
    runId,
    agentId: agent.id,
    triggeredBy: user.id,
    trigger: request.trigger ?? "manual",
    ...(request.documentId ? { documentId: request.documentId } : {}),
    costUsd: spent,
    startedAt,
    completedAt,
    output: { feature: request.feature, model: completion.model, inputTokens: completion.usage.inputTokens, outputTokens: completion.usage.outputTokens, refused: completion.refused },
  });
  config.store.writeAiUsage({
    id: runId,
    userId: user.id,
    agentId: agent.id,
    feature: request.feature,
    model: completion.model,
    inputTokens: completion.usage.inputTokens,
    outputTokens: completion.usage.outputTokens,
    costUsd: spent,
    ...(request.siteId ? { siteId: request.siteId } : {}),
    ...(request.documentId ? { documentId: request.documentId } : {}),
    createdAt: completedAt,
  });
  if (!modelAllowed(config.platform.enterprisePolicy(), completion.model, provider.model)) {
    throw new AiUnavailable("model_not_allowed", `The response came from ${completion.model}, which enterprise policy does not allow`);
  }
  if (completion.refused) throw new AiUnavailable("refused", "The language model declined this request");
  return { completion, costUsd: spent, agentId: agent.id, model: completion.model };
}

/**
 * An untouched default policy (never saved by an admin) allows the operator-configured model; once a
 * workspace admin saves a policy, its `modelAllowlist` is authoritative.
 */
export function modelAllowed(policy: EnterprisePolicy, model: string, configuredModel: string): boolean {
  return modelAllowedByPolicy(policy, model, configuredModel);
}

function resolveAgent(config: CloudServerConfig, user: CloudUserRecord, agentId: string | undefined): CloudAgentIdentity {
  if (config.agentOps.killSwitch().paused) throw new AiUnavailable("agents_paused", "Agents are paused by a workspace admin");
  if (!agentId) return ensureSystemAgent(config, user);
  const agent = config.platform.readAgent(agentId);
  if (!agent || agent.createdBy !== user.id) throw new AiUnavailable("agent_inactive", "Agent not found for this user");
  if (agent.status !== "active") throw new AiUnavailable("agent_inactive", "Agent identity is not active");
  return agent;
}

function requireCallable(config: CloudServerConfig, user: CloudUserRecord, agent: CloudAgentIdentity, worstCaseUsd: number): void {
  const provider = config.ai.provider;
  if (!provider) throw new AiUnavailable("not_configured", "No language model is configured on this server");
  const policy = config.platform.enterprisePolicy();
  if (!modelAllowed(policy, provider.model, provider.model)) {
    throw new AiUnavailable("model_not_allowed", `Enterprise policy does not allow ${provider.model}; add it to modelAllowlist`);
  }
  if (policy.requireZeroRetentionModels && !provider.zeroRetention) {
    throw new AiUnavailable("zero_retention_required", "Enterprise policy requires a zero-retention model provider");
  }
  if (agent.id !== systemAgentId(user.id)) {
    if (agent.modelPolicy.model !== provider.model) throw new AiUnavailable("model_not_allowed", `Agent ${agent.name} is limited to ${agent.modelPolicy.model}`);
    if (agent.modelPolicy.zeroRetention && !provider.zeroRetention) throw new AiUnavailable("zero_retention_required", `Agent ${agent.name} requires a zero-retention model`);
  }
  const userSpent = userSpend(config, user);
  if (userSpent + worstCaseUsd > config.ai.userBudgetUsd || userSpent >= config.ai.userBudgetUsd) {
    throw new AiUnavailable("user_budget_exhausted", "Your AI budget for the last 30 days is used up");
  }
  if (agent.spentUsd + worstCaseUsd > agent.budgetUsd || agent.spentUsd >= agent.budgetUsd) {
    throw new AiUnavailable("agent_budget_exhausted", `The budget of agent ${agent.name} is used up`);
  }
}

function userSpend(config: CloudServerConfig, user: CloudUserRecord): number {
  return config.store.aiSpendSince(user.id, new Date(config.now().getTime() - budgetWindowMs).toISOString());
}

function budgetView(config: CloudServerConfig, user: CloudUserRecord, agent: CloudAgentIdentity | undefined): AiStatus["budget"] {
  return {
    userLimitUsd: config.ai.userBudgetUsd,
    userSpentUsd: round(userSpend(config, user)),
    agentId: agent?.id ?? systemAgentId(user.id),
    agentLimitUsd: agent?.budgetUsd ?? config.ai.agentBudgetUsd,
    agentSpentUsd: round(agent?.spentUsd ?? 0),
  };
}

function providerView(config: CloudServerConfig): Pick<AiStatus, "provider" | "model" | "zeroRetention"> {
  const provider = config.ai.provider;
  return provider ? { provider: provider.id, model: provider.model, zeroRetention: provider.zeroRetention } : {};
}

function round(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000;
}

/** Escapes text placed inside the XML-ish data wrappers of a prompt so content cannot close them. */
export function promptData(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function promptAttr(value: string): string {
  return promptData(value).replace(/"/g, "&quot;").replace(/[\r\n]+/g, " ");
}

/** Extracts the first JSON object from a model reply, tolerating a Markdown code fence around it. */
export function parseModelJson(text: string): Record<string, unknown> | undefined {
  const fenced = /```(?:json)?\s*([\s\S]*?)```/.exec(text)?.[1];
  const candidate = (fenced ?? text).trim();
  const start = candidate.indexOf("{");
  const end = candidate.lastIndexOf("}");
  if (start < 0 || end <= start) return undefined;
  try {
    const parsed = JSON.parse(candidate.slice(start, end + 1)) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}
