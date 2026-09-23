/** `/api/documents/:id/restrictions`: Confluence-style page view/edit restrictions. */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { CloudDocumentRecord, CloudPageRestrictions, CloudRestrictionPrincipals, CloudUserRecord } from "../cloud-db.js";
import {
  type CloudServerConfig,
  type Principal,
  recordActivity,
  requireRecordAccess,
  requireUser,
} from "./context.js";
import { HttpError, readJsonBody, sendJson } from "./http.js";
import { assertCloudId, optionalRecord } from "./input.js";

const MAX_RESTRICTION_PRINCIPALS = 200;

export async function routeDocumentRestrictions(
  req: IncomingMessage,
  res: ServerResponse,
  config: CloudServerConfig,
  principal: Principal,
  document: CloudDocumentRecord,
): Promise<void> {
  const method = req.method ?? "GET";
  const manager = principal.user && canManageRestrictions(config, principal.user, document) ? principal.user : undefined;
  if (method === "GET") {
    if (!manager) requireRecordAccess(config, document, principal, "viewer");
    sendJson(res, 200, restrictionsResponse(config, document, principal, Boolean(manager)));
    return;
  }
  if (method === "PUT") {
    const user = requireUser(principal);
    if (!manager) throw new HttpError(403, "Only the page owner, a space owner, or a workspace admin can change restrictions");
    const restrictions = restrictionsInput(config, await readJsonBody(req, config.maxBodyBytes));
    config.store.replacePageRestrictions(document.id, restrictions, user.id, config.now().toISOString());
    recordActivity(config, user, "document.restrictions_updated", "document", document.id, {
      view: restrictions.view.users.length + restrictions.view.groups.length,
      edit: restrictions.edit.users.length + restrictions.edit.groups.length,
    });
    sendJson(res, 200, restrictionsResponse(config, document, principal, true));
    return;
  }
  throw new HttpError(405, "Method not allowed");
}

/**
 * Direct page owners, owners of any space containing the page, and workspace admins manage
 * restrictions. Space owners keep this even when a restriction hides the page from them, so a
 * space can always recover a page someone locked.
 */
export function canManageRestrictions(config: CloudServerConfig, user: CloudUserRecord, document: CloudDocumentRecord): boolean {
  if (config.store.isWorkspaceAdmin(user.id) || config.store.isDirectDocumentOwner(user.id, document.id)) return true;
  return config.store
    .documentSiteIds(document.id)
    .some((siteId) => !config.store.isTrashed("site", siteId) && config.store.resourceAccess(user.id, "site", siteId)?.role === "owner");
}

function restrictionsResponse(config: CloudServerConfig, document: CloudDocumentRecord, principal: Principal, canManage: boolean): Record<string, unknown> {
  const restrictions = config.store.readPageRestrictions(document.id);
  const users = (ids: string[]) => ids.map((id) => ({ id, name: config.store.readUser(id)?.name ?? "Unknown user" }));
  const groups = (ids: string[]) => ids.map((id) => ({ id, name: config.store.readGroup(id)?.name ?? "Unknown group" }));
  const principals = (entry: CloudRestrictionPrincipals) => ({ users: users(entry.users), groups: groups(entry.groups) });
  const viewerId = principal.user?.id;
  return {
    documentId: document.id,
    view: principals(restrictions.view),
    edit: principals(restrictions.edit),
    inherited: config.store.restrictedAncestors(document.id).map((ancestorId) => {
      const visible = viewerId ? config.store.documentAccessRole(viewerId, ancestorId) !== undefined : false;
      const ancestor = visible ? config.store.readDocument(ancestorId) : undefined;
      return { documentId: ancestorId, ...(ancestor ? { title: ancestor.title } : {}) };
    }),
    restricted: {
      view: restrictions.view.users.length + restrictions.view.groups.length > 0,
      edit: restrictions.edit.users.length + restrictions.edit.groups.length > 0,
    },
    canManage,
  };
}

function restrictionsInput(config: CloudServerConfig, input: Record<string, unknown>): CloudPageRestrictions {
  return {
    view: principalsInput(config, input.view, "view"),
    edit: principalsInput(config, input.edit, "edit"),
  };
}

function principalsInput(config: CloudServerConfig, value: unknown, label: string): CloudRestrictionPrincipals {
  const record = optionalRecord(value, label) ?? {};
  const users = idListInput(record.users, `${label}.users`);
  const groups = idListInput(record.groups, `${label}.groups`);
  if (users.length + groups.length > MAX_RESTRICTION_PRINCIPALS) {
    throw new HttpError(400, `${label} restrictions cannot list more than ${MAX_RESTRICTION_PRINCIPALS} users and groups`);
  }
  for (const userId of users) if (!config.store.readUser(userId)) throw new HttpError(400, `Unknown user in ${label}.users: ${userId}`);
  for (const groupId of groups) if (!config.store.readGroup(groupId)) throw new HttpError(400, `Unknown group in ${label}.groups: ${groupId}`);
  return { users, groups };
}

function idListInput(value: unknown, label: string): string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw new HttpError(400, `${label} must be an array of IDs`);
  if (value.length > MAX_RESTRICTION_PRINCIPALS) throw new HttpError(400, `${label} cannot contain more than ${MAX_RESTRICTION_PRINCIPALS} IDs`);
  const ids = value.map((item) => {
    if (typeof item !== "string") throw new HttpError(400, `${label} must contain ID strings`);
    assertCloudId(item, label.endsWith("groups") ? "Group" : "User");
    return item;
  });
  return [...new Set(ids)].sort();
}
