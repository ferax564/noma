import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { parse } from "../src/parser.js";
import { renderJson } from "../src/renderer-json.js";

const root = process.cwd();
const schemaNames = [
  "patch-op",
  "patch-transaction",
  "ast",
  "transcript",
  "capability",
] as const;

function loadSchema(name: (typeof schemaNames)[number]): Record<string, unknown> {
  return JSON.parse(readFileSync(join(root, "schemas", `${name}.schema.json`), "utf8")) as Record<
    string,
    unknown
  >;
}

function ajvWithSchemas(): Ajv2020 {
  const ajv = new Ajv2020({ strict: false, allErrors: true });
  addFormats(ajv);
  for (const name of schemaNames) {
    const schema = loadSchema(name);
    ajv.addSchema(schema, `${name}.schema.json`);
  }
  return ajv;
}

test("bundled schemas are valid JSON Schema documents", () => {
  const ajv = ajvWithSchemas();
  for (const name of schemaNames) {
    assert.ok(ajv.getSchema(`${name}.schema.json`), name);
  }
});

test("patch schemas validate all shipped operation shapes and transactions", () => {
  const ajv = ajvWithSchemas();
  const validateOp = ajv.getSchema("patch-op.schema.json")!;
  const validateTx = ajv.getSchema("patch-transaction.schema.json")!;
  const ops = [
    { op: "replace_block", id: "claim-1", content: "::claim{id=\"claim-1\"}\nBody.\n::" },
    { op: "replace_body", id: "claim-1", content: "Body only." },
    { op: "update_heading", id: "roadmap", title: "Roadmap" },
    { op: "add_block", parent: "risks", content: "::risk{id=\"r1\"}\nRisk.\n::", position: 0 },
    { op: "delete_block", id: "old-risk" },
    { op: "update_attribute", id: "claim-1", key: "confidence", value: 0.82 },
    { op: "rename_id", from: "claim-1", to: "claim-renamed" },
  ];
  for (const op of ops) assert.equal(validateOp(op), true, JSON.stringify(validateOp.errors));
  assert.equal(
    validateTx({ ops, prevalidate: true, postvalidate: true }),
    true,
    JSON.stringify(validateTx.errors),
  );
  assert.equal(validateOp({ op: "update_attribute", id: "x", key: "id", value: "y" }), false);
});

test("AST schema validates renderer-json output", () => {
  const ajv = ajvWithSchemas();
  const validateAst = ajv.getSchema("ast.schema.json")!;
  const doc = parse(`# Title\n\n::claim{id="c"}\nBody.\n::\n`);
  const json = JSON.parse(renderJson(doc));
  assert.equal(validateAst(json), true, JSON.stringify(validateAst.errors));
});

test("transcript and capability schemas validate reference examples", () => {
  const ajv = ajvWithSchemas();
  const validateTranscript = ajv.getSchema("transcript.schema.json")!;
  const validateCapability = ajv.getSchema("capability.schema.json")!;
  const transcript = {
    protocol_version: "1.0",
    tool_version: "0.10.2",
    op_id: "00000000-0000-4000-8000-000000000000",
    ts: "2026-05-14T00:00:00.000Z",
    actor: { kind: "agent", name: "schema-test" },
    doc_uri: "file:///tmp/demo.noma",
    pre_sha256: "a".repeat(64),
    post_sha256: "b".repeat(64),
    pre_sha: "a".repeat(8),
    post_sha: "b".repeat(8),
    op: { op: "replace_body", id: "c", content: "new" },
    patch_result: "applied",
    pre_validation: "ok",
    post_validation: "ok",
  };
  const capability = {
    nomaAgent: {
      version: 1,
      ids: { rename: true },
      validation: { required: true },
      blocks: {
        claim: {
          ops: ["replace_body", "update_attribute", "rename_id"],
          attrs: { confidence: { type: "number", min: 0, max: 1 } },
        },
      },
    },
  };
  assert.equal(validateTranscript(transcript), true, JSON.stringify(validateTranscript.errors));
  assert.equal(validateCapability(capability), true, JSON.stringify(validateCapability.errors));
});

test("noma schema prints bundled schemas", () => {
  const out = execFileSync("tsx", ["src/cli.ts", "schema", "patch-op"], {
    cwd: root,
    encoding: "utf8",
  });
  const schema = JSON.parse(out) as { title?: string };
  assert.equal(schema.title, "Noma Patch Operation");
});
