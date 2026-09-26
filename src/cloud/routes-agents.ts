/** Agent identities, connectors, recipes, and the agent gateway. */
import type { IncomingMessage, ServerResponse } from "node:http";
import { walk } from "../ast.js";
import type { CloudPatchProposal, CloudRole, CloudUserRecord } from "../cloud-db.js";
import type {
  AgentAccessGrant,
  AgentRecipe,
  AgentRun,
  CloudAgentIdentity,
  ConnectorKind,
  ConnectorSourceRecord,
  KnowledgeConnector,
  RecipeRun,
} from "../cloud-platform.js";
import type { PatchOp } from "../patch.js";
import { parse } from "../parser.js";
import { renderLlm } from "../renderer-llm.js";
import {
  type CloudServerConfig,
  type Principal,
  readDocument,
  recordActivity,
  requireAccessRole,
  requireRecordAccess,
  requireResourceAccess,
  requireUser,
  roleRank,
  uniqueId,
} from "./context.js";
import { headerValue, HttpError, readJsonBody, sendJson, sha256Hex } from "./http.js";
import {
  absoluteUrl,
  boundedInteger,
  boundedNumber,
  optionalCloudId,
  optionalRecord,
  optionalString,
  optionalStringArray,
  requiredIsoDate,
  requiredStringArray,
  scalarRecord,
  shaInput,
  stringInput,
  stringPathPart,
} from "./input.js";
import {
  AGENT_COMMENT_CAPABILITY,
  agentDocumentAccess,
  assignmentResponse,
  assignmentStatusInput,
  assignmentThreadRoot,
  recordAgentReply,
  updateAgentAssignment,
} from "./agent-assignments.js";
import { documentHasBlock, documentResponse, updateDocument } from "./records.js";
import { agentChatInbox, callChatGatewayTool } from "./routes-chat.js";
import { createComment } from "./routes-comments.js";
import { knowledgeDocuments, ownedAgent, platformInput } from "./routes-knowledge.js";
import {
  cloudProofRecord,
  createCloudPatchProof,
  patchOpsInput,
  patchReviewDecision,
  stalePatchProposal,
} from "./routes-patch.js";
import { pageQuery, requestUrl } from "./security.js";

export async function routeAgents(req: IncomingMessage, res: ServerResponse, parts: string[], config: CloudServerConfig, principal: Principal): Promise<void> {
  const user = requireUser(principal);
  const method = req.method ?? "GET";
  const agentId = parts[2];
  const action = parts[3];
  const childId = parts[4];
  if (!agentId && method === "GET") {
    const page = pageQuery(requestUrl(req));
    sendJson(res, 200, { agents: config.platform.listAgents(user.id, page).filter((agent) => agent.createdBy === user.id), ...page });
    return;
  }
  if (!agentId && method === "POST") {
    const input = await readJsonBody(req, config.maxBodyBytes);
    const now = config.now().toISOString();
    const modelPolicy = optionalRecord(input.modelPolicy, "modelPolicy") ?? {};
    const agent: CloudAgentIdentity = {
      id: uniqueId(config),
      name: stringInput(input, "name").slice(0, 120),
      ...(optionalString(input.description) ? { description: optionalString(input.description)?.slice(0, 2_000) } : {}),
      createdBy: user.id,
      modelPolicy: {
        model: stringInput(modelPolicy, "model", "local-deterministic"),
        zeroRetention: modelPolicy.zeroRetention === true,
        maxTokensPerRun: boundedInteger(modelPolicy.maxTokensPerRun, 8_000, 128, 1_000_000, "maxTokensPerRun"),
      },
      capabilities: requiredStringArray(input.capabilities, "capabilities", 100),
      budgetUsd: boundedNumber(input.budgetUsd, 25, 0, 1_000_000, "budgetUsd"),
      spentUsd: 0,
      status: "active",
      createdAt: now,
      updatedAt: now,
    };
    sendJson(res, 201, platformInput(() => config.platform.createAgent(agent)));
    return;
  }
  const agent = ownedAgent(config, user, stringPathPart(agentId, "Agent ID"));
  if (!action && method === "GET") {
    sendJson(res, 200, { ...agent, access: config.platform.listAgentAccess(agent.id), runs: config.platform.listAgentRuns(agent.id) });
    return;
  }
  if (action === "access" && method === "GET") {
    sendJson(res, 200, { access: config.platform.listAgentAccess(agent.id) });
    return;
  }
  if (action === "access" && method === "POST") {
    const input = await readJsonBody(req, config.maxBodyBytes);
    const resourceType = input.resourceType === "site" ? "site" : input.resourceType === "document" ? "document" : undefined;
    if (!resourceType) throw new HttpError(400, "resourceType must be document or site");
    const resourceId = stringInput(input, "resourceId");
    const role = input.role === "editor" ? "editor" : input.role === "viewer" ? "viewer" : undefined;
    if (!role) throw new HttpError(400, "role must be viewer or editor");
    await requireResourceAccess(config, principal, resourceType, resourceId, role);
    const now = config.now().toISOString();
    const grant: AgentAccessGrant = { id: uniqueId(config), agentId: agent.id, resourceType, resourceId, role, createdAt: now, updatedAt: now };
    sendJson(res, 201, platformInput(() => config.platform.grantAgentAccess(grant, user.id, now)));
    return;
  }
  if (action === "chat" && !childId && method === "GET") {
    const url = requestUrl(req);
    sendJson(res, 200, { mentions: agentChatInbox(config, agent, url.searchParams.get("status") ?? undefined, pageQuery(url, 25, 100).limit) });
    return;
  }
  if (action === "assignments" && !childId && method === "GET") {
    const url = requestUrl(req);
    sendJson(res, 200, { assignments: listAssignments(config, agent, url.searchParams.get("status") ?? undefined, pageQuery(url)) });
    return;
  }
  if (action === "assignments" && childId && parts[5] === "reply" && method === "POST") {
    const input = await readJsonBody(req, config.maxBodyBytes);
    sendJson(res, 201, await replyToAssignment(config, user, agent, childId, stringInput(input, "body")));
    return;
  }
  if (action === "assignments" && childId && parts[5] === "status" && method === "POST") {
    const input = await readJsonBody(req, config.maxBodyBytes);
    sendJson(res, 200, { assignment: assignmentResponse(config, setAssignmentStatus(config, agent, childId, input)) });
    return;
  }
  if (action === "runs" && !childId && method === "GET") {
    const page = pageQuery(requestUrl(req));
    sendJson(res, 200, { runs: config.platform.listAgentRuns(agent.id, page), ...page });
    return;
  }
  if (action === "runs" && !childId && method === "POST") {
    const input = await readJsonBody(req, config.maxBodyBytes);
    const documentId = optionalCloudId(input.documentId, "Document");
    if (documentId) requireGatewayAgentDocumentAccess(config, agent.id, documentId, "read_doc");
    const run: AgentRun = {
      id: uniqueId(config),
      agentId: agent.id,
      triggeredBy: user.id,
      trigger: agentRunTrigger(input.trigger),
      ...(documentId ? { documentId } : {}),
      status: "running",
      requestedCapabilities: optionalStringArray(input.requestedCapabilities, "requestedCapabilities", 100) ?? [],
      startedAt: config.now().toISOString(),
    };
    sendJson(res, 201, platformInput(() => config.platform.startAgentRun(run)));
    return;
  }
  if (action === "runs" && childId && parts[5] === "complete" && method === "POST") {
    if (!config.platform.listAgentRuns(agent.id).some((run) => run.id === childId)) throw new HttpError(404, "Agent run not found");
    const input = await readJsonBody(req, config.maxBodyBytes);
    const status = input.status === "completed" || input.status === "failed" || input.status === "cancelled" ? input.status : undefined;
    if (!status) throw new HttpError(400, "status must be completed, failed, or cancelled");
    sendJson(res, 200, platformInput(() => config.platform.finishAgentRun(childId, {
      status,
      costUsd: boundedNumber(input.costUsd, 0, 0, 1_000_000, "costUsd"),
      completedAt: config.now().toISOString(),
      ...(optionalRecord(input.output, "output") ? { output: optionalRecord(input.output, "output") } : {}),
    })));
    return;
  }
  throw new HttpError(404, "Unknown agent route");
}

export async function routeConnectors(req: IncomingMessage, res: ServerResponse, parts: string[], config: CloudServerConfig, principal: Principal): Promise<void> {
  const user = requireUser(principal);
  const method = req.method ?? "GET";
  const connectorId = parts[2];
  const action = parts[3];
  if (!connectorId && method === "GET") {
    const connectors = config.platform.listConnectors().filter((connector) => connectorRole(config, user, connector));
    sendJson(res, 200, { connectors: connectors.map(publicConnector) });
    return;
  }
  if (!connectorId && method === "POST") {
    const input = await readJsonBody(req, config.maxBodyBytes);
    const siteId = optionalCloudId(input.siteId, "Site");
    if (siteId) await requireResourceAccess(config, principal, "site", siteId, "editor");
    const now = config.now().toISOString();
    const connector: KnowledgeConnector = {
      id: uniqueId(config),
      kind: connectorKind(input.kind),
      name: stringInput(input, "name").slice(0, 120),
      ...(siteId ? { siteId } : {}),
      status: "active",
      configuration: scalarRecord(input.configuration, "configuration"),
      createdBy: user.id,
      createdAt: now,
      updatedAt: now,
    };
    sendJson(res, 201, publicConnector(platformInput(() => config.platform.putConnector(connector))));
    return;
  }
  const connector = visibleConnector(config, user, stringPathPart(connectorId, "Connector ID"));
  if (!action && method === "GET") {
    sendJson(res, 200, { ...publicConnector(connector), sources: config.platform.listConnectorSources(connector.id) });
    return;
  }
  if (action === "sources" && method === "GET") {
    sendJson(res, 200, { sources: config.platform.listConnectorSources(connector.id) });
    return;
  }
  if (action === "sources" && method === "POST") {
    requireConnectorRole(config, user, connector, "editor");
    const input = await readJsonBody(req, config.maxBodyBytes);
    const documentId = optionalCloudId(input.documentId, "Document");
    if (documentId) {
      await requireResourceAccess(config, principal, "document", documentId, "editor");
      if (connector.siteId && !config.store.readSite(connector.siteId)?.documentIds.includes(documentId)) {
        throw new HttpError(409, "Connector sources must belong to the connector's space");
      }
    }
    const syncedAt = config.now().toISOString();
    const source: ConnectorSourceRecord = {
      id: `${connector.id}:${sha256Hex(stringInput(input, "externalId")).slice(0, 18)}`,
      connectorId: connector.id,
      externalId: stringInput(input, "externalId").slice(0, 500),
      ...(documentId ? { documentId } : {}),
      upstreamPermissions: permissionLineage(input.upstreamPermissions),
      upstreamModifiedAt: requiredIsoDate(input.upstreamModifiedAt, "upstreamModifiedAt"),
      sourceUrl: absoluteUrl(input.sourceUrl, "sourceUrl"),
      contentHash: stringInput(input, "contentHash"),
      lineage: optionalStringArray(input.lineage, "lineage", 500) ?? [],
      ...(input.tombstone === true ? { tombstonedAt: syncedAt } : {}),
      syncedAt,
    };
    sendJson(res, 201, platformInput(() => config.platform.syncConnectorSource(source, user.id)));
    return;
  }
  throw new HttpError(404, "Unknown connector route");
}

export async function routeRecipes(req: IncomingMessage, res: ServerResponse, parts: string[], config: CloudServerConfig, principal: Principal): Promise<void> {
  const user = requireUser(principal);
  const method = req.method ?? "GET";
  const recipeId = parts[2];
  const action = parts[3];
  if (!recipeId && method === "GET") {
    const recipes = config.platform.recipes().filter((recipe) => recipeRole(config, user, recipe));
    sendJson(res, 200, { recipes: recipes.map(publicRecipe) });
    return;
  }
  if (!recipeId && method === "POST") {
    const input = await readJsonBody(req, config.maxBodyBytes);
    const siteId = optionalCloudId(input.siteId, "Site");
    if (siteId) await requireResourceAccess(config, principal, "site", siteId, "editor");
    const now = config.now().toISOString();
    const trigger = optionalRecord(input.trigger, "trigger") ?? {};
    const agentId = optionalString(input.agentId);
    const capabilitySet = requiredStringArray(input.capabilitySet, "capabilitySet", 100);
    if (agentId) {
      const agent = ownedAgent(config, user, agentId);
      const ungranted = capabilitySet.find((capability) => !agent.capabilities.includes(capability));
      if (ungranted) throw new HttpError(409, `Recipe requests an ungranted agent capability: ${ungranted}`);
    }
    const webhookSecretHash = trigger.webhookSecretHash === undefined ? undefined : shaInput(trigger.webhookSecretHash, "trigger.webhookSecretHash");
    const recipe: AgentRecipe = {
      id: uniqueId(config),
      name: stringInput(input, "name").slice(0, 120),
      purpose: "custom",
      ...(siteId ? { siteId } : {}),
      ...(agentId ? { agentId } : {}),
      trigger: {
        modes: recipeTriggerModes(trigger.modes),
        ...(optionalString(trigger.schedule) ? { schedule: optionalString(trigger.schedule) } : {}),
        ...(optionalString(trigger.event) ? { event: optionalString(trigger.event) } : {}),
        ...(webhookSecretHash ? { webhookSecretHash } : {}),
      },
      capabilitySet,
      steps: requiredStringArray(input.steps, "steps", 100),
      enabled: input.enabled !== false,
      createdBy: user.id,
      createdAt: now,
      updatedAt: now,
    };
    sendJson(res, 201, publicRecipe(config.platform.putRecipe(recipe)));
    return;
  }
  if (action === "runs" && method === "GET") {
    requireRecipeRole(config, user, stringPathPart(recipeId, "Recipe ID"), "viewer");
    sendJson(res, 200, { runs: config.platform.listRecipeRuns(recipeId) });
    return;
  }
  if (action === "runs" && method === "POST") {
    const input = await readJsonBody(req, config.maxBodyBytes);
    const recipe = requireRecipeRole(config, user, stringPathPart(recipeId, "Recipe ID"), "editor");
    const triggerMode = recipeTriggerMode(input.triggerMode);
    if (triggerMode === "webhook") requireRecipeWebhookSecret(req, recipe);
    const run: RecipeRun = {
      id: uniqueId(config),
      recipeId: stringPathPart(recipeId, "Recipe ID"),
      triggeredBy: user.id,
      triggerMode,
      input: optionalRecord(input.input, "input") ?? {},
      status: "planned",
      plan: [],
      mutationPolicy: "proof_proposal_only",
      startedAt: config.now().toISOString(),
    };
    sendJson(res, 201, platformInput(() => config.platform.runRecipe(run)));
    return;
  }
  throw new HttpError(404, "Unknown recipe route");
}

export async function routeAgentGateway(req: IncomingMessage, res: ServerResponse, parts: string[], config: CloudServerConfig, principal: Principal): Promise<void> {
  const user = requireUser(principal);
  const method = req.method ?? "GET";
  const action = parts[2];
  if (!action && method === "GET") {
    sendJson(res, 200, { protocol: "noma-agent-gateway-v1", transports: ["api", "mcp", "webhook"], capabilities: config.platform.gatewayCapabilities() });
    return;
  }
  if (action === "list-ids" && method === "POST") {
    const input = await readJsonBody(req, config.maxBodyBytes);
    const agentId = stringInput(input, "agentId");
    ownedAgent(config, user, agentId);
    const documentId = stringInput(input, "documentId");
    requireGatewayAgentDocumentAccess(config, agentId, documentId, "list_ids");
    const document = await readDocument(config, documentId);
    const doc = parse(document.source, { filename: `${document.id}.noma` });
    const ids = [...walk(doc)].filter((node) => node.id).map((node) => ({ id: node.id!, aliases: node.aliases ?? [], type: node.type, line: node.pos?.line, endLine: node.endLine }));
    sendJson(res, 200, { documentId, versionHash: document.hash, ids });
    return;
  }
  if (action === "mcp" && method === "POST") {
    const input = await readJsonBody(req, config.maxBodyBytes);
    const requestId = input.id ?? null;
    if (input.jsonrpc !== "2.0") throw new HttpError(400, "MCP request must use JSON-RPC 2.0");
    if (input.method === "tools/list") {
      sendJson(res, 200, {
        jsonrpc: "2.0",
        id: requestId,
        result: {
          tools: config.platform.gatewayCapabilities().filter((capability) => capability.operation !== "webhook").map((capability) => ({
            name: capability.operation,
            description: `Noma Cloud ${capability.operation.replace("_", " ")} with ${capability.permission} scope`,
            inputSchema: { type: "object", additionalProperties: true },
          })),
        },
      });
      return;
    }
    if (input.method === "tools/call") {
      const params = optionalRecord(input.params, "params") ?? {};
      const name = stringInput(params, "name");
      const args = optionalRecord(params.arguments, "params.arguments") ?? {};
      const result = await callGatewayTool(name, args, config, principal, user);
      sendJson(res, 200, { jsonrpc: "2.0", id: requestId, result: { content: [{ type: "text", text: JSON.stringify(result) }], structuredContent: result } });
      return;
    }
    throw new HttpError(400, "Unsupported MCP method");
  }
  if (action === "webhooks" && parts[3] && method === "POST") {
    const recipe = requireRecipeRole(config, user, parts[3], "editor");
    requireRecipeWebhookSecret(req, recipe);
    const input = await readJsonBody(req, config.maxBodyBytes);
    const run: RecipeRun = { id: uniqueId(config), recipeId: parts[3], triggeredBy: user.id, triggerMode: "webhook", input, status: "planned", plan: [], mutationPolicy: "proof_proposal_only", startedAt: config.now().toISOString() };
    sendJson(res, 202, platformInput(() => config.platform.runRecipe(run)));
    return;
  }
  throw new HttpError(404, "Unknown gateway route");
}

async function callGatewayTool(
  name: string,
  args: Record<string, unknown>,
  config: CloudServerConfig,
  principal: Principal,
  user: CloudUserRecord,
): Promise<Record<string, unknown>> {
  const now = config.now().toISOString();
  if (name === "search" || name === "cited_answer") {
    const agentId = stringInput(args, "agentId");
    ownedAgent(config, user, agentId);
    const query = stringInput(args, "query").slice(0, 1_000);
    const siteId = optionalCloudId(args.siteId, "Site");
    const documents = knowledgeDocuments(config, user, siteId, agentId);
    if (name === "search") {
      const { results, retrieval } = await config.platform.searchWithRetrieval({ principalId: agentId, query, documents, now, limit: boundedInteger(args.limit, 12, 1, 100, "limit") });
      return { query, results, retrieval };
    }
    return (await config.platform.askWithRetrieval({ principalId: agentId, query, documents, now, limit: boundedInteger(args.limit, 8, 1, 25, "limit") })) as unknown as Record<string, unknown>;
  }
  if (name === "llm_export") {
    const agentId = stringInput(args, "agentId");
    ownedAgent(config, user, agentId);
    const siteId = optionalCloudId(args.siteId, "Site");
    const documents = knowledgeDocuments(config, user, siteId, agentId);
    return {
      documents: documents.map((access) => ({
        documentId: access.document.id,
        versionHash: access.document.hash,
        accessDecision: { principalId: agentId, allowed: true, role: access.role, via: access.via, decidedAt: now },
        context: renderLlm(parse(access.document.source, { filename: `${access.document.id}.noma` })),
      })),
    };
  }
  if (name === "list_ids") {
    const agentId = stringInput(args, "agentId");
    ownedAgent(config, user, agentId);
    const documentId = stringInput(args, "documentId");
    requireGatewayAgentDocumentAccess(config, agentId, documentId, "list_ids");
    const document = await readDocument(config, documentId);
    const doc = parse(document.source, { filename: `${document.id}.noma` });
    return { documentId, versionHash: document.hash, ids: [...walk(doc)].filter((node) => node.id).map((node) => ({ id: node.id!, aliases: node.aliases ?? [], type: node.type, line: node.pos?.line, endLine: node.endLine })) };
  }
  if (name === "proof" || name === "proposal") {
    const agentId = stringInput(args, "agentId");
    const documentId = stringInput(args, "documentId");
    ownedAgent(config, user, agentId);
    const grant = requireGatewayAgentDocumentAccess(config, agentId, documentId, "patch_block");
    if (grant.role !== "editor") throw new HttpError(403, "Agent editor access is required for patch proposals");
    const document = await readDocument(config, documentId);
    const ops = patchOpsInput(args.ops);
    const proof = createCloudPatchProof(config, document, ops);
    const proofRecord = { ...cloudProofRecord(proof), agentId };
    if (name === "proof" || !proof.canWrite) return { proof: proofRecord, proposed: false };
    const proposal: Omit<CloudPatchProposal, "proposedByName"> = {
      id: uniqueId(config),
      documentId,
      documentHash: document.hash,
      proposedBy: user.id,
      summary: optionalString(args.summary)?.slice(0, 500) ?? `Proposal from ${config.platform.readAgent(agentId)?.name ?? agentId}`,
      ops,
      proof: proofRecord,
      status: "pending",
      createdAt: now,
      updatedAt: now,
    };
    const assignmentId = optionalString(args.assignmentId);
    const assignment = assignmentId ? ownedAssignment(config, config.platform.readAgent(agentId)!, assignmentId) : undefined;
    if (assignment && assignment.documentId !== documentId) throw new HttpError(400, "The assignment is for a different document");
    config.store.writePatchProposal(proposal);
    recordActivity(config, user, "patch.proposed", "document", documentId, { proposalId: proposal.id, agentId, transport: "mcp", ...(assignment ? { assignmentId: assignment.id } : {}) });
    const linked = assignment ? updateAgentAssignment(config, assignment, { proposalId: proposal.id }) : undefined;
    return { proposed: true, proposal: config.store.readPatchProposal(proposal.id), ...(linked ? { assignment: assignmentResponse(config, linked) } : {}) };
  }
  if (name === "assignments") {
    const agent = ownedAgent(config, user, stringInput(args, "agentId"));
    return { assignments: listAssignments(config, agent, optionalString(args.status), { limit: boundedInteger(args.limit, 50, 1, 200, "limit"), offset: 0 }) };
  }
  if (name === "reply") {
    const agent = ownedAgent(config, user, stringInput(args, "agentId"));
    return await replyToAssignment(config, user, agent, stringInput(args, "assignmentId"), stringInput(args, "body"));
  }
  if (name === "update_assignment") {
    const agent = ownedAgent(config, user, stringInput(args, "agentId"));
    return { assignment: assignmentResponse(config, setAssignmentStatus(config, agent, stringInput(args, "assignmentId"), args)) };
  }
  if (name === "chat_inbox" || name === "chat_history" || name === "chat_post") {
    return await callChatGatewayTool(name, args, config, principal, ownedAgent(config, user, stringInput(args, "agentId")));
  }
  if (name === "review") {
    const documentId = stringInput(args, "documentId");
    const document = await readDocument(config, documentId);
    const access = requireRecordAccess(config, document, principal, "editor");
    requireAccessRole(access, "editor");
    const proposal = config.store.readPatchProposal(stringInput(args, "proposalId"));
    if (!proposal || proposal.documentId !== document.id) throw new HttpError(404, "Patch proposal not found");
    if (proposal.status !== "pending") throw new HttpError(409, "Only pending proposals can be reviewed");
    if (proposal.documentHash !== document.hash) throw stalePatchProposal(proposal, document);
    const decision = patchReviewDecision(args.decision);
    if (decision === "approved" && proposal.proposedBy === user.id) throw new HttpError(409, "A different collaborator must approve an agent patch");
    config.store.writePatchProposal({ ...proposal, status: decision, reviewedBy: user.id, reviewedAt: now, updatedAt: now });
    return { proposal: config.store.readPatchProposal(proposal.id) };
  }
  if (name === "apply") {
    const documentId = stringInput(args, "documentId");
    const document = await readDocument(config, documentId);
    const access = requireRecordAccess(config, document, principal, "editor");
    const proposal = config.store.readPatchProposal(stringInput(args, "proposalId"));
    if (!proposal || proposal.documentId !== document.id) throw new HttpError(404, "Patch proposal not found");
    if (proposal.status !== "approved") throw new HttpError(409, "The proposal must be approved before it can be applied");
    if (proposal.documentHash !== document.hash) throw stalePatchProposal(proposal, document);
    const proof = createCloudPatchProof(config, document, proposal.ops as PatchOp[]);
    if (!proof.canWrite || proof.preHash.sha256 !== proposal.documentHash) throw new HttpError(409, "Patch proof no longer matches the current document", { proof: cloudProofRecord(proof) });
    const updated = await updateDocument(config, document, { source: proof.postSource }, access);
    config.store.writePatchProposal({ ...proposal, status: "applied", appliedHash: updated.hash, updatedAt: now });
    return { proposal: config.store.readPatchProposal(proposal.id), document: documentResponse(updated, access, config) };
  }
  throw new HttpError(400, `Unknown gateway tool: ${name}`);
}

function listAssignments(config: CloudServerConfig, agent: CloudAgentIdentity, status: string | undefined, page: { limit: number; offset: number }) {
  const wanted = status === undefined || status === "" || status === "all" ? undefined : status === "active" ? ["open", "in_progress"] : [assignmentStatusInput(status)];
  const all = config.platform.listAgentAssignments({ agentId: agent.id });
  return all
    .filter((assignment) => !wanted || wanted.includes(assignment.status))
    .slice(page.offset, page.offset + page.limit)
    .map((assignment) => {
      if (!agentDocumentAccess(config, agent.id, assignment.documentId)) {
        const { request: _request, ...rest } = assignment;
        return { ...rest, agentName: agent.name, accessRevoked: true as const };
      }
      const document = config.store.readDocument(assignment.documentId);
      const root = assignmentThreadRoot(config, assignment);
      return {
        ...assignmentResponse(config, assignment),
        ...(document ? { documentHash: document.hash } : {}),
        ...(root ? { thread: [root, ...config.store.listComments(assignment.documentId).filter((comment) => comment.parentId === root.id)].filter((comment) => !comment.deletedAt).slice(0, 50).map((comment) => ({ id: comment.id, body: comment.body, author: comment.createdByName, ...(comment.agentId ? { agentId: comment.agentId } : {}), createdAt: comment.createdAt })) } : {}),
      };
    });
}

function ownedAssignment(config: CloudServerConfig, agent: CloudAgentIdentity, assignmentId: string) {
  const assignment = config.platform.readAgentAssignment(assignmentId);
  if (!assignment || assignment.agentId !== agent.id) throw new HttpError(404, "Assignment not found");
  return assignment;
}

async function replyToAssignment(config: CloudServerConfig, owner: CloudUserRecord, agent: CloudAgentIdentity, assignmentId: string, body: string) {
  const assignment = ownedAssignment(config, agent, assignmentId);
  if (!agent.capabilities.includes(AGENT_COMMENT_CAPABILITY)) throw new HttpError(403, `Agent lacks capability: ${AGENT_COMMENT_CAPABILITY}`);
  if (!agentDocumentAccess(config, agent.id, assignment.documentId)) throw new HttpError(403, "The agent can no longer work on this page");
  const document = await readDocument(config, assignment.documentId);
  const root = assignmentThreadRoot(config, assignment);
  const blockId = !root && assignment.blockId && documentHasBlock(document, assignment.blockId) ? assignment.blockId : undefined;
  const comment = createComment(config, owner, document, { body, ...(root ? { parentId: root.id } : {}), ...(blockId ? { blockId } : {}) }, agent.id);
  const updated = recordAgentReply(config, assignment, comment.id);
  return { comment, assignment: assignmentResponse(config, updated) };
}

function setAssignmentStatus(config: CloudServerConfig, agent: CloudAgentIdentity, assignmentId: string, input: Record<string, unknown>) {
  const assignment = ownedAssignment(config, agent, assignmentId);
  const proposalId = optionalString(input.proposalId);
  if (proposalId) {
    const proposal = config.store.readPatchProposal(proposalId);
    if (!proposal || proposal.documentId !== assignment.documentId) throw new HttpError(400, "proposalId must be a proposal on the assignment's page");
  }
  const note = optionalString(input.note);
  return updateAgentAssignment(config, assignment, {
    ...(input.status === undefined ? {} : { status: assignmentStatusInput(input.status) }),
    ...(note !== undefined ? { note } : {}),
    ...(proposalId ? { proposalId } : {}),
  });
}

function requireGatewayAgentDocumentAccess(config: CloudServerConfig, agentId: string, documentId: string, capability: string): AgentAccessGrant {
  const agent = config.platform.readAgent(agentId);
  if (!agent || agent.status !== "active") throw new HttpError(403, "Agent identity is not active");
  if (!agent.capabilities.includes(capability)) throw new HttpError(403, `Agent lacks capability: ${capability}`);
  const grants = config.platform.listAgentAccess(agentId);
  const direct = grants.find((grant) => grant.resourceType === "document" && grant.resourceId === documentId);
  const inherited = grants.find((grant) => grant.resourceType === "site" && config.store.readSite(grant.resourceId)?.documentIds.includes(documentId));
  const grant = direct ?? inherited;
  if (!grant) throw new HttpError(403, "Agent has no explicit page or space grant for this document");
  const ownerRole = config.store.documentAccessRole(agent.createdBy, documentId);
  if (!ownerRole) throw new HttpError(403, "The agent's owner no longer has access to this document");
  if (ownerRole !== "owner" && roleRank[ownerRole] < roleRank[grant.role]) return { ...grant, role: ownerRole };
  return grant;
}

function agentRunTrigger(value: unknown): AgentRun["trigger"] {
  if (value === "scheduled" || value === "event" || value === "webhook") return value;
  if (value === undefined || value === "manual") return "manual";
  throw new HttpError(400, "trigger must be manual, scheduled, event, or webhook");
}

function connectorKind(value: unknown): ConnectorKind {
  if (value === "github" || value === "slack" || value === "google_drive" || value === "jira" || value === "linear" || value === "filesystem") return value;
  throw new HttpError(400, "Unsupported connector kind");
}

export function connectorKinds(value: unknown): ConnectorKind[] {
  return requiredStringArray(value, "connectorAllowlist", 6).map(connectorKind);
}

function visibleConnector(config: CloudServerConfig, user: CloudUserRecord, connectorId: string): KnowledgeConnector {
  const connector = config.platform.listConnectors().find((item) => item.id === connectorId);
  if (!connector) throw new HttpError(404, "Connector not found");
  if (!connectorRole(config, user, connector)) throw new HttpError(403, "Connector access is required");
  return connector;
}

function connectorRole(config: CloudServerConfig, user: CloudUserRecord, connector: KnowledgeConnector): CloudRole | undefined {
  if (connector.createdBy === user.id) return "owner";
  return connector.siteId ? config.store.resourceAccess(user.id, "site", connector.siteId)?.role : undefined;
}

function requireConnectorRole(config: CloudServerConfig, user: CloudUserRecord, connector: KnowledgeConnector, role: CloudRole): CloudRole {
  const actual = connectorRole(config, user, connector);
  if (!actual || roleRank[actual] < roleRank[role]) throw new HttpError(403, `${role} connector access is required`);
  return actual;
}

function publicConnector(connector: KnowledgeConnector): Omit<KnowledgeConnector, "configuration"> & { configurationKeys: string[] } {
  const { configuration, ...safe } = connector;
  return { ...safe, configurationKeys: Object.keys(configuration).sort() };
}

function recipeRole(config: CloudServerConfig, user: CloudUserRecord, recipe: AgentRecipe): CloudRole | undefined {
  if (recipe.createdBy === "system" || recipe.createdBy === user.id) return "owner";
  return recipe.siteId ? config.store.resourceAccess(user.id, "site", recipe.siteId)?.role : undefined;
}

function requireRecipeRole(config: CloudServerConfig, user: CloudUserRecord, recipeId: string, role: CloudRole): AgentRecipe {
  const recipe = config.platform.recipes().find((item) => item.id === recipeId);
  if (!recipe) throw new HttpError(404, "Recipe not found");
  const actual = recipeRole(config, user, recipe);
  if (!actual || roleRank[actual] < roleRank[role]) throw new HttpError(403, `${role} recipe access is required`);
  return recipe;
}

function publicRecipe(recipe: AgentRecipe): Record<string, unknown> {
  const { webhookSecretHash, ...trigger } = recipe.trigger;
  return { ...recipe, trigger: { ...trigger, webhookSecretConfigured: webhookSecretHash !== undefined } };
}

function requireRecipeWebhookSecret(req: IncomingMessage, recipe: AgentRecipe): void {
  if (!recipe.trigger.webhookSecretHash) return;
  const secret = headerValue(req, "x-noma-recipe-webhook-secret");
  if (!secret || sha256Hex(secret) !== recipe.trigger.webhookSecretHash) throw new HttpError(401, "Valid recipe webhook secret required");
}

function permissionLineage(value: unknown): ConnectorSourceRecord["upstreamPermissions"] {
  if (!Array.isArray(value)) throw new HttpError(400, "upstreamPermissions must be an array");
  return value.map((item, index) => {
    const record = optionalRecord(item, `upstreamPermissions[${index}]`)!;
    return { principal: stringInput(record, "principal"), role: stringInput(record, "role") };
  });
}

function recipeTriggerModes(value: unknown): AgentRecipe["trigger"]["modes"] {
  return requiredStringArray(value, "trigger.modes", 4).map(recipeTriggerMode);
}

function recipeTriggerMode(value: unknown): RecipeRun["triggerMode"] {
  if (value === "manual" || value === "scheduled" || value === "event" || value === "webhook") return value;
  throw new HttpError(400, "trigger mode must be manual, scheduled, event, or webhook");
}
