import type { MouseEvent, PointerEvent } from "react";

import { useI18n } from "../i18n/locale";
import type { IntervalTooltipData, IntervalTooltipHandlers } from "./StatsTooltip";
import {
  type ComparisonState,
  markerEdge,
  type RateBarGeometry,
  rateBarGeometry,
} from "./statsPanelModel";
import { classes, INTERVAL_TOOLTIP_ID, joinClasses } from "./statsPanelStyles";

type BarMoveEvent = PointerEvent<HTMLDivElement> | MouseEvent<HTMLDivElement>;

type RateBarProps = {
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
};

type RateBarHandlers = {
  onIntervalBlur?: IntervalTooltipHandlers["onIntervalBlur"] | undefined;
  onIntervalFocus?: IntervalTooltipHandlers["onIntervalFocus"] | undefined;
  onIntervalPointerDown?: IntervalTooltipHandlers["onIntervalPointerDown"] | undefined;
  onIntervalPointerEnter?: IntervalTooltipHandlers["onIntervalPointerEnter"] | undefined;
  onIntervalPointerLeave?: IntervalTooltipHandlers["onIntervalPointerLeave"] | undefined;
  onIntervalPointerMove?: IntervalTooltipHandlers["onIntervalPointerMove"] | undefined;
};

function observedToneClass(comparisonClassName: string) {
  if (comparisonClassName === "luck-good") return classes.observedGood;
  if (comparisonClassName === "luck-bad") return classes.observedBad;
  if (comparisonClassName === "luck-neutral") return classes.observedNeutral;
  return classes.observedDefault;
}

function observedDirectionClass(
  geometry: Pick<RateBarGeometry, "actualPercent" | "theoreticalPercent">,
) {
  if (geometry.actualPercent < geometry.theoreticalPercent) return classes.observedLeft;
  return classes.observedRight;
}

function eventInsideInterval(
  event: BarMoveEvent,
  comparison: ComparisonState,
  geometry: Pick<RateBarGeometry, "intervalLeft" | "intervalRight">,
) {
  if (!comparison.interval) return false;
  const rect = event.currentTarget.getBoundingClientRect();
  if (rect.width <= 0) return false;
  const xPercent = ((event.clientX - rect.left) / rect.width) * 100;
  return xPercent >= geometry.intervalLeft && xPercent <= geometry.intervalRight;
}

function IntervalBand({
  geometry,
  handlers,
  tooltipData,
  visible,
}: {
  geometry: Pick<
    RateBarGeometry,
    "intervalClippedHigh" | "intervalClippedLow" | "intervalLeft" | "intervalWidth"
  >;
  handlers: RateBarHandlers;
  tooltipData: IntervalTooltipData | null;
  visible: boolean;
}) {
  const { formatInteger, formatPercent, t } = useI18n();
  if (!visible || !tooltipData) return null;
  return (
    <button
      aria-describedby={INTERVAL_TOOLTIP_ID}
      aria-label={t("stats.intervalRangeAria", {
        attempts: formatInteger(tooltipData.attempts),
        high: formatPercent(tooltipData.high, 1),
        low: formatPercent(tooltipData.low, 1),
      })}
      className={classes.interval}
      onBlur={handlers.onIntervalBlur}
      onFocus={(event) => handlers.onIntervalFocus?.(event, tooltipData)}
      onMouseEnter={(event) => handlers.onIntervalPointerEnter?.(event, tooltipData)}
      onMouseLeave={handlers.onIntervalPointerLeave}
      onMouseMove={(event) => handlers.onIntervalPointerMove?.(event, tooltipData)}
      onPointerDown={(event) => handlers.onIntervalPointerDown?.(event, tooltipData)}
      onPointerEnter={(event) => handlers.onIntervalPointerEnter?.(event, tooltipData)}
      onPointerLeave={handlers.onIntervalPointerLeave}
      onPointerMove={(event) => handlers.onIntervalPointerMove?.(event, tooltipData)}
      style={{ left: `${geometry.intervalLeft}%`, width: `${geometry.intervalWidth}%` }}
      type="button"
    >
      {geometry.intervalClippedLow ? (
        <span aria-hidden="true" className={`${classes.intervalEdge} ${classes.intervalEdgeLow}`}>
          ‹
        </span>
      ) : null}
      {geometry.intervalClippedHigh ? (
        <span aria-hidden="true" className={`${classes.intervalEdge} ${classes.intervalEdgeHigh}`}>
          ›
        </span>
      ) : null}
    </button>
  );
}

function TheoryMarker({ attempts, theoreticalPercent, theoreticalRate }: RateBarGeometryPick) {
  const { formatPercent, t } = useI18n();
  const edge = markerEdge(theoreticalPercent);
  return (
    <div
      className={joinClasses(classes.theoryMarker, edge === "high" && "edge-high")}
      style={{ left: `${theoreticalPercent}%` }}
    >
      <span
        className={joinClasses(
          classes.theoryMarkerLabel,
          edge === "low" && classes.theoryMarkerLabelLow,
          edge === "high" && classes.theoryMarkerLabelHigh,
        )}
      >
        {t("stats.expectedLabel", {
          value: attempts ? formatPercent(theoreticalRate, 1) : "-",
        })}
      </span>
    </div>
  );
}

type RateBarGeometryPick = Pick<RateBarGeometry, "theoreticalPercent"> & {
  attempts: number;
  theoreticalRate: number;
};

function ActualMarker({
  actualPercent,
  attempts,
  actualRate,
}: Pick<RateBarGeometry, "actualPercent"> & {
  attempts: number;
  actualRate: number;
}) {
  const { formatPercent, t } = useI18n();
  const edge = markerEdge(actualPercent);
  return (
    <div
      className={joinClasses(
        classes.actualMarker,
        edge === "low" && classes.actualMarkerLow,
        edge === "high" && "edge-high",
        edge === "high" && classes.actualMarkerHigh,
      )}
      style={edge === "high" ? undefined : { left: `${actualPercent}%` }}
    >
      <span
        className={joinClasses(
          classes.actualMarkerLabel,
          edge === "low" && classes.actualMarkerLabelLow,
          edge === "high" && classes.actualMarkerLabelHigh,
        )}
      >
        {t("stats.actualLabel", { value: attempts ? formatPercent(actualRate, 1) : "-" })}
      </span>
    </div>
  );
}

export function RateBar({
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
}: RateBarProps) {
  const geometry = rateBarGeometry(actualRate, attempts, comparison, theoreticalRate);
  const tooltipData: IntervalTooltipData | null = comparison.interval
    ? {
        attempts,
        clippedHigh: geometry.intervalClippedHigh,
        clippedLow: geometry.intervalClippedLow,
        high: comparison.interval.high,
        low: comparison.interval.low,
      }
    : null;
  const intervalHandlers = {
    onIntervalBlur,
    onIntervalFocus,
    onIntervalPointerDown,
    onIntervalPointerEnter,
    onIntervalPointerLeave,
    onIntervalPointerMove,
  };
  const handleBarMove = (event: BarMoveEvent) => {
    if (tooltipData && eventInsideInterval(event, comparison, geometry)) {
      onIntervalPointerMove?.(event, tooltipData);
    } else onIntervalPointerLeave?.();
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
      <IntervalBand
        geometry={geometry}
        handlers={intervalHandlers}
        tooltipData={tooltipData}
        visible={Boolean(tooltipData)}
      />
      <div
        className={joinClasses(
          classes.observed,
          observedDirectionClass(geometry),
          observedToneClass(comparison.className),
        )}
        style={{
          left: `${geometry.deviationLeft}%`,
          width: attempts ? `${geometry.deviationWidth}%` : "0%",
        }}
      ></div>
      <TheoryMarker
        attempts={attempts}
        theoreticalPercent={geometry.theoreticalPercent}
        theoreticalRate={theoreticalRate}
      />
      <ActualMarker
        actualRate={actualRate}
        actualPercent={geometry.actualPercent}
        attempts={attempts}
      />
    </div>
  );
}
