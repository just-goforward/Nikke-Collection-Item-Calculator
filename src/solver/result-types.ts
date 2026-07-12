import type {
  CollectionState,
  Kit,
  KitVector,
  Strategy,
  SUPPLY_AVAILABILITY_PARAMS,
} from "./domain";
import type { ProbabilityGateAudit } from "./gate";
import type { NormalizedSolverInput } from "./input";
import type { FailureRouteStep, RecommendedRun } from "./routes";
import type { simulate } from "./simulation";

type SolverMonteCarlo = {
  runs: number;
  completed: number;
  successProbability: number;
  vector: KitVector;
  quantiles?: ReturnType<typeof simulate>["quantiles"];
  depletion?: number;
  stageReach?: ReturnType<typeof simulate>["stageReach"];
};

type ResearchShadowDiagnostics = {
  variant?: "single-update" | "bounded-fixed-point";
  iterations?: number;
  converged?: boolean | null;
  fallback?: string | null;
  finalPrices?: KitVector | null;
  baselineRootF?: number | null;
  candidateRootF?: number | null;
  candidateFirstAction?: Kit | null;
  candidateRunCount?: number | null;
};

type SolverStats = {
  states: number;
  exact: boolean;
  tolerance: number;
  iterations: number;
  probabilityTolerance?: number;
  maxSuccessProbability?: number;
  dynamicCapReductions?: number;
  dynamicCapFallbacks?: number;
  gateAudit?: ProbabilityGateAudit;
  strategy?: Strategy;
  supplyAvailability?: typeof SUPPLY_AVAILABILITY_PARAMS;
  researchShadow?: ResearchShadowDiagnostics;
};

type SolverBest = {
  name: string;
  firstAction: Kit | "convert" | null;
  firstProbability: number;
  run?: RecommendedRun | null;
  success: CollectionState;
  fail: CollectionState;
  vector: KitVector;
  totalKits: number;
  successProbability: number;
  maxSuccessProbability: number;
  probabilityGap: number;
  pressure: number;
  supplyCost: number;
  availabilityCost: number;
  legacySupplyCost: number;
  resourceCost: number;
};

type SolverKitBest = Omit<SolverBest, "firstAction" | "run"> & {
  firstAction: Kit | null;
  run?: RecommendedRun;
};

export type SolverTopCandidate = {
  name: string;
  firstAction: Kit;
  firstProbability: number;
  run: RecommendedRun;
  vector: KitVector;
  totalKits: number;
  successProbability: number;
  probabilityGap: number;
  pressure: number;
  supplyCost: number;
  availabilityCost: number;
  legacySupplyCost: number;
  resourceCost: number;
};

export type SolverResult = {
  possible?: boolean;
  terminal?: boolean;
  convertOnly?: boolean;
  input: NormalizedSolverInput;
  message?: string;
  candidateCount?: number;
  best?: SolverBest;
  route?: FailureRouteStep[];
  monteCarlo?: SolverMonteCarlo;
  stats?: SolverStats;
  topCandidates?: SolverTopCandidate[];
};

export type ResearchSolverResult = Omit<SolverResult, "best" | "stats" | "topCandidates"> & {
  best: SolverKitBest;
  stats: SolverStats & {
    gateAudit: ProbabilityGateAudit;
    maxSuccessProbability: number;
    probabilityTolerance: number;
    researchShadow: ResearchShadowDiagnostics;
  };
  topCandidates: SolverTopCandidate[];
};
