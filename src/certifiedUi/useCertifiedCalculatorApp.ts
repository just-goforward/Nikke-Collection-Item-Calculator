import { useMemo } from "react";
import {
  compareCertifiedSupplyPeriods,
  isCertifiedEventClaimable,
} from "../../shared/certifiedSupply";
import { REQUIRED_EXP } from "../../shared/game";
import type { Stock } from "../types";
import type { CertifiedCalculatorController } from "./calculatorController";
import { resolveCertifiedStockCorrection } from "./calculatorSessionActions";
import { certifiedClaimableEvents } from "./session";
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

/** The native session is the only calculator input; no legacy solver or stats flow is started. */
export function useCertifiedCalculatorApp(): CertifiedCalculatorController {
  const store = useCertifiedCalculatorSession();
  const preparation = useCertifiedCalculatorSnapshot();
  const ownership = useCertifiedCalculatorRun(store.bridge.session, preparation);
  const { updateSession, actions } = useCertifiedCalculatorActions(
    store,
    ownership,
    preparation.snapshotRef,
  );
  // Keep native binding, persistence, preparation, and committed recomputation effects in order.
  useCertifiedSessionPersistence(store.bridge);
  useCertifiedCalculatorPreparation(preparation, store.latest, ownership.retire, updateSession);
  useCertifiedActionRecomputation(
    store.bridge.session,
    store.latest,
    ownership.recompute,
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
  const now = Date.now();
  const claims = snapshot
    ? certifiedClaimableEvents(snapshot.events, bridge.session, now).filter((event) =>
        isCertifiedEventClaimable(snapshot, event, new Date(now).toISOString()),
      )
    : [];
  const correction = bridge.correction
    ? resolveCertifiedStockCorrection(bridge.correction, bridge.session).view
    : null;
  const run = ownership.view(actions.calculate);
  return {
    session: bridge.session,
    updateSession,
    snapshot,
    prepareError,
    comparison,
    claims,
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
    stockCorrectionRequired: !!bridge.correction || bridge.storageBlocked,
    stockCorrection: correction,
    modal: bridge.modal,
    actionError: bridge.actionError,
    actions,
  };
}
