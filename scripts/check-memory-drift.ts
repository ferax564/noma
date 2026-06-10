/**
 * Drift gate for the project-memory files (CLAUDE.md / AGENTS.md).
 *
 * Fails when:
 *   1. the two files' "Repo Layout" or "Useful Commands" blocks diverge,
 *   2. a path named in the layout block no longer exists on disk,
 *   3. a tracked top-level entry or src/*.ts file is missing from the layout.
 *
 * Run via `npm run check:memory` (CI runs it on every push).
 */
import { execSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync } from "node:fs";

let failures = 0;
const fail = (msg: string): void => {
  failures++;
  console.error(`✗ ${msg}`);
};

function fencedBlock(text: string, heading: string, file: string): string {
  const re = new RegExp(`## ${heading}\\n\\n\`\`\`[a-z]*\\n([\\s\\S]*?)\\n\`\`\``);
  const m = text.match(re);
  if (!m) {
    fail(`${file}: missing "## ${heading}" fenced block`);
    return "";
  }
  return m[1] ?? "";
}

const claude = readFileSync("CLAUDE.md", "utf8");
const agents = readFileSync("AGENTS.md", "utf8");

for (const heading of ["Repo Layout", "Useful Commands"]) {
  const a = fencedBlock(claude, heading, "CLAUDE.md");
  const b = fencedBlock(agents, heading, "AGENTS.md");
  if (a && b && a !== b) {
    fail(`CLAUDE.md and AGENTS.md "${heading}" blocks diverge — keep them identical`);
  }
}

const layout = fencedBlock(claude, "Repo Layout", "CLAUDE.md");

interface MentionSets {
  topLevel: Set<string>;
  srcFiles: Set<string>;
  srcGlobs: string[];
}

function parseLayout(block: string): MentionSets {
  const topLevel = new Set<string>();
  const srcFiles = new Set<string>();
  const srcGlobs: string[] = [];
  let inSrc = false;
  for (const line of block.split("\n")) {
    if (!line.trim()) continue;
    const indented = /^\s/.test(line);
    const tokens = (line.trim().split(/\s{2,}/)[0] ?? "")
      .split(",")
      .map((t) => t.trim().replace(/\/$/, ""))
      .filter(Boolean);
    if (!indented) {
      inSrc = tokens[0] === "src";
      for (const t of tokens) {
        const head = t.split("/")[0] ?? t;
        if (/^[\w.-]+$/.test(head)) topLevel.add(head);
      }
    } else if (inSrc) {
      for (const t of tokens) {
        if (t.includes("*")) srcGlobs.push(t);
        else if (/^[\w.-]+\.ts$/.test(t)) srcFiles.add(t);
      }
    }
  }
  return { topLevel, srcFiles, srcGlobs };
}

const { topLevel, srcFiles, srcGlobs } = parseLayout(layout);

for (const entry of topLevel) {
  if (!existsSync(entry)) fail(`layout names "${entry}" but it does not exist on disk`);
}
for (const entry of srcFiles) {
  if (!existsSync(`src/${entry}`)) fail(`layout names "src/${entry}" but it does not exist`);
}

const tracked = execSync("git ls-files", { encoding: "utf8" })
  .split("\n")
  .filter(Boolean);
const trackedTopLevel = new Set(tracked.map((p) => p.split("/")[0] ?? p));
const IGNORED_TOP_LEVEL = new Set([
  ".context",
  ".dockerignore",
  ".gitignore",
  ".npmignore",
  ".github",
  "AGENTS.md",
  "CLAUDE.md",
  "LICENSE",
  "eslint.config.mjs",
  "README.md",
  "package.json",
  "package-lock.json",
  "tsconfig.json",
]);
trackedTopLevel.delete(".github");
topLevel.add(".github");

for (const entry of trackedTopLevel) {
  if (IGNORED_TOP_LEVEL.has(entry)) continue;
  if (!topLevel.has(entry)) {
    fail(`tracked top-level entry "${entry}" is missing from the CLAUDE.md repo layout`);
  }
}

const globToRe = (glob: string): RegExp =>
  new RegExp(`^${glob.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*")}$`);
const globRes = srcGlobs.map(globToRe);
for (const file of readdirSync("src")) {
  if (!file.endsWith(".ts")) continue;
  if (srcFiles.has(file)) continue;
  if (globRes.some((re) => re.test(file))) continue;
  fail(`src/${file} is missing from the CLAUDE.md repo layout`);
}

if (failures > 0) {
  console.error(`\n${failures} memory-drift issue(s). Update CLAUDE.md and AGENTS.md (keep their blocks identical).`);
  process.exit(1);
}
console.log("✓ CLAUDE.md / AGENTS.md match the repository layout");
