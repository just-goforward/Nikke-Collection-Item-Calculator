import { type ReactNode, useCallback, useEffect, useId, useRef, useState } from "react";
import { useDismissableLayer } from "../hooks/useDismissableLayer";
import { useI18n } from "../i18n/locale";
import type { LocalizedMessage, MessageKey } from "../i18n/messages.ko";
import type { Kit } from "../types";
import type { DetailView, ValidationView } from "../ui-types";
import { ValidationSuccessChart } from "./ValidationSuccessChart";

const KIT_LABEL_KEYS: Record<Kit, MessageKey> = {
  blue: "kit.blue",
  purple: "kit.purple",
  yellow: "kit.yellow",
};

const KIT_PANEL_LABEL_KEYS: Record<Kit, MessageKey> = {
  blue: "kit.bluePanel",
  purple: "kit.purplePanel",
  yellow: "kit.yellowPanel",
};

const KIT_SHORT_LABEL_KEYS: Record<Kit, MessageKey> = {
  blue: "kit.blueShort",
  purple: "kit.purpleShort",
  yellow: "kit.yellowShort",
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
    "block text-[12px] font-semibold text-muted max-tablet:whitespace-nowrap max-tablet:text-[11px] max-mobile:flex max-mobile:min-h-[2.5em] max-mobile:items-center max-mobile:justify-center max-mobile:whitespace-normal max-mobile:text-[9.5px] max-mobile:leading-[1.25]",
  metricLabel:
    "metric-label relative inline-flex min-h-[1.2em] items-center justify-center whitespace-normal leading-[1.2] text-xs font-semibold text-muted max-tablet:whitespace-nowrap max-tablet:text-[11px] max-mobile:min-h-[2.5em] max-mobile:whitespace-normal max-mobile:text-[9.5px] max-mobile:leading-[1.25]",
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
  chip: "action-chip action-chip-responsive grid w-full min-w-0 grid-cols-[16px_minmax(0,1fr)] items-center gap-2 max-mobile:grid-cols-[12px_minmax(0,1fr)] max-mobile:gap-1.5",
  chipDot:
    "inline-block aspect-square size-4 flex-none rounded-full shadow-[0_0_0_3px_rgba(255,255,255,0.18)] max-mobile:size-3 max-mobile:shadow-none",
  chipText:
    "action-chip-text grid min-w-0 grid-cols-[minmax(0,var(--action-name-track-width))_auto_var(--action-count-width)] items-baseline justify-start whitespace-nowrap max-mobile:text-[10px]",
  chipName: "action-chip-name min-w-0 justify-self-start whitespace-nowrap",
  chipNameFull: "action-chip-name-full",
  chipNamePanel: "action-chip-name-panel",
  chipNameShort: "action-chip-name-short",
  chipSeparator: "action-chip-separator justify-self-end whitespace-pre",
  chipCount:
    "action-chip-count w-[var(--action-count-width)] justify-self-start whitespace-nowrap text-left tabular-nums",
  tableWrap: "table-wrap overflow-x-hidden",
  table: "w-full table-fixed border-collapse",
  tableColCandidate: "w-[17%] max-mobile:w-[20%]",
  tableColAction: "w-[39%] max-mobile:w-[44%]",
  tableColProbability: "w-[20%] max-mobile:w-[18%]",
  tableColConsumption: "w-[24%] max-mobile:w-[18%]",
  tableCell:
    "min-w-0 px-3 py-2 align-middle text-left [overflow-wrap:break-word] max-mobile:px-1 max-mobile:py-2 max-mobile:text-[10.5px] max-mobile:leading-tight",
  tableHeadCell:
    "border-y border-[var(--stats-divider-soft)] bg-surface-strong text-[12px] font-semibold text-text-soft max-mobile:text-[10.5px]",
  tableBodyCell: "text-[13px] font-medium text-text-soft max-mobile:text-[11px]",
  tableActionCell: "overflow-hidden",
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
  const { formatCount, t } = useI18n();
  const countLabel = formatCount(count, "use");
  return (
    <span className={`${classes.chip} ${kit}`}>
      <span className="sr-only">{`${t(KIT_LABEL_KEYS[kit])} × ${countLabel}`}</span>
      <i aria-hidden="true" className={`${classes.chipDot} ${kitDotClass[kit]}`}></i>
      <span className={classes.chipText} aria-hidden="true">
        <span className={`${classes.chipName} ${classes.chipNameFull}`}>
          {t(KIT_LABEL_KEYS[kit])}
        </span>
        <span className={`${classes.chipName} ${classes.chipNamePanel}`}>
          {t(KIT_PANEL_LABEL_KEYS[kit])}
        </span>
        <span className={`${classes.chipName} ${classes.chipNameShort}`}>
          {t(KIT_SHORT_LABEL_KEYS[kit])}
        </span>
        <span className={classes.chipSeparator}>{"\u00a0×\u00a0"}</span>
        <span className={classes.chipCount}>{countLabel}</span>
      </span>
    </span>
  );
}

function InfoTip({ label, children }: { label: string; children: ReactNode }) {
  const { t } = useI18n();
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
      aria-label={t("common.description", { label })}
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

function CandidateReason({
  label,
  help,
}: {
  label: LocalizedMessage;
  help?: LocalizedMessage | null;
}) {
  const { text } = useI18n();
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
      ({text(label)})
      {help ? (
        <span
          id={tooltipId}
          role="tooltip"
          className={`${classes.tableReasonBubble} ${open ? classes.tableReasonBubbleOpen : ""}`}
          style={{ left: position.left, top: position.top }}
        >
          {text(help)}
        </span>
      ) : null}
    </button>
  );
}

function DetailMetricGrid({ view }: { view: MetricsDetailView }) {
  const { t } = useI18n();
  const probabilityLabel = t("detail.sr15Probability");
  return (
    <div className={classes.metricGrid}>
      <div className={`${classes.metric} ${classes.metricHighlight}`}>
        <span
          className={`${classes.metricLabel} ${classes.metricLabelHighlight}`}
          style={{ color: "var(--green-dark)" }}
        >
          <span>{probabilityLabel}</span>
          <InfoTip label={probabilityLabel}>{t("detail.sr15ProbabilityHelp")}</InfoTip>
        </span>
        <strong
          className={`${classes.metricValue} ${classes.metricValueHighlight}`}
          style={{ color: "var(--green-dark)" }}
        >
          {view.successProbability}
        </strong>
      </div>
      <div className={classes.metric}>
        <span className={classes.metricText}>{t("detail.segmentSuperSuccess")}</span>
        <strong className={classes.metricValue}>{view.greatSuccessProbability}</strong>
      </div>
    </div>
  );
}

function CandidateTable({ view }: { view: MetricsDetailView }) {
  const { t, text } = useI18n();
  return (
    <div className={classes.tableWrap}>
      <table className={classes.table}>
        <colgroup>
          <col className={classes.tableColCandidate} />
          <col className={classes.tableColAction} />
          <col className={classes.tableColProbability} />
          <col className={classes.tableColConsumption} />
        </colgroup>
        <thead>
          <tr>
            <th className={`${classes.tableCell} ${classes.tableHeadCell}`}>
              {t("detail.candidate")}
            </th>
            <th className={`${classes.tableCell} ${classes.tableHeadCell}`}>
              {t("detail.firstAction")}
            </th>
            <th className={`${classes.tableCell} ${classes.tableHeadCell}`}>
              <span className="max-mobile:hidden">{t("detail.sr15Probability")}</span>
              <span className="hidden max-mobile:inline">{t("detail.reachRate")}</span>
            </th>
            <th className={`${classes.tableCell} ${classes.tableHeadCell}`}>
              <span className="max-mobile:hidden">{t("detail.expectedConsumption")}</span>
              <span className="hidden max-mobile:inline">{t("detail.consumption")}</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {view.candidates.map((candidate, index) => (
            <tr
              className={candidate.excludedReason ? "opacity-60" : ""}
              key={`${candidate.kit}-${candidate.count}-${candidate.successProbability}`}
            >
              <td
                className={`${classes.tableCell} ${classes.tableBodyCell} ${
                  index > 0 ? classes.tableBodyCellSeparated : ""
                }`}
              >
                {candidate.excludedReason ? t("common.excluded") : text(candidate.rankLabel)}
                {candidate.excludedReason ? (
                  <CandidateReason
                    label={candidate.excludedReason}
                    help={candidate.excludedReasonHelp ?? null}
                  />
                ) : null}
              </td>
              <td
                className={`${classes.tableCell} ${classes.tableBodyCell} ${classes.tableActionCell} ${
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
                <span className="block">
                  {candidate.expectedKits ? text(candidate.expectedKits) : "-"}
                </span>
                {candidate.expectedBreakdown ? (
                  <span className={classes.tableMuted}>{text(candidate.expectedBreakdown)}</span>
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
  monteCarloRuns: number;
  validation: ValidationView;
  onRunValidation: () => void;
}) {
  const { formatInteger, t, text } = useI18n();
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
          <span>{t("detail.validation")}</span>
          <InfoTip label={t("detail.validation")}>
            {t("detail.validationHelp", { runs: formatInteger(monteCarloRuns) })}
          </InfoTip>
        </span>
        <span className={classes.validationSummaryMeta}>
          {t(open ? "common.collapse" : "common.expand")}
        </span>
      </summary>
      <div className={classes.validationContent}>
        <p className={`${classes.validationText} validation-result`} data-validation-result>
          {text(validation.message)}
        </p>
        <ValidationSuccessChart monteCarloRuns={monteCarloRuns} validation={validation} />
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
  const { t } = useI18n();
  if (view.type === "empty") return null;

  return (
    <section className={classes.panel}>
      <div className={classes.heading}>
        <h2>{t("detail.title")}</h2>
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
