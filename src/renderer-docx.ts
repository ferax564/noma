import type { Attrs, AttrValue, DirectiveNode, DocumentNode, Node, SectionNode, TableAlign, TableNode } from "./ast.js";
import { walk } from "./ast.js";
import {
  bodyFieldText,
  buildComputedEvalContext,
  controlDefaultText,
  controlOptions,
  computedDomainText,
  evaluateComputedNode,
  evaluateComputedSeries,
  formatComputedNumber,
  formulaText,
  type ComputedEvalContext,
} from "./computed.js";
import { inlineToPlain, splitPipeRow, unescapeMarkdownLinkLabel, unescapeMarkdownTextEscapes } from "./inline.js";
import { buildDatasetRegistry, renderPlotSvgForNode, type DatasetTable } from "./renderer-html.js";

export interface DocxRenderOptions {
  /** Override document title used in package metadata. */
  title?: string;
  /** Creator metadata written to docProps/core.xml. */
  creator?: string;
  /** Short package description. */
  description?: string;
  /** Keyword metadata written to docProps/core.xml. */
  keywords?: string | string[];
  /** Category metadata written to docProps/core.xml. */
  category?: string;
  /** Content status metadata written to docProps/core.xml. */
  status?: string;
}

interface Relationship {
  id: string;
  type: string;
  target: string;
  targetMode?: "External";
}

interface DocxCtx {
  relationships: Relationship[];
  nextRelationshipId: number;
  media: DocxMedia[];
  nextMediaId: number;
  nextDrawingId: number;
  bookmarkNames: Map<string, string>;
  bookmarkIds: Map<string, number>;
  nextBookmarkId: number;
  captionCrossReferences: Map<string, string>;
  comments: DocxComment[];
  commentsBySourceId: Map<string, DocxComment>;
  commentsRelationships: Relationship[];
  nextCommentsRelationshipId: number;
  nextCommentId: number;
  nextRevisionId: number;
  targetedComments: Map<string, DocxComment[]>;
  targetedCommentNodes: Set<DirectiveNode>;
  anchoredCommentIds: Set<number>;
  targetedChangeRequests: Map<string, DirectiveNode[]>;
  targetedChangeRequestNodes: Set<DirectiveNode>;
  anchoredChangeRequestNodes: Set<DirectiveNode>;
  targetedChangeRequestComments: Map<string, DocxComment[]>;
  anchoredChangeRequestCommentIds: Set<number>;
  commentsRelationshipId?: string;
  commentsExRelationshipId?: string;
  footnotes: DocxFootnote[];
  targetedFootnotes: Map<string, DocxFootnote[]>;
  targetedFootnoteNodes: Set<DirectiveNode>;
  anchoredFootnoteIds: Set<number>;
  footnotesRelationships: Relationship[];
  nextFootnotesRelationshipId: number;
  nextFootnoteId: number;
  footnotesRelationshipId?: string;
  endnotes: DocxEndnote[];
  targetedEndnotes: Map<string, DocxEndnote[]>;
  targetedEndnoteNodes: Set<DirectiveNode>;
  anchoredEndnoteIds: Set<number>;
  endnotesRelationships: Relationship[];
  nextEndnotesRelationshipId: number;
  nextEndnoteId: number;
  endnotesRelationshipId?: string;
  datasets: Map<string, DatasetTable>;
  header?: HeaderFooterPart;
  headerRelationshipId?: string;
  headerRelationships: Relationship[];
  nextHeaderRelationshipId: number;
  footer?: HeaderFooterPart;
  footerRelationshipId?: string;
  footerRelationships: Relationship[];
  nextFooterRelationshipId: number;
  citations: CitationEntry[];
  sections: SectionEntry[];
  captions: CaptionEntry[];
  pageSetup: PageSetup;
  computed: ComputedEvalContext;
  relationshipScope?: RelationshipScope;
}

interface RunStyle {
  bold?: boolean;
  italic?: boolean;
  code?: boolean;
  color?: string;
  underline?: boolean;
  strike?: boolean;
}

interface ParagraphOptions {
  style?: string;
  align?: "left" | "center" | "right";
  numId?: number;
  bookmarkId?: string;
  bookmarkIds?: string[];
  commentIds?: number[];
  footnoteIds?: number[];
  endnoteIds?: number[];
  bottomBorder?: boolean;
  indentLeft?: number;
  tabRight?: number;
  frame?: ParagraphFrame;
  sectionProperties?: string;
}

interface TableCellOptions {
  header?: boolean;
  align?: TableAlign;
  width: number;
}

interface ParagraphFrame {
  border: string;
  fill: string;
}

interface DirectiveFrame extends ParagraphFrame {
  color: string;
}

interface DocxComment {
  id: number;
  paraId: string;
  parentParaId?: string;
  sourceId?: string;
  author: string;
  initials: string;
  date: string;
  status?: string;
  resolvedBy?: string;
  resolvedAt?: string;
  body: string;
}

interface DocxFootnote {
  id: number;
  sourceId?: string;
  body: string;
}

interface DocxEndnote {
  id: number;
  sourceId?: string;
  body: string;
}

interface DocxMedia {
  relationshipId: string;
  path: string;
  name: string;
  extension: string;
  contentType: string;
  data: Buffer;
  widthPx?: number;
  heightPx?: number;
}

interface DecodedImage {
  contentType: string;
  extension: string;
  data: Buffer;
  widthPx?: number;
  heightPx?: number;
}

interface ControlDataEntry {
  id: string;
  type: string;
  label: string;
  value: string;
}

interface CitationEntry {
  id?: string;
  source?: string;
  title?: string;
  url?: string;
  doi?: string;
  accessed?: string;
  body?: string;
}

interface SectionEntry {
  id?: string;
  title: string;
  level: number;
}

interface CaptionEntry {
  id?: string;
  title: string;
  kind: "figures" | "tables" | "plots";
}

interface HeaderFooterPart {
  id?: string;
  body?: string;
  children: Node[];
  align?: "left" | "center" | "right";
  pageNumbers: boolean;
  totalPages: boolean;
}

interface PageMargins {
  top: number;
  right: number;
  bottom: number;
  left: number;
  header: number;
  footer: number;
  gutter: number;
}

interface PageSetup {
  width: number;
  height: number;
  orientation?: "landscape";
  margins: PageMargins;
}

interface SettingsFeatures {
  updateFields: boolean;
  revisionView: boolean;
  protection?: DocumentProtection;
}

interface DocumentProtection {
  edit: "forms" | "readOnly" | "comments" | "trackedChanges";
  enforcement: boolean;
}

type ContentControlLock = "sdtLocked" | "contentLocked" | "sdtContentLocked" | "unlocked";

interface CoreProperties {
  title: string;
  creator: string;
  description: string;
  keywords?: string;
  category?: string;
  status?: string;
}

const W_NS = "http://schemas.openxmlformats.org/wordprocessingml/2006/main";
const R_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const WP_NS = "http://schemas.openxmlformats.org/drawingml/2006/wordprocessingDrawing";
const A_NS = "http://schemas.openxmlformats.org/drawingml/2006/main";
const PIC_NS = "http://schemas.openxmlformats.org/drawingml/2006/picture";
const M_NS = "http://schemas.openxmlformats.org/officeDocument/2006/math";
const MC_NS = "http://schemas.openxmlformats.org/markup-compatibility/2006";
const W14_NS = "http://schemas.microsoft.com/office/word/2010/wordml";
const W15_NS = "http://schemas.microsoft.com/office/word/2012/wordml";
const REL_NS = "http://schemas.openxmlformats.org/package/2006/relationships";
const PACKAGE_REL_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships";
const COMMENTS_EXTENDED_REL_NS = "http://schemas.microsoft.com/office/2011/relationships/commentsExtended";
const CORE_REL_NS = "http://schemas.openxmlformats.org/package/2006/relationships/metadata/core-properties";
const APP_REL_NS = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/extended-properties";
const FIXED_CORE_TIME = "2026-01-01T00:00:00Z";
const NOMA_CONTROLS_NS = "urn:noma:controls";
const NOMA_CONTROLS_STORE_ITEM_ID = "{4E1F6C8C-7091-4A42-A5BD-6B5C229E7B0A}";
const DEFAULT_PAGE_SETUP: PageSetup = {
  width: 12240,
  height: 15840,
  margins: {
    top: 1440,
    right: 1440,
    bottom: 1440,
    left: 1440,
    header: 720,
    footer: 720,
    gutter: 0,
  },
};

export function renderDocx(doc: DocumentNode, options: DocxRenderOptions = {}): Buffer {
  const headerFooter = collectHeaderFooter(doc);
  const controlData = collectControlData(doc);
  const hasControlData = controlData.length > 0;
  const settingsFeatures = collectSettingsFeatures(doc, headerFooter);
  const hasSettings = settingsFeatures.updateFields || settingsFeatures.revisionView || settingsFeatures.protection !== undefined;
  const ctx: DocxCtx = {
    relationships: [],
    nextRelationshipId: 3,
    media: [],
    nextMediaId: 1,
    nextDrawingId: 1,
    bookmarkNames: buildBookmarkNames(doc),
    bookmarkIds: new Map(),
    nextBookmarkId: 1,
    captionCrossReferences: buildCaptionCrossReferences(doc),
    comments: [],
    commentsBySourceId: new Map(),
    commentsRelationships: [],
    nextCommentsRelationshipId: 1,
    nextCommentId: 0,
    nextRevisionId: 0,
    targetedComments: new Map(),
    targetedCommentNodes: new Set(),
    anchoredCommentIds: new Set(),
    targetedChangeRequests: new Map(),
    targetedChangeRequestNodes: new Set(),
    anchoredChangeRequestNodes: new Set(),
    targetedChangeRequestComments: new Map(),
    anchoredChangeRequestCommentIds: new Set(),
    footnotes: [],
    targetedFootnotes: new Map(),
    targetedFootnoteNodes: new Set(),
    anchoredFootnoteIds: new Set(),
    footnotesRelationships: [],
    nextFootnotesRelationshipId: 1,
    nextFootnoteId: 1,
    endnotes: [],
    targetedEndnotes: new Map(),
    targetedEndnoteNodes: new Set(),
    anchoredEndnoteIds: new Set(),
    endnotesRelationships: [],
    nextEndnotesRelationshipId: 1,
    nextEndnoteId: 1,
    datasets: buildDatasetRegistry(doc),
    header: headerFooter.header,
    headerRelationships: [],
    nextHeaderRelationshipId: 1,
    footer: headerFooter.footer,
    footerRelationships: [],
    nextFooterRelationshipId: 1,
    citations: collectCitations(doc),
    sections: collectSections(doc),
    captions: collectCaptions(doc),
    pageSetup: collectPageSetup(doc),
    computed: buildComputedEvalContext(doc),
  };
  if (ctx.header) {
    ctx.headerRelationshipId = addRelationship(ctx, `${PACKAGE_REL_NS}/header`, "header1.xml");
  }
  if (ctx.footer) {
    ctx.footerRelationshipId = addRelationship(ctx, `${PACKAGE_REL_NS}/footer`, "footer1.xml");
  }
  collectTargetedComments(doc, ctx);
  collectTargetedChangeRequests(doc, ctx);
  collectTargetedFootnotes(doc, ctx);
  collectTargetedEndnotes(doc, ctx);
  const title =
    options.title ||
    (typeof doc.meta.title === "string" ? doc.meta.title : undefined) ||
    extractFirstHeading(doc) ||
    "Noma Document";
  const coreProperties = docxCoreProperties(doc, title, options);

  const documentXml = resolveBookmarkPlaceholders(renderDocumentXml(doc, ctx), ctx);
  const headerXml = ctx.header
    ? resolveBookmarkPlaceholders(headerFooterXml("hdr", ctx.header, ctx), ctx)
    : undefined;
  const footerXml = ctx.footer
    ? resolveBookmarkPlaceholders(headerFooterXml("ftr", ctx.footer, ctx), ctx)
    : undefined;
  if (hasSettings) {
    addRelationship(ctx, `${PACKAGE_REL_NS}/settings`, "settings.xml");
  }
  const relsXml = renderDocumentRelationships(ctx.relationships);
  const hasComments = ctx.comments.length > 0;
  const hasFootnotes = ctx.footnotes.length > 0;
  const hasEndnotes = ctx.endnotes.length > 0;
  const hasHeader = headerXml !== undefined;
  const hasFooter = footerXml !== undefined;
  const commentsPartXml = hasComments ? commentsXml(ctx.comments, ctx) : undefined;
  const footnotesPartXml = hasFootnotes ? footnotesXml(ctx.footnotes, ctx) : undefined;
  const endnotesPartXml = hasEndnotes ? endnotesXml(ctx.endnotes, ctx) : undefined;
  const entries: ZipEntry[] = [
    { path: "[Content_Types].xml", data: contentTypesXml({ hasComments, hasCommentsEx: hasComments, hasFootnotes, hasEndnotes, hasHeader, hasFooter, hasSettings, hasControlData, media: ctx.media }) },
    { path: "_rels/.rels", data: rootRelationshipsXml({ hasControlData }) },
    { path: "docProps/core.xml", data: corePropertiesXml(coreProperties) },
    { path: "docProps/app.xml", data: appPropertiesXml() },
    { path: "word/document.xml", data: documentXml },
    { path: "word/_rels/document.xml.rels", data: relsXml },
    { path: "word/styles.xml", data: stylesXml() },
    { path: "word/numbering.xml", data: numberingXml() },
  ];
  if (hasSettings) entries.push({ path: "word/settings.xml", data: settingsXml(settingsFeatures) });
  if (commentsPartXml) entries.push({ path: "word/comments.xml", data: commentsPartXml });
  if (ctx.commentsRelationships.length > 0) entries.push({ path: "word/_rels/comments.xml.rels", data: renderPartRelationships(ctx.commentsRelationships) });
  if (hasComments) entries.push({ path: "word/commentsExtended.xml", data: commentsExtendedXml(ctx.comments) });
  if (footnotesPartXml) entries.push({ path: "word/footnotes.xml", data: footnotesPartXml });
  if (ctx.footnotesRelationships.length > 0) entries.push({ path: "word/_rels/footnotes.xml.rels", data: renderPartRelationships(ctx.footnotesRelationships) });
  if (endnotesPartXml) entries.push({ path: "word/endnotes.xml", data: endnotesPartXml });
  if (ctx.endnotesRelationships.length > 0) entries.push({ path: "word/_rels/endnotes.xml.rels", data: renderPartRelationships(ctx.endnotesRelationships) });
  if (headerXml) entries.push({ path: "word/header1.xml", data: headerXml });
  if (ctx.headerRelationships.length > 0) entries.push({ path: "word/_rels/header1.xml.rels", data: renderPartRelationships(ctx.headerRelationships) });
  if (footerXml) entries.push({ path: "word/footer1.xml", data: footerXml });
  if (ctx.footerRelationships.length > 0) entries.push({ path: "word/_rels/footer1.xml.rels", data: renderPartRelationships(ctx.footerRelationships) });
  if (hasControlData) {
    entries.push({ path: "customXml/item1.xml", data: customXmlControlDataXml(controlData) });
    entries.push({ path: "customXml/_rels/item1.xml.rels", data: customXmlControlDataRelationshipsXml() });
    entries.push({ path: "customXml/itemProps1.xml", data: customXmlControlDataPropertiesXml() });
  }
  for (const media of ctx.media) entries.push({ path: media.path, data: media.data });
  return zipStore(entries);
}

function renderDocumentXml(doc: DocumentNode, ctx: DocxCtx): string {
  const body = doc.children.map((node) => renderNode(node, ctx)).join("");
  return xmlDecl(`\
<w:document xmlns:w="${W_NS}" xmlns:r="${R_NS}" xmlns:wp="${WP_NS}" xmlns:a="${A_NS}" xmlns:pic="${PIC_NS}" xmlns:m="${M_NS}" xmlns:w14="${W14_NS}" xmlns:mc="${MC_NS}" mc:Ignorable="w14">
  <w:body>
${body}    ${sectionPropertiesXml(ctx, ctx.pageSetup, "    ")}
  </w:body>
</w:document>`);
}

function sectionPropertiesXml(ctx: DocxCtx, setup: PageSetup, indent = ""): string {
  const headerReference = ctx.headerRelationshipId
    ? `${indent}  <w:headerReference w:type="default" r:id="${xmlAttr(ctx.headerRelationshipId)}"/>\n`
    : "";
  const footerReference = ctx.footerRelationshipId
    ? `${indent}  <w:footerReference w:type="default" r:id="${xmlAttr(ctx.footerRelationshipId)}"/>\n`
    : "";
  return `<w:sectPr>
${headerReference}${footerReference}${indent}  ${pageSizeXml(setup)}
${indent}  ${pageMarginsXml(setup.margins)}
${indent}</w:sectPr>`;
}

function renderNode(node: Node, ctx: DocxCtx, frame?: ParagraphFrame): string {
  const rendered = renderNodeCore(node, ctx, frame);
  return node.type === "section" ? rendered : rendered + renderAnchoredChangeRequests(node, ctx);
}

function renderNodeCore(node: Node, ctx: DocxCtx, frame?: ParagraphFrame): string {
  switch (node.type) {
    case "document":
      return node.children.map((child) => renderNode(child, ctx)).join("");
    case "section":
      return renderSection(node, ctx);
    case "paragraph":
      return paragraph(inlineRuns(node.content, ctx), { frame });
    case "code":
      return renderCode(node.content, node.lang);
    case "list":
      return node.items
        .map((item) => paragraph(inlineRuns(item.content, ctx), { numId: node.ordered ? 2 : 1, frame }))
        .join("");
    case "list_item":
      return paragraph(inlineRuns(node.content, ctx), { numId: 1, frame });
    case "quote":
      return splitLines(node.content).map((line) => paragraph(inlineRuns(line, ctx), { style: "NomaQuote", frame })).join("");
    case "thematic_break":
      return paragraph("", { bottomBorder: true });
    case "table":
      return renderTable(node, ctx);
    case "directive":
      return renderDirective(node, ctx);
    case "frontmatter":
      return "";
    default: {
      const _exhaustive: never = node;
      void _exhaustive;
      return "";
    }
  }
}

function renderSection(node: SectionNode, ctx: DocxCtx): string {
  const style = `Heading${Math.min(Math.max(node.level, 1), 6)}`;
  const heading = paragraph(inlineRuns(node.title, ctx), {
    style,
    bookmarkId: node.id,
    ...targetedCommentOptions(node, ctx),
  });
  return heading + renderAnchoredChangeRequests(node, ctx) + node.children.map((child) => renderNode(child, ctx)).join("");
}

function renderDirective(node: DirectiveNode, ctx: DocxCtx): string {
  if (node.name === "table") return renderTableDirective(node, ctx);
  if (node.name === "grid" || node.name === "columns") return renderColumnLayout(node, ctx);
  if (node.name === "page_setup") return renderPageSetup(node, ctx);
  if (node.name === "header" || node.name === "footer" || node.name === "doc_protection") return "";
  if (node.name === "toc") return renderToc(node, ctx);
  if (node.name === "pagebreak") return renderPageBreak(node, ctx);
  if (node.name === "plot") return renderPlot(node, ctx);
  if (node.name === "figure") return renderFigure(node, ctx);
  if (node.name === "dataset") return renderDataset(node, ctx);
  if (node.name === "metric") return renderMetric(node, ctx);
  if (node.name === "computed_metric") return renderComputedMetric(node, ctx);
  if (node.name === "computed_plot") return renderComputedPlot(node, ctx);
  if (node.name === "citation") return renderCitation(node, ctx);
  if (node.name === "bibliography") return renderBibliography(node, ctx);
  if (node.name === "comment") return renderComment(node, ctx);
  if (node.name === "footnote") return renderFootnote(node, ctx);
  if (node.name === "endnote") return renderEndnote(node, ctx);
  if (node.name === "change_request") return renderChangeRequest(node, ctx);
  if (node.name === "state_change") return renderStateChange(node, ctx);
  if (node.name === "review" || node.name === "provenance" || node.name === "confidence") return renderReviewMetaBlock(node, ctx);
  if (node.name === "math") return renderMath(node, ctx);
  if (node.name === "code") return renderCodeDirective(node, ctx);
  if (node.name === "code_cell") return renderCodeCell(node, ctx);
  if (node.name === "output") return renderOutputBlock(node, ctx);
  if (node.name === "agent_task" || node.name === "todo") return renderTaskDirective(node, ctx);
  if (node.name === "button") return renderButton(node, ctx);
  if (node.name === "export_button") return renderExportButton(node, ctx);
  if (node.name === "control") return renderControl(node, ctx);
  if (node.name === "hero" || node.name === "tabs" || node.name === "accordion") return renderFlattenedLayout(node, ctx);
  if (node.name === "tab") return renderTabPanel(node, ctx);
  if (node.name === "sidebar") return renderSidebar(node, ctx);
  if (node.name === "diagram") return renderDiagramDirective(node, ctx);
  if (node.name === "plotly") return renderPlotlyDirective(node, ctx);
  if (isTechnicalDirective(node.name)) return renderTechnicalDirective(node, ctx);
  if (isVerbatimDirective(node.name)) return renderVerbatimDirective(node, ctx);

  const frame = directiveFrame(node) ?? CUSTOM_DIRECTIVE_FRAME;
  const title = directiveTitle(node);
  const label = paragraph(editableLabelRuns(title, ctx, { color: frame.color }), {
    style: "NomaDirective",
    bookmarkId: node.id,
    ...targetedCommentOptions(node, ctx),
    frame,
  });
  const meta = semanticMetaRuns(node, ctx);
  const metaParagraph = meta ? paragraph(meta, { style: "NomaMeta", frame }) : "";
  return label + renderDirectiveContent(node, ctx, frame) + metaParagraph;
}

const CUSTOM_DIRECTIVE_FRAME: DirectiveFrame = { color: "3F5F4A", border: "7E9A82", fill: "F2F6F3" };

function renderDirectiveContent(node: DirectiveNode, ctx: DocxCtx, frame?: DirectiveFrame): string {
  if (node.children.length > 0) {
    return node.children.map((child) => renderNode(child, ctx, frame)).join("");
  }
  return renderBodyParagraphs(node.body ?? "", ctx, frame);
}

function renderFlattenedLayout(node: DirectiveNode, ctx: DocxCtx): string {
  return renderLayoutAnchor(node, ctx) + renderDirectiveContent(node, ctx);
}

function renderSidebar(node: DirectiveNode, ctx: DocxCtx): string {
  const frame: DirectiveFrame = { color: "46505A", border: "7E8B96", fill: "F3F4F6" };
  const title = attrText(node.attrs, "title");
  const label = title ? `Sidebar: ${title}` : "Sidebar";
  const heading = paragraph(editableLabelRuns(label, ctx, { color: frame.color }), {
    style: "NomaDirective",
    bookmarkId: node.id,
    ...targetedCommentOptions(node, ctx),
    frame,
  });
  return heading + renderDirectiveContent(node, ctx, frame);
}

function renderTabPanel(node: DirectiveNode, ctx: DocxCtx): string {
  const title = attrText(node.attrs, "title") ?? "Tab panel";
  const heading = paragraph(editableLabelRuns(title, ctx, { color: "493E78" }), {
    style: "NomaDirective",
    bookmarkId: node.id,
    ...targetedCommentOptions(node, ctx),
  });
  return heading + renderDirectiveContent(node, ctx);
}

function renderDiagramDirective(node: DirectiveNode, ctx: DocxCtx): string {
  const kind = attrText(node.attrs, "kind");
  return renderSourceFallback(node, ctx, kind ? `Diagram (${kind})` : "Diagram", kind ? `source: ${kind}` : "source");
}

function renderPlotlyDirective(node: DirectiveNode, ctx: DocxCtx): string {
  return renderSourceFallback(node, ctx, "Plotly chart", "interactive JSON spec");
}

function renderTechnicalDirective(node: DirectiveNode, ctx: DocxCtx): string {
  const frame = directiveFrame(node);
  const heading = paragraph(editableLabelRuns(technicalTitle(node), ctx, { color: frame?.color ?? "2B5265" }), {
    style: "NomaDirective",
    bookmarkId: node.id,
    ...targetedCommentOptions(node, ctx),
    frame,
  });
  const meta = technicalMetaRuns(node, ctx);
  const metaParagraph = meta ? paragraph(meta, { style: "NomaMeta", frame }) : "";
  const body = technicalBody(node, ctx, frame);
  return heading + metaParagraph + body;
}

function technicalBody(node: DirectiveNode, ctx: DocxCtx, frame?: DirectiveFrame): string {
  if ((node.name === "query" || node.name === "example") && node.body?.trim() && technicalLanguage(node)) {
    return renderCodeBody(node.body, frame);
  }
  return renderDirectiveContent(node, ctx, frame);
}

function renderSourceFallback(node: DirectiveNode, ctx: DocxCtx, label: string, meta: string): string {
  const heading = paragraph(textRun(label, { bold: true, color: "2B5265" }), {
    style: "NomaDirective",
    bookmarkId: node.id,
    ...targetedCommentOptions(node, ctx),
  });
  const metaParagraph = paragraph(textRun(meta), { style: "NomaMeta" });
  const body = node.body ?? "";
  if (!body.trim()) return heading + metaParagraph;
  return heading + metaParagraph + splitLines(body).map((line) => paragraph(textRun(line, { code: true }), { style: "NomaCode" })).join("");
}

function renderLayoutAnchor(node: DirectiveNode, ctx: DocxCtx): string {
  const commentOptions = targetedCommentOptions(node, ctx);
  if (!node.id && !commentOptions.commentIds?.length && !commentOptions.bookmarkIds?.length) return "";
  return paragraph("", {
    style: "NomaMeta",
    bookmarkId: node.id,
    ...commentOptions,
  });
}

function renderBodyParagraphs(body: string, ctx: DocxCtx, frame?: ParagraphFrame): string {
  const text = body.trim();
  if (!text) return "";
  return text
    .split(/\n\s*\n/)
    .map((para) => paragraph(inlineRuns(para.replace(/\n/g, " "), ctx), { frame }))
    .join("");
}

function collectTargetedComments(doc: DocumentNode, ctx: DocxCtx): void {
  const targets = commentAnchorTargets(doc);
  const commentNodes = commentNodesById(doc);
  for (const node of walk(doc)) {
    if (node.type !== "directive" || node.name !== "comment") continue;
    if (commentIsDeleted(node)) continue;
    const replyTo = commentReplyTarget(node);
    if (replyTo) {
      if (!commentExportsToDocx(node, commentNodes)) continue;
      const parent = commentNodes.get(replyTo);
      if (!parent) continue;
      const parentComment = ensureComment(parent, ctx, commentNodes);
      ensureComment(node, ctx, commentNodes, parentComment.paraId);
      ctx.targetedCommentNodes.add(node);
      continue;
    }
    const target = commentTarget(node);
    if (!target || !targets.has(target)) continue;
    const comment = ensureComment(node, ctx, commentNodes);
    ctx.targetedCommentNodes.add(node);
    const comments = ctx.targetedComments.get(target) ?? [];
    comments.push(comment);
    ctx.targetedComments.set(target, comments);
  }
}

function collectTargetedChangeRequests(doc: DocumentNode, ctx: DocxCtx): void {
  const targets = changeRequestAnchorTargets(doc);
  for (const node of walk(doc)) {
    if (node.type !== "directive" || node.name !== "change_request") continue;
    if (!changeRequestExportsNativeRevision(node)) continue;
    const target = changeRequestTarget(node);
    if (!target || !targets.has(target)) continue;
    ctx.targetedChangeRequestNodes.add(node);
    const requests = ctx.targetedChangeRequests.get(target) ?? [];
    requests.push(node);
    ctx.targetedChangeRequests.set(target, requests);
    const comments = ctx.targetedChangeRequestComments.get(target) ?? [];
    comments.push(addChangeRequestMarkerComment(node, ctx));
    ctx.targetedChangeRequestComments.set(target, comments);
  }
}

function collectTargetedFootnotes(doc: DocumentNode, ctx: DocxCtx): void {
  const targets = footnoteAnchorTargets(doc);
  for (const node of walk(doc)) {
    if (node.type !== "directive" || node.name !== "footnote") continue;
    if (noteIsDeleted(node)) continue;
    const target = footnoteTarget(node);
    if (!target || !targets.has(target)) continue;
    const footnote = addFootnote(node, ctx);
    ctx.targetedFootnoteNodes.add(node);
    const footnotes = ctx.targetedFootnotes.get(target) ?? [];
    footnotes.push(footnote);
    ctx.targetedFootnotes.set(target, footnotes);
  }
}

function collectTargetedEndnotes(doc: DocumentNode, ctx: DocxCtx): void {
  const targets = endnoteAnchorTargets(doc);
  for (const node of walk(doc)) {
    if (node.type !== "directive" || node.name !== "endnote") continue;
    if (noteIsDeleted(node)) continue;
    const target = endnoteTarget(node);
    if (!target || !targets.has(target)) continue;
    const endnote = addEndnote(node, ctx);
    ctx.targetedEndnoteNodes.add(node);
    const endnotes = ctx.targetedEndnotes.get(target) ?? [];
    endnotes.push(endnote);
    ctx.targetedEndnotes.set(target, endnotes);
  }
}

function commentNodesById(doc: DocumentNode): Map<string, DirectiveNode> {
  const out = new Map<string, DirectiveNode>();
  for (const node of walk(doc)) {
    if (node.type === "directive" && node.name === "comment" && node.id) out.set(node.id, node);
  }
  return out;
}

function commentExportsToDocx(
  node: DirectiveNode,
  commentNodes: Map<string, DirectiveNode>,
  seen = new Set<string>(),
): boolean {
  if (commentIsDeleted(node)) return false;
  const replyTo = commentReplyTarget(node);
  if (!replyTo) return true;
  if (node.id) {
    if (seen.has(node.id)) return false;
    seen.add(node.id);
  }
  const parent = commentNodes.get(replyTo);
  return Boolean(parent && commentExportsToDocx(parent, commentNodes, seen));
}

function commentAnchorTargets(doc: DocumentNode): Set<string> {
  const targets = new Set<string>();
  for (const node of walk(doc)) {
    if (!isCommentAnchorTarget(node)) continue;
    if (node.id) targets.add(node.id);
    for (const alias of node.aliases ?? []) targets.add(alias);
  }
  return targets;
}

function changeRequestAnchorTargets(doc: DocumentNode): Set<string> {
  const targets = new Set<string>();
  for (const node of walk(doc)) {
    if (!isChangeRequestAnchorTarget(node)) continue;
    if (node.id) targets.add(node.id);
    for (const alias of node.aliases ?? []) targets.add(alias);
  }
  return targets;
}

function footnoteAnchorTargets(doc: DocumentNode): Set<string> {
  const targets = new Set<string>();
  for (const node of walk(doc)) {
    if (!isFootnoteAnchorTarget(node)) continue;
    if (node.id) targets.add(node.id);
    for (const alias of node.aliases ?? []) targets.add(alias);
  }
  return targets;
}

function endnoteAnchorTargets(doc: DocumentNode): Set<string> {
  const targets = new Set<string>();
  for (const node of walk(doc)) {
    if (!isEndnoteAnchorTarget(node)) continue;
    if (node.id) targets.add(node.id);
    for (const alias of node.aliases ?? []) targets.add(alias);
  }
  return targets;
}

function isCommentAnchorTarget(node: Node): boolean {
  if (!node.id) return false;
  if (node.type !== "directive") return true;
  return node.name !== "page_setup" && node.name !== "header" && node.name !== "footer" && node.name !== "comment";
}

function isChangeRequestAnchorTarget(node: Node): boolean {
  if (!isCommentAnchorTarget(node)) return false;
  return node.type !== "directive" || node.name !== "change_request";
}

function isFootnoteAnchorTarget(node: Node): boolean {
  if (!isCommentAnchorTarget(node)) return false;
  return node.type !== "directive" || node.name !== "footnote";
}

function isEndnoteAnchorTarget(node: Node): boolean {
  if (!isCommentAnchorTarget(node)) return false;
  return node.type !== "directive" || node.name !== "endnote";
}

function commentTarget(node: DirectiveNode): string | undefined {
  return (
    stringAttr(node.attrs, "for") ??
    stringAttr(node.attrs, "parent") ??
    stringAttr(node.attrs, "target") ??
    stringAttr(node.attrs, "block") ??
    stringAttr(node.attrs, "ref")
  );
}

function changeRequestTarget(node: DirectiveNode): string | undefined {
  return (
    stringAttr(node.attrs, "target") ??
    stringAttr(node.attrs, "for") ??
    stringAttr(node.attrs, "parent") ??
    stringAttr(node.attrs, "block") ??
    stringAttr(node.attrs, "ref")
  );
}

function footnoteTarget(node: DirectiveNode): string | undefined {
  return (
    stringAttr(node.attrs, "for") ??
    stringAttr(node.attrs, "parent") ??
    stringAttr(node.attrs, "target") ??
    stringAttr(node.attrs, "block") ??
    stringAttr(node.attrs, "ref")
  );
}

function endnoteTarget(node: DirectiveNode): string | undefined {
  return (
    stringAttr(node.attrs, "for") ??
    stringAttr(node.attrs, "parent") ??
    stringAttr(node.attrs, "target") ??
    stringAttr(node.attrs, "block") ??
    stringAttr(node.attrs, "ref")
  );
}

function commentReplyTarget(node: DirectiveNode): string | undefined {
  return (
    stringAttr(node.attrs, "reply_to") ??
    stringAttr(node.attrs, "replyTo") ??
    stringAttr(node.attrs, "reply")
  );
}

function commentIsDeleted(node: DirectiveNode): boolean {
  return reviewDirectiveIsDeleted(node);
}

function noteIsDeleted(node: DirectiveNode): boolean {
  return reviewDirectiveIsDeleted(node);
}

function changeRequestIsDeleted(node: DirectiveNode): boolean {
  return reviewDirectiveIsDeleted(node);
}

function reviewDirectiveIsDeleted(node: DirectiveNode): boolean {
  const status = stringAttr(node.attrs, "status")?.toLowerCase();
  return status === "deleted" || status === "withdrawn";
}

function targetedCommentOptions(node: Node, ctx: DocxCtx): Pick<ParagraphOptions, "commentIds" | "bookmarkIds" | "footnoteIds" | "endnoteIds"> {
  const comments = targetedCommentsForNode(node, ctx);
  const changeRequestComments = targetedChangeRequestCommentsForNode(node, ctx);
  const footnotes = targetedFootnotesForNode(node, ctx);
  const endnotes = targetedEndnotesForNode(node, ctx);
  if (comments.length === 0 && changeRequestComments.length === 0 && footnotes.length === 0 && endnotes.length === 0) return {};
  const bookmarkIds = [
    ...comments.map((comment) => comment.sourceId),
    ...footnotes.map((footnote) => footnote.sourceId),
    ...endnotes.map((endnote) => endnote.sourceId),
  ]
    .filter((id): id is string => Boolean(id));
  const commentIds = [
    ...comments.map((comment) => comment.id),
    ...changeRequestComments.map((comment) => comment.id),
  ];
  return {
    commentIds,
    footnoteIds: footnotes.map((footnote) => footnote.id),
    endnoteIds: endnotes.map((endnote) => endnote.id),
    ...(bookmarkIds.length > 0 ? { bookmarkIds } : {}),
  };
}

function targetedCommentsForNode(node: Node, ctx: DocxCtx): DocxComment[] {
  const keys = [
    ...(node.id ? [node.id] : []),
    ...(node.aliases ?? []),
  ];
  const comments: DocxComment[] = [];
  for (const key of keys) {
    for (const comment of ctx.targetedComments.get(key) ?? []) {
      if (ctx.anchoredCommentIds.has(comment.id)) continue;
      ctx.anchoredCommentIds.add(comment.id);
      comments.push(comment);
    }
  }
  return comments;
}

function targetedChangeRequestCommentsForNode(node: Node, ctx: DocxCtx): DocxComment[] {
  const keys = [
    ...(node.id ? [node.id] : []),
    ...(node.aliases ?? []),
  ];
  const comments: DocxComment[] = [];
  for (const key of keys) {
    for (const comment of ctx.targetedChangeRequestComments.get(key) ?? []) {
      if (ctx.anchoredChangeRequestCommentIds.has(comment.id)) continue;
      ctx.anchoredChangeRequestCommentIds.add(comment.id);
      comments.push(comment);
    }
  }
  return comments;
}

function targetedFootnotesForNode(node: Node, ctx: DocxCtx): DocxFootnote[] {
  const keys = [
    ...(node.id ? [node.id] : []),
    ...(node.aliases ?? []),
  ];
  const footnotes: DocxFootnote[] = [];
  for (const key of keys) {
    for (const footnote of ctx.targetedFootnotes.get(key) ?? []) {
      if (ctx.anchoredFootnoteIds.has(footnote.id)) continue;
      ctx.anchoredFootnoteIds.add(footnote.id);
      footnotes.push(footnote);
    }
  }
  return footnotes;
}

function targetedEndnotesForNode(node: Node, ctx: DocxCtx): DocxEndnote[] {
  const keys = [
    ...(node.id ? [node.id] : []),
    ...(node.aliases ?? []),
  ];
  const endnotes: DocxEndnote[] = [];
  for (const key of keys) {
    for (const endnote of ctx.targetedEndnotes.get(key) ?? []) {
      if (ctx.anchoredEndnoteIds.has(endnote.id)) continue;
      ctx.anchoredEndnoteIds.add(endnote.id);
      endnotes.push(endnote);
    }
  }
  return endnotes;
}

function renderAnchoredChangeRequests(node: Node, ctx: DocxCtx): string {
  const requests = targetedChangeRequestsForNode(node, ctx);
  return requests.map((request) => renderChangeRequestBlock(request, ctx)).join("");
}

function targetedChangeRequestsForNode(node: Node, ctx: DocxCtx): DirectiveNode[] {
  const keys = [
    ...(node.id ? [node.id] : []),
    ...(node.aliases ?? []),
  ];
  const requests: DirectiveNode[] = [];
  for (const key of keys) {
    for (const request of ctx.targetedChangeRequests.get(key) ?? []) {
      if (ctx.anchoredChangeRequestNodes.has(request)) continue;
      ctx.anchoredChangeRequestNodes.add(request);
      requests.push(request);
    }
  }
  return requests;
}

function collectPageSetup(doc: DocumentNode): PageSetup {
  for (const node of walk(doc)) {
    if (node.type === "directive" && node.name === "page_setup") return pageSetupFromAttrs(node.attrs);
  }
  return DEFAULT_PAGE_SETUP;
}

function renderPageSetup(node: DirectiveNode, ctx: DocxCtx): string {
  const previous = ctx.pageSetup;
  const next = pageSetupFromAttrs(node.attrs, previous);
  ctx.pageSetup = next;
  if (samePageSetup(previous, next)) {
    return node.id ? paragraph("", { style: "NomaMeta", bookmarkId: node.id }) : "";
  }
  return paragraph("", {
    style: "NomaMeta",
    bookmarkId: node.id,
    sectionProperties: sectionPropertiesXml(ctx, previous),
  });
}

function collectSettingsFeatures(
  doc: DocumentNode,
  headerFooter: { header?: HeaderFooterPart; footer?: HeaderFooterPart },
): SettingsFeatures {
  let updateFields = Boolean(
    headerFooter.header?.pageNumbers ||
    headerFooter.header?.totalPages ||
    headerFooter.footer?.pageNumbers ||
    headerFooter.footer?.totalPages,
  );
  let revisionView = false;
  let protection: DocumentProtection | undefined;
  const commentNodes = commentNodesById(doc);
  for (const node of walk(doc)) {
    if (node.type !== "directive") continue;
    if (node.name === "toc" || hasCaptionSequenceField(node)) updateFields = true;
    if (node.name === "comment" && commentExportsToDocx(node, commentNodes)) revisionView = true;
    if (node.name === "change_request" && changeRequestExportsNativeRevision(node)) revisionView = true;
    if (node.name === "doc_protection") protection = documentProtectionFromAttrs(node.attrs);
  }
  return { updateFields, revisionView, protection };
}

function documentProtectionFromAttrs(attrs: Attrs): DocumentProtection {
  return {
    edit: documentProtectionEdit(attrs),
    enforcement: documentProtectionEnforcement(attrs),
  };
}

function documentProtectionEdit(attrs: Attrs): DocumentProtection["edit"] {
  const raw = (attrText(attrs, "edit") ?? attrText(attrs, "mode") ?? "forms").trim().toLowerCase();
  switch (raw.replace(/[\s_-]+/g, "")) {
    case "readonly":
      return "readOnly";
    case "comment":
    case "comments":
      return "comments";
    case "trackedchange":
    case "trackedchanges":
    case "trackchanges":
    case "revision":
    case "revisions":
      return "trackedChanges";
    case "form":
    case "forms":
    case "fill":
    case "fillforms":
    default:
      return "forms";
  }
}

function documentProtectionEnforcement(attrs: Attrs): boolean {
  const value = attrs.enforcement ?? attrs.enforced;
  if (value === undefined) return true;
  if (typeof value === "boolean") return value;
  const normalized = String(value).trim().toLowerCase();
  return normalized !== "false" && normalized !== "0" && normalized !== "no" && normalized !== "off";
}

function hasCaptionSequenceField(node: DirectiveNode): boolean {
  if (node.name === "figure" || node.name === "plot" || node.name === "computed_plot") return true;
  if (node.name !== "table") return false;
  return Boolean(stringAttr(node.attrs, "title") ?? stringAttr(node.attrs, "caption"));
}

function pageSetupFromAttrs(attrs: Attrs, base: PageSetup = DEFAULT_PAGE_SETUP): PageSetup {
  const size = pageSize(attrs, base);
  const hasSizeOverride = hasAttr(attrs, "size") || hasAttr(attrs, "page_size") || hasAttr(attrs, "width") || hasAttr(attrs, "height");
  const orientationAttr = stringAttr(attrs, "orientation");
  const orientation = orientationAttr === "landscape"
    ? "landscape"
    : orientationAttr === "portrait"
      ? undefined
      : hasSizeOverride
        ? undefined
        : base.orientation;
  const dimensions = orientation === "landscape"
    ? { width: Math.max(size.width, size.height), height: Math.min(size.width, size.height) }
    : { width: Math.min(size.width, size.height), height: Math.max(size.width, size.height) };
  const sharedMargin = lengthAttr(attrs, ["margin"], undefined);
  return {
    ...dimensions,
    ...(orientation ? { orientation } : {}),
    margins: {
      top: lengthAttr(attrs, ["margin_top", "top"], sharedMargin ?? base.margins.top) ?? base.margins.top,
      right: lengthAttr(attrs, ["margin_right", "right"], sharedMargin ?? base.margins.right) ?? base.margins.right,
      bottom: lengthAttr(attrs, ["margin_bottom", "bottom"], sharedMargin ?? base.margins.bottom) ?? base.margins.bottom,
      left: lengthAttr(attrs, ["margin_left", "left"], sharedMargin ?? base.margins.left) ?? base.margins.left,
      header: lengthAttr(attrs, ["header_margin", "header"], base.margins.header) ?? base.margins.header,
      footer: lengthAttr(attrs, ["footer_margin", "footer"], base.margins.footer) ?? base.margins.footer,
      gutter: lengthAttr(attrs, ["gutter"], base.margins.gutter) ?? base.margins.gutter,
    },
  };
}

function samePageSetup(a: PageSetup, b: PageSetup): boolean {
  return a.width === b.width &&
    a.height === b.height &&
    a.orientation === b.orientation &&
    a.margins.top === b.margins.top &&
    a.margins.right === b.margins.right &&
    a.margins.bottom === b.margins.bottom &&
    a.margins.left === b.margins.left &&
    a.margins.header === b.margins.header &&
    a.margins.footer === b.margins.footer &&
    a.margins.gutter === b.margins.gutter;
}

function pageSize(attrs: Attrs, base: PageSetup = DEFAULT_PAGE_SETUP): { width: number; height: number } {
  const width = lengthAttr(attrs, ["width"], undefined);
  const height = lengthAttr(attrs, ["height"], undefined);
  if (width !== undefined && height !== undefined) return { width, height };
  const nameAttr = stringAttr(attrs, "size") ?? stringAttr(attrs, "page_size");
  if (!nameAttr) return { width: base.width, height: base.height };
  const name = nameAttr.toLowerCase();
  if (name === "a4") return { width: 11906, height: 16838 };
  if (name === "legal") return { width: 12240, height: 20160 };
  return { width: 12240, height: 15840 };
}

function pageSizeXml(setup: PageSetup): string {
  const orient = setup.orientation ? ` w:orient="${setup.orientation}"` : "";
  return `<w:pgSz w:w="${setup.width}" w:h="${setup.height}"${orient}/>`;
}

function pageMarginsXml(margins: PageMargins): string {
  return `<w:pgMar w:top="${margins.top}" w:right="${margins.right}" w:bottom="${margins.bottom}" w:left="${margins.left}" w:header="${margins.header}" w:footer="${margins.footer}" w:gutter="${margins.gutter}"/>`;
}

function collectHeaderFooter(doc: DocumentNode): { header?: HeaderFooterPart; footer?: HeaderFooterPart } {
  let header: HeaderFooterPart | undefined;
  let footer: HeaderFooterPart | undefined;
  for (const node of walk(doc)) {
    if (node.type !== "directive") continue;
    if (node.name === "header" && !header) header = headerFooterPart(node);
    if (node.name === "footer" && !footer) footer = headerFooterPart(node);
  }
  return { ...(header ? { header } : {}), ...(footer ? { footer } : {}) };
}

function headerFooterPart(node: DirectiveNode): HeaderFooterPart {
  const align = alignAttr(node.attrs);
  return {
    ...(node.id ? { id: node.id } : {}),
    ...(node.body !== undefined ? { body: node.body } : {}),
    children: node.children,
    ...(align ? { align } : {}),
    pageNumbers: boolAttr(node.attrs, "page_numbers") || boolAttr(node.attrs, "page_number"),
    totalPages: boolAttr(node.attrs, "total_pages") || boolAttr(node.attrs, "page_count"),
  };
}

function headerFooterXml(tag: "hdr" | "ftr", part: HeaderFooterPart, ctx: DocxCtx): string {
  const scope = tag === "hdr" ? "header" : "footer";
  return withRelationshipScope(ctx, scope, () => xmlDecl(`\
<w:${tag} xmlns:w="${W_NS}" xmlns:r="${R_NS}" xmlns:wp="${WP_NS}" xmlns:a="${A_NS}" xmlns:pic="${PIC_NS}" xmlns:m="${M_NS}">
${renderHeaderFooterContent(part, ctx)}</w:${tag}>`));
}

function renderHeaderFooterContent(part: HeaderFooterPart, ctx: DocxCtx): string {
  const align = part.align ?? (part.pageNumbers ? "right" : undefined);
  const body = renderHeaderFooterBody(part, ctx);
  const page = part.pageNumbers
    ? paragraph(pageNumberRuns(part.totalPages), { align, bookmarkId: body ? undefined : part.id })
    : "";
  if (!body && !page) return paragraph("", { bookmarkId: part.id });
  return body + page;
}

function renderHeaderFooterBody(part: HeaderFooterPart, ctx: DocxCtx): string {
  if (part.children.length > 0) {
    const marker = part.id ? paragraph("", { bookmarkId: part.id }) : "";
    return marker + part.children.map((child) => renderNode(child, ctx)).join("");
  }
  const text = (part.body ?? "").trim();
  if (!text) return "";
  return text
    .split(/\n\s*\n/)
    .map((para, index) =>
      paragraph(inlineRuns(para.replace(/\n/g, " "), ctx), {
        align: part.align,
        bookmarkId: index === 0 ? part.id : undefined,
      }),
    )
    .join("");
}

function pageNumberRuns(totalPages: boolean): string {
  return textRun("Page ") + fieldRun("PAGE", "1") + (totalPages ? textRun(" of ") + fieldRun("NUMPAGES", "1") : "");
}

function fieldRun(instruction: string, placeholder: string, style: RunStyle = {}): string {
  return `<w:r><w:fldChar w:fldCharType="begin"/></w:r><w:r><w:instrText xml:space="preserve"> ${xmlText(instruction)} </w:instrText></w:r><w:r><w:fldChar w:fldCharType="separate"/></w:r>${textRun(placeholder, style)}<w:r><w:fldChar w:fldCharType="end"/></w:r>`;
}

function tabRun(): string {
  return "<w:r><w:tab/></w:r>";
}

function renderCode(content: string, lang?: string): string {
  const head = lang ? paragraph(textRun(`Code (${lang})`, { bold: true }), { style: "NomaMeta" }) : "";
  const lines = splitLines(content);
  return head + lines.map((line) => paragraph(textRun(line, { code: true }), { style: "NomaCode" })).join("");
}

function renderCodeDirective(node: DirectiveNode, ctx: DocxCtx): string {
  const frame = directiveFrame(node);
  const heading = paragraph(editableLabelRuns(codeDirectiveTitle(node), ctx, { color: frame?.color ?? "46505A" }), {
    style: "NomaDirective",
    bookmarkId: node.id,
    ...targetedCommentOptions(node, ctx),
    frame,
  });
  const body = node.body?.trim()
    ? renderCodeBody(node.body, frame)
    : renderDirectiveContent(node, ctx, frame);
  return heading + body;
}

function renderCodeCell(node: DirectiveNode, ctx: DocxCtx): string {
  const frame = directiveFrame(node);
  const language = attrText(node.attrs, "lang") ?? attrText(node.attrs, "language");
  const label = language ? `Code cell (${language})` : "Code cell";
  const heading = paragraph(textRun(label, { bold: true, color: frame?.color ?? "46505A" }), {
    style: "NomaDirective",
    bookmarkId: node.id,
    ...targetedCommentOptions(node, ctx),
    frame,
  });
  const meta = joinMetaRuns([
    metaTextField("kernel", attrText(node.attrs, "kernel") ?? attrText(node.attrs, "runtime"), ctx),
    metaTextField("status", attrText(node.attrs, "status"), ctx),
    metaTextField("execution", attrText(node.attrs, "execution_count") ?? attrText(node.attrs, "count"), ctx),
  ]);
  const metaParagraph = meta ? paragraph(meta, { style: "NomaMeta", frame }) : "";
  const body = node.body?.trim()
    ? renderCodeBody(node.body, frame)
    : renderDirectiveContent(node, ctx, frame);
  return heading + metaParagraph + body;
}

function renderOutputBlock(node: DirectiveNode, ctx: DocxCtx): string {
  const frame = directiveFrame(node);
  const kind = attrText(node.attrs, "type") ?? attrText(node.attrs, "mime") ?? attrText(node.attrs, "format");
  const label = kind ? `Output (${kind})` : "Output";
  const heading = paragraph(textRun(label, { bold: true, color: frame?.color ?? "46505A" }), {
    style: "NomaDirective",
    bookmarkId: node.id,
    ...targetedCommentOptions(node, ctx),
    frame,
  });
  const meta = joinMetaRuns([
    metaReferenceField("for", attrText(node.attrs, "for") ?? attrText(node.attrs, "cell") ?? attrText(node.attrs, "source"), ctx),
    metaTextField("status", attrText(node.attrs, "status"), ctx),
    metaTextField("mime", attrText(node.attrs, "mime"), ctx),
  ]);
  const metaParagraph = meta ? paragraph(meta, { style: "NomaMeta", frame }) : "";
  const body = node.body?.trim()
    ? renderCodeBody(node.body, frame)
    : renderDirectiveContent(node, ctx, frame);
  return heading + metaParagraph + body;
}

function renderCodeBody(body: string, frame?: ParagraphFrame): string {
  if (!body.trim()) return "";
  return splitLines(body).map((line) => paragraph(textRun(line, { code: true }), { style: "NomaCode", frame })).join("");
}

function renderVerbatimDirective(node: DirectiveNode, ctx: DocxCtx): string {
  const label = paragraph(editableLabelRuns(directiveTitle(node), ctx, { color: "3f5f4a" }), {
    style: "NomaDirective",
    bookmarkId: node.id,
    ...targetedCommentOptions(node, ctx),
  });
  const body = node.body ?? "";
  if (!body.trim()) return label;
  return label + splitLines(body).map((line) => paragraph(textRun(line, { code: true }), { style: "NomaCode" })).join("");
}

function renderMath(node: DirectiveNode, ctx: DocxCtx): string {
  const source = directiveBodyText(node, "").trim();
  const display = stringAttr(node.attrs, "display") !== "inline";
  const runs = source ? officeMathRun(source) : textRun("Equation", { italic: true, color: "6D7770" });
  return paragraph(runs, {
    style: "NomaMath",
    align: display ? "center" : undefined,
    bookmarkId: node.id,
    ...targetedCommentOptions(node, ctx),
  });
}

function officeMathRun(source: string): string {
  const linear = source.replace(/\r\n?/g, "\n").split("\n").map((line) => line.trim()).filter(Boolean).join(" ");
  return `<m:oMath><m:r><m:rPr><m:nor/></m:rPr><m:t>${xmlText(linear)}</m:t></m:r></m:oMath>`;
}

function renderToc(node: DirectiveNode, ctx: DocxCtx): string {
  const kind = tocKind(node);
  const title = stringAttr(node.attrs, "title") ?? tocTitle(kind);
  const label = paragraph(editableLabelRuns(title, ctx, { color: "203C2F" }), {
    style: "NomaDirective",
    bookmarkId: node.id,
    ...targetedCommentOptions(node, ctx),
  });
  if (kind !== "sections") {
    const entries = ctx.captions
      .filter((entry) => entry.kind === kind)
      .map((entry) =>
        paragraph(captionTocEntryRuns(entry, ctx), {
          style: "NomaToc",
          tabRight: usableTableWidth(ctx.pageSetup),
        }),
      )
      .join("");
    return label + (entries || paragraph(textRun(`No ${kind} found.`), { style: "NomaMeta" }));
  }
  const maxLevel = readPositiveInteger(node.attrs.depth) ?? readPositiveInteger(node.attrs.levels) ?? 3;
  const entries = ctx.sections
    .filter((entry) => entry.level <= maxLevel)
    .map((entry) =>
      paragraph(tocEntryRuns(entry, ctx), {
        style: "NomaToc",
        indentLeft: Math.max(0, entry.level - 1) * 360,
        tabRight: usableTableWidth(ctx.pageSetup),
      }),
    )
    .join("");
  return label + (entries || paragraph(textRun("No sections found."), { style: "NomaMeta" }));
}

function tocKind(node: DirectiveNode): "sections" | "figures" | "tables" | "plots" {
  const raw = (
    stringAttr(node.attrs, "of") ??
    stringAttr(node.attrs, "kind") ??
    stringAttr(node.attrs, "type") ??
    "sections"
  ).toLowerCase();
  if (raw === "figure" || raw === "figures") return "figures";
  if (raw === "table" || raw === "tables") return "tables";
  if (raw === "plot" || raw === "plots" || raw === "charts") return "plots";
  return "sections";
}

function tocTitle(kind: "sections" | "figures" | "tables" | "plots"): string {
  if (kind === "figures") return "List of Figures";
  if (kind === "tables") return "List of Tables";
  if (kind === "plots") return "List of Plots";
  return "Contents";
}

function renderPlot(node: DirectiveNode, ctx: DocxCtx): string {
  const title = typeof node.attrs.title === "string" ? node.attrs.title : "Plot";
  const source = node.attrs.dataset ?? node.attrs.data ?? node.attrs.src ?? "";
  const type = node.attrs.type ? String(node.attrs.type) : "line";
  const details = source ? `${type} plot, source: ${String(source)}` : `${type} plot`;
  const label = captionParagraph(`Plot: ${title}`, node, ctx);
  const plot = renderPlotSvgForNode(node, ctx.datasets);
  if (plot.totalPoints < 2) return label + paragraph(inlineRuns(details, ctx), { style: "NomaMeta" });

  const svg = plot.svg.replace(/\bcurrentColor\b/g, "#2B5265");
  const media = addMedia(ctx, {
    contentType: "image/svg+xml",
    extension: "svg",
    data: Buffer.from(svg, "utf8"),
    widthPx: plot.width,
    heightPx: plot.height,
  });
  const figure = paragraph(imageRun(media, extentFromPixels(plot.width, plot.height, ctx.pageSetup), inlineToPlain(title), ctx), { align: "center" });
  const meta = paragraph(inlineRuns(`${plot.type} plot, ${plot.sourceLabel}`, ctx), { style: "NomaMeta" });
  return figure + label + meta;
}

function renderFigure(node: DirectiveNode, ctx: DocxCtx): string {
  const caption = typeof node.attrs.caption === "string" ? node.attrs.caption : "Figure";
  const src = typeof node.attrs.src === "string" ? node.attrs.src : "";
  const image = figureImage(node, ctx);
  const body = renderDirectiveContent(node, ctx);
  const imageParagraph = image
    ? paragraph(imageRun(image.media, image.extent, inlineToPlain(stringAttr(node.attrs, "alt") ?? caption), ctx), { align: alignAttr(node.attrs) })
    : "";
  const source = src && !src.startsWith("data:")
    ? paragraph(inlineRuns(`Source: [${src}](${src})`, ctx), { style: "NomaMeta" })
    : "";
  const label = captionParagraph(`Figure: ${caption}`, node, ctx);
  return imageParagraph ? imageParagraph + label + source + body : label + source + body;
}

function captionParagraph(label: string, node: DirectiveNode, ctx: DocxCtx): string {
  const style: RunStyle = { color: "46505A" };
  return paragraph(captionRuns(label, style, ctx), {
    style: "NomaCaption",
    bookmarkId: node.id,
    ...targetedCommentOptions(node, ctx),
  });
}

function captionRuns(label: string, style: RunStyle, ctx: DocxCtx): string {
  const match = /^(Figure|Table|Plot|Computed plot):\s*(.+)$/i.exec(label);
  if (!match) return inlineRuns(label, ctx, style);
  const kind = match[1] ?? "";
  const caption = match[2] ?? "";
  const display = kind.charAt(0).toUpperCase() + kind.slice(1).toLowerCase();
  const sequence = display === "Computed plot" ? "Plot" : display;
  return inlineRuns(`${display} `, ctx, style) +
    fieldRun(`SEQ ${sequence} \\* ARABIC`, "1", style) +
    inlineRuns(`: ${caption}`, ctx, style);
}

function renderDataset(node: DirectiveNode, ctx: DocxCtx): string {
  const title = datasetTitle(node);
  const label = paragraph(editableLabelRuns(title, ctx, { color: "2B5265" }), {
    style: "NomaDirective",
    bookmarkId: node.id,
    ...targetedCommentOptions(node, ctx),
  });
  const table = node.id ? ctx.datasets.get(node.id) : undefined;
  if (!table || table.rows.length === 0) return renderVerbatimDirective(node, ctx);
  const columns = datasetColumns(table);
  const widths = tableWidths(columns.length, ctx.pageSetup);
  const header = tableRow(columns, ctx, widths, { header: true });
  const rows = table.rows
    .map((row) => tableRow(columns.map((_column, index) => datasetCellText(row[index])), ctx, widths, {}))
    .join("");
  return label + tableXml(header + rows, widths) + paragraph(datasetMetaRuns(node, table, ctx), { style: "NomaMeta" });
}

function datasetTitle(node: DirectiveNode): string {
  const title = stringAttr(node.attrs, "title");
  if (title) return `Dataset: ${title}`;
  if (node.id) return `Dataset: ${node.id}`;
  return "Dataset";
}

function datasetColumns(table: DatasetTable): string[] {
  const width = Math.max(table.columns.length, ...table.rows.map((row) => row.length), 1);
  const columns = table.columns.length > 0 ? [...table.columns] : [];
  while (columns.length < width) columns.push(`Column ${columns.length + 1}`);
  return columns.slice(0, width);
}

function datasetCellText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return String(value);
  return JSON.stringify(value);
}

function datasetMetaRuns(node: DirectiveNode, table: DatasetTable, ctx: DocxCtx): string {
  return joinMetaRuns([
    textRun(`${table.rows.length} row${table.rows.length === 1 ? "" : "s"}`),
    metaTextField("format", stringAttr(node.attrs, "format"), ctx),
    metaTextField("source", stringAttr(node.attrs, "src"), ctx),
  ]);
}

function renderMetric(node: DirectiveNode, ctx: DocxCtx): string {
  const frame = directiveFrame(node);
  const label = metricLabel(node);
  const valueAttr =
    attrText(node.attrs, "value") ??
    attrText(node.attrs, "current") ??
    attrText(node.attrs, "amount");
  const bodyValue = directiveBodyText(node, "").trim();
  const value = valueAttr ?? bodyValue;
  const usedBodyAsValue = valueAttr === undefined && bodyValue.length > 0;
  const headingStyle = { color: frame?.color ?? "2B5265" };
  const heading = paragraph(inlineRuns(`Metric: ${label}`, ctx, headingStyle), {
    style: "NomaDirective",
    bookmarkId: node.id,
    ...targetedCommentOptions(node, ctx),
    frame,
  });
  const valueParagraph = value
    ? paragraph(metricValueRuns(value, attrText(node.attrs, "unit"), ctx, { color: frame?.color ?? "2B5265" }), { style: "NomaMetricValue", frame })
    : "";
  const body = usedBodyAsValue ? "" : renderDirectiveContent(node, ctx, frame);
  const meta = metricMetaRuns(node, ctx);
  const metaParagraph = meta ? paragraph(meta, { style: "NomaMeta", frame }) : "";
  return heading + valueParagraph + body + metaParagraph;
}

function metricLabel(node: DirectiveNode): string {
  return attrText(node.attrs, "label") ?? attrText(node.attrs, "title") ?? attrText(node.attrs, "name") ?? node.id ?? "Metric";
}

function metricValueText(value: string, unit: string | undefined): string {
  if (!unit || value.endsWith(unit)) return value;
  if (/^[%°]/.test(unit)) return `${value}${unit}`;
  return `${value} ${unit}`;
}

function metricValueRuns(value: string, unit: string | undefined, ctx: DocxCtx, style: RunStyle): string {
  return inlineRuns(metricValueText(value, unit), ctx, style);
}

function metricMetaRuns(node: DirectiveNode, ctx: DocxCtx): string {
  return joinMetaRuns([
    metaTextField("status", attrText(node.attrs, "status"), ctx),
    metaTextField("trend", attrText(node.attrs, "trend"), ctx),
    metaTextField("change", attrText(node.attrs, "change") ?? attrText(node.attrs, "delta"), ctx),
    metaTextField("target", attrText(node.attrs, "target"), ctx),
    metaReferenceField("source", attrText(node.attrs, "source"), ctx),
    metaTextField("as of", attrText(node.attrs, "as_of") ?? attrText(node.attrs, "asOf") ?? attrText(node.attrs, "date"), ctx),
  ]);
}

function renderComputedMetric(node: DirectiveNode, ctx: DocxCtx): string {
  const frame = directiveFrame(node);
  const label = computedLabel(node, "Computed metric");
  const value = evaluateComputedNode(node, ctx.computed);
  const unit = attrText(node.attrs, "unit") ?? attrText(node.attrs, "suffix") ?? bodyFieldText(node, "unit");
  const headingStyle = { color: frame?.color ?? "2B5265" };
  const heading = paragraph(inlineRuns(`Computed metric: ${label}`, ctx, headingStyle), {
    style: "NomaDirective",
    bookmarkId: node.id,
    ...targetedCommentOptions(node, ctx),
    frame,
  });
  const valueParagraph = value !== undefined
    ? paragraph(textRun(metricValueText(formatComputedNumber(value), unit), { color: frame?.color ?? "2B5265" }), { style: "NomaMetricValue", frame })
    : paragraph(textRun("No default value could be evaluated.", { italic: true, color: "7E8B96" }), { style: "NomaMeta", frame });
  const meta = computedMetaRuns(node, ctx);
  const metaParagraph = meta ? paragraph(meta, { style: "NomaMeta", frame }) : "";
  return heading + valueParagraph + computedBody(node, ctx, frame) + metaParagraph;
}

function renderComputedPlot(node: DirectiveNode, ctx: DocxCtx): string {
  const title = computedLabel(node, "Computed plot");
  const series = evaluateComputedSeries(node, ctx.computed);
  const label = captionParagraph(`Computed plot: ${title}`, node, ctx);
  const meta = computedMetaRuns(node, ctx);
  const metaParagraph = meta ? paragraph(meta, { style: "NomaMeta" }) : "";
  const body = computedBody(node, ctx);
  if (!series || series.values.length < 2) {
    return label + metaParagraph + paragraph(textRun("No default series could be evaluated.", { italic: true, color: "7E8B96" }), { style: "NomaMeta" }) + body;
  }

  const plotNode: DirectiveNode = {
    type: "directive",
    name: "plot",
    id: node.id,
    attrs: {
      ...node.attrs,
      title,
      data: series.values.map((value) => String(value)).join(","),
      xlabels: series.points.map(formatComputedNumber).join(","),
    },
    children: [],
  };
  const plot = renderPlotSvgForNode(plotNode, ctx.datasets);
  if (plot.totalPoints < 2) return label + metaParagraph + body;

  const svg = plot.svg.replace(/\bcurrentColor\b/g, "#2B5265");
  const media = addMedia(ctx, {
    contentType: "image/svg+xml",
    extension: "svg",
    data: Buffer.from(svg, "utf8"),
    widthPx: plot.width,
    heightPx: plot.height,
  });
  const figure = paragraph(imageRun(media, extentFromPixels(plot.width, plot.height, ctx.pageSetup), inlineToPlain(title), ctx), { align: "center" });
  const seriesMeta = paragraph(textRun(`${plot.type} computed plot, ${series.values.length} points`), { style: "NomaMeta" });
  return figure + label + metaParagraph + seriesMeta + body;
}

function computedLabel(node: DirectiveNode, fallback: string): string {
  return attrText(node.attrs, "label") ??
    attrText(node.attrs, "title") ??
    attrText(node.attrs, "name") ??
    bodyFieldText(node, "label") ??
    bodyFieldText(node, "title") ??
    node.id ??
    fallback;
}

function computedMetaRuns(node: DirectiveNode, ctx: DocxCtx): string {
  return joinMetaRuns([
    metaTextField("formula", formulaText(node), ctx),
    metaTextField("domain", computedDomainText(node), ctx),
    metaTextField("unit", attrText(node.attrs, "unit") ?? attrText(node.attrs, "suffix") ?? bodyFieldText(node, "unit"), ctx),
  ]);
}

function computedBody(node: DirectiveNode, ctx: DocxCtx, frame?: DirectiveFrame): string {
  const hasStructuredChildren = node.children.some((child) => child.type !== "paragraph");
  if (hasStructuredChildren) return renderDirectiveContent(node, ctx, frame);

  const filtered = computedFreeformBody(node.body ?? "");
  return filtered ? renderBodyParagraphs(filtered, ctx, frame) : "";
}

const COMPUTED_BODY_FIELDS = new Set(["formula", "domain", "range", "title", "label", "unit"]);

function computedFreeformBody(body: string): string {
  return body
    .split(/\r?\n/)
    .filter((line) => {
      const match = /^\s*([A-Za-z_][\w.-]*)\s*:/.exec(line);
      if (!match) return true;
      return !COMPUTED_BODY_FIELDS.has(match[1]!.toLowerCase());
    })
    .join("\n")
    .trim();
}

function figureImage(
  node: DirectiveNode,
  ctx: DocxCtx,
): { media: DocxMedia; extent: { cx: number; cy: number } } | undefined {
  const src = stringAttr(node.attrs, "src");
  const dataUri = stringAttr(node.attrs, "data") ?? (src?.startsWith("data:") ? src : undefined);
  if (!dataUri) return undefined;
  const decoded = decodeImageDataUri(dataUri);
  if (!decoded) return undefined;
  const media = addMedia(ctx, decoded);
  return { media, extent: imageExtent(media, node.attrs, ctx.pageSetup) };
}

function renderCitation(node: DirectiveNode, ctx: DocxCtx): string {
  const frame = directiveFrame(node);
  const title = citationTitle(node);
  const label = paragraph(editableLabelRuns(title, ctx, { color: frame?.color ?? "5b4620" }), {
    style: "NomaDirective",
    bookmarkId: node.id,
    ...targetedCommentOptions(node, ctx),
    frame,
  });
  const lines: string[] = [];
  const source = stringAttr(node.attrs, "source");
  const accessed = stringAttr(node.attrs, "accessed");
  const url = stringAttr(node.attrs, "url") ?? stringAttr(node.attrs, "href");
  const doi = stringAttr(node.attrs, "doi");
  if (source) lines.push(`Source: ${source}`);
  if (accessed) lines.push(`Accessed: ${accessed}`);
  const meta = lines.length > 0
    ? paragraph(inlineRuns(lines.join(" · "), ctx), { style: "NomaMeta", frame })
    : "";
  const links = [
    url ? paragraph(inlineRuns(`URL: [${url}](${url})`, ctx), { style: "NomaMeta", frame }) : "",
    doi ? paragraph(inlineRuns(`DOI: [${doi}](https://doi.org/${doi})`, ctx), { style: "NomaMeta", frame }) : "",
  ].join("");
  return label + meta + links + renderDirectiveContent(node, ctx, frame);
}

function renderBibliography(node: DirectiveNode, ctx: DocxCtx): string {
  const frame = directiveFrame(node);
  const title = stringAttr(node.attrs, "title") ?? "Bibliography";
  const label = paragraph(editableLabelRuns(title, ctx, { color: frame?.color ?? "5B4620" }), {
    style: "NomaDirective",
    bookmarkId: node.id,
    ...targetedCommentOptions(node, ctx),
    frame,
  });
  const intro = renderDirectiveContent(node, ctx, frame);
  const items = ctx.citations.length > 0
    ? ctx.citations.map((entry) => paragraph(citationEntryRuns(entry, ctx), { numId: 2, frame })).join("")
    : paragraph(textRun("No citations found."), { style: "NomaMeta", frame });
  return label + intro + items;
}

function renderPageBreak(node: DirectiveNode, ctx: DocxCtx): string {
  return paragraph(`<w:r><w:br w:type="page"/></w:r>`, {
    bookmarkId: node.id,
    ...targetedCommentOptions(node, ctx),
  });
}

function renderComment(node: DirectiveNode, ctx: DocxCtx): string {
  if (ctx.targetedCommentNodes.has(node)) return "";
  if (commentIsDeleted(node)) return "";
  if (commentReplyTarget(node)) return "";
  const comment = ensureComment(node, ctx);
  const frame = directiveFrame(node);
  const target = commentTarget(node);
  const label = target ? `Comment on ${target}` : "Comment";
  const runs = `<w:commentRangeStart w:id="${comment.id}"/>${textRun(label, { bold: true, color: frame?.color ?? "6B4B13" })}<w:commentRangeEnd w:id="${comment.id}"/><w:r><w:commentReference w:id="${comment.id}"/></w:r>`;
  return paragraph(runs, { style: "NomaDirective", bookmarkId: node.id, frame });
}

function renderFootnote(node: DirectiveNode, ctx: DocxCtx): string {
  if (ctx.targetedFootnoteNodes.has(node)) return "";
  if (noteIsDeleted(node)) return "";
  const footnote = addFootnote(node, ctx);
  const frame = directiveFrame(node);
  const label = stringAttr(node.attrs, "label") ?? "Footnote";
  const runs = editableLabelRuns(label, ctx, { color: frame?.color ?? "5B4620" }) + footnoteReferenceRun(footnote.id);
  return paragraph(runs, {
    style: "NomaDirective",
    bookmarkId: node.id,
    ...targetedCommentOptions(node, ctx),
    frame,
  });
}

function renderEndnote(node: DirectiveNode, ctx: DocxCtx): string {
  if (ctx.targetedEndnoteNodes.has(node)) return "";
  if (noteIsDeleted(node)) return "";
  const endnote = addEndnote(node, ctx);
  const frame = directiveFrame(node);
  const label = stringAttr(node.attrs, "label") ?? "Endnote";
  const runs = editableLabelRuns(label, ctx, { color: frame?.color ?? "5B4620" }) + endnoteReferenceRun(endnote.id);
  return paragraph(runs, {
    style: "NomaDirective",
    bookmarkId: node.id,
    ...targetedCommentOptions(node, ctx),
    frame,
  });
}

type ChangeRequestAction = "insert" | "delete" | "replace";

interface ChangeRequestRevision {
  action: ChangeRequestAction;
  oldText?: string;
  newText?: string;
  usedBodyAsRevisionText: boolean;
}

function renderChangeRequest(node: DirectiveNode, ctx: DocxCtx): string {
  if (ctx.targetedChangeRequestNodes.has(node)) return "";
  if (changeRequestIsDeleted(node)) return "";
  return renderChangeRequestBlock(node, ctx);
}

function renderChangeRequestBlock(node: DirectiveNode, ctx: DocxCtx): string {
  const frame = directiveFrame(node);
  const revision = changeRequestRevision(node);
  const label = paragraph(textRun(changeRequestTitle(node, revision?.action), { bold: true, color: frame?.color ?? "8B2E20" }), {
    style: "NomaDirective",
    bookmarkId: node.id,
    ...targetedCommentOptions(node, ctx),
    frame,
  });
  const tracked = revision
    ? paragraph(changeRequestRevisionRuns(revision, node, ctx), { frame })
    : "";
  const body = revision?.usedBodyAsRevisionText ? "" : renderDirectiveContent(node, ctx, frame);
  const fallbackMeta = revision ? "" : changeRequestFallbackMetaRuns(node, ctx);
  const meta = fallbackMeta ? paragraph(fallbackMeta, { style: "NomaMeta", frame }) : "";
  return label + tracked + body + meta;
}

function renderStateChange(node: DirectiveNode, ctx: DocxCtx): string {
  const frame = directiveFrame(node);
  const label = paragraph(stateChangeHeaderRuns(node, ctx, frame), {
    style: "NomaDirective",
    bookmarkId: node.id,
    ...targetedCommentOptions(node, ctx),
    frame,
  });
  const delta = stateChangeDeltaRuns(node, ctx);
  const deltaParagraph = delta ? paragraph(delta, { frame }) : "";
  const body = renderDirectiveContent(node, ctx, frame);
  const meta = stateChangeMetaRuns(node, ctx);
  const metaParagraph = meta ? paragraph(meta, { style: "NomaMeta", frame }) : "";
  return label + deltaParagraph + body + metaParagraph;
}

function renderReviewMetaBlock(node: DirectiveNode, ctx: DocxCtx): string {
  const frame = directiveFrame(node);
  const label = paragraph(reviewMetaHeaderRuns(node, ctx, frame), {
    style: "NomaDirective",
    bookmarkId: node.id,
    ...targetedCommentOptions(node, ctx),
    frame,
  });
  const body = renderDirectiveContent(node, ctx, frame);
  const meta = reviewMetaRuns(node, ctx);
  const metaParagraph = meta ? paragraph(meta, { style: "NomaMeta", frame }) : "";
  return label + body + metaParagraph;
}

function renderTaskDirective(node: DirectiveNode, ctx: DocxCtx): string {
  const frame = directiveFrame(node);
  const label = paragraph(taskHeaderRuns(node, ctx, frame), {
    style: "NomaDirective",
    bookmarkId: node.id,
    ...targetedCommentOptions(node, ctx),
    frame,
  });
  const meta = taskMetaRuns(node, ctx);
  const metaParagraph = meta ? paragraph(meta, { style: "NomaMeta", frame }) : "";
  return label + renderDirectiveContent(node, ctx, frame) + metaParagraph;
}

function renderButton(node: DirectiveNode, ctx: DocxCtx): string {
  const href = stringAttr(node.attrs, "href");
  const label = actionLabel(node, "Button");
  const runs = href
    ? linkRuns(label, href, ctx, {})
    : inlineRuns(label, ctx, { color: "2B5265" });
  return paragraph(runs, {
    style: "NomaAction",
    bookmarkId: node.id,
    ...targetedCommentOptions(node, ctx),
  });
}

function renderExportButton(node: DirectiveNode, ctx: DocxCtx): string {
  const label = actionLabel(node, `Copy as ${attrText(node.attrs, "format") ?? "text"}`);
  const target = attrText(node.attrs, "target");
  let runs = inlineRuns(`Export action: ${label}`, ctx, { color: "2B5265" });
  if (target) {
    runs += textRun(" · target: ");
    runs += targetReferenceRuns(target, ctx, {});
  }
  const format = attrText(node.attrs, "format");
  const meta = format ? paragraph(metaTextField("format", format, ctx), { style: "NomaMeta" }) : "";
  return paragraph(runs, {
    style: "NomaAction",
    bookmarkId: node.id,
    ...targetedCommentOptions(node, ctx),
  }) + meta;
}

function renderControl(node: DirectiveNode, ctx: DocxCtx): string {
  const label = actionLabel(node, "Control");
  const type = attrText(node.attrs, "type") ?? "text";
  let runs = inlineRuns(`Control: ${label}`, ctx, { color: "2B5265" });
  runs += textRun(" ");
  runs += controlContentRun(node, label, type);
  const details = [
    `type: ${type}`,
    taskMetaField("default", attrText(node.attrs, "default")),
    taskMetaField("min", attrText(node.attrs, "min")),
    taskMetaField("max", attrText(node.attrs, "max")),
    taskMetaField("step", attrText(node.attrs, "step")),
  ].filter(Boolean);
  const meta = details.length > 0 ? paragraph(inlineRuns(details.join(" · "), ctx), { style: "NomaMeta" }) : "";
  return paragraph(runs, {
    style: "NomaAction",
    bookmarkId: node.id,
    ...targetedCommentOptions(node, ctx),
  }) + meta;
}

function controlContentRun(node: DirectiveNode, label: string, type: string): string {
  const normalizedType = type.toLowerCase();
  const plainLabel = inlineToPlain(label);
  if (normalizedType === "checkbox" || normalizedType === "toggle") {
    return checkboxContentControlRun(node, controlDefaultIsChecked(node), "control", `Control: ${plainLabel}`, "noma-control");
  }
  if (normalizedType === "select") {
    return dropdownContentControlRun(node, plainLabel);
  }
  if (normalizedType === "date") {
    return dateContentControlRun(node, plainLabel);
  }
  const id = contentControlId(node, "control");
  const tag = contentControlTag(node, "noma-control");
  const alias = `Control: ${plainLabel}`;
  const lock = contentControlLockXml(node);
  const dataBinding = controlDataBindingXml(node);
  const value = controlDefaultText(node) ?? "";
  const content = value.trim() ? value : " ";
  return `<w:sdt><w:sdtPr><w:id w:val="${id}"/><w:alias w:val="${xmlAttr(alias)}"/><w:tag w:val="${xmlAttr(tag)}"/>${lock}${dataBinding}<w:text/></w:sdtPr><w:sdtContent><w:r><w:t xml:space="preserve">${xmlText(content)}</w:t></w:r></w:sdtContent></w:sdt>`;
}

function dateContentControlRun(node: DirectiveNode, label: string): string {
  const id = contentControlId(node, "control");
  const tag = contentControlTag(node, "noma-control");
  const alias = `Control: ${label}`;
  const lock = contentControlLockXml(node);
  const dataBinding = controlDataBindingXml(node);
  const value = controlDefaultText(node) ?? "";
  const content = value.trim() ? value : " ";
  const fullDate = wordFullDate(value);
  const fullDateAttr = fullDate ? ` w:fullDate="${xmlAttr(fullDate)}"` : "";
  const format = attrText(node.attrs, "date_format") ?? attrText(node.attrs, "format") ?? "yyyy-MM-dd";
  const locale = attrText(node.attrs, "locale") ?? "en-US";
  return `<w:sdt><w:sdtPr><w:id w:val="${id}"/><w:alias w:val="${xmlAttr(alias)}"/><w:tag w:val="${xmlAttr(tag)}"/>${lock}${dataBinding}<w:date${fullDateAttr}><w:dateFormat w:val="${xmlAttr(format)}"/><w:lid w:val="${xmlAttr(locale)}"/><w:storeMappedDataAs w:val="dateTime"/><w:calendar w:val="gregorian"/></w:date></w:sdtPr><w:sdtContent>${textRun(content)}</w:sdtContent></w:sdt>`;
}

function wordFullDate(value: string): string | undefined {
  const trimmed = value.trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return `${trimmed}T00:00:00Z`;
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(trimmed)) return trimmed;
  return undefined;
}

function dropdownContentControlRun(node: DirectiveNode, label: string): string {
  const id = contentControlId(node, "control");
  const tag = contentControlTag(node, "noma-control");
  const alias = `Control: ${label}`;
  const value = controlDefaultText(node) ?? "";
  const options = controlOptionsWithDefault(node, value);
  const selected = options.find((option) => option.value === value) ?? options[0];
  const content = selected?.label ?? value;
  const lock = contentControlLockXml(node);
  const dataBinding = controlDataBindingXml(node);
  const listItems = options
    .map((option) => `<w:listItem w:displayText="${xmlAttr(option.label)}" w:value="${xmlAttr(option.value)}"/>`)
    .join("");
  return `<w:sdt><w:sdtPr><w:id w:val="${id}"/><w:alias w:val="${xmlAttr(alias)}"/><w:tag w:val="${xmlAttr(tag)}"/>${lock}${dataBinding}<w:dropDownList>${listItems}</w:dropDownList></w:sdtPr><w:sdtContent>${textRun(content || " ")}</w:sdtContent></w:sdt>`;
}

function controlOptionsWithDefault(node: DirectiveNode, value: string): ReturnType<typeof controlOptions> {
  const options = controlOptions(node);
  if (!value || options.some((option) => option.value === value)) return options;
  return [{ value, label: value }, ...options];
}

function controlDefaultIsChecked(node: DirectiveNode): boolean {
  const value = controlDefaultText(node)?.toLowerCase();
  return value === "1" || value === "true" || value === "yes" || value === "on" || value === "checked";
}

function actionLabel(node: DirectiveNode, fallback: string): string {
  const raw =
    attrText(node.attrs, "Label") ??
    attrText(node.attrs, "label") ??
    directiveBodyText(node, fallback);
  return raw.replace(/^Label:\s*/i, "").trim() || fallback;
}

function semanticMetaRuns(node: DirectiveNode, ctx: DocxCtx): string {
  switch (node.name) {
    case "evidence":
    case "counterevidence":
      return joinMetaRuns([
        metaReferenceField("for", attrText(node.attrs, "for"), ctx),
        metaReferenceField("source", attrText(node.attrs, "source"), ctx),
        metaExternalField("url", attrText(node.attrs, "url") ?? attrText(node.attrs, "href"), ctx),
        metaDoiField(attrText(node.attrs, "doi"), ctx),
        metaTextField("accessed", attrText(node.attrs, "accessed"), ctx),
      ]);
    case "risk":
      return joinMetaRuns([
        metaTextField("severity", attrText(node.attrs, "severity"), ctx),
        metaTextField("owner", attrText(node.attrs, "owner"), ctx),
        metaTextField("status", attrText(node.attrs, "status"), ctx),
      ]);
    case "decision":
    case "adr":
      return joinMetaRuns([
        metaTextField("status", attrText(node.attrs, "status"), ctx),
        metaTextField("owner", attrText(node.attrs, "owner"), ctx),
        metaTextField("date", attrText(node.attrs, "date") ?? attrText(node.attrs, "decided_at"), ctx),
      ]);
    case "open_question":
      return joinMetaRuns([
        metaTextField("status", attrText(node.attrs, "status"), ctx),
        metaTextField("owner", attrText(node.attrs, "owner"), ctx),
        metaTextField("due", attrText(node.attrs, "due") ?? attrText(node.attrs, "due_at"), ctx),
      ]);
    case "assumption":
    case "hypothesis":
    case "result":
    case "limitation":
      return joinMetaRuns([
        metaTextField("status", attrText(node.attrs, "status"), ctx),
        metaTextField("owner", attrText(node.attrs, "owner"), ctx),
        metaTextField("confidence", attrText(node.attrs, "confidence"), ctx),
        metaReferenceField("source", attrText(node.attrs, "source"), ctx),
      ]);
    case "card":
      return cardMetaRuns(node, ctx);
    case "memory":
      return memoryMetaRuns(node, ctx);
    default:
      return "";
  }
}

function cardMetaRuns(node: DirectiveNode, ctx: DocxCtx): string {
  return joinMetaRuns([
    metaTextField("variant", attrText(node.attrs, "variant"), ctx),
    metaTextField("icon", attrText(node.attrs, "icon"), ctx),
  ]);
}

function memoryMetaRuns(node: DirectiveNode, ctx: DocxCtx): string {
  return joinMetaRuns([
    metaTextField("type", attrText(node.attrs, "type"), ctx),
    metaTextField("confidence", attrText(node.attrs, "confidence"), ctx),
    metaTextField("last seen", attrText(node.attrs, "last_seen") ?? attrText(node.attrs, "lastSeen"), ctx),
    metaTextField("scope", attrText(node.attrs, "scope"), ctx),
    metaReferenceField("source", attrText(node.attrs, "source"), ctx),
    metaTextField("valid until", attrText(node.attrs, "valid_until") ?? attrText(node.attrs, "validUntil"), ctx),
    metaReferenceField("superseded by", attrText(node.attrs, "superseded_by") ?? attrText(node.attrs, "supersededBy"), ctx),
    boolAttr(node.attrs, "expired") ? textRun("expired: true") : "",
  ]);
}

function technicalMetaRuns(node: DirectiveNode, ctx: DocxCtx): string {
  switch (node.name) {
    case "api":
      return joinMetaRuns([
        metaTextField("version", attrText(node.attrs, "version"), ctx),
        metaExternalField("base URL", attrText(node.attrs, "base_url") ?? attrText(node.attrs, "baseUrl") ?? attrText(node.attrs, "url"), ctx),
        metaTextField("status", attrText(node.attrs, "status"), ctx),
        metaTextField("owner", attrText(node.attrs, "owner"), ctx),
      ]);
    case "endpoint":
      return joinMetaRuns([
        metaTextField("method", attrText(node.attrs, "method"), ctx),
        metaTextField("path", attrText(node.attrs, "path") ?? attrText(node.attrs, "url"), ctx),
        metaTextField("auth", attrText(node.attrs, "auth"), ctx),
        metaTextField("status", attrText(node.attrs, "status"), ctx),
        metaReferenceField("api", attrText(node.attrs, "api"), ctx),
      ]);
    case "parameter":
      return joinMetaRuns([
        metaTextField("in", attrText(node.attrs, "in") ?? attrText(node.attrs, "location"), ctx),
        metaTextField("type", attrText(node.attrs, "type"), ctx),
        metaTextField("required", attrText(node.attrs, "required"), ctx),
        metaTextField("default", attrText(node.attrs, "default"), ctx),
        metaTextField("enum", attrText(node.attrs, "enum") ?? attrText(node.attrs, "values"), ctx),
      ]);
    case "example":
      return joinMetaRuns([
        metaTextField("language", technicalLanguage(node), ctx),
        metaReferenceField("for", attrText(node.attrs, "for") ?? attrText(node.attrs, "target"), ctx),
        metaTextField("status", attrText(node.attrs, "status"), ctx),
      ]);
    case "changelog":
      return joinMetaRuns([
        metaTextField("version", attrText(node.attrs, "version"), ctx),
        metaTextField("date", attrText(node.attrs, "date") ?? attrText(node.attrs, "released_at"), ctx),
        metaTextField("status", attrText(node.attrs, "status"), ctx),
      ]);
    case "instruction":
      return joinMetaRuns([
        metaTextField("scope", attrText(node.attrs, "scope"), ctx),
        metaTextField("audience", attrText(node.attrs, "audience"), ctx),
        metaTextField("priority", attrText(node.attrs, "priority"), ctx),
        metaTextField("owner", attrText(node.attrs, "owner"), ctx),
      ]);
    case "query":
      return joinMetaRuns([
        metaTextField("language", technicalLanguage(node), ctx),
        metaReferenceField("dataset", attrText(node.attrs, "dataset"), ctx),
        metaReferenceField("source", attrText(node.attrs, "source"), ctx),
        metaTextField("status", attrText(node.attrs, "status"), ctx),
      ]);
    default:
      return "";
  }
}

function joinMetaRuns(fields: string[]): string {
  const active = fields.filter(Boolean);
  return active.map((field, index) => `${index > 0 ? textRun(" · ") : ""}${field}`).join("");
}

function metaTextField(label: string, value: string | undefined, ctx?: DocxCtx): string {
  if (!value || !value.trim()) return "";
  const text = `${label}: ${value}`;
  return ctx ? inlineRuns(text, ctx) : textRun(text);
}

function metaReferenceField(label: string, value: string | undefined, ctx: DocxCtx): string {
  if (!value || !value.trim()) return "";
  const target = value.trim();
  const linked = /^(https?:|mailto:)/i.test(target)
    ? linkRuns(target, target, ctx, {})
    : targetReferenceRuns(target, ctx, {});
  return textRun(`${label}: `) + linked;
}

function metaExternalField(label: string, value: string | undefined, ctx: DocxCtx): string {
  if (!value || !value.trim()) return "";
  const href = value.trim();
  return textRun(`${label}: `) + linkRuns(href, href, ctx, {});
}

function metaDoiField(value: string | undefined, ctx: DocxCtx): string {
  if (!value || !value.trim()) return "";
  const doi = value.trim();
  return textRun("doi: ") + linkRuns(doi, `https://doi.org/${doi}`, ctx, {});
}

function taskHeaderRuns(node: DirectiveNode, ctx: DocxCtx, frame: DirectiveFrame | undefined): string {
  const done = taskIsDone(node);
  const label = node.name === "todo" ? "Todo" : "Agent task";
  const status = attrText(node.attrs, "status");
  const color = frame?.color ?? "304B75";
  let runs = taskCheckboxRun(node, done);
  runs += textRun(label, { bold: true, color });
  if (status && !done) runs += inlineRuns(` (${status})`, ctx, { bold: true, color });
  return runs;
}

function taskCheckboxRun(node: DirectiveNode, checked: boolean): string {
  const alias = `${node.name === "todo" ? "Todo" : "Agent task"} status`;
  return checkboxContentControlRun(node, checked, "task-checkbox", alias, "noma-task") + textRun(" ");
}

function checkboxContentControlRun(node: DirectiveNode, checked: boolean, kind: string, alias: string, tagPrefix: string): string {
  const id = contentControlId(node, kind);
  const tag = contentControlTag(node, tagPrefix);
  const lock = contentControlLockXml(node);
  const dataBinding = tagPrefix === "noma-control" ? controlDataBindingXml(node) : "";
  const glyph = checked ? "&#x2612;" : "&#x2610;";
  return `<w:sdt><w:sdtPr><w:id w:val="${id}"/><w:alias w:val="${xmlAttr(alias)}"/><w:tag w:val="${xmlAttr(tag)}"/>${lock}${dataBinding}<w14:checkbox><w14:checked w14:val="${checked ? "1" : "0"}"/><w14:checkedState w14:val="2612" w14:font="MS Gothic"/><w14:uncheckedState w14:val="2610" w14:font="MS Gothic"/></w14:checkbox></w:sdtPr><w:sdtContent><w:r><w:t>${glyph}</w:t></w:r></w:sdtContent></w:sdt>`;
}

function contentControlId(node: DirectiveNode, kind: string): number {
  const key = node.id ?? `${node.name}:${node.pos?.line ?? 0}:${node.pos?.column ?? 0}`;
  return (crc32(Buffer.from(`${kind}:${key}`, "utf8")) & 0x7fffffff) || 1;
}

function contentControlTag(node: DirectiveNode, prefix: string): string {
  return node.id ? `${prefix}:${node.id}` : `${prefix}:${node.pos?.line ?? 0}`;
}

function controlDataBindingXml(node: DirectiveNode): string {
  if (!node.id) return "";
  const xpath = `/noma:controls[1]/noma:control[@id=${xpathLiteral(node.id)}][1]/noma:value[1]`;
  const prefixMappings = `xmlns:noma='${NOMA_CONTROLS_NS}'`;
  return `<w:dataBinding w:prefixMappings="${xmlAttr(prefixMappings)}" w:xpath="${xmlAttr(xpath)}" w:storeItemID="${xmlAttr(NOMA_CONTROLS_STORE_ITEM_ID)}"/>`;
}

function contentControlLockXml(node: DirectiveNode): string {
  const lock = contentControlLockValue(node);
  return lock ? `<w:lock w:val="${lock}"/>` : "";
}

function contentControlLockValue(node: DirectiveNode): ContentControlLock | undefined {
  const explicit = node.attrs.lock ?? node.attrs.content_control_lock ?? node.attrs.sdt_lock;
  if (explicit !== undefined) return contentControlLockFromAttr(explicit);
  if (boolAttr(node.attrs, "locked") || boolAttr(node.attrs, "lock_control") || boolAttr(node.attrs, "control_locked")) {
    return "sdtLocked";
  }
  if (boolAttr(node.attrs, "lock_content") || boolAttr(node.attrs, "content_locked")) {
    return "contentLocked";
  }
  return undefined;
}

function contentControlLockFromAttr(value: AttrValue): ContentControlLock | undefined {
  if (value === true) return "sdtLocked";
  if (value === false) return undefined;
  const normalized = String(value).trim().toLowerCase().replace(/[\s_-]+/g, "");
  switch (normalized) {
    case "control":
    case "field":
    case "container":
    case "sdt":
    case "sdtlocked":
      return "sdtLocked";
    case "content":
    case "value":
    case "contentlocked":
      return "contentLocked";
    case "all":
    case "both":
    case "full":
    case "sdtcontentlocked":
    case "controlandcontent":
    case "fieldandcontent":
      return "sdtContentLocked";
    case "unlocked":
      return "unlocked";
    case "none":
    case "off":
    case "false":
    case "0":
    case "no":
    case "":
      return undefined;
    default:
      return undefined;
  }
}

function taskIsDone(node: DirectiveNode): boolean {
  const status = attrText(node.attrs, "status")?.toLowerCase();
  return boolAttr(node.attrs, "done") || status === "done" || status === "complete" || status === "completed";
}

function taskMetaRuns(node: DirectiveNode, ctx: DocxCtx): string {
  const fields = [
    taskMetaField("scope", attrText(node.attrs, "scope")),
    taskMetaField("owner", attrText(node.attrs, "owner")),
    taskMetaField("due", attrText(node.attrs, "due") ?? attrText(node.attrs, "due_at")),
    taskMetaField("priority", attrText(node.attrs, "priority")),
  ].filter(Boolean);
  return fields.length > 0 ? inlineRuns(fields.join(" · "), ctx) : "";
}

function taskMetaField(label: string, value: string | undefined): string {
  return value ? `${label}: ${value}` : "";
}

function stateChangeHeaderRuns(node: DirectiveNode, ctx: DocxCtx, frame: DirectiveFrame | undefined): string {
  const block = attrText(node.attrs, "block");
  const attribute = attrText(node.attrs, "attribute");
  const color = frame?.color ?? "553C67";
  let runs = textRun("State change", { bold: true, color });
  if (block) {
    runs += textRun(": ", { bold: true, color });
    runs += targetReferenceRuns(block, ctx, { bold: true });
  }
  if (attribute) {
    runs += textRun(" · ");
    runs += textRun(attribute, { code: true });
  }
  return runs;
}

function stateChangeDeltaRuns(node: DirectiveNode, ctx: DocxCtx): string {
  const from = attrText(node.attrs, "from");
  const to = attrText(node.attrs, "to");
  if (from === undefined || to === undefined) return "";
  return (
    textRun("From ") +
    inlineRuns(from, ctx, { strike: true, color: "7A4B5F" }) +
    textRun(" to ") +
    inlineRuns(to, ctx, { bold: true, color: "315A34" })
  );
}

function stateChangeMetaRuns(node: DirectiveNode, ctx: DocxCtx): string {
  const at = attrText(node.attrs, "at");
  const reason = attrText(node.attrs, "reason");
  const parts = [
    at ? `at ${at}` : "",
    reason ? `why ${reason}` : "",
  ].filter(Boolean);
  return parts.length > 0 ? inlineRuns(parts.join(" · "), ctx) : "";
}

function reviewMetaHeaderRuns(node: DirectiveNode, ctx: DocxCtx, frame: DirectiveFrame | undefined): string {
  const color = frame?.color ?? "493E78";
  let runs = textRun(reviewMetaTitle(node), { bold: true, color });
  const target = reviewTarget(node);
  if (target) {
    runs += textRun(": ", { bold: true, color });
    runs += targetReferenceRuns(target, ctx, { bold: true });
  }
  return runs;
}

function reviewMetaTitle(node: DirectiveNode): string {
  if (node.name === "review") return "Review";
  if (node.name === "provenance") return "Provenance";
  return "Confidence";
}

function reviewTarget(node: DirectiveNode): string | undefined {
  return attrText(node.attrs, "for") ?? attrText(node.attrs, "target") ?? attrText(node.attrs, "block") ?? attrText(node.attrs, "claim");
}

function reviewMetaRuns(node: DirectiveNode, ctx: DocxCtx): string {
  switch (node.name) {
    case "review":
      return joinMetaRuns([
        metaTextField("status", attrText(node.attrs, "status"), ctx),
        metaTextField("reviewer", attrText(node.attrs, "reviewer") ?? attrText(node.attrs, "author") ?? attrText(node.attrs, "by"), ctx),
        metaTextField("due", attrText(node.attrs, "due") ?? attrText(node.attrs, "due_at"), ctx),
        metaTextField("date", attrText(node.attrs, "date") ?? attrText(node.attrs, "at"), ctx),
      ]);
    case "provenance":
      return joinMetaRuns([
        metaReferenceField("source", attrText(node.attrs, "source"), ctx),
        metaExternalField("url", attrText(node.attrs, "url") ?? attrText(node.attrs, "href"), ctx),
        metaTextField("tool", attrText(node.attrs, "tool") ?? attrText(node.attrs, "agent"), ctx),
        metaTextField("by", attrText(node.attrs, "by") ?? attrText(node.attrs, "author"), ctx),
        metaTextField("commit", attrText(node.attrs, "commit") ?? attrText(node.attrs, "sha"), ctx),
        metaTextField("at", attrText(node.attrs, "at") ?? attrText(node.attrs, "date"), ctx),
      ]);
    case "confidence":
      return joinMetaRuns([
        metaTextField("value", attrText(node.attrs, "value") ?? attrText(node.attrs, "score") ?? attrText(node.attrs, "confidence"), ctx),
        metaTextField("basis", attrText(node.attrs, "basis") ?? attrText(node.attrs, "reason"), ctx),
        metaReferenceField("source", attrText(node.attrs, "source"), ctx),
        metaTextField("updated", attrText(node.attrs, "updated") ?? attrText(node.attrs, "at") ?? attrText(node.attrs, "date"), ctx),
      ]);
    default:
      return "";
  }
}

function targetReferenceRuns(id: string, ctx: DocxCtx, style: RunStyle): string {
  const anchor = ctx.bookmarkNames.get(id);
  if (!anchor) return textRun(id, style);
  return `<w:hyperlink w:anchor="${xmlAttr(anchor)}">${textRun(id, { ...style, color: "0563C1", underline: true })}</w:hyperlink>`;
}

function changeRequestTitle(node: DirectiveNode, action: ChangeRequestAction | undefined): string {
  const target = changeRequestTarget(node);
  const label = action ?? changeRequestActionLabel(node);
  if (!label) return "Change request";
  return target ? `Change request: ${label} ${target}` : `Change request: ${label}`;
}

function changeRequestActionLabel(node: DirectiveNode): string | undefined {
  const raw = attrText(node.attrs, "action") ?? attrText(node.attrs, "type");
  return raw?.trim() || undefined;
}

function changeRequestFallbackMetaRuns(node: DirectiveNode, ctx: DocxCtx): string {
  return joinMetaRuns([
    metaReferenceField("target", changeRequestTarget(node), ctx),
    metaTextField("action", changeRequestActionLabel(node), ctx),
    metaTextField("from", attrText(node.attrs, "from"), ctx),
    metaTextField("to", attrText(node.attrs, "to"), ctx),
    metaTextField("text", attrText(node.attrs, "text"), ctx),
    metaTextField("author", attrText(node.attrs, "author") ?? attrText(node.attrs, "reviewer"), ctx),
    metaTextField("date", attrText(node.attrs, "date") ?? attrText(node.attrs, "at"), ctx),
  ]);
}

function changeRequestRevision(node: DirectiveNode): ChangeRequestRevision | null {
  const rawAction = (stringAttr(node.attrs, "action") ?? stringAttr(node.attrs, "type"))?.toLowerCase();
  if (rawAction !== "insert" && rawAction !== "delete" && rawAction !== "replace") return null;

  const body = directiveBodyText(node, "").trim();
  const text = stringAttr(node.attrs, "text");
  const from = stringAttr(node.attrs, "from") ?? (rawAction === "delete" ? text : undefined);
  const to = stringAttr(node.attrs, "to") ?? (rawAction === "insert" ? text : undefined);

  if (rawAction === "replace") {
    if (!from || !to) return null;
    return { action: "replace", oldText: from, newText: to, usedBodyAsRevisionText: false };
  }
  if (rawAction === "insert") {
    const newText = to ?? body;
    if (!newText) return null;
    return { action: "insert", newText, usedBodyAsRevisionText: !to && !text };
  }
  const oldText = from ?? body;
  if (!oldText) return null;
  return { action: "delete", oldText, usedBodyAsRevisionText: !from && !text };
}

function changeRequestRevisionRuns(revision: ChangeRequestRevision, node: DirectiveNode, ctx: DocxCtx): string {
  if (revision.action === "replace") {
    return [
      revision.oldText ? deletedRevisionRun(revision.oldText, node, ctx) : "",
      revision.oldText && revision.newText ? textRun(" ") : "",
      revision.newText ? insertedRevisionRun(revision.newText, node, ctx) : "",
    ].join("");
  }
  if (revision.action === "delete") {
    return deletedRevisionRun(revision.oldText ?? "", node, ctx);
  }
  return insertedRevisionRun(revision.newText ?? "", node, ctx);
}

function changeRequestExportsNativeRevision(node: DirectiveNode): boolean {
  return !changeRequestIsDeleted(node) && changeRequestRevision(node) !== null;
}

function insertedRevisionRun(text: string, node: DirectiveNode, ctx: DocxCtx): string {
  return revisionWrapper("ins", text, revisionMeta(node, ctx), ctx);
}

function deletedRevisionRun(text: string, node: DirectiveNode, ctx: DocxCtx): string {
  return revisionWrapper("del", text, revisionMeta(node, ctx), ctx);
}

function revisionMeta(node: DirectiveNode, ctx: DocxCtx): { id: number; author: string; date: string } {
  return {
    id: ctx.nextRevisionId++,
    author: stringAttr(node.attrs, "author") ?? stringAttr(node.attrs, "reviewer") ?? "Noma",
    date: stringAttr(node.attrs, "date") ?? stringAttr(node.attrs, "at") ?? FIXED_CORE_TIME,
  };
}

function revisionWrapper(kind: "ins" | "del", text: string, meta: { id: number; author: string; date: string }, ctx: DocxCtx): string {
  return `<w:${kind} w:id="${meta.id}" w:author="${xmlAttr(meta.author)}" w:date="${xmlAttr(meta.date)}">${revisionTextRuns(text, kind, ctx)}</w:${kind}>`;
}

function revisionTextRuns(text: string, kind: "ins" | "del", ctx: DocxCtx): string {
  const tag = kind === "ins" ? "t" : "delText";
  return inlineRunsWithTextElement(text, ctx, {}, tag);
}

function ensureComment(
  node: DirectiveNode,
  ctx: DocxCtx,
  commentNodes: Map<string, DirectiveNode> = new Map(),
  parentParaId?: string,
): DocxComment {
  if (node.id) {
    const existing = ctx.commentsBySourceId.get(node.id);
    if (existing) {
      if (parentParaId && !existing.parentParaId) existing.parentParaId = parentParaId;
      return existing;
    }
  }
  let resolvedParentParaId = parentParaId;
  if (!resolvedParentParaId) {
    const replyTo = commentReplyTarget(node);
    const parent = replyTo ? commentNodes.get(replyTo) : undefined;
    if (parent) resolvedParentParaId = ensureComment(parent, ctx, commentNodes).paraId;
  }
  return addComment(node, ctx, resolvedParentParaId);
}

function ensureCommentsParts(ctx: DocxCtx): void {
  if (!ctx.commentsRelationshipId) {
    ctx.commentsRelationshipId = addRelationship(ctx, `${PACKAGE_REL_NS}/comments`, "comments.xml");
  }
  if (!ctx.commentsExRelationshipId) {
    ctx.commentsExRelationshipId = addRelationship(ctx, COMMENTS_EXTENDED_REL_NS, "commentsExtended.xml");
  }
}

function addComment(node: DirectiveNode, ctx: DocxCtx, parentParaId?: string): DocxComment {
  ensureCommentsParts(ctx);
  const author = stringAttr(node.attrs, "author") ?? "Noma";
  const status = stringAttr(node.attrs, "status");
  const resolvedBy = stringAttr(node.attrs, "resolved_by");
  const resolvedAt = stringAttr(node.attrs, "resolved_at");
  const id = ctx.nextCommentId++;
  const comment: DocxComment = {
    id,
    paraId: commentParaId(id),
    ...(parentParaId ? { parentParaId } : {}),
    ...(node.id ? { sourceId: node.id } : {}),
    author,
    initials: stringAttr(node.attrs, "initials") ?? initialsFrom(author),
    date: stringAttr(node.attrs, "date") ?? stringAttr(node.attrs, "at") ?? FIXED_CORE_TIME,
    ...(status ? { status } : {}),
    ...(resolvedBy ? { resolvedBy } : {}),
    ...(resolvedAt ? { resolvedAt } : {}),
    body: directiveBodyText(node, "Comment"),
  };
  ctx.comments.push(comment);
  if (node.id) ctx.commentsBySourceId.set(node.id, comment);
  return comment;
}

function addChangeRequestMarkerComment(node: DirectiveNode, ctx: DocxCtx): DocxComment {
  ensureCommentsParts(ctx);
  const author = stringAttr(node.attrs, "author") ?? stringAttr(node.attrs, "reviewer") ?? "Noma";
  const id = ctx.nextCommentId++;
  const comment: DocxComment = {
    id,
    paraId: commentParaId(id),
    author,
    initials: stringAttr(node.attrs, "initials") ?? initialsFrom(author),
    date: stringAttr(node.attrs, "date") ?? stringAttr(node.attrs, "at") ?? FIXED_CORE_TIME,
    body: changeRequestMarkerBody(node),
  };
  ctx.comments.push(comment);
  return comment;
}

function changeRequestMarkerBody(node: DirectiveNode): string {
  const revision = changeRequestRevision(node);
  const lines = [changeRequestTitle(node, revision?.action)];
  if (revision?.oldText) lines.push(`From: ${revision.oldText}`);
  if (revision?.newText) lines.push(`To: ${revision.newText}`);
  const body = revision?.usedBodyAsRevisionText ? "" : directiveBodyText(node, "").trim();
  if (body) lines.push(`Note: ${body}`);
  return lines.join("\n\n");
}

function commentParaId(id: number): string {
  return (id + 1).toString(16).toUpperCase().padStart(8, "0").slice(-8);
}

function addFootnote(node: DirectiveNode, ctx: DocxCtx): DocxFootnote {
  if (!ctx.footnotesRelationshipId) {
    ctx.footnotesRelationshipId = addRelationship(ctx, `${PACKAGE_REL_NS}/footnotes`, "footnotes.xml");
  }
  const footnote: DocxFootnote = {
    id: ctx.nextFootnoteId++,
    ...(node.id ? { sourceId: node.id } : {}),
    body: directiveBodyText(node, "Footnote"),
  };
  ctx.footnotes.push(footnote);
  return footnote;
}

function addEndnote(node: DirectiveNode, ctx: DocxCtx): DocxEndnote {
  if (!ctx.endnotesRelationshipId) {
    ctx.endnotesRelationshipId = addRelationship(ctx, `${PACKAGE_REL_NS}/endnotes`, "endnotes.xml");
  }
  const endnote: DocxEndnote = {
    id: ctx.nextEndnoteId++,
    ...(node.id ? { sourceId: node.id } : {}),
    body: directiveBodyText(node, "Endnote"),
  };
  ctx.endnotes.push(endnote);
  return endnote;
}

function directiveBodyText(node: DirectiveNode, fallback: string): string {
  if (node.body?.trim()) return node.body.trim();
  const parts = node.children.map(plainNodeText).filter(Boolean);
  return parts.join("\n\n") || fallback;
}

function plainNodeText(node: Node): string {
  switch (node.type) {
    case "document":
    case "section":
      return node.children.map(plainNodeText).filter(Boolean).join("\n\n");
    case "paragraph":
    case "quote":
    case "code":
      return node.content.trim();
    case "list":
      return node.items.map((item) => `- ${item.content.trim()}`).join("\n");
    case "list_item":
      return `- ${node.content.trim()}`;
    case "thematic_break":
    case "frontmatter":
      return "";
    case "table":
      return [node.header.join(" | "), ...node.rows.map((row) => row.join(" | "))].join("\n");
    case "directive":
      return node.body?.trim() || node.children.map(plainNodeText).filter(Boolean).join("\n\n");
    default: {
      const _exhaustive: never = node;
      void _exhaustive;
      return "";
    }
  }
}

function initialsFrom(author: string): string {
  const initials = author
    .split(/\s+/)
    .map((part) => part[0])
    .filter(Boolean)
    .join("")
    .slice(0, 3)
    .toUpperCase();
  return initials || "N";
}

function renderTable(node: TableNode, ctx: DocxCtx): string {
  const columns = Math.max(node.header.length, ...node.rows.map((row) => row.length), 1);
  const widths = tableWidths(columns, ctx.pageSetup);
  const header = tableRow(node.header, ctx, widths, { header: true, align: node.align });
  const rows = node.rows
    .map((row) => tableRow(row, ctx, widths, { align: node.align }))
    .join("");
  return tableXml(header + rows, widths);
}

function renderTableDirective(node: DirectiveNode, ctx: DocxCtx): string {
  const body = node.body ?? "";
  const rows = body.split("\n").map((line) => line.trim()).filter(Boolean).map(splitPipeRow);
  const columns = Math.max(...rows.map((row) => row.length), 1);
  for (const row of rows) while (row.length < columns) row.push("");
  const widths = tableWidths(columns, ctx.pageSetup);
  const align = typeof node.attrs.align === "string" ? parseDirectiveAlign(node.attrs.align, columns) : [];
  const wantsHeader = node.attrs.header === true || node.attrs.header === "true";
  const label = tableDirectiveLabel(node, ctx);
  if (rows.length === 0) return label;
  const first = wantsHeader ? rows.shift() : undefined;
  const header = first ? tableRow(first, ctx, widths, { header: true, align }) : "";
  const bodyRows = rows.map((row) => tableRow(row, ctx, widths, { align })).join("");
  return label + tableXml(header + bodyRows, widths);
}

function tableDirectiveLabel(node: DirectiveNode, ctx: DocxCtx): string {
  const title = stringAttr(node.attrs, "title") ?? stringAttr(node.attrs, "caption");
  const options = targetedCommentOptions(node, ctx);
  const hasComments = (options.commentIds?.length ?? 0) > 0;
  if (title) {
    return captionParagraph(`Table: ${title}`, node, ctx);
  }
  if (!node.id && !hasComments) return "";
  return paragraph("", { style: "NomaMeta", bookmarkId: node.id, ...options });
}

function renderColumnLayout(node: DirectiveNode, ctx: DocxCtx): string {
  const columnCount = layoutColumnCount(node);
  const widths = tableWidths(columnCount, ctx.pageSetup);
  const anchor = layoutAnchorParagraph(node, ctx);
  if (node.children.length === 0) return anchor + renderBodyParagraphs(node.body ?? "", ctx);
  const rows: string[] = [];
  for (let i = 0; i < node.children.length; i += columnCount) {
    rows.push(layoutTableRow(node.children.slice(i, i + columnCount), ctx, widths));
  }
  return anchor + layoutTableXml(rows.join(""), widths);
}

function layoutAnchorParagraph(node: DirectiveNode, ctx: DocxCtx): string {
  const title = stringAttr(node.attrs, "title");
  const options = targetedCommentOptions(node, ctx);
  const hasComments = (options.commentIds?.length ?? 0) > 0;
  if (title) {
    return paragraph(editableLabelRuns(title, ctx, { color: "3F5F4A" }), {
      style: "NomaDirective",
      bookmarkId: node.id,
      ...options,
    });
  }
  if (!node.id && !hasComments) return "";
  return paragraph("", {
    style: "NomaMeta",
    bookmarkId: node.id,
    ...options,
  });
}

function layoutColumnCount(node: DirectiveNode): number {
  const requested =
    readPositiveInteger(node.attrs.columns) ??
    readPositiveInteger(node.attrs.cols) ??
    readPositiveInteger(node.attrs.count);
  return Math.min(Math.max(requested ?? 2, 1), 6);
}

function layoutTableRow(nodes: Node[], ctx: DocxCtx, widths: number[]): string {
  const cells = widths
    .map((width, index) => layoutTableCell(nodes[index], ctx, width))
    .join("");
  return `      <w:tr>${cells}</w:tr>\n`;
}

function layoutTableCell(node: Node | undefined, ctx: DocxCtx, width: number): string {
  const props = `\
<w:tcPr>
  <w:tcW w:w="${width}" w:type="dxa"/>
  <w:vAlign w:val="top"/>
</w:tcPr>`;
  const content = node ? renderNode(node, ctx) : paragraph("");
  return `<w:tc>${props}${content || paragraph("")}</w:tc>`;
}

function layoutTableXml(rows: string, widths: number[]): string {
  const grid = widths.map((width) => `<w:gridCol w:w="${width}"/>`).join("");
  return `\
    <w:tbl>
      <w:tblPr>
        <w:tblStyle w:val="NomaLayout"/>
        <w:tblW w:w="0" w:type="auto"/>
        <w:tblLayout w:type="fixed"/>
        <w:tblCellMar>
          <w:top w:w="120" w:type="dxa"/>
          <w:left w:w="140" w:type="dxa"/>
          <w:bottom w:w="120" w:type="dxa"/>
          <w:right w:w="140" w:type="dxa"/>
        </w:tblCellMar>
      </w:tblPr>
      <w:tblGrid>${grid}</w:tblGrid>
${rows}    </w:tbl>
`;
}

function tableXml(rows: string, widths: number[]): string {
  const grid = widths.map((width) => `<w:gridCol w:w="${width}"/>`).join("");
  return `\
    <w:tbl>
      <w:tblPr>
        <w:tblStyle w:val="TableGrid"/>
        <w:tblW w:w="0" w:type="auto"/>
        <w:tblCellMar>
          <w:top w:w="90" w:type="dxa"/>
          <w:left w:w="120" w:type="dxa"/>
          <w:bottom w:w="90" w:type="dxa"/>
          <w:right w:w="120" w:type="dxa"/>
        </w:tblCellMar>
      </w:tblPr>
      <w:tblGrid>${grid}</w:tblGrid>
${rows}    </w:tbl>
`;
}

function tableRow(
  cells: string[],
  ctx: DocxCtx,
  widths: number[],
  options: { header?: boolean; align?: TableAlign[] },
): string {
  const rowCells = widths
    .map((width, index) =>
      tableCell(cells[index] ?? "", ctx, {
        header: options.header,
        align: options.align?.[index] ?? null,
        width,
      }),
    )
    .join("");
  const rowPr = options.header ? "<w:trPr><w:tblHeader/></w:trPr>" : "";
  return `      <w:tr>${rowPr}${rowCells}</w:tr>\n`;
}

function tableCell(content: string, ctx: DocxCtx, options: TableCellOptions): string {
  const shade = options.header ? '<w:shd w:fill="E8F0EA"/>' : "";
  const props = `\
<w:tcPr>
  <w:tcW w:w="${options.width}" w:type="dxa"/>
  <w:vAlign w:val="center"/>
  ${shade}
</w:tcPr>`;
  const runs = inlineRuns(content, ctx);
  return `<w:tc>${props}${paragraph(runs, { align: wordAlign(options.align ?? null) })}</w:tc>`;
}

function tableWidths(columns: number, setup: PageSetup = DEFAULT_PAGE_SETUP): number[] {
  const usable = usableTableWidth(setup);
  const base = Math.floor(usable / columns);
  const widths = new Array<number>(columns).fill(base);
  widths[columns - 1] = usable - base * (columns - 1);
  return widths;
}

function usableTableWidth(setup: PageSetup): number {
  return Math.max(1440, setup.width - setup.margins.left - setup.margins.right);
}

function parseDirectiveAlign(raw: string, columns: number): TableAlign[] {
  const parts = raw.split(/[,\s]+/).map((part) => part.trim().toLowerCase()).filter(Boolean);
  const out: TableAlign[] = [];
  for (let i = 0; i < columns; i++) {
    const code = parts[i] ?? "-";
    if (code === "l" || code === "left") out.push("left");
    else if (code === "c" || code === "center") out.push("center");
    else if (code === "r" || code === "right") out.push("right");
    else out.push(null);
  }
  return out;
}

function wordAlign(align: TableAlign): "left" | "center" | "right" | undefined {
  return align ?? undefined;
}

function directiveTitle(node: DirectiveNode): string {
  const title = typeof node.attrs.title === "string" ? node.attrs.title : undefined;
  const caption = typeof node.attrs.caption === "string" ? node.attrs.caption : undefined;
  const status = typeof node.attrs.status === "string" ? node.attrs.status : undefined;
  const severity = typeof node.attrs.severity === "string" ? node.attrs.severity : undefined;
  const confidence = typeof node.attrs.confidence === "number" || typeof node.attrs.confidence === "string" ? String(node.attrs.confidence) : undefined;
  if (node.name === "card") return cardTitle(node);
  if (node.name === "figure" && caption) return `Figure: ${caption}`;
  if (node.name === "toc") return "Contents";
  if (node.name === "summary") return "Summary";
  if (node.name === "abstract") return "Abstract";
  if (node.name === "note") return "Note";
  if (node.name === "warning") return "Warning";
  if (node.name === "tip") return "Tip";
  if (node.name === "metric") return `Metric: ${metricLabel(node)}`;
  if (node.name === "code") return codeDirectiveTitle(node);
  if (node.name === "code_cell") return "Code cell";
  if (node.name === "output") return "Output";
  if (node.name === "claim") return confidence ? `Claim (confidence=${confidence})` : "Claim";
  if (node.name === "evidence") return "Evidence";
  if (node.name === "counterevidence") return "Counterevidence";
  if (node.name === "assumption") return "Assumption";
  if (node.name === "hypothesis") return "Hypothesis";
  if (node.name === "result") return "Result";
  if (node.name === "limitation") return "Limitation";
  if (node.name === "open_question") return "Open question";
  if (node.name === "risk") return severity ? `Risk (${severity})` : "Risk";
  if (node.name === "decision") return status ? `Decision (${status})` : "Decision";
  if (node.name === "adr") return status ? `ADR (${status})` : "ADR";
  if (node.name === "agent_task") return "Agent task";
  if (node.name === "todo") return "Todo";
  if (node.name === "review") return "Review";
  if (node.name === "provenance") return "Provenance";
  if (node.name === "confidence") return "Confidence";
  if (node.name === "footnote") return "Footnote";
  if (node.name === "endnote") return "Endnote";
  if (node.name === "bibliography") return "Bibliography";
  if (node.name === "change_request") return "Change request";
  if (node.name === "callout") return calloutTitle(node);
  if (node.name === "memory") return memoryTitle(node);
  if (node.name === "memory_index") return "Memory index";
  if (isTechnicalDirective(node.name)) return technicalTitle(node);
  if (node.name === "export_button") return `Export button: ${node.attrs.format ?? "text"}`;
  if (node.name === "control") return `Control: ${node.attrs.type ?? "text"}`;
  if (node.name === "html") return "HTML";
  if (node.name === "svg") return "SVG";
  if (node.name === "script") return "Script";
  return genericDirectiveTitle(node);
}

function codeDirectiveTitle(node: DirectiveNode): string {
  const language = attrText(node.attrs, "lang") ?? attrText(node.attrs, "language");
  const label = language ? `Code (${language})` : "Code";
  const title = stringAttr(node.attrs, "title");
  return title ? `${label}: ${title}` : label;
}

function genericDirectiveTitle(node: DirectiveNode): string {
  const base = readableDirectiveName(node.name);
  const title = stringAttr(node.attrs, "title") ?? stringAttr(node.attrs, "caption");
  const attrs = attrsSummary(node.attrs);
  const label = title ? `${base}: ${title}` : base;
  return attrs ? `${label} (${attrs})` : label;
}

function citationTitle(node: DirectiveNode): string {
  const id = stringAttr(node.attrs, "id");
  const source = stringAttr(node.attrs, "source");
  const doi = stringAttr(node.attrs, "doi");
  const url = stringAttr(node.attrs, "url") ?? stringAttr(node.attrs, "href");
  const label = source ?? doi ?? url ?? id;
  return label ? `Citation: ${label}` : "Citation";
}

function calloutTitle(node: DirectiveNode): string {
  const label = calloutToneLabel(stringAttr(node.attrs, "tone"));
  const title = stringAttr(node.attrs, "title");
  if (!title) return label;
  return label === "Callout" ? title : `${label}: ${title}`;
}

function cardTitle(node: DirectiveNode): string {
  return stringAttr(node.attrs, "title") ?? "Card";
}

function memoryTitle(node: DirectiveNode): string {
  const label = memoryTypeLabel(attrText(node.attrs, "type"));
  const title = stringAttr(node.attrs, "title") ?? node.id;
  return title ? `${label}: ${title}` : label;
}

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

function technicalTitle(node: DirectiveNode): string {
  const title = stringAttr(node.attrs, "title") ?? stringAttr(node.attrs, "name");
  switch (node.name) {
    case "api":
      return title ? `API: ${title}` : "API";
    case "endpoint": {
      const method = attrText(node.attrs, "method")?.toUpperCase();
      const path = attrText(node.attrs, "path") ?? attrText(node.attrs, "url");
      const label = [method, path].filter(Boolean).join(" ");
      return label ? `Endpoint: ${label}` : title ? `Endpoint: ${title}` : "Endpoint";
    }
    case "parameter": {
      const name = title ?? attrText(node.attrs, "key") ?? node.id;
      return name ? `Parameter: ${name}` : "Parameter";
    }
    case "example":
      return title ? `Example: ${title}` : "Example";
    case "changelog": {
      const version = attrText(node.attrs, "version");
      return version ? `Changelog: ${version}` : title ? `Changelog: ${title}` : "Changelog";
    }
    case "instruction":
      return title ? `Instruction: ${title}` : "Instruction";
    case "query":
      return title ? `Query: ${title}` : "Query";
    default:
      return genericDirectiveTitle(node);
  }
}

function technicalLanguage(node: DirectiveNode): string | undefined {
  return attrText(node.attrs, "lang") ?? attrText(node.attrs, "language") ?? attrText(node.attrs, "format");
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

function collectControlData(doc: DocumentNode): ControlDataEntry[] {
  const entries: ControlDataEntry[] = [];
  const seen = new Set<string>();
  for (const node of walk(doc)) {
    if (node.type !== "directive" || node.name !== "control" || !node.id) continue;
    if (seen.has(node.id)) continue;
    seen.add(node.id);
    entries.push({
      id: node.id,
      type: attrText(node.attrs, "type") ?? "text",
      label: actionLabel(node, "Control"),
      value: controlDefaultText(node) ?? "",
    });
  }
  return entries;
}

function collectCitations(doc: DocumentNode): CitationEntry[] {
  const entries: CitationEntry[] = [];
  for (const node of walk(doc)) {
    if (node.type !== "directive" || node.name !== "citation") continue;
    const entry: CitationEntry = {};
    if (node.id) entry.id = node.id;
    const source = stringAttr(node.attrs, "source");
    const title = stringAttr(node.attrs, "title");
    const url = stringAttr(node.attrs, "url") ?? stringAttr(node.attrs, "href");
    const doi = stringAttr(node.attrs, "doi");
    const accessed = stringAttr(node.attrs, "accessed");
    const body = directiveBodyText(node, "");
    if (source) entry.source = source;
    if (title) entry.title = title;
    if (url) entry.url = url;
    if (doi) entry.doi = doi;
    if (accessed) entry.accessed = accessed;
    if (body) entry.body = body;
    entries.push(entry);
  }
  return entries;
}

function collectSections(doc: DocumentNode): SectionEntry[] {
  const entries: SectionEntry[] = [];
  for (const node of walk(doc)) {
    if (node.type !== "section") continue;
    entries.push({ id: node.id, title: node.title, level: node.level });
  }
  return entries;
}

function collectCaptions(doc: DocumentNode): CaptionEntry[] {
  const entries: CaptionEntry[] = [];
  for (const node of walk(doc)) {
    if (node.type !== "directive") continue;
    const entry = captionEntry(node);
    if (entry) entries.push(entry);
  }
  return entries;
}

function captionEntry(node: DirectiveNode): CaptionEntry | undefined {
  if (node.name === "figure") {
    return {
      ...(node.id ? { id: node.id } : {}),
      kind: "figures",
      title: stringAttr(node.attrs, "caption") ?? stringAttr(node.attrs, "title") ?? "Figure",
    };
  }
  if (node.name === "plot" || node.name === "computed_plot") {
    return {
      ...(node.id ? { id: node.id } : {}),
      kind: "plots",
      title: computedLabel(node, "Plot"),
    };
  }
  if (node.name === "table") {
    const title = stringAttr(node.attrs, "title") ?? stringAttr(node.attrs, "caption");
    if (!title) return undefined;
    return {
      ...(node.id ? { id: node.id } : {}),
      kind: "tables",
      title,
    };
  }
  return undefined;
}

function tocEntryRuns(entry: SectionEntry, ctx: DocxCtx): string {
  if (entry.id) {
    const anchor = ctx.bookmarkNames.get(entry.id);
    if (anchor) {
      return `<w:hyperlink w:anchor="${xmlAttr(anchor)}">${inlineRuns(entry.title, ctx, { color: "0563C1", underline: true })}</w:hyperlink>${tabRun()}${fieldRun(`PAGEREF ${anchor} \\h`, "1")}`;
    }
  }
  return inlineRuns(entry.title, ctx);
}

function captionTocEntryRuns(entry: CaptionEntry, ctx: DocxCtx): string {
  const label = `${captionEntryDisplayKind(entry.kind)}: ${entry.title}`;
  if (entry.id) {
    const anchor = ctx.bookmarkNames.get(entry.id);
    if (anchor) {
      return `<w:hyperlink w:anchor="${xmlAttr(anchor)}">${inlineRuns(label, ctx, { color: "0563C1", underline: true })}</w:hyperlink>${tabRun()}${fieldRun(`PAGEREF ${anchor} \\h`, "1")}`;
    }
  }
  return inlineRuns(label, ctx);
}

function captionEntryDisplayKind(kind: CaptionEntry["kind"]): string {
  if (kind === "figures") return "Figure";
  if (kind === "tables") return "Table";
  return "Plot";
}

function citationEntryRuns(entry: CitationEntry, ctx: DocxCtx): string {
  const parts = [citationEntryText(entry)];
  if (entry.accessed) parts.push(`Accessed: ${entry.accessed}`);
  let runs = inlineRuns(parts.join(" "), ctx);
  if (entry.url) runs += textRun(" ") + linkRuns("URL", entry.url, ctx, {});
  if (entry.doi) runs += textRun(" ") + linkRuns(`DOI: ${entry.doi}`, `https://doi.org/${entry.doi}`, ctx, {});
  return runs;
}

function citationEntryText(entry: CitationEntry): string {
  const primary = entry.source ?? entry.title ?? entry.doi ?? entry.url ?? entry.id ?? "Untitled source";
  const body = entry.body?.replace(/\s+/g, " ").trim();
  return body && body !== primary ? `${primary} - ${body}` : primary;
}

function stringAttr(attrs: Attrs, key: string): string | undefined {
  const value = attrs[key];
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function attrText(attrs: Attrs, key: string): string | undefined {
  const value = attrs[key];
  return value === undefined ? undefined : String(value);
}

function hasAttr(attrs: Attrs, key: string): boolean {
  return attrs[key] !== undefined;
}

function boolAttr(attrs: Attrs, key: string): boolean {
  const value = attrs[key];
  return value === true || value === "true" || value === "yes";
}

function lengthAttr(attrs: Attrs, keys: string[], fallback: number | undefined): number | undefined {
  for (const key of keys) {
    const value = attrs[key];
    if (value !== undefined) return lengthToTwips(value, fallback);
  }
  return fallback;
}

function lengthToTwips(value: AttrValue, fallback: number | undefined): number | undefined {
  if (typeof value === "number") return Math.max(0, Math.round(value * 1440));
  if (typeof value !== "string") return fallback;
  const match = /^\s*([0-9]+(?:\.[0-9]+)?)\s*(twips?|in|inch|inches|mm|cm|pt)?\s*$/i.exec(value);
  if (!match) return fallback;
  const amount = Number(match[1]);
  const unit = (match[2] ?? "in").toLowerCase();
  if (!Number.isFinite(amount)) return fallback;
  if (unit === "twip" || unit === "twips") return Math.max(0, Math.round(amount));
  if (unit === "pt") return Math.max(0, Math.round(amount * 20));
  if (unit === "mm") return Math.max(0, Math.round(amount * 56.692913));
  if (unit === "cm") return Math.max(0, Math.round(amount * 566.92913));
  return Math.max(0, Math.round(amount * 1440));
}

function alignAttr(attrs: Attrs): "left" | "center" | "right" | undefined {
  const align = stringAttr(attrs, "align");
  if (align === "left" || align === "center" || align === "right") return align;
  return undefined;
}

function readPositiveInteger(value: Attrs[string] | undefined): number | undefined {
  const parsed = typeof value === "number" ? value : typeof value === "string" ? Number(value) : NaN;
  if (!Number.isInteger(parsed) || parsed <= 0) return undefined;
  return parsed;
}

function directiveFrame(node: DirectiveNode): DirectiveFrame | undefined {
  switch (node.name) {
    case "summary":
    case "abstract":
      return { color: "203C2F", border: "578A68", fill: "EAF2EF" };
    case "claim":
      return { color: "315A34", border: "548D57", fill: "F1F6EF" };
    case "evidence":
      return { color: "2B5265", border: "4F86A0", fill: "EFF6F8" };
    case "counterevidence":
      return { color: "6B4B13", border: "B8872E", fill: "FFF3DF" };
    case "assumption":
    case "hypothesis":
    case "result":
    case "limitation":
    case "open_question":
      return { color: "2B5265", border: "4F86A0", fill: "EFF6F8" };
    case "risk":
      return riskFrame(node.attrs);
    case "decision":
    case "adr":
      return { color: "493E78", border: "7B6EA8", fill: "F1EFF8" };
    case "agent_task":
    case "todo":
      return { color: "304B75", border: "5E7CAA", fill: "EEF3FA" };
    case "metric":
    case "computed_metric":
      return { color: "2B5265", border: "4F86A0", fill: "EFF6F8" };
    case "code_cell":
    case "code":
    case "output":
      return { color: "46505A", border: "7E8B96", fill: "F3F4F6" };
    case "review":
    case "provenance":
    case "confidence":
      return { color: "493E78", border: "7B6EA8", fill: "F1EFF8" };
    case "comment":
      return { color: "6B4B13", border: "B8872E", fill: "FFF3DF" };
    case "change_request":
      return { color: "8B2E20", border: "C85C4A", fill: "FBEDEC" };
    case "callout":
      return calloutFrame(node.attrs);
    case "note":
    case "warning":
    case "tip":
      return calloutFrame(node.attrs, node.name);
    case "citation":
    case "footnote":
    case "bibliography":
      return { color: "5B4620", border: "9C7C45", fill: "F4F1EA" };
    case "state_change":
      return { color: "553C67", border: "8C6CA7", fill: "F5F1F8" };
    case "card":
      return cardFrame(node.attrs);
    case "memory":
      return memoryFrame(node.attrs);
    case "memory_index":
      return { color: "46505A", border: "7E8B96", fill: "F3F4F6" };
    case "api":
    case "endpoint":
    case "parameter":
    case "example":
    case "changelog":
    case "instruction":
    case "query":
      return { color: "2B5265", border: "4F86A0", fill: "EFF6F8" };
    default:
      return undefined;
  }
}

function cardFrame(attrs: Attrs): DirectiveFrame {
  const variant = stringAttr(attrs, "variant")?.toLowerCase();
  if (variant === "important") return { color: "493E78", border: "7B6EA8", fill: "F1EFF8" };
  if (variant === "success") return { color: "315A34", border: "548D57", fill: "F1F6EF" };
  if (variant === "danger" || variant === "warning") return { color: "8B2E20", border: "C85C4A", fill: "FBEDEC" };
  if (variant === "info") return { color: "2B5265", border: "4F86A0", fill: "EFF6F8" };
  if (variant === "subtle") return { color: "46505A", border: "C7CDD2", fill: "FAFAFA" };
  return { color: "46505A", border: "7E8B96", fill: "F3F4F6" };
}

function memoryFrame(attrs: Attrs): DirectiveFrame {
  const type = attrText(attrs, "type")?.toLowerCase();
  if (type === "user") return { color: "203C2F", border: "578A68", fill: "EAF2EF" };
  if (type === "feedback") return { color: "493E78", border: "7B6EA8", fill: "F1EFF8" };
  if (type === "project") return { color: "2B5265", border: "4F86A0", fill: "EFF6F8" };
  if (type === "reference") return { color: "5B4620", border: "9C7C45", fill: "F4F1EA" };
  return { color: "46505A", border: "7E8B96", fill: "F3F4F6" };
}

function riskFrame(attrs: Attrs): DirectiveFrame {
  const severity = typeof attrs.severity === "string" ? attrs.severity.toLowerCase() : "";
  if (severity === "high" || severity === "critical") {
    return { color: "8B2E20", border: "C85C4A", fill: "FBEDEC" };
  }
  if (severity === "medium") {
    return { color: "6B4B13", border: "B8872E", fill: "FFF3DF" };
  }
  return { color: "46505A", border: "7E8B96", fill: "F3F4F6" };
}

function calloutFrame(attrs: Attrs, toneOverride?: string): DirectiveFrame {
  const tone = (toneOverride ?? (typeof attrs.tone === "string" ? attrs.tone : "")).toLowerCase();
  if (tone === "warning" || tone === "danger") {
    return { color: "8B2E20", border: "C85C4A", fill: "FBEDEC" };
  }
  if (tone === "tip" || tone === "success") {
    return { color: "315A34", border: "548D57", fill: "F1F6EF" };
  }
  if (tone === "info" || tone === "note") {
    return { color: "2B5265", border: "4F86A0", fill: "EFF6F8" };
  }
  return { color: "47514A", border: "AAB7AF", fill: "F6F8F6" };
}

function attrsSummary(attrs: Attrs): string {
  const skip = new Set(["id", "title", "caption", "variant"]);
  return Object.entries(attrs)
    .filter(([key]) => !skip.has(key))
    .map(([key, value]) => {
      const label = readableAttributeName(key);
      return value === true ? label : `${label}=${String(value)}`;
    })
    .join(", ");
}

function readableDirectiveName(name: string): string {
  const words = splitIdentifierWords(name);
  if (words.length === 0) return "Directive";
  return words.map((word, index) => (index === 0 ? titleWord(word) : word.toLowerCase())).join(" ");
}

function readableAttributeName(name: string): string {
  return splitIdentifierWords(name).join(" ") || name;
}

function splitIdentifierWords(value: string): string[] {
  return value.split(/::|[:_-]+/).map((part) => part.trim()).filter(Boolean);
}

function titleWord(word: string): string {
  if (word === word.toUpperCase()) return word;
  return word.charAt(0).toUpperCase() + word.slice(1).toLowerCase();
}

function isVerbatimDirective(name: string): boolean {
  return name === "diagram" || name === "plotly" || name === "html" || name === "svg" || name === "script";
}

function isTechnicalDirective(name: string): boolean {
  return name === "api" || name === "endpoint" || name === "parameter" || name === "example" || name === "changelog" || name === "instruction" || name === "query";
}

function paragraph(runs: string, options: ParagraphOptions = {}): string {
  const props: string[] = [];
  if (options.style) props.push(`<w:pStyle w:val="${xmlAttr(options.style)}"/>`);
  if (options.align) props.push(`<w:jc w:val="${options.align}"/>`);
  if (options.numId !== undefined) {
    props.push(`<w:numPr><w:ilvl w:val="0"/><w:numId w:val="${options.numId}"/></w:numPr>`);
  }
  if (options.indentLeft !== undefined) {
    props.push(`<w:ind w:left="${options.indentLeft}"/>`);
  }
  if (options.tabRight !== undefined) {
    props.push(`<w:tabs><w:tab w:val="right" w:leader="dot" w:pos="${options.tabRight}"/></w:tabs>`);
  }
  const borders: string[] = [];
  if (options.frame) {
    borders.push(`<w:left w:val="single" w:sz="12" w:space="8" w:color="${xmlAttr(options.frame.border)}"/>`);
  }
  if (options.bottomBorder) {
    borders.push('<w:bottom w:val="single" w:sz="6" w:space="1" w:color="AAB7AF"/>');
  }
  if (borders.length > 0) {
    props.push(`<w:pBdr>${borders.join("")}</w:pBdr>`);
  }
  if (options.frame) {
    props.push(`<w:shd w:fill="${xmlAttr(options.frame.fill)}"/>`);
  }
  if (options.sectionProperties) {
    props.push(options.sectionProperties);
  }
  const pPr = props.length > 0 ? `<w:pPr>${props.join("")}</w:pPr>` : "";
  const bookmarkIds = [
    ...(options.bookmarkId ? [options.bookmarkId] : []),
    ...(options.bookmarkIds ?? []),
  ];
  const bookmarkStarts = bookmarkIds.map(bookmarkStartXml).join("");
  const bookmarkEnds = [...bookmarkIds].reverse().map(bookmarkEndXml).join("");
  const body = options.commentIds?.length ? commentRangeRuns(runs, options.commentIds) : runs;
  const footnotes = options.footnoteIds?.map(footnoteReferenceRun).join("") ?? "";
  const endnotes = options.endnoteIds?.map(endnoteReferenceRun).join("") ?? "";
  return `    <w:p>${pPr}${bookmarkStarts}${body}${footnotes}${endnotes}${bookmarkEnds}</w:p>\n`;
}

function commentRangeRuns(runs: string, commentIds: number[]): string {
  const inner = runs || textRun("Comment");
  const starts = commentIds.map((id) => `<w:commentRangeStart w:id="${id}"/>`).join("");
  const ends = [...commentIds].reverse().map((id) => `<w:commentRangeEnd w:id="${id}"/>`).join("");
  const refs = commentIds.map((id) => `<w:r><w:commentReference w:id="${id}"/></w:r>`).join("");
  return starts + inner + ends + refs;
}

function bookmarkStartXml(id: string | undefined): string {
  if (!id) return "";
  return `{{BOOKMARK_START:${xmlAttr(id)}}}`;
}

function bookmarkEndXml(id: string | undefined): string {
  if (!id) return "";
  return `{{BOOKMARK_END:${xmlAttr(id)}}}`;
}

function resolveBookmarkPlaceholders(xml: string, ctx: DocxCtx): string {
  return xml.replace(/\{\{BOOKMARK_(START|END):([^}]+)\}\}/g, (_match, kind: string, rawId: string) => {
    const id = unescapePlaceholderId(rawId);
    const name = ctx.bookmarkNames.get(id);
    if (!name) return "";
    const num = bookmarkNumber(id, ctx);
    return kind === "START"
      ? `<w:bookmarkStart w:id="${num}" w:name="${xmlAttr(name)}"/>`
      : `<w:bookmarkEnd w:id="${num}"/>`;
  });
}

function bookmarkNumber(id: string, ctx: DocxCtx): number {
  let num = ctx.bookmarkIds.get(id);
  if (num === undefined) {
    num = ctx.nextBookmarkId++;
    ctx.bookmarkIds.set(id, num);
  }
  return num;
}

function unescapePlaceholderId(id: string): string {
  return id
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

type RelationshipScope = "document" | "header" | "footer" | "comments" | "footnotes" | "endnotes";
type TextElementName = "t" | "delText";

function editableLabelRuns(label: string, ctx: DocxCtx, style: RunStyle): string {
  return inlineRuns(label, ctx, nonGeneratedLabelStyle(style));
}

function nonGeneratedLabelStyle(style: RunStyle): RunStyle {
  const out = { ...style };
  delete out.bold;
  return out;
}

function inlineRuns(
  src: string,
  ctx: DocxCtx,
  base: RunStyle = {},
  relationshipScope: RelationshipScope = ctx.relationshipScope ?? "document",
): string {
  return inlineRunsWithTextElement(src, ctx, base, "t", relationshipScope);
}

function inlineRunsWithTextElement(
  src: string,
  ctx: DocxCtx,
  base: RunStyle = {},
  textElement: TextElementName = "t",
  relationshipScope: RelationshipScope = ctx.relationshipScope ?? "document",
): string {
  const out: string[] = [];
  let i = 0;
  while (i < src.length) {
    const next = nextInlineToken(src, i);
    if (!next) {
      out.push(textRunWithElement(normalizeVisibleInlineText(src.slice(i)), base, textElement));
      break;
    }
    if (next.index > i) {
      out.push(textRunWithElement(normalizeVisibleInlineText(src.slice(i, next.index)), base, textElement));
    }
    if (next.kind === "code") out.push(textRunWithElement(normalizeInlineText(next.text), { ...base, code: true }, textElement));
    else if (next.kind === "boldItalic") out.push(inlineRunsWithTextElement(next.text, ctx, { ...base, bold: true, italic: true }, textElement, relationshipScope));
    else if (next.kind === "bold") out.push(inlineRunsWithTextElement(next.text, ctx, { ...base, bold: true }, textElement, relationshipScope));
    else if (next.kind === "italic") out.push(inlineRunsWithTextElement(next.text, ctx, { ...base, italic: true }, textElement, relationshipScope));
    else if (next.kind === "math") out.push(textElement === "t" ? officeMathRun(next.text) : textRunWithElement(next.text, base, textElement));
    else if (next.kind === "link") out.push(linkRunsWithTextElement(next.text, next.href ?? "", ctx, base, relationshipScope, textElement));
    else if (next.kind === "wikilink") out.push(wikilinkRunsWithTextElement(next.text, ctx, base, textElement));
    i = next.end;
  }
  return out.join("");
}

type InlineToken =
  | { kind: "code" | "boldItalic" | "bold" | "italic" | "math" | "wikilink"; index: number; end: number; text: string }
  | { kind: "link"; index: number; end: number; text: string; href: string };

function nextInlineToken(src: string, start: number): InlineToken | null {
  const slice = src.slice(start);
  const specs: Array<{ kind: InlineToken["kind"]; re: RegExp }> = [
    { kind: "code", re: /`([^`]+)`/ },
    { kind: "boldItalic", re: /\*\*\*([^*\n]+)\*\*\*/ },
    { kind: "bold", re: /\*\*([^*]+)\*\*/ },
    { kind: "link", re: /\[((?:\\.|[^\]\\])+)\]\(([^)\s]+)\)/ },
    { kind: "wikilink", re: /\[\[([a-zA-Z_][\w\-./:]*)\]\]/ },
    { kind: "math", re: /\\\(([\s\S]+?)\\\)/ },
    { kind: "math", re: /\\\[([\s\S]+?)\\\]/ },
    { kind: "math", re: /\$\$([^$\n]+?)\$\$/ },
    { kind: "math", re: /\$([^$\n]+?)\$/ },
    { kind: "italic", re: /\*([^*\n]+)\*/ },
    { kind: "italic", re: /\b_([^_\n]+)_\b/ },
  ];
  let best: InlineToken | null = null;
  for (const spec of specs) {
    const match = spec.re.exec(slice);
    if (!match || match.index === undefined) continue;
    const index = start + match.index;
    const full = match[0] ?? "";
    const text = spec.kind === "link" ? unescapeMarkdownLinkLabel(match[1] ?? "") : match[1] ?? "";
    const token = spec.kind === "link"
      ? { kind: "link" as const, index, end: index + full.length, text, href: match[2] ?? "" }
      : { kind: spec.kind as Exclude<InlineToken["kind"], "link">, index, end: index + full.length, text };
    if (!best || token.index < best.index) best = token;
  }
  return best;
}

function normalizeInlineText(text: string): string {
  const hardBreak = "\u0000";
  return text
    .replace(/\r\n?/g, "\n")
    .replace(/(?: {2,}|\\)\n/g, hardBreak)
    .replace(/\n/g, " ")
    .replace(new RegExp(hardBreak, "g"), "\n");
}

function normalizeVisibleInlineText(text: string): string {
  return unescapeMarkdownTextEscapes(normalizeInlineText(text));
}

function linkRuns(
  label: string,
  href: string,
  ctx: DocxCtx,
  base: RunStyle,
  relationshipScope: RelationshipScope = "document",
): string {
  return linkRunsWithTextElement(label, href, ctx, base, relationshipScope, "t");
}

function linkRunsWithTextElement(
  label: string,
  href: string,
  ctx: DocxCtx,
  base: RunStyle,
  relationshipScope: RelationshipScope,
  textElement: TextElementName,
): string {
  if (href.startsWith("#")) {
    const anchor = ctx.bookmarkNames.get(href.slice(1));
    if (anchor) {
      return `<w:hyperlink w:anchor="${xmlAttr(anchor)}">${linkLabelRunsWithTextElement(label, ctx, base, relationshipScope, textElement)}</w:hyperlink>`;
    }
  }
  if (/^(https?:|mailto:)/i.test(href)) {
    const relId = addHyperlinkRelationship(ctx, href, relationshipScope);
    return `<w:hyperlink r:id="${xmlAttr(relId)}" w:history="1">${linkLabelRunsWithTextElement(label, ctx, base, relationshipScope, textElement)}</w:hyperlink>`;
  }
  return textRunWithElement(`${label} (${href})`, base, textElement);
}

function linkLabelRunsWithTextElement(
  label: string,
  ctx: DocxCtx,
  base: RunStyle,
  relationshipScope: RelationshipScope,
  textElement: TextElementName,
): string {
  return inlineRunsWithTextElement(
    label,
    ctx,
    { ...base, color: "0563C1", underline: true },
    textElement,
    relationshipScope,
  );
}

function addHyperlinkRelationship(
  ctx: DocxCtx,
  href: string,
  relationshipScope: RelationshipScope,
): string {
  const type = "http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink";
  if (relationshipScope === "header") return addHeaderRelationship(ctx, type, href, "External");
  if (relationshipScope === "footer") return addFooterRelationship(ctx, type, href, "External");
  if (relationshipScope === "comments") return addCommentsRelationship(ctx, type, href, "External");
  if (relationshipScope === "footnotes") return addFootnotesRelationship(ctx, type, href, "External");
  if (relationshipScope === "endnotes") return addEndnotesRelationship(ctx, type, href, "External");
  return addRelationship(ctx, type, href, "External");
}

function wikilinkRuns(id: string, ctx: DocxCtx, base: RunStyle): string {
  return wikilinkRunsWithTextElement(id, ctx, base, "t");
}

function wikilinkRunsWithTextElement(id: string, ctx: DocxCtx, base: RunStyle, textElement: TextElementName): string {
  const anchor = ctx.bookmarkNames.get(id);
  if (!anchor) return textRunWithElement(id, base, textElement);
  const captionLabel = ctx.captionCrossReferences.get(id);
  if (captionLabel && textElement === "t") {
    return fieldRun(`REF ${anchor} \\h`, captionLabel, { ...base, color: "0563C1", underline: true });
  }
  return `<w:hyperlink w:anchor="${xmlAttr(anchor)}">${textRunWithElement(id, { ...base, color: "0563C1", underline: true }, textElement)}</w:hyperlink>`;
}

function textRun(text: string, style: RunStyle = {}): string {
  return textRunWithElement(text, style, "t");
}

function textRunWithElement(text: string, style: RunStyle = {}, textElement: TextElementName = "t"): string {
  if (text.length === 0) return "";
  const parts = normalizeXmlText(text).split("\n");
  const content = parts
    .map((part, index) => `${index > 0 ? "<w:br/>" : ""}<w:${textElement} xml:space="preserve">${xmlText(part)}</w:${textElement}>`)
    .join("");
  return `<w:r>${runProps(style)}${content}</w:r>`;
}

function footnoteReferenceRun(id: number): string {
  return `<w:r><w:rPr><w:rStyle w:val="FootnoteReference"/></w:rPr><w:footnoteReference w:id="${id}"/></w:r>`;
}

function endnoteReferenceRun(id: number): string {
  return `<w:r><w:rPr><w:rStyle w:val="EndnoteReference"/></w:rPr><w:endnoteReference w:id="${id}"/></w:r>`;
}

function imageRun(
  media: DocxMedia,
  extent: { cx: number; cy: number },
  alt: string,
  ctx: DocxCtx,
): string {
  const id = ctx.nextDrawingId++;
  const descr = alt ? ` descr="${xmlAttr(alt)}"` : "";
  return `<w:r><w:drawing><wp:inline distT="0" distB="0" distL="0" distR="0"><wp:extent cx="${extent.cx}" cy="${extent.cy}"/><wp:effectExtent l="0" t="0" r="0" b="0"/><wp:docPr id="${id}" name="${xmlAttr(media.name)}"${descr}/><wp:cNvGraphicFramePr><a:graphicFrameLocks noChangeAspect="1"/></wp:cNvGraphicFramePr><a:graphic><a:graphicData uri="${PIC_NS}"><pic:pic><pic:nvPicPr><pic:cNvPr id="${id}" name="${xmlAttr(media.name)}"${descr}/><pic:cNvPicPr/></pic:nvPicPr><pic:blipFill><a:blip r:embed="${xmlAttr(media.relationshipId)}"/><a:stretch><a:fillRect/></a:stretch></pic:blipFill><pic:spPr><a:xfrm><a:off x="0" y="0"/><a:ext cx="${extent.cx}" cy="${extent.cy}"/></a:xfrm><a:prstGeom prst="rect"><a:avLst/></a:prstGeom></pic:spPr></pic:pic></a:graphicData></a:graphic></wp:inline></w:drawing></w:r>`;
}

function addMedia(ctx: DocxCtx, image: DecodedImage): DocxMedia {
  const index = ctx.nextMediaId++;
  const name = `image${index}.${image.extension}`;
  const relationshipId = addScopedRelationship(ctx, `${PACKAGE_REL_NS}/image`, `media/${name}`);
  const media: DocxMedia = {
    relationshipId,
    path: `word/media/${name}`,
    name,
    extension: image.extension,
    contentType: image.contentType,
    data: image.data,
    ...(image.widthPx ? { widthPx: image.widthPx } : {}),
    ...(image.heightPx ? { heightPx: image.heightPx } : {}),
  };
  ctx.media.push(media);
  return media;
}

function imageExtent(media: DocxMedia, attrs: Attrs, setup: PageSetup): { cx: number; cy: number } {
  const maxWidth = Math.max(914400, (setup.width - setup.margins.left - setup.margins.right) * 635);
  const requestedWidth = lengthAttr(attrs, ["width"], undefined);
  const requestedHeight = lengthAttr(attrs, ["height"], undefined);
  let cx = requestedWidth !== undefined ? requestedWidth * 635 : undefined;
  let cy = requestedHeight !== undefined ? requestedHeight * 635 : undefined;
  const naturalWidth = media.widthPx ? media.widthPx * 9525 : undefined;
  const naturalHeight = media.heightPx ? media.heightPx * 9525 : undefined;
  if (cx === undefined && cy === undefined) {
    cx = naturalWidth ?? Math.min(maxWidth, 4 * 914400);
    cy = naturalWidth && naturalHeight ? Math.round(cx * (naturalHeight / naturalWidth)) : Math.round(cx * 0.5625);
  } else if (cx !== undefined && cy === undefined) {
    cy = naturalWidth && naturalHeight ? Math.round(cx * (naturalHeight / naturalWidth)) : Math.round(cx * 0.5625);
  } else if (cx === undefined && cy !== undefined) {
    cx = naturalWidth && naturalHeight ? Math.round(cy * (naturalWidth / naturalHeight)) : Math.round(cy * 1.7778);
  }
  cx = Math.max(1, Math.round(cx ?? maxWidth));
  cy = Math.max(1, Math.round(cy ?? cx * 0.5625));
  if (requestedWidth === undefined && cx > maxWidth) {
    const scale = maxWidth / cx;
    cx = maxWidth;
    cy = Math.max(1, Math.round(cy * scale));
  }
  return { cx, cy };
}

function extentFromPixels(widthPx: number, heightPx: number, setup: PageSetup): { cx: number; cy: number } {
  const maxWidth = Math.max(914400, (setup.width - setup.margins.left - setup.margins.right) * 635);
  let cx = Math.max(1, Math.round(widthPx * 9525));
  let cy = Math.max(1, Math.round(heightPx * 9525));
  if (cx > maxWidth) {
    const scale = maxWidth / cx;
    cx = maxWidth;
    cy = Math.max(1, Math.round(cy * scale));
  }
  return { cx, cy };
}

function decodeImageDataUri(uri: string): DecodedImage | undefined {
  const match = /^data:([^;,]+)(;base64)?,([\s\S]*)$/i.exec(uri.trim());
  if (!match) return undefined;
  const contentType = match[1]?.toLowerCase();
  const base64 = match[2] !== undefined;
  const payload = match[3] ?? "";
  const extension = imageExtension(contentType);
  if (!contentType || !extension) return undefined;
  let data: Buffer;
  try {
    data = base64
      ? Buffer.from(payload.replace(/\s+/g, ""), "base64")
      : Buffer.from(decodeURIComponent(payload), "binary");
  } catch {
    return undefined;
  }
  const dimensions = imageDimensions(contentType, data);
  return {
    contentType,
    extension,
    data,
    ...(dimensions ? { widthPx: dimensions.width, heightPx: dimensions.height } : {}),
  };
}

function imageExtension(contentType: string | undefined): string | undefined {
  if (contentType === "image/png") return "png";
  if (contentType === "image/jpeg" || contentType === "image/jpg") return "jpg";
  if (contentType === "image/gif") return "gif";
  if (contentType === "image/svg+xml") return "svg";
  return undefined;
}

function imageDimensions(contentType: string, data: Buffer): { width: number; height: number } | undefined {
  if (contentType === "image/png" && data.length >= 24 && data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) {
    return { width: data.readUInt32BE(16), height: data.readUInt32BE(20) };
  }
  if (contentType === "image/gif" && data.length >= 10 && /GIF8[79]a/.test(data.subarray(0, 6).toString("ascii"))) {
    return { width: data.readUInt16LE(6), height: data.readUInt16LE(8) };
  }
  if ((contentType === "image/jpeg" || contentType === "image/jpg") && data.length > 4) {
    return jpegDimensions(data);
  }
  if (contentType === "image/svg+xml") {
    return svgDimensions(data.toString("utf8"));
  }
  return undefined;
}

function svgDimensions(source: string): { width: number; height: number } | undefined {
  const open = source.match(/<svg\b[^>]*>/i)?.[0];
  if (!open) return undefined;
  const width = svgLengthToPixels(svgAttr(open, "width"));
  const height = svgLengthToPixels(svgAttr(open, "height"));
  if (width !== undefined && height !== undefined) return { width, height };
  const viewBox = svgAttr(open, "viewBox");
  if (!viewBox) return undefined;
  const nums = viewBox.trim().split(/[\s,]+/).map(Number);
  if (nums.length < 4) return undefined;
  const boxWidth = nums[2]!;
  const boxHeight = nums[3]!;
  if (!Number.isFinite(boxWidth) || !Number.isFinite(boxHeight) || boxWidth <= 0 || boxHeight <= 0) {
    return undefined;
  }
  return {
    width: width ?? Math.round(boxWidth),
    height: height ?? Math.round(boxHeight),
  };
}

function svgAttr(openTag: string, name: string): string | undefined {
  const match = new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`, "i").exec(openTag);
  return match?.[1] ?? match?.[2] ?? match?.[3];
}

function svgLengthToPixels(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const match = /^\s*([0-9]+(?:\.[0-9]+)?)(px|pt|in|mm|cm)?\s*$/i.exec(value);
  if (!match) return undefined;
  const amount = Number(match[1]);
  if (!Number.isFinite(amount) || amount <= 0) return undefined;
  const unit = (match[2] ?? "px").toLowerCase();
  const px = unit === "in"
    ? amount * 96
    : unit === "pt"
      ? amount * (96 / 72)
      : unit === "mm"
        ? amount * (96 / 25.4)
        : unit === "cm"
          ? amount * (96 / 2.54)
          : amount;
  return Math.max(1, Math.round(px));
}

function jpegDimensions(data: Buffer): { width: number; height: number } | undefined {
  if (data.readUInt16BE(0) !== 0xffd8) return undefined;
  let offset = 2;
  while (offset + 9 < data.length) {
    if (data[offset] !== 0xff) return undefined;
    const marker = data[offset + 1];
    offset += 2;
    if (marker === 0xd9 || marker === 0xda) return undefined;
    const length = data.readUInt16BE(offset);
    if (length < 2 || offset + length > data.length) return undefined;
    if (
      marker !== undefined &&
      ((marker >= 0xc0 && marker <= 0xc3) ||
        (marker >= 0xc5 && marker <= 0xc7) ||
        (marker >= 0xc9 && marker <= 0xcb) ||
        (marker >= 0xcd && marker <= 0xcf))
    ) {
      return { height: data.readUInt16BE(offset + 3), width: data.readUInt16BE(offset + 5) };
    }
    offset += length;
  }
  return undefined;
}

function runProps(style: RunStyle): string {
  const props: string[] = [];
  if (style.bold) props.push("<w:b/>");
  if (style.italic) props.push("<w:i/>");
  if (style.underline) props.push('<w:u w:val="single"/>');
  if (style.strike) props.push("<w:strike/>");
  if (style.color) props.push(`<w:color w:val="${xmlAttr(style.color)}"/>`);
  if (style.code) {
    props.push('<w:rFonts w:ascii="Courier New" w:hAnsi="Courier New" w:cs="Courier New"/>');
    props.push('<w:sz w:val="20"/>');
    props.push('<w:shd w:fill="EEF2F0"/>');
  }
  return props.length > 0 ? `<w:rPr>${props.join("")}</w:rPr>` : "";
}

function addRelationship(
  ctx: DocxCtx,
  type: string,
  target: string,
  targetMode?: "External",
): string {
  const id = `rId${ctx.nextRelationshipId++}`;
  ctx.relationships.push({ id, type, target, ...(targetMode ? { targetMode } : {}) });
  return id;
}

function addScopedRelationship(
  ctx: DocxCtx,
  type: string,
  target: string,
  targetMode?: "External",
): string {
  const scope = ctx.relationshipScope ?? "document";
  if (scope === "header") return addHeaderRelationship(ctx, type, target, targetMode);
  if (scope === "footer") return addFooterRelationship(ctx, type, target, targetMode);
  if (scope === "comments") return addCommentsRelationship(ctx, type, target, targetMode);
  if (scope === "footnotes") return addFootnotesRelationship(ctx, type, target, targetMode);
  if (scope === "endnotes") return addEndnotesRelationship(ctx, type, target, targetMode);
  return addRelationship(ctx, type, target, targetMode);
}

function addHeaderRelationship(
  ctx: DocxCtx,
  type: string,
  target: string,
  targetMode?: "External",
): string {
  const id = `rId${ctx.nextHeaderRelationshipId++}`;
  ctx.headerRelationships.push({ id, type, target, ...(targetMode ? { targetMode } : {}) });
  return id;
}

function addFooterRelationship(
  ctx: DocxCtx,
  type: string,
  target: string,
  targetMode?: "External",
): string {
  const id = `rId${ctx.nextFooterRelationshipId++}`;
  ctx.footerRelationships.push({ id, type, target, ...(targetMode ? { targetMode } : {}) });
  return id;
}

function addCommentsRelationship(
  ctx: DocxCtx,
  type: string,
  target: string,
  targetMode?: "External",
): string {
  const id = `rId${ctx.nextCommentsRelationshipId++}`;
  ctx.commentsRelationships.push({ id, type, target, ...(targetMode ? { targetMode } : {}) });
  return id;
}

function addFootnotesRelationship(
  ctx: DocxCtx,
  type: string,
  target: string,
  targetMode?: "External",
): string {
  const id = `rId${ctx.nextFootnotesRelationshipId++}`;
  ctx.footnotesRelationships.push({ id, type, target, ...(targetMode ? { targetMode } : {}) });
  return id;
}

function addEndnotesRelationship(
  ctx: DocxCtx,
  type: string,
  target: string,
  targetMode?: "External",
): string {
  const id = `rId${ctx.nextEndnotesRelationshipId++}`;
  ctx.endnotesRelationships.push({ id, type, target, ...(targetMode ? { targetMode } : {}) });
  return id;
}

function withRelationshipScope<T>(
  ctx: DocxCtx,
  relationshipScope: RelationshipScope,
  render: () => T,
): T {
  const previous = ctx.relationshipScope;
  ctx.relationshipScope = relationshipScope;
  try {
    return render();
  } finally {
    if (previous === undefined) delete ctx.relationshipScope;
    else ctx.relationshipScope = previous;
  }
}

function buildBookmarkNames(doc: DocumentNode): Map<string, string> {
  const names = new Map<string, string>();
  const used = new Set<string>();
  for (const node of walk(doc)) {
    if (!node.id) continue;
    const name = uniqueBookmarkName(node.id, used);
    names.set(node.id, name);
    for (const alias of node.aliases ?? []) names.set(alias, name);
  }
  return names;
}

function buildCaptionCrossReferences(doc: DocumentNode): Map<string, string> {
  const refs = new Map<string, string>();
  for (const node of walk(doc)) {
    if (node.type !== "directive" || !node.id) continue;
    const label = captionReferenceLabel(node);
    if (!label) continue;
    refs.set(node.id, label);
    for (const alias of node.aliases ?? []) refs.set(alias, label);
  }
  return refs;
}

function captionReferenceLabel(node: DirectiveNode): string | undefined {
  if (node.name === "figure") return "Figure";
  if (node.name === "plot" || node.name === "computed_plot") return "Plot";
  if (node.name === "table" && (stringAttr(node.attrs, "title") ?? stringAttr(node.attrs, "caption"))) {
    return "Table";
  }
  return undefined;
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

function extractFirstHeading(doc: DocumentNode): string | undefined {
  for (const node of walk(doc)) {
    if (node.type === "section") return node.title;
  }
  return undefined;
}

function docxCoreProperties(doc: DocumentNode, title: string, options: DocxRenderOptions): CoreProperties {
  const description =
    options.description ??
    metaString(doc.meta, "description", "summary", "abstract") ??
    "Generated from Noma plain-text source.";
  return {
    title,
    creator: options.creator ?? metaString(doc.meta, "author", "creator") ?? "Noma",
    description,
    keywords: keywordText(options.keywords) ?? metaKeywords(doc.meta),
    category: options.category ?? metaProfileCategory(doc.meta),
    status: options.status ?? metaString(doc.meta, "status"),
  };
}

function metaString(meta: Record<string, unknown>, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = meta[key];
    if (typeof value === "string" && value.trim()) return value.trim();
    if (typeof value === "number" || typeof value === "boolean") return String(value);
  }
  return undefined;
}

function metaKeywords(meta: Record<string, unknown>): string | undefined {
  return keywordText(meta.tags) ?? keywordText(meta.keywords);
}

function keywordText(value: unknown): string | undefined {
  if (typeof value === "string" && value.trim()) return value.trim();
  if (!Array.isArray(value)) return undefined;
  const keywords = value
    .map((item) => (typeof item === "string" || typeof item === "number" || typeof item === "boolean" ? String(item).trim() : ""))
    .filter(Boolean);
  return keywords.length > 0 ? keywords.join(", ") : undefined;
}

function metaProfileCategory(meta: Record<string, unknown>): string | undefined {
  const profile = metaString(meta, "profile");
  if (profile) return `profile: ${profile}`;
  const profiles = keywordText(meta.profiles);
  return profiles ? `profiles: ${profiles}` : undefined;
}

function splitLines(text: string): string[] {
  const lines = text.replace(/\r\n?/g, "\n").split("\n");
  return lines.length > 0 ? lines : [""];
}

function normalizeXmlText(text: string): string {
  return text.replace(/[^\u0009\u000A\u000D\u0020-\uD7FF\uE000-\uFFFD]/g, "");
}

function xmlText(text: string): string {
  return normalizeXmlText(text)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function xmlAttr(text: string): string {
  return xmlText(text).replace(/"/g, "&quot;").replace(/'/g, "&apos;");
}

function xpathLiteral(text: string): string {
  if (!text.includes("'")) return `'${text}'`;
  if (!text.includes('"')) return `"${text}"`;
  return `concat(${text.split("'").map((part) => `'${part}'`).join(', "\'", ')})`;
}

function xmlDecl(body: string): string {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n${body}`;
}

function customXmlControlDataXml(entries: ControlDataEntry[]): string {
  const body = entries
    .map((entry) => `  <noma:control id="${xmlAttr(entry.id)}" type="${xmlAttr(entry.type)}">
    <noma:label>${xmlText(entry.label)}</noma:label>
    <noma:value>${xmlText(entry.value)}</noma:value>
  </noma:control>\n`)
    .join("");
  return xmlDecl(`\
<noma:controls xmlns:noma="${NOMA_CONTROLS_NS}">
${body}</noma:controls>`);
}

function customXmlControlDataRelationshipsXml(): string {
  return xmlDecl(`\
<Relationships xmlns="${REL_NS}">
  <Relationship Id="rId1" Type="${PACKAGE_REL_NS}/customXmlProps" Target="itemProps1.xml"/>
</Relationships>`);
}

function customXmlControlDataPropertiesXml(): string {
  return xmlDecl(`\
<ds:datastoreItem ds:itemID="${NOMA_CONTROLS_STORE_ITEM_ID}" xmlns:ds="http://schemas.openxmlformats.org/officeDocument/2006/customXml">
  <ds:schemaRefs/>
</ds:datastoreItem>`);
}

function contentTypesXml(parts: { hasComments?: boolean; hasCommentsEx?: boolean; hasFootnotes?: boolean; hasEndnotes?: boolean; hasHeader?: boolean; hasFooter?: boolean; hasSettings?: boolean; hasControlData?: boolean; media?: DocxMedia[] } = {}): string {
  const commentsOverride = parts.hasComments
    ? '  <Override PartName="/word/comments.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.comments+xml"/>\n'
    : "";
  const commentsExOverride = parts.hasCommentsEx
    ? '  <Override PartName="/word/commentsExtended.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.commentsExtended+xml"/>\n'
    : "";
  const footnotesOverride = parts.hasFootnotes
    ? '  <Override PartName="/word/footnotes.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footnotes+xml"/>\n'
    : "";
  const endnotesOverride = parts.hasEndnotes
    ? '  <Override PartName="/word/endnotes.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.endnotes+xml"/>\n'
    : "";
  const headerOverride = parts.hasHeader
    ? '  <Override PartName="/word/header1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/>\n'
    : "";
  const footerOverride = parts.hasFooter
    ? '  <Override PartName="/word/footer1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.footer+xml"/>\n'
    : "";
  const settingsOverride = parts.hasSettings
    ? '  <Override PartName="/word/settings.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.settings+xml"/>\n'
    : "";
  const customXmlPropertiesOverride = parts.hasControlData
    ? '  <Override PartName="/customXml/itemProps1.xml" ContentType="application/vnd.openxmlformats-officedocument.customXmlProperties+xml"/>\n'
    : "";
  const imageDefaults = imageContentTypeDefaults(parts.media ?? []);
  return xmlDecl(`\
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
${imageDefaults}
  <Override PartName="/docProps/core.xml" ContentType="application/vnd.openxmlformats-package.core-properties+xml"/>
  <Override PartName="/docProps/app.xml" ContentType="application/vnd.openxmlformats-officedocument.extended-properties+xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
${commentsOverride}${commentsExOverride}${footnotesOverride}${endnotesOverride}${headerOverride}${footerOverride}${settingsOverride}${customXmlPropertiesOverride}  <Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
  <Override PartName="/word/numbering.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.numbering+xml"/>
</Types>`);
}

function imageContentTypeDefaults(media: DocxMedia[]): string {
  const byExtension = new Map<string, string>();
  for (const item of media) byExtension.set(item.extension, item.contentType);
  return [...byExtension]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([extension, contentType]) => `  <Default Extension="${xmlAttr(extension)}" ContentType="${xmlAttr(contentType)}"/>\n`)
    .join("");
}

function rootRelationshipsXml(parts: { hasControlData?: boolean } = {}): string {
  const customXmlRelationship = parts.hasControlData
    ? `  <Relationship Id="rId4" Type="${PACKAGE_REL_NS}/customXml" Target="customXml/item1.xml"/>\n`
    : "";
  return xmlDecl(`\
<Relationships xmlns="${REL_NS}">
  <Relationship Id="rId1" Type="${PACKAGE_REL_NS}/officeDocument" Target="word/document.xml"/>
  <Relationship Id="rId2" Type="${CORE_REL_NS}" Target="docProps/core.xml"/>
  <Relationship Id="rId3" Type="${APP_REL_NS}" Target="docProps/app.xml"/>
${customXmlRelationship}\
</Relationships>`);
}

function renderDocumentRelationships(relationships: Relationship[]): string {
  const dynamic = relationships
    .map((rel) => {
      const mode = rel.targetMode ? ` TargetMode="${rel.targetMode}"` : "";
      return `  <Relationship Id="${xmlAttr(rel.id)}" Type="${xmlAttr(rel.type)}" Target="${xmlAttr(rel.target)}"${mode}/>`;
    })
    .join("\n");
  return xmlDecl(`\
<Relationships xmlns="${REL_NS}">
  <Relationship Id="rId1" Type="${PACKAGE_REL_NS}/styles" Target="styles.xml"/>
  <Relationship Id="rId2" Type="${PACKAGE_REL_NS}/numbering" Target="numbering.xml"/>
${dynamic ? `${dynamic}\n` : ""}</Relationships>`);
}

function renderPartRelationships(relationships: Relationship[]): string {
  const body = relationships
    .map((rel) => {
      const mode = rel.targetMode ? ` TargetMode="${rel.targetMode}"` : "";
      return `  <Relationship Id="${xmlAttr(rel.id)}" Type="${xmlAttr(rel.type)}" Target="${xmlAttr(rel.target)}"${mode}/>`;
    })
    .join("\n");
  return xmlDecl(`\
<Relationships xmlns="${REL_NS}">
${body ? `${body}\n` : ""}</Relationships>`);
}

function corePropertiesXml(props: CoreProperties): string {
  const keywords = props.keywords ? `  <cp:keywords>${xmlText(props.keywords)}</cp:keywords>\n` : "";
  const category = props.category ? `  <cp:category>${xmlText(props.category)}</cp:category>\n` : "";
  const status = props.status ? `  <cp:contentStatus>${xmlText(props.status)}</cp:contentStatus>\n` : "";
  return xmlDecl(`\
<cp:coreProperties xmlns:cp="http://schemas.openxmlformats.org/package/2006/metadata/core-properties"
  xmlns:dc="http://purl.org/dc/elements/1.1/"
  xmlns:dcterms="http://purl.org/dc/terms/"
  xmlns:dcmitype="http://purl.org/dc/dcmitype/"
  xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance">
  <dc:title>${xmlText(props.title)}</dc:title>
  <dc:subject>${xmlText(props.description)}</dc:subject>
  <dc:description>${xmlText(props.description)}</dc:description>
  <dc:creator>${xmlText(props.creator)}</dc:creator>
  <cp:lastModifiedBy>${xmlText(props.creator)}</cp:lastModifiedBy>
${keywords}${category}${status}\
  <dcterms:created xsi:type="dcterms:W3CDTF">${FIXED_CORE_TIME}</dcterms:created>
  <dcterms:modified xsi:type="dcterms:W3CDTF">${FIXED_CORE_TIME}</dcterms:modified>
</cp:coreProperties>`);
}

function appPropertiesXml(): string {
  return xmlDecl(`\
<Properties xmlns="http://schemas.openxmlformats.org/officeDocument/2006/extended-properties"
  xmlns:vt="http://schemas.openxmlformats.org/officeDocument/2006/docPropsVTypes">
  <Application>Noma</Application>
  <DocSecurity>0</DocSecurity>
  <ScaleCrop>false</ScaleCrop>
  <Company/>
  <LinksUpToDate>false</LinksUpToDate>
  <SharedDoc>false</SharedDoc>
  <HyperlinksChanged>false</HyperlinksChanged>
  <AppVersion>0.11</AppVersion>
</Properties>`);
}

function commentsXml(comments: DocxComment[], ctx: DocxCtx): string {
  const body = comments.map((comment) => commentXml(comment, ctx)).join("");
  return xmlDecl(`\
<w:comments xmlns:w="${W_NS}" xmlns:r="${R_NS}" xmlns:w15="${W15_NS}" xmlns:mc="${MC_NS}" mc:Ignorable="w15">
${body}</w:comments>`);
}

function commentXml(comment: DocxComment, ctx: DocxCtx): string {
  const bodyParagraphs = comment.body
    .split(/\n\s*\n/)
    .map((part) => part.replace(/\n/g, " ").trim())
    .filter(Boolean);
  const status = commentStatusText(comment);
  const paragraphs = [
    ...(status ? [status] : []),
    ...(bodyParagraphs.length > 0 ? bodyParagraphs : ["Comment"]),
  ];
  const body = paragraphs
    .map((part, index) => `  <w:p${index === 0 ? ` w15:paraId="${comment.paraId}"` : ""}>
    ${index === 0 ? '<w:r><w:annotationRef/></w:r>' : ""}
    ${inlineRuns(part, ctx, {}, "comments")}
  </w:p>\n`)
    .join("");
  return `  <w:comment w:id="${comment.id}" w:author="${xmlAttr(comment.author)}" w:initials="${xmlAttr(comment.initials)}" w:date="${xmlAttr(comment.date)}">
${body}  </w:comment>\n`;
}

function commentsExtendedXml(comments: DocxComment[]): string {
  const body = comments
    .map((comment) => {
      const parent = comment.parentParaId ? ` w15:paraIdParent="${comment.parentParaId}"` : "";
      return `  <w15:commentEx w15:paraId="${comment.paraId}"${parent} w15:done="${comment.status === "resolved" ? "1" : "0"}"/>\n`;
    })
    .join("");
  return xmlDecl(`\
<w15:commentsEx xmlns:w15="${W15_NS}">
${body}</w15:commentsEx>`);
}

function commentStatusText(comment: DocxComment): string | undefined {
  if (comment.status !== "resolved") return undefined;
  const parts = ["Status: resolved"];
  if (comment.resolvedBy) parts.push(`resolved by ${comment.resolvedBy}`);
  if (comment.resolvedAt) parts.push(`resolved at ${comment.resolvedAt}`);
  return parts.join("; ");
}

function footnotesXml(footnotes: DocxFootnote[], ctx: DocxCtx): string {
  const body = withRelationshipScope(ctx, "footnotes", () =>
    footnotes.map((footnote) => footnoteXml(footnote, ctx)).join(""),
  );
  return xmlDecl(`\
<w:footnotes xmlns:w="${W_NS}" xmlns:r="${R_NS}">
  <w:footnote w:id="-1" w:type="separator"><w:p><w:r><w:separator/></w:r></w:p></w:footnote>
  <w:footnote w:id="0" w:type="continuationSeparator"><w:p><w:r><w:continuationSeparator/></w:r></w:p></w:footnote>
${body}</w:footnotes>`);
}

function footnoteXml(footnote: DocxFootnote, ctx: DocxCtx): string {
  const paragraphs = footnote.body
    .split(/\n\s*\n/)
    .map((part) => part.replace(/\n/g, " ").trim())
    .filter(Boolean);
  const body = (paragraphs.length > 0 ? paragraphs : ["Footnote"])
    .map((part, index) => `  <w:p>
    <w:pPr><w:pStyle w:val="FootnoteText"/></w:pPr>
    ${index === 0 ? '<w:r><w:rPr><w:rStyle w:val="FootnoteReference"/></w:rPr><w:footnoteRef/></w:r>' : ""}
    ${inlineRuns(part, ctx, {}, "footnotes")}
  </w:p>\n`)
    .join("");
  return `  <w:footnote w:id="${footnote.id}">
${body}  </w:footnote>\n`;
}

function endnotesXml(endnotes: DocxEndnote[], ctx: DocxCtx): string {
  const body = withRelationshipScope(ctx, "endnotes", () =>
    endnotes.map((endnote) => endnoteXml(endnote, ctx)).join(""),
  );
  return xmlDecl(`\
<w:endnotes xmlns:w="${W_NS}" xmlns:r="${R_NS}">
  <w:endnote w:id="-1" w:type="separator"><w:p><w:r><w:separator/></w:r></w:p></w:endnote>
  <w:endnote w:id="0" w:type="continuationSeparator"><w:p><w:r><w:continuationSeparator/></w:r></w:p></w:endnote>
${body}</w:endnotes>`);
}

function endnoteXml(endnote: DocxEndnote, ctx: DocxCtx): string {
  const paragraphs = endnote.body
    .split(/\n\s*\n/)
    .map((part) => part.replace(/\n/g, " ").trim())
    .filter(Boolean);
  const body = (paragraphs.length > 0 ? paragraphs : ["Endnote"])
    .map((part, index) => `  <w:p>
    <w:pPr><w:pStyle w:val="EndnoteText"/></w:pPr>
    ${index === 0 ? '<w:r><w:rPr><w:rStyle w:val="EndnoteReference"/></w:rPr><w:endnoteRef/></w:r>' : ""}
    ${inlineRuns(part, ctx, {}, "endnotes")}
  </w:p>\n`)
    .join("");
  return `  <w:endnote w:id="${endnote.id}">
${body}  </w:endnote>\n`;
}

function stylesXml(): string {
  return xmlDecl(`\
<w:styles xmlns:w="${W_NS}">
  <w:docDefaults>
    <w:rPrDefault><w:rPr><w:rFonts w:ascii="Aptos" w:hAnsi="Aptos" w:cs="Aptos"/><w:sz w:val="22"/></w:rPr></w:rPrDefault>
    <w:pPrDefault><w:pPr><w:spacing w:after="160" w:line="276" w:lineRule="auto"/></w:pPr></w:pPrDefault>
  </w:docDefaults>
  <w:style w:type="paragraph" w:default="1" w:styleId="Normal">
    <w:name w:val="Normal"/><w:qFormat/>
    <w:pPr><w:spacing w:after="160" w:line="276" w:lineRule="auto"/></w:pPr>
    <w:rPr><w:rFonts w:ascii="Aptos" w:hAnsi="Aptos" w:cs="Aptos"/><w:sz w:val="22"/></w:rPr>
  </w:style>
${headingStyles()}
  <w:style w:type="paragraph" w:styleId="NomaDirective">
    <w:name w:val="Noma Directive"/><w:basedOn w:val="Normal"/><w:qFormat/>
    <w:pPr><w:spacing w:before="180" w:after="80"/><w:keepNext/></w:pPr>
    <w:rPr><w:b/><w:color w:val="3F5F4A"/><w:smallCaps/></w:rPr>
  </w:style>
  <w:style w:type="paragraph" w:styleId="NomaMeta">
    <w:name w:val="Noma Meta"/><w:basedOn w:val="Normal"/>
    <w:pPr><w:spacing w:after="120"/></w:pPr>
    <w:rPr><w:color w:val="6D7770"/><w:sz w:val="20"/></w:rPr>
  </w:style>
  <w:style w:type="paragraph" w:styleId="NomaMetricValue">
    <w:name w:val="Noma Metric Value"/><w:basedOn w:val="Normal"/>
    <w:pPr><w:spacing w:after="120"/></w:pPr>
    <w:rPr><w:b/><w:sz w:val="28"/></w:rPr>
  </w:style>
  <w:style w:type="paragraph" w:styleId="NomaCaption">
    <w:name w:val="Noma Caption"/><w:basedOn w:val="Normal"/>
    <w:pPr><w:spacing w:before="120" w:after="80"/><w:keepNext/></w:pPr>
    <w:rPr><w:b/><w:color w:val="46505A"/><w:sz w:val="20"/></w:rPr>
  </w:style>
  <w:style w:type="paragraph" w:styleId="NomaToc">
    <w:name w:val="Noma Table of Contents"/><w:basedOn w:val="Normal"/>
    <w:pPr><w:spacing w:after="60"/></w:pPr>
    <w:rPr><w:sz w:val="21"/></w:rPr>
  </w:style>
  <w:style w:type="paragraph" w:styleId="FootnoteText">
    <w:name w:val="footnote text"/><w:basedOn w:val="Normal"/>
    <w:pPr><w:spacing w:after="80" w:line="240" w:lineRule="auto"/></w:pPr>
    <w:rPr><w:sz w:val="18"/></w:rPr>
  </w:style>
  <w:style w:type="character" w:styleId="FootnoteReference">
    <w:name w:val="footnote reference"/>
    <w:rPr><w:vertAlign w:val="superscript"/></w:rPr>
  </w:style>
  <w:style w:type="paragraph" w:styleId="EndnoteText">
    <w:name w:val="endnote text"/><w:basedOn w:val="Normal"/>
    <w:pPr><w:spacing w:after="80" w:line="240" w:lineRule="auto"/></w:pPr>
    <w:rPr><w:sz w:val="18"/></w:rPr>
  </w:style>
  <w:style w:type="character" w:styleId="EndnoteReference">
    <w:name w:val="endnote reference"/>
    <w:rPr><w:vertAlign w:val="superscript"/></w:rPr>
  </w:style>
  <w:style w:type="paragraph" w:styleId="NomaCode">
    <w:name w:val="Noma Code"/><w:basedOn w:val="Normal"/>
    <w:pPr><w:spacing w:before="0" w:after="0" w:line="240" w:lineRule="auto"/></w:pPr>
    <w:rPr><w:rFonts w:ascii="Courier New" w:hAnsi="Courier New" w:cs="Courier New"/><w:sz w:val="20"/></w:rPr>
  </w:style>
  <w:style w:type="paragraph" w:styleId="NomaMath">
    <w:name w:val="Noma Math"/><w:basedOn w:val="Normal"/>
    <w:pPr><w:spacing w:before="120" w:after="160"/></w:pPr>
    <w:rPr><w:rFonts w:ascii="Cambria Math" w:hAnsi="Cambria Math" w:cs="Cambria Math"/><w:sz w:val="24"/></w:rPr>
  </w:style>
  <w:style w:type="paragraph" w:styleId="NomaAction">
    <w:name w:val="Noma Action"/><w:basedOn w:val="Normal"/>
    <w:pPr><w:spacing w:before="80" w:after="100"/></w:pPr>
    <w:rPr><w:color w:val="2B5265"/></w:rPr>
  </w:style>
  <w:style w:type="paragraph" w:styleId="NomaQuote">
    <w:name w:val="Noma Quote"/><w:basedOn w:val="Normal"/>
    <w:pPr><w:ind w:left="360"/><w:pBdr><w:left w:val="single" w:sz="12" w:space="8" w:color="AAB7AF"/></w:pBdr></w:pPr>
    <w:rPr><w:i/><w:color w:val="47514A"/></w:rPr>
  </w:style>
  <w:style w:type="table" w:styleId="TableGrid">
    <w:name w:val="Table Grid"/>
    <w:tblPr><w:tblBorders><w:top w:val="single" w:sz="4" w:color="B7C3BC"/><w:left w:val="single" w:sz="4" w:color="B7C3BC"/><w:bottom w:val="single" w:sz="4" w:color="B7C3BC"/><w:right w:val="single" w:sz="4" w:color="B7C3BC"/><w:insideH w:val="single" w:sz="4" w:color="B7C3BC"/><w:insideV w:val="single" w:sz="4" w:color="B7C3BC"/></w:tblBorders></w:tblPr>
  </w:style>
  <w:style w:type="table" w:styleId="NomaLayout">
    <w:name w:val="Noma Layout"/>
    <w:tblPr><w:tblBorders><w:top w:val="single" w:sz="3" w:color="D7E1DC"/><w:left w:val="single" w:sz="3" w:color="D7E1DC"/><w:bottom w:val="single" w:sz="3" w:color="D7E1DC"/><w:right w:val="single" w:sz="3" w:color="D7E1DC"/><w:insideH w:val="single" w:sz="3" w:color="D7E1DC"/><w:insideV w:val="single" w:sz="3" w:color="D7E1DC"/></w:tblBorders></w:tblPr>
  </w:style>
</w:styles>`);
}

function headingStyles(): string {
  const sizes = [36, 30, 26, 24, 22, 22];
  return sizes
    .map((size, index) => {
      const level = index + 1;
      const before = level === 1 ? 260 : 220;
      return `  <w:style w:type="paragraph" w:styleId="Heading${level}">
    <w:name w:val="heading ${level}"/><w:basedOn w:val="Normal"/><w:next w:val="Normal"/><w:qFormat/>
    <w:pPr><w:keepNext/><w:spacing w:before="${before}" w:after="100"/><w:outlineLvl w:val="${index}"/></w:pPr>
    <w:rPr><w:b/><w:color w:val="203C2F"/><w:sz w:val="${size}"/></w:rPr>
  </w:style>`;
    })
    .join("\n");
}

function numberingXml(): string {
  return xmlDecl(`\
<w:numbering xmlns:w="${W_NS}">
  <w:abstractNum w:abstractNumId="1">
    <w:multiLevelType w:val="singleLevel"/>
    <w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="bullet"/><w:lvlText w:val="&#8226;"/><w:lvlJc w:val="left"/><w:pPr><w:tabs><w:tab w:val="num" w:pos="720"/></w:tabs><w:ind w:left="720" w:hanging="360"/></w:pPr></w:lvl>
  </w:abstractNum>
  <w:abstractNum w:abstractNumId="2">
    <w:multiLevelType w:val="singleLevel"/>
    <w:lvl w:ilvl="0"><w:start w:val="1"/><w:numFmt w:val="decimal"/><w:lvlText w:val="%1."/><w:lvlJc w:val="left"/><w:pPr><w:tabs><w:tab w:val="num" w:pos="720"/></w:tabs><w:ind w:left="720" w:hanging="360"/></w:pPr></w:lvl>
  </w:abstractNum>
  <w:num w:numId="1"><w:abstractNumId w:val="1"/></w:num>
  <w:num w:numId="2"><w:abstractNumId w:val="2"/></w:num>
</w:numbering>`);
}

function settingsXml(features: SettingsFeatures): string {
  const updateFields = features.updateFields
    ? '  <w:updateFields w:val="true"/>\n'
    : "";
  const revisionView = features.revisionView
    ? '  <w:revisionView w:markup="1" w:comments="1" w:insDel="1" w:formatting="0"/>\n'
    : "";
  const protection = features.protection
    ? `  <w:documentProtection w:edit="${features.protection.edit}" w:enforcement="${features.protection.enforcement ? "1" : "0"}"/>\n`
    : "";
  return xmlDecl(`\
<w:settings xmlns:w="${W_NS}">
${updateFields}${revisionView}${protection}\
</w:settings>`);
}

interface ZipEntry {
  path: string;
  data: string | Buffer;
}

interface PreparedZipEntry {
  name: Buffer;
  data: Buffer;
  crc: number;
  offset: number;
}

function zipStore(entries: ZipEntry[]): Buffer {
  const prepared: PreparedZipEntry[] = [];
  const locals: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const name = Buffer.from(entry.path, "utf8");
    const data = typeof entry.data === "string" ? Buffer.from(entry.data, "utf8") : entry.data;
    const crc = crc32(data);
    const local = localHeader(name, data, crc);
    prepared.push({ name, data, crc, offset });
    locals.push(local, data);
    offset += local.length + data.length;
  }
  const central: Buffer[] = [];
  for (const entry of prepared) central.push(centralHeader(entry));
  const centralDir = Buffer.concat(central);
  const end = endRecord(prepared.length, centralDir.length, offset);
  return Buffer.concat([...locals, centralDir, end]);
}

function localHeader(name: Buffer, data: Buffer, crc: number): Buffer {
  const header = Buffer.alloc(30);
  header.writeUInt32LE(0x04034b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(0x0800, 6);
  header.writeUInt16LE(0, 8);
  header.writeUInt16LE(0, 10);
  header.writeUInt16LE(33, 12);
  header.writeUInt32LE(crc, 14);
  header.writeUInt32LE(data.length, 18);
  header.writeUInt32LE(data.length, 22);
  header.writeUInt16LE(name.length, 26);
  header.writeUInt16LE(0, 28);
  return Buffer.concat([header, name]);
}

function centralHeader(entry: PreparedZipEntry): Buffer {
  const header = Buffer.alloc(46);
  header.writeUInt32LE(0x02014b50, 0);
  header.writeUInt16LE(20, 4);
  header.writeUInt16LE(20, 6);
  header.writeUInt16LE(0x0800, 8);
  header.writeUInt16LE(0, 10);
  header.writeUInt16LE(0, 12);
  header.writeUInt16LE(33, 14);
  header.writeUInt32LE(entry.crc, 16);
  header.writeUInt32LE(entry.data.length, 20);
  header.writeUInt32LE(entry.data.length, 24);
  header.writeUInt16LE(entry.name.length, 28);
  header.writeUInt16LE(0, 30);
  header.writeUInt16LE(0, 32);
  header.writeUInt16LE(0, 34);
  header.writeUInt16LE(0, 36);
  header.writeUInt32LE(0, 38);
  header.writeUInt32LE(entry.offset, 42);
  return Buffer.concat([header, entry.name]);
}

function endRecord(entryCount: number, centralSize: number, centralOffset: number): Buffer {
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(0, 4);
  end.writeUInt16LE(0, 6);
  end.writeUInt16LE(entryCount, 8);
  end.writeUInt16LE(entryCount, 10);
  end.writeUInt32LE(centralSize, 12);
  end.writeUInt32LE(centralOffset, 16);
  end.writeUInt16LE(0, 20);
  return end;
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
