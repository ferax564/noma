import { decodeXml, parseXmlAttrs, readDocxZipEntries } from "./docx-control-data.js";

export interface DocxReviewComment {
  nativeId: string;
  anchorBookmarkNames?: string[];
  author?: string;
  initials?: string;
  date?: string;
  status?: "resolved";
  resolvedBy?: string;
  resolvedAt?: string;
  replyTo?: string;
  hasRevisions?: boolean;
  body: string;
}

export interface DocxReviewRevision {
  nativeId: string;
  action: "insert" | "delete" | "replace";
  anchorBookmarkNames?: string[];
  sourceBookmarkNames?: string[];
  targetId?: string;
  author?: string;
  date?: string;
  oldText?: string;
  newText?: string;
}

export interface DocxReviewNote {
  nativeId: string;
  anchorBookmarkNames?: string[];
  hasRevisions?: boolean;
  body: string;
}

export interface DocxReviewTable {
  nativeId: string;
  anchorBookmarkNames?: string[];
  header?: boolean;
  hasRevisions?: boolean;
  rows: string[][];
}

export interface DocxReviewHeading {
  nativeId: string;
  anchorBookmarkNames?: string[];
  hasRevisions?: boolean;
  level: number;
  title: string;
}

export interface DocxReviewCaption {
  nativeId: string;
  anchorBookmarkNames?: string[];
  hasRevisions?: boolean;
  kind: "figure" | "table" | "plot";
  title: string;
}

export interface DocxReviewBlockLabel {
  nativeId: string;
  anchorBookmarkNames?: string[];
  hasRevisions?: boolean;
  kind: "metric" | "computed_metric" | "control" | "button" | "export_button" | "block_title";
  title: string;
}

export interface DocxReviewBlockBody {
  nativeId: string;
  anchorBookmarkNames?: string[];
  hasRevisions?: boolean;
  mode?: "prose" | "code";
  body: string;
}

export interface DocxReviewMetricValue {
  nativeId: string;
  anchorBookmarkNames?: string[];
  hasRevisions?: boolean;
  value: string;
}

export interface DocxReviewMetricMetadata {
  nativeId: string;
  anchorBookmarkNames?: string[];
  hasRevisions?: boolean;
  fields: Record<string, string>;
}

export interface DocxReviewBlockMetadata {
  nativeId: string;
  anchorBookmarkNames?: string[];
  hasRevisions?: boolean;
  fields: Record<string, string>;
}

export interface DocxReviewData {
  comments: DocxReviewComment[];
  revisions: DocxReviewRevision[];
  footnotes: DocxReviewNote[];
  endnotes: DocxReviewNote[];
  tables: DocxReviewTable[];
  headings: DocxReviewHeading[];
  captions?: DocxReviewCaption[];
  labels?: DocxReviewBlockLabel[];
  blockBodies?: DocxReviewBlockBody[];
  metricValues?: DocxReviewMetricValue[];
  metricMetadata?: DocxReviewMetricMetadata[];
  blockMetadata?: DocxReviewBlockMetadata[];
}

interface ParsedComment {
  nativeId: string;
  author?: string;
  initials?: string;
  date?: string;
  paraId?: string;
  parentParaId?: string;
  done?: boolean;
  hasRevisions?: boolean;
  paragraphs: string[];
}

interface ParsedParagraph {
  paraId?: string;
  text: string;
  markdown: string;
}

interface CommentExtended {
  done?: boolean;
  parentParaId?: string;
}

interface WordReviewStoryPart {
  name: string;
  xml: string;
  relationships: Map<string, string>;
}

interface TextExtractionOptions {
  includeDeletedText?: boolean;
  ignoreBold?: boolean;
}

type MarkdownRunStyle = "bold" | "italic" | "boldItalic" | "code";
interface MetadataFieldMatch {
  label: string;
  index: number;
}

interface MarkdownPart {
  text: string;
  style?: MarkdownRunStyle;
}

interface VisibleMarkdownPart extends MarkdownPart {
  visibleText: string;
}

const METRIC_METADATA_FIELD_LABELS = ["status", "trend", "change", "target", "source", "as of"];

export function extractDocxReviewData(buffer: Buffer): DocxReviewData {
  const entries = readDocxZipEntries(buffer);
  const storyParts = wordReviewStoryParts(entries);
  const commentsXml = entries.get("word/comments.xml")?.toString("utf8");
  const anchorBookmarkNames = mergeBookmarkMaps(storyParts.map((part) => parseDocumentCommentAnchors(part.xml)));
  const footnoteAnchors = mergeBookmarkMaps(storyParts.map((part) => parseDocumentNoteAnchors(part.xml, "footnote")));
  const endnoteAnchors = mergeBookmarkMaps(storyParts.map((part) => parseDocumentNoteAnchors(part.xml, "endnote")));
  const extended = parseCommentsExtended(entries.get("word/commentsExtended.xml")?.toString("utf8") ?? "");
  const commentsRelationships = parseRelationships(entries.get("word/_rels/comments.xml.rels")?.toString("utf8") ?? "");
  const footnoteRelationships = parseRelationships(entries.get("word/_rels/footnotes.xml.rels")?.toString("utf8") ?? "");
  const endnoteRelationships = parseRelationships(entries.get("word/_rels/endnotes.xml.rels")?.toString("utf8") ?? "");
  const parsed = commentsXml ? parseCommentsXml(commentsXml, extended, commentsRelationships) : [];
  const nativeIdByParaId = new Map<string, string>();
  for (const comment of parsed) {
    if (comment.paraId) nativeIdByParaId.set(comment.paraId, comment.nativeId);
  }
  return {
    comments: parsed.map((comment) => toReviewComment(comment, nativeIdByParaId, anchorBookmarkNames)),
    revisions: storyParts.flatMap((part) =>
      parseDocumentRevisions(part.xml, part.relationships, storyNativeIdPrefix(part.name)),
    ),
    footnotes: parseNotesXml(entries.get("word/footnotes.xml")?.toString("utf8") ?? "", "footnote", footnoteAnchors, footnoteRelationships),
    endnotes: parseNotesXml(entries.get("word/endnotes.xml")?.toString("utf8") ?? "", "endnote", endnoteAnchors, endnoteRelationships),
    tables: storyParts.flatMap((part) => parseDocumentTables(part.xml, part.relationships, storyNativeIdPrefix(part.name))),
    headings: storyParts.flatMap((part) =>
      parseDocumentHeadings(part.xml, part.relationships, storyNativeIdPrefix(part.name)),
    ),
    captions: storyParts.flatMap((part) =>
      parseDocumentCaptions(part.xml, part.relationships, storyNativeIdPrefix(part.name)),
    ),
    labels: storyParts.flatMap((part) =>
      parseDocumentBlockLabels(part.xml, part.relationships, storyNativeIdPrefix(part.name)),
    ),
    blockBodies: storyParts.flatMap((part) =>
      parseDocumentBlockBodies(part.xml, part.relationships, storyNativeIdPrefix(part.name)),
    ),
    metricValues: storyParts.flatMap((part) =>
      parseDocumentMetricValues(part.xml, part.relationships, storyNativeIdPrefix(part.name)),
    ),
    metricMetadata: storyParts.flatMap((part) =>
      parseDocumentMetricMetadata(part.xml, part.relationships, storyNativeIdPrefix(part.name)),
    ),
    blockMetadata: storyParts.flatMap((part) =>
      parseDocumentBlockMetadata(part.xml, part.relationships, storyNativeIdPrefix(part.name)),
    ),
  };
}

function wordReviewStoryParts(entries: Map<string, Buffer>): WordReviewStoryPart[] {
  const names = [
    "word/document.xml",
    ...sortedWordPartNames(entries, /^word\/header\d+\.xml$/i),
    ...sortedWordPartNames(entries, /^word\/footer\d+\.xml$/i),
  ];
  return names.flatMap((name) => {
    const data = entries.get(name);
    if (!data) return [];
    return [{
      name,
      xml: data.toString("utf8"),
      relationships: parseRelationships(entries.get(wordStoryRelationshipsName(name))?.toString("utf8") ?? ""),
    }];
  });
}

function sortedWordPartNames(entries: Map<string, Buffer>, pattern: RegExp): string[] {
  return [...entries.keys()]
    .filter((name) => pattern.test(name))
    .sort((a, b) => wordPartNumber(a) - wordPartNumber(b) || a.localeCompare(b));
}

function wordPartNumber(name: string): number {
  return Number(/(\d+)\.xml$/i.exec(name)?.[1] ?? 0);
}

function wordStoryRelationshipsName(name: string): string {
  if (name === "word/document.xml") return "word/_rels/document.xml.rels";
  return name.replace(/^word\//, "word/_rels/") + ".rels";
}

function storyNativeIdPrefix(name: string): string {
  return name === "word/document.xml" ? "" : `${name}:`;
}

function mergeBookmarkMaps(maps: Map<string, string[]>[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  for (const map of maps) {
    for (const [id, bookmarks] of map) {
      const merged = out.get(id) ?? [];
      for (const bookmark of bookmarks) {
        if (!merged.includes(bookmark)) merged.push(bookmark);
      }
      out.set(id, merged);
    }
  }
  return out;
}

function parseDocumentHeadings(
  xml: string,
  relationships: Map<string, string>,
  nativeIdPrefix = "",
): DocxReviewHeading[] {
  const out: DocxReviewHeading[] = [];
  const blockRe = /<([\w.-]+:)?p\b[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?p>/g;
  for (const match of xml.matchAll(blockRe)) {
    const body = match[2] ?? "";
    const style = /<([\w.-]+:)?pStyle\b[^>]*\b(?:[\w.-]+:)?val="Heading([1-6])"/.exec(body);
    if (!style) continue;
    const title = paragraphReviewText(body, relationships);
    if (!title) continue;
    const bookmarks = paragraphBookmarkNames(body);
    const hasRevisions = /<([\w.-]+:)?(ins|del|moveFrom|moveTo|moveFromRangeStart|moveToRangeStart)\b/.test(body);
    out.push({
      nativeId: `${nativeIdPrefix}${out.length}`,
      ...(bookmarks.length > 0 ? { anchorBookmarkNames: bookmarks } : {}),
      ...(hasRevisions ? { hasRevisions: true } : {}),
      level: Number(style[2]),
      title,
    });
  }
  return out;
}

function parseDocumentCaptions(
  xml: string,
  relationships: Map<string, string>,
  nativeIdPrefix = "",
): DocxReviewCaption[] {
  const out: DocxReviewCaption[] = [];
  const blockRe = /<([\w.-]+:)?p\b[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?p>/g;
  for (const match of xml.matchAll(blockRe)) {
    const body = match[2] ?? "";
    if (paragraphStyle(body) !== "NomaCaption") continue;
    const caption = parseCaptionText(paragraphReviewText(body, relationships));
    if (!caption) continue;
    const bookmarks = paragraphBookmarkNames(body);
    const hasRevisions = /<([\w.-]+:)?(ins|del|moveFrom|moveTo|moveFromRangeStart|moveToRangeStart)\b/.test(body);
    out.push({
      nativeId: `${nativeIdPrefix}${out.length}`,
      ...(bookmarks.length > 0 ? { anchorBookmarkNames: bookmarks } : {}),
      ...(hasRevisions ? { hasRevisions: true } : {}),
      ...caption,
    });
  }
  return out;
}

function parseCaptionText(text: string): Pick<DocxReviewCaption, "kind" | "title"> | undefined {
  const match = /^(Figure|Table|Plot|Computed plot)\s+\d+\s*:\s*([\s\S]+)$/i.exec(text.trim());
  if (!match) return undefined;
  const title = match[2]?.trim() ?? "";
  if (!title) return undefined;
  const label = (match[1] ?? "").toLowerCase();
  if (label === "figure") return { kind: "figure", title };
  if (label === "table") return { kind: "table", title };
  return { kind: "plot", title };
}

function parseDocumentBlockLabels(
  xml: string,
  relationships: Map<string, string>,
  nativeIdPrefix = "",
): DocxReviewBlockLabel[] {
  const out: DocxReviewBlockLabel[] = [];
  const blockRe = /<([\w.-]+:)?p\b[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?p>/g;
  for (const match of xml.matchAll(blockRe)) {
    const body = match[2] ?? "";
    const style = paragraphStyle(body);
    if (style !== "NomaDirective" && style !== "NomaAction") continue;
    const labelBody = style === "NomaAction" ? stripContentControls(body) : body;
    const text = style === "NomaAction"
      ? paragraphActionText(labelBody, relationships)
      : paragraphReviewText(labelBody, relationships);
    const label = parseBlockLabelText(text) ??
      (style === "NomaAction" && text ? { kind: "button" as const, title: text } : undefined) ??
      (style === "NomaDirective" && text ? { kind: "block_title" as const, title: text } : undefined);
    if (!label) continue;
    const bookmarks = paragraphBookmarkNames(body);
    const hasRevisions = /<([\w.-]+:)?(ins|del|moveFrom|moveTo|moveFromRangeStart|moveToRangeStart)\b/.test(body);
    out.push({
      nativeId: `${nativeIdPrefix}${out.length}`,
      ...(bookmarks.length > 0 ? { anchorBookmarkNames: bookmarks } : {}),
      ...(hasRevisions ? { hasRevisions: true } : {}),
      ...label,
    });
  }
  return out;
}

function parseBlockLabelText(text: string): Pick<DocxReviewBlockLabel, "kind" | "title"> | undefined {
  const trimmed = text.trim();
  const exportMatch = /^Export action\s*:\s*([\s\S]+?)(?:\s+·\s+target\s*:\s*[\s\S]+)?$/i.exec(trimmed);
  if (exportMatch) {
    const title = exportMatch[1]?.trim() ?? "";
    return title ? { kind: "export_button", title } : undefined;
  }
  const match = /^(Metric|Computed metric|Control)\s*:\s*([\s\S]+)$/i.exec(trimmed);
  if (!match) return undefined;
  const title = match[2]?.trim() ?? "";
  if (!title) return undefined;
  const label = (match[1] ?? "").toLowerCase();
  if (label === "metric") return { kind: "metric", title };
  if (label === "control") return { kind: "control", title };
  return { kind: "computed_metric", title };
}

interface PendingBlockBody {
  anchorBookmarkNames: string[];
  paragraphs: string[];
  mode: "prose" | "code";
  separator: "\n" | "\n\n";
  hasRevisions: boolean;
}

function parseDocumentBlockBodies(
  xml: string,
  relationships: Map<string, string>,
  nativeIdPrefix = "",
): DocxReviewBlockBody[] {
  return parseDocumentBlockBodiesWithIndex(xml, relationships, nativeIdPrefix, { value: 0 });
}

function parseDocumentBlockBodiesWithIndex(
  xml: string,
  relationships: Map<string, string>,
  nativeIdPrefix: string,
  nativeIndex: { value: number },
): DocxReviewBlockBody[] {
  const out: DocxReviewBlockBody[] = [];
  let pending: PendingBlockBody | undefined;
  const flush = () => {
    if (!pending || pending.paragraphs.length === 0) {
      pending = undefined;
      return;
    }
    out.push({
      nativeId: `${nativeIdPrefix}${nativeIndex.value}`,
      anchorBookmarkNames: pending.anchorBookmarkNames,
      ...(pending.hasRevisions ? { hasRevisions: true } : {}),
      mode: pending.mode,
      body: pending.paragraphs.join(pending.separator),
    });
    nativeIndex.value++;
    pending = undefined;
  };

  for (const block of xmlBlocks(xml)) {
    if (block.kind === "tbl") {
      flush();
      if (tableStyle(block.xml) === "NomaLayout") {
        for (const cellXml of tableCellBodies(block.xml)) {
          out.push(...parseDocumentBlockBodiesWithIndex(cellXml, relationships, nativeIdPrefix, nativeIndex));
        }
      }
      continue;
    }

    const body = block.body;
    const style = paragraphStyle(body);
    const bookmarks = paragraphBookmarkNames(body);
    if (style === "NomaDirective") {
      flush();
      const text = paragraphText(body).trim() || paragraphMarkdown(body, relationships).trim();
      const label = parseBlockLabelText(text);
      const mode = blockBodyModeFromLabelText(text);
      pending = bookmarks.length > 0 && label?.kind !== "metric" && label?.kind !== "computed_metric" && label?.kind !== "control"
        ? { anchorBookmarkNames: bookmarks, paragraphs: [], mode, separator: "\n\n", hasRevisions: false }
        : undefined;
      continue;
    }
    if (!pending) continue;
    if (style === "NomaMeta" || style === "NomaCaption") continue;
    const text = style === "NomaCode"
      ? paragraphText(body)
      : (paragraphMarkdown(body, relationships).trim() || paragraphText(body).trim());
    if (!paragraphHasFrame(body)) {
      if (text) flush();
      continue;
    }
    if (style === "NomaCode") {
      pending.mode = "code";
      pending.separator = "\n";
    } else if (style && style !== "NomaQuote") {
      continue;
    }
    if (!text && style !== "NomaCode") continue;
    pending.paragraphs.push(text);
    pending.hasRevisions ||= /<([\w.-]+:)?(ins|del|moveFrom|moveTo|moveFromRangeStart|moveToRangeStart)\b/.test(body);
  }
  flush();
  return out;
}

function blockBodyModeFromLabelText(text: string): "prose" | "code" {
  return /^(?:Code(?:\s*\([^)]+\))?|Code cell(?:\s*\([^)]+\))?|Output(?:\s*\([^)]+\))?)(?:\s*:|$)/i.test(text.trim())
    ? "code"
    : "prose";
}

function stripContentControls(xml: string): string {
  let out = "";
  let cursor = 0;
  const sdtRe = /<([\w.-]+:)?sdt\b[^>]*>/g;
  while (cursor < xml.length) {
    sdtRe.lastIndex = cursor;
    const match = sdtRe.exec(xml);
    if (!match) break;
    const end = matchingElementEnd(xml, "sdt", match.index);
    if (end === undefined) break;
    out += xml.slice(cursor, match.index);
    cursor = end;
  }
  return out + xml.slice(cursor);
}

function parseDocumentMetricValues(
  xml: string,
  relationships: Map<string, string>,
  nativeIdPrefix = "",
): DocxReviewMetricValue[] {
  return parseDocumentMetricValuesWithIndex(xml, relationships, nativeIdPrefix, { value: 0 });
}

function parseDocumentMetricValuesWithIndex(
  xml: string,
  relationships: Map<string, string>,
  nativeIdPrefix: string,
  nativeIndex: { value: number },
): DocxReviewMetricValue[] {
  const out: DocxReviewMetricValue[] = [];
  let pendingBookmarks: string[] = [];
  for (const block of xmlBlocks(xml)) {
    if (block.kind === "tbl") {
      if (tableStyle(block.xml) === "NomaLayout") {
        for (const cellXml of tableCellBodies(block.xml)) {
          out.push(...parseDocumentMetricValuesWithIndex(cellXml, relationships, nativeIdPrefix, nativeIndex));
        }
      }
      pendingBookmarks = [];
      continue;
    }
    const body = block.body;
    const plainText = paragraphText(body).trim();
    const markdownText = paragraphMarkdown(body, relationships).trim();
    const text = plainText || markdownText;
    if (paragraphStyle(body) === "NomaDirective") {
      const label = parseBlockLabelText(text);
      pendingBookmarks = label?.kind === "metric" ? paragraphBookmarkNames(body) : [];
      continue;
    }
    if (pendingBookmarks.length === 0) continue;
    if (!text) continue;
    if (!paragraphHasFrame(body) || paragraphStyle(body) === "NomaMeta") {
      pendingBookmarks = [];
      continue;
    }
    const value = markdownText || plainText;
    if (value) {
      const hasRevisions = /<([\w.-]+:)?(ins|del|moveFrom|moveTo|moveFromRangeStart|moveToRangeStart)\b/.test(body);
      out.push({
        nativeId: `${nativeIdPrefix}${nativeIndex.value}`,
        anchorBookmarkNames: pendingBookmarks,
        ...(hasRevisions ? { hasRevisions: true } : {}),
        value,
      });
      nativeIndex.value++;
    }
    pendingBookmarks = [];
  }
  return out;
}

function parseDocumentMetricMetadata(
  xml: string,
  relationships: Map<string, string>,
  nativeIdPrefix = "",
): DocxReviewMetricMetadata[] {
  return parseDocumentMetricMetadataWithIndex(xml, relationships, nativeIdPrefix, { value: 0 });
}

function parseDocumentMetricMetadataWithIndex(
  xml: string,
  relationships: Map<string, string>,
  nativeIdPrefix: string,
  nativeIndex: { value: number },
): DocxReviewMetricMetadata[] {
  const out: DocxReviewMetricMetadata[] = [];
  let metricBookmarks: string[] = [];
  for (const block of xmlBlocks(xml)) {
    if (block.kind === "tbl") {
      if (tableStyle(block.xml) === "NomaLayout") {
        for (const cellXml of tableCellBodies(block.xml)) {
          out.push(...parseDocumentMetricMetadataWithIndex(cellXml, relationships, nativeIdPrefix, nativeIndex));
        }
      }
      metricBookmarks = [];
      continue;
    }
    const body = block.body;
    const text = paragraphText(body).trim() || paragraphMarkdown(body, relationships).trim();
    if (paragraphStyle(body) === "NomaDirective") {
      const label = parseBlockLabelText(text);
      metricBookmarks = label?.kind === "metric" ? paragraphBookmarkNames(body) : [];
      continue;
    }
    if (metricBookmarks.length === 0) continue;
    if (paragraphStyle(body) !== "NomaMeta") {
      if (text && !paragraphHasFrame(body)) metricBookmarks = [];
      continue;
    }
    const fields = parseMetricMetadataText(metadataFieldParts(body, METRIC_METADATA_FIELD_LABELS));
    if (Object.keys(fields).length === 0) {
      metricBookmarks = [];
      continue;
    }
    const hasRevisions = /<([\w.-]+:)?(ins|del|moveFrom|moveTo|moveFromRangeStart|moveToRangeStart)\b/.test(body);
    out.push({
      nativeId: `${nativeIdPrefix}${nativeIndex.value}`,
      anchorBookmarkNames: metricBookmarks,
      ...(hasRevisions ? { hasRevisions: true } : {}),
      fields,
    });
    nativeIndex.value++;
    metricBookmarks = [];
  }
  return out;
}

function parseMetricMetadataText(parts: string[]): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const part of parts) {
    const match = /^(status|trend|change|target|source|as of)\s*:\s*([\s\S]*)$/i.exec(part.trim());
    if (!match) continue;
    const key = (match[1] ?? "").toLowerCase();
    const value = (match[2] ?? "").trim();
    fields[key] = value;
  }
  return fields;
}

function parseDocumentBlockMetadata(
  xml: string,
  relationships: Map<string, string>,
  nativeIdPrefix = "",
): DocxReviewBlockMetadata[] {
  return parseDocumentBlockMetadataWithIndex(xml, relationships, nativeIdPrefix, { value: 0 });
}

function parseDocumentBlockMetadataWithIndex(
  xml: string,
  relationships: Map<string, string>,
  nativeIdPrefix: string,
  nativeIndex: { value: number },
): DocxReviewBlockMetadata[] {
  const out: DocxReviewBlockMetadata[] = [];
  let pendingBookmarks: string[] = [];
  let pendingFields: Record<string, string> = {};
  let pendingHasRevisions = false;
  let pendingFieldLabels = DEFAULT_BLOCK_METADATA_FIELD_LABELS;
  const flushPending = () => {
    if (pendingBookmarks.length === 0 || Object.keys(pendingFields).length === 0) {
      pendingFields = {};
      pendingHasRevisions = false;
      pendingFieldLabels = DEFAULT_BLOCK_METADATA_FIELD_LABELS;
      return;
    }
    out.push({
      nativeId: `${nativeIdPrefix}${nativeIndex.value}`,
      anchorBookmarkNames: pendingBookmarks,
      ...(pendingHasRevisions ? { hasRevisions: true } : {}),
      fields: pendingFields,
    });
    nativeIndex.value++;
    pendingBookmarks = [];
    pendingFields = {};
    pendingHasRevisions = false;
    pendingFieldLabels = DEFAULT_BLOCK_METADATA_FIELD_LABELS;
  };
  for (const block of xmlBlocks(xml)) {
    if (block.kind === "tbl") {
      flushPending();
      if (tableStyle(block.xml) === "NomaLayout") {
        for (const cellXml of tableCellBodies(block.xml)) {
          out.push(...parseDocumentBlockMetadataWithIndex(cellXml, relationships, nativeIdPrefix, nativeIndex));
        }
      }
      pendingBookmarks = [];
      continue;
    }
    const body = block.body;
    const text = paragraphText(body).trim() || paragraphMarkdown(body, relationships).trim();
    const style = paragraphStyle(body);
    if (style === "NomaDirective" || style === "NomaCaption" || style === "NomaAction") {
      flushPending();
      const fieldLabels = blockMetadataFieldLabelsForLabel(text);
      pendingBookmarks = fieldLabels ? paragraphBookmarkNames(body) : [];
      pendingFieldLabels = fieldLabels ?? DEFAULT_BLOCK_METADATA_FIELD_LABELS;
      continue;
    }
    if (pendingBookmarks.length === 0) continue;
    if (paragraphStyle(body) !== "NomaMeta") {
      if (Object.keys(pendingFields).length > 0) flushPending();
      if (text && !paragraphHasFrame(body)) {
        pendingBookmarks = [];
        pendingFields = {};
        pendingHasRevisions = false;
        pendingFieldLabels = DEFAULT_BLOCK_METADATA_FIELD_LABELS;
      }
      continue;
    }
    const fields = parseBlockMetadataText(metadataFieldParts(body, pendingFieldLabels));
    if (Object.keys(fields).length === 0) {
      if (Object.keys(pendingFields).length > 0) flushPending();
      else pendingBookmarks = [];
      continue;
    }
    const hasRevisions = /<([\w.-]+:)?(ins|del|moveFrom|moveTo|moveFromRangeStart|moveToRangeStart)\b/.test(body);
    pendingFields = { ...pendingFields, ...fields };
    pendingHasRevisions = pendingHasRevisions || hasRevisions;
  }
  flushPending();
  return out;
}

function blockMetadataLabelIsSupported(text: string): boolean {
  return blockMetadataFieldLabelsForLabel(text) !== undefined;
}

const DEFAULT_BLOCK_METADATA_FIELD_LABELS = ["source", "accessed", "url", "doi", "status", "owner", "date", "due"];

function blockMetadataFieldLabelsForLabel(text: string): string[] | undefined {
  const trimmed = text.trim();
  if (/^Citation(?:\s*:.*)?$/i.test(trimmed)) return ["source", "accessed", "url", "doi"];
  if (/^API(?:\s*:.*)?$/i.test(trimmed)) return ["version", "base url", "status", "owner"];
  if (/^Endpoint(?:\s*:.*)?$/i.test(trimmed)) return ["method", "path", "auth", "status", "api"];
  if (/^Parameter(?:\s*:.*)?$/i.test(trimmed)) return ["in", "type", "required", "default", "enum"];
  if (/^Example(?:\s*:.*)?$/i.test(trimmed)) return ["language", "for", "status"];
  if (/^Changelog(?:\s*:.*)?$/i.test(trimmed)) return ["version", "date", "status"];
  if (/^Instruction(?:\s*:.*)?$/i.test(trimmed)) return ["scope", "audience", "priority", "owner"];
  if (/^Query(?:\s*:.*)?$/i.test(trimmed)) return ["language", "dataset", "source", "status"];
  if (/^Code cell(?:\s+\([^)]+\))?$/i.test(trimmed)) return ["kernel", "status", "execution"];
  if (/^Output(?:\s+\([^)]+\))?$/i.test(trimmed)) return ["for", "status", "mime"];
  if (/^Computed metric(?:\s*:.*)?$/i.test(trimmed)) return ["formula", "domain", "unit"];
  if (/^Computed plot(?:\s+\d+)?(?:\s*:.*)?$/i.test(trimmed)) return ["formula", "domain", "unit"];
  if (/^Control(?:\s*:.*)?$/i.test(trimmed)) return ["type", "default", "min", "max", "step"];
  if (/^(?:User|Feedback|Project|Reference)\s+memory(?:\s*:.*)?$/i.test(trimmed) || /^Memory(?:\s*:.*)?$/i.test(trimmed)) {
    return ["type", "confidence", "last seen", "scope", "source", "valid until", "superseded by", "expired"];
  }
  if (/^(Evidence|Counterevidence)$/i.test(trimmed)) return ["for", "source", "url", "doi", "accessed"];
  if (/^Risk(?:\s+\([^)]+\))?$/i.test(trimmed)) return ["severity", "owner", "status"];
  if (/^(Decision|ADR)(?:\s+\([^)]+\))?$/i.test(trimmed)) return ["status", "owner", "date"];
  if (/^Open question$/i.test(trimmed)) return ["status", "owner", "due"];
  if (/^(Assumption|Hypothesis|Result|Limitation)$/i.test(trimmed)) return ["status", "owner", "confidence", "source"];
  if (/^Review(?:\s*:.*)?$/i.test(trimmed)) return ["status", "reviewer", "due", "date"];
  if (/^Provenance(?:\s*:.*)?$/i.test(trimmed)) return ["source", "url", "tool", "by", "commit", "at"];
  if (/^Confidence(?:\s*:.*)?$/i.test(trimmed)) return ["value", "basis", "source", "updated"];
  if (/^(Agent task|Todo)$/i.test(trimmed)) return ["scope", "owner", "due", "priority"];
  return undefined;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function parseBlockMetadataText(parts: string[]): Record<string, string> {
  const fields: Record<string, string> = {};
  for (const part of parts) {
    const match = /^([A-Za-z][A-Za-z0-9 _-]*)\s*:\s*([\s\S]*)$/.exec(part.trim());
    if (!match) continue;
    const key = (match[1] ?? "").toLowerCase();
    const value = (match[2] ?? "").trim();
    fields[key] = value;
  }
  return fields;
}

function metadataFieldParts(body: string, fieldLabels: readonly string[]): string[] {
  const split = metadataFieldPartsFromRuns(body, fieldLabels);
  if (split.hasSeparator) return split.parts;
  return splitMetadataFieldText(paragraphText(body).trim(), fieldLabels);
}

function metadataFieldPartsFromRuns(xml: string, fieldLabels: readonly string[]): { parts: string[]; hasSeparator: boolean } {
  const parts: string[] = [""];
  let sawSeparator = false;
  const currentXml = stripNonCurrentTrackedRanges(xml);
  const tokenRe = /<([\w.-]+:)?hyperlink\b[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?hyperlink>|<([\w.-]+:)?r\b[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?r>|<([\w.-]+:)?(tab|ptab|br|cr|noBreakHyphen|softHyphen|sym)\b([^>]*?)(?:\/>|>\s*<\/(?:[\w.-]+:)?\6>)/g;
  for (const match of currentXml.matchAll(tokenRe)) {
    const text = match[2] !== undefined
      ? paragraphText(match[2])
      : match[4] !== undefined
        ? paragraphText(match[4])
        : emptyRunTokenText(match[6], match[7] ?? "");
    if (isMetadataSeparatorRun(text)) {
      sawSeparator = true;
      parts.push("");
      continue;
    }
    parts[parts.length - 1] += text;
  }
  const trimmed = mergeMetadataFieldParts(parts, fieldLabels);
  return { parts: trimmed, hasSeparator: sawSeparator };
}

function isMetadataSeparatorRun(text: string): boolean {
  return text.trim() === "·";
}

function emptyRunTokenText(name: string | undefined, attrs: string): string {
  if (name === "tab" || name === "ptab") return "\t";
  if (name === "br" || name === "cr") return "\n";
  if (name === "noBreakHyphen") return "-";
  if (name === "softHyphen") return "\u00ad";
  if (name === "sym") return symbolText(attrs);
  return "";
}

function splitMetadataFieldText(text: string, fieldLabels: readonly string[]): string[] {
  const parts: string[] = [];
  const separator = /\s+·\s+/g;
  let start = 0;
  for (let match = separator.exec(text); match; match = separator.exec(text)) {
    const next = separator.lastIndex;
    if (!matchMetadataFieldLabel(text.slice(next), fieldLabels)) continue;
    parts.push(text.slice(start, match.index));
    start = next;
  }
  parts.push(text.slice(start));
  return mergeMetadataFieldParts(parts, fieldLabels);
}

function mergeMetadataFieldParts(parts: string[], fieldLabels: readonly string[]): string[] {
  const merged: string[] = [];
  let lastFieldIndex = -1;
  for (const rawPart of parts) {
    const part = rawPart.trim();
    if (!part) continue;
    const match = matchMetadataFieldLabel(part, fieldLabels);
    if (merged.length > 0 && (!match || match.index <= lastFieldIndex)) {
      merged[merged.length - 1] = `${merged[merged.length - 1]} · ${part}`;
      continue;
    }
    merged.push(part);
    lastFieldIndex = match?.index ?? -1;
  }
  return merged;
}

function matchMetadataFieldLabel(text: string, fieldLabels: readonly string[]): MetadataFieldMatch | undefined {
  const trimmed = text.trimStart();
  for (let index = 0; index < fieldLabels.length; index++) {
    const label = fieldLabels[index]!;
    const pattern = new RegExp(`^${label.trim().split(/\s+/).map(escapeRegExp).join("\\s+")}\\s*:`, "i");
    if (pattern.test(trimmed)) return { label, index };
  }
  return undefined;
}

function parseDocumentCommentAnchors(xml: string): Map<string, string[]> {
  const out = new Map<string, string[]>();
  let pending = emptyPendingBookmarkContext();
  for (const block of xmlBlocks(xml)) {
    if (block.kind === "p") {
      const body = block.body;
      const bookmarks = paragraphBookmarkNames(body);
      mapCommentAnchors(body, bookmarks.length > 0 ? bookmarks : pending.names, out);
      pending = nextPendingBookmarkContext(body, bookmarks, pending);
      continue;
    }
    const tableXml = block.xml;
    if (tableStyle(tableXml) === "NomaLayout") {
      mapCommentAnchorsInLayoutCells(tableXml, pending, out);
    } else if (pending.names.length > 0) {
      mapCommentAnchors(tableXml, pending.names, out);
    }
    pending = emptyPendingBookmarkContext();
  }
  return out;
}

function mapCommentAnchorsInParagraphs(
  xml: string,
  initialPending: PendingBookmarkContext,
  out: Map<string, string[]>,
): void {
  let pending = initialPending;
  const paragraphRe = /<([\w.-]+:)?p\b[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?p>/g;
  for (const match of xml.matchAll(paragraphRe)) {
    const body = match[2] ?? "";
    const bookmarks = paragraphBookmarkNames(body);
    mapCommentAnchors(body, bookmarks.length > 0 ? bookmarks : pending.names, out);
    pending = nextPendingBookmarkContext(body, bookmarks, pending);
  }
}

function mapCommentAnchorsInLayoutCells(
  tableXml: string,
  initialPending: PendingBookmarkContext,
  out: Map<string, string[]>,
): void {
  for (const cellXml of tableCellBodies(tableXml)) {
    let pending = initialPending;
    for (const block of xmlBlocks(cellXml)) {
      if (block.kind === "p") {
        const body = block.body;
        const bookmarks = paragraphBookmarkNames(body);
        mapCommentAnchors(body, bookmarks.length > 0 ? bookmarks : pending.names, out);
        pending = nextLayoutCellPendingBookmarkContext(body, bookmarks, pending, initialPending);
        continue;
      }
      const nestedTableXml = block.xml;
      if (tableStyle(nestedTableXml) === "NomaLayout") {
        mapCommentAnchorsInLayoutCells(nestedTableXml, pending, out);
      } else if (pending.names.length > 0) {
        mapCommentAnchors(nestedTableXml, pending.names, out);
      }
      pending = nextLayoutCellPendingAfterTable(pending, initialPending);
    }
  }
}

function mapCommentAnchors(xml: string, bookmarks: string[], out: Map<string, string[]>): void {
  if (bookmarks.length === 0) return;
  for (const match of xml.matchAll(/<([\w.-]+:)?(commentRangeStart|commentReference)\b([^>]*)\/?>/g)) {
    const id = parseXmlAttrs(match[3] ?? "").id;
    if (id && !out.has(id)) out.set(id, bookmarks);
  }
}

function parseDocumentTables(xml: string, relationships: Map<string, string>, nativeIdPrefix = ""): DocxReviewTable[] {
  return parseDocumentTablesWithIndex(xml, relationships, nativeIdPrefix, { value: 0 });
}

function parseDocumentTablesWithIndex(
  xml: string,
  relationships: Map<string, string>,
  nativeIdPrefix: string,
  nativeIndex: { value: number },
): DocxReviewTable[] {
  const out: DocxReviewTable[] = [];
  let pendingBookmarks: string[] = [];
  for (const block of xmlBlocks(xml)) {
    if (block.kind === "p") {
      const body = block.body;
      const bookmarks = paragraphBookmarkNames(body);
      if (bookmarks.length > 0) {
        pendingBookmarks = bookmarks;
      } else if (paragraphText(body).trim()) {
        pendingBookmarks = [];
      }
      continue;
    }
    const tableXml = block.xml;
    const style = tableStyle(tableXml);
    if (style === "NomaLayout") {
      for (const cellXml of tableCellBodies(tableXml)) {
        out.push(...parseDocumentTablesWithIndex(cellXml, relationships, nativeIdPrefix, nativeIndex));
      }
      pendingBookmarks = [];
      continue;
    }
    if (style !== "TableGrid" && pendingBookmarks.length === 0) {
      pendingBookmarks = [];
      continue;
    }
    const parsed = parseTableRows(tableXml, relationships);
    if (parsed.rows.length > 0) {
      const hasRevisions = parseRevisionRuns(tableXml, relationships).length > 0;
      out.push({
        nativeId: `${nativeIdPrefix}${nativeIndex.value}`,
        ...(pendingBookmarks.length > 0 ? { anchorBookmarkNames: pendingBookmarks } : {}),
        ...(parsed.header ? { header: true } : {}),
        ...(hasRevisions ? { hasRevisions: true } : {}),
        rows: parsed.rows,
      });
    }
    nativeIndex.value++;
    pendingBookmarks = [];
  }
  return out;
}

function tableStyle(xml: string): string | undefined {
  const match = /<([\w.-]+:)?tblStyle\b([^>]*)\/?>/.exec(xml);
  return match ? parseXmlAttrs(match[2] ?? "").val : undefined;
}

function paragraphBookmarkNames(xml: string): string[] {
  return Array.from(xml.matchAll(/<([\w.-]+:)?bookmarkStart\b([^>]*)\/?>/g))
    .map((match) => parseXmlAttrs(match[2] ?? "").name)
    .filter((name): name is string => Boolean(name));
}

interface PendingBookmarkContext {
  names: string[];
  keepAcrossFramedParagraphs: boolean;
}

function emptyPendingBookmarkContext(): PendingBookmarkContext {
  return { names: [], keepAcrossFramedParagraphs: false };
}

function pendingBookmarkContext(xml: string, names: string[]): PendingBookmarkContext {
  return {
    names,
    keepAcrossFramedParagraphs: paragraphStyle(xml) === "NomaDirective",
  };
}

function paragraphKeepsPendingContext(xml: string, pending: PendingBookmarkContext): boolean {
  return pending.keepAcrossFramedParagraphs && paragraphHasFrame(xml);
}

function nextPendingBookmarkContext(
  xml: string,
  bookmarks: string[],
  pending: PendingBookmarkContext,
): PendingBookmarkContext {
  if (bookmarks.length > 0) return pendingBookmarkContext(xml, bookmarks);
  if (paragraphText(xml).trim() && !paragraphKeepsPendingContext(xml, pending)) {
    return emptyPendingBookmarkContext();
  }
  return pending;
}

function nextLayoutCellPendingBookmarkContext(
  xml: string,
  bookmarks: string[],
  pending: PendingBookmarkContext,
  inherited: PendingBookmarkContext,
): PendingBookmarkContext {
  if (bookmarks.length > 0) return pendingBookmarkContext(xml, bookmarks);
  if (paragraphText(xml).trim() && !paragraphKeepsPendingContext(xml, pending)) {
    return sameBookmarkNames(pending.names, inherited.names) ? inherited : emptyPendingBookmarkContext();
  }
  return pending;
}

function nextLayoutCellPendingAfterTable(
  pending: PendingBookmarkContext,
  inherited: PendingBookmarkContext,
): PendingBookmarkContext {
  return sameBookmarkNames(pending.names, inherited.names) ? inherited : emptyPendingBookmarkContext();
}

function sameBookmarkNames(a: string[], b: string[]): boolean {
  return a.length === b.length && a.every((name, index) => name === b[index]);
}

function paragraphStyle(xml: string): string | undefined {
  const match = /<([\w.-]+:)?pStyle\b([^>]*)\/?>/.exec(xml);
  return match ? parseXmlAttrs(match[2] ?? "").val : undefined;
}

function paragraphHasFrame(xml: string): boolean {
  return /<([\w.-]+:)?(shd|pBdr)\b/.test(xml);
}

function parseTableRows(xml: string, relationships: Map<string, string>): { header: boolean; rows: string[][] } {
  const rows: string[][] = [];
  let header = false;
  for (const rowXml of tableRowBodies(xml)) {
    const headerRow = rows.length === 0 && /<([\w.-]+:)?tblHeader\b/.test(rowXml);
    header ||= headerRow;
    const cells: string[] = [];
    for (const cellXml of tableRowCellBodies(rowXml)) {
      cells.push(parseParagraphs(cellXml, relationships)
        .map(reviewParagraphText)
        .join("\n"));
    }
    rows.push(cells);
  }
  return { header, rows };
}

function tableRowBodies(tableXml: string): string[] {
  return childElementBodies(tableXml, "tr");
}

function tableRowCellBodies(rowXml: string): string[] {
  return childElementBodies(rowXml, "tc");
}

function parseDocumentNoteAnchors(xml: string, kind: "footnote" | "endnote"): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const reference = kind === "footnote" ? "footnoteReference" : "endnoteReference";
  const referenceRe = new RegExp(`<([\\w.-]+:)?${reference}\\b([^>]*)\\/?>`, "g");
  let pending = emptyPendingBookmarkContext();
  for (const block of xmlBlocks(xml)) {
    if (block.kind === "p") {
      const body = block.body;
      const bookmarks = paragraphBookmarkNames(body);
      mapNoteReferences(body, referenceRe, bookmarks.length > 0 ? bookmarks : pending.names, out);
      pending = nextPendingBookmarkContext(body, bookmarks, pending);
      continue;
    }
    const tableXml = block.xml;
    if (tableStyle(tableXml) === "NomaLayout") {
      mapNoteReferencesInLayoutCells(tableXml, referenceRe, pending, out);
    } else if (pending.names.length > 0) {
      mapNoteReferences(tableXml, referenceRe, pending.names, out);
    }
    pending = emptyPendingBookmarkContext();
  }
  return out;
}

function mapNoteReferencesInParagraphs(
  xml: string,
  referenceRe: RegExp,
  initialPending: PendingBookmarkContext,
  out: Map<string, string[]>,
): void {
  let pending = initialPending;
  const paragraphRe = /<([\w.-]+:)?p\b[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?p>/g;
  for (const match of xml.matchAll(paragraphRe)) {
    const body = match[2] ?? "";
    const bookmarks = paragraphBookmarkNames(body);
    mapNoteReferences(body, referenceRe, bookmarks.length > 0 ? bookmarks : pending.names, out);
    pending = nextPendingBookmarkContext(body, bookmarks, pending);
  }
}

function mapNoteReferencesInLayoutCells(
  tableXml: string,
  referenceRe: RegExp,
  initialPending: PendingBookmarkContext,
  out: Map<string, string[]>,
): void {
  for (const cellXml of tableCellBodies(tableXml)) {
    let pending = initialPending;
    for (const block of xmlBlocks(cellXml)) {
      if (block.kind === "p") {
        const body = block.body;
        const bookmarks = paragraphBookmarkNames(body);
        mapNoteReferences(body, referenceRe, bookmarks.length > 0 ? bookmarks : pending.names, out);
        pending = nextLayoutCellPendingBookmarkContext(body, bookmarks, pending, initialPending);
        continue;
      }
      const nestedTableXml = block.xml;
      if (tableStyle(nestedTableXml) === "NomaLayout") {
        mapNoteReferencesInLayoutCells(nestedTableXml, referenceRe, pending, out);
      } else if (pending.names.length > 0) {
        mapNoteReferences(nestedTableXml, referenceRe, pending.names, out);
      }
      pending = nextLayoutCellPendingAfterTable(pending, initialPending);
    }
  }
}

function mapNoteReferences(xml: string, referenceRe: RegExp, bookmarks: string[], out: Map<string, string[]>): void {
  if (bookmarks.length === 0) return;
  referenceRe.lastIndex = 0;
  for (const match of xml.matchAll(referenceRe)) {
    const id = parseXmlAttrs(match[2] ?? "").id;
    if (id) out.set(id, bookmarks);
  }
}

function parseCommentsExtended(xml: string): Map<string, CommentExtended> {
  const out = new Map<string, CommentExtended>();
  const re = /<([\w.-]+:)?commentEx\b([^>]*)\/?>/g;
  for (const match of xml.matchAll(re)) {
    const attrs = parseXmlAttrs(match[2] ?? "");
    const paraId = attrs.paraId;
    if (!paraId) continue;
    out.set(paraId, {
      ...(attrs.done !== undefined ? { done: booleanAttrValue(attrs.done) } : {}),
      ...(attrs.paraIdParent ? { parentParaId: attrs.paraIdParent } : {}),
    });
  }
  return out;
}

function booleanAttrValue(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return normalized === "1" || normalized === "true";
}

function parseRelationships(xml: string): Map<string, string> {
  const out = new Map<string, string>();
  const re = /<([\w.-]+:)?Relationship\b([^>]*)\/?>/g;
  for (const match of xml.matchAll(re)) {
    const attrs = parseXmlAttrs(match[2] ?? "");
    if (attrs.Id && attrs.Target) out.set(attrs.Id, attrs.Target);
  }
  return out;
}

function parseCommentsXml(
  xml: string,
  extended: Map<string, CommentExtended>,
  relationships: Map<string, string>,
): ParsedComment[] {
  const out: ParsedComment[] = [];
  const re = /<([\w.-]+:)?comment\b([^>]*)>([\s\S]*?)<\/(?:[\w.-]+:)?comment>/g;
  for (const match of xml.matchAll(re)) {
    const attrs = parseXmlAttrs(match[2] ?? "");
    const nativeId = attrs.id;
    if (!nativeId) continue;
    const paragraphs = parseParagraphs(match[3] ?? "", relationships);
    const paraId = paragraphs[0]?.paraId;
    const commentEx = paraId ? extended.get(paraId) : undefined;
    const hasRevisions = /<([\w.-]+:)?(ins|del|moveFrom|moveTo|moveFromRangeStart|moveToRangeStart)\b/.test(match[3] ?? "");
    out.push({
      nativeId,
      ...(attrs.author ? { author: attrs.author } : {}),
      ...(attrs.initials ? { initials: attrs.initials } : {}),
      ...(attrs.date ? { date: attrs.date } : {}),
      ...(paraId ? { paraId } : {}),
      ...(commentEx?.parentParaId ? { parentParaId: commentEx.parentParaId } : {}),
      ...(commentEx?.done !== undefined ? { done: commentEx.done } : {}),
      ...(hasRevisions ? { hasRevisions: true } : {}),
      paragraphs: paragraphs.map(reviewParagraphText).filter((text) => text.trim().length > 0),
    });
  }
  return out;
}

function parseNotesXml(
  xml: string,
  kind: "footnote" | "endnote",
  anchorBookmarkNames: Map<string, string[]>,
  relationships: Map<string, string>,
): DocxReviewNote[] {
  const out: DocxReviewNote[] = [];
  const noteRe = new RegExp(`<([\\w.-]+:)?${kind}\\b([^>]*)>([\\s\\S]*?)<\\/(?:[\\w.-]+:)?${kind}>`, "g");
  for (const match of xml.matchAll(noteRe)) {
    const attrs = parseXmlAttrs(match[2] ?? "");
    const nativeId = attrs.id;
    if (!nativeId || attrs.type) continue;
    const numericId = Number(nativeId);
    if (Number.isFinite(numericId) && numericId <= 0) continue;
    const body = parseParagraphs(match[3] ?? "", relationships)
      .map(reviewParagraphText)
      .filter((text) => text.trim().length > 0)
      .join("\n\n");
    if (!body.trim()) continue;
    const hasRevisions = /<([\w.-]+:)?(ins|del|moveFrom|moveTo|moveFromRangeStart|moveToRangeStart)\b/.test(match[3] ?? "");
    const anchors = anchorBookmarkNames.get(nativeId) ?? [];
    out.push({
      nativeId,
      ...(anchors.length > 0 ? { anchorBookmarkNames: anchors } : {}),
      ...(hasRevisions ? { hasRevisions: true } : {}),
      body,
    });
  }
  return out;
}

function parseDocumentRevisions(
  xml: string,
  relationships: Map<string, string>,
  nativeIdPrefix = "",
): DocxReviewRevision[] {
  const out: DocxReviewRevision[] = [];
  let pendingChangeRequest: { action: "insert" | "delete" | "replace"; targetId?: string; sourceBookmarkNames?: string[] } | undefined;
  let pending = emptyPendingBookmarkContext();
  for (const block of xmlBlocks(xml)) {
    if (block.kind === "p") {
      const body = block.body;
      const bookmarks = paragraphBookmarkNames(body);
      const revisions = parseRevisionRuns(body, relationships);
      if (revisions.length > 0) {
        out.push(...groupRevisionRuns(
          revisions,
          pendingChangeRequest,
          bookmarks.length > 0 ? bookmarks : pending.names,
          nativeIdPrefix,
        ));
        pendingChangeRequest = undefined;
        pending = nextPendingBookmarkContext(body, bookmarks, pending);
        continue;
      }
      const text = paragraphText(body).trim();
      const label = parseChangeRequestLabel(text);
      pendingChangeRequest = label
        ? { ...label, ...(bookmarks.length > 0 ? { sourceBookmarkNames: bookmarks } : {}) }
        : undefined;
      pending = nextPendingBookmarkContext(body, bookmarks, pending);
      continue;
    }
    const tableXml = block.xml;
    const tableRevisions = parseTableRevisions(
      tableXml,
      pendingChangeRequest,
      pending.names,
      relationships,
      nativeIdPrefix,
      tableStyle(tableXml) === "NomaLayout",
    );
    if (tableRevisions.length > 0) {
      out.push(...tableRevisions);
      pendingChangeRequest = undefined;
    }
    pending = emptyPendingBookmarkContext();
  }
  return out;
}

function parseTableRevisions(
  tableXml: string,
  label: { action: "insert" | "delete" | "replace"; targetId?: string; sourceBookmarkNames?: string[] } | undefined,
  inheritedBookmarks: string[],
  relationships: Map<string, string>,
  nativeIdPrefix: string,
  useNestedBookmarkContext = false,
): DocxReviewRevision[] {
  if (useNestedBookmarkContext) {
    return parseLayoutTableRevisions(tableXml, label, inheritedBookmarks, relationships, nativeIdPrefix);
  }
  const out: DocxReviewRevision[] = [];
  let pendingLabel = label;
  const paragraphRe = /<([\w.-]+:)?p\b[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?p>/g;
  for (const paragraphMatch of tableXml.matchAll(paragraphRe)) {
    const paragraph = paragraphMatch[2] ?? "";
    const revisions = parseRevisionRuns(paragraph, relationships);
    const bookmarks = paragraphBookmarkNames(paragraph);
    if (revisions.length === 0) continue;
    const anchors = bookmarks.length > 0 ? bookmarks : inheritedBookmarks;
    out.push(...groupRevisionRuns(
      revisions,
      pendingLabel,
      anchors,
      nativeIdPrefix,
    ));
    pendingLabel = undefined;
  }
  return out;
}

function parseLayoutTableRevisions(
  tableXml: string,
  label: { action: "insert" | "delete" | "replace"; targetId?: string; sourceBookmarkNames?: string[] } | undefined,
  inheritedBookmarks: string[],
  relationships: Map<string, string>,
  nativeIdPrefix: string,
): DocxReviewRevision[] {
  const out: DocxReviewRevision[] = [];
  let pendingLabel = label;
  for (const cellXml of tableCellBodies(tableXml)) {
    const inherited: PendingBookmarkContext = { names: inheritedBookmarks, keepAcrossFramedParagraphs: false };
    let pending = inherited;
    for (const block of xmlBlocks(cellXml)) {
      if (block.kind === "p") {
        const paragraph = block.body;
        const revisions = parseRevisionRuns(paragraph, relationships);
        const bookmarks = paragraphBookmarkNames(paragraph);
        if (revisions.length === 0) {
          pending = nextLayoutCellPendingBookmarkContext(paragraph, bookmarks, pending, inherited);
          continue;
        }
        out.push(...groupRevisionRuns(
          revisions,
          pendingLabel,
          bookmarks.length > 0 ? bookmarks : pending.names,
          nativeIdPrefix,
        ));
        pendingLabel = undefined;
        pending = nextLayoutCellPendingBookmarkContext(paragraph, bookmarks, pending, inherited);
        continue;
      }
      const nestedTableXml = block.xml;
      const revisions = tableStyle(nestedTableXml) === "NomaLayout"
        ? parseLayoutTableRevisions(nestedTableXml, pendingLabel, pending.names, relationships, nativeIdPrefix)
        : parseTableRevisions(nestedTableXml, pendingLabel, pending.names, relationships, nativeIdPrefix);
      if (revisions.length > 0) {
        out.push(...revisions);
        pendingLabel = undefined;
      }
      pending = nextLayoutCellPendingAfterTable(pending, inherited);
    }
  }
  return out;
}

function tableCellBodies(tableXml: string): string[] {
  const cells = childElementBodies(tableXml, "tc");
  return cells.length > 0 ? cells : [tableXml];
}

function childElementBodies(xml: string, name: string): string[] {
  const bodies: string[] = [];
  const elementRe = new RegExp(`<([\\w.-]+:)?${name}\\b[^>]*>`, "g");
  let cursor = 0;
  while (cursor < xml.length) {
    elementRe.lastIndex = cursor;
    const match = elementRe.exec(xml);
    if (!match) break;
    const end = matchingElementEnd(xml, name, match.index);
    if (end === undefined) break;
    const bodyStart = match.index + match[0].length;
    const bodyEnd = end - closingTagLength(xml, name, end);
    bodies.push(xml.slice(bodyStart, bodyEnd));
    cursor = end;
  }
  return bodies;
}

interface XmlBlock {
  kind: "p" | "tbl";
  xml: string;
  body: string;
}

function xmlBlocks(xml: string): XmlBlock[] {
  const blocks: XmlBlock[] = [];
  const startRe = /<([\w.-]+:)?(p|tbl)\b[^>]*>/g;
  let cursor = 0;
  while (cursor < xml.length) {
    startRe.lastIndex = cursor;
    const match = startRe.exec(xml);
    if (!match) break;
    const kind = match[2] as "p" | "tbl";
    const bodyStart = match.index + match[0].length;
    const end = kind === "p"
      ? nextElementEnd(xml, "p", bodyStart)
      : matchingElementEnd(xml, "tbl", match.index);
    if (end === undefined) break;
    const bodyEnd = end - closingTagLength(xml, kind, end);
    blocks.push({
      kind,
      xml: xml.slice(match.index, end),
      body: xml.slice(bodyStart, bodyEnd),
    });
    cursor = end;
  }
  return blocks;
}

function nextElementEnd(xml: string, name: string, from: number): number | undefined {
  const closeRe = new RegExp(`</(?:[\\w.-]+:)?${name}>`, "g");
  closeRe.lastIndex = from;
  const match = closeRe.exec(xml);
  return match ? match.index + match[0].length : undefined;
}

function matchingElementEnd(xml: string, name: string, start: number): number | undefined {
  const tagRe = new RegExp(`</?([\\w.-]+:)?${name}\\b[^>]*>`, "g");
  tagRe.lastIndex = start;
  let depth = 0;
  for (const match of xml.matchAll(tagRe)) {
    const tag = match[0];
    if (tag.startsWith("</")) {
      depth--;
    } else if (!tag.endsWith("/>")) {
      depth++;
    }
    if (depth === 0) return match.index + tag.length;
  }
  return undefined;
}

function closingTagLength(xml: string, name: string, end: number): number {
  const closeRe = new RegExp(`</(?:[\\w.-]+:)?${name}>$`);
  return closeRe.exec(xml.slice(0, end))?.[0].length ?? 0;
}

interface RevisionRun {
  nativeId: string;
  kind: "ins" | "del";
  author?: string;
  date?: string;
  text: string;
  separatedFromPrevious?: boolean;
}

interface PositionedRevisionRun extends RevisionRun {
  position: number;
  end: number;
}

function parseRevisionRuns(xml: string, relationships: Map<string, string>): RevisionRun[] {
  const out: PositionedRevisionRun[] = [];
  const re = /<([\w.-]+:)?(ins|del|moveFrom|moveTo)\b([^>]*)>([\s\S]*?)<\/(?:[\w.-]+:)?\2>/g;
  for (const match of xml.matchAll(re)) {
    const attrs = parseXmlAttrs(match[3] ?? "");
    const nativeId = attrs.id;
    if (!nativeId) continue;
    const revisionName = match[2];
    out.push({
      nativeId,
      kind: revisionName === "ins" || revisionName === "moveTo" ? "ins" : "del",
      ...(attrs.author ? { author: attrs.author } : {}),
      ...(attrs.date ? { date: attrs.date } : {}),
      text: revisionText(match[4] ?? "", relationships),
      position: match.index,
      end: match.index + match[0].length,
    });
  }
  out.push(...parseMoveRangeRevisionRuns(xml, relationships));
  const merged = mergeAdjacentRevisionRuns(out.sort((a, b) => a.position - b.position), xml);
  return merged.map((run, index) => {
    const previous = merged[index - 1];
    const separatedFromPrevious = previous ? revisionSeparatorHasText(xml, previous.end, run.position) : false;
    const { position: _position, end: _end, ...stripped } = run;
    return {
      ...stripped,
      ...(separatedFromPrevious ? { separatedFromPrevious: true } : {}),
    };
  });
}

function revisionText(xml: string, relationships: Map<string, string>): string {
  const options = { includeDeletedText: true };
  const markdown = paragraphMarkdown(xml, relationships, options);
  return markdown || paragraphText(xml, options);
}

function mergeAdjacentRevisionRuns(runs: PositionedRevisionRun[], xml: string): PositionedRevisionRun[] {
  const merged: PositionedRevisionRun[] = [];
  for (const run of runs) {
    const previous = merged[merged.length - 1];
    if (
      previous &&
      sameRevisionRun(previous, run) &&
      !revisionSeparatorHasText(xml, previous.end, run.position)
    ) {
      previous.text += run.text;
      previous.end = run.end;
      continue;
    }
    merged.push({ ...run });
  }
  return merged;
}

function sameRevisionRun(a: RevisionRun, b: RevisionRun): boolean {
  return a.nativeId === b.nativeId &&
    a.kind === b.kind &&
    a.author === b.author &&
    a.date === b.date;
}

function revisionSeparatorHasText(xml: string, start: number, end: number): boolean {
  if (end <= start) return false;
  return paragraphText(xml.slice(start, end), { includeDeletedText: true }).trim().length > 0;
}

function cleanRevisionText(text: string): string {
  return text.trim();
}

function parseMoveRangeRevisionRuns(xml: string, relationships: Map<string, string>): PositionedRevisionRun[] {
  return [
    ...markedRanges(xml, "moveFromRangeStart", "moveFromRangeEnd").map((range) => ({
      nativeId: range.id,
      kind: "del" as const,
      ...(range.attrs.author ? { author: range.attrs.author } : {}),
      ...(range.attrs.date ? { date: range.attrs.date } : {}),
      text: revisionText(xml.slice(range.bodyStart, range.bodyEnd), relationships),
      position: range.start,
      end: range.endEnd,
    })),
    ...markedRanges(xml, "moveToRangeStart", "moveToRangeEnd").map((range) => ({
      nativeId: range.id,
      kind: "ins" as const,
      ...(range.attrs.author ? { author: range.attrs.author } : {}),
      ...(range.attrs.date ? { date: range.attrs.date } : {}),
      text: revisionText(xml.slice(range.bodyStart, range.bodyEnd), relationships),
      position: range.start,
      end: range.endEnd,
    })),
  ];
}

function groupRevisionRuns(
  runs: RevisionRun[],
  label: { action: "insert" | "delete" | "replace"; targetId?: string; sourceBookmarkNames?: string[] } | undefined,
  anchorBookmarkNames: string[],
  nativeIdPrefix = "",
): DocxReviewRevision[] {
  const out: DocxReviewRevision[] = [];
  for (let i = 0; i < runs.length; i++) {
    const run = runs[i];
    if (!run) continue;
    const next = runs[i + 1];
    if (next && isAdjacentReplacementPair(run, next)) {
      out.push(replaceRevision(run, next, label, anchorBookmarkNames, nativeIdPrefix));
      i++;
      continue;
    }
    out.push(singleRevision(run, label, anchorBookmarkNames, nativeIdPrefix));
  }
  return out;
}

function isAdjacentReplacementPair(deleted: RevisionRun, inserted: RevisionRun): boolean {
  return deleted.kind === "del" && inserted.kind === "ins" && !inserted.separatedFromPrevious;
}

function replaceRevision(
  deleted: RevisionRun,
  inserted: RevisionRun,
  label: { action: "insert" | "delete" | "replace"; targetId?: string; sourceBookmarkNames?: string[] } | undefined,
  anchorBookmarkNames: string[],
  nativeIdPrefix: string,
): DocxReviewRevision {
  return {
    nativeId: `${nativeIdPrefix}${deleted.nativeId}/${inserted.nativeId}`,
    action: "replace",
    ...(anchorBookmarkNames.length > 0 ? { anchorBookmarkNames } : {}),
    ...(label?.sourceBookmarkNames?.length ? { sourceBookmarkNames: label.sourceBookmarkNames } : {}),
    ...(label?.targetId ? { targetId: label.targetId } : {}),
    ...(inserted.author ?? deleted.author ? { author: inserted.author ?? deleted.author } : {}),
    ...(inserted.date ?? deleted.date ? { date: inserted.date ?? deleted.date } : {}),
    oldText: cleanRevisionText(deleted.text),
    newText: cleanRevisionText(inserted.text),
  };
}

function singleRevision(
  run: RevisionRun,
  label: { action: "insert" | "delete" | "replace"; targetId?: string; sourceBookmarkNames?: string[] } | undefined,
  anchorBookmarkNames: string[],
  nativeIdPrefix: string,
): DocxReviewRevision {
  return {
    nativeId: `${nativeIdPrefix}${run.nativeId}`,
    action: run.kind === "ins" ? "insert" : "delete",
    ...(anchorBookmarkNames.length > 0 ? { anchorBookmarkNames } : {}),
    ...(label?.sourceBookmarkNames?.length ? { sourceBookmarkNames: label.sourceBookmarkNames } : {}),
    ...(label?.targetId ? { targetId: label.targetId } : {}),
    ...(run.author ? { author: run.author } : {}),
    ...(run.date ? { date: run.date } : {}),
    ...(run.kind === "ins" ? { newText: cleanRevisionText(run.text) } : { oldText: cleanRevisionText(run.text) }),
  };
}

function parseChangeRequestLabel(text: string): { action: "insert" | "delete" | "replace"; targetId?: string } | null {
  const match = /^Change request:\s+(insert|delete|replace)(?:\s+(.+?))?\s*$/.exec(text);
  if (!match) return null;
  const action = match[1] as "insert" | "delete" | "replace";
  const targetId = match[2]?.trim();
  return { action, ...(targetId ? { targetId } : {}) };
}

function parseParagraphs(xml: string, relationships = new Map<string, string>()): ParsedParagraph[] {
  const out: ParsedParagraph[] = [];
  const re = /<([\w.-]+:)?p\b([^>]*)>([\s\S]*?)<\/(?:[\w.-]+:)?p>/g;
  for (const match of xml.matchAll(re)) {
    const attrs = parseXmlAttrs(match[2] ?? "");
    const body = match[3] ?? "";
    out.push({
      ...(attrs.paraId ? { paraId: attrs.paraId } : {}),
      text: paragraphText(body),
      markdown: paragraphMarkdown(body, relationships),
    });
  }
  return out;
}

function reviewParagraphText(paragraph: ParsedParagraph): string {
  return paragraph.markdown || paragraph.text;
}

function paragraphReviewText(xml: string, relationships: Map<string, string>): string {
  const markdown = paragraphMarkdown(xml, relationships).trim();
  const text = paragraphText(xml).trim();
  if (!markdown) return text;
  if (text && markdownIsOnlyUniformStyle(markdown, text)) return text;
  return markdown;
}

function paragraphActionText(xml: string, relationships: Map<string, string>): string {
  const text = paragraphText(xml).trim();
  if (/^Export action\s*:/i.test(text)) {
    const label = exportActionLabelMarkdown(xml, relationships);
    return label ? `Export action: ${label}` : paragraphMarkdown(xml, relationships, { ignoreBold: true }).trim() || text;
  }
  const hyperlinkBody = wholeParagraphHyperlinkBody(xml);
  const sourceXml = hyperlinkBody ?? xml;
  const ignoreBold = allCurrentTextRunsBold(sourceXml);
  return paragraphMarkdown(sourceXml, relationships, { ignoreBold }).trim() || paragraphText(sourceXml).trim();
}

function exportActionLabelMarkdown(xml: string, relationships: Map<string, string>): string {
  const parts = paragraphMarkdownParts(xml, relationships);
  const visibleText = parts.map((part) => part.visibleText).join("");
  const prefix = /^\s*Export action\s*:\s*/i.exec(visibleText);
  if (!prefix) return "";
  const start = prefix[0].length;
  const target = /\s+·\s+target\s*:/i.exec(visibleText.slice(start));
  const end = target ? start + target.index : visibleText.length;
  const labelParts = stripUniformBold(sliceVisibleMarkdownParts(parts, start, end));
  return renderMarkdownParts(labelParts).trim();
}

function wholeParagraphHyperlinkBody(xml: string): string | undefined {
  const currentXml = stripNonCurrentTrackedRanges(xml);
  const hyperlinkRe = /<([\w.-]+:)?hyperlink\b[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?hyperlink>/g;
  const matches = [...currentXml.matchAll(hyperlinkRe)];
  if (matches.length !== 1) return undefined;
  const match = matches[0];
  if (!match || match.index === undefined) return undefined;
  const before = currentXml.slice(0, match.index);
  const after = currentXml.slice(match.index + match[0].length);
  if (paragraphText(before).trim() || paragraphText(after).trim()) return undefined;
  return match[2] ?? "";
}

function allCurrentTextRunsBold(xml: string): boolean {
  const currentXml = stripNonCurrentTrackedRanges(xml);
  const runRe = /<([\w.-]+:)?r\b[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?r>/g;
  let sawTextRun = false;
  for (const match of currentXml.matchAll(runRe)) {
    const runXml = match[2] ?? "";
    if (!paragraphText(runXml).trim()) continue;
    sawTextRun = true;
    if (!/<([\w.-]+:)?b\b(?![^>]*\b(?:[\w.-]+:)?val="(?:0|false)")/.test(runXml)) return false;
  }
  return sawTextRun;
}

function markdownIsOnlyUniformStyle(markdown: string, text: string): boolean {
  return markdown === `**${text}**` ||
    markdown === `*${text}*` ||
    markdown === `***${text}***` ||
    markdown === `_${text}_` ||
    markdown === `\`${text}\``;
}

function paragraphMarkdown(
  xml: string,
  relationships: Map<string, string>,
  options: TextExtractionOptions = {},
): string {
  const parts = paragraphMarkdownParts(xml, relationships, options);
  return renderMarkdownParts(parts).replace(/[ \t]+\n/g, "\n").replace(/\n[ \t]+/g, "\n");
}

function paragraphMarkdownParts(
  xml: string,
  relationships: Map<string, string>,
  options: TextExtractionOptions = {},
): VisibleMarkdownPart[] {
  const parts: VisibleMarkdownPart[] = [];
  const currentXml = replaceWordFields(options.includeDeletedText ? xml : stripNonCurrentTrackedRanges(xml));
  const tokenRe = /<([\w.-]+:)?hyperlink\b([^>]*)>([\s\S]*?)<\/(?:[\w.-]+:)?hyperlink>|<([\w.-]+:)?r\b[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?r>|<([\w.-]+:)?(tab|ptab|br|cr|noBreakHyphen|softHyphen|sym)\b([^>]*?)(?:\/>|>\s*<\/(?:[\w.-]+:)?\7>)/g;
  for (const match of currentXml.matchAll(tokenRe)) {
    if (match[3] !== undefined) {
      const attrs = parseXmlAttrs(match[2] ?? "");
      const labelText = paragraphText(match[3], options);
      const labelMarkdown = paragraphMarkdown(match[3], relationships, options) || labelText;
      const href = attrs.id ? relationships.get(attrs.id) : attrs.href;
      const anchorId = attrs.anchor ? decodeNomaBookmarkId(attrs.anchor) : undefined;
      if (href && labelMarkdown) {
        appendMarkdownPart(parts, {
          text: `[${escapeMarkdownLinkLabel(labelMarkdown)}](${escapeMarkdownLinkTarget(href)})`,
          visibleText: labelText,
        });
      } else if (anchorId && labelMarkdown === anchorId) {
        appendMarkdownPart(parts, { text: `[[${anchorId}]]`, visibleText: labelText });
      } else if (anchorId && labelMarkdown) {
        appendMarkdownPart(parts, {
          text: `[${escapeMarkdownLinkLabel(labelMarkdown)}](#${escapeMarkdownLinkTarget(anchorId)})`,
          visibleText: labelText,
        });
      } else if (attrs.anchor && isNomaId(labelText) && labelMarkdown === labelText) {
        appendMarkdownPart(parts, { text: `[[${labelText}]]`, visibleText: labelText });
      } else if (attrs.anchor && isNomaId(labelText) && labelMarkdown) {
        appendMarkdownPart(parts, { text: `[${escapeMarkdownLinkLabel(labelMarkdown)}](#${labelText})`, visibleText: labelText });
      } else if (attrs.anchor && labelMarkdown) {
        appendMarkdownPart(parts, {
          text: `[${escapeMarkdownLinkLabel(labelMarkdown)}](#${escapeMarkdownLinkTarget(attrs.anchor)})`,
          visibleText: labelText,
        });
      } else {
        appendMarkdownPart(parts, { text: labelMarkdown, visibleText: labelText });
      }
      continue;
    }
    if (match[5] !== undefined) {
      appendMarkdownPart(parts, visibleMarkdownPart(runMarkdownPart(match[5], options)));
      continue;
    }
    const selfClosingName = match[7];
    if (selfClosingName === "tab" || selfClosingName === "ptab") appendMarkdownPart(parts, { text: "\t", visibleText: "\t" });
    else if (selfClosingName === "br" || selfClosingName === "cr") appendMarkdownPart(parts, { text: "\n", visibleText: "\n" });
    else if (selfClosingName === "noBreakHyphen") appendMarkdownPart(parts, { text: "-", visibleText: "-" });
    else if (selfClosingName === "softHyphen") appendMarkdownPart(parts, { text: "\u00ad", visibleText: "\u00ad" });
    else if (selfClosingName === "sym") {
      const text = symbolText(match[8] ?? "");
      appendMarkdownPart(parts, { text, visibleText: text });
    }
  }
  return parts;
}

function replaceWordFields(xml: string): string {
  const fieldRe = /<([\w.-]+:)?r\b[^>]*>\s*<([\w.-]+:)?fldChar\b[^>]*\b(?:[\w.-]+:)?fldCharType="begin"[^>]*(?:\/>|>\s*<\/(?:[\w.-]+:)?fldChar>)\s*<\/(?:[\w.-]+:)?r>[\s\S]*?<([\w.-]+:)?r\b[^>]*>\s*<([\w.-]+:)?fldChar\b[^>]*\b(?:[\w.-]+:)?fldCharType="end"[^>]*(?:\/>|>\s*<\/(?:[\w.-]+:)?fldChar>)\s*<\/(?:[\w.-]+:)?r>/g;
  const complexFields = xml.replace(fieldRe, (fieldXml) => {
    return replaceSupportedField(fieldXml, fieldXml, fieldInstructionText(fieldXml));
  });
  const simpleFieldRe = /<([\w.-]+:)?fldSimple\b([^>]*)>([\s\S]*?)<\/(?:[\w.-]+:)?fldSimple>/g;
  return complexFields.replace(simpleFieldRe, (fieldXml, _prefix, attrsSource, body) => {
    return replaceSupportedField(fieldXml, body ?? "", parseXmlAttrs(attrsSource ?? "").instr);
  });
}

function replaceSupportedField(fieldXml: string, resultSourceXml: string, instruction: string | undefined): string {
  const field = parseFieldInstruction(instruction);
  if (!field) return fieldXml;
  if (field.kind === "REF") {
    const id = field.target ? decodeNomaBookmarkId(field.target) : undefined;
    if (!id) return fieldXml;
    const rPr = fieldResultRunProperties(resultSourceXml);
    return `<w:r>${rPr}<w:t>[[${id}]]</w:t></w:r>`;
  }
  if (field.kind === "HYPERLINK") {
    const resultXml = fieldResultXml(resultSourceXml);
    if (!resultXml.trim()) return fieldXml;
    if (field.anchor) return `<w:hyperlink w:anchor="${escapeXmlAttr(field.anchor)}">${resultXml}</w:hyperlink>`;
    if (field.target) return `<w:hyperlink w:href="${escapeXmlAttr(field.target)}">${resultXml}</w:hyperlink>`;
  }
  return fieldXml;
}

function fieldInstructionText(fieldXml: string): string {
  return [...fieldXml.matchAll(/<([\w.-]+:)?instrText\b[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?instrText>/g)]
    .map((match) => decodeXml(match[2] ?? ""))
    .join("")
    .trim();
}

function parseFieldInstruction(instruction: string | undefined): { kind: "REF"; target?: string } | { kind: "HYPERLINK"; target?: string; anchor?: string } | undefined {
  if (!instruction) return undefined;
  const tokens = fieldInstructionTokens(instruction);
  const kind = tokens[0]?.toUpperCase();
  if (kind === "REF") {
    const target = tokens[1];
    return target ? { kind, target } : { kind };
  }
  if (kind === "HYPERLINK") {
    let target: string | undefined;
    let anchor: string | undefined;
    for (let i = 1; i < tokens.length; i++) {
      const token = tokens[i];
      if (!token) continue;
      if (token.toLowerCase() === "\\l") {
        anchor = tokens[i + 1];
        i++;
      } else if (token.startsWith("#")) {
        anchor = token.slice(1);
      } else if (token.startsWith("\\")) {
        continue;
      } else if (!target) {
        target = token;
      }
    }
    return { kind, ...(target ? { target } : {}), ...(anchor ? { anchor } : {}) };
  }
  return undefined;
}

function fieldInstructionTokens(instruction: string): string[] {
  const tokens: string[] = [];
  const tokenRe = /"([^"]*)"|(\S+)/g;
  for (const match of instruction.trim().matchAll(tokenRe)) {
    tokens.push(match[1] ?? match[2] ?? "");
  }
  return tokens;
}

function fieldResultRunProperties(fieldXml: string): string {
  return /<([\w.-]+:)?rPr\b[^>]*>[\s\S]*?<\/(?:[\w.-]+:)?rPr>/.exec(fieldResultXml(fieldXml))?.[0] ?? "";
}

function fieldResultXml(fieldXml: string): string {
  const separateRe = /<([\w.-]+:)?r\b[^>]*>\s*<([\w.-]+:)?fldChar\b[^>]*\b(?:[\w.-]+:)?fldCharType="separate"[^>]*(?:\/>|>\s*<\/(?:[\w.-]+:)?fldChar>)\s*<\/(?:[\w.-]+:)?r>/;
  const separate = separateRe.exec(fieldXml);
  const resultXml = separate ? fieldXml.slice((separate.index ?? 0) + separate[0].length) : fieldXml;
  const endRe = /<([\w.-]+:)?r\b[^>]*>\s*<([\w.-]+:)?fldChar\b[^>]*\b(?:[\w.-]+:)?fldCharType="end"[^>]*(?:\/>|>\s*<\/(?:[\w.-]+:)?fldChar>)\s*<\/(?:[\w.-]+:)?r>\s*$/;
  return resultXml.replace(endRe, "");
}

function escapeXmlAttr(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/"/g, "&quot;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function appendMarkdownPart<T extends MarkdownPart>(parts: T[], part: T): void {
  if (!part.text) return;
  const previous = parts[parts.length - 1];
  if (previous && previous.style === part.style) {
    previous.text += part.text;
    if ("visibleText" in previous && "visibleText" in part) {
      (previous as VisibleMarkdownPart).visibleText += (part as VisibleMarkdownPart).visibleText;
    }
    return;
  }
  parts.push({ ...part });
}

function visibleMarkdownPart(part: MarkdownPart): VisibleMarkdownPart {
  return { ...part, visibleText: part.text };
}

function sliceVisibleMarkdownParts(parts: VisibleMarkdownPart[], start: number, end: number): MarkdownPart[] {
  const out: MarkdownPart[] = [];
  let offset = 0;
  for (const part of parts) {
    const partStart = offset;
    const partEnd = offset + part.visibleText.length;
    offset = partEnd;
    if (partEnd <= start || partStart >= end) continue;
    const sliceStart = Math.max(0, start - partStart);
    const sliceEnd = Math.min(part.visibleText.length, end - partStart);
    if (sliceStart === 0 && sliceEnd === part.visibleText.length) {
      appendMarkdownPart(out, { text: part.text, ...(part.style ? { style: part.style } : {}) });
      continue;
    }
    appendMarkdownPart(out, {
      text: part.visibleText.slice(sliceStart, sliceEnd),
      ...(part.style ? { style: part.style } : {}),
    });
  }
  return out;
}

function stripUniformBold(parts: MarkdownPart[]): MarkdownPart[] {
  const textParts = parts.filter((part) => part.text.trim());
  if (textParts.length === 0) return parts;
  if (!textParts.every((part) => part.style === "bold" || part.style === "boldItalic")) return parts;
  return parts.map((part) => {
    if (part.style === "bold") return { text: part.text };
    if (part.style === "boldItalic") return { text: part.text, style: "italic" };
    return part;
  });
}

function renderMarkdownParts(parts: MarkdownPart[]): string {
  return parts.map(renderMarkdownPart).join("");
}

function runMarkdownPart(xml: string, options: TextExtractionOptions = {}): MarkdownPart {
  const text = paragraphText(xml, options);
  if (!text) return { text: "" };
  const code = /<([\w.-]+:)?rFonts\b[^>]*Courier New/.test(xml) || /<([\w.-]+:)?shd\b[^>]*\b(?:[\w.-]+:)?fill="EEF2F0"/.test(xml);
  if (code) return { text, style: "code" };
  const bold = !options.ignoreBold && /<([\w.-]+:)?b\b(?![^>]*\b(?:[\w.-]+:)?val="(?:0|false)")/.test(xml);
  const italic = /<([\w.-]+:)?i\b(?![^>]*\b(?:[\w.-]+:)?val="(?:0|false)")/.test(xml);
  if (bold && italic) return { text, style: "boldItalic" };
  if (bold) return { text, style: "bold" };
  if (italic) return { text, style: "italic" };
  return { text };
}

function renderMarkdownPart(part: MarkdownPart): string {
  if (part.style === "code") {
    return wrapMarkdown(part.text, "`", "`", (value) => !value.includes("`") && !value.includes("\n"));
  }
  if (part.style === "boldItalic") return wrapMarkdown(part.text, "***", "***");
  if (part.style === "bold") return wrapMarkdown(part.text, "**", "**");
  if (part.style === "italic") return wrapMarkdown(part.text, "*", "*");
  return part.text;
}

function wrapMarkdown(
  text: string,
  open: string,
  close: string,
  canWrap: (value: string) => boolean = () => true,
): string {
  const match = /^(\s*)([\s\S]*?)(\s*)$/.exec(text);
  const leading = match?.[1] ?? "";
  const body = match?.[2] ?? text;
  const trailing = match?.[3] ?? "";
  if (!body || !canWrap(body)) return text;
  return `${leading}${open}${body}${close}${trailing}`;
}

function escapeMarkdownLinkLabel(label: string): string {
  return label.replace(/\\/g, "\\\\").replace(/\[/g, "\\[").replace(/\]/g, "\\]");
}

function escapeMarkdownLinkTarget(target: string): string {
  return target.replace(/[()\s]/g, (char) => {
    if (char === "(") return "%28";
    if (char === ")") return "%29";
    return encodeURIComponent(char);
  });
}

function decodeNomaBookmarkId(bookmarkName: string): string | undefined {
  const match = /^n_(.+)_([0-9a-f]{8})$/i.exec(bookmarkName);
  if (!match) return undefined;
  const stem = match[1] ?? "";
  const hash = match[2]?.toLowerCase() ?? "";
  for (const candidate of bookmarkIdCandidates(stem)) {
    if (isNomaId(candidate) && bookmarkStem(candidate) === stem && bookmarkHash(candidate) === hash) {
      return candidate;
    }
  }
  return undefined;
}

function bookmarkIdCandidates(stem: string): string[] {
  const candidates = new Set<string>();
  addBookmarkIdCandidateVariants(stem, candidates);
  const parts = stem.split("_");
  if (parts.length > 1 && parts.length <= 5) {
    const separators = ["_", "-", ".", "/", ":"];
    const visit = (index: number, current: string): void => {
      if (index >= parts.length) {
        addBookmarkIdCandidateVariants(current, candidates);
        return;
      }
      for (const separator of separators) {
        visit(index + 1, `${current}${separator}${parts[index] ?? ""}`);
      }
    };
    visit(1, parts[0] ?? "");
  }
  return [...candidates];
}

function addBookmarkIdCandidateVariants(candidate: string, candidates: Set<string>): void {
  if (!candidate) return;
  candidates.add(candidate);
  candidates.add(`_${candidate}`);
}

function bookmarkStem(id: string): string {
  const clean = id.replace(/[^A-Za-z0-9_]/g, "_").replace(/^[^A-Za-z]+/, "");
  return (clean || "id").slice(0, 28);
}

function bookmarkHash(id: string): string {
  return crc32(Buffer.from(id, "utf8")).toString(16).padStart(8, "0");
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

function isNomaId(value: string): boolean {
  return /^[a-zA-Z_][\w\-./:]*$/.test(value);
}

function paragraphText(xml: string, options: TextExtractionOptions = {}): string {
  let text = "";
  const currentXml = options.includeDeletedText ? xml : stripNonCurrentTrackedRanges(xml);
  const tokenRe = /<([\w.-]+:)?(tab|ptab|br|cr|noBreakHyphen|softHyphen|sym)\b([^>]*?)(?:\/>|>\s*<\/(?:[\w.-]+:)?\2>)|<([\w.-]+:)?(t|delText)\b[^>]*>([\s\S]*?)<\/(?:[\w.-]+:)?\5>/g;
  for (const match of currentXml.matchAll(tokenRe)) {
    const emptyName = match[2];
    if (emptyName === "tab" || emptyName === "ptab") {
      text += "\t";
    } else if (emptyName === "br" || emptyName === "cr") {
      text += "\n";
    } else if (emptyName === "noBreakHyphen") {
      text += "-";
    } else if (emptyName === "softHyphen") {
      text += "\u00ad";
    } else if (emptyName === "sym") {
      text += symbolText(match[3] ?? "");
    } else if (match[6] !== undefined && (options.includeDeletedText || match[5] !== "delText")) {
      text += decodeXml(match[6]);
    }
  }
  return text.replace(/[ \t]+\n/g, "\n").replace(/\n[ \t]+/g, "\n");
}

function stripNonCurrentTrackedRanges(xml: string): string {
  const withoutWrappedRanges = xml.replace(/<([\w.-]+:)?(del|moveFrom)\b[^>]*>[\s\S]*?<\/(?:[\w.-]+:)?\2>/g, "");
  return stripMarkedRanges(withoutWrappedRanges, "moveFromRangeStart", "moveFromRangeEnd");
}

interface MarkedRange {
  id: string;
  attrs: Record<string, string>;
  start: number;
  bodyStart: number;
  bodyEnd: number;
  endEnd: number;
}

function stripMarkedRanges(xml: string, startName: string, endName: string): string {
  const ranges = markedRanges(xml, startName, endName);
  if (ranges.length === 0) return xml;
  let out = "";
  let cursor = 0;
  for (const range of ranges) {
    if (range.start < cursor) continue;
    out += xml.slice(cursor, range.start);
    cursor = range.endEnd;
  }
  return out + xml.slice(cursor);
}

function markedRanges(xml: string, startName: string, endName: string): MarkedRange[] {
  const ranges: MarkedRange[] = [];
  const startRe = new RegExp(`<([\\w.-]+:)?${startName}\\b([^>]*)\\/?>`, "g");
  let startMatch: RegExpExecArray | null;
  while ((startMatch = startRe.exec(xml)) !== null) {
    const attrs = parseXmlAttrs(startMatch[2] ?? "");
    const id = attrs.id;
    if (!id) continue;
    const bodyStart = startRe.lastIndex;
    const end = findMarkedRangeEnd(xml, endName, id, bodyStart);
    if (!end) continue;
    ranges.push({
      id,
      attrs,
      start: startMatch.index,
      bodyStart,
      bodyEnd: end.start,
      endEnd: end.endEnd,
    });
    startRe.lastIndex = end.endEnd;
  }
  return ranges;
}

function findMarkedRangeEnd(
  xml: string,
  endName: string,
  id: string,
  fromIndex: number,
): { start: number; endEnd: number } | undefined {
  const endRe = new RegExp(`<([\\w.-]+:)?${endName}\\b([^>]*)\\/?>`, "g");
  endRe.lastIndex = fromIndex;
  let endMatch: RegExpExecArray | null;
  while ((endMatch = endRe.exec(xml)) !== null) {
    const attrs = parseXmlAttrs(endMatch[2] ?? "");
    if (attrs.id === id) return { start: endMatch.index, endEnd: endMatch.index + endMatch[0].length };
  }
  return undefined;
}

function symbolText(attrsSource: string): string {
  const char = parseXmlAttrs(attrsSource).char;
  if (!char || !/^[0-9a-f]+$/i.test(char)) return "";
  const codePoint = Number.parseInt(char, 16);
  if (!Number.isFinite(codePoint) || codePoint < 0 || codePoint > 0x10ffff) return "";
  return String.fromCodePoint(codePoint);
}

function toReviewComment(
  comment: ParsedComment,
  nativeIdByParaId: Map<string, string>,
  anchorBookmarkNames: Map<string, string[]>,
): DocxReviewComment {
  const paragraphs = [...comment.paragraphs];
  const status = parseStatusParagraph(paragraphs[0]);
  if (status) paragraphs.shift();
  const resolved = comment.done ?? status !== undefined;
  const anchors = anchorBookmarkNames.get(comment.nativeId) ?? [];
  return {
    nativeId: comment.nativeId,
    ...(anchors.length > 0 ? { anchorBookmarkNames: anchors } : {}),
    ...(comment.author ? { author: comment.author } : {}),
    ...(comment.initials ? { initials: comment.initials } : {}),
    ...(comment.date ? { date: comment.date } : {}),
    ...(resolved ? { status: "resolved" as const } : {}),
    ...(status?.resolvedBy ? { resolvedBy: status.resolvedBy } : {}),
    ...(status?.resolvedAt ? { resolvedAt: status.resolvedAt } : {}),
    ...(comment.parentParaId && nativeIdByParaId.has(comment.parentParaId)
      ? { replyTo: nativeIdByParaId.get(comment.parentParaId)! }
      : {}),
    ...(comment.hasRevisions ? { hasRevisions: true } : {}),
    body: paragraphs.join("\n\n"),
  };
}

function parseStatusParagraph(text: string | undefined): { resolvedBy?: string; resolvedAt?: string } | undefined {
  if (!text?.startsWith("Status: resolved")) return undefined;
  const out: { resolvedBy?: string; resolvedAt?: string } = {};
  for (const part of text.split(";").map((item) => item.trim())) {
    if (part.startsWith("resolved by ")) out.resolvedBy = part.slice("resolved by ".length);
    if (part.startsWith("resolved at ")) out.resolvedAt = part.slice("resolved at ".length);
  }
  return out;
}
