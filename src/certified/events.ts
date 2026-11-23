import { receiptDay } from "../../shared/receiptClock";
import { CERTIFIED_RECOMMENDED_HORIZON_DAYS } from "../../shared/certifiedHorizon";
import { type CertifiedSupplyEvent, isCertifiedEventModeled } from "../../shared/certifiedSupply";
import {
  certifiedSupplyLawPayloadBytes,
  type ExactSupplyOutcome,
  getCertifiedLawDistribution,
} from "../../shared/certifiedSupplyLaws";
import type { WorkBudget } from "./budget";
import type { CertifiedInput, CertifiedWaiting } from "./types";

/** Exact elapsed-day cutoffs. A positive offset never includes a past receipt. */
export function eventOffset(input: Pick<CertifiedInput,"asOf">, event: CertifiedSupplyEvent): number {
  return receiptDay(Date.parse(input.asOf), Date.parse(event.at));
}
export function futureEvents(input: Pick<CertifiedInput,"asOf"|"snapshot"|"receivedEventIds">): CertifiedSupplyEvent[] {
  const received = new Set(input.receivedEventIds ?? []);
  return input.snapshot.events
    .filter((event) => {
      const d = eventOffset(input, event);
      return (
        d >= 1 &&
        d <= CERTIFIED_RECOMMENDED_HORIZON_DAYS &&
        isCertifiedEventModeled(input.snapshot, event, input.asOf) &&
        !received.has(event.id)
      );
    })
    .sort((a, b) => Date.parse(a.at) - Date.parse(b.at) || a.id.localeCompare(b.id));
}
export function law(
  input: CertifiedInput,
  event: CertifiedSupplyEvent,
  refIndex: number,
  cohort: 0 | 1 | 2 | 3,
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
    horizonDays: CERTIFIED_RECOMMENDED_HORIZON_DAYS,
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
