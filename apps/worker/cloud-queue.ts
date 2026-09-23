import { dirname, join, resolve } from "node:path";
import { openNomaCloudDatabase } from "../../src/cloud-db.js";
import { drainWebhookQueue } from "../../src/cloud/webhooks.js";

const dataDir = resolve(process.env.NOMA_CLOUD_DATA_DIR ?? ".noma-cloud/documents");
const storageRoot = dirname(dataDir);
const store = openNomaCloudDatabase({
  dbPath: resolve(process.env.NOMA_CLOUD_DB ?? join(storageRoot, "noma-cloud.sqlite")),
  dataDir,
  usersDir: resolve(process.env.NOMA_CLOUD_USERS_DIR ?? join(storageRoot, "users")),
  sitesDir: resolve(process.env.NOMA_CLOUD_SITES_DIR ?? join(storageRoot, "sites")),
});
try {
  const webhooks = await drainWebhookQueue(store, () => new Date(), 200);
  process.stdout.write(`${JSON.stringify({ webhooks })}\n`);
} finally {
  store.close();
}
