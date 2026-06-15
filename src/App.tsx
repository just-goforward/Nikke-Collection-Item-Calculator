import { useState } from "react";

import { type AppHandlers, AppLayout } from "./AppLayout";
import type { MobileTab } from "./components/MobileChrome";
import { useCalculatorApp } from "./hooks/useCalculatorApp";
import { solverBackendFromRuntime } from "./lib/solverRuntime";
import { statsRuntimeMode } from "./lib/statsRuntime";

export default function App() {
  const calculator = useCalculatorApp();
  const { actions } = calculator;
  const [mobileTab, setMobileTab] = useState<MobileTab>("input");
  const statsMode = statsRuntimeMode();
  const solverBackend = solverBackendFromRuntime();

  const handlers: AppHandlers = {
    onCalculate: async () => {
      await actions.calculate();
      setMobileTab("result");
    },
    onReset: () => {
      actions.reset();
      setMobileTab("input");
    },
    onConvert: () => {
      actions.applyConvert();
      setMobileTab("input");
    },
    onOutcome: async (outcome) => {
      await actions.applyOutcome(outcome);
      setMobileTab(outcome === "success" ? "input" : "result");
    },
  };

  return (
    <AppLayout
      calculator={calculator}
      handlers={handlers}
      mobileTab={mobileTab}
      onTabChange={setMobileTab}
      solverBackend={solverBackend}
      statsMode={statsMode}
    />
  );
}
