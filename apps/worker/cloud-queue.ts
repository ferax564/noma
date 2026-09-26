import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { CloudChatStore } from "../../src/cloud-chat.js";
import { CloudComplianceStore } from "../../src/cloud-compliance.js";
import { openNomaCloudDatabase } from "../../src/cloud-db.js";
import { createEmbeddingProviderFromEnv } from "../../src/cloud-embeddings.js";
import { CloudIntegrationsStore } from "../../src/cloud-integrations.js";
import { CloudKnowledgePlatform } from "../../src/cloud-platform.js";
import { drainSlackOutbox, slackConfigFromEnv } from "../../src/cloud/integrations.js";
import { runCloudQueueTick } from "../../src/cloud/queue.js";
import { shipAuditToSiem, siemTargetFromEnv } from "../../src/cloud/siem.js";

const dataDir = resolve(process.env.NOMA_CLOUD_DATA_DIR ?? ".noma-cloud/documents");
const storageRoot = dirname(dataDir);
const dbPath = resolve(process.env.NOMA_CLOUD_DB ?? join(storageRoot, "noma-cloud.sqlite"));
const store = openNomaCloudDatabase({
  dbPath,
  dataDir,
  usersDir: resolve(process.env.NOMA_CLOUD_USERS_DIR ?? join(storageRoot, "users")),
  sitesDir: resolve(process.env.NOMA_CLOUD_SITES_DIR ?? join(storageRoot, "sites")),
});
const platform = new CloudKnowledgePlatform(dbPath, { embeddings: createEmbeddingProviderFromEnv() });
const compliance = new CloudComplianceStore(dbPath);
const siem = siemTargetFromEnv(process.env, (path) => readFileSync(resolve(path), "utf8"));
const slack = slackConfigFromEnv(process.env, (path) => readFileSync(resolve(path), "utf8"));
const chat = slack ? new CloudChatStore(dbPath) : undefined;
const integrations = slack ? new CloudIntegrationsStore(dbPath) : undefined;
try {
  const result = await runCloudQueueTick(store, () => new Date(), undefined, platform);
  const shipped = siem ? await shipAuditToSiem({ platform, compliance, siem, now: () => new Date() }) : undefined;
  const slackSent = slack && chat && integrations ? await drainSlackOutbox({ slack, chat, integrations, store, platform, now: () => new Date() }) : undefined;
  process.stdout.write(`${JSON.stringify({ ...result, ...(shipped ? { siem: shipped } : {}), ...(slackSent !== undefined ? { slackSent } : {}) })}\n`);
} finally {
  integrations?.close();
  chat?.close();
  compliance.close();
  platform.close();
  store.close();
}
