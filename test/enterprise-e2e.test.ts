import assert from "node:assert/strict";
import test from "node:test";
import { runEnterpriseReleaseDemonstration } from "../src/enterprise-demo.js";

test("section 17 enterprise demonstration: two humans, one agent, connector, pin, revoke, restore", () => {
  const result = runEnterpriseReleaseDemonstration();
  assert.ok(result.documentId);
  assert.ok(result.artifactId);
  assert.match(result.issueKey, /^THM-\d+$/);
  assert.ok(result.followUpKey);
  assert.equal(result.staleRejected, true);
  assert.equal(result.revokedDenied, true);
  assert.equal(result.pinnedUnchanged, true);
  assert.equal(result.updateCandidate, true);
  assert.equal(result.restored, true);
  assert.ok(result.searchHits > 0);
  assert.ok(result.notifications >= 0);
  assert.ok(result.changesetId);
  assert.ok(result.appliedHash);
});
