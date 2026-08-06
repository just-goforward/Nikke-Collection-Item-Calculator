import { describe, expect, it } from "vitest";

import type { PendingStatsEvent } from "./calculatorShared";
import { pendingStatsEventFromInput } from "./calculatorSolveFlow";

const RESULT_STATE = { grade: "R", level: 10, exp: 0 } as const;

function pendingEvent(): PendingStatsEvent {
  return {
    start: { grade: "R", level: 6, exp: 0 },
    kit: "blue",
    recommendedUses: 5,
    stockBefore: { blue: 50, purple: 100, yellow: 100 },
    resultState: RESULT_STATE,
  };
}

function eventFromStock(stock: { blue: number; purple: number; yellow: number }) {
  const pendingStatsEventRef = { current: pendingEvent() as PendingStatsEvent | null };
  const event = pendingStatsEventFromInput({
    currentStateSnapshot: () => RESULT_STATE,
    input: { start: RESULT_STATE, stock },
    pendingStatsEventRef,
  });
  expect(pendingStatsEventRef.current).toBeNull();
  return event;
}

describe("pendingStatsEventFromInput", () => {
  it("records the exact success attempt after a valid manual stock correction", () => {
    expect(eventFromStock({ blue: 0, purple: 100, yellow: 100 })).toMatchObject({
      kind: "kit_result",
      outcome: "great_success",
      recommendedUses: 5,
      successAttempt: 5,
      stockBefore: { blue: 50, purple: 100, yellow: 100 },
      stockAfter: { blue: 0, purple: 100, yellow: 100 },
      resultState: RESULT_STATE,
    });
  });

  it.each([
    ["a non-10-piece delta", { blue: 1, purple: 100, yellow: 100 }],
    ["an increased selected-kit stock", { blue: 60, purple: 100, yellow: 100 }],
    ["more attempts than recommended", { blue: -10, purple: 100, yellow: 100 }],
    ["a change to another kit", { blue: 0, purple: 90, yellow: 100 }],
  ])("does not submit %s", (_label, stock) => {
    expect(eventFromStock(stock)).toBeNull();
  });

  it("does not submit when the current state no longer matches the pending result", () => {
    const pendingStatsEventRef = { current: pendingEvent() as PendingStatsEvent | null };
    const event = pendingStatsEventFromInput({
      currentStateSnapshot: () => ({ grade: "R", level: 11, exp: 0 }),
      input: { start: RESULT_STATE, stock: { blue: 0, purple: 100, yellow: 100 } },
      pendingStatsEventRef,
    });

    expect(event).toBeNull();
    expect(pendingStatsEventRef.current).toBeNull();
  });
});
