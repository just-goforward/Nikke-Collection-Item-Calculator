import { describe, expect, it } from "vitest";
import { evaluateObserverCanary, expectedObserverSlots } from "./canary";

const start = Date.parse("2026-09-02T00:01:00.000Z");
const end = start + 8 * 60 * 60_000;
const sha = "a".repeat(40);

function passingInput() {
  const slots = expectedObserverSlots(start, end);
  return {
    canary: {
      canary_id: `soc-${"b".repeat(32)}`,
      deployment_sha: sha,
      started_at: new Date(start).toISOString(),
      ends_at: new Date(end).toISOString(),
      status: "running" as const,
    },
    runs: slots.map((slot) => ({
      scheduled_at: `${slot}:00.000Z`,
      status: "completed" as const,
      deployment_sha: sha,
      duplicate_attempts: 0,
    })),
    unsentAlerts: 0,
    contractRejections: 0,
    nowMs: end,
  };
}

describe("stats Observer canary", () => {
  it("requires all sixteen exact eight-hour slots", () => {
    expect(evaluateObserverCanary(passingInput())).toMatchObject({
      expectedSlots: 16,
      observedSlots: 16,
      completed: 16,
      passed: true,
    });
  });

  it("fails closed on a missing slot, duplicate, alert, rejection, or SHA drift", () => {
    const input = passingInput();
    input.runs.pop();
    const firstRun = input.runs[0];
    const secondRun = input.runs[1];
    if (!firstRun || !secondRun) throw new Error("passing fixture must include at least two runs");
    firstRun.duplicate_attempts = 1;
    secondRun.deployment_sha = "c".repeat(40);
    input.unsentAlerts = 1;
    input.contractRejections = 1;
    expect(evaluateObserverCanary(input)).toMatchObject({
      missingSlots: 1,
      duplicateAttempts: 1,
      wrongDeployment: 1,
      unsentAlerts: 1,
      contractRejections: 1,
      passed: false,
    });
  });

  it("never reclassifies a sealed failed canary as passing", () => {
    const input = passingInput() as Parameters<typeof evaluateObserverCanary>[0];
    input.canary.status = "failed";

    expect(evaluateObserverCanary(input)).toMatchObject({
      window: { eligible: true, statusEligible: false },
      passed: false,
    });
  });
});
