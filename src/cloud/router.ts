/** `/api/:resource` dispatch. To add a resource, add one entry to `apiRoutes`. */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { CloudServerConfig, Principal } from "./context.js";
import { HttpError } from "./http.js";
import { routeAgentGateway, routeAgents, routeConnectors, routeRecipes } from "./routes-agents.js";
import { routeAi, routeDocumentAi, routeSiteAi } from "./routes-ai.js";
import { routeDatabase } from "./routes-database.js";
import { routeDocuments } from "./routes-documents.js";
import { routeEnterprise } from "./routes-enterprise.js";
import { routeSyncManifest } from "./routes-git-sync.js";
import { routeGroups } from "./routes-groups.js";
import {
  routeAgentInbox,
  routeAskNoma,
  routeBackup,
  routeKnowledge,
  routeKnowledgeAnalytics,
  routeOffline,
  routeRealtime,
  routeSemanticCollections,
} from "./routes-knowledge.js";
import {
  routeActivity,
  routeLabels,
  routeNavigation,
  routeNotifications,
  routeSearch,
  routeTemplates,
  routeTrash,
} from "./routes-navigation.js";
import { routeSiteMaintenance } from "./routes-maintenance.js";
import { routeSites } from "./routes-sites.js";
import { routeUsers } from "./routes-users.js";
import { routeProjects } from "./routes-work.js";

/**
 * Handler for one `/api/:resource` subtree. `parts` is the split pathname, so
 * `parts[0] === "api"` and `parts[1]` is the resource name.
 */
export type ApiRouteHandler = (
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  parts: string[],
  config: CloudServerConfig,
  principal: Principal,
) => Promise<void> | void;

/** Resource name → handler. Adding an API resource is one entry here. */
export const apiRoutes: ReadonlyMap<string, ApiRouteHandler> = new Map<string, ApiRouteHandler>([
  ["users", (req, res, _url, parts, config, principal) => routeUsers(req, res, parts, config, principal)],
  ["documents", (req, res, _url, parts, config, principal) => (parts[3] === "ai" ? routeDocumentAi(req, res, parts, config, principal) : routeDocuments(req, res, parts, config, principal))],
  ["sites", (req, res, url, parts, config, principal) => routeSiteExtensions(req, res, url, parts, config, principal)],
  ["db", (req, res, _url, parts, config, principal) => routeDatabase(req, res, parts, config, principal)],
  ["search", (req, res, url, _parts, config, principal) => routeSearch(req, res, url, config, principal)],
  ["navigation", (req, res, _url, parts, config, principal) => routeNavigation(req, res, parts, config, principal)],
  ["templates", (req, res, _url, _parts, config, principal) => routeTemplates(req, res, config, principal)],
  ["trash", (req, res, _url, parts, config, principal) => routeTrash(req, res, parts, config, principal)],
  ["labels", (req, res, url, parts, config, principal) => routeLabels(req, res, url, parts, config, principal)],
  ["notifications", (req, res, _url, parts, config, principal) => routeNotifications(req, res, parts, config, principal)],
  ["activity", (req, res, url, _parts, config, principal) => routeActivity(req, res, url, config, principal)],
  ["groups", (req, res, _url, parts, config, principal) => routeGroups(req, res, parts, config, principal)],
  ["projects", (req, res, url, parts, config, principal) => routeProjects(req, res, url, parts, config, principal)],
  ["ask", (req, res, _url, _parts, config, principal) => routeAskNoma(req, res, config, principal)],
  ["knowledge", (req, res, url, parts, config, principal) => routeKnowledge(req, res, url, parts, config, principal)],
  ["agent-inbox", (req, res, url, _parts, config, principal) => routeAgentInbox(req, res, url, config, principal)],
  ["agents", (req, res, _url, parts, config, principal) => routeAgents(req, res, parts, config, principal)],
  ["connectors", (req, res, _url, parts, config, principal) => routeConnectors(req, res, parts, config, principal)],
  ["recipes", (req, res, _url, parts, config, principal) => routeRecipes(req, res, parts, config, principal)],
  ["collections", (req, res, url, _parts, config, principal) => routeSemanticCollections(req, res, url, config, principal)],
  ["gateway", (req, res, _url, parts, config, principal) => routeAgentGateway(req, res, parts, config, principal)],
  ["analytics", (req, res, _url, _parts, config, principal) => routeKnowledgeAnalytics(req, res, config, principal)],
  ["backup", (req, res, _url, parts, config, principal) => routeBackup(req, res, parts, config, principal)],
  ["offline", (req, res, _url, parts, config, principal) => routeOffline(req, res, parts, config, principal)],
  ["realtime", (req, res, url, parts, config, principal) => routeRealtime(req, res, url, parts, config, principal)],
  ["enterprise", (req, res, _url, parts, config, principal) => routeEnterprise(req, res, parts, config, principal)],
  ["ai", (req, res, url, parts, config, principal) => routeAi(req, res, url, parts, config, principal)],
]);

/** `/api/sites/:id/{ai,maintenance,sync-manifest}` live in their feature modules; everything else is `routeSites`. */
const routeSiteExtensions: ApiRouteHandler = (req, res, url, parts, config, principal) => {
  if (parts[2] && parts[3] === "ai") return routeSiteAi(req, res, parts, config, principal);
  if (parts[2] && parts[3] === "maintenance") return routeSiteMaintenance(req, res, url, parts, config, principal);
  if (parts[2] && parts[3] === "sync-manifest") return routeSyncManifest(req, res, parts, config, principal);
  return routeSites(req, res, url, parts, config, principal);
};

export async function routeApi(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  config: CloudServerConfig,
  principal: Principal,
): Promise<void> {
  const parts = url.pathname.split("/").filter(Boolean);
  const handler = apiRoutes.get(parts[1] ?? "");
  if (!handler) throw new HttpError(404, "Unknown API resource");
  await handler(req, res, url, parts, config, principal);
}
