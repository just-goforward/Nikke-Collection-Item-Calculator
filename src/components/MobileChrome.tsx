import type { ReactNode } from "react";

import { formatInteger } from "../format";
import type { Kit, Stock } from "../types";
import type { LoadingView, ResultView, StateChangeFeedback, StatePanelModel } from "../ui-types";
import { stateFeedbackAnimations } from "./stateFeedbackAnimations";

export type MobileTab = "input" | "result" | "stats";

type StatusKit = {
  kit: Kit;
  className: string;
  dotClassName: string;
};

const MOBILE_ACTION_LABEL = "모바일 작업";

const MOBILE_TABS: Array<{ id: MobileTab; label: string }> = [
  { id: "input", label: "입력" },
  { id: "result", label: "결과" },
  { id: "stats", label: "통계" },
];

const MOBILE_TAB_PANELS: Record<MobileTab, string> = {
  input: "mobile-panel-input",
  result: "mobile-panel-result",
  stats: "mobile-panel-stats",
};

const STATUS_KITS: StatusKit[] = [
  { kit: "blue", className: "kit-dot blue-kit", dotClassName: "bg-blue-kit" },
  { kit: "purple", className: "kit-dot purple-kit", dotClassName: "bg-purple-kit" },
  { kit: "yellow", className: "kit-dot yellow-kit", dotClassName: "bg-yellow-kit" },
];

const classes = {
  statusStrip:
    "mobile-status-strip relative -mx-2.5 grid grid-cols-1 gap-1.5 border-b border-border bg-surface px-3 pt-2.5 pb-2",
  statusStripFeedback: stateFeedbackAnimations.panel,
  statusFeedbackBadge: `state-feedback-badge pointer-events-none inline-flex shrink-0 items-center self-center rounded-pill border border-grade-active bg-surface-raised px-2 py-1 text-[10.5px] font-semibold leading-none text-grade-active-strong shadow-[0_8px_18px_rgba(21,43,58,0.14)] ${stateFeedbackAnimations.badge}`,
  statusState: "status-state flex min-w-0 items-center gap-2",
  statusGrade:
    "status-grade inline-flex w-[38px] min-w-[38px] flex-[0_0_38px] items-center justify-center rounded-[5px] bg-[var(--control-active-bg)] px-2 py-[3px] text-xs font-bold tracking-[0.04em] text-[var(--control-active-ink)] [text-shadow:none]",
  statusGradeFeedback: stateFeedbackAnimations.target,
  statusLevel:
    "status-level text-[15px] font-semibold text-text-strong [font-variant-numeric:tabular-nums]",
  statusLevelFeedback: stateFeedbackAnimations.text,
  statusDivider: "status-divider font-semibold text-border",
  statusExpText:
    "status-exp-text min-w-0 flex-1 overflow-hidden text-ellipsis whitespace-nowrap text-right text-xs font-medium text-muted [font-variant-numeric:tabular-nums]",
  statusExpBar: "status-exp-bar h-[5px] w-full overflow-hidden rounded-pill bg-surface-strong",
  statusExpFill:
    "status-exp-fill h-full rounded-pill bg-grade-active transition-[width] duration-[220ms] ease-[ease]",
  statusStock:
    "status-stock mt-0.5 mb-0 grid list-none grid-cols-3 gap-1 border-t border-dashed border-border p-0 pt-1.5",
  statusKit:
    "inline-flex items-center justify-center gap-1.5 text-[12.5px] font-semibold text-text-soft [font-variant-numeric:tabular-nums] max-phone-xs:text-xs",
  statusKitDot: "inline-block size-2.5 rounded-full",
  tabs: "mobile-tabs grid grid-cols-3 gap-0 border-t border-border bg-transparent px-1",
  tab: "mobile-tab relative min-h-[46px] cursor-pointer border-0 bg-transparent px-1.5 py-0 text-[13px] font-semibold tracking-[0.01em] text-muted transition-colors duration-160 ease-[ease] hover:text-text-soft max-phone-xs:text-xs",
  tabActive:
    "active text-grade-active-strong before:absolute before:top-[-1px] before:left-[22%] before:right-[22%] before:h-[2.5px] before:rounded-pill before:bg-grade-active before:content-['']",
  tabDot:
    "mobile-tab-dot absolute top-[9px] right-[calc(50%_-_32px)] size-1.5 rounded-full bg-grade-active not-italic",
  actionBar:
    "mobile-action-bar grid grid-cols-1 gap-2 border-0 bg-transparent px-3 pt-2.5 pb-2.5 shadow-none",
  actionBarCalculate: "mode-calculate grid-cols-[84px_1fr]",
  actionBarOutcome: "mode-outcome grid-cols-2",
  actionBarConvert: "mode-convert grid-cols-1",
  actionPrompt:
    "mobile-action-prompt col-span-full text-center text-[13px] font-semibold leading-[1.3] text-outcome-text",
  actionChangeNote:
    "change-note col-span-full m-0 text-center text-[11.5px] font-medium leading-[1.45] text-muted",
  actionButton:
    "min-h-12 rounded-card text-[15px] font-bold tracking-[0.01em] max-phone-xs:min-h-12 max-phone-xs:text-sm",
  primaryButton:
    "primary-button bg-action text-ice shadow-[inset_0_0_0_1px_rgba(248,252,254,0.10),0_10px_22px_rgba(21,43,58,0.18)] transition-[filter,box-shadow,transform,background-color] duration-[140ms] enabled:hover:brightness-[1.08] enabled:hover:shadow-[inset_0_0_0_1px_rgba(248,252,254,0.16),0_12px_26px_rgba(21,43,58,0.24)] enabled:active:translate-y-px enabled:active:shadow-[inset_0_0_0_1px_rgba(248,252,254,0.12),0_4px_10px_rgba(21,43,58,0.18)] [body.theme-dark_&]:bg-[#ee7a87] [body.theme-dark_&]:text-[#2a0c12] [body.theme-dark_&]:shadow-[inset_0_0_0_1px_rgba(255,255,255,0.22),0_10px_22px_rgba(0,0,0,0.45)] [body.theme-dark_&]:enabled:hover:bg-[#f48f99] [body.theme-dark_&]:enabled:hover:brightness-100 [body.theme-dark_&]:enabled:hover:shadow-[inset_0_0_0_1px_rgba(255,255,255,0.28),0_12px_26px_rgba(0,0,0,0.55)] [body.theme-dark_&]:enabled:active:bg-[#d6646f] [body.theme-dark_&]:enabled:active:shadow-[inset_0_0_0_1px_rgba(255,255,255,0.22),0_4px_10px_rgba(0,0,0,0.4)]",
  resetButton:
    "reset-button border border-border bg-button text-[13px] font-bold text-text-soft transition-[background-color,color,border-color] duration-160 ease-[ease] hover:bg-surface-strong hover:text-text-strong",
  outcomeButton: "border border-border",
  successButton: "bg-yellow-kit text-success-button-text",
  failButton: "bg-button text-text-soft",
  convertButton: "bg-primary text-ice",
  stockEditDisabled:
    "disabled:opacity-100 disabled:border-2 disabled:border-yellow-kit disabled:bg-warning-soft disabled:text-warning disabled:shadow-[0_0_0_3px_rgba(230,170,38,0.22)]",
} as const;

type MobileActionBarProps = {
  view: ResultView;
  loading: LoadingView;
  calculateDisabled: boolean;
  needsStockEdit: boolean;
  onCalculate: () => void;
  onReset: () => void;
  onConvert: () => void;
  onOutcome: (outcome: "success" | "fail") => void;
};

type MobileStatusStripProps = {
  feedback: StateChangeFeedback | null;
  state: StatePanelModel;
  stock: Stock;
};

type MobileTabsProps = {
  active: MobileTab;
  hasResult: boolean;
  onChange: (tab: MobileTab) => void;
};

function MobileToolbar({ children, mode }: { children: ReactNode; mode: string }) {
  const modeClass = mode.includes("mode-outcome")
    ? classes.actionBarOutcome
    : mode.includes("mode-convert")
      ? classes.actionBarConvert
      : classes.actionBarCalculate;

  return (
    <div
      className={`${classes.actionBar} ${modeClass} ${mode}`}
      role="toolbar"
      aria-label={MOBILE_ACTION_LABEL}
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

function calculateProgressPercent(state: StatePanelModel) {
  const required = state.expDisabled ? 0 : state.requiredExp;
  if (required <= 0) return 100;
  return Math.min(100, Math.max(0, Math.round((state.exp / required) * 100)));
}

function expSummaryText(state: StatePanelModel) {
  const required = state.expDisabled ? 0 : state.requiredExp;
  if (required <= 0) return "최대 레벨";
  return `${formatInteger(state.exp)} / ${formatInteger(required)}`;
}

function StatusStockList({ stock }: { stock: Stock }) {
  return (
    <ul className={classes.statusStock} aria-label="보유 키트">
      {STATUS_KITS.map((item) => (
        <li className={`${item.className} ${classes.statusKit}`} key={item.kit}>
          <i aria-hidden="true" className={`${classes.statusKitDot} ${item.dotClassName}`}></i>
          {formatInteger(stock[item.kit])}
        </li>
      ))}
    </ul>
  );
}

export function MobileActionBar({
  view,
  loading,
  calculateDisabled,
  needsStockEdit,
  onCalculate,
  onReset,
  onConvert,
  onOutcome,
}: MobileActionBarProps) {
  if (view.type === "recommendation") {
    return (
      <MobileToolbar mode="mode-outcome">
        <span className={classes.actionPrompt}>대성공 여부를 선택하세요</span>
        {view.count > 1 ? (
          <p className={classes.actionChangeNote}>
            다회 사용 중 대성공이 발생하면 몇 번째 사용에서 발생했는지 알 수 없으므로, 레벨만
            이동하고 보유 키트는 직접 수정해야 합니다.
          </p>
        ) : null}
        <button
          className={`${classes.actionButton} ${classes.outcomeButton} ${classes.failButton} fail-button`}
          type="button"
          onClick={() => onOutcome("fail")}
        >
          대성공 X
        </button>
        <button
          className={`${classes.actionButton} ${classes.outcomeButton} ${classes.successButton} success-button`}
          type="button"
          onClick={() => onOutcome("success")}
        >
          대성공 O
        </button>
      </MobileToolbar>
    );
  }

  if (
    view.type === "convertRecommendation" ||
    (view.type === "outcome" && view.showConvertRecommendation)
  ) {
    return (
      <MobileToolbar mode="mode-convert">
        <button
          className={`${classes.actionButton} ${classes.outcomeButton} ${classes.convertButton} convert-button`}
          type="button"
          aria-label="SR 등급으로 교체"
          onClick={onConvert}
        >
          교체 적용
        </button>
      </MobileToolbar>
    );
  }

  return (
    <MobileToolbar mode={needsStockEdit ? "mode-calculate needs-stock-edit" : "mode-calculate"}>
      <button
        className={`${classes.actionButton} ${classes.resetButton}`}
        type="button"
        onClick={onReset}
      >
        초기화
      </button>
      <button
        className={`${classes.actionButton} ${classes.primaryButton} ${
          needsStockEdit ? classes.stockEditDisabled : ""
        }`}
        type="button"
        disabled={calculateDisabled || loading.active}
        onPointerDown={commitFocusedInput}
        onClick={onCalculate}
      >
        {needsStockEdit ? "키트 수정 필요" : loading.active ? "계산 중" : "계산하기"}
      </button>
    </MobileToolbar>
  );
}

export function MobileStatusStrip({ feedback, state, stock }: MobileStatusStripProps) {
  const progress = calculateProgressPercent(state);
  const feedbackActive = feedback?.to.grade === state.grade && feedback.to.level === state.level;

  return (
    <div
      className={`${classes.statusStrip} ${feedbackActive ? classes.statusStripFeedback : ""}`}
      role="status"
      aria-live="polite"
    >
      <div className={classes.statusState}>
        <span
          className={`${classes.statusGrade} grade-${state.grade.toLowerCase()} ${
            feedbackActive && feedback.type === "grade" ? classes.statusGradeFeedback : ""
          }`}
        >
          {state.grade}
        </span>
        <span
          className={`${classes.statusLevel} ${feedbackActive ? classes.statusLevelFeedback : ""}`}
        >
          Lv {state.level}
        </span>
        <span className={classes.statusDivider} aria-hidden="true">
          /
        </span>
        {feedbackActive ? (
          <span className={classes.statusFeedbackBadge} key={feedback.id}>
            {feedback.label}
          </span>
        ) : null}
        <span className={classes.statusExpText}>{expSummaryText(state)}</span>
      </div>
      <div className={classes.statusExpBar} aria-hidden="true">
        <div className={classes.statusExpFill} style={{ width: `${progress}%` }} />
      </div>
      <StatusStockList stock={stock} />
    </div>
  );
}

export function MobileTabs({ active, hasResult, onChange }: MobileTabsProps) {
  return (
    <div className={classes.tabs} role="tablist" aria-label="화면 전환">
      {MOBILE_TABS.map((tab) => (
        <button
          className={active === tab.id ? `${classes.tab} ${classes.tabActive}` : classes.tab}
          aria-controls={MOBILE_TAB_PANELS[tab.id]}
          key={tab.id}
          type="button"
          id={`mobile-tab-${tab.id}`}
          role="tab"
          aria-selected={active === tab.id}
          onClick={() => onChange(tab.id)}
        >
          <span>{tab.label}</span>
          {tab.id === "result" && hasResult ? (
            <em className={classes.tabDot} aria-hidden="true" />
          ) : null}
        </button>
      ))}
    </div>
  );
}
