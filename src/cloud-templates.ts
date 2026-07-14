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
  return template.source
    .replaceAll("{{title}}", title.trim() || "Untitled Page")
    .replaceAll("{{title_id}}", slugify(title) || "untitled-page")
    .replaceAll("{{space}}", spaceTitle.trim() || "this workspace");
}
