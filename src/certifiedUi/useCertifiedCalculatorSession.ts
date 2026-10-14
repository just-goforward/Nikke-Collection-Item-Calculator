import { useCallback, useEffect, useRef, useState } from "react";
import type { SuccessAttemptModalState } from "../ui-types";
import type { CertifiedBatch } from "./calculatorSessionActions";
import {
  restoreCertifiedCalculatorSession,
  serializeCertifiedCalculatorSession,
} from "./calculatorSessionPersistence";
import {
  CERTIFIED_SESSION_STORAGE_KEY,
  type CertifiedSession,
  createCertifiedSession,
  LEGACY_CERTIFIED_SESSION_STORAGE_KEY,
  restoreCertifiedSession,
} from "./session";

export const CLOSED_CERTIFIED_MODAL: SuccessAttemptModalState = {
  open: false,
  maxAttempt: 1,
  attempt: 1,
};

export type CertifiedBridgeState = {
  session: CertifiedSession;
  correction: CertifiedBatch | null;
  modalBatch: CertifiedBatch | null;
  modal: SuccessAttemptModalState;
  actionError: string | null;
  storageBlocked: boolean;
  blockedStorageText: string | null;
};

export function settledCertifiedBridge(session: CertifiedSession): CertifiedBridgeState {
  return {
    session,
    correction: null,
    modalBatch: null,
    modal: CLOSED_CERTIFIED_MODAL,
    actionError: null,
    storageBlocked: false,
    blockedStorageText: null,
  };
}

function initialBridge(): CertifiedBridgeState {
  const emptySession = () =>
    createCertifiedSession("initial", { grade: "R", level: 0, exp: 0 }, [0, 0, 0]);
  let storedText: string | null = null;
  try {
    storedText =
      localStorage.getItem(CERTIFIED_SESSION_STORAGE_KEY) ??
      localStorage.getItem(LEGACY_CERTIFIED_SESSION_STORAGE_KEY);
    // Live storage has no authenticated original snapshot: non-point legacy
    // mixtures reset with a notice; fixed selections are preserved, not replayed.
    const restored = restoreCertifiedCalculatorSession(storedText);
    if (!restored) return settledCertifiedBridge(emptySession());
    return { ...settledCertifiedBridge(restored.session), correction: restored.correction };
  } catch {
    return {
      ...settledCertifiedBridge(emptySession()),
      storageBlocked: true,
      blockedStorageText: storedText,
      actionError: "invalid_certified_calculator_storage",
    };
  }
}

export function validatedCertifiedSession(next: CertifiedSession) {
  const validated = restoreCertifiedSession(JSON.stringify(next));
  if (!validated) throw new Error("invalid_certified_session_input");
  return validated;
}

/** Browser refusals of a session write are reported for the UI; other failures still propagate. */
export function writeCertifiedSessionStorage(
  text: string,
  setSaveFailed: (failed: boolean) => void,
) {
  try {
    localStorage.setItem(CERTIFIED_SESSION_STORAGE_KEY, text);
    setSaveFailed(false);
  } catch (failure) {
    if (!(failure instanceof DOMException)) throw failure;
    setSaveFailed(true);
  }
}

export function useCertifiedCalculatorSession() {
  const [bridge, setBridge] = useState<CertifiedBridgeState>(initialBridge);
  // Kept outside the bridge: commits settle the bridge, but only a later successful write clears this.
  const [saveFailed, setSaveFailed] = useState(false);
  const latest = useRef(bridge);
  const publish = useCallback((next: CertifiedBridgeState) => {
    latest.current = next;
    setBridge(next);
  }, []);
  const fail = useCallback(
    (failure: unknown) => {
      publish({
        ...latest.current,
        actionError: failure instanceof Error ? failure.message : "certified_action_error",
      });
    },
    [publish],
  );
  return { bridge, latest, publish, fail, saveFailed, setSaveFailed };
}

export type CertifiedSessionStore = ReturnType<typeof useCertifiedCalculatorSession>;

/** Pending state and its pre-outcome ledger are persisted together; rejected bytes stay quarantined. */
export function useCertifiedSessionPersistence(
  bridge: CertifiedBridgeState,
  setSaveFailed: CertifiedSessionStore["setSaveFailed"],
) {
  useEffect(() => {
    if (bridge.storageBlocked) return;
    writeCertifiedSessionStorage(
      serializeCertifiedCalculatorSession(bridge.session, bridge.correction),
      setSaveFailed,
    );
  }, [bridge.session, bridge.correction, bridge.storageBlocked, setSaveFailed]);
}
