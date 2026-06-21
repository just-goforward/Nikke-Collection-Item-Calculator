import { useRef, useState } from "react";
import type { Kit } from "../types";
import type { DetailView, ValidationView } from "../ui-types";
import { ValidationSuccessChart } from "./ValidationSuccessChart";

const KIT_LABELS: Record<Kit, string> = {
  blue: "초심자용 관리 키트",
  purple: "중급자용 관리 키트",
  yellow: "상급자용 관리 키트",
};

const KIT_SHORT_LABELS: Record<Kit, string> = {
  blue: "파랑",
  purple: "보라",
  yellow: "노랑",
};

const kitDotClass: Record<Kit, string> = {
  blue: "bg-blue-kit",
  purple: "bg-purple-kit",
  yellow: "bg-yellow-kit",
};

const classes = {
  panel:
    "panel detail-panel relative col-span-full min-w-0 overflow-visible rounded-card border border-border bg-surface shadow-panel [contain:layout] transition-[background-color,border-color,box-shadow] duration-[220ms]",
  heading:
    "section-heading flex items-center justify-between gap-3 border-b border-border px-[18px] py-4 transition-[border-color,background-color,color] duration-[220ms] max-mobile:px-3.5 max-mobile:py-[11px] max-mobile:[&_h2]:text-[16px]",
  solverBadge:
    "inline-flex min-h-6 items-center rounded-control border border-border bg-surface-strong px-2 py-1 text-[11px] font-semibold leading-none text-muted",
  emptyResult: "empty-result px-[18px] py-[22px] font-medium text-muted",
  resultContent:
    "result-content grid gap-3.5 p-[18px] max-mobile:gap-2.5 max-mobile:px-3.5 max-mobile:py-3",
  metricGrid:
    "metric-grid grid grid-cols-[repeat(auto-fit,minmax(150px,1fr))] gap-2.5 max-mobile:grid-cols-2 max-mobile:gap-2",
  metric:
    "metric flex min-w-0 flex-col justify-center rounded-card border border-border bg-surface-strong p-3 max-tablet:px-2 max-tablet:py-2.5 max-mobile:rounded-control max-mobile:p-2",
  metricText:
    "block text-[12px] font-medium text-muted max-tablet:whitespace-nowrap max-tablet:text-[11px]",
  metricLabel:
    "metric-label relative inline-flex min-h-[1.2em] items-center gap-[5px] whitespace-normal leading-[1.2] text-xs font-medium text-muted max-tablet:whitespace-nowrap max-tablet:text-[11px]",
  metricValue:
    "mt-[5px] block text-[21px] font-semibold leading-[1.16] text-text-strong max-tablet:text-[clamp(13px,3.5vw,16px)] max-mobile:text-[13px]",
  metricList: "mt-[5px] grid gap-1 text-[13px] font-semibold leading-snug text-text-strong",
  metricInlineList:
    "mt-[6px] flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-[13px] font-semibold leading-snug text-text-strong max-tablet:text-[12px]",
  metricInlineItem: "inline-flex min-w-0 items-center whitespace-nowrap",
  metricSubText: "font-medium text-muted",
  infoTip:
    "info-tip group relative top-[-0.28em] inline-grid size-3.5 cursor-help place-items-center rounded-full border border-border bg-surface-raised p-0 text-[9px] font-bold leading-none text-muted align-baseline",
  infoTipBubble:
    "absolute bottom-[calc(100%+9px)] z-[5] hidden box-border w-[min(280px,74vw)] max-w-[calc(100vw-32px)] whitespace-normal rounded-card border border-border bg-surface px-[11px] py-2.5 text-left text-xs font-normal leading-[1.45] text-text-soft shadow-panel [overflow-wrap:anywhere] [word-break:keep-all] group-hover:block group-focus:block group-focus-visible:block",
  infoTipBubbleLeft: "right-0",
  infoTipBubbleRight: "left-0",
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
  tablePercent:
    "inline-flex items-baseline justify-start whitespace-nowrap text-[13px] tabular-nums tracking-normal",
  tablePercentInteger: "text-left",
  tablePercentDecimal: "text-left",
  tablePercentSymbol: "ml-[1px] text-left",
  tableMuted: "block text-[11px] font-medium text-muted",
  validationDetails: "validation-details rounded-card border border-border bg-surface-raised",
  validationSummary:
    "min-h-[42px] cursor-pointer px-3.5 py-3 text-[13px] font-semibold text-text-soft max-mobile:min-h-[38px] max-mobile:px-3 max-mobile:py-2.5 max-mobile:text-xs",
  validationContent: "validation-content grid gap-2.5 px-3.5 pb-3.5",
  validationText: "m-0 text-[13px] font-normal leading-normal text-muted",
  secondaryButton:
    "secondary-button min-h-[42px] border border-border bg-button text-text-soft enabled:hover:border-grade-active enabled:hover:text-grade-active-strong min-[661px]:max-desktop:min-h-[38px] min-[661px]:max-desktop:text-[13px] max-mobile:min-h-[38px] max-mobile:text-[13px]",
  validationButton: "validation-button min-h-9 justify-self-start px-3",
} as const;

type MetricsDetailView = Extract<DetailView, { type: "metrics" }>;

type DetailPanelProps = {
  view: DetailView;
  validation: ValidationView;
  onRunValidation: () => void;
  showSolverBackend: boolean;
};

function KitChip({
  kit,
  count,
}: {
  kit: MetricsDetailView["candidates"][number]["kit"];
  count: number;
}) {
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
  const buttonRef = useRef<HTMLButtonElement>(null);
  const [openToRight, setOpenToRight] = useState(false);

  const updateDirection = () => {
    const rect = buttonRef.current?.getBoundingClientRect();
    if (!rect) return;
    const bubbleWidth = Math.min(
      280,
      Math.max(0, window.innerWidth - 32),
      window.innerWidth * 0.74,
    );
    const wouldOverflowLeft = rect.right - bubbleWidth < 16;
    setOpenToRight(wouldOverflowLeft);
  };

  return (
    <button
      ref={buttonRef}
      className={classes.infoTip}
      type="button"
      aria-label={`${label} 설명`}
      onFocus={updateDirection}
      onPointerEnter={updateDirection}
    >
      i
      <span
        className={`${classes.infoTipBubble} ${
          openToRight ? classes.infoTipBubbleRight : classes.infoTipBubbleLeft
        }`}
      >
        {children}
      </span>
    </button>
  );
}

function AlignedPercentValue({ value }: { value: string }) {
  const match = value.match(/^([^.%]+)(\.\d+)?(%)$/);
  if (!match) return <>{value}</>;
  return (
    <span className={classes.tablePercent}>
      <span className={classes.tablePercentInteger}>{match[1]}</span>
      <span className={classes.tablePercentDecimal}>{match[2] || ""}</span>
      <span className={classes.tablePercentSymbol}>{match[3]}</span>
    </span>
  );
}

function DetailMetricGrid({ view }: { view: MetricsDetailView }) {
  return (
    <div className={classes.metricGrid}>
      <div className={classes.metric}>
        <span className={classes.metricLabel}>
          SR 15 도달 확률
          <InfoTip label="SR 15 도달 확률">
            현재 보유 키트와 현재 상태에서, 이후에도 계산기가 고른 행동을 계속 따랐을 때 최종 목표인
            SR 15에 도달할 확률입니다.
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
          예상 소모량
          <InfoTip label="예상 소모량">
            SR 15까지 진행할 때 평균적으로 소모될 키트 수와, 28일 예상 수급량 기준 며칠치인지 함께
            표시합니다.
          </InfoTip>
        </span>
        <strong className={classes.metricInlineList}>
          {view.expectedConsumption.map((item) => (
            <span className={classes.metricInlineItem} key={item.kit}>
              <i
                aria-hidden="true"
                className={`${classes.chipDot} ${kitDotClass[item.kit]} mr-1 inline-block size-2`}
              />
              {KIT_SHORT_LABELS[item.kit]} {item.pieces}{" "}
              <span className={classes.metricSubText}>({item.supplyDays})</span>
            </span>
          ))}
        </strong>
      </div>
      <div className={classes.metric}>
        <span className={classes.metricLabel}>
          완료 후 예상 잔여
          <InfoTip label="완료 후 예상 잔여">
            현재 보유량에서 평균 소모량을 뺀 값입니다. 실제 결과는 대성공 여부에 따라 달라질 수
            있습니다.
          </InfoTip>
        </span>
        <strong className={classes.metricList}>{view.expectedRemaining}</strong>
      </div>
    </div>
  );
}

function CandidateTable({ view }: { view: MetricsDetailView }) {
  return (
    <div className={classes.tableWrap}>
      <table className={classes.table}>
        <thead>
          <tr>
            <th className={`${classes.tableCell} ${classes.tableHeadCell}`}>후보</th>
            <th className={`${classes.tableCell} ${classes.tableHeadCell}`}>첫 행동</th>
            <th className={`${classes.tableCell} ${classes.tableHeadCell}`}>SR 15 도달 확률</th>
            <th className={`${classes.tableCell} ${classes.tableHeadCell}`}>예상 소모량</th>
          </tr>
        </thead>
        <tbody>
          {view.candidates.map((candidate) => (
            <tr
              className={candidate.excludedReason ? "opacity-60" : ""}
              key={`${candidate.rankLabel}-${candidate.kit}-${candidate.count}-${candidate.successProbability}`}
            >
              <td className={`${classes.tableCell} ${classes.tableBodyCell}`}>
                {candidate.excludedReason ? "제외" : candidate.rankLabel}
                {candidate.excludedReason ? (
                  <span className={classes.tableMuted}>{candidate.excludedReason}</span>
                ) : null}
              </td>
              <td className={`${classes.tableCell} ${classes.tableBodyCell}`}>
                <KitChip kit={candidate.kit} count={candidate.count} />
              </td>
              <td className={`${classes.tableCell} ${classes.tableBodyCell}`}>
                <AlignedPercentValue value={candidate.successProbability} />
              </td>
              <td className={`${classes.tableCell} ${classes.tableBodyCell}`}>
                <span className="block">{candidate.expectedKits || "-"}</span>
                {candidate.expectedBreakdown ? (
                  <span className={classes.tableMuted}>{candidate.expectedBreakdown}</span>
                ) : null}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function ValidationDetails({
  monteCarloRuns,
  validation,
  onRunValidation,
}: {
  monteCarloRuns: string;
  validation: ValidationView;
  onRunValidation: () => void;
}) {
  return (
    <details className={classes.validationDetails}>
      <summary className={classes.validationSummary}>가상의 니붕이로 검증해보기</summary>
      <div className={classes.validationContent}>
        <p className={classes.validationText}>
          가상의 니붕이 {monteCarloRuns}명을 동일한 조건에서 시도시켜, 계산 결과와 비슷한지
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
        <ValidationSuccessChart validation={validation} />
      </div>
    </details>
  );
}

function MetricsDetail({
  view,
  validation,
  onRunValidation,
}: {
  view: MetricsDetailView;
  validation: ValidationView;
  onRunValidation: () => void;
}) {
  return (
    <div className={classes.resultContent}>
      <DetailMetricGrid view={view} />
      <CandidateTable view={view} />
      <ValidationDetails
        monteCarloRuns={view.monteCarloRuns}
        onRunValidation={onRunValidation}
        validation={validation}
      />
    </div>
  );
}

export default function DetailPanel({
  view,
  validation,
  onRunValidation,
  showSolverBackend,
}: DetailPanelProps) {
  return (
    <section className={classes.panel}>
      <div className={classes.heading}>
        <h2>세부 정보</h2>
        {showSolverBackend && view.type === "metrics" ? (
          <span className={classes.solverBadge}>
            Solver <span aria-hidden="true">·</span> {view.solverLabel}
          </span>
        ) : null}
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
