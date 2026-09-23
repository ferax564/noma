import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import * as nodeModule from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { describe, it } from "node:test";
import { pathToFileURL } from "node:url";
import { loadPuppeteer, PUPPETEER_MISSING_MESSAGE } from "../src/pdf.js";

const root = process.cwd();
const HEAVY_PACKAGES = ["better-sqlite3", "ws", "yjs", "puppeteer"];
const IMPORT_RE = /^\s*(?:import|export)\s+(?!type\b)(?:[^;"']*?\sfrom\s+)?["']([^"']+)["']/gm;

function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

/** Value-level (non `import type`) static import graph reachable from `entry`. */
function staticImportGraph(entry: string): { files: Set<string>; packages: Set<string> } {
  const files = new Set<string>();
  const packages = new Set<string>();
  const visit = (file: string): void => {
    if (files.has(file)) return;
    files.add(file);
    const source = stripComments(readFileSync(file, "utf8"));
    for (const match of source.matchAll(IMPORT_RE)) {
      const specifier = match[1];
      if (!specifier) continue;
      if (specifier.startsWith(".")) {
        visit(resolve(dirname(file), specifier.replace(/\.js$/, ".ts")));
      } else if (/^(@[a-z0-9._-]+\/)?[a-z0-9._-]+(\/.*)?$/.test(specifier)) {
        packages.add(specifier.startsWith("@") ? specifier.split("/").slice(0, 2).join("/") : specifier.split("/")[0]!);
      }
    }
  };
  visit(resolve(root, entry));
  return { files, packages };
}

describe("package entry points", () => {
  it("root entry's static import graph stays free of cloud, enterprise and native deps", () => {
    const { files, packages } = staticImportGraph("src/index.ts");
    for (const heavy of HEAVY_PACKAGES) {
      assert.ok(!packages.has(heavy), `src/index.ts transitively imports ${heavy}`);
    }
    const leaked = [...files].filter((file) => /[\\/](cloud|enterprise|paperdom)[-.][^\\/]*$/.test(file));
    assert.deepEqual(leaked, [], "root entry reaches cloud/enterprise modules");
    assert.deepEqual([...packages].sort(), ["js-yaml"]);
  });

  it("cloud and enterprise entries carry the server dependencies", () => {
    assert.ok(staticImportGraph("src/cloud.ts").packages.has("better-sqlite3"));
    const enterprise = staticImportGraph("src/enterprise.ts").packages;
    for (const dep of ["better-sqlite3", "ws", "yjs"]) assert.ok(enterprise.has(dep), `enterprise lacks ${dep}`);
  });

  it(
    "importing the root entry at runtime does not load better-sqlite3, ws or yjs",
    { skip: typeof (nodeModule as { registerHooks?: unknown }).registerHooks !== "function" && "needs module.registerHooks (Node >= 22.15)" },
    () => {
      const dir = mkdtempSync(join(tmpdir(), "noma-entry-"));
      const probe = join(dir, "probe.mjs");
      writeFileSync(
        probe,
        [
          'import { registerHooks } from "node:module";',
          "const seen = new Set();",
          "registerHooks({ resolve(specifier, context, next) { seen.add(specifier); return next(specifier, context); } });",
          "const mod = await import(process.argv[2]);",
          'if (typeof mod.parse !== "function") throw new Error("parse missing");',
          "console.log(JSON.stringify([...seen]));",
        ].join("\n"),
      );
      const result = spawnSync(process.execPath, ["--import", "tsx", probe, pathToFileURL(join(root, "src/index.ts")).href], {
        cwd: root,
        encoding: "utf8",
      });
      assert.equal(result.status, 0, result.stderr);
      const seen = JSON.parse(result.stdout.trim().split("\n").pop() ?? "[]") as string[];
      for (const heavy of HEAVY_PACKAGES) {
        assert.ok(!seen.some((spec) => spec === heavy || spec.includes(`node_modules/${heavy}/`)), `root import loaded ${heavy}`);
      }
    },
  );

  it("root entry no longer exports cloud or enterprise APIs; subpaths do", async () => {
    const core = (await import("../src/index.js")) as Record<string, unknown>;
    assert.equal(typeof core.parse, "function");
    assert.equal(typeof core.patchSource, "function");
    assert.equal(typeof core.formatSource, "function");
    assert.equal(core.CloudKnowledgePlatform, undefined);
    assert.equal(core.EnterpriseWorkspace, undefined);

    const cloud = (await import("../src/cloud.js")) as Record<string, unknown>;
    for (const name of ["createNomaCloudServer", "openNomaCloudDatabase", "NomaCloudDatabase", "CloudKnowledgePlatform", "cloudPageTemplates", "instantiateCloudPageTemplate"]) {
      assert.equal(typeof cloud[name], name === "cloudPageTemplates" ? "object" : "function", `cloud entry lacks ${name}`);
    }

    const enterprise = (await import("../src/enterprise.js")) as Record<string, unknown>;
    for (const name of ["EnterpriseWorkspace", "createTestOidc", "parseConfluenceStorage", "evaluateRagFixture", "paperDomHtmlExport"]) {
      assert.equal(typeof enterprise[name], "function", `enterprise entry lacks ${name}`);
    }
  });

  it("package.json maps the cloud and enterprise subpaths and marks puppeteer an optional peer", () => {
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8")) as Record<string, Record<string, unknown>>;
    assert.deepEqual(pkg.exports?.["./cloud"], { types: "./dist/cloud.d.ts", import: "./dist/cloud.js" });
    assert.deepEqual(pkg.exports?.["./enterprise"], { types: "./dist/enterprise.d.ts", import: "./dist/enterprise.js" });
    assert.equal(typeof pkg.peerDependencies?.puppeteer, "string");
    assert.deepEqual(pkg.peerDependenciesMeta?.puppeteer, { optional: true });
    assert.equal(pkg.dependencies?.puppeteer, undefined);
  });
});

describe("PDF rendering without puppeteer", () => {
  it("throws an actionable install hint when puppeteer cannot be imported", async () => {
    const missing = Object.assign(new Error("Cannot find package 'puppeteer'"), { code: "ERR_MODULE_NOT_FOUND" });
    await assert.rejects(
      loadPuppeteer(() => Promise.reject(missing)),
      (error: unknown) => {
        assert.ok(error instanceof Error);
        assert.ok(error.message.startsWith(PUPPETEER_MISSING_MESSAGE), error.message);
        assert.match(error.message, /npm i puppeteer/);
        assert.equal(error.cause, missing);
        return true;
      },
    );
  });
});
