import { describe, expect, it } from "vitest";
import {
  applyCertifiedBatch,
  type CertifiedBatch,
  resolveCertifiedStockCorrection,
  unresolvedCertifiedSuccess,
} from "./calculatorSessionActions";
import { createCertifiedSession } from "./session";

function batch(exp = 0): CertifiedBatch {
  return {
    before: createCertifiedSession("approved", { grade: "SR", level: 2, exp }, [79, 13, 7]),
    kit: "blue",
    uses: 4,
    at: "2026-09-30T04:00:00Z",
  };
}

describe("native batch actions", () => {
  it("records and charges each normal use without rounding raw stock", () => {
    const input = batch();
    const next = applyCertifiedBatch(input, null);
    expect(next.stock).toEqual([39, 13, 7]);
    expect(next.state).toEqual({ grade: "SR", level: 2, exp: 800 });
    expect(next.outcomes.map((entry) => entry.outcome)).toEqual([
      "normal",
      "normal",
      "normal",
      "normal",
    ]);
    expect(next.outcomes.map((entry) => [entry.before.exp, entry.after.exp])).toEqual([
      [0, 200],
      [200, 400],
      [400, 600],
      [600, 800],
    ]);
    expect(input.before.stock).toEqual([79, 13, 7]);
    expect(input.before.outcomes).toEqual([]);
  });

  it("stops normal uses on the first level change", () => {
    const next = applyCertifiedBatch(batch(2800), null);
    expect(next.stock).toEqual([69, 13, 7]);
    expect(next.state).toEqual({ grade: "SR", level: 3, exp: 0 });
    expect(next.outcomes).toHaveLength(1);
  });

  it("charges through the actual success attempt and no further", () => {
    const next = applyCertifiedBatch(batch(), 3);
    expect(next.stock).toEqual([49, 13, 7]);
    expect(next.state).toEqual({ grade: "SR", level: 5, exp: 0 });
    expect(next.outcomes.map((entry) => entry.outcome)).toEqual(["normal", "normal", "great"]);
    expect(next.outcomes[2]?.before.exp).toBe(400);
  });

  it("rejects a reported success after a normal-path level change", () => {
    const input = batch(2800);
    expect(() => applyCertifiedBatch(input, 2)).toThrow("success_after_batch_stop");
    expect(input.before.outcomes).toEqual([]);
    expect(input.before.stock).toEqual([79, 13, 7]);
  });

  it.each([0, -1, 1.5, 5, Number.NaN])("rejects an invalid success attempt %s", (attempt) => {
    expect(() => applyCertifiedBatch(batch(), attempt)).toThrow("invalid_success_attempt");
  });
});

describe("unknown-consumption correction", () => {
  it("never invents consumption or ledger entries and reconciles only an explicit exact deduction", () => {
    const input = batch();
    const unresolved = unresolvedCertifiedSuccess(input);
    expect(unresolved.stock).toEqual(input.before.stock);
    expect(unresolved.outcomes).toEqual([]);
    expect(unresolved.state).toEqual({ grade: "SR", level: 5, exp: 0 });
    expect(resolveCertifiedStockCorrection(input, unresolved)).toMatchObject({
      successAttempt: null,
      view: { status: "invalid", reason: "unchanged", canCalculate: false },
    });
    const resolution = resolveCertifiedStockCorrection(input, {
      ...unresolved,
      stock: [49, 13, 7],
    });
    expect(resolution.view).toMatchObject({
      status: "valid",
      successAttempt: 3,
      canCalculate: true,
      allowedMinimum: 39,
      allowedMaximum: 69,
    });
    expect(resolution.successAttempt).toBe(3);
    expect(unresolved.outcomes).toEqual([]);
    expect(input.before.outcomes).toEqual([]);
  });

  it.each([
    { stock: [49, 12, 7] as const, reason: "other_kit_changed" },
    { stock: [80, 13, 7] as const, reason: "selected_kit_increased" },
    { stock: [48, 13, 7] as const, reason: "invalid_delta" },
    { stock: [29, 13, 7] as const, reason: "too_many_attempts" },
  ])("blocks $reason without emitting an outcome", ({ stock, reason }) => {
    const input = batch();
    const resolution = resolveCertifiedStockCorrection(input, {
      ...unresolvedCertifiedSuccess(input),
      stock,
    });
    expect(resolution.successAttempt).toBeNull();
    expect(resolution.view).toMatchObject({ status: "invalid", reason, canCalculate: false });
  });

  it("rejects an entered success after a normal-path level change without recording uses", () => {
    const input = batch(2800);
    const resolution = resolveCertifiedStockCorrection(input, {
      ...unresolvedCertifiedSuccess(input),
      stock: [59, 13, 7],
    });
    expect(resolution.successAttempt).toBeNull();
    expect(resolution.view).toMatchObject({
      status: "invalid",
      reason: "too_many_attempts",
      canCalculate: false,
    });
    expect(input.before.outcomes).toEqual([]);
  });
});
