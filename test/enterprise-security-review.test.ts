import assert from "node:assert/strict";
import test from "node:test";
import { runIndependentSecurityReview } from "../src/enterprise-security-review.js";

test("independent security review pack passes executable findings", async () => {
  const report = await runIndependentSecurityReview();
  assert.equal(report.findings.length, 5);
  for (const finding of report.findings) {
    assert.equal(finding.passed, true, `${finding.id} ${finding.title}: ${finding.evidence}`);
  }
  assert.equal(report.passed, true);
});
