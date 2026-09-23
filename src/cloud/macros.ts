/**
 * Cloud-side resolvers for wiki macros (`::include`, `::children`, `::issue`,
 * `::issues`, `::page-properties-report`). Every lookup is checked against the
 * viewer's access; a page the viewer cannot open is reported as `forbidden`,
 * and trashed pages as `missing`. Work per render is bounded.
 */
import type { DocumentNode } from "../ast.js";
import type { CloudDocumentRecord, CloudIssue, CloudSiteRecord } from "../cloud-db.js";
import {
  type ChildPageRef,
  type ChildrenRequest,
  type ChildrenResolution,
  documentPageProperties,
  excerptPlainText,
  extractIncludeNodes,
  type IncludeRequest,
  type IncludeResolution,
  type IssueResolution,
  type IssuesRequest,
  type IssuesResolution,
  type MacroIssueCard,
  type MacroResolvers,
  type PagePropertiesReportRequest,
  type PagePropertiesReportResolution,
} from "../macros.js";
import { parse } from "../parser.js";
import { type CloudServerConfig, type Principal, requireProjectAccess, requireRecordAccess } from "./context.js";
import { HttpError } from "./http.js";

/** Upper bound on resolver calls per render, so a page cannot fan out into unbounded work. */
const MAX_MACRO_LOOKUPS = 200;
const MAX_CHILD_PAGES = 200;
const CLOUD_ID_RE = /^[A-Za-z0-9_-]{8,80}$/;

export type CloudMacroResolvers = Required<Omit<MacroResolvers, "documentId">> & Pick<MacroResolvers, "documentId">;

export interface CloudMacroOptions {
  /** Link for a page; defaults to the Cloud app URL. Return undefined to render without a link. */
  pageHref?: (documentId: string) => string | undefined;
}

export function cloudPageHref(documentId: string): string {
  return `/cloud.html?doc=${encodeURIComponent(documentId)}`;
}

/** Resolvers bound to one viewer and one host page. Create one per render. */
export function cloudMacroResolvers(
  config: CloudServerConfig,
  principal: Principal,
  documentId: string | undefined,
  options: CloudMacroOptions = {},
): CloudMacroResolvers {
  const hrefFor = options.pageHref ?? cloudPageHref;
  const parsed = new Map<string, DocumentNode>();
  let lookups = 0;
  const budget = (): boolean => ++lookups <= MAX_MACRO_LOOKUPS;
  const overBudget = { status: "unavailable" as const, message: `This page uses more than ${MAX_MACRO_LOOKUPS} macro lookups.` };

  const parseRecord = (record: CloudDocumentRecord): DocumentNode => {
    const cached = parsed.get(record.id);
    if (cached) return cached;
    const doc = parse(record.source, { filename: `${record.id}.noma` });
    parsed.set(record.id, doc);
    return doc;
  };
  const canView = (record: CloudDocumentRecord | CloudSiteRecord): boolean => {
    try {
      requireRecordAccess(config, record, principal, "viewer");
      return true;
    } catch {
      return false;
    }
  };
  const readLiveDocument = (id: string): CloudDocumentRecord | undefined => {
    if (!CLOUD_ID_RE.test(id) || config.store.isTrashed("document", id)) return undefined;
    return config.store.readDocument(id);
  };

  const findPage = (page: string, fromDocumentId: string | undefined): { record?: CloudDocumentRecord; forbidden: boolean } => {
    const byId = readLiveDocument(page);
    if (byId) return canView(byId) ? { record: byId, forbidden: false } : { forbidden: true };
    const candidates = config.store
      .documentIdsByTitle(page, 20)
      .map((id) => config.store.readDocument(id))
      .filter((record): record is CloudDocumentRecord => Boolean(record))
      .filter(canView);
    if (candidates.length === 0) return { forbidden: false };
    const hostSites = new Set(fromDocumentId ? config.store.siteIdsForDocument(fromDocumentId) : []);
    const sameSpace = candidates.find((record) => config.store.siteIdsForDocument(record.id).some((siteId) => hostSites.has(siteId)));
    return { record: sameSpace ?? candidates[0], forbidden: false };
  };

  const resolveInclude = (request: IncludeRequest): IncludeResolution => {
    if (!budget()) return overBudget;
    const fromId = request.fromDocumentId ?? documentId;
    let record: CloudDocumentRecord | undefined;
    if (request.page) {
      const found = findPage(request.page, fromId);
      if (found.forbidden) return { status: "forbidden" };
      record = found.record;
    } else if (fromId) {
      record = readLiveDocument(fromId);
      if (record && !canView(record)) return { status: "forbidden" };
    }
    if (!record) return { status: "missing" };
    const nodes = extractIncludeNodes(parseRecord(record), { block: request.block, excerpt: request.excerpt });
    if (!nodes) return { status: "missing", message: `"${record.title}" has no ${request.excerpt ? "::excerpt" : `block "${request.block ?? ""}"`}.` };
    const href = hrefFor(record.id);
    return {
      status: "ok",
      documentId: record.id,
      title: record.title,
      ...(request.block ? { blockId: request.block } : {}),
      ...(request.excerpt ? { excerpt: true } : {}),
      hash: record.hash,
      nodes,
      ...(href ? { href } : {}),
    };
  };

  const resolveChildren = (request: ChildrenRequest): ChildrenResolution => {
    if (!budget()) return overBudget;
    const parentId = request.documentId ?? documentId;
    if (!parentId) return { status: "unavailable", message: "Save the page into a space to list its children." };
    const site = config.store
      .siteIdsForDocument(parentId)
      .filter((siteId) => !config.store.isTrashed("site", siteId))
      .map((siteId) => config.store.readSite(siteId))
      .find((candidate): candidate is CloudSiteRecord => Boolean(candidate));
    if (!site) return { status: "ok", pages: [] };
    const parents = site.pageParents ?? {};
    const order = new Map(site.documentIds.map((id, index) => [id, index]));
    let emitted = 0;
    const collect = (id: string, depth: number): ChildPageRef[] => {
      const children: Array<{ ref: ChildPageRef; position: number; updatedAt: string }> = [];
      for (const childId of site.documentIds) {
        if (parents[childId] !== id || emitted >= MAX_CHILD_PAGES) continue;
        const record = readLiveDocument(childId);
        if (!record || !canView(record)) continue;
        emitted += 1;
        const summary = excerptPlainText(parseRecord(record), 200);
        const href = hrefFor(record.id);
        children.push({
          ref: {
            id: record.id,
            title: record.title,
            ...(href ? { href } : {}),
            updatedAt: record.updatedAt,
            ...(summary ? { summary } : {}),
            children: depth > 1 ? collect(record.id, depth - 1) : [],
          },
          position: order.get(childId) ?? 0,
          updatedAt: record.updatedAt,
        });
      }
      if (request.sort === "title") children.sort((a, b) => a.ref.title.localeCompare(b.ref.title) || a.position - b.position);
      else if (request.sort === "updated") children.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt) || a.position - b.position);
      else children.sort((a, b) => a.position - b.position);
      return children.map((child) => child.ref);
    };
    return { status: "ok", pages: collect(parentId, request.depth) };
  };

  const issueCard = (issue: CloudIssue): MacroIssueCard => ({
    key: issue.key,
    summary: issue.summary,
    status: issue.status,
    type: issue.type,
    priority: issue.priority,
    ...(issue.assigneeName ? { assigneeName: issue.assigneeName } : {}),
  });
  const projectVisible = (siteProject: Parameters<typeof requireProjectAccess>[1]): "ok" | "missing" | "forbidden" => {
    try {
      requireProjectAccess(config, siteProject, principal, "viewer");
      return "ok";
    } catch (error) {
      return error instanceof HttpError && (error.status === 404 || error.status === 410) ? "missing" : "forbidden";
    }
  };

  const resolveIssue = (key: string): IssueResolution => {
    if (!budget()) return overBudget;
    const issue = config.store.readIssue(key);
    const project = issue ? config.store.readProject(issue.projectId) : undefined;
    if (!issue || !project) return { status: "missing" };
    const visible = projectVisible(project);
    return visible === "ok" ? { status: "ok", issue: issueCard(issue) } : { status: visible };
  };

  const resolveIssues = (request: IssuesRequest): IssuesResolution => {
    if (!budget()) return overBudget;
    const project = config.store.readProject(request.project);
    if (!project) return { status: "missing", message: `No project ${request.project}.` };
    const visible = projectVisible(project);
    if (visible !== "ok") return { status: visible };
    const issues = config.store.listIssues(project.id, { limit: request.limit, ...(request.status ? { status: request.status } : {}) });
    return { status: "ok", project: project.key, issues: issues.map(issueCard) };
  };

  const resolvePagePropertiesReport = (request: PagePropertiesReportRequest): PagePropertiesReportResolution => {
    if (!budget()) return overBudget;
    if (!principal.user) return { status: "forbidden", message: "Sign in to see labeled pages." };
    const fromId = request.fromDocumentId ?? documentId;
    const siteId = fromId ? config.store.siteIdsForDocument(fromId)[0] : undefined;
    const labeled = config.store.listDocumentsByLabel(principal.user, request.label, siteId, request.limit);
    const rows = labeled
      .map((item) => readLiveDocument(item.documentId))
      .filter((record): record is CloudDocumentRecord => Boolean(record))
      .map((record) => {
        const href = hrefFor(record.id);
        return {
          documentId: record.id,
          title: record.title,
          ...(href ? { href } : {}),
          properties: documentPageProperties(parseRecord(record)),
        };
      });
    return { status: "ok", rows };
  };

  return {
    ...(documentId ? { documentId } : {}),
    resolveInclude,
    resolveChildren,
    resolveIssue,
    resolveIssues,
    resolvePagePropertiesReport,
  };
}

/** Plain-text page summary from its `::excerpt`, for tree and search listings. */
export function documentSummary(record: CloudDocumentRecord): string | undefined {
  return excerptPlainText(parse(record.source, { filename: `${record.id}.noma` }), 280);
}
