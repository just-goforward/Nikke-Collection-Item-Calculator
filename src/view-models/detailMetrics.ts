import { formatInteger, formatNumber } from "../format";
import type { Kit, Strategy } from "../types";
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
  resourceCost?: number;
};

type DetailResultSource = {
  input: { strategy?: Strategy };
  best: {
    firstAction: Kit;
    firstProbability: number;
    successProbability: number;
    vector?: DetailVectorSource;
  };
  topCandidates?: DetailCandidateSource[];
  stats?: {
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

function excludedCandidateReason(candidateSuccess: string, bestSuccess: string, rawGap: number) {
  if (rawGap <= 0) return { label: null, help: null };
  if (candidateSuccess === bestSuccess) {
    return {
      label: "미세 열세",
      help: "표시값은 같지만, 반올림 전 SR 15 도달 확률이 추천 후보보다 낮습니다.",
    };
  }
  return {
    label: "도달률 낮음",
    help: "SR 15 도달 확률이 추천 후보보다 낮아 제외되었습니다.",
  };
}

const COMPARISON_EPSILON = 1e-9;

function candidateTotalKits(candidate: DetailCandidateSource) {
  if (Number.isFinite(candidate.totalKits)) return Number(candidate.totalKits);
  return KIT_KEYS.reduce((sum, kit) => sum + Number(candidate.vector?.[kit] || 0), 0);
}

function candidateExclusionReason({
  candidate,
  candidateSuccess,
  maxSuccess,
  recommended,
  recommendedSuccess,
  tolerance,
}: {
  candidate: DetailCandidateSource;
  candidateSuccess: string;
  maxSuccess: string;
  recommended: DetailCandidateSource;
  recommendedSuccess: string;
  tolerance: number;
}) {
  const gap = Number(candidate.probabilityGap || 0);
  if (gap > tolerance + COMPARISON_EPSILON) {
    return excludedCandidateReason(candidateSuccess, maxSuccess, gap);
  }

  const candidateCost = Number(candidate.resourceCost);
  const recommendedCost = Number(recommended.resourceCost);
  if (
    Number.isFinite(candidateCost) &&
    Number.isFinite(recommendedCost) &&
    candidateCost > recommendedCost + COMPARISON_EPSILON
  ) {
    return {
      label: "키트 부담 높음",
      help: "SR 15 도달률 조건은 충족했지만, 보유량과 향후 수급을 반영한 키트 부담이 추천 후보보다 높아 제외되었습니다.",
    };
  }

  if (candidateTotalKits(candidate) > candidateTotalKits(recommended) + COMPARISON_EPSILON) {
    return {
      label: "예상 소모량 많음",
      help: "SR 15 도달률과 키트 부담이 비슷하지만, 총 예상 소모량이 추천 후보보다 많아 제외되었습니다.",
    };
  }

  const rawProbabilityGap =
    Number(recommended.successProbability) - Number(candidate.successProbability);
  if (rawProbabilityGap > COMPARISON_EPSILON) {
    return excludedCandidateReason(candidateSuccess, recommendedSuccess, rawProbabilityGap);
  }

  return {
    label: "계산상 동률",
    help: "주요 비교값이 같아, 일관된 결과를 위한 고정 우선순위에서 제외되었습니다.",
  };
}

function makeCandidateViews(
  candidates: DetailCandidateSource[] = [],
  tolerance: number,
  recommendedAction: Kit,
): CandidateView[] {
  const maxSuccess = formatCompactPercent(
    candidates.reduce(
      (best, candidate) => Math.max(best, Number(candidate.successProbability) || 0),
      0,
    ),
    2,
  );
  const recommendedIndex = candidates.findIndex(
    (candidate) => candidate.firstAction === recommendedAction,
  );
  const orderedCandidates =
    recommendedIndex > 0
      ? [
          candidates[recommendedIndex] as DetailCandidateSource,
          ...candidates.filter((_, index) => index !== recommendedIndex),
        ]
      : candidates;
  const recommended = orderedCandidates[0];
  const recommendedSuccess = formatCompactPercent(recommended?.successProbability || 0, 2);

  return orderedCandidates.map((candidate, index) => {
    const recommendedCandidate = index === 0;
    const candidateVector = candidate.vector || {};
    const totalExpectedKits = candidateTotalKits(candidate);
    const successProbability = formatCompactPercent(candidate.successProbability, 2);
    const excludedReason =
      recommendedCandidate || !recommended
        ? { label: null, help: null }
        : candidateExclusionReason({
            candidate,
            candidateSuccess: successProbability,
            maxSuccess,
            recommended,
            recommendedSuccess,
            tolerance,
          });

    return {
      rankLabel: recommendedCandidate ? "추천" : `후보 ${index + 1}`,
      kit: candidate.firstAction,
      count: candidate.run?.count || 1,
      successProbability,
      successProbabilityMedium: formatCompactPercent(candidate.successProbability, 3),
      successProbabilityDetailed: formatCompactPercent(candidate.successProbability, 4),
      expectedKits: formatKitPieces(totalExpectedKits),
      expectedBreakdown: formatKitBreakdown(candidateVector),
      excludedReason: excludedReason.label,
      excludedReasonHelp: excludedReason.help,
    };
  });
}

export function makeMetricsDetailView(
  result: DetailResultSource,
  run: DetailRunSource,
  monteCarloRunsLabel: string,
): Extract<DetailView, { type: "metrics" }> {
  const best = result.best;
  const tolerance = Number(result.stats?.probabilityTolerance ?? 0);

  return {
    type: "metrics",
    successProbability: formatReadablePercent(best.successProbability, 2),
    greatSuccessProbability: formatCompactPercent(
      run.greatSuccessProbability ?? best.firstProbability,
      1,
    ),
    candidates: makeCandidateViews(result.topCandidates, tolerance, best.firstAction),
    monteCarloRuns: monteCarloRunsLabel,
    solverLabel: solverLabel(result.stats?.solverBackend),
  };
}
