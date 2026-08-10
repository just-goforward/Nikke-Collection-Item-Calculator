import { describe, expect, it } from "vitest";

import type { CollectionState, Stock } from "../types";
import type { PendingStatsEvent } from "./calculatorShared";
import { resolvePendingStockCorrection } from "./calculatorStockCorrection";

const RESULT_STATE: CollectionState = { grade: "R", level: 10, exp: 0 };

function pendingEvent(): PendingStatsEvent {
  return {
    start: { grade: "R", level: 6, exp: 0 },
    kit: "blue",
    recommendedUses: 5,
    stockBefore: { blue: 50, purple: 100, yellow: 100 },
    resultState: RESULT_STATE,
  };
}

function resolve(stock: Stock, state = RESULT_STATE) {
  return resolvePendingStockCorrection(pendingEvent(), state, stock);
}

describe("resolvePendingStockCorrection", () => {
  it("builds the exact event without consuming the pending correction", () => {
    const pending = pendingEvent();
    const resolution = resolvePendingStockCorrection(pending, RESULT_STATE, {
      blue: 20,
      purple: 100,
      yellow: 100,
    });

    expect(resolution).toMatchObject({
      status: "valid",
      successAttempt: 3,
      allowedMinimum: 0,
      allowedMaximum: 40,
      event: {
        kind: "kit_result",
        outcome: "great_success",
        successAttempt: 3,
        stockBefore: pending.stockBefore,
        stockAfter: { blue: 20, purple: 100, yellow: 100 },
        resultState: RESULT_STATE,
      },
    });
    expect(pending).toEqual(pendingEvent());
  });

  it.each([
    ["unchanged", { blue: 50, purple: 100, yellow: 100 }],
    ["selected_kit_increased", { blue: 60, purple: 100, yellow: 100 }],
    ["invalid_delta", { blue: 1, purple: 100, yellow: 100 }],
    ["other_kit_changed", { blue: 20, purple: 90, yellow: 100 }],
  ] as const)("preserves an invalid %s correction for another edit", (reason, stock) => {
    expect(resolve(stock)).toMatchObject({ status: "invalid", reason });
  });

  it("rejects more consumed attempts than the recommendation contained", () => {
    expect(
      resolvePendingStockCorrection({ ...pendingEvent(), recommendedUses: 4 }, RESULT_STATE, {
        blue: 0,
        purple: 100,
        yellow: 100,
      }),
    ).toMatchObject({ status: "invalid", reason: "too_many_attempts" });
  });

  it("does not infer stats after a collection state change but still allows recalculation", () => {
    expect(
      resolve({ blue: 20, purple: 100, yellow: 100 }, { ...RESULT_STATE, level: 11 }),
    ).toMatchObject({
      status: "invalid",
      reason: "state_changed",
      canCalculate: true,
    });
  });

  it("allows recalculation after a stock change that cannot be inferred", () => {
    expect(resolve({ blue: 25, purple: 100, yellow: 100 })).toMatchObject({
      status: "invalid",
      reason: "invalid_delta",
      canCalculate: true,
    });
  });

  it("keeps recalculation blocked until at least one kit count changes", () => {
    expect(resolve({ blue: 50, purple: 100, yellow: 100 })).toMatchObject({
      status: "invalid",
      reason: "unchanged",
      canCalculate: false,
    });
  });
});
