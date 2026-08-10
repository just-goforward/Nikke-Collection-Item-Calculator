import type { KeyboardEvent, ReactNode } from "react";
import { useRef } from "react";

import { useAnimatedStateProgress } from "../hooks/useAnimatedStateProgress";
import { useI18n } from "../i18n/locale";
import { nextNavigationIndex } from "../lib/keyboardNavigation";
import type {
  LoadingView,
  OutcomePreview,
  ResultView,
  StateChangeFeedback,
  StatePanelModel,
  StockCorrectionView,
} from "../ui-types";
import { presentOutcomePreview } from "../view-models/outcomePresentation";
import { AlignedText } from "./AlignedText";
import { stateFeedbackAnimations } from "./stateFeedbackAnimations";

export type MobileTab = "input" | "result" | "stats";

const MOBILE_TABS: MobileTab[] = ["input", "result", "stats"];

const MOBILE_TAB_PANELS: Record<MobileTab, string> = {
  input: "mobile-panel-input",
  result: "mobile-panel-result",
  stats: "statsWorkspace",
};

const classes = {
  statusStrip:
    "mobile-status-strip relative -mx-2.5 border-b border-border bg-surface px-3 pt-2.5 pb-2",
  statusStripFeedback: stateFeedbackAnimations.panel,
  statusState: "status-state flex min-w-0 items-center gap-2",
  statusGrade:
    "status-grade inline-flex size-6 min-w-6 flex-[0_0_24px] items-center justify-center rounded-[5px] bg-[var(--control-active-bg)] px-1 text-[11px] font-bold tracking-[0.04em] text-[var(--control-active-ink)] [text-shadow:none]",
  statusGradeFeedback: stateFeedbackAnimations.target,
  statusLevel:
    "status-level inline-flex min-h-6 items-center whitespace-nowrap text-[15px] font-extrabold text-text-strong [font-variant-numeric:tabular-nums]",
  statusLevelWrap: "relative grid min-w-[48px] gap-[3px]",
  levelBurst:
    "pointer-events-none absolute bottom-[calc(100%+1px)] left-1/2 grid -translate-x-1/2 grid-cols-3 gap-px text-[9px] font-extrabold leading-none text-grade-active motion-reduce:hidden",
  levelBurstIcon: "animate-[level-burst_700ms_ease-out_2_both]",
  statusLevelFeedback: stateFeedbackAnimations.text,
  statusExpBar:
    "status-exp-bar h-[7px] min-w-0 flex-1 overflow-hidden rounded-pill bg-progress-track",
  statusExpFill:
    "status-exp-fill h-full rounded-pill bg-grade-active transition-[width] duration-[420ms] ease-[cubic-bezier(0.2,0.8,0.2,1)]",
  statusExpFillNoTransition: "transition-none",
  statusExpText:
    "status-exp-text min-w-0 overflow-hidden text-ellipsis whitespace-nowrap text-right text-[10.5px] font-bold text-text-strong [font-variant-numeric:tabular-nums]",
  tabs: "mobile-tabs relative grid grid-cols-3 gap-0 border-t border-border bg-transparent px-1",
  tab: "mobile-tab relative grid min-h-[46px] cursor-pointer place-items-center border-0 bg-transparent px-1.5 py-0 text-[13px] font-semibold leading-none tracking-[0.01em] text-muted transition-colors duration-160 ease-[ease] hover:text-text-soft max-phone-xs:text-xs",
  tabActive: "active text-grade-active-strong",
  tabHighlight:
    "mobile-tab-highlight pointer-events-none absolute top-[-1px] left-0 h-[2.5px] w-1/3 transform-gpu transition-transform duration-[220ms] ease-[cubic-bezier(0.2,0.8,0.2,1)] before:absolute before:inset-y-0 before:left-[22%] before:right-[22%] before:rounded-pill before:bg-grade-active before:content-[''] motion-reduce:transition-none",
  tabDot:
    "mobile-tab-dot absolute top-[9px] right-[calc(50%_-_32px)] size-1.5 rounded-full bg-grade-active not-italic",
  actionBar: "mobile-action-bar grid grid-cols-1 gap-2 px-3 pt-2.5 pb-2.5 shadow-none",
  actionBarCalculate: "mode-calculate grid-cols-[68px_1fr]",
  actionBarOutcome:
    "mode-outcome outcome-ring mx-1 mb-1.5 mt-1 grid-cols-2 rounded-card border-2 border-yellow-kit bg-outcome text-outcome-text",
  actionBarConvert: "mode-convert grid-cols-1",
  actionPrompt:
    "mobile-action-prompt col-span-full text-center text-[13px] font-semibold leading-[1.3] text-outcome-text",
  actionChangeNote:
    "change-note col-span-full m-0 text-center text-[11.5px] font-semibold leading-[1.45] text-outcome-text",
  actionOutcomeChoice: "grid min-w-0 grid-rows-[48px_minmax(18px,auto)] gap-0.5",
  actionChoiceCaption:
    "action-choice-caption m-0 flex min-h-[18px] flex-wrap items-center justify-center text-balance text-center text-[10px] font-semibold leading-[1.25] text-muted [overflow-wrap:anywhere] [word-break:keep-all]",
  actionCaptionPrefix: "text-muted",
  actionCaptionValue: "font-bold text-text-strong",
  actionButton:
    "inline-flex h-12 min-h-12 items-center justify-center whitespace-nowrap rounded-card text-[15px] font-bold leading-none tracking-[0.01em] max-phone-xs:text-[13px]",
  primaryButton:
    "primary-button bg-action text-ice shadow-[inset_0_0_0_1px_rgba(248,252,254,0.10),0_10px_22px_rgba(21,43,58,0.18)] transition-[filter,box-shadow,transform,background-color] duration-[140ms] enabled:hover:brightness-[1.08] enabled:hover:shadow-[inset_0_0_0_1px_rgba(248,252,254,0.16),0_12px_26px_rgba(21,43,58,0.24)] enabled:active:translate-y-px enabled:active:shadow-[inset_0_0_0_1px_rgba(248,252,254,0.12),0_4px_10px_rgba(21,43,58,0.18)] [body.theme-dark_&]:bg-[#ee7a87] [body.theme-dark_&]:text-[#2a0c12] [body.theme-dark_&]:shadow-[inset_0_0_0_1px_rgba(255,255,255,0.22),0_10px_22px_rgba(0,0,0,0.45)] [body.theme-dark_&]:enabled:hover:bg-[#f48f99] [body.theme-dark_&]:enabled:hover:brightness-100 [body.theme-dark_&]:enabled:hover:shadow-[inset_0_0_0_1px_rgba(255,255,255,0.28),0_12px_26px_rgba(0,0,0,0.55)] [body.theme-dark_&]:enabled:active:bg-[#d6646f] [body.theme-dark_&]:enabled:active:shadow-[inset_0_0_0_1px_rgba(255,255,255,0.22),0_4px_10px_rgba(0,0,0,0.4)]",
  resetButton:
    "reset-button inline-flex self-center justify-self-center !min-h-[34px] items-center justify-center border-0 bg-transparent px-0 !text-[11px] !font-medium leading-none text-muted underline underline-offset-[3px] transition-[color,transform] duration-[140ms] enabled:hover:text-text-soft enabled:active:translate-y-px",
  outcomeButton:
    "relative inline-flex min-h-[44px] items-center justify-center overflow-hidden border border-border leading-none select-none [touch-action:manipulation] [-webkit-touch-callout:none] [-webkit-user-select:none] [user-select:none]",
  successButton: "success-button border-yellow-kit bg-button text-text",
  failButton: "fail-button border-yellow-kit bg-button text-text",
  outcomeConfirmButton:
    "border-0 bg-action text-ice shadow-[inset_0_0_0_1px_rgba(248,252,254,0.10)]",
  outcomeCancelButton: "border border-border bg-button text-muted",
  convertButton: "bg-primary text-ice",
  stockEditDisabled:
    "disabled:opacity-100 disabled:border-2 disabled:border-yellow-kit disabled:bg-warning-soft disabled:text-warning disabled:shadow-[0_0_0_3px_rgba(230,170,38,0.22)]",
  spinner:
    "inline-block size-[13px] animate-spin rounded-full border-2 border-[color-mix(in_srgb,var(--ice)_32%,transparent)] border-t-ice [body.theme-dark_&]:border-[rgba(42,12,18,0.24)] [body.theme-dark_&]:border-t-[#2a0c12]",
} as const;

type MobileActionBarProps = {
  view: ResultView;
  loading: LoadingView;
  calculateDisabled: boolean;
  isStale: boolean;
  needsStockEdit: boolean;
  correction: StockCorrectionView | null;
  onCalculate: () => void;
  onReset: () => void;
  onConvert: () => void | Promise<void>;
  onOutcome: (outcome: "success" | "fail") => void;
  pendingOutcome: "success" | "fail" | null;
  onPendingOutcomeChange: (outcome: "success" | "fail" | null) => void;
};

type MobileStatusStripProps = {
  feedback: StateChangeFeedback | null;
  state: StatePanelModel;
};

type MobileTabsProps = {
  active: MobileTab;
  hasResult: boolean;
  needsStockEdit: boolean;
  onChange: (tab: MobileTab) => void;
};

function MobileToolbar({ children, mode }: { children: ReactNode; mode: string }) {
  const { t } = useI18n();
  const modeClass = mode.includes("mode-outcome")
    ? classes.actionBarOutcome
    : mode.includes("mode-convert")
      ? classes.actionBarConvert
      : classes.actionBarCalculate;

  return (
    <div
      className={`${classes.actionBar} ${modeClass} ${mode}`}
      role="toolbar"
      aria-label={t("common.mobileActions")}
    >
      {children}
    </div>
  );
}

function commitFocusedInput() {
  const activeElement = document.activeElement;
  if (
    activeElement instanceof HTMLInputElement ||
    activeElement instanceof HTMLSelectElement ||
    activeElement instanceof HTMLTextAreaElement
  ) {
    activeElement.blur();
  }
}

function expSummaryText(
  state: StatePanelModel,
  formatInteger: (value: number) => string,
  maxPhaseLabel: string,
) {
  const required = state.expDisabled ? 0 : state.requiredExp;
  if (required <= 0) return maxPhaseLabel;
  return `${formatInteger(state.exp)} / ${formatInteger(required)}`;
}

function ActionPreviewValue({ preview }: { preview: OutcomePreview }) {
  const { locale } = useI18n();
  const parts = presentOutcomePreview(preview, locale);
  return (
    <>
      <strong className={classes.actionCaptionValue}>{parts.emphasis}</strong>
      {parts.suffix ? <span className={classes.actionCaptionPrefix}>{parts.suffix}</span> : null}
    </>
  );
}

function ActionPreviewCaption({ preview }: { preview: OutcomePreview }) {
  return <ActionPreviewValue preview={preview} />;
}

function PendingActionCaption({ preview }: { preview: OutcomePreview }) {
  return <ActionPreviewValue preview={preview} />;
}

function MobileOutcomeActionBar({
  onOutcome,
  onPendingOutcomeChange,
  pendingOutcome,
  view,
}: Pick<MobileActionBarProps, "onOutcome" | "onPendingOutcomeChange" | "pendingOutcome"> & {
  view: Extract<ResultView, { type: "recommendation" }>;
}) {
  const { t } = useI18n();
  const armOutcome = (outcome: "success" | "fail") => {
    onPendingOutcomeChange(outcome);
  };
  const confirmOutcome = (outcome: "success" | "fail") => {
    onPendingOutcomeChange(null);
    onOutcome(outcome);
  };

  const successButton =
    pendingOutcome === "success" ? (
      <span className={classes.actionOutcomeChoice}>
        <button
          className={`${classes.actionButton} ${classes.outcomeButton} ${classes.outcomeConfirmButton} success-button`}
          type="button"
          onClick={() => confirmOutcome("success")}
        >
          <AlignedText alignmentRole="action">{t("common.superSuccessYesConfirm")}</AlignedText>
        </button>
        <strong className={`${classes.actionChoiceCaption} text-text-strong`}>
          <PendingActionCaption preview={view.successPreview} />
        </strong>
      </span>
    ) : pendingOutcome === "fail" ? (
      <span className={classes.actionOutcomeChoice}>
        <button
          className={`${classes.actionButton} ${classes.outcomeButton} ${classes.outcomeCancelButton}`}
          type="button"
          onClick={() => onPendingOutcomeChange(null)}
        >
          <AlignedText alignmentRole="action">{t("common.cancel")}</AlignedText>
        </button>
        <span className={classes.actionChoiceCaption} aria-hidden="true" />
      </span>
    ) : (
      <span className={classes.actionOutcomeChoice}>
        <button
          className={`${classes.actionButton} ${classes.outcomeButton} ${classes.successButton} success-button`}
          type="button"
          onClick={() => armOutcome("success")}
        >
          <AlignedText alignmentRole="action">{t("common.superSuccessYes")}</AlignedText>
        </button>
        <strong className={`${classes.actionChoiceCaption} text-text-strong`}>
          <ActionPreviewCaption preview={view.successPreview} />
        </strong>
      </span>
    );
  const failButton =
    pendingOutcome === "fail" ? (
      <span className={classes.actionOutcomeChoice}>
        <button
          className={`${classes.actionButton} ${classes.outcomeButton} ${classes.outcomeConfirmButton} fail-button`}
          type="button"
          onClick={() => confirmOutcome("fail")}
        >
          <AlignedText alignmentRole="action">{t("common.superSuccessNoConfirm")}</AlignedText>
        </button>
        <strong className={`${classes.actionChoiceCaption} text-text-strong`}>
          <PendingActionCaption preview={view.failPreview} />
        </strong>
      </span>
    ) : pendingOutcome === "success" ? (
      <span className={classes.actionOutcomeChoice}>
        <button
          className={`${classes.actionButton} ${classes.outcomeButton} ${classes.outcomeCancelButton}`}
          type="button"
          onClick={() => onPendingOutcomeChange(null)}
        >
          <AlignedText alignmentRole="action">{t("common.cancel")}</AlignedText>
        </button>
        <span className={classes.actionChoiceCaption} aria-hidden="true" />
      </span>
    ) : (
      <span className={classes.actionOutcomeChoice}>
        <button
          className={`${classes.actionButton} ${classes.outcomeButton} ${classes.failButton} fail-button`}
          type="button"
          onClick={() => armOutcome("fail")}
        >
          <AlignedText alignmentRole="action">{t("common.superSuccessNo")}</AlignedText>
        </button>
        <strong className={`${classes.actionChoiceCaption} text-text-strong`}>
          <ActionPreviewCaption preview={view.failPreview} />
        </strong>
      </span>
    );

  return (
    <MobileToolbar mode={`mode-outcome ${pendingOutcome ? "is-holding-ring" : ""}`}>
      <p className={classes.actionChangeNote}>{t("result.outcomePrompt")}</p>
      {successButton}
      {failButton}
    </MobileToolbar>
  );
}

function MobileConvertActionBar({ onConvert }: Pick<MobileActionBarProps, "onConvert">) {
  const { t } = useI18n();
  return (
    <MobileToolbar mode="mode-convert">
      <button
        className={`${classes.actionButton} ${classes.outcomeButton} ${classes.convertButton} convert-button`}
        type="button"
        aria-label={t("common.convertToSr")}
        onClick={onConvert}
      >
        <AlignedText alignmentRole="action">{t("common.applyConversion")}</AlignedText>
      </button>
    </MobileToolbar>
  );
}

function MobileCalculateActionBar({
  calculateDisabled,
  correction,
  isStale,
  loading,
  needsStockEdit,
  onCalculate,
  onReset,
}: Pick<
  MobileActionBarProps,
  | "calculateDisabled"
  | "correction"
  | "isStale"
  | "loading"
  | "needsStockEdit"
  | "onCalculate"
  | "onReset"
>) {
  const { t } = useI18n();
  let calculateLabel: ReactNode = t(isStale ? "common.recalculate" : "common.calculateLong");
  if (correction?.status === "valid") {
    calculateLabel = t("stock.correctionCalculate", { attempt: correction.successAttempt ?? 1 });
  } else if (correction?.canCalculate) {
    calculateLabel = t("common.recalculate");
  } else if (needsStockEdit) {
    calculateLabel = t("common.stockEditRequired");
  } else if (loading.active) {
    calculateLabel = (
      <>
        <span className={classes.spinner} aria-hidden="true" /> {t("common.calculating")}
      </>
    );
  }
  return (
    <MobileToolbar mode={needsStockEdit ? "mode-calculate needs-stock-edit" : "mode-calculate"}>
      <button
        className={`${classes.actionButton} ${classes.resetButton}`}
        type="button"
        onClick={onReset}
      >
        <AlignedText alignmentRole="action">{t("common.reset")}</AlignedText>
      </button>
      <button
        className={`${classes.actionButton} ${classes.primaryButton} ${
          needsStockEdit && !correction?.canCalculate ? classes.stockEditDisabled : ""
        }`}
        type="button"
        disabled={calculateDisabled || loading.active}
        onPointerDown={commitFocusedInput}
        onClick={onCalculate}
      >
        <AlignedText alignmentRole="action" className="gap-2">
          {calculateLabel}
        </AlignedText>
      </button>
    </MobileToolbar>
  );
}

export function MobileActionBar({
  view,
  loading,
  calculateDisabled,
  correction,
  isStale,
  needsStockEdit,
  onCalculate,
  onReset,
  onConvert,
  onOutcome,
  pendingOutcome,
  onPendingOutcomeChange,
}: MobileActionBarProps) {
  if (view.type === "recommendation" && !needsStockEdit && !isStale && !loading.active) {
    return (
      <MobileOutcomeActionBar
        pendingOutcome={pendingOutcome}
        view={view}
        onOutcome={onOutcome}
        onPendingOutcomeChange={onPendingOutcomeChange}
      />
    );
  }

  if (view.type === "convertRecommendation" || (view.type === "outcome" && view.canConvert)) {
    return <MobileConvertActionBar onConvert={onConvert} />;
  }

  return (
    <MobileCalculateActionBar
      calculateDisabled={calculateDisabled}
      correction={correction}
      isStale={isStale}
      loading={loading}
      needsStockEdit={needsStockEdit}
      onCalculate={onCalculate}
      onReset={onReset}
    />
  );
}

export function MobileStatusStrip({ feedback, state }: MobileStatusStripProps) {
  const { formatInteger, t } = useI18n();
  const feedbackActive = feedback?.to.grade === state.grade && feedback.to.level === state.level;
  const animated = useAnimatedStateProgress(state, feedbackActive ? feedback : null);
  const displayState = animated.state;

  return (
    <div
      className={`${classes.statusStrip} ${feedbackActive ? classes.statusStripFeedback : ""}`}
      role="status"
      aria-live="polite"
    >
      <div className={classes.statusState}>
        <span
          className={`${classes.statusGrade} grade-${displayState.grade.toLowerCase()} ${
            feedbackActive && feedback.type === "grade" ? classes.statusGradeFeedback : ""
          }`}
        >
          <AlignedText alignmentRole="status">{displayState.grade}</AlignedText>
        </span>
        <span className={classes.statusLevelWrap}>
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
          <span
            className={`${classes.statusLevel} ${
              feedbackActive ? classes.statusLevelFeedback : ""
            }`}
          >
            <AlignedText alignmentRole="status">
              {t("common.phase", { phase: displayState.level })}
            </AlignedText>
          </span>
        </span>
        <div className={classes.statusExpBar} aria-hidden="true">
          <div
            className={`${classes.statusExpFill} ${
              animated.transition ? "" : classes.statusExpFillNoTransition
            }`}
            style={{ width: `${animated.progress}%` }}
          />
        </div>
        <span className={classes.statusExpText}>
          {expSummaryText(displayState, formatInteger, t("common.maxPhase"))}
        </span>
      </div>
    </div>
  );
}

export function MobileTabs({ active, hasResult, needsStockEdit, onChange }: MobileTabsProps) {
  const { t } = useI18n();
  const tabLabels: Record<MobileTab, string> = {
    input: t("tab.input"),
    result: t("tab.result"),
    stats: t("tab.stats"),
  };
  const activeIndex = MOBILE_TABS.indexOf(active);
  const tabRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const selectFromKeyboard = (event: KeyboardEvent<HTMLButtonElement>, currentIndex: number) => {
    const nextIndex = nextNavigationIndex(
      event.key,
      currentIndex,
      MOBILE_TABS.length,
      "horizontal",
    );
    if (nextIndex === null) return;
    event.preventDefault();
    const nextTab = MOBILE_TABS[nextIndex];
    if (!nextTab) return;
    onChange(nextTab);
    tabRefs.current[nextIndex]?.focus();
  };

  return (
    <div
      className={classes.tabs}
      data-active-index={activeIndex < 0 ? 0 : activeIndex}
      role="tablist"
      aria-label={t("common.viewSwitch")}
    >
      <span className={classes.tabHighlight} aria-hidden="true" />
      {MOBILE_TABS.map((tab) => (
        <button
          className={active === tab ? `${classes.tab} ${classes.tabActive}` : classes.tab}
          aria-controls={MOBILE_TAB_PANELS[tab]}
          key={tab}
          type="button"
          id={`mobile-tab-${tab}`}
          role="tab"
          aria-selected={active === tab}
          tabIndex={active === tab ? 0 : -1}
          ref={(element) => {
            tabRefs.current[MOBILE_TABS.indexOf(tab)] = element;
          }}
          onKeyDown={(event) => selectFromKeyboard(event, MOBILE_TABS.indexOf(tab))}
          onClick={() => onChange(tab)}
        >
          <AlignedText alignmentRole="segment">{tabLabels[tab]}</AlignedText>
          {(needsStockEdit && tab === "input") ||
          (!needsStockEdit && tab === "result" && hasResult) ? (
            <em className={classes.tabDot} aria-hidden="true" />
          ) : null}
        </button>
      ))}
    </div>
  );
}
