import { type CSSProperties, useLayoutEffect, useRef, useState } from "react";

import DetailPanel from "./components/DetailPanel";
import {
  MobileActionBar,
  MobileStatusStrip,
  type MobileTab,
  MobileTabs,
} from "./components/MobileChrome";
import PrivacyFooter from "./components/PrivacyFooter";
import ResultPanel from "./components/ResultPanel";
import StatePanel from "./components/StatePanel";
import StatsPanel from "./components/StatsPanel";
import StockPanel from "./components/StockPanel";
import SuccessAttemptModal from "./components/SuccessAttemptModal";
import TopBar, { type TopViewTab } from "./components/TopBar";
import type { CalculatorAppModel } from "./hooks/calculatorAppModel";
import { useI18n } from "./i18n/locale";
import type { LocalizedMessage } from "./i18n/messages.ko";
import type { StatsRuntimeMode } from "./lib/statsRuntime";

const classes = {
  shell:
    "app-shell mx-auto flex min-h-dvh w-[min(1240px,calc(100%_-_32px))] flex-col py-7 pb-[42px] max-mobile:w-[min(100%_-_20px,1240px)] max-mobile:py-2.5 max-mobile:pb-3.5",
  content: "app-content flex min-h-0 flex-1 flex-col",
  stagingBanner:
    "mb-3 rounded-card border border-warning bg-warning-soft px-3.5 py-2.5 text-[13px] font-semibold leading-[1.4] text-warning max-mobile:mb-2.5 max-mobile:px-3 max-mobile:py-2 max-mobile:text-xs",
  stagingErrorBanner: "border-danger bg-danger-soft text-danger",
  mobileHeader:
    "hidden max-mobile:sticky max-mobile:top-0 max-mobile:z-20 max-mobile:mx-[-10px] max-mobile:mb-3 max-mobile:block max-mobile:bg-page max-mobile:px-2.5 max-mobile:shadow-[0_1px_0_var(--line)]",
  workspace:
    "grid grid-cols-[430px_minmax(0,1fr)] items-start gap-4 min-[661px]:max-tablet:grid-cols-2 max-mobile:grid-cols-1 max-mobile:gap-2.5",
  inputColumn:
    "input-column grid min-w-0 content-start gap-4 min-[981px]:sticky min-[981px]:top-7 min-[661px]:max-tablet:col-span-full min-[661px]:max-tablet:grid-cols-[minmax(0,1fr)_minmax(286px,34%)] min-[661px]:max-tablet:items-stretch max-mobile:gap-2.5",
  resultColumn:
    "result-column grid min-w-0 content-start gap-4 min-[661px]:max-tablet:col-span-full max-mobile:gap-2.5",
  statsColumn:
    "stats-column-layout min-w-0 min-[661px]:col-span-full max-mobile:grid max-mobile:gap-2.5",
  gridCellHidden: "max-mobile:hidden",
  mobileBottom:
    "mobile-bottom-bar hidden max-mobile:fixed max-mobile:inset-x-0 max-mobile:bottom-0 max-mobile:z-30 max-mobile:block max-mobile:border-t max-mobile:border-border max-mobile:bg-surface max-mobile:shadow-[0_-6px_20px_rgba(15,30,45,0.08)] max-mobile:[padding-bottom:env(safe-area-inset-bottom,0px)]",
  resetToast:
    "fixed bottom-5 left-1/2 z-40 flex -translate-x-1/2 items-center gap-3 rounded-pill bg-action px-4 py-2.5 text-[13px] font-semibold text-ice shadow-[0_14px_32px_rgba(10,18,30,0.35)] max-mobile:bottom-[calc(64px+env(safe-area-inset-bottom,0px))] max-mobile:max-w-[calc(100%-24px)] max-mobile:text-[12.5px]",
  resetToastButton:
    "inline-flex min-h-[30px] items-center justify-center rounded-pill border-0 bg-[rgba(248,252,254,0.14)] px-3 text-[12.5px] font-bold leading-none text-ice",
  loadingOverlay:
    "fixed inset-0 z-50 grid place-items-center bg-[var(--overlay-bg)] px-4 backdrop-blur-[1px]",
  loadingPopup:
    "grid w-[min(340px,calc(100vw-32px))] justify-items-center gap-3 rounded-card border border-border bg-surface-raised px-5 py-4 text-center shadow-panel",
  loadingSpinner: "size-8 animate-spin rounded-full border-4 border-primary-soft border-t-primary",
  loadingTitle: "text-[15px] font-extrabold leading-tight text-text-strong",
  loadingText: "m-0 text-[13px] font-semibold leading-[1.45] text-text-soft",
} as const;

const MOBILE_PANEL_IDS: Record<MobileTab, string> = {
  input: "mobile-panel-input",
  result: "mobile-panel-result",
  stats: "mobile-panel-stats",
};

function tabPanelClass(activeTab: MobileTab, tab: MobileTab) {
  return activeTab === tab ? "" : classes.gridCellHidden;
}

function tabPanelProps(tab: MobileTab) {
  return {
    "aria-labelledby": `mobile-tab-${tab}`,
    "data-tab": tab,
    id: MOBILE_PANEL_IDS[tab],
    role: "tabpanel",
  } as const;
}

type CalculatorApp = CalculatorAppModel;

type ResetToastView = {
  secondsLeft: number;
  onUndo: () => void;
};

export type AppHandlers = {
  onCalculate: () => Promise<void>;
  onReset: () => void;
  onConvert: () => Promise<void>;
  onOutcome: (outcome: "success" | "fail") => Promise<void>;
};

function StagingBanners({ statsMode }: { statsMode: StatsRuntimeMode }) {
  const { t } = useI18n();
  if (statsMode === "staging-misconfigured") {
    return (
      <aside
        className={`${classes.stagingBanner} ${classes.stagingErrorBanner}`}
        aria-label={t("staging.label")}
        role="alert"
      >
        {t("staging.missing")}
      </aside>
    );
  }
  if (statsMode !== "staging") return null;

  return (
    <aside className={classes.stagingBanner} aria-label={t("staging.label")}>
      {t("staging.notice")}
    </aside>
  );
}

function MobileHeader({ calculator }: { calculator: CalculatorApp }) {
  return (
    <div className={classes.mobileHeader}>
      <MobileStatusStrip feedback={calculator.stateFeedback} state={calculator.statePanel} />
    </div>
  );
}

function ResetToast({ toast }: { toast: ResetToastView | null }) {
  const { t } = useI18n();
  if (!toast) return null;
  return (
    <div className={classes.resetToast} role="status" aria-live="polite">
      <span>{t("reset.done")}</span>
      <button className={classes.resetToastButton} type="button" onClick={toast.onUndo}>
        {t("reset.undo", { seconds: toast.secondsLeft })}
      </button>
    </div>
  );
}

function LoadingPopup({ text: loadingMessage }: { text: LocalizedMessage }) {
  const { t, text } = useI18n();
  return (
    <div
      className={classes.loadingOverlay}
      role="status"
      aria-live="polite"
      aria-atomic="true"
      aria-busy="true"
    >
      <div className={classes.loadingPopup}>
        <span className={classes.loadingSpinner} aria-hidden="true" />
        <strong className={classes.loadingTitle}>{t("common.loadingTitle")}</strong>
        <p className={classes.loadingText}>{text(loadingMessage)}</p>
      </div>
    </div>
  );
}

function Workspace({
  calculator,
  handlers,
  mobileTab,
  onPendingOutcomeChange,
  pendingOutcome,
  showSolverBackend,
  viewTab,
}: {
  calculator: CalculatorApp;
  handlers: AppHandlers;
  mobileTab: MobileTab;
  pendingOutcome: "success" | "fail" | null;
  showSolverBackend: boolean;
  viewTab: TopViewTab;
  onPendingOutcomeChange: (outcome: "success" | "fail" | null) => void;
}) {
  const { actions } = calculator;
  const calcDesktopVisibility = viewTab === "stats" ? "min-[661px]:hidden" : "";
  const statsDesktopVisibility = viewTab === "stats" ? "" : "min-[661px]:hidden";
  const renderStatsContent = viewTab === "stats" || mobileTab === "stats";

  return (
    <section id="calculatorWorkspace" className={classes.workspace}>
      <div
        className={`${classes.inputColumn} ${calcDesktopVisibility} ${tabPanelClass(mobileTab, "input")}`}
        {...tabPanelProps("input")}
      >
        <StatePanel
          state={calculator.statePanel}
          onGradeChange={actions.setGrade}
          onLevelChange={actions.setLevel}
          onExpChange={actions.setExp}
        />
        <StockPanel
          stock={calculator.stockPanel.stock}
          needsStockEdit={calculator.stockPanel.needsStockEdit}
          isStale={calculator.stockPanel.isStale}
          stockStale={calculator.stockPanel.stockStale}
          notice={calculator.stockPanel.notice}
          onStockChange={actions.setStock}
          description={calculator.solvePanel.description}
          calculateDisabled={calculator.solvePanel.calculateDisabled}
          loading={calculator.loading.active}
          onCalculate={handlers.onCalculate}
          onReset={handlers.onReset}
        />
      </div>
      <div
        className={`${classes.resultColumn} ${calcDesktopVisibility} ${tabPanelClass(mobileTab, "result")}`}
        {...tabPanelProps("result")}
      >
        <ResultPanel
          feedback={calculator.stateFeedback}
          needsStockEdit={calculator.stockPanel.needsStockEdit}
          isStale={calculator.stockPanel.isStale}
          staleSource={calculator.stockPanel.staleSource}
          stockEditNotice={calculator.stockPanel.notice}
          state={calculator.statePanel}
          view={calculator.resultView}
          outcomeDisabled={calculator.loading.active}
          pendingOutcome={pendingOutcome}
          onActionTransitionComplete={actions.clearActionTransition}
          onConvert={handlers.onConvert}
          onOutcome={handlers.onOutcome}
          onPendingOutcomeChange={onPendingOutcomeChange}
        />
        <DetailPanel
          view={calculator.detailView}
          validation={calculator.validationView}
          onRunValidation={actions.runMonteCarloValidation}
          showSolverBackend={showSolverBackend}
        />
      </div>
      <div
        className={`${classes.statsColumn} ${statsDesktopVisibility} ${tabPanelClass(mobileTab, "stats")}`}
        {...tabPanelProps("stats")}
      >
        <StatsPanel renderContent={renderStatsContent} view={calculator.statsView} />
      </div>
    </section>
  );
}

function MobileBottomBar({
  calculator,
  hasResult,
  handlers,
  mobileTab,
  pendingOutcome,
  onTabChange,
  onPendingOutcomeChange,
  onHeightChange,
}: {
  calculator: CalculatorApp;
  hasResult: boolean;
  handlers: AppHandlers;
  mobileTab: MobileTab;
  pendingOutcome: "success" | "fail" | null;
  onTabChange: (tab: MobileTab) => void;
  onPendingOutcomeChange: (outcome: "success" | "fail" | null) => void;
  onHeightChange: (height: number) => void;
}) {
  const bottomBarRef = useRef<HTMLDivElement>(null);

  useLayoutEffect(() => {
    const bottomBar = bottomBarRef.current;
    if (!bottomBar) return undefined;
    const updateHeight = () => {
      const hasActionBar = Boolean(bottomBar.querySelector(".mobile-action-bar"));
      if (hasActionBar !== (mobileTab !== "stats")) return;
      onHeightChange(Math.ceil(bottomBar.getBoundingClientRect().height));
    };
    updateHeight();
    const observer = new ResizeObserver(updateHeight);
    observer.observe(bottomBar);
    return () => observer.disconnect();
  }, [mobileTab, onHeightChange]);

  return (
    <div className={classes.mobileBottom} ref={bottomBarRef}>
      {mobileTab === "stats" ? null : (
        <MobileActionBar
          view={calculator.resultView}
          loading={calculator.loading}
          calculateDisabled={calculator.solvePanel.calculateDisabled}
          isStale={calculator.stockPanel.isStale}
          needsStockEdit={calculator.stockPanel.needsStockEdit}
          onCalculate={handlers.onCalculate}
          onReset={handlers.onReset}
          onConvert={handlers.onConvert}
          onOutcome={handlers.onOutcome}
          pendingOutcome={pendingOutcome}
          onPendingOutcomeChange={onPendingOutcomeChange}
        />
      )}
      <MobileTabs
        active={mobileTab}
        hasResult={hasResult}
        needsStockEdit={calculator.stockPanel.needsStockEdit}
        onChange={onTabChange}
      />
    </div>
  );
}

export function AppLayout({
  calculator,
  handlers,
  mobileTab,
  pendingOutcome,
  onTabChange,
  onPendingOutcomeChange,
  onViewTabChange,
  resetToast,
  statsMode,
  viewTab,
}: {
  calculator: CalculatorApp;
  handlers: AppHandlers;
  mobileTab: MobileTab;
  pendingOutcome: "success" | "fail" | null;
  onTabChange: (tab: MobileTab) => void;
  onPendingOutcomeChange: (outcome: "success" | "fail" | null) => void;
  onViewTabChange: (viewTab: TopViewTab) => void;
  resetToast: ResetToastView | null;
  statsMode: StatsRuntimeMode;
  viewTab: TopViewTab;
}) {
  const [mobileBottomHeight, setMobileBottomHeight] = useState(116);
  const hasResult = calculator.resultView.type !== "empty";

  return (
    <>
      <div
        className={classes.shell}
        data-mobile-tab={mobileTab}
        style={{ "--mobile-bottom-height": `${mobileBottomHeight}px` } as CSSProperties}
      >
        <main className={classes.content}>
          <StagingBanners statsMode={statsMode} />
          <TopBar
            themeMode={calculator.themeMode}
            viewTab={viewTab}
            onThemeModeChange={calculator.actions.setThemeMode}
            onViewTabChange={onViewTabChange}
          />
          <MobileHeader calculator={calculator} />
          <Workspace
            calculator={calculator}
            handlers={handlers}
            mobileTab={mobileTab}
            pendingOutcome={pendingOutcome}
            onPendingOutcomeChange={onPendingOutcomeChange}
            showSolverBackend={statsMode === "staging"}
            viewTab={viewTab}
          />
        </main>
        <PrivacyFooter />
      </div>
      <MobileBottomBar
        calculator={calculator}
        hasResult={hasResult}
        handlers={handlers}
        mobileTab={mobileTab}
        pendingOutcome={pendingOutcome}
        onTabChange={onTabChange}
        onPendingOutcomeChange={onPendingOutcomeChange}
        onHeightChange={setMobileBottomHeight}
      />
      <ResetToast toast={resetToast} />
      {calculator.loading.active ? <LoadingPopup text={calculator.loading.text} /> : null}
      <SuccessAttemptModal
        modal={calculator.modal}
        onSubmit={calculator.actions.submitSuccessAttempt}
      />
    </>
  );
}
