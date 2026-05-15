import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, it } from "node:test";

const root = process.cwd();

function readJson(path: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(root, path), "utf8")) as Record<string, unknown>;
}

function assertPublicScopedPackage(pkg: Record<string, unknown>): void {
  assert.equal(typeof pkg.name, "string");
  assert.match(pkg.name as string, /^@ferax564\/noma-/);
  assert.deepEqual(pkg.publishConfig, { access: "public" });
  assert.equal(pkg.license, "MIT");
  assert.equal(typeof pkg.homepage, "string");
  assert.equal(typeof (pkg.bugs as Record<string, unknown>).url, "string");
  assert.equal(typeof (pkg.repository as Record<string, unknown>).url, "string");
}

function assertNoPublishLocalDeps(pkg: Record<string, unknown>): void {
  const dependencies = (pkg.dependencies ?? {}) as Record<string, string>;
  for (const [name, spec] of Object.entries(dependencies)) {
    assert.ok(!spec.startsWith("file:"), `${pkg.name as string} dependency ${name} uses local file spec`);
    assert.ok(!spec.startsWith("workspace:"), `${pkg.name as string} dependency ${name} uses workspace spec`);
  }
}

describe("npm package manifests", () => {
  it("root CLI package is public and does not publish generated site artifacts", () => {
    const pkg = readJson("package.json");
    assertPublicScopedPackage(pkg);
    assertNoPublishLocalDeps(pkg);

    const files = pkg.files as string[];
    assert.ok(Array.isArray(files));
    assert.deepEqual(pkg.bin, { noma: "bin/noma.mjs" });
    assert.ok(files.includes("dist/*.js"));
    assert.ok(files.includes("dist/*.d.ts"));
    assert.ok(files.includes("dist/*.js.map"));
    assert.ok(files.includes("schemas"));
    assert.ok(!files.includes("dist"));
    assert.ok(!files.some((entry) => entry.startsWith("dist/examples") || entry.startsWith("dist/docs")));
  });

  it("MCP server package has a typed ESM export and excludes tests from npm files", () => {
    const pkg = readJson("packages/mcp-server/package.json");
    assertPublicScopedPackage(pkg);
    assertNoPublishLocalDeps(pkg);
    assert.equal(pkg.main, "dist/index.js");
    assert.equal(pkg.types, "dist/index.d.ts");
    assert.deepEqual(pkg.exports, {
      ".": {
        types: "./dist/index.d.ts",
        import: "./dist/index.js",
      },
      "./package.json": "./package.json",
    });
    assert.deepEqual(pkg.files, ["src", "dist", "README.md"]);
    assert.deepEqual(pkg.bin, { "noma-mcp-server": "dist/index.js" });
    assert.equal((pkg.scripts as Record<string, string>).prepack, "npm run build");

    const source = readFileSync(join(root, "packages/mcp-server/src/index.ts"), "utf8");
    assert.match(source, new RegExp(`version: "${pkg.version as string}"`));
  });

  it("Agent SDK package is public under the same scope", () => {
    const pkg = readJson("packages/agent-sdk/package.json");
    assertPublicScopedPackage(pkg);
    assertNoPublishLocalDeps(pkg);
    assert.equal(pkg.main, "dist/index.js");
    assert.equal(pkg.types, "dist/index.d.ts");
    assert.equal((pkg.scripts as Record<string, string>).prepack, "npm run build");
  });
});
