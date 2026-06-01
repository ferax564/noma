import yaml from "js-yaml";
import type { AttrValue, DirectiveNode, Node } from "./ast.js";
import { isDirective, walk } from "./ast.js";
import {
  type DocxReviewBlockLabel,
  type DocxReviewBlockBody,
  type DocxReviewBlockMetadata,
  type DocxReviewCaption,
  type DocxReviewComment,
  type DocxReviewData,
  type DocxReviewHeading,
  type DocxReviewMetricMetadata,
  type DocxReviewMetricValue,
  type DocxReviewNote,
  type DocxReviewRevision,
  type DocxReviewTable,
  extractDocxReviewData,
} from "./docx-review-data.js";
import { escapePipeTableCell, serializeDelimitedRow, splitPipeRow, unescapeMarkdownLinkLabel, unescapeMarkdownTextEscapes } from "./inline.js";
import { parse } from "./parser.js";
import { patchSource, type PatchOp } from "./patch.js";
import { buildDatasetRegistry, type DatasetTable } from "./renderer-html.js";

type ReviewTextFieldKey = "title" | "caption" | "label" | "Label" | "name";
type MetricValuePatchKey = "value" | "current" | "amount" | "body";
type MetricMetadataPatchKey = "status" | "trend" | "change" | "delta" | "target" | "source" | "as_of" | "asOf" | "date";
type BlockMetadataPatchKey = string;

export type DocxReviewSyncChange =
  | {
      action: "add_comment";
      id: string;
      target: string;
      nativeId: string;
      replyTo?: string;
    }
  | { action: "update_comment"; id: string; nativeId: string }
  | { action: "resolve_comment"; id: string; nativeId: string }
  | { action: "reopen_comment"; id: string; nativeId: string }
  | { action: "delete_comment"; id: string; target?: string; replyTo?: string }
  | { action: "add_footnote"; id: string; target: string; nativeId: string }
  | { action: "update_footnote"; id: string; nativeId: string }
  | { action: "delete_footnote"; id: string; target: string }
  | { action: "add_endnote"; id: string; target: string; nativeId: string }
  | { action: "update_endnote"; id: string; nativeId: string }
  | { action: "delete_endnote"; id: string; target: string }
  | { action: "update_table"; id: string; nativeId: string }
  | { action: "update_dataset"; id: string; nativeId: string }
  | { action: "add_change_request"; id: string; target: string; nativeId: string }
  | { action: "update_change_request"; id: string; nativeId: string }
  | { action: "delete_change_request"; id: string; target: string }
  | { action: "update_heading"; id: string; nativeId: string }
  | { action: "update_caption"; id: string; nativeId: string; key: ReviewTextFieldKey }
  | { action: "update_label"; id: string; nativeId: string; key: ReviewTextFieldKey }
  | { action: "update_block_title"; id: string; nativeId: string; key: ReviewTextFieldKey }
  | { action: "update_block_body"; id: string; nativeId: string }
  | { action: "update_metric_value"; id: string; nativeId: string; key: MetricValuePatchKey }
  | { action: "update_metric_metadata"; id: string; nativeId: string; key: MetricMetadataPatchKey }
  | { action: "delete_metric_metadata"; id: string; nativeId: string; key: MetricMetadataPatchKey }
  | { action: "update_block_metadata"; id: string; nativeId: string; key: BlockMetadataPatchKey }
  | { action: "delete_block_metadata"; id: string; nativeId: string; key: BlockMetadataPatchKey };

export interface DocxReviewSyncResult {
  source: string;
  changes: DocxReviewSyncChange[];
  skipped: DocxReviewComment[];
  skippedRevisions: DocxReviewRevision[];
  skippedFootnotes: DocxReviewNote[];
  skippedEndnotes: DocxReviewNote[];
  skippedTables: DocxReviewTable[];
  skippedHeadings: DocxReviewHeading[];
  skippedCaptions: DocxReviewCaption[];
  skippedLabels: DocxReviewBlockLabel[];
  skippedBlockBodies: DocxReviewBlockBody[];
  skippedMetricValues: DocxReviewMetricValue[];
  skippedMetricMetadata: DocxReviewMetricMetadata[];
  skippedBlockMetadata: DocxReviewBlockMetadata[];
}

interface SourceIndex {
  ids: Set<string>;
  bookmarkToId: Map<string, string>;
  referenceTargets: Map<string, string>;
  nodesById: Map<string, Node>;
  datasets: Map<string, DatasetTable>;
}

interface CommentAnchorMapping {
  targetId?: string;
  sourceId?: string;
  replyToSourceId?: string;
}

interface ReviewTextSourceField {
  key: ReviewTextFieldKey;
  location: "attr" | "body" | "body_text";
}

type GenericFallbackAttrValue = string | true;

interface GenericFallbackTitleParts {
  title?: string;
  attrs?: Map<string, GenericFallbackAttrValue>;
}

interface GenericFallbackAttrSuffix {
  text: string;
  attrs?: Map<string, GenericFallbackAttrValue>;
  hasSuffix: boolean;
}

interface MetricValueSourceField {
  key: MetricValuePatchKey;
  location: "attr" | "body";
}

export function syncReviewCommentsFromDocx(source: string, buffer: Buffer): DocxReviewSyncResult {
  return syncReviewCommentsFromData(source, extractDocxReviewData(buffer));
}

export function syncReviewCommentsFromData(source: string, data: DocxReviewData): DocxReviewSyncResult {
  const index = buildSourceIndex(source);
  const ops: PatchOp[] = [];
  const changes: DocxReviewSyncChange[] = [];
  const skipped: DocxReviewComment[] = [];
  const skippedRevisions: DocxReviewRevision[] = [];
  const skippedFootnotes: DocxReviewNote[] = [];
  const skippedEndnotes: DocxReviewNote[] = [];
  const skippedTables: DocxReviewTable[] = [];
  const skippedHeadings: DocxReviewHeading[] = [];
  const skippedCaptions: DocxReviewCaption[] = [];
  const skippedLabels: DocxReviewBlockLabel[] = [];
  const skippedBlockBodies: DocxReviewBlockBody[] = [];
  const skippedMetricValues: DocxReviewMetricValue[] = [];
  const skippedMetricMetadata: DocxReviewMetricMetadata[] = [];
  const skippedBlockMetadata: DocxReviewBlockMetadata[] = [];
  const usedIds = new Set(index.ids);
  const nativeCommentSourceIds = new Map<string, string>();
  const commentAnchors = new Map<string, CommentAnchorMapping>();
  const matchedSourceCommentIds = new Set<string>();
  const reviewedCommentTargets = new Set<string>();
  const reviewedReplyParents = new Set<string>();
  const ambiguousCommentTargets = new Set<string>();
  const ambiguousReplyParents = new Set<string>();
  const footnoteState = createNoteSyncState();
  const endnoteState = createNoteSyncState();
  const changeRequestState = createChangeRequestSyncState();

  syncHeadings(data.headings ?? [], index, ops, changes, skippedHeadings);
  syncCaptions(data.captions ?? [], index, ops, changes, skippedCaptions);
  syncBlockLabels(data.labels ?? [], index, ops, changes, skippedLabels);
  syncBlockBodies(data.blockBodies ?? [], index, ops, changes, skippedBlockBodies);
  syncMetricValues(data.metricValues ?? [], index, ops, changes, skippedMetricValues);
  syncMetricMetadata(data.metricMetadata ?? [], index, ops, changes, skippedMetricMetadata);
  syncBlockMetadata(data.blockMetadata ?? [], index, ops, changes, skippedBlockMetadata);

  for (const comment of data.comments) {
    const mapped = mapCommentAnchors(comment, index);
    commentAnchors.set(comment.nativeId, mapped);
    if (mapped.sourceId) nativeCommentSourceIds.set(comment.nativeId, mapped.sourceId);
  }

  for (const comment of data.comments) {
    if (comment.body.startsWith("Change request: ")) continue;
    const mapped = commentAnchors.get(comment.nativeId) ?? {};
    if (mapped.sourceId) {
      matchedSourceCommentIds.add(mapped.sourceId);
      if (mapped.replyToSourceId) reviewedReplyParents.add(mapped.replyToSourceId);
      else if (mapped.targetId) reviewedCommentTargets.add(mapped.targetId);
      updateMatchedComment(mapped.sourceId, comment, index, ops, changes, skipped);
      continue;
    }
    const replyToSourceId = comment.replyTo ? nativeCommentSourceIds.get(comment.replyTo) : mapped.replyToSourceId;
    if (comment.replyTo || replyToSourceId) {
      if (!replyToSourceId || !comment.body.trim()) {
        skipped.push(comment);
        continue;
      }
      reviewedReplyParents.add(replyToSourceId);
      const existingReply = findExistingReplyComment(index, replyToSourceId, comment, matchedSourceCommentIds);
      if (existingReply.id) {
        matchedSourceCommentIds.add(existingReply.id);
        nativeCommentSourceIds.set(comment.nativeId, existingReply.id);
        updateMatchedComment(existingReply.id, comment, index, ops, changes, skipped);
        continue;
      }
      if (existingReply.ambiguous) {
        ambiguousReplyParents.add(replyToSourceId);
        skipped.push(comment);
        continue;
      }
      if (comment.hasRevisions) {
        ambiguousReplyParents.add(replyToSourceId);
        skipped.push(comment);
        continue;
      }
      const id = uniqueCommentId(`comment-${replyToSourceId}-${comment.nativeId}`, usedIds);
      ops.push({
        op: "add_comment",
        id,
        target: replyToSourceId,
        reply_to: replyToSourceId,
        content: comment.body,
        ...(comment.author ? { author: comment.author } : {}),
        ...(comment.initials ? { initials: comment.initials } : {}),
        ...(comment.date ? { date: comment.date } : {}),
      });
      changes.push({
        action: "add_comment",
        id,
        target: replyToSourceId,
        nativeId: comment.nativeId,
        replyTo: replyToSourceId,
      });
      nativeCommentSourceIds.set(comment.nativeId, id);
      if (comment.status === "resolved") {
        ops.push({
          op: "resolve_comment",
          id,
          ...(comment.resolvedBy ? { resolved_by: comment.resolvedBy } : {}),
          ...(comment.resolvedAt ? { resolved_at: comment.resolvedAt } : {}),
        });
        changes.push({ action: "resolve_comment", id, nativeId: comment.nativeId });
      }
      continue;
    }
    if (!mapped.targetId || !comment.body.trim()) {
      skipped.push(comment);
      continue;
    }
    reviewedCommentTargets.add(mapped.targetId);
    const existingTargetComment = findExistingTargetComment(index, mapped.targetId, comment, matchedSourceCommentIds);
    if (existingTargetComment.id) {
      matchedSourceCommentIds.add(existingTargetComment.id);
      nativeCommentSourceIds.set(comment.nativeId, existingTargetComment.id);
      updateMatchedComment(existingTargetComment.id, comment, index, ops, changes, skipped);
      continue;
    }
    if (existingTargetComment.ambiguous) {
      ambiguousCommentTargets.add(mapped.targetId);
      skipped.push(comment);
      continue;
    }
    if (comment.hasRevisions) {
      ambiguousCommentTargets.add(mapped.targetId);
      skipped.push(comment);
      continue;
    }
    const id = uniqueCommentId(`comment-${mapped.targetId}-${comment.nativeId}`, usedIds);
    ops.push({
      op: "add_comment",
      id,
      target: mapped.targetId,
      content: comment.body,
      ...(comment.author ? { author: comment.author } : {}),
      ...(comment.initials ? { initials: comment.initials } : {}),
      ...(comment.date ? { date: comment.date } : {}),
    });
    changes.push({ action: "add_comment", id, target: mapped.targetId, nativeId: comment.nativeId });
    nativeCommentSourceIds.set(comment.nativeId, id);
    if (comment.status === "resolved") {
      ops.push({
        op: "resolve_comment",
        id,
        ...(comment.resolvedBy ? { resolved_by: comment.resolvedBy } : {}),
        ...(comment.resolvedAt ? { resolved_at: comment.resolvedAt } : {}),
      });
      changes.push({ action: "resolve_comment", id, nativeId: comment.nativeId });
    }
  }

  syncDeletedComments(
    index,
    matchedSourceCommentIds,
    reviewedCommentTargets,
    reviewedReplyParents,
    ambiguousCommentTargets,
    ambiguousReplyParents,
    ops,
    changes,
  );

  syncChangeRequests(data.revisions, index, ops, changes, skippedRevisions, usedIds, changeRequestState);
  syncDeletedChangeRequests(index, changeRequestState, ops, changes);

  syncNotes("footnote", data.footnotes, index, ops, changes, skippedFootnotes, usedIds, footnoteState);
  syncNotes("endnote", data.endnotes, index, ops, changes, skippedEndnotes, usedIds, endnoteState);
  syncDeletedNotes("footnote", index, footnoteState, ops, changes);
  syncDeletedNotes("endnote", index, endnoteState, ops, changes);

  for (const table of data.tables) {
    syncTable(table, index, ops, changes, skippedTables);
  }

  return {
    source: ops.length > 0 ? patchSource(source, ops) : source,
    changes,
    skipped,
    skippedRevisions,
    skippedFootnotes,
    skippedEndnotes,
    skippedTables,
    skippedHeadings,
    skippedCaptions,
    skippedLabels,
    skippedBlockBodies,
    skippedMetricValues,
    skippedMetricMetadata,
    skippedBlockMetadata,
  };
}

function updateMatchedComment(
  id: string,
  comment: DocxReviewComment,
  index: SourceIndex,
  ops: PatchOp[],
  changes: DocxReviewSyncChange[],
  skipped?: DocxReviewComment[],
): void {
  const node = index.nodesById.get(id);
  if (comment.hasRevisions) {
    skipped?.push(comment);
  } else if (
    isCommentDirective(node) &&
    comment.body.trim() &&
    !commentBodyIsGeneratedFallback(node, comment.body) &&
    !sourceReviewBodyMatches(node, comment.body, index)
  ) {
    ops.push({ op: "replace_body", id, content: comment.body });
    changes.push({ action: "update_comment", id, nativeId: comment.nativeId });
  }
  if (comment.status === "resolved" && sourceCommentResolutionNeedsUpdate(node, comment)) {
    ops.push({
      op: "resolve_comment",
      id,
      ...(comment.resolvedBy ? { resolved_by: comment.resolvedBy } : {}),
      ...(comment.resolvedAt ? { resolved_at: comment.resolvedAt } : {}),
    });
    changes.push({ action: "resolve_comment", id, nativeId: comment.nativeId });
  }
  if (comment.status !== "resolved" && sourceCommentResolved(node)) {
    for (const key of sourceCommentResolutionAttrKeys(node)) {
      ops.push({ op: "remove_attribute", id, key });
    }
    changes.push({ action: "reopen_comment", id, nativeId: comment.nativeId });
  }
}

function buildSourceIndex(source: string): SourceIndex {
  const doc = parse(source);
  const ids = new Set<string>();
  const nodesById = new Map<string, Node>();
  const bookmarkToId = new Map<string, string>();
  const referenceTargets = new Map<string, string>();
  const usedBookmarks = new Set<string>();
  for (const node of walk(doc)) {
    if (!node.id) continue;
    ids.add(node.id);
    nodesById.set(node.id, node);
    referenceTargets.set(node.id, node.id);
    for (const alias of node.aliases ?? []) referenceTargets.set(alias, node.id);
    const name = uniqueBookmarkName(node.id, usedBookmarks);
    bookmarkToId.set(name, node.id);
  }
  return { ids, bookmarkToId, referenceTargets, nodesById, datasets: buildDatasetRegistry(doc) };
}

function mapCommentAnchors(comment: DocxReviewComment, index: SourceIndex): CommentAnchorMapping {
  let targetId: string | undefined;
  let replyToSourceId: string | undefined;
  const sourceCandidates = new Set<string>();
  for (const bookmark of comment.anchorBookmarkNames ?? []) {
    const id = index.bookmarkToId.get(bookmark);
    if (!id) continue;
    const node = index.nodesById.get(id);
    if (isCommentDirective(node)) {
      const replyTo = commentReplyTarget(node);
      if (replyTo) replyToSourceId ??= replyTo;
      else targetId ??= commentTarget(node);
      if (!commentSuppressed(node)) sourceCandidates.add(id);
    } else {
      targetId ??= id;
    }
  }
  const sourceId = sourceCandidates.size === 1 ? [...sourceCandidates][0] : undefined;
  return { targetId, sourceId, replyToSourceId };
}

function canonicalReference(index: SourceIndex | undefined, id: string | undefined): string | undefined {
  if (!id) return undefined;
  return index?.referenceTargets.get(id) ?? id;
}

function referencesEqual(index: SourceIndex, left: string | undefined, right: string | undefined): boolean {
  const canonicalLeft = canonicalReference(index, left);
  const canonicalRight = canonicalReference(index, right);
  return Boolean(canonicalLeft && canonicalRight && canonicalLeft === canonicalRight);
}

function syncHeadings(
  headings: DocxReviewHeading[],
  index: SourceIndex,
  ops: PatchOp[],
  changes: DocxReviewSyncChange[],
  skipped: DocxReviewHeading[],
): void {
  for (const heading of headings) {
    const id = mapHeadingAnchor(heading, index);
    const node = id ? index.nodesById.get(id) : undefined;
    if (heading.hasRevisions || !id || !node || node.type !== "section" || !heading.title.trim()) {
      skipped.push(heading);
      continue;
    }
    if (sourceReviewTextMatches(node.title, heading.title, index)) continue;
    ops.push({ op: "update_heading", id, title: heading.title });
    changes.push({ action: "update_heading", id, nativeId: heading.nativeId });
  }
}

function mapHeadingAnchor(heading: DocxReviewHeading, index: SourceIndex): string | undefined {
  for (const bookmark of heading.anchorBookmarkNames ?? []) {
    const id = index.bookmarkToId.get(bookmark);
    const node = id ? index.nodesById.get(id) : undefined;
    if (id && node?.type === "section") return id;
  }
  return undefined;
}

function syncCaptions(
  captions: DocxReviewCaption[],
  index: SourceIndex,
  ops: PatchOp[],
  changes: DocxReviewSyncChange[],
  skipped: DocxReviewCaption[],
): void {
  for (const caption of captions) {
    const id = mapCaptionAnchor(caption, index);
    const node = id ? index.nodesById.get(id) : undefined;
    const field = captionSourceField(caption, node);
    if (caption.hasRevisions || !id || !field || !caption.title.trim()) {
      skipped.push(caption);
      continue;
    }
    const current = captionSourceValue(node as DirectiveNode, field);
    if (sourceReviewTextMatches(current, caption.title, index)) continue;
    ops.push(captionPatchOp(node as DirectiveNode, field, caption.title));
    changes.push({ action: "update_caption", id, nativeId: caption.nativeId, key: field.key });
  }
}

function mapCaptionAnchor(caption: DocxReviewCaption, index: SourceIndex): string | undefined {
  for (const bookmark of caption.anchorBookmarkNames ?? []) {
    const id = index.bookmarkToId.get(bookmark);
    const node = id ? index.nodesById.get(id) : undefined;
    if (captionSourceField(caption, node)) return id;
  }
  return undefined;
}

function captionSourceField(caption: DocxReviewCaption, node: Node | undefined): ReviewTextSourceField | undefined {
  if (!node || !isDirective(node)) return undefined;
  if (caption.kind === "figure" && node.name === "figure") return { key: "caption", location: "attr" };
  if (caption.kind === "table" && node.name === "table") {
    return {
      key: node.attrs.caption !== undefined && node.attrs.title === undefined ? "caption" : "title",
      location: "attr",
    };
  }
  if (caption.kind === "plot" && node.name === "plot") return { key: "title", location: "attr" };
  if (caption.kind === "plot" && node.name === "computed_plot") return computedPlotCaptionSourceField(node);
  return undefined;
}

function computedPlotCaptionSourceField(node: DirectiveNode): ReviewTextSourceField | undefined {
  for (const key of ["label", "title", "name"] as const) {
    if (node.attrs[key] !== undefined) return { key, location: "attr" };
  }
  for (const key of ["label", "title"] as const) {
    if (directiveBodyFieldText(node, key) !== undefined) return { key, location: "body" };
  }
  return { key: "title", location: "attr" };
}

function captionSourceValue(node: DirectiveNode, field: ReviewTextSourceField): string {
  if (field.location === "body") return directiveBodyFieldText(node, field.key) ?? "";
  const value = attrValueText(node, field.key);
  if (value !== undefined) return value;
  if (node.name === "computed_plot" && field.key === "title") return node.id ?? "Computed plot";
  if (node.name === "figure" && field.key === "caption") return "Figure";
  if (node.name === "plot" && field.key === "title") return "Plot";
  return "";
}

function captionPatchOp(node: DirectiveNode, field: ReviewTextSourceField, value: string): PatchOp {
  if (field.location === "body") {
    return {
      op: "replace_body",
      id: node.id!,
      content: replaceDirectiveBodyField(directiveBody(node), field.key, value),
    };
  }
  return { op: "update_attribute", id: node.id!, key: field.key, value };
}

function syncBlockLabels(
  labels: DocxReviewBlockLabel[],
  index: SourceIndex,
  ops: PatchOp[],
  changes: DocxReviewSyncChange[],
  skipped: DocxReviewBlockLabel[],
): void {
  for (const label of labels) {
    const id = mapBlockLabelAnchor(label, index);
    const node = id ? index.nodesById.get(id) : undefined;
    const field = blockLabelSourceField(label, node);
    if (label.kind === "block_title" && (!id || !field)) continue;
    if (label.hasRevisions || !id || !field || !label.title.trim()) {
      skipped.push(label);
      continue;
    }
    const directive = node as DirectiveNode;
    const reviewed = blockLabelReviewedValue(label, directive, field);
    if (!reviewed?.trim()) {
      skipped.push(label);
      continue;
    }
    const current = label.kind === "block_title"
      ? blockTitleSourceValue(directive, field)
      : blockLabelSourceValue(directive, field);
    if (
      label.kind === "block_title" &&
      isCustomFallbackDirective(directive) &&
      syncCustomFallbackBlockTitle(label, directive, field, index, ops, changes, skipped)
    ) {
      continue;
    }
    if (sourceReviewTextMatches(current, reviewed, index)) continue;
    ops.push(blockLabelPatchOp(directive, field, reviewed));
    if (label.kind === "block_title") changes.push({ action: "update_block_title", id, nativeId: label.nativeId, key: field.key });
    else changes.push({ action: "update_label", id, nativeId: label.nativeId, key: field.key });
  }
}

function mapBlockLabelAnchor(label: DocxReviewBlockLabel, index: SourceIndex): string | undefined {
  for (const bookmark of label.anchorBookmarkNames ?? []) {
    const id = index.bookmarkToId.get(bookmark);
    const node = id ? index.nodesById.get(id) : undefined;
    if (blockLabelSourceField(label, node)) return id;
  }
  return undefined;
}

function blockLabelSourceField(label: DocxReviewBlockLabel, node: Node | undefined): ReviewTextSourceField | undefined {
  if (!node || !isDirective(node)) return undefined;
  if (label.kind === "metric" && node.name === "metric") return metricLabelSourceField(node);
  if (label.kind === "computed_metric" && node.name === "computed_metric") return computedMetricLabelSourceField(node);
  if (label.kind === "control" && node.name === "control") return controlLabelSourceField(node);
  if (label.kind === "button" && node.name === "button") return actionLabelSourceField(node);
  if (label.kind === "export_button" && node.name === "export_button") return actionLabelSourceField(node);
  if (label.kind === "block_title") return blockTitleSourceField(node);
  return undefined;
}

function metricLabelSourceField(node: DirectiveNode): ReviewTextSourceField {
  for (const key of ["label", "title", "name"] as const) {
    if (node.attrs[key] !== undefined) return { key, location: "attr" };
  }
  return { key: "label", location: "attr" };
}

function computedMetricLabelSourceField(node: DirectiveNode): ReviewTextSourceField {
  for (const key of ["label", "title", "name"] as const) {
    if (node.attrs[key] !== undefined) return { key, location: "attr" };
  }
  for (const key of ["label", "title"] as const) {
    if (directiveBodyFieldText(node, key) !== undefined) return { key, location: "body" };
  }
  return { key: "label", location: "attr" };
}

function controlLabelSourceField(node: DirectiveNode): ReviewTextSourceField {
  for (const key of ["Label", "label"] as const) {
    if (node.attrs[key] !== undefined) return { key, location: "attr" };
  }
  return { key: "label", location: "attr" };
}

function actionLabelSourceField(node: DirectiveNode): ReviewTextSourceField {
  for (const key of ["Label", "label"] as const) {
    if (node.attrs[key] !== undefined) return { key, location: "attr" };
  }
  if (directiveBodyFieldText(node, "label") !== undefined) return { key: "label", location: "body" };
  if (directiveBody(node).trim()) return { key: "label", location: "body_text" };
  return { key: "label", location: "attr" };
}

function blockTitleSourceField(node: DirectiveNode): ReviewTextSourceField | undefined {
  if (node.attrs.title !== undefined) return { key: "title", location: "attr" };
  if (node.attrs.caption !== undefined && blockTitleUsesCaption(node)) return { key: "caption", location: "attr" };
  if (node.attrs.name !== undefined && blockTitleUsesName(node)) return { key: "name", location: "attr" };
  if (blockTitleCanAddTitle(node)) return { key: "title", location: "attr" };
  return undefined;
}

function blockTitleUsesCaption(node: DirectiveNode): boolean {
  return ![
    "table",
    "figure",
    "plot",
    "computed_plot",
  ].includes(node.name);
}

function blockTitleUsesName(node: DirectiveNode): boolean {
  return [
    "api",
    "parameter",
    "example",
    "instruction",
    "query",
  ].includes(node.name);
}

function blockTitleCanAddTitle(node: DirectiveNode): boolean {
  switch (node.name) {
    case "card":
    case "sidebar":
    case "tab":
    case "callout":
    case "memory":
    case "dataset":
    case "bibliography":
    case "api":
    case "example":
    case "instruction":
    case "query":
      return true;
    case "endpoint":
      return attrValueText(node, "method") === undefined &&
        attrValueText(node, "path") === undefined &&
        attrValueText(node, "url") === undefined;
    case "changelog":
      return attrValueText(node, "version") === undefined;
    default:
      return isCustomFallbackDirective(node);
  }
}

function blockLabelReviewedValue(
  label: DocxReviewBlockLabel,
  node: DirectiveNode,
  field: ReviewTextSourceField,
): string | undefined {
  if (label.kind !== "block_title") return label.title;
  return blockTitleReviewedValue(label.title, node, field);
}

function blockTitleReviewedValue(
  reviewedTitle: string,
  node: DirectiveNode,
  field: ReviewTextSourceField,
): string | undefined {
  const text = stripGenericAttrSummary(reviewedTitle.trim(), node);
  switch (node.name) {
    case "card":
    case "tab":
    case "bibliography":
      return text;
    case "sidebar":
      return stripTitlePrefix(text, "Sidebar") ?? text;
    case "callout":
      if (isKnownTitleLabel(text, CALLOUT_TITLE_LABELS)) return blockTitleSourceValue(node, field);
      return stripKnownTitlePrefix(text, CALLOUT_TITLE_LABELS) ??
        stripTitlePrefix(text, calloutToneLabel(attrValueText(node, "tone"))) ??
        text;
    case "memory":
      if (isKnownTitleLabel(text, MEMORY_TITLE_LABELS)) return blockTitleSourceValue(node, field);
      return stripKnownTitlePrefix(text, MEMORY_TITLE_LABELS) ??
        stripTitlePrefix(text, memoryTypeLabel(attrValueText(node, "type"))) ??
        text;
    case "dataset":
      return stripTitlePrefix(text, "Dataset") ?? text;
    case "code":
      return stripTitlePrefix(text, codeDirectiveBaseTitle(node)) ?? text;
    case "api":
      return stripTitlePrefix(text, "API") ?? text;
    case "endpoint":
      return stripTitlePrefix(text, "Endpoint") ?? text;
    case "parameter":
      return stripTitlePrefix(text, "Parameter") ?? text;
    case "example":
      return stripTitlePrefix(text, "Example") ?? text;
    case "changelog":
      return stripTitlePrefix(text, "Changelog") ?? text;
    case "instruction":
      return stripTitlePrefix(text, "Instruction") ?? text;
    case "query":
      return stripTitlePrefix(text, "Query") ?? text;
    default: {
      const prefix = readableDirectiveName(node.name);
      if (field.key === "title" || field.key === "caption") return stripTitlePrefix(text, prefix) ?? text;
      return text;
    }
  }
}

function blockTitleSourceValue(node: DirectiveNode, field: ReviewTextSourceField): string {
  const value = attrValueText(node, field.key);
  if (value !== undefined) return value;
  switch (node.name) {
    case "card":
      return "Card";
    case "sidebar":
      return "Sidebar";
    case "tab":
      return "Tab panel";
    case "callout":
      return calloutToneLabel(attrValueText(node, "tone"));
    case "memory":
      return node.id ?? memoryTypeLabel(attrValueText(node, "type"));
    case "dataset":
      return node.id ?? "Dataset";
    case "bibliography":
      return "Bibliography";
    case "api":
      return "API";
    case "endpoint":
      return "Endpoint";
    case "example":
      return "Example";
    case "changelog":
      return "Changelog";
    case "instruction":
      return "Instruction";
    case "query":
      return "Query";
    case "footnote":
      return "Footnote";
    case "endnote":
      return "Endnote";
    default:
      if ((field.key === "title" || field.key === "caption") && isCustomFallbackDirective(node)) {
        return readableDirectiveName(node.name);
      }
      return "";
  }
}

function syncCustomFallbackBlockTitle(
  label: DocxReviewBlockLabel,
  node: DirectiveNode,
  field: ReviewTextSourceField,
  index: SourceIndex,
  ops: PatchOp[],
  changes: DocxReviewSyncChange[],
  skipped: DocxReviewBlockLabel[],
): boolean {
  const parts = parseGenericFallbackTitle(label.title, node);
  if (!parts) return false;
  if (parts.attrs) syncGenericFallbackTitleAttrs(label, node, parts.attrs, index, ops, changes);
  const reviewedTitle = parts.title ?? readableDirectiveName(node.name);
  if (!reviewedTitle.trim()) {
    skipped.push(label);
    return true;
  }
  if (!sourceReviewTextMatches(blockTitleSourceValue(node, field), reviewedTitle, index)) {
    ops.push(blockLabelPatchOp(node, field, reviewedTitle));
    changes.push({ action: "update_block_title", id: node.id!, nativeId: label.nativeId, key: field.key });
  }
  return true;
}

function parseGenericFallbackTitle(text: string, node: DirectiveNode): GenericFallbackTitleParts | undefined {
  const base = readableDirectiveName(node.name);
  const sourceHasAttrs = genericFallbackAttrKeys(node).length > 0;
  const trimmed = text.trim();
  if (sameReviewLabel(trimmed, base)) return { attrs: sourceHasAttrs ? new Map() : undefined };
  const prefixed = stripTitlePrefix(trimmed, base);
  if (prefixed !== undefined) {
    const split = splitGenericFallbackAttrSuffix(prefixed, node);
    if (split.hasSuffix && !split.attrs) return undefined;
    return { title: split.text, attrs: split.attrs ?? (sourceHasAttrs ? new Map() : undefined) };
  }
  const split = splitGenericFallbackAttrSuffix(trimmed, node);
  if (split.attrs && sameReviewLabel(split.text, base)) return { attrs: split.attrs };
  return undefined;
}

function splitGenericFallbackAttrSuffix(
  text: string,
  node: DirectiveNode,
): GenericFallbackAttrSuffix {
  const trimmed = text.trim();
  if (!trimmed.endsWith(")")) return { text: trimmed, hasSuffix: false };
  const open = trimmed.lastIndexOf(" (");
  if (open < 0) return { text: trimmed, hasSuffix: false };
  const summary = trimmed.slice(open + 2, -1).trim();
  const attrs = parseGenericFallbackAttrSummary(summary, node);
  if (!attrs) return { text: trimmed, hasSuffix: true };
  return { text: trimmed.slice(0, open).trimEnd(), attrs, hasSuffix: true };
}

function parseGenericFallbackAttrSummary(
  summary: string,
  node: DirectiveNode,
): Map<string, GenericFallbackAttrValue> | undefined {
  if (!summary) return undefined;
  const attrs = new Map<string, GenericFallbackAttrValue>();
  for (const rawPart of splitGenericFallbackAttrSummary(summary, node)) {
    const part = rawPart.trim();
    if (!part) return undefined;
    const equals = part.indexOf("=");
    const hasValue = equals >= 0;
    const label = (hasValue ? part.slice(0, equals) : part).trim();
    const key = genericFallbackAttrKey(label, node, hasValue);
    if (!key || attrs.has(key)) return undefined;
    attrs.set(key, hasValue ? part.slice(equals + 1).trim() : true);
  }
  return attrs;
}

function splitGenericFallbackAttrSummary(summary: string, node: DirectiveNode): string[] {
  const parts: string[] = [];
  let start = 0;
  for (let index = 0; index < summary.length; index += 1) {
    if (summary[index] !== ",") continue;
    const next = skipSpaces(summary, index + 1);
    if (!genericFallbackAttrSummaryStartsAt(summary, next, node)) continue;
    parts.push(summary.slice(start, index));
    start = next;
    index = next;
  }
  parts.push(summary.slice(start));
  return parts;
}

function genericFallbackAttrSummaryStartsAt(summary: string, index: number, node: DirectiveNode): boolean {
  const tail = summary.slice(index);
  for (const key of genericFallbackAttrKeys(node)) {
    const label = readableAttributeName(key);
    if (new RegExp(`^${labelPattern(label)}\\s*(?:=|(?=,|$))`, "i").test(tail)) return true;
  }
  return /^[a-zA-Z_][\w -]*\s*=/.test(tail);
}

function skipSpaces(value: string, index: number): number {
  let cursor = index;
  while (cursor < value.length && /\s/.test(value[cursor] ?? "")) cursor += 1;
  return cursor;
}

function labelPattern(label: string): string {
  return label.trim().split(/\s+/).map(escapeRegExp).join("\\s+");
}

function syncGenericFallbackTitleAttrs(
  label: DocxReviewBlockLabel,
  node: DirectiveNode,
  reviewedAttrs: Map<string, GenericFallbackAttrValue>,
  index: SourceIndex,
  ops: PatchOp[],
  changes: DocxReviewSyncChange[],
): void {
  for (const [key, value] of reviewedAttrs) {
    if (genericFallbackAttrValueMatches(node.attrs[key], value, index)) continue;
    ops.push({ op: "update_attribute", id: node.id!, key, value });
    changes.push({ action: "update_block_metadata", id: node.id!, nativeId: label.nativeId, key });
  }
  for (const key of genericFallbackAttrKeys(node)) {
    if (reviewedAttrs.has(key)) continue;
    ops.push({ op: "remove_attribute", id: node.id!, key });
    changes.push({ action: "delete_block_metadata", id: node.id!, nativeId: label.nativeId, key });
  }
}

function genericFallbackAttrValueMatches(
  source: AttrValue | undefined,
  reviewed: GenericFallbackAttrValue,
  index: SourceIndex,
): boolean {
  if (source === undefined) return false;
  if (reviewed === true) return source === true;
  return sourceReviewTextMatches(String(source), reviewed, index);
}

function genericFallbackAttrKey(label: string, node: DirectiveNode, allowNew: boolean): string | undefined {
  const normalized = normalizeReviewLabel(label);
  const existing = genericFallbackAttrKeys(node).find((key) => normalizeReviewLabel(readableAttributeName(key)) === normalized);
  if (existing) return existing;
  if (!allowNew) return undefined;
  const key = label.trim().replace(/[\s-]+/g, "_");
  if (!/^[a-zA-Z_][\w-]*$/.test(key) || RESERVED_GENERIC_FALLBACK_ATTRS.has(key)) return undefined;
  return key;
}

function genericFallbackAttrKeys(node: DirectiveNode): string[] {
  return Object.keys(node.attrs).filter((key) => !RESERVED_GENERIC_FALLBACK_ATTRS.has(key));
}

function sameReviewLabel(left: string, right: string): boolean {
  return normalizeReviewLabel(left) === normalizeReviewLabel(right);
}

function normalizeReviewLabel(value: string): string {
  return value.trim().replace(/\s+/g, " ").toLowerCase();
}

const RESERVED_GENERIC_FALLBACK_ATTRS = new Set(["id", "title", "caption", "variant"]);

function stripTitlePrefix(text: string, prefix: string): string | undefined {
  const match = new RegExp(`^${escapeRegExp(prefix)}\\s*:\\s*([\\s\\S]+)$`, "i").exec(text.trim());
  const value = match?.[1]?.trim();
  return value || undefined;
}

function stripKnownTitlePrefix(text: string, labels: readonly string[]): string | undefined {
  for (const label of labels) {
    const value = stripTitlePrefix(text, label);
    if (value !== undefined) return value;
  }
  return undefined;
}

function isKnownTitleLabel(text: string, labels: readonly string[]): boolean {
  return labels.some((label) => text.localeCompare(label, undefined, { sensitivity: "accent" }) === 0);
}

function stripGenericAttrSummary(text: string, node: DirectiveNode): string {
  const summary = genericTitleAttrSummary(node);
  if (!summary) return text;
  const suffix = ` (${summary})`;
  return text.endsWith(suffix) ? text.slice(0, -suffix.length).trimEnd() : text;
}

function genericTitleAttrSummary(node: DirectiveNode): string {
  return Object.entries(node.attrs)
    .filter(([key]) => key !== "id" && key !== "title" && key !== "caption" && key !== "variant")
    .map(([key, value]) => value === true ? readableAttributeName(key) : `${readableAttributeName(key)}=${String(value)}`)
    .join(", ");
}

function syncBlockBodies(
  bodies: DocxReviewBlockBody[],
  index: SourceIndex,
  ops: PatchOp[],
  changes: DocxReviewSyncChange[],
  skipped: DocxReviewBlockBody[],
): void {
  for (const body of bodies) {
    const id = mapBlockBodyAnchor(body, index);
    if (!id) continue;
    const node = index.nodesById.get(id);
    if (!node || !isDirective(node) || !blockBodyCanSync(node)) continue;
    if (body.hasRevisions || !body.body.trim()) {
      skipped.push(body);
      continue;
    }
    if (sourceReviewTextMatches(renderedDirectiveBodyText(node, blockBodyMode(body, node)), body.body, index)) continue;
    ops.push({ op: "replace_body", id, content: body.body });
    changes.push({ action: "update_block_body", id, nativeId: body.nativeId });
  }
}

function mapBlockBodyAnchor(body: DocxReviewBlockBody, index: SourceIndex): string | undefined {
  for (const bookmark of body.anchorBookmarkNames ?? []) {
    const id = index.bookmarkToId.get(bookmark);
    const node = id ? index.nodesById.get(id) : undefined;
    if (node && isDirective(node) && blockBodyCanSync(node)) return id;
  }
  return undefined;
}

function blockBodyCanSync(node: DirectiveNode): boolean {
  if (!node.id || (!PROSE_BODY_SYNC_DIRECTIVES.has(node.name) && !isCodeBodySyncDirective(node) && !isFallbackBodySyncDirective(node))) return false;
  return node.children.length === 0 ||
    (node.children.length === 1 && node.children[0]?.type === "paragraph" && node.body !== undefined);
}

const PROSE_BODY_SYNC_DIRECTIVES = new Set([
  "abstract",
  "agent_task",
  "adr",
  "api",
  "assumption",
  "callout",
  "card",
  "changelog",
  "claim",
  "confidence",
  "counterevidence",
  "decision",
  "endpoint",
  "evidence",
  "example",
  "hypothesis",
  "instruction",
  "limitation",
  "memory",
  "note",
  "open_question",
  "parameter",
  "provenance",
  "query",
  "result",
  "review",
  "risk",
  "sidebar",
  "summary",
  "tab",
  "tip",
  "todo",
  "warning",
]);

const CODE_BODY_SYNC_DIRECTIVES = new Set([
  "code",
  "code_cell",
  "output",
]);

const LANGUAGE_CODE_BODY_SYNC_DIRECTIVES = new Set([
  "example",
  "query",
]);

function blockBodyMode(body: DocxReviewBlockBody, node: DirectiveNode): "prose" | "code" {
  if (body.mode === "code" || isCodeBodySyncDirective(node)) return "code";
  return "prose";
}

function isCodeBodySyncDirective(node: DirectiveNode): boolean {
  if (CODE_BODY_SYNC_DIRECTIVES.has(node.name)) return true;
  return LANGUAGE_CODE_BODY_SYNC_DIRECTIVES.has(node.name) &&
    Boolean(stringAttr(node, "lang") ?? stringAttr(node, "language") ?? stringAttr(node, "format"));
}

function isFallbackBodySyncDirective(node: DirectiveNode): boolean {
  return !SPECIAL_BODY_SYNC_EXCLUDED_DIRECTIVES.has(node.name);
}

function isCustomFallbackDirective(node: DirectiveNode): boolean {
  return node.name.includes("::") || !KNOWN_DIRECTIVES.has(node.name);
}

const SPECIAL_BODY_SYNC_EXCLUDED_DIRECTIVES = new Set([
  "accordion",
  "bibliography",
  "button",
  "change_request",
  "code",
  "code_cell",
  "columns",
  "comment",
  "computed_metric",
  "computed_plot",
  "control",
  "citation",
  "dataset",
  "diagram",
  "doc_protection",
  "endnote",
  "export_button",
  "figure",
  "footer",
  "footnote",
  "grid",
  "header",
  "hero",
  "html",
  "math",
  "metric",
  "output",
  "page_setup",
  "pagebreak",
  "plot",
  "plotly",
  "script",
  "state_change",
  "svg",
  "table",
  "tabs",
  "toc",
]);

const KNOWN_DIRECTIVES = new Set([
  ...PROSE_BODY_SYNC_DIRECTIVES,
  ...CODE_BODY_SYNC_DIRECTIVES,
  ...LANGUAGE_CODE_BODY_SYNC_DIRECTIVES,
  ...SPECIAL_BODY_SYNC_EXCLUDED_DIRECTIVES,
  "memory_index",
]);

function renderedDirectiveBodyText(node: DirectiveNode, mode: "prose" | "code"): string {
  if (mode === "code") return directiveBody(node);
  return directiveBody(node)
    .trim()
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.replace(/\n/g, " ").trim())
    .filter(Boolean)
    .join("\n\n");
}

function codeDirectiveBaseTitle(node: DirectiveNode): string {
  const language = attrValueText(node, "lang") ?? attrValueText(node, "language");
  return language ? `Code (${language})` : "Code";
}

function calloutToneLabel(tone: string | undefined): string {
  switch (tone?.toLowerCase()) {
    case "warning":
      return "Warning";
    case "danger":
      return "Danger";
    case "tip":
    case "success":
      return "Tip";
    case "info":
    case "note":
      return "Note";
    default:
      return "Callout";
  }
}

const CALLOUT_TITLE_LABELS = ["Warning", "Danger", "Tip", "Note", "Callout"] as const;

function memoryTypeLabel(type: string | undefined): string {
  switch (type?.toLowerCase()) {
    case "user":
      return "User memory";
    case "feedback":
      return "Feedback memory";
    case "project":
      return "Project memory";
    case "reference":
      return "Reference memory";
    default:
      return "Memory";
  }
}

const MEMORY_TITLE_LABELS = ["User memory", "Feedback memory", "Project memory", "Reference memory", "Memory"] as const;

function readableDirectiveName(name: string): string {
  const words = splitIdentifierWords(name);
  if (words.length === 0) return "Directive";
  return words.map((word, index) => index === 0 ? titleWord(word) : word.toLowerCase()).join(" ");
}

function readableAttributeName(name: string): string {
  return splitIdentifierWords(name).join(" ") || name;
}

function splitIdentifierWords(value: string): string[] {
  const spaced = value
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/::|[:_-]+/g, " ");
  return spaced.split(/\s+/).map((word) => word.trim()).filter(Boolean);
}

function titleWord(word: string): string {
  return word ? word.charAt(0).toUpperCase() + word.slice(1).toLowerCase() : word;
}

function blockLabelSourceValue(node: DirectiveNode, field: ReviewTextSourceField): string {
  if (field.location === "body") return directiveBodyFieldText(node, field.key) ?? "";
  if (field.location === "body_text") return directiveBody(node).trim().replace(/^Label:\s*/i, "").trim();
  const value = attrValueText(node, field.key);
  if (value !== undefined) return value;
  if (node.name === "metric" && field.key === "label") return node.id ?? "Metric";
  if (node.name === "computed_metric" && field.key === "label") return node.id ?? "Computed metric";
  if (node.name === "control" && field.key === "label") {
    return directiveBody(node).trim().replace(/^Label:\s*/i, "").trim() || "Control";
  }
  if (node.name === "button" && field.key === "label") return "Button";
  if (node.name === "export_button" && field.key === "label") {
    return `Copy as ${attrValueText(node, "format") ?? "text"}`;
  }
  return "";
}

function blockLabelPatchOp(node: DirectiveNode, field: ReviewTextSourceField, value: string): PatchOp {
  if (field.location === "body") {
    return {
      op: "replace_body",
      id: node.id!,
      content: replaceDirectiveBodyField(directiveBody(node), field.key, value),
    };
  }
  if (field.location === "body_text") return { op: "replace_body", id: node.id!, content: value };
  return { op: "update_attribute", id: node.id!, key: field.key, value };
}

function syncMetricValues(
  values: DocxReviewMetricValue[],
  index: SourceIndex,
  ops: PatchOp[],
  changes: DocxReviewSyncChange[],
  skipped: DocxReviewMetricValue[],
): void {
  for (const value of values) {
    const id = mapMetricValueAnchor(value, index);
    const node = id ? index.nodesById.get(id) : undefined;
    const field = metricValueSourceField(node);
    if (value.hasRevisions || !id || !field || !value.value.trim()) {
      skipped.push(value);
      continue;
    }
    const directive = node as DirectiveNode;
    const current = metricValueSourceValue(directive, field);
    const unit = attrValueText(directive, "unit");
    const displayed = metricDisplayValue(current, unit);
    if (sourceReviewTextMatches(displayed, value.value, index)) continue;
    const patch = metricValuePatchValue(value.value, current, unit);
    ops.push(metricValuePatchOp(directive, field, patch.value));
    if (patch.removeUnit) ops.push({ op: "remove_attribute", id, key: "unit" });
    changes.push({ action: "update_metric_value", id, nativeId: value.nativeId, key: field.key });
  }
}

function mapMetricValueAnchor(value: DocxReviewMetricValue, index: SourceIndex): string | undefined {
  for (const bookmark of value.anchorBookmarkNames ?? []) {
    const id = index.bookmarkToId.get(bookmark);
    const node = id ? index.nodesById.get(id) : undefined;
    if (metricValueSourceField(node)) return id;
  }
  return undefined;
}

function metricValueSourceField(node: Node | undefined): MetricValueSourceField | undefined {
  if (!node || !isDirective(node) || node.name !== "metric") return undefined;
  for (const key of ["value", "current", "amount"] as const) {
    if (node.attrs[key] !== undefined) return { key, location: "attr" };
  }
  if (directiveBody(node).trim()) return { key: "body", location: "body" };
  return { key: "value", location: "attr" };
}

function metricValueSourceValue(node: DirectiveNode, field: MetricValueSourceField): string {
  if (field.location === "body") return directiveBody(node).trim();
  return attrValueText(node, field.key) ?? "";
}

function metricDisplayValue(value: string, unit: string | undefined): string {
  if (!unit || value.endsWith(unit)) return value;
  if (/^[%°]/.test(unit)) return `${value}${unit}`;
  return `${value} ${unit}`;
}

function metricValuePatchValue(
  reviewed: string,
  current: string,
  unit: string | undefined,
): { value: string; removeUnit?: boolean } {
  const reviewedValue = reviewed.trim();
  if (!unit || current.endsWith(unit)) return { value: reviewedValue };
  if (/^[%°]/.test(unit) && reviewedValue.endsWith(unit)) {
    return { value: reviewedValue.slice(0, -unit.length).trimEnd() };
  }
  const spacedUnit = ` ${unit}`;
  if (reviewedValue.endsWith(spacedUnit)) {
    return { value: reviewedValue.slice(0, -spacedUnit.length).trimEnd() };
  }
  if (reviewedValue.endsWith(unit)) return { value: reviewedValue };
  return { value: reviewedValue, removeUnit: true };
}

function metricValuePatchOp(node: DirectiveNode, field: MetricValueSourceField, value: string): PatchOp {
  if (field.location === "body") return { op: "replace_body", id: node.id!, content: value };
  return { op: "update_attribute", id: node.id!, key: field.key, value };
}

function syncMetricMetadata(
  metadata: DocxReviewMetricMetadata[],
  index: SourceIndex,
  ops: PatchOp[],
  changes: DocxReviewSyncChange[],
  skipped: DocxReviewMetricMetadata[],
): void {
  for (const meta of metadata) {
    const id = mapMetricMetadataAnchor(meta, index);
    const node = id ? index.nodesById.get(id) : undefined;
    if (meta.hasRevisions || !id || !node || !isDirective(node) || node.name !== "metric") {
      skipped.push(meta);
      continue;
    }
    const directive = node;
    const sourceFields = metricMetadataSourceFields(directive);
    for (const [label, reviewedValue] of Object.entries(meta.fields)) {
      const key = metricMetadataSourceKey(label, directive);
      if (!key) continue;
      if (!reviewedValue.trim()) {
        if (directive.attrs[key] !== undefined) {
          ops.push({ op: "remove_attribute", id, key });
          changes.push({ action: "delete_metric_metadata", id, nativeId: meta.nativeId, key });
        }
        continue;
      }
      if (sourceReviewTextMatches(attrValueText(directive, key) ?? "", reviewedValue, index)) continue;
      ops.push({ op: "update_attribute", id, key, value: reviewedValue });
      changes.push({ action: "update_metric_metadata", id, nativeId: meta.nativeId, key });
    }
    for (const [label, key] of sourceFields) {
      if (Object.hasOwn(meta.fields, label)) continue;
      ops.push({ op: "remove_attribute", id, key });
      changes.push({ action: "delete_metric_metadata", id, nativeId: meta.nativeId, key });
    }
  }
}

function mapMetricMetadataAnchor(meta: DocxReviewMetricMetadata, index: SourceIndex): string | undefined {
  for (const bookmark of meta.anchorBookmarkNames ?? []) {
    const id = index.bookmarkToId.get(bookmark);
    const node = id ? index.nodesById.get(id) : undefined;
    if (node && isDirective(node) && node.name === "metric") return id;
  }
  return undefined;
}

function metricMetadataSourceKey(label: string, node: DirectiveNode): MetricMetadataPatchKey | undefined {
  switch (label) {
    case "status":
      return "status";
    case "trend":
      return "trend";
    case "change":
      return node.attrs.change !== undefined || node.attrs.delta === undefined ? "change" : "delta";
    case "target":
      return "target";
    case "source":
      return "source";
    case "as of":
      if (node.attrs.as_of !== undefined || (node.attrs.asOf === undefined && node.attrs.date === undefined)) return "as_of";
      return node.attrs.asOf !== undefined ? "asOf" : "date";
    default:
      return undefined;
  }
}

function metricMetadataSourceFields(node: DirectiveNode): Array<[string, MetricMetadataPatchKey]> {
  const fields: Array<[string, MetricMetadataPatchKey]> = [];
  if (node.attrs.status !== undefined) fields.push(["status", "status"]);
  if (node.attrs.trend !== undefined) fields.push(["trend", "trend"]);
  if (node.attrs.change !== undefined) fields.push(["change", "change"]);
  else if (node.attrs.delta !== undefined) fields.push(["change", "delta"]);
  if (node.attrs.target !== undefined) fields.push(["target", "target"]);
  if (node.attrs.source !== undefined) fields.push(["source", "source"]);
  if (node.attrs.as_of !== undefined) fields.push(["as of", "as_of"]);
  else if (node.attrs.asOf !== undefined) fields.push(["as of", "asOf"]);
  else if (node.attrs.date !== undefined) fields.push(["as of", "date"]);
  return fields;
}

interface BlockMetadataFieldDef {
  label: string;
  keys: readonly string[];
  defaultKey: string;
  bodyKeys?: readonly string[];
}

interface BlockMetadataSourceField {
  key: string;
  location: "attr" | "body";
}

function syncBlockMetadata(
  metadata: DocxReviewBlockMetadata[],
  index: SourceIndex,
  ops: PatchOp[],
  changes: DocxReviewSyncChange[],
  skipped: DocxReviewBlockMetadata[],
): void {
  for (const meta of metadata) {
    const id = mapBlockMetadataAnchor(meta, index);
    const node = id ? index.nodesById.get(id) : undefined;
    if (meta.hasRevisions || !id || !node || !isDirective(node)) {
      skipped.push(meta);
      continue;
    }
    const directive = node;
    const sourceFields = blockMetadataSourceFields(directive);
    let bodyContent = directiveBody(directive);
    for (const [label, reviewedValue] of Object.entries(meta.fields)) {
      const field = blockMetadataSourceKey(label, directive);
      if (!field) continue;
      if (!reviewedValue.trim()) {
        const op = removeBlockMetadataSourceField(directive, field, bodyContent);
        if (!op) continue;
        if (op.op === "replace_body") bodyContent = op.content;
        ops.push(op);
        changes.push({ action: "delete_block_metadata", id, nativeId: meta.nativeId, key: field.key });
        continue;
      }
      if (sourceReviewTextMatches(blockMetadataSourceValue(directive, field), reviewedValue, index)) continue;
      const op = updateBlockMetadataSourceField(directive, field, reviewedValue, bodyContent);
      if (op.op === "replace_body") bodyContent = op.content;
      ops.push(op);
      changes.push({ action: "update_block_metadata", id, nativeId: meta.nativeId, key: field.key });
    }
    for (const [label, field] of sourceFields) {
      if (Object.hasOwn(meta.fields, label)) continue;
      const op = removeBlockMetadataSourceField(directive, field, bodyContent);
      if (!op) continue;
      if (op.op === "replace_body") bodyContent = op.content;
      ops.push(op);
      changes.push({ action: "delete_block_metadata", id, nativeId: meta.nativeId, key: field.key });
    }
  }
}

function mapBlockMetadataAnchor(meta: DocxReviewBlockMetadata, index: SourceIndex): string | undefined {
  for (const bookmark of meta.anchorBookmarkNames ?? []) {
    const id = index.bookmarkToId.get(bookmark);
    const node = id ? index.nodesById.get(id) : undefined;
    if (node && isDirective(node) && blockMetadataFieldDefs(node).length > 0) return id;
  }
  return undefined;
}

function blockMetadataSourceKey(label: string, node: DirectiveNode): BlockMetadataSourceField | undefined {
  const normalized = label.toLowerCase();
  const field = blockMetadataFieldDefs(node).find((def) => def.label === normalized);
  if (!field) return undefined;
  const attrKey = field.keys.find((key) => node.attrs[key] !== undefined);
  if (attrKey) return { key: attrKey, location: "attr" };
  const bodyKey = field.bodyKeys?.find((key) => directiveBodyFieldText(node, key) !== undefined);
  if (bodyKey) return { key: bodyKey, location: "body" };
  return { key: field.defaultKey, location: "attr" };
}

function blockMetadataSourceFields(node: DirectiveNode): Array<[string, BlockMetadataSourceField]> {
  return blockMetadataFieldDefs(node).flatMap((field) => {
    const key = field.keys.find((candidate) => node.attrs[candidate] !== undefined);
    if (key) {
      const source: BlockMetadataSourceField = { key, location: "attr" };
      return [[field.label, source] as [string, BlockMetadataSourceField]];
    }
    const bodyKey = field.bodyKeys?.find((candidate) => directiveBodyFieldText(node, candidate) !== undefined);
    if (bodyKey) {
      const source: BlockMetadataSourceField = { key: bodyKey, location: "body" };
      return [[field.label, source] as [string, BlockMetadataSourceField]];
    }
    return [];
  });
}

function blockMetadataSourceValue(node: DirectiveNode, field: BlockMetadataSourceField): string {
  if (field.location === "body") return directiveBodyFieldText(node, field.key) ?? "";
  return attrValueText(node, field.key) ?? "";
}

function updateBlockMetadataSourceField(node: DirectiveNode, field: BlockMetadataSourceField, value: string, body: string): PatchOp {
  if (field.location === "body") {
    return {
      op: "replace_body",
      id: node.id!,
      content: replaceDirectiveBodyField(body, field.key, value),
    };
  }
  return { op: "update_attribute", id: node.id!, key: field.key, value };
}

function removeBlockMetadataSourceField(node: DirectiveNode, field: BlockMetadataSourceField, body: string): PatchOp | undefined {
  if (field.location === "body") {
    return {
      op: "replace_body",
      id: node.id!,
      content: removeDirectiveBodyField(body, field.key),
    };
  }
  return node.attrs[field.key] !== undefined ? { op: "remove_attribute", id: node.id!, key: field.key } : undefined;
}

function blockMetadataFieldDefs(node: DirectiveNode): BlockMetadataFieldDef[] {
  switch (node.name) {
    case "citation":
      return [
        { label: "source", keys: ["source"], defaultKey: "source" },
        { label: "accessed", keys: ["accessed"], defaultKey: "accessed" },
        { label: "url", keys: ["url", "href"], defaultKey: "url" },
        { label: "doi", keys: ["doi"], defaultKey: "doi" },
      ];
    case "api":
      return [
        { label: "version", keys: ["version"], defaultKey: "version" },
        { label: "base url", keys: ["base_url", "baseUrl", "url"], defaultKey: "base_url" },
        { label: "status", keys: ["status"], defaultKey: "status" },
        { label: "owner", keys: ["owner"], defaultKey: "owner" },
      ];
    case "endpoint":
      return [
        { label: "method", keys: ["method"], defaultKey: "method" },
        { label: "path", keys: ["path", "url"], defaultKey: "path" },
        { label: "auth", keys: ["auth"], defaultKey: "auth" },
        { label: "status", keys: ["status"], defaultKey: "status" },
        { label: "api", keys: ["api"], defaultKey: "api" },
      ];
    case "parameter":
      return [
        { label: "in", keys: ["in", "location"], defaultKey: "in" },
        { label: "type", keys: ["type"], defaultKey: "type" },
        { label: "required", keys: ["required"], defaultKey: "required" },
        { label: "default", keys: ["default"], defaultKey: "default" },
        { label: "enum", keys: ["enum", "values"], defaultKey: "enum" },
      ];
    case "example":
      return [
        { label: "language", keys: ["lang", "language", "format"], defaultKey: "lang" },
        { label: "for", keys: ["for", "target"], defaultKey: "for" },
        { label: "status", keys: ["status"], defaultKey: "status" },
      ];
    case "changelog":
      return [
        { label: "version", keys: ["version"], defaultKey: "version" },
        { label: "date", keys: ["date", "released_at"], defaultKey: "date" },
        { label: "status", keys: ["status"], defaultKey: "status" },
      ];
    case "instruction":
      return [
        { label: "scope", keys: ["scope"], defaultKey: "scope" },
        { label: "audience", keys: ["audience"], defaultKey: "audience" },
        { label: "priority", keys: ["priority"], defaultKey: "priority" },
        { label: "owner", keys: ["owner"], defaultKey: "owner" },
      ];
    case "query":
      return [
        { label: "language", keys: ["lang", "language", "format"], defaultKey: "lang" },
        { label: "dataset", keys: ["dataset"], defaultKey: "dataset" },
        { label: "source", keys: ["source"], defaultKey: "source" },
        { label: "status", keys: ["status"], defaultKey: "status" },
      ];
    case "code_cell":
      return [
        { label: "kernel", keys: ["kernel", "runtime"], defaultKey: "kernel" },
        { label: "status", keys: ["status"], defaultKey: "status" },
        { label: "execution", keys: ["execution_count", "count"], defaultKey: "execution_count" },
      ];
    case "output":
      return [
        { label: "for", keys: ["for", "cell", "source"], defaultKey: "for" },
        { label: "status", keys: ["status"], defaultKey: "status" },
        { label: "mime", keys: ["mime"], defaultKey: "mime" },
      ];
    case "computed_metric":
    case "computed_plot":
      return [
        { label: "formula", keys: ["formula"], bodyKeys: ["formula"], defaultKey: "formula" },
        { label: "domain", keys: ["domain", "range"], bodyKeys: ["domain", "range"], defaultKey: "domain" },
        { label: "unit", keys: ["unit", "suffix"], bodyKeys: ["unit"], defaultKey: "unit" },
      ];
    case "control":
      return [
        { label: "type", keys: ["type"], defaultKey: "type" },
        { label: "default", keys: ["default"], defaultKey: "default" },
        { label: "min", keys: ["min"], defaultKey: "min" },
        { label: "max", keys: ["max"], defaultKey: "max" },
        { label: "step", keys: ["step"], defaultKey: "step" },
      ];
    case "memory":
      return [
        { label: "type", keys: ["type"], defaultKey: "type" },
        { label: "confidence", keys: ["confidence"], defaultKey: "confidence" },
        { label: "last seen", keys: ["last_seen", "lastSeen"], defaultKey: "last_seen" },
        { label: "scope", keys: ["scope"], defaultKey: "scope" },
        { label: "source", keys: ["source"], defaultKey: "source" },
        { label: "valid until", keys: ["valid_until", "validUntil"], defaultKey: "valid_until" },
        { label: "superseded by", keys: ["superseded_by", "supersededBy"], defaultKey: "superseded_by" },
        { label: "expired", keys: ["expired"], defaultKey: "expired" },
      ];
    case "evidence":
    case "counterevidence":
      return [
        { label: "for", keys: ["for"], defaultKey: "for" },
        { label: "source", keys: ["source"], defaultKey: "source" },
        { label: "url", keys: ["url", "href"], defaultKey: "url" },
        { label: "doi", keys: ["doi"], defaultKey: "doi" },
        { label: "accessed", keys: ["accessed"], defaultKey: "accessed" },
      ];
    case "risk":
      return [
        { label: "severity", keys: ["severity"], defaultKey: "severity" },
        { label: "owner", keys: ["owner"], defaultKey: "owner" },
        { label: "status", keys: ["status"], defaultKey: "status" },
      ];
    case "decision":
    case "adr":
      return [
        { label: "status", keys: ["status"], defaultKey: "status" },
        { label: "owner", keys: ["owner"], defaultKey: "owner" },
        { label: "date", keys: ["date", "decided_at"], defaultKey: "date" },
      ];
    case "open_question":
      return [
        { label: "status", keys: ["status"], defaultKey: "status" },
        { label: "owner", keys: ["owner"], defaultKey: "owner" },
        { label: "due", keys: ["due", "due_at"], defaultKey: "due" },
      ];
    case "assumption":
    case "hypothesis":
    case "result":
    case "limitation":
      return [
        { label: "status", keys: ["status"], defaultKey: "status" },
        { label: "owner", keys: ["owner"], defaultKey: "owner" },
        { label: "confidence", keys: ["confidence"], defaultKey: "confidence" },
        { label: "source", keys: ["source"], defaultKey: "source" },
      ];
    case "review":
      return [
        { label: "status", keys: ["status"], defaultKey: "status" },
        { label: "reviewer", keys: ["reviewer", "author", "by"], defaultKey: "reviewer" },
        { label: "due", keys: ["due", "due_at"], defaultKey: "due" },
        { label: "date", keys: ["date", "at"], defaultKey: "date" },
      ];
    case "provenance":
      return [
        { label: "source", keys: ["source"], defaultKey: "source" },
        { label: "url", keys: ["url", "href"], defaultKey: "url" },
        { label: "tool", keys: ["tool", "agent"], defaultKey: "tool" },
        { label: "by", keys: ["by", "author"], defaultKey: "by" },
        { label: "commit", keys: ["commit", "sha"], defaultKey: "commit" },
        { label: "at", keys: ["at", "date"], defaultKey: "at" },
      ];
    case "confidence":
      return [
        { label: "value", keys: ["value", "score", "confidence"], defaultKey: "value" },
        { label: "basis", keys: ["basis", "reason"], defaultKey: "basis" },
        { label: "source", keys: ["source"], defaultKey: "source" },
        { label: "updated", keys: ["updated", "at", "date"], defaultKey: "updated" },
      ];
    case "agent_task":
    case "todo":
      return [
        { label: "scope", keys: ["scope"], defaultKey: "scope" },
        { label: "owner", keys: ["owner"], defaultKey: "owner" },
        { label: "due", keys: ["due", "due_at"], defaultKey: "due" },
        { label: "priority", keys: ["priority"], defaultKey: "priority" },
      ];
    default:
      return [];
  }
}

function attrValueText(node: DirectiveNode, key: string): string | undefined {
  const value = node.attrs[key];
  return value === undefined ? undefined : String(value);
}

function directiveBodyFieldText(node: DirectiveNode, key: string): string | undefined {
  const pattern = new RegExp(`^\\s*${escapeRegExp(key)}\\s*:`, "i");
  const line = directiveBody(node).split(/\r?\n/).find((candidate) => pattern.test(candidate));
  return line?.replace(pattern, "").trim() || undefined;
}

function replaceDirectiveBodyField(body: string, key: string, value: string): string {
  const lines = body.replace(/\r\n?/g, "\n").split("\n");
  const pattern = new RegExp(`^(\\s*${escapeRegExp(key)}\\s*:\\s*)(.*)$`, "i");
  const singleLineValue = value.replace(/\r?\n/g, " ");
  const index = lines.findIndex((line) => pattern.test(line));
  if (index === -1) return body;
  lines[index] = lines[index]!.replace(pattern, `$1${singleLineValue}`);
  return lines.join("\n");
}

function removeDirectiveBodyField(body: string, key: string): string {
  const lines = body.replace(/\r\n?/g, "\n").split("\n");
  const pattern = new RegExp(`^\\s*${escapeRegExp(key)}\\s*:`, "i");
  return lines.filter((line) => !pattern.test(line)).join("\n").trim();
}

function mapRevisionAnchorTarget(revision: DocxReviewRevision, index: SourceIndex): string | undefined {
  for (const bookmark of revision.anchorBookmarkNames ?? []) {
    const id = index.bookmarkToId.get(bookmark);
    const node = id ? index.nodesById.get(id) : undefined;
    if (id && !isCommentDirective(node) && !isChangeRequestDirective(node)) return id;
  }
  return undefined;
}

function mapRevisionSourceId(revision: DocxReviewRevision, index: SourceIndex): string | undefined {
  for (const bookmark of revision.sourceBookmarkNames ?? []) {
    const id = index.bookmarkToId.get(bookmark);
    const node = id ? index.nodesById.get(id) : undefined;
    if (id && isChangeRequestDirective(node) && changeRequestExportsNativeRevision(node)) return id;
  }
  return undefined;
}

function mapRevisionSourceTarget(revision: DocxReviewRevision, index: SourceIndex): string | undefined {
  for (const bookmark of revision.sourceBookmarkNames ?? []) {
    const id = index.bookmarkToId.get(bookmark);
    const node = id ? index.nodesById.get(id) : undefined;
    if (isChangeRequestDirective(node)) return changeRequestTarget(node);
  }
  return undefined;
}

function syncDeletedComments(
  index: SourceIndex,
  matchedSourceCommentIds: Set<string>,
  reviewedCommentTargets: Set<string>,
  reviewedReplyParents: Set<string>,
  ambiguousCommentTargets: Set<string>,
  ambiguousReplyParents: Set<string>,
  ops: PatchOp[],
  changes: DocxReviewSyncChange[],
): void {
  for (const node of index.nodesById.values()) {
    if (!isCommentDirective(node) || !node.id) continue;
    if (matchedSourceCommentIds.has(node.id) || commentSuppressed(node)) continue;
    const replyTo = commentReplyTarget(node);
    if (replyTo) {
      if (!reviewedReplyParents.has(replyTo)) continue;
      if (ambiguousReplyParents.has(replyTo)) continue;
      ops.push({ op: "update_attribute", id: node.id, key: "status", value: "deleted" });
      changes.push({ action: "delete_comment", id: node.id, replyTo });
      continue;
    }
    const target = commentTarget(node);
    const canonicalTarget = canonicalReference(index, target);
    if (!target || !canonicalTarget || !reviewedCommentTargets.has(canonicalTarget)) continue;
    if (ambiguousCommentTargets.has(canonicalTarget)) continue;
    ops.push({ op: "update_attribute", id: node.id, key: "status", value: "deleted" });
    changes.push({ action: "delete_comment", id: node.id, target });
  }
}

interface ChangeRequestSyncState {
  matchedIds: Set<string>;
  reviewedTargets: Set<string>;
  ambiguousTargets: Set<string>;
}

function createChangeRequestSyncState(): ChangeRequestSyncState {
  return {
    matchedIds: new Set(),
    reviewedTargets: new Set(),
    ambiguousTargets: new Set(),
  };
}

function syncChangeRequests(
  revisions: DocxReviewRevision[],
  index: SourceIndex,
  ops: PatchOp[],
  changes: DocxReviewSyncChange[],
  skipped: DocxReviewRevision[],
  usedIds: Set<string>,
  state: ChangeRequestSyncState,
): void {
  for (const revision of revisions) {
    const sourceId = mapRevisionSourceId(revision, index);
    const sourceNode = sourceId ? index.nodesById.get(sourceId) : undefined;
    const targetId = canonicalReference(
      index,
      revision.targetId ??
      mapRevisionAnchorTarget(revision, index) ??
      mapRevisionSourceTarget(revision, index) ??
      (isChangeRequestDirective(sourceNode) ? changeRequestTarget(sourceNode) : undefined),
    );
    if (targetId) state.reviewedTargets.add(targetId);
    if (sourceId) {
      state.matchedIds.add(sourceId);
      updateMatchedChangeRequest(sourceId, revision, index, ops, changes);
      continue;
    }
    if (!targetId || !revisionHasText(revision)) {
      skipped.push(revision);
      continue;
    }
    const exact = findMatchingChangeRequest(index, targetId, revision, state.matchedIds);
    if (exact.id) {
      state.matchedIds.add(exact.id);
      continue;
    }
    if (exact.ambiguous) {
      state.ambiguousTargets.add(targetId);
      skipped.push(revision);
      continue;
    }
    const equivalent = findEquivalentChangeRequest(index, targetId, revision, state.matchedIds);
    if (equivalent.id) {
      state.matchedIds.add(equivalent.id);
      updateMatchedChangeRequest(equivalent.id, revision, index, ops, changes);
      continue;
    }
    if (equivalent.ambiguous) {
      state.ambiguousTargets.add(targetId);
      skipped.push(revision);
      continue;
    }
    if (revision.targetId) {
      const candidates = targetedChangeRequestCandidates(index, targetId, state.matchedIds);
      const existing = selectExistingChangeRequest(candidates, revision);
      if (existing.id) {
        const id = existing.id;
        state.matchedIds.add(id);
        updateMatchedChangeRequest(id, revision, index, ops, changes);
        continue;
      }
      if (existing.ambiguous) {
        state.ambiguousTargets.add(targetId);
        skipped.push(revision);
        continue;
      }
    }
    const id = uniqueCommentId(`change-${targetId}-${revision.nativeId}`, usedIds);
    ops.push({
      op: "add_change_request",
      id,
      target: targetId,
      action: revision.action,
      ...(revision.oldText ? { from: revision.oldText } : {}),
      ...(revision.newText ? { to: revision.newText } : {}),
      ...(revision.author ? { author: revision.author } : {}),
      ...(revision.date ? { date: revision.date } : {}),
    });
    changes.push({ action: "add_change_request", id, target: targetId, nativeId: revision.nativeId });
  }
}

function updateMatchedChangeRequest(
  id: string,
  revision: DocxReviewRevision,
  index: SourceIndex,
  ops: PatchOp[],
  changes: DocxReviewSyncChange[],
): void {
  const node = index.nodesById.get(id);
  if (!isChangeRequestDirective(node) || !revisionHasText(revision)) return;
  const before = ops.length;
  updateAttrIfChanged(node, ops, changeRequestActionKey(node), revision.action);
  if (revision.action === "replace") {
    if (revision.oldText) updateReviewAttrIfChanged(node, ops, "from", revision.oldText, index);
    if (revision.newText) updateReviewAttrIfChanged(node, ops, "to", revision.newText, index);
  } else if (revision.action === "insert") {
    updateChangeRequestSingleText(node, ops, "insert", revision.newText ?? "", index);
  } else {
    updateChangeRequestSingleText(node, ops, "delete", revision.oldText ?? "", index);
  }
  if (revision.author && changeRequestHasAuthorAttr(node)) updateAttrIfChanged(node, ops, changeRequestAuthorKey(node), revision.author);
  if (revision.date && changeRequestHasDateAttr(node)) updateAttrIfChanged(node, ops, changeRequestDateKey(node), revision.date);
  if (ops.length > before) changes.push({ action: "update_change_request", id, nativeId: revision.nativeId });
}

function syncDeletedChangeRequests(
  index: SourceIndex,
  state: ChangeRequestSyncState,
  ops: PatchOp[],
  changes: DocxReviewSyncChange[],
): void {
  for (const node of index.nodesById.values()) {
    if (!isChangeRequestDirective(node) || !node.id) continue;
    if (state.matchedIds.has(node.id) || !changeRequestExportsNativeRevision(node)) continue;
    const target = changeRequestTarget(node);
    const canonicalTarget = canonicalReference(index, target);
    if (!target || !canonicalTarget || !state.reviewedTargets.has(canonicalTarget) || state.ambiguousTargets.has(canonicalTarget)) continue;
    ops.push({ op: "update_attribute", id: node.id, key: "status", value: "deleted" });
    changes.push({ action: "delete_change_request", id: node.id, target });
  }
}

interface NoteSyncState {
  matchedIds: Set<string>;
  reviewedTargets: Set<string>;
  ambiguousTargets: Set<string>;
}

interface MappedReviewNote {
  note: DocxReviewNote;
  mapped: { targetId?: string; sourceId?: string };
  handled: boolean;
}

function createNoteSyncState(): NoteSyncState {
  return {
    matchedIds: new Set(),
    reviewedTargets: new Set(),
    ambiguousTargets: new Set(),
  };
}

function syncNotes(
  kind: "footnote" | "endnote",
  notes: DocxReviewNote[],
  index: SourceIndex,
  ops: PatchOp[],
  changes: DocxReviewSyncChange[],
  skipped: DocxReviewNote[],
  usedIds: Set<string>,
  state: NoteSyncState,
): void {
  const mappedNotes: MappedReviewNote[] = notes.map((note) => ({
    note,
    mapped: mapNoteAnchors(note, index, kind),
    handled: false,
  }));
  for (const item of mappedNotes) {
    if (item.mapped.targetId) state.reviewedTargets.add(item.mapped.targetId);
    if (!item.mapped.sourceId) continue;
    state.matchedIds.add(item.mapped.sourceId);
    item.handled = true;
    if (item.note.hasRevisions) {
      skipped.push(item.note);
      continue;
    }
    updateMatchedNote(kind, item.mapped.sourceId, item.note, index, ops, changes);
  }

  for (const item of mappedNotes) {
    if (item.handled || item.note.hasRevisions || !item.mapped.targetId || !item.note.body.trim()) continue;
    const exactId = findExactTargetedNote(index, kind, item.mapped.targetId, item.note.body, state.matchedIds);
    if (!exactId) continue;
    state.matchedIds.add(exactId);
    item.handled = true;
    updateMatchedNote(kind, exactId, item.note, index, ops, changes);
  }

  for (const item of mappedNotes) {
    if (item.handled) continue;
    const { note, mapped } = item;
    if (note.hasRevisions) {
      if (mapped.targetId) state.ambiguousTargets.add(mapped.targetId);
      skipped.push(note);
      continue;
    }
    if (!mapped.targetId || !note.body.trim()) {
      skipped.push(note);
      continue;
    }
    const candidates = targetedNoteCandidates(index, kind, mapped.targetId, state.matchedIds);
    if (candidates.length === 1 && candidates[0]?.id) {
      const id = candidates[0].id;
      state.matchedIds.add(id);
      updateMatchedNote(kind, id, note, index, ops, changes);
      continue;
    }
    if (candidates.length > 1) {
      state.ambiguousTargets.add(mapped.targetId);
      skipped.push(note);
      continue;
    }
    const id = uniqueCommentId(`${kind}-${mapped.targetId}-${note.nativeId}`, usedIds);
    if (kind === "footnote") {
      ops.push({ op: "add_footnote", id, target: mapped.targetId, content: note.body });
      changes.push({ action: "add_footnote", id, target: mapped.targetId, nativeId: note.nativeId });
    } else {
      ops.push({ op: "add_endnote", id, target: mapped.targetId, content: note.body });
      changes.push({ action: "add_endnote", id, target: mapped.targetId, nativeId: note.nativeId });
    }
  }
}

function updateMatchedNote(
  kind: "footnote" | "endnote",
  id: string,
  note: DocxReviewNote,
  index: SourceIndex,
  ops: PatchOp[],
  changes: DocxReviewSyncChange[],
): void {
  const node = index.nodesById.get(id);
  if (isNoteDirective(node, kind) && noteBodyIsGeneratedFallback(kind, node, note.body)) return;
  if (!isNoteDirective(node, kind) || !note.body.trim() || sourceReviewBodyMatches(node, note.body, index)) return;
  ops.push({ op: "replace_body", id, content: note.body });
  changes.push({
    action: kind === "footnote" ? "update_footnote" : "update_endnote",
    id,
    nativeId: note.nativeId,
  });
}

function syncDeletedNotes(
  kind: "footnote" | "endnote",
  index: SourceIndex,
  state: NoteSyncState,
  ops: PatchOp[],
  changes: DocxReviewSyncChange[],
): void {
  for (const node of index.nodesById.values()) {
    if (!isNoteDirective(node, kind) || !node.id) continue;
    if (state.matchedIds.has(node.id) || noteClosed(node)) continue;
    const target = noteTarget(node);
    const canonicalTarget = canonicalReference(index, target);
    if (!target || !canonicalTarget || !state.reviewedTargets.has(canonicalTarget) || state.ambiguousTargets.has(canonicalTarget)) continue;
    ops.push({ op: "update_attribute", id: node.id, key: "status", value: "deleted" });
    changes.push({
      action: kind === "footnote" ? "delete_footnote" : "delete_endnote",
      id: node.id,
      target,
    });
  }
}

function syncTable(
  table: DocxReviewTable,
  index: SourceIndex,
  ops: PatchOp[],
  changes: DocxReviewSyncChange[],
  skipped: DocxReviewTable[],
): void {
  if (table.hasRevisions) {
    skipped.push(table);
    return;
  }
  const id = mapTableAnchor(table, index);
  const node = id ? index.nodesById.get(id) : undefined;
  if (!id || !isTableLikeDirective(node) || table.rows.length === 0) {
    skipped.push(table);
    return;
  }
  if (isDatasetDirective(node)) {
    syncDatasetTable(id, node, table, index, ops, changes, skipped);
    return;
  }
  const currentRows = sourceTableRows(node);
  if (sameRows(currentRows, table.rows, index)) return;
  const tableOps = granularTablePatchOps(id, node, currentRows, table.rows, index);
  if (tableOps) {
    ops.push(...tableOps);
  } else if (!rowsHaveMultilineCells(table.rows)) {
    ops.push({ op: "replace_body", id, content: serializeTableRows(table.rows) });
  } else {
    skipped.push(table);
    return;
  }
  changes.push({ action: "update_table", id, nativeId: table.nativeId });
}

function granularTablePatchOps(
  id: string,
  node: DirectiveNode,
  currentRows: string[][],
  nextRows: string[][],
  index: SourceIndex,
): PatchOp[] | undefined {
  const headerOffset = tableHasHeader(node) ? 1 : 0;
  if (currentRows.length === nextRows.length) {
    return (
      sameShapeTableUpdateOps(id, currentRows, nextRows, headerOffset, index) ??
      columnTablePatchOps(id, currentRows, nextRows, headerOffset, index)
    );
  }
  if (currentRows.length + 1 === nextRows.length) {
    const inserted = findInsertedRow(currentRows, nextRows, index);
    if (inserted === undefined || inserted < headerOffset) return undefined;
    const cells = nextRows[inserted] ?? [];
    if (!singleLineCells(cells)) return undefined;
    return [{ op: "insert_table_row", id, row: inserted - headerOffset, cells }];
  }
  if (currentRows.length - 1 === nextRows.length) {
    const deleted = findDeletedRow(currentRows, nextRows, index);
    if (deleted === undefined || deleted < headerOffset) return undefined;
    return [{ op: "delete_table_row", id, row: deleted - headerOffset }];
  }
  return undefined;
}

function columnTablePatchOps(
  id: string,
  currentRows: string[][],
  nextRows: string[][],
  headerOffset: number,
  index: SourceIndex,
): PatchOp[] | undefined {
  const insertedColumn = findInsertedColumn(currentRows, nextRows, index);
  if (insertedColumn !== undefined) {
    const header = headerOffset > 0 ? nextRows[0]?.[insertedColumn] ?? "" : undefined;
    const cells = nextRows.slice(headerOffset).map((row) => row[insertedColumn] ?? "");
    if ((header !== undefined && !singleLineCell(header)) || !singleLineCells(cells)) return undefined;
    return [{
      op: "insert_table_column",
      id,
      column: insertedColumn,
      ...(header !== undefined ? { header } : {}),
      cells,
    }];
  }
  const deletedColumn = findDeletedColumn(currentRows, nextRows, index);
  if (deletedColumn !== undefined) return [{ op: "delete_table_column", id, column: deletedColumn }];
  return undefined;
}

function sameShapeTableUpdateOps(
  id: string,
  currentRows: string[][],
  nextRows: string[][],
  headerOffset: number,
  index: SourceIndex,
): PatchOp[] | undefined {
  const out: PatchOp[] = [];
  for (let rowIndex = 0; rowIndex < nextRows.length; rowIndex++) {
    const current = currentRows[rowIndex] ?? [];
    const next = nextRows[rowIndex] ?? [];
    if (current.length !== next.length) return undefined;
    if (rowIndex < headerOffset) {
      for (let column = 0; column < next.length; column++) {
        const value = next[column] ?? "";
        if (sourceCellMatches(current[column] ?? "", value, index)) continue;
        if (!singleLineCell(value)) return undefined;
        out.push({ op: "update_table_header_cell", id, column, value });
      }
      continue;
    }
    for (let column = 0; column < next.length; column++) {
      const value = next[column] ?? "";
      if (sourceCellMatches(current[column] ?? "", value, index)) continue;
      if (!singleLineCell(value)) return undefined;
      out.push({ op: "update_table_cell", id, row: rowIndex - headerOffset, column, value });
    }
  }
  return out;
}

function syncDatasetTable(
  id: string,
  node: DirectiveNode,
  table: DocxReviewTable,
  index: SourceIndex,
  ops: PatchOp[],
  changes: DocxReviewSyncChange[],
  skipped: DocxReviewTable[],
): void {
  const currentRows = sourceDatasetRows(id, index);
  if (!currentRows || table.rows.length < 1) {
    skipped.push(table);
    return;
  }
  if (sameRows(currentRows, table.rows, index)) return;
  const datasetOps = granularDatasetPatchOps(id, node, currentRows, table.rows, index);
  if (datasetOps) {
    ops.push(...datasetOps);
    changes.push({ action: "update_dataset", id, nativeId: table.nativeId });
    return;
  }
  if (rowsHaveMultilineCells(table.rows)) {
    skipped.push(table);
    return;
  }
  const content = serializeDatasetRows(node, table.rows);
  if (!content) {
    skipped.push(table);
    return;
  }
  ops.push({ op: "replace_body", id, content });
  changes.push({ action: "update_dataset", id, nativeId: table.nativeId });
}

function granularDatasetPatchOps(
  id: string,
  node: DirectiveNode,
  currentRows: string[][],
  nextRows: string[][],
  index: SourceIndex,
): PatchOp[] | undefined {
  const format = (stringAttr(node, "format") ?? "yaml").toLowerCase();
  if (format !== "yaml" && format !== "csv" && format !== "tsv" && format !== "json") return undefined;
  if (format === "json" && !jsonDatasetSupportsGranularPatch(node)) return undefined;
  const currentHeader = currentRows[0] ?? [];
  const nextHeader = nextRows[0] ?? [];
  if (currentRows.length === nextRows.length) {
    return (
      (sameRow(currentHeader, nextHeader, index) ? sameShapeDatasetUpdateOps(id, currentRows, nextRows, format, index) : undefined) ??
      columnDatasetPatchOps(id, node, currentRows, nextRows, format, index)
    );
  }
  if (!sameRow(currentHeader, nextHeader, index)) return undefined;
  if (!datasetSupportsGranularRowPatch(node, format)) return undefined;
  if (currentRows.length + 1 === nextRows.length) {
    const inserted = findInsertedRow(currentRows, nextRows, index);
    if (inserted === undefined || inserted < 1) return undefined;
    const cells = nextRows[inserted] ?? [];
    if (!datasetCellsSupportedByGranularPatch(cells, format)) return undefined;
    return [{ op: "insert_dataset_row", id, row: inserted - 1, cells }];
  }
  if (currentRows.length - 1 === nextRows.length) {
    const deleted = findDeletedRow(currentRows, nextRows, index);
    if (deleted === undefined || deleted < 1) return undefined;
    return [{ op: "delete_dataset_row", id, row: deleted - 1 }];
  }
  return undefined;
}

function sameShapeDatasetUpdateOps(
  id: string,
  currentRows: string[][],
  nextRows: string[][],
  format: string,
  index: SourceIndex,
): PatchOp[] | undefined {
  if (currentRows.length < 2) return undefined;
  const out: PatchOp[] = [];
  for (let rowIndex = 1; rowIndex < nextRows.length; rowIndex++) {
    const current = currentRows[rowIndex] ?? [];
    const next = nextRows[rowIndex] ?? [];
    if (current.length !== next.length) return undefined;
    for (let column = 0; column < next.length; column++) {
      const value = next[column] ?? "";
      if (sourceCellMatches(current[column] ?? "", value, index)) continue;
      if (!datasetCellSupportedByGranularPatch(value, format)) return undefined;
      out.push({ op: "update_dataset_cell", id, row: rowIndex - 1, column, value });
    }
  }
  return out.length > 0 ? out : undefined;
}

function columnDatasetPatchOps(
  id: string,
  node: DirectiveNode,
  currentRows: string[][],
  nextRows: string[][],
  format: string,
  index: SourceIndex,
): PatchOp[] | undefined {
  if (!datasetSupportsGranularColumnPatch(node, format)) return undefined;
  const insertedColumn = findInsertedColumn(currentRows, nextRows, index);
  if (insertedColumn !== undefined) {
    const header = nextRows[0]?.[insertedColumn] ?? "";
    const cells = nextRows.slice(1).map((row) => row[insertedColumn] ?? "");
    if (!datasetColumnHeaderSupportedByGranularPatch(header) || !datasetCellsSupportedByGranularPatch(cells, format)) return undefined;
    return [{ op: "insert_dataset_column", id, column: insertedColumn, header, cells }];
  }
  const deletedColumn = findDeletedColumn(currentRows, nextRows, index);
  if (deletedColumn !== undefined) {
    const header = currentRows[0]?.[deletedColumn];
    return [{ op: "delete_dataset_column", id, column: header && header.trim() ? header : deletedColumn }];
  }
  return undefined;
}

function datasetSupportsGranularColumnPatch(node: DirectiveNode, format: string): boolean {
  if (format === "csv" || format === "tsv") return true;
  if (format === "yaml") return yamlDatasetSupportsGranularColumns(node);
  if (format === "json") return jsonDatasetSupportsGranularColumnPatch(node);
  return false;
}

function yamlDatasetSupportsGranularColumns(node: DirectiveNode): boolean {
  const body = node.body ?? "";
  let parsed: unknown;
  try {
    parsed = yaml.load(body);
  } catch {
    return false;
  }
  const schema = recordValue(recordValue(parsed)?.schema);
  if (!schema || Object.keys(schema).length === 0 || !rowsAreInlineYamlArrays(body)) return false;
  return Object.keys(schema).every((key) => new RegExp(`^\\s*${escapeRegExp(key)}\\s*:`, "m").test(body));
}

function jsonDatasetSupportsGranularColumnPatch(node: DirectiveNode): boolean {
  const body = node.body ?? "";
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return false;
  }
  const lines = body.replace(/\r\n?/g, "\n").split("\n");
  if (Array.isArray(parsed)) return firstJsonRowIsRecord(parsed) && jsonHasRecordRowBounds(lines);
  const record = recordValue(parsed);
  return Array.isArray(record?.rows) && jsonHasOneLineColumnsArray(lines) && jsonHasOneLineArrayRows(lines);
}

function jsonHasOneLineColumnsArray(lines: string[]): boolean {
  return lines.some((line) => {
    const match = line.match(/^\s*"columns"\s*:\s*(\[.*\])\s*,?\s*$/);
    if (!match) return false;
    try {
      return Array.isArray(JSON.parse(match[1] ?? ""));
    } catch {
      return false;
    }
  });
}

function datasetColumnHeaderSupportedByGranularPatch(header: string): boolean {
  return singleLineCell(header) && header.trim().length > 0;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function datasetSupportsGranularRowPatch(node: DirectiveNode, format: string): boolean {
  if (format === "csv" || format === "tsv") return true;
  if (format === "yaml") return yamlDatasetSupportsGranularRows(node);
  if (format === "json") return jsonDatasetSupportsGranularRowPatch(node);
  return false;
}

function yamlDatasetSupportsGranularRows(node: DirectiveNode): boolean {
  const body = node.body ?? "";
  try {
    const parsed = yaml.load(body);
    const rows = recordValue(parsed)?.rows;
    if (!Array.isArray(rows)) return false;
    if (rows.length === 0) return /^\s*rows\s*:\s*\[\]\s*$/m.test(body) || /^\s*rows\s*:\s*$/m.test(body);
  } catch {
    return false;
  }
  return rowsAreInlineYamlArrays(body);
}

function rowsAreInlineYamlArrays(body: string): boolean {
  const lines = body.replace(/\r\n?/g, "\n").split("\n");
  let insideRows = false;
  let rowsIndent = -1;
  let mapped = 0;
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const indent = line.match(/^\s*/)?.[0].length ?? 0;
    if (!insideRows) {
      if (/^rows\s*:/.test(trimmed)) {
        insideRows = true;
        rowsIndent = indent;
      }
      continue;
    }
    if (indent <= rowsIndent && !trimmed.startsWith("-")) break;
    if (/^\s*-\s*\[.*\](?:\s+#.*)?\s*$/.test(line)) mapped += 1;
    else if (trimmed.startsWith("-")) return false;
  }
  return mapped > 0;
}

function datasetCellSupportedByGranularPatch(cell: string, _format: string): boolean {
  if (!singleLineCell(cell)) return false;
  return true;
}

function datasetCellsSupportedByGranularPatch(cells: string[], format: string): boolean {
  return cells.every((cell) => datasetCellSupportedByGranularPatch(cell, format));
}

function jsonDatasetSupportsGranularPatch(node: DirectiveNode): boolean {
  const body = node.body ?? "";
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return false;
  }
  const lines = body.replace(/\r\n?/g, "\n").split("\n");
  if (Array.isArray(parsed) && firstJsonRowIsRecord(parsed)) {
    const firstNonblank = lines.findIndex((line) => line.trim().length > 0);
    return firstNonblank !== -1 && lines[firstNonblank]?.trim() === "[" && lines.slice(firstNonblank + 1).some((line) => line.trim().startsWith("{"));
  }
  if (Array.isArray(parsed)) return jsonHasOneLineArrayRows(lines);
  const record = recordValue(parsed);
  return Array.isArray(record?.rows) && jsonHasOneLineArrayRows(lines);
}

function jsonDatasetSupportsGranularRowPatch(node: DirectiveNode): boolean {
  const body = node.body ?? "";
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return false;
  }
  const lines = body.replace(/\r\n?/g, "\n").split("\n");
  if (Array.isArray(parsed)) {
    return firstJsonRowIsRecord(parsed)
      ? jsonHasRecordRowBounds(lines)
      : jsonHasRowArrayBounds(lines, false);
  }
  const record = recordValue(parsed);
  return Array.isArray(record?.rows) && jsonHasRowArrayBounds(lines, true);
}

function jsonHasRecordRowBounds(lines: string[]): boolean {
  const firstNonblank = lines.findIndex((line) => line.trim().length > 0);
  return firstNonblank !== -1 && lines[firstNonblank]?.trim() === "[" && lines.slice(firstNonblank + 1).some((line) => line.trim().startsWith("{"));
}

function jsonHasRowArrayBounds(lines: string[], objectRows: boolean): boolean {
  return lines.some((line) => {
    const trimmed = line.trim();
    if (objectRows) {
      return /^"rows"\s*:\s*\[\s*$/.test(trimmed) || /^"rows"\s*:\s*\[\]\s*,?\s*$/.test(trimmed);
    }
    return trimmed === "[";
  });
}

function jsonHasOneLineArrayRows(lines: string[]): boolean {
  return lines.some((line) => {
    const trimmed = line.trim();
    if (!trimmed.startsWith("[") || trimmed === "[" || trimmed === "],") return false;
    const candidate = trimmed.endsWith(",") ? trimmed.slice(0, -1).trimEnd() : trimmed;
    try {
      return Array.isArray(JSON.parse(candidate));
    } catch {
      return false;
    }
  });
}

function mapTableAnchor(table: DocxReviewTable, index: SourceIndex): string | undefined {
  for (const bookmark of table.anchorBookmarkNames ?? []) {
    const id = index.bookmarkToId.get(bookmark);
    const node = id ? index.nodesById.get(id) : undefined;
    if (id && isTableLikeDirective(node)) return id;
  }
  return undefined;
}

function mapNoteAnchors(
  note: DocxReviewNote,
  index: SourceIndex,
  kind: "footnote" | "endnote",
): { targetId?: string; sourceId?: string } {
  let targetId: string | undefined;
  const sourceCandidates = new Set<string>();
  for (const bookmark of note.anchorBookmarkNames ?? []) {
    const id = index.bookmarkToId.get(bookmark);
    if (!id) continue;
    const node = index.nodesById.get(id);
    if (isNoteDirective(node, kind)) {
      targetId ??= noteTarget(node);
      if (!noteClosed(node)) sourceCandidates.add(id);
    } else if (!isCommentDirective(node) && !isChangeRequestDirective(node)) {
      targetId ??= id;
    }
  }
  const sourceId = sourceCandidates.size === 1 ? [...sourceCandidates][0] : undefined;
  return { targetId, sourceId };
}

function isCommentDirective(node: Node | undefined): node is DirectiveNode {
  return Boolean(node && isDirective(node) && node.name === "comment");
}

function sourceCommentResolved(node: Node | undefined): boolean {
  return isCommentDirective(node) && node.attrs.status === "resolved";
}

function sourceCommentResolutionNeedsUpdate(node: Node | undefined, comment: DocxReviewComment): boolean {
  if (!sourceCommentResolved(node)) return true;
  if (!isCommentDirective(node)) return false;
  if (comment.resolvedBy && stringAttr(node, "resolved_by") !== comment.resolvedBy) return true;
  if (comment.resolvedAt && stringAttr(node, "resolved_at") !== comment.resolvedAt) return true;
  return false;
}

function sourceCommentResolutionAttrKeys(node: Node | undefined): Array<"status" | "resolved_by" | "resolved_at"> {
  if (!isCommentDirective(node)) return [];
  return ["status", "resolved_by", "resolved_at"].filter((key) => node.attrs[key] !== undefined) as Array<
    "status" | "resolved_by" | "resolved_at"
  >;
}

function commentSuppressed(node: DirectiveNode): boolean {
  const status = stringAttr(node, "status")?.toLowerCase();
  return status === "deleted" || status === "withdrawn";
}

function commentBodyIsGeneratedFallback(node: DirectiveNode, reviewedBody: string): boolean {
  return !directiveBody(node).trim() && reviewedBody.trim() === "Comment";
}

function commentReplyTarget(node: DirectiveNode): string | undefined {
  return stringAttr(node, "reply_to") ?? stringAttr(node, "replyTo") ?? stringAttr(node, "reply");
}

function commentTarget(node: DirectiveNode): string | undefined {
  return stringAttr(node, "for") ?? stringAttr(node, "parent") ?? stringAttr(node, "target") ?? stringAttr(node, "block") ?? stringAttr(node, "ref");
}

interface ExistingReviewMatch {
  id?: string;
  ambiguous?: boolean;
}

function findExistingTargetComment(
  index: SourceIndex,
  targetId: string,
  comment: DocxReviewComment,
  matchedSourceCommentIds: Set<string>,
): ExistingReviewMatch {
  const candidates: DirectiveNode[] = [];
  for (const node of index.nodesById.values()) {
    if (!isCommentDirective(node) || !node.id) continue;
    if (matchedSourceCommentIds.has(node.id) || commentSuppressed(node)) continue;
    if (commentReplyTarget(node)) continue;
    if (!referencesEqual(index, commentTarget(node), targetId)) continue;
    candidates.push(node);
  }
  return selectExistingComment(candidates, comment, index);
}

function findExistingReplyComment(
  index: SourceIndex,
  replyTo: string,
  comment: DocxReviewComment,
  matchedSourceCommentIds: Set<string>,
): ExistingReviewMatch {
  const candidates: DirectiveNode[] = [];
  for (const node of index.nodesById.values()) {
    if (!isCommentDirective(node) || !node.id) continue;
    if (matchedSourceCommentIds.has(node.id) || commentSuppressed(node)) continue;
    const sourceReplyTo = commentReplyTarget(node);
    if (sourceReplyTo !== replyTo) continue;
    candidates.push(node);
  }
  return selectExistingComment(candidates, comment, index);
}

function selectExistingComment(
  candidates: DirectiveNode[],
  comment: DocxReviewComment,
  index: SourceIndex,
): ExistingReviewMatch {
  const bodyMatches = candidates.filter((node) =>
    sourceReviewIdentityMatches(node, comment.body, index) || commentBodyIsGeneratedFallback(node, comment.body),
  );
  if (bodyMatches.length > 0) return selectMetadataCompatibleComment(bodyMatches, comment);
  const metadataResults = candidates.map((node) => ({ node, result: reviewCommentMetadataResult(node, comment) }));
  const metadataMatches = metadataResults.filter(({ result }) => result === "match").map(({ node }) => node);
  if (metadataMatches.length === 1) return { id: metadataMatches[0]?.id };
  if (metadataMatches.length > 1) return { ambiguous: true };
  if (candidates.length === 1) {
    return metadataResults[0]?.result === "mismatch" ? {} : { id: candidates[0]?.id };
  }
  return candidates.length > 1 ? { ambiguous: true } : {};
}

function selectMetadataCompatibleComment(candidates: DirectiveNode[], comment: DocxReviewComment): ExistingReviewMatch {
  const metadataResults = candidates.map((node) => ({ node, result: reviewCommentMetadataResult(node, comment) }));
  const metadataMatches = metadataResults.filter(({ result }) => result === "match").map(({ node }) => node);
  if (metadataMatches.length === 1) return { id: metadataMatches[0]?.id };
  if (metadataMatches.length > 1) return { ambiguous: true };
  const compatible = metadataResults.filter(({ result }) => result !== "mismatch").map(({ node }) => node);
  if (compatible.length === 1) return { id: compatible[0]?.id };
  if (compatible.length > 1) return { ambiguous: true };
  return {};
}

function reviewCommentMetadataResult(node: DirectiveNode, comment: DocxReviewComment): "match" | "mismatch" | "none" {
  const checks: Array<["author" | "initials" | "date", string]> = [];
  if (comment.author) checks.push(["author", comment.author]);
  if (comment.initials) checks.push(["initials", comment.initials]);
  if (comment.date) checks.push(["date", comment.date]);
  if (checks.length === 0) return "none";
  let comparable = false;
  for (const [key, value] of checks) {
    const sourceValue = stringAttr(node, key);
    if (sourceValue === undefined) continue;
    comparable = true;
    if (sourceValue !== value) return "mismatch";
  }
  return comparable ? "match" : "none";
}

function sourceReviewIdentityMatches(
  node: DirectiveNode,
  reviewedBody: string,
  index?: SourceIndex,
): boolean {
  return sourceReviewBodyMatches(node, reviewedBody, index) || sourceBodyText(node) === sourceMarkupText(reviewedBody);
}

function isChangeRequestDirective(node: Node | undefined): node is DirectiveNode {
  return Boolean(node && isDirective(node) && node.name === "change_request");
}

function isTableDirective(node: Node | undefined): node is DirectiveNode {
  return Boolean(node && isDirective(node) && node.name === "table");
}

function isDatasetDirective(node: Node | undefined): node is DirectiveNode {
  return Boolean(node && isDirective(node) && node.name === "dataset");
}

function isTableLikeDirective(node: Node | undefined): node is DirectiveNode {
  return isTableDirective(node) || isDatasetDirective(node);
}

function isNoteDirective(node: Node | undefined, kind: "footnote" | "endnote"): node is DirectiveNode {
  return Boolean(node && isDirective(node) && node.name === kind);
}

function revisionHasText(revision: DocxReviewRevision): boolean {
  return Boolean(revision.oldText?.trim() || revision.newText?.trim());
}

function findMatchingChangeRequest(
  index: SourceIndex,
  targetId: string,
  revision: DocxReviewRevision,
  matchedIds: Set<string>,
): ExistingReviewMatch {
  const matches = targetedChangeRequestCandidates(index, targetId, matchedIds).filter((node) =>
    changeRequestMatchesRevision(node, revision, index),
  );
  return selectMetadataCompatibleChangeRequest(matches, revision);
}

function findEquivalentChangeRequest(
  index: SourceIndex,
  targetId: string,
  revision: DocxReviewRevision,
  matchedIds: Set<string>,
): ExistingReviewMatch {
  const matches = targetedChangeRequestCandidates(index, targetId, matchedIds).filter((node) =>
    changeRequestTextIdentityMatches(node, revision),
  );
  return selectMetadataCompatibleChangeRequest(matches, revision);
}

function targetedChangeRequestCandidates(
  index: SourceIndex,
  targetId: string,
  matchedIds: Set<string>,
): DirectiveNode[] {
  const out: DirectiveNode[] = [];
  for (const node of index.nodesById.values()) {
    if (!isChangeRequestDirective(node) || !node.id) continue;
    if (matchedIds.has(node.id) || !changeRequestExportsNativeRevision(node)) continue;
    if (referencesEqual(index, changeRequestTarget(node), targetId)) out.push(node);
  }
  return out;
}

function selectExistingChangeRequest(candidates: DirectiveNode[], revision: DocxReviewRevision): ExistingReviewMatch {
  const metadataResults = candidates.map((node) => ({ node, result: reviewChangeRequestMetadataResult(node, revision) }));
  const metadataMatches = metadataResults.filter(({ result }) => result === "match").map(({ node }) => node);
  if (metadataMatches.length === 1) return { id: metadataMatches[0]?.id };
  if (metadataMatches.length > 1) return { ambiguous: true };
  if (candidates.length === 1) {
    return metadataResults[0]?.result === "mismatch" ? {} : { id: candidates[0]?.id };
  }
  return candidates.length > 1 ? { ambiguous: true } : {};
}

function selectMetadataCompatibleChangeRequest(candidates: DirectiveNode[], revision: DocxReviewRevision): ExistingReviewMatch {
  if (candidates.length === 0) return {};
  const metadataResults = candidates.map((node) => ({ node, result: reviewChangeRequestMetadataResult(node, revision) }));
  const metadataMatches = metadataResults.filter(({ result }) => result === "match").map(({ node }) => node);
  if (metadataMatches.length === 1) return { id: metadataMatches[0]?.id };
  if (metadataMatches.length > 1) return { ambiguous: true };
  const compatible = metadataResults.filter(({ result }) => result !== "mismatch").map(({ node }) => node);
  if (compatible.length === 1) return { id: compatible[0]?.id };
  if (compatible.length > 1) return { ambiguous: true };
  return {};
}

function reviewChangeRequestMetadataResult(node: DirectiveNode, revision: DocxReviewRevision): "match" | "mismatch" | "none" {
  const checks: Array<["author" | "date", string]> = [];
  if (revision.author) checks.push(["author", revision.author]);
  if (revision.date) checks.push(["date", revision.date]);
  if (checks.length === 0) return "none";
  let comparable = false;
  for (const [key, value] of checks) {
    const sourceValue = key === "author" ? changeRequestAuthor(node) : changeRequestDate(node);
    if (sourceValue === undefined) continue;
    comparable = true;
    if (sourceValue !== value) return "mismatch";
  }
  return comparable ? "match" : "none";
}

function changeRequestMatchesRevision(
  node: DirectiveNode,
  revision: DocxReviewRevision,
  index: SourceIndex,
): boolean {
  const source = sourceChangeRequestRevision(node);
  if (!source || source.action !== revision.action) return false;
  if (!sourceReviewTextMatches(source.oldText ?? "", revision.oldText ?? "", index)) return false;
  if (!sourceReviewTextMatches(source.newText ?? "", revision.newText ?? "", index)) return false;
  return true;
}

function changeRequestTextIdentityMatches(node: DirectiveNode, revision: DocxReviewRevision): boolean {
  const source = sourceChangeRequestRevision(node);
  if (!source || source.action !== revision.action) return false;
  if (sourceMarkupText(source.oldText ?? "") !== sourceMarkupText(revision.oldText ?? "")) return false;
  if (sourceMarkupText(source.newText ?? "") !== sourceMarkupText(revision.newText ?? "")) return false;
  return true;
}

function sourceChangeRequestRevision(node: DirectiveNode): { action: "insert" | "delete" | "replace"; oldText?: string; newText?: string } | undefined {
  const action = changeRequestAction(node);
  if (!action) return undefined;
  const body = directiveBody(node);
  const text = stringAttr(node, "text");
  const from = stringAttr(node, "from") ?? (action === "delete" ? text : undefined);
  const to = stringAttr(node, "to") ?? (action === "insert" ? text : undefined);
  if (action === "replace") {
    if (!from || !to) return undefined;
    return { action, oldText: from, newText: to };
  }
  if (action === "insert") {
    const newText = to ?? body;
    return newText ? { action, newText } : undefined;
  }
  const oldText = from ?? body;
  return oldText ? { action, oldText } : undefined;
}

function changeRequestExportsNativeRevision(node: DirectiveNode): boolean {
  return !changeRequestClosed(node) && sourceChangeRequestRevision(node) !== undefined;
}

function changeRequestTarget(node: DirectiveNode): string | undefined {
  return stringAttr(node, "target") ?? stringAttr(node, "for") ?? stringAttr(node, "parent") ?? stringAttr(node, "block") ?? stringAttr(node, "ref");
}

function changeRequestAction(node: DirectiveNode): "insert" | "delete" | "replace" | undefined {
  const action = (stringAttr(node, "action") ?? stringAttr(node, "type"))?.toLowerCase();
  return action === "insert" || action === "delete" || action === "replace" ? action : undefined;
}

function changeRequestActionKey(node: DirectiveNode): string {
  return node.attrs.action !== undefined ? "action" : node.attrs.type !== undefined ? "type" : "action";
}

function changeRequestAuthor(node: DirectiveNode): string | undefined {
  return stringAttr(node, "author") ?? stringAttr(node, "reviewer");
}

function changeRequestAuthorKey(node: DirectiveNode): string {
  return node.attrs.reviewer !== undefined ? "reviewer" : "author";
}

function changeRequestHasAuthorAttr(node: DirectiveNode): boolean {
  return node.attrs.author !== undefined || node.attrs.reviewer !== undefined;
}

function changeRequestDate(node: DirectiveNode): string | undefined {
  return stringAttr(node, "date") ?? stringAttr(node, "at");
}

function changeRequestDateKey(node: DirectiveNode): string {
  return node.attrs.at !== undefined ? "at" : "date";
}

function changeRequestHasDateAttr(node: DirectiveNode): boolean {
  return node.attrs.date !== undefined || node.attrs.at !== undefined;
}

function updateChangeRequestSingleText(
  node: DirectiveNode,
  ops: PatchOp[],
  action: "insert" | "delete",
  value: string,
  index: SourceIndex,
): void {
  const primaryKey = action === "insert" ? "to" : "from";
  if (node.attrs[primaryKey] !== undefined) {
    updateReviewAttrIfChanged(node, ops, primaryKey, value, index);
    return;
  }
  if (node.attrs.text !== undefined) {
    updateReviewAttrIfChanged(node, ops, "text", value, index);
    return;
  }
  if (!sourceReviewTextMatches(directiveBody(node), value, index)) ops.push({ op: "replace_body", id: node.id!, content: value });
}

function updateAttrIfChanged(node: DirectiveNode, ops: PatchOp[], key: string, value: string): void {
  if (node.id && stringAttr(node, key) !== value) ops.push({ op: "update_attribute", id: node.id, key, value });
}

function updateReviewAttrIfChanged(
  node: DirectiveNode,
  ops: PatchOp[],
  key: string,
  value: string,
  index: SourceIndex,
): void {
  if (node.id && !sourceReviewTextMatches(stringAttr(node, key) ?? "", value, index)) {
    ops.push({ op: "update_attribute", id: node.id, key, value });
  }
}

function changeRequestClosed(node: DirectiveNode): boolean {
  const status = stringAttr(node, "status")?.toLowerCase();
  return status === "deleted" || status === "withdrawn";
}

function findExactTargetedNote(
  index: SourceIndex,
  kind: "footnote" | "endnote",
  targetId: string,
  body: string,
  matchedIds: Set<string>,
): string | undefined {
  const matches = targetedNoteCandidates(index, kind, targetId, matchedIds).filter((node) =>
    sourceReviewIdentityMatches(node, body, index) || noteBodyIsGeneratedFallback(kind, node, body),
  );
  return matches.length === 1 ? matches[0]?.id : undefined;
}

function targetedNoteCandidates(
  index: SourceIndex,
  kind: "footnote" | "endnote",
  targetId: string,
  matchedIds: Set<string>,
): DirectiveNode[] {
  const out: DirectiveNode[] = [];
  for (const node of index.nodesById.values()) {
    if (!isNoteDirective(node, kind) || !node.id) continue;
    if (matchedIds.has(node.id) || noteClosed(node)) continue;
    if (referencesEqual(index, noteTarget(node), targetId)) out.push(node);
  }
  return out;
}

function noteTarget(node: DirectiveNode): string | undefined {
  return stringAttr(node, "for") ?? stringAttr(node, "parent") ?? stringAttr(node, "target") ?? stringAttr(node, "block") ?? stringAttr(node, "ref");
}

function noteClosed(node: DirectiveNode): boolean {
  const status = stringAttr(node, "status")?.toLowerCase();
  return status === "deleted" || status === "withdrawn";
}

function noteBodyIsGeneratedFallback(kind: "footnote" | "endnote", node: DirectiveNode, reviewedBody: string): boolean {
  return !directiveBody(node).trim() && reviewedBody.trim() === noteGeneratedFallback(kind);
}

function noteGeneratedFallback(kind: "footnote" | "endnote"): string {
  return kind === "footnote" ? "Footnote" : "Endnote";
}

function directiveBody(node: DirectiveNode): string {
  return node.body?.replace(/\n+$/, "") ?? "";
}

function sourceBodyText(node: DirectiveNode): string {
  return sourceMarkupText(directiveBody(node));
}

function sourceReviewBodyMatches(
  node: DirectiveNode,
  reviewedBody: string,
  index?: SourceIndex,
): boolean {
  return sourceReviewTextMatches(directiveBody(node), reviewedBody, index);
}

function sourceReviewTextMatches(
  sourceText: string,
  reviewedText: string,
  index?: SourceIndex,
): boolean {
  if (sourceText === reviewedText) return true;
  if (equivalentReviewMarkdown(sourceText, reviewedText, index)) return true;
  if (canonicalReviewTextEscapes(sourceText) === canonicalReviewTextEscapes(reviewedText)) return true;
  return false;
}

function hasSourceMarkup(text: string): boolean {
  return /`[^`]+`|\*\*[^*]+\*\*|\*[^*\n]+\*|\b_[^_\n]+_\b|\[((?:\\.|[^\]\\])+)\]\([^)]+\)|\[\[[a-zA-Z_][\w\-./:]*\]\]/.test(text);
}

function equivalentReviewMarkdown(sourceText: string, reviewedText: string, index?: SourceIndex): boolean {
  if (!hasSourceMarkup(sourceText) || !hasSourceMarkup(reviewedText)) return false;
  return canonicalReviewMarkdown(sourceText, index) === canonicalReviewMarkdown(reviewedText, index);
}

function canonicalReviewMarkdown(text: string, index?: SourceIndex): string {
  let canonical = text
    .replace(/\r\n?/g, "\n")
    .replace(/\b_([^_\n]+)_\b/g, "*$1*")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n[ \t]+/g, "\n");
  canonical = canonicalizeReviewLinks(canonical, index);
  return canonical.trimEnd();
}

function canonicalReviewTextEscapes(text: string): string {
  return unescapeMarkdownPipesOutsideCode(text.replace(/\r\n?/g, "\n")).trimEnd();
}

function unescapeMarkdownPipesOutsideCode(text: string): string {
  const codeSpans: string[] = [];
  const placeholderOpen = "\u0002";
  const placeholderClose = "\u0003";
  const withPlaceholders = text.replace(/`([^`]+)`/g, (_match, body: string) => {
    const i = codeSpans.push(body) - 1;
    return `${placeholderOpen}${i}${placeholderClose}`;
  });
  const unescaped = unescapeMarkdownTextEscapes(withPlaceholders);
  const restoreRe = new RegExp(`${placeholderOpen}(\\d+)${placeholderClose}`, "g");
  return unescaped.replace(restoreRe, (_match, indexText: string) => codeSpans[Number(indexText)] ?? "");
}

function canonicalizeReviewLinks(text: string, index?: SourceIndex): string {
  const links: string[] = [];
  const placeholderOpen = "\u0002";
  const placeholderClose = "\u0003";
  const withPlaceholders = text.replace(/\[((?:\\.|[^\]\\])+)\]\(([^)]+)\)/g, (_match, label: string, target: string) => {
    const visibleLabel = unescapeMarkdownLinkLabel(label);
    const internal = /^#([a-zA-Z_][\w\-./:]*)$/.exec(target);
    let canonical: string;
    if (internal) {
      const targetId = internal[1]!;
      const canonicalTarget = index ? (canonicalReference(index, targetId) ?? targetId) : targetId;
      const labelTarget = plainInternalReferenceLabel(visibleLabel);
      const canonicalLabel = labelTarget && index ? canonicalReference(index, labelTarget) : labelTarget;
      canonical = labelTarget && canonicalLabel === canonicalTarget
        ? `[[${canonicalTarget}]]`
        : `[${visibleLabel}](#${canonicalTarget})`;
    } else {
      canonical = `[${visibleLabel}](${target})`;
    }
    const i = links.push(canonical) - 1;
    return `${placeholderOpen}${i}${placeholderClose}`;
  });
  const withCanonicalWikilinks = withPlaceholders.replace(/\[\[([a-zA-Z_][\w\-./:]*)\]\]/g, (_match, target: string) =>
    `[[${index ? (canonicalReference(index, target) ?? target) : target}]]`,
  );
  const restoreRe = new RegExp(`${placeholderOpen}(\\d+)${placeholderClose}`, "g");
  return withCanonicalWikilinks.replace(restoreRe, (_match, indexText: string) => links[Number(indexText)] ?? "");
}

function plainInternalReferenceLabel(label: string): string | undefined {
  return /^[a-zA-Z_][\w\-./:]*$/.test(label) ? label : undefined;
}

function sourceTableRows(node: DirectiveNode): string[][] {
  return (node.body ?? "")
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => splitPipeRow(line));
}

function sourceDatasetRows(id: string, index: SourceIndex): string[][] | undefined {
  const table = index.datasets.get(id);
  if (!table) return undefined;
  const columns = datasetColumns(table);
  return [
    columns,
    ...table.rows.map((row) => columns.map((_column, columnIndex) => datasetCellText(row[columnIndex]))),
  ];
}

function tableHasHeader(node: DirectiveNode): boolean {
  return node.attrs.header === true || node.attrs.header === "true";
}

function sameRows(a: string[][], b: string[][], index?: SourceIndex): boolean {
  if (a.length !== b.length) return false;
  for (let row = 0; row < a.length; row++) {
    const left = a[row] ?? [];
    const right = b[row] ?? [];
    if (left.length !== right.length) return false;
    for (let column = 0; column < left.length; column++) {
      if (!sourceCellMatches(left[column] ?? "", right[column] ?? "", index)) return false;
    }
  }
  return true;
}

function sameRow(left: string[], right: string[], index?: SourceIndex): boolean {
  if (left.length !== right.length) return false;
  for (let i = 0; i < left.length; i++) {
    if (!sourceCellMatches(left[i] ?? "", right[i] ?? "", index)) return false;
  }
  return true;
}

function sourceCellMatches(sourceCell: string, reviewedCell: string, index?: SourceIndex): boolean {
  return sourceReviewTextMatches(sourceCell, reviewedCell, index);
}

function findInsertedRow(currentRows: string[][], nextRows: string[][], index?: SourceIndex): number | undefined {
  const candidates: number[] = [];
  for (let inserted = 0; inserted < nextRows.length; inserted++) {
    if (rowsMatchWithInsertedRow(currentRows, nextRows, inserted, index)) candidates.push(inserted);
  }
  return candidates.length === 1 ? candidates[0] : undefined;
}

function rowsMatchWithInsertedRow(currentRows: string[][], nextRows: string[][], inserted: number, index?: SourceIndex): boolean {
  for (let nextIndex = 0; nextIndex < nextRows.length; nextIndex++) {
    if (nextIndex === inserted) continue;
    const currentIndex = nextIndex < inserted ? nextIndex : nextIndex - 1;
    if (!sameRow(currentRows[currentIndex] ?? [], nextRows[nextIndex] ?? [], index)) return false;
  }
  return true;
}

function findDeletedRow(currentRows: string[][], nextRows: string[][], index?: SourceIndex): number | undefined {
  const candidates: number[] = [];
  for (let deleted = 0; deleted < currentRows.length; deleted++) {
    if (rowsMatchWithDeletedRow(currentRows, nextRows, deleted, index)) candidates.push(deleted);
  }
  return candidates.length === 1 ? candidates[0] : undefined;
}

function rowsMatchWithDeletedRow(currentRows: string[][], nextRows: string[][], deleted: number, index?: SourceIndex): boolean {
  for (let currentIndex = 0; currentIndex < currentRows.length; currentIndex++) {
    if (currentIndex === deleted) continue;
    const nextIndex = currentIndex < deleted ? currentIndex : currentIndex - 1;
    if (!sameRow(currentRows[currentIndex] ?? [], nextRows[nextIndex] ?? [], index)) return false;
  }
  return true;
}

function findInsertedColumn(currentRows: string[][], nextRows: string[][], index?: SourceIndex): number | undefined {
  const currentWidth = uniformTableWidth(currentRows);
  const nextWidth = uniformTableWidth(nextRows);
  if (currentWidth === undefined || nextWidth !== currentWidth + 1) return undefined;
  const candidates: number[] = [];
  for (let inserted = 0; inserted < nextWidth; inserted++) {
    if (rowsMatchWithInsertedColumn(currentRows, nextRows, inserted, index)) candidates.push(inserted);
  }
  return candidates.length === 1 ? candidates[0] : undefined;
}

function rowsMatchWithInsertedColumn(currentRows: string[][], nextRows: string[][], inserted: number, index?: SourceIndex): boolean {
  for (let row = 0; row < currentRows.length; row++) {
    if (!sameRow(currentRows[row] ?? [], rowWithoutColumn(nextRows[row] ?? [], inserted), index)) return false;
  }
  return true;
}

function findDeletedColumn(currentRows: string[][], nextRows: string[][], index?: SourceIndex): number | undefined {
  const currentWidth = uniformTableWidth(currentRows);
  const nextWidth = uniformTableWidth(nextRows);
  if (currentWidth === undefined || nextWidth !== currentWidth - 1 || currentWidth <= 1) return undefined;
  const candidates: number[] = [];
  for (let deleted = 0; deleted < currentWidth; deleted++) {
    if (rowsMatchWithDeletedColumn(currentRows, nextRows, deleted, index)) candidates.push(deleted);
  }
  return candidates.length === 1 ? candidates[0] : undefined;
}

function rowsMatchWithDeletedColumn(currentRows: string[][], nextRows: string[][], deleted: number, index?: SourceIndex): boolean {
  for (let row = 0; row < currentRows.length; row++) {
    if (!sameRow(rowWithoutColumn(currentRows[row] ?? [], deleted), nextRows[row] ?? [], index)) return false;
  }
  return true;
}

function uniformTableWidth(rows: string[][]): number | undefined {
  const firstWidth = rows[0]?.length;
  if (firstWidth === undefined) return undefined;
  return rows.every((row) => row.length === firstWidth) ? firstWidth : undefined;
}

function rowWithoutColumn(row: string[], column: number): string[] {
  return [...row.slice(0, column), ...row.slice(column + 1)];
}

function singleLineCells(cells: string[]): boolean {
  return cells.every(singleLineCell);
}

function singleLineCell(cell: string): boolean {
  return !/[\r\n]/.test(cell);
}

function rowsHaveMultilineCells(rows: string[][]): boolean {
  return rows.some((row) => row.some((cell) => !singleLineCell(cell)));
}

function serializeTableRows(rows: string[][]): string {
  return rows.map((row) => `| ${row.map(escapeTableCell).join(" | ")} |`).join("\n");
}

function serializeDatasetRows(node: DirectiveNode, rows: string[][]): string | undefined {
  const columns = normalizedDatasetColumns(rows[0]);
  if (!columns) return undefined;
  const dataRows = rows.slice(1);
  const format = (stringAttr(node, "format") ?? "yaml").toLowerCase();
  if (format === "csv") return serializeDelimitedDataset(columns, dataRows, ",");
  if (format === "tsv") return serializeDelimitedDataset(columns, dataRows, "\t");
  if (format === "json") return serializeJsonDataset(node, columns, dataRows);
  if (format !== "yaml") return undefined;
  return serializeYamlDataset(node, columns, dataRows);
}

function normalizedDatasetColumns(row: string[] | undefined): string[] | undefined {
  const columns = row?.map((column) => column.trim()) ?? [];
  if (columns.length === 0 || columns.some((column) => column.length === 0)) return undefined;
  return new Set(columns).size === columns.length ? columns : undefined;
}

function serializeDelimitedDataset(columns: string[], dataRows: string[][], delimiter: "," | "\t"): string | undefined {
  const rows = [columns, ...dataRows];
  if (rows.some((row) => row.some(delimitedCellUnsupported))) return undefined;
  return rows.map((row) => serializeDelimitedRow(row, delimiter)).join("\n");
}

function delimitedCellUnsupported(cell: string): boolean {
  return /[\r\n]/.test(cell);
}

function serializeJsonDataset(node: DirectiveNode, columns: string[], dataRows: string[][]): string | undefined {
  const parsed = parseJsonSource(node);
  if (parsed === undefined) return undefined;
  const rows = dataRows.map((row) => columns.map((_column, columnIndex) => coerceDatasetScalar(row[columnIndex] ?? "")));
  if (Array.isArray(parsed) && firstJsonRowIsRecord(parsed)) {
    return JSON.stringify(rows.map((row) => datasetRecord(columns, row)), null, 2);
  }
  return JSON.stringify({ columns, rows }, null, 2);
}

function serializeYamlDataset(node: DirectiveNode, columns: string[], dataRows: string[][]): string | undefined {
  const parsed = parseYamlSource(node);
  if (!parsed) return undefined;
  const existingSchema = recordValue(parsed.schema);
  const schema = datasetSchema(columns, dataRows, existingSchema);
  const body = {
    schema,
    rows: dataRows.map((row) => columns.map((column, columnIndex) => coerceDatasetValue(row[columnIndex] ?? "", schema[column]))),
  };
  return yaml.dump(body, { flowLevel: 2, lineWidth: -1, noRefs: true, sortKeys: false }).trimEnd();
}

function datasetColumns(table: DatasetTable): string[] {
  const width = Math.max(table.columns.length, ...table.rows.map((row) => row.length), 1);
  const columns = table.columns.length > 0 ? [...table.columns] : [];
  while (columns.length < width) columns.push(`Column ${columns.length + 1}`);
  return columns.slice(0, width).map(String);
}

function datasetCellText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

function parseJsonSource(node: DirectiveNode): unknown | undefined {
  try {
    return JSON.parse(node.body ?? "");
  } catch {
    return undefined;
  }
}

function parseYamlSource(node: DirectiveNode): Record<string, unknown> | undefined {
  let parsed: unknown;
  try {
    parsed = yaml.load(node.body ?? "");
  } catch {
    return undefined;
  }
  return recordValue(parsed);
}

function firstJsonRowIsRecord(rows: unknown[]): boolean {
  const first = rows[0];
  return Boolean(first && typeof first === "object" && !Array.isArray(first));
}

function datasetRecord(columns: string[], row: unknown[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  columns.forEach((column, index) => {
    out[column] = row[index] ?? null;
  });
  return out;
}

function datasetSchema(
  columns: string[],
  rows: string[][],
  existingSchema: Record<string, unknown> | undefined,
): Record<string, unknown> {
  const schema: Record<string, unknown> = {};
  columns.forEach((column, columnIndex) => {
    schema[column] = existingSchema?.[column] ?? inferDatasetType(rows.map((row) => row[columnIndex] ?? ""));
  });
  return schema;
}

function inferDatasetType(values: string[]): "boolean" | "number" | "string" {
  const present = values.map((value) => value.trim()).filter(Boolean);
  if (present.length === 0) return "string";
  if (present.every((value) => Number.isFinite(Number(value)))) return "number";
  if (present.every((value) => booleanText(value) !== undefined)) return "boolean";
  return "string";
}

function coerceDatasetValue(value: string, schemaValue: unknown): unknown {
  const type = schemaType(schemaValue);
  if (type === "number" || type === "integer") {
    if (!value.trim()) return null;
    const number = Number(value);
    return Number.isFinite(number) ? number : value;
  }
  if (type === "boolean") {
    if (!value.trim()) return null;
    return booleanText(value) ?? value;
  }
  return type ? value : coerceDatasetScalar(value);
}

function coerceDatasetScalar(value: string): unknown {
  const trimmed = value.trim();
  if (!trimmed) return value;
  const boolean = booleanText(trimmed);
  if (boolean !== undefined) return boolean;
  const number = Number(trimmed);
  if (Number.isFinite(number) && /^-?\d/.test(trimmed)) return number;
  return value;
}

function schemaType(schemaValue: unknown): string | undefined {
  if (typeof schemaValue === "string") return schemaValue.toLowerCase();
  const record = recordValue(schemaValue);
  const type = record?.type;
  return typeof type === "string" ? type.toLowerCase() : undefined;
}

function booleanText(value: string): boolean | undefined {
  const normalized = value.trim().toLowerCase();
  if (normalized === "true" || normalized === "yes" || normalized === "1") return true;
  if (normalized === "false" || normalized === "no" || normalized === "0") return false;
  return undefined;
}

function recordValue(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}

function escapeTableCell(cell: string): string {
  return escapePipeTableCell(cell.replace(/\r?\n/g, " "));
}

function sourceMarkupText(text: string): string {
  const codeSpans: string[] = [];
  const placeholderOpen = "\u0002";
  const placeholderClose = "\u0003";
  const withCodePlaceholders = text.replace(/`([^`]+)`/g, (_match, body: string) => {
    const i = codeSpans.push(body) - 1;
    return `${placeholderOpen}${i}${placeholderClose}`;
  });
  const withoutMarkup = withCodePlaceholders
    .replace(/\[((?:\\.|[^\]\\])+)\]\([^)]+\)/g, (_match, label: string) => unescapeMarkdownLinkLabel(label))
    .replace(/\[\[([a-zA-Z_][\w\-./:]*)\]\]/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/\b_([^_]+)_\b/g, "$1");
  const unescaped = unescapeMarkdownTextEscapes(withoutMarkup);
  const restoreRe = new RegExp(`${placeholderOpen}(\\d+)${placeholderClose}`, "g");
  return unescaped.replace(restoreRe, (_match, indexText: string) => codeSpans[Number(indexText)] ?? "");
}

function stringAttr(node: DirectiveNode, key: string): string | undefined {
  const value = node.attrs[key];
  return typeof value === "string" ? value : undefined;
}

function uniqueCommentId(base: string, used: Set<string>): string {
  const stem = sanitizeId(base) || "comment";
  let id = stem;
  let i = 2;
  while (used.has(id)) id = `${stem}-${i++}`;
  used.add(id);
  return id;
}

function sanitizeId(value: string): string {
  const clean = value.toLowerCase().replace(/[^a-z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "");
  return /^[a-z_]/.test(clean) ? clean : `comment-${clean}`;
}

function uniqueBookmarkName(id: string, used: Set<string>): string {
  const hash = crc32(Buffer.from(id, "utf8")).toString(16).padStart(8, "0");
  const clean = id.replace(/[^A-Za-z0-9_]/g, "_").replace(/^[^A-Za-z]+/, "");
  const stem = (clean || "id").slice(0, 28);
  let name = `n_${stem}_${hash}`.slice(0, 40);
  let i = 1;
  while (used.has(name)) {
    const suffix = `_${i++}`;
    name = `${`n_${stem}_${hash}`.slice(0, 40 - suffix.length)}${suffix}`;
  }
  used.add(name);
  return name;
}

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of buffer) {
    crc ^= byte;
    for (let i = 0; i < 8; i++) {
      crc = (crc >>> 1) ^ (0xedb88320 & -(crc & 1));
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}
