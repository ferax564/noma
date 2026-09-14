import { CUTOVER_STAGES, EnterpriseError, type CutoverStage, type ImportDisposition } from "./enterprise-contracts.js";

export interface ConfluenceMacroLoss {
  name: string;
  snapshot: string;
}

export interface ConfluenceImportResult {
  title: string;
  source: string;
  lossReport: ConfluenceMacroLoss[];
}

export interface JiraImportedIssue {
  key: string;
  summary: string;
  typeKey: string;
  status: string;
  labels: string[];
  comments: string[];
  worklogs: Array<{ author: string; durationSeconds: number; started?: string }>;
  customFields: Record<string, unknown>;
  parentKey?: string;
  links: Array<{ type: string; targetKey: string }>;
  createdAt?: string;
}

const MAX_IMPORT_BYTES = 5_000_000;

export function assertSafeImportUrl(url: string): void {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new EnterpriseError("invalid", "importer URL is not valid");
  }
  if (parsed.protocol === "file:" || parsed.protocol === "gopher:" || parsed.protocol === "ftp:") {
    throw new EnterpriseError("policy", "importer URL scheme is not allowed", { protocol: parsed.protocol });
  }
  const host = parsed.hostname.toLowerCase();
  if (host === "localhost" || host.endsWith(".local") || host === "metadata.google.internal") {
    throw new EnterpriseError("policy", "importer URL target is not allowed", { host });
  }
  if (/^(127\.|10\.|192\.168\.|169\.254\.|0\.)/.test(host)) {
    throw new EnterpriseError("policy", "importer URL target is not allowed", { host });
  }
}

export function parseConfluenceStorage(xml: string, title = "Imported page"): ConfluenceImportResult {
  if (xml.length > MAX_IMPORT_BYTES) throw new EnterpriseError("invalid", "confluence payload too large");
  if (/<!ENTITY/i.test(xml) || /SYSTEM\s+"/i.test(xml)) {
    throw new EnterpriseError("policy", "XML entity expansion is not accepted");
  }
  const lossReport: ConfluenceMacroLoss[] = [];
  let body = xml;
  body = body.replace(/<ac:structured-macro[^>]*ac:name="([^"]+)"[^>]*>([\s\S]*?)<\/ac:structured-macro>/gi, (_all, name: string, inner: string) => {
    const known = name === "code" || name === "info" || name === "note" || name === "warning";
    if (!known) {
      lossReport.push({ name, snapshot: inner.slice(0, 400) });
      return `\n::unsupported_macro{name="${name}"}\n${inner.replace(/<[^>]+>/g, "").trim()}\n::\n`;
    }
    if (name === "code") {
      const text = inner.replace(/<[^>]+>/g, "");
      return `\n\`\`\`\n${text.trim()}\n\`\`\`\n`;
    }
    const text = inner.replace(/<[^>]+>/g, "").trim();
    return `\n::callout{kind="${name}"}\n${text}\n::\n`;
  });
  body = body.replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, (_all, level: string, inner: string) => {
    return `\n${"#".repeat(Number(level))} ${inner.replace(/<[^>]+>/g, "").trim()}\n`;
  });
  body = body.replace(/<p[^>]*>([\s\S]*?)<\/p>/gi, (_all, inner: string) => `\n${inner.replace(/<[^>]+>/g, "").trim()}\n`);
  body = body.replace(/<br\s*\/?>/gi, "\n");
  body = body.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, (_all, inner: string) => `- ${inner.replace(/<[^>]+>/g, "").trim()}\n`);
  body = body.replace(/<table[\s\S]*?<\/table>/gi, (table) => {
    const rows = [...table.matchAll(/<tr[\s\S]*?<\/tr>/gi)].map((match) =>
      [...match[0].matchAll(/<t[hd][^>]*>([\s\S]*?)<\/t[hd]>/gi)].map((cell) => cell[1]!.replace(/<[^>]+>/g, "").trim()),
    );
    if (rows.length === 0) return "\n";
    const width = Math.max(...rows.map((row) => row.length), 2);
    const pad = (row: string[]): string[] => {
      const next = [...row];
      while (next.length < width) next.push("");
      return next;
    };
    const header = pad(rows[0] ?? ["", ""]);
    const sep = header.map(() => "---");
    const bodyRows = rows.slice(1).map((row) => pad(row));
    const line = (cells: string[]): string => `| ${cells.join(" | ")} |`;
    return `\n${line(header)}\n${line(sep)}\n${bodyRows.map(line).join("\n")}\n`;
  });
  body = body.replace(/<[^>]+>/g, "");
  const source = `# ${title}\n\n${body.trim()}\n`;
  return { title, source, lossReport };
}

export function parseJiraIssue(payload: Record<string, unknown>): JiraImportedIssue {
  const fields = (payload.fields ?? {}) as Record<string, unknown>;
  const comments = Array.isArray((fields.comment as { comments?: unknown[] } | undefined)?.comments)
    ? ((fields.comment as { comments: Array<{ body?: string }> }).comments).map((item) => String(item.body ?? ""))
    : [];
  const worklogs = Array.isArray((fields.worklog as { worklogs?: unknown[] } | undefined)?.worklogs)
    ? ((fields.worklog as { worklogs: Array<{ author?: { displayName?: string }; timeSpentSeconds?: number; started?: string }> }).worklogs).map(
        (item) => ({
          author: String(item.author?.displayName ?? "unknown"),
          durationSeconds: Number(item.timeSpentSeconds ?? 0),
          started: item.started,
        }),
      )
    : [];
  const customFields: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (key.startsWith("customfield_")) customFields[key] = value;
  }
  const links = Array.isArray(fields.issuelinks)
    ? (fields.issuelinks as Array<{ type?: { name?: string }; outwardIssue?: { key?: string }; inwardIssue?: { key?: string } }>).map((link) => ({
        type: String(link.type?.name ?? "relates"),
        targetKey: String(link.outwardIssue?.key ?? link.inwardIssue?.key ?? ""),
      }))
    : [];
  const issuetype = String((fields.issuetype as { name?: string } | undefined)?.name ?? "Task").toLowerCase();
  const typeKey = issuetype.includes("story")
    ? "story"
    : issuetype.includes("bug")
      ? "bug"
      : issuetype.includes("epic")
        ? "epic"
        : issuetype.includes("sub")
          ? "subtask"
          : "task";
  return {
    key: String(payload.key ?? ""),
    summary: String(fields.summary ?? ""),
    typeKey,
    status: String((fields.status as { name?: string } | undefined)?.name ?? "backlog"),
    labels: Array.isArray(fields.labels) ? (fields.labels as unknown[]).map(String) : [],
    comments,
    worklogs,
    customFields,
    parentKey: (fields.parent as { key?: string } | undefined)?.key,
    links,
    createdAt: typeof fields.created === "string" ? fields.created : undefined,
  };
}

export function nextCutoverStage(current: CutoverStage): CutoverStage {
  const index = CUTOVER_STAGES.indexOf(current);
  const next = CUTOVER_STAGES[index + 1];
  if (!next) throw new EnterpriseError("invalid", "cutover is complete");
  return next;
}

export function reconcileInventory(
  inventoried: Array<{ sourceId: string }>,
  report: Array<{ sourceId: string; disposition: ImportDisposition }>,
): { missing: string[]; complete: boolean } {
  const seen = new Set(report.map((row) => row.sourceId));
  const missing = inventoried.map((row) => row.sourceId).filter((id) => !seen.has(id));
  return { missing, complete: missing.length === 0 };
}
