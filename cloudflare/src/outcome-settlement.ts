import {
  assertOutcomeSettlementBinding, type OutcomeLegacySettlement, type OutcomeRawFacts,
} from "../../shared/decisionOutcomeV4.ts";
import { publicationHash } from "../../shared/forecastPublication.ts";
import { validateKitResultSubmission } from "./event-validation-kit.ts";
import type { ValidatedKitResultEvent } from "./event-validation-types.ts";

/** The v4 parser supplies the legacy schema bounds; this existing validator retains
 * stock deltas, game transitions, EXP steps and the start-level boundary authority.
 */
export function validateOutcomeSettlement(
  reportId: string, facts: OutcomeRawFacts, settlement: OutcomeLegacySettlement | null,
  explicitAttempt: number | null = facts.attemptCount,
): ValidatedKitResultEvent | null {
  if (!settlement) return null;
  assertOutcomeSettlementBinding(facts, settlement, explicitAttempt);
  return validateKitResultSubmission({
    eventId: reportId, sourceHost: undefined, deliveryHealth: undefined,
  }, settlement).event as ValidatedKitResultEvent;
}
export function legacySettlementDigest(reportId: string, settlement: OutcomeLegacySettlement): Promise<string> {
  return publicationHash({ reportId, legacySettlement: settlement });
}
