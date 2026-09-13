import type { DocumentNode, ListItemNode, Node, TableNode } from "./ast.js";
import { walk } from "./ast.js";

/** Whole-line stable ID marker: `{#block-id}` immediately before a block. */
export const STABLE_ID_LINE_RE =
  /^\{#([A-Za-z][\w:./-]*)((?:\s+[a-zA-Z_][\w-]*="[^"]*")*)\}\s*$/;

/** Cell/list-item prefix: `{#cell-id} remaining text`. */
export const INLINE_STABLE_ID_RE = /^\{#([A-Za-z][\w:./-]*)\}\s*/;

export const IDENTITY_FORMAT_VERSION = 1;

export interface IdentityFactory {
  next(kind: "block" | "col" | "row" | "cell" | "item"): string;
}

export interface AssignIdentityOptions {
  factory?: IdentityFactory;
}

export interface ParsedCellIdentity {
  id?: string;
  content: string;
}

export interface TableAddress {
  tableId: string;
  columnId?: string;
  rowId?: string;
  cellId?: string;
}

export interface LocatedTableCell {
  table: TableNode;
  rowIndex: number;
  columnIndex: number;
  rowId?: string;
  columnId?: string;
  cellId?: string;
  content: string;
}

let identitySeq = 0;

export function resetIdentitySequence(value = 0): void {
  identitySeq = value;
}

export function defaultIdentityFactory(): IdentityFactory {
  return {
    next(kind) {
      identitySeq += 1;
      return `${kind}_${identitySeq.toString(36)}`;
    },
  };
}

export function parseInlineStableId(raw: string): ParsedCellIdentity {
  const match = INLINE_STABLE_ID_RE.exec(raw);
  if (!match) return { content: raw };
  return { id: match[1], content: raw.slice(match[0].length) };
}

export function formatInlineStableId(id: string | undefined, content: string): string {
  return id ? `{#${id}} ${content}` : content;
}

export function parseListItemIdentity(raw: string): Pick<ListItemNode, "id" | "content"> {
  const parsed = parseInlineStableId(raw);
  return parsed.id ? { id: parsed.id, content: parsed.content } : { content: raw };
}

export function collectIdentityStrings(node: Node): string[] {
  const ids: string[] = [];
  if (node.id) ids.push(node.id);
  if (node.aliases) ids.push(...node.aliases);
  if (node.type === "table") ids.push(...collectTableIdentityStrings(node));
  if (node.type === "list") {
    for (const item of node.items) {
      if (item.id) ids.push(item.id);
    }
  }
  return ids;
}

export function collectTableIdentityStrings(table: TableNode): string[] {
  const ids: string[] = [];
  for (const id of table.columnIds ?? []) if (id) ids.push(id);
  for (const id of table.headerIds ?? []) if (id) ids.push(id);
  for (const id of table.rowIds ?? []) if (id) ids.push(id);
  for (const row of table.cellIds ?? []) {
    for (const id of row) if (id) ids.push(id);
  }
  return ids;
}

/**
 * Assign persistent IDs to editable blocks, list items, and table
 * rows/columns/cells that do not already have one. Existing IDs are never
 * rewritten. IDs are not derived from text, position, or title.
 */
export function assignPersistentIdentities(
  doc: DocumentNode,
  options: AssignIdentityOptions = {},
): DocumentNode {
  const factory = options.factory ?? defaultIdentityFactory();
  const used = new Set<string>();
  for (const node of walk(doc)) {
    for (const id of collectIdentityStrings(node)) used.add(id);
  }

  const take = (kind: "block" | "col" | "row" | "cell" | "item"): string => {
    let id = factory.next(kind);
    while (used.has(id)) id = factory.next(kind);
    used.add(id);
    return id;
  };

  const visit = (node: Node): void => {
    if (!node.id && node.type !== "document" && node.type !== "frontmatter" && node.type !== "thematic_break") {
      if (node.type === "list_item") {
        node.id = take("item");
      } else if (node.type !== "section") {
        node.id = take("block");
      }
    }
    if (node.type === "table") assignTableIdentities(node, take);
    if (node.type === "list") {
      for (const item of node.items) visit(item);
    }
    if (node.type === "document" || node.type === "section" || node.type === "directive") {
      for (const child of node.children) visit(child);
    }
  };

  visit(doc);
  doc.meta = { ...doc.meta, identityFormat: IDENTITY_FORMAT_VERSION };
  return doc;
}

function assignTableIdentities(
  table: TableNode,
  take: (kind: "block" | "col" | "row" | "cell" | "item") => string,
): void {
  const cols = table.header.length;
  const columnIds = [...(table.columnIds ?? [])];
  const headerIds = [...(table.headerIds ?? [])];
  while (columnIds.length < cols) columnIds.push(take("col"));
  for (let c = 0; c < cols; c++) if (!columnIds[c]) columnIds[c] = take("col");
  while (headerIds.length < cols) headerIds.push(take("cell"));
  for (let c = 0; c < cols; c++) if (!headerIds[c]) headerIds[c] = take("cell");
  table.columnIds = columnIds.slice(0, cols);
  table.headerIds = headerIds.slice(0, cols);

  const rowIds = [...(table.rowIds ?? [])];
  const cellIds = (table.cellIds ?? []).map((row) => [...row]);
  while (rowIds.length < table.rows.length) rowIds.push(take("row"));
  for (let r = 0; r < table.rows.length; r++) if (!rowIds[r]) rowIds[r] = take("row");
  while (cellIds.length < table.rows.length) cellIds.push([]);
  for (let r = 0; r < table.rows.length; r++) {
    const row = table.rows[r] ?? [];
    const ids = cellIds[r] ?? [];
    while (ids.length < row.length) ids.push(take("cell"));
    for (let c = 0; c < row.length; c++) if (!ids[c]) ids[c] = take("cell");
    cellIds[r] = ids.slice(0, row.length);
  }
  table.rowIds = rowIds.slice(0, table.rows.length);
  table.cellIds = cellIds.slice(0, table.rows.length);
}

export function locateTableCell(table: TableNode, address: Omit<TableAddress, "tableId">): LocatedTableCell {
  if (address.cellId) {
    for (let r = 0; r < (table.cellIds ?? []).length; r++) {
      const row = table.cellIds?.[r] ?? [];
      const c = row.indexOf(address.cellId);
      if (c >= 0) {
        return {
          table,
          rowIndex: r,
          columnIndex: c,
          rowId: table.rowIds?.[r],
          columnId: table.columnIds?.[c],
          cellId: address.cellId,
          content: table.rows[r]?.[c] ?? "",
        };
      }
    }
    throw new Error(`table cell "${address.cellId}" not found`);
  }
  let rowIndex: number | undefined;
  let columnIndex: number | undefined;
  if (address.rowId) {
    const idx = table.rowIds?.indexOf(address.rowId) ?? -1;
    if (idx < 0) throw new Error(`table row "${address.rowId}" not found`);
    rowIndex = idx;
  }
  if (address.columnId) {
    const idx = table.columnIds?.indexOf(address.columnId) ?? -1;
    if (idx < 0) throw new Error(`table column "${address.columnId}" not found`);
    columnIndex = idx;
  }
  if (rowIndex === undefined || columnIndex === undefined) {
    throw new Error("table cell address requires cellId or both rowId and columnId");
  }
  return {
    table,
    rowIndex,
    columnIndex,
    rowId: table.rowIds?.[rowIndex],
    columnId: table.columnIds?.[columnIndex],
    cellId: table.cellIds?.[rowIndex]?.[columnIndex],
    content: table.rows[rowIndex]?.[columnIndex] ?? "",
  };
}

export function updateTableCellById(table: TableNode, address: Omit<TableAddress, "tableId">, value: string): LocatedTableCell {
  const located = locateTableCell(table, address);
  const row = table.rows[located.rowIndex];
  if (!row) throw new Error("table row missing");
  row[located.columnIndex] = value;
  return { ...located, content: value };
}

export function insertTableRowWithIdentities(
  table: TableNode,
  at: number,
  cells: string[],
  factory: IdentityFactory = defaultIdentityFactory(),
): string {
  const cols = table.header.length;
  const normalized = [...cells];
  while (normalized.length < cols) normalized.push("");
  if (normalized.length > cols) normalized.length = cols;
  const rowId = factory.next("row");
  const cellIds = normalized.map(() => factory.next("cell"));
  table.rows.splice(at, 0, normalized);
  const rowIds = [...(table.rowIds ?? [])];
  const allCellIds = [...(table.cellIds ?? [])];
  while (rowIds.length < at) rowIds.push(factory.next("row"));
  while (allCellIds.length < at) allCellIds.push([]);
  rowIds.splice(at, 0, rowId);
  allCellIds.splice(at, 0, cellIds);
  table.rowIds = rowIds;
  table.cellIds = allCellIds;
  return rowId;
}

export function remapIdentitiesOnDuplicate(
  doc: DocumentNode,
  factory: IdentityFactory = defaultIdentityFactory(),
): Map<string, string> {
  const remap = new Map<string, string>();
  const rewrite = (id: string | undefined, kind: "block" | "col" | "row" | "cell" | "item"): string | undefined => {
    if (!id) return id;
    const existing = remap.get(id);
    if (existing) return existing;
    const next = factory.next(kind);
    remap.set(id, next);
    return next;
  };
  for (const node of walk(doc)) {
    if (node.id) node.id = rewrite(node.id, node.type === "list_item" ? "item" : "block") ?? node.id;
    if (node.aliases) node.aliases = node.aliases.map((alias) => rewrite(alias, "block") ?? alias);
    if (node.type === "table") {
      node.columnIds = node.columnIds?.map((id) => rewrite(id, "col") ?? id);
      node.headerIds = node.headerIds?.map((id) => rewrite(id, "cell") ?? id);
      node.rowIds = node.rowIds?.map((id) => rewrite(id, "row") ?? id);
      node.cellIds = node.cellIds?.map((row) => row.map((id) => rewrite(id, "cell") ?? id));
    }
    if (node.type === "list") {
      for (const item of node.items) {
        if (item.id) item.id = rewrite(item.id, "item") ?? item.id;
      }
    }
  }
  return remap;
}

export function findNodeByAnyId(root: Node, id: string): Node | undefined {
  for (const node of walk(root)) {
    if (node.id === id || node.aliases?.includes(id)) return node;
    if (node.type === "list") {
      const item = node.items.find((entry) => entry.id === id);
      if (item) return item;
    }
    if (node.type === "table" && collectTableIdentityStrings(node).includes(id)) return node;
  }
  return undefined;
}
