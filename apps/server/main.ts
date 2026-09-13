import { listenEnterpriseHttp } from "../../src/enterprise-http.js";
import { createTestOidc, EnterpriseWorkspace } from "../../src/enterprise-workspace.js";

const oidc = createTestOidc({
  alice: { sub: "alice", email: "alice@example.com", name: "Alice" },
});
const workspace = new EnterpriseWorkspace({ oidc, dbPath: process.env.NOMA_ENTERPRISE_DB ?? ":memory:" });
const tenantId = workspace.provisionTenant("local").tenantId;
workspace.scimUpsert(tenantId, { externalId: "alice", userName: "Alice", active: true });
const session = workspace.loginOidc(tenantId, "alice");
workspace.bootstrapGrant(tenantId, session.actor.principalId, "tenant", tenantId, "owner");

const bound = await listenEnterpriseHttp({
  workspace,
  host: process.env.HOST ?? "127.0.0.1",
  port: Number(process.env.PORT ?? "8787"),
});
process.stdout.write(`noma enterprise server listening on ${bound.port} tenant=${tenantId}\n`);
