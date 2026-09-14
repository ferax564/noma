import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { receiveMessageOnPort, MessageChannel, Worker } from "node:worker_threads";
import { fileURLToPath } from "node:url";
import type { PostgresBridge } from "./enterprise-sql.js";

const require = createRequire(import.meta.url);

function workerPath(): string {
  const next = fileURLToPath(new URL("./enterprise-pg-worker.mjs", import.meta.url));
  if (existsSync(next)) return next;
  return fileURLToPath(new URL("../src/enterprise-pg-worker.mjs", import.meta.url));
}

export function createPostgresBridge(url: string): PostgresBridge {
  const worker = new Worker(workerPath(), { workerData: { url } });
  worker.unref();
  const call = (type: "query" | "end", sql = "", params: unknown[] = []): { rows: unknown[]; rowCount: number } => {
    const lock = new Int32Array(new SharedArrayBuffer(4));
    const { port1, port2 } = new MessageChannel();
    worker.postMessage({ type, sql, params, port: port2, lock: lock.buffer }, [port2]);
    const wait = Atomics.wait(lock, 0, 0, 15_000);
    if (wait === "timed-out") throw new Error("postgres worker timed out");
    const reply = receiveMessageOnPort(port1)?.message as
      | { ok: true; rows: unknown[]; rowCount: number }
      | { ok: false; error: string }
      | undefined;
    port1.close();
    if (!reply || !("ok" in reply) || reply.ok !== true) {
      throw new Error(reply && "error" in reply ? reply.error : "postgres worker returned no result");
    }
    return { rows: reply.rows, rowCount: reply.rowCount };
  };
  return {
    exec(sql: string) {
      call("query", sql, []);
    },
    query(sql: string, params: unknown[]) {
      return call("query", sql, params);
    },
    close() {
      try {
        call("end");
      } finally {
        void worker.terminate();
      }
    },
  };
}

export function postgresRuntimeAvailable(url: string): boolean {
  if (url.startsWith("pglite:")) {
    try {
      require.resolve("@electric-sql/pglite");
      return true;
    } catch {
      return false;
    }
  }
  try {
    require.resolve("pg");
    return true;
  } catch {
    return false;
  }
}
