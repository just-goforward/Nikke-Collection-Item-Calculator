import {
  type ReactNode,
  type RefObject,
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
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
  detailBody: "relative overflow-hidden rounded-b-card",
  loadingOverlay:
    "absolute inset-0 z-[4] grid place-items-center bg-[rgba(255,255,255,0.88)] px-[18px] py-[22px] text-center backdrop-blur-[1px] [body.theme-dark_&]:bg-[rgba(35,38,42,0.9)] max-mobile:px-3.5 max-mobile:py-3",
  loadingStack: "grid justify-items-center gap-2.5 text-[13px] font-semibold text-muted",
  loadingSpinner:
    "size-7 animate-spin rounded-full border-[3px] border-primary-soft border-t-primary",
  emptyResult: "empty-result px-[18px] py-[22px] font-medium text-muted",
  resultContent:
    "result-content grid gap-3.5 p-[18px] max-mobile:gap-2.5 max-mobile:px-3.5 max-mobile:py-3",
  metricGrid: "metric-grid grid grid-cols-2 gap-2.5 max-mobile:gap-2",
  metric:
    "metric flex min-w-0 flex-col items-center justify-center rounded-card border border-border bg-surface-strong p-3 text-center max-tablet:px-2 max-tablet:py-2.5 max-mobile:rounded-control max-mobile:p-2",
  metricHighlight: "border-primary/35 [background:var(--green-soft)]",
  metricText:
    "metric-copy block text-[12px] font-semibold text-muted max-tablet:whitespace-nowrap max-tablet:text-[11px] max-mobile:flex max-mobile:items-center max-mobile:justify-center max-mobile:whitespace-normal max-mobile:text-[9.5px] max-mobile:leading-[1.25]",
  metricLabel:
    "metric-copy metric-label relative inline-flex min-h-[1.2em] items-center justify-center whitespace-normal leading-[1.2] text-xs font-semibold text-muted max-tablet:whitespace-nowrap max-tablet:text-[11px] max-mobile:whitespace-normal max-mobile:text-[9.5px] max-mobile:leading-[1.25]",
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
    "pointer-events-auto fixed z-[9999] box-border w-[min(280px,74vw)] max-w-[calc(100vw-32px)] whitespace-normal rounded-card border border-border bg-surface px-[11px] py-2.5 text-left text-xs font-normal leading-[1.45] text-text-soft opacity-100 shadow-panel [overflow-wrap:anywhere] [word-break:keep-all]",
  chip: "action-chip action-chip-responsive grid w-full min-w-0 grid-cols-[16px_minmax(0,1fr)] items-center gap-2 max-mobile:grid-cols-[12px_minmax(0,1fr)] max-mobile:gap-1.5",
  chipDot:
    "inline-block aspect-square size-4 flex-none rounded-full shadow-[0_0_0_3px_rgba(255,255,255,0.18)] max-mobile:size-3 max-mobile:shadow-none",
  chipText:
    "action-chip-text grid min-w-0 grid-cols-[minmax(0,var(--action-name-track-width))_auto_max-content] items-baseline justify-start whitespace-nowrap max-mobile:text-[10px]",
  chipName: "action-chip-name min-w-0 justify-self-start whitespace-nowrap",
  chipNameFull: "action-chip-name-full",
  chipNamePanel: "action-chip-name-panel",
  chipNameShort: "action-chip-name-short",
  chipSeparator: "action-chip-separator justify-self-end whitespace-pre",
  chipCount: "action-chip-count justify-self-start whitespace-nowrap text-left tabular-nums",
  tableWrap: "table-wrap overflow-x-hidden",
  table: "w-full table-fixed border-collapse",
  tableColCandidate: "w-[var(--candidate-col-width)]",
  tableColAction: "w-[var(--action-col-width)]",
  tableColProbability: "w-[var(--probability-col-width)]",
  tableColConsumption: "w-[var(--consumption-col-width)]",
  tableCell:
    "min-w-0 px-1 py-2 align-middle text-left [overflow-wrap:break-word] max-mobile:py-2 max-mobile:text-[10.5px] max-mobile:leading-tight",
  tableCandidateCell: "candidate-rank-cell",
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
    "candidate-reason-bubble pointer-events-none fixed z-[9999] box-border w-[min(260px,calc(100vw-24px))] rounded-card border border-border bg-surface px-[11px] py-2 text-left text-xs font-normal leading-[1.45] text-text-soft shadow-panel [overflow-wrap:anywhere] [word-break:keep-all]",
  validationDetails:
    "validation-details relative rounded-card border border-border bg-surface-raised",
  validationHeader:
    "flex min-h-[42px] items-center gap-1 px-3.5 py-3 text-[13px] font-semibold text-text-soft max-mobile:min-h-[38px] max-mobile:px-3 max-mobile:py-2.5 max-mobile:text-xs",
  validationLabelGroup: "validation-label-group relative inline-flex min-w-0 items-center",
  validationSummary:
    "min-w-0 cursor-pointer border-0 bg-transparent p-0 text-left font-[inherit] leading-[1.2] text-[inherit]",
  validationSummaryLabel:
    "validation-summary-label relative inline-block min-h-[1.2em] leading-[1.2]",
  validationSummaryMeta:
    "validation-summary-meta ml-auto shrink-0 cursor-pointer whitespace-nowrap border-0 bg-transparent p-0 text-[11.5px] font-semibold text-muted max-mobile:text-[10.5px]",
  validationContent: "validation-content grid gap-2.5 px-3.5 pb-3.5 [&[hidden]]:hidden",
  validationText: "m-0 text-[13px] font-normal leading-normal text-muted",
} as const;

type MetricsDetailView = Extract<DetailView, { type: "metrics" }>;

type DetailPanelProps = {
  loading: boolean;
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
  const bubbleRef = useRef<HTMLSpanElement>(null);
  const tooltipId = useId();
  const [lockedOpen, setLockedOpen] = useState(false);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ left: 16, top: 16 });

  const updatePosition = useCallback(() => {
    const triggerRect = buttonRef.current?.getBoundingClientRect();
    if (!triggerRect) return;
    const viewportPadding = 16;
    const gap = 9;
    const bubbleRect = bubbleRef.current?.getBoundingClientRect();
    const bubbleWidth =
      bubbleRect?.width ??
      Math.min(280, Math.max(0, window.innerWidth - viewportPadding * 2), window.innerWidth * 0.74);
    const bubbleHeight = bubbleRect?.height ?? 96;
    const preferredLeft = triggerRect.right - bubbleWidth;
    const maxLeft = Math.max(viewportPadding, window.innerWidth - viewportPadding - bubbleWidth);
    const left = Math.min(
      maxLeft,
      Math.max(
        viewportPadding,
        preferredLeft >= viewportPadding ? preferredLeft : triggerRect.left,
      ),
    );
    const above = triggerRect.top - gap - bubbleHeight;
    const below = triggerRect.bottom + gap;
    const maxTop = Math.max(viewportPadding, window.innerHeight - viewportPadding - bubbleHeight);
    const top = Math.min(
      maxTop,
      Math.max(viewportPadding, above >= viewportPadding ? above : below),
    );
    setPosition({ left, top });
  }, []);

  const showTip = () => {
    updatePosition();
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

  useLayoutEffect(() => {
    if (!open) return;
    updatePosition();
    window.addEventListener("resize", updatePosition);
    window.addEventListener("scroll", updatePosition, true);
    return () => {
      window.removeEventListener("resize", updatePosition);
      window.removeEventListener("scroll", updatePosition, true);
    };
  }, [open, updatePosition]);

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
        updatePosition();
        const next = !lockedOpen;
        setLockedOpen(next);
        setOpen(next);
      }}
      onFocus={showTip}
      onPointerEnter={showTip}
      onPointerLeave={hideTip}
    >
      i
      {open
        ? createPortal(
            <span
              ref={bubbleRef}
              id={tooltipId}
              role="tooltip"
              className={classes.infoTipBubble}
              style={{ left: position.left, top: position.top }}
            >
              {children}
            </span>,
            document.body,
          )
        : null}
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
  const bubbleRef = useRef<HTMLSpanElement>(null);
  const tooltipId = useId();
  const [lockedOpen, setLockedOpen] = useState(false);
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState({ left: 12, top: 12 });

  const updatePosition = useCallback(() => {
    const rect = buttonRef.current?.getBoundingClientRect();
    if (!rect) return;
    const viewportPadding = 12;
    const gap = 7;
    const bubbleRect = bubbleRef.current?.getBoundingClientRect();
    const bubbleWidth = bubbleRect?.width ?? Math.min(260, Math.max(0, window.innerWidth - 24));
    const bubbleHeight = bubbleRect?.height ?? 80;
    const left = Math.min(
      Math.max(viewportPadding, rect.left),
      Math.max(viewportPadding, window.innerWidth - bubbleWidth - viewportPadding),
    );
    const below = rect.bottom + gap;
    const above = rect.top - gap - bubbleHeight;
    const maxTop = Math.max(viewportPadding, window.innerHeight - bubbleHeight - viewportPadding);
    const top = Math.min(maxTop, Math.max(viewportPadding, below <= maxTop ? below : above));
    setPosition({ left, top });
  }, []);

  const showTip = () => {
    updatePosition();
    setOpen(true);
  };

  const hideTip = () => {
    if (!lockedOpen) setOpen(false);
  };

  useLayoutEffect(() => {
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
      {open && help
        ? createPortal(
            <span
              ref={bubbleRef}
              id={tooltipId}
              role="tooltip"
              className={classes.tableReasonBubble}
              style={{ left: position.left, top: position.top }}
            >
              {text(help)}
            </span>,
            document.body,
          )
        : null}
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

function useResponsiveCandidateTable(
  tableWrapRef: RefObject<HTMLDivElement | null>,
  layoutRevision: string,
) {
  const alignRef = useRef<() => void>(() => undefined);

  useLayoutEffect(() => {
    // The rendered labels are read from the DOM, so the revision is an execution trigger only.
    void layoutRevision;
    const tableWrap = tableWrapRef.current;
    if (!tableWrap) return;

    const actionLabelVariants = ["full", "panel", "short"] as const;
    const alignVisibleActionNames = () => {
      tableWrap.style.setProperty("--action-name-track-width", "max-content");
      const visibleNames = Array.from(
        tableWrap.querySelectorAll<HTMLElement>(".action-chip-name"),
      ).filter((name) => getComputedStyle(name).display !== "none");
      const longestName = Math.max(0, ...visibleNames.map((name) => name.scrollWidth));
      tableWrap.style.setProperty("--action-name-track-width", `${Math.ceil(longestName)}px`);
    };

    const actionLabelsFit = () => {
      alignVisibleActionNames();
      const labelsFit = Array.from(
        tableWrap.querySelectorAll<HTMLElement>(".action-chip-text"),
      ).every((chip) => chip.scrollWidth <= chip.clientWidth + 1);
      const countStarts = Array.from(
        tableWrap.querySelectorAll<HTMLElement>(".action-chip-count"),
        (count) => count.getBoundingClientRect().left,
      );
      const firstCountStart = countStarts[0];
      const countsAlign =
        firstCountStart === undefined ||
        countStarts.every((start) => Math.abs(start - firstCountStart) <= 1);
      return labelsFit && countsAlign;
    };

    const headerLabelsFit = () =>
      Array.from(tableWrap.querySelectorAll<HTMLElement>(".candidate-header-full")).every(
        (label) => {
          const cell = label.closest<HTMLElement>("th");
          if (!cell) return false;
          const style = getComputedStyle(cell);
          const available =
            cell.clientWidth -
            Number.parseFloat(style.paddingInlineStart) -
            Number.parseFloat(style.paddingInlineEnd);
          const range = document.createRange();
          range.selectNodeContents(label);
          return (
            range.getClientRects().length === 1 &&
            range.getBoundingClientRect().width <= available + 1
          );
        },
      );

    const alignActionNames = () => {
      for (const variant of actionLabelVariants) {
        tableWrap.setAttribute("data-action-label", variant);
        if (actionLabelsFit()) break;
      }
      tableWrap.setAttribute("data-header-label", "full");
      if (!headerLabelsFit()) tableWrap.setAttribute("data-header-label", "compact");
      alignVisibleActionNames();
    };

    alignRef.current = alignActionNames;
    alignActionNames();
    return () => {
      alignRef.current = () => undefined;
    };
  }, [layoutRevision, tableWrapRef]);

  useLayoutEffect(() => {
    const tableWrap = tableWrapRef.current;
    if (!tableWrap || typeof ResizeObserver !== "function") return;
    const observer = new ResizeObserver(() => alignRef.current());
    observer.observe(tableWrap);
    return () => observer.disconnect();
  }, [tableWrapRef]);
}

function CandidateTable({ view }: { view: MetricsDetailView }) {
  const { locale, t, text } = useI18n();
  const tableWrapRef = useRef<HTMLDivElement | null>(null);
  const layoutRevision = `${locale}:${view.candidates
    .map((candidate) => `${candidate.kit}:${candidate.count}`)
    .join(",")}`;
  useResponsiveCandidateTable(tableWrapRef, layoutRevision);

  return (
    <div
      className={classes.tableWrap}
      data-action-label="full"
      data-header-label="full"
      ref={tableWrapRef}
    >
      <table className={classes.table}>
        <colgroup>
          <col className={classes.tableColCandidate} />
          <col className={classes.tableColAction} />
          <col className={classes.tableColProbability} />
          <col className={classes.tableColConsumption} />
        </colgroup>
        <thead>
          <tr>
            <th
              className={`${classes.tableCell} ${classes.tableHeadCell} ${classes.tableCandidateCell}`}
            >
              {t("detail.candidate")}
            </th>
            <th className={`${classes.tableCell} ${classes.tableHeadCell}`}>
              {t("detail.firstAction")}
            </th>
            <th className={`${classes.tableCell} ${classes.tableHeadCell}`}>
              <span className="candidate-header-full">{t("detail.sr15Probability")}</span>
              <span className="candidate-header-compact">{t("detail.reachRate")}</span>
            </th>
            <th className={`${classes.tableCell} ${classes.tableHeadCell}`}>
              <span className="candidate-header-full">{t("detail.expectedConsumption")}</span>
              <span className="candidate-header-compact">{t("detail.consumption")}</span>
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
                className={`${classes.tableCell} ${classes.tableBodyCell} ${classes.tableCandidateCell} ${
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
  const wasOpenRef = useRef(false);
  const contentId = useId();

  useEffect(() => {
    const justOpened = open && !wasOpenRef.current;
    wasOpenRef.current = open;
    if (!open || validation.disabled || validation.stageReach) return;

    // An expanded panel expresses ongoing validation intent. A new solve resets the view to idle,
    // while reopening also lets the user retry a cancelled or failed validation without a loop.
    if (validation.status === "idle" || justOpened) void onRunValidation();
  }, [onRunValidation, open, validation.disabled, validation.stageReach, validation.status]);

  const toggleValidation = () => setOpen((current) => !current);

  return (
    <section className={classes.validationDetails}>
      <div className={classes.validationHeader}>
        <span className={classes.validationLabelGroup}>
          <button
            className={classes.validationSummary}
            type="button"
            aria-controls={contentId}
            aria-expanded={open}
            onClick={toggleValidation}
          >
            <span className={classes.validationSummaryLabel}>{t("detail.validation")}</span>
          </button>
          <InfoTip label={t("detail.validation")}>
            {t("detail.validationHelp", { runs: formatInteger(monteCarloRuns) })}
          </InfoTip>
        </span>
        <button
          className={classes.validationSummaryMeta}
          type="button"
          aria-controls={contentId}
          aria-expanded={open}
          onClick={toggleValidation}
        >
          {t(open ? "common.collapse" : "common.expand")}
        </button>
      </div>
      <div id={contentId} className={classes.validationContent} hidden={!open}>
        <p className={`${classes.validationText} validation-result`} data-validation-result>
          {text(validation.message)}
        </p>
        <ValidationSuccessChart monteCarloRuns={monteCarloRuns} validation={validation} />
      </div>
    </section>
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
  loading,
  view,
  validation,
  onRunValidation,
  showSolverBackend,
}: DetailPanelProps) {
  const { t } = useI18n();
  if (view.type !== "metrics") return null;

  return (
    <section className={classes.panel} aria-busy={loading || undefined}>
      <div className={classes.heading}>
        <h2>{t("detail.title")}</h2>
        {showSolverBackend ? (
          <span className={classes.solverBadge}>
            Solver <span aria-hidden="true">·</span> {view.solverLabel}
          </span>
        ) : null}
      </div>
      <div id="detailBox" className={classes.detailBody}>
        {loading ? (
          <div className={classes.loadingOverlay} role="status" aria-live="polite">
            <div className={classes.loadingStack}>
              <span className={classes.loadingSpinner} aria-hidden="true" />
              <span>{t("detail.preparing")}</span>
            </div>
          </div>
        ) : null}
        <div aria-hidden={loading || undefined} inert={loading || undefined}>
          <MetricsDetail view={view} validation={validation} onRunValidation={onRunValidation} />
        </div>
      </div>
    </section>
  );
}
