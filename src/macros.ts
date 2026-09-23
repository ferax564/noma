/**
 * Wiki macros: `::include`, `::excerpt`, `::children`, `::issue`, `::issues`,
 * `::page-properties`, and `::page-properties-report`.
 *
 * Macros that need data from outside the document (other pages, the page tree,
 * the issue tracker) are resolved through optional, synchronous resolver
 * callbacks passed in render options. Renderers stay pure: without resolvers
 * they emit a static placeholder, and the same AST always renders the same way
 * for the same resolver answers.
 */
import type { DirectiveNode, DocumentNode, ListNode, Node, ParagraphNode, TableNode } from "./ast.js";
import { walk } from "./ast.js";
import { inlineToPlain, splitPipeRow } from "./inline.js";

/** Maximum nesting of `::include` blocks (an include inside an included block counts as depth 2). */
export const MAX_INCLUDE_DEPTH = 3;

export const MACRO_DIRECTIVES: ReadonlySet<string> = new Set([
  "include",
  "excerpt",
  "children",
  "issue",
  "issues",
  "page-properties",
  "page-properties-report",
]);

export const ISSUE_STATUSES = ["backlog", "todo", "in_progress", "in_review", "done"] as const;
export type MacroIssueStatus = (typeof ISSUE_STATUSES)[number];

export const CHILDREN_SORTS = ["position", "title", "updated"] as const;
export type ChildrenSort = (typeof CHILDREN_SORTS)[number];

/** Why a macro could not be resolved. `cycle` and `depth` are produced by renderers, not resolvers. */
export type MacroUnavailableStatus = "missing" | "forbidden" | "unavailable" | "cycle" | "depth";

export interface MacroUnavailable {
  status: MacroUnavailableStatus;
  message?: string;
}

export interface IncludeRequest {
  /** Target page: a document ID or page title. Absent means the current page. */
  page?: string;
  /** Block ID (or alias) inside the target page. Absent means the whole page. */
  block?: string;
  /** Pull the target page's `::excerpt` instead of a block. */
  excerpt: boolean;
  /** Page that contains the `::include`, when known. */
  fromDocumentId?: string;
}

export interface IncludeResolved {
  status: "ok";
  documentId: string;
  title: string;
  blockId?: string;
  excerpt?: boolean;
  /** Content hash of the target page source at resolution time. */
  hash: string;
  /** Included nodes with IDs and source positions removed. */
  nodes: Node[];
  href?: string;
}

export type IncludeResolution = IncludeResolved | MacroUnavailable;

export interface ChildPageRef {
  id: string;
  title: string;
  href?: string;
  updatedAt?: string;
  summary?: string;
  children: ChildPageRef[];
}

export interface ChildrenRequest {
  documentId?: string;
  depth: number;
  sort: ChildrenSort;
}

export type ChildrenResolution = { status: "ok"; pages: ChildPageRef[] } | MacroUnavailable;

export interface MacroIssueCard {
  key: string;
  summary: string;
  status: string;
  type?: string;
  priority?: string;
  assigneeName?: string;
  href?: string;
}

export type IssueResolution = { status: "ok"; issue: MacroIssueCard } | MacroUnavailable;

export interface IssuesRequest {
  project: string;
  status?: MacroIssueStatus;
  limit: number;
}

export type IssuesResolution = { status: "ok"; project: string; issues: MacroIssueCard[] } | MacroUnavailable;

export interface PagePropertiesReportRequest {
  label: string;
  limit: number;
  fromDocumentId?: string;
}

export interface PagePropertiesRow {
  documentId: string;
  title: string;
  href?: string;
  properties: Array<[string, string]>;
}

export type PagePropertiesReportResolution = { status: "ok"; rows: PagePropertiesRow[] } | MacroUnavailable;

/**
 * Callbacks that supply data for wiki macros at render time. Every callback is
 * optional; an absent callback renders the macro as an unresolved placeholder.
 */
export interface MacroResolvers {
  /** ID of the page being rendered. Seeds the include cycle guard and `::children`. */
  documentId?: string;
  resolveInclude?: (request: IncludeRequest) => IncludeResolution;
  resolveChildren?: (request: ChildrenRequest) => ChildrenResolution;
  resolveIssue?: (key: string) => IssueResolution;
  resolveIssues?: (request: IssuesRequest) => IssuesResolution;
  resolvePagePropertiesReport?: (request: PagePropertiesReportRequest) => PagePropertiesReportResolution;
}

/** Include nesting state threaded through a render. */
export interface IncludeTrail {
  documentId?: string;
  stack: string[];
}

export function initialIncludeTrail(documentId: string | undefined): IncludeTrail {
  return { ...(documentId ? { documentId } : {}), stack: documentId ? [includeKey(documentId)] : [] };
}

export function includeKey(documentId: string, blockId?: string, excerpt?: boolean): string {
  return `${documentId}#${excerpt ? ":excerpt" : blockId ?? ""}`;
}

export type IncludeStep =
  | { status: "ok"; resolved: IncludeResolved; trail: IncludeTrail }
  | MacroUnavailable
  | { status: "unresolved"; request: IncludeRequest };

/**
 * Resolve one `::include` against the trail, enforcing the depth limit and
 * cycle guard. An include without `page=` inside the document being rendered
 * resolves from `rootDoc` itself, so same-page transclusion needs no resolver.
 */
export function resolveIncludeStep(node: DirectiveNode, resolvers: MacroResolvers, trail: IncludeTrail, rootDoc?: DocumentNode): IncludeStep {
  const request = includeRequest(node, trail.documentId);
  const samePage = !request.page && rootDoc !== undefined && trail.documentId === resolvers.documentId;
  if (!resolvers.resolveInclude && !samePage) return { status: "unresolved", request };
  const depth = Math.max(0, trail.stack.length - (resolvers.documentId ? 1 : 0));
  if (depth >= MAX_INCLUDE_DEPTH) return { status: "depth", message: `Includes nest at most ${MAX_INCLUDE_DEPTH} levels deep.` };
  if (!request.page && !request.block && !request.excerpt) return { status: "missing", message: "::include needs page=, block=, or excerpt." };
  const resolution = samePage ? samePageInclude(rootDoc, request, resolvers.documentId) : resolvers.resolveInclude!(request);
  if (resolution.status !== "ok") return resolution;
  const key = includeKey(resolution.documentId, resolution.blockId, resolution.excerpt);
  if (trail.stack.includes(key)) {
    return { status: "cycle", message: `"${resolution.title}" is already being included.` };
  }
  const nextDocumentId = samePage ? resolvers.documentId : resolution.documentId;
  return { status: "ok", resolved: resolution, trail: { ...(nextDocumentId ? { documentId: nextDocumentId } : {}), stack: [...trail.stack, key] } };
}

function samePageInclude(doc: DocumentNode, request: IncludeRequest, documentId: string | undefined): IncludeResolution {
  const nodes = extractIncludeNodes(doc, { block: request.block, excerpt: request.excerpt });
  if (!nodes) return { status: "missing", message: request.excerpt ? "This page has no ::excerpt." : `This page has no block "${request.block ?? ""}".` };
  return {
    status: "ok",
    documentId: documentId ?? "",
    title: "this page",
    ...(request.block ? { blockId: request.block } : {}),
    ...(request.excerpt ? { excerpt: true } : {}),
    hash: "same-page",
    nodes,
    ...(request.block ? { href: `#${request.block}` } : {}),
  };
}

export function includeRequest(node: DirectiveNode, fromDocumentId?: string): IncludeRequest {
  const page = attrString(node, "page");
  const block = attrString(node, "block");
  return {
    ...(page ? { page } : {}),
    ...(block ? { block } : {}),
    excerpt: node.attrs.excerpt === true || node.attrs.excerpt === "true",
    ...(fromDocumentId ? { fromDocumentId } : {}),
  };
}

export function childrenRequest(node: DirectiveNode, documentId?: string): ChildrenRequest {
  const depth = Number(node.attrs.depth ?? 1);
  const sort = String(node.attrs.sort ?? "position");
  return {
    ...(documentId ? { documentId } : {}),
    depth: Number.isInteger(depth) ? Math.max(1, Math.min(5, depth)) : 1,
    sort: (CHILDREN_SORTS as readonly string[]).includes(sort) ? (sort as ChildrenSort) : "position",
  };
}

const ISSUE_KEY_RE = /^[A-Z][A-Z0-9_]{1,19}-\d{1,9}$/;
const PROJECT_KEY_RE = /^[A-Z][A-Z0-9_]{1,19}$/;

export function issueKeyFromNode(node: DirectiveNode): string | undefined {
  const key = attrString(node, "key")?.toUpperCase();
  return key && ISSUE_KEY_RE.test(key) ? key : undefined;
}

export function issuesRequest(node: DirectiveNode): IssuesRequest | undefined {
  const project = attrString(node, "project")?.toUpperCase();
  if (!project || !PROJECT_KEY_RE.test(project)) return undefined;
  const status = attrString(node, "status");
  const limit = Number(node.attrs.limit ?? 20);
  return {
    project,
    ...(status && (ISSUE_STATUSES as readonly string[]).includes(status) ? { status: status as MacroIssueStatus } : {}),
    limit: Number.isInteger(limit) ? Math.max(1, Math.min(50, limit)) : 20,
  };
}

export function pagePropertiesReportRequest(node: DirectiveNode, fromDocumentId?: string): PagePropertiesReportRequest | undefined {
  const label = attrString(node, "label")?.trim().toLowerCase().replace(/\s+/g, "-");
  if (!label) return undefined;
  const limit = Number(node.attrs.limit ?? 50);
  return {
    label,
    limit: Number.isInteger(limit) ? Math.max(1, Math.min(200, limit)) : 50,
    ...(fromDocumentId ? { fromDocumentId } : {}),
  };
}

/** Key/value pairs of a `::page-properties` block, from pipe rows or `Key: value` lines. */
export function pagePropertiesEntries(node: DirectiveNode): Array<[string, string]> {
  const entries: Array<[string, string]> = [];
  const push = (key: string, value: string): void => {
    const cleanKey = key.trim();
    if (cleanKey && entries.length < 100) entries.push([cleanKey, value.trim()]);
  };
  const tables = node.children.filter((child): child is TableNode => child.type === "table");
  if (tables.length > 0) {
    for (const table of tables) {
      if (table.header.length >= 2) push(table.header[0] ?? "", table.header[1] ?? "");
      for (const row of table.rows) push(row[0] ?? "", row[1] ?? "");
    }
    return entries;
  }
  for (const raw of (node.body ?? "").split("\n")) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith("|")) {
      if (/^\|?\s*:?-{3,}/.test(line)) continue;
      const cells = splitPipeRow(line);
      if (cells.length >= 2) push(cells[0] ?? "", cells[1] ?? "");
      continue;
    }
    const colon = line.indexOf(":");
    if (colon > 0) push(line.slice(0, colon), line.slice(colon + 1));
  }
  return entries;
}

/** Page properties of a whole document: the first `::page-properties` block wins per key. */
export function documentPageProperties(doc: DocumentNode): Array<[string, string]> {
  const seen = new Set<string>();
  const out: Array<[string, string]> = [];
  for (const node of walk(doc)) {
    if (node.type !== "directive" || node.name !== "page-properties") continue;
    for (const [key, value] of pagePropertiesEntries(node)) {
      const normalized = key.toLowerCase();
      if (seen.has(normalized)) continue;
      seen.add(normalized);
      out.push([key, value]);
    }
  }
  return out;
}

export function findExcerpt(doc: DocumentNode): DirectiveNode | undefined {
  for (const node of walk(doc)) {
    if (node.type === "directive" && node.name === "excerpt") return node;
  }
  return undefined;
}

/** Plain-text page summary from the page's `::excerpt`, trimmed to `max` characters. */
export function excerptPlainText(doc: DocumentNode, max = 280): string | undefined {
  const excerpt = findExcerpt(doc);
  if (!excerpt) return undefined;
  const parts: string[] = [];
  if (excerpt.children.length === 0 && excerpt.body) parts.push(inlineToPlain(excerpt.body));
  for (const node of excerpt.children.flatMap((child) => [...walk(child)])) {
    if (node.type === "paragraph" || node.type === "quote" || node.type === "list_item") parts.push(inlineToPlain(node.content));
    else if (node.type === "section") parts.push(inlineToPlain(node.title));
  }
  const text = parts.join(" ").replace(/\s+/g, " ").trim();
  if (!text) return undefined;
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

/**
 * Nodes an include of `doc` should show: the excerpt, one block (by ID or
 * alias), or the whole page. Returns `undefined` when the target is absent.
 * The result is a deep copy with IDs, aliases, and source positions removed
 * so included content never collides with the host page's IDs or edit map.
 */
export function extractIncludeNodes(doc: DocumentNode, target: { block?: string; excerpt?: boolean }): Node[] | undefined {
  let nodes: Node[] | undefined;
  if (target.excerpt) {
    const excerpt = findExcerpt(doc);
    if (!excerpt) return undefined;
    nodes = excerpt.children.length > 0 ? excerpt.children : excerpt.body ? [paragraphNode(excerpt.body)] : [];
  } else if (target.block) {
    for (const node of walk(doc)) {
      if (node.type === "document") continue;
      if (node.id === target.block || node.aliases?.includes(target.block)) {
        nodes = [node];
        break;
      }
    }
  } else {
    nodes = doc.children.filter((child) => child.type !== "frontmatter");
  }
  return nodes?.map(stripNodeIdentity);
}

export function stripNodeIdentity(node: Node): Node {
  return JSON.parse(
    JSON.stringify(node, (key, value: unknown) => {
      if (key === "id" || key === "aliases" || key === "pos" || key === "endLine") return undefined;
      if (key === "columnIds" || key === "headerIds" || key === "rowIds" || key === "cellIds") return undefined;
      return value;
    }),
  ) as Node;
}

export function unavailableMessage(status: MacroUnavailableStatus | "unresolved", what: string, detail?: string): string {
  const base = (() => {
    switch (status) {
      case "missing":
        return `${what} not found`;
      case "forbidden":
        return `You do not have access to ${what}`;
      case "cycle":
        return `${what} skipped: include cycle`;
      case "depth":
        return `${what} skipped: includes are nested too deeply`;
      case "unresolved":
        return `${what} is resolved when this page is viewed in Noma Cloud`;
      default:
        return `${what} is unavailable`;
    }
  })();
  return detail ? `${base}. ${detail}` : `${base}.`;
}

export function includeLabel(request: IncludeRequest): string {
  const page = request.page ? `"${request.page}"` : "this page";
  if (request.excerpt) return `Excerpt of ${page}`;
  return request.block ? `Block "${request.block}" of ${page}` : `Page ${page}`;
}

/**
 * Replace resolvable macros with plain AST nodes (paragraphs, lists, tables,
 * included content). Used for exports whose renderers have no macro support of
 * their own (Markdown, DOCX). The input is not mutated.
 */
export function expandMacros(doc: DocumentNode, resolvers: MacroResolvers): DocumentNode {
  const trail = initialIncludeTrail(resolvers.documentId);
  return { ...doc, children: expandNodes(doc.children, resolvers, trail, doc) };
}

function expandNodes(nodes: Node[], resolvers: MacroResolvers, trail: IncludeTrail, rootDoc: DocumentNode): Node[] {
  return nodes.flatMap((node) => expandNode(node, resolvers, trail, rootDoc));
}

function expandNode(node: Node, resolvers: MacroResolvers, trail: IncludeTrail, rootDoc: DocumentNode): Node[] {
  if (node.type === "section") return [{ ...node, children: expandNodes(node.children, resolvers, trail, rootDoc) }];
  if (node.type !== "directive") return [node];
  switch (node.name) {
    case "include": {
      const step = resolveIncludeStep(node, resolvers, trail, rootDoc);
      if (step.status === "ok") return expandNodes(step.resolved.nodes, resolvers, step.trail, rootDoc);
      if (step.status === "unresolved") return [quoteNode(unavailableMessage("unresolved", includeLabel(step.request)))];
      return [quoteNode(unavailableMessage(step.status, includeLabel(includeRequest(node, trail.documentId)), step.message))];
    }
    case "excerpt":
      return expandNodes(node.children.length > 0 ? node.children : node.body ? [paragraphNode(node.body)] : [], resolvers, trail, rootDoc);
    case "children": {
      const resolution = resolvers.resolveChildren?.(childrenRequest(node, trail.documentId));
      if (!resolution) return [quoteNode(unavailableMessage("unresolved", "The child page list"))];
      if (resolution.status !== "ok") return [quoteNode(unavailableMessage(resolution.status, "The child page list", resolution.message))];
      const items = flattenChildPages(resolution.pages, 0);
      return items.length > 0 ? [listNode(items)] : [paragraphNode("No child pages.")];
    }
    case "issue": {
      const key = issueKeyFromNode(node);
      const resolution = key ? resolvers.resolveIssue?.(key) : { status: "missing" as const, message: "Set key=\"PROJ-1\"." };
      if (!resolution) return [quoteNode(unavailableMessage("unresolved", `Issue ${key ?? ""}`.trim()))];
      if (resolution.status !== "ok") return [quoteNode(unavailableMessage(resolution.status, `Issue ${key ?? ""}`.trim(), resolution.message))];
      return [paragraphNode(issueLine(resolution.issue))];
    }
    case "issues": {
      const request = issuesRequest(node);
      const resolution = request ? resolvers.resolveIssues?.(request) : { status: "missing" as const, message: "Set project=\"PROJ\"." };
      if (!resolution) return [quoteNode(unavailableMessage("unresolved", `Issues in ${request?.project ?? "project"}`))];
      if (resolution.status !== "ok") return [quoteNode(unavailableMessage(resolution.status, `Issues in ${request?.project ?? "project"}`, resolution.message))];
      if (resolution.issues.length === 0) return [paragraphNode(`No matching issues in ${resolution.project}.`)];
      return [
        tableNode(
          ["Key", "Summary", "Status", "Assignee"],
          resolution.issues.map((issue) => [issue.key, issue.summary, issue.status.replace(/_/g, " "), issue.assigneeName ?? "Unassigned"]),
        ),
      ];
    }
    case "page-properties": {
      const entries = pagePropertiesEntries(node);
      return entries.length > 0 ? [tableNode(["Property", "Value"], entries.map(([key, value]) => [key, value]))] : [];
    }
    case "page-properties-report": {
      const request = pagePropertiesReportRequest(node, trail.documentId);
      const resolution = request ? resolvers.resolvePagePropertiesReport?.(request) : { status: "missing" as const, message: "Set label=\"...\"." };
      if (!resolution) return [quoteNode(unavailableMessage("unresolved", "The page properties report"))];
      if (resolution.status !== "ok") return [quoteNode(unavailableMessage(resolution.status, "The page properties report", resolution.message))];
      const columns = propertiesReportColumns(resolution.rows);
      if (resolution.rows.length === 0) return [paragraphNode(`No pages labeled "${request?.label ?? ""}".`)];
      return [tableNode(["Page", ...columns], resolution.rows.map((row) => [row.title, ...columns.map((column) => propertyValue(row, column))]))];
    }
    default:
      return [{ ...node, children: expandNodes(node.children, resolvers, trail, rootDoc) }];
  }
}

export function flattenChildPages(pages: ChildPageRef[], depth: number): string[] {
  return pages.flatMap((page) => [
    `${depth > 0 ? `${"— ".repeat(depth)}` : ""}${page.title}${page.summary ? ` — ${page.summary}` : ""}`,
    ...flattenChildPages(page.children, depth + 1),
  ]);
}

export function issueLine(issue: MacroIssueCard): string {
  const parts = [`${issue.key}: ${issue.summary}`, issue.status.replace(/_/g, " ")];
  if (issue.assigneeName) parts.push(issue.assigneeName);
  return parts.join(" · ");
}

export function propertiesReportColumns(rows: PagePropertiesRow[]): string[] {
  const columns: string[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    for (const [key] of row.properties) {
      const normalized = key.toLowerCase();
      if (seen.has(normalized) || columns.length >= 12) continue;
      seen.add(normalized);
      columns.push(key);
    }
  }
  return columns;
}

export function propertyValue(row: PagePropertiesRow, column: string): string {
  const normalized = column.toLowerCase();
  return row.properties.find(([key]) => key.toLowerCase() === normalized)?.[1] ?? "";
}

function attrString(node: DirectiveNode, key: string): string | undefined {
  const value = node.attrs[key];
  if (typeof value === "string") return value.trim() || undefined;
  if (typeof value === "number") return String(value);
  return undefined;
}

function paragraphNode(content: string): ParagraphNode {
  return { type: "paragraph", content };
}

function quoteNode(content: string): Node {
  return { type: "quote", content };
}

function listNode(items: string[]): ListNode {
  return { type: "list", ordered: false, items: items.map((content) => ({ type: "list_item", content })) };
}

function tableNode(header: string[], rows: string[][]): TableNode {
  const clean = (cell: string): string => cell.replace(/\s*\n\s*/g, " ").replace(/\|/g, "\\|");
  return { type: "table", header: header.map(clean), align: header.map(() => null), rows: rows.map((row) => row.map(clean)) };
}
