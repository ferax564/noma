/**
 * Yjs codec for the visual-editor model. Reads and writes the same
 * `Y.XmlFragment` layout that y-prosemirror produces in the browser (one
 * `Y.XmlElement` per node, attrs as element attributes, text runs as
 * `Y.XmlText` with mark attributes), so the Cloud relay can checkpoint a live
 * document to `.noma` and merge external source changes into it without a DOM
 * or a ProseMirror dependency on the server.
 */
import * as Y from "yjs";
import {
  canonicalEditorDoc,
  canonicalEditorNode,
  EDITOR_MARK_SPECS,
  EDITOR_NODE_SPECS,
  editorBlockKey,
  type EditorAttrPatch,
  type EditorAttrs,
  type EditorAttrValue,
  type EditorDoc,
  type EditorMark,
  type EditorNode,
  nomaToEditorDoc,
  planBlockMerge,
} from "./editor-model.js";

/** Name of the shared XmlFragment every Noma visual-editor document binds to. */
export const EDITOR_YJS_FRAGMENT = "noma";

const MAX_DEPTH = 64;

export function editorFragment(doc: Y.Doc): Y.XmlFragment {
  return doc.getXmlFragment(EDITOR_YJS_FRAGMENT);
}

/** Decode a Yjs fragment into canonical editor JSON. Unknown node types are dropped. */
export function yFragmentToEditorDoc(fragment: Y.XmlFragment): EditorDoc {
  return canonicalEditorDoc({ type: "doc", content: yChildren(fragment, 0) });
}

function yChildren(parent: Y.XmlFragment | Y.XmlElement, depth: number): EditorNode[] {
  if (depth > MAX_DEPTH) return [];
  const out: EditorNode[] = [];
  for (const child of parent.toArray()) {
    if (child instanceof Y.XmlElement) {
      const node = yElementToNode(child, depth + 1);
      if (node) out.push(node);
    } else if (child instanceof Y.XmlText) {
      out.push(...yTextToNodes(child));
    }
  }
  return out;
}

function yElementToNode(element: Y.XmlElement, depth: number): EditorNode | undefined {
  const spec = EDITOR_NODE_SPECS[element.nodeName];
  if (!spec || element.nodeName === "doc" || element.nodeName === "text") return undefined;
  const raw = element.getAttributes() as Record<string, unknown>;
  const attrs: EditorAttrs = {};
  for (const key of Object.keys(spec.attrs)) {
    const value = raw[key];
    if (value === undefined) continue;
    attrs[key] = attrValue(value);
  }
  const node: EditorNode = { type: element.nodeName, attrs };
  const content = yChildren(element, depth);
  if (content.length > 0) node.content = content;
  return node;
}

function attrValue(value: unknown): EditorAttrValue {
  if (value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  return JSON.stringify(value);
}

function yTextToNodes(text: Y.XmlText): EditorNode[] {
  const out: EditorNode[] = [];
  const delta = text.toDelta() as Array<{ insert?: unknown; attributes?: Record<string, unknown> }>;
  for (const op of delta) {
    if (typeof op.insert !== "string" || op.insert === "") continue;
    const marks: EditorMark[] = [];
    for (const [rawName, rawAttrs] of Object.entries(op.attributes ?? {})) {
      const name = rawName.split("--")[0] ?? rawName;
      if (!EDITOR_MARK_SPECS[name]) continue;
      const attrs: EditorAttrs = {};
      if (rawAttrs && typeof rawAttrs === "object") {
        for (const [key, value] of Object.entries(rawAttrs as Record<string, unknown>)) attrs[key] = attrValue(value);
      }
      marks.push({ type: name, attrs });
    }
    out.push(marks.length > 0 ? { type: "text", text: op.insert, marks } : { type: "text", text: op.insert });
  }
  return out;
}

/** Build the Yjs representation of one editor block (mirrors y-prosemirror's encoding). */
export function editorNodeToYElement(node: EditorNode): Y.XmlElement {
  const canonical = canonicalEditorNode(node);
  const element = new Y.XmlElement(canonical.type);
  for (const [key, value] of Object.entries(canonical.attrs ?? {})) {
    if (value !== null) element.setAttribute(key, value as string);
  }
  const children: Array<Y.XmlElement | Y.XmlText> = [];
  let run: EditorNode[] = [];
  const flush = (): void => {
    if (run.length === 0) return;
    const text = new Y.XmlText();
    text.applyDelta(run.map((item) => ({ insert: item.text ?? "", attributes: markAttributes(item.marks) })));
    children.push(text);
    run = [];
  };
  for (const child of canonical.content ?? []) {
    if (child.type === "text") {
      run.push(child);
      continue;
    }
    flush();
    children.push(editorNodeToYElement(child));
  }
  flush();
  if (children.length > 0) element.insert(0, children);
  return element;
}

function markAttributes(marks: EditorMark[] | undefined): Record<string, EditorAttrs> {
  const out: Record<string, EditorAttrs> = {};
  for (const mark of marks ?? []) out[mark.type] = mark.attrs ?? {};
  return out;
}

/** Replace the whole fragment with `doc` (used to seed a new room from source). */
export function replaceYFragment(fragment: Y.XmlFragment, doc: EditorDoc): void {
  if (fragment.length > 0) fragment.delete(0, fragment.length);
  fragment.insert(0, canonicalEditorDoc(doc).content.map(editorNodeToYElement));
}

/** Seed a fresh Y.Doc from `.noma` source. */
export function yDocFromNoma(source: string): Y.Doc {
  const doc = new Y.Doc();
  doc.transact(() => replaceYFragment(editorFragment(doc), nomaToEditorDoc(source)), "server");
  return doc;
}

export interface YMergeResult {
  inserted: number;
  deleted: number;
}

/**
 * Merge an external source change into a live fragment at block granularity:
 * `baseSource` is what the fragment was last reconciled with, `theirsSource`
 * the newly written source. Live edits made since `baseSource` survive.
 */
export function mergeSourceIntoYFragment(fragment: Y.XmlFragment, baseSource: string, theirsSource: string): YMergeResult {
  const base = nomaToEditorDoc(baseSource).content.map(editorBlockKey);
  const theirsDoc = nomaToEditorDoc(theirsSource).content;
  const theirs = theirsDoc.map(editorBlockKey);
  const currentNodes = yFragmentToEditorDoc(fragment).content;
  const elements = fragment.toArray();
  const current = elements.length === currentNodes.length ? currentNodes.map(editorBlockKey) : undefined;
  if (!current) {
    replaceYFragment(fragment, { type: "doc", content: theirsDoc });
    return { inserted: theirsDoc.length, deleted: elements.length };
  }
  const steps = planBlockMerge(base, theirs, current);
  const kept = new Set(steps.filter((step) => step.kind === "keep").map((step) => step.index));
  let deleted = 0;
  for (let index = current.length - 1; index >= 0; index--) {
    if (kept.has(index)) continue;
    fragment.delete(index, 1);
    deleted++;
  }
  let position = 0;
  let inserted = 0;
  for (const step of steps) {
    if (step.kind === "keep") {
      position++;
      continue;
    }
    fragment.insert(position, [editorNodeToYElement(theirsDoc[step.index]!)]);
    position++;
    inserted++;
  }
  if (fragment.length === 0) fragment.insert(0, [editorNodeToYElement({ type: "paragraph" })]);
  return { inserted, deleted };
}

/** Apply attr patches (see `editorIdBackfill`) to the fragment. Returns how many applied. */
export function applyYAttrPatches(fragment: Y.XmlFragment, patches: EditorAttrPatch[]): number {
  let applied = 0;
  for (const patch of patches) {
    let target: Y.XmlFragment | Y.XmlElement = fragment;
    let ok = true;
    for (const index of patch.path) {
      const child: unknown = target.get(index);
      if (!(child instanceof Y.XmlElement)) {
        ok = false;
        break;
      }
      target = child;
    }
    if (!ok || !(target instanceof Y.XmlElement)) continue;
    for (const [key, value] of Object.entries(patch.attrs)) {
      if (value === null) continue;
      if (target.getAttribute(key) !== value) target.setAttribute(key, value as string);
    }
    applied++;
  }
  return applied;
}
