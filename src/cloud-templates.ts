import { slugify } from "./parser.js";

export interface CloudPageTemplate {
  id: string;
  title: string;
  description: string;
  category: "general" | "team" | "project" | "technical" | "research";
  source: string;
}

export const cloudPageTemplates: CloudPageTemplate[] = [
  {
    id: "blank",
    title: "Blank page",
    description: "A clean page with a stable title ID.",
    category: "general",
    source: "# {{title}} {id=\"{{title_id}}\"}\n\nStart writing here.\n",
  },
  {
    id: "meeting-notes",
    title: "Meeting notes",
    description: "Agenda, decisions, notes, and addressable action items.",
    category: "team",
    source: `# {{title}} {id="{{title_id}}"}

::summary{id="meeting-summary" status="draft"}
Date, attendees, and the outcome of this meeting.
::

## Agenda {id="agenda"}

- Topic one
- Topic two

## Decisions {id="decisions"}

::decision{id="decision-1" status="proposed" owner="unassigned"}
Record the decision and why it was made.
::

## Action items {id="action-items"}

::agent_task{id="action-1" owner="unassigned" scope="meeting-follow-up"}
Describe the next action, owner, and expected result.
::
`,
  },
  {
    id: "decision-record",
    title: "Decision record",
    description: "Context, options, decision, consequences, and follow-up work.",
    category: "team",
    source: `# {{title}} {id="{{title_id}}"}

## Context {id="context"}

Describe the problem, constraints, and people affected.

## Options {id="options"}

::table{id="option-comparison" header align="l,l,l"}
| Option | Benefits | Costs |
| Option A | | |
| Option B | | |
::

## Decision {id="decision"}

::decision{id="decision-record" status="proposed" owner="unassigned"}
State the chosen option and the deciding evidence.
::

## Consequences {id="consequences"}

Record expected benefits, risks, and reversible follow-up steps.
`,
  },
  {
    id: "project-overview",
    title: "Project overview",
    description: "Goals, scope, milestones, risks, owners, and linked work.",
    category: "project",
    source: `# {{title}} {id="{{title_id}}"}

::summary{id="project-summary" status="draft"}
Summarize the outcome this project should create for {{space}}.
::

## Goals {id="goals"}

- Goal one
- Goal two

## Scope {id="scope"}

Describe what is in scope and explicitly out of scope.

## Milestones {id="milestones"}

::table{id="milestone-plan" header align="l,l,l,l"}
| Milestone | Owner | Target | Status |
| First usable slice | unassigned | TBD | planned |
::

## Risks {id="risks"}

::risk{id="risk-1" owner="unassigned" severity="medium"}
Describe the risk and mitigation.
::
`,
  },
  {
    id: "technical-spec",
    title: "Technical specification",
    description: "Requirements, design, interfaces, rollout, and verification.",
    category: "technical",
    source: `---
profile: technical-docs
---

# {{title}} {id="{{title_id}}"}

## Summary {id="summary"}

State the problem, proposed design, and measurable outcome.

## Requirements {id="requirements"}

- Functional requirement
- Reliability and security requirement

## Design {id="design"}

Describe components, data flow, invariants, and failure handling.

## Interfaces {id="interfaces"}

::api{id="primary-interface" method="POST" path="/example"}
Describe the request, response, authorization, and errors.
::

## Rollout and verification {id="rollout-verification"}

Describe migration, observability, rollback, and acceptance tests.
`,
  },
  {
    id: "research-paper",
    title: "Research paper",
    description: "Claim/evidence paper scaffold with methods, findings, and review queue.",
    category: "research",
    source: `# {{title}} {id="{{title_id}}"}

::abstract{id="abstract" status="draft"}
State the research question, method, primary result, and confidence.
::

## Research question {id="research-question"}

::claim{id="claim-main" confidence=0.5}
State the central claim.
::

::evidence{id="evidence-primary" for="claim-main" source="source-primary"}
Summarize the strongest evidence.
::

## Methods {id="methods"}

Describe the study design, corpus, collection window, and analysis method.

## Findings {id="findings"}

Draft the result narrative.

::citation{id="source-primary" source="Primary source placeholder" url="https://example.com/source"}
Replace this placeholder with the canonical source.
::

## Review queue {id="review-queue"}

::agent_task{id="task-source-check" scope="paper-review" owner="reviewer"}
Verify the primary source and leave unrelated blocks unchanged.
::
`,
  },
];

export function instantiateCloudPageTemplate(templateId: string, title: string, spaceTitle: string): string {
  const template = cloudPageTemplates.find((candidate) => candidate.id === templateId);
  if (!template) throw new Error(`Unknown page template: ${templateId}`);
  return instantiateTemplateSource(template.source, builtInTemplateValues(title, spaceTitle));
}

/** A blueprint variable declared by a user or space template. */
export interface TemplateVariableSpec {
  name: string;
  label: string;
  default?: string;
  required: boolean;
}

/** Placeholders every template may use without declaring them. */
export const RESERVED_TEMPLATE_VARIABLES: readonly string[] = ["title", "title_id", "space", "date", "author"];

const PLACEHOLDER_RE = /\{\{\s*([A-Za-z][A-Za-z0-9_]{0,39})\s*\}\}/g;
export const TEMPLATE_VARIABLE_NAME_RE = /^[a-z][a-z0-9_]{0,39}$/;
export const MAX_TEMPLATE_VALUE_LENGTH = 500;

export function builtInTemplateValues(title: string, spaceTitle: string, extra: Record<string, string> = {}): Record<string, string> {
  return {
    title: title.trim() || "Untitled Page",
    title_id: slugify(title) || "untitled-page",
    space: spaceTitle.trim() || "this workspace",
    ...extra,
  };
}

/** Placeholder names used in a template source, in first-use order. */
export function templatePlaceholders(source: string): string[] {
  const names: string[] = [];
  for (const match of source.matchAll(PLACEHOLDER_RE)) {
    const name = match[1]!;
    if (!names.includes(name)) names.push(name);
  }
  return names;
}

const ZWSP = "\u200b";
const STRUCTURAL_LINE_RE: Array<[string, RegExp]> = [
  ["fence", /^```/],
  ["directive-close", /^:{2,}\s*$/],
  ["directive", /^:{2,}\s*[a-zA-Z_]/],
  ["heading", /^#{1,6}\s+\S/],
  ["thematic", /^(?:-{3,}|\*{3,}|_{3,})\s*$/],
  ["list", /^[-*+]\s+/],
  ["ordered", /^\d+\.\s+/],
  ["quote", /^>/],
  ["table", /^\s*\|/],
];
const HEADING_ATTRS_RE = /\s+\{[^}]+\}\s*$/;

function lineKind(line: string): string {
  const trimmed = line.trimStart();
  for (const [kind, re] of STRUCTURAL_LINE_RE) {
    if (re.test(trimmed)) return kind;
  }
  return "text";
}

/**
 * Fill `{{name}}` placeholders so a value can never change the document's
 * structure: values become single-line, attribute values cannot close their
 * quotes or brace block, YAML values are quoted, and a value that would turn a
 * line into a heading, list, directive, fence, or attribute block is guarded
 * with a zero-width space. Unknown placeholders are left as written.
 */
export function instantiateTemplateSource(source: string, values: Record<string, string>): string {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  let inFrontmatter = lines[0]?.trim() === "---";
  let inFence = false;
  return lines
    .map((line, index) => {
      if (index > 0 && inFrontmatter && line.trim() === "---") {
        inFrontmatter = false;
        return line;
      }
      if (!inFrontmatter && /^```/.test(line.trimStart())) {
        inFence = !inFence;
        if (!line.includes("{{")) return line;
      }
      if (!line.includes("{{")) return line;
      const context: LineContext = inFrontmatter && index > 0 ? "yaml" : inFence ? "code" : "noma";
      return fillLine(line, values, context);
    })
    .join("\n");
}

type LineContext = "noma" | "yaml" | "code";

function fillLine(line: string, values: Record<string, string>, context: LineContext): string {
  const neutral = line.replace(PLACEHOLDER_RE, (match, name: string) => (name in values ? "x" : match));
  const attrSpan = context === "noma" ? attributeSpan(neutral, line) : undefined;
  let out = "";
  let last = 0;
  for (const match of line.matchAll(PLACEHOLDER_RE)) {
    const name = match[1]!;
    const start = match.index ?? 0;
    out += line.slice(last, start);
    last = start + match[0].length;
    const raw = values[name];
    if (raw === undefined) {
      out += match[0];
      continue;
    }
    const value = singleLine(raw);
    if (context === "yaml") out += yamlValue(value, quoteBefore(line, 0, start));
    else if (attrSpan && start > attrSpan.start && start < attrSpan.end) out += attributeValue(value, quoteBefore(line, attrSpan.start, start));
    else out += value;
  }
  out += line.slice(last);
  if (context === "yaml") return out;
  const neutralKind = lineKind(neutral);
  const outKind = lineKind(out);
  const changesStructure = context === "code" ? outKind === "fence" && neutralKind !== "fence" : outKind !== neutralKind;
  if (changesStructure) out =`${leadingWhitespace(out)}${ZWSP}${out.trimStart()}`;
  if (neutralKind === "heading" && !HEADING_ATTRS_RE.test(neutral) && HEADING_ATTRS_RE.test(out)) out = `${out.trimEnd()}${ZWSP}`;
  return out;
}

/** Character span of the `{...}` attribute block on a directive-open or heading line. */
function attributeSpan(neutral: string, line: string): { start: number; end: number } | undefined {
  const trimmed = line.trimStart();
  const offset = line.length - trimmed.length;
  if (/^:{2,}\s*[a-zA-Z_]/.test(trimmed)) {
    const start = line.indexOf("{", offset);
    const end = line.lastIndexOf("}");
    return start >= 0 && end > start ? { start, end } : undefined;
  }
  if (/^#{1,6}\s/.test(trimmed) && HEADING_ATTRS_RE.test(neutral)) {
    const start = line.lastIndexOf(" {") + 1;
    const end = line.lastIndexOf("}");
    return start > 0 && end > start ? { start, end } : undefined;
  }
  return undefined;
}

function quoteBefore(line: string, from: number, to: number): '"' | "'" | undefined {
  let quote: '"' | "'" | undefined;
  for (let index = from; index < to; index++) {
    const char = line[index];
    if (char !== '"' && char !== "'") continue;
    if (!quote) quote = char;
    else if (quote === char) quote = undefined;
  }
  return quote;
}

function attributeValue(value: string, quote: '"' | "'" | undefined): string {
  const unbraced = value.replace(/[{}]/g, "");
  if (quote === '"') return unbraced.replace(/"/g, "'");
  if (quote === "'") return unbraced.replace(/'/g, "\u2019");
  return unbraced.replace(/[\s"'=]+/g, "-");
}

function yamlValue(value: string, quote: '"' | "'" | undefined): string {
  if (quote === '"') return JSON.stringify(value).slice(1, -1);
  if (quote === "'") return value.replace(/'/g, "''");
  return JSON.stringify(value);
}

function singleLine(value: string): string {
  return value
    .replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, " ")
    .replace(/\s{2,}/g, " ")
    .trim()
    .slice(0, MAX_TEMPLATE_VALUE_LENGTH);
}

function leadingWhitespace(line: string): string {
  return line.slice(0, line.length - line.trimStart().length);
}
