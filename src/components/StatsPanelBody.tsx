import type { Dispatch, FocusEvent, PointerEvent, SetStateAction } from "react";
import { useState } from "react";

import { useDismissableLayer } from "../hooks/useDismissableLayer";
import { useI18n } from "../i18n/locale";
import type { StatsPanelModel, StatsView } from "../ui-types";
import { DifficultyStats, KitStats, OverallStats } from "./StatsPanelSections";
import {
  DifficultyTooltip,
  type IntervalTooltipData,
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
  onRetry: () => void;
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
    content: { type: "interval", data: null },
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
  const moveTooltip = (event: TooltipMoveEvent, data: IntervalTooltipData) => {
    showTooltipAtPointer(setTooltip, event, { type: "interval", data });
  };
  const showTooltipFromFocus = (
    event: FocusEvent<HTMLButtonElement>,
    data: IntervalTooltipData,
  ) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const nextPosition = positionTooltip(rect.left + rect.width / 2, rect.top + rect.height / 2);
    setTooltip((current) =>
      current.visible
        ? { ...current, content: { type: "interval", data }, locked: false, visible: true }
        : {
            ...current,
            content: { type: "interval", data },
            locked: false,
            visible: true,
            ...nextPosition,
          },
    );
  };
  const lockTooltip = (event: PointerEvent<HTMLButtonElement>, data: IntervalTooltipData) => {
    if (event.pointerType === "mouse") return;
    event.preventDefault();
    event.stopPropagation();
    showTooltipAtPointer(setTooltip, event, { type: "interval", data }, true);
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
  const showUsageTooltip = (event: PointerEvent<HTMLButtonElement>, items: UsageTooltipItem[]) => {
    showTooltipAtPointer(setTooltip, event, { type: "usage", items });
  };
  const showUsageTooltipFromFocus = (
    event: FocusEvent<HTMLButtonElement>,
    items: UsageTooltipItem[],
  ) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const nextPosition = positionTooltip(rect.left + rect.width / 2, rect.top + rect.height / 2);
    setTooltip((current) => ({
      ...current,
      content: { type: "usage", items },
      locked: false,
      visible: true,
      ...nextPosition,
    }));
  };
  const lockUsageTooltip = (event: PointerEvent<HTMLButtonElement>, items: UsageTooltipItem[]) => {
    if (event.pointerType === "mouse") return;
    event.preventDefault();
    event.stopPropagation();
    showTooltipAtPointer(setTooltip, event, { type: "usage", items }, true);
  };
  return {
    onUsageBlur: hideTooltip,
    onUsageFocus: showUsageTooltipFromFocus,
    onUsagePointerDown: lockUsageTooltip,
    onUsagePointerEnter: showUsageTooltip,
    onUsagePointerLeave: hideTooltip,
    onUsagePointerMove: showUsageTooltip,
  };
}

function showTooltipAtPointer(
  setTooltip: SetTooltip,
  event: TooltipMoveEvent | PointerEvent<HTMLButtonElement>,
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

function StatsBody({ onRetry, view }: StatsPanelProps) {
  const { t, text } = useI18n();
  if (view.type === "loading") {
    return (
      <div
        id="globalStatsBox"
        className={classes.panelLoading}
        role="status"
        aria-live="polite"
        aria-busy="true"
      >
        <div className={classes.panelLoadingInner}>
          <span className={classes.panelLoadingSpinner} aria-hidden="true" />
          <p className={classes.panelLoadingText}>{t("stats.loading")}</p>
        </div>
      </div>
    );
  }

  return (
    <div
      id="globalStatsBox"
      className={
        view.type === "empty" ||
        view.type === "error" ||
        view.type === "hidden" ||
        view.type === "unconfigured"
          ? classes.panelEmpty
          : ""
      }
    >
      {view.type === "stats" ? (
        <StatsContent stats={view.stats} />
      ) : view.type === "error" ? (
        <div className={classes.errorMessage} role="alert">
          <p>{text(view.message)}</p>
          <button className={classes.retryButton} type="button" onClick={onRetry}>
            {t("stats.retry")}
          </button>
        </div>
      ) : view.type === "empty" || view.type === "unconfigured" ? (
        text(view.message)
      ) : (
        t("stats.unconfigured")
      )}
    </div>
  );
}

export default function StatsPanelBody({ onRetry, view }: StatsPanelProps) {
  return <StatsBody onRetry={onRetry} view={view} />;
}
