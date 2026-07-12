import { wilsonInterval } from "../lib/stats/binomial";
import type { KitStat } from "../ui-types";

export type ComparisonState = {
  className: string;
  interval: { low: number; high: number } | null;
};

export type RateBarGeometry = {
  actualWidth: number;
  actualPercent: number;
  deviationLeft: number;
  deviationWidth: number;
  intervalLeft: number;
  intervalRight: number;
  intervalWidth: number;
  theoreticalPercent: number;
};

export function weightedTheoryRate(rows: KitStat[] = []) {
  const attempts = rows.reduce((sum, item) => sum + Number(item.attempts || 0), 0);
  if (!attempts) return 0;
  return (
    rows.reduce(
      (sum, item) =>
        sum + Number(item.theoreticalGreatSuccessRate || 0) * Number(item.attempts || 0),
      0,
    ) / attempts
  );
}

export function normalizeSegmentLabel(label: string) {
  const text = String(label || "");
  const match = text.match(/^(R|SR)\s*(\d+)\D+(\d+)$/);
  if (match) return `${match[1]} ${match[2]} → ${match[3]}`;
  return text.replace(/->/g, "→").replace(/\s*→\s*/g, " → ");
}

export function comparisonState(
  greatSuccesses: number,
  attempts: number,
  theoreticalRate: number,
): ComparisonState {
  if (attempts <= 0) return { className: "", interval: null };
  const interval = wilsonInterval(greatSuccesses, attempts);
  if (attempts < 5) return { className: "luck-neutral", interval };
  if (theoreticalRate < interval.low) {
    return { className: "luck-good", interval };
  }
  if (theoreticalRate > interval.high) {
    return { className: "luck-bad", interval };
  }
  return { className: "luck-neutral", interval };
}

function percentPosition(rate: number) {
  return Math.min(100, Math.max(0, rate * 100));
}

export function markerEdge(percent: number) {
  return percent <= 12 ? "low" : percent >= 88 ? "high" : "";
}

export function rateBarGeometry(
  actualRate: number,
  attempts: number,
  comparison: ComparisonState,
  theoreticalRate: number,
): RateBarGeometry {
  const theoreticalPercent = 50;
  const deltaPercentagePoints = (actualRate - theoreticalRate) * 100;
  const deviation = Math.max(-50, Math.min(50, deltaPercentagePoints * 10));
  const observedPercent = attempts > 0 ? theoreticalPercent + deviation : theoreticalPercent;
  const actualWidth = attempts > 0 ? Math.abs(deviation) : 0;
  const intervalLeft = comparison.interval ? percentPosition(comparison.interval.low) : 0;
  const intervalRight = comparison.interval ? percentPosition(comparison.interval.high) : 0;
  return {
    actualPercent: observedPercent,
    actualWidth,
    deviationLeft: Math.min(theoreticalPercent, observedPercent),
    deviationWidth: Math.max(1, actualWidth),
    intervalLeft,
    intervalRight,
    intervalWidth: Math.max(0, intervalRight - intervalLeft),
    theoreticalPercent,
  };
}
