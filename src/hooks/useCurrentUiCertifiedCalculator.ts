import { useCallback, useEffect, useRef, useState } from "react";
import type { CertifiedInput } from "../certified/types";
import type { CertifiedCalculatorController } from "../certifiedUi/calculatorController";
import {
  restoreCertifiedCalculatorSession,
  serializeCertifiedCalculatorSession,
} from "../certifiedUi/calculatorSessionPersistence";
import { createCertifiedSession } from "../certifiedUi/session";
import { useCertifiedCalculatorController } from "../certifiedUi/useCertifiedCalculatorApp";
import {
  settledCertifiedBridge,
  type CertifiedBridgeState,
  type CertifiedSessionStore,
} from "../certifiedUi/useCertifiedCalculatorSession";
import { useStatsQuery } from "./useStatsQuery";
import { useTheme } from "./useTheme";

export const CURRENT_UI_CERTIFIED_STORAGE_KEY = "collection-current-ui-certified-local-test-v1:session";

export type CurrentUiCertifiedController = Omit<
  CertifiedCalculatorController, "accountDeps" | "accountToken"
>;

/** The reset undo path must never invoke the public guest-key quarantine writer. */
export function restoreCurrentUiCertifiedQuarantine(
  bridge: CertifiedBridgeState,
  setSaveFailed: (failed: boolean) => void,
) {
  if (!bridge.storageBlocked || bridge.blockedStorageText === null) return;
  try {
    localStorage.setItem(CURRENT_UI_CERTIFIED_STORAGE_KEY, bridge.blockedStorageText);
    setSaveFailed(false);
  } catch (failure) {
    if (!(failure instanceof DOMException)) throw failure;
    setSaveFailed(true);
  }
}

/** No legacy-key fallback or import: malformed local bytes remain untouched. */
export function initialCurrentUiCertifiedBridge(): CertifiedBridgeState {
  const empty = settledCertifiedBridge(
    createCertifiedSession("initial", { grade: "R", level: 0, exp: 0 }, [0, 0, 0]),
  );
  let text: string | null = null;
  try {
    text = localStorage.getItem(CURRENT_UI_CERTIFIED_STORAGE_KEY);
    const restored = restoreCertifiedCalculatorSession(text);
    return restored
      ? { ...settledCertifiedBridge(restored.session), correction: restored.correction }
      : empty;
  } catch {
    return {
      ...empty,
      storageBlocked: true,
      blockedStorageText: text,
      actionError: "invalid_certified_calculator_storage",
    };
  }
}

function useCurrentUiCertifiedSession(): CertifiedSessionStore {
  const [bridge, setBridge] = useState(initialCurrentUiCertifiedBridge);
  const [saveFailed, setSaveFailed] = useState(false);
  // This private store is externally persisted: suppress the public guest-key writer.
  // Account dependencies are never exposed by this bridge.
  const accountMode = useRef(true);
  const latest = useRef(bridge);
  const publish = useCallback((next: CertifiedBridgeState) => {
    latest.current = next;
    setBridge(next);
  }, []);
  const fail = useCallback((failure: unknown) => {
    publish({
      ...latest.current,
      actionError: failure instanceof Error ? failure.message : "certified_action_error",
    });
  }, [publish]);
  useEffect(() => {
    if (bridge.storageBlocked) return;
    try {
      localStorage.setItem(
        CURRENT_UI_CERTIFIED_STORAGE_KEY,
        serializeCertifiedCalculatorSession(bridge.session, bridge.correction),
      );
      setSaveFailed(false);
    } catch (failure) {
      if (!(failure instanceof DOMException)) throw failure;
      setSaveFailed(true);
    }
  }, [bridge.session, bridge.correction, bridge.storageBlocked]);
  return { bridge, latest, publish, fail, saveFailed, setSaveFailed, accountMode };
}

/** Current shell adapter: native certified results only, no legacy worker or account port. */
export function useCurrentUiCertifiedCalculator(
  statsQueryEnabled = false,
  stableRecommendation?: CertifiedInput["stableRecommendation"],
) {
  const store = useCurrentUiCertifiedSession();
  const controller = useCertifiedCalculatorController(store, undefined, undefined, {
    autoRecommendation: true,
    ...(stableRecommendation ? { stableRecommendation } : {}),
  });
  const theme = useTheme(controller.session.state.grade);
  // Local-test outcomes do not enter the production statistics submission outbox.
  const { statsView, retryStats } = useStatsQuery(statsQueryEnabled);
  const { accountDeps: _accountDeps, accountToken: _accountToken, ...calculator } = controller;
  const cancel = () => {
    controller.run.cancel();
  };
  const reset = () => {
    const previous = store.latest.current;
    const undo = controller.actions.reset();
    if (!previous.storageBlocked) return undo;
    return () => {
      controller.run.invalidate();
      store.publish(previous);
      restoreCurrentUiCertifiedQuarantine(previous, store.setSaveFailed);
    };
  };
  return {
    ...calculator,
    actions: { ...calculator.actions, reset },
    run: { ...calculator.run, cancel },
    ...theme,
    statsView,
    retryStats,
    busy: controller.run.busy,
    error: controller.actionError ?? controller.prepareError ?? controller.run.error,
    calculate: controller.actions.calculate,
    cancel,
  };
}

export type CurrentUiCertifiedCalculator = ReturnType<typeof useCurrentUiCertifiedCalculator>;
