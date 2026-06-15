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
import {
  AVAILABILITY_BASELINE_ID,
  AVAILABILITY_NO_LOSS_EPSILON,
  AVAILABILITY_STRICT_EPSILON,
  aggregateExact,
  aggregateFiniteTail,
  buildCandidate,
  candidateDebt,
  candidateLoss,
  guardrailComparison,
  isJudgeableCandidate,
  paretoFrontier,
  pOf,
  readDeepReport,
  tauOf,
} from "./availability-selection-evaluation.ts";
import { renderSelectionReport } from "./availability-selection-report.ts";
import type {
  CandidateEvaluation,
  LoadedDeepReport,
  SelectionOutput,
  SignificanceCandidate,
  SignificanceLoad,
  StageOutput,
} from "./availability-selection-types.ts";
import { envValue, isErrorWithCode } from "./runner-utils";

const RESULTS_DIRECTORY = new URL("./results/", import.meta.url);
const SLICE_FILE = new URL("./results/availability-deep-slice.json", import.meta.url);
const SINGLE_FILE = new URL("./results/availability-deep.json", import.meta.url);
const SIGNIFICANCE_FILE = new URL("./results/availability-significance.json", import.meta.url);
const JSON_OUTPUT = new URL("./results/availability-selection.json", import.meta.url);
const REPORT_OUTPUT = new URL("./results/availability-selection-report.ko.md", import.meta.url);

function parseNumber(value: string | number | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

const deltaPBudget = parseNumber(envValue("AVAILABILITY_SELECT_DELTA_P_BUDGET"), 0.005);
const depletionTolerance = parseNumber(envValue("AVAILABILITY_SELECT_DEPLETION_TOL"), 0.01);
const residualRelTolerance = parseNumber(envValue("AVAILABILITY_SELECT_RESIDUAL_REL_TOL"), 0.05);
const autonomyRelTolerance = parseNumber(envValue("AVAILABILITY_SELECT_AUTONOMY_REL_TOL"), 0.05);

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
  const baseline = candidates.find((candidate) => candidate.modelId === AVAILABILITY_BASELINE_ID);

  const out: SelectionOutput = {
    kind: "availability-selection",
    version: 1,
    generatedAt: new Date().toISOString(),
    source,
    deltaPBudget,
    guardrailTolerances: { depletionTolerance, residualRelTolerance, autonomyRelTolerance },
    baselineId: AVAILABILITY_BASELINE_ID,
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
      candidate.modelId !== AVAILABILITY_BASELINE_ID &&
      candidate.gateComplete &&
      candidate.supplyDebtJudgeable &&
      candidate.worstExactLoss !== null &&
      candidate.worstRelativeLoss !== null &&
      candidate.supplyDebt !== null &&
      candidate.gateEvidence.eligibleEmptyCount === 0,
  );

  for (const candidate of prelimJudgeable) {
    const guard = guardrailComparison(candidate, baseline, gateScenarioIds, {
      depletionTolerance,
      residualRelTolerance,
      autonomyRelTolerance,
    });
    candidate.guard = guard;
    candidate.noLoss = candidate.worstExactLoss <= AVAILABILITY_NO_LOSS_EPSILON;
    candidate.boundedLoss = candidate.worstExactLoss <= deltaPBudget + AVAILABILITY_STRICT_EPSILON;
    candidate.tailStrictlyBetter =
      candidate.supplyDebt < baseline.supplyDebt - AVAILABILITY_STRICT_EPSILON;
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
    probabilityCandidates.find(
      (candidate) => candidate.worstExactLoss < -AVAILABILITY_NO_LOSS_EPSILON,
    ) || null;

  const preservationCandidates = judgeable
    .filter(
      (candidate) =>
        candidate.boundedLoss &&
        candidate.worstExactLoss > AVAILABILITY_NO_LOSS_EPSILON &&
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

  let monotone = true;
  for (let index = 1; index < chosen.length; index += 1) {
    const previous = chosen[index - 1]?.candidate;
    const current = chosen[index]?.candidate;
    if (!previous || !current) continue;
    if (candidateLoss(current) < candidateLoss(previous) - AVAILABILITY_STRICT_EPSILON) {
      monotone = false;
    }
    if (candidateDebt(current) > candidateDebt(previous) + AVAILABILITY_STRICT_EPSILON) {
      monotone = false;
    }
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
    worstExactLoss: candidateLoss(candidate),
    worstRelativeLoss:
      candidate.modelId === AVAILABILITY_BASELINE_ID ? 0 : candidate.worstRelativeLoss,
    supplyDebtCvar90: candidateDebt(candidate),
    tailSignificantImprovement:
      candidate.modelId === AVAILABILITY_BASELINE_ID
        ? null
        : Boolean(candidate.tailSignificantlyBetter),
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
          candidate.modelId !== AVAILABILITY_BASELINE_ID &&
          candidate.gateEvidence.eligibleEmptyCount > 0,
      )
      .map((candidate) => candidate.modelId),
  };

  await writeOutputs(out);
  return out;
}

async function writeOutputs(out: SelectionOutput): Promise<void> {
  await mkdir(RESULTS_DIRECTORY, { recursive: true });
  await writeFile(JSON_OUTPUT, `${JSON.stringify(out, null, 2)}\n`, "utf8");
  await writeFile(REPORT_OUTPUT, renderSelectionReport(out), "utf8");
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
