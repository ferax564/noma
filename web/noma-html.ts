export function nomaToEditorHtml(title: string, source: string, token: string): string {
  let text = source.replace(/^---[\s\S]*?---\n/, "").trim();
  text = text.replace(/^\{#[^\n]*\}\n?/gm, "");
  const chunks: string[] = [];
  const lines = text.split("\n");
  let index = 0;
  while (index < lines.length) {
    const line = lines[index] ?? "";
    if (!line.trim()) {
      index += 1;
      continue;
    }
    const fence = line.match(/^::(\w+)(?:\{([^}]*)\})?\s*$/);
    if (fence) {
      const name = fence[1] ?? "";
      const attrs = fence[2] ?? "";
      const body: string[] = [];
      index += 1;
      while (index < lines.length && !/^(::|:::)\s*$/.test(lines[index] ?? "")) {
        body.push(lines[index] ?? "");
        index += 1;
      }
      if (index < lines.length) index += 1;
      chunks.push(renderDirective(name, attrs, body.join("\n").trim(), token));
      continue;
    }
    if (/^#{1,6}\s+/.test(line)) {
      const level = line.match(/^#+/)?.[0].length ?? 1;
      const heading = line.replace(/^#{1,6}\s+/, "").replace(/\s*\{[^}]*\}\s*$/, "").trim();
      index += 1;
      if (level === 1 && heading.toLowerCase() === title.toLowerCase()) continue;
      const tag = level === 1 ? "h1" : "h2";
      chunks.push(`<${tag}>${inlineHtml(heading)}</${tag}>`);
      continue;
    }
    if (/^\s*[-*]\s+/.test(line) || /^\s*\d+\.\s+/.test(line)) {
      const ordered = /^\s*\d+\.\s+/.test(line);
      const items: string[] = [];
      while (index < lines.length && (/^\s*[-*]\s+/.test(lines[index] ?? "") || /^\s*\d+\.\s+/.test(lines[index] ?? ""))) {
        items.push((lines[index] ?? "").replace(/^\s*(?:[-*]|\d+\.)\s+/, ""));
        index += 1;
      }
      const tag = ordered ? "ol" : "ul";
      chunks.push(`<${tag}>${items.map((item) => `<li><p>${inlineHtml(item)}</p></li>`).join("")}</${tag}>`);
      continue;
    }
    const paragraph: string[] = [];
    while (index < lines.length && (lines[index] ?? "").trim() && !/^(::|#|\s*[-*]\s+|\s*\d+\.\s+)/.test(lines[index] ?? "")) {
      paragraph.push(lines[index] ?? "");
      index += 1;
    }
    const body = paragraph.join(" ").trim();
    if (body) chunks.push(`<p>${inlineHtml(body)}</p>`);
  }
  return chunks.filter(Boolean).join("") || `<p></p>`;
}

function renderDirective(name: string, attrs: string, body: string, token: string): string {
  const src = /(?:src|asset)="([^"]+)"/.exec(attrs)?.[1] ?? "";
  const alt = /(?:alt|title)="([^"]+)"/.exec(attrs)?.[1] ?? name;
  if (name === "figure" && src) {
    const url = src.includes("?") ? src : `${src}?token=${encodeURIComponent(token)}`;
    return `<p><img src="${escapeAttr(url)}" alt="${escapeAttr(alt)}"></p>`;
  }
  if (name === "video" && src) {
    const url = src.includes("?") ? src : `${src}?token=${encodeURIComponent(token)}`;
    return `<p><video src="${escapeAttr(url)}" controls></video></p>`;
  }
  if (name === "claim" || name === "info" || name === "note" || name === "warning" || name === "success" || name === "decision") {
    const confidence = /confidence=([0-9.]+)/.exec(attrs)?.[1];
    const title = name === "claim" ? (confidence ? `Claim · ${confidence}` : "Claim") : `${name[0]!.toUpperCase()}${name.slice(1)}`;
    return `<div data-noma-panel="${escapeAttr(name)}" data-panel-title="${escapeAttr(title)}" class="ew-panel ew-panel-${escapeAttr(name)}"><p><strong>${escapeHtml(title)}</strong> ${inlineHtml(body)}</p></div>`;
  }
  if (body) return `<blockquote><p><strong>${escapeHtml(name)}</strong> ${inlineHtml(body)}</p></blockquote>`;
  return "";
}

function escapeHtml(value: string): string {
  return value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeAttr(value: string): string {
  return escapeHtml(value).replace(/"/g, "&quot;");
}

function inlineHtml(value: string): string {
  const parts: string[] = [];
  const pattern = /(`[^`]+`|\*\*[^*]+\*\*|\*[^*]+\*|\[([^\]]+)\]\(([^)]+)\))/g;
  let cursor = 0;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(value))) {
    parts.push(escapeHtml(value.slice(cursor, match.index)));
    const token = match[0];
    if (token.startsWith("`")) parts.push(`<code>${escapeHtml(token.slice(1, -1))}</code>`);
    else if (token.startsWith("**")) parts.push(`<strong>${escapeHtml(token.slice(2, -2))}</strong>`);
    else if (token.startsWith("*")) parts.push(`<em>${escapeHtml(token.slice(1, -1))}</em>`);
    else parts.push(`<a href="${escapeAttr(match[3] ?? "")}">${escapeHtml(match[2] ?? "")}</a>`);
    cursor = match.index + token.length;
  }
  parts.push(escapeHtml(value.slice(cursor)));
  return parts.join("");
}
