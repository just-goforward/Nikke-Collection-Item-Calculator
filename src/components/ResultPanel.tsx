import { type CSSProperties, type ReactNode, useEffect, useLayoutEffect, useRef } from "react";

import { useAnimatedStateProgress } from "../hooks/useAnimatedStateProgress";
import { useI18n } from "../i18n/locale";
import type { LocalizedMessage, MessageKey } from "../i18n/messages.ko";
import type { CollectionState, Kit } from "../types";
import type {
  OutcomePreview,
  RecommendationActionTransition,
  ResultKit,
  ResultView,
  StateChangeFeedback,
  StatePanelModel,
} from "../ui-types";
import { presentOutcomePreview } from "../view-models/outcomePresentation";
import { AlignedText } from "./AlignedText";
import { STATE_FEEDBACK_VISIBLE_MS, stateFeedbackAnimations } from "./stateFeedbackAnimations";

const RESULT_KIT_KEYS: Record<ResultKit, MessageKey> = {
  blue: "kit.blue",
  purple: "kit.purple",
  yellow: "kit.yellow",
  convert: "common.convertToSr",
};

const RESULT_KIT_PANEL_KEYS: Record<Kit, MessageKey> = {
  blue: "kit.bluePanel",
  purple: "kit.purplePanel",
  yellow: "kit.yellowPanel",
};

const resultKitDotClass: Record<ResultKit, string> = {
  blue: "bg-blue-kit",
  purple: "bg-purple-kit",
  yellow: "bg-yellow-kit",
  convert: "bg-primary",
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
  stateFeedbackBadge: `state-feedback-badge inline-flex shrink-0 items-center rounded-pill border border-grade-active bg-surface-raised px-2 py-1 text-[10.5px] font-semibold leading-none text-grade-active-strong shadow-[0_8px_18px_rgba(21,43,58,0.14)] ${stateFeedbackAnimations.badge}`,
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
  recommendation:
    "recommendation grid items-stretch gap-3 [container-type:inline-size] max-mobile:gap-2.5",
  nextAction:
    "next-action relative grid min-h-[120px] overflow-hidden rounded-card bg-action p-[18px] text-center text-ice [perspective:900px] max-mobile:min-h-24 max-mobile:p-3",
  nextActionCard: "next-action-card grid min-h-full w-full place-items-center",
  previousActionCard:
    "next-action-previous pointer-events-none absolute inset-0 z-0 grid place-items-center rounded-card bg-action p-[18px] text-center text-ice opacity-80 transform-gpu animate-[next-action-previous-out_var(--next-action-feedback-ms)_cubic-bezier(0.2,0.8,0.2,1)_forwards] max-mobile:p-3 max-mobile:animate-[next-action-previous-out-mobile_var(--next-action-feedback-ms)_cubic-bezier(0.2,0.8,0.2,1)_forwards] motion-reduce:hidden",
  currentActionCard:
    "next-action-current relative z-[1] grid min-h-full w-full place-items-center transform-gpu animate-[next-action-current-in_var(--next-action-feedback-ms)_cubic-bezier(0.2,0.8,0.2,1)_forwards] max-mobile:animate-[next-action-current-in-mobile_var(--next-action-feedback-ms)_cubic-bezier(0.2,0.8,0.2,1)_forwards] motion-reduce:animate-none",
  nextInner: "min-w-0 w-full",
  actionLabel: "action-label text-[12px] font-bold text-action-label max-mobile:text-[10.5px]",
  nextStrong:
    "mt-[7px] block text-[clamp(24px,3vw,38px)] font-extrabold leading-[1.05] [overflow-wrap:break-word] [word-break:keep-all]",
  actionChip: "action-chip inline-flex items-center justify-center gap-[9px]",
  actionDot: "inline-block size-4 rounded-full shadow-[0_0_0_3px_rgba(255,255,255,0.18)]",
  actionChipLarge:
    "action-chip-large inline-flex max-w-full flex-nowrap items-center justify-center gap-2.5 max-mobile:w-auto max-mobile:gap-2",
  actionChipText:
    "action-chip-text inline-flex min-w-0 items-baseline gap-0 whitespace-nowrap text-[clamp(23px,2.7vw,34px)] max-mobile:flex max-mobile:flex-wrap max-mobile:justify-center max-mobile:whitespace-normal max-mobile:text-[clamp(18px,5vw,24px)]",
  actionChipName:
    "action-chip-name inline min-w-0 leading-[1.16] [overflow-wrap:break-word] [word-break:keep-all] max-mobile:w-auto max-mobile:max-w-full",
  actionChipNameFull: "action-chip-name-full",
  actionChipNameMobile: "action-chip-name-mobile hidden",
  actionChipQuantity: "action-chip-quantity inline-flex shrink-0 items-baseline whitespace-nowrap",
  actionChipSeparator:
    "action-chip-separator inline min-w-0 whitespace-pre leading-[1.08] text-ice",
  actionChipCount: "action-chip-count inline min-w-0 leading-[1.08] text-ice",
  outcomePanel:
    "outcome-panel grid grid-cols-[minmax(0,1fr)_max-content] items-center gap-3.5 rounded-card border-2 border-yellow-kit bg-outcome px-4 py-3 shadow-[0_12px_26px_rgba(128,89,11,0.12)] min-[661px]:max-tablet:gap-3 min-[661px]:max-tablet:px-4 max-mobile:hidden",
  outcomePanelRing: "outcome-ring",
  outcomeCopy: "outcome-copy grid min-w-0 gap-1.5",
  outcomeTitle:
    "outcome-title m-0 flex min-w-0 items-center gap-2 whitespace-nowrap text-[17px] font-semibold text-outcome-text before:inline-block before:size-[11px] before:shrink-0 before:rounded-full before:bg-yellow-kit before:shadow-[0_0_0_4px_rgba(230,170,38,0.22)] before:content-[''] min-[661px]:max-tablet:text-[15px]",
  outcomeTitleText: "outcome-title-text min-w-0",
  outcomeActionGroup:
    "outcome-action-group grid w-[var(--outcome-actions-width,360px)] min-w-0 max-w-full justify-self-end content-center gap-1",
  outcomeButtons: "outcome-buttons grid grid-cols-2 gap-2",
  outcomeChoiceCaption:
    "outcome-choice-caption m-0 flex min-h-[18px] self-center flex-wrap items-center justify-center text-balance text-center text-[10.5px] font-semibold leading-[1.2] text-muted [overflow-wrap:anywhere] [word-break:keep-all]",
  outcomeCaptionPrefix: "text-muted",
  outcomeCaptionValue: "font-bold text-text-strong",
  outcomeButton:
    "relative inline-flex min-h-[52px] items-center justify-center overflow-hidden whitespace-nowrap border bg-button px-2 text-[16px] font-bold leading-none [touch-action:manipulation] [user-select:none] min-[661px]:max-tablet:min-h-[46px] min-[661px]:max-tablet:text-[13.5px] max-mobile:min-w-0 max-mobile:px-2 max-mobile:text-[13px] max-mobile:min-h-10",
  successButton: "success-button border-yellow-kit text-text",
  failButton: "fail-button border-yellow-kit text-text",
  successHoldFill: "bg-[rgba(230,170,38,0.42)]",
  failHoldFill: "bg-[rgba(230,170,38,0.42)]",
  hiddenDot: "hidden",
  outcomeCaption:
    "outcome-caption m-0 flex min-h-[18px] self-center flex-wrap items-center justify-center text-balance text-center text-[10.5px] font-semibold leading-[1.2] text-muted [overflow-wrap:anywhere] [word-break:keep-all]",
  outcomeCaptionStage: "outcome-caption-stage grid min-h-[26px] min-[1004px]:min-h-[18px]",
  outcomeChoiceCaptions: "grid grid-cols-2 gap-2",
  outcomeCaptionLayer: "col-start-1 row-start-1",
  convertActionGroup: "grid justify-self-end w-[min(180px,100%)]",
  convertButton: "convert-button bg-primary text-ice",
  changeNote:
    "change-note m-0 text-[13px] font-semibold leading-[1.45] text-muted max-mobile:text-[11.5px]",
  outcomeConfirmButton:
    "inline-flex min-h-[52px] items-center justify-center whitespace-nowrap border-0 bg-action px-2 text-[15px] font-bold leading-none text-ice shadow-[inset_0_0_0_1px_rgba(248,252,254,0.10)] min-[661px]:max-tablet:min-h-[46px] min-[661px]:max-tablet:text-[13px]",
  outcomeCancelButton:
    "inline-flex min-h-[52px] items-center justify-center whitespace-nowrap border border-border bg-button px-2 text-[14px] font-bold leading-none text-muted min-[661px]:max-tablet:min-h-[46px] min-[661px]:max-tablet:text-[13px]",
} as const;

function outcomeLayoutMeasurementKey(panelWidth: number) {
  const root = document.documentElement;
  return `${Math.round(panelWidth * 2) / 2}:${root.getAttribute("data-locale")}:${root.getAttribute("data-locale-font-ready")}`;
}

function observeLocaleLayoutChanges(updateLayout: () => void) {
  const observer = new MutationObserver(updateLayout);
  observer.observe(document.documentElement, {
    attributeFilter: ["data-locale", "data-locale-font-ready"],
    attributes: true,
  });
  return observer;
}

type ResultPanelProps = {
  needsStockEdit: boolean;
  isStale: boolean;
  staleSource: "state" | "stock" | null;
  stockEditNotice: LocalizedMessage;
  feedback: StateChangeFeedback | null;
  state: StatePanelModel;
  view: ResultView;
  onActionTransitionComplete: (transitionId: number) => void;
  onConvert: () => void | Promise<void>;
  onOutcome: (outcome: "success" | "fail") => void;
  outcomeDisabled: boolean;
  pendingOutcome: "success" | "fail" | null;
  onPendingOutcomeChange: (outcome: "success" | "fail" | null) => void;
};

function ActionChip({
  kit,
  count,
  large = false,
}: {
  kit: ResultKit;
  count?: number;
  large?: boolean;
}) {
  const { formatCount, t } = useI18n();
  const kitLabel = t(RESULT_KIT_KEYS[kit]);
  const className = `${classes.actionChip} ${large ? classes.actionChipLarge : ""} ${
    kit === "convert" ? "" : kit
  }`;

  if (!large || kit === "convert") {
    return (
      <span className={className.trim()}>
        <i aria-hidden="true" className={`${classes.actionDot} ${resultKitDotClass[kit]}`}></i>
        {kitLabel}
      </span>
    );
  }

  return (
    <span className={className}>
      <i
        aria-hidden="true"
        className={`${classes.actionDot} ${resultKitDotClass[kit]} shrink-0 self-center`}
      ></i>
      <span className={classes.actionChipText}>
        <span className={classes.actionChipName}>
          <span className={classes.actionChipNameFull}>{kitLabel}</span>
          <span className={classes.actionChipNameMobile}>{t(RESULT_KIT_PANEL_KEYS[kit])}</span>
        </span>
        <span className={classes.actionChipQuantity}>
          <span className={classes.actionChipSeparator}>{"\u00a0×\u00a0"}</span>
          <span className={classes.actionChipCount}>{formatCount(count || 1, "use")}</span>
        </span>
      </span>
    </span>
  );
}

function ActionCardContent({ count, kit }: { kit: ResultKit; count?: number }) {
  const { t } = useI18n();
  return (
    <div className={classes.nextInner}>
      <span className={classes.actionLabel}>{t("common.recommended")}</span>
      <strong className={classes.nextStrong}>
        <ActionChip
          kit={kit}
          large={kit !== "convert"}
          {...(count !== undefined ? { count } : {})}
        />
      </strong>
    </div>
  );
}

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

function RecommendationBlock({
  actionContent,
  kit,
  count = 1,
  outcomePending = false,
  outcomeRing = false,
  title,
  children,
  transition,
  onTransitionComplete,
}: {
  actionContent?: ReactNode;
  kit: ResultKit;
  count?: number;
  outcomePending?: boolean;
  outcomeRing?: boolean;
  title: string;
  children: ReactNode;
  transition?: RecommendationActionTransition;
  onTransitionComplete?: (transitionId: number) => void;
}) {
  const outcomePanelRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!transition || !onTransitionComplete) return;
    const transitionId = transition.id;
    const timeoutId = window.setTimeout(
      () => onTransitionComplete(transitionId),
      STATE_FEEDBACK_VISIBLE_MS,
    );
    return () => window.clearTimeout(timeoutId);
  }, [onTransitionComplete, transition]);

  useLayoutEffect(() => {
    const panel = outcomePanelRef.current;
    if (!panel) return;

    let measurementKey = "";
    const updateLayout = () => {
      const panelWidth = panel.getBoundingClientRect().width;
      const nextMeasurementKey = outcomeLayoutMeasurementKey(panelWidth);
      if (nextMeasurementKey === measurementKey) return;
      measurementKey = nextMeasurementKey;
      panel.setAttribute("data-layout", "inline");

      const copy = panel.querySelector<HTMLElement>(".outcome-copy");
      const actions = panel.querySelector<HTMLElement>(".outcome-action-group");
      if (!copy || !actions) return;

      const panelBounds = panel.getBoundingClientRect();
      const copyBounds = copy.getBoundingClientRect();
      const actionBounds = actions.getBoundingClientRect();
      const panelStyle = getComputedStyle(panel);
      const contentLeft =
        panelBounds.left +
        Number.parseFloat(panelStyle.borderLeftWidth) +
        Number.parseFloat(panelStyle.paddingLeft);
      const contentRight =
        panelBounds.right -
        Number.parseFloat(panelStyle.borderRightWidth) -
        Number.parseFloat(panelStyle.paddingRight);
      const childOverflows =
        copyBounds.left < contentLeft - 1 || actionBounds.right > contentRight + 1;
      const copyOverflows = copy.scrollWidth > copy.clientWidth + 1;
      const actionsOverflow = actions.scrollWidth > actions.clientWidth + 1;
      panel.setAttribute(
        "data-layout",
        childOverflows || copyOverflows || actionsOverflow ? "stacked" : "inline",
      );
    };

    updateLayout();
    if (typeof ResizeObserver !== "function") return;
    const observer = new ResizeObserver(updateLayout);
    observer.observe(panel);
    const localeObserver = observeLocaleLayoutChanges(updateLayout);
    return () => {
      observer.disconnect();
      localeObserver.disconnect();
    };
  });

  const transitionStyle = transition
    ? ({ "--next-action-feedback-ms": `${STATE_FEEDBACK_VISIBLE_MS}ms` } as CSSProperties)
    : undefined;

  return (
    <div className={classes.recommendation}>
      <div className={classes.nextAction} style={transitionStyle}>
        {transition ? (
          <div className={classes.previousActionCard} key={`previous-${transition.id}`}>
            <ActionCardContent kit={transition.previous.kit} count={transition.previous.count} />
          </div>
        ) : null}
        <div
          className={transition ? classes.currentActionCard : classes.nextActionCard}
          key={transition ? `current-${transition.id}` : "current-static"}
        >
          <ActionCardContent kit={kit} count={count} />
        </div>
      </div>
      <div
        ref={outcomePanelRef}
        data-layout="inline"
        className={`${classes.outcomePanel} ${outcomeRing ? classes.outcomePanelRing : ""} ${
          outcomePending ? "is-holding-ring" : ""
        }`}
      >
        <div className={classes.outcomeCopy}>
          <h3 className={classes.outcomeTitle}>
            <span className={classes.outcomeTitleText}>{title}</span>
          </h3>
          {children}
        </div>
        {actionContent}
      </div>
    </div>
  );
}

function OutcomePreviewValue({ preview }: { preview: OutcomePreview }) {
  const { locale } = useI18n();
  const parts = presentOutcomePreview(preview, locale);
  return (
    <>
      <strong className={classes.outcomeCaptionValue}>{parts.emphasis}</strong>
      {parts.suffix ? <span className={classes.outcomeCaptionPrefix}>{parts.suffix}</span> : null}
    </>
  );
}

function OutcomePreviewCaption({ preview }: { preview: OutcomePreview }) {
  return <OutcomePreviewValue preview={preview} />;
}

function PendingOutcomeCaption({
  outcome,
  preview,
}: {
  outcome: "success" | "fail";
  preview: OutcomePreview;
}) {
  const { t } = useI18n();
  const label = t(outcome === "success" ? "common.superSuccessYes" : "common.superSuccessNo");
  return (
    <>
      <strong className={classes.outcomeCaptionValue}>{label}</strong>
      <span className={classes.outcomeCaptionPrefix}>{t("result.recordPrefix")}</span>
      <OutcomePreviewValue preview={preview} />
      <span className={classes.outcomeCaptionPrefix}>{t("result.recordSuffix")}</span>
    </>
  );
}

function OutcomeCaptionStage({
  activeOutcome,
  failPreview,
  successPreview,
}: {
  activeOutcome: "success" | "fail" | null;
  failPreview: OutcomePreview;
  successPreview: OutcomePreview;
}) {
  return (
    <div className={classes.outcomeCaptionStage}>
      <div
        aria-hidden={activeOutcome !== null}
        className={`${classes.outcomeChoiceCaptions} ${classes.outcomeCaptionLayer} ${
          activeOutcome === null ? "" : "invisible"
        }`}
      >
        <strong className={`${classes.outcomeChoiceCaption} text-text-strong`}>
          <OutcomePreviewCaption preview={successPreview} />
        </strong>
        <strong className={`${classes.outcomeChoiceCaption} text-text-strong`}>
          <OutcomePreviewCaption preview={failPreview} />
        </strong>
      </div>
      {(["success", "fail"] as const).map((outcome) => {
        const active = outcome === activeOutcome;
        return (
          <p
            aria-hidden={!active}
            className={`${classes.outcomeCaption} ${classes.outcomeCaptionLayer} ${
              active ? "" : "invisible"
            }`}
            key={outcome}
          >
            <PendingOutcomeCaption
              outcome={outcome}
              preview={outcome === "success" ? successPreview : failPreview}
            />
          </p>
        );
      })}
    </div>
  );
}

function ConvertRecommendation({ onConvert }: { onConvert: () => void | Promise<void> }) {
  const { t } = useI18n();
  return (
    <RecommendationBlock
      actionContent={
        <div className={classes.convertActionGroup}>
          <button
            className={`${classes.outcomeButton} ${classes.convertButton}`}
            type="button"
            data-convert="sr"
            onClick={onConvert}
          >
            <AlignedText alignmentRole="action">{t("common.applyConversion")}</AlignedText>
          </button>
        </div>
      }
      kit="convert"
      title={t("result.conversionTitle")}
    >
      <span className="sr-only">{t("result.conversionSrOnly")}</span>
    </RecommendationBlock>
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

function OutcomeActionButtons({
  disabled,
  failPreview,
  pendingOutcome,
  successPreview,
  onOutcome,
  onPendingOutcomeChange,
}: {
  disabled: boolean;
  failPreview: OutcomePreview;
  pendingOutcome: "success" | "fail" | null;
  successPreview: OutcomePreview;
  onOutcome: (outcome: "success" | "fail") => void;
  onPendingOutcomeChange: (outcome: "success" | "fail" | null) => void;
}) {
  const { t } = useI18n();
  const armOutcome = (outcome: "success" | "fail") => {
    if (disabled) return;
    onPendingOutcomeChange(outcome);
  };
  const confirmOutcome = (outcome: "success" | "fail") => {
    if (disabled) return;
    onPendingOutcomeChange(null);
    onOutcome(outcome);
  };

  if (pendingOutcome === "success") {
    return (
      <div className={classes.outcomeActionGroup}>
        <div className={classes.outcomeButtons}>
          <button
            className={classes.outcomeConfirmButton}
            type="button"
            disabled={disabled}
            onClick={() => confirmOutcome("success")}
          >
            <AlignedText alignmentRole="action">{t("common.superSuccessYesConfirm")}</AlignedText>
          </button>
          <button
            className={classes.outcomeCancelButton}
            type="button"
            disabled={disabled}
            onClick={() => onPendingOutcomeChange(null)}
          >
            <AlignedText alignmentRole="action">{t("common.cancel")}</AlignedText>
          </button>
        </div>
        <OutcomeCaptionStage
          activeOutcome="success"
          failPreview={failPreview}
          successPreview={successPreview}
        />
      </div>
    );
  }

  if (pendingOutcome === "fail") {
    return (
      <div className={classes.outcomeActionGroup}>
        <div className={classes.outcomeButtons}>
          <button
            className={classes.outcomeCancelButton}
            type="button"
            disabled={disabled}
            onClick={() => onPendingOutcomeChange(null)}
          >
            <AlignedText alignmentRole="action">{t("common.cancel")}</AlignedText>
          </button>
          <button
            className={classes.outcomeConfirmButton}
            type="button"
            disabled={disabled}
            onClick={() => confirmOutcome("fail")}
          >
            <AlignedText alignmentRole="action">{t("common.superSuccessNoConfirm")}</AlignedText>
          </button>
        </div>
        <OutcomeCaptionStage
          activeOutcome="fail"
          failPreview={failPreview}
          successPreview={successPreview}
        />
      </div>
    );
  }

  return (
    <div className={classes.outcomeActionGroup}>
      <div className={classes.outcomeButtons}>
        <button
          className={`${classes.outcomeButton} ${classes.successButton}`}
          type="button"
          disabled={disabled}
          onClick={() => armOutcome("success")}
        >
          <AlignedText alignmentRole="action">{t("common.superSuccessYes")}</AlignedText>
        </button>
        <button
          className={`${classes.outcomeButton} ${classes.failButton}`}
          type="button"
          disabled={disabled}
          onClick={() => armOutcome("fail")}
        >
          <AlignedText alignmentRole="action">{t("common.superSuccessNo")}</AlignedText>
        </button>
      </div>
      <OutcomeCaptionStage
        activeOutcome={null}
        failPreview={failPreview}
        successPreview={successPreview}
      />
    </div>
  );
}

function ResultViewContent({
  onActionTransitionComplete,
  onConvert,
  onOutcome,
  onPendingOutcomeChange,
  outcomeDisabled,
  pendingOutcome,
  view,
}: Pick<
  ResultPanelProps,
  | "onActionTransitionComplete"
  | "onConvert"
  | "onOutcome"
  | "onPendingOutcomeChange"
  | "outcomeDisabled"
  | "pendingOutcome"
  | "view"
>) {
  const { formatInteger, t, text } = useI18n();
  const describeState = (state: CollectionState) => {
    const phase = `${state.grade} ${t("common.phase", { phase: state.level })}`;
    return state.exp > 0 ? `${phase} · EXP ${formatInteger(state.exp)}` : phase;
  };
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
    return (
      <div className={classes.resultContent}>
        <div className={classes.error}>
          {t(view.reason === "solver_failure" ? "result.solverError" : "result.noAction")}
        </div>
      </div>
    );
  }

  if (view.type === "convertRecommendation") {
    return (
      <div className={classes.resultContent}>
        <ConvertRecommendation onConvert={onConvert} />
      </div>
    );
  }

  if (view.type === "recommendation") {
    return (
      <div className={classes.resultContent}>
        <RecommendationBlock
          actionContent={
            <OutcomeActionButtons
              disabled={outcomeDisabled}
              failPreview={view.failPreview}
              pendingOutcome={pendingOutcome}
              successPreview={view.successPreview}
              onOutcome={onOutcome}
              onPendingOutcomeChange={onPendingOutcomeChange}
            />
          }
          kit={view.kit}
          count={view.count}
          outcomePending={pendingOutcome !== null}
          outcomeRing
          onTransitionComplete={onActionTransitionComplete}
          title={t("result.outcomeTitle")}
          {...(view.actionTransition ? { transition: view.actionTransition } : {})}
        >
          <p className={classes.changeNote}>{t("result.outcomePrompt")}</p>
        </RecommendationBlock>
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
      {view.canConvert ? <ConvertRecommendation onConvert={onConvert} /> : null}
    </div>
  );
}

export default function ResultPanel({
  feedback,
  isStale,
  needsStockEdit,
  staleSource,
  stockEditNotice,
  state,
  view,
  onActionTransitionComplete,
  onConvert,
  onOutcome,
  outcomeDisabled,
  pendingOutcome,
  onPendingOutcomeChange,
}: ResultPanelProps) {
  const { t, text } = useI18n();
  const showStaleOverlay = needsStockEdit || (isStale && view.type !== "empty");
  const staleMessage = needsStockEdit
    ? text(stockEditNotice)
    : t(staleSource === "stock" ? "result.staleStock" : "result.staleState");

  return (
    <section className={classes.panel}>
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
            onPendingOutcomeChange={onPendingOutcomeChange}
          />
        </div>
      </div>
    </section>
  );
}
