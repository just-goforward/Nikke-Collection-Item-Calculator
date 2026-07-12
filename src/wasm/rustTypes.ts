import type { Kit, StageReachPoint } from "../types";
import type { RustCoreExports as RawRustCoreExports } from "./rustCoreExports";

export type State = { grade: string; level: number; exp?: number };
export type Stock = { blue: number; purple: number; yellow: number };

export type RustCoreExports = RawRustCoreExports;

export type RustMinEfRoot = {
  firstAction: Kit | null;
  successProbability: number;
  maxSuccessProbability: number;
  vector: Record<Kit, number>;
  expectedCost: number;
  states: number;
};

type RustMinEfRootResult = {
  root: RustMinEfRoot;
  candidates: RustPhase2Candidate[];
};

export type RustMinEfPolicyHandle = RustMinEfRootResult & {
  nodeCount: number;
  actionAt: (state: State, stockUses: Stock) => Kit | null;
};

export type RustPhase2Root = {
  firstAction: Kit | null;
  successProbability: number;
  maxSuccessProbability: number;
  vector: Record<Kit, number>;
  states: number;
};

export type RustFirstActionEstimate = {
  expectedCost: number;
  completionRate: number;
};

export type RustFirstActionMomentEstimate = RustFirstActionEstimate & {
  runs: number;
  sumSq: number;
  variance: number;
  standardError: number;
};

export type RustPairedExpectedCostEstimate = {
  runs: number;
  meanBaseline: number;
  meanSelected: number;
  meanDelta: number;
  deltaSumSq: number;
  deltaVariance: number;
  standardError: number;
  upper95: number;
  correlation: number;
};

export type RustA2MomentEstimate = {
  mean: Record<Kit, number>;
  covariance: {
    blueBlue: number;
    purplePurple: number;
    yellowYellow: number;
    bluePurple: number;
    blueYellow: number;
    purpleYellow: number;
  };
  baseCost: number;
  secondOrderCorrection: number;
  surrogateCost: number;
  nodeCount: number;
};

export type RustExactExpectedCostEstimate = {
  expectedCost: number;
  nodeCount: number;
};

export type RustPhase2Candidate = {
  firstAction: Kit;
  successProbability: number;
  maxSuccessProbability: number;
  probabilityGap: number;
  vector: Record<Kit, number>;
  resourceCost: number;
  eligible: boolean;
};

export type RustRerankedCandidate = RustPhase2Candidate & RustFirstActionEstimate;

export type RustRerankResult = {
  baseline: RustPhase2Root;
  selected: RustRerankedCandidate;
  candidates: RustRerankedCandidate[];
  policy: RustPhase2Policy;
};

export type RustMonteCarloResult = {
  runs: number;
  completed: number;
  successProbability: number;
  vector: Record<Kit, number>;
  quantiles?: Record<Kit, { p50: number; p90: number; p95: number }>;
  depletion?: number;
  stageReach?: StageReachPoint[];
  validationPolicyCache?: "hit" | "miss";
};

export type RustMinEfSolver = {
  configureMemoTier: (tier: number) => void;
  memoTier: () => number;
  releaseMemo: () => void;
  solveRootWithCandidates: (
    start: State,
    stock: Stock,
    horizonFactor?: number,
    normPower?: number,
    tolerance?: number,
  ) => RustMinEfPolicyHandle;
};

export type RustPhase2Policy = {
  root: RustPhase2Root;
  candidates: RustPhase2Candidate[];
  actionAt: (state: State, stockUses: Stock) => Kit | null;
  simulate: (runs: number, seed: number) => RustMonteCarloResult;
};

export type RustPhase2ProductSolver = {
  configureMemoTier: (tier: number) => void;
  memoTier: () => number;
  releaseMemo: () => void;
  buildPolicy: (
    start: State,
    stock: Stock,
    horizonFactor?: number,
    normPower?: number,
    tolerance?: number,
  ) => RustPhase2Policy;
};

export type RustPhase2ResearchSolver = RustPhase2ProductSolver & {
  solveRoot: (
    start: State,
    stock: Stock,
    horizonFactor?: number,
    normPower?: number,
    tolerance?: number,
  ) => RustPhase2Root;
  rootCandidates: (
    start: State,
    stock: Stock,
    horizonFactor?: number,
    normPower?: number,
    tolerance?: number,
  ) => RustPhase2Candidate[];
  simulatePolicy: (
    start: State,
    stock: Stock,
    runs: number,
    seed: number,
    horizonFactor?: number,
    normPower?: number,
    tolerance?: number,
  ) => RustMonteCarloResult;
  simulatePolicyAfterFirstAction: (
    start: State,
    stock: Stock,
    firstAction: Kit,
    runs: number,
    seed: number,
    horizonFactor?: number,
    normPower?: number,
    tolerance?: number,
  ) => RustMonteCarloResult;
  estimateExpectedCostAfterFirstAction: (
    start: State,
    stock: Stock,
    firstAction: Kit,
    runs: number,
    seed: number,
    horizonFactor?: number,
    normPower?: number,
    tolerance?: number,
  ) => RustFirstActionEstimate;
  // Follows the currently built phase2 policy. The current build's tolerance is intentionally
  // inherited because this rollout does not rebuild or reselect the policy.
  estimateExpectedCostAfterFirstActionFromCurrent: (
    start: State,
    stock: Stock,
    firstAction: Kit,
    runs: number,
    seed: number,
    horizonFactor?: number,
    normPower?: number,
  ) => RustFirstActionEstimate;
  estimateExpectedCostAfterFirstActionFromCurrentWithMoments: (
    start: State,
    stock: Stock,
    firstAction: Kit,
    runs: number,
    seed: number,
    horizonFactor?: number,
    normPower?: number,
  ) => RustFirstActionMomentEstimate;
  estimateExpectedCostPairFromCurrent: (
    start: State,
    stock: Stock,
    baselineFirstAction: Kit,
    selectedFirstAction: Kit,
    runs: number,
    seed: number,
    horizonFactor?: number,
    normPower?: number,
  ) => RustPairedExpectedCostEstimate;
  estimateA2SurrogateAfterFirstActionFromCurrent: (
    start: State,
    stock: Stock,
    firstAction: Kit,
    horizonFactor?: number,
    normPower?: number,
  ) => RustA2MomentEstimate;
  estimateExactExpectedCostAfterFirstActionFromCurrent: (
    start: State,
    stock: Stock,
    firstAction: Kit,
    horizonFactor?: number,
    normPower?: number,
  ) => RustExactExpectedCostEstimate;
  selectFirstActionByExpectedCost: (
    start: State,
    stock: Stock,
    runs: number,
    seed: number,
    horizonFactor?: number,
    normPower?: number,
    tolerance?: number,
  ) => RustRerankResult | null;
};
