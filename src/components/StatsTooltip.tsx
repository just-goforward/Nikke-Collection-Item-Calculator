import type { CSSProperties, FocusEvent, MouseEvent, PointerEvent } from "react";
import { createPortal } from "react-dom";

import type { Kit } from "../types";
import {
  classes,
  INTERVAL_TOOLTIP_ID,
  INTERVAL_TOOLTIP_MESSAGES,
  joinClasses,
  KIT_LABELS,
  kitDotClass,
} from "./statsPanelStyles";

export type UsageTooltipItem = {
  kit: Kit;
  pieces: number;
};

export type TooltipContent = { type: "interval" } | { type: "usage"; items: UsageTooltipItem[] };

export type TooltipState = {
  visible: boolean;
  left: number;
  top: number;
  sideX: "left" | "right";
  sideY: "bottom" | "top";
  locked: boolean;
  content: TooltipContent;
};

export type TooltipMoveEvent = PointerEvent<HTMLElement> | MouseEvent<HTMLElement>;

export type IntervalTooltipHandlers = {
  onIntervalBlur: () => void;
  onIntervalFocus: (event: FocusEvent<HTMLButtonElement>) => void;
  onIntervalPointerDown: (event: PointerEvent<HTMLButtonElement>) => void;
  onIntervalPointerEnter: (event: TooltipMoveEvent) => void;
  onIntervalPointerLeave: () => void;
  onIntervalPointerMove: (event: TooltipMoveEvent) => void;
};

export type UsageTooltipHandlers = {
  onUsagePointerEnter: (event: TooltipMoveEvent, items: UsageTooltipItem[]) => void;
  onUsagePointerLeave: () => void;
  onUsagePointerMove: (event: TooltipMoveEvent, items: UsageTooltipItem[]) => void;
};

export function positionTooltip(
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

function UsageTooltipContent({ items }: { items: UsageTooltipItem[] }) {
  return (
    <div className={classes.tooltipUsageList}>
      {items.map((item) => (
        <div className={classes.tooltipUsageItem} key={item.kit}>
          <span className={classes.tooltipUsageKit}>
            <i
              aria-hidden="true"
              className={`${classes.tooltipUsageDot} ${kitDotClass[item.kit]}`}
            ></i>
            {KIT_LABELS[item.kit]}
          </span>
          <strong className={classes.tooltipUsageValue}>
            {item.pieces.toLocaleString("ko-KR")}개
          </strong>
        </div>
      ))}
    </div>
  );
}

export function DifficultyTooltip({ tooltip }: { tooltip: TooltipState }) {
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
      <div
        className={joinClasses(
          classes.tooltipMessage,
          tooltip.content.type === "usage" && classes.tooltipMessageUsage,
        )}
      >
        {tooltip.content.type === "usage" ? (
          <UsageTooltipContent items={tooltip.content.items} />
        ) : (
          INTERVAL_TOOLTIP_MESSAGES.map((message) => (
            <p className={classes.tooltipParagraph} key={message}>
              {message}
            </p>
          ))
        )}
      </div>
    </div>,
    document.body,
  );
}
