import { formatInteger, formatNumber, formatPercent } from "../format";
import { EXPECTED_28_DAY_GAIN, STRATEGY_META } from "../solver/domain";
import type { Kit, Stock, Strategy } from "../types";
import type { CandidateView, DetailView } from "../ui-types";

const KIT_KEYS: Kit[] = ["blue", "purple", "yellow"];

const KIT_SHORT_LABELS: Record<Kit, string> = {
  blue: "파랑",
  purple: "보라",
  yellow: "노랑",
};

type DetailRunSource = {
  count: number;
  greatSuccessProbability?: number;
};

type DetailVectorSource = Partial<Record<Kit, number>>;

type DetailCandidateSource = {
  firstAction: Kit;
  firstProbability: number;
  successProbability: number;
  run?: DetailRunSource;
  vector?: DetailVectorSource;
  totalKits?: number;
  probabilityGap?: number;
};

type DetailResultSource = {
  input: {
    stock: Stock;
    strategy?: Strategy;
  };
  best: {
    firstAction: Kit;
    firstProbability: number;
    successProbability: number;
    vector?: DetailVectorSource;
  };
  topCandidates?: DetailCandidateSource[];
  stats?: {
    states?: number;
    strategy?: Strategy;
    probabilityTolerance?: number;
    solverBackend?: string;
  };
};

function solverLabel(backend?: string) {
  switch (backend) {
    case "rust-min-ef":
      return "Rust min E[f]";
    case "rust-phase2":
      return "Rust phase2";
    case "js-phase2":
    case undefined:
      return "JS phase2";
    default:
      return backend;
  }
}

function formatKitPieces(value: number) {
  return `약 ${formatInteger(Math.round(value))}개`;
}

function formatSupplyDays(pieces: number, kit: Kit) {
  if (pieces <= 0) return "0일치";
  const days = (pieces / EXPECTED_28_DAY_GAIN[kit]) * 28;
  return `${days < 10 ? days.toFixed(1) : formatInteger(Math.round(days))}일치`;
}

function formatReadablePercent(value: number, digits = 4) {
  const percent = value * 100;
  const rounded = Number(percent.toFixed(digits));
  if (Math.abs(rounded - Math.round(rounded)) <= 1e-10) {
    return `${formatInteger(Math.round(rounded))}%`;
  }
  return `${formatNumber(rounded, digits)}%`;
}

function formatCompactPercent(value: number, digits = 2) {
  return formatReadablePercent(value, digits);
}

function formatKitBreakdown(vector: DetailVectorSource = {}) {
  return KIT_KEYS.map(
    (kit) => `${KIT_SHORT_LABELS[kit]} ${formatInteger(Math.round(Number(vector[kit] || 0)))}`,
  ).join(" · ");
}

function makeCandidateViews(
  candidates: DetailCandidateSource[] = [],
  tolerance: number,
): CandidateView[] {
  return candidates.map((candidate, index) => {
    const gap = Number(candidate.probabilityGap || 0);
    const excluded = gap > tolerance + 1e-9;
    const candidateVector = candidate.vector || {};
    const totalExpectedKits =
      Number(candidate.totalKits) ||
      KIT_KEYS.reduce((sum, kit) => sum + Number(candidateVector[kit] || 0), 0);

    return {
      rankLabel: index === 0 && !excluded ? "추천" : `후보 ${index + 1}`,
      kit: candidate.firstAction,
      count: candidate.run?.count || 1,
      successProbability: formatCompactPercent(candidate.successProbability, 2),
      expectedKits: formatKitPieces(totalExpectedKits),
      expectedBreakdown: formatKitBreakdown(candidateVector),
      excludedReason: excluded ? `허용 확률 차이 초과 (${formatPercent(gap, 2)})` : null,
    };
  });
}

export function makeMetricsDetailView(
  result: DetailResultSource,
  run: DetailRunSource,
  monteCarloRunsLabel: string,
): Extract<DetailView, { type: "metrics" }> {
  const best = result.best;
  const strategyKey = result.stats?.strategy || result.input.strategy || "supply";
  const tolerance = Number(result.stats?.probabilityTolerance ?? 0);

  return {
    type: "metrics",
    strategyLabel: STRATEGY_META[strategyKey].label,
    successProbability: formatReadablePercent(best.successProbability, 2),
    greatSuccessProbability: formatCompactPercent(
      run.greatSuccessProbability ?? best.firstProbability,
      1,
    ),
    stateCount: formatInteger(Number(result.stats?.states || 0)),
    candidates: makeCandidateViews(result.topCandidates, tolerance),
    monteCarloRuns: monteCarloRunsLabel,
    expectedConsumption: KIT_KEYS.map((kit) => {
      const pieces = Number(best.vector?.[kit] || 0);
      return {
        kit,
        pieces: formatKitPieces(pieces),
        supplyDays: formatSupplyDays(pieces, kit),
      };
    }),
    expectedRemaining: KIT_KEYS.map((kit) => {
      const remaining = Math.max(
        0,
        Math.round(Number(result.input.stock[kit] || 0) - Number(best.vector?.[kit] || 0)),
      );
      return `${KIT_SHORT_LABELS[kit]} ${formatInteger(remaining)}개`;
    }).join(" · "),
    solverLabel: solverLabel(result.stats?.solverBackend),
  };
}
