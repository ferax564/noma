import { test } from "node:test";
import assert from "node:assert/strict";
import { CapabilityDescriptor } from "../src/capabilities.js";
import { NomaCapabilityError } from "../src/errors.js";

const MINIMAL = `
nomaAgent:
  version: 1
`;

const FULL = `
nomaAgent:
  version: 1
  profile: research
  blocks:
    claim:
      ops: [replace_block, update_attribute]
      attrs:
        confidence:
          type: number
          min: 0
          max: 1
    evidence:
      ops: [add_block, replace_block, delete_block]
  ids:
    rename: true
  validation:
    required: true
`;

test("fromYaml accepts minimal v1 descriptor", () => {
  const d = CapabilityDescriptor.fromYaml(MINIMAL);
  assert.equal(d.version, 1);
  assert.equal(d.profile, undefined);
  assert.equal(d.blocks.size, 0);
  assert.equal(d.idsRename, false);
  assert.equal(d.validationRequired, false);
});

test("fromYaml accepts full descriptor and indexes ops + attr constraints", () => {
  const d = CapabilityDescriptor.fromYaml(FULL);
  assert.equal(d.profile, "research");
  assert.ok(d.allows("claim", "replace_block"));
  assert.ok(d.allows("claim", "update_attribute"));
  assert.ok(!d.allows("claim", "delete_block"));
  assert.ok(d.allows("evidence", "add_block"));
  assert.ok(!d.allows("paragraph", "replace_block"));
  assert.equal(d.idsRename, true);
  assert.equal(d.validationRequired, true);
});

test("validateAttr enforces type", () => {
  const d = CapabilityDescriptor.fromYaml(FULL);
  assert.deepEqual(d.validateAttr("claim", "confidence", 0.5), { ok: true });
  const bad = d.validateAttr("claim", "confidence", "high");
  assert.equal(bad.ok, false);
});

test("validateAttr enforces min/max", () => {
  const d = CapabilityDescriptor.fromYaml(FULL);
  assert.deepEqual(d.validateAttr("claim", "confidence", 0), { ok: true });
  assert.deepEqual(d.validateAttr("claim", "confidence", 1), { ok: true });
  assert.equal(d.validateAttr("claim", "confidence", -0.1).ok, false);
  assert.equal(d.validateAttr("claim", "confidence", 1.1).ok, false);
});

test("validateAttr accepts unknown keys (no constraint)", () => {
  const d = CapabilityDescriptor.fromYaml(FULL);
  assert.deepEqual(d.validateAttr("claim", "uncatalogued", "anything"), { ok: true });
});

test("validateAttr accepts unknown block names", () => {
  const d = CapabilityDescriptor.fromYaml(FULL);
  assert.deepEqual(d.validateAttr("unknown", "any", 1), { ok: true });
});

test("fromYaml rejects malformed YAML", () => {
  assert.throws(() => CapabilityDescriptor.fromYaml(": : :"), NomaCapabilityError);
});

test("fromYaml rejects unsupported version", () => {
  assert.throws(
    () => CapabilityDescriptor.fromYaml("nomaAgent:\n  version: 2\n"),
    (e: unknown) => e instanceof NomaCapabilityError && /version/i.test((e as Error).message),
  );
});

test("fromYaml rejects descriptor with no nomaAgent root", () => {
  assert.throws(
    () => CapabilityDescriptor.fromYaml("foo: bar\n"),
    NomaCapabilityError,
  );
});

test("fromYaml accepts enum constraint", () => {
  const yaml = `
nomaAgent:
  version: 1
  blocks:
    decision:
      ops: [update_attribute]
      attrs:
        status:
          type: string
          enum: [open, accepted, rejected]
`;
  const d = CapabilityDescriptor.fromYaml(yaml);
  assert.deepEqual(d.validateAttr("decision", "status", "open"), { ok: true });
  const bad = d.validateAttr("decision", "status", "pending");
  assert.equal(bad.ok, false);
});

import { mkdtempSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

function scratch(): string {
  return mkdtempSync(join(tmpdir(), "noma-cap-"));
}

test("fromFile returns null when sidecar is absent", async () => {
  const d = await CapabilityDescriptor.fromFile(
    join(scratch(), "does-not-exist.noma.capabilities.yml"),
  );
  assert.equal(d, null);
});

test("fromFile parses a real sidecar from disk", async () => {
  const dir = scratch();
  const path = join(dir, "doc.noma.capabilities.yml");
  writeFileSync(path, "nomaAgent:\n  version: 1\n  profile: r\n");
  const d = await CapabilityDescriptor.fromFile(path);
  assert.ok(d);
  assert.equal(d.profile, "r");
});

test("fromFile throws NomaCapabilityError on bad YAML on disk", async () => {
  const dir = scratch();
  const path = join(dir, "bad.noma.capabilities.yml");
  writeFileSync(path, ": : :\n");
  await assert.rejects(() => CapabilityDescriptor.fromFile(path), NomaCapabilityError);
});
