import { dirname, join, resolve } from "node:path";
import { openNomaCloudDatabase } from "../../src/cloud-db.js";
import { createEmbeddingProviderFromEnv } from "../../src/cloud-embeddings.js";
import { CloudKnowledgePlatform } from "../../src/cloud-platform.js";
import { runCloudQueueTick } from "../../src/cloud/queue.js";

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
try {
  const result = await runCloudQueueTick(store, () => new Date(), undefined, platform);
  process.stdout.write(`${JSON.stringify(result)}\n`);
} finally {
  platform.close();
  store.close();
}
