import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join, relative } from "node:path";
import { parse } from "./parser.js";
import { renderNoma } from "./renderer-noma.js";
import { validate } from "./validator.js";
import { walk } from "./ast.js";
import { patchSource, PatchError, type PatchOp } from "./patch.js";

export interface FixtureReport {
  name: string;
  status: "pass" | "fail" | "skip";
  error?: string;
}

export interface VerifyReport {
  ok: boolean;
  fixtures: FixtureReport[];
}

function listFixtures(root: string): string[] {
  const out: string[] = [];
  const walkDir = (dir: string) => {
    for (const entry of readdirSync(dir)) {
      const p = join(dir, entry);
      const s = statSync(p);
      if (s.isDirectory()) {
        if (existsSync(join(p, "input.noma"))) {
          out.push(p);
        } else {
          walkDir(p);
        }
      }
    }
  };
  walkDir(root);
  return out.sort();
}

function checkIds(doc: ReturnType<typeof parse>, expectedPath: string): string | null {
  const expected = JSON.parse(readFileSync(expectedPath, "utf8")) as {
    canonical: string[];
    aliases: Record<string, string[]>;
  };
  const canonical: string[] = [];
  const aliases: Record<string, string[]> = {};
  for (const node of walk(doc)) {
    if ("id" in node && node.id) {
      canonical.push(node.id);
      if (node.aliases?.length) aliases[node.id] = [...node.aliases];
    }
  }
  if (JSON.stringify(canonical.sort()) !== JSON.stringify([...expected.canonical].sort())) {
    return `ids mismatch: got ${JSON.stringify(canonical)}, expected ${JSON.stringify(expected.canonical)}`;
  }
  for (const k of Object.keys(expected.aliases)) {
    if (JSON.stringify((aliases[k] ?? []).sort()) !== JSON.stringify([...expected.aliases[k]!].sort())) {
      return `aliases mismatch for ${k}`;
    }
  }
  return null;
}

function checkDiagnostics(doc: ReturnType<typeof parse>, expectedPath: string): string | null {
  const expected = JSON.parse(readFileSync(expectedPath, "utf8")) as { code: string; severity: string }[];
  const got = validate(doc).map((d) => ({ code: d.code, severity: d.severity }));
  const norm = (xs: { code: string; severity: string }[]) =>
    xs.map((x) => `${x.severity}:${x.code}`).sort();
  if (JSON.stringify(norm(got)) !== JSON.stringify(norm(expected))) {
    return `diagnostics mismatch: got ${JSON.stringify(got)}, expected ${JSON.stringify(expected)}`;
  }
  return null;
}

function checkRoundtrip(source: string, expectedPath: string): string | null {
  const doc = parse(source);
  const rendered = renderNoma(doc);
  const expected = readFileSync(expectedPath, "utf8");
  if (rendered !== expected) {
    return `roundtrip mismatch: render-noma output differs from expected.roundtrip.noma`;
  }
  const reparsed = parse(rendered);
  if (JSON.stringify(reparsed) !== JSON.stringify(doc)) {
    return `roundtrip property failed: parse(render-noma(parse(x))) !== parse(x)`;
  }
  return null;
}

function checkSpans(doc: ReturnType<typeof parse>, expectedPath: string): string | null {
  const expected = JSON.parse(readFileSync(expectedPath, "utf8")) as Record<
    string,
    { startLine: number; endLine: number }
  >;
  for (const node of walk(doc)) {
    if (!("id" in node) || !node.id) continue;
    const want = expected[node.id];
    if (!want) continue;
    const gotStart = node.pos?.line;
    const gotEnd = node.endLine;
    if (gotStart !== want.startLine || gotEnd !== want.endLine) {
      return `span mismatch for "${node.id}": got [${gotStart}, ${gotEnd}], expected [${want.startLine}, ${want.endLine}]`;
    }
  }
  return null;
}

function checkPatch(source: string, fixturePath: string): string | null {
  const patchPath = join(fixturePath, "patch.json");
  const postPath = join(fixturePath, "expected.post.noma");
  const errorPath = join(fixturePath, "expected.error.json");
  if (!existsSync(patchPath)) return null;
  const raw = JSON.parse(readFileSync(patchPath, "utf8")) as PatchOp | PatchOp[];
  const ops = Array.isArray(raw) ? raw : [raw];

  if (existsSync(errorPath)) {
    const expected = JSON.parse(readFileSync(errorPath, "utf8")) as { code: string };
    try {
      let cur = source;
      for (const op of ops) cur = patchSource(cur, op);
    } catch (err) {
      if (err instanceof PatchError) {
        return err.code === expected.code
          ? null
          : `error code mismatch: got "${err.code}", expected "${expected.code}"`;
      }
      return `expected PatchError("${expected.code}"), got ${(err as Error).name}: ${(err as Error).message}`;
    }
    return `expected PatchError("${expected.code}"), but patch succeeded`;
  }

  if (!existsSync(postPath)) return null;
  let cur = source;
  for (const op of ops) {
    cur = patchSource(cur, op);
  }
  const expected = readFileSync(postPath, "utf8");
  if (cur !== expected) {
    return `patch output mismatch: got\n${cur}\n--- expected ---\n${expected}`;
  }
  return null;
}

function checkOne(fixturePath: string): FixtureReport {
  const name = relative(process.cwd(), fixturePath);
  const inputPath = join(fixturePath, "input.noma");
  const source = readFileSync(inputPath, "utf8");
  const doc = parse(source);

  const idsPath = join(fixturePath, "expected.ids.json");
  if (existsSync(idsPath)) {
    const err = checkIds(doc, idsPath);
    if (err) return { name, status: "fail", error: err };
  }
  const diagsPath = join(fixturePath, "expected.diagnostics.json");
  if (existsSync(diagsPath)) {
    const err = checkDiagnostics(doc, diagsPath);
    if (err) return { name, status: "fail", error: err };
  }
  const rtPath = join(fixturePath, "expected.roundtrip.noma");
  if (existsSync(rtPath)) {
    const err = checkRoundtrip(source, rtPath);
    if (err) return { name, status: "fail", error: err };
  }
  const spansPath = join(fixturePath, "expected.spans.json");
  if (existsSync(spansPath)) {
    const err = checkSpans(doc, spansPath);
    if (err) return { name, status: "fail", error: err };
  }
  const err = checkPatch(source, fixturePath);
  if (err) return { name, status: "fail", error: err };
  return { name, status: "pass" };
}

export function verifyFixtureDir(root: string): VerifyReport {
  const fixtures = listFixtures(root).map(checkOne);
  return { ok: fixtures.every((f) => f.status === "pass"), fixtures };
}
