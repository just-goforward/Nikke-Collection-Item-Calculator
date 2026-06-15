import type { MouseEvent, PointerEvent } from "react";

import { formatPercent } from "../format";
import type { IntervalTooltipHandlers } from "./StatsTooltip";
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
  visible,
}: {
  geometry: Pick<RateBarGeometry, "intervalLeft" | "intervalWidth">;
  handlers: RateBarHandlers;
  visible: boolean;
}) {
  if (!visible) return null;
  return (
    <button
      aria-describedby={INTERVAL_TOOLTIP_ID}
      aria-label="기대 범위 설명"
      className={classes.interval}
      onBlur={handlers.onIntervalBlur}
      onFocus={handlers.onIntervalFocus}
      onMouseEnter={handlers.onIntervalPointerEnter}
      onMouseLeave={handlers.onIntervalPointerLeave}
      onMouseMove={handlers.onIntervalPointerMove}
      onPointerDown={handlers.onIntervalPointerDown}
      onPointerEnter={handlers.onIntervalPointerEnter}
      onPointerLeave={handlers.onIntervalPointerLeave}
      onPointerMove={handlers.onIntervalPointerMove}
      style={{ left: `${geometry.intervalLeft}%`, width: `${geometry.intervalWidth}%` }}
      type="button"
    ></button>
  );
}

function TheoryMarker({ attempts, theoreticalPercent, theoreticalRate }: RateBarGeometryPick) {
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
        기대값 {attempts ? formatPercent(theoreticalRate, 1) : "-"}
      </span>
    </div>
  );
}

type RateBarGeometryPick = Pick<RateBarGeometry, "theoreticalPercent"> & {
  attempts: number;
  theoreticalRate: number;
};

function ActualMarker({
  actualWidth,
  attempts,
  actualRate,
}: Pick<RateBarGeometry, "actualWidth"> & {
  attempts: number;
  actualRate: number;
}) {
  const edge = markerEdge(actualWidth);
  return (
    <div
      className={joinClasses(
        classes.actualMarker,
        edge === "low" && classes.actualMarkerLow,
        edge === "high" && "edge-high",
        edge === "high" && classes.actualMarkerHigh,
      )}
      style={edge === "high" ? undefined : { left: `${actualWidth}%` }}
    >
      <span
        className={joinClasses(
          classes.actualMarkerLabel,
          edge === "low" && classes.actualMarkerLabelLow,
          edge === "high" && classes.actualMarkerLabelHigh,
        )}
      >
        실측 {attempts ? formatPercent(actualRate, 1) : "-"}
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
  const intervalHandlers = {
    onIntervalBlur,
    onIntervalFocus,
    onIntervalPointerDown,
    onIntervalPointerEnter,
    onIntervalPointerLeave,
    onIntervalPointerMove,
  };
  const handleBarMove = (event: BarMoveEvent) => {
    if (eventInsideInterval(event, comparison, geometry)) onIntervalPointerMove?.(event);
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
      <IntervalBand
        geometry={geometry}
        handlers={intervalHandlers}
        visible={Boolean(comparison.interval)}
      />
      <div
        className={joinClasses(classes.observed, observedToneClass(comparison.className))}
        style={{ width: `${geometry.actualWidth}%` }}
      ></div>
      <TheoryMarker
        attempts={attempts}
        theoreticalPercent={geometry.theoreticalPercent}
        theoreticalRate={theoreticalRate}
      />
      <ActualMarker
        actualRate={actualRate}
        actualWidth={geometry.actualWidth}
        attempts={attempts}
      />
    </div>
  );
}
