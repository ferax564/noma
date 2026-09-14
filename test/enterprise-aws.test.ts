import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import test from "node:test";
import { AWS_EU_REGION, assertAwsEuStack, awsEuCloudFormation, awsEuReferenceStack } from "../src/enterprise-aws.js";

test("AWS/EU reference stack uses KMS, encrypted Multi-AZ RDS, private S3, and Secrets Manager", () => {
  const generated = awsEuCloudFormation();
  const checkedIn = JSON.parse(readFileSync("infra/aws-eu-reference.json", "utf8")) as Record<string, unknown>;
  assert.deepEqual(checkedIn, generated);
  assert.deepEqual(assertAwsEuStack(generated), []);
  assert.equal(awsEuReferenceStack().region, AWS_EU_REGION);
  assert.equal(AWS_EU_REGION, "eu-central-1");
  const resources = generated.Resources as Record<string, { Properties?: Record<string, unknown> }>;
  assert.equal(resources.EnterpriseKey?.Properties?.EnableKeyRotation, true);
  assert.equal(resources.Database?.Properties?.PubliclyAccessible, false);
});
