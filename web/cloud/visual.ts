/**
 * Visual mode: a WYSIWYG block editor over the page's `.noma` source.
 *
 * `#sourceInput` stays the single local source of truth. Visual edits are
 * written back with `editorDocToNoma`, which copies untouched blocks
 * byte-for-byte; source changes are projected into the editor block by block.
 * When the page is clean and the Cloud socket is reachable, the editor joins
 * the page's live Yjs room (co-editing, presence, cursors); typing in the raw
 * source pauses live editing until the draft is saved.
 */
import { history, redo, undo } from "@tiptap/pm/history";
import { Fragment, Node as PMNode } from "@tiptap/pm/model";
import { EditorState, type Plugin } from "@tiptap/pm/state";
import { EditorView } from "@tiptap/pm/view";
import { yXmlFragmentToProseMirrorRootNode } from "y-prosemirror";
import { editorBlockKey, editorDocToNoma, editorIdBackfill, type EditorNode, lcsPairs, nomaToEditorDoc } from "../../src/editor-model.js";
import { sourceInput, visualEditorMount, visualLiveBadge, visualPresence, visualViewButton } from "./dom.js";
import { clearLocalDraft, persistLocalDraft } from "./drafts.js";
import { markDirty, saveCurrentPage, scheduleRender, syncTitleFromSource } from "./editor.js";
import { refreshHistory } from "./history.js";
import { renderChrome } from "./layout.js";
import { replacePage } from "./navigation.js";
import { canEditPage } from "./permissions.js";
import { shareToken, state } from "./state.js";
import { setCloudStatus } from "./util.js";
import { LiveSession, type LiveInit, type LivePresence, type LiveSaved } from "./visual-collab.js";
import { nomaEditorPlugins, nomaNodeViews, type VisualEditorHooks } from "./visual-editor.js";
import { visualSchema } from "./visual-schema.js";

const SOURCE_SYNC = "noma-source-sync";

let view: EditorView | undefined;
let viewPageId: string | undefined;
let viewMode: "local" | "live" = "local";
let lastDerived = "";
let deriveTimer: number | undefined;
let live: LiveSession | undefined;
let detachedForSource = false;
let retryAt = 0;
let retryDelay = 2_000;
let presence: LivePresence[] = [];
let lastEditable: boolean | undefined;

const hooks: VisualEditorHooks = {
  isRemote: (tr) => Boolean(live?.isRemote(tr)),
  save: () => void saveCurrentPage(),
  editable: () => isEditable(),
  styleTokens: () => state.currentPage?.styleTokens ?? {},
};

function isEditable(): boolean {
  if (!state.currentPage) return false;
  if (viewMode === "live") return Boolean(live?.ready && !live.readOnly);
  return canEditPage();
}

function docFromSource(source: string): PMNode {
  try {
    return PMNode.fromJSON(visualSchema, nomaToEditorDoc(source));
  } catch {
    return visualSchema.node("doc", null, [visualSchema.node("raw", { src: source, label: "page" })]);
  }
}

function createView(editorState: EditorState): void {
  view?.destroy();
  view = undefined;
  lastEditable = undefined;
  view = new EditorView(visualEditorMount, {
    state: editorState,
    nodeViews: nomaNodeViews(hooks),
    editable: () => isEditable(),
    attributes: { class: "visual-editor-surface", "aria-label": "Visual page editor", role: "textbox", "aria-multiline": "true" },
    dispatchTransaction(this: EditorView, tr) {
      if (this.isDestroyed) return;
      this.updateState(this.state.apply(tr));
      if (this === view && tr.docChanged && !tr.getMeta(SOURCE_SYNC)) scheduleDerive();
    },
  });
}

function localState(source: string): EditorState {
  return EditorState.create({
    schema: visualSchema,
    doc: docFromSource(source),
    plugins: nomaEditorPlugins(hooks, [history()], undo, redo),
  });
}

function buildLocalView(): void {
  viewMode = "local";
  viewPageId = state.currentPage?.id;
  lastDerived = sourceInput.value;
  createView(localState(sourceInput.value));
}

function scheduleDerive(): void {
  if (deriveTimer !== undefined) window.clearTimeout(deriveTimer);
  deriveTimer = window.setTimeout(() => {
    deriveTimer = undefined;
    deriveSource();
  }, 120);
}

/** Write the editor document back to `#sourceInput`, preserving untouched blocks byte-for-byte. */
export function deriveSource(): void {
  if (!view || !state.currentPage || viewPageId !== state.currentPage.id) return;
  const json = view.state.doc.toJSON() as EditorNode;
  const base = sourceInput.value;
  const next = editorDocToNoma(json, base);
  lastDerived = next;
  if (next !== base) {
    sourceInput.value = next;
    if (viewMode === "live") {
      state.currentPage = { ...state.currentPage, source: next };
      state.dirty = false;
      clearLocalDraft(state.currentPage.id);
      renderChrome();
    } else {
      markDirty();
    }
    syncTitleFromSource();
    scheduleRender();
  }
  if (viewMode === "local") {
    const patches = editorIdBackfill(json, next);
    if (patches.length > 0) {
      let tr = view.state.tr;
      for (const patch of patches) {
        const target = nodeAtPath(view.state.doc, patch.path);
        if (target) tr = tr.setNodeMarkup(target.pos, undefined, patch.attrs);
      }
      view.dispatch(tr.setMeta(SOURCE_SYNC, true).setMeta("addToHistory", false));
    }
  }
}

function nodeAtPath(doc: PMNode, path: number[]): { pos: number; node: PMNode } | undefined {
  let parent = doc;
  let pos = 0;
  let found: PMNode | undefined;
  for (const [depth, index] of path.entries()) {
    if (index >= parent.childCount) return undefined;
    let offset = depth === 0 ? 0 : pos + 1;
    for (let i = 0; i < index; i++) offset += parent.child(i).nodeSize;
    pos = offset;
    found = parent.child(index);
    parent = found;
  }
  return found ? { pos, node: found } : undefined;
}

/** Project a source change into the editor, replacing only the top-level blocks that changed. */
function applySourceToView(source: string, fromLive: boolean): void {
  if (!view) return;
  const target = nomaToEditorDoc(source).content;
  const current: EditorNode[] = [];
  view.state.doc.forEach((node) => current.push(node.toJSON() as EditorNode));
  const pairs = lcsPairs(current.map(editorBlockKey), target.map(editorBlockKey));
  const offsets: number[] = [];
  let offset = 0;
  view.state.doc.forEach((node) => {
    offsets.push(offset);
    offset += node.nodeSize;
  });
  offsets.push(offset);
  let tr = view.state.tr;
  const hunks: Array<{ c0: number; c1: number; t0: number; t1: number }> = [];
  let pc = 0;
  let pt = 0;
  for (const [c, t] of [...pairs, [current.length, target.length] as [number, number]]) {
    if (c > pc || t > pt) hunks.push({ c0: pc, c1: c, t0: pt, t1: t });
    pc = c + 1;
    pt = t + 1;
  }
  try {
    for (const hunk of hunks.reverse()) {
      const nodes = target.slice(hunk.t0, hunk.t1).map((node) => PMNode.fromJSON(visualSchema, node));
      tr = tr.replaceWith(offsets[hunk.c0]!, offsets[hunk.c1]!, Fragment.fromArray(nodes));
    }
  } catch {
    tr = view.state.tr.replaceWith(0, view.state.doc.content.size, docFromSource(source).content);
  }
  lastDerived = source;
  if (!tr.docChanged) return;
  if (!fromLive) tr.setMeta(SOURCE_SYNC, true);
  view.dispatch(tr.setMeta("addToHistory", false));
}

/** Called after every render of `#sourceInput`: keeps the visual editor in step with the source. */
export function syncVisualEditor(): void {
  if (state.currentPage?.id !== viewPageId) {
    stopLive();
    detachedForSource = false;
    retryDelay = 2_000;
    retryAt = 0;
    if (view) buildLocalView();
    else viewPageId = state.currentPage?.id;
    return;
  }
  if (!view || sourceInput.value === lastDerived) return;
  if (viewMode === "live") {
    if (sourceInput.value === state.savedPageSource) return;
    applySourceToView(sourceInput.value, true);
    state.dirty = false;
    if (state.currentPage) clearLocalDraft(state.currentPage.id);
    return;
  }
  applySourceToView(sourceInput.value, false);
}

/** The raw source was typed into directly: a raw-source draft is saved the classic way, so leave the live room. */
export function visualSourceTyped(): void {
  if (viewMode !== "live" && !live) return;
  detachedForSource = true;
  stopLive();
  if (view) buildLocalView();
  setCloudStatus("Live editing paused while you edit the raw source; save to rejoin", "warning");
}

function liveEligible(): boolean {
  return Boolean(
    state.viewMode === "visual" &&
      state.currentPage &&
      state.cloudAvailable &&
      (state.cloudUser || shareToken) &&
      !state.dirty &&
      !detachedForSource &&
      typeof WebSocket !== "undefined" &&
      sourceInput.value === state.savedPageSource,
  );
}

function startLive(): void {
  const page = state.currentPage;
  if (!page) return;
  const pageId = page.id;
  const session = new LiveSession(pageId, { share: shareToken }, {
    ready: (ready, init) => {
      if (live !== ready || state.currentPage?.id !== pageId) return;
      becomeLive(ready, init);
    },
    saved: (saved) => {
      if (live === session) applySaved(saved);
    },
    presence: (next) => {
      if (live !== session) return;
      presence = next;
      renderPresence();
    },
    role: () => {
      if (live !== session) return;
      renderVisualChrome();
    },
    error: (message) => {
      if (live === session) setCloudStatus(message, "error");
    },
    closed: (reason, retry) => {
      if (live !== session) return;
      live = undefined;
      presence = [];
      retryAt = Date.now() + (retry ? retryDelay : 60_000);
      retryDelay = Math.min(30_000, retryDelay * 2);
      if (viewMode === "live") {
        buildLocalView();
        if (sourceInput.value !== state.savedPageSource) {
          state.dirty = true;
          persistLocalDraft();
        }
        setCloudStatus(`${reason}. Visual editing continues on this device; save to keep changes.`, "warning");
      }
      renderPresence();
      renderLiveBadge();
      window.setTimeout(() => renderVisualChrome(), Math.max(0, retryAt - Date.now()) + 10);
    },
  });
  live = session;
  renderLiveBadge();
}

function becomeLive(session: LiveSession, init: LiveInit): void {
  if (!state.currentPage) return;
  retryDelay = 2_000;
  if (init.hash !== state.currentPage.hash) applySaved(init);
  viewMode = "live";
  viewPageId = state.currentPage.id;
  const plugins: Plugin[] = [...session.plugins(), ...nomaEditorPlugins(hooks, [], session.undo, session.redo)];
  createView(EditorState.create({ schema: visualSchema, doc: yXmlFragmentToProseMirrorRootNode(session.fragment, visualSchema), plugins }));
  lastDerived = "";
  deriveSource();
  renderLiveBadge();
  renderPresence();
}

function applySaved(saved: LiveSaved): void {
  if (!state.currentPage) return;
  const updated = { ...state.currentPage, hash: saved.hash, title: saved.title, updatedAt: saved.updatedAt, source: sourceInput.value };
  state.currentPage = updated;
  state.savedPageSource = saved.source;
  state.savedPageHash = saved.hash;
  state.savedPageTitle = saved.title;
  replacePage({ ...updated, source: saved.source });
  if (viewMode === "live") state.dirty = false;
  renderChrome();
  void refreshHistory({ silent: true });
}

function stopLive(): void {
  if (!live) return;
  const session = live;
  live = undefined;
  session.close();
  presence = [];
  renderPresence();
  renderLiveBadge();
  if (viewMode === "live") viewMode = "local";
}

function renderPresence(): void {
  visualPresence.textContent = "";
  const seen = new Set<string>();
  for (const person of presence) {
    const key = person.userId ?? `client:${person.clientId}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const avatar = document.createElement("span");
    avatar.className = "visual-avatar";
    avatar.style.backgroundColor = person.color;
    const self = person.userId !== null && person.userId === state.cloudUser?.id;
    avatar.textContent = person.name.split(/\s+/).map((part) => part[0] ?? "").join("").slice(0, 2).toUpperCase() || "?";
    avatar.title = `${person.name}${self ? " (you)" : ""} · ${person.readOnly ? "viewing" : "editing"}`;
    avatar.setAttribute("aria-label", avatar.title);
    avatar.setAttribute("role", "img");
    visualPresence.append(avatar);
  }
  visualPresence.hidden = presence.length === 0;
}

function renderLiveBadge(): void {
  const connected = viewMode === "live" && live?.ready;
  visualLiveBadge.hidden = state.viewMode !== "visual" || !state.currentPage;
  visualLiveBadge.textContent = connected ? (live?.readOnly ? "live · read-only" : "live") : live ? "connecting" : "local";
  visualLiveBadge.dataset.state = connected ? "ok" : live ? "warning" : "";
}

/** Called from `renderChrome`: mounts the editor in Visual mode, and joins or leaves the live room. */
export function renderVisualChrome(): void {
  visualViewButton.setAttribute("aria-pressed", String(state.viewMode === "visual"));
  if (state.viewMode !== "visual") {
    if (live) {
      stopLive();
      if (view) buildLocalView();
    }
    renderLiveBadge();
    return;
  }
  if (!view || (viewMode === "local" && viewPageId !== state.currentPage?.id)) buildLocalView();
  if (!state.dirty && detachedForSource && sourceInput.value === state.savedPageSource) detachedForSource = false;
  if (!live && liveEligible() && Date.now() >= retryAt) startLive();
  const editable = isEditable();
  if (view && editable !== lastEditable) {
    lastEditable = editable;
    view.setProps({ editable: () => isEditable() });
  }
  renderLiveBadge();
}

/** Test/automation hook: the current live-session status. */
export function visualStatus(): { mode: "local" | "live"; connected: boolean; unacked: number; presence: number } {
  return { mode: viewMode, connected: Boolean(live?.ready), unacked: live?.unacked ?? 0, presence: presence.length };
}

/** Test/automation hook: the editor view, when mounted. */
export function visualView(): EditorView | undefined {
  return view;
}
