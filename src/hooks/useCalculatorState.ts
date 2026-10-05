import { useEffect, useMemo, useState } from "react";

import { message } from "../i18n/locale";
import { bindLegacyInputRecovery } from "../lib/lazyModuleRetry";
import type { LegacyRecoveryNotice } from "../lib/legacyInputRecovery";
import type { Grade, Stock } from "../types";
import type { StatePanelModel } from "../ui-types";
import { requiredForGrade } from "./calculatorShared";
import {
  ACTIVE_STRATEGY,
  EMPTY_STOCK,
  type UseCalculatorStateOptions,
  useCalculatorStateActions,
  useCalculatorStateRef,
} from "./calculatorStateActions";

export function useCalculatorState({ onInputChanged, onMaxLevelState }: UseCalculatorStateOptions) {
  const [grade, setGradeState] = useState<Grade>("R");
  const [level, setLevelState] = useState(0);
  const [exp, setExpState] = useState(0);
  const [stock, setStockState] = useState<Stock>(EMPTY_STOCK);
  const [manualStockEditRequired, setManualStockEditRequired] = useState(false);
  const [calculateBusy, setCalculateBusy] = useState(false);
  const [reloadRecoveryNotice, setReloadRecoveryNotice] = useState<LegacyRecoveryNotice | null>(
    null,
  );
  const stateValues = { grade, level, exp, stock, manualStockEditRequired };
  const stateRef = useCalculatorStateRef(stateValues);
  const statePanel: StatePanelModel = useMemo(
    () => ({
      grade,
      level,
      exp,
      requiredExp: requiredForGrade(grade),
      expDisabled: level >= 15,
    }),
    [grade, level, exp],
  );
  const stateActions = useCalculatorStateActions({
    ...stateValues,
    onInputChanged,
    onMaxLevelState,
    setters: {
      setExpState,
      setGradeState,
      setLevelState,
      setManualStockEditRequired,
      setStockState,
    },
    stateRef,
  });
  const { restoreInputSnapshot } = stateActions;
  useEffect(() => {
    const unbind = bindLegacyInputRecovery(() => {
      const current = stateRef.current;
      return current.manualStockEditRequired ? null : current;
    });
    let active = true;
    let inputRevision = 0;
    let stopTracking = () => {};
    const before = stateRef.current;
    try {
      if (sessionStorage.getItem("nikke:legacy-reload-input:v1")) {
        const edited = (event: Event) => {
          if (event.target instanceof Element && event.target.closest(".input-column"))
            inputRevision += 1;
        };
        document.addEventListener("input", edited, true);
        document.addEventListener("click", edited, true);
        stopTracking = () => {
          document.removeEventListener("input", edited, true);
          document.removeEventListener("click", edited, true);
        };
        void import("../lib/legacyInputRecovery")
          .then(({ consumeLegacyInputRecovery, LEGACY_PENDING_RECOVERY_NOTICE }) => {
            if (!active) return;
            const input = consumeLegacyInputRecovery(
              sessionStorage,
              location.pathname + location.search,
            );
            if (input === "pending") setReloadRecoveryNotice(LEGACY_PENDING_RECOVERY_NOTICE);
            else if (input && inputRevision === 0 && stateRef.current === before)
              restoreInputSnapshot(input);
          })
          .catch(() => false)
          .finally(stopTracking);
      }
    } catch {
      active = false;
    }
    return () => {
      active = false;
      unbind();
      stopTracking();
    };
  }, [restoreInputSnapshot, stateRef]);
  const hasUsableStock = stock.blue >= 10 || stock.purple >= 10 || stock.yellow >= 10;
  const calculateDisabled =
    level >= 15 || manualStockEditRequired || calculateBusy || !hasUsableStock;

  return {
    grade,
    level,
    exp,
    stock,
    strategy: ACTIVE_STRATEGY,
    manualStockEditRequired,
    calculateBusy,
    reloadRecoveryNotice,
    stateRef,
    statePanel,
    solvePanel: {
      description: message("solver.strategySupply"),
      calculateDisabled,
    },
    setCollectionState: stateActions.setCollectionState,
    setStockCountForKit: stateActions.setStockCountForKit,
    setManualStockEditRequired,
    setCalculateBusy,
    collectInput: stateActions.collectInput,
    currentStateSnapshot: stateActions.currentStateSnapshot,
    restoreInputSnapshot: stateActions.restoreInputSnapshot,
    resetState: stateActions.resetState,
    actions: stateActions.actions,
  };
}
