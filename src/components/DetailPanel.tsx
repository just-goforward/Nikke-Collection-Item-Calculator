import type { Kit } from "../types";
import type { DetailView, ValidationView } from "../ui-types";

type DetailPanelProps = {
  view: DetailView;
  validation: ValidationView;
  onRunValidation: () => void;
};

const KIT_LABELS: Record<Kit, string> = {
  blue: "초심자용 관리 키트",
  purple: "중급자용 관리 키트",
  yellow: "상급자용 관리 키트",
};

function KitChip({ kit, count }: { kit: Kit; count: number }) {
  return (
    <span className={`action-chip ${kit}`}>
      <i></i>
      <span className="action-chip-text">
        <span className="action-chip-name">{KIT_LABELS[kit]}</span>
        <span className="action-chip-count">{count}회</span>
      </span>
    </span>
  );
}

function InfoTip({ label, children }: { label: string; children: string }) {
  return (
    <button className="info-tip" type="button" aria-label={`${label} 설명`}>
      i<span>{children}</span>
    </button>
  );
}

function MetricsDetail({
  view,
  validation,
  onRunValidation,
}: {
  view: Extract<DetailView, { type: "metrics" }>;
  validation: ValidationView;
  onRunValidation: () => void;
}) {
  return (
    <div className="result-content">
      <div className="metric-grid">
        <div className="metric">
          <span>선택 전략</span>
          <strong>{view.strategyLabel}</strong>
        </div>
        <div className="metric">
          <span className="metric-label">
            SR 15 도달 확률
            <InfoTip label="SR 15 도달 확률">
              현재 보유 키트와 현재 상태에서, 앞으로도 이 전략이 고른 행동을 계속 따른다고 할 때
              최종 목표인 SR 15에 도달할 확률입니다.
            </InfoTip>
          </span>
          <strong>{view.successProbability}</strong>
        </div>
        <div className="metric">
          <span>구간 대성공 확률</span>
          <strong>{view.greatSuccessProbability}</strong>
        </div>
        <div className="metric">
          <span className="metric-label">
            정확 계산 상태 수
            <InfoTip label="정확 계산 상태 수">
              MDP가 실제로 평가한 등급, 레벨, 경험치, 남은 키트 사용 가능 횟수 조합의 개수입니다.
            </InfoTip>
          </span>
          <strong>{view.stateCount}</strong>
        </div>
      </div>

      <div className="table-wrap">
        <table>
          <thead>
            <tr>
              <th>후보</th>
              <th>첫 행동</th>
              <th>SR 15 도달 확률</th>
            </tr>
          </thead>
          <tbody>
            {view.candidates.map((candidate) => (
              <tr
                key={`${candidate.rankLabel}-${candidate.kit}-${candidate.count}-${candidate.successProbability}`}
              >
                <td>{candidate.rankLabel}</td>
                <td>
                  <KitChip kit={candidate.kit} count={candidate.count} />
                </td>
                <td>{candidate.successProbability}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <details className="validation-details">
        <summary>가상의 니붕이로 검증해보기</summary>
        <div className="validation-content">
          <p>
            가상의 니붕이 {view.monteCarloRuns}명을 동일한 조건에서 시도시켜, 계산 결과와 비슷한지
            확인해보는 기능입니다.
          </p>
          <button
            className="secondary-button validation-button"
            type="button"
            disabled={validation.disabled}
            onClick={onRunValidation}
          >
            {validation.buttonLabel}
          </button>
          <p className="validation-result" data-validation-result>
            {validation.message}
          </p>
        </div>
      </details>
    </div>
  );
}

export default function DetailPanel({ view, validation, onRunValidation }: DetailPanelProps) {
  return (
    <section className="panel detail-panel">
      <div className="section-heading">
        <h2>세부 정보</h2>
      </div>
      <div id="detailBox" className={view.type === "empty" ? "empty-result" : ""}>
        {view.type === "empty" ? (
          view.message
        ) : (
          <MetricsDetail view={view} validation={validation} onRunValidation={onRunValidation} />
        )}
      </div>
    </section>
  );
}
