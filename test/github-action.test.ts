import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import yaml from "js-yaml";

interface ActionYaml {
  name?: string;
  inputs?: Record<string, { required?: boolean; default?: string }>;
  runs?: {
    using?: string;
    steps?: Array<{ name?: string; uses?: string; run?: string }>;
  };
}

test("root GitHub Action exposes render inputs and composite steps", () => {
  const action = yaml.load(readFileSync("action.yml", "utf8")) as ActionYaml;
  assert.equal(action.name, "Render Noma artifact");
  assert.equal(action.runs?.using, "composite");
  assert.equal(action.inputs?.input?.required, true);
  assert.equal(action.inputs?.to?.default, "html");
  assert.equal(action.inputs?.["upload-artifact"]?.default, "true");

  const steps = action.runs?.steps ?? [];
  assert.ok(steps.some((s) => s.uses === "actions/setup-node@v4"));
  assert.ok(steps.some((s) => s.run?.includes("npm install -g")));
  assert.ok(steps.some((s) => s.run?.includes("noma \"${args[@]}\"")));
  assert.ok(steps.some((s) => s.uses === "actions/upload-artifact@v4"));
});
