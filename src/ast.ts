/**
 * Noma AST — single source of truth.
 *
 * Renderers and the validator must import types from this file. Adding a new
 * node variant requires extending the `Node` union and updating every
 * renderer's switch (the compiler will tell you where).
 */

export type AttrValue = string | number | boolean;
export type Attrs = Record<string, AttrValue>;

export interface Position {
  line: number;
  column: number;
}

interface NodeBase {
  /** Stable, user-facing identifier when set. Auto-generated for headings. */
  id?: string;
  /**
   * Additional IDs that resolve to this node. Populated by:
   *   • frontmatter `aliases:` list (attaches to chapter root section)
   *   • chapter filename slug in book mode
   *   • path-scoped heading ID in book mode (registers the bare slug as alias)
   */
  aliases?: string[];
  /** Source position of the node's first character. */
  pos?: Position;
  /**
   * 1-based last source line covered by this node (inclusive). Populated by
   * the parser; used by `patchSource` to splice ranges without re-rendering
   * the rest of the document.
   */
  endLine?: number;
}

export interface DocumentNode extends NodeBase {
  type: "document";
  meta: Record<string, unknown>;
  children: Node[];
}

export interface FrontmatterNode extends NodeBase {
  type: "frontmatter";
  /** Parsed YAML object (string keys → arbitrary values). */
  data: Record<string, unknown>;
  /** Raw frontmatter source text (between the --- fences, exclusive). */
  raw: string;
}

export interface SectionNode extends NodeBase {
  type: "section";
  level: number;
  title: string;
  children: Node[];
}

export interface ParagraphNode extends NodeBase {
  type: "paragraph";
  content: string;
}

export interface CodeNode extends NodeBase {
  type: "code";
  lang?: string;
  content: string;
}

export interface ListNode extends NodeBase {
  type: "list";
  ordered: boolean;
  items: ListItemNode[];
}

export interface ListItemNode extends NodeBase {
  type: "list_item";
  content: string;
}

export interface QuoteNode extends NodeBase {
  type: "quote";
  content: string;
}

export interface ThematicBreakNode extends NodeBase {
  type: "thematic_break";
}

export type TableAlign = "left" | "center" | "right" | null;

export interface TableNode extends NodeBase {
  type: "table";
  /** Header cells (one row). Inline markdown is preserved as plain strings. */
  header: string[];
  /** Per-column alignment from the separator row (`:---`, `:---:`, `---:`). */
  align: TableAlign[];
  /** Body rows, each with one entry per column. */
  rows: string[][];
}

/**
 * Generic block directive — covers every typed semantic block (claim, evidence,
 * grid, card, plot, dataset, agent_task, ...). Renderers dispatch on `name`.
 */
export interface DirectiveNode extends NodeBase {
  type: "directive";
  name: string;
  attrs: Attrs;
  /** Inline body text (when the block has no nested children). */
  body?: string;
  /** Nested directive children (grids, cards, etc.). */
  children: Node[];
}

export type Node =
  | DocumentNode
  | SectionNode
  | FrontmatterNode
  | ParagraphNode
  | CodeNode
  | ListNode
  | ListItemNode
  | QuoteNode
  | ThematicBreakNode
  | TableNode
  | DirectiveNode;

export type BlockNode = Exclude<Node, ListItemNode | FrontmatterNode>;

export interface Diagnostic {
  severity: "error" | "warning" | "info";
  code: string;
  message: string;
  pos?: Position;
  /** Last source line of the offending block, completing the span begun at pos. */
  endLine?: number;
  nodeId?: string;
}

export const isDirective = (n: Node): n is DirectiveNode => n.type === "directive";
export const isSection = (n: Node): n is SectionNode => n.type === "section";

export function* walk(node: Node): Generator<Node> {
  yield node;
  if (
    node.type === "document" ||
    node.type === "section" ||
    node.type === "directive"
  ) {
    for (const child of node.children) yield* walk(child);
  } else if (node.type === "list") {
    for (const item of node.items) yield* walk(item);
  }
}
