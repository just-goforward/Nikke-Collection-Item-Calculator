import { useState } from "react";

import DetailPanel from "./components/DetailPanel";
import LoadingOverlay from "./components/LoadingOverlay";
import {
  MobileActionBar,
  MobileStatusStrip,
  type MobileTab,
  MobileTabs,
} from "./components/MobileChrome";
import PrivacyFooter from "./components/PrivacyFooter";
import ResultPanel from "./components/ResultPanel";
import SolvePanel from "./components/SolvePanel";
import StatePanel from "./components/StatePanel";
import StatsPanel from "./components/StatsPanel";
import StockPanel from "./components/StockPanel";
import SuccessAttemptModal from "./components/SuccessAttemptModal";
import TopBar from "./components/TopBar";
import { useCalculatorApp } from "./hooks/useCalculatorApp";

const classes = {
  shell:
    "app-shell mx-auto w-[min(1320px,calc(100%_-_32px))] py-7 pb-[42px] max-mobile:w-[min(100%_-_20px,1320px)] max-mobile:py-2.5 max-mobile:pb-3.5",
  mobileHeader:
    "hidden max-mobile:sticky max-mobile:top-0 max-mobile:z-20 max-mobile:mx-[-10px] max-mobile:mb-3 max-mobile:block max-mobile:bg-page max-mobile:px-2.5 max-mobile:shadow-[0_1px_0_var(--line)]",
  workspace:
    "grid grid-cols-[minmax(0,1.05fr)_minmax(320px,0.68fr)_minmax(260px,0.48fr)] gap-4 min-[981px]:max-[1099px]:grid-cols-[minmax(0,1.14fr)_minmax(286px,0.66fr)_minmax(238px,0.46fr)] min-[981px]:max-[1099px]:gap-3 max-tablet:grid-cols-1 max-mobile:gap-2.5",
  gridCell: "contents max-mobile:block",
  gridCellHidden: "max-mobile:hidden",
  mobileBottom:
    "hidden max-mobile:fixed max-mobile:inset-x-0 max-mobile:bottom-0 max-mobile:z-30 max-mobile:block max-mobile:border-t max-mobile:border-border max-mobile:bg-surface max-mobile:shadow-[0_-6px_20px_rgba(15,30,45,0.08)] max-mobile:[padding-bottom:env(safe-area-inset-bottom,0px)]",
} as const;

function gridCellClass(activeTab: MobileTab, tab: MobileTab) {
  return `${classes.gridCell} ${activeTab === tab ? "" : classes.gridCellHidden}`;
}

export default function App() {
  const calculator = useCalculatorApp();
  const { actions } = calculator;
  const [mobileTab, setMobileTab] = useState<MobileTab>("input");

  const handleCalculate = async () => {
    await actions.calculate();
    setMobileTab("result");
  };

  const handleReset = () => {
    actions.reset();
    setMobileTab("input");
  };

  const handleConvert = () => {
    actions.applyConvert();
    setMobileTab("input");
  };

  const handleOutcome = async (outcome: "success" | "fail") => {
    await actions.applyOutcome(outcome);
    setMobileTab(outcome === "success" ? "input" : "result");
  };

  const hasResult = calculator.resultView.type !== "empty";

  return (
    <>
      <main className={classes.shell} data-mobile-tab={mobileTab}>
        <TopBar themeMode={calculator.themeMode} onThemeModeChange={actions.setThemeMode} />
        <div className={classes.mobileHeader}>
          <MobileStatusStrip
            feedback={calculator.stateFeedback}
            state={calculator.statePanel}
            stock={calculator.stockPanel.stock}
          />
        </div>
        <section className={classes.workspace}>
          <div className={gridCellClass(mobileTab, "input")} data-tab="input">
            <StatePanel
              feedback={calculator.stateFeedback}
              state={calculator.statePanel}
              onGradeChange={actions.setGrade}
              onLevelChange={actions.setLevel}
              onExpChange={actions.setExp}
            />
          </div>
          <div className={gridCellClass(mobileTab, "input")} data-tab="input">
            <StockPanel
              stock={calculator.stockPanel.stock}
              needsStockEdit={calculator.stockPanel.needsStockEdit}
              notice={calculator.stockPanel.notice}
              onStockChange={actions.setStock}
            />
          </div>
          <div className={gridCellClass(mobileTab, "input")} data-tab="input">
            <SolvePanel
              description={calculator.solvePanel.description}
              calculateDisabled={calculator.solvePanel.calculateDisabled}
              onCalculate={handleCalculate}
              onReset={handleReset}
            />
          </div>
          <div className={gridCellClass(mobileTab, "result")} data-tab="result">
            <ResultPanel
              view={calculator.resultView}
              onConvert={handleConvert}
              onOutcome={handleOutcome}
            />
          </div>
          <div className={gridCellClass(mobileTab, "result")} data-tab="result">
            <DetailPanel
              view={calculator.detailView}
              validation={calculator.validationView}
              onRunValidation={actions.runMonteCarloValidation}
            />
          </div>
          <div className={gridCellClass(mobileTab, "stats")} data-tab="stats">
            <StatsPanel view={calculator.statsView} />
            <PrivacyFooter placement="mobileStats" />
          </div>
        </section>
      </main>
      <div className={classes.mobileBottom}>
        <MobileActionBar
          view={calculator.resultView}
          loading={calculator.loading}
          calculateDisabled={calculator.solvePanel.calculateDisabled}
          needsStockEdit={calculator.stockPanel.needsStockEdit}
          onCalculate={handleCalculate}
          onReset={handleReset}
          onConvert={handleConvert}
          onOutcome={handleOutcome}
        />
        <MobileTabs active={mobileTab} hasResult={hasResult} onChange={setMobileTab} />
      </div>
      <PrivacyFooter />
      <SuccessAttemptModal
        modal={calculator.modal}
        onAttemptChange={actions.setModalAttempt}
        onSubmit={actions.submitSuccessAttempt}
      />
      <LoadingOverlay loading={calculator.loading} />
    </>
  );
}
