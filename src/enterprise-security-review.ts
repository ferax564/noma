import { EnterpriseError } from "./enterprise-contracts.js";
import { createEnterpriseHttpServer } from "./enterprise-http.js";
import { createTestOidc, EnterpriseWorkspace } from "./enterprise-workspace.js";

export interface SecurityFinding {
  id: string;
  title: string;
  severity: "critical" | "high" | "medium" | "low";
  passed: boolean;
  evidence: string;
}

export async function runIndependentSecurityReview(): Promise<{ passed: boolean; findings: SecurityFinding[] }> {
  const oidc = createTestOidc({
    alice: { sub: "alice", email: "alice@example.com", name: "Alice" },
    bob: { sub: "bob", email: "bob@example.com", name: "Bob" },
  });
  const ws = new EnterpriseWorkspace({ oidc });
  const tenantId = ws.provisionTenant("Review").tenantId;
  ws.scimUpsert(tenantId, { externalId: "alice", userName: "Alice", active: true });
  ws.scimUpsert(tenantId, { externalId: "bob", userName: "Bob", active: true });
  const alice = ws.loginOidc(tenantId, "alice");
  const bob = ws.loginOidc(tenantId, "bob");
  ws.bootstrapGrant(tenantId, alice.actor.principalId, "tenant", tenantId, "owner");
  const spaceId = ws.createSpace(alice.actor, "Public");
  ws.bootstrapGrant(tenantId, bob.actor.principalId, "space", spaceId, "editor");
  const documentId = ws.createDocument(alice.actor, { spaceId, title: "Spec", source: `{#p}\nVisible.\n` });
  const secretSpace = ws.createSpace(alice.actor, "Secret", "restricted");
  const secretDoc = ws.createDocument(alice.actor, { spaceId: secretSpace, title: "Secret price", source: "# Secret\n\n900 million.\n" });
  ws.publishDocument(alice.actor, secretDoc);
  const server = createEnterpriseHttpServer({ workspace: ws });
  const findings: SecurityFinding[] = [];
  try {
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const port = (server.address() as { port: number }).port;
    const origin = `http://127.0.0.1:${port}`;

    const unauth = await fetch(`${origin}/v1/search?q=million`);
    findings.push({
      id: "SEC-01",
      title: "Unauthenticated search is rejected",
      severity: "critical",
      passed: unauth.status === 403,
      evidence: `status ${unauth.status}`,
    });

    const leaked = await fetch(`${origin}/v1/search?q=million`, { headers: { authorization: `Bearer ${bob.token}` } });
    const body = (await leaked.json()) as { hits?: Array<{ resourceId?: string }> };
    findings.push({
      id: "SEC-02",
      title: "Restricted documents do not leak through search",
      severity: "critical",
      passed: leaked.ok && (body.hits ?? []).every((hit) => hit.resourceId !== secretDoc),
      evidence: JSON.stringify(body.hits ?? []),
    });

    let selfApproveBlocked = false;
    try {
      const agentId = ws.createPrincipal(tenantId, { kind: "agent", name: "bot", capabilities: ["changeset.propose"] });
      const agent = ws.createSession({ id: agentId, tenant_id: tenantId, kind: "agent" }).actor;
      ws.bootstrapGrant(tenantId, agentId, "space", spaceId, "editor");
      const cs = ws.draftChangeset(agent, {
        intent: "self",
        idempotencyKey: "sec-self",
        targetRevisions: { [documentId]: 0 },
        operations: [{ resource: { kind: "document", id: documentId }, op: "replace_paragraph", payload: { blockId: "p", content: "x" } }],
      });
      ws.proposeChangeset(agent, cs, [alice.actor.principalId]);
      ws.approveChangeset(agent, cs);
    } catch (error) {
      selfApproveBlocked = error instanceof EnterpriseError && error.code === "self_approval";
    }
    findings.push({
      id: "SEC-03",
      title: "Agents cannot approve their own changesets",
      severity: "critical",
      passed: selfApproveBlocked,
      evidence: selfApproveBlocked ? "self_approval" : "approval succeeded",
    });

    let grantInjected = false;
    try {
      const agentId = ws.createPrincipal(tenantId, { kind: "agent", name: "inj", capabilities: ["changeset.propose"] });
      const agent = ws.createSession({ id: agentId, tenant_id: tenantId, kind: "agent" }).actor;
      ws.bootstrapGrant(tenantId, agentId, "space", spaceId, "editor");
      const cs = ws.draftChangeset(agent, {
        intent: "inject",
        idempotencyKey: "sec-grant",
        targetRevisions: { [documentId]: 0 },
        operations: [{ resource: { kind: "document", id: documentId }, op: "replace_paragraph", payload: { blockId: "p", content: "x", grant: "owner" } }],
      });
      ws.validateChangeset(agent, cs);
    } catch (error) {
      grantInjected = error instanceof EnterpriseError && error.code === "policy";
    }
    findings.push({
      id: "SEC-04",
      title: "Untrusted payloads cannot grant privileges",
      severity: "high",
      passed: grantInjected,
      evidence: grantInjected ? "policy" : "injection accepted",
    });

    const svg = ws.uploadAsset(alice.actor, { bytes: Buffer.from("<svg><script>alert(1)</script></svg>"), mime: "image/svg+xml" });
    let svgBlocked = false;
    try {
      ws.readAsset(alice.actor, svg);
    } catch (error) {
      svgBlocked = error instanceof EnterpriseError;
    }
    findings.push({
      id: "SEC-05",
      title: "Scripted SVG is quarantined",
      severity: "high",
      passed: svgBlocked,
      evidence: svgBlocked ? "quarantined" : "served",
    });
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    ws.close();
  }
  return { passed: findings.every((finding) => finding.passed), findings };
}
