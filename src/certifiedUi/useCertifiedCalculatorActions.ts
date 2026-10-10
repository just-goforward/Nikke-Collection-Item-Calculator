import { type Dispatch, type SetStateAction, useCallback } from "react";
import { KIT_ORDER, REQUIRED_EXP } from "../../shared/game";
import type { Stock } from "../types";
import type { CertifiedCalculatorController } from "./calculatorController";
import {
  applyCertifiedBatch,
  type CertifiedBatch,
  resolveCertifiedStockCorrection,
  unresolvedCertifiedSuccess,
} from "./calculatorSessionActions";
import { showCertifiedRunResults } from "./runStatus";
import {
  CERTIFIED_SESSION_STORAGE_KEY,
  type CertifiedSession,
  convertCertifiedSession,
  createCertifiedSession,
} from "./session";
import type { CertifiedSnapshotState } from "./useCertifiedCalculatorPreparation";
import type { CertifiedRunOwnership } from "./useCertifiedCalculatorRun";
import {
  type CertifiedSessionStore,
  CLOSED_CERTIFIED_MODAL,
  settledCertifiedBridge,
  validatedCertifiedSession,
} from "./useCertifiedCalculatorSession";

type Commit = (next: CertifiedSession, autoCalculate?: boolean) => void;
type SessionActions = Pick<CertifiedSessionStore, "latest" | "publish" | "fail"> & {
  commit: Commit;
  retire: () => void;
};
type ActionContext = SessionActions & {
  ownership: CertifiedRunOwnership;
  snapshotRef: CertifiedSnapshotState["snapshotRef"];
};
type CalculationContext = Pick<SessionActions, "latest" | "commit" | "fail"> &
  Pick<CertifiedRunOwnership, "canStart" | "calculateNative"> & {
    snapshotRef: CertifiedSnapshotState["snapshotRef"];
  };

function updateCertifiedSession(context: SessionActions, update: SetStateAction<CertifiedSession>) {
  const { latest, retire, commit, publish, fail } = context;
  retire();
  const current = latest.current;
  try {
    if (current.correction || current.storageBlocked) throw new Error("stock_correction_required");
    commit(typeof update === "function" ? update(current.session) : update);
  } catch (failure) {
    publish({ ...latest.current, modalBatch: null, modal: CLOSED_CERTIFIED_MODAL });
    fail(failure);
  }
}

async function calculateCertifiedAction(context: CalculationContext) {
  const { latest, snapshotRef, canStart, calculateNative, commit, fail } = context;
  const current = latest.current;
  if (
    current.storageBlocked ||
    current.modalBatch ||
    !snapshotRef.current ||
    !canStart(current.session)
  )
    return;
  if (!current.correction) {
    await calculateNative(current.session);
    return;
  }
  try {
    const resolution = resolveCertifiedStockCorrection(current.correction, current.session);
    if (!resolution.view.canCalculate || resolution.successAttempt === null) return;
    commit(applyCertifiedBatch(current.correction, resolution.successAttempt), true);
  } catch (failure) {
    fail(failure);
  }
}

function editCertifiedStock(context: SessionActions, stock: Stock) {
  const { latest, retire, commit, publish, fail } = context;
  retire();
  const current = latest.current;
  try {
    if (current.storageBlocked) throw new Error("stock_correction_required");
    const session = validatedCertifiedSession({
      ...current.session,
      stock: [stock.blue, stock.purple, stock.yellow],
    });
    if (current.correction)
      publish({
        ...current,
        session,
        modalBatch: null,
        modal: CLOSED_CERTIFIED_MODAL,
        actionError: null,
      });
    else commit(session);
  } catch (failure) {
    publish({ ...latest.current, modalBatch: null, modal: CLOSED_CERTIFIED_MODAL });
    fail(failure);
  }
}

function editCertifiedState(
  updateSession: Dispatch<SetStateAction<CertifiedSession>>,
  patch: Partial<CertifiedSession["state"]>,
) {
  updateSession((current) => {
    const state = { ...current.state, ...patch };
    state.level = Math.max(0, Math.min(15, Math.floor(state.level)));
    state.exp =
      state.level === 15
        ? 0
        : Math.max(0, Math.min(REQUIRED_EXP[state.grade] - 100, Math.floor(state.exp / 100) * 100));
    return { ...current, state };
  });
}

function authorizedCertifiedBatch(context: Pick<ActionContext, "latest" | "ownership">) {
  const current = context.latest.current;
  const { nativeRef, ownedSession, calculating } = context.ownership;
  const run = nativeRef.current;
  const recommendation = run.result?.current;
  if (
    current.correction ||
    current.storageBlocked ||
    current.modalBatch ||
    calculating.current ||
    run.busy ||
    ownedSession.current !== current.session ||
    !showCertifiedRunResults(run.error, run.result) ||
    recommendation?.status !== "use_certified" ||
    !recommendation.kit
  )
    return null;
  return {
    before: current.session,
    kit: recommendation.kit,
    uses: recommendation.uses,
    at: new Date().toISOString(),
  };
}

function openCertifiedSuccessModal(context: SessionActions, batch: CertifiedBatch) {
  context.retire();
  context.publish({
    ...context.latest.current,
    session: unresolvedCertifiedSuccess(batch),
    correction: batch,
    modalBatch: batch,
    modal: {
      open: true,
      maxAttempt: batch.uses,
      attempt: 1,
      kit: batch.kit,
      beforeStock: batch.before.stock[KIT_ORDER.indexOf(batch.kit)] ?? 0,
    },
    actionError: null,
  });
}

function applyCertifiedOutcome(context: ActionContext, outcome: "normal" | "great") {
  const batch = authorizedCertifiedBatch(context);
  if (!batch) {
    context.fail(new Error("certified_action_not_authorized"));
    return;
  }
  try {
    if (outcome === "great" && batch.uses > 1) openCertifiedSuccessModal(context, batch);
    else context.commit(applyCertifiedBatch(batch, outcome === "great" ? 1 : null), true);
  } catch (failure) {
    context.fail(failure);
  }
}

function submitCertifiedSuccessAttempt(context: SessionActions, attempt: number | null) {
  const current = context.latest.current;
  const batch = current.modalBatch;
  if (!batch) return;
  try {
    if (attempt === null) {
      context.retire();
      context.publish({
        ...settledCertifiedBridge(unresolvedCertifiedSuccess(batch)),
        correction: batch,
      });
    } else context.commit(applyCertifiedBatch(batch, attempt), true);
  } catch (failure) {
    context.fail(failure);
  }
}

function convertCertifiedCollection(context: SessionActions) {
  try {
    const current = context.latest.current;
    if (current.correction || current.modalBatch || current.storageBlocked)
      throw new Error("stock_correction_required");
    context.commit(convertCertifiedSession(current.session), true);
  } catch (failure) {
    context.fail(failure);
  }
}

function resetCertifiedCollection(context: SessionActions & Pick<ActionContext, "snapshotRef">) {
  const previous = context.latest.current;
  context.commit(
    createCertifiedSession(
      context.snapshotRef.current?.revision ?? "initial",
      { grade: "R", level: 0, exp: 0 },
      [0, 0, 0],
    ),
  );
  return () => {
    context.retire();
    context.publish(previous);
    // Restore quarantined bytes verbatim; they remain untrusted on the next reload.
    if (previous.storageBlocked && previous.blockedStorageText !== null) {
      try {
        localStorage.setItem(CERTIFIED_SESSION_STORAGE_KEY, previous.blockedStorageText);
      } catch (failure) {
        if (!(failure instanceof DOMException)) throw failure;
        context.fail(failure);
      }
    }
  };
}

export function useCertifiedCalculatorActions(
  store: CertifiedSessionStore,
  ownership: CertifiedRunOwnership,
  snapshotRef: CertifiedSnapshotState["snapshotRef"],
) {
  const { latest, publish, fail } = store;
  const { retire, recompute, canStart, calculateNative } = ownership;
  const commit = useCallback(
    (next: CertifiedSession, autoCalculate = false) => {
      const session = validatedCertifiedSession(next);
      retire();
      publish(settledCertifiedBridge(session));
      if (autoCalculate) recompute.current = session;
    },
    [publish, retire, recompute],
  );
  const updateSession: Dispatch<SetStateAction<CertifiedSession>> = useCallback(
    (update) => {
      updateCertifiedSession({ latest, publish, fail, commit, retire }, update);
    },
    [latest, publish, fail, commit, retire],
  );
  const calculate = useCallback(async () => {
    await calculateCertifiedAction({
      latest,
      snapshotRef,
      canStart,
      calculateNative,
      commit,
      fail,
    });
  }, [latest, snapshotRef, canStart, calculateNative, commit, fail]);
  const context: ActionContext = {
    latest,
    publish,
    fail,
    commit,
    retire,
    ownership,
    snapshotRef,
  };
  const actions: CertifiedCalculatorController["actions"] = {
    setGrade: (grade) => editCertifiedState(updateSession, { grade }),
    setLevel: (level) => editCertifiedState(updateSession, { level }),
    setExp: (exp) => editCertifiedState(updateSession, { exp }),
    setStock: (stock) => editCertifiedStock(context, stock),
    calculate,
    applyOutcome: (outcome) => applyCertifiedOutcome(context, outcome),
    submitSuccessAttempt: (attempt) => submitCertifiedSuccessAttempt(context, attempt),
    convert: () => convertCertifiedCollection(context),
    reset: () => resetCertifiedCollection(context),
  };
  return { updateSession, actions };
}
