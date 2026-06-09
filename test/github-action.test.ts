import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import yaml from "js-yaml";

interface ActionYaml {
  name?: string;
  inputs?: Record<string, { required?: boolean; default?: string }>;
  runs?: {
    using?: string;
    steps?: Array<{ name?: string; uses?: string; run?: string; env?: Record<string, string> }>;
  };
}

test("root GitHub Action exposes render and proof inputs with composite steps", () => {
  const action = yaml.load(readFileSync("action.yml", "utf8")) as ActionYaml;
  assert.equal(action.name, "Noma artifact and proof");
  assert.equal(action.runs?.using, "composite");
  assert.equal(action.inputs?.mode?.default, "render");
  assert.equal(action.inputs?.input?.required, true);
  assert.equal(action.inputs?.to?.default, "html");
  assert.equal(action.inputs?.["cli-package"]?.default, "");
  assert.equal(action.inputs?.["cli-version"]?.default, "");
  assert.equal(action.inputs?.["upload-artifact"]?.default, "true");
  assert.equal(action.inputs?.profile?.default, "");
  assert.equal(action.inputs?.ops?.default, "");
  assert.equal(action.inputs?.["proof-output"]?.default, "noma-proof.html");
  assert.equal(action.inputs?.["proof-summary-output"]?.default, "noma-proof.md");
  assert.equal(action.inputs?.["comment-pr"]?.default, "false");

  const steps = action.runs?.steps ?? [];
  assert.ok(steps.some((s) => s.uses === "actions/setup-node@v4"));
  assert.ok(steps.some((s) => s.run?.includes('package_spec="$GITHUB_ACTION_PATH"')));
  assert.ok(steps.some((s) => s.run?.includes('npm install -g "$package_spec"')));
  // eslint-disable-next-line no-template-curly-in-string -- asserting a literal bash expansion in action.yml
  assert.ok(steps.some((s) => s.run?.includes("noma \"${args[@]}\"")));
  assert.ok(steps.some((s) => s.run?.includes('proof_args=(proof "$NOMA_INPUT"')));
  assert.ok(steps.some((s) => s.uses === "actions/github-script@v7"));
  assert.ok(steps.some((s) => s.uses === "actions/upload-artifact@v4"));
});
