import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import type { DirectiveNode, Node } from "../src/ast.js";
import { parse } from "../src/parser.js";
import { validate } from "../src/validator.js";
import { renderHtml, renderSlidesHtml } from "../src/renderer-html.js";
import { renderMarkdown } from "../src/renderer-markdown.js";
import { renderLlm } from "../src/renderer-llm.js";
import { renderNoma } from "../src/renderer-noma.js";
import { renderPaperDom } from "../src/renderer-paperdom.js";
import { componentKitFromSource, componentUseSource, expandComponents, readComponentDefinition } from "../src/components.js";

const KIT = `::component{name="pricing_card" props="plan,price,cta?" slots="features"}
:::card{title="{{plan}}" class="elevated"}
**{{price}}**

{{slot:features}}

{{cta}}
:::
::

::component{name="pair" props="left,right"}
:::card{id="l" title="{{left}}"}
x
:::

:::card{id="r" title="{{right}}"}
y
:::
::
`;

const PAGE = `# Plans

::pricing_card{id="team" plan="Team" price="$8" class="tone-accent"}
:::slot{name="features"}
- Unlimited spaces
:::
::

::pricing_card{plan="Free" price="$0"}
::
`;

function directives(nodes: Node[]): DirectiveNode[] {
  const out: DirectiveNode[] = [];
  const visit = (list: Node[]): void => {
    for (const node of list) {
      if (node.type === "directive") out.push(node);
      if (node.type === "directive" || node.type === "section" || node.type === "document") visit(node.children);
    }
  };
  visit(nodes);
  return out;
}

test("definitions parse props, optional props, slots, and reject shadowing core blocks", () => {
  const kit = componentKitFromSource(KIT);
  const card = kit.get("pricing_card");
  assert.ok(card);
  assert.deepEqual(card.props, [{ name: "plan", optional: false }, { name: "price", optional: false }, { name: "cta", optional: true }]);
  assert.deepEqual(card.slots, ["features"]);
  const shadow = readComponentDefinition(parse(`::component{name="card"}\nx\n::\n`).children[0] as DirectiveNode);
  assert.ok("message" in shadow && /shadow the core ::card/.test(shadow.message));
  const badProp = readComponentDefinition(parse(`::component{name="ok_name" props="id"}\nx\n::\n`).children[0] as DirectiveNode);
  assert.ok("message" in badProp && /invalid prop "id"/.test(badProp.message));
});

test("expansion substitutes props and slots on the AST, adopts the use's id and tokens, and never mutates input", () => {
  const doc = parse(PAGE);
  const before = JSON.stringify(doc);
  const kit = componentKitFromSource(KIT);
  const expanded = expandComponents(doc, { kit, wrap: false });
  assert.equal(JSON.stringify(doc), before);
  const cards = directives(expanded.children).filter((d) => d.name === "card");
  assert.equal(cards.length, 2);
  assert.equal(cards[0]!.attrs.title, "Team");
  assert.equal(cards[0]!.id, "team");
  assert.equal(cards[0]!.attrs.class, "elevated tone-accent");
  const teamText = JSON.stringify(cards[0]!.children);
  assert.match(teamText, /\*\*\$8\*\*/);
  assert.match(teamText, /Unlimited spaces/);
  assert.equal(cards[1]!.id, undefined, "a use without an id yields no id");
  assert.doesNotMatch(JSON.stringify(cards[1]!.children), /\{\{cta\}\}/, "an empty optional prop drops its placeholder-only paragraph");
});

test("prop values cannot inject structure", () => {
  const kit = componentKitFromSource(KIT);
  const doc = parse(`::pricing_card{id="x" plan="A\\" onmouseover=\\"alert(1)" price="::html\\n<script>alert(1)</script>\\n::"}\n::\n`);
  const html = renderHtml(doc, { components: kit, standalone: false, allowEscapeHatches: true });
  assert.doesNotMatch(html, /<script>/);
  assert.doesNotMatch(html, /<[^>]*\sonmouseover=/, "a prop value never becomes an attribute");
  assert.equal(directives(expandComponents(doc, { kit }).children).filter((d) => d.name === "html").length, 0);
});

test("multi-root templates scope template ids per use, so repeated uses never collide", () => {
  const kit = componentKitFromSource(KIT);
  const doc = parse(`::pair{id="a" left="L1" right="R1"}\n::\n\n::pair{id="b" left="L2" right="R2"}\n::\n`);
  const html = renderHtml(doc, { components: kit, standalone: false });
  for (const id of ["a--l", "a--r", "b--l", "b--r"]) assert.match(html, new RegExp(`id="${id}"`));
  assert.match(html, /<div class="noma-component" data-component="pair" id="a">/);
});

test("HTML renders uses, and kit pages show definitions with visible placeholders", () => {
  const kit = componentKitFromSource(KIT);
  const html = renderHtml(parse(PAGE), { components: kit, standalone: false });
  assert.match(html, /<div class="noma-component noma-component-single" data-component="pricing_card"><article class="noma-card n-elevated n-tone-accent" id="team"/);
  const kitHtml = renderHtml(parse(KIT), { standalone: false });
  assert.match(kitHtml, /<code>pricing_card\(plan, price, cta\?\) \[features\]<\/code>/);
  assert.match(kitHtml, /\{\{slot:features\}\}/);
});

test("document-local definitions work without a host kit, and definitions stay out of handoff targets", () => {
  const doc = parse(`${KIT}\n${PAGE}`);
  assert.match(renderHtml(doc, { standalone: false }), /id="team"/);
  const md = renderMarkdown(doc);
  assert.match(md, /### Team/);
  assert.doesNotMatch(md, /\{\{plan\}\}/);
  const slides = renderSlidesHtml(doc);
  assert.doesNotMatch(slides, /noma-component-definition/);
  const paper = JSON.stringify(renderPaperDom(doc));
  assert.match(paper, /Unlimited spaces/);
  assert.doesNotMatch(paper, /\{\{price\}\}/);
});

test("LLM context and .noma source keep the compact component call", () => {
  const doc = parse(PAGE);
  const llm = renderLlm(doc);
  assert.match(llm, /\[PRICING_CARD id="team" plan="Team" price="\$8" class="tone-accent"\]/);
  assert.equal(renderNoma(doc).includes("::pricing_card{"), true);
});

test("cycles and runaway nesting render a warning instead of recursing", () => {
  const doc = parse(`::component{name="loop_a"}\n:::loop_b\n:::\n::\n\n::component{name="loop_b"}\n:::loop_a\n:::\n::\n\n::loop_a\n::\n`);
  const html = renderHtml(doc, { standalone: false });
  assert.match(html, /component cycle: loop_a → loop_b → loop_a/);
});

test("validator checks uses against the kit and skips template placeholders", () => {
  const kit = componentKitFromSource(KIT);
  const doc = parse(`::pricing_card{id="p" plan="Pro" colour="red"}\n:::slot{name="extras"}\nx\n:::\n::\n`);
  const codes = validate(doc, { components: kit }).map((d) => `${d.severity}:${d.code}`);
  assert.ok(codes.includes("error:component-missing-prop"));
  assert.ok(codes.includes("warning:component-unknown-prop"));
  assert.ok(codes.includes("warning:component-unknown-slot"));
  assert.deepEqual(validate(parse(KIT)).filter((d) => d.severity !== "info"), [], "templates with placeholders and scoped ids validate clean");
  const invalid = validate(parse(`::component{name="Bad"}\nx\n::\n\n::component{name="twice"}\nx\n::\n\n::component{name="twice"}\ny\n::\n`)).map((d) => d.code);
  assert.ok(invalid.includes("component-invalid-definition"));
  assert.ok(invalid.includes("component-duplicate"));
  const profiled = validate(parse(`---\nprofile: minimal\n---\n\n${KIT}\n${PAGE}`)).map((d) => d.code);
  assert.ok(!profiled.includes("out-of-profile-directive"), "kit plumbing and uses are allowed under profiles");
});

test("componentUseSource scaffolds required props and named slots", () => {
  const kit = componentKitFromSource(KIT);
  const source = componentUseSource(kit.get("pricing_card")!, "plan-1");
  assert.equal(source, `::pricing_card{id="plan-1" plan="" price=""}\n:::slot{name="features"}\n\n:::\n::`);
  assert.ok(!validate(parse(source), { components: kit }).some((d) => d.code === "component-unknown-slot"));
});

test("the example kit and pricing page validate and render", () => {
  const kitSource = readFileSync("examples/kit/kit.noma", "utf8");
  const kit = componentKitFromSource(kitSource);
  assert.deepEqual([...kit.keys()], ["pricing_card", "stat", "feature"]);
  const page = parse(readFileSync("examples/kit/pricing.noma", "utf8"));
  assert.equal(validate(page, { components: kit }).filter((d) => d.severity === "error").length, 0);
  assert.match(renderHtml(page, { components: kit, standalone: false }), /id="plan-enterprise"/);
});
