/** `/api/collab/documents/:id` — live-editing room status. The WebSocket upgrade on the same path is handled by `cloud-collab.ts`. */
import type { IncomingMessage, ServerResponse } from "node:http";
import { collabHubFor } from "../cloud-collab.js";
import { type CloudServerConfig, type Principal, readDocument, requireNotTrashed, requireRecordAccess } from "./context.js";
import { HttpError, sendJson } from "./http.js";

export async function routeCollab(
  req: IncomingMessage,
  res: ServerResponse,
  parts: string[],
  config: CloudServerConfig,
  principal: Principal,
): Promise<void> {
  const documentId = parts[3];
  if (parts[2] !== "documents" || !documentId || parts.length !== 4) throw new HttpError(404, "Unknown collab route");
  if ((req.method ?? "GET") !== "GET") throw new HttpError(405, "Method not allowed");
  const record = await readDocument(config, documentId);
  requireNotTrashed(config, "document", documentId);
  const access = requireRecordAccess(config, record, principal, "viewer");
  const info = collabHubFor(config)?.roomInfo(documentId) ?? { live: false, clients: [], pendingUpdates: 0, dirty: false };
  sendJson(res, 200, {
    documentId,
    hash: record.hash,
    websocket: `/api/collab/documents/${encodeURIComponent(documentId)}`,
    role: access.role,
    readOnly: access.role === "viewer",
    ...info,
  });
}
