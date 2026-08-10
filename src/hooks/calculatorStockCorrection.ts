import type { StatsSubmissionEvent } from "../lib/statsSubmissionQueue";
import type { CollectionState, Kit, Stock } from "../types";
import { KIT_KEYS, makeStatsEvent, type PendingStatsEvent, sameState } from "./calculatorShared";

type StockCorrectionInvalidReason =
  | "unchanged"
  | "state_changed"
  | "other_kit_changed"
  | "selected_kit_increased"
  | "invalid_delta"
  | "too_many_attempts";

type StockCorrectionBase = {
  allowedMaximum: number;
  allowedMinimum: number;
  beforeStock: number;
  canDiscardStats: boolean;
  currentStock: number;
  kit: Kit;
  recommendedUses: number;
};

export type PendingStockCorrectionResolution =
  | { status: "none" }
  | (StockCorrectionBase & {
      status: "invalid";
      reason: StockCorrectionInvalidReason;
      changedKits: Kit[];
    })
  | (StockCorrectionBase & {
      status: "valid";
      event: StatsSubmissionEvent;
      successAttempt: number;
    });

function stockChanged(before: Stock, after: Stock) {
  return KIT_KEYS.some((kit) => before[kit] !== after[kit]);
}

export function resolvePendingStockCorrection(
  pending: PendingStatsEvent | null,
  currentState: CollectionState,
  stockAfter: Stock,
): PendingStockCorrectionResolution {
  if (!pending) return { status: "none" };

  const before = pending.stockBefore;
  const changedKits = KIT_KEYS.filter((kit) => before[kit] !== stockAfter[kit]);
  const stateMatches = sameState(currentState, pending.resultState);
  const base: StockCorrectionBase = {
    allowedMaximum: Math.max(0, before[pending.kit] - 10),
    allowedMinimum: Math.max(0, before[pending.kit] - pending.recommendedUses * 10),
    beforeStock: before[pending.kit],
    canDiscardStats: stateMatches && stockChanged(before, stockAfter),
    currentStock: stockAfter[pending.kit],
    kit: pending.kit,
    recommendedUses: pending.recommendedUses,
  };
  const invalid = (reason: StockCorrectionInvalidReason): PendingStockCorrectionResolution => ({
    ...base,
    status: "invalid",
    reason,
    changedKits,
  });

  if (!stateMatches) return invalid("state_changed");
  if (changedKits.some((kit) => kit !== pending.kit)) return invalid("other_kit_changed");

  const usedPieces = before[pending.kit] - stockAfter[pending.kit];
  if (usedPieces === 0) return invalid("unchanged");
  if (usedPieces < 0) return invalid("selected_kit_increased");
  if (!Number.isInteger(usedPieces) || usedPieces % 10 !== 0) return invalid("invalid_delta");

  const successAttempt = usedPieces / 10;
  if (successAttempt > pending.recommendedUses) return invalid("too_many_attempts");

  return {
    ...base,
    status: "valid",
    successAttempt,
    event: makeStatsEvent({
      start: pending.start,
      kit: pending.kit,
      recommendedUses: pending.recommendedUses,
      outcome: "great_success",
      successAttempt,
      stockBefore: before,
      stockAfter,
      resultState: pending.resultState,
    }),
  };
}
