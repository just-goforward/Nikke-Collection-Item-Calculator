import { formatInteger, formatNumber, formatPercent } from "../format";
import type { Kit } from "../types";
import type { ValidationSuccessDistributionView } from "../ui-types";

type MonteCarloValidationResult = {
  runs: number;
  completed: number;
  successProbability: number;
  vector?: Partial<Record<Kit, number>>;
  quantiles?: Record<Kit, { p50: number; p90: number; p95: number }>;
  depletion?: number;
};

function formatReadablePercent(value: number, digits = 4) {
  const percent = value * 100;
  const rounded = Number(percent.toFixed(digits));
  if (Math.abs(rounded - Math.round(rounded)) <= 1e-10) {
    return `${formatInteger(Math.round(rounded))}%`;
  }
  return `${formatNumber(rounded, digits)}%`;
}

export function makeBinomialCurvePoints(
  runs: number,
  probability: number,
  xMin: number,
  xMax: number,
) {
  if (probability <= 0 || probability >= 1 || xMax <= xMin) return [];
  const mode = Math.min(runs, Math.max(0, Math.floor((runs + 1) * probability)));
  const weights = new Map<number, number>([[mode, 1]]);

  for (let x = mode; x < xMax; x += 1) {
    const current = weights.get(x) || 0;
    const next =
      current * ((runs - x) / (x + 1)) * (probability / Math.max(1e-12, 1 - probability));
    weights.set(x + 1, Number.isFinite(next) ? next : 0);
  }

  for (let x = mode; x > xMin; x -= 1) {
    const current = weights.get(x) || 0;
    const previous =
      current * (x / (runs - x + 1)) * ((1 - probability) / Math.max(1e-12, probability));
    weights.set(x - 1, Number.isFinite(previous) ? previous : 0);
  }

  const maxWeight = Math.max(...weights.values(), 1e-12);
  const step = Math.max(1, Math.ceil((xMax - xMin) / 180));
  const points: Array<{ x: number; y: number }> = [];

  for (let x = xMin; x <= xMax; x += step) {
    points.push({ x, y: Math.max(0, Math.min(1, (weights.get(x) || 0) / maxWeight)) });
  }

  if (points[points.length - 1]?.x !== xMax) {
    points.push({ x: xMax, y: Math.max(0, Math.min(1, (weights.get(xMax) || 0) / maxWeight)) });
  }

  return points;
}

export function makeValidationCharts(
  monteCarlo: MonteCarloValidationResult,
  expectedProbability: number,
): { successDistribution: ValidationSuccessDistributionView } {
  const expected = Math.min(1, Math.max(0, Number(expectedProbability || 0)));
  const probability = Math.min(1, Math.max(0, Number(monteCarlo.successProbability || 0)));
  const runs = Math.max(1, Math.trunc(Number(monteCarlo.runs || 0)));
  const observedCount = Math.max(0, Math.min(runs, Math.trunc(Number(monteCarlo.completed || 0))));
  const meanCount = runs * expected;
  const variance = runs * expected * (1 - expected);
  const standardDeviation = Math.sqrt(Math.max(0, variance));
  const lowerCount = Math.max(0, Math.round(meanCount - 1.96 * standardDeviation));
  const upperCount = Math.min(runs, Math.round(meanCount + 1.96 * standardDeviation));
  const spread = Math.max(1, standardDeviation);
  let xMin = Math.max(0, Math.floor(Math.min(meanCount - 4 * spread, observedCount - spread)));
  let xMax = Math.min(runs, Math.ceil(Math.max(meanCount + 4 * spread, observedCount + spread)));

  if (xMax <= xMin) {
    xMin = Math.max(0, Math.floor(meanCount - 1));
    xMax = Math.min(runs, Math.ceil(meanCount + 1));
  }

  const deterministic = standardDeviation <= 1e-9;
  const skewness = variance > 0 ? (1 - 2 * expected) / Math.sqrt(variance) : 0;
  const excessKurtosis = variance > 0 ? (1 - 6 * expected * (1 - expected)) / variance : 0;

  return {
    successDistribution: {
      kind: deterministic ? "deterministic" : "binomial",
      expectedRateLabel: formatReadablePercent(expected, 4),
      observedRateLabel: formatPercent(probability, 2),
      expectedCountLabel: `평균 ${formatNumber(meanCount, 1)}명`,
      observedCountLabel: `이번 ${formatInteger(observedCount)}명`,
      intervalLabel: deterministic
        ? "결과 폭 없음"
        : `95% 근사 ${formatInteger(lowerCount)} ~ ${formatInteger(upperCount)}명`,
      standardDeviationLabel: `표준편차 ${formatNumber(standardDeviation, 1)}명`,
      skewnessLabel: `왜도 ${formatNumber(skewness, 3)}`,
      kurtosisLabel: `초과첨도 ${formatNumber(excessKurtosis, 3)}`,
      xMin,
      xMax,
      meanCount,
      observedCount,
      points: makeBinomialCurvePoints(runs, expected, xMin, xMax),
    },
  };
}
