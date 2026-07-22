import type { CollectionState, Kit, KitRecord } from "../../shared/game";
import type { SolverExecutionKind, StatsLocale } from "../../shared/statsContract";
import type {
  RuntimeInvariantEventInput,
  SolverDiagnosticEventInput,
  SolverRecoveryEventInput,
} from "./schemas";

export type ValidatedKitResultEvent = {
  kind: "kit_result";
  start: CollectionState;
  kit: Kit;
  recommendedUses: number;
  outcome: "great_success" | "no_great_success";
  successAttempt: number | null;
  stockBefore: KitRecord<number>;
  stockAfter: KitRecord<number>;
  resultState: CollectionState;
};

export type ValidatedSolverDiagnosticEvent = {
  kind: "solver_diagnostic";
  diagnosticVersion: SolverDiagnosticEventInput["diagnosticVersion"];
  locale: StatsLocale | null;
  solverVersion: string;
  solverPhase: string;
  solverBackend: string;
  requestedBackend: string;
  executionKind: SolverExecutionKind;
  fallbackFrom: string;
  fallbackReason: string;
  workerErrorCode: string;
  memoryStrategy: string;
  minEfMemoTier: string;
  phase2MemoTier: string;
  phase2MemoRetried: string;
  start: CollectionState;
  strategy: string;
  stockBuckets: SolverDiagnosticEventInput["stockBuckets"];
  recommendedKit: SolverDiagnosticEventInput["recommendedKit"];
  recommendedUsesBucket: SolverDiagnosticEventInput["recommendedUsesBucket"];
  candidateCountBucket: SolverDiagnosticEventInput["candidateCountBucket"];
  probabilityGapBucket: SolverDiagnosticEventInput["probabilityGapBucket"];
  resourceCostBucket: SolverDiagnosticEventInput["resourceCostBucket"];
  legacySupplyCostBucket: SolverDiagnosticEventInput["legacySupplyCostBucket"];
  totalExpectedCostBucket: SolverDiagnosticEventInput["totalExpectedCostBucket"];
  blueShareBucket: SolverDiagnosticEventInput["blueShareBucket"];
  minAutonomyDaysBucket: SolverDiagnosticEventInput["minAutonomyDaysBucket"];
  nodeCountBucket: string;
  attemptedNodeCountBucket: string;
  solveMsBucket: string;
  changedFromSingle: SolverDiagnosticEventInput["changedFromSingle"];
  changedFromLegacySupply: SolverDiagnosticEventInput["changedFromLegacySupply"];
  legacyPrivateStatsAvailable: boolean;
  legacyEventAggregateMatchable: boolean;
};

export type ValidatedSolverRecoveryEvent = SolverRecoveryEventInput;
export type ValidatedRuntimeInvariantEvent = RuntimeInvariantEventInput;

export type ValidatedSubmission = {
  eventId: string;
  sourceHost: string;
  event:
    | ValidatedKitResultEvent
    | ValidatedRuntimeInvariantEvent
    | ValidatedSolverDiagnosticEvent
    | ValidatedSolverRecoveryEvent;
};

export type SubmissionEnvelope = {
  eventId: string;
  sourceHost: string | undefined;
};
