import type { RustPairedExpectedCostEstimate } from "../src/wasm/rustTypes";
import type { ScenarioSource } from "./rust-rerank-summary-model.ts";
import type { SolverScenario } from "./scenarios/fixed-grid";

export const HORIZON_FACTOR = 0.75;
export const NORM_POWER = 3;
export const TOLERANCE = 0;
export const DEFAULT_RUNS = 2048;
export const ADAPTIVE_QUICK_RUNS = 512;
export const ADAPTIVE_MAX_RUNS = 2048;
export const ADAPTIVE_GATE_Z = 1.645;
export const ADAPTIVE_QUICK_ACCEPT_MARGIN = -0.001;
export const ADAPTIVE_FULL_ACCEPT_MARGIN = -0.00025;
export const DEFAULT_SEED = 20260509;
export const DEFAULT_HELD_OUT_SEED = 20260510;
export const DEFAULT_EVALUATION_SEEDS = [20260511, 20260512, 20260513, 20260514] as const;
export const DEFAULT_A1_SENTINEL_IDS = [
  "SR10-balanced100",
  "SR10-blue10",
  "SR10-yellow10",
  "SR10-yellow30",
  "SR14e2900-balanced100",
] as const;

export type BenchmarkScenario = SolverScenario & {
  source: ScenarioSource;
};

export type Adaptive90Decision = {
  rawSelectedFirstAction: string | null;
  selectedFirstAction: string | null;
  gatePass: boolean | null;
  intervened: boolean;
  evaluationDeltaVsBaseline: number | null;
  falsePositive: boolean | null;
  falseNegative: boolean | null;
  gateRuns: number | null;
  gateMeanDelta: number | null;
  gateStandardError: number | null;
  gateUpperBound: number | null;
  gateCorrelation: number | null;
};

export function parsePositiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? Math.trunc(parsed) : fallback;
}

export function parseList(value: string | undefined, fallback: readonly string[]): string[] {
  const parsed = String(value || "")
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
  return parsed.length > 0 ? parsed : [...fallback];
}

export function parseIntegerList(value: string | undefined, fallback: readonly number[]): number[] {
  const parsed = String(value || "")
    .split(",")
    .map((item) => Number(item.trim()))
    .filter((item) => Number.isFinite(item) && item > 0)
    .map((item) => Math.trunc(item));
  return parsed.length > 0 ? parsed : [...fallback];
}

export function parseSources(value: string | undefined): Set<ScenarioSource> {
  const parsed = new Set(
    String(value || "all")
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean),
  );
  if (parsed.has("all"))
    return new Set([
      "fixed-grid",
      "gain28-supplemental",
      "product-observed",
      "product-observed-high-stock",
    ]);
  return new Set(
    [...parsed].filter(
      (source): source is ScenarioSource =>
        source === "fixed-grid" ||
        source === "gain28-supplemental" ||
        source === "product-observed" ||
        source === "product-observed-high-stock",
    ),
  );
}

export function csvEscape(value: unknown): string {
  const text = String(value ?? "");
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export function stateLabel(scenario: SolverScenario) {
  const exp = scenario.start.exp ? `e${scenario.start.exp}` : "";
  return `${scenario.start.grade}${scenario.start.level}${exp}`;
}

export function summarizeEvaluationPairs(pairs: RustPairedExpectedCostEstimate[]) {
  const runs = pairs.reduce((total, pair) => total + pair.runs, 0);
  const sumDelta = pairs.reduce((total, pair) => total + pair.meanDelta * pair.runs, 0);
  const sumDeltaSq = pairs.reduce((total, pair) => total + pair.deltaSumSq, 0);
  const meanDelta = runs > 0 ? sumDelta / runs : 0;
  const variance = runs > 0 ? Math.max(0, sumDeltaSq / runs - meanDelta * meanDelta) : 0;
  const standardError = runs > 0 ? Math.sqrt(variance / runs) : 0;
  const seedMeans = pairs.map((pair) => pair.meanDelta);
  return {
    runs,
    meanDelta,
    standardError,
    upper95: meanDelta + 1.96 * standardError,
    seedSpread: seedMeans.length > 0 ? Math.max(...seedMeans) - Math.min(...seedMeans) : null,
  };
}

export function nullAdaptive90Decision(): Adaptive90Decision {
  return {
    rawSelectedFirstAction: null,
    selectedFirstAction: null,
    gatePass: null,
    intervened: false,
    evaluationDeltaVsBaseline: null,
    falsePositive: null,
    falseNegative: null,
    gateRuns: null,
    gateMeanDelta: null,
    gateStandardError: null,
    gateUpperBound: null,
    gateCorrelation: null,
  };
}

export function calculateAdaptiveGateUpperBound(pair: RustPairedExpectedCostEstimate) {
  return pair.meanDelta + ADAPTIVE_GATE_Z * pair.standardError;
}
