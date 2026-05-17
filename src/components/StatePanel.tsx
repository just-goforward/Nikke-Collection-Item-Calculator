import { useEffect, useState } from "react";

import { formatInteger } from "../format";
import type { Grade } from "../types";
import type { StatePanelModel } from "../ui-types";

const LEVEL_ROWS = [
  { label: "1~5", levels: [1, 2, 3, 4, 5] },
  { label: "6~10", levels: [6, 7, 8, 9, 10] },
  { label: "11~15", levels: [11, 12, 13, 14, 15] },
];

type StatePanelProps = {
  state: StatePanelModel;
  onGradeChange: (grade: Grade) => void;
  onLevelChange: (level: number) => void;
  onExpChange: (exp: number) => void;
};

function levelButtonText(level: number) {
  if (level <= 5) return `☆ ⸰ ⸰ ${level}`;
  if (level <= 10) return `☆☆ ⸰ ${level}`;
  return `☆☆☆ ${level}`;
}

export default function StatePanel({
  state,
  onGradeChange,
  onLevelChange,
  onExpChange,
}: StatePanelProps) {
  const [expText, setExpText] = useState(String(state.exp));

  useEffect(() => {
    setExpText(String(state.exp));
  }, [state.exp]);

  const maxExp = state.expDisabled ? 0 : Math.max(0, state.requiredExp - 100);

  return (
    <section className="panel state-panel">
      <div className="section-heading">
        <h2>현재 소장품</h2>
      </div>

      {/* biome-ignore lint/a11y/useSemanticElements: Existing CSS and Playwright smoke tests use this grouped control contract. */}
      <div className="grade-row" role="group" aria-label="소장품 등급">
        <button
          className={state.grade === "R" ? "seg-button active" : "seg-button"}
          type="button"
          data-grade="R"
          aria-pressed={state.grade === "R"}
          onClick={() => onGradeChange("R")}
        >
          R
        </button>
        <button
          className={state.grade === "SR" ? "seg-button active" : "seg-button"}
          type="button"
          data-grade="SR"
          aria-pressed={state.grade === "SR"}
          onClick={() => onGradeChange("SR")}
        >
          SR
        </button>
      </div>

      {/* biome-ignore lint/a11y/useSemanticElements: Existing CSS and Playwright smoke tests use this grouped control contract. */}
      <div id="levelGrid" className="level-grid" role="group" aria-label="현재 단계">
        {LEVEL_ROWS.map((row) => (
          <div className="level-row" key={row.label}>
            <span>{row.label}</span>
            {row.levels.map((level) => (
              <button
                className={level === state.level ? "level-button active" : "level-button"}
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

      <div className="field-grid exp-grid">
        <label>
          <span>현재 경험치</span>
          <input
            id="currentExp"
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
        <div className="exp-divider" aria-hidden="true">
          /
        </div>
        <div className="readonly-field">
          <span>레벨업 필요 경험치</span>
          <strong id="requiredExpLabel">{formatInteger(state.requiredExp)}</strong>
        </div>
      </div>
    </section>
  );
}
