import type { CSSProperties, FocusEvent, MouseEvent, PointerEvent } from "react";
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";

import { formatInteger, formatPercent } from "../format";
import { wilsonInterval } from "../lib/stats/binomial";
import type { Kit } from "../types";
import type { GlobalStats, KitStat, SegmentStat, StatsView } from "../ui-types";

type StatsPanelProps = {
  view: StatsView;
};

type TooltipState = {
  visible: boolean;
  left: number;
  top: number;
  sideX: "left" | "right";
  sideY: "bottom" | "top";
  locked: boolean;
};

type ComparisonState = {
  className: string;
  label: string;
  interval: { low: number; high: number } | null;
};

type TooltipMoveEvent = PointerEvent<HTMLElement> | MouseEvent<HTMLElement>;
type BarMoveEvent = PointerEvent<HTMLDivElement> | MouseEvent<HTMLDivElement>;
type IntervalTooltipHandlers = {
  onIntervalBlur: () => void;
  onIntervalFocus: (event: FocusEvent<HTMLButtonElement>) => void;
  onIntervalPointerDown: (event: PointerEvent<HTMLButtonElement>) => void;
  onIntervalPointerEnter: (event: TooltipMoveEvent) => void;
  onIntervalPointerLeave: () => void;
  onIntervalPointerMove: (event: TooltipMoveEvent) => void;
};

const KIT_ORDER: Kit[] = ["blue", "purple", "yellow"];

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

const INTERVAL_TOOLTIP_MESSAGES = [
  "횟수가 적으면 우연히 결과가 좋거나 나쁠 수 있습니다.",
  "따라서 시도 횟수를 고려해 '결과값이 어느 정도 폭으로 움직일 수 있는지'를 보여줍니다.",
];
const INTERVAL_TOOLTIP_ID = "difficultyIntervalTooltip";

const classes = {
  panel:
    "panel stats-panel col-span-full min-w-0 rounded-card border border-border bg-surface shadow-panel [contain:layout_paint] [transform:translateZ(0)] transition-[background-color,border-color,box-shadow] duration-[220ms]",
  heading:
    "section-heading flex items-center justify-between gap-3 border-b border-border px-[18px] py-4 transition-[border-color,background-color,color] duration-[220ms] max-mobile:px-3.5 max-mobile:py-[11px] max-mobile:[&_h2]:text-[16px]",
  panelEmpty: "empty-result px-[18px] py-[22px] font-medium text-muted",
  resultContent:
    "result-content stats-content grid gap-3.5 p-[18px] max-mobile:gap-2.5 max-mobile:px-3.5 max-mobile:py-3",
  layout: "stats-layout grid grid-cols-2 gap-3 max-tablet:grid-cols-1",
  column: "stats-column grid min-w-0 content-start gap-3",
  section:
    "stats-section grid min-w-0 content-start gap-3.5 rounded-card border border-border bg-[linear-gradient(180deg,color-mix(in_srgb,var(--surface-raised)_86%,var(--grade-active-soft)),var(--surface-strong))] p-[15px] max-mobile:gap-2.5 max-mobile:rounded-control max-mobile:p-3",
  sectionTitle: "stats-section-title flex min-w-0 items-center justify-between gap-2.5",
  sectionHeading:
    "m-0 text-[15px] font-semibold leading-[1.25] text-text-strong max-mobile:text-[14px]",
  sectionMeta: "text-right text-[11px] font-medium text-muted whitespace-normal",
  overallStack: "overall-stats-stack grid gap-2.5",
  overallWindow:
    "overall-stats-window grid min-w-0 gap-2 rounded-card border border-border bg-surface-raised p-[11px] max-mobile:p-2.5",
  overallWindowHead:
    "overall-stats-window-head flex min-w-0 items-baseline justify-between gap-2 max-mobile:grid max-mobile:gap-[3px]",
  overallWindowTitle: "text-[13px] font-semibold leading-[1.2] text-text-strong",
  overallWindowMeta:
    "text-right text-[11px] font-medium leading-[1.35] text-muted max-mobile:text-left",
  empty: "stats-empty m-0 text-[12px] font-normal leading-[1.45] text-muted",
  note: "stats-note m-0 text-[11px] font-normal leading-[1.45] text-muted [overflow-wrap:break-word] [word-break:keep-all]",
  disclaimer:
    "stats-disclaimer m-0 px-0.5 text-right text-[11px] font-normal leading-[1.45] text-muted [overflow-wrap:break-word] [word-break:keep-all]",
  difficultyList: "difficulty-list grid gap-0",
  difficultyRow:
    "difficulty-row flex min-w-0 flex-col gap-[7px] px-0.5 pb-3 pt-[15px] max-mobile:py-2.5 max-mobile:pb-3",
  difficultyRowBorder: "border-t border-border",
  difficultyHead: "difficulty-head flex min-w-0 items-center justify-between gap-2.5",
  difficultySegment:
    "difficulty-segment min-w-0 whitespace-nowrap text-[13px] font-semibold leading-[1.2] text-text-strong max-mobile:text-[12px]",
  difficultyTags: "difficulty-tags flex min-w-0 flex-wrap justify-end gap-[5px]",
  difficultyComparison:
    "difficulty-comparison whitespace-nowrap rounded-pill border border-[color-mix(in_srgb,var(--line)_76%,var(--grade-active))] bg-[color-mix(in_srgb,var(--surface-raised)_82%,var(--grade-active-soft))] px-2 py-[3px] text-[11px] font-medium leading-none text-muted",
  difficultyLabel:
    "difficulty-label whitespace-nowrap rounded-pill border border-border bg-surface-raised px-2 py-[3px] text-[11px] font-medium leading-none text-text-strong",
  rateBar:
    "difficulty-bar relative block h-[13px] w-full overflow-visible rounded-pill border-0 bg-progress-track p-0 text-left text-inherit [margin-block:12px_17px] [font:inherit] [user-select:none] cursor-default",
  kitRateBar:
    "kit-rate-bar relative block h-[13px] w-full overflow-visible rounded-pill border-0 bg-progress-track p-0 text-left text-inherit [margin-block:12px_17px] [font:inherit] [user-select:none] cursor-default",
  interval:
    "difficulty-interval absolute bottom-[-2px] top-[-2px] z-[3] min-w-[14px] cursor-help appearance-none rounded-pill border border-[color-mix(in_srgb,var(--grade-active)_38%,transparent)] bg-[color-mix(in_srgb,var(--grade-active-soft)_65%,transparent)] p-0 focus-visible:outline-none focus-visible:shadow-[0_0_0_3px_color-mix(in_srgb,var(--grade-active)_24%,transparent)]",
  observed:
    "difficulty-observed relative z-[1] block h-full rounded-pill transition-[width] duration-[240ms] ease-[ease]",
  observedDefault: "bg-[linear-gradient(90deg,var(--blue),var(--purple),var(--yellow))]",
  observedGood: "bg-[linear-gradient(90deg,#22b573,#46d28f)]",
  observedBad: "bg-[linear-gradient(90deg,#ef5350,#ff8a65)]",
  observedNeutral: "bg-[linear-gradient(90deg,var(--blue),var(--purple))]",
  theoryMarker: "difficulty-theory absolute bottom-0 top-0 z-[2] w-0.5 -translate-x-px bg-muted",
  theoryMarkerLabel:
    "absolute bottom-[calc(100%+4px)] left-1/2 whitespace-nowrap text-[10px] font-medium leading-none text-muted -translate-x-1/2",
  theoryMarkerLabelLow: "left-0 translate-x-0",
  theoryMarkerLabelHigh: "left-auto right-0 translate-x-0",
  actualMarker: "difficulty-actual absolute top-[calc(100%+5px)] z-[2] w-0 -translate-x-1/2",
  actualMarkerLow: "translate-x-0",
  actualMarkerHigh: "!left-auto right-0 translate-x-0",
  actualMarkerLabel:
    "absolute left-1/2 whitespace-nowrap text-[12px] font-medium leading-none text-text-strong -translate-x-1/2",
  actualMarkerLabelLow: "left-0 translate-x-0",
  actualMarkerLabelHigh: "left-auto right-0 translate-x-0",
  tooltip:
    "difficulty-tooltip pointer-events-none invisible fixed left-0 top-0 z-[9999] grid w-max max-w-[min(380px,calc(100vw-44px))] gap-[7px] rounded-[10px] border border-[rgba(255,255,255,0.14)] bg-[rgba(22,28,38,0.88)] px-3 py-2.5 text-[#f8fcfe] opacity-0 shadow-[0_14px_32px_rgba(10,18,30,0.22)] transition-opacity duration-[160ms] [--tooltip-motion-y:4px] [--tooltip-offset-x:0px] [--tooltip-offset-y:0px] [transform:translate(var(--tooltip-offset-x),calc(var(--tooltip-offset-y)+var(--tooltip-motion-y)))]",
  tooltipVisible: "is-visible visible opacity-100 [--tooltip-motion-y:0px]",
  tooltipLeft: "side-left [--tooltip-offset-x:-100%]",
  tooltipTop: "side-top [--tooltip-offset-y:-100%]",
  tooltipMessage:
    "difficulty-tooltip-message grid max-w-[calc(100vw-40px)] gap-1.5 text-[12px] font-light leading-[1.65] text-[#f8fcfe] [inline-size:clamp(240px,42vw,360px)] [overflow-wrap:break-word] [text-wrap:pretty] [word-break:keep-all] whitespace-normal",
  tooltipParagraph: "m-0",
  kitRateList: "kit-rate-list grid gap-3",
  kitRateRow: "kit-rate-row grid min-w-0 gap-[7px]",
  kitRateRowBorder: "border-t border-border pt-3",
  kitRateHead: "kit-rate-head flex min-w-0 items-center justify-between gap-2.5",
  kitRateName:
    "kit-rate-name inline-flex min-w-0 items-center text-[13px] font-semibold leading-[1.2] text-text-strong [word-break:keep-all]",
  kitRateDot: "mr-[7px] size-[9px] flex-none rounded-pill",
  kitRateMeta:
    "kit-rate-meta m-0 text-[11px] font-medium leading-[1.45] text-muted [overflow-wrap:break-word] [word-break:keep-all]",
} as const;

function joinClasses(...items: Array<string | false | null | undefined>) {
  return items.filter(Boolean).join(" ");
}

function normalizeSegmentLabel(label: string) {
  const text = String(label || "");
  const match = text.match(/^(R|SR)\s*(\d+)\D+(\d+)$/);
  if (match) return `${match[1]} ${match[2]} → ${match[3]}`;
  return text.replace(/->/g, "→").replace(/\s*→\s*/g, " → ");
}

function comparisonState(
  greatSuccesses: number,
  attempts: number,
  theoreticalRate: number,
): ComparisonState {
  if (attempts <= 0) return { className: "", interval: null, label: "집계 대기" };
  const interval = wilsonInterval(greatSuccesses, attempts);
  if (attempts < 5) return { className: "luck-neutral", interval, label: "표본 부족" };
  if (theoreticalRate < interval.low) {
    return { className: "luck-good", interval, label: "기대 대비 높음" };
  }
  if (theoreticalRate > interval.high) {
    return { className: "luck-bad", interval, label: "기대 대비 낮음" };
  }
  return { className: "luck-neutral", interval, label: "기대 범위 내" };
}

function difficultyLabel(attempts: number, theoreticalRate: number) {
  if (!attempts) return "집계 대기";
  if (theoreticalRate >= 0.5) return "쉬움";
  if (theoreticalRate >= 0.15) return "보통";
  return "어려움";
}

function percentPosition(rate: number) {
  return Math.min(100, Math.max(0, rate * 100));
}

function positionTooltip(
  clientX: number,
  clientY: number,
): Pick<TooltipState, "left" | "sideX" | "sideY" | "top"> {
  const padding = 10;
  const gap = 12;
  const tooltipElement =
    typeof document === "undefined"
      ? null
      : document.querySelector<HTMLElement>(".difficulty-tooltip");
  const tooltipRect = tooltipElement?.getBoundingClientRect();
  const tooltipWidth =
    tooltipRect && tooltipRect.width > 180
      ? tooltipRect.width
      : Math.min(320, window.innerWidth - padding * 2);
  const tooltipHeight = tooltipRect && tooltipRect.height > 50 ? tooltipRect.height : 92;
  const maxRightAnchor = Math.max(padding, window.innerWidth - padding - tooltipWidth);
  const maxBottomAnchor = Math.max(padding, window.innerHeight - padding - tooltipHeight);

  let sideX: TooltipState["sideX"] = "right";
  let anchorX = clientX + gap;
  const rightOverflow = anchorX + tooltipWidth > window.innerWidth - padding;
  const leftAnchor = clientX - gap;
  const leftEdgeAfterFlip = leftAnchor - tooltipWidth;

  if (rightOverflow && leftEdgeAfterFlip >= padding) {
    sideX = "left";
    anchorX = leftAnchor;
  } else if (sideX === "right") {
    anchorX = Math.min(Math.max(anchorX, padding), maxRightAnchor);
  }

  let sideY: TooltipState["sideY"] = "bottom";
  let anchorY = clientY + gap;
  const bottomOverflow = anchorY + tooltipHeight > window.innerHeight - padding;
  const topAnchor = clientY - gap;
  const topEdgeAfterFlip = topAnchor - tooltipHeight;

  if (bottomOverflow && topEdgeAfterFlip >= padding) {
    sideY = "top";
    anchorY = topAnchor;
  } else if (sideY === "bottom") {
    anchorY = Math.min(Math.max(anchorY, padding), maxBottomAnchor);
  }

  return { left: anchorX, sideX, sideY, top: anchorY };
}

function DifficultyTooltip({ tooltip }: { tooltip: TooltipState }) {
  if (typeof document === "undefined") return null;

  const tooltipStyle = {
    "--tooltip-motion-y": tooltip.visible ? "0px" : "4px",
    "--tooltip-offset-x": tooltip.sideX === "left" ? "-100%" : "0px",
    "--tooltip-offset-y": tooltip.sideY === "top" ? "-100%" : "0px",
    left: `${tooltip.left}px`,
    top: `${tooltip.top}px`,
  } as CSSProperties;

  return createPortal(
    <div
      className={joinClasses(
        classes.tooltip,
        tooltip.sideX === "left" && classes.tooltipLeft,
        tooltip.sideY === "top" && classes.tooltipTop,
        tooltip.visible && classes.tooltipVisible,
      )}
      id={INTERVAL_TOOLTIP_ID}
      role="tooltip"
      style={tooltipStyle}
    >
      <div className={classes.tooltipMessage}>
        {INTERVAL_TOOLTIP_MESSAGES.map((message) => (
          <p className={classes.tooltipParagraph} key={message}>
            {message}
          </p>
        ))}
      </div>
    </div>,
    document.body,
  );
}

function RateBar({
  actualRate,
  attempts,
  barClassName = classes.rateBar,
  comparison,
  onIntervalBlur,
  onIntervalFocus,
  onIntervalPointerDown,
  onIntervalPointerEnter,
  onIntervalPointerLeave,
  onIntervalPointerMove,
  theoreticalRate,
}: {
  actualRate: number;
  attempts: number;
  barClassName?: string;
  comparison: ComparisonState;
  onIntervalBlur?: IntervalTooltipHandlers["onIntervalBlur"];
  onIntervalFocus?: IntervalTooltipHandlers["onIntervalFocus"];
  onIntervalPointerDown?: IntervalTooltipHandlers["onIntervalPointerDown"];
  onIntervalPointerEnter?: IntervalTooltipHandlers["onIntervalPointerEnter"];
  onIntervalPointerLeave?: IntervalTooltipHandlers["onIntervalPointerLeave"];
  onIntervalPointerMove?: IntervalTooltipHandlers["onIntervalPointerMove"];
  theoreticalRate: number;
}) {
  const actualPercent = percentPosition(actualRate);
  const theoreticalPercent = percentPosition(theoreticalRate);
  const actualWidth = attempts > 0 ? Math.max(1, actualPercent) : 0;
  const markerEdge = theoreticalPercent <= 12 ? "low" : theoreticalPercent >= 88 ? "high" : "";
  const actualEdge = actualWidth <= 12 ? "low" : actualWidth >= 88 ? "high" : "";
  const intervalLeft = comparison.interval ? percentPosition(comparison.interval.low) : 0;
  const intervalRight = comparison.interval ? percentPosition(comparison.interval.high) : 0;
  const intervalWidth = Math.max(0, intervalRight - intervalLeft);
  const observedTone =
    comparison.className === "luck-good"
      ? classes.observedGood
      : comparison.className === "luck-bad"
        ? classes.observedBad
        : comparison.className === "luck-neutral"
          ? classes.observedNeutral
          : classes.observedDefault;
  const isInsideInterval = (event: BarMoveEvent) => {
    if (!comparison.interval) return false;
    const rect = event.currentTarget.getBoundingClientRect();
    if (rect.width <= 0) return false;
    const xPercent = ((event.clientX - rect.left) / rect.width) * 100;
    return xPercent >= intervalLeft && xPercent <= intervalRight;
  };
  const handleBarMove = (event: BarMoveEvent) => {
    if (isInsideInterval(event)) onIntervalPointerMove?.(event);
    else onIntervalPointerLeave?.();
  };

  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: The bar passively tracks pointer position so only the interval band opens the tooltip.
    <div
      className={barClassName}
      onMouseLeave={onIntervalPointerLeave}
      onMouseMove={handleBarMove}
      onPointerLeave={onIntervalPointerLeave}
      onPointerMove={handleBarMove}
    >
      {comparison.interval ? (
        <button
          aria-describedby={INTERVAL_TOOLTIP_ID}
          aria-label="기대 범위 설명"
          className={classes.interval}
          onBlur={onIntervalBlur}
          onFocus={onIntervalFocus}
          onMouseEnter={onIntervalPointerEnter}
          onMouseLeave={onIntervalPointerLeave}
          onMouseMove={onIntervalPointerMove}
          onPointerDown={onIntervalPointerDown}
          onPointerEnter={onIntervalPointerEnter}
          onPointerLeave={onIntervalPointerLeave}
          onPointerMove={onIntervalPointerMove}
          style={{ left: `${intervalLeft}%`, width: `${intervalWidth}%` }}
          type="button"
        ></button>
      ) : null}
      <div
        className={joinClasses(classes.observed, observedTone)}
        style={{ width: `${actualWidth}%` }}
      ></div>
      <div
        className={joinClasses(classes.theoryMarker, markerEdge === "high" && "edge-high")}
        style={{ left: `${theoreticalPercent}%` }}
      >
        <span
          className={joinClasses(
            classes.theoryMarkerLabel,
            markerEdge === "low" && classes.theoryMarkerLabelLow,
            markerEdge === "high" && classes.theoryMarkerLabelHigh,
          )}
        >
          기대값 {attempts ? formatPercent(theoreticalRate, 1) : "-"}
        </span>
      </div>
      <div
        className={joinClasses(
          classes.actualMarker,
          actualEdge === "low" && classes.actualMarkerLow,
          actualEdge === "high" && "edge-high",
          actualEdge === "high" && classes.actualMarkerHigh,
        )}
        style={actualEdge === "high" ? undefined : { left: `${actualWidth}%` }}
      >
        <span
          className={joinClasses(
            classes.actualMarkerLabel,
            actualEdge === "low" && classes.actualMarkerLabelLow,
            actualEdge === "high" && classes.actualMarkerLabelHigh,
          )}
        >
          실측 {attempts ? formatPercent(actualRate, 1) : "-"}
        </span>
      </div>
    </div>
  );
}

function DifficultyRow({
  index,
  item,
  tooltipHandlers,
}: {
  index: number;
  item: SegmentStat;
  tooltipHandlers: IntervalTooltipHandlers;
}) {
  const attempts = Number(item.attempts || 0);
  const actualRate = Number(item.greatSuccessRate || 0);
  const theoreticalRate = Number(item.theoreticalGreatSuccessRate || item.theoreticalRate || 0);
  const greatSuccesses = Number(item.greatSuccesses || 0);
  const comparison = comparisonState(greatSuccesses, attempts, theoreticalRate);
  const label = difficultyLabel(attempts, theoreticalRate);

  return (
    <div
      className={joinClasses(
        classes.difficultyRow,
        index > 0 && classes.difficultyRowBorder,
        comparison.className,
      )}
    >
      <div className={classes.difficultyHead}>
        <span className={classes.difficultySegment}>{normalizeSegmentLabel(item.label)}</span>
        <span className={classes.difficultyTags}>
          <span className={classes.difficultyComparison}>{comparison.label}</span>
          <span className={classes.difficultyLabel}>{label}</span>
        </span>
      </div>
      <RateBar
        actualRate={actualRate}
        attempts={attempts}
        comparison={comparison}
        {...tooltipHandlers}
        theoreticalRate={theoreticalRate}
      />
    </div>
  );
}

type OverallStatsSummary = NonNullable<GlobalStats["summary"]>;

function OverallStatsWindow({
  note,
  summary,
  title,
}: {
  note?: string;
  summary?: Partial<OverallStatsSummary>;
  title: string;
}) {
  const attempts = Number(summary?.attempts || 0);
  const events = Number(summary?.events || 0);
  const greatSuccesses = Number(summary?.greatSuccesses || 0);

  return (
    <article className={classes.overallWindow}>
      <div className={classes.overallWindowHead}>
        <strong className={classes.overallWindowTitle}>{title}</strong>
        <span className={classes.overallWindowMeta}>
          {formatInteger(attempts)}시도 / {formatInteger(events)}입력 · 대성공{" "}
          {formatInteger(greatSuccesses)}회
        </span>
      </div>
      {note ? <p className={classes.note}>{note}</p> : null}
    </article>
  );
}

function OverallStats({ stats }: { stats: GlobalStats }) {
  const cumulative = stats.cumulative;
  const cumulativeSummary = cumulative?.summary;

  return (
    <section className={`${classes.section} stats-overall-section`}>
      <div className={classes.sectionTitle}>
        <h3 className={classes.sectionHeading}>전체 대성공률</h3>
        <span className={classes.sectionMeta}>누적 중심</span>
      </div>
      <div className={classes.overallStack}>
        <OverallStatsWindow
          note={cumulative ? undefined : "누적 통계는 최신 Worker 배포 후 표시됩니다."}
          summary={cumulativeSummary}
          title="누적 입력 표본"
        />
      </div>
      <p className={classes.note}>
        기대값은 실제 기록된 레벨·키트 조합의 이론 확률을 시도수로 가중평균한 값입니다.
      </p>
    </section>
  );
}

function KitRateRow({
  index,
  item,
  tooltipHandlers,
}: {
  index: number;
  item: KitStat;
  tooltipHandlers: IntervalTooltipHandlers;
}) {
  const kit = item.kit;
  if (!kit) return null;
  const attempts = Number(item.attempts || 0);
  const greatSuccesses = Number(item.greatSuccesses || 0);
  const actualRate = Number(item.greatSuccessRate || 0);
  const theoreticalRate = Number(item.theoreticalGreatSuccessRate || 0);
  const comparison = comparisonState(greatSuccesses, attempts, theoreticalRate);

  return (
    <div
      className={joinClasses(
        classes.kitRateRow,
        index > 0 && classes.kitRateRowBorder,
        comparison.className,
      )}
    >
      <div className={classes.kitRateHead}>
        <span className={joinClasses(classes.kitRateName, kit)}>
          <i aria-hidden="true" className={`${classes.kitRateDot} ${kitDotClass[kit]}`}></i>
          {KIT_LABELS[kit]}
        </span>
        <span className={classes.difficultyComparison}>{comparison.label}</span>
      </div>
      <RateBar
        actualRate={actualRate}
        attempts={attempts}
        barClassName={classes.kitRateBar}
        comparison={comparison}
        {...tooltipHandlers}
        theoreticalRate={theoreticalRate}
      />
      <p className={classes.kitRateMeta}>{formatInteger(attempts)}시도</p>
    </div>
  );
}

function KitStats({
  stats,
  tooltipHandlers,
}: {
  stats: GlobalStats;
  tooltipHandlers: IntervalTooltipHandlers;
}) {
  const byKit = Array.isArray(stats.byKit) ? stats.byKit : [];
  return (
    <section className={`${classes.section} stats-kit-section`}>
      <div className={classes.sectionTitle}>
        <h3 className={classes.sectionHeading}>키트별 대성공률</h3>
        <span className={classes.sectionMeta}>기대값 vs 실측</span>
      </div>
      {byKit.length ? (
        <div className={classes.kitRateList}>
          {KIT_ORDER.map((kit, index) => {
            const item = byKit.find((row) => row.kit === kit) || { kit };
            return (
              <KitRateRow index={index} item={item} key={kit} tooltipHandlers={tooltipHandlers} />
            );
          })}
        </div>
      ) : (
        <p className={classes.empty}>아직 키트별 통계가 없습니다.</p>
      )}
    </section>
  );
}

function StatsContent({ stats }: { stats: GlobalStats }) {
  const [tooltip, setTooltip] = useState<TooltipState>({
    visible: false,
    left: 0,
    sideX: "right",
    sideY: "bottom",
    top: 0,
    locked: false,
  });
  const segmentRows = Array.isArray(stats.segmentStats) ? stats.segmentStats : [];

  useEffect(() => {
    if (!tooltip.locked) return;
    const closeLockedTooltip = (event: globalThis.PointerEvent) => {
      const target = event.target;
      if (!(target instanceof Element)) return;
      if (target.closest(".difficulty-interval") || target.closest(".difficulty-tooltip")) return;
      setTooltip((current) => ({ ...current, locked: false, visible: false }));
    };
    document.addEventListener("pointerdown", closeLockedTooltip, true);
    return () => document.removeEventListener("pointerdown", closeLockedTooltip, true);
  }, [tooltip.locked]);

  useEffect(() => {
    if (!tooltip.visible) return;
    const closeTooltipOnEscape = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      setTooltip((current) => ({ ...current, locked: false, visible: false }));
    };
    document.addEventListener("keydown", closeTooltipOnEscape);
    return () => document.removeEventListener("keydown", closeTooltipOnEscape);
  }, [tooltip.visible]);

  const moveTooltip = (event: TooltipMoveEvent) => {
    const nextPosition = positionTooltip(event.clientX, event.clientY);
    setTooltip((current) => ({ ...current, visible: true, ...nextPosition }));
  };

  const showTooltipFromFocus = (event: FocusEvent<HTMLButtonElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const nextPosition = positionTooltip(rect.left + rect.width / 2, rect.top + rect.height / 2);
    setTooltip((current) =>
      current.visible
        ? { ...current, locked: false, visible: true }
        : { ...current, locked: false, visible: true, ...nextPosition },
    );
  };

  const lockTooltip = (event: PointerEvent<HTMLButtonElement>) => {
    if (event.pointerType === "mouse") return;
    event.preventDefault();
    event.stopPropagation();
    const nextPosition = positionTooltip(event.clientX, event.clientY);
    setTooltip((current) => ({ ...current, locked: true, visible: true, ...nextPosition }));
  };

  const hideTooltip = () => {
    setTooltip((current) => (current.locked ? current : { ...current, visible: false }));
  };
  const intervalTooltipHandlers: IntervalTooltipHandlers = {
    onIntervalBlur: hideTooltip,
    onIntervalFocus: showTooltipFromFocus,
    onIntervalPointerDown: lockTooltip,
    onIntervalPointerEnter: moveTooltip,
    onIntervalPointerLeave: hideTooltip,
    onIntervalPointerMove: moveTooltip,
  };

  return (
    <div className={classes.resultContent}>
      <div className={classes.layout}>
        <div className={classes.column}>
          <OverallStats stats={stats} />
          <KitStats stats={stats} tooltipHandlers={intervalTooltipHandlers} />
        </div>
        <section className={classes.section}>
          <div className={classes.sectionTitle}>
            <h3 className={classes.sectionHeading}>구간별 체감 난이도</h3>
            <span className={classes.sectionMeta}>기록된 키트 조합 기준</span>
          </div>
          {segmentRows.length ? (
            <div className={classes.difficultyList}>
              {segmentRows.map((row, index) => (
                <DifficultyRow
                  index={index}
                  item={row}
                  key={row.key}
                  tooltipHandlers={intervalTooltipHandlers}
                />
              ))}
            </div>
          ) : (
            <p className={classes.empty}>아직 구간별 통계가 없습니다.</p>
          )}
        </section>
      </div>
      <p className={classes.disclaimer}>결과 입력 표본 기준 · 이벤트 단위 집계</p>
      <DifficultyTooltip tooltip={tooltip} />
    </div>
  );
}

export default function StatsPanel({ view }: StatsPanelProps) {
  return (
    <section id="globalStatsPanel" className={classes.panel} hidden={view.type === "hidden"}>
      <div className={classes.heading}>
        <h2>전체 통계</h2>
      </div>
      <div
        id="globalStatsBox"
        className={view.type === "empty" || view.type === "hidden" ? classes.panelEmpty : ""}
      >
        {view.type === "stats" ? (
          <StatsContent stats={view.stats} />
        ) : view.type === "empty" ? (
          view.message
        ) : (
          "통계 서버를 연결하면 전체 사용자의 결과가 표시됩니다."
        )}
      </div>
    </section>
  );
}
