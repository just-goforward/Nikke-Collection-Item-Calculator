import {
  EXPECTED_28_DAY_GAIN,
  type ResearchCostModel,
  SUPPLY_AVAILABILITY_PARAMS,
  solveWithResearchCostModel,
} from "../../src/solver";
import type { Kit, SolverInput, Stock } from "../../src/types";
import { availabilityPnormObjective } from "../metrics";

const KITS: Kit[] = ["blue", "purple", "yellow"];
const SIGNATURE_DIGITS = 6;
const ROOT_OBJECTIVE_EPSILON = 1e-12;

export const SHADOW_DAMPING = 0.5;
export const SHADOW_MAX_ITERATIONS = 8;
export const SHADOW_TIMEOUT_MS = 10_000;

type SolverOutput = ReturnType<typeof solveWithResearchCostModel>;

type ShadowDiagnostics = {
  variant: "single-update" | "bounded-fixed-point";
  iterations: number;
  converged: boolean | null;
  fallback:
    | null
    | "not_possible"
    | "cycle"
    | "max_iterations"
    | "timeout"
    | "root_objective_worsened";
  finalPrices: Stock | null;
  baselineRootF: number | null;
  candidateRootF: number | null;
  candidateFirstAction: Kit | null;
  candidateRunCount: number | null;
};

type BoundedShadowOptions = {
  damping?: number;
  maxIterations?: number;
  timeoutMs?: number;
};

type CandidateDiagnostics = Omit<
  ShadowDiagnostics,
  "baselineRootF" | "candidateRootF" | "candidateFirstAction" | "candidateRunCount"
>;

function supplyInput(input: SolverInput): SolverInput {
  return { ...input, strategy: "supply" };
}

function withDiagnostics(result: SolverOutput, diagnostics: ShadowDiagnostics): SolverOutput {
  return {
    ...result,
    stats: {
      ...result.stats,
      researchShadow: diagnostics,
    },
  };
}

function recommendationVector(result: SolverOutput): Stock | null {
  if (!result.possible || !result.best?.vector) return null;
  return result.best.vector as Stock;
}

function rootObjective(result: SolverOutput, stock: Stock) {
  const vector = recommendationVector(result);
  return vector ? availabilityPnormObjective(vector, stock) : null;
}

export function shadowGradient(expectedConsumption: Stock, initialStock: Stock): Stock {
  const power = SUPPLY_AVAILABILITY_PARAMS.normPower;
  return Object.fromEntries(
    KITS.map((kit) => {
      const availability =
        initialStock[kit] + SUPPLY_AVAILABILITY_PARAMS.horizon * EXPECTED_28_DAY_GAIN[kit];
      const consumption = Math.max(0, expectedConsumption[kit]);
      const gradient = (power * consumption ** (power - 1)) / availability ** power;
      return [kit, gradient];
    }),
  ) as Stock;
}

function linearCostModel(prices: Stock): ResearchCostModel {
  return { kind: "linear-shadow", prices };
}

function dampPrices(previous: Stock, next: Stock, damping: number): Stock {
  return Object.fromEntries(
    KITS.map((kit) => [kit, damping * previous[kit] + (1 - damping) * next[kit]]),
  ) as Stock;
}

function recommendationSignature(result: SolverOutput) {
  const vector = recommendationVector(result);
  if (!vector || !result.best?.run) return "not_possible";
  return [
    result.best.firstAction,
    result.best.run.count,
    ...KITS.map((kit) => Number(vector[kit]).toFixed(SIGNATURE_DIGITS)),
  ].join("|");
}

function selectMonotonicCandidate(
  baseline: SolverOutput,
  candidate: SolverOutput,
  stock: Stock,
  diagnostics: CandidateDiagnostics,
) {
  const baselineRootF = rootObjective(baseline, stock);
  const candidateRootF = rootObjective(candidate, stock);
  const annotated = {
    ...diagnostics,
    baselineRootF,
    candidateRootF,
    candidateFirstAction: candidate.best?.firstAction || null,
    candidateRunCount: candidate.best?.run?.count || null,
  };
  if (
    baselineRootF !== null &&
    candidateRootF !== null &&
    candidateRootF > baselineRootF + ROOT_OBJECTIVE_EPSILON
  ) {
    return withDiagnostics(baseline, {
      ...annotated,
      fallback: "root_objective_worsened",
    });
  }
  return withDiagnostics(candidate, annotated);
}

export function solveSingleUpdateShadow(input: SolverInput): SolverOutput {
  const normalizedInput = supplyInput(input);
  const baseline = solveWithResearchCostModel(normalizedInput, { kind: "availability-pnorm" });
  const baselineVector = recommendationVector(baseline);
  if (!baselineVector) {
    return withDiagnostics(baseline, {
      variant: "single-update",
      iterations: 0,
      converged: null,
      fallback: "not_possible",
      finalPrices: null,
      baselineRootF: null,
      candidateRootF: null,
      candidateFirstAction: null,
      candidateRunCount: null,
    });
  }
  const prices = shadowGradient(baselineVector, normalizedInput.stock);
  const candidate = solveWithResearchCostModel(normalizedInput, linearCostModel(prices));
  return selectMonotonicCandidate(baseline, candidate, normalizedInput.stock, {
    variant: "single-update",
    iterations: 1,
    converged: null,
    fallback: null,
    finalPrices: prices,
  });
}

export function solveBoundedShadow(
  input: SolverInput,
  options: BoundedShadowOptions = {},
): SolverOutput {
  const normalizedInput = supplyInput(input);
  const damping = Math.max(0, Math.min(1, options.damping ?? SHADOW_DAMPING));
  const maxIterations = Math.max(1, Math.trunc(options.maxIterations ?? SHADOW_MAX_ITERATIONS));
  const timeoutMs = Math.max(0, Number(options.timeoutMs ?? SHADOW_TIMEOUT_MS));
  const startedAt = performance.now();
  const baseline = solveWithResearchCostModel(normalizedInput, { kind: "availability-pnorm" });
  const baselineVector = recommendationVector(baseline);
  if (!baselineVector) {
    return withDiagnostics(baseline, {
      variant: "bounded-fixed-point",
      iterations: 0,
      converged: false,
      fallback: "not_possible",
      finalPrices: null,
      baselineRootF: null,
      candidateRootF: null,
      candidateFirstAction: null,
      candidateRunCount: null,
    });
  }

  let prices = shadowGradient(baselineVector, normalizedInput.stock);
  let previousSignature: string | null = null;
  const seenSignatures = new Set<string>();

  for (let iteration = 1; iteration <= maxIterations; iteration += 1) {
    if (performance.now() - startedAt >= timeoutMs) {
      return withDiagnostics(baseline, {
        variant: "bounded-fixed-point",
        iterations: iteration - 1,
        converged: false,
        fallback: "timeout",
        finalPrices: prices,
        baselineRootF: rootObjective(baseline, normalizedInput.stock),
        candidateRootF: null,
        candidateFirstAction: null,
        candidateRunCount: null,
      });
    }
    const candidate = solveWithResearchCostModel(normalizedInput, linearCostModel(prices));
    const vector = recommendationVector(candidate);
    if (!vector) {
      return withDiagnostics(baseline, {
        variant: "bounded-fixed-point",
        iterations: iteration,
        converged: false,
        fallback: "not_possible",
        finalPrices: prices,
        baselineRootF: rootObjective(baseline, normalizedInput.stock),
        candidateRootF: null,
        candidateFirstAction: null,
        candidateRunCount: null,
      });
    }
    const signature = recommendationSignature(candidate);
    if (signature === previousSignature) {
      return selectMonotonicCandidate(baseline, candidate, normalizedInput.stock, {
        variant: "bounded-fixed-point",
        iterations: iteration,
        converged: true,
        fallback: null,
        finalPrices: prices,
      });
    }
    if (seenSignatures.has(signature)) {
      return withDiagnostics(baseline, {
        variant: "bounded-fixed-point",
        iterations: iteration,
        converged: false,
        fallback: "cycle",
        finalPrices: prices,
        baselineRootF: rootObjective(baseline, normalizedInput.stock),
        candidateRootF: rootObjective(candidate, normalizedInput.stock),
        candidateFirstAction: candidate.best?.firstAction || null,
        candidateRunCount: candidate.best?.run?.count || null,
      });
    }
    seenSignatures.add(signature);
    previousSignature = signature;
    prices = dampPrices(prices, shadowGradient(vector, normalizedInput.stock), damping);
  }

  return withDiagnostics(baseline, {
    variant: "bounded-fixed-point",
    iterations: maxIterations,
    converged: false,
    fallback: "max_iterations",
    finalPrices: prices,
    baselineRootF: rootObjective(baseline, normalizedInput.stock),
    candidateRootF: null,
    candidateFirstAction: null,
    candidateRunCount: null,
  });
}
