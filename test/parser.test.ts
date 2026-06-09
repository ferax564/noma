import { test } from "node:test";
import assert from "node:assert/strict";
import { parse } from "../src/parser.js";
import { renderHtml } from "../src/renderer-html.js";
import { renderLlm } from "../src/renderer-llm.js";
import { validate } from "../src/validator.js";
import { extractWikilinks } from "../src/inline.js";
import type { DirectiveNode, SectionNode, TableNode } from "../src/ast.js";

test("table cells preserve pipes inside backticks", () => {
  const src = `| Form          | Type    |
| :------------ | :------ |
| \`a|b\`       | string  |
| \`x\\|y\`     | string  |
`;
  const html = renderHtml(parse(src));
  assert.match(html, /<code>a\|b<\/code>/);
  assert.match(html, /<code>x\\\|y<\/code>/);
});

test("escaped table pipes render as literal pipes outside code spans", () => {
  const src = `| Label | Code |
| --- | --- |
| A\\|B | \`x\\|y\` |
`;
  const doc = parse(src);
  const html = renderHtml(doc);

  assert.match(html, /<td[^>]*>A\|B<\/td>/);
  assert.match(html, /<code>x\\\|y<\/code>/);
});

test("inline links preserve escaped brackets in labels", () => {
  const doc = parse(`See [\\[source\\]](https://example.com/report).`);
  const html = renderHtml(doc);
  const llm = renderLlm(doc);

  assert.match(html, /<a href="https:\/\/example\.com\/report">\[source\]<\/a>/);
  assert.match(llm, /See \[source\] \(https:\/\/example\.com\/report\)\./);
});

test("Obsidian-style wikilinks support page titles, headings, and labels", () => {
  const html = renderHtml(parse(`See [[Literature Review]], [[Paper Draft#Methods|methods]], and [[claim-main]].`));
  const llm = renderLlm(parse(`See [[Literature Review]], [[Paper Draft#Methods|methods]], and [[claim-main]].`));

  assert.match(html, /<a class="noma-ref" href="#Literature%20Review">Literature Review<\/a>/);
  assert.match(html, /<a class="noma-ref" href="#Paper%20Draft%23Methods">methods<\/a>/);
  assert.match(html, /<a class="noma-ref" href="#claim-main">claim-main<\/a>/);
  assert.match(llm, /See Literature Review, methods, and claim-main\./);
});

test("wikilink extraction ignores inline code examples", () => {
  assert.deepEqual(extractWikilinks("Use `[[Page Title]]` as an example, then link [[Real Page]]."), [
    { raw: "Real Page", target: "Real Page", label: "Real Page" },
  ]);
});

test("::table directive renders pipe-body without separator row", () => {
  const src = `::table{header align="-,c,r"}
| Vertical | Status | Score |
| Legal | OK | 3.4 |
| Healthcare | OK | 2.9 |
::
`;
  const html = renderHtml(parse(src));
  assert.match(html, /<table class="noma-table"/);
  assert.match(html, /<th[^>]*>Vertical<\/th>/);
  assert.match(html, /<th[^>]*style="text-align: center"[^>]*>Status<\/th>/);
  assert.match(html, /<th[^>]*style="text-align: right"[^>]*>Score<\/th>/);
  assert.match(html, /<td[^>]*>Legal<\/td>/);
  assert.match(html, /<td[^>]*style="text-align: right"[^>]*>3.4<\/td>/);
});

test("::pagebreak renders as a print page-break marker", () => {
  const html = renderHtml(parse(`Before.\n\n::pagebreak{id="pb1"}\n::\n\nAfter.\n`));
  assert.match(html, /<div class="noma-pagebreak" id="pb1" role="separator" aria-label="Page break"><\/div>/);
});

test("::footnote renders as a structured note", () => {
  const html = renderHtml(parse(`::footnote{id="fn1" label="1"}\nCommittee context.\n::\n`));
  assert.match(html, /<aside class="noma-footnote" id="fn1" data-label="1"><sup>1<\/sup><p>Committee context\.<\/p><\/aside>/);
});

test("::endnote renders as a structured note", () => {
  const html = renderHtml(parse(`::endnote{id="en1" label="i"}\nAppendix context.\n::\n`));
  assert.match(html, /<aside class="noma-endnote" id="en1" data-label="i"><sup>i<\/sup><p>Appendix context\.<\/p><\/aside>/);
});

test("::bibliography collects citation blocks", () => {
  const html = renderHtml(parse(`::citation{id="src1" source="Briefing" url="https://example.com" accessed="2026-05-24"}\nSource note.\n::\n\n::bibliography{id="refs"}\n::\n`));
  assert.match(html, /<section class="noma-bibliography" id="refs">/);
  assert.match(html, /<h2>Bibliography<\/h2>/);
  assert.match(html, /<li>Briefing - Source note\./);
  assert.match(html, /<a href="https:\/\/example\.com">URL<\/a>/);
  assert.match(html, /Accessed: 2026-05-24/);
});

test("::toc renders a generated section table of contents", () => {
  const html = renderHtml(parse(`# Alpha {id="alpha"}\n\n::toc{id="toc" depth=2}\n::\n\n## Beta {id="beta"}\n`));
  assert.match(html, /<nav class="noma-toc" id="toc" data-depth="2" aria-label="Contents">/);
  assert.match(html, /<li data-level="1"><a href="#alpha">Alpha<\/a><\/li>/);
  assert.match(html, /<li data-level="2"><a href="#beta">Beta<\/a><\/li>/);
});

test("::toc can render generated caption lists", () => {
  const html = renderHtml(parse(`::toc{id="figures" of="figures"}
::

::toc{id="tables" of="tables"}
::

::figure{id="fig1" caption="Adoption curve"}
::

::table{id="scenario-table" caption="Scenario summary" header}
| Case | Return |
| Base | 8% |
::
`));
  assert.match(html, /<nav class="noma-toc noma-toc-figures" id="figures" data-of="figures" aria-label="List of Figures">/);
  assert.match(html, /<li data-kind="figures"><a href="#fig1">Figure: Adoption curve<\/a><\/li>/);
  assert.match(html, /<nav class="noma-toc noma-toc-tables" id="tables" data-of="tables" aria-label="List of Tables">/);
  assert.match(html, /<li data-kind="tables"><a href="#scenario-table">Table: Scenario summary<\/a><\/li>/);
});

test("::header and ::footer render page chrome in HTML", () => {
  const html = renderHtml(parse(`::header{id="h"}\nDraft\n::\n\n::footer{id="f" page_numbers total_pages}\nConfidential\n::\n`));
  assert.match(html, /<header class="noma-page-header" id="h"><p>Draft<\/p><\/header>/);
  assert.match(html, /<footer class="noma-page-footer" id="f" data-page_numbers="true" data-total_pages="true"><p>Confidential<\/p><span class="noma-page-number">Page <span class="noma-page-current">1<\/span> of <span class="noma-page-total">1<\/span><\/span><\/footer>/);
});

test("::page_setup renders print page CSS", () => {
  const html = renderHtml(parse(`::page_setup{id="setup" size="A4" orientation="landscape" margin="12mm" margin_left="20mm"}\n::\n`));
  assert.match(html, /<style class="noma-page-setup" id="setup" data-size="A4" data-orientation="landscape" data-margin="12mm" data-margin_left="20mm">@page \{ size: a4 landscape; margin: 12mm; margin-left: 20mm; \}<\/style>/);
});

test("::change_request renders review revisions in HTML", () => {
  const html = renderHtml(parse(`::change_request{id="cr1" action="replace" target="c1" from="old wording" to="new wording"}\nTighten before handoff.\n::\n`));
  assert.match(html, /<aside class="noma-change-request" id="cr1" data-action="replace" data-target="c1" data-from="old wording" data-to="new wording">/);
  assert.match(html, /<del>old wording<\/del> <ins>new wording<\/ins>/);
  assert.match(html, /<p>Tighten before handoff\.<\/p>/);
});

test("custom directives render readable HTML fallback panels", () => {
  const html = renderHtml(parse(`::finance::position{id="holding-asml" asset_class="equity" region="EU"}
ASML position note.
::

::custom_directive{id="custom-block" last_seen="2026-05-24" noverify}
Custom block note.
::
`));

  assert.match(html, /<aside class="noma-block noma-custom-directive noma-block-finance::position" id="holding-asml"/);
  assert.match(html, /<span class="noma-tag">Finance position<\/span>/);
  assert.match(html, /ASML position note\./);
  assert.match(html, /<span class="noma-meta-key">asset class<\/span> equity/);
  assert.match(html, /<span class="noma-meta-key">region<\/span> EU/);
  assert.doesNotMatch(html, /<span class="noma-tag">finance::position<\/span>/);

  assert.match(html, /<aside class="noma-block noma-custom-directive noma-block-custom_directive" id="custom-block"/);
  assert.match(html, /<span class="noma-tag">Custom directive<\/span>/);
  assert.match(html, /Custom block note\./);
  assert.match(html, /<span class="noma-meta-key">last seen<\/span> 2026-05-24/);
  assert.match(html, /<span><span class="noma-meta-key">noverify<\/span><\/span>/);
});

test("research directives render full semantic metadata in HTML", () => {
  const html = renderHtml(parse(`::claim{id="claim1" confidence=0.7}
Claim body.
::

::citation{id="source1" source="Interview log"}
Source details.
::

::evidence{id="ev1" for="claim1" source="source1" url="https://source.example/report" doi="10.1234/example" accessed="2026-05-24"}
Supporting evidence.
::

::counterevidence{id="ce1" for="claim1" source="https://counter.example/report"}
Contradicting evidence.
::

::risk{id="risk1" severity="high" owner="Research" status="watching"}
Risk body.
::

::decision{id="decision1" status="accepted" owner="Andrea" date="2026-05-24"}
Decision body.
::

::open_question{id="oq1" owner="Ops" due="2026-06-01" status="open"}
Question body.
::

::assumption{id="assumption1" status="active" owner="Strategy" confidence=0.6 source="source1"}
Assumption body.
::
`));

  assert.match(html, /<aside class="noma-research noma-evidence" id="ev1"/);
  assert.match(html, /<span class="noma-meta-key">for<\/span> <a href="#claim1">claim1<\/a>/);
  assert.match(html, /<span class="noma-meta-key">source<\/span> <a href="#source1">source1<\/a>/);
  assert.match(html, /<span class="noma-meta-key">url<\/span> <a href="https:\/\/source\.example\/report">https:\/\/source\.example\/report<\/a>/);
  assert.match(html, /<span class="noma-meta-key">doi<\/span> <a href="https:\/\/doi\.org\/10\.1234\/example">10\.1234\/example<\/a>/);
  assert.match(html, /<span class="noma-meta-key">accessed<\/span> 2026-05-24/);

  assert.match(html, /<aside class="noma-research noma-counterevidence" id="ce1"/);
  assert.match(html, /<span class="noma-meta-key">source<\/span> <a href="https:\/\/counter\.example\/report">https:\/\/counter\.example\/report<\/a>/);

  assert.match(html, /<aside class="noma-research noma-risk" id="risk1"/);
  assert.match(html, /<span class="noma-meta-key">severity<\/span> high/);
  assert.match(html, /<span class="noma-meta-key">owner<\/span> Research/);
  assert.match(html, /<span class="noma-meta-key">status<\/span> watching/);

  assert.match(html, /<aside class="noma-research noma-decision" id="decision1"/);
  assert.match(html, /<span class="noma-meta-key">status<\/span> accepted/);
  assert.match(html, /<span class="noma-meta-key">owner<\/span> Andrea/);
  assert.match(html, /<span class="noma-meta-key">date<\/span> 2026-05-24/);

  assert.match(html, /<aside class="noma-research noma-open_question" id="oq1"/);
  assert.match(html, /<span class="noma-meta-key">owner<\/span> Ops/);
  assert.match(html, /<span class="noma-meta-key">due<\/span> 2026-06-01/);

  assert.match(html, /<aside class="noma-research noma-assumption" id="assumption1"/);
  assert.match(html, /<span class="noma-meta-key">confidence<\/span> 0\.6/);
  assert.match(html, /<span class="noma-meta-key">source<\/span> <a href="#source1">source1<\/a>/);
});

test("review collaboration directives render as structured HTML panels", () => {
  const html = renderHtml(parse(`::claim{id="claim1" confidence=0.7}
Claim body.
::

::citation{id="source1" source="Interview log" url="https://source.example/report"}
Source details.
::

::comment{id="comment1" parent="claim1" author="Andrea" date="2026-05-24T09:00:00Z" status="resolved" resolved_by="Research" resolved_at="2026-05-24T10:00:00Z"}
Tighten this claim.
::

::review{id="review1" for="claim1" status="needs_changes" reviewer="Andrea" due="2026-06-01"}
Tighten the support before sending.
::

::provenance{id="prov1" for="claim1" source="source1" url="https://source.example/report" tool="refresh-agent" by="Research" commit="abc123" at="2026-05-24"}
Updated during source refresh.
::

::confidence{id="conf1" for="claim1" value=0.82 basis="new deployment evidence" source="source1" updated="2026-05-24"}
::
`));

  assert.match(html, /<aside class="noma-comment" id="comment1"/);
  assert.match(html, /<span class="noma-tag">Comment<\/span> <a href="#claim1">claim1<\/a>/);
  assert.match(html, /Tighten this claim\./);
  assert.match(html, /<span class="noma-meta-key">author<\/span> Andrea/);
  assert.match(html, /<span class="noma-meta-key">status<\/span> resolved/);
  assert.match(html, /<span class="noma-meta-key">resolved by<\/span> Research/);

  assert.match(html, /<aside class="noma-review-meta noma-collab-review" id="review1"/);
  assert.match(html, /<span class="noma-tag">Review<\/span> <a href="#claim1">claim1<\/a>/);
  assert.match(html, /Tighten the support before sending\./);
  assert.match(html, /<span class="noma-meta-key">status<\/span> needs_changes/);
  assert.match(html, /<span class="noma-meta-key">reviewer<\/span> Andrea/);

  assert.match(html, /<aside class="noma-review-meta noma-collab-provenance" id="prov1"/);
  assert.match(html, /<span class="noma-tag">Provenance<\/span> <a href="#claim1">claim1<\/a>/);
  assert.match(html, /Updated during source refresh\./);
  assert.match(html, /<span class="noma-meta-key">source<\/span> <a href="#source1">source1<\/a>/);
  assert.match(html, /<span class="noma-meta-key">url<\/span> <a href="https:\/\/source\.example\/report">https:\/\/source\.example\/report<\/a>/);
  assert.match(html, /<span class="noma-meta-key">commit<\/span> abc123/);

  assert.match(html, /<aside class="noma-review-meta noma-collab-confidence" id="conf1"/);
  assert.match(html, /<span class="noma-tag">Confidence<\/span> <a href="#claim1">claim1<\/a>/);
  assert.match(html, /<span class="noma-meta-key">value<\/span> 0\.82/);
  assert.match(html, /<span class="noma-meta-key">basis<\/span> new deployment evidence/);
  assert.match(html, /<span class="noma-meta-key">source<\/span> <a href="#source1">source1<\/a>/);

  assert.doesNotMatch(html, /noma-block-comment/);
  assert.doesNotMatch(html, /noma-block-review/);
  assert.doesNotMatch(html, /noma-block-provenance/);
  assert.doesNotMatch(html, /noma-block-confidence/);
});

test("memory profile directives render as structured HTML panels", () => {
  const html = renderHtml(parse(`::memory_index{id="index"}
- [[user_handle]] - primary handle
- [[project_state]] - current project state
::

::memory{id="user_handle" type="user" confidence=0.95 last_seen="2026-05-09" scope="global" source="profile"}
ferax564 is the public authorship handle.
::

::memory{id="project_state" type="project" confidence=0.8 last_seen="2026-05-20" valid_until="2026-06-30" superseded_by="user_handle" expired}
Project context is tracked as patchable memory.
::
`));

  assert.match(html, /<aside class="noma-memory-index" id="index"/);
  assert.match(html, /<span class="noma-tag">Memory index<\/span>/);
  assert.match(html, /<a class="noma-ref" href="#user_handle">user_handle<\/a>/);
  assert.match(html, /primary handle/);
  assert.doesNotMatch(html, /noma-block-memory_index/);

  assert.match(html, /<aside class="noma-memory noma-memory-user" id="user_handle"/);
  assert.match(html, /<span class="noma-tag">User memory<\/span><h3>user_handle<\/h3>/);
  assert.match(html, /ferax564 is the public authorship handle\./);
  assert.match(html, /<span class="noma-meta-key">type<\/span> user/);
  assert.match(html, /<span class="noma-meta-key">confidence<\/span> 0\.95/);
  assert.match(html, /<span class="noma-meta-key">last seen<\/span> 2026-05-09/);
  assert.match(html, /<span class="noma-meta-key">scope<\/span> global/);
  assert.match(html, /<span class="noma-meta-key">source<\/span> <a href="#profile">profile<\/a>/);

  assert.match(html, /<aside class="noma-memory noma-memory-project" id="project_state"/);
  assert.match(html, /<span class="noma-tag">Project memory<\/span><h3>project_state<\/h3>/);
  assert.match(html, /Project context is tracked as patchable memory\./);
  assert.match(html, /<span class="noma-meta-key">valid until<\/span> 2026-06-30/);
  assert.match(html, /<span class="noma-meta-key">superseded by<\/span> <a href="#user_handle">user_handle<\/a>/);
  assert.match(html, /<span class="noma-meta-key">expired<\/span> true/);
  assert.doesNotMatch(html, /noma-block-memory/);
});

test("technical documentation directives render as structured HTML panels", () => {
  const html = renderHtml(parse(`::api{id="payments-api" title="Payments API" version="v1" base_url="https://api.example.test" status="beta"}
Use this API for payment orchestration.
::

::endpoint{id="create-payment" api="payments-api" method="post" path="/v1/payments" auth="bearer"}
Creates a payment intent.
::

::parameter{id="amount-param" name="amount" in="body" type="integer" required default=100}
Amount in cents.
::

::example{id="create-payment-example" title="Create payment" lang="json" for="create-payment"}
{"amount":100}
::

::query{id="payment-query" title="Recent payments" lang="sql" dataset="payments-api"}
select * from payments limit 10;
::

::instruction{id="agent-instruction" scope="agent" priority="high"}
Patch only the endpoint block that changed.
::

::changelog{id="api-change" version="1.2.0" date="2026-05-24" status="added"}
Added the create-payment endpoint.
::`));

  assert.match(html, /<article class="noma-technical noma-technical-api" id="payments-api"/);
  assert.match(html, /<span class="noma-tag">API<\/span><h3>Payments API<\/h3>/);
  assert.match(html, /<span class="noma-meta-key">base URL<\/span> <a href="https:\/\/api\.example\.test">https:\/\/api\.example\.test<\/a>/);

  assert.match(html, /<article class="noma-technical noma-technical-endpoint" id="create-payment"/);
  assert.match(html, /<span class="noma-tag">Endpoint<\/span><h3>POST \/v1\/payments<\/h3>/);
  assert.match(html, /<span class="noma-meta-key">api<\/span> <a href="#payments-api">payments-api<\/a>/);

  assert.match(html, /<span class="noma-tag">Parameter<\/span><h3>amount<\/h3>/);
  assert.match(html, /<span class="noma-meta-key">required<\/span> true/);

  assert.match(html, /<span class="noma-tag">Example<\/span><h3>Create payment<\/h3>/);
  assert.match(html, /<span class="noma-meta-key">for<\/span> <a href="#create-payment">create-payment<\/a>/);
  assert.match(html, /<pre class="noma-technical-code"><code class="lang-json">\{"amount":100\}<\/code><\/pre>/);

  assert.match(html, /<span class="noma-tag">Query<\/span><h3>Recent payments<\/h3>/);
  assert.match(html, /<span class="noma-meta-key">dataset<\/span> <a href="#payments-api">payments-api<\/a>/);
  assert.match(html, /<pre class="noma-technical-code"><code class="lang-sql">select \* from payments limit 10;<\/code><\/pre>/);

  assert.match(html, /<span class="noma-tag">Instruction<\/span><h3>agent<\/h3>/);
  assert.match(html, /Patch only the endpoint block that changed\./);

  assert.match(html, /<span class="noma-tag">Changelog<\/span><h3>1\.2\.0<\/h3>/);
  assert.match(html, /<span class="noma-meta-key">date<\/span> 2026-05-24/);
  assert.doesNotMatch(html, /noma-block-api/);
  assert.doesNotMatch(html, /noma-block-endpoint/);
});

test("data and computation directives render as structured HTML panels", () => {
  const html = renderHtml(parse(`::citation{id="source-dashboard" source="RevOps dashboard"}
Daily metric pull.
::

::metric{id="nrr" label="NRR" value=122 unit="%" status="green" trend="up" change="+4 pts" target="115%" source="source-dashboard" as_of="2026-05-24"}
Review note for the operating cadence.
::

::metric{id="pipeline"}
$42M
::

::code{id="agent-safe-edit-prompt" lang="text" title="Agent prompt"}
Discover IDs first.
noma patch --ops ops.json --inplace
::

::code_cell{id="cell-1" lang="python" kernel="pyodide" status="cached" execution_count=7}
print("hello")
total = 1 + 2
::

::output{id="cell-1-output" for="cell-1" type="stdout" status="ok"}
hello
3
::`));

  assert.match(html, /<aside class="noma-metric" id="nrr"/);
  assert.match(html, /<span class="noma-tag">Metric<\/span><h3>NRR<\/h3>/);
  assert.match(html, /<div class="noma-metric-value">122%<\/div>/);
  assert.match(html, /Review note for the operating cadence\./);
  assert.match(html, /<span class="noma-meta-key">source<\/span> <a href="#source-dashboard">source-dashboard<\/a>/);
  assert.match(html, /<span class="noma-meta-key">as of<\/span> 2026-05-24/);

  assert.match(html, /<aside class="noma-metric" id="pipeline"/);
  assert.match(html, /<span class="noma-tag">Metric<\/span><h3>pipeline<\/h3>/);
  assert.match(html, /<div class="noma-metric-value">\$42M<\/div>/);
  assert.doesNotMatch(html, /<p>\$42M<\/p>/);

  assert.match(html, /<article class="noma-technical noma-code-block" id="agent-safe-edit-prompt"/);
  assert.match(html, /<span class="noma-tag">Code<\/span><h3>Agent prompt<\/h3>/);
  assert.match(html, /<span class="noma-meta-key">language<\/span> text/);
  assert.match(html, /<pre class="noma-technical-code"><code class="lang-text">Discover IDs first\.\nnoma patch --ops ops\.json --inplace<\/code><\/pre>/);

  assert.match(html, /<article class="noma-technical noma-code-cell" id="cell-1"/);
  assert.match(html, /<span class="noma-tag">Code cell<\/span><h3>python<\/h3>/);
  assert.match(html, /<span class="noma-meta-key">kernel<\/span> pyodide/);
  assert.match(html, /<span class="noma-meta-key">execution<\/span> 7/);
  assert.match(html, /<code class="lang-python">print\("hello"\)\ntotal = 1 \+ 2<\/code>/);

  assert.match(html, /<article class="noma-technical noma-output-block" id="cell-1-output"/);
  assert.match(html, /<span class="noma-tag">Output<\/span><h3>stdout<\/h3>/);
  assert.match(html, /<span class="noma-meta-key">for<\/span> <a href="#cell-1">cell-1<\/a>/);
  assert.match(html, /<code class="lang-stdout">hello\n3<\/code>/);

  assert.doesNotMatch(html, /noma-block-metric/);
  assert.doesNotMatch(html, /noma-block-code_cell/);
  assert.doesNotMatch(html, /noma-block-output/);
});

test("computed directives render interactive HTML artifact blocks", () => {
  const html = renderHtml(parse(`::control{id="growth-rate" type="slider" min=0 max=20 default=8}
label: Growth rate
unit: %
::

::control{id="base-revenue" type="number" default=120}
Base revenue
::

::control{id="scenario" type="select" default=1 options="0.8=Downside,1=Base,1.2=Upside" label="Scenario"}
::

::control{id="include-risk" type="toggle" default=true label="Include risk"}
::

::computed_metric{id="year-5-revenue" formula="base-revenue * pow(1 + growth-rate / 100, 5)" unit="M" title="Year 5 revenue"}
::

::computed_plot{id="projection" type="line"}
formula: base-revenue * pow(1 + growth-rate / 100, year)
domain: year:0..3
title: Projection
::
`), { standalone: true, themeCss: "" });

  assert.match(html, /<div class="noma-control" id="growth-rate"[^>]*data-noma-control="growth-rate"[^>]*data-unit="%"/);
  assert.match(html, /<span class="noma-control-label">Growth rate<\/span><input type="range" name="growth-rate" data-noma-control-input="growth-rate" min="0" max="20" value="8"/);
  assert.match(html, /<output class="noma-control-value" data-noma-control-value="growth-rate">8%<\/output>/);
  assert.match(html, /<span class="noma-control-label">Scenario<\/span><select name="scenario" data-noma-control-input="scenario"><option value="0\.8">Downside<\/option><option value="1" selected>Base<\/option><option value="1\.2">Upside<\/option><\/select>/);
  assert.match(html, /<span class="noma-control-label">Include risk<\/span><input type="checkbox" name="include-risk" data-noma-control-input="include-risk" value="1" checked \/>/);
  assert.match(html, /<output class="noma-control-value" data-noma-control-value="include-risk">1<\/output>/);

  assert.match(html, /<aside class="noma-computed noma-computed-metric" id="year-5-revenue" data-noma-computed="metric" data-unit="M" data-formula=/);
  assert.match(html, /data-formula-ast="/);
  assert.match(html, /<span class="noma-tag">Computed metric<\/span><h3>Year 5 revenue<\/h3>/);
  assert.match(html, /<div class="noma-computed-value" data-noma-computed-value>176\.319[^<]* M<\/div>/);

  assert.match(html, /<figure class="noma-computed noma-computed-plot noma-plot" id="projection" data-noma-computed="plot" data-chart-type="line" data-width="320" data-height="140" data-domain="year:0\.\.3"/);
  assert.match(html, /<figcaption>Projection · <span class="noma-meta-key">type<\/span> line · <span class="noma-meta-key">domain<\/span> year:0\.\.3<\/figcaption>/);
  assert.match(html, /data-noma-computed-plot/);
  assert.match(html, /document\.querySelectorAll\("\[data-noma-computed\]"\)/);
  assert.doesNotMatch(html, /<p>formula:/);
  assert.doesNotMatch(html, /noma-block-computed_metric/);
  assert.doesNotMatch(html, /noma-block-computed_plot/);
});

test("computed directives render inert static controls when interactivity is disabled", () => {
  const html = renderHtml(parse(`::control{id="growth-rate" type="slider" min=0 max=20 default=8}
Growth rate
::

::control{id="scenario" type="select" default=1 options="0.8=Downside,1=Base"}
::

::computed_metric{id="projection" formula="growth-rate * scenario"}
::
`), { standalone: true, themeCss: "", interactive: false });

  assert.doesNotMatch(html, /<script\b/);
  assert.equal(html.match(/interactive controls disabled in strict mode/g)?.length, 1);
  assert.match(html, /<input type="range" name="growth-rate" data-noma-control-input="growth-rate" min="0" max="20" value="8" disabled \/>/);
  assert.match(html, /<select name="scenario" data-noma-control-input="scenario" disabled><option value="0\.8">Downside<\/option><option value="1" selected>Base<\/option><\/select>/);
  assert.match(html, /<div class="noma-computed-value" data-noma-computed-value>8<\/div>/);
});

test("frontmatter parsed into meta", () => {
  const doc = parse(`---\ntitle: Hello\nauthor: ferax564\n---\n\n# Body\n`);
  assert.equal(doc.meta.title, "Hello");
  assert.equal(doc.meta.author, "ferax564");
});

test("headings fold into nested sections with stable ids", () => {
  const doc = parse(`# A\n\n## B\n\nbody\n\n## C\n\nbody\n`);
  assert.equal(doc.children.length, 1);
  const a = doc.children[0] as SectionNode;
  assert.equal(a.type, "section");
  assert.equal(a.id, "a");
  assert.equal(a.children.length, 2);
  assert.equal((a.children[0] as SectionNode).id, "b");
  assert.equal((a.children[1] as SectionNode).id, "c");
});

test("directive block parses with attributes", () => {
  const doc = parse(`::claim{id="c1" confidence=0.82}\nClaim body.\n::\n`);
  const node = doc.children[0] as DirectiveNode;
  assert.equal(node.type, "directive");
  assert.equal(node.name, "claim");
  assert.equal(node.id, "c1");
  assert.equal(node.attrs.confidence, 0.82);
  assert.equal(node.body, "Claim body.");
});

test("namespaced directive block parses for community packs", () => {
  const doc = parse(`::finance::position{id="p1" ticker="ASML"}\nLong.\n::\n`);
  const node = doc.children[0] as DirectiveNode;
  assert.equal(node.type, "directive");
  assert.equal(node.name, "finance::position");
  assert.equal(node.id, "p1");
  assert.equal(node.attrs.ticker, "ASML");
  assert.equal(node.body, "Long.");
});

test("nested directives via colon counting", () => {
  const src = `::grid{columns=2}\n:::card{title="A"}\nleft\n:::\n\n:::card{title="B"}\nright\n:::\n::\n`;
  const doc = parse(src);
  const grid = doc.children[0] as DirectiveNode;
  assert.equal(grid.name, "grid");
  assert.equal(grid.children.length, 2);
  const cardA = grid.children[0] as DirectiveNode;
  assert.equal(cardA.name, "card");
  assert.equal(cardA.attrs.title, "A");
});

test("inline markup survives in HTML output", () => {
  const doc = parse(`This is **bold** and *em* and \`code\`.\n`);
  const html = renderHtml(doc);
  assert.match(html, /<strong>bold<\/strong>/);
  assert.match(html, /<em>em<\/em>/);
  assert.match(html, /<code>code<\/code>/);
});

test("LLM renderer emits typed tags", () => {
  const doc = parse(`::claim{id="c1" confidence=0.5}\nHello.\n::\n`);
  const out = renderLlm(doc);
  assert.match(out, /\[CLAIM/);
  assert.match(out, /id="c1"/);
  assert.match(out, /\[\/CLAIM\]/);
});

test("validator catches duplicate IDs", () => {
  const doc = parse(`::claim{id="x"}\na\n::\n\n::claim{id="x"}\nb\n::\n`);
  const diagnostics = validate(doc);
  assert.ok(diagnostics.some((d) => d.code === "duplicate-id"));
});

test("validator catches broken evidence reference", () => {
  const doc = parse(`::evidence{for="missing"}\nbody\n::\n`);
  const diagnostics = validate(doc);
  assert.ok(diagnostics.some((d) => d.code === "broken-reference"));
});

test("validator catches plot without data", () => {
  const doc = parse(`::plot{title="x"}\n::\n`);
  const diagnostics = validate(doc);
  assert.ok(diagnostics.some((d) => d.code === "plot-missing-data"));
});

test("github-style tables parse and render", () => {
  const src = `# T\n\n| A | B | C |\n| :--- | :---: | ---: |\n| 1 | 2 | 3 |\n| **a** | b | c |\n`;
  const doc = parse(src);
  const section = doc.children[0] as SectionNode;
  const table = section.children[0] as TableNode;
  assert.equal(table.type, "table");
  assert.deepEqual(table.header, ["A", "B", "C"]);
  assert.deepEqual(table.align, ["left", "center", "right"]);
  assert.equal(table.rows.length, 2);
  assert.equal(table.rows[1]?.[0], "**a**");

  const html = renderHtml(doc);
  assert.match(html, /<table class="noma-table">/);
  assert.match(html, /<th style="text-align: center">B<\/th>/);
  assert.match(html, /<td style="text-align: right">3<\/td>/);
  assert.match(html, /<strong>a<\/strong>/);

  const llm = renderLlm(doc);
  assert.match(llm, /\| A\s+\| B\s+\| C\s+\|/);
  assert.match(llm, /\| 1\s+\| 2\s+\| 3\s+\|/);
});

test("standalone HTML wraps with theme", () => {
  const doc = parse(`# Hello\n`);
  const html = renderHtml(doc, { standalone: true, themeCss: "body{color:red}" });
  assert.match(html, /<!doctype html>/);
  assert.match(html, /color:red/);
});

test("variant attribute lands as data-variant on cards/callouts/research", () => {
  const doc = parse(
    `::card{title="X" variant="important"}\nA\n::\n\n::callout{tone="info" variant="subtle"}\nB\n::\n\n::claim{id="c1" variant="danger"}\nC\n::\n`,
  );
  const html = renderHtml(doc);
  assert.match(html, /class="noma-card"[^>]*data-variant="important"/);
  assert.match(html, /class="noma-callout[^"]*"[^>]*data-variant="subtle"/);
  assert.match(html, /class="noma-research noma-claim"[^>]*data-variant="danger"/);
});
