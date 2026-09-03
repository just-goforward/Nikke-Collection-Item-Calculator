import type { CollectionState, Kit, KitRecord } from "../../shared/game";
import type { StatsDeliveryHealth } from "../../shared/solverRecoveryContract";
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
  forecastId: string;
  forecastProfileId: string;
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

export type ValidatedSolverRecoveryEvent = {
  kind: "solver_recovery";
  recoveryVersion: SolverRecoveryEventInput["recoveryVersion"];
  policyVersion: SolverRecoveryEventInput["policyVersion"];
  appRevision: string;
  forecastId: string;
  forecastProfileId: string;
  requestedBackend: SolverRecoveryEventInput["requestedBackend"];
  minEfExit: SolverRecoveryEventInput["minEfExit"];
  phase2Exit: SolverRecoveryEventInput["phase2Exit"];
  jsExit: SolverRecoveryEventInput["jsExit"];
  terminalBackend: SolverRecoveryEventInput["terminalBackend"];
  terminalOutcome: SolverRecoveryEventInput["terminalOutcome"];
  minEfMemoTier: SolverRecoveryEventInput["minEfMemoTier"];
  phase2MemoTier: SolverRecoveryEventInput["phase2MemoTier"];
  start: CollectionState;
  stockBuckets: SolverRecoveryEventInput["stockBuckets"];
  solverVersions: {
    rustMinEf: string;
    rustPhase2: string;
    jsPhase2: string;
  };
};
export type ValidatedRuntimeInvariantEvent = RuntimeInvariantEventInput;

export type ValidatedSubmission = {
  eventId: string;
  sourceHost: string;
  deliveryHealth: StatsDeliveryHealth | null;
  event:
    | ValidatedKitResultEvent
    | ValidatedRuntimeInvariantEvent
    | ValidatedSolverDiagnosticEvent
    | ValidatedSolverRecoveryEvent;
};

export type SubmissionEnvelope = {
  eventId: string;
  sourceHost: string | undefined;
  deliveryHealth: StatsDeliveryHealth | undefined;
};
