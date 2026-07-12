import type { Dispatch, FocusEvent, PointerEvent, SetStateAction } from "react";
import { useState } from "react";

import { useDismissableLayer } from "../hooks/useDismissableLayer";
import type { StatsPanelModel, StatsView } from "../ui-types";
import { DifficultyStats, KitStats, OverallStats } from "./StatsPanelSections";
import {
  DifficultyTooltip,
  type IntervalTooltipHandlers,
  positionTooltip,
  type TooltipContent,
  type TooltipMoveEvent,
  type TooltipState,
  type UsageTooltipHandlers,
  type UsageTooltipItem,
} from "./StatsTooltip";
import { classes } from "./statsPanelStyles";

type StatsPanelProps = {
  view: StatsView;
};

type SetTooltip = Dispatch<SetStateAction<TooltipState>>;

function useStatsTooltips() {
  const [tooltip, setTooltip] = useState<TooltipState>({
    visible: false,
    left: 0,
    sideX: "right",
    sideY: "bottom",
    top: 0,
    locked: false,
    content: { type: "interval" },
  });
  useTooltipDismissal(tooltip, setTooltip);

  const hideTooltip = () => {
    setTooltip((current) => (current.locked ? current : { ...current, visible: false }));
  };

  return {
    intervalTooltipHandlers: useIntervalTooltipHandlers(setTooltip, hideTooltip),
    tooltip,
    usageTooltipHandlers: useUsageTooltipHandlers(setTooltip, hideTooltip),
  };
}

function useTooltipDismissal(tooltip: TooltipState, setTooltip: SetTooltip) {
  useDismissableLayer({
    escapeEnabled: tooltip.visible,
    outsideEnabled: tooltip.locked,
    containsTarget: (target) =>
      target instanceof Element &&
      Boolean(
        target.closest(".difficulty-interval") ||
          target.closest(".stats-usage-trigger") ||
          target.closest(".difficulty-tooltip"),
      ),
    onDismiss: () => {
      setTooltip((current) => ({ ...current, locked: false, visible: false }));
    },
  });
}

function useIntervalTooltipHandlers(
  setTooltip: SetTooltip,
  hideTooltip: () => void,
): IntervalTooltipHandlers {
  const moveTooltip = (event: TooltipMoveEvent) => {
    showTooltipAtPointer(setTooltip, event, { type: "interval" });
  };
  const showTooltipFromFocus = (event: FocusEvent<HTMLButtonElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const nextPosition = positionTooltip(rect.left + rect.width / 2, rect.top + rect.height / 2);
    setTooltip((current) =>
      current.visible
        ? { ...current, content: { type: "interval" }, locked: false, visible: true }
        : {
            ...current,
            content: { type: "interval" },
            locked: false,
            visible: true,
            ...nextPosition,
          },
    );
  };
  const lockTooltip = (event: PointerEvent<HTMLButtonElement>) => {
    if (event.pointerType === "mouse") return;
    event.preventDefault();
    event.stopPropagation();
    showTooltipAtPointer(setTooltip, event, { type: "interval" }, true);
  };
  return {
    onIntervalBlur: hideTooltip,
    onIntervalFocus: showTooltipFromFocus,
    onIntervalPointerDown: lockTooltip,
    onIntervalPointerEnter: moveTooltip,
    onIntervalPointerLeave: hideTooltip,
    onIntervalPointerMove: moveTooltip,
  };
}

function useUsageTooltipHandlers(
  setTooltip: SetTooltip,
  hideTooltip: () => void,
): UsageTooltipHandlers {
  const showUsageTooltip = (event: TooltipMoveEvent, items: UsageTooltipItem[]) => {
    showTooltipAtPointer(setTooltip, event, { type: "usage", items });
  };
  const lockUsageTooltip = (event: PointerEvent<HTMLElement>, items: UsageTooltipItem[]) => {
    if (event.pointerType === "mouse") return;
    event.preventDefault();
    event.stopPropagation();
    showTooltipAtPointer(setTooltip, event, { type: "usage", items }, true);
  };
  return {
    onUsagePointerDown: lockUsageTooltip,
    onUsagePointerEnter: showUsageTooltip,
    onUsagePointerLeave: hideTooltip,
    onUsagePointerMove: showUsageTooltip,
  };
}

function showTooltipAtPointer(
  setTooltip: SetTooltip,
  event: TooltipMoveEvent,
  content: TooltipContent,
  locked = false,
) {
  const nextPosition = positionTooltip(event.clientX, event.clientY);
  setTooltip((current) => ({ ...current, content, locked, visible: true, ...nextPosition }));
}

function StatsContent({ stats }: { stats: StatsPanelModel }) {
  const { intervalTooltipHandlers, tooltip, usageTooltipHandlers } = useStatsTooltips();

  return (
    <div className={classes.resultContent}>
      <div className={classes.layout}>
        <div className={classes.column}>
          <OverallStats stats={stats} />
          <KitStats stats={stats} tooltipHandlers={intervalTooltipHandlers} />
        </div>
        <DifficultyStats
          stats={stats}
          tooltipHandlers={intervalTooltipHandlers}
          usageTooltipHandlers={usageTooltipHandlers}
        />
      </div>
      <DifficultyTooltip tooltip={tooltip} />
    </div>
  );
}

function StatsBody({ view }: StatsPanelProps) {
  return (
    <div
      id="globalStatsBox"
      className={
        view.type === "empty" || view.type === "error" || view.type === "hidden"
          ? classes.panelEmpty
          : ""
      }
    >
      {view.type === "stats" ? (
        <StatsContent stats={view.stats} />
      ) : view.type === "empty" || view.type === "error" ? (
        view.message
      ) : (
        "통계 서버를 연결하면 전체 사용자의 결과가 표시됩니다."
      )}
    </div>
  );
}

export default function StatsPanelBody({ view }: StatsPanelProps) {
  return <StatsBody view={view} />;
}
