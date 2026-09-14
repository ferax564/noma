import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { listenEnterpriseHttp } from "../../src/enterprise-http.js";
import { enterpriseWorkspaceHtml, seedEnterpriseProductFixture } from "../../src/enterprise-shell.js";
import { enterpriseCollabHtml } from "../../src/enterprise-yjs.js";
import { createTestOidc, EnterpriseWorkspace } from "../../src/enterprise-workspace.js";

const oidc = createTestOidc({
  alice: { sub: "alice", email: "alice@example.com", name: "Alice" },
});
const postgresUrl = process.env.DATABASE_URL?.startsWith("postgres") ? process.env.DATABASE_URL : undefined;
const workspace = new EnterpriseWorkspace({
  oidc,
  dbPath: postgresUrl ? undefined : process.env.NOMA_ENTERPRISE_DB ?? ":memory:",
  postgresUrl,
});
const tenantId = workspace.provisionTenant("Atlas").tenantId;
workspace.scimUpsert(tenantId, { externalId: "alice", userName: "Alice Chen", active: true });
const session = workspace.loginOidc(tenantId, "alice");
workspace.bootstrapGrant(tenantId, session.actor.principalId, "tenant", tenantId, "owner");
seedEnterpriseProductFixture(workspace, session.actor);

const assetDir = resolve("site/assets");
const collabScriptPath = resolve(assetDir, "enterprise-collab.js");
const workspaceScriptPath = resolve(assetDir, "enterprise-workspace.js");
const workspaceCssPath = resolve(assetDir, "enterprise-workspace.css");
const bound = await listenEnterpriseHttp({
  workspace,
  host: process.env.HOST ?? "127.0.0.1",
  port: Number(process.env.PORT ?? "8787"),
  publicDir: existsSync(assetDir) ? assetDir : undefined,
  tenantId,
  demoUser: "alice",
  workspaceHtml:
    existsSync(workspaceScriptPath) && existsSync(workspaceCssPath)
      ? enterpriseWorkspaceHtml({
          script: readFileSync(workspaceScriptPath, "utf8"),
          css: readFileSync(workspaceCssPath, "utf8"),
          tenantId,
          demoUser: "alice",
        })
      : enterpriseWorkspaceHtml({ tenantId, demoUser: "alice" }),
  collabHtml: existsSync(collabScriptPath) ? enterpriseCollabHtml(readFileSync(collabScriptPath, "utf8")) : undefined,
});
process.stdout.write(`noma enterprise server listening on ${bound.port} tenant=${tenantId}\n`);
