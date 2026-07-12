import { type ReactNode, useCallback, useEffect, useId, useRef, useState } from "react";
import { useDismissableLayer } from "../hooks/useDismissableLayer";
import type { Kit } from "../types";
import type { DetailView, ValidationView } from "../ui-types";
import { ValidationSuccessChart } from "./ValidationSuccessChart";

const KIT_LABELS: Record<Kit, string> = {
  blue: "초심자용 관리 키트",
  purple: "중급자용 관리 키트",
  yellow: "상급자용 관리 키트",
};

const KIT_MOBILE_LABELS: Record<Kit, string> = {
  blue: "초심자용",
  purple: "중급자용",
  yellow: "상급자용",
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
  metricGrid: "metric-grid grid grid-cols-2 gap-2.5 max-mobile:gap-2",
  metric:
    "metric flex min-w-0 flex-col items-center justify-center rounded-card border border-border bg-surface-strong p-3 text-center max-tablet:px-2 max-tablet:py-2.5 max-mobile:rounded-control max-mobile:p-2",
  metricHighlight: "border-primary/35 [background:var(--green-soft)]",
  metricText:
    "block text-[12px] font-semibold text-muted max-tablet:whitespace-nowrap max-tablet:text-[11px]",
  metricLabel:
    "metric-label relative inline-block min-h-[1.2em] whitespace-normal leading-[1.2] text-xs font-semibold text-muted max-tablet:whitespace-nowrap max-tablet:text-[11px]",
  metricLabelHighlight: "[color:var(--green-dark)]",
  metricValue:
    "mt-[5px] block text-[24px] font-semibold leading-[1.16] text-text-strong max-tablet:text-[clamp(16px,3.5vw,20px)] max-mobile:text-[16px]",
  metricValueHighlight: "[color:var(--green-dark)] font-bold",
  metricList: "mt-[5px] grid gap-1 text-[13px] font-semibold leading-snug text-text-strong",
  metricInlineList:
    "mt-[6px] flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-[13px] font-semibold leading-snug text-text-strong max-tablet:text-[12px]",
  metricInlineItem: "inline-flex min-w-0 items-center whitespace-nowrap",
  metricSubText: "font-medium text-muted",
  infoTip:
    "info-tip group absolute left-[calc(100%+3px)] top-0 z-[2] grid size-3 -translate-y-[35%] cursor-help place-items-center rounded-full border border-border bg-surface-raised p-0 text-[8px] font-bold leading-none text-muted",
  infoTipBubble:
    "invisible pointer-events-none absolute bottom-[calc(100%+9px)] z-[5] box-border w-[min(280px,74vw)] max-w-[calc(100vw-32px)] whitespace-normal rounded-card border border-border bg-surface px-[11px] py-2.5 text-left text-xs font-normal leading-[1.45] text-text-soft opacity-0 shadow-panel transition-opacity duration-[160ms] [overflow-wrap:anywhere] [word-break:keep-all] group-hover:visible group-hover:opacity-100",
  infoTipBubbleOpen: "visible pointer-events-auto opacity-100",
  infoTipBubbleLeft: "right-0",
  infoTipBubbleRight: "left-0",
  chip: "action-chip inline-flex items-center justify-center gap-[9px] max-mobile:gap-1.5",
  chipDot:
    "inline-block aspect-square size-4 flex-none rounded-full shadow-[0_0_0_3px_rgba(255,255,255,0.18)] max-mobile:size-3 max-mobile:shadow-none",
  chipText:
    "action-chip-text inline-flex items-baseline gap-0 whitespace-nowrap max-mobile:text-[11px]",
  chipName: "action-chip-name inline",
  chipSeparator: "action-chip-separator inline whitespace-pre",
  chipCount: "action-chip-count inline",
  tableWrap: "table-wrap overflow-x-auto",
  table: "w-full border-collapse max-mobile:w-max max-mobile:min-w-full",
  tableCell:
    "whitespace-nowrap px-3 py-2 align-middle text-left max-mobile:px-2 max-mobile:py-2 max-mobile:text-[11px] max-mobile:leading-tight",
  tableHeadCell:
    "border-y border-[var(--stats-divider-soft)] bg-surface-strong text-[12px] font-semibold text-text-soft max-mobile:text-[10.5px]",
  tableBodyCell: "text-[13px] font-medium text-text-soft max-mobile:text-[11px]",
  tableBodyCellSeparated: "border-t border-[var(--stats-divider-soft)]",
  tablePercent:
    "inline-flex items-baseline justify-start whitespace-nowrap text-[13px] tabular-nums tracking-normal",
  tablePercentInteger: "text-left",
  tablePercentDecimal: "text-left",
  tablePercentSymbol: "ml-[1px] text-left",
  tableMuted:
    "block text-[11px] font-medium text-muted max-mobile:text-[10px] max-mobile:leading-tight",
  tableReason:
    "candidate-reason-trigger mt-0.5 block w-fit max-w-full cursor-help border-0 bg-transparent p-0 text-left text-[11px] font-medium leading-tight text-muted max-mobile:text-[10px]",
  tableReasonBubble:
    "candidate-reason-bubble pointer-events-none fixed z-[20] box-border w-[min(260px,calc(100vw-24px))] rounded-card border border-border bg-surface px-[11px] py-2 text-left text-xs font-normal leading-[1.45] text-text-soft opacity-0 shadow-panel transition-opacity duration-[160ms] [overflow-wrap:anywhere] [word-break:keep-all]",
  tableReasonBubbleOpen: "opacity-100",
  validationDetails:
    "validation-details relative rounded-card border border-border bg-surface-raised",
  validationSummary:
    "flex min-h-[42px] cursor-pointer items-center justify-between gap-3 px-3.5 py-3 text-[13px] font-semibold text-text-soft max-mobile:min-h-[38px] max-mobile:px-3 max-mobile:py-2.5 max-mobile:text-xs",
  validationSummaryLabel:
    "validation-summary-label relative inline-block min-h-[1.2em] leading-[1.2]",
  validationSummaryMeta:
    "shrink-0 whitespace-nowrap text-[11.5px] font-semibold text-muted max-mobile:text-[10.5px]",
  validationContent: "validation-content grid gap-2.5 px-3.5 pb-3.5",
  validationText: "m-0 text-[13px] font-normal leading-normal text-muted",
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
        <span className={classes.chipName} data-mobile-label={KIT_MOBILE_LABELS[kit]}>
          {KIT_LABELS[kit]}
        </span>
        <span className={classes.chipSeparator}>{"\u00a0×\u00a0"}</span>
        <span className={classes.chipCount}>{count}회</span>
      </span>
    </span>
  );
}

function InfoTip({ label, children }: { label: string; children: ReactNode }) {
  const buttonRef = useRef<HTMLButtonElement>(null);
  const tooltipId = useId();
  const [lockedOpen, setLockedOpen] = useState(false);
  const [open, setOpen] = useState(false);
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

  const showTip = () => {
    updateDirection();
    setOpen(true);
  };

  const hideTip = () => {
    if (!lockedOpen) setOpen(false);
  };

  useDismissableLayer({
    escapeEnabled: open,
    outsideEnabled: lockedOpen,
    containsTarget: (target) =>
      target instanceof Node && Boolean(buttonRef.current?.contains(target)),
    onDismiss: () => {
      setLockedOpen(false);
      setOpen(false);
      buttonRef.current?.focus();
    },
  });

  return (
    <button
      ref={buttonRef}
      className={classes.infoTip}
      type="button"
      aria-describedby={open ? tooltipId : undefined}
      aria-expanded={open}
      aria-label={`${label} 설명`}
      onBlur={hideTip}
      onClick={(event) => {
        event.stopPropagation();
        updateDirection();
        const next = !lockedOpen;
        setLockedOpen(next);
        setOpen(next);
      }}
      onFocus={showTip}
      onPointerEnter={showTip}
      onPointerLeave={hideTip}
    >
      i
      <span
        id={tooltipId}
        role="tooltip"
        className={`${classes.infoTipBubble} ${
          openToRight ? classes.infoTipBubbleRight : classes.infoTipBubbleLeft
        } ${open ? classes.infoTipBubbleOpen : ""}`}
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

function ResponsivePercentValue({
  compact,
  medium,
  detailed,
}: {
  compact: string;
  medium: string;
  detailed: string;
}) {
  return (
    <span className="candidate-probability-set">
      <span className="sr-only">{detailed}</span>
      <span className="candidate-probability candidate-probability-wide" aria-hidden="true">
        <AlignedPercentValue value={detailed} />
      </span>
      <span className="candidate-probability candidate-probability-medium" aria-hidden="true">
        <AlignedPercentValue value={medium} />
      </span>
      <span className="candidate-probability candidate-probability-compact" aria-hidden="true">
        <AlignedPercentValue value={compact} />
      </span>
    </span>
  );
}

function CandidateReason({ label, help }: { label: string; help?: string | null }) {
  const buttonRef = useRef<HTMLButtonElement>(null);
  const tooltipId = useId();
  const [lockedOpen, setLockedOpen] = useState(false);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ left: 12, top: 12 });

  const updatePosition = useCallback(() => {
    const rect = buttonRef.current?.getBoundingClientRect();
    if (!rect) return;
    const bubbleWidth = Math.min(260, Math.max(0, window.innerWidth - 24));
    const left = Math.min(
      Math.max(12, rect.left),
      Math.max(12, window.innerWidth - bubbleWidth - 12),
    );
    const top = rect.bottom + 7;
    setPosition({ left, top });
  }, []);

  const showTip = () => {
    updatePosition();
    setOpen(true);
  };

  const hideTip = () => {
    if (!lockedOpen) setOpen(false);
  };

  useEffect(() => {
    if (!open) return undefined;
    const update = () => updatePosition();
    window.addEventListener("resize", update);
    window.addEventListener("scroll", update, true);
    return () => {
      window.removeEventListener("resize", update);
      window.removeEventListener("scroll", update, true);
    };
  }, [open, updatePosition]);

  useDismissableLayer({
    escapeEnabled: open,
    outsideEnabled: lockedOpen,
    containsTarget: (target) =>
      target instanceof Node && Boolean(buttonRef.current?.contains(target)),
    onDismiss: () => {
      setLockedOpen(false);
      setOpen(false);
      buttonRef.current?.focus();
    },
  });

  return (
    <button
      ref={buttonRef}
      className={classes.tableReason}
      type="button"
      aria-describedby={open && help ? tooltipId : undefined}
      aria-expanded={open}
      onBlur={hideTip}
      onClick={(event) => {
        event.stopPropagation();
        const next = !lockedOpen;
        updatePosition();
        setLockedOpen(next);
        setOpen(next);
      }}
      onFocus={showTip}
      onPointerEnter={showTip}
      onPointerLeave={hideTip}
    >
      ({label})
      {help ? (
        <span
          id={tooltipId}
          role="tooltip"
          className={`${classes.tableReasonBubble} ${open ? classes.tableReasonBubbleOpen : ""}`}
          style={{ left: position.left, top: position.top }}
        >
          {help}
        </span>
      ) : null}
    </button>
  );
}

function DetailMetricGrid({ view }: { view: MetricsDetailView }) {
  return (
    <div className={classes.metricGrid}>
      <div className={`${classes.metric} ${classes.metricHighlight}`}>
        <span
          className={`${classes.metricLabel} ${classes.metricLabelHighlight}`}
          style={{ color: "var(--green-dark)" }}
        >
          <span>SR 15 도달 확률</span>
          <InfoTip label="SR 15 도달 확률">
            현재 보유 키트와 현재 상태에서, 이후에도 계산기가 고른 행동을 계속 따랐을 때 최종 목표인
            SR 15에 도달할 확률입니다.
          </InfoTip>
        </span>
        <strong
          className={`${classes.metricValue} ${classes.metricValueHighlight}`}
          style={{ color: "var(--green-dark)" }}
        >
          {view.successProbability}
        </strong>
      </div>
      <div className={classes.metric}>
        <span className={classes.metricText}>구간 대성공 확률</span>
        <strong className={classes.metricValue}>{view.greatSuccessProbability}</strong>
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
            <th className={`${classes.tableCell} ${classes.tableHeadCell}`}>
              <span className="max-mobile:hidden">SR 15 도달 확률</span>
              <span className="hidden max-mobile:inline">도달률</span>
            </th>
            <th className={`${classes.tableCell} ${classes.tableHeadCell}`}>
              <span className="max-mobile:hidden">예상 소모량</span>
              <span className="hidden max-mobile:inline">소모량</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {view.candidates.map((candidate, index) => (
            <tr
              className={candidate.excludedReason ? "opacity-60" : ""}
              key={`${candidate.rankLabel}-${candidate.kit}-${candidate.count}-${candidate.successProbability}`}
            >
              <td
                className={`${classes.tableCell} ${classes.tableBodyCell} ${
                  index > 0 ? classes.tableBodyCellSeparated : ""
                }`}
              >
                {candidate.excludedReason ? "제외" : candidate.rankLabel}
                {candidate.excludedReason ? (
                  <CandidateReason
                    label={candidate.excludedReason}
                    help={candidate.excludedReasonHelp ?? null}
                  />
                ) : null}
              </td>
              <td
                className={`${classes.tableCell} ${classes.tableBodyCell} ${
                  index > 0 ? classes.tableBodyCellSeparated : ""
                }`}
              >
                <KitChip kit={candidate.kit} count={candidate.count} />
              </td>
              <td
                className={`${classes.tableCell} ${classes.tableBodyCell} ${
                  index > 0 ? classes.tableBodyCellSeparated : ""
                }`}
              >
                <ResponsivePercentValue
                  compact={candidate.successProbability}
                  medium={candidate.successProbabilityMedium}
                  detailed={candidate.successProbabilityDetailed}
                />
              </td>
              <td
                className={`${classes.tableCell} ${classes.tableBodyCell} ${
                  index > 0 ? classes.tableBodyCellSeparated : ""
                }`}
              >
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
  monteCarloRunsLabel,
  validation,
  onRunValidation,
}: {
  monteCarloRunsLabel: string;
  validation: ValidationView;
  onRunValidation: () => void;
}) {
  const [open, setOpen] = useState(false);

  return (
    <details
      className={classes.validationDetails}
      onToggle={(event) => {
        if (event.target !== event.currentTarget) return;
        const nextOpen = event.currentTarget.open;
        setOpen(nextOpen);
        if (nextOpen && !validation.disabled && !validation.stageReach) {
          onRunValidation();
        }
      }}
    >
      <summary className={classes.validationSummary}>
        <span className={classes.validationSummaryLabel}>
          <span>검증</span>
          <InfoTip label="검증">
            가상의 니붕이 {monteCarloRunsLabel}명을 동일한 조건에서 시도시켜, 계산 결과와 비슷한지
            확인해보는 기능입니다.
          </InfoTip>
        </span>
        <span className={classes.validationSummaryMeta}>{open ? "접기 ▴" : "펼치기 ▾"}</span>
      </summary>
      <div className={classes.validationContent}>
        <p className={`${classes.validationText} validation-result`} data-validation-result>
          {validation.message}
        </p>
        <ValidationSuccessChart monteCarloRunsLabel={monteCarloRunsLabel} validation={validation} />
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
        monteCarloRunsLabel={view.monteCarloRuns}
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
  if (view.type === "empty") return null;

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
      <div id="detailBox">
        <MetricsDetail view={view} validation={validation} onRunValidation={onRunValidation} />
      </div>
    </section>
  );
}
