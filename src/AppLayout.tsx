import {
  type ComponentProps,
  type CSSProperties,
  lazy,
  type ReactNode,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { LazySectionErrorBoundary } from "./components/LazySectionErrorBoundary";
import LazySuccessAttemptModal from "./components/LazySuccessAttemptModal";
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
import TopBar, { type TopViewTab } from "./components/TopBar";
import type { CalculatorAppModel } from "./hooks/calculatorAppModel";
import { useMobileLayout } from "./hooks/useMobileLayout";
import { useI18n } from "./i18n/locale";
import type { StatsRuntimeMode } from "./lib/statsRuntime";
import { formatStagingForecastKstWindow } from "./lib/supplyForecastPresentation";
import { resolveRuntimeSupplyForecast } from "./lib/supplyForecastRuntime";
import type {
  StateChangeFeedback,
  StatePanelModel,
  StatsView,
  SuccessAttemptModalState,
  ThemeMode,
} from "./ui-types";

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
  stagingForecast: "mt-1 grid gap-0.5 font-medium text-text-soft",
  stagingForecastPeriod: "font-semibold text-text",
  stagingForecastGain: "block",
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

/** Shared input column: every engine renders the same state and stock panels. */
type AppShellInputPanels = {
  state: ComponentProps<typeof StatePanel>;
  stock: ComponentProps<typeof StockPanel>;
  /** Engine-specific inputs rendered below the shared panels. */
  extra?: ReactNode;
};

type AppShellStats = {
  view: StatsView;
  onRetry: () => void;
};

export type AppHandlers = {
  onCalculate: () => Promise<void>;
  onReset: () => void;
  onConvert: () => Promise<void>;
  onOutcome: (outcome: "success" | "fail") => Promise<void>;
};

function stagingForecastWindowText(
  forecastWindow: ReturnType<typeof formatStagingForecastKstWindow> | null,
  scheduleStatus: string,
  t: ReturnType<typeof useI18n>["t"],
) {
  if (forecastWindow?.until) {
    return t("staging.forecastWindow", {
      from: forecastWindow.from,
      until: forecastWindow.until,
      status: scheduleStatus,
    });
  }
  return t("staging.forecastWindowOpenEnded", {
    from: forecastWindow?.from ?? "-",
    status: scheduleStatus,
  });
}

function StagingBanners({ statsMode }: { statsMode: StatsRuntimeMode }) {
  const { formatNumber, locale, t } = useI18n();
  const [forecastTimestamp, setForecastTimestamp] = useState(Date.now);
  const runtimeForecast = resolveRuntimeSupplyForecast(forecastTimestamp);
  const isStagingForecast = runtimeForecast.environment === "staging";
  const profileUntil = runtimeForecast.profile.effectiveUntil;
  useEffect(() => {
    if (!isStagingForecast || profileUntil === null) return;
    const boundaryMs = Date.parse(profileUntil);
    if (!Number.isFinite(boundaryMs)) return;
    const delayMs = Math.min(Math.max(boundaryMs - Date.now() + 250, 0), 2_147_483_647);
    const timer = window.setTimeout(() => setForecastTimestamp(Date.now()), delayMs);
    return () => window.clearTimeout(timer);
  }, [isStagingForecast, profileUntil]);

  const forecastWindow = isStagingForecast
    ? formatStagingForecastKstWindow(runtimeForecast.profile, locale)
    : null;
  const scheduleStatusKey =
    runtimeForecast.profile.scheduleStatus === "confirmed"
      ? "staging.forecastStatusConfirmed"
      : "staging.forecastStatusEstimated";
  const scheduleStatus = isStagingForecast ? t(scheduleStatusKey) : "";
  const forecastDetails = isStagingForecast ? (
    <span
      className={classes.stagingForecast}
      data-testid="staging-forecast-details"
      data-forecast-profile-id={runtimeForecast.profile.id}
      title={t("staging.forecastAudit", {
        forecastId: runtimeForecast.forecastId,
        profileId: runtimeForecast.profile.id,
      })}
    >
      <span className={classes.stagingForecastPeriod}>
        {stagingForecastWindowText(forecastWindow, scheduleStatus, t)}
      </span>
      <span className={classes.stagingForecastGain}>
        {t("staging.forecastGain", {
          blue: formatNumber(runtimeForecast.profile.expectedGain.blue, 2),
          purple: formatNumber(runtimeForecast.profile.expectedGain.purple, 2),
          yellow: formatNumber(runtimeForecast.profile.expectedGain.yellow, 2),
        })}
      </span>
    </span>
  ) : null;
  if (statsMode === "staging-misconfigured") {
    return (
      <aside
        className={`${classes.stagingBanner} ${classes.stagingErrorBanner}`}
        data-forecast-id={isStagingForecast ? runtimeForecast.forecastId : undefined}
        aria-label={t("staging.label")}
        role="alert"
      >
        {t("staging.missing")}
        {forecastDetails}
      </aside>
    );
  }
  if (statsMode !== "staging") return null;

  return (
    <aside
      className={classes.stagingBanner}
      data-forecast-id={isStagingForecast ? runtimeForecast.forecastId : undefined}
      aria-label={t("staging.label")}
    >
      {t("staging.notice")}
      {forecastDetails}
    </aside>
  );
}

function MobileHeader({
  feedback,
  state,
}: {
  feedback: StateChangeFeedback | null;
  state: StatePanelModel;
}) {
  return (
    <div className={classes.mobileHeader}>
      <MobileStatusStrip feedback={feedback} state={state} />
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
  inputPanels,
  mobileTab,
  onWorkspaceInteraction,
  result,
  stats,
  viewTab,
}: {
  inputPanels: AppShellInputPanels;
  mobileTab: MobileTab;
  onWorkspaceInteraction: (() => void) | undefined;
  result: ReactNode;
  stats: AppShellStats;
  viewTab: TopViewTab;
}) {
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
        onFocusCapture={onWorkspaceInteraction}
        onPointerDownCapture={onWorkspaceInteraction}
        {...desktopCalculatorTabPanelProps}
      >
        <div
          className={`${classes.inputColumn} ${tabPanelClass(mobileTab, "input")}`}
          {...mobileTabPanelProps("input", isMobile)}
        >
          <StatePanel {...inputPanels.state} />
          <StockPanel {...inputPanels.stock} />
          {inputPanels.extra}
        </div>
        <div
          className={`${classes.resultColumn} ${tabPanelClass(mobileTab, "result")}`}
          {...mobileTabPanelProps("result", isMobile)}
        >
          {result}
        </div>
      </div>
      <div
        id="statsWorkspace"
        className={`${classes.statsColumn} ${statsDesktopVisibility} ${tabPanelClass(mobileTab, "stats")}`}
        role="tabpanel"
        aria-labelledby={isMobile ? "mobile-tab-stats" : "desktop-tab-stats"}
      >
        <StatsPanel onRetry={stats.onRetry} renderContent={renderStatsContent} view={stats.view} />
      </div>
    </section>
  );
}

function MobileBottomBar({
  actions,
  hasResult,
  mobileTab,
  needsStockEdit,
  onTabChange,
  onHeightChange,
}: {
  actions: ReactNode;
  hasResult: boolean;
  mobileTab: MobileTab;
  needsStockEdit: boolean;
  onTabChange: (tab: MobileTab) => void;
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
      {mobileTab === "stats" ? null : actions}
      <MobileTabs
        active={mobileTab}
        hasResult={hasResult}
        needsStockEdit={needsStockEdit}
        onChange={onTabChange}
      />
    </div>
  );
}

type AppShellProps = {
  /** Route notices rendered above the shared top bar. */
  banner: ReactNode;
  /** Marks the engine profile that owns the calculation; omitted for the legacy engine. */
  engineProfile?: string;
  hasResult: boolean;
  inputPanels: AppShellInputPanels;
  /** Mobile action toolbar; must render an element with the `mobile-action-bar` class. */
  mobileActions: ReactNode;
  mobileTab: MobileTab;
  modal: SuccessAttemptModalState;
  onSubmitSuccessAttempt: (successAttempt: number | null) => void;
  onTabChange: (tab: MobileTab) => void;
  onThemeModeChange: (themeMode: ThemeMode) => void;
  onViewTabChange: (viewTab: TopViewTab) => void;
  onWorkspaceInteraction?: () => void;
  resetToast: ResetToastView | null;
  result: ReactNode;
  stateFeedback: StateChangeFeedback | null;
  stats: AppShellStats;
  themeMode: ThemeMode;
  viewTab: TopViewTab;
};

/** Engine-neutral calculator frame: top bar, panels, navigation, footer, reset undo and modal. */
export function AppShell({
  banner,
  engineProfile,
  hasResult,
  inputPanels,
  mobileActions,
  mobileTab,
  modal,
  onSubmitSuccessAttempt,
  onTabChange,
  onThemeModeChange,
  onViewTabChange,
  onWorkspaceInteraction,
  resetToast,
  result,
  stateFeedback,
  stats,
  themeMode,
  viewTab,
}: AppShellProps) {
  const [mobileBottomHeight, setMobileBottomHeight] = useState(116);

  return (
    <>
      <div
        className={classes.shell}
        data-mobile-tab={mobileTab}
        style={{ "--mobile-bottom-height": `${mobileBottomHeight}px` } as CSSProperties}
      >
        <main className={classes.content} data-engine-profile={engineProfile}>
          {banner}
          <TopBar
            themeMode={themeMode}
            viewTab={viewTab}
            onThemeModeChange={onThemeModeChange}
            onViewTabChange={onViewTabChange}
          />
          <MobileHeader feedback={stateFeedback} state={inputPanels.state.state} />
          <Workspace
            inputPanels={inputPanels}
            mobileTab={mobileTab}
            onWorkspaceInteraction={onWorkspaceInteraction}
            result={result}
            stats={stats}
            viewTab={viewTab}
          />
        </main>
        <PrivacyFooter />
      </div>
      <MobileBottomBar
        actions={mobileActions}
        hasResult={hasResult}
        mobileTab={mobileTab}
        needsStockEdit={inputPanels.stock.needsStockEdit}
        onTabChange={onTabChange}
        onHeightChange={setMobileBottomHeight}
      />
      <ResetToast toast={resetToast} />
      <LazySuccessAttemptModal modal={modal} onSubmit={onSubmitSuccessAttempt} />
    </>
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
  const { actions } = calculator;

  return (
    <AppShell
      banner={<StagingBanners statsMode={statsMode} />}
      hasResult={calculator.resultView.type !== "empty"}
      inputPanels={{
        state: {
          disabled: calculator.inputLocked || calculator.stockPanel.needsStockEdit,
          state: calculator.statePanel,
          onGradeChange: actions.setGrade,
          onLevelChange: actions.setLevel,
          onExpChange: actions.setExp,
        },
        stock: {
          stock: calculator.stockPanel.stock,
          needsStockEdit: calculator.stockPanel.needsStockEdit,
          correction: calculator.stockPanel.correction,
          isStale: calculator.stockPanel.isStale,
          stockStale: calculator.stockPanel.stockStale,
          notice: calculator.stockPanel.notice,
          onStockChange: actions.setStock,
          description: calculator.solvePanel.description,
          calculateDisabled: calculator.solvePanel.calculateDisabled,
          loading: calculator.loading.active,
          disabled: calculator.inputLocked,
          onCalculate: handlers.onCalculate,
          onReset: handlers.onReset,
        },
      }}
      mobileActions={
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
      }
      mobileTab={mobileTab}
      modal={calculator.modal}
      onSubmitSuccessAttempt={actions.submitSuccessAttempt}
      onTabChange={onTabChange}
      onThemeModeChange={actions.setThemeMode}
      onViewTabChange={onViewTabChange}
      onWorkspaceInteraction={preloadDetailPanel}
      resetToast={resetToast}
      result={
        <>
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
          <DetailPanelRegion calculator={calculator} showSolverBackend={statsMode === "staging"} />
        </>
      }
      stateFeedback={calculator.stateFeedback}
      stats={{ view: calculator.statsView, onRetry: actions.retryStats }}
      themeMode={calculator.themeMode}
      viewTab={viewTab}
    />
  );
}
