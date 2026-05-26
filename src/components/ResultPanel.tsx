import type { CSSProperties, ReactNode } from "react";

import type { Kit } from "../types";
import type { RecommendationActionTransition, ResultKit, ResultView } from "../ui-types";
import { STATE_FEEDBACK_VISIBLE_MS } from "./stateFeedbackAnimations";

type ResultPanelProps = {
  view: ResultView;
  onConvert: () => void;
  onOutcome: (outcome: "success" | "fail") => void;
};

const KIT_LABELS: Record<ResultKit, string> = {
  blue: "초심자용 관리 키트",
  purple: "중급자용 관리 키트",
  yellow: "상급자용 관리 키트",
  convert: "SR 등급으로 교체",
};

const kitDotClass: Record<ResultKit, string> = {
  blue: "bg-blue-kit",
  purple: "bg-purple-kit",
  yellow: "bg-yellow-kit",
  convert: "bg-primary",
};

const classes = {
  panel:
    "panel result-panel col-span-full min-w-0 rounded-card border border-border bg-surface shadow-panel [contain:layout_paint] [transform:translateZ(0)] transition-[background-color,border-color,box-shadow] duration-[220ms]",
  heading:
    "section-heading flex items-center justify-between gap-3 border-b border-border px-[18px] py-4 transition-[border-color,background-color,color] duration-[220ms] max-mobile:px-3.5 max-mobile:py-[11px] max-mobile:[&_h2]:text-[16px]",
  emptyResult: "empty-result px-[18px] py-[22px] font-medium text-muted",
  resultContent:
    "result-content grid gap-3.5 p-[18px] max-mobile:gap-2.5 max-mobile:px-3.5 max-mobile:py-3",
  callout:
    "callout rounded-card bg-primary-soft px-3.5 py-[13px] font-bold leading-[1.45] text-primary-strong",
  error: "error rounded-card bg-danger-soft px-3.5 py-[13px] font-bold leading-[1.45] text-danger",
  recommendation:
    "recommendation grid grid-cols-[minmax(220px,0.36fr)_minmax(0,0.64fr)] items-stretch gap-3.5 max-tablet:grid-cols-1 max-mobile:gap-2.5",
  nextAction:
    "next-action relative grid min-h-[150px] overflow-hidden rounded-card bg-action p-[18px] text-center text-ice [perspective:900px] max-mobile:min-h-24 max-mobile:p-3",
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
    "action-chip-large inline-flex max-w-full flex-nowrap items-center justify-center gap-2.5 max-mobile:gap-2",
  actionChipText:
    "action-chip-text inline-flex min-w-0 items-baseline gap-0 whitespace-nowrap text-[clamp(23px,2.7vw,34px)] max-mobile:text-[clamp(18px,5vw,24px)]",
  actionChipName:
    "action-chip-name inline min-w-0 leading-[1.16] [overflow-wrap:break-word] [word-break:keep-all] max-mobile:[overflow-wrap:normal]",
  actionChipSeparator:
    "action-chip-separator inline min-w-0 whitespace-pre leading-[1.08] text-ice",
  actionChipCount: "action-chip-count inline min-w-0 leading-[1.08] text-ice",
  outcomePanel:
    "outcome-panel grid gap-2.5 rounded-card border-2 border-yellow-kit bg-outcome p-3.5 shadow-[0_12px_26px_rgba(128,89,11,0.12)] max-mobile:hidden",
  outcomeTitle:
    "m-0 flex items-center gap-2 text-[18px] text-outcome-text before:inline-block before:size-[11px] before:rounded-full before:bg-yellow-kit before:shadow-[0_0_0_4px_rgba(230,170,38,0.22)] before:content-['']",
  outcomeButtons: "outcome-buttons grid grid-cols-2 gap-2.5 max-mobile:gap-2",
  outcomeButton:
    "min-h-[50px] text-[16px] max-mobile:min-w-0 max-mobile:px-2 max-mobile:text-[13px] max-mobile:min-h-10",
  successButton: "success-button bg-yellow-kit text-success-button-text",
  failButton: "fail-button border border-border bg-button text-text-soft",
  convertButton: "convert-button bg-primary text-ice",
  changeNote:
    "change-note m-0 text-[13px] font-semibold leading-[1.45] text-muted max-mobile:text-[11.5px]",
} as const;

function ActionChip({
  kit,
  count,
  large = false,
}: {
  kit: ResultKit;
  count?: number;
  large?: boolean;
}) {
  const className = `${classes.actionChip} ${large ? classes.actionChipLarge : ""} ${
    kit === "convert" ? "" : kit
  }`;

  if (!large || kit === "convert") {
    return (
      <span className={className.trim()}>
        <i aria-hidden="true" className={`${classes.actionDot} ${kitDotClass[kit]}`}></i>
        {KIT_LABELS[kit]}
      </span>
    );
  }

  return (
    <span className={className}>
      <i
        aria-hidden="true"
        className={`${classes.actionDot} ${kitDotClass[kit]} shrink-0 self-center`}
      ></i>
      <span className={classes.actionChipText}>
        <span className={classes.actionChipName}>{KIT_LABELS[kit]}</span>
        <span className={classes.actionChipSeparator}>{"\u00a0×\u00a0"}</span>
        <span className={classes.actionChipCount}>{count || 1}회</span>
      </span>
    </span>
  );
}

function ActionCardContent({ count, kit }: { kit: ResultKit; count?: number }) {
  return (
    <div className={classes.nextInner}>
      <span className={classes.actionLabel}>{"\ucd94\ucc9c \ud589\ub3d9"}</span>
      <strong className={classes.nextStrong}>
        <ActionChip kit={kit} count={count} large={kit !== "convert"} />
      </strong>
    </div>
  );
}

function RecommendationBlock({
  kit,
  count = 1,
  title,
  children,
  transition,
}: {
  kit: ResultKit;
  count?: number;
  title: string;
  children: ReactNode;
  transition?: RecommendationActionTransition;
}) {
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
      <div className={classes.outcomePanel}>
        <h3 className={classes.outcomeTitle}>{title}</h3>
        {children}
      </div>
    </div>
  );
}
function ConvertRecommendation({ onConvert }: { onConvert: () => void }) {
  return (
    <RecommendationBlock kit="convert" title="등급 교체">
      <div className={classes.outcomeButtons}>
        <button
          className={`${classes.outcomeButton} ${classes.convertButton}`}
          type="button"
          data-convert="sr"
          onClick={onConvert}
        >
          교체 적용
        </button>
      </div>
    </RecommendationBlock>
  );
}

function renderView(
  view: ResultView,
  onConvert: () => void,
  onOutcome: (outcome: "success" | "fail") => void,
) {
  if (view.type === "empty") return <>{view.message}</>;

  if (view.type === "callout") {
    return (
      <div className={classes.resultContent}>
        <div className={classes.callout}>{view.message}</div>
      </div>
    );
  }

  if (view.type === "error") {
    return (
      <div className={classes.resultContent}>
        <div className={classes.error}>{view.message}</div>
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
          kit={view.kit}
          count={view.count}
          title={"\ub300\uc131\uacf5 \uc5ec\ubd80"}
          transition={view.actionTransition}
        >
          <p className={classes.changeNote}>
            다회 사용 중 대성공이 발생하면 몇 번째 사용에서 발생했는지 알 수 없으므로, 레벨만
            이동하고 보유 키트는 직접 수정해야 합니다.
          </p>
          <div className={classes.outcomeButtons}>
            <button
              className={`${classes.outcomeButton} ${classes.successButton}`}
              type="button"
              onClick={() => onOutcome("success")}
            >
              대성공 O
            </button>
            <button
              className={`${classes.outcomeButton} ${classes.failButton}`}
              type="button"
              onClick={() => onOutcome("fail")}
            >
              대성공 X
            </button>
          </div>
        </RecommendationBlock>
      </div>
    );
  }

  return (
    <div className={classes.resultContent}>
      <div className={classes.callout}>
        적용 완료: {KIT_LABELS[view.kit as Kit]} {view.count}회 사용, {view.outcomeLabel} 결과로{" "}
        {view.stateText}가 반영되었습니다. {view.stockMessage}
      </div>
      {view.showConvertRecommendation ? <ConvertRecommendation onConvert={onConvert} /> : null}
    </div>
  );
}

export default function ResultPanel({ view, onConvert, onOutcome }: ResultPanelProps) {
  return (
    <section className={classes.panel}>
      <div className={classes.heading}>
        <h2>결과</h2>
      </div>
      <div id="resultBox" className={view.type === "empty" ? classes.emptyResult : ""}>
        {renderView(view, onConvert, onOutcome)}
      </div>
    </section>
  );
}
