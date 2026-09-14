import { parentPort, workerData } from "node:worker_threads";

if (!parentPort) throw new Error("enterprise postgres worker must run as a worker thread");

const ready = (async () => {
  const url = String(workerData.url ?? "");
  if (url.startsWith("pglite:")) {
    const { PGlite } = await import("@electric-sql/pglite");
    const db = new PGlite();
    await db.waitReady;
    return {
      async query(text, values = []) {
        return db.query(text, values);
      },
      async end() {
        await db.close();
      },
    };
  }
  const pg = await import("pg");
  const client = new pg.Client({ connectionString: url });
  await client.connect();
  return client;
})();

parentPort.on("message", async (message) => {
  const port = message.port;
  try {
    const db = await ready;
    if (message.type === "end") {
      await db.end?.();
      port.postMessage({ ok: true, rows: [], rowCount: 0 });
    } else {
      const result = await db.query(message.sql, message.params ?? []);
      port.postMessage({
        ok: true,
        rows: result.rows ?? [],
        rowCount: result.rowCount ?? result.affectedRows ?? (Array.isArray(result.rows) ? result.rows.length : 0),
      });
    }
  } catch (error) {
    port.postMessage({ ok: false, error: error instanceof Error ? error.message : String(error) });
  } finally {
    const lock = new Int32Array(message.lock);
    Atomics.store(lock, 0, 1);
    Atomics.notify(lock, 0);
  }
});
