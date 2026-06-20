import type { CollectionState, Kit, KitRecord } from "./domain";
import type { SolverDiagnosticEventInput } from "./schemas";

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
  solverVersion: string;
  solverPhase: string;
  solverBackend: string;
  fallbackFrom: string;
  fallbackReason: string;
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

export type ValidatedSubmission = {
  eventId: string;
  sourceHost: string;
  event: ValidatedKitResultEvent | ValidatedSolverDiagnosticEvent;
};

export type SubmissionEnvelope = {
  eventId: string;
  sourceHost: string | undefined;
};
