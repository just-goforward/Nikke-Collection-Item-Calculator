import { useCallback, useEffect, useMemo, useRef, useState } from "react";

import { normalizeState, STRATEGY_META } from "../solver";
import type { CollectionState, Grade, Kit, SolverInput, Stock, Strategy } from "../types";
import type { StatePanelModel } from "../ui-types";
import { clampStock, requiredForGrade, sanitizeExpValue } from "./calculatorShared";

const ACTIVE_STRATEGY: Strategy = "supply";

type CalculatorStateRef = {
  grade: Grade;
  level: number;
  exp: number;
  stock: Stock;
  strategy: Strategy;
  manualStockEditRequired: boolean;
};

type UseCalculatorStateOptions = {
  onInputChanged: (manualStockEditRequired: boolean) => void;
  onMaxLevelState: (grade: Grade, level: number) => void;
};

export function useCalculatorState({ onInputChanged, onMaxLevelState }: UseCalculatorStateOptions) {
  const [grade, setGradeState] = useState<Grade>("R");
  const [level, setLevelState] = useState(0);
  const [exp, setExpState] = useState(0);
  const [stock, setStockState] = useState<Stock>({ blue: 0, purple: 0, yellow: 0 });
  const [manualStockEditRequired, setManualStockEditRequired] = useState(false);
  const [calculateBusy, setCalculateBusy] = useState(false);
  const stateRef = useRef<CalculatorStateRef>({
    grade,
    level,
    exp,
    stock,
    strategy: ACTIVE_STRATEGY,
    manualStockEditRequired,
  });

  useEffect(() => {
    stateRef.current = {
      grade,
      level,
      exp,
      stock,
      strategy: ACTIVE_STRATEGY,
      manualStockEditRequired,
    };
  }, [grade, level, exp, stock, manualStockEditRequired]);

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

  const strategyDescription = STRATEGY_META.supply.description;
  const calculateDisabled = level >= 15 || manualStockEditRequired || calculateBusy;

  const setCollectionState = useCallback(
    (next: CollectionState, options: { maxLevelRender?: boolean; markChanged?: boolean } = {}) => {
      const normalized = normalizeState(next) as CollectionState;
      setGradeState(normalized.grade);
      setLevelState(normalized.level);
      setExpState(sanitizeExpValue(normalized.grade, normalized.level, normalized.exp));
      if (options.maxLevelRender !== false && normalized.level >= 15) {
        onMaxLevelState(normalized.grade, normalized.level);
      } else if (options.markChanged) {
        onInputChanged(manualStockEditRequired);
      }
    },
    [manualStockEditRequired, onInputChanged, onMaxLevelState],
  );

  const collectInput = useCallback((): SolverInput => {
    const current = stateRef.current;
    const safeExp = sanitizeExpValue(current.grade, current.level, current.exp);
    if (safeExp !== current.exp) setExpState(safeExp);
    return {
      start: {
        grade: current.grade,
        level: current.level,
        exp: safeExp,
      },
      stock: { ...current.stock },
      strategy: ACTIVE_STRATEGY,
    };
  }, []);

  const currentStateSnapshot = useCallback((): CollectionState => {
    const current = stateRef.current;
    return {
      grade: current.grade,
      level: current.level,
      exp: sanitizeExpValue(current.grade, current.level, current.exp),
    };
  }, []);

  const setStockCountForKit = useCallback((kit: Kit, value: number) => {
    setStockState((current) => ({
      ...current,
      [kit]: Math.max(0, Math.floor(Number(value) || 0)),
    }));
  }, []);

  const setGrade = useCallback(
    (nextGrade: Grade) => {
      const nextExp = sanitizeExpValue(nextGrade, level, exp);
      setGradeState(nextGrade);
      setExpState(nextExp);
      if (level >= 15) onMaxLevelState(nextGrade, level);
      else onInputChanged(manualStockEditRequired);
    },
    [exp, level, manualStockEditRequired, onInputChanged, onMaxLevelState],
  );

  const setLevel = useCallback(
    (nextLevel: number) => {
      const rawLevel = Number(nextLevel);
      const safeLevel = Math.min(
        15,
        Math.max(0, Number.isFinite(rawLevel) ? Math.trunc(rawLevel) : 0),
      );
      const nextExp = sanitizeExpValue(grade, safeLevel, exp);
      setLevelState(safeLevel);
      setExpState(nextExp);
      if (safeLevel >= 15) onMaxLevelState(grade, safeLevel);
      else onInputChanged(manualStockEditRequired);
    },
    [exp, grade, manualStockEditRequired, onInputChanged, onMaxLevelState],
  );

  const setExp = useCallback(
    (nextExp: number) => {
      setExpState(sanitizeExpValue(grade, level, nextExp));
      onInputChanged(manualStockEditRequired);
    },
    [grade, level, manualStockEditRequired, onInputChanged],
  );

  const setStock = useCallback(
    (nextStock: Stock) => {
      setStockState(clampStock(nextStock));
      setManualStockEditRequired(false);
      onInputChanged(false);
    },
    [onInputChanged],
  );

  const resetState = useCallback(() => {
    setManualStockEditRequired(false);
    setGradeState("R");
    setLevelState(0);
    setExpState(0);
    setStockState({ blue: 0, purple: 0, yellow: 0 });
  }, []);

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
      description: strategyDescription,
      calculateDisabled,
    },
    setCollectionState,
    setStockCountForKit,
    setManualStockEditRequired,
    setCalculateBusy,
    collectInput,
    currentStateSnapshot,
    resetState,
    actions: {
      setGrade,
      setLevel,
      setExp,
      setStock,
    },
  };
}
