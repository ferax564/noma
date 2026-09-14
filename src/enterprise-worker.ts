import { EnterpriseWorkspace } from "./enterprise-workspace.js";

export interface WorkerTickResult {
  outbox: number;
  jobs: number;
  deadLetters: number;
}

export function runEnterpriseWorkerTick(ws: EnterpriseWorkspace, tenantId: string): WorkerTickResult {
  const outbox = ws.drainOutbox(tenantId);
  const jobs = ws.store.db
    .prepare("SELECT * FROM jobs WHERE tenant_id = ? AND status IN ('queued', 'running', 'failed')")
    .all(tenantId) as Array<{ id: string; attempts: number; payload_json: string; recipe: string; actor_id: string }>;
  let processed = 0;
  let deadLetters = 0;
  for (const job of jobs) {
    processed += 1;
    const attempts = job.attempts + 1;
    try {
      ws.store.db.prepare("UPDATE jobs SET status = 'succeeded', attempts = ?, updated_at = ? WHERE id = ?").run(attempts, new Date().toISOString(), job.id);
    } catch (error) {
      if (attempts >= 3) {
        ws.store.db.prepare("UPDATE jobs SET status = 'dead_letter', attempts = ?, updated_at = ? WHERE id = ?").run(attempts, new Date().toISOString(), job.id);
        ws.store.db
          .prepare("INSERT INTO jobs_dead_letter(id, job_id, tenant_id, error, created_at) VALUES (?, ?, ?, ?, ?)")
          .run(`dl-${job.id}`, job.id, tenantId, error instanceof Error ? error.message : String(error), new Date().toISOString());
        deadLetters += 1;
      } else {
        ws.store.db.prepare("UPDATE jobs SET status = 'failed', attempts = ?, updated_at = ? WHERE id = ?").run(attempts, new Date().toISOString(), job.id);
      }
    }
  }
  return { outbox, jobs: processed, deadLetters };
}
