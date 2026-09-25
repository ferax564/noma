/**
 * Component kits — reusable blocks built only from core Noma blocks.
 *
 * A definition is an ordinary directive whose body is the template:
 *
 *   ::component{name="pricing_card" props="plan,price,cta?" slots="features"}
 *   :::card{title="{{plan}}" class="elevated tone-accent"}
 *   **{{price}}**
 *
 *   {{slot:features}}
 *   :::
 *   ::
 *
 * A use is a directive named after the component:
 *
 *   ::pricing_card{id="team" plan="Team" price="$8"}
 *   :::slot{name="features"}
 *   - Unlimited pages
 *   :::
 *   ::
 *
 * The `.noma` source keeps the call (small, diffable, one stable ID); renderers
 * expand it. Substitution happens on the AST, never on source text, so a prop
 * value can change words and attribute values but can never inject blocks,
 * attributes, or markup. Components cannot shadow core directives, kits cannot
 * add CSS or scripts, and expansion is depth- and cycle-bounded.
 */
import type { DirectiveNode, DocumentNode, Node } from "./ast.js";
import { parse } from "./parser.js";

export interface ComponentProp {
  name: string;
  optional: boolean;
}

export interface ComponentDefinition {
  name: string;
  props: ComponentProp[];
  /** Named slots; the unnamed default slot (`{{slot}}`) is always available. */
  slots: string[];
  /** Template blocks (the definition's children). Never mutated. */
  template: Node[];
  description?: string;
  /** Where the definition came from (a page ID in Noma Cloud, a file path in the CLI). */
  origin?: string;
}

/** Definitions by component name. First definition of a name wins. */
export type ComponentKit = ReadonlyMap<string, ComponentDefinition>;

/** Core directives a component may never shadow. */
export const CORE_DIRECTIVES: ReadonlySet<string> = new Set([
  "abstract", "accordion", "adr", "agent_task", "api", "assumption", "bibliography", "button", "callout", "card",
  "change_request", "changelog", "children", "citation", "claim", "code", "code_cell", "columns", "comment",
  "canvas", "component", "component_instance", "computed_metric", "computed_plot", "computed_table", "confidence", "control",
  "counterevidence", "dataset", "decision", "deck", "diagram", "doc_protection", "endnote", "endpoint", "evidence",
  "example", "excerpt", "export_button", "figure", "footer", "footnote", "grid", "header", "hero", "html",
  "hypothesis", "include", "instruction", "issue", "issues", "limitation", "math", "memory", "memory_index",
  "mermaid", "metric", "note", "notes", "open_question", "output", "page_setup", "pagebreak", "parameter", "plot",
  "plotly", "provenance", "query", "result", "review", "risk", "script", "sidebar", "slide", "slot",
  "state_change", "summary", "svg", "tab", "table", "tabs", "tip", "toc", "todo", "warning",
]);

export const COMPONENT_NAME_RE = /^[a-z][a-z0-9_]{1,40}$/;
const PROP_NAME_RE = /^[a-zA-Z_][\w-]{0,40}$/;
const PLACEHOLDER_RE = /\{\{\s*([a-zA-Z_][\w-]*)\s*\}\}/g;
const SLOT_PLACEHOLDER_RE = /^\{\{\s*slot(?::([a-zA-Z_][\w-]*))?\s*\}\}$/;
/** Attributes every use may carry besides its props. */
const USE_RESERVED_ATTRS = new Set(["id", "class", "noverify"]);
export const MAX_COMPONENT_DEPTH = 8;
export const MAX_COMPONENT_EXPANSIONS = 500;

export interface ComponentDefinitionIssue {
  node: DirectiveNode;
  message: string;
}

/** Reads one `::component` block. Returns an issue instead when the definition is unusable. */
export function readComponentDefinition(node: DirectiveNode, origin?: string): ComponentDefinition | ComponentDefinitionIssue {
  const name = typeof node.attrs.name === "string" ? node.attrs.name.trim() : "";
  if (!COMPONENT_NAME_RE.test(name)) return { node, message: `component name "${name}" must be 2-41 lowercase letters, digits, or underscores, starting with a letter` };
  if (CORE_DIRECTIVES.has(name)) return { node, message: `component "${name}" would shadow the core ::${name} block` };
  const props: ComponentProp[] = [];
  for (const raw of listAttr(node.attrs.props)) {
    const optional = raw.endsWith("?");
    const prop = optional ? raw.slice(0, -1) : raw;
    if (!PROP_NAME_RE.test(prop) || USE_RESERVED_ATTRS.has(prop)) return { node, message: `component "${name}" has an invalid prop "${raw}"` };
    if (!props.some((p) => p.name === prop)) props.push({ name: prop, optional });
  }
  const slots = listAttr(node.attrs.slots);
  const badSlot = slots.find((slot) => !PROP_NAME_RE.test(slot));
  if (badSlot) return { node, message: `component "${name}" has an invalid slot "${badSlot}"` };
  const description = typeof node.attrs.description === "string" ? node.attrs.description : undefined;
  return { name, props, slots, template: node.children, ...(description ? { description } : {}), ...(origin ? { origin } : {}) };
}

function listAttr(value: unknown): string[] {
  return typeof value === "string" ? value.split(/[\s,]+/).map((part) => part.trim()).filter(Boolean) : [];
}

function isIssue(value: ComponentDefinition | ComponentDefinitionIssue): value is ComponentDefinitionIssue {
  return "message" in value;
}

/** Every `::component` block in a document, in source order. */
export function componentDefinitionNodes(doc: DocumentNode): DirectiveNode[] {
  const out: DirectiveNode[] = [];
  const visit = (nodes: Node[]): void => {
    for (const node of nodes) {
      if (node.type === "directive" && node.name === "component") {
        out.push(node);
        continue;
      }
      if (node.type === "section" || node.type === "directive") visit(node.children);
    }
  };
  visit(doc.children);
  return out;
}

/** Builds a kit from documents (e.g. the page itself, then its spaces' kit pages). Earlier sources win. */
export function componentKitFrom(sources: Array<{ doc: DocumentNode; origin?: string }>): { kit: Map<string, ComponentDefinition>; issues: ComponentDefinitionIssue[] } {
  const kit = new Map<string, ComponentDefinition>();
  const issues: ComponentDefinitionIssue[] = [];
  for (const { doc, origin } of sources) {
    for (const node of componentDefinitionNodes(doc)) {
      const definition = readComponentDefinition(node, origin);
      if (isIssue(definition)) issues.push(definition);
      else if (!kit.has(definition.name)) kit.set(definition.name, definition);
    }
  }
  return { kit, issues };
}

/** Parses kit source text (a kit page or file) into definitions. */
export function componentKitFromSource(source: string, origin?: string): Map<string, ComponentDefinition> {
  return componentKitFrom([{ doc: parse(source, { filename: "kit.noma" }), ...(origin ? { origin } : {}) }]).kit;
}

/** The document's own definitions first, then the host kit (a space's kit page, `--kit`). */
export function resolveComponentKit(doc: DocumentNode, host?: ComponentKit): Map<string, ComponentDefinition> {
  const local = componentKitFrom([{ doc }]).kit;
  for (const [name, definition] of host ?? []) if (!local.has(name)) local.set(name, definition);
  return local;
}

export interface ExpandComponentsOptions {
  /** Host kit merged under the document's own definitions. */
  kit?: ComponentKit;
  /**
   * Wrap each expansion in a `component_instance` directive carrying the use's
   * `id`, `class`, and `component` name (HTML). When false the expansion is
   * spliced in place (Markdown, DOCX, PaperDOM).
   */
  wrap?: boolean;
  /** Remove `::component` definitions from the output (handoff targets). */
  dropDefinitions?: boolean;
}

/**
 * Returns a new document with every component use expanded. The input is not
 * mutated. Template nodes lose their source positions; template IDs become
 * `<use-id>--<template-id>` (or are dropped when the use has no ID) so repeated
 * uses never collide. Unknown placeholders are left visible.
 */
export function expandComponents(doc: DocumentNode, options: ExpandComponentsOptions = {}): DocumentNode {
  const kit = resolveComponentKit(doc, options.kit);
  if (kit.size === 0 && !options.dropDefinitions) return doc;
  const budget = { left: MAX_COMPONENT_EXPANSIONS };
  const children = expandList(doc.children, kit, options, [], budget);
  return children === doc.children ? doc : { ...doc, children };
}

function expandList(nodes: Node[], kit: ComponentKit, options: ExpandComponentsOptions, stack: string[], budget: { left: number }): Node[] {
  let changed = false;
  const out: Node[] = [];
  for (const node of nodes) {
    const next = expandNode(node, kit, options, stack, budget);
    if (next.length !== 1 || next[0] !== node) changed = true;
    out.push(...next);
  }
  return changed ? out : nodes;
}

function expandNode(node: Node, kit: ComponentKit, options: ExpandComponentsOptions, stack: string[], budget: { left: number }): Node[] {
  if (node.type === "directive" && node.name === "component") return options.dropDefinitions ? [] : [node];
  if (node.type === "directive" && !CORE_DIRECTIVES.has(node.name) && kit.has(node.name)) {
    const definition = kit.get(node.name)!;
    if (stack.includes(node.name) || stack.length >= MAX_COMPONENT_DEPTH || budget.left <= 0) {
      return [componentError(node, stack.includes(node.name) ? `component cycle: ${[...stack, node.name].join(" → ")}` : "component expansion limit reached")];
    }
    budget.left -= 1;
    const instance = instantiate(definition, node);
    const expanded = expandList(instance, kit, options, [...stack, node.name], budget);
    const adopted = adoptUseIdentity(expanded, node);
    if (options.wrap === false) return adopted;
    const single = adopted !== expanded;
    const attrs: Record<string, string | number | boolean> = { component: node.name };
    if (single) attrs.single = true;
    else {
      if (node.id) attrs.id = node.id;
      if (typeof node.attrs.class === "string") attrs.class = node.attrs.class;
    }
    const wrapper: DirectiveNode = { type: "directive", name: "component_instance", attrs, children: adopted };
    if (node.id && !single) wrapper.id = node.id;
    if (node.pos) wrapper.pos = node.pos;
    if (node.endLine !== undefined) wrapper.endLine = node.endLine;
    return [wrapper];
  }
  if (node.type === "section" || node.type === "directive" || node.type === "document") {
    const children = expandList(node.children, kit, options, stack, budget);
    return children === node.children ? [node] : [{ ...node, children } as Node];
  }
  return [node];
}

/**
 * A single-root expansion takes the use's ID and style tokens, so anchors land
 * on a real box and `class="tone-accent"` styles the card itself. Returns the
 * input array unchanged when there is no single root to adopt them.
 */
function adoptUseIdentity(expanded: Node[], use: DirectiveNode): Node[] {
  const root = expanded.length === 1 ? expanded[0] : undefined;
  if (!root || (root.type !== "directive" && root.type !== "section")) return expanded;
  const next = { ...root } as DirectiveNode | Extract<Node, { type: "section" }>;
  if (use.id) next.id = use.id;
  if (next.type === "directive") {
    const attrs = { ...next.attrs };
    if (use.id) attrs.id = use.id;
    const classes = [attrs.class, use.attrs.class].filter((value): value is string => typeof value === "string" && value.length > 0);
    if (classes.length > 0) attrs.class = classes.join(" ");
    next.attrs = attrs;
  }
  return [next];
}

function componentError(node: DirectiveNode, message: string): DirectiveNode {
  return { type: "directive", name: "callout", attrs: { tone: "warning" }, body: `::${node.name} — ${message}`, children: [], ...(node.pos ? { pos: node.pos } : {}) };
}

/** Prop values and slot contents of one use. */
function useBindings(definition: ComponentDefinition, use: DirectiveNode): { props: Map<string, string>; slots: Map<string, Node[]> } {
  const props = new Map<string, string>();
  for (const prop of definition.props) {
    const value = use.attrs[prop.name];
    props.set(prop.name, value === undefined || value === true ? (value === true ? "true" : "") : String(value));
  }
  const slots = new Map<string, Node[]>([["", []]]);
  const bodyNodes = use.children.length === 0 && use.body ? [{ type: "paragraph", content: use.body } as Node] : use.children;
  for (const child of bodyNodes) {
    if (child.type === "directive" && child.name === "slot") {
      const name = typeof child.attrs.name === "string" ? child.attrs.name : "";
      const content = child.children.length === 0 && child.body ? [{ type: "paragraph", content: child.body } as Node] : child.children;
      slots.set(name, [...(slots.get(name) ?? []), ...content]);
    } else {
      slots.get("")!.push(child);
    }
  }
  return { props, slots };
}

function instantiate(definition: ComponentDefinition, use: DirectiveNode): Node[] {
  const { props, slots } = useBindings(definition, use);
  const idPrefix = use.id;
  const text = (value: string): string => value.replace(PLACEHOLDER_RE, (whole, name: string) => (props.has(name) ? props.get(name)! : whole));
  const scopedId = (id: string | undefined): string | undefined => (id && idPrefix ? `${idPrefix}--${text(id)}` : undefined);

  const cloneList = (nodes: Node[]): Node[] => nodes.flatMap(cloneNode);
  const cloneNode = (node: Node): Node[] => {
    if (node.type === "paragraph") {
      const slot = SLOT_PLACEHOLDER_RE.exec(node.content.trim());
      if (slot) return slots.get(slot[1] ?? "") ?? [];
      const content = text(node.content);
      if (!content.trim() && node.content.trim()) return [];
      return [withId({ type: "paragraph", content }, scopedId(node.id))];
    }
    switch (node.type) {
      case "section": {
        const section: Node = { type: "section", level: node.level, title: text(node.title), children: cloneList(node.children) };
        return [withId(section, scopedId(node.id))];
      }
      case "code":
        return [withId({ type: "code", content: node.content, ...(node.lang ? { lang: node.lang } : {}) }, scopedId(node.id))];
      case "list":
        return [withId({ type: "list", ordered: node.ordered, items: node.items.map((item) => ({ type: "list_item" as const, content: text(item.content) })) }, scopedId(node.id))];
      case "quote":
        return [withId({ type: "quote", content: text(node.content) }, scopedId(node.id))];
      case "thematic_break":
        return [{ type: "thematic_break" }];
      case "table":
        return [withId({ type: "table", header: node.header.map(text), align: [...node.align], rows: node.rows.map((row) => row.map(text)) }, scopedId(node.id))];
      case "directive": {
        const attrs: Record<string, string | number | boolean> = {};
        for (const [key, value] of Object.entries(node.attrs)) {
          if (key === "id") continue;
          attrs[key] = typeof value === "string" ? text(value) : value;
        }
        const id = scopedId(node.id ?? (typeof node.attrs.id === "string" ? node.attrs.id : undefined));
        if (id) attrs.id = id;
        const clone: DirectiveNode = { type: "directive", name: node.name, attrs, children: cloneList(node.children) };
        if (node.body !== undefined) clone.body = text(node.body);
        return [withId(clone, id)];
      }
      default:
        return [];
    }
  };
  return cloneList(definition.template);
}

function withId<T extends Node>(node: T, id: string | undefined): T {
  if (id) node.id = id;
  return node;
}

export interface ComponentUseIssue {
  node: DirectiveNode;
  code: "component-missing-prop" | "component-unknown-prop" | "component-unknown-slot";
  message: string;
}

/** Checks every use in `doc` against `kit`: required props present, no unknown props or slots. */
export function checkComponentUses(doc: DocumentNode, kit: ComponentKit): ComponentUseIssue[] {
  const issues: ComponentUseIssue[] = [];
  const visit = (nodes: Node[]): void => {
    for (const node of nodes) {
      if (node.type === "directive" && node.name === "component") continue;
      if (node.type === "directive" && !CORE_DIRECTIVES.has(node.name) && kit.has(node.name)) {
        const definition = kit.get(node.name)!;
        const known = new Set(definition.props.map((p) => p.name));
        for (const prop of definition.props) {
          if (!prop.optional && (node.attrs[prop.name] === undefined || node.attrs[prop.name] === "")) {
            issues.push({ node, code: "component-missing-prop", message: `::${node.name} needs \`${prop.name}=\`.` });
          }
        }
        for (const key of Object.keys(node.attrs)) {
          if (!known.has(key) && !USE_RESERVED_ATTRS.has(key)) {
            issues.push({ node, code: "component-unknown-prop", message: `::${node.name} has no prop "${key}". Props: ${definition.props.map((p) => p.name + (p.optional ? "?" : "")).join(", ") || "none"}.` });
          }
        }
        for (const child of node.children) {
          if (child.type !== "directive" || child.name !== "slot") continue;
          const slot = typeof child.attrs.name === "string" ? child.attrs.name : "";
          if (slot && !definition.slots.includes(slot)) {
            issues.push({ node: child, code: "component-unknown-slot", message: `::${node.name} has no slot "${slot}". Slots: ${definition.slots.join(", ") || "only the default slot"}.` });
          }
        }
      }
      if (node.type === "section" || node.type === "directive") visit(node.children);
    }
  };
  visit(doc.children);
  return issues;
}

/** Human-readable signature, e.g. `pricing_card(plan, price, cta?) [features]`. */
export function componentSignature(definition: ComponentDefinition): string {
  const props = definition.props.map((p) => p.name + (p.optional ? "?" : "")).join(", ");
  return `${definition.name}(${props})${definition.slots.length ? ` [${definition.slots.join(", ")}]` : ""}`;
}

/**
 * Source for a new use of `definition`: required props as empty attributes,
 * one `slot` block per named slot. The caller assigns the ID.
 */
export function componentUseSource(definition: ComponentDefinition, id?: string): string {
  const attrs = [...(id ? [`id="${id}"`] : []), ...definition.props.filter((p) => !p.optional).map((p) => `${p.name}=""`)].join(" ");
  const slots = definition.slots.map((slot) => `:::slot{name="${slot}"}\n\n:::`).join("\n\n");
  return `::${definition.name}${attrs ? `{${attrs}}` : ""}\n${slots}${slots ? "\n" : ""}::`;
}
