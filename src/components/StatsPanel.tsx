import type { FocusEvent, PointerEvent } from "react";
import { useEffect, useState } from "react";

import type { GlobalStats, StatsView } from "../ui-types";
import { DifficultyStats, KitStats, OverallStats } from "./StatsPanelSections";
import {
  DifficultyTooltip,
  type IntervalTooltipHandlers,
  positionTooltip,
  type TooltipMoveEvent,
  type TooltipState,
} from "./StatsTooltip";
import { classes } from "./statsPanelStyles";

type StatsPanelProps = {
  view: StatsView;
};

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
        <DifficultyStats rows={segmentRows} tooltipHandlers={intervalTooltipHandlers} />
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
