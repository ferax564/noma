/** Comment thread rendering (edit/delete/reactions/quotes) and text-range anchors captured from, and highlighted in, the preview. */
import { fetchCloudJson } from "./api.js";
import { previewFrame } from "./dom.js";
import { mentionDisplay } from "./mentions.js";
import { currentPageRole } from "./permissions.js";
import { state } from "./state.js";
import type { CloudComment, CommentAnchor } from "./types.js";
import { actionButton, emptyState, errorMessage, formatDate } from "./util.js";

export interface CommentThreadActions {
  endpoint: () => string;
  reply: (comment: CloudComment) => void;
  toggleResolved: (comment: CloudComment) => void;
  refresh: () => Promise<void>;
  status: (message: string, kind: "ok" | "error") => void;
}

const defaultReactions = ["👍", "👎", "😄", "🎉", "😕", "❤️", "🚀", "👀"];
const quoteStatus = requireElement<HTMLElement>("commentQuoteStatus");
const clearQuoteButton = requireElement<HTMLButtonElement>("commentQuoteClearButton");
let pendingAnchor: CommentAnchor | undefined;
let selectionCandidate: CommentAnchor | undefined;

clearQuoteButton.addEventListener("click", () => {
  pendingAnchor = undefined;
  renderQuoteStatus();
});

/** The quote the next top-level comment will be anchored to (consumed on read). */
export function takePendingAnchor(): CommentAnchor | undefined {
  const anchor = pendingAnchor;
  pendingAnchor = undefined;
  renderQuoteStatus();
  return anchor;
}

export function renderCommentThread(container: HTMLElement, comments: CloudComment[], actions: CommentThreadActions): void {
  container.textContent = "";
  if (!state.currentPage) {
    container.append(emptyState("Select a page"));
    return;
  }
  if (comments.length === 0) {
    container.append(emptyState("No comments"));
    return;
  }
  for (const comment of comments) container.append(commentRow(comment, actions));
}

function commentRow(comment: CloudComment, actions: CommentThreadActions): HTMLElement {
  const row = document.createElement("div");
  row.className = `collaboration-row comment-row${comment.parentId ? " comment-reply" : ""}${comment.deleted ? " comment-deleted" : ""}`;
  row.dataset.commentId = comment.id;
  const copy = document.createElement("div");
  copy.className = "collaboration-copy";
  const title = document.createElement("strong");
  title.textContent = `${comment.parentId ? "↳ " : ""}${comment.deleted ? "Deleted comment" : comment.createdByName}${comment.resolvedAt ? " · resolved" : ""}`;
  copy.append(title);
  if (comment.anchor && !comment.deleted) {
    const quote = document.createElement("blockquote");
    quote.className = `comment-quote${comment.outdated ? " comment-quote-outdated" : ""}`;
    quote.textContent = `“${comment.anchor.quote}”`;
    if (comment.outdated) {
      const badge = document.createElement("span");
      badge.className = "meta-badge comment-outdated-badge";
      badge.textContent = "outdated";
      badge.title = "The quoted text is no longer on the page";
      quote.append(" ", badge);
    } else {
      quote.tabIndex = 0;
      quote.title = "Show in preview";
      quote.addEventListener("click", () => focusHighlight(comment.id));
    }
    copy.append(quote);
  }
  const body = document.createElement("span");
  body.className = "comment-body";
  body.textContent = comment.deleted ? "This comment was deleted." : mentionDisplay(comment.body, comment.mentions);
  const meta = document.createElement("span");
  meta.className = "history-meta";
  const target = [comment.blockId ? `#${comment.blockId}` : undefined, comment.line ? `line ${comment.line}` : undefined].filter(Boolean).join(" · ");
  meta.textContent = `${target ? `${target} · ` : ""}${formatDate(comment.createdAt)}${comment.editedAt && !comment.deleted ? " · edited" : ""}`;
  if (comment.editedAt && !comment.deleted) meta.title = `Edited ${formatDate(comment.editedAt)}`;
  copy.append(body, meta);
  row.append(copy);
  if (comment.deleted) return row;

  const reactions = document.createElement("div");
  reactions.className = "comment-reactions";
  for (const reaction of comment.reactions ?? []) {
    const button = actionButton(`${reaction.emoji} ${reaction.count}`, () => void react(comment, reaction.emoji, reaction.reacted, actions), false, `${reaction.reacted ? "Remove" : "Add"} ${reaction.emoji} reaction (${reaction.users.join(", ")})`);
    button.className = `comment-reaction${reaction.reacted ? " comment-reaction-active" : ""}`;
    button.setAttribute("aria-pressed", String(reaction.reacted));
    reactions.append(button);
  }
  const picker = document.createElement("details");
  picker.className = "comment-reaction-picker";
  const summary = document.createElement("summary");
  summary.textContent = "React";
  summary.setAttribute("aria-label", "Add a reaction");
  picker.append(summary);
  for (const emoji of defaultReactions) {
    const button = actionButton(emoji, () => {
      picker.open = false;
      void react(comment, emoji, Boolean(comment.reactions?.some((item) => item.emoji === emoji && item.reacted)), actions);
    }, false, `React with ${emoji}`);
    button.className = "comment-reaction-choice";
    picker.append(button);
  }
  reactions.append(picker);
  row.append(reactions);

  const buttons = document.createElement("div");
  buttons.className = "collaboration-actions";
  const own = comment.createdBy === state.cloudUser?.id;
  buttons.append(actionButton("Reply", () => actions.reply(comment)));
  if (own || currentPageRole() !== "viewer") buttons.append(actionButton(comment.resolvedAt ? "Reopen" : "Resolve", () => actions.toggleResolved(comment)));
  if (own) buttons.append(actionButton("Edit", () => void editComment(comment, actions), false, "Edit comment"));
  if (own || currentPageRole() === "owner") buttons.append(actionButton("Delete", () => void deleteComment(comment, actions), false, "Delete comment"));
  row.append(buttons);
  return row;
}

async function react(comment: CloudComment, emoji: string, active: boolean, actions: CommentThreadActions): Promise<void> {
  const url = `${actions.endpoint()}/comments/${encodeURIComponent(comment.id)}/reactions`;
  try {
    if (active) await fetchCloudJson(`${url}/${encodeURIComponent(emoji)}`, { method: "DELETE" });
    else await fetchCloudJson(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ emoji }) });
    await actions.refresh();
  } catch (error) {
    actions.status(errorMessage(error), "error");
  }
}

async function editComment(comment: CloudComment, actions: CommentThreadActions): Promise<void> {
  const body = window.prompt("Edit comment", comment.body)?.trim();
  if (!body || body === comment.body) return;
  try {
    await fetchCloudJson(`${actions.endpoint()}/comments/${encodeURIComponent(comment.id)}`, {
      method: "PATCH",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ body }),
    });
    actions.status("Comment updated", "ok");
    await actions.refresh();
  } catch (error) {
    actions.status(errorMessage(error), "error");
  }
}

async function deleteComment(comment: CloudComment, actions: CommentThreadActions): Promise<void> {
  if (!window.confirm("Delete this comment? Replies stay in the thread.")) return;
  try {
    await fetchCloudJson(`${actions.endpoint()}/comments/${encodeURIComponent(comment.id)}`, { method: "DELETE" });
    actions.status("Comment deleted", "ok");
    await actions.refresh();
  } catch (error) {
    actions.status(errorMessage(error), "error");
  }
}

/** Tracks text selections in the preview so a new comment can quote them. */
export function installCommentSelectionCapture(previewDoc: Document | null): void {
  if (!previewDoc?.body) return;
  const capture = (): void => {
    selectionCandidate = anchorFromSelection(previewDoc);
    if (selectionCandidate) {
      pendingAnchor = selectionCandidate;
      renderQuoteStatus();
    }
  };
  previewDoc.addEventListener("mouseup", capture);
  previewDoc.addEventListener("keyup", (event) => {
    if (event.shiftKey || event.key.startsWith("Arrow")) capture();
  });
  highlightCommentAnchors(previewDoc, state.comments);
}

function anchorFromSelection(previewDoc: Document): CommentAnchor | undefined {
  const selection = previewDoc.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return undefined;
  const quote = selection.toString().replace(/\s+/g, " ").trim();
  if (!quote || quote.length > 500) return undefined;
  const range = selection.getRangeAt(0);
  const block = anchorBlockElement(range.commonAncestorContainer);
  if (!block) return undefined;
  const text = block.textContent ?? "";
  const before = previewDoc.createRange();
  before.selectNodeContents(block);
  before.setEnd(range.startContainer, range.startOffset);
  const start = before.toString().length;
  const prefix = text.slice(Math.max(0, start - 32), start).replace(/\s+/g, " ");
  const end = start + range.toString().length;
  const suffix = text.slice(end, end + 32).replace(/\s+/g, " ");
  return { blockId: block.id, quote, ...(prefix.trim() ? { prefix } : {}), ...(suffix.trim() ? { suffix } : {}) };
}

function anchorBlockElement(node: Node): HTMLElement | undefined {
  let element: HTMLElement | null = node instanceof HTMLElement ? node : node.parentElement;
  while (element && !element.classList.contains("noma-document")) {
    if (element.id && !element.classList.contains("noma-alias")) return element;
    element = element.parentElement;
  }
  return undefined;
}

/** Wraps each current (non-outdated) quoted range in a `<mark>` inside its block. */
export function highlightCommentAnchors(previewDoc: Document | null = previewFrame.contentDocument, comments: CloudComment[] = state.comments): void {
  if (!previewDoc?.body) return;
  if (!previewDoc.getElementById("noma-comment-highlight-style")) {
    const style = previewDoc.createElement("style");
    style.id = "noma-comment-highlight-style";
    style.textContent = "mark.noma-comment-highlight{background:#fdf1c7;border-bottom:2px solid #d9a21b;color:inherit;border-radius:2px}mark.noma-comment-highlight.noma-comment-focus{background:#f9dc7a}";
    previewDoc.head.append(style);
  }
  for (const mark of [...previewDoc.querySelectorAll("mark.noma-comment-highlight")]) mark.replaceWith(...mark.childNodes);
  previewDoc.body.normalize();
  for (const comment of comments) {
    if (!comment.anchor || comment.deleted || comment.outdated || comment.resolvedAt) continue;
    const block = previewDoc.getElementById(comment.anchor.blockId);
    if (block) wrapQuote(previewDoc, block, comment);
  }
}

function wrapQuote(previewDoc: Document, block: HTMLElement, comment: CloudComment): void {
  const anchor = comment.anchor!;
  const walker = previewDoc.createTreeWalker(block, NodeFilter.SHOW_TEXT);
  const nodes: Array<{ node: Text; start: number }> = [];
  let flat = "";
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node as Text;
    nodes.push({ node: text, start: flat.length });
    flat += text.data;
  }
  let normalized = "";
  const origin: number[] = [];
  for (let index = 0; index < flat.length; index++) {
    const char = flat[index]!;
    if (/\s/.test(char)) {
      if (normalized.endsWith(" ")) continue;
      normalized += " ";
    } else {
      normalized += char;
    }
    origin.push(index);
  }
  const needle = anchor.quote;
  let found = -1;
  for (let index = normalized.indexOf(needle); index >= 0; index = normalized.indexOf(needle, index + 1)) {
    const prefixOk = !anchor.prefix || normalized.slice(0, index).endsWith(anchor.prefix);
    const suffixOk = !anchor.suffix || normalized.slice(index + needle.length).startsWith(anchor.suffix);
    if (found < 0) found = index;
    if (prefixOk && suffixOk) {
      found = index;
      break;
    }
  }
  if (found < 0) return;
  const best = origin[found]!;
  const end = origin[found + needle.length - 1]! + 1;
  for (const { node, start } of nodes) {
    const nodeEnd = start + node.data.length;
    if (nodeEnd <= best || start >= end) continue;
    const from = Math.max(0, best - start);
    const to = Math.min(node.data.length, end - start);
    const range = previewDoc.createRange();
    range.setStart(node, from);
    range.setEnd(node, to);
    const mark = previewDoc.createElement("mark");
    mark.className = "noma-comment-highlight";
    mark.dataset.commentId = comment.id;
    mark.title = `${comment.createdByName}: ${comment.body.slice(0, 120)}`;
    range.surroundContents(mark);
  }
}

function focusHighlight(commentId: string): void {
  const previewDoc = previewFrame.contentDocument;
  const marks = previewDoc ? [...previewDoc.querySelectorAll<HTMLElement>(`mark.noma-comment-highlight[data-comment-id="${CSS.escape(commentId)}"]`)] : [];
  for (const mark of previewDoc?.querySelectorAll(".noma-comment-focus") ?? []) mark.classList.remove("noma-comment-focus");
  for (const mark of marks) mark.classList.add("noma-comment-focus");
  marks[0]?.scrollIntoView({ block: "center", behavior: "smooth" });
}

function renderQuoteStatus(): void {
  quoteStatus.textContent = pendingAnchor ? `Quoting “${pendingAnchor.quote.slice(0, 80)}${pendingAnchor.quote.length > 80 ? "…" : ""}” in #${pendingAnchor.blockId}` : "Select text in the preview to quote it";
  clearQuoteButton.hidden = !pendingAnchor;
}

function requireElement<T extends HTMLElement>(id: string): T {
  const element = document.getElementById(id);
  if (!element) throw new Error(`Missing #${id}`);
  return element as T;
}
