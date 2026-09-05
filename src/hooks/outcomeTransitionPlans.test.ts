import { describe, expect, it } from "vitest";

import type { CollectionState, Stock } from "../types";
import type {
  RecommendedRun,
  SolverBest,
  SolverResult,
  TerminalSuccessContext,
} from "./calculatorShared";
import {
  canApplyConversion,
  OUTCOME_PLAN_ATTEMPT,
  OUTCOME_PLAN_KNOWN,
  OUTCOME_PLAN_STOCK,
  planConversion,
  planFailedOutcome,
  planSuccessAttempt,
  planSuccessfulOutcome,
  prepareRecommendedOutcome,
} from "./outcomeTransitionPlans";

const start: CollectionState = { grade: "R", level: 0, exp: 0 };
const stock: Stock = { blue: 100, purple: 50, yellow: 20 };

function runWith(success: CollectionState, count = 2): RecommendedRun {
  return {
    count,
    success,
    fail: { grade: "R", level: 1, exp: 0 },
  };
}

function resultWith(run: RecommendedRun): SolverResult {
  const best: SolverBest = {
    firstAction: "blue",
    firstProbability: 0.5,
    successProbability: 0.75,
    run,
  };
  return {
    possible: true,
    input: { start, stock: { blue: 120, purple: 50, yellow: 20 }, strategy: "supply" },
    best,
  };
}

function prepared(run: RecommendedRun) {
  const value = prepareRecommendedOutcome(resultWith(run), () => stock);
  if (!value) throw new Error("Expected a prepared outcome.");
  return value;
}

function contextWith(run: RecommendedRun): TerminalSuccessContext {
  const value = prepared(run);
  return {
    best: value.best,
    beforeStock: value.beforeStock,
    input: value.input,
    run: value.run,
    startSnapshot: value.startSnapshot,
    stockBeforeSnapshot: value.stockBeforeSnapshot,
  };
}

describe("outcome transition plans", () => {
  it("rejects results that are not actionable", () => {
    expect(prepareRecommendedOutcome(null, () => stock)).toBeNull();
    expect(prepareRecommendedOutcome({ possible: false }, () => stock)).toBeNull();
  });

  it("copies solver snapshots and derives the current selected-kit stock", () => {
    const source = resultWith(runWith({ grade: "R", level: 2, exp: 0 }));
    const value = prepareRecommendedOutcome(source, () => stock);

    expect(value).toMatchObject({
      beforeStock: 100,
      currentStock: stock,
      startSnapshot: start,
      stockBeforeSnapshot: { blue: 120, purple: 50, yellow: 20 },
    });
    expect(value?.startSnapshot).not.toBe(source.input?.start);
    expect(value?.stockBeforeSnapshot).not.toBe(source.input?.stock);
  });

  it("separates known, terminal-prompt, and stock-edit success paths", () => {
    expect(planSuccessfulOutcome(prepared(runWith({ grade: "R", level: 2, exp: 0 }, 1))).kind).toBe(
      OUTCOME_PLAN_KNOWN,
    );
    expect(planSuccessfulOutcome(prepared(runWith({ grade: "R", level: 15, exp: 0 }))).kind).toBe(
      OUTCOME_PLAN_ATTEMPT,
    );
    expect(planSuccessfulOutcome(prepared(runWith({ grade: "SR", level: 15, exp: 0 }))).kind).toBe(
      OUTCOME_PLAN_ATTEMPT,
    );

    const edit = planSuccessfulOutcome(prepared(runWith({ grade: "R", level: 3, exp: 100 })));
    expect(edit).toMatchObject({
      kind: OUTCOME_PLAN_STOCK,
      nextState: { grade: "R", level: 3, exp: 100 },
      pendingEvent: {
        kit: "blue",
        recommendedUses: 2,
        resultState: { grade: "R", level: 3, exp: 100 },
      },
    });
  });

  it("plans a failed run with the same stock, telemetry, and next input", () => {
    const plan = planFailedOutcome(prepared(runWith({ grade: "R", level: 3, exp: 100 }, 2)));

    expect(plan).toMatchObject({
      nextState: { grade: "R", level: 1, exp: 0 },
      stockAfter: { blue: 80, purple: 50, yellow: 20 },
      stockCountAfter: 80,
      statsEvent: {
        kind: "kit_result",
        kit: "blue",
        recommendedUses: 2,
        outcome: "no_great_success",
        successAttempt: null,
      },
      calculation: {
        nextInput: {
          start: { grade: "R", level: 1, exp: 0 },
          stock: { blue: 80, purple: 50, yellow: 20 },
          strategy: "supply",
        },
        previousAction: { kit: "blue", count: 2 },
      },
    });
  });

  it("plans a known great-success attempt from the live stock snapshot", () => {
    const context = contextWith(runWith({ grade: "R", level: 4, exp: 0 }, 3));
    const plan = planSuccessAttempt(context, 2, { blue: 130, purple: 40, yellow: 10 });

    expect(plan).toMatchObject({
      stockAfter: { blue: 80, purple: 40, yellow: 10 },
      stockCountAfter: 80,
      statsEvent: {
        outcome: "great_success",
        successAttempt: 2,
        stockBefore: { blue: 120, purple: 50, yellow: 20 },
        stockAfter: { blue: 80, purple: 40, yellow: 10 },
      },
      calculation: {
        nextInput: {
          start: { grade: "R", level: 4, exp: 0 },
          stock: { blue: 80, purple: 40, yellow: 10 },
          strategy: "supply",
        },
      },
    });
  });

  it("keeps unknown R15 telemetry pending across conversion but not final SR15", () => {
    const conversion = planSuccessAttempt(
      contextWith(runWith({ grade: "R", level: 15, exp: 0 })),
      null,
      null,
    );
    const final = planSuccessAttempt(
      contextWith(runWith({ grade: "SR", level: 15, exp: 0 })),
      null,
      null,
    );

    expect(conversion).toMatchObject({
      reachesConvertState: true,
      needsStockEdit: false,
      pendingEvent: { resultState: { grade: "SR", level: 5, exp: 0 } },
    });
    expect(final).toMatchObject({
      reachesFinalTarget: true,
      needsStockEdit: false,
      pendingEvent: null,
    });
  });

  it("requires a stock snapshot only when the success attempt is known", () => {
    const context = contextWith(runWith({ grade: "R", level: 4, exp: 0 }));

    expect(() => planSuccessAttempt(context, 1, null)).toThrow("Missing stock snapshot.");
    expect(planSuccessAttempt(context, null, null)).not.toHaveProperty("calculation");
  });

  it("plans R15 conversion without losing pending telemetry or strategy", () => {
    const pendingEvent = {
      start,
      kit: "blue" as const,
      recommendedUses: 3,
      stockBefore: stock,
      resultState: { grade: "R" as const, level: 15, exp: 0 },
    };
    const plan = planConversion({ grade: "R", level: 15, exp: 0 }, stock, pendingEvent, {
      start,
      stock,
      strategy: "supply",
    });

    expect(plan).toMatchObject({
      hasPendingGreatSuccess: true,
      nextState: { grade: "SR", level: 5, exp: 0 },
      pendingEvent: { resultState: { grade: "SR", level: 5, exp: 0 } },
      nextInput: {
        start: { grade: "SR", level: 5, exp: 0 },
        stock,
        strategy: "supply",
      },
    });
    expect(canApplyConversion({ grade: "R", level: 14, exp: 0 })).toBe(false);
    expect(planConversion({ grade: "SR", level: 15, exp: 0 }, stock, null, undefined)).toBeNull();
  });
});
