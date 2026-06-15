import {
  type CollectionState,
  failAfterUses,
  greatSuccessState,
  KIT_ORDER,
  type Kit,
} from "./domain";
import {
  field,
  intInRange,
  normalizeState,
  normalizeStock,
  sameState,
} from "./event-validation-common";
import type {
  SubmissionEnvelope,
  UnknownRecord,
  ValidatedSubmission,
} from "./event-validation-types";
import { HttpError } from "./http-error";
import { normalizeSourceHost } from "./normalization";

const MAX_RECOMMENDED_USES = 100;

export function validateKitResultSubmission(
  payload: SubmissionEnvelope,
  event: UnknownRecord,
): ValidatedSubmission {
  const start = normalizeState(field(event, "start"), false);
  const resultState = normalizeState(field(event, "resultState"), true);
  const stockBefore = normalizeStock(field(event, "stockBefore"));
  const stockAfter = normalizeStock(field(event, "stockAfter"));
  const inputKit = field(event, "kit");
  const kit = KIT_ORDER.includes(inputKit as Kit) ? (inputKit as Kit) : null;
  if (!kit) throw new HttpError(400, "invalid_kit");
  const recommendedUses = intInRange(
    field(event, "recommendedUses"),
    1,
    MAX_RECOMMENDED_USES,
    "invalid_recommended_uses",
  );
  const inputOutcome = field(event, "outcome");
  const outcome =
    inputOutcome === "great_success" || inputOutcome === "no_great_success" ? inputOutcome : null;
  if (!outcome) throw new HttpError(400, "invalid_outcome");

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

function validateGreatSuccessOutcome(
  event: UnknownRecord,
  start: CollectionState,
  resultState: CollectionState,
  recommendedUses: number,
  usedAttempts: number,
) {
  const successAttempt = intInRange(
    field(event, "successAttempt"),
    1,
    recommendedUses,
    "invalid_success_attempt",
  );
  if (usedAttempts !== successAttempt) {
    throw new HttpError(400, "stock_delta_does_not_match_success_attempt");
  }
  if (!sameState(resultState, greatSuccessState(start))) {
    throw new HttpError(400, "invalid_success_result_state");
  }
  return successAttempt;
}

function validateNoGreatSuccessOutcome(
  event: UnknownRecord,
  start: CollectionState,
  resultState: CollectionState,
  kit: Kit,
  recommendedUses: number,
  usedAttempts: number,
) {
  if (field(event, "successAttempt") !== null && field(event, "successAttempt") !== undefined) {
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
