/**
 * Document/user record operations and response shaping shared by several route modules (create/update
 * documents, source inspection, preconditions).
 */
import type { IncomingMessage } from "node:http";
import { type Diagnostic, walk } from "../ast.js";
import type { CloudDocumentRecord, CloudUserRecord } from "../cloud-db.js";
import { convertMarkdownToNoma } from "../ingest-markdown.js";
import { slugify, parse } from "../parser.js";
import { renderJson } from "../renderer-json.js";
import { renderLlm } from "../renderer-llm.js";
import { validate } from "../validator.js";
import {
  type AccessContext,
  type CloudServerConfig,
  randomId,
  randomToken,
  recordActivity,
  tokenPreview,
  uniqueId,
  writeDocument,
  writeNotification,
  writeUser,
} from "./context.js";
import { headerValue, HttpError, sha256Hex } from "./http.js";
import { optionalString } from "./input.js";
import { afterDocumentSaved } from "./page-hooks.js";
import { documentComponentKit, documentComponentKitSource, documentStyleTokens, requirePageWritable } from "./spaces.js";
import type { ComponentKit } from "../components.js";
import type { StyleTokenAliases } from "../style-tokens.js";
import { assignTaskIds } from "./tasks.js";
import { resolveCreateTemplate } from "./templates.js";

export interface SourceInspection {
  hash: string;
  diagnostics: Diagnostic[];
  json: string;
  llm: string;
}

export async function createUser(
  config: CloudServerConfig,
  input: Record<string, unknown>,
): Promise<{ record: CloudUserRecord; token: string }> {
  const token = randomToken("nu");
  const now = config.now().toISOString();
  const record: CloudUserRecord = {
    version: 1,
    id: randomId(),
    name: userName(input.name),
    tokenHash: sha256Hex(token),
    tokenPreview: tokenPreview(token),
    createdAt: now,
    updatedAt: now,
  };
  await writeUser(config, record);
  return { record, token };
}

export async function createDocument(
  config: CloudServerConfig,
  input: Record<string, unknown>,
  user: CloudUserRecord,
  spaceTitle = "Noma Workspace",
  siteId?: string,
  deferSaveHooks = false,
): Promise<CloudDocumentRecord> {
  const id = uniqueId(config);
  const template = resolveCreateTemplate(config, input.templateId, siteId);
  const requestedTitle = optionalString(input.title) ?? template?.title ?? "Untitled document";
  const source = assignTaskIds(template ? template.instantiate(requestedTitle, spaceTitle, input.variables, user) : sourceFromCreateInput(input));
  inspectSource(source, id);
  const now = config.now().toISOString();
  const record: CloudDocumentRecord = {
    version: 2,
    id,
    title: titleFromInput(template ? { ...input, title: requestedTitle } : input, source),
    source,
    hash: sha256Hex(source),
    createdAt: now,
    updatedAt: now,
    createdBy: user.id,
    updatedBy: user.id,
    permissions: {
      [user.id]: { role: "owner", addedAt: now },
    },
    shareLinks: [],
  };
  await writeDocument(config, record);
  config.store.setWatch(user.id, "document", record.id, now);
  recordActivity(config, user, "document.created", "document", record.id, { title: record.title });
  if (!deferSaveHooks) afterDocumentSaved(config, undefined, record, { user, name: user.name });
  return record;
}

export async function updateDocument(
  config: CloudServerConfig,
  existing: CloudDocumentRecord,
  input: Record<string, unknown>,
  access: AccessContext,
  options: { assignTaskIds?: boolean } = {},
): Promise<CloudDocumentRecord> {
  requirePageWritable(config, existing.id);
  const submitted = input.source === undefined ? existing.source : sourceFromInput(input);
  const source = options.assignTaskIds && input.source !== undefined ? assignTaskIds(submitted) : submitted;
  inspectSource(source, existing.id);
  const record: CloudDocumentRecord = {
    ...existing,
    title: titleFromInput(input, source, existing.title),
    source,
    hash: sha256Hex(source),
    updatedAt: config.now().toISOString(),
    updatedBy: access.user?.id ?? `share:${access.share?.id ?? "unknown"}`,
  };
  await writeDocument(config, record, existing.hash);
  if (access.user) recordActivity(config, access.user, "document.updated", "document", record.id, { hash: record.hash });
  if (record.hash !== existing.hash || record.title !== existing.title) notifyPageWatchers(config, record, access);
  if (access.user) config.store.setWatch(access.user.id, "document", record.id, record.updatedAt);
  afterDocumentSaved(config, existing, record, { ...(access.user ? { user: access.user } : {}), name: access.user?.name ?? "A share-link editor" });
  return record;
}

export function documentResponse(record: CloudDocumentRecord, access: AccessContext, config: CloudServerConfig): Record<string, unknown> & SourceInspection {
  const styleTokens = documentStyleTokens(config, record.id);
  const components = documentComponentKit(config, record.id);
  return {
    version: record.version,
    id: record.id,
    title: record.title,
    source: record.source,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
    createdBy: record.createdBy,
    updatedBy: record.updatedBy,
    ...inspectSource(record.source, record.id, styleTokens, components),
    styleTokens,
    componentKit: documentComponentKitSource(config, record.id),
    access: accessResponse(access),
  };
}

export function accessResponse(access: AccessContext): Record<string, unknown> {
  return {
    role: access.role,
    via: access.via,
    user: access.user ? selfUser(access.user) : undefined,
    shareId: access.share?.id,
    groupId: access.groupId,
  };
}

/** A user as other users see it: no token hash, no token preview, and no email address. */
export function publicUser(user: CloudUserRecord): Omit<CloudUserRecord, "tokenHash" | "tokenPreview" | "email"> {
  const { tokenHash: _tokenHash, tokenPreview: _tokenPreview, email: _email, ...out } = user;
  return out;
}

/** A user as they see themselves: includes the legacy token preview, never the hash. */
export function selfUser(user: CloudUserRecord): Omit<CloudUserRecord, "tokenHash"> {
  const { tokenHash: _tokenHash, ...out } = user;
  return out;
}

export function inspectSource(source: string, id: string, styleTokens?: StyleTokenAliases, components?: ComponentKit): SourceInspection {
  const doc = parse(source, { filename: `${id}.noma` });
  return {
    hash: sha256Hex(source),
    diagnostics: validate(doc, { ...(styleTokens ? { styleTokens } : {}), ...(components && components.size > 0 ? { components } : {}) }),
    json: renderJson(doc),
    llm: renderLlm(doc),
  };
}

function sourceFromInput(input: Record<string, unknown>): string {
  if (typeof input.source !== "string") throw new HttpError(400, "source must be a string");
  if (input.source.trim().length === 0) throw new HttpError(400, "source cannot be empty");
  return input.source;
}

function sourceFromCreateInput(input: Record<string, unknown>): string {
  const source = sourceFromInput(input);
  const format = optionalString(input.format)?.toLowerCase() ?? "noma";
  if (format === "noma") return source.replace(/\r\n?/g, "\n");
  if (format === "markdown" || format === "md") return convertMarkdownToNoma(source);
  throw new HttpError(400, "format must be noma or markdown");
}

export function documentHasBlock(document: CloudDocumentRecord, blockId: string): boolean {
  const doc = parse(document.source, { filename: `${document.id}.noma` });
  for (const node of walk(doc)) {
    if (node.id === blockId || node.aliases?.includes(blockId)) return true;
  }
  return false;
}

export function requireDocumentPrecondition(
  req: IncomingMessage,
  document: CloudDocumentRecord,
  input: Record<string, unknown>,
): void {
  if (input.expectedHash !== undefined && typeof input.expectedHash !== "string") {
    throw new HttpError(400, "expectedHash must be a SHA-256 string");
  }
  const bodyHash = optionalString(input.expectedHash);
  const headerHash = ifMatchHash(headerValue(req, "if-match"));
  if (bodyHash && headerHash && bodyHash !== headerHash) {
    throw new HttpError(400, "expectedHash and If-Match must agree");
  }
  const expectedHash = bodyHash ?? headerHash;
  if (!expectedHash) {
    throw new HttpError(428, "Document updates require expectedHash or If-Match", {
      code: "precondition_required",
      currentHash: document.hash,
    });
  }
  if (!/^[a-f0-9]{64}$/.test(expectedHash)) throw new HttpError(400, "expectedHash must be a lowercase SHA-256 hash");
  if (expectedHash !== document.hash) {
    throw new HttpError(409, "Document changed since it was loaded", {
      code: "document_conflict",
      expectedHash,
      currentHash: document.hash,
      currentUpdatedAt: document.updatedAt,
    });
  }
}

function ifMatchHash(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const match = /^(?:W\/)?"?([a-f0-9]{64})"?$/.exec(value.trim());
  if (!match?.[1]) throw new HttpError(400, "If-Match must contain one SHA-256 hash");
  return match[1];
}

function titleFromInput(input: Record<string, unknown>, source: string, fallback = "Untitled document"): string {
  const title = optionalString(input.title);
  if (title) return title.slice(0, 120);
  const heading = source.match(/^#\s+(.+)$/m)?.[1]?.replace(/\s+\{[^}]*\}\s*$/, "").trim();
  return heading ? heading.slice(0, 120) : fallback;
}

export function cloudSlug(title: string, fallback: string): string {
  return (slugify(title) || fallback).slice(0, 80);
}

function userName(value: unknown): string {
  const name = optionalString(value);
  return name ? name.slice(0, 80) : "Noma collaborator";
}

export function notifyPageWatchers(config: CloudServerConfig, document: CloudDocumentRecord, access: AccessContext): void {
  const actorId = access.user?.id;
  const actorName = access.user?.name ?? "A share-link editor";
  for (const userId of config.store.documentWatchers(document.id)) {
    if (userId === actorId || !config.store.documentAccessRole(userId, document.id)) continue;
    writeNotification(config, userId, "page_updated", `${document.title} was updated`, `${actorName} edited ${document.title}.`, "document", document.id);
  }
}
