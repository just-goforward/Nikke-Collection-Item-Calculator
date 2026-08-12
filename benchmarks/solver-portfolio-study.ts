import type { SolverInput } from "../src/types";

export const SOLVER_PORTFOLIO_CONTRACT = {
  baseline: "min-ef-tier21-to-phase2-tier22",
  branchBoundMode: 2,
  exactRescueNodeBudget: 4_000_000,
  horizonFactor: 0.75,
  minEfTier: 21,
  normPower: 3,
  phase2Tier: 22,
  rescueTier: 22,
  tolerance: 0,
  childTimeoutMs: 45_000,
  rootLatencyGate: {
    absoluteMarginMs: 50,
    relativeFactor: 1.15,
  },
  candidateArms: [
    "min-ef-tier22",
    "branch-bound-b2-tier22",
    "phase2-tier22",
    "bounded-prioritized-phase2",
  ],
  routingHypotheses: {
    exactRescueByGrade: {
      R: "min-ef-tier22",
      SR: "branch-bound-b2-tier22",
    },
    boundedPrioritizedEligibility: "SR fallback states only",
    directPhase2Skip:
      "research-only unless a discovery rule has zero completed-state skips on held-out confirmation",
  },
} as const;

export type PortfolioArm =
  | "branch-bound-b2-tier22"
  | "bounded-prioritized-phase2"
  | "min-ef-tier21"
  | "min-ef-tier22"
  | "phase2-tier22";

export type PortfolioOutcome =
  | "budget_exceeded"
  | "completed"
  | "failure"
  | "memo_full"
  | "timeout";

export type PortfolioSemantic = {
  action: string | null;
  expectedCost: number | null;
  maxSuccessProbability: number;
  successProbability: number;
  vector: { blue: number; purple: number; yellow: number };
};

export type PortfolioRootRecord = {
  arm: PortfolioArm;
  branchBound?: {
    appliedPrunes: number;
    oracleStates: number;
    prepassMismatches: number;
  };
  elapsedMs: number;
  errorMessage: string | null;
  memoryAfterBytes: number;
  memoryBeforeBytes: number;
  nodeCount: number | null;
  outcome: PortfolioOutcome;
  prioritized?: {
    outcome: string;
    overrides: number;
    passes: number;
    peakStates: number;
    probabilityGap: number;
    successInvariantMaxGap: number;
  };
  scenarioId: string;
  semantic: PortfolioSemantic | null;
};

export function shouldScreenPortfolioAlternatives(outcome: PortfolioOutcome): boolean {
  return outcome === "memo_full" || outcome === "budget_exceeded";
}

export function preRegisteredExactRescueArm(
  input: Pick<SolverInput, "start">,
): Extract<PortfolioArm, "branch-bound-b2-tier22" | "min-ef-tier22"> {
  return input.start.grade === "SR" ? "branch-bound-b2-tier22" : "min-ef-tier22";
}

export function semanticParity(
  left: PortfolioSemantic | null,
  right: PortfolioSemantic | null,
): boolean {
  if (!left || !right) return false;
  return (
    floatBits(left.maxSuccessProbability) === floatBits(right.maxSuccessProbability) &&
    floatBits(left.successProbability) === floatBits(right.successProbability) &&
    nullableFloatBits(left.expectedCost) === nullableFloatBits(right.expectedCost) &&
    left.action === right.action &&
    floatBits(left.vector.blue) === floatBits(right.vector.blue) &&
    floatBits(left.vector.purple) === floatBits(right.vector.purple) &&
    floatBits(left.vector.yellow) === floatBits(right.vector.yellow)
  );
}

export function rootLatencyLimitMs(baselineMs: number): number {
  const policy = SOLVER_PORTFOLIO_CONTRACT.rootLatencyGate;
  return Math.max(baselineMs * policy.relativeFactor, baselineMs + policy.absoluteMarginMs);
}

function nullableFloatBits(value: number | null): string | null {
  return value === null ? null : floatBits(value);
}

function floatBits(value: number): string {
  const buffer = new ArrayBuffer(8);
  const view = new DataView(buffer);
  view.setFloat64(0, value, false);
  return view.getBigUint64(0, false).toString(16).padStart(16, "0");
}
