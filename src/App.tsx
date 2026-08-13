import { useEffect, useState } from "react";

import { type AppHandlers, AppLayout, preloadDetailPanel } from "./AppLayout";
import type { MobileTab } from "./components/MobileChrome";
import type { TopViewTab } from "./components/TopBar";
import type { CalculatorAppModel } from "./hooks/calculatorAppModel";
import { useCalculatorApp } from "./hooks/useCalculatorApp";
import { statsRuntimeMode } from "./lib/statsRuntime";
import type { Grade, Stock } from "./types";

type InputSnapshot = {
  grade: Grade;
  level: number;
  exp: number;
  stock: Stock;
};

type ResetToast = {
  snapshot: InputSnapshot;
  secondsLeft: number;
};

type AppHandlerOptions = {
  calculator: CalculatorAppModel;
  resetWithUndo: () => void;
  setMobileViewTab: (next: MobileTab, focus?: boolean) => void;
  setPendingOutcome: (outcome: "success" | "fail" | null) => void;
};

const RESET_UNDO_SECONDS = 5;

function viewTabFromHash(): TopViewTab {
  if (typeof window === "undefined") return "calc";
  return window.location.hash === "#stats" ? "stats" : "calc";
}

function replaceHashForView(viewTab: TopViewTab) {
  if (typeof window === "undefined") return;
  const nextUrl = `${window.location.pathname}${window.location.search}${
    viewTab === "stats" ? "#stats" : ""
  }`;
  window.history.replaceState(null, "", nextUrl);
}

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
  const [mobileTab, setMobileTab] = useState<MobileTab>("input");
  const [pendingOutcome, setPendingOutcome] = useState<"success" | "fail" | null>(null);
  const [viewTab, setViewTabState] = useState<TopViewTab>(viewTabFromHash);
  const [resetToast, setResetToast] = useState<ResetToast | null>(null);
  const calculator = useCalculatorApp(viewTab === "stats" || mobileTab === "stats");
  const { actions } = calculator;
  const statsMode = statsRuntimeMode();

  useEffect(() => {
    const syncFromHash = () => {
      const next = viewTabFromHash();
      setViewTabState(next);
      setMobileTab((current) =>
        next === "stats" ? "stats" : current === "stats" ? "input" : current,
      );
    };
    syncFromHash();
    window.addEventListener("hashchange", syncFromHash);
    return () => window.removeEventListener("hashchange", syncFromHash);
  }, []);

  const setViewTab = (next: TopViewTab) => {
    setViewTabState(next);
    replaceHashForView(next);
    if (next === "stats") {
      setMobileTab("stats");
      return;
    }
    setMobileTab((current) => (current === "stats" ? "input" : current));
  };

  const setMobileViewTab = (next: MobileTab, focus = false) => {
    setMobileTab(next);
    const nextViewTab = next === "stats" ? "stats" : "calc";
    setViewTabState(nextViewTab);
    replaceHashForView(nextViewTab);
    if (focus && window.matchMedia("(max-width: 660px)").matches) {
      window.requestAnimationFrame(() => document.getElementById(`mobile-tab-${next}`)?.focus());
    }
  };

  useEffect(() => {
    if (!resetToast) return undefined;
    if (resetToast.secondsLeft <= 0) {
      setResetToast(null);
      return undefined;
    }
    const timer = window.setTimeout(() => {
      setResetToast((current) =>
        current ? { ...current, secondsLeft: current.secondsLeft - 1 } : null,
      );
    }, 1000);
    return () => window.clearTimeout(timer);
  }, [resetToast]);

  const rememberInputSnapshot = (): InputSnapshot => ({
    grade: calculator.statePanel.grade,
    level: calculator.statePanel.level,
    exp: calculator.statePanel.exp,
    stock: { ...calculator.stockPanel.stock },
  });

  const restoreInputSnapshot = (snapshot: InputSnapshot) => {
    actions.restoreInputSnapshot(snapshot);
    setMobileViewTab("input", true);
    setResetToast(null);
  };

  const resetWithUndo = () => {
    const snapshot = rememberInputSnapshot();
    setPendingOutcome(null);
    actions.reset();
    setMobileViewTab("input", true);
    setResetToast({ snapshot, secondsLeft: RESET_UNDO_SECONDS });
  };

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
      onViewTabChange={setViewTab}
      resetToast={
        resetToast
          ? {
              secondsLeft: resetToast.secondsLeft,
              onUndo: () => restoreInputSnapshot(resetToast.snapshot),
            }
          : null
      }
      statsMode={statsMode}
      viewTab={viewTab}
    />
  );
}
