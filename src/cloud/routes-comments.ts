/**
 * Page comments: threads, block and text-range anchors, edit, soft delete, resolve, and reactions.
 * Mounted at `/api/documents/:id/comments` and `/api/sites/:id/documents/:docId/comments`.
 */
import type { IncomingMessage, ServerResponse } from "node:http";
import { walk } from "../ast.js";
import type { CloudComment, CloudCommentAnchor, CloudCommentReaction, CloudDocumentRecord, CloudNotification, CloudUserRecord } from "../cloud-db.js";
import { inlineToPlain } from "../inline.js";
import { parse } from "../parser.js";
import {
  type AccessContext,
  type CloudServerConfig,
  isWorkspaceAdmin,
  type Principal,
  recordActivity,
  requireAccessRole,
  requireUser,
  uniqueId,
  writeNotification,
} from "./context.js";
import { decodePathSegment, HttpError, readJsonBody, sendJson } from "./http.js";
import { boundedInteger, optionalRecord, optionalString, stringInput } from "./input.js";
import { extractMentions, mentionNames } from "./mentions.js";
import { documentHasBlock } from "./records.js";

/** Reactions are a fixed, small set so they render consistently and cannot carry arbitrary text. */
export const commentReactionEmoji = ["👍", "👎", "😄", "🎉", "😕", "❤️", "🚀", "👀"] as const;

export interface CommentReactionSummary {
  emoji: string;
  count: number;
  reacted: boolean;
  users: string[];
}

export type CommentResponse = CloudComment & {
  deleted?: true;
  outdated?: boolean;
  reactions: CommentReactionSummary[];
  mentions: Array<{ id: string; name: string }>;
};

export async function routeComments(
  req: IncomingMessage,
  res: ServerResponse,
  commentId: string | undefined,
  action: string | undefined,
  actionArg: string | undefined,
  config: CloudServerConfig,
  principal: Principal,
  document: CloudDocumentRecord,
  access: AccessContext,
): Promise<void> {
  const method = req.method ?? "GET";
  const user = requireUser(principal);

  if (!commentId && method === "GET") {
    sendJson(res, 200, { comments: listCommentResponses(config, user, document), reactionSet: commentReactionEmoji });
    return;
  }

  if (!commentId && method === "POST") {
    const input = await readJsonBody(req, config.maxBodyBytes);
    const comment = createComment(config, user, document, input);
    sendJson(res, 201, commentResponse(config, user, document, comment));
    return;
  }

  if (!commentId) throw new HttpError(404, "Unknown comment route");
  const existing = config.store.readComment(commentId);
  if (!existing || existing.documentId !== document.id) throw new HttpError(404, "Comment not found");

  if (!action && method === "PATCH") {
    if (existing.deletedAt) throw new HttpError(409, "Deleted comments cannot be edited");
    if (existing.createdBy !== user.id) throw new HttpError(403, "Only the author can edit a comment");
    const input = await readJsonBody(req, config.maxBodyBytes);
    const body = commentBody(input);
    if (body !== existing.body) {
      const now = config.now().toISOString();
      config.store.editComment(existing.id, body, now);
      notifyNewMentions(config, document, existing, body, user);
      recordActivity(config, user, "comment.edited", "document", document.id, { commentId: existing.id });
    }
    sendJson(res, 200, commentResponse(config, user, document, config.store.readComment(existing.id)!));
    return;
  }

  if (!action && method === "DELETE") {
    if (existing.createdBy !== user.id && access.role !== "owner" && !isWorkspaceAdmin(config, user)) {
      throw new HttpError(403, "Only the author, a page owner, or a workspace admin can delete this comment");
    }
    if (!existing.deletedAt) {
      config.store.softDeleteComment(existing.id, user.id, config.now().toISOString());
      recordActivity(config, user, "comment.deleted", "document", document.id, { commentId: existing.id, authorId: existing.createdBy });
    }
    sendJson(res, 200, commentResponse(config, user, document, config.store.readComment(existing.id)!));
    return;
  }

  if (action === "resolve" && method === "POST") {
    if (existing.deletedAt) throw new HttpError(409, "Deleted comments cannot be resolved");
    if (existing.createdBy !== user.id) requireAccessRole(access, "editor");
    const now = config.now().toISOString();
    config.store.writeComment({
      ...existing,
      updatedAt: now,
      resolvedAt: existing.resolvedAt ? undefined : now,
      resolvedBy: existing.resolvedAt ? undefined : user.id,
    });
    recordActivity(config, user, existing.resolvedAt ? "comment.reopened" : "comment.resolved", "document", document.id, { commentId });
    sendJson(res, 200, commentResponse(config, user, document, config.store.readComment(commentId)!));
    return;
  }

  if (action === "reactions" && (method === "POST" || method === "DELETE")) {
    if (existing.deletedAt) throw new HttpError(409, "Deleted comments cannot take reactions");
    const emoji = method === "POST" ? reactionInput((await readJsonBody(req, config.maxBodyBytes)).emoji) : reactionInput(decodePathSegment(actionArg ?? ""));
    if (method === "POST") {
      if (config.store.countCommentReactions(existing.id) >= 500) throw new HttpError(409, "This comment has too many reactions");
      config.store.addCommentReaction(existing.id, user.id, emoji, config.now().toISOString());
    } else {
      config.store.removeCommentReaction(existing.id, user.id, emoji);
    }
    sendJson(res, 200, commentResponse(config, user, document, existing));
    return;
  }

  throw new HttpError(404, "Unknown comment route");
}

function createComment(config: CloudServerConfig, user: CloudUserRecord, document: CloudDocumentRecord, input: Record<string, unknown>): CloudComment {
  const body = commentBody(input);
  const anchor = anchorInput(document, input.anchor);
  const blockId = anchor?.blockId ?? optionalString(input.blockId)?.slice(0, 160);
  const line = input.line === undefined ? undefined : boundedInteger(input.line, 1, 1, 1_000_000, "line");
  const parentId = optionalString(input.parentId);
  if (blockId && !documentHasBlock(document, blockId)) throw new HttpError(400, "Comment blockId does not exist in this document");
  if (parentId) {
    const parent = config.store.readComment(parentId);
    if (!parent || parent.documentId !== document.id) throw new HttpError(400, "Comment parentId does not exist in this document");
    if (parent.deletedAt) throw new HttpError(409, "Cannot reply to a deleted comment");
  }
  if (config.store.listComments(document.id).length >= 5_000) throw new HttpError(409, "This page has too many comments");
  const now = config.now().toISOString();
  const comment: Omit<CloudComment, "createdByName"> = {
    id: uniqueId(config),
    documentId: document.id,
    ...(blockId ? { blockId } : {}),
    ...(line === undefined ? {} : { line }),
    ...(parentId ? { parentId } : {}),
    body,
    createdBy: user.id,
    createdAt: now,
    updatedAt: now,
  };
  config.store.writeComment(comment);
  if (anchor) config.store.setCommentAnchor(comment.id, anchor);
  notifyCommentParticipants(config, document, comment, user);
  recordActivity(config, user, parentId ? "comment.replied" : "comment.created", "document", document.id, {
    commentId: comment.id,
    blockId,
    line,
    ...(anchor ? { quote: anchor.quote.slice(0, 120) } : {}),
  });
  return config.store.readComment(comment.id)!;
}

export function listCommentResponses(config: CloudServerConfig, user: CloudUserRecord, document: CloudDocumentRecord): CommentResponse[] {
  const reactions = config.store.listCommentReactions(document.id);
  const blocks = anchorBlockTexts(document);
  return config.store.listComments(document.id).map((comment) => shapeComment(config, user, document, comment, reactions.get(comment.id) ?? [], blocks));
}

function commentResponse(config: CloudServerConfig, user: CloudUserRecord, document: CloudDocumentRecord, comment: CloudComment): CommentResponse {
  const reactions = config.store.listCommentReactions(document.id).get(comment.id) ?? [];
  return shapeComment(config, user, document, comment, reactions, comment.anchor ? anchorBlockTexts(document) : new Map());
}

function shapeComment(
  config: CloudServerConfig,
  user: CloudUserRecord,
  document: CloudDocumentRecord,
  comment: CloudComment,
  reactions: CloudCommentReaction[],
  blockTexts: Map<string, string>,
): CommentResponse {
  if (comment.deletedAt) {
    const { anchor, ...rest } = comment;
    return { ...rest, ...(anchor ? { anchor: { blockId: anchor.blockId, quote: "" } } : {}), body: "", deleted: true, reactions: [], mentions: [] };
  }
  const outdated = comment.anchor ? !quoteStillPresent(blockTexts.get(comment.anchor.blockId), comment.anchor.quote) : undefined;
  return {
    ...comment,
    ...(outdated === undefined ? {} : { outdated }),
    reactions: summarizeReactions(reactions, user.id),
    mentions: mentionNames(config, user, comment.body, document.id),
  };
}

function summarizeReactions(reactions: CloudCommentReaction[], userId: string): CommentReactionSummary[] {
  const byEmoji = new Map<string, CloudCommentReaction[]>();
  for (const reaction of reactions) byEmoji.set(reaction.emoji, [...(byEmoji.get(reaction.emoji) ?? []), reaction]);
  return commentReactionEmoji
    .filter((emoji) => byEmoji.has(emoji))
    .map((emoji) => {
      const list = byEmoji.get(emoji)!;
      return { emoji, count: list.length, reacted: list.some((reaction) => reaction.userId === userId), users: list.slice(0, 20).map((reaction) => reaction.userName) };
    });
}

function commentBody(input: Record<string, unknown>): string {
  const body = stringInput(input, "body");
  if (body.length > 10_000) throw new HttpError(400, "body cannot be longer than 10000 characters");
  return body;
}

function reactionInput(value: unknown): string {
  if (typeof value === "string" && (commentReactionEmoji as readonly string[]).includes(value)) return value;
  throw new HttpError(400, `emoji must be one of ${commentReactionEmoji.join(" ")}`);
}

function anchorInput(document: CloudDocumentRecord, value: unknown): CloudCommentAnchor | undefined {
  const record = optionalRecord(value, "anchor");
  if (!record) return undefined;
  const blockId = stringInput(record, "blockId").slice(0, 160);
  const quote = typeof record.quote === "string" ? normalizeText(record.quote) : "";
  if (!quote || quote.length > 500) throw new HttpError(400, "anchor.quote must be 1-500 characters");
  const prefix = anchorContext(record.prefix, "prefix");
  const suffix = anchorContext(record.suffix, "suffix");
  const blocks = anchorBlockTexts(document);
  if (!blocks.has(blockId)) throw new HttpError(400, "anchor.blockId does not exist in this document");
  if (!quoteStillPresent(blocks.get(blockId), quote)) throw new HttpError(400, "anchor.quote does not appear in that block");
  return { blockId, quote, ...(prefix ? { prefix } : {}), ...(suffix ? { suffix } : {}) };
}

function anchorContext(value: unknown, label: string): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string") throw new HttpError(400, `anchor.${label} must be a string`);
  return value.replace(/\s+/g, " ").slice(label === "prefix" ? -64 : 0, label === "prefix" ? undefined : 64);
}

/** Plain text of every identified block (by ID and alias), as a reader sees it in the rendered page. */
function anchorBlockTexts(document: CloudDocumentRecord): Map<string, string> {
  const lines = document.source.split("\n");
  const texts = new Map<string, string>();
  for (const node of walk(parse(document.source, { filename: `${document.id}.noma` }))) {
    if (!node.id || node.type === "document" || !node.pos?.line) continue;
    const slice = lines.slice(node.pos.line - 1, node.endLine ?? node.pos.line);
    const text = normalizeText(slice.map(plainSourceLine).join(" "));
    for (const key of [node.id, ...(node.aliases ?? [])]) if (!texts.has(key)) texts.set(key, text);
  }
  return texts;
}

function plainSourceLine(line: string): string {
  const trimmed = line.trim();
  if (/^:{2,}/.test(trimmed) || /^```|^~~~|^\|?\s*:?-{3,}/.test(trimmed)) return "";
  const withoutMarkers = trimmed
    .replace(/^#{1,6}\s+/, "")
    .replace(/\s+\{[^}]*\}\s*$/, "")
    .replace(/^(?:[-*+]|\d+[.)])\s+/, "")
    .replace(/^\{#[^}]+\}\s*/, "")
    .replace(/^\[[ xX]\]\s+/, "")
    .replace(/^>\s?/, "")
    .replace(/\|/g, " ");
  return inlineToPlain(withoutMarkers);
}

function normalizeText(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function quoteStillPresent(blockText: string | undefined, quote: string): boolean {
  return blockText !== undefined && blockText.includes(normalizeText(quote));
}

function notifyNewMentions(config: CloudServerConfig, document: CloudDocumentRecord, previous: CloudComment, body: string, actor: CloudUserRecord): void {
  const before = new Set(extractMentions(previous.body));
  for (const userId of extractMentions(body)) {
    if (before.has(userId) || userId === actor.id || !config.store.documentAccessRole(userId, document.id)) continue;
    writeNotification(config, userId, "mention", `Mentioned in ${document.title}`, `${actor.name}: ${body.slice(0, 240)}`, "document", document.id);
  }
}

function notifyCommentParticipants(
  config: CloudServerConfig,
  document: CloudDocumentRecord,
  comment: Omit<CloudComment, "createdByName">,
  actor: CloudUserRecord,
): void {
  const recipients = new Map<string, CloudNotification["type"]>();
  for (const userId of extractMentions(comment.body)) {
    if (userId !== actor.id && config.store.documentAccessRole(userId, document.id)) recipients.set(userId, "mention");
  }
  if (comment.parentId) {
    const parent = config.store.readComment(comment.parentId);
    if (parent && parent.createdBy !== actor.id) recipients.set(parent.createdBy, recipients.get(parent.createdBy) ?? "comment");
  } else if (document.createdBy !== actor.id) {
    recipients.set(document.createdBy, recipients.get(document.createdBy) ?? "comment");
  }
  for (const [userId, type] of recipients) {
    if (!config.store.documentAccessRole(userId, document.id)) continue;
    writeNotification(
      config,
      userId,
      type,
      type === "mention" ? `Mentioned in ${document.title}` : `New comment on ${document.title}`,
      `${actor.name}: ${comment.body.slice(0, 240)}`,
      "document",
      document.id,
    );
  }
}
