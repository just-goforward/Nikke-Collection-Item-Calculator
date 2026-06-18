import type { CollectionState, Kit, KitRecord } from "./domain";

export type UnknownRecord = Record<string, unknown>;

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
  diagnosticVersion: unknown;
  solverVersion: string;
  solverPhase: string;
  start: CollectionState;
  strategy: string;
  stockBuckets: { blue: unknown; purple: unknown; yellow: unknown };
  recommendedKit: unknown;
  recommendedUsesBucket: unknown;
  candidateCountBucket: unknown;
  probabilityGapBucket: unknown;
  resourceCostBucket: unknown;
  legacySupplyCostBucket: unknown;
  totalExpectedCostBucket: unknown;
  blueShareBucket: unknown;
  minAutonomyDaysBucket: unknown;
  nodeCountBucket: string;
  changedFromSingle: unknown;
  changedFromLegacySupply: unknown;
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
  sourceHost: unknown;
};
