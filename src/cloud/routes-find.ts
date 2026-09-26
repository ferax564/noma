/**
 * `GET /api/find?q=` — one search box across the product: spaces, pages, Work issues, channels,
 * direct messages and chat messages, each already filtered by what the caller may read. Backs the
 * command palette (Cmd/Ctrl+K).
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { type CloudServerConfig, type Principal, requireUser } from "./context.js";
import { HttpError, sendJson } from "./http.js";
import { boundedInteger, numberQuery } from "./input.js";
import { findInChat } from "./routes-chat.js";

export function routeFind(req: IncomingMessage, res: ServerResponse, url: URL, config: CloudServerConfig, principal: Principal): void {
  if ((req.method ?? "GET") !== "GET") throw new HttpError(405, "Method not allowed");
  const user = requireUser(principal);
  const q = (url.searchParams.get("q") ?? "").trim().slice(0, 200);
  if (q.length < 2) throw new HttpError(400, "q must be at least 2 characters");
  const limit = boundedInteger(numberQuery(url.searchParams.get("limit")), 8, 1, 50, "limit");
  const needle = q.toLowerCase();
  const sites = config.store.listSites(user).filter((site) => !config.store.isTrashed("site", site.id));
  const spaces = sites
    .filter((site) => site.title.toLowerCase().includes(needle) || (site.key ?? "").toLowerCase() === needle)
    .slice(0, limit)
    .map((site) => ({ id: site.id, title: site.title, ...(site.key ? { key: site.key } : {}) }));
  const seenPages = new Set<string>();
  const pages = config.store
    .search(user, q, undefined, limit * 4)
    .filter((result) => (seenPages.has(result.documentId) ? false : (seenPages.add(result.documentId), true)))
    .slice(0, limit)
    .map((result) => ({ id: result.documentId, title: result.documentTitle, ...(result.siteId ? { siteId: result.siteId } : {}), excerpt: result.excerpt.slice(0, 200), ...(result.blockId ? { blockId: result.blockId } : {}) }));
  const projects = config.store.listProjects(user);
  const issues = projects
    .flatMap((project) => config.store.listIssues(project.id, { q, limit }).map((issue) => ({ project, issue })))
    .slice(0, limit)
    .map(({ project, issue }) => ({ id: issue.id, key: issue.key, summary: issue.summary, status: issue.status, projectId: project.id, siteId: project.siteId }));
  sendJson(res, 200, { q, spaces, pages, issues, ...findInChat(config, principal, user, q, limit) });
}
