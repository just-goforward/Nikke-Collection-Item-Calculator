import { formatNumber } from "../format";
import { wilsonInterval } from "../lib/stats/binomial";
import type { KitStat } from "../ui-types";

export type ComparisonState = {
  className: string;
  label: string;
  interval: { low: number; high: number } | null;
};

export type RateBarGeometry = {
  actualWidth: number;
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

export function formatSignedPercentPoint(value: number) {
  if (!Number.isFinite(value)) return "-";
  const sign = value > 0 ? "+" : value < 0 ? "-" : "";
  return `${sign}${formatNumber(Math.abs(value) * 100, 1)}%p`;
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
  if (attempts <= 0) return { className: "", interval: null, label: "집계 대기" };
  const interval = wilsonInterval(greatSuccesses, attempts);
  if (attempts < 5) return { className: "luck-neutral", interval, label: "표본 부족" };
  if (theoreticalRate < interval.low) {
    return { className: "luck-good", interval, label: "기대 대비 높음" };
  }
  if (theoreticalRate > interval.high) {
    return { className: "luck-bad", interval, label: "기대 대비 낮음" };
  }
  return { className: "luck-neutral", interval, label: "기대 범위 내" };
}

export function difficultyLabel(attempts: number, theoreticalRate: number) {
  if (!attempts) return "집계 대기";
  if (theoreticalRate >= 0.5) return "쉬움";
  if (theoreticalRate >= 0.15) return "보통";
  return "어려움";
}

export function percentPosition(rate: number) {
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
  const actualPercent = percentPosition(actualRate);
  const theoreticalPercent = percentPosition(theoreticalRate);
  const actualWidth = attempts > 0 ? Math.max(1, actualPercent) : 0;
  const intervalLeft = comparison.interval ? percentPosition(comparison.interval.low) : 0;
  const intervalRight = comparison.interval ? percentPosition(comparison.interval.high) : 0;
  return {
    actualWidth,
    intervalLeft,
    intervalRight,
    intervalWidth: Math.max(0, intervalRight - intervalLeft),
    theoreticalPercent,
  };
}
