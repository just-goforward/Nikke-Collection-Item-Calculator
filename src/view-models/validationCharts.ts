import type { Kit, StageReachPoint } from "../types";
import type { ValidationStageReachPointView, ValidationStageReachView } from "../ui-types";

type MonteCarloValidationResult = {
  runs: number;
  completed: number;
  successProbability: number;
  vector?: Partial<Record<Kit, number>>;
  quantiles?: Record<Kit, { p50: number; p90: number; p95: number }>;
  depletion?: number;
  stageReach?: StageReachPoint[];
};

const MAX_VISIBLE_STAGES = 6;
const AGGREGATE_THRESHOLD = 0.985;

type StageRun = {
  start: StageReachPoint;
  end: StageReachPoint;
  probabilityKey: number;
};

function stageRank(stage: Pick<StageReachPoint, "grade" | "level">) {
  return stage.grade === "SR" ? 15 + stage.level : stage.level;
}

function stageLabel(stage: Pick<StageReachPoint, "grade" | "level">) {
  return `${stage.grade} ${stage.level}`;
}

function displayedProbabilityKey(point: StageReachPoint) {
  return Math.round(Math.max(0, Math.min(1, Number(point.probability || 0))) * 1000);
}

function collapseStageRuns(points: StageReachPoint[]) {
  const sorted = [...points].sort((a, b) => stageRank(a) - stageRank(b));
  const runs: StageRun[] = [];

  for (const point of sorted) {
    const probabilityKey = displayedProbabilityKey(point);
    const current = runs.at(-1);
    if (current && current.probabilityKey === probabilityKey) {
      current.end = point;
      continue;
    }
    runs.push({ start: point, end: point, probabilityKey });
  }

  return runs;
}

function toStagePointView(
  point: StageReachPoint,
  runs: number,
  aggregateBelow = false,
  aggregateAbove = false,
): ValidationStageReachPointView {
  const reached = Math.max(0, Math.min(runs, Math.trunc(Number(point.reached || 0))));
  const probability = Math.max(0, Math.min(1, Number(point.probability || 0)));
  return {
    stateLabel: stageLabel(point),
    probability,
    reached,
    ...(aggregateBelow ? { aggregateBelow: true } : {}),
    ...(aggregateAbove ? { aggregateAbove: true } : {}),
  };
}

function fallbackStageReach(monteCarlo: MonteCarloValidationResult): StageReachPoint[] {
  return [
    {
      grade: "SR",
      level: 15,
      reached: Math.max(0, Math.trunc(Number(monteCarlo.completed || 0))),
      probability: Math.max(0, Math.min(1, Number(monteCarlo.successProbability || 0))),
    },
  ];
}

export function makeStageReachChart(
  monteCarlo: MonteCarloValidationResult,
): ValidationStageReachView {
  const runs = Math.max(1, Math.trunc(Number(monteCarlo.runs || 0)));
  const source = monteCarlo.stageReach?.length
    ? monteCarlo.stageReach
    : fallbackStageReach(monteCarlo);
  const collapsedRuns = collapseStageRuns(source);
  const selectedRuns =
    collapsedRuns.length > MAX_VISIBLE_STAGES
      ? collapsedRuns.slice(collapsedRuns.length - MAX_VISIBLE_STAGES)
      : collapsedRuns;

  const points = selectedRuns.map((run, index) => {
    const isFirstVisible = index === 0;
    const isLastVisible = index === selectedRuns.length - 1;
    const hiddenLowerStages = collapsedRuns[0] !== selectedRuns[0];
    const aggregateBelow =
      (isFirstVisible && hiddenLowerStages) ||
      (isFirstVisible && run.end.probability >= AGGREGATE_THRESHOLD && selectedRuns.length > 1);
    const aggregateAbove =
      isLastVisible &&
      stageRank(run.start) < stageRank(run.end) &&
      run.end.probability < AGGREGATE_THRESHOLD;
    const displayPoint = aggregateAbove ? run.start : run.end;
    return toStagePointView(displayPoint, runs, aggregateBelow, aggregateAbove);
  });

  return {
    runs,
    points,
  };
}

export function makeValidationCharts(
  monteCarlo: MonteCarloValidationResult,
  _expectedProbability: number,
): { stageReach: ValidationStageReachView } {
  return { stageReach: makeStageReachChart(monteCarlo) };
}
