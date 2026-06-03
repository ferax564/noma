import { test } from "node:test";
import assert from "node:assert/strict";
import { parse } from "../src/parser.js";
import { renderMarkdown } from "../src/renderer-markdown.js";

test("renderMarkdown exports portable Markdown with anchors and semantic block comments", () => {
  const doc = parse(`---
title: Shareable Spec
---

# Shareable Spec {id="spec" aliases="share"}

See [[risk-1]] and [site](https://example.com).

::claim{id="claim-1" confidence=0.8}
Noma can export **Markdown**.
::

::warning{id="risk-1" title="Review risk"}
Check \`docx\`.
::

::agent_task{id="task-1" done scope="weekly"}
Ship Markdown export.
::

::figure{id="fig-1" src="chart.png" alt="Chart" caption="Growth chart"}
::

::table{id="matrix" header align="l,c"}
| Item | Done |
| Markdown | yes |
::
`);

  const md = renderMarkdown(doc);
  assert.match(md, /^---\ntitle: Shareable Spec\n---/);
  assert.match(md, /<a id="spec"><\/a>\n<a id="share"><\/a>/);
  assert.match(md, /See \[risk-1\]\(#risk-1\) and \[site\]\(https:\/\/example\.com\)\./);
  assert.match(md, /<!-- noma:block \{"name":"claim","id":"claim-1","attrs":\{"confidence":0\.8\}\} -->/);
  assert.match(md, /\*\*Claim: claim-1\*\*/);
  assert.match(md, /_id=claim-1, confidence=0\.8_/);
  assert.match(md, /> \[!WARNING\]\n> \*\*Review risk\*\*\n> Check `docx`\./);
  assert.match(md, /- \[x\] Ship Markdown export\./);
  assert.match(md, /_id=task-1, done, scope=weekly_/);
  assert.match(md, /!\[Chart\]\(chart\.png\)\n\n_Growth chart_/);
  assert.match(md, /\| Item     \| Done \|\n\| :------- \| :---: \|\n\| Markdown \| yes  \|/);
  assert.doesNotMatch(md, /::claim/);
});

test("renderMarkdown uses safe placeholders for escape hatches by default", () => {
  const md = renderMarkdown(parse(`::html{id="raw"}
<script>alert(1)</script>
::
`));

  assert.match(md, /\[Html escape hatch omitted\]/);
  assert.doesNotMatch(md, /<script>alert/);
});

test("renderMarkdown can preserve Noma wikilinks and omit semantic comments", () => {
  const md = renderMarkdown(parse(`# A

See [[target]].

::note{id="n1"}
Note body.
::
`), {
    anchorWikilinks: false,
    semanticComments: false,
  });

  assert.match(md, /See \[\[target\]\]\./);
  assert.doesNotMatch(md, /noma:block/);
});
