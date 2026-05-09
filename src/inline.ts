/**
 * Tiny inline markup parser. Operates on plain text and emits HTML.
 * Order matters: handle code spans first so emphasis inside `code` stays raw.
 */
export function inlineToHtml(src: string): string {
  let text = escapeHtml(src);

  text = text.replace(/`([^`]+)`/g, (_m, body) => `<code>${body}</code>`);
  text = text.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  text = text.replace(/\*([^*]+)\*/g, "<em>$1</em>");
  text = text.replace(/\b_([^_]+)_\b/g, "<em>$1</em>");
  text = text.replace(
    /\[([^\]]+)\]\(([^)\s]+)\)/g,
    (_m, label, href) => `<a href="${escapeAttr(href)}">${label}</a>`,
  );
  text = text.replace(/\[\[([a-zA-Z_][\w-]*)\]\]/g, (_m, id) =>
    `<a class="noma-ref" href="#${escapeAttr(id)}">${id}</a>`,
  );
  text = text.replace(/\n/g, "<br />");
  return text;
}

export function inlineToPlain(src: string): string {
  return src
    .replace(/`([^`]+)`/g, "$1")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/\b_([^_]+)_\b/g, "$1")
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, "$1 ($2)")
    .replace(/\[\[([a-zA-Z_][\w-]*)\]\]/g, "$1");
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

export function escapeAttr(s: string): string {
  return escapeHtml(s).replace(/"/g, "&quot;");
}
