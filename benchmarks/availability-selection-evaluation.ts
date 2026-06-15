import type { Stock } from "../src/types";
import type {
  CandidateEvaluation,
  DeepReport,
  ExactEntry,
  FiniteTailEntry,
  GateEvidenceSummary,
  GuardrailAggregate,
  GuardrailComparison,
  JourneyDemandEntry,
  JudgeableCandidate,
  RawGateEvidence,
  TailSummary,
} from "./availability-selection-types.ts";

export const AVAILABILITY_BASELINE_ID = "tau0.01-h0.5-p3";
export const AVAILABILITY_NO_LOSS_EPSILON = 1e-9;
export const AVAILABILITY_STRICT_EPSILON = 1e-9;

const KITS = ["blue", "purple", "yellow"] as const;
const EXACT_RESULTS_KEY = "exactResults";
const FINITE_STOCK_TAIL_KEY = "finiteStockTail";
const JOURNEY_DEMAND_KEY = "journeyDemand";

type Kit = (typeof KITS)[number];

export type GuardrailTolerances = {
  depletionTolerance: number;
  residualRelTolerance: number;
  autonomyRelTolerance: number;
};

export function readDeepReport(value: unknown): DeepReport {
  const object = asObject(value);
  if (!object) return { exactResults: [], finiteStockTail: [], journeyDemand: [] };
  return {
    exactResults: Array.isArray(object[EXACT_RESULTS_KEY])
      ? (object[EXACT_RESULTS_KEY] as ExactEntry[])
      : [],
    finiteStockTail: Array.isArray(object[FINITE_STOCK_TAIL_KEY])
      ? (object[FINITE_STOCK_TAIL_KEY] as FiniteTailEntry[])
      : [],
    journeyDemand: Array.isArray(object[JOURNEY_DEMAND_KEY])
      ? (object[JOURNEY_DEMAND_KEY] as JourneyDemandEntry[])
      : [],
  };
}

export function aggregateFiniteTail(
  finiteStockTail: readonly FiniteTailEntry[],
): Map<string, Map<string, GuardrailAggregate>> {
  const byKey = new Map<string, TailSummary[]>();
  for (const entry of finiteStockTail) {
    if (entry.status !== "completed" || !entry.summary) continue;
    const key = `${entry.modelId}|${entry.scenario}`;
    const bucket = byKey.get(key) ?? [];
    bucket.push(entry.summary);
    byKey.set(key, bucket);
  }

  const result = new Map<string, Map<string, GuardrailAggregate>>();
  for (const [key, summaries] of byKey) {
    const [modelId, scenario] = key.split("|");
    if (!modelId || !scenario) continue;
    const byScenario = result.get(modelId) ?? new Map<string, GuardrailAggregate>();
    byScenario.set(scenario, {
      residualP05Min: mean(summaries.map((summary) => minKit(summary.residualP05))),
      depletionProbability: mean(summaries.map((summary) => Number(summary.depletionProbability))),
      autonomyDaysP05: mean(summaries.map((summary) => Number(summary.autonomyDaysP05))),
      seeds: summaries.length,
    });
    result.set(modelId, byScenario);
  }
  return result;
}

export function aggregateExact(
  exactResults: readonly ExactEntry[],
): Map<string, { completed: ExactEntry[]; incomplete: ExactEntry[] }> {
  const byCandidate = new Map<string, { completed: ExactEntry[]; incomplete: ExactEntry[] }>();
  for (const entry of exactResults) {
    const bucket = byCandidate.get(entry.modelId) ?? { completed: [], incomplete: [] };
    if (entry.status === "completed") bucket.completed.push(entry);
    else bucket.incomplete.push(entry);
    byCandidate.set(entry.modelId, bucket);
  }
  return byCandidate;
}

export function buildCandidate(
  modelId: string,
  exactByCandidate: Map<string, { completed: ExactEntry[]; incomplete: ExactEntry[] }>,
  finiteByCandidate: Map<string, Map<string, GuardrailAggregate>>,
  journeyByCandidate: Map<string, JourneyDemandEntry>,
  gateScenarioIds: readonly string[],
): CandidateEvaluation {
  const exact = exactByCandidate.get(modelId) || { completed: [], incomplete: [] };
  const losses = exact.completed
    .map((entry) => Number(entry.exactLossVsA))
    .filter((value) => Number.isFinite(value));
  const relativeLosses = exact.completed
    .map((entry) => Number(entry.relativeLossVsA))
    .filter((value) => Number.isFinite(value));
  const judgedScenarioIds = new Set(
    exact.completed
      .filter((entry) => Number.isFinite(Number(entry.exactLossVsA)))
      .map((entry) => entry.scenario),
  );
  if (modelId === AVAILABILITY_BASELINE_ID) {
    for (const entry of exact.completed) judgedScenarioIds.add(entry.scenario);
  }
  const gateComplete = gateScenarioIds.every((id) => judgedScenarioIds.has(id));
  const incompleteReasons = exact.incomplete.map(
    (entry) => `${entry.scenario}:${entry.reason || entry.status}`,
  );
  const journey = journeyByCandidate.get(modelId) || null;
  const supplyDebt =
    journey && Number.isFinite(Number(journey.maxPanelSupplyDebtCvar90))
      ? Number(journey.maxPanelSupplyDebtCvar90)
      : null;

  return {
    modelId,
    worstExactLoss:
      modelId === AVAILABILITY_BASELINE_ID ? 0 : losses.length ? Math.max(...losses) : null,
    worstRelativeLoss:
      modelId === AVAILABILITY_BASELINE_ID
        ? 0
        : relativeLosses.length
          ? Math.max(...relativeLosses)
          : null,
    gateComplete,
    gateJudgedCount: judgedScenarioIds.size,
    gateTotal: gateScenarioIds.length,
    incompleteReasons,
    gateEvidence: sumGateEvidence(exact.completed),
    supplyDebt,
    supplyDebtJudgeable: supplyDebt !== null,
    finiteByScenario: finiteByCandidate.get(modelId) || new Map(),
  };
}

export function guardrailComparison(
  candidate: CandidateEvaluation,
  baseline: CandidateEvaluation,
  gateScenarioIds: readonly string[],
  tolerances: GuardrailTolerances,
): GuardrailComparison {
  let degraded = false;
  const degradations: string[] = [];
  let anyRiskStratumBetter = false;

  for (const scenario of gateScenarioIds) {
    const candidateGuard = candidate.finiteByScenario.get(scenario);
    const baselineGuard = baseline.finiteByScenario.get(scenario);
    if (!candidateGuard || !baselineGuard) continue;
    const depletion = compareDepletion(candidateGuard, baselineGuard, scenario, tolerances);
    if (depletion.degraded) {
      degraded = true;
      degradations.push(...depletion.degradations);
    }
    anyRiskStratumBetter ||= depletion.better;

    const residual = compareResidual(candidateGuard, baselineGuard, scenario, tolerances);
    if (residual.degraded) {
      degraded = true;
      degradations.push(...residual.degradations);
    }

    const autonomy = compareAutonomy(candidateGuard, baselineGuard, scenario, tolerances);
    if (autonomy.degraded) {
      degraded = true;
      degradations.push(...autonomy.degradations);
    }
    anyRiskStratumBetter ||= autonomy.better;
  }

  return { degraded, degradations, anyRiskStratumBetter };
}

export function paretoFrontier<T extends { modelId: string; x: number; y: number }>(
  points: T[],
): T[] {
  return points.filter(
    (point) =>
      !points.some(
        (other) =>
          other.modelId !== point.modelId &&
          other.x <= point.x + AVAILABILITY_STRICT_EPSILON &&
          other.y <= point.y + AVAILABILITY_STRICT_EPSILON &&
          (other.x < point.x - AVAILABILITY_STRICT_EPSILON ||
            other.y < point.y - AVAILABILITY_STRICT_EPSILON),
      ),
  );
}

export function isJudgeableCandidate(
  candidate: CandidateEvaluation,
): candidate is JudgeableCandidate {
  return (
    candidate.modelId !== AVAILABILITY_BASELINE_ID &&
    candidate.gateComplete &&
    candidate.supplyDebtJudgeable &&
    candidate.worstExactLoss !== null &&
    candidate.worstRelativeLoss !== null &&
    candidate.supplyDebt !== null &&
    candidate.gateEvidence.eligibleEmptyCount === 0 &&
    candidate.guard !== undefined &&
    candidate.noLoss !== undefined &&
    candidate.boundedLoss !== undefined &&
    candidate.tailStrictlyBetter !== undefined &&
    candidate.significance !== undefined &&
    candidate.tailSignificantlyBetter !== undefined
  );
}

export function tauOf(modelId: string): number {
  const match = modelId.match(/tau([\d.]+)/);
  return match ? Number(match[1]) : Number.POSITIVE_INFINITY;
}

export function pOf(modelId: string): number {
  const match = modelId.match(/-p(inf|\d+)$/);
  if (!match) return Number.NaN;
  return match[1] === "inf" ? Number.POSITIVE_INFINITY : Number(match[1]);
}

export function candidateLoss(candidate: CandidateEvaluation): number {
  return candidate.modelId === AVAILABILITY_BASELINE_ID ? 0 : Number(candidate.worstExactLoss);
}

export function candidateDebt(candidate: CandidateEvaluation): number {
  return Number(candidate.supplyDebt);
}

function asObject(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

function mean(values: number[]): number {
  const finite = values.filter((value) => Number.isFinite(value));
  if (finite.length === 0) return Number.NaN;
  return finite.reduce((sum, value) => sum + value, 0) / finite.length;
}

function minKit(stock: Partial<Stock> | undefined): number {
  if (!stock) return Number.NaN;
  return Math.min(...KITS.map((kit) => Number(stock[kit as Kit])));
}

function sumGateEvidence(completedEntries: readonly ExactEntry[]): GateEvidenceSummary {
  let eligibleEmptyCount = 0;
  let internalViolationCount = 0;
  let boundaryViolationCount = 0;
  for (const entry of completedEntries) {
    const evidence: RawGateEvidence = entry.gateEvidence || {};
    eligibleEmptyCount += Number(evidence.eligibleEmptyCount ?? 0);
    internalViolationCount += Number(
      evidence.internalViolationCount ?? evidence.violationCount ?? 0,
    );
    boundaryViolationCount += Number(evidence.boundaryViolationCount ?? 0);
  }
  return { eligibleEmptyCount, internalViolationCount, boundaryViolationCount };
}

function compareDepletion(
  candidate: GuardrailAggregate,
  baseline: GuardrailAggregate,
  scenario: string,
  tolerances: GuardrailTolerances,
) {
  const degradations: string[] = [];
  let better = false;
  if (
    Number.isFinite(candidate.depletionProbability) &&
    Number.isFinite(baseline.depletionProbability)
  ) {
    if (
      candidate.depletionProbability >
      baseline.depletionProbability + tolerances.depletionTolerance
    ) {
      degradations.push(
        `${scenario}: depletion ${baseline.depletionProbability.toFixed(4)} -> ${candidate.depletionProbability.toFixed(4)}`,
      );
    }
    if (
      candidate.depletionProbability <
      baseline.depletionProbability - AVAILABILITY_STRICT_EPSILON
    ) {
      better = true;
    }
  }
  return { degraded: degradations.length > 0, degradations, better };
}

function compareResidual(
  candidate: GuardrailAggregate,
  baseline: GuardrailAggregate,
  scenario: string,
  tolerances: GuardrailTolerances,
) {
  const degradations: string[] = [];
  if (
    Number.isFinite(candidate.residualP05Min) &&
    Number.isFinite(baseline.residualP05Min) &&
    baseline.residualP05Min > 0 &&
    candidate.residualP05Min < baseline.residualP05Min * (1 - tolerances.residualRelTolerance)
  ) {
    degradations.push(
      `${scenario}: residualP05 ${baseline.residualP05Min.toFixed(1)} -> ${candidate.residualP05Min.toFixed(1)}`,
    );
  }
  return { degraded: degradations.length > 0, degradations };
}

function compareAutonomy(
  candidate: GuardrailAggregate,
  baseline: GuardrailAggregate,
  scenario: string,
  tolerances: GuardrailTolerances,
) {
  const degradations: string[] = [];
  let better = false;
  if (
    Number.isFinite(candidate.autonomyDaysP05) &&
    Number.isFinite(baseline.autonomyDaysP05) &&
    baseline.autonomyDaysP05 > 0
  ) {
    if (
      candidate.autonomyDaysP05 <
      baseline.autonomyDaysP05 * (1 - tolerances.autonomyRelTolerance)
    ) {
      degradations.push(
        `${scenario}: autonomyP05 ${baseline.autonomyDaysP05.toFixed(2)} -> ${candidate.autonomyDaysP05.toFixed(2)}`,
      );
    }
    if (candidate.autonomyDaysP05 > baseline.autonomyDaysP05 + AVAILABILITY_STRICT_EPSILON) {
      better = true;
    }
  }
  return { degraded: degradations.length > 0, degradations, better };
}
