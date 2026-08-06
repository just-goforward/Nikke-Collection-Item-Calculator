import {
  HP_BASELINE_ID,
  HP_MANDATORY_SHORTLIST_IDS,
  type HpCandidateScreenSummary,
  type HpNormPower,
  hpCandidateById,
} from "./min-ef-hp-model";

const SHORTLIST_LIMIT = 16;

function dominates(left: HpCandidateScreenSummary, right: HpCandidateScreenSummary): boolean {
  if (left.newFailures !== right.newFailures) return left.newFailures < right.newFailures;
  if (!hasComparableMetrics(left)) return false;
  if (!hasComparableMetrics(right)) return true;
  const noWorse =
    left.maxSuccessProbabilityLoss <= right.maxSuccessProbabilityLoss &&
    left.meanTotalExpectedUses <= right.meanTotalExpectedUses &&
    left.worstSupplyDebtDays <= right.worstSupplyDebtDays;
  const strictlyBetter =
    left.maxSuccessProbabilityLoss < right.maxSuccessProbabilityLoss ||
    left.meanTotalExpectedUses < right.meanTotalExpectedUses ||
    left.worstSupplyDebtDays < right.worstSupplyDebtDays;
  return noWorse && strictlyBetter;
}

export function paretoFrontier(
  summaries: readonly HpCandidateScreenSummary[],
): HpCandidateScreenSummary[] {
  return summaries.filter(
    (candidate) => !summaries.some((other) => other !== candidate && dominates(other, candidate)),
  );
}

export function selectHpShortlist(
  summaries: readonly HpCandidateScreenSummary[],
  limit = SHORTLIST_LIMIT,
): string[] {
  if (limit < HP_MANDATORY_SHORTLIST_IDS.size) {
    throw new Error("H/p shortlist limit cannot exclude mandatory sensitivity candidates.");
  }
  const byId = new Map(summaries.map((summary) => [summary.candidateId, summary]));
  if (!byId.has(HP_BASELINE_ID)) throw new Error("H/p screening is missing the baseline.");
  for (const id of HP_MANDATORY_SHORTLIST_IDS) {
    if (!byId.has(id)) throw new Error(`H/p screening is missing mandatory candidate ${id}.`);
  }

  const selected = new Set(HP_MANDATORY_SHORTLIST_IDS);
  const frontier = paretoFrontier(summaries)
    .filter(
      (summary) =>
        !selected.has(summary.candidateId) &&
        summary.newFailures === 0 &&
        hasComparableMetrics(summary),
    )
    .sort(compareShortlistPriority);
  for (const summary of frontier) {
    if (selected.size >= limit) break;
    selected.add(summary.candidateId);
  }
  return [...selected].sort((left, right) => {
    const leftSummary = byId.get(left);
    const rightSummary = byId.get(right);
    if (!leftSummary || !rightSummary) return left.localeCompare(right);
    return compareShortlistPriority(leftSummary, rightSummary);
  });
}

function compareShortlistPriority(
  left: HpCandidateScreenSummary,
  right: HpCandidateScreenSummary,
): number {
  return (
    nullableMetric(left.worstSupplyDebtDays) - nullableMetric(right.worstSupplyDebtDays) ||
    nullableMetric(left.meanTotalExpectedUses) - nullableMetric(right.meanTotalExpectedUses) ||
    Math.abs(hpCandidateById(left.candidateId).horizonFactor - 0.75) -
      Math.abs(hpCandidateById(right.candidateId).horizonFactor - 0.75) ||
    normDistance(hpCandidateById(left.candidateId).normPower) -
      normDistance(hpCandidateById(right.candidateId).normPower) ||
    left.candidateId.localeCompare(right.candidateId)
  );
}

function hasComparableMetrics(
  summary: HpCandidateScreenSummary,
): summary is HpCandidateScreenSummary & {
  maxSuccessProbabilityLoss: number;
  meanTotalExpectedUses: number;
  worstSupplyDebtDays: number;
} {
  return (
    summary.maxSuccessProbabilityLoss !== null &&
    summary.meanTotalExpectedUses !== null &&
    summary.worstSupplyDebtDays !== null
  );
}

function nullableMetric(value: number | null): number {
  return value ?? Number.POSITIVE_INFINITY;
}

function normDistance(normPower: HpNormPower): number {
  return normPower === "infinity" ? Number.POSITIVE_INFINITY : Math.abs(normPower - 3);
}
