import { describe, expect, it } from "vitest";

import type { PendingStatsEvent } from "./calculatorShared";
import { consumePendingStockCorrection } from "./calculatorSolveFlow";

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

describe("consumePendingStockCorrection", () => {
  it("submits and clears only after a valid manual stock correction", () => {
    const pendingStatsEventRef = { current: pendingEvent() as PendingStatsEvent | null };
    const queued: unknown[] = [];
    const pendingUpdates: Array<PendingStatsEvent | null> = [];
    const manualUpdates: boolean[] = [];
    const ready = consumePendingStockCorrection({
      input: { start: RESULT_STATE, stock: { blue: 20, purple: 100, yellow: 100 } },
      pendingStatsEventRef,
      queueStatsEvent: (event) => queued.push(event),
      setPendingStatsEvent: (event) => pendingUpdates.push(event),
      setManualStockEditRequired: (required) => manualUpdates.push(required),
    });

    expect(ready).toBe(true);
    expect(queued).toHaveLength(1);
    expect(queued[0]).toMatchObject({ outcome: "great_success", successAttempt: 3 });
    expect(pendingUpdates).toEqual([null]);
    expect(manualUpdates).toEqual([false]);
  });

  it("preserves the pending correction and blocks calculation after an invalid edit", () => {
    const pending = pendingEvent();
    const pendingStatsEventRef = { current: pending as PendingStatsEvent | null };
    const queued: unknown[] = [];
    const pendingUpdates: Array<PendingStatsEvent | null> = [];
    const manualUpdates: boolean[] = [];
    const ready = consumePendingStockCorrection({
      input: { start: RESULT_STATE, stock: { blue: 21, purple: 100, yellow: 100 } },
      pendingStatsEventRef,
      queueStatsEvent: (event) => queued.push(event),
      setPendingStatsEvent: (event) => pendingUpdates.push(event),
      setManualStockEditRequired: (required) => manualUpdates.push(required),
    });

    expect(ready).toBe(false);
    expect(pendingStatsEventRef.current).toBe(pending);
    expect(queued).toEqual([]);
    expect(pendingUpdates).toEqual([]);
    expect(manualUpdates).toEqual([]);
  });
});
