import {
  type CollectionState,
  failOnce,
  greatSuccessState,
  KIT_ORDER,
  type Kit,
} from "../../shared/game";
import type { StockCorrectionView } from "../ui-types";
import { type CertifiedSession, recordCertifiedOutcome } from "./session";

export type CertifiedBatch = {
  before: CertifiedSession;
  kit: Kit;
  uses: number;
  at: string;
};

function batchLevelChanged(batch: CertifiedBatch, state: CollectionState) {
  return state.grade !== batch.before.state.grade || state.level !== batch.before.state.level;
}

/** Every consumed use has a native ledger entry; the recommendation ends at a level change. */
export function applyCertifiedBatch(
  batch: CertifiedBatch,
  successAttempt: number | null,
): CertifiedSession {
  if (!Number.isInteger(batch.uses) || batch.uses < 1 || batch.uses > 10)
    throw new Error("invalid_certified_batch");
  if (
    successAttempt !== null &&
    (!Number.isInteger(successAttempt) || successAttempt < 1 || successAttempt > batch.uses)
  )
    throw new Error("invalid_success_attempt");
  let next = batch.before;
  const count = successAttempt ?? batch.uses;
  for (let attempt = 1; attempt <= count; attempt++) {
    const outcome = attempt === successAttempt ? "great" : "normal";
    next = recordCertifiedOutcome(next, batch.kit, outcome, batch.at);
    if (outcome === "great" || batchLevelChanged(batch, next.state)) {
      if (successAttempt !== null && attempt !== successAttempt)
        throw new Error("success_after_batch_stop");
      break;
    }
  }
  return next;
}

/** Unknown consumption changes no stock and creates no outcome entries. */
export function unresolvedCertifiedSuccess(batch: CertifiedBatch): CertifiedSession {
  return { ...batch.before, state: greatSuccessState(batch.before.state) };
}

export function resolveCertifiedStockCorrection(
  batch: CertifiedBatch,
  session: CertifiedSession,
): { view: StockCorrectionView; successAttempt: number | null } {
  const index = KIT_ORDER.indexOf(batch.kit);
  const beforeStock = batch.before.stock[index] ?? 0;
  const currentStock = session.stock[index] ?? 0;
  const base = {
    allowedMaximum: Math.max(0, beforeStock - 10),
    allowedMinimum: Math.max(0, beforeStock - batch.uses * 10),
    beforeStock,
    currentStock,
    canCalculate: false,
    kit: batch.kit,
    recommendedUses: batch.uses,
  };
  const invalid = (reason: NonNullable<StockCorrectionView["reason"]>) => ({
    view: { ...base, status: "invalid" as const, reason },
    successAttempt: null,
  });
  const expected = greatSuccessState(batch.before.state);
  if (
    session.state.grade !== expected.grade ||
    session.state.level !== expected.level ||
    session.state.exp !== expected.exp
  )
    return invalid("state_changed");
  if (KIT_ORDER.some((_, i) => i !== index && session.stock[i] !== batch.before.stock[i]))
    return invalid("other_kit_changed");
  const used = beforeStock - currentStock;
  if (used === 0) return invalid("unchanged");
  if (used < 0) return invalid("selected_kit_increased");
  if (!Number.isInteger(used) || used % 10 !== 0) return invalid("invalid_delta");
  const successAttempt = used / 10;
  if (successAttempt > batch.uses) return invalid("too_many_attempts");
  // Validate the normal prefix without recording any uses. Only explicit confirmation
  // may turn an entered inventory amount into native outcome ledger entries.
  let state = batch.before.state;
  for (let attempt = 1; attempt < successAttempt; attempt++) {
    state = failOnce(state, batch.kit);
    if (batchLevelChanged(batch, state)) return invalid("too_many_attempts");
  }
  return {
    view: { ...base, canCalculate: true, status: "valid", successAttempt },
    successAttempt,
  };
}
