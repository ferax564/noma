/**
 * Capability registry for agent-initiated actions — the single source of truth for how the governance
 * gate (`governance.ts`) treats each action kind. Ported from keepop's capability model:
 *
 *   read_only          reads and dry runs — no write, no approval
 *   approve_to_execute writes — need a hash-bound approval (or a standing human policy) and a trust tier
 *   propose_only       bright lines — an agent may propose them, but the gate never executes them,
 *                      even with an approval on record; a person performs them by hand
 *
 * Anything not registered here is denied by default.
 */

export type CapabilityClass = "read_only" | "approve_to_execute" | "propose_only";

/** Per-space agent trust tier: 0 read-only, 1 propose content, 2 run tests, 3 run deploys. */
export type AgentTrustTier = 0 | 1 | 2 | 3;

export const TRUST_TIER_LABELS: Record<AgentTrustTier, string> = {
  0: "read-only",
  1: "propose content",
  2: "run tests",
  3: "run deploys",
};

/** Default tier for spaces nobody has configured: everything agents could do before the tiers existed. */
export const DEFAULT_TRUST_TIER: AgentTrustTier = 3;

export interface ActionCapability {
  kind: string;
  capabilityClass: CapabilityClass;
  /** Lowest space trust tier at which an agent may request (and, where allowed, execute) this action. */
  minTier: AgentTrustTier;
  /**
   * For `approve_to_execute`: the human policy that may stand in for a per-action approval record.
   * Absent means every execution needs a decision in the log whose payload hash matches.
   */
  standingPolicy?: string;
  description: string;
}

const registry: ReadonlyArray<ActionCapability> = [
  { kind: "page.read", capabilityClass: "read_only", minTier: 0, description: "Search, cited answers, LLM export, block IDs, and patch dry-run proofs" },
  { kind: "chat.read", capabilityClass: "read_only", minTier: 0, description: "Chat inbox and channel history" },
  { kind: "assignment.read", capabilityClass: "read_only", minTier: 0, description: "The agent's own assignments" },

  { kind: "page.patch", capabilityClass: "approve_to_execute", minTier: 1, description: "Apply a block-level patch proposal to a page" },
  { kind: "page.create", capabilityClass: "approve_to_execute", minTier: 1, description: "Create an AI-drafted page in a space" },
  { kind: "comment.post", capabilityClass: "approve_to_execute", minTier: 1, standingPolicy: "the owner granted the comment capability and page access", description: "Reply on a page comment thread" },
  { kind: "chat.post", capabilityClass: "approve_to_execute", minTier: 1, standingPolicy: "the owner granted the chat capability and channel access", description: "Post a chat message as the agent" },
  { kind: "assignment.update", capabilityClass: "approve_to_execute", minTier: 1, standingPolicy: "a person assigned the work", description: "Update the status of the agent's own assignment" },
  { kind: "run.test", capabilityClass: "approve_to_execute", minTier: 2, standingPolicy: "the project owner turned off approval for agent runs", description: "Start a test run on the run environment" },
  { kind: "run.deploy", capabilityClass: "approve_to_execute", minTier: 3, standingPolicy: "the project owner turned off approval for agent runs", description: "Deploy a preview on the run environment" },

  { kind: "page.delete", capabilityClass: "propose_only", minTier: 1, description: "Trash or purge pages or spaces" },
  { kind: "run.teardown", capabilityClass: "propose_only", minTier: 1, description: "Tear down a preview or test environment" },
  { kind: "access.change", capabilityClass: "propose_only", minTier: 1, description: "Permissions, page restrictions, share links, agent grants, or trust tiers" },
  { kind: "retention.change", capabilityClass: "propose_only", minTier: 1, description: "Retention policy, legal holds, or chat retention" },
  { kind: "external.publish", capabilityClass: "propose_only", minTier: 1, description: "Publish outside the workspace (public links, exports, outbound integrations)" },
  { kind: "repo.change", capabilityClass: "propose_only", minTier: 1, description: "Link, unlink, or reconfigure a project repository or its webhook secret" },
  { kind: "agent.config", capabilityClass: "propose_only", minTier: 1, description: "Agent capabilities, budgets, hosting, or the workspace kill switch" },
];

const byKind = new Map(registry.map((entry) => [entry.kind, entry]));

/** The capability entry for `kind`; undefined means the action is unregistered and must be denied. */
export function lookupCapability(kind: string): ActionCapability | undefined {
  return byKind.get(kind);
}

/** Every registered action kind, in registry order. */
export function listCapabilities(): ActionCapability[] {
  return registry.map((entry) => ({ ...entry }));
}

/**
 * Agent gateway tools → the action kind the gate checks. `review` and `apply` are the human side of
 * the proposal loop (the caller decides or executes); `action_propose` names its kind in its arguments.
 * A tool missing from this map is denied by default.
 */
export const GATEWAY_TOOL_KINDS: Readonly<Record<string, string>> = {
  search: "page.read",
  cited_answer: "page.read",
  llm_export: "page.read",
  list_ids: "page.read",
  proof: "page.read",
  proposal: "page.patch",
  review: "page.patch",
  apply: "page.patch",
  assignments: "assignment.read",
  reply: "comment.post",
  update_assignment: "assignment.update",
  chat_inbox: "chat.read",
  chat_history: "chat.read",
  chat_post: "chat.post",
  run_request: "run.*",
  action_propose: "*",
};

export function trustTierInput(value: unknown): AgentTrustTier | undefined {
  return value === 0 || value === 1 || value === 2 || value === 3 ? value : undefined;
}

/** JSON with object keys sorted at every depth and `undefined` fields dropped — the bytes an approval binds to. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value ?? null);
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item === undefined ? null : item)).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(",")}}`;
}
