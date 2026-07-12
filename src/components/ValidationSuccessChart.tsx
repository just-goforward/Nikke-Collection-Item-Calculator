import type { ValidationStageReachView, ValidationView } from "../ui-types";

const classes = {
  chartCard:
    "validation-chart-card grid min-h-[112px] w-full max-w-[620px] gap-[9px] rounded-card border border-border bg-surface px-3 py-2.5 text-[12px] text-text-soft",
  header: "flex flex-wrap items-center justify-between gap-2",
  title: "text-[11.5px] font-semibold text-text-strong",
  badge:
    "rounded-control border border-primary/35 bg-primary-soft px-2 py-1 text-[10px] font-semibold text-primary-strong",
  list: "m-0 grid list-none gap-2 px-0 py-0.5",
  row: "grid grid-cols-[86px_minmax(120px,1fr)_138px] items-center gap-2.5 max-mobile:grid-cols-[64px_minmax(90px,1fr)_112px] max-mobile:gap-2",
  targetRow: "",
  label: "text-[12px] font-semibold text-muted max-mobile:text-[11px]",
  targetLabel: "font-extrabold text-text-strong",
  track: "h-[9px] overflow-hidden rounded-pill bg-progress-track",
  fill: "block h-full rounded-pill bg-blue-kit transition-[width] duration-[420ms] ease-[cubic-bezier(0.2,0.8,0.2,1)]",
  targetFill: "bg-grade-active",
  value:
    "justify-self-end whitespace-nowrap text-right text-[12px] font-bold text-text-strong max-mobile:text-[11px]",
  targetValue: "text-[13.5px] font-extrabold max-mobile:text-[12px]",
  reached: "font-medium text-muted",
  loading:
    "validation-chart-loading grid min-h-[58px] place-items-center gap-2 text-center text-[11.5px] font-medium text-muted",
  spinner:
    "validation-chart-spinner size-5 animate-spin rounded-full border-[3px] border-primary-soft border-t-primary motion-reduce:animate-none",
} as const;

function StageReachBars({ chart }: { chart: ValidationStageReachView }) {
  return (
    <ul className={classes.list} aria-label="단계별 도달률">
      {chart.points.map((point, index) => {
        const isTarget = index === chart.points.length - 1;
        const percent = Math.max(0, Math.min(100, point.probability * 100));
        return (
          <li className={`${classes.row} ${isTarget ? classes.targetRow : ""}`} key={point.label}>
            <span className={`${classes.label} ${isTarget ? classes.targetLabel : ""}`}>
              {point.label}
            </span>
            <span className={classes.track} aria-hidden="true">
              <span
                className={`${classes.fill} ${isTarget ? classes.targetFill : ""}`}
                style={{ width: `${percent}%` }}
              />
            </span>
            <span className={`${classes.value} ${isTarget ? classes.targetValue : ""}`}>
              {point.percentLabel} <span className={classes.reached}>· {point.reachedLabel}</span>
            </span>
          </li>
        );
      })}
    </ul>
  );
}

function validationPlaceholderMessage(status: ValidationView["status"]) {
  if (status === "error") return "검산 그래프를 표시하지 못했습니다.";
  if (status === "cancelled") return "새 계산 결과에서 다시 검산할 수 있습니다.";
  if (status === "running") return "검산 결과를 계산하고 있습니다.";
  return "검산 결과를 기다리고 있습니다.";
}

function ValidationChartPlaceholder({ status }: { status: ValidationView["status"] }) {
  const loading = status === "running";
  return (
    <div className={classes.loading} aria-live="polite" role={loading ? "status" : undefined}>
      {loading ? <span className={classes.spinner} aria-hidden="true" /> : null}
      <span>{validationPlaceholderMessage(status)}</span>
    </div>
  );
}

export function ValidationSuccessChart({
  monteCarloRunsLabel,
  validation,
}: {
  monteCarloRunsLabel: string;
  validation: ValidationView;
}) {
  return (
    <div className={classes.chartCard} aria-busy={validation.status === "running"}>
      <div className={classes.header}>
        <div className={classes.title}>단계별 도달률</div>
        <div className={classes.badge}>
          {validation.stageReach?.runsLabel ?? `검산 ${monteCarloRunsLabel}명 기준`}
        </div>
      </div>
      {validation.stageReach ? (
        <StageReachBars chart={validation.stageReach} />
      ) : (
        <ValidationChartPlaceholder status={validation.status} />
      )}
    </div>
  );
}
