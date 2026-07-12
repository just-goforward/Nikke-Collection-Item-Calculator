import { useEffect, useState } from "react";

import { formatInteger } from "../format";
import type { Grade } from "../types";
import type { StatePanelModel } from "../ui-types";

const LEVEL_ROWS = [
  { label: "0~4", levels: [0, 1, 2, 3, 4] },
  { label: "5~9", levels: [5, 6, 7, 8, 9] },
  { label: "10~15", levels: [10, 11, 12, 13, 14, 15] },
];

const classes = {
  panel:
    "panel state-panel relative min-w-0 rounded-card border border-border bg-surface shadow-panel [contain:layout_paint] transition-[background-color,border-color,box-shadow] duration-[220ms]",
  staleOverlay:
    "pointer-events-auto absolute inset-0 z-[4] rounded-card bg-[rgba(255,255,255,0.45)] [body.theme-dark_&]:bg-[rgba(10,12,14,0.55)]",
  heading:
    "section-heading flex items-center justify-between gap-3 border-b border-border px-[18px] py-4 transition-[border-color,background-color,color] duration-[220ms] max-mobile:px-3.5 max-mobile:py-[11px] max-mobile:[&_h2]:text-[16px]",
  gradeRow:
    "grade-row grid grid-cols-[42px_repeat(2,minmax(0,1fr))] gap-[5px] px-[18px] pb-2.5 pt-4 max-mobile:grid-cols-[28px_repeat(2,minmax(0,1fr))] max-mobile:gap-1.5 max-mobile:px-3 max-mobile:pb-1.5 max-mobile:pt-2",
  segmentButton:
    "seg-button min-h-10 border transition-[background-color,color,border-color,box-shadow,text-shadow,filter] duration-[220ms] max-mobile:min-h-[30px] max-mobile:px-2 max-mobile:py-0 max-mobile:text-[12.5px]",
  inactiveButton:
    "border-border bg-surface-strong text-muted [text-shadow:none] enabled:hover:border-grade-active-strong enabled:hover:text-text-soft enabled:hover:brightness-[0.98]",
  activeButton:
    "active border-[var(--control-active-bg)] bg-[var(--control-active-bg)] text-[var(--control-active-ink)] [text-shadow:none]",
  levelGrid:
    "level-grid grid min-w-0 gap-[6px] px-[18px] pb-3.5 max-mobile:gap-[5px] max-mobile:px-3 max-mobile:pb-2",
  levelRow:
    "level-row grid min-w-0 grid-cols-[42px_repeat(6,minmax(0,1fr))] items-center gap-[5px] max-mobile:grid-cols-[28px_repeat(6,minmax(0,1fr))] max-mobile:gap-1",
  levelRowLabel:
    "whitespace-nowrap text-[11px] font-bold leading-none text-muted max-mobile:text-[10px]",
  levelButton:
    "level-button relative min-h-9 min-w-0 whitespace-nowrap border px-2 text-[13px] font-bold leading-[1.1] transition-[background-color,color,border-color,box-shadow,text-shadow,filter] duration-[220ms] max-mobile:min-h-[30px] max-mobile:px-0.5 max-mobile:py-0 max-mobile:text-[10.5px]",
  activeLevelButton: "z-[2] shadow-[0_0_0_3px_var(--grade-active-soft)]",
  expGrid:
    "field-grid exp-grid grid grid-cols-[minmax(0,1fr)_16px_minmax(0,1fr)] items-end gap-2.5 border-t border-border px-[18px] pb-4 pt-3.5 font-medium max-mobile:grid-cols-[minmax(0,1fr)_12px_minmax(0,1fr)] max-mobile:gap-1.5 max-mobile:px-3 max-mobile:pb-[9px] max-mobile:pt-2",
  fieldControl: "grid gap-[7px]",
  fieldLabel: "text-[13px] font-medium text-muted max-mobile:text-[11px]",
  expInput:
    "text-center text-[15px] font-semibold tabular-nums text-text-strong placeholder:text-text-strong/75 focus:placeholder:text-transparent min-[661px]:min-h-9 min-[661px]:px-[10px] min-[661px]:py-[6px] min-[661px]:text-[14px] max-mobile:min-h-[34px] max-mobile:px-[9px] max-mobile:py-1.5 max-mobile:text-[13px]",
  expDivider:
    "exp-divider grid min-h-[42px] place-items-center text-[18px] font-semibold text-muted min-[661px]:min-h-9 max-mobile:min-h-[34px] max-mobile:text-[16px]",
  readonlyValue:
    "grid min-h-[42px] items-center rounded-control border border-border bg-surface-strong px-[11px] py-2.5 text-center text-[15px] font-semibold text-text-strong min-[661px]:min-h-9 min-[661px]:px-[10px] min-[661px]:py-[6px] min-[661px]:text-[14px] max-mobile:min-h-[34px] max-mobile:px-[9px] max-mobile:py-1.5 max-mobile:text-[13px]",
} as const;

function stateButtonClass(active: boolean) {
  return `${classes.segmentButton} ${active ? classes.activeButton : classes.inactiveButton}`;
}

function levelButtonClass(active: boolean) {
  return `${classes.levelButton} ${
    active ? `${classes.activeButton} ${classes.activeLevelButton}` : classes.inactiveButton
  }`;
}

type StatePanelProps = {
  disabled?: boolean;
  state: StatePanelModel;
  onGradeChange: (grade: Grade) => void;
  onLevelChange: (level: number) => void;
  onExpChange: (exp: number) => void;
};

function levelRowLabel(index: number) {
  if (index === 0) return "☆";
  if (index === 1) return "☆☆";
  return "☆☆☆";
}

function GradeSelector({
  disabled,
  state,
  onGradeChange,
}: Pick<StatePanelProps, "disabled" | "state" | "onGradeChange">) {
  return (
    // biome-ignore lint/a11y/useSemanticElements: Existing CSS and Playwright smoke tests use this grouped control contract.
    <div className={classes.gradeRow} role="group" aria-label="소장품 등급">
      <span aria-hidden="true" />
      {(["R", "SR"] as const).map((grade) => (
        <button
          className={stateButtonClass(state.grade === grade)}
          type="button"
          data-grade={grade}
          aria-pressed={state.grade === grade}
          disabled={disabled}
          key={grade}
          onClick={() => onGradeChange(grade)}
        >
          {grade}
        </button>
      ))}
    </div>
  );
}

function LevelSelector({
  disabled,
  state,
  onLevelChange,
}: Pick<StatePanelProps, "disabled" | "state" | "onLevelChange">) {
  return (
    // biome-ignore lint/a11y/useSemanticElements: Existing CSS and Playwright smoke tests use this grouped control contract.
    <div id="levelGrid" className={classes.levelGrid} role="group" aria-label="현재 단계">
      {LEVEL_ROWS.map((row, rowIndex) => (
        <div className={classes.levelRow} key={row.label}>
          <span className={classes.levelRowLabel} aria-hidden="true">
            {levelRowLabel(rowIndex)}
          </span>
          {row.levels.map((level) => (
            <button
              className={levelButtonClass(level === state.level)}
              data-level={level}
              type="button"
              aria-label={`${level}단계`}
              aria-pressed={level === state.level}
              disabled={disabled}
              key={level}
              onClick={() => onLevelChange(level)}
            >
              {level}
            </button>
          ))}
        </div>
      ))}
    </div>
  );
}

export default function StatePanel({
  disabled = false,
  state,
  onGradeChange,
  onLevelChange,
  onExpChange,
}: StatePanelProps) {
  const [expText, setExpText] = useState(expValueToText(state.exp));

  useEffect(() => {
    setExpText(expValueToText(state.exp));
  }, [state.exp]);

  const maxExp = state.expDisabled ? 0 : Math.max(0, state.requiredExp - 100);
  const updateExpText = (value: string) => {
    const nextText = sanitizeExpText(value);
    setExpText(nextText);
    onExpChange(normalizeExpText(nextText, maxExp));
  };

  return (
    <section className={classes.panel} aria-disabled={disabled}>
      {disabled ? <span className={classes.staleOverlay} aria-hidden="true" /> : null}
      <div className={classes.heading}>
        <h2>현재 소장품</h2>
      </div>

      <GradeSelector disabled={disabled} state={state} onGradeChange={onGradeChange} />
      <LevelSelector disabled={disabled} state={state} onLevelChange={onLevelChange} />

      <div className={classes.expGrid}>
        <label className={classes.fieldControl}>
          <span className={classes.fieldLabel}>현재 경험치</span>
          <input
            id="currentExp"
            className={classes.expInput}
            type="text"
            inputMode="numeric"
            pattern="[0-9]*"
            autoComplete="off"
            placeholder="0"
            value={expText}
            disabled={disabled || state.expDisabled}
            onChange={(event) => updateExpText(event.currentTarget.value)}
            onBlur={() => {
              const normalized = normalizeExpText(expText, maxExp);
              setExpText(expValueToText(normalized));
              onExpChange(normalized);
            }}
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

function expValueToText(value: number) {
  return value > 0 ? String(value) : "";
}

function sanitizeExpText(value: string) {
  return value.replace(/\D/g, "");
}

function normalizeExpText(value: string, maxExp: number) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) return 0;
  const stepped = Math.floor(Math.max(0, numeric) / 100) * 100;
  return Math.min(stepped, maxExp);
}
