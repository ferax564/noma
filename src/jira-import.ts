/**
 * Jira issues (the JSON of `GET /rest/api/3/search`, one page or many, or a bare issue array) → Work
 * issues. Pure: it maps types, statuses, priorities, people, links, subtasks, comments, and Atlassian
 * Document Format descriptions to Markdown; the Cloud route writes them.
 */

export type JiraType = "task" | "story" | "bug" | "epic";
export type JiraStatus = "backlog" | "todo" | "in_progress" | "in_review" | "done";
export type JiraPriority = "lowest" | "low" | "medium" | "high" | "highest";

export interface JiraPerson {
  name: string;
  email?: string;
}

export interface JiraComment {
  author: JiraPerson;
  body: string;
  created: string;
}

export interface JiraLink {
  type: "blocks" | "relates" | "duplicates";
  /** The other issue's key. */
  key: string;
}

export interface JiraIssue {
  key: string;
  summary: string;
  description: string;
  type: JiraType;
  status: JiraStatus;
  priority: JiraPriority;
  labels: string[];
  assignee?: JiraPerson;
  reporter?: JiraPerson;
  parentKey?: string;
  dueDate?: string;
  estimate?: number;
  created?: string;
  links: JiraLink[];
  comments: JiraComment[];
}

export class JiraImportError extends Error {}

const MAX_ISSUES = 20_000;

/** Accepts `{issues: [...]}`, `[{issues}, …]` (paged search results), or `[issue, …]`. */
export function parseJiraExport(input: unknown): JiraIssue[] {
  const raw: unknown[] = Array.isArray(input)
    ? input.flatMap((item) => (record(item).issues !== undefined ? arrayOf(record(item).issues) : [item]))
    : arrayOf(record(input).issues);
  if (raw.length === 0) throw new JiraImportError("No issues found — send the JSON of a Jira search (`{issues: [...]}`) or an issue array");
  if (raw.length > MAX_ISSUES) throw new JiraImportError(`At most ${MAX_ISSUES} issues per import`);
  const seen = new Set<string>();
  const issues: JiraIssue[] = [];
  for (const item of raw) {
    const issue = jiraIssue(record(item));
    if (!issue || seen.has(issue.key)) continue;
    seen.add(issue.key);
    issues.push(issue);
  }
  return issues;
}

/** Atlassian Document Format (or a plain string, for Server/DC and API v2) → Markdown. */
export function adfToMarkdown(node: unknown): string {
  if (typeof node === "string") return node;
  return block(record(node)).replace(/\n{3,}/g, "\n\n").trim();
}

function block(node: Record<string, unknown>, depth = 0): string {
  const children = arrayOf(node.content).map(record);
  switch (node.type) {
    case "doc":
      return children.map((child) => block(child, depth)).join("\n\n");
    case "paragraph":
      return children.map(inline).join("");
    case "heading":
      return `${"#".repeat(Math.min(6, Math.max(1, Number(record(node.attrs).level) || 2)))} ${children.map(inline).join("")}`;
    case "bulletList":
    case "orderedList":
      return children.map((item, index) => `${"  ".repeat(depth)}${node.type === "orderedList" ? `${index + 1}.` : "-"} ${arrayOf(item.content).map((child) => block(record(child), depth + 1)).join("\n").trim()}`).join("\n");
    case "codeBlock": {
      const code = children.map((child) => text(child.text) ?? "").join("");
      return `\`\`\`${text(record(node.attrs).language) ?? ""}\n${code}\n\`\`\``;
    }
    case "blockquote":
      return children.map((child) => block(child, depth)).join("\n\n").split("\n").map((line) => `> ${line}`).join("\n");
    case "rule":
      return "---";
    case "panel":
      return children.map((child) => block(child, depth)).join("\n\n");
    case "table":
      return children
        .map((row, index) => {
          const cells = arrayOf(row.content).map((cell) => arrayOf(record(cell).content).map((child) => block(record(child), depth)).join(" ").replace(/\|/g, "\\|").replace(/\n/g, " "));
          const line = `| ${cells.join(" | ")} |`;
          return index === 0 ? `${line}\n|${cells.map(() => "---").join("|")}|` : line;
        })
        .join("\n");
    default:
      return children.length ? children.map((child) => (child.type === "text" ? inline(child) : block(child, depth))).join("") : inline(node);
  }
}

function inline(node: Record<string, unknown>): string {
  if (node.type === "hardBreak") return "\n";
  if (node.type === "mention") return `@${text(record(node.attrs).text)?.replace(/^@/, "") ?? "someone"}`;
  if (node.type === "emoji") return text(record(node.attrs).text) ?? text(record(node.attrs).shortName) ?? "";
  if (node.type === "inlineCard") return text(record(node.attrs).url) ?? "";
  let value = text(node.text) ?? "";
  for (const mark of arrayOf(node.marks).map(record)) {
    if (mark.type === "strong") value = `**${value}**`;
    else if (mark.type === "em") value = `*${value}*`;
    else if (mark.type === "code") value = `\`${value}\``;
    else if (mark.type === "strike") value = `~~${value}~~`;
    else if (mark.type === "link" && text(record(mark.attrs).href)) value = `[${value}](${text(record(mark.attrs).href)})`;
  }
  return value;
}

function jiraIssue(raw: Record<string, unknown>): JiraIssue | undefined {
  const key = text(raw.key);
  const fields = record(raw.fields);
  if (!key || !/^[A-Z][A-Z0-9_]*-\d+$/.test(key)) return undefined;
  const typeName = (text(record(fields.issuetype).name) ?? "").toLowerCase();
  const links: JiraLink[] = [];
  for (const link of arrayOf(fields.issuelinks).map(record)) {
    const kind = (text(record(link.type).name) ?? "").toLowerCase();
    const outward = text(record(link.outwardIssue).key);
    if (!outward) continue;
    links.push({ type: kind.includes("block") ? "blocks" : kind.includes("duplic") ? "duplicates" : "relates", key: outward });
  }
  const estimate = typeof fields.customfield_10016 === "number" ? fields.customfield_10016 : typeof fields.story_points === "number" ? fields.story_points : undefined;
  return {
    key,
    summary: (text(fields.summary) ?? key).slice(0, 240),
    description: adfToMarkdown(fields.description ?? ""),
    type: typeName === "bug" ? "bug" : typeName === "story" ? "story" : typeName === "epic" ? "epic" : "task",
    status: jiraStatus(record(fields.status)),
    priority: jiraPriority(text(record(fields.priority).name)),
    labels: (Array.isArray(fields.labels) ? fields.labels : []).filter((label): label is string => typeof label === "string"),
    ...(person(fields.assignee) ? { assignee: person(fields.assignee)! } : {}),
    ...(person(fields.reporter) ? { reporter: person(fields.reporter)! } : {}),
    ...(text(record(fields.parent).key) ? { parentKey: text(record(fields.parent).key) } : {}),
    ...(text(fields.duedate) && /^\d{4}-\d{2}-\d{2}$/.test(text(fields.duedate)!) ? { dueDate: text(fields.duedate) } : {}),
    ...(estimate !== undefined && estimate >= 0 ? { estimate } : {}),
    ...(text(fields.created) ? { created: text(fields.created) } : {}),
    links,
    comments: arrayOf(record(fields.comment).comments).map(record).map((comment) => ({
      author: person(comment.author) ?? { name: "Jira user" },
      body: adfToMarkdown(comment.body ?? ""),
      created: text(comment.created) ?? "",
    })),
  };
}

function jiraStatus(status: Record<string, unknown>): JiraStatus {
  const name = (text(status.name) ?? "").toLowerCase();
  if (/review|qa|testing|verify/.test(name)) return "in_review";
  const category = text(record(status.statusCategory).key);
  if (category === "done" || /done|closed|resolved/.test(name)) return "done";
  if (category === "indeterminate" || /progress/.test(name)) return "in_progress";
  if (/backlog/.test(name)) return "backlog";
  return "todo";
}

function jiraPriority(name: string | undefined): JiraPriority {
  const value = (name ?? "").toLowerCase();
  if (value.includes("highest") || value.includes("blocker") || value.includes("critical")) return "highest";
  if (value.includes("high") || value.includes("major")) return "high";
  if (value.includes("lowest") || value.includes("trivial")) return "lowest";
  if (value.includes("low") || value.includes("minor")) return "low";
  return "medium";
}

function person(value: unknown): JiraPerson | undefined {
  const raw = record(value);
  const name = text(raw.displayName) ?? text(raw.name);
  if (!name) return undefined;
  const email = text(raw.emailAddress);
  return { name, ...(email ? { email: email.toLowerCase() } : {}) };
}

function arrayOf(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function text(value: unknown): string | undefined {
  return typeof value === "string" && value ? value : undefined;
}
