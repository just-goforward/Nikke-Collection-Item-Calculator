import { useMemo, useState } from "react";

import { STRATEGY_META } from "../solver/domain";
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
    stateRef,
    statePanel,
    solvePanel: {
      description: STRATEGY_META.supply.description,
      calculateDisabled,
    },
    setCollectionState: stateActions.setCollectionState,
    setStockCountForKit: stateActions.setStockCountForKit,
    setManualStockEditRequired,
    setCalculateBusy,
    collectInput: stateActions.collectInput,
    currentStateSnapshot: stateActions.currentStateSnapshot,
    resetState: stateActions.resetState,
    actions: stateActions.actions,
  };
}
