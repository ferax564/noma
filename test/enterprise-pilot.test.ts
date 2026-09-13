import assert from "node:assert/strict";
import test from "node:test";
import { PILOT_PARTNERS, measureUsabilityTasks, runPaidPilotUsability } from "../src/enterprise-pilot.js";

test("three paid pilots have champions, budget owners, and a go/no-go harness", () => {
  assert.equal(PILOT_PARTNERS.length, 3);
  assert.ok(PILOT_PARTNERS.every((partner) => partner.paid && partner.champion && partner.budgetOwner && partner.seats > 0));
  const failing = measureUsabilityTasks([
    { id: "slow", name: "slow", baselineMs: 100, nomaMs: 90, completed: true },
    { id: "incomplete", name: "incomplete", baselineMs: 100, nomaMs: 10, completed: false },
  ]);
  assert.equal(failing.goNoGo, false);
  const session = runPaidPilotUsability();
  assert.equal(session.partners.length, 3);
  assert.equal(session.tasks.length, 3);
  assert.ok(session.tasks.every((task) => task.completed && task.nomaMs < task.baselineMs));
  assert.equal(session.result.goNoGo, true);
  assert.ok(session.result.medianImprovement >= 0.3);
  assert.ok(session.result.completionRate >= 0.5);
});
