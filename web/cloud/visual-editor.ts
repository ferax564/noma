/** Visual editor behaviour: node views, slash menu, formatting toolbar, input rules, keymap, paste. DOM-only; no app state. */
import { baseKeymap, setBlockType, toggleMark } from "@tiptap/pm/commands";
import { dropCursor } from "@tiptap/pm/dropcursor";
import { gapCursor } from "@tiptap/pm/gapcursor";
import { InputRule, inputRules, textblockTypeInputRule } from "@tiptap/pm/inputrules";
import { keymap } from "@tiptap/pm/keymap";
import { Fragment, type Node as PMNode, Slice } from "@tiptap/pm/model";
import { type Command, type EditorState, Plugin, PluginKey, TextSelection, type Transaction } from "@tiptap/pm/state";
import { addColumnAfter, addRowAfter, deleteColumn, deleteRow, goToNextCell, isInTable, tableEditing } from "@tiptap/pm/tables";
import type { EditorView, NodeView, NodeViewConstructor } from "@tiptap/pm/view";
import {
  CHIP_DIRECTIVES,
  type EditorNode,
  editorNodeId,
  nomaToEditorDoc,
  parseDirectiveAttrs,
  parseInline,
  serializeDirectiveAttrs,
} from "../../src/editor-model.js";
import { convertMarkdownToNoma } from "../../src/ingest-markdown.js";
import { STYLE_TOKEN_GROUPS } from "../../src/style-tokens.js";
import { type ComponentKit, componentUseSource } from "../../src/components.js";
import { safeHref } from "../../src/inline.js";
import { knownMentionName, resolveMentionNames } from "./mentions.js";
import { visualSchema, wikilinkLabel } from "./visual-schema.js";

const schema = visualSchema;
const nodes = schema.nodes;
const marks = schema.marks;

export interface VisualEditorHooks {
  /** True for transactions that came from a remote collaborator (never rewritten locally). */
  isRemote(tr: Transaction): boolean;
  /** Called on Mod-s. */
  save(): void;
  /** Whether the document is currently editable. */
  editable(): boolean;
  /** Style-token aliases of the page's spaces, offered in the Style picker. */
  styleTokens?(): Readonly<Record<string, readonly string[]>>;
  /** Component kit of the page's spaces, offered in the slash menu. */
  components?(): ComponentKit;
}

// ---------------------------------------------------------------------------
// Block factories

function paragraph(text = ""): PMNode {
  return nodes.paragraph!.create(null, text ? schema.text(text) : null);
}

function directive(name: string, attrs = "", children: PMNode[] = [paragraph()]): PMNode {
  return nodes.directive!.create({ name, attrs, colons: 2 }, CHIP_DIRECTIVES.has(name) ? [] : children);
}

function textDirective(name: string, attrs: string, body: string): PMNode {
  return nodes.text_directive!.create({ name, attrs, colons: 2 }, body ? schema.text(body) : null);
}

function listNode(type: "bullet_list" | "ordered_list", checked: boolean | null, content: Fragment): PMNode {
  return nodes[type]!.create(null, nodes.list_item!.create({ checked }, content));
}

function tableNode(columns = 3, bodyRows = 2): PMNode {
  const row = (header: boolean) =>
    nodes.table_row!.create(null, Array.from({ length: columns }, (_, index) => (header ? nodes.table_header! : nodes.table_cell!).create(null, header ? schema.text(`Column ${index + 1}`) : null)));
  return nodes.table!.create({ align: Array.from({ length: columns }, () => "-").join(",") }, [row(true), ...Array.from({ length: bodyRows }, () => row(false))]);
}

export interface SlashItem {
  id: string;
  label: string;
  hint: string;
  keywords: string;
  build: (content: Fragment) => PMNode | PMNode[];
  /** Keep the current paragraph's text as the new block's content. */
  keepsText?: boolean;
  /** Context-aware insertion (e.g. a slide goes after the current slide); replaces `build`. */
  insert?: (view: EditorView, from: number, to: number) => void;
}

/** A block ID not yet used in the document (`base-1`, `base-2`, …), assigned once like any other ID. */
export function freshBlockId(doc: PMNode, base: string, reserved: ReadonlySet<string> = new Set()): string {
  const used = new Set<string>(reserved);
  doc.descendants((node) => {
    const raw = typeof node.attrs.attrs === "string" ? node.attrs.attrs : typeof node.attrs.src === "string" ? node.attrs.src : "";
    for (const match of raw.matchAll(/\bid="([^"]+)"|\bid=([\w.:-]+)/g)) used.add(match[1] ?? match[2] ?? "");
    return true;
  });
  for (let n = 1; ; n++) if (!used.has(`${base}-${n}`)) return `${base}-${n}`;
}

function slideNode(id: string, title: string, layout = "content", children: PMNode[] = [paragraph()]): PMNode {
  return nodes.directive!.create({ name: "slide", attrs: serializeDirectiveAttrs([["id", id], ["title", title], ["layout", layout]]), colons: 3 }, children);
}

/** Nearest ancestor directive named `name` around `pos`, with its depth. */
function ancestorDirective(doc: PMNode, pos: number, name: string): { node: PMNode; depth: number; $pos: ReturnType<PMNode["resolve"]> } | undefined {
  const $pos = doc.resolve(pos);
  for (let depth = $pos.depth; depth > 0; depth--) {
    const node = $pos.node(depth);
    if (node.type === nodes.directive && node.attrs.name === name) return { node, depth, $pos };
  }
  return undefined;
}

function focusInside(tr: Transaction, pos: number): Transaction {
  const selection = TextSelection.findFrom(tr.doc.resolve(Math.min(tr.doc.content.size, pos)), 1, true);
  return selection ? tr.setSelection(selection) : tr;
}

/** Removes the typed `/query`, and the paragraph too when that leaves it empty. */
function removeSlashText(tr: Transaction, from: number, to: number): Transaction {
  tr = tr.delete(from, to);
  const $pos = tr.doc.resolve(tr.mapping.map(from));
  if ($pos.parent.type === nodes.paragraph && $pos.parent.content.size === 0 && $pos.depth > 0 && $pos.node($pos.depth - 1).childCount > 1) {
    tr = tr.delete($pos.before(), $pos.after());
  }
  return tr;
}

function insertDeck(view: EditorView, from: number, to: number): void {
  const doc = view.state.doc;
  const deckId = freshBlockId(doc, "deck");
  const first = freshBlockId(doc, "slide");
  const second = freshBlockId(doc, "slide", new Set([first]));
  const deck = nodes.directive!.create({ name: "deck", attrs: serializeDirectiveAttrs([["id", deckId], ["title", "Untitled deck"], ["aspect", "16:9"]]), colons: 2 }, [
    slideNode(first, "Title slide", "title", [paragraph("Subtitle")]),
    slideNode(second, "First point", "content", [paragraph()]),
  ]);
  applySlashItem(view, { id: "deck", label: "", hint: "", keywords: "", build: () => deck }, from, to);
}

function insertSlide(view: EditorView, from: number, to: number): void {
  const slide = ancestorDirective(view.state.doc, from, "slide");
  const deck = slide ? ancestorDirective(view.state.doc, slide.$pos.before(slide.depth), "deck") : ancestorDirective(view.state.doc, from, "deck");
  if (!deck) {
    insertDeck(view, from, to);
    return;
  }
  const id = freshBlockId(view.state.doc, "slide");
  let tr = removeSlashText(view.state.tr, from, to);
  const after = slide ? tr.mapping.map(slide.$pos.after(slide.depth)) : tr.mapping.map(deck.$pos.end(deck.depth));
  tr = tr.insert(after, slideNode(id, "New slide"));
  view.dispatch(focusInside(tr, after + 1).scrollIntoView());
  view.focus();
}

function insertNotes(view: EditorView, from: number, to: number): void {
  const slide = ancestorDirective(view.state.doc, from, "slide");
  const notes = directive("notes", "", [paragraph()]);
  if (!slide) {
    applySlashItem(view, { id: "notes", label: "", hint: "", keywords: "", build: () => notes }, from, to);
    return;
  }
  let tr = removeSlashText(view.state.tr, from, to);
  const end = tr.mapping.map(slide.$pos.end(slide.depth));
  tr = tr.insert(end, notes);
  view.dispatch(focusInside(tr, end + 1).scrollIntoView());
  view.focus();
}

function insertWidget(view: EditorView, from: number, to: number): void {
  const id = freshBlockId(view.state.doc, "widget");
  const src = `::html{id="${id}" height=240 title="Widget"}\n<button id="go">Click me</button>\n<p id="out"></p>\n<script>\ndocument.getElementById("go").onclick = () => { document.getElementById("out").textContent = "Hello from a sandboxed widget"; };\n</script>\n::`;
  applySlashItem(view, { id: "html", label: "", hint: "", keywords: "", build: () => nodes.raw!.create({ src, label: "html" }) }, from, to);
}

function gridOfCards(): PMNode {
  const card = (title: string) => nodes.directive!.create({ name: "card", attrs: serializeDirectiveAttrs([["title", title]]), colons: 3 }, [paragraph()]);
  return nodes.directive!.create({ name: "grid", attrs: "columns=2", colons: 2 }, [card("First"), card("Second")]);
}

export const slashItems: SlashItem[] = [
  { id: "h1", label: "Heading 1", hint: "#", keywords: "title h1", keepsText: true, build: (content) => nodes.heading!.create({ level: 1 }, content) },
  { id: "h2", label: "Heading 2", hint: "##", keywords: "section h2", keepsText: true, build: (content) => nodes.heading!.create({ level: 2 }, content) },
  { id: "h3", label: "Heading 3", hint: "###", keywords: "subsection h3", keepsText: true, build: (content) => nodes.heading!.create({ level: 3 }, content) },
  { id: "bullet", label: "Bullet list", hint: "-", keywords: "list ul unordered", keepsText: true, build: (content) => listNode("bullet_list", null, content) },
  { id: "numbered", label: "Numbered list", hint: "1.", keywords: "list ol ordered", keepsText: true, build: (content) => listNode("ordered_list", null, content) },
  { id: "task", label: "Task list", hint: "[ ]", keywords: "todo checkbox checklist", keepsText: true, build: (content) => listNode("bullet_list", false, content) },
  { id: "table", label: "Table", hint: "| |", keywords: "grid rows columns pipe", build: () => tableNode() },
  { id: "code", label: "Code block", hint: "```", keywords: "fence snippet", build: (content) => nodes.code_block!.create(null, content.size ? schema.text(fragmentText(content)) : null) },
  { id: "quote", label: "Quote", hint: ">", keywords: "blockquote citation", keepsText: true, build: (content) => nodes.blockquote!.create(null, content) },
  { id: "callout", label: "Callout", hint: "::callout", keywords: "note info tip", build: (content) => directive("callout", `tone="info"`, [nodes.paragraph!.create(null, content)]) },
  { id: "warning", label: "Warning", hint: "::callout", keywords: "caution danger alert", build: (content) => directive("callout", `tone="warning"`, [nodes.paragraph!.create(null, content)]) },
  { id: "decision", label: "Decision", hint: "::decision", keywords: "adr record choose", build: (content) => directive("decision", `status="proposed"`, [nodes.paragraph!.create(null, content)]) },
  { id: "claim", label: "Claim", hint: "::claim", keywords: "assertion thesis", build: (content) => directive("claim", "confidence=0.7", [nodes.paragraph!.create(null, content)]) },
  { id: "evidence", label: "Evidence", hint: "::evidence", keywords: "source support", build: (content) => directive("evidence", `for=""`, [nodes.paragraph!.create(null, content)]) },
  { id: "figure", label: "Figure", hint: "::figure", keywords: "image picture caption", build: () => directive("figure", `src="" alt=""`, [paragraph("Caption")]) },
  { id: "math", label: "Math", hint: "::math", keywords: "equation latex tex formula", build: () => textDirective("math", "", "E = mc^2") },
  { id: "mermaid", label: "Mermaid diagram", hint: "::diagram", keywords: "chart flow graph", build: () => textDirective("diagram", `kind="mermaid"`, "graph TD\n  A --> B") },
  { id: "toc", label: "Table of contents", hint: "::toc", keywords: "outline contents", build: () => directive("toc") },
  { id: "children", label: "Child pages", hint: "::children", keywords: "subpages tree", build: () => directive("children") },
  { id: "include", label: "Include page", hint: "::include", keywords: "transclude embed", build: () => directive("include", `src=""`) },
  { id: "deck", label: "Slide deck", hint: "::deck", keywords: "presentation slides present pitch", build: () => paragraph(), insert: insertDeck },
  { id: "slide", label: "Slide", hint: ":::slide", keywords: "presentation deck page", build: () => paragraph(), insert: insertSlide },
  { id: "notes", label: "Speaker notes", hint: "::::notes", keywords: "presenter slide talk", build: () => paragraph(), insert: insertNotes },
  { id: "grid", label: "Grid of cards", hint: "::grid", keywords: "columns layout cards lego", build: () => gridOfCards() },
  { id: "card", label: "Card", hint: "::card", keywords: "box panel tile", keepsText: true, build: (content) => directive("card", `title="Card"`, [nodes.paragraph!.create(null, content)]) },
  { id: "widget", label: "HTML widget", hint: "::html", keywords: "embed interactive calculator app script sandbox", build: () => paragraph(), insert: insertWidget },
  { id: "divider", label: "Divider", hint: "---", keywords: "rule hr separator", build: () => nodes.horizontal_rule!.create() },
  { id: "raw", label: "Raw Noma block", hint: "::", keywords: "source directive custom", build: () => nodes.raw!.create({ src: "::note\nWrite Noma source here.\n::", label: "note" }) },
];

function fragmentText(content: Fragment): string {
  let text = "";
  content.forEach((node) => {
    text += node.isText ? (node.text ?? "") : node.type.name === "hard_break" ? "\n" : node.textContent;
  });
  return text;
}

export function runSlashItem(view: EditorView, item: SlashItem, from: number, to: number): void {
  if (item.insert) item.insert(view, from, to);
  else applySlashItem(view, item, from, to);
}

/** Replace the textblock around the cursor (after removing `from..to`) with the slash item. */
export function applySlashItem(view: EditorView, item: SlashItem, from: number, to: number): void {
  const { state } = view;
  let tr = state.tr.delete(from, to);
  const $pos = tr.doc.resolve(tr.mapping.map(from));
  const block = $pos.parent;
  if (!block.isTextblock || $pos.depth === 0) return;
  const start = $pos.before();
  const end = $pos.after();
  const content = item.keepsText || block.content.size === 0 ? block.content : Fragment.empty;
  const built = item.build(item.keepsText ? content : Fragment.empty);
  const replacement = Array.isArray(built) ? built : [built];
  if (block.type === nodes.paragraph && (block.content.size === 0 || item.keepsText)) {
    tr = tr.replaceWith(start, end, replacement);
  } else {
    tr = tr.insert(end, replacement);
  }
  const target = tr.doc.resolve(Math.min(tr.doc.content.size, (block.type === nodes.paragraph && (block.content.size === 0 || item.keepsText) ? start : end) + 1));
  const selection = TextSelection.findFrom(target, 1, true);
  if (selection) tr = tr.setSelection(selection);
  view.dispatch(tr.scrollIntoView());
  view.focus();
}

// ---------------------------------------------------------------------------
// Slash menu

interface SlashState {
  active: boolean;
  from: number;
  to: number;
  query: string;
}

const slashKey = new PluginKey<SlashState>("noma-slash");

function slashMatch(state: EditorState): SlashState {
  const { selection } = state;
  if (!selection.empty) return { active: false, from: 0, to: 0, query: "" };
  const $from = selection.$from;
  if (!$from.parent.isTextblock || $from.parent.type.spec.code) return { active: false, from: 0, to: 0, query: "" };
  const before = $from.parent.textBetween(0, $from.parentOffset, undefined, "￼");
  const match = /(?:^|\s)\/([\w-]{0,24})$/.exec(before);
  if (!match) return { active: false, from: 0, to: 0, query: "" };
  const length = match[1]!.length + 1;
  return { active: true, from: $from.pos - length, to: $from.pos, query: match[1]!.toLowerCase() };
}

let componentProvider: () => ComponentKit = () => new Map();

/** Slash entries for the page's components: `/pricing_card` inserts a use with required props and slots scaffolded. */
export function componentSlashItems(kit: ComponentKit): SlashItem[] {
  return [...kit.values()].map((definition) => ({
    id: `component:${definition.name}`,
    label: definition.name.replace(/_/g, " "),
    hint: `::${definition.name}`,
    keywords: `component kit ${definition.name} ${definition.description ?? ""}`.toLowerCase(),
    build: () => paragraph(),
    insert: (view, from, to) => {
      const id = freshBlockId(view.state.doc, definition.name.replace(/_/g, "-"));
      const parsed = schema.nodeFromJSON(nomaToEditorDoc(componentUseSource(definition, id)));
      const blocks: PMNode[] = [];
      parsed.forEach((node) => {
        blocks.push(node);
      });
      applySlashItem(view, { id: definition.name, label: "", hint: "", keywords: "", build: () => blocks }, from, to);
    },
  }));
}

/** Matching items, best first: exact id, then label or id prefix, then any other match (menu order kept within a rank). */
export function filteredSlashItems(query: string): SlashItem[] {
  const all = [...slashItems, ...componentSlashItems(componentProvider())];
  if (!query) return all;
  const rank = (item: SlashItem): number =>
    item.id === query || item.id === `component:${query}` ? 0 : item.label.toLowerCase().startsWith(query) || item.id.startsWith(query) || item.hint.startsWith(`::${query}`) ? 1 : 2;
  return all
    .filter((item) => item.label.toLowerCase().includes(query) || item.id.includes(query) || item.keywords.includes(query))
    .map((item, index) => ({ item, index, rank: rank(item) }))
    .sort((a, b) => a.rank - b.rank || a.index - b.index)
    .map(({ item }) => item);
}

function slashPlugin(): Plugin<SlashState> {
  let menu: HTMLElement | undefined;
  let selected = 0;
  let dismissedAt = -1;
  const close = (): void => {
    menu?.remove();
    menu = undefined;
    selected = 0;
  };
  const render = (view: EditorView, slash: SlashState): void => {
    const items = filteredSlashItems(slash.query);
    if (!slash.active || items.length === 0 || dismissedAt === slash.from || !view.editable) {
      close();
      return;
    }
    if (!menu) {
      menu = document.createElement("div");
      menu.className = "visual-slash-menu";
      menu.setAttribute("role", "listbox");
      menu.setAttribute("aria-label", "Insert block");
      document.body.append(menu);
    }
    selected = Math.min(selected, items.length - 1);
    menu.textContent = "";
    items.forEach((item, index) => {
      const button = document.createElement("button");
      button.type = "button";
      button.className = "visual-slash-item";
      button.setAttribute("role", "option");
      button.setAttribute("aria-selected", String(index === selected));
      button.dataset.slashId = item.id;
      const label = document.createElement("span");
      label.textContent = item.label;
      const hint = document.createElement("span");
      hint.className = "visual-slash-hint";
      hint.textContent = item.hint;
      button.append(label, hint);
      button.addEventListener("mousedown", (event) => {
        event.preventDefault();
        close();
        runSlashItem(view, item, slash.from, slash.to);
      });
      menu!.append(button);
    });
    const coords = view.coordsAtPos(slash.to);
    menu.style.left = `${Math.max(8, Math.min(window.innerWidth - 280, coords.left))}px`;
    menu.style.top = `${Math.min(window.innerHeight - 40, coords.bottom + 6)}px`;
  };
  return new Plugin<SlashState>({
    key: slashKey,
    state: {
      init: () => ({ active: false, from: 0, to: 0, query: "" }),
      apply: (_tr, _value, _old, next) => slashMatch(next),
    },
    props: {
      handleKeyDown(view, event) {
        const slash = slashKey.getState(view.state);
        if (!slash?.active || !menu) return false;
        const items = filteredSlashItems(slash.query);
        if (event.key === "ArrowDown" || event.key === "ArrowUp") {
          selected = (selected + (event.key === "ArrowDown" ? 1 : items.length - 1)) % items.length;
          render(view, slash);
          return true;
        }
        if (event.key === "Enter" || event.key === "Tab") {
          const item = items[selected];
          if (!item) return false;
          close();
          runSlashItem(view, item, slash.from, slash.to);
          return true;
        }
        if (event.key === "Escape") {
          dismissedAt = slash.from;
          close();
          return true;
        }
        return false;
      },
    },
    view: () => ({
      update: (view) => {
        const slash = slashKey.getState(view.state);
        if (slash) render(view, slash);
      },
      destroy: close,
    }),
  });
}

// ---------------------------------------------------------------------------
// Floating formatting toolbar

function markActive(state: EditorState, name: string): boolean {
  const type = marks[name];
  if (!type) return false;
  const { from, to, empty, $from } = state.selection;
  if (empty) return Boolean(type.isInSet(state.storedMarks ?? $from.marks()));
  return state.doc.rangeHasMark(from, to, type);
}

function promptLink(view: EditorView): void {
  const type = marks.link!;
  if (markActive(view.state, "link")) {
    toggleMark(type)(view.state, view.dispatch);
    return;
  }
  const href = window.prompt("Link URL", "https://");
  if (!href) return;
  toggleMark(type, { href: safeHref(href.trim()) })(view.state, view.dispatch);
}

function promptWikilink(view: EditorView): void {
  const { from, to } = view.state.selection;
  const label = view.state.doc.textBetween(from, to, " ");
  const target = window.prompt("Link to block ID or page", label.toLowerCase().replace(/[^\w-]+/g, "-"));
  if (!target) return;
  const raw = label && label !== target ? `${target.trim()}|${label}` : target.trim();
  view.dispatch(view.state.tr.replaceSelectionWith(nodes.wikilink!.create({ raw }), false));
}

function toolbarPlugin(): Plugin {
  let bar: HTMLElement | undefined;
  const close = (): void => {
    bar?.remove();
    bar = undefined;
  };
  const buttons: Array<{ id: string; label: string; aria: string; run: (view: EditorView) => void; active?: (state: EditorState) => boolean; table?: boolean }> = [
    { id: "bold", label: "B", aria: "Bold", run: (view) => toggleMark(marks.strong!)(view.state, view.dispatch), active: (state) => markActive(state, "strong") },
    { id: "italic", label: "I", aria: "Italic", run: (view) => toggleMark(marks.em!)(view.state, view.dispatch), active: (state) => markActive(state, "em") },
    { id: "code", label: "</>", aria: "Inline code", run: (view) => toggleMark(marks.code!)(view.state, view.dispatch), active: (state) => markActive(state, "code") },
    { id: "link", label: "Link", aria: "Link", run: promptLink, active: (state) => markActive(state, "link") },
    { id: "wikilink", label: "[[ ]]", aria: "Link to block", run: promptWikilink },
    { id: "h2", label: "H2", aria: "Heading 2", run: (view) => setBlockType(nodes.heading!, { level: 2 })(view.state, view.dispatch) },
    { id: "h3", label: "H3", aria: "Heading 3", run: (view) => setBlockType(nodes.heading!, { level: 3 })(view.state, view.dispatch) },
    { id: "text", label: "Text", aria: "Plain paragraph", run: (view) => setBlockType(nodes.paragraph!)(view.state, view.dispatch) },
    { id: "row", label: "+ Row", aria: "Add table row", run: (view) => addRowAfter(view.state, view.dispatch), table: true },
    { id: "column", label: "+ Column", aria: "Add table column", run: (view) => addColumnAfter(view.state, view.dispatch), table: true },
    { id: "delete-row", label: "- Row", aria: "Delete table row", run: (view) => deleteRow(view.state, view.dispatch), table: true },
    { id: "delete-column", label: "- Column", aria: "Delete table column", run: (view) => deleteColumn(view.state, view.dispatch), table: true },
  ];
  return new Plugin({
    view: () => ({
      update: (view) => {
        const { selection } = view.state;
        const inTable = isInTable(view.state);
        const textSelected = !selection.empty && selection instanceof TextSelection && selection.$from.parent.inlineContent && !selection.$from.parent.type.spec.code;
        const show = view.editable && view.hasFocus() && (textSelected || inTable);
        if (!show) {
          close();
          return;
        }
        if (!bar) {
          bar = document.createElement("div");
          bar.className = "visual-toolbar";
          bar.setAttribute("role", "toolbar");
          bar.setAttribute("aria-label", "Formatting");
          for (const item of buttons) {
            const button = document.createElement("button");
            button.type = "button";
            button.textContent = item.label;
            button.setAttribute("aria-label", item.aria);
            button.dataset.toolbar = item.id;
            button.addEventListener("mousedown", (event) => {
              event.preventDefault();
              item.run(view);
              view.focus();
            });
            bar.append(button);
          }
          document.body.append(bar);
        }
        for (const item of buttons) {
          const button = bar.querySelector<HTMLButtonElement>(`[data-toolbar="${item.id}"]`);
          if (!button) continue;
          button.hidden = item.table ? !inTable : !textSelected;
          if (item.active) button.setAttribute("aria-pressed", String(item.active(view.state)));
        }
        const start = view.coordsAtPos(selection.from);
        bar.style.left = `${Math.max(8, Math.min(window.innerWidth - 360, start.left))}px`;
        bar.style.top = `${Math.max(8, start.top - 44)}px`;
      },
      destroy: close,
    }),
    props: {
      handleDOMEvents: {
        blur: () => {
          window.setTimeout(close, 120);
          return false;
        },
      },
    },
  });
}

// ---------------------------------------------------------------------------
// Input rules

function replaceTextblock(build: (content: Fragment, match: RegExpMatchArray) => PMNode | undefined) {
  return (state: EditorState, match: RegExpMatchArray, start: number, end: number): Transaction | null => {
    const $start = state.doc.resolve(start);
    const block = $start.parent;
    if (block.type !== nodes.paragraph || $start.depth === 0) return null;
    const rest = block.content.cut(end - $start.start());
    const node = build(rest, match);
    if (!node) return null;
    const tr = state.tr.replaceWith($start.before(), $start.after(), node);
    const selection = TextSelection.findFrom(tr.doc.resolve($start.before() + 1), 1, true);
    return selection ? tr.setSelection(selection) : tr;
  };
}

function markRule(pattern: RegExp, markName: string, attrs: Record<string, string> = {}): InputRule {
  return new InputRule(pattern, (state, match, start, end) => {
    const type = marks[markName];
    const inner = match[2];
    if (!type || !inner) return null;
    const leading = match[1] ?? "";
    const from = start + leading.length;
    const tr = state.tr.replaceWith(from, end, schema.text(inner, [type.create(attrs)]));
    return tr.removeStoredMark(type);
  });
}

function nomaInputRules(): Plugin {
  return inputRules({
    rules: [
      textblockTypeInputRule(/^(#{1,6})\s$/, nodes.heading!, (match) => ({ level: match[1]!.length })),
      textblockTypeInputRule(/^```(\w*)\s$/, nodes.code_block!, (match) => ({ lang: match[1] ?? "" })),
      new InputRule(/^\[( |x|X)?\]\s$/, replaceTextblock((content, match) => listNode("bullet_list", /x/i.test(match[1] ?? ""), content))),
      new InputRule(/^([-*])\s$/, replaceTextblock((content, match) => nodes.bullet_list!.create({ bullet: match[1] }, nodes.list_item!.create(null, content)))),
      new InputRule(/^(\d+)\.\s$/, replaceTextblock((content, match) => nodes.ordered_list!.create(null, nodes.list_item!.create({ num: match[1] }, content)))),
      new InputRule(/^>\s$/, replaceTextblock((content) => nodes.blockquote!.create(null, content))),
      new InputRule(/^---$/, (state, _match, start, end) => {
        const $start = state.doc.resolve(start);
        if ($start.parent.type !== nodes.paragraph || $start.depth === 0 || state.doc.resolve(end).parentOffset !== $start.parent.content.size) return null;
        const tr = state.tr.replaceWith($start.before(), $start.after(), [nodes.horizontal_rule!.create(), paragraph()]);
        return tr.setSelection(TextSelection.create(tr.doc, $start.before() + 2));
      }),
      markRule(/(^|[^*])\*\*([^*]+)\*\*$/, "strong", { delim: "**" }),
      markRule(/(^|[^*])\*([^*\s][^*]*)\*$/, "em", { delim: "*" }),
      markRule(/(^|\s)_([^_\s][^_]*)_$/, "em", { delim: "_" }),
      markRule(/(^|[^`])`([^`]+)`$/, "code"),
      new InputRule(/\[\[([^[\]\n]+)\]\]$/, (state, match, start, end) => state.tr.replaceWith(start, end, nodes.wikilink!.create({ raw: match[1] }))),
    ],
  });
}

// ---------------------------------------------------------------------------
// Keymap

function listItemAt(state: EditorState): { node: PMNode; depth: number } | undefined {
  const { $from } = state.selection;
  for (let depth = $from.depth; depth > 0; depth--) {
    const node = $from.node(depth);
    if (node.type === nodes.list_item) return { node, depth };
  }
  return undefined;
}

const splitListItem: Command = (state, dispatch) => {
  const item = listItemAt(state);
  if (!item || !state.selection.empty) return false;
  const { $from } = state.selection;
  if (item.node.content.size === 0) {
    const list = $from.node(item.depth - 1);
    const listStart = $from.before(item.depth - 1);
    const index = $from.index(item.depth - 1);
    if (!dispatch) return true;
    let tr = state.tr;
    const after = listStart + list.nodeSize;
    const itemStart = $from.before(item.depth);
    tr = tr.delete(itemStart, itemStart + item.node.nodeSize);
    if (list.childCount === 1) tr = tr.replaceWith(listStart, listStart + tr.doc.nodeAt(listStart)!.nodeSize, paragraph());
    else if (index === list.childCount - 1) tr = tr.insert(tr.mapping.map(after), paragraph());
    else return false;
    const target = list.childCount === 1 ? listStart + 1 : tr.mapping.map(after) + 1;
    dispatch(tr.setSelection(TextSelection.create(tr.doc, Math.min(target, tr.doc.content.size))).scrollIntoView());
    return true;
  }
  if (dispatch) {
    const checked = item.node.attrs.checked === null ? null : false;
    dispatch(state.tr.split($from.pos, 1, [{ type: nodes.list_item!, attrs: { id: null, checked, num: null } }]).scrollIntoView());
  }
  return true;
};

const hardBreak: Command = (state, dispatch) => {
  if (state.selection.$from.parent.type.spec.code) return false;
  if (dispatch) dispatch(state.tr.replaceSelectionWith(nodes.hard_break!.create()).scrollIntoView());
  return true;
};

function nomaKeymap(hooks: VisualEditorHooks, undo: Command, redo: Command): Plugin {
  const table = (command: Command): Command => (state, dispatch) => isInTable(state) && command(state, dispatch);
  return keymap({
    "Mod-z": undo,
    "Shift-Mod-z": redo,
    "Mod-y": redo,
    "Mod-b": toggleMark(marks.strong!),
    "Mod-i": toggleMark(marks.em!),
    "Mod-e": toggleMark(marks.code!),
    "Mod-k": (_state, _dispatch, view) => {
      if (view) promptLink(view);
      return true;
    },
    "Mod-s": () => {
      hooks.save();
      return true;
    },
    "Mod-Alt-0": setBlockType(nodes.paragraph!),
    "Mod-Alt-1": setBlockType(nodes.heading!, { level: 1 }),
    "Mod-Alt-2": setBlockType(nodes.heading!, { level: 2 }),
    "Mod-Alt-3": setBlockType(nodes.heading!, { level: 3 }),
    "Shift-Enter": hardBreak,
    Enter: splitListItem,
    Tab: table(goToNextCell(1)),
    "Shift-Tab": table(goToNextCell(-1)),
    "Mod-Enter": table(addRowAfter),
  });
}

// ---------------------------------------------------------------------------
// Stable-ID deduplication (split, paste and duplicate never clone an ID)

function dedupePlugin(hooks: VisualEditorHooks): Plugin {
  return new Plugin({
    appendTransaction(transactions, _old, state) {
      if (!transactions.some((tr) => tr.docChanged && !hooks.isRemote(tr))) return null;
      const seen = new Set<string>();
      let tr: Transaction | null = null;
      state.doc.descendants((node, pos) => {
        const id = editorNodeId(node.toJSON() as EditorNode);
        if (!id) return true;
        if (!seen.has(id)) {
          seen.add(id);
          return true;
        }
        const attrs = { ...node.attrs };
        if ("marker" in attrs && typeof attrs.marker === "string" && attrs.marker.includes(`{#${id}`)) attrs.marker = null;
        else if (node.type === nodes.directive || node.type === nodes.text_directive) {
          attrs.attrs = serializeDirectiveAttrs(parseDirectiveAttrs(String(attrs.attrs ?? "")).filter(([key]) => key !== "id"));
        } else if ("id" in attrs) {
          attrs.id = null;
          if (node.type === nodes.heading && typeof attrs.attrs === "string") {
            attrs.attrs = serializeDirectiveAttrs(parseDirectiveAttrs(attrs.attrs).filter(([key]) => key !== "id")) || null;
          }
        }
        tr = (tr ?? state.tr).setNodeMarkup(pos, undefined, attrs);
        return true;
      });
      if (tr) (tr as Transaction).setMeta("addToHistory", false);
      return tr;
    },
  });
}

// ---------------------------------------------------------------------------
// Paste: external HTML/Markdown becomes Noma blocks through the ingest pipeline

const BLOCK_SYNTAX_RE = /^(#{1,6}\s|[-*]\s|\d+\.\s|>\s?|```|:{2,}\w|\||\{#|---\s*$)/m;

/** Convert pasted HTML to Markdown using only structural tags; scripts, styles and attributes are dropped. */
export function htmlToMarkdown(html: string): string {
  const doc = new DOMParser().parseFromString(html, "text/html");
  for (const element of Array.from(doc.querySelectorAll("script, style, iframe, object, embed, template, noscript, svg, meta, link"))) element.remove();
  const inline = (node: globalThis.Node): string => {
    if (node.nodeType === 3) return (node.textContent ?? "").replace(/\s+/g, " ");
    if (!(node instanceof Element)) return "";
    const inner = Array.from(node.childNodes).map(inline).join("");
    switch (node.tagName.toLowerCase()) {
      case "strong":
      case "b":
        return inner.trim() ? `**${inner.trim()}**` : "";
      case "em":
      case "i":
        return inner.trim() ? `*${inner.trim()}*` : "";
      case "code":
        return inner ? `\`${inner.replace(/`/g, "")}\`` : "";
      case "a": {
        const href = node.getAttribute("href");
        return href && inner.trim() ? `[${inner.trim().replace(/[[\]]/g, "")}](${safeHref(href).replace(/[()\s]/g, encodeURIComponent)})` : inner;
      }
      case "br":
        return "\n";
      default:
        return inner;
    }
  };
  const blocks: string[] = [];
  const block = (node: globalThis.Node): void => {
    if (node.nodeType === 3) {
      const text = (node.textContent ?? "").trim();
      if (text) blocks.push(text);
      return;
    }
    if (!(node instanceof Element)) return;
    const tag = node.tagName.toLowerCase();
    const heading = /^h([1-6])$/.exec(tag);
    if (heading) {
      blocks.push(`${"#".repeat(Number(heading[1]))} ${inline(node).trim()}`);
      return;
    }
    if (tag === "p") {
      const text = inline(node).trim();
      if (text) blocks.push(text);
      return;
    }
    if (tag === "ul" || tag === "ol") {
      const items = Array.from(node.children).filter((child) => child.tagName.toLowerCase() === "li");
      blocks.push(items.map((item, index) => `${tag === "ol" ? `${index + 1}.` : "-"} ${inline(item).replace(/\n+/g, " ").trim()}`).join("\n"));
      return;
    }
    if (tag === "pre") {
      blocks.push(`\`\`\`\n${(node.textContent ?? "").replace(/\n$/, "")}\n\`\`\``);
      return;
    }
    if (tag === "blockquote") {
      blocks.push(inline(node).trim().split("\n").map((line) => `> ${line}`).join("\n"));
      return;
    }
    if (tag === "hr") {
      blocks.push("---");
      return;
    }
    if (tag === "table") {
      const rows = Array.from(node.querySelectorAll("tr")).map((row) => Array.from(row.children).map((cell) => inline(cell).replace(/\|/g, "\\|").replace(/\n/g, " ").trim()));
      if (rows.length > 0) {
        const width = Math.max(...rows.map((row) => row.length));
        const line = (row: string[]) => `| ${Array.from({ length: width }, (_, index) => row[index] ?? "").join(" | ")} |`;
        blocks.push([line(rows[0]!), `|${Array.from({ length: width }, () => "---").join("|")}|`, ...rows.slice(1).map(line)].join("\n"));
      }
      return;
    }
    if (tag === "img") return;
    const hasBlockChildren = Array.from(node.children).some((child) => /^(p|div|h[1-6]|ul|ol|pre|blockquote|table|hr|section|article)$/i.test(child.tagName));
    if (hasBlockChildren) {
      for (const child of Array.from(node.childNodes)) block(child);
      return;
    }
    const text = inline(node).trim();
    if (text) blocks.push(text);
  };
  for (const child of Array.from(doc.body.childNodes)) block(child);
  return blocks.join("\n\n");
}

/** Build a paste slice from Markdown/Noma text via the Markdown ingest pipeline. */
export function markdownToSlice(markdown: string): Slice | undefined {
  const text = markdown.replace(/\r\n?/g, "\n").trim();
  if (!text) return undefined;
  if (!text.includes("\n") && !BLOCK_SYNTAX_RE.test(text)) {
    const inlineNodes = parseInline(text).map((node) => schema.nodeFromJSON(node));
    return new Slice(Fragment.from(nodes.paragraph!.create(null, inlineNodes)), 1, 1);
  }
  const noma = convertMarkdownToNoma(text);
  const blocks = nomaToEditorDoc(noma).content.filter((node) => node.type !== "frontmatter");
  const pmNodes: PMNode[] = [];
  for (const node of blocks) {
    try {
      pmNodes.push(schema.nodeFromJSON(node));
    } catch {
      continue;
    }
  }
  return pmNodes.length > 0 ? new Slice(Fragment.fromArray(pmNodes), 0, 0) : undefined;
}

function pastePlugin(): Plugin {
  return new Plugin({
    props: {
      handlePaste(view, event) {
        const data = event.clipboardData;
        if (!data) return false;
        const html = data.getData("text/html");
        if (html && html.includes("data-pm-slice")) return false;
        if (view.state.selection.$from.parent.type.spec.code) return false;
        const text = html ? htmlToMarkdown(html) : data.getData("text/plain");
        const slice = markdownToSlice(text);
        if (!slice) return false;
        view.dispatch(view.state.tr.replaceSelection(slice).scrollIntoView());
        return true;
      },
    },
  });
}

// ---------------------------------------------------------------------------
// Node views

const CALLOUT_NAMES = new Set(["callout", "note", "warning", "tip", "info", "important", "caution", "danger", "summary"]);
const SEMANTIC_NAMES = new Set(["claim", "evidence", "counterevidence", "decision", "risk", "requirement", "open_question", "assumption", "result"]);

function attrSummary(raw: string): string {
  return parseDirectiveAttrs(raw)
    .map(([key, value]) => (value === true ? key : `${key}=${String(value)}`))
    .join(" · ");
}

function directiveKind(name: string): "callout" | "semantic" | "chip" | "figure" | "container" {
  if (CALLOUT_NAMES.has(name)) return "callout";
  if (SEMANTIC_NAMES.has(name)) return "semantic";
  if (CHIP_DIRECTIVES.has(name)) return "chip";
  if (name === "figure") return "figure";
  return "container";
}

class AttrEditor {
  readonly dom: HTMLElement;
  private readonly body: HTMLElement;

  constructor(private readonly onApply: (name: string, attrs: string) => void, private readonly readOnlyName = false) {
    this.dom = document.createElement("div");
    this.dom.className = "visual-attr-editor";
    this.dom.contentEditable = "false";
    this.dom.hidden = true;
    this.body = document.createElement("div");
    this.dom.append(this.body);
  }

  open(name: string, raw: string, editable: boolean): void {
    this.dom.hidden = false;
    this.body.textContent = "";
    const rows: Array<{ key: HTMLInputElement; value: HTMLInputElement }> = [];
    const nameInput = document.createElement("input");
    nameInput.value = name;
    nameInput.setAttribute("aria-label", "Block type");
    nameInput.disabled = !editable || this.readOnlyName;
    nameInput.className = "visual-attr-name";
    this.body.append(nameInput);
    const addRow = (key: string, value: string): void => {
      const row = document.createElement("div");
      row.className = "visual-attr-row";
      const keyInput = document.createElement("input");
      keyInput.value = key;
      keyInput.setAttribute("aria-label", "Attribute name");
      keyInput.disabled = !editable;
      const valueInput = document.createElement("input");
      valueInput.value = value;
      valueInput.setAttribute("aria-label", `Value of ${key || "attribute"}`);
      valueInput.disabled = !editable;
      row.append(keyInput, valueInput);
      rows.push({ key: keyInput, value: valueInput });
      this.body.insertBefore(row, actions);
    };
    const actions = document.createElement("div");
    actions.className = "visual-attr-actions";
    this.body.append(actions);
    for (const [key, value] of parseDirectiveAttrs(raw)) addRow(key, value === true ? "" : String(value));
    if (editable) {
      const add = document.createElement("button");
      add.type = "button";
      add.textContent = "Add attribute";
      add.addEventListener("click", () => addRow("", ""));
      const apply = document.createElement("button");
      apply.type = "button";
      apply.textContent = "Apply";
      apply.addEventListener("click", () => {
        const pairs: Array<[string, string | number | boolean]> = [];
        for (const row of rows) {
          const key = row.key.value.trim();
          if (!/^[a-zA-Z_][\w-]*$/.test(key)) continue;
          const value = row.value.value;
          pairs.push([key, value === "" ? true : /^-?\d+(?:\.\d+)?$/.test(value) ? Number(value) : value]);
        }
        this.onApply(nameInput.value.trim(), serializeDirectiveAttrs(pairs));
        this.close();
      });
      actions.append(add, apply);
    }
    const done = document.createElement("button");
    done.type = "button";
    done.textContent = "Close";
    done.addEventListener("click", () => this.close());
    actions.append(done);
  }

  close(): void {
    this.dom.hidden = true;
    this.body.textContent = "";
  }
}

/** Groups where picking a token replaces the group's other tokens (one tone, one size, …). */
const EXCLUSIVE_TOKEN_GROUPS = new Set(["tone", "surface", "size", "align", "spacing", "span"]);

/** Reads `class=` from a directive's raw attrs as a word list. */
export function classWords(raw: string): string[] {
  const value = parseDirectiveAttrs(raw).find(([key]) => key === "class")?.[1];
  return typeof value === "string" ? value.split(/[\s,]+/).filter(Boolean) : [];
}

/** Toggles `token` in `class=`; exclusive groups drop their other tokens. Returns the new raw attrs. */
export function toggleClassToken(raw: string, token: string, group?: readonly string[]): string {
  const words = classWords(raw);
  const next = words.includes(token) ? words.filter((word) => word !== token) : [...words.filter((word) => !group?.includes(word)), token];
  const pairs = parseDirectiveAttrs(raw).filter(([key]) => key !== "class");
  if (next.length > 0) pairs.push(["class", next.join(" ")]);
  return serializeDirectiveAttrs(pairs);
}

/** Chip picker for `class=` style tokens: the core vocabulary plus the space's aliases. Applies on click. */
class TokenPicker {
  readonly dom: HTMLElement;

  constructor(private readonly current: () => string, private readonly onChange: (attrs: string) => void, private readonly aliases: () => Readonly<Record<string, readonly string[]>>) {
    this.dom = document.createElement("div");
    this.dom.className = "visual-token-picker";
    this.dom.contentEditable = "false";
    this.dom.hidden = true;
    this.dom.setAttribute("role", "group");
    this.dom.setAttribute("aria-label", "Style tokens");
  }

  toggle(editable: boolean): void {
    if (this.dom.hidden) this.open(editable);
    else this.close();
  }

  open(editable: boolean): void {
    this.dom.hidden = false;
    this.render(editable);
  }

  close(): void {
    this.dom.hidden = true;
    this.dom.textContent = "";
  }

  private render(editable: boolean): void {
    this.dom.textContent = "";
    const raw = this.current();
    const active = new Set(classWords(raw));
    const known = new Set<string>();
    const addGroup = (label: string, tokens: readonly string[], exclusive: boolean, titles?: Record<string, string>): void => {
      const row = document.createElement("div");
      row.className = "visual-token-group";
      const name = document.createElement("span");
      name.className = "visual-token-group-name";
      name.textContent = label;
      row.append(name);
      for (const token of tokens) {
        known.add(token);
        const chip = document.createElement("button");
        chip.type = "button";
        chip.className = "visual-token-chip";
        chip.dataset.token = token;
        chip.textContent = token;
        chip.setAttribute("aria-pressed", String(active.has(token)));
        if (titles?.[token]) chip.title = titles[token]!;
        chip.disabled = !editable;
        chip.addEventListener("mousedown", (event) => event.preventDefault());
        chip.addEventListener("click", () => {
          this.onChange(toggleClassToken(this.current(), token, exclusive ? tokens : undefined));
          this.render(editable);
        });
        row.append(chip);
      }
      this.dom.append(row);
    };
    const aliases = this.aliases();
    const aliasNames = Object.keys(aliases);
    if (aliasNames.length > 0) {
      addGroup("space", aliasNames, false, Object.fromEntries(aliasNames.map((alias) => [alias, `= ${aliases[alias]!.join(" ")}`])));
    }
    for (const [group, tokens] of Object.entries(STYLE_TOKEN_GROUPS)) addGroup(group, tokens, EXCLUSIVE_TOKEN_GROUPS.has(group));
    const unknown = [...active].filter((word) => !known.has(word));
    if (unknown.length > 0) {
      const row = document.createElement("div");
      row.className = "visual-token-group visual-token-unknown";
      const name = document.createElement("span");
      name.className = "visual-token-group-name";
      name.textContent = "unknown";
      row.append(name);
      for (const word of unknown) {
        const chip = document.createElement("button");
        chip.type = "button";
        chip.className = "visual-token-chip";
        chip.dataset.token = word;
        chip.textContent = `${word} ×`;
        chip.title = "Not a style token here; click to remove";
        chip.disabled = !editable;
        chip.addEventListener("mousedown", (event) => event.preventDefault());
        chip.addEventListener("click", () => {
          this.onChange(toggleClassToken(this.current(), word));
          this.render(editable);
        });
        row.append(chip);
      }
      this.dom.append(row);
    }
  }
}

class DirectiveView implements NodeView {
  dom: HTMLElement;
  contentDOM?: HTMLElement;
  private readonly badge: HTMLElement;
  private readonly summary: HTMLElement;
  private readonly editor: AttrEditor;
  private readonly picker: TokenPicker;
  private readonly styleButton: HTMLButtonElement;

  constructor(private node: PMNode, private readonly view: EditorView, private readonly getPos: () => number | undefined, private readonly hooks: VisualEditorHooks) {
    const name = String(node.attrs.name);
    const kind = directiveKind(name);
    this.dom = document.createElement("div");
    this.dom.className = `nv-directive nv-kind-${kind}`;
    const header = document.createElement("div");
    header.className = "nv-directive-header";
    header.contentEditable = "false";
    this.badge = document.createElement("span");
    this.badge.className = "nv-directive-name";
    this.summary = document.createElement("span");
    this.summary.className = "nv-directive-attrs";
    const edit = document.createElement("button");
    edit.type = "button";
    edit.className = "nv-directive-edit";
    edit.textContent = "Attributes";
    edit.setAttribute("aria-label", `Edit ${name} attributes`);
    edit.addEventListener("mousedown", (event) => event.preventDefault());
    edit.addEventListener("click", () => this.editor.open(String(this.node.attrs.name), String(this.node.attrs.attrs ?? ""), this.hooks.editable()));
    this.styleButton = document.createElement("button");
    this.styleButton.type = "button";
    this.styleButton.className = "nv-directive-edit nv-directive-style";
    this.styleButton.textContent = "Style";
    this.styleButton.setAttribute("aria-label", `Style ${name} block`);
    this.styleButton.setAttribute("aria-expanded", "false");
    this.styleButton.addEventListener("mousedown", (event) => event.preventDefault());
    this.styleButton.addEventListener("click", () => {
      this.editor.close();
      this.picker.toggle(this.hooks.editable());
      this.styleButton.setAttribute("aria-expanded", String(!this.picker.dom.hidden));
    });
    header.append(this.badge, this.summary, this.styleButton, edit);
    this.editor = new AttrEditor((nextName, attrs) => this.apply(nextName, attrs));
    this.picker = new TokenPicker(
      () => String(this.node.attrs.attrs ?? ""),
      (attrs) => this.apply(String(this.node.attrs.name), attrs),
      () => this.hooks.styleTokens?.() ?? {},
    );
    this.dom.append(header, this.editor.dom, this.picker.dom);
    if (kind !== "chip") {
      this.contentDOM = document.createElement("div");
      this.contentDOM.className = "nv-directive-body";
      this.dom.append(this.contentDOM);
    }
    this.render();
  }

  private apply(name: string, attrs: string): void {
    const pos = this.getPos();
    if (pos === undefined || !/^[a-zA-Z_][\w-]*(?:::[a-zA-Z_][\w-]*)*$/.test(name)) return;
    this.view.dispatch(this.view.state.tr.setNodeMarkup(pos, undefined, { ...this.node.attrs, name, attrs }));
  }

  private render(): void {
    const name = String(this.node.attrs.name);
    const attrs = String(this.node.attrs.attrs ?? "");
    const tone = parseDirectiveAttrs(attrs).find(([key]) => key === "tone" || key === "status")?.[1];
    this.dom.dataset.name = name;
    this.dom.dataset.tone = typeof tone === "string" ? tone : "";
    this.badge.textContent = name.replace(/_/g, " ");
    this.summary.textContent = attrSummary(attrs);
  }

  update(node: PMNode): boolean {
    if (node.type !== this.node.type || directiveKind(String(node.attrs.name)) !== directiveKind(String(this.node.attrs.name))) return false;
    this.node = node;
    this.render();
    return true;
  }

  stopEvent(event: Event): boolean {
    return this.editor.dom.contains(event.target as globalThis.Node) || this.picker.dom.contains(event.target as globalThis.Node) || (event.target instanceof HTMLElement && event.target.closest(".nv-directive-header") !== null && event.target.closest(".nv-directive") === this.dom);
  }

  ignoreMutation(mutation: MutationRecord | { type: "selection"; target: globalThis.Node }): boolean {
    if (mutation.type === "selection") return false;
    return !this.contentDOM || !this.contentDOM.contains(mutation.target);
  }
}

class TextDirectiveView implements NodeView {
  dom: HTMLElement;
  contentDOM: HTMLElement;
  private readonly label: HTMLElement;
  private readonly editor: AttrEditor;

  constructor(private node: PMNode, private readonly view: EditorView, private readonly getPos: () => number | undefined, private readonly hooks: VisualEditorHooks) {
    this.dom = document.createElement("div");
    this.dom.className = "nv-text-directive";
    const header = document.createElement("div");
    header.className = "nv-directive-header";
    header.contentEditable = "false";
    this.label = document.createElement("span");
    this.label.className = "nv-directive-name";
    const edit = document.createElement("button");
    edit.type = "button";
    edit.className = "nv-directive-edit";
    edit.textContent = "Attributes";
    edit.setAttribute("aria-label", "Edit block attributes");
    edit.addEventListener("mousedown", (event) => event.preventDefault());
    edit.addEventListener("click", () => this.editor.open(String(this.node.attrs.name), String(this.node.attrs.attrs ?? ""), this.hooks.editable()));
    header.append(this.label, edit);
    this.editor = new AttrEditor((name, attrs) => {
      const pos = this.getPos();
      if (pos === undefined) return;
      this.view.dispatch(this.view.state.tr.setNodeMarkup(pos, undefined, { ...this.node.attrs, name: /^[a-zA-Z_][\w-]*$/.test(name) ? name : this.node.attrs.name, attrs }));
    });
    const pre = document.createElement("pre");
    this.contentDOM = document.createElement("code");
    pre.append(this.contentDOM);
    const note = document.createElement("div");
    note.className = "nv-text-directive-note";
    note.contentEditable = "false";
    note.textContent = "Rendered in Preview";
    this.dom.append(header, this.editor.dom, pre, note);
    this.render();
  }

  private render(): void {
    const name = String(this.node.attrs.name);
    const kind = parseDirectiveAttrs(String(this.node.attrs.attrs ?? "")).find(([key]) => key === "kind")?.[1];
    this.label.textContent = name === "diagram" ? `${typeof kind === "string" ? kind : "diagram"} diagram` : name;
    this.dom.dataset.name = name;
  }

  update(node: PMNode): boolean {
    if (node.type !== this.node.type) return false;
    this.node = node;
    this.render();
    return true;
  }

  stopEvent(event: Event): boolean {
    return this.editor.dom.contains(event.target as globalThis.Node);
  }

  ignoreMutation(mutation: MutationRecord | { type: "selection"; target: globalThis.Node }): boolean {
    if (mutation.type === "selection") return false;
    return !this.contentDOM.contains(mutation.target);
  }
}

class RawView implements NodeView {
  dom: HTMLElement;
  private readonly textarea: HTMLTextAreaElement;
  private readonly title: HTMLElement;
  private timer: number | undefined;

  constructor(private node: PMNode, private readonly view: EditorView, private readonly getPos: () => number | undefined, private readonly hooks: VisualEditorHooks) {
    this.dom = document.createElement("div");
    this.dom.className = node.type.name === "frontmatter" ? "nv-raw nv-frontmatter" : "nv-raw";
    this.dom.contentEditable = "false";
    this.title = document.createElement("div");
    this.title.className = "nv-raw-title";
    this.textarea = document.createElement("textarea");
    this.textarea.spellcheck = false;
    this.textarea.className = "nv-raw-source";
    this.textarea.setAttribute("aria-label", node.type.name === "frontmatter" ? "Page frontmatter" : `Noma source for ${String(node.attrs.label || "block")}`);
    this.textarea.addEventListener("input", () => {
      this.fit();
      if (this.timer !== undefined) window.clearTimeout(this.timer);
      this.timer = window.setTimeout(() => this.commit(), 250);
    });
    this.textarea.addEventListener("blur", () => this.commit());
    this.dom.append(this.title, this.textarea);
    this.render();
  }

  private commit(): void {
    if (this.timer !== undefined) window.clearTimeout(this.timer);
    this.timer = undefined;
    const pos = this.getPos();
    if (pos === undefined || this.textarea.value === this.node.attrs.src) return;
    this.view.dispatch(this.view.state.tr.setNodeMarkup(pos, undefined, { ...this.node.attrs, src: this.textarea.value }));
  }

  private fit(): void {
    this.textarea.rows = Math.min(24, Math.max(2, this.textarea.value.split("\n").length));
  }

  private render(): void {
    this.title.textContent = this.node.type.name === "frontmatter" ? "Frontmatter" : `Noma source · ${String(this.node.attrs.label || "block")}`;
    if (document.activeElement !== this.textarea) this.textarea.value = String(this.node.attrs.src ?? "");
    this.textarea.readOnly = !this.hooks.editable();
    this.fit();
  }

  update(node: PMNode): boolean {
    if (node.type !== this.node.type) return false;
    this.node = node;
    this.render();
    return true;
  }

  stopEvent(): boolean {
    return true;
  }

  ignoreMutation(): boolean {
    return true;
  }

  destroy(): void {
    if (this.timer !== undefined) this.commit();
  }
}

class ListItemView implements NodeView {
  dom: HTMLElement;
  contentDOM: HTMLElement;
  private checkbox?: HTMLInputElement;

  constructor(private node: PMNode, private readonly view: EditorView, private readonly getPos: () => number | undefined, private readonly hooks: VisualEditorHooks) {
    this.dom = document.createElement("li");
    this.contentDOM = document.createElement("span");
    this.contentDOM.className = "nv-li-content";
    this.dom.append(this.contentDOM);
    this.render();
  }

  private render(): void {
    const checked = this.node.attrs.checked;
    this.dom.className = checked === null ? "" : "nv-task";
    if (typeof this.node.attrs.id === "string") this.dom.dataset.id = this.node.attrs.id;
    else delete this.dom.dataset.id;
    if (checked === null) {
      this.checkbox?.remove();
      this.checkbox = undefined;
      return;
    }
    if (!this.checkbox) {
      this.checkbox = document.createElement("input");
      this.checkbox.type = "checkbox";
      this.checkbox.contentEditable = "false";
      this.checkbox.setAttribute("aria-label", "Task done");
      this.checkbox.addEventListener("mousedown", (event) => event.preventDefault());
      this.checkbox.addEventListener("click", (event) => {
        event.preventDefault();
        const pos = this.getPos();
        if (pos === undefined || !this.hooks.editable()) return;
        this.view.dispatch(this.view.state.tr.setNodeMarkup(pos, undefined, { ...this.node.attrs, checked: !this.node.attrs.checked }));
      });
      this.dom.prepend(this.checkbox);
    }
    this.checkbox.checked = checked === true;
    this.checkbox.disabled = !this.hooks.editable();
  }

  update(node: PMNode): boolean {
    if (node.type !== this.node.type) return false;
    this.node = node;
    this.render();
    return true;
  }

  stopEvent(event: Event): boolean {
    return event.target === this.checkbox;
  }

  ignoreMutation(mutation: MutationRecord | { type: "selection"; target: globalThis.Node }): boolean {
    return mutation.type !== "selection" && mutation.target === this.checkbox;
  }
}

class InlineAtomView implements NodeView {
  dom: HTMLElement;

  constructor(private node: PMNode, private readonly view: EditorView, private readonly getPos: () => number | undefined, private readonly hooks: VisualEditorHooks) {
    this.dom = document.createElement("span");
    this.dom.className = node.type.name === "wikilink" ? "nv-wikilink" : "nv-math-inline";
    this.dom.addEventListener("dblclick", () => this.edit());
    this.render();
  }

  private edit(): void {
    const pos = this.getPos();
    if (pos === undefined || !this.hooks.editable()) return;
    const key = this.node.type.name === "wikilink" ? "raw" : "tex";
    const next = window.prompt(this.node.type.name === "wikilink" ? "Link target (id or id|label)" : "TeX", String(this.node.attrs[key] ?? ""));
    if (next === null) return;
    if (!next.trim()) {
      this.view.dispatch(this.view.state.tr.delete(pos, pos + this.node.nodeSize));
      return;
    }
    this.view.dispatch(this.view.state.tr.setNodeMarkup(pos, undefined, { ...this.node.attrs, [key]: next.replace(/[[\]\n]/g, key === "raw" ? "" : "$&") }));
  }

  private render(): void {
    if (this.node.type.name === "wikilink") {
      const raw = String(this.node.attrs.raw ?? "");
      this.dom.textContent = wikilinkLabel(raw);
      this.dom.title = `[[${raw}]]`;
    } else {
      this.dom.textContent = String(this.node.attrs.tex ?? "");
      this.dom.title = "Inline math (double-click to edit)";
    }
  }

  update(node: PMNode): boolean {
    if (node.type !== this.node.type) return false;
    this.node = node;
    this.render();
    return true;
  }
}

/** `@{userId}` shown as an `@Name` chip; the source keeps the stable user ID. */
class MentionView implements NodeView {
  dom: HTMLElement;

  constructor(private node: PMNode) {
    this.dom = document.createElement("span");
    this.dom.className = "nv-mention";
    this.dom.contentEditable = "false";
    this.render();
    const userId = String(node.attrs.userId ?? "");
    if (!knownMentionName(userId)) void resolveMentionNames([userId]).then(() => this.render());
  }

  private render(): void {
    const userId = String(this.node.attrs.userId ?? "");
    this.dom.textContent = `@${knownMentionName(userId) ?? "…"}`;
    this.dom.title = `@{${userId}}`;
  }

  update(node: PMNode): boolean {
    if (node.type !== this.node.type) return false;
    this.node = node;
    this.render();
    return true;
  }
}

export function nomaNodeViews(hooks: VisualEditorHooks): Record<string, NodeViewConstructor> {
  return {
    directive: (node, view, getPos) => new DirectiveView(node, view, getPos, hooks),
    text_directive: (node, view, getPos) => new TextDirectiveView(node, view, getPos, hooks),
    raw: (node, view, getPos) => new RawView(node, view, getPos, hooks),
    frontmatter: (node, view, getPos) => new RawView(node, view, getPos, hooks),
    list_item: (node, view, getPos) => new ListItemView(node, view, getPos, hooks),
    wikilink: (node, view, getPos) => new InlineAtomView(node, view, getPos, hooks),
    math_inline: (node, view, getPos) => new InlineAtomView(node, view, getPos, hooks),
    mention: (node) => new MentionView(node),
  };
}

/** Plugins shared by local and live editing. `history` supplies undo/redo (ProseMirror history or Yjs undo). */
export function nomaEditorPlugins(hooks: VisualEditorHooks, historyPlugins: Plugin[], undo: Command, redo: Command): Plugin[] {
  componentProvider = () => hooks.components?.() ?? new Map();
  return [
    ...historyPlugins,
    slashPlugin(),
    nomaInputRules(),
    nomaKeymap(hooks, undo, redo),
    keymap(baseKeymap),
    pastePlugin(),
    dedupePlugin(hooks),
    toolbarPlugin(),
    tableEditing(),
    dropCursor(),
    gapCursor(),
  ];
}

