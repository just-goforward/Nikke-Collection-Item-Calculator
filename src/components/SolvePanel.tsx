import type { Strategy } from "../types";

type SolvePanelProps = {
  strategy: Strategy;
  description: string;
  calculateDisabled: boolean;
  onStrategyChange: (strategy: Strategy) => void;
  onCalculate: () => void;
  onReset: () => void;
};

export default function SolvePanel({
  strategy,
  description,
  calculateDisabled,
  onStrategyChange,
  onCalculate,
  onReset,
}: SolvePanelProps) {
  return (
    <section className="panel solve-panel">
      <div className="section-heading">
        <h2>계산</h2>
      </div>

      {/* biome-ignore lint/a11y/useSemanticElements: Existing CSS uses this segmented control contract. */}
      <div className="strategy-control" role="group" aria-label="최적화 방식">
        <button
          className={strategy === "single" ? "strategy-button active" : "strategy-button"}
          type="button"
          data-strategy="single"
          aria-pressed={strategy === "single"}
          onClick={() => onStrategyChange("single")}
        >
          단일 목표
        </button>
        <button
          className={strategy === "supply" ? "strategy-button active" : "strategy-button"}
          type="button"
          data-strategy="supply"
          aria-pressed={strategy === "supply"}
          onClick={() => onStrategyChange("supply")}
        >
          수급량 고려
        </button>
      </div>

      <div id="strategyDescription" className="solve-note">
        {description}
      </div>

      <div className="button-row">
        <button
          id="calculateButton"
          className="primary-button"
          type="button"
          disabled={calculateDisabled}
          onClick={onCalculate}
        >
          계산
        </button>
        <button id="resetButton" className="secondary-button" type="button" onClick={onReset}>
          초기화
        </button>
      </div>
    </section>
  );
}
