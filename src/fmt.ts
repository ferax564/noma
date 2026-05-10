/**
 * Source formatter — currently scoped to GitHub-style pipe tables.
 *
 * The parser already accepts misaligned tables; this rewriter exists so the
 * *source* stays readable even when cell widths drift (mixed `✓`/long-prose
 * columns are the friction point). It only touches recognised pipe-table
 * blocks; unrelated lines are byte-identical to the input.
 */
import { splitPipeRow } from "./inline.js";

const TABLE_ROW_RE = /^\s*\|.*\|\s*$/;
const TABLE_SEPARATOR_RE = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?\s*$/;
const FENCE_RE = /^```(\w*)\s*$/;

interface Alignment {
  left: boolean;
  right: boolean;
}

function visibleWidth(s: string): number {
  // js String.length — good enough for ASCII; not perfect for full-width
  // CJK or emoji clusters, but predictable and dependency-free.
  return Array.from(s).length;
}

const splitRow = splitPipeRow;

function parseSeparator(line: string): Alignment[] | null {
  if (!TABLE_SEPARATOR_RE.test(line)) return null;
  return splitRow(line).map((c) => ({
    left: c.startsWith(":"),
    right: c.endsWith(":"),
  }));
}

function buildSeparator(widths: number[], aligns: Alignment[]): string {
  const cells = widths.map((w, i) => {
    const a = aligns[i] ?? { left: false, right: false };
    const target = Math.max(3, w);
    if (a.left && a.right) return `:${"-".repeat(target - 2)}:`;
    if (a.right) return `${"-".repeat(target - 1)}:`;
    if (a.left) return `:${"-".repeat(target - 1)}`;
    return "-".repeat(target);
  });
  return `| ${cells.join(" | ")} |`;
}

function pad(cell: string, width: number, align: Alignment): string {
  const w = visibleWidth(cell);
  const slack = Math.max(0, width - w);
  if (align.left && align.right) {
    const left = Math.floor(slack / 2);
    const right = slack - left;
    return " ".repeat(left) + cell + " ".repeat(right);
  }
  if (align.right) return " ".repeat(slack) + cell;
  return cell + " ".repeat(slack);
}

function buildRow(
  cells: string[],
  widths: number[],
  aligns: Alignment[],
): string {
  const padded = cells.map((c, i) =>
    pad(c, widths[i] ?? visibleWidth(c), aligns[i] ?? { left: false, right: false }),
  );
  return `| ${padded.join(" | ")} |`;
}

export function formatSource(source: string): string {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const out: string[] = [];
  let i = 0;
  let inFence = false;

  while (i < lines.length) {
    const line = lines[i] ?? "";
    if (FENCE_RE.test(line)) {
      inFence = !inFence;
      out.push(line);
      i++;
      continue;
    }
    if (inFence) {
      out.push(line);
      i++;
      continue;
    }
    if (
      TABLE_ROW_RE.test(line) &&
      i + 1 < lines.length &&
      TABLE_SEPARATOR_RE.test(lines[i + 1] ?? "")
    ) {
      const header = splitRow(line);
      const sepAligns = parseSeparator(lines[i + 1] ?? "") ?? [];
      const rows: string[][] = [];
      let j = i + 2;
      while (j < lines.length && TABLE_ROW_RE.test(lines[j] ?? "")) {
        const cells = splitRow(lines[j] ?? "");
        while (cells.length < header.length) cells.push("");
        if (cells.length > header.length) cells.length = header.length;
        rows.push(cells);
        j++;
      }
      const widths = header.map((h, idx) =>
        Math.max(
          visibleWidth(h),
          ...rows.map((r) => visibleWidth(r[idx] ?? "")),
          3,
        ),
      );
      const aligns: Alignment[] = header.map(
        (_, idx) => sepAligns[idx] ?? { left: false, right: false },
      );
      out.push(buildRow(header, widths, aligns));
      out.push(buildSeparator(widths, aligns));
      for (const r of rows) out.push(buildRow(r, widths, aligns));
      i = j;
      continue;
    }
    out.push(line);
    i++;
  }
  return out.join("\n");
}
