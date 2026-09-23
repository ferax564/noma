/** `/api/db` structured query API. */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { CloudDbQuery } from "../cloud-db.js";
import { type CloudServerConfig, type Principal, requireUser } from "./context.js";
import { HttpError, readJsonBody, sendJson } from "./http.js";
import { boundedInteger, optionalCloudId, optionalString } from "./input.js";

export async function routeDatabase(
  req: IncomingMessage,
  res: ServerResponse,
  parts: string[],
  config: CloudServerConfig,
  principal: Principal,
): Promise<void> {
  const method = req.method ?? "GET";
  const action = parts[2];
  const user = requireUser(principal);

  if (action === "schema" && method === "GET") {
    sendJson(res, 200, {
      storage: "sqlite",
      resources: {
        documents: {
          filters: ["q", "siteId", "documentId"],
          fields: ["id", "title", "hash", "createdAt", "updatedAt", "createdBy", "updatedBy", "access.role", "source"],
          notes: "source is returned only when includeSource is true",
        },
        sites: {
          filters: ["q", "siteId"],
          fields: ["id", "title", "slug", "documentIds", "folders", "pageFolders", "createdAt", "updatedAt", "createdBy", "updatedBy", "access.role"],
        },
        blocks: {
          filters: ["q", "siteId", "documentId"],
          fields: ["rowKey", "documentId", "documentTitle", "id", "aliases", "type", "name", "title", "text", "line", "depth", "ordinal", "access.role"],
        },
        users: {
          filters: ["q"],
          fields: ["id", "name", "tokenPreview", "createdAt", "updatedAt"],
        },
      },
      query: {
        method: "POST",
        path: "/api/db/query",
        body: {
          resource: "documents | sites | blocks | users",
          q: "optional text search",
          siteId: "optional site filter",
          documentId: "optional document filter",
          includeSource: "boolean, documents only",
          limit: "1..100, default 25",
          offset: "0..10000, default 0",
        },
      },
    });
    return;
  }

  if (action === "query" && method === "POST") {
    const input = await readJsonBody(req, config.maxBodyBytes);
    sendJson(res, 200, config.store.query(user, databaseQueryInput(input)));
    return;
  }

  throw new HttpError(404, "Unknown database route");
}

function databaseQueryInput(input: Record<string, unknown>): CloudDbQuery {
  const resource = databaseQueryResource(input.resource);
  return {
    resource,
    q: optionalString(input.q) ?? optionalString(input.text),
    siteId: optionalCloudId(input.siteId, "Site"),
    documentId: optionalCloudId(input.documentId, "Document"),
    includeSource: input.includeSource === true,
    limit: boundedInteger(input.limit, 25, 1, 100, "limit"),
    offset: boundedInteger(input.offset, 0, 0, 10_000, "offset"),
  };
}

function databaseQueryResource(value: unknown): CloudDbQuery["resource"] {
  if (value === "documents" || value === "sites" || value === "blocks" || value === "users") return value;
  throw new HttpError(400, "resource must be documents, sites, blocks, or users");
}
