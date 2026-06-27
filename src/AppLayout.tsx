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
import type { useCalculatorApp } from "./hooks/useCalculatorApp";
import type { StatsRuntimeMode } from "./lib/statsRuntime";

const classes = {
  shell:
    "app-shell mx-auto w-[min(1320px,calc(100%_-_32px))] py-7 pb-[42px] max-mobile:w-[min(100%_-_20px,1320px)] max-mobile:py-2.5 max-mobile:pb-3.5",
  stagingBanner:
    "mb-3 rounded-card border border-warning bg-warning-soft px-3.5 py-2.5 text-[13px] font-semibold leading-[1.4] text-warning max-mobile:mb-2.5 max-mobile:px-3 max-mobile:py-2 max-mobile:text-xs",
  stagingErrorBanner: "border-danger bg-danger-soft text-danger",
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

type CalculatorApp = ReturnType<typeof useCalculatorApp>;

export type AppHandlers = {
  onCalculate: () => Promise<void>;
  onReset: () => void;
  onConvert: () => void;
  onOutcome: (outcome: "success" | "fail") => Promise<void>;
};

function StagingBanners({ statsMode }: { statsMode: StatsRuntimeMode }) {
  if (statsMode === "staging-misconfigured") {
    return (
      <aside
        className={`${classes.stagingBanner} ${classes.stagingErrorBanner}`}
        aria-label="스테이징 환경"
        role="alert"
      >
        STAGING 설정 누락 - 통계 제출이 중지됨
      </aside>
    );
  }
  if (statsMode !== "staging") return null;

  return (
    <aside className={classes.stagingBanner} aria-label="스테이징 환경">
      STAGING - 테스트 기록은 운영 통계에 반영되지 않음
    </aside>
  );
}

function mobileActionMode(view: CalculatorApp["resultView"]) {
  if (view.type === "recommendation") return "outcome";
  if (
    view.type === "convertRecommendation" ||
    (view.type === "outcome" && view.showConvertRecommendation)
  ) {
    return "convert";
  }
  return "calculate";
}

function MobileHeader({ calculator }: { calculator: CalculatorApp }) {
  return (
    <div className={classes.mobileHeader}>
      <MobileStatusStrip
        feedback={calculator.stateFeedback}
        state={calculator.statePanel}
        stock={calculator.stockPanel.stock}
      />
    </div>
  );
}

function Workspace({
  calculator,
  handlers,
  mobileTab,
  showSolverBackend,
}: {
  calculator: CalculatorApp;
  handlers: AppHandlers;
  mobileTab: MobileTab;
  showSolverBackend: boolean;
}) {
  const { actions } = calculator;

  return (
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
          onCalculate={handlers.onCalculate}
          onReset={handlers.onReset}
        />
      </div>
      <div className={gridCellClass(mobileTab, "result")} data-tab="result">
        <ResultPanel
          view={calculator.resultView}
          onActionTransitionComplete={actions.clearActionTransition}
          onConvert={handlers.onConvert}
          onOutcome={handlers.onOutcome}
        />
      </div>
      <div className={gridCellClass(mobileTab, "result")} data-tab="result">
        <DetailPanel
          view={calculator.detailView}
          validation={calculator.validationView}
          onRunValidation={actions.runMonteCarloValidation}
          showSolverBackend={showSolverBackend}
        />
      </div>
      <div className={gridCellClass(mobileTab, "stats")} data-tab="stats">
        <StatsPanel view={calculator.statsView} />
        <PrivacyFooter placement="mobileStats" />
      </div>
    </section>
  );
}

function MobileBottomBar({
  calculator,
  hasResult,
  handlers,
  mobileTab,
  onTabChange,
}: {
  calculator: CalculatorApp;
  hasResult: boolean;
  handlers: AppHandlers;
  mobileTab: MobileTab;
  onTabChange: (tab: MobileTab) => void;
}) {
  return (
    <div className={classes.mobileBottom}>
      <MobileActionBar
        view={calculator.resultView}
        loading={calculator.loading}
        calculateDisabled={calculator.solvePanel.calculateDisabled}
        needsStockEdit={calculator.stockPanel.needsStockEdit}
        onCalculate={handlers.onCalculate}
        onReset={handlers.onReset}
        onConvert={handlers.onConvert}
        onOutcome={handlers.onOutcome}
      />
      <MobileTabs active={mobileTab} hasResult={hasResult} onChange={onTabChange} />
    </div>
  );
}

export function AppLayout({
  calculator,
  handlers,
  mobileTab,
  onTabChange,
  statsMode,
}: {
  calculator: CalculatorApp;
  handlers: AppHandlers;
  mobileTab: MobileTab;
  onTabChange: (tab: MobileTab) => void;
  statsMode: StatsRuntimeMode;
}) {
  const hasResult = calculator.resultView.type !== "empty";
  const actionMode = mobileActionMode(calculator.resultView);

  return (
    <>
      <main className={classes.shell} data-mobile-action={actionMode} data-mobile-tab={mobileTab}>
        <StagingBanners statsMode={statsMode} />
        <TopBar
          onReset={handlers.onReset}
          themeMode={calculator.themeMode}
          onThemeModeChange={calculator.actions.setThemeMode}
        />
        <MobileHeader calculator={calculator} />
        <Workspace
          calculator={calculator}
          handlers={handlers}
          mobileTab={mobileTab}
          showSolverBackend={statsMode === "staging"}
        />
      </main>
      <MobileBottomBar
        calculator={calculator}
        hasResult={hasResult}
        handlers={handlers}
        mobileTab={mobileTab}
        onTabChange={onTabChange}
      />
      <PrivacyFooter />
      <SuccessAttemptModal
        modal={calculator.modal}
        onAttemptChange={calculator.actions.setModalAttempt}
        onSubmit={calculator.actions.submitSuccessAttempt}
      />
      <LoadingOverlay loading={calculator.loading} />
    </>
  );
}
