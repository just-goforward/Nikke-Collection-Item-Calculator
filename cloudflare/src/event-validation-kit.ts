import {
  type CollectionState,
  failAfterUses,
  greatSuccessState,
  KIT_ORDER,
  type Kit,
} from "../../shared/game";
import { sameState, validateState } from "./event-validation-common";
import type { SubmissionEnvelope, ValidatedSubmission } from "./event-validation-types";
import { HttpError } from "./http-error";
import { normalizeSourceHost } from "./normalization";
import type { KitResultEventInput } from "./schemas";

export function validateKitResultSubmission(
  payload: SubmissionEnvelope,
  event: KitResultEventInput,
): ValidatedSubmission {
  const start = validateState(event.start, false);
  const resultState = validateState(event.resultState, true);
  const { kit, outcome, recommendedUses, stockAfter, stockBefore } = event;

  const otherChanged = KIT_ORDER.some(
    (name) => name !== kit && stockBefore[name] !== stockAfter[name],
  );
  if (otherChanged) throw new HttpError(400, "unexpected_stock_change");
  const usedKits = stockBefore[kit] - stockAfter[kit];
  if (usedKits <= 0 || usedKits % 10 !== 0) throw new HttpError(400, "invalid_stock_delta");
  const usedAttempts = usedKits / 10;
  const successAttempt =
    outcome === "great_success"
      ? validateGreatSuccessOutcome(event, start, resultState, recommendedUses, usedAttempts)
      : validateNoGreatSuccessOutcome(
          event,
          start,
          resultState,
          kit,
          recommendedUses,
          usedAttempts,
        );
  assertAttemptsStayWithinStartLevel(start, kit, usedAttempts);

  return {
    eventId: payload.eventId,
    sourceHost: normalizeSourceHost(payload.sourceHost),
    event: {
      kind: "kit_result",
      start,
      kit,
      recommendedUses,
      outcome,
      successAttempt,
      stockBefore,
      stockAfter,
      resultState,
    },
  };
}

function assertAttemptsStayWithinStartLevel(
  start: CollectionState,
  kit: Kit,
  usedAttempts: number,
) {
  if (usedAttempts <= 1) return;
  const stateBeforeLastAttempt = failAfterUses(start, kit, usedAttempts - 1);
  if (
    stateBeforeLastAttempt.grade !== start.grade ||
    stateBeforeLastAttempt.level !== start.level
  ) {
    throw new HttpError(400, "attempts_cross_level_boundary");
  }
}

function validateGreatSuccessOutcome(
  event: KitResultEventInput,
  start: CollectionState,
  resultState: CollectionState,
  recommendedUses: number,
  usedAttempts: number,
) {
  const successAttempt = event.successAttempt;
  if (successAttempt === null || successAttempt === undefined || successAttempt > recommendedUses) {
    throw new HttpError(400, "invalid_success_attempt");
  }
  if (usedAttempts !== successAttempt) {
    throw new HttpError(400, "stock_delta_does_not_match_success_attempt");
  }
  if (!sameState(resultState, greatSuccessState(start))) {
    throw new HttpError(400, "invalid_success_result_state");
  }
  return successAttempt;
}

function validateNoGreatSuccessOutcome(
  event: KitResultEventInput,
  start: CollectionState,
  resultState: CollectionState,
  kit: Kit,
  recommendedUses: number,
  usedAttempts: number,
) {
  if (event.successAttempt !== null && event.successAttempt !== undefined) {
    throw new HttpError(400, "unexpected_success_attempt");
  }
  if (usedAttempts !== recommendedUses) {
    throw new HttpError(400, "stock_delta_does_not_match_recommended_uses");
  }
  if (!sameState(resultState, failAfterUses(start, kit, recommendedUses))) {
    throw new HttpError(400, "invalid_fail_result_state");
  }
  return null;
}
