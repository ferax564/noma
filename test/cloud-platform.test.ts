import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { CloudDocumentRecord, CloudPatchProposal } from "../src/cloud-db.js";
import {
  CloudKnowledgePlatform,
  type AgentRecipe,
  type CloudAgentIdentity,
  type EnterprisePolicy,
  type KnowledgeDocumentAccess,
  type NomaBackupBundle,
} from "../src/cloud-platform.js";
import { sha256Hex } from "../src/hash.js";

const now = "2026-07-14T10:00:00.000Z";

test("hybrid RAG preserves exact Noma identity, permissions, trust, freshness, and citations", async () => {
  await withPlatform((platform) => {
    const publicDoc = document("deployment", "Deployment", `# Deployment

::decision{id="deploy-target" status="open" owner="alice"}
Production deploys to Zurich with an active-active database.
::

See [[Runbook]] and [[Missing Policy]].
`);
    const runbook = document("runbook", "Runbook", `# Runbook

::claim{id="recovery" owner="ops"}
The recovery target is fifteen minutes for the Zurich deployment.
::
`);
    const secret = document("secret", "Restricted acquisition", `# Restricted acquisition

::claim{id="secret-price"}
The confidential acquisition price is 900 million francs.
::
`);
    platform.putTrust({
      documentId: publicDoc.id,
      blockId: "deploy-target",
      ownerId: "alice",
      verifiedBy: "reviewer",
      verifiedAt: "2026-07-01T09:00:00.000Z",
      reviewBy: "2027-01-01T00:00:00.000Z",
      canonicalFor: ["production deployment target"],
      sourceOf: ["https://ops.example/deployments/production"],
      updatedAt: now,
      updatedBy: "alice",
    });
    const access = allowed(publicDoc, runbook);
    const results = platform.search({ principalId: "alice", query: "Where does production deploy?", documents: access, now });
    assert.ok(results.length > 0);
    const citation = results.find((result) => result.blockId === "deploy-target" && result.contentType === "decision");
    assert.ok(citation);
    assert.equal(citation.documentId, publicDoc.id);
    assert.equal(citation.versionHash, publicDoc.hash);
    assert.equal(citation.contentType, "decision");
    assert.match(citation.exactSource, /Production deploys to Zurich/);
    assert.ok(citation.sourceSpan.line > 0);
    assert.ok(citation.sourceSpan.endLine >= citation.sourceSpan.line);
    assert.equal(citation.embedding.length, 96);
    assert.equal(citation.trust.verifiedBy, "reviewer");
    assert.equal(citation.freshness.state, "current");
    assert.deepEqual(citation.provenance, ["https://ops.example/deployments/production"]);
    assert.deepEqual(citation.accessDecision, { principalId: "alice", allowed: true, role: "editor", via: "user", decidedAt: now });
    assert.ok(citation.scoreParts.lexical > 0);
    assert.ok(results.every((result) => result.documentId !== secret.id));

    const answer = platform.ask({ principalId: "alice", query: "Where does the production deployment run?", documents: access, now });
    assert.equal(answer.state, "answered");
    assert.match(answer.answer, /Zurich/);
    assert.ok(answer.confidence.score > 0);
    assert.ok(answer.citations.length > 0);
    assert.equal(answer.citations[0]?.citation, 1);
    assert.equal(answer.citations[0]?.versionHash, publicDoc.hash);

    const refusal = platform.ask({ principalId: "alice", query: "What is the lunar cafeteria menu on Europa?", documents: access, now: "2026-07-14T10:01:00.000Z" });
    assert.equal(refusal.state, "insufficient_evidence");
    assert.deepEqual(refusal.citations, []);
    assert.match(refusal.answer, /enough accessible, current evidence/);
  });
});

test("RAG evaluations measure source recall, forbidden use, leakage, stale use, abstention, latency, and cost", async () => {
  await withPlatform((platform) => {
    const current = document("current", "Current policy", `# Current policy

::claim{id="expense-limit" owner="finance" verified_at="2026-07-01" review_by="2027-01-01"}
The current travel expense limit is 500 francs.
::
`);
    const forbidden = document("forbidden", "Board policy", `# Board policy

::claim{id="board-limit"}
The confidential board limit is 10,000 francs.
::
`);
    const base = { principalId: "employee", documents: allowed(current), now };
    const results = platform.evaluate([
      {
        id: "travel-limit",
        query: "What is the current travel expense limit?",
        requiredSources: [{ documentId: current.id, blockId: "expense-limit" }],
        forbiddenSources: [{ documentId: forbidden.id }],
        expectAbstention: false,
        maxLatencyMs: 5_000,
        maxCostUsd: 0.01,
      },
      {
        id: "unknown-policy",
        query: "What is the quantum submarine policy?",
        expectAbstention: true,
        maxLatencyMs: 5_000,
        maxCostUsd: 0.01,
      },
    ], base);
    assert.equal(results.length, 2);
    assert.equal(results[0]?.passed, true, JSON.stringify(results[0]));
    assert.equal(results[0]?.requiredRecall, 1);
    assert.equal(results[0]?.forbiddenHits, 0);
    assert.equal(results[0]?.permissionLeakage, 0);
    assert.equal(results[0]?.staleSourceHits, 0);
    assert.equal(results[0]?.citationCoverage, 1);
    assert.equal(results[1]?.passed, true, JSON.stringify(results[1]));
    assert.equal(results[1]?.abstentionCorrect, true);
  });
});

test("knowledge health and LLM Wiki expose stale, orphaned, broken, duplicate, contradictory, unowned, and missing knowledge", async () => {
  await withPlatform((platform) => {
    const alpha = document("alpha", "Alpha operations", `# Alpha operations

::claim{id="availability-a" value="99.9"}
The canonical Alpha service availability target is 99.9 percent.
::

See [[Beta operations]] and [[Missing escalation policy]].
`);
    const beta = document("beta", "Beta operations", `# Beta operations

::claim{id="availability-b" value="95"}
The canonical Alpha service availability target is 95 percent.
::
`);
    const duplicate = document("duplicate", "Alpha service notes", `# Alpha service notes

::claim{id="availability-copy"}
The canonical Alpha service availability target is 99.9 percent.
::
`);
    const orphan = document("orphan", "Isolated handbook", `# Isolated handbook

::decision{id="isolated-choice" status="open"}
An isolated decision with no owner or links.
::
`);
    for (const [documentId, blockId, value, reviewBy] of [
      [alpha.id, "availability-a", "99.9", "2026-01-01T00:00:00.000Z"],
      [beta.id, "availability-b", "95", "2027-01-01T00:00:00.000Z"],
    ] as const) {
      platform.putTrust({ documentId, blockId, ownerId: documentId === alpha.id ? "ops" : undefined, canonicalFor: ["alpha availability"], reviewBy, provenance: { assertedValue: value }, updatedAt: now, updatedBy: "ops" });
    }
    const access = allowed(alpha, beta, duplicate, orphan);
    platform.ask({ principalId: "ops", query: "How are pet dragons reimbursed?", documents: access, now: "2026-07-14T10:02:00.000Z" });
    const health = platform.health(access, now);
    const kinds = new Set(health.map((item) => item.kind));
    assert.ok(kinds.has("stale"));
    assert.ok(kinds.has("orphan"));
    assert.ok(kinds.has("broken_link"));
    assert.ok(kinds.has("duplicate"));
    assert.ok(kinds.has("contradiction"));
    assert.ok(kinds.has("missing_owner"));
    assert.ok(kinds.has("unanswered_query"));

    const wiki = platform.wiki(access, now);
    assert.ok(wiki.missingConcepts.some((item) => item.target === "Missing escalation policy"));
    assert.ok(wiki.canonicalConcepts.some((item) => item.concept === "alpha availability"));
    assert.ok(wiki.relationships.some((item) => item.relation === "links-to"));
    assert.ok(wiki.suggestions.length > 0);
    assert.ok(wiki.mergeProposals.length > 0);
    assert.deepEqual(wiki.mergeProposals[0]?.requestedCapabilities, ["read_doc", "list_ids", "validate_doc", "patch_block"]);
    assert.equal(wiki.mergeProposals[0]?.status, "draft");
  });
});

test("agent inboxes expose proof context and scoped identities enforce access, model policy, capabilities, and spend", async () => {
  await withPlatform((platform) => {
    const doc = document("agent-doc", "Agent document", `# Agent document

::decision{id="target" status="open"}
Choose a target.
::
`);
    const proposal: CloudPatchProposal = {
      id: "proposal-1",
      documentId: doc.id,
      documentHash: doc.hash,
      proposedBy: "agent-owner",
      proposedByName: "Research agent",
      summary: "Accept the target",
      ops: [{ op: "update_attribute", id: "target", key: "status", value: "accepted" }],
      proof: { canWrite: true, diff: "- open\n+ accepted", preValidation: { errors: 0 }, postValidation: { errors: 0 } },
      status: "pending",
      createdAt: now,
      updatedAt: now,
    };
    const inbox = platform.agentChangeInbox([proposal], allowed(doc));
    assert.equal(inbox.length, 1);
    assert.deepEqual(inbox[0]?.affectedIds, ["target"]);
    assert.equal(inbox[0]?.validation.canWrite, true);
    assert.equal(inbox[0]?.applyStatus, "awaiting_review");
    assert.match(String(inbox[0]?.diff), /accepted/);

    const agent = agentIdentity("agent-1", 1);
    platform.createAgent(agent);
    assert.throws(() => platform.requireAgentAccess(agent.id, "document", doc.id, "read_doc"), /no explicit access/);
    platform.grantAgentAccess({ id: "grant-1", agentId: agent.id, resourceType: "document", resourceId: doc.id, role: "viewer", createdAt: now, updatedAt: now }, "owner", now);
    assert.equal(platform.requireAgentAccess(agent.id, "document", doc.id, "read_doc").role, "viewer");
    assert.throws(() => platform.requireAgentAccess(agent.id, "document", doc.id, "delete_workspace"), /lacks capability/);
    platform.startAgentRun({ id: "run-1", agentId: agent.id, triggeredBy: "owner", trigger: "manual", documentId: doc.id, status: "running", requestedCapabilities: ["read_doc"], startedAt: now });
    platform.finishAgentRun("run-1", { status: "completed", costUsd: 0.4, completedAt: "2026-07-14T10:03:00.000Z" });
    assert.equal(platform.readAgent(agent.id)?.spentUsd, 0.4);
    assert.equal(platform.listAgentRuns(agent.id)[0]?.status, "completed");
    platform.startAgentRun({ id: "run-2", agentId: agent.id, triggeredBy: "owner", trigger: "manual", status: "running", requestedCapabilities: [], startedAt: "2026-07-14T10:04:00.000Z" });
    assert.throws(() => platform.finishAgentRun("run-2", { status: "completed", costUsd: 0.7, completedAt: "2026-07-14T10:05:00.000Z" }), /remaining budget/);
  });
});

test("connectors preserve upstream lineage, recipes remain proposal-only, and semantic collections are typed", async () => {
  await withPlatform((platform) => {
    const doc = document("collections", "Collections", `# Collections

::decision{id="open-decision" status="open" owner="alice"}
Select a launch day.
::

::claim{id="unsupported-claim"}
Launch readiness is high.
::

::risk{id="owned-risk" owner="bob"}
Capacity could be constrained.
::
`);
    platform.putConnector({ id: "github-1", kind: "github", name: "Product repository", siteId: "space-1", status: "active", configuration: { repository: "acme/product" }, createdBy: "alice", createdAt: now, updatedAt: now });
    platform.syncConnectorSource({ id: "github-1:issue-42", connectorId: "github-1", externalId: "issue-42", documentId: doc.id, upstreamPermissions: [{ principal: "team:product", role: "read" }], upstreamModifiedAt: "2026-07-14T09:00:00.000Z", sourceUrl: "https://github.example/acme/product/issues/42", contentHash: "first", lineage: ["github:issue-41"], syncedAt: now }, "alice");
    platform.syncConnectorSource({ id: "github-1:issue-42", connectorId: "github-1", externalId: "issue-42", documentId: doc.id, upstreamPermissions: [{ principal: "team:product", role: "read" }], upstreamModifiedAt: "2026-07-14T09:30:00.000Z", sourceUrl: "https://github.example/acme/product/issues/42", contentHash: "deleted", lineage: ["github:issue-42@first"], tombstonedAt: "2026-07-14T10:10:00.000Z", syncedAt: "2026-07-14T10:10:00.000Z" }, "alice");
    const source = platform.listConnectorSources("github-1")[0];
    assert.equal(source?.tombstonedAt, "2026-07-14T10:10:00.000Z");
    assert.deepEqual(source?.upstreamPermissions, [{ principal: "team:product", role: "read" }]);
    assert.deepEqual(source?.lineage, ["github:issue-41", "github:issue-42@first"]);

    const recipes = platform.recipes();
    assert.deepEqual(new Set(recipes.map((recipe) => recipe.purpose)), new Set(["stale_doc_review", "meeting_to_decision", "issue_to_runbook", "research_refresh", "onboarding_answers", "release_maintenance"]));
    const recipeRun = platform.runRecipe({ id: "recipe-run", recipeId: "meeting-to-decision", triggeredBy: "alice", triggerMode: "webhook", input: { meetingId: "meeting-1" }, status: "planned", plan: [], mutationPolicy: "proof_proposal_only", startedAt: now });
    assert.equal(recipeRun.mutationPolicy, "proof_proposal_only");
    assert.ok(recipeRun.plan.length > 0);
    assert.throws(() => platform.runRecipe({ ...recipeRun, id: "invalid-trigger", recipeId: "stale-doc-review", triggerMode: "webhook" }), /trigger mode/);

    const collections = platform.semanticCollections(allowed(doc), now);
    assert.ok(collections.find((collection) => collection.id === "open_decisions")?.items.some((item) => item.blockId === "open-decision"));
    assert.ok(collections.find((collection) => collection.id === "claims_missing_evidence")?.items.some((item) => item.blockId === "unsupported-claim"));
    assert.ok(collections.find((collection) => collection.id === "risks_by_owner")?.items.some((item) => item.ownerId === "bob"));
    assert.deepEqual(platform.gatewayCapabilities().map((capability) => capability.operation), ["search", "cited_answer", "list_ids", "llm_export", "proof", "proposal", "review", "apply", "webhook"]);
  });
});

test("analytics are access-scoped and deterministic backups report corruption and concurrent edits", async () => {
  await withPlatform((platform) => {
    const visible = document("visible", "Visible", "# Visible\n\nVisible source.\n");
    const hidden = document("hidden", "Hidden", "# Hidden\n\nHidden source.\n");
    platform.recordAnalytics({ id: "visible-event", type: "citation_opened", actorId: "other", documentId: visible.id, createdAt: now });
    platform.recordAnalytics({ id: "hidden-event", type: "answer_rejected", actorId: "other", documentId: hidden.id, createdAt: now });
    platform.recordAnalytics({ id: "own-event", type: "task_completed", actorId: "alice", documentId: hidden.id, createdAt: now });
    const summary = platform.analytics("alice", [visible.id]);
    assert.equal(summary.total, 2);
    assert.equal(summary.counts.citation_opened, 1);
    assert.equal(summary.counts.answer_rejected, 0);
    assert.equal(summary.counts.task_completed, 1);

    const bundle = platform.exportBackup([hidden, visible], now, { repository: "acme/knowledge", branch: "noma-backup", pullRequestReview: true });
    const repeated = platform.exportBackup([visible, hidden], now, { repository: "acme/knowledge", branch: "noma-backup", pullRequestReview: true });
    assert.equal(bundle.digest, repeated.digest);
    assert.deepEqual(bundle.files.map((file) => file.documentId), [hidden.id, visible.id]);
    const unchangedPlan = platform.planBackupImport(bundle, [visible, hidden]);
    assert.deepEqual(unchangedPlan.unchanged, [hidden.id, visible.id]);
    assert.equal(unchangedPlan.pullRequestReview, true);

    const corrupted: NomaBackupBundle = { ...bundle, files: bundle.files.map((file, index) => index === 0 ? { ...file, source: `${file.source}corrupt` } : file) };
    assert.equal(platform.planBackupImport(corrupted, []).conflicts[0]?.type, "corrupt_bundle");
    const edited = { ...visible, source: "# Visible\n\nChanged after export.\n", hash: sha256Hex("# Visible\n\nChanged after export.\n"), updatedAt: "2026-07-15T00:00:00.000Z" };
    assert.ok(platform.planBackupImport(bundle, [edited, hidden]).conflicts.some((conflict) => conflict.type === "concurrent_edit" && conflict.documentId === visible.id));
  });
});

test("offline recovery, realtime preconditions, SSO/SCIM governance, legal hold, audit, allowlists, and retention are enforced", async () => {
  await withPlatform((platform) => {
    const doc = document("continuity", "Continuity", "# Continuity\n\nBase line.\nSecond line.\n");
    platform.saveOfflineDraft({ id: "draft-1", userId: "alice", documentId: doc.id, baseHash: doc.hash, baseSource: doc.source, source: "# Continuity\n\nOffline edit.\nSecond line.\n", createdAt: now, updatedAt: now });
    assert.equal(platform.listOfflineDrafts("alice").length, 1);
    assert.equal(platform.mergeOfflineDraft("draft-1", doc.source, doc.hash, now).state, "clean");
    const current = "# Continuity\n\nOnline edit.\nSecond line.\n";
    const conflict = platform.mergeOfflineDraft("draft-1", current, sha256Hex(current), "2026-07-14T10:20:00.000Z");
    assert.equal(conflict.state, "conflict");
    assert.ok(conflict.conflicts.length > 0);
    assert.match(conflict.source, /NOMA MERGE CONFLICT: CURRENT/);

    platform.recordRealtimeOperation({ id: "rt-1", documentId: doc.id, userId: "alice", actorType: "human", sequence: 1, baseHash: doc.hash, resultHash: sha256Hex(current), operations: [{ op: "replace_block", id: "continuity" }], affectedIds: ["continuity"], proofStatus: "pass", createdAt: now });
    assert.equal(platform.realtimeOperations(doc.id)[0]?.sequence, 1);
    assert.throws(() => platform.recordRealtimeOperation({ id: "rt-3", documentId: doc.id, userId: "alice", actorType: "human", sequence: 3, baseHash: doc.hash, resultHash: doc.hash, operations: [], affectedIds: [], proofStatus: "pass", createdAt: now }), /sequence must be 2/);
    assert.throws(() => platform.recordRealtimeOperation({ id: "rt-agent", documentId: doc.id, userId: "agent", actorType: "agent" as "human", sequence: 2, baseHash: doc.hash, resultHash: doc.hash, operations: [], affectedIds: [], proofStatus: "pass", createdAt: now }), /reserved for humans/);

    const policy: EnterprisePolicy = {
      id: "workspace",
      sso: { enabled: true, provider: "oidc", issuer: "https://id.example", enforced: true },
      scim: { enabled: true, baseUrl: "https://noma.example/scim/v2" },
      retentionDays: 30,
      legalHoldEnabled: true,
      dataResidency: "ch-zurich",
      connectorAllowlist: ["github", "filesystem"],
      modelAllowlist: ["secure-model"],
      requireZeroRetentionModels: true,
      auditExportEnabled: true,
      updatedAt: "2026-07-14T10:30:00.000Z",
      updatedBy: "security-admin",
    };
    platform.setEnterprisePolicy(policy);
    assert.deepEqual(platform.enterprisePolicy(), policy);
    assert.throws(() => platform.putConnector({ id: "slack-denied", kind: "slack", name: "Slack", status: "active", configuration: {}, createdBy: "alice", createdAt: now, updatedAt: now }), /not allowed/);
    assert.throws(() => platform.createAgent(agentIdentity("bad-model", 2)), /Model is not allowed/);
    const secureAgent: CloudAgentIdentity = { ...agentIdentity("secure-agent", 2), modelPolicy: { model: "secure-model", zeroRetention: true, maxTokensPerRun: 4_000 } };
    platform.createAgent(secureAgent);
    platform.upsertScimIdentity({ id: "scim-1", externalId: "00u123", userId: "alice", userName: "Alice", active: true, groups: ["engineering"], updatedAt: now }, "security-admin");
    assert.equal(platform.listScimIdentities()[0]?.externalId, "00u123");
    platform.putLegalHold({ id: "hold-1", resourceType: "document", resourceId: doc.id, reason: "Regulatory inquiry", createdBy: "legal", createdAt: now });
    assert.equal(platform.listLegalHolds().length, 1);
    const audit = platform.exportAudit("security-admin", [doc.id, "workspace"]);
    assert.equal(audit.format, "noma-cloud-audit-v1");
    assert.equal(audit.dataResidency, "ch-zurich");
    assert.ok(audit.events.some((event) => event.action === "enterprise.policy_updated"));
    assert.equal(audit.digest.length, 64);
    const retention = platform.enforceRetention("2027-07-14T10:00:00.000Z");
    assert.ok(retention.protectedByLegalHold > 0);
  });
});

function document(id: string, title: string, source: string): CloudDocumentRecord {
  return {
    version: 2,
    id,
    title,
    source,
    hash: sha256Hex(source),
    createdAt: "2026-07-01T00:00:00.000Z",
    updatedAt: "2026-07-10T00:00:00.000Z",
    createdBy: "alice",
    updatedBy: "alice",
    permissions: { alice: { role: "owner", addedAt: "2026-07-01T00:00:00.000Z" } },
    shareLinks: [],
  };
}

function allowed(...documents: CloudDocumentRecord[]): KnowledgeDocumentAccess[] {
  return documents.map((item) => ({ document: item, role: "editor", via: "user" }));
}

function agentIdentity(id: string, budgetUsd: number): CloudAgentIdentity {
  return {
    id,
    name: id,
    createdBy: "owner",
    modelPolicy: { model: "local-deterministic", zeroRetention: true, maxTokensPerRun: 4_000 },
    capabilities: ["read_doc", "list_ids", "validate_doc", "patch_block"],
    budgetUsd,
    spentUsd: 0,
    status: "active",
    createdAt: now,
    updatedAt: now,
  };
}

async function withPlatform(run: (platform: CloudKnowledgePlatform) => void | Promise<void>): Promise<void> {
  const root = await mkdtemp(join(tmpdir(), "noma-platform-"));
  const platform = new CloudKnowledgePlatform(join(root, "platform.sqlite"));
  try {
    await run(platform);
  } finally {
    platform.close();
    await rm(root, { recursive: true, force: true });
  }
}
