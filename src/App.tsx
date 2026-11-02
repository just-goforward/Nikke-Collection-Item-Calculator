import { useEffect, useState } from "react";
import { type AppHandlers, AppLayout, preloadDetailPanel } from "./AppLayout";
import type { MobileTab } from "./components/MobileChrome";
import type { CalculatorAppModel } from "./hooks/calculatorAppModel";
import { useAppShellNavigation } from "./hooks/useAppShellNavigation";
import { useCalculatorApp } from "./hooks/useCalculatorApp";
import { statsRuntimeMode } from "./lib/statsRuntime";
import type { Grade, Stock } from "./types";
import { useDecisionPort } from "./analytics/useDecisionPort";
import { DecisionPresentation } from "./analytics/DecisionPresentation";
import { useMobileLayout } from "./hooks/useMobileLayout";
import { createProductionDecision } from "./analytics/decisionProduction";

type InputSnapshot = { grade: Grade; level: number; exp: number; stock: Stock };
type AppHandlerOptions = {
  calculator: CalculatorAppModel;
  resetWithUndo: () => void;
  setMobileViewTab: (next: MobileTab, focus?: boolean) => void;
  setPendingOutcome: (outcome: "success" | "fail" | null) => void;
};
function makeAppHandlers({
  calculator, resetWithUndo, setMobileViewTab, setPendingOutcome,
}: AppHandlerOptions): AppHandlers {
  const { actions } = calculator;
  const handlers: AppHandlers = {
    onCalculate: async () => {
      preloadDetailPanel();
      setPendingOutcome(null);
      const started = await actions.calculate();
      if (!started) return;
      setMobileViewTab("result", true);
    },
    onReset: () => { if (!calculator.inputLocked) resetWithUndo(); },
    onConvert: async () => {
      preloadDetailPanel();
      setPendingOutcome(null);
      const applied = await actions.applyConvert();
      if (!applied) return;
      if (applied?.needsStockEdit) { setMobileViewTab("input", true); return; }
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
  return handlers;
}
export default function App({ decision }: { decision?: Parameters<typeof useDecisionPort>[0] } = {}) {
  const [productionDecision, setProductionDecision] = useState<Awaited<ReturnType<typeof createProductionDecision>>>();
  useEffect(() => {
    let retired = false;
    let port: Awaited<ReturnType<typeof createProductionDecision>>;
    setProductionDecision(undefined);
    if (!decision) void createProductionDecision().then(next => {
      if (retired) next?.disable();
      else { port = next; setProductionDecision(next); }
    });
    return () => { retired = true; port?.disable(); };
  }, [decision]);
  const [pendingOutcome, setPendingOutcome] = useState<"success" | "fail" | null>(null);
  const shell = useAppShellNavigation<InputSnapshot>();
  const { mobileTab, setMobileViewTab, viewTab } = shell;
  const binding = useDecisionPort(decision ?? productionDecision);
  const model = useCalculatorApp(shell.statsVisible, binding.lifecycle);
  const calculator = model;
  const { actions } = calculator;
  const statsMode = statsRuntimeMode();
  const isMobile = useMobileLayout();
  const eligible = (isMobile ? mobileTab === "result" : viewTab !== "stats") &&
    !calculator.stockPanel.isStale && !calculator.stockPanel.needsStockEdit &&
    !calculator.inputLocked;
  const rememberInputSnapshot = (): InputSnapshot => ({
    grade: calculator.statePanel.grade, level: calculator.statePanel.level,
    exp: calculator.statePanel.exp, stock: { ...calculator.stockPanel.stock },
  });
  const restoreInputSnapshot = (snapshot: InputSnapshot) => {
    actions.restoreInputSnapshot(snapshot);
    setMobileViewTab("input", true);
    shell.clearResetToast();
  };
  const resetWithUndo = () => {
    const snapshot = rememberInputSnapshot();
    binding.explicitAction("reset");
    setPendingOutcome(null);
    actions.reset();
    setMobileViewTab("input", true);
    shell.showResetToast(snapshot);
  };
  const resetToast = shell.resetToast;
  const handlers = makeAppHandlers({
    calculator, resetWithUndo, setMobileViewTab, setPendingOutcome,
  });
  const observedHandlers = {
    ...handlers,
    onCalculate: async () => {
      if (!calculator.inputLocked) binding.explicitAction("recalculate");
      return handlers.onCalculate();
    },
  };
  return <DecisionPresentation.Provider value={{ lifecycle: binding.lifecycle, owner: binding.owner, eligible }}><AppLayout
    accountControl={null}
    calculator={calculator} handlers={observedHandlers} mobileTab={mobileTab}
    pendingOutcome={pendingOutcome} onTabChange={(tab) => setMobileViewTab(tab)}
    onPendingOutcomeChange={(value) => {
      binding.explicitAction(value === null ? "dismiss" : "outcome_open");
      setPendingOutcome(value);
    }}
    onViewTabChange={shell.setViewTab}
    resetToast={resetToast ? { secondsLeft: resetToast.secondsLeft, onUndo: () => restoreInputSnapshot(resetToast.payload) } : null}
    statsMode={statsMode} viewTab={viewTab}
  /></DecisionPresentation.Provider>;
}
