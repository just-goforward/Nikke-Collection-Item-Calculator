import type { MouseEvent, PointerEvent } from "react";

import { useI18n } from "../i18n/locale";
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

function observedDirectionClass(
  geometry: Pick<RateBarGeometry, "actualPercent" | "theoreticalPercent">,
) {
  if (geometry.actualPercent < geometry.theoreticalPercent) return classes.observedLeft;
  return classes.observedRight;
}

function eventInsideInterval(
  event: BarMoveEvent,
  comparison: ComparisonState,
  _geometry: Pick<RateBarGeometry, "intervalLeft" | "intervalRight">,
) {
  void event;
  if (!comparison.interval) return false;
  return true;
}

function IntervalBand({ handlers, visible }: { handlers: RateBarHandlers; visible: boolean }) {
  const { t } = useI18n();
  if (!visible) return null;
  return (
    <button
      aria-describedby={INTERVAL_TOOLTIP_ID}
      aria-label={t("stats.expectedRangeAria")}
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
      style={{ left: "0%", width: "100%" }}
      type="button"
    ></button>
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
      <IntervalBand handlers={intervalHandlers} visible={Boolean(comparison.interval)} />
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
