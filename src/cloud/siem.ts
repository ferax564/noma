/**
 * Ships the audit log to a SIEM: batches of NDJSON records (oldest first, each with its `sequence`)
 * POSTed to `NOMA_CLOUD_SIEM_URL` with a bearer token and an HMAC of the body. The cursor only moves
 * after a 2xx, so a SIEM outage delays delivery but never drops records.
 */
import { createHmac } from "node:crypto";
import type { CloudComplianceStore, SiemStatus } from "../cloud-compliance.js";
import type { CloudKnowledgePlatform } from "../cloud-platform.js";

export interface SiemTarget {
  url: string;
  token: string;
  fetch?: typeof fetch;
  batchSize?: number;
}

/** Audit records as newline-delimited JSON. */
export function auditNdjson(records: ReadonlyArray<object>): string {
  return records.map((record) => JSON.stringify(record)).join("\n") + (records.length ? "\n" : "");
}

/** What shipping needs: the server config satisfies it, and so does the standalone queue worker. */
export interface SiemDeps {
  platform: CloudKnowledgePlatform;
  compliance: CloudComplianceStore;
  siem?: SiemTarget;
  now: () => Date;
}

/** Sends every audit record past the cursor, one batch at a time. Returns the updated status. */
export async function shipAuditToSiem(config: SiemDeps, maxBatches = 5): Promise<SiemStatus> {
  const target = config.siem;
  let status = config.compliance.siemStatus();
  if (!target) return status;
  const fetcher = target.fetch ?? fetch;
  for (let batch = 0; batch < maxBatches; batch++) {
    const records = config.platform.auditAfter(status.cursor, target.batchSize ?? 500);
    if (records.length === 0) break;
    const body = auditNdjson(records.map((record) => ({ source: "noma-cloud", ...record })));
    try {
      const response = await fetcher(target.url, {
        method: "POST",
        headers: {
          "content-type": "application/x-ndjson",
          authorization: `Bearer ${target.token}`,
          "x-noma-signature": `sha256=${createHmac("sha256", target.token).update(body).digest("hex")}`,
        },
        body,
        signal: AbortSignal.timeout(15_000),
      });
      if (!response.ok) throw new Error(`SIEM answered ${response.status}`);
    } catch (error) {
      return config.compliance.setSiemStatus({ ...status, lastError: (error instanceof Error ? error.message : String(error)).slice(0, 300), lastErrorAt: config.now().toISOString() });
    }
    const { lastError: _error, lastErrorAt: _errorAt, ...rest } = status;
    status = config.compliance.setSiemStatus({ ...rest, cursor: records.at(-1)!.sequence, lastShippedAt: config.now().toISOString(), lastBatch: records.length });
  }
  return status;
}

/** `NOMA_CLOUD_SIEM_URL` + `NOMA_CLOUD_SIEM_TOKEN` (or `_FILE`). */
export function siemTargetFromEnv(env: NodeJS.ProcessEnv, readSecretFile: (path: string) => string): SiemTarget | undefined {
  const url = env.NOMA_CLOUD_SIEM_URL?.trim();
  const token = env.NOMA_CLOUD_SIEM_TOKEN?.trim() || (env.NOMA_CLOUD_SIEM_TOKEN_FILE ? readSecretFile(env.NOMA_CLOUD_SIEM_TOKEN_FILE).trim() : "");
  if (!url || !token) return undefined;
  if (!/^https:\/\//.test(url) && !/^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\//.test(url)) throw new Error("NOMA_CLOUD_SIEM_URL must be an https URL");
  return { url, token };
}
