import type { ValidationStageReachView, ValidationView } from "../ui-types";

const classes = {
  chartCard:
    "grid max-w-[620px] gap-2.5 rounded-card border border-border bg-surface px-3 py-2.5 text-[12px] text-text-soft",
  header: "flex flex-wrap items-center justify-between gap-2",
  title: "text-[12px] font-semibold text-text-strong",
  badge:
    "rounded-control border border-grade-active/35 bg-grade-active/10 px-2 py-1 text-[11px] font-semibold text-grade-active-strong",
  canvasWrap:
    "rounded-card border border-border bg-surface-strong px-2.5 py-2 shadow-[inset_0_1px_0_rgba(255,255,255,0.025)]",
  canvas: "block h-auto w-full text-grade-active",
  grid: "stroke-border/70 stroke-[1]",
  axisLine: "stroke-muted/55 stroke-[1.1]",
  axisText: "fill-muted text-[9px] font-normal",
  stepLine:
    "fill-none stroke-grade-active stroke-[1.7] [stroke-linecap:round] [stroke-linejoin:round]",
  point: "fill-text-strong stroke-surface stroke-[2.2]",
  pointLabelBox: "fill-surface stroke-border stroke-[1]",
  pointText: "fill-text-strong text-[9px] font-medium",
  helper: "text-[11px] font-medium leading-snug text-muted",
} as const;

const CHART = {
  width: 340,
  height: 144,
  left: 42,
  right: 34,
  top: 16,
  bottom: 36,
} as const;

const plotWidth = CHART.width - CHART.left - CHART.right;
const plotHeight = CHART.height - CHART.top - CHART.bottom;
const plotBottom = CHART.height - CHART.bottom;
const plotRight = CHART.width - CHART.right;
const labelBoxWidth = 44;
const labelBoxHeight = 14;

function chartX(index: number, total: number) {
  if (total <= 1) return CHART.left + plotWidth / 2;
  return CHART.left + (index / (total - 1)) * plotWidth;
}

function chartY(probability: number) {
  return CHART.top + (1 - Math.max(0, Math.min(1, probability))) * plotHeight;
}

function stepPath(points: ValidationStageReachView["points"]) {
  if (!points.length) return "";
  const first = points[0];
  if (!first) return "";
  const commands = [
    `M${chartX(0, points.length).toFixed(2)},${chartY(first.probability).toFixed(2)}`,
  ];
  for (let index = 1; index < points.length; index += 1) {
    const point = points[index];
    if (!point) continue;
    const x = chartX(index, points.length).toFixed(2);
    const y = chartY(point.probability).toFixed(2);
    commands.push(`H${x}`);
    commands.push(`V${y}`);
  }
  return commands.join(" ");
}

function valueLabelPosition(index: number, total: number, x: number, y: number) {
  const clampedX = Math.max(
    CHART.left + labelBoxWidth / 2,
    Math.min(plotRight - labelBoxWidth / 2, x),
  );
  const isEdge = index === 0 || index === total - 1;
  const preferBelow = y < CHART.top + labelBoxHeight + 8 || isEdge;
  const boxY = preferBelow
    ? Math.min(plotBottom - labelBoxHeight - 4, y + 7)
    : Math.max(CHART.top + 2, y - labelBoxHeight - 9);
  return {
    boxX: clampedX - labelBoxWidth / 2,
    boxY,
    textX: clampedX,
    textY: boxY + 10,
  };
}

function axisLabelAnchor(index: number, total: number) {
  if (index === 0) return "start";
  if (index === total - 1) return "end";
  return "middle";
}

function axisLabelX(index: number, total: number, x: number) {
  if (index === 0) return Math.max(CHART.left, x - 2);
  if (index === total - 1) return Math.min(plotRight, x + 2);
  return x;
}

function StageReachSvg({ chart }: { chart: ValidationStageReachView }) {
  const path = stepPath(chart.points);
  return (
    <svg
      aria-label="단계별 도달률 계단 그래프"
      className={classes.canvas}
      role="img"
      viewBox={`0 0 ${CHART.width} ${CHART.height}`}
    >
      <line className={classes.grid} x1={CHART.left} x2={plotRight} y1={CHART.top} y2={CHART.top} />
      <line
        className={classes.grid}
        x1={CHART.left}
        x2={plotRight}
        y1={chartY(0.5)}
        y2={chartY(0.5)}
      />
      <line
        className={classes.grid}
        x1={CHART.left}
        x2={plotRight}
        y1={plotBottom}
        y2={plotBottom}
      />
      <line
        className={classes.axisLine}
        x1={CHART.left}
        x2={CHART.left}
        y1={CHART.top}
        y2={plotBottom}
      />
      <line
        className={classes.axisLine}
        x1={CHART.left}
        x2={plotRight}
        y1={plotBottom}
        y2={plotBottom}
      />
      <text className={classes.axisText} textAnchor="end" x={CHART.left - 6} y={CHART.top + 3}>
        100%
      </text>
      <text className={classes.axisText} textAnchor="end" x={CHART.left - 6} y={chartY(0.5) + 3}>
        50%
      </text>
      <text className={classes.axisText} textAnchor="end" x={CHART.left - 6} y={plotBottom + 3}>
        0%
      </text>
      <path className={classes.stepLine} d={path} />
      {chart.points.map((point, index) => {
        const x = chartX(index, chart.points.length);
        const y = chartY(point.probability);
        const valueLabel = valueLabelPosition(index, chart.points.length, x, y);
        const tickTextAnchor = axisLabelAnchor(index, chart.points.length);
        const tickX = axisLabelX(index, chart.points.length, x);
        return (
          <g key={point.label}>
            <circle className={classes.point} cx={x.toFixed(2)} cy={y.toFixed(2)} r="3.5" />
            <rect
              className={classes.pointLabelBox}
              height={labelBoxHeight}
              rx="4"
              width={labelBoxWidth}
              x={valueLabel.boxX.toFixed(2)}
              y={valueLabel.boxY.toFixed(2)}
            />
            <text
              className={classes.pointText}
              textAnchor="middle"
              x={valueLabel.textX.toFixed(2)}
              y={valueLabel.textY.toFixed(2)}
            >
              {point.reachedLabel}
            </text>
            <text
              className={classes.axisText}
              textAnchor={tickTextAnchor}
              x={tickX.toFixed(2)}
              y={CHART.height - 14}
            >
              {point.label}
            </text>
          </g>
        );
      })}
    </svg>
  );
}

export function ValidationSuccessChart({ validation }: { validation: ValidationView }) {
  if (!validation.stageReach) return null;
  return (
    <div className={classes.chartCard}>
      <div className={classes.header}>
        <div className={classes.title}>단계별 도달률</div>
        <div className={classes.badge}>{validation.stageReach.runsLabel}</div>
      </div>
      <div className={classes.canvasWrap}>
        <StageReachSvg chart={validation.stageReach} />
      </div>
      <p className={classes.helper}>
        각 지점은 해당 단계 이상까지 도달한 비율입니다. 오른쪽으로 갈수록 더 높은 목표 단계입니다.
      </p>
    </div>
  );
}
