import { useMemo } from "react";
import { compareCertifiedSupplyPeriods } from "../../shared/certifiedSupply";
import { REQUIRED_EXP } from "../../shared/game";
import type { StatsSubmissionEvent } from "../lib/statsSubmissionQueue";
import type { Stock } from "../types";
import type { CertifiedCalculatorController } from "./calculatorController";
import { resolveCertifiedStockCorrection } from "./calculatorSessionActions";
import { useCertifiedCalculatorActions } from "./useCertifiedCalculatorActions";
import {
  useCertifiedCalculatorPreparation,
  useCertifiedCalculatorSnapshot,
} from "./useCertifiedCalculatorPreparation";
import {
  useCertifiedActionRecomputation,
  useCertifiedCalculatorRun,
} from "./useCertifiedCalculatorRun";
import {
  useCertifiedCalculatorSession,
  useCertifiedSessionPersistence,
} from "./useCertifiedCalculatorSession";
import { useCertifiedDailyRecompute } from "./useCertifiedDailyRecompute";

/**
 * The native session is the only calculator input and no legacy solver is started. Statistics are
 * not started here either: the optional `queueStatsEvent` callback only receives confirmed
 * kit_result events, and the submission queue/outbox lives in the caller's stats hook.
 */
export function useCertifiedCalculatorApp(
  queueStatsEvent?: (event: StatsSubmissionEvent) => void,
): CertifiedCalculatorController {
  const store = useCertifiedCalculatorSession();
  const preparation = useCertifiedCalculatorSnapshot();
  const ownership = useCertifiedCalculatorRun(store.bridge.session, preparation);
  const { updateSession, actions } = useCertifiedCalculatorActions(
    store,
    ownership,
    preparation.snapshotRef,
    queueStatsEvent,
  );
  // Keep native binding, persistence, preparation, and committed recomputation effects in order.
  useCertifiedSessionPersistence(store.bridge, store.setSaveFailed, store.accountMode);
  useCertifiedCalculatorPreparation(
    preparation,
    store.latest,
    ownership.retire,
    updateSession,
    ownership.calculating,
  );
  useCertifiedActionRecomputation(
    store.bridge.session,
    store.latest,
    ownership.recompute,
    actions.calculate,
  );
  useCertifiedDailyRecompute(
    preparation.snapshot?.coverage.currentDay ?? null,
    !!store.bridge.correction ||
      store.bridge.storageBlocked ||
      store.bridge.modal.open ||
      ownership.nativeRef.current.busy,
    actions.calculate,
  );

  const { bridge } = store;
  const { snapshot, prepareError } = preparation;
  const comparison = useMemo(
    () => (snapshot ? compareCertifiedSupplyPeriods(snapshot, bridge.session.cohortWeights) : null),
    [snapshot, bridge.session.cohortWeights],
  );
  const stock = useMemo<Stock>(
    () => ({
      blue: bridge.session.stock[0],
      purple: bridge.session.stock[1],
      yellow: bridge.session.stock[2],
    }),
    [bridge.session.stock[0], bridge.session.stock[1], bridge.session.stock[2]],
  );
  const correction = bridge.correction
    ? resolveCertifiedStockCorrection(bridge.correction, bridge.session).view
    : null;
  const run = ownership.view(actions.calculate);
  const accountToken = useMemo(
    () => ({ session: bridge.session, correction: bridge.correction }),
    [bridge.session, bridge.correction],
  );
  return {
    // Plain references for the optional account control; no account code runs here.
    accountDeps: {
      latest: store.latest,
      publish: store.publish,
      accountMode: store.accountMode,
      retire: ownership.retire,
      snapshotRef: preparation.snapshotRef,
      updateSession,
    },
    accountToken,
    session: bridge.session,
    updateSession,
    snapshot,
    prepareError,
    comparison,
    run,
    statePanel: {
      ...bridge.session.state,
      requiredExp: REQUIRED_EXP[bridge.session.state.grade],
      expDisabled: bridge.session.state.level === 15,
    },
    stock,
    calculateDisabled:
      !snapshot ||
      run.busy ||
      (!!bridge.correction && !correction?.canCalculate) ||
      bridge.modal.open ||
      bridge.storageBlocked,
    inputLocked: run.busy || bridge.modal.open || bridge.storageBlocked,
    storageBlocked: bridge.storageBlocked,
    sessionSaveFailed: store.saveFailed,
    stockCorrectionRequired: !!bridge.correction || bridge.storageBlocked,
    stockCorrection: correction,
    modal: bridge.modal,
    actionError: bridge.actionError,
    actions,
  };
}
