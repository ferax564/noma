/**
 * `/api/macros/resolve`: batch resolution of wiki macros for the browser
 * preview, which renders unsaved source client-side and cannot reach the store.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { CHILDREN_SORTS, type ChildrenSort, ISSUE_STATUSES, type MacroIssueStatus } from "../macros.js";
import { type CloudServerConfig, type Principal, readDocument, requireNotTrashed, requireRecordAccess } from "./context.js";
import { HttpError, readJsonBody, sendJson } from "./http.js";
import { optionalCloudId, optionalRecord, optionalString } from "./input.js";
import { cloudMacroResolvers } from "./macros.js";

const MAX_REQUESTS = 50;

export async function routeMacros(
  req: IncomingMessage,
  res: ServerResponse,
  parts: string[],
  config: CloudServerConfig,
  principal: Principal,
): Promise<void> {
  if (parts[2] !== "resolve") throw new HttpError(404, "Unknown macros route");
  if ((req.method ?? "GET") !== "POST") throw new HttpError(405, "Method not allowed");
  if (!principal.user && !principal.shareTokenHash) throw new HttpError(401, "A cloud user token is required");
  const input = await readJsonBody(req, config.maxBodyBytes);
  const documentId = optionalCloudId(input.documentId, "Document");
  if (documentId) {
    const record = await readDocument(config, documentId);
    requireNotTrashed(config, "document", documentId);
    requireRecordAccess(config, record, principal, "viewer");
  }
  if (!Array.isArray(input.requests)) throw new HttpError(400, "requests must be an array");
  if (input.requests.length > MAX_REQUESTS) throw new HttpError(400, `requests cannot contain more than ${MAX_REQUESTS} items`);
  const resolvers = cloudMacroResolvers(config, principal, documentId);
  const viewable = new Map<string, boolean>();
  const canViewContext = async (id: string | undefined): Promise<boolean> => {
    if (!id || id === documentId) return true;
    const cached = viewable.get(id);
    if (cached !== undefined) return cached;
    let allowed = false;
    try {
      const record = await readDocument(config, id);
      requireNotTrashed(config, "document", id);
      requireRecordAccess(config, record, principal, "viewer");
      allowed = true;
    } catch {
      allowed = false;
    }
    viewable.set(id, allowed);
    return allowed;
  };

  const results: unknown[] = [];
  for (const [index, raw] of input.requests.entries()) {
    const request = optionalRecord(raw, `requests[${index}]`) ?? {};
    const contextId = optionalCloudId(request.fromDocumentId ?? request.documentId, "Context document");
    if (!(await canViewContext(contextId))) {
      results.push({ status: "forbidden" });
      continue;
    }
    switch (request.kind) {
      case "include": {
        const page = boundedText(request.page, "page", 200);
        const block = boundedText(request.block, "block", 160);
        results.push(
          resolvers.resolveInclude({
            ...(page ? { page } : {}),
            ...(block ? { block } : {}),
            excerpt: request.excerpt === true,
            ...(contextId ? { fromDocumentId: contextId } : {}),
          }),
        );
        break;
      }
      case "children":
        results.push(
          resolvers.resolveChildren({
            ...(contextId ? { documentId: contextId } : {}),
            depth: integerIn(request.depth, 1, 1, 5),
            sort: (CHILDREN_SORTS as readonly unknown[]).includes(request.sort) ? (request.sort as ChildrenSort) : "position",
          }),
        );
        break;
      case "issue": {
        const key = boundedText(request.key, "key", 40)?.toUpperCase();
        if (!key) throw new HttpError(400, `requests[${index}].key is required`);
        results.push(resolvers.resolveIssue(key));
        break;
      }
      case "issues": {
        const project = boundedText(request.project, "project", 20)?.toUpperCase();
        if (!project) throw new HttpError(400, `requests[${index}].project is required`);
        const status = (ISSUE_STATUSES as readonly unknown[]).includes(request.status) ? (request.status as MacroIssueStatus) : undefined;
        results.push(resolvers.resolveIssues({ project, ...(status ? { status } : {}), limit: integerIn(request.limit, 20, 1, 50) }));
        break;
      }
      case "page-properties-report": {
        const label = boundedText(request.label, "label", 50)?.toLowerCase();
        if (!label) throw new HttpError(400, `requests[${index}].label is required`);
        results.push(
          resolvers.resolvePagePropertiesReport({
            label,
            limit: integerIn(request.limit, 50, 1, 200),
            ...(contextId ? { fromDocumentId: contextId } : {}),
          }),
        );
        break;
      }
      default:
        throw new HttpError(400, `requests[${index}].kind must be include, children, issue, issues, or page-properties-report`);
    }
  }
  sendJson(res, 200, { results });
}

function boundedText(value: unknown, label: string, max: number): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string" && typeof value !== "number") throw new HttpError(400, `${label} must be a string`);
  return optionalString(String(value))?.slice(0, max);
}

function integerIn(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === "number" && Number.isInteger(value) ? Math.max(min, Math.min(max, value)) : fallback;
}
