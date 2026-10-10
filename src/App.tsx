import { useState } from "react";

import { type AppHandlers, AppLayout, preloadDetailPanel } from "./AppLayout";
import type { MobileTab } from "./components/MobileChrome";
import type { CalculatorAppModel } from "./hooks/calculatorAppModel";
import { useAppShellNavigation } from "./hooks/useAppShellNavigation";
import { useCalculatorApp } from "./hooks/useCalculatorApp";
import { statsRuntimeMode } from "./lib/statsRuntime";
import type { Grade, Stock } from "./types";

type InputSnapshot = {
  grade: Grade;
  level: number;
  exp: number;
  stock: Stock;
};

type AppHandlerOptions = {
  calculator: CalculatorAppModel;
  resetWithUndo: () => void;
  setMobileViewTab: (next: MobileTab, focus?: boolean) => void;
  setPendingOutcome: (outcome: "success" | "fail" | null) => void;
};

function makeAppHandlers({
  calculator,
  resetWithUndo,
  setMobileViewTab,
  setPendingOutcome,
}: AppHandlerOptions): AppHandlers {
  const { actions } = calculator;

  return {
    onCalculate: async () => {
      preloadDetailPanel();
      setPendingOutcome(null);
      const started = await actions.calculate();
      if (!started) return;
      setMobileViewTab("result", true);
    },
    onReset: () => {
      if (!calculator.inputLocked) resetWithUndo();
    },
    onConvert: async () => {
      preloadDetailPanel();
      setPendingOutcome(null);
      const applied = await actions.applyConvert();
      if (!applied) return;
      if (applied?.needsStockEdit) {
        setMobileViewTab("input", true);
        return;
      }
      setMobileViewTab("result", true);
    },
    onOutcome: async (outcome) => {
      preloadDetailPanel();
      const applied = await actions.applyOutcome(outcome);
      if (!applied) return;
      setPendingOutcome(null);
      setMobileViewTab(applied?.needsStockEdit ? "input" : "result", true);
    },
  };
}

export default function App() {
  const [pendingOutcome, setPendingOutcome] = useState<"success" | "fail" | null>(null);
  const shell = useAppShellNavigation<InputSnapshot>();
  const { mobileTab, setMobileViewTab, viewTab } = shell;
  const calculator = useCalculatorApp(shell.statsVisible);
  const { actions } = calculator;
  const statsMode = statsRuntimeMode();

  const rememberInputSnapshot = (): InputSnapshot => ({
    grade: calculator.statePanel.grade,
    level: calculator.statePanel.level,
    exp: calculator.statePanel.exp,
    stock: { ...calculator.stockPanel.stock },
  });

  const restoreInputSnapshot = (snapshot: InputSnapshot) => {
    actions.restoreInputSnapshot(snapshot);
    setMobileViewTab("input", true);
    shell.clearResetToast();
  };

  const resetWithUndo = () => {
    const snapshot = rememberInputSnapshot();
    setPendingOutcome(null);
    actions.reset();
    setMobileViewTab("input", true);
    shell.showResetToast(snapshot);
  };
  const resetToast = shell.resetToast;

  const handlers = makeAppHandlers({
    calculator,
    resetWithUndo,
    setMobileViewTab,
    setPendingOutcome,
  });

  return (
    <AppLayout
      calculator={calculator}
      handlers={handlers}
      mobileTab={mobileTab}
      pendingOutcome={pendingOutcome}
      onTabChange={(tab) => setMobileViewTab(tab)}
      onPendingOutcomeChange={setPendingOutcome}
      onViewTabChange={shell.setViewTab}
      resetToast={
        resetToast
          ? {
              secondsLeft: resetToast.secondsLeft,
              onUndo: () => restoreInputSnapshot(resetToast.payload),
            }
          : null
      }
      statsMode={statsMode}
      viewTab={viewTab}
    />
  );
}
