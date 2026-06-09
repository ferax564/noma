import { slugify } from "./parser.js";

export interface MarkdownIngestOptions {
  addStableIds?: boolean;
}

const ATX_HEADING_RE = /^(#{1,6})\s+(.+?)(?:\s+\{([^}]+)\})?\s*$/;
const FENCE_RE = /^(```|~~~)/;

export function convertMarkdownToNoma(source: string, options: MarkdownIngestOptions = {}): string {
  const addStableIds = options.addStableIds !== false;
  if (!addStableIds) return normalizeNewlines(source);

  const normalized = normalizeNewlines(source);
  const lines = normalized.split("\n");
  const seen = new Set<string>();
  let inFence = false;
  let frontmatterOpen = lines[0]?.trim() === "---";

  const out = lines.map((line, index) => {
    if (index > 0 && frontmatterOpen && line.trim() === "---") {
      frontmatterOpen = false;
      return line;
    }
    if (frontmatterOpen) return line;

    if (FENCE_RE.test(line.trimStart())) {
      inFence = !inFence;
      return line;
    }
    if (inFence) return line;

    const heading = line.match(ATX_HEADING_RE);
    if (!heading) return line;

    const hashes = heading[1]!;
    const title = heading[2]!.trim();
    const rawAttrs = heading[3];
    if (rawAttrs && /\bid\s*=/.test(rawAttrs)) {
      const id = rawAttrs.match(/\bid\s*=\s*"([^"]+)"|\bid\s*=\s*([^\s}]+)/);
      const existing = id?.[1] ?? id?.[2];
      if (existing) seen.add(existing);
      return line;
    }

    const id = uniqueHeadingId(title, seen);
    const attrs = rawAttrs ? `{id="${id}" ${rawAttrs.trim()}}` : `{id="${id}"}`;
    return `${hashes} ${title} ${attrs}`;
  });

  return out.join("\n");
}

function normalizeNewlines(source: string): string {
  return source.replace(/\r\n?/g, "\n");
}

function uniqueHeadingId(title: string, seen: Set<string>): string {
  const base = slugify(title) || "section";
  let id = base;
  let index = 2;
  while (seen.has(id)) {
    id = `${base}-${index}`;
    index++;
  }
  seen.add(id);
  return id;
}
