import { type CertifiedSupplyEvent, isCertifiedEventModeled } from "../../shared/certifiedSupply";
import {
  certifiedSupplyLawPayloadBytes,
  type ExactSupplyOutcome,
  getCertifiedLawDistribution,
} from "../../shared/certifiedSupplyLaws";
import type { WorkBudget } from "./budget";
import type { CertifiedInput, CertifiedWaiting } from "./types";

const GAME_DAY_MS = 86_400_000;
/** Dates are game dates (the snapshot owns the 05:00 KST boundary). */
export function eventOffset(input: CertifiedInput, event: CertifiedSupplyEvent): number {
  const day =
    (Date.parse(`${event.gameDate}T00:00:00Z`) -
      Date.parse(`${input.snapshot.coverage.currentDay}T00:00:00Z`)) /
    GAME_DAY_MS;
  // D0 contains only input stock. A later reward today first belongs to D1.
  return day === 0 && Date.parse(event.at) > Date.parse(input.asOf) ? 1 : day;
}
export function futureEvents(input: CertifiedInput): CertifiedSupplyEvent[] {
  const received = new Set(input.receivedEventIds ?? []);
  return input.snapshot.events
    .filter((event) => {
      const d = eventOffset(input, event);
      return (
        d >= 1 &&
        d <= 56 &&
        isCertifiedEventModeled(input.snapshot, event, input.asOf) &&
        !received.has(event.id)
      );
    })
    .sort((a, b) => eventOffset(input, a) - eventOffset(input, b) || a.id.localeCompare(b.id));
}
export function law(
  input: CertifiedInput,
  event: CertifiedSupplyEvent,
  refIndex: number,
  cohort: 0 | 1 | 2,
  budget: WorkBudget,
): readonly ExactSupplyOutcome[] {
  // Production callers enumerate refs.length. For a missing reference, the
  // existing decoder's native property read throws; the operation boundary
  // accepts that input without asserting a reference exists.
  type LawLookup = {
    (
      ref: undefined,
      cohort: Parameters<typeof getCertifiedLawDistribution>[1],
      options: Parameters<typeof getCertifiedLawDistribution>[2],
    ): never;
    (
      ref: Parameters<typeof getCertifiedLawDistribution>[0],
      cohort: Parameters<typeof getCertifiedLawDistribution>[1],
      options: Parameters<typeof getCertifiedLawDistribution>[2],
    ): ReturnType<typeof getCertifiedLawDistribution>;
    (
      ref: Parameters<typeof getCertifiedLawDistribution>[0] | undefined,
      cohort: Parameters<typeof getCertifiedLawDistribution>[1],
      options: Parameters<typeof getCertifiedLawDistribution>[2],
    ): ReturnType<typeof getCertifiedLawDistribution>;
  };
  budget.check();
  const outcomes = (getCertifiedLawDistribution as LawLookup)(event.refs[refIndex], cohort, {
    laws: input.snapshot.laws,
    checkBudget: budget.check,
  });
  budget.setExternalPayload(certifiedSupplyLawPayloadBytes());
  return outcomes;
}
export function waitingBase(
  status: CertifiedWaiting["status"],
  reason: string | null,
): CertifiedWaiting {
  return {
    status,
    horizonDays: 56,
    recommendedDays: null,
    rangeBoundary: false,
    bestDayRange: null,
    value: null,
    evaluatedDays: [0],
    successImprovementUpperBound: null,
    successProbabilityInterval: null,
    reason,
    evidence: [],
  };
}
