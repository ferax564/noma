import { mkdtempSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const root = process.cwd();
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const npx = process.platform === "win32" ? "npx.cmd" : "npx";

type RunOptions = {
  cwd?: string;
  capture?: boolean;
};

function run(command: string, args: string[], options: RunOptions = {}): string {
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? root,
    encoding: "utf8",
    stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
  });
  if (result.status !== 0) {
    const detail = options.capture ? `\n${result.stdout ?? ""}${result.stderr ?? ""}` : "";
    throw new Error(`${command} ${args.join(" ")} failed with exit ${result.status}${detail}`);
  }
  return result.stdout ?? "";
}

function hasNestedDistEntry(dir: string): boolean {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) return true;
  }
  return false;
}

const tmp = mkdtempSync(join(tmpdir(), "noma-package-smoke-"));
const packDir = join(tmp, "pack");
const workDir = join(tmp, "work");
const publishWorkDir = join(tmp, "publish-work");
mkdirSync(packDir);
mkdirSync(workDir);
mkdirSync(publishWorkDir);

const packOut = run(npm, ["pack", "--pack-destination", packDir, "--json"], { capture: true });
const [packed] = JSON.parse(packOut) as Array<{ filename: string; size: number }>;
if (!packed) throw new Error("npm pack produced no tarball metadata");

const tarball = join(packDir, packed.filename);
const mcpPackOut = run(npm, ["pack", "--pack-destination", packDir, "--json", "-w", "@ferax564/noma-mcp-server"], {
  capture: true,
});
const [mcpPacked] = JSON.parse(mcpPackOut) as Array<{ filename: string; size: number }>;
if (!mcpPacked) throw new Error("npm pack produced no MCP server tarball metadata");

const agentPackOut = run(npm, ["pack", "--pack-destination", packDir, "--json", "-w", "@ferax564/noma-agent-sdk"], {
  capture: true,
});
const [agentPacked] = JSON.parse(agentPackOut) as Array<{ filename: string; size: number }>;
if (!agentPacked) throw new Error("npm pack produced no Agent SDK tarball metadata");

const mcpTarball = join(packDir, mcpPacked.filename);
const agentTarball = join(packDir, agentPacked.filename);

run(npm, ["init", "-y"], { cwd: workDir, capture: true });
run(npm, ["install", tarball], { cwd: workDir, capture: true });

const installedPkg = JSON.parse(
  readFileSync(join(workDir, "node_modules/@ferax564/noma-cli/package.json"), "utf8"),
) as { name: string; version: string };
if (installedPkg.name !== "@ferax564/noma-cli") {
  throw new Error(`unexpected installed package name: ${installedPkg.name}`);
}

const distDir = join(workDir, "node_modules/@ferax564/noma-cli/dist");
if (hasNestedDistEntry(distDir)) {
  throw new Error("CLI package leaked nested generated dist artifacts");
}

const version = run(npx, ["noma", "--version"], { cwd: workDir, capture: true }).trim();
if (version !== installedPkg.version) {
  throw new Error(`noma --version printed ${version}, expected ${installedPkg.version}`);
}

const patchSchema = JSON.parse(run(npx, ["noma", "schema", "patch-op"], { cwd: workDir, capture: true }));
if (patchSchema.title !== "Noma Patch Operation") {
  throw new Error("noma schema patch-op did not print the bundled patch schema");
}

run(npx, ["noma", "init", "demo"], { cwd: workDir });
run(npx, ["noma", "check", "demo/demo.noma"], { cwd: workDir });
run(npx, ["noma", "render", "demo/demo.noma", "--to", "html", "--out", "out/demo.html"], {
  cwd: workDir,
});
run(
  npx,
  [
    "noma",
    "render",
    "demo/demo.noma",
    "--to",
    "llm",
    "--select",
    "claim,evidence",
    "--budget",
    "2000",
    "--out",
    "out/demo.llm.txt",
  ],
  { cwd: workDir },
);
run(npx, ["noma", "render", "demo/demo.noma", "--to", "markdown", "--out", "out/demo.md"], {
  cwd: workDir,
});

const ids = JSON.parse(run(npx, ["noma", "ids", "demo/demo.noma"], { cwd: workDir, capture: true }));
if (!Array.isArray(ids.records) || ids.records.length === 0) {
  throw new Error("noma ids emitted no records for starter document");
}

writeFileSync(
  join(workDir, "spec.noma"),
  [
    "# Patchable Spec",
    "",
    '::claim{id="claim-1" confidence=0.4}',
    "Initial claim.",
    "::",
    "",
    '::evidence{id="ev-1" for="claim-1"}',
    "Initial evidence.",
    "::",
    "",
  ].join("\n"),
);
writeFileSync(
  join(workDir, "ops.json"),
  JSON.stringify({
    ops: [{ op: "update_attribute", id: "claim-1", key: "confidence", value: 0.82 }],
    prevalidate: true,
    postvalidate: true,
  }),
);
run(npx, ["noma", "prove", "spec.noma", "--ops", "ops.json", "--out", "out/spec-proof.html"], { cwd: workDir });
const proofHtml = readFileSync(join(workDir, "out/spec-proof.html"), "utf8");
if (!proofHtml.includes("Noma Agent Safety Proof") || !proofHtml.includes("Lines preserved")) {
  throw new Error("noma prove did not write the expected proof artifact");
}
run(npx, ["noma", "patch", "spec.noma", "--ops", "ops.json", "--inplace"], { cwd: workDir });
if (!readFileSync(join(workDir, "spec.noma"), "utf8").includes("confidence=0.82")) {
  throw new Error("noma patch did not update confidence");
}

writeFileSync(
  join(workDir, "api-smoke.mjs"),
  [
    'import { createAgentSafetyProof, parse, renderLlm, renderMarkdown } from "@ferax564/noma-cli";',
    'const doc = parse("# API smoke\\n\\n::claim{id=\\"x\\"}\\nWorks.\\n::");',
    'const out = renderLlm(doc, { select: ["claim"] });',
    'if (!out.includes("[CLAIM id=\\"x\\"]")) throw new Error(out);',
    'const md = renderMarkdown(doc);',
    'if (!md.includes("<!-- noma:block")) throw new Error(md);',
    'const proof = createAgentSafetyProof({ filePath: "api-smoke.noma", source: "# API smoke\\n\\n::risk{id=\\"x\\" owner=\\"ops\\"}\\nWorks.\\n::\\n", ops: [{ op: "replace_body", id: "x", content: "Still works." }] });',
    'if (proof.status !== "pass" || proof.patchResult !== "applied") throw new Error(JSON.stringify(proof));',
  ].join("\n"),
);
run(process.execPath, ["api-smoke.mjs"], { cwd: workDir });

writeFileSync(
  join(workDir, "unsafe.noma"),
  ['# Unsafe', "", '::html{id="raw"}', "<script>alert(1)</script>", "::", ""].join("\n"),
);
run(npx, ["noma", "render", "unsafe.noma", "--to", "html", "--strict", "--out", "out/unsafe.html"], {
  cwd: workDir,
});
const strictHtml = readFileSync(join(workDir, "out/unsafe.html"), "utf8");
if (strictHtml.includes("<script>alert") || strictHtml.includes("alert(1)")) {
  throw new Error("strict HTML output leaked unsafe script body");
}

run(npm, ["init", "-y"], { cwd: publishWorkDir, capture: true });
run(npm, ["install", tarball, mcpTarball, agentTarball], { cwd: publishWorkDir, capture: true });
run(
  process.execPath,
  [
    "--input-type=module",
    "-e",
    [
      'import { NomaTools } from "@ferax564/noma-agent-sdk";',
      'import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";',
      'if (typeof NomaTools !== "function") throw new Error("Agent SDK import failed");',
      'if (typeof McpServer !== "function") throw new Error("MCP dependency import failed");',
    ].join("\n"),
  ],
  { cwd: publishWorkDir },
);

console.log(`package smoke passed: ${installedPkg.name}@${installedPkg.version}`);
console.log(`consumer-smoke-dir=${workDir}`);
console.log(`publish-bundle-smoke-dir=${publishWorkDir}`);
