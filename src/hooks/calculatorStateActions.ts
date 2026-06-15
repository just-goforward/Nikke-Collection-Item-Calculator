import {
  type Dispatch,
  type RefObject,
  type SetStateAction,
  useCallback,
  useEffect,
  useRef,
} from "react";

import { normalizeState } from "../solver/domain";
import type { CollectionState, Grade, Kit, SolverInput, Stock, Strategy } from "../types";
import { clampStock, sanitizeExpValue } from "./calculatorShared";

export const ACTIVE_STRATEGY: Strategy = "supply";
export const EMPTY_STOCK: Stock = { blue: 0, purple: 0, yellow: 0 };

export type CalculatorStateRef = {
  grade: Grade;
  level: number;
  exp: number;
  stock: Stock;
  strategy: Strategy;
  manualStockEditRequired: boolean;
};

export type CalculatorStateValues = {
  grade: Grade;
  level: number;
  exp: number;
  stock: Stock;
  manualStockEditRequired: boolean;
};

export type CalculatorStateSetters = {
  setGradeState: Dispatch<SetStateAction<Grade>>;
  setLevelState: Dispatch<SetStateAction<number>>;
  setExpState: Dispatch<SetStateAction<number>>;
  setStockState: Dispatch<SetStateAction<Stock>>;
  setManualStockEditRequired: Dispatch<SetStateAction<boolean>>;
};

export type UseCalculatorStateOptions = {
  onInputChanged: (manualStockEditRequired: boolean) => void;
  onMaxLevelState: (grade: Grade, level: number) => void;
};

function safeLevelFromInput(nextLevel: number) {
  const rawLevel = Number(nextLevel);
  return Math.min(15, Math.max(0, Number.isFinite(rawLevel) ? Math.trunc(rawLevel) : 0));
}

export function useCalculatorStateRef({
  exp,
  grade,
  level,
  manualStockEditRequired,
  stock,
}: CalculatorStateValues) {
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

  return stateRef;
}

type CalculatorActionOptions = CalculatorStateValues & {
  onInputChanged: (manualStockEditRequired: boolean) => void;
  onMaxLevelState: (grade: Grade, level: number) => void;
  setters: CalculatorStateSetters;
  stateRef: RefObject<CalculatorStateRef>;
};

function useCalculatorCoreActions({
  manualStockEditRequired,
  onInputChanged,
  onMaxLevelState,
  setters,
  stateRef,
}: CalculatorActionOptions) {
  const { setExpState, setGradeState, setLevelState } = setters;
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
    [
      manualStockEditRequired,
      onInputChanged,
      onMaxLevelState,
      setExpState,
      setGradeState,
      setLevelState,
    ],
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
  }, [setExpState, stateRef]);

  const currentStateSnapshot = useCallback((): CollectionState => {
    const current = stateRef.current;
    return {
      grade: current.grade,
      level: current.level,
      exp: sanitizeExpValue(current.grade, current.level, current.exp),
    };
  }, [stateRef]);

  return {
    setCollectionState,
    collectInput,
    currentStateSnapshot,
  };
}

function useCalculatorInputActions({
  exp,
  grade,
  level,
  manualStockEditRequired,
  onInputChanged,
  onMaxLevelState,
  setters,
}: CalculatorActionOptions) {
  const { setExpState, setGradeState, setLevelState, setManualStockEditRequired, setStockState } =
    setters;
  const setStockCountForKit = useCallback(
    (kit: Kit, value: number) => {
      setStockState((current) => ({
        ...current,
        [kit]: Math.max(0, Math.floor(Number(value) || 0)),
      }));
    },
    [setStockState],
  );

  const setGrade = useCallback(
    (nextGrade: Grade) => {
      const nextExp = sanitizeExpValue(nextGrade, level, exp);
      setGradeState(nextGrade);
      setExpState(nextExp);
      if (level >= 15) onMaxLevelState(nextGrade, level);
      else onInputChanged(manualStockEditRequired);
    },
    [
      exp,
      level,
      manualStockEditRequired,
      onInputChanged,
      onMaxLevelState,
      setExpState,
      setGradeState,
    ],
  );

  const setLevel = useCallback(
    (nextLevel: number) => {
      const safeLevel = safeLevelFromInput(nextLevel);
      const nextExp = sanitizeExpValue(grade, safeLevel, exp);
      setLevelState(safeLevel);
      setExpState(nextExp);
      if (safeLevel >= 15) onMaxLevelState(grade, safeLevel);
      else onInputChanged(manualStockEditRequired);
    },
    [
      exp,
      grade,
      manualStockEditRequired,
      onInputChanged,
      onMaxLevelState,
      setExpState,
      setLevelState,
    ],
  );

  const setExp = useCallback(
    (nextExp: number) => {
      setExpState(sanitizeExpValue(grade, level, nextExp));
      onInputChanged(manualStockEditRequired);
    },
    [grade, level, manualStockEditRequired, onInputChanged, setExpState],
  );

  const setStock = useCallback(
    (nextStock: Stock) => {
      setStockState(clampStock(nextStock));
      setManualStockEditRequired(false);
      onInputChanged(false);
    },
    [onInputChanged, setManualStockEditRequired, setStockState],
  );

  const resetState = useCallback(() => {
    setManualStockEditRequired(false);
    setGradeState("R");
    setLevelState(0);
    setExpState(0);
    setStockState(EMPTY_STOCK);
  }, [setExpState, setGradeState, setLevelState, setManualStockEditRequired, setStockState]);

  return {
    setStockCountForKit,
    resetState,
    actions: {
      setGrade,
      setLevel,
      setExp,
      setStock,
    },
  };
}

export function useCalculatorStateActions(options: CalculatorActionOptions) {
  const coreActions = useCalculatorCoreActions(options);
  const inputActions = useCalculatorInputActions(options);
  return {
    ...coreActions,
    ...inputActions,
  };
}
