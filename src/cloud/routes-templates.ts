/**
 * `/api/templates`: built-in page templates plus workspace templates (workspace
 * admins manage them) and space templates (space editors manage them).
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import type { CloudPageTemplateRecord, CloudPageTemplateScope, CloudUserRecord } from "../cloud-db.js";
import { builtInTemplateValues, cloudPageTemplates, instantiateTemplateSource } from "../cloud-templates.js";
import { parse } from "../parser.js";
import {
  type CloudServerConfig,
  isWorkspaceAdmin,
  type Principal,
  randomId,
  readDocument,
  readSite,
  recordActivity,
  requireNotTrashed,
  requireRecordAccess,
  requireUser,
  requireWorkspaceOwner,
} from "./context.js";
import { HttpError, readJsonBody, sendJson } from "./http.js";
import { assertCloudId, optionalCloudId, optionalString } from "./input.js";
import {
  assertTemplateSource,
  builtInTemplateResponses,
  templateResponse,
  templateSourceFromPage,
  templateVariablesInput,
} from "./templates.js";

const TEMPLATE_CATEGORIES = new Set(["general", "team", "project", "technical", "research"]);

export async function routeTemplates(
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  parts: string[],
  config: CloudServerConfig,
  principal: Principal,
): Promise<void> {
  const method = req.method ?? "GET";
  const user = requireUser(principal);
  const id = parts[2];

  if (!id && method === "GET") {
    const siteId = optionalCloudId(url.searchParams.get("site"), "Site");
    const siteIds: string[] = [];
    if (siteId) {
      const site = await readSite(config, siteId);
      requireNotTrashed(config, "site", siteId);
      requireRecordAccess(config, site, principal, "viewer");
      siteIds.push(siteId);
    }
    const stored = config.store.listPageTemplates(siteIds).map((template) => templateResponse(template, canManage(config, principal, user, template)));
    const templates = [...builtInTemplateResponses(), ...stored];
    sendJson(res, 200, { templates, count: templates.length, storage: stored.length > 0 ? "mixed" : "built-in" });
    return;
  }

  if (!id && method === "POST") {
    const input = await readJsonBody(req, config.maxBodyBytes);
    const scope = scopeInput(input.scope);
    const siteId = scope === "site" ? optionalCloudId(input.siteId, "Site") : undefined;
    if (scope === "site" && !siteId) throw new HttpError(400, "siteId is required for space templates");
    if (siteId) await requireSiteEditor(config, principal, siteId);
    else requireWorkspaceOwner(config, user);
    const variables = templateVariablesInput(input.variables);
    const source = await sourceInput(config, principal, input);
    assertTemplateSource(source, variables);
    assertTemplateParses(source);
    const now = config.now().toISOString();
    const template: CloudPageTemplateRecord = {
      id: randomId(),
      scope,
      ...(siteId ? { siteId } : {}),
      name: nameInput(input.name),
      description: (optionalString(input.description) ?? "").slice(0, 400),
      category: categoryInput(input.category),
      source,
      variables,
      createdBy: user.id,
      updatedBy: user.id,
      createdAt: now,
      updatedAt: now,
    };
    config.store.writePageTemplate(template);
    if (siteId) recordActivity(config, user, "template.created", "site", siteId, { templateId: template.id, name: template.name });
    sendJson(res, 201, templateResponse(template, true));
    return;
  }

  if (!id) throw new HttpError(405, "Method not allowed");
  if (cloudPageTemplates.some((template) => template.id === id)) {
    if (method !== "GET") throw new HttpError(403, "Built-in templates are read-only");
    sendJson(res, 200, builtInTemplateResponses().find((template) => template.id === id));
    return;
  }
  assertCloudId(id, "Template");
  const template = config.store.readPageTemplate(id);
  if (!template) throw new HttpError(404, "Template not found");
  if (template.siteId) {
    const site = await readSite(config, template.siteId);
    requireNotTrashed(config, "site", site.id);
    requireRecordAccess(config, site, principal, "viewer");
  }

  if (method === "GET") {
    sendJson(res, 200, templateResponse(template, canManage(config, principal, user, template)));
    return;
  }

  if (!canManage(config, principal, user, template)) {
    throw new HttpError(403, template.scope === "site" ? "editor access to the space is required" : "Workspace owner access is required");
  }

  if (method === "PUT" || method === "PATCH") {
    const input = await readJsonBody(req, config.maxBodyBytes);
    const variables = input.variables === undefined ? template.variables : templateVariablesInput(input.variables);
    const source = input.source === undefined && input.fromDocumentId === undefined ? template.source : await sourceInput(config, principal, input);
    assertTemplateSource(source, variables);
    assertTemplateParses(source);
    const updated: CloudPageTemplateRecord = {
      ...template,
      name: input.name === undefined ? template.name : nameInput(input.name),
      description: input.description === undefined ? template.description : (optionalString(input.description) ?? "").slice(0, 400),
      category: input.category === undefined ? template.category : categoryInput(input.category),
      source,
      variables,
      updatedBy: user.id,
      updatedAt: config.now().toISOString(),
    };
    config.store.writePageTemplate(updated);
    if (template.siteId) recordActivity(config, user, "template.updated", "site", template.siteId, { templateId: template.id });
    sendJson(res, 200, templateResponse(updated, true));
    return;
  }

  if (method === "DELETE") {
    config.store.deletePageTemplate(template.id);
    if (template.siteId) recordActivity(config, user, "template.deleted", "site", template.siteId, { templateId: template.id });
    sendJson(res, 200, { ok: true, id: template.id });
    return;
  }

  throw new HttpError(405, "Method not allowed");
}

function canManage(config: CloudServerConfig, principal: Principal, user: CloudUserRecord, template: CloudPageTemplateRecord): boolean {
  if (template.scope === "workspace") return isWorkspaceAdmin(config, user);
  const site = template.siteId ? config.store.readSite(template.siteId) : undefined;
  if (!site) return false;
  try {
    requireRecordAccess(config, site, principal, "editor");
    return true;
  } catch {
    return false;
  }
}

async function requireSiteEditor(config: CloudServerConfig, principal: Principal, siteId: string): Promise<void> {
  const site = await readSite(config, siteId);
  requireNotTrashed(config, "site", siteId);
  requireRecordAccess(config, site, principal, "editor");
}

async function sourceInput(config: CloudServerConfig, principal: Principal, input: Record<string, unknown>): Promise<string> {
  const fromDocumentId = optionalCloudId(input.fromDocumentId, "Document");
  if (fromDocumentId) {
    const document = await readDocument(config, fromDocumentId);
    requireNotTrashed(config, "document", fromDocumentId);
    requireRecordAccess(config, document, principal, "viewer");
    return templateSourceFromPage(document.source);
  }
  if (typeof input.source !== "string") throw new HttpError(400, "source or fromDocumentId is required");
  return input.source.replace(/\r\n?/g, "\n");
}

function assertTemplateParses(source: string): void {
  try {
    parse(instantiateTemplateSource(source, builtInTemplateValues("Template preview", "Space")), { filename: "template.noma" });
  } catch (error) {
    throw new HttpError(400, `Template source does not parse: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function scopeInput(value: unknown): CloudPageTemplateScope {
  if (value === "workspace" || value === "site") return value;
  throw new HttpError(400, "scope must be workspace or site");
}

function nameInput(value: unknown): string {
  const name = optionalString(value);
  if (!name) throw new HttpError(400, "name is required");
  return name.slice(0, 120);
}

function categoryInput(value: unknown): string {
  const category = optionalString(value) ?? "general";
  if (!TEMPLATE_CATEGORIES.has(category)) throw new HttpError(400, `category must be one of ${[...TEMPLATE_CATEGORIES].join(", ")}`);
  return category;
}
