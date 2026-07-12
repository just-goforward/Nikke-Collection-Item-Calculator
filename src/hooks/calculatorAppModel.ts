import type { Grade, Stock } from "../types";
import type {
  DetailView,
  LoadingView,
  ResultView,
  StateChangeFeedback,
  StatePanelModel,
  StatsView,
  SuccessAttemptModalState,
  ThemeMode,
  ValidationView,
} from "../ui-types";
import { DEFAULT_STOCK_NOTICE } from "./calculatorShared";
import type { OutcomeApplyResult } from "./outcomeFlowTypes";
import type { useCalculatorState } from "./useCalculatorState";
import type { useOutcomeFlow } from "./useOutcomeFlow";
import type { useStats } from "./useStats";
import type { useTheme } from "./useTheme";

type CalculatorState = ReturnType<typeof useCalculatorState>;
type OutcomeFlow = ReturnType<typeof useOutcomeFlow>;
type StatsState = ReturnType<typeof useStats>;
type ThemeState = ReturnType<typeof useTheme>;

export type CalculatorAppModel = {
  statePanel: StatePanelModel;
  stockPanel: {
    stock: Stock;
    needsStockEdit: boolean;
    isStale: boolean;
    staleSource: "state" | "stock" | null;
    stockStale: boolean;
    notice: string;
  };
  solvePanel: { description: string; calculateDisabled: boolean };
  resultView: ResultView;
  detailView: DetailView;
  validationView: ValidationView;
  statsView: StatsView;
  loading: LoadingView;
  modal: SuccessAttemptModalState;
  themeMode: ThemeMode;
  stateFeedback: StateChangeFeedback | null;
  actions: {
    setThemeMode: (mode: ThemeMode) => void;
    setGrade: (grade: Grade) => void;
    setLevel: (level: number) => void;
    setExp: (exp: number) => void;
    setStock: (stock: Stock) => void;
    calculate: () => Promise<void>;
    reset: () => void;
    applyOutcome: (outcome: "success" | "fail") => Promise<OutcomeApplyResult>;
    clearActionTransition: (transitionId: number) => void;
    applyConvert: () => { needsStockEdit: boolean };
    runMonteCarloValidation: () => Promise<void>;
    submitSuccessAttempt: (attempt: number | null) => void;
  };
};

type CalculatorAppModelOptions = {
  calculatorState: CalculatorState;
  detailView: DetailView;
  loading: LoadingView;
  isResultStale: boolean;
  staleSource: "state" | "stock" | null;
  outcomeFlow: OutcomeFlow;
  resultView: ResultView;
  runCalculation: () => Promise<void>;
  runMonteCarloValidation: () => Promise<void>;
  setStock: (stock: Stock) => void;
  statsView: StatsState["statsView"];
  stateFeedback: StateChangeFeedback | null;
  theme: ThemeState;
  validationView: ValidationView;
  applyOutcomeAndMaybeCalculate: (outcome: "success" | "fail") => Promise<OutcomeApplyResult>;
  clearActionTransition: (transitionId: number) => void;
  resetInputs: () => void;
};

function canRecalculateStaleStockAtMaxLevel(
  calculatorState: CalculatorState,
  isResultStale: boolean,
  staleSource: "state" | "stock" | null,
) {
  if (!isResultStale || staleSource !== "stock") return false;
  if (calculatorState.manualStockEditRequired || calculatorState.calculateBusy) return false;
  const { stock } = calculatorState;
  return stock.blue >= 10 || stock.purple >= 10 || stock.yellow >= 10;
}

export function makeCalculatorAppModel({
  applyOutcomeAndMaybeCalculate,
  calculatorState,
  clearActionTransition,
  detailView,
  isResultStale,
  loading,
  outcomeFlow,
  resetInputs,
  resultView,
  runCalculation,
  runMonteCarloValidation,
  setStock,
  stateFeedback,
  statsView,
  staleSource,
  theme,
  validationView,
}: CalculatorAppModelOptions): CalculatorAppModel {
  const calculateDisabled =
    calculatorState.solvePanel.calculateDisabled &&
    !canRecalculateStaleStockAtMaxLevel(calculatorState, isResultStale, staleSource);

  return {
    statePanel: calculatorState.statePanel,
    stockPanel: {
      stock: calculatorState.stock,
      needsStockEdit: calculatorState.manualStockEditRequired,
      isStale: isResultStale,
      staleSource,
      stockStale: isResultStale && staleSource === "stock",
      notice: DEFAULT_STOCK_NOTICE,
    },
    solvePanel: {
      ...calculatorState.solvePanel,
      calculateDisabled,
    },
    resultView,
    detailView,
    validationView,
    statsView,
    loading,
    modal: outcomeFlow.modal,
    themeMode: theme.themeMode,
    stateFeedback,
    actions: {
      setThemeMode: theme.setThemeMode,
      setGrade: calculatorState.actions.setGrade,
      setLevel: calculatorState.actions.setLevel,
      setExp: calculatorState.actions.setExp,
      setStock,
      calculate: runCalculation,
      reset: resetInputs,
      applyOutcome: applyOutcomeAndMaybeCalculate,
      clearActionTransition,
      applyConvert: outcomeFlow.applyConvert,
      runMonteCarloValidation,
      submitSuccessAttempt: outcomeFlow.submitSuccessAttempt,
    },
  };
}
