/**
 * Tiny inline markup parser. Operates on plain text and emits HTML.
 * Order matters: handle code spans first so emphasis inside `code` stays raw.
 */
const MARKDOWN_LINK_RE = /\[((?:\\.|[^\]\\])+)\]\(([^)\s]+)\)/g;
const WIKILINK_RE = /\[\[([^\]\n]+?)\]\]/g;
const BLOCK_REFERENCE_WIKILINK_RE = /^[a-zA-Z_][\w\-./:]*$/;

export interface Wikilink {
  raw: string;
  target: string;
  label: string;
}

export function extractWikilinks(src: string): Wikilink[] {
  const out: Wikilink[] = [];
  for (const match of stripInlineCodeSpans(src).matchAll(WIKILINK_RE)) {
    const parsed = parseWikilink(match[1] ?? "");
    if (parsed) out.push(parsed);
  }
  return out;
}

function stripInlineCodeSpans(src: string): string {
  return src.replace(/`[^`\n]*`/g, "");
}

export function isBlockReferenceWikilinkTarget(target: string): boolean {
  return BLOCK_REFERENCE_WIKILINK_RE.test(target);
}

export function inlineToHtml(src: string): string {
  let text = escapeHtml(src);

  // Code spans go first AND get placeholdered so subsequent inline rules
  // (emphasis, links, wikilinks) don't reach into their content. Without the
  // placeholder, a sequence like `x_y` ... `a_b` lets the underscore regex
  // greedily span across the rendered <code> tags.
  const codeSpans: string[] = [];
  const PH_OPEN = String.fromCharCode(2);
  const PH_CLOSE = String.fromCharCode(3);
  text = text.replace(/`([^`]+)`/g, (_m, body) => {
    const i = codeSpans.push("<code>" + body + "</code>") - 1;
    return PH_OPEN + i + PH_CLOSE;
  });
  text = unescapeMarkdownTextEscapes(text);
  text = text.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  text = text.replace(/\*([^*]+)\*/g, "<em>$1</em>");
  text = text.replace(/\b_([^_]+)_\b/g, "<em>$1</em>");
  text = text.replace(
    MARKDOWN_LINK_RE,
    (_m, label, href) => `<a href="${escapeAttr(href)}">${unescapeMarkdownLinkLabel(label)}</a>`,
  );
  text = text.replace(WIKILINK_RE, (match, raw) => renderWikilinkHtml(match, raw));
  // CommonMark: a single newline inside a paragraph is a soft line break
  // (renders as a space); two trailing spaces or a trailing backslash before
  // the newline make it a hard break (`<br/>`).
  text = text.replace(/(?:  +|\\)\n/g, "<br />");
  text = text.replace(/\n/g, " ");
  // Restore code-span placeholders.
  const restoreRe = new RegExp(PH_OPEN + "(\\d+)" + PH_CLOSE, "g");
  text = text.replace(restoreRe, (_m, i) => codeSpans[Number(i)] ?? "");
  return text;
}

export function inlineToPlain(src: string): string {
  const codeSpans: string[] = [];
  const PH_OPEN = String.fromCharCode(2);
  const PH_CLOSE = String.fromCharCode(3);
  let text = src.replace(/`([^`]+)`/g, (_m, body) => {
    const i = codeSpans.push(body) - 1;
    return PH_OPEN + i + PH_CLOSE;
  });
  text = unescapeMarkdownTextEscapes(text)
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/\*([^*]+)\*/g, "$1")
    .replace(/\b_([^_]+)_\b/g, "$1")
    .replace(MARKDOWN_LINK_RE, (_m, label, href) => `${unescapeMarkdownLinkLabel(label)} (${href})`)
    .replace(WIKILINK_RE, (match, raw) => parseWikilink(raw)?.label ?? match);
  const restoreRe = new RegExp(PH_OPEN + "(\\d+)" + PH_CLOSE, "g");
  return text.replace(restoreRe, (_m, i) => codeSpans[Number(i)] ?? "");
}

function renderWikilinkHtml(match: string, raw: string): string {
  const parsed = parseWikilink(raw);
  if (!parsed) return match;
  const hrefTarget = isBlockReferenceWikilinkTarget(parsed.target)
    ? parsed.target
    : encodeURIComponent(parsed.target);
  return `<a class="noma-ref" href="#${escapeAttr(hrefTarget)}">${parsed.label}</a>`;
}

function parseWikilink(raw: string): Wikilink | undefined {
  const trimmed = raw.trim();
  if (!trimmed || trimmed.includes("[") || trimmed.includes("]")) return undefined;
  const pipe = trimmed.indexOf("|");
  const target = (pipe === -1 ? trimmed : trimmed.slice(0, pipe)).trim();
  const label = (pipe === -1 ? defaultWikilinkLabel(target) : trimmed.slice(pipe + 1).trim()) || defaultWikilinkLabel(target);
  if (!target) return undefined;
  return { raw: trimmed, target, label };
}

function defaultWikilinkLabel(target: string): string {
  return target.replace(/^#/, "").replace(/#/g, " > ");
}

export function unescapeMarkdownLinkLabel(label: string): string {
  return label.replace(/\\([\\[\]|])/g, "$1");
}

export function unescapeMarkdownTextEscapes(text: string): string {
  return text.replace(/\\\|/g, "|");
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

/**
 * Split a pipe-table row respecting `code spans` and `\|` escapes — pipes
 * inside backticks or escaped with a backslash are kept verbatim inside the
 * cell. Used by the parser and by `noma fmt` so both agree on cell counts.
 */
export function splitPipeRow(line: string): string[] {
  const trimmed = line.trim().replace(/^\|/, "").replace(/\|$/, "");
  const cells: string[] = [];
  let buf = "";
  let inBacktick = false;
  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i]!;
    if (ch === "\\" && trimmed[i + 1] === "|") {
      buf += "\\|";
      i++;
      continue;
    }
    if (ch === "`") {
      inBacktick = !inBacktick;
      buf += ch;
      continue;
    }
    if (ch === "|" && !inBacktick) {
      cells.push(buf.trim());
      buf = "";
      continue;
    }
    buf += ch;
  }
  cells.push(buf.trim());
  return cells;
}

export function escapePipeTableCell(cell: string): string {
  let out = "";
  let inBacktick = false;
  for (let i = 0; i < cell.length; i++) {
    const ch = cell[i]!;
    if (ch === "`") {
      inBacktick = !inBacktick;
      out += ch;
      continue;
    }
    if (ch === "|" && !inBacktick && cell[i - 1] !== "\\") {
      out += "\\|";
      continue;
    }
    out += ch;
  }
  return out;
}

export type DelimitedRowDelimiter = "," | "\t";

export function splitDelimitedRow(line: string, delimiter: DelimitedRowDelimiter): string[] {
  const cells: string[] = [];
  let buf = "";
  let inQuotes = false;
  let quotedCell = false;
  let afterClosingQuote = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (inQuotes) {
      if (ch === "\"" && line[i + 1] === "\"") {
        buf += "\"";
        i++;
        continue;
      }
      if (ch === "\"") {
        inQuotes = false;
        quotedCell = true;
        afterClosingQuote = true;
        continue;
      }
      buf += ch;
      continue;
    }
    if (ch === delimiter) {
      cells.push(quotedCell ? buf : buf.trim());
      buf = "";
      quotedCell = false;
      afterClosingQuote = false;
      continue;
    }
    if (ch === "\"" && buf.trim() === "" && !quotedCell) {
      buf = "";
      inQuotes = true;
      continue;
    }
    if (afterClosingQuote && /\s/.test(ch)) continue;
    afterClosingQuote = false;
    buf += ch;
  }
  cells.push(quotedCell ? buf : buf.trim());
  return cells;
}

export function serializeDelimitedRow(cells: string[], delimiter: DelimitedRowDelimiter): string {
  return cells.map((cell) => serializeDelimitedCell(cell, delimiter)).join(delimiter);
}

function serializeDelimitedCell(cell: string, delimiter: DelimitedRowDelimiter): string {
  if (!cell.includes(delimiter) && !cell.includes("\"") && !/^\s|\s$/.test(cell)) return cell;
  return `"${cell.replace(/"/g, "\"\"")}"`;
}
