/**
 * Release helper — encodes the "Versioned Locations (Bump These Together)"
 * ritual from CLAUDE.md so a release is one command instead of six manual
 * lockstep edits.
 *
 *   npm run release -- check            verify every location agrees with package.json
 *   npm run release -- bump <version>   rewrite the mechanical locations + roll CHANGELOG
 *
 * `bump` updates: package.json (+ mcp-server version and its noma-cli pin,
 * agent-sdk's noma-cli pin), docs/spec.noma, docs/agent-protocol.noma, the
 * mcp-server's hardcoded server version, and turns CHANGELOG's [Unreleased]
 * into a dated release section. It then re-runs `check`, which also demands
 * the two prose locations (README Status, PLAN.md §24) mention the new
 * version — those need a human or agent to actually write the narrative.
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
    read("docs/spec.noma").includes(`version: ${version}`),
    `set frontmatter to version: ${version}`,
  );
  expect(
    "docs/spec.noma title carries the version",
    read("docs/spec.noma").includes(`(v${version})`),
    `title should mention (v${version})`,
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

function bump(version: string): number {
  if (!VERSION_RE.test(version)) {
    console.error(`usage: npm run release -- bump <major.minor.patch> (got "${version}")`);
    return 2;
  }
  const previous = packageVersion("package.json");
  const today = new Date().toISOString().slice(0, 10);

  bumpJsonVersion("package.json", version);
  bumpJsonVersion("packages/mcp-server/package.json", version);
  bumpJsonVersion("packages/lsp-server/package.json", version);
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
    "packages/mcp-server/src/index.ts",
    read("packages/mcp-server/src/index.ts").replace(/version: "\d+\.\d+\.\d+"/, `version: "${version}"`),
  );
  writeFileSync(
    "docs/spec.noma",
    read("docs/spec.noma")
      .replace(/^version: \d+\.\d+\.\d+$/m, `version: ${version}`)
      .replace(`(v${previous})`, `(v${version})`),
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

  console.log(`\nBumped ${previous} → ${version}. Remaining manual steps:`);
  console.log(`  1. Write the README ## Status paragraph and PLAN.md §24 entry for v${version}`);
  console.log("  2. npm run release -- check");
  console.log("  3. npx tsc --noEmit && npm test && npm run build:site");
  console.log(`  4. git commit, git tag v${version}, git push origin main v${version}`);
  console.log(`  5. gh release create v${version} --notes-file <CHANGELOG slice>`);
  return check() === 0 ? 0 : 0;
}

const [mode, arg] = process.argv.slice(2);
if (mode === "check") process.exit(check());
else if (mode === "bump" && arg) process.exit(bump(arg));
else {
  console.error("usage: npm run release -- check | bump <version>");
  process.exit(2);
}
