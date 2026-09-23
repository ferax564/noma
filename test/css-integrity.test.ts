import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import test from "node:test";

const stylesheets = [
  ...readdirSync("site/assets").filter((name) => name.endsWith(".css")).map((name) => join("site/assets", name)),
  ...readdirSync("themes").filter((name) => name.endsWith(".css")).map((name) => join("themes", name)),
];

test("shipped stylesheets have balanced braces outside comments and strings", () => {
  assert.ok(stylesheets.length > 0);
  for (const path of stylesheets) {
    const css = readFileSync(path, "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g, '""');
    let depth = 0;
    let line = 1;
    for (const char of css) {
      if (char === "\n") line++;
      if (char === "{") depth++;
      if (char === "}") depth--;
      assert.ok(depth >= 0, `${path}: unexpected "}" near line ${line}`);
    }
    assert.equal(depth, 0, `${path}: ${depth} unclosed "{"`);
  }
});
