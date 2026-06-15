import type {
  DetailView,
  LoadingView,
  ResultView,
  StateChangeFeedback,
  ValidationView,
} from "../ui-types";
import { DEFAULT_STOCK_NOTICE } from "./calculatorShared";
import type { useCalculatorState } from "./useCalculatorState";
import type { useOutcomeFlow } from "./useOutcomeFlow";
import type { useStats } from "./useStats";
import type { useTheme } from "./useTheme";

type CalculatorState = ReturnType<typeof useCalculatorState>;
type OutcomeFlow = ReturnType<typeof useOutcomeFlow>;
type StatsState = ReturnType<typeof useStats>;
type ThemeState = ReturnType<typeof useTheme>;

type CalculatorAppModelOptions = {
  calculatorState: CalculatorState;
  detailView: DetailView;
  loading: LoadingView;
  outcomeFlow: OutcomeFlow;
  resultView: ResultView;
  runCalculation: () => Promise<void>;
  runMonteCarloValidation: () => Promise<void>;
  statsView: StatsState["statsView"];
  stateFeedback: StateChangeFeedback | null;
  theme: ThemeState;
  validationView: ValidationView;
  applyOutcomeAndMaybeCalculate: (outcome: "success" | "fail") => Promise<void>;
  resetInputs: () => void;
};

export function makeCalculatorAppModel({
  applyOutcomeAndMaybeCalculate,
  calculatorState,
  detailView,
  loading,
  outcomeFlow,
  resetInputs,
  resultView,
  runCalculation,
  runMonteCarloValidation,
  stateFeedback,
  statsView,
  theme,
  validationView,
}: CalculatorAppModelOptions) {
  return {
    statePanel: calculatorState.statePanel,
    stockPanel: {
      stock: calculatorState.stock,
      needsStockEdit: calculatorState.manualStockEditRequired,
      notice: DEFAULT_STOCK_NOTICE,
    },
    solvePanel: calculatorState.solvePanel,
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
      setStock: calculatorState.actions.setStock,
      calculate: runCalculation,
      reset: resetInputs,
      applyOutcome: applyOutcomeAndMaybeCalculate,
      applyConvert: outcomeFlow.applyConvert,
      runMonteCarloValidation,
      setModalAttempt: outcomeFlow.setModalAttempt,
      submitSuccessAttempt: outcomeFlow.submitSuccessAttempt,
    },
  };
}
