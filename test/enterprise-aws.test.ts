import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import {
  AWS_EU_REGION,
  AWS_REQUIRED_PROPERTIES,
  assertAwsEuStack,
  awsEuCloudFormation,
  awsEuReferenceStack,
} from "../src/enterprise-aws.js";

type Template = Record<string, unknown> & {
  Parameters: Record<string, { Default?: unknown }>;
  Resources: Record<string, { Type: string; Condition?: string; Properties: Record<string, unknown> }>;
};

const REGENERATE =
  'npx tsx -e \'import("./src/enterprise-aws.ts").then(m=>require("node:fs").writeFileSync("infra/aws-eu-reference.json", JSON.stringify(m.awsEuCloudFormation(), null, 2)+"\\n"))\'';

function fresh(): Template {
  return structuredClone(awsEuCloudFormation()) as Template;
}

test("AWS/EU reference stack uses KMS, encrypted Multi-AZ RDS, private S3, and Secrets Manager", () => {
  const generated = awsEuCloudFormation();
  const checkedIn = JSON.parse(readFileSync("infra/aws-eu-reference.json", "utf8")) as Record<string, unknown>;
  assert.deepEqual(checkedIn, generated, `infra/aws-eu-reference.json is stale; regenerate with: ${REGENERATE}`);
  assert.deepEqual(assertAwsEuStack(generated), []);
  assert.equal(awsEuReferenceStack().region, AWS_EU_REGION);
  assert.equal(AWS_EU_REGION, "eu-central-1");
  const resources = (generated as Template).Resources;
  assert.equal(resources.EnterpriseKey?.Properties.EnableKeyRotation, true);
  assert.equal(resources.Database?.Properties.PubliclyAccessible, false);
});

test("the RDS instance carries everything CloudFormation needs to create it", () => {
  const db = fresh().Resources.Database!.Properties;
  for (const property of AWS_REQUIRED_PROPERTIES["AWS::RDS::DBInstance"] ?? []) {
    assert.ok(db[property] !== undefined, `Database.${property}`);
  }
  assert.equal(db.Engine, "postgres");
  assert.equal(db.ManageMasterUserPassword, true);
  assert.equal(db.MasterUserPassword, undefined, "no password literal in the template");
  assert.deepEqual(db.DBSubnetGroupName, { Ref: "DatabaseSubnetGroup" });
});

test("Bedrock access is a parameter, not a hard-coded profile", () => {
  const template = fresh();
  assert.equal(template.Parameters.BedrockInferenceProfileId?.Default, "");
  assert.deepEqual(awsEuReferenceStack().bedrockAllowedProfiles, []);
  assert.deepEqual(awsEuReferenceStack({ bedrockInferenceProfileId: "eu.example-profile" }).bedrockAllowedProfiles, [
    "eu.example-profile",
  ]);
  assert.equal(template.Resources.BedrockInvokePolicy?.Condition, "HasBedrockProfile");
  assert.doesNotMatch(JSON.stringify(template), /anthropic\.claude/);

  const pinned = fresh();
  pinned.Parameters.BedrockInferenceProfileId!.Default = "eu.anthropic.claude-sonnet-4";
  assert.ok(assertAwsEuStack(pinned).some((f) => /hard-coded/.test(f)));
});

test("self-check catches regressions that would make the stack undeployable or unsafe", () => {
  const cases: Array<[string, (t: Template) => void, RegExp]> = [
    ["missing instance class", (t) => delete t.Resources.Database!.Properties.DBInstanceClass, /Database: missing required property DBInstanceClass/],
    ["missing storage", (t) => delete t.Resources.Database!.Properties.AllocatedStorage, /missing required property AllocatedStorage/],
    ["missing username", (t) => delete t.Resources.Database!.Properties.MasterUsername, /missing required property MasterUsername/],
    ["missing subnet group", (t) => delete t.Resources.Database!.Properties.DBSubnetGroupName, /missing required property DBSubnetGroupName/],
    [
      "plaintext password",
      (t) => {
        delete t.Resources.Database!.Properties.ManageMasterUserPassword;
        t.Resources.Database!.Properties.MasterUserPassword = "hunter2hunter2";
      },
      /plaintext literal/,
    ],
    [
      "dynamic secret reference is accepted",
      (t) => {
        delete t.Resources.Database!.Properties.ManageMasterUserPassword;
        t.Resources.Database!.Properties.MasterUserPassword = "{{resolve:secretsmanager:noma/db:SecretString:password}}";
      },
      /^$/,
    ],
    ["unknown resource type", (t) => (t.Resources.Extra = { Type: "AWS::Lambda::Function", Properties: {} }), /no required-property contract/],
    ["dangling Ref", (t) => (t.Resources.Database!.Properties.DBInstanceClass = { Ref: "Missing" }), /unresolved reference Missing/],
    ["public database", (t) => (t.Resources.Database!.Properties.PubliclyAccessible = true), /publicly accessible/],
    ["no region rule", (t) => delete t.Rules, /EU region allowlist/],
    ["tiny storage", (t) => (t.Resources.Database!.Properties.AllocatedStorage = 5), /below the 20 GiB/],
  ];
  for (const [label, mutate, expected] of cases) {
    const template = fresh();
    mutate(template);
    const findings = assertAwsEuStack(template);
    if (expected.source === "^$") assert.deepEqual(findings, [], label);
    else assert.ok(findings.some((f) => expected.test(f)), `${label}: ${JSON.stringify(findings)}`);
  }
});
