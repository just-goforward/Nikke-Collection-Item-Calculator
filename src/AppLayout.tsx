import {
  type CSSProperties,
  lazy,
  Suspense,
  useCallback,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { LazySectionErrorBoundary } from "./components/LazySectionErrorBoundary";
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
import { useMobileLayout } from "./hooks/useMobileLayout";
import { useI18n } from "./i18n/locale";
import type { StatsRuntimeMode } from "./lib/statsRuntime";

type DetailPanelModule = typeof import("./components/DetailPanel");

let detailPanelLoad: Promise<DetailPanelModule> | null = null;

function loadDetailPanel() {
  detailPanelLoad ??= import("./components/DetailPanel");
  return detailPanelLoad;
}

export function preloadDetailPanel() {
  void loadDetailPanel().catch(() => {
    detailPanelLoad = null;
  });
}

function createDetailPanel() {
  return lazy(loadDetailPanel);
}

const classes = {
  shell:
    "app-shell mx-auto flex min-h-dvh w-[min(1240px,calc(100%_-_32px))] flex-col py-7 pb-[42px] max-mobile:w-[min(100%_-_20px,1240px)] max-mobile:py-2.5 max-mobile:pb-3.5",
  content: "app-content flex min-h-0 flex-1 flex-col",
  stagingBanner:
    "mb-3 rounded-card border border-warning bg-warning-soft px-3.5 py-2.5 text-[13px] font-semibold leading-[1.4] text-warning max-mobile:mb-2.5 max-mobile:px-3 max-mobile:py-2 max-mobile:text-xs",
  stagingErrorBanner: "border-danger bg-danger-soft text-danger",
  mobileHeader:
    "hidden max-mobile:sticky max-mobile:top-0 max-mobile:z-20 max-mobile:mx-[-10px] max-mobile:mb-3 max-mobile:block max-mobile:bg-page max-mobile:px-2.5 max-mobile:shadow-[0_1px_0_var(--line)]",
  workspace: "min-w-0",
  calculatorWorkspace:
    "grid grid-cols-[430px_minmax(0,1fr)] items-start gap-4 min-[661px]:max-tablet:grid-cols-2 max-mobile:grid-cols-1 max-mobile:gap-2.5",
  inputColumn:
    "input-column grid min-w-0 content-start gap-4 min-[981px]:sticky min-[981px]:top-7 min-[661px]:max-tablet:col-span-full min-[661px]:max-tablet:grid-cols-[minmax(0,1fr)_max-content] min-[661px]:max-tablet:items-stretch max-mobile:gap-2.5",
  resultColumn:
    "result-column grid min-w-0 content-start gap-4 min-[661px]:max-tablet:col-span-full max-mobile:gap-2.5",
  detailFallback:
    "panel detail-panel relative col-span-full min-h-[210px] min-w-0 overflow-hidden rounded-card border border-border bg-surface shadow-panel [contain:layout] max-mobile:min-h-[170px]",
  detailFallbackHeading:
    "section-heading flex items-center border-b border-border px-[18px] py-4 max-mobile:px-3.5 max-mobile:py-[11px] max-mobile:[&_h2]:text-[16px]",
  detailFallbackBody:
    "grid min-h-[148px] place-items-center px-[18px] py-[22px] text-center text-[13px] font-semibold leading-[1.45] text-muted max-mobile:min-h-[116px] max-mobile:px-3.5 max-mobile:py-3",
  detailLoadingStack: "grid justify-items-center gap-2.5",
  detailLoadingSpinner:
    "size-7 animate-spin rounded-full border-[3px] border-primary-soft border-t-primary",
  detailRetryButton:
    "mt-3 inline-flex min-h-9 items-center justify-center rounded-control border border-border bg-button px-3.5 text-[12.5px] font-bold text-text-soft",
  statsColumn:
    "stats-column-layout min-w-0 min-[661px]:col-span-full max-mobile:grid max-mobile:gap-2.5",
  gridCellHidden: "max-mobile:hidden",
  mobileBottom:
    "mobile-bottom-bar hidden max-mobile:fixed max-mobile:inset-x-0 max-mobile:bottom-0 max-mobile:z-30 max-mobile:block max-mobile:border-t max-mobile:border-border max-mobile:bg-surface max-mobile:shadow-[0_-6px_20px_rgba(15,30,45,0.08)] max-mobile:[padding-bottom:env(safe-area-inset-bottom,0px)]",
  resetToast:
    "fixed bottom-5 left-1/2 z-40 flex -translate-x-1/2 items-center gap-3 rounded-pill bg-action px-4 py-2.5 text-[13px] font-semibold text-ice shadow-[0_14px_32px_rgba(10,18,30,0.35)] max-mobile:bottom-[calc(64px+env(safe-area-inset-bottom,0px))] max-mobile:max-w-[calc(100%-24px)] max-mobile:text-[12.5px]",
  resetToastButton:
    "inline-flex min-h-[30px] items-center justify-center rounded-pill border-0 bg-[rgba(248,252,254,0.14)] px-3 text-[12.5px] font-bold leading-none text-ice",
} as const;

const MOBILE_PANEL_IDS: Record<Exclude<MobileTab, "stats">, string> = {
  input: "mobile-panel-input",
  result: "mobile-panel-result",
};

function tabPanelClass(activeTab: MobileTab, tab: MobileTab) {
  return activeTab === tab ? "" : classes.gridCellHidden;
}

function mobileTabPanelProps(tab: Exclude<MobileTab, "stats">, isMobile: boolean) {
  return {
    "aria-labelledby": isMobile ? `mobile-tab-${tab}` : undefined,
    "data-tab": tab,
    id: MOBILE_PANEL_IDS[tab],
    role: isMobile ? ("tabpanel" as const) : undefined,
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
    <div className={classes.resetToast}>
      <span role="status" aria-live="polite" aria-atomic="true">
        {t("reset.done")}
      </span>
      <button
        aria-label={t("reset.undoAction")}
        className={classes.resetToastButton}
        type="button"
        onClick={toast.onUndo}
      >
        <span aria-hidden="true">{t("reset.undo", { seconds: toast.secondsLeft })}</span>
      </button>
    </div>
  );
}

function DetailPanelFallback() {
  const { t } = useI18n();
  return (
    <section
      className={classes.detailFallback}
      aria-busy="true"
      aria-labelledby="detail-loading-title"
    >
      <div className={classes.detailFallbackHeading}>
        <h2 id="detail-loading-title">{t("detail.title")}</h2>
      </div>
      <div className={classes.detailFallbackBody} role="status" aria-live="polite">
        <div className={classes.detailLoadingStack}>
          <span className={classes.detailLoadingSpinner} aria-hidden="true" />
          <span>{t("detail.preparing")}</span>
        </div>
      </div>
    </section>
  );
}

function DetailPanelFailure({ onRetry }: { onRetry: () => void }) {
  const { t } = useI18n();
  return (
    <section className={classes.detailFallback} role="alert" aria-labelledby="detail-error-title">
      <div className={classes.detailFallbackHeading}>
        <h2 id="detail-error-title">{t("detail.title")}</h2>
      </div>
      <div className={classes.detailFallbackBody}>
        <div>
          <p>{t("error.sectionDetail")}</p>
          <button className={classes.detailRetryButton} type="button" onClick={onRetry}>
            {t("error.retrySection")}
          </button>
        </div>
      </div>
    </section>
  );
}

function useRetryableDetailPanel() {
  const [component, setComponent] = useState(createDetailPanel);
  const retry = useCallback(() => {
    detailPanelLoad = null;
    setComponent(createDetailPanel());
  }, []);
  return { component, retry };
}

function DetailPanelRegion({
  calculator,
  showSolverBackend,
}: {
  calculator: CalculatorApp;
  showSolverBackend: boolean;
}) {
  const { actions, detailView } = calculator;
  const { component: DetailPanelComponent, retry: retryDetailPanel } = useRetryableDetailPanel();
  if (detailView.type === "empty") return null;
  if (detailView.type === "loading") return <DetailPanelFallback />;

  return (
    <LazySectionErrorBoundary
      name="DetailPanel"
      onRetry={retryDetailPanel}
      fallback={(retry) => <DetailPanelFailure onRetry={retry} />}
    >
      <Suspense fallback={<DetailPanelFallback />}>
        <DetailPanelComponent
          loading={calculator.resultView.type === "loading"}
          view={detailView}
          validation={calculator.validationView}
          onRunValidation={actions.runMonteCarloValidation}
          showSolverBackend={showSolverBackend}
        />
      </Suspense>
    </LazySectionErrorBoundary>
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
  const isMobile = useMobileLayout();
  const calcDesktopVisibility = viewTab === "stats" ? "min-[661px]:hidden" : "";
  const statsDesktopVisibility = viewTab === "stats" ? "" : "min-[661px]:hidden";
  const calcMobileVisibility = mobileTab === "stats" ? classes.gridCellHidden : "";
  const renderStatsContent = viewTab === "stats" || mobileTab === "stats";
  const desktopCalculatorTabPanelProps = isMobile
    ? {}
    : { "aria-labelledby": "desktop-tab-calc", role: "tabpanel" as const };

  return (
    <section className={classes.workspace}>
      <div
        id="calculatorWorkspace"
        className={`${classes.calculatorWorkspace} ${calcDesktopVisibility} ${calcMobileVisibility}`}
        onFocusCapture={preloadDetailPanel}
        onPointerDownCapture={preloadDetailPanel}
        {...desktopCalculatorTabPanelProps}
      >
        <div
          className={`${classes.inputColumn} ${tabPanelClass(mobileTab, "input")}`}
          {...mobileTabPanelProps("input", isMobile)}
        >
          <StatePanel
            disabled={calculator.inputLocked || calculator.stockPanel.needsStockEdit}
            state={calculator.statePanel}
            onGradeChange={actions.setGrade}
            onLevelChange={actions.setLevel}
            onExpChange={actions.setExp}
          />
          <StockPanel
            stock={calculator.stockPanel.stock}
            needsStockEdit={calculator.stockPanel.needsStockEdit}
            correction={calculator.stockPanel.correction}
            isStale={calculator.stockPanel.isStale}
            stockStale={calculator.stockPanel.stockStale}
            notice={calculator.stockPanel.notice}
            onStockChange={actions.setStock}
            description={calculator.solvePanel.description}
            calculateDisabled={calculator.solvePanel.calculateDisabled}
            loading={calculator.loading.active}
            disabled={calculator.inputLocked}
            onCalculate={handlers.onCalculate}
            onReset={handlers.onReset}
          />
        </div>
        <div
          className={`${classes.resultColumn} ${tabPanelClass(mobileTab, "result")}`}
          {...mobileTabPanelProps("result", isMobile)}
        >
          <ResultPanel
            feedback={calculator.stateFeedback}
            needsStockEdit={calculator.stockPanel.needsStockEdit}
            isStale={calculator.stockPanel.isStale}
            staleSource={calculator.stockPanel.staleSource}
            stockEditNotice={calculator.stockPanel.notice}
            state={calculator.statePanel}
            view={calculator.resultView}
            loading={calculator.loading}
            outcomeDisabled={calculator.loading.active}
            pendingOutcome={pendingOutcome}
            onActionTransitionComplete={actions.clearActionTransition}
            onConvert={handlers.onConvert}
            onOutcome={handlers.onOutcome}
            onRetryCalculation={handlers.onCalculate}
            onPendingOutcomeChange={onPendingOutcomeChange}
          />
          <DetailPanelRegion calculator={calculator} showSolverBackend={showSolverBackend} />
        </div>
      </div>
      <div
        id="statsWorkspace"
        className={`${classes.statsColumn} ${statsDesktopVisibility} ${tabPanelClass(mobileTab, "stats")}`}
        role="tabpanel"
        aria-labelledby={isMobile ? "mobile-tab-stats" : "desktop-tab-stats"}
      >
        <StatsPanel
          onRetry={actions.retryStats}
          renderContent={renderStatsContent}
          view={calculator.statsView}
        />
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
          correction={calculator.stockPanel.correction}
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
      <SuccessAttemptModal
        modal={calculator.modal}
        onSubmit={calculator.actions.submitSuccessAttempt}
      />
    </>
  );
}
