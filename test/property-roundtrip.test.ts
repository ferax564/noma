import { test } from "node:test";
import assert from "node:assert/strict";
import { parse } from "../src/parser.js";
import { renderNoma } from "../src/renderer-noma.js";
import { isDirective, walk, type AttrValue, type DirectiveNode, type DocumentNode } from "../src/ast.js";
import { findById, patchSource, PatchError } from "../src/patch.js";

/**
 * Deterministic property tests: a seeded generator of random-but-valid Noma
 * documents exercises parse → renderNoma → parse and random block-level
 * patches. A failure prints the seed and source so it can be replayed.
 */

function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

class Gen {
  private readonly next: () => number;
  private counter = 0;
  constructor(seed: number) {
    this.next = rng(seed);
  }
  int(n: number): number {
    return Math.floor(this.next() * n);
  }
  chance(p: number): boolean {
    return this.next() < p;
  }
  pick<T>(items: readonly T[]): T {
    return items[this.int(items.length)]!;
  }
  uid(prefix: string): string {
    this.counter += 1;
    return `${prefix}-${this.counter}`;
  }
}

const WORDS = [
  "alpha", "beta", "gamma", "delta", "Noma", "agents", "edit", "blocks", "safely",
  "日本語", "Привет", "café", "naïve", "Straße", "μ-law", "**bold**", "*em*", "`code`",
  "[link](https://example.com)", "[[ref]]", "a:b", "x=1", "{curly}", "\"quoted\"", "it's",
  "::inline", "50%", "C:\\path", "->", "#tag", "|pipe|",
];

const TITLES = [
  "Intro", "Risks", "日本語", "Привет мир", "Set {a, b}", "Map {x}", "Café au lait",
  "API: v2 (beta)", "???", "Ünïcödé Title", "العربية", "한국어 문서", "Risks", "Intro",
];

const ATTR_VALUES: readonly AttrValue[] = [
  "plain", "2024", "1.10", "true", "false", "", "with space", "he said \"hi\"", "it's",
  "both \"double\" and 'single'", "back\\slash", "trailing\\", "a\\\"b", "brace}", "x=y",
  "日本", "C:\\dir\\", 3, 0.5, -2, 0, true, false,
];

const DIRECTIVE_NAMES = ["claim", "card", "note", "callout", "evidence", "grid", "finance::position"];

const CODE_LINES = ["plain code", "::", ":::card{id=\"x\"}", "# not a heading", "```", "````js", "~~~", "  indented", "{#fake}", "- not a list", ""];

function words(g: Gen, min: number, max: number): string {
  const n = min + g.int(max - min + 1);
  const out: string[] = [];
  for (let i = 0; i < n; i++) out.push(g.pick(WORDS));
  return `${g.pick(["Start", "The", "Some", "Each", "Ни", "日本"])} ${out.join(" ")}`.trim();
}

function attrKey(g: Gen, used: Set<string>): string {
  for (;;) {
    const key = g.pick(["title", "status", "confidence", "owner", "note", "data-x", "_private", "tone", "version", "n"]);
    if (!used.has(key)) {
      used.add(key);
      return key;
    }
    if (used.size >= 10) return g.uid("k");
  }
}

function serializeValue(key: string, value: AttrValue): string {
  if (value === true) return key;
  if (value === false) return `${key}=false`;
  if (typeof value === "number") return `${key}=${value}`;
  if (value.includes('"') && !value.includes("'")) return `${key}='${value}'`;
  return `${key}="${value.replace(/\\(?=[\\"]|$)/g, "\\\\").replace(/"/g, '\\"')}"`;
}

function genAttrs(g: Gen, withId: boolean): string {
  const used = new Set<string>(["id"]);
  const parts: string[] = [];
  if (withId) parts.push(`id="${g.uid("d")}"`);
  const n = g.int(4);
  for (let i = 0; i < n; i++) parts.push(serializeValue(attrKey(g, used), g.pick(ATTR_VALUES)));
  if (parts.length === 0 && g.chance(0.5)) return "";
  return `{${parts.join(" ")}}`;
}

function genCode(g: Gen): string {
  const lines: string[] = [];
  const n = g.int(4);
  for (let i = 0; i < n; i++) lines.push(g.pick(CODE_LINES));
  const tilde = g.chance(0.3);
  const ch = tilde ? "~" : "`";
  const longest = Math.max(0, ...lines.map((l) => (l.startsWith(ch) ? /^[`~]*/.exec(l)![0].length : 0)));
  const fence = ch.repeat(Math.max(3, longest + 1));
  const lang = g.pick(["", "js", "c++", "noma", "sh"]);
  return [`${fence}${lang}`, ...lines, fence].join("\n");
}

function genList(g: Gen): string {
  const ordered = g.chance(0.4);
  const n = 1 + g.int(3);
  const items: string[] = [];
  for (let i = 0; i < n; i++) {
    const id = g.chance(0.4) ? `{#${g.uid("li")}} ` : "";
    items.push(`${ordered ? `${i + 1}.` : "-"} ${id}${words(g, 1, 4)}`);
  }
  return items.join("\n");
}

function genParagraph(g: Gen): string {
  const lines = 1 + g.int(2);
  const out: string[] = [];
  for (let i = 0; i < lines; i++) out.push(words(g, 1, 6));
  const text = out.join("\n");
  return g.chance(0.3) ? `{#${g.uid("p")}}\n${text}` : text;
}

function genQuote(g: Gen): string {
  return [`> ${words(g, 1, 4)}`, g.chance(0.3) ? ">" : `> ${words(g, 1, 3)}`].join("\n");
}

function genTable(g: Gen): string {
  const cols = 1 + g.int(3);
  const row = () => `| ${Array.from({ length: cols }, () => g.pick(["a", "b", "日本", "**x**", "1"])).join(" | ")} |`;
  const sep = `| ${Array.from({ length: cols }, () => g.pick(["---", ":---", "---:", ":---:"])).join(" | ")} |`;
  return [row(), sep, row()].join("\n");
}

function genHeading(g: Gen, level: number): string {
  const title = g.pick(TITLES);
  const roll = g.int(6);
  if (roll === 0) return `${"#".repeat(level)} ${title} {id="${g.uid("h")}"}`;
  if (roll === 1) return `${"#".repeat(level)} ${title} {id="${g.uid("h")}" aliases="${g.uid("al")},${g.uid("al")}"}`;
  if (roll === 2) return `${"#".repeat(level)} ${title} {k=v} {id="${g.uid("h")}"}`;
  return `${"#".repeat(level)} ${title}`;
}

function genDirective(g: Gen, colons: number, depth: number): string {
  const fence = ":".repeat(colons);
  const open = `${fence}${g.pick(DIRECTIVE_NAMES)}${genAttrs(g, g.chance(0.8))}`;
  const children: string[] = [];
  const n = g.int(3);
  for (let i = 0; i < n; i++) children.push(genBlock(g, colons + 1, depth + 1, false));
  return [open, ...(children.length ? [children.join("\n\n")] : []), fence].join("\n");
}

function genBlock(g: Gen, colons: number, depth: number, topLevel: boolean): string {
  const roll = g.int(topLevel ? 10 : 8);
  if (roll <= 1) return genParagraph(g);
  if (roll === 2) return genList(g);
  if (roll === 3) return genCode(g);
  if (roll === 4) return genQuote(g);
  if (roll === 5) return depth < 3 ? genDirective(g, colons, depth) : genParagraph(g);
  if (roll === 6) return genTable(g);
  if (roll === 7) return depth < 3 ? genDirective(g, colons, depth) : genList(g);
  if (roll === 8) return genHeading(g, 1 + g.int(3));
  return "***";
}

function genDoc(seed: number): string {
  const g = new Gen(seed);
  const parts: string[] = [];
  if (g.chance(0.3)) parts.push(`---\ntitle: Doc ${seed}\ntags: [a, b]\n---`);
  const n = 1 + g.int(8);
  for (let i = 0; i < n; i++) parts.push(genBlock(g, 2, 0, true));
  return `${parts.join("\n\n")}\n`;
}

function stripPositions(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stripPositions);
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (k === "pos" || k === "endLine") continue;
      out[k] = stripPositions(v);
    }
    return out;
  }
  return value;
}

function ids(doc: DocumentNode): string[] {
  const out: string[] = [];
  for (const node of walk(doc)) if (node.id) out.push(`${node.type}:${node.id}`);
  return out;
}

function directivesWithIds(doc: DocumentNode): DirectiveNode[] {
  return [...walk(doc)].filter((n): n is DirectiveNode => isDirective(n) && typeof n.id === "string");
}

const SEEDS = Number(process.env.NOMA_PROPERTY_SEEDS) || 400;

test("property: parse → renderNoma → parse preserves the AST (minus positions)", () => {
  const seen = { directives: 0, nested: 0, code: 0, unicodeSections: 0, quotedAttrs: 0 };
  for (let seed = 1; seed <= SEEDS; seed++) {
    const source = genDoc(seed);
    const first = parse(source);
    for (const node of walk(first)) {
      if (isDirective(node)) {
        seen.directives++;
        if (node.children.some(isDirective)) seen.nested++;
        if (Object.values(node.attrs).some((v) => typeof v === "string" && /["'\\]/.test(v))) seen.quotedAttrs++;
      }
      if (node.type === "code") seen.code++;
      if (node.type === "section" && /[^\x00-\x7f]/.test(node.id ?? "")) seen.unicodeSections++;
    }
    const rendered = renderNoma(first);
    const second = parse(rendered);
    assert.deepEqual(
      stripPositions(second),
      stripPositions(first),
      `seed ${seed}\n--- source ---\n${source}\n--- rendered ---\n${rendered}`,
    );
    assert.equal(renderNoma(second), rendered, `renderNoma is not idempotent for seed ${seed}`);
  }
  for (const [k, n] of Object.entries(seen)) assert.ok(n >= 20, `generator coverage too low for ${k}: ${n}`);
});

test("property: random update_attribute patches never disturb untouched blocks", () => {
  for (let seed = 1; seed <= SEEDS; seed++) {
    const g = new Gen(seed * 7919);
    const source = genDoc(seed);
    const before = parse(source);
    const targets = directivesWithIds(before);
    if (targets.length === 0) continue;
    const target = g.pick(targets);
    const key = g.pick(["status", "confidence", "note", "owner", "data-x", "fresh_key"]);
    const value = g.pick(ATTR_VALUES);
    const after = patchSource(source, { op: "update_attribute", id: target.id!, key, value });
    const parsed = parse(after);
    const context = `seed ${seed} target ${target.id} ${key}=${JSON.stringify(value)}\n${source}\n---\n${after}`;
    assert.deepEqual(ids(parsed), ids(before), context);
    const updated = findById(parsed, target.id!);
    assert.ok(updated && isDirective(updated), context);
    assert.deepEqual(updated.attrs[key], value, context);
    for (const other of directivesWithIds(before)) {
      if (other.id === target.id) continue;
      const now = findById(parsed, other.id!);
      assert.ok(now && isDirective(now), context);
      assert.deepEqual(now.attrs, other.attrs, context);
    }
    const src2 = after.split("\n");
    const orig = source.split("\n");
    const line = (target.pos?.line ?? 1) - 1;
    assert.deepEqual(
      src2.filter((_l, i) => i !== line),
      orig.filter((_l, i) => i !== line),
      `update_attribute touched more than the open line: ${context}`,
    );
  }
});

const BODY_LINES = ["new text", "::", ":::", "::::", "```", "~~~", ":::note{id=\"inner\"}", "# heading", "", "- item", "::claim{id=\"evil\"}"];

test("property: random replace_body either stays inside the target or is rejected", () => {
  let accepted = 0;
  let rejected = 0;
  for (let seed = 1; seed <= SEEDS; seed++) {
    const g = new Gen(seed * 104729);
    const source = genDoc(seed);
    const before = parse(source);
    const bodyOnly = directivesWithIds(before).filter(
      (d) => d.children.length === 0 || (d.children.length === 1 && d.children[0]?.type === "paragraph"),
    );
    if (bodyOnly.length === 0) continue;
    const target = g.pick(bodyOnly);
    const lines = Array.from({ length: 1 + g.int(4) }, () => g.pick(BODY_LINES));
    const content = lines.join("\n");
    let after: string;
    try {
      after = patchSource(source, { op: "replace_body", id: target.id!, content });
    } catch (err) {
      assert.ok(err instanceof PatchError, String(err));
      assert.equal(err.code, "unbalanced_fence_content", `seed ${seed}: ${err.message}`);
      rejected++;
      continue;
    }
    accepted++;
    const parsed = parse(after);
    const context = `seed ${seed} target ${target.id} content ${JSON.stringify(content)}\n${source}\n---\n${after}`;
    const replaced = new Set([...walk(target)].map((n) => `${n.type}:${n.id ?? ""}`));
    const survivors = ids(before).filter((id) => !replaced.has(id));
    const now = new Set(ids(parsed));
    for (const id of survivors) assert.ok(now.has(id), `${id} lost; ${context}`);
    const node = findById(parsed, target.id!);
    assert.ok(node && isDirective(node) && node.name === target.name, context);
    assert.equal(node.pos?.line, target.pos?.line, context);
  }
  assert.ok(accepted >= 20 && rejected >= 20, `coverage: ${accepted} accepted, ${rejected} rejected`);
});
