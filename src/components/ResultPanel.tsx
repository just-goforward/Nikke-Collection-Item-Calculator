import { lazy, Suspense, useCallback, useState } from "react";

import { useAnimatedStateProgress } from "../hooks/useAnimatedStateProgress";
import { useI18n } from "../i18n/locale";
import type { LocalizedMessage, MessageKey } from "../i18n/messages.ko";
import { lazyModuleRetryUrl, reloadWithLegacyInputs } from "../lib/lazyModuleRetry";
import type { LegacyRecoveryNotice } from "../lib/legacyInputRecovery";
import type { CollectionState, Kit } from "../types";
import type {
  LoadingView,
  ResultKit,
  ResultView,
  StateChangeFeedback,
  StatePanelModel,
} from "../ui-types";
import { AlignedText } from "./AlignedText";
import { LazySectionErrorBoundary } from "./LazySectionErrorBoundary";
import type { RecommendationProps } from "./RecommendationContent";
import { stateFeedbackAnimations } from "./stateFeedbackAnimations";

const RESULT_KIT_KEYS: Record<ResultKit, MessageKey> = {
  blue: "kit.blue",
  purple: "kit.purple",
  yellow: "kit.yellow",
  convert: "common.convertToSr",
};

const classes = {
  panel:
    "panel result-panel relative min-w-0 rounded-card border border-border bg-surface shadow-panel [contain:layout_paint] transition-[background-color,border-color,box-shadow] duration-[220ms]",
  staleOverlay:
    "pointer-events-auto absolute inset-0 z-[4] grid place-items-center rounded-b-card bg-[rgba(255,255,255,0.56)] p-4 backdrop-blur-[1px] [body.theme-dark_&]:bg-[rgba(10,12,14,0.62)]",
  staleNotice:
    "rounded-card border-2 border-yellow-kit bg-outcome px-3.5 py-3 text-center text-[13px] font-semibold leading-[1.45] text-outcome-text shadow-[0_12px_26px_rgba(128,89,11,0.12)] max-mobile:max-w-[min(280px,92%)] max-mobile:px-3 max-mobile:py-2.5 max-mobile:text-[12px]",
  heading:
    "section-heading flex items-center justify-between gap-3 border-b border-border px-[18px] py-4 transition-[border-color,background-color,color] duration-[220ms] max-mobile:px-3.5 max-mobile:py-[11px] max-mobile:[&_h2]:text-[16px]",
  emptyResult: "empty-result",
  emptyGuide:
    "grid gap-3 p-[18px] text-[13px] font-semibold leading-[1.45] text-muted max-mobile:px-3.5 max-mobile:py-3",
  emptyLead: "m-0 text-text-soft",
  emptySteps: "m-0 grid list-none grid-cols-1 gap-2 p-0 max-mobile:gap-1.5",
  emptyStep:
    "grid grid-cols-[24px_minmax(0,1fr)] items-center gap-2 rounded-control border border-border bg-surface-strong px-3 py-2",
  emptyStepNumber:
    "grid size-6 place-items-center rounded-full bg-theme-active text-[11px] font-extrabold text-page",
  emptyStepText: "flex min-h-6 items-center leading-[1.35]",
  loadingResult:
    "grid min-h-[210px] place-items-center px-[18px] py-[22px] text-center max-mobile:min-h-[170px] max-mobile:px-3.5 max-mobile:py-3",
  loadingStack: "grid max-w-[320px] justify-items-center gap-2.5",
  loadingSpinner:
    "size-7 animate-spin rounded-full border-[3px] border-primary-soft border-t-primary",
  loadingTitle: "text-[14px] font-bold leading-tight text-text-strong",
  loadingText: "m-0 text-[12.5px] font-semibold leading-[1.45] text-muted",
  resultContent:
    "result-content grid gap-3 p-[18px] max-mobile:gap-2.5 max-mobile:px-3.5 max-mobile:py-3",
  resultBody: "relative min-h-0 overflow-hidden rounded-b-card",
  stateStrip: "current-state-strip ml-auto flex min-w-0 items-center gap-[9px] max-mobile:hidden",
  stateStripFeedback: `border-grade-active shadow-[0_0_0_3px_var(--grade-active-soft)] ${stateFeedbackAnimations.panel}`,
  stateGrade:
    "grid size-6 shrink-0 place-items-center rounded-[6px] bg-[var(--control-active-bg)] text-[12px] font-extrabold leading-none text-[var(--control-active-ink)]",
  stateMain: "state-main relative grid min-w-[48px] gap-[3px]",
  stateLevel: "whitespace-nowrap text-[15px] font-extrabold leading-none text-text-strong",
  levelBurst:
    "pointer-events-none absolute bottom-[calc(100%+1px)] left-1/2 grid -translate-x-1/2 grid-cols-3 gap-px text-[9px] font-extrabold leading-none text-grade-active motion-reduce:hidden",
  levelBurstIcon: "animate-[level-burst_700ms_ease-out_2_both]",
  expGroup: "grid w-[150px] min-w-0 flex-none gap-[5px] min-[661px]:max-tablet:w-[140px]",
  expHeader: "flex items-center justify-between gap-3",
  expLabel: "text-[9.5px] font-extrabold leading-none text-muted",
  expValue: "whitespace-nowrap text-right text-[11px] font-bold leading-none text-text-strong",
  expTrack: "h-1.5 overflow-hidden rounded-pill bg-progress-track",
  expFill:
    "block h-full rounded-pill bg-blue-kit transition-[width] duration-[420ms] ease-[cubic-bezier(0.2,0.8,0.2,1)]",
  expFillNoTransition: "transition-none",
  callout:
    "callout rounded-card bg-primary-soft px-3.5 py-[13px] font-bold leading-[1.45] text-primary-strong",
  error: "error rounded-card bg-danger-soft px-3.5 py-[13px] font-bold leading-[1.45] text-danger",
  errorContent: "grid gap-3",
  retryButton:
    "inline-flex min-h-11 w-fit items-center justify-center rounded-control border-0 bg-action px-4 text-sm font-bold leading-none text-ice",
} as const;

type ResultPanelProps = {
  needsStockEdit: boolean;
  isStale: boolean;
  staleSource: "state" | "stock" | null;
  stockEditNotice: LocalizedMessage | LegacyRecoveryNotice;
  feedback: StateChangeFeedback | null;
  loading: LoadingView;
  state: StatePanelModel;
  view: ResultView;
  onActionTransitionComplete: (transitionId: number) => void;
  onConvert: () => void | Promise<void>;
  onOutcome: (outcome: "success" | "fail") => void;
  onRetryCalculation: () => void | Promise<void>;
  outcomeDisabled: boolean;
  pendingOutcome: "success" | "fail" | null;
  onPendingOutcomeChange: (outcome: "success" | "fail" | null) => void;
};

function CurrentStateStrip({
  feedback,
  state,
}: {
  feedback: StateChangeFeedback | null;
  state: StatePanelModel;
}) {
  const { formatInteger, t } = useI18n();
  const feedbackActive = feedback?.to.grade === state.grade && feedback.to.level === state.level;
  const animated = useAnimatedStateProgress(state, feedbackActive ? feedback : null);
  const displayState = animated.state;
  const progress = animated.progress;
  return (
    <div
      className={`${classes.stateStrip} ${feedbackActive ? classes.stateStripFeedback : ""}`}
      aria-live="polite"
    >
      <span className={classes.stateGrade}>{displayState.grade}</span>
      <span className={classes.stateMain}>
        {feedbackActive ? (
          <span className={classes.levelBurst} aria-hidden="true" key={feedback.id}>
            {[0, 1, 2].map((index) => (
              <span
                className={classes.levelBurstIcon}
                key={index}
                style={{ animationDelay: `${index * 140}ms` }}
              >
                ▲
              </span>
            ))}
          </span>
        ) : null}
        <strong className={classes.stateLevel}>
          <AlignedText alignmentRole="status">
            {t("common.phase", { phase: displayState.level })}
          </AlignedText>
        </strong>
      </span>
      <span className={classes.expGroup}>
        <span className={classes.expHeader}>
          <span className={classes.expLabel}>EXP</span>
          <span className={classes.expValue}>
            {displayState.expDisabled
              ? t("common.maxPhase")
              : `${formatInteger(displayState.exp)} / ${formatInteger(displayState.requiredExp)}`}
          </span>
        </span>
        <span className={classes.expTrack} aria-hidden="true">
          <span
            className={`${classes.expFill} ${animated.transition ? "" : classes.expFillNoTransition}`}
            style={{ width: `${progress}%` }}
          />
        </span>
      </span>
    </div>
  );
}

function EmptyResultGuide() {
  const { t } = useI18n();
  const steps = [
    t("result.emptyStepState"),
    t("result.emptyStepStock"),
    t("result.emptyStepCalculate"),
  ];
  return (
    <div className={classes.emptyGuide}>
      <p className={classes.emptyLead}>{t("result.emptyLead")}</p>
      <ol className={classes.emptySteps}>
        {steps.map((step, index) => (
          <li className={classes.emptyStep} key={step}>
            <span className={classes.emptyStepNumber}>{index + 1}</span>
            <span className={classes.emptyStepText}>{step}</span>
          </li>
        ))}
      </ol>
    </div>
  );
}

type RecommendationModule = typeof import("./RecommendationContent");
let recommendationLoad: Promise<RecommendationModule> | null = null;
let recommendationRetryUrl: string | null = null;
let recommendationRetryGeneration = 0;
function createRecommendation() {
  return lazy(() => {
    recommendationLoad ??= (
      recommendationRetryUrl
        ? (import(/* @vite-ignore */ recommendationRetryUrl) as Promise<RecommendationModule>)
        : import("./RecommendationContent")
    )
      .then((module) => {
        recommendationRetryUrl = null;
        recommendationRetryGeneration = 0;
        return module;
      })
      .catch((error: unknown) => {
        recommendationRetryUrl = lazyModuleRetryUrl(
          error,
          "RecommendationContent",
          location.origin,
          ++recommendationRetryGeneration,
        );
        throw error;
      });
    return recommendationLoad;
  });
}
function LazyRecommendation(props: RecommendationProps) {
  const { t } = useI18n();
  const [Recommendation, setRecommendation] = useState(createRecommendation);
  const [reloadFailed, setReloadFailed] = useState(false);
  const retry = useCallback(() => {
    recommendationLoad = null;
    setRecommendation(createRecommendation());
  }, []);
  const reload = () => {
    if (!reloadWithLegacyInputs()) setReloadFailed(true);
  };
  return (
    <LazySectionErrorBoundary
      name="RecommendationContent"
      onRetry={retry}
      fallback={(onRetry) => (
        <div className={classes.error} role="alert">
          <p>
            {t(
              reloadFailed
                ? "error.reloadInputsUnavailable"
                : recommendationRetryUrl
                  ? "error.sectionDetail"
                  : "error.reloadInputsDetail",
            )}
          </p>
          <button
            className={classes.retryButton}
            type="button"
            onClick={recommendationRetryUrl ? onRetry : reload}
          >
            {t(recommendationRetryUrl ? "error.retrySection" : "error.reload")}
          </button>
        </div>
      )}
    >
      <Suspense
        fallback={
          <div className={classes.loadingResult} role="status" aria-live="polite">
            {t("result.preparing")}
          </div>
        }
      >
        <Recommendation {...props} />
      </Suspense>
    </LazySectionErrorBoundary>
  );
}

function ResultViewContent({
  onActionTransitionComplete,
  onConvert,
  onOutcome,
  onPendingOutcomeChange,
  onRetryCalculation,
  outcomeDisabled,
  pendingOutcome,
  loading,
  view,
}: Pick<
  ResultPanelProps,
  | "onActionTransitionComplete"
  | "onConvert"
  | "onOutcome"
  | "onPendingOutcomeChange"
  | "onRetryCalculation"
  | "outcomeDisabled"
  | "pendingOutcome"
  | "loading"
  | "view"
>) {
  const { formatInteger, t, text } = useI18n();
  const describeState = (state: CollectionState) => {
    const phase = `${state.grade} ${t("common.phase", { phase: state.level })}`;
    return state.exp > 0 ? `${phase} · EXP ${formatInteger(state.exp)}` : phase;
  };
  if (view.type === "loading") {
    return (
      <div className={classes.loadingResult} role="status" aria-live="polite" aria-atomic="true">
        <div className={classes.loadingStack}>
          <span className={classes.loadingSpinner} aria-hidden="true" />
          <strong className={classes.loadingTitle}>{t("common.loadingTitle")}</strong>
          <p className={classes.loadingText}>{text(loading.text)}</p>
        </div>
      </div>
    );
  }
  if (view.type === "empty") {
    return <EmptyResultGuide />;
  }

  if (view.type === "callout") {
    return (
      <div className={classes.resultContent}>
        <div className={classes.callout}>{text(view.message)}</div>
      </div>
    );
  }

  if (view.type === "error") {
    const followUpFailure =
      view.reason === "follow_up_outcome_failure" || view.reason === "follow_up_conversion_failure";
    return (
      <div className={classes.resultContent}>
        <div className={`${classes.error} ${classes.errorContent}`} role="alert">
          <span>{text(view.message)}</span>
          {followUpFailure ? (
            <button className={classes.retryButton} type="button" onClick={onRetryCalculation}>
              <AlignedText alignmentRole="action">{t("result.retryCalculation")}</AlignedText>
            </button>
          ) : null}
        </div>
      </div>
    );
  }

  if (view.type === "convertRecommendation" || view.type === "recommendation") {
    return (
      <div className={classes.resultContent}>
        <LazyRecommendation
          view={view}
          onActionTransitionComplete={onActionTransitionComplete}
          onConvert={onConvert}
          onOutcome={onOutcome}
          onPendingOutcomeChange={onPendingOutcomeChange}
          outcomeDisabled={outcomeDisabled}
          pendingOutcome={pendingOutcome}
        />
      </div>
    );
  }

  return (
    <div className={classes.resultContent}>
      <div className={classes.callout}>
        {t("result.applied", {
          kit: t(RESULT_KIT_KEYS[view.kit as Kit]),
          uses: formatInteger(view.count),
          outcome: t(
            view.outcome === "success" ? "common.superSuccessYes" : "common.superSuccessNo",
          ),
          state: describeState(view.state),
          stock: text(view.stockMessage),
        })}
      </div>
      {view.canConvert ? (
        <LazyRecommendation
          view={{ type: "convertRecommendation", reason: "r15_conversion" }}
          onActionTransitionComplete={onActionTransitionComplete}
          onConvert={onConvert}
          onOutcome={onOutcome}
          onPendingOutcomeChange={onPendingOutcomeChange}
          outcomeDisabled={outcomeDisabled}
          pendingOutcome={pendingOutcome}
        />
      ) : null}
    </div>
  );
}

export default function ResultPanel({
  feedback,
  isStale,
  loading,
  needsStockEdit,
  staleSource,
  stockEditNotice,
  state,
  view,
  onActionTransitionComplete,
  onConvert,
  onOutcome,
  onRetryCalculation,
  outcomeDisabled,
  pendingOutcome,
  onPendingOutcomeChange,
}: ResultPanelProps) {
  const { locale, t, text } = useI18n();
  const showStaleOverlay =
    view.type !== "loading" && (needsStockEdit || (isStale && view.type !== "empty"));
  const staleMessage = needsStockEdit
    ? "key" in stockEditNotice
      ? text(stockEditNotice)
      : stockEditNotice[locale]
    : t(staleSource === "stock" ? "result.staleStock" : "result.staleState");

  return (
    <section className={classes.panel} aria-busy={view.type === "loading" || undefined}>
      <div className={classes.heading}>
        <h2>{t("result.title")}</h2>
        <CurrentStateStrip feedback={feedback} state={state} />
      </div>
      <div className={classes.resultBody}>
        {showStaleOverlay ? (
          <div className={classes.staleOverlay} role="status" aria-live="polite">
            <span className={classes.staleNotice}>{staleMessage}</span>
          </div>
        ) : null}
        <div
          id="resultBox"
          className={view.type === "empty" ? classes.emptyResult : ""}
          inert={showStaleOverlay || undefined}
        >
          <ResultViewContent
            view={view}
            onActionTransitionComplete={onActionTransitionComplete}
            onConvert={onConvert}
            onOutcome={onOutcome}
            outcomeDisabled={outcomeDisabled}
            pendingOutcome={pendingOutcome}
            loading={loading}
            onPendingOutcomeChange={onPendingOutcomeChange}
            onRetryCalculation={onRetryCalculation}
          />
        </div>
      </div>
    </section>
  );
}
