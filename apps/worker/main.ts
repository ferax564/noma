import { runEnterpriseWorkerTick } from "../../src/enterprise-worker.js";
import { createTestOidc, EnterpriseWorkspace } from "../../src/enterprise-workspace.js";

const oidc = createTestOidc({
  alice: { sub: "alice", email: "alice@example.com", name: "Alice" },
});
const workspace = new EnterpriseWorkspace({ oidc, dbPath: process.env.NOMA_ENTERPRISE_DB ?? ":memory:" });
const tenantId = process.env.NOMA_TENANT_ID;
if (!tenantId) {
  process.stderr.write("NOMA_TENANT_ID is required for the worker process\n");
  process.exit(1);
}
const result = runEnterpriseWorkerTick(workspace, tenantId);
process.stdout.write(JSON.stringify(result) + "\n");
workspace.close();
