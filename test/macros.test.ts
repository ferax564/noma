import assert from "node:assert/strict";
import test from "node:test";
import { expandMacros, extractIncludeNodes, type IncludeRequest, type MacroResolvers, MAX_INCLUDE_DEPTH } from "../src/macros.js";
import { parse } from "../src/parser.js";
import { renderHtml } from "../src/renderer-html.js";
import { renderLlm } from "../src/renderer-llm.js";
import { renderMarkdown } from "../src/renderer-markdown.js";
import { renderNoma } from "../src/renderer-noma.js";
import { validate } from "../src/validator.js";

const pages: Record<string, string> = {
  handbook: `# Handbook

::excerpt
Short **summary**.
::

::note{id="policy"}
Review every change.
::
`,
  loop: `# Loop

::include{page="loop"}
::
`,
  chain1: `# One

::include{page="chain2"}
::
`,
  chain2: `# Two

::include{page="chain3"}
::
`,
  chain3: `# Three

::include{page="chain4"}
::
`,
  chain4: `# Four

::include{page="chain5"}
::
`,
  chain5: `# Five
`,
};

function resolvers(documentId?: string): MacroResolvers {
  return {
    ...(documentId ? { documentId } : {}),
    resolveInclude: (request: IncludeRequest) => {
      const id = request.page ?? request.fromDocumentId ?? "";
      const source = pages[id];
      if (!source) return { status: "missing" };
      const nodes = extractIncludeNodes(parse(source), { block: request.block, excerpt: request.excerpt });
      if (!nodes) return { status: "missing" };
      return { status: "ok", documentId: id, title: id, ...(request.block ? { blockId: request.block } : {}), ...(request.excerpt ? { excerpt: true } : {}), hash: "a".repeat(64), nodes, href: `/p/${id}` };
    },
    resolveChildren: () => ({
      status: "ok",
      pages: [{ id: "c1", title: "Child <one>", href: "javascript:alert(1)", summary: "First", children: [{ id: "c2", title: "Grandchild", children: [] }] }],
    }),
    resolveIssue: (key) => (key === "ABC-1" ? { status: "ok", issue: { key, summary: "Fix <bug>", status: "in_review", assigneeName: "Ada" } } : { status: "forbidden" }),
    resolveIssues: (request) => ({ status: "ok", project: request.project, issues: [{ key: `${request.project}-2`, summary: "Two", status: request.status ?? "todo" }] }),
    resolvePagePropertiesReport: () => ({
      status: "ok",
      rows: [{ documentId: "d1", title: "ADR 1", properties: [["Owner", "Ada"], ["Status", "Done"]] }],
    }),
  };
}

const host = `# Host

::include{page="handbook" block="policy"}
::

::include{page="handbook" excerpt}
::

::children{depth=2}
::

::issue{key="ABC-1"}
::

::issue{key="ABC-9"}
::

::issues{project="ABC" status="todo"}
::

::page-properties{id="props"}
| Owner | Ada |
Status: Draft
::

::page-properties-report{label="adr"}
::
`;

test("html renderer resolves macros through injected resolvers and escapes their data", () => {
  const html = renderHtml(parse(host), { ...resolvers("host") });
  assert.match(html, /<div class="noma-include" data-include-document="handbook" data-include-block="policy"/);
  assert.match(html, /Included from <a href="\/p\/handbook">handbook<\/a><\/div><aside class="noma-callout noma-callout-note"><p>Review every change\.<\/p><\/aside>/);
  assert.doesNotMatch(html, /id="policy"/);
  assert.match(html, /Excerpt from[\s\S]*Short <strong>summary<\/strong>\./);
  assert.match(html, /<li data-page-id="c1"><a href="#">Child &lt;one&gt;<\/a> <span class="noma-children-summary">First<\/span><ul><li data-page-id="c2">Grandchild<\/li><\/ul><\/li>/);
  assert.match(html, /Fix &lt;bug&gt;/);
  assert.match(html, /data-macro="issue" data-status="forbidden"/);
  assert.match(html, /ABC-2[\s\S]*Two/);
  assert.match(html, /<th scope="row">Owner<\/th><td>Ada<\/td>[\s\S]*<th scope="row">Status<\/th><td>Draft<\/td>/);
  assert.match(html, /<th>Page<\/th><th>Owner<\/th><th>Status<\/th>[\s\S]*ADR 1/);
});

test("html renderer emits placeholders when no resolver is supplied", () => {
  const html = renderHtml(parse(host));
  assert.equal(html.match(/data-status="unresolved"/g)?.length, 7);
  assert.match(html, /Block "policy" of "handbook" is resolved when this page is viewed in Noma Cloud\./);
  assert.match(html, /noma-page-properties/);
});

test("include cycles and depth limits stop recursion", () => {
  const loop = renderHtml(parse(pages.loop!), resolvers("loop"));
  assert.match(loop, /data-status="cycle"/);
  const deep = renderHtml(parse(pages.chain1!), { resolveInclude: resolvers().resolveInclude! });
  assert.equal(deep.match(/class="noma-include"/g)?.length, MAX_INCLUDE_DEPTH);
  assert.match(deep, /data-status="depth"/);
  assert.doesNotMatch(deep, /<h1>Five<\/h1>/);
});

test("llm renderer inlines included content with provenance comments", () => {
  const llm = renderLlm(parse(host), resolvers("host"));
  assert.match(llm, /<!-- included from handbook:policy@aaaaaaaaaaaa -->\n\[NOTE\]\nReview every change\.\n+\[\/NOTE\]\n+<!-- \/included from handbook:policy -->/);
  assert.match(llm, /<!-- included from handbook:excerpt@aaaaaaaaaaaa -->/);
  assert.match(llm, /\[ISSUE key="ABC-1"\]\nABC-1: Fix <bug> · in review · Ada\n\[\/ISSUE\]/);
  assert.match(llm, /- Child <one> — First\n- — Grandchild/);
  assert.match(llm, /Owner: Ada\nStatus: Draft/);
  const plain = renderLlm(parse(host));
  assert.match(plain, /\[INCLUDE page="handbook" block="policy"\]\nBlock "policy" of "handbook" is resolved when this page is viewed in Noma Cloud\./);
});

test("expandMacros turns macros into portable nodes for markdown and docx exports", () => {
  const doc = parse(host);
  const before = JSON.stringify(doc);
  const expanded = expandMacros(doc, resolvers("host"));
  assert.equal(JSON.stringify(doc), before);
  const markdown = renderMarkdown(expanded, { semanticComments: false, includeAnchors: false });
  assert.match(markdown, /Review every change\./);
  assert.match(markdown, /- Child <one> — First\n- — Grandchild/);
  assert.match(markdown, /\| ABC-2 +\| Two +\| todo +\| Unassigned +\|/);
  assert.match(markdown, /\| Page +\| Owner \| Status \|/);
});

test("macros round-trip through .noma source unchanged", () => {
  const doc = parse(host);
  assert.equal(renderNoma(parse(renderNoma(doc))), renderNoma(doc));
  assert.match(renderNoma(doc), /::include\{page="handbook" block="policy"\}/);
});

test("validator checks macro attributes and warns on unverifiable pages", () => {
  const source = `# Checks

::include
::

::include{page="Elsewhere"}
::

::include{block="missing-block"}
::

::excerpt
One
::

::excerpt
Two
::

::children{depth=9 sort="random"}
::

::issue{key="bad"}
::

::issues{project="x" status="later"}
::

::page-properties-report
::
`;
  const codes = validate(parse(source)).map((diagnostic) => `${diagnostic.severity}:${diagnostic.code}`);
  for (const expected of [
    "error:include-missing-target",
    "warning:include-unknown-page",
    "error:broken-reference",
    "warning:excerpt-duplicate",
    "warning:children-invalid-option",
    "error:issue-invalid-key",
    "error:issues-invalid-project",
    "warning:issues-invalid-status",
    "error:page-properties-report-missing-label",
  ]) {
    assert.ok(codes.includes(expected), `${expected} in ${codes.join(", ")}`);
  }
  const known = validate(parse(`# Ok\n\n::include{page="Elsewhere"}\n::\n`), { pageExists: (page) => page === "Elsewhere" });
  assert.equal(known.filter((diagnostic) => diagnostic.code === "include-unknown-page").length, 0);
});
