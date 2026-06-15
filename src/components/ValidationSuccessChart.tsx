import type { ValidationSuccessDistributionView, ValidationView } from "../ui-types";

const classes = {
  validationGraphGrid: "grid max-w-[560px] gap-2.5",
  validationGraph:
    "rounded-card border border-border bg-surface px-3 py-2.5 text-[12px] text-text-soft",
  graphTitle: "text-[12px] font-semibold text-text-strong",
  graphMeta: "mt-1 text-[11px] font-medium leading-snug text-muted",
  probabilityTrack: "relative mt-3 h-[92px] rounded-control border border-border bg-surface-strong",
  probabilityCurve:
    "absolute left-2 top-2 h-[54px] w-[calc(100%_-_1rem)] overflow-visible text-grade-active [--curve-fill:color-mix(in_srgb,currentColor_18%,transparent)] [--curve-stroke:currentColor]",
  probabilityCurveArea: "fill-[var(--curve-fill)]",
  probabilityCurveLine: "fill-none stroke-[var(--curve-stroke)] stroke-[2]",
  probabilityAxisLine: "absolute left-2 right-2 bottom-6 h-px bg-border",
  probabilityMarker: "absolute bottom-6 top-2 w-px",
  probabilityExpected: "bg-grade-active",
  probabilityObserved: "bg-text-strong",
  probabilityMarkerLabel:
    "absolute top-[-1px] -translate-x-1/2 rounded-[3px] bg-surface px-1 text-[9px] font-semibold leading-4 text-muted shadow-sm",
  probabilityAxis:
    "absolute bottom-1 left-2 right-2 flex justify-between text-[10px] font-medium text-muted",
  probabilityLegend: "mt-2 flex flex-wrap gap-x-2 gap-y-1 text-[10px] font-medium text-muted",
  probabilityDot: "inline-block size-2 rounded-full",
} as const;

function distributionPosition(value: number, distribution: ValidationSuccessDistributionView) {
  const width = Math.max(1, distribution.xMax - distribution.xMin);
  return Math.max(0, Math.min(100, ((value - distribution.xMin) / width) * 100));
}

function distributionPath(distribution: ValidationSuccessDistributionView) {
  if (!distribution.points.length) return { line: "", area: "" };
  const first = distribution.points[0];
  const last = distribution.points.at(-1);
  if (!first || !last) return { line: "", area: "" };
  const toPoint = (point: { x: number; y: number }) => {
    const x = distributionPosition(point.x, distribution);
    const y = 48 - point.y * 38;
    return `${x.toFixed(2)},${y.toFixed(2)}`;
  };
  const line = distribution.points
    .map((point, index) => `${index === 0 ? "M" : "L"}${toPoint(point)}`)
    .join(" ");
  const firstX = distributionPosition(first.x, distribution).toFixed(2);
  const lastX = distributionPosition(last.x, distribution).toFixed(2);
  const area = `${line} L${lastX},50 L${firstX},50 Z`;
  return { line, area };
}

export function ValidationSuccessChart({ validation }: { validation: ValidationView }) {
  if (!validation.successDistribution) return null;
  const distribution = validation.successDistribution;
  const expectedPosition = `${distributionPosition(distribution.meanCount, distribution)}%`;
  const observedPosition = `${distributionPosition(distribution.observedCount, distribution)}%`;
  const { line, area } = distributionPath(distribution);
  return (
    <div className={classes.validationGraphGrid}>
      <div className={classes.validationGraph}>
        <div className={classes.graphTitle}>SR 15 도달 확률</div>
        <div className={classes.probabilityTrack}>
          {distribution.kind === "deterministic" ? (
            <span
              className={`${classes.probabilityMarker} ${classes.probabilityExpected}`}
              style={{ left: expectedPosition }}
              aria-hidden="true"
            />
          ) : (
            <svg
              aria-hidden="true"
              className={classes.probabilityCurve}
              preserveAspectRatio="none"
              viewBox="0 0 100 52"
            >
              <path className={classes.probabilityCurveArea} d={area} />
              <path className={classes.probabilityCurveLine} d={line} />
            </svg>
          )}
          <span className={classes.probabilityAxisLine} aria-hidden="true" />
          <span
            className={`${classes.probabilityMarker} ${classes.probabilityExpected}`}
            style={{ left: expectedPosition }}
            aria-hidden="true"
          >
            <span className={classes.probabilityMarkerLabel}>계산</span>
          </span>
          <span
            className={`${classes.probabilityMarker} ${classes.probabilityObserved}`}
            style={{ left: observedPosition }}
            aria-hidden="true"
          >
            <span className={classes.probabilityMarkerLabel}>검증</span>
          </span>
          <div className={classes.probabilityAxis}>
            <span>{Math.round(distribution.xMin)}명</span>
            <span>{distribution.expectedCountLabel}</span>
            <span>{Math.round(distribution.xMax)}명</span>
          </div>
        </div>
        <div className={classes.probabilityLegend}>
          <span>
            <i className={`${classes.probabilityDot} bg-grade-active/35`} /> 이항분포
          </span>
          <span>
            <i className={`${classes.probabilityDot} bg-grade-active`} /> 계산 기준
          </span>
          <span>
            <i className={`${classes.probabilityDot} bg-text-strong`} /> 이번 검증
          </span>
        </div>
        <p className={classes.graphMeta}>
          계산 기준 {distribution.expectedRateLabel}({distribution.expectedCountLabel}) · 이번 검증{" "}
          {distribution.observedRateLabel}({distribution.observedCountLabel}) ·{" "}
          {distribution.intervalLabel}
        </p>
        <p className={classes.graphMeta}>
          {distribution.standardDeviationLabel} · {distribution.skewnessLabel} ·{" "}
          {distribution.kurtosisLabel}
        </p>
      </div>
    </div>
  );
}
