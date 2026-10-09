import { type CSSProperties, type ReactNode, useEffect, useLayoutEffect, useRef } from "react";
import { useI18n } from "../i18n/locale";
import type {
  OutcomePreview,
  RecommendationActionTransition,
  ResultKit,
  ResultView,
} from "../ui-types";
import { presentOutcomePreview } from "../view-models/outcomePresentation";
import { AlignedText } from "./AlignedText";
import { KIT_PANEL_LABEL_KEYS, RESULT_KIT_KEYS, resultKitDotClass } from "./kitPresentation";
import { STATE_FEEDBACK_VISIBLE_MS } from "./stateFeedbackAnimations";

const classes = {
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
          <span className={classes.actionChipNameMobile}>{t(KIT_PANEL_LABEL_KEYS[kit])}</span>
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

export type RecommendationProps = {
  view: Extract<ResultView, { type: "recommendation" | "convertRecommendation" }>;
  onActionTransitionComplete: (transitionId: number) => void;
  onConvert: () => void | Promise<void>;
  onOutcome: (outcome: "success" | "fail") => void;
  onPendingOutcomeChange: (outcome: "success" | "fail" | null) => void;
  outcomeDisabled: boolean;
  pendingOutcome: "success" | "fail" | null;
};
export default function RecommendationContent({
  view,
  onActionTransitionComplete,
  onConvert,
  onOutcome,
  onPendingOutcomeChange,
  outcomeDisabled,
  pendingOutcome,
}: RecommendationProps) {
  const { t } = useI18n();
  if (view.type === "convertRecommendation") return <ConvertRecommendation onConvert={onConvert} />;
  return (
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
  );
}
