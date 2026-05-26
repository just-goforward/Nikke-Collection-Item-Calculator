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

const kitDotClass: Record<Kit, string> = {
  blue: "bg-blue-kit",
  purple: "bg-purple-kit",
  yellow: "bg-yellow-kit",
};

const classes = {
  panel:
    "panel detail-panel relative col-span-full min-w-0 overflow-visible rounded-card border border-border bg-surface shadow-panel [contain:layout] [transform:translateZ(0)] transition-[background-color,border-color,box-shadow] duration-[220ms]",
  heading:
    "section-heading flex items-center justify-between gap-3 border-b border-border px-[18px] py-4 transition-[border-color,background-color,color] duration-[220ms] max-mobile:px-3.5 max-mobile:py-[11px] max-mobile:[&_h2]:text-[16px]",
  emptyResult: "empty-result px-[18px] py-[22px] font-medium text-muted",
  resultContent:
    "result-content grid gap-3.5 p-[18px] max-mobile:gap-2.5 max-mobile:px-3.5 max-mobile:py-3",
  metricGrid:
    "metric-grid grid grid-cols-4 gap-2.5 max-tablet:grid-cols-1 max-mobile:grid-cols-2 max-mobile:gap-2",
  metric:
    "metric flex min-w-0 flex-col justify-center rounded-card border border-border bg-surface-strong p-3 max-tablet:px-2 max-tablet:py-2.5 max-mobile:rounded-control max-mobile:p-2",
  metricText:
    "block text-[12px] font-medium text-muted max-tablet:whitespace-nowrap max-tablet:text-[11px]",
  metricLabel:
    "metric-label relative inline-flex min-h-[1.2em] items-center gap-[5px] whitespace-normal leading-[1.2] text-xs font-medium text-muted max-tablet:whitespace-nowrap max-tablet:text-[11px]",
  metricValue:
    "mt-[5px] block text-[21px] font-semibold leading-[1.16] text-text-strong max-tablet:text-[clamp(13px,3.5vw,16px)] max-mobile:text-[13px]",
  infoTip:
    "info-tip group relative top-[-0.28em] inline-grid size-3.5 cursor-help place-items-center rounded-full border border-border bg-surface-raised p-0 text-[9px] font-bold leading-none text-muted align-baseline",
  infoTipBubble:
    "absolute right-0 bottom-[calc(100%+9px)] z-[5] hidden box-border w-[min(280px,74vw)] max-w-[calc(100vw-32px)] whitespace-normal rounded-card border border-border bg-surface px-[11px] py-2.5 text-left text-xs font-normal leading-[1.45] text-text-soft shadow-panel [overflow-wrap:anywhere] [word-break:keep-all] group-hover:block group-focus:block group-focus-visible:block",
  chip: "action-chip inline-flex items-center justify-center gap-[9px]",
  chipDot: "inline-block size-4 rounded-full shadow-[0_0_0_3px_rgba(255,255,255,0.18)]",
  chipText: "action-chip-text inline-flex items-baseline gap-0 whitespace-nowrap",
  chipName: "action-chip-name inline",
  chipSeparator: "action-chip-separator inline whitespace-pre",
  chipCount: "action-chip-count inline",
  tableWrap: "table-wrap overflow-x-auto",
  table: "w-full border-collapse",
  tableCell:
    "whitespace-nowrap border-t border-border px-3 py-2.5 text-left max-mobile:px-2.5 max-mobile:py-2 max-mobile:text-xs",
  tableHeadCell: "bg-surface-strong text-[12px] font-semibold text-text-soft",
  tableBodyCell: "text-[13px] font-medium text-text-soft",
  validationDetails: "validation-details rounded-card border border-border bg-surface-raised",
  validationSummary:
    "min-h-[42px] cursor-pointer px-3.5 py-3 text-[13px] font-semibold text-text-soft max-mobile:min-h-[38px] max-mobile:px-3 max-mobile:py-2.5 max-mobile:text-xs",
  validationContent: "validation-content grid gap-2.5 px-3.5 pb-3.5",
  validationText: "m-0 text-[13px] font-normal leading-normal text-muted",
  secondaryButton:
    "secondary-button min-h-[42px] border border-border bg-button text-text-soft enabled:hover:border-grade-active enabled:hover:text-grade-active-strong min-[661px]:max-desktop:min-h-[38px] min-[661px]:max-desktop:text-[13px] max-mobile:min-h-[38px] max-mobile:text-[13px]",
  validationButton: "validation-button min-h-9 justify-self-start px-3",
} as const;

function KitChip({ kit, count }: { kit: Kit; count: number }) {
  return (
    <span className={`${classes.chip} ${kit}`}>
      <i aria-hidden="true" className={`${classes.chipDot} ${kitDotClass[kit]}`}></i>
      <span className={classes.chipText}>
        <span className={classes.chipName}>{KIT_LABELS[kit]}</span>
        <span className={classes.chipSeparator}>{"\u00a0×\u00a0"}</span>
        <span className={classes.chipCount}>{count}회</span>
      </span>
    </span>
  );
}

function InfoTip({ label, children }: { label: string; children: string }) {
  return (
    <button className={classes.infoTip} type="button" aria-label={`${label} 설명`}>
      i<span className={classes.infoTipBubble}>{children}</span>
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
    <div className={classes.resultContent}>
      <div className={classes.metricGrid}>
        <div className={classes.metric}>
          <span className={classes.metricText}>추천 기준</span>
          <strong className={classes.metricValue}>{view.strategyLabel}</strong>
        </div>
        <div className={classes.metric}>
          <span className={classes.metricLabel}>
            SR 15 도달 확률
            <InfoTip label="SR 15 도달 확률">
              현재 보유 키트와 현재 상태에서, 앞으로도 이 전략이 고른 행동을 계속 따른다고 할 때
              최종 목표인 SR 15에 도달할 확률입니다.
            </InfoTip>
          </span>
          <strong className={classes.metricValue}>{view.successProbability}</strong>
        </div>
        <div className={classes.metric}>
          <span className={classes.metricText}>구간 대성공 확률</span>
          <strong className={classes.metricValue}>{view.greatSuccessProbability}</strong>
        </div>
        <div className={classes.metric}>
          <span className={classes.metricLabel}>
            정확 계산 상태 수
            <InfoTip label="정확 계산 상태 수">
              MDP가 실제로 평가한 등급, 레벨, 경험치, 남은 키트 사용 가능 횟수 조합의 개수입니다.
            </InfoTip>
          </span>
          <strong className={classes.metricValue}>{view.stateCount}</strong>
        </div>
      </div>

      <div className={classes.tableWrap}>
        <table className={classes.table}>
          <thead>
            <tr>
              <th className={`${classes.tableCell} ${classes.tableHeadCell}`}>후보</th>
              <th className={`${classes.tableCell} ${classes.tableHeadCell}`}>첫 행동</th>
              <th className={`${classes.tableCell} ${classes.tableHeadCell}`}>SR 15 도달 확률</th>
              <th className={`${classes.tableCell} ${classes.tableHeadCell}`}>구간 대성공 확률</th>
            </tr>
          </thead>
          <tbody>
            {view.candidates.map((candidate) => (
              <tr
                key={`${candidate.rankLabel}-${candidate.kit}-${candidate.count}-${candidate.successProbability}`}
              >
                <td className={`${classes.tableCell} ${classes.tableBodyCell}`}>
                  {candidate.rankLabel}
                </td>
                <td className={`${classes.tableCell} ${classes.tableBodyCell}`}>
                  <KitChip kit={candidate.kit} count={candidate.count} />
                </td>
                <td className={`${classes.tableCell} ${classes.tableBodyCell}`}>
                  {candidate.successProbability}
                </td>
                <td className={`${classes.tableCell} ${classes.tableBodyCell}`}>
                  {candidate.greatSuccessProbability}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <details className={classes.validationDetails}>
        <summary className={classes.validationSummary}>가상의 니붕이로 검증해보기</summary>
        <div className={classes.validationContent}>
          <p className={classes.validationText}>
            가상의 니붕이 {view.monteCarloRuns}명을 동일한 조건에서 시도시켜, 계산 결과와 비슷한지
            확인해보는 기능입니다.
          </p>
          <button
            className={`${classes.secondaryButton} ${classes.validationButton}`}
            type="button"
            disabled={validation.disabled}
            onClick={onRunValidation}
          >
            {validation.buttonLabel}
          </button>
          <p className={`${classes.validationText} validation-result`} data-validation-result>
            {validation.message}
          </p>
        </div>
      </details>
    </div>
  );
}

export default function DetailPanel({ view, validation, onRunValidation }: DetailPanelProps) {
  return (
    <section className={classes.panel}>
      <div className={classes.heading}>
        <h2>세부 정보</h2>
      </div>
      <div id="detailBox" className={view.type === "empty" ? classes.emptyResult : ""}>
        {view.type === "empty" ? (
          view.message
        ) : (
          <MetricsDetail view={view} validation={validation} onRunValidation={onRunValidation} />
        )}
      </div>
    </section>
  );
}
