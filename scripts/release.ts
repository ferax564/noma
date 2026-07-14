/**
 * Release helper — encodes the "Versioned Locations (Bump These Together)"
 * ritual from CLAUDE.md so a release is one command instead of six manual
 * lockstep edits.
 *
 *   npm run release -- check            verify every location agrees with package.json
 *   npm run release -- bump <version>   rewrite the mechanical locations + roll CHANGELOG
 *
 * `bump` updates: package.json (+ lockstep workspace versions, an independent
 * Agent SDK patch, and dependency pins), docs/spec.noma,
 * docs/agent-protocol.noma, the MCP runtime and registry versions, and turns
 * CHANGELOG's [Unreleased] into a dated release section.
 * It then re-runs `check`, which also demands the two prose locations (README
 * Status, PLAN.md §24) mention the new version — those need a human or agent
 * to actually write the narrative.
 */
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const VERSION_RE = /^\d+\.\d+\.\d+$/;

function read(path: string): string {
  return readFileSync(path, "utf8");
}

function packageVersion(path: string): string {
  return (JSON.parse(read(path)) as { version: string }).version;
}

function check(): number {
  const version = packageVersion("package.json");
  const spec = read("docs/spec.noma");
  console.log(`package.json version: ${version}`);
  let failures = 0;
  const expect = (label: string, ok: boolean, hint: string): void => {
    if (ok) {
      console.log(`✓ ${label}`);
    } else {
      failures++;
      console.error(`✗ ${label} — ${hint}`);
    }
  };

  expect(
    "docs/spec.noma frontmatter version",
    spec.includes(`version: ${version}`),
    `set frontmatter to version: ${version}`,
  );
  expect(
    "docs/spec.noma title carries the version",
    spec.includes(`title: Noma — Format Specification (v${version})`),
    `title should mention (v${version})`,
  );
  expect(
    "docs/spec.noma summary carries the version",
    spec.includes(`format at version ${version}`),
    `summary should describe version ${version}`,
  );
  expect(
    "docs/spec.noma render-target heading carries the version",
    spec.includes(`## Render targets (v${version})`),
    `render-target heading should mention (v${version})`,
  );
  expect(
    "docs/spec.noma compatibility heading carries the version",
    spec.includes(`## Compatibility promises (v${version})`),
    `compatibility heading should mention (v${version})`,
  );
  expect(
    "docs/agent-protocol.noma frontmatter version",
    read("docs/agent-protocol.noma").includes(`version: ${version}`),
    `set frontmatter to version: ${version}`,
  );
  expect(
    `CHANGELOG.md has a [${version}] section`,
    new RegExp(`^## \\[${version.replace(/\./g, "\\.")}\\]`, "m").test(read("CHANGELOG.md")),
    "run `npm run release -- bump` or add the section manually",
  );
  expect(
    "README.md Status paragraph mentions the version",
    read("README.md").includes(`v${version}`),
    `update the ## Status paragraph for v${version}`,
  );
  expect(
    `PLAN.md §24 tracks v${version}`,
    read("PLAN.md").includes(`v${version}`),
    `add the §24.N shipped subsection for v${version}`,
  );
  expect(
    "packages/mcp-server version matches",
    packageVersion("packages/mcp-server/package.json") === version,
    `bump packages/mcp-server/package.json to ${version}`,
  );
  expect(
    "packages/mcp-server pins @ferax564/noma-cli to the release",
    read("packages/mcp-server/package.json").includes(`"@ferax564/noma-cli": "${version}"`),
    "update the dependency pin",
  );
  expect(
    "packages/agent-sdk pins @ferax564/noma-cli to the release",
    read("packages/agent-sdk/package.json").includes(`"@ferax564/noma-cli": "${version}"`),
    "update the dependency pin",
  );
  expect(
    "packages/agent-sdk pins @ferax564/noma-mcp-server to the release",
    read("packages/agent-sdk/package.json").includes(`"@ferax564/noma-mcp-server": "${version}"`),
    "update the MCP dependency pin",
  );
  expect(
    "packages/lsp-server version matches",
    packageVersion("packages/lsp-server/package.json") === version,
    `bump packages/lsp-server/package.json to ${version}`,
  );
  expect(
    "packages/lsp-server pins @ferax564/noma-cli to the release",
    read("packages/lsp-server/package.json").includes(`"@ferax564/noma-cli": "${version}"`),
    "update the dependency pin",
  );
  expect(
    "mcp-server McpServer version string matches",
    read("packages/mcp-server/src/index.ts").includes(`version: "${version}"`),
    "update the McpServer constructor version",
  );
  const mcpRegistry = JSON.parse(read("packages/mcp-server/server.json")) as { version?: string; packages?: Array<{ version?: string }> };
  expect(
    "MCP registry server version matches",
    mcpRegistry.version === version,
    `set packages/mcp-server/server.json version to ${version}`,
  );
  expect(
    "MCP registry package version matches",
    mcpRegistry.packages?.[0]?.version === version,
    `set packages/mcp-server/server.json packages[0].version to ${version}`,
  );

  if (failures > 0) {
    console.error(`\n${failures} versioned location(s) out of sync.`);
    return 1;
  }
  console.log("\nAll versioned locations agree.");
  return 0;
}

function bumpJsonVersion(path: string, version: string): void {
  writeFileSync(path, read(path).replace(/"version":\s*"\d+\.\d+\.\d+"/, `"version": "${version}"`));
}

function nextPatch(version: string): string {
  const [major, minor, patch] = version.split(".").map(Number);
  return `${major}.${minor}.${patch + 1}`;
}

function bump(version: string): number {
  if (!VERSION_RE.test(version)) {
    console.error(`usage: npm run release -- bump <major.minor.patch> (got "${version}")`);
    return 2;
  }
  const previous = packageVersion("package.json");
  const previousAgentSdk = packageVersion("packages/agent-sdk/package.json");
  const agentSdkVersion = nextPatch(previousAgentSdk);
  const today = new Date().toISOString().slice(0, 10);

  bumpJsonVersion("package.json", version);
  bumpJsonVersion("packages/mcp-server/package.json", version);
  bumpJsonVersion("packages/lsp-server/package.json", version);
  bumpJsonVersion("packages/agent-sdk/package.json", agentSdkVersion);
  for (const path of [
    "packages/mcp-server/package.json",
    "packages/agent-sdk/package.json",
    "packages/lsp-server/package.json",
  ]) {
    writeFileSync(
      path,
      read(path).replace(/"@ferax564\/noma-cli":\s*"\d+\.\d+\.\d+"/, `"@ferax564/noma-cli": "${version}"`),
    );
  }
  writeFileSync(
    "packages/agent-sdk/package.json",
    read("packages/agent-sdk/package.json").replace(
      /"@ferax564\/noma-mcp-server":\s*"\d+\.\d+\.\d+"/,
      `"@ferax564/noma-mcp-server": "${version}"`,
    ),
  );
  writeFileSync(
    "packages/mcp-server/src/index.ts",
    read("packages/mcp-server/src/index.ts").replace(/version: "\d+\.\d+\.\d+"/, `version: "${version}"`),
  );
  writeFileSync(
    "packages/mcp-server/server.json",
    read("packages/mcp-server/server.json")
      .replace(/"version": "\d+\.\d+\.\d+"/, `"version": "${version}"`)
      .replace(/("identifier": "@ferax564\/noma-mcp-server",\s*\n\s*"version": ")\d+\.\d+\.\d+"/, `$1${version}"`),
  );
  writeFileSync(
    "docs/spec.noma",
    read("docs/spec.noma")
      .replace(/^version: \d+\.\d+\.\d+$/m, `version: ${version}`)
      .replaceAll(`(v${previous})`, `(v${version})`)
      .replace(`format at version ${previous}`, `format at version ${version}`),
  );
  writeFileSync(
    "docs/agent-protocol.noma",
    read("docs/agent-protocol.noma").replace(/^version: \d+\.\d+\.\d+$/m, `version: ${version}`),
  );

  const changelog = read("CHANGELOG.md");
  if (!/^## \[Unreleased\]\s*\n+## \[/m.test(changelog)) {
    writeFileSync(
      "CHANGELOG.md",
      changelog.replace(/^## \[Unreleased\]/m, `## [Unreleased]\n\n## [${version}] — ${today}`),
    );
    console.log(`CHANGELOG.md: promoted [Unreleased] to [${version}] — ${today}`);
  } else {
    console.warn("CHANGELOG.md: [Unreleased] is empty — add release notes before tagging");
  }

  execSync("npm install --package-lock-only --ignore-scripts", { stdio: "inherit" });

  console.log(`\nBumped ${previous} → ${version}; agent SDK ${previousAgentSdk} → ${agentSdkVersion}. Remaining manual steps:`);
  console.log(`  1. Write the README ## Status paragraph and PLAN.md §24 entry for v${version}`);
  console.log("  2. npm run release -- check");
  console.log("  3. npx tsc --noEmit && npm test && npm run build:site");
  console.log(`  4. git commit, git tag v${version}, git push origin main v${version}`);
  console.log(`  5. gh release create v${version} --notes-file <CHANGELOG slice>`);
  return check();
}

const [mode, arg] = process.argv.slice(2);
if (mode === "check") process.exit(check());
else if (mode === "bump" && arg) process.exit(bump(arg));
else {
  console.error("usage: npm run release -- check | bump <version>");
  process.exit(2);
}
