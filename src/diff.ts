import type { Attrs, AttrValue, DirectiveNode, DocumentNode } from "./ast.js";
import { isDirective, walk } from "./ast.js";

export interface DiffOptions {
  /**
   * Required timestamp written as `at=` on every emitted state_change. Format:
   * `YYYY-MM-DD` (or any ISO-8601 date string). Required so output is
   * deterministic — same inputs always produce the same bytes.
   */
  at: string;
  /**
   * Optional reason string applied to every emitted state_change. Surfaces in
   * the rendered narrative; agents typically set this to a commit message or
   * a refresh trigger description.
   */
  reason?: string;
}

/**
 * Compare two parsed documents and emit a flat list of synthesized
 * `::state_change` directives describing every scalar attribute drift on
 * blocks identified by `id` and present in both snapshots.
 *
 * Emits value changes plus attribute presence changes. Added attributes use
 * `from="(absent)"`; removed attributes use `to="(absent)"`.
 *
 * Out of scope: prose/heading changes, block adds/deletes, block renames,
 * ID-less directives, nested-children diffs.
 *
 * Throws if either document contains duplicate IDs (the validator already
 * flags this as an error; diff cannot reason about which copy to compare).
 */
export function diffDocs(
  before: DocumentNode,
  after: DocumentNode,
  options: DiffOptions,
): DirectiveNode[] {
  if (typeof options.at !== "string" || options.at.length === 0) {
    throw new Error("diffDocs: options.at is required (YYYY-MM-DD)");
  }
  const at = options.at;
  const beforeIdx = indexById(before);
  const afterIdx = indexById(after);
  const deltas: DirectiveNode[] = [];

  for (const [id, afterNode] of afterIdx) {
    const beforeNode = beforeIdx.get(id);
    if (!beforeNode) continue;
    for (const delta of diffAttrs(beforeNode.attrs, afterNode.attrs)) {
      deltas.push(makeStateChange(id, delta, at, options.reason));
    }
  }

  return deltas;
}

interface AttrDelta {
  attribute: string;
  from: AttrValue;
  to: AttrValue;
}

const ABSENT_ATTR_VALUE = "(absent)";

function diffAttrs(a: Attrs, b: Attrs): AttrDelta[] {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  keys.delete("id");
  const out: AttrDelta[] = [];
  for (const k of [...keys].sort()) {
    const av = a[k];
    const bv = b[k];
    if (av === undefined && bv === undefined) continue;
    if (av === undefined) {
      out.push({ attribute: k, from: ABSENT_ATTR_VALUE, to: bv! });
      continue;
    }
    if (bv === undefined) {
      out.push({ attribute: k, from: av, to: ABSENT_ATTR_VALUE });
      continue;
    }
    if (Object.is(av, bv)) continue;
    out.push({ attribute: k, from: av, to: bv });
  }
  return out;
}

function indexById(doc: DocumentNode): Map<string, DirectiveNode> {
  const map = new Map<string, DirectiveNode>();
  for (const node of walk(doc)) {
    if (!isDirective(node) || !node.id) continue;
    if (map.has(node.id)) {
      throw new Error(`diffDocs: duplicate id "${node.id}" — fix with \`noma check\` first`);
    }
    map.set(node.id, node);
  }
  return map;
}

function makeStateChange(
  blockId: string,
  delta: AttrDelta,
  at: string,
  reason: string | undefined,
): DirectiveNode {
  const attrs: Attrs = {
    block: blockId,
    attribute: delta.attribute,
    from: delta.from,
    to: delta.to,
    at,
  };
  if (reason) attrs.reason = reason;
  return {
    type: "directive",
    name: "state_change",
    attrs,
    children: [],
  };
}
