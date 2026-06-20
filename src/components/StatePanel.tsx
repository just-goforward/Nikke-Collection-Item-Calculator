import { useEffect, useState } from "react";

import { formatInteger } from "../format";
import type { Grade } from "../types";
import type { StateChangeFeedback, StatePanelModel } from "../ui-types";
import { stateFeedbackAnimations } from "./stateFeedbackAnimations";

const LEVEL_ROWS = [
  { label: "0~4", levels: [0, 1, 2, 3, 4] },
  { label: "5~9", levels: [5, 6, 7, 8, 9] },
  { label: "10~15", levels: [10, 11, 12, 13, 14, 15] },
];

const classes = {
  panel:
    "panel state-panel relative min-w-0 rounded-card border border-border bg-surface shadow-panel [contain:layout_paint] transition-[background-color,border-color,box-shadow] duration-[220ms]",
  feedbackRing: `pointer-events-none absolute inset-0 z-[1] rounded-card border-2 border-grade-active opacity-0 ${stateFeedbackAnimations.ring}`,
  feedbackBadge: `state-feedback-badge pointer-events-none ml-auto inline-flex shrink-0 items-center rounded-pill border border-grade-active bg-surface-raised px-2.5 py-1 text-[11px] font-semibold leading-none text-grade-active-strong shadow-[0_8px_18px_rgba(21,43,58,0.14)] ${stateFeedbackAnimations.badge}`,
  heading:
    "section-heading flex items-center justify-between gap-3 border-b border-border px-[18px] py-4 transition-[border-color,background-color,color] duration-[220ms] max-mobile:px-3.5 max-mobile:py-[11px] max-mobile:[&_h2]:text-[16px]",
  gradeRow:
    "grade-row grid grid-cols-2 gap-2 px-[18px] pb-2.5 pt-4 min-tablet-plus:max-desktop:px-3 min-tablet-plus:max-desktop:pb-2 min-tablet-plus:max-desktop:pt-3 max-mobile:gap-1.5 max-mobile:px-3 max-mobile:pb-1.5 max-mobile:pt-2",
  segmentButton:
    "seg-button min-h-10 border transition-[background-color,color,border-color,box-shadow,text-shadow,filter] duration-[220ms] min-tablet-plus:max-desktop:min-h-[34px] min-tablet-plus:max-desktop:text-[13px] max-mobile:min-h-[30px] max-mobile:px-2 max-mobile:py-0 max-mobile:text-[12.5px]",
  inactiveButton:
    "border-border bg-surface-strong text-muted [text-shadow:none] enabled:hover:border-grade-active-strong enabled:hover:text-text-soft enabled:hover:brightness-[0.98]",
  activeButton:
    "active border-[var(--control-active-bg)] bg-[var(--control-active-bg)] text-[var(--control-active-ink)] [text-shadow:none]",
  levelGrid:
    "level-grid grid min-w-0 gap-2 px-[18px] pb-3.5 min-tablet-plus:max-desktop:gap-1.5 min-tablet-plus:max-desktop:px-3 min-tablet-plus:max-desktop:pb-3 max-mobile:gap-[5px] max-mobile:px-3 max-mobile:pb-2",
  levelRow:
    "level-row grid min-w-0 items-center gap-2 min-tablet-plus:max-desktop:gap-[5px] max-mobile:gap-1",
  levelButton:
    "level-button relative min-h-10 min-w-0 whitespace-nowrap border px-2 text-[13px] leading-[1.1] transition-[background-color,color,border-color,box-shadow,text-shadow,filter] duration-[220ms] min-tablet-plus:max-desktop:min-h-[34px] min-tablet-plus:max-desktop:px-[3px] min-tablet-plus:max-desktop:text-[11px] max-mobile:min-h-[30px] max-mobile:px-0.5 max-mobile:py-0 max-mobile:text-[10.5px]",
  activeLevelButton: "z-[2] shadow-[0_0_0_3px_var(--grade-active-soft)]",
  feedbackTarget: stateFeedbackAnimations.target,
  expGrid:
    "field-grid exp-grid grid grid-cols-[minmax(0,1fr)_16px_minmax(0,1fr)] items-end gap-2.5 px-[18px] pb-4 pt-0 font-medium min-tablet-plus:max-desktop:px-3 max-mobile:grid-cols-[minmax(0,1fr)_12px_minmax(0,1fr)] max-mobile:gap-1.5 max-mobile:px-3 max-mobile:pb-[9px] max-mobile:pt-2",
  fieldControl: "grid gap-[7px]",
  fieldLabel: "text-[13px] font-medium text-muted max-mobile:text-[11px]",
  expInput: "max-mobile:min-h-[34px] max-mobile:px-[9px] max-mobile:py-1.5 max-mobile:text-[13px]",
  expDivider:
    "exp-divider grid min-h-[42px] place-items-center text-[18px] font-semibold text-muted max-mobile:min-h-[34px] max-mobile:text-[16px]",
  readonlyValue:
    "grid min-h-[42px] items-center rounded-control border border-border bg-surface-strong px-[11px] py-2.5 text-[15px] font-semibold text-text-strong max-mobile:min-h-[37.5px] max-mobile:px-[9px] max-mobile:py-2 max-mobile:text-[13px]",
} as const;

function stateButtonClass(active: boolean) {
  return `${classes.segmentButton} ${active ? classes.activeButton : classes.inactiveButton}`;
}

function levelButtonClass(active: boolean, highlight: boolean) {
  return `${classes.levelButton} ${
    active ? `${classes.activeButton} ${classes.activeLevelButton}` : classes.inactiveButton
  } ${highlight ? classes.feedbackTarget : ""}`;
}

type StatePanelProps = {
  feedback: StateChangeFeedback | null;
  state: StatePanelModel;
  onGradeChange: (grade: Grade) => void;
  onLevelChange: (level: number) => void;
  onExpChange: (exp: number) => void;
};

function levelButtonText(level: number) {
  if (level < 5) return `☆ ⸰ ⸰ ${level}`;
  if (level < 10) return `☆☆ ⸰ ${level}`;
  return `☆☆☆ ${level}`;
}

export default function StatePanel({
  feedback,
  state,
  onGradeChange,
  onLevelChange,
  onExpChange,
}: StatePanelProps) {
  const [expText, setExpText] = useState(String(state.exp));
  const feedbackActive = feedback?.to.grade === state.grade && feedback.to.level === state.level;

  useEffect(() => {
    setExpText(String(state.exp));
  }, [state.exp]);

  const maxExp = state.expDisabled ? 0 : Math.max(0, state.requiredExp - 100);

  return (
    <section className={classes.panel}>
      {feedbackActive ? (
        <span className={classes.feedbackRing} key={`ring-${feedback.id}`} aria-hidden="true" />
      ) : null}
      <div className={classes.heading}>
        <h2>현재 소장품</h2>
        {feedbackActive ? (
          <span className={classes.feedbackBadge} key={feedback.id} role="status">
            {feedback.label}
          </span>
        ) : null}
      </div>

      {/* biome-ignore lint/a11y/useSemanticElements: Existing CSS and Playwright smoke tests use this grouped control contract. */}
      <div className={classes.gradeRow} role="group" aria-label="소장품 등급">
        <button
          className={`${stateButtonClass(state.grade === "R")} ${
            feedbackActive && feedback.type === "grade" && feedback.to.grade === "R"
              ? classes.feedbackTarget
              : ""
          }`}
          type="button"
          data-grade="R"
          aria-pressed={state.grade === "R"}
          onClick={() => onGradeChange("R")}
        >
          R
        </button>
        <button
          className={`${stateButtonClass(state.grade === "SR")} ${
            feedbackActive && feedback.type === "grade" && feedback.to.grade === "SR"
              ? classes.feedbackTarget
              : ""
          }`}
          type="button"
          data-grade="SR"
          aria-pressed={state.grade === "SR"}
          onClick={() => onGradeChange("SR")}
        >
          SR
        </button>
      </div>

      {/* biome-ignore lint/a11y/useSemanticElements: Existing CSS and Playwright smoke tests use this grouped control contract. */}
      <div id="levelGrid" className={classes.levelGrid} role="group" aria-label="현재 단계">
        {LEVEL_ROWS.map((row) => (
          <div
            className={classes.levelRow}
            key={row.label}
            style={{ gridTemplateColumns: `repeat(${row.levels.length}, minmax(0, 1fr))` }}
          >
            {row.levels.map((level) => (
              <button
                className={levelButtonClass(
                  level === state.level,
                  Boolean(feedbackActive && level === state.level),
                )}
                data-level={level}
                type="button"
                aria-label={`${level}단계`}
                aria-pressed={level === state.level}
                key={level}
                onClick={() => onLevelChange(level)}
              >
                {levelButtonText(level)}
              </button>
            ))}
          </div>
        ))}
      </div>

      <div className={classes.expGrid}>
        <label className={classes.fieldControl}>
          <span className={classes.fieldLabel}>현재 경험치</span>
          <input
            id="currentExp"
            className={classes.expInput}
            type="number"
            min="0"
            max={maxExp}
            step="100"
            inputMode="numeric"
            value={expText}
            disabled={state.expDisabled}
            onChange={(event) => setExpText(event.currentTarget.value)}
            onBlur={() => onExpChange(Number(expText) || 0)}
          />
        </label>
        <div className={classes.expDivider} aria-hidden="true">
          /
        </div>
        <div className={`readonly-field ${classes.fieldControl}`}>
          <span className={classes.fieldLabel}>레벨업 필요 경험치</span>
          <strong id="requiredExpLabel" className={classes.readonlyValue}>
            {formatInteger(state.requiredExp)}
          </strong>
        </div>
      </div>
    </section>
  );
}
