import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

function patchErrorCodes(relPath: string): string[] {
  const text = readFileSync(resolve(REPO_ROOT, relPath), "utf8");
  const body = /export type PatchErrorCode =([^;]+);/.exec(text);
  assert.ok(body, `PatchErrorCode union not found in ${relPath}`);
  return [...body[1]!.matchAll(/"([a-z_]+)"/g)].map((m) => m[1]!).sort();
}

test("SDK PatchErrorCode mirrors the reference engine exactly", () => {
  const engine = patchErrorCodes("src/patch.ts");
  assert.deepEqual(patchErrorCodes("packages/agent-sdk/src/types.ts"), engine);
  for (const code of ["invalid_attribute_key", "invalid_attribute_value", "unbalanced_fence_content"]) {
    assert.ok(engine.includes(code), code);
  }
});
