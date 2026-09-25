/** Patch proposals and agent safety proofs (`/api/documents/:id/patch-proposals`). */
import type { IncomingMessage, ServerResponse } from "node:http";
import { join } from "node:path";
import type { CloudDocumentRecord, CloudIssue, CloudPatchProposal } from "../cloud-db.js";
import type { PatchOp } from "../patch.js";
import { createAgentSafetyProof, type AgentSafetyProof } from "../proof.js";
import {
  type AccessContext,
  type CloudServerConfig,
  type Principal,
  recordActivity,
  recordIssueEvent,
  requireAccessRole,
  requireProjectAccess,
  requireRecordAccess,
  requireUser,
  uniqueId,
} from "./context.js";
import { HttpError, readJsonBody, sendJson } from "./http.js";
import { assertCloudId, optionalString } from "./input.js";
import { documentResponse, updateDocument } from "./records.js";

export async function routePatchProposals(
  req: IncomingMessage,
  res: ServerResponse,
  proposalId: string | undefined,
  action: string | undefined,
  config: CloudServerConfig,
  principal: Principal,
  document: CloudDocumentRecord,
  inheritedAccess?: AccessContext,
): Promise<void> {
  const method = req.method ?? "GET";
  const access = inheritedAccess ?? requireRecordAccess(config, document, principal, "viewer");
  const user = requireUser(principal);
  if (!proposalId && method === "GET") {
    sendJson(res, 200, { proposals: config.store.listPatchProposals(document.id) });
    return;
  }
  if (!proposalId && method === "POST") {
    requireAccessRole(access, "editor");
    const input = await readJsonBody(req, config.maxBodyBytes);
    const ops = patchOpsInput(input.ops);
    const issueId = optionalString(input.issueId);
    const issue = issueId ? linkedPatchIssue(config, principal, document, issueId) : undefined;
    const proof = createCloudPatchProof(config, document, ops);
    const proofRecord = cloudProofRecord(proof);
    if (!proof.canWrite) throw new HttpError(422, "Patch proof failed", { proof: proofRecord });
    const now = config.now().toISOString();
    const proposal: Omit<CloudPatchProposal, "proposedByName"> = {
      id: uniqueId(config),
      documentId: document.id,
      documentHash: document.hash,
      ...(issue ? { issueId: issue.id } : {}),
      proposedBy: user.id,
      ...(optionalString(input.summary) ? { summary: optionalString(input.summary)?.slice(0, 500) } : {}),
      ops,
      proof: proofRecord,
      status: "pending",
      createdAt: now,
      updatedAt: now,
    };
    config.store.writePatchProposal(proposal);
    recordActivity(config, user, "patch.proposed", "document", document.id, { proposalId: proposal.id, issueId: issue?.id });
    if (issue) recordIssueEvent(config, user, issue.id, "patch.proposed", { proposalId: proposal.id, documentId: document.id, documentHash: document.hash });
    sendJson(res, 201, config.store.readPatchProposal(proposal.id));
    return;
  }
  if (!proposalId) throw new HttpError(404, "Patch proposal ID is required");
  assertCloudId(proposalId, "Patch proposal");
  const proposal = config.store.readPatchProposal(proposalId);
  if (!proposal || proposal.documentId !== document.id) throw new HttpError(404, "Patch proposal not found");
  if (!action && method === "GET") {
    sendJson(res, 200, proposal);
    return;
  }
  if (action === "review" && method === "POST") {
    requireAccessRole(access, "editor");
    if (proposal.status !== "pending") throw new HttpError(409, "Only pending proposals can be reviewed");
    if (document.hash !== proposal.documentHash) throw stalePatchProposal(proposal, document);
    const input = await readJsonBody(req, config.maxBodyBytes);
    const decision = patchReviewDecision(input.decision);
    if (decision === "approved" && proposal.proposedBy === user.id) {
      throw new HttpError(409, "A different collaborator must approve an agent patch");
    }
    const now = config.now().toISOString();
    config.store.writePatchProposal({ ...proposal, status: decision, reviewedBy: user.id, reviewedAt: now, updatedAt: now });
    recordActivity(config, user, `patch.${decision}`, "document", document.id, { proposalId: proposal.id, issueId: proposal.issueId });
    if (proposal.issueId) recordIssueEvent(config, user, proposal.issueId, `patch.${decision}`, { proposalId: proposal.id, documentId: document.id });
    sendJson(res, 200, config.store.readPatchProposal(proposal.id));
    return;
  }
  if (action === "apply" && method === "POST") {
    requireAccessRole(access, "editor");
    if (proposal.status !== "approved") throw new HttpError(409, "The proposal must be approved before it can be applied");
    if (document.hash !== proposal.documentHash) throw stalePatchProposal(proposal, document);
    const proof = createCloudPatchProof(config, document, proposal.ops as PatchOp[]);
    if (!proof.canWrite || proof.preHash.sha256 !== proposal.documentHash) {
      throw new HttpError(409, "Patch proof no longer matches the current document", { proof: cloudProofRecord(proof) });
    }
    const updated = await updateDocument(config, document, { source: proof.postSource }, access);
    const now = config.now().toISOString();
    config.store.writePatchProposal({ ...proposal, status: "applied", appliedHash: updated.hash, updatedAt: now });
    recordActivity(config, user, "patch.applied", "document", document.id, { proposalId: proposal.id, issueId: proposal.issueId, hash: updated.hash });
    if (proposal.issueId) {
      recordIssueEvent(config, user, proposal.issueId, "patch.applied", {
        proposalId: proposal.id,
        documentId: document.id,
        beforeHash: proposal.documentHash,
        afterHash: updated.hash,
      });
    }
    sendJson(res, 200, { proposal: config.store.readPatchProposal(proposal.id), document: documentResponse(updated, access, config) });
    return;
  }
  throw new HttpError(404, "Unknown patch proposal route");
}

export function patchOpsInput(value: unknown): PatchOp[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > 100) throw new HttpError(400, "ops must be an array with 1-100 patch operations");
  for (const op of value) {
    if (!op || typeof op !== "object" || Array.isArray(op) || typeof (op as { op?: unknown }).op !== "string") {
      throw new HttpError(400, "Each patch operation must be an object with an op name");
    }
  }
  return value as PatchOp[];
}

function linkedPatchIssue(
  config: CloudServerConfig,
  principal: Principal,
  document: CloudDocumentRecord,
  issueId: string,
): CloudIssue {
  const issue = config.store.readIssue(issueId);
  if (!issue) throw new HttpError(404, "Linked issue not found");
  const project = config.store.readProject(issue.projectId);
  if (!project) throw new HttpError(404, "Linked issue project not found");
  requireProjectAccess(config, project, principal, "editor");
  const site = config.store.readSite(project.siteId);
  if (!site?.documentIds.includes(document.id)) throw new HttpError(400, "Linked issue must belong to the space containing this document");
  return issue;
}

export function createCloudPatchProof(config: CloudServerConfig, document: CloudDocumentRecord, ops: PatchOp[]): AgentSafetyProof {
  return createAgentSafetyProof({
    filePath: join(config.dataDir, `${document.id}.noma`),
    source: document.source,
    ops,
    prevalidate: true,
    postvalidate: true,
    artifactOptions: { allowEscapeHatches: false, externalAssets: false, interactive: false },
    inlineSources: false,
  });
}

export function cloudProofRecord(proof: AgentSafetyProof): Record<string, unknown> {
  return {
    status: proof.status,
    patchResult: proof.patchResult,
    canWrite: proof.canWrite,
    preHash: proof.preHash,
    postHash: proof.postHash,
    preValidation: proof.preValidation,
    postValidation: proof.postValidation,
    preDiagnostics: proof.preDiagnostics,
    postDiagnostics: proof.postDiagnostics,
    sourceMetrics: proof.sourceMetrics,
    diff: proof.diff,
    idRegistry: proof.idRegistry,
    artifactPreviewHtml: proof.artifactPreviewHtml,
    ...(proof.error ? { error: proof.error } : {}),
  };
}

export function patchReviewDecision(value: unknown): "approved" | "rejected" {
  if (value === "approved" || value === "rejected") return value;
  throw new HttpError(400, "decision must be approved or rejected");
}

export function stalePatchProposal(proposal: CloudPatchProposal, document: CloudDocumentRecord): HttpError {
  return new HttpError(409, "This patch proposal targets an older document version", {
    code: "patch_proposal_stale",
    proposalHash: proposal.documentHash,
    currentHash: document.hash,
  });
}
