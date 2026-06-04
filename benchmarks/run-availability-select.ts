// Selection / decision stage.
//
// Consumes deep-evaluation JSON plus optional significance evidence and produces:
// - per-candidate 2D coordinates: x = worst exact interactive-replan P-loss vs A,
//   y = journey-demand CVaR90(max supplyDebtDays),
// - finite-stock guardrail comparisons vs A,
// - the 2D Pareto frontier,
// - stage contracts for 확률우선 / 균형 / 수급보존,
// - a null-result determination.
//
// This stage performs no solving. It is a deterministic decision over collected evidence and
// degrades to insufficient-evidence on partial data.

import { mkdir, readFile, writeFile } from "node:fs/promises";
import type { Stock } from "../src/types";
import { isErrorWithCode } from "./runner-utils";

const RESULTS_DIRECTORY = new URL("./results/", import.meta.url);
const SLICE_FILE = new URL("./results/availability-deep-slice.json", import.meta.url);
const SINGLE_FILE = new URL("./results/availability-deep.json", import.meta.url);
const SIGNIFICANCE_FILE = new URL("./results/availability-significance.json", import.meta.url);
const JSON_OUTPUT = new URL("./results/availability-selection.json", import.meta.url);
const REPORT_OUTPUT = new URL("./results/availability-selection-report.ko.md", import.meta.url);

const BASELINE_ID = "tau0.01-h0.5-p3";
const NO_LOSS_EPSILON = 1e-9;
const STRICT_EPSILON = 1e-9;
const KITS = ["blue", "purple", "yellow"] as const;

type Kit = (typeof KITS)[number];

type GateEvidenceSummary = {
  eligibleEmptyCount: number;
  internalViolationCount: number;
  boundaryViolationCount: number;
};

type RawGateEvidence = Partial<GateEvidenceSummary> & {
  violationCount?: number;
};

type ExactEntry = {
  modelId: string;
  scenario: string;
  status: string;
  reason?: string;
  exactLossVsA?: number | null;
  relativeLossVsA?: number | null;
  gateEvidence?: RawGateEvidence | null;
};

type TailSummary = {
  residualP05?: Partial<Stock>;
  depletionProbability?: number;
  autonomyDaysP05?: number;
};

type FiniteTailEntry = {
  modelId: string;
  scenario: string;
  status: string;
  summary?: TailSummary;
};

type JourneyDemandEntry = {
  candidateId: string;
  maxPanelSupplyDebtCvar90?: number | null;
};

type DeepReport = {
  exactResults: ExactEntry[];
  finiteStockTail: FiniteTailEntry[];
  journeyDemand: JourneyDemandEntry[];
};

type LoadedDeepReport = {
  report: DeepReport;
  source: string;
};

type SignificanceCandidate = {
  candidateId: string;
  significantImprovement?: boolean;
};

type SignificanceLoad =
  | {
      available: true;
      byId: Map<string, SignificanceCandidate>;
    }
  | {
      available: false;
      byId: Map<string, SignificanceCandidate>;
    };

type GuardrailAggregate = {
  residualP05Min: number;
  depletionProbability: number;
  autonomyDaysP05: number;
  seeds: number;
};

type CandidateEvaluation = {
  modelId: string;
  worstExactLoss: number | null;
  worstRelativeLoss: number | null;
  gateComplete: boolean;
  gateJudgedCount: number;
  gateTotal: number;
  incompleteReasons: string[];
  gateEvidence: GateEvidenceSummary;
  supplyDebt: number | null;
  supplyDebtJudgeable: boolean;
  finiteByScenario: Map<string, GuardrailAggregate>;
  guard?: GuardrailComparison;
  noLoss?: boolean;
  boundedLoss?: boolean;
  tailStrictlyBetter?: boolean;
  significance?: SignificanceCandidate | null;
  tailSignificantlyBetter?: boolean;
};

type JudgeableCandidate = CandidateEvaluation & {
  worstExactLoss: number;
  worstRelativeLoss: number;
  supplyDebt: number;
  guard: GuardrailComparison;
  noLoss: boolean;
  boundedLoss: boolean;
  tailStrictlyBetter: boolean;
  significance: SignificanceCandidate | null;
  tailSignificantlyBetter: boolean;
};

type GuardrailComparison = {
  degraded: boolean;
  degradations: string[];
  anyRiskStratumBetter: boolean;
};

type StageOutput = {
  stage: "확률우선" | "균형" | "수급보존";
  modelId: string;
  worstExactLoss: number;
  worstRelativeLoss: number | null;
  supplyDebtCvar90: number;
  tailSignificantImprovement: boolean | null;
  guardrailDegraded: boolean;
  guardrailDegradations: string[];
  riskStratumBetter: boolean | null;
};

type SelectionCandidateOutput = {
  modelId: string;
  worstExactLoss: number | null;
  worstRelativeLoss: number | null;
  supplyDebtCvar90: number | null;
  supplyDebtSignificantImprovement: boolean | null;
  gateComplete: boolean;
  gateJudged: string;
  incompleteReasons: string[];
  gateEvidence: GateEvidenceSummary;
};

type ImprovedDefaultOutput = {
  modelId: string;
  worstExactLoss: number;
  supplyDebtCvar90: number;
  supplyDebtVsA: number;
  tailSignificantImprovement: boolean;
  riskStratumBetter: boolean;
  provisional: boolean;
};

type SelectionOutput = {
  kind: "availability-selection";
  version: 1;
  generatedAt: string;
  source: string;
  deltaPBudget: number;
  guardrailTolerances: {
    depletionTolerance: number;
    residualRelTolerance: number;
    autonomyRelTolerance: number;
  };
  baselineId: string;
  significanceAvailable: boolean;
  gateScenarioIds: string[];
  candidates: SelectionCandidateOutput[];
  outcome?: string;
  reason?: string;
  paretoFrontier?: string[];
  stages?: StageOutput[];
  monotone?: boolean;
  baselineSupplyDebt?: number;
  improvedDefaultAvailable?: boolean;
  improvedDefault?: ImprovedDefaultOutput | null;
  dominatorsOfA?: string[];
  preservationProvisional?: boolean;
  preservationEscalationSuggested?: boolean;
  diagnostics?: {
    judgeableCount: number;
    probabilityCandidateCount: number;
    preservationCandidateCount: number;
    dominatorCount: number;
    droppedForFallback: string[];
  };
};

function parseNumber(value: string | number | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

const deltaPBudget = parseNumber(process.env.AVAILABILITY_SELECT_DELTA_P_BUDGET, 0.005);
const depletionTolerance = parseNumber(process.env.AVAILABILITY_SELECT_DEPLETION_TOL, 0.01);
const residualRelTolerance = parseNumber(process.env.AVAILABILITY_SELECT_RESIDUAL_REL_TOL, 0.05);
const autonomyRelTolerance = parseNumber(process.env.AVAILABILITY_SELECT_AUTONOMY_REL_TOL, 0.05);

function asObject(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : null;
}

function readDeepReport(value: unknown): DeepReport {
  const object = asObject(value);
  if (!object) return { exactResults: [], finiteStockTail: [], journeyDemand: [] };
  return {
    exactResults: Array.isArray(object.exactResults) ? (object.exactResults as ExactEntry[]) : [],
    finiteStockTail: Array.isArray(object.finiteStockTail)
      ? (object.finiteStockTail as FiniteTailEntry[])
      : [],
    journeyDemand: Array.isArray(object.journeyDemand)
      ? (object.journeyDemand as JourneyDemandEntry[])
      : [],
  };
}

async function loadReport(): Promise<LoadedDeepReport> {
  for (const file of [SLICE_FILE, SINGLE_FILE]) {
    try {
      return {
        report: readDeepReport(JSON.parse(await readFile(file, "utf8"))),
        source: file.pathname,
      };
    } catch (error) {
      if (!isErrorWithCode(error) || error.code !== "ENOENT") throw error;
    }
  }
  throw new Error(
    "No deep-evaluation results found. Run bench:availability-deep:slice (or bench:availability-deep) first.",
  );
}

async function loadSignificance(): Promise<SignificanceLoad> {
  try {
    const value = JSON.parse(await readFile(SIGNIFICANCE_FILE, "utf8")) as {
      candidates?: SignificanceCandidate[];
    };
    const byId = new Map(
      (value.candidates || []).map((candidate) => [candidate.candidateId, candidate]),
    );
    return { available: true, byId };
  } catch (error) {
    if (!isErrorWithCode(error) || error.code !== "ENOENT") throw error;
    return { available: false, byId: new Map() };
  }
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

function aggregateFiniteTail(
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

function aggregateExact(
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

function sumGateEvidence(completedEntries: readonly ExactEntry[]): GateEvidenceSummary {
  let eligibleEmptyCount = 0;
  let internalViolationCount = 0;
  let boundaryViolationCount = 0;
  for (const entry of completedEntries) {
    const evidence = entry.gateEvidence || {};
    eligibleEmptyCount += Number(evidence.eligibleEmptyCount ?? 0);
    internalViolationCount += Number(
      evidence.internalViolationCount ?? evidence.violationCount ?? 0,
    );
    boundaryViolationCount += Number(evidence.boundaryViolationCount ?? 0);
  }
  return { eligibleEmptyCount, internalViolationCount, boundaryViolationCount };
}

function buildCandidate(
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
  if (modelId === BASELINE_ID) {
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
    worstExactLoss: modelId === BASELINE_ID ? 0 : losses.length ? Math.max(...losses) : null,
    worstRelativeLoss:
      modelId === BASELINE_ID ? 0 : relativeLosses.length ? Math.max(...relativeLosses) : null,
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

function guardrailComparison(
  candidate: CandidateEvaluation,
  baseline: CandidateEvaluation,
  gateScenarioIds: readonly string[],
): GuardrailComparison {
  let degraded = false;
  const degradations: string[] = [];
  let anyRiskStratumBetter = false;

  for (const scenario of gateScenarioIds) {
    const candidateGuard = candidate.finiteByScenario.get(scenario);
    const baselineGuard = baseline.finiteByScenario.get(scenario);
    if (!candidateGuard || !baselineGuard) continue;

    if (
      Number.isFinite(candidateGuard.depletionProbability) &&
      Number.isFinite(baselineGuard.depletionProbability)
    ) {
      if (
        candidateGuard.depletionProbability >
        baselineGuard.depletionProbability + depletionTolerance
      ) {
        degraded = true;
        degradations.push(
          `${scenario}: depletion ${baselineGuard.depletionProbability.toFixed(4)} -> ${candidateGuard.depletionProbability.toFixed(4)}`,
        );
      }
      if (
        candidateGuard.depletionProbability <
        baselineGuard.depletionProbability - STRICT_EPSILON
      ) {
        anyRiskStratumBetter = true;
      }
    }

    if (
      Number.isFinite(candidateGuard.residualP05Min) &&
      Number.isFinite(baselineGuard.residualP05Min) &&
      baselineGuard.residualP05Min > 0
    ) {
      if (
        candidateGuard.residualP05Min <
        baselineGuard.residualP05Min * (1 - residualRelTolerance)
      ) {
        degraded = true;
        degradations.push(
          `${scenario}: residualP05 ${baselineGuard.residualP05Min.toFixed(1)} -> ${candidateGuard.residualP05Min.toFixed(1)}`,
        );
      }
    }

    if (
      Number.isFinite(candidateGuard.autonomyDaysP05) &&
      Number.isFinite(baselineGuard.autonomyDaysP05) &&
      baselineGuard.autonomyDaysP05 > 0
    ) {
      if (
        candidateGuard.autonomyDaysP05 <
        baselineGuard.autonomyDaysP05 * (1 - autonomyRelTolerance)
      ) {
        degraded = true;
        degradations.push(
          `${scenario}: autonomyP05 ${baselineGuard.autonomyDaysP05.toFixed(2)} -> ${candidateGuard.autonomyDaysP05.toFixed(2)}`,
        );
      }
      if (candidateGuard.autonomyDaysP05 > baselineGuard.autonomyDaysP05 + STRICT_EPSILON) {
        anyRiskStratumBetter = true;
      }
    }
  }

  return { degraded, degradations, anyRiskStratumBetter };
}

function paretoFrontier<T extends { modelId: string; x: number; y: number }>(points: T[]): T[] {
  return points.filter(
    (point) =>
      !points.some(
        (other) =>
          other.modelId !== point.modelId &&
          other.x <= point.x + STRICT_EPSILON &&
          other.y <= point.y + STRICT_EPSILON &&
          (other.x < point.x - STRICT_EPSILON || other.y < point.y - STRICT_EPSILON),
      ),
  );
}

function fmt(value: number | null | undefined, digits = 6): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return "n/a";
  return value.toFixed(digits);
}

function isJudgeableCandidate(candidate: CandidateEvaluation): candidate is JudgeableCandidate {
  return (
    candidate.modelId !== BASELINE_ID &&
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

function tauOf(modelId: string): number {
  const match = modelId.match(/tau([\d.]+)/);
  return match ? Number(match[1]) : Number.POSITIVE_INFINITY;
}

function pOf(modelId: string): number {
  const match = modelId.match(/-p(inf|\d+)$/);
  if (!match) return Number.NaN;
  return match[1] === "inf" ? Number.POSITIVE_INFINITY : Number(match[1]);
}

async function main(): Promise<SelectionOutput> {
  const { report, source } = await loadReport();
  const significance = await loadSignificance();
  const candidateIds = Array.from(
    new Set([
      ...report.exactResults.map((entry) => entry.modelId),
      ...report.journeyDemand.map((entry) => entry.candidateId),
    ]),
  );
  const gateScenarioIds = Array.from(new Set(report.exactResults.map((entry) => entry.scenario)));

  const exactByCandidate = aggregateExact(report.exactResults);
  const finiteByCandidate = aggregateFiniteTail(report.finiteStockTail);
  const journeyByCandidate = new Map(
    report.journeyDemand.map((entry) => [entry.candidateId, entry]),
  );
  const candidates = candidateIds.map((id) =>
    buildCandidate(id, exactByCandidate, finiteByCandidate, journeyByCandidate, gateScenarioIds),
  );
  const baseline = candidates.find((candidate) => candidate.modelId === BASELINE_ID);

  const out: SelectionOutput = {
    kind: "availability-selection",
    version: 1,
    generatedAt: new Date().toISOString(),
    source,
    deltaPBudget,
    guardrailTolerances: { depletionTolerance, residualRelTolerance, autonomyRelTolerance },
    baselineId: BASELINE_ID,
    significanceAvailable: significance.available,
    gateScenarioIds,
    candidates: candidates.map((candidate) => ({
      modelId: candidate.modelId,
      worstExactLoss: candidate.worstExactLoss,
      worstRelativeLoss: candidate.worstRelativeLoss,
      supplyDebtCvar90: candidate.supplyDebt,
      supplyDebtSignificantImprovement:
        significance.byId.get(candidate.modelId)?.significantImprovement ?? null,
      gateComplete: candidate.gateComplete,
      gateJudged: `${candidate.gateJudgedCount}/${candidate.gateTotal}`,
      incompleteReasons: candidate.incompleteReasons,
      gateEvidence: candidate.gateEvidence,
    })),
  };

  if (!baseline?.gateComplete || !baseline.supplyDebtJudgeable || baseline.supplyDebt === null) {
    out.outcome = "insufficient-evidence";
    out.reason = !baseline
      ? "Baseline A absent from results."
      : !baseline.gateComplete
        ? `Baseline A gate incomplete (${baseline.gateJudgedCount}/${baseline.gateTotal}; ${baseline.incompleteReasons.join(", ")}).`
        : "Baseline A journey supplyDebt unjudgeable (no completion-sufficient panel).";
    await writeOutputs(out);
    return out;
  }

  const prelimJudgeable = candidates.filter(
    (
      candidate,
    ): candidate is CandidateEvaluation & {
      worstExactLoss: number;
      worstRelativeLoss: number;
      supplyDebt: number;
    } =>
      candidate.modelId !== BASELINE_ID &&
      candidate.gateComplete &&
      candidate.supplyDebtJudgeable &&
      candidate.worstExactLoss !== null &&
      candidate.worstRelativeLoss !== null &&
      candidate.supplyDebt !== null &&
      candidate.gateEvidence.eligibleEmptyCount === 0,
  );

  for (const candidate of prelimJudgeable) {
    const guard = guardrailComparison(candidate, baseline, gateScenarioIds);
    candidate.guard = guard;
    candidate.noLoss = candidate.worstExactLoss <= NO_LOSS_EPSILON;
    candidate.boundedLoss = candidate.worstExactLoss <= deltaPBudget + STRICT_EPSILON;
    candidate.tailStrictlyBetter = candidate.supplyDebt < baseline.supplyDebt - STRICT_EPSILON;
    const sig = significance.byId.get(candidate.modelId);
    candidate.significance = sig || null;
    candidate.tailSignificantlyBetter = significance.available
      ? Boolean(sig?.significantImprovement)
      : candidate.tailStrictlyBetter;
  }

  const judgeable = prelimJudgeable.filter(isJudgeableCandidate);
  const paretoPoints = paretoFrontier([
    { modelId: baseline.modelId, x: 0, y: baseline.supplyDebt },
    ...judgeable.map((candidate) => ({
      modelId: candidate.modelId,
      x: candidate.worstExactLoss,
      y: candidate.supplyDebt,
    })),
  ]).map((point) => point.modelId);
  out.paretoFrontier = paretoPoints;

  const balanced = baseline;
  const probabilityCandidates = judgeable
    .filter((candidate) => candidate.noLoss && !candidate.guard.degraded)
    .sort(
      (left, right) =>
        left.worstExactLoss - right.worstExactLoss ||
        tauOf(left.modelId) - tauOf(right.modelId) ||
        left.supplyDebt - right.supplyDebt,
    );
  const probabilityFirst =
    probabilityCandidates.find((candidate) => candidate.worstExactLoss < -NO_LOSS_EPSILON) || null;

  const preservationCandidates = judgeable
    .filter(
      (candidate) =>
        candidate.boundedLoss &&
        candidate.worstExactLoss > NO_LOSS_EPSILON &&
        !candidate.guard.degraded &&
        candidate.tailSignificantlyBetter &&
        candidate.guard.anyRiskStratumBetter,
    )
    .sort(
      (left, right) =>
        left.supplyDebt - right.supplyDebt || left.worstExactLoss - right.worstExactLoss,
    );
  const preservation = preservationCandidates[0] || null;

  const dominatorsOfA = judgeable
    .filter(
      (candidate) =>
        candidate.noLoss &&
        !candidate.guard.degraded &&
        candidate.guard.anyRiskStratumBetter &&
        candidate.tailSignificantlyBetter,
    )
    .sort(
      (left, right) =>
        left.supplyDebt - right.supplyDebt || left.worstExactLoss - right.worstExactLoss,
    );
  const improvedDefault = dominatorsOfA[0] || null;

  const chosen: Array<{ stage: StageOutput["stage"]; candidate: CandidateEvaluation }> = [];
  if (probabilityFirst) chosen.push({ stage: "확률우선", candidate: probabilityFirst });
  chosen.push({ stage: "균형", candidate: balanced });
  if (preservation) chosen.push({ stage: "수급보존", candidate: preservation });

  const lossOf = (candidate: CandidateEvaluation) =>
    candidate.modelId === BASELINE_ID ? 0 : Number(candidate.worstExactLoss);
  const debtOf = (candidate: CandidateEvaluation) => Number(candidate.supplyDebt);
  let monotone = true;
  for (let index = 1; index < chosen.length; index += 1) {
    const previous = chosen[index - 1].candidate;
    const current = chosen[index].candidate;
    if (lossOf(current) < lossOf(previous) - STRICT_EPSILON) monotone = false;
    if (debtOf(current) > debtOf(previous) + STRICT_EPSILON) monotone = false;
  }

  let outcome = "keep-A-only";
  if (improvedDefault) outcome = "improved-default-available";
  else if (probabilityFirst && preservation && monotone) outcome = "3-stage";
  else if (probabilityFirst && preservation && !monotone) outcome = "non-monotone-3-candidates";
  else if (!probabilityFirst && preservation) outcome = "2-stage:balanced+preservation";
  else if (probabilityFirst && !preservation) outcome = "2-stage:probability+balanced";

  const evaluatedNormPowers = new Set(judgeable.map((candidate) => pOf(candidate.modelId)));
  const preservationEscalationSuggested =
    !preservation &&
    !improvedDefault &&
    evaluatedNormPowers.size > 0 &&
    [...evaluatedNormPowers].every((power) => power === 3);

  out.stages = chosen.map(({ stage, candidate }) => ({
    stage,
    modelId: candidate.modelId,
    worstExactLoss: lossOf(candidate),
    worstRelativeLoss: candidate.modelId === BASELINE_ID ? 0 : candidate.worstRelativeLoss,
    supplyDebtCvar90: debtOf(candidate),
    tailSignificantImprovement:
      candidate.modelId === BASELINE_ID ? null : Boolean(candidate.tailSignificantlyBetter),
    guardrailDegraded: candidate.guard ? candidate.guard.degraded : false,
    guardrailDegradations: candidate.guard ? candidate.guard.degradations : [],
    riskStratumBetter: candidate.guard ? candidate.guard.anyRiskStratumBetter : null,
  }));
  out.monotone = monotone;
  out.outcome = outcome;
  out.baselineSupplyDebt = baseline.supplyDebt;
  out.improvedDefaultAvailable = Boolean(improvedDefault);
  out.improvedDefault = improvedDefault
    ? {
        modelId: improvedDefault.modelId,
        worstExactLoss: improvedDefault.worstExactLoss,
        supplyDebtCvar90: improvedDefault.supplyDebt,
        supplyDebtVsA: improvedDefault.supplyDebt - baseline.supplyDebt,
        tailSignificantImprovement: Boolean(improvedDefault.tailSignificantlyBetter),
        riskStratumBetter: improvedDefault.guard.anyRiskStratumBetter,
        provisional: !significance.available,
      }
    : null;
  out.dominatorsOfA = dominatorsOfA.map((candidate) => candidate.modelId);
  out.preservationProvisional = Boolean(preservation) && !significance.available;
  out.preservationEscalationSuggested = preservationEscalationSuggested;
  out.diagnostics = {
    judgeableCount: judgeable.length,
    probabilityCandidateCount: probabilityCandidates.length,
    preservationCandidateCount: preservationCandidates.length,
    dominatorCount: dominatorsOfA.length,
    droppedForFallback: candidates
      .filter(
        (candidate) =>
          candidate.modelId !== BASELINE_ID && candidate.gateEvidence.eligibleEmptyCount > 0,
      )
      .map((candidate) => candidate.modelId),
  };

  await writeOutputs(out);
  return out;
}

function renderReport(out: SelectionOutput): string {
  const lines: string[] = [];
  lines.push("# Availability slider selection result");
  lines.push("");
  lines.push(`- Generated at: ${out.generatedAt}`);
  lines.push(`- Source: \`${out.source}\``);
  lines.push(`- Delta P budget: ${out.deltaPBudget}`);
  lines.push(`- Gate scenarios: ${out.gateScenarioIds.join(", ")}`);
  lines.push("");
  lines.push(`## Outcome: \`${out.outcome ?? "unknown"}\``);
  if (out.reason) lines.push(`- Reason: ${out.reason}`);
  if (out.monotone !== undefined)
    lines.push(`- Output monotonicity: ${out.monotone ? "pass" : "fail"}`);
  lines.push(
    `- Significance evidence: ${out.significanceAvailable ? "available" : "absent/provisional"}`,
  );

  if (out.improvedDefault) {
    const improved = out.improvedDefault;
    lines.push("");
    lines.push(
      `- Improved default candidate: \`${improved.modelId}\` (P-loss ${fmt(improved.worstExactLoss)}, supplyDebt ${fmt(out.baselineSupplyDebt, 1)} -> ${fmt(improved.supplyDebtCvar90, 1)}, delta ${fmt(improved.supplyDebtVsA, 1)}).`,
    );
  }
  if (out.preservationProvisional) {
    lines.push("- Preservation stage is provisional because significance evidence is absent.");
  }
  if (out.preservationEscalationSuggested) {
    lines.push("- Preservation escalation suggested: evaluate p in {4, Infinity}.");
  }

  if (out.stages) {
    lines.push("");
    lines.push("## Stages");
    lines.push("");
    lines.push(
      "| Stage | Candidate | Worst exact P loss | Relative loss | supplyDebt CVaR90 | Tail significant | Guardrail degraded |",
    );
    lines.push("|---|---|---|---|---|---|---|");
    for (const stage of out.stages) {
      const tail =
        stage.tailSignificantImprovement === null
          ? "-"
          : stage.tailSignificantImprovement
            ? "yes"
            : "no";
      lines.push(
        `| ${stage.stage} | \`${stage.modelId}\` | ${fmt(stage.worstExactLoss)} | ${fmt(stage.worstRelativeLoss)} | ${fmt(stage.supplyDebtCvar90, 3)} | ${tail} | ${stage.guardrailDegraded ? `yes (${stage.guardrailDegradations.join("; ")})` : "no"} |`,
      );
    }
  }

  if (out.paretoFrontier) {
    lines.push("");
    lines.push("## 2D Pareto Frontier");
    lines.push("");
    lines.push(out.paretoFrontier.map((id) => `\`${id}\``).join(", "));
  }

  lines.push("");
  lines.push("## Candidates");
  lines.push("");
  lines.push("| Candidate | Exact P loss | supplyDebt CVaR90 | Gate judged | eligibleEmpty |");
  lines.push("|---|---|---|---|---|");
  for (const candidate of out.candidates) {
    lines.push(
      `| \`${candidate.modelId}\` | ${fmt(candidate.worstExactLoss)} | ${fmt(candidate.supplyDebtCvar90, 3)} | ${candidate.gateJudged}${candidate.gateComplete ? "" : " (incomplete)"} | ${candidate.gateEvidence.eligibleEmptyCount} |`,
    );
  }
  lines.push("");
  lines.push("> supplyDebt is measured only on completion-sufficient journey panels.");
  lines.push("> exact P loss is the blocking gate; MC fallback is not used for exact P.");
  return `${lines.join("\n")}\n`;
}

async function writeOutputs(out: SelectionOutput): Promise<void> {
  await mkdir(RESULTS_DIRECTORY, { recursive: true });
  await writeFile(JSON_OUTPUT, `${JSON.stringify(out, null, 2)}\n`, "utf8");
  await writeFile(REPORT_OUTPUT, renderReport(out), "utf8");
}

const result = await main();
console.log(
  JSON.stringify(
    {
      kind: result.kind,
      outcome: result.outcome,
      monotone: result.monotone ?? null,
      stages: (result.stages || []).map((stage) => ({
        stage: stage.stage,
        modelId: stage.modelId,
      })),
      paretoFrontier: result.paretoFrontier || [],
      preservationEscalationSuggested: result.preservationEscalationSuggested ?? null,
      report: REPORT_OUTPUT.pathname,
      json: JSON_OUTPUT.pathname,
    },
    null,
    2,
  ),
);
